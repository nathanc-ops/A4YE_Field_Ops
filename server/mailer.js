'use strict';
// Outbound email over SMTP.
// The mail account comes from Settings → Email (set up in the app, password stored as a secret), or — if the server's
// environment has SMTP_HOST — from SMTP_HOST / SMTP_PORT / SMTP_SECURE / SMTP_USER / SMTP_PASS / SMTP_FROM, which win.
// With neither, a send is recorded in the outbox as "not_configured" and the caller hands the text to the office instead.
const { run, settings } = require('./db');

function config(db) {
  const e = process.env;
  if (e.SMTP_HOST) {
    const port = Number(e.SMTP_PORT || 587);
    return { source: 'server', host: e.SMTP_HOST, port, security: e.SMTP_SECURE === 'true' || port === 465 ? 'ssl' : 'starttls', user: e.SMTP_USER || '', pass: e.SMTP_PASS || '',
      from: e.SMTP_FROM || e.SMTP_USER || '' };
  }
  const s = settings(db);
  if (!s.smtp_host) return null;
  return fromSettings(s, {});
}
// settings (+ unsaved overrides from the Settings form, for "Send test email") → config
function fromSettings(s, o) {
  const v = k => (o[k] !== undefined && o[k] !== null && o[k] !== '' ? o[k] : s[`smtp_${k}`]);
  const host = String(v('host') || '').trim(), port = Number(v('port')) || 587;
  const fromEmail = String(v('from_email') || v('user') || '').trim(), fromName = String(v('from_name') || s.company_name || '').replace(/["<>\r\n]/g, '').trim();
  return { source: 'settings', host, port, security: ['ssl', 'starttls', 'none'].includes(v('security')) ? v('security') : port === 465 ? 'ssl' : 'starttls',
    user: String(v('user') || '').trim(), pass: (o.pass ? String(o.pass) : (s.smtp_pass || '')).replace(/\s+/g, ''), from: fromEmail ? (fromName ? `"${fromName}" <${fromEmail}>` : fromEmail) : '' };
}
function transportFor(c) {
  const nodemailer = require('nodemailer');
  return nodemailer.createTransport({ host: c.host, port: c.port, secure: c.security === 'ssl', requireTLS: c.security === 'starttls', ignoreTLS: c.security === 'none',
    auth: c.user ? { user: c.user, pass: c.pass } : undefined, connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 30000 });
}
let cached = { key: null, t: null };
function getTransport(db) {
  const c = config(db); if (!c) return null;
  const key = JSON.stringify(c);
  if (cached.key !== key) cached = { key, t: transportFor(c) };
  return { t: cached.t, c };
}
const configured = db => !!config(db);

// Where a customer's reply goes. Sending from a no-reply address is fine as long as this is set: the company email
// (Settings → Company), unless the send names someone (a PM on a bi-weekly report).
const EMAIL = /^[^@\s,;<>]+@[^@\s,;<>]+\.[^@\s,;<>]+$/;
const addrOf = from => ((String(from || '').match(/<([^>]+)>/) || [])[1] || String(from || '')).trim().toLowerCase();
function defaultReplyTo(db, from) {
  const ce = String(settings(db).company_email || '').trim();
  return EMAIL.test(ce) && ce.toLowerCase() !== addrOf(from) ? ce : undefined;
}
const isNoReply = from => /^(no-?reply|do-?not-?reply|donotreply)@/i.test(addrOf(from));

async function send(db, { to, cc, replyTo, subject, text, html, related, attachments }) {
  const tc = getTransport(db);
  const info = run(db, 'INSERT INTO outbox (to_email, subject, body, status, related) VALUES (?,?,?,?,?)',
    [to, cc].filter(Boolean).join(', '), subject, text, tc ? 'queued' : 'not_configured', related || null);
  const id = Number(info.lastInsertRowid);
  if (!tc) return { status: 'not_configured', id };
  try {
    await tc.t.sendMail({ from: tc.c.from, to, cc: cc || undefined, replyTo: replyTo || defaultReplyTo(db, tc.c.from), subject, text, html, attachments: attachments || undefined });
    run(db, "UPDATE outbox SET status = 'sent' WHERE id = ?", id);
    return { status: 'sent', id };
  } catch (e) {
    const why = explain(e, tc.c);
    run(db, "UPDATE outbox SET status = 'failed', error = ? WHERE id = ?", why, id);
    return { status: 'failed', id, error: why };
  }
}

// SMTP errors in plain words, with what usually fixes them
function explain(e, c) {
  const msg = String(e && (e.response || e.message) || e), code = e && (e.code || '');
  const host = String(c.host || '').toLowerCase();
  if (code === 'EAUTH' || /\b535\b|authentication|username and password|invalid login/i.test(msg)) {
    if (host.includes('gmail') || host.includes('google')) return `Google rejected the sign-in. Use an App Password (Google Account → Security → 2-Step Verification → App passwords), not the normal password. (${msg})`;
    if (host.includes('office365') || host.includes('outlook')) return `Microsoft rejected the sign-in. Microsoft 365 has been turning off password sign-in for SMTP — use a sending service (Postmark, SendGrid, Brevo, Amazon SES) instead, or have your Microsoft admin set up a relay. (${msg})`;
    if (host.includes('sendgrid')) {
      const key = String(c.pass || ''), user = String(c.user || '');
      if (user !== 'apikey') return `The username must be exactly apikey (lowercase, no spaces) — it is "${user}". (${msg})`;
      if (/^SK[0-9a-f]{32}$/i.test(key)) return `That is a Twilio account API key (starts with SK). Email needs an email API key, which starts with "SG." — create one in the Twilio console's Email section → API Keys, with Mail Send access. (${msg})`;
      if (!key.startsWith('SG.')) return `That doesn't look like an email API key — those start with "SG." and are about 69 characters. The key's secret is shown only once when it's created; if you didn't copy it then, create a new key. (${msg})`;
      if (key.length < 60) return `The key looks cut off (${key.length} characters; email API keys are about 69). Copy the whole key, or create a new one. (${msg})`;
      return `Twilio Email rejected that API key: it was mistyped, deleted, or doesn't have Mail Send access. Create a new email API key with Mail Send access and paste it again. (${msg})`;
    }
    return `The mail server rejected the username or password. (${msg})`;
  }
  if (code === 'ENOTFOUND' || /getaddrinfo/i.test(msg)) return `Couldn't find the mail server "${c.host}". Check the server name.`;
  if (['ETIMEDOUT', 'ECONNECTION', 'ESOCKET', 'ECONNREFUSED'].includes(code) || /timed? ?out|ECONNREFUSED|Greeting never received/i.test(msg))
    return `Couldn't connect to ${c.host} on port ${c.port}. Many hosting companies, DigitalOcean included, block outgoing mail ports 25, 465 and 587 — try port 2525 (Postmark, SendGrid and Brevo accept it), or ask the host to unblock mail. (${msg})`;
  if (/wrong version number|ssl3_get_record|self[- ]signed|certificate|STARTTLS/i.test(msg))
    return `The secure-connection setting doesn't match the port: port 465 uses SSL, ports 587 and 2525 use STARTTLS. (${msg})`;
  if (/\b55[0-4]\b|sender|not (permitted|allowed)|domain.*(not verified|unverified)|from address/i.test(msg))
    return `The mail service refused the From address. Verify that address (or your domain) with the provider, or send from the account's own address. (${msg})`;
  return msg;
}

// Settings → Email → Send test email: connect, sign in and send one message, with the form's unsaved values
async function test(db, to, overrides = {}) {
  const c = process.env.SMTP_HOST ? config(db) : fromSettings(settings(db), overrides);
  if (!c || !c.host) return { ok: false, error: 'Enter the mail server first' };
  if (!c.from) return { ok: false, error: 'Enter the From address (or the username, if it is an email address)' };
  const t = transportFor(c);
  try {
    await t.verify();
    const s = settings(db);
    const reply = defaultReplyTo(db, c.from);
    await t.sendMail({ from: c.from, to, replyTo: reply, subject: `Test email from ${s.company_name || 'A4YE Field Ops'}`,
      text: `This is a test from A4YE Field Ops.\n\nIf you're reading it, estimates, invoices, reports and appointment confirmations will send from ${c.from} through ${c.host}:${c.port}.\n${reply ? `Customer replies go to ${reply} — press Reply on this email to check.\n` : ''}` });
    return { ok: true, from: c.from, host: c.host, port: c.port, reply_to: reply || null };
  } catch (e) { return { ok: false, error: explain(e, c) }; } finally { t.close(); }
}

module.exports = { send, configured, config, test, explain, defaultReplyTo, isNoReply };
