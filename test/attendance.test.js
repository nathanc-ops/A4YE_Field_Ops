'use strict';
// Attendance: time off, sick, absent, in late, left early — schedule warnings and the KPI numbers.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const D = require('../server/db');
const { createApp } = require('../server/app');
const KpiAuto = require('../server/kpi_auto');
const { localToUtc } = require('../server/kpi');

let server, base, db; const tok = {}, ids = {};
async function call(who, method, p, body) {
  const res = await fetch(base + '/api' + p, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok[who] }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}
const login = async email => (await (await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'password123' }) })).json()).token;
const WEEK = '2026-10-25';   // a Sunday; Boise is UTC−6 that week

before(async () => {
  db = D.open(':memory:');
  server = createApp(db).listen(0); await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  tok.admin = (await (await fetch(base + '/api/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Owner', email: 'o@x.com', password: 'longenough' }) })).json()).token;
  await call('admin', 'PUT', '/settings', { timezone: 'America/Boise' });
  ids.dana = (await call('admin', 'POST', '/users', { name: 'Dana Tech', email: 'dana@x.com', password: 'password123', role: 'tech' })).data.id;
  ids.sam = (await call('admin', 'POST', '/users', { name: 'Sam Tech', email: 'sam@x.com', password: 'password123', role: 'tech' })).data.id;
  ids.desk = (await call('admin', 'POST', '/users', { name: 'Desk Person', email: 'desk@x.com', password: 'password123', role: 'office' })).data.id;
  tok.dana = await login('dana@x.com'); tok.desk = await login('desk@x.com');
  const cust = (await call('admin', 'POST', '/customers', { name: 'Test Customer' })).data.id;
  ids.job = (await call('admin', 'POST', '/jobs', { customer_id: cust, title: 'Panel swap' })).data.id;
  // Dana is booked Tue 9–11 local (15:00Z)
  ids.visit = (await call('admin', 'POST', '/appointments', { job_id: ids.job, start: '2026-10-27T15:00:00.000Z', end: '2026-10-27T17:00:00.000Z', tech_ids: [ids.dana] })).data.id;
});
after(() => server.close());

test('time off is checked, and booked visits on those days come back as a warning', async () => {
  assert.match((await call('admin', 'POST', '/attendance', { user_id: ids.dana, kind: 'vacation', start_date: '2026-10-26' })).data.error, /Pick time off/);
  assert.match((await call('admin', 'POST', '/attendance', { user_id: ids.dana, kind: 'time_off', start_date: '2026-10-28', end_date: '2026-10-26' })).data.error, /before the start/);
  assert.match((await call('admin', 'POST', '/attendance', { user_id: ids.dana, kind: 'late', start_date: '2026-10-26' })).data.error, /minutes late/);
  const r = (await call('desk', 'POST', '/attendance', { user_id: ids.dana, kind: 'time_off', start_date: '2026-10-26', end_date: '2026-10-30', paid: 1, reason: 'Vacation' })).data;
  assert.ok(r.id); assert.deepEqual(r.booked.map(b => b.id), [ids.visit], 'the Tuesday visit is flagged');
  assert.equal((await call('dana', 'POST', '/attendance', { user_id: ids.dana, kind: 'sick', start_date: '2026-10-26' })).status, 403, 'techs can\'t log attendance');
});

test('booking someone on a day off warns, like a double-booking', async () => {
  const r = (await call('admin', 'POST', '/appointments', { job_id: ids.job, start: '2026-10-29T15:00:00.000Z', end: '2026-10-29T16:00:00.000Z', tech_ids: [ids.dana, ids.sam] })).data;
  const off = r.conflicts.filter(c => c.off);
  assert.deepEqual(off.map(c => [c.name, c.off]), [['Dana Tech', 'time_off']]);
  const r2 = (await call('admin', 'PUT', `/appointments/${ids.visit}`, { start: '2026-11-03T15:00:00.000Z', end: '2026-11-03T17:00:00.000Z', tech_ids: [ids.dana] })).data;
  assert.equal(r2.conflicts.filter(c => c.off).length, 0, 'moved off the vacation: no warning');
});

