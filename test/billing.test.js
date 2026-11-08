'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const D = require('../server/db');
const { createApp } = require('../server/app');

let server, base, db;
const tok = {};
const ids = {};
async function call(who, method, p, body) {
  const res = await fetch(base + '/api' + p, { method, headers: { 'Content-Type': 'application/json', ...(tok[who] ? { Authorization: 'Bearer ' + tok[who] } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json() };
}
const NOW = Date.now(); // one clock for the whole file so durations are exact
const hoursAgo = h => new Date(NOW - h * 3600e3).toISOString();

before(async () => {
  db = D.open(':memory:');
  server = createApp(db).listen(0);
  await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  tok.admin = (await call(null, 'POST', '/setup', { name: 'Owner', email: 'o@x.com', password: 'longenough' })).data.token;
  ids.tech = (await call('admin', 'POST', '/users', { name: 'Mike', email: 'm@x.com', password: 'longenough', role: 'tech', hourly_wage: 40, burden_pct: 25, bill_rate: 120 })).data.id;
  tok.tech = (await call(null, 'POST', '/login', { email: 'm@x.com', password: 'longenough' })).data.token;
  ids.cust = (await call('admin', 'POST', '/customers', { name: 'GC Builders', type: 'commercial', email: 'gc@x.com', tax_exempt: 1, location: { address: '9 Site Rd' } })).data.id;
  ids.mat = (await call('admin', 'POST', '/pricebook', { name: '20A breaker', kind: 'material', unit_cost: 10, unit_price: 18, qty_on_hand: 100 })).data.id;
});
after(() => server.close());

test('quoted job: contract from quote + signed change order; progress, milestone, retainage, final', async () => {
  const est = (await call('admin', 'POST', '/estimates', { customer_id: ids.cust, title: 'Tenant improvement', tax_rate: 0, items: [{ description: 'Electrical per plans', qty: 1, unit_price: 20000, unit_cost: 9000 }] })).data.id;
  await call('admin', 'PUT', `/estimates/${est}`, { status: 'approved' });
  ids.fixed = (await call('admin', 'POST', `/estimates/${est}/convert-to-job`, {})).data.id;
  await call('admin', 'PUT', `/jobs/${ids.fixed}`, { retainage_pct: 10 });
  let b = (await call('admin', 'GET', `/jobs/${ids.fixed}/billing`)).data;
  assert.equal(b.billing_type, 'fixed');
  assert.equal(b.contract.total, 20000);

  // change order: estimate on this job is flagged automatically; only counts once the customer approves
  const co = (await call('admin', 'POST', '/estimates', { customer_id: ids.cust, job_id: ids.fixed, title: 'Add 4 circuits', tax_rate: 0, items: [{ description: 'Added circuits', qty: 4, unit_price: 500 }] })).data.id;
  b = (await call('admin', 'GET', `/jobs/${ids.fixed}/billing`)).data;
  assert.equal(b.change_orders[0].id, co);
  assert.equal(b.contract.total, 20000, 'unapproved change order does not raise the contract');
  const tokn = (await call('admin', 'GET', `/estimates/${co}`)).data.public_token;
  await call('admin', 'POST', `/estimates/${co}/send`, {});
  await fetch(`${base}/api/public/estimate/${tokn}/respond`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision: 'approve', signature_name: 'GC PM' }) });
  b = (await call('admin', 'GET', `/jobs/${ids.fixed}/billing`)).data;
  assert.equal(b.contract.total, 22000);

  // schedule of values + deposit milestone with 10% retainage
  await call('admin', 'POST', `/jobs/${ids.fixed}/milestones`, { template: 'standard' });
  b = (await call('admin', 'GET', `/jobs/${ids.fixed}/billing`)).data;
  assert.deepEqual(b.milestones.map(m => m.value), [6600, 8800, 6600]);
  let r = await call('admin', 'POST', `/jobs/${ids.fixed}/bill-fixed`, { mode: 'milestone', milestone_id: b.milestones[0].id });
  let inv = (await call('admin', 'GET', `/invoices/${r.data.id}`)).data;
  assert.equal(inv.total, 5940, '6,600 less 10% retainage');
  assert.equal(inv.retainage, 660);
  assert.equal((await call('admin', 'POST', `/jobs/${ids.fixed}/bill-fixed`, { mode: 'milestone', milestone_id: b.milestones[0].id })).status, 400, 'milestone cannot bill twice');

  // percent complete: bill up to 60% → 13,200 − 6,600 already = 6,600 more
  r = await call('admin', 'POST', `/jobs/${ids.fixed}/bill-fixed`, { mode: 'percent', pct: 60 });
  inv = (await call('admin', 'GET', `/invoices/${r.data.id}`)).data;
  assert.equal(inv.subtotal + inv.retainage, 6600);
  b = (await call('admin', 'GET', `/jobs/${ids.fixed}/billing`)).data;
  assert.equal(b.billed_to_date, 13200);
  assert.equal(b.retainage_held, 1320);
  assert.equal(b.percent_complete, 60);
  assert.equal(b.over_under, 0);
  // can't overbill the contract
  assert.equal((await call('admin', 'POST', `/jobs/${ids.fixed}/bill-fixed`, { mode: 'amount', amount: 9000 })).status, 400);

  // void a progress bill → milestone/percent amount is billable again
  await call('admin', 'PUT', `/invoices/${r.data.id}`, { status: 'void' });
  assert.equal((await call('admin', 'GET', `/jobs/${ids.fixed}/billing`)).data.billed_to_date, 6600);

  // final bills the balance and releases all retainage
  r = await call('admin', 'POST', `/jobs/${ids.fixed}/bill-fixed`, { mode: 'final' });
  inv = (await call('admin', 'GET', `/invoices/${r.data.id}`)).data;
  assert.equal(inv.total, 15400 + 660, 'remaining 15,400 + released retainage 660');
  b = (await call('admin', 'GET', `/jobs/${ids.fixed}/billing`)).data;
  assert.equal(b.remaining, 0);
  assert.equal(b.retainage_held, 0);
  // T&M billing refused on a quoted job; materials logged on it are cost only
  assert.equal((await call('admin', 'POST', `/jobs/${ids.fixed}/bill-tm`, {})).status, 400);
});

