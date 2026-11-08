'use strict';
// Versioned schema upgrades. Each migration runs once, in order, inside a transaction.
// Never edit a shipped migration — add a new one.

function hasColumn(db, table, col) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === col);
}
function addColumn(db, table, col, def) {
  if (!hasColumn(db, table, col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
}

const DEFAULT_COST_CODES = [
  ['100', 'Mobilization & Layout', 'labor'],
  ['200', 'Temporary Power', 'both'],
  ['300', 'Underground & Site', 'both'],
  ['400', 'Rough-in', 'both'],
  ['500', 'Service & Distribution', 'both'],
  ['600', 'Trim & Devices', 'both'],
  ['700', 'Lighting & Controls', 'both'],
  ['750', 'Low Voltage / Data', 'both'],
  ['800', 'Service Call / Troubleshooting', 'both'],
  ['850', 'EV Chargers & Generators', 'both'],
  ['900', 'Punch List & Warranty', 'both'],
  ['950', 'Travel', 'labor'],
  ['960', 'Equipment Rental', 'other'],
  ['970', 'Subcontract', 'other'],
  ['980', 'Permits & Inspections', 'other'],
  ['990', 'Shop / Non-billable', 'labor'],
];

// [number, name, type, subtype]
const DEFAULT_ACCOUNTS = [
  ['1000', 'Checking', 'asset', 'bank'],
  ['1050', 'Savings', 'asset', 'bank'],
  ['1100', 'Undeposited Funds', 'asset', 'bank'],
  ['1200', 'Accounts Receivable', 'asset', 'ar'],
  ['1300', 'Inventory — Materials', 'asset', 'inventory'],
  ['1400', 'Prepaid Expenses', 'asset', null],
  ['1500', 'Vehicles & Equipment', 'asset', 'fixed'],
  ['1550', 'Accumulated Depreciation', 'asset', 'fixed'],
  ['2000', 'Accounts Payable', 'liability', 'ap'],
  ['2050', 'Business Credit Card', 'liability', 'credit_card'],
  ['2100', 'Accrued Payroll & Burden', 'liability', 'payroll'],
  ['2200', 'Sales Tax Payable', 'liability', 'sales_tax'],
  ['2300', 'Customer Deposits', 'liability', null],
  ['2500', 'Vehicle & Equipment Loans', 'liability', null],
  ['3000', "Owner's Equity", 'equity', null],
  ['3100', 'Owner Draws', 'equity', null],
  ['3900', 'Retained Earnings', 'equity', 'retained'],
  ['4000', 'Revenue — Residential', 'income', null],
  ['4100', 'Revenue — Commercial', 'income', null],
  ['4200', 'Revenue — Service Agreements', 'income', null],
  ['4900', 'Other Income', 'income', null],
  ['5000', 'Direct Labor', 'cogs', 'labor'],
  ['5100', 'Job Materials', 'cogs', 'materials'],
  ['5200', 'Subcontractors', 'cogs', null],
  ['5300', 'Equipment Rental', 'cogs', null],
  ['5400', 'Permits & Fees', 'cogs', null],
  ['5500', 'Other Job Costs', 'cogs', null],
  ['5900', 'Inventory Adjustments', 'cogs', null],
  ['6000', 'Indirect Labor (shop, training, PTO)', 'expense', 'labor'],
  ['6100', 'Rent', 'expense', null],
  ['6150', 'Utilities', 'expense', null],
  ['6200', 'Insurance', 'expense', null],
  ['6300', 'Vehicles & Fuel', 'expense', null],
  ['6350', 'Tools & Small Equipment', 'expense', null],
  ['6400', 'Software & Phones', 'expense', null],
  ['6500', 'Marketing', 'expense', null],
  ['6600', 'Office & Admin', 'expense', null],
  ['6650', 'Licenses & Training', 'expense', null],
  ['6700', 'Professional Services', 'expense', null],
  ['6800', 'Bank & Card Fees', 'expense', null],
  ['6900', 'Depreciation', 'expense', null],
  ['6950', 'Other Expense', 'expense', null],
];

// expense category -> [account if overhead, account if tied to a job]
const CATEGORY_ACCOUNTS = {
  'Materials (supply house)': ['5100', '5100'], 'Subcontractor': ['5200', '5200'], 'Equipment rental': ['5300', '5300'],
  'Permits & fees': ['5400', '5400'], 'Dump/disposal': ['5500', '5500'], 'Rent': ['6100', '6100'], 'Utilities': ['6150', '6150'],
  'Insurance': ['6200', '6200'], 'Vehicles & fuel': ['6300', '6300'], 'Tools & equipment': ['6350', '6350'], 'Software & phones': ['6400', '6400'],
  'Marketing': ['6500', '6500'], 'Office & admin': ['6600', '6600'], 'Licenses & training': ['6650', '6650'], 'Professional services': ['6700', '6700'],
  'Bank & card fees': ['6800', '6800'], 'Other': ['6950', '5500'],
};

const MIGRATIONS = [
  // 1: scheduling appointments, cost codes, budgets, purchasing, accounting, integrations
  db => {
    db.exec(`
    CREATE TABLE IF NOT EXISTS appointments (
      id INTEGER PRIMARY KEY,
      job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      start TEXT NOT NULL,
      end TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','dispatched','en_route','on_site','done','cancelled')),
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS appointment_techs (
      appointment_id INTEGER NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id),
      PRIMARY KEY (appointment_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_appt_start ON appointments(start);
    CREATE INDEX IF NOT EXISTS idx_appt_job ON appointments(job_id);

    CREATE TABLE IF NOT EXISTS cost_codes (
      id INTEGER PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'both' CHECK (kind IN ('labor','material','both','other')),
      active INTEGER NOT NULL DEFAULT 1,
      ply_code TEXT
    );
    CREATE TABLE IF NOT EXISTS job_budgets (
      id INTEGER PRIMARY KEY,
      job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      cost_code_id INTEGER NOT NULL REFERENCES cost_codes(id),
      budget_hours REAL NOT NULL DEFAULT 0,
      budget_material REAL NOT NULL DEFAULT 0,
      budget_other REAL NOT NULL DEFAULT 0,
      UNIQUE (job_id, cost_code_id)
    );

    CREATE TABLE IF NOT EXISTS vendors (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      contact TEXT, email TEXT, phone TEXT, address TEXT,
      account_number TEXT,
      terms_days INTEGER NOT NULL DEFAULT 30,
      default_account_id INTEGER,
      ply_vendor_id TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS purchase_orders (
      id INTEGER PRIMARY KEY,
      number TEXT NOT NULL UNIQUE,
      vendor_id INTEGER NOT NULL REFERENCES vendors(id),
      job_id INTEGER REFERENCES jobs(id),
      status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','partial','received','cancelled')),
      deliver_to TEXT NOT NULL DEFAULT 'job' CHECK (deliver_to IN ('job','shop','will_call')),
      order_date TEXT NOT NULL DEFAULT (date('now')),
      expected_date TEXT,
      tax REAL NOT NULL DEFAULT 0,
      shipping REAL NOT NULL DEFAULT 0,
      notes TEXT,
      ply_id TEXT, ply_status TEXT, ply_synced_at TEXT,
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS po_lines (
      id INTEGER PRIMARY KEY,
      po_id INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
      pricebook_id INTEGER REFERENCES pricebook(id),
      description TEXT NOT NULL,
      qty REAL NOT NULL DEFAULT 1,
      qty_received REAL NOT NULL DEFAULT 0,
      unit_cost REAL NOT NULL DEFAULT 0,
      cost_code_id INTEGER REFERENCES cost_codes(id),
      sort INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS po_receipts (
      id INTEGER PRIMARY KEY,
      po_line_id INTEGER NOT NULL REFERENCES po_lines(id) ON DELETE CASCADE,
      qty REAL NOT NULL,
      received_at TEXT NOT NULL DEFAULT (date('now')),
      job_material_id INTEGER,
      user_id INTEGER REFERENCES users(id),
      source TEXT DEFAULT 'manual'
    );
    CREATE TABLE IF NOT EXISTS pick_lists (
      id INTEGER PRIMARY KEY,
      number TEXT NOT NULL UNIQUE,
      job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','picking','picked','delivered','cancelled')),
      needed_by TEXT,
      assigned_to INTEGER REFERENCES users(id),
      notes TEXT,
      ply_id TEXT, ply_synced_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS pick_list_lines (
      id INTEGER PRIMARY KEY,
      pick_list_id INTEGER NOT NULL REFERENCES pick_lists(id) ON DELETE CASCADE,
      pricebook_id INTEGER REFERENCES pricebook(id),
      description TEXT NOT NULL,
      qty REAL NOT NULL DEFAULT 1,
      qty_picked REAL NOT NULL DEFAULT 0,
      cost_code_id INTEGER REFERENCES cost_codes(id),
      job_material_id INTEGER
    );

    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY,
      number TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('asset','liability','equity','income','cogs','expense')),
      subtype TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      description TEXT
    );
    CREATE TABLE IF NOT EXISTS journal_entries (
      id INTEGER PRIMARY KEY,
      date TEXT NOT NULL,
      memo TEXT,
      source_type TEXT NOT NULL DEFAULT 'manual',
      source_id INTEGER,
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_je_source ON journal_entries(source_type, source_id);
    CREATE INDEX IF NOT EXISTS idx_je_date ON journal_entries(date);
    CREATE TABLE IF NOT EXISTS journal_lines (
      id INTEGER PRIMARY KEY,
      entry_id INTEGER NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
      account_id INTEGER NOT NULL REFERENCES accounts(id),
      debit REAL NOT NULL DEFAULT 0,
      credit REAL NOT NULL DEFAULT 0,
      memo TEXT,
      job_id INTEGER, cost_code_id INTEGER, customer_id INTEGER, vendor_id INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_jl_account ON journal_lines(account_id);
    CREATE INDEX IF NOT EXISTS idx_jl_entry ON journal_lines(entry_id);

    CREATE TABLE IF NOT EXISTS bills (
      id INTEGER PRIMARY KEY,
      vendor_id INTEGER NOT NULL REFERENCES vendors(id),
      po_id INTEGER REFERENCES purchase_orders(id),
      vendor_invoice TEXT,
      bill_date TEXT NOT NULL DEFAULT (date('now')),
      due_date TEXT,
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','partial','paid','void')),
      memo TEXT,
      ply_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS bill_lines (
      id INTEGER PRIMARY KEY,
      bill_id INTEGER NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
      account_id INTEGER NOT NULL REFERENCES accounts(id),
      description TEXT,
      amount REAL NOT NULL,
      job_id INTEGER REFERENCES jobs(id),
      cost_code_id INTEGER REFERENCES cost_codes(id),
      job_material_id INTEGER
    );
    CREATE TABLE IF NOT EXISTS bill_payments (
      id INTEGER PRIMARY KEY,
      bill_id INTEGER NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
      amount REAL NOT NULL,
      paid_at TEXT NOT NULL DEFAULT (date('now')),
      method TEXT NOT NULL DEFAULT 'check',
      account_id INTEGER REFERENCES accounts(id),
      reference TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS integration_log (
      id INTEGER PRIMARY KEY,
      provider TEXT NOT NULL,
      direction TEXT NOT NULL,
      event TEXT NOT NULL,
      status TEXT NOT NULL,
      detail TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );`);

    addColumn(db, 'time_entries', 'cost_code_id', 'INTEGER REFERENCES cost_codes(id)');
    addColumn(db, 'time_entries', 'appointment_id', 'INTEGER REFERENCES appointments(id) ON DELETE SET NULL');
    addColumn(db, 'job_materials', 'cost_code_id', 'INTEGER REFERENCES cost_codes(id)');
    addColumn(db, 'job_materials', 'po_line_id', 'INTEGER');
    addColumn(db, 'expenses', 'cost_code_id', 'INTEGER REFERENCES cost_codes(id)');
    addColumn(db, 'expenses', 'account_id', 'INTEGER REFERENCES accounts(id)');
    addColumn(db, 'expenses', 'paid_from_account_id', 'INTEGER REFERENCES accounts(id)');
    addColumn(db, 'estimate_items', 'cost_code_id', 'INTEGER REFERENCES cost_codes(id)');
    addColumn(db, 'invoice_items', 'cost_code_id', 'INTEGER REFERENCES cost_codes(id)');
    addColumn(db, 'pricebook', 'cost_code_id', 'INTEGER REFERENCES cost_codes(id)');
    addColumn(db, 'pricebook', 'ply_item_id', 'TEXT');
    addColumn(db, 'pricebook', 'vendor_id', 'INTEGER REFERENCES vendors(id)');
    addColumn(db, 'payments', 'deposit_account_id', 'INTEGER REFERENCES accounts(id)');
    addColumn(db, 'jobs', 'ply_id', 'TEXT');

    const cc = db.prepare('INSERT OR IGNORE INTO cost_codes (code, name, kind) VALUES (?,?,?)');
    for (const c of DEFAULT_COST_CODES) cc.run(...c);
    const ac = db.prepare('INSERT OR IGNORE INTO accounts (number, name, type, subtype) VALUES (?,?,?,?)');
    for (const a of DEFAULT_ACCOUNTS) ac.run(...a);

    // Existing scheduled jobs become one appointment each, crewed by the job's techs.
    const jobs = db.prepare('SELECT id, scheduled_start, scheduled_end, status FROM jobs WHERE scheduled_start IS NOT NULL').all();
    for (const j of jobs) {
      if (db.prepare('SELECT 1 FROM appointments WHERE job_id = ?').get(j.id)) continue;
      const end = j.scheduled_end || new Date(new Date(j.scheduled_start).getTime() + 2 * 3600e3).toISOString();
      const status = ['completed', 'invoiced'].includes(j.status) ? 'done' : j.status === 'cancelled' ? 'cancelled' : j.status === 'in_progress' ? 'on_site' : 'scheduled';
      const aid = Number(db.prepare('INSERT INTO appointments (job_id, start, end, status) VALUES (?,?,?,?)').run(j.id, j.scheduled_start, end, status).lastInsertRowid);
      for (const t of db.prepare('SELECT user_id FROM job_techs WHERE job_id = ?').all(j.id))
        db.prepare('INSERT OR IGNORE INTO appointment_techs (appointment_id, user_id) VALUES (?,?)').run(aid, t.user_id);
    }

    const ins = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
    for (const [k, v] of Object.entries({
      brand_primary: '#0b2a4a', brand_accent: '#f5b400', brand_sidebar: '#0b1f36', logo_url: '',
      books_closed_through: '', default_deposit_account: '1000', default_paid_from_account: '1000',
      ply_enabled: '0', ply_api_base: '', ply_api_key: '', ply_webhook_secret: '',
      ply_path_po: '/purchase-orders', ply_path_pick_list: '/pick-lists', ply_path_job: '/jobs', ply_path_items: '/items',
      day_start_hour: '6', day_end_hour: '19',
    })) ins.run(k, v);
  },
  // 2: All 4 You Electrical brand (red on black). Leaves colors alone if someone already customized them.
  db => {
    const set = (k, v, ifIn) => {
      const cur = db.prepare('SELECT value FROM settings WHERE key = ?').get(k);
      if (!cur) db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(k, v);
      else if (ifIn.includes(cur.value || '')) db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(v, k);
    };
    set('brand_primary', '#d0332c', ['', '#0b2a4a']);
    set('brand_accent', '#d0332c', ['', '#f5b400']);
    set('brand_sidebar', '#000000', ['', '#0b1f36']);
    set('logo_url', '/brand/a4y-logo.png', ['']);
    set('company_tagline', 'Powered by people. Built All 4 You.', ['']);
  },
  // 3: banking — statement imports, transaction matching, categorization rules, reconciliations
  db => {
    db.exec(`
    CREATE TABLE IF NOT EXISTS bank_imports (
      id INTEGER PRIMARY KEY,
      account_id INTEGER NOT NULL REFERENCES accounts(id),
      filename TEXT, rows INTEGER NOT NULL DEFAULT 0, added INTEGER NOT NULL DEFAULT 0, duplicates INTEGER NOT NULL DEFAULT 0,
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS bank_transactions (
      id INTEGER PRIMARY KEY,
      account_id INTEGER NOT NULL REFERENCES accounts(id),
      import_id INTEGER REFERENCES bank_imports(id) ON DELETE SET NULL,
      date TEXT NOT NULL,
      amount REAL NOT NULL,              -- + money in, − money out (as the bank shows it)
      description TEXT,
      reference TEXT,                     -- check number / bank reference
      fit_id TEXT NOT NULL,               -- bank's unique id, or a hash, for de-duplication
      status TEXT NOT NULL DEFAULT 'unmatched' CHECK (status IN ('unmatched','matched','excluded')),
      journal_line_id INTEGER,            -- the ledger line this bank line is matched to
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (account_id, fit_id)
    );
    CREATE INDEX IF NOT EXISTS idx_banktx_acct ON bank_transactions(account_id, status, date);
    CREATE TABLE IF NOT EXISTS bank_rules (
      id INTEGER PRIMARY KEY,
      match_text TEXT NOT NULL,           -- case-insensitive "description contains"
      direction TEXT NOT NULL DEFAULT 'out' CHECK (direction IN ('in','out','any')),
      account_id INTEGER NOT NULL REFERENCES accounts(id),
      category TEXT, vendor TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS reconciliations (
      id INTEGER PRIMARY KEY,
      account_id INTEGER NOT NULL REFERENCES accounts(id),
      statement_date TEXT NOT NULL,
      start_date TEXT,                    -- first reconciliation only: earlier lines are part of the opening balance
      beginning_balance REAL NOT NULL DEFAULT 0,
      statement_balance REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress','completed')),
      completed_at TEXT, completed_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    -- re-posting a source deletes its old lines: release any bank match on them
    CREATE TRIGGER IF NOT EXISTS trg_jl_delete_unmatch AFTER DELETE ON journal_lines BEGIN
      UPDATE bank_transactions SET status = 'unmatched', journal_line_id = NULL WHERE journal_line_id = OLD.id;
    END;`);
    addColumn(db, 'journal_lines', 'cleared', 'INTEGER NOT NULL DEFAULT 0');
    addColumn(db, 'journal_lines', 'reconciliation_id', 'INTEGER');
    const r = db.prepare('INSERT INTO bank_rules (match_text, direction, account_id, category, vendor) SELECT ?, ?, id, ?, ? FROM accounts WHERE number = ?');
    for (const [t, acct, cat, v] of [['SHELL', '6300', 'Vehicles & fuel', 'Shell'], ['CHEVRON', '6300', 'Vehicles & fuel', 'Chevron'], ['HOME DEPOT', '5100', 'Materials (supply house)', 'Home Depot'],
      ['LOWES', '5100', 'Materials (supply house)', "Lowe's"], ['VERIZON', '6400', 'Software & phones', 'Verizon'], ['GOOGLE ADS', '6500', 'Marketing', 'Google Ads'], ['SERVICE FEE', '6800', 'Bank & card fees', 'Bank']])
      r.run(t, 'out', cat, v, acct);
  },
];

function migrate(db) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
  const row = db.prepare('SELECT version FROM schema_version').get();
  let v = row ? row.version : 0;
  if (!row) db.prepare('INSERT INTO schema_version (version) VALUES (0)').run();
  while (v < MIGRATIONS.length) {
    db.exec('BEGIN');
    try { MIGRATIONS[v](db); v++; db.prepare('UPDATE schema_version SET version = ?').run(v); db.exec('COMMIT'); }
    catch (e) { db.exec('ROLLBACK'); throw e; }
  }
}

module.exports = { migrate, CATEGORY_ACCOUNTS, DEFAULT_COST_CODES };
