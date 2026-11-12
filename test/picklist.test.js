'use strict';
// Pick lists: material added by hand (price book or typed), editing, field requests, completion costing.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const D = require('../server/db');
const { createApp } = require('../server/app');

let server, base, db;
const tok = {}, ids = {};
async function call(who, method, p, body) {
  const res = await fetch(base + '/api' + p, { method, headers: { 'Content-Type': 'application/json', ...(tok[who] ? { Authorization: 'Bearer ' + tok[who] } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json() };
}
const cc = code => db.prepare('SELECT id FROM cost_codes WHERE code = ?').get(code).id;

before(async () => {
  db = D.open(':memory:');
  server = createApp(db).listen(0);
  await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  tok.admin = (await call(null, 'POST', '/setup', { name: 'Owner', email: 'o@x.com', password: 'longenough' })).data.token;
  ids.tech = (await call('admin', 'POST', '/users', { name: 'Jay', email: 'j@x.com', password: 'password123', role: 'tech' })).data.id;
  ids.other = (await call('admin', 'POST', '/users', { name: 'Ava', email: 'a@x.com', password: 'password123', role: 'tech' })).data.id;
  tok.tech = (await call(null, 'POST', '/login', { email: 'j@x.com', password: 'password123' })).data.token;
  tok.other = (await call(null, 'POST', '/login', { email: 'a@x.com', password: 'password123' })).data.token;
  ids.cust = (await call('admin', 'POST', '/customers', { name: 'GC' })).data.id;
  ids.job = (await call('admin', 'POST', '/jobs', { customer_id: ids.cust, title: 'TI', tech_ids: [ids.tech] })).data.id;
  ids.box = (await call('admin', 'POST', '/pricebook', { code: 'BOX4', name: '4" square box', kind: 'material', unit: 'ea', unit_cost: 2.5, unit_price: 6, qty_on_hand: 100, cost_code_id: cc('0870') })).data.id;
});
after(() => server.close());

test('empty pick list: office adds price-book and hand-typed material, edits and removes lines', async () => {
  const r = await call('admin', 'POST', `/jobs/${ids.job}/pick-lists`, { needed_by: '2026-11-12' });
  assert.equal(r.status, 200); assert.equal(r.data.lines, 0);
  ids.pl = r.data.id;
  let p = (await call('admin', 'GET', `/pick-lists/${ids.pl}`)).data;
  assert.deepEqual(p.lines, []); assert.equal(p.can_edit, true);
  const add = await call('admin', 'PUT', `/pick-lists/${ids.pl}`, { lines: [
    { pricebook_id: ids.box, qty: 24 },
    { description: '3/4" EMT set-screw connectors', qty: 50, unit: 'ea', unit_cost: 0.42, cost_code_id: cc('0810'), note: 'steel, not die-cast' },
  ] });
  assert.equal(add.status, 200, JSON.stringify(add.data));
  p = (await call('admin', 'GET', `/pick-lists/${ids.pl}`)).data;
  assert.equal(p.lines.length, 2);
  const box = p.lines.find(l => l.pricebook_id === ids.box), emt = p.lines.find(l => !l.pricebook_id);
  assert.equal(box.description, '4" square box'); assert.equal(box.unit, 'ea'); assert.equal(box.cost_code, '0870'); assert.equal(box.added_by_name, 'Owner');
  assert.equal(emt.unit_cost, 0.42); assert.equal(emt.note, 'steel, not die-cast'); assert.equal(emt.cost_code, '0810');
  assert.equal((await call('admin', 'PUT', `/pick-lists/${ids.pl}`, { lines: [{ description: 'Nothing', qty: 0 }] })).status, 400);
  assert.equal((await call('admin', 'PUT', `/pick-lists/${ids.pl}`, { lines: [{ description: '', qty: 3 }] })).data.ok, true, 'blank rows are ignored');
  await call('admin', 'PUT', `/pick-lists/${ids.pl}`, { lines: [{ id: box.id, qty: 30 }] });
  assert.equal(db.prepare('SELECT qty FROM pick_list_lines WHERE id = ?').get(box.id).qty, 30);
  // a tech on the job can request more; not remove, and costs they type are ignored
  const req = await call('tech', 'PUT', `/pick-lists/${ids.pl}`, { lines: [{ description: 'Red wirenuts', qty: 1, unit: 'jar', unit_cost: 999 }] });
  assert.equal(req.status, 200);
  const nut = db.prepare("SELECT * FROM pick_list_lines WHERE description = 'Red wirenuts'").get();
  assert.equal(nut.added_by, ids.tech); assert.equal(nut.unit_cost, null);
  assert.equal((await call('tech', 'PUT', `/pick-lists/${ids.pl}`, { remove: [box.id] })).status, 403, 'not the office\'s lines');
  assert.equal((await call('other', 'PUT', `/pick-lists/${ids.pl}`, { lines: [{ description: 'x', qty: 1 }] })).status, 403, 'not on the job');
  assert.equal((await call('admin', 'PUT', `/pick-lists/${ids.pl}`, { remove: [nut.id] })).status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM pick_list_lines WHERE pick_list_id = ?').get(ids.pl).n, 2);
});

test('completing the pick charges the job: price-book cost and stock, hand-typed cost with markup', async () => {
  const p = (await call('admin', 'GET', `/pick-lists/${ids.pl}`)).data;
  await call('tech', 'PUT', `/pick-lists/${ids.pl}`, { lines: p.lines.map(l => ({ id: l.id, qty_picked: l.qty })) });
  assert.equal((await call('tech', 'POST', `/pick-lists/${ids.pl}/complete`, {})).status, 200);
  const mats = db.prepare('SELECT * FROM job_materials WHERE job_id = ? ORDER BY id').all(ids.job);
  assert.equal(mats.length, 2);
  const box = mats.find(m => m.pricebook_id === ids.box), emt = mats.find(m => !m.pricebook_id);
  assert.equal(box.qty, 30); assert.equal(box.unit_cost, 2.5); assert.equal(db.prepare('SELECT qty_on_hand FROM pricebook WHERE id = ?').get(ids.box).qty_on_hand, 70);
  assert.equal(emt.unit_cost, 0.42); assert.ok(emt.unit_price > 0.42, 'custom items get the default markup'); assert.equal(emt.source, 'pick list');
  // picked lists are locked for new lines
  const more = await call('admin', 'PUT', `/pick-lists/${ids.pl}`, { lines: [{ description: 'More', qty: 1 }] });
  assert.equal(more.status, 400); assert.match(more.data.error, /new one/);
  assert.equal((await call('admin', 'GET', `/pick-lists/${ids.pl}`)).data.can_edit, false);
});

test('from the estimate: price-book materials and hand-typed material lines, not labor or fees', async () => {
  const est = (await call('admin', 'POST', '/estimates', { customer_id: ids.cust, job_id: ids.job, items: [
    { pricebook_id: ids.box, description: '4" square box', qty: 12, unit_price: 6, unit_cost: 2.5 },
    { description: '400A meter base', qty: 1, unit_price: 900, unit_cost: 520 },
    { description: 'Electrical labor', qty: 16, unit_price: 125 },
    { description: 'Permit & inspection fee', qty: 1, unit_price: 175 },
  ] })).data.id;
  await call('admin', 'PUT', `/estimates/${est}`, { status: 'approved' });
  const r = await call('admin', 'POST', `/jobs/${ids.job}/pick-lists`, { from_estimate: true });
  assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.lines, 2);
  const lines = (await call('admin', 'GET', `/pick-lists/${r.data.id}`)).data.lines.map(l => l.description).sort();
  assert.deepEqual(lines, ['4" square box', '400A meter base']);
  assert.equal(db.prepare("SELECT unit_cost FROM pick_list_lines WHERE description = '400A meter base'").get().unit_cost, 520);
});

test('log material used on a job: blank unit cost keeps the price-book cost', async () => {
  const m = await call('admin', 'POST', `/jobs/${ids.job}/materials`, { pricebook_id: ids.box, qty: 2, unit_cost: null, source: 'stock' });
  assert.equal(m.status, 200);
  assert.equal(db.prepare('SELECT unit_cost FROM job_materials WHERE id = ?').get(m.data.id).unit_cost, 2.5);
  const c = await call('tech', 'POST', `/jobs/${ids.job}/materials`, { description: 'Unistrut 10ft', qty: 3, source: 'supply_house' });
  assert.equal(c.status, 200);
});

test('a tech starts a pick list for their own job, adds and fixes their own lines; the office sees who asked', async () => {
  assert.equal((await call('other', 'POST', `/jobs/${ids.job}/pick-lists`, { notes: 'x' })).status, 403, 'not on the job');
  const r = (await call('tech', 'POST', `/jobs/${ids.job}/pick-lists`, { needed_by: '2026-12-01', assigned_to: ids.other, notes: 'For the 2nd floor',
    lines: [{ pricebook_id: ids.box, qty: 12 }, { description: '1/2" KO seals', qty: 20, unit_cost: 50 }] })).data;
  assert.ok(r.id); assert.equal(r.lines, 2);
  const pl = (await call('admin', 'GET', `/pick-lists/${r.id}`)).data;
  assert.equal(pl.created_by_name, 'Jay'); assert.equal(pl.assigned_to, null, 'a tech can\'t pick who picks');
  assert.ok(pl.lines.every(l => l.added_by === ids.tech));
  assert.equal(db.prepare("SELECT unit_cost FROM pick_list_lines WHERE description = '1/2\" KO seals'").get().unit_cost, null, 'typed costs ignored');
  assert.equal((await call('admin', 'GET', '/pick-lists')).data.find(p => p.id === r.id).created_by_name, 'Jay');
  const seals = pl.lines.find(l => !l.pricebook_id);
  assert.equal((await call('tech', 'PUT', `/pick-lists/${r.id}`, { lines: [{ id: seals.id, qty: 25 }] })).status, 200);
  assert.equal(db.prepare('SELECT qty FROM pick_list_lines WHERE id = ?').get(seals.id).qty, 25);
  assert.equal((await call('tech', 'PUT', `/pick-lists/${r.id}`, { remove: [seals.id] })).status, 200, 'own line, still open');
  // once picking starts, their lines are locked too
  const box = pl.lines.find(l => l.pricebook_id);
  await call('admin', 'PUT', `/pick-lists/${r.id}`, { lines: [{ id: box.id, qty_picked: 5 }] });
  assert.equal((await call('tech', 'PUT', `/pick-lists/${r.id}`, { remove: [box.id] })).status, 403);
  assert.equal((await call('tech', 'GET', '/pick-lists')).data.some(p => p.id === r.id), true, 'on their list');
});
