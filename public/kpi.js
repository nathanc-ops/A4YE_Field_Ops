'use strict';
// 🎯 KPIs — the KPI Command Center web app, inside Field Ops: Team overview (tiles, team cards, every KPI with filters, search,
// sparklines and a drill-down drawer) and one page per person (live status while typing, auto numbers that can be replaced
// with a reason, cause and fix on every yellow or red row, extra items, Save draft / Submit week).
// The server (server/kpi.js) decides who sees what and is the final word on every rule; this re-works the same rules live.

const KPI_STATE = { in: ['Submitted', 'ok'], late: ['Submitted late', 'ok'], missing: ['Not submitted', 'warn'], open: ['Not submitted', 'warn'] };
const KPI_ST = { green: 'GREEN', yellow: 'YELLOW', red: 'RED', no_data: 'NO DATA', info: 'INFO', no_target: 'NO TARGET' };
const KPI_FILTER_LABEL = { '': 'All', red: 'Red', yellow: 'Yellow', green: 'Green', no_data: 'No data', info: 'Info' };
const KPI_COLORS = ['#d6001c', '#7a3fd6', '#0e7490', '#c2410c', '#2f7d4f', '#b45309', '#2563eb', '#be185d'];
const KPI_SRC = { auto: 'auto', feed: 'feed', manual: 'entered', override: 'override', calc: 'calc', none: 'missing' };
let KPI = { d: null, filter: { owner: '', status: '', q: '' }, ids: [], cur: null, week: null, edit: null };

const kpiColor = i => KPI_COLORS[(i < 0 ? 0 : i) % KPI_COLORS.length];
const kpiAv = (name, color, cls = '') => `<span class="kav ${cls}" style="--av:${esc(color)}">${esc(String(name || '?').trim().slice(0, 1).toUpperCase())}</span>`;
function kpiFmt(v, unit) {
  if (v === null || v === undefined || v === '' || Number.isNaN(Number(v))) return '—';
  v = Number(v);
  if (unit === '$') return (v < 0 ? '-$' : '$') + Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: Math.abs(v) >= 1000 ? 0 : 2 });
  if (unit === '%') return `${Math.round(v * 1000) / 10}%`;
  if (unit === 'hrs') return `${Math.round(v * 10) / 10} h`;
  if (unit === 'days') return `${Math.round(v * 10) / 10} d`;
  return (Math.round(v * 100) / 100).toLocaleString('en-US');
}
function kpiShort(v, unit) {
  if (v === null || v === undefined || Number.isNaN(v)) return '';
  const a = Math.abs(v);
  if (unit === '$') return (v < 0 ? '-$' : '$') + (a >= 1e6 ? `${(a / 1e6).toFixed(1)}M` : a >= 1e3 ? `${Math.round(a / 1e3)}k` : Math.round(a));
  if (unit === '%') return `${Math.round(v * 100)}%`;
  return a >= 1e4 ? `${Math.round(v / 1e3)}k` : String(Math.round(v * 10) / 10);
}
const kpiIn = (v, unit) => v == null ? '' : String(unit === '%' ? Math.round(v * 10000) / 100 : Math.round(v * 10000) / 10000);
const kpiOut = (s, unit) => { const t = String(s ?? '').replace(/[$,%\s]/g, ''); if (t === '') return null; const n = Number(t); return Number.isFinite(n) ? (unit === '%' ? n / 100 : n) : NaN; };
const kpiTarget = m => m.better === 'Info' ? '—' : m.target == null ? 'not set' : `${m.better === 'Lower' ? '≤ ' : '≥ '}${kpiFmt(m.target, m.unit)}`;
const kpiBadge = st => `<span class="kst k-${st}">${esc(KPI_ST[st] || st)}</span>`;
const kpiSrc = (o, title = '') => `<span class="ksrc s-${o}" title="${esc(title)}">${KPI_SRC[o] || o}</span>`;
const kpiTone = st => ({ green: 'var(--kgreen)', yellow: 'var(--kyellow)', red: 'var(--kred)' }[st] || 'var(--border)');
const kpiMD = d => { const x = new Date(d + 'T12:00:00Z'); return `${x.getUTCMonth() + 1}/${x.getUTCDate()}`; };
const kpiWeekLabel = w => { if (!w) return ''; const e = new Date(w + 'T12:00:00Z'); e.setUTCDate(e.getUTCDate() + 6); return `${kpiMD(w)}–${kpiMD(e.toISOString().slice(0, 10))}/${String(e.getUTCFullYear()).slice(2)}`; };
const kpiDue = s => { const [d, t] = s.split(' '); const x = new Date(`${d}T${t}:00Z`); return `${x.toLocaleDateString('en-US', { weekday: 'short', month: 'numeric', day: 'numeric', timeZone: 'UTC' })} ${x.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' })}`; };
const kpiStamp = s => s ? new Date(normDT(s)).toLocaleString('en-US', { month: 'numeric', day: 'numeric', year: '2-digit', hour: 'numeric', minute: '2-digit' }) : '';
function kpiDelta(m, v) {
  if (v == null || Number.isNaN(v) || m.target == null || (m.better !== 'Higher' && m.better !== 'Lower')) return '';
  const d = v - m.target, good = m.better === 'Higher' ? d >= 0 : d <= 0;
  const txt = m.unit === '%' ? `${Math.round(Math.abs(d) * 1000) / 10} pts` : m.target === 0 ? kpiFmt(Math.abs(d), m.unit) : `${Math.round(Math.abs(d / m.target) * 100)}%`;
  return `<div class="kdelta ${good ? 'good' : 'bad'}">${d >= 0 ? '▲' : '▼'} ${txt} ${d >= 0 ? 'over' : 'under'} target</div>`;
}
function kpiSpark(trend, st) {
  const pts = trend.map((v, i) => [i, v]).filter(p => p[1] != null);
  if (pts.length < 2) return '<span class="muted">—</span>';
  const ys = pts.map(p => p[1]), lo = Math.min(...ys), hi = Math.max(...ys), n = trend.length - 1 || 1;
  const xy = pts.map(p => [p[0] / n * 104 + 3, hi === lo ? 14 : 25 - (p[1] - lo) / (hi - lo) * 21]);
  const d = xy.map(q => `${q[0].toFixed(1)},${q[1].toFixed(1)}`).join(' '), last = xy[xy.length - 1];
  return `<svg class="kspark c-${st}" viewBox="0 0 110 28" aria-hidden="true"><path d="M${xy[0][0].toFixed(1)},27 L${d.replace(/ /g, ' L')} L${last[0].toFixed(1)},27 Z" fill="currentColor" opacity=".1"/><polyline fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round" points="${d}"/><circle cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="2.6" fill="currentColor"/></svg>`;
}
function kpiRing(pct, cls = '') {
  const r = 28, c = 2 * Math.PI * r, off = pct == null ? c : c * (1 - Math.max(0, Math.min(1, pct)));
  return `<svg class="kring ${cls}" viewBox="0 0 70 70"><circle class="trk" cx="35" cy="35" r="${r}"/><circle class="arc" cx="35" cy="35" r="${r}" stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}"/></svg>`;
}

