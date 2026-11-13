'use strict';
// Housecall Pro pull against a fake HCP API shaped like the public API reference. Made-up data only.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const D = require('../server/db');
const { createApp } = require('../server/app');
const HCP = require('../server/hcp');

const KEY = 'test-hcp-key';
const hcp = {
  customers: [
    { id: 'cus_1', first_name: 'Alex', last_name: 'Sample', email: 'alex@example.com', mobile_number: '555-300-0001', home_number: '555-300-0002',
      company: null, lead_source: 'Google', notes: 'Gate code 1234. Dog in yard.', created_at: '2025-01-05T17:00:00Z', updated_at: '2026-11-01T17:00:00Z',
      addresses: [{ id: 'adr_1', type: 'service', street: '10 Test Lane', street_line_2: null, city: 'Sampletown', state: 'ID', zip: '83700' }] },
    { id: 'cus_2', first_name: null, last_name: null, email: 'office@example.org', mobile_number: '555-300-0003', company: 'Example Builders LLC',
      notes: '', created_at: '2025-02-05T17:00:00Z', updated_at: '2026-11-02T17:00:00Z',
      addresses: [{ id: 'adr_2', type: 'service', street: '20 Commerce Way', city: 'Sampletown', state: 'ID', zip: '83701' }] },
  ],
  estimates: [
    { id: 'est_1', estimate_number: '5001', customer: { id: 'cus_1' }, address: { id: 'adr_1', street: '10 Test Lane', city: 'Sampletown', state: 'ID', zip: '83700' },
      created_at: '2026-10-01T17:00:00Z', updated_at: '2026-10-03T17:00:00Z',
      options: [
        { id: 'opt_a', name: 'Good', option_number: 1, total_amount: 120000, approval_status: 'declined', notes: [{ id: 'note_e1', content: 'Customer wants copper' }] },
        { id: 'opt_b', name: 'Better', option_number: 2, total_amount: 180000, approval_status: 'approved', notes: [] }] },
    { id: 'est_2', estimate_number: '5002', customer: { id: 'cus_2' }, created_at: '2026-10-02T17:00:00Z', updated_at: '2026-10-02T17:00:00Z',
      options: [{ id: 'opt_c', name: 'Option 1', option_number: 1, total_amount: 50000, approval_status: 'awaiting response', notes: [] }] },
  ],
  lines: {
    opt_a: [{ name: 'Panel replacement', description: '100A to 200A', quantity: 1, unit_price: 120000, unit_cost: 60000, taxable: false }],
    opt_b: [{ name: 'Panel replacement', description: '200A, 40 space', quantity: 1, unit_price: 150000, unit_cost: 70000, taxable: false },
      { name: 'Whole-home surge protector', quantity: 1, unit_price: 30000, unit_cost: 9000, taxable: true }],
    opt_c: [],
  },
  jobs: [
    { id: 'job_1', invoice_number: '1001', description: 'Panel swap\nPer estimate 5001', customer: { id: 'cus_1' }, address: { id: 'adr_1', street: '10 Test Lane', city: 'Sampletown', state: 'ID', zip: '83700' },
      notes: [{ id: 'note_j1', content: 'Bring 200A main' }, { id: 'note_j2', content: 'Call before arrival' }], work_status: 'complete rated',
      work_timestamps: { completed_at: '2026-10-20T22:00:00Z' }, schedule: { scheduled_start: '2026-10-20T15:00:00Z', scheduled_end: '2026-10-20T22:00:00Z' },
      assigned_employees: [{ id: 'pro_1', first_name: 'Tess', last_name: 'Tech', email: 'tess@example.com' }], original_estimate_id: 'est_1',
      job_fields: { job_type: { name: 'Service' } }, created_at: '2026-10-05T17:00:00Z', updated_at: '2026-10-21T17:00:00Z' },
    { id: 'job_2', invoice_number: '1002', description: 'Troubleshoot breaker', customer: { id: 'cus_1' }, notes: [], work_status: 'scheduled',
      schedule: { scheduled_start: '2026-11-20T16:00:00Z', scheduled_end: '2026-11-20T18:00:00Z' },
      assigned_employees: [{ id: 'pro_2', first_name: 'Nobody', last_name: 'Here' }], created_at: '2026-11-01T17:00:00Z', updated_at: '2026-11-03T17:00:00Z' },
    { id: 'job_3', invoice_number: '1003', description: 'New lighting', customer: { id: 'cus_2' }, notes: [], work_status: 'needs scheduling',
      schedule: {}, assigned_employees: [], created_at: '2026-11-02T17:00:00Z', updated_at: '2026-11-04T17:00:00Z' },
  ],
};
let calls = 0;
const page = (list, q, name) => {
  const p = Number(q.get('page') || 1), n = Number(q.get('page_size') || 10);
  let l = [...list];
  if (q.get('sort_by') === 'updated_at') l.sort((a, b) => (q.get('sort_direction') === 'desc' ? -1 : 1) * a.updated_at.localeCompare(b.updated_at));
  return { page: p, page_size: n, total_pages: Math.max(1, Math.ceil(l.length / n)), total_items: l.length, [name]: l.slice((p - 1) * n, p * n) };
};
const fake = http.createServer((req, res) => {
  calls++;
  const u = new URL(req.url, 'http://x'), q = u.searchParams;
  const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (req.headers.authorization !== `Token ${KEY}`) return send(401, { message: 'bad key' });
  if (u.pathname === '/customers') return send(200, page(hcp.customers, q, 'customers'));
  if (u.pathname === '/jobs') return send(200, page(hcp.jobs, q, 'jobs'));
  if (u.pathname === '/estimates') return send(200, page(hcp.estimates, q, 'estimates'));
  const m = u.pathname.match(/^\/estimates\/[^/]+\/options\/([^/]+)\/line_items$/);
  if (m) return send(200, page(hcp.lines[m[1]] || [], q, 'line_items'));
  send(404, { message: 'nope' });
});

