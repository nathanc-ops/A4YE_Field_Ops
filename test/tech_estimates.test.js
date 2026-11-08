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

before(async () => {
  db = D.open(':memory:');
  server = createApp(db).listen(0);
  await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  tok.admin = (await call(null, 'POST', '/setup', { name: 'Owner', email: 'o@x.com', password: 'longenough' })).data.token;
  ids.tech = (await call('admin', 'POST', '/users', { name: 'Mike', email: 'm@x.com', password: 'longenough', role: 'tech', hourly_wage: 40 })).data.id;
  ids.other = (await call('admin', 'POST', '/users', { name: 'Dana', email: 'd@x.com', password: 'longenough', role: 'tech' })).data.id;
  tok.tech = (await call(null, 'POST', '/login', { email: 'm@x.com', password: 'longenough' })).data.token;
  tok.other = (await call(null, 'POST', '/login', { email: 'd@x.com', password: 'longenough' })).data.token;
  await call('admin', 'PUT', '/settings', { default_tax_rate: '0' });
  ids.cust = (await call('admin', 'POST', '/customers', { name: 'Pat', email: 'p@x.com', location: { address: '1 Elm' } })).data.id;
  ids.job = (await call('admin', 'POST', '/jobs', { customer_id: ids.cust, title: 'Service call', job_type: 'service', tech_ids: [ids.tech] })).data.id;
  ids.panel = (await call('admin', 'POST', '/pricebook', { name: '200A panel upgrade', kind: 'service', unit_cost: 1000, unit_price: 3400 })).data.id;
  ids.surge = (await call('admin', 'POST', '/pricebook', { name: 'Whole-home surge', kind: 'service', unit_cost: 95, unit_price: 425 })).data.id;
  ids.thin = (await call('admin', 'POST', '/pricebook', { name: 'Low-margin item', kind: 'material', unit_cost: 90, unit_price: 100 })).data.id;
});
after(() => server.close());

test('tech builds an estimate on their job at price-book prices; costs hidden; closes on site', async () => {
  // tries to sneak a lower price and cost — server reprices from the price book
  let r = await call('tech', 'POST', '/estimates', { job_id: ids.job, title: 'Panel upgrade', items: [{ pricebook_id: ids.panel, description: '200A panel upgrade', qty: 1, unit_price: 1, unit_cost: 9999 }] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.review, []);
  ids.est = r.data.id;
  const e = (await call('tech', 'GET', `/estimates/${ids.est}`)).data;
  assert.equal(e.total, 3400, 'price-book price enforced');
  assert.equal(e.items[0].unit_cost, undefined, 'tech cannot see cost');
  assert.equal(e.est_margin_pct, undefined);
  assert.equal(e.guard.checks[0].margin_ok, true);
  assert.equal(e.guard.checks[0].margin, undefined, 'margin number hidden too');
  assert.equal(e.customer_id, ids.cust, 'customer comes from the job');
  // other tech / unassigned job
  assert.equal((await call('other', 'GET', `/estimates/${ids.est}`)).status, 403);
  const otherJob = (await call('admin', 'POST', '/jobs', { customer_id: ids.cust, title: 'Not mine', tech_ids: [ids.other] })).data.id;
  assert.equal((await call('tech', 'POST', '/estimates', { job_id: otherJob, items: [] })).status, 403);
  // tech can't approve for the customer, but can present and the customer signs
  assert.equal((await call('tech', 'PUT', `/estimates/${ids.est}`, { status: 'approved' })).status, 403);
  r = await call('tech', 'POST', `/estimates/${ids.est}/present`, {});
  const token = r.data.url.split('/').pop();
  const signed = await fetch(`${base}/api/public/estimate/${token}/respond`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision: 'approve', signature_name: 'Pat' }) });
  assert.equal(signed.status, 200);
  assert.equal((await call('admin', 'GET', `/estimates/${ids.est}`)).data.status, 'approved');
  assert.equal((await call('tech', 'PUT', `/estimates/${ids.est}`, { title: 'x' })).status, 400, 'locked after approval');
});

