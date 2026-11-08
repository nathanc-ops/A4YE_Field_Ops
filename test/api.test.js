'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const D = require('../server/db');
const C = require('../server/calc');
const { createApp } = require('../server/app');

let server, base, db;
const tokens = {};
async function call(who, method, path, body) {
  const res = await fetch(base + '/api' + path, {
    method, headers: { 'Content-Type': 'application/json', ...(tokens[who] ? { Authorization: 'Bearer ' + tokens[who] } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  return { status: res.status, data };
}

before(async () => {
  db = D.open(':memory:');
  server = createApp(db).listen(0);
  await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

test('docTotals applies discount before tax and only taxes taxable lines', () => {
  const t = C.docTotals({ tax_rate: 10, discount: 100 }, [
    { qty: 1, unit_price: 800, unit_cost: 300, taxable: 1 },
    { qty: 2, unit_price: 100, unit_cost: 0, taxable: 0 },
  ]);
  assert.equal(t.subtotal, 1000);
  assert.equal(t.discount, 100);
  assert.equal(t.tax, 72); // 800 taxable * (1 - 100/1000) * 10%
  assert.equal(t.total, 972);
  assert.equal(t.est_cost, 300);
});

test('first-run setup creates admin and blocks a second setup', async () => {
  let r = await call(null, 'GET', '/setup');
  assert.equal(r.data.needs_setup, true);
  r = await call(null, 'POST', '/setup', { name: 'Owner', email: 'o@x.com', password: 'longenough', company_name: 'Test Electric' });
  assert.equal(r.status, 200);
  tokens.admin = r.data.token;
  r = await call(null, 'POST', '/setup', { name: 'X', email: 'x@x.com', password: 'longenough' });
  assert.equal(r.status, 400);
  r = await call(null, 'GET', '/jobs');
  assert.equal(r.status, 401);
});

test('full workflow: estimate -> approve -> job -> time & materials -> invoice -> payment -> reports', async () => {
  let r = await call('admin', 'POST', '/users', { name: 'Tech T', email: 't@x.com', password: 'longenough', role: 'tech', hourly_wage: 40, burden_pct: 25, bill_rate: 120 });
  const techId = r.data.id;
  tokens.tech = (await call(null, 'POST', '/login', { email: 't@x.com', password: 'longenough' })).data.token;

  r = await call('admin', 'POST', '/customers', { name: 'Pat Home', type: 'residential', email: 'pat@x.com', location: { address: '1 Elm' } });
  const cid = r.data.id;
  const cust = (await call('admin', 'GET', `/customers/${cid}`)).data;
  const lid = cust.locations[0].id;

  r = await call('admin', 'POST', '/pricebook', { name: 'Panel upgrade', kind: 'service', unit_cost: 800, unit_price: 3000, labor_hours: 8 });
  const pbPanel = r.data.id;
  r = await call('admin', 'POST', '/pricebook', { name: 'GFCI', kind: 'material', unit_cost: 20, unit_price: 40, qty_on_hand: 10 });
  const pbGfci = r.data.id;

  r = await call('admin', 'POST', '/estimates', { customer_id: cid, location_id: lid, title: 'Panel', tax_rate: 0,
    items: [{ pricebook_id: pbPanel, description: 'Panel upgrade', qty: 1, unit_price: 3000, unit_cost: 800, taxable: 1 }] });
  const eid = r.data.id;
  const est = (await call('admin', 'GET', `/estimates/${eid}`)).data;
  assert.equal(est.total, 3000);

  // tech cannot see estimates
  assert.equal((await call('tech', 'GET', '/estimates')).status, 403);

  r = await call('admin', 'POST', `/estimates/${eid}/send`, {});
  assert.equal(r.data.status, 'not_configured'); // no SMTP in tests
  // customer views & approves via public link; cost must not leak
  const token = est.public_token;
  r = await call(null, 'GET', `/public/estimate/${token}`);
  assert.equal(r.data.doc.status, 'viewed');
  assert.equal(r.data.doc.items[0].unit_cost, undefined);
  r = await call(null, 'POST', `/public/estimate/${token}/respond`, { decision: 'approve', signature_name: 'Pat Home' });
  assert.equal(r.data.doc.status, 'approved');

  r = await call('admin', 'POST', `/estimates/${eid}/convert-to-job`, {});
  const jid = r.data.id;
  let job = (await call('admin', 'GET', `/jobs/${jid}`)).data;
  assert.equal(job.budget_hours, 8);
  assert.equal(job.contract_amount, 3000);
  await call('admin', 'PUT', `/jobs/${jid}`, { tech_ids: [techId], scheduled_start: new Date().toISOString(), scheduled_end: new Date(Date.now() + 3600e3).toISOString() });

  // tech logs material (stock decrements) and sees no costs
  r = await call('tech', 'POST', `/jobs/${jid}/materials`, { pricebook_id: pbGfci, qty: 2 });
  assert.equal(r.status, 200);
  job = (await call('tech', 'GET', `/jobs/${jid}`)).data;
  assert.equal(job.materials[0].unit_cost, undefined);
  assert.equal(job.costing, undefined);
  const gfci = (await call('admin', 'GET', '/pricebook')).data.find(p => p.id === pbGfci);
  assert.equal(gfci.qty_on_hand, 8);

  // manual 4h time entry for the tech
  const start = new Date(Date.now() - 5 * 3600e3);
  await call('admin', 'POST', '/time', { user_id: techId, job_id: jid, clock_in: start.toISOString(), clock_out: new Date(start.getTime() + 4 * 3600e3).toISOString() });
  job = (await call('admin', 'GET', `/jobs/${jid}`)).data;
  assert.equal(job.costing.hours, 4);
  assert.equal(job.costing.labor_cost, 200); // 4h * 40 * 1.25
  assert.equal(job.costing.materials_cost, 40);

  // tech can't put job into invoiced state
  assert.equal((await call('tech', 'PUT', `/jobs/${jid}`, { status: 'invoiced' })).status, 403);
  await call('tech', 'PUT', `/jobs/${jid}`, { status: 'completed', completion_notes: 'done' });

  r = await call('admin', 'POST', `/jobs/${jid}/invoice`, {});
  const iid = r.data.id;
  let inv = (await call('admin', 'GET', `/invoices/${iid}`)).data;
  assert.equal(inv.total, 3000); // from approved estimate
  assert.equal((await call('admin', 'GET', `/jobs/${jid}`)).data.status, 'invoiced');

  await call('admin', 'POST', `/invoices/${iid}/send`, {});
  await call('admin', 'POST', `/invoices/${iid}/payments`, { amount: 1000, method: 'check' });
  inv = (await call('admin', 'GET', `/invoices/${iid}`)).data;
  assert.equal(inv.status, 'partial');
  assert.equal(inv.balance, 2000);
  await call('admin', 'POST', `/invoices/${iid}/payments`, { amount: 2000, method: 'card' });
  inv = (await call('admin', 'GET', `/invoices/${iid}`)).data;
  assert.equal(inv.status, 'paid');

  await call('admin', 'POST', '/expenses', { category: 'Rent', amount: 500, date: new Date().toISOString().slice(0, 10) });
  const today = new Date().toISOString().slice(0, 10);
  const pl = (await call('admin', 'GET', `/reports/pl?from=${today.slice(0, 8)}01&to=${today}`)).data;
  assert.equal(pl.revenue, 3000);
  assert.equal(pl.cogs.direct_labor, 200);
  assert.equal(pl.cogs.materials, 40);
  assert.equal(pl.gross_profit, 2760);
  assert.equal(pl.net_profit, 2260);

  const hrs = (await call('admin', 'GET', `/reports/hours-by-job?from=${today.slice(0, 8)}01&to=${today}`)).data;
  assert.equal(hrs[0].hours, 4);
  const pay = (await call('admin', 'GET', `/reports/payroll?from=${today.slice(0, 8)}01&to=${today}`)).data;
  assert.equal(pay[0].gross_pay, 160);

  // tech cannot read financial reports
  assert.equal((await call('tech', 'GET', '/reports/pl')).status, 403);
  const dash = (await call('admin', 'GET', '/dashboard'));
  assert.equal(dash.status, 200);
});

test('clock in / switch / clock out', async () => {
  const jobs = (await call('admin', 'GET', '/jobs')).data;
  let r = await call('tech', 'POST', '/time/clock-in', { job_id: jobs[0].id });
  assert.equal(r.status, 200);
  r = await call('tech', 'GET', '/time/status');
  assert.equal(r.data.open.job_id, jobs[0].id);
  await call('tech', 'POST', '/time/clock-in', { kind: 'shop' }); // switch closes previous
  r = await call('admin', 'GET', '/time/clocked-in');
  assert.equal(r.data.length, 1);
  assert.equal(r.data[0].kind, 'shop');
  await call('tech', 'POST', '/time/clock-out', {});
  assert.equal((await call('tech', 'GET', '/time/status')).data.open, null);
  assert.equal((await call('tech', 'POST', '/time/clock-out', {})).status, 400);
});

test('payroll splits weekly overtime', () => {
  const pdb = D.open(':memory:');
  const uid = Number(D.run(pdb, "INSERT INTO users (name, email, password_hash, hourly_wage) VALUES ('A','a@a','x',20)").lastInsertRowid);
  const monday = new Date(2025, 0, 6, 7, 0, 0); // Mon Jan 6 2025
  for (let d = 0; d < 5; d++) {
    const s = new Date(monday); s.setDate(s.getDate() + d);
    D.run(pdb, 'INSERT INTO time_entries (user_id, kind, clock_in, clock_out, hourly_cost, hourly_wage) VALUES (?,?,?,?,?,?)',
      uid, 'shop', s.toISOString(), new Date(s.getTime() + 10 * 3600e3).toISOString(), 25, 20);
  }
  const [row] = C.payroll(pdb, '2025-01-06', '2025-01-12');
  assert.equal(row.regular_hours, 40);
  assert.equal(row.overtime_hours, 10);
  assert.equal(row.gross_pay, 40 * 20 + 10 * 30);
});
