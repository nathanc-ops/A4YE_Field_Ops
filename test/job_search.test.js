'use strict';
// Finding any job in a picker (no list limit) and renumbering jobs (admins only).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const D = require('../server/db');
const { createApp } = require('../server/app');

let server, base, db;
const tok = {}, ids = {};
async function call(who, method, p, body) {
  const res = await fetch(base + '/api' + p, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok[who] }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, total: res.headers.get('x-total-count'), data: await res.json() };
}
before(async () => {
  db = D.open(':memory:');
  server = createApp(db).listen(0); await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  tok.admin = (await call(null, 'POST', '/setup', { name: 'Owner', email: 'o@x.com', password: 'longenough' })).data.token;
  await call('admin', 'POST', '/users', { name: 'Ann Office', email: 'ann@x.com', password: 'password123', role: 'office' });
  tok.office = (await call(null, 'POST', '/login', { email: 'ann@x.com', password: 'password123' })).data.token;
  ids.cust = (await call('admin', 'POST', '/customers', { name: 'Ray Patel', company: 'Northgate Plaza LLC', location: { address: '1200 Northgate Blvd', city: 'Boise' } })).data.id;
  ids.loc = db.prepare('SELECT id FROM locations WHERE customer_id = ?').get(ids.cust).id;
  ids.other = (await call('admin', 'POST', '/customers', { name: 'Ana Garcia', location: { address: '815 Elm St' } })).data.id;
  // 1,500 old invoiced jobs, more than any list shows at once
  const ins = db.prepare("INSERT INTO jobs (number, customer_id, title, status, billing_type) VALUES (?, ?, ?, 'invoiced', 'tm')");
  for (let n = 4000; n < 5500; n++) ins.run(`J-${n}`, ids.other, `Service ${n}`);
  ids.target = (await call('admin', 'POST', '/jobs', { customer_id: ids.cust, location_id: ids.loc, title: 'Suite 12 tenant improvement', po_number: 'PO-7781' })).data.id;
  db.prepare("UPDATE jobs SET number = 'J-6020', timeclock_job = '2615001' WHERE id = ?").run(ids.target);
  db.prepare("UPDATE jobs SET status = 'invoiced' WHERE number = 'J-4007'").run();
});
after(() => server.close());

test('picker search finds any job however many there are, by #, clock #, customer, company, address, PO, words', async () => {
  const all = await call('admin', 'GET', '/jobs');
  assert.equal(all.data.length, 1000, 'the plain list still stops at 1,000');
  assert.equal(Number(all.total), 1501, 'and says how many there are');
  const s = async q => (await call('admin', 'GET', `/jobs?picker=1&limit=12&q=${encodeURIComponent(q)}`));
  const old = await s('4007');
  assert.equal(old.data[0].number, 'J-4007', 'an old invoiced job, by number, first'); assert.equal(old.data.length, 1);
  assert.equal((await s('6020')).data[0].id, ids.target);
  assert.equal((await s('2615001')).data[0].id, ids.target, 'time clock job #');
  assert.equal((await s('Northgate')).data[0].id, ids.target, 'company / address');
  assert.equal((await s('PO-7781')).data[0].id, ids.target, 'customer PO');
  assert.equal((await s('ray suite')).data[0].id, ids.target, 'every word must match somewhere');
  assert.equal((await s('ray elm')).data.length, 0);
  const many = await s('Service');
  assert.equal(many.data.length, 12); assert.equal(Number(many.total), 1500, 'the picker can say "1,488 more — keep typing"');
  assert.equal((await s('50%')).data.length, 0, 'wildcards are literal');
  // exact number first even when other numbers contain it
  const r = await s('J-4100');
  assert.equal(r.data[0].number, 'J-4100');
  assert.equal(r.data[0].customer_company, null);
  assert.equal((await s('6020')).data[0].customer_company, 'Northgate Plaza LLC');
});

test('admins can renumber a job; everyone else cannot; numbers stay unique; history keeps the old number', async () => {
  assert.equal((await call('office', 'PUT', `/jobs/${ids.target}/number`, { number: '5815' })).status, 403);
  assert.equal((await call('admin', 'PUT', `/jobs/${ids.target}/number`, { number: '' })).status, 400);
  assert.equal((await call('admin', 'PUT', `/jobs/${ids.target}/number`, { number: 'bad;drop' })).status, 400);
  const clash = await call('admin', 'PUT', `/jobs/${ids.target}/number`, { number: 'j-4007' });
  assert.equal(clash.status, 400); assert.match(clash.data.error, /J-4007 already exists/);
  const ok = await call('admin', 'PUT', `/jobs/${ids.target}/number`, { number: '5815-A' });
  assert.equal(ok.status, 200); assert.equal(ok.data.number, '5815-A');
  assert.equal(ok.data.next_new_job, 'J-5500', 'new jobs count on from the highest remaining J- number');
  const j = (await call('admin', 'GET', `/jobs/${ids.target}`)).data;
  assert.equal(j.number, '5815-A'); assert.equal(j.timeclock_job, '2615001', 'time clock link unchanged');
  assert.ok(db.prepare('SELECT 1 x FROM job_notes WHERE job_id = ? AND body = ?').get(ids.target, 'Job number changed from J-6020 to 5815-A'));
  assert.equal((await call('admin', 'GET', '/jobs?picker=1&q=5815')).data[0].id, ids.target);
  // a new job doesn't reuse a number
  const nj = (await call('admin', 'POST', '/jobs', { customer_id: ids.cust, title: 'Next' })).data.id;
  assert.equal(db.prepare('SELECT number FROM jobs WHERE id = ?').get(nj).number, 'J-5500');
});