test('T&M job: rates, rounding, markup, trip charge, billed once, locked, NTE, void releases', async () => {
  ids.tm = (await call('admin', 'POST', '/jobs', { customer_id: ids.cust, title: 'Troubleshoot tripping breakers', job_type: 'service', tech_ids: [ids.tech],
    billing_type: 'tm', material_markup_pct: 50, trip_charge: 95, nte_amount: 800 })).data.id;
  // 1h 05m of time → billed 1.25 h at 120
  await call('admin', 'POST', '/time', { user_id: ids.tech, job_id: ids.tm, clock_in: hoursAgo(3), clock_out: new Date(NOW - 3 * 3600e3 + 65 * 60e3).toISOString() });
  await call('tech', 'POST', `/jobs/${ids.tm}/materials`, { pricebook_id: ids.mat, qty: 2 });
  await call('admin', 'POST', '/expenses', { date: new Date().toISOString().slice(0, 10), category: 'Equipment rental', vendor: 'Sunbelt', amount: 100, job_id: ids.tm, billable: 1 });
  let b = (await call('admin', 'GET', `/jobs/${ids.tm}/billing`)).data;
  assert.equal(b.billing_type, 'tm');
  assert.equal(b.labor[0].bill_hours, 1.25);
  assert.equal(b.unbilled.labor, 150);
  assert.equal(b.unbilled.materials, 30, '2 × cost 10 × 1.5');
  assert.equal(b.unbilled.expenses, 150, 'rental at markup');
  assert.equal(b.unbilled.trip, 95);
  assert.equal(b.unbilled.total, 425);
  assert.equal(b.nte_after, 375);

  let r = await call('admin', 'POST', `/jobs/${ids.tm}/bill-tm`, {});
  assert.equal(r.status, 200);
  const inv1 = r.data.id;
  assert.equal((await call('admin', 'GET', `/invoices/${inv1}`)).data.total, 425);
  b = (await call('admin', 'GET', `/jobs/${ids.tm}/billing`)).data;
  assert.equal(b.unbilled.total, 0, 'nothing is billed twice');
  assert.equal(b.billed_to_date, 425);
  // billed time is locked
  const te = (await call('admin', 'GET', `/time?user_id=${ids.tech}`)).data.find(t => t.job_id === ids.tm);
  r = await call('admin', 'DELETE', `/time/${te.id}`);
  assert.equal(r.status, 400);
  assert.match(r.data.error, /Already billed/);

  // more work pushes past the NTE: blocked unless confirmed
  await call('admin', 'POST', '/time', { user_id: ids.tech, job_id: ids.tm, clock_in: hoursAgo(8), clock_out: hoursAgo(4) });
  b = (await call('admin', 'GET', `/jobs/${ids.tm}/billing`)).data;
  assert.equal(b.unbilled.labor, 480, '4 h × 120');
  r = await call('admin', 'POST', `/jobs/${ids.tm}/bill-tm`, {});
  assert.equal(r.status, 400);
  assert.match(r.data.error, /not-to-exceed/);
  r = await call('admin', 'POST', `/jobs/${ids.tm}/bill-tm`, { allow_over_nte: true });
  assert.equal(r.status, 200);

  // voiding the first invoice puts its time/materials/expense/trip back in the unbilled pile
  await call('admin', 'PUT', `/invoices/${inv1}`, { status: 'void' });
  b = (await call('admin', 'GET', `/jobs/${ids.tm}/billing`)).data;
  assert.equal(b.unbilled.total, 425);
  assert.equal((await call('admin', 'DELETE', `/time/${te.id}`)).status, 200, 'unlocked once its invoice is void');
  // progress billing refused on a T&M job
  assert.equal((await call('admin', 'POST', `/jobs/${ids.tm}/bill-fixed`, { mode: 'final' })).status, 400);
});

test('WIP report shows quoted jobs (earned vs billed) and unbilled T&M', async () => {
  const w = (await call('admin', 'GET', '/reports/wip')).data;
  const tm = w.tm.find(j => j.id === ids.tm);
  assert.ok(tm.unbilled > 0);
  assert.ok(w.totals.unbilled_tm >= tm.unbilled);
  assert.equal((await call('tech', 'GET', '/reports/wip')).status, 403);
});