// ---- the web app's rules, run in the browser while numbers are typed (the server checks again on save)
function kpiEval(expr, vals) {
  const toks = String(expr || '').match(/[A-Za-z_][A-Za-z_0-9]*|\d+(\.\d+)?|[-+*/()]/g) || [];
  let i = 0, missing = false;
  const peek = () => toks[i], next = () => toks[i++];
  function factor() {
    const t = next();
    if (t === '(') { const v = sum(); next(); return v; }
    if (t === '-') { const u = factor(); return u === null ? null : -u; }
    if (/^\d/.test(t)) return Number(t);
    const x = vals[t];
    if (x === null || x === undefined || x === '' || Number.isNaN(Number(x))) { missing = true; return null; }
    return Number(x);
  }
  function prod() { let v = factor(); while (peek() === '*' || peek() === '/') { const op = next(), r = factor(); if (v === null || r === null) { v = null; continue; } if (op === '/') { if (r === 0) { missing = true; v = null; } else v /= r; } else v *= r; } return v; }
  function sum() { let v = prod(); while (peek() === '+' || peek() === '-') { const op = next(), r = prod(); v = v === null || r === null ? null : op === '+' ? v + r : v - r; } return v; }
  const out = sum();
  return missing || out === null || !Number.isFinite(out) ? null : Math.round(out * 1e6) / 1e6;
}
function kpiStatusOf(m, v, band) {
  if (m.better === 'Info') return 'info';
  if (v === null || v === undefined || Number.isNaN(v)) return 'no_data';
  if (m.target === null || m.target === undefined) return 'no_target';
  const t = Number(m.target), b = Number(band) || 0;
  if (m.better === 'Higher') return v >= t ? 'green' : (t > 0 && v >= t * (1 - b)) ? 'yellow' : 'red';
  return v <= t ? 'green' : (t > 0 && v <= t * (1 + b)) ? 'yellow' : 'red';
}
function kpiScore(m, trend, band) {
  let st = kpiStatusOf(m, trend[trend.length - 1], band), wrong = false;
  if (st === 'green' || st === 'yellow') {
    const t = trend.slice(-4);
    if (t.length === 4 && t.every(x => x !== null && x !== undefined)) { wrong = [1, 2, 3].every(i => m.better === 'Higher' ? t[i] < t[i - 1] : t[i] > t[i - 1]); if (wrong) st = 'red'; }
  }
  return { status: st, wrong_way: wrong };
}

