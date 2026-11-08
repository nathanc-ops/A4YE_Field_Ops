'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'a4y-uploads-'));
const D = require('../server/db');
const { createApp } = require('../server/app');

let server, base, db;
const tok = {};
const ids = {};
async function call(who, method, p, body) {
  const res = await fetch(base + '/api' + p, { method, headers: { 'Content-Type': 'application/json', ...(tok[who] ? { Authorization: 'Bearer ' + tok[who] } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const ct = res.headers.get('content-type') || '';
  return { status: res.status, data: ct.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()), headers: res.headers };
}
// 1×1 PNG
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

before(async () => {
  db = D.open(':memory:');
  server = createApp(db).listen(0);
  await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  tok.admin = (await call(null, 'POST', '/setup', { name: 'Owner', email: 'o@x.com', password: 'longenough' })).data.token;
  ids.tech = (await call('admin', 'POST', '/users', { name: 'T', email: 't@x.com', password: 'longenough', role: 'tech', hourly_wage: 30 })).data.id;
  ids.other = (await call('admin', 'POST', '/users', { name: 'O', email: 'o2@x.com', password: 'longenough', role: 'tech' })).data.id;
  tok.tech = (await call(null, 'POST', '/login', { email: 't@x.com', password: 'longenough' })).data.token;
  tok.other = (await call(null, 'POST', '/login', { email: 'o2@x.com', password: 'longenough' })).data.token;
  ids.cust = (await call('admin', 'POST', '/customers', { name: 'Pat', email: 'p@x.com', location: { address: '1 Elm' } })).data.id;
  ids.loc = (await call('admin', 'GET', `/customers/${ids.cust}`)).data.locations[0].id;
  ids.job = (await call('admin', 'POST', '/jobs', { customer_id: ids.cust, location_id: ids.loc, title: 'EV charger', job_type: 'ev_charger', tech_ids: [ids.tech] })).data.id;
});
after(() => server.close());

test('checklists attach by job type and gate completion', async () => {
  const job = (await call('tech', 'GET', `/jobs/${ids.job}`)).data;
  assert.deepEqual(job.forms.map(f => f.name), ['Job start safety', 'EV charger install', 'Final walkthrough']);
  assert.deepEqual(job.completion_blockers, ['Job start safety', 'Final walkthrough']);
  // another tech can't see it
  assert.equal((await call('other', 'GET', `/jobs/${ids.job}/forms`)).status, 403);
  const ev = job.forms.find(f => f.name === 'EV charger install');
  let r = await call('tech', 'PUT', `/job-forms/${ev.id}`, { answers: { 0: 48 }, complete: true });
  assert.equal(r.status, 400, 'required items missing');
  r = await call('tech', 'PUT', `/job-forms/${ev.id}`, { answers: { 0: 48, 1: true, 2: 'fail', 3: true, 4: true }, complete: true });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.failed, ['GFCI protection provided where required']);
  assert.equal((await call('tech', 'PUT', `/job-forms/${ev.id}`, { answers: {} })).status, 400, 'completed checklist is locked');
  // tech blocked, office may override (and it is noted)
  assert.equal((await call('tech', 'POST', `/jobs/${ids.job}/complete`, {})).status, 400);
});

test('photos: upload, list, fetch with sniffed type; rejects disguised files; tech scope', async () => {
  let r = await call('tech', 'POST', '/attachments', { entity_type: 'job', entity_id: ids.job, tag: 'before', data: PNG, filename: 'panel.png', lat: 43.6, lng: -116.2 });
  assert.equal(r.status, 200);
  ids.photo = r.data.id;
  r = await call('tech', 'POST', '/attachments', { entity_type: 'job', entity_id: ids.job, data: 'data:image/png;base64,' + Buffer.from('<svg onload=alert(1)>').toString('base64') });
  assert.equal(r.status, 400, 'non-image content refused');
  assert.equal((await call('other', 'POST', '/attachments', { entity_type: 'job', entity_id: ids.job, data: PNG })).status, 403);
  const list = (await call('tech', 'GET', `/attachments?entity_type=job&entity_id=${ids.job}`)).data;
  assert.equal(list[0].tag, 'before');
  assert.equal(list[0].lat, 43.6);
  const f = await call('tech', 'GET', `/attachments/${ids.photo}/file`);
  assert.equal(f.headers.get('content-type'), 'image/png');
  assert.equal(f.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(f.data.subarray(1, 4).toString(), 'PNG');
  assert.equal((await call('other', 'GET', `/attachments/${ids.photo}/file`)).status, 403);
  assert.equal((await call(null, 'GET', `/attachments/${ids.photo}/file`)).status, 401);
});

test('GPS stamps on clock in/out and status changes', async () => {
  await call('tech', 'POST', '/time/clock-in', { job_id: ids.job, lat: 43.61, lng: -116.21, acc: 12 });
  await call('tech', 'POST', '/time/clock-out', { lat: 43.62, lng: -116.22, acc: 9 });
  await call('tech', 'POST', '/time/clock-in', { job_id: ids.job, lat: 'bogus', lng: 999 });
  await call('tech', 'POST', '/time/clock-out', {});
  const rows = (await call('admin', 'GET', `/time?user_id=${ids.tech}`)).data;
  const first = rows.find(r => r.in_lat === 43.61);
  assert.ok(first);
  assert.equal(first.out_lng, -116.22);
  assert.equal(first.in_acc, 12);
  assert.ok(rows.some(r => r.in_lat == null), 'invalid coordinates are ignored, not stored');
});

test('equipment records at the location; customer sign-off completes the job', async () => {
  let r = await call('tech', 'POST', '/equipment', { location_id: ids.loc, type: 'ev_charger', make: 'Tesla', model: 'Wall Connector Gen 3', serial: 'TWC-123', amps: '48', installed_job_id: ids.job });
  assert.equal(r.status, 200);
  assert.equal((await call('tech', 'POST', '/equipment', { location_id: ids.loc, type: 'spaceship' })).status, 400);
  const cust = (await call('admin', 'GET', `/customers/${ids.cust}`)).data;
  assert.equal(cust.locations[0].equipment[0].serial, 'TWC-123');
  // finish required lists, then sign off
  const forms = (await call('tech', 'GET', `/jobs/${ids.job}/forms`)).data.filter(f => !f.completed_at);
  for (const f of forms) await call('tech', 'PUT', `/job-forms/${f.id}`, { answers: Object.fromEntries(f.items.map((it, i) => [i, it.type === 'check' ? true : it.type === 'passfail' ? 'pass' : 1])), complete: true });
  r = await call('tech', 'POST', `/jobs/${ids.job}/complete`, { completion_notes: 'Installed and tested', signature: PNG, signoff_name: '' });
  assert.equal(r.status, 400, 'signature needs a printed name');
  r = await call('tech', 'POST', `/jobs/${ids.job}/complete`, { completion_notes: 'Installed and tested', signature: PNG, signoff_name: 'Pat Home' });
  assert.equal(r.status, 200);
  const job = (await call('admin', 'GET', `/jobs/${ids.job}`)).data;
  assert.equal(job.status, 'completed');
  assert.equal(job.signoff_name, 'Pat Home');
  const sig = job.attachments.find(a => a.kind === 'signature');
  assert.ok(sig);
  assert.equal((await call('admin', 'DELETE', `/attachments/${sig.id}`)).status, 400, 'signatures are permanent');
  // shows on the customer's invoice page
  const inv = (await call('admin', 'POST', `/jobs/${ids.job}/invoice`, {})).data.id;
  await call('admin', 'POST', `/invoices/${inv}/send`, {});
  const token = (await call('admin', 'GET', `/invoices/${inv}`)).data.public_token;
  const pub = (await call(null, 'GET', `/public/invoice/${token}`)).data;
  assert.equal(pub.job.signoff_name, 'Pat Home');
});

test('office can complete over missing checklists; it is recorded', async () => {
  const j = (await call('admin', 'POST', '/jobs', { customer_id: ids.cust, location_id: ids.loc, title: 'Fan', job_type: 'service', tech_ids: [ids.tech] })).data.id;
  const r = await call('admin', 'POST', `/jobs/${j}/complete`, {});
  assert.equal(r.status, 200);
  assert.ok(r.data.overridden.includes('Job start safety'));
  const job = (await call('admin', 'GET', `/jobs/${j}`)).data;
  assert.match(job.notes[0].body, /without these checklists/);
});
