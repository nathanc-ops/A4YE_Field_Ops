'use strict';
// Bring data over from another system (ServiceTitan, Successware, Housecall, QuickBooks, spreadsheets…)
// as CSV. Each import type lists the fields it understands with the column names other systems use,
// so most exports map themselves. Every import runs in one transaction, can be test-run first
// (the same code runs and then rolls back), and records what it created so the batch can be undone.
const D = require('./db');
const A = require('./accounting');
const { all, get, run, tx, settings } = D;

const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
const err = (m, s = 400) => Object.assign(new Error(m), { status: s });
const DRY = Symbol('dry run');

// ------------------------------------------------------------ parsing
function parseRows(text) {
  text = String(text || '').replace(/^﻿/, '');
  const first = text.slice(0, text.search(/\r?\n|$/));
  const delim = (first.match(/\t/g) || []).length > (first.match(/,/g) || []).length ? '\t'
    : (first.match(/;/g) || []).length > (first.match(/,/g) || []).length ? ';' : ',';
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
    else if (c === '"') q = true;
    else if (c === delim) { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; }
    else cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows.map(r => r.map(x => x.trim())).filter(r => r.some(x => x !== ''));
}
const norm = s => String(s || '').toLowerCase().replace(/#/g, 'number').replace(/\bno\b\.?/g, 'number').replace(/[^a-z0-9]/g, '');
function parseDate(s) {
  s = String(s || '').trim(); if (!s) return null;
  let m;
  if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s))) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  if ((m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})\b/.exec(s))) return `${m[3].length === 2 ? '20' + m[3] : m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  const d = new Date(s); // "Nov 3, 2026", "3 November 2026"
  return isNaN(d) ? null : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
// A local date/time from the file → UTC ISO, using the office's time-zone offset (minutes, as JS getTimezoneOffset()).
function parseDateTime(s, tzOffset = 0, defaultTime = '08:00') {
  s = String(s || '').trim();
  if (/T\d\d:\d\d.*(Z|[+-]\d\d:?\d\d)$/.test(s)) { const d = new Date(s); return isNaN(d) ? null : d.toISOString(); } // already has a zone
  const date = parseDate(s); if (!date) return null;
  const t = /(\d{1,2}):(\d{2})(?::\d{2})?\s*([ap]\.?m\.?)?/i.exec(s);
  let hh, mm;
  if (t) {
    hh = Number(t[1]); mm = Number(t[2]);
    if (t[3]) { const pm = /p/i.test(t[3]); if (hh === 12) hh = pm ? 12 : 0; else if (pm) hh += 12; }
  } else [hh, mm] = defaultTime.split(':').map(Number);
  const utc = Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10), hh, mm) + tzOffset * 60000;
  return new Date(utc).toISOString();
}
function parseAmount(s) {
  if (s == null) return null;
  let t = String(s).trim(); if (!t) return null;
  const neg = /^\(.*\)$/.test(t) || /^-/.test(t) || /-$/.test(t);
  t = t.replace(/[^0-9.]/g, '');
  if (!t || t === '.') return null;
  const v = parseFloat(t);
  return Number.isFinite(v) ? (neg ? -v : v) : null;
}
const parseRate = s => { const v = parseAmount(s); return v == null ? null : (v > 0 && v < 1 && !/%/.test(s) ? r2(v * 100) : v); }; // 0.08 or 8% → 8
const yes = s => /^(y|yes|true|1|x|taxable|billed|paid|active)$/i.test(String(s || '').trim());
const no = s => /^(n|no|false|0|non-?taxable|exempt)$/i.test(String(s || '').trim());
const digits = s => String(s || '').replace(/\D/g, '').slice(-10);
const clip = (s, n = 500) => s == null || s === '' ? null : String(s).slice(0, n);

// ------------------------------------------------------------ field definitions
// f(key, label, aliases, extra) — aliases are other systems' column names (matched ignoring case/punctuation)
const f = (key, lbl, aliases = [], extra = {}) => ({ key, label: lbl, aliases, ...extra });
const CUSTOMER_REF = [
  f('customer_id', 'Customer ID (old system)', ['customer id', 'customer #', 'customer number', 'cust id', 'account #', 'account number', 'customerid']),
  f('customer_name', 'Customer name', ['customer', 'customer name', 'client', 'client name', 'name', 'bill to', 'customer full name', 'display name']),
  f('customer_email', 'Customer email', ['email', 'customer email', 'e-mail']),
  f('customer_phone', 'Customer phone', ['phone', 'customer phone', 'mobile', 'phone number']),
];
const ADDRESS = [
  f('address', 'Service address', ['service address', 'address', 'street', 'address 1', 'address line 1', 'location address', 'job address', 'site address']),
  f('city', 'City', ['city', 'service city']), f('state', 'State', ['state', 'service state', 'province']), f('zip', 'ZIP', ['zip', 'zip code', 'postal code', 'service zip']),
];
const LINE_FIELDS = [
  f('item', 'Line item / description', ['item', 'line item', 'item name', 'line description', 'task', 'product/service', 'product', 'service', 'item description', 'sku description']),
  f('item_code', 'Item code / SKU', ['sku', 'item code', 'part #', 'part number', 'task code', 'code']),
  f('qty', 'Quantity', ['qty', 'quantity', 'units']),
  f('unit_price', 'Unit price', ['unit price', 'price', 'rate', 'sales price', 'each']),
  f('unit_cost', 'Unit cost', ['unit cost', 'cost', 'item cost']),
  f('line_total', 'Line amount', ['line total', 'amount', 'line amount', 'extended price', 'ext price']),
  f('taxable', 'Taxable (yes/no)', ['taxable', 'tax']),
];
const TYPES = {
  customers: {
    label: 'Customers', note: 'One row per customer. A service address on the row adds a location. Matches existing customers by old-system ID, email, phone, then exact name.',
    options: [{ key: 'update_existing', label: 'Fill in missing details on customers that already exist', default: true }],
    fields: [
      f('external_id', 'Customer ID (old system)', ['customer id', 'id', 'customer #', 'customer number', 'account #', 'account number']),
      f('name', 'Customer name', ['name', 'customer name', 'customer', 'full name', 'display name', 'client name']),
      f('first_name', 'First name', ['first name', 'first']), f('last_name', 'Last name', ['last name', 'last']),
      f('company', 'Company', ['company', 'company name', 'business name', 'business']),
      f('type', 'Residential / commercial', ['type', 'customer type', 'customer class', 'class']),
      f('email', 'Email', ['email', 'e-mail', 'email address', 'primary email']),
      f('phone', 'Phone', ['phone', 'phone number', 'mobile', 'mobile phone', 'primary phone', 'cell']),
      f('alt_phone', 'Other phone', ['alt phone', 'other phone', 'home phone', 'work phone', 'secondary phone']),
      f('billing_address', 'Billing address', ['billing address', 'bill address', 'billing street', 'mailing address']),
      f('billing_city', 'Billing city', ['billing city', 'bill city']), f('billing_state', 'Billing state', ['billing state', 'bill state']), f('billing_zip', 'Billing ZIP', ['billing zip', 'bill zip', 'billing postal code']),
      ...ADDRESS,
      f('lead_source', 'Lead source', ['lead source', 'source', 'campaign', 'referral source', 'marketing source']),
      f('tax_exempt', 'Tax exempt (yes/no)', ['tax exempt', 'exempt']),
      f('terms', 'Payment terms', ['terms', 'payment terms', 'net terms']),
      f('notes', 'Notes', ['notes', 'note', 'comments', 'customer notes']),
      f('created_at', 'Customer since', ['created', 'created date', 'created on', 'customer since', 'date added']),
    ],
  },
  jobs: {
    label: 'Jobs', note: 'One row per job. Finds the customer (or creates one from the name). Keeps the old job number, so later files (estimates, invoices, notes, materials, photos) link to it.',
    fields: [
      f('number', 'Job number', ['job #', 'job number', 'job id', 'job no', 'work order', 'work order #', 'wo #', 'ticket #', 'number']),
      ...CUSTOMER_REF, ...ADDRESS,
      f('title', 'Job title / summary', ['summary', 'title', 'job name', 'job title', 'job summary', 'name of job']),
      f('description', 'Description', ['description', 'job description', 'notes', 'work description', 'scope']),
      f('job_type', 'Job type', ['job type', 'type', 'category', 'business unit', 'service type']),
      f('status', 'Status', ['status', 'job status']),
      f('priority', 'Priority', ['priority']),
      f('scheduled_start', 'Scheduled start', ['scheduled', 'scheduled date', 'scheduled start', 'start', 'start date', 'appointment', 'appointment date', 'job date', 'date']),
      f('scheduled_end', 'Scheduled end', ['scheduled end', 'end', 'end date', 'appointment end']),
      f('completed_at', 'Completed date', ['completed', 'completed date', 'completion date', 'completed on', 'closed date']),
      f('created_at', 'Created date', ['created', 'created date', 'created on', 'booked on', 'date booked']),
      f('technician', 'Technician(s)', ['technician', 'technicians', 'tech', 'techs', 'assigned to', 'assigned technicians', 'employee']),
      f('lead_source', 'Lead source', ['lead source', 'source', 'campaign', 'marketing source']),
      f('po_number', 'Customer PO #', ['po', 'po #', 'po number', 'customer po']),
      f('billing_type', 'Billing (quoted / T&M)', ['billing type', 'pricing', 'pricing type', 'contract type']),
      f('contract_amount', 'Quoted / contract price', ['contract amount', 'contract', 'quoted price', 'fixed price', 'bid amount', 'sold amount']),
      f('completion_notes', 'Completion notes', ['completion notes', 'resolution', 'work performed', 'tech notes']),
    ],
    options: [{ key: 'update_existing', label: 'Update jobs whose number already exists (otherwise they are skipped)', default: false }],
  },
  estimates: {
    label: 'Estimates', note: 'One row per estimate, or one row per line item with the estimate number repeated. An "Option" column (Good / Better / Best) builds options.',
    fields: [
      f('number', 'Estimate number', ['estimate #', 'estimate number', 'estimate id', 'quote #', 'quote number', 'proposal #', 'number']),
      f('job_number', 'Job number', ['job #', 'job number', 'job id', 'work order']),
      ...CUSTOMER_REF,
      f('title', 'Title / summary', ['name', 'title', 'summary', 'estimate name', 'description']),
      f('status', 'Status', ['status', 'estimate status']),
      f('date', 'Estimate date', ['date', 'created', 'created date', 'estimate date', 'sent date']),
      f('valid_until', 'Expires', ['expires', 'expiration', 'expiration date', 'valid until']),
      f('option', 'Option (Good / Better / Best)', ['option', 'option name', 'tier', 'package']),
      ...LINE_FIELDS,
      f('tax_rate', 'Tax rate %', ['tax rate', 'tax %', 'sales tax rate']),
      f('tax_amount', 'Tax amount', ['tax amount', 'sales tax', 'tax total']),
      f('discount', 'Discount $', ['discount', 'discount amount']),
      f('total', 'Estimate total', ['total', 'estimate total', 'grand total', 'total amount']),
      f('notes', 'Notes', ['notes', 'customer notes', 'memo']),
    ],
  },
  invoices: {
    label: 'Invoices & payments', note: 'One row per invoice, or one row per line item with the invoice number repeated. "Amount paid" or "Balance due" records the payment.',
    fields: [
      f('number', 'Invoice number', ['invoice #', 'invoice number', 'invoice no', 'invoice id', 'num', 'number']),
      f('job_number', 'Job number', ['job #', 'job number', 'job id', 'work order']),
      ...CUSTOMER_REF,
      f('issue_date', 'Invoice date', ['invoice date', 'date', 'issue date', 'created', 'txn date']),
      f('due_date', 'Due date', ['due date', 'due']),
      f('status', 'Status', ['status', 'invoice status']),
      ...LINE_FIELDS,
      f('tax_rate', 'Tax rate %', ['tax rate', 'tax %', 'sales tax rate']),
      f('tax_amount', 'Tax amount', ['tax amount', 'sales tax', 'tax total']),
      f('discount', 'Discount $', ['discount', 'discount amount']),
      f('total', 'Invoice total', ['total', 'invoice total', 'grand total', 'total amount', 'amount due']),
      f('amount_paid', 'Amount paid', ['amount paid', 'paid', 'payments', 'paid amount', 'total paid']),
      f('balance', 'Balance due', ['balance', 'balance due', 'open balance', 'outstanding']),
      f('paid_date', 'Paid date', ['paid date', 'payment date', 'date paid']),
      f('payment_method', 'Payment method', ['payment method', 'payment type', 'method']),
      f('notes', 'Notes', ['notes', 'memo', 'message']),
    ],
    options: [{ key: 'post_to_books', label: 'Post these invoices and payments to the books', default: false,
      help: 'Leave this off if you are bringing over opening balances (accounts receivable as one total). Then old invoices show on customers, jobs and sales reports without counting twice in accounting. Payments you record on them from now on still post normally.' }],
  },
  notes: {
    label: 'Notes', note: 'One row per note. With a job number the note goes on the job; otherwise it is added to the customer\'s notes.',
    fields: [
      f('job_number', 'Job number', ['job #', 'job number', 'job id', 'work order']),
      ...CUSTOMER_REF,
      f('note', 'Note', ['note', 'notes', 'comment', 'comments', 'body', 'text', 'message']),
      f('date', 'Date', ['date', 'created', 'created date', 'created on', 'timestamp']),
      f('author', 'Written by', ['author', 'user', 'created by', 'employee', 'by']),
    ],
  },
  pricebook: {
    label: 'Materials & price book', note: 'Your materials, services and flat-rate tasks. Matches existing items by code, then name, and updates them.',
    fields: [
      f('code', 'Code / SKU', ['code', 'sku', 'item code', 'part #', 'part number', 'item #', 'task code']),
      f('name', 'Name', ['name', 'item', 'item name', 'product/service', 'product', 'task', 'task name']),
      f('description', 'Description', ['description', 'sales description', 'long description']),
      f('category', 'Category', ['category', 'group', 'type category', 'department']),
      f('kind', 'Kind (material / service / labor / equipment)', ['kind', 'type', 'item type']),
      f('unit', 'Unit', ['unit', 'uom', 'unit of measure']),
      f('unit_cost', 'Cost', ['cost', 'unit cost', 'purchase cost', 'material cost']),
      f('unit_price', 'Price', ['price', 'unit price', 'sales price', 'sell price', 'retail']),
      f('labor_hours', 'Labor hours', ['hours', 'labor hours', 'est hours']),
      f('taxable', 'Taxable (yes/no)', ['taxable', 'tax']),
      f('qty_on_hand', 'Quantity on hand', ['qty on hand', 'on hand', 'quantity', 'qty', 'stock']),
      f('reorder_point', 'Reorder point', ['reorder point', 'reorder', 'min', 'minimum']),
      f('vendor', 'Vendor', ['vendor', 'supplier', 'preferred vendor']),
      f('active', 'Active (yes/no)', ['active', 'status']),
    ],
  },
  job_materials: {
    label: 'Materials used on jobs', note: 'Material history for job costing. Does not change stock on hand or the books. Mark rows billed so T&M billing doesn\'t bill them again (default: billed when the job is finished).',
    fields: [
      f('job_number', 'Job number', ['job #', 'job number', 'job id', 'work order'], { required: true }),
      f('item', 'Item', ['item', 'item name', 'description', 'material', 'name', 'product']),
      f('item_code', 'Code / SKU', ['code', 'sku', 'item code', 'part #']),
      f('qty', 'Quantity', ['qty', 'quantity', 'units']),
      f('unit_cost', 'Unit cost', ['unit cost', 'cost']),
      f('unit_price', 'Unit price', ['unit price', 'price', 'sell price']),
      f('date', 'Date used', ['date', 'used on', 'date used', 'used date']),
      f('billed', 'Already billed (yes/no)', ['billed', 'invoiced']),
    ],
  },
  vendors: {
    label: 'Vendors', note: 'Supply houses and subcontractors. Matches existing vendors by name.',
    fields: [
      f('name', 'Vendor name', ['name', 'vendor', 'vendor name', 'company', 'supplier'], { required: true }),
      f('contact', 'Contact', ['contact', 'contact name', 'rep']), f('email', 'Email', ['email', 'e-mail']), f('phone', 'Phone', ['phone', 'phone number']),
      f('address', 'Address', ['address', 'street', 'billing address']), f('account_number', 'Our account #', ['account #', 'account number', 'acct #']),
      f('terms', 'Terms', ['terms', 'payment terms']), f('notes', 'Notes', ['notes', 'memo']),
    ],
  },
  accounts: {
    label: 'Chart of accounts', note: 'Adds accounts you had in your old books. Existing accounts are matched by number or name and left as they are. Accounts without a number get one in the right range.',
    fields: [
      f('number', 'Account number', ['number', 'account number', 'account #', 'acct #', 'acct num']),
      f('name', 'Account name', ['name', 'account name', 'account', 'full name'], { required: true }),
      f('type', 'Type', ['type', 'account type', 'detail type'], { required: true }),
      f('description', 'Description', ['description', 'notes']),
    ],
  },
  opening_balances: {
    label: 'Opening balances', note: 'Your trial balance from the old books on your start date. Any difference goes to Opening Balance Equity. Import the chart of accounts first if accounts are missing.',
    fields: [
      f('account', 'Account (number or name)', ['account', 'account number', 'account name', 'acct', 'number', 'name'], { required: true }),
      f('debit', 'Debit', ['debit', 'debits', 'dr']), f('credit', 'Credit', ['credit', 'credits', 'cr']),
      f('balance', 'Balance (if no debit/credit)', ['balance', 'amount', 'ending balance']),
    ],
    options: [{ key: 'as_of', label: 'Balances as of (your start date)', type: 'date', required: true }],
  },
  journal: {
    label: 'Journal entries', note: 'General ledger history. Rows with the same entry number (or date when there is none) make one entry, which must balance.',
    fields: [
      f('entry', 'Entry # / reference', ['entry', 'entry #', 'entry number', 'journal #', 'je #', 'num', 'ref', 'reference', 'transaction id', 'trans #']),
      f('date', 'Date', ['date', 'txn date', 'entry date', 'transaction date'], { required: true }),
      f('account', 'Account (number or name)', ['account', 'account number', 'account name', 'acct'], { required: true }),
      f('debit', 'Debit', ['debit', 'debits', 'dr']), f('credit', 'Credit', ['credit', 'credits', 'cr']),
      f('amount', 'Amount (+ debit / − credit)', ['amount']),
      f('memo', 'Memo', ['memo', 'description', 'memo/description', 'name', 'line memo']),
      f('job_number', 'Job number', ['job #', 'job number', 'job']),
    ],
  },
};
for (const [k, t] of Object.entries(TYPES)) t.key = k;

function autoMap(headers, fields) {
  const H = headers.map(norm), map = {}, used = new Set();
  const take = (fld, i) => { map[fld.key] = headers[i]; used.add(i); };
  for (const pass of [0, 1]) for (const fld of fields) {
    if (map[fld.key]) continue;
    const names = [fld.key, fld.label, ...fld.aliases].map(norm).filter(Boolean);
    const i = H.findIndex((h, j) => !used.has(j) && (pass === 0 ? names.includes(h) : names.some(n => n.length > 3 && h.length > 3 && (h.includes(n) || n.includes(h)))));
    if (i >= 0) take(fld, i);
  }
  return map;
}

function describe() {
  return Object.values(TYPES).map(t => ({ key: t.key, label: t.label, note: t.note, options: t.options || [],
    fields: t.fields.map(x => ({ key: x.key, label: x.label, required: !!x.required })) }));
}
function preview(type, text) {
  const t = TYPES[type]; if (!t) throw err('Unknown import type');
  const rows = parseRows(text);
  if (!rows.length) throw err('That file is empty');
  const headers = rows[0];
  return { headers, mapping: autoMap(headers, t.fields), sample: rows.slice(1, 6), row_count: rows.length - 1 };
}

// ------------------------------------------------------------ the import run
function runImport(db, { type, text, mapping, options = {}, filename, userId, dryRun = false, H = {} }) {
  const t = TYPES[type]; if (!t) throw err('Unknown import type');
  const rows = parseRows(text);
  if (rows.length < 2) throw err('No data rows found (the first row must be the column headings)');
  const headers = rows[0];
  mapping = mapping || autoMap(headers, t.fields);
  const idx = {};
  for (const fld of t.fields) { const h = mapping[fld.key]; if (h) { const i = headers.indexOf(h); if (i >= 0) idx[fld.key] = i; } }
  for (const fld of t.fields) if (fld.required && idx[fld.key] == null) throw err(`Choose a column for “${fld.label}”`);
  for (const o of t.options || []) if (o.required && !options[o.key]) throw err(`Set “${o.label}”`);
  const recs = rows.slice(1).map((r, i) => {
    const o = { _row: i + 2 };
    for (const [k, j] of Object.entries(idx)) o[k] = (r[j] ?? '').trim();
    return o;
  });

  const ctx = { db, userId, options, H, tz: Number(options.tz_offset) || 0, created: [], updated: 0, skipped: 0, errors: [], warnings: [], counts: {} };
  ctx.made = (entity, id) => { ctx.created.push([entity, id]); ctx.counts[entity] = (ctx.counts[entity] || 0) + 1; return id; };
  ctx.warn = (row, m) => { if (ctx.warnings.length < 300) ctx.warnings.push({ row, message: m }); };
  let report;
  try {
    tx(db, () => {
      IMPORTERS[type](ctx, recs);
      report = finish(ctx, { type, filename, userId, dryRun });
      if (dryRun) throw DRY;
    });
  } catch (e) { if (e !== DRY) throw e; }
  return report;
}
function finish(ctx, { type, filename, userId, dryRun }) {
  const created = ctx.created.length;
  let batchId = null;
  if (!dryRun && (created || ctx.updated)) {
    batchId = Number(run(ctx.db, 'INSERT INTO import_batches (type, filename, options, created_count, updated_count, skipped_count, warnings, user_id) VALUES (?,?,?,?,?,?,?,?)',
      type, filename || null, JSON.stringify(ctx.options || {}), created, ctx.updated, ctx.skipped + ctx.errors.length,
      JSON.stringify([...ctx.errors, ...ctx.warnings].slice(0, 300)), userId || null).lastInsertRowid);
    const ins = ctx.db.prepare('INSERT INTO import_records (batch_id, entity, entity_id) VALUES (?,?,?)');
    for (const [e, id] of ctx.created) ins.run(batchId, e, id);
  }
  return { dry_run: !!dryRun, batch_id: batchId, created: ctx.counts, created_total: created, updated: ctx.updated, skipped: ctx.skipped,
    errors: ctx.errors.slice(0, 300), error_count: ctx.errors.length, warnings: ctx.warnings };
}
// each row (or group) runs in its own savepoint so one bad row doesn't spoil the rest
function eachRow(ctx, items, fn) {
  for (const it of items) {
    const row = Array.isArray(it) ? it[0]._row : it._row;
    const before = ctx.created.length, counts = { ...ctx.counts }, upd = ctx.updated;
    try { tx(ctx.db, () => fn(it)); }
    catch (e) { ctx.created.length = before; ctx.counts = counts; ctx.updated = upd; if (e.status || e.code === 'ERR_SQLITE_ERROR') ctx.errors.push({ row, message: e.message }); else throw e; }
  }
}
const groupBy = (recs, key) => { const m = new Map(); for (const r of recs) { const k = key(r); if (!m.has(k)) m.set(k, []); m.get(k).push(r); } return [...m.values()]; };
function insert(db, table, data) {
  const keys = Object.keys(data).filter(k => data[k] !== undefined);
  return Number(run(db, `INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, ...keys.map(k => data[k])).lastInsertRowid);
}
function update(db, table, id, data) {
  const keys = Object.keys(data).filter(k => data[k] !== undefined && data[k] !== null && data[k] !== '');
  if (keys.length) run(db, `UPDATE ${table} SET ${keys.map(k => `${k} = ?`).join(',')} WHERE id = ?`, ...keys.map(k => data[k]), id);
  return keys.length;
}

