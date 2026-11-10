'use strict';
// Outbound email: over SMTP, or — when the server is comms.twilio.com — through the Twilio Email API (HTTPS, signed in
// with a Twilio API key: username = the key's SID, which starts with SK; password = the key's secret).
// The mail account comes from Settings → Email (set up in the app, password stored as a secret), or — if the server's
// environment has SMTP_HOST — from SMTP_HOST / SMTP_PORT / SMTP_SECURE / SMTP_USER / SMTP_PASS / SMTP_FROM, which win.
// With neither, a send is recorded in the outbox as "not_configured" and the caller hands the text to the office instead.
const { run, settings } = require('./db');

const EMAIL = /^[^@\s,;<>]+@[^@\s,;<>]+\.[^@\s,;<>]+$/;
const addrOf = from => ((String(from || '').match(/<([^>]+)>/) || [])[1] || String(from || '')).trim().toLowerCase();
const TWILIO_HOST = 'comms.twilio.com';
const isTwilioApi = c => String((c && c.host) || '').trim().toLowerCase() === TWILIO_HOST;
const isTwilioKeySid = k => /^SK[0-9a-f]{32}$/i.test(String(k || ''));

function config(db) {
  const e = process.env;
  if (e.SMTP_HOST) {
    const port = Number(e.SMTP_PORT || 587);
    const from = e.SMTP_FROM || (String(e.SMTP_USER || '').includes('@') ? e.SMTP_USER : '');
    return { source: 'server', host: e.SMTP_HOST, port, security: e.SMTP_SECURE === 'true' || port === 465 ? 'ssl' : 'starttls', user: e.SMTP_USER || '', pass: e.SMTP_PASS || '',
      from, fromEmail: addrOf(from), fromName: ((String(from).match(/^\s*"?([^"<]*?)"?\s*</) || [])[1] || '').trim() };
  }
  const s = settings(db);
  if (!s.smtp_host) return null;
  return fromSettings(s, {});
}
// settings (+ unsaved overrides from the Settings form, for "Send test email") → config
function fromSettings(s, o) {
  const v = k => (o[k] !== undefined && o[k] !== null && o[k] !== '' ? o[k] : s[`smtp_${k}`]);
  const host = String(v('host') || '').trim(), port = Number(v('port')) || 587;
  // the username doubles as the From address only when it is one (a Postmark token or an SK key SID is not)
  const fromEmail = String(v('from_email') || (String(v('user') || '').includes('@') ? v('user') : '') || '').trim(), fromName = String(v('from_name') || s.company_name || '').replace(/["<>\r\n]/g, '').trim();
  return { source: 'settings', host, port, security: ['ssl', 'starttls', 'none'].includes(v('security')) ? v('security') : port === 465 ? 'ssl' : 'starttls',
    user: String(v('user') || '').trim(), pass: (o.pass ? String(o.pass) : (s.smtp_pass || '')).replace(/\s+/g, ''), from: fromEmail ? (fromName ? `"${fromName}" <${fromEmail}>` : fromEmail) : '', fromEmail, fromName };
}
function transportFor(c) {
  if (isTwilioApi(c)) return twilioTransport(c);
  const nodemailer = require('nodemailer');
  return nodemailer.createTransport({ host: c.host, port: c.port, secure: c.security === 'ssl', requireTLS: c.security === 'starttls', ignoreTLS: c.security === 'none',
    auth: c.user ? { user: c.user, pass: c.pass } : undefined, connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 30000 });
}
// ---- Twilio Email API (https://www.twilio.com/docs/email/api). Same sendMail/verify/close shape as a nodemailer transport.
// The API has no Reply-To or CC: CC addresses get their own copy, and the reply address is written into the message.
const apiBase = () => (process.env.TWILIO_EMAIL_API_BASE || `https://${TWILIO_HOST}/v1`).replace(/\/+$/, '');
const escHtml = t => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function parseAddrs(list) {
  return String(list || '').split(/[,;]/).map(x => x.trim()).filter(Boolean).map(x => {
    const m = x.match(/^"?([^"<]*?)"?\s*<([^>]+)>$/);
    return m ? { address: m[2].trim(), name: m[1].trim() } : { address: x };
  }).filter(a => EMAIL.test(a.address));
}
function textToHtml(t) {
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5">${escHtml(t)
    .replace(/https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"]/g, u => `<a href="${u}">${u}</a>`).replace(/\r?\n/g, '<br>')}</div>`;
}
function apiError(status, txt) {
  let j = null; try { j = JSON.parse(txt); } catch { /* not JSON */ }
  const list = j && (j.errors || j.issues || j.details);
  const msg = (j && (j.message || j.detail || j.error_message || (typeof j.error === 'string' ? j.error : '')))
    || (Array.isArray(list) ? list.map(x => (typeof x === 'string' ? x : [x.field || x.path, x.message || x.detail].filter(Boolean).join(': '))).join('; ') : '')
    || String(txt || '').slice(0, 300) || `HTTP ${status}`;
  const e = new Error(`${msg}${status ? ` (HTTP ${status})` : ''}`); e.code = 'ETWILIO'; e.status = status; return e;
}
function twilioTransport(c) {
  const auth = 'Basic ' + Buffer.from(`${c.user}:${c.pass}`).toString('base64');
  async function call(method, path, body) {
    let r;
    try {
      r = await fetch(apiBase() + path, { method, headers: { Authorization: auth, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) });
    } catch (err) { const e = new Error(`Couldn't reach ${TWILIO_HOST}: ${err.cause ? err.cause.code || err.cause.message : err.message}`); e.code = 'ECONNECTION'; throw e; }
    return { status: r.status, txt: await r.text() };
  }
  return {
    async sendMail(m) {
      const seen = new Set(), to = [...parseAddrs(m.to), ...parseAddrs(m.cc)].filter(a => !seen.has(a.address.toLowerCase()) && seen.add(a.address.toLowerCase()));
      if (!to.length) throw apiError(0, 'No valid recipient address');
      let text = m.text || '', html = m.html || textToHtml(text);
      const reply = m.replyTo && addrOf(m.replyTo);
      if (reply && reply !== String(c.fromEmail || '').toLowerCase() && !`${text} ${m.html || ''}`.toLowerCase().includes(reply)) {
        text += `${text ? '\n\n' : ''}To reply, email ${reply}`;
        const p = `<p style="font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#555">To reply, email <a href="mailto:${escHtml(reply)}">${escHtml(reply)}</a></p>`;
        html = /<\/body>/i.test(html) ? html.replace(/<\/body>/i, `${p}</body>`) : html + p;
      }
      const attachments = (m.attachments || []).map(a => ({ filename: a.filename || 'attachment', contentType: a.contentType || 'application/octet-stream',
        content: Buffer.isBuffer(a.content) ? a.content.toString('base64') : Buffer.from(String(a.content || ''), 'utf8').toString('base64') }));
      const body = { from: { address: c.fromEmail, name: c.fromName || c.fromEmail }, to,
        content: { subject: m.subject || '', html, ...(text ? { text } : {}), ...(attachments.length ? { attachments } : {}) } };
      const r = await call('POST', '/Emails', body);
      if (r.status < 200 || r.status > 299) throw apiError(r.status, r.txt);
      let j = {}; try { j = JSON.parse(r.txt); } catch { /* empty body */ }
      return { messageId: j.operationId || null, operationId: j.operationId || null };
    },
    // per-recipient status of one send, or null when the key can't read it
    async status(operationId) {
      const r = await call('GET', `/Emails?operationId=${encodeURIComponent(operationId)}&pageSize=20`).catch(() => null);
      if (!r || r.status !== 200) return null;
      try { const j = JSON.parse(r.txt); return (j.emails || j.items || j.data || []).map(x => ({ to: ((x.to || [])[0] || {}).address, status: x.status, reason: x.statusReason || x.reason || x.error || null })); } catch { return null; }
    },
    async verify() {
      if (!c.user || !c.pass) throw apiError(401, 'Enter the API key SID and secret');
      return true;
    },
    close() {},
  };
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
  if (isTwilioApi(c)) {
    const s = e && e.status, user = String(c.user || '');
    if (code === 'ECONNECTION') return `${msg}. Check the server's internet connection (this uses normal HTTPS, port 443).`;
    // Twilio answers 401 both for a wrong secret and for a right key that lacks a permission — the text tells them apart
    const perm = (msg.match(/permission\s+([\w\/.:-]+)\s+is\s+missing/i) || [])[1];
    if (perm || s === 403) return `The API key signed in, but it isn't allowed to send email${perm ? ` (missing permission ${perm})` : ''}. In the Twilio Console → API keys, edit this key and tick Emails → Create${perm ? ` (${perm})` : ''}, or create a Standard key. Then enter the new key's SID and secret here. (${msg})`;
    if (s === 401) {
      if (!isTwilioKeySid(user)) return `Twilio rejected the sign-in. The username must be the API key's SID — it starts with SK and is 34 characters (it is "${user.slice(0, 6)}${user.length > 6 ? '…' : ''}"). (${msg})`;
      if (isTwilioKeySid(c.pass)) return `The password is the key SID again. It must be the key's secret — shown once, next to the SID, when the key was created. If you didn't copy it, create a new key. (${msg})`;
      return `Twilio rejected the API key: the secret doesn't match that SID, or the key was deleted. The secret is shown only once when the key is made — if you don't have it, create a new key. (Not the account Auth Token.) (${msg})`;
    }
    if (s === 400 && /from|sender|domain|identity|verif/i.test(msg))
      return `Twilio refused the From address ${c.fromEmail || ''}. Authenticate ${String(c.fromEmail || '').split('@')[1] || 'your domain'} in the Twilio Console → Email → Domains (it gives DNS records to add), then try again. (${msg})`;
    if (s === 429 || s >= 500) return `Twilio Email is busy or having trouble. Wait a minute and try again. (${msg})`;
    if (code === 'ETWILIO') return `Twilio Email refused the message: ${msg}`;
  }
  if (code === 'EAUTH' || /\b535\b|authentication|username and password|invalid login/i.test(msg)) {
    if (host.includes('gmail') || host.includes('google')) return `Google rejected the sign-in. Use an App Password (Google Account → Security → 2-Step Verification → App passwords), not the normal password. (${msg})`;
    if (host.includes('office365') || host.includes('outlook')) return `Microsoft rejected the sign-in. Microsoft 365 has been turning off password sign-in for SMTP — use a sending service (Postmark, SendGrid, Brevo, Amazon SES) instead, or have your Microsoft admin set up a relay. (${msg})`;
    if (host.includes('sendgrid')) {
      const key = String(c.pass || ''), user = String(c.user || '');
      if (isTwilioKeySid(key) || isTwilioKeySid(user)) return `That is a Twilio API key (starts with SK), which doesn't work with SendGrid's SMTP server. Switch the Email provider to "Twilio Email (API key SK…)": username = the SK key SID, password = the key's secret. (${msg})`;
      if (user !== 'apikey') return `The username must be exactly apikey (lowercase, no spaces) — it is "${user}". (${msg})`;
      if (!key.startsWith('SG.')) return `That doesn't look like an email API key — those start with "SG." and are about 69 characters. The key's secret is shown only once when it's created; if you didn't copy it then, create a new key. (${msg})`;
      if (key.length < 60) return `The key looks cut off (${key.length} characters; email API keys are about 69). Copy the whole key, or create a new one. (${msg})`;
      return `SendGrid rejected that API key: it was mistyped, deleted, or doesn't have Mail Send access. Create a new SG. key with Mail Send access and paste it again. (${msg})`;
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
    const info = await t.sendMail({ from: c.from, to, replyTo: reply, subject: `Test email from ${s.company_name || 'A4YE Field Ops'}`,
      text: `This is a test from A4YE Field Ops.\n\nIf you're reading it, estimates, invoices, reports and appointment confirmations will send from ${c.from} through ${c.host}:${c.port}.\n${reply ? (isTwilioApi(c) ? `Customer replies go to ${reply}. (The Twilio Email API can't set a Reply-To, so each message says "To reply, email ${reply}".)\n` : `Customer replies go to ${reply} — press Reply on this email to check.\n`) : ''}` });
    if (isTwilioApi(c) && info && info.operationId) {
      // the API accepts first and delivers after; look once or twice so a refusal shows here rather than as silence
      const wait = Number(process.env.TWILIO_EMAIL_POLL_MS || 2500);
      for (let i = 0; i < 3; i++) {
        await new Promise(r => setTimeout(r, wait));
        const st = await t.status(info.operationId);
        if (!st || !st.length) continue;
        const bad = st.find(x => /FAILED|UNDELIVERED|CANCELED/i.test(x.status || ''));
        if (bad) return { ok: false, error: `Twilio accepted the message but it ${String(bad.status).toLowerCase()}${bad.reason ? `: ${typeof bad.reason === 'string' ? bad.reason : JSON.stringify(bad.reason)}` : ''}. Usually the From domain isn't authenticated yet (Twilio Console → Email → Domains).` };
        if (st.every(x => /SENT|DELIVERED|OPENED/i.test(x.status || ''))) break;
      }
    }
    return { ok: true, from: c.from, host: c.host, port: c.port, reply_to: reply || null, api: isTwilioApi(c) || undefined };
  } catch (e) { return { ok: false, error: explain(e, c) }; } finally { t.close(); }
}

module.exports = { send, configured, config, test, explain, defaultReplyTo, isNoReply, isTwilioApi };
