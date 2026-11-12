'use strict';
// Customer email wording, editable in Settings → Email templates (admins), and once more in the Send window before each send.
//  - A template is a subject and a plain-text body with {placeholders}. The HTML version is drawn from the text, so there is
//    one thing to edit: blank lines make paragraphs, "Label: value" lines become a neat two-column list, a line whose value
//    is a web link becomes a button, and any other link is clickable.
//  - A line holding a placeholder that has nothing to fill it (no phone on file, no crew assigned, no extra note) is left
//    out, so templates don't show "Who's coming: " with nothing after it.
//  - A placeholder at the start of a sentence gets a capital letter ("{call_us}." → "Call (208) 555-0100 or reply…").
//  - Saved templates live in settings as email_tpl_<type>_subject / _body; blank or back to default = the built-in wording.
const D = require('./db');

const COMMON = [['customer_name', 'Customer name'], ['customer_first', 'Customer first name (or "there")'], ['company_name', 'Your company name'],
  ['company_phone', 'Company phone'], ['company_email', 'Company email'], ['message', 'The optional note typed in the Send window']];
const APPT = [['visit_date', 'e.g. Thursday, November 12'], ['visit_time', 'e.g. 1:00 – 2:30 PM'], ['visit_short', 'e.g. Thu, November 12, 1:00–2:30 PM (for subjects)'],
  ['timezone', 'e.g. MST'], ['address', 'Service address'], ['crew', 'First names of the techs coming'], ['call_us', '"call (phone) or reply to this email"']];

const TEMPLATES = {
  estimate: {
    label: 'Estimate', when: 'Send on an estimate or change order',
    subject: 'Estimate {estimate_number} from {company_name}',
    body: 'Hi {customer_name},\n\nThank you for the opportunity. Your estimate is ready to review.\n\n{message}\n\nEstimate {estimate_number}: {estimate_total}\nView and approve online: {link}\n\n{questions}\n\n{company_name}\n{company_phone}',
    vars: [...COMMON, ['estimate_number', 'e.g. EST-1042'], ['estimate_title', 'What the estimate is for'], ['estimate_total', 'e.g. $3,200.00'],
      ['valid_until', 'Date the price is good until'], ['link', 'The page where the customer views, signs and approves'], ['questions', '"Questions? Reply to this email or call (phone)."']],
  },
  invoice: {
    label: 'Invoice', when: 'Send on an invoice',
    subject: 'Invoice {invoice_number} from {company_name}',
    body: 'Hi {customer_name},\n\nThank you for your business. Your invoice is ready to view online.\n\n{message}\n\nInvoice {invoice_number}\nAmount due: {amount_due}\nDue: {due_date}\nView online: {link}\n\n{questions}\n\n{company_name}\n{company_phone}',
    vars: [...COMMON, ['invoice_number', 'e.g. INV-2210'], ['invoice_total', 'Invoice total'], ['amount_due', 'Balance still owed'], ['due_date', 'Due date, or "on receipt"'],
      ['job_title', 'The job it bills for'], ['link', 'The page where the customer views and pays'], ['questions', '"Questions? Reply to this email or call (phone)."']],
  },
  appointment: {
    label: 'Job visit confirmation', when: 'Email the customer from a scheduled job visit',
    subject: 'Your appointment with {company_name} — {visit_short}',
    body: 'Hi {customer_first},\n\n{intro}\n\nWhen: {visit_date}, {visit_time} ({timezone})\nWhere: {address}\nWork: {work}\nWho\'s coming: {crew}\n\n{message}\n\nNeed to change it? {call_us}. Please make sure we can get to the panel and the work area.\n\n{company_name}\n{company_phone}',
    vars: [...COMMON, ['intro', '"This confirms your appointment…", or "We\'ve changed the time…" when it moved'], ...APPT, ['work', 'The job title']],
    note: 'When a visit is moved after the customer was told, "Updated time: " is put in front of the subject automatically.',
  },
  estimate_appointment: {
    label: 'Estimate visit confirmation', when: 'Email the customer from a scheduled estimate walkthrough',
    subject: 'Your estimate appointment with {company_name} — {visit_short}',
    body: 'Hi {customer_first},\n\n{intro}\n\nWhen: {visit_date}, {visit_time} ({timezone})\nWhere: {address}\nPurpose: {work}\nWho\'s coming: {crew}\n\n{message}\n\nNeed to change it? {call_us}. Please have someone 18 or older there to walk us through what you need.\n\n{company_name}\n{company_phone}',
    vars: [...COMMON, ['intro', '"This confirms your estimate appointment…", or the changed-time line'], ...APPT, ['work', '"look at the work and put together a price for: …"']],
    note: 'When a visit is moved after the customer was told, "Updated time: " is put in front of the subject automatically.',
  },
  on_the_way: {
    label: 'Technician on the way', when: 'A tech taps En route on a visit (Settings → Email the customer when a tech is on the way)',
    subject: '{tech_first} from {company_name} is on the way',
    body: 'Hi {customer_first},\n\n{tech_first} from {company_name} is on the way to {address} and should arrive at about {eta_time} ({timezone}).\n\nWork: {work}\n\n{message}\n\nNeed us to wait, or a different door or gate? {call_us}.\n\n{company_name}\n{company_phone}',
    vars: [...COMMON, ['tech_first', 'First name of the tech on the way'], ['crew', 'First names of everyone on the visit'], ['eta_time', 'e.g. 10:45 AM'], ['eta_minutes', 'e.g. 25'],
      ['timezone', 'e.g. MST'], ['address', 'Service address'], ['work', 'The job title or estimate purpose'], ['call_us', '"call (phone) or reply to this email"']],
  },
  appointment_cancelled: {
    label: 'Visit cancelled', when: '"Tell the customer it\'s cancelled" on a job or estimate visit',
    subject: 'Cancelled: your appointment with {company_name} — {visit_short}',
    body: 'Hi {customer_first},\n\nYour appointment on {visit_date} at {visit_time} has been cancelled.\n\n{message}\n\nTo book a new time, {call_us}.\n\n{company_name}\n{company_phone}',
    vars: [...COMMON, ...APPT, ['work', 'The job title or estimate purpose']],
  },
};

