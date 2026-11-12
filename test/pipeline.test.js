'use strict';
// Sales pipeline: each customer / estimate / job / invoice shows once, at its furthest stage; next steps, owners, lost.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const D = require('../server/db');
const { createApp } = require('../server/app');

let server, base, db; const tok = {}, ids = {};
async function call(who, method, p, body) {
  const res = await fetch(base + '/api' + p, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok[who] }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}
const est = (customer_id, price, extra = {}) => call('admin', 'POST', '/estimates', { customer_id, title: 'Work', tax_rate: 0, items: [{ description: 'Labor and material', qty: 1, unit_price: price }], ...extra });
const stageOf = (d, kind, id) => (d.cards.find(c => c.kind === kind && c.id === id) || {}).stage;
const day = n => { const x = new Date(); x.setDate(x.getDate() + n); return x.toISOString().slice(0, 10); };

before(async () => {
  db = D.open(':memory:');
  server = createApp(db).listen(0); await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  tok.admin = (await (await fetch(base + '/api/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Owner', email: 'o@x.com', password: 'longenough' }) })).json()).token;
  ids.sales = (await call('admin', 'POST', '/users', { name: 'Sales Person', email: 's@x.com', password: 'password123', role: 'office' })).data.id;
  await call('admin', 'POST', '/users', { name: 'Tech', email: 't@x.com', password: 'password123', role: 'tech' });
  tok.tech = (await (await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 't@x.com', password: 'password123' }) })).json()).token;
  ids.lead = (await call('admin', 'POST', '/customers', { name: 'Lead Person', phone: '555-0101', lead_status: 'new', est_value: 4000, owner_id: ids.sales })).data.id;
  ids.c1 = (await call('admin', 'POST', '/customers', { name: 'Draft Customer' })).data.id;
  ids.c2 = (await call('admin', 'POST', '/customers', { name: 'Proposal Customer', email: 'p@example.com' })).data.id;
  ids.c3 = (await call('admin', 'POST', '/customers', { name: 'Won Customer', email: 'w@example.com' })).data.id;
  ids.e1 = (await est(ids.c1, 1000)).data.id;
  ids.e2 = (await est(ids.c2, 2000)).data.id;
  await call('admin', 'POST', `/estimates/${ids.e2}/send`, {});
  ids.e3 = (await est(ids.c3, 3000)).data.id;
  await call('admin', 'PUT', `/estimates/${ids.e3}`, { status: 'approved' });
});
after(() => server.close());

test('each record shows once, at its stage, with weighted open pipeline', async () => {
  const d = (await call('admin', 'GET', '/pipeline')).data;
  assert.equal(stageOf(d, 'lead', ids.lead), 'lead');
  assert.equal(stageOf(d, 'estimate', ids.e1), 'estimating');
  assert.equal(stageOf(d, 'estimate', ids.e2), 'proposal');
  assert.equal(stageOf(d, 'estimate', ids.e3), 'won');
  assert.equal(d.cards.filter(c => c.kind === 'lead' && [ids.c1, ids.c2, ids.c3].includes(c.id)).length, 0, 'a customer with an estimate is the estimate, not also a lead');
  const s = Object.fromEntries(d.stages.map(x => [x.key, x]));
  assert.equal(s.lead.amount, 4000); assert.equal(s.estimating.amount, 1000); assert.equal(s.proposal.amount, 2000);
  assert.equal(d.totals.open, 7000); assert.equal(d.totals.weighted, 4000 * 0.1 + 1000 * 0.25 + 2000 * 0.5);
  assert.equal(d.totals.booked, 3000);
  assert.equal(d.cards.find(c => c.kind === 'lead').owner_name, 'Sales Person');
  assert.equal((await call('tech', 'GET', '/pipeline')).status, 403);
});

