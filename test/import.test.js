'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fo-imp-'));
const D = require('../server/db');
const I = require('../server/importer');
const { createApp } = require('../server/app');

let server, base, db, tok;
async function call(method, p, body, token = tok) {
  const res = await fetch(base + '/api' + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json() };
}
const imp = (type, csv, extra = {}) => call('POST', '/import/run', { type, csv, filename: type + '.csv', ...extra });

before(async () => {
  db = D.open(':memory:');
  server = createApp(db).listen(0);
  await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  tok = (await call('POST', '/setup', { name: 'Owner', email: 'o@x.com', password: 'longenough' })).data.token;
  await call('POST', '/users', { name: 'Mike Reyes', email: 'mike@x.com', password: 'password123', role: 'tech' });
});
after(() => server.close());

test('parsing: delimiters, BOM, quoted commas, dates, money', () => {
  assert.deepEqual(I.parseRows('﻿Name\tPhone\nA\t1\n'), [['Name', 'Phone'], ['A', '1']]);
  assert.deepEqual(I.parseRows('a,b\n"x, y","say ""hi"""\n'), [['a', 'b'], ['x, y', 'say "hi"']]);
  assert.equal(I.parseDate('11/3/2026 2:15 PM'), '2026-11-03');
  assert.equal(I.parseDate('Nov 3, 2026'), '2026-11-03');
  assert.equal(I.parseDateTime('11/12/2026 2:30 PM', 300), '2026-11-12T19:30:00.000Z'); // US Central-ish offset
  assert.equal(I.parseAmount('($1,250.50)'), -1250.5);
  const m = I.autoMap(['Customer Name', 'E-mail', 'Mobile Phone', 'Service Address', 'Zip Code'], I.TYPES.customers.fields);
  assert.equal(m.name, 'Customer Name'); assert.equal(m.email, 'E-mail'); assert.equal(m.phone, 'Mobile Phone'); assert.equal(m.address, 'Service Address'); assert.equal(m.zip, 'Zip Code');
});

test('customers: test run changes nothing, real run creates, re-import matches instead of duplicating', async () => {
  const csv = 'Customer ID,First Name,Last Name,Company,Email,Phone,Service Address,City,State,Zip,Type,Lead Source\n' +
    'C100,Jordan,Smith,,jordan@ex.com,(208) 555-0101,12 Oak St,Boise,ID,83702,Residential,Google\n' +
    'C101,,,Riverside Plaza LLC,ap@riverside.com,208-555-0199,400 Main St,Boise,ID,83702,Commercial,Referral\n' +
    'C102,,,,,,,,,,,\n';
  const pre = await call('POST', '/import/preview', { type: 'customers', csv });
  assert.equal(pre.data.row_count, 3); assert.equal(pre.data.mapping.external_id, 'Customer ID');
  const dry = await imp('customers', csv, { dry_run: true });
  assert.equal(dry.status, 200); assert.equal(dry.data.created.customer, 2); assert.equal(dry.data.error_count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM customers').get().n, 0);
  const real = await imp('customers', csv);
  assert.equal(real.data.created.customer, 2); assert.equal(real.data.created.location, 2); assert.ok(real.data.batch_id);
  const plaza = db.prepare("SELECT * FROM customers WHERE external_id = 'C101'").get();
  assert.equal(plaza.type, 'commercial'); assert.equal(plaza.name, 'Riverside Plaza LLC');
  const again = await imp('customers', 'Name,Phone,Notes\nJordan Smith,208.555.0101,Gate code 4411\n');
  assert.equal(again.data.created_total, 0); assert.equal(again.data.updated, 1);
  assert.equal(db.prepare("SELECT notes FROM customers WHERE external_id = 'C100'").get().notes, 'Gate code 4411');
});

test('jobs link to customers, keep old numbers, assign techs and land on the board', async () => {
  const soon = new Date(Date.now() + 3 * 864e5); const us = `${soon.getMonth() + 1}/${soon.getDate()}/${soon.getFullYear()}`;
  const csv = 'Job #,Customer ID,Customer Name,Summary,Job Type,Status,Scheduled Date,Completed Date,Technician,Contract Amount\n' +
    `5001,C100,,Panel upgrade 200A,Install,Completed,10/02/2026 8:00 AM,10/02/2026,Mike Reyes,4200\n` +
    `5002,,New Person,Troubleshoot dead outlets,Service,Scheduled,${us} 9:30 AM,,"Mike, Zed",\n` +
    `5001,C100,,dup,,,,,,\n`;
  const r = await imp('jobs', csv, { options: { tz_offset: 0 } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.created.job, 2); assert.equal(r.data.created.customer, 1); assert.equal(r.data.skipped, 1);
  assert.ok(r.data.warnings.some(w => /Zed/.test(w.message)));
  const j1 = db.prepare("SELECT * FROM jobs WHERE number = '5001'").get();
  assert.equal(j1.status, 'completed'); assert.equal(j1.billing_type, 'fixed'); assert.equal(j1.contract_amount, 4200);
  const j2 = db.prepare("SELECT * FROM jobs WHERE number = '5002'").get();
  assert.equal(j2.status, 'scheduled');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM appointments WHERE job_id = ?').get(j2.id).n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM job_techs WHERE job_id = ?').get(j2.id).n, 1);
  // our own numbering skips past anything imported with the same prefix
  db.prepare("INSERT INTO jobs (number, customer_id, title) VALUES ('J-7000', ?, 'x')").run(j1.customer_id);
  assert.equal(D.nextNumber(db, 'jobs', 'J'), 'J-7001');
  db.prepare("DELETE FROM jobs WHERE number = 'J-7000'").run();
});

