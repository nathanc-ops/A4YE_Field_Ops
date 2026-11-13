'use strict';
// Plaid bank feeds, run against a stand-in Plaid API (PLAID_API_BASE).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const d = n => { const x = new Date(); x.setDate(x.getDate() + n); return x.toISOString().slice(0, 10); };

// ---- fake Plaid
const fake = { calls: [], pages: [], failSync: null, removed: [] };
const plaidServer = http.createServer((req, res) => {
  let body = ''; req.on('data', c => body += c); req.on('end', () => {
    const b = JSON.parse(body || '{}'); fake.calls.push({ path: req.url, body: b });
    const send = (code, o) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (b.client_id !== 'cid' || b.secret !== 'sek') return send(400, { error_code: 'INVALID_API_KEYS', error_message: 'bad keys' });
    switch (req.url) {
      case '/link/token/create': return send(200, { link_token: 'link-sandbox-123', expiration: '2030-01-01T00:00:00Z' });
      case '/item/public_token/exchange': return send(200, { access_token: 'access-sandbox-abc', item_id: 'item-1' });
      case '/accounts/get': return send(200, { accounts: [
        { account_id: 'acc-chk', name: 'Business Checking', mask: '4321', type: 'depository', subtype: 'checking', balances: { current: 5000, available: 4900 } },
        { account_id: 'acc-card', name: 'Rewards Visa', mask: '0546', type: 'credit', subtype: 'credit card', balances: { current: 812.5 } },
        { account_id: 'acc-loan', name: 'Truck loan', mask: '9999', type: 'loan', subtype: 'auto', balances: { current: 30000 } }] });
      case '/transactions/sync':
        if (fake.failSync) return send(400, { error_code: fake.failSync, error_message: 'the login details of this item have changed' });
        return send(200, fake.pages.shift() || { added: [], modified: [], removed: [], next_cursor: b.cursor || 'c0', has_more: false });
      case '/item/remove': fake.removed.push(b.access_token); return send(200, {});
      default: return send(404, { error_code: 'NOT_FOUND', error_message: req.url });
    }
  });
});

