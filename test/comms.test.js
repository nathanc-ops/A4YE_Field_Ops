'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const D = require('../server/db');
const { createApp } = require('../server/app');

let server, base, db; const tok = {};
async function call(who, method, p, body) {
  const res = await fetch(base + '/api' + p, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok[who] }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}
const login = async (email) => (await (await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'password123' }) })).json()).token;
let cust, other, jobId, estId, techId;

before(async () => {
  db = D.open(':memory:');
  server = createApp(db).listen(0); await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  tok.admin = (await (await fetch(base + '/api/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Owner', email: 'o@x.com', password: 'longenough' }) })).json()).token;
  techId = (await call('admin', 'POST', '/users', { name: 'Tech', email: 't@x.com', password: 'password123', role: 'tech' })).data.id;
  await call('admin', 'POST', '/users', { name: 'Other Tech', email: 't2@x.com', password: 'password123', role: 'tech' });
  await call('admin', 'POST', '/users', { name: 'Desk', email: 'd@x.com', password: 'password123', role: 'office' });
  tok.tech = await login('t@x.com'); tok.tech2 = await login('t2@x.com'); tok.office = await login('d@x.com');
  cust = (await call('admin', 'POST', '/customers', { name: 'Sample Homeowner', email: 'home@example.com', phone: '555-0100' })).data.id;
  other = (await call('admin', 'POST', '/customers', { name: 'Someone Else', email: 'else@example.com' })).data.id;
  jobId = (await call('admin', 'POST', '/jobs', { customer_id: cust, title: 'Panel swap', tech_ids: [techId] })).data.id;
  estId = (await call('admin', 'POST', '/estimates', { customer_id: cust, job_id: jobId, title: 'Add circuits', tax_rate: 0, items: [{ description: 'Circuit', qty: 2, unit_price: 300 }] })).data.id;
  // another customer's estimate email must not leak into this customer's log
  const e2 = (await call('admin', 'POST', '/estimates', { customer_id: other, title: 'Other', tax_rate: 0, items: [{ description: 'X', qty: 1, unit_price: 100 }] })).data.id;
  await call('admin', 'POST', `/estimates/${estId}/send`, {});
  await call('admin', 'POST', `/estimates/${e2}/send`, {});
});
after(() => server.close());

test('emails the app sent show on the estimate, its job and the customer', async () => {
  const onEst = (await call('admin', 'GET', `/comms?estimate_id=${estId}`)).data;
  assert.equal(onEst.emails, true);
  assert.deepEqual(onEst.items.map(x => [x.type, x.to]), [['email', 'home@example.com']]);
  assert.equal(onEst.items[0].related, `estimate:${estId}`); assert.equal(onEst.items[0].status, 'not_configured');
  const onJob = (await call('admin', 'GET', `/comms?job_id=${jobId}`)).data.items;
  assert.equal(onJob.filter(x => x.type === 'email').length, 1, 'the job sees its estimate email');
  const onCust = (await call('office', 'GET', `/comms?customer_id=${cust}`)).data.items;
  assert.deepEqual(onCust.filter(x => x.type === 'email').map(x => x.to), ['home@example.com'], 'only this customer');
});

test('calls are logged by hand and roll up to the customer', async () => {
  assert.match((await call('admin', 'POST', '/comms', { job_id: jobId, kind: 'call' })).data.error, /outcome or notes/);
  assert.match((await call('admin', 'POST', '/comms', { job_id: jobId, customer_id: cust, outcome: 'x' })).data.error, /Say which/);
  assert.match((await call('admin', 'POST', '/comms', { job_id: jobId, kind: 'fax', outcome: 'x' })).data.error, /call, text/);
  assert.match((await call('admin', 'POST', '/comms', { job_id: jobId, outcome: 'x', occurred_at: new Date(Date.now() + 86400e3).toISOString() })).data.error, /future/);
  const a = (await call('office', 'POST', '/comms', { estimate_id: estId, kind: 'call', direction: 'in', contact: 'Homeowner', outcome: 'Wants a callback', body: 'Asked about adding a sub-panel', duration_min: 6 })).data.id;
  assert.ok(a);
  await call('admin', 'POST', '/comms', { customer_id: cust, kind: 'email', outcome: 'Sent photos from Outlook', occurred_at: new Date(Date.now() - 86400e3).toISOString() });
  const est = (await call('admin', 'GET', `/comms?estimate_id=${estId}`)).data.items.filter(x => x.type === 'log');
  assert.equal(est.length, 1); assert.equal(est[0].user_name, 'Desk'); assert.equal(est[0].duration_min, 6);
  const job = (await call('admin', 'GET', `/comms?job_id=${jobId}`)).data.items.filter(x => x.type === 'log');
  assert.equal(job.length, 1, 'an estimate on a job counts for the job');
  const all = (await call('admin', 'GET', `/comms?customer_id=${cust}`)).data.items;
  assert.equal(all.filter(x => x.type === 'log').length, 2);
  assert.equal(all.find(x => x.type === 'log' && x.estimate_id === estId).estimate_number != null, true, 'says which estimate');
  assert.ok(all.every((x, i) => !i || String(all[i - 1].at) >= String(x.at)), 'newest first');
  assert.equal((await call('admin', 'GET', `/comms?customer_id=${other}`)).data.items.filter(x => x.type === 'log').length, 0);
});

