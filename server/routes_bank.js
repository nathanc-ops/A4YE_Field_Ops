'use strict';
// Banking API (admin only): statement import, review/match, rules, reconciliation.
const { all, get, run } = require('./db');
const B = require('./banking');

module.exports = function routesBank(app, db, X) {
  const { wrap, bad, admin, pick, insert, update } = X;

  app.get('/api/banking/accounts', admin, wrap((req, res) => res.json(B.bankSummary(db))));
  app.post('/api/banking/import', admin, wrap((req, res) => {
    const { account_id, filename, content, flip } = req.body;
    if (!content) throw bad('File is empty');
    if (content.length > 5e6) throw bad('File is too large (5 MB max)');
    res.json(B.importStatement(db, { accountId: Number(account_id), filename, content: String(content), flip: !!flip, userId: req.user.id }));
  }));
  app.get('/api/banking/imports', admin, wrap((req, res) => res.json(all(db, `SELECT i.*, a.name account_name, u.name user_name FROM bank_imports i JOIN accounts a ON a.id = i.account_id
    LEFT JOIN users u ON u.id = i.created_by ORDER BY i.id DESC LIMIT 50`))));
  app.get('/api/banking/transactions', admin, wrap((req, res) => res.json(B.listTransactions(db, Number(req.query.account_id), req.query.status || null))));
  app.post('/api/banking/auto-match', admin, wrap((req, res) => res.json({ matched: B.autoMatch(db, Number(req.body.account_id)) })));
  app.get('/api/banking/transactions/:id/candidates', admin, wrap((req, res) => {
    const tx = get(db, 'SELECT * FROM bank_transactions WHERE id = ?', req.params.id);
    if (!tx) throw bad('Not found', 404);
    res.json(B.candidates(db, tx, { any: true }).slice(0, 50));
  }));
  app.post('/api/banking/transactions/:id/match', admin, wrap((req, res) => { B.matchTo(db, Number(req.params.id), Number(req.body.journal_line_id)); res.json({ ok: true }); }));
  app.post('/api/banking/transactions/:id/unmatch', admin, wrap((req, res) => {
    const tx = get(db, 'SELECT * FROM bank_transactions WHERE id = ?', req.params.id);
    if (!tx) throw bad('Not found', 404);
    if (tx.journal_line_id && get(db, 'SELECT reconciliation_id r FROM journal_lines WHERE id = ?', tx.journal_line_id)?.r) throw bad('That line is on a completed reconciliation');
    if (tx.journal_line_id) run(db, 'UPDATE journal_lines SET cleared = 0 WHERE id = ? AND reconciliation_id IS NULL', tx.journal_line_id);
    run(db, "UPDATE bank_transactions SET status = 'unmatched', journal_line_id = NULL WHERE id = ?", tx.id);
    res.json({ ok: true });
  }));
  app.post('/api/banking/transactions/:id/exclude', admin, wrap((req, res) => {
    const tx = get(db, 'SELECT * FROM bank_transactions WHERE id = ?', req.params.id);
    if (!tx || tx.status === 'matched') throw bad('Only unmatched lines can be excluded');
    run(db, 'UPDATE bank_transactions SET status = ? WHERE id = ?', req.body.include ? 'unmatched' : 'excluded', tx.id);
    res.json({ ok: true });
  }));
  app.post('/api/banking/transactions/:id/categorize', admin, wrap((req, res) => res.json(B.categorize(db, Number(req.params.id), req.body, req.user.id))));
  app.post('/api/banking/transactions/:id/apply-invoice', admin, wrap((req, res) => res.json(B.applyToInvoice(db, Number(req.params.id), Number(req.body.invoice_id)))));

  const RULE = ['match_text', 'direction', 'account_id', 'category', 'vendor', 'active'];
  app.get('/api/banking/rules', admin, wrap((req, res) => res.json(all(db, 'SELECT r.*, a.number account_number, a.name account_name FROM bank_rules r JOIN accounts a ON a.id = r.account_id ORDER BY r.match_text'))));
  app.post('/api/banking/rules', admin, wrap((req, res) => { if (!req.body.match_text || !req.body.account_id) throw bad('Text and account are required'); res.json({ id: insert('bank_rules', pick(req.body, RULE)) }); }));
  app.put('/api/banking/rules/:id', admin, wrap((req, res) => { update('bank_rules', req.params.id, pick(req.body, RULE)); res.json({ ok: true }); }));
  app.delete('/api/banking/rules/:id', admin, wrap((req, res) => { run(db, 'DELETE FROM bank_rules WHERE id = ?', req.params.id); res.json({ ok: true }); }));

  app.get('/api/reconciliations', admin, wrap((req, res) => res.json(all(db, `SELECT r.*, a.name account_name, u.name completed_by_name FROM reconciliations r JOIN accounts a ON a.id = r.account_id
    LEFT JOIN users u ON u.id = r.completed_by ${req.query.account_id ? 'WHERE r.account_id = ?' : ''} ORDER BY r.statement_date DESC, r.id DESC`, ...(req.query.account_id ? [req.query.account_id] : [])))));
  app.post('/api/reconciliations', admin, wrap((req, res) => {
    const { account_id, statement_date, statement_balance, start_date, beginning_balance } = req.body;
    if (!statement_date || statement_balance == null || statement_balance === '') throw bad('Statement end date and ending balance are required');
    res.json({ id: B.startReconciliation(db, { accountId: Number(account_id), statementDate: statement_date, statementBalance: Number(statement_balance), startDate: start_date || null, beginningBalance: beginning_balance }) });
  }));
  app.get('/api/reconciliations/:id', admin, wrap((req, res) => res.json(B.reconciliationState(db, Number(req.params.id)))));
  app.put('/api/reconciliations/:id', admin, wrap((req, res) => {
    const r = get(db, 'SELECT * FROM reconciliations WHERE id = ?', req.params.id);
    if (!r || r.status !== 'in_progress') throw bad('Reconciliation is not in progress');
    if (req.body.statement_date || req.body.statement_balance != null)
      run(db, 'UPDATE reconciliations SET statement_date = COALESCE(?, statement_date), statement_balance = COALESCE(?, statement_balance) WHERE id = ?', req.body.statement_date || null, req.body.statement_balance ?? null, r.id);
    if (Array.isArray(req.body.line_ids)) B.setCleared(db, r.id, req.body.line_ids, !!req.body.cleared);
    res.json(B.reconciliationState(db, r.id));
  }));
  app.post('/api/reconciliations/:id/finish', admin, wrap((req, res) => { B.finishReconciliation(db, Number(req.params.id), req.user.id); res.json({ ok: true }); }));
  app.post('/api/reconciliations/:id/undo', admin, wrap((req, res) => { B.undoReconciliation(db, Number(req.params.id)); res.json({ ok: true }); }));
  app.delete('/api/reconciliations/:id', admin, wrap((req, res) => {
    const r = get(db, 'SELECT * FROM reconciliations WHERE id = ?', req.params.id);
    if (!r || r.status !== 'in_progress') throw bad('Only an in-progress reconciliation can be discarded');
    run(db, 'DELETE FROM reconciliations WHERE id = ?', r.id); res.json({ ok: true });
  }));
};