let server, base, db, tok;
async function call(method, p, body) {
  const res = await fetch(base + '/api' + p, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json() };
}
before(async () => {
  fake.listen(0); await new Promise(r => fake.once('listening', r));
  process.env.HCP_API_BASE = `http://127.0.0.1:${fake.address().port}`;
  db = D.open(':memory:');
  server = createApp(db).listen(0); await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  tok = (await call('POST', '/setup', { name: 'Owner', email: 'o@example.com', password: 'longenough' })).data.token;
  await call('POST', '/users', { name: 'Tess Tech', email: 'tess@example.com', password: 'password123', role: 'tech' });
  // already here before the pull: the customer (old phone, notes typed here) and two jobs
  const c = (await call('POST', '/customers', { name: 'Alex Sample', email: 'alex@example.com', phone: '555-999-9999', notes: 'Typed in Field Ops' })).data.id;
  const j1 = (await call('POST', '/jobs', { customer_id: c, title: 'Panel job (our title)', billing_type: 'fixed', contract_amount: 1800 })).data.id;
  db.prepare("UPDATE jobs SET number = '1001', status = 'invoiced' WHERE id = ?").run(j1);
  const j2 = (await call('POST', '/jobs', { customer_id: c, title: 'Breaker' })).data.id;
  db.prepare("UPDATE jobs SET number = '1002', status = 'on_hold' WHERE id = ?").run(j2);
});
after(() => { server.close(); fake.close(); delete process.env.HCP_API_BASE; });

test('without a key it says where to add one; a wrong key is reported', async () => {
  assert.equal((await call('POST', '/hcp/pull', {})).status, 400);
  await call('PUT', '/settings', { hcp_api_key: 'wrong' });
  const t = await call('POST', '/hcp/test');
  assert.equal(t.status, 400); assert.match(t.data.error, /refused the API key/);
  const s = (await call('GET', '/me')).data.settings;
  assert.equal(s.hcp_api_key, '', 'the key is never sent back to the browser'); assert.equal(s.hcp_api_key_set, '1');
  await call('PUT', '/settings', { hcp_api_key: KEY });
  assert.deepEqual((await call('POST', '/hcp/test')).data, { customers: 2, jobs: 3, estimates: 2 });
});

