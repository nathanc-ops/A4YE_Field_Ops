'use strict';
/* The Bi-Weekly Project Report document, shared by the project's Bi-Weekly Report sheet and the public link a GC opens
 * (/p/report/<token>). Needs esc, money0, wbDate and statusPill from the page that loads it. */
const REPORT_NARRATIVE = [['progress', 'Progress this period'], ['plan_next', 'Plan for next period'], ['issues', 'Issues & risks'], ['decisions', 'Decisions needed from the GC / owner'], ['notes', 'Notes']];
function reportDoc(d, rep = {}, { gc = false, editable = false, preparedBy = '' } = {}) {
  const issued = rep.status === 'issued', F = d.financial, P = d.production, I = d.info, narrative = REPORT_NARRATIVE;
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
  return `<div class="card report-doc">
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
      <table class="rp-kv" style="margin-top:14px">${pair(['Prepared by', esc(rep.prepared_by_name || I.pm_name || preparedBy)], ['Date', wbDate(issued ? rep.issued_at : d.period_end)])}</table>
    </div>`;
}