test('invoices: line rows group by number, payments recorded, kept off the books by default', async () => {
  const csv = 'Invoice #,Job #,Invoice Date,Item,Qty,Rate,Tax Amount,Total,Amount Paid,Paid Date,Payment Method\n' +
    '9001,5001,10/03/2026,200A panel upgrade,1,4000,,4200,4200,10/10/2026,Check\n' +
    '9001,5001,10/03/2026,Permit fee,1,200,,4200,4200,10/10/2026,Check\n' +
    '9002,5002,10/20/2026,,,,8.00,108.00,50,,Visa\n';
  const r = await imp('invoices', csv);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.created.invoice, 2); assert.equal(r.data.created.payment, 2); assert.equal(r.data.error_count, 0, JSON.stringify(r.data.errors));
  const i1 = db.prepare("SELECT * FROM invoices WHERE number = '9001'").get();
  assert.equal(i1.status, 'paid'); assert.equal(db.prepare('SELECT COUNT(*) n FROM invoice_items WHERE invoice_id = ?').get(i1.id).n, 2);
  const i2 = (await call('GET', '/invoices/' + db.prepare("SELECT id FROM invoices WHERE number = '9002'").get().id)).data;
  assert.equal(i2.status, 'partial'); assert.equal(i2.total, 108); assert.equal(i2.balance, 58);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM journal_entries WHERE source_type IN ('invoice','payment')").get().n, 0);
  // a payment taken today on an imported open invoice does post (AR came in with the opening balance)
  await call('POST', `/invoices/${i2.id}/payments`, { amount: 58, method: 'check' });
  assert.equal(db.prepare("SELECT COUNT(*) n FROM journal_entries WHERE source_type = 'payment'").get().n, 1);
  // same file again: nothing new
  const again = await imp('invoices', csv);
  assert.equal(again.data.created_total, 0); assert.equal(again.data.skipped, 2);
});

test('estimates with good/better/best options', async () => {
  const csv = 'Estimate #,Customer Name,Name,Status,Option,Item,Qty,Price\n' +
    'Q-1,Jordan Smith,EV charger,Sold,Good,Level 2 charger install,1,1200\nQ-1,Jordan Smith,EV charger,Sold,Better,Charger + load mgmt,1,1800\nQ-1,Jordan Smith,EV charger,Sold,Better,Surge protector,1,350\n';
  const r = await imp('estimates', csv);
  assert.equal(r.data.created.estimate, 1, JSON.stringify(r.data));
  const e = db.prepare("SELECT * FROM estimates WHERE number = 'Q-1'").get();
  assert.equal(e.status, 'approved');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM estimate_options WHERE estimate_id = ?').get(e.id).n, 2);
});

test('notes, price book and job materials', async () => {
  const n = await imp('notes', 'Job #,Note,Date,Author\n5001,Customer wants old panel hauled away,10/01/2026,Mike Reyes\n,Prefers texts,10/01/2026,Office\n9999,orphan,,\n');
  assert.equal(n.data.created.job_note, 1); assert.equal(n.data.error_count, 2); // no job 9999; customer-less row
  const pb = await imp('pricebook', 'SKU,Name,Type,Cost,Price,On Hand\nTHQL2120,20A 1P breaker,Inventory,8.25,24,40\nTHQL2120,20A 1P breaker,Inventory,8.50,25,\n');
  assert.equal(pb.data.created.pricebook, 1); assert.equal(pb.data.updated, 1);
  assert.equal(db.prepare("SELECT unit_cost FROM pricebook WHERE code = 'THQL2120'").get().unit_cost, 8.5);
  const m = await imp('job_materials', 'Job #,SKU,Qty,Date\n5001,THQL2120,4,10/02/2026\n5002,,2,\n');
  assert.equal(m.data.created.job_material, 1); assert.equal(m.data.error_count, 1);
  const row = db.prepare("SELECT * FROM job_materials WHERE source = 'imported'").get();
  assert.equal(row.invoice_id, -1); assert.equal(row.unit_cost, 8.5); // finished job → already billed
  assert.equal(db.prepare("SELECT qty_on_hand FROM pricebook WHERE code = 'THQL2120'").get().qty_on_hand, 40); // stock untouched
});

