'use strict';
// Push notifications to techs: who gets told what, and the three delivery paths (Web Push, Apple, Firebase) against fakes.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const http2 = require('node:http2');
const crypto = require('node:crypto');
const ece = require('http_ece');
const D = require('../server/db');
const { createApp } = require('../server/app');
const Push = require('../server/push');

process.env.PUSH_ALLOW_HTTP = '1';
let server, base, db, fake, h2, fcmSrv;
const tok = {}, ids = {}, got = [], apnsGot = [], fcmGot = [];
let pushStatus = 201;
async function call(who, method, p, body) {
  const res = await fetch(base + '/api' + p, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok[who] }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json() };
}
// a browser's push subscription: our own key pair, so the test can read what the server encrypted
function browserSub(name) {
  const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys();
  const auth = crypto.randomBytes(16).toString('base64url');
  return { ecdh, auth, sub: { endpoint: `http://127.0.0.1:${fake.address().port}/push/${name}`, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth } } };
}
const subs = {};
const read = name => got.filter(g => g.url === `/push/${name}`).map(g => JSON.parse(ece.decrypt(g.body, { version: 'aes128gcm', privateKey: subs[name].ecdh, authSecret: subs[name].auth }).toString()));
const T = (h, m = 0) => new Date(Date.UTC(2099, 10, 12, h, m)).toISOString();

before(async () => {
  fake = http.createServer((req, res) => { const b = []; req.on('data', d => b.push(d)); req.on('end', () => { got.push({ url: req.url, headers: req.headers, body: Buffer.concat(b) }); res.writeHead(pushStatus); res.end(); }); });
  await new Promise(r => fake.listen(0, '127.0.0.1', r));
  db = D.open(':memory:');
  server = createApp(db).listen(0); await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  tok.admin = (await call(null, 'POST', '/setup', { name: 'Owner Admin', email: 'owner@a4ye.example', password: 'longenough' })).data.token;
  await call('admin', 'PUT', '/settings', { company_name: 'All 4 You Electrical', company_email: 'office@a4ye.example', timezone: 'America/Boise' });
  for (const [k, name, role] of [['dana', 'Dana Tech', 'tech'], ['sam', 'Sam Tech', 'tech'], ['ann', 'Ann Office', 'office']]) {
    ids[k] = (await call('admin', 'POST', '/users', { name, email: `${k}@x.com`, password: 'password123', role })).data.id;
    tok[k] = (await call(null, 'POST', '/login', { email: `${k}@x.com`, password: 'password123' })).data.token;
  }
  ids.cust = (await call('admin', 'POST', '/customers', { name: 'Maria Lopez', location: { address: '12 Elm St', city: 'Boise' } })).data.id;
  ids.job = (await call('admin', 'POST', '/jobs', { customer_id: ids.cust, title: 'Garage circuit' })).data.id;
  for (const k of ['dana', 'sam', 'ann']) { subs[k] = browserSub(k); assert.equal((await call(k, 'POST', '/push/devices', { kind: 'web', subscription: subs[k].sub })).status, 200); }
});
after(() => { server.close(); fake.close(); if (h2) h2.close(); if (fcmSrv) fcmSrv.close(); delete process.env.PUSH_ALLOW_HTTP; delete process.env.APNS_BASE; delete process.env.FCM_BASE; });

test('device sign-up: config gives the server key; bad subscriptions refused; private keys never reach a browser', async () => {
  const c = (await call('dana', 'GET', '/push/config')).data;
  assert.match(c.web_key, /^[A-Za-z0-9_-]{80,}$/); assert.equal(c.devices.length, 1); assert.equal(c.apns, false);
  assert.equal((await call('dana', 'POST', '/push/devices', { kind: 'web', subscription: { endpoint: 'http://x' } })).status, 400);
  assert.equal((await call('dana', 'POST', '/push/devices', { kind: 'carrier-pigeon' })).status, 400);
  assert.equal((await call('dana', 'POST', '/push/devices', { kind: 'apns', token: 'short' })).status, 400);
  const me = (await call('admin', 'GET', '/me')).data.settings;
  assert.equal(me.vapid_private_key, ''); assert.equal(me.vapid_private_key_set, '1');
});

