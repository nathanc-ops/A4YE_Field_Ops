'use strict';
/* Job billing UI: quoted (fixed-price) vs time & material. */

const BILLING_TYPES = [['tm', 'Time & material'], ['fixed', 'Quoted price']];
const billingPill = t => t === 'fixed' ? '<span class="pill accent">Quoted price</span>' : '<span class="pill info">T&amp;M</span>';
const KIND_LABEL = { deposit: 'Deposit', milestone: 'Milestone', progress: 'Progress', percent: 'Progress', amount: 'Progress', final: 'Final', tm: 'T&M', standard: 'Invoice' };

async function jobBillingTab(j, T) {
  T.innerHTML = '<div class="empty">Loading billing…</div>';
  const through = hashParams().params.get('through') || '';
  const b = await GET(`/jobs/${j.id}/billing` + qs({ through }));
  const invTable = list => table([{ label: 'Invoice', html: i => `<b>${esc(i.number)}</b> <span class="muted small">${esc(KIND_LABEL[i.kind] || i.kind)}</span>` }, { label: 'Date', get: i => fmtDate(i.issue_date) },
    { label: 'Status', html: i => pill(i.status) }, { label: 'Billed', num: 1, get: i => money(i.amount) }, { label: 'Total', num: 1, get: i => money(i.total) }, { label: 'Balance', num: 1, get: i => money(i.balance) }],
  list, { onClick: i => go('#/invoices/' + i.id), empty: 'Nothing billed yet' });
  if (b.billing_type === 'fixed') return fixedBilling(j, T, b, invTable);
  return tmBilling(j, T, b, invTable, through);
}

