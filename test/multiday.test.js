'use strict';
// Multi-day visits (a commercial crew window repeated each day): change one day's crew or hours, or take a day off,
// without touching the rest of the visit.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const D = require('../server/db');
const { createApp } = require('../server/app');

let server, base, db;
const tok = {}, ids = {};
async function call(who, method, p, body) {
  const res = await fetch(base + '/api' + p, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok[who] }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json() };
}
// 2099-11-09 is a Monday. Boise in November is UTC−7: local midnight = 07:00Z, 7:00 AM = 14:00Z, 3:30 PM = 22:30Z.
const Z = (day, hm) => `2099-11-${String(day).padStart(2, '0')}T${hm}:00.000Z`;
const dayBody = (day, extra = {}) => ({ day_from: Z(day, '07:00'), day_to: Z(day + 1, '07:00'), start: Z(day, '14:00'), end: Z(day, '22:30'),
  before_end: Z(day - 1, '22:30'), after_start: Z(day + 1, '14:00'), ...extra });
const visits = () => db.prepare(`SELECT a.*, (SELECT GROUP_CONCAT(user_id) FROM appointment_techs t WHERE t.appointment_id = a.id) crew FROM appointments a WHERE job_id = ? ORDER BY start`).all(ids.job);

before(async () => {
  db = D.open(':memory:');
  server = createApp(db).listen(0); await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  tok.admin = (await call(null, 'POST', '/setup', { name: 'Owner', email: 'o@x.com', password: 'longenough' })).data.token;
  ids.dana = (await call('admin', 'POST', '/users', { name: 'Dana Brooks', email: 'dana@x.com', password: 'password123', role: 'tech', hourly_wage: 36 })).data.id;
  ids.sam = (await call('admin', 'POST', '/users', { name: 'Sam Lee', email: 'sam@x.com', password: 'password123', role: 'tech', hourly_wage: 22 })).data.id;
  const cust = (await call('admin', 'POST', '/customers', { name: 'Summit GC', email: 'gc@example.com' })).data.id;
  ids.job = (await call('admin', 'POST', '/jobs', { customer_id: cust, title: 'Clinic TI', is_project: 1, billing_type: 'fixed', contract_amount: 50000 })).data.id;
  // Mon 7:00 → Fri 3:30 local: a 5-day crew window
  ids.visit = (await call('admin', 'POST', '/appointments', { job_id: ids.job, start: Z(9, '14:00'), end: Z(13, '22:30'), tech_ids: [ids.dana], notes: 'Badge in at the GC trailer' })).data.id;
  // Dana already clocked in on Thursday on this visit
  db.prepare("INSERT INTO time_entries (user_id, job_id, appointment_id, kind, clock_in, clock_out, hourly_cost, hourly_wage) VALUES (?, ?, ?, 'job', ?, ?, 45, 36)")
    .run(ids.dana, ids.job, ids.visit, Z(12, '14:05'), Z(12, '22:30'));
  await call('admin', 'POST', `/appointments/${ids.visit}/confirm`, {});
});
after(() => server.close());

test('change Wednesday\'s crew only: the visit splits into Mon–Tue, Wed and Thu–Fri; Thursday\'s clocked time follows its day', async () => {
  const r = await call('admin', 'POST', `/appointments/${ids.visit}/day`, dayBody(11, { tech_ids: [ids.sam] }));
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.ids.length, 3); assert.equal(r.data.ids[0], ids.visit, 'the original row stays the first piece');
  const v = visits();
  assert.deepEqual(v.map(x => [x.start, x.end, x.crew]), [
    [Z(9, '14:00'), Z(10, '22:30'), String(ids.dana)],
    [Z(11, '14:00'), Z(11, '22:30'), String(ids.sam)],
    [Z(12, '14:00'), Z(13, '22:30'), String(ids.dana)]]);
  assert.ok(v.every(x => x.notes === 'Badge in at the GC trailer' && x.status === 'scheduled'), 'notes and status carried to every piece');
  assert.equal(db.prepare('SELECT appointment_id FROM time_entries').get().appointment_id, v[2].id, 'Thursday time moved to the Thu–Fri piece');
  assert.equal(r.data.id, v[1].id);
  // a crew-only change doesn't make the customer's confirmation stale
  const list = (await call('admin', 'GET', `/appointments?from=${encodeURIComponent(Z(9, '00:00'))}&to=${encodeURIComponent(Z(14, '00:00'))}`)).data.filter(a => a.job_id === ids.job);
  assert.ok(list.every(a => a.confirmed_at && a.needs_reconfirm === false), JSON.stringify(list.map(a => [a.id, a.needs_reconfirm])));
  // booked hours on Wednesday: Sam 8.5, Dana 0
  const disp = (await call('admin', 'GET', '/dispatch?date=2099-11-11')).data;
  const booked = Object.fromEntries(disp.techs.map(t => [t.id, t.booked_hours]));
  assert.equal(booked[ids.sam], 8.5); assert.equal(booked[ids.dana], 0);
  // Sam's crew wasn't added to the job's crew list by accident? (he is now on the job — that's expected)
  assert.ok(db.prepare('SELECT 1 x FROM job_techs WHERE job_id = ? AND user_id = ?').get(ids.job, ids.sam));
  // the job's schedule window still spans the whole week
  const j = db.prepare('SELECT scheduled_start, scheduled_end FROM jobs WHERE id = ?').get(ids.job);
  assert.equal(j.scheduled_start, Z(9, '14:00')); assert.equal(j.scheduled_end, Z(13, '22:30'));
});

