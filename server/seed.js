'use strict';
// Loads realistic demo data for an electrical contractor. Usage: npm run seed
// Refuses to run against a database that already has users unless --force is passed.
const fs = require('node:fs');
const path = require('node:path');
const D = require('./db');
const C = require('./calc');

const LEADS = ['Google', 'Referral', 'Repeat', 'Yelp', 'Website'];

function seed(db) {
  const { run, get } = D;
  const ins = (table, o) => Number(run(db, `INSERT INTO ${table} (${Object.keys(o).join(',')}) VALUES (${Object.keys(o).map(() => '?').join(',')})`, ...Object.values(o)).lastInsertRowid);
  const day = (offset, hour = 8, min = 0) => { const d = new Date(); d.setHours(hour, min, 0, 0); d.setDate(d.getDate() + offset); return d.toISOString(); };
  const date = offset => day(offset).slice(0, 10);
  const rate = u => C.r2(u.hourly_wage * (1 + u.burden_pct / 100));

  run(db, "UPDATE settings SET value = '7' WHERE key = 'default_tax_rate'");
  run(db, "UPDATE settings SET value = '(555) 410-4400' WHERE key = 'company_phone'");
  run(db, "UPDATE settings SET value = 'office@example.com' WHERE key = 'company_email'");
  run(db, "UPDATE settings SET value = '100 Main St, Springfield' WHERE key = 'company_address'");
  run(db, "UPDATE settings SET value = 'EC-0000000' WHERE key = 'license_number'");

  const pw = D.hashPassword('password123');
  const users = [
    { name: 'Owner Admin', email: 'admin@example.com', role: 'admin', title: 'Master Electrician', hourly_wage: 0, burden_pct: 0, bill_rate: 145, color: '#7c3aed' },
    { name: 'Office Manager', email: 'office@example.com', role: 'office', title: 'Dispatcher', hourly_wage: 24, burden_pct: 20, bill_rate: 0, color: '#64748b' },
    { name: 'Mike Torres', email: 'mike@example.com', role: 'tech', title: 'Journeyman', hourly_wage: 38, burden_pct: 28, bill_rate: 125, color: '#2563eb' },
    { name: 'Dana Brooks', email: 'dana@example.com', role: 'tech', title: 'Journeyman', hourly_wage: 36, burden_pct: 28, bill_rate: 125, color: '#059669' },
    { name: 'Sam Lee', email: 'sam@example.com', role: 'tech', title: 'Apprentice', hourly_wage: 22, burden_pct: 28, bill_rate: 85, color: '#d97706' },
  ].map(u => ({ ...u, id: ins('users', { ...u, password_hash: pw }) }));
  const [, , mike, dana, sam] = users;

  const pb = {};
  const items = [
    ['SVC-DIAG', 'Service call & diagnostic', 'service', 'Service', 'ea', 0, 129, 1, 0],
    ['LAB-HR', 'Electrical labor (per hour)', 'labor', 'Labor', 'hr', 0, 125, 1, 0],
    ['PNL-200', '200A panel upgrade (main breaker, 40 space)', 'service', 'Panels & Service', 'ea', 850, 3400, 10, 1],
    ['PNL-SUB100', '100A subpanel install', 'service', 'Panels & Service', 'ea', 380, 1450, 5, 1],
    ['EV-L2', 'Level 2 EV charger circuit (up to 50 ft, 60A)', 'service', 'EV & Generators', 'ea', 260, 1250, 4, 1],
    ['GEN-INT', 'Generator interlock kit + inlet', 'service', 'EV & Generators', 'ea', 210, 895, 3, 1],
    ['SURGE-WH', 'Whole-home surge protector', 'service', 'Panels & Service', 'ea', 95, 425, 1, 1],
    ['GFCI-REP', 'Replace receptacle with GFCI', 'service', 'Devices', 'ea', 18, 165, 0.5, 1],
    ['CAN-6', '6" LED recessed light, new work', 'service', 'Lighting', 'ea', 22, 195, 0.75, 1],
    ['FAN-INST', 'Ceiling fan install (existing box rated)', 'service', 'Lighting', 'ea', 8, 225, 1.25, 1],
    ['CKT-20', 'New 20A dedicated circuit (up to 50 ft)', 'service', 'Circuits', 'ea', 65, 485, 2.5, 1],
    ['MAT-122', '12/2 NM-B wire (250 ft)', 'material', 'Wire', 'roll', 118, 185, 0, 1],
    ['MAT-142', '14/2 NM-B wire (250 ft)', 'material', 'Wire', 'roll', 84, 135, 0, 1],
    ['MAT-GFCI', '20A GFCI receptacle', 'material', 'Devices', 'ea', 17.5, 32, 0, 1],
    ['MAT-AFCI', '20A AFCI breaker', 'material', 'Breakers', 'ea', 44, 79, 0, 1],
    ['MAT-1P20', '20A single-pole breaker', 'material', 'Breakers', 'ea', 6.5, 14, 0, 1],
    ['MAT-EMT34', '3/4" EMT conduit (10 ft)', 'material', 'Conduit', 'stick', 9.8, 18, 0, 1],
    ['MAT-BOX', 'Old-work single gang box', 'material', 'Boxes', 'ea', 1.2, 4, 0, 1],
    ['PERMIT', 'Permit & inspection fee (pass-through)', 'service', 'Permits', 'ea', 0, 175, 0, 0],
  ];
  for (const [code, name, kind, category, unit, cost, price, hrs, taxable] of items)
    pb[code] = ins('pricebook', { code, name, kind, category, unit, unit_cost: cost, unit_price: price, labor_hours: hrs, taxable,
      qty_on_hand: kind === 'material' ? 20 : 0, reorder_point: kind === 'material' ? 8 : 0, vendor: kind === 'material' ? 'City Electric Supply' : null });
  run(db, 'UPDATE pricebook SET qty_on_hand = 3 WHERE id = ?', pb['MAT-AFCI']);

  const cust = (o, loc) => { const id = ins('customers', o); const lid = ins('locations', { customer_id: id, ...loc }); return { id, lid }; };
  const smith = cust({ type: 'residential', name: 'Jordan Smith', email: 'jordan@example.com', phone: '(555) 201-3344', lead_source: 'Google' },
    { address: '42 Oak Ln', city: 'Springfield', state: 'IL', zip: '62704', service_size: '100A 1PH', panel_info: 'Federal Pacific Stab-Lok in garage', access_notes: 'Side gate code 1234' });
  const garcia = cust({ type: 'residential', name: 'Ana Garcia', email: 'ana@example.com', phone: '(555) 201-9921', lead_source: 'Referral' },
    { address: '815 Elm St', city: 'Springfield', state: 'IL', zip: '62702', service_size: '200A 1PH', panel_info: 'Square D QO, basement' });
  const plaza = cust({ type: 'commercial', name: 'Ray Patel', company: 'Northgate Plaza LLC', email: 'facilities@example.com', phone: '(555) 300-1200', lead_source: 'Repeat', payment_terms_days: 45 },
    { label: 'Retail center', address: '1200 Northgate Blvd', city: 'Springfield', state: 'IL', zip: '62711', service_size: '800A 3PH 208Y/120', panel_info: 'MDP in rear electrical room', access_notes: 'Check in with property manager' });
  const cafe = cust({ type: 'commercial', name: 'Lee Chen', company: 'Bluebird Cafe', email: 'bluebird@example.com', phone: '(555) 300-7781', lead_source: 'Yelp' },
    { address: '9 Market Sq', city: 'Springfield', state: 'IL', zip: '62701', service_size: '400A 3PH 208Y/120' });

  const job = (o, techs) => {
    const id = ins('jobs', { number: D.nextNumber(db, 'jobs', 'J'), ...o });
    for (const t of techs) run(db, 'INSERT INTO job_techs (job_id, user_id) VALUES (?,?)', id, t.id);
    return id;
  };
  const time = (u, jobId, start, hours, kind = 'job') => ins('time_entries', { user_id: u.id, job_id: jobId, kind, clock_in: start,
    clock_out: new Date(new Date(start).getTime() + hours * 3600000).toISOString(), hourly_cost: rate(u), hourly_wage: u.hourly_wage });
  const mat = (jobId, code, qty, u, offset) => { const p = get(db, 'SELECT * FROM pricebook WHERE id = ?', pb[code]);
    ins('job_materials', { job_id: jobId, pricebook_id: p.id, description: p.name, qty, unit_cost: p.unit_cost, unit_price: p.unit_price, user_id: u.id, used_on: date(offset), invoiced: 1 }); };
  const doc = (table, itemsTable, fk, o, lines) => {
    const prefix = table === 'estimates' ? 'EST' : 'INV';
    const id = ins(table, { number: D.nextNumber(db, table, prefix), public_token: D.token(), ...o });
    lines.forEach(([code, qty, priceOverride], i) => { const p = get(db, 'SELECT * FROM pricebook WHERE id = ?', pb[code]);
      ins(itemsTable, { [fk]: id, pricebook_id: p.id, description: p.name, qty, unit_price: priceOverride ?? p.unit_price, unit_cost: p.unit_cost, taxable: p.taxable, sort: i }); });
    return id;
  };

  // 1. Completed & paid panel upgrade (residential)
  const j1 = job({ customer_id: smith.id, location_id: smith.lid, title: '200A panel upgrade — replace FPE panel', job_type: 'install', status: 'invoiced',
    scheduled_start: day(-12, 8), scheduled_end: day(-12, 17), completed_at: day(-12, 17), contract_amount: 3575, budget_hours: 10, lead_source: 'Google' }, [mike, sam]);
  const e1 = doc('estimates', 'estimate_items', 'estimate_id', { customer_id: smith.id, location_id: smith.lid, job_id: j1, title: '200A panel upgrade', status: 'approved', tax_rate: 7,
    created_at: day(-20), sent_at: day(-20), approved_at: day(-18), signature_name: 'Jordan Smith', created_by: users[0].id }, [['PNL-200', 1], ['PERMIT', 1]]);
  time(mike, j1, day(-12, 8), 9); time(sam, j1, day(-12, 8), 9);
  mat(j1, 'MAT-AFCI', 4, mike, -12); mat(j1, 'MAT-1P20', 8, mike, -12);
  ins('permits', { job_id: j1, permit_number: 'E-24-1182', jurisdiction: 'City of Springfield', permit_type: 'Service change', status: 'passed', applied_date: date(-16), issued_date: date(-14), inspection_date: date(-11), fee: 175 });
  const i1 = doc('invoices', 'invoice_items', 'invoice_id', { customer_id: smith.id, job_id: j1, estimate_id: e1, status: 'paid', issue_date: date(-11), due_date: date(19), tax_rate: 7, sent_at: day(-11) }, [['PNL-200', 1], ['PERMIT', 1]]);
  ins('payments', { invoice_id: i1, amount: C.invoiceWithTotals(db, get(db, 'SELECT * FROM invoices WHERE id = ?', i1)).total, method: 'card', paid_at: date(-9) });

  // 2. Commercial T&M job, invoiced, partially paid, past due
  const j2 = job({ customer_id: plaza.id, location_id: plaza.lid, title: 'Parking lot pole lights — repair 6 fixtures', job_type: 'commercial', status: 'invoiced',
    scheduled_start: day(-40, 7), scheduled_end: day(-39, 16), completed_at: day(-39, 16), budget_hours: 16, po_number: 'NP-5521', lead_source: 'Repeat' }, [mike, dana]);
  time(mike, j2, day(-40, 7), 8.5); time(dana, j2, day(-40, 7), 8.5); time(mike, j2, day(-39, 7), 6); time(dana, j2, day(-39, 7), 6);
  ins('expenses', { date: date(-40), category: 'Equipment rental', vendor: 'Sunbelt Rentals', description: '45ft bucket truck, 2 days', amount: 780, job_id: j2 });
  const i2 = ins('invoices', { number: D.nextNumber(db, 'invoices', 'INV'), public_token: D.token(), customer_id: plaza.id, job_id: j2, status: 'partial', issue_date: date(-38), due_date: date(-38 + 45 - 10), tax_rate: 0, sent_at: day(-38) });
  ins('invoice_items', { invoice_id: i2, description: 'Electrical labor — journeyman (T&M)', qty: 29, unit_price: 125, unit_cost: 48, taxable: 0, sort: 0 });
  ins('invoice_items', { invoice_id: i2, description: 'Bucket truck rental', qty: 2, unit_price: 520, unit_cost: 390, taxable: 0, sort: 1 });
  ins('invoice_items', { invoice_id: i2, description: 'LED retrofit kits, 150W', qty: 6, unit_price: 289, unit_cost: 145, taxable: 1, sort: 2 });
  ins('payments', { invoice_id: i2, amount: 2000, method: 'ach', reference: 'ACH 88123', paid_at: date(-20) });

  // 3. Completed, ready to invoice (T&M service call)
  const j3 = job({ customer_id: garcia.id, location_id: garcia.lid, title: 'Kitchen GFCI tripping — troubleshoot & replace', job_type: 'service', status: 'completed',
    scheduled_start: day(-1, 9), scheduled_end: day(-1, 11), completed_at: day(-1, 11, 30), lead_source: 'Referral', completion_notes: 'Replaced 2 failed GFCIs, found loose neutral at counter box.' }, [dana]);
  time(dana, j3, day(-1, 9), 2.25);
  ins('job_materials', { job_id: j3, pricebook_id: pb['MAT-GFCI'], description: '20A GFCI receptacle', qty: 2, unit_cost: 17.5, unit_price: 32, user_id: dana.id, used_on: date(-1) });

  // 4. Today: EV charger install (in progress) & tomorrow commercial
  const e4 = doc('estimates', 'estimate_items', 'estimate_id', { customer_id: garcia.id, location_id: garcia.lid, title: 'Tesla wall connector circuit', status: 'approved', tax_rate: 7,
    created_at: day(-6), sent_at: day(-6), approved_at: day(-5), signature_name: 'Ana Garcia', created_by: users[0].id }, [['EV-L2', 1], ['SURGE-WH', 1], ['PERMIT', 1]]);
  const j4 = job({ customer_id: garcia.id, location_id: garcia.lid, title: 'Level 2 EV charger + whole-home surge', job_type: 'install', status: 'in_progress',
    scheduled_start: day(0, 8), scheduled_end: day(0, 14), contract_amount: 1850, budget_hours: 5, budget_materials: 355 }, [mike]);
  run(db, 'UPDATE estimates SET job_id = ? WHERE id = ?', j4, e4);
  time(mike, j4, day(0, 8), 2.5);
  ins('permits', { job_id: j4, permit_number: 'E-24-1240', jurisdiction: 'City of Springfield', permit_type: 'EVSE circuit', status: 'issued', applied_date: date(-4), issued_date: date(-2), inspection_date: date(2), fee: 175 });

  const j5 = job({ customer_id: cafe.id, location_id: cafe.lid, title: 'Add 3 dedicated circuits for new espresso line', job_type: 'commercial', status: 'scheduled',
    scheduled_start: day(1, 7), scheduled_end: day(1, 15), budget_hours: 8, lead_source: 'Yelp' }, [dana, sam]);
  ins('permits', { job_id: j5, jurisdiction: 'City of Springfield', permit_type: 'Commercial alteration', status: 'applied', applied_date: date(-1), fee: 225 });
  job({ customer_id: smith.id, location_id: smith.lid, title: 'Install 4 recessed lights in living room', job_type: 'service', status: 'scheduled',
    scheduled_start: day(0, 13), scheduled_end: day(0, 16) }, [dana]);
  job({ customer_id: plaza.id, location_id: plaza.lid, title: 'Emergency: tenant suite 4 no power', job_type: 'emergency', priority: 'emergency', status: 'unscheduled' }, []);

  // Open estimates
  doc('estimates', 'estimate_items', 'estimate_id', { customer_id: cafe.id, location_id: cafe.lid, title: 'Dining room lighting retrofit', status: 'sent', valid_until: date(27), tax_rate: 7, sent_at: day(-3), created_at: day(-3), created_by: users[0].id },
    [['CAN-6', 14], ['CKT-20', 1], ['PERMIT', 1]]);
  doc('estimates', 'estimate_items', 'estimate_id', { customer_id: smith.id, location_id: smith.lid, title: 'Generator interlock', status: 'draft', tax_rate: 7, created_by: users[0].id },
    [['GEN-INT', 1], ['PERMIT', 1]]);

  // ~6 months of paid history so trend/P&L reports have something to show
  const histCust = [smith, garcia, plaza, cafe];
  const histWork = [['GFCI-REP', 3, 'Replace bath/kitchen GFCIs'], ['CAN-6', 6, 'Recessed lighting add'], ['CKT-20', 2, 'Dedicated circuits'], ['FAN-INST', 2, 'Ceiling fan installs'],
    ['SURGE-WH', 1, 'Whole-home surge protection'], ['EV-L2', 1, 'EV charger circuit'], ['PNL-SUB100', 1, 'Garage subpanel'], ['GEN-INT', 1, 'Generator interlock']];
  for (let k = 0; k < 60; k++) {
    const offset = -(3 + Math.floor(k * 3));
    const c = histCust[k % histCust.length];
    const [code, qty, title] = histWork[k % histWork.length];
    const tech = [mike, dana, sam][k % 3];
    const p = get(db, 'SELECT * FROM pricebook WHERE id = ?', pb[code]);
    const jid = job({ customer_id: c.id, location_id: c.lid, title, job_type: c === plaza || c === cafe ? 'commercial' : 'service', status: 'invoiced',
      scheduled_start: day(offset, 8), scheduled_end: day(offset, 12), completed_at: day(offset, 12), lead_source: LEADS[k % LEADS.length] }, [tech]);
    time(tech, jid, day(offset, 8), Math.max(1, p.labor_hours * qty * (0.85 + (k % 5) * 0.08)));
    ins('job_materials', { job_id: jid, pricebook_id: p.id, description: p.name, qty, unit_cost: p.unit_cost, unit_price: 0, billable: 0, user_id: tech.id, used_on: date(offset), invoiced: 1 });
    const iid = doc('invoices', 'invoice_items', 'invoice_id', { customer_id: c.id, job_id: jid, status: 'sent', issue_date: date(offset), due_date: date(offset + 30), tax_rate: 7, sent_at: day(offset) }, [[code, qty]]);
    const inv = C.invoiceWithTotals(db, get(db, 'SELECT * FROM invoices WHERE id = ?', iid));
    ins('payments', { invoice_id: iid, amount: inv.total, method: ['card', 'check', 'ach'][k % 3], paid_at: date(offset + 5) });
    run(db, "UPDATE invoices SET status = 'paid' WHERE id = ?", iid);
  }

  // Shop time & overhead
  time(sam, null, day(-2, 7), 3, 'shop');
  time(mike, null, day(-7, 7), 4, 'training');
  for (let m = 0; m < 7; m++) {
    const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - m); const ds = d.toISOString().slice(0, 10);
    ins('expenses', { date: ds, category: 'Rent', vendor: 'Landlord', description: 'Shop rent', amount: 2400 });
    ins('expenses', { date: ds, category: 'Insurance', vendor: 'Contractors Mutual', description: 'GL + WC', amount: 1150 });
    ins('expenses', { date: ds, category: 'Vehicles & fuel', vendor: 'Fleet card', description: 'Fuel', amount: 1300 + m * 40 });
    ins('expenses', { date: ds, category: 'Software & phones', vendor: 'Various', description: 'Phones, software', amount: 310 });
    ins('expenses', { date: ds, category: 'Marketing', vendor: 'Google Ads', description: 'Local search ads', amount: 650 });
  }
  ins('agreements', { customer_id: plaza.id, location_id: plaza.lid, name: 'Annual IR scan & panel maintenance', price: 1800, billing_frequency: 'annual', visits_per_year: 1, start_date: date(-300), next_visit: date(20) });
  ins('agreements', { customer_id: smith.id, location_id: smith.lid, name: 'Home Safety Club', price: 15, billing_frequency: 'monthly', visits_per_year: 1, start_date: date(-11), next_visit: date(340) });
}

if (require.main === module) {
  const file = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'fieldops.db');
  const force = process.argv.includes('--force');
  if (force && fs.existsSync(file)) for (const f of [file, file + '-wal', file + '-shm']) fs.rmSync(f, { force: true });
  const db = D.open(file);
  if (D.get(db, 'SELECT COUNT(*) n FROM users').n > 0) { console.error('Database already has data. Use `npm run seed -- --force` to wipe and reseed.'); process.exit(1); }
  seed(db);
  console.log('Demo data loaded. Sign in as admin@example.com / password123 (techs: mike@, dana@, sam@example.com)');
}

module.exports = { seed };
