'use strict';
// 🎯 KPIs — laid out like the KPI Command Center web app: Team overview + one page per person, a week picker, auto numbers
// that can be replaced with a reason, cause/fix on every yellow or red row, Save draft / Submit week in a bar at the bottom.
// Who sees what is decided by the server (server/kpi.js); this only draws what it is given.

const KPI_STATE = { in: ['Submitted', 'good'], late: ['Submitted late', 'warn'], missing: ['Not submitted', 'bad'], open: ['Not submitted yet', ''] };
const KPI_LABEL = { green: 'Green', yellow: 'Yellow', red: 'Red', no_data: 'No data', info: 'Info' };
const KPI_COLORS = ['#dc2626', '#7c3aed', '#2a7fa8', '#c2541a', '#3f8f4f', '#b45309', '#0e7490', '#be185d'];
const kpiColor = (o, i) => (o && o.color && o.color !== '#2563eb' ? o.color : KPI_COLORS[(i ?? 0) % KPI_COLORS.length]);
const kpiAvatar = (name, color, size = '') => `<span class="kpi-av ${size}" style="background:${esc(color)}">${esc(String(name || '?').trim()[0] || '?').toUpperCase()}</span>`;
const kpiPct = u => u === '%';
function kpiFmt(v, unit) {
  if (v == null || v === '') return '—';
  if (unit === '%') return `${(Math.round(v * 1000) / 10).toLocaleString('en-US')}%`;
  if (unit === '$') return '$' + Math.round(v).toLocaleString('en-US');
  const n = (Math.round(v * 10) / 10).toLocaleString('en-US');
  return unit === 'hrs' ? `${n} h` : unit === 'days' ? `${n} d` : n;
}
const kpiTarget = m => m.better === 'Info' ? '—' : m.target == null ? 'not set' : `${m.better === 'Higher' ? '≥' : '≤'} ${kpiFmt(m.target, m.unit)}`;
const kpiIn = (v, unit) => v == null ? '' : String(kpiPct(unit) ? Math.round(v * 10000) / 100 : Math.round(v * 10000) / 10000);
const kpiOut = (s, unit) => { const t = String(s ?? '').replace(/[$,%\s]/g, ''); if (t === '') return null; const n = Number(t); return Number.isFinite(n) ? (kpiPct(unit) ? n / 100 : n) : NaN; };
const kpiMD = d => { const x = new Date(d + 'T12:00:00Z'); return `${x.getUTCMonth() + 1}/${x.getUTCDate()}`; };
const kpiWeekLabel = w => { const e = new Date(w + 'T12:00:00Z'); e.setUTCDate(e.getUTCDate() + 6); return `${kpiMD(w)}–${kpiMD(e.toISOString().slice(0, 10))}/${String(e.getUTCFullYear()).slice(2)}`; };
const kpiDue = s => { const [d, t] = s.split(' '); const x = new Date(`${d}T${t}:00Z`); return `${x.toLocaleDateString('en-US', { weekday: 'short', month: 'numeric', day: 'numeric', timeZone: 'UTC' })} ${x.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' })}`; };
const kpiStamp = s => s ? new Date(normDT(s)).toLocaleString('en-US', { month: 'numeric', day: 'numeric', year: '2-digit', hour: 'numeric', minute: '2-digit' }) : '';
const kpiPill = st => `<span class="kpi-pill kpi-p-${st}">${esc(KPI_LABEL[st] || st)}</span>`;
function kpiRing(part, whole, color) {
  const p = whole ? Math.max(0, Math.min(1, part / whole)) : 0, r = 30, c = 2 * Math.PI * r;
  return `<svg class="kpi-ring" viewBox="0 0 76 76" aria-hidden="true"><circle cx="38" cy="38" r="${r}" class="kpi-ring-bg"/><circle cx="38" cy="38" r="${r}" stroke="${color}" stroke-dasharray="${(c * p).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 38 38)"/></svg>`;
}

