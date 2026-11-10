'use strict';
// A4Y Time Clock sync + commercial dashboard.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const D = require('../server/db');
const TC = require('../server/timeclock');
const { createApp } = require('../server/app');

let server, base, db;
const tok = {};
async function call(who, method, p, body) {
  const res = await fetch(base + '/api' + p, { method, headers: { 'Content-Type': 'application/json', ...(tok[who] ? { Authorization: 'Bearer ' + tok[who] } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json() };
}
const cc = code => db.prepare('SELECT id FROM cost_codes WHERE code = ?').get(code).id;
const ids = {};
// exactly the header row of the "Time Entries" tab
const HEAD = 'Entry ID,Employee ID,Employee,Date,Start,End,Hours,Job #,Job name,Category,Cost code,Cost code description,Note,Source,Updated,Labor Amt.';
const row = (...v) => v.map(x => /[,"]/.test(String(x)) ? `"${String(x).replace(/"/g, '""')}"` : x).join(',');

before(async () => {
  db = D.open(':memory:');
  server = createApp(db).listen(0);
  await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  tok.admin = (await call(null, 'POST', '/setup', { name: 'Nathan Carter', email: 'o@x.com', password: 'longenough' })).data.token;
  ids.kayla = (await call('admin', 'POST', '/users', { name: 'Kayla Guinn', email: 'k@x.com', password: 'password123', role: 'office', burden_pct: 35 })).data.id;
  ids.cust = (await call('admin', 'POST', '/customers', { name: 'Summit GC', type: 'commercial' })).data.id;
});
after(() => server.close());

test('time clock times are read in Boise time, daylight saving included', () => {
  assert.equal(TC.toUtc('9/11/2026 6:45 AM', 'America/Boise'), '2026-09-11T12:45:00.000Z');   // MDT, UTC-6
  assert.equal(TC.toUtc('1/15/2026 6:45 PM', 'America/Boise'), '2026-01-16T01:45:00.000Z');   // MST, UTC-7
  assert.equal(TC.toUtc('11/1/2026 12:30 AM', 'America/Boise'), '2026-11-01T06:30:00.000Z');  // before the fall-back hour
  assert.equal(TC.toUtc('2026-09-11T12:45:00Z', 'America/Boise'), '2026-09-11T12:45:00.000Z');
});

test('CSV of the Time Entries tab: shop time, codes, unknown people, job numbers that link later; re-sync is idempotent', async () => {
  const csv = [HEAD,
    row('T6F18122F8A', 'EA05B4B3496', 'Kayla Guinn', 'Fri 9/11/2026', '9/11/2026 6:45 AM', '9/11/2026 9:12 AM', '2.45', '0000', 'Shop / Office', '80 Office & Overhead', '8025-L', 'Receptionist', '', 'Clock (edited)', '9/11/2026 11:26 AM', '$53.90'),
    row('T1000000001', 'E111', 'Jezrael Wilson', 'Mon 9/14/2026', '9/14/2026 7:00 AM', '9/14/2026 3:30 PM', '8.00', '2417', 'Summit Medical', '08 Raceway', '0810-L', 'EMT', 'Lunch deducted', 'Clock', '9/14/2026 3:30 PM', '$192.00'),
    row('T1000000002', 'E111', 'Jezrael Wilson', 'Tue 9/15/2026', '9/15/2026 7:00 AM', '9/15/2026 3:30 PM', '8.00', '2417', 'Summit Medical', '09 Conductors', '0910-L', 'Branch Wire', '', 'Clock', '9/15/2026 3:30 PM', '$192.00'),
    row('T1000000003', 'E111', 'Jezrael Wilson', 'Wed 9/16/2026', '9/16/2026 7:00 AM', '', '', '2417', 'Summit Medical', '09 Conductors', '0910-L', 'Branch Wire', '', 'Clock', '', ''),
  ].join('\n');
  const r = await call('admin', 'POST', '/timeclock/upload', { csv });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.created, 4); assert.deepEqual(r.data.people_added, ['Jezrael Wilson']); assert.deepEqual(r.data.unmatched_jobs, { 2417: 'Summit Medical' });
  const shop = db.prepare("SELECT * FROM time_entries WHERE external_id = 'T6F18122F8A'").get();
  assert.equal(shop.user_id, ids.kayla); assert.equal(shop.kind, 'shop'); assert.equal(shop.job_id, null); assert.equal(shop.cost_code_id, cc('8025'));
  assert.equal(shop.clock_in, '2026-09-11T12:45:00.000Z'); assert.equal(Date.parse(shop.clock_out) - Date.parse(shop.clock_in), 2.45 * 36e5);
  assert.equal(shop.hourly_wage, 22); assert.equal(shop.hourly_cost, 29.7);  // $53.90 / 2.45 h, + 35% burden
  assert.equal(db.prepare('SELECT timeclock_id FROM users WHERE id = ?').get(ids.kayla).timeclock_id, 'EA05B4B3496', 'ID learned from the name match');
  const jez = db.prepare("SELECT * FROM users WHERE name = 'Jezrael Wilson'").get();
  assert.equal(jez.active, 0); assert.equal(jez.role, 'tech'); assert.equal(jez.timeclock_id, 'E111');
  assert.equal(db.prepare("SELECT clock_out FROM time_entries WHERE external_id = 'T1000000003'").get().clock_out, null, 'still clocked in');
  const status = (await call('admin', 'GET', '/timeclock/status')).data;
  assert.equal(status.unlinked[0].ext_job, '2417'); assert.equal(status.unlinked[0].n, 3);

  // the project gets time clock job # 2417 → its hours attach
  ids.proj = (await call('admin', 'POST', '/jobs', { customer_id: ids.cust, title: 'Summit Medical Office', is_project: 1, billing_type: 'fixed', contract_amount: 50000, timeclock_job: '2417',
    start_date: '2026-09-01', end_date: '2026-12-31' })).data.id;
  assert.equal(db.prepare('SELECT COUNT(*) n FROM time_entries WHERE job_id = ?').get(ids.proj).n, 3);
  // same file again: nothing duplicated; a changed row updates
  const again = await call('admin', 'POST', '/timeclock/upload', { csv });
  assert.equal(again.data.created, 0); assert.equal(again.data.updated, 0); assert.equal(again.data.unchanged, 4);
  const edited = await call('admin', 'POST', '/timeclock/upload', { csv: csv.replace(/9\/16\/2026 7:00 AM,,,2417/, '9/16/2026 7:00 AM,9/16/2026 1:00 PM,6.00,2417') });
  assert.equal(edited.data.updated, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM time_entries WHERE external_id IS NOT NULL').get().n, 4);
  assert.equal((await call('admin', 'POST', '/timeclock/upload', { csv: 'Name,Hours\nx,1' })).status, 400);
});

test('automatic pull from the export script: data, wrong link, wrong key', async () => {
  await call('admin', 'PUT', '/settings', { timeclock_url: 'https://script.google.com/macros/s/ABC/exec', timeclock_key: 'k3y' });
  let asked = '';
  const ok = async url => { asked = url; return new Response(JSON.stringify({ entries: [{ 'Entry ID': 'T2000000001', 'Employee ID': 'E111', Employee: 'Jezrael Wilson', Date: 'Thu 9/17/2026',
    Start: '9/17/2026 7:00 AM', End: '9/17/2026 3:30 PM', Hours: '8.00', 'Job #': '2417', 'Cost code': '0810-L', 'Labor Amt.': '$192.00' }],
    cost_codes: [{ Code: '0810-L', Description: 'EMT', Category: '08 Raceway', Hide: 'FALSE' }, { Code: '9999-L', Description: 'New thing', Category: '90 Cost Adjustments', Hide: 'FALSE' }] }), { status: 200 }); };
  const r = await TC.pull(db, { fetchImpl: ok });
  assert.match(asked, /key=k3y/); assert.equal(r.created, 1); assert.deepEqual(r.codes_added, ['9999']);
  assert.equal(db.prepare("SELECT job_id FROM time_entries WHERE external_id = 'T2000000001'").get().job_id, ids.proj);
  await assert.rejects(TC.pull(db, { fetchImpl: async () => new Response('<html>Sign in</html>', { status: 200 }) }), /web page, not data/);
  await assert.rejects(TC.pull(db, { fetchImpl: async () => new Response(JSON.stringify({ error: 'Not allowed: wrong or missing key' }), { status: 200 }) }), /wrong or missing key/);
  await call('admin', 'PUT', '/settings', { timeclock_url: 'https://evil.example.com/x' });
  await assert.rejects(TC.pull(db), /script\.google\.com/);
});

test('commercial dashboard: contract, EAC, margin vs target, CPI, commitments, pending COs, exceptions', async () => {
  await call('admin', 'PUT', `/jobs/${ids.proj}/budgets`, { budgets: [{ cost_code_id: cc('0810'), budget_hours: 100, budget_material: 5000 }, { cost_code_id: cc('0910'), budget_hours: 100, budget_material: 5000 }] });
  await call('admin', 'PUT', `/projects/${ids.proj}/budgets`, { codes: [{ cost_code_id: cc('0810'), percent_complete: 20 }] });
  // an open PO (commitment) and a pending change order
  const vendor = (await call('admin', 'POST', '/vendors', { name: 'CED' })).data.id;
  const po = (await call('admin', 'POST', '/purchase-orders', { vendor_id: vendor, job_id: ids.proj, lines: [{ description: 'Wire', qty: 10, unit_cost: 100, cost_code_id: cc('0910') }] })).data.id;
  db.prepare("UPDATE purchase_orders SET status = 'submitted' WHERE id = ?").run(po);
  await call('admin', 'POST', '/estimates', { customer_id: ids.cust, job_id: ids.proj, change_order: 1, title: 'Add 4 circuits', items: [{ description: 'Circuits', qty: 1, unit_price: 2500, unit_cost: 1500 }] });
  const d = (await call('admin', 'GET', '/projects/dashboard')).data;
  assert.equal(d.money, true);
  const p = d.projects.find(x => x.id === ids.proj);
  assert.equal(p.contract, 50000); assert.equal(p.open_commit, 1000); assert.equal(p.pending_co, 2500);
  assert.ok(p.budget_cost > 10000, `budget ${p.budget_cost}`);
  assert.equal(p.percent_complete, p.percent_complete); // set from cost codes
  assert.ok(p.ev > 0 && p.cpi > 0, JSON.stringify(p));
  assert.ok(p.eac >= p.actual_cost + p.open_commit);
  assert.equal(p.margin, Math.round((50000 - p.eac) * 100) / 100);
  assert.equal(d.totals.contract, 50000); assert.equal(d.totals.target_margin, 18);
  assert.ok(d.exceptions.find(e => e.key === 'co').count === 1);
  assert.ok(p.spi != null, 'start/end dates give a straight-line plan');
  assert.ok(d.divisions.some(x => /08/.test(x.division)), JSON.stringify(d.divisions));
  // someone without "see costs" gets hours and progress only
  const off = (await call('admin', 'POST', '/users', { name: 'Ollie', email: 'ollie@x.com', password: 'password123', role: 'office' })).data.id;
  tok.off = (await call(null, 'POST', '/login', { email: 'ollie@x.com', password: 'password123' })).data.token;
  const me = (await call('off', 'GET', '/me')).data.user;
  await call('admin', 'PUT', `/users/${off}`, { perms: { ...me.perms, see_costs: false } });
  const h = (await call('off', 'GET', '/projects/dashboard')).data;
  assert.equal(h.money, false); assert.equal(h.totals.contract, undefined); assert.equal(h.projects[0].margin, undefined); assert.ok(h.projects[0].hours > 0);
});
