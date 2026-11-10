'use strict';
/* A commercial project laid out like the A4YE job tracker workbook (A4YE_Job_TEMPLATE.xlsx).
 * Sheets, in the workbook's order: Dashboard · Cost Codes · Labor Log · Cost Log · Change Orders · SOV · Billing Entry ·
 * Pay Apps · Pay App (G702/G703) · RFI-Submittal · Safety-Quality · Milestones · Daily Logs. */
const WB_SHEETS = [
  ['dashboard', 'Dashboard'], ['codes', 'Cost Codes'], ['labor', 'Labor Log'], ['cost', 'Cost Log', 'cost'], ['co', 'Change Orders', 'office'],
  ['sov', 'SOV', 'bill'], ['billing', 'Billing Entry', 'bill'], ['payapps', 'Pay Apps', 'bill'], ['g702', 'Pay App (G702/G703)', 'bill'],
  ['rfi', 'RFI-Submittal'], ['safety', 'Safety-Quality'], ['milestones', 'Milestones'], ['logs', 'Daily Logs'],
];
const wbDate = d => d ? fmtDate(String(d).slice(0, 10)) : '—';
const statusPill = (st) => { const tone = { Approved: 'good', Paid: 'good', Complete: 'good', Closed: 'good', 'On Track': 'good', Answered: 'good', 'Approved as Noted': 'good',
  Submitted: 'info', Open: 'info', Pending: 'warn', Draft: '', 'At Risk': 'warn', 'Short Paid': 'warn', Overdue: 'bad', Late: 'bad', Rejected: 'bad', Void: 'bad', Disputed: 'bad', 'Revise & Resubmit': 'warn' }[st] ?? '';
  return `<span class="pill ${tone}">${esc(st || '—')}</span>`; };

async function projectTab(j, T) {
  const { params } = hashParams();
  const okSheet = ([, , need]) => !need || (need === 'office' && isOffice()) || (need === 'cost' && isOffice() && can('see_costs')) || (need === 'bill' && isOffice() && can('invoices') && j.billing_type === 'fixed');
  const sheets = WB_SHEETS.filter(okSheet);
  const sheet = sheets.some(([k]) => k === params.get('sheet')) ? params.get('sheet') : 'dashboard';
  T.innerHTML = `<div class="wb-tabs no-print">${sheets.map(([k, l]) => `<a href="#/jobs/${j.id}?tab=project&sheet=${k}" class="${k === sheet ? 'on' : ''}">${l}</a>`).join('')}</div><div id="wbs"></div>`;
  const W = $('#wbs', T);
  if (['dashboard', 'codes', 'logs'].includes(sheet)) return projectCoreSheet(j, W, sheet);
  return ({ labor: wbLabor, cost: wbCost, co: wbChangeOrders, sov: wbSov, billing: wbBilling, payapps: wbPayApps, g702: wbG702, rfi: wbRfi, safety: wbSafety, milestones: wbMilestones })[sheet](j, W);
}

// ------------------------------------------------------------ Labor Log / Cost Log
async function wbLabor(j, W) {
  const d = await GET(`/projects/${j.id}/labor-log`), seeCost = can('see_costs');
  const cols = [{ label: 'Week ending', get: r => wbDate(r.week_ending), csv: r => r.week_ending }, { label: 'Employee', html: r => `${esc(r.employee)}${r.class ? `<div class="small muted">${esc(r.class)}</div>` : ''}`, csv: r => r.employee },
    { label: 'Date', get: r => wbDate(r.date), csv: r => r.date }, { label: 'Start', get: r => fmtTime(r.start), csv: r => r.start }, { label: 'End', get: r => r.end ? fmtTime(r.end) : 'on the clock', csv: r => r.end || '' },
    { label: 'Hours', num: 1, get: r => num(r.hours), csv: r => r.hours }, { label: 'Cost code', html: r => r.cost_code ? `<b>${esc(r.cost_code)}</b> ${esc(r.cost_code_name || '')}` : '<span class="muted">—</span>', csv: r => r.cost_code || '' },
    { label: 'Note', key: 'note' }, { label: 'Source', key: 'source' }, ...(seeCost ? [{ label: 'Labor $', num: 1, get: r => money0(r.labor_cost), csv: r => r.labor_cost }] : [])];
  W.innerHTML = `<div class="card"><div class="row spread"><h2>Labor Log</h2><button class="btn sm" id="wcsv">CSV</button></div>
    <p class="small muted">Every punch on this project, from the A4Y Time Clock sync and the Field Ops clock. ${num(d.totals.hours)} hours${seeCost ? ` · ${money0(d.totals.labor_cost)} labor (loaded)` : ''}.</p>
    ${table(cols, d.rows, { empty: 'No time on this project yet' })}</div>`;
  $('#wcsv', W).onclick = () => toCSV(cols, d.rows, `${j.number}_labor_log.csv`);
}
async function wbCost(j, W) {
  const d = await GET(`/projects/${j.id}/cost-log`);
  const cols = [{ label: 'Date', get: r => wbDate(r.date), csv: r => r.date }, { label: 'Cost code', key: 'cost_code' }, { label: 'Type', key: 'type' }, { label: 'Vendor / Sub', key: 'vendor' },
    { label: 'PO / Invoice #', key: 'ref' }, { label: 'Description', key: 'description' }, { label: 'Status', html: r => statusPill(r.status), csv: r => r.status },
    { label: 'Committed $', num: 1, get: r => r.committed_cost == null ? '' : money(r.committed_cost), csv: r => r.committed_cost ?? '' },
    { label: 'Total cost $', num: 1, get: r => money(r.total_cost), csv: r => r.total_cost }, { label: 'Open commit $', num: 1, get: r => r.open_commit ? money(r.open_commit) : '', csv: r => r.open_commit }];
  W.innerHTML = `<div class="card"><div class="row spread"><h2>Cost Log</h2><button class="btn sm" id="wcsv">CSV</button></div>
    <p class="small muted">Material, subcontract, equipment and other costs: purchase orders (committed until received), material used, expenses and vendor bills. Type: M material · S sub · E equipment · O other.</p>
    <div class="grid g4" style="margin-bottom:12px">${kpi('Total cost', money0(d.totals.total_cost))}${kpi('Open commitments', money0(d.totals.open_commit), 'POs not yet received')}${kpi('Committed (POs)', money0(d.totals.committed_cost))}${kpi('Entries', d.rows.length)}</div>
    ${table(cols, d.rows, { empty: 'No costs logged yet' })}</div>`;
  $('#wcsv', W).onclick = () => toCSV(cols, d.rows, `${j.number}_cost_log.csv`);
}

