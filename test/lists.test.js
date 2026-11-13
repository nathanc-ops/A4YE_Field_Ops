'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const D = require('../server/db');
const C = require('../server/calc');
const { createApp } = require('../server/app');

let server, base, db; const tok = {};
async function call(who, method, p, body) {
  const res = await fetch(base + '/api' + p, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok[who] }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json(), total: Number(res.headers.get('X-Total-Count')), sums: JSON.parse(res.headers.get('X-Sums') || 'null') };
}
const ins = (sql, ...a) => Number(db.prepare(sql).run(...a).lastInsertRowid);
const ids = {};

before(async () => {
  db = D.open(':memory:');
  server = createApp(db).listen(0); await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  tok.admin = (await (await fetch(base + '/api/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Owner', email: 'o@x.com', password: 'longenough' }) })).json()).token;
  for (const [role, email, name] of [['manager', 'm@x.com', 'Mgr'], ['office', 'f@x.com', 'Ofc'], ['tech', 't1@x.com', 'Tech One'], ['tech', 't2@x.com', 'Tech Two']]) {
    const r = await call('admin', 'POST', '/users', { name, email, password: 'password123', role });
    ids[email] = r.data.id;
    tok[email] = (await (await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'password123' }) })).json()).token;
  }
  tok.manager = tok['m@x.com']; tok.office = tok['f@x.com']; tok.tech = tok['t1@x.com'];
  ids.a = ins("INSERT INTO customers (name, type, lead_source, created_at) VALUES ('Alice Able', 'residential', 'Google', '2026-01-05 10:00:00')");
  ids.b = ins("INSERT INTO customers (name, company, type, lead_source, created_at) VALUES ('Bob Baker', 'Baker Builds', 'commercial', 'Referral', '2026-06-01 10:00:00')");
  ids.c = ins("INSERT INTO customers (name, type, created_at) VALUES ('Cara Cole', 'residential', '2026-09-01 10:00:00')");
  // jobs: a mix of types, billing, techs and dates
  const job = (n, cust, title, type, billing, start, status = 'scheduled', proj = 0) => ins('INSERT INTO jobs (number, customer_id, title, job_type, billing_type, scheduled_start, scheduled_end, status, is_project) VALUES (?,?,?,?,?,?,?,?,?)',
    n, cust, title, type, billing, start, start, status, proj);
  ids.j1 = job('J-9', ids.a, 'Panel', 'install', 'fixed', '2026-10-05T15:00:00.000Z');
  ids.j2 = job('J-10', ids.b, 'Lot lights', 'commercial', 'tm', '2026-10-01T15:00:00.000Z', 'scheduled', 1);
  ids.j3 = job('J-100', ids.c, 'Outlet', 'service', 'tm', '2026-10-10T15:00:00.000Z');
  ins('INSERT INTO job_techs (job_id, user_id) VALUES (?,?)', ids.j3, ids['t2@x.com']);
  // invoices: totals via one line each
  const inv = (n, cust, job, issue, due, status, amt) => { const id = ins("INSERT INTO invoices (number, customer_id, job_id, status, issue_date, due_date, tax_rate, public_token) VALUES (?,?,?,?,?,?,0,?)", n, cust, job, status, issue, due, 'tk' + n);
    ins("INSERT INTO invoice_items (invoice_id, description, qty, unit_price, unit_cost, taxable) VALUES (?, 'Work', 1, ?, 0, 0)", id, amt); return id; };
  inv('INV-2', ids.a, ids.j1, '2026-09-01', '2026-09-15', 'sent', 500);
  inv('INV-10', ids.b, ids.j2, '2026-10-01', '2099-10-15', 'sent', 3000);
  inv('INV-3', ids.c, null, '2026-08-01', '2026-08-15', 'draft', 75);
  // estimates
  const est = (n, cust, title, created, amt, status = 'sent') => { const id = ins("INSERT INTO estimates (number, customer_id, title, status, created_at, tax_rate, public_token) VALUES (?,?,?,?,?,0,?)", n, cust, title, status, created, 'e' + n);
    ins("INSERT INTO estimate_items (estimate_id, description, qty, unit_price, unit_cost, taxable) VALUES (?, 'Work', 1, ?, 0, 0)", id, amt); return id; };
  est('EST-1', ids.a, 'EV charger', '2026-07-01 10:00:00', 1800);
  est('EST-2', ids.b, 'Warehouse LED', '2026-10-02 10:00:00', 42000, 'approved');
  est('EST-3', ids.c, 'Hot tub circuit', '2026-10-20 10:00:00', 900);
});
after(() => server.close());

