'use strict';
// Database layer: SQLite via Node's built-in node:sqlite (no native deps).
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const crypto = require('node:crypto');

const SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'tech' CHECK (role IN ('admin','office','tech')),
  phone TEXT,
  title TEXT,                         -- e.g. Journeyman, Apprentice, Master
  license_number TEXT,
  hourly_wage REAL NOT NULL DEFAULT 0, -- what we pay
  burden_pct REAL NOT NULL DEFAULT 25, -- payroll taxes, WC, benefits as % of wage
  bill_rate REAL NOT NULL DEFAULT 0,   -- what we charge per hour
  color TEXT DEFAULT '#2563eb',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY,
  type TEXT NOT NULL DEFAULT 'residential' CHECK (type IN ('residential','commercial')),
  name TEXT NOT NULL,
  company TEXT,
  email TEXT,
  phone TEXT,
  alt_phone TEXT,
  billing_address TEXT,
  lead_source TEXT,
  tax_exempt INTEGER NOT NULL DEFAULT 0,
  payment_terms_days INTEGER,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS locations (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  label TEXT,
  address TEXT NOT NULL,
  city TEXT, state TEXT, zip TEXT,
  service_size TEXT,        -- e.g. 200A 1PH, 400A 3PH 208Y/120
  panel_info TEXT,          -- make/model, location of panels
  access_notes TEXT,        -- gate codes, dogs, site contact
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS pricebook (
  id INTEGER PRIMARY KEY,
  code TEXT,
  name TEXT NOT NULL,
  description TEXT,
  category TEXT,
  kind TEXT NOT NULL DEFAULT 'material' CHECK (kind IN ('material','service','labor','equipment')),
  unit TEXT DEFAULT 'ea',
  unit_cost REAL NOT NULL DEFAULT 0,
  unit_price REAL NOT NULL DEFAULT 0,
  labor_hours REAL NOT NULL DEFAULT 0,   -- flat-rate tasks: estimated hours
  taxable INTEGER NOT NULL DEFAULT 1,
  qty_on_hand REAL NOT NULL DEFAULT 0,
  reorder_point REAL NOT NULL DEFAULT 0,
  vendor TEXT,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY,
  number TEXT NOT NULL UNIQUE,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  location_id INTEGER REFERENCES locations(id),
  title TEXT NOT NULL,
  description TEXT,
  job_type TEXT NOT NULL DEFAULT 'service',
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','emergency')),
  status TEXT NOT NULL DEFAULT 'unscheduled'
    CHECK (status IN ('unscheduled','scheduled','dispatched','in_progress','on_hold','completed','invoiced','cancelled')),
  scheduled_start TEXT,
  scheduled_end TEXT,
  lead_source TEXT,
  po_number TEXT,
  contract_amount REAL,      -- for fixed-bid jobs
  budget_hours REAL,
  budget_materials REAL,
  completion_notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS job_techs (
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  PRIMARY KEY (job_id, user_id)
);

CREATE TABLE IF NOT EXISTS estimates (
  id INTEGER PRIMARY KEY,
  number TEXT NOT NULL UNIQUE,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  location_id INTEGER REFERENCES locations(id),
  job_id INTEGER REFERENCES jobs(id),
  title TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent','viewed','approved','declined','expired')),
  tax_rate REAL NOT NULL DEFAULT 0,
  discount REAL NOT NULL DEFAULT 0,
  notes TEXT,
  terms TEXT,
  valid_until TEXT,
  public_token TEXT NOT NULL UNIQUE,
  signature_name TEXT,
  sent_at TEXT, viewed_at TEXT, approved_at TEXT, declined_at TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS estimate_items (
  id INTEGER PRIMARY KEY,
  estimate_id INTEGER NOT NULL REFERENCES estimates(id) ON DELETE CASCADE,
  pricebook_id INTEGER REFERENCES pricebook(id),
  description TEXT NOT NULL,
  qty REAL NOT NULL DEFAULT 1,
  unit_price REAL NOT NULL DEFAULT 0,
  unit_cost REAL NOT NULL DEFAULT 0,
  taxable INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY,
  number TEXT NOT NULL UNIQUE,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  job_id INTEGER REFERENCES jobs(id),
  estimate_id INTEGER REFERENCES estimates(id),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent','partial','paid','void')),
  issue_date TEXT NOT NULL DEFAULT (date('now')),
  due_date TEXT,
  tax_rate REAL NOT NULL DEFAULT 0,
  discount REAL NOT NULL DEFAULT 0,
  notes TEXT,
  terms TEXT,
  public_token TEXT NOT NULL UNIQUE,
  sent_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS invoice_items (
  id INTEGER PRIMARY KEY,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  pricebook_id INTEGER REFERENCES pricebook(id),
  description TEXT NOT NULL,
  qty REAL NOT NULL DEFAULT 1,
  unit_price REAL NOT NULL DEFAULT 0,
  unit_cost REAL NOT NULL DEFAULT 0,
  taxable INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  amount REAL NOT NULL,
  method TEXT NOT NULL DEFAULT 'check',
  reference TEXT,
  paid_at TEXT NOT NULL DEFAULT (date('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS time_entries (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
  kind TEXT NOT NULL DEFAULT 'job' CHECK (kind IN ('job','travel','shop','training','pto')),
  clock_in TEXT NOT NULL,
  clock_out TEXT,
  hourly_cost REAL NOT NULL DEFAULT 0,  -- loaded cost snapshot (wage * (1+burden))
  hourly_wage REAL NOT NULL DEFAULT 0,  -- wage snapshot, for payroll
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS job_materials (
  id INTEGER PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  pricebook_id INTEGER REFERENCES pricebook(id),
  description TEXT NOT NULL,
  qty REAL NOT NULL DEFAULT 1,
  unit_cost REAL NOT NULL DEFAULT 0,
  unit_price REAL NOT NULL DEFAULT 0,
  billable INTEGER NOT NULL DEFAULT 1,
  invoiced INTEGER NOT NULL DEFAULT 0,
  source TEXT DEFAULT 'stock',    -- stock | supply_house | customer
  user_id INTEGER REFERENCES users(id),
  used_on TEXT NOT NULL DEFAULT (date('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS expenses (
  id INTEGER PRIMARY KEY,
  date TEXT NOT NULL DEFAULT (date('now')),
  category TEXT NOT NULL,
  vendor TEXT,
  description TEXT,
  amount REAL NOT NULL,
  job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL,  -- set = job cost, null = overhead
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS permits (
  id INTEGER PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  permit_number TEXT,
  jurisdiction TEXT,
  permit_type TEXT,
  status TEXT NOT NULL DEFAULT 'needed'
    CHECK (status IN ('needed','applied','issued','rough_scheduled','rough_passed','final_scheduled','passed','failed','closed')),
  applied_date TEXT, issued_date TEXT, inspection_date TEXT, expires_date TEXT,
  fee REAL NOT NULL DEFAULT 0,
  inspector TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS agreements (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  location_id INTEGER REFERENCES locations(id),
  name TEXT NOT NULL,
  price REAL NOT NULL DEFAULT 0,
  billing_frequency TEXT NOT NULL DEFAULT 'annual' CHECK (billing_frequency IN ('monthly','quarterly','annual')),
  visits_per_year INTEGER NOT NULL DEFAULT 1,
  start_date TEXT NOT NULL DEFAULT (date('now')),
  end_date TEXT,
  next_visit TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','cancelled','expired')),
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS job_notes (
  id INTEGER PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY,
  to_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',   -- sent | failed | not_configured
  error TEXT,
  related TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_jobs_sched ON jobs(scheduled_start);
CREATE INDEX IF NOT EXISTS idx_time_user ON time_entries(user_id, clock_in);
CREATE INDEX IF NOT EXISTS idx_time_job ON time_entries(job_id);
CREATE INDEX IF NOT EXISTS idx_mat_job ON job_materials(job_id);
CREATE INDEX IF NOT EXISTS idx_exp_date ON expenses(date);
CREATE INDEX IF NOT EXISTS idx_inv_date ON invoices(issue_date);
`;

const DEFAULT_SETTINGS = {
  company_name: 'All 4 You Electrical',
  company_phone: '',
  company_email: '',
  company_address: '',
  license_number: '',
  default_tax_rate: '0',
  invoice_terms_days: '30',
  estimate_valid_days: '30',
  estimate_terms: 'Estimate valid for 30 days. 50% deposit required on projects over $5,000. All work performed to current NEC and local code. Permit fees included where noted.',
  invoice_terms: 'Payment due by the date shown. A 1.5% monthly finance charge applies to past-due balances.',
  overtime_weekly_hours: '40',
  overtime_multiplier: '1.5',
  target_gross_margin: '50',
};

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pw, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(pw, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const test = crypto.scryptSync(pw, salt, 64);
  const ref = Buffer.from(hash, 'hex');
  return ref.length === test.length && crypto.timingSafeEqual(ref, test);
}
const token = () => crypto.randomBytes(24).toString('base64url');

function open(file) {
  const dbPath = file || process.env.DB_PATH || path.join(__dirname, '..', 'data', 'fieldops.db');
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA);
  const ins = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) ins.run(k, v);
  require('./migrations').migrate(db);
  return db;
}

// Helpers -----------------------------------------------------------------
function all(db, sql, ...p) { return db.prepare(sql).all(...p).map(r => ({ ...r })); }
function get(db, sql, ...p) { const r = db.prepare(sql).get(...p); return r ? { ...r } : null; }
function run(db, sql, ...p) { return db.prepare(sql).run(...p); }

// Nestable transactions (outer BEGIN, inner SAVEPOINTs).
const txDepth = new WeakMap();
function tx(db, fn) {
  const d = txDepth.get(db) || 0;
  const sp = `sp${d}`;
  db.exec(d ? `SAVEPOINT ${sp}` : 'BEGIN');
  txDepth.set(db, d + 1);
  try {
    const r = fn();
    txDepth.set(db, d);
    db.exec(d ? `RELEASE ${sp}` : 'COMMIT');
    return r;
  } catch (e) {
    txDepth.set(db, d);
    db.exec(d ? `ROLLBACK TO ${sp}; RELEASE ${sp}` : 'ROLLBACK');
    throw e;
  }
}

function nextNumber(db, table, prefix) {
  const row = get(db, `SELECT number FROM ${table} WHERE number LIKE ? ORDER BY id DESC LIMIT 1`, `${prefix}-%`);
  const n = row ? parseInt(row.number.split('-').pop(), 10) + 1 : 1001;
  return `${prefix}-${n}`;
}

function settings(db) {
  const o = {};
  for (const r of all(db, 'SELECT key, value FROM settings')) o[r.key] = r.value;
  return o;
}

module.exports = { open, all, get, run, tx, nextNumber, settings, hashPassword, verifyPassword, token };
