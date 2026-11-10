'use strict';
// Appointment confirmation emails: tell the customer when we're coming, for a job visit or an estimate walkthrough.
//  - Times are written in the company's time zone (Settings, default America/Boise), never the server's.
//  - Dispatch notes are internal (gate codes, "call first", who the customer is) and never go in the email.
//  - A calendar file (.ics) rides along; the same UID with a higher SEQUENCE moves the event instead of adding a second.
//  - Moving a confirmed visit marks it "time changed since the customer was told"; sending again says so in the subject.
const D = require('./db');
const mailer = require('./mailer');
const { get, run } = D;

const EMAIL = /^[^@\s,;<>]+@[^@\s,;<>]+\.[^@\s,;<>]+$/;
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const tzOf = s => { const tz = s.timezone || 'America/Boise'; try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz; } catch { return 'America/Boise'; } };

// "Wednesday, November 11" and "1:00 – 2:30 PM" in the company time zone (multi-day visits show both dates)
function when(a, tz) {
  const d = x => new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long', month: 'long', day: 'numeric' }).format(new Date(x));
  const t = x => new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(new Date(x));
  const ds = d(a.start), de = d(a.end), ts = t(a.start), te = t(a.end);
  const tzName = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' }).formatToParts(new Date(a.start)).find(p => p.type === 'timeZoneName').value;
  if (ds !== de) return { date: `${ds} – ${de}`, time: `${ts} – ${te} each day`, short: `${ds.replace(/^\w+, /, '')}–${de.replace(/^\w+, /, '')}`, tz: tzName };
  const same = ts.slice(-2) === te.slice(-2);
  return { date: ds, time: `${same ? ts.slice(0, -3) : ts} – ${te}`, short: `${ds.split(', ')[0].slice(0, 3)}, ${ds.split(', ')[1]}, ${same ? ts.slice(0, -3) : ts}–${te}`, tz: tzName };
}

// RFC 5545 calendar file
const icsText = v => String(v ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const icsTime = x => new Date(x).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const fold = line => { const out = []; let s = line; while (Buffer.byteLength(s) > 75) { let n = 75; while (Buffer.byteLength(s.slice(0, n)) > 75) n--; out.push(s.slice(0, n)); s = ' ' + s.slice(n); } out.push(s); return out.join('\r\n'); };
function buildIcs({ uid, sequence = 0, start, end, summary, location, description, organizerName, organizerEmail, cancelled = false }) {
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//A4YE Field Ops//Appointments//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'BEGIN:VEVENT',
    `UID:${uid}`, `SEQUENCE:${sequence}`, `DTSTAMP:${icsTime(Date.now())}`, `DTSTART:${icsTime(start)}`, `DTEND:${icsTime(end)}`,
    `SUMMARY:${icsText(summary)}`, location ? `LOCATION:${icsText(location)}` : null, description ? `DESCRIPTION:${icsText(description)}` : null,
    organizerEmail ? `ORGANIZER;CN=${icsText(organizerName || organizerEmail)}:mailto:${organizerEmail}` : null,
    `STATUS:${cancelled ? 'CANCELLED' : 'CONFIRMED'}`, 'TRANSP:OPAQUE', 'END:VEVENT', 'END:VCALENDAR'].filter(Boolean).map(fold).join('\r\n') + '\r\n';
}