test('changing a day\'s hours flags that day for the customer; first and last days split cleanly', async () => {
  const [mon] = visits();
  // Monday (first day of the Mon–Tue piece): start at 9:00 instead → Mon alone + Tue
  const r = await call('admin', 'POST', `/appointments/${mon.id}/day`, { ...dayBody(9, { start: Z(9, '16:00'), times_changed: true }), before_end: undefined });
  assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.ids.length, 2);
  const v = visits();
  assert.deepEqual(v.slice(0, 2).map(x => [x.start, x.end]), [[Z(9, '16:00'), Z(9, '22:30')], [Z(10, '14:00'), Z(10, '22:30')]]);
  const a = (await call('admin', 'GET', `/appointments?from=${encodeURIComponent(Z(9, '00:00'))}&to=${encodeURIComponent(Z(10, '00:00'))}`)).data.find(x => x.id === v[0].id);
  assert.equal(a.needs_reconfirm, true, 'Monday now starts later than the customer was told');
});

test('take a day off the visit; refused when someone clocked time that day; bad requests', async () => {
  const thuFri = visits().find(x => x.start === Z(12, '14:00'));
  // Thursday has Dana's time → can't be taken off
  const no = await call('admin', 'POST', `/appointments/${thuFri.id}/day`, { ...dayBody(12), before_end: undefined, remove: true });
  assert.equal(no.status, 400); assert.match(no.data.error, /already clocked time/);
  // Friday off → the piece becomes Thursday only
  const ok = await call('admin', 'POST', `/appointments/${thuFri.id}/day`, { ...dayBody(13), after_start: undefined, before_end: Z(12, '22:30'), remove: true });
  assert.equal(ok.status, 200, JSON.stringify(ok.data)); assert.equal(ok.data.removed, true);
  const v = visits();
  assert.equal(v[v.length - 1].start, Z(12, '14:00')); assert.equal(v[v.length - 1].end, Z(12, '22:30'));
  assert.equal(v.some(x => x.start.startsWith('2099-11-13')), false);
  // the only day of a one-day visit can't be "taken off" — delete it instead
  assert.equal((await call('admin', 'POST', `/appointments/${v[v.length - 1].id}/day`, { ...dayBody(12), remove: true })).status, 400);
  // a day the visit doesn't cover
  assert.equal((await call('admin', 'POST', `/appointments/${v[0].id}/day`, dayBody(20))).status, 400);
  // a "day before" that doesn't line up
  const tueId = v.find(x => x.start === Z(10, '14:00')).id;
  assert.equal(tueId > 0, true);
  const big = (await call('admin', 'POST', '/appointments', { job_id: ids.job, start: Z(16, '14:00'), end: Z(20, '22:30'), tech_ids: [ids.dana] })).data.id;
  assert.equal((await call('admin', 'POST', `/appointments/${big}/day`, dayBody(18, { before_end: Z(10, '22:30') }))).status, 400);
  // a single-day visit just changes
  const single = v.find(x => x.start === Z(11, '14:00'));
  const s = await call('admin', 'POST', `/appointments/${single.id}/day`, { ...dayBody(11), tech_ids: [ids.dana, ids.sam] });
  assert.equal(s.status, 200); assert.deepEqual(s.data.ids, [single.id]);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM appointment_techs WHERE appointment_id = ?').get(single.id).n, 2);
});
