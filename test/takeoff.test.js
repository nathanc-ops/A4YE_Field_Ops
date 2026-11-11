'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fo-to-'));
const D = require('../server/db');
const Takeoff = require('../server/takeoff');
const { createApp } = require('../server/app');

// The Claude API is replaced by a fake that records each request and returns a made-up takeoff.
const calls = [];
let reply = null;
Takeoff.setClientFactory(apiKey => ({ beta: { messages: { stream: params => { calls.push({ apiKey, params }); return { finalMessage: async () => reply(params) }; } } } }));
const takeoffJson = {
  project_name: 'Test Office TI', scope_summary: 'Lighting and power for a small office suite', sheets_reviewed: ['E1.1 Lighting', 'E2.1 Power'],
  lines: [
    { phase_code: '0810', phase: 'Level 1', tag: 'A', description: '2x4 LED troffer', qty: 20, unit: 'EA', pricebook_code: 'LT-24', neca_hours: 0, material_unit: 0, source: 'E1.1', confidence: 'high', notes: '' },
    { phase_code: '0820', phase: 'Level 1', tag: '', description: 'Duplex receptacle', qty: 10, unit: 'EA', pricebook_code: '', neca_hours: 0.5, material_unit: 12, source: 'E2.1', confidence: 'medium', notes: '' },
    { phase_code: '9999', phase: 'Site', tag: '', description: 'Feeder to RTU', qty: 120, unit: 'LF', pricebook_code: '', neca_hours: 0, material_unit: 0, source: 'E2.1 scaled', confidence: 'low', notes: 'length scaled' },
  ],
  assumptions: ['Ceiling grid by others'], exclusions: ['Fire alarm'], questions: ['Is the RTU disconnect by mechanical?'],
};
const okReply = () => ({ model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(takeoffJson) }], usage: { input_tokens: 41000, output_tokens: 3200 } });

let server, base, db; const tok = {};
async function call(who, method, p, body) {
  const res = await fetch(base + '/api' + p, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok[who] }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json() };
}
const pdf = 'data:application/pdf;base64,' + Buffer.from('%PDF-1.4\n% made-up test plans\n%%EOF').toString('base64');
const waitDone = async id => { for (let i = 0; i < 50; i++) { const t = (await call('admin', 'GET', `/estimating/takeoffs/${id}`)).data; if (t.status !== 'running') return t; await new Promise(r => setTimeout(r, 20)); } throw new Error('still running'); };
let bidId;

before(async () => {
  db = D.open(':memory:');
  server = createApp(db).listen(0); await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  tok.admin = (await (await fetch(base + '/api/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Owner', email: 'o@x.com', password: 'longenough' }) })).json()).token;
  for (const [role, email] of [['manager', 'm@x.com'], ['office', 'f@x.com']]) {
    await call('admin', 'POST', '/users', { name: role, email, password: 'password123', role });
    tok[role] = (await (await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'password123' }) })).json()).token;
  }
  db.prepare("INSERT INTO pricebook (code, name, kind, unit, unit_cost, unit_price, labor_hours) VALUES ('LT-24', '2x4 LED troffer', 'material', 'ea', 85, 150, 0.75)").run();
  for (const [c, n] of [['0810', 'Lighting'], ['0820', 'Devices']]) if (!db.prepare('SELECT 1 FROM cost_codes WHERE code = ?').get(c)) db.prepare('INSERT INTO cost_codes (code, name) VALUES (?, ?)').run(c, n);
  bidId = (await call('admin', 'POST', '/estimating/bids', { project_name: 'Test Office TI', job_kind: 'commercial' })).data.id;
});
after(() => server.close());

test('needs an API key, a PDF and a job type; admins and managers only', async () => {
  assert.equal((await call('admin', 'POST', `/estimating/bids/${bidId}/takeoff`, { kind: 'commercial', file: pdf })).status, 400, 'no key yet');
  await call('admin', 'PUT', '/settings', { anthropic_api_key: 'sk-test-not-real' });
  const s = (await call('admin', 'GET', '/me')).data.settings;
  assert.equal(s.anthropic_api_key, '', 'the key never goes back to a browser'); assert.equal(s.anthropic_api_key_set, '1');
  assert.equal((await call('admin', 'POST', `/estimating/bids/${bidId}/takeoff`, { kind: 'industrial', file: pdf })).status, 400);
  assert.equal((await call('admin', 'POST', `/estimating/bids/${bidId}/takeoff`, { kind: 'commercial', file: 'data:application/pdf;base64,' + Buffer.from('not a pdf').toString('base64') })).status, 400);
  assert.equal((await call('office', 'POST', `/estimating/bids/${bidId}/takeoff`, { kind: 'commercial', file: pdf })).status, 403);
  assert.equal((await call('office', 'GET', '/estimating/takeoff-settings')).status, 403);
});