module.exports = function apptConfirm(app, db, X) {
  const { wrap, bad, mustGet, H } = X;

  // what the customer is told, built from the visit (H.appointments gives job and estimate visits the same shape)
  function compose(a, { message, cancelled = false } = {}) {
    const s = D.settings(db), tz = tzOf(s), w = when(a, tz);
    const cust = get(db, 'SELECT * FROM customers WHERE id = ?', a.customer_id);
    const company = s.company_name || 'All 4 You Electrical', phone = s.company_phone || '', replyTo = s.company_email || '';
    const first = String(cust.name || '').trim().split(/\s+/)[0] || 'there';
    const isEst = a.kind === 'estimate';
    const what = isEst ? String(a.job_title || '').replace(/^Estimate visit: /, '') : a.job_title;
    const where = [a.address, [a.city, a.state].filter(Boolean).join(', '), a.zip].filter(Boolean).join(' ').replace(/ ,/g, ',');
    const crew = String(a.tech_names || '').split(', ').filter(Boolean).map(n => n.split(/\s+/)[0]);
    const who = crew.length ? `${crew.slice(0, -1).join(', ')}${crew.length > 1 ? ' and ' : ''}${crew[crew.length - 1]}` : '';
    const changed = !cancelled && !!a.confirmed_at && (a.confirmed_start !== a.start || a.confirmed_end !== a.end);
    const purpose = isEst ? `to look at the work and put together a price${what ? ` for: ${what}` : ''}` : (what ? `for: ${what}` : 'for your service visit');
    const subject = cancelled ? `Cancelled: your appointment with ${company} — ${w.short}`
      : `${changed ? 'Updated time: ' : ''}Your ${isEst ? 'estimate appointment' : 'appointment'} with ${company} — ${w.short}`;
    const lead = cancelled ? `Your appointment on ${w.date} at ${w.time} has been cancelled.`
      : changed ? `We've changed the time of your ${isEst ? 'estimate appointment' : 'appointment'}. Here is the new time:`
        : `This confirms your ${isEst ? 'estimate appointment' : 'appointment'} with ${company}.`;
    const rows = cancelled ? [] : [['When', `${w.date}, ${w.time} (${w.tz})`], ['Where', where || 'On file'], [isEst ? 'Purpose' : 'Work', purpose.replace(/^for: /, '').replace(/^to /, '')],
      ...(who ? [['Who\'s coming', who]] : [])];
    const help = cancelled ? `To book a new time, call ${phone || 'us'}${replyTo ? ' or reply to this email' : ''}.`
      : `Need to change it? Call ${phone || 'us'}${replyTo ? ' or reply to this email' : ''}. ${isEst ? 'Please have someone 18 or older there to walk us through what you need.' : 'Please make sure we can get to the panel and the work area.'}`;
    const extra = String(message || '').trim();
    const text = [`Hi ${first},`, '', lead, ...(rows.length ? ['', ...rows.map(([k, v]) => `${k}: ${v}`)] : []), ...(extra ? ['', extra] : []), '', help, '', company, phone].filter(x => x != null).join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
    const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#16191f;max-width:560px">
      <p>Hi ${esc(first)},</p><p>${esc(lead)}</p>
      ${rows.length ? `<table style="border-collapse:collapse;margin:12px 0;font-size:15px">${rows.map(([k, v]) => `<tr><td style="padding:5px 18px 5px 0;color:#4b5563;vertical-align:top">${esc(k)}</td><td style="padding:5px 0"><b>${esc(v)}</b></td></tr>`).join('')}</table>` : ''}
      ${extra ? `<p>${esc(extra).replace(/\n/g, '<br>')}</p>` : ''}
      <p style="color:#4b5563">${esc(help)}</p>
      ${cancelled ? '' : '<p style="color:#6b7280;font-size:13px">A calendar invite is attached so you can add it to your phone.</p>'}
      <p>${esc(company)}${phone ? `<br>${esc(phone)}` : ''}</p></div>`;
    const ics = buildIcs({ uid: `appt-${a.id}@a4ye-field-ops`, sequence: (a.confirm_count || 0) + (cancelled ? 1 : 0), start: a.start, end: a.end,
      summary: `${company}: ${isEst ? 'estimate appointment' : (what || 'service visit')}`, location: where, description: `${lead}\n${help}`,
      organizerName: company, organizerEmail: replyTo || null, cancelled });
    return { to: cust.email || '', name: cust.name, subject, text, html, ics, changed, replyTo: replyTo || null };
  }
  const visit = id => { const a = H.appointments('a.id = ?', [Number(id)])[0]; if (!a) throw bad('Visit not found', 404); return a; };

  // preview (also says whether the time changed since the last confirmation)
  app.get('/api/appointments/:id/confirmation', wrap((req, res) => {
    if (req.user.role === 'tech') throw bad('Office only', 403);
    const a = visit(req.params.id), c = compose(a);
    res.json({ to: c.to, customer: c.name, subject: c.subject, text: c.text, changed: c.changed, confirmed_at: a.confirmed_at, confirmed_to: a.confirmed_to, smtp: !!process.env.SMTP_HOST });
  }));
  app.post('/api/appointments/:id/confirm', wrap(async (req, res) => {
    if (req.user.role === 'tech') throw bad('Office only', 403);
    const a = visit(req.params.id), b = req.body || {};
    if (a.status === 'cancelled' && !b.cancelled) throw bad('That visit is cancelled');
    if (a.status === 'done') throw bad('That visit already happened');
    const c = compose(a, { message: b.message, cancelled: !!b.cancelled });
    const to = String(b.to ?? c.to).split(/[,;\s]+/).filter(Boolean);
    if (!to.length) throw bad('The customer has no email address — add one on the customer, or type one in');
    for (const e of to) if (!EMAIL.test(e)) throw bad(`"${e}" is not an email address`);
    if (to.length > 5) throw bad('5 addresses at most');
    const r = await mailer.send(db, { to: to.join(', '), replyTo: c.replyTo || req.user.email || undefined, subject: c.subject, text: c.text, html: c.html, related: `appointment:${a.id}`,
      attachments: [{ filename: b.cancelled ? 'cancelled.ics' : 'appointment.ics', content: c.ics, contentType: 'text/calendar; charset=utf-8; method=PUBLISH' }] });
    if (r.status !== 'failed') {
      if (b.cancelled) run(db, 'UPDATE appointments SET confirmed_at = NULL, confirmed_start = NULL, confirmed_end = NULL, confirm_count = confirm_count + 1 WHERE id = ?', a.id);
      else run(db, "UPDATE appointments SET confirmed_at = datetime('now'), confirmed_to = ?, confirmed_start = ?, confirmed_end = ?, confirm_count = confirm_count + 1 WHERE id = ?", to.join(', '), a.start, a.end, a.id);
    }
    res.json({ ...r, subject: c.subject, text: c.text, changed: c.changed });
  }));
};
module.exports.buildIcs = buildIcs;
module.exports.when = when;
