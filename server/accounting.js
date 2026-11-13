'use strict';
// Double-entry general ledger. Operational records (invoices, payments, bills, expenses,
// stock usage, labor) post journal entries automatically; each source owns its entry and
// re-posting replaces it. Entries dated on/before books_closed_through are frozen.
const { all, get, run, settings } = require('./db');
const { CATEGORY_ACCOUNTS } = require('./migrations');

const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
const err = (m, s = 400) => Object.assign(new Error(m), { status: s });

function accountId(db, numberOrId) {
  if (numberOrId == null) return null;
  const byNum = get(db, 'SELECT id FROM accounts WHERE number = ?', String(numberOrId));
  if (byNum) return byNum.id;
  const byId = get(db, 'SELECT id FROM accounts WHERE id = ?', Number(numberOrId));
  if (byId) return byId.id;
  throw err(`Account ${numberOrId} not found`);
}
function closedThrough(db) { return settings(db).books_closed_through || ''; }
function assertOpen(db, date) {
  const c = closedThrough(db);
  if (c && date && String(date).slice(0, 10) <= c) throw err(`Books are closed through ${c}. Reopen the period in Accounting → Close books to change this.`);
}

// A line that appears on a completed bank reconciliation is part of a closed statement.
function assertNotReconciled(db, entryId) {
  const r = get(db, `SELECT r.statement_date, a.name FROM journal_lines jl JOIN reconciliations r ON r.id = jl.reconciliation_id
    JOIN accounts a ON a.id = jl.account_id WHERE jl.entry_id = ? LIMIT 1`, entryId);
  if (r) throw err(`This transaction is on the ${r.name} reconciliation for the statement ending ${r.statement_date}. Undo that reconciliation (Accounting → Banking) to change it.`);
}
function unpost(db, sourceType, sourceId) {
  const existing = all(db, 'SELECT * FROM journal_entries WHERE source_type = ? AND source_id = ?', sourceType, sourceId);
  for (const e of existing) { assertOpen(db, e.date); assertNotReconciled(db, e.id); }
  run(db, 'DELETE FROM journal_entries WHERE source_type = ? AND source_id = ?', sourceType, sourceId);
}

// lines: [{ account, debit, credit, memo, job_id, cost_code_id, customer_id, vendor_id }]
function post(db, { date, memo, source_type = 'manual', source_id = null, created_by = null, lines }) {
  if (source_type !== 'manual' && source_id != null) unpost(db, source_type, source_id);
  const clean = lines.map(l => ({ ...l, debit: r2(l.debit), credit: r2(l.credit) })).filter(l => l.debit || l.credit);
  if (!clean.length) return null;
  const dr = r2(clean.reduce((s, l) => s + l.debit, 0)), cr = r2(clean.reduce((s, l) => s + l.credit, 0));
  if (Math.abs(dr - cr) > 0.005) throw err(`Entry does not balance (debits ${dr} ≠ credits ${cr})`);
  assertOpen(db, date);
  const eid = Number(run(db, 'INSERT INTO journal_entries (date, memo, source_type, source_id, created_by) VALUES (?,?,?,?,?)',
    String(date).slice(0, 10), memo || null, source_type, source_id, created_by).lastInsertRowid);
  for (const l of clean)
    run(db, 'INSERT INTO journal_lines (entry_id, account_id, debit, credit, memo, job_id, cost_code_id, customer_id, vendor_id) VALUES (?,?,?,?,?,?,?,?,?)',
      eid, accountId(db, l.account), l.debit, l.credit, l.memo || null, l.job_id || null, l.cost_code_id || null, l.customer_id || null, l.vendor_id || null);
  return eid;
}