// ------------------------------------------------------------ lookups
function terms(s) { const m = /(\d+)/.exec(String(s || '')); return m ? Number(m[1]) : /receipt|cod/i.test(s || '') ? 0 : null; }
function findCustomer(db, r) {
  if (r.customer_id || r.external_id) { const c = get(db, 'SELECT * FROM customers WHERE external_id = ?', r.customer_id || r.external_id); if (c) return c; }
  const email = (r.customer_email || r.email || '').toLowerCase();
  if (email) { const c = get(db, 'SELECT * FROM customers WHERE lower(email) = ?', email); if (c) return c; }
  const ph = digits(r.customer_phone || r.phone);
  if (ph.length === 10) {
    const clean = col => `replace(replace(replace(replace(replace(replace(${col},'-',''),' ',''),'(',''),')',''),'.',''),'+','')`;
    const c = get(db, `SELECT * FROM customers WHERE ${clean('phone')} LIKE ? OR ${clean('alt_phone')} LIKE ? ORDER BY id LIMIT 1`, '%' + ph, '%' + ph);
    if (c) return c;
  }
  const name = (r.customer_name || r.name || '').toLowerCase();
  if (name) { const c = get(db, 'SELECT * FROM customers WHERE lower(name) = ? OR lower(company) = ? ORDER BY id LIMIT 1', name, name); if (c) return c; }
  return null;
}
// customer for a job/estimate/invoice/note row: existing, or a new one from the name on the row
function customerFor(ctx, r, { create = true } = {}) {
  const c = findCustomer(ctx.db, r);
  if (c) return c;
  if (!create || !r.customer_name) throw err(r.customer_name || r.customer_id ? `Customer “${r.customer_name || r.customer_id}” not found` : 'No customer on this row');
  const id = ctx.made('customer', insert(ctx.db, 'customers', { name: clip(r.customer_name, 200), email: clip(r.customer_email, 200), phone: clip(r.customer_phone, 40), external_id: clip(r.customer_id, 80) }));
  ctx.warn(r._row, `Created customer “${r.customer_name}”`);
  return get(ctx.db, 'SELECT * FROM customers WHERE id = ?', id);
}
function locationFor(ctx, customerId, r) {
  if (!r.address) return null;
  const l = get(ctx.db, 'SELECT id FROM locations WHERE customer_id = ? AND lower(address) = ?', customerId, r.address.toLowerCase());
  if (l) return l.id;
  return ctx.made('location', insert(ctx.db, 'locations', { customer_id: customerId, address: clip(r.address, 200), city: clip(r.city, 80), state: clip(r.state, 40), zip: clip(r.zip, 20) }));
}
function jobByNumber(db, n) { return n ? get(db, 'SELECT * FROM jobs WHERE number = ?', String(n).trim()) : null; }
function userByName(db, name) {
  const n = String(name || '').trim().toLowerCase(); if (!n) return null;
  const users = all(db, 'SELECT id, name, email FROM users');
  return users.find(u => u.name.toLowerCase() === n || (u.email || '').toLowerCase() === n)
    || (users.filter(u => u.name.toLowerCase().split(/\s+/)[0] === n).length === 1 ? users.find(u => u.name.toLowerCase().split(/\s+/)[0] === n) : null);
}
function accountFor(db, s) {
  const v = String(s || '').trim(); if (!v) return null;
  const num = /^(\d{3,6})\b/.exec(v);
  if (num) { const a = get(db, 'SELECT * FROM accounts WHERE number = ?', num[1]); if (a) return a; }
  const name = v.replace(/^\d{3,6}\s*[·:\-–]?\s*/, '').toLowerCase();
  return get(db, 'SELECT * FROM accounts WHERE lower(name) = ?', name) || get(db, 'SELECT * FROM accounts WHERE lower(name) = ?', v.toLowerCase())
    || get(db, 'SELECT * FROM accounts WHERE lower(name) = ?', (name.split(':').pop() || '').trim());
}

