'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fo-cancel-'));
const { DatabaseSync } = require('node:sqlite');
const D = require('../server/db');
const { createApp } = require('../server/app');

let server, base, db, tok, techTok, cust, vendor;
async function call(method, p, body, token = tok) {
  const res = await fetch(base + '/api' + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json() };
}
const at = d => new Date(Date.now() + d * 864e5).toISOString();
const newJob = async (extra = {}) => (await call('POST', '/jobs', { customer_id: cust, title: 'Panel upgrade', scheduled_start: at(2), scheduled_end: at(2.1), ...extra })).data.id;
const newEst = async (extra = {}) => (await call('POST', '/estimates', { customer_id: cust, title: 'Panel upgrade', items: [{ description: '200A panel', qty: 1, unit_price: 2400, unit_cost: 900 }], ...extra })).data.id;

before(async () => {
  db = D.open(':memory:');
  server = createApp(db).listen(0);
  await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  tok = (await call('POST', '/setup', { name: 'Owner', email: 'o@x.com', password: 'longenough' })).data.token;
  await call('POST', '/users', { name: 'Mike', email: 'mike@x.com', password: 'password123', role: 'tech' });
  techTok = (await call('POST', '/login', { email: 'mike@x.com', password: 'password123' }, null)).data.token;
  cust = (await call('POST', '/customers', { name: 'Jordan Smith', email: 'j@ex.com' })).data.id;
  vendor = (await call('POST', '/vendors', { name: 'City Electric' })).data.id;
});
after(() => server.close());

test('cancelling a job keeps it, clears the board and closes open paperwork', async () => {
  const job = await newJob();
  const est = await newEst({ job_id: job });
  const po = (await call('POST', '/purchase-orders', { vendor_id: vendor, job_id: job, lines: [{ description: 'Panel', qty: 1, unit_cost: 900 }] })).data.id;
  assert.equal(db.prepare("SELECT COUNT(*) n FROM appointments WHERE job_id = ? AND status != 'cancelled'").get(job).n, 1);

  assert.equal((await call('POST', `/jobs/${job}/cancel`, { reason: 'Went with another contractor' }, techTok)).status, 403);
  const r = await call('POST', `/jobs/${job}/cancel`, { reason: 'Went with another contractor' });
  assert.equal(r.status, 200);
  assert.equal(r.data.visits, 1); assert.equal(r.data.estimates, 1); assert.equal(r.data.purchase_orders, 1); assert.deepEqual(r.data.warnings, []);
  const j = (await call('GET', `/jobs/${job}`)).data;
  assert.equal(j.status, 'cancelled'); assert.equal(j.cancel_reason, 'Went with another contractor'); assert.ok(j.cancelled_at);
  assert.match(j.notes[0].body, /cancelled: Went with another/);
  assert.equal(db.prepare('SELECT status FROM estimates WHERE id = ?').get(est).status, 'cancelled');
  assert.equal(db.prepare('SELECT status FROM purchase_orders WHERE id = ?').get(po).status, 'cancelled');
  assert.equal((await call('POST', `/jobs/${job}/cancel`, {})).status, 400);
  // can't sneak it back to "scheduled" from the dropdown
  assert.equal((await call('PUT', `/jobs/${job}`, { status: 'scheduled' })).status, 400);

  const re = await call('POST', `/jobs/${job}/reopen`);
  assert.equal(re.status, 200);
  const j2 = db.prepare('SELECT * FROM jobs WHERE id = ?').get(job);
  assert.equal(j2.status, 'unscheduled'); assert.equal(j2.cancel_reason, null);
});