async function viewKpi() {
  const q = new URLSearchParams((location.hash.split('?')[1]) || '');
  const me = await GET('/kpi/me');
  const tabs = [];
  if (me.view_all || me.edit_all) tabs.push({ k: 'dash', html: 'Team overview' });
  me.owners.forEach((o, i) => tabs.push({ k: `o${o.id}`, html: `${kpiAvatar(o.name, kpiColor(o, i), 'sm')} ${esc(o.name)}` }));
  if (me.edit_all) tabs.push({ k: 'setup', html: 'Targets & set-up', minor: true });
  if (me.admin) tabs.push({ k: 'import', html: 'Import', minor: true });
  if (!tabs.length) { $('#view').innerHTML = setTop('KPIs') + '<div class="card"><p>You have no KPI page. An admin links each KPI owner to a person under KPIs → Targets & set-up.</p></div>'; return; }
  const mine = me.owners.find(o => o.user_id === S.user.id);
  let tab = q.get('tab') || (mine ? `o${mine.id}` : tabs[0].k);
  if (!tabs.some(t => t.k === tab)) tab = tabs[0].k;
  const week = me.weeks.includes(q.get('week')) ? q.get('week') : me.week;
  const go_ = (t, w = week, extra = '') => { location.hash = `#/kpi?tab=${t}&week=${w}${extra}`; };
  const logo = S.settings.logo_url || '/brand/a4y-logo.png';
  const weekly = tab === 'dash' || tab.startsWith('o');
  $('#view').innerHTML = `<div class="kpi-top">
      <div class="row spread" style="align-items:center;gap:10px"><div class="row" style="gap:10px;align-items:center"><button class="btn menu-btn" onclick="document.getElementById('side').classList.toggle('open')">☰</button>
        <div><h1 class="kpi-title">KPI <span>Command</span> Center</h1><div class="small muted">Powered by people. Built all 4 you</div></div></div>
        <img class="kpi-logo" src="${esc(logo)}" alt="${esc(S.settings.company_name || '')}"></div>
      <div class="kpi-tabs">${tabs.map(t => `<button data-kt="${t.k}" class="${t.k === tab ? 'on' : ''} ${t.minor ? 'minor' : ''}">${t.html}</button>`).join('')}</div>
      ${weekly ? `<div class="row spread" style="gap:10px;flex-wrap:wrap;align-items:center"><label class="kpi-week">Week <select id="kwk">${me.weeks.map(w => `<option value="${w}" ${w === week ? 'selected' : ''}>${kpiWeekLabel(w)}</option>`).join('')}</select></label>
        <span class="small muted" id="kupd"></span></div>` : ''}</div>
    <div id="kbody"><div class="muted small" style="padding:16px">Loading…</div></div>`;
  $$('[data-kt]').forEach(b => b.onclick = () => go_(b.dataset.kt));
  if ($('#kwk')) $('#kwk').onchange = e => go_(tab, e.target.value);
  const el = $('#kbody');
  const updated = at => { if ($('#kupd') && at) $('#kupd').innerHTML = `<span class="kpi-dot"></span> Updated ${esc(kpiStamp(at))}`; };
  if (tab === 'dash') return kpiDashboard(el, week, me, updated, q.get('who'));
  if (tab === 'setup') return kpiSetup(el);
  if (tab === 'import') return kpiImport(el);
  const idx = me.owners.findIndex(o => `o${o.id}` === tab);
  return kpiPage(el, Number(tab.slice(1)), week, kpiColor(me.owners[idx], idx), updated);
}

