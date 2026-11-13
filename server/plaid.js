'use strict';
// Plaid bank feeds — built against the Plaid REST API (https://plaid.com/docs/api), no SDK.
//
//  Flow: the office clicks "Connect a bank" → the server makes a link token → Plaid Link opens in the browser and
//  the account holder signs in to their bank there (credentials go to Plaid, never to this server) → Link returns a
//  public token → the server swaps it for an access token, kept only in this database and never sent to browsers.
//  Each Plaid account is mapped to a bank or credit card account in the chart of accounts, with a start date.
//
//  Transactions come in through /transactions/sync (cursor based) and land in bank_transactions exactly like an
//  imported statement (fit_id = "plaid:<transaction_id>"), so auto-match, "Add expense", rules and reconciliation all
//  work unchanged. Pending transactions are skipped; they arrive once they post.
//
//  Sign: Plaid amounts are positive when money leaves the account (a purchase, or a charge on a card). Our bank lines
//  are + money in / − money out for both banks and cards, so every Plaid amount is negated.
const { all, get, run, settings } = require('./db');
const B = require('./banking');

const BASES = { sandbox: 'https://sandbox.plaid.com', production: 'https://production.plaid.com' };
const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
const err = (m, s = 400, code) => Object.assign(new Error(m), { status: s, plaid_code: code });

function config(db) {
  const s = settings(db);
  const env = (process.env.PLAID_ENV || s.plaid_env) === 'production' ? 'production' : 'sandbox';
  const clientId = process.env.PLAID_CLIENT_ID || s.plaid_client_id || '';
  const secret = process.env.PLAID_SECRET || s.plaid_secret || '';
  return {
    env, clientId, secret, configured: !!(clientId && secret),
    base: (process.env.PLAID_API_BASE || BASES[env]).replace(/\/+$/, ''),     // PLAID_API_BASE only for tests
    redirectUri: s.plaid_redirect_uri || '',
    companyName: s.company_name || 'All 4 You Electrical',
  };
}
function log(db, event, status, detail) {
  run(db, 'INSERT INTO integration_log (provider, direction, event, status, detail) VALUES (?,?,?,?,?)',
    'plaid', 'out', event, status, (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 4000));
}
// never write tokens into the activity log
const scrub = o => JSON.parse(JSON.stringify(o || {}, (k, v) => /token|secret/i.test(k) && typeof v === 'string' ? '[hidden]' : v));

async function call(db, path, body) {
  const c = config(db);
  if (!c.configured) throw err('Plaid is not set up. Add the client ID and secret under Settings → Integrations – Plaid.');
  let res;
  try {
    res = await fetch(c.base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: c.clientId, secret: c.secret, ...body }), signal: AbortSignal.timeout(60000) });
  } catch { throw err("Can't reach Plaid right now. Check the server's internet connection and try again.", 502); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    log(db, path, `http_${res.status}`, { error_code: data.error_code, error_message: data.error_message, request_id: data.request_id });
    throw err(`Plaid: ${data.display_message || data.error_message || 'request failed'}${data.error_code ? ` (${data.error_code})` : ''}`, res.status >= 500 ? 502 : 400, data.error_code);
  }
  if (path !== '/transactions/sync') log(db, path, 'ok', scrub(data));
  return data;
}

// ------------------------------------------------------------ linking
async function linkToken(db, { userId, itemId } = {}) {
  const c = config(db);
  const body = { client_name: c.companyName.slice(0, 30), user: { client_user_id: `fieldops-user-${userId || 0}` }, country_codes: ['US'], language: 'en' };
  if (c.redirectUri) body.redirect_uri = c.redirectUri;
  if (itemId) {                                       // update mode: the bank asked the account holder to sign in again
    const item = get(db, 'SELECT * FROM plaid_items WHERE id = ?', itemId);
    if (!item) throw err('That bank connection was not found', 404);
    body.access_token = item.access_token;
  } else {
    body.products = ['transactions'];
    body.transactions = { days_requested: 730 };
  }
  const r = await call(db, '/link/token/create', body);
  return { link_token: r.link_token, expiration: r.expiration };
}