test('setting the status to cancelled goes through the same cancel steps; open invoices are flagged', async () => {
  const job = await newJob();
  await call('POST', `/jobs/${job}/materials`, { description: 'Wire', qty: 10, unit_cost: 1, unit_price: 2 });
  const inv = await call('POST', `/jobs/${job}/invoice`, {});
  assert.equal(inv.status, 200);
  const r = await call('PUT', `/jobs/${job}`, { status: 'cancelled', cancel_reason: 'Duplicate' });
  assert.equal(r.status, 200);
  const j = db.prepare('SELECT * FROM jobs WHERE id = ?').get(job);
  assert.equal(j.status, 'cancelled'); assert.equal(j.cancel_reason, 'Duplicate');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM appointments WHERE job_id = ? AND status != 'cancelled'").get(job).n, 0);
  // and the direct route reports what still needs a person
  const job2 = await newJob();
  await call('POST', `/jobs/${job2}/materials`, { description: 'Wire', qty: 1, unit_cost: 1, unit_price: 2 });
  await call('POST', `/jobs/${job2}/invoice`, {});
  const c = await call('POST', `/jobs/${job2}/cancel`, { reason: 'x' });
  assert.equal(c.data.warnings.length, 1); assert.match(c.data.warnings[0], /invoice/);
});

test('deleting a job: admin only, refused when it has history, removes photos when allowed', async () => {
  const keep = await newJob();
  await call('POST', `/jobs/${keep}/materials`, { description: 'Wire', qty: 1, unit_cost: 1, unit_price: 2 });
  const blocked = await call('DELETE', `/jobs/${keep}`);
  assert.equal(blocked.status, 400); assert.match(blocked.data.error, /material line.*Cancel it instead/);
  assert.deepEqual((await call('GET', `/jobs/${keep}`)).data.delete_blockers, ['1 material line(s)']);

  const job = await newJob();
  const est = await newEst({ job_id: job });
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const att = (await call('POST', '/attachments', { entity_type: 'job', entity_id: job, data: png, filename: 'a.png' })).data.id;
  const file = path.join(process.env.UPLOAD_DIR, db.prepare('SELECT path FROM attachments WHERE id = ?').get(att).path);
  assert.ok(fs.existsSync(file));
  assert.equal((await call('DELETE', `/jobs/${job}`, null, techTok)).status, 403);
  const r = await call('DELETE', `/jobs/${job}`);
  assert.equal(r.status, 200); assert.equal(r.data.files, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM jobs WHERE id = ?').get(job).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM attachments WHERE id = ?').get(att).n, 0);
  assert.ok(!fs.existsSync(file));
  assert.equal(db.prepare('SELECT job_id FROM estimates WHERE id = ?').get(est).job_id, null); // the estimate survives, unlinked
});

test('cancelling an estimate: customer can no longer sign, not counted as lost, reopen needs a fresh signature', async () => {
  const id = await newEst();
  const tokn = db.prepare('SELECT public_token FROM estimates WHERE id = ?').get(id).public_token;
  await call('PUT', `/estimates/${id}`, { status: 'sent' });
  const r = await call('POST', `/estimates/${id}/cancel`, { reason: 'Re-quoted' });
  assert.equal(r.status, 200);
  const e = (await call('GET', `/estimates/${id}`)).data;
  assert.equal(e.status, 'cancelled'); assert.equal(e.cancel_reason, 'Re-quoted');
  const sign = await call('POST', `/public/estimate/${tokn}/respond`, { decision: 'approve', signature_name: 'Jordan' }, null);
  assert.equal(sign.status, 400); assert.match(sign.data.error, /withdrawn/);
  assert.equal((await call('PUT', `/estimates/${id}`, { title: 'x' })).status, 400);
  assert.equal((await call('POST', `/estimates/${id}/send`, {})).status, 400);
  assert.equal((await call('POST', `/estimates/${id}/convert-to-invoice`, {})).status, 400);
  const yr = new Date().getFullYear();
  const rep = (await call('GET', `/reports/estimates?from=${yr}-01-01&to=${yr}-12-31`)).data;
  assert.equal(rep.declined, 0); assert.equal(rep.sent, 0); // withdrawn quotes don't drag down the close rate

  assert.equal((await call('POST', `/estimates/${id}/reopen`)).status, 200);
  assert.equal(db.prepare('SELECT status FROM estimates WHERE id = ?').get(id).status, 'draft');
});

