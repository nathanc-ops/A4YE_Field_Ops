'use strict';
// 🎯 KPIs: each owner's weekly page, the company scorecard, set-up and the import from the KPI Dashboard workbook.
// Who sees what is decided by the server (server/kpi.js); this only draws what it is given.

const KPI_STATE = { in: ['Submitted', 'good'], late: ['Submitted late', 'warn'], missing: ['Missing', 'bad'], open: ['Not submitted yet', ''] };
const KPI_STATUS = { green: 'On target', yellow: 'Close', red: 'Off target', no_data: 'No data', set_target: 'Set target', info: '' };
const kpiPct = u => u === '%';
function kpiFmt(v, unit) {
  if (v == null || v === '') return '—';
  if (unit === '%') return `${(v * 100).toFixed(Math.abs(v) < 0.1 ? 1 : 0)}%`;
  if (unit === '$') return (Math.abs(v) >= 1000 ? money0(v) : money(v));
  return String(Math.round(v * 100) / 100);
}
const kpiIn = (v, unit) => v == null ? '' : String(kpiPct(unit) ? Math.round(v * 10000) / 100 : Math.round(v * 10000) / 10000);
const kpiOut = (s, unit) => { const t = String(s ?? '').replace(/[$,%\s]/g, ''); if (t === '') return null; const n = Number(t); return Number.isFinite(n) ? (kpiPct(unit) ? n / 100 : n) : NaN; };
const kpiDay = d => new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const kpiWeekLabel = w => { const e = new Date(w + 'T12:00:00Z'); e.setUTCDate(e.getUTCDate() + 6); return `${kpiDay(w)} – ${kpiDay(e.toISOString().slice(0, 10))}`; };
const kpiDue = s => { const [d, t] = s.split(' '); const x = new Date(`${d}T${t}:00Z`); return `${x.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })}, ${x.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' })}`; };
const kpiStatus = st => st && st !== 'info' ? `<span class="kpi-st kpi-${st}">${esc(KPI_STATUS[st])}</span>` : '';
function kpiSpark(trend, m) {
  const xs = trend.map(t => t.value); const ys = xs.filter(v => v != null); if (ys.length < 2) return '';
  const lo = Math.min(...ys, m.target ?? Infinity), hi = Math.max(...ys, m.target ?? -Infinity), w = 84, h = 22, sx = i => 2 + i * (w - 4) / (xs.length - 1), sy = v => hi === lo ? h / 2 : h - 3 - (v - lo) / (hi - lo) * (h - 6);
  const pts = xs.map((v, i) => v == null ? null : `${sx(i).toFixed(1)},${sy(v).toFixed(1)}`).filter(Boolean).join(' ');
  const tgt = m.target != null && m.better !== 'Info' ? `<line x1="0" x2="${w}" y1="${sy(m.target).toFixed(1)}" y2="${sy(m.target).toFixed(1)}" class="kpi-tline"/>` : '';
  return `<svg class="kpi-spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="Last ${xs.length} weeks: ${xs.map(v => kpiFmt(v, m.unit)).join(', ')}">${tgt}<polyline points="${pts}"/></svg>`;
}

async function viewKpi() {
  const q = new URLSearchParams((location.hash.split('?')[1]) || '');
  const me = await GET('/kpi/me');
  const tabs = [];
  if (me.view_all || me.edit_all) tabs.push(['dash', 'Scorecard']);
  for (const o of me.owners) tabs.push([`o${o.id}`, `${o.name}${me.owners.length > 1 && o.user_id === S.user.id ? ' (you)' : ''}`]);
  if (me.edit_all) tabs.push(['setup', 'Targets & set-up']);
  if (me.admin) tabs.push(['import', 'Import from sheet']);
  if (!tabs.length) { $('#view').innerHTML = setTop('KPIs') + '<div class="card"><p>You have no KPI page. An admin links each KPI owner to a person under KPIs → Targets & set-up.</p></div>'; return; }
  const mineFirst = me.owners.find(o => o.user_id === S.user.id);
  // your own page first; people without one start on the scorecard
  let tab = q.get('tab') || (mineFirst ? `o${mineFirst.id}` : tabs[0][0]);
  if (!tabs.some(t => t[0] === tab)) tab = tabs[0][0];
  const week = me.weeks.includes(q.get('week')) ? q.get('week') : me.week;
  const go_ = (t, w = week) => { location.hash = `#/kpi?tab=${t}&week=${w}`; };
  $('#view').innerHTML = setTop('KPIs', ['dash'].includes(tab) || tab.startsWith('o') ? `<label class="small muted" style="display:flex;gap:6px;align-items:center">Week
      <select id="kwk">${me.weeks.map(w => `<option value="${w}" ${w === week ? 'selected' : ''}>${kpiWeekLabel(w)}${w === me.week ? ' (last week)' : ''}</option>`).join('')}</select></label>` : '')
    + `<div class="tabs">${tabs.map(([k, l]) => `<button data-kt="${k}" class="${k === tab ? 'on' : ''}">${esc(l)}</button>`).join('')}</div><div id="kbody"><div class="muted small">Loading…</div></div>`;
  $$('[data-kt]').forEach(b => b.onclick = () => go_(b.dataset.kt));
  if ($('#kwk')) $('#kwk').onchange = e => go_(tab, e.target.value);
  const el = $('#kbody');
  if (tab === 'dash') return kpiDashboard(el, week, me);
  if (tab === 'setup') return kpiSetup(el);
  if (tab === 'import') return kpiImport(el);
  return kpiPage(el, Number(tab.slice(1)), week);
}