test('customers: filter by lead source and date added, sort by newest or jobs', async () => {
  assert.deepEqual((await call('admin', 'GET', '/customers?lead_source=Referral')).data.map(c => c.name), ['Bob Baker']);
  assert.deepEqual((await call('admin', 'GET', '/customers?created_from=2026-05-01&created_to=2026-08-31')).data.map(c => c.name), ['Bob Baker']);
  assert.deepEqual((await call('admin', 'GET', '/customers?order=created&dir=desc')).data.map(c => c.name), ['Cara Cole', 'Bob Baker', 'Alice Able']);
  assert.deepEqual((await call('admin', 'GET', '/customers?order=name&dir=desc')).data.map(c => c.name), ['Cara Cole', 'Bob Baker', 'Alice Able']);
});

test('jobs: filters and sort; job numbers sort as numbers', async () => {
  const n = async q => (await call('admin', 'GET', '/jobs?' + q)).data.map(j => j.number);
  assert.deepEqual(await n('order=number&dir=asc'), ['J-9', 'J-10', 'J-100']);
  assert.deepEqual(await n('order=scheduled&dir=desc'), ['J-100', 'J-9', 'J-10']);
  assert.deepEqual(await n('billing_type=tm&order=number&dir=asc'), ['J-10', 'J-100']);
  assert.deepEqual(await n('kind=project'), ['J-10']);
  assert.deepEqual(await n('kind=service&order=number&dir=asc'), ['J-9', 'J-100']);
  assert.deepEqual(await n(`tech_id=${ids['t2@x.com']}`), ['J-100']);
  assert.deepEqual(await n('sched_from=2026-10-02&sched_to=2026-10-06'), ['J-9']);
  assert.deepEqual(await n('order=customer&dir=asc'), ['J-9', 'J-10', 'J-100'], 'Alice Able, Baker Builds, Cara Cole');
});

test('invoices: search, date, overdue, sort by money, totals cover every match across pages', async () => {
  const r = await call('admin', 'GET', '/invoices?order=total&dir=desc');
  assert.deepEqual(r.data.map(i => i.number), ['INV-10', 'INV-2', 'INV-3']);
  assert.equal(r.total, 3); assert.deepEqual(r.sums, { total: 3575, balance: 3575 });
  assert.deepEqual((await call('admin', 'GET', '/invoices?order=number&dir=asc')).data.map(i => i.number), ['INV-2', 'INV-3', 'INV-10']);
  assert.deepEqual((await call('admin', 'GET', '/invoices?overdue=1')).data.map(i => i.number), ['INV-2']);
  assert.deepEqual((await call('admin', 'GET', '/invoices?q=baker')).data.map(i => i.number), ['INV-10']);
  assert.deepEqual((await call('admin', 'GET', '/invoices?from=2026-08-15&to=2026-09-30')).data.map(i => i.number), ['INV-2']);
  const p2 = await call('admin', 'GET', '/invoices?order=total&dir=desc&limit=2&offset=2');
  assert.deepEqual(p2.data.map(i => i.number), ['INV-3']); assert.equal(p2.total, 3); assert.equal(p2.sums.total, 3575);
});