test('put on a new visit: the tech gets "New job" with when and where; the person who booked it does not', async () => {
  const n = got.length;
  ids.visit = (await call('ann', 'POST', '/appointments', { job_id: ids.job, start: T(20), end: T(21, 30), tech_ids: [ids.dana, ids.ann] })).data.id;
  await Push.idle();
  const d = read('dana');
  assert.equal(d.length, 1);
  assert.match(d[0].title, /^New job: J-\d+ Garage circuit$/); assert.equal(d[0].body, 'Thu, November 12, 1:00–2:30 PM · 12 Elm St, Boise');
  assert.equal(d[0].url, `#/jobs/${ids.job}`);
  assert.equal(read('ann').length, 0, 'not sent to the person who made the change');
  assert.match(got[n].headers.authorization, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=/); assert.equal(got[n].headers['content-encoding'], 'aes128gcm');
  const log = db.prepare('SELECT * FROM push_log ORDER BY id DESC').get();
  assert.equal(log.user_id, ids.dana); assert.equal(log.sent, 1);
});

test('moved, crew changed, cancelled, deleted: the right people hear the right thing, once', async () => {
  const before = { dana: read('dana').length, sam: read('sam').length };
  // add Sam and move the time in one save: Sam is told "New job" (with the new time), Dana "Time changed"
  await call('admin', 'PUT', `/appointments/${ids.visit}`, { start: T(21), end: T(22, 30), tech_ids: [ids.dana, ids.sam] });
  await Push.idle();
  assert.deepEqual(read('sam').slice(before.sam).map(m => m.title), [read('sam').slice(before.sam)[0].title]);
  assert.match(read('sam').at(-1).title, /^New job:/); assert.match(read('sam').at(-1).body, /2:00–3:30 PM/);
  assert.match(read('dana').at(-1).title, /^Time changed: J-\d+ Garage circuit$/); assert.match(read('dana').at(-1).body, /^Now Thu, November 12, 2:00–3:30 PM/);
  assert.equal(read('dana').length, before.dana + 1);
  // a status change alone is not news
  await call('admin', 'PUT', `/appointments/${ids.visit}`, { status: 'dispatched' }); await Push.idle();
  assert.equal(read('dana').length, before.dana + 1);
  // Sam taken off
  await call('admin', 'PUT', `/appointments/${ids.visit}`, { tech_ids: [ids.dana] }); await Push.idle();
  assert.match(read('sam').at(-1).title, /^Taken off: J-\d+/);
  // cancelled
  await call('admin', 'PUT', `/appointments/${ids.visit}`, { status: 'cancelled' }); await Push.idle();
  assert.match(read('dana').at(-1).title, /^Cancelled: J-\d+/); assert.match(read('dana').at(-1).body, /is off your schedule/);
  // deleted (worded before it's gone)
  const v2 = (await call('admin', 'POST', '/appointments', { job_id: ids.job, start: T(16), end: T(17), tech_ids: [ids.sam] })).data.id;
  await call('admin', 'DELETE', `/appointments/${v2}`); await Push.idle();
  assert.deepEqual(read('sam').slice(-2).map(m => m.title.split(':')[0]), ['New job', 'Cancelled']);
  // a visit already over: nobody is woken up for it
  const n = got.length;
  await call('admin', 'POST', '/appointments', { job_id: ids.job, start: '2020-01-02T16:00:00Z', end: '2020-01-02T17:00:00Z', tech_ids: [ids.sam] }); await Push.idle();
  assert.equal(got.length, n);
});

test('a job with a crew but no time yet; a job booked with a time sends one notice, not two', async () => {
  const n = read('sam').length;
  const j = (await call('admin', 'POST', '/jobs', { customer_id: ids.cust, title: 'Panel swap', tech_ids: [ids.sam] })).data.id; await Push.idle();
  assert.match(read('sam').at(-1).title, /^New job: J-\d+ Panel swap$/); assert.match(read('sam').at(-1).body, /^Not scheduled yet/);
  assert.equal(read('sam').at(-1).url, `#/jobs/${j}`);
  await call('admin', 'POST', '/jobs', { customer_id: ids.cust, title: 'Hot tub circuit', tech_ids: [ids.sam], scheduled_start: T(18), scheduled_end: T(19) }); await Push.idle();
  assert.equal(read('sam').length, n + 2);
  assert.match(read('sam').at(-1).body, /^Thu, November 12/, 'the visit notice, which has the time');
});

