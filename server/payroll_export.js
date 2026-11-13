'use strict';
// Payroll export: hours and gross pay per employee for a pay period, as a CSV to hand to the payroll provider (or the bookkeeper).
//
//  - Pay periods are whole workweeks (Sunday–Saturday unless Settings → Workweek starts says Monday) in the company time zone,
//    because overtime is figured per workweek: worked hours past the weekly threshold (default 40) are overtime at the multiplier.
//  - PTO is paid at the regular rate and does not count toward overtime (it isn't time worked).
//  - Each time entry is paid at the wage saved on it when it was logged, so a raise mid-period is honored.
//  - Open entries (someone still clocked in) are left out and listed as warnings.
//  - Salaried (exempt) people get their yearly salary ÷ 52 for every week of the period, whether or not they clocked in.
//    Their clocked hours are shown for reference; they never get overtime, and PTO doesn't change their pay.
//  - Every export is logged: who, when, which period, how many people, total gross.
const { all, get, run, settings } = require('./db');

const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
const err = (m, s = 400) => Object.assign(new Error(m), { status: s });
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

function tzOf(db) {
  const z = settings(db).timezone || 'America/Boise';
  try { new Intl.DateTimeFormat('en-US', { timeZone: z }); return z; } catch { return 'America/Boise'; }
}
// The UTC instant of local midnight at the start of a calendar date in the time zone.
function zonedMidnight(date, tz) {
  const guess = new Date(date + 'T00:00:00Z');
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(guess).map(p => [p.type, p.value]));
  const asLocal = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  const offset = asLocal - guess.getTime();                 // local minus UTC at that moment
  const t = guess.getTime() - offset;
  // second pass handles a DST change between the guess and the answer
  const p2 = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(new Date(t)).map(p => [p.type, p.value]));
  const off2 = Date.UTC(+p2.year, +p2.month - 1, +p2.day, +p2.hour, +p2.minute, +p2.second) - t;
  return new Date(guess.getTime() - off2);
}
const localDate = (iso, tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
const addDays = (d, n) => { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const weekday = d => new Date(d + 'T12:00:00Z').getUTCDay();   // 0 Sun … 6 Sat
const DAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const firstDow = db => (settings(db).workweek_start === 'mon' ? 1 : 0);
const weekStartOf = (d, first) => addDays(d, -((weekday(d) - first + 7) % 7));

function checkPeriod(db, from, to) {
  const first = firstDow(db), last = (first + 6) % 7;
  if (!isDate(from) || !isDate(to)) throw err('Pick the first and last day of the pay period');
  if (to < from) throw err('The period ends before it starts');
  if (weekday(from) !== first) throw err(`A pay period has to start on a ${DAY[first]}, so overtime is figured on whole workweeks`);
  if (weekday(to) !== last) throw err(`A pay period has to end on a ${DAY[last]}, so overtime is figured on whole workweeks`);
  if (addDays(from, 62) < to) throw err('Export at most about two months at a time');
}

function build(db, from, to) {
  checkPeriod(db, from, to);
  const s = settings(db), tz = tzOf(db), first = firstDow(db);
  const otAfter = Number(s.overtime_weekly_hours) || 40, otMult = Number(s.overtime_multiplier) || 1.5;
  const start = zonedMidnight(from, tz), end = zonedMidnight(addDays(to, 1), tz);
  const entries = all(db, `SELECT t.*, u.name user_name, u.email, u.payroll_id, u.timeclock_id, u.hourly_wage current_wage, u.active user_active, u.pay_type, u.salary_annual,
      j.number job_number, j.title job_title, cc.code cost_code
    FROM time_entries t JOIN users u ON u.id = t.user_id LEFT JOIN jobs j ON j.id = t.job_id LEFT JOIN cost_codes cc ON cc.id = t.cost_code_id
    WHERE t.clock_in < ? AND COALESCE(t.clock_out, '9999') > ? ORDER BY t.user_id, t.clock_in, t.id`, end.toISOString(), start.toISOString());

  const warnings = [], people = new Map(), detail = [];
  const newPerson = (u) => ({ user_id: u.user_id, name: u.user_name, email: u.email, employee_id: u.payroll_id || u.timeclock_id || '', current_wage: u.current_wage, active: u.user_active,
    salaried: u.pay_type === 'salary', salary_annual: Number(u.salary_annual) || 0, weeks: new Map(), rates: new Set() });
  const weekRow = wk => ({ week_start: wk, worked: 0, reg: 0, ot: 0, pto: 0, reg_pay: 0, ot_pay: 0, pto_pay: 0 });
  // salaried people are paid every week of the period even with no time clocked
  for (const u of all(db, `SELECT id user_id, name user_name, email, payroll_id, timeclock_id, hourly_wage current_wage, active user_active, pay_type, salary_annual
      FROM users WHERE pay_type = 'salary' AND active = 1`)) people.set(u.user_id, newPerson(u));
  for (const t of entries) {
    if (!t.clock_out) { warnings.push(`${t.user_name} is still clocked in since ${localDate(t.clock_in, tz)} — that time isn't in this export. Clock them out and export again.`); continue; }
    const s0 = Math.max(new Date(t.clock_in).getTime(), start.getTime()), e0 = Math.min(new Date(t.clock_out).getTime(), end.getTime());
    const hours = Math.max(0, (e0 - s0) / 3600000);
    if (!hours) continue;
    if (!people.has(t.user_id)) people.set(t.user_id, newPerson(t));
    const p = people.get(t.user_id);
    const day = localDate(new Date(s0).toISOString(), tz), wk = weekStartOf(day, first);
    if (!p.weeks.has(wk)) p.weeks.set(wk, weekRow(wk));
    const w = p.weeks.get(wk);
    const rate = p.salaried ? 0 : Number(t.hourly_wage) || 0;
    if (!p.salaried) p.rates.add(rate);
    let reg = 0, ot = 0, pto = 0;
    if (t.kind === 'pto') pto = hours;
    else if (p.salaried) { reg = hours; w.worked += hours; }        // exempt: hours for reference, never overtime
    else { reg = Math.max(0, Math.min(hours, otAfter - w.worked)); ot = hours - reg; w.worked += hours; }
    w.reg += reg; w.ot += ot; w.pto += pto;
    if (!p.salaried) { w.reg_pay += reg * rate; w.ot_pay += ot * rate * otMult; w.pto_pay += pto * rate; }
    detail.push({ employee_id: p.employee_id, name: t.user_name, date: day, week_start: wk, kind: t.kind, job: t.job_number ? `${t.job_number} ${t.job_title || ''}`.trim() : '',
      cost_code: t.cost_code || '', clock_in: t.clock_in, clock_out: t.clock_out, hours: r2(hours), regular_hours: r2(reg), overtime_hours: r2(ot), pto_hours: r2(pto),
      rate: p.salaried ? '' : r2(rate), pay: p.salaried ? '' : r2(reg * rate + ot * rate * otMult + pto * rate), pay_type: p.salaried ? 'Salary' : 'Hourly' });
  }

  const weekly = [], summary = [];
  const periodWeeks = [];
  for (let w = from; w <= to; w = addDays(w, 7)) periodWeeks.push(w);
  for (const p of [...people.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    if (p.salaried) {
      const weekly = p.salary_annual / 52;
      for (const wk of periodWeeks) { if (!p.weeks.has(wk)) p.weeks.set(wk, weekRow(wk)); p.weeks.get(wk).reg_pay = weekly; }
      if (!p.salary_annual) warnings.push(`${p.name} is set to salary but has no yearly salary, so their pay shows $0. Set it on the Team page.`);
    }
    const tot = { reg: 0, ot: 0, pto: 0, reg_pay: 0, ot_pay: 0, pto_pay: 0 };
    for (const w of [...p.weeks.values()].sort((a, b) => a.week_start.localeCompare(b.week_start))) {
      for (const k in tot) tot[k] += w[k];
      weekly.push({ employee_id: p.employee_id, name: p.name, email: p.email, pay_type: p.salaried ? 'Salary' : 'Hourly', week_start: w.week_start, week_end: addDays(w.week_start, 6),
        regular_hours: r2(w.reg), overtime_hours: r2(w.ot), pto_hours: r2(w.pto), total_hours: r2(w.reg + w.ot + w.pto),
        regular_pay: r2(w.reg_pay), overtime_pay: r2(w.ot_pay), pto_pay: r2(w.pto_pay), gross_pay: r2(w.reg_pay + w.ot_pay + w.pto_pay) });
    }
    const rate = p.rates.size === 1 ? [...p.rates][0] : p.current_wage;
    if (!p.salaried && p.rates.size > 1) warnings.push(`${p.name} had more than one pay rate in this period (${[...p.rates].map(r => '$' + r2(r).toFixed(2)).join(', ')}); each hour is paid at the rate it was logged at.`);
    if (!p.salaried && ![...p.rates].some(r => r > 0)) warnings.push(`${p.name} has no hourly wage on their time, so their pay shows $0. Set the wage on the Team page, then fix their time entries.`);
    summary.push({ employee_id: p.employee_id, name: p.name, email: p.email, pay_type: p.salaried ? 'Salary' : 'Hourly', period_start: from, period_end: to,
      regular_hours: r2(tot.reg), overtime_hours: r2(tot.ot), pto_hours: r2(tot.pto), total_hours: r2(tot.reg + tot.ot + tot.pto),
      hourly_rate: p.salaried ? '' : r2(rate), overtime_rate: p.salaried ? '' : r2(rate * otMult), salary_per_week: p.salaried ? r2(p.salary_annual / 52) : '', regular_pay: r2(tot.reg_pay), overtime_pay: r2(tot.ot_pay), pto_pay: r2(tot.pto_pay),
      gross_pay: r2(tot.reg_pay + tot.ot_pay + tot.pto_pay) });
  }
  const total = r2(summary.reduce((a, r) => a + r.gross_pay, 0));
  return { from, to, timezone: tz, week_starts: DAY[first], overtime_after: otAfter, overtime_multiplier: otMult, summary, weekly, detail, warnings, total_gross: total,
    total_hours: r2(summary.reduce((a, r) => a + r.total_hours, 0)) };
}

const LAYOUTS = {
  summary: { label: 'One row per employee', rows: r => r.summary, cols: [['Employee ID', 'employee_id'], ['Employee', 'name'], ['Email', 'email'], ['Pay type', 'pay_type'], ['Period start', 'period_start'], ['Period end', 'period_end'],
    ['Regular hours', 'regular_hours'], ['Overtime hours', 'overtime_hours'], ['PTO hours', 'pto_hours'], ['Total hours', 'total_hours'], ['Hourly rate', 'hourly_rate'], ['Overtime rate', 'overtime_rate'], ['Salary per week', 'salary_per_week'],
    ['Regular pay', 'regular_pay'], ['Overtime pay', 'overtime_pay'], ['PTO pay', 'pto_pay'], ['Gross pay', 'gross_pay']] },
  weekly: { label: 'One row per employee per week', rows: r => r.weekly, cols: [['Employee ID', 'employee_id'], ['Employee', 'name'], ['Email', 'email'], ['Pay type', 'pay_type'], ['Week start', 'week_start'], ['Week end', 'week_end'],
    ['Regular hours', 'regular_hours'], ['Overtime hours', 'overtime_hours'], ['PTO hours', 'pto_hours'], ['Total hours', 'total_hours'],
    ['Regular pay', 'regular_pay'], ['Overtime pay', 'overtime_pay'], ['PTO pay', 'pto_pay'], ['Gross pay', 'gross_pay']] },
  detail: { label: 'Every time entry', rows: r => r.detail, cols: [['Employee ID', 'employee_id'], ['Employee', 'name'], ['Pay type', 'pay_type'], ['Date', 'date'], ['Week start', 'week_start'], ['Type', 'kind'], ['Job', 'job'], ['Cost code', 'cost_code'],
    ['Clock in', 'clock_in'], ['Clock out', 'clock_out'], ['Hours', 'hours'], ['Regular hours', 'regular_hours'], ['Overtime hours', 'overtime_hours'], ['PTO hours', 'pto_hours'], ['Rate', 'rate'], ['Pay', 'pay']] },
};
// cells starting with = + - @ are prefixed so a spreadsheet won't run them as formulas
const cell = v => { let s = String(v ?? ''); if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = "'" + s; return `"${s.replace(/"/g, '""')}"`; };
function toCSV(result, layout) {
  const L = LAYOUTS[layout];
  if (!L) throw err('Unknown export layout');
  return [L.cols.map(c => cell(c[0])).join(','), ...L.rows(result).map(r => L.cols.map(c => cell(r[c[1]])).join(','))].join('\r\n') + '\r\n';
}
function exportCSV(db, { from, to, layout = 'summary', userId }) {
  if (!LAYOUTS[layout]) throw err('Unknown export layout');
  const r = build(db, from, to);
  const csv = toCSV(r, layout);
  run(db, 'INSERT INTO payroll_exports (period_start, period_end, layout, employees, total_hours, total_gross, warnings, user_id) VALUES (?,?,?,?,?,?,?,?)',
    from, to, layout, r.summary.length, r.total_hours, r.total_gross, r.warnings.length, userId || null);
  return { csv, filename: `payroll_${from}_to_${to}_${layout}.csv`, result: r };
}
function history(db) {
  return all(db, `SELECT x.*, u.name user_name FROM payroll_exports x LEFT JOIN users u ON u.id = x.user_id ORDER BY x.id DESC LIMIT 25`);
}
function lastPeriod(db) {    // the most recent full week, or the two-week period if the last export was two weeks long
  const tz = tzOf(db), today = localDate(new Date().toISOString(), tz);
  const lastMon = addDays(weekStartOf(today, firstDow(db)), -7);   // start of the last full workweek
  const prev = get(db, 'SELECT period_start, period_end FROM payroll_exports ORDER BY id DESC LIMIT 1');
  const len = prev ? Math.round((new Date(prev.period_end) - new Date(prev.period_start)) / 86400000) + 1 : 7;
  const weeks = len >= 14 ? 2 : 1;
  return { from: addDays(lastMon, -7 * (weeks - 1)), to: addDays(lastMon, 6) };
}

module.exports = { build, exportCSV, toCSV, history, lastPeriod, zonedMidnight, LAYOUTS: Object.fromEntries(Object.entries(LAYOUTS).map(([k, v]) => [k, v.label])) };