// ================================================================ page frame
async function viewKpi() {
  const q = new URLSearchParams((location.hash.split('?')[1]) || '');
  const me = await GET('/kpi/me');
  KPI.me = me;
  const tabs = [];
  if (me.view_all || me.edit_all) tabs.push({ k: 'dash', html: 'Team overview', cls: 'master' });
  me.owners.forEach((o, i) => tabs.push({ k: `o${o.id}`, html: `${kpiAv(o.name, kpiColor(i), 'sm')}${esc(o.name)}` }));
  if (me.edit_all) tabs.push({ k: 'setup', html: 'Targets & set-up', cls: 'minor' });
  if (me.admin) tabs.push({ k: 'import', html: 'Import', cls: 'minor' });
  if (!tabs.length) { $('#view').innerHTML = setTop('KPIs') + '<div class="card"><p>You have no KPI page. An admin links each KPI owner to a person under KPIs → Targets & set-up.</p></div>'; return; }
  const mine = me.owners.find(o => o.user_id === S.user.id);
  let tab = q.get('tab') || (me.view_all || me.edit_all ? 'dash' : mine ? `o${mine.id}` : tabs[0].k);
  if (!tabs.some(t => t.k === tab)) tab = tabs[0].k;
  const week = me.weeks.includes(q.get('week')) ? q.get('week') : me.week;
  KPI.week = week;
  const logo = S.settings.logo_url || '/brand/a4y-logo.png';
  const weekly = tab === 'dash' || tab.startsWith('o');
  $('#view').innerHTML = `<header class="ktop"><div class="krow1"><button class="btn menu-btn" onclick="document.getElementById('side').classList.toggle('open')">☰</button>
      <div class="kbrand"><div class="t">KPI <em>Command</em> Center</div><div class="s">Powered by people. Built all 4 you</div></div>
      <div class="klogo"><img alt="${esc(S.settings.company_name || '')}" src="${esc(logo)}"></div></div>
    <div class="krow2"><nav class="knav">${tabs.map(t => `<a href="#/kpi?tab=${t.k}&week=${week}" class="${t.k === tab ? 'on' : ''} ${t.cls || ''}">${t.html}</a>`).join('')}</nav>
      ${weekly ? `<div class="kctl"><label>Week <select id="kwk">${me.weeks.map(w => `<option value="${w}" ${w === week ? 'selected' : ''}>${kpiWeekLabel(w)}</option>`).join('')}</select></label><span id="kupd" class="klive"></span></div>` : ''}</div></header>
    <div id="kbody"><div class="kskel"><i></i><i></i><i></i><i></i><i class="tall"></i></div></div>
    <div id="kshade"></div><aside id="kdrawer" aria-label="KPI details"><div id="kdrill"></div></aside>`;
  if ($('#kwk')) $('#kwk').onchange = e => { if (kpiDirtyOk()) location.hash = `#/kpi?tab=${tab}&week=${e.target.value}`; else e.target.value = week; };
  $('#kshade').onclick = kpiClose;
  const el = $('#kbody');
  KPI.updated = at => { if ($('#kupd') && at) { $('#kupd').textContent = `Updated ${kpiStamp(at)}`; } };
  if (tab === 'dash') return kpiMaster(el, week);
  if (tab === 'setup') return kpiSetup(el);
  if (tab === 'import') return kpiImport(el);
  const idx = me.owners.findIndex(o => `o${o.id}` === tab);
  return kpiOwner(el, Number(tab.slice(1)), week, kpiColor(idx));
}
const kpiDirtyOk = () => !(KPI.edit && KPI.edit.dirty) || confirm('You have unsaved changes on this page. Leave without saving?');
window.addEventListener('beforeunload', e => { if (KPI.edit && KPI.edit.dirty && /^#\/kpi/.test(location.hash)) { e.preventDefault(); e.returnValue = ''; } });

// ================================================================ team overview
async function kpiMaster(el, week) {
  const d = await GET(`/kpi/dashboard?week=${week}`);
  KPI.d = d; KPI.edit = null; KPI.updated(d.updated_at);
  KPI.color = id => kpiColor(d.reports.findIndex(r => r.id === id));
  const H = d.health, pct = d.scored ? H.green / d.scored : null, nSub = d.submitted;
  const tile = (st, label, n, hint, tone) => `<button class="kstat ${KPI.filter.status === st ? 'on' : ''}" style="--tone:${tone}" data-fs="${st}"><div class="lbl">${label}</div><div class="val">${n}</div><div class="hint">${hint}</div></button>`;
  const bar = (c, cls) => { const tot = c.green + c.yellow + c.red + c.no_data || 1; return `<div class="${cls}">${[['green', 'G'], ['yellow', 'Y'], ['red', 'R'], ['no_data', 'N']].map(k => c[k[0]] ? `<i class="bg-${k[1]}" style="width:${(c[k[0]] / tot * 100).toFixed(2)}%" title="${c[k[0]]} ${k[0].replace('_', ' ')}"></i>` : '').join('')}</div>`; };
  el.innerHTML = `<div class="kfade"><div class="khero"><div><h1>Week of ${kpiWeekLabel(d.week)}</h1><div class="sub">Owner pages are due ${esc(kpiDue(d.due))}. Click any KPI to see where its number came from.</div></div>
      <details class="khow"><summary>How status works</summary><div class="pop"><b class="ok">Green</b> is at or better than target. <b style="color:var(--kyellow)">Yellow</b> is within ${Math.round(d.band * 100)}% of target.
        <b class="warn">Red</b> is beyond that, or moving the wrong way 3 weeks running. Every red or yellow KPI needs a cause and a fix from its owner.</div></details></div>
    <div class="kstats">
      <button class="kstat ring" style="--tone:var(--kgreen)" data-fs="green">${kpiRing(pct)}<div><div class="lbl">On target</div><div class="val">${pct == null ? '—' : `${Math.round(pct * 100)}<small>%</small>`}</div><div class="hint">${H.green} of ${d.scored} scored KPIs</div></div></button>
      ${tile('red', 'Red', H.red, 'Off target or sliding', 'var(--kred)')}${tile('yellow', 'Yellow', H.yellow, 'Close to target', 'var(--kyellow)')}${tile('no_data', 'No data', H.no_data, 'Waiting on a number', '#b9bfca')}
      <button class="kstat" style="--tone:var(--brand,#d6001c)" id="kgo-team"><div class="lbl">Pages submitted</div><div class="val">${nSub}<small>/${d.reports.length}</small></div><div class="hint">${nSub === d.reports.length ? 'Everyone is in' : `Waiting on ${esc(d.waiting_on.join(', '))}`}</div></button>
      <button class="kstat" style="--tone:${d.need_note ? 'var(--kred)' : 'var(--kgreen)'}" data-fs="red"><div class="lbl">Need cause and fix</div><div class="val">${d.need_note}</div><div class="hint">${d.need_note ? 'Off-target KPIs not explained' : 'Every off-target KPI explained'}</div></button></div>
    ${bar(H, 'kteambar')}<div class="klegend"><span><i class="bg-G"></i>${H.green} green</span><span><i class="bg-Y"></i>${H.yellow} yellow</span><span><i class="bg-R"></i>${H.red} red</span><span><i class="bg-N"></i>${H.no_data} no data</span>${H.info ? `<span>${H.info} tracked for info</span>` : ''}</div>
    <div class="ksect" id="kowners"><h2>Team</h2><span class="muted small">Click a person to filter the KPI list</span></div>
    <div class="kcards">${d.reports.map((r, i) => { const st = KPI_STATE[r.state];
      return `<div class="kcard ${KPI.filter.owner === String(r.id) ? 'on' : ''}" data-fo="${r.id}"><div class="top">${kpiAv(r.name, kpiColor(i))}<h3><span>${esc(r.name)}</span><span class="chip ${st[1]}" title="${esc(r.at ? `${kpiStamp(r.at)} by ${r.by || ''}` : '')}">${st[0]}</span></h3></div>
        ${bar(r, 'mini')}<div class="pills">${['green', 'yellow', 'red', 'no_data'].map(k => `<span class="pill k-${k}" data-fo2="${r.id}" data-fs2="${k}">${r[k]} ${k.replace('_', ' ')}</span>`).join('')}</div>
        <div class="foot"><div class="sub">${r.need_note ? `<span class="warn">${r.need_note} off-target without cause/fix</span>` : 'Every off-target KPI explained'}</div><a class="open" href="#/kpi?tab=o${r.id}&week=${d.week}">Open page ›</a></div></div>`; }).join('')}</div>
    <div class="ksect" id="kkpis"><h2>All KPIs</h2></div>
    <div class="ktool"><div class="kseg" id="kchips"></div>
      <select id="kfo"><option value="">Everyone</option>${d.reports.map(r => `<option value="${r.id}" ${KPI.filter.owner === String(r.id) ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}</select>
      <label class="ksearch"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2"><circle cx="9" cy="9" r="6"/><path d="M14 14l4 4"/></svg><input id="kfq" placeholder="Search KPIs" value="${esc(KPI.filter.q)}" aria-label="Search KPIs"></label>
      <span class="count" id="kcount"></span></div>
    <div class="ktablewrap"><div class="scroll" id="ktbl"></div></div>
    ${d.extras.length ? `<div class="ksect"><h2>Extra numbers reported this week</h2></div><div class="ktablewrap"><div class="scroll"><table class="ktab"><tr><th>Owner</th><th>Item</th><th class="num">Value</th><th>Explanation</th></tr>
      ${d.extras.map(x => `<tr><td>${kpiAv(x.owner, KPI.color(x.owner_id), 'sm')} ${esc(x.owner)}</td><td>${esc(x.item)}</td><td class="num"><b>${esc(x.value || '')}</b></td><td>${esc(x.explanation)}<div class="muted small">${esc(`${x.by_label || ''} · ${kpiStamp(x.at)}`)}</div></td></tr>`).join('')}</table></div></div>` : ''}</div>`;
  const setFilter = (o, s, scroll) => { KPI.filter.owner = o; KPI.filter.status = s; kpiMaster(el, week).then(() => { if (scroll && $('#kkpis')) $('#kkpis').scrollIntoView({ behavior: 'smooth' }); }); };
  $$('[data-fs]', el).forEach(b => b.onclick = () => setFilter('', KPI.filter.status === b.dataset.fs ? '' : b.dataset.fs, true));
  $$('[data-fo]', el).forEach(b => b.onclick = e => { if (e.target.closest('a,.pill')) return; setFilter(KPI.filter.owner === b.dataset.fo ? '' : b.dataset.fo, KPI.filter.status, true); });
  $$('[data-fo2]', el).forEach(b => b.onclick = () => setFilter(b.dataset.fo2, b.dataset.fs2, true));
  $('#kgo-team').onclick = () => $('#kowners').scrollIntoView({ behavior: 'smooth' });
  $('#kfo').onchange = e => setFilter(e.target.value, KPI.filter.status);
  let tq; $('#kfq').oninput = e => { KPI.filter.q = e.target.value; clearTimeout(tq); tq = setTimeout(kpiTable, 150); };
  kpiTable();
}
function kpiTable() {
  const d = KPI.d, F = KPI.filter, q = F.q.toLowerCase();
  let last = '', shown = 0, h = '<table class="ktab"><tr><th>KPI</th><th class="num">Value</th><th class="num hide-sm">Target</th><th>Status</th><th class="hide-sm">Source</th><th class="hide-sm">12 weeks</th></tr>';
  KPI.ids = [];
  for (const k of d.kpis) {
    if (F.owner && String(k.owner_id) !== F.owner) continue;
    if (F.status && k.status !== F.status) continue;
    if (q && `${k.metric} ${k.id} ${k.section}`.toLowerCase().indexOf(q) < 0) continue;
    const sec = `${k.owner} · ${k.section}`;
    if (sec !== last) { h += `<tr class="sec"><td colspan="6">${esc(sec)}</td></tr>`; last = sec; }
    const off = k.status === 'red' || k.status === 'yellow';
    h += `<tr class="krow s-${k.status}" data-k="${esc(k.id)}"><td><span class="kid">${esc(k.id)}</span> <span class="kname">${esc(k.metric)}</span>${off ? (k.note && k.note.cause && k.note.fix ? ` <span class="muted" title="${esc(`Cause: ${k.note.cause}\nFix: ${k.note.fix}`)}">✎</span>` : ' <span class="warn" title="No cause/fix yet">!</span>') : ''}</td>
      <td class="num"><b>${kpiFmt(k.value, k.unit)}</b>${kpiDelta(k, k.value)}</td><td class="num hide-sm">${esc(kpiTarget(k))}</td><td>${kpiBadge(k.status)}${k.wrong_way ? ' <span class="muted" title="Moved the wrong way 3 weeks running">↘3</span>' : ''}</td>
      <td class="hide-sm">${kpiSrc(k.origin, k.origin === 'calc' ? `Calculated: ${k.rule}` : k.auto_source || k.source || '')}</td><td class="hide-sm">${kpiSpark(k.trend, k.status)}</td></tr>`;
    shown++; KPI.ids.push(k.id);
  }
  h += '</table>';
  if (!shown) h = '<div class="kempty"><b>No KPIs match.</b>Try another status, person or search. <button class="kclear" id="kclr">Clear filters</button></div>';
  $('#ktbl').innerHTML = h;
  const own = d.kpis.filter(k => !F.owner || String(k.owner_id) === F.owner), cnt = s => own.filter(k => k.status === s).length;
  $('#kchips').innerHTML = ['', 'red', 'yellow', 'green', 'no_data', 'info'].map(s => `<button type="button" class="${F.status === s ? 'on' : ''}" data-chip="${s}">${s ? `<span class="kdot d-${s}"></span>` : ''}${KPI_FILTER_LABEL[s]}<span class="n">${s ? cnt(s) : own.length}</span></button>`).join('');
  $$('[data-chip]').forEach(b => b.onclick = () => { F.status = b.dataset.chip; kpiTable(); });
  $('#kcount').innerHTML = `Showing ${shown} of ${d.kpis.length}${F.owner || F.status || F.q ? ' · <button class="kclear" id="kclr2">Clear</button>' : ''}`;
  const clear = () => { KPI.filter = { owner: '', status: '', q: '' }; kpiMaster($('#kbody'), KPI.week); };
  if ($('#kclr')) $('#kclr').onclick = clear; if ($('#kclr2')) $('#kclr2').onclick = clear;
  $$('#ktbl [data-k]').forEach(r => r.onclick = () => kpiDrill(r.dataset.k));
}

// ================================================================ drill-down drawer
function kpiChart(m, weeks) {
  const trend = m.trend, W = 540, H = 190, L = 46, R = 14, T = 14, B = 26;
  const pts = trend.map((v, i) => [i, v]).filter(p => p[1] != null && !Number.isNaN(p[1]));
  if (pts.length < 2) return '<p class="muted">Not enough history yet to draw a trend.</p>';
  const ys = pts.map(p => Number(p[1])), hasT = m.target != null && m.better !== 'Info';
  if (hasT) ys.push(Number(m.target));
  let lo = Math.min(...ys), hi = Math.max(...ys);
  if (hi === lo) { hi += Math.abs(hi) * 0.1 || 1; lo -= Math.abs(lo) * 0.1 || 1; }
  const pad = (hi - lo) * 0.1; hi += pad; lo = lo >= 0 && lo - pad < 0 ? 0 : lo - pad;
  const n = trend.length - 1 || 1, X = i => L + i / n * (W - L - R), Y = v => T + (hi - v) / (hi - lo) * (H - T - B);
  const col = kpiTone(m.status) === 'var(--border)' ? 'var(--muted)' : kpiTone(m.status);
  let s = `<svg class="kchart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(m.metric)} over the last ${trend.length} weeks"><defs><linearGradient id="kcg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${col}" stop-opacity=".22"/><stop offset="1" stop-color="${col}" stop-opacity="0"/></linearGradient></defs>`;
  for (let g = 0; g <= 3; g++) { const gv = lo + (hi - lo) * g / 3, gy = Y(gv); s += `<line class="grid" x1="${L}" x2="${W - R}" y1="${gy.toFixed(1)}" y2="${gy.toFixed(1)}"/><text x="${L - 6}" y="${(gy + 3).toFixed(1)}" text-anchor="end">${esc(kpiShort(gv, m.unit))}</text>`; }
  weeks.forEach((w, i) => { if (i % 2 === (weeks.length - 1) % 2) s += `<text x="${X(i).toFixed(1)}" y="${H - 6}" text-anchor="middle">${kpiMD(w)}</text>`; });
  if (hasT) { const ty = Y(Number(m.target)); s += `<line class="tgt" x1="${L}" x2="${W - R}" y1="${ty.toFixed(1)}" y2="${ty.toFixed(1)}"/><text x="${W - R}" y="${(ty - 5).toFixed(1)}" text-anchor="end">Target ${esc(kpiShort(Number(m.target), m.unit))}</text>`; }
  const line = pts.map(p => `${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`);
  s += `<path d="M${X(pts[0][0]).toFixed(1)},${H - B} L${line.join(' L')} L${X(pts[pts.length - 1][0]).toFixed(1)},${H - B} Z" fill="url(#kcg)"/><polyline points="${line.join(' ')}" fill="none" stroke="${col}" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"/>`;
  pts.forEach((p, k) => { s += `<circle class="pt" id="kcp${p[0]}" cx="${X(p[0]).toFixed(1)}" cy="${Y(p[1]).toFixed(1)}" r="${k === pts.length - 1 ? 5 : 3.2}" fill="var(--surface)" stroke="${col}" stroke-width="2"/>`; });
  const bw = (W - L - R) / (n || 1);
  trend.forEach((v, i) => { s += `<rect class="hit" data-tip="${i}" x="${(X(i) - bw / 2).toFixed(1)}" y="${T}" width="${bw.toFixed(1)}" height="${H - T - B}"><title>${kpiWeekLabel(weeks[i])}: ${esc(kpiFmt(v, m.unit))}</title></rect>`; });
  return `${s}</svg><div class="kctip" id="kctip">Hover or tap the chart to read a week.</div>`;
}
async function kpiDrill(id) {
  KPI.cur = id;
  let m; try { m = await GET(`/kpi/metric/${encodeURIComponent(id)}?week=${KPI.week}`); } catch (e) { return toast(e.message, true); }
  const list = KPI.ids.includes(id) ? KPI.ids : [id], pos = list.indexOf(id);
  const where = m.input === 'calc' ? `<p>Calculated: <code>${esc(m.rule || '')}</code></p><table class="ktab"><tr><th>Input</th><th class="num">Value</th><th>Source</th></tr>
      ${m.consts.map(x => `<tr><td>${esc(x.name)}</td><td class="num">${kpiFmt(x.value, x.unit)}</td><td>Settings</td></tr>`).join('')}
      ${m.inputs.map(x => `<tr class="krow" data-k="${esc(x.id)}"><td><span class="kid">${esc(x.id)}</span> ${esc(x.metric)}</td><td class="num">${kpiFmt(x.value, x.unit)}</td><td>${kpiSrc(x.origin)}</td></tr>`).join('')}</table>
      ${m.value == null ? '<p class="muted">Blank until every input above has a number (or the divisor is zero).</p>' : ''}`
    : m.origin === 'auto' || m.origin === 'feed' ? `<p>${kpiSrc(m.origin)} ${esc(m.auto_source || '')}${m.auto_link ? ` · <a target="_blank" rel="noopener" href="${esc(m.auto_link)}">open source</a>` : ''}</p>${m.auto_note ? `<p class="muted">${esc(m.auto_note)}</p>` : ''}`
      : m.origin === 'override' ? `<p>${kpiSrc('override')} Override by ${esc(m.entered_by || '')} · ${esc(kpiStamp(m.entered_at))} (${esc(m.auto_source || 'auto')} said ${kpiFmt(m.auto_value, m.unit)})</p><p><b>Reason:</b> ${esc(m.reason || '')}</p>`
        : m.origin === 'manual' ? `<p>${kpiSrc('manual')} Entered by ${esc(m.entered_by || '')} · ${esc(kpiStamp(m.entered_at))}</p>` : '<p class="warn">No number for this week yet.</p>';
  const du = /hrs|days/.test(m.unit) ? m.unit : '$';
  const tot = m.detail.reduce((s, x) => s + (Number(x.amount) || 0), 0);
  $('#kdrill').innerHTML = `<div class="kdhead" style="--tone:${kpiTone(m.status)}"><div class="kdbar"><button class="kx" id="kclose">Close</button>
      ${list.length > 1 ? `<div class="kstep"><span class="pos">${pos + 1} of ${list.length}</span><button class="knb" data-step="-1" title="Previous KPI (←)">‹</button><button class="knb" data-step="1" title="Next KPI (→)">›</button></div>` : ''}</div>
    <div><span class="kid">${esc(m.id)}</span> <span class="muted small">${esc(m.owner)} · ${esc(m.section)}</span></div><h2>${esc(m.metric)}</h2>
    <div class="kdval"><div class="big">${kpiFmt(m.value, m.unit)}</div>${kpiBadge(m.status)}${kpiDelta(m, m.value)}</div>
    <div class="kdmeta">Target ${esc(kpiTarget(m))} · ${esc(m.better === 'Info' ? 'tracked, no status' : `${m.better} is better`)} · week of ${kpiWeekLabel(m.week)}</div>
    ${m.wrong_way ? '<div class="kcallout">Red because it moved the wrong way 3 weeks running.</div>' : ''}</div>
    <div class="kdbody"><div class="kpanel"><h4>Last ${m.weeks.length} weeks</h4>${kpiChart(m, m.weeks)}</div>
    <div class="kpanel"><h4>Where this number came from</h4>${where}${m.input !== 'calc' ? `<p class="muted">Pulled from: ${esc(m.source || '—')}${m.how ? `<br>Measured as: ${esc(m.how)}` : ''}</p>` : ''}${m.target_note ? `<p class="muted"><b>Target note:</b> ${esc(m.target_note)}</p>` : ''}</div>
    ${m.detail.length ? `<div class="kpanel"><h4>Line items (${m.detail.length})</h4><table class="ktab"><tr><th>Item</th><th class="num">${du === '$' ? 'Amount' : du === 'hrs' ? 'Hours' : 'Count'}</th></tr>
      ${m.detail.map(x => `<tr><td>${x.link ? `<a target="_blank" rel="noopener" href="${esc(x.link)}">${esc(x.label)}</a>` : esc(x.label)}<div class="muted small">${esc(x.ref || '')}</div></td><td class="num">${x.amount == null ? '—' : kpiFmt(x.amount, du)}</td></tr>`).join('')}
      <tr><td><b>Total</b></td><td class="num"><b>${kpiFmt(tot, du)}</b></td></tr></table></div>` : ''}
    ${m.note && (m.note.cause || m.note.fix) ? `<div class="kpanel"><h4>Cause and fix</h4><p><b>Cause:</b> ${esc(m.note.cause)}</p><p><b>Fix:</b> ${esc(m.note.fix)}</p><p class="muted small">${esc(`${m.note.by || ''} · ${kpiStamp(m.note.at)}`)}</p></div>`
      : m.status === 'red' || m.status === 'yellow' ? `<div class="kpanel"><h4>Cause and fix</h4><p class="warn">${esc(m.owner)} hasn't explained this one yet.</p></div>` : ''}
    ${m.history.length ? `<div class="kpanel"><h4>Entries this week</h4><table class="ktab"><tr><th>When</th><th>Who</th><th class="num">Value</th><th>Type</th></tr>
      ${m.history.map(x => `<tr><td>${esc(kpiStamp(x.at))}</td><td>${esc(x.by_label || '')}</td><td class="num">${kpiFmt(x.value, m.unit)}</td><td>${esc(x.origin)}${x.reason ? `<div class="muted">${esc(x.reason)}</div>` : ''}</td></tr>`).join('')}</table></div>` : ''}
    <div class="kpanel"><h4>Week by week</h4><table class="ktab"><tr><th>Week</th><th class="num">Value</th><th>Source</th></tr>
      ${m.by_week.slice().reverse().map(x => `<tr><td>${kpiWeekLabel(x.week)}</td><td class="num">${kpiFmt(x.value, m.unit)}</td><td>${kpiSrc(x.origin)}</td></tr>`).join('')}</table></div></div>`;
  $('#kdrawer').classList.add('open'); $('#kdrawer').scrollTop = 0; $('#kshade').classList.add('open'); document.body.classList.add('klock');
  $('#kclose').onclick = kpiClose;
  $$('#kdrill [data-step]').forEach(b => b.onclick = () => kpiStep(Number(b.dataset.step)));
  $$('#kdrill tr[data-k]').forEach(r => r.onclick = () => kpiDrill(r.dataset.k));
  $$('#kdrill [data-tip]').forEach(r => { const f = () => { const i = Number(r.dataset.tip), w = m.weeks[i], o = m.by_week[i] ? m.by_week[i].origin : 'none';
    $('#kctip').innerHTML = `Week of ${kpiWeekLabel(w)}: <b>${kpiFmt(m.trend[i], m.unit)}</b> · ${KPI_SRC[o] || o}`; $$('#kdrill .pt').forEach(p => p.setAttribute('r', p.id === `kcp${i}` ? 6 : 3.2)); };
    r.onmouseenter = f; r.onclick = f; });
}
function kpiStep(dx) { const list = KPI.ids.includes(KPI.cur) ? KPI.ids : [KPI.cur], i = list.indexOf(KPI.cur); if (i >= 0 && list.length > 1) kpiDrill(list[(i + dx + list.length) % list.length]); }
function kpiClose() { if (!$('#kdrawer')) return; $('#kdrawer').classList.remove('open'); $('#kshade').classList.remove('open'); document.body.classList.remove('klock'); }
document.addEventListener('keydown', e => {
  const dr = $('#kdrawer'); if (!dr || !dr.classList.contains('open')) return;
  const tag = (e.target && e.target.tagName) || '';
  if (e.key === 'Escape') kpiClose();
  else if (!/INPUT|TEXTAREA|SELECT/.test(tag) && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) kpiStep(e.key === 'ArrowRight' ? 1 : -1);
});

// ================================================================ owner page
async function kpiOwner(el, ownerId, week, color) {
  const p = await GET(`/kpi/page?owner=${ownerId}&week=${week}`);
  KPI.updated(p.updated_at);
  const mets = p.sections.flatMap(s => s.metrics);
  KPI.ids = mets.map(m => m.id);
  const E = KPI.edit = { owner: ownerId, p, mets, vals: {}, override: {}, reason: {}, cause: {}, fix: {}, extras: [], dirty: false };
  for (const m of mets) {
    if (m.origin === 'override') { E.override[m.id] = true; E.vals[m.id] = m.value; E.reason[m.id] = m.reason || ''; }
    else if (m.input !== 'calc') E.vals[m.id] = m.origin === 'manual' ? m.value : null;
    if (m.note) { E.cause[m.id] = m.note.cause || ''; E.fix[m.id] = m.note.fix || ''; }
  }
  const sub = p.report.state === 'in' || p.report.state === 'late' ? p.report : null, edit = p.can_edit;
  let last = '', rows = '';
  for (const m of mets) { if (m.section !== last) { rows += `<tr class="sec"><td colspan="4">${esc(m.section)}</td></tr>`; last = m.section; } rows += `<tr id="kr_${esc(m.id)}"></tr>`; }
  el.innerHTML = `<div class="kfade"><div class="kohead">${kpiAv(p.owner.name, color, 'lg')}<div class="grow"><h1>${esc(p.owner.name)}'s KPIs</h1>
      <div class="muted">Week of <b>${kpiWeekLabel(p.week)}</b> (Sun–Sat) · due ${esc(kpiDue(p.due))}</div>
      ${sub ? `<div class="ok" style="margin-top:4px">Submitted ${esc(kpiStamp(sub.at))}${p.report.state === 'late' ? ' (late)' : ''}.${edit ? ' You can still correct numbers and submit again.' : ''}</div>` : ''}</div>
      <div class="kprog">${kpiRing(0)}<div><div class="pt" id="kpg_txt">—</div><div class="pl" id="kpg_sub">KPIs with a number</div></div></div></div>
    <div class="knote">Blue ${kpiSrc('auto')} numbers fill themselves; type the rest. Anything yellow or red needs a cause and a fix before you can submit.</div>
    <div class="ktablewrap"><div class="scroll"><table class="ktab kfrm"><tr class="hd"><th>KPI</th><th class="num">This week</th><th class="num hide-sm">Target</th><th>Status</th></tr>${rows}</table></div></div>
    <div class="ksect"><h2>Anything else worth reporting?</h2></div><p class="muted" style="margin-top:-4px">A number outside your assigned KPIs goes here, with an explanation of why it matters.</p>
    <div class="ktablewrap"><div class="scroll"><table class="ktab kfrm" id="kextras"></table></div></div>${edit ? '<p><button class="btn" id="kaddx">+ Add an item</button></p>' : ''}</div>
    ${edit ? `<div class="kbar"><span class="muted small">Signed in as ${esc(p.signed_in_as || '')}</span><span class="msg" id="kbarmsg"></span><button class="btn" id="ksave">Save draft</button><button class="btn primary" id="ksub">Submit week</button></div>` : ''}`;
  mets.forEach(m => kpiRow(m.id));
  kpiExtras();
  kpiLive();
  if (!edit) return;
  $('#kaddx').onclick = () => { E.extras.push({ item: '', value: '', explanation: '' }); kpiExtras(); };
  $('#ksave').onclick = () => kpiSave(false, el, ownerId, week, color);
  $('#ksub').onclick = () => kpiSave(true, el, ownerId, week, color);
}
const kpiM = id => KPI.edit.mets.find(m => m.id === id);
function kpiRow(id) {
  const E = KPI.edit, m = kpiM(id), hasAuto = m.auto_value != null, el = $(`#kr_${CSS.escape(id)}`), edit = E.p.can_edit;
  let cell;
  if (m.input === 'calc') cell = `<span id="kv_${esc(id)}"></span><div class="muted" style="font-size:11px">${esc(m.rule || '')}</div>`;
  else if (hasAuto && !E.override[id]) cell = `<b>${kpiFmt(m.auto_value, m.unit)}</b> ${kpiSrc(String(m.auto_source || '').startsWith('Feed:') ? 'feed' : 'auto', m.auto_source || '')}${edit ? `<div><a href="#" data-ov="${esc(id)}" style="font-size:11px">replace this number</a></div>` : ''}`;
  else if (!edit) cell = `<b>${kpiFmt(m.value, m.unit)}</b>${m.origin === 'override' ? ` ${kpiSrc('override', m.reason || '')}` : ''}`;
  else {
    const v = E.vals[id], shown = v == null ? '' : m.unit === '%' ? Math.round(v * 10000) / 100 : v;
    cell = `<input type="number" step="any" inputmode="decimal" id="kin_${esc(id)}" value="${esc(shown)}" aria-label="${esc(m.metric)}">${m.unit === '%' ? ' %' : ''}`
      + (hasAuto ? `<div class="kov"><label>Why replace the ${esc(m.auto_source || 'automatic')} number (${kpiFmt(m.auto_value, m.unit)})?</label><input type="text" id="krs_${esc(id)}" value="${esc(E.reason[id] || '')}"><a href="#" data-unov="${esc(id)}" style="font-size:11px">use the auto number</a></div>` : '');
  }
  el.innerHTML = `<td><span class="kid">${esc(id)}</span> <span class="kname">${esc(m.metric)}</span><div class="rowsrc">${esc(m.source || '')}</div>${m.target_note ? `<div class="rowsrc" style="color:var(--kyellow)">${esc(m.target_note)}</div>` : ''}<div id="kwhy_${esc(id)}"></div></td>
    <td class="num">${cell}</td><td class="num hide-sm">${esc(kpiTarget(m))}</td><td id="ks_${esc(id)}"></td>`;
  el.querySelector('.kid').onclick = () => kpiDrill(id); el.querySelector('.kid').style.cursor = 'pointer';
  const inp = $(`#kin_${CSS.escape(id)}`);
  if (inp) inp.oninput = () => { const s = inp.value; let v = s === '' ? null : Number(s); if (v !== null && m.unit === '%') v /= 100; E.vals[id] = v; E.dirty = true; clearTimeout(E.t); E.t = setTimeout(kpiLive, 120); };
  const rs = $(`#krs_${CSS.escape(id)}`); if (rs) rs.oninput = () => { E.reason[id] = rs.value; E.dirty = true; };
  const ov = el.querySelector('[data-ov]'); if (ov) ov.onclick = e => { e.preventDefault(); E.override[id] = true; if (E.vals[id] == null) E.vals[id] = m.auto_value; E.dirty = true; kpiRow(id); kpiLive(); const i2 = $(`#kin_${CSS.escape(id)}`); if (i2) i2.focus(); };
  const un = el.querySelector('[data-unov]'); if (un) un.onclick = e => { e.preventDefault(); E.override[id] = false; E.dirty = true; kpiRow(id); kpiLive(); };
}
// re-work this page's numbers and statuses from what's typed (other pages' numbers come from the server)
function kpiLive() {
  const E = KPI.edit, p = E.p, vals = { OT_RATE: p.ot_rate };
  for (const [id, o] of Object.entries(p.others || {})) vals[id] = o.value;
  for (const m of E.mets) {
    if (m.input === 'calc') continue;
    vals[m.id] = m.auto_value != null && !E.override[m.id] ? m.auto_value : (p.can_edit ? E.vals[m.id] : m.value);
  }
  for (let g = 0, changed = true; changed && g < 10; g++) { changed = false; for (const m of E.mets) if (m.input === 'calc') { const v = kpiEval(m.rule, vals); if (v !== vals[m.id]) { vals[m.id] = v; changed = true; } } }
  let tot = 0, filled = 0, need = 0;
  E.calc = {};
  for (const m of E.mets) {
    const v = vals[m.id] === undefined ? null : vals[m.id], sc = kpiScore(m, [...m.trend.slice(0, -1), v], p.band);
    E.calc[m.id] = { value: v, ...sc };
    tot++; if (v != null && !Number.isNaN(v)) filled++;
    const tr = $(`#kr_${CSS.escape(m.id)}`); if (tr) tr.className = `s-${sc.status}`;
    $(`#ks_${CSS.escape(m.id)}`).innerHTML = kpiBadge(sc.status) + (sc.wrong_way ? ' <span class="muted" title="Moved the wrong way 3 weeks running">↘3</span>' : '');
    const vv = $(`#kv_${CSS.escape(m.id)}`); if (vv) vv.innerHTML = `<b>${kpiFmt(v, m.unit)}</b>`;
    const w = $(`#kwhy_${CSS.escape(m.id)}`), off = sc.status === 'red' || sc.status === 'yellow';
    if (off && !w.firstChild) {
      w.innerHTML = p.can_edit ? `<div class="kwhy"><div><label>Cause (why it's off target)</label><textarea data-c="${esc(m.id)}">${esc(E.cause[m.id] || '')}</textarea></div><div><label>Fix (what you'll do, by when)</label><textarea data-f="${esc(m.id)}">${esc(E.fix[m.id] || '')}</textarea></div></div>`
        : `<div class="kwhy ro"><div><b>Cause:</b> ${esc(E.cause[m.id] || '—')}</div><div><b>Fix:</b> ${esc(E.fix[m.id] || '—')}</div></div>`;
      const c = w.querySelector('[data-c]'), f = w.querySelector('[data-f]');
      if (c) c.oninput = () => { E.cause[m.id] = c.value; E.dirty = true; kpiNeed(m.id); kpiProgress(); };
      if (f) f.oninput = () => { E.fix[m.id] = f.value; E.dirty = true; kpiNeed(m.id); kpiProgress(); };
    } else if (!off && w.firstChild) w.innerHTML = '';
    kpiNeed(m.id);
  }
  kpiProgress();
}
function kpiNeed(id) { const E = KPI.edit, w = $(`#kwhy_${CSS.escape(id)}`); if (!w || !w.firstChild) return; w.className = !String(E.cause[id] || '').trim() || !String(E.fix[id] || '').trim() ? 'need' : ''; }
function kpiProgress() {
  const E = KPI.edit; let tot = 0, filled = 0, need = 0;
  for (const m of E.mets) { const c = E.calc[m.id]; tot++; if (c.value != null) filled++; if ((c.status === 'red' || c.status === 'yellow') && (!String(E.cause[m.id] || '').trim() || !String(E.fix[m.id] || '').trim())) need++; }
  $('#kpg_txt').textContent = `${filled} / ${tot}`;
  $('#kpg_sub').innerHTML = need ? `<span class="warn">${need} still need a cause and fix</span>` : 'KPIs with a number';
  const arc = $('.kprog .arc'); if (arc) { const cc = Number(arc.getAttribute('stroke-dasharray')); arc.setAttribute('stroke-dashoffset', (cc * (1 - (tot ? filled / tot : 0))).toFixed(1)); }
}
function kpiExtras() {
  const E = KPI.edit, saved = E.p.extras || [];
  let h = saved.map(x => `<tr><td>${esc(x.item)}</td><td class="num"><b>${esc(x.value || '')}</b></td><td>${esc(x.explanation)}<div class="muted small">saved ${esc(kpiStamp(x.at))}</div></td></tr>`).join('');
  h += E.extras.map((x, i) => `<tr><td><input type="text" placeholder="What" data-xi="${i}" data-xk="item" value="${esc(x.item)}"></td><td style="width:140px"><input type="text" placeholder="Value" data-xi="${i}" data-xk="value" value="${esc(x.value)}"></td>
    <td><textarea placeholder="Why it matters (required)" data-xi="${i}" data-xk="explanation">${esc(x.explanation)}</textarea></td></tr>`).join('');
  $('#kextras').innerHTML = h ? `<tr><th>Item</th><th class="num">Value</th><th>Explanation</th></tr>${h}` : '<tr><td class="muted" style="padding:16px">Nothing extra this week.</td></tr>';
  $$('#kextras [data-xi]').forEach(x => x.oninput = () => { E.extras[Number(x.dataset.xi)][x.dataset.xk] = x.value; E.dirty = true; });
}
async function kpiSave(submit, el, ownerId, week, color) {
  const E = KPI.edit, msg = $('#kbarmsg'); clearTimeout(E.t); kpiLive();
  const values = {}, reasons = {}, notes = {}, problems = [];
  for (const m of E.mets) {
    if (m.input === 'calc') continue;
    const hasAuto = m.auto_value != null;
    if (hasAuto && !E.override[m.id]) { if (m.origin === 'override') values[m.id] = null; continue; }
    const v = E.vals[m.id];
    if (hasAuto && v != null && !String(E.reason[m.id] || '').trim()) problems.push(`${m.id} needs a reason for replacing the auto number`);
    values[m.id] = v; if (hasAuto) reasons[m.id] = E.reason[m.id] || '';
  }
  for (const m of E.mets) {
    const c = E.cause[m.id], f = E.fix[m.id], st = E.calc[m.id].status;
    if (c !== undefined || f !== undefined) notes[m.id] = { cause: c || '', fix: f || '' };
    if (submit && (st === 'red' || st === 'yellow') && (!String(c || '').trim() || !String(f || '').trim())) problems.push(`${m.id} ${m.metric} needs a cause and a fix`);
  }
  const extras = E.extras.filter(x => String(x.item).trim());
  extras.forEach(x => { if (!String(x.explanation).trim()) problems.push(`"${x.item}" needs an explanation`); });
  if (problems.length) { msg.innerHTML = `<span class="warn">${esc(problems.slice(0, 3).join('; ') + (problems.length > 3 ? `; and ${problems.length - 3} more` : ''))}</span>`; return; }
  msg.textContent = 'Saving…';
  try {
    const r = await PUT('/kpi/page', { owner: ownerId, week, values, reasons, notes, extras, submit });
    let t = 'Saved.';
    if (submit && r.submitted) t = `Submitted.${r.blank && r.blank.length ? ` Still blank: ${r.blank.length} KPI(s).` : ''}`;
    else if (submit && r.need_notes.length) t = `Saved, not submitted: ${r.need_notes.map(n => `${n.id} ${n.metric}`).join('; ')} still need a cause and fix.`;
    E.dirty = false;
    await kpiOwner(el, ownerId, week, color);
    $('#kbarmsg').innerHTML = `<span class="ok">✓ ${esc(t)}</span>`;
  } catch (e) { msg.innerHTML = `<span class="warn">${esc(e.message)}</span>`; }
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
    <div class="card" style="margin-top:12px"><h3 style="margin-top:0">Field Ops numbers</h3>
      <p class="small muted">Auto KPIs are worked out from Field Ops: jobs, estimates, invoices, payments, the schedule, the time clock and purchase orders (no Housecall Pro).
        Weeks before the start week keep what came from the sheet or was typed. A Feed number from the sheet, or an override with a reason, still wins.
        ${s.settings.auto_from ? '' : s.settings.auto_from_effective ? `Not set, so it starts with the first week Field Ops has records for: <b>${kpiWeekLabel(s.settings.auto_from_effective)}</b>.` : 'Field Ops has no records yet.'}</p>
      <form id="kauto" class="form-grid">
        ${fieldHtml({ name: 'auto_from', label: 'Start with the week of (a date in the first week Field Ops is the record)', type: 'date' }, s.settings.auto_from)}
        ${fieldHtml({ name: 'non_job_numbers', label: 'Job #s that aren\'t a job site (shop, house…)' }, s.settings.non_job_numbers)}
        ${fieldHtml({ name: 'tardy_grace_min', label: 'Tardy grace (minutes after the first visit)', type: 'number' }, s.settings.tardy_grace_min)}
        <p class="small muted full" style="margin:0">Overtime counts hours over <b>${esc(s.settings.ot_after)}</b> a week (Settings › Overtime after). Technicians are field; office, managers and admins are office.</p>
        <div class="full"><button class="btn primary sm">Save</button></div></form></div>
    <div class="card" style="margin-top:12px"><h3 style="margin-top:0">Targets</h3><p class="small muted">Changes save as you leave each box. Percent targets in percent (6 = 6%).</p>
    <div class="table-wrap"><table class="kpi-t"><thead><tr><th>#</th><th>Page</th><th>Metric</th><th>Better</th><th class="num">Target</th><th>Filled from</th><th>Active</th></tr></thead><tbody>
    ${s.metrics.map(m => `<tr data-m="${esc(m.id)}"><td class="small muted">${esc(m.id)}</td><td class="small">${esc(m.owner)}</td><td>${esc(m.metric)} <span class="small muted">${esc(m.input)}${m.rule ? ` · ${esc(m.rule)}` : ''}</span></td>
      <td><select data-f="better">${['Higher', 'Lower', 'Info'].map(b => `<option ${b === m.better ? 'selected' : ''}>${b}</option>`).join('')}</select></td>
      <td class="num"><input data-f="target" data-unit="${esc(m.unit)}" inputmode="decimal" style="width:90px" value="${esc(kpiIn(m.target, m.unit))}">${m.unit === '%' ? ' %' : ''}</td>
      <td>${m.input === 'calc' ? `<span class="small muted">formula ${esc(m.rule || '')}</span>` : `<select data-f="rule" style="max-width:260px"><option value="">Typed by hand</option>${s.rules.map(r => `<option value="${esc(r.key)}" title="${esc(r.desc)}" ${r.key === m.rule ? 'selected' : ''}>${esc(r.desc.length > 60 ? r.desc.slice(0, 60) + '…' : r.desc)}</option>`).join('')}${m.rule && !s.rules.some(r => r.key === m.rule) ? `<option value="${esc(m.rule)}" selected>${esc(m.rule)} (not in Field Ops — typed)</option>` : ''}</select>`}</td>
      <td><input type="checkbox" data-f="active" ${m.active ? 'checked' : ''}></td></tr>`).join('')}</tbody></table></div></div>`;
  $$('[data-owner]', el).forEach(x => x.onchange = () => act(() => PUT(`/kpi/owners/${x.dataset.owner}`, { user_id: x.value }), 'Saved').catch(() => null));
  $('#kset', el).onsubmit = async e => { e.preventDefault(); const f = e.target;
    await act(() => PUT('/kpi/settings', { band: f.band.value, ot_rate: f.ot_rate.value, due_days: f.due_days.value, due_time: f.due_time.value, history_weeks: f.history_weeks.value, headlines: f.headlines.value }), 'Rules saved').catch(() => null); };
  $('#kauto', el).onsubmit = async e => { e.preventDefault(); const f = e.target;
    await act(() => PUT('/kpi/settings', { auto_from: f.auto_from.value, non_job_numbers: f.non_job_numbers.value, tardy_grace_min: f.tardy_grace_min.value }), 'Saved').catch(() => null); kpiSetup(el); };
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
    <p class="small muted">Reads the Metrics, Settings, Values, Notes, Submissions, Extras, Feed, FeedDetail and Snapshots tabs (never the Housecall Pro, Ply or time-clock data tabs).
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