test('approved estimates: cancel (not delete), and only once their invoices are voided', async () => {
  const id = await newEst();
  await call('PUT', `/estimates/${id}`, { status: 'approved' });
  const del = await call('DELETE', `/estimates/${id}`);
  assert.equal(del.status, 400); assert.match(del.data.error, /Cancel it instead/);
  const inv = (await call('POST', `/estimates/${id}/convert-to-invoice`, {})).data.id;
  const c1 = await call('POST', `/estimates/${id}/cancel`, {});
  assert.equal(c1.status, 400); assert.match(c1.data.error, /Void them first/);
  await call('PUT', `/invoices/${inv}`, { status: 'void' });
  const c2 = await call('POST', `/estimates/${id}/cancel`, {});
  assert.equal(c2.status, 200); assert.equal(c2.data.was_approved, true);
  await call('POST', `/estimates/${id}/reopen`);
  const e = db.prepare('SELECT * FROM estimates WHERE id = ?').get(id);
  assert.equal(e.status, 'draft'); assert.equal(e.approved_at, null);
});

test('deleting a draft estimate still works; a tech cannot cancel', async () => {
  const id = await newEst();
  assert.equal((await call('POST', `/estimates/${id}/cancel`, {}, techTok)).status, 403);
  assert.equal((await call('DELETE', `/estimates/${id}`)).status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM estimates WHERE id = ?').get(id).n, 0);
});

test('upgrading an existing database keeps estimate lines, options and invoice links', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fo-mig-')), 'old.db');
  let d = D.open(file);
  const c = d.prepare("INSERT INTO customers (name) VALUES ('Old')").run().lastInsertRowid;
  const e = d.prepare("INSERT INTO estimates (number, customer_id, public_token, status) VALUES ('EST-9', ?, 't9', 'sent')").run(c).lastInsertRowid;
  d.prepare("INSERT INTO estimate_options (estimate_id, name) VALUES (?, 'Good')").run(e);
  d.prepare("INSERT INTO estimate_items (estimate_id, description, qty, unit_price) VALUES (?, 'Panel', 1, 100)").run(e);
  d.prepare("INSERT INTO invoices (number, customer_id, estimate_id, public_token) VALUES ('INV-9', ?, ?, 'i9')").run(c, e);
  // pretend this database is from before the change: old CHECK, version 9
  d.exec('PRAGMA writable_schema = ON');
  d.prepare("UPDATE sqlite_master SET sql = replace(sql, ',''cancelled'')', ')') WHERE name = 'estimates'").run();
  d.exec('PRAGMA writable_schema = OFF');
  d.prepare('UPDATE schema_version SET version = version - 1').run();
  d.close();
  const raw = new DatabaseSync(file);
  assert.ok(!/'cancelled'/.test(raw.prepare("SELECT sql FROM sqlite_master WHERE name = 'estimates'").get().sql));
  raw.close();

  d = D.open(file);
  assert.ok(/'cancelled'/.test(d.prepare("SELECT sql FROM sqlite_master WHERE name = 'estimates'").get().sql));
  assert.equal(d.prepare('SELECT COUNT(*) n FROM estimate_items WHERE estimate_id = ?').get(e).n, 1);
  assert.equal(d.prepare('SELECT COUNT(*) n FROM estimate_options WHERE estimate_id = ?').get(e).n, 1);
  assert.equal(d.prepare('SELECT estimate_id FROM invoices').get().estimate_id, e);
  assert.equal(d.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  assert.deepEqual(d.prepare('PRAGMA foreign_key_check').all(), []);
  d.prepare("UPDATE estimates SET status = 'cancelled' WHERE id = ?").run(e);
  // child rows still cascade from the rebuilt table
  d.prepare('DELETE FROM invoices').run();
  d.prepare('DELETE FROM estimates WHERE id = ?').run(e);
  assert.equal(d.prepare('SELECT COUNT(*) n FROM estimate_items').get().n, 0);
  d.close();
});
