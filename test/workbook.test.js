'use strict';
// Commercial projects in the A4YE job tracker format: SOV, pay apps (G702/G703), CO log, RFI, safety, milestones, logs.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const D = require('../server/db');
const { createApp } = require('../server/app');

let server, base, db;
const tok = {}, ids = {};
async function call(who, method, p, body) {
  const res = await fetch(base + '/api' + p, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok[who] }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json() };
}
const cc = code => db.prepare('SELECT id FROM cost_codes WHERE code = ?').get(code).id;
const ago = n => { const d = new Date(Date.now() - n * 864e5); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

before(async () => {
  db = D.open(':memory:');
  server = createApp(db).listen(0); await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  tok.admin = (await call(null, 'POST', '/setup', { name: 'Owner', email: 'o@x.com', password: 'longenough' })).data.token;
  ids.tech = (await call('admin', 'POST', '/users', { name: 'Jay', email: 'j@x.com', password: 'password123', role: 'tech', hourly_wage: 40, burden_pct: 25 })).data.id;
  tok.tech = (await call(null, 'POST', '/login', { email: 'j@x.com', password: 'password123' })).data.token;
  ids.cust = (await call('admin', 'POST', '/customers', { name: 'Summit GC', company: 'Summit Builders' })).data.id;
  ids.job = (await call('admin', 'POST', '/jobs', { customer_id: ids.cust, title: 'Medical Office TI', is_project: 1, billing_type: 'fixed', contract_amount: 100000, retainage_pct: 10, tech_ids: [ids.tech],
    start_date: ago(30), end_date: ago(-60) })).data.id;
  // budget: raceway 08 and devices 10
  await call('admin', 'PUT', `/jobs/${ids.job}/budgets`, { budgets: [{ cost_code_id: cc('0810'), budget_hours: 300, budget_material: 15000 }, { cost_code_id: cc('1010'), budget_hours: 100, budget_material: 5000 }] });
});
after(() => server.close());

test('SOV: mobilization + one line per budgeted division, adds up to the contract; override and protect billed lines', async () => {
  const r = await call('admin', 'POST', `/projects/${ids.job}/sov/build`, { mobilization_pct: 5 });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const L = r.data.lines;
  assert.deepEqual(L.map(l => l.division), ['MOB', '08', '10']);
  assert.equal(L[0].scheduled_value, 5000); assert.equal(r.data.totals.scheduled_value, 100000); assert.equal(r.data.variance, 0);
  assert.ok(L[1].scheduled_value > L[2].scheduled_value, 'raceway has the bigger budget');
  ids.mob = L[0].id; ids.race = L[1].id; ids.dev = L[2].id;
  const ov = await call('admin', 'PUT', `/projects/${ids.job}/sov`, { lines: [{ id: ids.race, override_value: 70000 }, { id: ids.dev, override_value: 25000 }] });
  assert.equal(ov.data.totals.scheduled_value, 100000);
  assert.equal(ov.data.lines.find(l => l.id === ids.race).scheduled_value, 70000);
});

test('pay apps: billing entry → G702 math (work, stored, retainage, net due), invoice per app, locked after invoicing', async () => {
  const a1 = (await call('admin', 'POST', `/projects/${ids.job}/pay-apps`, { period_to: ago(20) })).data.id;
  // too much: more than the line's scheduled value
  const over = await call('admin', 'PUT', `/pay-apps/${a1}`, { lines: [{ sov_line_id: ids.mob, work_this_period: 6000 }] });
  assert.equal(over.status, 400); assert.match(over.data.error, /more than its scheduled value/);
  let r = await call('admin', 'PUT', `/pay-apps/${a1}`, { lines: [{ sov_line_id: ids.mob, work_this_period: 5000 }, { sov_line_id: ids.race, work_this_period: 15000, stored_balance: 5000 }] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.work_this_period, 20000); assert.equal(r.data.stored_balance, 5000); assert.equal(r.data.completed_and_stored, 25000);
  assert.equal(r.data.gross_this_app, 25000); assert.equal(r.data.retainage_to_date, 2500); assert.equal(r.data.retainage_this_app, 2500); assert.equal(r.data.net_due, 22500);
  // second app before the first is invoiced: allowed to enter, not to invoice
  const a2 = (await call('admin', 'POST', `/projects/${ids.job}/pay-apps`, { period_to: ago(5) })).data.id;
  assert.equal((await call('admin', 'POST', `/projects/${ids.job}/pay-apps`, { period_to: ago(25) })).status, 400, 'periods go forward');
  r = await call('admin', 'PUT', `/pay-apps/${a2}`, { lines: [{ sov_line_id: ids.race, work_this_period: 20000, stored_balance: 0 }, { sov_line_id: ids.dev, work_this_period: 5000 }] });
  // stored 5000 installed and billed in place: H2 = 20000+15000+5000 work... = 45000 work to date, 0 stored
  assert.equal(r.data.work_to_date, 45000); assert.equal(r.data.completed_and_stored, 45000); assert.equal(r.data.gross_this_app, 20000);
  assert.equal(r.data.retainage_to_date, 4500); assert.equal(r.data.retainage_this_app, 2000); assert.equal(r.data.net_due, 18000);
  assert.equal((await call('admin', 'POST', `/pay-apps/${a2}/invoice`)).status, 400, 'App 1 must be invoiced first');
  // invoice App #1
  const i1 = await call('admin', 'POST', `/pay-apps/${a1}/invoice`);
  assert.equal(i1.status, 200, JSON.stringify(i1.data));
  const inv = (await call('admin', 'GET', `/invoices/${i1.data.invoice_id}`)).data;
  assert.equal(inv.total, 22500); assert.equal(inv.retainage, 2500); assert.equal(inv.billing_kind, 'pay_app');
  assert.ok(inv.items.some(i => /Less retainage withheld \(10%\)/.test(i.description)));
  // the job's billing position counts work billed incl. retainage withheld
  const bill = (await call('admin', 'GET', `/jobs/${ids.job}/billing`)).data;
  if (bill.billed_to_date !== undefined) assert.equal(bill.billed_to_date, 25000);
  const locked = await call('admin', 'PUT', `/pay-apps/${a1}`, { lines: [{ sov_line_id: ids.mob, work_this_period: 0 }] });
  assert.equal(locked.status, 400); assert.match(locked.data.error, /Void that invoice/);
  const i2 = await call('admin', 'POST', `/pay-apps/${a2}/invoice`);
  assert.equal((await call('admin', 'GET', `/invoices/${i2.data.invoice_id}`)).data.total, 18000);
  // G702 / G703 for App #2
  const pr = (await call('admin', 'GET', `/pay-apps/${a2}/print`)).data;
  assert.equal(pr.g702.contract_to_date, 100000); assert.equal(pr.g702.completed_and_stored, 45000); assert.equal(pr.g702.retainage, 4500);
  assert.equal(pr.g702.earned_less_retainage, 40500); assert.equal(pr.g702.previous_certificates, 22500); assert.equal(pr.g702.current_due, 18000); assert.equal(pr.g702.balance_to_finish, 59500);
  const race = pr.g703.find(l => l.division === '08');
  assert.deepEqual([race.from_previous, race.this_period, race.stored, race.completed_and_stored, race.balance], [15000, 20000, 0, 35000, 35000]);
  // paid in full → Paid
  await call('admin', 'POST', `/invoices/${i1.data.invoice_id}/payments`, { amount: 22500, paid_at: ago(1), method: 'check' });
  const apps = (await call('admin', 'GET', `/projects/${ids.job}/pay-apps`)).data.apps;
  assert.equal(apps[0].status, 'Paid'); assert.equal(apps[0].open_balance, 0); assert.equal(apps[1].status, 'Submitted');
});

test('change orders: priced like the workbook (labor × rate + material + tax, then OH and profit); approval adds to contract and SOV', async () => {
  const r = await call('admin', 'POST', `/projects/${ids.job}/change-orders`, { description: 'Add 6 floor boxes', type: 'Owner', labor_hrs: 10, material: 1000, oh_pct: 18, profit_pct: 15, days_added: 2, reference: 'RFI-004' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const list = (await call('admin', 'GET', `/projects/${ids.job}/change-orders`)).data;
  const co = list.rows[0];
  const rate = list.defaults.labor_rate, cost = Math.round((10 * rate + 1000 + 60) * 100) / 100;
  assert.equal(co.total_cost, cost); assert.ok(Math.abs(co.sell_price - cost * 1.18 * 1.15) < 0.05, `${co.sell_price} vs ${cost * 1.18 * 1.15}`);
  assert.equal(co.status, 'Draft'); assert.equal(co.type, 'Owner'); assert.equal(co.days_added, 2); assert.equal(co.labor_hrs, 10);
  await call('admin', 'PUT', `/change-orders/${co.id}`, { status: 'Submitted' });
  assert.equal((await call('admin', 'GET', `/projects/${ids.job}/change-orders`)).data.rows[0].submitted !== null, true);
  await call('admin', 'PUT', `/change-orders/${co.id}`, { status: 'Approved' });
  const sov = (await call('admin', 'GET', `/projects/${ids.job}/sov`)).data;
  assert.equal(sov.contract.change_orders, co.sell_price);
  const coLine = sov.lines.find(l => l.division === 'CO');
  assert.equal(coLine.scheduled_value, co.sell_price); assert.equal(sov.variance, 0);
  assert.equal((await call('admin', 'PUT', `/change-orders/${co.id}`, { status: 'Nope' })).status, 400);
});

test('RFI & submittal, safety & quality, milestones: IDs, overdue/late status, flags on the project and the company dashboard', async () => {
  let r = await call('admin', 'POST', `/projects/${ids.job}/rfis`, { type: 'RFI', subject: 'Panel L2 location conflicts with duct', date_sent: ago(10), date_needed: ago(3), status: 'Open', ball_in_court: 'Architect', cost_code_id: cc('0720') });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  await call('admin', 'POST', `/projects/${ids.job}/rfis`, { type: 'Submittal', subject: 'Lighting fixture package', date_sent: ago(5), status: 'Approved as Noted', date_returned: ago(1) });
  assert.equal((await call('admin', 'POST', `/projects/${ids.job}/rfis`, { subject: 'x', status: 'Maybe' })).status, 400);
  const rf = (await call('admin', 'GET', `/projects/${ids.job}/rfis`)).data.rows;
  assert.deepEqual(rf.map(x => x.ref), ['RFI-001', 'SUB-001']);
  assert.equal(rf[0].overdue, true); assert.equal(rf[0].days_late, 3); assert.equal(rf[1].open, false);
  // a tech on the job can report a near miss, not an RFI
  assert.equal((await call('tech', 'POST', `/projects/${ids.job}/rfis`, { subject: 'x' })).status, 403);
  r = await call('tech', 'POST', `/projects/${ids.job}/safety`, { date: ago(4), type: 'Near Miss', description: 'Unsecured ladder at stair 2', severity: 'High', due_date: ago(1) });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const sq = (await call('admin', 'GET', `/projects/${ids.job}/safety`)).data.rows;
  assert.equal(sq[0].ref_id, 'SQ-001'); assert.equal(sq[0].status, 'Overdue');
  await call('admin', 'POST', `/projects/${ids.job}/milestones`, { name: 'Rough-in inspection', baseline_date: ago(5), forecast_date: ago(2) });
  await call('admin', 'POST', `/projects/${ids.job}/milestones`, { name: 'Energize', baseline_date: ago(-20), forecast_date: ago(-25) });
  const ms = (await call('admin', 'GET', `/projects/${ids.job}/milestones`)).data.rows;
  assert.deepEqual(ms.map(m => m.status), ['Late', 'At Risk']); assert.equal(ms[0].variance_days, 3);
  const flags = (await call('admin', 'GET', `/projects/${ids.job}`)).data.summary.flags.join(' | ');
  assert.match(flags, /1 RFI\/submittal\(s\) past/); assert.match(flags, /1 safety\/quality item\(s\) past due/); assert.match(flags, /1 milestone\(s\) late/);
  const dash = (await call('admin', 'GET', '/projects/dashboard')).data;
  assert.equal(dash.exceptions.find(e => e.key === 'rfi').count, 1); assert.equal(dash.exceptions.find(e => e.key === 'safety').count, 1); assert.equal(dash.exceptions.find(e => e.key === 'ms').count, 1);
  // close the safety item
  await call('admin', 'PUT', `/safety/${sq[0].id}`, { closed_date: ago(0), corrective_action: 'Ladder tied off; toolbox talk held' });
  assert.equal((await call('admin', 'GET', `/projects/${ids.job}/safety`)).data.rows[0].status, 'Closed');
});

test('labor log and cost log', async () => {
  db.prepare("INSERT INTO time_entries (user_id, job_id, kind, clock_in, clock_out, hourly_cost, hourly_wage, cost_code_id, external_id) VALUES (?,?, 'job', ?, ?, 50, 40, ?, 'T1')")
    .run(ids.tech, ids.job, `${ago(3)}T14:00:00Z`, `${ago(3)}T22:00:00Z`, cc('0810'));
  const ll = (await call('admin', 'GET', `/projects/${ids.job}/labor-log`)).data;
  assert.equal(ll.rows[0].hours, 8); assert.equal(ll.rows[0].labor_cost, 400); assert.equal(ll.rows[0].source, 'A4Y Time Clock'); assert.equal(ll.rows[0].cost_code, '0810');
  const vendor = (await call('admin', 'POST', '/vendors', { name: 'CED' })).data.id;
  const po = (await call('admin', 'POST', '/purchase-orders', { vendor_id: vendor, job_id: ids.job, lines: [{ description: '3/4 EMT', qty: 100, unit_cost: 2, cost_code_id: cc('0810') }] })).data.id;
  db.prepare("UPDATE purchase_orders SET status = 'submitted' WHERE id = ?").run(po);
  await call('admin', 'POST', `/jobs/${ids.job}/materials`, { description: 'Unistrut', qty: 4, unit_cost: 25, source: 'supply_house' });
  const cl = (await call('admin', 'GET', `/projects/${ids.job}/cost-log`)).data;
  assert.equal(cl.totals.open_commit, 200); assert.equal(cl.totals.total_cost, 100);
  assert.ok(cl.rows.some(r => r.status === 'Committed (PO)')); assert.ok(cl.rows.some(r => r.description === 'Unistrut' && r.status === 'Used'));
});

test('one way of billing per contract: pay apps and Billing-tab progress invoices can\'t both bill the same project', async () => {
  // this project bills by pay app → the job's Billing tab refuses
  const r = await call('admin', 'POST', `/jobs/${ids.job}/bill-fixed`, { mode: 'percent', pct: 50 });
  assert.equal(r.status, 400); assert.match(r.data.error, /bills by pay application/);
  // a project billed from the Billing tab can't start pay apps until those invoices are voided
  const job2 = (await call('admin', 'POST', '/jobs', { customer_id: ids.cust, title: 'Warehouse lighting', is_project: 1, billing_type: 'fixed', contract_amount: 20000 })).data.id;
  await call('admin', 'PUT', `/jobs/${job2}/budgets`, { budgets: [{ cost_code_id: cc('1110'), budget_hours: 50, budget_material: 4000 }] });
  const inv = (await call('admin', 'POST', `/jobs/${job2}/bill-fixed`, { mode: 'deposit', pct: 20 })).data.id;
  await call('admin', 'POST', `/projects/${job2}/sov/build`, {});
  const blocked = await call('admin', 'POST', `/projects/${job2}/pay-apps`, { period_to: ago(1) });
  assert.equal(blocked.status, 400); assert.match(blocked.data.error, /would bill that work again/);
  await call('admin', 'PUT', `/invoices/${inv}`, { status: 'void' });
  assert.equal((await call('admin', 'POST', `/projects/${job2}/pay-apps`, { period_to: ago(1) })).status, 200);
});