async function kpiPage(el, ownerId, week) {
  const p = await GET(`/kpi/page?owner=${ownerId}&week=${week}`);
  const st = KPI_STATE[p.report.state];
  el.innerHTML = `<div class="card"><div class="row spread" style="flex-wrap:wrap;gap:8px">
      <div><h2 style="margin:0">${esc(p.owner.name)} · ${kpiWeekLabel(p.week)}</h2>
        <div class="small muted">Due ${kpiDue(p.due)}${p.owner.user_name ? ` · filled in by ${esc(p.owner.user_name)}` : ' · <b>no person linked to this page yet</b>'}</div></div>
      <div><span class="pill ${st[1]}">${st[0]}</span>${p.report.at ? ` <span class="small muted">${fmtDT(p.report.at)}${p.report.by ? ` by ${esc(p.report.by)}` : ''}</span>` : ''}</div></div>
    ${p.can_edit ? `<p class="small muted" style="margin:8px 0 0">Type numbers in the white boxes; gray rows calculate. A row that's <b>off target</b> needs a cause and a fix before you can submit. Percent boxes take a percent (6 = 6%).</p>` : '<p class="small muted">View only.</p>'}</div>
    <form id="kpf">${p.sections.map(s => `<div class="card" style="margin-top:12px"><h3>${esc(s.name)}</h3><div class="table-wrap"><table class="kpi-t">
      <thead><tr><th>#</th><th>Metric</th><th class="num">Target</th><th class="num">This week</th><th>Status</th><th>Last ${s.metrics[0] ? s.metrics[0].trend.length : ''} weeks</th></tr></thead><tbody>
      ${s.metrics.map(m => `<tr data-row="${m.id}" class="${m.input === 'calc' ? 'kpi-calc' : ''}">
        <td class="small muted">${esc(m.id)}</td>
        <td><b>${esc(m.metric)}</b><div class="small muted">${esc(m.how || '')}${m.input === 'calc' ? ` · ${esc(m.rule || '')}` : m.source ? ` · <span title="${esc(m.source)}">${esc(m.source.length > 70 ? m.source.slice(0, 70) + '…' : m.source)}</span>` : ''}</div>
          ${m.target_note ? `<div class="small" style="color:var(--warn,#b45309)">${esc(m.target_note)}</div>` : ''}</td>
        <td class="num small">${m.better === 'Info' ? '<span class="muted">info</span>' : m.target == null ? '—' : `${m.better === 'Higher' ? '≥' : '≤'} ${kpiFmt(m.target, m.unit)}`}</td>
        <td class="num">${m.input === 'calc' || !p.can_edit ? `<b>${kpiFmt(m.value, m.unit)}</b>` : `<input class="kpi-in" name="v_${m.id}" inputmode="decimal" value="${esc(kpiIn(m.value, m.unit))}" data-unit="${esc(m.unit)}" aria-label="${esc(m.metric)}">${m.unit === '%' ? ' %' : ''}`}
          ${m.entered_by && m.input !== 'calc' ? `<div class="small muted" title="${esc(m.entered_by)}">${fmtDT(m.entered_at)}</div>` : ''}</td>
        <td>${kpiStatus(m.status)}</td><td>${kpiSpark(m.trend, m)}</td></tr>
        ${m.status === 'red' || m.note ? `<tr class="kpi-note ${m.status === 'red' ? 'need' : ''}" data-note="${m.id}"><td></td><td colspan="5"><div class="kpi-cf">
          ${p.can_edit ? `<label>Cause<textarea name="c_${m.id}" rows="2" placeholder="Why it missed">${esc(m.note ? m.note.cause : '')}</textarea></label><label>Fix<textarea name="f_${m.id}" rows="2" placeholder="What we'll do about it">${esc(m.note ? m.note.fix : '')}</textarea></label>`
            : `<div><b>Cause:</b> ${esc(m.note ? m.note.cause : '—')}</div><div><b>Fix:</b> ${esc(m.note ? m.note.fix : '—')}</div>`}</div></td></tr>` : ''}`).join('')}
      </tbody></table></div></div>`).join('')}
    ${p.can_edit ? `<div class="row" style="margin:14px 0;gap:8px"><button type="button" class="btn" id="ksave">Save</button><button class="btn primary" id="ksub">Submit week</button></div>` : ''}</form>`;
  if (!p.can_edit) return;
  const f = $('#kpf');
  const collect = () => {
    const values = {}, notes = {};
    for (const i of $$('.kpi-in', f)) { const v = kpiOut(i.value, i.dataset.unit); if (Number.isNaN(v)) throw new Error(`"${i.value}" isn't a number`); values[i.name.slice(2)] = v; }
    for (const t of $$('textarea[name^="c_"]', f)) { const id = t.name.slice(2); notes[id] = { cause: t.value, fix: f[`f_${id}`].value }; }
    return { owner: ownerId, week, values, notes };
  };
  const save = async submit => {
    let body; try { body = collect(); } catch (e) { return toast(e.message, true); }
    try {
      const r = await PUT('/kpi/page', { ...body, submit });
      if (submit && !r.submitted) {
        await kpiPage(el, ownerId, week);
        toast(`Saved. Before submitting, add a cause and a fix for: ${r.need_notes.map(n => `${n.id} ${n.metric}`).join(', ')}`, true);
        const first = $(`[data-note="${r.need_notes[0].id}"] textarea`); if (first) first.focus();
        return;
      }
      toast(submit ? 'Week submitted' : 'Saved'); kpiPage(el, ownerId, week);
    } catch (e) { toast(e.message, true); }
  };
  $('#ksave').onclick = () => save(false);
  f.onsubmit = e => { e.preventDefault(); save(true); };
}

