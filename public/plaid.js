'use strict';
// Plaid bank feeds: the "Bank feeds" panel on Accounting → Banking, Plaid Link, and account mapping.
// The bank sign-in happens inside Plaid Link (Plaid's window); this app never sees bank usernames or passwords.

const PLAID_LINK_JS = 'https://cdn.plaid.com/link/v2/stable/link-initialize.js';
let plaidScript;
function loadPlaidLink() {
  if (window.Plaid) return Promise.resolve();
  plaidScript = plaidScript || new Promise((res, rej) => {
    const s = document.createElement('script'); s.src = PLAID_LINK_JS; s.onload = res;
    s.onerror = () => { plaidScript = null; rej(new Error("Couldn't load Plaid Link. Check the internet connection or an ad blocker.")); };
    document.head.append(s);
  });
  return plaidScript;
}

// Open Plaid Link. itemId = re-sign-in (update mode) for an existing connection. oauthUri = coming back from a bank's own sign-in page.
async function openPlaidLink({ itemId = null, oauthUri = null } = {}) {
  await loadPlaidLink();
  let token;
  if (oauthUri) {
    try { ({ token, itemId } = JSON.parse(sessionStorage.getItem('plaid_link') || '{}')); } catch { token = null; }
    if (!token) throw new Error('The bank sign-in took too long to come back. Start Connect a bank again.');
  } else {
    token = (await act(() => POST('/banking/plaid/link-token', itemId ? { item_id: itemId } : {}))).link_token;
    sessionStorage.setItem('plaid_link', JSON.stringify({ token, itemId }));   // needed if the bank sends us out to its own site (OAuth)
  }
  return new Promise(resolve => {
    const handler = Plaid.create({
      token, ...(oauthUri ? { receivedRedirectUri: oauthUri } : {}),
      onSuccess: async (publicToken, meta) => {
        sessionStorage.removeItem('plaid_link');
        try {
          if (itemId) {
            const r = await act(() => POST(`/banking/plaid/items/${itemId}/reconnected`), 'Bank reconnected');
            if (r.added) toast(`${r.added} new transaction(s) brought in`);
            resolve(null);
          } else {
            const item = await act(() => POST('/banking/plaid/exchange', { public_token: publicToken, institution: meta && meta.institution }), `${(meta && meta.institution && meta.institution.name) || 'Bank'} connected`);
            resolve(item);
          }
        } catch { resolve(null); }
      },
      onExit: (e) => { if (e && e.display_message) toast(e.display_message, true); resolve(null); },
    });
    handler.open();
  });
}