test('techs see only their own entries, without the office note', async () => {
  await call('admin', 'POST', '/attendance', { user_id: ids.sam, kind: 'sick', start_date: '2026-10-27', reason: 'Flu' });
  const mine = (await call('dana', 'GET', `/attendance?from=${WEEK}&to=2026-10-31`)).data;
  assert.deepEqual(mine.map(a => a.user_id), [ids.dana]); assert.equal(mine[0].reason, undefined);
  const all = (await call('admin', 'GET', `/attendance?from=${WEEK}&to=2026-10-31`)).data;
  assert.equal(all.length, 2); assert.equal(all.find(a => a.kind === 'sick').reason, 'Flu');
});

test('KPI numbers: days off (weekdays), sick, absent / no call, late, left early', async () => {
  await call('admin', 'POST', '/attendance', { user_id: ids.desk, kind: 'absent', start_date: '2026-10-28', no_call: 1 });
  await call('admin', 'POST', '/attendance', { user_id: ids.sam, kind: 'time_off', start_date: '2026-10-29', hours: 4 });
  await call('admin', 'POST', '/attendance', { user_id: ids.sam, kind: 'late', start_date: '2026-10-26', minutes: 25, reason: 'Traffic' });
  await call('admin', 'POST', '/attendance', { user_id: ids.dana, kind: 'late', start_date: '2026-11-02', minutes: 10 });   // next week
  await call('admin', 'POST', '/attendance', { user_id: ids.desk, kind: 'left_early', start_date: '2026-10-30', minutes: 60 });
  const localNow = (tz, at = new Date()) => { const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at).map(x => [x.type, x.value])); return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`; };
  const addDays = (d, n) => { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
  const A = KpiAuto(db, { localNow, localToUtc, addDays }), c = { tz: 'America/Boise' }, X = A.context(c);
  const v = rule => A.compute(rule, WEEK, c, X);
  assert.equal(v('att_time_off_days').value, 5.5, 'Dana Mon–Fri vacation (5) + Sam half a day');
  assert.equal(v('att_sick_days').value, 1);
  assert.equal(v('att_absent_days').value, 1); assert.equal(v('att_no_call').value, 1);
  assert.equal(v('att_unplanned_days').value, 2);
  const late = v('att_late'); assert.equal(late.value, 1); assert.match(late.detail[0].ref, /25 min late · Traffic/);
  assert.equal(v('att_late_minutes').value, 25);
  assert.equal(v('att_left_early').value, 1);
  assert.equal(A.compute('att_late', '2026-11-01', c, X).value, 1, 'next week has its own');
});

test('a KPI row can be added for attendance', async () => {
  db.prepare("INSERT INTO kpi_owners (name) VALUES ('Office')").run();
  const owner = db.prepare('SELECT id FROM kpi_owners').get().id;
  const r = (await call('admin', 'POST', '/kpi/metrics', { owner_id: owner, metric: 'Unplanned days out', rule: 'att_unplanned_days', unit: 'days', better: 'Lower', target: 1 })).data;
  assert.equal(r.id, 'X1');
  const m = db.prepare("SELECT * FROM kpi_metrics WHERE id = 'X1'").get();
  assert.equal(m.input, 'auto'); assert.equal(m.rule, 'att_unplanned_days'); assert.equal(m.section, 'Attendance'); assert.equal(m.target, 1);
  assert.match((await call('admin', 'POST', '/kpi/metrics', { owner_id: owner, metric: 'x', rule: 'nope' })).data.error, /Unknown/);
  assert.equal((await call('admin', 'POST', '/kpi/metrics', { owner_id: owner, metric: 'Typed' })).data.id, 'X2');
});

test('time-off requests: anyone asks; the Settings people are emailed; only approvers decide; pending isn\'t time off yet', async () => {
  const ap = (await call('admin', 'POST', '/users', { name: 'Approver Person', email: 'ap@x.com', password: 'password123', role: 'office' })).data.id;
  tok.ap = await login('ap@x.com');
  await call('admin', 'PUT', '/settings', { timeoff_notify: `${ids.desk}`, timeoff_approvers: `${ap}` });
  const day = n => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
  assert.match((await call('dana', 'POST', '/attendance/request', { start_date: day(-3) })).data.error, /from today on/);
  const r = (await call('dana', 'POST', '/attendance/request', { start_date: day(20), end_date: day(22), paid: 1, reason: 'Family trip', user_id: ids.sam, kind: 'sick' })).data;
  assert.ok(r.id); assert.equal(r.email.status, 'not_configured'); assert.deepEqual(r.email.to.sort(), ['ap@x.com', 'desk@x.com']);
  const row = db.prepare('SELECT * FROM attendance WHERE id = ?').get(r.id);
  assert.equal(row.user_id, ids.dana, 'always your own'); assert.equal(row.kind, 'time_off'); assert.equal(row.status, 'pending'); assert.equal(row.paid, 1);
  assert.match(db.prepare("SELECT subject FROM outbox WHERE related = ?").get(`attendance:${r.id}`).subject, /Time-off request: Dana Tech/);
  assert.match((await call('dana', 'POST', '/attendance/request', { start_date: day(21) })).data.error, /already have time off requested/);
  // waiting: on the schedule as requested, not counted as off
  const reqs = (await call('ap', 'GET', '/attendance/requests')).data;
  assert.equal(reqs.can_approve, true); assert.deepEqual(reqs.pending.map(x => x.id), [r.id]);
  assert.equal((await call('dana', 'GET', '/attendance/requests')).data.can_approve, false);
  assert.equal((await call('dana', 'GET', '/attendance/requests')).data.mine[0].status, 'pending');
  // only approvers decide; an admin who isn't on the list can't
  assert.equal((await call('admin', 'POST', `/attendance/${r.id}/decide`, { decision: 'approved' })).status, 403);
  assert.equal((await call('desk', 'POST', `/attendance/${r.id}/decide`, { decision: 'approved' })).status, 403);
  assert.match((await call('ap', 'POST', `/attendance/${r.id}/decide`, { decision: 'denied' })).data.error, /why/);
  const ok = (await call('ap', 'POST', `/attendance/${r.id}/decide`, { decision: 'approved' })).data;
  assert.equal(ok.ok, true); assert.ok(ok.email.to.includes('dana@x.com'), 'the person who asked hears back');
  assert.equal(db.prepare('SELECT status, decided_by FROM attendance WHERE id = ?').get(r.id).decided_by, ap);
  assert.match((await call('ap', 'POST', `/attendance/${r.id}/decide`, { decision: 'denied', note: 'x' })).data.error, /already approved/);
  // a second request, denied with a note; then hidden from the schedule
  const r2 = (await call('dana', 'POST', '/attendance/request', { start_date: day(40) })).data.id;
  await call('ap', 'POST', `/attendance/${r2}/decide`, { decision: 'denied', note: 'Inspection that week' });
  assert.equal((await call('admin', 'GET', `/attendance?from=${day(40)}&to=${day(40)}`)).data.length, 0);
  assert.equal((await call('dana', 'GET', '/attendance/requests')).data.mine.find(x => x.id === r2).decision_note, 'Inspection that week');
  // withdraw while waiting
  const r3 = (await call('dana', 'POST', '/attendance/request', { start_date: day(60) })).data.id;
  assert.equal((await call('desk', 'POST', `/attendance/${r3}/withdraw`)).status, 403);
  assert.equal((await call('dana', 'POST', `/attendance/${r3}/withdraw`)).status, 200);
});

test('everyone selected gets every request, including a request they made themselves; the result names them', async () => {
  await call('admin', 'PUT', '/settings', { timeoff_notify: `${ids.desk},${ids.dana}` });
  const d = new Date(); d.setDate(d.getDate() + 90); const day = d.toISOString().slice(0, 10);
  const r = (await call('dana', 'POST', '/attendance/request', { start_date: day })).data;
  assert.ok(r.email.to.includes('dana@x.com'), 'the person asking is on the list, so they get it too');
  assert.ok(r.email.to.includes('desk@x.com'));
  assert.ok(r.email.names.includes('Dana Tech') && r.email.names.includes('Desk Person'));
  assert.equal(r.email.status, 'not_configured'); assert.match(r.email.error, /Settings → Email/);
  const sent = db.prepare("SELECT to_email FROM outbox WHERE related = ? ORDER BY id DESC").get(`attendance:${r.id}`);
  assert.match(sent.to_email, /dana@x\.com/);
});