const ACCOUNT_SUBTYPE = a => a.type === 'credit' ? 'credit_card' : a.type === 'depository' ? 'bank' : a.type;
async function refreshAccounts(db, itemId) {
  const item = get(db, 'SELECT * FROM plaid_items WHERE id = ?', itemId);
  const r = await call(db, '/accounts/get', { access_token: item.access_token });
  for (const a of r.accounts || []) {
    const kind = ACCOUNT_SUBTYPE(a);
    const have = get(db, 'SELECT id FROM plaid_accounts WHERE plaid_account_id = ?', a.account_id);
    if (have) run(db, 'UPDATE plaid_accounts SET name = ?, official_name = ?, mask = ?, kind = ?, current_balance = ?, available_balance = ? WHERE id = ?',
      a.name, a.official_name || null, a.mask || null, kind, a.balances?.current ?? null, a.balances?.available ?? null, have.id);
    else run(db, `INSERT INTO plaid_accounts (item_id, plaid_account_id, name, official_name, mask, kind, current_balance, available_balance, ignored)
      VALUES (?,?,?,?,?,?,?,?,?)`, item.id, a.account_id, a.name, a.official_name || null, a.mask || null, kind,
      a.balances?.current ?? null, a.balances?.available ?? null, ['bank', 'credit_card'].includes(kind) ? 0 : 1);   // loans/investments: off by default
  }
  return listAccounts(db, item.id);
}
async function exchange(db, { publicToken, institution, userId }) {
  if (!publicToken) throw err('Missing public token from Plaid Link');
  const r = await call(db, '/item/public_token/exchange', { public_token: publicToken });
  const existing = get(db, 'SELECT id FROM plaid_items WHERE item_id = ?', r.item_id);
  let id;
  if (existing) { run(db, "UPDATE plaid_items SET access_token = ?, status = 'ok', error = NULL WHERE id = ?", r.access_token, existing.id); id = existing.id; }
  else id = Number(run(db, 'INSERT INTO plaid_items (item_id, access_token, institution_id, institution_name, created_by) VALUES (?,?,?,?,?)',
    r.item_id, r.access_token, institution?.institution_id || null, institution?.name || 'Bank', userId || null).lastInsertRowid);
  await refreshAccounts(db, id);
  return itemView(db, id);
}