async function kpiDashboard(el, week) {
  const d = await GET(`/kpi/dashboard?week=${week}`);
  const H = d.health;
  el.innerHTML = `<div class="card"><h2 style="margin-top:0">Reports in · ${kpiWeekLabel(d.week)} <span class="small muted">due ${kpiDue(d.due)}</span></h2>
      <div class="row" style="flex-wrap:wrap;gap:8px">${d.reports.map(r => `<a class="kpi-chip ${r.state}" href="#/kpi?tab=o${r.id}&week=${d.week}">${esc(r.name)}<span>${KPI_STATE[r.state][0]}</span></a>`).join('')}</div>
      <div class="row" style="flex-wrap:wrap;gap:8px;margin-top:12px">${[['green', H.green], ['yellow', H.yellow], ['red', H.red], ['no_data', H.no_data], ['set_target', H.set_target]].map(([k, n]) => `<div class="kpi-count kpi-${k}"><b>${n}</b>${KPI_STATUS[k]}</div>`).join('')}</div></div>
    ${d.headlines.length ? `<div class="kpi-heads">${d.headlines.map(h => `<div class="card kpi-head kpi-b-${h.status}"><div class="small muted">${esc(h.metric)} · ${esc(h.owner)}</div>
      <div class="kpi-big">${kpiFmt(h.value, h.unit)}</div><div class="small">${kpiStatus(h.status)} ${h.target != null && h.better !== 'Info' ? `target ${h.better === 'Higher' ? '≥' : '≤'} ${kpiFmt(h.target, h.unit)}` : ''}</div>
      <div class="small muted">vs ${d.quarter.slice(4)} weekly avg: ${kpiFmt(h.qtr_avg, h.unit)}</div></div>`).join('')}</div>` : ''}
    ${d.constraint ? `<div class="card" style="margin-top:12px"><h3 style="margin-top:0">The constraint</h3><p>Furthest from target: <b>${esc(d.constraint.owner)} · ${esc(d.constraint.section)}</b> —
      ${d.constraint.red} off target, ${d.constraint.yellow} close, ${d.constraint.green} on target. It gets the most meeting time.</p></div>` : ''}
    <div class="card" style="margin-top:12px"><h3 style="margin-top:0">Off target this week (${d.red.length})</h3>${table([{ label: 'Metric', html: r => `<b>${esc(r.metric)}</b><div class="small muted">${esc(r.id)} · ${esc(r.owner)}</div>` },
      { label: 'Value', num: true, get: r => kpiFmt(r.value, r.unit) }, { label: 'Target', num: true, get: r => `${r.better === 'Higher' ? '≥' : '≤'} ${kpiFmt(r.target, r.unit)}` },
      { label: 'Cause / fix', html: r => r.note ? `${esc(r.note.cause)}<div class="small muted">→ ${esc(r.note.fix)}</div>` : '<span class="small" style="color:var(--bad)">none given</span>' }], d.red, { empty: 'Nothing off target' })}</div>
    <div class="card" style="margin-top:12px"><h3 style="margin-top:0">By section</h3>${table([{ label: 'Owner', key: 'owner' }, { label: 'Section', key: 'section' },
      { label: 'On / close / off', html: s => `<span class="kpi-st kpi-green">${s.green}</span> <span class="kpi-st kpi-yellow">${s.yellow}</span> <span class="kpi-st kpi-red">${s.red}</span>` },
      { label: 'Score', num: true, get: s => `${Math.round(s.score * 100)}%` }], d.sections, { empty: 'No scored metrics with numbers yet' })}</div>`;
}

