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
// per-employee permissions (Team → edit person). Admins can do everything.
const can = k => !!S.user && (S.user.role === 'admin' || !!(S.user.perms || {})[k]);
// the company workweek (payroll, overtime): Sunday–Saturday unless Settings says Monday–Sunday
const weekOffset = d => (d.getDay() - (S.settings.workweek_start === 'mon' ? 1 : 0) + 7) % 7;
const weekLabel = () => (S.settings.workweek_start === 'mon' ? 'Monday–Sunday' : 'Sunday–Saturday');
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
  if (Array.isArray(data) && res.headers.get('X-Total-Count')) data.total = Number(res.headers.get('X-Total-Count'));
  if (Array.isArray(data) && res.headers.get('X-Sums')) { try { data.sums = JSON.parse(res.headers.get('X-Sums')); } catch { /* ignore */ } }
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
  if (f.type === 'customer') return customerFieldHtml(f, val);
  if (f.type === 'job') return jobFieldHtml(f, val);
  if (f.type === 'address') return addressFieldHtml(f, val);
  if (f.type === 'hidden') return `<input type="hidden" name="${f.name}" value="${esc(val)}">`;
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
    if ((f.type === 'customer' || f.type === 'job') && f.required && !el.value) throw new Error(`Choose the ${f.label.toLowerCase()} from the search list`);
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
function table(cols, rows, { onClick, empty = 'Nothing here yet', foot, sort } = {}) {
  if (!rows.length) return `<div class="empty">${esc(empty)}</div>`;
  const id = 't' + Math.random().toString(36).slice(2);
  setTimeout(() => {
    const t = document.getElementById(id); if (!t) return;
    if (sort) $$('th[data-sk]', t).forEach(th => { th.onclick = () => sort.go(th.dataset.sk); th.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); sort.go(th.dataset.sk); } }; });
    if (!onClick) return;
    $$('tbody tr', t).forEach((tr, i) => tr.onclick = e => { if (!e.target.closest('a,button,input,select')) onClick(rows[i], e); });
  });
  const head = c => {
    if (!sort || !c.sort) return `<th class="${c.num ? 'num' : ''}">${esc(c.label)}</th>`;
    const on = sort.by === c.sort, arrow = on ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : '';
    return `<th class="${c.num ? 'num ' : ''}sortable${on ? ' on' : ''}" data-sk="${esc(c.sort)}" tabindex="0" role="button" aria-sort="${on ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}" title="Sort by ${esc(c.label.toLowerCase())}">${esc(c.label)}<span class="sarrow">${arrow}</span></th>`;
  };
  return `<div class="table-wrap"><table id="${id}"><thead><tr>${cols.map(head).join('')}</tr></thead>
    <tbody>${rows.map(r => `<tr class="${onClick ? 'click' : ''}">${cols.map(c => `<td class="${c.num ? 'num' : ''}">${c.html ? c.html(r) : esc(c.get ? c.get(r) : r[c.key])}</td>`).join('')}</tr>`).join('')}</tbody>
    ${foot ? `<tfoot><tr>${foot.map(f => `<td class="${f && f.num ? 'num' : ''}">${f ? esc(f.v ?? f) : ''}</td>`).join('')}</tr></tfoot>` : ''}</table></div>`;
}
// list pages keep filters/sort/page in the URL, so Back and bookmarks work
// clicking the sorted column flips it; a new column starts in its natural order (dates and money newest/largest first)
function listSort(params, base, def, descFirst = []) {
  const by = params.get('order') || def.by, dir = params.get('dir') || (params.get('order') ? (descFirst.includes(by) ? 'desc' : 'asc') : def.dir);
  return { by, dir, go: k => {
    const p = new URLSearchParams(params); p.delete('page');
    p.set('order', k); p.set('dir', k === by ? (dir === 'asc' ? 'desc' : 'asc') : descFirst.includes(k) ? 'desc' : 'asc');
    go(base + '?' + p.toString());
  } };
}
// a filter form's values → URL (empty ones dropped); keeps tab/status and sort
function listFilterGo(form, base, keep = {}) {
  const o = { ...keep };
  for (const el of form.elements) if (el.name) o[el.name] = el.type === 'checkbox' ? (el.checked ? '1' : '') : el.value.trim();
  go(base + qs(o));
}
function listPager(total, page, per, link) {
  const pages = Math.max(1, Math.ceil(total / per));
  return pages > 1 ? `<div class="row" style="margin-top:10px;justify-content:center;gap:8px">${page > 1 ? `<a class="btn" href="${link(page - 1)}">‹ Previous</a>` : ''}<span class="muted">Page ${page} of ${pages}</span>${page < pages ? `<a class="btn" href="${link(page + 1)}">Next ›</a>` : ''}</div>` : '';
}
const listCount = (total, shown, page, per, noun) => `<p class="small muted" style="margin:6px 0">${total.toLocaleString()} ${noun}${total === 1 ? '' : 's'}${total > shown ? ` · showing ${((page - 1) * per + 1).toLocaleString()}–${((page - 1) * per + shown).toLocaleString()}` : ''}</p>`;

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
  { href: '#/dashboard', label: 'Dashboard', icon: '▦', roles: ['admin', 'manager', 'office'] },
  { href: '#/schedule', label: 'Schedule & Dispatch', icon: '🗓' },
  { href: '#/jobs', label: 'Jobs', icon: '🔧' },
  { href: '#/time', label: 'Time Clock', icon: '⏱' },
  { href: '#/picklists', label: 'Pick Lists', icon: '🧺', roles: ['tech'] },
  { href: '#/permits', label: 'Permits & Inspections', icon: '📋' },
  { sect: 'Sales & Billing', roles: ['admin', 'manager', 'office'] },
  { href: '#/pipeline', label: 'Pipeline', icon: '🧭', roles: ['admin', 'manager', 'office'] },
  { href: '#/customers', label: 'Customers', icon: '👥', roles: ['admin', 'manager', 'office'] },
  { href: '#/estimates', label: 'Estimates', icon: '📝', roles: ['admin', 'manager', 'office'], perm: 'estimates' },
  { href: '#/estimates', label: 'My Estimates', icon: '📝', roles: ['tech'], perm: 'field_estimates' },
  { href: '#/invoices', label: 'Invoices', icon: '💵', roles: ['admin', 'manager', 'office'], perm: 'invoices' },
  { href: '#/agreements', label: 'Service Agreements', icon: '🔁', roles: ['admin', 'manager', 'office'] },
  { sect: 'Back Office', roles: ['admin', 'manager', 'office'] },
  { href: '#/purchasing', label: 'Purchasing & Pick Lists', icon: '🚚', roles: ['admin', 'manager', 'office'], perm: 'purchasing' },
  { href: '#/vendors', label: 'Vendors', icon: '🏭', roles: ['admin', 'manager', 'office'], perm: ['purchasing', 'accounting'] },
  { href: '#/pricebook', label: 'Price Book & Inventory', icon: '📦', roles: ['admin', 'manager', 'office'] },
  { href: '#/expenses', label: 'Expenses', icon: '🧾', roles: ['admin', 'manager', 'office'], perm: 'expenses' },
  { href: '#/reports', label: 'Reports', icon: '📈', roles: ['admin', 'manager', 'office'], perm: ['reports', 'timesheets', 'jobs'] },
  { href: '#/accounting', label: 'Accounting', icon: '📒', roles: ['admin', 'manager', 'office'], perm: 'accounting' },
  { href: '#/team', label: 'Team', icon: '👷', roles: ['admin'] },
  { href: '#/estimating', label: 'Estimating', icon: '📐', roles: ['admin', 'manager'] },
  { href: '#/kpi', label: 'KPIs', icon: '🎯', roles: ['admin', 'manager', 'office'], show: () => S.user.kpi || isAdmin() },
  { href: '#/notifications', label: 'Notifications', icon: '🔔' },
  { href: '#/settings', label: 'Settings', icon: '⚙', roles: ['admin', 'manager', 'office'] },
];
function renderShell() {
  const nav = NAV.filter(n => (!n.roles || n.roles.includes(S.user.role)) && (!n.perm || [].concat(n.perm).some(can)) && (!n.show || n.show()));
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
  [/^\/kpi$/, () => viewKpi()], [/^\/estimating$/, () => viewEstimating()], [/^\/estimating\/takeoff\/(\d+)$/, id => viewTakeoff(id)], [/^\/estimating\/proposal\/(\d+)$/, id => viewProposal(id)], [/^\/notifications$/, () => viewNotifications()], [/^\/dashboard$/, viewDashboard], [/^\/my-day$/, () => viewMyDay2()], [/^\/schedule$/, () => viewScheduleHub()],
  [/^\/purchasing$/, () => viewPurchasing()], [/^\/vendors$/, () => viewVendors()], [/^\/vendors\/(\d+)$/, id => viewVendor(id)], [/^\/purchasing\/po\/(new|\d+)$/, id => viewPO(id)], [/^\/(?:purchasing\/)?pick\/(\d+)$/, id => viewPickList(id)],
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
    if (typeof refreshPush === 'function') refreshPush();
  } catch { /* api() already handled 401 */ }
}

