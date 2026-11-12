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
  // 4: exact logo red from the original artwork (#FA001C); buttons use #E0001A so white text stays readable
  db => {
    const swap = (k, from, to) => db.prepare('UPDATE settings SET value = ? WHERE key = ? AND lower(value) = ?').run(to, k, from);
    swap('brand_primary', '#d0332c', '#e0001a');
    swap('brand_accent', '#d0332c', '#fa001c');
  },
  // 5: field tools — photos/files, checklists, customer sign-off, GPS punches, equipment records
  db => {
    db.exec(`
    CREATE TABLE IF NOT EXISTS attachments (
      id INTEGER PRIMARY KEY,
      entity_type TEXT NOT NULL CHECK (entity_type IN ('job','location','equipment')),
      entity_id INTEGER NOT NULL,
      kind TEXT NOT NULL DEFAULT 'photo' CHECK (kind IN ('photo','document','signature')),
      tag TEXT,                           -- before | during | after | panel | permit | other
      filename TEXT, mime TEXT NOT NULL, size INTEGER NOT NULL DEFAULT 0,
      path TEXT NOT NULL,                 -- relative to the upload directory
      caption TEXT,
      lat REAL, lng REAL,
      user_id INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_att_entity ON attachments(entity_type, entity_id);
    CREATE TABLE IF NOT EXISTS form_templates (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      job_types TEXT NOT NULL DEFAULT '*',   -- comma list of job types, or * for every job
      items TEXT NOT NULL,                   -- JSON [{label, type: check|passfail|text|number, required}]
      required_for_completion INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      sort INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS job_forms (
      id INTEGER PRIMARY KEY,
      job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      template_id INTEGER REFERENCES form_templates(id),
      name TEXT NOT NULL,
      items TEXT NOT NULL,                   -- snapshot of the template items when attached
      answers TEXT NOT NULL DEFAULT '{}',
      required_for_completion INTEGER NOT NULL DEFAULT 0,
      completed_at TEXT, completed_by INTEGER REFERENCES users(id),
      updated_at TEXT, updated_by INTEGER REFERENCES users(id),
      UNIQUE (job_id, template_id)
    );
    CREATE TABLE IF NOT EXISTS equipment (
      id INTEGER PRIMARY KEY,
      location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
      type TEXT NOT NULL DEFAULT 'panel',
      make TEXT, model TEXT, serial TEXT,
      amps TEXT, voltage TEXT,
      install_date TEXT, warranty_until TEXT,
      installed_job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','removed')),
      notes TEXT,
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_equip_loc ON equipment(location_id);`);
    for (const c of ['in_lat', 'in_lng', 'in_acc', 'out_lat', 'out_lng', 'out_acc']) addColumn(db, 'time_entries', c, 'REAL');
    addColumn(db, 'jobs', 'signoff_name', 'TEXT');
    addColumn(db, 'jobs', 'signoff_at', 'TEXT');
    addColumn(db, 'jobs', 'signoff_attachment_id', 'INTEGER');
    addColumn(db, 'jobs', 'signoff_note', 'TEXT');

    const T = (name, types, req, items, sort) => db.prepare('INSERT INTO form_templates (name, job_types, required_for_completion, items, sort) VALUES (?,?,?,?,?)')
      .run(name, types, req, JSON.stringify(items.map(([label, type = 'check', required = 1]) => ({ label, type, required: !!required }))), sort);
    T('Job start safety', '*', 1, [
      ['PPE worn (safety glasses, gloves, arc-rated clothing as required)'],
      ['Work area hazards assessed (water, overhead lines, access, pets)'],
      ['Circuits identified; lockout/tagout applied for de-energized work'],
      ['Absence of voltage verified with a tested meter (live-dead-live)'],
      ['Customer told about any power interruption'],
    ], 1);
    T('Service call diagnostic', 'service,troubleshooting,emergency', 0, [
      ['Customer complaint confirmed', 'text'],
      ['Panel inspected for heat, damage, double taps', 'passfail'],
      ['Grounding and bonding checked', 'passfail'],
      ['GFCI / AFCI devices tested', 'passfail'],
      ['Voltage at panel L1–N (V)', 'number', 0],
      ['Voltage at panel L2–N (V)', 'number', 0],
      ['Findings and recommendation', 'text'],
      ['Upgrades / safety recommendations offered to customer', 'check', 0],
    ], 2);
    T('Panel upgrade / service change', 'install,remodel,new_construction', 0, [
      ['Permit posted on site'],
      ['Utility disconnect / reconnect coordinated'],
      ['Grounding electrode system installed or verified', 'passfail'],
      ['Main bonding jumper installed at service equipment only'],
      ['Neutrals and grounds separated in subpanels', 'passfail'],
      ['Terminations torqued to manufacturer spec (calibrated tool)'],
      ['AFCI / GFCI protection installed where required', 'passfail'],
      ['Surge protection installed or offered (NEC 230.67)', 'check', 0],
      ['Working clearance maintained (30 in wide × 36 in deep)', 'passfail'],
      ['Panel directory filled out and legible'],
      ['Rough / final inspection result', 'passfail', 0],
    ], 3);
    T('EV charger install', 'ev_charger', 0, [
      ['Load calculation done — available capacity (A)', 'number'],
      ['Circuit sized at 125% of continuous load'],
      ['GFCI protection provided where required', 'passfail'],
      ['Disconnect within sight where required'],
      ['Charger commissioned and tested'],
      ['Customer shown operation / app setup', 'check', 0],
    ], 4);
    T('Generator / interlock', 'generator', 0, [
      ['Interlock is listed for this panel'],
      ['Inlet and cord rated for generator output'],
      ['Generator breaker sized and labeled'],
      ['Customer trained on transfer procedure'],
      ['Carbon monoxide / placement warning given'],
    ], 5);
    T('Final walkthrough', '*', 1, [
      ['All new circuits tested and labeled'],
      ['Covers, plates and dead fronts installed'],
      ['Work area cleaned up, debris removed'],
      ['Before / after photos taken'],
      ['Walkthrough completed with customer', 'check', 0],
    ], 9);
  },
  // 6: separate billing for quoted (fixed-price) jobs and time & material jobs
  db => {
    addColumn(db, 'jobs', 'billing_type', "TEXT NOT NULL DEFAULT 'tm' CHECK (billing_type IN ('fixed','tm'))");
    // fixed price
    addColumn(db, 'jobs', 'retainage_pct', 'REAL NOT NULL DEFAULT 0');
    addColumn(db, 'jobs', 'percent_complete', 'REAL');          // office estimate; null = use cost-to-cost
    // time & material
    addColumn(db, 'jobs', 'labor_rate', 'REAL');                // null = each tech's bill rate
    addColumn(db, 'jobs', 'material_markup_pct', 'REAL');       // null = price book sell price
    addColumn(db, 'jobs', 'trip_charge', 'REAL');
    addColumn(db, 'jobs', 'trip_invoice_id', 'INTEGER');
    addColumn(db, 'jobs', 'nte_amount', 'REAL');                // not-to-exceed cap
    addColumn(db, 'jobs', 'bill_travel', 'INTEGER NOT NULL DEFAULT 1');
    // what got billed where (so nothing is billed twice and billed items are locked)
    addColumn(db, 'time_entries', 'invoice_id', 'INTEGER');
    addColumn(db, 'time_entries', 'billable', 'INTEGER NOT NULL DEFAULT 1');
    addColumn(db, 'job_materials', 'invoice_id', 'INTEGER');
    addColumn(db, 'expenses', 'billable', 'INTEGER NOT NULL DEFAULT 0');
    addColumn(db, 'expenses', 'invoice_id', 'INTEGER');
    addColumn(db, 'invoices', 'billing_kind', "TEXT NOT NULL DEFAULT 'standard'");   // standard|deposit|milestone|progress|final|tm
    addColumn(db, 'invoices', 'retainage', 'REAL NOT NULL DEFAULT 0');                // retainage withheld on this invoice (positive)
    addColumn(db, 'invoices', 'period_to', 'TEXT');
    addColumn(db, 'estimates', 'change_order', 'INTEGER NOT NULL DEFAULT 0');
    db.exec(`CREATE TABLE IF NOT EXISTS billing_milestones (
      id INTEGER PRIMARY KEY,
      job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      pct REAL,                 -- share of contract, or…
      amount REAL,              -- …a fixed amount
      invoice_id INTEGER,
      sort INTEGER NOT NULL DEFAULT 0
    )`);
    // existing data: jobs with a contract amount are quoted jobs; materials already flagged invoiced stay billed
    db.exec("UPDATE jobs SET billing_type = 'fixed' WHERE contract_amount IS NOT NULL AND contract_amount > 0");
    db.exec("UPDATE job_materials SET invoice_id = -1 WHERE invoiced = 1 AND invoice_id IS NULL");
    // T&M time already invoiced the old way (any non-void invoice on the job before this upgrade) counts as billed
    db.exec(`UPDATE time_entries SET invoice_id = -1 WHERE invoice_id IS NULL AND job_id IN
      (SELECT j.id FROM jobs j WHERE j.billing_type = 'tm' AND EXISTS (SELECT 1 FROM invoices i WHERE i.job_id = j.id AND i.status != 'void'))`);
    const ins = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
    for (const [k, v] of Object.entries({ tm_default_markup_pct: '', tm_billing_increment_minutes: '15', tm_material_taxable: '1', fixed_lines_taxable: '0' })) ins.run(k, v);
  },
  // 7: good / better / best options on estimates
  db => {
    db.exec(`CREATE TABLE IF NOT EXISTS estimate_options (
      id INTEGER PRIMARY KEY,
      estimate_id INTEGER NOT NULL REFERENCES estimates(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT,
      recommended INTEGER NOT NULL DEFAULT 0,
      sort INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_estopt ON estimate_options(estimate_id);`);
    addColumn(db, 'estimate_items', 'option_id', 'INTEGER');          // null = included in every option
    addColumn(db, 'estimates', 'approved_option_id', 'INTEGER');
  },
  // 8: techs build estimates in the field, with price guardrails and office review
  db => {
    addColumn(db, 'estimates', 'review_status', 'TEXT');        // null | pending | approved | rejected
    addColumn(db, 'estimates', 'review_reasons', 'TEXT');       // JSON list of why it needs review
    addColumn(db, 'estimates', 'review_note', 'TEXT');
    addColumn(db, 'estimates', 'reviewed_by', 'INTEGER');
    addColumn(db, 'estimates', 'reviewed_at', 'TEXT');
    const ins = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
    for (const [k, v] of Object.entries({ tech_estimates: '1', tech_see_costs: '0', tech_max_discount_pct: '10', tech_min_margin_pct: '35', tech_custom_lines: 'review' })) ins.run(k, v);
  },
  // 9: data import from other systems (CSV), with an undo log per batch
  db => {
    db.exec(`CREATE TABLE IF NOT EXISTS import_batches (
      id INTEGER PRIMARY KEY,
      type TEXT NOT NULL,
      filename TEXT,
      options TEXT,
      created_count INTEGER NOT NULL DEFAULT 0,
      updated_count INTEGER NOT NULL DEFAULT 0,
      skipped_count INTEGER NOT NULL DEFAULT 0,
      warnings TEXT,
      user_id INTEGER REFERENCES users(id),
      undone_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS import_records (
      id INTEGER PRIMARY KEY,
      batch_id INTEGER NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
      entity TEXT NOT NULL,
      entity_id INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_imprec ON import_records(batch_id);`);
    addColumn(db, 'customers', 'external_id', 'TEXT');          // the customer's id in the old system, for linking later files
    db.exec('CREATE INDEX IF NOT EXISTS idx_cust_ext ON customers(external_id)');
    addColumn(db, 'invoices', 'ledger_skip', 'INTEGER NOT NULL DEFAULT 0');   // history from the old system: not posted to the books
    addColumn(db, 'payments', 'ledger_skip', 'INTEGER NOT NULL DEFAULT 0');
    db.prepare("INSERT OR IGNORE INTO accounts (number, name, type, subtype, description) VALUES ('3950', 'Opening Balance Equity', 'equity', 'opening', 'Offset for opening balances brought over from the old books. Should be zero once conversion is finished.')").run();
  },
  // 10: cancelling jobs and estimates (with a reason); estimates gain a 'cancelled' status
  Object.assign(function (db) {
    for (const t of ['jobs', 'estimates']) { addColumn(db, t, 'cancelled_at', 'TEXT'); addColumn(db, t, 'cancel_reason', 'TEXT'); }
    rebuildTable(db, 'estimates', sql => sql.replace("'declined','expired')", "'declined','expired','cancelled')"));
  }, { foreignKeysOff: true }),
  // 11: the invoice form has always had a Title box, but the table had no column for it, so saving failed
  db => {
    addColumn(db, 'invoices', 'title', 'TEXT');
    db.exec("UPDATE invoices SET title = (SELECT e.title FROM estimates e WHERE e.id = invoices.estimate_id) WHERE title IS NULL AND estimate_id IS NOT NULL");
    db.exec("UPDATE invoices SET title = (SELECT j.title FROM jobs j WHERE j.id = invoices.job_id) WHERE title IS NULL AND job_id IS NOT NULL");
  },
  // 12: service addresses remember map coordinates and when they were checked against a map/address database
  db => {
    addColumn(db, 'locations', 'lat', 'REAL');
    addColumn(db, 'locations', 'lng', 'REAL');
    addColumn(db, 'locations', 'verified_at', 'TEXT');
  },
  // 13: per-employee permissions; commercial projects (project fields, % complete by cost code, daily logs)
  db => {
    addColumn(db, 'users', 'permissions', 'TEXT');               // JSON of switches that differ from the role's defaults
    addColumn(db, 'jobs', 'is_project', 'INTEGER NOT NULL DEFAULT 0');
    addColumn(db, 'jobs', 'project_manager_id', 'INTEGER REFERENCES users(id)');
    addColumn(db, 'jobs', 'foreman_id', 'INTEGER REFERENCES users(id)');
    addColumn(db, 'jobs', 'start_date', 'TEXT');
    addColumn(db, 'jobs', 'end_date', 'TEXT');                    // target substantial completion
    addColumn(db, 'jobs', 'gc_contact', 'TEXT');                  // GC / owner's site contact
    addColumn(db, 'jobs', 'gc_phone', 'TEXT');
    addColumn(db, 'jobs', 'gc_email', 'TEXT');
    addColumn(db, 'job_budgets', 'percent_complete', 'REAL');     // entered by the PM/foreman per cost code
    db.exec(`
    CREATE TABLE IF NOT EXISTS daily_logs (
      id INTEGER PRIMARY KEY,
      job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      log_date TEXT NOT NULL,
      user_id INTEGER REFERENCES users(id),
      weather TEXT,
      crew_count INTEGER,
      work_performed TEXT,
      delays TEXT,
      safety TEXT,
      visitors TEXT,
      deliveries TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_dlog_job ON daily_logs(job_id, log_date);`);
    db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('project_require_cost_code', '1')").run();
    db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('project_clock_any', '1')").run();
  },
  // 14: the A4YE cost code list (same codes as the A4Y Time Clock and job tracker) replaces the placeholder codes;
  //     links for syncing the A4Y Time Clock (employee id, job #, entry id)
  db => {
    for (const [col, def] of [['division', 'TEXT'], ['division_name', 'TEXT'], ['phase', 'TEXT'], ['details', 'TEXT']]) addColumn(db, 'cost_codes', col, def);
    const ins = db.prepare(`INSERT INTO cost_codes (code, name, kind, active, division, division_name, phase, details) VALUES (?,?,?,1,?,?,?,?)
      ON CONFLICT(code) DO UPDATE SET division = excluded.division, division_name = excluded.division_name, phase = excluded.phase, details = COALESCE(cost_codes.details, excluded.details)`);
    for (const [code, name, div, divName, phase, details] of require('./a4ye_codes'))
      ins.run(code, name, div === '80' ? 'labor' : 'both', div, divName, phase, details || null);
    // retire the placeholder codes nobody has used yet (used ones stay, so history keeps its codes)
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(t => t.name)
      .filter(t => t !== 'cost_codes' && db.prepare(`PRAGMA table_info(${t})`).all().some(c => c.name === 'cost_code_id'));
    for (const [code] of DEFAULT_COST_CODES) {
      const row = db.prepare('SELECT id FROM cost_codes WHERE code = ?').get(code);
      if (row && !tables.some(t => db.prepare(`SELECT 1 x FROM ${t} WHERE cost_code_id = ? LIMIT 1`).get(row.id))) db.prepare('UPDATE cost_codes SET active = 0 WHERE id = ?').run(row.id);
    }
    addColumn(db, 'users', 'timeclock_id', 'TEXT');           // Employee ID in the A4Y Time Clock (e.g. E0A1B2C3D4F)
    addColumn(db, 'jobs', 'timeclock_job', 'TEXT');           // Job # in the A4Y Time Clock (e.g. 2417)
    addColumn(db, 'time_entries', 'external_id', 'TEXT');     // Entry ID in the A4Y Time Clock
    addColumn(db, 'time_entries', 'ext_job', 'TEXT');         // the time clock's Job #, kept so entries link once a job gets that number
    addColumn(db, 'time_entries', 'source', 'TEXT');
    addColumn(db, 'time_entries', 'labor_amount', 'REAL');    // the time clock's own Labor Amt (unburdened pay)
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_te_ext ON time_entries(external_id) WHERE external_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_te_extjob ON time_entries(ext_job) WHERE ext_job IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_jobs_tc ON jobs(timeclock_job);`);
    for (const [k, v] of [['timezone', 'America/Boise'], ['timeclock_url', ''], ['timeclock_key', ''], ['timeclock_last_sync', ''], ['timeclock_auto', '1'], ['burden_default_pct', '35'], ['project_target_margin', '18']])
      db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run(k, v);
  },
  // 15: pick list lines typed in by hand (not from the price book) carry their own unit, cost and a note
  db => {
    addColumn(db, 'pick_list_lines', 'unit', 'TEXT');
    addColumn(db, 'pick_list_lines', 'unit_cost', 'REAL');
    addColumn(db, 'pick_list_lines', 'note', 'TEXT');
    addColumn(db, 'pick_list_lines', 'added_by', 'INTEGER REFERENCES users(id)');
  },
  // 16: Ply Public API — which Ply line each of our pick list / PO lines became; connection settings
  db => {
    addColumn(db, 'pick_list_lines', 'ply_line_id', 'TEXT');
    addColumn(db, 'po_lines', 'ply_line_id', 'TEXT');
    for (const t of ['pick_lists', 'purchase_orders']) { addColumn(db, t, 'ply_id', 'TEXT'); addColumn(db, t, 'ply_synced_at', 'TEXT'); }
    addColumn(db, 'purchase_orders', 'ply_status', 'TEXT');
    for (const [k, v] of [['ply_env', 'production'], ['ply_from_location_id', ''], ['ply_po_location_id', ''], ['ply_auto_sync', '1'], ['ply_last_sync', ''], ['ply_locations', '[]']])
      db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run(k, v);
  },
  // 17: commercial projects in the A4YE job tracker format — schedule of values, pay applications (AIA G702/G703),
  //     change order log fields, RFI & submittal log, safety & quality log, milestones
  db => {
    db.exec(`
    CREATE TABLE IF NOT EXISTS sov_lines (
      id INTEGER PRIMARY KEY,
      job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      division TEXT NOT NULL,                 -- MOB, 01-90, or CO
      co_estimate_id INTEGER REFERENCES estimates(id) ON DELETE SET NULL,
      description TEXT NOT NULL,
      calc_value REAL NOT NULL DEFAULT 0,     -- suggested (from budget / CO)
      override_value REAL,                    -- what you typed, when it differs
      notes TEXT,
      sort INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_sov_job ON sov_lines(job_id, sort);
    CREATE TABLE IF NOT EXISTS pay_apps (
      id INTEGER PRIMARY KEY,
      job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      app_no INTEGER NOT NULL,
      period_to TEXT NOT NULL,
      retainage_pct REAL,                     -- override for this app (else the job's)
      status TEXT NOT NULL DEFAULT 'Draft' CHECK (status IN ('Draft','Submitted','Approved','Paid','Short Paid','Disputed')),
      date_submitted TEXT, date_paid TEXT, amount_paid REAL,
      customer_ref TEXT, notes TEXT,
      invoice_id INTEGER REFERENCES invoices(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(job_id, app_no)
    );
    CREATE TABLE IF NOT EXISTS pay_app_lines (
      id INTEGER PRIMARY KEY,
      pay_app_id INTEGER NOT NULL REFERENCES pay_apps(id) ON DELETE CASCADE,
      sov_line_id INTEGER NOT NULL REFERENCES sov_lines(id) ON DELETE CASCADE,
      work_this_period REAL NOT NULL DEFAULT 0,
      stored_balance REAL NOT NULL DEFAULT 0, -- materials presently stored at the end of this period
      UNIQUE(pay_app_id, sov_line_id)
    );
    CREATE TABLE IF NOT EXISTS rfis (
      id INTEGER PRIMARY KEY,
      job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      type TEXT NOT NULL DEFAULT 'RFI',
      number TEXT, subject TEXT NOT NULL, spec_section TEXT,
      cost_code_id INTEGER REFERENCES cost_codes(id),
      date_sent TEXT, date_needed TEXT, date_returned TEXT,
      status TEXT NOT NULL DEFAULT 'Open', ball_in_court TEXT,
      cost_impact REAL, sched_impact_days REAL,
      co_estimate_id INTEGER REFERENCES estimates(id) ON DELETE SET NULL,
      notes TEXT, created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS safety_items (
      id INTEGER PRIMARY KEY,
      job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      date TEXT NOT NULL, type TEXT NOT NULL, description TEXT NOT NULL,
      severity TEXT, reported_by TEXT, corrective_action TEXT, owner TEXT,
      due_date TEXT, closed_date TEXT, recordable INTEGER NOT NULL DEFAULT 0, lost_time_days REAL,
      ref TEXT, created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS project_milestones (
      id INTEGER PRIMARY KEY,
      job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      name TEXT NOT NULL, phase TEXT,
      baseline_date TEXT, forecast_date TEXT, actual_date TEXT,
      owner TEXT, critical INTEGER NOT NULL DEFAULT 0, impacts_billing INTEGER NOT NULL DEFAULT 0,
      notes TEXT, sort INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_rfi_job ON rfis(job_id); CREATE INDEX IF NOT EXISTS idx_sq_job ON safety_items(job_id); CREATE INDEX IF NOT EXISTS idx_ms_job ON project_milestones(job_id);`);
    // change order log fields (a change order is an estimate with change_order = 1)
    for (const [c, d] of [['co_type', 'TEXT'], ['co_status', 'TEXT'], ['co_days_added', 'REAL'], ['co_reference', 'TEXT'], ['co_submitted_at', 'TEXT']]) addColumn(db, 'estimates', c, d);
    addColumn(db, 'jobs', 'mobilization_pct', 'REAL');
    for (const [k, v] of [['co_overhead_pct', '18'], ['co_profit_pct', '15'], ['material_tax_pct', '6'], ['default_retainage_pct', '5'], ['mobilization_pct', '5']])
      db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run(k, v);
  },
  // 18: project schedule (the workbook's Schedule & Gantt tab) and the Cover tab's crew planning settings
  db => {
    db.exec(`
    CREATE TABLE IF NOT EXISTS project_tasks (
      id INTEGER PRIMARY KEY,
      job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      phase TEXT, area TEXT,
      name TEXT NOT NULL,
      cost_code_id INTEGER REFERENCES cost_codes(id) ON DELETE SET NULL,
      start_date TEXT, finish_date TEXT,
      predecessor_id INTEGER REFERENCES project_tasks(id) ON DELETE SET NULL,
      responsible TEXT,
      budget_hours REAL,
      pct_complete REAL,                      -- 0-100; NULL = not updated yet
      on_hold INTEGER NOT NULL DEFAULT 0,
      notes TEXT,
      sort INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_task_job ON project_tasks(job_id);`);
    addColumn(db, 'jobs', 'schedule_start', 'TEXT');
    for (const [k, v] of [['sched_hours_per_day', '8'], ['sched_days_per_week', '5'], ['sched_crew_availability', '0.92'], ['sched_max_crew', '10']])
      db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run(k, v);
  },
  // 19: weekly % complete history (the workbook's Weekly History) — captured automatically each week, the PM can type over it
  db => {
    db.exec(`
    CREATE TABLE IF NOT EXISTS project_progress (
      id INTEGER PRIMARY KEY,
      job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      week_ending TEXT NOT NULL,              -- Sunday
      pct_complete REAL NOT NULL,             -- 0-100
      source TEXT NOT NULL DEFAULT 'auto' CHECK (source IN ('auto', 'manual')),
      note TEXT,
      updated_by INTEGER REFERENCES users(id),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (job_id, week_ending)
    );`);
  },
  // 20: bi-weekly project reports — the narrative typed per period, and a frozen copy of the numbers once issued
  db => {
    db.exec(`
    CREATE TABLE IF NOT EXISTS project_reports (
      id INTEGER PRIMARY KEY,
      job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      period_end TEXT NOT NULL,
      progress TEXT, plan_next TEXT, issues TEXT, decisions TEXT, notes TEXT,
      prepared_by INTEGER REFERENCES users(id),
      status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'issued')),
      issued_at TEXT, issued_by INTEGER REFERENCES users(id),
      snapshot TEXT,                          -- JSON of the report's numbers at issue
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (job_id, period_end)
    );`);
  },
  // 21: the quote's line items as imported (the workbook's Estimate Import → Import Quote), the source of a project's budget
  db => {
    db.exec(`
    CREATE TABLE IF NOT EXISTS project_quote_lines (
      id INTEGER PRIMARY KEY,
      job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      import_id TEXT NOT NULL,                -- one paste / file = one import
      source TEXT,                            -- scope tab or quote file
      area TEXT, cost_code_id INTEGER REFERENCES cost_codes(id), cost_type TEXT,
      phase_code TEXT, tag TEXT, description TEXT NOT NULL,
      qty REAL, unit TEXT, material_unit REAL, hours_unit REAL,
      ext_material REAL NOT NULL DEFAULT 0, ext_hours REAL NOT NULL DEFAULT 0, ext_labor REAL NOT NULL DEFAULT 0, ext_total REAL NOT NULL DEFAULT 0,
      notes TEXT, sort INTEGER NOT NULL DEFAULT 0,
      imported_by INTEGER REFERENCES users(id), imported_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_quote_job ON project_quote_lines(job_id);`);
  },
  // 22: emailing an issued bi-weekly report — a public link (GC copy only) and who it was last sent to
  db => {
    for (const [c, d] of [['public_token', 'TEXT'], ['sent_at', 'TEXT'], ['sent_to', 'TEXT'], ['viewed_at', 'TEXT']]) addColumn(db, 'project_reports', c, d);
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_report_token ON project_reports(public_token)');
  },
  // 23: job workbook import — expenses brought in as history (already in the real books) skip the ledger like old-system invoices do
  db => {
    addColumn(db, 'expenses', 'ledger_skip', 'INTEGER NOT NULL DEFAULT 0');
  },
  // 24: estimate visits — a scheduled visit belongs to a job or to an estimate (a walkthrough to price the work)
  Object.assign(function (db) {
    rebuildTable(db, 'appointments', sql => sql.replace(/job_id INTEGER NOT NULL REFERENCES jobs\(id\) ON DELETE CASCADE,/,
      'job_id INTEGER REFERENCES jobs(id) ON DELETE CASCADE,\n      estimate_id INTEGER REFERENCES estimates(id) ON DELETE CASCADE,'));
    db.exec('CREATE INDEX IF NOT EXISTS idx_appt_estimate ON appointments(estimate_id)');
  }, { foreignKeysOff: true }),
  // 25: appointment confirmation emails — when the customer was told, which address, and the time they were told
  db => {
    for (const [c, d] of [['confirmed_at', 'TEXT'], ['confirmed_to', 'TEXT'], ['confirmed_start', 'TEXT'], ['confirmed_end', 'TEXT'], ['confirm_count', 'INTEGER NOT NULL DEFAULT 0']]) addColumn(db, 'appointments', c, d);
  },
  // 26: push notifications — each phone/browser that has said yes, and what was sent
  db => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS push_devices (
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('web','apns','fcm')),
        token TEXT NOT NULL UNIQUE,
        keys TEXT,
        platform TEXT,
        user_agent TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_ok_at TEXT,
        last_error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_push_devices_user ON push_devices(user_id);
      CREATE TABLE IF NOT EXISTS push_log (
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        body TEXT,
        url TEXT,
        devices INTEGER NOT NULL DEFAULT 0,
        sent INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );`);
  },
  // 27: weekly KPIs — owners (a person's page), metric definitions, weekly values, cause/fix notes, submissions
  db => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS kpi_owners (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        sort INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS kpi_metrics (
        id TEXT PRIMARY KEY,
        owner_id INTEGER NOT NULL REFERENCES kpi_owners(id),
        section TEXT NOT NULL DEFAULT '',
        metric TEXT NOT NULL,
        unit TEXT NOT NULL DEFAULT '#',
        better TEXT NOT NULL DEFAULT 'Info' CHECK (better IN ('Higher','Lower','Info')),
        target REAL,
        input TEXT NOT NULL DEFAULT 'manual' CHECK (input IN ('manual','calc','auto')),
        rule TEXT,
        source TEXT,
        how TEXT,
        target_note TEXT,
        active INTEGER NOT NULL DEFAULT 1,
        sort INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS kpi_values (
        week TEXT NOT NULL,
        metric_id TEXT NOT NULL REFERENCES kpi_metrics(id) ON DELETE CASCADE,
        value REAL,
        origin TEXT NOT NULL DEFAULT 'manual',
        user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        by_label TEXT,
        at TEXT NOT NULL,
        PRIMARY KEY (week, metric_id)
      );
      CREATE TABLE IF NOT EXISTS kpi_notes (
        id INTEGER PRIMARY KEY,
        week TEXT NOT NULL,
        metric_id TEXT NOT NULL REFERENCES kpi_metrics(id) ON DELETE CASCADE,
        cause TEXT NOT NULL DEFAULT '',
        fix TEXT NOT NULL DEFAULT '',
        user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        by_label TEXT,
        at TEXT NOT NULL,
        UNIQUE (week, metric_id, at, cause)
      );
      CREATE INDEX IF NOT EXISTS idx_kpi_notes_week ON kpi_notes(week, metric_id);
      CREATE TABLE IF NOT EXISTS kpi_submissions (
        id INTEGER PRIMARY KEY,
        week TEXT NOT NULL,
        owner_id INTEGER NOT NULL REFERENCES kpi_owners(id) ON DELETE CASCADE,
        user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        by_label TEXT,
        at TEXT NOT NULL,
        UNIQUE (week, owner_id, at, by_label)
      );`);
  },
  // 28: Manager role — office work plus the company-wide views (KPIs for everyone), below admin (no Team/Settings/Import)
  Object.assign(function (db) {
    rebuildTable(db, 'users', sql => sql.replace(/CHECK \(role IN \('admin',\s*'office',\s*'tech'\)\)/, "CHECK (role IN ('admin','manager','office','tech'))"));
  }, { foreignKeysOff: true }),
  // 29: KPIs like the Command Center web app — an auto number kept beside a typed replacement, and why it was replaced
  db => {
    for (const [c, d] of [['auto_value', 'REAL'], ['auto_at', 'TEXT'], ['auto_source', 'TEXT'], ['reason', 'TEXT']]) addColumn(db, 'kpi_values', c, d);
  },
  // 30: KPIs — every entry kept (the drill-down's "entries this week"), extra items owners report, and where an auto
  // number came from (its link, note and line items)
  db => {
    for (const [c, d] of [['auto_link', 'TEXT'], ['auto_note', 'TEXT'], ['detail', 'TEXT']]) addColumn(db, 'kpi_values', c, d);
    db.exec(`
      CREATE TABLE IF NOT EXISTS kpi_value_log (
        id INTEGER PRIMARY KEY,
        week TEXT NOT NULL,
        metric_id TEXT NOT NULL REFERENCES kpi_metrics(id) ON DELETE CASCADE,
        value REAL,
        origin TEXT NOT NULL,
        reason TEXT,
        user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        by_label TEXT,
        at TEXT NOT NULL,
        UNIQUE (week, metric_id, at, by_label, origin)
      );
      CREATE INDEX IF NOT EXISTS idx_kpi_log_week ON kpi_value_log(week, metric_id);
      CREATE TABLE IF NOT EXISTS kpi_extras (
        id INTEGER PRIMARY KEY,
        week TEXT NOT NULL,
        owner_id INTEGER NOT NULL REFERENCES kpi_owners(id) ON DELETE CASCADE,
        item TEXT NOT NULL,
        value TEXT,
        explanation TEXT NOT NULL,
        user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        by_label TEXT,
        at TEXT NOT NULL,
        UNIQUE (week, owner_id, item, at)
      );`);
  },
  // 31: a log of scheduled visits moved to a different time (the KPI "cancellations / reschedules" count reads it)
  db => {
    db.exec(`CREATE TABLE IF NOT EXISTS appointment_moves (
      id INTEGER PRIMARY KEY,
      appointment_id INTEGER,
      job_id INTEGER,
      from_start TEXT,
      to_start TEXT,
      user_id INTEGER,
      at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_appt_moves_at ON appointment_moves(at);`);
  },
  // 32: imported invoices didn't mark their finished job invoiced, so paid jobs sat on "Ready to invoice"
  db => {
    db.exec(`UPDATE jobs SET status = 'invoiced' WHERE status = 'completed' AND id IN (
      SELECT i.job_id FROM invoices i JOIN import_records r ON r.entity = 'invoice' AND r.entity_id = i.id
      JOIN import_batches b ON b.id = r.batch_id AND b.undone_at IS NULL
      WHERE i.job_id IS NOT NULL AND i.status NOT IN ('void', 'draft'))`);
  },
  // 33: estimating dashboard (commercial bid log)
  db => {
    db.exec(`
    CREATE TABLE IF NOT EXISTS bid_gcs (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE COLLATE NOCASE,
      active INTEGER NOT NULL DEFAULT 1,
      sort INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS bids (
      id INTEGER PRIMARY KEY,
      bid_number TEXT UNIQUE,
      project_name TEXT NOT NULL,
      due_date TEXT,
      due_time TEXT,
      submitted_date TEXT,
      bid_value REAL,
      status TEXT NOT NULL DEFAULT 'estimating' CHECK (status IN ('estimating','waiting','in_progress','awarded','lost','no_bid')),
      notes TEXT,
      checked_in_at TEXT,
      job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS bid_gc_links (
      bid_id INTEGER NOT NULL REFERENCES bids(id) ON DELETE CASCADE,
      gc_id INTEGER NOT NULL REFERENCES bid_gcs(id) ON DELETE CASCADE,
      PRIMARY KEY (bid_id, gc_id)
    );`);
  },
  // 34: several contacts per vendor (counter rep, outside sales, AP...). Existing contact/email/phone become the first one.
  db => {
    db.exec(`CREATE TABLE IF NOT EXISTS vendor_contacts (
      id INTEGER PRIMARY KEY,
      vendor_id INTEGER NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
      name TEXT,
      role TEXT,
      email TEXT,
      phone TEXT,
      gets_pos INTEGER NOT NULL DEFAULT 0,
      notes TEXT,
      sort INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_vendor_contacts ON vendor_contacts(vendor_id);
    INSERT INTO vendor_contacts (vendor_id, name, email, phone, gets_pos)
      SELECT id, NULLIF(TRIM(contact), ''), NULLIF(TRIM(email), ''), NULLIF(TRIM(phone), ''), CASE WHEN NULLIF(TRIM(email), '') IS NULL THEN 0 ELSE 1 END
      FROM vendors WHERE COALESCE(TRIM(contact), '') != '' OR COALESCE(TRIM(email), '') != '';`);
  },
  // 35: plan takeoffs by Claude for bids; a bid is commercial or residential
  db => {
    addColumn(db, 'bids', 'job_kind', 'TEXT');
    db.exec(`CREATE TABLE IF NOT EXISTS takeoffs (
      id INTEGER PRIMARY KEY,
      bid_id INTEGER NOT NULL REFERENCES bids(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('commercial','residential')),
      status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','done','error')),
      file_path TEXT NOT NULL,
      filename TEXT,
      notes TEXT,
      result TEXT,
      lines TEXT,
      error TEXT,
      model TEXT,
      input_tokens INTEGER,
      output_tokens INTEGER,
      applied_at TEXT,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_takeoffs_bid ON takeoffs(bid_id);`);
  },
  // 36: estimate assumptions per takeoff (quote-workbook model) and the proposal letter draft
  db => {
    addColumn(db, 'takeoffs', 'assumptions', 'TEXT');
    addColumn(db, 'takeoffs', 'proposal', 'TEXT');
  },
  // 37: a takeoff can read several files (plan sets, specs, addenda, photos)
  db => { addColumn(db, 'takeoffs', 'files', 'TEXT'); },
  // 38: a takeoff can wait for its files ('pending') while the browser uploads them one at a time
  Object.assign(function (db) {
    rebuildTable(db, 'takeoffs', sql => sql.replace("CHECK (status IN ('running','done','error'))", "CHECK (status IN ('pending','running','done','error'))"));
  }, { foreignKeysOff: true }),
  // 39: on hold needs a reason and a follow-up date (shown on the schedule, sent as a calendar invite)
  db => {
    for (const [c, d] of [['hold_reason', 'TEXT'], ['hold_follow_up', 'TEXT'], ['hold_at', 'TEXT'], ['hold_by', 'INTEGER'], ['hold_seq', 'INTEGER NOT NULL DEFAULT 0']]) addColumn(db, 'jobs', c, d);
    db.exec('CREATE INDEX IF NOT EXISTS idx_jobs_hold_follow_up ON jobs(hold_follow_up)');
  },
  // 40: an on-hold follow-up is a task for someone (default: Settings → Jobs on hold)
  db => { addColumn(db, 'jobs', 'hold_assignee', 'INTEGER'); db.exec('UPDATE jobs SET hold_assignee = hold_by WHERE hold_assignee IS NULL AND hold_by IS NOT NULL'); },
  // 41: calls (and texts, emails sent outside the app, meetings) logged by hand on a customer, job, estimate or bid;
  //     shown next to the emails the app sent (outbox.related)
  db => {
    db.exec(`CREATE TABLE IF NOT EXISTS comm_log (
      id INTEGER PRIMARY KEY,
      kind TEXT NOT NULL DEFAULT 'call' CHECK (kind IN ('call','text','email','meeting')),
      direction TEXT NOT NULL DEFAULT 'out' CHECK (direction IN ('in','out')),
      customer_id INTEGER REFERENCES customers(id) ON DELETE CASCADE,
      job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
      estimate_id INTEGER REFERENCES estimates(id) ON DELETE SET NULL,
      bid_id INTEGER REFERENCES bids(id) ON DELETE CASCADE,
      contact TEXT,
      phone TEXT,
      outcome TEXT,
      body TEXT,
      duration_min INTEGER,
      occurred_at TEXT NOT NULL,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_comm_customer ON comm_log(customer_id);
    CREATE INDEX IF NOT EXISTS idx_comm_job ON comm_log(job_id);
    CREATE INDEX IF NOT EXISTS idx_comm_estimate ON comm_log(estimate_id);
    CREATE INDEX IF NOT EXISTS idx_comm_bid ON comm_log(bid_id);
    CREATE INDEX IF NOT EXISTS idx_outbox_related ON outbox(related);`);
  },
  // 42: attendance — scheduled time off, called in sick, absent, in late, left early (schedule + KPI tracker)
  db => {
    db.exec(`CREATE TABLE IF NOT EXISTS attendance (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('time_off','sick','absent','late','left_early')),
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      hours REAL,
      minutes INTEGER,
      paid INTEGER NOT NULL DEFAULT 0,
      no_call INTEGER NOT NULL DEFAULT 0,
      reason TEXT,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_attendance_dates ON attendance(start_date, end_date);
    CREATE INDEX IF NOT EXISTS idx_attendance_user ON attendance(user_id);`);
  },
  // 43: en route — when the tech left, the arrival time they gave, and whether the customer was told
  db => {
    for (const [c, d] of [['en_route_at', 'TEXT'], ['eta_at', 'TEXT'], ['on_way_notice', 'TEXT']]) addColumn(db, 'appointments', c, d);
  },
  // 44: techs start pick lists from the field — who asked for it
  db => { addColumn(db, 'pick_lists', 'created_by', 'INTEGER REFERENCES users(id) ON DELETE SET NULL'); },
  // 45: sales pipeline (Salesforce-style): lead status, owner, next step and expected value / close date
  db => {
    for (const [c, d] of [['lead_status', 'TEXT'], ['lead_status_at', 'TEXT'], ['owner_id', 'INTEGER'], ['next_step', 'TEXT'], ['next_step_date', 'TEXT'], ['est_value', 'REAL'], ['lost_reason', 'TEXT']]) addColumn(db, 'customers', c, d);
    for (const [c, d] of [['owner_id', 'INTEGER'], ['next_step', 'TEXT'], ['next_step_date', 'TEXT'], ['close_date', 'TEXT'], ['lost_reason', 'TEXT']]) addColumn(db, 'estimates', c, d);
    for (const [c, d] of [['pipeline_owner_id', 'INTEGER'], ['next_step', 'TEXT'], ['next_step_date', 'TEXT']]) addColumn(db, 'jobs', c, d);
  },
  // 46: POs created in Ply for a job are imported and logged on the job
  db => { addColumn(db, 'purchase_orders', 'source', 'TEXT'); addColumn(db, 'purchase_orders', 'ply_number', 'TEXT'); db.exec('CREATE INDEX IF NOT EXISTS idx_po_ply ON purchase_orders(ply_id)'); },
  // 47: time-off requests from anyone on the team: pending until an approver approves or denies
  db => {
    for (const [c, d] of [['status', "TEXT NOT NULL DEFAULT 'approved'"], ['requested_by', 'INTEGER'], ['decided_by', 'INTEGER'], ['decided_at', 'TEXT'], ['decision_note', 'TEXT']]) addColumn(db, 'attendance', c, d);
  },
  // 48: a pick list remembers its status in Ply (shown on the job)
  db => { addColumn(db, 'pick_lists', 'ply_status', 'TEXT'); addColumn(db, 'pick_lists', 'ply_completed_at', 'TEXT'); },
];

// SQLite can't alter a CHECK constraint, so copy the table under the new definition.
// Must run with foreign keys off (see migrate), or dropping the old table would cascade-delete child rows.
function rebuildTable(db, table, edit) {
  const def = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table).sql;
  const next = edit(def);
  if (next === def) return;
  const extras = db.prepare("SELECT sql FROM sqlite_master WHERE tbl_name = ? AND type IN ('index','trigger') AND sql IS NOT NULL").all(table).map(r => r.sql);
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => `"${c.name}"`).join(', ');
  db.exec(next.replace(/^CREATE TABLE\s+(IF NOT EXISTS\s+)?("?)\w+\2/i, `CREATE TABLE ${table}__new`));
  db.exec(`INSERT INTO ${table}__new (${cols}) SELECT ${cols} FROM ${table}`);
  db.exec(`DROP TABLE ${table}`);
  db.exec(`ALTER TABLE ${table}__new RENAME TO ${table}`);
  for (const x of extras) db.exec(x);
}

function migrate(db) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
  const row = db.prepare('SELECT version FROM schema_version').get();
  let v = row ? row.version : 0;
  if (!row) db.prepare('INSERT INTO schema_version (version) VALUES (0)').run();
  while (v < MIGRATIONS.length) {
    const m = MIGRATIONS[v];
    if (m.foreignKeysOff) db.exec('PRAGMA foreign_keys = OFF');   // only takes effect outside a transaction
    db.exec('BEGIN');
    try {
      m(db);
      if (m.foreignKeysOff) {
        const broken = db.prepare('PRAGMA foreign_key_check').all();
        if (broken.length) throw new Error(`Migration ${v + 1} left ${broken.length} broken reference(s), e.g. ${JSON.stringify(broken[0])}`);
      }
      v++; db.prepare('UPDATE schema_version SET version = ?').run(v); db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    finally { if (m.foreignKeysOff) db.exec('PRAGMA foreign_keys = ON'); }
  }
}

module.exports = { migrate, CATEGORY_ACCOUNTS, DEFAULT_COST_CODES };