const JOB_STATUS = s => {
  s = String(s || '').toLowerCase();
  return /cancel|void|lost/.test(s) ? 'cancelled' : /invoic|billed|paid/.test(s) ? 'invoiced' : /complet|done|closed|finish/.test(s) ? 'completed'
    : /hold|pend/.test(s) ? 'on_hold' : /progress|working|started|on ?site/.test(s) ? 'in_progress' : /dispatch|en ?route/.test(s) ? 'dispatched'
    : /schedul|book|confirm/.test(s) ? 'scheduled' : /unsched|open|new|lead/.test(s) ? 'unscheduled' : null;
};
const DOC_STATUS = s => {
  s = String(s || '').toLowerCase();
  return /approv|accept|sold|won|sign/.test(s) ? 'approved' : /declin|lost|reject|dismiss/.test(s) ? 'declined' : /expir/.test(s) ? 'expired'
    : /view|open(ed)?$/.test(s) ? 'viewed' : /sent|pending|present|open/.test(s) ? 'sent' : /draft/.test(s) ? 'draft' : null;
};
const KINDS = ['material', 'service', 'labor', 'equipment'];
const kindOf = s => { s = String(s || '').toLowerCase(); return KINDS.find(k => s.includes(k)) || (/task|flat|service/.test(s) ? 'service' : /inventory|part|product|non-?inventory/.test(s) ? 'material' : null); };
const METHOD = s => { s = String(s || '').toLowerCase(); return /check|chk/.test(s) ? 'check' : /cash/.test(s) ? 'cash' : /ach|bank|transfer|eft|wire/.test(s) ? 'ach' : /card|visa|master|amex|discover|credit/.test(s) ? 'card' : s ? 'other' : 'check'; };

