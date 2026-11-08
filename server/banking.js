'use strict';
// Banking: statement import (CSV / OFX / QFX), matching bank lines to ledger lines,
// categorization rules, and statement reconciliation.
//
// Sign convention for bank lines: amount > 0 is money IN (deposit, or a payment/credit on a card),
// amount < 0 is money OUT. Money in matches a ledger DEBIT on that account; money out matches a CREDIT.
// That holds for both bank (asset) and credit card (liability) accounts.
const crypto = require('node:crypto');
const { all, get, run, settings } = require('./db');
const A = require('./accounting');

const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
const err = (m, s = 400) => Object.assign(new Error(m), { status: s });

// ------------------------------------------------------------ parsing
function parseCSVRows(text) {
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; }
    else cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows.map(r => r.map(x => x.trim())).filter(r => r.some(x => x !== ''));
}
function parseDate(s) {
  s = String(s || '').trim();
  let m;
  if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s))) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  if ((m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/.exec(s))) {
    const y = m[3].length === 2 ? '20' + m[3] : m[3];
    return `${y}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  }
  if ((m = /^(\d{4})(\d{2})(\d{2})/.exec(s))) return `${m[1]}-${m[2]}-${m[3]}`; // OFX 20261105120000
  return null;
}
function parseAmount(s) {
  if (s == null) return null;
  let t = String(s).trim(); if (!t) return null;
  const neg = /^\(.*\)$/.test(t) || /^-/.test(t) || /-$/.test(t) || /\bDR\b/i.test(t);
  t = t.replace(/[^0-9.]/g, '');
  if (!t) return null;
  const v = parseFloat(t);
  return Number.isFinite(v) ? (neg ? -v : v) : null;
}
const find = (hdr, ...names) => hdr.findIndex(h => names.some(n => h === n || h.includes(n)));

function parseCSV(text) {
  const rows = parseCSVRows(text);
  // header = first row that names a date column
  const hi = rows.findIndex(r => r.some(c => /date|posted/i.test(c)));
  if (hi < 0) throw err('Could not find a header row with a Date column in the CSV');
  const hdr = rows[hi].map(h => h.toLowerCase());
  const di = find(hdr, 'posting date', 'transaction date', 'posted date', 'date', 'posted');
  const desc = find(hdr, 'description', 'payee', 'name', 'memo', 'details', 'narrative');
  const memo = hdr.findIndex((h, i) => i !== desc && /memo|note/.test(h));
  const amt = find(hdr, 'amount');
  const deb = find(hdr, 'debit', 'withdrawal', 'money out', 'payments');
  const cred = find(hdr, 'credit', 'deposit', 'money in');
  const ref = find(hdr, 'check', 'reference', 'ref', 'number', 'transaction id');
  if (di < 0 || (amt < 0 && deb < 0 && cred < 0)) throw err('CSV needs a Date column and either an Amount column or Debit/Credit columns');
  const out = [];
  for (const r of rows.slice(hi + 1)) {
    const date = parseDate(r[di]); if (!date) continue;
    let amount;
    if (amt >= 0 && r[amt] !== '' && r[amt] != null) amount = parseAmount(r[amt]);
    else {
      const d = deb >= 0 ? parseAmount(r[deb]) : null, c = cred >= 0 ? parseAmount(r[cred]) : null;
      amount = (c ? Math.abs(c) : 0) - (d ? Math.abs(d) : 0);
    }
    if (amount == null || !amount) continue;
    out.push({ date, amount: r2(amount), description: [r[desc], memo >= 0 ? r[memo] : ''].filter(Boolean).join(' · ') || '(no description)', reference: ref >= 0 ? r[ref] || null : null, fit_id: null });
  }
  return out;
}
function parseOFX(text) {
  const tag = (block, t) => { const m = new RegExp(`<${t}>([^<\\r\\n]*)`, 'i').exec(block); return m ? m[1].trim() : null; };
  const out = [];
  const re = /<STMTTRN>([\s\S]*?)(?=<\/STMTTRN>|<STMTTRN>|<\/BANKTRANLIST>)/gi;
  let m;
  while ((m = re.exec(text))) {
    const b = m[1];
    const date = parseDate(tag(b, 'DTPOSTED')), amount = parseAmount(tag(b, 'TRNAMT'));
    if (!date || !amount) continue;
    out.push({ date, amount: r2(amount), description: [tag(b, 'NAME'), tag(b, 'MEMO')].filter(Boolean).join(' · ') || '(no description)',
      reference: tag(b, 'CHECKNUM') || tag(b, 'REFNUM'), fit_id: tag(b, 'FITID') });
  }
  if (!out.length && !/<OFX>/i.test(text)) throw err('Not an OFX/QFX file');
  return out;
}

// ------------------------------------------------------------ import & matching
function bankAccount(db, accountId) {
  const a = get(db, 'SELECT * FROM accounts WHERE id = ?', accountId);
  if (!a || !['bank', 'credit_card'].includes(a.subtype)) throw err('Pick a bank or credit card account');
  return a;
}
function importStatement(db, { accountId, filename, content, flip, userId }) {
  const acct = bankAccount(db, accountId);
  const isOFX = /<OFX>|OFXHEADER|<STMTTRN>/i.test(content) || /\.(ofx|qfx|qbo)$/i.test(filename || '');
  let txs = isOFX ? parseOFX(content) : parseCSV(content);
  if (flip) txs = txs.map(t => ({ ...t, amount: -t.amount }));
  if (!txs.length) throw err('No transactions found in that file');
  const imp = Number(run(db, 'INSERT INTO bank_imports (account_id, filename, rows, created_by) VALUES (?,?,?,?)', acct.id, filename || null, txs.length, userId || null).lastInsertRowid);
  // identical lines on the same day (two $5 charges) get an occurrence number so re-importing the same file still de-duplicates
  const seen = new Map(); let added = 0, dup = 0;
  for (const t of txs) {
    let fit = t.fit_id;
    if (!fit) {
      const key = `${t.date}|${t.amount}|${t.description}|${t.reference || ''}`;
      const n = (seen.get(key) || 0) + 1; seen.set(key, n);
      fit = 'h:' + crypto.createHash('sha1').update(`${key}|${n}`).digest('hex').slice(0, 20);
    }
    const info = run(db, 'INSERT OR IGNORE INTO bank_transactions (account_id, import_id, date, amount, description, reference, fit_id) VALUES (?,?,?,?,?,?,?)',
      acct.id, imp, t.date, t.amount, t.description, t.reference, fit);
    if (info.changes) added++; else dup++;
  }
  run(db, 'UPDATE bank_imports SET added = ?, duplicates = ? WHERE id = ?', added, dup, imp);
  const matched = autoMatch(db, acct.id);
  return { import_id: imp, rows: txs.length, added, duplicates: dup, matched };
}

// Ledger lines on this account that a bank line could pair with.
function candidates(db, tx, { days = 7, any = false } = {}) {
  const col = tx.amount > 0 ? 'jl.debit' : 'jl.credit';
  const amt = Math.abs(tx.amount);
  return all(db, `SELECT jl.id, jl.debit, jl.credit, jl.memo, je.date, je.memo entry_memo, je.source_type, je.source_id,
      COALESCE(c.name, v.name) name, ABS(julianday(je.date) - julianday(?)) gap
    FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
    LEFT JOIN customers c ON c.id = jl.customer_id LEFT JOIN vendors v ON v.id = jl.vendor_id
    WHERE jl.account_id = ? AND jl.reconciliation_id IS NULL AND ABS(${col} - ?) < 0.005
      AND NOT EXISTS (SELECT 1 FROM bank_transactions b WHERE b.journal_line_id = jl.id)
      ${any ? '' : 'AND ABS(julianday(je.date) - julianday(?)) <= ?'}
    ORDER BY gap, je.id`, tx.date, tx.account_id, amt, ...(any ? [] : [tx.date, days]));
}
function matchTo(db, txId, lineId) {
  const tx = get(db, 'SELECT * FROM bank_transactions WHERE id = ?', txId);
  if (!tx) throw err('Bank transaction not found', 404);
  const line = get(db, 'SELECT jl.*, je.date FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id WHERE jl.id = ?', lineId);
  if (!line || line.account_id !== tx.account_id) throw err('That ledger line is not on this account');
  const want = tx.amount > 0 ? line.debit : line.credit;
  if (Math.abs(want - Math.abs(tx.amount)) >= 0.005) throw err(`Amounts differ: bank ${tx.amount}, ledger ${line.debit || -line.credit}`);
  if (get(db, 'SELECT id FROM bank_transactions WHERE journal_line_id = ? AND id != ?', lineId, txId)) throw err('That ledger line is already matched to another bank line');
  run(db, "UPDATE bank_transactions SET status = 'matched', journal_line_id = ? WHERE id = ?", lineId, txId);
  run(db, 'UPDATE journal_lines SET cleared = 1 WHERE id = ?', lineId); // the bank says it cleared
}
function autoMatch(db, accountId) {
  let n = 0;
  for (const tx of all(db, "SELECT * FROM bank_transactions WHERE account_id = ? AND status = 'unmatched' ORDER BY date, id", accountId)) {
    // checks can clear weeks later: allow 45 days when the check number appears on the ledger line
    let c = candidates(db, tx)[0];
    if (!c && tx.reference) c = candidates(db, tx, { days: 45 }).find(x => `${x.memo || ''} ${x.entry_memo || ''}`.includes(tx.reference));
    if (c) { matchTo(db, tx.id, c.id); n++; }
  }
  return n;
}

function ruleFor(db, tx) {
  const d = String(tx.description || '').toUpperCase();
  return all(db, `SELECT r.*, a.number account_number, a.name account_name FROM bank_rules r JOIN accounts a ON a.id = r.account_id WHERE r.active = 1 ORDER BY LENGTH(r.match_text) DESC`)
    .find(r => d.includes(r.match_text.toUpperCase()) && (r.direction === 'any' || (r.direction === 'in') === (tx.amount > 0))) || null;
}
function listTransactions(db, accountId, status) {
  const C = require('./calc');
  const rows = all(db, `SELECT b.*, je.memo match_memo, je.source_type match_source, je.date match_date FROM bank_transactions b
    LEFT JOIN journal_lines jl ON jl.id = b.journal_line_id LEFT JOIN journal_entries je ON je.id = jl.entry_id
    WHERE b.account_id = ? ${status ? 'AND b.status = ?' : ''} ORDER BY b.date DESC, b.id DESC LIMIT 1000`, accountId, ...(status ? [status] : []));
  const openInv = all(db, "SELECT i.*, c.name customer_name FROM invoices i JOIN customers c ON c.id = i.customer_id WHERE i.status IN ('sent','partial')").map(i => C.invoiceWithTotals(db, i));
  for (const t of rows) {
    if (t.status !== 'unmatched') continue;
    t.candidates = candidates(db, t, { days: 30 }).slice(0, 5);
    t.rule = ruleFor(db, t);
    if (t.amount > 0) t.invoice_suggestions = openInv.filter(i => Math.abs(i.balance - t.amount) < 0.005).map(i => ({ id: i.id, number: i.number, customer_name: i.customer_name, balance: i.balance }));
  }
  return rows;
}

// Turn an unmatched bank line into books: money out to an expense/COGS/asset account becomes an
// Expense (so it lands in job costing too); transfers and money in become a journal entry.
function categorize(db, txId, b, userId) {
  const tx = get(db, 'SELECT * FROM bank_transactions WHERE id = ?', txId);
  if (!tx || tx.status !== 'unmatched') throw err('That bank line is already handled');
  const target = get(db, 'SELECT * FROM accounts WHERE id = ?', b.account_id);
  if (!target) throw err('Choose an account');
  if (target.id === tx.account_id) throw err('Pick a different account than the bank account itself');
  let lineId;
  const isTransfer = ['bank', 'credit_card'].includes(target.subtype);
  if (tx.amount < 0 && ['expense', 'cogs', 'asset'].includes(target.type) && !isTransfer) {
    const id = Number(run(db, 'INSERT INTO expenses (date, category, vendor, description, amount, job_id, cost_code_id, account_id, paid_from_account_id) VALUES (?,?,?,?,?,?,?,?,?)',
      tx.date, b.category || target.name, b.vendor || null, b.description || tx.description, -tx.amount, b.job_id || null, b.cost_code_id || null, target.id, tx.account_id).lastInsertRowid);
    A.postExpense(db, id);
    lineId = get(db, `SELECT jl.id FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id WHERE je.source_type = 'expense' AND je.source_id = ? AND jl.account_id = ?`, id, tx.account_id).id;
  } else {
    const amt = Math.abs(tx.amount);
    const lines = tx.amount > 0
      ? [{ account: tx.account_id, debit: amt }, { account: target.id, credit: amt, job_id: b.job_id, cost_code_id: b.cost_code_id }]
      : [{ account: target.id, debit: amt, job_id: b.job_id, cost_code_id: b.cost_code_id }, { account: tx.account_id, credit: amt }];
    const eid = A.post(db, { date: tx.date, memo: b.description || `${isTransfer ? 'Transfer' : 'Bank'}: ${tx.description}`, source_type: 'manual', created_by: userId, lines });
    lineId = get(db, 'SELECT id FROM journal_lines WHERE entry_id = ? AND account_id = ?', eid, tx.account_id).id;
  }
  matchTo(db, tx.id, lineId);
  if (b.save_rule && b.rule_text) run(db, 'INSERT INTO bank_rules (match_text, direction, account_id, category, vendor) VALUES (?,?,?,?,?)',
    String(b.rule_text).trim(), tx.amount > 0 ? 'in' : 'out', target.id, b.category || null, b.vendor || null);
  return { line_id: lineId };
}
// A deposit that is a customer paying an invoice: record the payment into this bank account and match it.
function applyToInvoice(db, txId, invoiceId) {
  const C = require('./calc');
  const tx = get(db, 'SELECT * FROM bank_transactions WHERE id = ?', txId);
  if (!tx || tx.status !== 'unmatched' || tx.amount <= 0) throw err('Only unmatched deposits can be applied to an invoice');
  const inv = get(db, 'SELECT * FROM invoices WHERE id = ?', invoiceId);
  if (!inv || ['void', 'draft'].includes(inv.status)) throw err('Invoice must be sent and not void');
  const bal = C.invoiceWithTotals(db, inv).balance;
  if (tx.amount > bal + 0.005) throw err(`Deposit ${tx.amount} is more than the invoice balance ${bal}`);
  const pid = Number(run(db, "INSERT INTO payments (invoice_id, amount, method, reference, paid_at, deposit_account_id) VALUES (?,?,'ach',?,?,?)",
    inv.id, tx.amount, tx.reference || tx.description, tx.date, tx.account_id).lastInsertRowid);
  C.refreshInvoiceStatus(db, inv.id);
  A.postPayment(db, pid);
  const line = get(db, `SELECT jl.id FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id WHERE je.source_type = 'payment' AND je.source_id = ? AND jl.account_id = ?`, pid, tx.account_id);
  matchTo(db, tx.id, line.id);
  return { payment_id: pid };
}

// ------------------------------------------------------------ reconciliation
const signFor = acct => acct.type === 'liability' ? -1 : 1; // card statements show the balance owed as positive
function startReconciliation(db, { accountId, statementDate, statementBalance, startDate, beginningBalance }) {
  const acct = bankAccount(db, accountId);
  const open = get(db, "SELECT * FROM reconciliations WHERE account_id = ? AND status = 'in_progress'", acct.id);
  if (open) {
    run(db, 'UPDATE reconciliations SET statement_date = ?, statement_balance = ? WHERE id = ?', statementDate || open.statement_date, statementBalance ?? open.statement_balance, open.id);
    return open.id;
  }
  const last = get(db, "SELECT * FROM reconciliations WHERE account_id = ? AND status = 'completed' ORDER BY statement_date DESC, id DESC LIMIT 1", acct.id);
  if (last && statementDate <= last.statement_date) throw err(`Last reconciliation ended ${last.statement_date}; the new statement must end after that`);
  // first reconciliation: the statement's opening balance and start date come from the bank statement
  const first = !last;
  return Number(run(db, 'INSERT INTO reconciliations (account_id, statement_date, start_date, beginning_balance, statement_balance) VALUES (?,?,?,?,?)',
    acct.id, statementDate, first && startDate ? startDate : null, last ? last.statement_balance : Number(beginningBalance) || 0, Number(statementBalance)).lastInsertRowid);
}
function reconciliationState(db, id) {
  const rec = get(db, 'SELECT r.*, a.number account_number, a.name account_name, a.type account_type FROM reconciliations r JOIN accounts a ON a.id = r.account_id WHERE r.id = ?', id);
  if (!rec) throw err('Not found', 404);
  const sign = signFor({ type: rec.account_type });
  const lines = all(db, `SELECT jl.id, jl.debit, jl.credit, jl.memo, jl.cleared, jl.reconciliation_id, je.date, je.memo entry_memo, je.source_type,
      COALESCE(c.name, v.name) name, b.id bank_tx_id, b.description bank_description
    FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
    LEFT JOIN customers c ON c.id = jl.customer_id LEFT JOIN vendors v ON v.id = jl.vendor_id
    LEFT JOIN bank_transactions b ON b.journal_line_id = jl.id
    WHERE jl.account_id = ? AND (jl.reconciliation_id IS NULL OR jl.reconciliation_id = ?) AND je.date <= ? AND (? IS NULL OR je.date >= ?)
    ORDER BY je.date, jl.id`, rec.account_id, rec.id, rec.statement_date, rec.start_date, rec.start_date);
  const done = rec.status === 'completed';
  const isCleared = l => done ? l.reconciliation_id === rec.id : !!l.cleared;
  const shown = done ? lines.filter(l => l.reconciliation_id === rec.id) : lines;
  const net = l => (l.debit - l.credit) * sign;
  const cleared = shown.filter(isCleared);
  const clearedBalance = r2(rec.beginning_balance + cleared.reduce((s, l) => s + net(l), 0));
  return {
    ...rec, lines: shown.map(l => ({ ...l, cleared: isCleared(l) ? 1 : 0, amount: r2(net(l)) })),
    cleared_in: r2(cleared.filter(l => net(l) > 0).reduce((s, l) => s + net(l), 0)),
    cleared_out: r2(cleared.filter(l => net(l) < 0).reduce((s, l) => s + net(l), 0)),
    cleared_balance: clearedBalance, difference: r2(rec.statement_balance - clearedBalance),
    unmatched_bank_lines: get(db, "SELECT COUNT(*) n FROM bank_transactions WHERE account_id = ? AND status = 'unmatched' AND date <= ?", rec.account_id, rec.statement_date).n,
  };
}
function setCleared(db, id, lineIds, cleared) {
  const rec = get(db, 'SELECT * FROM reconciliations WHERE id = ?', id);
  if (!rec || rec.status !== 'in_progress') throw err('Reconciliation is not in progress');
  for (const lid of lineIds) run(db, 'UPDATE journal_lines SET cleared = ? WHERE id = ? AND account_id = ? AND reconciliation_id IS NULL', cleared ? 1 : 0, lid, rec.account_id);
}
function finishReconciliation(db, id, userId) {
  const st = reconciliationState(db, id);
  if (st.status !== 'in_progress') throw err('Already completed');
  if (Math.abs(st.difference) >= 0.005) throw err(`Difference is ${st.difference.toFixed(2)} — it must be 0.00 to finish`);
  for (const l of st.lines) if (l.cleared) run(db, 'UPDATE journal_lines SET reconciliation_id = ? WHERE id = ?', id, l.id);
  // first reconciliation: anything before the statement start is already in the opening balance
  if (st.start_date) run(db, `UPDATE journal_lines SET reconciliation_id = ?, cleared = 1 WHERE account_id = ? AND reconciliation_id IS NULL
    AND entry_id IN (SELECT id FROM journal_entries WHERE date < ?)`, id, st.account_id, st.start_date);
  run(db, "UPDATE reconciliations SET status = 'completed', completed_at = datetime('now'), completed_by = ? WHERE id = ?", userId || null, id);
}
function undoReconciliation(db, id) {
  const rec = get(db, 'SELECT * FROM reconciliations WHERE id = ?', id);
  if (!rec || rec.status !== 'completed') throw err('Only completed reconciliations can be undone');
  const later = get(db, "SELECT id FROM reconciliations WHERE account_id = ? AND id != ? AND statement_date >= ? AND status = 'completed'", rec.account_id, rec.id, rec.statement_date);
  if (later) throw err('Undo the most recent reconciliation first');
  run(db, 'UPDATE journal_lines SET reconciliation_id = NULL WHERE reconciliation_id = ?', id);
  run(db, "UPDATE reconciliations SET status = 'in_progress', completed_at = NULL, completed_by = NULL WHERE id = ?", id);
}
function bankSummary(db) {
  const bal = A.balances(db, { to: '9999-12-31' });
  return bal.filter(a => ['bank', 'credit_card'].includes(a.subtype) && a.active).map(a => {
    const last = get(db, "SELECT statement_date, statement_balance FROM reconciliations WHERE account_id = ? AND status = 'completed' ORDER BY statement_date DESC LIMIT 1", a.id);
    const open = get(db, "SELECT id, statement_date FROM reconciliations WHERE account_id = ? AND status = 'in_progress'", a.id);
    const t = get(db, `SELECT SUM(status = 'unmatched') unmatched, MAX(date) last_date FROM bank_transactions WHERE account_id = ?`, a.id);
    const bankBal = get(db, 'SELECT SUM(amount) v FROM bank_transactions WHERE account_id = ? AND status != ?', a.id, 'excluded').v;
    return { id: a.id, number: a.number, name: a.name, type: a.type, subtype: a.subtype, book_balance: a.balance,
      last_reconciled: last, open_reconciliation: open, to_review: t.unmatched || 0, last_import_date: t.last_date, imported_total: r2(bankBal) };
  });
}

module.exports = { parseCSV, parseOFX, importStatement, autoMatch, candidates, matchTo, listTransactions, categorize, applyToInvoice, ruleFor,
  startReconciliation, reconciliationState, setCleared, finishReconciliation, undoReconciliation, bankSummary };