let server, base, db, tok, checking, card;
async function call(method, path, body) {
  const res = await fetch(base + '/api' + path, { method, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json() };
}

before(async () => {
  await new Promise(r => plaidServer.listen(0, '127.0.0.1', r));
  process.env.PLAID_API_BASE = `http://127.0.0.1:${plaidServer.address().port}`;
  const D = require('../server/db');
  const { createApp } = require('../server/app');
  db = D.open(':memory:');
  server = createApp(db).listen(0);
  await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  tok = (await call('POST', '/setup', { name: 'Owner', email: 'o@x.com', password: 'longenough' })).data.token;
  const accts = (await call('GET', '/accounts')).data;
  checking = accts.find(a => a.number === '1000').id;
  card = accts.find(a => a.number === '2050').id;
});
after(() => { server.close(); plaidServer.close(); delete process.env.PLAID_API_BASE; });

test('without keys the feed says so; the secret is never sent back to the browser', async () => {
  let r = await call('GET', '/banking/plaid');
  assert.equal(r.data.configured, false);
  r = await call('POST', '/banking/plaid/link-token', {});
  assert.equal(r.status, 400); assert.match(r.data.error, /not set up/);
  r = await call('PUT', '/settings', { plaid_client_id: 'cid', plaid_secret: 'sek', plaid_env: 'sandbox' });
  assert.equal(r.data.plaid_secret, ''); assert.equal(r.data.plaid_secret_set, '1');
  assert.equal((await call('GET', '/banking/plaid')).data.configured, true);
});

test('connect: link token, exchange, accounts listed with no access token exposed', async () => {
  let r = await call('POST', '/banking/plaid/link-token', {});
  assert.equal(r.data.link_token, 'link-sandbox-123');
  const lt = fake.calls.find(c => c.path === '/link/token/create').body;
  assert.deepEqual(lt.products, ['transactions']);
  r = await call('POST', '/banking/plaid/exchange', { public_token: 'public-sandbox-x', institution: { name: 'Mountain America CU', institution_id: 'ins_1' } });
  assert.equal(r.status, 200);
  assert.equal(r.data.institution_name, 'Mountain America CU');
  assert.equal(r.data.accounts.length, 3);
  assert.equal(r.data.ready, false, 'needs mapping before syncing');
  assert.ok(!JSON.stringify(r.data).includes('access-sandbox-abc'));
  assert.ok(!JSON.stringify((await call('GET', '/banking/plaid')).data).includes('access-sandbox-abc'));
  const loan = r.data.accounts.find(a => a.kind === 'loan');
  assert.equal(loan.ignored, 1, 'loans are off by default');
  // the activity log hides the token too
  const log = (await call('GET', '/integrations/plaid/log')).data;
  assert.ok(log.length && !log.some(l => l.detail.includes('access-sandbox-abc')));
});

test('sync waits for mapping, then brings settled transactions in with the right signs and auto-matches', async () => {
  const item = (await call('GET', '/banking/plaid')).data.items[0];
  let r = await call('POST', `/banking/plaid/items/${item.id}/sync`);
  assert.match(r.data.skipped, /Map every account/);
  assert.equal(fake.calls.filter(c => c.path === '/transactions/sync').length, 0, 'cursor not moved before mapping');

  const chk = item.accounts.find(a => a.kind === 'bank'), vis = item.accounts.find(a => a.kind === 'credit_card');
  assert.equal((await call('PUT', '/banking/plaid/accounts/' + chk.id, { ledger_account_id: card })).status, 200);
  r = await call('PUT', '/banking/plaid/accounts/' + vis.id, { ledger_account_id: card });
  assert.equal(r.status, 400, 'one ledger account per feed'); assert.match(r.data.error, /already fed/);
  await call('PUT', '/banking/plaid/accounts/' + chk.id, { ledger_account_id: checking, start_date: d(-10) });
  await call('PUT', '/banking/plaid/accounts/' + vis.id, { ledger_account_id: card, start_date: d(-10) });
  r = await call('PUT', '/banking/plaid/accounts/' + chk.id, { ledger_account_id: 99999 });
  assert.equal(r.status, 400);

  // an expense already in the books, paid from checking, should auto-match
  await call('POST', '/expenses', { date: d(-3), category: 'Rent', amount: 2400, vendor: 'Landlord' });
  fake.pages = [
    { added: [
      { transaction_id: 't1', account_id: 'acc-chk', amount: 2400, date: d(-3), name: 'ONLINE PMT LANDLORD', pending: false },
      { transaction_id: 't2', account_id: 'acc-chk', amount: -1250, date: d(-2), name: 'MOBILE DEPOSIT', pending: false },
      { transaction_id: 't3', account_id: 'acc-chk', amount: 61.4, date: d(-1), name: 'SHELL OIL 5521', merchant_name: 'Shell', pending: true },
      { transaction_id: 't4', account_id: 'acc-chk', amount: 15, date: d(-30), name: 'OLD FEE', pending: false },
    ], modified: [], removed: [], next_cursor: 'c1', has_more: true },
    { added: [
      { transaction_id: 't5', account_id: 'acc-card', amount: 84.12, date: d(-2), name: 'HOME DEPOT #4410', merchant_name: 'The Home Depot', pending: false },
      { transaction_id: 't6', account_id: 'acc-card', amount: -500, date: d(-1), name: 'PAYMENT THANK YOU', pending: false },
      { transaction_id: 't7', account_id: 'acc-loan', amount: 600, date: d(-1), name: 'LOAN PMT', pending: false },
    ], modified: [], removed: [], next_cursor: 'c2', has_more: false }];
  r = await call('POST', `/banking/plaid/items/${item.id}/sync`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual([r.data.added, r.data.matched, r.data.skipped], [4, 1, 3], 'pending, before-start and ignored-account lines are skipped');
  const syncs = fake.calls.filter(c => c.path === '/transactions/sync');
  assert.equal(syncs.length, 2); assert.equal(syncs[0].body.cursor, undefined); assert.equal(syncs[1].body.cursor, 'c1');

  const chkTx = (await call('GET', `/banking/transactions?account_id=${checking}`)).data;
  assert.deepEqual(chkTx.map(t => [t.amount, t.status]).sort(), [[-2400, 'matched'], [1250, 'unmatched']]);
  const cardTx = (await call('GET', `/banking/transactions?account_id=${card}`)).data;
  assert.deepEqual(cardTx.map(t => t.amount).sort((a, b) => a - b), [-84.12, 500], 'card: purchase is money out, payment is money in');
  assert.equal(cardTx.find(t => t.amount === -84.12).description, 'HOME DEPOT #4410 · The Home Depot');
  const ov = (await call('GET', '/banking/plaid')).data.items[0];
  assert.equal(ov.status, 'ok'); assert.equal(ov.last_sync_added, 4);
});

test('re-sync is idempotent; modified updates only unreviewed lines; removed drops them', async () => {
  const item = (await call('GET', '/banking/plaid')).data.items[0];
  fake.pages = [{ added: [{ transaction_id: 't2', account_id: 'acc-chk', amount: -1250, date: d(-2), name: 'MOBILE DEPOSIT', pending: false }],
    modified: [{ transaction_id: 't1', account_id: 'acc-chk', amount: 9999, date: d(-3), name: 'CHANGED', pending: false },
               { transaction_id: 't5', account_id: 'acc-card', amount: 84.5, date: d(-2), name: 'HOME DEPOT #4410', pending: false }],
    removed: [{ transaction_id: 't6' }], next_cursor: 'c3', has_more: false }];
  const r = await call('POST', `/banking/plaid/items/${item.id}/sync`);
  assert.deepEqual([r.data.added, r.data.updated, r.data.removed], [0, 1, 1]);
  const chkTx = (await call('GET', `/banking/transactions?account_id=${checking}`)).data;
  assert.equal(chkTx.find(t => t.status === 'matched').amount, -2400, 'a matched line is left alone');
  const cardTx = (await call('GET', `/banking/transactions?account_id=${card}`)).data;
  assert.deepEqual(cardTx.map(t => t.amount), [-84.5]);
});

test('a statement imported by hand suggests the next day as the feed start', async () => {
  const P = require('../server/plaid');
  await call('POST', '/banking/import', { account_id: checking, filename: 's.csv', content: `Date,Description,Amount\n${d(5)},X,-1.00\n` });
  assert.equal(P.suggestStart(db, checking), d(6));
});

test('bank asks to sign in again: flagged, skipped by sync-all, cleared after reconnecting', async () => {
  const item = (await call('GET', '/banking/plaid')).data.items[0];
  fake.failSync = 'ITEM_LOGIN_REQUIRED';
  let r = await call('POST', `/banking/plaid/items/${item.id}/sync`);
  assert.equal(r.status, 400);
  assert.equal((await call('GET', '/banking/plaid')).data.items[0].status, 'login_required');
  const before = fake.calls.filter(c => c.path === '/transactions/sync').length;
  r = await call('POST', '/banking/plaid/sync');
  assert.deepEqual(r.data, []);
  assert.equal(fake.calls.filter(c => c.path === '/transactions/sync').length, before);
  r = await call('POST', '/banking/plaid/link-token', { item_id: item.id });
  const upd = fake.calls.filter(c => c.path === '/link/token/create').pop().body;
  assert.equal(upd.access_token, 'access-sandbox-abc'); assert.equal(upd.products, undefined, 'update mode');
  fake.failSync = null;
  r = await call('POST', `/banking/plaid/items/${item.id}/reconnected`);
  assert.equal(r.status, 200);
  assert.equal((await call('GET', '/banking/plaid')).data.items[0].status, 'ok');
});

test('disconnect removes the item at Plaid and keeps the books', async () => {
  const item = (await call('GET', '/banking/plaid')).data.items[0];
  const r = await call('DELETE', '/banking/plaid/items/' + item.id);
  assert.equal(r.status, 200);
  assert.deepEqual(fake.removed, ['access-sandbox-abc']);
  assert.equal((await call('GET', '/banking/plaid')).data.items.length, 0);
  assert.ok((await call('GET', `/banking/transactions?account_id=${checking}`)).data.some(t => t.status === 'matched'));
});

test('techs cannot reach bank feeds', async () => {
  await call('POST', '/users', { name: 'Tech', email: 't@x.com', password: 'longenough', role: 'tech' });
  const saved = tok;
  tok = (await call('POST', '/login', { email: 't@x.com', password: 'longenough' })).data.token;
  const r = await call('GET', '/banking/plaid');
  tok = saved;
  assert.equal(r.status, 403);
});
