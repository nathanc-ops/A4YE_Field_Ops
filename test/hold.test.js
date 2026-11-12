'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const D = require('../server/db');
const { createApp } = require('../server/app');

let server, base, db; const tok = {};
async function call(who, method, p, body) {
  const res = await fetch(base + '/api' + p, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok[who] }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, type: res.headers.get('content-type') };
}
const day = n => { const d = new Date(); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
let jobId, techId;

before(async () => {
  db = D.open(':memory:');
  server = createApp(db).listen(0); await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  tok.admin = (await (await fetch(base + '/api/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Owner', email: 'o@x.com', password: 'longenough' }) })).json()).token;
  techId = (await call('admin', 'POST', '/users', { name: 'Tech', email: 't@x.com', password: 'password123', role: 'tech' })).data.id;
  tok.tech = (await (await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 't@x.com', password: 'password123' }) })).json()).token;
  const cust = (await call('admin', 'POST', '/customers', { name: 'Test Customer' })).data.id;
  jobId = (await call('admin', 'POST', '/jobs', { customer_id: cust, title: 'Panel swap', tech_ids: [techId] })).data.id;
});
after(() => server.close());

test('on hold needs a reason and a follow-up date', async () => {
  assert.match((await call('admin', 'PUT', `/jobs/${jobId}`, { status: 'on_hold' })).data.error, /reason/);
  assert.match((await call('admin', 'PUT', `/jobs/${jobId}`, { status: 'on_hold', hold_reason: 'Waiting on the utility' })).data.error, /follow-up date/);
  assert.match((await call('admin', 'PUT', `/jobs/${jobId}`, { status: 'on_hold', hold_reason: 'Waiting on the utility', hold_follow_up: day(-3) })).data.error, /past/);
  assert.match((await call('tech', 'PUT', `/jobs/${jobId}`, { status: 'on_hold' })).data.error, /reason/, 'techs too');
  assert.equal((await call('tech', 'PUT', `/jobs/${jobId}`, { status: 'on_hold', hold_reason: 'Waiting on the utility to set the meter', hold_follow_up: day(5) })).status, 200);
  const j = (await call('admin', 'GET', `/jobs/${jobId}`)).data;
  assert.equal(j.status, 'on_hold'); assert.equal(j.hold_reason, 'Waiting on the utility to set the meter'); assert.equal(j.hold_follow_up, day(5));
  assert.equal(j.hold_by_name, 'Tech'); assert.ok(j.hold_at);
  assert.match(j.notes.map(n => n.body).join('\n'), /Put on hold: Waiting on the utility to set the meter — follow up/);
});

test('the follow-up is on the schedule, the dashboard and a calendar file; moving it updates the same event', async () => {
  const f = (await call('admin', 'GET', `/job-follow-ups?from=${day(0)}&to=${day(7)}`)).data;
  assert.deepEqual(f.map(x => [x.id, x.hold_follow_up]), [[jobId, day(5)]]);
  assert.equal((await call('tech', 'GET', '/job-follow-ups')).status, 403);
  assert.equal((await call('admin', 'GET', '/dashboard')).data.follow_ups_due.length, 0, 'not due yet');
  let ics = (await call('admin', 'GET', `/jobs/${jobId}/hold.ics`));
  assert.match(ics.type, /text\/calendar/);
  assert.match(ics.data, new RegExp(`DTSTART;VALUE=DATE:${day(5).replace(/-/g, '')}`)); assert.match(ics.data, /UID:job-hold-\d+@fieldops/); assert.match(ics.data, /SUMMARY:Task: follow up on J-\d+ \(on hold\)/);
  const seq1 = +ics.data.match(/SEQUENCE:(\d+)/)[1];
  await call('admin', 'PUT', `/jobs/${jobId}`, { hold_follow_up: day(0) });
  ics = (await call('admin', 'GET', `/jobs/${jobId}/hold.ics`));
  assert.equal(+ics.data.match(/SEQUENCE:(\d+)/)[1], seq1 + 1, 'same event, newer version');
  assert.equal((await call('admin', 'GET', '/dashboard')).data.follow_ups_due[0].id, jobId, 'due today');
  const j = (await call('admin', 'GET', `/jobs/${jobId}`)).data;
  assert.equal(j.hold_reason, 'Waiting on the utility to set the meter', 'reason kept when only the date moves');
  assert.match(j.notes.map(n => n.body).join('\n'), /Follow-up moved to/);
});

