'use strict';
/* Commercial projects: list page (#/projects) and the "Project" tab on a project's job page.
 * A project is a job marked "Commercial project" (Book job → tick the box). It keeps the job's contract,
 * change orders, retainage, billing and cost-code budgets, and adds progress by cost code, crew and daily logs. */
NAV.splice(NAV.findIndex(n => n.href === '#/jobs') + 1, 0, { href: '#/projects', label: 'Commercial Projects', icon: '🏗' });
ROUTES.push([/^\/projects$/, () => viewProjects()]);

const prodPill = p => p == null ? '—' : `<span class="pill ${p >= 1 ? 'good' : p >= 0.9 ? 'warn' : 'bad'}" title="Earned hours ÷ hours used. Above 1 is ahead of budget.">${num(p, 2)}</span>`;
const barPct = (v, cap = 100) => `<div class="cap ${v > 100 ? 'over' : v >= 90 ? 'full' : ''}" style="margin:4px 0 0"><i style="width:${Math.min(cap, Math.max(0, v || 0))}%"></i></div>`;
const daysLeft = d => d ? Math.round((new Date(d + 'T00:00:00') - new Date(todayStr() + 'T00:00:00')) / 864e5) : null;

// Company roll-up of every commercial project — the Master Tracker's dashboard, live.
// every open project's schedule rolled up: how many people the company needs each week vs who actually worked
async function companyManpower(el) {
  const d = await GET('/manpower'), cols = manpowerTable(d.weeks, d.classes, { cum: false });
  const busy = d.jobs.filter(j => j.planned_crew.some(Boolean) || j.actual_hours.some(Boolean));
  el.innerHTML = `<div class="row spread"><h2>Company manpower — all open projects</h2><button class="btn sm" id="mpcsv">CSV</button></div>
    <p class="small muted">Four weeks back and sixteen ahead. Planned crew comes from each project's Schedule; projects without dated tasks only show actual hours. Max crew ${d.cfg.max_crew} (Settings → Commercial projects).</p>
    ${d.weeks.some(w => w.planned_hours || w.actual_hours) ? crewChart(d.weeks, d.cfg, d.today) : '<div class="empty">No scheduled or actual project hours in this window</div>'}
    ${busy.length ? `<h3 style="margin:14px 0 6px">Planned crew by project</h3>${table([{ label: 'Project', html: j => `<a href="#/jobs/${j.id}?tab=project&sheet=manpower"><b>${esc(j.number)}</b></a> ${esc(j.title)}` },
      ...d.weeks.map((w, i) => ({ label: `${Number(w.week_start.slice(5, 7))}/${Number(w.week_start.slice(8))}`, num: 1, get: j => j.planned_crew[i] || '' }))], busy)}` : ''}
    <details style="margin-top:10px"><summary class="small">Week-by-week detail</summary>${table(cols, d.weeks)}</details>`;
  $('#mpcsv', el).onclick = () => toCSV(cols, d.weeks, `company_manpower_${d.today}.csv`);
}
async function viewProjects() {
  const { params } = hashParams(); const status = params.get('status') || 'active';
  if (!isOffice()) return viewMyProjects();
  const d = await GET('/projects/dashboard' + qs({ status }));
  const t = d.totals, M = d.money;
  const tone = (v, good, warn) => v == null ? '' : v >= good ? 'good' : v >= warn ? 'warn' : 'bad';
  const idx = v => v == null ? '—' : num(v, 2);
  const signed = v => v == null ? '—' : `<span style="color:var(${v < 0 ? '--bad' : '--good'})">${v < 0 ? `(${money0(-v)})` : money0(v)}</span>`;
  const mTone = r => r.margin_pct == null ? '' : r.margin_pct < t.target_margin ? 'bad' : r.margin_pct < t.target_margin + 5 ? 'warn' : 'good';
  const summary = M ? [
    `Contract of <b>${money0(t.contract)}</b> across ${t.projects} project${t.projects === 1 ? '' : 's'}${t.approved_co ? ` (${money0(t.approved_co)} in approved change orders)` : ''}, projected to finish at <b>${money0(t.eac)}</b> cost for a <b>${pct(t.margin_pct)}</b> margin (target ${t.target_margin}%).`,
    `Spent ${money0(t.actual_cost)} plus ${money0(t.open_commit)} committed against a ${money0(t.budget_cost)} budget; the work is ${pct(t.percent_complete)} complete${t.cpi != null ? `, earning ${num(t.cpi, 2)} of budget per dollar spent (CPI)` : ''}.`,
    `Schedule: ${t.spi != null ? `SPI ${num(t.spi, 2)} — ${t.spi >= 1 ? 'ahead of' : t.spi >= 0.9 ? 'close to' : 'behind'} plan` : 'add start and finish dates to see schedule performance'}. ${num(t.hours, 0)} labor hours of ${num(t.budget_hours, 0)} budgeted.`,
    `Billing: ${money0(t.billed)} billed, ${money0(t.cash)} collected, ${money0(t.retainage)} retainage held; ${t.over_under < 0 ? `<b>${money0(-t.over_under)} under-billed</b> (work done, not yet billed)` : `${money0(t.over_under)} over-billed`}.${t.pending_co ? ` Exposure: ${money0(t.pending_co)} in change orders not yet approved.` : ''}`,
  ] : [`${t.projects} project${t.projects === 1 ? '' : 's'}, ${pct(t.percent_complete)} complete overall. ${num(t.hours, 0)} labor hours of ${num(t.budget_hours, 0)} budgeted${t.spi != null ? `; schedule SPI ${num(t.spi, 2)}` : ''}.`];
  const cols = M ? [
    { label: 'Job', html: r => `<b>${esc(r.number)}</b> ${esc(r.title)}<div class="muted small">${esc(r.customer_name)}${r.pm_name ? ` · PM ${esc(r.pm_name)}` : ''}${r.timeclock_job ? ` · clock #${esc(r.timeclock_job)}` : ''}</div>`, csv: r => `${r.number} ${r.title}` },
    { label: '% Compl', num: 1, html: r => r.percent_complete == null ? '—' : `${pct(r.percent_complete)}${barPct(r.percent_complete)}`, csv: r => r.percent_complete },
    { label: 'Revised contract', num: 1, html: r => r.contract == null ? '<span class="muted">T&amp;M</span>' : money0(r.contract), csv: r => r.contract },
    { label: 'Budget cost', num: 1, get: r => r.budget_cost == null ? '—' : money0(r.budget_cost), csv: r => r.budget_cost },
    { label: 'Actual cost', num: 1, get: r => money0(r.actual_cost), csv: r => r.actual_cost },
    { label: 'Open commit', num: 1, get: r => r.open_commit ? money0(r.open_commit) : '—', csv: r => r.open_commit },
    { label: 'Projected cost', num: 1, get: r => money0(r.eac), csv: r => r.eac },
    { label: 'Margin', num: 1, html: r => r.margin == null ? '—' : `${money0(r.margin)}<div class="small"><span class="pill ${mTone(r)}">${pct(r.margin_pct)}</span></div>`, csv: r => r.margin },
    { label: 'Margin %', num: 1, html: () => '', csv: r => r.margin_pct, hide: 1 },
    { label: 'CPI', num: 1, html: r => r.cpi == null ? '—' : `<span class="pill ${tone(r.cpi, 1, 0.9)}">${idx(r.cpi)}</span>`, csv: r => r.cpi },
    { label: 'SPI', num: 1, html: r => r.spi == null ? '—' : `<span class="pill ${tone(r.spi, 1, 0.9)}">${idx(r.spi)}</span>`, csv: r => r.spi },
    { label: 'Billed', num: 1, html: r => `${money0(r.billed)}${r.contract ? `<div class="small muted">${pct(r.billed / r.contract * 100)}</div>` : ''}`, csv: r => r.billed },
    { label: 'Over / (under)', num: 1, html: r => signed(r.over_under), csv: r => r.over_under },
    { label: 'Hours', num: 1, html: r => `${num(r.hours, 0)}${r.budget_hours ? ` / ${num(r.budget_hours, 0)}${barPct(r.hours / r.budget_hours * 100)}` : ''}`, csv: r => r.hours },
    { label: 'Watch', html: r => r.flags.map(f => `<div class="small" style="color:var(--bad)">${esc(f)}</div>`).join('') || '<span class="pill good">On track</span>', csv: r => r.flags.join('; ') },
  ] : [
    { label: 'Job', html: r => `<b>${esc(r.number)}</b> ${esc(r.title)}<div class="muted small">${esc(r.customer_name)}</div>`, csv: r => `${r.number} ${r.title}` },
    { label: 'Finish', get: r => r.end_date ? fmtDate(r.end_date) : '—', csv: r => r.end_date },
    { label: '% Compl', num: 1, html: r => r.percent_complete == null ? '—' : `${pct(r.percent_complete)}${barPct(r.percent_complete)}`, csv: r => r.percent_complete },
    { label: 'SPI', num: 1, html: r => r.spi == null ? '—' : `<span class="pill ${tone(r.spi, 1, 0.9)}">${idx(r.spi)}</span>`, csv: r => r.spi },
    { label: 'Hours', num: 1, html: r => `${num(r.hours, 0)}${r.budget_hours ? ` / ${num(r.budget_hours, 0)}${barPct(r.hours / r.budget_hours * 100)}` : ''}`, csv: r => r.hours },
    { label: 'On site', num: 1, get: r => r.crew_now || '—', csv: r => r.crew_now },
    { label: 'Watch', html: r => r.flags.map(f => `<div class="small" style="color:var(--bad)">${esc(f)}</div>`).join('') || '<span class="pill good">On track</span>', csv: r => r.flags.join('; ') },
  ];
  const ex = d.exceptions;
  $('#view').innerHTML = setTop('Commercial Dashboard', `<div class="seg">${[['active', 'Active'], ['all', 'All projects']].map(([k, l]) => `<a href="#/projects${qs({ status: k })}" class="${k === status ? 'on' : ''}">${l}</a>`).join('')}</div>
      <button class="btn" id="pcsv">Export CSV</button><button class="btn" onclick="print()">Print</button>${can('jobs') ? '<button class="btn primary" id="newp">+ New project</button>' : ''}`,
    `Company roll-up of ${t.projects} commercial project${t.projects === 1 ? '' : 's'} · as of ${fmtDate(d.as_of)}`) + `
    <div class="card"><h2>Executive summary</h2>${summary.map(x => `<p style="margin:4px 0">${x}</p>`).join('')}</div>
    ${M ? `<h3 style="margin:16px 0 6px">Contract &amp; margin</h3><div class="grid g4">
      ${kpi('Revised contract', money0(t.contract), `original ${money0(t.original)} + approved COs ${money0(t.approved_co)}`)}
      ${kpi('Projected cost (EAC)', money0(t.eac), 'at current cost performance')}
      ${kpi('Projected margin', money0(t.margin), `<span class="pill ${t.margin_pct == null ? '' : t.margin_pct < t.target_margin ? 'bad' : 'good'}">${pct(t.margin_pct)}</span> vs ${t.target_margin}% target`)}
      ${kpi('% complete', pct(t.percent_complete), 'earned value ÷ budget')}</div>
    <h3 style="margin:16px 0 6px">Cost</h3><div class="grid g4">
      ${kpi('Budget cost', money0(t.budget_cost), 'cost-code budgets')}${kpi('Actual cost to date', money0(t.actual_cost), 'labor + material + other')}
      ${kpi('Open commitments', money0(t.open_commit), 'POs sent, not yet received')}${kpi('Cost variance', signed(t.cost_variance), 'budget less cost &amp; commitments')}</div>` : ''}
    <h3 style="margin:16px 0 6px">Performance</h3><div class="grid g4">
      ${M ? kpi('CPI', `<span class="pill ${tone(t.cpi, 1, 0.9)}" style="font-size:inherit">${idx(t.cpi)}</span>`, 'earned ÷ actual cost (1.00 = on budget)') : kpi('% complete', pct(t.percent_complete), 'by cost-code progress')}
      ${kpi('SPI', `<span class="pill ${tone(t.spi, 1, 0.9)}" style="font-size:inherit">${idx(t.spi)}</span>`, 'earned ÷ planned hours (straight-line plan)')}
      ${kpi('Labor hours', `${num(t.hours, 0)}`, `of ${num(t.budget_hours, 0)} budgeted${t.budget_hours ? ` (${pct(t.hours / t.budget_hours * 100)})` : ''}`)}
      ${kpi('On site now', t.crew_now, 'clocked in on a project')}</div>
    ${M ? `<h3 style="margin:16px 0 6px">Billing</h3><div class="grid g4">
      ${kpi('Billed to date', money0(t.billed), t.contract ? `${pct(t.billed / t.contract * 100)} of contract` : '')}${kpi('Cash received', money0(t.cash), 'payments recorded')}
      ${kpi('Retainage held', money0(t.retainage), 'owed at closeout')}${kpi('Over / (under) billed', signed(t.over_under), 'billed less earned revenue')}</div>` : ''}
    <div class="grid g2" style="margin-top:16px">
      <div class="card"><h2>Exceptions &amp; watch list</h2>${table([{ label: 'Item', key: 'label' },
        { label: 'Count', num: 1, html: e => e.count ? `<span class="pill bad">${e.count}</span>` : '<span class="pill good">0</span>' },
        ...(M ? [{ label: 'Amount', num: 1, get: e => e.amount ? money0(e.amount) : '' }] : []),
        { label: 'Jobs', html: e => e.jobs.map(n => { const r = d.projects.find(p => p.number === n); return r ? `<a href="#/jobs/${r.id}?tab=project">${esc(n)}</a>` : esc(n); }).join(', ') }], ex)}</div>
      <div class="card"><h2>Labor hours by week</h2>${weekBars(d.weeks)}</div>
    </div>
    <div class="card snap" style="margin-top:14px"><h2>Job snapshot</h2>
      ${table(cols.filter(c => !c.hide), d.projects, { onClick: r => go(`#/jobs/${r.id}?tab=project`), empty: status === 'active' ? 'No open commercial projects. Use “+ New project”, or tick “Commercial project” when booking a job.' : 'None' })}</div>
    <div class="card" style="margin-top:14px"><h2>By division</h2><p class="small muted">Budget vs actual across ${status === 'active' ? 'active' : 'all'} projects, grouped by your cost-code divisions.</p>
      ${table([{ label: 'Division', key: 'division' }, { label: 'Budget hrs', num: 1, get: x => num(x.budget_hours, 0) },
        { label: 'Actual hrs', num: 1, html: x => `${num(x.hours, 0)}${x.budget_hours ? barPct(x.hours / x.budget_hours * 100) : ''}` },
        ...(M ? [{ label: 'Material budget', num: 1, get: x => money0(x.budget_material) }, { label: 'Material actual', num: 1, get: x => money0(x.material_cost) }, { label: 'Total cost', num: 1, get: x => money0(x.cost) }] : [])],
        d.divisions, { empty: 'No cost-coded budget or hours yet' })}</div>
    <div class="card" style="margin-top:14px" id="mpall"><h2>Company manpower — all open projects</h2><div class="muted small">Loading…</div></div>`;
  companyManpower($('#mpall'));
  $('#pcsv').onclick = () => toCSV(cols, d.projects, `commercial_dashboard_${d.as_of}.csv`);
  if ($('#newp')) $('#newp').onclick = () => jobForm({ is_project: 1, billing_type: 'fixed', job_type: 'commercial' });
}
// techs: just the projects they're on
async function viewMyProjects() {
  const list = await GET('/projects');
  $('#view').innerHTML = setTop('Projects', '', 'Commercial projects you are on.') + `<div class="card">${table([
    { label: 'Project', html: p => `<b>${esc(p.number)}</b> ${esc(p.title)}<div class="muted small">${esc(p.customer_name)}${p.foreman_name ? ` · Foreman ${esc(p.foreman_name)}` : ''}</div>` },
    { label: 'Finish', get: p => p.end_date ? fmtDate(p.end_date) : '—' },
    { label: '% complete', num: 1, html: p => p.summary.percent_complete == null ? '—' : `${pct(p.summary.percent_complete)}${barPct(p.summary.percent_complete)}` },
    { label: 'Hours', num: 1, html: p => `${num(p.summary.hours, 0)}${p.summary.budget_hours ? ` / ${num(p.summary.budget_hours, 0)}` : ''}` },
    { label: 'On site', html: p => p.summary.crew_now.length ? `<span class="pill good">● ${p.summary.crew_now.length}</span>` : '—' }],
    list, { onClick: p => go(`#/jobs/${p.id}?tab=project`), empty: 'No projects' })}</div>`;
}

// the Dashboard, Cost Codes and Daily Logs sheets of a project (the other sheets live in workbook.js)
async function projectCoreSheet(j, T, sheet) {
  const [p] = await Promise.all([GET(`/projects/${j.id}`), loadCostCodes()]);
  const s = p.summary, seeMoney = (isOffice() && can('see_costs')) || (!isOffice() && can('see_costs'));
  const d = daysLeft(j.end_date);
  const pctSrc = { entered: 'entered on the job', cost_codes: 'from cost-code progress', cost: 'from cost to date vs budget' }[s.percent_source] || '';
  T.innerHTML = `${sheet === 'dashboard' ? `
    ${s.flags.length ? `<div class="alert" style="margin-bottom:14px"><b>Needs attention:</b><ul style="margin:6px 0 0 18px;padding:0">${s.flags.map(f => `<li>${esc(f)}</li>`).join('')}</ul></div>` : ''}
    <div class="grid g4">
      ${kpi('% complete', s.percent_complete == null ? '—' : pct(s.percent_complete), pctSrc)}
      ${kpi('Labor hours', `${num(s.hours, 0)}${s.budget_hours ? ` / ${num(s.budget_hours, 0)}` : ''}`, s.budget_hours ? `forecast ${num(s.forecast_hours, 0)} at completion` : 'no hours budget yet')}
      ${seeMoney && s.contract != null ? kpi('Contract', money0(s.contract), s.change_orders_total ? `incl. ${money0(s.change_orders_total)} change orders` : 'no change orders') : kpi('Finish', j.end_date ? fmtDate(j.end_date) : '—', d == null ? '' : d < 0 ? `${-d} days late` : `${d} days left`)}
      ${seeMoney && s.contract != null ? kpi('Billed', money0(s.billed), `${pct(s.billed_pct)} · ${s.over_under == null ? '' : s.over_under < 0 ? `${money0(-s.over_under)} under-billed` : `${money0(s.over_under)} over-billed`}`)
        : kpi('On site now', s.crew_now.length, s.crew_now.map(c => esc(c.name)).join(', ') || 'nobody clocked in')}
    </div>
    <div class="grid g2" style="margin-top:14px">
      <div class="card"><h2>Project team</h2><dl class="kv">
        <dt>Customer / GC</dt><dd>${esc(j.customer_name)}</dd>
        <dt>Site contact</dt><dd>${esc(j.gc_contact || '—')} ${j.gc_phone ? `· <a href="tel:${esc(j.gc_phone)}">${esc(j.gc_phone)}</a>` : ''} ${j.gc_email ? `· <a href="mailto:${esc(j.gc_email)}">${esc(j.gc_email)}</a>` : ''}</dd>
        <dt>Project manager</dt><dd>${p.users.pm ? esc(p.users.pm.name) : '—'}</dd><dt>Foreman</dt><dd>${p.users.foreman ? esc(p.users.foreman.name) : '—'}</dd>
        <dt>Dates</dt><dd>${j.start_date ? fmtDate(j.start_date) : '—'} → ${j.end_date ? fmtDate(j.end_date) : '—'}${d != null ? ` <span class="small ${d < 0 ? '' : 'muted'}" style="${d < 0 ? 'color:var(--bad)' : ''}">(${d < 0 ? `${-d} days late` : `${d} days left`})</span>` : ''}</dd>
        ${seeMoney && s.projected_margin_pct != null ? `<dt>Projected margin</dt><dd>${pct(s.projected_margin_pct)} (${money0(s.projected_profit)})</dd>` : ''}
        ${seeMoney && s.retainage_held ? `<dt>Retainage held</dt><dd>${money0(s.retainage_held)}</dd>` : ''}
      </dl>${isOffice() && can('jobs') ? '<button class="btn sm" id="pedit" style="margin-top:8px">Edit project details</button>' : ''}</div>
      <div class="card"><h2>Crew today</h2>
        ${table([{ label: 'Who', html: r => `${r.on_clock ? '<span class="pill good">●</span> ' : ''}${esc(r.name)}` }, { label: 'Cost code', get: r => r.code ? `${r.code} ${r.cost_code_name}` : 'Uncoded' }, { label: 'Hours', num: 1, get: r => num(r.h) }],
          p.today_crew, { empty: 'No time on this project today' })}
        <h3 style="margin-top:14px">Hours by week</h3>${weekBars(p.weeks)}</div>
    </div>
    ` : ''}${sheet === 'codes' ? `<div class="card"><div class="row spread"><h2>Progress by cost code</h2>
      ${p.can_edit_progress ? '<button class="btn primary sm" id="psave">Save progress</button>' : ''}</div>
      <p class="small muted">Enter how far along each cost code is. Earned hours = budget × % complete. Productivity = earned ÷ used (above 1 is ahead). Forecast = hours used ÷ % complete. Budgets are set on the <a href="#/jobs/${j.id}?tab=budget">Cost codes &amp; budget</a> tab.</p>
      ${table([
        { label: 'Cost code', html: r => `<b>${esc(r.code)}</b> ${esc(r.name)}` },
        { label: 'Budget hrs', num: 1, get: r => r.budget_hours ? num(r.budget_hours) : '—' },
        { label: 'Used', num: 1, html: r => `${num(r.hours)}${r.budget_hours ? barPct(r.pct_hours_used) : ''}` },
        { label: '% complete', num: 1, html: r => p.can_edit_progress && r.cost_code_id ? `<input class="n" type="number" min="0" max="100" step="1" data-cc="${r.cost_code_id}" value="${r.percent_complete ?? ''}" style="width:72px">` : r.percent_complete == null ? '—' : pct(r.percent_complete) },
        { label: 'Earned', num: 1, get: r => r.earned_hours == null ? '—' : num(r.earned_hours) },
        { label: 'Productivity', num: 1, html: r => prodPill(r.productivity) },
        { label: 'Forecast hrs', num: 1, html: r => r.forecast_variance != null && r.forecast_variance < 0 ? `<span style="color:var(--bad)">${num(r.forecast_hours)}</span>` : num(r.forecast_hours) },
        ...(seeMoney ? [{ label: 'Material', num: 1, html: r => `${money0(r.material_cost)}${r.budget_material ? `<div class="small muted">of ${money0(r.budget_material)}</div>` : ''}` }] : []),
      ], p.cost_codes, { empty: 'No cost-code budget or hours yet. Add a budget on the Cost codes & budget tab.' })}</div>
    ` : ''}${sheet === 'logs' ? `<div class="card"><div class="row spread"><h2>Daily logs</h2>${p.can_log ? '<button class="btn primary sm" id="plog">+ Daily log</button>' : ''}</div><div id="logs">Loading…</div></div>` : ''}`;

  if ($('#pedit')) $('#pedit').onclick = () => jobForm(j);
  if ($('#psave')) $('#psave').onclick = async () => {
    const codes = $$('[data-cc]', T).map(i => ({ cost_code_id: Number(i.dataset.cc), percent_complete: i.value === '' ? null : Number(i.value) }));
    if (codes.some(c => c.percent_complete != null && (c.percent_complete < 0 || c.percent_complete > 100))) return toast('Percent complete must be 0 to 100', true);
    const r = await act(() => PUT(`/projects/${j.id}/budgets`, { codes }), 'Progress saved');
    if (r && r.percent_complete != null) toast(`Project is ${pct(r.percent_complete)} complete`);
    route();
  };
  if (sheet !== 'logs') return;
  const logs = await GET(`/projects/${j.id}/logs`);
  $('#logs', T).innerHTML = logs.length ? logs.map(l => `<div class="dlog" data-log="${l.id}">
      <div class="row spread"><b>${new Date(l.log_date + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}</b>
        <span class="small muted">${esc(l.user_name || '')}${l.weather ? ` · ${esc(l.weather)}` : ''}${l.crew_count ? ` · crew of ${l.crew_count}` : ''}</span></div>
      <div style="white-space:pre-wrap;margin:4px 0">${esc(l.work_performed)}</div>
      ${[['Delays / issues', l.delays], ['Safety', l.safety], ['Visitors / inspections', l.visitors], ['Deliveries', l.deliveries]].filter(([, v]) => v).map(([k, v]) => `<div class="small"><b>${k}:</b> ${esc(v)}</div>`).join('')}
      ${l.time.length ? `<div class="small muted" style="margin-top:4px">Time clock: ${l.time.map(t => `${esc(t.name)} ${num(t.h)}h${t.code ? ` (${esc(t.code)})` : ''}`).join(' · ')}</div>` : ''}
    </div>`).join('') : '<div class="empty">No daily logs yet</div>';
  $$('[data-log]', T).forEach(el => el.onclick = () => { const l = logs.find(x => x.id === Number(el.dataset.log)); if (isOffice() || l.user_id === S.user.id) dailyLogForm(j, l); });
  if ($('#plog')) $('#plog').onclick = () => dailyLogForm(j, { log_date: todayStr(), crew_count: p.today_crew.length ? new Set(p.today_crew.map(r => r.name)).size : '' });
}
function weekBars(weeks) {
  if (!weeks.length) return '<div class="empty">No hours yet</div>';
  const max = Math.max(...weeks.map(w => w.hours), 1);
  return `<div class="wbars">${weeks.map(w => `<div title="Week of ${fmtDate(w.week)}: ${num(w.hours)} h"><i style="height:${Math.max(2, w.hours / max * 100)}%"></i><span>${new Date(w.week + 'T00:00:00').toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' })}</span></div>`).join('')}</div>`;
}
async function dailyLogForm(j, l) {
  const fields = [{ name: 'log_date', label: 'Date', type: 'date', required: true }, { name: 'weather', label: 'Weather', placeholder: 'e.g. 45°F, rain in the afternoon' },
    { name: 'crew_count', label: 'Crew on site', type: 'number' },
    { name: 'work_performed', label: 'Work performed (areas, floors, systems)', type: 'textarea', required: true, full: true },
    { name: 'delays', label: 'Delays / issues (waiting on GC, other trades, material, RFIs)', type: 'textarea', full: true },
    { name: 'safety', label: 'Safety (toolbox talk, incidents, near misses)', full: true }, { name: 'visitors', label: 'Visitors / inspections', full: true },
    { name: 'deliveries', label: 'Deliveries', full: true }];
  const hours = await GET(`/projects/${j.id}/hours-on` + qs({ date: l.log_date || todayStr() })).catch(() => []);
  const m = formModal({
    title: l.id ? `Daily log — ${fmtDate(l.log_date)}` : `Daily log — ${j.number}`, values: l, wide: true, okLabel: 'Save log',
    extra: `<p class="small muted" id="dlhours" style="margin-top:8px">${hours.length ? `Time clock that day: ${hours.map(t => `${esc(t.name)} ${num(t.h)}h${t.code ? ` (${esc(t.code)})` : ''}`).join(' · ')}` : 'No time clock hours on this date.'}</p>
      ${l.id ? '<button type="button" class="btn danger sm" id="dldel" style="margin-top:6px">Delete log</button>' : ''}`,
    fields, submit: async d => { if (l.id) await PUT('/daily-logs/' + l.id, d); else await POST(`/projects/${j.id}/logs`, d); toast('Daily log saved'); route(); },
  });
  if ($('#dldel', m.el)) $('#dldel', m.el).onclick = async () => { if (confirm('Delete this daily log?')) { await act(() => DEL('/daily-logs/' + l.id), 'Deleted'); m.close(); route(); } };
}