// ------------------------------------------------------------ importers
const IMPORTERS = {
  customers(ctx, recs) {
    const { db } = ctx;
    eachRow(ctx, recs, r => {
      const person = [r.first_name, r.last_name].filter(Boolean).join(' ');
      const name = r.name || person || r.company;
      if (!name) throw err('No customer name');
      const commercial = r.type ? /comm|business|company|gc|builder|property|contractor/i.test(r.type) : !!(r.company && !person && !r.name);
      const billing = [r.billing_address, [r.billing_city, [r.billing_state, r.billing_zip].filter(Boolean).join(' ')].filter(Boolean).join(', ')].filter(Boolean).join(', ');
      const data = {
        name: clip(name, 200), company: clip(r.company, 200), type: r.type || commercial ? (commercial ? 'commercial' : 'residential') : undefined,
        email: clip(r.email, 200), phone: clip(r.phone, 40), alt_phone: clip(r.alt_phone, 40), billing_address: clip(billing, 300),
        lead_source: clip(r.lead_source, 80), tax_exempt: r.tax_exempt ? (yes(r.tax_exempt) ? 1 : 0) : undefined,
        payment_terms_days: r.terms ? terms(r.terms) ?? undefined : undefined, notes: clip(r.notes, 5000), external_id: clip(r.external_id, 80),
      };
      const existing = findCustomer(db, { ...r, name });
      let id;
      if (existing) {
        if (ctx.options.update_existing === false) { ctx.skipped++; return; }
        // fill in what's missing; never overwrite with blanks
        const fill = Object.fromEntries(Object.entries(data).filter(([k, v]) => v != null && v !== '' && (existing[k] == null || existing[k] === '' || k === 'external_id' && !existing.external_id)));
        if (update(db, 'customers', existing.id, fill)) ctx.updated++;
        id = existing.id;
      } else {
        const created = parseDate(r.created_at);
        id = ctx.made('customer', insert(db, 'customers', { ...data, type: data.type || 'residential', ...(created ? { created_at: created + ' 12:00:00' } : {}) }));
      }
      locationFor(ctx, id, r);
    });
  },

  jobs(ctx, recs) {
    const { db } = ctx;
    const seen = new Set();
    eachRow(ctx, recs, r => {
      const number = String(r.number || '').trim();
      if (number && seen.has(number)) { ctx.skipped++; ctx.warn(r._row, `Job ${number} appears more than once; used the first row`); return; }
      if (number) seen.add(number);
      const existing = jobByNumber(db, number);
      if (existing && !ctx.options.update_existing) { ctx.skipped++; ctx.warn(r._row, `Job ${number} already exists; skipped`); return; }
      const cust = customerFor(ctx, r);
      const location_id = locationFor(ctx, cust.id, r) || (get(db, 'SELECT id FROM locations WHERE customer_id = ? ORDER BY id LIMIT 1', cust.id) || {}).id || null;
      const start = parseDateTime(r.scheduled_start, ctx.tz), end = parseDateTime(r.scheduled_end, ctx.tz, '10:00');
      const completed = parseDate(r.completed_at);
      let status = JOB_STATUS(r.status);
      if (r.status && !status) ctx.warn(r._row, `Unknown status “${r.status}”; guessed from the dates`);
      status = status || (completed ? 'completed' : start ? 'scheduled' : 'unscheduled');
      const contract = parseAmount(r.contract_amount);
      const billing = r.billing_type ? (/fix|quot|bid|lump|contract|flat/i.test(r.billing_type) ? 'fixed' : 'tm') : contract > 0 ? 'fixed' : 'tm';
      const jt = String(r.job_type || 'service').toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'service';
      const pr = String(r.priority || '').toLowerCase();
      const data = {
        customer_id: cust.id, location_id, title: clip(r.title || (r.description || '').split(/\r?\n/)[0] || r.job_type || 'Imported job', 120),
        description: clip(r.description, 5000), job_type: jt, status,
        priority: /emerg/.test(pr) ? 'emergency' : /high|urgent/.test(pr) ? 'high' : /low/.test(pr) ? 'low' : 'normal',
        scheduled_start: start, scheduled_end: end && start && end > start ? end : null, lead_source: clip(r.lead_source, 80), po_number: clip(r.po_number, 80),
        billing_type: billing, contract_amount: contract, completion_notes: clip(r.completion_notes, 5000),
        completed_at: completed ? completed + ' 17:00:00' : (['completed', 'invoiced'].includes(status) && start ? start.slice(0, 10) + ' 17:00:00' : null),
      };
      const techIds = [];
      for (const n of String(r.technician || '').split(/[,;/&|]+|\band\b/).map(s => s.trim()).filter(Boolean)) {
        const u = userByName(db, n);
        if (u) techIds.push(u.id); else ctx.warn(r._row, `No team member named “${n}” (add them in Team, then they can be assigned)`);
      }
      let id;
      if (existing) { update(db, 'jobs', existing.id, data); ctx.updated++; id = existing.id; }
      else {
        const created = parseDate(r.created_at);
        id = ctx.made('job', insert(db, 'jobs', { ...data, number: number || D.nextNumber(db, 'jobs', 'J'), ...(created ? { created_at: created + ' 12:00:00' } : {}) }));
      }
      for (const u of [...new Set(techIds)]) run(db, 'INSERT OR IGNORE INTO job_techs (job_id, user_id) VALUES (?,?)', id, u);
      // open jobs with a date go on the schedule board
      if (start && ['scheduled', 'dispatched', 'in_progress', 'on_hold'].includes(status) && ctx.H.syncSingleAppointment)
        ctx.H.syncSingleAppointment(id, start, data.scheduled_end, techIds.length ? [...new Set(techIds)] : undefined);
    });
  },

  estimates(ctx, recs) { importDocs(ctx, recs, 'estimate'); },
  invoices(ctx, recs) { importDocs(ctx, recs, 'invoice'); },

  notes(ctx, recs) {
    const { db } = ctx;
    eachRow(ctx, recs, r => {
      if (!r.note) { ctx.skipped++; return; }
      const date = parseDateTime(r.date, ctx.tz, '12:00');
      const u = userByName(db, r.author);
      const job = jobByNumber(db, r.job_number);
      if (r.job_number && !job) throw err(`Job ${r.job_number} not found (import jobs first)`);
      if (job) {
        ctx.made('job_note', insert(db, 'job_notes', { job_id: job.id, user_id: u ? u.id : null, body: clip(u || !r.author ? r.note : `${r.author}: ${r.note}`, 10000),
          ...(date ? { created_at: date.replace('T', ' ').slice(0, 19) } : {}) }));
        return;
      }
      const c = customerFor(ctx, r, { create: false });
      const line = `${date ? date.slice(0, 10) + ' ' : ''}${r.author ? r.author + ': ' : ''}${r.note}`;
      run(db, "UPDATE customers SET notes = CASE WHEN notes IS NULL OR notes = '' THEN ? ELSE notes || char(10) || ? END WHERE id = ?", line, line, c.id);
      ctx.updated++;
    });
  },

  pricebook(ctx, recs) {
    const { db } = ctx;
    eachRow(ctx, recs, r => {
      if (!r.name && !r.code) throw err('No item name');
      const existing = (r.code && get(db, 'SELECT * FROM pricebook WHERE lower(code) = ?', r.code.toLowerCase())) || (r.name && get(db, 'SELECT * FROM pricebook WHERE lower(name) = ?', r.name.toLowerCase()));
      const num = s => { const v = parseAmount(s); return v == null ? undefined : v; };
      const data = { code: clip(r.code, 60), name: clip(r.name || r.code, 200), description: clip(r.description, 2000), category: clip(r.category, 80),
        kind: kindOf(r.kind) || undefined, unit: clip(r.unit, 20), unit_cost: num(r.unit_cost), unit_price: num(r.unit_price), labor_hours: num(r.labor_hours),
        taxable: r.taxable ? (no(r.taxable) ? 0 : 1) : undefined, qty_on_hand: num(r.qty_on_hand), reorder_point: num(r.reorder_point), vendor: clip(r.vendor, 120),
        active: r.active ? (/inactive|no|false|0/i.test(r.active) ? 0 : 1) : undefined };
      if (r.kind && !data.kind) ctx.warn(r._row, `Kind “${r.kind}” not recognized; used material`);
      if (existing) { if (update(db, 'pricebook', existing.id, data)) ctx.updated++; }
      else ctx.made('pricebook', insert(db, 'pricebook', { ...Object.fromEntries(Object.entries(data).filter(([, v]) => v != null)), kind: data.kind || 'material' }));
    });
  },

  job_materials(ctx, recs) {
    const { db } = ctx;
    eachRow(ctx, recs, r => {
      const job = jobByNumber(db, r.job_number);
      if (!job) throw err(`Job ${r.job_number || '(blank)'} not found (import jobs first)`);
      const pb = (r.item_code && get(db, 'SELECT * FROM pricebook WHERE lower(code) = ?', r.item_code.toLowerCase())) || (r.item && get(db, 'SELECT * FROM pricebook WHERE lower(name) = ?', r.item.toLowerCase()));
      if (!r.item && !pb) throw err('No item');
      const qty = parseAmount(r.qty) ?? 1;
      const cost = parseAmount(r.unit_cost) ?? (pb ? pb.unit_cost : 0), price = parseAmount(r.unit_price) ?? (pb ? pb.unit_price : 0);
      const billed = r.billed ? yes(r.billed) : ['completed', 'invoiced', 'cancelled'].includes(job.status);
      ctx.made('job_material', insert(db, 'job_materials', { job_id: job.id, pricebook_id: pb ? pb.id : null, description: clip(r.item || pb.name, 300), qty, unit_cost: cost, unit_price: price,
        billable: 1, invoiced: billed ? 1 : 0, invoice_id: billed ? -1 : null, source: 'imported', cost_code_id: pb ? pb.cost_code_id : null,
        used_on: parseDate(r.date) || (job.completed_at || job.created_at || '').slice(0, 10) || new Date().toISOString().slice(0, 10) }));
    });
  },

  vendors(ctx, recs) {
    const { db } = ctx;
    eachRow(ctx, recs, r => {
      if (!r.name) throw err('No vendor name');
      const data = { name: clip(r.name, 200), contact: clip(r.contact, 120), email: clip(r.email, 200), phone: clip(r.phone, 40), address: clip(r.address, 300),
        account_number: clip(r.account_number, 80), terms_days: r.terms ? terms(r.terms) ?? undefined : undefined, notes: clip(r.notes, 2000) };
      const existing = get(db, 'SELECT * FROM vendors WHERE lower(name) = ?', r.name.toLowerCase());
      if (existing) { if (update(db, 'vendors', existing.id, Object.fromEntries(Object.entries(data).filter(([k]) => existing[k] == null || existing[k] === '')))) ctx.updated++; }
      else ctx.made('vendor', insert(db, 'vendors', Object.fromEntries(Object.entries(data).filter(([, v]) => v != null))));
    });
  },

  accounts(ctx, recs) {
    const { db } = ctx;
    const TYPE = s => {
      s = String(s || '').toLowerCase();
      return /cost of goods|cogs|cost of sales|job cost/.test(s) ? 'cogs' : /payable|liabilit|credit card|loan|accrued/.test(s) ? 'liability'
        : /income|revenue|sales/.test(s) ? 'income' : /equity|capital|draw|retained/.test(s) ? 'equity' : /expense/.test(s) ? 'expense'
        : /bank|asset|receivable|inventory|undeposited|prepaid|equipment|vehicle|depreciation/.test(s) ? 'asset' : null;
    };
    const BASE = { asset: 1000, liability: 2000, equity: 3000, income: 4000, cogs: 5000, expense: 6000 };
    eachRow(ctx, recs, r => {
      const type = TYPE(r.type);
      if (!type) throw err(`Account type “${r.type}” not recognized (use asset, liability, equity, income, cost of goods sold or expense)`);
      const name = clip(String(r.name).split(':').pop().trim(), 120);
      const byNum = r.number && get(db, 'SELECT * FROM accounts WHERE number = ?', r.number.trim());
      const existing = byNum || get(db, 'SELECT * FROM accounts WHERE lower(name) = ?', name.toLowerCase());
      if (existing) {
        if (existing.type !== type) throw err(`Account ${existing.number} ${existing.name} is ${existing.type} here, not ${type}`);
        if (byNum && existing.name.toLowerCase() !== name.toLowerCase()) ctx.warn(r._row, `Number ${existing.number} is already “${existing.name}” here; kept it. Give “${name}” another number to add it.`);
        ctx.skipped++;
        return;
      }
      let number = r.number && r.number.trim();
      if (!number) { // next free number in the type's range, in steps of 10
        const top = get(db, 'SELECT MAX(CAST(number AS INTEGER)) n FROM accounts WHERE CAST(number AS INTEGER) BETWEEN ? AND ?', BASE[type] + 800, BASE[type] + 999).n;
        number = String(top ? top + 10 : BASE[type] + 800);
        if (Number(number) > BASE[type] + 999) throw err('No free account numbers left in that range; add numbers to the file');
      }
      ctx.made('account', insert(db, 'accounts', { number, name, type, description: clip(r.description, 500) }));
    });
  },

  opening_balances(ctx, recs) {
    const { db } = ctx;
    const asOf = parseDate(ctx.options.as_of);
    if (!asOf) throw err('Set the “as of” date');
    const lines = [];
    eachRow(ctx, recs, r => {
      const a = accountFor(db, r.account);
      if (!a) throw err(`Account “${r.account}” not found (import the chart of accounts first)`);
      if (a.number === '3950') { ctx.skipped++; return; }
      let dr = parseAmount(r.debit) || 0, cr = parseAmount(r.credit) || 0;
      if (!dr && !cr && r.balance) { const b = parseAmount(r.balance) || 0; const debitNormal = ['asset', 'cogs', 'expense'].includes(a.type); if ((b > 0) === debitNormal) dr = Math.abs(b); else cr = Math.abs(b); }
      if (dr < 0) { cr -= dr; dr = 0; } if (cr < 0) { dr -= cr; cr = 0; }
      if (!dr && !cr) { ctx.skipped++; return; }
      if (['income', 'cogs', 'expense'].includes(a.type)) ctx.warn(r._row, `${a.number} ${a.name} is a profit-and-loss account; its balance counts as this year's activity`);
      lines.push({ account: a.id, debit: dr, credit: cr, memo: 'Opening balance' });
    });
    if (!lines.length) return;
    const diff = r2(lines.reduce((s, l) => s + l.debit - l.credit, 0));
    if (diff) lines.push({ account: '3950', debit: diff < 0 ? -diff : 0, credit: diff > 0 ? diff : 0, memo: 'Opening balance offset' });
    const id = A.post(db, { date: asOf, memo: `Opening balances as of ${asOf}`, source_type: 'opening', created_by: ctx.userId, lines });
    ctx.made('journal_entry', id);
    if (diff) ctx.warn(null, `Debits and credits differ by ${Math.abs(diff).toFixed(2)}; that difference went to 3950 Opening Balance Equity`);
  },

  journal(ctx, recs) {
    const { db } = ctx;
    const groups = groupBy(recs.filter(r => r.account), r => r.entry ? `e:${r.entry}` : `d:${parseDate(r.date)}`);
    eachRow(ctx, groups, rows => {
      const date = parseDate(rows[0].date);
      if (!date) throw err(`Date “${rows[0].date}” not understood`);
      const lines = rows.map(r => {
        const a = accountFor(db, r.account);
        if (!a) throw err(`Row ${r._row}: account “${r.account}” not found`);
        let dr = parseAmount(r.debit) || 0, cr = parseAmount(r.credit) || 0;
        if (!dr && !cr && r.amount) { const v = parseAmount(r.amount) || 0; if (v > 0) dr = v; else cr = -v; }
        const job = jobByNumber(db, r.job_number);
        return { account: a.id, debit: dr, credit: cr, memo: clip(r.memo, 300), job_id: job ? job.id : null };
      });
      const id = A.post(db, { date, memo: clip(`Imported${rows[0].entry ? ' entry ' + rows[0].entry : ''}${rows[0].memo ? ' · ' + rows[0].memo : ''}`, 300), source_type: 'import', created_by: ctx.userId, lines });
      if (id) ctx.made('journal_entry', id); else ctx.skipped++;
    });
  },
};

