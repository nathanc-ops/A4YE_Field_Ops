'use strict';
// Files on commercial bids: Drive-template folders, PDF/Word/Excel only, move/rename/delete. Made-up data only.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bidfiles-'));
process.env.UPLOAD_DIR = tmp;
const D = require('../server/db');
const { createApp } = require('../server/app');
const BF = require('../server/bid_files');

let server, base, db; const tok = {};
async function call(who, method, p, body) {
  const res = await fetch(base + '/api' + p, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok[who] }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => null) };
}
async function upload(who, bid, folder, filename, buf) {
  const res = await fetch(`${base}/api/estimating/bids/${bid}/files?folder=${encodeURIComponent(folder)}&filename=${encodeURIComponent(filename)}`, { method: 'POST',
    headers: { Authorization: 'Bearer ' + tok[who], 'Content-Type': 'application/octet-stream' }, body: buf });
  return { status: res.status, data: await res.json() };
}
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');
const zip = inner => Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(26), Buffer.from(inner)]);
const DOCX = zip('[Content_Types].xml word/document.xml'), XLSX = zip('[Content_Types].xml xl/workbook.xml');
const OLE = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(504)]);

before(async () => {
  db = D.open(':memory:');
  server = createApp(db).listen(0); await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  tok.admin = (await call(null, 'POST', '/setup', { name: 'Owner', email: 'o@example.com', password: 'longenough' })).data.token;
  await call('admin', 'POST', '/users', { name: 'Desk', email: 'd@example.com', password: 'password123', role: 'office' });
  tok.office = (await call(null, 'POST', '/login', { email: 'd@example.com', password: 'password123' })).data.token;
});
after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('a bid starts with the Drive template folders', async () => {
  const bid = (await call('admin', 'POST', '/estimating/bids', { project_name: 'Sample Clinic TI', bid_number: '9001' })).data.id;
  const r = (await call('admin', 'GET', `/estimating/bids/${bid}/files`)).data;
  assert.ok(r.folders.includes('001 - Precon/003 - Estimate'));
  assert.ok(r.folders.includes('004 - Project Docs/003 - Submittals/01 - APPROVED'));
  assert.equal(r.folders.filter(f => !f.includes('/')).length, 8, '001 … 008 at the top');
  assert.deepEqual(r.files, []);
  assert.equal((await call('office', 'GET', `/estimating/bids/${bid}/files`)).status, 403, 'admins and managers only, like estimating');
});

test('PDF, Word and Excel go in; anything else is refused; files open with their own name', async () => {
  const bid = (await call('admin', 'POST', '/estimating/bids', { project_name: 'Sample Warehouse', bid_number: '9002' })).data.id;
  assert.equal((await upload('admin', bid, '001 - Precon/001 - Customer Supplied Documents', 'E-sheets.pdf', PDF)).data.mime, 'application/pdf');
  assert.match((await upload('admin', bid, '001 - Precon/004 - Proposal', 'Proposal.docx', DOCX)).data.mime, /wordprocessingml/);
  assert.match((await upload('admin', bid, '001 - Precon/003 - Estimate', 'Takeoff.xlsx', XLSX)).data.mime, /spreadsheetml/);
  assert.equal((await upload('admin', bid, '001 - Precon/002 - Vendor Quotes', 'Old quote.xls', OLE)).data.mime, 'application/vnd.ms-excel');
  assert.equal((await upload('admin', bid, '001 - Precon/002 - Vendor Quotes', 'Letter.doc', OLE)).data.mime, 'application/msword');
  const exe = await upload('admin', bid, '001 - Precon/005 - RFI', 'setup.exe', Buffer.from('MZ\x90\x00 not a document'));
  assert.equal(exe.status, 400); assert.match(exe.data.error, /only PDF, Word/);
  const sneaky = await upload('admin', bid, '001 - Precon/005 - RFI', 'notes.pdf', Buffer.from('<html>not really a pdf</html>'));
  assert.equal(sneaky.status, 400, 'checked by content, not by name');
  const esc = await upload('admin', bid, '../../etc', 'x.pdf', PDF);
  assert.equal(esc.status, 200); assert.equal(esc.data.folder, 'etc', '".." is stripped from folder paths');

  const list = (await call('admin', 'GET', `/estimating/bids/${bid}/files`)).data;
  assert.equal(list.files.length, 6);
  const pdf = list.files.find(f => f.filename === 'E-sheets.pdf');
  const res = await fetch(`${base}/api/estimating/bids/${bid}/files/${pdf.id}`, { headers: { Authorization: 'Bearer ' + tok.admin } });
  assert.equal(res.status, 200); assert.equal(res.headers.get('content-type'), 'application/pdf');
  assert.match(res.headers.get('content-disposition'), /inline; filename\*=UTF-8''E-sheets\.pdf/);
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), PDF);
  const xl = list.files.find(f => f.filename === 'Takeoff.xlsx');
  const r2 = await fetch(`${base}/api/estimating/bids/${bid}/files/${xl.id}`, { headers: { Authorization: 'Bearer ' + tok.admin } });
  assert.match(r2.headers.get('content-disposition'), /^attachment/, 'Office files download');
  // the bid list shows how many files it has
  const bids = (await call('admin', 'GET', '/estimating')).data;
  assert.equal(bids.bids.find(b => b.id === bid).file_count, 6);
});

