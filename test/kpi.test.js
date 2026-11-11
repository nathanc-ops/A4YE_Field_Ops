'use strict';
// Weekly KPIs: import from the KPI Dashboard workbook, who sees and fills in what, formulas, status colours, cause/fix
// before submit, the company scorecard. Made-up people and metrics only.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const D = require('../server/db');
const { createApp } = require('../server/app');
const { xlsx } = require('./_xlsx');
const K = require('../server/kpi');

let server, base, db;
const tok = {}, ids = {};
async function call(who, method, p, body) {
  const res = await fetch(base + '/api' + p, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok[who] }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json() };
}
// a tab from rows of arrays (row 1 = headers)
const tab = rows => Object.fromEntries(rows.flatMap((r, i) => r.map((v, j) => [`${String.fromCharCode(65 + j)}${i + 1}`, v]).filter(([, v]) => v !== undefined && v !== '')));
const H = ['ID', 'Owner', 'Section', 'Metric', 'Unit', 'Better', 'Target', 'Input', 'Rule', 'Source', 'How measured', 'Target note', 'Active'];
const WEEK = '2026-10-25'; // a Sunday
function workbook() {
  return xlsx({
    Metrics: tab([H,
      ['P1', 'Pat', 'Calls', 'Total calls', '#', 'Higher', 100, 'manual', '', 'Phone system', 'Calls received', '', 'Y'],
      ['P2', 'Pat', 'Calls', 'Missed calls', '#', 'Lower', 10, 'manual', '', 'Phone system', 'Not answered', '', 'Y'],
      ['P3', 'Pat', 'Calls', 'Missed call rate %', '%', 'Lower', 0.06, 'calc', 'P2/P1', 'Calculated', 'Missed ÷ total', '', 'Y'],
      ['P4', 'Pat', 'Leads', 'Leads – other', '#', 'Info', '', 'manual', '', 'CRM', 'Count', '', 'Y'],
      ['P5', 'Pat', 'Leads', 'Retired metric', '#', 'Higher', 5, 'manual', '', '', '', '', 'N'],
      ['L1', 'Lee', 'Revenue', 'Revenue completed ($)', '$', 'Higher', 1000, 'auto', 'some_api_source', 'Billing system', 'Jobs completed', '', 'Y'],
      ['L2', 'Lee', 'Labor', 'Overtime hours', 'hrs', 'Lower', 5, 'manual', '', 'Time clock', 'Over 40', '', 'Y'],
      ['L3', 'Lee', 'Labor', 'Overtime cost ($)', '$', 'Lower', '', 'calc', 'L2*OT_RATE', 'Calculated', 'OT × rate', '', 'Y'],
      ['L4', 'Lee', 'Revenue', 'Revenue per call ($)', '$', 'Higher', 10, 'calc', 'L1/(P1-P2)', 'Calculated', 'Revenue ÷ answered calls', 'Cross-page formula', 'Y']]),
    Settings: tab([['Key', 'Value', 'What it does'], ['TIMEZONE', 'America/Boise'], ['BAND', 0.25], ['OT_RATE', 50], ['DUE_DAYS_AFTER_WEEK_END', 3], ['DUE_TIME', '23:59'],
      ['HISTORY_WEEKS', 6], ['ADMINS', 'boss@x.com'], ['MASTER_VIEWERS', 'viewer@x.com, boss@x.com, nobody@x.com'], ['EMAIL_Pat', 'pat@x.com'], ['EMAIL_Lee', 'LEE@x.com'],
      ['TIMECLOCK_SHEET_ID', 'not-read']]),
    Values: tab([['Week', 'ID', 'Value', 'Origin', 'Source', 'Entered by', 'Entered at', 'Reason'],
      [WEEK, 'P1', 90, 'manual', '', 'pat@x.com', '2026-10-27 09:15'], [WEEK, 'P2', 14, 'manual', '', 'pat@x.com', '2026-10-27 09:15'],
      [WEEK, 'L1', 1200, 'auto', '', 'script', '2026-10-27 05:00'], ['2026-10-18', 'P1', 120, 'manual', '', 'pat@x.com', '2026-10-20 09:00'],
      ['2026-10-26', 'P1', 5, 'manual', '', 'pat@x.com', '2026-10-27 09:00'], [WEEK, 'ZZ9', 1, 'manual']]),
    Notes: tab([['Week', 'ID', 'Owner', 'Cause', 'Fix', 'By', 'At'], [WEEK, 'P2', 'Pat', 'Spam calls', 'Block numbers', 'pat@x.com', '2026-10-27 09:16']]),
    Submissions: tab([['Week', 'Owner', 'Submitted at', 'By'], ['2026-10-18', 'Pat', '2026-10-20 09:05', 'pat@x.com']]),
    HCP_Invoices: tab([['Customer', 'Amount'], ['Somebody Real', 123]]),
  }).toString('base64');
}

