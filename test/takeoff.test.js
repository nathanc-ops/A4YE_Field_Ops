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
  project_name: 'Test Office TI', plans_basis: 'Made-up test plans E1.1 and E2.1', scope_summary: 'Lighting and power for a small office suite', sheets_reviewed: ['E1.1 Lighting', 'E2.1 Power'],
  lines: [
    { phase_code: '0810', scope: 'lighting', phase: 'P4', area: 'Level 1', high_repetition: false, tag: 'A', description: '2x4 LED troffer', qty: 20, unit: 'EA', pricebook_code: 'LT-24', neca_hours: 0, material_unit: 0, source: 'E1.1', confidence: 'high', notes: '' },
    { phase_code: '0820', scope: 'power', phase: 'P4', area: 'Level 1', high_repetition: false, tag: '', description: 'Duplex receptacle', qty: 10, unit: 'EA', pricebook_code: '', neca_hours: 0.5, material_unit: 12, source: 'E2.1', confidence: 'medium', notes: '' },
    { phase_code: '9999', scope: 'distribution', phase: 'P3', area: 'Site', high_repetition: false, tag: '', description: 'Feeder to RTU', qty: 120, unit: 'LF', pricebook_code: '', neca_hours: 0, material_unit: 0, source: 'E2.1 scaled', confidence: 'low', notes: 'length scaled' },
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
  // the commercial template: blended crew rate $42.4722/h, productivity 0.75 on NECA-normal hours
  assert.equal(t.totals.labor_rate, 42.4722);
  assert.equal(t.totals.material, 20 * 85 + 120);
  assert.equal(t.totals.hours, Math.round((20 * 0.75 + 10 * 0.5) * 0.75 * 100) / 100);
  assert.equal(t.estimate.subtotal.neca_hours, 20 * 0.75 + 10 * 0.5);
  assert.equal(t.totals.sell, t.estimate.build.total, 'the bid total is the Summary build-up total');
  assert.ok(t.estimate.build.total > t.totals.cost);
  assert.deepEqual([t.totals.ai_priced, t.totals.unpriced, t.totals.low_confidence, t.totals.no_code], [1, 1, 1, 1]);
  assert.deepEqual(t.questions, ['Is the RTU disconnect by mechanical?']); assert.deepEqual(t.clarifications, ['Ceiling grid by others']);
});

test('edits re-price; the template changes the numbers; the sell price becomes the bid value', async () => {
  const id = (await call('admin', 'GET', `/estimating/bids/${bidId}/takeoffs`)).data[0].id;
  let t = (await call('admin', 'GET', `/estimating/takeoffs/${id}`)).data;
  const lines = t.lines.map((l, i) => ({ ...l, ...(i === 2 ? { material_override: 6, hours_override: 0.1, phase_code: '0810' } : {}), ...(i === 1 ? { include: false } : {}) }));
  t = (await call('admin', 'PUT', `/estimating/takeoffs/${id}`, { lines })).data;
  assert.equal(t.lines[2].priced_from, 'edited'); assert.equal(t.lines[2].ext_material, 720); assert.equal(t.lines[2].cost_code_ok, true);
  assert.equal(t.totals.lines, 2, 'excluded line left out');
  // the job type's template: one crew class at $50 x 1.4 burden, productivity 1.0
  await call('admin', 'PUT', '/estimating/takeoff-settings', { templates: { commercial: { assumptions: { crew: [{ cls: 'Journeyman', base: 50, mix: 100, local: 100 }], burden: 1.4, productivity: 1 } } } });
  t = (await call('admin', 'GET', `/estimating/takeoffs/${id}`)).data;
  assert.equal(t.totals.labor_rate, 70); assert.equal(t.totals.factor, 1);
  assert.equal(t.totals.hours, Math.round((20 * 0.75 + 120 * 0.1) * 100) / 100);
  // this estimate only: 10% O&P, no contingency, no indirects
  t = (await call('admin', 'PUT', `/estimating/takeoffs/${id}`, { assumptions: { ...t.assumptions, op_pct: 10, contingency_pct: 0, small_tools_pct: 0, trucks: 0, conex_week: 0, safety_pct: 0, mob_equip_pct: 0, mob_crew_pct: 0, pm_hours_week: 0, tax_pct: 0 } })).data;
  assert.equal(t.totals.sell, Math.round(t.totals.cost * 1.1 * 100) / 100);
  assert.equal((await call('admin', 'GET', '/estimating/takeoff-settings')).data.templates.commercial.assumptions.op_pct, 21.95, 'the template is unchanged');
  const r = (await call('admin', 'POST', `/estimating/takeoffs/${id}/apply`)).data;
  assert.equal(r.bid_value, t.totals.sell);
  const bid = (await call('admin', 'GET', '/estimating')).data.bids.find(b => b.id === bidId);
  assert.equal(bid.bid_value, t.totals.sell); assert.equal(bid.job_kind, 'commercial'); assert.equal(bid.takeoff_count, 1);
});

