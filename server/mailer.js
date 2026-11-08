'use strict';
// Outbound email. Uses SMTP when SMTP_HOST is set; otherwise records the message
// in the outbox with status "not_configured" so the office can copy the link manually.
const { run } = require('./db');

let transport = null;
function getTransport() {
  if (transport !== null) return transport;
  if (!process.env.SMTP_HOST) { transport = false; return transport; }
  const nodemailer = require('nodemailer');
  transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  });
  return transport;
}

async function send(db, { to, subject, text, html, related }) {
  const t = getTransport();
  const info = run(db, 'INSERT INTO outbox (to_email, subject, body, status, related) VALUES (?,?,?,?,?)',
    to, subject, text, t ? 'queued' : 'not_configured', related || null);
  const id = Number(info.lastInsertRowid);
  if (!t) return { status: 'not_configured', id };
  try {
    await t.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to, subject, text, html });
    run(db, "UPDATE outbox SET status = 'sent' WHERE id = ?", id);
    return { status: 'sent', id };
  } catch (e) {
    run(db, "UPDATE outbox SET status = 'failed', error = ? WHERE id = ?", String(e.message), id);
    return { status: 'failed', id, error: e.message };
  }
}

module.exports = { send };