before(async () => {
  db = D.open(':memory:');
  server = createApp(db).listen(0); await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  tok.admin = (await call(null, 'POST', '/setup', { name: 'Owner Admin', email: 'owner@x.com', password: 'longenough' })).data.token;
  await call('admin', 'PUT', '/settings', { timezone: 'America/Boise' });
  for (const [k, name, role] of [['pat', 'Pat Sales', 'office'], ['lee', 'Lee Field', 'tech'], ['boss', 'Boss Manager', 'office'], ['viewer', 'Vi Ewer', 'office'], ['other', 'Other Office', 'office']]) {
    ids[k] = (await call('admin', 'POST', '/users', { name, email: `${k}@x.com`, password: 'password123', role })).data.id;
    tok[k] = (await call(null, 'POST', '/login', { email: `${k}@x.com`, password: 'password123' })).data.token;
  }
});
after(() => server.close());

test('formulas: operators, brackets, constants; bad ones are refused', () => {
  const look = { B14: 700, B4: 4900, N6: 3, K6: 8, K5: 0 };
  const ev = (r, c = {}) => K.evalTree(K.parseRule(r), id => look[id] ?? null, c);
  assert.equal(ev('B14/(B4/7)'), 1); assert.equal(Math.round(ev('N6*OT_RATE', { OT_RATE: 78.6 }) * 100) / 100, 235.8); assert.equal(ev('-B14+B4'), 4200);
  assert.equal(ev('K6/K5'), null, 'divide by zero = no number'); assert.equal(ev('K6/K7'), null, 'missing input = no number');
  assert.throws(() => K.parseRule('B4/(B1')); assert.throws(() => K.parseRule('B4 $ 2'));
});

test('import: preview first; then metrics, settings, owners by email, the sheet\'s ADMINS and MASTER_VIEWERS, history', async () => {
  assert.equal((await call('pat', 'POST', '/import/kpi-workbook/preview', { file: workbook() })).status, 403, 'admins import');
  const p = (await call('admin', 'POST', '/import/kpi-workbook/preview', { file: workbook() })).data;
  assert.equal(p.metrics, 9);
  assert.deepEqual(p.owners.map(o => [o.name, o.user && o.user.name]), [['Pat', 'Pat Sales'], ['Lee', 'Lee Field']]);
  assert.deepEqual(p.grants.filter(g => g.user).map(g => `${g.user.name}:${g.perm}`).sort(), ['Boss Manager:kpi_edit_all', 'Boss Manager:kpi_view_all', 'Vi Ewer:kpi_view_all']);
  assert.equal((await call('admin', 'GET', '/kpi/page?owner=1&week=' + WEEK)).status, 404, 'nothing until it is imported');
  const r = (await call('admin', 'POST', '/import/kpi-workbook', { file: workbook() })).data;
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.unmatched_emails, ['nobody@x.com']); assert.deepEqual(r.permissions_for.sort(), ['Boss Manager', 'Vi Ewer']);
  assert.equal(r.values, 4, 'unknown metric ID and non-Sunday week skipped'); assert.equal(r.notes, 1); assert.equal(r.submissions, 1);
  assert.equal(db.prepare("SELECT value FROM settings WHERE key = 'kpi_ot_rate'").get().value, '50');
  // times in the sheet are Boise wall-clock: 09:15 MDT = 15:15 UTC
  assert.equal(db.prepare("SELECT at FROM kpi_values WHERE week = ? AND metric_id = 'P1'").get(WEEK).at, '2026-10-27T15:15:00.000Z');
  // importing again changes nothing
  const again = (await call('admin', 'POST', '/import/kpi-workbook', { file: workbook() })).data;
  assert.equal(again.values + again.notes + again.submissions, 0);
  // the data tabs were never read into the app
  assert.equal(db.prepare("SELECT COUNT(*) n FROM customers WHERE name = 'Somebody Real'").get().n, 0);
});

