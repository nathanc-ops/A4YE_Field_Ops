'use strict';
// Push notifications to the crew's phones: "you've been put on a job", "your visit moved", "your visit was cancelled".
//
// Three ways a phone can be reached, one table of devices (push_devices):
//  - web:  the browser / home-screen app (Android Chrome, iPhone 16.4+ once added to the Home Screen, desktop browsers).
//          Standard Web Push. The server makes its own key pair (VAPID) the first time; nothing to sign up for.
//  - apns: the App Store iPhone app. Needs an APNs key (.p8) from the Apple Developer account: Settings → Push.
//  - fcm:  the Google Play Android app. Needs a Firebase service-account JSON: Settings → Push.
// A phone that has been uninstalled or turned notifications off is dropped when its push service says so.
//
// Sending happens after the change is saved: the scheduling code calls queue(); the events are sent once the request
// finishes without an error (so a change that gets rolled back never notifies anyone), merged per person, and never
// sent to the person who made the change.
const { AsyncLocalStorage } = require('node:async_hooks');
const crypto = require('node:crypto');
const http2 = require('node:http2');
const D = require('./db');
const { all, get, run } = D;

const als = new AsyncLocalStorage();
let DB = null;
const settings = () => D.settings(DB);
const setSetting = (k, v) => DB.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, v);

// ---------------------------------------------------------------- keys
function vapid() {
  const s = settings();
  if (s.vapid_public_key && s.vapid_private_key) return { publicKey: s.vapid_public_key, privateKey: s.vapid_private_key };
  const k = require('web-push').generateVAPIDKeys();
  setSetting('vapid_public_key', k.publicKey); setSetting('vapid_private_key', k.privateKey);
  return k;
}
const vapidSubject = () => {
  const s = settings(), e = String(s.company_email || '').trim();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) ? `mailto:${e}` : (process.env.PUBLIC_URL || 'https://ops.all4youelectrical.com');
};
function apnsConfig() {
  const s = settings();
  if (!s.apns_key_p8 || !s.apns_key_id || !s.apns_team_id) return null;
  return { key: s.apns_key_p8, keyId: String(s.apns_key_id).trim(), teamId: String(s.apns_team_id).trim(),
    topic: String(s.apns_bundle_id || 'com.all4youelectrical.fieldops').trim(), sandbox: s.apns_env === 'sandbox' };
}
function fcmConfig() {
  const s = settings();
  if (!s.fcm_service_account) return null;
  try { const j = JSON.parse(s.fcm_service_account); return j.client_email && j.private_key && j.project_id ? j : null; } catch { return null; }
}
const b64url = b => Buffer.from(b).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
function jwt(header, claims, key, alg) {
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const sig = alg === 'ES256' ? crypto.sign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' }) : crypto.sign('RSA-SHA256', Buffer.from(input), key);
  return `${input}.${b64url(sig)}`;
}

// ---------------------------------------------------------------- transports: each returns { ok } or { ok:false, gone, error }
async function sendWeb(dev, msg) {
  const wp = require('web-push'), v = vapid();
  const sub = { endpoint: dev.token, keys: JSON.parse(dev.keys || '{}') };
  const d = wp.generateRequestDetails(sub, JSON.stringify(msg), { vapidDetails: { subject: vapidSubject(), publicKey: v.publicKey, privateKey: v.privateKey }, TTL: 6 * 3600, urgency: 'high' });
  const r = await fetch(d.endpoint, { method: d.method, headers: d.headers, body: d.body, signal: AbortSignal.timeout(15000) });
  if (r.status >= 200 && r.status < 300) return { ok: true };
  return { ok: false, gone: r.status === 404 || r.status === 410, error: `${r.status} ${(await r.text()).slice(0, 200)}` };
}

