'use strict';
// Editable customer email wording: Settings → Email templates, plus a per-send edit in the Send window.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const D = require('../server/db');
const { createApp } = require('../server/app');
const ET = require('../server/email_templates');

let server, base, db;
const tok = {}, ids = {};
async function call(who, method, p, body) {
  const res = await fetch(base + '/api' + p, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok[who] }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json() };
}
before(async () => {
  delete process.env.SMTP_HOST;
  db = D.open(':memory:');
  server = createApp(db).listen(0); await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  tok.admin = (await call(null, 'POST', '/setup', { name: 'Owner', email: 'owner@a4ye.example', password: 'longenough' })).data.token;
  await call('admin', 'PUT', '/settings', { company_name: 'All 4 You Electrical', company_email: 'office@a4ye.example', company_phone: '(208) 555-0100', timezone: 'America/Boise' });
  await call('admin', 'POST', '/users', { name: 'Ann Office', email: 'ann@x.com', password: 'password123', role: 'office' });
  tok.office = (await call(null, 'POST', '/login', { email: 'ann@x.com', password: 'password123' })).data.token;
  ids.cust = (await call('admin', 'POST', '/customers', { name: 'Maria Lopez', email: 'maria@example.com', location: { address: '12 Elm St', city: 'Boise', state: 'ID' } })).data.id;
  ids.inv = (await call('admin', 'POST', '/invoices', { customer_id: ids.cust, tax_rate: 0, due_date: '2099-12-10', items: [{ description: 'Service call', qty: 1, unit_price: 1850 }] })).data.id;
  ids.est = (await call('admin', 'POST', '/estimates', { customer_id: ids.cust, title: 'Panel', tax_rate: 0, items: [{ description: '200A panel', qty: 1, unit_price: 3200 }] })).data.id;
  ids.job = (await call('admin', 'POST', '/jobs', { customer_id: ids.cust, title: 'Garage circuit' })).data.id;
  ids.visit = (await call('admin', 'POST', '/appointments', { job_id: ids.job, start: '2099-11-12T20:00:00Z', end: '2099-11-12T21:30:00Z' })).data.id;
});
after(() => server.close());

test('fill: placeholders, empty lines dropped, capital at sentence start, unknown braces left alone', () => {
  const t = 'Hi {a},\nPhone: {b}\n{c}. Then {c}.\nKeep {not_a_var}';
  assert.equal(ET.fill(t, { a: 'Maria', b: '', c: 'call us' }), 'Hi Maria,\nCall us. Then call us.\nKeep {not_a_var}');
  assert.equal(ET.fill('Thanks. {m}\n{m}\nCrew: {m}\nDone', { m: '' }), 'Thanks.\nDone', 'inline empty note tidied; lone or label-only lines dropped');
});

test('HTML: Label lines become a list, a link line becomes a button, other links clickable', () => {
  const h = ET.toHtml('Hi Maria,\n\nInvoice INV-1\nAmount due: $10.00\nView online: https://x.example/p/1\n\nSee https://x.example/faq for more.');
  assert.match(h, /<table[^>]*>.*Amount due.*<b>\$10\.00<\/b>/s);
  assert.match(h, /<a href="https:\/\/x\.example\/p\/1"[^>]*display:inline-block[^>]*>View online<\/a>/);
  assert.match(h, /<a href="https:\/\/x\.example\/faq"[^>]*>https:\/\/x\.example\/faq<\/a> for more\./);
  assert.match(ET.toHtml('<b>hi</b>'), /&lt;b&gt;hi&lt;\/b&gt;/, 'text is escaped');
});

test('Settings → Email templates: list, save, reject bad placeholders and a missing link, reset; admins only', async () => {
  const list = (await call('admin', 'GET', '/email-templates')).data;
  assert.deepEqual(list.map(t => t.type), ['estimate', 'invoice', 'appointment', 'estimate_appointment', 'appointment_cancelled']);
  assert.equal(list.find(t => t.type === 'invoice').customized, false);
  assert.equal((await call('office', 'GET', '/email-templates')).status, 403);
  let r = await call('admin', 'PUT', '/email-templates/invoice', { subject: 'Bill {invoice_number}', body: 'Hi {customer_frist}, {link}' });
  assert.equal(r.status, 400); assert.match(r.data.error, /\{customer_frist\}/);
  r = await call('admin', 'PUT', '/email-templates/invoice', { subject: 'x', body: 'No link here' });
  assert.equal(r.status, 400); assert.match(r.data.error, /\{link\}/);
  r = await call('admin', 'PUT', '/email-templates/invoice', { subject: '{company_name} invoice {invoice_number} — {amount_due} due {due_date}',
    body: 'Hello {customer_first}!\n\nThanks for choosing us. {message}\n\nAmount due: {amount_due}\nPay online: {link}\n\nJob: {job_title}\n\n{company_name}' });
  assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.customized, true);
  // preview with sample data
  const p = (await call('admin', 'POST', '/email-templates/invoice/preview', { subject: 'Hi {customer_first} {bogus}', body: 'x {link}' })).data;
  assert.equal(p.subject, 'Hi Maria {bogus}'); assert.deepEqual(p.unknown, ['bogus']);
});

