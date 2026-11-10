'use strict';
/* A commercial project laid out like the A4YE job tracker workbook (A4YE_Job_TEMPLATE.xlsx).
 * Sheets, in the workbook's order: Dashboard · Schedule & Gantt · Cost Codes · Labor Log · Cost Log · Change Orders · SOV · Billing Entry ·
 * Pay Apps · Pay App (G702/G703) · RFI-Submittal · Safety-Quality · Milestones · Daily Logs. */
const WB_SHEETS = [
  ['dashboard', 'Dashboard'], ['import', 'Estimate Import', 'budget'], ['schedule', 'Schedule'], ['codes', 'Cost Codes'], ['manpower', 'Manpower Loading'], ['history', 'Weekly History'], ['report', 'Bi-Weekly Report', 'office'], ['labor', 'Labor Log'], ['cost', 'Cost Log', 'cost'], ['co', 'Change Orders', 'office'],
  ['sov', 'SOV', 'bill'], ['billing', 'Billing Entry', 'bill'], ['payapps', 'Pay Apps', 'bill'], ['g702', 'Pay App (G702/G703)', 'bill'],
  ['rfi', 'RFI-Submittal'], ['safety', 'Safety-Quality'], ['milestones', 'Milestones'], ['logs', 'Daily Logs'],
];
const wbDate = d => d ? fmtDate(String(d).slice(0, 10)) : '—';
const statusPill = (st) => { const tone = { Approved: 'good', Paid: 'good', Complete: 'good', Closed: 'good', 'On Track': 'good', Answered: 'good', 'Approved as Noted': 'good',
  Submitted: 'info', Open: 'info', Pending: 'warn', Draft: '', 'At Risk': 'warn', 'Short Paid': 'warn', Overdue: 'bad', Late: 'bad', Rejected: 'bad', Void: 'bad', Disputed: 'bad', 'Revise & Resubmit': 'warn' }[st] ?? '';
  return `<span class="pill ${tone}">${esc(st || '—')}</span>`; };

async function projectTab(j, T) {
  const { params } = hashParams();
  const okSheet = ([, , need]) => !need || (need === 'office' && isOffice()) || (need === 'cost' && isOffice() && can('see_costs')) || (need === 'bill' && isOffice() && can('invoices') && j.billing_type === 'fixed') || (need === 'budget' && isOffice() && can('projects'));
  const sheets = WB_SHEETS.filter(okSheet);
  const sheet = sheets.some(([k]) => k === params.get('sheet')) ? params.get('sheet') : 'dashboard';
  T.innerHTML = `<div class="wb-tabs no-print">${sheets.map(([k, l]) => `<a href="#/jobs/${j.id}?tab=project&sheet=${k}" class="${k === sheet ? 'on' : ''}">${l}</a>`).join('')}</div><div id="wbs"></div>`;
  const W = $('#wbs', T);
  if (['dashboard', 'codes', 'logs'].includes(sheet)) return projectCoreSheet(j, W, sheet);
  return ({ import: wbImport, schedule: wbSchedule, manpower: wbManpower, history: wbHistory, report: wbReport, labor: wbLabor, cost: wbCost, co: wbChangeOrders, sov: wbSov, billing: wbBilling, payapps: wbPayApps, g702: wbG702, rfi: wbRfi, safety: wbSafety, milestones: wbMilestones })[sheet](j, W);
}

