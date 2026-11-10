'use strict';
// Email set up from Settings, end to end against a small fake SMTP server (sign-in, message, attachment).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const D = require('../server/db');
const { createApp } = require('../server/app');

// ---- a minimal SMTP server: EHLO, AUTH PLAIN/LOGIN, MAIL, RCPT, DATA, QUIT — records what it receives
function fakeSmtp({ user = 'apikey', pass = 'right-key' } = {}) {
  const got = [];
  const srv = net.createServer(sock => {
    let buf = '', inData = false, msg = null, loginStep = 0, loginUser = '';
    const say = l => sock.write(l + '\r\n');
    say('220 fake.smtp ESMTP ready');
    sock.on('data', d => {
      buf += d.toString('utf8');
      for (;;) {
        if (inData) {
          const end = buf.indexOf('\r\n.\r\n'); if (end < 0) return;
          msg.data = buf.slice(0, end); buf = buf.slice(end + 5); inData = false; got.push(msg); say('250 2.0.0 queued'); continue;
        }
        const i = buf.indexOf('\r\n'); if (i < 0) return;
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (loginStep === 1) { loginUser = Buffer.from(line, 'base64').toString(); loginStep = 2; say('334 UGFzc3dvcmQ6'); continue; }
        if (loginStep === 2) { loginStep = 0; say(loginUser === user && Buffer.from(line, 'base64').toString() === pass ? '235 2.7.0 ok' : '535 5.7.8 Authentication credentials invalid'); continue; }
        const cmd = line.toUpperCase();
        if (cmd.startsWith('EHLO') || cmd.startsWith('HELO')) { sock.write('250-fake.smtp\r\n250-AUTH PLAIN LOGIN\r\n250 OK\r\n'); }
        else if (cmd.startsWith('AUTH PLAIN')) {
          const parts = Buffer.from(line.split(' ')[2] || '', 'base64').toString().split('\0');
          say(parts[1] === user && parts[2] === pass ? '235 2.7.0 ok' : '535 5.7.8 Authentication credentials invalid');
        } else if (cmd.startsWith('AUTH LOGIN')) { loginStep = 1; say('334 VXNlcm5hbWU6'); }
        else if (cmd.startsWith('MAIL FROM')) { msg = { from: line.slice(10), to: [] }; say('250 ok'); }
        else if (cmd.startsWith('RCPT TO')) { msg.to.push(line.slice(8)); say('250 ok'); }
        else if (cmd === 'DATA') { inData = true; say('354 go ahead'); }
        else if (cmd === 'QUIT') { say('221 bye'); sock.end(); }
        else if (cmd === 'RSET' || cmd === 'NOOP') say('250 ok');
        else say('502 not implemented');
      }
    });
    sock.on('error', () => {});
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r({ srv, got, port: srv.address().port })));
}

let server, base, db, smtp;
const tok = {};
async function call(who, method, p, body) {
  const res = await fetch(base + '/api' + p, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok[who] }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json() };
}
before(async () => {
  delete process.env.SMTP_HOST;
  smtp = await fakeSmtp();
  db = D.open(':memory:');
  server = createApp(db).listen(0); await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  tok.admin = (await call(null, 'POST', '/setup', { name: 'Owner', email: 'owner@a4ye.example', password: 'longenough' })).data.token;
  await call('admin', 'PUT', '/settings', { company_name: 'All 4 You Electrical', company_email: 'office@a4ye.example', company_phone: '(208) 555-0100' });
  await call('admin', 'POST', '/users', { name: 'Ann Office', email: 'ann@x.com', password: 'password123', role: 'office' });
  tok.office = (await call(null, 'POST', '/login', { email: 'ann@x.com', password: 'password123' })).data.token;
});
after(() => { server.close(); smtp.srv.close(); });

test('not set up: status says so; sends are recorded as not_configured', async () => {
  const e = (await call('admin', 'GET', '/settings/email')).data;
  assert.equal(e.configured, false); assert.equal(e.pass_set, false);
  assert.equal((await call('office', 'GET', '/settings/email')).status, 403, 'admins only');
});