test('the customised invoice wording is what the Send window shows and what goes out; the Send window can change it once', async () => {
  const em = (await call('office', 'GET', `/invoices/${ids.inv}/email`)).data;
  assert.equal(em.to, 'maria@example.com');
  assert.equal(em.subject, 'All 4 You Electrical invoice INV-1001 — $1,850.00 due Dec 10, 2099'.replace('INV-1001', em.subject.match(/INV-\d+/)[0]));
  assert.match(em.body, /^Hello Maria!\n\nThanks for choosing us\.\n\nAmount due: \$1,850\.00\nPay online: http/);
  assert.doesNotMatch(em.body, /Job:/, 'no job on this invoice → the Job line is left out');
  // edited for this one send
  const r = (await call('office', 'POST', `/invoices/${ids.inv}/send`, { subject: 'Your bill', body: 'Maria — here it is: {link}\nThanks!' })).data;
  assert.equal(r.status, 'not_configured'); assert.equal(r.subject, 'Your bill'); assert.match(r.text, /^Maria — here it is: http\S+\/p\/invoice\/\S+\nThanks!/);
  const ob = db.prepare("SELECT * FROM outbox WHERE related = ? ORDER BY id DESC").get(`invoice:${ids.inv}`);
  assert.equal(ob.subject, 'Your bill');
  // the saved template is untouched by a one-off edit; back to default
  assert.equal((await call('admin', 'GET', '/email-templates')).data.find(t => t.type === 'invoice').customized, true);
  await call('admin', 'PUT', '/email-templates/invoice', { subject: '', body: '' });
  const d = (await call('office', 'GET', `/invoices/${ids.inv}/email`)).data;
  assert.match(d.subject, /^Invoice INV-\d+ from All 4 You Electrical$/);
  assert.match(d.body, /Questions\? Reply to this email or call \(208\) 555-0100\./);
});

test('estimate: default wording and a per-send edit', async () => {
  const em = (await call('office', 'GET', `/estimates/${ids.est}/email`)).data;
  assert.match(em.subject, /^Estimate EST-\d+ from All 4 You Electrical$/);
  assert.match(em.body, /Estimate EST-\d+: \$3,200\.00\nView and approve online: http\S+\/p\/estimate\//);
  const r = (await call('office', 'POST', `/estimates/${ids.est}/send`, { subject: em.subject, body: em.body.replace('Thank you for the opportunity.', 'Great meeting you Tuesday.') })).data;
  assert.match(r.text, /Great meeting you Tuesday\./);
});

test('job visit confirmation follows its template; the changed-time prefix still applies; cancellations have their own', async () => {
  await call('admin', 'PUT', '/email-templates/appointment', { subject: 'See you {visit_short}', body: 'Hi {customer_first},\n\n{intro}\n\nArriving: {visit_date}, {visit_time}\nCrew: {crew}\n\nPlease leave the gate open. {call_us} with questions.' });
  let c = (await call('admin', 'GET', `/appointments/${ids.visit}/confirmation`)).data;
  assert.equal(c.subject, 'See you Thu, November 12, 1:00–2:30 PM');
  assert.match(c.text, /Arriving: Thursday, November 12, 1:00 – 2:30 PM\n\nPlease leave the gate open\. Call \(208\) 555-0100 or reply to this email with questions\./);
  assert.doesNotMatch(c.text, /Crew:/, 'no crew assigned → line left out');
  await call('admin', 'POST', `/appointments/${ids.visit}/confirm`, {});
  await call('admin', 'PUT', `/appointments/${ids.visit}`, { start: '2099-11-12T21:00:00Z', end: '2099-11-12T22:30:00Z' });
  c = (await call('admin', 'GET', `/appointments/${ids.visit}/confirmation`)).data;
  assert.equal(c.subject, 'Updated time: See you Thu, November 12, 2:00–3:30 PM'); assert.match(c.text, /We've changed the time/);
  // per-send edit wins (no prefix added to a subject typed in the Send window)
  const r = (await call('admin', 'POST', `/appointments/${ids.visit}/confirm`, { subject: 'New time Thursday', body: 'Maria, we moved you to 2pm.' })).data;
  assert.equal(r.subject, 'New time Thursday'); assert.equal(r.text, 'Maria, we moved you to 2pm.\n');
  // cancellation preview
  const x = (await call('admin', 'GET', `/appointments/${ids.visit}/confirmation?cancelled=1`)).data;
  assert.match(x.subject, /^Cancelled: your appointment with All 4 You Electrical/); assert.match(x.text, /To book a new time, call \(208\) 555-0100/);
});