test('a full pull brings customers, estimates, jobs and every kind of note up to date', async () => {
  assert.equal((await call('POST', '/hcp/pull', { full: true })).status, 200);
  await HCP._waitIdle();
  const st = (await call('GET', '/hcp/status')).data.last;
  assert.equal(st.failed, false, st.message);

  const alex = db.prepare("SELECT * FROM customers WHERE email = 'alex@example.com'").all();
  assert.equal(alex.length, 1, 'matched by email, not duplicated');
  assert.equal(alex[0].phone, '555-300-0001', 'HCP phone wins'); assert.equal(alex[0].alt_phone, '555-300-0002');
  assert.equal(alex[0].notes, 'Typed in Field Ops', 'our own notes kept');
  assert.equal(alex[0].hcp_notes, 'Gate code 1234. Dog in yard.', 'customer notes from HCP');
  assert.equal(alex[0].hcp_id, 'cus_1');
  const biz = db.prepare("SELECT * FROM customers WHERE hcp_id = 'cus_2'").get();
  assert.equal(biz.name, 'Example Builders LLC'); assert.equal(biz.type, 'commercial');
  assert.equal(db.prepare("SELECT count(*) n FROM locations WHERE hcp_id IN ('adr_1','adr_2')").get().n, 2);

  const e1 = db.prepare("SELECT * FROM estimates WHERE number = '5001'").get();
  assert.equal(e1.status, 'approved'); assert.equal(e1.hcp_id, 'est_1');
  const opts = db.prepare('SELECT * FROM estimate_options WHERE estimate_id = ? ORDER BY sort').all(e1.id);
  assert.deepEqual(opts.map(o => o.name), ['Good', 'Better']);
  assert.equal(e1.approved_option_id, opts[1].id, 'the option the customer chose');
  const items = db.prepare('SELECT description, unit_price, option_id FROM estimate_items WHERE estimate_id = ? ORDER BY sort').all(e1.id);
  assert.equal(items.length, 3); assert.equal(items[1].description, 'Panel replacement\n200A, 40 space'); assert.equal(items[1].unit_price, 1500);
  const en = (await call('GET', `/estimates/${e1.id}`)).data;
  assert.equal(en.internal_notes.length, 1); assert.equal(en.internal_notes[0].body, '[Good] Customer wants copper');
  assert.equal(en.notes, null, 'HCP notes are not put on the customer-facing estimate');
  assert.equal(db.prepare("SELECT status FROM estimates WHERE number = '5002'").get().status, 'sent');

  const j1 = db.prepare("SELECT * FROM jobs WHERE number = '1001'").get();
  assert.equal(j1.status, 'invoiced', 'an invoiced job stays invoiced'); assert.equal(j1.title, 'Panel job (our title)', 'title untouched');
  assert.equal(j1.billing_type, 'fixed'); assert.equal(j1.contract_amount, 1800, 'money untouched');
  assert.equal(j1.description, 'Panel swap\nPer estimate 5001'); assert.equal(j1.hcp_id, 'job_1');
  const jd = (await call('GET', `/jobs/${j1.id}`)).data;
  assert.deepEqual(jd.notes.map(n => n.body).sort(), ['Bring 200A main', 'Call before arrival']);
  assert.deepEqual(jd.tech_ids, [db.prepare("SELECT id FROM users WHERE email = 'tess@example.com'").get().id], 'tech from HCP assigned');
  assert.equal(db.prepare("SELECT job_id FROM estimates WHERE number = '5001'").get().job_id, j1.id, 'estimate linked to its job');
  const j2 = db.prepare("SELECT * FROM jobs WHERE number = '1002'").get();
  assert.equal(j2.status, 'on_hold', 'on hold here stays on hold while HCP only says scheduled');
  assert.equal(j2.scheduled_start, '2026-11-20T16:00:00Z');
  const j3 = db.prepare("SELECT * FROM jobs WHERE number = '1003'").get();
  assert.equal(j3.status, 'unscheduled'); assert.equal(j3.title, 'New lighting');
  assert.ok(st.problems.some(p => /Nobody Here/.test(p)), 'unknown tech is reported');
});

test('pulling again changes nothing and never duplicates notes; a changed note is updated', async () => {
  const before = { jn: db.prepare('SELECT count(*) n FROM job_notes').get().n, en: db.prepare('SELECT count(*) n FROM estimate_notes').get().n,
    est: db.prepare('SELECT count(*) n FROM estimates').get().n, jobs: db.prepare('SELECT count(*) n FROM jobs').get().n, cust: db.prepare('SELECT count(*) n FROM customers').get().n };
  hcp.jobs[0].notes[0].content = 'Bring 200A main + meter seal';
  hcp.jobs[0].updated_at = '2026-11-12T17:00:00Z';
  await call('POST', '/hcp/pull', { full: true }); await HCP._waitIdle();
  assert.equal(db.prepare('SELECT count(*) n FROM job_notes').get().n, before.jn);
  assert.equal(db.prepare('SELECT count(*) n FROM estimate_notes').get().n, before.en);
  assert.equal(db.prepare('SELECT count(*) n FROM estimates').get().n, before.est);
  assert.equal(db.prepare('SELECT count(*) n FROM jobs').get().n, before.jobs);
  assert.equal(db.prepare('SELECT count(*) n FROM customers').get().n, before.cust);
  assert.ok(db.prepare("SELECT 1 x FROM job_notes WHERE body = 'Bring 200A main + meter seal'").get());
});

test('"Pull changes now" only reads what changed since the last pull; non-admins are refused', async () => {
  hcp.jobs[2].work_status = 'scheduled'; hcp.jobs[2].schedule = { scheduled_start: '2026-12-01T16:00:00Z', scheduled_end: '2026-12-01T18:00:00Z' };
  hcp.jobs[2].updated_at = new Date(Date.now() + 60000).toISOString();
  calls = 0;
  const r = await call('POST', '/hcp/pull', {}); assert.equal(r.status, 200); assert.ok(r.data.since);
  await HCP._waitIdle();
  assert.equal(db.prepare("SELECT status FROM jobs WHERE number = '1003'").get().status, 'scheduled');
  assert.equal((await call('GET', '/hcp/status')).data.last.stats.jobs.updated, 1);
  assert.ok(calls <= 4, `only one page per list (${calls} calls)`);
  const t = (await call('POST', '/login', { email: 'tess@example.com', password: 'password123' })).data.token;
  const res = await fetch(base + '/api/hcp/pull', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t }, body: '{}' });
  assert.equal(res.status, 403);
});