test('runs the takeoff: request shape, pricing from the price book first, Claude second', async () => {
  reply = okReply;
  const { id } = (await call('manager', 'POST', `/estimating/bids/${bidId}/takeoff`, { kind: 'commercial', file: pdf, filename: 'plans.pdf' })).data;
  const t = await waitDone(id);
  assert.equal(t.status, 'done', t.error);
  const p = calls.at(-1).params;
  assert.equal(calls.at(-1).apiKey, 'sk-test-not-real');
  assert.equal(p.model, 'claude-opus-5-5'); assert.deepEqual(p.thinking, { type: 'adaptive' }); assert.equal(p.fallbacks, 'default');
  assert.equal(p.output_config.format.type, 'json_schema');
  assert.equal(p.messages[0].content[0].type, 'document'); assert.equal(p.messages[0].content[0].source.media_type, 'application/pdf');
  assert.match(p.system[0].text, /COMMERCIAL bid/); assert.match(p.system[0].text, /LT-24 \| 2x4 LED troffer/); assert.match(p.system[0].text, /\n0810 /);
  const [lt, rec, feeder] = t.lines;
  assert.equal(lt.priced_from, 'price book'); assert.equal(lt.material_unit, 85); assert.equal(lt.hours_unit, 0.75);
  assert.equal(rec.priced_from, 'AI suggestion'); assert.equal(rec.ext_material, 120);
  assert.equal(feeder.priced_from, 'not priced'); assert.equal(feeder.cost_code_ok, false);
  const rate = t.totals.labor_rate;   // crew average, or $65 with no wages set
  assert.equal(t.totals.material, 20 * 85 + 120);
  assert.equal(t.totals.hours, 20 * 0.75 + 10 * 0.5);
  assert.equal(t.totals.cost, Math.round((1820 + 20 * rate) * 100) / 100);
  assert.equal(t.totals.sell, Math.round(t.totals.cost * 1.15 * 100) / 100, 'commercial markup 15%');
  assert.deepEqual([t.totals.ai_priced, t.totals.unpriced, t.totals.low_confidence, t.totals.no_code], [1, 1, 1, 1]);
  assert.deepEqual(t.questions, ['Is the RTU disconnect by mechanical?']);
});

test('edits re-price; the template changes the numbers; the sell price becomes the bid value', async () => {
  const id = (await call('admin', 'GET', `/estimating/bids/${bidId}/takeoffs`)).data[0].id;
  let t = (await call('admin', 'GET', `/estimating/takeoffs/${id}`)).data;
  const lines = t.lines.map((l, i) => ({ ...l, ...(i === 2 ? { material_override: 6, hours_override: 0.1, phase_code: '0810' } : {}), ...(i === 1 ? { include: false } : {}) }));
  t = (await call('admin', 'PUT', `/estimating/takeoffs/${id}`, { lines })).data;
  assert.equal(t.lines[2].priced_from, 'edited'); assert.equal(t.lines[2].ext_material, 720); assert.equal(t.lines[2].cost_code_ok, true);
  assert.equal(t.totals.lines, 2, 'excluded line left out');
  await call('admin', 'PUT', '/estimating/takeoff-settings', { templates: { commercial: { labor_rate: 100, factor: 1.2, markup_pct: 10 } } });
  t = (await call('admin', 'GET', `/estimating/takeoffs/${id}`)).data;
  assert.equal(t.totals.labor_rate, 100); assert.equal(t.totals.factor, 1.2);
  assert.equal(t.totals.hours, Math.round((20 * 0.75 * 1.2 + 120 * 0.1 * 1.2) * 100) / 100);
  const r = (await call('admin', 'POST', `/estimating/takeoffs/${id}/apply`)).data;
  assert.equal(r.bid_value, t.totals.sell);
  const bid = (await call('admin', 'GET', '/estimating')).data.bids.find(b => b.id === bidId);
  assert.equal(bid.bid_value, t.totals.sell); assert.equal(bid.job_kind, 'commercial'); assert.equal(bid.takeoff_count, 1);
});

test('residential uses its own template; refusals and bad output end as errors with a reason', async () => {
  reply = okReply;
  const { id } = (await call('admin', 'POST', `/estimating/bids/${bidId}/takeoff`, { kind: 'residential', file: pdf })).data;
  const t = await waitDone(id);
  assert.match(calls.at(-1).params.system[0].text, /RESIDENTIAL bid/); assert.equal(t.totals.markup_pct, 25);
  reply = () => ({ stop_reason: 'refusal', content: [], usage: {} });
  const a = (await call('admin', 'POST', `/estimating/bids/${bidId}/takeoff`, { kind: 'commercial', file: pdf })).data.id;
  assert.match((await waitDone(a)).error, /declined/);
  reply = () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'not json' }], usage: {} });
  const b = (await call('admin', 'POST', `/estimating/bids/${bidId}/takeoff`, { kind: 'commercial', file: pdf })).data.id;
  assert.match((await waitDone(b)).error, /run it again/);
  // run it again, then delete it
  reply = okReply;
  await call('admin', 'POST', `/estimating/takeoffs/${b}/rerun`);
  assert.equal((await waitDone(b)).status, 'done');
  assert.equal((await call('admin', 'DELETE', `/estimating/takeoffs/${b}`)).status, 200);
  assert.equal((await call('admin', 'GET', `/estimating/takeoffs/${b}`)).status, 404);
});
