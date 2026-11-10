'use strict';
// Per-employee permissions, commercial projects, project time clock with cost codes, cost-code import.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const D = require('../server/db');
const { createApp } = require('../server/app');

let server, base, db;
const tok = {};
async function call(who, method, p, body) {
  const res = await fetch(base + '/api' + p, { method, headers: { 'Content-Type': 'application/json', ...(tok[who] ? { Authorization: 'Bearer ' + tok[who] } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json() };
}
const login = async (who, email) => { tok[who] = (await call(null, 'POST', '/login', { email, password: 'password123' })).data.token; };
const ids = {};
const cc = code => db.prepare('SELECT id FROM cost_codes WHERE code = ?').get(code).id;

before(async () => {
  db = D.open(':memory:');
  server = createApp(db).listen(0);
  await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  tok.admin = (await call(null, 'POST', '/setup', { name: 'Owner', email: 'o@x.com', password: 'longenough' })).data.token;
  ids.office = (await call('admin', 'POST', '/users', { name: 'Olivia Office', email: 'olivia@x.com', password: 'password123', role: 'office', hourly_wage: 25 })).data.id;
  ids.jw = (await call('admin', 'POST', '/users', { name: 'Jay Journeyman', email: 'jay@x.com', password: 'password123', role: 'tech', title: 'Journeyman', hourly_wage: 40, burden_pct: 25 })).data.id;
  ids.app = (await call('admin', 'POST', '/users', { name: 'Ava Apprentice', email: 'ava@x.com', password: 'password123', role: 'tech', title: 'Apprentice', hourly_wage: 20, burden_pct: 25 })).data.id;
  await login('office', 'olivia@x.com'); await login('jw', 'jay@x.com'); await login('app', 'ava@x.com');
  ids.cust = (await call('admin', 'POST', '/customers', { name: 'Summit Builders', company: 'Summit Builders GC', type: 'commercial', location: { address: '100 Tower Rd' } })).data.id;
});
after(() => server.close());

test('permissions: office defaults, turning areas off and on, admin-only areas, cost hiding', async () => {
  let me = (await call('office', 'GET', '/me')).data.user;
  assert.equal(me.perms.invoices, true); assert.equal(me.perms.accounting, false); assert.equal(me.permissions, undefined);
  assert.equal((await call('office', 'GET', '/accounting/summary')).status, 403);
  // owner takes invoices away and gives accounting
  const perms = { ...me.perms, invoices: false, accounting: true };
  assert.equal((await call('admin', 'PUT', `/users/${ids.office}`, { perms })).status, 200);
  me = (await call('office', 'GET', '/me')).data.user;
  assert.equal(me.perms.invoices, false); assert.equal(me.perms.accounting, true);
  const inv = await call('office', 'POST', '/invoices', { customer_id: ids.cust, items: [{ description: 'x', qty: 1, unit_price: 1 }] });
  assert.equal(inv.status, 403); assert.match(inv.data.error, /Invoices.*Team/);
  assert.equal((await call('office', 'GET', '/invoices')).status, 403);
  assert.equal((await call('office', 'GET', '/accounting/summary')).status, 200, 'admin-only area opens when granted');
  assert.equal((await call('office', 'PUT', '/settings', { company_name: 'Hacked' })).status, 403, 'settings stay admin-only');
  assert.equal((await call('office', 'POST', '/users', { name: 'X', email: 'x@x.com', password: 'password123', role: 'admin' })).status, 403, 'team stays admin-only');
  // only the differences are stored
  const stored = JSON.parse(db.prepare('SELECT permissions FROM users WHERE id = ?').get(ids.office).permissions);
  assert.deepEqual(stored, { invoices: false, accounting: true });
  const team = (await call('admin', 'GET', '/users')).data.find(u => u.id === ids.office);
  assert.deepEqual(team.custom_perms.sort(), ['accounting', 'invoices']);
  assert.equal((await call('office', 'GET', '/users')).data[0].permissions, undefined);

  // costs: hidden when see_costs is off, and saving an estimate keeps the hidden costs
  const est = (await call('office', 'POST', '/estimates', { customer_id: ids.cust, items: [{ description: 'Panel', qty: 1, unit_price: 3000, unit_cost: 1200 }] })).data.id;
  await call('admin', 'PUT', `/users/${ids.office}`, { perms: { ...perms, see_costs: false } });
  const e = (await call('office', 'GET', `/estimates/${est}`)).data;
  assert.equal(e.items[0].unit_cost, undefined); assert.equal(e.est_cost, undefined); assert.equal(e.total, 3000);
  assert.equal((await call('office', 'GET', '/users')).data.find(u => u.id === ids.jw).hourly_wage, undefined);
  await call('office', 'PUT', `/estimates/${est}`, { items: e.items.map(it => ({ ...it, unit_price: 3200 })) });
  assert.equal(db.prepare('SELECT unit_cost, unit_price FROM estimate_items WHERE estimate_id = ?').get(est).unit_cost, 1200);
  // admin can't demote themselves
  const me2 = (await call('admin', 'GET', '/me')).data.user;
  assert.equal((await call('admin', 'PUT', `/users/${me2.id}`, { role: 'office' })).status, 400);
});

test('tech permissions: field estimates and daily logs per person', async () => {
  const job = (await call('admin', 'POST', '/jobs', { customer_id: ids.cust, title: 'Tenant fit-out', tech_ids: [ids.jw, ids.app] })).data.id;
  assert.equal((await call('jw', 'POST', '/estimates', { job_id: job, items: [{ description: 'Extra circuit', qty: 1, unit_price: 400 }] })).status, 200);
  const apprentice = (await call('admin', 'GET', '/users')).data.find(u => u.id === ids.app);
  await call('admin', 'PUT', `/users/${ids.app}`, { perms: { ...apprentice.perms, field_estimates: false } });
  const r = await call('app', 'POST', '/estimates', { job_id: job, items: [{ description: 'Extra circuit', qty: 1, unit_price: 400 }] });
  assert.equal(r.status, 403);
  assert.equal((await call('app', 'GET', '/me')).data.user.perms.field_estimates, false);
});

test('commercial project: progress by cost code, forecast, billing position, flags', async () => {
  const p = (await call('admin', 'POST', '/jobs', { customer_id: ids.cust, title: 'Summit Medical Office', is_project: 1, billing_type: 'fixed', job_type: 'commercial',
    contract_amount: 100000, retainage_pct: 10, foreman_id: ids.jw, project_manager_id: ids.office, start_date: '2026-10-01', end_date: '2027-03-31',
    gc_contact: 'Sam Super', gc_phone: '555-1000', tech_ids: [ids.jw] })).data;
  ids.proj = p.id;
  await call('admin', 'PUT', `/jobs/${p.id}/budgets`, { budgets: [
    { cost_code_id: cc('0810'), budget_hours: 200, budget_material: 10000 }, { cost_code_id: cc('1010'), budget_hours: 100, budget_material: 4000 } ] });
  // 120 hours of rough-in so far
  const ins = db.prepare('INSERT INTO time_entries (user_id, job_id, kind, clock_in, clock_out, hourly_cost, hourly_wage, cost_code_id) VALUES (?,?,?,?,?,?,?,?)');
  for (let i = 0; i < 15; i++) ins.run(ids.jw, p.id, 'job', `2026-10-${String(i + 1).padStart(2, '0')}T14:00:00Z`, `2026-10-${String(i + 1).padStart(2, '0')}T22:00:00Z`, 50, 40, cc('0810'));

  // foreman reports rough-in 50% → forecast 240h on a 200h budget
  assert.equal((await call('app', 'PUT', `/projects/${p.id}/budgets`, { codes: [{ cost_code_id: cc('0810'), percent_complete: 50 }] })).status, 403);
  const r = await call('jw', 'PUT', `/projects/${p.id}/budgets`, { codes: [{ cost_code_id: cc('0810'), percent_complete: 50 }] });
  assert.equal(r.status, 200);
  const d = (await call('admin', 'GET', `/projects/${p.id}`)).data;
  const rough = d.cost_codes.find(c => c.code === '0810');
  assert.equal(rough.hours, 120); assert.equal(rough.earned_hours, 100); assert.equal(rough.productivity, 0.83); assert.equal(rough.forecast_hours, 240); assert.equal(rough.forecast_variance, -40);
  const s = d.summary;
  assert.equal(s.contract, 100000); assert.equal(s.budget_hours, 300); assert.equal(s.hours, 120);
  assert.equal(s.percent_source, 'cost_codes');
  assert.ok(s.percent_complete > 30 && s.percent_complete < 40, `weighted % complete ${s.percent_complete}`); // rough-in is ~2/3 of the budget, half done
  assert.ok(s.over_under < 0, 'nothing billed yet → under-billed');
  assert.ok(s.flags.some(f => /Under-billed/.test(f)), JSON.stringify(s.flags));
  assert.ok(s.flags.some(f => /Forecast .* over budget/.test(f)), JSON.stringify(s.flags));
  assert.equal(d.users.foreman.name, 'Jay Journeyman');
  // editing the budget keeps reported progress
  await call('admin', 'PUT', `/jobs/${p.id}/budgets`, { budgets: [{ cost_code_id: cc('0810'), budget_hours: 220, budget_material: 10000 }, { cost_code_id: cc('1010'), budget_hours: 100 }] });
  assert.equal(db.prepare('SELECT percent_complete FROM job_budgets WHERE job_id = ? AND cost_code_id = ?').get(p.id, cc('0810')).percent_complete, 50);
  // list
  const list = (await call('admin', 'GET', '/projects')).data;
  assert.equal(list.length, 1); assert.equal(list[0].pm_name, 'Olivia Office'); assert.equal(list[0].foreman_name, 'Jay Journeyman');
  // a regular job is not a project
  assert.equal((await call('admin', 'GET', '/projects/999')).status, 404);
});

test('time clock: any open project, cost code required, project codes listed', async () => {
  const opts = (await call('app', 'GET', '/time/options')).data;
  const pr = opts.projects.find(x => x.id === ids.proj);
  assert.ok(pr, 'apprentice not assigned but may clock into any open project by default');
  assert.deepEqual(pr.cost_code_ids.sort(), [cc('0810'), cc('1010')].sort()); assert.equal(opts.require_cost_code, true);
  const no = await call('app', 'POST', '/time/clock-in', { job_id: ids.proj, kind: 'job' });
  assert.equal(no.status, 400); assert.match(no.data.error, /cost code/);
  assert.equal((await call('app', 'POST', '/time/clock-in', { job_id: ids.proj, kind: 'job', cost_code_id: cc('1010') })).status, 200);
  const crew = (await call('admin', 'GET', `/projects/${ids.proj}`)).data;
  assert.ok(crew.summary.crew_now.some(c => c.name === 'Ava Apprentice' && c.cost_code === '1010'));
  await call('app', 'POST', '/time/clock-out', {});
  // travel to the project doesn't need a code; turning off any_project hides unassigned projects
  assert.equal((await call('app', 'POST', '/time/clock-in', { job_id: ids.proj, kind: 'travel' })).status, 200);
  await call('app', 'POST', '/time/clock-out', {});
  const ava = (await call('admin', 'GET', '/users')).data.find(u => u.id === ids.app);
  await call('admin', 'PUT', `/users/${ids.app}`, { perms: { ...ava.perms, any_project: false } });
  assert.equal((await call('app', 'GET', '/time/options')).data.projects.length, 0);
  assert.ok((await call('jw', 'GET', '/time/options')).data.projects.some(x => x.id === ids.proj), 'assigned foreman still sees it');
  // the company can turn the requirement off
  await call('admin', 'PUT', '/settings', { project_require_cost_code: '0' });
  assert.equal((await call('jw', 'POST', '/time/clock-in', { job_id: ids.proj, kind: 'job' })).status, 200);
  await call('jw', 'POST', '/time/clock-out', {});
  await call('admin', 'PUT', '/settings', { project_require_cost_code: '1' });
  // inactive codes can't be used
  db.prepare("UPDATE cost_codes SET active = 0 WHERE code = '8100'").run();
  assert.equal((await call('jw', 'POST', '/time/clock-in', { job_id: ids.proj, kind: 'job', cost_code_id: cc('8100') })).status, 400);
});

test('daily logs: foreman writes, sees the day\'s time clock hours; others need permission', async () => {
  const l = await call('jw', 'POST', `/projects/${ids.proj}/logs`, { log_date: '2026-10-05', weather: 'Clear 50°F', crew_count: 2, work_performed: 'Rough-in 2nd floor east wing', delays: 'Waiting on drywall at stair 2' });
  assert.equal(l.status, 200);
  const logs = (await call('admin', 'GET', `/projects/${ids.proj}/logs`)).data;
  assert.equal(logs[0].user_name, 'Jay Journeyman'); assert.equal(logs[0].time[0].h, 8); assert.equal(logs[0].time[0].code, '0810');
  assert.equal((await call('jw', 'POST', `/projects/${ids.proj}/logs`, { log_date: '2026-10-06' })).status, 400, 'work performed is required');
  const ava = (await call('admin', 'GET', '/users')).data.find(u => u.id === ids.app);
  await call('admin', 'PUT', `/users/${ids.app}`, { perms: { ...ava.perms, daily_logs: false, any_project: true } });
  assert.equal((await call('app', 'POST', `/projects/${ids.proj}/logs`, { work_performed: 'x' })).status, 403);
  assert.equal((await call('app', 'PUT', `/daily-logs/${l.data.id}`, { work_performed: 'changed' })).status, 403, 'not the author');
  assert.equal((await call('jw', 'PUT', `/daily-logs/${l.data.id}`, { work_performed: 'Rough-in 2nd floor, east and north' })).status, 200);
  assert.equal((await call('admin', 'DELETE', `/daily-logs/${l.data.id}`)).status, 200);
});

test('cost codes import: time clock codes (0810-L) file under the base code; renames, adds, turns off missing', async () => {
  const csv = 'Code,Description,Category\n0810-L,EMT Conduit,08 Raceway\n0815-L,Surface Raceway,08 Raceway\n2050-L,FA Monitoring,20 Fire Alarm\n';
  const r = await call('admin', 'POST', '/import/run', { type: 'cost_codes', csv, filename: 'timeclock-codes.csv', options: { deactivate_missing: true } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.created.cost_code, 2); assert.equal(r.data.updated, 1);
  const emt = db.prepare("SELECT * FROM cost_codes WHERE code = '0810'").get();
  assert.equal(emt.name, 'EMT Conduit'); assert.equal(emt.active, 1);
  assert.equal(db.prepare("SELECT active FROM cost_codes WHERE code = '1010'").get().active, 0);
  assert.equal(db.prepare("SELECT division FROM cost_codes WHERE code = '2050'").get().division, '20');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM cost_codes WHERE code LIKE '%-L'").get().n, 0);
  // undo removes the codes it added
  assert.equal((await call('admin', 'POST', `/import/batches/${r.data.batch_id}/undo`)).status, 200);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM cost_codes WHERE code IN ('0815','2050')").get().n, 0);
  db.prepare('UPDATE cost_codes SET active = 1 WHERE length(code) = 4').run();
});

test('dashboard hides money figures from people without business reports; forecast falls back to budget before hours', async () => {
  const office = (await call('admin', 'GET', '/users')).data.find(u => u.id === ids.office);
  await call('admin', 'PUT', `/users/${ids.office}`, { perms: { ...office.perms, reports: false } });
  const d = (await call('office', 'GET', '/dashboard')).data;
  assert.equal(d.money, false); assert.equal(d.mtd, undefined); assert.equal(d.ar, undefined); assert.equal(d.trend, undefined);
  assert.ok(Array.isArray(d.today_jobs));
  assert.equal((await call('office', 'GET', '/reports/pl')).status, 403);
  assert.equal((await call('admin', 'GET', '/dashboard')).data.money, true);
  // 600 trim: 30% reported, no hours yet → forecast = budget, not 0
  await call('jw', 'PUT', `/projects/${ids.proj}/budgets`, { codes: [{ cost_code_id: cc('1010'), percent_complete: 30 }] });
  const trim = (await call('admin', 'GET', `/projects/${ids.proj}`)).data.cost_codes.find(c => c.code === '1010');
  assert.ok(trim.hours > 0 || trim.forecast_hours === trim.budget_hours, JSON.stringify(trim));
});
