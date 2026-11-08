'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const D = require('../server/db');
const B = require('../server/banking');
const { createApp } = require('../server/app');

let server, base, db, tok, checking, card;
async function call(method, path, body) {
  const res = await fetch(base + '/api' + path, { method, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json() };
}
const d = n => { const x = new Date(); x.setDate(x.getDate() + n); return x.toISOString().slice(0, 10); };
const us = iso => { const [y, m, dd] = iso.split('-'); return `${m}/${dd}/${y}`; };

before(async () => {
  db = D.open(':memory:');
  server = createApp(db).listen(0);
  await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  tok = (await call('POST', '/setup', { name: 'Owner', email: 'o@x.com', password: 'longenough' })).data.token;
  const accts = (await call('GET', '/accounts')).data;
  checking = accts.find(a => a.number === '1000').id;
  card = accts.find(a => a.number === '2050').id;
});
after(() => server.close());

test('CSV parser handles single amount, debit/credit columns, parentheses and quotes', () => {
  const a = B.parseCSV('Date,Description,Amount\n11/03/2026,"HOME DEPOT #4410, BOISE",-84.12\n2026-11-04,DEPOSIT,"1,250.00"\n11/05/26,FEE,(5.00)\n');
  assert.deepEqual(a.map(t => [t.date, t.amount]), [['2026-11-03', -84.12], ['2026-11-04', 1250], ['2026-11-05', -5]]);
  assert.equal(a[0].description, 'HOME DEPOT #4410, BOISE');
  const b = B.parseCSV('Account summary\n\nPosting Date,Details,Debit,Credit,Check or Slip #\n11/06/2026,CHECK 1042,350.00,,1042\n11/07/2026,ACH CREDIT,,900.00,\n');
  assert.deepEqual(b.map(t => [t.amount, t.reference]), [[-350, '1042'], [900, null]]);
});

test('OFX parser reads STMTTRN blocks with FITIDs', () => {
  const ofx = `OFXHEADER:100\n<OFX><BANKTRANLIST><STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261102120000<TRNAMT>-42.50<FITID>A1<NAME>SHELL OIL 123</STMTTRN>
    <STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20261103<TRNAMT>500.00<FITID>A2<NAME>MOBILE DEPOSIT<MEMO>INV-1001</STMTTRN></BANKTRANLIST></OFX>`;
  const t = B.parseOFX(ofx);
  assert.deepEqual(t.map(x => [x.date, x.amount, x.fit_id]), [['2026-11-02', -42.5, 'A1'], ['2026-11-03', 500, 'A2']]);
  assert.equal(t[1].description, 'MOBILE DEPOSIT · INV-1001');
});

test('import de-duplicates, auto-matches recorded transactions, and suggests categories', async () => {
  // an expense already entered in the app (paid from checking) and a customer payment
  const cust = (await call('POST', '/customers', { name: 'Pat', email: 'pat@x.com', location: { address: '1 Elm' } })).data.id;
  const inv = (await call('POST', '/invoices', { customer_id: cust, tax_rate: 0, items: [{ description: 'Service', qty: 1, unit_price: 1250 }] })).data.id;
  await call('POST', `/invoices/${inv}/send`, {});
  const inv2 = (await call('POST', '/invoices', { customer_id: cust, tax_rate: 0, items: [{ description: 'Panel', qty: 1, unit_price: 900 }] })).data.id;
  await call('POST', `/invoices/${inv2}/send`, {});
  await call('POST', `/invoices/${inv}/payments`, { amount: 1250, paid_at: d(-3), method: 'check' });
  await call('POST', '/expenses', { date: d(-4), category: 'Rent', amount: 2400, vendor: 'Landlord' });

  const csv = `Date,Description,Amount\n${us(d(-4))},ONLINE PMT LANDLORD,-2400.00\n${us(d(-2))},MOBILE DEPOSIT,1250.00\n${us(d(-2))},SHELL OIL 5521,-61.40\n${us(d(-1))},SHELL OIL 5521,-61.40\n${us(d(-1))},ACH CREDIT PAT,900.00\n${us(d(0))},MONTHLY SERVICE FEE,-15.00\n`;
  let r = await call('POST', '/banking/import', { account_id: checking, filename: 'nov.csv', content: csv });
  assert.equal(r.status, 200);
  assert.deepEqual([r.data.added, r.data.duplicates, r.data.matched], [6, 0, 2]);
  r = await call('POST', '/banking/import', { account_id: checking, filename: 'nov.csv', content: csv });
  assert.deepEqual([r.data.added, r.data.duplicates], [0, 6], 're-import adds nothing');

  const txs = (await call('GET', `/banking/transactions?account_id=${checking}&status=unmatched`)).data;
  assert.equal(txs.length, 4);
  const shell = txs.find(t => /SHELL/.test(t.description));
  assert.equal(shell.rule.account_number, '6300');
  const ach = txs.find(t => /ACH CREDIT/.test(t.description));
  assert.equal(ach.invoice_suggestions[0].id, inv2);
});

test('categorize creates an expense (and a rule); deposit applies to invoice; transfer becomes a JE', async () => {
  const txs = (await call('GET', `/banking/transactions?account_id=${checking}&status=unmatched`)).data;
  const fuel = (await call('GET', '/accounts')).data.find(a => a.number === '6300').id;
  const fee = txs.find(t => /SERVICE FEE/.test(t.description));
  const bankFees = (await call('GET', '/accounts')).data.find(a => a.number === '6800').id;
  let r = await call('POST', `/banking/transactions/${fee.id}/categorize`, { account_id: bankFees, category: 'Bank & card fees', vendor: 'Bank', save_rule: true, rule_text: 'MONTHLY SERVICE' });
  assert.equal(r.status, 200);
  const exp = (await call('GET', '/expenses')).data.find(e => e.amount === 15);
  assert.ok(exp, 'expense was created');
  assert.equal(exp.paid_from_account_id, checking);
  for (const s of txs.filter(t => /SHELL/.test(t.description))) await call('POST', `/banking/transactions/${s.id}/categorize`, { account_id: fuel, category: 'Vehicles & fuel', vendor: 'Shell' });
  const ach = txs.find(t => /ACH CREDIT/.test(t.description));
  r = await call('POST', `/banking/transactions/${ach.id}/apply-invoice`, { invoice_id: ach.invoice_suggestions[0].id });
  assert.equal(r.status, 200);
  const inv = (await call('GET', `/invoices/${ach.invoice_suggestions[0].id}`)).data;
  assert.equal(inv.status, 'paid');
  assert.equal((await call('GET', `/banking/transactions?account_id=${checking}&status=unmatched`)).data.length, 0);
  assert.ok((await call('GET', '/banking/rules')).data.some(x => x.match_text === 'MONTHLY SERVICE'));

  // card payment from checking: categorize the card-side line as a transfer from checking
  const cardCsv = `Date,Description,Amount\n${us(d(-1))},PAYMENT THANK YOU,500.00\n${us(d(-1))},LOWES #1182,-212.33\n`;
  await call('POST', '/banking/import', { account_id: card, filename: 'card.csv', content: cardCsv });
  const ctx = (await call('GET', `/banking/transactions?account_id=${card}&status=unmatched`)).data;
  const pay = ctx.find(t => /PAYMENT/.test(t.description));
  r = await call('POST', `/banking/transactions/${pay.id}/categorize`, { account_id: checking });
  assert.equal(r.status, 200);
  // the matching withdrawal on the checking statement auto-matches that transfer
  const chk2 = `Date,Description,Amount\n${us(d(-1))},CARD AUTOPAY,-500.00\n`;
  const m = (await call('POST', '/banking/import', { account_id: checking, filename: 'chk2.csv', content: chk2 })).data;
  assert.equal(m.matched, 1);
});

test('reconcile to zero, then reconciled transactions are locked until undone', async () => {
  // bank shows: -2400 +1250 -61.40 -61.40 +900 -15 -500 = -887.80 from a zero start
  let r = await call('POST', '/reconciliations', { account_id: checking, statement_date: d(0), statement_balance: -887.80 });
  const id = r.data.id;
  let st = (await call('GET', `/reconciliations/${id}`)).data;
  assert.equal(st.difference, 0, 'bank-matched lines arrive pre-cleared');
  // unclear one, can't finish
  const fee = st.lines.find(l => l.amount === -15);
  st = (await call('PUT', `/reconciliations/${id}`, { line_ids: [fee.id], cleared: false })).data;
  assert.equal(st.difference, -15);
  assert.equal((await call('POST', `/reconciliations/${id}/finish`)).status, 400);
  st = (await call('PUT', `/reconciliations/${id}`, { line_ids: [fee.id], cleared: true })).data;
  assert.equal((await call('POST', `/reconciliations/${id}/finish`)).status, 200);

  // the $15 fee expense is now locked
  const exp = (await call('GET', '/expenses')).data.find(e => e.amount === 15);
  r = await call('DELETE', `/expenses/${exp.id}`);
  assert.equal(r.status, 400);
  assert.match(r.data.error, /reconciliation/);
  assert.ok((await call('GET', '/expenses')).data.some(e => e.id === exp.id), 'delete rolled back');
  // rebuild keeps reconciled entries intact
  await call('POST', '/accounting/rebuild');
  st = (await call('GET', `/reconciliations/${id}`)).data;
  assert.equal(st.difference, 0);
  assert.equal(st.status, 'completed');

  // next statement must start where this one ended
  const next = await call('POST', '/reconciliations', { account_id: checking, statement_date: d(-10), statement_balance: 0 });
  assert.equal(next.status, 400);
  // undo unlocks
  assert.equal((await call('POST', `/reconciliations/${id}/undo`)).status, 200);
  assert.equal((await call('DELETE', `/expenses/${exp.id}`)).status, 200);
  const tb = (await call('GET', '/accounting/trial-balance')).data;
  assert.equal(tb.total_debit, tb.total_credit);
});

test('first reconciliation uses the statement opening balance and start date', async () => {
  const savings = (await call('GET', '/accounts')).data.find(a => a.number === '1050').id;
  // old history in savings (before the first statement) + one deposit during it
  await call('POST', '/journal', { date: d(-90), memo: 'Old transfer in', lines: [{ account_id: savings, debit: 1000 }, { account_id: checking, credit: 1000 }] });
  await call('POST', '/journal', { date: d(-5), memo: 'Transfer in', lines: [{ account_id: savings, debit: 250 }, { account_id: checking, credit: 250 }] });
  const id = (await call('POST', '/reconciliations', { account_id: savings, start_date: d(-30), beginning_balance: 1000, statement_date: d(0), statement_balance: 1250 })).data.id;
  let st = (await call('GET', `/reconciliations/${id}`)).data;
  assert.equal(st.lines.length, 1, 'pre-statement history is not listed');
  assert.equal(st.difference, 250);
  st = (await call('PUT', `/reconciliations/${id}`, { line_ids: [st.lines[0].id], cleared: true })).data;
  assert.equal(st.difference, 0);
  assert.equal((await call('POST', `/reconciliations/${id}/finish`)).status, 200);
  // the old line is now locked as part of the opening balance
  const je = (await call('GET', '/journal?source_type=manual')).data.find(e => e.memo === 'Old transfer in');
  assert.equal((await call('DELETE', `/journal/${je.id}`)).status, 400);
});
