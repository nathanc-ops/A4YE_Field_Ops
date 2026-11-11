'use strict';
// KPI auto numbers worked out from Field Ops records (instead of Housecall Pro): jobs, estimates, invoices, payments,
// A/R as of Saturday night, schedule vs time clock, purchase orders, headcount; plus the start-week guard, Feed precedence,
// overrides, and the reschedule log.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const D = require('../server/db');
const { createApp } = require('../server/app');
const { xlsx } = require('./_xlsx');

let server, base, db;
const tok = {}, ids = {};
async function call(who, method, p, body) {
  const res = await fetch(base + '/api' + p, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok[who] }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json() };
}
const tab = rows => Object.fromEntries(rows.flatMap((r, i) => r.map((v, j) => [`${String.fromCharCode(65 + j)}${i + 1}`, v]).filter(([, v]) => v !== undefined && v !== '')));
const WEEK = '2026-10-25', PREV = '2026-10-18', OLD = '2026-10-04';   // Sundays; Boise is on MDT (UTC−6) all of this
const at = (d, hhmm) => `${d}T${hhmm}:00.000Z`;                       // UTC instants
const H = ['ID', 'Owner', 'Section', 'Metric', 'Unit', 'Better', 'Target', 'Input', 'Rule', 'Source', 'How measured', 'Target note', 'Active'];
const RULES = [['A1', 'hcp_jobs_completed', '#'], ['A2', 'hcp_revenue_completed', '$'], ['A3', 'hcp_estimates_created', '#'], ['A4', 'hcp_est_won_value', '$'],
  ['A5', 'hcp_inv_sent_value', '$'], ['A6', 'hcp_inv_paid_value', '$'], ['A7', 'snap_ar_0_30', '$'], ['A8', 'clock_paid_hours', 'hrs'], ['A9', 'clock_onsite_hours', 'hrs'],
  ['A10', 'clock_overtime', 'hrs'], ['A11', 'hcp_days_scheduled', '#'], ['A12', 'clock_days_worked', '#'], ['A13', 'clock_tardies', '#'], ['A14', 'ply_materials', '$'],
  ['A15', 'ply_unassigned', '$'], ['A16', 'snap_headcount_field', '#'], ['A17', 'hcp_cancels', '#'], ['A18', 'hcp_est_won_new', '#'], ['A19', 'hcp_days_to_invoice', 'days'],
  ['A20', 'snap_open_estimates', '$'], ['A21', 'hcp_jobs_scheduled', '#']];