// Estimates and invoices share the shape: header fields + one or many line rows per document.
function importDocs(ctx, recs, kind) {
  const { db } = ctx;
  const table = kind === 'estimate' ? 'estimates' : 'invoices', itemsTable = table.slice(0, -1) + '_items', fk = kind + '_id';
  const s = settings(db);
  const groups = groupBy(recs, r => r.number ? `n:${r.number}` : `r:${r._row}`);
  const post = kind === 'invoice' && !!ctx.options.post_to_books;
  eachRow(ctx, groups, rows => {
    const h = rows[0];
    const number = String(h.number || '').trim();
    if (number && get(db, `SELECT 1 x FROM ${table} WHERE number = ?`, number)) { ctx.skipped++; ctx.warn(h._row, `${kind === 'estimate' ? 'Estimate' : 'Invoice'} ${number} already exists; skipped`); return; }
    const job = jobByNumber(db, h.job_number);
    if (h.job_number && !job) ctx.warn(h._row, `Job ${h.job_number} not found; imported without a job`);
    const cust = job && !h.customer_name && !h.customer_id && !h.customer_email ? get(db, 'SELECT * FROM customers WHERE id = ?', job.customer_id) : customerFor(ctx, h);
    // lines
    let lines = rows.filter(r => r.item || r.line_total || r.unit_price).map(r => {
      const qty = parseAmount(r.qty) ?? 1;
      const lt = parseAmount(r.line_total);
      const price = parseAmount(r.unit_price) ?? (lt != null && qty ? r2(lt / qty) : 0);
      const pb = r.item_code ? get(db, 'SELECT id, unit_cost, cost_code_id FROM pricebook WHERE lower(code) = ?', r.item_code.toLowerCase()) : null;
      return { description: clip(r.item || 'Item', 500), qty, unit_price: price, unit_cost: parseAmount(r.unit_cost) ?? (pb ? pb.unit_cost : 0),
        taxable: r.taxable ? (no(r.taxable) ? 0 : 1) : 1, pricebook_id: pb ? pb.id : null, cost_code_id: pb ? pb.cost_code_id : null, option: r.option || h.option || '' };
    });
    const total = parseAmount(h.total), taxAmt = parseAmount(h.tax_amount), discount = parseAmount(h.discount) || 0;
    if (!lines.length) {
      if (total == null) throw err('No line items and no total');
      lines = [{ description: clip(h.title || h.item || (kind === 'estimate' ? 'Estimate' : 'Invoice') + ' (imported total)', 500), qty: 1, unit_price: r2(total - (taxAmt || 0) + discount), unit_cost: 0, taxable: taxAmt ? 1 : 0, option: '' }];
    }
    const sub = r2(lines.reduce((s2, l) => s2 + l.qty * l.unit_price, 0)), taxable = r2(lines.filter(l => l.taxable).reduce((s2, l) => s2 + l.qty * l.unit_price, 0));
    let rate = parseRate(h.tax_rate);
    if (rate == null && taxAmt) rate = taxable ? Math.round(taxAmt / Math.max(0.01, taxable - discount * (taxable / (sub || 1))) * 1e6) / 1e4 : 0;
    if (rate == null) rate = 0;
    if (!taxAmt && rate === 0) lines.forEach(l => { l.taxable = h.taxable ? l.taxable : 0; });
    const date = parseDate(kind === 'estimate' ? h.date : h.issue_date) || new Date().toISOString().slice(0, 10);
    const base = { customer_id: cust.id, job_id: job ? job.id : null, tax_rate: rate, discount, notes: clip(h.notes, 5000), public_token: D.token(),
      number: number || D.nextNumber(db, table, kind === 'estimate' ? 'EST' : 'INV') };
    let id;
    if (kind === 'estimate') {
      const st = DOC_STATUS(h.status) || 'sent';
      id = insert(db, 'estimates', { ...base, location_id: job ? job.location_id : null, title: clip(h.title, 200), status: st === 'viewed' ? 'sent' : st,
        valid_until: parseDate(h.valid_until), terms: s.estimate_terms, created_by: ctx.userId, created_at: date + ' 12:00:00',
        sent_at: st !== 'draft' ? date + ' 12:00:00' : null, approved_at: st === 'approved' ? date + ' 12:00:00' : null, declined_at: st === 'declined' ? date + ' 12:00:00' : null });
      ctx.made('estimate', id);
      const optNames = [...new Set(lines.map(l => l.option).filter(Boolean))];
      const optIds = {};
      if (optNames.length > 4) throw err('More than four options on one estimate');
      if (optNames.length === 1) ctx.warn(h._row, `Only one option (“${optNames[0]}”) on this estimate; imported as a single price`);
      if (optNames.length >= 2) optNames.forEach((n, i) => { optIds[n] = insert(db, 'estimate_options', { estimate_id: id, name: clip(n, 60), recommended: i === 1 ? 1 : 0, sort: i }); });
      lines.forEach((l, i) => insert(db, itemsTable, { [fk]: id, pricebook_id: l.pricebook_id, description: l.description, qty: l.qty, unit_price: l.unit_price, unit_cost: l.unit_cost,
        taxable: l.taxable, cost_code_id: l.cost_code_id, sort: i, option_id: optIds[l.option] ?? null }));
      if (st === 'approved' && optNames.length >= 2) ctx.warn(h._row, 'Approved estimate with options: open it and mark which option the customer chose');
    } else {
      const due = parseDate(h.due_date) || (() => { const d = new Date(date + 'T00:00:00'); d.setDate(d.getDate() + (Number(cust.payment_terms_days ?? s.invoice_terms_days) || 0)); return d.toISOString().slice(0, 10); })();
      const isVoid = /void|cancel/i.test(h.status || ''), isDraft = /draft/i.test(h.status || '');
      id = insert(db, 'invoices', { ...base, issue_date: date, due_date: due, status: isVoid ? 'void' : isDraft ? 'draft' : 'sent', terms: s.invoice_terms,
        sent_at: isDraft ? null : date + ' 12:00:00', created_at: date + ' 12:00:00', ledger_skip: post ? 0 : 1 });
      ctx.made('invoice', id);
      lines.forEach((l, i) => insert(db, itemsTable, { [fk]: id, pricebook_id: l.pricebook_id, description: l.description, qty: l.qty, unit_price: l.unit_price, unit_cost: l.unit_cost,
        taxable: l.taxable, cost_code_id: l.cost_code_id, sort: i }));
      const C = require('./calc');
      const full = C.invoiceWithTotals(db, get(db, 'SELECT * FROM invoices WHERE id = ?', id));
      if (total != null && Math.abs(full.total - total) > 0.02) ctx.warn(h._row, `Invoice ${base.number}: lines add up to ${full.total.toFixed(2)}, file says ${total.toFixed(2)}`);
      const fileTotal = total != null ? total : full.total;
      let paid = parseAmount(h.amount_paid);
      if (paid == null && h.balance) paid = r2(fileTotal - (parseAmount(h.balance) || 0));
      if (paid == null && /paid/i.test(h.status || '') && !/partial|unpaid/i.test(h.status)) paid = fileTotal;
      if (!isVoid && paid > 0.004) {
        const pid = ctx.made('payment', insert(db, 'payments', { invoice_id: id, amount: full.total > 0 ? r2(Math.min(paid, full.total)) : r2(paid), method: METHOD(h.payment_method),
          reference: 'Imported', paid_at: parseDate(h.paid_date) || date, ledger_skip: post ? 0 : 1 }));
        if (post) A.postPayment(db, pid);
      }
      if (!isVoid && !isDraft) {
        const after = C.invoiceWithTotals(db, get(db, 'SELECT * FROM invoices WHERE id = ?', id));
        run(db, 'UPDATE invoices SET status = ? WHERE id = ?', after.balance <= 0.004 ? 'paid' : after.paid > 0 ? 'partial' : 'sent', id);
      }
      if (post) A.postInvoice(db, id);
    }
  });
}