test('one day of a multi-day visit: only that day\'s changes are told', async () => {
  const mv = (await call('admin', 'POST', '/appointments', { job_id: ids.job, start: '2099-11-16T14:00:00Z', end: '2099-11-20T22:30:00Z', tech_ids: [ids.dana] })).data.id;
  await Push.idle();
  const d0 = read('dana').length, s0 = read('sam').length;
  // Wednesday: Sam instead of Dana, same hours
  await call('admin', 'POST', `/appointments/${mv}/day`, { day_from: '2099-11-18T07:00:00Z', day_to: '2099-11-19T07:00:00Z', start: '2099-11-18T14:00:00Z', end: '2099-11-18T22:30:00Z',
    before_end: '2099-11-17T22:30:00Z', after_start: '2099-11-19T14:00:00Z', tech_ids: [ids.sam] });
  await Push.idle();
  assert.equal(read('sam').length, s0 + 1); assert.match(read('sam').at(-1).body, /^Wed, November 18/);
  assert.equal(read('dana').length, d0 + 1); assert.match(read('dana').at(-1).title, /^Taken off/); assert.match(read('dana').at(-1).body, /Wed, November 18/);
});

test('a browser that was uninstalled (410) is dropped; the test button reports no device', async () => {
  pushStatus = 410;
  await call('admin', 'POST', '/appointments', { job_id: ids.job, start: T(14), end: T(15), tech_ids: [ids.sam] }); await Push.idle();
  pushStatus = 201;
  assert.equal(db.prepare('SELECT COUNT(*) n FROM push_devices WHERE user_id = ?').get(ids.sam).n, 0);
  assert.equal((await call('sam', 'POST', '/push/test')).status, 400);
  const t = (await call('dana', 'POST', '/push/test')).data; assert.equal(t.sent, 1);
});

