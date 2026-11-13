'use strict';
// KPIs: auto numbers stay live until the week is submitted; submitting (after the week ends) locks the page.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const D = require('../server/db');
const { createApp } = require('../server/app');

let server, base, db, admin, ann, owner, week, thisWeek;
async function call(tok, method, path, body) {
  const res = await fetch(base + '/api' + path, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json() };
}
const addDays = (d, n) => { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const val = (p, id) => p.sections.flatMap(s => s.metrics).find(m => m.id === id);

before(async () => {
  db = D.open(':memory:');
  server = createApp(db).listen(0);
  await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  admin = (await call('', 'POST', '/setup', { name: 'Owner', email: 'o@x.com', password: 'longenough' })).data.token;
  const annId = (await call(admin, 'POST', '/users', { name: 'Ann', email: 'ann@x.com', password: 'longenough', role: 'office' })).data.id;
  ann = (await call('', 'POST', '/login', { email: 'ann@x.com', password: 'longenough' })).data.token;
  owner = Number(D.run(db, 'INSERT INTO kpi_owners (name, user_id) VALUES (?, ?)', 'Ann', annId).lastInsertRowid);
  // A1 auto: estimates created; A2 typed; A3 = A1 * 2 (a formula)
  D.run(db, "INSERT INTO kpi_metrics (id, owner_id, section, metric, unit, better, target, input, rule) VALUES ('A1', ?, 'Sales', 'Estimates created', '#', 'Higher', 1, 'auto', 'hcp_estimates_created')", owner);
  D.run(db, "INSERT INTO kpi_metrics (id, owner_id, section, metric, unit, better, input) VALUES ('A2', ?, 'Sales', 'Calls', '#', 'Info', 'manual')", owner);
  D.run(db, "INSERT INTO kpi_metrics (id, owner_id, section, metric, unit, better, input, rule) VALUES ('A3', ?, 'Sales', 'Double', '#', 'Info', 'calc', 'A1*2')", owner);
  D.run(db, "UPDATE settings SET value = '2020-01-05' WHERE key = 'kpi_auto_from'");
  D.run(db, "INSERT OR REPLACE INTO settings (key, value) VALUES ('kpi_auto_from', '2020-01-05')");
  const me = (await call(ann, 'GET', '/kpi/me')).data;
  week = me.week; thisWeek = me.weeks[0];
});
after(() => server.close());

const cust = async () => (await call(admin, 'POST', '/customers', { name: 'C' + Math.random(), location: { address: '1 A St' } })).data.id;
async function estimateOn(day) {
  const id = (await call(admin, 'POST', '/estimates', { customer_id: await cust(), items: [{ description: 'x', qty: 1, unit_price: 100 }] })).data.id;
  D.run(db, 'UPDATE estimates SET created_at = ? WHERE id = ?', `${day} 18:00:00`, id);
}

test('due Monday; auto numbers are live: a new estimate shows up on the next read', async () => {
  let p = (await call(ann, 'GET', `/kpi/page?owner=${owner}&week=${week}`)).data;
  assert.equal(p.due.slice(0, 10), addDays(week, 8), 'due the Monday after the week');
  assert.equal(p.live, true); assert.equal(p.locked, null); assert.equal(p.week_over, true);
  const before = val(p, 'A1').value || 0;
  await estimateOn(addDays(week, 2));
  p = (await call(ann, 'GET', `/kpi/page?owner=${owner}&week=${week}`)).data;
  assert.equal(val(p, 'A1').value, before + 1);
  assert.equal(val(p, 'A3').value, (before + 1) * 2);
});

test('the week in progress can be saved but not submitted', async () => {
  let r = await call(ann, 'PUT', '/kpi/page', { owner, week: thisWeek, values: { A2: 5 } });
  assert.equal(r.status, 200);
  r = await call(ann, 'PUT', '/kpi/page', { owner, week: thisWeek, values: {}, submit: true });
  assert.equal(r.status, 400); assert.match(r.data.error, /isn't over/);
  const p = (await call(ann, 'GET', `/kpi/page?owner=${owner}&week=${thisWeek}`)).data;
  assert.equal(p.week_over, false);
});

test('submitting locks the page: numbers freeze, edits are refused, formulas keep their submitted value', async () => {
  let r = await call(ann, 'PUT', '/kpi/page', { owner, week, values: { A2: 12 }, submit: true });
  assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.locked, true);
  let p = (await call(ann, 'GET', `/kpi/page?owner=${owner}&week=${week}`)).data;
  const a1 = val(p, 'A1').value, a3 = val(p, 'A3').value;
  assert.ok(p.locked); assert.equal(p.can_edit, false); assert.equal(p.live, false);
  await estimateOn(addDays(week, 3));                       // more work logged after the lock
  p = (await call(ann, 'GET', `/kpi/page?owner=${owner}&week=${week}`)).data;
  assert.equal(val(p, 'A1').value, a1, 'auto number frozen'); assert.equal(val(p, 'A3').value, a3, 'formula frozen');
  r = await call(ann, 'PUT', '/kpi/page', { owner, week, values: { A2: 99 } });
  assert.equal(r.status, 409); assert.match(r.data.error, /locked/);
  r = await call(admin, 'PUT', '/kpi/page', { owner, week, values: { A2: 99 } });
  assert.equal(r.status, 409, 'even admins reopen first');
  const dash = (await call(admin, 'GET', `/kpi/dashboard?week=${week}`)).data;
  assert.equal(dash.reports.find(x => x.id === owner).locked, true);
});

test('reopen needs edit-all and a reason; numbers go live again; submitting locks again', async () => {
  let r = await call(ann, 'POST', '/kpi/page/reopen', { owner, week, reason: 'typo' });
  assert.equal(r.status, 403);
  r = await call(admin, 'POST', '/kpi/page/reopen', { owner, week, reason: '' });
  assert.equal(r.status, 400);
  r = await call(admin, 'POST', '/kpi/page/reopen', { owner, week, reason: 'Calls were miscounted' });
  assert.equal(r.status, 200);
  let p = (await call(ann, 'GET', `/kpi/page?owner=${owner}&week=${week}`)).data;
  assert.equal(p.locked, null); assert.equal(p.can_edit, true);
  assert.equal(p.reopens[0].reason, 'Calls were miscounted');
  const live = val(p, 'A1').value;
  assert.ok(live >= 2, 'the estimate logged after the lock now counts');
  r = await call(ann, 'PUT', '/kpi/page', { owner, week, values: { A2: 14 }, submit: true });
  assert.equal(r.data.locked, true);
  p = (await call(ann, 'GET', `/kpi/page?owner=${owner}&week=${week}`)).data;
  assert.ok(p.locked); assert.equal(val(p, 'A2').value, 14);
});