test('accounting: chart of accounts, opening balances, journal entries', async () => {
  const acc = await imp('accounts', 'Account,Type,Number\nTruck Loan - Ford,Long Term Liability,\nChecking - US Bank,Bank,1000\nSales Tax Payable,Other Current Liability,\n');
  assert.equal(acc.data.created.account, 1, JSON.stringify(acc.data)); // Sales Tax Payable already exists
  assert.equal(db.prepare("SELECT number FROM accounts WHERE name = 'Truck Loan - Ford'").get().number, '2800');
  assert.ok(acc.data.warnings.some(w => /1000 is already/.test(w.message))); // our checking account keeps its number
  const ob = await imp('opening_balances', 'Account,Debit,Credit\n1000 Checking,25000,\n1200,12000,\nTruck Loan - Ford,,30000\n', { options: { as_of: '2026-09-30' } });
  assert.equal(ob.status, 200, JSON.stringify(ob.data)); assert.equal(ob.data.created.journal_entry, 1);
  const obe = db.prepare("SELECT SUM(credit - debit) v FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id WHERE a.number = '3950'").get().v;
  assert.equal(obe, 7000);
  const missing = await imp('opening_balances', 'Account,Balance\nNope Account,5\n', { options: { as_of: '2026-09-30' } });
  assert.equal(missing.data.error_count, 1);
  const je = await imp('journal', 'Num,Date,Account,Debit,Credit,Memo\n77,10/05/2026,6100,500,,Insurance\n77,10/05/2026,1000,,500,\n78,10/06/2026,6100,10,,bad\n78,10/06/2026,1000,,9,\n');
  assert.equal(je.data.created.journal_entry, 1); assert.equal(je.data.error_count, 1);
  assert.match(je.data.errors[0].message, /balance/);
});

test('photos match jobs by folder or file name; undo removes a batch', async () => {
  const png = 'data:image/png;base64,' + Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]).toString('base64');
  const m = await call('POST', '/import/photos/match', { paths: ['Jobs/5001/before 1.jpg', 'Jobs/5002 - New Person_after.png', 'Random/x.jpg', 'Jordan Smith/panel.jpg'] });
  assert.deepEqual(m.data.map(x => x.target && x.target.label), ['5001', '5002', null, 'Jordan Smith']);
  const { batch_id } = (await call('POST', '/import/photos/start', { folder: 'Jobs' })).data;
  const up = await call('POST', '/import/photos', { batch_id, path: 'Jobs/5001/before 1.png', filename: 'before 1.png', data: png });
  assert.equal(up.data.ok, true);
  const att = db.prepare('SELECT * FROM attachments WHERE id = ?').get(up.data.id);
  assert.equal(att.tag, 'before'); assert.ok(fs.existsSync(path.join(process.env.UPLOAD_DIR, att.path)));
  const miss = await call('POST', '/import/photos', { batch_id, path: 'Random/x.png', filename: 'x.png', data: png });
  assert.equal(miss.data.ok, false);
  await call('POST', `/import/batches/${batch_id}/undo`);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM attachments').get().n, 0);
  assert.ok(!fs.existsSync(path.join(process.env.UPLOAD_DIR, att.path)));
});

test('undo is refused once imported records are in use, and works otherwise', async () => {
  const b = (await call('GET', '/import/batches')).data;
  const custBatch = b.find(x => x.type === 'customers' && x.created_count > 0);
  // jobs were imported onto these customers, so the customers can't simply disappear
  const r = await call('POST', `/import/batches/${custBatch.id}/undo`);
  assert.equal(r.status, 409);
  const est = b.find(x => x.type === 'estimates');
  assert.equal((await call('POST', `/import/batches/${est.id}/undo`)).status, 200);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM estimates WHERE number = 'Q-1'").get().n, 0);
  assert.equal((await call('POST', `/import/batches/${est.id}/undo`)).status, 400);
});

test('only admins can import', async () => {
  const t = (await call('POST', '/login', { email: 'mike@x.com', password: 'password123' })).data.token;
  assert.equal((await call('POST', '/import/run', { type: 'customers', csv: 'Name\nX\n' }, t)).status, 403);
});
