'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const D = require('../server/db');
const { createApp } = require('../server/app');

let server, base, db, ply, plyBase;
const plyCalls = [];
const tokens = {};
async function call(who, method, path, body, headers = {}) {
  const res = await fetch(base + (path.startsWith('/hooks') ? '' : '/api') + path, {
    method, headers: { 'Content-Type': 'application/json', ...(tokens[who] ? { Authorization: 'Bearer ' + tokens[who] } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json() };
}
const ids = {};
const today = () => new Date().toISOString().slice(0, 10);

before(async () => {
  db = D.open(':memory:');
  server = createApp(db).listen(0);
  await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  // fake Ply API
  ply = http.createServer((req, res) => {
    let body = ''; req.on('data', c => body += c); req.on('end', () => {
      plyCalls.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: body ? JSON.parse(body) : null });
      res.setHeader('Content-Type', 'application/json');
      if (req.url.startsWith('/v1/items')) return res.end(JSON.stringify({ items: [{ id: 'itm_9', sku: 'MAT-GFCI', quantity_on_hand: 50, unit_cost: 16 }, { id: 'itm_10', sku: 'NEW-1', name: 'Wago 221 (100pk)', unit_cost: 30, quantity_on_hand: 5 }] }));
      res.end(JSON.stringify({ id: 'ply_' + plyCalls.length, status: 'submitted' }));
    });
  }).listen(0);
  await new Promise(r => ply.once('listening', r));
  plyBase = `http://127.0.0.1:${ply.address().port}/v1`;

  tokens.admin = (await call(null, 'POST', '/setup', { name: 'Owner', email: 'o@x.com', password: 'longenough' })).data.token;
  ids.tech = (await call('admin', 'POST', '/users', { name: 'Tech', email: 't@x.com', password: 'longenough', role: 'tech', hourly_wage: 40, burden_pct: 25, bill_rate: 120 })).data.id;
  ids.tech2 = (await call('admin', 'POST', '/users', { name: 'Tech2', email: 't2@x.com', password: 'longenough', role: 'tech', hourly_wage: 30, burden_pct: 25 })).data.id;
  tokens.tech = (await call(null, 'POST', '/login', { email: 't@x.com', password: 'longenough' })).data.token;
  ids.cust = (await call('admin', 'POST', '/customers', { name: 'Biz', type: 'commercial', location: { address: '1 Main' } })).data.id;
  const codes = (await call('admin', 'GET', '/cost-codes')).data;
  ids.rough = codes.find(c => c.code === '0810').id;
  ids.trim = codes.find(c => c.code === '1010').id;
  ids.gfci = (await call('admin', 'POST', '/pricebook', { code: 'MAT-GFCI', name: 'GFCI', kind: 'material', unit_cost: 20, unit_price: 40, qty_on_hand: 10, cost_code_id: ids.trim })).data.id;
  ids.rough_task = (await call('admin', 'POST', '/pricebook', { name: 'Rough-in per opening', kind: 'service', unit_cost: 10, unit_price: 90, labor_hours: 0.5, cost_code_id: ids.rough })).data.id;
  ids.vendor = (await call('admin', 'POST', '/vendors', { name: 'City Electric', terms_days: 30 })).data.id;
});
after(() => { server.close(); ply.close(); });

test('estimate → job builds cost-code budgets', async () => {
  const est = (await call('admin', 'POST', '/estimates', { customer_id: ids.cust, title: 'TI', tax_rate: 0, items: [
    { pricebook_id: ids.rough_task, description: 'Rough-in per opening', qty: 20, unit_price: 90, unit_cost: 10, taxable: 0 },
    { pricebook_id: ids.gfci, description: 'GFCI', qty: 4, unit_price: 40, unit_cost: 20, taxable: 1 }] })).data.id;
  await call('admin', 'PUT', `/estimates/${est}`, { status: 'approved' });
  ids.job = (await call('admin', 'POST', `/estimates/${est}/convert-to-job`, {})).data.id;
  const job = (await call('admin', 'GET', `/jobs/${ids.job}`)).data;
  const rough = job.budgets.find(b => b.code === '0810');
  assert.equal(rough.budget_hours, 10);
  assert.equal(rough.budget_material, 200);
  assert.equal(job.budgets.find(b => b.code === '1010').budget_material, 80);
  assert.equal(job.budget_hours, 10);
});

test('multiple appointments per job and per tech per day; conflicts reported', async () => {
  const d = today();
  const at = h => new Date(`${d}T${String(h).padStart(2, '0')}:00:00`).toISOString();
  const a1 = await call('admin', 'POST', '/appointments', { job_id: ids.job, start: at(8), end: at(12), tech_ids: [ids.tech, ids.tech2] });
  const a2 = await call('admin', 'POST', '/appointments', { job_id: ids.job, start: at(13), end: at(16), tech_ids: [ids.tech] });
  assert.equal(a2.data.conflicts.length, 0);
  const a3 = await call('admin', 'POST', '/appointments', { job_id: ids.job, start: at(15), end: at(17), tech_ids: [ids.tech] });
  assert.equal(a3.data.conflicts.length, 1); // overlaps 13–16 for the same tech
  ids.appt = a1.data.id;
  const job = (await call('admin', 'GET', `/jobs/${ids.job}`)).data;
  assert.equal(job.appointments.length, 3);
  assert.equal(job.status, 'scheduled');
  assert.equal(new Date(job.scheduled_start).getHours(), 8);
  assert.deepEqual(job.tech_ids.sort(), [ids.tech, ids.tech2].sort());
  // tech sees only their appointments
  const mine = (await call('tech', 'GET', `/appointments?from=${at(0)}&to=${at(23)}`)).data;
  assert.equal(mine.length, 3);
  // drag to another time
  await call('admin', 'PUT', `/appointments/${a3.data.id}`, { start: at(16), end: at(18) });
  const disp = (await call('admin', 'GET', `/dispatch?date=${d}`)).data;
  assert.equal(disp.techs.find(t => t.id === ids.tech).booked_hours, 9);
});

test('tech status on site clocks in with appointment; cost-coded time costs to the code', async () => {
  let r = await call('tech', 'PUT', `/appointments/${ids.appt}`, { status: 'on_site' });
  assert.equal(r.status, 200);
  const st = (await call('tech', 'GET', '/time/status')).data.open;
  assert.equal(st.job_id, ids.job);
  await call('tech', 'PUT', `/appointments/${ids.appt}`, { status: 'done' });
  assert.equal((await call('tech', 'GET', '/time/status')).data.open, null);
  // manual coded time
  const s = new Date(Date.now() - 6 * 3600e3);
  await call('admin', 'POST', '/time', { user_id: ids.tech, job_id: ids.job, cost_code_id: ids.rough, clock_in: s.toISOString(), clock_out: new Date(s.getTime() + 4 * 3600e3).toISOString() });
  const job = (await call('admin', 'GET', `/jobs/${ids.job}`)).data;
  const rough = job.cost_codes.find(c => c.code === '0810');
  assert.equal(rough.hours, 4);
  assert.equal(rough.labor_cost, 200);
  assert.equal(rough.hours_variance, 6);
});

test('pick list pulls stock to the job and posts inventory → job materials', async () => {
  const pl = (await call('admin', 'POST', `/jobs/${ids.job}/pick-lists`, { from_estimate: true })).data.id;
  let p = (await call('tech', 'GET', `/pick-lists/${pl}`)).data;
  assert.equal(p.lines.length, 1);
  await call('tech', 'PUT', `/pick-lists/${pl}`, { lines: [{ id: p.lines[0].id, qty_picked: 4 }] });
  await call('tech', 'POST', `/pick-lists/${pl}/complete`, {});
  const pb = (await call('admin', 'GET', '/pricebook')).data.find(x => x.id === ids.gfci);
  assert.equal(pb.qty_on_hand, 6);
  const job = (await call('admin', 'GET', `/jobs/${ids.job}`)).data;
  assert.equal(job.cost_codes.find(c => c.code === '1010').material_cost, 80);
  const tb = (await call('admin', 'GET', '/accounting/trial-balance')).data;
  assert.equal(tb.rows.find(r => r.number === '5100').debit, 80);
  assert.equal(tb.rows.find(r => r.number === '1300').credit, 80);
});

test('PO to job: receive → job materials; bill → AP & job materials; pay bill', async () => {
  const po = (await call('admin', 'POST', '/purchase-orders', { vendor_id: ids.vendor, job_id: ids.job, lines: [
    { description: '3/4 EMT', qty: 50, unit_cost: 9, cost_code_id: ids.rough }, { pricebook_id: ids.gfci, description: 'GFCI', qty: 10, unit_cost: 18, cost_code_id: ids.trim }] })).data.id;
  await call('admin', 'POST', `/purchase-orders/${po}/submit`, {});
  const p0 = (await call('admin', 'GET', `/purchase-orders/${po}`)).data;
  await call('admin', 'POST', `/purchase-orders/${po}/receive`, { lines: [{ po_line_id: p0.lines[0].id, qty: 50 }] });
  assert.equal((await call('admin', 'GET', `/purchase-orders/${po}`)).data.status, 'partial');
  const over = await call('admin', 'POST', `/purchase-orders/${po}/receive`, { lines: [{ po_line_id: p0.lines[1].id, qty: 11 }] });
  assert.equal(over.status, 400);
  await call('admin', 'POST', `/purchase-orders/${po}/receive`, { all: true });
  assert.equal((await call('admin', 'GET', `/purchase-orders/${po}`)).data.status, 'received');
  // stock untouched for job delivery
  assert.equal((await call('admin', 'GET', '/pricebook')).data.find(x => x.id === ids.gfci).qty_on_hand, 6);
  let job = (await call('admin', 'GET', `/jobs/${ids.job}`)).data;
  assert.equal(job.cost_codes.find(c => c.code === '0810').material_cost, 450);
  const before = job.costing.total_cost;
  const bill = (await call('admin', 'POST', `/purchase-orders/${po}/bill`, { vendor_invoice: 'S100-1', total: 640 })).data.id;
  const b = (await call('admin', 'GET', `/bills/${bill}`)).data;
  assert.equal(b.total, 640); // includes $10 price variance line
  job = (await call('admin', 'GET', `/jobs/${ids.job}`)).data;
  assert.equal(job.costing.total_cost, before); // bill does not double count PO materials in job costing
  await call('admin', 'POST', `/bills/${bill}/payments`, { amount: 640 });
  assert.equal((await call('admin', 'GET', `/bills/${bill}`)).data.status, 'paid');
  const ap = (await call('admin', 'GET', '/accounting/ap-aging')).data;
  assert.equal(ap.total, 0);
});

test('shop PO updates stock with weighted-average cost; reorder creates PO', async () => {
  await call('admin', 'PUT', `/pricebook/${ids.gfci}`, { reorder_point: 8, vendor_id: ids.vendor });
  const r = (await call('admin', 'POST', '/purchase-orders/reorder', {})).data;
  assert.equal(r.created.length, 1);
  const po = (await call('admin', 'GET', `/purchase-orders/${r.created[0]}`)).data;
  assert.equal(po.lines[0].qty, 10); // back up to 2× reorder point (16) from 6
  await call('admin', 'PUT', `/purchase-orders/${po.id}`, { lines: [{ ...po.lines[0], unit_cost: 23 }] });
  await call('admin', 'POST', `/purchase-orders/${po.id}/receive`, { all: true });
  const pb = (await call('admin', 'GET', '/pricebook')).data.find(x => x.id === ids.gfci);
  assert.equal(pb.qty_on_hand, 16);
  assert.equal(pb.unit_cost, 21.88); // (6×20 + 10×23) / 16
});

test('ledger stays balanced; invoice/payment/expense post; closed period blocks changes', async () => {
  const inv = (await call('admin', 'POST', `/jobs/${ids.job}/invoice`, {})).data.id;
  await call('admin', 'POST', `/invoices/${inv}/send`, {});
  const i = (await call('admin', 'GET', `/invoices/${inv}`)).data;
  await call('admin', 'POST', `/invoices/${inv}/payments`, { amount: 500 });
  await call('admin', 'POST', '/expenses', { category: 'Rent', amount: 1000, date: today() });
  const tb = (await call('admin', 'GET', '/accounting/trial-balance')).data;
  assert.equal(tb.total_debit, tb.total_credit);
  assert.equal(tb.rows.find(r => r.number === '4100').credit, i.subtotal - i.discount); // commercial revenue
  assert.equal(tb.rows.find(r => r.number === '1200').debit, i.total - 500);
  const bs = (await call('admin', 'GET', '/accounting/balance-sheet')).data;
  assert.ok(bs.balanced, 'balance sheet balances');
  // labor accrual
  const lab = (await call('admin', 'POST', '/accounting/labor', { weeks: [today()] })).data;
  assert.ok(lab[0].total > 0);
  const status = (await call('admin', 'GET', `/accounting/labor?from=${today()}&to=${today()}`)).data;
  assert.equal(status[0].in_sync, true);
  // close books and try to post into the closed period
  await call('admin', 'POST', '/accounting/close', { through: today() });
  const blocked = await call('admin', 'POST', '/expenses', { category: 'Rent', amount: 5, date: today() });
  assert.equal(blocked.status, 400);
  assert.match(blocked.data.error, /closed/);
  const n = (await call('admin', 'GET', '/expenses')).data.filter(e => e.amount === 5).length;
  assert.equal(n, 0, 'expense rolled back with the failed posting');
  await call('admin', 'POST', '/accounting/close', { through: '' });
  // techs and office can't see the ledger
  assert.equal((await call('tech', 'GET', '/accounting/trial-balance')).status, 403);
});

test('Ply: push PO to API, pull items, and accept signed webhooks', async () => {
  await call('admin', 'PUT', '/settings', { ply_enabled: '1', ply_api_base: plyBase, ply_api_key: 'sk_test', ply_webhook_secret: 'whsec' });
  const me = (await call('admin', 'GET', '/me')).data.settings;
  assert.equal(me.ply_api_key, ''); // never sent back
  assert.equal(me.ply_api_key_set, '1');
  const po = (await call('admin', 'POST', '/purchase-orders', { vendor_id: ids.vendor, job_id: ids.job, lines: [{ pricebook_id: ids.gfci, description: 'GFCI', qty: 5, unit_cost: 20, cost_code_id: ids.trim }] })).data.id;
  const r = await call('admin', 'POST', `/purchase-orders/${po}/submit`, { send_to_ply: true });
  assert.equal(r.status, 200);
  const sent = plyCalls.find(c => c.url === '/v1/purchase-orders');
  assert.equal(sent.auth, 'Bearer sk_test');
  assert.equal(sent.body.lines[0].cost_code, '1010-M'); // A4YE Full Code for material
  assert.equal(sent.body.job.external_id, (await call('admin', 'GET', `/jobs/${ids.job}`)).data.number);
  const P = (await call('admin', 'GET', `/purchase-orders/${po}`)).data;
  assert.ok(P.ply_id);

  const pulled = (await call('admin', 'POST', '/integrations/ply/pull-items', {})).data;
  assert.deepEqual(pulled, { updated: 1, created: 1 });

  // unsigned webhook rejected
  assert.equal((await call(null, 'POST', '/hooks/ply', { type: 'purchase_order.received' })).status, 401);
  const evt = { type: 'purchase_order.received', data: { external_id: P.number, lines: [{ external_line_id: String(P.lines[0].id), quantity_received: 5 }] } };
  const sig = crypto.createHmac('sha256', 'whsec').update(JSON.stringify(evt)).digest('hex');
  const w = await call(null, 'POST', '/hooks/ply', evt, { 'X-Ply-Signature': sig });
  assert.equal(w.status, 200);
  assert.equal((await call('admin', 'GET', `/purchase-orders/${po}`)).data.status, 'received');
  const bevt = { type: 'bill.created', data: { id: 'inv_1', purchase_order_external_id: P.number, invoice_number: 'CE-77', total: 100, date: today() } };
  const w2 = await call(null, 'POST', '/hooks/ply', bevt, { 'X-Ply-Signature': crypto.createHmac('sha256', 'whsec').update(JSON.stringify(bevt)).digest('hex') });
  assert.equal(w2.status, 200);
  const bills = (await call('admin', 'GET', '/bills')).data.filter(b => b.vendor_invoice === 'CE-77');
  assert.equal(bills.length, 1);
  assert.equal(bills[0].total, 100);
});
