'use strict';
// Appointment confirmation emails (job visits and estimate walkthroughs).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const D = require('../server/db');
const { createApp } = require('../server/app');
const { buildIcs, when } = require('../server/appt_confirm');

let server, base, db;
const tok = {}, ids = {};
async function call(who, method, p, body) {
  const res = await fetch(base + '/api' + p, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok[who] }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json() };
}
// a fixed future date, so the wording is predictable: Thursday, November 12 2099 is a Thursday
const T = (h, m = 0) => `2099-11-12T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00.000Z`;

before(async () => {
  db = D.open(':memory:');
  server = createApp(db).listen(0); await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  tok.admin = (await call(null, 'POST', '/setup', { name: 'Owner', email: 'o@x.com', password: 'longenough' })).data.token;
  await call('admin', 'PUT', '/settings', { company_name: 'All 4 You Electrical', company_phone: '(208) 555-0100', company_email: 'office@a4ye.example', timezone: 'America/Boise' });
  ids.dana = (await call('admin', 'POST', '/users', { name: 'Dana Brooks', email: 'dana@x.com', password: 'password123', role: 'tech' })).data.id;
  ids.sam = (await call('admin', 'POST', '/users', { name: 'Sam Lee', email: 'sam@x.com', password: 'password123', role: 'tech' })).data.id;
  tok.dana = (await call(null, 'POST', '/login', { email: 'dana@x.com', password: 'password123' })).data.token;
  ids.cust = (await call('admin', 'POST', '/customers', { name: 'Maria Lopez', email: 'maria@example.com', location: { address: '12 Elm St', city: 'Boise', state: 'ID', zip: '83702' } })).data.id;
  const loc = db.prepare('SELECT id FROM locations WHERE customer_id = ?').get(ids.cust).id;
  ids.job = (await call('admin', 'POST', '/jobs', { customer_id: ids.cust, location_id: loc, title: 'Add 20A circuit for garage freezer' })).data.id;
  // 20:00–21:30 UTC = 1:00–2:30 PM in Boise (MST, UTC−7 in November)
  ids.visit = (await call('admin', 'POST', '/appointments', { job_id: ids.job, start: T(20), end: T(21, 30), tech_ids: [ids.dana, ids.sam], notes: 'Gate code 4455 — dog is friendly' })).data.id;
  ids.noMail = (await call('admin', 'POST', '/customers', { name: 'Bob Nomail', location: { address: '5 Pine Rd' } })).data.id;
});
after(() => server.close());

