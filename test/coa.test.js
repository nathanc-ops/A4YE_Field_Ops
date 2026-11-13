'use strict';
// Chart of accounts: rename, renumber, delete rules.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const D = require('../server/db');
const { createApp } = require('../server/app');

let server, base, tok;
async function call(method, path, body) {
  const res = await fetch(base + '/api' + path, { method, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json() };
}
const acct = async n => (await call('GET', '/accounts?all=1')).data.find(a => a.number === n);

before(async () => {
  server = createApp(D.open(':memory:')).listen(0);
  await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  tok = (await call('POST', '/setup', { name: 'Owner', email: 'o@x.com', password: 'longenough' })).data.token;
});
after(() => server.close());

test('system accounts: rename yes; renumber, retype, deactivate and delete no', async () => {
  const chk = await acct('1000');
  assert.equal(chk.system, true);
  let r = await call('PUT', '/accounts/' + chk.id, { number: '1000', name: 'MACU Business Checking' });
  assert.equal(r.status, 200); assert.equal(r.data.name, 'MACU Business Checking');
  r = await call('PUT', '/accounts/' + chk.id, { number: '1010' });
  assert.equal(r.status, 400); assert.match(r.data.error, /number can't change/);
  r = await call('PUT', '/accounts/' + chk.id, { type: 'expense' });
  assert.equal(r.status, 400);
  r = await call('PUT', '/accounts/' + chk.id, { subtype: null });
  assert.equal(r.status, 400, 'detail tag kept');
  const ap = await acct('2000');
  r = await call('PUT', '/accounts/' + ap.id, { name: 'Accounts Payable - Vendors', subtype: ap.subtype, description: '' });
  assert.equal(r.status, 200); assert.equal(r.data.subtype, ap.subtype);
  r = await call('PUT', '/accounts/' + chk.id, { active: 0 });
  assert.equal(r.status, 400);
  r = await call('DELETE', '/accounts/' + chk.id);
  assert.equal(r.status, 400); assert.match(r.data.error, /automatic posting/);
  // the expense categories (e.g. 6300 Vehicles & fuel) are locked too
  assert.equal((await acct('6300')).system, true);
});

test('an unused custom account can be renamed, renumbered, retyped and deleted', async () => {
  let r = await call('POST', '/accounts', { number: '6420', name: 'Shop Supplies', type: 'expense' });
  assert.equal(r.status, 200);
  const id = r.data.id;
  r = await call('POST', '/accounts', { number: '6420', name: 'Dup', type: 'expense' });
  assert.equal(r.status, 400, 'duplicate number refused');
  r = await call('PUT', '/accounts/' + id, { number: '6425', name: 'Shop & Truck Supplies', type: 'cogs' });
  assert.equal(r.status, 200); assert.deepEqual([r.data.number, r.data.name, r.data.type], ['6425', 'Shop & Truck Supplies', 'cogs']);
  r = await call('PUT', '/accounts/' + id, { number: '1000' });
  assert.equal(r.status, 400); assert.match(r.data.error, /already used/);
  r = await call('PUT', '/accounts/' + id, { name: '' });
  assert.equal(r.status, 400);
  const a = await acct('6425');
  assert.deepEqual([a.system, a.used], [false, false]);
  r = await call('DELETE', '/accounts/' + id);
  assert.equal(r.status, 200);
  assert.equal(await acct('6425'), undefined);
});

test('an account with history cannot be deleted or retyped, but can be renamed and made inactive', async () => {
  const id = (await call('POST', '/accounts', { number: '6430', name: 'Small tools', type: 'expense' })).data.id;
  const r0 = await call('POST', '/expenses', { date: '2026-11-01', category: 'Tools', amount: 45, account_id: id });
  assert.equal(r0.status, 200, JSON.stringify(r0.data));
  assert.equal((await acct('6430')).used, true);
  let r = await call('DELETE', '/accounts/' + id);
  assert.equal(r.status, 409); assert.match(r.data.error, /expense/); assert.match(r.data.error, /Untick Active/);
  r = await call('PUT', '/accounts/' + id, { type: 'cogs' });
  assert.equal(r.status, 400); assert.match(r.data.error, /ledger activity/);
  r = await call('PUT', '/accounts/' + id, { name: 'Hand tools', number: '6431', active: 0 });
  assert.equal(r.status, 200); assert.deepEqual([r.data.name, r.data.number, r.data.active], ['Hand tools', '6431', 0]);
  assert.equal((await call('GET', '/accounts')).data.find(a => a.id === id), undefined, 'inactive hidden from normal lists');
});