// ---------------------------------------------------------------- quoted price
function fixedBilling(j, T, b, invTable) {
  const c = b.contract;
  const ou = b.over_under;
  const ouPill = ou == null ? '<span class="muted">Set % complete or a budget</span>' : Math.abs(ou) < 1 ? '<span class="pill good">On track</span>'
    : ou > 0 ? `<span class="pill info">Over-billed ${money0(ou)}</span>` : `<span class="pill warn">Under-billed ${money0(-ou)}</span>`;
  T.innerHTML = `<div class="alert info" style="margin-bottom:14px"><b>Quoted-price job.</b> The customer pays the contract price. Time and materials are tracked for job costing but never billed. Extra work needs a signed change order.</div>
    <div class="grid g4">
      ${kpi('Contract', money0(c.total), c.change_orders ? `${money0(c.base)} quote + ${money0(c.change_orders)} change orders` : 'Quoted price')}
      ${kpi('Billed to date', money0(b.billed_to_date), `${pct(b.billed_pct)} of contract · ${money0(b.collected)} collected`)}
      ${kpi('Left to bill', money0(b.remaining), b.retainage_held ? `+ ${money0(b.retainage_held)} retainage held` : (b.retainage_pct ? `${b.retainage_pct}% retainage on progress bills` : 'No retainage'))}
      ${kpi('Projected profit', money0(b.projected_profit), b.projected_margin_pct != null ? `${pct(b.projected_margin_pct)} margin on ${money0(b.estimated_cost ?? b.cost_to_date)} est. cost` : '')}
    </div>
    <div class="grid g2" style="margin-top:14px">
      <div class="card"><h2>Progress</h2>
        <dl class="kv"><dt>% complete</dt><dd><b>${b.percent_complete != null ? pct(b.percent_complete) : '—'}</b> ${b.percent_source === 'cost' ? '<span class="muted small">(cost to date ÷ budgeted cost)</span>' : b.percent_source === 'entered' ? '<span class="muted small">(entered)</span>' : ''}
            ${b.cost_pct_complete != null && b.percent_source === 'entered' ? `<div class="small muted">Cost-based: ${pct(b.cost_pct_complete)}</div>` : ''}</dd>
          <dt>Earned</dt><dd>${b.earned != null ? money(b.earned) : '—'}</dd><dt>Billed</dt><dd>${money(b.billed_to_date)}</dd><dt>Position</dt><dd>${ouPill}</dd>
          <dt>Cost to date</dt><dd>${money(b.cost_to_date)}${b.estimated_cost ? ` of ${money(b.estimated_cost)} budgeted` : ''}</dd></dl>
        <div class="row" style="margin-top:10px"><input type="number" id="pctc" min="0" max="100" step="1" placeholder="% complete" value="${b.percent_complete ?? ''}" style="width:130px"><button class="btn" id="setpct">Update % complete</button></div>
        <h3 style="margin-top:16px">Bill this job</h3>
        <div class="row">
          <button class="btn" data-bill="deposit">Deposit…</button>
          <button class="btn" data-bill="percent">By % complete…</button>
          <button class="btn" data-bill="amount">Set amount…</button>
          <button class="btn primary" data-bill="final">Final invoice (${money0(b.remaining + b.retainage_held)})</button>
        </div></div>
      <div class="card"><div class="row spread"><h2>Schedule of values</h2>
          <div class="row"><select id="mstpl" style="width:auto"><option value="">Add from template…</option><option value="standard">Deposit 30 / Rough 40 / Final 30</option><option value="half">50 / 50</option><option value="commercial">Commercial (5 phases)</option></select><button class="btn sm" id="addms">+ Milestone</button></div></div>
        ${table([{ label: 'Milestone', key: 'name' }, { label: 'Share', num: 1, get: m => m.amount != null ? 'Fixed' : pct(m.pct) }, { label: 'Value', num: 1, get: m => money(m.value) },
          { label: '', html: m => m.billed ? `<a href="#/invoices/${m.invoice_id}" class="pill good">✓ ${esc(m.invoice_number)}</a>` : `<button class="btn sm primary" data-ms="${m.id}">Bill</button> <button class="btn sm danger" data-delms="${m.id}">✕</button>` }],
        b.milestones, { empty: 'No milestones. Use them for deposit / rough-in / final style billing.' })}
        ${b.milestones.length ? `<p class="small muted">Milestones total ${money(b.milestones.reduce((s, m) => s + m.value, 0))} of ${money(c.total)} contract.</p>` : ''}</div>
    </div>
    <div class="grid g2" style="margin-top:14px">
      <div class="card"><div class="row spread"><h2>Change orders</h2><a class="btn sm primary" href="#/estimates/new?job_id=${j.id}&customer_id=${j.customer_id}">+ Change order</a></div>
        <p class="small muted">Change orders are estimates on this job. They raise the contract once the customer signs them.</p>
        ${table([{ label: '#', key: 'number' }, { label: 'Scope', key: 'title' }, { label: 'Status', html: x => pill(x.status) }, { label: 'Amount', num: 1, get: x => money(x.amount) }],
          b.change_orders, { onClick: x => go('#/estimates/' + x.id), empty: 'No change orders' })}</div>
      <div class="card"><h2>Invoices</h2>${invTable(b.invoices)}</div></div>`;
  $('#setpct').onclick = async () => { await act(() => PUT('/jobs/' + j.id, { percent_complete: $('#pctc').value === '' ? null : Number($('#pctc').value) }), 'Updated'); route(); };
  $('#mstpl').onchange = async e => { if (!e.target.value) return; await act(() => POST(`/jobs/${j.id}/milestones`, { template: e.target.value }), 'Milestones added'); route(); };
  $('#addms').onclick = () => formModal({ title: 'Add milestone', fields: [{ name: 'name', label: 'Milestone', required: true, full: true }, { name: 'pct', label: '% of contract', type: 'number' }, { name: 'amount', label: '…or fixed amount $', type: 'number' }],
    submit: async d => { await POST(`/jobs/${j.id}/milestones`, d); toast('Milestone added'); route(); } });
  const bill = async body => { const r = await act(() => POST(`/jobs/${j.id}/bill-fixed`, body), 'Invoice created (draft)'); go('#/invoices/' + r.id); };
  $$('[data-ms]').forEach(x => x.onclick = () => bill({ mode: 'milestone', milestone_id: Number(x.dataset.ms) }));
  $$('[data-delms]').forEach(x => x.onclick = async () => { await act(() => DEL('/milestones/' + x.dataset.delms)); route(); });
  $$('[data-bill]').forEach(x => x.onclick = () => {
    const mode = x.dataset.bill;
    if (mode === 'final') { if (confirm(`Create the final invoice for ${money(b.remaining)}${b.retainage_held ? ` plus ${money(b.retainage_held)} retainage release` : ''}?`)) bill({ mode }); return; }
    const fields = mode === 'deposit' ? [{ name: 'pct', label: '% of contract', type: 'number', default: 30 }, { name: 'amount', label: '…or amount $ (overrides %)', type: 'number' }]
      : mode === 'percent' ? [{ name: 'pct', label: 'Bill up to this % complete', type: 'number', required: true, default: b.percent_complete ?? '' }]
      : [{ name: 'amount', label: 'Amount $', type: 'number', required: true }, { name: 'description', label: 'Description', full: true, default: 'Progress billing' }];
    formModal({ title: { deposit: 'Deposit invoice', percent: 'Progress invoice by % complete', amount: 'Progress invoice' }[mode], okLabel: 'Create invoice', fields,
      extra: `<p class="small muted">Billed so far ${money(b.billed_to_date)} of ${money(c.total)}.${b.retainage_pct ? ` ${b.retainage_pct}% retainage will be withheld.` : ''}</p>`,
      submit: d => bill({ mode, ...d }) });
  });
}

