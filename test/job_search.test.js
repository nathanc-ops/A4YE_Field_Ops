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
