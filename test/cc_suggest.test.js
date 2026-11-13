'use strict';
// Cost code suggestions for material lines (PO lines): price-book code, past coding, trade words, the job's budget.
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
const cc = code => db.prepare('SELECT id FROM cost_codes WHERE code = ?').get(code).id;
const top = r => r.data.map(x => x.code);

before(async () => {
  db = D.open(':memory:');
  server = createApp(db).listen(0); await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  tok.admin = (await (await fetch(base + '/api/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Owner', email: 'o@x.com', password: 'longenough' }) })).json()).token;
  await call('admin', 'POST', '/users', { name: 'Tech', email: 't@x.com', password: 'password123', role: 'tech' });
  tok.tech = (await (await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 't@x.com', password: 'password123' }) })).json()).token;
});
after(() => server.close());

test('trade words point at the right code; nothing for nonsense; demolition codes only for removal', async () => {
  const s = async d => top(await call('admin', 'GET', '/cost-codes/suggest?description=' + encodeURIComponent(d)));
  assert.equal((await s('3/4" EMT set screw connector'))[0], '0810');
  assert.equal((await s('#12 THHN black 500ft'))[0], '0910');
  assert.equal((await s('20A GFCI receptacle'))[0], '1010');
  assert.equal((await s('1-5/8 strut 10ft'))[0], '0870');
  assert.equal((await s('Wago 221 lever nuts'))[0], '0930');
  assert.equal((await s('LED wall pack 40W'))[0], '1120');
  assert.deepEqual(await s('widget thing'), []);
  assert.ok(!(await s('2x4 troffer')).some(c => c.startsWith('04')), 'no demolition code for a new fixture');
  assert.equal((await s('remove existing troffers'))[0], '0420');
  assert.equal((await call('tech', 'GET', '/cost-codes/suggest?description=emt')).status, 403);
});

test('the price-book code wins; then how the same item was coded before', async () => {
  const pb = (await call('admin', 'POST', '/pricebook', { code: 'MISC1', name: 'Odd part', kind: 'material', unit_cost: 3, unit_price: 6, cost_code_id: cc('0870') })).data.id;
  let r = (await call('admin', 'GET', `/cost-codes/suggest?description=Odd%20part&pricebook_id=${pb}`)).data;
  assert.equal(r[0].code, '0870'); assert.match(r[0].why, /price-book item/);
  // an item the price book doesn't have: after it's been coded twice as 0930, that's the suggestion
  const vend = (await call('admin', 'POST', '/vendors', { name: 'Sample Supply' })).data.id;
  for (let i = 0; i < 2; i++) await call('admin', 'POST', '/purchase-orders', { vendor_id: vend, deliver_to: 'shop', lines: [{ description: 'Polaris IT-2/0', qty: 2, unit_cost: 30, cost_code_id: cc('0930') }] });
  r = (await call('admin', 'GET', '/cost-codes/suggest?description=polaris%20it-2/0')).data;
  assert.equal(r[0].code, '0930'); assert.match(r[0].why, /coded this way 2 times before/);
  // several lines at once
  const many = (await call('admin', 'POST', '/cost-codes/suggest', { lines: [{ description: 'EMT 3/4 10ft' }, { description: 'widget' }] })).data;
  assert.equal(many[0][0].code, '0810'); assert.deepEqual(many[1], []);
});

test('a received PO\'s cost code can still be changed; the received material and its bill line follow', async () => {
  const cust = (await call('admin', 'POST', '/customers', { name: 'Code Customer' })).data.id;
  const job = (await call('admin', 'POST', '/jobs', { customer_id: cust, title: 'Code job' })).data.id;
  const vend = (await call('admin', 'POST', '/vendors', { name: 'Code Supply' })).data.id;
  const po = (await call('admin', 'POST', '/purchase-orders', { vendor_id: vend, job_id: job, deliver_to: 'job', lines: [{ description: '4 square box', qty: 10, unit_cost: 3 }] })).data.id;
  await call('admin', 'POST', `/purchase-orders/${po}/receive`, { all: true });
  assert.equal(db.prepare('SELECT status FROM purchase_orders WHERE id = ?').get(po).status, 'received');
  const line = db.prepare('SELECT * FROM po_lines WHERE po_id = ?').get(po);
  const jm = db.prepare('SELECT * FROM job_materials WHERE po_line_id = ?').get(line.id);
  const bill = db.prepare("INSERT INTO bills (vendor_id, po_id, vendor_invoice, bill_date, status) VALUES (?, ?, 'B-9', date('now'), 'open')").run(vend, po).lastInsertRowid;
  db.prepare('INSERT INTO bill_lines (bill_id, account_id, description, amount, job_id, job_material_id) VALUES (?,?,?,?,?,?)').run(bill, db.prepare("SELECT id FROM accounts WHERE number = '5100'").get().id, 'boxes', 30, job, jm.id);
  // the normal save still refuses line edits on a received PO
  assert.match((await call('admin', 'PUT', `/purchase-orders/${po}`, { lines: [{ id: line.id, description: 'x', qty: 1, unit_cost: 1 }] })).data.error, /locked/);
  const r = (await call('admin', 'PUT', `/purchase-orders/${po}/codes`, { lines: [{ id: line.id, cost_code_id: cc('0870') }] })).data;
  assert.equal(r.changed, 1); assert.equal(r.received_updated, 1);
  assert.equal(db.prepare('SELECT cost_code_id FROM po_lines WHERE id = ?').get(line.id).cost_code_id, cc('0870'));
  assert.equal(db.prepare('SELECT cost_code_id FROM job_materials WHERE id = ?').get(jm.id).cost_code_id, cc('0870'));
  assert.equal(db.prepare('SELECT cost_code_id FROM bill_lines WHERE job_material_id = ?').get(jm.id).cost_code_id, cc('0870'));
  assert.match(db.prepare('SELECT body FROM job_notes WHERE job_id = ? ORDER BY id DESC').get(job).body, /"4 square box" none → 0870 \(received material updated too\)/);
  assert.equal((await call('admin', 'PUT', `/purchase-orders/${po}/codes`, { lines: [{ id: line.id, cost_code_id: cc('0870') }] })).data.changed, 0, 'same code: nothing');
  assert.equal((await call('admin', 'PUT', `/purchase-orders/${po}/codes`, { lines: [{ id: 999999, cost_code_id: cc('0870') }] })).status, 400);
  assert.equal((await call('tech', 'PUT', `/purchase-orders/${po}/codes`, { lines: [{ id: line.id, cost_code_id: null }] })).status, 403);
});