before(async () => {
  db = D.open(':memory:');
  server = createApp(db).listen(0); await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  tok.admin = (await call(null, 'POST', '/setup', { name: 'Owner Admin', email: 'owner@x.com', password: 'longenough' })).data.token;
  await call('admin', 'PUT', '/settings', { timezone: 'America/Boise', overtime_weekly_hours: '40', kpi_auto_from: PREV });
  ids.dana = (await call('admin', 'POST', '/users', { name: 'Dana Tech', email: 'dana@x.com', password: 'password123', role: 'tech' })).data.id;
  ids.sam = (await call('admin', 'POST', '/users', { name: 'Sam Tech', email: 'sam@x.com', password: 'password123', role: 'tech' })).data.id;
  const run = (sql, ...a) => db.prepare(sql).run(...a), ins = (sql, ...a) => Number(run(sql, ...a).lastInsertRowid);
  ids.c1 = ins("INSERT INTO customers (name, created_at) VALUES ('Old Customer', '2026-01-01 10:00:00')");
  ids.c2 = ins("INSERT INTO customers (name) VALUES ('New Customer')");
  ins("INSERT INTO jobs (number, customer_id, title, status, created_at) VALUES ('J-1', ?, 'Earlier job', 'completed', '2026-03-01 12:00:00')", ids.c1);
  // two jobs completed in WEEK: one invoiced $1,200, one not invoiced with a $500 contract; one commercial project; one cancelled
  ids.j1 = ins("INSERT INTO jobs (number, customer_id, title, status, created_at, scheduled_start, completed_at) VALUES ('J-10', ?, 'Panel', 'completed', ?, ?, ?)", ids.c1, at('2026-10-20', '15:00'), at('2026-10-26', '15:00'), at('2026-10-27', '20:00'));
  ids.j2 = ins("INSERT INTO jobs (number, customer_id, title, status, created_at, scheduled_start, completed_at, contract_amount) VALUES ('J-11', ?, 'Outlet', 'completed', ?, ?, ?, 500)", ids.c2, at('2026-10-26', '15:00'), at('2026-10-28', '15:00'), at('2026-10-29', '20:00'));
  ins("INSERT INTO jobs (number, customer_id, title, status, created_at, completed_at, contract_amount, is_project) VALUES ('J-12', ?, 'TI', 'completed', ?, ?, 90000, 1)", ids.c1, at('2026-10-01', '15:00'), at('2026-10-30', '20:00'));
  ins("INSERT INTO jobs (number, customer_id, title, status, created_at, completed_at, cancelled_at) VALUES ('J-13', ?, 'Nope', 'cancelled', ?, ?, ?)", ids.c2, at('2026-10-26', '15:00'), at('2026-10-27', '15:00'), at('2026-10-28', '16:00'));
  // invoice for J-10 sent Thu of WEEK, $1,200; $200 paid in WEEK, $1,000 paid the next week (so still owed Saturday night)
  ids.inv = ins("INSERT INTO invoices (number, customer_id, job_id, status, issue_date, sent_at, tax_rate, public_token) VALUES ('INV-1', ?, ?, 'partial', '2026-10-29', ?, 0, 'tok1')", ids.c1, ids.j1, at('2026-10-29', '18:00'));
  run("INSERT INTO invoice_items (invoice_id, description, qty, unit_price, unit_cost, taxable) VALUES (?, 'Panel', 1, 1200, 0, 0)", ids.inv);
  run("INSERT INTO payments (invoice_id, amount, method, paid_at) VALUES (?, 200, 'check', '2026-10-30')", ids.inv);
  run("INSERT INTO payments (invoice_id, amount, method, paid_at) VALUES (?, 1000, 'check', '2026-11-03')", ids.inv);
  // estimates: one created + approved in WEEK for the new customer ($2,000 chosen of options 2,000 / 3,000), one created and still open, one change order
  ids.e1 = ins("INSERT INTO estimates (number, customer_id, status, created_at, sent_at, approved_at, public_token, tax_rate) VALUES ('EST-1', ?, 'approved', ?, ?, ?, 't1', 0)", ids.c2, at('2026-10-25', '18:00'), at('2026-10-26', '18:00'), at('2026-10-28', '18:00'));
  const o1 = ins("INSERT INTO estimate_options (estimate_id, name, sort) VALUES (?, 'Good', 0)", ids.e1), o2 = ins("INSERT INTO estimate_options (estimate_id, name, sort) VALUES (?, 'Best', 1)", ids.e1);
  run("INSERT INTO estimate_items (estimate_id, description, qty, unit_price, unit_cost, option_id) VALUES (?, 'a', 1, 2000, 0, ?)", ids.e1, o1);
  run("INSERT INTO estimate_items (estimate_id, description, qty, unit_price, unit_cost, option_id) VALUES (?, 'b', 1, 3000, 0, ?)", ids.e1, o2);
  run('UPDATE estimates SET approved_option_id = ? WHERE id = ?', o1, ids.e1);
  ids.e2 = ins("INSERT INTO estimates (number, customer_id, status, created_at, sent_at, public_token, tax_rate) VALUES ('EST-2', ?, 'sent', ?, ?, 't2', 0)", ids.c1, at('2026-10-27', '18:00'), at('2026-10-27', '19:00'));
  run("INSERT INTO estimate_items (estimate_id, description, qty, unit_price, unit_cost) VALUES (?, 'c', 1, 750, 0)", ids.e2);
  ins("INSERT INTO estimates (number, customer_id, status, created_at, public_token, tax_rate, change_order) VALUES ('CO-1', ?, 'draft', ?, 't3', 0, 1)", ids.c1, at('2026-10-27', '18:00'));
  // schedule: Dana on J-10 Mon 9:00 local (15:00Z) and Tue 9:00; Sam on J-11 Wed 8:00 local (14:00Z)
  for (const [job, user, s, e] of [[ids.j1, ids.dana, '2026-10-26T15:00', '2026-10-26T20:00'], [ids.j1, ids.dana, '2026-10-27T15:00', '2026-10-27T20:00'], [ids.j2, ids.sam, '2026-10-28T14:00', '2026-10-28T18:00']]) {
    const a = ins("INSERT INTO appointments (job_id, start, end, status) VALUES (?, ?, ?, 'done')", job, `${s}:00.000Z`, `${e}:00.000Z`);
    run('INSERT INTO appointment_techs (appointment_id, user_id) VALUES (?, ?)', a, user);
  }
  // punches: Dana Mon 8:55 local (on time) 9 h on J-10; Tue 9:20 local (late) 35 h on J-10 (forgotten clock-out style long day)
  //          Sam Wed 7:50 local (on time) 6 h shop + 1 h PTO
  const p = (u, job, kind, s, e) => run('INSERT INTO time_entries (user_id, job_id, kind, clock_in, clock_out) VALUES (?, ?, ?, ?, ?)', u, job, kind, s, e);
  p(ids.dana, ids.j1, 'job', '2026-10-26T14:55:00.000Z', '2026-10-26T23:55:00.000Z');
  p(ids.dana, ids.j1, 'job', '2026-10-27T15:20:00.000Z', '2026-10-29T02:20:00.000Z');
  p(ids.sam, null, 'shop', '2026-10-28T13:50:00.000Z', '2026-10-28T19:50:00.000Z');
  p(ids.sam, null, 'pto', '2026-10-29T14:00:00.000Z', '2026-10-29T15:00:00.000Z');
  // purchase orders in WEEK: $100 for J-10, $40 with no job; a draft that doesn't count
  const v = ins("INSERT INTO vendors (name) VALUES ('Supply House')");
  for (const [num, job, status, amt] of [['PO-1', ids.j1, 'submitted', 100], ['PO-2', null, 'received', 40], ['PO-3', null, 'draft', 999]]) {
    const po = ins("INSERT INTO purchase_orders (number, vendor_id, job_id, status, order_date) VALUES (?, ?, ?, ?, '2026-10-28')", num, v, job, status);
    run('INSERT INTO po_lines (po_id, description, qty, unit_cost) VALUES (?, ?, 1, ?)', po, 'stuff', amt);
  }
  // the KPI workbook: one owner with the auto metrics, plus a Feed number and an old-week value
  const metrics = RULES.map(([id, rule, unit]) => [id, 'Owner', 'Auto', `Metric ${id}`, unit, 'Info', '', 'auto', rule, 'Housecall Pro (old)', '', '', 'Y']);
  metrics.push(['M1', 'Owner', 'Typed', 'Cash in bank', '$', 'Higher', 1000, 'manual', '', 'Bank', '', '', 'Y']);
  const wb = xlsx({ Metrics: tab([H, ...metrics]), Settings: tab([['Key', 'Value'], ['EMAIL_Owner', 'owner@x.com']]),
    Values: tab([['Week', 'ID', 'Value', 'Origin', 'Source', 'Entered by', 'Entered at', 'Reason'], [OLD, 'A1', 7, 'manual', '', 'owner@x.com', '2026-10-06 09:00'],
      [WEEK, 'A14', 5, 'manual', '', 'owner@x.com', '2026-11-01 09:00'], [WEEK, 'A6', 999, 'override', '', 'owner@x.com', '2026-11-01 09:00', 'Includes a commercial check']]),
    Feed: tab([['Week', 'ID', 'Value', 'Source', 'Link', 'Note'], [WEEK, 'A15', 77, 'Supplier statement', '', '']]) }).toString('base64');
  const imp = await call('admin', 'POST', '/import/kpi-workbook', { file: wb });
  assert.equal(imp.status, 200, JSON.stringify(imp.data));
  ids.owner = db.prepare("SELECT id FROM kpi_owners WHERE name = 'Owner'").get().id;
});
after(() => server.close());