test('move, rename (keeps the extension), extra folders, delete; deleting the bid removes its files', async () => {
  const bid = (await call('admin', 'POST', '/estimating/bids', { project_name: 'Sample School', bid_number: '9003' })).data.id;
  const id = (await upload('admin', bid, '004 - Project Docs/003 - Submittals/00 - PENDING', 'Panel submittal.pdf', PDF)).data.id;
  await call('admin', 'PUT', `/estimating/bids/${bid}/files/${id}`, { folder: '004 - Project Docs/003 - Submittals/01 - APPROVED' });
  const rn = (await call('admin', 'PUT', `/estimating/bids/${bid}/files/${id}`, { filename: 'Panel submittal - approved' })).data;
  assert.equal(rn.filename, 'Panel submittal - approved.pdf');
  await call('admin', 'POST', `/estimating/bids/${bid}/folders`, { folder: '001 - Precon/005 - RFI/Addenda' });
  const r = (await call('admin', 'GET', `/estimating/bids/${bid}/files`)).data;
  assert.ok(r.folders.includes('001 - Precon/005 - RFI/Addenda'));
  assert.equal(r.files[0].folder, '004 - Project Docs/003 - Submittals/01 - APPROVED');
  const stored = db.prepare('SELECT path FROM bid_files WHERE id = ?').get(id).path;
  assert.ok(fs.existsSync(path.join(tmp, stored)));
  await call('admin', 'DELETE', `/estimating/bids/${bid}`);
  assert.equal(fs.existsSync(path.join(tmp, stored)), false, 'stored file removed with the bid');
  assert.equal(db.prepare('SELECT count(*) n FROM bid_files WHERE bid_id = ?').get(bid).n, 0);
});

test('the folder template can be changed in Settings; a project finds its bid', async () => {
  await call('admin', 'PUT', '/settings', { bid_folder_template: '01. Bid Drawings\n02. Bid Specs\n03. Bid Docs & Reports\nRFI Responses' });
  const bid = (await call('admin', 'POST', '/estimating/bids', { project_name: 'Sample Office', bid_number: '9004' })).data.id;
  assert.deepEqual((await call('admin', 'GET', `/estimating/bids/${bid}/files`)).data.folders, ['01. Bid Drawings', '02. Bid Specs', '03. Bid Docs & Reports', 'RFI Responses']);
  const cust = (await call('admin', 'POST', '/customers', { name: 'Sample GC', type: 'commercial' })).data.id;
  const job = (await call('admin', 'POST', '/jobs', { customer_id: cust, title: 'Sample Office build-out', is_project: 1 })).data.id;
  await call('admin', 'PUT', `/estimating/bids/${bid}`, { job_id: job });
  assert.equal((await call('admin', 'GET', `/estimating/bid-for-job/${job}`)).data.id, bid);
  assert.equal(BF.cleanFolder(' a / ../b /c '), 'a/b/c');
});

test('adding a folder with the same name merges into it (any letter case); a same-named file is replaced', async () => {
  await call('admin', 'PUT', '/settings', { bid_folder_template: '' });   // back to the Drive template
  const bid = (await call('admin', 'POST', '/estimating/bids', { project_name: 'Sample Lab', bid_number: '9005' })).data.id;
  const first = await upload('admin', bid, '001 - Precon/003 - Estimate', 'Takeoff.pdf', PDF);
  const oldPath = db.prepare('SELECT path FROM bid_files WHERE id = ?').get(first.data.id).path;
  // a whole folder dropped at the top level, named like the template folder but in other letter case, with a new subfolder
  const mk = (await call('admin', 'POST', `/estimating/bids/${bid}/folders`, { folders: ['001 - PRECON', '001 - PRECON/003 - estimate', '001 - PRECON/Site Photos'] })).data;
  assert.deepEqual(mk.folders, ['001 - Precon', '001 - Precon/003 - Estimate', '001 - Precon/Site Photos']);
  const again = await upload('admin', bid, '001 - PRECON/003 - estimate', 'takeoff.PDF', Buffer.concat([PDF, Buffer.from('v2')]));
  assert.equal(again.data.replaced, true); assert.equal(again.data.id, first.data.id);
  assert.equal(again.data.folder, '001 - Precon/003 - Estimate', 'went into the existing folder');
  const r = (await call('admin', 'GET', `/estimating/bids/${bid}/files`)).data;
  assert.equal(r.files.length, 1, 'replaced, not duplicated');
  assert.equal(r.files[0].filename, 'takeoff.PDF'); assert.equal(r.files[0].size, PDF.length + 2);
  assert.equal(fs.existsSync(path.join(tmp, oldPath)), false, 'the old copy is removed from disk');
  assert.ok(r.folders.includes('001 - Precon/Site Photos'));
  assert.equal(r.folders.filter(f => f.toLowerCase() === '001 - precon').length, 1, 'no second Precon folder');
  // a different name in the same folder is added alongside
  await upload('admin', bid, '001 - Precon/003 - Estimate', 'Takeoff rev B.pdf', PDF);
  assert.equal((await call('admin', 'GET', `/estimating/bids/${bid}/files`)).data.files.length, 2);
});