// ------------------------------------------------------------ Change Orders
async function wbChangeOrders(j, W) {
  const d = await GET(`/projects/${j.id}/change-orders`), edit = can('estimates'), seeCost = can('see_costs');
  W.innerHTML = `<div class="card"><div class="row spread"><h2>Change Orders</h2>${edit ? '<button class="btn primary sm" id="newco">+ Change order</button>' : ''}</div>
    <p class="small muted">Priced the way the workbook does: labor hours × blended rate + material (+${d.defaults.tax_pct}% tax) + equipment + sub + other, then ${d.defaults.oh_pct}% overhead and ${d.defaults.profit_pct}% profit. Approved COs add to the contract and get their own SOV line.</p>
    <div class="grid g4" style="margin-bottom:12px">${kpi('Approved', money0(d.totals.approved), 'in the contract')}${kpi('Pending exposure', money0(d.totals.pending), 'draft, pending or submitted')}${kpi('Change orders', d.rows.length)}${kpi('Blended labor rate', seeCost ? money(d.defaults.labor_rate) + '/h' : '—')}</div>
    ${table([{ label: 'CO #', html: r => `<b>${r.co_no}</b><div class="small muted">${esc(r.number)}</div>` }, { label: 'Initiated', get: r => wbDate(r.date_initiated) }, { label: 'Description', key: 'description' },
      { label: 'Type', html: r => edit ? `<select data-cot="${r.id}" style="width:auto"><option value="">—</option>${d.lists.co_type.map(t => `<option ${t === r.type ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>` : esc(r.type || '—') },
      { label: 'Status', html: r => edit ? `<select data-cos="${r.id}" style="width:auto">${d.lists.co_status.map(t => `<option ${t === r.status ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>` : statusPill(r.status) },
      { label: 'Code', get: r => r.cost_code || '—' }, { label: 'Labor hrs', num: 1, get: r => r.labor_hrs ? num(r.labor_hrs) : '' },
      ...(seeCost ? [{ label: 'Total cost', num: 1, get: r => money(r.total_cost) }] : []), { label: 'Sell price', num: 1, get: r => money(r.sell_price) },
      ...(seeCost ? [{ label: 'Margin', num: 1, html: r => r.margin_pct == null ? '' : `${money0(r.margin)}<div class="small muted">${pct(r.margin_pct)}</div>` }] : []),
      { label: 'Days added', num: 1, get: r => r.days_added ?? '' }, { label: 'Submitted', get: r => wbDate(r.submitted) }, { label: 'Approved', get: r => wbDate(r.approved) },
      { label: 'Days open', num: 1, html: r => r.days_open == null ? '' : r.days_open > 14 ? `<span class="pill warn">${r.days_open}</span>` : r.days_open }, { label: 'Ref (RFI/PCO)', key: 'reference' },
      { label: '', html: r => `<a class="btn sm" href="#/estimates/${r.id}">Open</a>` }], d.rows, { empty: 'No change orders yet' })}</div>`;
  $$('[data-cos]', W).forEach(sel => sel.onchange = async () => {
    if (sel.value === 'Approved' && !confirm('Approve this change order? It adds to the contract value.')) return route();
    await act(() => PUT(`/change-orders/${sel.dataset.cos}`, { status: sel.value }), `CO ${sel.value.toLowerCase()}`); route();
  });
  $$('[data-cot]', W).forEach(sel => sel.onchange = () => act(() => PUT(`/change-orders/${sel.dataset.cot}`, { type: sel.value }), 'Saved'));
  if ($('#newco', W)) $('#newco', W).onclick = () => {
    const f = d.defaults;
    const m = formModal({ title: `New change order — ${j.number}`, wide: true, okLabel: 'Create change order',
      fields: [{ name: 'description', label: 'Description', required: true, full: true }, { name: 'type', label: 'Type', type: 'select', options: d.lists.co_type },
        { name: 'cost_code_id', label: 'Cost code', type: 'select', options: ccOptions() }, { name: 'labor_hrs', label: 'Labor hours', type: 'number' },
        { name: 'material', label: 'Material $', type: 'number' }, { name: 'equipment', label: 'Equipment $', type: 'number' }, { name: 'sub', label: 'Subcontract $', type: 'number' },
        { name: 'other', label: 'Other $', type: 'number' }, { name: 'oh_pct', label: 'Overhead %', type: 'number', default: f.oh_pct }, { name: 'profit_pct', label: 'Profit %', type: 'number', default: f.profit_pct },
        { name: 'days_added', label: 'Days added to schedule', type: 'number' }, { name: 'reference', label: 'Reference (RFI / PCO #)' }, { name: 'notes', label: 'Notes', type: 'textarea', full: true }],
      extra: '<div class="alert info" id="copreview" style="margin-top:10px">Enter hours and costs to see the price.</div>',
      submit: async v => { const r = await POST(`/projects/${j.id}/change-orders`, v); toast(`Change order created: ${money(r.sell_price)}`); route(); } });
    const form = $('form', m.el), pv = $('#copreview', m.el);
    const calc = () => { const g = k => Number(form.elements[k].value) || 0;
      const cost = g('labor_hrs') * f.labor_rate + g('material') * (1 + f.tax_pct / 100) + g('equipment') + g('sub') + g('other'), sell = cost * (1 + g('oh_pct') / 100) * (1 + g('profit_pct') / 100);
      pv.innerHTML = cost ? `Cost <b>${money(cost)}</b> → sell <b>${money(sell)}</b> (margin ${money(sell - cost)}, ${pct((sell - cost) / sell * 100)})` : 'Enter hours and costs to see the price.'; };
    form.addEventListener('input', calc);
  };
}

// ------------------------------------------------------------ SOV
async function wbSov(j, W) {
  const d = await GET(`/projects/${j.id}/sov`), seeCost = can('see_costs');
  const L = d.lines, t = d.totals;
  W.innerHTML = `<div class="card"><div class="row spread"><h2>Schedule of Values</h2>
      <form id="sovb" class="row"><label class="small">Mobilization % <input name="mob" type="number" step="0.5" min="0" max="49" value="${d.mobilization_pct}" style="width:80px"></label>
      <button class="btn">${L.length ? 'Refresh suggested values from budget' : 'Build from budget'}</button></form></div>
    <p class="small muted">One mobilization line, one line per cost-code division with budget, and one per approved change order. Suggested values spread the base contract by budgeted cost; type an override to set your own. Billing happens on Billing Entry.</p>
    ${Math.abs(d.variance) >= 0.01 && L.length ? `<div class="alert" style="margin-bottom:10px">Scheduled values total ${money(t.scheduled_value)}, but the contract is ${money(d.contract.total)} (${d.variance > 0 ? 'over' : 'short'} by ${money(Math.abs(d.variance))}). Adjust an override so they match.</div>` : ''}
    <form id="sovf">${table([{ label: '#', key: 'line_no' }, { label: 'Div', get: l => l.division }, { label: 'Description', html: l => `<input data-desc="${l.id}" value="${esc(l.description)}" style="min-width:200px">` },
      { label: 'Calculated SV', num: 1, get: l => money(l.calc_value) }, { label: 'Override', num: 1, html: l => `<input class="n" type="number" step="0.01" data-ov="${l.id}" value="${l.override_value ?? ''}" placeholder="—" style="width:110px">` },
      { label: 'Scheduled value', num: 1, html: l => `<b>${money(l.scheduled_value)}</b>` }, { label: 'Completed & stored', num: 1, get: l => money(l.completed_and_stored) },
      { label: '%', num: 1, html: l => `${pct(l.pct)}${barPct(l.pct)}` }, { label: 'Balance to finish', num: 1, get: l => money(l.balance) },
      ...(seeCost ? [{ label: 'Cost to date', num: 1, get: l => l.division === 'MOB' || l.division === 'CO' ? '' : money(l.cost_to_date) },
        { label: 'Gain / (loss)', num: 1, html: l => l.gain_loss == null ? '' : `<span style="color:var(${l.gain_loss < 0 ? '--bad' : '--good'})">${money(l.gain_loss)}</span>` }] : []),
      { label: '', html: l => l.completed_and_stored ? '' : `<button type="button" class="btn sm danger" data-rm="${l.id}">✕</button>` }], L,
      { empty: 'No SOV yet. Set the mobilization % and build it from the budget.', foot: L.length ? ['', '', 'Total', '', '', { v: money(t.scheduled_value), num: 1 }, { v: money(t.completed_and_stored), num: 1 }, '', { v: money(t.balance), num: 1 }] : null })}
    ${L.length ? `<div class="row" style="margin-top:10px;flex-wrap:wrap"><button class="btn primary">Save SOV</button><input id="newdesc" placeholder="Add a line: description" style="width:240px"><input id="newdiv" placeholder="Div" style="width:70px"><input id="newval" type="number" placeholder="Value" style="width:110px"><button type="button" class="btn" id="addsov">+ Line</button></div>` : ''}</form></div>`;
  $('#sovb', W).onsubmit = async e => { e.preventDefault(); if (L.some(l => l.completed_and_stored) && !confirm('Refresh suggested values? Your overrides are kept.')) return; await act(() => POST(`/projects/${j.id}/sov/build`, { mobilization_pct: e.target.mob.value }), 'SOV updated'); route(); };
  const lines = () => L.map(l => ({ id: l.id, description: $(`[data-desc="${l.id}"]`, W).value, override_value: $(`[data-ov="${l.id}"]`, W).value }));
  if ($('#sovf button.primary', W)) $('#sovf', W).onsubmit = async e => { e.preventDefault(); await act(() => PUT(`/projects/${j.id}/sov`, { lines: lines() }), 'SOV saved'); route(); };
  if ($('#addsov', W)) $('#addsov', W).onclick = async () => { const desc = $('#newdesc', W).value.trim(); if (!desc) return toast('Describe the line', true);
    await act(() => PUT(`/projects/${j.id}/sov`, { lines: lines(), add: [{ description: desc, division: $('#newdiv', W).value || '00', override_value: $('#newval', W).value }] }), 'Line added'); route(); };
  $$('[data-rm]', W).forEach(b => b.onclick = async () => { if (confirm('Remove this SOV line?')) { await act(() => PUT(`/projects/${j.id}/sov`, { remove: [Number(b.dataset.rm)] }), 'Removed'); route(); } });
}

// ------------------------------------------------------------ Billing Entry (work this period by SOV line, per application)
async function wbBilling(j, W) {
  const d = await GET(`/projects/${j.id}/pay-apps`);
  const { params } = hashParams();
  const apps = d.apps, a = apps.find(x => String(x.id) === params.get('app')) || apps[apps.length - 1];
  const L = d.sov.lines;
  if (!L.length) { W.innerHTML = '<div class="card empty">Build the schedule of values first (SOV sheet).</div>'; return; }
  const idx = a ? apps.indexOf(a) : -1;
  const prevWork = id => apps.slice(0, idx).reduce((t, x) => t + ((x.lines.find(l => l.sov_line_id === id) || {}).work_this_period || 0), 0);
  const cur = id => (a && a.lines.find(l => l.sov_line_id === id)) || { work_this_period: 0, stored_balance: 0 };
  W.innerHTML = `<div class="card"><div class="row spread"><h2>Billing Entry${a ? ` — App #${a.app_no}` : ''}</h2>
      <div class="row">${apps.length ? `<select id="appsel" style="width:auto">${apps.map(x => `<option value="${x.id}" ${x === a ? 'selected' : ''}>App #${x.app_no} · to ${wbDate(x.period_to)}${x.locked ? ' (invoiced)' : ''}</option>`).join('')}</select>` : ''}
      <button class="btn primary sm" id="newapp">+ New pay application</button></div></div>
    <p class="small muted">For each SOV line, enter the work completed <b>this period</b> and the materials presently stored (balance at the end of the period). Retainage ${pct(a ? a.retainage_used : d.retainage_pct)}.</p>
    ${!a ? '<div class="empty">No pay applications yet. Start App #1 with its Period To date.</div>' : `<form id="bef">${table([{ label: '#', key: 'line_no' }, { label: 'Div', key: 'division' }, { label: 'Description', key: 'description' },
      { label: 'Scheduled value', num: 1, get: l => money(l.scheduled_value) }, { label: 'From previous apps', num: 1, get: l => money(prevWork(l.id)) },
      { label: 'Work this period', num: 1, html: l => a.locked ? money(cur(l.id).work_this_period) : `<input class="n" type="number" step="0.01" data-w="${l.id}" value="${cur(l.id).work_this_period || ''}" style="width:120px">` },
      { label: 'Stored (end of period)', num: 1, html: l => a.locked ? money(cur(l.id).stored_balance) : `<input class="n" type="number" step="0.01" min="0" data-st="${l.id}" value="${cur(l.id).stored_balance || ''}" style="width:120px">` },
      { label: 'To date + stored', num: 1, html: l => { const tot = prevWork(l.id) + (cur(l.id).work_this_period || 0) + (cur(l.id).stored_balance || 0); return `${money(tot)}${barPct(l.scheduled_value ? tot / l.scheduled_value * 100 : 0)}`; } },
      { label: '', html: l => a.locked ? '' : `<button type="button" class="btn sm" data-fill="${l.id}" title="Bill the rest of this line">Rest</button>` }], L)}
      <div class="grid g4" style="margin-top:12px">${kpi('Work this period', money0(a.work_this_period))}${kpi('Gross this app', money0(a.gross_this_app))}${kpi('Retainage this app', money0(a.retainage_this_app))}${kpi('Net due', money0(a.net_due))}</div>
      ${a.locked ? `<p class="small">On invoice <b>${esc(a.invoice_number)}</b>. Void the invoice to change this application.</p>` : '<div class="row" style="margin-top:10px"><button class="btn primary">Save billing</button></div>'}</form>`}</div>`;
  if ($('#appsel', W)) $('#appsel', W).onchange = e => go(`#/jobs/${j.id}?tab=project&sheet=billing&app=${e.target.value}`);
  $('#newapp', W).onclick = () => formModal({ title: `New pay application — App #${(apps.length ? apps[apps.length - 1].app_no : 0) + 1}`, okLabel: 'Start application',
    fields: [{ name: 'period_to', label: 'Period To', type: 'date', required: true, default: todayStr() }, { name: 'retainage_pct', label: `Retainage % (blank = ${d.retainage_pct}%)`, type: 'number' }],
    submit: async v => { const r = await POST(`/projects/${j.id}/pay-apps`, v); toast('Pay application started'); go(`#/jobs/${j.id}?tab=project&sheet=billing&app=${r.id}`); } });
  $$('[data-fill]', W).forEach(b => b.onclick = () => { const l = L.find(x => x.id === Number(b.dataset.fill)); const st = Number($(`[data-st="${l.id}"]`, W).value) || 0; $(`[data-w="${l.id}"]`, W).value = Math.max(0, Math.round((l.scheduled_value - prevWork(l.id) - st) * 100) / 100); });
  if ($('#bef button.primary', W)) $('#bef', W).onsubmit = async e => { e.preventDefault();
    const lines = L.map(l => ({ sov_line_id: l.id, work_this_period: $(`[data-w="${l.id}"]`, W).value, stored_balance: $(`[data-st="${l.id}"]`, W).value }));
    await act(() => PUT(`/pay-apps/${a.id}`, { lines }), 'Billing saved'); route(); };
}

// ------------------------------------------------------------ Pay Apps (log)
async function wbPayApps(j, W) {
  const d = await GET(`/projects/${j.id}/pay-apps`);
  const A = d.apps, sum = k => A.reduce((t, x) => t + (x[k] || 0), 0), last = A[A.length - 1];
  W.innerHTML = `<div class="card"><div class="row spread"><h2>Pay Applications &amp; Payment Log</h2><a class="btn sm" href="#/jobs/${j.id}?tab=project&sheet=billing">Billing Entry →</a></div>
    <div class="grid g4" style="margin-bottom:12px">${kpi('Contract to date', money0(d.sov.contract.total))}${kpi('Completed & stored', money0(last ? last.completed_and_stored : 0), last ? pct(last.completed_and_stored / (d.sov.contract.total || 1) * 100) + ' of contract' : '')}
      ${kpi('Retainage held', money0(last ? last.retainage_to_date : 0))}${kpi('Open balance', money0(sum('open_balance')), 'net due less paid')}</div>
    ${table([{ label: 'App #', html: a => `<b>${a.app_no}</b>` }, { label: 'Period to', get: a => wbDate(a.period_to) }, { label: 'Ret %', num: 1, get: a => pct(a.retainage_used) },
      { label: 'Work this period', num: 1, get: a => money(a.work_this_period) }, { label: 'Work to date', num: 1, get: a => money(a.work_to_date) }, { label: 'Stored', num: 1, get: a => money(a.stored_balance) },
      { label: 'Completed & stored', num: 1, get: a => money(a.completed_and_stored) }, { label: 'Gross this app', num: 1, get: a => money(a.gross_this_app) },
      { label: 'Retainage to date', num: 1, get: a => money(a.retainage_to_date) }, { label: 'Ret. this app', num: 1, get: a => money(a.retainage_this_app) },
      { label: 'Net due', num: 1, html: a => `<b>${money(a.net_due)}</b>` }, { label: 'Submitted', get: a => wbDate(a.date_submitted) }, { label: 'Paid', get: a => wbDate(a.date_paid) },
      { label: 'Amount paid', num: 1, get: a => money(a.amount_paid) }, { label: 'Days to pay', num: 1, html: a => a.days_to_pay == null ? '' : a.days_to_pay > 45 && a.open_balance > 0 ? `<span class="pill bad">${a.days_to_pay}</span>` : a.days_to_pay },
      { label: 'Open', num: 1, get: a => money(a.open_balance) }, { label: 'Status', html: a => `${statusPill(a.status)}${a.invoice_number ? `<div class="small"><a href="#/invoices/${a.invoice_id}">${esc(a.invoice_number)}</a></div>` : ''}` },
      { label: '', html: a => `<div class="row" style="gap:4px;flex-wrap:nowrap">${!a.locked ? `<button class="btn sm primary" data-inv="${a.id}">Invoice</button>` : ''}<a class="btn sm" href="#/jobs/${j.id}?tab=project&sheet=g702&app=${a.id}">G702</a>${a === last && !a.locked ? `<button class="btn sm danger" data-del="${a.id}">✕</button>` : ''}</div>` }],
      A, { empty: 'No pay applications yet. Start one on Billing Entry.' })}
    <p class="small muted">Invoicing an application creates the invoice (this period's work by SOV line, less retainage) and locks the application. Payments recorded on that invoice show here as paid.</p></div>`;
  $$('[data-inv]', W).forEach(b => b.onclick = async () => { const a = A.find(x => x.id === Number(b.dataset.inv)); if (!confirm(`Create the invoice for App #${a.app_no}: ${money(a.net_due)} net due?`)) return;
    const r = await act(() => POST(`/pay-apps/${a.id}/invoice`), 'Invoice created'); go('#/invoices/' + r.invoice_id); });
  $$('[data-del]', W).forEach(b => b.onclick = async () => { if (confirm('Delete this pay application?')) { await act(() => DEL(`/pay-apps/${b.dataset.del}`), 'Deleted'); route(); } });
}

// ------------------------------------------------------------ Pay App Summary (G702) + Billing Worksheet (G703), printable
async function wbG702(j, W) {
  const d = await GET(`/projects/${j.id}/pay-apps`);
  const { params } = hashParams();
  const a = d.apps.find(x => String(x.id) === params.get('app')) || d.apps[d.apps.length - 1];
  if (!a) { W.innerHTML = '<div class="card empty">No pay applications yet.</div>'; return; }
  const p = await GET(`/pay-apps/${a.id}/print`), g = p.g702;
  const row = (n, l, v, strong) => `<tr><td style="width:36px">${n}</td><td>${l}</td><td class="num">${strong ? `<b>${money(v)}</b>` : money(v)}</td></tr>`;
  W.innerHTML = `<div class="row no-print" style="margin-bottom:10px"><select id="appsel" style="width:auto">${d.apps.map(x => `<option value="${x.id}" ${x === a ? 'selected' : ''}>App #${x.app_no} · to ${wbDate(x.period_to)}</option>`).join('')}</select><button class="btn" onclick="print()">Print</button></div>
    <div class="card g702"><h2 style="text-align:center;margin:0">APPLICATION AND CERTIFICATE FOR PAYMENT</h2>
      <p class="small" style="text-align:center;margin:2px 0 12px">${esc(p.company.name || '')} · ${esc(p.company.address || '')} · ${esc(p.company.phone || '')}${p.company.license ? ` · Lic. ${esc(p.company.license)}` : ''} · AIA G702 format</p>
      <div class="grid g2"><dl class="kv"><dt>To (owner / GC)</dt><dd>${esc(p.project.customer)}</dd><dt>Project</dt><dd>${esc(p.project.number)} ${esc(p.project.title)}</dd><dt>Location</dt><dd>${esc(p.project.address || '—')}</dd></dl>
        <dl class="kv"><dt>Application no.</dt><dd>${p.app.no}</dd><dt>Period to</dt><dd>${wbDate(p.app.period_to)}</dd><dt>Invoice</dt><dd>${esc(p.app.invoice_number || 'not yet invoiced')}</dd></dl></div>
      <table style="margin-top:10px"><tbody>
        ${row(1, 'Original contract sum', g.original_contract)}${row(2, 'Net change by change orders', g.change_orders)}${row(3, 'Contract sum to date (1 + 2)', g.contract_to_date, 1)}
        ${row(4, 'Total completed &amp; stored to date (G703 col. G)', g.completed_and_stored)}${row(5, `Retainage (${pct(p.app.retainage_pct)} of completed work &amp; stored material)`, g.retainage)}
        ${row(6, 'Total earned less retainage (4 − 5)', g.earned_less_retainage)}${row(7, 'Less previous certificates for payment', g.previous_certificates)}
        ${row(8, 'CURRENT PAYMENT DUE (6 − 7)', g.current_due, 1)}${row(9, 'Balance to finish, including retainage (3 − 6)', g.balance_to_finish)}</tbody></table>
      <p class="small" style="margin-top:14px">The undersigned contractor certifies that, to the best of the contractor's knowledge, the work covered by this application has been completed in accordance with the contract documents, and that current payment shown herein is now due.</p>
      <div class="grid g2" style="margin-top:22px"><div>Contractor: ______________________________<br><span class="small">${esc(p.company.name || '')}</span></div><div>Date: ________________</div></div></div>
    <div class="card g703" style="margin-top:14px"><h2 style="margin:0 0 6px">CONTINUATION SHEET (AIA G703 format) — Application ${p.app.no}, period to ${wbDate(p.app.period_to)}</h2>
      ${table([{ label: 'A Item', key: 'item' }, { label: 'B Description', html: l => `${esc(l.division === 'CO' ? '' : l.division + ' ')}${esc(l.description)}` }, { label: 'C Scheduled value', num: 1, get: l => money(l.scheduled_value) },
        { label: 'D From previous', num: 1, get: l => money(l.from_previous) }, { label: 'E This period', num: 1, get: l => money(l.this_period) }, { label: 'F Materials stored', num: 1, get: l => money(l.stored) },
        { label: 'G Completed & stored (D+E+F)', num: 1, get: l => money(l.completed_and_stored) }, { label: 'G ÷ C', num: 1, get: l => pct(l.pct) }, { label: 'H Balance (C−G)', num: 1, get: l => money(l.balance) }, { label: 'I Retainage', num: 1, get: l => money(l.retainage) }],
        p.g703, { foot: ['', 'Totals', ...['scheduled_value', 'from_previous', 'this_period', 'stored', 'completed_and_stored'].map(k => ({ v: money(p.g703.reduce((t, l) => t + l[k], 0)), num: 1 })), '', { v: money(p.g703.reduce((t, l) => t + l.balance, 0)), num: 1 }, { v: money(p.g703.reduce((t, l) => t + l.retainage, 0)), num: 1 }] })}</div>`;
  $('#appsel', W).onchange = e => go(`#/jobs/${j.id}?tab=project&sheet=g702&app=${e.target.value}`);
}

// ------------------------------------------------------------ RFI-Submittal / Safety-Quality / Milestones (log sheets)
async function wbLog(j, W, { kind, title, intro, cols, fields, addLabel, canAdd, canEdit, del = true }) {
  const d = await GET(`/projects/${j.id}/${kind}`);
  W.innerHTML = `<div class="card"><div class="row spread"><h2>${title}</h2><div class="row">${canAdd ? `<button class="btn primary sm" id="logadd">${addLabel}</button>` : ''}<button class="btn sm" id="logcsv">CSV</button></div></div>
    <p class="small muted">${intro}</p>${table(cols(d.lists), d.rows, { empty: 'Nothing logged yet', onClick: r => canEdit(r) && open(r) })}</div>`;
  const F = fields(d.lists);
  const open = (r = {}) => {
    const m = formModal({ title: r.id ? `Edit ${r.ref || r.ref_id || ''}` : addLabel.replace('+ ', ''), values: r, wide: true, fields: F,
      extra: r.id && del && isOffice() ? '<button type="button" class="btn danger sm" id="logdel" style="margin-top:8px">Delete</button>' : '',
      submit: async v => { if (r.id) await PUT(`/${kind}/${r.id}`, v); else await POST(`/projects/${j.id}/${kind}`, v); toast('Saved'); route(); } });
    const x = $('#logdel', m.el); if (x) x.onclick = async () => { if (confirm('Delete this entry?')) { await act(() => DEL(`/${kind}/${r.id}`), 'Deleted'); m.close(); route(); } };
  };
  if ($('#logadd', W)) $('#logadd', W).onclick = () => open({});
  $('#logcsv', W).onclick = () => toCSV(cols(d.lists).map(c => ({ ...c, csv: c.csv || (r => r[c.key] ?? '') })), d.rows, `${j.number}_${kind}.csv`);
}
const wbRfi = (j, W) => wbLog(j, W, { kind: 'rfis', title: 'RFI & Submittal Log', addLabel: '+ RFI / submittal', canAdd: can('projects') && isOffice(), canEdit: () => isOffice() && can('projects'),
  intro: 'One log for questions out and documents in. Days late counts past the date needed until it comes back; overdue items show on the dashboards.',
  cols: () => [{ label: 'ID', html: r => `<b>${esc(r.ref)}</b>`, csv: r => r.ref }, { label: 'Type', key: 'type' }, { label: 'No.', key: 'number' }, { label: 'Subject', key: 'subject' }, { label: 'Spec', key: 'spec_section' },
    { label: 'Code', key: 'cost_code' }, { label: 'Sent', get: r => wbDate(r.date_sent), csv: r => r.date_sent }, { label: 'Needed', get: r => wbDate(r.date_needed), csv: r => r.date_needed }, { label: 'Returned', get: r => wbDate(r.date_returned), csv: r => r.date_returned },
    { label: 'Days open', num: 1, get: r => r.days_open ?? '' }, { label: 'Days late', num: 1, html: r => r.days_late ? `<span class="pill ${r.open ? 'bad' : 'warn'}">${r.days_late}</span>` : '', csv: r => r.days_late ?? '' },
    { label: 'Status', html: r => statusPill(r.overdue ? 'Overdue' : r.status), csv: r => r.status }, { label: 'Ball in court', key: 'ball_in_court' },
    { label: 'Cost $', num: 1, get: r => r.cost_impact ? money0(r.cost_impact) : '', csv: r => r.cost_impact ?? '' }, { label: 'Sched days', num: 1, get: r => r.sched_impact_days ?? '' }, { label: 'CO', key: 'co_number' }],
  fields: L => [{ name: 'type', label: 'Type', type: 'select', options: L.rfi_type, blank: false, default: 'RFI' }, { name: 'number', label: 'No. (GC / architect #)' },
    { name: 'subject', label: 'Subject', required: true, full: true }, { name: 'spec_section', label: 'Spec section' }, { name: 'cost_code_id', label: 'Cost code', type: 'select', options: ccOptions() },
    { name: 'date_sent', label: 'Date sent', type: 'date' }, { name: 'date_needed', label: 'Date needed', type: 'date' }, { name: 'date_returned', label: 'Date returned', type: 'date' },
    { name: 'status', label: 'Status', type: 'select', options: L.doc_status, blank: false, default: 'Open' }, { name: 'ball_in_court', label: 'Ball in court', type: 'select', options: L.ball_in_court },
    { name: 'cost_impact', label: 'Cost impact $', type: 'number' }, { name: 'sched_impact_days', label: 'Schedule impact (days)', type: 'number' }, { name: 'notes', label: 'Notes', type: 'textarea', full: true }] });
const wbSafety = (j, W) => wbLog(j, W, { kind: 'safety', title: 'Safety & Quality Log', addLabel: '+ Safety / quality item', canAdd: isOffice() || can('daily_logs'),
  canEdit: r => isOffice() || r.created_by === S.user.id,
  intro: 'Toolbox talks, inspections, near misses, incidents, QC and punch items. Items past their due date without a closed date show as overdue.',
  cols: () => [{ label: 'ID', html: r => `<b>${esc(r.ref_id)}</b>`, csv: r => r.ref_id }, { label: 'Date', get: r => wbDate(r.date), csv: r => r.date }, { label: 'Type', key: 'type' }, { label: 'Description', key: 'description' },
    { label: 'Severity', html: r => r.severity ? `<span class="pill ${['High', 'Critical'].includes(r.severity) ? 'bad' : r.severity === 'Medium' ? 'warn' : ''}">${esc(r.severity)}</span>` : '', csv: r => r.severity || '' },
    { label: 'Reported by', key: 'reported_by' }, { label: 'Corrective action', key: 'corrective_action' }, { label: 'Owner', key: 'owner' }, { label: 'Due', get: r => wbDate(r.due_date), csv: r => r.due_date },
    { label: 'Closed', get: r => wbDate(r.closed_date), csv: r => r.closed_date }, { label: 'Status', html: r => statusPill(r.status), csv: r => r.status }, { label: 'Recordable', get: r => r.recordable ? 'Yes' : '', csv: r => r.recordable ? 'Yes' : 'No' },
    { label: 'Lost days', num: 1, get: r => r.lost_time_days ?? '' }, { label: 'Days open', num: 1, get: r => r.days_open }],
  fields: L => [{ name: 'date', label: 'Date', type: 'date', required: true, default: todayStr() }, { name: 'type', label: 'Type', type: 'select', options: L.safety_type, required: true },
    { name: 'description', label: 'Description', type: 'textarea', required: true, full: true }, { name: 'severity', label: 'Severity', type: 'select', options: L.severity },
    { name: 'reported_by', label: 'Reported by', default: S.user.name }, { name: 'corrective_action', label: 'Corrective action', type: 'textarea', full: true }, { name: 'owner', label: 'Owner' },
    { name: 'due_date', label: 'Due date', type: 'date' }, { name: 'closed_date', label: 'Closed date', type: 'date' }, { name: 'recordable', label: 'OSHA recordable', type: 'checkbox' },
    { name: 'lost_time_days', label: 'Lost time days', type: 'number' }, { name: 'ref', label: 'Ref / photo' }] });
const wbMilestones = (j, W) => wbLog(j, W, { kind: 'milestones', title: 'Milestones', addLabel: '+ Milestone', canAdd: isOffice() && can('projects'), canEdit: () => isOffice() && can('projects'),
  intro: 'Contract and internal dates. Variance is forecast (or actual) minus baseline. Late = forecast date passed without an actual date; At Risk = forecast later than baseline.',
  cols: () => [{ label: 'ID', html: r => `<b>${esc(r.ref)}</b>`, csv: r => r.ref }, { label: 'Milestone', key: 'name' }, { label: 'Phase', key: 'phase' },
    { label: 'Baseline', get: r => wbDate(r.baseline_date), csv: r => r.baseline_date }, { label: 'Forecast', get: r => wbDate(r.forecast_date), csv: r => r.forecast_date }, { label: 'Actual', get: r => wbDate(r.actual_date), csv: r => r.actual_date },
    { label: 'Variance (days)', num: 1, html: r => r.variance_days == null ? '' : r.variance_days > 0 ? `<span style="color:var(--bad)">+${r.variance_days}</span>` : r.variance_days, csv: r => r.variance_days ?? '' },
    { label: 'Owner', key: 'owner' }, { label: 'Status', html: r => statusPill(r.status), csv: r => r.status }, { label: 'Critical', get: r => r.critical ? 'Yes' : '', csv: r => r.critical ? 'Yes' : 'No' },
    { label: 'Billing', get: r => r.impacts_billing ? 'Yes' : '', csv: r => r.impacts_billing ? 'Yes' : 'No' }, { label: 'Days to go', num: 1, get: r => r.days_to_go ?? '' }],
  fields: L => [{ name: 'name', label: 'Milestone', required: true, full: true }, { name: 'phase', label: 'Phase', type: 'select', options: L.phases },
    { name: 'baseline_date', label: 'Baseline date', type: 'date' }, { name: 'forecast_date', label: 'Forecast date', type: 'date' }, { name: 'actual_date', label: 'Actual date', type: 'date' },
    { name: 'owner', label: 'Owner' }, { name: 'critical', label: 'Critical path', type: 'checkbox' }, { name: 'impacts_billing', label: 'Impacts billing', type: 'checkbox' }, { name: 'notes', label: 'Notes', type: 'textarea', full: true }] });