// ---------------------------------------------------------------- time & material
function tmBilling(j, T, b, invTable, through) {
  const u = b.unbilled;
  const nteBar = b.nte != null ? (() => { const used = Math.min(100, (b.billed_to_date + u.total) / b.nte * 100); return `<div class="cap ${used >= 100 ? 'over' : used > 85 ? 'full' : ''}" style="margin-top:6px"><i style="width:${used}%"></i></div>`; })() : '';
  T.innerHTML = `<div class="alert info" style="margin-bottom:14px"><b>Time &amp; material job.</b> The customer pays for labor hours and materials used. Everything logged is billable once, and items are locked after they're billed.</div>
    ${b.open_time_entries ? `<div class="alert" style="margin-bottom:14px">⏱ ${b.open_time_entries} person is still clocked in on this job. Their open time isn't included until they clock out.</div>` : ''}
    ${b.nte != null && b.nte_after < 0 ? `<div class="alert" style="margin-bottom:14px">⚠ Unbilled work would put this job ${money(-b.nte_after)} over its ${money(b.nte)} not-to-exceed. Get the customer's OK before billing past it.</div>` : ''}
    <div class="grid g4">
      ${kpi('Unbilled', money0(u.total), `${num(b.labor.reduce((s, l) => s + l.bill_hours, 0))} h labor · ${money0(u.materials)} materials`)}
      ${kpi('Billed to date', money0(b.billed_to_date), `${money0(b.collected)} collected`)}
      ${b.nte != null ? `<div class="card kpi"><div class="label">Not-to-exceed</div><div class="value">${money0(b.nte_remaining)}</div><div class="sub">left of ${money0(b.nte)}</div>${nteBar}</div>` : kpi('Not-to-exceed', '—', 'No cap set')}
      ${kpi('Cost to date', money0(b.cost_to_date), b.billed_to_date + u.total ? `${pct((b.billed_to_date + u.total - b.cost_to_date) / (b.billed_to_date + u.total) * 100)} margin incl. unbilled` : '')}
    </div>
    <div class="card" style="margin-top:14px"><div class="row spread"><h2>Ready to bill</h2>
        <span class="small muted">Labor ${b.labor_rate != null ? `at ${money(b.labor_rate)}/h (job rate)` : "at each tech's bill rate"} · ${b.increment_minutes}-min increments · travel ${b.bill_travel ? 'billed' : 'not billed'} · materials ${b.markup_pct != null ? `cost + ${b.markup_pct}%` : 'at price-book price'}</span></div>
      <h3>Labor</h3>${table([{ label: 'Tech', key: 'name' }, { label: 'Actual hrs', num: 1, get: l => num(l.hours) }, { label: 'Billed hrs', num: 1, get: l => num(l.bill_hours) }, { label: 'Rate', num: 1, get: l => money(l.rate) }, { label: 'Amount', num: 1, get: l => money(l.amount) }],
        b.labor, { empty: 'No unbilled time' })}
      <h3 style="margin-top:12px">Materials</h3>${table([{ label: 'Date', get: m => fmtDate(m.used_on) }, { label: 'Item', key: 'description' }, { label: 'Qty', num: 1, get: m => num(m.qty) }, { label: 'Cost', num: 1, get: m => money(m.unit_cost) },
        { label: 'Price', num: 1, get: m => money(m.bill_price) }, { label: 'Amount', num: 1, get: m => money(m.amount) }], b.materials, { empty: 'No unbilled materials' })}
      ${b.expenses.length ? `<h3 style="margin-top:12px">Billable expenses</h3>${table([{ label: 'Date', get: e => fmtDate(e.date) }, { label: 'Expense', get: e => [e.category, e.vendor, e.description].filter(Boolean).join(' — ') },
        { label: 'Cost', num: 1, get: e => money(e.amount) }, { label: 'Bill', num: 1, get: e => money(e.bill_amount) }], b.expenses)}` : ''}
      ${u.trip ? `<p>Trip / service charge: <b>${money(u.trip)}</b></p>` : ''}
      <form id="tmf" class="row" style="margin-top:14px;align-items:flex-end">
        <label class="f"><span>Bill work through</span><input type="date" name="through" value="${esc(through)}" style="width:auto"></label>
        <label class="check"><input type="checkbox" name="labor" checked> Labor</label><label class="check"><input type="checkbox" name="materials" checked> Materials</label>
        <label class="check"><input type="checkbox" name="expenses" checked> Expenses</label><label class="check"><input type="checkbox" name="trip" checked> Trip charge</label>
        <button type="button" class="btn" id="tmpreview">Update</button><button class="btn primary" ${u.total ? '' : 'disabled'}>Create T&amp;M invoice (${money0(u.total)})</button></form></div>
    <div class="grid g2" style="margin-top:14px"><div class="card"><h2>Invoices</h2>${invTable(b.invoices)}</div>
      <div class="card"><h2>Estimates</h2>${table([{ label: '#', key: 'number' }, { label: 'Title', key: 'title' }, { label: 'Status', html: e => pill(e.status) }, { label: 'Total', num: 1, get: e => money(e.total) }],
        j.estimates || [], { onClick: e => go('#/estimates/' + e.id), empty: 'No estimates (optional on T&M jobs)' })}</div></div>`;
  const f = $('#tmf');
  $('#tmpreview').onclick = () => go(`#/jobs/${j.id}?tab=billing${f.through.value ? '&through=' + f.through.value : ''}`);
  f.onsubmit = async e => {
    e.preventDefault();
    const body = { through: f.through.value || undefined, include: { labor: f.labor.checked, materials: f.materials.checked, expenses: f.expenses.checked, trip: f.trip.checked } };
    try { const r = await POST(`/jobs/${j.id}/bill-tm`, body); toast('T&M invoice created (draft)'); go('#/invoices/' + r.id); }
    catch (err) {
      if (/not-to-exceed/.test(err.message) && confirm(err.message + '\n\nBill anyway?')) { const r = await act(() => POST(`/jobs/${j.id}/bill-tm`, { ...body, allow_over_nte: true }), 'T&M invoice created (draft)'); go('#/invoices/' + r.id); }
      else if (!/not-to-exceed/.test(err.message)) toast(err.message, true);
    }
  };
}

