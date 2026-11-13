'use strict';
// Spoken scope → estimate lines, against a stand-in for Claude (no network, no key spent).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const D = require('../server/db');
const VE = require('../server/voice_estimate');
const { createApp } = require('../server/app');

let server, base, db; const tok = {}, ids = {}; let sent = null, reply = null;
VE.setClientFactory(() => ({ beta: { messages: { stream: params => { sent = params; return { finalMessage: async () => reply }; } } } }));
const say = obj => { reply = { stop_reason: 'end_turn', model: 'claude-opus-5-5', content: [{ type: 'text', text: JSON.stringify(obj) }] }; };
async function call(who, method, p, body) {
  const res = await fetch(base + '/api' + p, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok[who] }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

before(async () => {
  db = D.open(':memory:');
  server = createApp(db).listen(0); await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  tok.admin = (await (await fetch(base + '/api/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Owner', email: 'o@x.com', password: 'longenough' }) })).json()).token;
  await call('admin', 'POST', '/users', { name: 'Tech', email: 't@x.com', password: 'password123', role: 'tech' });
  tok.tech = (await (await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 't@x.com', password: 'password123' }) })).json()).token;
  ids.gfci = (await call('admin', 'POST', '/pricebook', { code: 'GFCI20', name: 'Install 20A GFCI receptacle', kind: 'service', unit: 'ea', unit_cost: 22, unit_price: 189, taxable: 1 })).data.id;
  ids.circ = (await call('admin', 'POST', '/pricebook', { code: 'CIRC20', name: 'New 20A circuit (up to 50 ft)', kind: 'service', unit: 'ea', unit_cost: 90, unit_price: 425 })).data.id;
  ids.cust = (await call('admin', 'POST', '/customers', { name: 'Sample Homeowner' })).data.id;
});
after(() => server.close());

test('needs the Anthropic key and enough words', async () => {
  assert.match((await call('admin', 'POST', '/estimates/voice-draft', { scope: 'two gfci in the garage on a new circuit' })).data.error, /API key/);
  await call('admin', 'PUT', '/settings', { anthropic_api_key: 'sk-test-not-real' });
  assert.match((await call('admin', 'POST', '/estimates/voice-draft', { scope: 'gfci' })).data.error, /bit more/);
});

test('price book lines use the price book price; a made-up id becomes a custom line; custom lines keep Claude\'s price', async () => {
  say({ title: 'Garage GFCI circuit', summary: 'New 20A circuit with two GFCI outlets in the garage.',
    lines: [{ pricebook_id: ids.circ, description: 'circuit', qty: 1, unit_price: null, why: 'new circuit' },
      { pricebook_id: ids.gfci, description: 'gfci', qty: 2, unit_price: 5, why: 'two GFCI outlets' },
      { pricebook_id: 99999, description: 'Weatherproof in-use cover', qty: 1, unit_price: 38.5, why: 'outdoor outlet' },
      { pricebook_id: null, description: 'Patch drywall at panel', qty: 0, unit_price: 120, why: 'access' }],
    assumptions: ['Panel has room for a new breaker'], questions: ['Is the garage finished?'] });
  const r = (await call('admin', 'POST', '/estimates/voice-draft', { scope: 'add two twenty amp gee eff eye outlets in the garage on a new circuit', customer_id: ids.cust, existing: ['Service call'] })).data;
  assert.deepEqual(r.lines.map(l => [l.description, l.qty, l.unit_price, l.from_book]), [
    ['New 20A circuit (up to 50 ft)', 1, 425, true], ['Install 20A GFCI receptacle', 2, 189, true],
    ['Weatherproof in-use cover', 1, 38.5, false], ['Patch drywall at panel', 1, 120, false]]);
  assert.equal(r.title, 'Garage GFCI circuit'); assert.deepEqual(r.questions, ['Is the garage finished?']);
  // what was sent: the price book in the cached system prompt, structured output, fallback on, the scope and context
  const sys = sent.system[0].text;
  assert.match(sys, new RegExp(`${ids.gfci}\\|GFCI20\\|Install 20A GFCI receptacle\\|ea\\|189.00`)); assert.equal(sent.system[0].cache_control.type, 'ephemeral');
  assert.equal(sent.model, 'claude-opus-5-5'); assert.equal(sent.output_config.format.type, 'json_schema'); assert.equal(sent.fallbacks, 'default');
  const user = sent.messages[0].content[0].text;
  assert.match(user, /Sample Homeowner/); assert.match(user, /- Service call/); assert.match(user, /<scope>\nadd two twenty amp/);
});

test('techs: only with field estimates on, and no costs unless they may see them', async () => {
  say({ title: 'x', summary: 'x', lines: [{ pricebook_id: ids.gfci, description: 'g', qty: 1, unit_price: null, why: '' }], assumptions: [], questions: [] });
  const r = (await call('tech', 'POST', '/estimates/voice-draft', { scope: 'one gfci by the sink please' })).data;
  assert.equal(r.lines[0].unit_price, 189); assert.equal(r.lines[0].unit_cost, undefined);
  await call('admin', 'PUT', '/settings', { tech_estimates: '0' });
  assert.equal((await call('tech', 'POST', '/estimates/voice-draft', { scope: 'one gfci by the sink please' })).status, 403);
  await call('admin', 'PUT', '/settings', { tech_estimates: '1' });
});

test('a refusal or a cut-off answer says so', async () => {
  reply = { stop_reason: 'refusal', content: [] };
  assert.match((await call('admin', 'POST', '/estimates/voice-draft', { scope: 'something to price here' })).data.error, /declined/);
  reply = { stop_reason: 'max_tokens', content: [] };
  assert.match((await call('admin', 'POST', '/estimates/voice-draft', { scope: 'something to price here' })).data.error, /too long/);
});