async function kpiSetup(el) {
  const s = await GET('/kpi/setup');
  const userOpts = sel => `<option value="">— nobody —</option>${s.users.map(u => `<option value="${u.id}" ${u.id === sel ? 'selected' : ''}>${esc(u.name)} (${esc(u.email)})</option>`).join('')}`;
  el.innerHTML = `<div class="grid g2"><div class="card"><h3 style="margin-top:0">Who fills in each page</h3>
      <p class="small muted">That person fills in the page. Seeing everyone's numbers and filling in anyone's page are per-person permissions under <b>Team</b> (the sheet's MASTER_VIEWERS and ADMINS).</p>
      ${table([{ label: 'Page', html: o => `<b>${esc(o.name)}</b> <span class="small muted">${o.metrics} metrics</span>` }, { label: 'Filled in by', html: o => `<select data-owner="${o.id}">${userOpts(o.user_id)}</select>` }], s.owners, { empty: 'Import the KPI workbook first' })}</div>
    <div class="card"><h3 style="margin-top:0">Rules</h3><form id="kset" class="form-grid">
      ${fieldHtml({ name: 'band', label: 'Yellow band (share of target, 0.25 = 25%)', type: 'number', step: '0.01' }, s.settings.band)}
      ${fieldHtml({ name: 'ot_rate', label: 'OT rate $/hr (OT_RATE in formulas)', type: 'number', step: '0.01' }, s.settings.ot_rate ?? '')}
      ${fieldHtml({ name: 'due_days', label: 'Due days after the Saturday', type: 'number' }, s.settings.due_days)}
      ${fieldHtml({ name: 'due_time', label: 'Due time (24 h)' }, s.settings.due_time)}
      ${fieldHtml({ name: 'history_weeks', label: 'Weeks in trend lines', type: 'number' }, s.settings.history_weeks)}
      ${fieldHtml({ name: 'headlines', label: 'Scorecard headline IDs', full: true }, s.settings.headlines)}
      <div class="full"><button class="btn primary sm">Save rules</button></div></form></div></div>
    <div class="card" style="margin-top:12px"><h3 style="margin-top:0">Targets</h3><p class="small muted">Changes save as you leave each box. Percent targets in percent (6 = 6%).</p>
    <div class="table-wrap"><table class="kpi-t"><thead><tr><th>#</th><th>Page</th><th>Metric</th><th>Better</th><th class="num">Target</th><th>Active</th></tr></thead><tbody>
    ${s.metrics.map(m => `<tr data-m="${esc(m.id)}"><td class="small muted">${esc(m.id)}</td><td class="small">${esc(m.owner)}</td><td>${esc(m.metric)} <span class="small muted">${esc(m.input)}${m.rule ? ` · ${esc(m.rule)}` : ''}</span></td>
      <td><select data-f="better">${['Higher', 'Lower', 'Info'].map(b => `<option ${b === m.better ? 'selected' : ''}>${b}</option>`).join('')}</select></td>
      <td class="num"><input data-f="target" data-unit="${esc(m.unit)}" inputmode="decimal" style="width:90px" value="${esc(kpiIn(m.target, m.unit))}">${m.unit === '%' ? ' %' : ''}</td>
      <td><input type="checkbox" data-f="active" ${m.active ? 'checked' : ''}></td></tr>`).join('')}</tbody></table></div></div>`;
  $$('[data-owner]', el).forEach(x => x.onchange = () => act(() => PUT(`/kpi/owners/${x.dataset.owner}`, { user_id: x.value }), 'Saved').catch(() => null));
  $('#kset', el).onsubmit = async e => { e.preventDefault(); const f = e.target;
    await act(() => PUT('/kpi/settings', { band: f.band.value, ot_rate: f.ot_rate.value, due_days: f.due_days.value, due_time: f.due_time.value, history_weeks: f.history_weeks.value, headlines: f.headlines.value }), 'Rules saved').catch(() => null); };
  $$('[data-m] [data-f]', el).forEach(x => x.onchange = () => {
    const id = x.closest('[data-m]').dataset.m, k = x.dataset.f;
    let v = k === 'active' ? x.checked : x.value;
    if (k === 'target') { v = kpiOut(x.value, x.dataset.unit); if (Number.isNaN(v)) return toast('Target must be a number', true); }
    act(() => PUT(`/kpi/metrics/${id}`, { [k]: v }), `${id} saved`).catch(() => null);
  });
}