// Map each account at the bank to a bank / credit card account in the chart of accounts.
async function plaidMapModal(item, onDone) {
  const ledger = (await GET('/accounts')).filter(a => ['bank', 'credit_card'].includes(a.subtype) && a.active !== 0);
  const opts = ledger.map(a => [a.id, `${a.number} ${a.name}${a.subtype === 'credit_card' ? ' (card)' : ''}`]);
  const guess = pa => {
    if (pa.ledger_account_id) return pa.ledger_account_id;
    const want = pa.kind === 'credit_card' ? 'credit_card' : 'bank';
    const byMask = pa.mask && ledger.find(a => a.subtype === want && String(a.name).includes(pa.mask));
    return byMask ? byMask.id : '';
  };
  const m = modal(`<form><h2>${esc(item.institution_name)} — choose where each account goes</h2>
    <p class="small muted">Pick the account in your chart of accounts each one feeds. The start date keeps the feed from bringing in transactions you already imported from a statement (it suggests the day after the last line already there). Plaid can reach back up to about two years.</p>
    ${table([{ label: 'At the bank', html: a => `<b>${esc(a.name)}</b>${a.mask ? ` <span class="muted">••${esc(a.mask)}</span>` : ''}<div class="small muted">${esc(label(a.kind || ''))}${a.current_balance != null ? ` · balance ${money(a.current_balance)}` : ''}</div>` },
      { label: 'Goes to', html: a => `<select data-acct="${a.id}"><option value="ignore" ${a.ignored ? 'selected' : ''}>Don't import</option>${opts.map(([v, l]) => `<option value="${v}" ${!a.ignored && String(guess(a)) === String(v) ? 'selected' : ''}>${esc(l)}</option>`).join('')}${!a.ignored && !guess(a) ? '<option value="" selected>— choose —</option>' : ''}</select>` },
      { label: 'Bring in from', html: a => `<input type="date" data-start="${a.id}" value="${esc(a.start_date || a.suggested_start || '')}">` }], item.accounts, { empty: 'Plaid returned no accounts' })}
    ${!opts.length ? '<div class="alert">No bank or credit card accounts in the chart of accounts yet. Add one (Detail = Bank account or Credit card) first.</div>' : ''}
    <div class="actions"><button type="button" class="btn" data-x>Later</button><button class="btn primary">Save &amp; sync</button></div></form>`, { wide: true });
  const form = $('form', m.el);
  $('[data-x]', form).onclick = () => { m.close(); onDone && onDone(); };
  form.onsubmit = async e => {
    e.preventDefault();
    const btn = $('button.primary', form); btn.disabled = true;
    try {
      for (const a of item.accounts) {
        const v = $(`[data-acct="${a.id}"]`, form).value;
        if (!v) throw new Error(`Choose where ${a.name}${a.mask ? ' ••' + a.mask : ''} goes, or "Don't import"`);
        await PUT('/banking/plaid/accounts/' + a.id, v === 'ignore' ? { ignored: 1 } : { ledger_account_id: Number(v), start_date: $(`[data-start="${a.id}"]`, form).value });
      }
      const r = await POST(`/banking/plaid/items/${item.id}/sync`);
      toast(r.skipped ? r.skipped : `${r.added} transaction(s) brought in, ${r.matched} matched automatically`);
      m.close(); onDone && onDone();
    } catch (err) { toast(err.message, true); } finally { btn.disabled = false; }
  };
}

const plaidStatus = it => it.status === 'login_required' ? '<span class="pill bad">Sign in again</span>'
  : it.status === 'error' ? '<span class="pill warn">Problem</span>' : !it.ready ? '<span class="pill warn">Needs mapping</span>' : '<span class="pill good">Connected</span>';

// The panel at the top of Accounting → Banking.
async function plaidFeeds(el, reload) {
  let ov;
  try { ov = await GET('/banking/plaid'); } catch { el.innerHTML = ''; return; }
  if (!ov.configured) {
    el.innerHTML = `<div class="card" style="margin-bottom:14px"><div class="row spread"><h2>Bank feeds</h2><a class="btn sm" href="#/settings">Set up Plaid</a></div>
      <p class="small muted">Connect the business bank and card accounts so transactions come in on their own every hour, instead of importing statements. Add your Plaid keys under Settings → Integrations – Plaid first.</p></div>`;
    return;
  }
  el.innerHTML = `<div class="card" style="margin-bottom:14px"><div class="row spread"><h2>Bank feeds ${ov.env === 'sandbox' ? '<span class="pill warn">Sandbox — test data</span>' : ''}</h2>
      <div class="row">${ov.items.length ? '<button class="btn" id="plaidsyncall">Sync now</button>' : ''}<button class="btn primary" id="plaidconnect">+ Connect a bank</button></div></div>
    <p class="small muted">You sign in to your bank inside Plaid's window; this app never sees the bank password. New transactions land below in "To review" every hour${ov.auto_sync ? '' : ' (hourly sync is off — use Sync now)'}.</p>
    ${table([{ label: 'Bank', html: it => `<b>${esc(it.institution_name)}</b><div class="small muted">${it.accounts.filter(a => !a.ignored).map(a => `${esc(a.name)}${a.mask ? ' ••' + esc(a.mask) : ''}${a.ledger_number ? ` → ${esc(a.ledger_number)} ${esc(a.ledger_name)}` : ' → <i>not mapped</i>'}`).join('<br>') || 'No accounts imported'}</div>` },
      { label: 'Status', html: it => `${plaidStatus(it)}${it.error ? `<div class="small" style="color:var(--bad)">${esc(it.error)}</div>` : ''}` },
      { label: 'Last sync', html: it => it.last_sync_at ? `${fmtDT(it.last_sync_at)}<div class="small muted">${it.last_sync_added || 0} new</div>` : '<span class="muted small">Not yet</span>' },
      { label: '', html: it => `<div class="status-btns">${it.status === 'login_required' ? `<button class="btn sm primary" data-prelink="${it.id}">Sign in again</button>` : `<button class="btn sm" data-psync="${it.id}">Sync</button>`}
        <button class="btn sm ${it.ready ? '' : 'primary'}" data-pmap="${it.id}">Accounts</button><button class="btn sm danger" data-pdel="${it.id}" title="Disconnect">✕</button></div>` }],
      ov.items, { empty: 'No banks connected yet.' })}</div>`;
  const byId = id => ov.items.find(i => i.id === Number(id));
  $('#plaidconnect', el).onclick = async () => { const item = await openPlaidLink().catch(e => { toast(e.message, true); return null; }); if (item) plaidMapModal(item, reload); };
  if ($('#plaidsyncall', el)) $('#plaidsyncall', el).onclick = async () => {
    const rs = await act(() => POST('/banking/plaid/sync'));
    const ok = rs.filter(r => !r.error && !r.skipped), bad = rs.filter(r => r.error);
    toast(`${ok.reduce((s, r) => s + r.added, 0)} new transaction(s), ${ok.reduce((s, r) => s + r.matched, 0)} matched`);
    for (const r of bad) toast(`${r.institution}: ${r.error}`, true);
    reload();
  };
  $$('[data-psync]', el).forEach(b => b.onclick = async () => { const r = await act(() => POST(`/banking/plaid/items/${b.dataset.psync}/sync`)); toast(r.skipped || `${r.added} new, ${r.matched} matched`, !!r.skipped); reload(); });
  $$('[data-pmap]', el).forEach(b => b.onclick = () => plaidMapModal(byId(b.dataset.pmap), reload));
  $$('[data-prelink]', el).forEach(b => b.onclick = async () => { await openPlaidLink({ itemId: Number(b.dataset.prelink) }).catch(e => toast(e.message, true)); reload(); });
  $$('[data-pdel]', el).forEach(b => b.onclick = async () => {
    const it = byId(b.dataset.pdel);
    if (!confirm(`Disconnect ${it.institution_name}? New transactions stop coming in. Lines already brought in, matched or reconciled stay in the books.`)) return;
    await act(() => DEL('/banking/plaid/items/' + it.id), 'Disconnected'); reload();
  });
}

// Coming back from a bank's own sign-in page (OAuth): /plaid-oauth.html sends us here with the full return URL.
async function resumePlaidOAuth(params, reload) {
  const uri = params.get('plaid_oauth'); if (!uri) return;
  history.replaceState(null, '', location.pathname + '#/accounting?tab=banking');
  const item = await openPlaidLink({ oauthUri: uri }).catch(e => { toast(e.message, true); return null; });
  if (item) plaidMapModal(item, reload); else reload();
}