// ---------------------------------------------------------------- WIP & unbilled report
async function wipReportView(R) {
  const w = await GET('/reports/wip');
  const t = w.totals;
  const fCols = [{ label: 'Job', html: x => `<a href="#/jobs/${x.id}?tab=billing">${esc(x.number)}</a> ${esc(x.title)}<div class="muted small">${esc(x.customer_name)}</div>`, csv: x => `${x.number} ${x.title}` },
    { label: 'Contract', num: 1, get: x => money0(x.contract), csv: x => x.contract }, { label: 'Cost to date', num: 1, get: x => money0(x.cost_to_date), csv: x => x.cost_to_date },
    { label: '% complete', num: 1, get: x => pct(x.percent_complete), csv: x => x.percent_complete }, { label: 'Earned', num: 1, get: x => x.earned == null ? '—' : money0(x.earned), csv: x => x.earned },
    { label: 'Billed', num: 1, get: x => money0(x.billed), csv: x => x.billed },
    { label: 'Over / (under)', num: 1, html: x => x.over_under == null ? '—' : Math.abs(x.over_under) < 1 ? '0' : x.over_under > 0 ? `<span class="pill info">${money0(x.over_under)}</span>` : `<span class="pill warn">(${money0(-x.over_under)})</span>`, csv: x => x.over_under },
    { label: 'Left to bill', num: 1, get: x => money0(x.remaining), csv: x => x.remaining }, { label: 'Retainage', num: 1, get: x => x.retainage_held ? money0(x.retainage_held) : '', csv: x => x.retainage_held },
    { label: 'Proj. profit', num: 1, get: x => money0(x.projected_profit), csv: x => x.projected_profit }];
  const tCols = [{ label: 'Job', html: x => `<a href="#/jobs/${x.id}?tab=billing">${esc(x.number)}</a> ${esc(x.title)}<div class="muted small">${esc(x.customer_name)} · ${esc(label(x.status))}</div>`, csv: x => `${x.number} ${x.title}` },
    { label: 'Unbilled hrs', num: 1, get: x => num(x.unbilled_hours), csv: x => x.unbilled_hours }, { label: 'Unbilled', num: 1, html: x => `<b>${money0(x.unbilled)}</b>${x.open_time_entries ? ' <span class="pill warn">clocked in</span>' : ''}`, csv: x => x.unbilled },
    { label: 'Billed', num: 1, get: x => money0(x.billed), csv: x => x.billed }, { label: 'Cost to date', num: 1, get: x => money0(x.cost_to_date), csv: x => x.cost_to_date },
    { label: 'NTE left after', num: 1, html: x => x.nte == null ? '' : x.nte_after < 0 ? `<span class="pill bad">${money0(x.nte_after)}</span>` : money0(x.nte_after), csv: x => x.nte_after }];
  R.innerHTML = `<div class="grid g4">${kpi('Unbilled T&M', money0(t.unbilled_tm), 'Work done, not invoiced yet')}${kpi('Under-billed (quoted)', money0(t.under_billed), 'Earned but not billed yet')}
      ${kpi('Over-billed (quoted)', money0(t.over_billed), 'Billed ahead of the work (a liability)')}${kpi('Retainage held', money0(t.retainage_held), 'Owed to you at completion')}</div>
    <div class="card" style="margin-top:14px"><div class="row spread"><h2>Quoted-price jobs — work in progress</h2><button class="btn sm" id="csvf">CSV</button></div>
      <p class="small muted">Earned = contract × % complete (entered on the job, or cost to date ÷ budgeted cost). Over-billed is a liability, under-billed is an asset. This is the WIP schedule banks and bonding companies ask for.</p>
      ${table(fCols, w.fixed, { empty: 'No open quoted jobs' })}</div>
    <div class="card" style="margin-top:14px"><div class="row spread"><h2>Time &amp; material jobs — unbilled</h2><button class="btn sm" id="csvt">CSV</button></div>${table(tCols, w.tm, { empty: 'Nothing unbilled' })}</div>`;
  $('#csvf').onclick = () => toCSV(fCols, w.fixed, 'wip_quoted.csv');
  $('#csvt').onclick = () => toCSV(tCols, w.tm, 'unbilled_tm.csv');
  return null;
}