// ------------------------------------------------------------ source posters
function postInvoice(db, invoiceId) {
  const C = require('./calc');
  const inv = get(db, 'SELECT * FROM invoices WHERE id = ?', invoiceId);
  if (!inv || inv.status === 'draft' || inv.status === 'void' || inv.ledger_skip) return unpost(db, 'invoice', invoiceId);
  const full = C.invoiceWithTotals(db, inv);
  const cust = get(db, 'SELECT type FROM customers WHERE id = ?', inv.customer_id);
  const revAcct = cust && cust.type === 'commercial' ? '4100' : '4000';
  return post(db, { date: inv.issue_date, memo: `Invoice ${inv.number}`, source_type: 'invoice', source_id: inv.id, lines: [
    { account: '1200', debit: full.total, customer_id: inv.customer_id, job_id: inv.job_id },
    { account: revAcct, credit: full.subtotal - full.discount, customer_id: inv.customer_id, job_id: inv.job_id },
    { account: '2200', credit: full.tax, customer_id: inv.customer_id },
  ] });
}
function postPayment(db, paymentId) {
  const p = get(db, 'SELECT p.*, i.number, i.customer_id, i.job_id FROM payments p JOIN invoices i ON i.id = p.invoice_id WHERE p.id = ?', paymentId);
  if (!p || p.ledger_skip) return unpost(db, 'payment', paymentId);
  const dep = p.deposit_account_id || settings(db).default_deposit_account || '1000';
  return post(db, { date: p.paid_at, memo: `Payment on ${p.number}${p.reference ? ' · ' + p.reference : ''}`, source_type: 'payment', source_id: p.id, lines: [
    { account: dep, debit: p.amount, customer_id: p.customer_id },
    { account: '1200', credit: p.amount, customer_id: p.customer_id, job_id: p.job_id },
  ] });
}
function billTotals(db, bill) {
  const lines = all(db, `SELECT bl.*, a.number account_number, a.name account_name, j.number job_number, cc.code cost_code
    FROM bill_lines bl JOIN accounts a ON a.id = bl.account_id LEFT JOIN jobs j ON j.id = bl.job_id LEFT JOIN cost_codes cc ON cc.id = bl.cost_code_id
    WHERE bill_id = ? ORDER BY bl.id`, bill.id);
  const payments = all(db, 'SELECT bp.*, a.name account_name FROM bill_payments bp LEFT JOIN accounts a ON a.id = bp.account_id WHERE bill_id = ? ORDER BY paid_at, id', bill.id);
  const total = r2(lines.reduce((s, l) => s + l.amount, 0));
  const paid = r2(payments.reduce((s, p) => s + p.amount, 0));
  return { ...bill, lines, payments, total, paid, balance: r2(total - paid) };
}
function refreshBillStatus(db, billId) {
  const b = get(db, 'SELECT * FROM bills WHERE id = ?', billId);
  if (!b || b.status === 'void') return;
  const t = billTotals(db, b);
  run(db, 'UPDATE bills SET status = ? WHERE id = ?', t.balance <= 0.004 ? 'paid' : t.paid > 0 ? 'partial' : 'open', billId);
}
function postBill(db, billId) {
  const b = get(db, 'SELECT * FROM bills WHERE id = ?', billId);
  if (!b || b.status === 'void') return unpost(db, 'bill', billId);
  const t = billTotals(db, b);
  return post(db, { date: b.bill_date, memo: `Bill ${b.vendor_invoice || '#' + b.id}`, source_type: 'bill', source_id: b.id, lines: [
    ...t.lines.map(l => ({ account: l.account_id, debit: l.amount > 0 ? l.amount : 0, credit: l.amount < 0 ? -l.amount : 0, memo: l.description, job_id: l.job_id, cost_code_id: l.cost_code_id, vendor_id: b.vendor_id })),
    { account: '2000', credit: t.total > 0 ? t.total : 0, debit: t.total < 0 ? -t.total : 0, vendor_id: b.vendor_id },
  ] });
}
function postBillPayment(db, id) {
  const p = get(db, 'SELECT bp.*, b.vendor_id, b.vendor_invoice FROM bill_payments bp JOIN bills b ON b.id = bp.bill_id WHERE bp.id = ?', id);
  if (!p) return unpost(db, 'bill_payment', id);
  return post(db, { date: p.paid_at, memo: `Paid bill ${p.vendor_invoice || '#' + p.bill_id}${p.reference ? ' · ' + p.reference : ''}`, source_type: 'bill_payment', source_id: p.id, lines: [
    { account: '2000', debit: p.amount, vendor_id: p.vendor_id },
    { account: p.account_id || settings(db).default_paid_from_account || '1000', credit: p.amount, vendor_id: p.vendor_id },
  ] });
}
function expenseAccount(db, e) {
  if (e.account_id) return e.account_id;
  const m = CATEGORY_ACCOUNTS[e.category] || ['6950', '5500'];
  return accountId(db, e.job_id ? m[1] : m[0]);
}
function postExpense(db, id) {
  const e = get(db, 'SELECT * FROM expenses WHERE id = ?', id);
  if (!e || e.ledger_skip) return unpost(db, 'expense', id);
  return post(db, { date: e.date, memo: `${e.category}${e.vendor ? ' · ' + e.vendor : ''}${e.description ? ' · ' + e.description : ''}`, source_type: 'expense', source_id: e.id, lines: [
    { account: expenseAccount(db, e), debit: e.amount, job_id: e.job_id, cost_code_id: e.cost_code_id },
    { account: e.paid_from_account_id || settings(db).default_paid_from_account || '1000', credit: e.amount },
  ] });
}
// Only stock pulled from inventory moves money in the ledger; PO/bill materials post through the bill.
function postJobMaterial(db, id) {
  const m = get(db, 'SELECT * FROM job_materials WHERE id = ?', id);
  if (!m || m.source !== 'stock' || !m.pricebook_id) return unpost(db, 'job_material', id);
  const amt = r2(m.qty * m.unit_cost);
  return post(db, { date: m.used_on, memo: `Stock to job: ${m.qty} × ${m.description}`, source_type: 'job_material', source_id: m.id, lines: [
    { account: '5100', debit: amt, job_id: m.job_id, cost_code_id: m.cost_code_id },
    { account: '1300', credit: amt, job_id: m.job_id },
  ] });
}
function postInventoryAdjustment(db, { pricebookId, delta, unitCost, userId, date }) {
  const amt = r2(delta * unitCost);
  if (!amt) return null;
  const p = get(db, 'SELECT name FROM pricebook WHERE id = ?', pricebookId);
  return post(db, { date: date || new Date().toISOString().slice(0, 10), memo: `Inventory count adjustment: ${delta > 0 ? '+' : ''}${delta} × ${p ? p.name : 'item'}`, source_type: 'inventory_adjustment', created_by: userId,
    lines: amt > 0 ? [{ account: '1300', debit: amt }, { account: '5900', credit: amt }] : [{ account: '5900', debit: -amt }, { account: '1300', credit: -amt }] });
}