test('job numbers without the J- prefix: plain numbering, continue-from, removing J- from existing jobs', async () => {
  let d = (await call('admin', 'GET', '/settings/job-numbers')).data;
  assert.equal(d.prefix, 'J-', 'unchanged installs keep J-');
  assert.equal((await call('office', 'GET', '/settings/job-numbers')).status, 403);
  // plain numbers, continuing the company's own sequence
  await call('admin', 'PUT', '/settings', { job_number_prefix: '', job_number_next: '5816' });
  d = (await call('admin', 'GET', '/settings/job-numbers')).data;
  assert.equal(d.prefix, ''); assert.equal(d.next, '5816');
  const a = (await call('admin', 'POST', '/jobs', { customer_id: ids.cust, title: 'Plain A' })).data.id;
  const b = (await call('admin', 'POST', '/jobs', { customer_id: ids.cust, title: 'Plain B' })).data.id;
  assert.equal(db.prepare('SELECT number FROM jobs WHERE id = ?').get(a).number, '5816');
  assert.equal(db.prepare('SELECT number FROM jobs WHERE id = ?').get(b).number, '5817');
  // "5815-A" (renamed earlier) and the J- jobs don't confuse the plain sequence
  assert.equal((await call('admin', 'GET', '/settings/job-numbers')).data.next, '5818');
  // a job already renamed to a plain number collides with stripping J- from J-5816? set one up: J-5817 exists → clash
  db.prepare("INSERT INTO jobs (number, customer_id, title, status, billing_type) VALUES ('J-5817', ?, 'old twin', 'invoiced', 'tm')").run(ids.other);
  const dry = (await call('admin', 'POST', '/jobs/remove-prefix', { prefix: 'J-', dry_run: true })).data;
  assert.equal(dry.clashes.length, 1); assert.equal(dry.clashes[0].from, 'J-5817'); assert.equal(dry.clashes[0].taken_by, '5817');
  assert.equal(dry.would_change, 1501, 'the 1,500 history jobs + J-5500 from the earlier test');
  assert.equal((await call('office', 'POST', '/jobs/remove-prefix', { prefix: 'J-' })).status, 403);
  const r = (await call('admin', 'POST', '/jobs/remove-prefix', { prefix: 'J-' })).data;
  assert.equal(r.changed, dry.would_change); assert.equal(r.skipped.length, 1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM jobs WHERE number = '4007'").get().n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM jobs WHERE number = 'J-5817'").get().n, 1, 'the clash is left alone');
  const j4007 = db.prepare("SELECT id FROM jobs WHERE number = '4007'").get().id;
  assert.ok(db.prepare('SELECT 1 x FROM job_notes WHERE job_id = ? AND body LIKE ?').get(j4007, 'Job number changed from J-4007 to 4007%'));
  // search still finds it by the bare number; the next plain number skips everything taken
  assert.equal((await call('admin', 'GET', '/jobs?picker=1&q=4007')).data[0].number, '4007');
  assert.equal(r.next, '5818');
  // back to a prefix
  await call('admin', 'PUT', '/settings', { job_number_prefix: 'A4-', job_number_next: '' });
  const c = (await call('admin', 'POST', '/jobs', { customer_id: ids.cust, title: 'Prefixed' })).data.id;
  assert.equal(db.prepare('SELECT number FROM jobs WHERE id = ?').get(c).number, 'A4-1001');
});

test('the next job number can be set lower than jobs already used; it counts up from there and skips taken numbers', async () => {
  await call('admin', 'PUT', '/settings', { job_number_prefix: '', job_number_next: '' });
  for (const n of ['7000', '7002']) { const id = (await call('admin', 'POST', '/jobs', { customer_id: ids.cust, title: 'Existing' })).data.id; await call('admin', 'PUT', `/jobs/${id}/number`, { number: n }); }
  assert.match((await call('admin', 'PUT', '/settings', { job_number_next: '12.5' })).data.error, /whole number/);
  await call('admin', 'PUT', '/settings', { job_number_next: '6999' });   // below the highest (7002)
  assert.equal((await call('admin', 'GET', '/settings/job-numbers')).data.next, '6999');
  const made = [];
  for (let i = 0; i < 3; i++) made.push((await call('admin', 'POST', '/jobs', { customer_id: ids.cust, title: `New ${i}` })).data.id);
  assert.deepEqual(made.map(id => db.prepare('SELECT number FROM jobs WHERE id = ?').get(id).number), ['6999', '7001', '7003'], '7000 and 7002 are taken, so they are skipped');
  assert.equal((await call('admin', 'GET', '/settings/job-numbers')).data.next_floor, '7004', 'the counter moves on');
  // cleared: back to after the highest
  await call('admin', 'PUT', '/settings', { job_number_next: '' });
  assert.equal((await call('admin', 'GET', '/settings/job-numbers')).data.next, String(Math.max(...db.prepare("SELECT number FROM jobs WHERE number NOT GLOB '*[^0-9]*'").all().map(r => Number(r.number))) + 1));
});