async function kpiImport(el) {
  el.innerHTML = `<div class="card"><h3 style="margin-top:0">Import from the KPI Dashboard sheet</h3>
    <ol class="small"><li>Open the <b>A4YE KPI Dashboard</b> Google Sheet → <b>File → Download → Microsoft Excel (.xlsx)</b>.</li><li>Choose that file here, check the preview, then import.</li></ol>
    <p class="small muted">Reads only the Metrics, Settings, Values, Notes and Submissions tabs (never the Housecall Pro, Ply or time-clock data tabs).
      Each page's person comes from the sheet's <code>EMAIL_&lt;Name&gt;</code> settings; <code>ADMINS</code> get "fill in anyone's page" and <code>MASTER_VIEWERS</code> get "see everyone's numbers", matched by email to Field Ops users.
      Importing again updates definitions and adds newer history; numbers typed here since are kept unless the sheet's are newer.</p>
    <input type="file" id="kfile" accept=".xlsx"> <div id="kprev" style="margin-top:12px"></div></div>`;
  $('#kfile', el).onchange = async e => {
    const file = e.target.files[0]; if (!file) return;
    const data = await new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = no; r.readAsDataURL(file); });
    const out = $('#kprev', el); out.innerHTML = '<span class="small muted">Reading…</span>';
    let p; try { p = await POST('/import/kpi-workbook/preview', { file: data }); } catch (err) { out.innerHTML = `<div class="alert">${esc(err.message)}</div>`; return; }
    out.innerHTML = `<p><b>${p.metrics}</b> metrics · <b>${p.values}</b> weekly values · <b>${p.notes}</b> cause/fix notes · <b>${p.submissions}</b> submissions</p>
      ${p.problems.length ? `<div class="alert"><b>Formulas that can't be read:</b> ${p.problems.map(esc).join('; ')}</div>` : ''}
      ${table([{ label: 'Page', key: 'name' }, { label: 'Sheet email', get: o => o.email || '—' }, { label: 'Field Ops user', html: o => o.user ? esc(o.user.name) : o.tech ? `<span style="color:var(--bad)">${esc(o.tech)} is a technician — KPIs are for office, managers and admins. Change their role under Team, or link someone else after importing.</span>` : '<span style="color:var(--bad)">no user with that email — link one under Targets & set-up after importing</span>' }], p.owners)}
      ${table([{ label: 'Email', key: 'email' }, { label: 'Gets', get: g => g.perm === 'kpi_edit_all' ? "fill in anyone's page" : "see everyone's numbers" },
        { label: 'Role', get: g => g.user ? label(g.user.role) : '' },
        { label: 'Field Ops user', html: g => g.user ? `${esc(g.user.name)}${g.user.role === 'admin' ? ' <span class="small muted">(admin: has it already)</span>' : ''}` : g.tech ? `<span class="small muted">${esc(g.tech)} is a technician — skipped</span>` : '<span class="small muted">no user with that email — skipped</span>' }], p.grants)}
      <p class="small muted">Settings: yellow band ${esc(p.settings.band ?? '—')}, OT rate ${esc(p.settings.ot_rate ?? '—')}, due ${esc(p.settings.due_days ?? '—')} days after Saturday at ${esc(p.settings.due_time ?? '—')}.</p>
      <button class="btn primary" id="kgo" ${p.problems.length ? 'disabled' : ''}>Import</button>`;
    $('#kgo', out).onclick = async () => {
      const r = await act(() => POST('/import/kpi-workbook', { file: data })).catch(() => null); if (!r) return;
      toast(`Imported ${r.metrics} metrics, ${r.values} values, ${r.notes} notes, ${r.submissions} submissions`);
      S.user.kpi = true; renderShell(); location.hash = '#/kpi?tab=setup';
    };
  };
}