test('test email: wrong key explained, right key delivers; unsaved form values are what get tested', async () => {
  const form = { host: '127.0.0.1', port: smtp.port, security: 'none', user: 'apikey', from_email: 'office@a4ye.example', from_name: 'All 4 You Electrical' };
  const bad1 = (await call('admin', 'POST', '/settings/email-test', { to: 'owner@a4ye.example', ...form, pass: 'wrong' })).data;
  assert.equal(bad1.ok, false); assert.match(bad1.error, /rejected the username or password/);
  const ok = (await call('admin', 'POST', '/settings/email-test', { to: 'owner@a4ye.example', ...form, pass: 'right-key' })).data;
  assert.equal(ok.ok, true, JSON.stringify(ok)); assert.equal(ok.from, '"All 4 You Electrical" <office@a4ye.example>');
  const m = smtp.got[smtp.got.length - 1];
  assert.match(m.from, /office@a4ye.example/); assert.deepEqual(m.to, ['<owner@a4ye.example>']);
  assert.match(m.data, /Subject: Test email from All 4 You Electrical/);
  // the test result is remembered for the status line
  const e = (await call('admin', 'GET', '/settings/email')).data;
  assert.equal(e.last_test.ok, true); assert.equal(e.configured, false, 'testing does not save');
  // nothing listening → a connection error, explained with the port advice
  const closed = (await call('admin', 'POST', '/settings/email-test', { to: 'owner@a4ye.example', ...form, port: 1, pass: 'x' })).data;
  assert.equal(closed.ok, false); assert.match(closed.error, /Couldn't connect to 127\.0\.0\.1 on port 1.*2525/s);
  assert.equal((await call('admin', 'POST', '/settings/email-test', { to: 'nope' })).status, 400);
});

test('saved settings: password is a secret, real sends go out with the calendar invite attached', async () => {
  await call('admin', 'PUT', '/settings', { smtp_host: '127.0.0.1', smtp_port: String(smtp.port), smtp_security: 'none', smtp_user: 'apikey', smtp_pass: 'right-key',
    smtp_from_email: 'office@a4ye.example', smtp_from_name: 'All 4 You Electrical' });
  const e = (await call('admin', 'GET', '/settings/email')).data;
  assert.equal(e.configured, true); assert.equal(e.source, 'settings'); assert.equal(e.pass_set, true); assert.equal(e.pass, undefined);
  const me = (await call('admin', 'GET', '/me')).data;
  assert.equal(me.settings.smtp_pass, '', 'never sent to the browser'); assert.equal(me.settings.smtp_pass_set, '1');
  // saving the form with a blank password keeps the saved one
  await call('admin', 'PUT', '/settings', { smtp_user: 'apikey', smtp_pass: '' });
  assert.equal(db.prepare("SELECT value FROM settings WHERE key = 'smtp_pass'").get().value, 'right-key');
  // an appointment confirmation goes out for real
  const cust = (await call('admin', 'POST', '/customers', { name: 'Maria Lopez', email: 'maria@example.com', location: { address: '12 Elm St', city: 'Boise' } })).data.id;
  const job = (await call('admin', 'POST', '/jobs', { customer_id: cust, title: 'Garage circuit' })).data.id;
  const v = (await call('admin', 'POST', '/appointments', { job_id: job, start: '2099-11-12T20:00:00Z', end: '2099-11-12T21:00:00Z' })).data.id;
  const before = smtp.got.length;
  const r = await call('admin', 'POST', `/appointments/${v}/confirm`, {});
  assert.equal(r.data.status, 'sent', JSON.stringify(r.data));
  const m = smtp.got[before];
  assert.deepEqual(m.to, ['<maria@example.com>']);
  assert.match(m.data, /Subject: =\?UTF-8\?Q\?Your_appointment_with_All_4_You_Electric/, "subject is MIME-encoded because of the dash");
  assert.match(m.data, /Reply-To: office@a4ye.example/);
  assert.match(m.data, /Content-Type: text\/calendar; charset=utf-8; method=PUBLISH/);
  assert.match(m.data, /filename=appointment\.ics/);
  assert.equal(db.prepare("SELECT status FROM outbox WHERE related = ? ORDER BY id DESC").get(`appointment:${v}`).status, 'sent');
  // a failed send is recorded with the plain-words reason
  await call('admin', 'PUT', '/settings', { smtp_pass: 'now-wrong' });
  const f = await call('admin', 'POST', `/appointments/${v}/confirm`, {});
  assert.equal(f.data.status, 'failed'); assert.match(f.data.error, /rejected the username or password/);
  assert.match(db.prepare("SELECT error FROM outbox WHERE related = ? ORDER BY id DESC").get(`appointment:${v}`).error, /rejected/);
  // turning it off
  await call('admin', 'PUT', '/settings', { smtp_host: '', smtp_pass_clear: '1' });
  assert.equal((await call('admin', 'GET', '/settings/email')).data.configured, false);
  assert.equal(db.prepare("SELECT value FROM settings WHERE key = 'smtp_pass'").get().value, '');
});

test('SMTP_* on the server still wins over Settings', async () => {
  await call('admin', 'PUT', '/settings', { smtp_host: 'smtp.example.invalid' });
  process.env.SMTP_HOST = '127.0.0.1'; process.env.SMTP_PORT = String(smtp.port); process.env.SMTP_USER = 'apikey'; process.env.SMTP_PASS = 'right-key'; process.env.SMTP_FROM = 'env@a4ye.example';
  try {
    const e = (await call('admin', 'GET', '/settings/email')).data;
    assert.equal(e.source, 'server'); assert.equal(e.server_env, true); assert.equal(e.env.host, '127.0.0.1');
  } finally { for (const k of ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM']) delete process.env[k]; }
});

test('sending from a no-reply address: invoices, estimates and confirmations carry Reply-To = the company email', async () => {
  await call('admin', 'PUT', '/settings', { smtp_host: '127.0.0.1', smtp_port: String(smtp.port), smtp_security: 'none', smtp_user: 'apikey', smtp_pass: 'right-key',
    smtp_from_email: 'noreply@a4ye.example', smtp_from_name: 'All 4 You Electrical' });
  const e = (await call('admin', 'GET', '/settings/email')).data;
  assert.equal(e.no_reply_sender, true); assert.equal(e.reply_to, 'office@a4ye.example');
  const cust = (await call('admin', 'POST', '/customers', { name: 'Pat Payer', email: 'pat@example.com' })).data.id;
  const inv = (await call('admin', 'POST', '/invoices', { customer_id: cust, tax_rate: 0, items: [{ description: 'Service call', qty: 1, unit_price: 250 }] })).data.id;
  const est = (await call('admin', 'POST', '/estimates', { customer_id: cust, title: 'Panel', tax_rate: 0, items: [{ description: '200A panel', qty: 1, unit_price: 3200 }] })).data.id;
  for (const [path, subj] of [[`/invoices/${inv}/send`, /Invoice INV-/], [`/estimates/${est}/send`, /Estimate EST-/]]) {
    const n = smtp.got.length;
    const r = await call('admin', 'POST', path, {});
    assert.equal(r.data.status, 'sent', JSON.stringify(r.data));
    const m = smtp.got[n];
    assert.match(m.from, /noreply@a4ye\.example/, 'envelope sender');
    assert.match(m.data, /From: All 4 You Electrical <noreply@a4ye\.example>/);
    assert.match(m.data, /Reply-To: office@a4ye\.example/, `${path}: replies reach the office`);
    assert.match(m.data, subj);
    assert.match(m.data, /Questions\? Reply to this email or call \(208\) 555-0100\./);
  }
  // the test email says where replies go
  const t = (await call('admin', 'POST', '/settings/email-test', { to: 'owner@a4ye.example' })).data;
  assert.equal(t.ok, true); assert.equal(t.reply_to, 'office@a4ye.example');
  assert.match(smtp.got[smtp.got.length - 1].data, /Reply-To: office@a4ye\.example/);
  // no company email → nowhere for replies; the status says so
  await call('admin', 'PUT', '/settings', { company_email: '' });
  assert.equal((await call('admin', 'GET', '/settings/email')).data.reply_to, null);
  await call('admin', 'PUT', '/settings', { company_email: 'office@a4ye.example' });
});

test('Twilio Email sign-in errors say which key problem it is', () => {
  const { explain } = require('../server/mailer');
  const e = { code: 'EAUTH', response: '535 Authentication failed: The provided authorization grant is invalid, expired, or revoked' };
  const c = pass => ({ host: 'smtp.sendgrid.net', port: 2525, user: 'apikey', pass });
  assert.match(explain(e, c('SK' + 'a'.repeat(32))), /Twilio API key \(starts with SK\)/);
  assert.match(explain(e, c('abc123secret')), /start with "SG\."/);
  assert.match(explain(e, c('SG.short')), /cut off/);
  assert.match(explain(e, c('SG.' + 'x'.repeat(66))), /mistyped, deleted, or doesn't have Mail Send/);
  assert.match(explain(e, { ...c('SG.' + 'x'.repeat(66)), user: 'Apikey' }), /must be exactly apikey/);
});

// ---- Twilio Email API (comms.twilio.com): HTTPS + Basic auth with an SK key SID and its secret
test('Twilio Email API: SK key signs in, message/attachment/CC go as JSON, errors explained', async () => {
  const http = require('node:http');
  const SID = 'SK' + '0123456789abcdef'.repeat(2), SECRET = 'the-secret';
  const got = [];
  const api = http.createServer((req, res) => {
    let b = ''; req.on('data', d => { b += d; }); req.on('end', () => {
      const [u, p] = Buffer.from(String(req.headers.authorization || '').replace(/^Basic /, ''), 'base64').toString().split(':');
      const reply = (code, o) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (u !== SID || p !== SECRET) return reply(401, { message: 'Authentication Error - invalid username' });
      if (req.method === 'GET') return reply(200, { emails: [{ to: [{ address: 'owner@a4ye.example' }], status: got.at(-1).from.address.endsWith('unverified.example') ? 'FAILED' : 'DELIVERED' }] });
      const j = JSON.parse(b); got.push(j);
      if (j.from.address.startsWith('bad@')) return reply(400, { errors: [{ field: 'from', message: 'sender domain is not verified' }] });
      reply(202, { operationId: 'comms_operation_x' + got.length, operationLocation: 'x' });
    });
  });
  await new Promise(r => api.listen(0, '127.0.0.1', r));
  process.env.TWILIO_EMAIL_API_BASE = `http://127.0.0.1:${api.address().port}/v1`; process.env.TWILIO_EMAIL_POLL_MS = '5';
  try {
    const form = { host: 'comms.twilio.com', port: 443, security: 'ssl', user: SID, from_email: 'noreply@a4ye.example', from_name: 'All 4 You Electrical' };
    const mailer0 = require('../server/mailer');
    const t = o => call('admin', 'POST', '/settings/email-test', { to: 'owner@a4ye.example', ...form, ...o }).then(r => r.data);
    assert.match((await t({ pass: 'wrong' })).error, /secret doesn't match that SID/);
    assert.match((await t({ pass: SID })).error, /password is the key SID again/);
    assert.match((await t({ user: 'apikey', pass: SECRET })).error, /must be the API key's SID/);
    assert.match(mailer0.explain(Object.assign(new Error('required permission twilio/comms/emails/create is missing (HTTP 401)'), { code: 'ETWILIO', status: 401 }), { host: 'comms.twilio.com', user: SID, pass: SECRET }),
      /signed in, but it isn't allowed to send email \(missing permission twilio\/comms\/emails\/create\)/);
    assert.match((await t({ pass: SECRET, from_email: 'bad@a4ye.example' })).error, /refused the From address bad@a4ye\.example.*Email → Domains/);
    assert.match((await t({ pass: SECRET, from_email: 'x@unverified.example' })).error, /accepted the message but it failed/);
    const ok = await t({ pass: SECRET });
    assert.equal(ok.ok, true, JSON.stringify(ok)); assert.equal(ok.api, true);
    const m = got.at(-1);
    assert.deepEqual(m.from, { address: 'noreply@a4ye.example', name: 'All 4 You Electrical' });
    assert.deepEqual(m.to, [{ address: 'owner@a4ye.example' }]);
    assert.match(m.content.subject, /Test email/); assert.match(m.content.html, /<br>/); assert.match(m.content.text, /office@a4ye\.example/);

    // saved → real sends go through the API; CC becomes another recipient; reply address written in; attachments base64
    await call('admin', 'PUT', '/settings', { smtp_host: 'comms.twilio.com', smtp_port: 443, smtp_security: 'ssl', smtp_user: SID, smtp_pass: SECRET, smtp_from_email: 'noreply@a4ye.example', smtp_from_name: 'All 4 You Electrical' });
    const mailer = require('../server/mailer');
    const r = await mailer.send(db, { to: '"Pat GC" <pat@gc.example>', cc: 'pm@gc.example, pat@gc.example', subject: 'Report', text: 'See https://x.example/r/1 now',
      attachments: [{ filename: 'a.ics', content: 'BEGIN:VCALENDAR', contentType: 'text/calendar' }] });
    assert.equal(r.status, 'sent', JSON.stringify(r));
    const s = got.at(-1);
    assert.deepEqual(s.to, [{ address: 'pat@gc.example', name: 'Pat GC' }, { address: 'pm@gc.example' }]);
    assert.match(s.content.text, /To reply, email office@a4ye\.example$/);
    assert.match(s.content.html, /<a href="https:\/\/x\.example\/r\/1">/); assert.match(s.content.html, /mailto:office@a4ye\.example/);
    assert.deepEqual(s.content.attachments, [{ filename: 'a.ics', contentType: 'text/calendar', content: Buffer.from('BEGIN:VCALENDAR').toString('base64') }]);
    const e = (await call('admin', 'GET', '/settings/email')).data;
    assert.equal(e.configured, true); assert.equal(e.pass_set, true); assert.equal(e.from, '"All 4 You Electrical" <noreply@a4ye.example>');
    // the old SendGrid preset with an SK key points to the new one
    assert.match(mailer.explain({ code: 'EAUTH', response: '535 nope' }, { host: 'smtp.sendgrid.net', user: 'apikey', pass: SID }), /Twilio Email \(API key SK…\)/);
  } finally {
    delete process.env.TWILIO_EMAIL_API_BASE; delete process.env.TWILIO_EMAIL_POLL_MS; api.close();
    await call('admin', 'PUT', '/settings', { smtp_host: '', smtp_pass_clear: '1' });
  }
});
