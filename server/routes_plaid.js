'use strict';
// Plaid bank feeds API (admin only). See server/plaid.js.
const { all, run } = require('./db');
const P = require('./plaid');

module.exports = function routesPlaid(app, db, X) {
  const { wrap, bad, admin } = X;

  app.get('/api/banking/plaid', admin, wrap((req, res) => res.json(P.overview(db))));
  app.post('/api/banking/plaid/link-token', admin, wrap(async (req, res) => res.json(await P.linkToken(db, { userId: req.user.id, itemId: req.body.item_id ? Number(req.body.item_id) : null }))));
  app.post('/api/banking/plaid/exchange', admin, wrap(async (req, res) => {
    const { public_token, institution } = req.body || {};
    if (!public_token) throw bad('Missing public token');
    res.json(await P.exchange(db, { publicToken: String(public_token), institution, userId: req.user.id }));
  }));
  app.put('/api/banking/plaid/accounts/:id', admin, wrap((req, res) => { P.mapAccount(db, Number(req.params.id), req.body || {}); res.json({ ok: true }); }));
  app.post('/api/banking/plaid/items/:id/sync', admin, wrap(async (req, res) => res.json(await P.syncItem(db, Number(req.params.id)))));
  // after the account holder signs in again through Link (update mode)
  app.post('/api/banking/plaid/items/:id/reconnected', admin, wrap(async (req, res) => {
    run(db, "UPDATE plaid_items SET status = 'ok', error = NULL WHERE id = ?", req.params.id);
    await P.refreshAccounts(db, Number(req.params.id));
    res.json(await P.syncItem(db, Number(req.params.id)));
  }));
  app.post('/api/banking/plaid/sync', admin, wrap(async (req, res) => res.json(await P.syncAll(db))));
  app.delete('/api/banking/plaid/items/:id', admin, wrap(async (req, res) => { await P.removeItem(db, Number(req.params.id)); res.json({ ok: true }); }));
  app.get('/api/integrations/plaid/log', admin, wrap((req, res) => res.json(all(db, "SELECT * FROM integration_log WHERE provider = 'plaid' ORDER BY id DESC LIMIT 100"))));
};