// ============================================================ shared pickers
// (kept for old callers) the most recent open jobs as select options; pickers use the 'job' search field instead
async function jobPicker() {
  const list = await GET('/jobs' + qs({ status: 'unscheduled,scheduled,dispatched,in_progress,on_hold,completed', limit: 1000 }));
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
  const money = d.money !== false;
  const gmOk = money && d.mtd.gross_margin_pct >= d.target_gross_margin;
  const overdue = money ? d.ar.total - d.ar.buckets.current : 0;
  $('#view').innerHTML = setTop('Dashboard', `${can('jobs') ? '<a class="btn" href="#/jobs?new=1">+ Book job</a>' : ''}${can('estimates') ? '<a class="btn" href="#/estimates/new">+ Estimate</a>' : ''}${can('invoices') ? '<a class="btn primary" href="#/invoices/new">+ Invoice</a>' : ''}`,
    new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })) + `
    <div class="grid g4">${money ? `
      ${kpi('Revenue · month to date', money0(d.mtd.revenue), `${money0(d.mtd.cash_collected)} collected`)}
      ${kpi('Gross margin · MTD', pct(d.mtd.gross_margin_pct), `<span class="pill ${gmOk ? 'good' : 'warn'}">${gmOk ? '✓ at/above' : '⚠ below'} ${d.target_gross_margin}% target</span>`)}
      ${kpi('Receivables', money0(d.ar.total), overdue > 0 ? `<span class="pill bad">⚠ ${money0(overdue)} past due</span>` : 'nothing past due')}
      ${kpi('Open estimates', money0(d.open_estimates.open_value), `${d.open_estimates.open} awaiting answer · ${pct(d.open_estimates.close_rate_pct)} close rate`)}` : `
      ${kpi("Today's visits", d.today_jobs.length)}${kpi('Waiting to be scheduled', d.unscheduled)}${kpi('On the clock now', d.clocked_in.length)}${kpi('Ready to invoice', d.to_invoice.length)}`}
    </div>
    <div class="card" style="margin-top:14px" id="weekcard"><h2>Week at a glance</h2><div class="muted">Loading…</div></div>
    <div class="grid g2" style="margin-top:14px">
      <div class="card"><div class="row spread"><h2>Today's visits</h2><a href="#/schedule">Tech board →</a></div>
        ${table([{ label: 'Time', get: a => `${fmtTime(a.start)}–${fmtTime(a.end)}` }, { label: 'Job', html: a => `<b>${esc(a.job_number)}</b> ${esc(a.job_title)}<div class="muted small">${esc(a.customer_name)} · ${esc(a.address || '')}</div>` },
          { label: 'Tech', get: a => a.tech_names || 'Unassigned' }, { label: 'Status', html: a => pill(a.status) }], d.today_jobs, { onClick: a => go(a.href), empty: 'No visits scheduled today' })}
        ${d.unscheduled ? `<div class="alert" style="margin-top:10px">${d.unscheduled} job(s) waiting to be scheduled. <a href="#/schedule">Schedule them</a></div>` : ''}
      </div>
      ${money ? `<div class="card"><h2>Revenue — last 6 months</h2>${bars(d.trend, 'revenue', 'month')}
        <div class="small muted" style="margin-top:8px">Hover a bar for net profit. Full detail in <a href="#/reports">Reports</a>.</div></div>` : ''}
    </div>
    <div class="grid g3" style="margin-top:14px">
      <div class="card"><h2>Ready to invoice</h2>
        ${d.wip && (d.wip.unbilled_tm || d.wip.under_billed) ? `<div class="alert info" style="margin-bottom:8px">${money0(d.wip.unbilled_tm)} unbilled T&amp;M · ${money0(d.wip.under_billed)} under-billed on quoted jobs. <a href="#/reports?r=wip">WIP report →</a></div>` : ''}${table([{ label: 'Job', html: j => `<b>${esc(j.number)}</b> ${esc(j.title)}<div class="muted small">${esc(j.customer_name)}</div>` },
        { label: '', html: j => `<button class="btn sm primary" data-inv="${j.id}">Invoice</button>` }], d.to_invoice, { onClick: j => go('#/jobs/' + j.id), empty: 'All completed jobs are invoiced' })}
        ${d.estimates_review ? `<div class="alert" style="margin-top:8px">📝 ${d.estimates_review} tech estimate(s) waiting for your pricing review — customers can't sign yet. <a href="#/estimates?status=review">Review →</a></div>` : ''}</div>
      <div class="card"><h2>On the clock now</h2>${table([{ label: 'Who', key: 'user_name' }, { label: 'On', get: t => t.job_number ? `${t.job_number} ${t.job_title}` : label(t.kind) }, { label: 'Since', get: t => fmtTime(t.clock_in) }], d.clocked_in, { empty: 'Nobody is clocked in' })}</div>
      <div class="card"><h2>Watch list</h2>
        ${(d.follow_ups_due || []).map(f => `<div class="row spread" style="padding:4px 0"><span>Follow up · <a href="#/jobs/${f.id}">${esc(f.number)}</a> ${esc(f.title || '')}<div class="small muted">${f.hold_assignee === S.user.id ? '<b>Your task</b> · ' : f.assignee_name ? `${esc(f.assignee_name)} · ` : ''}${esc((f.hold_reason || 'no reason recorded').slice(0, 80))}</div></span><span class="pill ${!f.hold_follow_up || f.hold_follow_up < todayStr() ? 'bad' : 'warn'}">${f.hold_follow_up ? (f.hold_follow_up < todayStr() ? 'overdue ' : 'today ') + fmtDate(f.hold_follow_up) : 'no date'}</span></div>`).join('')}
        ${d.inspections_upcoming.map(p => `<div class="row spread" style="padding:4px 0"><span>📋 ${esc(p.permit_type || 'Inspection')} · <a href="#/jobs/${p.job_id}">${esc(p.job_number)}</a></span><span class="muted">${fmtDate(p.inspection_date)}</span></div>`).join('')}
        ${d.agreements_due.map(a => `<div class="row spread" style="padding:4px 0"><span>🔁 ${esc(a.customer_name)} — ${esc(a.name)}</span><span class="muted">${fmtDate(a.next_visit)}</span></div>`).join('')}
        ${d.low_stock.map(p => `<div class="row spread" style="padding:4px 0"><span>📦 Low stock: ${esc(p.name)}</span><span class="pill warn">${num(p.qty_on_hand)} left</span></div>`).join('')}
        ${(money ? d.ar.invoices : []).filter(i => i.days_past_due > 0).slice(0, 5).map(i => `<div class="row spread" style="padding:4px 0"><span>💵 <a href="#/invoices/${i.id}">${esc(i.number)}</a> ${esc(i.customer_name)}</span><span class="pill bad">${i.days_past_due}d · ${money0(i.balance)}</span></div>`).join('')}
        ${!(d.follow_ups_due || []).length && !d.inspections_upcoming.length && !d.agreements_due.length && !d.low_stock.length && !(money ? d.ar.invoices : []).some(i => i.days_past_due > 0) ? '<div class="empty">All clear</div>' : ''}
      </div>
    </div>`;
  $$('[data-inv]').forEach(b => b.onclick = async () => { const r = await act(() => POST(`/jobs/${b.dataset.inv}/invoice`), 'Invoice created'); go('#/invoices/' + r.id); });
  weekCard($('#weekcard'), todayStr(), { compact: true }).catch(e => { $('#weekcard').innerHTML = `<h2>Week at a glance</h2><div class="empty">${esc(e.message)}</div>`; });
}

// ============================================================ time clock widget
function elapsed(from) { const s = Math.max(0, Math.floor((Date.now() - new Date(from)) / 1000)); return `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; }
async function clockCard(el, { jobId } = {}) {
  const [{ open }, opts] = await Promise.all([GET('/time/status'), GET('/time/options'), loadCostCodes()]);
  const projById = Object.fromEntries(opts.projects.map(p => [String(p.id), p]));
  const labor = S.costCodes.filter(c => c.active !== 0 && (c.kind === 'labor' || c.kind === 'both'));
  const draw = () => {
    el.innerHTML = `<div class="card clock">
      ${open ? `<div class="muted">Clocked in${open.job_number ? ` on <a href="#/jobs/${open.job_id}">${esc(open.job_number)} ${esc(open.job_title)}</a>` : ` — ${esc(label(open.kind))}`}${open.cost_code ? ` · ${esc(open.cost_code)} ${esc(open.cost_code_name)}` : ''} since ${fmtTime(open.clock_in)}</div>
        <div class="timer" id="timer">${elapsed(open.clock_in)}</div>` : `<div class="muted">You are off the clock</div><div class="timer">0:00:00</div>`}
      <div class="row" style="justify-content:center;flex-wrap:wrap">
        <select id="ck_job" style="max-width:340px"><option value="">— No job (shop/training) —</option>
          ${opts.jobs.length ? `<optgroup label="My jobs">${opts.jobs.map(j => `<option value="${j.id}" ${String(jobId || '') === String(j.id) ? 'selected' : ''}>${esc(j.number)} · ${esc(j.title)}</option>`).join('')}</optgroup>` : ''}
          ${opts.projects.length ? `<optgroup label="Commercial projects">${opts.projects.map(j => `<option value="${j.id}" ${String(jobId || '') === String(j.id) ? 'selected' : ''}>${esc(j.number)} · ${esc(j.title)} (${esc(j.customer_name)})</option>`).join('')}</optgroup>` : ''}</select>
        <select id="ck_kind" style="max-width:140px">${['job', 'travel', 'shop', 'training'].map(k => `<option value="${k}">${label(k)}</option>`).join('')}</select>
        <select id="ck_cc" style="max-width:300px"></select>
      </div>
      <div class="small muted" id="ck_hint" style="text-align:center;margin-top:6px"></div>
      <div class="row" style="justify-content:center;margin-top:12px">
        <button class="btn big go" id="ck_in">${open ? 'Switch job' : 'Clock in'}</button>
        ${open ? '<button class="btn big stop" id="ck_out">Clock out</button>' : ''}
      </div></div>`;
    const jobSel = $('#ck_job', el), ccSel = $('#ck_cc', el), kindSel = $('#ck_kind', el);
    // a project's budgeted codes come first; the rest stay available below
    const fillCodes = () => {
      const p = projById[jobSel.value], keep = ccSel.value;
      const mine = p ? labor.filter(c => p.cost_code_ids.includes(c.id)) : [], rest = labor.filter(c => !mine.includes(c));
      const opt = c => `<option value="${c.id}">${esc(c.code)} · ${esc(c.name)}</option>`;
      const need = p && opts.require_cost_code && kindSel.value === 'job';
      ccSel.innerHTML = `<option value="">${need ? 'Cost code (required)…' : 'Cost code…'}</option>` +
        (mine.length ? `<optgroup label="This project">${mine.map(opt).join('')}</optgroup><optgroup label="Other codes">${rest.map(opt).join('')}</optgroup>` : rest.map(opt).join(''));
      if ([...ccSel.options].some(o => o.value === keep)) ccSel.value = keep;
      ccSel.classList.toggle('need', !!need && !ccSel.value);
      $('#ck_hint', el).textContent = need ? 'Commercial project: pick the cost code you are working on. Switch job when you change tasks.' : '';
    };
    jobSel.onchange = fillCodes; kindSel.onchange = fillCodes; ccSel.onchange = () => ccSel.classList.remove('need');
    fillCodes();
    $('#ck_in', el).onclick = async () => {
      const job_id = jobSel.value || null; let kind = kindSel.value;
      if (!job_id && (kind === 'job' || kind === 'travel')) kind = 'shop';
      if (projById[job_id] && opts.require_cost_code && kind === 'job' && !ccSel.value) { ccSel.focus(); return toast('Pick a cost code for this project', true); }
      const loc = await getLoc();
      await act(() => POST('/time/clock-in', { job_id, kind, cost_code_id: ccSel.value || null, ...loc }), 'Clocked in'); route();
    };
    if (open) $('#ck_out', el).onclick = async () => { const loc = await getLoc(); await act(() => POST('/time/clock-out', loc), 'Clocked out'); route(); };
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
  const techs = S.users.filter(u => u.active && (u.role === 'tech' || u.on_schedule || jobs.some(j => j.tech_ids.includes(u.id))));
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
  const fields = [
    { name: 'customer_id', label: 'Customer', type: 'customer', required: true, full: true },
    { name: 'location_id', label: 'Service location', type: 'select', options: [], full: true },
    { name: 'title', label: 'Job title', required: true, full: true, placeholder: 'e.g. Replace 100A panel with 200A' },
    { name: 'job_type', label: 'Job type', type: 'select', options: JOB_TYPES, blank: false, default: 'service' },
    { name: 'priority', label: 'Priority', type: 'select', options: ['low', 'normal', 'high', 'emergency'], blank: false, default: 'normal' },
    { name: 'scheduled_start', label: 'Start', type: 'datetime' }, { name: 'scheduled_end', label: 'End', type: 'datetime' },
    { name: 'status', label: 'Status', type: 'select', options: JOB_STATUSES, blank: 'Auto' },
    { name: 'lead_source', label: 'Lead source', type: 'select', options: LEAD_SOURCES },
    { name: 'billing_type', label: 'How is this job priced?', type: 'select', options: [['tm', 'Time & material — bill hours and parts'], ['fixed', 'Quoted price — bill the contract']], blank: false, default: 'tm', full: true },
    { name: 'contract_amount', label: 'Contract / quoted price $', type: 'number', bt: 'fixed' }, { name: 'retainage_pct', label: 'Retainage % (commercial)', type: 'number', bt: 'fixed' },
    { name: 'labor_rate', label: 'Labor rate $/h (blank = tech bill rates)', type: 'number', bt: 'tm' }, { name: 'material_markup_pct', label: 'Material markup % (blank = price book)', type: 'number', bt: 'tm' },
    { name: 'trip_charge', label: 'Trip / service charge $', type: 'number', bt: 'tm' }, { name: 'nte_amount', label: 'Not-to-exceed $ (optional)', type: 'number', bt: 'tm' },
    { name: 'bill_travel', label: 'Bill travel time', type: 'checkbox', default: 1, bt: 'tm' },
    { name: 'po_number', label: 'Customer PO #' },
    { name: 'budget_hours', label: 'Budgeted labor hours', type: 'number' }, { name: 'budget_materials', label: 'Budgeted material cost ($)', type: 'number' },
    { name: 'description', label: 'Scope / description', type: 'textarea', full: true },
    { name: 'is_project', label: 'Commercial project: track progress by cost code, crew and daily logs', type: 'checkbox', full: true },
    { name: 'project_manager_id', label: 'Project manager', type: 'select', options: S.users.filter(u => u.active && u.role !== 'tech').map(u => [u.id, u.name]), proj: 1 },
    { name: 'foreman_id', label: 'Foreman (can update progress)', type: 'select', options: S.users.filter(u => u.active).map(u => [u.id, `${u.name}${u.title ? ` · ${u.title}` : ''}`]), proj: 1 },
    { name: 'start_date', label: 'Start date', type: 'date', proj: 1 }, { name: 'end_date', label: 'Target completion', type: 'date', proj: 1 },
    { name: 'gc_contact', label: 'GC / site contact', proj: 1 }, { name: 'gc_phone', label: 'Site contact phone', type: 'tel', proj: 1 },
    { name: 'gc_email', label: 'Site contact email', type: 'email', proj: 1 },
    { name: 'timeclock_job', label: 'Time clock job # (A4Y Time Clock)', placeholder: 'e.g. 2417', proj: 1 },
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
      if (data.status === 'on_hold' && job.status !== 'on_hold') { const h = await holdPrompt(job); if (!h) return; Object.assign(data, h); }
      // clear the other model's fields so a job isn't half fixed, half T&M
      for (const f of fields.filter(x => x.bt && x.bt !== data.billing_type)) data[f.name] = f.type === 'checkbox' ? 1 : null;
      if (job.id) { inviteToast(await PUT('/jobs/' + job.id, data), 'Job saved'); route(); }
      else { const r = await POST('/jobs', data); inviteToast(r, 'Job booked'); go('#/jobs/' + r.id); }
    },
  });
  const form = $('form', m.el);
  // show only the pricing fields for the chosen billing type
  const showBT = () => fields.filter(f => f.bt).forEach(f => { const el = form.elements[f.name]; const box = el && el.closest('label'); if (box) box.style.display = form.billing_type.value === f.bt ? '' : 'none'; });
  form.billing_type.onchange = showBT; showBT();
  const showProj = () => fields.filter(f => f.proj).forEach(f => { const box = form.elements[f.name] && form.elements[f.name].closest('label'); if (box) box.style.display = form.is_project.checked ? '' : 'none'; });
  form.is_project.onchange = () => { showProj(); if (form.is_project.checked && !job.id) { form.billing_type.value = 'fixed'; form.job_type.value = 'commercial'; showBT(); } };
  showProj();
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
  const F = ['q', 'job_type', 'billing_type', 'kind', 'tech_id', 'sched_from', 'sched_to'];
  const f = Object.fromEntries(F.map(k => [k, params.get(k) || '']));
  const sort = listSort(params, '#/jobs', { by: 'scheduled', dir: 'asc' }, ['created', 'completed', 'number']);
  const jobs = await GET('/jobs' + qs({ status: status === 'all' ? '' : status, ...(isOffice() ? f : { q: f.q }), order: sort.by, dir: sort.dir }));
  const tabs = [['unscheduled,scheduled,dispatched,in_progress,on_hold,completed', 'Open'], ['unscheduled', 'Unscheduled'], ['in_progress', 'In progress'], ['completed', 'Needs invoice'], ['invoiced', 'Invoiced'], ['all', 'All'], ['cancelled', 'Cancelled'], ['', 'All']];
  const keep = { status, order: params.get('order'), dir: params.get('dir') };
  const filtered = F.some(k => f[k]);
  $('#view').innerHTML = setTop('Jobs', isOffice() ? '<button class="btn primary" id="new">+ Book job</button>' : '') + `<div class="card">
    <div class="tabs" style="margin:0;border:0">${tabs.map(([v, l]) => `<button class="${v === status ? 'on' : ''}" data-s="${v}">${l}</button>`).join('')}</div>
    <form id="srch" class="filters"><input name="q" type="search" placeholder="Search job #, customer, address, PO" value="${esc(f.q)}">
      ${isOffice() ? `<select name="job_type" aria-label="Job type"><option value="">Any type</option>${JOB_TYPES.map(t => `<option value="${t}" ${t === f.job_type ? 'selected' : ''}>${label(t)}</option>`).join('')}</select>
      <select name="kind" aria-label="Service or project"><option value="">Service + projects</option><option value="service" ${f.kind === 'service' ? 'selected' : ''}>Service jobs</option><option value="project" ${f.kind === 'project' ? 'selected' : ''}>Commercial projects</option></select>
      <select name="billing_type" aria-label="Billing"><option value="">Any billing</option><option value="fixed" ${f.billing_type === 'fixed' ? 'selected' : ''}>Fixed price</option><option value="tm" ${f.billing_type === 'tm' ? 'selected' : ''}>Time & material</option></select>
      <select name="tech_id" aria-label="Tech"><option value="">Any tech</option>${techOptions().map(([v, l]) => `<option value="${v}" ${String(v) === f.tech_id ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>
      <label class="small muted">Scheduled <input type="date" name="sched_from" value="${esc(f.sched_from)}"> to <input type="date" name="sched_to" value="${esc(f.sched_to)}"></label>` : ''}
      <button class="btn">Filter</button>${filtered ? `<a class="btn" href="#/jobs${qs({ status })}">Clear</a>` : ''}</form>
    ${listCount(jobs.total ?? jobs.length, jobs.length, 1, jobs.length, 'job')}${jobs.total > jobs.length ? '<p class="small muted" style="margin:0 0 6px">Filter or search to narrow it down.</p>' : ''}
    ${table([{ label: 'Job', sort: 'number', html: j => `<b>${esc(j.number)}</b>${j.priority === 'emergency' ? ' <span class="pill bad">Emergency</span>' : ''}<div>${esc(j.title)}</div>` },
      { label: 'Customer', sort: 'customer', html: j => `${esc(j.customer_name)} <span class="muted small">${esc(label(j.customer_type))}</span><div class="muted small">${esc(j.address || '')}</div>` },
      { label: 'Type', sort: 'type', html: j => `${esc(label(j.job_type))}<div>${billingPill(j.billing_type)}</div>` }, { label: 'Scheduled', sort: 'scheduled', get: j => fmtDT(j.scheduled_start) },
      ...(status === 'completed' || status === 'invoiced' ? [{ label: 'Completed', sort: 'completed', get: j => fmtDate(j.completed_at) }] : []),
      { label: 'Techs', get: j => j.tech_names || '—' }, { label: 'Status', sort: 'status', html: j => `${pill(j.status)}${j.status === 'on_hold' ? `<div class="small muted" title="${esc(j.hold_reason || '')}">${esc((j.hold_reason || 'no reason recorded').slice(0, 60))}</div>${j.hold_follow_up ? `<div class="small ${j.hold_follow_up < todayStr() ? 'bad' : 'muted'}">follow up ${fmtDate(j.hold_follow_up)}</div>` : ''}` : ''}` }], jobs, { onClick: j => go('#/jobs/' + j.id), empty: 'No jobs match', sort })}</div>`;
  $$('[data-s]').forEach(b => b.onclick = () => go('#/jobs' + qs({ ...f, ...keep, status: b.dataset.s })));
  $('#srch').onsubmit = e => { e.preventDefault(); listFilterGo(e.target, '#/jobs', keep); };
  $$('#srch select').forEach(s => s.onchange = () => listFilterGo($('#srch'), '#/jobs', keep));
  if (isOffice()) { $('#new').onclick = () => jobForm({}); if (params.get('new')) jobForm({}, { customerId: params.get('customer_id') }); }
}

// ---- emails & calls: what the app emailed (automatic) and calls / texts / meetings logged by hand
const COMM_KIND = { call: '📞 Call', text: '💬 Text', email: '✉️ Email', meeting: '🤝 Meeting' };
const COMM_OUTCOMES = ['Talked', 'Left voicemail', 'No answer', 'Wrong number', 'Scheduled', 'Approved', 'Declined', 'Wants a callback'];
async function commCard(el, scope, { phone, contact, rollup } = {}) {
  if (!el) return;
  const { params } = hashParams(); let show = params.get('comms') || 'all';
  el.innerHTML = '<div class="card"><h2>Emails & calls</h2><p class="muted">Loading…</p></div>';
  let r;
  try { r = await GET('/comms' + qs(scope)); } catch (e) { el.innerHTML = `<div class="card"><h2>Emails & calls</h2><p class="bad">${esc(e.message)}</p></div>`; return; }
  const draw = () => {
    const items = r.items.filter(x => show === 'all' || (show === 'email' ? x.type === 'email' : x.type === 'log'));
    const nE = r.items.filter(x => x.type === 'email').length, nL = r.items.length - nE;
    const where = x => rollup ? [x.job_number && `<a href="#/jobs/${x.job_id}">${esc(x.job_number)}</a>`, x.estimate_number && `<a href="#/estimates/${x.estimate_id}">Est ${esc(x.estimate_number)}</a>`].filter(Boolean).join(' · ') : '';
    const relLink = rel => { const [k, id] = String(rel || '').split(':'); const href = { job: '#/jobs/', estimate: '#/estimates/', invoice: '#/invoices/' }[k];
      return rollup || scope.job_id ? (href ? `<a href="${href}${id}">${esc(label(k))}</a>` : `<span>${esc(label(k))}</span>`) : ''; };
    el.innerHTML = `<div class="card comms"><div class="row spread" style="flex-wrap:wrap;gap:8px"><h2 style="margin:0">${r.emails ? 'Emails & calls' : 'Calls'}</h2>
      <div class="row" style="gap:6px;flex-wrap:wrap">${r.emails ? `<div class="seg">${[['all', `All (${r.items.length})`], ['email', `Emails (${nE})`], ['log', `Calls & notes (${nL})`]].map(([k, l]) => `<button type="button" class="${k === show ? 'on' : ''}" data-show="${k}">${l}</button>`).join('')}</div>` : ''}
        ${phone ? `<a class="btn sm" href="tel:${esc(phone)}" id="cm-dial">📞 ${esc(phone)}</a>` : ''}<button type="button" class="btn sm primary" id="cm-add">+ Log a call</button></div></div>
      ${r.emails ? '<p class="small muted" style="margin:6px 0 0">Emails are the ones this app sent (estimates, invoices, visit notices, reports). Replies and mail sent from Outlook aren\'t captured, so log anything important with “+ Log a call” → Email.</p>' : ''}
      <div class="cm-list">${items.map(x => x.type === 'email' ? `<div class="cm-item email ${x.internal ? 'internal' : ''}">
          <div class="row spread"><span><b>✉️ Email sent</b> to ${esc(x.to)}${x.internal ? ' <span class="pill">staff</span>' : ''} ${relLink(x.related)}</span><span class="small muted">${fmtDT(x.at)}</span></div>
          <div>${esc(x.subject)} ${x.status === 'sent' ? '' : `<span class="pill ${x.status === 'failed' ? 'bad' : 'warn'}" title="${esc(x.error || '')}">${esc(label(x.status))}</span>`}</div>
          <details><summary class="small">Show message</summary><div class="cm-body">${esc(x.body || '')}</div></details></div>`
        : `<div class="cm-item log"><div class="row spread"><span><b>${COMM_KIND[x.kind] || esc(x.kind)}</b> ${x.direction === 'in' ? 'from' : 'to'} ${esc(x.contact || 'customer')}${x.phone ? ` · ${esc(x.phone)}` : ''}${x.outcome ? ` · <span class="pill">${esc(x.outcome)}</span>` : ''}${x.duration_min ? ` · ${x.duration_min} min` : ''} ${where(x)}</span>
          <span class="small muted">${fmtDT(x.at)}${x.user_name ? ` · ${esc(x.user_name)}` : ''}${x.user_id === S.user.id || isAdmin() || S.user.role === 'manager' ? ` <button type="button" class="linkbtn" data-cedit="${x.id}">edit</button>` : ''}</span></div>
          ${x.body ? `<div class="cm-body">${esc(x.body)}</div>` : ''}</div>`).join('') || `<p class="muted">${r.items.length ? 'Nothing of this kind' : `No ${r.emails ? 'emails or calls' : 'calls'} yet`}</p>`}</div></div>`;
    $$('[data-show]', el).forEach(b => b.onclick = () => { show = b.dataset.show; draw(); });
    $('#cm-add', el).onclick = () => logForm();
    $$('[data-cedit]', el).forEach(b => b.onclick = () => logForm(r.items.find(x => x.type === 'log' && x.id === +b.dataset.cedit)));
    if ($('#cm-dial', el)) $('#cm-dial', el).addEventListener('click', () => setTimeout(() => logForm(null, { direction: 'out', phone }), 400));
  };
  const reload = async () => { r = await GET('/comms' + qs(scope)); draw(); };
  const logForm = (x, pre = {}) => {
    const fields = [{ name: 'kind', label: 'Type', type: 'select', blank: false, options: Object.entries(COMM_KIND) },
      { name: 'direction', label: 'Direction', type: 'select', blank: false, options: [['out', 'We contacted them'], ['in', 'They contacted us']] },
      { name: 'contact', label: 'Who', placeholder: 'Name' }, { name: 'phone', label: 'Phone / email' },
      { name: 'outcome', label: 'Outcome', list: 'cm-outcomes', placeholder: 'e.g. Left voicemail' }, { name: 'duration_min', label: 'Minutes', type: 'number' },
      { name: 'occurred_at', label: 'When', type: 'datetime', required: true },
      { name: 'body', label: 'Notes', type: 'textarea', full: true, placeholder: 'What was said, what was promised, next step' }];
    const m = formModal({ title: x ? 'Edit log entry' : 'Log a call, text, email or meeting', okLabel: x ? 'Save' : 'Log it',
      values: x || { kind: 'call', direction: 'out', contact: contact || '', occurred_at: new Date().toISOString(), ...pre }, fields,
      extra: `<datalist id="cm-outcomes">${COMM_OUTCOMES.map(o => `<option value="${esc(o)}">`).join('')}</datalist>${x ? '<div class="row" style="margin-top:8px"><button type="button" class="btn sm danger" id="cm-del">Delete entry</button></div>' : ''}`,
      submit: async v => { if (x) await PUT('/comms/' + x.id, v); else await POST('/comms', { ...scope, ...v }); toast(x ? 'Saved' : 'Logged'); await reload(); } });
    if (x && $('#cm-del', m.el)) $('#cm-del', m.el).onclick = async () => { if (!confirm('Delete this log entry?')) return; await act(() => DEL('/comms/' + x.id), 'Deleted'); m.close(); reload(); };
  };
  draw();
}

// ---- Reports → Jobs: a filterable job list; a job opens as a printable one-page summary
async function jobsReport(R, { params, from, to, sub, setCsv }) {
  const jobId = params.get('job');
  if (jobId) return jobSheet(R, jobId, setCsv);
  const f = { date_by: params.get('date_by') || 'created', status: params.get('status') || '', job_type: params.get('job_type') || '', tech_id: params.get('tech_id') || '', kind: params.get('kind') || '' };
  const d = await GET('/reports/jobs' + qs({ from, to, ...f }));
  const costs = can('see_costs'), T = d.totals;
  const techs = (S.users || []).filter(u => u.active && (u.role === 'tech' || u.on_schedule));
  R.innerHTML = `<form id="jf" class="row no-print" style="gap:8px;flex-wrap:wrap;margin:-4px 0 14px">
      <label class="small">Dates are <select name="date_by" style="width:auto">${[['created', 'Created'], ['scheduled', 'Scheduled / start'], ['completed', 'Completed']].map(([k, l]) => `<option value="${k}" ${k === f.date_by ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <select name="status" style="width:auto"><option value="">All but cancelled</option><option value="open" ${f.status === 'open' ? 'selected' : ''}>Open (not done)</option>${JOB_STATUSES.map(s => `<option value="${s}" ${s === f.status ? 'selected' : ''}>${label(s)}</option>`).join('')}</select>
      <select name="job_type" style="width:auto"><option value="">All types</option>${JOB_TYPES.map(s => `<option value="${s}" ${s === f.job_type ? 'selected' : ''}>${label(s)}</option>`).join('')}</select>
      <select name="kind" style="width:auto"><option value="">Service & projects</option><option value="service" ${f.kind === 'service' ? 'selected' : ''}>Service only</option><option value="project" ${f.kind === 'project' ? 'selected' : ''}>Projects only</option></select>
      <select name="tech_id" style="width:auto"><option value="">All techs</option>${techs.map(u => `<option value="${u.id}" ${String(u.id) === f.tech_id ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}</select>
      <button class="btn">Apply</button></form>
    <div class="grid g4">${kpi('Jobs', T.jobs, `${label(f.date_by)} ${sub}`)}${kpi('Hours', num(T.hours, 1))}${kpi('Invoiced', money0(T.revenue), `${money0(T.collected)} collected`)}${costs ? kpi('Profit', money0(T.profit), `${money0(T.total_cost)} cost`) : kpi('Contract value', money0(T.contract_amount))}</div>
    <p class="small" style="margin:10px 0">${Object.entries(d.by_status).map(([s, n]) => `${pill(s)} ${n}`).join(' &nbsp; ') || ''}</p>
    <div class="card"><h2>Jobs — ${sub}</h2><p class="small muted no-print">Click a job for its one-page report.</p>
      ${table([{ label: 'Job', html: j => `<b>${esc(j.number)}</b> ${esc(j.title || '')}${j.is_project ? ' <span class="pill">project</span>' : ''}<div class="small muted">${esc(j.customer_name)}</div>` },
        { label: 'Type', get: j => label(j.job_type) }, { label: 'Techs', get: j => j.tech_names || '—' },
        { label: 'Status', html: j => `${pill(j.status)}${j.status === 'on_hold' ? `<div class="small muted">${esc((j.hold_reason || '').slice(0, 50))}</div><div class="small ${j.hold_follow_up && j.hold_follow_up < todayStr() ? 'bad' : 'muted'}">${j.days_on_hold != null ? `${j.days_on_hold}d on hold · ` : ''}follow up ${fmtDate(j.hold_follow_up)}${j.hold_assignee_name ? ` (${esc(j.hold_assignee_name)})` : ''}</div>` : ''}` },
        { label: 'Created', get: j => fmtDate(String(j.created_at).slice(0, 10)) }, { label: 'Scheduled', get: j => j.scheduled_start ? fmtDate(j.scheduled_start) : (j.start_date ? fmtDate(j.start_date) : '—') },
        { label: 'Completed', get: j => j.completed_at ? fmtDate(String(j.completed_at).slice(0, 10)) : '—' }, { label: 'Hours', num: 1, get: j => num(j.hours, 1) },
        { label: 'Contract', num: 1, get: j => j.contract_amount ? money0(j.contract_amount) : '—' }, { label: 'Invoiced', num: 1, get: j => money0(j.revenue) },
        ...(costs ? [{ label: 'Cost', num: 1, get: j => money0(j.total_cost) }, { label: 'Margin', num: 1, html: j => j.margin_pct == null ? '—' : `<span class="${j.margin_pct < 0 ? 'bad' : ''}">${pct(j.margin_pct)}</span>` }] : [])],
        d.rows, { onClick: j => go('#/reports' + qs({ r: 'jobs', from, to, job: j.id })), empty: 'No jobs match' })}</div>`;
  $('#jf').onsubmit = e => { e.preventDefault(); const v = Object.fromEntries(new FormData(e.target)); go('#/reports' + qs({ r: 'jobs', from, to, ...v })); };
  const D10 = v => v ? String(v).slice(0, 10) : '';
  setCsv(() => toCSV([['Job', 'number'], ['Title', 'title'], ['Customer', 'customer_name'], ['Type', x => label(x.job_type)], ['Project', x => x.is_project ? 'yes' : ''], ['Status', x => label(x.status)],
    ['Hold reason', 'hold_reason'], ['Follow-up', 'hold_follow_up'], ['Follow-up with', 'hold_assignee_name'], ['Techs', 'tech_names'], ['Visits', 'visits'], ['Created', x => D10(x.created_at)],
    ['Scheduled', x => D10(x.scheduled_start) || x.start_date || ''], ['Completed', x => D10(x.completed_at)], ['Hours', 'hours'], ['Contract', 'contract_amount'], ['Invoiced', 'revenue'], ['Collected', 'collected'],
    ...(costs ? [['Cost', 'total_cost'], ['Profit', 'profit'], ['Margin %', 'margin_pct']] : [])].map(([l, g]) => typeof g === 'function' ? { label: l, csv: g } : { label: l, key: g }), d.rows, `jobs_${from}_${to}.csv`));
}
async function jobSheet(R, id, setCsv) {
  const [j, cm] = await Promise.all([GET('/jobs/' + id), GET('/comms' + qs({ job_id: id })).catch(() => ({ items: [] }))]);
  const k = j.costing || {}, costs = can('see_costs'), loc = j.location || {};
  const addr = [loc.address, loc.city, loc.state, loc.zip].filter(Boolean).join(', ');
  const hrsBy = {}; for (const t of j.time || []) { const h = t.clock_out ? (new Date(t.clock_out) - new Date(t.clock_in)) / 36e5 : 0; hrsBy[t.user_name || '—'] = (hrsBy[t.user_name || '—'] || 0) + Math.max(0, h); }
  const sec = (h, body) => `<div class="js-sec"><h3>${h}</h3>${body}</div>`;
  const list = (rows, cols, empty) => rows.length ? `<table class="js-t"><thead><tr>${cols.map(c => `<th class="${c.num ? 'num' : ''}">${c.label}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${cols.map(c => `<td class="${c.num ? 'num' : ''}">${c.html ? c.html(r) : esc(String(c.get(r) ?? ''))}</td>`).join('')}</tr>`).join('')}</tbody></table>` : `<p class="muted small">${empty}</p>`;
  R.innerHTML = `<div class="row no-print" style="margin-bottom:10px;gap:8px"><button class="btn" onclick="history.back()">‹ Back to the list</button><a class="btn" href="#/jobs/${j.id}">Open job</a><button class="btn primary" onclick="print()">Print / save as PDF</button></div>
    <div class="card js-sheet">
      <div class="row spread" style="align-items:flex-start"><div><div class="small muted">${esc(S.settings.company_name || '')} · Job report · ${fmtDate(todayStr())}</div><h2 style="margin:4px 0">${esc(j.number)} · ${esc(j.title || '')}</h2>
        <div>${pill(j.status)} ${billingPill(j.billing_type)} · ${esc(label(j.job_type))}${j.is_project ? ' · project' : ''}</div></div>
        <div class="kpis-mini">${[['Hours', num(k.hours, 1)], ['Contract', k.contract_amount ? money0(k.contract_amount) : '—'], ['Invoiced', money0(k.revenue)], ['Collected', money0(k.collected)], ...(costs ? [['Cost', money0(k.total_cost)], ['Profit', `${money0(k.profit)}${k.margin_pct != null ? ` (${pct(k.margin_pct)})` : ''}`]] : [])].map(([l, v]) => `<div><span class="small muted">${l}</span><b>${v}</b></div>`).join('')}</div></div>
      ${j.status === 'on_hold' ? `<div class="alert" style="margin-top:10px"><b>On hold${j.hold_at ? ` since ${fmtDate(j.hold_at.slice(0, 10))}` : ''}:</b> ${esc(j.hold_reason || '')} · follow up ${fmtDate(j.hold_follow_up)}${j.hold_assignee_name ? ` (${esc(j.hold_assignee_name)})` : ''}</div>` : ''}
      ${j.status === 'cancelled' ? `<div class="alert" style="margin-top:10px"><b>Cancelled:</b> ${esc(j.cancel_reason || '')}</div>` : ''}
      <div class="js-grid">
        ${sec('Customer & site', `<dl class="kv"><dt>Customer</dt><dd>${esc(j.customer_name)}${j.customer_phone ? ` · ${esc(j.customer_phone)}` : ''}</dd><dt>Address</dt><dd>${esc(addr || '—')}</dd>${j.po_number ? `<dt>PO #</dt><dd>${esc(j.po_number)}</dd>` : ''}<dt>Techs</dt><dd>${esc(j.tech_names || 'Unassigned')}</dd></dl>`)}
        ${sec('Dates', `<dl class="kv"><dt>Created</dt><dd>${fmtDate(String(j.created_at).slice(0, 10))}</dd><dt>Scheduled</dt><dd>${j.scheduled_start ? fmtDT(j.scheduled_start) : 'Not scheduled'}</dd><dt>Completed</dt><dd>${j.completed_at ? fmtDate(String(j.completed_at).slice(0, 10)) : '—'}</dd>${j.signoff_name ? `<dt>Signed off</dt><dd>${esc(j.signoff_name)}${j.signoff_at ? `, ${fmtDate(j.signoff_at.slice(0, 10))}` : ''}</dd>` : ''}</dl>`)}
      </div>
      ${j.description ? sec('Scope', `<div style="white-space:pre-wrap">${esc(j.description)}</div>`) : ''}
      ${j.completion_notes ? sec('Completion notes', `<div style="white-space:pre-wrap">${esc(j.completion_notes)}</div>`) : ''}
      ${sec(`Visits (${(j.appointments || []).length})`, list(j.appointments || [], [{ label: 'When', get: a => `${fmtDT(a.start)} – ${fmtTime(a.end)}` }, { label: 'Techs', get: a => a.tech_names || '' }, { label: 'Status', html: a => pill(a.status) }], 'No visits'))}
      ${sec(`Hours (${num(k.hours, 1)})`, list(Object.entries(hrsBy), [{ label: 'Who', get: r => r[0] }, { label: 'Hours', num: 1, get: r => num(r[1], 1) }], 'No time logged'))}
      ${sec(`Materials (${(j.materials || []).length})`, list(j.materials || [], [{ label: 'Item', get: m => m.description || m.name || '' }, { label: 'Qty', num: 1, get: m => num(m.qty, 2) }, { label: 'Price', num: 1, get: m => money(m.unit_price) }, ...(costs ? [{ label: 'Cost', num: 1, get: m => money(m.unit_cost) }] : [])], 'No materials'))}
      ${(j.permits || []).length ? sec('Permits', list(j.permits, [{ label: 'Permit', get: p => p.permit_number || p.type || '' }, { label: 'Jurisdiction', get: p => p.jurisdiction || '' }, { label: 'Status', html: p => pill(p.status) }], '')) : ''}
      ${(j.estimates || []).length || (j.invoices || []).length ? sec('Estimates & invoices', list([...(j.estimates || []).map(e => ({ k: e.change_order ? 'Change order' : 'Estimate', ...e })), ...(j.invoices || []).map(i => ({ k: 'Invoice', ...i }))],
        [{ label: '', get: x => x.k }, { label: '#', get: x => x.number }, { label: 'Status', html: x => pill(x.status) }, { label: 'Total', num: 1, get: x => money(x.total) }, { label: 'Balance', num: 1, get: x => x.k === 'Invoice' ? money(x.balance) : '' }], '')) : ''}
      ${sec(`Emails & calls (${cm.items.length})`, list(cm.items.slice(0, 25), [{ label: 'When', get: x => fmtDT(x.at) }, { label: '', get: x => x.type === 'email' ? 'Email sent' : `${(COMM_KIND[x.kind] || x.kind).replace(/^\S+\s/, '')} ${x.direction === 'in' ? 'in' : 'out'}` },
        { label: 'Detail', get: x => x.type === 'email' ? `${x.subject} → ${x.to}` : [x.contact, x.outcome, x.body].filter(Boolean).join(' · ') }], 'None logged'))}
      ${sec(`Notes (${(j.notes || []).length})`, list((j.notes || []).slice(0, 30), [{ label: 'When', get: n => fmtDT(n.created_at) }, { label: 'Who', get: n => n.user_name || '' }, { label: 'Note', html: n => `<span style="white-space:pre-wrap">${esc(n.body)}</span>` }], 'No notes'))}
      <p class="small muted">${(j.attachments || []).length} photo(s)/file(s) and ${(j.forms || []).filter(x => x.completed_at).length}/${(j.forms || []).length} checklist(s) on the job.</p>
    </div>`;
  setCsv(null);
}

// ---- 🎤 speak the scope: the browser's speech-to-text fills an editable transcript; Claude turns it into lines from
//      the price book; the person ticks which lines to add. Nothing is saved until they press Save on the estimate.
function voiceScope({ doc, form, opt, draw, techMode }) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const m = modal(`<h2>🎤 Speak the scope</h2>
    <p class="small muted">Say what the customer wants, like you'd tell the office: <i>"Add two 20 amp GFCI outlets in the garage on a new circuit, swap the panel cover, and put four 6 inch LED cans in the kitchen."</i> You can fix the words before Claude builds it.</p>
    ${SR ? '<div class="row" style="gap:10px;align-items:center"><button type="button" class="btn go" id="vmic">🎤 Start talking</button><span class="small muted" id="vstate">Microphone off</span></div>'
      : '<div class="alert info">This browser can\'t listen here (Firefox, or the page isn\'t on https). Tap the 🎤 on your phone\'s keyboard to dictate into the box, or type.</div>'}
    <textarea id="vtext" rows="7" style="width:100%;margin-top:8px" placeholder="What you say appears here. You can type or fix it too."></textarea>
    <div class="small muted" id="vint" style="min-height:1.2em"></div>
    <div id="vout"></div>
    <div class="actions"><button type="button" class="btn" data-x>Close</button><button type="button" class="btn primary" id="vgo">Build the estimate with Claude</button></div>`, { wide: true });
  const ta = $('#vtext', m.el), state = $('#vstate', m.el), interim = $('#vint', m.el);
  let rec = null, on = false;
  const stop = () => { on = false; if (rec) try { rec.stop(); } catch { /* already stopped */ } if ($('#vmic', m.el)) { $('#vmic', m.el).textContent = '🎤 Start talking'; $('#vmic', m.el).className = 'btn go'; } if (state) state.textContent = 'Microphone off'; interim.textContent = ''; };
  if (SR) $('#vmic', m.el).onclick = () => {
    if (on) return stop();
    rec = new SR(); rec.lang = 'en-US'; rec.continuous = true; rec.interimResults = true;
    rec.onresult = e => { let tmp = ''; for (let i = e.resultIndex; i < e.results.length; i++) { const t = e.results[i][0].transcript; if (e.results[i].isFinal) ta.value = (ta.value ? ta.value.replace(/\s*$/, ' ') : '') + t.trim(); else tmp += t; } interim.textContent = tmp; };
    rec.onerror = e => { state.textContent = e.error === 'not-allowed' ? 'Microphone blocked — allow it in the browser, or type' : `Stopped (${e.error})`; on = false; };
    rec.onend = () => { if (on) { try { rec.start(); } catch { stop(); } } };   // phones stop after a pause: keep listening until they tap Stop
    try { rec.start(); on = true; $('#vmic', m.el).textContent = '⏹ Stop'; $('#vmic', m.el).className = 'btn stop'; state.textContent = 'Listening… talk normally'; } catch (e) { state.textContent = e.message; }
  };
  const close = m.close; m.close = () => { stop(); close(); };
  $('[data-x]', m.el).onclick = () => m.close();
  $('#vgo', m.el).onclick = async () => {
    stop();
    const scope = ta.value.trim(); if (scope.length < 10) return toast('Say or type a bit more about the work', true);
    const out = $('#vout', m.el), go = $('#vgo', m.el);
    go.disabled = true; out.innerHTML = '<p class="muted">Claude is building the estimate from your price book… (usually 15–40 seconds)</p>';
    let r;
    try { r = await POST('/estimates/voice-draft', { scope, customer_id: form.customer_id && form.customer_id.value || doc.customer_id || null, job_id: doc.job_id || null, existing: doc.items.map(i => i.description).filter(Boolean) }); }
    catch (e) { go.disabled = false; out.innerHTML = `<p class="bad">${esc(e.message)}</p>`; return; }
    go.disabled = false; go.textContent = 'Build it again';
    const custom = r.lines.filter(l => !l.from_book).length;
    out.innerHTML = `<div class="card" style="margin-top:10px"><h3 style="margin-top:0">${esc(r.title || 'Estimate')}</h3><p class="small">${esc(r.summary || '')}</p>
      <table class="items"><thead><tr><th></th><th>Line</th><th class="num">Qty</th><th class="num">Price</th><th class="num">Total</th></tr></thead><tbody>
      ${r.lines.map((l, i) => `<tr><td><input type="checkbox" data-vl="${i}" checked style="width:auto"></td><td>${esc(l.description)} ${l.from_book ? '<span class="pill">price book</span>' : '<span class="pill warn" title="Not in the price book: Claude suggested this price">priced by Claude — check</span>'}<div class="small muted">${esc(l.why || '')}</div></td>
        <td class="num">${num(l.qty)}</td><td class="num">${money(l.unit_price)}</td><td class="num">${money(l.qty * l.unit_price)}</td></tr>`).join('') || '<tr><td colspan="5" class="empty">No lines — add more detail and build it again</td></tr>'}</tbody></table>
      ${custom && techMode && S.settings.tech_custom_lines === 'block' ? '<p class="small warn">Custom lines aren\'t allowed for field estimates here — untick them, or the office has to add them.</p>' : ''}
      ${r.assumptions.length ? `<h4>Assumptions</h4><ul class="small">${r.assumptions.map(a => `<li>${esc(a)}</li>`).join('')}</ul>` : ''}
      ${r.questions.length ? `<h4>Check with the customer</h4><ul class="small">${r.questions.map(a => `<li>${esc(a)}</li>`).join('')}</ul>` : ''}
      <label class="check"><input type="checkbox" id="vnotes" ${r.assumptions.length ? '' : 'disabled'}> Put the assumptions in "Notes to customer"</label>
      <div class="row" style="margin-top:8px"><button type="button" class="btn primary" id="vadd">Add the ticked lines to the estimate</button></div></div>`;
    $('#vadd', m.el).onclick = () => {
      const pick = $$('[data-vl]', m.el).filter(c => c.checked).map(c => r.lines[+c.dataset.vl]);
      if (!pick.length) return toast('Tick at least one line', true);
      for (const l of pick) doc.items.push({ pricebook_id: l.pricebook_id, description: l.description, qty: l.qty, unit_price: l.unit_price, unit_cost: l.unit_cost ?? 0, taxable: l.taxable ?? 1, cost_code_id: l.cost_code_id || null, opt: opt() });
      if (form.title && !form.title.value.trim() && r.title) form.title.value = r.title;
      if ($('#vnotes', m.el).checked && form.notes) form.notes.value = [form.notes.value.trim(), r.assumptions.map(a => `• ${a}`).join('\n')].filter(Boolean).join('\n\n');
      draw(); m.close();
      toast(`${pick.length} line(s) added — check them, then Save`);
    };
  };
}

// after a hold change: say whether the calendar invite went
function inviteToast(r, fallback) {
  const i = r && r.invite;
  if (!i) return toast(fallback);
  if (i.status === 'sent') return toast(`${fallback} · calendar invite emailed to ${i.name || i.to}`);
  toast(`${fallback}, but the calendar invite was NOT emailed: ${i.error || i.status}. The follow-up is still on the schedule.`, true);
}
// on hold: a reason and a follow-up date are required; resolves to the fields to send, or null if cancelled
function holdPrompt(j) {
  return new Promise(resolve => {
    const d = new Date(); d.setDate(d.getDate() + 7);
    let done = false;
    const m = formModal({ title: `Put ${j.number || 'this job'} on hold`, okLabel: 'Put on hold',
      fields: [{ name: 'hold_reason', label: 'Why is it on hold?', type: 'textarea', full: true, required: true, placeholder: 'e.g. Waiting on the customer to approve the change order; Utility has to set the meter; Material on back order until the 20th' },
        { name: 'hold_follow_up', label: 'Follow up on', type: 'date', required: true, default: localDate(d) },
        { name: 'hold_assignee', label: 'Follow-up task for', type: 'select', blank: false, options: followUpPeople(), default: Number(S.settings.hold_followup_assignee) || S.user.id },
        { name: 'hold_invite', label: 'Email them a calendar invite', type: 'checkbox', default: 1 }],
      extra: '<p class="small muted">The follow-up goes on the schedule as a task in that person\'s row (Week view) and on the Dashboard, and is noted on the job.</p>',
      submit: async v => {
        if (!v.hold_reason || v.hold_reason.trim().length < 3) throw new Error('Give a reason for putting the job on hold');
        if (!v.hold_follow_up) throw new Error('Pick a follow-up date');
        if (v.hold_follow_up < todayStr()) throw new Error('The follow-up date is in the past');
        done = true; resolve({ hold_reason: v.hold_reason.trim(), hold_follow_up: v.hold_follow_up, hold_assignee: Number(v.hold_assignee) || null, hold_invite: !!v.hold_invite });
      } });
    const close = m.close; m.close = () => { close(); if (!done) resolve(null); };
    $('[data-x]', m.el).onclick = () => m.close();
    new MutationObserver((_, o) => { if (!m.el.isConnected) { o.disconnect(); if (!done) resolve(null); } }).observe(document.body, { childList: true });
  });
}
// who can be given a follow-up task: active office people first, then everyone else
const followUpPeople = () => [...(S.users || [])].filter(u => u.active).sort((a, b) => (a.role === 'tech') - (b.role === 'tech') || a.name.localeCompare(b.name))
  .map(u => [u.id, `${u.name}${u.role === 'tech' ? ' (tech)' : ''}`]);
function holdBanner(j) {
  const late = j.hold_follow_up && j.hold_follow_up < todayStr();
  return `<div class="alert ${late ? '' : 'info'} holdbar" style="margin-bottom:14px"><div><b>On hold${j.hold_at ? ` since ${fmtDate(j.hold_at.slice(0, 10))}` : ''}${j.hold_by_name ? ` (${esc(j.hold_by_name)})` : ''}:</b> ${esc(j.hold_reason || 'no reason recorded')}
    <div>Follow up: ${j.hold_follow_up ? `<b>${fmtDate(j.hold_follow_up)}</b>${late ? ' <span class="pill bad">overdue</span>' : ''}` : '<span class="pill warn">no date set</span>'}${j.hold_assignee_name ? ` · task for <b>${esc(j.hold_assignee_name)}</b>` : ''}</div></div>
    ${isOffice() ? `<div class="row" style="gap:6px;flex-wrap:wrap"><button class="btn sm" id="holdedit">${j.hold_follow_up ? 'Change follow-up' : 'Set follow-up'}</button>${j.hold_follow_up ? '<button class="btn sm" id="holdics">Add to my calendar</button>' : ''}</div>` : ''}</div>`;
}
function wireHoldBanner(j) {
  if ($('#holdedit')) $('#holdedit').onclick = () => formModal({ title: `On hold: ${j.number}`, okLabel: 'Save',
    values: { hold_reason: j.hold_reason || '', hold_follow_up: j.hold_follow_up || '', hold_assignee: j.hold_assignee || Number(S.settings.hold_followup_assignee) || S.user.id, hold_invite: 1 },
    fields: [{ name: 'hold_reason', label: 'Why is it on hold?', type: 'textarea', full: true, required: true }, { name: 'hold_follow_up', label: 'Follow up on', type: 'date', required: true },
      { name: 'hold_assignee', label: 'Follow-up task for', type: 'select', blank: false, options: followUpPeople() },
      { name: 'hold_invite', label: 'Email them an updated calendar invite', type: 'checkbox' }],
    submit: async v => { await PUT('/jobs/' + j.id, { hold_reason: v.hold_reason, hold_follow_up: v.hold_follow_up, hold_assignee: Number(v.hold_assignee) || null, hold_invite: !!v.hold_invite }).then(r => inviteToast(r, 'Saved')); route(); } });
  if ($('#holdics')) $('#holdics').onclick = async () => {
    const res = await fetch(`/api/jobs/${j.id}/hold.ics`, { headers: { Authorization: 'Bearer ' + S.token } });
    if (!res.ok) return toast('Could not make the calendar file', true);
    const a = document.createElement('a'); a.href = URL.createObjectURL(await res.blob()); a.download = `follow-up-${j.number}.ics`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  };
}
function cancelJobModal(j) {
  formModal({
    title: `Cancel ${j.number}`, okLabel: 'Cancel job',
    extra: '<p class="small muted">The job is kept for your records. Upcoming visits come off the board, and open estimates, pick lists and draft purchase orders are cancelled. Invoices, and orders already sent to a vendor, are left for you to handle.</p>',
    fields: [{ name: 'reason', label: 'Reason', full: true, required: true, placeholder: 'e.g. Customer went with another contractor' }],
    submit: async d => {
      const r = await POST(`/jobs/${j.id}/cancel`, d);
      toast('Job cancelled');
      if (r.warnings.length) alert('Still to do:\n\n• ' + r.warnings.join('\n• '));
      route();
    },
  });
}
async function viewJob(id) {
  const j = await GET('/jobs/' + id);
  const { params } = hashParams();
  const tab = params.get('tab') || 'overview';
  const loc = j.location || {};
  const addr = [loc.address, loc.city, loc.state, loc.zip].filter(Boolean).join(', ');
  const c = j.costing;
  const formsDone = j.forms.filter(f => f.completed_at).length;
  const tabs = [['overview', 'Overview'], ['forms', `Checklists (${formsDone}/${j.forms.length})`], ['photos', `Photos & files (${j.attachments.length})`], ['time', `Time (${j.time.length})`],
    ['materials', `Materials (${j.materials.length})`], ['equipment', `Equipment (${j.equipment.length})`], ['permits', `Permits (${j.permits.length})`], ['comms', isOffice() ? 'Emails & calls' : 'Calls']];
  if (j.is_project) tabs.splice(1, 0, ['project', 'Project']);
  if (isOffice()) tabs.push(['budget', 'Cost codes & budget'], ['purchasing', `Purchasing (${(j.purchase_orders || []).length + j.pick_lists.length})`], ['billing', 'Billing'], ...(can('see_costs') ? [['costs', 'Other costs'], ['costing', 'Job costing']] : []));
  else tabs.push(['purchasing', `Pick lists (${j.pick_lists.length})`]);
  const statusOpts = isOffice() ? JOB_STATUSES : ['dispatched', 'in_progress', 'on_hold', 'completed'];
  $('#view').innerHTML = setTop(`${esc(j.number)} · ${esc(j.title)}`,
    `<select id="status" style="width:auto">${(statusOpts.includes(j.status) ? statusOpts : [j.status, ...statusOpts]).map(s => `<option value="${s}" ${s === j.status ? 'selected' : ''}>${label(s)}</option>`).join('')}</select>
     ${!['completed', 'invoiced', 'cancelled'].includes(j.status) ? '<button class="btn go" id="completejob">✓ Complete job</button>' : ''}
     ${!isOffice() && can('field_estimates') && !['invoiced', 'cancelled'].includes(j.status) ? `<a class="btn" href="#/estimates/new?job_id=${j.id}">${j.billing_type === 'fixed' && j.contract_amount ? '+ Change order' : '+ Estimate'}</a>` : ''}
     ${isOffice() && j.status === 'cancelled' ? '<button class="btn" id="reopenjob">Reopen job</button>' : ''}
     ${isAdmin() ? '<button class="btn" id="renum" title="Change the job number">Job #</button>' : ''}
     ${isOffice() && j.status !== 'cancelled' ? `<button class="btn" id="edit">Edit</button><a class="btn" href="#/estimates/new?job_id=${j.id}&customer_id=${j.customer_id}">${j.billing_type === 'fixed' && j.contract_amount ? '+ Change order' : '+ Estimate'}</a><button class="btn primary" id="invoice">Bill job</button>` : ''}
     ${isOffice() && !['cancelled', 'invoiced'].includes(j.status) ? '<button class="btn danger" id="canceljob">Cancel job</button>' : ''}
     ${isAdmin() ? `<button class="btn danger" id="deljob" ${j.delete_blockers.length ? `title="Can't delete: has ${esc(j.delete_blockers.join(', '))}"` : ''}>Delete</button>` : ''}
     ${!isOffice() && j.status !== 'cancelled' ? '<button class="btn go" id="clockhere">Clock in here</button>' : ''}`,
    `${pill(j.status)} ${j.priority !== 'normal' ? pill(j.priority) : ''} ${billingPill(j.billing_type)} · ${esc(label(j.job_type))} · ${isOffice() ? `<a href="#/customers/${j.customer_id}">${esc(j.customer_name)}</a>` : esc(j.customer_name)}`) + `
    ${j.status === 'on_hold' ? holdBanner(j) : ''}
    ${j.status === 'cancelled' ? `<div class="alert" style="margin-bottom:14px"><b>Cancelled${j.cancelled_at ? ` ${fmtDate(j.cancelled_at.slice(0, 10))}` : ''}.</b> ${esc(j.cancel_reason || '')}</div>` : ''}
    <div class="tabs">${tabs.map(([k, l]) => `<button class="${k === tab ? 'on' : ''}" data-tab="${k}">${l}</button>`).join('')}</div><div id="tab"></div>`;
  $$('[data-tab]').forEach(b => b.onclick = () => go(`#/jobs/${j.id}?tab=${b.dataset.tab}`));
  pipelinePath('job', j.id);
  if ($('#canceljob')) $('#canceljob').onclick = () => cancelJobModal(j);
  wireHoldBanner(j);
  if ($('#renum')) $('#renum').onclick = () => formModal({
    title: `Change job number — ${j.number}`, okLabel: 'Change number', values: { number: j.number },
    fields: [{ name: 'number', label: 'New job number', required: true, full: true }],
    extra: `<p class="small muted" style="margin-top:8px">Everything on the job stays attached (visits, time, invoices, estimates, costs); only the number shown changes, and a note records the old one. To match the A4Y Time Clock, set <b>Time clock job #</b> on the job instead (Edit). New jobs count on from the highest number in the style set under Settings → Job numbers.</p>`,
    submit: async v => { const r = await PUT(`/jobs/${j.id}/number`, { number: v.number }); toast(`Job is now ${r.number}${r.next_new_job ? ` · next new job will be ${r.next_new_job}` : ''}`); route(); },
  });
  if ($('#reopenjob')) $('#reopenjob').onclick = async () => { await act(() => POST(`/jobs/${j.id}/reopen`), 'Job reopened. Schedule a new visit when ready.'); route(); };
  if ($('#deljob')) $('#deljob').onclick = async () => {
    if (j.delete_blockers.length) return toast(`Can't delete ${j.number}: it has ${j.delete_blockers.join(', ')}. Cancel it instead, so the history is kept.`, true);
    if (!confirm(`Permanently delete ${j.number}? Its visits, notes, checklists and photos are erased. This can't be undone.\n\nIf the work just isn't happening, use Cancel job instead.`)) return;
    await act(() => DEL('/jobs/' + j.id), 'Job deleted'); go('#/jobs');
  };
  if ($('#completejob')) $('#completejob').onclick = () => completeJobModal(j);
  $$('[data-present]').forEach(b => b.onclick = async () => { const r = await act(() => POST(`/estimates/${b.dataset.present}/present`)); window.open(r.url, '_blank', 'noopener'); route(); });
  $('#status').onchange = async e => {
    if (e.target.value === 'completed' && j.status !== 'completed') { e.target.value = j.status; return completeJobModal(j); }
    if (e.target.value === 'cancelled' && j.status !== 'cancelled') { e.target.value = j.status; return cancelJobModal(j); }
    if (j.status === 'cancelled') { e.target.value = j.status; return toast('Use Reopen job first', true); }
    const body = { status: e.target.value };
    if (body.status === 'on_hold' && j.status !== 'on_hold') { const h = await holdPrompt(j); if (!h) { e.target.value = j.status; return; } Object.assign(body, h); }
    if (body.status === 'completed' && !isOffice()) { const n = prompt('Completion notes (what was done, anything the office should know):', j.completion_notes || ''); if (n === null) { e.target.value = j.status; return; } body.completion_notes = n; }
    const r = await act(() => PUT('/jobs/' + j.id, body)); if (r) inviteToast(r, 'Status updated'); route();
  };
  if (isOffice()) {
    if ($('#edit')) $('#edit').onclick = () => jobForm(j);
    if ($('#invoice')) $('#invoice').onclick = () => go(`#/jobs/${j.id}?tab=billing`);
  } else if ($('#clockhere')) $('#clockhere').onclick = async () => {
    if (j.is_project) { const m = modal('<h2>Clock in</h2><div id="ckm"></div><div class="actions"><button type="button" class="btn" data-x>Close</button></div>', { wide: true }); $('[data-x]', m.el).onclick = m.close; return clockCard($('#ckm', m.el), { jobId: j.id }); }
    const loc = await getLoc(); await act(() => POST('/time/clock-in', { job_id: j.id, kind: 'job', ...loc }), 'Clocked in on ' + j.number); route();
  };

  const T = $('#tab');
  if (tab === 'comms') return commCard(T, { job_id: j.id }, { phone: j.customer_phone, contact: j.customer_name });
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
      ${!isOffice() ? (j.billing_type === 'fixed' ? '<div class="alert info">💲 <b>Quoted-price job.</b> Extra work outside the quote needs a signed change order. Call the office before doing it.</div>'
        : '<div class="alert info">⏱ <b>Time &amp; material job.</b> Every hour and part is billed to the customer. Log all your time and materials accurately.</div>') : ''}
      ${!isOffice() && (j.present || []).length ? `<div class="card" style="margin:10px 0;padding:12px"><h3>Present to customer</h3>${j.present.map(e => `<div class="row spread" style="padding:6px 0">
          <span><b>${esc(e.change_order ? 'Change order' : 'Estimate')} ${esc(e.number)}</b> ${esc(e.title || '')}<br><span class="muted small">${e.options ? `${e.options} options · ${money(e.price_min)}–${money(e.price_max)}` : money(e.price_max)} · ${esc(label(e.status))}</span></span>
          <span class="row"><a class="btn sm" href="#/estimates/${e.id}">Open</a><button class="btn primary" data-present="${e.id}" ${e.review_status === 'pending' ? 'disabled title="Waiting for office review"' : ''}>Show customer</button></span></div>`).join('')}
        <p class="small muted">Opens the customer page. They pick an option and sign on your screen.${j.present.some(e => e.status === 'draft') ? ' Drafts must be sent by the office before the customer can approve.' : ''}</p></div>` : ''}
      <div id="appts"></div>
      <h2>Scope</h2><div style="white-space:pre-wrap">${esc(j.description || '—')}</div>
      ${j.completion_notes ? `<h2>Completion notes</h2><div style="white-space:pre-wrap">${esc(j.completion_notes)}</div>` : ''}
      ${j.signoff_name ? `<h2>Customer sign-off</h2><div>✍ Accepted by <b>${esc(j.signoff_name)}</b> · ${fmtDT(j.signoff_at)}</div><div id="sigimg"></div>` : ''}
      ${j.completion_blockers.length && !['completed', 'invoiced', 'cancelled'].includes(j.status) ? `<div class="alert">Before completing: finish ${j.completion_blockers.map(esc).join(', ')} on the <a href="#/jobs/${j.id}?tab=forms">Checklists</a> tab.</div>` : ''}
    </div><div class="card"><h2>Notes & activity</h2>
      <form id="note" class="row"><input name="body" class="grow" placeholder="Add a note (visible to the team)"><button class="btn primary">Add</button></form>
      <div style="margin-top:10px">${j.notes.map(n => `<div style="padding:8px 0;border-bottom:1px solid var(--border)"><div class="small muted">${esc(n.user_name || '')} · ${fmtDT(n.created_at)}</div><div style="white-space:pre-wrap">${esc(n.body)}</div></div>`).join('') || '<div class="empty">No notes yet</div>'}</div>
    </div></div>`;
    jobAppointmentsCard(j);
    const sig = j.attachments.find(a => a.kind === 'signature');
    if (sig && $('#sigimg')) authImg(sig.id).then(u => { $('#sigimg').innerHTML = `<img src="${u}" alt="Customer signature" style="max-width:320px;background:#fff;border-radius:8px;margin-top:6px">`; });
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
  if (tab === 'project') await projectTab(j, T);
  if (tab === 'forms') fieldFormsTab(j, T);
  if (tab === 'photos') fieldPhotosTab(j, T);
  if (tab === 'equipment') fieldEquipmentTab(j, T);
  if (tab === 'budget') jobBudgetTab(j, T);
  if (tab === 'purchasing') jobPurchasingTab(j, T);
  if (tab === 'billing') jobBillingTab(j, T);
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
  return Promise.resolve().then(() => formModal({
    title: t.id ? 'Edit time entry' : 'Add time entry', values: t,
    fields: [
      { name: 'user_id', label: 'Employee', type: 'select', options: techOptions(), required: true },
      { name: 'job_id', label: 'Job (blank = no job)', type: 'job', full: true },
      { name: 'kind', label: 'Type', type: 'select', options: ['job', 'travel', 'shop', 'training', 'pto'], blank: false, default: 'job' },
      { name: 'cost_code_id', label: 'Cost code', type: 'select', options: ccOptions('labor') },
      { name: 'clock_in', label: 'Start', type: 'datetime', required: true }, { name: 'clock_out', label: 'End', type: 'datetime', required: !t.id },
      { name: 'notes', label: 'Notes', full: true },
      { name: 'billable', label: 'Billable (T&M jobs)', type: 'checkbox', default: 1 },
    ],
    extra: t.id ? '<div style="margin-top:12px"><button type="button" class="btn danger" id="deltime">Delete entry</button></div>' : '',
    submit: async d => { if (t.id) await PUT('/time/' + t.id, d); else await POST('/time', d); toast('Time saved'); route(); },
  })).then(m => { const b = $('#deltime', m.el); if (b) b.onclick = async () => { if (confirm('Delete this time entry?')) { await act(() => DEL('/time/' + t.id)); m.close(); route(); } }; });
}

async function materialForm(jobId) {
  await loadPricebook(true);
  const fields = [
    { name: 'pricebook_id', type: 'hidden' },
    { name: 'description', label: 'Material: search the price book, or type any item', full: true, required: true, placeholder: 'e.g. 12/2 MC, 4" square box, EMT 3/4' },
    { name: 'qty', label: 'Quantity', type: 'number', default: 1, required: true },
    { name: 'cost_code_id', label: 'Cost code (blank = item default)', type: 'select', options: ccOptions('material') },
    { name: 'source', label: 'Came from', type: 'select', options: [['stock', 'Truck / shop stock'], ['supply_house', 'Supply house (bought for job)'], ['customer', 'Customer supplied']], blank: false },
    { name: 'unit_cost', label: 'Unit cost (blank = price book)', type: 'number' },
    { name: 'unit_price', label: 'Unit sell price (custom items)', type: 'number' },
    { name: 'billable', label: 'Billable to customer', type: 'checkbox', default: 1 },
  ].filter(f => (isOffice() && can('see_costs')) || f.name !== 'unit_cost');
  const m = formModal({ title: 'Log material used', fields, submit: async d => {
    if (!d.pricebook_id) delete d.pricebook_id;
    await POST(`/jobs/${jobId}/materials`, d); toast('Material logged'); route();
  } });
  const form = $('form', m.el);
  const inp = form.elements.description, wrap = document.createElement('div');
  wrap.className = 'lk'; inp.replaceWith(wrap); wrap.append(inp);
  await pricebookSearch(inp, form.elements.pricebook_id, { onPick: p => { if (p && p.cost_code_id && !form.cost_code_id.value) form.cost_code_id.value = p.cost_code_id; } });
  inp.focus();
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
    { name: 'loc_address', label: 'Service address', type: 'address', full: true, fill: { city: 'loc_city', state: 'loc_state', zip: 'loc_zip', lat: 'loc_lat', lng: 'loc_lng', verified: 'loc_verified_at' } },
    { name: 'loc_city', label: 'City' }, { name: 'loc_state', label: 'State' }, { name: 'loc_zip', label: 'ZIP' },
    { name: 'loc_service_size', label: 'Service size (e.g. 200A 1PH)' },
    { name: 'loc_lat', type: 'hidden' }, { name: 'loc_lng', type: 'hidden' }, { name: 'loc_verified_at', type: 'hidden' },
  ];
  formModal({
    title: c.id ? 'Edit customer' : 'New customer', fields: [...fields, ...locFields], values: c, wide: true,
    submit: async d => {
      const body = Object.fromEntries(Object.entries(d).filter(([k]) => !k.startsWith('loc_')));
      if (c.id) { await PUT('/customers/' + c.id, body); toast('Saved'); route(); return; }
      body.location = { address: d.loc_address, city: d.loc_city, state: d.loc_state, zip: d.loc_zip, service_size: d.loc_service_size, lat: d.loc_lat, lng: d.loc_lng, verified_at: d.loc_verified_at };
      const r = await POST('/customers', body); toast('Customer added'); go('#/customers/' + r.id);
    },
  });
}
function locationForm(customerId, l = {}) {
  formModal({
    title: l.id ? 'Edit location' : 'Add service location', values: l,
    fields: [{ name: 'label', label: 'Label (e.g. Main house, Suite 4)' },
      { name: 'address', label: 'Address', type: 'address', required: true, full: true, fill: { city: 'city', state: 'state', zip: 'zip', lat: 'lat', lng: 'lng', verified: 'verified_at' } },
      { name: 'city', label: 'City' }, { name: 'state', label: 'State' }, { name: 'zip', label: 'ZIP' },
      { name: 'lat', type: 'hidden' }, { name: 'lng', type: 'hidden' }, { name: 'verified_at', type: 'hidden' },
      { name: 'service_size', label: 'Service size' }, { name: 'panel_info', label: 'Panel(s) — make/model/location', full: true }, { name: 'access_notes', label: 'Access notes (gate codes, pets, site contact)', type: 'textarea', full: true }],
    submit: async d => { if (l.id) await PUT('/locations/' + l.id, d); else await POST(`/customers/${customerId}/locations`, d); toast('Saved'); route(); },
  });
}
async function viewCustomers() {
  const { params } = hashParams();
  const q = params.get('q') || '', type = params.get('type') || '', letter = params.get('letter') || '';
  let sort = params.get('sort'); if (sort == null) { try { sort = localStorage.getItem('fo_cust_sort') || ''; } catch { sort = ''; } }
  const page = Math.max(Number(params.get('page')) || 1, 1), per = 100;
  const lead = params.get('lead_source') || '', cfrom = params.get('created_from') || '', cto = params.get('created_to') || '';
  const ls = listSort(params, '#/customers', { by: 'name', dir: 'asc' }, ['created', 'jobs']);
  const list = await GET('/customers' + qs({ q, type, letter, sort, lead_source: lead, created_from: cfrom, created_to: cto, order: ls.by, dir: ls.dir, limit: per, offset: (page - 1) * per }));
  const total = list.total ?? list.length, pages = Math.max(1, Math.ceil(total / per));
  const link = o => '#/customers' + qs({ q, type, letter, sort, lead_source: lead, created_from: cfrom, created_to: cto, order: params.get('order'), dir: params.get('dir'), ...o });
  $('#view').innerHTML = setTop('Customers', '<button class="btn primary" id="new">+ New customer</button>') + `<div class="card">
    <form id="srch" class="row"><input name="q" placeholder="Search name, company, phone, email or address" value="${esc(q)}" style="max-width:360px">
      <select name="type" style="width:auto"><option value="">All types</option><option ${type === 'residential' ? 'selected' : ''}>residential</option><option ${type === 'commercial' ? 'selected' : ''}>commercial</option></select>
      <select name="lead_source" style="width:auto" aria-label="Lead source"><option value="">Any lead source</option>${LEAD_SOURCES.map(s => `<option ${s === lead ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select>
      <label class="small muted">Added <input type="date" name="created_from" value="${esc(cfrom)}" style="width:auto"> to <input type="date" name="created_to" value="${esc(cto)}" style="width:auto"></label><button class="btn">Search</button>
      ${q || type || letter || lead || cfrom || cto ? `<a class="btn" href="#/customers">Clear</a>` : ''}<span class="grow"></span>
      <select id="csort" style="width:auto" title="How people are filed A to Z"><option value="">A–Z by last name</option><option value="first" ${sort === 'first' ? 'selected' : ''}>A–Z by first name</option></select></form>
    <div class="az">${['', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ', '#'].map(L => `<button type="button" data-letter="${L}" class="${L === letter ? 'on' : ''}">${L || 'All'}</button>`).join('')}</div>
    <p class="small muted" style="margin:0 0 8px">${total.toLocaleString()} customer${total === 1 ? '' : 's'}${total > per ? ` · showing ${((page - 1) * per + 1).toLocaleString()}–${Math.min(page * per, total).toLocaleString()}` : ''}</p>
    ${table([{ label: 'Name', sort: 'name', html: c => `<b>${esc(c.company || c.name)}</b>${c.company ? `<div class="muted small">${esc(c.name)}</div>` : ''}` }, { label: 'Type', html: c => pill(c.type) },
      { label: 'Phone', key: 'phone' }, { label: 'Email', key: 'email' }, { label: 'Address', key: 'primary_address' }, { label: 'Added', sort: 'created', get: c => fmtDate((c.created_at || '').slice(0, 10)) },
      { label: 'Jobs', num: 1, sort: 'jobs', key: 'job_count' }], list, { onClick: c => go('#/customers/' + c.id), empty: q || letter || lead || cfrom || cto ? 'No customers match' : 'No customers yet', sort: ls })}
    ${pages > 1 ? `<div class="row" style="margin-top:10px;justify-content:center">${page > 1 ? `<a class="btn" href="${link({ page: page - 1 })}">‹ Previous</a>` : ''}<span class="muted">Page ${page} of ${pages}</span>${page < pages ? `<a class="btn" href="${link({ page: page + 1 })}">Next ›</a>` : ''}</div>` : ''}</div>`;
  $('#new').onclick = () => customerForm();
  $$('[data-letter]').forEach(b => b.onclick = () => go('#/customers' + qs({ q, type, sort, letter: b.dataset.letter })));
  $('#csort').onchange = e => { try { localStorage.setItem('fo_cust_sort', e.target.value); } catch { /* private mode */ } go('#/customers' + qs({ q, type, letter, sort: e.target.value })); };
  $('#srch').onsubmit = e => { e.preventDefault(); const t = e.target; go('#/customers' + qs({ q: t.q.value.trim(), type: t.type.value, sort, lead_source: t.lead_source.value, created_from: t.created_from.value, created_to: t.created_to.value, order: params.get('order'), dir: params.get('dir') })); };
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
      ${customerEquipmentCard(c)}
      <div class="card"><h2>Estimates</h2>${table([{ label: '#', key: 'number' }, { label: 'Title', key: 'title' }, { label: 'Status', html: e => pill(e.status) }, { label: 'Total', num: 1, get: e => money(e.total) }], c.estimates, { onClick: e => go('#/estimates/' + e.id), empty: 'No estimates' })}</div>
      <div class="card"><h2>Invoices</h2>${table([{ label: '#', key: 'number' }, { label: 'Date', get: i => fmtDate(i.issue_date) }, { label: 'Status', html: i => pill(i.status) }, { label: 'Balance', num: 1, get: i => money(i.balance) }], c.invoices, { onClick: i => go('#/invoices/' + i.id), empty: 'No invoices' })}</div>
      <div class="full" id="comms"></div>
      ${c.agreements.length ? `<div class="card"><h2>Service agreements</h2>${table([{ label: 'Plan', key: 'name' }, { label: 'Price', get: a => `${money(a.price)} / ${a.billing_frequency}` }, { label: 'Next visit', get: a => fmtDate(a.next_visit) }, { label: 'Status', html: a => pill(a.status) }], c.agreements, { onClick: () => go('#/agreements') })}</div>` : ''}
    </div>`;
  $('#edit').onclick = () => customerForm(c);
  $('#addloc').onclick = () => locationForm(c.id);
  commCard($('#comms'), { customer_id: c.id }, { phone: c.phone, contact: c.company ? c.name : '', rollup: true });
  pipelinePath('lead', c.id);
}

// ============================================================ estimates & invoices (shared editor)
async function viewEstimates() {
  const { params } = hashParams(); const status = params.get('status') || '';
  if (!isOffice()) return viewEstimatesTech(status);
  const f = { q: params.get('q') || '', from: params.get('from') || '', to: params.get('to') || '' };
  const page = Math.max(Number(params.get('page')) || 1, 1), per = 100;
  const sort = listSort(params, '#/estimates', { by: 'created', dir: 'desc' }, ['created', 'total', 'margin', 'number']);
  const list = await GET('/estimates' + qs({ status, ...f, order: sort.by, dir: sort.dir, limit: per, offset: (page - 1) * per }));
  const total = list.total ?? list.length, keep = { status, order: params.get('order'), dir: params.get('dir') };
  const tabs = [['', 'All'], ['review', 'Needs review'], ['draft', 'Draft'], ['sent,viewed', 'Open'], ['sent', 'Sent'], ['viewed', 'Viewed'], ['approved', 'Approved'], ['declined', 'Declined'], ['cancelled', 'Cancelled']];
  $('#view').innerHTML = setTop('Estimates', '<a class="btn primary" href="#/estimates/new">+ New estimate</a>') + `<div class="card">
    <div class="tabs">${tabs.map(([v, l]) => `<button class="${v === status ? 'on' : ''}" data-s="${v}">${l}</button>`).join('')}</div>
    <form id="srch" class="filters"><input name="q" type="search" placeholder="Search estimate #, customer, title, job #" value="${esc(f.q)}">
      <label class="small muted">Created <input type="date" name="from" value="${esc(f.from)}"> to <input type="date" name="to" value="${esc(f.to)}"></label>
      <button class="btn">Filter</button>${f.q || f.from || f.to ? `<a class="btn" href="#/estimates${qs({ status })}">Clear</a>` : ''}</form>
    ${listCount(total, list.length, page, per, 'estimate')}
    ${table([{ label: '#', sort: 'number', key: 'number' }, { label: 'Customer', sort: 'customer', key: 'customer_name' }, { label: 'Title', sort: 'title', key: 'title' }, { label: 'Created', sort: 'created', get: e => fmtDate(e.created_at.slice(0, 10)) },
      { label: 'Status', sort: 'status', html: e => pill(e.status) }, { label: 'Margin', num: 1, sort: 'margin', get: e => pct(e.est_margin_pct) },
      { label: 'Total', num: 1, sort: 'total', html: e => e.options && e.options.length && e.status !== 'approved' ? `${money(e.price_min)}–${money(e.price_max)}<div class="small muted">${e.options.length} options</div>` : money(e.total) }], list,
    { onClick: e => go('#/estimates/' + e.id), empty: f.q || f.from || f.to ? 'No estimates match' : 'No estimates', sort,
      foot: list.sums && total ? ['', '', '', '', '', `${total > list.length ? 'All matches' : 'Total'}`, { v: money(list.sums.total), num: 1 }] : null })}
    ${listPager(total, page, per, n => '#/estimates' + qs({ ...f, ...keep, page: n }))}</div>`;
  $$('[data-s]').forEach(b => b.onclick = () => go('#/estimates' + qs({ ...f, ...keep, status: b.dataset.s })));
  $('#srch').onsubmit = e => { e.preventDefault(); listFilterGo(e.target, '#/estimates', keep); };
}
// a tech's own estimates (their list comes from the field-estimate routes)
async function viewEstimatesTech(status) {
  const list = await GET('/estimates' + qs({ status }));
  $('#view').innerHTML = setTop('My Estimates', '', 'Start a new estimate from one of your jobs.') + `<div class="card">
    ${table([{ label: '#', key: 'number' }, { label: 'Customer', key: 'customer_name' }, { label: 'Title', key: 'title' }, { label: 'Created', get: e => fmtDate(e.created_at.slice(0, 10)) },
      { label: 'Status', html: e => pill(e.status) }, { label: 'Total', num: 1, get: e => money(e.total) }], list, { onClick: e => go('#/estimates/' + e.id), empty: 'No estimates' })}</div>`;
}
async function viewInvoices() {
  const { params } = hashParams(); const status = params.get('status') ?? 'sent,partial';
  const f = { q: params.get('q') || '', from: params.get('from') || '', to: params.get('to') || '', overdue: params.get('overdue') || '' };
  const page = Math.max(Number(params.get('page')) || 1, 1), per = 100;
  const sort = listSort(params, '#/invoices', { by: 'issued', dir: 'desc' }, ['issued', 'due', 'total', 'balance', 'number']);
  const list = await GET('/invoices' + qs({ status: status === 'all' ? '' : status, ...f, order: sort.by, dir: sort.dir, limit: per, offset: (page - 1) * per }));
  const total = list.total ?? list.length, keep = { status, order: params.get('order'), dir: params.get('dir') };
  const tabs = [['sent,partial', 'Open'], ['draft', 'Draft'], ['paid', 'Paid'], ['void', 'Void'], ['all', 'All']];
  const t = todayStr(), filtered = f.q || f.from || f.to || f.overdue;
  $('#view').innerHTML = setTop('Invoices', '<a class="btn primary" href="#/invoices/new">+ New invoice</a>') + `<div class="card">
    <div class="tabs">${tabs.map(([v, l]) => `<button class="${v === status ? 'on' : ''}" data-s="${v}">${l}</button>`).join('')}</div>
    <form id="srch" class="filters"><input name="q" type="search" placeholder="Search invoice #, customer, job #" value="${esc(f.q)}">
      <label class="small muted">Issued <input type="date" name="from" value="${esc(f.from)}"> to <input type="date" name="to" value="${esc(f.to)}"></label>
      <label class="check"><input type="checkbox" name="overdue" ${f.overdue ? 'checked' : ''}> Overdue only</label>
      <button class="btn">Filter</button>${filtered ? `<a class="btn" href="#/invoices${qs({ status })}">Clear</a>` : ''}</form>
    ${listCount(total, list.length, page, per, 'invoice')}
    ${table([{ label: '#', sort: 'number', key: 'number' }, { label: 'Customer', sort: 'customer', key: 'customer_name' }, { label: 'Job', sort: 'job', key: 'job_number' }, { label: 'Issued', sort: 'issued', get: i => fmtDate(i.issue_date) },
      { label: 'Due', sort: 'due', html: i => `${fmtDate(i.due_date)}${['sent', 'partial'].includes(i.status) && i.due_date < t ? ' <span class="pill bad">Overdue</span>' : ''}` },
      { label: 'Status', sort: 'status', html: i => pill(i.status) }, { label: 'Total', num: 1, sort: 'total', get: i => money(i.total) }, { label: 'Balance', num: 1, sort: 'balance', get: i => money(i.balance) }], list,
    { onClick: i => go('#/invoices/' + i.id), empty: filtered ? 'No invoices match' : 'No invoices', sort,
      foot: list.sums && total ? ['', '', '', '', '', total > list.length ? 'All matches' : 'Total', { v: money(list.sums.total), num: 1 }, { v: money(list.sums.balance), num: 1 }] : null })}
    ${listPager(total, page, per, n => '#/invoices' + qs({ ...f, ...keep, page: n }))}</div>`;
  $$('[data-s]').forEach(b => b.onclick = () => go('#/invoices' + qs({ ...f, ...keep, status: b.dataset.s })));
  $('#srch').onsubmit = e => { e.preventDefault(); listFilterGo(e.target, '#/invoices', keep); };
  $('#srch [name=overdue]').onchange = () => listFilterGo($('#srch'), '#/invoices', keep);
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
  const pb = await loadPricebook(true);
  let doc;
  if (id === 'new') {
    doc = { items: [], customer_id: params.get('customer_id') || '', job_id: params.get('job_id') || null, discount: 0, tax_rate: null, status: 'draft' };
    if (doc.job_id) { const j = await GET('/jobs/' + doc.job_id); doc.customer_id = j.customer_id; doc.location_id = j.location_id; doc.title = j.title; }
  } else doc = await GET(`${base}/${id}`);
  const techMode = !isOffice();
  if (techMode && (!isEst || (id === 'new' && !doc.job_id))) throw new Error('Start an estimate from one of your jobs');
  const seeCosts = can('see_costs');
  const locked = isEst ? (['approved', 'cancelled'].includes(doc.status) || (techMode && ['declined', 'expired'].includes(doc.status))) : (doc.status === 'void' || (doc.payments || []).length > 0);
  const maxDisc = Number(S.settings.tech_max_discount_pct) || 0;
  const review = isEst && id !== 'new' ? { status: doc.review_status, reasons: doc.review_reasons ? (Array.isArray(doc.review_reasons) ? doc.review_reasons : JSON.parse(doc.review_reasons)) : [], note: doc.review_note } : { status: null, reasons: [] };
  const st = S.settings;
  if (doc.tax_rate == null) doc.tax_rate = Number(st.default_tax_rate) || 0;
  // good / better / best: doc.opts holds the options; each line's .opt is an option index, or null = in every option
  doc.opts = (doc.options || []).map(o => ({ name: o.name, description: o.description || '', recommended: !!o.recommended, _id: o.id }));
  for (const it of doc.items) { const k = doc.opts.findIndex(o => o._id === it.option_id); it.opt = k < 0 ? null : k; }
  let optTab = doc.opts.length ? (doc.opts.findIndex(o => o._id === doc.approved_option_id) >= 0 ? doc.opts.findIndex(o => o._id === doc.approved_option_id) : 0) : null;
  const optItems = k => doc.items.filter(it => it.opt == null || it.opt === k);

  const itemRow = (it, i) => `<tr data-i="${i}">
    <td class="desc-cell"><textarea class="desc" data-k="description" rows="1" placeholder="Type to search the price book, or write the line (Enter for a new line)" ${locked ? 'disabled' : ''}>${esc(it.description)}</textarea></td>
    <td><input class="n" type="number" step="any" data-k="qty" value="${esc(it.qty)}" ${locked ? 'disabled' : ''}></td>
    <td><input class="n" type="number" step="any" data-k="unit_price" value="${esc(it.unit_price)}" ${locked || (techMode && it.pricebook_id) ? 'disabled title="Price-book price"' : ''}></td>
    ${seeCosts ? `<td><input class="n" type="number" step="any" data-k="unit_cost" value="${esc(it.unit_cost ?? '')}" title="Your cost — never shown to the customer" ${locked || (techMode && it.pricebook_id) ? 'disabled' : ''}></td>` : ''}
    <td><select data-k="cost_code_id" style="width:110px" ${locked ? 'disabled' : ''}><option value="">—</option>${S.costCodes.map(c => `<option value="${c.id}" ${String(c.id) === String(it.cost_code_id) ? 'selected' : ''}>${esc(c.code)} ${esc(c.name)}</option>`).join('')}</select></td>
    <td style="text-align:center"><input type="checkbox" data-k="taxable" ${it.taxable ? 'checked' : ''} ${locked ? 'disabled' : ''} style="width:auto"></td>
    <td class="num" data-line>${money((+it.qty || 0) * (+it.unit_price || 0))}</td>
    <td>${locked ? '' : `<button class="btn sm danger" data-rm="${i}" type="button">✕</button>`}</td></tr>`;

  $('#view').innerHTML = setTop(id === 'new' ? `New ${kind}` : `${isEst ? (doc.change_order ? 'Change order' : 'Estimate') : 'Invoice'} ${esc(doc.number)}`,
    id === 'new' ? '' : techMode ? `${pill(doc.status)} ${review.status === 'pending' ? '<span class="pill warn">Office review</span>' : ''}${doc.job_id ? `<a class="btn" href="#/jobs/${doc.job_id}">Open job</a>` : ''}
      ${!['approved', 'cancelled'].includes(doc.status) ? `<button class="btn primary" id="present" ${review.status === 'pending' ? 'disabled title="Waiting for office review"' : ''}>Present to customer</button>` : ''}` : `${pill(doc.status)} ${review.status === 'pending' ? '<span class="pill warn">Needs review</span>' : ''}
      <a class="btn" target="_blank" href="${esc(doc.public_url)}" ${!isEst && doc.status === 'draft' ? 'title="Draft: only you can see this until it is sent"' : ''}>${!isEst && doc.status === 'draft' ? 'Preview (draft) ↗' : 'Customer view ↗'}</a>
      ${isEst ? `${['sent', 'viewed', 'draft'].includes(doc.status) ? '<button class="btn" id="mark-approved">Mark approved</button><button class="btn" id="mark-declined">Mark declined</button>' : ''}
        ${doc.status === 'approved' && !doc.job_id ? '<button class="btn" id="tojob">Convert to job</button>' : ''}${doc.job_id ? `<a class="btn" href="#/jobs/${doc.job_id}">Open job</a>` : ''}
        ${doc.status !== 'cancelled' ? '<button class="btn" id="toinv">Convert to invoice</button><button class="btn danger" id="cancelest">Cancel estimate</button>' : '<button class="btn" id="reopenest">Reopen as draft</button>'}`
    : `${doc.job_id ? `<a class="btn" href="#/jobs/${doc.job_id}">Open job</a>` : ''}${doc.status !== 'void' && doc.balance > 0 && doc.status !== 'draft' ? '<button class="btn" id="pay">Record payment</button>' : ''}`}
      ${!['void', 'cancelled'].includes(doc.status) ? `<button class="btn primary" id="send">Send to customer</button>` : ''}`) + `
    ${isEst && doc.status === 'cancelled' ? `<div class="alert" style="margin-bottom:14px"><b>Cancelled${doc.cancelled_at ? ` ${fmtDate(doc.cancelled_at.slice(0, 10))}` : ''}.</b> ${esc(doc.cancel_reason || '')} The customer link no longer accepts a signature.</div>` : ''}
    ${review.status === 'pending' ? `<div class="alert" style="margin-bottom:14px"><b>${techMode ? 'Waiting for office review.' : 'Built by a tech — needs your review.'}</b> ${review.reasons.map(esc).join(' · ')}${techMode ? '<br>The customer can look at it but can\'t sign until the office approves the pricing.' : ''}
      ${!techMode ? '<div class="row" style="margin-top:8px"><button type="button" class="btn go" id="rv-ok">Approve pricing</button><button type="button" class="btn" id="rv-back">Send back to tech…</button></div>' : ''}</div>` : ''}
    ${review.status === 'rejected' ? `<div class="alert" style="margin-bottom:14px"><b>Sent back by the office:</b> ${esc(review.note || '')}${techMode ? '<br>Make the change and save. It is checked again automatically.' : ''}</div>` : ''}
    ${techMode && !locked ? `<p class="small muted">Pick items from the price book (prices are fixed). ${S.settings.tech_custom_lines === 'block' ? 'Custom lines are turned off.' : S.settings.tech_custom_lines === 'review' ? 'Custom lines send the estimate to the office for review.' : ''} Discounts over ${maxDisc}% need office review.</p>` : ''}
    <form id="docform" class="stack">
    <div class="card"><div class="form-grid">
      ${fieldHtml({ name: 'customer_id', label: 'Customer', type: 'customer', required: true }, doc.customer_id)}
      ${isEst ? fieldHtml({ name: 'location_id', label: 'Service location', type: 'select', options: [] }) : fieldHtml({ name: 'job_id', label: 'Job', type: 'select', options: [] })}
      ${fieldHtml({ name: 'title', label: isEst ? 'Estimate title' : 'Title (optional)', full: true }, doc.title)}
      ${isEst ? fieldHtml({ name: 'valid_until', label: 'Valid until', type: 'date' }, doc.valid_until) : fieldHtml({ name: 'issue_date', label: 'Issue date', type: 'date' }, doc.issue_date || todayStr()) + fieldHtml({ name: 'due_date', label: 'Due date (blank = customer terms)', type: 'date' }, doc.due_date)}
    </div></div>
    <div class="card"><div class="row spread"><h2>Line items</h2>${locked ? `<span class="muted small">${isEst ? 'Approved estimates are locked — create a new estimate for change orders.' : 'Locked: invoice is void or has payments.'}</span>` : ''}</div>
      <datalist id="pblist">${pb.map(p => `<option value="${esc(p.name)}">${esc(p.code || '')} · ${money(p.unit_price)}</option>`).join('')}</datalist>
      ${isEst ? '<div id="optbar"></div>' : ''}
      <div class="table-wrap"><table class="items"><thead><tr><th>Description (type to search price book)</th><th>Qty</th><th>Price</th>${seeCosts ? '<th>Your cost</th>' : ''}<th>Cost code</th><th>Tax</th><th class="num">Amount</th><th></th></tr></thead><tbody id="items"></tbody></table></div>
      ${locked ? '' : '<div class="row" style="margin-top:8px"><button type="button" class="btn" id="addline">+ Line</button><button type="button" class="btn" id="addlabor">+ Labor hours</button>' + (isEst ? '<button type="button" class="btn primary" id="voicebtn" title="Say (or type) the scope; Claude builds the lines from the price book">🎤 Speak the scope</button>' : '') + '</div>'}
      <div class="row" style="align-items:flex-start;margin-top:14px">
        <div class="grow form-grid" style="max-width:520px">
          ${fieldHtml({ name: 'tax_rate', label: techMode ? 'Tax rate % (set by office)' : 'Tax rate %', type: 'number' }, doc.tax_rate)}${fieldHtml({ name: 'discount', label: techMode ? `Discount $ (up to ${maxDisc}% without review)` : 'Discount $', type: 'number' }, doc.discount)}
          ${fieldHtml({ name: 'notes', label: 'Notes to customer', type: 'textarea', full: true }, doc.notes)}
          ${fieldHtml({ name: 'terms', label: 'Terms', type: 'textarea', full: true }, doc.terms ?? (isEst ? st.estimate_terms : st.invoice_terms))}
        </div>
        <div class="totals" id="totals"></div>
      </div></div>
    <div class="row no-print">${isEst && doc.status === 'cancelled' ? '' : `<button class="btn primary">Save ${kind}</button>`}${id !== 'new' && (isEst ? doc.status !== 'approved' : doc.status === 'draft') ? `<button type="button" class="btn danger" id="del">Delete</button>` : ''}
      ${!isEst && id !== 'new' && !['void', 'paid'].includes(doc.status) ? '<button type="button" class="btn danger" id="void">Void invoice</button>' : ''}</div>
    </form>
    ${!isEst && id !== 'new' ? `<div class="card" style="margin-top:14px"><h2>Payments</h2>${table([{ label: 'Date', get: p => fmtDate(p.paid_at) }, { label: 'Method', get: p => label(p.method) }, { label: 'Reference', key: 'reference' }, { label: 'Amount', num: 1, get: p => money(p.amount) },
      ...(isAdmin() ? [{ label: '', html: p => `<button class="btn sm danger" data-delpay="${p.id}">✕</button>` }] : [])], doc.payments, { empty: 'No payments recorded' })}</div>` : ''}
    ${isEst && id !== 'new' && !doc.change_order ? `<div class="card no-print" style="margin-top:14px" id="estvisits"><div class="row spread"><h2>Site visits (${(doc.visits || []).length})</h2>${!techMode && can('jobs') && !['cancelled', 'declined', 'expired'].includes(doc.status) ? '<button type="button" class="btn sm primary" id="addestvisit">+ Schedule visit</button>' : ''}</div><p class="small muted">Walkthroughs to see the work and price it. They show on the schedule board marked EST.</p>${table([{ label: 'When', html: v => `<b>${fmtDT(v.start)}</b> – ${fmtTime(v.end)}` }, { label: 'Techs', get: v => v.tech_names || 'Unassigned' }, { label: 'Status', html: v => pill(v.status) }, { label: 'Notes', get: v => v.notes || '' }], doc.visits || [], { empty: 'No visit booked yet', onClick: !techMode && can('jobs') ? v => apptForm({ ...v, estimate_title: doc.title }) : null })}</div>` : ''}
    ${isEst && (doc.signature_name || doc.approved_option_id) ? `<div class="card" style="margin-top:14px"><h2>Customer approval</h2>${doc.approved_option_id ? `Chose <b>${esc((doc.options.find(o => o.id === doc.approved_option_id) || {}).name || '')}</b> — ${money(doc.total)}. ` : ''}${doc.signature_name ? `Signed by <b>${esc(doc.signature_name)}</b> on ${fmtDT(doc.approved_at)}` : ''}</div>` : ''}`;

  if (isEst && id !== 'new') pipelinePath('estimate', doc.id);
  if (isEst && id !== 'new' && isOffice()) { const box = document.createElement('div'); box.style.marginTop = '14px'; $('#view').appendChild(box); commCard(box, { estimate_id: doc.id }, { phone: (doc.customer || {}).phone, contact: (doc.customer || {}).name }); }
  const form = $('#docform');
  const tbody = $('#items');
  if ($('#addestvisit')) $('#addestvisit').onclick = () => apptForm({ estimate_id: doc.id, estimate_number: doc.number, customer_name: (doc.customer || {}).name, estimate_title: doc.title,
    start: dayISO(todayStr(), 9), end: dayISO(todayStr(), 10), tech_ids: [] });
  const draw = () => {
    const rows = doc.items.map((it, i) => ({ it, i })).filter(x => !doc.opts.length || x.it.opt === optTab);
    tbody.innerHTML = rows.map(x => itemRow(x.it, x.i)).join('') || `<tr><td colspan="8" class="empty">${doc.opts.length ? (optTab == null ? 'No shared lines. Add things every option includes, like the permit or trip charge.' : 'No lines in this option yet') : 'No line items — add one below'}</td></tr>`;
    drawOpts(); totals();
    $$('#items textarea.desc').forEach(el => { el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight + 2, 320) + 'px'; });
  };
  const drawOpts = () => {
    const bar = $('#optbar'); if (!bar) return;
    if (!doc.opts.length) {
      bar.innerHTML = locked ? '' : '<div class="row" style="margin-bottom:10px"><button type="button" class="btn" id="mkopts">⭐ Offer Good / Better / Best</button><span class="small muted">Let the customer pick between 2–4 packages. Lines already entered stay in every option.</span></div>';
      if ($('#mkopts')) $('#mkopts').onclick = () => {
        doc.opts = [{ name: 'Good', description: '' }, { name: 'Better', description: '', recommended: true }, { name: 'Best', description: '' }];
        optTab = 0; draw();
      };
      return;
    }
    const tabs = [[null, 'In every option'], ...doc.opts.map((o, k) => [k, o.name])];
    bar.innerHTML = `<div class="opt-tabs">${tabs.map(([k, l]) => `<button type="button" class="${k === optTab ? 'on' : ''}" data-opt="${k == null ? '' : k}">${esc(l)}${k != null && doc.opts[k].recommended ? ' ★' : ''}${k != null && doc.opts[k]._id && doc.opts[k]._id === doc.approved_option_id ? ' ✓' : ''}
        ${k != null ? `<span class="small">${money(calcTotals({ ...doc, items: optItems(k) }).total)}</span>` : ''}</button>`).join('')}
      ${locked ? '' : '<button type="button" class="btn sm" id="editopts">Edit options</button>'}</div>
      <p class="small muted" style="margin:6px 0 10px">${optTab == null ? 'Lines on this tab are included in every option.' : `${esc(doc.opts[optTab].description || 'No description — add one under Edit options; customers read it.')}${locked ? '' : ' · <a href="#" id="copyopt">Copy these lines to another option</a>'}`}</p>`;
    $$('[data-opt]', bar).forEach(b => b.onclick = () => { optTab = b.dataset.opt === '' ? null : Number(b.dataset.opt); draw(); });
    if ($('#copyopt')) $('#copyopt').onclick = e => {
      e.preventDefault();
      const others = doc.opts.map((o, k) => [k, o.name]).filter(([k]) => k !== optTab);
      formModal({ title: `Copy “${doc.opts[optTab].name}” lines`, okLabel: 'Copy', fields: [{ name: 'to', label: 'Copy to', type: 'select', options: others, blank: false }],
        submit: async d => { const to = Number(d.to); doc.items.push(...doc.items.filter(it => it.opt === optTab).map(it => ({ ...it, id: undefined, opt: to }))); optTab = to; draw(); } });
    };
    if ($('#editopts')) $('#editopts').onclick = () => {
      const row = (o, k) => `<tr data-k="${k}"><td><input data-f="name" value="${esc(o.name)}" maxlength="60"></td><td><input data-f="description" value="${esc(o.description || '')}" placeholder="What makes this option different"></td>
        <td style="text-align:center"><input type="radio" name="rec" ${o.recommended ? 'checked' : ''} style="width:auto"></td><td><button type="button" class="btn sm danger" data-rmopt>✕</button></td></tr>`;
      const m = modal(`<form><h2>Options</h2><p class="small muted">2–4 options. The recommended option is highlighted for the customer and is the default price on lists.</p>
        <div class="table-wrap"><table class="items"><thead><tr><th>Name</th><th>Description (customer sees this)</th><th>Recommended</th><th></th></tr></thead><tbody id="optrows">${doc.opts.map(row).join('')}</tbody></table></div>
        <div class="row" style="margin-top:8px"><button type="button" class="btn" id="addopt">+ Option</button><button type="button" class="btn danger" id="noopts" style="margin-left:auto">Stop offering options</button></div>
        <div class="actions"><button type="button" class="btn" data-x>Cancel</button><button class="btn primary">Apply</button></div></form>`, { wide: true });
      $('[data-x]', m.el).onclick = m.close;
      $('#addopt', m.el).onclick = () => { if ($$('#optrows tr', m.el).length >= 4) return toast('Up to four options', true); $('#optrows', m.el).insertAdjacentHTML('beforeend', row({ name: 'Option', description: '' }, 'new')); };
      $('#optrows', m.el).addEventListener('click', e => { if (e.target.closest('[data-rmopt]')) e.target.closest('tr').remove(); });
      $('#noopts', m.el).onclick = () => {
        // keep the shared lines and the recommended option's lines as a single price
        const keep = Math.max(0, doc.opts.findIndex(o => o.recommended));
        if (!confirm(`Quote a single price? Lines in “${doc.opts[keep].name}” are kept; other options' lines are removed.`)) return;
        doc.items = doc.items.filter(it => it.opt == null || it.opt === keep).map(it => ({ ...it, opt: null }));
        doc.opts = []; optTab = null; m.close(); draw();
      };
      $('form', m.el).onsubmit = e => {
        e.preventDefault();
        const rows = $$('#optrows tr', m.el);
        if (rows.length < 2) return toast('Keep at least two options, or choose “Stop offering options”', true);
        const map = {}; // old index → new index
        const next = rows.map((tr, n) => { if (tr.dataset.k !== 'new') map[tr.dataset.k] = n;
          return { name: $('[data-f=name]', tr).value.trim() || `Option ${n + 1}`, description: $('[data-f=description]', tr).value.trim(), recommended: $('[name=rec]', tr).checked, _id: tr.dataset.k !== 'new' ? doc.opts[tr.dataset.k]._id : null }; });
        const dropped = doc.items.filter(it => it.opt != null && map[it.opt] == null).length;
        if (dropped && !confirm(`${dropped} line(s) in removed options will be deleted. Continue?`)) return;
        doc.items = doc.items.filter(it => it.opt == null || map[it.opt] != null).map(it => ({ ...it, opt: it.opt == null ? null : map[it.opt] }));
        doc.opts = next; optTab = optTab == null ? null : (map[optTab] ?? 0); m.close(); draw();
      };
    };
  };
  // tech pricing check: live discount limit + the saved margin check (margin itself stays hidden)
  const techCheck = (t, k) => {
    if (t.sub > 0 && t.disc / t.sub * 100 > maxDisc + 1e-9) return `<span class="pill warn">Discount over ${maxDisc}% → office review</span>`;
    const c = doc.guard && doc.guard.checks && doc.guard.checks[doc.opts.length ? k : 0];
    if (!c) return '<span class="muted">Save to check pricing</span>';
    return c.margin_ok ? '<span class="pill good">✓ Pricing OK</span>' : '<span class="pill warn">Low margin → office review</span>';
  };
  const totals = () => {
    doc.tax_rate = form.tax_rate.value; doc.discount = form.discount.value;
    if (doc.opts.length) {
      // one row per option: customer price + internal margin
      $('#totals').innerHTML = doc.opts.map((o, k) => { const t = calcTotals({ ...doc, items: optItems(k) });
        return `<div class="${k === optTab ? 'grand' : ''}"><span>${esc(o.name)}${o.recommended ? ' ★' : ''}</span><span>${money(t.total)}</span></div>
          <div class="muted small" style="justify-content:flex-end">tax ${money(t.tax)}${seeCosts ? ` · cost ${money(t.cost)} · margin ${pct(t.margin)}${t.margin < Number(st.target_gross_margin) ? ' ⚠' : ''}` : ''}${techMode ? ' · ' + techCheck(t, k) : ''}</div>`; }).join('')
        + (techMode ? '' : '<div class="muted small" style="margin-top:8px;border-top:1px dashed var(--border);padding-top:6px">Costs and margins are internal only.</div>');
      return;
    }
    const t = calcTotals(doc);
    $('#totals').innerHTML = `<div><span>Subtotal</span><span>${money(t.sub)}</span></div>${t.disc ? `<div><span>Discount</span><span>−${money(t.disc)}</span></div>` : ''}
      <div><span>Tax</span><span>${money(t.tax)}</span></div><div class="grand"><span>Total</span><span>${money(t.total)}</span></div>
      ${!isEst && doc.paid ? `<div><span>Paid</span><span>${money(doc.paid)}</span></div><div><b>Balance</b><b>${money(t.total - doc.paid)}</b></div>` : ''}
      ${techMode ? `<div class="small" style="margin-top:8px">${techCheck(t, 0)}</div>` : ''}
      <div class="muted small" style="margin-top:8px;border-top:1px dashed var(--border);padding-top:6px;${seeCosts ? '' : 'display:none'}">Internal only: est. cost ${money(t.cost)} · margin <b class="${t.margin < Number(st.target_gross_margin) ? '' : ''}">${pct(t.margin)}</b>${t.margin < Number(st.target_gross_margin) ? ` <span class="pill warn">below ${st.target_gross_margin}% target</span>` : ''}</div>`;
  };
  tbody.addEventListener('input', e => {
    const tr = e.target.closest('tr[data-i]'); if (!tr) return;
    const it = doc.items[tr.dataset.i]; const k = e.target.dataset.k;
    it[k] = e.target.type === 'checkbox' ? (e.target.checked ? 1 : 0) : e.target.value;
    if (k === 'description') {
      growDesc(e.target);
      const p = pb.find(x => x.name === e.target.value);
      if (p) { pickPb(tr.dataset.i, p); return; }
      pbMenu(e.target, tr.dataset.i);
    }
    $('[data-line]', tr).textContent = money((+it.qty || 0) * (+it.unit_price || 0)); totals();
  });
  // ---- description: a growing text box (several lines OK) with a price-book dropdown while the line is short
  const growDesc = el => { el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight + 2, 320) + 'px'; };
  const pickPb = (ix, p) => {
    const it = doc.items[ix];
    Object.assign(it, { pricebook_id: p.id, description: p.name, unit_price: p.unit_price, unit_cost: p.unit_cost ?? 0, taxable: p.taxable, cost_code_id: p.cost_code_id || it.cost_code_id });
    closeMenu(); draw(); const q = $(`tr[data-i="${ix}"] [data-k=qty]`); if (q) q.focus();
  };
  let menu = null, menuIx = null, menuSel = -1, menuList = [];
  const closeMenu = () => { if (menu) menu.remove(); menu = null; menuIx = null; menuSel = -1; menuList = []; };
  const pbMenu = (el, ix) => {
    const t = el.value.trim().toLowerCase();
    if (locked || t.length < 2 || el.value.includes('\n')) return closeMenu();   // a multi-line description isn't a search
    menuList = pb.filter(p => `${p.name} ${p.code || ''}`.toLowerCase().includes(t)).slice(0, 8);
    if (!menuList.length) return closeMenu();
    if (!menu) { menu = document.createElement('div'); menu.className = 'pbdrop'; document.body.appendChild(menu); }
    menuIx = ix; menuSel = -1;
    const r = el.getBoundingClientRect();
    Object.assign(menu.style, { left: `${r.left + window.scrollX}px`, top: `${r.bottom + window.scrollY + 2}px`, width: `${Math.max(r.width, 320)}px` });
    menu.innerHTML = menuList.map((p, n) => `<div class="pbopt" data-n="${n}"><b>${esc(p.name)}</b> <span class="muted small">${esc(p.code || '')} · ${money(p.unit_price)}</span></div>`).join('');
    $$('.pbopt', menu).forEach(o => o.onmousedown = ev => { ev.preventDefault(); pickPb(menuIx, menuList[+o.dataset.n]); });
  };
  tbody.addEventListener('keydown', e => {
    if (!e.target.classList.contains('desc') || !menu) return;
    const tr = e.target.closest('tr[data-i]'); if (!tr || tr.dataset.i !== menuIx) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); menuSel = (menuSel + (e.key === 'ArrowDown' ? 1 : -1) + menuList.length) % menuList.length; $$('.pbopt', menu).forEach((o, n) => o.classList.toggle('on', n === menuSel)); }
    else if (e.key === 'Enter' && menuSel >= 0 && !e.shiftKey) { e.preventDefault(); pickPb(menuIx, menuList[menuSel]); }
    else if (e.key === 'Escape') closeMenu();
  });
  tbody.addEventListener('focusout', e => { if (e.target.classList.contains('desc')) setTimeout(closeMenu, 150); });
  tbody.addEventListener('change', e => {
    if (e.target.type === 'checkbox') totals();
    if (e.target.dataset.k === 'cost_code_id') doc.items[e.target.closest('tr').dataset.i].cost_code_id = e.target.value || null;
  });
  tbody.addEventListener('click', e => { const b = e.target.closest('[data-rm]'); if (b) { doc.items.splice(+b.dataset.rm, 1); draw(); } });
  form.tax_rate.oninput = totals; form.discount.oninput = totals;
  if (!locked) {
    $('#addline').onclick = () => { doc.items.push({ description: '', qty: 1, unit_price: 0, unit_cost: 0, taxable: 1, opt: optTab }); draw(); $$('#items .desc').pop().focus(); };
    $('#addlabor').onclick = () => {
      if (techMode) {
        const lab = pb.find(p => p.kind === 'labor');
        if (!lab) return toast('No labor item in the price book — ask the office to add one', true);
        doc.items.push({ pricebook_id: lab.id, description: lab.name, qty: 1, unit_price: lab.unit_price, taxable: lab.taxable, cost_code_id: lab.cost_code_id, opt: optTab }); return draw();
      }
      const rate = Math.max(...S.users.map(u => u.bill_rate || 0), 0) || 125;
      const loaded = S.users.filter(u => u.role === 'tech' && u.hourly_wage).map(u => u.hourly_wage * (1 + u.burden_pct / 100));
      doc.items.push({ description: 'Electrical labor', qty: 1, unit_price: rate, unit_cost: loaded.length ? Math.round(loaded.reduce((a, b) => a + b, 0) / loaded.length * 100) / 100 : 0, taxable: 0, opt: optTab }); draw();
    };
    if ($('#voicebtn')) $('#voicebtn').onclick = () => voiceScope({ doc, form, opt: () => optTab, draw, techMode });
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
    if (!techMode && !form.customer_id.value) return toast('Choose the customer from the search list', true);
    const body = techMode ? { job_id: doc.job_id, title: form.title.value, discount: Number(form.discount.value) || 0, notes: form.notes.value }
      : { customer_id: Number(form.customer_id.value), title: form.title.value, tax_rate: Number(form.tax_rate.value) || 0, discount: Number(form.discount.value) || 0, notes: form.notes.value, terms: form.terms.value };
    if (isEst) Object.assign(body, { location_id: form.location_id.value || null, valid_until: form.valid_until.value || null, job_id: doc.job_id || null });
    else Object.assign(body, { job_id: form.job_id.value || null, issue_date: form.issue_date.value || undefined, due_date: form.due_date.value || undefined });
    if (!locked) {
      body.items = doc.items.filter(it => it.description).map(it => ({ ...it, option_index: it.opt }));
      if (isEst && (doc.opts.length || (doc.options || []).length)) {
        if (doc.opts.length) for (let k = 0; k < doc.opts.length; k++) if (!body.items.some(it => it.option_index === k)) return toast(`“${doc.opts[k].name}” has no lines yet`, true);
        body.options = doc.opts.map(o => ({ name: o.name, description: o.description, recommended: !!o.recommended }));
      }
    }
    if (id === 'new') { const r = await act(() => POST(base, body), 'Saved'); go(`#${base}/${r.id}`); }
    else { await act(() => PUT(`${base}/${id}`, body), 'Saved'); route(); }
  };
  if (techMode) {
    // customer, location, tax, terms and dates come from the job and office settings
    ['customer_id', 'location_id', 'tax_rate', 'terms', 'valid_until'].forEach(n => { if (form.elements[n]) form.elements[n].disabled = true; });
  }
  if (id === 'new') return;
  const on = (sel, fn) => { const el = $(sel); if (el) el.onclick = fn; };
  on('#present', async () => { const r = await act(() => POST(`/estimates/${id}/present`)); window.open(r.url, '_blank', 'noopener'); route(); });
  on('#rv-ok', async () => { await act(() => POST(`/estimates/${id}/review`, { decision: 'approve' }), 'Pricing approved — the tech can present it'); route(); });
  on('#rv-back', () => formModal({ title: 'Send back to tech', okLabel: 'Send back', fields: [{ name: 'note', label: 'What should they change?', type: 'textarea', required: true, full: true }],
    submit: async d => { await POST(`/estimates/${id}/review`, { decision: 'reject', note: d.note }); toast('Sent back'); route(); } }));
  on('#send', async () => {
    const em = await GET(`${base}/${id}/email`);
    const m = formModal({
      title: `Send ${kind} ${doc.number}`, okLabel: em.smtp ? 'Send' : 'Record & copy link', wide: true, values: { to: em.to, subject: em.subject, body: em.body },
      fields: [{ name: 'to', label: 'To', type: 'email', required: true, full: true }, { name: 'subject', label: 'Subject', required: true, full: true },
        { name: 'body', label: 'Message — edit anything for this one email', type: 'textarea', required: true, full: true }],
      extra: `<p class="small muted" style="margin-top:6px">The customer link (to view${isEst ? ', sign and approve' : ''} online) is in the message: <code>${esc(em.url)}</code>. Keep it in.
        ${isAdmin() ? 'To change the wording for every email, use <a href="#/settings">Settings → Email templates</a>.' : ''}</p>`,
      submit: async d => {
        if (!String(d.body || '').includes(em.url) && !String(d.body || '').includes('{link}') && !confirm('The customer link isn\'t in the message any more, so they won\'t be able to open it. Send anyway?')) throw new Error('Not sent');
        const r = await POST(`${base}/${id}/send`, d);
        if (r.status === 'sent') toast('Email sent');
        else if (r.status === 'not_configured') { await navigator.clipboard?.writeText(r.url).catch(() => {}); toast('Email is not set up (see Settings). Marked as sent and copied the customer link — paste it into a text or email.', true); }
        else toast('Email failed: ' + (r.error || 'unknown'), true);
        route();
      },
    });
    const ta = $('textarea[name=body]', m.el); if (ta) ta.rows = 14;
  });
  on('#mark-approved', async () => {
    if (!(doc.options || []).length) { await act(() => PUT(`${base}/${id}`, { status: 'approved' }), 'Marked approved'); return route(); }
    formModal({ title: 'Which option did the customer choose?', okLabel: 'Mark approved', values: { option: doc.chosen_option_id },
      fields: [{ name: 'option', label: 'Option', type: 'select', options: doc.options.map(o => [o.id, `${o.name} — ${money(o.total)}`]), blank: false, full: true }],
      submit: async d => { await PUT(`${base}/${id}`, { status: 'approved', approved_option_id: Number(d.option) }); toast('Marked approved'); route(); } });
  });
  on('#mark-declined', async () => { await act(() => PUT(`${base}/${id}`, { status: 'declined' }), 'Marked declined'); route(); });
  on('#tojob', async () => { const r = await act(() => POST(`${base}/${id}/convert-to-job`), 'Job created — schedule it'); go('#/jobs/' + r.id); });
  on('#toinv', async () => { const r = await act(() => POST(`${base}/${id}/convert-to-invoice`), 'Invoice created'); go('#/invoices/' + r.id); });
  on('#del', async () => {
    const msg = isEst && doc.status !== 'draft' ? `Permanently delete ${doc.number}? The customer has already been sent this ${kind}, and their link will stop working. This can't be undone.\n\nTo keep the record, use Cancel estimate instead.` : `Delete this ${kind}? This can't be undone.`;
    if (confirm(msg)) { await act(() => DEL(`${base}/${id}`), 'Deleted'); go(doc.job_id ? '#/jobs/' + doc.job_id : '#' + base); }
  });
  on('#cancelest', () => formModal({
    title: `Cancel ${doc.number}`, okLabel: 'Cancel estimate',
    extra: `<p class="small muted">${doc.status === 'approved' ? '<b>The customer approved this estimate.</b> Cancelling it removes it from the job\'s contract value. ' : ''}The estimate is kept for your records, but the customer can no longer sign it, and it isn't counted as a lost sale.</p>`,
    fields: [{ name: 'reason', label: 'Reason (optional)', full: true, placeholder: 'e.g. Customer postponed, duplicate, re-quoted as EST-1042' }],
    submit: async d => { await POST(`${base}/${id}/cancel`, d); toast('Estimate cancelled'); route(); } }));
  on('#reopenest', async () => { await act(() => POST(`${base}/${id}/reopen`), 'Reopened as draft'); route(); });
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
  const from = params.get('from') || (() => { const d = new Date(); d.setDate(d.getDate() - weekOffset(d)); return localDate(d); })();
  const to = params.get('to') || todayStr();
  const userId = params.get('user_id') || '';
  $('#view').innerHTML = setTop('Time Clock', isOffice() ? '<button class="btn" id="add">+ Add time</button>' : '') + `<div id="clock"></div>
    ${isOffice() ? '<div class="card" style="margin-top:14px" id="weekcard"></div>' : ''}
    <div class="card" style="margin-top:14px"><div class="row spread"><h2>${isOffice() ? 'Timesheets' : 'My hours'}</h2>
      <form id="flt" class="row">${isOffice() ? `<select name="user_id" style="width:auto"><option value="">Everyone</option>${techOptions().map(([v, l]) => `<option value="${v}" ${String(v) === userId ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>` : ''}
        <input type="date" name="from" value="${from}" style="width:auto"> to <input type="date" name="to" value="${to}" style="width:auto"><button class="btn">Show</button></form></div><div id="sheet"></div></div>`;
  await clockCard($('#clock'));
  if (isOffice()) { $('#add').onclick = () => timeForm({}); weekCard($('#weekcard'), params.get('week') || todayStr()); }
  $('#flt').onsubmit = e => { e.preventDefault(); const f = e.target; go('#/time' + qs({ from: f.from.value, to: f.to.value, user_id: f.user_id ? f.user_id.value : '' })); };
  const rows = await GET('/time' + qs({ from, to, user_id: userId }));
  const total = rows.reduce((s, r) => s + r.hours, 0);
  const byUser = {};
  for (const r of rows) byUser[r.user_name] = (byUser[r.user_name] || 0) + r.hours;
  $('#sheet').innerHTML = (isOffice() && Object.keys(byUser).length > 1 ? `<div class="row" style="margin-bottom:10px">${Object.entries(byUser).map(([n, h]) => `<span class="pill accent">${esc(n)}: ${num(h)} h</span>`).join('')}</div>` : '') +
    table([{ label: 'Date', get: t => fmtDate(localDate(new Date(t.clock_in))) }, ...(isOffice() ? [{ label: 'Employee', key: 'user_name' }] : []),
      { label: 'Job', html: t => t.job_id ? `<a href="#/jobs/${t.job_id}">${esc(t.job_number)}</a> ${esc(t.job_title)}` : '—' }, { label: 'Type', get: t => label(t.kind) },
      { label: 'Code', get: t => t.cost_code || '—' }, { label: 'In', get: t => fmtTime(t.clock_in) },
      { label: 'GPS', html: t => [['in', t.in_lat, t.in_lng, t.in_acc], ['out', t.out_lat, t.out_lng, t.out_acc]].filter(x => x[1] != null).map(([k, la, ln, ac]) => `<a target="_blank" rel="noopener" href="https://maps.google.com/?q=${la},${ln}" title="±${ac || '?'} m">📍${k}</a>`).join(' ') || '—', csv: t => t.in_lat != null ? `${t.in_lat},${t.in_lng}` : '' }, { label: 'Out', html: t => t.clock_out ? fmtTime(t.clock_out) : '<span class="pill good">On the clock</span>' },
      { label: 'Hours', num: 1, get: t => num(t.hours) }, { label: 'Notes', key: 'notes' }], rows,
    { onClick: isOffice() ? t => timeForm(t) : null, empty: 'No time in this range', foot: rows.length ? ['Total', ...(isOffice() ? [''] : []), '', '', '', '', '', '', { v: num(total), num: 1 }, ''] : null });
}

// Everyone's workweek (Sun–Sat or Mon–Sun, per Settings): hours worked so far, scheduled, projected; flags anyone over or headed over the overtime line.
async function weekCard(el, day, { compact = false } = {}) {
  const w = await GET('/time/week' + qs({ week: day }));
  if (!el.isConnected) return;
  const shift = n => { const d = new Date(w.week + 'T00:00:00'); d.setDate(d.getDate() + n); return localDate(d); };
  const t = todayStr(), lim = w.ot_after;
  const FLAG = { over: ['bad', `⚠ Over ${lim} now`], projected: ['warn', `⚠ Headed over ${lim}`], scheduled: ['info', `Scheduled over ${lim}`] };
  const rows = w.rows.slice().sort((a, b) => (b.flags.length > 0) - (a.flags.length > 0) || b.projected - a.projected || a.name.localeCompare(b.name));
  const bar = r => { const max = Math.max(lim * 1.25, r.projected, r.scheduled);
    return `<div class="wkbar" title="${num(r.worked)} h worked · ${num(r.ahead)} h still scheduled · ${num(r.scheduled)} h scheduled this week">
      <span class="wkw ${r.worked > lim ? 'over' : ''}" style="width:${r.worked / max * 100}%"></span><span class="wka" style="width:${r.ahead / max * 100}%"></span>
      <span class="wkl" style="left:${lim / max * 100}%" aria-hidden="true"></span></div>`; };
  const flagged = w.rows.filter(r => r.flags.length).length;
  el.innerHTML = `<div class="row spread" style="flex-wrap:wrap;gap:8px"><h2 style="margin:0">Week at a glance</h2>
      <div class="row" style="gap:6px"><button class="btn sm" data-wk="${shift(-7)}" aria-label="Previous week">‹</button><b>${fmtDate(w.days[0])} – ${fmtDate(w.days[6])}</b><button class="btn sm" data-wk="${shift(7)}" aria-label="Next week">›</button>
      ${w.days.includes(t) ? '' : `<button class="btn sm" data-wk="${t}">This week</button>`}</div></div>
    <p class="small muted" style="margin:6px 0 10px">Worked = clocked hours so far (anyone on the clock counts up to now). Scheduled = their visits on the board this week.
      Projected = worked + scheduled time still ahead. Overtime after ${esc(lim)} h (Settings). ${flagged ? `<b>${flagged} flagged.</b>` : 'Nobody flagged.'}${compact ? ' <a href="#/time">Time Clock →</a>' : ''}</p>
    ${table([{ label: 'Employee', html: r => `<b>${esc(r.name)}</b>${r.on_clock ? ' <span class="pill good">On the clock</span>' : ''}<div class="small muted">${esc(label(r.role))}</div>` },
      ...w.days.map((d, i) => ({ label: new Date(d + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', day: 'numeric' }), num: true,
        html: r => `${r.worked_by_day[i] ? num(r.worked_by_day[i], 1) : d <= t ? '<span class="muted">–</span>' : ''}${r.scheduled_by_day[i] ? `<div class="small muted" title="Scheduled">${num(r.scheduled_by_day[i], 1)} sch</div>` : ''}` })),
      { label: 'Worked', num: true, html: r => `<b>${num(r.worked, 1)}</b>` },
      { label: 'Scheduled', num: true, get: r => num(r.scheduled, 1) },
      { label: 'Projected', num: true, html: r => `<b>${num(r.projected, 1)}</b>${bar(r)}` },
      { label: 'Flag', html: r => r.flags.map(f => `<span class="pill ${FLAG[f][0]}">${FLAG[f][1]}</span>`).join(' ') || '<span class="pill good">✓ Under</span>' }],
      rows, { empty: 'No one on the clock or the schedule this week' })}`;
  $$('[data-wk]', el).forEach(b => b.onclick = () => weekCard(el, b.dataset.wk, { compact }));
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
  if (isAdmin()) await loadAccounts();
  formModal({
    title: e.id ? 'Edit expense' : 'Add expense', values: e,
    fields: [{ name: 'date', label: 'Date', type: 'date', required: true }, { name: 'amount', label: 'Amount $', type: 'number', required: true },
      { name: 'category', label: 'Category', type: 'select', options: EXPENSE_CATS, required: true }, { name: 'vendor', label: 'Vendor' },
      { name: 'job_id', label: 'Job (blank = company overhead)', type: 'job', full: true },
      { name: 'cost_code_id', label: 'Cost code (job costs)', type: 'select', options: ccOptions() },
      { name: 'billable', label: 'Bill to customer (T&M jobs, at the job markup)', type: 'checkbox' },
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

  const m = formModal({
    title: p.id ? 'Edit permit' : 'New permit', values: p, wide: true,
    fields: [{ name: 'job_id', label: 'Job', type: 'job', required: true, full: true }, { name: 'permit_type', label: 'Permit type (e.g. Service change, EVSE)' }, { name: 'permit_number', label: 'Permit #' },
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
  $('#view').innerHTML = setTop('Permits & Inspections', isOffice() ? '<a class="btn" href="#/reports?r=permits">Permit report</a><button class="btn primary" id="new">+ Permit</button>' : '') + `<div class="card">
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
  formModal({
    title: a.id ? 'Edit agreement' : 'New service agreement', values: a, wide: true,
    fields: [{ name: 'customer_id', label: 'Customer', type: 'customer', required: true, full: true }, { name: 'name', label: 'Plan name', required: true, full: true },
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
const PERMIT_DATES = [['applied', 'Applied'], ['issued', 'Issued'], ['inspection', 'Inspection'], ['expires', 'Expires']];
async function permitReportView(R, params, from, to) {
  const by = params.get('by') || 'applied', status = params.get('status') || 'all', jurisdiction = params.get('jurisdiction') || '';
  const d = await GET('/reports/permits' + qs({ from, to, by, status, jurisdiction }));
  const sm = d.summary;
  const cols = [{ label: 'Job', html: p => `<a href="#/jobs/${p.job_id}">${esc(p.job_number)}</a><div class="muted small">${esc(p.job_title)}</div>`, csv: p => p.job_number },
    { label: 'Customer / address', html: p => `${esc(p.customer_company || p.customer_name)}<div class="muted small">${esc(p.address || '')}</div>`, csv: p => p.customer_company || p.customer_name },
    { label: 'Address', html: () => '', csv: p => p.address, hide: 1 },
    { label: 'Type', key: 'permit_type' }, { label: 'Permit #', key: 'permit_number' }, { label: 'Jurisdiction', key: 'jurisdiction' },
    { label: 'Status', html: p => pill(p.status) + (p.flags.length ? `<div class="small" style="color:var(--bad)">${p.flags.map(esc).join('<br>')}</div>` : ''), csv: p => p.status },
    { label: 'Applied', get: p => fmtDate(p.applied_date), csv: p => p.applied_date }, { label: 'Issued', get: p => fmtDate(p.issued_date), csv: p => p.issued_date },
    { label: 'Inspection', get: p => fmtDate(p.inspection_date), csv: p => p.inspection_date }, { label: 'Expires', get: p => fmtDate(p.expires_date), csv: p => p.expires_date },
    { label: 'Days open', num: 1, get: p => p.days_open ?? '', csv: p => p.days_open ?? '' }, { label: 'Inspector', key: 'inspector' }, { label: 'Techs', key: 'techs' },
    { label: 'Fee', num: 1, get: p => money(p.fee), csv: p => p.fee }, { label: 'Issues', html: () => '', csv: p => p.flags.join('; '), hide: 1 }];
  const go2 = o => go('#/reports' + qs({ r: 'permits', from, to, by, status, jurisdiction, ...o }));
  R.innerHTML = `<form id="pf" class="row no-print" style="margin-bottom:12px;flex-wrap:wrap">
      <label class="small">Date range applies to <select name="by" style="width:auto">${PERMIT_DATES.map(([k, l]) => `<option value="${k}" ${k === by ? 'selected' : ''}>${l} date</option>`).join('')}</select></label>
      <label class="small">Status <select name="status" style="width:auto">${[['all', 'All'], ['open', 'Open (not passed/closed)'], ['attention', 'Needs attention'], ['failed', 'Failed'], ['passed,closed', 'Passed / closed'], ['needed', 'Needed'], ['applied', 'Applied'], ['issued', 'Issued'], ['rough_scheduled,final_scheduled', 'Inspection scheduled']]
        .map(([k, l]) => `<option value="${k}" ${k === status ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label class="small">Jurisdiction <select name="jurisdiction" style="width:auto"><option value="">All</option>${sm.jurisdictions.map(j => `<option ${j === jurisdiction ? 'selected' : ''}>${esc(j)}</option>`).join('')}</select></label></form>
    <div class="grid g4">${kpi('Permits', sm.count, `${fmtDate(from)} – ${fmtDate(to)}, by ${by} date`)}${kpi('Open', sm.open, `${sm.passed} passed / closed`)}${kpi('Need attention', sm.attention, `${sm.failed} failed`)}${kpi('Permit fees', money0(sm.fees))}</div>
    <div class="grid g2" style="margin-top:14px">
      <div class="card"><h2>By status</h2>${table([{ label: 'Status', html: x => pill(x.status) }, { label: 'Permits', num: 1, key: 'count' }, { label: 'Fees', num: 1, get: x => money(x.fees) }], sm.by_status, { empty: 'None', onClick: x => go2({ status: x.status }) })}</div>
      <div class="card"><h2>By jurisdiction</h2>${table([{ label: 'Jurisdiction', key: 'jurisdiction' }, { label: 'Permits', num: 1, key: 'count' }, { label: 'Fees', num: 1, get: x => money(x.fees) }], sm.by_jurisdiction, { empty: 'None', onClick: x => x.jurisdiction !== '(none)' && go2({ jurisdiction: x.jurisdiction }) })}</div></div>
    <div class="card" style="margin-top:14px"><h2>Permits</h2>${table(cols.filter(c => !c.hide), d.rows, { empty: 'No permits match. Try a wider date range, or a different date type.' })}</div>`;
  $('#pf').onchange = e => go2({ [e.target.name]: e.target.value });
  return () => toCSV(cols, d.rows, `permits_${by}_${from}_${to}.csv`);
}
async function viewReports() {
  const { params } = hashParams();
  const r = params.get('r') || 'pl';
  const [defFrom, defTo] = presetRange('mtd');
  const from = params.get('from') || defFrom, to = params.get('to') || defTo;
  const REPORT_PERM = { hours: 'timesheets', payroll: ['timesheets', 'payroll_export'], permits: 'jobs' };
  const tabs = [['pl', 'Profit & Loss'], ['jobs', 'Jobs'], ['jobcost', 'Job Costing'], ['hours', 'Hours by Job'], ['payroll', 'Payroll / Timesheet'], ['tech', 'Tech Performance'], ['ar', 'A/R Aging'], ['est', 'Estimates'], ['source', 'Lead Sources'], ['cc', 'Cost Codes'], ['wip', 'WIP & Unbilled'], ['permits', 'Permits']]
    .filter(([k]) => [].concat(REPORT_PERM[k] || 'reports').some(p => can(p)));
  if (!tabs.length) { $('#view').innerHTML = setTop('Reports') + '<div class="card empty">You don\'t have access to any reports. Ask the owner to turn some on under Team.</div>'; return; }
  if (!tabs.some(([k]) => k === r)) return go('#/reports' + qs({ r: tabs[0][0], from: params.get('from'), to: params.get('to') }));
  $('#view').innerHTML = setTop('Reports', '<button class="btn" id="csv">Export CSV</button><button class="btn" onclick="print()">Print</button>') + `
    <div class="tabs">${tabs.map(([k, l]) => `<button class="${k === r ? 'on' : ''}" data-r="${k}">${l}</button>`).join('')}</div>
    ${r === 'ar' || r === 'wip' ? '' : `<form id="rng" class="row no-print" style="margin-bottom:14px"><input type="date" name="from" value="${from}" style="width:auto"> to <input type="date" name="to" value="${to}" style="width:auto"><button class="btn">Run</button>
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

  if (r === 'jobs') return jobsReport(R, { params, from, to, sub, setCsv: f => { csv = f; } });
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
    const exp = can('payroll_export') ? '<div id="pxcard"></div>' : '';
    if (!can('timesheets')) { R.innerHTML = exp; payrollExportCard($('#pxcard')); return; }
    const rows = await GET('/reports/payroll' + qs({ from, to }));
    const kinds = ['job', 'travel', 'shop', 'training', 'pto'];
    const cols = [{ label: 'Employee', html: r => `${esc(r.name)}${r.pay_type === 'salary' ? ' <span class="pill">Salary</span>' : ''}`, csv: r => r.name }, ...kinds.map(k => ({ label: label(k), num: 1, get: r => num(r.by_kind[k] || 0), csv: r => r.by_kind[k] || 0 })),
      { label: 'Regular', num: 1, get: r => num(r.regular_hours), csv: r => r.regular_hours }, { label: 'Overtime', num: 1, html: r => r.overtime_hours ? `<span class="pill warn">${num(r.overtime_hours)}</span>` : '0', csv: r => r.overtime_hours },
      { label: 'Total hrs', num: 1, get: r => num(r.total_hours), csv: r => r.total_hours }, { label: 'Gross pay', num: 1, get: r => money(r.gross_pay), csv: r => r.gross_pay }];
    R.innerHTML = exp + `<div class="card"><h2>Payroll summary — ${sub}</h2><p class="small muted">Overtime: hours worked over ${esc(S.settings.overtime_weekly_hours)}/week (${weekLabel()}) at ${esc(S.settings.overtime_multiplier)}×; PTO doesn't count toward overtime. Gross pay is before taxes & deductions.${can('payroll_export') ? ' Use <b>Payroll export</b> above for the file to send to payroll.' : ''}</p>
      ${table(cols, rows, { empty: 'No time in range', foot: ['Total', ...kinds.map(() => ''), '', '', { v: num(rows.reduce((s, r) => s + r.total_hours, 0)), num: 1 }, { v: money(rows.reduce((s, r) => s + r.gross_pay, 0)), num: 1 }] })}</div>`;
    csv = () => toCSV(cols, rows, `payroll_${from}_${to}.csv`);
    if (exp) payrollExportCard($('#pxcard'));
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
  if (r === 'wip') await wipReportView(R);
  if (r === 'permits') csv = await permitReportView(R, params, from, to);
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
  $('#view').innerHTML = setTop('Team', '<button class="btn" id="teamimp">⇪ Import list</button> <button class="btn primary" id="new">+ Employee</button>', 'Wage + burden = loaded labor cost used in job costing and P&L. Bill rate is used for T&M invoices.') + `<div class="card">
    ${table([{ label: 'Name', html: u => `<span class="dot" style="background:${esc(u.color)}"></span> <b>${esc(u.name)}</b>${u.active ? '' : ' <span class="pill">Inactive</span>'}<div class="muted small">${esc(u.email)}</div>` },
      { label: 'Role', html: u => `${esc(label(u.role))}${u.custom_perms && u.custom_perms.length ? ` <span class="pill warn" title="${esc(u.custom_perms.join(', '))}">custom permissions</span>` : ''}` }, { label: 'Title', key: 'title' }, { label: 'License', key: 'license_number' }, { label: 'Pay', num: 1, get: u => u.pay_type === 'salary' ? `${money(u.salary_annual)}/yr salary` : `${money(u.hourly_wage)}/hr` },
      { label: 'Burden', num: 1, get: u => pct(u.burden_pct) }, { label: 'Loaded cost/hr', num: 1, get: u => money(u.hourly_wage * (1 + u.burden_pct / 100)) }, { label: 'Bill rate', num: 1, get: u => money(u.bill_rate) }],
    users, { onClick: u => userForm(u) })}</div>`;
  $('#new').onclick = () => userForm({});
  $('#teamimp').onclick = teamImport;
}
// Team → Import list: paste from Google Sheets (or pick a CSV) with Name / Email / Phone (/ Role). Preview first:
// people already here get their email + phone updated; the rest are added. Role, wage, permissions untouched.
function teamImport() {
  const m = modal(`<h2>Import team list</h2>
    <p class="small muted">Copy the whole sheet (heading row included: Name, Email, Phone, and optionally Role) and paste it below, or choose a CSV.
      People already on the team — matched by email, then by name — get their <b>email and phone</b> updated. Anyone not here is added.
      New people are never made Admin: their role text picks Technician / Office / Manager and becomes their title.</p>
    <textarea id="ti_txt" rows="7" style="width:100%;font-family:monospace;font-size:12px" placeholder="Name	Role	Email	Phone"></textarea>
    <div class="row" style="margin:8px 0"><input type="file" id="ti_file" accept=".csv,.tsv,.txt,text/csv"><button class="btn" id="ti_prev">Preview</button></div>
    <div id="ti_out"></div>`, { wide: true });
  const el = m.el; let last = '';
  $('#ti_file', el).onchange = async e => { const f = e.target.files[0]; if (f) { $('#ti_txt', el).value = await f.text(); preview(); } };
  const chg = it => Object.entries(it.changes || {}).map(([k, v]) => `${k}: <s class="muted">${esc(v.from || '—')}</s> → <b>${esc(v.to)}</b>`).join('<br>');
  const ACT = { update: ['Update', 'good'], add: ['Add', 'info'], same: ['No change', ''], skip: ['Skip', 'bad'] };
  const draw = (items, applied) => {
    const n = k => items.filter(i => i.action === k).length;
    $('#ti_out', el).innerHTML = `<p><b>${n('update')}</b> to update · <b>${n('add')}</b> to add · ${n('same')} already up to date · ${n('skip')} skipped${applied ? ' — <b>saved</b>' : ''}</p>
      <div style="max-height:46vh;overflow:auto"><table class="items"><thead><tr><th>Row</th><th></th><th>Name</th><th>What happens</th></tr></thead><tbody>
      ${items.map(it => `<tr><td class="muted">${it.row}</td><td><span class="pill ${ACT[it.action][1]}">${ACT[it.action][0]}</span></td>
        <td><b>${esc(it.name || '—')}</b>${it.current_name && it.current_name !== it.name ? `<div class="muted small">on the team as ${esc(it.current_name)}</div>` : ''}${it.matched_by === 'name' ? '<div class="muted small">matched by name</div>' : ''}</td>
        <td class="small">${it.action === 'update' ? chg(it) : it.action === 'add' ? `${esc(it.email)} · ${esc(it.phone || 'no phone')}<br>${esc(label(it.role))}${it.title ? ` — “${esc(it.title)}”` : ''}` : it.action === 'skip' ? esc(it.reason) : ''}
          ${(it.warnings || []).map(w => `<div style="color:var(--warn)">⚠ ${esc(w)}</div>`).join('')}</td></tr>`).join('')}</tbody></table></div>
      ${applied ? `<div class="row" style="margin-top:10px"><button class="btn primary" id="ti_done">Done</button></div>` : n('update') + n('add') ? `<div class="row" style="margin-top:10px;align-items:end;flex-wrap:wrap;gap:10px">
        ${n('add') ? `<label class="small" style="flex:1;min-width:260px">Starting password for the ${n('add')} new ${n('add') === 1 ? 'person' : 'people'} (8+; leave blank to add them <b>inactive</b> and set passwords one at a time)
          <input type="text" id="ti_pw" autocomplete="off"></label>` : ''}
        <button class="btn primary" id="ti_apply">Save ${n('update') + n('add')} change${n('update') + n('add') === 1 ? '' : 's'}</button></div>` : ''}`;
    const d = $('#ti_done', el); if (d) d.onclick = async () => { m.close(); await loadUsers(true); route(); };
    const ap = $('#ti_apply', el); if (ap) ap.onclick = async () => {
      const pw = ($('#ti_pw', el) || {}).value || '';
      if (pw && pw.length < 8) return toast('Starting password must be 8+ characters', 'error');
      ap.disabled = true;
      try { const r = await POST('/users/import', { csv: last, apply: true, start_password: pw }); draw(r.items, true); toast('Team updated'); }
      catch (e) { ap.disabled = false; toast(e.message, 'error'); }
    };
  };
  const preview = async () => {
    last = $('#ti_txt', el).value; if (!last.trim()) return toast('Paste the list first', 'error');
    try { draw((await POST('/users/import', { csv: last })).items, false); } catch (e) { toast(e.message, 'error'); }
  };
  $('#ti_prev', el).onclick = preview;
  $('#ti_txt', el).addEventListener('paste', () => setTimeout(preview, 50));
}
async function userForm(u) {
  const P = await GET('/permissions');
  const role0 = u.role || 'tech';
  const permBox = role => {
    if (role === 'admin') return '<p class="small muted">Admins can do everything, including Team, Settings and Import. Use the Office role to limit what someone can do.</p>';
    const list = P.list.filter(p => p.roles.includes(role)), def = P.defaults[role];
    const cur = role === role0 && u.perms ? u.perms : def;
    return `<p class="small muted">Ticked = allowed. Starts from the ${role === 'tech' ? 'Technician' : role === 'manager' ? 'Manager' : 'Office'} defaults; <a href="#" id="permreset">reset to defaults</a>. Team, Settings and Import are always admin-only.</p>
      <div class="permgrid">${list.map(p => `<label class="check"><input type="checkbox" name="perm_${p.key}" ${cur[p.key] ? 'checked' : ''}> ${esc(p.label)}${!!cur[p.key] !== !!def[p.key] ? ' <span class="pill warn" title="Different from the role default">custom</span>' : ''}</label>`).join('')}</div>`;
  };
  const m = formModal({
    title: u.id ? `Edit ${u.name}` : 'Add employee', values: u, wide: true,
    fields: [{ name: 'name', label: 'Name', required: true }, { name: 'email', label: 'Email (login)', type: 'email', required: true },
      { name: 'role', label: 'Role', type: 'select', options: [['tech', 'Technician (field app)'], ['office', 'Office (choose what they can do below)'], ['manager', 'Manager (all office work + company KPIs; not Team/Settings)'], ['admin', 'Admin (everything)']], blank: false, default: 'tech' },
      { name: 'title', label: 'Title (Apprentice, Journeyman, Foreman…)' }, { name: 'phone', label: 'Phone' }, { name: 'license_number', label: 'License #' },
      { name: 'pay_type', label: 'Pay type', type: 'select', options: [['hourly', 'Hourly (overtime after the weekly limit)'], ['salary', 'Salary (exempt: set pay, no overtime)']], blank: false, default: 'hourly' },
      { name: 'salary_annual', label: 'Yearly salary $ (salaried only)', type: 'number', default: 0 },
      { name: 'hourly_wage', label: 'Hourly wage $ (salaried: cost per hour for job costing; blank = salary ÷ 2080)', type: 'number', default: 0 }, { name: 'burden_pct', label: 'Burden % (taxes, WC, benefits)', type: 'number', default: 25 },
      { name: 'bill_rate', label: 'Bill rate $/hr', type: 'number', default: 0 }, { name: 'color', label: 'Schedule color', type: 'color', default: '#2563eb' },
      { name: 'password', label: u.id ? 'New password (leave blank to keep)' : 'Password (8+ chars)', type: 'password', required: !u.id },
      { name: 'timeclock_id', label: 'Time clock ID (A4Y Time Clock employee ID)', placeholder: 'e.g. E0A1B2C3D4F' },
      { name: 'payroll_id', label: 'Payroll employee ID (as your payroll provider lists them; goes on the payroll export)' },
      { name: 'on_schedule', label: 'Show on the schedule like a tech (Tech board, Week, Dispatch) — e.g. a service manager who runs calls', type: 'checkbox', full: true },
      { name: 'active', label: 'Active (can sign in)', type: 'checkbox', default: 1 }],
    extra: `<h3 style="margin-top:14px">Permissions</h3><div id="perms"></div>`,
    submit: async (d, form) => {
      if (!d.password) delete d.password;
      if (d.role !== 'admin') d.perms = Object.fromEntries(P.list.filter(p => p.roles.includes(d.role)).map(p => [p.key, !!(form.elements['perm_' + p.key] || {}).checked]));
      if (u.id) await PUT('/users/' + u.id, d); else await POST('/users', d);
      await loadUsers(true); toast('Saved'); route();
    },
  });
  const form = $('form', m.el);
  const draw = (role, reset) => {
    $('#perms', m.el).innerHTML = permBox(role);
    if (reset) for (const p of P.list) { const el = form.elements['perm_' + p.key]; if (el) el.checked = !!P.defaults[role][p.key]; }
    const r = $('#permreset', m.el); if (r) r.onclick = e => { e.preventDefault(); draw(role, true); $$('.pill.warn', $('#perms', m.el)).forEach(x => x.remove()); };
  };
  form.role.onchange = () => draw(form.role.value, form.role.value !== role0);
  draw(role0);
}
async function viewSettings() {
  const s = S.settings;
  const fields = [{ name: 'company_name', label: 'Company name' }, { name: 'license_number', label: 'Contractor license #' }, { name: 'company_phone', label: 'Phone' }, { name: 'company_email', label: 'Email' }, { name: 'company_website', label: 'Website' },
    { name: 'company_address', label: 'Address', full: true }, { name: 'default_tax_rate', label: 'Default sales tax %', type: 'number' }, { name: 'invoice_terms_days', label: 'Default invoice terms (days)', type: 'number' },
    { name: 'estimate_valid_days', label: 'Estimates valid for (days)', type: 'number' }, { name: 'target_gross_margin', label: 'Target gross margin %', type: 'number' },
    { name: 'overtime_weekly_hours', label: 'Overtime after (hrs/week)', type: 'number' }, { name: 'overtime_multiplier', label: 'Overtime multiplier', type: 'number' },
    { name: 'workweek_start', label: 'Workweek / pay week starts (overtime, payroll export, time clock week)', type: 'select', options: [['sun', 'Sunday (Sunday–Saturday)'], ['mon', 'Monday (Monday–Sunday)']], blank: false },
    { name: 'estimate_terms', label: 'Default estimate terms', type: 'textarea', full: true }, { name: 'invoice_terms', label: 'Default invoice terms', type: 'textarea', full: true }];
  $('#view').innerHTML = setTop('Settings') + `<div class="grid g2"><div class="card"><h2>Company</h2><form id="sf"><div class="form-grid">${fields.map(f => fieldHtml(f, s[f.name])).join('')}</div>
      ${isAdmin() ? '<div class="row" style="margin-top:12px"><button class="btn primary">Save settings</button></div>' : '<p class="muted">Only admins can change settings.</p>'}</form></div>
    <div class="stack"><div class="card"><h2>Change my password</h2><form id="pw" class="stack">${fieldHtml({ name: 'current', label: 'Current password', type: 'password', required: true })}${fieldHtml({ name: 'next', label: 'New password (8+)', type: 'password', required: true })}<button class="btn">Change password</button></form></div>
    <div class="card"><h2>Notifications on this device</h2><div id="pushme"><div class="muted small">Loading…</div></div></div>
    <div class="card"><h2>Email</h2><div id="emailsetup"><div class="muted small">Loading…</div></div></div>
    ${isAdmin() ? '<div class="card"><h2>Push notifications</h2><div id="pushadmin"><div class="muted small">Loading…</div></div></div>' : ''}
    ${isAdmin() ? '<div class="card"><h2>Email templates</h2><div id="mailtpls"><div class="muted small">Loading…</div></div></div>' : ''}
    ${isAdmin() ? '<div class="card"><h2>Job numbers</h2><div id="jobnums"><div class="muted small">Loading…</div></div></div>' : ''}
    <div class="card"><h2>Appearance</h2><p class="small muted">Applies to this device only.</p><div class="seg">${[['dark', 'Dark (default)'], ['light', 'Light'], ['system', 'Match device']].map(([k, l]) => `<button type="button" data-theme="${k}" class="${themePref() === k ? 'on' : ''}">${l}</button>`).join('')}</div></div></div></div>
    <div id="settings-ext" class="stack" style="margin-top:14px"></div>`;
  // cost codes go last on the page (a long list), full width, after everything the extras add
  settingsExtras($('#settings-ext')).then(() => { const cc = $('#newcc') && $('#newcc').closest('.card'), ext = $('#settings-ext'); if (cc && ext) { cc.id = 'costcodes'; ext.appendChild(cc); } }).catch(() => null);
  emailSetup($('#emailsetup'));
  if ($('#jobnums')) jobNumberSetup($('#jobnums'));
  if ($('#mailtpls')) emailTemplates($('#mailtpls'));
  pushCard($('#pushme'));
  if ($('#pushadmin')) pushAdmin($('#pushadmin'));
  if (isAdmin()) $('#sf').onsubmit = async e => { e.preventDefault(); S.settings = await act(() => PUT('/settings', readForm(e.target, fields)), 'Settings saved'); renderShell(); route(); };
  else $$('#sf input, #sf textarea').forEach(i => i.disabled = true);
  $('#pw').onsubmit = async e => { e.preventDefault(); await act(() => POST('/me/password', { current: e.target.current.value, next: e.target.next.value }), 'Password changed'); e.target.reset(); };
  $$('[data-theme]').forEach(b => b.onclick = () => { try { localStorage.setItem('fo_theme', b.dataset.theme); } catch { /* private mode */ } applyTheme(); $$('[data-theme]').forEach(x => x.classList.toggle('on', x === b)); });
}
// Settings → Job numbers: prefix ("J-", or blank for plain numbers), where new numbers continue from, and taking the
// old "J-" off existing jobs (skipping any that would collide with a job already using the plain number).
async function jobNumberSetup(el) {
  const d = await GET('/settings/job-numbers');
  el.innerHTML = `<form id="jnf"><div class="form-grid">
      ${fieldHtml({ name: 'job_number_prefix', label: 'Prefix (blank = plain numbers like 5816)', placeholder: 'none' }, d.prefix)}
      ${fieldHtml({ name: 'job_number_next', label: 'Next job number (optional)', type: 'number', placeholder: 'e.g. 5816' }, d.next_floor)}
    </div><p class="small" style="margin:8px 0">Next new job will be <b>${esc(d.next)}</b>. With <b>Next job number</b> set, new jobs count up from exactly that number, even if it's lower than jobs you already have, skipping any number already in use. Leave it blank to carry on after the highest job numbered this way. Admins can still change any job's number on the job (Job #).</p>
    <div class="row"><button class="btn primary">Save</button>${d.with_j_prefix && d.prefix !== 'J-' ? `<button type="button" class="btn" id="stripj">Remove "J-" from ${d.with_j_prefix.toLocaleString()} existing job${d.with_j_prefix === 1 ? '' : 's'}…</button>` : ''}</div></form>`;
  $('#jnf', el).onsubmit = async e => { e.preventDefault(); const f = e.target;
    const prefix = f.job_number_prefix.value.trim();
    if (prefix.length > 10 || /[^A-Za-z0-9 ._\/#-]/.test(prefix)) return toast('Prefixes use letters, numbers and - . _ / # (10 characters at most)', true);
    await act(() => PUT('/settings', { job_number_prefix: prefix, job_number_next: f.job_number_next.value || '' }), 'Job numbering saved').catch(() => null); jobNumberSetup(el); };
  if ($('#stripj', el)) $('#stripj', el).onclick = async () => {
    const plan = await POST('/jobs/remove-prefix', { prefix: 'J-', dry_run: true });
    const msg = `Change ${plan.would_change.toLocaleString()} job number(s) from "J-1234" to "1234"?` + (plan.clashes.length ? `\n\n${plan.clashes.length} will be skipped because a job already uses the plain number (e.g. ${plan.clashes.slice(0, 3).map(c => `${c.from} → ${c.to} is taken by ${c.taken_by}`).join('; ')}).` : '') + '\n\nEach job keeps a note of its old number.';
    if (!confirm(msg)) return;
    const r = await act(() => POST('/jobs/remove-prefix', { prefix: 'J-' }), null).catch(() => null);
    if (r) toast(`${r.changed.toLocaleString()} job(s) renumbered${r.skipped.length ? ` · ${r.skipped.length} skipped (number taken)` : ''} · next new job ${r.next}`);
    jobNumberSetup(el);
  };
}
// Settings → Email: pick the provider, enter the account, send a test. The password is stored as a secret on the server
// and never sent back to the browser. A server with SMTP_* environment variables uses those instead (shown, not editable).
const MAIL_PRESETS = [
  ['postmark', 'Postmark (recommended)', 'smtp.postmarkapp.com', 2525, 'starttls', 'Username and password are both your Postmark Server API Token. Verify your domain (or the From address) in Postmark first.'],
  ['twilio', 'Twilio Email (API key SK…)', 'comms.twilio.com', 443, 'ssl', 'For the Email product in the new Twilio Console. Sends over normal HTTPS, so hosting mail-port blocks don\'t matter. Twilio Console → API keys & tokens → Create API key (Standard, or Restricted with Emails → Create ticked — permission twilio/comms/emails/create). Username = the key\'s SID (starts with SK); Password = the key\'s Secret (shown only once, when the key is made — not the Auth Token). First authenticate your domain under Email → Domains, or Twilio refuses the From address. Twilio\'s API can\'t set Reply-To, so each message says where to reply.'],
  ['sendgrid', 'SendGrid SMTP (SG. key)', 'smtp.sendgrid.net', 2525, 'starttls', 'For accounts in the SendGrid app (app.sendgrid.com). Username is the word apikey (literally); password is a key starting with SG., made at app.sendgrid.com → Settings → API Keys with Mail Send access. An SK key from the Twilio Console doesn\'t work here — use "Twilio Email (API key SK…)" for that. Authenticate your domain first (Sender Authentication).'],
  ['brevo', 'Brevo', 'smtp-relay.brevo.com', 2525, 'starttls', 'Username and SMTP key are under Brevo → SMTP & API. Verify your domain or sender in Brevo.'],
  ['ses', 'Amazon SES', 'email-smtp.us-west-2.amazonaws.com', 2587, 'starttls', 'Use SES SMTP credentials (not your AWS login) and the server for your SES region. Verify your domain in SES.'],
  ['google', 'Google Workspace / Gmail', 'smtp.gmail.com', 587, 'starttls', 'Username is the full Google address; password is an App Password (Google Account → Security → 2-Step Verification → App passwords). Note: some hosts, DigitalOcean included, block port 587.'],
  ['m365', 'Microsoft 365', 'smtp.office365.com', 587, 'starttls', 'Microsoft has been turning off password sign-in for SMTP, so a mailbox password usually no longer works. If your business email is Microsoft 365, use Postmark/SendGrid/Brevo with your domain instead.'],
  ['other', 'Other SMTP server', '', 587, 'starttls', 'Use the server, port and sign-in your email provider gives for "SMTP".'],
];
async function emailSetup(el) {
  const outbox = await GET('/outbox');
  const recent = `<h3 style="margin-top:14px">Recent messages</h3>${table([{ label: 'When', get: o => fmtDT(o.created_at) }, { label: 'To', key: 'to_email' }, { label: 'Subject', key: 'subject' },
    { label: 'Status', html: o => `${pill(o.status)}${o.error ? `<div class="small" style="color:var(--bad);max-width:320px">${esc(o.error)}</div>` : ''}` }], outbox.slice(0, 15), { empty: 'Nothing sent yet' })}`;
  if (!isAdmin()) { el.innerHTML = `<p class="small muted">An admin sets up email sending here.</p>${recent}`; return; }
  const e = await GET('/settings/email');
  const status = e.configured ? `<div class="alert ${e.last_test && !e.last_test.ok ? '' : 'info'}"><b>Email is set up</b>${e.source === 'server' ? ' on the server (environment variables)' : ''} — sending from ${esc(e.from || '')}.
      ${e.last_test ? `<br><span class="small">Last test ${fmtDT(e.last_test.at)} to ${esc(e.last_test.to)}: ${e.last_test.ok ? '<b style="color:var(--good)">worked</b>' : `<b style="color:var(--bad)">failed</b> — ${esc(e.last_test.error || '')}`}</span>` : '<br><span class="small">Not tested yet — send a test below.</span>'}</div>`
    : '<div class="alert">Email isn\'t set up yet. Until it is, "Send" on estimates, invoices, reports and appointment confirmations records the message and copies the link or text for you to send yourself.</div>';
  const guess = MAIL_PRESETS.find(p => p[2] && p[2] === e.host) ? MAIL_PRESETS.find(p => p[2] === e.host)[0] : e.host ? 'other' : 'postmark';
  el.innerHTML = `${status}
    ${e.server_env ? `<p class="small">This server sets <code>SMTP_HOST</code> (${esc(e.env.host)}:${esc(e.env.port)}), which takes priority over the form below. Remove the <code>SMTP_</code> lines from <code>/etc/fieldops/fieldops.env</code> to manage email here instead.</p>` : ''}
    <form id="mailf"><div class="form-grid">
      ${fieldHtml({ name: 'preset', label: 'Email provider', type: 'select', options: MAIL_PRESETS.map(p => [p[0], p[1]]), blank: false, full: true }, guess)}
      <p class="small muted full" id="mailhint" style="margin:0"></p>
      ${fieldHtml({ name: 'host', label: 'SMTP server' }, e.host)}${fieldHtml({ name: 'port', label: 'Port', type: 'number' }, e.port || '')}
      ${fieldHtml({ name: 'security', label: 'Secure connection', type: 'select', options: [['starttls', 'STARTTLS (ports 587, 2525, 2587)'], ['ssl', 'SSL/TLS (port 465)'], ['none', 'None (not recommended)']], blank: false }, e.security || 'starttls')}
      ${fieldHtml({ name: 'user', label: 'Username' }, e.user)}
      ${fieldHtml({ name: 'pass', label: e.pass_set ? 'Password / API key (saved — leave blank to keep)' : 'Password / API key', type: 'password' }, '')}
      ${fieldHtml({ name: 'from_email', label: 'Send from address', type: 'email', placeholder: 'e.g. noreply@yourcompany.com' }, e.from_email)}
      ${fieldHtml({ name: 'from_name', label: 'Send from name', placeholder: S.settings.company_name || '' }, e.from_name)}
    </div>
    <div class="row" style="margin-top:12px;flex-wrap:wrap;gap:8px"><button class="btn primary">Save</button>
      <input name="test_to" type="email" placeholder="Send a test to…" value="${esc(S.user.email || '')}" style="width:auto;min-width:220px"><button type="button" class="btn" id="mailtest">Send test email</button>
      ${e.configured && e.source === 'settings' ? '<button type="button" class="btn danger sm" id="mailoff">Turn off</button>' : ''}</div>
    ${e.reply_to ? `<p class="small" style="margin-top:8px">↩ Customer replies go to <b>${esc(e.reply_to)}</b> (the company email above), whatever the send-from address is — so a no-reply address is fine.</p>`
      : '<div class="alert" style="margin-top:8px"><b>Replies have nowhere to go.</b> Set the company <b>Email</b> above — customer replies are sent there. Without it, a reply to a no-reply address is lost.</div>'}
    <p class="small muted" style="margin-top:8px">The test uses what's in the form, saved or not. For mail to land in inboxes rather than spam, the provider will ask you to add a few DNS records (SPF/DKIM) for your domain — they show you exactly which.</p></form>
    ${recent}`;
  const f = $('#mailf', el);
  const hint = () => { const p = MAIL_PRESETS.find(x => x[0] === f.preset.value), tw = p[0] === 'twilio'; $('#mailhint', el).textContent = p[5];
    f.user.placeholder = tw ? 'API key SID — SK…' : ''; f.pass.placeholder = tw ? 'API key secret' : '';
    for (const n of ['port', 'security']) { const w = f[n].closest('label, .field') || f[n].parentElement; if (w && w !== f) w.style.display = tw ? 'none' : ''; } };
  f.preset.onchange = () => { const p = MAIL_PRESETS.find(x => x[0] === f.preset.value); if (p[2]) f.host.value = p[2]; f.port.value = p[3]; f.security.value = p[4];
    if (p[0] === 'sendgrid' && !f.user.value) f.user.value = 'apikey';
    if (p[0] === 'twilio' && f.user.value === 'apikey') f.user.value = '';
    hint(); };
  hint();
  if (!e.host) f.preset.onchange();
  const vals = () => ({ host: f.host.value.trim(), port: f.port.value, security: f.security.value, user: f.user.value.trim(), pass: f.pass.value, from_email: f.from_email.value.trim(), from_name: f.from_name.value.trim() });
  f.onsubmit = async ev => { ev.preventDefault(); const v = vals();
    if (!v.host) return toast('Enter the SMTP server', true);
    await act(() => PUT('/settings', { smtp_host: v.host, smtp_port: v.port, smtp_security: v.security, smtp_user: v.user, smtp_pass: v.pass, smtp_from_email: v.from_email, smtp_from_name: v.from_name }), 'Email settings saved').catch(() => null);
    emailSetup(el); };
  $('#mailtest', el).onclick = async () => {
    const to = f.test_to.value.trim(); if (!to) return toast('Enter an address for the test', true);
    const b = $('#mailtest', el); b.disabled = true; b.textContent = 'Sending…';
    try { const r = await POST('/settings/email-test', { to, ...vals() });
      if (r.ok) toast(`Test sent to ${to} from ${r.from}${r.reply_to ? ` (replies → ${r.reply_to})` : ''} — check the inbox (and spam)`); else toast(r.error, true);
    } catch (err) { toast(err.message, true); }
    emailSetup(el); };
  if ($('#mailoff', el)) $('#mailoff', el).onclick = async () => { if (!confirm('Turn off email sending? Sends will be recorded and copied for you instead.')) return;
    await act(() => PUT('/settings', { smtp_host: '', smtp_pass_clear: '1' }), 'Email turned off').catch(() => null); emailSetup(el); };
}
// Settings → Email templates: the wording of customer emails. Plain text with {placeholders}; the HTML version is drawn
// from it (Label: value lines become a list, a line ending in the link becomes a button). Preview uses sample data.
async function emailTemplates(el) {
  const list = await GET('/email-templates');
  el.innerHTML = `<p class="small muted">The wording customers get. Each email can still be changed in the Send window before it goes.</p>
    ${table([{ label: 'Email', html: t => `<b>${esc(t.label)}</b><div class="small muted">${esc(t.when)}</div>` }, { label: 'Subject', key: 'subject' },
      { label: '', html: t => t.customized ? pill('customized') : '<span class="small muted">default</span>' }], list, { onClick: t => editEmailTemplate(t, () => emailTemplates(el)) })}`;
}
function editEmailTemplate(t, done) {
  const chips = t.placeholders.map(p => `<button type="button" class="btn sm" data-ph="${esc(p.key)}" title="${esc(p.desc)}">{${esc(p.key)}}</button>`).join(' ');
  const m = modal(`<form><h2>${esc(t.label)} email</h2>
    <div class="form-grid">${fieldHtml({ name: 'subject', label: 'Subject', full: true, required: true }, t.subject)}${fieldHtml({ name: 'body', label: 'Message', type: 'textarea', full: true, required: true }, t.body)}</div>
    <p class="small muted" style="margin:6px 0">Click a placeholder to insert it at the cursor (hover for what it is). A line whose placeholder has nothing to fill it is left out.
      Blank line = new paragraph. "Label: value" lines show as a list; a line ending in {link} becomes a button.${t.note ? ` ${esc(t.note)}` : ''}</p>
    <div class="row" style="flex-wrap:wrap;gap:4px">${chips}</div>
    <h3 style="margin-top:14px">Preview <span class="small muted">(sample customer)</span></h3>
    <div class="small" id="tp-subj" style="margin-bottom:6px"></div><div class="small" id="tp-warn" style="color:var(--bad)"></div>
    <iframe id="tp-frame" sandbox="" title="Email preview" style="width:100%;height:340px;border:1px solid var(--border);border-radius:8px;background:#fff"></iframe>
    <div class="actions"><button type="button" class="btn" data-x>Cancel</button>${t.customized ? '<button type="button" class="btn" id="tp-reset">Back to default</button>' : ''}<button class="btn primary">Save</button></div></form>`, { wide: true });
  const f = $('form', m.el), ta = f.body; ta.rows = 14;
  let last = ta;
  f.subject.onfocus = () => { last = f.subject; }; ta.onfocus = () => { last = ta; };
  let timer = null;
  const preview = () => { clearTimeout(timer); timer = setTimeout(async () => {
    try { const r = await POST(`/email-templates/${t.type}/preview`, { subject: f.subject.value, body: ta.value });
      $('#tp-subj', f).innerHTML = `<b>Subject:</b> ${esc(r.subject)}`;
      $('#tp-warn', f).textContent = r.unknown.length ? `Not a placeholder for this email: ${r.unknown.map(k => `{${k}}`).join(', ')}` : '';
      $('#tp-frame', f).srcdoc = `<!doctype html><meta charset="utf-8"><body style="margin:14px">${r.html}</body>`;
    } catch (e) { $('#tp-warn', f).textContent = e.message; } }, 250); };
  $$('[data-ph]', f).forEach(b => b.onclick = () => {
    const el = last, ins = `{${b.dataset.ph}}`, a = el.selectionStart ?? el.value.length, z = el.selectionEnd ?? a;
    el.value = el.value.slice(0, a) + ins + el.value.slice(z); el.focus(); el.selectionStart = el.selectionEnd = a + ins.length; preview(); });
  f.subject.oninput = preview; ta.oninput = preview; preview();
  $('[data-x]', f).onclick = m.close;
  if ($('#tp-reset', f)) $('#tp-reset', f).onclick = async () => {
    if (!confirm('Go back to the built-in wording for this email?')) return;
    await act(() => PUT(`/email-templates/${t.type}`, { subject: '', body: '' }), 'Back to the default wording').catch(() => null); m.close(); done(); };
  f.onsubmit = async e => { e.preventDefault();
    const r = await act(() => PUT(`/email-templates/${t.type}`, { subject: f.subject.value, body: ta.value }), 'Email template saved').catch(() => null);
    if (r) { m.close(); done(); } };
}
// Dark is the company default (matches the black brand). Each person can pick Light or Match device.
const themePref = () => { try { return localStorage.getItem('fo_theme') || 'dark'; } catch { return 'dark'; } };
function applyTheme() { const t = themePref(); if (t === 'system') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t === 'light' ? 'light' : 'dark'; }

applyTheme();
// boot() runs from ext.js once all views are defined

// ------------------------------------------------------------ payroll export (Reports → Payroll)
// Admins always; office staff and managers only when "Payroll export" is switched on for them under Team.
async function payrollExportCard(el, period) {
  const info = await GET('/payroll-export');
  const p = period || { from: info.from, to: info.to };
  const addD = (d, n) => { const x = new Date(d + 'T12:00:00'); x.setDate(x.getDate() + n); return x.toISOString().slice(0, 10); };
  const wk = addD(info.to, -6);
  const presets = [["Last week", wk, info.to], ["Last 2 weeks", addD(wk, -7), info.to], ["This week", addD(wk, 7), addD(info.to, 7)]];
  el.innerHTML = `<div class="card no-print" style="margin-bottom:14px"><div class="row spread"><h2>Payroll export</h2></div>
    <p class="small muted">Hours, rates and gross pay for one pay period, as a CSV for your payroll provider or bookkeeper. Periods run ${weekLabel()} (Settings → Company) so overtime is figured per workweek. Every download is logged below.</p>
    <form id="pxf" class="row" style="flex-wrap:wrap"><input type="date" name="from" value="${p.from}" style="width:auto"> to <input type="date" name="to" value="${p.to}" style="width:auto">
      ${presets.map(([l, f, t]) => `<button type="button" class="btn sm" data-pxp="${f}|${t}">${l}</button>`).join('')}
      <select name="layout" style="width:auto">${Object.entries(info.layouts).map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join('')}</select>
      <button class="btn">Preview</button><button type="button" class="btn primary" id="pxdl">⬇ Download CSV</button></form>
    <div id="pxprev" style="margin-top:12px"></div>
    ${info.history.length ? `<h3 style="margin-top:14px">Recent exports</h3>${table([{ label: 'When', get: h => fmtDT(h.created_at) }, { label: 'By', get: h => h.user_name || '' }, { label: 'Period', get: h => `${fmtDate(h.period_start)} – ${fmtDate(h.period_end)}` },
      { label: 'Layout', get: h => info.layouts[h.layout] || h.layout }, { label: 'People', num: 1, key: 'employees' }, { label: 'Hours', num: 1, get: h => num(h.total_hours) }, { label: 'Gross', num: 1, get: h => money(h.total_gross) },
      { label: '', html: h => h.warnings ? `<span class="pill warn">${h.warnings} warning${h.warnings === 1 ? '' : 's'}</span>` : '' }], info.history.slice(0, 8))}` : ''}</div>`;
  const f = $('#pxf', el);
  $$('[data-pxp]', el).forEach(b => b.onclick = () => { const [a, z] = b.dataset.pxp.split('|'); f.from.value = a; f.to.value = z; preview(); });
  async function preview() {
    const box = $('#pxprev', el);
    try {
      const r = await GET('/payroll-export/preview' + qs({ from: f.from.value, to: f.to.value }));
      box.innerHTML = `${r.warnings.length ? `<div class="alert" style="margin-bottom:10px">${r.warnings.map(w => `⚠ ${esc(w)}`).join('<br>')}</div>` : ''}
        ${table([{ label: 'Employee', html: x => `${esc(x.name)}${x.employee_id ? ` <span class="muted small">#${esc(x.employee_id)}</span>` : ''}` }, { label: 'Regular', num: 1, get: x => num(x.regular_hours) },
          { label: 'Overtime', num: 1, html: x => x.overtime_hours ? `<span class="pill warn">${num(x.overtime_hours)}</span>` : '0' }, { label: 'PTO', num: 1, get: x => num(x.pto_hours) },
          { label: 'Rate', num: 1, get: x => x.pay_type === 'Salary' ? `Salary ${money(x.salary_per_week)}/wk` : money(x.hourly_rate) }, { label: 'Gross pay', num: 1, get: x => money(x.gross_pay) }], r.summary,
          { empty: 'No closed time entries in this period', foot: ['Total', { v: num(r.summary.reduce((a, x) => a + x.regular_hours, 0)), num: 1 }, { v: num(r.summary.reduce((a, x) => a + x.overtime_hours, 0)), num: 1 },
            { v: num(r.summary.reduce((a, x) => a + x.pto_hours, 0)), num: 1 }, '', { v: money(r.total_gross), num: 1 }] })}
        <p class="small muted">Overtime after ${num(r.overtime_after)} hrs/week at ${r.overtime_multiplier}× for hourly staff; salaried staff get yearly salary ÷ 52 each week, no overtime (their hours are shown for reference). Weeks start ${esc(r.week_starts)}, days counted in ${esc(r.timezone)}. Gross is before taxes and deductions.</p>`;
    } catch (e) { box.innerHTML = `<div class="alert">${esc(e.message)}</div>`; }
  }
  f.onsubmit = e => { e.preventDefault(); preview(); };
  $('#pxdl', el).onclick = async () => {
    try {
      const res = await fetch('/api/payroll-export/csv' + qs({ from: f.from.value, to: f.to.value, layout: f.layout.value }), { headers: { Authorization: 'Bearer ' + S.token } });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Download failed (${res.status})`);
      const name = (/filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') || '') || [])[1] || 'payroll.csv';
      const a = document.createElement('a'); a.href = URL.createObjectURL(await res.blob()); a.download = name; a.click();
      toast('Payroll export downloaded'); payrollExportCard(el, { from: f.from.value, to: f.to.value });
    } catch (e) { toast(e.message, true); }
  };
  preview();
}