test('won → job → completed → invoiced → paid moves one card along', async () => {
  const job = (await call('admin', 'POST', '/jobs', { customer_id: ids.c3, title: 'Work', contract_amount: 3000 })).data.id;
  await call('admin', 'PUT', `/estimates/${ids.e3}`, { job_id: job });
  let d = (await call('admin', 'GET', '/pipeline')).data;
  assert.equal(stageOf(d, 'job', job), 'won', 'unscheduled job'); assert.equal(stageOf(d, 'estimate', ids.e3), undefined, 'the estimate became the job');
  await call('admin', 'PUT', `/jobs/${job}`, { scheduled_start: new Date(Date.now() + 864e5).toISOString(), scheduled_end: new Date(Date.now() + 9e7).toISOString() });
  d = (await call('admin', 'GET', '/pipeline')).data; assert.equal(stageOf(d, 'job', job), 'in_progress');
  await call('admin', 'PUT', `/jobs/${job}`, { status: 'completed' });
  d = (await call('admin', 'GET', '/pipeline')).data; assert.equal(stageOf(d, 'job', job), 'to_invoice');
  assert.equal(d.cards.find(c => c.kind === 'job' && c.id === job).amount, 3000);
  const inv = (await call('admin', 'POST', '/invoices', { customer_id: ids.c3, job_id: job, tax_rate: 0, items: [{ description: 'Work', qty: 1, unit_price: 3000 }] })).data.id;
  await call('admin', 'POST', `/invoices/${inv}/send`, {});
  d = (await call('admin', 'GET', '/pipeline')).data;
  assert.equal(stageOf(d, 'invoice', inv), 'invoiced'); assert.equal(stageOf(d, 'job', job), undefined);
  assert.equal(d.totals.billed, 3000);
  await call('admin', 'POST', `/invoices/${inv}/payments`, { amount: 3000, method: 'check', paid_at: day(0) });
  d = (await call('admin', 'GET', '/pipeline')).data; assert.equal(stageOf(d, 'invoice', inv), 'paid');
  // the path bar on the estimate follows it to the invoice
  const p = (await call('admin', 'GET', `/pipeline/path?kind=estimate&id=${ids.e3}`)).data;
  assert.equal(p.card.stage, 'paid');
});

test('next step, owner and close date; overdue next steps are counted', async () => {
  assert.equal((await call('admin', 'PUT', `/pipeline/estimate/${ids.e2}`, { next_step: 'Call about the options', next_step_date: day(-1), owner_id: ids.sales, close_date: day(14) })).status, 200);
  const d = (await call('admin', 'GET', '/pipeline')).data;
  const c = d.cards.find(x => x.kind === 'estimate' && x.id === ids.e2);
  assert.equal(c.next_step, 'Call about the options'); assert.equal(c.overdue, true); assert.equal(c.owner_name, 'Sales Person'); assert.equal(c.close_date, day(14));
  assert.ok(d.totals.overdue_steps >= 1);
  assert.equal((await call('admin', 'GET', `/pipeline?owner_id=${ids.sales}`)).data.cards.every(x => x.owner_id === ids.sales), true);
  assert.match((await call('admin', 'PUT', `/pipeline/invoice/1`, { next_step: 'x' })).data.error, /lead, estimate or job/);
});

test('lost: a declined estimate with a reason, an unqualified lead; hidden unless asked', async () => {
  assert.match((await call('admin', 'PUT', `/pipeline/lead/${ids.lead}`, { lead_status: 'unqualified' })).data.error, /why/);
  await call('admin', 'PUT', `/pipeline/lead/${ids.lead}`, { lead_status: 'unqualified', lost_reason: 'Outside our area' });
  await call('admin', 'PUT', `/estimates/${ids.e1}`, { status: 'declined' });
  await call('admin', 'PUT', `/pipeline/estimate/${ids.e1}`, { lost_reason: 'Price too high' });
  let d = (await call('admin', 'GET', '/pipeline')).data;
  assert.equal(stageOf(d, 'lead', ids.lead), undefined); assert.equal(stageOf(d, 'estimate', ids.e1), undefined);
  d = (await call('admin', 'GET', '/pipeline?lost=1')).data;
  assert.equal(stageOf(d, 'lead', ids.lead), 'lost'); assert.equal(stageOf(d, 'estimate', ids.e1), 'lost');
  assert.equal(d.cards.find(c => c.kind === 'estimate' && c.id === ids.e1).lost_reason, 'Price too high');
  assert.ok(d.totals.win_rate >= 0);
});