// ------------------------------------------------------------ Schedule & Gantt
// Start, finish and budget hours drive the Gantt; planned % is time-based against the as-of date. One bar per task per week,
// the done part shaded by % complete; under it the weekly planned hours and crew (the Manpower Loading math).
const SCHED_TONE = { Complete: 'good', 'In Progress': 'info', Late: 'bad', 'Late Start': 'bad', 'Update %': 'warn', 'On Hold': 'warn', 'By Others': '', 'Not Started': '' };
async function wbSchedule(j, W) {
  const { params } = hashParams();
  const asOf = params.get('asof') || '', la = params.get('la') === '1';
  const d = await GET(`/projects/${j.id}/schedule${asOf ? `?as_of=${asOf}` : ''}`);
  if (d.can_edit) await loadCostCodes();
  const go = (k, v) => { const p = new URLSearchParams(params); if (v) p.set(k, v); else p.delete(k); location.hash = `#/jobs/${j.id}?${p}`; };
  const rows = la ? d.rows.filter(r => r.lookahead) : d.rows;
  const t = d.totals, late = d.rows.filter(r => r.status === 'Late' || r.status === 'Late Start').length, upd = d.rows.filter(r => r.status === 'Update %').length;
  const n1 = v => v == null ? '' : Number(v).toLocaleString(undefined, { maximumFractionDigits: 1 });
  const addDays = (s, n) => { const x = new Date(s + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
  const now = d.as_of, wkNow = d.weeks.find(w => w.week_start <= now && w.week_ending >= now);
  const doneTo = r => { if (!r.start_date || !r.finish_date || !(r.pct_complete > 0)) return null;
    const len = (Date.parse(r.finish_date) - Date.parse(r.start_date)) / 864e5 + 1; return addDays(r.start_date, Math.ceil(len * Math.min(100, r.pct_complete) / 100) - 1); };
  const cell = (r, w) => {
    const on = r.start_date && r.finish_date && r.start_date <= w.week_ending && r.finish_date >= w.week_start;
    const dt = on && doneTo(r), done = dt && dt >= w.week_start;
    const cls = ['g', on ? (done ? 'g-done' : r.status === 'Late' || r.status === 'Late Start' ? 'g-late' : 'g-on') : '', w === wkNow ? 'g-now' : ''].join(' ');
    return `<td class="${cls}" title="${on ? esc(`${r.ref} ${r.name}: ${wbDate(r.start_date)} – ${wbDate(r.finish_date)}`) : ''}"></td>`;
  };
  const pctCell = r => d.can_progress && !r.on_hold ? `<input type="number" min="0" max="100" step="5" class="pct-in" data-pct="${r.id}" value="${r.pct_complete ?? ''}" placeholder="—">` : r.pct_complete == null ? '—' : `${n1(r.pct_complete)}%`;
  const monthHead = d.weeks.map((w, i) => { const m = w.week_start.slice(0, 7); return i === 0 || d.weeks[i - 1].week_start.slice(0, 7) !== m ? `<th class="g gm" colspan="${d.weeks.filter(x => x.week_start.slice(0, 7) === m).length}">${new Date(w.week_start + 'T12:00:00Z').toLocaleString(undefined, { month: 'short', year: '2-digit', timeZone: 'UTC' })}</th>` : ''; }).join('');
  // compact by default so the Gantt is on screen; "All columns" shows the workbook's full set
  const allCols = params.get('cols') === 'all';
  const C = [
    { l: 'ID', core: 1, td: r => `<b>${esc(r.ref)}</b>`, cls: 'g-id' }, { l: 'Phase', td: r => esc(r.phase || '') }, { l: 'Area / WBS', td: r => esc(r.area || '') },
    { l: 'Task / activity', core: 1, td: r => `${esc(r.name)}${!allCols && r.pred_conflict ? ' <span class="pill warn" title="Starts before its predecessor finishes">!</span>' : ''}`, cls: 'g-task' },
    { l: 'Code', td: r => esc(r.cost_code || '') }, { l: 'Start', core: 1, td: r => wbDate(r.start_date) }, { l: 'Finish', core: 1, td: r => wbDate(r.finish_date) },
    { l: 'Work days', num: 1, td: r => r.work_days ?? '' },
    { l: 'Pred.', td: r => r.pred_ref ? `${esc(r.pred_ref)}${r.pred_conflict ? ' <span class="pill warn" title="Starts before its predecessor finishes">!</span>' : ''}` : '' },
    { l: 'Responsible', td: r => esc(r.responsible || '') }, { l: 'Budget hrs', num: 1, core: 1, td: r => n1(r.budget_hours) }, { l: '% complete', num: 1, core: 1, td: pctCell },
    { l: 'Earned hrs', num: 1, td: r => n1(r.earned_hours) }, { l: 'Planned %', num: 1, td: r => r.planned_pct == null ? '' : n1(r.planned_pct) + '%' }, { l: 'Planned hrs', num: 1, td: r => n1(r.planned_hours) },
    { l: 'Actual hrs', num: 1, core: 1, td: r => n1(r.actual_hours) }, { l: 'Hrs variance', num: 1, td: r => n1(r.hours_variance), st: r => r.hours_variance < 0 ? 'color:var(--bad)' : '' },
    { l: 'SPI', num: 1, core: 1, td: r => r.spi ?? '', st: r => r.spi != null && r.spi < 0.9 ? 'color:var(--bad);font-weight:600' : '' },
    { l: 'Status', core: 1, td: r => `<span class="pill ${SCHED_TONE[r.status] ?? ''}">${esc(r.status)}</span>` }, { l: 'Float (days)', num: 1, td: r => r.float_days ?? '', st: r => r.float_days < 0 ? 'color:var(--bad)' : '' },
  ].filter(c => allCols || c.core);
  const fixed = C.length;
  W.innerHTML = `<div class="card"><div class="row spread"><h2>Schedule &amp; Gantt</h2><div class="row no-print">
      <label class="small muted">As of <input type="date" id="sasof" value="${esc(d.as_of)}"></label>
      <label class="small"><input type="checkbox" id="sla" ${la ? 'checked' : ''}> 3-week look-ahead</label>
      <label class="small"><input type="checkbox" id="scols" ${allCols ? 'checked' : ''}> All columns</label>
      ${d.can_edit ? '<button class="btn sm" id="sbuild">Build from budget</button><button class="btn primary sm" id="sadd">+ Task</button>' : ''}<button class="btn sm" id="scsv">CSV</button><button class="btn sm" onclick="print()">Print</button></div></div>
    <p class="small muted">Start, finish and budget hours drive the Gantt. Planned % is time-based against the as-of date; earned = budget × % complete; actual hours come from the time clock on the task's cost code (or its phase) between start and finish. SPI under 1 is behind.${d.can_progress && !d.can_edit ? ' You can update % complete for your tasks.' : ''}</p>
    <div class="grid g4" style="margin:12px 0">${kpi('Complete', t.pct_complete == null ? '—' : `${n1(t.pct_complete)}%`, `${n1(t.earned_hours)} of ${n1(t.budget_hours)} budget hrs earned`)}${kpi('SPI', t.spi ?? '—', `${n1(t.planned_hours)} hrs planned by ${wbDate(d.as_of)}`)}${kpi('Actual hours', n1(t.actual_hours), 'on scheduled codes, inside task dates')}${kpi('Needs attention', late + upd, `${late} late · ${upd} need % update`)}</div>
    <div class="small muted no-print" style="margin-bottom:8px">Gantt week 1: <b>${wbDate(d.weeks[0] && d.weeks[0].week_start)}</b>${d.can_edit ? ' <a href="#" id="sstart">change</a>' : ''} · planned crew = planned hrs ÷ (${d.cfg.hours_per_day} h/day × ${d.cfg.days_per_week} days × ${d.cfg.availability} availability) · max crew ${d.cfg.max_crew}</div>
    ${rows.length ? `<div class="gantt-wrap"><table class="gantt"><thead><tr><th colspan="${fixed}" class="g-fixh"></th>${monthHead}</tr>
      <tr>${C.map(c => `<th class="${c.num ? 'num' : ''} ${c.cls || ''}">${c.l}</th>`).join('')}${d.weeks.map(w => `<th class="g${w === wkNow ? ' g-now' : ''}" title="Week ${w.wk}: ${wbDate(w.week_start)} – ${wbDate(w.week_ending)}">${Number(w.week_start.slice(8))}</th>`).join('')}</tr></thead>
      <tbody>${rows.map(r => `<tr data-id="${r.id}" class="${d.can_edit ? 'click' : ''}">${C.map(c => `<td class="${c.num ? 'num' : ''} ${c.cls || ''}" style="${c.st ? c.st(r) : ''}">${c.td(r)}</td>`).join('')}
        ${d.weeks.map(w => cell(r, w)).join('')}</tr>`).join('')}</tbody>
      <tfoot>${[['Planned hrs', 'planned_hours'], ['Planned crew', 'planned_crew'], ['Actual hrs', 'actual_hours']].map(([lab, k]) => `<tr><td colspan="${fixed}" class="g-foot"><b>${lab}</b> <span class="small muted">by week</span></td>${d.weeks.map(w => `<td class="g gt${k === 'planned_crew' && w.over_max ? ' g-over' : ''}${w === wkNow ? ' g-now' : ''}" title="${esc(`Week ${w.wk} · ${lab}: ${w[k]}`)}">${w[k] ? Math.round(w[k]) : ''}</td>`).join('')}</tr>`).join('')}</tfoot>
      </table></div>`
    : `<div class="empty">${la ? 'Nothing in the 3-week look-ahead' : d.can_edit ? 'No tasks yet. "Build from budget" makes one task per budgeted labor cost code, or add tasks one at a time.' : 'No schedule yet'}</div>`}
    ${d.weeks.some(w => w.over_max) ? `<div class="alert" style="margin-top:10px">Planned crew is over the max crew of ${d.cfg.max_crew} in week(s) ${d.weeks.filter(w => w.over_max).map(w => w.wk).join(', ')} — spread those tasks out or raise the max on the Settings page.</div>` : ''}</div>`;
  $('#sasof', W).onchange = e => go('asof', e.target.value === todayStr() ? '' : e.target.value);
  $('#sla', W).onchange = e => go('la', e.target.checked ? '1' : '');
  $('#scols', W).onchange = e => go('cols', e.target.checked ? 'all' : '');
  $$('[data-pct]', W).forEach(inp => inp.onchange = async () => {
    const v = inp.value === '' ? null : Number(inp.value);
    if (v != null && (v < 0 || v > 100)) return toast('% complete is 0 to 100', 'error');
    if (await act(() => PUT(`/schedule/${inp.dataset.pct}`, { pct_complete: v }), 'Updated').catch(() => null)) route();
  });
  const csvCols = [['ref', 'Task ID'], ['job_number', 'Job#'], ['phase', 'Phase'], ['area', 'Area / WBS'], ['name', 'Task / Activity'], ['cost_code', 'Cost Code'], ['start_date', 'Start'], ['finish_date', 'Finish'],
    ['work_days', 'Work Days'], ['pred_ref', 'Pred.'], ['responsible', 'Responsible'], ['budget_hours', 'Budget Hrs'], ['pct_complete', '% Complete'], ['earned_hours', 'Earned Hrs'], ['planned_pct', 'Planned %'],
    ['planned_hours', 'Planned Hrs'], ['actual_hours', 'Actual Hrs'], ['hours_variance', 'Hrs Variance'], ['spi', 'SPI'], ['status', 'Status'], ['float_days', 'Float (days)'], ['notes', 'Notes']].map(([key, label]) => ({ key, label }));
  $('#scsv', W).onclick = () => toCSV(csvCols, rows, `${j.number}_schedule.csv`);
  if (!d.can_edit) return;
  const open = (r = {}) => {
    const others = d.rows.filter(x => x.id !== r.id).map(x => [x.id, `${x.ref} · ${x.name}`]);
    const m = formModal({ title: r.id ? `Edit ${r.ref}` : 'New task', values: { ...r, on_hold: !!r.on_hold }, wide: true,
      fields: [{ name: 'name', label: 'Task / activity', required: true, full: true }, { name: 'phase', label: 'Phase', type: 'select', options: d.lists.phases }, { name: 'area', label: 'Area / WBS' },
        { name: 'cost_code_id', label: 'Cost code (actual hours come from it)', type: 'select', options: ccOptions('labor') }, { name: 'responsible', label: 'Responsible' },
        { name: 'start_date', label: 'Start', type: 'date' }, { name: 'finish_date', label: 'Finish', type: 'date' }, { name: 'predecessor_id', label: 'Predecessor', type: 'select', options: others },
        { name: 'budget_hours', label: 'Budget hours', type: 'number' }, { name: 'pct_complete', label: '% complete (0–100)', type: 'number' }, { name: 'sort', label: 'Order', type: 'number' },
        { name: 'on_hold', label: 'On hold', type: 'checkbox' }, { name: 'notes', label: 'Notes', type: 'textarea', full: true }],
      extra: r.id ? '<button type="button" class="btn danger sm" id="sdel" style="margin-top:8px">Delete task</button>' : '',
      submit: async v => { v.on_hold = v.on_hold ? 1 : 0; if (r.id) await PUT(`/schedule/${r.id}`, v); else await POST(`/projects/${j.id}/schedule`, v); toast('Saved'); route(); } });
    const x = $('#sdel', m.el); if (x) x.onclick = async () => { if (confirm(`Delete ${r.ref} ${r.name}?`)) { await act(() => DEL(`/schedule/${r.id}`), 'Deleted'); m.close(); route(); } };
  };
  $('#sadd', W).onclick = () => open({});
  $$('tbody tr[data-id]', W).forEach(tr => tr.onclick = e => { if (!e.target.closest('input,a,button')) open(d.rows.find(r => r.id === Number(tr.dataset.id))); });
  $('#sbuild', W).onclick = async () => { const r = await act(() => POST(`/projects/${j.id}/schedule/build`)).catch(() => null); if (r) { toast(`Added ${r.added} task(s) — set their start and finish dates`); route(); } };
  if ($('#sstart', W)) $('#sstart', W).onclick = e => { e.preventDefault();
    formModal({ title: 'Gantt start (week 1)', values: { schedule_start: d.schedule_start || '' }, fields: [{ name: 'schedule_start', label: 'Week of (snaps to Monday; blank = first task start)', type: 'date' }],
      submit: async v => { await PUT(`/projects/${j.id}/schedule-start`, v); route(); } }); };
}

// ------------------------------------------------------------ Manpower Loading
// Planned crew = planned hrs ÷ (hrs/day × days/wk × availability); actual crew = actual hrs ÷ (hrs/day × days/wk).
// Weeks needing more than the max crew are flagged. Shared by the project sheet and the all-projects view.
function crewChart(weeks, cfg, today) {
  const top = Math.max(cfg.max_crew, ...weeks.map(w => Math.max(w.planned_crew, w.actual_crew))) * 1.1 || 1, H = 110;
  const y = v => Math.round(v / top * H);
  return `<div class="crew-chart" role="img" aria-label="Planned and actual crew by week">
    <div class="cc-max" style="bottom:${y(cfg.max_crew) + 18}px"><span>max crew ${cfg.max_crew}</span></div>
    ${weeks.map(w => `<div class="cc-wk${w.week_start <= today && w.week_ending >= today ? ' now' : ''}" title="${esc(`Week ${w.wk} (${wbDate(w.week_start)} – ${wbDate(w.week_ending)})\nPlanned crew ${w.planned_crew} · ${w.planned_hours} hrs\nActual crew ${w.actual_crew} · ${w.actual_hours} hrs`)}">
      <div class="cc-bars" style="height:${H}px"><i class="p${w.over_max ? ' over' : ''}" style="height:${y(w.planned_crew)}px"></i><i class="a" style="height:${y(w.actual_crew)}px"></i></div>
      <div class="cc-lab">${Number(w.week_start.slice(5, 7))}/${Number(w.week_start.slice(8))}</div></div>`).join('')}
  </div><div class="cc-legend small"><span><i class="p"></i>Planned crew (from the schedule)</span><span><i class="a"></i>Actual crew (time clock)</span><span><i class="p over"></i>Over max crew</span></div>`;
}
const shortD = d => new Date(d + 'T12:00:00Z').toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
function manpowerTable(weeks, classes, { cum = true } = {}) {
  const n1 = v => v == null || v === 0 ? '' : Number(v).toLocaleString(undefined, { maximumFractionDigits: 1 });
  const cols = [{ label: 'Wk', key: 'wk' }, { label: 'Week start', get: r => shortD(r.week_start), csv: r => r.week_start }, { label: 'Week ending', get: r => shortD(r.week_ending), csv: r => r.week_ending },
    { label: 'Planned hrs', num: 1, get: r => n1(r.planned_hours), csv: r => r.planned_hours }, { label: 'Planned crew', num: 1, html: r => r.over_max ? `<b style="color:var(--bad)">${r.planned_crew}</b>` : n1(r.planned_crew), csv: r => r.planned_crew },
    { label: 'Actual hrs', num: 1, get: r => n1(r.actual_hours), csv: r => r.actual_hours }, { label: 'Actual crew', num: 1, get: r => n1(r.actual_crew), csv: r => r.actual_crew },
    { label: 'Variance hrs', num: 1, html: r => r.variance_hours ? `<span style="color:${r.variance_hours > 0 ? 'var(--bad)' : 'inherit'}">${n1(r.variance_hours)}</span>` : '', csv: r => r.variance_hours },
    ...(cum ? [{ label: 'Cum planned', num: 1, get: r => n1(r.cum_planned), csv: r => r.cum_planned }, { label: 'Cum actual', num: 1, get: r => n1(r.cum_actual), csv: r => r.cum_actual }] : []),
    ...classes.map(c => ({ label: `${c} hrs`, num: 1, get: r => n1(r.by_class[c]), csv: r => r.by_class[c] })),
    { label: 'OT hrs', num: 1, get: r => n1(r.ot_hours), csv: r => r.ot_hours }, { label: 'OT %', num: 1, get: r => r.ot_pct ? r.ot_pct + '%' : '', csv: r => r.ot_pct ?? '' },
    { label: 'People', num: 1, get: r => r.headcount || '', csv: r => r.headcount }, { label: 'Over max crew?', html: r => r.over_max ? '<span class="pill bad">OVER</span>' : '', csv: r => r.over_max ? 'OVER' : '' }];
  return cols;
}
async function wbManpower(j, W) {
  const d = await GET(`/projects/${j.id}/manpower`), t = d.totals, cols = manpowerTable(d.weeks, d.classes);
  const n1 = v => Number(v || 0).toLocaleString(undefined, { maximumFractionDigits: 1 });
  W.innerHTML = `<div class="card"><div class="row spread"><h2>Manpower Loading</h2><div class="row no-print"><button class="btn sm" id="mcsv">CSV</button><button class="btn sm" onclick="print()">Print</button></div></div>
    <p class="small muted">Planned hours come from the Schedule (each task's budget hours spread over its dates). Planned crew = planned hrs ÷ (${d.cfg.hours_per_day} h/day × ${d.cfg.days_per_week} days × ${d.cfg.availability} availability); actual crew = actual hrs ÷ (${d.cfg.hours_per_day} × ${d.cfg.days_per_week}). Class comes from the job's foreman and each employee's title; OT is hours past the weekly overtime threshold across all their jobs.</p>
    <div class="grid g4" style="margin:12px 0">${kpi('Planned hours', n1(t.planned_hours), 'scheduled, whole job')}${kpi('Actual hours', n1(t.actual_hours), d.classes.filter(c => t.by_class[c]).map(c => `${c} ${n1(t.by_class[c])}`).join(' · ') || 'none yet')}
      ${kpi('Overtime', n1(t.ot_hours), t.actual_hours ? `${Math.round(t.ot_hours / t.actual_hours * 1000) / 10}% of actual hours` : '')}${kpi('Peak crew ahead', d.peak_planned_crew_remaining, d.weeks_over_max ? `<span style="color:var(--bad)">${d.weeks_over_max} week(s) over max crew ${d.cfg.max_crew}</span>` : `max crew ${d.cfg.max_crew}`)}</div>
    ${d.weeks.some(w => w.planned_hours || w.actual_hours) ? crewChart(d.weeks, d.cfg, todayStr()) : '<div class="empty">No scheduled or actual hours yet — add tasks with dates and budget hours on the Schedule sheet.</div>'}
    <div style="margin-top:12px">${table(cols, d.weeks)}</div></div>`;
  $('#mcsv', W).onclick = () => toCSV(cols, d.weeks, `${j.number}_manpower.csv`);
}

// ------------------------------------------------------------ Weekly History & trends
// Cumulative S-curve (planned / earned / actual) with a crosshair tooltip, and the workbook's weekly table.
function sCurve(weeks, series, fmt) {
  const pts = weeks.length; if (pts < 2) return '<div class="empty">Trends appear after the second week</div>';
  const Wd = 760, Hd = 220, L = 56, R = 12, T = 10, B = 26, w = Wd - L - R, h = Hd - T - B;
  const max = Math.max(1, ...series.flatMap(s => weeks.map(x => x[s.key] || 0))) * 1.08;
  const X = i => L + (pts === 1 ? w / 2 : i / (pts - 1) * w), Y = v => T + h - v / max * h;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map(f => max / 1.08 * f);
  const every = Math.ceil(pts / 8);
  const path = s => { let d = '', pen = false; weeks.forEach((x, i) => { const v = x[s.key]; if (v == null) { pen = false; return; } d += `${pen ? 'L' : 'M'}${X(i).toFixed(1)},${Y(v).toFixed(1)}`; pen = true; }); return d; };
  return `<svg class="scurve" viewBox="0 0 ${Wd} ${Hd}" role="img" aria-label="${esc(series.map(s => s.label).join(', '))} by week">
    <g class="grid">${ticks.map(t => `<line x1="${L}" x2="${Wd - R}" y1="${Y(t)}" y2="${Y(t)}"/><text x="${L - 6}" y="${Y(t) + 4}" text-anchor="end">${fmt(t, true)}</text>`).join('')}</g>
    ${weeks.map((x, i) => i % every === 0 || i === pts - 1 ? `<text x="${X(i)}" y="${Hd - 8}" text-anchor="middle">${Number(x.week_ending.slice(5, 7))}/${Number(x.week_ending.slice(8))}</text>` : '').join('')}
    ${series.map(s => `<path class="ln" d="${path(s)}" stroke="var(${s.color})"/>`).join('')}
    ${weeks.map((x, i) => `<g class="col" data-i="${i}"><rect class="hit" x="${X(i) - w / pts / 2}" y="${T}" width="${w / pts}" height="${h}"/><line class="xh" x1="${X(i)}" x2="${X(i)}" y1="${T}" y2="${T + h}"/>
      ${series.map(s => x[s.key] == null ? '' : `<circle class="dot" cx="${X(i)}" cy="${Y(x[s.key])}" r="4" fill="var(${s.color})"/>`).join('')}</g>`).join('')}
  </svg><div class="sc-legend">${series.map(s => `<span><i style="background:var(${s.color})"></i>${esc(s.label)}</span>`).join('')}</div>`;
}
function sCurveTips(el, weeks, series, fmt) {
  let tip = $('.sc-tip'); if (!tip) { tip = document.createElement('div'); tip.className = 'sc-tip'; document.body.appendChild(tip); }
  $$('.scurve g.col', el).forEach(g => {
    const x = weeks[Number(g.dataset.i)];
    g.onmousemove = e => { tip.style.display = 'block'; tip.style.left = Math.min(e.clientX + 14, innerWidth - 220) + 'px'; tip.style.top = (e.clientY + 12) + 'px';
      tip.innerHTML = `<b>Week ending ${esc(wbDate(x.week_ending))}</b>${series.map(s => `<div><i style="background:var(${s.color})"></i>${esc(s.label)}: <b>${x[s.key] == null ? '—' : fmt(x[s.key])}</b></div>`).join('')}`; };
    g.onmouseleave = () => { tip.style.display = 'none'; };
  });
}
async function wbHistory(j, W) {
  const d = await GET(`/projects/${j.id}/weekly-history`), seeCost = can('see_costs'), editPct = isOffice() && can('projects');
  const weeks = d.weeks, last = weeks[weeks.length - 1] || {};
  const n1 = v => v == null ? '' : Number(v).toLocaleString(undefined, { maximumFractionDigits: 1 });
  const m0 = (v, short) => v == null ? '—' : short && Math.abs(v) >= 1000 ? '$' + (v / 1000).toLocaleString(undefined, { maximumFractionDigits: 0 }) + 'k' : money0(v);
  const h0 = (v, short) => v == null ? '—' : Math.round(v).toLocaleString() + (short ? '' : ' hrs');
  const series = seeCost ? [{ key: 'pv', label: 'Planned value (PV)', color: '--s1' }, { key: 'ev', label: 'Earned value (EV)', color: '--s2' }, { key: 'ac', label: 'Actual cost (AC)', color: '--s3' }]
    : [{ key: 'planned_hours', label: 'Planned hours', color: '--s1' }, { key: 'earned_hours', label: 'Earned hours', color: '--s2' }, { key: 'actual_hours', label: 'Actual hours', color: '--s3' }];
  const fmt = seeCost ? m0 : h0;
  const idx = v => v == null ? '' : `<span style="${v < 0.9 ? 'color:var(--bad);font-weight:600' : ''}">${v.toFixed(2)}</span>`;
  const cols = [{ label: 'Wk', key: 'wk' }, { label: 'Week ending', get: r => shortD(r.week_ending), csv: r => r.week_ending },
    ...(seeCost ? [{ label: 'Revised contract', num: 1, get: r => money0(r.revised_contract), csv: r => r.revised_contract }, { label: 'Revised budget cost', num: 1, get: r => money0(r.revised_budget), csv: r => r.revised_budget }] : []),
    { label: '% complete', num: 1, html: r => editPct ? `<input type="number" class="pct-in" min="0" max="100" step="0.5" data-wk="${r.week_ending}" value="${r.pct_complete ?? ''}" title="${r.pct_source === 'manual' ? 'Typed in' + (r.pct_note ? ': ' + esc(r.pct_note) : '') : r.pct_source === 'auto' ? 'Recorded automatically that week' : 'Hours burned ÷ budget hours (nothing recorded that week)'}"><span class="small muted"> ${r.pct_source === 'manual' ? '✎' : r.pct_source === 'auto' ? '●' : '≈'}</span>` : r.pct_complete == null ? '' : `${n1(r.pct_complete)}%`, csv: r => r.pct_complete },
    ...(seeCost ? [{ label: 'PV', num: 1, get: r => r.pv == null ? '' : money0(r.pv), csv: r => r.pv }, { label: 'EV', num: 1, get: r => r.ev == null ? '' : money0(r.ev), csv: r => r.ev }, { label: 'AC', num: 1, get: r => money0(r.ac), csv: r => r.ac },
      { label: 'Open commit', num: 1, get: r => r.open_commit ? money0(r.open_commit) : '', csv: r => r.open_commit }, { label: 'CPI', num: 1, html: r => idx(r.cpi), csv: r => r.cpi ?? '' }] : []),
    { label: 'Planned hrs', num: 1, get: r => n1(r.planned_hours), csv: r => r.planned_hours }, { label: 'Earned hrs', num: 1, get: r => n1(r.earned_hours), csv: r => r.earned_hours },
    { label: 'Actual hrs', num: 1, get: r => n1(r.actual_hours), csv: r => r.actual_hours }, { label: 'SPI', num: 1, html: r => idx(r.spi), csv: r => r.spi ?? '' },
    ...(seeCost ? [{ label: 'Projected cost', num: 1, get: r => r.projected_cost == null ? '' : money0(r.projected_cost), csv: r => r.projected_cost }, { label: 'Proj. margin', num: 1, get: r => r.projected_margin_pct == null ? '' : r.projected_margin_pct + '%', csv: r => r.projected_margin_pct },
      { label: 'Billed to date', num: 1, get: r => money0(r.billed), csv: r => r.billed }, { label: 'Cash received', num: 1, get: r => money0(r.cash), csv: r => r.cash }, { label: 'Pending CO', num: 1, get: r => r.pending_co ? money0(r.pending_co) : '', csv: r => r.pending_co }] : []),
    { label: 'Open RFIs', num: 1, get: r => r.open_rfis || '', csv: r => r.open_rfis }, { label: 'Open safety', num: 1, get: r => r.open_safety || '', csv: r => r.open_safety }, { label: 'Crew', num: 1, get: r => n1(r.crew), csv: r => r.crew }];
  W.innerHTML = `<div class="card"><div class="row spread"><h2>Weekly History &amp; Trends</h2><div class="row no-print"><button class="btn sm" id="hcsv">CSV</button><button class="btn sm" onclick="print()">Print</button></div></div>
    <p class="small muted">Every week recalculates from the logs, cumulative through its week ending. % complete is what was recorded that week (● captured automatically each week, ✎ typed in); weeks with nothing recorded use hours burned ÷ budget hours (≈).${editPct ? ' Type over any week with the progress you actually reported to the GC — that makes CPI and the earned-value curve yours rather than a proxy. Clear it to go back to automatic.' : ''}</p>
    <div class="grid g4" style="margin:12px 0">${seeCost ? kpi('CPI', last.cpi == null ? '—' : last.cpi.toFixed(2), 'earned ÷ actual cost') : kpi('% complete', last.pct_complete == null ? '—' : n1(last.pct_complete) + '%', '')}${kpi('SPI', last.spi == null ? '—' : last.spi.toFixed(2), 'earned ÷ planned hours')}
      ${seeCost ? kpi('Projected margin', last.projected_margin_pct == null ? '—' : last.projected_margin_pct + '%', last.projected_cost == null ? '' : `projected cost ${money0(last.projected_cost)}`) : kpi('Actual hours', n1(last.actual_hours), `of ${n1(d.budget_hours)} budgeted`)}
      ${kpi('Weeks tracked', weeks.length, `${weeks.filter(w => w.pct_source !== 'hours').length} with recorded progress`)}</div>
    ${sCurve(weeks, series, fmt)}
    <div style="margin-top:12px">${table(cols, weeks.slice().reverse())}</div></div>`;
  sCurveTips(W, weeks, series, v => fmt(v));
  $('#hcsv', W).onclick = () => toCSV(cols, weeks, `${j.number}_weekly_history.csv`);
  $$('[data-wk]', W).forEach(inp => inp.onchange = async () => {
    const v = inp.value;
    if (v !== '' && (Number(v) < 0 || Number(v) > 100)) return toast('% complete is 0 to 100', true);
    const note = v === '' ? null : prompt('Note for this week (optional, e.g. "per GC walk 11/6")', '') || null;
    if (await act(() => PUT(`/projects/${j.id}/progress`, { week_ending: inp.dataset.wk, pct_complete: v, note }), v === '' ? 'Back to automatic' : 'Recorded').catch(() => null)) route();
  });
}

// ------------------------------------------------------------ Bi-Weekly Report (printable)
async function wbReport(j, W) {
  const { params } = hashParams();
  const pe = params.get('pe') || todayStr(), gc = params.get('gc') === '1';
  const [r, list] = await Promise.all([GET(`/projects/${j.id}/biweekly${qs({ period_end: pe, gc: gc ? '1' : '' })}`), GET(`/projects/${j.id}/reports`)]);
  const d = r.data, rep = r.report || {}, issued = rep.status === 'issued', F = d.financial, P = d.production, I = d.info, editable = !issued && can('projects');
  const go = (k, v) => { const p = new URLSearchParams(params); if (v) p.set(k, v); else p.delete(k); location.hash = `#/jobs/${j.id}?${p}`; };
  const m0 = v => v == null ? '—' : money0(v), n1 = v => v == null ? '—' : Number(v).toLocaleString(undefined, { maximumFractionDigits: 1 });
  const pc = v => v == null ? '—' : `${n1(v)}%`, ix = v => v == null ? '—' : Number(v).toFixed(2), dt = v => v ? wbDate(v) : '—';
  const pair = (a, b) => `<tr>${a ? `<th>${a[0]}</th><td>${a[1]}</td>` : '<th></th><td></td>'}${b ? `<th>${b[0]}</th><td>${b[1]}</td>` : '<th></th><td></td>'}</tr>`;
  const sect = (n, title, body) => `<section class="rp-sec"><h3>${n}.&nbsp; ${title}</h3>${body}</section>`;
  const grid = (cols, rows, empty) => rows.length ? `<table class="rp-grid"><thead><tr>${cols.map(c => `<th class="${c.num ? 'num' : ''}">${c.l}</th>`).join('')}</tr></thead>
    <tbody>${rows.map((x, i) => `<tr>${cols.map(c => `<td class="${c.num ? 'num' : ''}">${c.v(x, i)}</td>`).join('')}</tr>`).join('')}</tbody></table>` : `<p class="muted small">${empty}</p>`;
  const addr = [I.address, [I.city, I.state].filter(Boolean).join(', '), I.zip].filter(Boolean).join(' ');
  const cmp = d.company || {};
  const fin = gc ? [pair(['Original contract', m0(F.original_contract)], ['Billed to date', m0(F.billed)]), pair(['Approved change orders', m0(F.approved_co)], ['Retainage held', m0(F.retainage_held)]),
      pair(['Revised contract', `<b>${m0(F.revised_contract)}</b>`], ['Payments received', m0(F.cash)]), pair(['Pending change orders', m0(F.pending_co)], ['% complete', pc(F.pct_complete)]), pair(['SPI', ix(F.spi)], ['Labor hours used', n1(F.hours_used)])]
    : [pair(['Original contract', m0(F.original_contract)], ['Billed to date', m0(F.billed)]), pair(['Approved change orders', m0(F.approved_co)], ['Retainage held', m0(F.retainage_held)]),
      pair(['Revised contract', `<b>${m0(F.revised_contract)}</b>`], ['Cash received', m0(F.cash)]), pair(['Budget cost', m0(F.budget_cost)], ['Over / (under) billed', F.over_under == null ? '—' : F.over_under < 0 ? `(${m0(-F.over_under)})` : m0(F.over_under)]),
      pair(['Actual cost to date', m0(F.actual_cost)], ['Pending change orders', m0(F.pending_co)]), pair(['Open commitments', m0(F.open_commit)], ['% complete', pc(F.pct_complete)]),
      pair(['Projected cost (EAC)', m0(F.projected_cost)], ['CPI', ix(F.cpi)]), pair(['Projected margin', m0(F.projected_margin)], ['SPI', ix(F.spi)]),
      pair(['Projected margin %', pc(F.projected_margin_pct)], ['Labor hours used / budget', `${n1(F.hours_used)} / ${n1(F.budget_hours)}`])];
  const phaseTot = !gc && d.phases ? d.phases.reduce((t, x) => { for (const k of ['budget', 'earned', 'actual', 'commit', 'variance', 'projected']) t[k] = (t[k] || 0) + x[k]; return t; }, {}) : null;
  let sn = 0; const N = () => ++sn;
  const narrative = [['progress', 'Progress this period'], ['plan_next', 'Plan for next period'], ['issues', 'Issues & risks'], ['decisions', 'Decisions needed from the GC / owner'], ['notes', 'Notes']];
  W.innerHTML = `<div class="card no-print" style="margin-bottom:12px"><div class="row spread" style="flex-wrap:wrap;gap:10px">
      <div class="row" style="flex-wrap:wrap;gap:10px"><label class="small muted">Period ending <input type="date" id="rpe" value="${esc(pe)}" max="${todayStr()}"></label>
        ${list.length ? `<select id="rpast"><option value="">Saved reports…</option>${list.map(x => `<option value="${x.period_end}">${wbDate(x.period_end)} · ${x.status === 'issued' ? 'issued' : 'draft'}</option>`).join('')}</select>` : ''}
        ${r.can_see_costs ? `<label class="small"><input type="checkbox" id="rgc" ${gc ? 'checked' : ''}> GC copy (hide our costs &amp; margin)</label>` : ''}</div>
      <div class="row">${issued ? `<span class="pill good">Issued ${wbDate(rep.issued_at)}</span>${S.user.role === 'admin' ? '<button class="btn sm" id="rreopen">Reopen</button>' : ''}`
        : `${editable ? '<button class="btn sm" id="rsave">Save narrative</button><button class="btn primary sm" id="rissue">Issue report</button>' : ''}`}<button class="btn sm" onclick="print()">Print / PDF</button></div></div>
      <p class="small muted" style="margin:8px 0 0">${issued ? 'This report was issued: its numbers are frozen as they were that day, so it always matches what was sent.' : 'Live numbers. Type the narrative, save, then <b>Issue</b> to freeze the numbers before you send it.'}${r.can_see_costs ? ' Tick <b>GC copy</b> before printing for a GC or owner — it leaves out budget, cost, commitments, margin and cost by phase.' : ''}</p></div>
    <div class="card report-doc">
      <div class="rp-head"><div><h1>Bi-Weekly Project Report</h1><div class="small muted">${esc(cmp.company_name || '')}${cmp.company_address ? ` &nbsp;|&nbsp; ${esc(cmp.company_address)}` : ''}${cmp.company_phone ? ` &nbsp;|&nbsp; ${esc(cmp.company_phone)}` : ''}</div></div>
        <div class="rp-per"><b>Job ${esc(I.number)} — ${esc(I.title)}</b><div>Period: ${wbDate(d.period_start)} to ${wbDate(d.period_end)}</div>${gc ? '<div class="small muted">GC / owner copy</div>' : ''}</div></div>
      ${sect(N(), 'Project information', `<table class="rp-kv">${pair(['Client / GC', esc(I.company || I.customer_name)], ['Address', esc(addr || '—')])}${pair(['Project manager', esc(I.pm_name || '—')], ['Foreman', esc(I.foreman_name || '—')])}
        ${pair(['Status', esc(String(I.status || '').replace(/_/g, ' ').replace(/^./, ch => ch.toUpperCase()))], ['Contract start', dt(I.start_date)])}${pair(['Contract finish', dt(I.end_date)], ['GC contact', esc([I.gc_contact, I.gc_phone].filter(Boolean).join(' · ') || '—')])}</table>`)}
      ${sect(N(), 'Financial summary', `<table class="rp-kv">${fin.join('')}</table>`)}
      ${!gc && d.phases ? sect(N(), 'Cost by phase', grid([{ l: 'Phase', v: x => x.total ? '<b>TOTAL</b>' : `${esc(x.phase)}&nbsp; ${esc(x.name)}` }, { l: 'Budget $', num: 1, v: x => m0(x.budget) }, { l: 'Earned $', num: 1, v: x => m0(x.earned) }, { l: 'Actual $', num: 1, v: x => m0(x.actual) },
        { l: 'Commit $', num: 1, v: x => m0(x.commit) }, { l: 'Variance $', num: 1, v: x => x.variance < 0 ? `<span style="color:var(--bad)">(${m0(-x.variance)})</span>` : m0(x.variance) }, { l: 'CPI', num: 1, v: x => x.cpi == null ? '' : x.cpi.toFixed(2) },
        { l: '% compl', num: 1, v: x => x.pct == null ? '' : x.pct + '%' }, { l: 'Projected $', num: 1, v: x => m0(x.projected) }], [...d.phases, { total: true, ...phaseTot, cpi: phaseTot.actual ? phaseTot.earned / phaseTot.actual : null, pct: phaseTot.budget ? Math.round(phaseTot.earned / phaseTot.budget * 1000) / 10 : null }], '')) : ''}
      ${sect(N(), `Production this period <span class="muted small">(${wbDate(P.from)} – ${wbDate(P.to)})</span>`, `<table class="rp-kv">${pair(['Labor hours', n1(P.labor_hours)], gc ? ['People on site', P.people] : ['Material / sub cost', m0(P.material_cost)])}
        ${pair(['Overtime hours', n1(P.ot_hours)], ['Average crew size', n1(P.avg_crew)])}${pair(gc ? null : ['Labor cost', m0(P.labor_cost)], ['Peak planned crew, rest of schedule', n1(P.peak_planned_crew)])}</table>`)}
      ${sect(N(), 'Look-ahead — open tasks in the next two weeks', grid([{ l: '#', v: (x, i) => i + 1 }, { l: 'Task', v: x => `${esc(x.ref)} ${esc(x.name)}` }, { l: 'Cost code', v: x => esc(x.cost_code || '') }, { l: 'Start', v: x => dt(x.start_date) }, { l: 'Finish', v: x => dt(x.finish_date) },
        { l: 'Budget hrs', num: 1, v: x => n1(x.budget_hours) }, { l: '% compl', num: 1, v: x => x.pct_complete == null ? '—' : x.pct_complete + '%' }, { l: 'Actual hrs', num: 1, v: x => n1(x.actual_hours) }, { l: 'SPI', num: 1, v: x => x.spi ?? '' }, { l: 'Status', v: x => statusPill(x.status) }], d.lookahead, 'Nothing scheduled in the look-ahead window.'))}
      ${sect(N(), 'Milestones — open', grid([{ l: '#', v: (x, i) => i + 1 }, { l: 'Milestone', v: x => esc(x.name) }, { l: 'Owner', v: x => esc(x.owner || '') }, { l: 'Baseline', v: x => dt(x.baseline_date) }, { l: 'Forecast', v: x => dt(x.forecast_date) },
        { l: 'Variance', num: 1, v: x => x.variance_days == null ? '' : x.variance_days > 0 ? `+${x.variance_days}` : x.variance_days }, { l: 'Days to go', num: 1, v: x => x.days_to_go ?? '' }, { l: 'Status', v: x => statusPill(x.status) }, { l: 'Critical', v: x => x.critical ? 'Yes' : '' }], d.milestones, 'No open milestones.'))}
      ${sect(N(), 'Open RFIs &amp; submittals', grid([{ l: '#', v: x => esc(x.ref) }, { l: 'Subject', v: x => esc(x.subject) }, { l: 'Type', v: x => esc(x.type || '') }, { l: 'No.', v: x => esc(x.number || '') }, { l: 'Sent', v: x => dt(x.date_sent) }, { l: 'Needed', v: x => dt(x.date_needed) },
        { l: 'Days open', num: 1, v: x => x.days_open ?? '' }, { l: 'Days late', num: 1, v: x => x.days_late ? `<b style="color:var(--bad)">${x.days_late}</b>` : '' }, { l: 'Ball in court', v: x => esc(x.ball_in_court || '') }, { l: 'Cost impact', num: 1, v: x => x.cost_impact ? m0(x.cost_impact) : '' }], d.rfis, 'No open RFIs or submittals.'))}
      ${sect(N(), 'Change orders — not yet executed', grid([{ l: 'CO #', v: x => esc(x.number || x.co_no) }, { l: 'Description', v: x => esc(x.description || '') }, { l: 'Type', v: x => esc(x.type || '') }, { l: 'Status', v: x => statusPill(x.status) },
        { l: 'Sell $', num: 1, v: x => m0(x.sell_price) }, ...(gc ? [] : [{ l: 'Cost $', num: 1, v: x => m0(x.total_cost) }, { l: 'Margin %', num: 1, v: x => x.margin_pct == null ? '' : x.margin_pct + '%' }]),
        { l: 'Days added', num: 1, v: x => x.days_added ?? '' }, { l: 'Submitted', v: x => dt(x.submitted) }], d.change_orders, 'No change orders waiting.'))}
      ${sect(N(), 'Open safety &amp; quality items', grid([{ l: '#', v: x => esc(x.ref_id) }, { l: 'Description', v: x => esc(x.description) }, { l: 'Type', v: x => esc(x.type) }, { l: 'Severity', v: x => esc(x.severity || '') }, { l: 'Date', v: x => dt(x.date) },
        { l: 'Due', v: x => dt(x.due_date) }, { l: 'Days open', num: 1, v: x => x.days_open ?? '' }, { l: 'Owner', v: x => esc(x.owner || '') }, { l: 'Status', v: x => statusPill(x.status) }, { l: 'Corrective action', v: x => esc(x.corrective_action || '') }], d.safety, 'No open safety or quality items.'))}
      ${sect(N(), 'Narrative', `<form id="rnf">${narrative.map(([k, l]) => `<div class="rp-narr"><h4>${l}</h4>${editable ? `<textarea name="${k}" rows="3" class="no-print-border">${esc(rep[k] || '')}</textarea><div class="print-only">${esc(rep[k] || '')}</div>` : `<div class="rp-text">${esc(rep[k] || '—')}</div>`}</div>`).join('')}</form>`)}
      <table class="rp-kv" style="margin-top:14px">${pair(['Prepared by', esc(rep.prepared_by_name || I.pm_name || S.user.name)], ['Date', wbDate(issued ? rep.issued_at : d.period_end)])}</table>
    </div>`;
  $('#rpe', W).onchange = e => go('pe', e.target.value === todayStr() ? '' : e.target.value);
  if ($('#rpast', W)) $('#rpast', W).onchange = e => e.target.value && go('pe', e.target.value);
  if ($('#rgc', W)) $('#rgc', W).onchange = e => go('gc', e.target.checked ? '1' : '');
  const narr = () => Object.fromEntries(narrative.map(([k]) => [k, $(`[name=${k}]`, W).value]));
  if ($('#rsave', W)) $('#rsave', W).onclick = async () => { await act(() => PUT(`/projects/${j.id}/biweekly`, { period_end: pe, ...narr() }), 'Narrative saved').catch(() => null); };
  if ($('#rissue', W)) $('#rissue', W).onclick = async () => {
    if (!confirm(`Issue the report for the period ending ${wbDate(pe)}? Its numbers will be frozen as they are now.`)) return;
    try { await PUT(`/projects/${j.id}/biweekly`, { period_end: pe, ...narr() }); await act(() => POST(`/projects/${j.id}/biweekly/issue`, { period_end: pe }), 'Report issued'); route(); } catch (e) { toast(e.message, true); }
  };
  if ($('#rreopen', W)) $('#rreopen', W).onclick = async () => { if (confirm('Reopen this report? The frozen numbers are discarded and it goes back to live numbers.')) { await act(() => POST(`/project-reports/${rep.id}/reopen`), 'Reopened').catch(() => null); route(); } };
}

// ------------------------------------------------------------ Estimate Import → Import Quote → budget
async function wbImport(j, W) {
  const seeCost = can('see_costs');
  const q = await GET(`/projects/${j.id}/quote-lines`);
  let pv = null, overrides = {};
  const m0 = v => seeCost ? money0(v) : '—', n1 = v => v == null ? '' : Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 });
  W.innerHTML = `<div class="card"><div class="row spread"><h2>Estimate Import</h2></div>
      <p class="small muted">Copy each scope tab's line items from the quote workbook (columns A–P: Phase Code, Phase, Tag, Description, Qty, Unit, Material $/Unit, NECA Hrs/Unit, Prod. Factor, Adj. Hrs/Unit, Labor $/Unit, Total Unit Cost, Ext. Material, Ext. Labor $, Ext. Cost, Notes) and paste them below — one tab at a time or stacked. The cost code is read from the Phase Code (<code>LAB-P2-0810-L</code>, <code>0810-L</code> or <code>0810</code>); subtotal and no-quantity rows are skipped. A CSV in the same column order works too.</p>
      <div class="form-grid" style="margin-top:8px"><label class="f"><span>Scope tab / quote file</span><input id="qsrc" placeholder="e.g. Rough-In tab, Quote rev 2"></label>
        <label class="f"><span>…or load a CSV</span><input type="file" id="qfile" accept=".csv,.tsv,.txt"></label>
        <label class="f full"><span>Paste quote rows</span><textarea id="qtext" rows="7" placeholder="Paste from Excel here" style="font-family:ui-monospace,monospace;font-size:12px"></textarea></label></div>
      <div class="row" style="margin-top:8px"><button class="btn primary" id="qprev">Preview</button></div>
      <div id="qpv"></div></div>
    <div class="card" style="margin-top:14px"><div class="row spread"><h2>Import Quote — the budget's source</h2>${q.rows.length ? '<button class="btn sm" id="qcsv">CSV</button>' : ''}</div>
      <p class="small muted">Every imported line, as it fed the cost-code budget. Undo an import to take its hours and dollars back out of the budget.</p>
      ${q.imports.length ? table([{ label: 'Imported', get: x => wbDate(x.imported_at) }, { label: 'Source', get: x => x.source || '—' }, { label: 'Lines', num: 1, key: 'lines' },
        { label: 'Total', num: 1, get: x => m0(x.total) }, { label: '', html: x => `<button class="btn sm danger" data-undo="${esc(x.import_id)}">Undo</button>` }], q.imports) : ''}
      <div style="margin-top:10px">${table([{ label: 'Area', key: 'area' }, { label: 'Phase', key: 'phase' }, { label: 'Code', html: r => `<b>${esc(r.cost_code || '')}</b> <span class="small muted">${esc(r.cost_code_name || '')}</span>` }, { label: 'Type', key: 'cost_type' },
        { label: 'Tag', key: 'tag' }, { label: 'Description', key: 'description' }, { label: 'Qty', num: 1, get: r => n1(r.qty) }, { label: 'Unit', key: 'unit' }, { label: 'Hrs/unit', num: 1, get: r => n1(r.hours_unit) },
        { label: 'Ext material', num: 1, get: r => m0(r.ext_material) }, { label: 'Ext hrs', num: 1, get: r => n1(r.ext_hours) }, { label: 'Ext labor', num: 1, get: r => m0(r.ext_labor) }, { label: 'Ext total', num: 1, get: r => m0(r.ext_total) }, { label: 'Source', key: 'source' }],
        q.rows, { empty: 'Nothing imported yet — the budget on the Cost Codes sheet was entered by hand.', foot: q.rows.length ? ['TOTAL', '', '', '', '', '', '', '', '', { v: m0(q.totals.ext_material), num: 1 }, { v: n1(q.totals.ext_hours), num: 1 }, { v: m0(q.totals.ext_labor), num: 1 }, { v: m0(q.totals.ext_total), num: 1 }, ''] : null })}</div></div>`;
  $('#qfile', W).onchange = e => { const f = e.target.files[0]; if (!f) return; const rd = new FileReader(); rd.onload = () => { $('#qtext', W).value = rd.result; if (!$('#qsrc', W).value) $('#qsrc', W).value = f.name; }; rd.readAsText(f); };
  const body = () => ({ text: $('#qtext', W).value, source: $('#qsrc', W).value || null, overrides });
  const preview = async () => {
    try { pv = await POST(`/projects/${j.id}/quote-import/preview`, body()); } catch (e) { return toast(e.message, true); }
    const t = pv.totals, tone = st => st === 'OK' ? 'good' : /Skipped/.test(st) ? '' : 'bad';
    $('#qpv', W).innerHTML = `<div class="grid g4" style="margin:14px 0">${kpi('Lines to import', t.lines, `${t.skipped} skipped${t.need_code ? ` · <b style="color:var(--bad)">${t.need_code} need a code</b>` : ''}`)}${kpi('Labor hours', n1(t.hours), seeCost ? `${m0(t.labor)} labor at ${money(pv.labor_rate)}/h unless the quote gave Ext. Labor` : '')}
        ${kpi('Material / other', m0(t.material), '')}${kpi('Quote total', m0(t.total), 'material + labor')}</div>
      ${t.need_code ? '<div class="alert">Some lines have no usable cost code. Type a 4-digit code in the Code box on those lines and preview again, or tick “skip lines without a code”.</div>' : ''}
      <h3 style="margin:12px 0 6px">Budget by cost code</h3>
      ${table([{ label: 'Code', html: b => `<b>${esc(b.code)}</b> ${esc(b.name || '')}` }, { label: 'Phase', key: 'phase' }, { label: 'Hours', num: 1, get: b => n1(b.budget_hours) }, { label: 'Material', num: 1, get: b => m0(b.budget_material) },
        { label: 'Sub / equip / other', num: 1, get: b => m0(b.budget_other) }, { label: 'Labor $ (quote)', num: 1, get: b => m0(b.labor) }, { label: 'Current hrs', num: 1, get: b => b.current_hours == null ? '—' : n1(b.current_hours) }], pv.budget, { empty: 'No importable lines' })}
      <h3 style="margin:14px 0 6px">Lines</h3>
      <div class="table-wrap"><table><thead><tr><th>Row</th><th>Status</th><th>Phase code</th><th>Code</th><th>Area</th><th>Type</th><th>Description</th><th class="num">Qty</th><th>Unit</th><th class="num">Hrs</th><th class="num">Material</th><th class="num">Labor $</th></tr></thead><tbody>
        ${pv.lines.map(l => `<tr style="${l.include ? '' : 'opacity:.55'}"><td>${l.row + 1}</td><td><span class="pill ${tone(l.status)}">${esc(l.status)}</span></td><td>${esc(l.phase_code)}</td>
          <td>${l.include ? `<input class="pct-in" style="width:62px" data-ovc="${l.row}" value="${esc(l.code)}" placeholder="code">` : esc(l.code)}</td><td>${l.include ? `<input class="pct-in" style="width:70px;text-align:left" data-ova="${l.row}" value="${esc(l.area)}">` : esc(l.area)}</td>
          <td>${esc(l.cost_type)}</td><td>${esc(l.description)}</td><td class="num">${n1(l.qty)}</td><td>${esc(l.unit)}</td><td class="num">${n1(l.hours)}</td><td class="num">${m0(l.material)}</td><td class="num">${m0(l.labor)}</td></tr>`).join('')}</tbody></table></div>
      <div class="row" style="margin-top:12px;flex-wrap:wrap;gap:12px"><label class="small">Apply as <select id="qmode"><option value="replace">Replace the budget (the quote is the whole job)</option><option value="add">Add to the budget (addendum / another scope tab)</option></select></label>
        ${t.need_code ? '<label class="small"><input type="checkbox" id="qskip"> Skip lines without a code</label>' : ''}<button class="btn sm" id="qre">Preview again</button><button class="btn primary" id="qgo" ${t.lines ? '' : 'disabled'}>Import ${t.lines} line(s)</button></div>
      ${pv.removed ? `<p class="small muted">Replace removes the budget on ${pv.removed} cost code(s) not in this quote. % complete already reported is kept on codes that stay.</p>` : ''}`;
    $$('[data-ovc]', W).forEach(i => i.onchange = () => { overrides[i.dataset.ovc] = { ...(overrides[i.dataset.ovc] || {}), code: i.value.trim() }; });
    $$('[data-ova]', W).forEach(i => i.onchange = () => { overrides[i.dataset.ova] = { ...(overrides[i.dataset.ova] || {}), area: i.value.trim() }; });
    $('#qre', W).onclick = preview;
    $('#qgo', W).onclick = async () => {
      const mode = $('#qmode', W).value;
      if (mode === 'replace' && !confirm('Replace this project\'s cost-code budget with the quote? Previously imported quote lines are replaced too.')) return;
      try { const r = await POST(`/projects/${j.id}/quote-import`, { ...body(), mode, skip_uncoded: !!($('#qskip', W) && $('#qskip', W).checked) });
        toast(`Imported ${r.lines} line(s) into ${r.codes} cost code(s)`); route(); } catch (e) { toast(e.message, true); }
    };
  };
  $('#qprev', W).onclick = () => { overrides = {}; preview(); };
  $$('[data-undo]', W).forEach(b => b.onclick = async () => { if (confirm('Undo this import? Its hours and dollars come back out of the budget.')) { await act(() => DEL(`/projects/${j.id}/quote-import/${encodeURIComponent(b.dataset.undo)}`), 'Import undone').catch(() => null); route(); } });
  if ($('#qcsv', W)) $('#qcsv', W).onclick = () => toCSV([{ label: 'Area', key: 'area' }, { label: 'Phase', key: 'phase' }, { label: 'Cost Code', key: 'cost_code' }, { label: 'Cost Type', key: 'cost_type' }, { label: 'Tag', key: 'tag' },
    { label: 'Description', key: 'description' }, { label: 'Qty', key: 'qty' }, { label: 'Unit', key: 'unit' }, { label: 'Material $/Unit', key: 'material_unit' }, { label: 'Labor Hrs/Unit', key: 'hours_unit' },
    { label: 'Ext Material/Other $', key: 'ext_material' }, { label: 'Ext Labor Hrs', key: 'ext_hours' }, { label: 'Ext Labor $', key: 'ext_labor' }, { label: 'Ext Total $', key: 'ext_total' }, { label: 'Source', key: 'source' }, { label: 'Import Date', key: 'imported_at' }, { label: 'Notes', key: 'notes' }], q.rows, `${j.number}_import_quote.csv`);
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
