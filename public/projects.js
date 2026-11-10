'use strict';
/* Commercial projects: list page (#/projects) and the "Project" tab on a project's job page.
 * A project is a job marked "Commercial project" (Book job → tick the box). It keeps the job's contract,
 * change orders, retainage, billing and cost-code budgets, and adds progress by cost code, crew and daily logs. */
NAV.splice(NAV.findIndex(n => n.href === '#/jobs') + 1, 0, { href: '#/projects', label: 'Projects', icon: '🏗' });
ROUTES.push([/^\/projects$/, () => viewProjects()]);

const prodPill = p => p == null ? '—' : `<span class="pill ${p >= 1 ? 'good' : p >= 0.9 ? 'warn' : 'bad'}" title="Earned hours ÷ hours used. Above 1 is ahead of budget.">${num(p, 2)}</span>`;
const barPct = (v, cap = 100) => `<div class="cap ${v > 100 ? 'over' : v >= 90 ? 'full' : ''}" style="margin:4px 0 0"><i style="width:${Math.min(cap, Math.max(0, v || 0))}%"></i></div>`;
const daysLeft = d => d ? Math.round((new Date(d + 'T00:00:00') - new Date(todayStr() + 'T00:00:00')) / 864e5) : null;

async function viewProjects() {
  const { params } = hashParams(); const status = params.get('status') || 'active';
  const list = await GET('/projects' + qs({ status }));
  const seeMoney = isOffice() && can('see_costs');
  const sum = k => list.reduce((s, p) => s + (p.summary[k] || 0), 0);
  const under = list.reduce((s, p) => s + Math.min(0, p.summary.over_under || 0), 0);
  $('#view').innerHTML = setTop('Commercial Projects', isOffice() && can('jobs') ? '<button class="btn primary" id="newp">+ New project</button>' : '',
    'Contract, progress by cost code, labor hours vs budget, billing position, crew and daily logs.') + `
    ${isOffice() ? `<div class="grid g4">${kpi('Projects', list.length, status === 'active' ? 'open' : status)}${kpi('Contract value', money0(sum('contract')), `${money0(sum('billed'))} billed`)}
      ${kpi('Under-billed', money0(-under), 'work done but not yet billed')}${kpi('Need attention', list.filter(p => p.summary.flags.length).length, 'see flags below')}</div>` : ''}
    <div class="card" style="margin-top:14px"><div class="tabs">${[['active', 'Active'], ['closed', 'Closed'], ['all', 'All']].map(([k, l]) => `<button class="${k === status ? 'on' : ''}" data-s="${k}">${l}</button>`).join('')}</div>
    ${table([
      { label: 'Project', html: p => `<b>${esc(p.number)}</b> ${esc(p.title)}<div class="muted small">${esc(p.customer_name)}${p.pm_name ? ` · PM ${esc(p.pm_name)}` : ''}${p.foreman_name ? ` · Foreman ${esc(p.foreman_name)}` : ''}</div>` },
      { label: 'Finish', html: p => { const d = daysLeft(p.end_date); return p.end_date ? `${fmtDate(p.end_date)}<div class="small ${d < 0 ? '' : 'muted'}" style="${d < 0 ? 'color:var(--bad)' : ''}">${d < 0 ? `${-d} days late` : `${d} days left`}</div>` : '—'; } },
      { label: '% complete', num: 1, html: p => p.summary.percent_complete == null ? '—' : `${pct(p.summary.percent_complete)}${barPct(p.summary.percent_complete)}` },
      { label: 'Hours', num: 1, html: p => `${num(p.summary.hours, 0)}${p.summary.budget_hours ? ` / ${num(p.summary.budget_hours, 0)}${barPct(p.summary.hours_pct)}` : ''}` },
      ...(seeMoney ? [{ label: 'Contract', num: 1, html: p => p.summary.contract != null ? money0(p.summary.contract) : '<span class="muted">T&amp;M</span>' },
        { label: 'Billed', num: 1, html: p => `${money0(p.summary.billed)}${p.summary.billed_pct != null ? `<div class="small muted">${pct(p.summary.billed_pct)}</div>` : ''}` },
        { label: 'Over / under', num: 1, html: p => p.summary.over_under == null ? '—' : `<span style="color:var(${p.summary.over_under < 0 ? '--bad' : '--good'})">${money0(p.summary.over_under)}</span>` },
        { label: 'Proj. margin', num: 1, get: p => p.summary.projected_margin_pct == null ? '—' : pct(p.summary.projected_margin_pct) }] : []),
      { label: 'On site', html: p => p.summary.crew_now.length ? `<span class="pill good">● ${p.summary.crew_now.length}</span>` : '<span class="muted">—</span>' },
      { label: 'Flags', html: p => p.summary.flags.map(f => `<div class="small" style="color:var(--bad)">${esc(f)}</div>`).join('') || '<span class="muted small">On track</span>' },
    ], list, { onClick: p => go(`#/jobs/${p.id}?tab=project`), empty: status === 'active' ? 'No open commercial projects. Use “+ New project”, or tick “Commercial project” when booking a job.' : 'None' })}</div>`;
  $$('[data-s]').forEach(b => b.onclick = () => go('#/projects' + qs({ status: b.dataset.s })));
  if ($('#newp')) $('#newp').onclick = () => jobForm({ is_project: 1, billing_type: 'fixed', job_type: 'commercial' });
}

async function projectTab(j, T) {
  const [p] = await Promise.all([GET(`/projects/${j.id}`), loadCostCodes()]);
  const s = p.summary, seeMoney = (isOffice() && can('see_costs')) || (!isOffice() && can('see_costs'));
  const d = daysLeft(j.end_date);
  const pctSrc = { entered: 'entered on the job', cost_codes: 'from cost-code progress', cost: 'from cost to date vs budget' }[s.percent_source] || '';
  T.innerHTML = `
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
    <div class="card" style="margin-top:14px"><div class="row spread"><h2>Progress by cost code</h2>
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
    <div class="card" style="margin-top:14px"><div class="row spread"><h2>Daily logs</h2>${p.can_log ? '<button class="btn primary sm" id="plog">+ Daily log</button>' : ''}</div><div id="logs">Loading…</div></div>`;

  if ($('#pedit')) $('#pedit').onclick = () => jobForm(j);
  if ($('#psave')) $('#psave').onclick = async () => {
    const codes = $$('[data-cc]', T).map(i => ({ cost_code_id: Number(i.dataset.cc), percent_complete: i.value === '' ? null : Number(i.value) }));
    if (codes.some(c => c.percent_complete != null && (c.percent_complete < 0 || c.percent_complete > 100))) return toast('Percent complete must be 0 to 100', true);
    const r = await act(() => PUT(`/projects/${j.id}/budgets`, { codes }), 'Progress saved');
    if (r && r.percent_complete != null) toast(`Project is ${pct(r.percent_complete)} complete`);
    route();
  };
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