const key = (type, part) => `email_tpl_${type}_${part}`;
function current(db, type) {
  const t = TEMPLATES[type], s = D.settings(db);
  return { subject: s[key(type, 'subject')] || t.subject, body: s[key(type, 'body')] || t.body, customized: !!(s[key(type, 'subject')] || s[key(type, 'body')]) };
}

// fill {placeholders}; drop lines whose placeholder came out empty; capitalise a placeholder that starts a sentence
const PH = /\{([a-z_]+)\}/g;
function fill(tpl, vars, { dropEmpty = true } = {}) {
  const val = k => (vars[k] == null ? '' : String(vars[k]).trim());
  const out = [];
  for (const line of String(tpl || '').replace(/\r\n?/g, '\n').split('\n')) {
    const keys = [...line.matchAll(PH)].map(m => m[1]).filter(k => k in vars);
    let filled = line.replace(PH, (m, k, off) => {
      if (!(k in vars)) return m;
      const v = val(k), before = line.slice(0, off);
      return /(^\s*|[.!?]\s+)$/.test(before) && /^[a-z]/.test(v) ? v[0].toUpperCase() + v.slice(1) : v;
    });
    if (keys.some(k => !val(k))) {
      // an empty placeholder: leave the line out if nothing but a label or punctuation is left; otherwise just tidy the gap
      if (dropEmpty && (/^[\s\W_]*$/.test(filled) || /^[^:]{0,40}:[\s\W_]*$/.test(filled))) continue;
      filled = filled.replace(/[ \t]{2,}/g, ' ').replace(/ +([.,;:!?])/g, '$1').replace(/[ \t]+$/, '');
    }
    out.push(filled);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
const unknownPlaceholders = (type, ...texts) => {
  const known = new Set(TEMPLATES[type].vars.map(v => v[0]));
  return [...new Set(texts.flatMap(t => [...String(t || '').matchAll(PH)].map(m => m[1])).filter(k => !known.has(k)))];
};

const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const linkify = t => esc(t).replace(/https?:\/\/[^\s<>"]+?(?=[.,;:!?)\]']?(\s|$))/g, u => `<a href="${u}" style="color:#b00014">${u}</a>`);
const LABEL = /^([^:\n]{1,40}):\s+(.+)$/;
function toHtml(text, { footer = '' } = {}) {
  const paras = String(text || '').split(/\n{2,}/).map(p => p.split('\n'));
  const body = paras.map(lines => {
    const button = l => { const m = l.match(LABEL); return m && /^https?:\/\/\S+$/.test(m[2].trim()) ? m : null; };
    if (lines.length >= 2 && lines.every(l => LABEL.test(l) || /^[^:]{1,60}$/.test(l)) && lines.filter(l => LABEL.test(l)).length >= 2) {
      const rows = lines.filter(l => !button(l)).map(l => { const m = l.match(LABEL);
        return m ? `<tr><td style="padding:5px 18px 5px 0;color:#4b5563;vertical-align:top">${esc(m[1])}</td><td style="padding:5px 0"><b>${linkify(m[2])}</b></td></tr>`
          : `<tr><td colspan="2" style="padding:5px 0"><b>${linkify(l)}</b></td></tr>`; });
      const btns = lines.map(button).filter(Boolean);
      return `<table style="border-collapse:collapse;margin:12px 0;font-size:15px">${rows.join('')}</table>${btns.map(btnHtml).join('')}`;
    }
    if (lines.length === 1 && button(lines[0])) return btnHtml(button(lines[0]));
    return `<p>${lines.map(linkify).join('<br>')}</p>`;
  }).join('\n');
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.45;color:#16191f;max-width:580px">${body}${footer}</div>`;
}
const btnHtml = m => `<p style="margin:16px 0"><a href="${esc(m[2].trim())}" style="background:#fa001c;color:#fff;text-decoration:none;padding:11px 20px;border-radius:6px;font-weight:bold;display:inline-block">${esc(m[1])}</a></p>`;

// The email for one send. `edit` = {subject, body} typed in the Send window (used as written; placeholders still fill in).
function render(db, type, vars, edit = {}) {
  const c = current(db, type);
  const subjectTpl = String(edit.subject || '').trim() || c.subject, bodyTpl = String(edit.body || '').trim() ? edit.body : c.body;
  const subject = fill(subjectTpl, vars, { dropEmpty: false }).replace(/\s+/g, ' ').trim();
  const text = fill(bodyTpl, vars) + '\n';
  return { subject, text, html: toHtml(text) };
}

// common values from settings + customer
function baseVars(db, cust, message) {
  const s = D.settings(db);
  const phone = s.company_phone || '', email = s.company_email || '';
  return {
    customer_name: (cust && cust.name) || '', customer_first: String((cust && cust.name) || '').trim().split(/\s+/)[0] || 'there',
    company_name: s.company_name || 'All 4 You Electrical', company_phone: phone, company_email: email, message: String(message || '').trim(),
    questions: email || phone ? `Questions? ${email ? 'Reply to this email' : ''}${email && phone ? ' or call ' : phone ? 'Call ' : ''}${phone}.` : '',
    call_us: `call ${phone || 'us'}${email ? ' or reply to this email' : ''}`,
  };
}
const usd = n => (Number(n) || 0).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const fmtDate = d => d ? new Date(String(d).slice(0, 10) + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '';

// sample values for the Settings preview
const SAMPLE = {
  customer_name: 'Maria Lopez', customer_first: 'Maria', message: '', estimate_number: 'EST-1042', estimate_title: 'Panel upgrade to 200A', estimate_total: '$3,200.00',
  valid_until: 'Dec 10, 2026', link: 'https://ops.example.com/p/sample', invoice_number: 'INV-2210', invoice_total: '$1,850.00', amount_due: '$1,850.00', due_date: 'Dec 10, 2026',
  job_title: 'Garage circuit', intro: 'This confirms your appointment with {company_name}.', visit_date: 'Thursday, November 12', visit_time: '1:00 – 2:30 PM',
  visit_short: 'Thu, November 12, 1:00–2:30 PM', timezone: 'MST', tech_first: 'Dana', eta_time: '10:45 AM', eta_minutes: '25', address: '12 Elm St Boise, ID 83702', crew: 'Dana and Sam', work: 'Add 20A circuit for garage freezer',
};

function routes(app, db, { wrap, bad, admin }) {
  const list = () => Object.entries(TEMPLATES).map(([type, t]) => {
    const c = current(db, type);
    return { type, label: t.label, when: t.when, note: t.note || null, subject: c.subject, body: c.body, customized: c.customized,
      default_subject: t.subject, default_body: t.body, placeholders: t.vars.map(([k, d]) => ({ key: k, desc: d })) };
  });
  const typeOf = req => { const t = req.params.type; if (!TEMPLATES[t]) throw bad('Unknown email template', 404); return t; };
  app.get('/api/email-templates', admin, (req, res) => res.json(list()));
  app.put('/api/email-templates/:type', admin, wrap((req, res) => {
    const type = typeOf(req), t = TEMPLATES[type], b = req.body || {};
    const subject = String(b.subject ?? '').trim(), body = String(b.body ?? '').replace(/\r\n?/g, '\n').trim();
    const unknown = unknownPlaceholders(type, subject, body);
    if (unknown.length) throw bad(`Not a placeholder for this email: ${unknown.map(k => `{${k}}`).join(', ')}. Use the list under the box, or remove the braces.`);
    if (subject.length > 300) throw bad('Subject is too long');
    if (body.length > 10000) throw bad('Body is too long');
    if (['estimate', 'invoice'].includes(type) && body && !body.includes('{link}')) throw bad('Keep {link} in the body — it is how the customer opens the document');
    const up = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    up.run(key(type, 'subject'), subject && subject !== t.subject ? subject : '');
    up.run(key(type, 'body'), body && body !== t.body ? body : '');
    res.json(list().find(x => x.type === type));
  }));
  app.post('/api/email-templates/:type/preview', admin, wrap((req, res) => {
    const type = typeOf(req), b = req.body || {};
    const vars = { ...SAMPLE, ...baseVars(db, { name: SAMPLE.customer_name }, b.message || '') };
    vars.intro = fill(SAMPLE.intro, vars);
    if (type === 'estimate_appointment') { vars.intro = vars.intro.replace('appointment', 'estimate appointment'); vars.work = 'look at the work and put together a price for: Panel upgrade to 200A'; }
    res.json({ ...render(db, type, vars, { subject: b.subject, body: b.body }), unknown: unknownPlaceholders(type, b.subject, b.body) });
  }));
}

module.exports = { TEMPLATES, render, fill, toHtml, baseVars, usd, fmtDate, routes, unknownPlaceholders };
