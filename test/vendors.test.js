'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const D = require('../server/db');
const { createApp } = require('../server/app');

let server, base, db; const tok = {};
async function call(who, method, p, body) {
  const res = await fetch(base + '/api' + p, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok[who] }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json() };
}
const ins = (sql, ...a) => Number(db.prepare(sql).run(...a).lastInsertRowid);

before(async () => {
  db = D.open(':memory:');
  server = createApp(db).listen(0); await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  tok.admin = (await (await fetch(base + '/api/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Owner', email: 'o@x.com', password: 'longenough' }) })).json()).token;
  for (const [role, email] of [['office', 'f@x.com'], ['tech', 't@x.com']]) {
    await call('admin', 'POST', '/users', { name: role, email, password: 'password123', role });
    tok[role] = (await (await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'password123' }) })).json()).token;
  }
});
after(() => server.close());

test('add, edit, list with totals, detail, and delete only when unused', async () => {
  const a = (await call('admin', 'POST', '/vendors', { name: 'Test Supply', terms_days: 30, phone: '555-0100' })).data.id;
  const b = (await call('admin', 'POST', '/vendors', { name: 'Spare Parts Co' })).data.id;
  assert.equal((await call('admin', 'POST', '/vendors', { name: 'test supply' })).status, 400, 'same name, any case');
  assert.equal((await call('admin', 'PUT', `/vendors/${b}`, { name: 'Test Supply' })).status, 400);
  assert.equal((await call('admin', 'PUT', `/vendors/${b}`, { contact: 'Pat at the counter' })).status, 200);
  // history for vendor a: a PO, a stocked item, a bill ($300, $100 paid, past due)
  ins("INSERT INTO purchase_orders (number, vendor_id, status, order_date) VALUES ('PO-1', ?, 'submitted', '2026-10-01')", a);
  ins("INSERT INTO pricebook (code, name, kind, unit_cost, unit_price, vendor_id) VALUES ('W12', '12/2 wire', 'material', 80, 120, ?)", a);
  const acct = db.prepare('SELECT id FROM accounts ORDER BY id LIMIT 1').get().id;
  const bill = ins("INSERT INTO bills (vendor_id, vendor_invoice, bill_date, due_date, status) VALUES (?, 'S-77', date('now', '-20 days'), date('now', '-5 days'), 'partial')", a);
  ins('INSERT INTO bill_lines (bill_id, account_id, amount) VALUES (?,?,300)', bill, acct);
  ins("INSERT INTO bill_payments (bill_id, amount, paid_at) VALUES (?, 100, date('now'))", bill);
  const list = (await call('admin', 'GET', '/vendors?detail=1')).data;
  const va = list.find(v => v.id === a);
  assert.deepEqual([va.po_count, va.open_po_count, va.item_count, va.owed, va.overdue, va.spend_12mo], [1, 1, 1, 200, 200, 300]);
  const d = (await call('admin', 'GET', `/vendors/${a}`)).data;
  assert.equal(d.purchase_orders.length, 1); assert.equal(d.items.length, 1); assert.equal(d.bills[0].balance, 200); assert.equal(d.owed, 200);
  // in use → refuse delete, explain why
  const del = await call('admin', 'DELETE', `/vendors/${a}`);
  assert.equal(del.status, 409); assert.match(del.data.error, /1 purchase order, 1 bill, 1 price book item/);
  assert.equal((await call('admin', 'DELETE', `/vendors/${b}`)).status, 200);
});

test('office without accounting sees vendors but not the bill money; techs see nothing', async () => {
  const list = await call('office', 'GET', '/vendors?detail=1');
  assert.equal(list.status, 200);
  assert.ok(list.data.every(v => v.owed === undefined));
  const d = (await call('office', 'GET', `/vendors/${list.data[0].id}`)).data;
  assert.equal(d.sees_bills, false); assert.equal(d.bills, undefined);
  assert.equal((await call('tech', 'GET', '/vendors')).status, 403);
});

test('several contacts per vendor; the PO goes to the ones marked for POs', async () => {
  const id = (await call('admin', 'POST', '/vendors', { name: 'Contact Test Supply', email: 'orders@example.com' })).data.id;
  const c1 = (await call('admin', 'POST', `/vendors/${id}/contacts`, { name: 'Counter Rep', role: 'Counter', phone: '555-0101' })).data.id;
  await call('office', 'POST', `/vendors/${id}/contacts`, { name: 'Outside Sales', email: 'sales@example.com', gets_pos: 1 });
  await call('admin', 'POST', `/vendors/${id}/contacts`, { name: 'AP Dept', email: 'ap@example.com' });
  assert.equal((await call('admin', 'POST', `/vendors/${id}/contacts`, { role: 'nobody' })).status, 400);
  assert.equal((await call('admin', 'POST', `/vendors/${id}/contacts`, { name: 'x', email: 'not-an-email' })).status, 400);
  let v = (await call('admin', 'GET', `/vendors/${id}`)).data;
  assert.deepEqual(v.contacts.map(c => c.name), ['Counter Rep', 'Outside Sales', 'AP Dept']);
  assert.equal(v.contact, 'Counter Rep', 'first contact shows as the vendor contact');
  const po = Number(db.prepare("INSERT INTO purchase_orders (number, vendor_id) VALUES ('PO-CT', ?)").run(id).lastInsertRowid);
  assert.deepEqual((await call('admin', 'GET', `/purchase-orders/${po}`)).data.to_emails, ['sales@example.com']);
  await call('admin', 'PUT', `/vendor-contacts/${v.contacts[1].id}`, { gets_pos: 0 });
  assert.deepEqual((await call('admin', 'GET', `/purchase-orders/${po}`)).data.to_emails, ['orders@example.com'], 'falls back to the main email');
  await call('admin', 'DELETE', `/vendor-contacts/${c1}`);
  v = (await call('admin', 'GET', `/vendors/${id}`)).data;
  assert.equal(v.contacts.length, 2); assert.equal(v.contact, 'Outside Sales');
  assert.equal((await call('tech', 'POST', `/vendors/${id}/contacts`, { name: 'x' })).status, 403);
});

test('migration 34 copies an existing vendor contact into the contact list', () => {
  const M = require('../server/migrations');
  const fresh = D.open(':memory:');
  const vid = Number(fresh.prepare("INSERT INTO vendors (name, contact, email, phone) VALUES ('Old Way', 'Jo', 'jo@example.com', '555')").run().lastInsertRowid);
  fresh.exec('DROP TABLE vendor_contacts'); fresh.exec('UPDATE schema_version SET version = 33');
  M.migrate(fresh);
  assert.deepEqual({ ...fresh.prepare('SELECT name, email, phone, gets_pos FROM vendor_contacts WHERE vendor_id = ?').get(vid) }, { name: 'Jo', email: 'jo@example.com', phone: '555', gets_pos: 1 });
});
