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
  ids.cust = (await call('admin', 'POST', '/customers', { name: 'Pat', email: 'p@x.com', location: { address: '1 Elm' } })).data.id;
  ids.ev = (await call('admin', 'POST', '/pricebook', { name: 'EV circuit 40A', kind: 'service', unit_cost: 200, unit_price: 900, labor_hours: 3 })).data.id;
  ids.wire = (await call('admin', 'POST', '/pricebook', { name: '6/3 NM wire (ft)', kind: 'material', unit_cost: 3, unit_price: 6, qty_on_hand: 500 })).data.id;
});
after(() => server.close());

const items = [
  { description: 'Permit & inspection', qty: 1, unit_price: 150, unit_cost: 150, taxable: 0 },                                         // every option
  { description: 'Basic 40A charger circuit', qty: 1, unit_price: 900, unit_cost: 200, option_index: 0, pricebook_id: null },
  { description: '60A circuit + hardwired charger', qty: 1, unit_price: 1400, unit_cost: 450, option_index: 1 },
  { description: '6/3 NM wire (ft)', qty: 40, unit_price: 6, unit_cost: 3, option_index: 1, taxable: 1 },
  { description: '60A circuit + charger + load management', qty: 1, unit_price: 2300, unit_cost: 800, option_index: 2 },
  { description: 'Whole-home surge protector', qty: 1, unit_price: 425, unit_cost: 95, option_index: 2, taxable: 1 },
];
const options = [{ name: 'Good', description: 'Gets you charging' }, { name: 'Better', recommended: true, description: 'Faster charging, ready for the next car' }, { name: 'Best', description: 'Fastest charging, no panel upgrade needed' }];

test('options price independently; common lines in every option; recommended drives the list total', async () => {
  ids.est = (await call('admin', 'POST', '/estimates', { customer_id: ids.cust, title: 'EV charger', tax_rate: 10, options, items })).data.id;
  const e = (await call('admin', 'GET', `/estimates/${ids.est}`)).data;
  assert.deepEqual(e.options.map(o => o.name), ['Good', 'Better', 'Best']);
  assert.deepEqual(e.options.map(o => o.subtotal), [1050, 1790, 2875]);
  assert.equal(e.options[1].tax, 24, 'tax only on that option’s taxable lines (240 × 10%)');
  assert.equal(e.options[2].tax, 42.5);
  assert.equal(e.chosen_option_id, e.options[1].id, 'recommended option is the default');
  assert.equal(e.total, 1814);
  assert.deepEqual([e.price_min, e.price_max], [1050, 2917.5]);
  assert.ok(e.options.every(o => o.est_margin_pct > 0));
  // a single option isn't a choice
  assert.equal((await call('admin', 'POST', '/estimates', { customer_id: ids.cust, options: [{ name: 'Only' }], items })).status, 400);
});

test('customer must pick an option to approve; their pick sets the job price, budget and invoice', async () => {
  const e = (await call('admin', 'GET', `/estimates/${ids.est}`)).data;
  await call('admin', 'POST', `/estimates/${ids.est}/send`, {});
  const pub = (await call(null, 'GET', `/public/estimate/${e.public_token}`)).data;
  assert.equal(pub.doc.options.length, 3);
  assert.equal(pub.doc.options[0].est_cost, undefined, 'no costs on the customer page');
  assert.ok(pub.doc.items.every(i => i.unit_cost === undefined));
  let r = await call(null, 'POST', `/public/estimate/${e.public_token}/respond`, { decision: 'approve', signature_name: 'Pat' });
  assert.equal(r.status, 400, 'option required');
  const best = e.options[2].id;
  r = await call(null, 'POST', `/public/estimate/${e.public_token}/respond`, { decision: 'approve', signature_name: 'Pat', option_id: best });
  assert.equal(r.status, 200);
  assert.equal(r.data.doc.approved_option_id, best);
  assert.equal(r.data.doc.total, 2917.5);

  const job = (await call('admin', 'POST', `/estimates/${ids.est}/convert-to-job`, {})).data.id;
  const j = (await call('admin', 'GET', `/jobs/${job}`)).data;
  assert.equal(j.contract_amount, 2875, 'contract = Best (net, before tax)');
  const inv = (await call('admin', 'POST', `/jobs/${job}/invoice`, {})).data.id;
  const i = (await call('admin', 'GET', `/invoices/${inv}`)).data;
  assert.deepEqual(i.items.map(x => x.description).sort(), ['60A circuit + charger + load management', 'Permit & inspection', 'Whole-home surge protector'].sort());
  assert.equal(i.total, 2917.5);
  // approved estimates with options can't be edited
  assert.equal((await call('admin', 'PUT', `/estimates/${ids.est}`, { options, items })).status, 400);
});

test('office approval must record the chosen option; removing options returns to a single price', async () => {
  const id = (await call('admin', 'POST', '/estimates', { customer_id: ids.cust, title: 'EV 2', tax_rate: 0, options, items })).data.id;
  assert.equal((await call('admin', 'PUT', `/estimates/${id}`, { status: 'approved' })).status, 400);
  const e = (await call('admin', 'GET', `/estimates/${id}`)).data;
  assert.equal((await call('admin', 'PUT', `/estimates/${id}`, { status: 'approved', approved_option_id: e.options[0].id })).status, 200);
  assert.equal((await call('admin', 'GET', `/estimates/${id}`)).data.total, 1050);
  // a different estimate: drop options → every line counts again
  const id2 = (await call('admin', 'POST', '/estimates', { customer_id: ids.cust, title: 'EV 3', tax_rate: 0, options, items })).data.id;
  await call('admin', 'PUT', `/estimates/${id2}`, { options: [], items: items.slice(0, 2) });
  const e2 = (await call('admin', 'GET', `/estimates/${id2}`)).data;
  assert.equal(e2.options.length, 0);
  assert.equal(e2.total, 1050);
  // saving lines without option info keeps their options
  const id3 = (await call('admin', 'POST', '/estimates', { customer_id: ids.cust, title: 'EV 4', tax_rate: 0, options, items })).data.id;
  const e3 = (await call('admin', 'GET', `/estimates/${id3}`)).data;
  await call('admin', 'PUT', `/estimates/${id3}`, { items: e3.items });
  assert.deepEqual((await call('admin', 'GET', `/estimates/${id3}`)).data.options.map(o => o.subtotal), [1050, 1790, 2875]);
});