// Labor accrual for one Mon–Sun week: loaded cost to Direct Labor (job/travel time on jobs)
// or Indirect Labor (everything else), against Accrued Payroll & Burden.
function weekKey(dateStr) { return Number(dateStr.replace(/-/g, '')); }
function laborForWeek(db, weekStart) {
  const C = require('./calc');
  const s = new Date(weekStart + 'T00:00:00'); const e = new Date(s); e.setDate(e.getDate() + 7);
  const rows = C.timeInRange(db, s.toISOString(), e.toISOString(), 'AND t.clock_out IS NOT NULL');
  const groups = new Map();
  for (const t of rows) {
    const direct = t.job_id && (t.kind === 'job' || t.kind === 'travel');
    const key = direct ? `d:${t.job_id}:${t.cost_code_id || ''}` : 'i';
    const g = groups.get(key) || { direct, job_id: direct ? t.job_id : null, cost_code_id: direct ? t.cost_code_id : null, hours: 0, cost: 0 };
    g.hours += t.hours; g.cost += t.hours * t.hourly_cost;
    groups.set(key, g);
  }
  return [...groups.values()].map(g => ({ ...g, hours: r2(g.hours), cost: r2(g.cost) }));
}
function postLaborWeek(db, weekStart, userId) {
  const groups = laborForWeek(db, weekStart);
  const total = r2(groups.reduce((s, g) => s + g.cost, 0));
  const end = new Date(weekStart + 'T00:00:00'); end.setDate(end.getDate() + 6);
  const endStr = end.toISOString().slice(0, 10);
  if (!total) { unpost(db, 'labor', weekKey(weekStart)); return { week: weekStart, total: 0 }; }
  post(db, { date: endStr, memo: `Labor accrual, week of ${weekStart}`, source_type: 'labor', source_id: weekKey(weekStart), created_by: userId, lines: [
    ...groups.map(g => ({ account: g.direct ? '5000' : '6000', debit: g.cost, job_id: g.job_id, cost_code_id: g.cost_code_id, memo: `${g.hours} hrs` })),
    { account: '2100', credit: total },
  ] });
  return { week: weekStart, total };
}
function mondayOf(d) { const x = new Date(d + 'T00:00:00'); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; }
function laborStatus(db, from, to) {
  const out = [];
  for (let w = mondayOf(from); w <= to;) {
    const computed = r2(laborForWeek(db, w).reduce((s, g) => s + g.cost, 0));
    const je = get(db, `SELECT COALESCE(SUM(jl.credit),0) v, MAX(je.date) date FROM journal_entries je JOIN journal_lines jl ON jl.entry_id = je.id
      JOIN accounts a ON a.id = jl.account_id WHERE je.source_type = 'labor' AND je.source_id = ? AND a.number = '2100'`, weekKey(w));
    out.push({ week: w, computed, posted: r2(je.v), in_sync: Math.abs(computed - je.v) < 0.01 });
    const x = new Date(w + 'T00:00:00'); x.setDate(x.getDate() + 7);
    w = `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
  }
  return out;
}

// Re-post every automatic entry outside the closed period (used after migration or data fixes).
function rebuild(db) {
  const closed = closedThrough(db);
  const after = d => !closed || String(d).slice(0, 10) > closed;
  run(db, `DELETE FROM journal_entries WHERE source_type IN ('invoice','payment','bill','bill_payment','expense','job_material') ${closed ? 'AND date > ?' : ''}
    AND id NOT IN (SELECT entry_id FROM journal_lines WHERE reconciliation_id IS NOT NULL)`, ...(closed ? [closed] : []));
  // entries kept because they're reconciled stay exactly as they are
  const kept = new Set(all(db, "SELECT source_type || ':' || source_id k FROM journal_entries WHERE id IN (SELECT entry_id FROM journal_lines WHERE reconciliation_id IS NOT NULL)").map(r => r.k));
  const _after = after;
  const afterK = (type, id, d) => !kept.has(`${type}:${id}`) && _after(d);
  let n = 0;
  for (const r of all(db, "SELECT id, issue_date d FROM invoices WHERE status NOT IN ('draft','void')")) if (afterK('invoice', r.id, r.d)) { postInvoice(db, r.id); n++; }
  for (const r of all(db, 'SELECT id, paid_at d FROM payments')) if (afterK('payment', r.id, r.d)) { postPayment(db, r.id); n++; }
  for (const r of all(db, "SELECT id, bill_date d FROM bills WHERE status != 'void'")) if (afterK('bill', r.id, r.d)) { postBill(db, r.id); n++; }
  for (const r of all(db, 'SELECT id, paid_at d FROM bill_payments')) if (afterK('bill_payment', r.id, r.d)) { postBillPayment(db, r.id); n++; }
  for (const r of all(db, 'SELECT id, date d FROM expenses')) if (afterK('expense', r.id, r.d)) { postExpense(db, r.id); n++; }
  for (const r of all(db, "SELECT id, used_on d FROM job_materials WHERE source = 'stock' AND pricebook_id IS NOT NULL")) if (afterK('job_material', r.id, r.d)) { postJobMaterial(db, r.id); n++; }
  return { reposted: n };
}

// ------------------------------------------------------------ reports
const NORMAL_DEBIT = new Set(['asset', 'cogs', 'expense']);
function balances(db, { from = '0000-01-01', to = '9999-12-31' } = {}) {
  return all(db, `SELECT a.*, COALESCE(SUM(jl.debit),0) debit, COALESCE(SUM(jl.credit),0) credit
    FROM accounts a LEFT JOIN journal_lines jl ON jl.account_id = a.id
    LEFT JOIN journal_entries je ON je.id = jl.entry_id
    WHERE je.id IS NULL OR (je.date >= ? AND je.date <= ?)
    GROUP BY a.id ORDER BY a.number`, from, to).map(a => ({
    ...a, debit: r2(a.debit), credit: r2(a.credit), balance: r2(NORMAL_DEBIT.has(a.type) ? a.debit - a.credit : a.credit - a.debit),
  }));
}
function trialBalance(db, asOf) {
  const rows = balances(db, { to: asOf }).filter(a => a.debit || a.credit);
  const tb = rows.map(a => { const net = r2(a.debit - a.credit); return { id: a.id, number: a.number, name: a.name, type: a.type, debit: net > 0 ? net : 0, credit: net < 0 ? -net : 0 }; });
  return { as_of: asOf, rows: tb, total_debit: r2(tb.reduce((s, r) => s + r.debit, 0)), total_credit: r2(tb.reduce((s, r) => s + r.credit, 0)) };
}
function incomeStatement(db, from, to) {
  const rows = balances(db, { from, to }).filter(a => ['income', 'cogs', 'expense'].includes(a.type) && (a.debit || a.credit));
  const sum = t => r2(rows.filter(a => a.type === t).reduce((s, a) => s + a.balance, 0));
  const income = sum('income'), cogs = sum('cogs'), expense = sum('expense');
  return { from, to, income: rows.filter(a => a.type === 'income'), cogs: rows.filter(a => a.type === 'cogs'), expenses: rows.filter(a => a.type === 'expense'),
    total_income: income, total_cogs: cogs, gross_profit: r2(income - cogs), total_expenses: expense, net_income: r2(income - cogs - expense) };
}
function balanceSheet(db, asOf) {
  const rows = balances(db, { to: asOf });
  const yearStart = asOf.slice(0, 4) + '-01-01';
  const priorNI = incomeStatement(db, '0000-01-01', `${Number(asOf.slice(0, 4)) - 1}-12-31`).net_income;
  const ytdNI = incomeStatement(db, yearStart, asOf).net_income;
  const pick = t => rows.filter(a => a.type === t && (a.debit || a.credit));
  const assets = pick('asset'), liabilities = pick('liability'), equity = pick('equity');
  const ta = r2(assets.reduce((s, a) => s + a.balance, 0)), tl = r2(liabilities.reduce((s, a) => s + a.balance, 0));
  const te = r2(equity.reduce((s, a) => s + a.balance, 0) + priorNI + ytdNI);
  return { as_of: asOf, assets, liabilities, equity, prior_earnings: priorNI, current_earnings: ytdNI,
    total_assets: ta, total_liabilities: tl, total_equity: te, balanced: Math.abs(ta - tl - te) < 0.01 };
}
function generalLedger(db, accountIdV, from, to) {
  const a = get(db, 'SELECT * FROM accounts WHERE id = ?', accountIdV);
  if (!a) throw err('Account not found', 404);
  const sign = NORMAL_DEBIT.has(a.type) ? 1 : -1;
  const open = get(db, `SELECT COALESCE(SUM(jl.debit - jl.credit),0) v FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id WHERE jl.account_id = ? AND je.date < ?`, a.id, from).v * sign;
  let bal = r2(open);
  const lines = all(db, `SELECT jl.*, je.date, je.memo entry_memo, je.source_type, je.source_id, j.number job_number, c.name customer_name, v.name vendor_name
    FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id LEFT JOIN jobs j ON j.id = jl.job_id
    LEFT JOIN customers c ON c.id = jl.customer_id LEFT JOIN vendors v ON v.id = jl.vendor_id
    WHERE jl.account_id = ? AND je.date >= ? AND je.date <= ? ORDER BY je.date, je.id, jl.id`, a.id, from, to)
    .map(l => { bal = r2(bal + (l.debit - l.credit) * sign); return { ...l, balance: bal }; });
  return { account: a, from, to, opening_balance: r2(open), lines, closing_balance: bal };
}
function apAging(db) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const buckets = { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0 };
  const rows = all(db, `SELECT b.*, v.name vendor_name FROM bills b JOIN vendors v ON v.id = b.vendor_id WHERE b.status IN ('open','partial')`)
    .map(b => billTotals(db, b)).filter(b => b.balance > 0.004).map(b => {
      const days = Math.floor((today - new Date((b.due_date || b.bill_date) + 'T00:00:00')) / 864e5);
      const k = days <= 0 ? 'current' : days <= 30 ? 'd1_30' : days <= 60 ? 'd31_60' : days <= 90 ? 'd61_90' : 'd90_plus';
      buckets[k] += b.balance;
      return { id: b.id, vendor_name: b.vendor_name, vendor_invoice: b.vendor_invoice, bill_date: b.bill_date, due_date: b.due_date, days_past_due: Math.max(0, days), balance: b.balance };
    }).sort((a, b) => a.due_date < b.due_date ? -1 : 1);
  for (const k in buckets) buckets[k] = r2(buckets[k]);
  return { buckets, total: r2(rows.reduce((s, r) => s + r.balance, 0)), bills: rows };
}

// ------------------------------------------------------------ chart of accounts maintenance
// Accounts the program posts to by number. Their numbers and types are fixed (renaming is fine) and they can't be deleted,
// or invoices, payments, bills, expenses, stock and labor would stop posting.
const CORE_ACCOUNTS = ['1000', '1200', '1300', '2000', '2050', '2100', '2200', '3950', '4000', '4100', '5000', '5900', '6000'];
function systemAccountNumbers(db) {
  const s = settings(db);
  const set = new Set([...CORE_ACCOUNTS, ...Object.values(CATEGORY_ACCOUNTS).flat()]);
  for (const k of ['default_deposit_account', 'default_paid_from_account']) if (s[k]) {
    const a = get(db, 'SELECT number FROM accounts WHERE number = ? OR id = ?', String(s[k]), Number(s[k]) || -1);
    if (a) set.add(a.number);
  }
  return set;
}
// Everything that points at an account: every table with a foreign key to accounts, found from the schema so new tables are covered.
function accountUsage(db, id) {
  const out = [];
  for (const { name } of all(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")) {
    for (const fk of all(db, `PRAGMA foreign_key_list("${name}")`)) {
      if (fk.table !== 'accounts' || name === 'accounts') continue;
      const n = get(db, `SELECT COUNT(*) n FROM "${name}" WHERE "${fk.from}" = ?`, id).n;
      if (n) out.push({ table: name, column: fk.from, count: n });
    }
  }
  return out;
}
const USAGE_LABEL = { journal_lines: 'ledger line', bank_transactions: 'bank transaction', bank_imports: 'statement import', bank_rules: 'bank rule',
  reconciliations: 'reconciliation', expenses: 'expense', payments: 'customer payment', bill_lines: 'bill line', bill_payments: 'bill payment',
  plaid_accounts: 'bank feed', pricebook: 'price book item' };
function describeUsage(usage) {
  return usage.map(u => { const l = USAGE_LABEL[u.table] || u.table.replace(/_/g, ' '); return `${u.count} ${l}${u.count === 1 ? '' : 's'}`; }).join(', ');
}
const TYPES = ['asset', 'liability', 'equity', 'income', 'cogs', 'expense'];
function updateAccount(db, id, b) {
  const a = get(db, 'SELECT * FROM accounts WHERE id = ?', id);
  if (!a) throw err('Account not found', 404);
  const sys = systemAccountNumbers(db).has(a.number);
  const ch = {};
  if (b.name !== undefined) { const n = String(b.name || '').trim(); if (!n) throw err('Name is required'); ch.name = n; }
  const num = b.number == null ? '' : String(b.number).trim();
  if (b.number !== undefined && num !== a.number) {
    if (!num) throw err('Number is required');
    if (sys) throw err(`${a.number} is used by automatic posting, so its number can't change. You can rename it.`);
    if (get(db, 'SELECT id FROM accounts WHERE number = ? AND id != ?', num, a.id)) throw err(`Account number ${num} is already used`);
    ch.number = num;
  }
  if (b.type !== undefined && b.type !== a.type) {
    if (!TYPES.includes(b.type)) throw err('Unknown account type');
    if (sys) throw err(`${a.number} is used by automatic posting, so its type can't change`);
    if (get(db, 'SELECT 1 FROM journal_lines WHERE account_id = ? LIMIT 1', a.id)) throw err("This account has ledger activity, so its type can't change (it would move past amounts between statements). Make a new account instead.");
    ch.type = b.type;
  }
  if (b.subtype !== undefined && (b.subtype || null) !== a.subtype) {
    const st = b.subtype || null;
    if (sys) throw err(`${a.number} is used by automatic posting, so its detail can't change`);
    if (st !== a.subtype && ['bank', 'credit_card'].includes(a.subtype) && get(db, 'SELECT 1 FROM bank_transactions WHERE account_id = ? LIMIT 1', a.id))
      throw err('This account has bank transactions, so it has to stay a bank / credit card account');
    ch.subtype = st;
  }
  if (b.description !== undefined) ch.description = b.description || null;
  if (b.active !== undefined) {
    const on = b.active === true || b.active === 1 || b.active === '1' ? 1 : 0;
    if (!on && sys) throw err(`${a.number} is used by automatic posting and has to stay active`);
    ch.active = on;
  }
  const keys = Object.keys(ch);
  if (keys.length) run(db, `UPDATE accounts SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map(k => ch[k]), a.id);
  return get(db, 'SELECT * FROM accounts WHERE id = ?', a.id);
}
// Only an account nothing has ever touched can be deleted; one with history can be made inactive instead.
function deleteAccount(db, id) {
  const a = get(db, 'SELECT * FROM accounts WHERE id = ?', id);
  if (!a) throw err('Account not found', 404);
  if (systemAccountNumbers(db).has(a.number)) throw err(`${a.number} ${a.name} is used by automatic posting and can't be deleted. You can rename it.`);
  const usage = accountUsage(db, a.id);
  if (usage.length) throw Object.assign(err(`${a.number} ${a.name} can't be deleted because it's used by ${describeUsage(usage)}. Untick Active to hide it instead; its history stays in the books.`, 409), { usage });
  run(db, 'DELETE FROM accounts WHERE id = ?', a.id);
}
function accountMeta(db) {
  const sys = systemAccountNumbers(db);
  return all(db, 'SELECT id, number FROM accounts').map(a => ({ id: a.id, system: sys.has(a.number), used: accountUsage(db, a.id).length > 0 }));
}

module.exports = {
  assertNotReconciled, accountId, assertOpen, closedThrough, post, unpost, postInvoice, postPayment, postBill, postBillPayment, postExpense, postJobMaterial,
  postInventoryAdjustment, postLaborWeek, laborStatus, laborForWeek, mondayOf, rebuild, billTotals, refreshBillStatus, expenseAccount,
  trialBalance, incomeStatement, balanceSheet, generalLedger, apAging, balances,
  systemAccountNumbers, accountUsage, updateAccount, deleteAccount, accountMeta,
};
