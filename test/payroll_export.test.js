'use strict';
// Payroll export: overtime per workweek, PTO, time zone, permissions, logging.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const D = require('../server/db');
const C = require('../server/calc');
const PX = require('../server/payroll_export');
const { createApp } = require('../server/app');

let server, base, db, admin, office, tech, sam, ana;
async function call(tok, method, path, body) {
  const res = await fetch(base + '/api' + path, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, headers: res.headers };
}
// Boise is UTC-7 in November (MST)
const mst = (date, hh, mm = 0) => new Date(`${date}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00-07:00`).toISOString();
const entry = (uid, kind, inIso, outIso, wage) => D.run(db, 'INSERT INTO time_entries (user_id, kind, clock_in, clock_out, hourly_cost, hourly_wage) VALUES (?,?,?,?,?,?)', uid, kind, inIso, outIso, wage * 1.3, wage);

before(async () => {
  db = D.open(':memory:');
  server = createApp(db).listen(0);
  await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  admin = (await call('', 'POST', '/setup', { name: 'Owner', email: 'o@x.com', password: 'longenough' })).data.token;
  D.run(db, "UPDATE settings SET value = 'America/Boise' WHERE key = 'timezone'");
  for (const [n, e, role] of [['Office Ann', 'oa@x.com', 'office'], ['Tech Tom', 'tt@x.com', 'tech']]) await call(admin, 'POST', '/users', { name: n, email: e, password: 'longenough', role });
  office = (await call('', 'POST', '/login', { email: 'oa@x.com', password: 'longenough' })).data.token;
  tech = (await call('', 'POST', '/login', { email: 'tt@x.com', password: 'longenough' })).data.token;
  sam = (await call(admin, 'POST', '/users', { name: 'Sam Sparks', email: 's@x.com', password: 'longenough', role: 'tech', hourly_wage: 30, payroll_id: 'EMP-7' })).data.id;
  ana = (await call(admin, 'POST', '/users', { name: '=HYPERLINK("x")', email: 'a@x.com', password: 'longenough', role: 'tech', hourly_wage: 20 })).data.id;

  // Sam, workweek Sun Nov 1 – Sat Nov 7: 5 × 10 h worked + 8 h PTO Saturday → 40 regular, 10 OT, 8 PTO (PTO never pushes into OT)
  for (let d = 2; d <= 6; d++) entry(sam, 'job', mst(`2026-11-0${d}`, 7), mst(`2026-11-0${d}`, 17), 30);
  entry(sam, 'pto', mst('2026-11-07', 8), mst('2026-11-07', 16), 30);
  // Saturday-night shift: 8 PM Sat Nov 7 local is already Sunday in UTC — it still belongs to the Nov 1 week
  entry(sam, 'shop', mst('2026-11-07', 20), mst('2026-11-07', 22), 30);
  // week of Sun Nov 8: a raise to $32 mid-week, 36 h total
  entry(sam, 'job', mst('2026-11-09', 7), mst('2026-11-09', 19), 30);
  entry(sam, 'job', mst('2026-11-10', 7), mst('2026-11-10', 19), 32);
  entry(sam, 'travel', mst('2026-11-11', 7), mst('2026-11-11', 19), 32);
  // Ana: one closed day and one still clocked in
  entry(ana, 'job', mst('2026-11-03', 8), mst('2026-11-03', 12), 20);
  D.run(db, 'INSERT INTO time_entries (user_id, kind, clock_in, clock_out, hourly_cost, hourly_wage) VALUES (?,?,?,NULL,?,?)', ana, 'job', mst('2026-11-12', 8), 26, 20);
});
after(() => server.close());