test('App Store iPhone app: Apple push over HTTP/2 with a signed token; a dead token is dropped', async () => {
  h2 = http2.createServer();
  h2.on('stream', (stream, headers) => {
    let b = ''; stream.on('data', d => { b += d; });
    stream.on('end', () => { apnsGot.push({ headers, body: JSON.parse(b) });
      const dead = headers[':path'].endsWith('/dead' + 'a'.repeat(60));
      stream.respond({ ':status': dead ? 410 : 200, 'content-type': 'application/json' }); stream.end(dead ? JSON.stringify({ reason: 'Unregistered' }) : ''); });
  });
  await new Promise(r => h2.listen(0, '127.0.0.1', r));
  process.env.APNS_BASE = `http://127.0.0.1:${h2.address().port}`;
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  assert.equal((await call('admin', 'PUT', '/push/admin', { apns_key_p8: 'not a key' })).status, 400);
  const r = await call('admin', 'PUT', '/push/admin', { apns_key_p8: privateKey.export({ type: 'pkcs8', format: 'pem' }), apns_key_id: 'ABC123DEFG', apns_team_id: 'TEAM123456' });
  assert.equal(r.data.apns, true);
  assert.equal((await call('admin', 'GET', '/me')).data.settings.apns_key_p8, '', 'the key never goes back to a browser');
  const tokenOk = 'f'.repeat(64), tokenDead = 'dead' + 'a'.repeat(60);
  await call('sam', 'POST', '/push/devices', { kind: 'apns', token: tokenOk, platform: 'ios' });
  await call('sam', 'POST', '/push/devices', { kind: 'apns', token: tokenDead, platform: 'ios' });
  await call('admin', 'POST', '/appointments', { job_id: ids.job, start: T(23), end: T(23, 45), tech_ids: [ids.sam] }); await Push.idle();
  const m = apnsGot.find(x => x.headers[':path'] === `/3/device/${tokenOk}`);
  assert.ok(m, 'sent to the phone');
  assert.equal(m.headers['apns-topic'], 'com.all4youelectrical.fieldops'); assert.equal(m.headers['apns-push-type'], 'alert');
  assert.match(m.body.aps.alert.title, /^New job: J-\d+/); assert.equal(m.body.url, `#/jobs/${ids.job}`);
  const [h, c, sig] = m.headers.authorization.replace('bearer ', '').split('.');
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url')), { alg: 'ES256', kid: 'ABC123DEFG' });
  assert.equal(JSON.parse(Buffer.from(c, 'base64url')).iss, 'TEAM123456');
  assert.ok(crypto.verify('sha256', Buffer.from(`${h}.${c}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url')), 'signed with the .p8 key');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM push_devices WHERE token = ?').get(tokenDead).n, 0, 'uninstalled phone dropped');
});

test('Google Play Android app: Firebase sign-in with the service account, then the message; unregistered dropped', async () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  fcmSrv = http.createServer((req, res) => { let b = ''; req.on('data', d => { b += d; }); req.on('end', () => {
    if (req.url === '/token') {
      const assertion = new URLSearchParams(b).get('assertion'), [h, c, s] = assertion.split('.');
      const ok = crypto.verify('RSA-SHA256', Buffer.from(`${h}.${c}`), publicKey, Buffer.from(s, 'base64url'));
      fcmGot.push({ token: JSON.parse(Buffer.from(c, 'base64url')), ok });
      res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ access_token: 'ya29.test', expires_in: 3600 }));
    }
    const j = JSON.parse(b); fcmGot.push({ url: req.url, auth: req.headers.authorization, body: j });
    if (j.message.token.startsWith('gone')) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: { status: 'NOT_FOUND', details: [{ errorCode: 'UNREGISTERED' }] } })); }
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ name: 'projects/a4ye/messages/1' }));
  }); });
  await new Promise(r => fcmSrv.listen(0, '127.0.0.1', r));
  const port = fcmSrv.address().port; process.env.FCM_BASE = `http://127.0.0.1:${port}`;
  assert.equal((await call('admin', 'PUT', '/push/admin', { fcm_service_account: '{"nope":1}' })).status, 400);
  const sa = { type: 'service_account', project_id: 'a4ye-field-ops', client_email: 'push@a4ye-field-ops.iam.gserviceaccount.com',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }), token_uri: `http://127.0.0.1:${port}/token` };
  assert.equal((await call('admin', 'PUT', '/push/admin', { fcm_service_account: JSON.stringify(sa) })).data.fcm, true);
  await call('dana', 'POST', '/push/devices', { kind: 'fcm', token: 'fcmtoken_' + 'x'.repeat(40), platform: 'android' });
  await call('dana', 'POST', '/push/devices', { kind: 'fcm', token: 'gone_' + 'y'.repeat(40), platform: 'android' });
  await call('admin', 'POST', '/appointments', { job_id: ids.job, start: T(13), end: T(14), tech_ids: [ids.dana] }); await Push.idle();
  const t = fcmGot.find(x => x.token);
  assert.ok(t.ok, 'the sign-in token is signed with the service account key');
  assert.equal(t.token.scope, 'https://www.googleapis.com/auth/firebase.messaging'); assert.equal(t.token.iss, sa.client_email);
  const m = fcmGot.find(x => x.url && x.body.message.token.startsWith('fcmtoken_'));
  assert.equal(m.url, '/v1/projects/a4ye-field-ops/messages:send'); assert.equal(m.auth, 'Bearer ya29.test');
  assert.match(m.body.message.notification.title, /^New job: J-\d+/); assert.equal(m.body.message.data.url, `#/jobs/${ids.job}`);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM push_devices WHERE token LIKE 'gone_%'").get().n, 0);
  // admin view
  const a = (await call('admin', 'GET', '/push/admin')).data;
  assert.equal(a.fcm_project, 'a4ye-field-ops'); assert.ok(a.devices.some(d => d.name === 'Dana Tech' && d.kind === 'fcm')); assert.ok(a.log.length);
  assert.equal((await call('dana', 'GET', '/push/admin')).status, 403);
});

test('merge: one notice per person per visit, the most important one; a job notice gives way to its visit notice', () => {
  const m = Push.merge([{ type: 'moved', user_id: 1, appt_id: 5, job_id: 9 }, { type: 'assigned', user_id: 1, appt_id: 5, job_id: 9 }, { type: 'job', user_id: 1, job_id: 9 }, { type: 'job', user_id: 2, job_id: 9 }]);
  assert.deepEqual(m.map(e => `${e.user_id}:${e.type}`).sort(), ['1:assigned', '2:job']);
});