let apnsJwt = { token: null, at: 0, keyId: null };
function sendApns(dev, msg) {
  const c = apnsConfig(); if (!c) return { ok: false, error: 'APNs key not set up (Settings → Push notifications)' };
  if (!apnsJwt.token || apnsJwt.keyId !== c.keyId || Date.now() - apnsJwt.at > 45 * 60e3)
    apnsJwt = { token: jwt({ alg: 'ES256', kid: c.keyId }, { iss: c.teamId, iat: Math.floor(Date.now() / 1000) }, c.key, 'ES256'), at: Date.now(), keyId: c.keyId };
  const base = process.env.APNS_BASE || (c.sandbox ? 'https://api.sandbox.push.apple.com' : 'https://api.push.apple.com');
  const payload = JSON.stringify({ aps: { alert: { title: msg.title, body: msg.body }, sound: 'default' }, url: msg.url });
  return new Promise(resolve => {
    let done = false; const finish = r => { if (!done) { done = true; try { client.close(); } catch { /* closed */ } resolve(r); } };
    const client = http2.connect(base);
    client.on('error', e => finish({ ok: false, error: `Couldn't reach Apple: ${e.message}` }));
    const req = client.request({ ':method': 'POST', ':path': `/3/device/${dev.token}`, authorization: `bearer ${apnsJwt.token}`,
      'apns-topic': c.topic, 'apns-push-type': 'alert', 'apns-priority': '10', 'content-type': 'application/json' });
    let status = 0, body = '';
    req.setTimeout(15000, () => { req.close(); finish({ ok: false, error: 'Apple did not answer' }); });
    req.on('response', h => { status = h[':status']; });
    req.on('data', d => { body += d; });
    req.on('end', () => {
      if (status === 200) return finish({ ok: true });
      let reason = ''; try { reason = JSON.parse(body).reason; } catch { reason = body; }
      if (['InvalidProviderToken', 'ExpiredProviderToken'].includes(reason)) apnsJwt.token = null;
      finish({ ok: false, gone: status === 410 || ['BadDeviceToken', 'Unregistered', 'DeviceTokenNotForTopic'].includes(reason), error: `${status} ${reason}` });
    });
    req.on('error', e => finish({ ok: false, error: e.message }));
    req.end(payload);
  });
}