const pageFor = async week => Object.fromEntries((await call('admin', 'GET', `/kpi/page?owner=${ids.owner}&week=${week}`)).data.sections.flatMap(s => s.metrics).map(m => [m.id, m]));

test('jobs, estimates, invoices and payments for the week', async () => {
  const m = await pageFor(WEEK);
  assert.equal(m.A1.value, 3, 'J-10, J-11 and the commercial project J-12; the cancelled job is left out');
  assert.equal(m.A2.value, 91700, 'J-10 invoiced $1,200 + J-11 contract $500 + J-12 contract $90,000');
  assert.equal(m.A21.value, 1, 'J-11 booked this week with a time (J-10 was booked the week before)');
  assert.equal(m.A3.value, 2, 'EST-1 and EST-2; the change order is left out');
  assert.equal(m.A4.value, 2000, 'approved option, not the largest');
  assert.equal(m.A18.value, 1, 'EST-1 is the new customer\'s first record');
  assert.equal(m.A5.value, 1200); assert.equal(m.A19.value, 1.92, 'completed Tue 2 PM, invoice sent Thu noon (Boise) = 1.92 days');
  assert.equal(m.A1.origin, 'auto'); assert.match(m.A1.auto_source, /^Field Ops: /);
});

test('A/R and open estimates are worked out as of Saturday night', async () => {
  const m = await pageFor(WEEK);
  assert.equal(m.A7.value, 1000, '$1,200 − the $200 paid by Saturday; the $1,000 paid the next week doesn\'t count yet');
  assert.equal(m.A20.value, 750, 'EST-2 is still open; EST-1 was approved before Saturday');
});