test('the email: company time zone, address, crew first names, never the dispatch notes', async () => {
  const c = (await call('admin', 'GET', `/appointments/${ids.visit}/confirmation`)).data;
  assert.equal(c.to, 'maria@example.com'); assert.equal(c.changed, false); assert.equal(c.smtp, false);
  assert.equal(c.subject, 'Your appointment with All 4 You Electrical — Thu, November 12, 1:00–2:30 PM');
  assert.match(c.text, /^Hi Maria,/);
  assert.match(c.text, /When: Thursday, November 12, 1:00 – 2:30 PM \(MST\)/);
  assert.match(c.text, /Where: 12 Elm St Boise, ID 83702/);
  assert.match(c.text, /Work: Add 20A circuit for garage freezer/);
  assert.match(c.text, /Who's coming: Dana and Sam/);
  assert.match(c.text, /Call \(208\) 555-0100 or reply to this email/);
  assert.doesNotMatch(c.text, /Gate code|4455|dog/, 'dispatch notes stay internal');
  assert.equal((await call('dana', 'GET', `/appointments/${ids.visit}/confirmation`)).status, 403);
});

test('send: recorded in the outbox, visit marked confirmed; moving it flags "customer has the old time"; resending says so', async () => {
  assert.equal((await call('admin', 'POST', `/appointments/${ids.visit}/confirm`, { to: 'not-an-email' })).status, 400);
  const r = await call('admin', 'POST', `/appointments/${ids.visit}/confirm`, { message: 'Please park in the driveway.' });
  assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.status, 'not_configured', 'no SMTP in tests: recorded, text returned');
  assert.match(r.data.text, /Please park in the driveway\./);
  const ob = db.prepare("SELECT * FROM outbox WHERE related = ? ORDER BY id DESC").get(`appointment:${ids.visit}`);
  assert.equal(ob.to_email, 'maria@example.com'); assert.match(ob.subject, /^Your appointment/);
  let v = db.prepare('SELECT * FROM appointments WHERE id = ?').get(ids.visit);
  assert.ok(v.confirmed_at); assert.equal(v.confirmed_to, 'maria@example.com'); assert.equal(v.confirm_count, 1); assert.equal(v.confirmed_start, T(20));
  const list = () => call('admin', 'GET', `/appointments?from=${encodeURIComponent(T(0))}&to=${encodeURIComponent(T(23))}`).then(x => x.data.find(a => a.id === ids.visit));
  assert.equal((await list()).needs_reconfirm, false);
  // moved an hour later
  await call('admin', 'PUT', `/appointments/${ids.visit}`, { start: T(21), end: T(22, 30) });
  assert.equal((await list()).needs_reconfirm, true);
  const c = (await call('admin', 'GET', `/appointments/${ids.visit}/confirmation`)).data;
  assert.equal(c.changed, true); assert.match(c.subject, /^Updated time: Your appointment/); assert.match(c.text, /We've changed the time/); assert.match(c.text, /2:00 – 3:30 PM/);
  await call('admin', 'POST', `/appointments/${ids.visit}/confirm`, {});
  assert.equal((await list()).needs_reconfirm, false);
  assert.equal(db.prepare('SELECT confirm_count FROM appointments WHERE id = ?').get(ids.visit).confirm_count, 2);
  // a status change alone (dispatched) isn't a new time
  await call('admin', 'PUT', `/appointments/${ids.visit}`, { status: 'dispatched' });
  assert.equal((await list()).needs_reconfirm, false);
});

test('cancellation notice; no email on file; finished visits; estimate walkthroughs', async () => {
  const cx = await call('admin', 'POST', `/appointments/${ids.visit}/confirm`, { cancelled: true });
  assert.equal(cx.status, 200); assert.match(cx.data.subject, /^Cancelled: your appointment with All 4 You Electrical/);
  assert.match(cx.data.text, /has been cancelled/); assert.doesNotMatch(cx.data.text, /When:/);
  assert.equal(db.prepare('SELECT confirmed_at FROM appointments WHERE id = ?').get(ids.visit).confirmed_at, null);
  // no email on file: refused unless one is typed
  const job2 = (await call('admin', 'POST', '/jobs', { customer_id: ids.noMail, title: 'Outlet' })).data.id;
  const v2 = (await call('admin', 'POST', '/appointments', { job_id: job2, start: T(16), end: T(17) })).data.id;
  const nm = await call('admin', 'POST', `/appointments/${v2}/confirm`, {});
  assert.equal(nm.status, 400); assert.match(nm.data.error, /no email address/);
  assert.equal((await call('admin', 'POST', `/appointments/${v2}/confirm`, { to: 'bob@example.com' })).status, 200);
  // a finished visit isn't confirmed
  db.prepare("UPDATE appointments SET status = 'done' WHERE id = ?").run(v2);
  assert.equal((await call('admin', 'POST', `/appointments/${v2}/confirm`, {})).status, 400);
  // estimate walkthrough wording
  const ev = (await call('admin', 'POST', '/estimate-visits', { customer_id: ids.cust, title: 'Panel upgrade to 200A', start: T(15), end: T(16) })).data;
  const c = (await call('admin', 'GET', `/appointments/${ev.id}/confirmation`)).data;
  assert.equal(c.subject, 'Your estimate appointment with All 4 You Electrical — Thu, November 12, 8:00–9:00 AM');
  assert.match(c.text, /Purpose: look at the work and put together a price for: Panel upgrade to 200A/);
  assert.match(c.text, /someone 18 or older/);
});

test('calendar invite: UTC times, stable UID, escaping, 75-byte lines; multi-day wording', () => {
  const ics = buildIcs({ uid: 'appt-7@a4ye-field-ops', sequence: 2, start: T(20), end: T(21, 30), summary: 'All 4 You Electrical: panel, meter; and more',
    location: '12 Elm St, Boise, ID 83702', description: 'A long line '.repeat(20), organizerName: 'All 4 You Electrical', organizerEmail: 'office@a4ye.example' });
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/); assert.match(ics, /\r\nUID:appt-7@a4ye-field-ops\r\n/); assert.match(ics, /\r\nSEQUENCE:2\r\n/);
  assert.match(ics, /\r\nDTSTART:20991112T200000Z\r\n/); assert.match(ics, /\r\nDTEND:20991112T213000Z\r\n/);
  assert.match(ics, /SUMMARY:All 4 You Electrical: panel\\, meter\\; and more/);
  for (const line of ics.split('\r\n')) assert.ok(Buffer.byteLength(line) <= 75, `line too long: ${line}`);
  assert.match(ics, /STATUS:CONFIRMED/);
  assert.match(buildIcs({ uid: 'x', start: T(1), end: T(2), summary: 's', cancelled: true }), /STATUS:CANCELLED/);
  const w = when({ start: '2099-11-12T15:00:00Z', end: '2099-11-13T23:00:00Z' }, 'America/Boise');
  assert.equal(w.date, 'Thursday, November 12 – Friday, November 13'); assert.equal(w.time, '8:00 AM – 4:00 PM each day');
});