test('techs: calls on their own jobs only, and no emails', async () => {
  const r = (await call('tech', 'GET', `/comms?job_id=${jobId}`)).data;
  assert.equal(r.emails, false); assert.ok(r.items.every(x => x.type === 'log'));
  assert.equal((await call('tech', 'POST', '/comms', { job_id: jobId, outcome: 'On my way, 20 min' })).status, 200);
  assert.equal((await call('tech2', 'GET', `/comms?job_id=${jobId}`)).status, 403);
  assert.equal((await call('tech2', 'POST', '/comms', { job_id: jobId, outcome: 'x' })).status, 403);
  assert.equal((await call('tech', 'GET', `/comms?customer_id=${cust}`)).status, 403);
  assert.equal((await call('tech', 'GET', `/comms?estimate_id=${estId}`)).status, 403);
});

test('only who logged it, or an admin, edits or deletes it', async () => {
  const id = (await call('admin', 'GET', `/comms?job_id=${jobId}`)).data.items.find(x => x.type === 'log' && x.user_name === 'Tech').id;
  assert.equal((await call('office', 'PUT', `/comms/${id}`, { outcome: 'changed' })).status, 403);
  assert.equal((await call('tech', 'PUT', `/comms/${id}`, { outcome: 'Arrived', body: 'Customer let us in' })).status, 200);
  assert.match((await call('tech', 'PUT', `/comms/${id}`, { outcome: '', body: '' })).data.error, /outcome or notes/);
  assert.equal((await call('admin', 'DELETE', `/comms/${id}`)).status, 200);
  assert.equal((await call('admin', 'GET', `/comms?job_id=${jobId}`)).data.items.filter(x => x.user_name === 'Tech').length, 0);
});

test('bids keep their own log; a missing record is a 404', async () => {
  const bid = db.prepare("INSERT INTO bids (project_name) VALUES ('Test Plaza')").run().lastInsertRowid;
  assert.equal((await call('admin', 'POST', '/comms', { bid_id: Number(bid), contact: 'GC estimator', outcome: 'Confirmed bid date' })).status, 200);
  const r = (await call('admin', 'GET', `/comms?bid_id=${bid}`)).data.items;
  assert.equal(r.length, 1); assert.equal(r[0].bid_name, 'Test Plaza'); assert.equal(r[0].customer_id, null);
  assert.equal((await call('admin', 'GET', '/comms?job_id=99999')).status, 404);
});

test('Reports → Jobs: filters, hold details, totals; office only', async () => {
  const d = new Date(); d.setDate(d.getDate() + 4); const fu = d.toISOString().slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);
  const hold = (await call('admin', 'POST', '/jobs', { customer_id: other, title: 'Meter base', job_type: 'install', status: 'on_hold', hold_reason: 'Utility', hold_follow_up: fu })).data.id;
  const all = (await call('admin', 'GET', `/reports/jobs?from=${today}&to=${today}`)).data;
  assert.ok(all.rows.length >= 2); assert.equal(all.totals.jobs, all.rows.length);
  const h = all.rows.find(r => r.id === hold);
  assert.equal(h.hold_reason, 'Utility'); assert.equal(h.hold_follow_up, fu); assert.equal(h.days_on_hold, 0); assert.ok('hours' in h && 'revenue' in h);
  assert.deepEqual((await call('admin', 'GET', `/reports/jobs?from=${today}&to=${today}&status=on_hold`)).data.rows.map(r => r.id), [hold]);
  assert.deepEqual((await call('admin', 'GET', `/reports/jobs?from=${today}&to=${today}&tech_id=${techId}`)).data.rows.map(r => r.id), [jobId]);
  assert.ok((await call('admin', 'GET', `/reports/jobs?from=${today}&to=${today}&job_type=install`)).data.rows.every(r => r.job_type === 'install'));
  assert.equal((await call('admin', 'GET', `/reports/jobs?from=2000-01-01&to=2000-01-31`)).data.rows.length, 0);
  assert.equal((await call('tech', 'GET', `/reports/jobs?from=${today}&to=${today}`)).status, 403);
});
