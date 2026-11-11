'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const D = require('../server/db');
const { createApp } = require('../server/app');
const { xlsx } = require('./_xlsx');

let server, base, db; const tok = {};
async function call(who, method, p, body) {
  const res = await fetch(base + '/api' + p, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok[who] }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json() };
}
// made-up bids in the workbook's DATA layout: row 1 headers, row 2 contractor names, bids from row 3
const H = { A1: 'Bid Due Date', B1: 'Bid Number', C1: 'Project Name', D1: 'Contractor', G1: 'Date Submitted', H1: 'Bid Value', I1: 'Status', J1: 'Check in', D2: 'Alpha GC', E2: 'Beta Build', F2: 'Gamma Co' };
const wb = rows => xlsx({ DATA: { ...H, ...rows }, CALCS: { A1: 'Bids Submitted' } }).toString('base64');
const ROWS = {
  A3: 46200, B3: 9001, C3: 'Test Clinic TI', D3: 'X', G3: 46200, H3: 100000, I3: 'Awarded',
  A4: 46210, B4: 9002, C4: 'Test Warehouse', D4: 'X', E4: 'X', G4: 46210, H4: 50000, I4: 'Lost', J4: 'GC not awarded',
  A5: 46220, B5: 9003, C5: 'Test Shop', F5: 'X', G5: 46220, H5: 30000, I5: 'Waiting',
  A6: 46225, B6: 9004, C6: 'Test School', E6: 'X', I6: 'No Bid',
  A7: 46400, B7: 9005, C7: 'Test Future Bid', F7: 'X',
};

before(async () => {
  db = D.open(':memory:');
  server = createApp(db).listen(0); await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  tok.admin = (await (await fetch(base + '/api/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Owner', email: 'o@x.com', password: 'longenough' }) })).json()).token;
  for (const [role, email] of [['manager', 'm@x.com'], ['office', 'f@x.com'], ['tech', 't@x.com']]) {
    await call('admin', 'POST', '/users', { name: role, email, password: 'password123', role });
    tok[role] = (await (await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'password123' }) })).json()).token;
  }
});
after(() => server.close());

test('only admins and managers can see it', async () => {
  assert.equal((await call('admin', 'GET', '/estimating')).status, 200);
  assert.equal((await call('manager', 'GET', '/estimating')).status, 200);
  assert.equal((await call('office', 'GET', '/estimating')).status, 403);
  assert.equal((await call('tech', 'GET', '/estimating')).status, 403);
  assert.equal((await call('office', 'POST', '/estimating/bids', { project_name: 'x' })).status, 403);
});

test('import the workbook, the totals match the sheet, re-import updates', async () => {
  const r = await call('manager', 'POST', '/estimating/import', { file: wb(ROWS) });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual([r.data.created, r.data.updated, r.data.gcs], [5, 0, 3]);
  const d = (await call('admin', 'GET', '/estimating?today=2026-06-01')).data;
  assert.equal(d.totals.submitted, 3, 'COUNTA of Date Submitted');
  assert.equal(d.totals.submitted_value, 180000);
  assert.equal(d.totals.awarded_value, 100000); assert.equal(d.totals.waiting_value, 30000);
  assert.equal(d.totals.win_rate, 50, '1 awarded of 2 decided');
  const fut = d.bids.find(b => b.bid_number === '9005');
  assert.equal(fut.status, 'estimating'); assert.equal(fut.due_date, '2027-01-13');
  assert.deepEqual(d.bids.find(b => b.bid_number === '9002').gcs.map(g => g.name), ['Alpha GC', 'Beta Build']);
  const beta = d.gcs.find(g => g.name === 'Beta Build');
  assert.deepEqual([beta.bids, beta.sent, beta.sent_value, beta.lost], [2, 1, 50000, 1]);
  assert.ok(d.upcoming.some(u => u.id === fut.id));
  // the waiting bid went out 2026-07-17; by Aug 10 it needs a check-in
  const later = (await call('admin', 'GET', '/estimating?today=2026-08-10')).data;
  assert.deepEqual(later.check_in.map(id => later.bids.find(b => b.id === id).bid_number), ['9003']);
  // same file with one change: updates, no copies
  const again = await call('admin', 'POST', '/estimating/import', { file: wb({ ...ROWS, I5: 'Awarded' }) });
  assert.deepEqual([again.data.created, again.data.updated], [0, 5]);
  assert.equal((await call('admin', 'GET', '/estimating')).data.totals.awarded_value, 130000);
});

test('add and edit a bid; a submitted date moves it to waiting; notes stamp the check-in', async () => {
  const gc = (await call('admin', 'GET', '/estimating')).data.all_gcs[0];
  const n = (await call('admin', 'GET', '/estimating')).data.next_number;
  assert.equal(n, '9006');
  const { id } = (await call('manager', 'POST', '/estimating/bids', { project_name: 'Test Retail', bid_number: n, due_date: '2026-12-01', gc_ids: [gc.id] })).data;
  assert.equal((await call('admin', 'POST', '/estimating/bids', { project_name: 'Dup', bid_number: n })).status, 400);
  await call('manager', 'PUT', `/estimating/bids/${id}`, { submitted_date: '2026-11-30', bid_value: '$12,500', notes: 'Called PM' });
  const b = (await call('admin', 'GET', '/estimating')).data.bids.find(x => x.id === id);
  assert.equal(b.status, 'waiting'); assert.equal(b.bid_value, 12500); assert.ok(b.checked_in_at); assert.equal(b.gcs[0].id, gc.id);
  assert.equal((await call('admin', 'DELETE', `/estimating/bids/${id}`)).status, 200);
});
