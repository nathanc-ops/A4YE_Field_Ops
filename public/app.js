'use strict';
/* A4YE Field Ops — single-page front end (no build step). */

// ============================================================ core helpers
const S = { token: localStorage.getItem('fo_token'), user: null, settings: {}, users: [], pricebook: null, costCodes: [], accounts: null, vendors: null };
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = n => (Number(n) || 0).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const money0 = n => (Number(n) || 0).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const num = (n, d = 2) => (Number(n) || 0).toLocaleString('en-US', { maximumFractionDigits: d });
const pct = n => n == null ? '—' : `${num(n, 1)}%`;
const todayStr = () => localDate(new Date());
function localDate(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
const fmtDate = s => s ? new Date(s.length === 10 ? s + 'T00:00:00' : s).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—';
const normDT = s => /^\d{4}-\d\d-\d\d \d\d:\d\d(:\d\d)?$/.test(s) ? s.replace(' ', 'T') + 'Z' : s;
const fmtDT = s => s ? new Date(normDT(s)).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—';
const fmtTime = s => s ? new Date(s).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : '';
const toLocalInput = s => { if (!s) return ''; const d = new Date(s); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };
const fromLocalInput = s => s ? new Date(s).toISOString() : null;
const isOffice = () => S.user && S.user.role !== 'tech';
const isAdmin = () => S.user && S.user.role === 'admin';
const label = s => String(s || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

const STATUS_TONE = {
  unscheduled: 'warn', scheduled: 'info', dispatched: 'accent', in_progress: 'accent', on_hold: 'warn', completed: 'good', invoiced: '', cancelled: 'bad',
  draft: '', sent: 'info', viewed: 'accent', approved: 'good', declined: 'bad', expired: 'bad', partial: 'warn', paid: 'good', void: 'bad',
  needed: 'warn', applied: 'info', issued: 'accent', rough_scheduled: 'info', rough_passed: 'good', final_scheduled: 'info', passed: 'good', failed: 'bad', closed: '',
  active: 'good', paused: 'warn', not_configured: 'warn', queued: 'info', emergency: 'bad', high: 'warn',
};
const pill = s => `<span class="pill ${STATUS_TONE[s] || ''}">${esc(label(s))}</span>`;

const JOB_STATUSES = ['unscheduled', 'scheduled', 'dispatched', 'in_progress', 'on_hold', 'completed', 'invoiced', 'cancelled'];
const JOB_TYPES = ['service', 'install', 'remodel', 'new_construction', 'commercial', 'maintenance', 'emergency', 'inspection', 'troubleshooting', 'generator', 'ev_charger', 'lighting'];
const PERMIT_STATUSES = ['needed', 'applied', 'issued', 'rough_scheduled', 'rough_passed', 'final_scheduled', 'passed', 'failed', 'closed'];
const EXPENSE_CATS = ['Materials (supply house)', 'Subcontractor', 'Equipment rental', 'Permits & fees', 'Dump/disposal', 'Rent', 'Utilities', 'Insurance', 'Vehicles & fuel', 'Tools & equipment', 'Software & phones', 'Marketing', 'Office & admin', 'Licenses & training', 'Professional services', 'Bank & card fees', 'Other'];
const LEAD_SOURCES = ['Google', 'Referral', 'Repeat', 'Website', 'Yelp', 'Facebook', 'Nextdoor', 'Home warranty', 'GC / builder', 'Truck sign', 'Other'];

async function api(method, path, body) {
  const res = await fetch('/api' + path, {
    method, headers: { 'Content-Type': 'application/json', ...(S.token ? { Authorization: 'Bearer ' + S.token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/login') { logout(true); throw new Error('Please sign in again'); }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}
const GET = p => api('GET', p);
const POST = (p, b = {}) => api('POST', p, b);
const PUT = (p, b) => api('PUT', p, b);
const DEL = p => api('DELETE', p);
const qs = o => '?' + new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '')).toString();

function toast(msg, err = false) {
  const d = document.createElement('div'); d.textContent = msg; if (err) d.className = 'err';
  $('#toast').append(d); setTimeout(() => d.remove(), err ? 6000 : 3000);
}
// Run an async action and surface errors as a toast.
async function act(fn, ok) {
  try { const r = await fn(); if (ok) toast(ok); return r; } catch (e) { toast(e.message, true); throw e; }
}

function modal(html, { wide = false } = {}) {
  const bg = document.createElement('div'); bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">${html}</div>`;
  const close = () => { bg.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = e => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  bg.addEventListener('mousedown', e => { if (e.target === bg) close(); });
  document.body.append(bg);
  const first = bg.querySelector('input, select, textarea'); if (first) first.focus();
  return { el: bg, close };
}

// fields: {name, label, type: text|number|date|datetime|select|textarea|checkbox|email|password, options: [[v, l]] | [v], full, step, required}
function fieldHtml(f, v) {
  const id = 'f_' + f.name;
  const val = v ?? f.default ?? '';
  const req = f.required ? 'required' : '';
  let input;
  if (f.type === 'select') {
    const opts = (f.options || []).map(o => Array.isArray(o) ? o : [o, label(o)]);
    input = `<select id="${id}" name="${f.name}" ${req}>${f.blank !== false ? `<option value="">${esc(f.blank || '—')}</option>` : ''}${opts.map(([ov, ol]) => `<option value="${esc(ov)}" ${String(ov) === String(val) ? 'selected' : ''}>${esc(ol)}</option>`).join('')}</select>`;
  } else if (f.type === 'textarea') input = `<textarea id="${id}" name="${f.name}" ${req}>${esc(val)}</textarea>`;
  else if (f.type === 'checkbox') return `<label class="check ${f.full ? 'full' : ''}"><input type="checkbox" name="${f.name}" ${val ? 'checked' : ''}> ${esc(f.label)}</label>`;
  else if (f.type === 'datetime') input = `<input id="${id}" type="datetime-local" name="${f.name}" value="${esc(toLocalInput(val))}" ${req}>`;
  else input = `<input id="${id}" type="${f.type || 'text'}" name="${f.name}" value="${esc(val)}" ${f.step ? `step="${f.step}"` : f.type === 'number' ? 'step="any"' : ''} ${f.placeholder ? `placeholder="${esc(f.placeholder)}"` : ''} ${f.list ? `list="${f.list}"` : ''} ${req}>`;
  return `<label class="f ${f.full ? 'full' : ''}" for="${id}"><span>${esc(f.label)}</span>${input}</label>`;
}
function readForm(form, fields) {
  const o = {};
  for (const f of fields) {
    const el = form.elements[f.name]; if (!el) continue;
    if (f.type === 'checkbox') o[f.name] = el.checked ? 1 : 0;
    else if (f.type === 'number') o[f.name] = el.value === '' ? null : Number(el.value);
    else if (f.type === 'datetime') o[f.name] = fromLocalInput(el.value);
    else o[f.name] = el.value === '' ? null : el.value;
  }
  return o;
}
function formModal({ title, fields, values = {}, submit, wide, extra = '', okLabel = 'Save' }) {
  const m = modal(`<form><h2>${esc(title)}</h2><div class="form-grid">${fields.map(f => fieldHtml(f, values[f.name])).join('')}</div>${extra}
    <div class="actions"><button type="button" class="btn" data-x>Cancel</button><button class="btn primary">${esc(okLabel)}</button></div></form>`, { wide });
  const form = $('form', m.el);
  $('[data-x]', form).onclick = m.close;
  form.onsubmit = async e => {
    e.preventDefault();
    const btn = $('button.primary', form); btn.disabled = true;
    try { await submit(readForm(form, fields), form); m.close(); } catch (err) { toast(err.message, true); } finally { btn.disabled = false; }
  };
  return m;
}
function table(cols, rows, { onClick, empty = 'Nothing here yet', foot } = {}) {
  if (!rows.length) return `<div class="empty">${esc(empty)}</div>`;
  const id = 't' + Math.random().toString(36).slice(2);
  setTimeout(() => {
    const t = document.getElementById(id); if (!t || !onClick) return;
    $$('tbody tr', t).forEach((tr, i) => tr.onclick = e => { if (!e.target.closest('a,button,input,select')) onClick(rows[i], e); });
  });
  return `<div class="table-wrap"><table id="${id}"><thead><tr>${cols.map(c => `<th class="${c.num ? 'num' : ''}">${esc(c.label)}</th>`).join('')}</tr></thead>
    <tbody>${rows.map(r => `<tr class="${onClick ? 'click' : ''}">${cols.map(c => `<td class="${c.num ? 'num' : ''}">${c.html ? c.html(r) : esc(c.get ? c.get(r) : r[c.key])}</td>`).join('')}</tr>`).join('')}</tbody>
    ${foot ? `<tfoot><tr>${foot.map(f => `<td class="${f && f.num ? 'num' : ''}">${f ? esc(f.v ?? f) : ''}</td>`).join('')}</tr></tfoot>` : ''}</table></div>`;
}
function toCSV(cols, rows, filename) {
  const cell = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = [cols.map(c => cell(c.label)).join(','), ...rows.map(r => cols.map(c => cell(c.csv ? c.csv(r) : c.get ? c.get(r) : r[c.key])).join(','))].join('\n');
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); a.download = filename; a.click();
}
async function loadUsers(force) { if (!S.users.length || force) S.users = await GET('/users'); return S.users; }
async function loadCostCodes(force) { if (!S.costCodes.length || force) S.costCodes = await GET('/cost-codes'); return S.costCodes; }
// kind: 'labor' | 'material' | 'other' — codes of that kind plus 'both'
const ccOptions = kind => S.costCodes.filter(c => !kind || c.kind === kind || c.kind === 'both').map(c => [c.id, `${c.code} · ${c.name}`]);
const ccLabel = id => { const c = S.costCodes.find(x => x.id === Number(id)); return c ? `${c.code} ${c.name}` : ''; };
async function loadAccounts(force) { if (!S.accounts || force) S.accounts = isOffice() ? await GET('/accounts') : []; return S.accounts; }
const acctOptions = (...types) => (S.accounts || []).filter(a => !types.length || types.includes(a.type) || types.includes(a.subtype)).map(a => [a.id, `${a.number} · ${a.name}`]);
async function loadVendors(force) { if (!S.vendors || force) S.vendors = await GET('/vendors'); return S.vendors; }
async function loadPricebook(force) { if (!S.pricebook || force) S.pricebook = await GET('/pricebook'); return S.pricebook; }
const techOptions = () => S.users.filter(u => u.active).map(u => [u.id, u.name]);
const userName = id => (S.users.find(u => u.id === Number(id)) || {}).name || '—';

// ============================================================ auth & shell
function logout(silent) {
  if (!silent && S.token) POST('/logout').catch(() => {});
  S.token = null; S.user = null; localStorage.removeItem('fo_token');
  renderAuth();
}
async function renderAuth() {
  const { needs_setup, brand = {} } = await GET('/setup');
  const root = $('#root');
  // "Powered by people. Built All 4 You." → two stacked lines (small word + big words)
  const tl = String(brand.tagline || '').match(/^\s*(\S+\s+\S+)\s+(.+?)\.\s*(\S+)\s+(.+?)\.?\s*$/);
  const tagline = tl ? `<div class="tagline"><div class="sm">${esc(tl[1])}</div><div class="lg red">${esc(tl[2])}.</div>
      <div class="rule"><i></i><svg width="26" height="26" viewBox="0 0 24 24" aria-hidden="true"><path fill="#fa001c" d="M14 2 4 14h7l-1 8 10-12h-7z"/></svg><i></i></div><div class="sm">${esc(tl[3])}</div><div class="lg">${esc(tl[4])}.</div></div>` : '';
  root.innerHTML = `<div class="auth"><div class="auth-box">
    ${brand.logo_url ? `<img class="logo" src="${esc(brand.logo_url)}" alt="${esc(brand.company_name || '')}">` : `<h1>${esc(brand.company_name || 'Field Ops')}</h1>`}
    <div class="label">FIELD OPS</div>${tagline}
    <p class="hint">${needs_setup ? 'First run — create the owner (admin) account.' : 'Sign in to your crew account'}</p>
    <form class="stack">
      ${needs_setup ? fieldHtml({ name: 'company_name', label: 'Company name', default: 'All 4 You Electrical' }) + fieldHtml({ name: 'name', label: 'Your name', required: true }) : ''}
      ${fieldHtml({ name: 'email', label: 'Email', type: 'email', required: true })}
      ${fieldHtml({ name: 'password', label: needs_setup ? 'Password (8+ characters)' : 'Password', type: 'password', required: true })}
      <button class="btn primary">${needs_setup ? 'Create account' : 'Sign in'}</button>
    </form></div></div>`;
  $('form', root).onsubmit = async e => {
    e.preventDefault();
    const f = e.target;
    const body = { email: f.email.value, password: f.password.value };
    if (needs_setup) Object.assign(body, { name: f.name.value, company_name: f.company_name.value });
    const r = await act(() => POST(needs_setup ? '/setup' : '/login', body));
    S.token = r.token; localStorage.setItem('fo_token', r.token);
    boot();
  };
}

const NAV = [
  { sect: 'Field' },
  { href: '#/my-day', label: 'My Day', icon: '☀', roles: ['tech'] },
  { href: '#/dashboard', label: 'Dashboard', icon: '▦', roles: ['admin', 'office'] },
  { href: '#/schedule', label: 'Schedule & Dispatch', icon: '🗓' },
  { href: '#/jobs', label: 'Jobs', icon: '🔧' },
  { href: '#/time', label: 'Time Clock', icon: '⏱' },
  { href: '#/picklists', label: 'Pick Lists', icon: '🧺', roles: ['tech'] },
  { href: '#/permits', label: 'Permits & Inspections', icon: '📋' },
  { sect: 'Sales & Billing', roles: ['admin', 'office'] },
  { href: '#/customers', label: 'Customers', icon: '👥', roles: ['admin', 'office'] },
  { href: '#/estimates', label: 'Estimates', icon: '📝', roles: ['admin', 'office'] },
  { href: '#/invoices', label: 'Invoices', icon: '💵', roles: ['admin', 'office'] },
  { href: '#/agreements', label: 'Service Agreements', icon: '🔁', roles: ['admin', 'office'] },
  { sect: 'Back Office', roles: ['admin', 'office'] },
  { href: '#/purchasing', label: 'Purchasing & Pick Lists', icon: '🚚', roles: ['admin', 'office'] },
  { href: '#/pricebook', label: 'Price Book & Inventory', icon: '📦', roles: ['admin', 'office'] },
  { href: '#/expenses', label: 'Expenses', icon: '🧾', roles: ['admin', 'office'] },
  { href: '#/reports', label: 'Reports', icon: '📈', roles: ['admin', 'office'] },
  { href: '#/accounting', label: 'Accounting', icon: '📒', roles: ['admin'] },
  { href: '#/team', label: 'Team', icon: '👷', roles: ['admin'] },
  { href: '#/settings', label: 'Settings', icon: '⚙', roles: ['admin', 'office'] },
];
function renderShell() {
  const nav = NAV.filter(n => !n.roles || n.roles.includes(S.user.role));
  $('#root').innerHTML = `<div class="app">
    <nav class="side" id="side"><div class="brand">${S.settings.logo_url ? `<img class="logo" src="${esc(S.settings.logo_url)}" alt="${esc(S.settings.company_name || '')}">` : `<span class="bolt">⚡</span> <span>${esc(S.settings.company_name || 'Field Ops')}</span>`}</div>
      ${nav.map(n => n.sect ? `<div class="sect">${esc(n.sect)}</div>` : `<a href="${n.href}" data-nav>${n.icon} &nbsp;${esc(n.label)}</a>`).join('')}
      <div class="me">${esc(S.user.name)}<br><span class="muted">${esc(label(S.user.role))}</span><br><a href="#" id="logout" style="padding:6px 0;color:var(--brand-text, #e05a4c)">Sign out</a></div>
    </nav>
    <main class="main"><div id="view"></div></main></div>`;
  $('#logout').onclick = e => { e.preventDefault(); logout(); };
}
function setTop(title, actions = '', sub = '') {
  return `<div class="topbar"><div class="row"><button class="btn menu-btn" onclick="document.getElementById('side').classList.toggle('open')">☰</button>
    <div><h1>${title}</h1>${sub ? `<div class="muted">${sub}</div>` : ''}</div></div><div class="row no-print">${actions}</div></div>`;
}

// ============================================================ router
const ROUTES = [
  [/^\/dashboard$/, viewDashboard], [/^\/my-day$/, () => viewMyDay2()], [/^\/schedule$/, () => viewScheduleHub()],
  [/^\/purchasing$/, () => viewPurchasing()], [/^\/purchasing\/po\/(new|\d+)$/, id => viewPO(id)], [/^\/(?:purchasing\/)?pick\/(\d+)$/, id => viewPickList(id)],
  [/^\/picklists$/, () => viewTechPickLists()],
  [/^\/accounting$/, () => viewAccounting()], [/^\/accounting\/reconcile\/(\d+)$/, id => viewReconcile(id)], [/^\/accounting\/ledger\/(\d+)$/, id => viewLedger(id)], [/^\/accounting\/bills\/(new|\d+)$/, id => viewBill(id)],
  [/^\/jobs$/, viewJobs], [/^\/jobs\/(\d+)$/, viewJob],
  [/^\/customers$/, viewCustomers], [/^\/customers\/(\d+)$/, viewCustomer],
  [/^\/estimates$/, viewEstimates], [/^\/estimates\/(new|\d+)$/, id => viewDoc('estimate', id)],
  [/^\/invoices$/, viewInvoices], [/^\/invoices\/(new|\d+)$/, id => viewDoc('invoice', id)],
  [/^\/time$/, viewTime], [/^\/pricebook$/, viewPricebook], [/^\/expenses$/, viewExpenses],
  [/^\/permits$/, viewPermits], [/^\/agreements$/, viewAgreements], [/^\/reports$/, viewReports],
  [/^\/team$/, viewTeam], [/^\/settings$/, viewSettings],
];
function hashParams() { const h = location.hash.slice(1); const i = h.indexOf('?'); return { path: i < 0 ? h : h.slice(0, i), params: new URLSearchParams(i < 0 ? '' : h.slice(i + 1)) }; }
async function route() {
  if (!S.user) return;
  let { path } = hashParams();
  if (!path || path === '/') { location.hash = isOffice() ? '#/dashboard' : '#/my-day'; return; }
  $$('[data-nav]').forEach(a => a.classList.toggle('active', path.startsWith(a.getAttribute('href').slice(1))));
  $('#side') && $('#side').classList.remove('open');
  clearInterval(S.timer);
  const view = $('#view');
  for (const [re, fn] of ROUTES) {
    const m = path.match(re);
    if (m) {
      view.innerHTML = '<div class="empty">Loading…</div>';
      try { await fn(...m.slice(1)); } catch (e) { view.innerHTML = `<div class="alert">${esc(e.message)}</div>`; }
      window.scrollTo(0, 0);
      return;
    }
  }
  view.innerHTML = '<div class="empty">Page not found</div>';
}
window.addEventListener('hashchange', route);
const go = h => { if (location.hash === h) route(); else location.hash = h; };

async function boot() {
  if (!S.token) return renderAuth();
  try {
    const me = await GET('/me');
    S.user = me.user; S.settings = me.settings;
    applyBrand();
    await Promise.all([loadUsers(true), loadCostCodes(true)]);
    renderShell(); route();
  } catch { /* api() already handled 401 */ }
}

// ============================================================ shared pickers
async function customerPicker(selectedId) {
  const list = await GET('/customers');
  return list.map(c => [c.id, c.company ? `${c.company} (${c.name})` : c.name]);
}
async function jobPicker() {
  const list = await GET('/jobs' + qs({ status: 'unscheduled,scheduled,dispatched,in_progress,on_hold,completed' }));
  return list.map(j => [j.id, `${j.number} · ${j.customer_name} · ${j.title}`]);
}

// ============================================================ dashboard
function bars(rows, key, labelKey) {
  const max = Math.max(1, ...rows.map(r => Math.max(0, r[key])));
  return `<div class="bars" role="img" aria-label="Monthly revenue">${rows.map(r => `<div class="b"><span class="tip">${esc(r[labelKey])}: ${money0(r[key])}<br>Net: ${money0(r.net)}</span><span class="bar" style="height:${Math.max(0, r[key]) / max * 100}%"></span></div>`).join('')}</div>
    <div class="bar-labels">${rows.map(r => `<span>${esc(new Date(r[labelKey] + '-01T00:00:00').toLocaleDateString('en-US', { month: 'short' }))}</span>`).join('')}</div>`;
}
function kpi(lbl, value, sub = '') { return `<div class="card kpi"><div class="label">${esc(lbl)}</div><div class="value">${value}</div><div class="sub">${sub}</div></div>`; }

async function viewDashboard() {
  const d = await GET('/dashboard');
  const gmOk = d.mtd.gross_margin_pct >= d.target_gross_margin;
  const overdue = d.ar.total - d.ar.buckets.current;
  $('#view').innerHTML = setTop('Dashboard', `<a class="btn" href="#/jobs?new=1">+ Book job</a><a class="btn" href="#/estimates/new">+ Estimate</a><a class="btn primary" href="#/invoices/new">+ Invoice</a>`,
    new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })) + `
    <div class="grid g4">
      ${kpi('Revenue · month to date', money0(d.mtd.revenue), `${money0(d.mtd.cash_collected)} collected`)}
      ${kpi('Gross margin · MTD', pct(d.mtd.gross_margin_pct), `<span class="pill ${gmOk ? 'good' : 'warn'}">${gmOk ? '✓ at/above' : '⚠ below'} ${d.target_gross_margin}% target</span>`)}
      ${kpi('Receivables', money0(d.ar.total), overdue > 0 ? `<span class="pill bad">⚠ ${money0(overdue)} past due</span>` : 'nothing past due')}
      ${kpi('Open estimates', money0(d.open_estimates.open_value), `${d.open_estimates.open} awaiting answer · ${pct(d.open_estimates.close_rate_pct)} close rate`)}
    </div>
    <div class="grid g2" style="margin-top:14px">
      <div class="card"><div class="row spread"><h2>Today's visits</h2><a href="#/schedule">Tech board →</a></div>
        ${table([{ label: 'Time', get: a => `${fmtTime(a.start)}–${fmtTime(a.end)}` }, { label: 'Job', html: a => `<b>${esc(a.job_number)}</b> ${esc(a.job_title)}<div class="muted small">${esc(a.customer_name)} · ${esc(a.address || '')}</div>` },
          { label: 'Tech', get: a => a.tech_names || 'Unassigned' }, { label: 'Status', html: a => pill(a.status) }], d.today_jobs, { onClick: a => go('#/jobs/' + a.job_id), empty: 'No visits scheduled today' })}
        ${d.unscheduled ? `<div class="alert" style="margin-top:10px">${d.unscheduled} job(s) waiting to be scheduled. <a href="#/schedule">Schedule them</a></div>` : ''}
      </div>
      <div class="card"><h2>Revenue — last 6 months</h2>${bars(d.trend, 'revenue', 'month')}
        <div class="small muted" style="margin-top:8px">Hover a bar for net profit. Full detail in <a href="#/reports">Reports</a>.</div></div>
    </div>
    <div class="grid g3" style="margin-top:14px">
      <div class="card"><h2>Ready to invoice</h2>${table([{ label: 'Job', html: j => `<b>${esc(j.number)}</b> ${esc(j.title)}<div class="muted small">${esc(j.customer_name)}</div>` },
        { label: '', html: j => `<button class="btn sm primary" data-inv="${j.id}">Invoice</button>` }], d.to_invoice, { onClick: j => go('#/jobs/' + j.id), empty: 'All completed jobs are invoiced' })}</div>
      <div class="card"><h2>On the clock now</h2>${table([{ label: 'Who', key: 'user_name' }, { label: 'On', get: t => t.job_number ? `${t.job_number} ${t.job_title}` : label(t.kind) }, { label: 'Since', get: t => fmtTime(t.clock_in) }], d.clocked_in, { empty: 'Nobody is clocked in' })}</div>
      <div class="card"><h2>Watch list</h2>
        ${d.inspections_upcoming.map(p => `<div class="row spread" style="padding:4px 0"><span>📋 ${esc(p.permit_type || 'Inspection')} · <a href="#/jobs/${p.job_id}">${esc(p.job_number)}</a></span><span class="muted">${fmtDate(p.inspection_date)}</span></div>`).join('')}
        ${d.agreements_due.map(a => `<div class="row spread" style="padding:4px 0"><span>🔁 ${esc(a.customer_name)} — ${esc(a.name)}</span><span class="muted">${fmtDate(a.next_visit)}</span></div>`).join('')}
        ${d.low_stock.map(p => `<div class="row spread" style="padding:4px 0"><span>📦 Low stock: ${esc(p.name)}</span><span class="pill warn">${num(p.qty_on_hand)} left</span></div>`).join('')}
        ${d.ar.invoices.filter(i => i.days_past_due > 0).slice(0, 5).map(i => `<div class="row spread" style="padding:4px 0"><span>💵 <a href="#/invoices/${i.id}">${esc(i.number)}</a> ${esc(i.customer_name)}</span><span class="pill bad">${i.days_past_due}d · ${money0(i.balance)}</span></div>`).join('')}
        ${!d.inspections_upcoming.length && !d.agreements_due.length && !d.low_stock.length && !d.ar.invoices.some(i => i.days_past_due > 0) ? '<div class="empty">All clear</div>' : ''}
      </div>
    </div>`;
  $$('[data-inv]').forEach(b => b.onclick = async () => { const r = await act(() => POST(`/jobs/${b.dataset.inv}/invoice`), 'Invoice created'); go('#/invoices/' + r.id); });
}

// ============================================================ time clock widget
function elapsed(from) { const s = Math.max(0, Math.floor((Date.now() - new Date(from)) / 1000)); return `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; }
async function clockCard(el, { jobId } = {}) {
  const { open } = await GET('/time/status');
  const myJobs = await GET('/jobs' + qs({ mine: 1, status: 'scheduled,dispatched,in_progress,on_hold,unscheduled' }));
  const draw = () => {
    el.innerHTML = `<div class="card clock">
      ${open ? `<div class="muted">Clocked in${open.job_number ? ` on <a href="#/jobs/${open.job_id}">${esc(open.job_number)} ${esc(open.job_title)}</a>` : ` — ${esc(label(open.kind))}`}${open.cost_code ? ` · ${esc(open.cost_code)} ${esc(open.cost_code_name)}` : ''} since ${fmtTime(open.clock_in)}</div>
        <div class="timer" id="timer">${elapsed(open.clock_in)}</div>` : `<div class="muted">You are off the clock</div><div class="timer">0:00:00</div>`}
      <div class="row" style="justify-content:center">
        <select id="ck_job" style="max-width:320px"><option value="">— No job (shop/training) —</option>${myJobs.map(j => `<option value="${j.id}" ${String(jobId || '') === String(j.id) ? 'selected' : ''}>${esc(j.number)} · ${esc(j.title)}</option>`).join('')}</select>
        <select id="ck_kind" style="max-width:140px">${['job', 'travel', 'shop', 'training'].map(k => `<option value="${k}">${label(k)}</option>`).join('')}</select>
        <select id="ck_cc" style="max-width:260px"><option value="">Cost code…</option>${ccOptions('labor').map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('')}</select>
      </div>
      <div class="row" style="justify-content:center;margin-top:12px">
        <button class="btn big go" id="ck_in">${open ? 'Switch job' : 'Clock in'}</button>
        ${open ? '<button class="btn big stop" id="ck_out">Clock out</button>' : ''}
      </div></div>`;
    $('#ck_in', el).onclick = async () => {
      const job_id = $('#ck_job', el).value || null; let kind = $('#ck_kind', el).value;
      if (!job_id && (kind === 'job' || kind === 'travel')) kind = 'shop';
      await act(() => POST('/time/clock-in', { job_id, kind, cost_code_id: $('#ck_cc', el).value || null }), 'Clocked in'); route();
    };
    if (open) $('#ck_out', el).onclick = async () => { await act(() => POST('/time/clock-out'), 'Clocked out'); route(); };
  };
  draw();
  if (open) S.timer = setInterval(() => { const t = $('#timer'); if (t) t.textContent = elapsed(open.clock_in); }, 1000);
}

async function viewMyDay() {
  $('#view').innerHTML = setTop(`Hi, ${esc(S.user.name.split(' ')[0])}`, '', new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })) +
    `<div id="clock"></div><div class="card" style="margin-top:14px"><h2>My jobs</h2><div id="mine"></div></div>`;
  await clockCard($('#clock'));
  const jobs = await GET('/jobs' + qs({ mine: 1, status: 'scheduled,dispatched,in_progress,on_hold' }));
  $('#mine').innerHTML = table([{ label: 'When', get: j => j.scheduled_start ? fmtDT(j.scheduled_start) : 'Not scheduled' },
    { label: 'Job', html: j => `<b>${esc(j.number)}</b> ${esc(j.title)}<div class="muted small">${esc(j.customer_name)} · ${esc([j.address, j.city].filter(Boolean).join(', '))}</div>` },
    { label: 'Status', html: j => pill(j.status) },
    { label: '', html: j => j.address ? `<a class="btn sm" target="_blank" rel="noopener" href="https://maps.google.com/?q=${encodeURIComponent([j.address, j.city, j.state, j.zip].filter(Boolean).join(' '))}">Map</a>` : '' }],
  jobs, { onClick: j => go('#/jobs/' + j.id), empty: 'No open jobs assigned to you' });
}

// ============================================================ schedule / dispatch board
async function viewSchedule() {
  const { params } = hashParams();
  const start = new Date((params.get('week') || todayStr()) + 'T00:00:00');
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7)); // Monday
  const days = [...Array(7)].map((_, i) => { const d = new Date(start); d.setDate(d.getDate() + i); return d; });
  const end = new Date(start); end.setDate(end.getDate() + 7);
  const [jobs, unsched] = await Promise.all([
    GET('/jobs' + qs({ from: start.toISOString(), to: end.toISOString() })),
    isOffice() ? GET('/jobs' + qs({ status: 'unscheduled' })) : Promise.resolve([]),
  ]);
  const techs = S.users.filter(u => u.active && (u.role === 'tech' || jobs.some(j => j.tech_ids.includes(u.id))));
  const rows = [...techs.map(t => ({ id: t.id, name: t.name, color: t.color })), { id: 0, name: 'Unassigned', color: '#94a3b8' }];
  const shift = n => { const d = new Date(start); d.setDate(d.getDate() + n); return localDate(d); };
  const chip = j => `<a class="chip ${j.priority === 'emergency' ? 'emergency' : ''} ${j.status}" draggable="${isOffice()}" data-job="${j.id}" href="#/jobs/${j.id}"
      title="${esc(j.customer_name)} — ${esc(j.title)}"><b>${j.scheduled_start ? fmtTime(j.scheduled_start) : ''}</b> ${esc(j.number)}<br>${esc(j.customer_name)}<br><span class="muted">${esc(j.title)}</span></a>`;
  const inCell = (j, d, techId) => {
    const s = new Date(j.scheduled_start), ds = localDate(d);
    if (localDate(s) !== ds) return false;
    return techId ? j.tech_ids.includes(techId) : !j.tech_ids.length;
  };
  $('#view').innerHTML = setTop('Schedule & Dispatch', `<a class="btn" href="#/schedule?week=${shift(-7)}">← Prev</a><a class="btn" href="#/schedule">This week</a><a class="btn" href="#/schedule?week=${shift(7)}">Next →</a>${isOffice() ? '<button class="btn primary" id="newjob">+ Book job</button>' : ''}`,
    `Week of ${fmtDate(localDate(start))}${isOffice() ? ' · drag jobs between techs and days to dispatch' : ''}`) +
    (isOffice() ? `<h3>Unscheduled (${unsched.length})</h3><div class="unsched" data-cell="unsched">${unsched.map(chip).join('') || '<span class="muted">Nothing waiting</span>'}</div><div style="height:14px"></div>` : '') +
    `<div class="board"><div class="h">Tech</div>${days.map(d => `<div class="h ${localDate(d) === todayStr() ? 'today' : ''}">${d.toLocaleDateString('en-US', { weekday: 'short', month: 'numeric', day: 'numeric' })}</div>`).join('')}
    ${rows.map(r => `<div class="tech"><span class="dot" style="background:${esc(r.color)}"></span>${esc(r.name)}</div>${days.map(d => `<div class="cell" data-tech="${r.id}" data-day="${localDate(d)}">${jobs.filter(j => j.scheduled_start && inCell(j, d, r.id)).map(chip).join('')}</div>`).join('')}`).join('')}</div>`;
  if (!isOffice()) return;
  $('#newjob').onclick = () => jobForm({});
  const byId = Object.fromEntries([...jobs, ...unsched].map(j => [j.id, j]));
  let dragFrom = null;
  $$('.chip').forEach(c => c.addEventListener('dragstart', e => { e.dataTransfer.setData('text/plain', c.dataset.job); const cell = c.closest('[data-tech]'); dragFrom = cell ? Number(cell.dataset.tech) : null; }));
  $$('.cell').forEach(cell => {
    cell.addEventListener('dragover', e => { e.preventDefault(); cell.classList.add('over'); });
    cell.addEventListener('dragleave', () => cell.classList.remove('over'));
    cell.addEventListener('drop', async e => {
      e.preventDefault(); cell.classList.remove('over');
      const j = byId[e.dataTransfer.getData('text/plain')]; if (!j) return;
      const toTech = Number(cell.dataset.tech);
      const oldStart = j.scheduled_start ? new Date(j.scheduled_start) : null;
      const durMs = j.scheduled_start && j.scheduled_end ? new Date(j.scheduled_end) - new Date(j.scheduled_start) : 2 * 3600000;
      const s = new Date(cell.dataset.day + 'T00:00:00');
      s.setHours(oldStart ? oldStart.getHours() : 8, oldStart ? oldStart.getMinutes() : 0);
      let techIds = j.tech_ids.filter(id => id !== dragFrom);
      if (toTech && !techIds.includes(toTech)) techIds.push(toTech);
      if (!toTech) techIds = [];
      const status = ['unscheduled'].includes(j.status) ? 'scheduled' : j.status;
      await act(() => PUT('/jobs/' + j.id, { scheduled_start: s.toISOString(), scheduled_end: new Date(s.getTime() + durMs).toISOString(), tech_ids: techIds, status }), `${j.number} moved`);
      route();
    });
  });
}

// ============================================================ jobs
async function jobForm(job, { customerId } = {}) {
  await loadUsers();
  const customers = await customerPicker();
  const fields = [
    { name: 'customer_id', label: 'Customer', type: 'select', options: customers, required: true, full: true },
    { name: 'location_id', label: 'Service location', type: 'select', options: [], full: true },
    { name: 'title', label: 'Job title', required: true, full: true, placeholder: 'e.g. Replace 100A panel with 200A' },
    { name: 'job_type', label: 'Job type', type: 'select', options: JOB_TYPES, blank: false, default: 'service' },
    { name: 'priority', label: 'Priority', type: 'select', options: ['low', 'normal', 'high', 'emergency'], blank: false, default: 'normal' },
    { name: 'scheduled_start', label: 'Start', type: 'datetime' }, { name: 'scheduled_end', label: 'End', type: 'datetime' },
    { name: 'status', label: 'Status', type: 'select', options: JOB_STATUSES, blank: 'Auto' },
    { name: 'lead_source', label: 'Lead source', type: 'select', options: LEAD_SOURCES },
    { name: 'contract_amount', label: 'Fixed-bid amount ($, optional)', type: 'number' }, { name: 'po_number', label: 'Customer PO #' },
    { name: 'budget_hours', label: 'Budgeted labor hours', type: 'number' }, { name: 'budget_materials', label: 'Budgeted material cost ($)', type: 'number' },
    { name: 'description', label: 'Scope / description', type: 'textarea', full: true },
  ];
  const techBoxes = `<div style="margin-top:10px"><label class="f"><span>Assigned techs</span></label><div class="row">${S.users.filter(u => u.active).map(u =>
    `<label class="check"><input type="checkbox" name="tech" value="${u.id}" ${(job.tech_ids || []).includes(u.id) ? 'checked' : ''}> ${esc(u.name)}</label>`).join('')}</div></div>`;
  const values = { ...job, customer_id: job.customer_id || customerId };
  const m = formModal({
    title: job.id ? `Edit ${job.number}` : 'Book a job', fields, values, wide: true, extra: techBoxes,
    submit: async (data, form) => {
      data.tech_ids = $$('input[name=tech]:checked', form).map(i => Number(i.value));
      if (data.scheduled_start && !data.scheduled_end) data.scheduled_end = new Date(new Date(data.scheduled_start).getTime() + 2 * 3600000).toISOString();
      if (!data.status) delete data.status;
      if (job.id) { await PUT('/jobs/' + job.id, data); toast('Job saved'); route(); }
      else { const r = await POST('/jobs', data); toast('Job booked'); go('#/jobs/' + r.id); }
    },
  });
  const form = $('form', m.el);
  const loadLocs = async () => {
    const cid = form.customer_id.value; const sel = form.location_id;
    if (!cid) { sel.innerHTML = '<option value="">—</option>'; return; }
    const c = await GET('/customers/' + cid);
    sel.innerHTML = `<option value="">—</option>` + c.locations.map(l => `<option value="${l.id}">${esc([l.label, l.address, l.city].filter(Boolean).join(' · '))}</option>`).join('');
    if (job.location_id && String(job.customer_id) === cid) sel.value = job.location_id;
    else if (c.locations.length === 1) sel.value = c.locations[0].id;
    if (!job.id && c.lead_source && !form.lead_source.value) form.lead_source.value = c.lead_source;
  };
  form.customer_id.onchange = loadLocs; loadLocs();
}

async function viewJobs() {
  const { params } = hashParams();
  const status = params.get('status') || (isOffice() ? 'unscheduled,scheduled,dispatched,in_progress,on_hold,completed' : '');
  const q = params.get('q') || '';
  const jobs = await GET('/jobs' + qs({ status, q }));
  const tabs = [['unscheduled,scheduled,dispatched,in_progress,on_hold,completed', 'Open'], ['unscheduled', 'Unscheduled'], ['in_progress', 'In progress'], ['completed', 'Needs invoice'], ['invoiced', 'Invoiced'], ['', 'All']];
  $('#view').innerHTML = setTop('Jobs', isOffice() ? '<button class="btn primary" id="new">+ Book job</button>' : '') + `<div class="card">
    <div class="row spread"><div class="tabs" style="margin:0;border:0">${tabs.map(([v, l]) => `<button class="${v === status ? 'on' : ''}" data-s="${v}">${l}</button>`).join('')}</div>
    <form id="srch" class="row"><input name="q" placeholder="Search job #, customer, address" value="${esc(q)}" style="width:260px"></form></div>
    ${table([{ label: 'Job', html: j => `<b>${esc(j.number)}</b>${j.priority === 'emergency' ? ' <span class="pill bad">Emergency</span>' : ''}<div>${esc(j.title)}</div>` },
      { label: 'Customer', html: j => `${esc(j.customer_name)} <span class="muted small">${esc(label(j.customer_type))}</span><div class="muted small">${esc(j.address || '')}</div>` },
      { label: 'Type', get: j => label(j.job_type) }, { label: 'Scheduled', get: j => fmtDT(j.scheduled_start) },
      { label: 'Techs', get: j => j.tech_names || '—' }, { label: 'Status', html: j => pill(j.status) }], jobs, { onClick: j => go('#/jobs/' + j.id), empty: 'No jobs match' })}</div>`;
  $$('[data-s]').forEach(b => b.onclick = () => go('#/jobs' + qs({ status: b.dataset.s, q })));
  $('#srch').onsubmit = e => { e.preventDefault(); go('#/jobs' + qs({ status, q: e.target.q.value })); };
  if (isOffice()) { $('#new').onclick = () => jobForm({}); if (params.get('new')) jobForm({}, { customerId: params.get('customer_id') }); }
}

async function viewJob(id) {
  const j = await GET('/jobs/' + id);
  const { params } = hashParams();
  const tab = params.get('tab') || 'overview';
  const loc = j.location || {};
  const addr = [loc.address, loc.city, loc.state, loc.zip].filter(Boolean).join(', ');
  const c = j.costing;
  const tabs = [['overview', 'Overview'], ['time', `Time (${j.time.length})`], ['materials', `Materials (${j.materials.length})`], ['permits', `Permits (${j.permits.length})`]];
  if (isOffice()) tabs.push(['budget', 'Cost codes & budget'], ['purchasing', `Purchasing (${(j.purchase_orders || []).length + j.pick_lists.length})`], ['billing', 'Estimates & Invoices'], ['costs', 'Other costs'], ['costing', 'Job costing']);
  else if (j.pick_lists.length) tabs.push(['purchasing', `Pick lists (${j.pick_lists.length})`]);
  const statusOpts = isOffice() ? JOB_STATUSES : ['dispatched', 'in_progress', 'on_hold', 'completed'];
  $('#view').innerHTML = setTop(`${esc(j.number)} · ${esc(j.title)}`,
    `<select id="status" style="width:auto">${(statusOpts.includes(j.status) ? statusOpts : [j.status, ...statusOpts]).map(s => `<option value="${s}" ${s === j.status ? 'selected' : ''}>${label(s)}</option>`).join('')}</select>
     ${isOffice() ? `<button class="btn" id="edit">Edit</button><a class="btn" href="#/estimates/new?job_id=${j.id}&customer_id=${j.customer_id}">+ Estimate</a><button class="btn primary" id="invoice">Create invoice</button>` : `<button class="btn go" id="clockhere">Clock in here</button>`}`,
    `${pill(j.status)} ${j.priority !== 'normal' ? pill(j.priority) : ''} · ${esc(label(j.job_type))} · ${isOffice() ? `<a href="#/customers/${j.customer_id}">${esc(j.customer_name)}</a>` : esc(j.customer_name)}`) + `
    <div class="tabs">${tabs.map(([k, l]) => `<button class="${k === tab ? 'on' : ''}" data-tab="${k}">${l}</button>`).join('')}</div><div id="tab"></div>`;
  $$('[data-tab]').forEach(b => b.onclick = () => go(`#/jobs/${j.id}?tab=${b.dataset.tab}`));
  $('#status').onchange = async e => {
    const body = { status: e.target.value };
    if (body.status === 'completed' && !isOffice()) { const n = prompt('Completion notes (what was done, anything the office should know):', j.completion_notes || ''); if (n === null) { e.target.value = j.status; return; } body.completion_notes = n; }
    await act(() => PUT('/jobs/' + j.id, body), 'Status updated'); route();
  };
  if (isOffice()) {
    $('#edit').onclick = () => jobForm(j);
    $('#invoice').onclick = async () => {
      const approved = (j.estimates || []).find(e => e.status === 'approved');
      if (!confirm(approved ? `Create an invoice from approved estimate ${approved.number}?` : 'Create an invoice from logged labor (at each tech\'s bill rate) and billable materials?')) return;
      const r = await act(() => POST(`/jobs/${j.id}/invoice`), 'Invoice created'); go('#/invoices/' + r.id);
    };
  } else $('#clockhere').onclick = async () => { await act(() => POST('/time/clock-in', { job_id: j.id, kind: 'job' }), 'Clocked in on ' + j.number); route(); };

  const T = $('#tab');
  if (tab === 'overview') {
    T.innerHTML = `<div class="grid g2"><div class="card stack">
      <h2>Site</h2><dl class="kv">
        <dt>Customer</dt><dd>${esc(j.customer_name)} ${j.customer_phone ? `· <a href="tel:${esc(j.customer_phone)}">${esc(j.customer_phone)}</a>` : ''}</dd>
        <dt>Address</dt><dd>${addr ? `<a target="_blank" rel="noopener" href="https://maps.google.com/?q=${encodeURIComponent(addr)}">${esc(addr)}</a>` : '—'}</dd>
        <dt>Service</dt><dd>${esc(loc.service_size || '—')}</dd><dt>Panel</dt><dd>${esc(loc.panel_info || '—')}</dd>
        <dt>Access</dt><dd>${esc(loc.access_notes || '—')}</dd>
        <dt>Scheduled</dt><dd>${j.scheduled_start ? `${fmtDT(j.scheduled_start)} – ${fmtTime(j.scheduled_end)}` : 'Not scheduled'}</dd>
        <dt>Techs</dt><dd>${esc(j.tech_names || 'Unassigned')}</dd>
        ${j.po_number ? `<dt>PO #</dt><dd>${esc(j.po_number)}</dd>` : ''}
        ${isOffice() && j.contract_amount ? `<dt>Contract</dt><dd>${money(j.contract_amount)}</dd>` : ''}
        ${j.budget_hours ? `<dt>Budget</dt><dd>${num(j.budget_hours)} hrs${isOffice() && j.budget_materials ? ` · ${money(j.budget_materials)} materials` : ''}</dd>` : ''}
      </dl>
      <div id="appts"></div>
      <h2>Scope</h2><div style="white-space:pre-wrap">${esc(j.description || '—')}</div>
      ${j.completion_notes ? `<h2>Completion notes</h2><div style="white-space:pre-wrap">${esc(j.completion_notes)}</div>` : ''}
    </div><div class="card"><h2>Notes & activity</h2>
      <form id="note" class="row"><input name="body" class="grow" placeholder="Add a note (visible to the team)"><button class="btn primary">Add</button></form>
      <div style="margin-top:10px">${j.notes.map(n => `<div style="padding:8px 0;border-bottom:1px solid var(--border)"><div class="small muted">${esc(n.user_name || '')} · ${fmtDT(n.created_at)}</div><div style="white-space:pre-wrap">${esc(n.body)}</div></div>`).join('') || '<div class="empty">No notes yet</div>'}</div>
    </div></div>`;
    jobAppointmentsCard(j);
    $('#note').onsubmit = async e => { e.preventDefault(); if (!e.target.body.value.trim()) return; await act(() => POST(`/jobs/${j.id}/notes`, { body: e.target.body.value })); route(); };
  }
  if (tab === 'time') {
    const total = j.time.reduce((s, t) => s + (new Date(t.clock_out || Date.now()) - new Date(t.clock_in)) / 3600000, 0);
    T.innerHTML = `<div class="card"><div class="row spread"><h2>Time on this job — ${num(total)} hrs${j.budget_hours ? ` of ${num(j.budget_hours)} budgeted` : ''}</h2>${isOffice() ? '<button class="btn" id="addtime">+ Add time</button>' : ''}</div>
      ${j.budget_hours && total > j.budget_hours ? `<div class="alert">⚠ Over budget by ${num(total - j.budget_hours)} hours</div>` : ''}
      ${table([{ label: 'Tech', key: 'user_name' }, { label: 'Type', get: t => label(t.kind) }, { label: 'Cost code', get: t => t.cost_code || '—' }, { label: 'In', get: t => fmtDT(t.clock_in) }, { label: 'Out', get: t => t.clock_out ? fmtDT(t.clock_out) : 'On the clock' },
        { label: 'Hours', num: 1, get: t => num((new Date(t.clock_out || Date.now()) - new Date(t.clock_in)) / 3600000) }, { label: 'Notes', key: 'notes' }], j.time, { empty: 'No time logged yet', onClick: isOffice() ? t => timeForm(t) : null })}</div>`;
    if (isOffice()) $('#addtime').onclick = () => timeForm({ job_id: j.id });
  }
  if (tab === 'materials') {
    const totCost = j.materials.reduce((s, m) => s + m.qty * (m.unit_cost || 0), 0);
    T.innerHTML = `<div class="card"><div class="row spread"><h2>Materials used</h2><button class="btn primary" id="addmat">+ Log material</button></div>
      ${table([{ label: 'Date', get: m => fmtDate(m.used_on) }, { label: 'Item', key: 'description' }, { label: 'Code', get: m => m.cost_code || '—' }, { label: 'Qty', num: 1, get: m => num(m.qty) }, { label: 'Source', get: m => label(m.source) },
        ...(isOffice() ? [{ label: 'Unit cost', num: 1, get: m => money(m.unit_cost) }, { label: 'Ext. cost', num: 1, get: m => money(m.qty * m.unit_cost) }] : []),
        { label: 'Bill price', num: 1, get: m => m.billable ? money(m.unit_price * m.qty) : 'No charge' }, { label: 'By', key: 'user_name' },
        ...(isOffice() ? [{ label: '', html: m => `<button class="btn sm danger" data-delmat="${m.id}">✕</button>` }] : [])],
      j.materials, { empty: 'No materials logged', foot: isOffice() ? ['', 'Total', '', '', '', '', { v: money(totCost), num: 1 }, '', '', ''] : null })}</div>`;
    $('#addmat').onclick = () => materialForm(j.id);
    $$('[data-delmat]').forEach(b => b.onclick = async () => { if (confirm('Remove this material line? Stock will be returned to inventory.')) { await act(() => DEL('/materials/' + b.dataset.delmat)); route(); } });
  }
  if (tab === 'permits') {
    T.innerHTML = `<div class="card"><div class="row spread"><h2>Permits & inspections</h2>${isOffice() ? '<button class="btn primary" id="addp">+ Permit</button>' : ''}</div>
      ${table(permitCols(false), j.permits, { empty: 'No permits on this job', onClick: isOffice() ? p => permitForm(p) : null })}</div>`;
    if (isOffice()) $('#addp').onclick = () => permitForm({ job_id: j.id });
  }
  if (tab === 'budget') jobBudgetTab(j, T);
  if (tab === 'purchasing') jobPurchasingTab(j, T);
  if (tab === 'billing') {
    T.innerHTML = `<div class="grid g2"><div class="card"><div class="row spread"><h2>Estimates</h2><a class="btn sm" href="#/estimates/new?job_id=${j.id}&customer_id=${j.customer_id}">+ Estimate</a></div>
      ${table([{ label: '#', key: 'number' }, { label: 'Title', key: 'title' }, { label: 'Status', html: e => pill(e.status) }, { label: 'Total', num: 1, get: e => money(e.total) }], j.estimates, { onClick: e => go('#/estimates/' + e.id), empty: 'No estimates' })}</div>
      <div class="card"><h2>Invoices</h2>${table([{ label: '#', key: 'number' }, { label: 'Date', get: i => fmtDate(i.issue_date) }, { label: 'Status', html: i => pill(i.status) }, { label: 'Total', num: 1, get: i => money(i.total) }, { label: 'Balance', num: 1, get: i => money(i.balance) }], j.invoices, { onClick: i => go('#/invoices/' + i.id), empty: 'No invoices yet' })}</div></div>`;
  }
  if (tab === 'costs') {
    T.innerHTML = `<div class="card"><div class="row spread"><h2>Other job costs</h2><button class="btn primary" id="addexp">+ Job cost</button></div>
      <p class="muted small">Subcontractors, equipment rental, supply-house runs not logged as materials, disposal, etc. These count as cost of goods on this job.</p>
      ${table(expenseCols(false), j.expenses, { empty: 'No other costs', onClick: e => expenseForm(e) })}</div>`;
    $('#addexp').onclick = () => expenseForm({ job_id: j.id, date: todayStr() });
  }
  if (tab === 'costing') {
    const basis = c.revenue || c.contract_amount || 0;
    T.innerHTML = `<div class="grid g4">${kpi('Revenue', money0(c.revenue), c.revenue ? `${money0(c.collected)} collected` : c.contract_amount ? `Contract ${money0(c.contract_amount)} (not yet invoiced)` : 'Not invoiced')}
      ${kpi('Total cost', money0(c.total_cost), `${num(c.hours)} labor hrs`)}
      ${kpi('Profit', money0(c.profit), basis ? '' : 'No revenue yet')}
      ${kpi('Margin', pct(c.margin_pct), c.margin_pct != null ? `<span class="pill ${c.margin_pct >= Number(S.settings.target_gross_margin) ? 'good' : 'warn'}">target ${S.settings.target_gross_margin}%</span>` : '')}</div>
      <div class="card" style="margin-top:14px"><h2>Cost breakdown</h2>
      ${table([{ label: 'Category', key: 'k' }, { label: 'Actual', num: 1, get: r => money(r.v) }, { label: 'Budget', num: 1, get: r => r.b == null ? '—' : r.money === false ? `${num(r.b)} hrs` : money(r.b) }, { label: 'Note', key: 'n' }], [
        { k: 'Labor (loaded: wage + burden)', v: c.labor_cost, n: `${num(c.hours)} hrs${c.budget_hours ? ` vs ${num(c.budget_hours)} budgeted` : ''}`, b: c.budget_hours, money: false },
        { k: 'Materials', v: c.materials_cost, b: c.budget_materials, n: `${money(c.materials_billable)} billable at sell price` },
        { k: 'Permit fees', v: c.permit_fees }, { k: 'Other job costs', v: c.other_cost }], { foot: ['Total', { v: money(c.total_cost), num: 1 }, '', ''] })}</div>`;
  }
}

function timeForm(t) {
  return jobPicker().then(jobs => formModal({
    title: t.id ? 'Edit time entry' : 'Add time entry', values: t,
    fields: [
      { name: 'user_id', label: 'Employee', type: 'select', options: techOptions(), required: true },
      { name: 'job_id', label: 'Job', type: 'select', options: jobs, blank: '— No job —' },
      { name: 'kind', label: 'Type', type: 'select', options: ['job', 'travel', 'shop', 'training', 'pto'], blank: false, default: 'job' },
      { name: 'cost_code_id', label: 'Cost code', type: 'select', options: ccOptions('labor') },
      { name: 'clock_in', label: 'Start', type: 'datetime', required: true }, { name: 'clock_out', label: 'End', type: 'datetime', required: !t.id },
      { name: 'notes', label: 'Notes', full: true },
    ],
    extra: t.id ? '<div style="margin-top:12px"><button type="button" class="btn danger" id="deltime">Delete entry</button></div>' : '',
    submit: async d => { if (t.id) await PUT('/time/' + t.id, d); else await POST('/time', d); toast('Time saved'); route(); },
  })).then(m => { const b = $('#deltime', m.el); if (b) b.onclick = async () => { if (confirm('Delete this time entry?')) { await act(() => DEL('/time/' + t.id)); m.close(); route(); } }; });
}

async function materialForm(jobId) {
  const pb = await loadPricebook(true);
  const mats = pb.filter(p => p.kind === 'material' || p.kind === 'equipment');
  const fields = [
    { name: 'pricebook_id', label: 'From price book', type: 'select', options: mats.map(p => [p.id, `${p.code ? p.code + ' · ' : ''}${p.name}${isOffice() ? ` (${num(p.qty_on_hand)} on hand)` : ''}`]), blank: '— Custom item —', full: true },
    { name: 'description', label: 'Description (custom items)', full: true },
    { name: 'qty', label: 'Quantity', type: 'number', default: 1, required: true },
    { name: 'cost_code_id', label: 'Cost code (blank = item default)', type: 'select', options: ccOptions('material') },
    { name: 'source', label: 'Came from', type: 'select', options: [['stock', 'Truck / shop stock'], ['supply_house', 'Supply house (bought for job)'], ['customer', 'Customer supplied']], blank: false },
    { name: 'unit_cost', label: 'Unit cost (custom / override)', type: 'number' },
    { name: 'unit_price', label: 'Unit sell price (custom)', type: 'number' },
    { name: 'billable', label: 'Billable to customer', type: 'checkbox', default: 1 },
  ].filter(f => isOffice() || f.name !== 'unit_cost');
  formModal({ title: 'Log material used', fields, submit: async d => { await POST(`/jobs/${jobId}/materials`, d); toast('Material logged'); route(); } });
}

// ============================================================ customers
async function customerForm(c = {}) {
  const fields = [
    { name: 'type', label: 'Type', type: 'select', options: ['residential', 'commercial'], blank: false, default: 'residential' },
    { name: 'lead_source', label: 'Lead source', type: 'select', options: LEAD_SOURCES },
    { name: 'name', label: 'Contact name', required: true }, { name: 'company', label: 'Company (commercial)' },
    { name: 'email', label: 'Email', type: 'email' }, { name: 'phone', label: 'Phone', type: 'tel' },
    { name: 'alt_phone', label: 'Alt phone', type: 'tel' }, { name: 'payment_terms_days', label: 'Payment terms (days, blank = default)', type: 'number' },
    { name: 'billing_address', label: 'Billing address', full: true },
    { name: 'tax_exempt', label: 'Tax exempt', type: 'checkbox' },
    { name: 'notes', label: 'Notes', type: 'textarea', full: true },
  ];
  const locFields = c.id ? [] : [
    { name: 'loc_address', label: 'Service address', full: true }, { name: 'loc_city', label: 'City' }, { name: 'loc_state', label: 'State' }, { name: 'loc_zip', label: 'ZIP' },
    { name: 'loc_service_size', label: 'Service size (e.g. 200A 1PH)' },
  ];
  formModal({
    title: c.id ? 'Edit customer' : 'New customer', fields: [...fields, ...locFields], values: c, wide: true,
    submit: async d => {
      const body = Object.fromEntries(Object.entries(d).filter(([k]) => !k.startsWith('loc_')));
      if (c.id) { await PUT('/customers/' + c.id, body); toast('Saved'); route(); return; }
      body.location = { address: d.loc_address, city: d.loc_city, state: d.loc_state, zip: d.loc_zip, service_size: d.loc_service_size };
      const r = await POST('/customers', body); toast('Customer added'); go('#/customers/' + r.id);
    },
  });
}
function locationForm(customerId, l = {}) {
  formModal({
    title: l.id ? 'Edit location' : 'Add service location', values: l,
    fields: [{ name: 'label', label: 'Label (e.g. Main house, Suite 4)' }, { name: 'address', label: 'Address', required: true }, { name: 'city', label: 'City' }, { name: 'state', label: 'State' }, { name: 'zip', label: 'ZIP' },
      { name: 'service_size', label: 'Service size' }, { name: 'panel_info', label: 'Panel(s) — make/model/location', full: true }, { name: 'access_notes', label: 'Access notes (gate codes, pets, site contact)', type: 'textarea', full: true }],
    submit: async d => { if (l.id) await PUT('/locations/' + l.id, d); else await POST(`/customers/${customerId}/locations`, d); toast('Saved'); route(); },
  });
}
async function viewCustomers() {
  const { params } = hashParams();
  const q = params.get('q') || '', type = params.get('type') || '';
  const list = await GET('/customers' + qs({ q, type }));
  $('#view').innerHTML = setTop('Customers', '<button class="btn primary" id="new">+ New customer</button>') + `<div class="card">
    <form id="srch" class="row"><input name="q" placeholder="Search name, company, phone, email" value="${esc(q)}" style="max-width:320px">
      <select name="type" style="width:auto"><option value="">All types</option><option ${type === 'residential' ? 'selected' : ''}>residential</option><option ${type === 'commercial' ? 'selected' : ''}>commercial</option></select><button class="btn">Search</button></form>
    ${table([{ label: 'Name', html: c => `<b>${esc(c.company || c.name)}</b>${c.company ? `<div class="muted small">${esc(c.name)}</div>` : ''}` }, { label: 'Type', html: c => pill(c.type) },
      { label: 'Phone', key: 'phone' }, { label: 'Email', key: 'email' }, { label: 'Address', key: 'primary_address' }, { label: 'Jobs', num: 1, key: 'job_count' }], list, { onClick: c => go('#/customers/' + c.id), empty: 'No customers yet' })}</div>`;
  $('#new').onclick = () => customerForm();
  $('#srch').onsubmit = e => { e.preventDefault(); go('#/customers' + qs({ q: e.target.q.value, type: e.target.type.value })); };
}
async function viewCustomer(id) {
  const c = await GET('/customers/' + id);
  $('#view').innerHTML = setTop(esc(c.company || c.name), `<button class="btn" id="edit">Edit</button><a class="btn" href="#/estimates/new?customer_id=${c.id}">+ Estimate</a><a class="btn" href="#/invoices/new?customer_id=${c.id}">+ Invoice</a><a class="btn primary" href="#/jobs?new=1&customer_id=${c.id}">+ Book job</a>`,
    `${pill(c.type)} ${c.company ? esc(c.name) + ' · ' : ''}${c.phone ? `<a href="tel:${esc(c.phone)}">${esc(c.phone)}</a>` : ''} ${c.email ? `· <a href="mailto:${esc(c.email)}">${esc(c.email)}</a>` : ''}`) + `
    <div class="grid g4">${kpi('Lifetime revenue', money0(c.lifetime_revenue))}${kpi('Open balance', money0(c.balance))}${kpi('Jobs', c.jobs.length)}${kpi('Customer since', fmtDate(c.created_at.slice(0, 10)), c.lead_source ? 'via ' + esc(c.lead_source) : '')}</div>
    <div class="grid g2" style="margin-top:14px">
      <div class="card"><div class="row spread"><h2>Service locations</h2><button class="btn sm" id="addloc">+ Location</button></div>
        ${table([{ label: 'Address', html: l => `${l.label ? `<b>${esc(l.label)}</b><br>` : ''}${esc([l.address, l.city, l.state, l.zip].filter(Boolean).join(', '))}` }, { label: 'Service', key: 'service_size' }, { label: 'Panel', key: 'panel_info' }], c.locations, { onClick: l => locationForm(c.id, l), empty: 'No locations' })}
        ${c.notes ? `<h3 style="margin-top:12px">Notes</h3><div style="white-space:pre-wrap">${esc(c.notes)}</div>` : ''}</div>
      <div class="card"><h2>Jobs</h2>${table([{ label: 'Job', html: j => `<b>${esc(j.number)}</b> ${esc(j.title)}` }, { label: 'Date', get: j => fmtDate(j.scheduled_start) }, { label: 'Status', html: j => pill(j.status) }], c.jobs, { onClick: j => go('#/jobs/' + j.id), empty: 'No jobs' })}</div>
      <div class="card"><h2>Estimates</h2>${table([{ label: '#', key: 'number' }, { label: 'Title', key: 'title' }, { label: 'Status', html: e => pill(e.status) }, { label: 'Total', num: 1, get: e => money(e.total) }], c.estimates, { onClick: e => go('#/estimates/' + e.id), empty: 'No estimates' })}</div>
      <div class="card"><h2>Invoices</h2>${table([{ label: '#', key: 'number' }, { label: 'Date', get: i => fmtDate(i.issue_date) }, { label: 'Status', html: i => pill(i.status) }, { label: 'Balance', num: 1, get: i => money(i.balance) }], c.invoices, { onClick: i => go('#/invoices/' + i.id), empty: 'No invoices' })}</div>
      ${c.agreements.length ? `<div class="card"><h2>Service agreements</h2>${table([{ label: 'Plan', key: 'name' }, { label: 'Price', get: a => `${money(a.price)} / ${a.billing_frequency}` }, { label: 'Next visit', get: a => fmtDate(a.next_visit) }, { label: 'Status', html: a => pill(a.status) }], c.agreements, { onClick: () => go('#/agreements') })}</div>` : ''}
    </div>`;
  $('#edit').onclick = () => customerForm(c);
  $('#addloc').onclick = () => locationForm(c.id);
}

// ============================================================ estimates & invoices (shared editor)
async function viewEstimates() {
  const { params } = hashParams(); const status = params.get('status') || '';
  const list = await GET('/estimates' + qs({ status }));
  const tabs = [['', 'All'], ['draft', 'Draft'], ['sent', 'Sent'], ['viewed', 'Viewed'], ['approved', 'Approved'], ['declined', 'Declined']];
  $('#view').innerHTML = setTop('Estimates', '<a class="btn primary" href="#/estimates/new">+ New estimate</a>') + `<div class="card">
    <div class="tabs">${tabs.map(([v, l]) => `<button class="${v === status ? 'on' : ''}" data-s="${v}">${l}</button>`).join('')}</div>
    ${table([{ label: '#', key: 'number' }, { label: 'Customer', key: 'customer_name' }, { label: 'Title', key: 'title' }, { label: 'Created', get: e => fmtDate(e.created_at.slice(0, 10)) },
      { label: 'Status', html: e => pill(e.status) }, { label: 'Margin', num: 1, get: e => pct(e.est_margin_pct) }, { label: 'Total', num: 1, get: e => money(e.total) }], list, { onClick: e => go('#/estimates/' + e.id), empty: 'No estimates' })}</div>`;
  $$('[data-s]').forEach(b => b.onclick = () => go('#/estimates' + qs({ status: b.dataset.s })));
}
async function viewInvoices() {
  const { params } = hashParams(); const status = params.get('status') ?? 'sent,partial';
  const list = await GET('/invoices' + qs({ status }));
  const tabs = [['sent,partial', 'Open'], ['draft', 'Draft'], ['paid', 'Paid'], ['void', 'Void'], ['', 'All']];
  const t = todayStr();
  $('#view').innerHTML = setTop('Invoices', '<a class="btn primary" href="#/invoices/new">+ New invoice</a>') + `<div class="card">
    <div class="tabs">${tabs.map(([v, l]) => `<button class="${v === status ? 'on' : ''}" data-s="${v}">${l}</button>`).join('')}</div>
    ${table([{ label: '#', key: 'number' }, { label: 'Customer', key: 'customer_name' }, { label: 'Job', key: 'job_number' }, { label: 'Issued', get: i => fmtDate(i.issue_date) },
      { label: 'Due', html: i => `${fmtDate(i.due_date)}${['sent', 'partial'].includes(i.status) && i.due_date < t ? ' <span class="pill bad">Overdue</span>' : ''}` },
      { label: 'Status', html: i => pill(i.status) }, { label: 'Total', num: 1, get: i => money(i.total) }, { label: 'Balance', num: 1, get: i => money(i.balance) }], list,
    { onClick: i => go('#/invoices/' + i.id), empty: 'No invoices', foot: list.length ? ['', '', '', '', '', 'Total', { v: money(list.reduce((s, i) => s + i.total, 0)), num: 1 }, { v: money(list.reduce((s, i) => s + i.balance, 0)), num: 1 }] : null })}</div>`;
  $$('[data-s]').forEach(b => b.onclick = () => go('#/invoices' + qs({ status: b.dataset.s })));
}

function calcTotals(doc) {
  let sub = 0, taxable = 0, cost = 0;
  for (const it of doc.items) { const l = (+it.qty || 0) * (+it.unit_price || 0); sub += l; if (it.taxable) taxable += l; cost += (+it.qty || 0) * (+it.unit_cost || 0); }
  const disc = Math.min(+doc.discount || 0, sub);
  const tax = (sub > 0 ? taxable * (1 - disc / sub) : 0) * (+doc.tax_rate || 0) / 100;
  const net = sub - disc;
  return { sub, disc, tax, total: sub - disc + tax, cost, margin: net > 0 ? (net - cost) / net * 100 : 0 };
}

async function viewDoc(kind, id) {
  const isEst = kind === 'estimate';
  const base = isEst ? '/estimates' : '/invoices';
  const { params } = hashParams();
  const [customers, pb] = await Promise.all([customerPicker(), loadPricebook(true)]);
  let doc;
  if (id === 'new') {
    doc = { items: [], customer_id: params.get('customer_id') || '', job_id: params.get('job_id') || null, discount: 0, tax_rate: null, status: 'draft' };
    if (doc.job_id) { const j = await GET('/jobs/' + doc.job_id); doc.customer_id = j.customer_id; doc.location_id = j.location_id; doc.title = j.title; }
  } else doc = await GET(`${base}/${id}`);
  const locked = isEst ? doc.status === 'approved' : (doc.status === 'void' || (doc.payments || []).length > 0);
  const st = S.settings;
  if (doc.tax_rate == null) doc.tax_rate = Number(st.default_tax_rate) || 0;

  const itemRow = (it, i) => `<tr data-i="${i}">
    <td><input class="desc" data-k="description" value="${esc(it.description)}" list="pblist" ${locked ? 'disabled' : ''}></td>
    <td><input class="n" type="number" step="any" data-k="qty" value="${esc(it.qty)}" ${locked ? 'disabled' : ''}></td>
    <td><input class="n" type="number" step="any" data-k="unit_price" value="${esc(it.unit_price)}" ${locked ? 'disabled' : ''}></td>
    <td><input class="n" type="number" step="any" data-k="unit_cost" value="${esc(it.unit_cost)}" title="Your cost — never shown to the customer" ${locked ? 'disabled' : ''}></td>
    <td><select data-k="cost_code_id" style="width:110px" ${locked ? 'disabled' : ''}><option value="">—</option>${S.costCodes.map(c => `<option value="${c.id}" ${String(c.id) === String(it.cost_code_id) ? 'selected' : ''}>${esc(c.code)} ${esc(c.name)}</option>`).join('')}</select></td>
    <td style="text-align:center"><input type="checkbox" data-k="taxable" ${it.taxable ? 'checked' : ''} ${locked ? 'disabled' : ''} style="width:auto"></td>
    <td class="num" data-line>${money((+it.qty || 0) * (+it.unit_price || 0))}</td>
    <td>${locked ? '' : `<button class="btn sm danger" data-rm="${i}" type="button">✕</button>`}</td></tr>`;

  $('#view').innerHTML = setTop(id === 'new' ? `New ${kind}` : `${isEst ? 'Estimate' : 'Invoice'} ${esc(doc.number)}`,
    id === 'new' ? '' : `${pill(doc.status)}
      <a class="btn" target="_blank" href="${esc(doc.public_url)}">Customer view ↗</a>
      ${isEst ? `${['sent', 'viewed', 'draft'].includes(doc.status) ? '<button class="btn" id="mark-approved">Mark approved</button><button class="btn" id="mark-declined">Mark declined</button>' : ''}
        ${doc.status === 'approved' && !doc.job_id ? '<button class="btn" id="tojob">Convert to job</button>' : ''}${doc.job_id ? `<a class="btn" href="#/jobs/${doc.job_id}">Open job</a>` : ''}
        <button class="btn" id="toinv">Convert to invoice</button>`
    : `${doc.job_id ? `<a class="btn" href="#/jobs/${doc.job_id}">Open job</a>` : ''}${doc.status !== 'void' && doc.balance > 0 && doc.status !== 'draft' ? '<button class="btn" id="pay">Record payment</button>' : ''}`}
      ${doc.status !== 'void' ? `<button class="btn primary" id="send">Send to customer</button>` : ''}`) + `
    <form id="docform" class="stack">
    <div class="card"><div class="form-grid">
      ${fieldHtml({ name: 'customer_id', label: 'Customer', type: 'select', options: customers, required: true }, doc.customer_id)}
      ${isEst ? fieldHtml({ name: 'location_id', label: 'Service location', type: 'select', options: [] }) : fieldHtml({ name: 'job_id', label: 'Job', type: 'select', options: [] })}
      ${fieldHtml({ name: 'title', label: isEst ? 'Estimate title' : 'Title (optional)', full: true }, doc.title)}
      ${isEst ? fieldHtml({ name: 'valid_until', label: 'Valid until', type: 'date' }, doc.valid_until) : fieldHtml({ name: 'issue_date', label: 'Issue date', type: 'date' }, doc.issue_date || todayStr()) + fieldHtml({ name: 'due_date', label: 'Due date (blank = customer terms)', type: 'date' }, doc.due_date)}
    </div></div>
    <div class="card"><div class="row spread"><h2>Line items</h2>${locked ? `<span class="muted small">${isEst ? 'Approved estimates are locked — create a new estimate for change orders.' : 'Locked: invoice is void or has payments.'}</span>` : ''}</div>
      <datalist id="pblist">${pb.map(p => `<option value="${esc(p.name)}">${esc(p.code || '')} · ${money(p.unit_price)}</option>`).join('')}</datalist>
      <div class="table-wrap"><table class="items"><thead><tr><th>Description (type to search price book)</th><th>Qty</th><th>Price</th><th>Your cost</th><th>Cost code</th><th>Tax</th><th class="num">Amount</th><th></th></tr></thead><tbody id="items"></tbody></table></div>
      ${locked ? '' : '<div class="row" style="margin-top:8px"><button type="button" class="btn" id="addline">+ Line</button><button type="button" class="btn" id="addlabor">+ Labor hours</button></div>'}
      <div class="row" style="align-items:flex-start;margin-top:14px">
        <div class="grow form-grid" style="max-width:520px">
          ${fieldHtml({ name: 'tax_rate', label: 'Tax rate %', type: 'number' }, doc.tax_rate)}${fieldHtml({ name: 'discount', label: 'Discount $', type: 'number' }, doc.discount)}
          ${fieldHtml({ name: 'notes', label: 'Notes to customer', type: 'textarea', full: true }, doc.notes)}
          ${fieldHtml({ name: 'terms', label: 'Terms', type: 'textarea', full: true }, doc.terms ?? (isEst ? st.estimate_terms : st.invoice_terms))}
        </div>
        <div class="totals" id="totals"></div>
      </div></div>
    <div class="row no-print"><button class="btn primary">Save ${kind}</button>${id !== 'new' && (isEst ? doc.status !== 'approved' : doc.status === 'draft') ? `<button type="button" class="btn danger" id="del">Delete</button>` : ''}
      ${!isEst && id !== 'new' && !['void', 'paid'].includes(doc.status) ? '<button type="button" class="btn danger" id="void">Void invoice</button>' : ''}</div>
    </form>
    ${!isEst && id !== 'new' ? `<div class="card" style="margin-top:14px"><h2>Payments</h2>${table([{ label: 'Date', get: p => fmtDate(p.paid_at) }, { label: 'Method', get: p => label(p.method) }, { label: 'Reference', key: 'reference' }, { label: 'Amount', num: 1, get: p => money(p.amount) },
      ...(isAdmin() ? [{ label: '', html: p => `<button class="btn sm danger" data-delpay="${p.id}">✕</button>` }] : [])], doc.payments, { empty: 'No payments recorded' })}</div>` : ''}
    ${isEst && doc.signature_name ? `<div class="card" style="margin-top:14px"><h2>Customer approval</h2>Signed by <b>${esc(doc.signature_name)}</b> on ${fmtDT(doc.approved_at)}</div>` : ''}`;

  const form = $('#docform');
  const tbody = $('#items');
  const draw = () => { tbody.innerHTML = doc.items.map(itemRow).join('') || '<tr><td colspan="8" class="empty">No line items — add one below</td></tr>'; totals(); };
  const totals = () => {
    doc.tax_rate = form.tax_rate.value; doc.discount = form.discount.value;
    const t = calcTotals(doc);
    $('#totals').innerHTML = `<div><span>Subtotal</span><span>${money(t.sub)}</span></div>${t.disc ? `<div><span>Discount</span><span>−${money(t.disc)}</span></div>` : ''}
      <div><span>Tax</span><span>${money(t.tax)}</span></div><div class="grand"><span>Total</span><span>${money(t.total)}</span></div>
      ${!isEst && doc.paid ? `<div><span>Paid</span><span>${money(doc.paid)}</span></div><div><b>Balance</b><b>${money(t.total - doc.paid)}</b></div>` : ''}
      <div class="muted small" style="margin-top:8px;border-top:1px dashed var(--border);padding-top:6px">Internal only: est. cost ${money(t.cost)} · margin <b class="${t.margin < Number(st.target_gross_margin) ? '' : ''}">${pct(t.margin)}</b>${t.margin < Number(st.target_gross_margin) ? ` <span class="pill warn">below ${st.target_gross_margin}% target</span>` : ''}</div>`;
  };
  tbody.addEventListener('input', e => {
    const tr = e.target.closest('tr[data-i]'); if (!tr) return;
    const it = doc.items[tr.dataset.i]; const k = e.target.dataset.k;
    it[k] = e.target.type === 'checkbox' ? (e.target.checked ? 1 : 0) : e.target.value;
    if (k === 'description') {
      const p = pb.find(x => x.name === e.target.value);
      if (p) { Object.assign(it, { pricebook_id: p.id, unit_price: p.unit_price, unit_cost: p.unit_cost ?? 0, taxable: p.taxable, cost_code_id: p.cost_code_id || it.cost_code_id }); draw(); $(`tr[data-i="${tr.dataset.i}"] [data-k=qty]`).focus(); return; }
    }
    $('[data-line]', tr).textContent = money((+it.qty || 0) * (+it.unit_price || 0)); totals();
  });
  tbody.addEventListener('change', e => {
    if (e.target.type === 'checkbox') totals();
    if (e.target.dataset.k === 'cost_code_id') doc.items[e.target.closest('tr').dataset.i].cost_code_id = e.target.value || null;
  });
  tbody.addEventListener('click', e => { const b = e.target.closest('[data-rm]'); if (b) { doc.items.splice(+b.dataset.rm, 1); draw(); } });
  form.tax_rate.oninput = totals; form.discount.oninput = totals;
  if (!locked) {
    $('#addline').onclick = () => { doc.items.push({ description: '', qty: 1, unit_price: 0, unit_cost: 0, taxable: 1 }); draw(); $$('#items .desc').pop().focus(); };
    $('#addlabor').onclick = () => {
      const rate = Math.max(...S.users.map(u => u.bill_rate || 0), 0) || 125;
      const loaded = S.users.filter(u => u.role === 'tech' && u.hourly_wage).map(u => u.hourly_wage * (1 + u.burden_pct / 100));
      doc.items.push({ description: 'Electrical labor', qty: 1, unit_price: rate, unit_cost: loaded.length ? Math.round(loaded.reduce((a, b) => a + b, 0) / loaded.length * 100) / 100 : 0, taxable: 0 }); draw();
    };
  }
  const loadSub = async () => {
    const cid = form.customer_id.value;
    if (isEst) {
      const sel = form.location_id; if (!cid) { sel.innerHTML = '<option value="">—</option>'; return; }
      const c = await GET('/customers/' + cid);
      sel.innerHTML = '<option value="">—</option>' + c.locations.map(l => `<option value="${l.id}">${esc([l.label, l.address, l.city].filter(Boolean).join(' · '))}</option>`).join('');
      sel.value = doc.location_id || (c.locations[0] || {}).id || '';
      if (id === 'new' && c.tax_exempt) { form.tax_rate.value = 0; totals(); }
    } else {
      const sel = form.job_id; if (!cid) { sel.innerHTML = '<option value="">—</option>'; return; }
      const jobs = await GET('/jobs' + qs({ customer_id: cid }));
      sel.innerHTML = '<option value="">— No job —</option>' + jobs.map(j => `<option value="${j.id}">${esc(j.number)} · ${esc(j.title)}</option>`).join('');
      sel.value = doc.job_id || '';
    }
  };
  form.customer_id.onchange = loadSub; loadSub();
  draw();

  form.onsubmit = async e => {
    e.preventDefault();
    const body = { customer_id: Number(form.customer_id.value), title: form.title.value, tax_rate: Number(form.tax_rate.value) || 0, discount: Number(form.discount.value) || 0, notes: form.notes.value, terms: form.terms.value };
    if (isEst) Object.assign(body, { location_id: form.location_id.value || null, valid_until: form.valid_until.value || null, job_id: doc.job_id || null });
    else Object.assign(body, { job_id: form.job_id.value || null, issue_date: form.issue_date.value || undefined, due_date: form.due_date.value || undefined });
    if (!locked) body.items = doc.items.filter(it => it.description);
    if (id === 'new') { const r = await act(() => POST(base, body), 'Saved'); go(`#${base}/${r.id}`); }
    else { await act(() => PUT(`${base}/${id}`, body), 'Saved'); route(); }
  };
  if (id === 'new') return;
  const on = (sel, fn) => { const el = $(sel); if (el) el.onclick = fn; };
  on('#send', () => {
    const cust = doc.customer || {};
    formModal({
      title: `Send ${kind} ${doc.number}`, okLabel: 'Send', values: { to: cust.email },
      fields: [{ name: 'to', label: 'To', type: 'email', required: true, full: true }, { name: 'message', label: 'Message', type: 'textarea', full: true, default: isEst ? 'Thank you for the opportunity. Your estimate is ready to review and approve online.' : 'Thank you for your business! Your invoice is ready.' }],
      extra: `<p class="small muted">The customer gets a link to view${isEst ? ', sign and approve' : ''} online: <br><code>${esc(doc.public_url)}</code></p>`,
      submit: async d => {
        const r = await POST(`${base}/${id}/send`, d);
        if (r.status === 'sent') toast('Email sent');
        else if (r.status === 'not_configured') { await navigator.clipboard?.writeText(r.url).catch(() => {}); toast('Email is not set up (see Settings). Marked as sent and copied the customer link — paste it into a text or email.', true); }
        else toast('Email failed: ' + (r.error || 'unknown'), true);
        route();
      },
    });
  });
  on('#mark-approved', async () => { await act(() => PUT(`${base}/${id}`, { status: 'approved' }), 'Marked approved'); route(); });
  on('#mark-declined', async () => { await act(() => PUT(`${base}/${id}`, { status: 'declined' }), 'Marked declined'); route(); });
  on('#tojob', async () => { const r = await act(() => POST(`${base}/${id}/convert-to-job`), 'Job created — schedule it'); go('#/jobs/' + r.id); });
  on('#toinv', async () => { const r = await act(() => POST(`${base}/${id}/convert-to-invoice`), 'Invoice created'); go('#/invoices/' + r.id); });
  on('#del', async () => { if (confirm(`Delete this ${kind}?`)) { await act(() => DEL(`${base}/${id}`), 'Deleted'); go('#' + base); } });
  on('#void', async () => { if (confirm('Void this invoice? It will be excluded from revenue and receivables.')) { await act(() => PUT(`${base}/${id}`, { status: 'void' }), 'Voided'); route(); } });
  if (isAdmin()) await loadAccounts();
  on('#pay', () => formModal({
    title: 'Record payment', values: { amount: doc.balance, paid_at: todayStr() },
    fields: [{ name: 'amount', label: 'Amount', type: 'number', required: true }, { name: 'paid_at', label: 'Date', type: 'date', required: true },
      { name: 'method', label: 'Method', type: 'select', options: ['check', 'card', 'cash', 'ach', 'financing', 'other'], blank: false }, { name: 'reference', label: 'Check # / reference' },
      ...(isAdmin() ? [{ name: 'deposit_account_id', label: 'Deposit to', type: 'select', options: acctOptions('bank'), blank: 'Default (Settings)' }] : [])],
    submit: async d => { await POST(`${base}/${id}/payments`, d); toast('Payment recorded'); route(); },
  }));
  $$('[data-delpay]').forEach(b => b.onclick = async () => { if (confirm('Delete this payment?')) { await act(() => DEL('/payments/' + b.dataset.delpay)); route(); } });
}

// ============================================================ time clock & timesheets
async function viewTime() {
  const { params } = hashParams();
  const from = params.get('from') || (() => { const d = new Date(); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return localDate(d); })();
  const to = params.get('to') || todayStr();
  const userId = params.get('user_id') || '';
  $('#view').innerHTML = setTop('Time Clock', isOffice() ? '<button class="btn" id="add">+ Add time</button>' : '') + `<div id="clock"></div>
    <div class="card" style="margin-top:14px"><div class="row spread"><h2>${isOffice() ? 'Timesheets' : 'My hours'}</h2>
      <form id="flt" class="row">${isOffice() ? `<select name="user_id" style="width:auto"><option value="">Everyone</option>${techOptions().map(([v, l]) => `<option value="${v}" ${String(v) === userId ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>` : ''}
        <input type="date" name="from" value="${from}" style="width:auto"> to <input type="date" name="to" value="${to}" style="width:auto"><button class="btn">Show</button></form></div><div id="sheet"></div></div>`;
  await clockCard($('#clock'));
  if (isOffice()) $('#add').onclick = () => timeForm({});
  $('#flt').onsubmit = e => { e.preventDefault(); const f = e.target; go('#/time' + qs({ from: f.from.value, to: f.to.value, user_id: f.user_id ? f.user_id.value : '' })); };
  const rows = await GET('/time' + qs({ from, to, user_id: userId }));
  const total = rows.reduce((s, r) => s + r.hours, 0);
  const byUser = {};
  for (const r of rows) byUser[r.user_name] = (byUser[r.user_name] || 0) + r.hours;
  $('#sheet').innerHTML = (isOffice() && Object.keys(byUser).length > 1 ? `<div class="row" style="margin-bottom:10px">${Object.entries(byUser).map(([n, h]) => `<span class="pill accent">${esc(n)}: ${num(h)} h</span>`).join('')}</div>` : '') +
    table([{ label: 'Date', get: t => fmtDate(localDate(new Date(t.clock_in))) }, ...(isOffice() ? [{ label: 'Employee', key: 'user_name' }] : []),
      { label: 'Job', html: t => t.job_id ? `<a href="#/jobs/${t.job_id}">${esc(t.job_number)}</a> ${esc(t.job_title)}` : '—' }, { label: 'Type', get: t => label(t.kind) },
      { label: 'Code', get: t => t.cost_code || '—' }, { label: 'In', get: t => fmtTime(t.clock_in) }, { label: 'Out', html: t => t.clock_out ? fmtTime(t.clock_out) : '<span class="pill good">On the clock</span>' },
      { label: 'Hours', num: 1, get: t => num(t.hours) }, { label: 'Notes', key: 'notes' }], rows,
    { onClick: isOffice() ? t => timeForm(t) : null, empty: 'No time in this range', foot: rows.length ? ['Total', ...(isOffice() ? [''] : []), '', '', '', '', '', { v: num(total), num: 1 }, ''] : null });
}

// ============================================================ price book & inventory
async function viewPricebook() {
  const list = await GET('/pricebook?all=1');
  const { params } = hashParams(); const cat = params.get('cat') || '';
  const cats = [...new Set(list.map(p => p.category).filter(Boolean))].sort();
  const rows = list.filter(p => !cat || p.category === cat);
  $('#view').innerHTML = setTop('Price Book & Inventory', `<button class="btn" id="csv">Export CSV</button><button class="btn" id="reorder">Create reorder POs</button><button class="btn primary" id="new">+ Item</button>`,
    'Flat-rate tasks, materials, and stock levels. Costs are hidden from techs and customers.') + `<div class="card">
    <div class="tabs"><button class="${!cat ? 'on' : ''}" data-c="">All</button>${cats.map(c => `<button class="${c === cat ? 'on' : ''}" data-c="${esc(c)}">${esc(c)}</button>`).join('')}</div>
    ${table(PB_COLS, rows, { onClick: p => pbForm(p), empty: 'Price book is empty' })}</div>`;
  $$('[data-c]').forEach(b => b.onclick = () => go('#/pricebook' + qs({ cat: b.dataset.c })));
  $('#new').onclick = () => pbForm({});
  $('#csv').onclick = () => toCSV(PB_COLS, rows, 'pricebook.csv');
  $('#reorder').onclick = async () => {
    const r = await act(() => POST('/purchase-orders/reorder'));
    toast(r.created.length ? `Created ${r.created.length} draft PO(s)` : 'Nothing at or below its reorder point has a preferred vendor', !r.created.length);
    if (r.skipped_without_vendor) toast(`${r.skipped_without_vendor} low item(s) skipped — set a preferred vendor on them`, true);
    if (r.created.length) go('#/purchasing');
  };
}
const PB_COLS = [{ label: 'Code', key: 'code' }, { label: 'Name', html: p => `${esc(p.name)}${p.active ? '' : ' <span class="pill">Inactive</span>'}`, csv: p => p.name }, { label: 'Category', key: 'category' }, { label: 'Kind', get: p => label(p.kind) },
  { label: 'Cost code', get: p => (S.costCodes.find(c => c.id === p.cost_code_id) || {}).code || '' },
  { label: 'Cost', num: 1, get: p => money(p.unit_cost) }, { label: 'Price', num: 1, get: p => money(p.unit_price) },
  { label: 'Markup', num: 1, get: p => p.unit_cost ? pct((p.unit_price - p.unit_cost) / p.unit_cost * 100) : '—' },
  { label: 'Labor hrs', num: 1, get: p => p.labor_hours ? num(p.labor_hours) : '' },
  { label: 'On hand', num: 1, html: p => p.kind === 'material' ? `${num(p.qty_on_hand)}${p.reorder_point && p.qty_on_hand <= p.reorder_point ? ' <span class="pill warn">Reorder</span>' : ''}` : '', csv: p => p.qty_on_hand }];
async function pbForm(p) {
  await loadVendors();
  formModal({
    title: p.id ? 'Edit item' : 'New price book item', values: p, wide: true,
    fields: [{ name: 'code', label: 'Code / SKU' }, { name: 'name', label: 'Name', required: true }, { name: 'category', label: 'Category' },
      { name: 'kind', label: 'Kind', type: 'select', options: ['material', 'service', 'labor', 'equipment'], blank: false, default: 'material' },
      { name: 'unit', label: 'Unit', default: 'ea' }, { name: 'vendor', label: 'Preferred vendor' },
      { name: 'unit_cost', label: 'Unit cost $', type: 'number', default: 0 }, { name: 'unit_price', label: 'Unit sell price $', type: 'number', default: 0 },
      { name: 'labor_hours', label: 'Labor hours (flat-rate tasks)', type: 'number', default: 0 }, { name: 'qty_on_hand', label: 'Qty on hand', type: 'number', default: 0 },
      { name: 'reorder_point', label: 'Reorder at', type: 'number', default: 0 },
      { name: 'cost_code_id', label: 'Default cost code', type: 'select', options: ccOptions() },
      { name: 'vendor_id', label: 'Preferred vendor (for reorders)', type: 'select', options: (S.vendors || []).map(v => [v.id, v.name]) },
      { name: 'ply_item_id', label: 'Ply item ID' },
      { name: 'description', label: 'Customer-facing description', type: 'textarea', full: true },
      { name: 'taxable', label: 'Taxable', type: 'checkbox', default: 1 }, { name: 'active', label: 'Active', type: 'checkbox', default: 1 }],
    submit: async d => { if (p.id) await PUT('/pricebook/' + p.id, d); else await POST('/pricebook', d); S.pricebook = null; toast('Saved'); route(); },
  });
}

// ============================================================ expenses
const expenseCols = showJob => [{ label: 'Date', get: e => fmtDate(e.date) }, { label: 'Category', key: 'category' }, { label: 'Vendor', key: 'vendor' }, { label: 'Description', key: 'description' },
  ...(showJob ? [{ label: 'Job', html: e => e.job_id ? `<a href="#/jobs/${e.job_id}">${esc(e.job_number)}</a>` : '<span class="muted">Overhead</span>', csv: e => e.job_number || 'Overhead' }] : []),
  { label: 'Amount', num: 1, get: e => money(e.amount), csv: e => e.amount }];
async function expenseForm(e) {
  const jobs = await jobPicker();
  if (isAdmin()) await loadAccounts();
  if (e.job_id && !jobs.some(([id]) => id === e.job_id)) jobs.unshift([e.job_id, e.job_number || `Job #${e.job_id}`]);
  formModal({
    title: e.id ? 'Edit expense' : 'Add expense', values: e,
    fields: [{ name: 'date', label: 'Date', type: 'date', required: true }, { name: 'amount', label: 'Amount $', type: 'number', required: true },
      { name: 'category', label: 'Category', type: 'select', options: EXPENSE_CATS, required: true }, { name: 'vendor', label: 'Vendor' },
      { name: 'job_id', label: 'Job (blank = company overhead)', type: 'select', options: jobs, blank: '— Overhead —', full: true },
      { name: 'cost_code_id', label: 'Cost code (job costs)', type: 'select', options: ccOptions() },
      ...(isAdmin() ? [{ name: 'account_id', label: 'GL account (blank = by category)', type: 'select', options: acctOptions('expense', 'cogs', 'asset') },
        { name: 'paid_from_account_id', label: 'Paid from', type: 'select', options: acctOptions('bank', 'credit_card'), blank: 'Default (Settings)' }] : []),
      { name: 'description', label: 'Description', full: true }],
    extra: e.id ? '<div style="margin-top:12px"><button type="button" class="btn danger" id="delexp">Delete</button></div>' : '',
    submit: async d => { if (e.id) await PUT('/expenses/' + e.id, d); else await POST('/expenses', d); toast('Saved'); route(); },
  }).el.querySelector('#delexp')?.addEventListener('click', async () => { if (confirm('Delete this expense?')) { await act(() => DEL('/expenses/' + e.id)); $('.modal-bg')?.remove(); route(); } });
}
async function viewExpenses() {
  const { params } = hashParams();
  const from = params.get('from') || todayStr().slice(0, 8) + '01', to = params.get('to') || todayStr();
  const rows = await GET('/expenses' + qs({ from, to }));
  const overhead = rows.filter(r => !r.job_id).reduce((s, r) => s + r.amount, 0), jobc = rows.filter(r => r.job_id).reduce((s, r) => s + r.amount, 0);
  const cols = expenseCols(true);
  $('#view').innerHTML = setTop('Expenses', '<button class="btn" id="csv">Export CSV</button><button class="btn primary" id="new">+ Expense</button>', 'Tie a cost to a job to count it in job costing; leave the job blank for overhead.') + `
    <div class="grid g3">${kpi('Total', money(overhead + jobc))}${kpi('Overhead', money(overhead))}${kpi('Job costs', money(jobc))}</div>
    <div class="card" style="margin-top:14px"><form id="flt" class="row"><input type="date" name="from" value="${from}" style="width:auto"> to <input type="date" name="to" value="${to}" style="width:auto"><button class="btn">Show</button></form>
    ${table(cols, rows, { onClick: e => expenseForm(e), empty: 'No expenses in this range' })}</div>`;
  $('#new').onclick = () => expenseForm({ date: todayStr() });
  $('#csv').onclick = () => toCSV(cols, rows, `expenses_${from}_${to}.csv`);
  $('#flt').onsubmit = e => { e.preventDefault(); go('#/expenses' + qs({ from: e.target.from.value, to: e.target.to.value })); };
}

// ============================================================ permits
const permitCols = showJob => [...(showJob ? [{ label: 'Job', html: p => `<a href="#/jobs/${p.job_id}">${esc(p.job_number)}</a><div class="muted small">${esc(p.customer_name)} · ${esc(p.address || '')}</div>` }] : []),
  { label: 'Type', key: 'permit_type' }, { label: 'Permit #', key: 'permit_number' }, { label: 'Jurisdiction', key: 'jurisdiction' }, { label: 'Status', html: p => pill(p.status) },
  { label: 'Inspection', get: p => fmtDate(p.inspection_date) }, { label: 'Fee', num: 1, get: p => money(p.fee) }];
async function permitForm(p) {
  const jobs = await jobPicker();
  if (p.job_id && !jobs.some(([id]) => id === p.job_id)) jobs.unshift([p.job_id, p.job_number || `Job #${p.job_id}`]);
  const m = formModal({
    title: p.id ? 'Edit permit' : 'New permit', values: p, wide: true,
    fields: [{ name: 'job_id', label: 'Job', type: 'select', options: jobs, required: true, full: true }, { name: 'permit_type', label: 'Permit type (e.g. Service change, EVSE)' }, { name: 'permit_number', label: 'Permit #' },
      { name: 'jurisdiction', label: 'Jurisdiction / AHJ' }, { name: 'status', label: 'Status', type: 'select', options: PERMIT_STATUSES, blank: false },
      { name: 'applied_date', label: 'Applied', type: 'date' }, { name: 'issued_date', label: 'Issued', type: 'date' }, { name: 'inspection_date', label: 'Inspection date', type: 'date' },
      { name: 'expires_date', label: 'Expires', type: 'date' }, { name: 'fee', label: 'Fee $', type: 'number', default: 0 }, { name: 'inspector', label: 'Inspector' },
      { name: 'notes', label: 'Notes / corrections', type: 'textarea', full: true }],
    extra: p.id ? '<div style="margin-top:12px"><button type="button" class="btn danger" id="delp">Delete</button></div>' : '',
    submit: async d => { if (p.id) await PUT('/permits/' + p.id, d); else await POST('/permits', d); toast('Saved'); route(); },
  });
  $('#delp', m.el)?.addEventListener('click', async () => { if (confirm('Delete this permit?')) { await act(() => DEL('/permits/' + p.id)); m.close(); route(); } });
}
async function viewPermits() {
  const { params } = hashParams(); const open = params.get('all') ? '' : '1';
  const rows = await GET('/permits' + qs({ open }));
  $('#view').innerHTML = setTop('Permits & Inspections', isOffice() ? '<button class="btn primary" id="new">+ Permit</button>' : '') + `<div class="card">
    <div class="tabs"><button class="${open ? 'on' : ''}" data-a="">Open</button><button class="${open ? '' : 'on'}" data-a="1">All</button></div>
    ${table(permitCols(true), rows, { onClick: isOffice() ? p => permitForm(p) : p => go('#/jobs/' + p.job_id), empty: 'No permits' })}</div>`;
  $$('[data-a]').forEach(b => b.onclick = () => go('#/permits' + qs({ all: b.dataset.a })));
  if (isOffice()) $('#new').onclick = () => permitForm({ status: 'needed' });
}

// ============================================================ service agreements
async function viewAgreements() {
  const rows = await GET('/agreements');
  const active = rows.filter(a => a.status === 'active');
  const mult = { monthly: 12, quarterly: 4, annual: 1 };
  const arr = active.reduce((s, a) => s + a.price * mult[a.billing_frequency], 0);
  $('#view').innerHTML = setTop('Service Agreements', '<button class="btn primary" id="new">+ Agreement</button>', 'Maintenance plans & memberships — recurring revenue and booked future work.') + `
    <div class="grid g3">${kpi('Active agreements', active.length)}${kpi('Annual recurring revenue', money0(arr))}${kpi('Visits due in 30 days', active.filter(a => a.next_visit && a.next_visit <= localDate(new Date(Date.now() + 30 * 864e5))).length)}</div>
    <div class="card" style="margin-top:14px">${table([{ label: 'Customer', key: 'customer_name' }, { label: 'Plan', key: 'name' }, { label: 'Price', get: a => `${money(a.price)} / ${a.billing_frequency}` },
      { label: 'Visits/yr', num: 1, key: 'visits_per_year' }, { label: 'Next visit', get: a => fmtDate(a.next_visit) }, { label: 'Status', html: a => pill(a.status) },
      { label: '', html: a => a.status === 'active' ? `<button class="btn sm" data-visit="${a.id}">Create visit job</button>` : '' }], rows, { onClick: a => agreementForm(a), empty: 'No agreements yet' })}</div>`;
  $('#new').onclick = () => agreementForm({});
  $$('[data-visit]').forEach(b => b.onclick = async () => { const r = await act(() => POST(`/agreements/${b.dataset.visit}/create-visit`), 'Visit job created'); go('#/jobs/' + r.id); });
}
async function agreementForm(a) {
  const customers = await customerPicker();
  formModal({
    title: a.id ? 'Edit agreement' : 'New service agreement', values: a, wide: true,
    fields: [{ name: 'customer_id', label: 'Customer', type: 'select', options: customers, required: true, full: true }, { name: 'name', label: 'Plan name', required: true, full: true },
      { name: 'price', label: 'Price $', type: 'number', required: true }, { name: 'billing_frequency', label: 'Billed', type: 'select', options: ['monthly', 'quarterly', 'annual'], blank: false, default: 'annual' },
      { name: 'visits_per_year', label: 'Visits per year', type: 'number', default: 1 }, { name: 'status', label: 'Status', type: 'select', options: ['active', 'paused', 'cancelled', 'expired'], blank: false },
      { name: 'start_date', label: 'Start', type: 'date', default: todayStr() }, { name: 'end_date', label: 'End', type: 'date' }, { name: 'next_visit', label: 'Next visit', type: 'date' },
      { name: 'notes', label: 'What is included', type: 'textarea', full: true }],
    submit: async d => { if (a.id) await PUT('/agreements/' + a.id, d); else await POST('/agreements', d); toast('Saved'); route(); },
  });
}

// ============================================================ reports
function presetRange(p) {
  const d = new Date(), y = d.getFullYear(), m = d.getMonth();
  const f = localDate;
  switch (p) {
    case 'last_month': return [f(new Date(y, m - 1, 1)), f(new Date(y, m, 0))];
    case 'qtd': return [f(new Date(y, Math.floor(m / 3) * 3, 1)), f(d)];
    case 'ytd': return [f(new Date(y, 0, 1)), f(d)];
    case 'last_year': return [f(new Date(y - 1, 0, 1)), f(new Date(y - 1, 11, 31))];
    case '12m': return [f(new Date(y, m - 11, 1)), f(d)];
    default: return [f(new Date(y, m, 1)), f(d)];
  }
}
async function viewReports() {
  const { params } = hashParams();
  const r = params.get('r') || 'pl';
  const [defFrom, defTo] = presetRange('mtd');
  const from = params.get('from') || defFrom, to = params.get('to') || defTo;
  const tabs = [['pl', 'Profit & Loss'], ['jobcost', 'Job Costing'], ['hours', 'Hours by Job'], ['payroll', 'Payroll / Timesheet'], ['tech', 'Tech Performance'], ['ar', 'A/R Aging'], ['est', 'Estimates'], ['source', 'Lead Sources'], ['cc', 'Cost Codes']];
  $('#view').innerHTML = setTop('Reports', '<button class="btn" id="csv">Export CSV</button><button class="btn" onclick="print()">Print</button>') + `
    <div class="tabs">${tabs.map(([k, l]) => `<button class="${k === r ? 'on' : ''}" data-r="${k}">${l}</button>`).join('')}</div>
    ${r === 'ar' ? '' : `<form id="rng" class="row no-print" style="margin-bottom:14px"><input type="date" name="from" value="${from}" style="width:auto"> to <input type="date" name="to" value="${to}" style="width:auto"><button class="btn">Run</button>
      ${[['mtd', 'This month'], ['last_month', 'Last month'], ['qtd', 'Quarter'], ['ytd', 'Year to date'], ['12m', 'Last 12 mo'], ['last_year', 'Last year']].map(([k, l]) => `<button type="button" class="btn sm" data-p="${k}">${l}</button>`).join('')}</form>`}
    <div id="rep"></div>`;
  $$('[data-r]').forEach(b => b.onclick = () => go('#/reports' + qs({ r: b.dataset.r, from, to })));
  const rng = $('#rng');
  if (rng) {
    rng.onsubmit = e => { e.preventDefault(); go('#/reports' + qs({ r, from: rng.from.value, to: rng.to.value })); };
    $$('[data-p]').forEach(b => b.onclick = () => { const [f, t] = presetRange(b.dataset.p); go('#/reports' + qs({ r, from: f, to: t })); });
  }
  const R = $('#rep');
  let csv = null;
  $('#csv').onclick = () => csv ? csv() : toast('Nothing to export on this report', true);
  const sub = `${fmtDate(from)} – ${fmtDate(to)}`;

  if (r === 'pl') {
    const [p, trend] = await Promise.all([GET('/reports/pl' + qs({ from, to })), GET('/reports/trend?months=12')]);
    const line = (l, v, cls = '', indent = 0) => `<tr class="${cls}"><td style="padding-left:${10 + indent * 18}px">${l}</td><td class="num">${money(v)}</td><td class="num muted">${p.revenue ? pct(v / p.revenue * 100) : ''}</td></tr>`;
    R.innerHTML = `<div class="grid g4">${kpi('Revenue', money0(p.revenue), sub)}${kpi('Gross profit', money0(p.gross_profit), pct(p.gross_margin_pct) + ' gross margin')}${kpi('Net profit', money0(p.net_profit), pct(p.net_margin_pct) + ' net margin')}${kpi('Cash collected', money0(p.cash_collected), `${money0(p.sales_tax_collected)} sales tax billed`)}</div>
      <div class="grid g2" style="margin-top:14px"><div class="card"><h2>Profit & Loss — ${sub}</h2><div class="table-wrap"><table>
        <thead><tr><th></th><th class="num">Amount</th><th class="num">% of rev</th></tr></thead><tbody>
        <tr><td><b>Revenue</b></td><td></td><td></td></tr>${p.revenue_by_segment.map(s => line(esc(label(s.segment)), s.amount, '', 1)).join('')}${line('<b>Total revenue</b>', p.revenue)}
        <tr><td><b>Cost of goods sold</b></td><td></td><td></td></tr>
        ${line(`Direct labor (${num(p.cogs.direct_hours)} hrs, loaded)`, p.cogs.direct_labor, '', 1)}${line('Materials', p.cogs.materials, '', 1)}${line('Permit fees', p.cogs.permit_fees, '', 1)}
        ${p.cogs.job_expenses.map(e => line(esc(e.category), e.amount, '', 1)).join('')}${line('<b>Total COGS</b>', p.cogs.total)}
        ${line('<b>Gross profit</b>', p.gross_profit)}
        <tr><td><b>Overhead</b></td><td></td><td></td></tr>${line(`Non-billable labor (${num(p.overhead.indirect_hours)} hrs: shop, training, PTO)`, p.overhead.indirect_labor, '', 1)}
        ${p.overhead.expenses.map(e => line(esc(e.category), e.amount, '', 1)).join('')}${line('<b>Total overhead</b>', p.overhead.total)}
        ${line(`<b>Net profit</b>`, p.net_profit)}</tbody></table></div><p class="small muted">${esc(p.note)}</p></div>
      <div class="card"><h2>Last 12 months — revenue</h2>${bars(trend, 'revenue', 'month')}
        <div style="margin-top:14px">${table([{ label: 'Month', key: 'month' }, { label: 'Revenue', num: 1, get: t => money0(t.revenue) }, { label: 'COGS', num: 1, get: t => money0(t.cogs) }, { label: 'Overhead', num: 1, get: t => money0(t.overhead) }, { label: 'Net', num: 1, get: t => money0(t.net) }, { label: 'GM %', num: 1, get: t => pct(t.gross_margin_pct) }], [...trend].reverse())}</div></div></div>`;
    csv = () => toCSV([{ label: 'Line', key: 'k' }, { label: 'Amount', key: 'v' }], [
      ...p.revenue_by_segment.map(s => ({ k: 'Revenue: ' + s.segment, v: s.amount })), { k: 'Total revenue', v: p.revenue },
      { k: 'COGS: Direct labor', v: p.cogs.direct_labor }, { k: 'COGS: Materials', v: p.cogs.materials }, { k: 'COGS: Permit fees', v: p.cogs.permit_fees },
      ...p.cogs.job_expenses.map(e => ({ k: 'COGS: ' + e.category, v: e.amount })), { k: 'Total COGS', v: p.cogs.total }, { k: 'Gross profit', v: p.gross_profit },
      { k: 'Overhead: Non-billable labor', v: p.overhead.indirect_labor }, ...p.overhead.expenses.map(e => ({ k: 'Overhead: ' + e.category, v: e.amount })),
      { k: 'Total overhead', v: p.overhead.total }, { k: 'Net profit', v: p.net_profit }], `pl_${from}_${to}.csv`);
  }
  if (r === 'jobcost') {
    const rows = await GET('/reports/job-costing' + qs({ from, to }));
    const cols = [{ label: 'Job', html: j => `<a href="#/jobs/${j.id}">${esc(j.number)}</a> ${esc(j.title)}<div class="muted small">${esc(j.customer_name)}</div>`, csv: j => `${j.number} ${j.title}` },
      { label: 'Status', html: j => pill(j.status), csv: j => j.status }, { label: 'Hours', num: 1, get: j => num(j.hours), csv: j => j.hours },
      { label: 'Budget hrs', num: 1, html: j => j.budget_hours == null ? '—' : `${num(j.budget_hours)}${j.hours > j.budget_hours ? ' <span class="pill bad">over</span>' : ''}`, csv: j => j.budget_hours },
      { label: 'Labor', num: 1, get: j => money0(j.labor_cost), csv: j => j.labor_cost }, { label: 'Materials', num: 1, get: j => money0(j.materials_cost), csv: j => j.materials_cost },
      { label: 'Other', num: 1, get: j => money0(j.other_cost + j.permit_fees), csv: j => j.other_cost + j.permit_fees },
      { label: 'Revenue', num: 1, get: j => money0(j.revenue), csv: j => j.revenue }, { label: 'Profit', num: 1, get: j => money0(j.profit), csv: j => j.profit },
      { label: 'Margin', num: 1, html: j => j.margin_pct == null ? '—' : `<span class="pill ${j.margin_pct >= Number(S.settings.target_gross_margin) ? 'good' : j.margin_pct >= 0 ? 'warn' : 'bad'}">${pct(j.margin_pct)}</span>`, csv: j => j.margin_pct }];
    const sum = k => rows.reduce((s, j) => s + (j[k] || 0), 0);
    R.innerHTML = `<div class="card"><h2>Job costing — ${sub}</h2><p class="small muted">Jobs completed (or scheduled/created if not complete) in range. Margin uses invoiced revenue, or the contract amount if not invoiced yet.</p>
      ${table(cols, rows, { empty: 'No jobs in range', foot: ['Total', '', { v: num(sum('hours')), num: 1 }, '', { v: money0(sum('labor_cost')), num: 1 }, { v: money0(sum('materials_cost')), num: 1 }, { v: money0(sum('other_cost') + sum('permit_fees')), num: 1 }, { v: money0(sum('revenue')), num: 1 }, { v: money0(sum('profit')), num: 1 }, ''] })}</div>`;
    csv = () => toCSV(cols, rows, `job_costing_${from}_${to}.csv`);
  }
  if (r === 'hours') {
    const rows = await GET('/reports/hours-by-job' + qs({ from, to }));
    const cols = [{ label: 'Job', html: j => j.job_id ? `<a href="#/jobs/${j.job_id}">${esc(j.job_number)}</a> ${esc(j.job_title)}` : esc(j.job_title), csv: j => `${j.job_number} ${j.job_title}` },
      { label: 'Techs', get: j => j.techs.map(t => `${t.name} ${num(t.hours)}h`).join(', ') }, { label: 'Hours', num: 1, get: j => num(j.hours), csv: j => j.hours },
      { label: 'Budget', num: 1, html: j => j.budget_hours == null ? '—' : `${num(j.budget_hours)}${j.hours > j.budget_hours ? ' <span class="pill bad">over</span>' : ''}`, csv: j => j.budget_hours },
      { label: 'Labor cost', num: 1, get: j => money(j.labor_cost), csv: j => j.labor_cost }];
    R.innerHTML = `<div class="card"><h2>Hours on job — ${sub}</h2>${table(cols, rows, { empty: 'No time in range', foot: ['Total', '', { v: num(rows.reduce((s, j) => s + j.hours, 0)), num: 1 }, '', { v: money(rows.reduce((s, j) => s + j.labor_cost, 0)), num: 1 }] })}</div>`;
    csv = () => toCSV(cols, rows, `hours_by_job_${from}_${to}.csv`);
  }
  if (r === 'payroll') {
    const rows = await GET('/reports/payroll' + qs({ from, to }));
    const kinds = ['job', 'travel', 'shop', 'training', 'pto'];
    const cols = [{ label: 'Employee', key: 'name' }, ...kinds.map(k => ({ label: label(k), num: 1, get: r => num(r.by_kind[k] || 0), csv: r => r.by_kind[k] || 0 })),
      { label: 'Regular', num: 1, get: r => num(r.regular_hours), csv: r => r.regular_hours }, { label: 'Overtime', num: 1, html: r => r.overtime_hours ? `<span class="pill warn">${num(r.overtime_hours)}</span>` : '0', csv: r => r.overtime_hours },
      { label: 'Total hrs', num: 1, get: r => num(r.total_hours), csv: r => r.total_hours }, { label: 'Gross pay', num: 1, get: r => money(r.gross_pay), csv: r => r.gross_pay }];
    R.innerHTML = `<div class="card"><h2>Payroll summary — ${sub}</h2><p class="small muted">Overtime: hours over ${esc(S.settings.overtime_weekly_hours)}/week (Mon–Sun) at ${esc(S.settings.overtime_multiplier)}×. Gross pay is before taxes & deductions — export to your payroll provider.</p>
      ${table(cols, rows, { empty: 'No time in range', foot: ['Total', ...kinds.map(() => ''), '', '', { v: num(rows.reduce((s, r) => s + r.total_hours, 0)), num: 1 }, { v: money(rows.reduce((s, r) => s + r.gross_pay, 0)), num: 1 }] })}</div>`;
    csv = () => toCSV(cols, rows, `payroll_${from}_${to}.csv`);
  }
  if (r === 'tech') {
    const rows = await GET('/reports/tech-performance' + qs({ from, to }));
    const cols = [{ label: 'Tech', key: 'name' }, { label: 'Total hrs', num: 1, get: r => num(r.total_hours), csv: r => r.total_hours }, { label: 'On-job hrs', num: 1, get: r => num(r.job_hours), csv: r => r.job_hours },
      { label: 'Utilization', num: 1, get: r => pct(r.utilization_pct), csv: r => r.utilization_pct }, { label: 'Jobs worked', num: 1, key: 'jobs_worked' }, { label: 'Completed', num: 1, key: 'jobs_completed' },
      { label: 'Revenue', num: 1, get: r => money0(r.revenue_attributed), csv: r => r.revenue_attributed }, { label: 'Rev / hr', num: 1, get: r => money(r.revenue_per_hour), csv: r => r.revenue_per_hour }];
    R.innerHTML = `<div class="card"><h2>Tech performance — ${sub}</h2><p class="small muted">Revenue is invoiced revenue on each job, split by each tech's share of hours on that job. Utilization = on-job hours ÷ all clocked hours.</p>${table(cols, rows.filter(r => r.total_hours > 0), { empty: 'No time in range' })}</div>`;
    csv = () => toCSV(cols, rows, `tech_performance_${from}_${to}.csv`);
  }
  if (r === 'ar') {
    const a = await GET('/reports/ar-aging');
    const cols = [{ label: 'Invoice', html: i => `<a href="#/invoices/${i.id}">${esc(i.number)}</a>`, csv: i => i.number }, { label: 'Customer', key: 'customer_name' }, { label: 'Issued', get: i => fmtDate(i.issue_date) },
      { label: 'Due', get: i => fmtDate(i.due_date) }, { label: 'Days late', num: 1, html: i => i.days_past_due ? `<span class="pill ${i.days_past_due > 60 ? 'bad' : 'warn'}">${i.days_past_due}</span>` : '—', csv: i => i.days_past_due },
      { label: 'Balance', num: 1, get: i => money(i.balance), csv: i => i.balance }];
    R.innerHTML = `<div class="grid g4">${kpi('Current', money0(a.buckets.current))}${kpi('1–30 days', money0(a.buckets.d1_30))}${kpi('31–60 days', money0(a.buckets.d31_60))}${kpi('60+ days', money0(a.buckets.d61_90 + a.buckets.d90_plus), a.buckets.d90_plus ? `${money0(a.buckets.d90_plus)} over 90` : '')}</div>
      <div class="card" style="margin-top:14px"><h2>Open receivables — ${money(a.total)}</h2>${table(cols, a.invoices, { empty: 'Nothing outstanding 🎉' })}</div>`;
    csv = () => toCSV(cols, a.invoices, 'ar_aging.csv');
  }
  if (r === 'est') {
    const e = await GET('/reports/estimates' + qs({ from, to }));
    R.innerHTML = `<div class="grid g4">${kpi('Close rate', pct(e.close_rate_pct), `${e.approved} won of ${e.sent} sent`)}${kpi('Won value', money0(e.approved_value))}${kpi('Still open', money0(e.open_value), `${e.open} estimates`)}${kpi('Avg. won ticket', money0(e.avg_ticket))}</div>
      <div class="card" style="margin-top:14px"><p>Estimates created ${sub}: <b>${e.count}</b> · sent <b>${e.sent}</b> (${money0(e.sent_value)}) · approved <b>${e.approved}</b> · declined/expired <b>${e.declined}</b>.</p><a href="#/estimates?status=sent">Follow up on open estimates →</a></div>`;
  }
  if (r === 'cc') csv = await costCodeReportView(R, from, to, sub);
  if (r === 'source') {
    const rows = await GET('/reports/lead-sources' + qs({ from, to }));
    const cols = [{ label: 'Source', key: 'source' }, { label: 'Jobs', num: 1, key: 'jobs' }, { label: 'Invoiced revenue', num: 1, get: r => money0(r.revenue), csv: r => r.revenue }, { label: 'Rev / job', num: 1, get: r => money0(r.jobs ? r.revenue / r.jobs : 0), csv: r => r.jobs ? r.revenue / r.jobs : 0 }];
    R.innerHTML = `<div class="card"><h2>Lead sources — jobs created ${sub}</h2><p class="small muted">Compare against your Marketing expenses to find cost per job by channel.</p>${table(cols, rows, { empty: 'No jobs in range' })}</div>`;
    csv = () => toCSV(cols, rows, `lead_sources_${from}_${to}.csv`);
  }
}

// ============================================================ team & settings
async function viewTeam() {
  const users = await loadUsers(true);
  $('#view').innerHTML = setTop('Team', '<button class="btn primary" id="new">+ Employee</button>', 'Wage + burden = loaded labor cost used in job costing and P&L. Bill rate is used for T&M invoices.') + `<div class="card">
    ${table([{ label: 'Name', html: u => `<span class="dot" style="background:${esc(u.color)}"></span> <b>${esc(u.name)}</b>${u.active ? '' : ' <span class="pill">Inactive</span>'}<div class="muted small">${esc(u.email)}</div>` },
      { label: 'Role', get: u => label(u.role) }, { label: 'Title', key: 'title' }, { label: 'License', key: 'license_number' }, { label: 'Wage', num: 1, get: u => money(u.hourly_wage) },
      { label: 'Burden', num: 1, get: u => pct(u.burden_pct) }, { label: 'Loaded cost/hr', num: 1, get: u => money(u.hourly_wage * (1 + u.burden_pct / 100)) }, { label: 'Bill rate', num: 1, get: u => money(u.bill_rate) }],
    users, { onClick: u => userForm(u) })}</div>`;
  $('#new').onclick = () => userForm({});
}
function userForm(u) {
  formModal({
    title: u.id ? `Edit ${u.name}` : 'Add employee', values: u, wide: true,
    fields: [{ name: 'name', label: 'Name', required: true }, { name: 'email', label: 'Email (login)', type: 'email', required: true },
      { name: 'role', label: 'Role', type: 'select', options: [['tech', 'Technician (field app only)'], ['office', 'Office (no settings/team)'], ['admin', 'Admin (everything)']], blank: false, default: 'tech' },
      { name: 'title', label: 'Title (Apprentice, Journeyman…)' }, { name: 'phone', label: 'Phone' }, { name: 'license_number', label: 'License #' },
      { name: 'hourly_wage', label: 'Hourly wage $', type: 'number', default: 0 }, { name: 'burden_pct', label: 'Burden % (taxes, WC, benefits)', type: 'number', default: 25 },
      { name: 'bill_rate', label: 'Bill rate $/hr', type: 'number', default: 0 }, { name: 'color', label: 'Schedule color', type: 'color', default: '#2563eb' },
      { name: 'password', label: u.id ? 'New password (leave blank to keep)' : 'Password (8+ chars)', type: 'password', required: !u.id },
      { name: 'active', label: 'Active (can sign in)', type: 'checkbox', default: 1 }],
    submit: async d => { if (!d.password) delete d.password; if (u.id) await PUT('/users/' + u.id, d); else await POST('/users', d); await loadUsers(true); toast('Saved'); route(); },
  });
}
async function viewSettings() {
  const s = S.settings;
  const fields = [{ name: 'company_name', label: 'Company name' }, { name: 'license_number', label: 'Contractor license #' }, { name: 'company_phone', label: 'Phone' }, { name: 'company_email', label: 'Email' },
    { name: 'company_address', label: 'Address', full: true }, { name: 'default_tax_rate', label: 'Default sales tax %', type: 'number' }, { name: 'invoice_terms_days', label: 'Default invoice terms (days)', type: 'number' },
    { name: 'estimate_valid_days', label: 'Estimates valid for (days)', type: 'number' }, { name: 'target_gross_margin', label: 'Target gross margin %', type: 'number' },
    { name: 'overtime_weekly_hours', label: 'Overtime after (hrs/week)', type: 'number' }, { name: 'overtime_multiplier', label: 'Overtime multiplier', type: 'number' },
    { name: 'estimate_terms', label: 'Default estimate terms', type: 'textarea', full: true }, { name: 'invoice_terms', label: 'Default invoice terms', type: 'textarea', full: true }];
  const outbox = await GET('/outbox');
  $('#view').innerHTML = setTop('Settings') + `<div class="grid g2"><div class="card"><h2>Company</h2><form id="sf"><div class="form-grid">${fields.map(f => fieldHtml(f, s[f.name])).join('')}</div>
      ${isAdmin() ? '<div class="row" style="margin-top:12px"><button class="btn primary">Save settings</button></div>' : '<p class="muted">Only admins can change settings.</p>'}</form></div>
    <div class="stack"><div class="card"><h2>Change my password</h2><form id="pw" class="stack">${fieldHtml({ name: 'current', label: 'Current password', type: 'password', required: true })}${fieldHtml({ name: 'next', label: 'New password (8+)', type: 'password', required: true })}<button class="btn">Change password</button></form></div>
    <div class="card"><h2>Email delivery</h2>${outbox.some(o => o.status === 'not_configured') || !outbox.length ? `<div class="alert info">To email estimates and invoices directly, set <code>SMTP_HOST</code>, <code>SMTP_PORT</code>, <code>SMTP_USER</code>, <code>SMTP_PASS</code> and <code>SMTP_FROM</code> on the server (see README). Until then, "Send" marks the document as sent and copies the customer link for you to text or email.</div>` : ''}
      <h3 style="margin-top:12px">Recent messages</h3>${table([{ label: 'When', get: o => fmtDT(o.created_at) }, { label: 'To', key: 'to_email' }, { label: 'Subject', key: 'subject' }, { label: 'Status', html: o => pill(o.status) }], outbox.slice(0, 15), { empty: 'Nothing sent yet' })}</div>
    <div class="card"><h2>Appearance</h2><div class="row"><button class="btn" data-theme="">System</button><button class="btn" data-theme="light">Light</button><button class="btn" data-theme="dark">Dark</button></div></div></div></div>
    <div id="settings-ext" class="stack" style="margin-top:14px"></div>`;
  settingsExtras($('#settings-ext'));
  if (isAdmin()) $('#sf').onsubmit = async e => { e.preventDefault(); S.settings = await act(() => PUT('/settings', readForm(e.target, fields)), 'Settings saved'); renderShell(); route(); };
  else $$('#sf input, #sf textarea').forEach(i => i.disabled = true);
  $('#pw').onsubmit = async e => { e.preventDefault(); await act(() => POST('/me/password', { current: e.target.current.value, next: e.target.next.value }), 'Password changed'); e.target.reset(); };
  $$('[data-theme]').forEach(b => b.onclick = () => { const t = b.dataset.theme; localStorage.setItem('fo_theme', t); applyTheme(); });
}
function applyTheme() { const t = localStorage.getItem('fo_theme'); if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme; }

applyTheme();
// boot() runs from ext.js once all views are defined