test('off hold clears the follow-up and keeps the history; a job can be booked on hold', async () => {
  await call('admin', 'PUT', `/jobs/${jobId}`, { status: 'scheduled' });
  const j = (await call('admin', 'GET', `/jobs/${jobId}`)).data;
  assert.equal(j.hold_reason, null); assert.equal(j.hold_follow_up, null);
  assert.match(j.notes.map(n => n.body).join('\n'), /Taken off hold \(was: Waiting on the utility to set the meter\)/);
  assert.equal((await call('admin', 'GET', `/jobs/${jobId}/hold.ics`)).status, 404);
  const cust = (await call('admin', 'POST', '/customers', { name: 'Second Customer' })).data.id;
  assert.equal((await call('admin', 'POST', '/jobs', { customer_id: cust, title: 'Service upgrade', status: 'on_hold' })).status, 400);
  const id2 = (await call('admin', 'POST', '/jobs', { customer_id: cust, title: 'Service upgrade', status: 'on_hold', hold_reason: 'Customer financing pending', hold_follow_up: day(10) })).data.id;
  const j2 = (await call('admin', 'GET', `/jobs/${id2}`)).data;
  assert.equal(j2.hold_follow_up, day(10)); assert.match(j2.notes[0].body, /Customer financing pending/);
});

test('the follow-up is a task for someone: the company default, or who was picked; they get the invite', async () => {
  const kId = (await call('admin', 'POST', '/users', { name: 'Office Person', email: 'k@x.com', password: 'password123', role: 'office' })).data.id;
  await call('admin', 'PUT', '/settings', { hold_followup_assignee: String(kId) });
  const cust = (await call('admin', 'POST', '/customers', { name: 'Third Customer' })).data.id;
  const id = (await call('admin', 'POST', '/jobs', { customer_id: cust, title: 'Generator hookup', tech_ids: [techId] })).data.id;
  await call('tech', 'PUT', `/jobs/${id}`, { status: 'on_hold', hold_reason: 'Generator not delivered', hold_follow_up: day(3) });
  let j = (await call('admin', 'GET', `/jobs/${id}`)).data;
  assert.equal(j.hold_assignee, kId, 'the Settings person, not the tech who set it'); assert.equal(j.hold_assignee_name, 'Office Person');
  assert.match(j.notes[0].body, /\(Office Person\)/);
  const f = (await call('admin', 'GET', `/job-follow-ups?from=${day(0)}&to=${day(7)}`)).data.find(x => x.id === id);
  assert.equal(f.hold_assignee, kId); assert.equal(f.assignee_name, 'Office Person');
  assert.match((await call('admin', 'GET', `/jobs/${id}/hold.ics`)).data, /SUMMARY:Task: follow up on J-\d+/);
  // hand it to someone else
  await call('admin', 'PUT', `/jobs/${id}`, { hold_assignee: techId });
  j = (await call('admin', 'GET', `/jobs/${id}`)).data;
  assert.equal(j.hold_assignee, techId); assert.match(j.notes[0].body, /Follow-up now with Tech/);
  assert.match((await call('admin', 'PUT', `/jobs/${id}`, { hold_assignee: 99999 })).data.error, /active user/);
  // off hold clears it
  await call('admin', 'PUT', `/jobs/${id}`, { status: 'scheduled' });
  assert.equal((await call('admin', 'GET', `/jobs/${id}`)).data.hold_assignee, null);
});