// ------------------------------------------------------------ batches & undo
function listBatches(db) {
  return all(db, `SELECT b.*, u.name user_name FROM import_batches b LEFT JOIN users u ON u.id = b.user_id ORDER BY b.id DESC LIMIT 100`)
    .map(b => ({ ...b, warnings: JSON.parse(b.warnings || '[]'), options: JSON.parse(b.options || '{}') }));
}
const ENTITY_TABLE = { customer: 'customers', location: 'locations', job: 'jobs', estimate: 'estimates', invoice: 'invoices', payment: 'payments', job_note: 'job_notes',
  pricebook: 'pricebook', job_material: 'job_materials', vendor: 'vendors', account: 'accounts', journal_entry: 'journal_entries', attachment: 'attachments' };
function undoBatch(db, id, { removeFile } = {}) {
  const b = get(db, 'SELECT * FROM import_batches WHERE id = ?', id);
  if (!b) throw err('Import not found', 404);
  if (b.undone_at) throw err('This import was already undone');
  const recs = all(db, 'SELECT * FROM import_records WHERE batch_id = ? ORDER BY id DESC', id);
  const files = [];
  tx(db, () => {
    for (const r of recs) {
      const table = ENTITY_TABLE[r.entity];
      const row = get(db, `SELECT * FROM ${table} WHERE id = ?`, r.entity_id);
      if (!row) continue;
      if (r.entity === 'invoice') { for (const p of all(db, 'SELECT id FROM payments WHERE invoice_id = ?', row.id)) A.unpost(db, 'payment', p.id); A.unpost(db, 'invoice', row.id); }
      if (r.entity === 'payment') A.unpost(db, 'payment', row.id);
      if (r.entity === 'journal_entry') { A.assertOpen(db, row.date); A.assertNotReconciled(db, row.id); }
      if (r.entity === 'job') { run(db, 'DELETE FROM appointments WHERE job_id = ?', row.id); }
      if (r.entity === 'attachment') files.push(row.path);
      try { run(db, `DELETE FROM ${table} WHERE id = ?`, row.id); }
      catch (e) {
        if (/FOREIGN KEY/i.test(e.message)) throw err(`Can't undo: ${r.entity.replace('_', ' ')} #${row.number || row.name || row.id} from this import has been used since (for example a new job, invoice or entry was added to it). Remove that first, or leave the import in place.`, 409);
        throw e;
      }
    }
    run(db, "UPDATE import_batches SET undone_at = datetime('now') WHERE id = ?", id);
  });
  if (removeFile) for (const p of files) removeFile(p);
  return { removed: recs.length };
}

module.exports = { TYPES, describe, preview, runImport, undoBatch, listBatches, parseRows, parseDate, parseDateTime, parseAmount, autoMap, jobByNumber, findCustomer };