test('residential uses its own template; refusals and bad output end as errors with a reason', async () => {
  reply = okReply;
  const { id } = (await call('admin', 'POST', `/estimating/bids/${bidId}/takeoff`, { kind: 'residential', file: pdf })).data;
  const t = await waitDone(id);
  assert.match(calls.at(-1).params.system[0].text, /RESIDENTIAL bid/); assert.equal(t.assumptions.op_pct, 25); assert.equal(t.assumptions.productivity, 1);
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

test('exports the estimate in the quote workbook layout, with formulas', async () => {
  const id = (await call('admin', 'GET', `/estimating/bids/${bidId}/takeoffs`)).data.at(-1).id;
  const res = await fetch(`${base}/api/estimating/takeoffs/${id}/xlsx`, { headers: { Authorization: 'Bearer ' + tok.admin } });
  assert.equal(res.status, 200); assert.match(res.headers.get('content-type'), /spreadsheetml/);
  const wb = require('../server/xlsx').read(Buffer.from(await res.arrayBuffer()));
  assert.deepEqual(wb.sheetNames.slice(0, 2), ['Cover & Assumptions', 'Summary']);
  assert.ok(wb.sheetNames.includes('Electrical - Lighting')); assert.ok(wb.sheetNames.includes('Schedule & Crew'));
  const sh = wb.sheet('Electrical - Lighting');
  assert.equal(sh.val(5, 1), 'Phase Code'); assert.equal(sh.val(5, 16), 'Notes / Source');
  const row = [...sh.rows.keys()].find(r => /troffer/.test(sh.val(r, 4) || ''));
  assert.match(sh.val(row, 1), /-P\d-0810$/);
  assert.ok(sh.cell(row, 10).f && sh.cell(row, 15).f, 'adjusted hours and ext. cost are formulas');
});

test('price list import (EMT pricing layout) fills the price book; EMT fittings are derived from footage', async () => {
  const { xlsx } = require('./_xlsx');
  const H = ['Key', 'Cost Code - Mat', 'Cost Code - Lab', 'Category', 'Description', 'Size', 'Unit', 'Material $/Unit', 'NECA Hrs/Unit', 'Prod. Factor', 'Adj. Hrs/Unit', 'Labor $/Unit', 'Total Unit Cost', 'Vendor Item #', 'CAT #'];
  const rows = [H, ['TEST CONDUIT'], ['EMT-3/4"', '0810-M', '0810-L', 'Conduit - EMT', '3/4" EMT conduit (test)', '3/4"', 'FT', 1, 0.04],
    ['SSCPLG-3/4"', '0810-M', '0810-L', 'Fitting', '3/4" set screw coupling (test)', '3/4"', 'EA', 0.5, 0.1], ['SSCONN-3/4"', '0810-M', '0810-L', 'Fitting', '3/4" set screw connector (test)', '3/4"', 'EA', 0.4, 0.12],
    ['STRAP-3/4"', '0810-M', '0810-L', 'Support', '3/4" strap (test)', '3/4"', 'EA', 0.3, 0.05]];
  const cells = {}; rows.forEach((r, i) => r.forEach((v, j) => { if (v !== undefined) cells[`${String.fromCharCode(65 + j)}${i + 1}`] = v; }));
  const file = xlsx({ 'How to Use': { A1: 'test' }, 'EMT Price List': cells }).toString('base64');
  const r = (await call('admin', 'POST', '/estimating/price-list', { file })).data;
  assert.deepEqual([r.created, r.updated, r.sheets[0]], [4, 0, 'EMT Price List']);
  assert.equal((await call('admin', 'POST', '/estimating/price-list', { file })).data.updated, 4, 're-import updates');
  const pb = db.prepare("SELECT * FROM pricebook WHERE code = 'EMT-3/4\"'").get();
  assert.equal(pb.unit_cost, 1); assert.equal(pb.labor_hours, 0.04); assert.equal(pb.unit, 'ft');
  // a takeoff with 1,000 LF of 3/4" EMT gets 100 couplings, 60 connectors, 120 straps added
  reply = () => ({ model: 'claude-opus-5-5', stop_reason: 'end_turn', usage: {}, content: [{ type: 'text', text: JSON.stringify({ ...takeoffJson,
    lines: [{ phase_code: '0810', scope: 'power', phase: 'P2', area: '', tag: '', description: '3/4" EMT', qty: 1000, unit: 'LF', pricebook_code: 'EMT-3/4"', neca_hours: 0, material_unit: 0, high_repetition: false, source: 'E2.1', confidence: 'medium', notes: '' }] }) }] });
  const { id } = (await call('admin', 'POST', `/estimating/bids/${bidId}/takeoff`, { kind: 'commercial', file: pdf })).data;
  const t = await waitDone(id);
  const derived = t.lines.filter(l => l.derived).map(l => [l.pricebook_code, l.qty]);
  assert.deepEqual(derived, [['SSCPLG-3/4"', 100], ['SSCONN-3/4"', 60], ['STRAP-3/4"', 120]]);
  assert.equal(t.totals.material, 1000 * 1 + 100 * 0.5 + 60 * 0.4 + 120 * 0.3);
});

test('proposal draft: built from the takeoff, saved, standard lists become company defaults', async () => {
  const id = (await call('admin', 'GET', `/estimating/bids/${bidId}/takeoffs`)).data[0].id;
  const p = (await call('admin', 'GET', `/estimating/takeoffs/${id}/proposal`)).data;
  assert.equal(p.draft, null); assert.ok(p.takeoff.total > 0); assert.ok(p.takeoff.lines.length);
  assert.ok(p.defaults.qualifications.some(q => /30 days/.test(q)));
  const draft = { greeting: 'Hello Pat,', std_qualifications: ['Pricing assumes normal weekday working hours.', 'Valid 45 days.'] };
  await call('admin', 'PUT', `/estimating/takeoffs/${id}/proposal`, { draft, save_defaults: true });
  const again = (await call('admin', 'GET', `/estimating/takeoffs/${id}/proposal`)).data;
  assert.equal(again.draft.greeting, 'Hello Pat,'); assert.deepEqual(again.defaults.qualifications, draft.std_qualifications);
  assert.equal((await call('office', 'GET', `/estimating/takeoffs/${id}/proposal`)).status, 403);
});

test('several files per takeoff: PDFs and images go to Claude together; add, remove, limits', async () => {
  reply = okReply;
  const png = 'data:image/png;base64,' + Buffer.concat([Buffer.from([0x89]), Buffer.from('PNG\r\n\x1a\n'), Buffer.alloc(20)]).toString('base64');
  const specs = 'data:application/pdf;base64,' + Buffer.from('%PDF-1.4\n% made-up specifications\n%%EOF').toString('base64');
  const { id } = (await call('admin', 'POST', `/estimating/bids/${bidId}/takeoff`, { kind: 'commercial', files: [{ file: pdf, filename: 'E-sheets.pdf' }, { file: specs, filename: 'Specs.pdf' }, { file: png, filename: 'panel photo.png' }] })).data;
  let t = await waitDone(id);
  const content = calls.at(-1).params.messages[0].content;
  assert.deepEqual(content.map(b => b.type), ['document', 'document', 'image', 'text']);
  assert.equal(content[1].title, 'Specs.pdf'); assert.equal(content[2].source.media_type, 'image/png');
  assert.match(content[3].text, /3 files are: 1\. E-sheets\.pdf; 2\. Specs\.pdf; 3\. panel photo\.png \(image\)/);
  assert.deepEqual(t.files.map(f => f.filename), ['E-sheets.pdf', 'Specs.pdf', 'panel photo.png']);
  // add an addendum, remove the photo, run again: Claude gets the new set
  assert.equal((await call('admin', 'POST', `/estimating/takeoffs/${id}/files`, { files: [{ file: specs, filename: 'Addendum 1.pdf' }] })).data.files, 4);
  assert.equal((await call('admin', 'DELETE', `/estimating/takeoffs/${id}/files/2`)).status, 200);
  await call('admin', 'POST', `/estimating/takeoffs/${id}/rerun`);
  t = await waitDone(id);
  assert.deepEqual(t.files.map(f => f.filename), ['E-sheets.pdf', 'Specs.pdf', 'Addendum 1.pdf']);
  assert.deepEqual(calls.at(-1).params.messages[0].content.map(b => b.title || b.type), ['E-sheets.pdf', 'Specs.pdf', 'Addendum 1.pdf', 'text']);
  // limits: not a PDF or image; too many; last file can't be removed
  const txt = 'data:text/plain;base64,' + Buffer.from('hello').toString('base64');
  const r1 = await call('admin', 'POST', `/estimating/bids/${bidId}/takeoff`, { kind: 'commercial', files: [{ file: pdf, filename: 'a.pdf' }, { file: txt, filename: 'notes.txt' }] });
  assert.equal(r1.status, 400); assert.match(r1.data.error, /notes\.txt is not a PDF or an image/);
  const many = Array.from({ length: 21 }, (_, i) => ({ file: pdf, filename: `s${i}.pdf` }));
  assert.match((await call('admin', 'POST', `/estimating/bids/${bidId}/takeoff`, { kind: 'commercial', files: many })).data.error, /Up to 20 files/);
  const one = (await call('admin', 'POST', `/estimating/bids/${bidId}/takeoff`, { kind: 'commercial', files: [{ file: pdf, filename: 'only.pdf' }] })).data.id;
  await waitDone(one);
  assert.equal((await call('admin', 'DELETE', `/estimating/takeoffs/${one}/files/0`)).status, 400);
});

test('underbidding guards: complete-scope rules and coverage in the request; a $0 price book item does not zero a line; effort per template', async () => {
  db.prepare("INSERT INTO pricebook (code, name, kind, unit, unit_cost, unit_price, labor_hours) VALUES ('BOX-4SQ', '4\" square box', 'material', 'ea', 0, 0, 0)").run();
  reply = () => ({ model: 'claude-opus-5-5', stop_reason: 'end_turn', usage: {}, content: [{ type: 'text', text: JSON.stringify({ ...takeoffJson,
    scope_checklist: [{ category: 'Branch wire', status: 'counted', note: '' }, { category: 'Firestopping', status: 'not_shown', note: 'no penetrations shown' }],
    lines: [{ phase_code: '0870', scope: 'power', phase: 'P2', area: '', tag: '', description: '4" square box with ring', qty: 50, unit: 'EA', pricebook_code: 'BOX-4SQ', neca_hours: 0.3, material_unit: 4.5, high_repetition: false, source: 'E2.1', confidence: 'medium', notes: '' }] }) }] });
  await call('admin', 'PUT', '/estimating/takeoff-settings', { templates: { commercial: { effort: 'max' } } });
  const { id } = (await call('admin', 'POST', `/estimating/bids/${bidId}/takeoff`, { kind: 'commercial', file: pdf })).data;
  const t = await waitDone(id);
  const p = calls.at(-1).params;
  assert.equal(p.output_config.effort, 'max');
  assert.match(p.system[0].text, /Never leave a line at 0/); assert.match(p.system[0].text, /branch conductors/); assert.match(p.system[0].text, /scope_checklist/);
  assert.ok(Takeoff.SCHEMA.required.includes('scope_checklist'));
  const box = t.lines[0];
  assert.equal(box.material_unit, 4.5, "Claude's price fills the price book's blank cost"); assert.equal(box.hours_unit, 0.3); assert.equal(box.priced_from, 'AI suggestion');
  assert.equal(t.scope_checklist[1].status, 'not_shown');
  let C = t.estimate.checks;
  assert.equal(C.no_material, 0);
  const t2 = (await call('admin', 'PUT', `/estimating/takeoffs/${id}`, { assumptions: { ...t.assumptions, productivity: 0.75 } })).data;
  C = t2.estimate.checks;
  assert.equal(C.productivity_factor, 0.75);
  assert.ok(Math.abs(C.productivity_cost - 50 * 0.3 * 0.25 * t2.estimate.rates.blended * (1 + t2.assumptions.contingency_pct / 100) * (1 + t2.assumptions.op_pct / 100)) < 0.05, 'the 0.75 factor is shown in dollars, marked up');
  assert.equal((await call('admin', 'GET', '/estimating/takeoff-settings')).data.templates.commercial.effort, 'max');
  await call('admin', 'PUT', '/estimating/takeoff-settings', { templates: { commercial: { effort: 'xhigh' } } });
});

test('estimate-specific instructions: sent to Claude as their own block, editable, used on the next run', async () => {
  reply = okReply;
  const notes = 'MC cable above ceilings, EMT where exposed. Owner furnishes fixtures (labor only).';
  const { id } = (await call('admin', 'POST', `/estimating/bids/${bidId}/takeoff`, { kind: 'commercial', file: pdf, notes })).data;
  let t = await waitDone(id);
  assert.equal(t.notes, notes);
  let blocks = calls.at(-1).params.messages[0].content.filter(b => b.type === 'text');
  assert.equal(blocks.length, 2);
  assert.match(blocks[1].text, /these win/); assert.match(blocks[1].text, /<estimator_instructions>\nMC cable above ceilings/);
  assert.equal((await call('office', 'PUT', `/estimating/takeoffs/${id}/instructions`, { notes: 'x' })).status, 403);
  await call('admin', 'PUT', `/estimating/takeoffs/${id}/instructions`, { notes: 'Only the restroom areas are in our scope.' });
  await call('admin', 'POST', `/estimating/takeoffs/${id}/rerun`);
  t = await waitDone(id);
  blocks = calls.at(-1).params.messages[0].content.filter(b => b.type === 'text');
  assert.match(blocks[1].text, /Only the restroom areas/);
  // cleared: no instructions block at all
  await call('admin', 'PUT', `/estimating/takeoffs/${id}/instructions`, { notes: '' });
  await call('admin', 'POST', `/estimating/takeoffs/${id}/rerun`); await waitDone(id);
  assert.equal(calls.at(-1).params.messages[0].content.filter(b => b.type === 'text').length, 1);
});
