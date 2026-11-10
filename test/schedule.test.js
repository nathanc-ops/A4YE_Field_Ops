'use strict';
// Project schedule (the job tracker's Schedule & Gantt tab): task math, statuses, Gantt weeks / manpower, permissions.
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
const cc = code => db.prepare('SELECT id FROM cost_codes WHERE code = ?').get(code).id;
const day = n => { const d = new Date(Date.now() + n * 864e5); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

before(async () => {
  db = D.open(':memory:');
  server = createApp(db).listen(0); await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  tok.admin = (await call(null, 'POST', '/setup', { name: 'Owner', email: 'o@x.com', password: 'longenough' })).data.token;
  ids.tech = (await call('admin', 'POST', '/users', { name: 'Jay', email: 'j@x.com', password: 'password123', role: 'tech', hourly_wage: 40 })).data.id;
  ids.other = (await call('admin', 'POST', '/users', { name: 'Kim', email: 'k@x.com', password: 'password123', role: 'tech', hourly_wage: 40 })).data.id;
  tok.tech = (await call(null, 'POST', '/login', { email: 'j@x.com', password: 'password123' })).data.token;
  tok.other = (await call(null, 'POST', '/login', { email: 'k@x.com', password: 'password123' })).data.token;
  ids.cust = (await call('admin', 'POST', '/customers', { name: 'Summit GC' })).data.id;
  ids.job = (await call('admin', 'POST', '/jobs', { customer_id: ids.cust, title: 'Clinic TI', is_project: 1, billing_type: 'fixed', contract_amount: 80000, tech_ids: [ids.tech],
    start_date: day(-20), end_date: day(40) })).data.id;
  await call('admin', 'PUT', `/jobs/${ids.job}/budgets`, { budgets: [{ cost_code_id: cc('0810'), budget_hours: 200 }, { cost_code_id: cc('1010'), budget_hours: 80 }] });
  // 3 × 8 h on raceway inside the task window, 8 h outside it, 8 h on devices
  const ins = db.prepare("INSERT INTO time_entries (user_id, job_id, kind, clock_in, clock_out, hourly_cost, hourly_wage, cost_code_id) VALUES (?,?, 'job', ?, ?, 50, 40, ?)");
  const at = (n, h) => { const d = new Date(Date.now() + n * 864e5); d.setHours(h, 0, 0, 0); return d.toISOString(); };
  for (const n of [-9, -8, -7]) ins.run(ids.tech, ids.job, at(n, 7), at(n, 15), cc('0810'));
  ins.run(ids.tech, ids.job, at(-15, 7), at(-15, 15), cc('0810'));
  ins.run(ids.tech, ids.job, at(-3, 7), at(-3, 15), cc('1010'));
});
after(() => server.close());

test('build from budget, then task math: work days, planned %, earned, actual from the time clock, SPI, status', async () => {
  const b = await call('admin', 'POST', `/projects/${ids.job}/schedule/build`);
  assert.equal(b.status, 200, JSON.stringify(b.data)); assert.equal(b.data.added, 2);
  assert.equal((await call('admin', 'POST', `/projects/${ids.job}/schedule/build`)).status, 400, 'nothing left to add');
  let s = (await call('admin', 'GET', `/projects/${ids.job}/schedule`)).data;
  const race = s.rows.find(r => r.cost_code === '0810'), dev = s.rows.find(r => r.cost_code === '1010');
  assert.equal(race.budget_hours, 200); assert.equal(race.ref, 'T-001'); assert.ok(race.phase, 'phase from the A4YE code');
  ids.race = race.id; ids.dev = dev.id;
  // raceway: 10 days, started 10 days ago, today is day 11 of 10 → planned 100%
  let r = await call('admin', 'PUT', `/schedule/${ids.race}`, { start_date: day(-10), finish_date: day(-1), pct_complete: 50 });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  r = await call('admin', 'PUT', `/schedule/${ids.dev}`, { start_date: day(-4), finish_date: day(5), predecessor_id: ids.race });
  s = (await call('admin', 'GET', `/projects/${ids.job}/schedule`)).data;
  const R = s.rows.find(x => x.id === ids.race), V = s.rows.find(x => x.id === ids.dev);
  assert.equal(R.planned_pct, 100); assert.equal(R.planned_hours, 200); assert.equal(R.earned_hours, 100);
  assert.equal(R.actual_hours, 24, 'only entries inside start–finish on its code');
  assert.equal(R.hours_variance, 76); assert.equal(R.spi, 0.5); assert.equal(R.status, 'Late');
  assert.ok(R.work_days >= 6 && R.work_days <= 8, `10 calendar days → 6–8 work days (${R.work_days})`);
  assert.equal(V.status, 'Update %', 'started with no % entered'); assert.equal(V.actual_hours, 8); assert.equal(V.planned_pct, 50);
  assert.equal(V.pred_ref, 'T-001'); assert.equal(V.pred_conflict, true, 'starts before its predecessor finishes');
  assert.ok(R.float_days < 0, 'successor already started → negative float');
  assert.equal(V.lookahead, true);
  // statuses
  await call('admin', 'PUT', `/schedule/${ids.dev}`, { pct_complete: 0 });
  assert.equal((await call('admin', 'GET', `/projects/${ids.job}/schedule`)).data.rows.find(x => x.id === ids.dev).status, 'Late Start');
  await call('admin', 'PUT', `/schedule/${ids.race}`, { pct_complete: 100 });
  s = (await call('admin', 'GET', `/projects/${ids.job}/schedule`)).data;
  assert.equal(s.rows.find(x => x.id === ids.race).status, 'Complete');
  assert.equal(s.totals.budget_hours, 280); assert.equal(s.totals.earned_hours, 200);
  // as-of date moves planned %
  const early = (await call('admin', 'GET', `/projects/${ids.job}/schedule?as_of=${day(-6)}`)).data.rows.find(x => x.id === ids.race);
  assert.equal(early.planned_pct, 50);
});

test('validation: dates, %, loops, other project', async () => {
  assert.equal((await call('admin', 'PUT', `/schedule/${ids.dev}`, { start_date: day(5), finish_date: day(1) })).status, 400);
  assert.equal((await call('admin', 'PUT', `/schedule/${ids.dev}`, { pct_complete: 120 })).status, 400);
  assert.equal((await call('admin', 'PUT', `/schedule/${ids.race}`, { predecessor_id: ids.dev })).status, 400, 'loop');
  assert.equal((await call('admin', 'PUT', `/schedule/${ids.race}`, { predecessor_id: ids.race })).status, 400, 'self');
  assert.equal((await call('admin', 'POST', `/projects/${ids.job}/schedule`, { phase: 'P3' })).status, 400, 'name required');
  const t = await call('admin', 'POST', `/projects/${ids.job}/schedule`, { name: 'Owner furnished fixtures by others', start_date: day(10), finish_date: day(12) });
  assert.equal(t.status, 200);
  const row = (await call('admin', 'GET', `/projects/${ids.job}/schedule`)).data.rows.find(x => x.id === t.data.id);
  assert.equal(row.status, 'By Others'); assert.equal(row.ref, 'T-003');
  await call('admin', 'PUT', `/schedule/${t.data.id}`, { on_hold: true, budget_hours: 4 });
  assert.equal((await call('admin', 'GET', `/projects/${ids.job}/schedule`)).data.rows.find(x => x.id === t.data.id).status, 'On Hold');
});

test('Gantt weeks: planned hours spread by calendar overlap, crew, actual by week, schedule start snaps to Monday', async () => {
  const r = await call('admin', 'PUT', `/projects/${ids.job}/schedule-start`, { schedule_start: day(-20) });
  assert.equal(r.status, 200);
  const s = (await call('admin', 'GET', `/projects/${ids.job}/schedule`)).data;
  assert.equal(new Date(s.schedule_start + 'T00:00:00Z').getUTCDay(), 1);
  assert.equal(s.weeks[0].week_start, s.schedule_start);
  const planned = s.weeks.reduce((x, w) => x + w.planned_hours, 0);
  assert.ok(Math.abs(planned - 284) < 0.5, `all budget hours land in some week (${planned})`);
  const actual = s.weeks.reduce((x, w) => x + w.actual_hours, 0);
  assert.equal(actual, 40);
  const w = s.weeks.find(x => x.planned_hours > 0);
  assert.equal(w.planned_crew, Math.round(w.planned_hours / (8 * 5 * 0.92) * 10) / 10);
});

test('permissions: crew on the job posts % only; others cannot; office needs the projects permission', async () => {
  let r = await call('tech', 'PUT', `/schedule/${ids.dev}`, { pct_complete: 40 });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal((await call('tech', 'PUT', `/schedule/${ids.dev}`, { budget_hours: 999 })).status, 403);
  assert.equal(db.prepare('SELECT budget_hours FROM project_tasks WHERE id = ?').get(ids.dev).budget_hours, 80);
  assert.equal((await call('tech', 'POST', `/projects/${ids.job}/schedule`, { name: 'x' })).status, 403);
  assert.equal((await call('tech', 'DELETE', `/schedule/${ids.dev}`)).status, 403);
  assert.equal((await call('other', 'PUT', `/schedule/${ids.dev}`, { pct_complete: 90 })).status, 403, 'not on the job');
  assert.equal((await call('tech', 'GET', `/projects/${ids.job}/schedule`)).data.can_edit, false);
  // dashboard flag once a started task has nothing done
  await call('admin', 'PUT', `/schedule/${ids.dev}`, { pct_complete: 0 });
  const p = (await call('admin', 'GET', `/projects/${ids.job}`)).data;
  assert.equal(p.summary.logs.tasks_late, 1);
  const flags = JSON.stringify(p);
  assert.match(flags, /schedule task/);
});

test('manpower loading: class split from foreman/title, overtime past 40 h across all jobs, all-projects roll-up', async () => {
  const apprentice = (await call('admin', 'POST', '/users', { name: 'Al', email: 'al@x.com', password: 'password123', role: 'tech', title: 'Apprentice 2nd yr', hourly_wage: 22 })).data.id;
  db.prepare('UPDATE jobs SET foreman_id = ? WHERE id = ?').run(ids.tech, ids.job);
  // a fresh week four weeks out: 36 h for Al on a service job first, then 8 h on the project → 4 h of it is OT
  const other = (await call('admin', 'POST', '/jobs', { customer_id: ids.cust, title: 'Service call' })).data.id;
  const mon = new Date(); mon.setDate(mon.getDate() - ((mon.getDay() + 6) % 7) + 28);
  const at = (d, h) => { const x = new Date(mon); x.setDate(x.getDate() + d); x.setHours(h, 0, 0, 0); return x.toISOString(); };
  const ins = db.prepare("INSERT INTO time_entries (user_id, job_id, kind, clock_in, clock_out, hourly_cost, hourly_wage) VALUES (?,?, 'job', ?, ?, 30, 22)");
  for (const d of [0, 1, 2]) ins.run(apprentice, other, at(d, 6), at(d, 18));         // 36 h
  ins.run(apprentice, ids.job, at(3, 7), at(3, 15));                                   // 8 h, 4 OT
  // make the schedule reach that week
  await call('admin', 'PUT', `/schedule/${ids.dev}`, { finish_date: (() => { const x = new Date(mon); x.setDate(x.getDate() + 6); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; })() });
  const m = await call('admin', 'GET', `/projects/${ids.job}/manpower`);
  assert.equal(m.status, 200, JSON.stringify(m.data));
  assert.deepEqual(m.data.classes, ['Foreman', 'Journeyman', 'Apprentice', 'Office']);
  assert.equal(m.data.totals.by_class.Foreman, 40, "Jay is the job's foreman");
  assert.equal(m.data.totals.by_class.Apprentice, 8);
  assert.equal(m.data.totals.ot_hours, 4);
  const wk = m.data.weeks.find(w => w.by_class.Apprentice === 8);
  assert.equal(wk.ot_hours, 4); assert.equal(wk.ot_pct, 50); assert.equal(wk.headcount, 1);
  assert.equal(m.data.totals.actual_hours, 48);
  assert.ok(m.data.peak_planned_crew_remaining >= 0);
  // all projects (office only)
  const a = await call('admin', 'GET', '/manpower?back=8&ahead=8');
  assert.equal(a.status, 200); assert.equal(a.data.weeks.length, 16);
  assert.equal(a.data.weeks.reduce((x, w) => x + w.by_class.Apprentice, 0), 8, 'service-job hours are not project manpower');
  assert.ok(a.data.jobs.some(j => j.id === ids.job && j.planned_crew.some(Boolean)));
  assert.equal((await call('tech', 'GET', '/manpower')).status, 403);
});

test('weekly history: cumulative PV/EV/AC by week, recorded % beats the hours proxy, PM can type over a week', async () => {
  const h = await call('admin', 'GET', `/projects/${ids.job}/weekly-history`);
  assert.equal(h.status, 200, JSON.stringify(h.data));
  const W = h.data.weeks, last = W[W.length - 1];
  assert.equal(last.week_ending, h.data.current_week_ending);
  assert.equal(new Date(last.week_ending + 'T00:00:00Z').getUTCDay(), 0, 'weeks end Sunday');
  assert.ok(W.length >= 3);
  for (let i = 1; i < W.length; i++) assert.ok(W[i].actual_hours >= W[i - 1].actual_hours && W[i].ac >= W[i - 1].ac, 'cumulative');
  assert.equal(last.pct_source, 'auto', 'this week captured automatically');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM project_progress WHERE job_id = ?').get(ids.job).n, 1);
  // an earlier week falls back to hours ÷ budget hours
  const early = W.find(w => w.actual_hours > 0 && w.pct_source === 'hours');
  assert.equal(early.pct_complete, Math.round(early.actual_hours / h.data.budget_hours * 1000) / 10);
  assert.equal(early.ev, Math.round(early.revised_budget * early.pct_complete / 100));
  // PM types over it
  assert.equal((await call('admin', 'PUT', `/projects/${ids.job}/progress`, { week_ending: early.week_start, pct_complete: 30, note: 'per GC walk' })).status, 200);
  let w2 = (await call('admin', 'GET', `/projects/${ids.job}/weekly-history`)).data.weeks.find(w => w.week_ending === early.week_ending);
  assert.equal(w2.pct_complete, 30); assert.equal(w2.pct_source, 'manual'); assert.equal(w2.earned_hours, Math.round(h.data.budget_hours * 0.3 * 10) / 10);
  // the automatic snapshot never overwrites a manual week
  await call('admin', 'PUT', `/projects/${ids.job}/progress`, { week_ending: last.week_ending, pct_complete: 12 });
  await call('admin', 'GET', `/projects/${ids.job}/weekly-history`);
  assert.equal(db.prepare('SELECT pct_complete FROM project_progress WHERE job_id = ? AND week_ending = ?').get(ids.job, last.week_ending).pct_complete, 12);
  // blank → back to automatic / hours
  await call('admin', 'PUT', `/projects/${ids.job}/progress`, { week_ending: early.week_ending, pct_complete: '' });
  w2 = (await call('admin', 'GET', `/projects/${ids.job}/weekly-history`)).data.weeks.find(w => w.week_ending === early.week_ending);
  assert.equal(w2.pct_source, 'hours');
  assert.equal((await call('admin', 'PUT', `/projects/${ids.job}/progress`, { week_ending: '2099-01-04', pct_complete: 5 })).status, 400, 'future week');
  assert.equal((await call('tech', 'PUT', `/projects/${ids.job}/progress`, { week_ending: early.week_ending, pct_complete: 5 })).status, 403);
});

test('bi-weekly report: all sections, GC copy hides our costs, issuing freezes the numbers, narrative locks', async () => {
  // an open RFI and a pending CO so those sections have rows
  await call('admin', 'POST', `/projects/${ids.job}/rfis`, { subject: 'Panel L2 location', date_sent: day(-5), date_needed: day(-1) });
  const r = await call('admin', 'GET', `/projects/${ids.job}/biweekly`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const d = r.data.data;
  assert.equal(d.period_start, day(-13)); assert.equal(d.period_end, day(0));
  assert.equal(d.info.customer_name, 'Summit GC');
  assert.equal(d.financial.revised_contract, 80000);
  assert.ok(d.financial.budget_cost > 0 && d.financial.actual_cost > 0);
  assert.equal(d.phases.length >= 10, true, 'P0–P9 always listed');
  assert.ok(d.phases.some(p => p.budget > 0));
  assert.ok(d.production.labor_hours > 0); assert.ok(d.production.labor_cost > 0);
  assert.equal(d.rfis.length, 1); assert.equal(d.rfis[0].days_late >= 1, true);
  assert.ok(Array.isArray(d.lookahead) && Array.isArray(d.milestones) && Array.isArray(d.safety) && Array.isArray(d.change_orders));
  const gc = (await call('admin', 'GET', `/projects/${ids.job}/biweekly?gc=1`)).data.data;
  assert.equal(gc.gc_copy, true);
  assert.equal(gc.phases, undefined); assert.equal(gc.financial.budget_cost, undefined); assert.equal(gc.financial.projected_margin_pct, undefined); assert.equal(gc.production.labor_cost, undefined);
  assert.equal(gc.financial.revised_contract, 80000, 'contract and billing stay');
  // narrative, issue, frozen
  assert.equal((await call('admin', 'PUT', `/projects/${ids.job}/biweekly`, { progress: 'Rough-in 80% in conference room', decisions: 'Need fixture approval' })).status, 200);
  assert.equal((await call('admin', 'POST', `/projects/${ids.job}/biweekly/issue`, {})).status, 200);
  const hoursBefore = (await call('admin', 'GET', `/projects/${ids.job}/biweekly`)).data.data.production.labor_hours;
  db.prepare("INSERT INTO time_entries (user_id, job_id, kind, clock_in, clock_out, hourly_cost, hourly_wage) VALUES (?, ?, 'job', ?, ?, 50, 40)")
    .run(ids.tech, ids.job, new Date(Date.now() - 2 * 864e5).toISOString(), new Date(Date.now() - 2 * 864e5 + 5 * 36e5).toISOString());
  const after = (await call('admin', 'GET', `/projects/${ids.job}/biweekly`)).data;
  assert.equal(after.data.production.labor_hours, hoursBefore, 'issued report does not move');
  assert.equal(after.report.status, 'issued'); assert.equal(after.report.progress, 'Rough-in 80% in conference room');
  assert.equal((await call('admin', 'PUT', `/projects/${ids.job}/biweekly`, { progress: 'x' })).status, 400);
  const list = (await call('admin', 'GET', `/projects/${ids.job}/reports`)).data;
  assert.equal(list.length, 1); assert.equal(list[0].status, 'issued');
  assert.equal((await call('admin', 'POST', `/project-reports/${list[0].id}/reopen`)).status, 200);
  assert.equal((await call('admin', 'GET', `/projects/${ids.job}/biweekly`)).data.data.production.labor_hours, Math.round((hoursBefore + 5) * 10) / 10, 'live again after reopening');
  assert.equal((await call('admin', 'GET', `/projects/${ids.job}/biweekly?period_end=2099-01-01`)).status, 400);
  assert.equal((await call('tech', 'GET', `/projects/${ids.job}/biweekly`)).status, 403);
});

test('estimate import: parse pasted quote rows, codes from the phase code, skip subtotals, replace/add budgets, undo an import', async () => {
  const job = (await call('admin', 'POST', '/jobs', { customer_id: ids.cust, title: 'Warehouse', is_project: 1, billing_type: 'fixed', contract_amount: 50000 })).data.id;
  const T = (...c) => c.join('\t');
  const text = [
    T('Phase Code', 'Phase', 'Tag', 'Description', 'Qty', 'Unit', 'Material $/Unit', 'NECA', 'Factor', 'Adj', 'Labor $/Unit', 'Total', 'Ext Mat', 'Ext Lab', 'Ext Cost', 'Notes'),
    T('LAB-P2-0810-L', 'Rough-In', 'A1', '3/4" EMT', '1,000', 'ft', '$1.20', '0.04', '1.1', '', '', '', '', '', '', 'from takeoff'),
    T('1010-L', 'Trim', '', 'Duplex receptacles', '40', 'ea', '3.5', '', '', '0.5', '', '', '', '$900', '', ''),
    T('P2-0810-M', 'Rough-In', '', 'EMT fittings', '1', 'lot', '', '', '', '', '', '', '450', '', '', ''),
    T('9999', '', '', 'Mystery item', '2', 'ea', '10', '1', '', '', '', '', '', '', '', ''),
    T('', '', '', 'Rough-in subtotal', '1', '', '', '', '', '', '', '', '', '', '', ''),
    T('0810', '', '', 'Notes row, no qty', '', '', '', '', '', '', '', '', '', '', '', ''),
    T('', 'Sub', '', 'Fire alarm subcontract', '1', 'ls', '12000', '', '', '', '', '', '', '', '', ''),
  ].join('\n');
  const pv = await call('admin', 'POST', `/projects/${job}/quote-import/preview`, { text, source: 'Rough-In tab' });
  assert.equal(pv.status, 200, JSON.stringify(pv.data));
  const L = pv.data.lines;
  assert.equal(L.length, 7, 'header row dropped');
  const emt = L.find(l => l.description === '3/4" EMT');
  assert.equal(emt.code, '0810'); assert.equal(emt.area, 'LAB'); assert.equal(emt.cost_type, 'L'); assert.equal(emt.status, 'OK');
  assert.equal(emt.hours, 44, '1000 × 0.04 × 1.1'); assert.equal(emt.material, 1200);
  const rec = L.find(l => l.description === 'Duplex receptacles');
  assert.equal(rec.hours, 20); assert.equal(rec.labor, 900, 'Ext. Labor wins'); assert.equal(rec.material, 140);
  assert.equal(L.find(l => l.description === 'EMT fittings').cost_type, 'M');
  assert.match(L.find(l => l.description === 'Mystery item').status, /not on the cost code list/);
  assert.match(L.find(l => /subtotal/.test(l.description)).status, /Skipped/);
  assert.match(L.find(l => /no qty/.test(l.description)).status, /Skipped/);
  assert.match(L.find(l => /Fire alarm/.test(l.description)).status, /NO COST CODE/);
  assert.equal(pv.data.totals.need_code, 2);
  // refuse while lines need codes, unless told to skip them
  assert.equal((await call('admin', 'POST', `/projects/${job}/quote-import`, { text })).status, 400);
  const fa = L.find(l => /Fire alarm/.test(l.description)).row;
  const ov = { [fa]: { code: '1610' } };
  const pv2 = (await call('admin', 'POST', `/projects/${job}/quote-import/preview`, { text, overrides: ov })).data;
  const faLine = pv2.lines.find(l => l.row === fa);
  assert.equal(faLine.status, 'OK', 'override gives the sub line a code');
  const r = await call('admin', 'POST', `/projects/${job}/quote-import`, { text, overrides: ov, skip_uncoded: true, source: 'Rough-In tab' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const b = db.prepare('SELECT cc.code, jb.* FROM job_budgets jb JOIN cost_codes cc ON cc.id = jb.cost_code_id WHERE jb.job_id = ? ORDER BY cc.code').all(job);
  const b0810 = b.find(x => x.code === '0810');
  assert.equal(b0810.budget_hours, 44); assert.equal(b0810.budget_material, 1650, 'EMT + fittings');
  assert.equal(b.find(x => x.code === '1610').budget_material, 12000, 'type L default → material');
  assert.equal(db.prepare('SELECT budget_hours FROM jobs WHERE id = ?').get(job).budget_hours, 64);
  // % complete survives a replace; a second import in add mode stacks; undo takes it back out
  db.prepare("UPDATE job_budgets SET percent_complete = 25 WHERE job_id = ? AND cost_code_id = (SELECT id FROM cost_codes WHERE code = '0810')").run(job);
  const add = T('0810-L', '', '', 'More EMT', '500', 'ft', '1.2', '0.04', '', '', '', '', '', '', '', '');
  const a = await call('admin', 'POST', `/projects/${job}/quote-import`, { text: add, mode: 'add', source: 'Addendum 1' });
  assert.equal(a.status, 200, JSON.stringify(a.data));
  let r0810 = db.prepare("SELECT * FROM job_budgets WHERE job_id = ? AND cost_code_id = (SELECT id FROM cost_codes WHERE code = '0810')").get(job);
  assert.equal(r0810.budget_hours, 64); assert.equal(r0810.percent_complete, 25);
  const ql = (await call('admin', 'GET', `/projects/${job}/quote-lines`)).data;
  assert.equal(ql.imports.length, 2);
  assert.equal((await call('admin', 'DELETE', `/projects/${job}/quote-import/${a.data.import_id}`)).status, 200);
  r0810 = db.prepare("SELECT * FROM job_budgets WHERE job_id = ? AND cost_code_id = (SELECT id FROM cost_codes WHERE code = '0810')").get(job);
  assert.equal(r0810.budget_hours, 44);
  assert.equal((await call('tech', 'POST', `/projects/${job}/quote-import/preview`, { text })).status, 403);
});

test('emailing the bi-weekly report: issued only, GC copy behind a link, outbox + sent tracking, reopen kills the link', async () => {
  db.prepare('UPDATE jobs SET gc_email = ?, gc_contact = ? WHERE id = ?').run('ray@summitgc.com', 'Ray Patel', ids.job);
  const rc = (await call('admin', 'GET', `/projects/${ids.job}/biweekly/recipients`)).data;
  assert.equal(rc.to, 'ray@summitgc.com'); assert.equal(rc.cc, 'o@x.com'); assert.equal(rc.smtp, false);
  // the earlier test reopened today's report → draft: refused
  let r = await call('admin', 'POST', `/projects/${ids.job}/biweekly/email`, { to: 'ray@summitgc.com' });
  assert.equal(r.status, 400); assert.match(r.data.error, /Issue the report first/);
  await call('admin', 'PUT', `/projects/${ids.job}/biweekly`, { decisions: 'Approve fixture substitution' });
  await call('admin', 'POST', `/projects/${ids.job}/biweekly/issue`, {});
  assert.equal((await call('admin', 'POST', `/projects/${ids.job}/biweekly/email`, { to: 'not an email' })).status, 400);
  assert.equal((await call('admin', 'POST', `/projects/${ids.job}/biweekly/email`, { to: '' })).status, 400);
  r = await call('admin', 'POST', `/projects/${ids.job}/biweekly/email`, { to: 'ray@summitgc.com, pm@summitgc.com', cc: 'o@x.com', message: 'See attached progress.' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.status, 'not_configured', 'no SMTP in tests: recorded, link returned');
  assert.match(r.data.url, /\/p\/report\/[A-Za-z0-9_-]{20,}$/);
  const ob = db.prepare("SELECT * FROM outbox WHERE related LIKE 'report:%' ORDER BY id DESC").get();
  assert.equal(ob.to_email, 'ray@summitgc.com, pm@summitgc.com, o@x.com');
  assert.match(ob.subject, /Bi-weekly report: J-\d+ Clinic TI/);
  assert.match(ob.body, /Decisions needed from you:\nApprove fixture substitution/);
  assert.match(ob.body, /Full report: http/);
  assert.doesNotMatch(ob.body, /margin|budget cost/i, 'no internal numbers in the email');
  const token = r.data.url.split('/').pop();
  // the public link: GC copy, no login
  const pub = await fetch(`${base}/api/public/report/${token}`).then(x => x.json());
  assert.equal(pub.data.gc_copy, true); assert.equal(pub.data.phases, undefined); assert.equal(pub.data.financial.budget_cost, undefined);
  assert.equal(pub.report.decisions, 'Approve fixture substitution');
  assert.equal((await fetch(`${base}/p/report/${token}`)).status, 200);
  const rep = (await call('admin', 'GET', `/projects/${ids.job}/biweekly`)).data.report;
  assert.ok(rep.sent_at); assert.match(rep.sent_to, /ray@summitgc.com/); assert.ok(rep.viewed_at, 'the GC opened it'); assert.equal(rep.public_url, r.data.url);
  // a second send reuses the same link
  const r2 = await call('admin', 'POST', `/projects/${ids.job}/biweekly/email`, { to: 'ray@summitgc.com' });
  assert.equal(r2.data.url, r.data.url);
  // reopening kills the link
  await call('admin', 'POST', `/project-reports/${rep.id}/reopen`);
  assert.equal((await fetch(`${base}/api/public/report/${token}`)).status, 404);
  assert.equal((await call('tech', 'POST', `/projects/${ids.job}/biweekly/email`, { to: 'ray@summitgc.com' })).status, 403);
});

test('imported quote prices the budget: budget cost = quote total (quote labor $/h, not the crew rate); blended rate is the last fallback', async () => {
  const Bill = require('../server/billing');
  const job = (await call('admin', 'POST', '/jobs', { customer_id: ids.cust, title: 'Pump station', is_project: 1, billing_type: 'fixed', contract_amount: 90000 })).data.id;
  const T = (...c) => c.join('\t');
  const text = [T('0810-L', '', '', 'EMT', '100', 'ft', '2', '', '', '0.5', '', '', '', '3500', '', ''), T('1010-L', '', '', 'Devices', '10', 'ea', '5', '', '', '1', '', '', '', '700', '', '')].join('\n');
  const r = await call('admin', 'POST', `/projects/${job}/quote-import`, { text });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.totals.total, 200 + 3500 + 50 + 700);
  const j = db.prepare('SELECT * FROM jobs WHERE id = ?').get(job);
  assert.equal(Bill.budgetCost(db, j), 4450, 'quote labor $, whatever the crew earns');
  db.prepare("UPDATE job_budgets SET budget_hours = 100 WHERE job_id = ? AND cost_code_id = (SELECT id FROM cost_codes WHERE code = '0810')").run(job);
  assert.equal(Bill.budgetCost(db, j), 4450 + 3500, 'edited hours keep the quote rate ($70/h)');
  // a job with no time, no crew and no wages anywhere falls back to the blended rate setting
  const D2 = require('../server/db').open(':memory:');
  D2.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('blended_labor_rate', '39.34')").run();
  assert.equal(Bill.laborRate(D2, { id: 999 }), 39.34);
});