test('overtime per workweek, PTO at regular rate and outside overtime, local-time weeks, raises honored', () => {
  const r = PX.build(db, '2026-11-01', '2026-11-14');
  const s = r.summary.find(x => x.name === 'Sam Sparks');
  // week 1: 52 worked (50 job + 2 shop) → 40 reg + 12 OT; PTO 8. week 2: 36 worked, no OT
  assert.deepEqual([s.regular_hours, s.overtime_hours, s.pto_hours, s.total_hours], [76, 12, 8, 96]);
  const w1 = r.weekly.find(x => x.name === 'Sam Sparks' && x.week_start === '2026-11-01');
  assert.equal(w1.week_end, '2026-11-07');
  assert.deepEqual([w1.regular_hours, w1.overtime_hours, w1.pto_hours], [40, 12, 8]);
  assert.equal(w1.gross_pay, 40 * 30 + 12 * 45 + 8 * 30);
  const w2 = r.weekly.find(x => x.name === 'Sam Sparks' && x.week_start === '2026-11-08');
  assert.equal(w2.gross_pay, 12 * 30 + 24 * 32, 'each hour at the rate it was logged at');
  assert.equal(s.gross_pay, w1.gross_pay + w2.gross_pay);
  assert.equal(s.employee_id, 'EMP-7');
  assert.ok(r.warnings.some(w => /more than one pay rate/.test(w)));
  assert.ok(r.warnings.some(w => /still clocked in/.test(w)), 'open entry flagged');
  assert.equal(r.summary.find(x => x.email === 'a@x.com').total_hours, 4, 'open entry left out');
});

test('periods must be whole Sunday–Saturday weeks; switching the setting to Monday moves the weeks', () => {
  assert.throws(() => PX.build(db, '2026-11-02', '2026-11-07'), /start on a Sunday/);
  assert.throws(() => PX.build(db, '2026-11-01', '2026-11-08'), /end on a Saturday/);
  assert.throws(() => PX.build(db, '2026-11-08', '2026-11-07'), /ends before/);
  D.run(db, "UPDATE settings SET value = 'mon' WHERE key = 'workweek_start'");
  try {
    assert.throws(() => PX.build(db, '2026-11-01', '2026-11-07'), /start on a Monday/);
    const r = PX.build(db, '2026-11-02', '2026-11-08');
    // Mon–Sun: Sam's Mon–Fri 50 h + Sat 2 h shop = 52 worked → 12 OT, same 8 h PTO
    const s = r.summary.find(x => x.name === 'Sam Sparks');
    assert.deepEqual([s.overtime_hours, s.pto_hours], [12, 8]);
    assert.equal(r.week_starts, 'Monday');
  } finally { D.run(db, "UPDATE settings SET value = 'sun' WHERE key = 'workweek_start'"); }
});

test('the payroll report no longer counts PTO toward overtime either', () => {
  const [row] = C.payroll(db, '2026-11-01', '2026-11-07').filter(x => x.name === 'Sam Sparks');
  assert.equal(row.by_kind.pto, 8);
  // before: 50 job + 8 PTO + 2 shop = 60 → 20 OT. Now PTO is left out: 10–12 OT depending on which day the
  // Saturday-night shift lands on (this report still uses the server's clock; the export uses the company time zone)
  assert.ok(row.overtime_hours >= 10 && row.overtime_hours <= 12, `OT ${row.overtime_hours}`);
});