test('guardrails: big discount, thin margin and custom lines go to office review and block signing', async () => {
  let r = await call('tech', 'POST', '/estimates', { job_id: ids.job, title: 'Discounted', discount: 600, items: [{ pricebook_id: ids.panel, description: 'Panel', qty: 1 }] });
  assert.match(r.data.review.join(), /discount 17.65% is over the 10% limit/);
  const disc = r.data.id;
  r = await call('tech', 'POST', '/estimates', { job_id: ids.job, title: 'Thin', items: [{ pricebook_id: ids.thin, description: 'Low-margin item', qty: 1 }] });
  assert.match(r.data.review.join(), /margin is below the 35% minimum/);
  r = await call('tech', 'POST', '/estimates', { job_id: ids.job, title: 'Custom', items: [{ description: 'Chase wire through plaster wall', qty: 1, unit_price: 400 }] });
  assert.match(r.data.review.join(), /custom line/);
  const custom = r.data.id;
  // customer can view but not sign; tech can't present
  assert.equal((await call('tech', 'POST', `/estimates/${custom}/present`, {})).status, 400);
  const e = (await call('admin', 'GET', `/estimates/${custom}`)).data;
  await call('admin', 'PUT', `/estimates/${custom}`, { status: 'sent' });
  const pub = (await call(null, 'GET', `/public/estimate/${e.public_token}`)).data;
  assert.equal(pub.doc.pending_review, true);
  const blocked = await fetch(`${base}/api/public/estimate/${e.public_token}/respond`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision: 'approve', signature_name: 'Pat' }) });
  assert.equal(blocked.status, 400);
  // office queue, send back with a note, tech fixes it, office approves
  const queue = (await call('admin', 'GET', '/estimates-review')).data;
  assert.equal(queue.length, 3);
  assert.equal((await call('admin', 'POST', `/estimates/${disc}/review`, { decision: 'reject' })).status, 400, 'needs a note');
  await call('admin', 'POST', `/estimates/${disc}/review`, { decision: 'reject', note: 'Max 10% — offer surge protector instead' });
  assert.equal((await call('tech', 'GET', `/estimates/${disc}`)).data.review_note, 'Max 10% — offer surge protector instead');
  r = await call('tech', 'PUT', `/estimates/${disc}`, { discount: 300, items: [{ pricebook_id: ids.panel, description: 'Panel', qty: 1 }] });
  assert.deepEqual(r.data.review, [], 'within limits now');
  await call('admin', 'POST', `/estimates/${custom}/review`, { decision: 'approve' });
  assert.equal((await call('tech', 'POST', `/estimates/${custom}/present`, {})).status, 200);
  const ok = await fetch(`${base}/api/public/estimate/${e.public_token}/respond`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision: 'approve', signature_name: 'Pat' }) });
  assert.equal(ok.status, 200);
  // job notes record the review trail
  const notes = (await call('admin', 'GET', `/jobs/${ids.job}`)).data.notes.map(n => n.body).join('\n');
  assert.match(notes, /needs office review/);
  assert.match(notes, /Office sent .* back/);
});

test('settings: block custom lines, let techs see costs, options checked per option', async () => {
  await call('admin', 'PUT', '/settings', { tech_custom_lines: 'block', tech_see_costs: '1' });
  assert.equal((await call('tech', 'POST', '/estimates', { job_id: ids.job, items: [{ description: 'Anything', qty: 1, unit_price: 50 }] })).status, 400);
  const r = await call('tech', 'POST', '/estimates', { job_id: ids.job, title: 'Options', options: [{ name: 'Good' }, { name: 'Best', recommended: true }],
    items: [{ pricebook_id: ids.thin, description: 'Low-margin item', qty: 1, option_index: 0 }, { pricebook_id: ids.panel, description: 'Panel', qty: 1, option_index: 1 }] });
  assert.match(r.data.review.join(), /“Good” margin is below/);
  const e = (await call('tech', 'GET', `/estimates/${r.data.id}`)).data;
  assert.equal(e.items[0].unit_cost, 90, 'costs visible when allowed');
  assert.deepEqual(e.guard.checks.map(c => c.margin_ok), [false, true]);
  assert.equal(e.guard.checks[1].margin, 70.59);
  // turning field estimating off
  await call('admin', 'PUT', '/settings', { tech_estimates: '0' });
  assert.equal((await call('tech', 'POST', '/estimates', { job_id: ids.job, items: [] })).status, 403);
  await call('admin', 'PUT', '/settings', { tech_estimates: '1', tech_custom_lines: 'review', tech_see_costs: '0' });
});