test('who sees what: owners their own page, viewers everyone, others nothing', async () => {
  const me = async k => (await call(k, 'GET', '/me')).data.user.kpi;
  assert.deepEqual(await Promise.all(['admin', 'pat', 'lee', 'boss', 'viewer', 'other'].map(me)), [true, true, true, true, true, false]);
  ids.Pat = db.prepare("SELECT id FROM kpi_owners WHERE name = 'Pat'").get().id; ids.Lee = db.prepare("SELECT id FROM kpi_owners WHERE name = 'Lee'").get().id;
  assert.deepEqual((await call('pat', 'GET', '/kpi/me')).data.owners.map(o => o.name), ['Pat']);
  assert.deepEqual((await call('viewer', 'GET', '/kpi/me')).data.owners.map(o => o.name), ['Pat', 'Lee']);
  assert.equal((await call('pat', 'GET', `/kpi/page?owner=${ids.Lee}&week=${WEEK}`)).status, 403);
  assert.equal((await call('other', 'GET', `/kpi/page?owner=${ids.Pat}&week=${WEEK}`)).status, 403);
  assert.equal((await call('viewer', 'GET', `/kpi/page?owner=${ids.Lee}&week=${WEEK}`)).status, 200);
  assert.equal((await call('pat', 'GET', `/kpi/page?owner=${ids.Pat}&week=2026-10-26`)).status, 400, 'weeks start on Sunday');
});

test('a page: values, formulas across pages, status colours, trend, late/missing', async () => {
  const pg = (await call('pat', 'GET', `/kpi/page?owner=${ids.Pat}&week=${WEEK}`)).data;
  assert.equal(pg.due, '2026-11-03 23:59'); assert.equal(pg.can_edit, true);
  assert.equal(pg.report.state, 'missing');
  const m = Object.fromEntries(pg.sections.flatMap(s => s.metrics).map(x => [x.id, x]));
  assert.deepEqual(Object.keys(m), ['P1', 'P2', 'P3', 'P4'], 'inactive metric hidden');
  assert.equal(m.P1.status, 'yellow', '90 vs 100 is within 25%'); assert.equal(m.P2.status, 'red', '14 vs 10 is past 12.5');
  assert.ok(Math.abs(m.P3.value - 14 / 90) < 1e-9); assert.equal(m.P3.status, 'red'); assert.equal(m.P4.status, 'info');
  assert.equal(m.P2.note.cause, 'Spam calls'); assert.equal(m.P3.note, null);
  assert.deepEqual(m.P1.trend.slice(-2).map(t => t.value), [120, 90]);
  const lee = (await call('lee', 'GET', `/kpi/page?owner=${ids.Lee}&week=${WEEK}`)).data;
  const l = Object.fromEntries(lee.sections.flatMap(s => s.metrics).map(x => [x.id, x]));
  assert.equal(l.L1.value, 1200); assert.equal(l.L1.input, 'auto');
  assert.ok(Math.abs(l.L4.value - 1200 / 76) < 1e-9, 'a formula can use another page\'s numbers');
  assert.equal(l.L3.status, 'set_target');
  // last week was submitted on time, from the sheet
  assert.equal((await call('pat', 'GET', `/kpi/page?owner=${ids.Pat}&week=2026-10-18`)).data.report.state, 'in');
});

test('filling in: owners their own page only; "fill in anyone\'s page" can do any; viewers can\'t write', async () => {
  assert.equal((await call('pat', 'PUT', '/kpi/page', { owner: ids.Lee, week: WEEK, values: { L2: 3 } })).status, 403);
  assert.equal((await call('viewer', 'PUT', '/kpi/page', { owner: ids.Pat, week: WEEK, values: { P1: 1 } })).status, 403);
  assert.equal((await call('pat', 'PUT', '/kpi/page', { owner: ids.Pat, week: WEEK, values: { L2: 3 } })).status, 400, 'another page\'s metric');
  assert.equal((await call('pat', 'PUT', '/kpi/page', { owner: ids.Pat, week: WEEK, values: { P1: 'lots' } })).status, 400);
  const r = (await call('boss', 'PUT', '/kpi/page', { owner: ids.Lee, week: WEEK, values: { L2: 7, L3: 999 } })).data;
  assert.equal(r.changed, 1, 'a formula row can\'t be typed over');
  const v = db.prepare("SELECT * FROM kpi_values WHERE week = ? AND metric_id = 'L2'").get(WEEK);
  assert.equal(v.by_label, 'boss@x.com for Lee'); assert.equal(v.user_id, ids.boss);
  const lee = (await call('lee', 'GET', `/kpi/page?owner=${ids.Lee}&week=${WEEK}`)).data;
  assert.equal(lee.sections.flatMap(s => s.metrics).find(x => x.id === 'L3').value, 350, '7 OT hours × $50');
});