test('office staff need the switch; techs never; admins always — and every download is logged', async () => {
  let r = await call(office, 'GET', '/payroll-export/csv?from=2026-11-01&to=2026-11-07');
  assert.equal(r.status, 403); assert.match(r.data.error, /Payroll export/);
  assert.equal((await call(tech, 'GET', '/payroll-export')).status, 403);
  const perms = (await call(admin, 'GET', '/permissions')).data.defaults;
  assert.equal(perms.office.payroll_export, false); assert.equal(perms.manager.payroll_export, false); assert.equal(perms.admin.payroll_export, true);
  const annId = (await call(admin, 'GET', '/users')).data.find(u => u.email === 'oa@x.com').id;
  r = await call(admin, 'PUT', '/users/' + annId, { perms: { ...perms.office, payroll_export: true } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  r = await call(office, 'GET', '/payroll-export/csv?from=2026-11-01&to=2026-11-07&layout=summary');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-disposition'), /payroll_2026-11-01_to_2026-11-07_summary\.csv/);
  const lines = r.data.replace(/^﻿/, '').trim().split('\r\n');
  assert.match(lines[0], /^"Employee ID","Employee","Email","Pay type","Period start"/);
  assert.ok(lines.some(l => l.startsWith('"EMP-7","Sam Sparks","s@x.com","Hourly"')));
  assert.ok(lines.some(l => l.includes(`"'=HYPERLINK(""x"")"`)), 'formula-looking names are defused');
  r = await call(admin, 'GET', '/payroll-export/csv?from=2026-11-01&to=2026-11-14&layout=detail');
  assert.equal(r.status, 200);
  assert.ok(r.data.split('\r\n').length > 10);
  const info = (await call(admin, 'GET', '/payroll-export')).data;
  assert.equal(info.history.length, 2);
  assert.equal(info.history[1].user_name, 'Office Ann');
  assert.equal(info.history[0].layout, 'detail');
  r = await call(admin, 'GET', '/payroll-export/csv?from=2026-11-01&to=2026-11-07&layout=bogus');
  assert.equal(r.status, 400);
});

test('time zone math: local midnight in Boise across the DST change', () => {
  assert.equal(PX.zonedMidnight('2026-11-02', 'America/Boise').toISOString(), '2026-11-02T07:00:00.000Z');   // MST
  assert.equal(PX.zonedMidnight('2026-10-26', 'America/Boise').toISOString(), '2026-10-26T06:00:00.000Z');   // MDT
  assert.equal(PX.zonedMidnight('2026-11-01', 'America/Boise').toISOString(), '2026-11-01T06:00:00.000Z');   // the change day starts in MDT
});

test('new and existing installs default to a Sunday workweek; the time clock week starts Sunday too', () => {
  assert.equal(D.settings(db).workweek_start, 'sun');
  const w = C.weekHours(db, '2026-11-04');
  assert.equal(w.week, '2026-11-01');
  assert.equal(w.days[6], '2026-11-07');
});

test('salaried staff: weekly salary every week, no overtime anywhere, hours for reference only', async () => {
  const nate = (await call(admin, 'POST', '/users', { name: 'Nathan Carter', email: 'n@x.com', password: 'longenough', role: 'admin', pay_type: 'salary', salary_annual: 78000, payroll_id: 'EMP-1' })).data.id;
  const u = D.get(db, 'SELECT * FROM users WHERE id = ?', nate);
  assert.equal(u.hourly_wage, 37.5, 'job-costing rate defaults to salary ÷ 2080');
  // 55 h in week one, nothing in week two
  for (let d = 2; d <= 6; d++) entry(nate, 'job', mst(`2026-11-0${d}`, 6), mst(`2026-11-0${d}`, 17), 37.5);
  const r = PX.build(db, '2026-11-01', '2026-11-14');
  const s = r.summary.find(x => x.name === 'Nathan Carter');
  assert.deepEqual([s.pay_type, s.regular_hours, s.overtime_hours, s.salary_per_week, s.gross_pay], ['Salary', 55, 0, 1500, 3000]);
  assert.equal(r.weekly.filter(x => x.name === 'Nathan Carter').length, 2, 'paid for the week with no time too');
  // the Sam hourly numbers are unchanged
  assert.equal(r.summary.find(x => x.name === 'Sam Sparks').overtime_hours, 12);
  // payroll report and time-clock week: no overtime, no flags
  const rep = C.payroll(db, '2026-11-01', '2026-11-07').find(x => x.name === 'Nathan Carter');
  assert.deepEqual([rep.overtime_hours, rep.gross_pay, rep.pay_type], [0, 1500, 'salary']);
  const wk = C.weekHours(db, '2026-11-04', mst('2026-11-07', 12)).rows.find(x => x.name === 'Nathan Carter');
  assert.deepEqual([wk.worked, wk.overtime, wk.flags], [55, 0, []]);
  // salary isn't shown to people without cost access, and a bad pay type is refused
  assert.equal((await call(admin, 'PUT', '/users/' + nate, { pay_type: 'commission' })).status, 400);
  const csv = (await call(admin, 'GET', '/payroll-export/csv?from=2026-11-01&to=2026-11-07')).data;
  assert.ok(csv.includes('"EMP-1","Nathan Carter","n@x.com","Salary"'));
});