test('estimates: search, created dates, sort by total; no longer cut off at 500', async () => {
  assert.deepEqual((await call('admin', 'GET', '/estimates?order=total&dir=desc')).data.map(e => e.number), ['EST-2', 'EST-1', 'EST-3']);
  assert.deepEqual((await call('admin', 'GET', '/estimates?q=led')).data.map(e => e.number), ['EST-2']);
  assert.deepEqual((await call('admin', 'GET', '/estimates?from=2026-10-01&to=2026-10-31&order=created&dir=asc')).data.map(e => e.number), ['EST-2', 'EST-3']);
  assert.deepEqual((await call('admin', 'GET', '/estimates?status=sent,viewed')).data.map(e => e.number).sort(), ['EST-1', 'EST-3']);
  for (let k = 0; k < 520; k++) db.prepare("INSERT INTO estimates (number, customer_id, status, tax_rate, public_token) VALUES (?, ?, 'draft', 0, ?)").run('B-' + k, ids.a, 'b' + k);
  const r = await call('admin', 'GET', '/estimates?limit=10');
  assert.equal(r.total, 523); assert.equal(r.data.length, 10);
});

test('weekly hours: worked, scheduled, projected and overtime flags', () => {
  db.prepare("UPDATE settings SET value = '40' WHERE key = 'overtime_weekly_hours'").run();
  const t1 = ids['t1@x.com'], t2 = ids['t2@x.com'];
  const local = (d, h) => new Date(`${d}T${String(h).padStart(2, '0')}:00:00`).toISOString();
  const clock = (u, d, a, b) => ins('INSERT INTO time_entries (user_id, kind, clock_in, clock_out, hourly_cost, hourly_wage) VALUES (?, \'job\', ?, ?, 0, 0)', u, local(d, a), b == null ? null : local(d, b));
  const visit = (u, d1, h1, d2, h2) => { const a = ins("INSERT INTO appointments (job_id, start, end) VALUES (?,?,?)", ids.j1, local(d1, h1), local(d2, h2)); ins('INSERT INTO appointment_techs (appointment_id, user_id) VALUES (?,?)', a, u); };
  // workweek Sun 2026-11-01 – Sat 11-07 (A4YE pays Sunday–Saturday). "now" = Wed 2026-11-04 noon.
  // Tech One: 11 h Mon + 11 h Tue = 22 worked; Wed–Fri 7–3 crew visit (multi-day) = 8 h/day scheduled, 3 h of today left + Thu/Fri 16 = 19 ahead → 41 projected
  clock(t1, '2026-11-02', 6, 17); clock(t1, '2026-11-03', 6, 17);
  visit(t1, '2026-11-04', 7, '2026-11-06', 15);
  // Tech Two: 21 h Mon + 21 h Tue = 42, on the clock since 9 Wed → 45 worked
  for (const d of ['2026-11-02', '2026-11-03']) clock(t2, d, 2, 23);
  clock(t2, '2026-11-04', 9, null);
  const w = C.weekHours(db, '2026-11-05', local('2026-11-04', 12));
  assert.equal(w.week, '2026-11-01'); assert.equal(w.days.length, 7);
  const one = w.rows.find(r => r.user_id === t1), two = w.rows.find(r => r.user_id === t2);
  assert.equal(one.worked, 22); assert.equal(one.scheduled, 24); assert.equal(one.ahead, 19); assert.equal(one.projected, 41);
  assert.deepEqual(one.flags, ['projected']); assert.equal(one.projected_overtime, 1);
  assert.deepEqual(one.scheduled_by_day.slice(3, 6), [8, 8, 8]);
  assert.equal(two.worked, 45); assert.ok(two.on_clock); assert.deepEqual(two.flags, ['over']); assert.equal(two.overtime, 5);
});

test('weekly hours: office, managers and admins only', async () => {
  for (const who of ['admin', 'manager', 'office']) assert.equal((await call(who, 'GET', '/time/week?week=2026-11-04')).status, 200, who);
  assert.equal((await call('tech', 'GET', '/time/week')).status, 403);
});