let fcmToken = { token: null, exp: 0, who: null };
async function sendFcm(dev, msg) {
  const c = fcmConfig(); if (!c) return { ok: false, error: 'Firebase not set up (Settings → Push notifications)' };
  if (!fcmToken.token || fcmToken.who !== c.client_email || Date.now() > fcmToken.exp) {
    const now = Math.floor(Date.now() / 1000), aud = c.token_uri || 'https://oauth2.googleapis.com/token';
    const assertion = jwt({ alg: 'RS256', typ: 'JWT' }, { iss: c.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud, iat: now, exp: now + 3600 }, c.private_key, 'RS256');
    const r = await fetch(aud, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: AbortSignal.timeout(15000),
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) return { ok: false, error: `Google sign-in failed: ${j.error_description || j.error || r.status}` };
    fcmToken = { token: j.access_token, exp: Date.now() + (Number(j.expires_in) || 3600) * 1000 - 120e3, who: c.client_email };
  }
  const base = (process.env.FCM_BASE || 'https://fcm.googleapis.com').replace(/\/+$/, '');
  const r = await fetch(`${base}/v1/projects/${encodeURIComponent(c.project_id)}/messages:send`, { method: 'POST', signal: AbortSignal.timeout(15000),
    headers: { Authorization: `Bearer ${fcmToken.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: { token: dev.token, notification: { title: msg.title, body: msg.body }, data: { url: msg.url || '' },
      android: { priority: 'high', notification: { sound: 'default' } } } }) });
  if (r.ok) return { ok: true };
  const t = await r.text();
  if (r.status === 401) fcmToken.token = null;
  return { ok: false, gone: r.status === 404 || /UNREGISTERED|registration-token-not-registered/.test(t), error: `${r.status} ${t.slice(0, 200)}` };
}
const TRANSPORT = { web: sendWeb, apns: sendApns, fcm: sendFcm };

// ---------------------------------------------------------------- send to a person
async function sendToUser(userId, msg, { log = true } = {}) {
  const devices = all(DB, 'SELECT * FROM push_devices WHERE user_id = ?', userId);
  let sent = 0; const errors = [];
  for (const dev of devices) {
    let r;
    try { r = await TRANSPORT[dev.kind](dev, msg); } catch (e) { r = { ok: false, error: e.message }; }
    if (r.ok) { sent++; run(DB, "UPDATE push_devices SET last_ok_at = datetime('now'), last_error = NULL WHERE id = ?", dev.id); }
    else if (r.gone) run(DB, 'DELETE FROM push_devices WHERE id = ?', dev.id);
    else { errors.push(`${dev.kind}: ${r.error}`); run(DB, 'UPDATE push_devices SET last_error = ? WHERE id = ?', String(r.error).slice(0, 300), dev.id); }
  }
  if (log) run(DB, 'INSERT INTO push_log (user_id, title, body, url, devices, sent, error) VALUES (?,?,?,?,?,?,?)', userId, msg.title, msg.body, msg.url || null, devices.length, sent, errors.join('; ') || null);
  return { devices: devices.length, sent, errors };
}

// ---------------------------------------------------------------- what the tech is told
function visitInfo(apptId) {
  const a = get(DB, `SELECT a.*, COALESCE(j.number, e.number) number, COALESCE(NULLIF(j.title, ''), NULLIF(e.title, ''), 'Estimate visit') title,
      l.address, l.city FROM appointments a LEFT JOIN jobs j ON j.id = a.job_id LEFT JOIN estimates e ON e.id = a.estimate_id
      LEFT JOIN locations l ON l.id = COALESCE(j.location_id, e.location_id,
        (SELECT id FROM locations WHERE customer_id = COALESCE(j.customer_id, e.customer_id) ORDER BY id LIMIT 1)) WHERE a.id = ?`, apptId);
  if (!a) return null;
  const s = settings(), tz = (() => { try { const z = s.timezone || 'America/Boise'; new Intl.DateTimeFormat('en-US', { timeZone: z }); return z; } catch { return 'America/Boise'; } })();
  const { when } = require('./appt_confirm');
  return { ...a, when: when(a, tz).short, where: [a.address, a.city].filter(Boolean).join(', '), est: !!a.estimate_id,
    url: a.estimate_id ? `#/estimates/${a.estimate_id}` : `#/jobs/${a.job_id}` };
}
function message(ev) {
  if (ev.type === 'job') {
    const j = get(DB, `SELECT j.id, j.number, j.title, l.address, l.city FROM jobs j
      LEFT JOIN locations l ON l.id = COALESCE(j.location_id, (SELECT id FROM locations WHERE customer_id = j.customer_id ORDER BY id LIMIT 1)) WHERE j.id = ?`, ev.job_id);
    if (!j) return null;
    return { title: `New job: ${j.number} ${j.title || ''}`.trim(), body: ['Not scheduled yet', [j.address, j.city].filter(Boolean).join(', ')].filter(Boolean).join(' · '), url: `#/jobs/${j.id}` };
  }
  const v = visitInfo(ev.appt_id); if (!v) return null;
  const what = `${v.number} ${v.title}`.trim(), where = v.where ? ` · ${v.where}` : '';
  if (ev.type === 'assigned') return { title: `${v.est ? 'New estimate visit' : 'New job'}: ${what}`, body: `${v.when}${where}`, url: v.url };
  if (ev.type === 'moved') return { title: `Time changed: ${what}`, body: `Now ${v.when}${where}`, url: v.url };
  if (ev.type === 'cancelled') return { title: `Cancelled: ${what}`, body: `${v.when} is off your schedule`, url: '#/' };
  if (ev.type === 'removed') return { title: `Taken off: ${what}`, body: `You're no longer on ${v.when}`, url: '#/' };
  return null;
}

// one message per person per visit; "assigned" wins over "moved"; a job-level notice is dropped when a visit for that job is
function merge(events) {
  const rank = { assigned: 4, cancelled: 3, removed: 3, moved: 2, job: 1 };
  const byKey = new Map();
  for (const e of events) {
    const k = `${e.user_id}:${e.appt_id ? `a${e.appt_id}` : `j${e.job_id}`}`;
    if (!byKey.has(k) || rank[e.type] > rank[byKey.get(k).type]) byKey.set(k, e);
  }
  const list = [...byKey.values()];
  return list.filter(e => e.type !== 'job' || !list.some(o => o.user_id === e.user_id && o.appt_id && o.job_id === e.job_id));
}

// ---------------------------------------------------------------- queue (called from the scheduling code)
let pending = Promise.resolve();
const later = (events, actorId) => { pending = pending.then(() => flush(events, actorId)).catch(e => console.error('push failed', e)); };
function queue(ev) {
  const store = als.getStore();
  if (store) store.events.push(ev); else later([ev], null);
}
async function flush(events, actorId) {
  if (!DB) return;
  for (const ev of merge(events)) {
    if (ev.user_id === actorId) continue;
    const u = get(DB, 'SELECT active FROM users WHERE id = ?', ev.user_id);
    if (!u || !u.active) continue;
    if (!get(DB, 'SELECT 1 x FROM push_devices WHERE user_id = ? LIMIT 1', ev.user_id)) continue;
    const msg = ev.msg || message(ev); if (!msg) continue;
    try { await sendToUser(ev.user_id, msg); } catch (e) { console.error('push failed', e); }
  }
}
// after auth: collect this request's events, send them once it has finished without an error
function middleware(req, res, next) {
  const store = { events: [] };
  res.on('finish', () => { if (res.statusCode < 400 && store.events.length) later(store.events, req.user && req.user.id); });
  als.run(store, next);
}
const idle = () => new Promise(r => setTimeout(r, 30)).then(() => pending); // tests: wait for sends to finish

// ---------------------------------------------------------------- routes
function routes(app, db, { wrap, bad, admin }) {
  DB = db;
  const status = () => ({ web: true, web_key: vapid().publicKey, apns: !!apnsConfig(), fcm: !!fcmConfig() });
  // what this device needs to subscribe, and whether it already is
  app.get('/api/push/config', (req, res) => res.json({ ...status(), devices: all(db, 'SELECT id, kind, platform, created_at, last_ok_at, last_error FROM push_devices WHERE user_id = ? ORDER BY id DESC', req.user.id) }));
  app.post('/api/push/devices', wrap((req, res) => {
    const b = req.body || {}, kind = b.kind;
    if (!['web', 'apns', 'fcm'].includes(kind)) throw bad('Unknown kind of device');
    let token, keys = null;
    if (kind === 'web') {
      const s = b.subscription || {};
      if (!/^https:\/\/\S+$/.test(String(s.endpoint || '')) && !process.env.PUSH_ALLOW_HTTP) throw bad('That browser subscription has no https endpoint');
      if (!s.keys || !s.keys.p256dh || !s.keys.auth) throw bad('That browser subscription is missing its keys');
      token = s.endpoint; keys = JSON.stringify({ p256dh: s.keys.p256dh, auth: s.keys.auth });
    } else {
      token = String(b.token || '').trim();
      if (!/^[\w:.-]{20,4096}$/.test(token)) throw bad('That device token does not look right');
    }
    const platform = String(b.platform || kind).slice(0, 40), ua = String(req.get('user-agent') || '').slice(0, 300);
    // a phone handed to someone else: the token moves to the person now signed in
    run(db, `INSERT INTO push_devices (user_id, kind, token, keys, platform, user_agent) VALUES (?,?,?,?,?,?)
      ON CONFLICT(token) DO UPDATE SET user_id = excluded.user_id, kind = excluded.kind, keys = excluded.keys, platform = excluded.platform, user_agent = excluded.user_agent, last_error = NULL`,
      req.user.id, kind, token, keys, platform, ua);
    res.json({ ok: true, id: get(db, 'SELECT id FROM push_devices WHERE token = ?', token).id });
  }));
  app.delete('/api/push/devices', wrap((req, res) => {
    const b = req.body || {}, token = String(b.token || (b.subscription && b.subscription.endpoint) || '');
    if (b.id) run(db, 'DELETE FROM push_devices WHERE id = ? AND user_id = ?', Number(b.id), req.user.id);
    else if (token) run(db, 'DELETE FROM push_devices WHERE token = ? AND user_id = ?', token, req.user.id);
    res.json({ ok: true });
  }));
  app.post('/api/push/test', wrap(async (req, res) => {
    const r = await sendToUser(req.user.id, { title: 'Field Ops notifications are on', body: 'You\'ll get a notice here when you\'re put on a job or a visit changes.', url: '#/' }, { log: false });
    if (!r.devices) throw bad('This account has no phone or browser signed up for notifications yet');
    res.json(r);
  }));
  // admin: set-up status for the store apps, and recent notices
  app.get('/api/push/admin', admin, (req, res) => res.json({ ...status(), apns_key_id: settings().apns_key_id || '', apns_team_id: settings().apns_team_id || '',
    apns_bundle_id: settings().apns_bundle_id || 'com.all4youelectrical.fieldops', apns_env: settings().apns_env || 'production',
    fcm_project: (fcmConfig() || {}).project_id || '',
    devices: all(db, 'SELECT u.name, d.kind, COUNT(*) n, MAX(d.last_ok_at) last_ok, MAX(d.last_error) last_error FROM push_devices d JOIN users u ON u.id = d.user_id GROUP BY d.user_id, d.kind ORDER BY u.name'),
    log: all(db, 'SELECT p.*, u.name FROM push_log p JOIN users u ON u.id = p.user_id ORDER BY p.id DESC LIMIT 25') }));
  app.put('/api/push/admin', admin, wrap((req, res) => {
    const b = req.body || {};
    if (b.apns_key_p8) {
      const k = String(b.apns_key_p8).trim();
      try { crypto.createPrivateKey(k); } catch { throw bad('That APNs key isn\'t readable. Open the .p8 file in Notepad and paste everything, including the BEGIN and END lines.'); }
      setSetting('apns_key_p8', k);
    }
    for (const k of ['apns_key_id', 'apns_team_id', 'apns_bundle_id']) if (b[k] !== undefined) setSetting(k, String(b[k]).trim());
    if (b.apns_env !== undefined) setSetting('apns_env', b.apns_env === 'sandbox' ? 'sandbox' : 'production');
    if (b.fcm_service_account) {
      let j; try { j = JSON.parse(b.fcm_service_account); } catch { throw bad('That isn\'t the service-account JSON file. Paste the whole file Firebase downloaded.'); }
      if (!j.client_email || !j.private_key || !j.project_id) throw bad('That JSON is missing client_email, private_key or project_id — download a new private key from Firebase → Project settings → Service accounts.');
      try { crypto.createPrivateKey(j.private_key); } catch { throw bad('The private key inside that JSON isn\'t readable'); }
      setSetting('fcm_service_account', JSON.stringify(j));
    }
    if (b.apns_clear) setSetting('apns_key_p8', '');
    if (b.fcm_clear) setSetting('fcm_service_account', '');
    apnsJwt.token = null; fcmToken.token = null;
    res.json({ ok: true, ...status() });
  }));
}

module.exports = { routes, middleware, queue, sendToUser, flush, merge, message, idle, _vapid: vapid };
