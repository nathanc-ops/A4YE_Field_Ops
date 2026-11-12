'use strict';
// En route: travel time starts, the ETA is kept, and the customer is emailed (or the app says why not).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const D = require('../server/db');
const { createApp } = require('../server/app');

let server, base, db; const tok = {}, ids = {};
async function call(who, method, p, body) {
  const res = await fetch(base + '/api' + p, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok[who] }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}
const soon = h => new Date(Date.now() + h * 36e5).toISOString();

before(async () => {
  db = D.open(':memory:');
  server = createApp(db).listen(0); await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  tok.admin = (await (await fetch(base + '/api/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Owner', email: 'o@x.com', password: 'longenough' }) })).json()).token;
  ids.tech = (await call('admin', 'POST', '/users', { name: 'Dana Tech', email: 'dana@x.com', password: 'password123', role: 'tech' })).data.id;
  tok.tech = (await (await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'dana@x.com', password: 'password123' }) })).json()).token;
  ids.cust = (await call('admin', 'POST', '/customers', { name: 'Pat Example', email: 'pat@example.com' })).data.id;
  ids.nomail = (await call('admin', 'POST', '/customers', { name: 'No Mail' })).data.id;
  // a service address with map coordinates
  const loc = db.prepare("INSERT INTO locations (customer_id, address, city, state, zip, lat, lng) VALUES (?, '100 Main St', 'Boise', 'ID', '83702', 43.6150, -116.2023)").run(ids.cust).lastInsertRowid;
  ids.job = (await call('admin', 'POST', '/jobs', { customer_id: ids.cust, location_id: Number(loc), title: 'Panel swap', tech_ids: [ids.tech] })).data.id;
  ids.v1 = (await call('admin', 'POST', '/appointments', { job_id: ids.job, start: soon(1), end: soon(3), tech_ids: [ids.tech] })).data.id;
  ids.v2 = (await call('admin', 'POST', '/appointments', { job_id: ids.job, start: soon(5), end: soon(6), tech_ids: [ids.tech] })).data.id;
  const j2 = (await call('admin', 'POST', '/jobs', { customer_id: ids.nomail, title: 'Outlet', tech_ids: [ids.tech] })).data.id;
  ids.v3 = (await call('admin', 'POST', '/appointments', { job_id: j2, start: soon(7), end: soon(8), tech_ids: [ids.tech] })).data.id;
});
after(() => server.close());

test('a rough drive time from the phone location prefills the prompt', async () => {
  const r = (await call('tech', 'GET', `/appointments/${ids.v1}/eta?lat=43.6629&lng=-116.6874`)).data;   // ~25 mi west
  assert.equal(r.customer_email, true); assert.equal(r.notify, true);
  assert.ok(r.estimate.minutes >= 40 && r.estimate.minutes <= 80, `got ${r.estimate.minutes}`);
  assert.equal((await call('tech', 'GET', `/appointments/${ids.v1}/eta`)).data.estimate, null, 'no location, no guess');
});

test('tech taps En route: travel time starts, ETA kept, customer emailed with the arrival time', async () => {
  const r = (await call('tech', 'PUT', `/appointments/${ids.v1}`, { status: 'en_route', eta_min: 25 })).data;
  assert.equal(r.on_the_way.status, 'not_configured'); assert.match(r.on_the_way.error, /Settings → Email/);
  const eta = Date.parse(r.on_the_way.eta_at); assert.ok(Math.abs(eta - (Date.now() + 25 * 6e4)) < 60e3);
  const a = db.prepare('SELECT * FROM appointments WHERE id = ?').get(ids.v1);
  assert.equal(a.status, 'en_route'); assert.ok(a.en_route_at); assert.equal(a.on_way_notice, 'not_configured');
  const t = db.prepare('SELECT * FROM time_entries WHERE user_id = ? AND clock_out IS NULL').get(ids.tech);
  assert.equal(t.kind, 'travel'); assert.equal(t.appointment_id, ids.v1);
  const mail = db.prepare("SELECT * FROM outbox WHERE related = ?").get(`appointment:${ids.v1}`);
  assert.equal(mail.to_email, 'pat@example.com'); assert.match(mail.subject, /Dana from .* is on the way/); assert.match(mail.body, /should arrive at about \d{1,2}:\d\d [AP]M/);
});

test('the tech can choose not to notify; the company can turn it off; no email on file says so', async () => {
  const r = (await call('tech', 'PUT', `/appointments/${ids.v2}`, { status: 'en_route', eta_min: 10, notify: false })).data;
  assert.equal(r.on_the_way.status, 'off');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM outbox WHERE related = ?").get(`appointment:${ids.v2}`).n, 0);
  const r3 = (await call('tech', 'PUT', `/appointments/${ids.v3}`, { status: 'en_route', eta_min: 15 })).data;
  assert.equal(r3.on_the_way.status, 'no_email');
  await call('admin', 'PUT', '/settings', { notify_on_the_way: '0' });
  await call('admin', 'PUT', `/appointments/${ids.v1}`, { status: 'dispatched' });
  const r4 = (await call('admin', 'PUT', `/appointments/${ids.v1}`, { status: 'en_route', eta_min: 30 })).data;
  assert.equal(r4.on_the_way.status, 'off', 'the office path too, and the company switch wins');
  assert.equal((await call('admin', 'PUT', `/appointments/${ids.v1}`, { notes: 'gate code' })).data.on_the_way, null, 'other edits send nothing');
});