// one person's KPIs for a week
async function kpiPage(el, ownerId, week, color, updated) {
  const p = await GET(`/kpi/page?owner=${ownerId}&week=${week}`);
  updated(p.updated_at);
  const C = p.counts, edit = p.can_edit, rep = p.report;
  const sub = rep.state === 'in' || rep.state === 'late'
    ? `<div class="kpi-ok">Submitted ${esc(kpiStamp(rep.at))}${rep.state === 'late' ? ' (late)' : ''}.${edit ? ' You can still correct numbers and submit again.' : ''}</div>`
    : rep.state === 'missing' ? '<div class="kpi-bad">Not submitted — past due.</div>' : '';
  const row = m => {
    const auto = m.origin === 'auto' && m.auto_value != null, replaced = m.origin === 'manual' && m.auto_value != null;
    const val = m.input === 'calc' || !edit
      ? `<b class="kpi-num">${kpiFmt(m.value, m.unit)}</b>${auto ? ' <span class="kpi-auto">auto</span>' : ''}${m.input === 'calc' ? `<div class="kpi-rule">${esc(m.rule || '')}</div>` : ''}`
      : auto ? `<b class="kpi-num">${kpiFmt(m.value, m.unit)}</b> <span class="kpi-auto">auto</span><div><a href="#" class="kpi-repl" data-repl="${m.id}">replace this number</a></div>
          <div class="kpi-replbox" data-rb="${m.id}" hidden><input class="kpi-in" name="v_${m.id}" data-unit="${esc(m.unit)}" data-auto="${m.auto_value}" inputmode="decimal" value="${esc(kpiIn(m.value, m.unit))}" aria-label="${esc(m.metric)}" disabled>
          <label class="kpi-why">Why replace ${esc(m.auto_source || m.source || 'the automatic number')}?<input name="r_${m.id}" placeholder="What the automatic number got wrong"></label></div>`
      : `<input class="kpi-in" name="v_${m.id}" data-unit="${esc(m.unit)}" inputmode="decimal" value="${esc(kpiIn(m.value, m.unit))}" aria-label="${esc(m.metric)}">${m.unit === '%' ? '<span class="small muted"> %</span>' : ''}
          ${replaced ? `<div class="small muted">auto was ${kpiFmt(m.auto_value, m.unit)}</div><label class="kpi-why">Why replace ${esc(m.auto_source || m.source || 'the automatic number')}?<input name="r_${m.id}" value="${esc(m.reason || '')}"></label>` : ''}`;
    const needs = m.status === 'red' || m.status === 'yellow';
    const cf = (needs || (m.note && (m.note.cause || m.note.fix))) ? `<div class="kpi-cf">${edit
      ? `<label>Cause (why it's off target)<textarea name="c_${m.id}" rows="2" class="${needs && !(m.note && m.note.cause) ? 'empty' : ''}">${esc(m.note ? m.note.cause : '')}</textarea></label>
         <label>Fix (what you'll do, by when)<textarea name="f_${m.id}" rows="2" class="${needs && !(m.note && m.note.fix) ? 'empty' : ''}">${esc(m.note ? m.note.fix : '')}</textarea></label>`
      : `<div><b>Cause:</b> ${esc(m.note ? m.note.cause : '—')}</div><div><b>Fix:</b> ${esc(m.note ? m.note.fix : '—')}</div>`}</div>` : '';
    return `<div class="kpi-row kpi-s-${m.status}" data-row="${m.id}">
      <div class="kpi-k"><div><span class="kpi-id">${esc(m.id)}</span> <span class="kpi-name">${esc(m.metric)}</span></div>
        <div class="kpi-src">${esc(m.input === 'calc' ? (m.source || 'Calculated') : (m.source || m.how || ''))}</div>
        ${m.target_note ? `<div class="kpi-tnote">${esc(m.target_note)}</div>` : ''}${cf}</div>
      <div class="kpi-v">${val}</div><div class="kpi-t">${esc(kpiTarget(m))}</div><div class="kpi-st">${kpiPill(m.status)}</div></div>`;
  };
  el.innerHTML = `<div class="kpi-wrap"><div class="card kpi-head"><div class="row" style="gap:14px;align-items:center;flex:1;min-width:240px">${kpiAvatar(p.owner.name, color, 'lg')}
        <div><h2 class="kpi-h2">${esc(p.owner.name)}'s KPIs</h2><div class="small muted">Week of <b>${kpiWeekLabel(p.week)}</b> (Sun–Sat) · due ${esc(kpiDue(p.due))}</div>${sub}</div></div>
      <div class="row" style="gap:10px;align-items:center">${kpiRing(C.with_number, C.total, C.need_note ? '#e5484d' : '#3fb950')}
        <div><div class="kpi-big">${C.with_number} / ${C.total}</div><div class="small ${C.need_note ? 'kpi-bad' : 'muted'}">${C.need_note ? `${C.need_note} still need a cause and fix` : 'KPIs with a number'}</div></div></div></div>
    <div class="kpi-banner">Blue <span class="kpi-auto">auto</span> numbers fill themselves; type the rest. Anything yellow or red needs a cause and a fix before you can submit.</div>
    <form id="kpf"><div class="card kpi-table"><div class="kpi-thead"><div>KPI</div><div>This week</div><div>Target</div><div>Status</div></div>
      ${p.sections.map(s => `<div class="kpi-sec">${esc(s.name)}</div>${s.metrics.map(row).join('')}`).join('')}</div></form>
    ${edit ? `<div class="kpi-bar"><span class="small muted">Signed in as ${esc(p.signed_in_as || '')}</span><span class="row" style="gap:8px"><button type="button" class="btn" id="ksave">Save draft</button><button type="button" class="btn primary" id="ksub">Submit week</button></span></div>` : ''}</div>`;
  if (!edit) return;
  const f = $('#kpf');
  $$('[data-repl]', f).forEach(a => a.onclick = e => { e.preventDefault(); const box = $(`[data-rb="${a.dataset.repl}"]`, f); box.hidden = false; $('input', box).disabled = false; $('input', box).focus(); a.parentElement.hidden = true; });
  $$('textarea', f).forEach(t => t.oninput = () => t.classList.toggle('empty', !t.value.trim() && t.closest('.kpi-s-red, .kpi-s-yellow')));
  const collect = () => {
    const values = {}, notes = {}, reasons = {};
    for (const i of $$('.kpi-in', f)) { if (i.disabled) continue; const v = kpiOut(i.value, i.dataset.unit); if (Number.isNaN(v)) throw new Error(`"${i.value}" isn't a number`); values[i.name.slice(2)] = v; }
    for (const i of $$('input[name^="r_"]', f)) if (i.value.trim()) reasons[i.name.slice(2)] = i.value.trim();
    for (const t of $$('textarea[name^="c_"]', f)) { const id = t.name.slice(2); notes[id] = { cause: t.value, fix: f[`f_${id}`].value }; }
    return { owner: ownerId, week, values, notes, reasons };
  };
  const save = async submit => {
    let body; try { body = collect(); } catch (e) { return toast(e.message, true); }
    try {
      const r = await PUT('/kpi/page', { ...body, submit });
      if (submit && !r.submitted) {
        await kpiPage(el, ownerId, week, color, updated);
        toast(`Saved. Before submitting, add a cause and a fix for: ${r.need_notes.map(n => `${n.id} ${n.metric}`).join(', ')}`, true);
        const first = $(`[data-row="${r.need_notes[0].id}"] textarea`); if (first) { first.scrollIntoView({ block: 'center' }); first.focus(); }
        return;
      }
      toast(submit ? 'Week submitted' : 'Draft saved'); kpiPage(el, ownerId, week, color, updated);
    } catch (e) { toast(e.message, true); }
  };
  $('#ksave').onclick = () => save(false);
  $('#ksub').onclick = () => save(true);
}

// Team overview: how the week is going, who's in, and every KPI (filter by person; click one to see where it came from)
async function kpiDashboard(el, week, me, updated, who) {
  const d = await GET(`/kpi/dashboard?week=${week}`);
  updated(d.updated_at);
  const H = d.health, total = H.green + H.yellow + H.red + H.no_data;
  const colorOf = id => { const i = d.reports.findIndex(r => r.id === id); return kpiColor(d.reports[i], i); };
  const filter = who ? Number(who) : null;
  const list = d.kpis.filter(k => !filter || k.owner_id === filter);
  const tile = (cls, label, big, sub, extra = '') => `<div class="kpi-tile ${cls}">${extra}<div><div class="kpi-tl">${label}</div><div class="kpi-tb">${big}</div><div class="kpi-ts">${sub}</div></div></div>`;
  el.innerHTML = `<div class="kpi-wrap"><h2 class="kpi-h2" style="font-size:30px;margin:6px 0 2px">Week of ${kpiWeekLabel(d.week)}</h2>
    <p class="muted" style="margin:0 0 10px">Owner pages are due ${esc(kpiDue(d.due))}. Click any KPI to see where its number came from.</p>
    <button class="btn sm" id="khow">How status works</button>
    <div id="khowtext" class="card small" hidden style="margin-top:8px"><b>Green</b> = at or better than target. <b>Yellow</b> = missed, but within ${Math.round((d.band ?? 0.25) * 100) || 25}% of target. <b>Red</b> = missed by more than that.
      <b>No data</b> = waiting on a number. <b>Info</b> = tracked without a target. Every yellow or red KPI needs a cause and a fix before its page can be submitted.
      Pages are due ${esc(kpiDue(d.due).split(' ')[0])} for the Sunday–Saturday week before.</div>
    <div class="kpi-tiles">
      ${tile('t-green', 'On target', `${d.on_target_pct ?? '—'}<small>%</small>`, `${H.green} of ${d.scored} scored KPIs`, kpiRing(H.green, d.scored, '#3fb950'))}
      ${tile('t-red', 'Red', H.red, 'Off target')}
      ${tile('t-yellow', 'Yellow', H.yellow, 'Close to target')}
      ${tile('t-grey', 'No data', H.no_data, 'Waiting on a number')}
      ${tile('t-red', 'Pages submitted', `${d.submitted}<small>/${d.reports.length}</small>`, d.waiting_on.length ? `Waiting on ${esc(d.waiting_on.join(', '))}` : 'Everyone is in')}
      ${tile('t-red', 'Need cause and fix', d.need_note, 'Off-target KPIs not explained')}</div>
    <div class="kpi-stack">${[['green', H.green], ['yellow', H.yellow], ['red', H.red], ['no_data', H.no_data]].map(([k, n]) => n ? `<span class="kpi-b-${k}" style="flex:${n}"></span>` : '').join('')}</div>
    <div class="kpi-legend"><span><i class="kpi-b-green"></i>${H.green} green</span><span><i class="kpi-b-yellow"></i>${H.yellow} yellow</span><span><i class="kpi-b-red"></i>${H.red} red</span><span><i class="kpi-b-no_data"></i>${H.no_data} no data</span><span>${H.info} tracked for info</span></div>
    <div class="row spread" style="margin-top:22px;align-items:baseline"><h2 class="kpi-h2">Team</h2><span class="small muted">Click a person to filter the KPI list</span></div>
    <div class="kpi-team">${d.reports.map(r => { const st = KPI_STATE[r.state];
      return `<button class="card kpi-person ${filter === r.id ? 'on' : ''}" data-who="${r.id}"><div class="row spread" style="align-items:center"><span class="row" style="gap:10px;align-items:center">${kpiAvatar(r.name, colorOf(r.id))}<b class="kpi-pname">${esc(r.name)}</b></span><span class="kpi-sub ${st[1]}">${st[0]}</span></div>
        <div class="kpi-mini"><span class="kpi-b-green"></span>${r.green} <span class="kpi-b-yellow"></span>${r.yellow} <span class="kpi-b-red"></span>${r.red} <span class="kpi-b-no_data"></span>${r.no_data}</div>
        <div class="small muted">${r.with_number} of ${r.total} with a number${r.need_note ? ` · <span class="kpi-bad">${r.need_note} need a cause and fix</span>` : ''}${r.at ? ` · in ${esc(kpiStamp(r.at))}` : ''}</div></button>`; }).join('')}</div>
    <div class="row spread" style="margin-top:22px;align-items:baseline"><h2 class="kpi-h2">KPIs${filter ? ` — ${esc((d.reports.find(r => r.id === filter) || {}).name || '')}` : ''}</h2>${filter ? '<a href="#" id="kall" class="small">Show everyone</a>' : ''}</div>
    <div class="card kpi-table">${list.map((k, i) => `${i === 0 || list[i - 1].section !== k.section || list[i - 1].owner_id !== k.owner_id ? `<div class="kpi-sec">${esc(k.owner)} · ${esc(k.section)}</div>` : ''}
      <div class="kpi-row kpi-s-${k.status} click" data-k="${esc(k.id)}"><div class="kpi-k"><div><span class="kpi-id">${esc(k.id)}</span> <span class="kpi-name">${esc(k.metric)}</span></div>
        ${k.needs_note ? '<div class="small kpi-bad">needs a cause and fix</div>' : k.note && k.note.cause ? `<div class="kpi-src">${esc(k.note.cause)} → ${esc(k.note.fix)}</div>` : ''}</div>
        <div class="kpi-v"><b class="kpi-num">${kpiFmt(k.value, k.unit)}</b>${k.origin === 'auto' ? ' <span class="kpi-auto">auto</span>' : ''}</div><div class="kpi-t">${esc(kpiTarget(k))}</div><div class="kpi-st">${kpiPill(k.status)}</div></div>`).join('')}</div></div>`;
  $('#khow').onclick = () => { $('#khowtext').hidden = !$('#khowtext').hidden; };
  $$('[data-who]', el).forEach(b => b.onclick = () => { location.hash = `#/kpi?tab=dash&week=${week}${filter === Number(b.dataset.who) ? '' : `&who=${b.dataset.who}`}`; });
  if ($('#kall')) $('#kall').onclick = e => { e.preventDefault(); location.hash = `#/kpi?tab=dash&week=${week}`; };
  $$('[data-k]', el).forEach(r => r.onclick = () => {
    const k = d.kpis.find(x => x.id === r.dataset.k);
    const where = k.input === 'calc' ? `Calculated: <code>${esc(k.rule || '')}</code>` : k.origin === 'auto' ? `Automatic — ${esc(k.auto_source || k.source || '')}` : k.origin === 'manual' ? `Typed in${k.auto_value != null ? ` (replacing the automatic ${kpiFmt(k.auto_value, k.unit)})` : ''}` : 'No number yet';
    modal(`<h2>${esc(k.id)} · ${esc(k.metric)}</h2><dl class="kv">
      <dt>This week</dt><dd><b>${kpiFmt(k.value, k.unit)}</b> ${kpiPill(k.status)}</dd><dt>Target</dt><dd>${esc(kpiTarget(k))}${k.target_note ? `<div class="small muted">${esc(k.target_note)}</div>` : ''}</dd>
      <dt>Where it came from</dt><dd>${where}</dd>${k.entered_by ? `<dt>Entered</dt><dd>${esc(k.entered_by)} · ${esc(kpiStamp(k.entered_at))}</dd>` : ''}
      ${k.reason ? `<dt>Why replaced</dt><dd>${esc(k.reason)}</dd>` : ''}<dt>Source</dt><dd>${esc(k.source || '—')}</dd><dt>How it's measured</dt><dd>${esc(k.how || '—')}</dd>
      <dt>Owner</dt><dd>${esc(k.owner)} · ${esc(k.section)}</dd>${k.note ? `<dt>Cause</dt><dd>${esc(k.note.cause)}</dd><dt>Fix</dt><dd>${esc(k.note.fix)}</dd>` : ''}</dl>
      <div class="actions"><a class="btn" href="#/kpi?tab=o${k.owner_id}&week=${week}">Open ${esc(k.owner)}'s page</a><button class="btn primary" data-x>Close</button></div>`);
    const x = $('.modal [data-x]'); if (x) x.onclick = () => x.closest('.modal-bg').remove();
  });
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