test('schedule against the time clock: paid, on-site and overtime hours; days scheduled, worked and tardies', async () => {
  const m = await pageFor(WEEK);
  assert.equal(m.A8.value, 50, 'Dana 9 + 35, Sam 6 shop; PTO left out');
  assert.equal(m.A9.value, 44, 'shop time isn\'t on a job site');
  assert.equal(m.A10.value, 4, 'Dana 44 h → 4 over 40');
  assert.equal(m.A11.value, 3); assert.equal(m.A12.value, 3); assert.equal(m.A13.value, 1, 'Dana Tue 9:20 vs 9:00 + 5 min grace');
  const d = (await call('admin', 'GET', `/kpi/metric/A13?week=${WEEK}`)).data;
  assert.equal(d.detail.length, 1); assert.match(d.detail[0].ref, /first visit 9:00 AM .* first punch 9:20 AM/);
});

test('purchase orders; a Feed number beats Field Ops; a reasoned override stays; a plain typed number gives way', async () => {
  const m = await pageFor(WEEK);
  assert.equal(m.A14.value, 140, 'PO-1 + PO-2, the draft left out; the 5 typed in the sheet gives way to the Field Ops number');
  assert.equal(m.A14.origin, 'auto');
  assert.equal(m.A15.value, 77, 'the Feed number from the sheet wins'); assert.equal(m.A15.origin, 'feed');
  assert.equal(m.A6.value, 999); assert.equal(m.A6.origin, 'override'); assert.equal(m.A6.auto_value, 200, 'the Field Ops number is kept beside it');
});

test('weeks before the start week keep what came from the sheet', async () => {
  const m = await pageFor(OLD);
  assert.equal(m.A1.value, 7); assert.equal(m.A1.origin, 'manual');
  await call('admin', 'PUT', '/kpi/settings', { auto_from: OLD });
  assert.equal((await pageFor(OLD)).A1.value, 0, 'from the start week on, Field Ops is the source');
  await call('admin', 'PUT', '/kpi/settings', { auto_from: PREV });
  const s = (await call('admin', 'GET', '/kpi/setup')).data;
  assert.equal(s.settings.auto_from, PREV); assert.ok(s.rules.some(r => r.key === 'clock_overtime'));
});

test('headcount is taken once and kept; a visit moved counts as a reschedule; set-up can pick the Field Ops number', async () => {
  // the in-progress week's headcount follows the team until the week ends
  const cur = (await call('admin', 'GET', '/kpi/me')).data.week;
  const next = new Date(Date.parse(cur + 'T12:00:00Z') + 7 * 864e5).toISOString().slice(0, 10);
  assert.equal((await pageFor(next)).A16.value, 2);
  await call('admin', 'POST', '/users', { name: 'New Tech', email: 'nt@x.com', password: 'password123', role: 'tech' });
  assert.equal((await pageFor(next)).A16.value, 3);
  assert.equal((await pageFor(PREV)).A16.value, null, 'an older week can\'t be rebuilt from today\'s team');
  // reschedule: moving a future job visit is logged and counted in the week it happened
  const job = db.prepare("SELECT id FROM jobs WHERE number = 'J-11'").get().id;
  const v = (await call('admin', 'POST', '/appointments', { job_id: job, start: '2099-01-05T15:00:00Z', end: '2099-01-05T17:00:00Z' })).data.id;
  await call('admin', 'PUT', `/appointments/${v}`, { start: '2099-01-06T15:00:00Z', end: '2099-01-06T17:00:00Z' });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM appointment_moves').get().n, 1);
  assert.equal((await pageFor(WEEK)).A17.value, 1, 'the cancelled job in WEEK (the move happened this week, not then)');
  // set-up: a typed metric switched to a Field Ops number
  assert.equal((await call('admin', 'PUT', '/kpi/metrics/M1', { rule: 'nope' })).status, 400);
  await call('admin', 'PUT', '/kpi/metrics/M1', { rule: 'hcp_inv_paid_value' });
  const m = await pageFor(WEEK);
  assert.equal(m.M1.input, 'auto'); assert.equal(m.M1.value, 200);
});