test('submit: every red row needs a cause and a fix; then it counts as in (late, here)', async () => {
  let r = (await call('pat', 'PUT', '/kpi/page', { owner: ids.Pat, week: WEEK, values: { P1: 95 }, submit: true })).data;
  assert.equal(r.submitted, false); assert.deepEqual(r.need_notes.map(n => n.id), ['P3'], 'P2 already has its note from the sheet');
  assert.equal(db.prepare("SELECT value FROM kpi_values WHERE week = ? AND metric_id = 'P1'").get(WEEK).value, 95, 'the numbers are saved even so');
  r = (await call('pat', 'PUT', '/kpi/page', { owner: ids.Pat, week: WEEK, notes: { P3: { cause: 'Spam calls', fix: '' } }, submit: true })).data;
  assert.equal(r.submitted, false, 'a fix is needed too');
  r = (await call('pat', 'PUT', '/kpi/page', { owner: ids.Pat, week: WEEK, notes: { P3: { cause: 'Spam calls', fix: 'Block numbers' } }, submit: true })).data;
  assert.equal(r.submitted, true);
  const pg = (await call('pat', 'GET', `/kpi/page?owner=${ids.Pat}&week=${WEEK}`)).data;
  assert.equal(pg.report.state, 'late'); assert.equal(pg.submissions.at(-1).by_label, 'pat@x.com');
});

test('company scorecard: viewers only; reports in, health, headlines with quarter average, the constraint, red rows with notes', async () => {
  assert.equal((await call('pat', 'GET', `/kpi/dashboard?week=${WEEK}`)).status, 403);
  assert.equal((await call('boss', 'PUT', '/kpi/settings', { headlines: 'P1, L1, NOPE' })).status, 400);
  assert.equal((await call('pat', 'PUT', '/kpi/settings', { headlines: 'P1' })).status, 403);
  await call('boss', 'PUT', '/kpi/settings', { headlines: 'P1, L1' });
  const d = (await call('viewer', 'GET', `/kpi/dashboard?week=${WEEK}`)).data;
  assert.deepEqual(d.reports.map(r => `${r.name}:${r.state}`), ['Pat:late', 'Lee:missing']);
  assert.deepEqual(d.health, { green: 2, yellow: 1, red: 3, no_data: 0, set_target: 1 });
  assert.deepEqual(d.headlines.map(h => h.id), ['P1', 'L1']);
  assert.equal(d.headlines[0].qtr_avg, (120 + 95) / 2, 'Q4 weeks so far: 10/18 and 10/25'); assert.equal(d.quarter, '2026Q4');
  assert.equal(d.constraint.section, 'Labor', 'Labor: 1 red of 1 scored; Calls: 1 yellow + 2 red'); assert.equal(d.sections[1].section, 'Calls');
  assert.deepEqual(d.red.map(x => x.id).sort(), ['L2', 'P2', 'P3']);
  assert.equal(d.red.find(x => x.id === 'P3').note.fix, 'Block numbers');
});

test('set-up: targets, owner\'s user, settings — by people who can fill in anyone\'s page', async () => {
  assert.equal((await call('pat', 'PUT', '/kpi/metrics/P1', { target: 80 })).status, 403);
  assert.equal((await call('boss', 'PUT', '/kpi/metrics/P1', { target: 80 })).status, 200);
  assert.equal((await call('boss', 'PUT', `/kpi/owners/${ids.Pat}`, { user_id: ids.other })).status, 200);
  assert.deepEqual((await call('other', 'GET', '/kpi/me')).data.owners.map(o => o.name), ['Pat'], 'the page moves with the person');
  assert.equal((await call('pat', 'GET', `/kpi/page?owner=${ids.Pat}&week=${WEEK}`)).status, 403);
  const s = (await call('boss', 'GET', '/kpi/setup')).data;
  assert.equal(s.metrics.find(m => m.id === 'P1').target, 80); assert.equal(s.settings.ot_rate, 50);
});