// ------------------------------------------------------------ mapping
function listAccounts(db, itemId) {
  return all(db, `SELECT pa.id, pa.item_id, pa.name, pa.official_name, pa.mask, pa.kind, pa.current_balance, pa.available_balance, pa.ledger_account_id,
      pa.start_date, pa.ignored, a.number ledger_number, a.name ledger_name
    FROM plaid_accounts pa LEFT JOIN accounts a ON a.id = pa.ledger_account_id WHERE pa.item_id = ? ORDER BY pa.kind, pa.name`, itemId);
}
// suggested start date: the day after the newest line already on that ledger account (so a statement you imported
// by hand isn't brought in twice), otherwise the first of this month
function suggestStart(db, ledgerAccountId) {
  const last = ledgerAccountId && get(db, 'SELECT MAX(date) d FROM bank_transactions WHERE account_id = ?', ledgerAccountId)?.d;
  if (last) { const d = new Date(last + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); }
  const t = new Date(); return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-01`;
}
function mapAccount(db, id, b) {
  const pa = get(db, 'SELECT * FROM plaid_accounts WHERE id = ?', id);
  if (!pa) throw err('Not found', 404);
  if (b.ignored) { run(db, 'UPDATE plaid_accounts SET ignored = 1 WHERE id = ?', id); return; }
  const ledger = get(db, 'SELECT * FROM accounts WHERE id = ?', b.ledger_account_id);
  if (!ledger || !['bank', 'credit_card'].includes(ledger.subtype)) throw err('Pick a bank or credit card account from the chart of accounts');
  const other = get(db, 'SELECT id FROM plaid_accounts WHERE ledger_account_id = ? AND id != ? AND ignored = 0', ledger.id, id);
  if (other) throw err(`${ledger.number} ${ledger.name} is already fed by another bank account`);
  if (pa.ledger_account_id && pa.ledger_account_id !== ledger.id && get(db, 'SELECT 1 FROM bank_transactions WHERE plaid_account_id = ? LIMIT 1', id))
    throw err('Transactions from this account are already in the books under another account; disconnect and reconnect to move it');
  const start = /^\d{4}-\d{2}-\d{2}$/.test(b.start_date || '') ? b.start_date : suggestStart(db, ledger.id);
  run(db, 'UPDATE plaid_accounts SET ledger_account_id = ?, start_date = ?, ignored = 0 WHERE id = ?', ledger.id, start, id);
}

// ------------------------------------------------------------ syncing
// An item syncs only when every account on it is either mapped or set to "don't import" — otherwise the cursor would
// move past transactions for an account nobody has mapped yet, and they'd never come in.
function readyToSync(db, itemId) {
  return !get(db, 'SELECT 1 FROM plaid_accounts WHERE item_id = ? AND ignored = 0 AND ledger_account_id IS NULL', itemId);
}
function describe(t) {
  const name = t.merchant_name && t.name && !t.name.toUpperCase().includes(t.merchant_name.toUpperCase()) ? `${t.name} · ${t.merchant_name}` : (t.name || t.merchant_name);
  return name || '(no description)';
}
async function syncItem(db, itemId) {
  const item = get(db, 'SELECT * FROM plaid_items WHERE id = ?', itemId);
  if (!item) throw err('That bank connection was not found', 404);
  if (!readyToSync(db, item.id)) return { item_id: item.id, skipped: 'Map every account (or mark it "Don\'t import") before the first sync', added: 0, updated: 0, removed: 0, matched: 0 };
  const accts = new Map(all(db, 'SELECT * FROM plaid_accounts WHERE item_id = ?', item.id).map(a => [a.plaid_account_id, a]));
  let cursor = item.cursor || undefined, added = 0, updated = 0, removed = 0, skipped = 0, pages = 0;
  const touched = new Set();
  try {
    for (;;) {
      const r = await call(db, '/transactions/sync', { access_token: item.access_token, cursor, count: 500 });
      for (const t of r.added || []) {
        const a = accts.get(t.account_id);
        if (!a || a.ignored || !a.ledger_account_id || t.pending || (a.start_date && t.date < a.start_date)) { skipped++; continue; }
        const info = run(db, `INSERT OR IGNORE INTO bank_transactions (account_id, import_id, date, amount, description, reference, fit_id, plaid_account_id)
          VALUES (?,?,?,?,?,?,?,?)`, a.ledger_account_id, null, t.date, r2(-t.amount), describe(t), t.check_number || null, 'plaid:' + t.transaction_id, a.id);
        if (info.changes) { added++; touched.add(a.ledger_account_id); }
      }
      for (const t of r.modified || []) {
        const a = accts.get(t.account_id); if (!a || !a.ledger_account_id || t.pending) continue;
        // only lines nobody has acted on yet are changed; matched or excluded lines stay as the office left them
        const info = run(db, "UPDATE bank_transactions SET date = ?, amount = ?, description = ? WHERE account_id = ? AND fit_id = ? AND status = 'unmatched'",
          t.date, r2(-t.amount), describe(t), a.ledger_account_id, 'plaid:' + t.transaction_id);
        if (info.changes) { updated++; touched.add(a.ledger_account_id); }
      }
      for (const t of r.removed || []) {
        const info = run(db, "DELETE FROM bank_transactions WHERE fit_id = ? AND status = 'unmatched'", 'plaid:' + t.transaction_id);
        removed += Number(info.changes);
      }
      cursor = r.next_cursor;
      run(db, 'UPDATE plaid_items SET cursor = ? WHERE id = ?', cursor, item.id);   // saved per page, so a failure mid-way doesn't repeat work
      if (!r.has_more || ++pages > 200) break;
    }
  } catch (e) {
    const relink = ['ITEM_LOGIN_REQUIRED', 'PENDING_EXPIRATION', 'ITEM_LOCKED', 'USER_PERMISSION_REVOKED', 'ACCESS_NOT_GRANTED', 'NO_ACCOUNTS'].includes(e.plaid_code);
    run(db, "UPDATE plaid_items SET status = ?, error = ?, last_sync_at = datetime('now') WHERE id = ?", relink ? 'login_required' : 'error', e.message, item.id);
    throw e;
  }
  let matched = 0;
  for (const acct of touched) matched += B.autoMatch(db, acct);
  run(db, "UPDATE plaid_items SET status = 'ok', error = NULL, last_sync_at = datetime('now'), last_sync_added = ? WHERE id = ?", added, item.id);
  try { await refreshAccounts(db, item.id); } catch { /* balances are a nice-to-have */ }
  return { item_id: item.id, institution: item.institution_name, added, updated, removed, skipped, matched };
}
async function syncAll(db) {
  const out = [];
  for (const it of all(db, "SELECT id, institution_name FROM plaid_items WHERE status != 'login_required' ORDER BY id")) {
    try { out.push(await syncItem(db, it.id)); } catch (e) { out.push({ item_id: it.id, institution: it.institution_name, error: e.message }); }
  }
  return out;
}

// ------------------------------------------------------------ views & removal
function itemView(db, id) {
  const it = get(db, `SELECT id, item_id, institution_id, institution_name, status, error, last_sync_at, last_sync_added, created_at FROM plaid_items WHERE id = ?`, id);
  if (!it) return null;
  const accounts = listAccounts(db, id).map(a => ({ ...a, suggested_start: a.start_date || suggestStart(db, a.ledger_account_id) }));
  return { ...it, accounts, ready: readyToSync(db, id) };
}
function overview(db) {
  const c = config(db);
  return { configured: c.configured, env: c.env, oauth: !!c.redirectUri, auto_sync: settings(db).plaid_auto_sync !== '0',
    items: all(db, 'SELECT id FROM plaid_items ORDER BY institution_name, id').map(r => itemView(db, r.id)) };
}
async function removeItem(db, id) {
  const item = get(db, 'SELECT * FROM plaid_items WHERE id = ?', id);
  if (!item) throw err('Not found', 404);
  try { await call(db, '/item/remove', { access_token: item.access_token }); }
  catch (e) { if (!['ITEM_NOT_FOUND', 'INVALID_ACCESS_TOKEN'].includes(e.plaid_code)) throw e; }   // already gone at Plaid: just forget it here
  // bank lines already brought in stay (they're your records); they just stop being linked to the feed
  run(db, 'UPDATE bank_transactions SET plaid_account_id = NULL WHERE plaid_account_id IN (SELECT id FROM plaid_accounts WHERE item_id = ?)', id);
  run(db, 'DELETE FROM plaid_accounts WHERE item_id = ?', id);
  run(db, 'DELETE FROM plaid_items WHERE id = ?', id);
}

module.exports = { config, linkToken, exchange, refreshAccounts, mapAccount, syncItem, syncAll, overview, itemView, removeItem, suggestStart, readyToSync };
