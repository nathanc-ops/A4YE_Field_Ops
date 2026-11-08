'use strict';
/* A4YE Field Ops — scheduling boards, purchasing, accounting, cost codes, Ply, branding.
   Loaded after app.js and uses its helpers ($, esc, api, table, formModal, …). */

Object.assign(STATUS_TONE, { en_route: 'warn', on_site: 'good', done: '', picking: 'info', picked: 'accent', delivered: 'good', submitted: 'info', received: 'good', open: 'warn' });
const APPT_STATUSES = ['scheduled', 'dispatched', 'en_route', 'on_site', 'done', 'cancelled'];

// ============================================================ brand theme
function hexToRgb(h) { const m = /^#?([0-9a-f]{6})$/i.exec(String(h || '').trim()); if (!m) return null; const n = parseInt(m[1], 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; }
const rgbToHex = c => '#' + c.map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
const mix = (a, b, t) => { const x = hexToRgb(a), y = hexToRgb(b); return x && y ? rgbToHex(x.map((v, i) => v + (y[i] - v) * t)) : a; };
const lum = h => { const c = hexToRgb(h); if (!c) return 0; const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
const inkFor = h => lum(h) > 0.4 ? '#111827' : '#ffffff';
function isDarkMode() { const t = localStorage.getItem('fo_theme'); return t ? t === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches; }
function applyBrand(s = S.settings) {
  const r = document.documentElement.style;
  const primary = hexToRgb(s.brand_primary) ? s.brand_primary : null;
  const accent = hexToRgb(s.brand_accent) ? s.brand_accent : '#f5b400';
  const side = hexToRgb(s.brand_sidebar) ? s.brand_sidebar : '#0b1f36';
  r.setProperty('--brand', accent); r.setProperty('--brand-ink', inkFor(accent)); r.setProperty('--sidebar', side);
  if (primary) {
    const dark = isDarkMode();
    // dark mode needs a lighter step of the brand color to stay readable on a dark surface
    const a = dark ? (lum(primary) < 0.2 ? mix(primary, '#ffffff', 0.55) : primary) : (lum(primary) > 0.35 ? mix(primary, '#000000', 0.35) : primary);
    r.setProperty('--accent', a); r.setProperty('--accent-ink', inkFor(a));
    r.setProperty('--accent-soft', dark ? mix(a, '#0f1115', 0.78) : mix(a, '#ffffff', 0.86));
  } else ['--accent', '--accent-ink', '--accent-soft'].forEach(k => r.removeProperty(k));
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyBrand());
const _applyTheme = applyTheme;
applyTheme = function () { _applyTheme(); if (S.user) applyBrand(); }; // eslint-disable-line no-func-assign

// ============================================================ shared: time helpers & appointment form
const dayISO = (d, h = 0) => { const x = new Date(d + 'T00:00:00'); x.setMinutes(Math.round(h * 60)); return x.toISOString(); };
const hoursOf = (iso, day) => (new Date(iso) - new Date(day + 'T00:00:00')) / 36e5;
const hhmm = h => { const x = new Date(2000, 0, 1, 0, Math.round(h * 60)); return x.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }); };
const snap = h => Math.round(h * 4) / 4;
function addDaysStr(d, n) { const x = new Date(d + 'T00:00:00'); x.setDate(x.getDate() + n); return localDate(x); }
function warnConflicts(r) {
  if (r && r.conflicts && r.conflicts.length)
    toast('⚠ Double-booked: ' + r.conflicts.map(c => `${c.name} on ${c.job_number} ${fmtTime(c.start)}–${fmtTime(c.end)}`).join('; '), true);
}

async function apptForm(a = {}, { onSaved } = {}) {
  await loadUsers();
  const jobs = a.id ? [[a.job_id, `${a.job_number} · ${a.customer_name} · ${a.job_title}`]] : await jobPicker();
  if (a.job_id && !jobs.some(([id]) => id === Number(a.job_id))) jobs.unshift([Number(a.job_id), a.job_number || `Job #${a.job_id}`]);
  const techBoxes = `<div style="margin-top:10px"><label class="f"><span>Techs on this visit</span></label><div class="row">${S.users.filter(u => u.active).map(u =>
    `<label class="check"><input type="checkbox" name="tech" value="${u.id}" ${(a.tech_ids || []).includes(u.id) ? 'checked' : ''}> <span class="dot" style="background:${esc(u.color)}"></span>${esc(u.name)}</label>`).join('')}</div></div>
    ${a.id ? `<div class="row" style="margin-top:12px"><a class="btn" href="#/jobs/${a.job_id}">Open job</a><button type="button" class="btn danger" id="delappt">Delete visit</button></div>` : ''}`;
  const m = formModal({
    title: a.id ? `Visit · ${a.job_number}` : 'Schedule a visit', values: { ...a, status: a.status || 'scheduled' }, wide: true, extra: techBoxes,
    fields: [
      { name: 'job_id', label: 'Job', type: 'select', options: jobs, required: true, full: true },
      { name: 'start', label: 'Start', type: 'datetime', required: true }, { name: 'end', label: 'End', type: 'datetime', required: true },
      { name: 'status', label: 'Status', type: 'select', options: APPT_STATUSES, blank: false },
      { name: 'notes', label: 'Dispatch notes', full: true },
    ],
    submit: async (d, form) => {
      d.tech_ids = $$('input[name=tech]:checked', form).map(i => Number(i.value));
      const r = a.id ? await PUT('/appointments/' + a.id, d) : await POST('/appointments', d);
      toast(a.id ? 'Visit updated' : 'Visit scheduled'); warnConflicts(r);
      onSaved ? onSaved() : route();
    },
  });
  if (a.id) $('#delappt', m.el).onclick = async () => { if (confirm('Delete this visit?')) { await act(() => DEL('/appointments/' + a.id), 'Visit deleted'); m.close(); onSaved ? onSaved() : route(); } };
  if (a.id) $('select[name=job_id]', m.el).disabled = true;
  return m;
}

// ============================================================ schedule hub
async function viewScheduleHub() {
  const { params } = hashParams();
  const view = params.get('view') || (isOffice() ? 'board' : 'week');
  const date = params.get('date') || todayStr();
  const tabs = isOffice() ? [['board', 'Tech board'], ['week', 'Week'], ['dispatch', 'Dispatch']] : [['board', 'Day'], ['week', 'Week']];
  const seg = `<div class="seg">${tabs.map(([k, l]) => `<a href="#/schedule${qs({ view: k, date })}" class="${k === view ? 'on' : ''}">${l}</a>`).join('')}</div>`;
  if (view === 'week') return viewWeek(date, seg);
  if (view === 'dispatch' && isOffice()) return viewDispatch(date, seg);
  return viewBoard(date, seg);
}
function dateNav(view, date, step) {
  return `<a class="btn" href="#/schedule${qs({ view, date: addDaysStr(date, -step) })}">←</a>
    <input type="date" id="dpick" value="${date}" style="width:auto">
    <a class="btn" href="#/schedule${qs({ view, date: todayStr() })}">Today</a>
    <a class="btn" href="#/schedule${qs({ view, date: addDaysStr(date, step) })}">→</a>`;
}
function bindDatePick(view) { const d = $('#dpick'); if (d) d.onchange = () => go('#/schedule' + qs({ view, date: d.value })); }
const legend = () => `<div class="legend">${APPT_STATUSES.filter(s => s !== 'cancelled').map(s => `<span class="st-${s}"><i></i>${label(s)}</span>`).join('')}</div>`;

// ---------------------------------------------------------------- hourly tech board
async function viewBoard(date, seg) {
  const H0 = Number(S.settings.day_start_hour) || 6, H1 = Math.max(H0 + 4, Number(S.settings.day_end_hour) || 19);
  // default zoom fits the whole working day on screen; +/- overrides and is remembered
  const fit = Math.floor((($('#view').clientWidth || 1200) - 160 - (isOffice() ? 256 : 0) - 4) / (H1 - H0));
  const hw = Math.max(48, Math.min(200, Number(localStorage.getItem('fo_hw')) || Math.max(56, fit)));
  const from = dayISO(date), to = dayISO(addDaysStr(date, 1));
  const disp = isOffice() ? await GET('/dispatch' + qs({ date })) : null;
  const appts = disp ? disp.appointments : await GET('/appointments' + qs({ from, to }));
  const techUsers = isOffice()
    ? S.users.filter(u => u.active && (u.role === 'tech' || appts.some(a => a.tech_ids.includes(u.id))))
    : S.users.filter(u => u.id === S.user.id);
  const rows = techUsers.map(u => ({ id: u.id, name: u.name, color: u.color, title: u.title, clock: disp && (disp.techs.find(t => t.id === u.id) || {}).clock, booked: disp && (disp.techs.find(t => t.id === u.id) || {}).booked_hours }));
  if (isOffice()) rows.push({ id: 0, name: 'Unassigned', color: '#94a3b8' });

  // greedy lane packing so overlapping visits for the same tech stack instead of covering each other
  const placed = new Map();
  for (const r of rows) {
    const mine = appts.filter(a => r.id ? a.tech_ids.includes(r.id) : !a.tech_ids.length).sort((a, b) => a.start.localeCompare(b.start));
    const lanes = [];
    r.items = mine.map(a => { let l = lanes.findIndex(end => end <= a.start); if (l < 0) { l = lanes.length; lanes.push(''); } lanes[l] = a.end; return { a, lane: l }; });
    r.lanes = Math.max(1, lanes.length);
  }
  const x = iso => Math.max(0, Math.min(H1 - H0, hoursOf(iso, date) - H0)) * hw;
  const block = (r, { a, lane }) => {
    const left = x(a.start), width = Math.max(28, x(a.end) - left);
    placed.set(`${r.id}:${a.id}`, a);
    return `<div class="hb-appt st-${a.status} ${a.priority === 'emergency' ? 'emergency' : ''}" data-appt="${a.id}" data-row="${r.id}" style="left:${left}px;width:${width}px;top:${5 + lane * 58}px"
      title="${esc(`${fmtTime(a.start)}–${fmtTime(a.end)} ${a.job_number} ${a.customer_name} — ${a.job_title}${a.tech_names ? ' · ' + a.tech_names : ''}`)}">
      <div class="t">${fmtTime(a.start)}–${fmtTime(a.end)} · ${esc(a.job_number)}</div>
      <div class="d"><b>${esc(a.customer_name)}</b> · ${esc(a.job_title)}</div>
      <div class="d small">${esc([a.address, a.city].filter(Boolean).join(', '))}${a.tech_ids.length > 1 ? ` · 👥 ${a.tech_ids.length}` : ''}</div>
      ${isOffice() ? '<span class="rs"></span>' : ''}</div>`;
  };
  const nowH = hoursOf(new Date().toISOString(), date);
  const nowLine = date === todayStr() && nowH > H0 && nowH < H1 ? `<div class="hb-now" style="left:${(nowH - H0) * hw}px"></div>` : '';
  const hours = [...Array(H1 - H0)].map((_, i) => `<div>${hhmm(H0 + i)}</div>`).join('');

  $('#view').innerHTML = setTop('Schedule & Dispatch', `${seg}${dateNav('board', date, 1)}
      <span class="seg"><button id="zout" title="Zoom out">−</button><button id="zin" title="Zoom in">+</button></span>
      ${isOffice() ? '<button class="btn primary" id="newjob">+ Book job</button>' : ''}`,
    `${new Date(date + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })} · ${appts.length} visit(s)${isOffice() ? ' · drag to move or reassign, drag the right edge to resize, click an empty slot to add' : ''}`) + `
    <div class="hb-layout" style="${isOffice() ? '' : 'grid-template-columns:1fr'}">
      ${isOffice() ? `<div class="card hb-queue"><h2>Needs scheduling (${disp.unscheduled.length})</h2><p class="small muted">Drag onto a tech's row.</p>
        ${disp.unscheduled.map(j => `<div class="chip ${j.priority === 'emergency' ? 'emergency' : ''}" draggable="true" data-qjob="${j.id}" data-hours="${Math.min(8, Math.max(1, j.budget_hours || 2))}">
          <b>${esc(j.number)}</b> ${j.priority !== 'normal' ? pill(j.priority) : ''}<br>${esc(j.customer_name)}<br><span class="muted">${esc(j.title)}</span></div>`).join('') || '<div class="empty">All caught up</div>'}</div>` : ''}
      <div><div class="hb-wrap"><div class="hb" style="--hours:${H1 - H0};--hw:${hw}px">
        <div class="hb-head"><div class="hb-tech" style="background:var(--surface-2)"><b>Tech</b></div><div class="hb-hours">${hours}</div></div>
        ${rows.map(r => `<div class="hb-row"><div class="hb-tech"><b><span class="dot" style="background:${esc(r.color)}"></span>${esc(r.name)}</b>
            ${r.id ? `<div class="small muted">${r.clock ? `<span class="pill good">● ${r.clock.job_number ? esc(r.clock.job_number) : label(r.clock.kind)}</span>` : 'Off clock'}${r.booked != null ? ` · ${num(r.booked, 1)}h booked` : ''}</div>` : ''}</div>
          <div class="hb-lane" data-tech="${r.id}" style="height:${r.lanes * 58 + 10}px">${r.items.map(it => block(r, it)).join('')}${nowLine}</div></div>`).join('')}
      </div></div><div class="row spread" style="margin-top:8px">${legend()}<span class="small muted">15-minute snap</span></div></div>
    </div>`;
  bindDatePick('board');
  $('#zin').onclick = () => { localStorage.setItem('fo_hw', Math.min(200, hw + 24)); route(); };
  $('#zout').onclick = () => { localStorage.setItem('fo_hw', Math.max(48, hw - 24)); route(); };
  $('#zout').ondblclick = $('#zin').ondblclick = () => { localStorage.removeItem('fo_hw'); route(); };
  if (!isOffice()) { $$('.hb-appt').forEach(el => el.onclick = () => { const a = appts.find(x => x.id === Number(el.dataset.appt)); go('#/jobs/' + a.job_id); }); return; }
  $('#newjob').onclick = () => jobForm({});
  if (date === todayStr()) S.timer = setInterval(() => { if (!document.querySelector('.hb-appt.dragging') && !document.querySelector('.modal-bg')) route(); }, 120000);

  const lanes = $$('.hb-lane');
  const laneAt = y => lanes.find(l => { const r = l.getBoundingClientRect(); return y >= r.top && y <= r.bottom; });
  const hourAt = (lane, clientX) => H0 + (clientX - lane.getBoundingClientRect().left) / hw;

  // click empty slot → new visit for that tech at that time
  lanes.forEach(l => l.addEventListener('click', e => {
    if (e.target !== l) return;
    const h = Math.floor(hourAt(l, e.clientX) * 2) / 2, tech = Number(l.dataset.tech);
    apptForm({ start: dayISO(date, h), end: dayISO(date, h + 2), tech_ids: tech ? [tech] : [] });
  }));

  // queue → board (HTML5 drag from outside the grid)
  $$('[data-qjob]').forEach(c => c.addEventListener('dragstart', e => e.dataTransfer.setData('text/plain', 'job:' + c.dataset.qjob + ':' + c.dataset.hours)));
  lanes.forEach(l => {
    l.addEventListener('dragover', e => { e.preventDefault(); l.classList.add('over'); });
    l.addEventListener('dragleave', () => l.classList.remove('over'));
    l.addEventListener('drop', async e => {
      e.preventDefault(); l.classList.remove('over');
      const [k, jobId, hrs] = e.dataTransfer.getData('text/plain').split(':'); if (k !== 'job') return;
      const h = Math.max(H0, snap(hourAt(l, e.clientX))), tech = Number(l.dataset.tech);
      const r = await act(() => POST('/appointments', { job_id: Number(jobId), start: dayISO(date, h), end: dayISO(date, h + Number(hrs)), tech_ids: tech ? [tech] : [] }), 'Visit scheduled');
      warnConflicts(r); route();
    });
  });

  // move / resize existing visits with pointer events (works with mouse, pen and touch)
  $$('.hb-appt').forEach(el => {
    el.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      const a = placed.get(`${el.dataset.row}:${el.dataset.appt}`);
      const mode = e.target.classList.contains('rs') ? 'resize' : 'move';
      const sx = e.clientX, sy = e.clientY, left0 = parseFloat(el.style.left), width0 = parseFloat(el.style.width);
      const fromRow = Number(el.dataset.row);
      let moved = false, target = el.parentElement;
      el.setPointerCapture(e.pointerId);
      const onMove = ev => {
        const dx = ev.clientX - sx, dy = ev.clientY - sy;
        if (!moved && Math.abs(dx) + Math.abs(dy) < 5) return;
        moved = true; el.classList.add('dragging');
        if (mode === 'resize') { el.style.width = Math.max(hw / 4, Math.round((width0 + dx) / (hw / 4)) * (hw / 4)) + 'px'; return; }
        el.style.left = Math.round((left0 + dx) / (hw / 4)) * (hw / 4) + 'px';
        el.style.transform = `translateY(${dy}px)`;
        const l = laneAt(ev.clientY); lanes.forEach(z => z.classList.toggle('over', z === l && l !== el.parentElement)); if (l) target = l;
      };
      const onUp = async () => {
        el.removeEventListener('pointermove', onMove); el.removeEventListener('pointerup', onUp); el.removeEventListener('pointercancel', onUp);
        lanes.forEach(z => z.classList.remove('over'));
        if (!moved) return apptForm(a);
        const durH = (new Date(a.end) - new Date(a.start)) / 36e5;
        let body;
        if (mode === 'resize') {
          const startH = hoursOf(a.start, date);
          body = { end: dayISO(date, startH + snap(parseFloat(el.style.width) / hw)) };
        } else {
          const startH = H0 + snap(parseFloat(el.style.left) / hw);
          const toRow = Number(target.dataset.tech);
          let techs = a.tech_ids.filter(id => id !== fromRow);
          if (toRow && !techs.includes(toRow)) techs.push(toRow);
          if (!toRow) techs = a.tech_ids.filter(id => id !== fromRow);
          body = { start: dayISO(date, startH), end: dayISO(date, startH + durH), tech_ids: techs };
        }
        try { const r = await PUT('/appointments/' + a.id, body); toast(`${a.job_number} updated`); warnConflicts(r); } catch (err) { toast(err.message, true); }
        route();
      };
      el.addEventListener('pointermove', onMove); el.addEventListener('pointerup', onUp); el.addEventListener('pointercancel', onUp);
    });
  });
}

// ---------------------------------------------------------------- week view
async function viewWeek(date, seg) {
  const start = new Date(date + 'T00:00:00'); start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  const monday = localDate(start);
  const days = [...Array(7)].map((_, i) => addDaysStr(monday, i));
  const appts = await GET('/appointments' + qs({ from: dayISO(monday), to: dayISO(addDaysStr(monday, 7)) }));
  const techs = isOffice() ? S.users.filter(u => u.active && (u.role === 'tech' || appts.some(a => a.tech_ids.includes(u.id)))) : S.users.filter(u => u.id === S.user.id);
  const rows = [...techs.map(t => ({ id: t.id, name: t.name, color: t.color })), ...(isOffice() ? [{ id: 0, name: 'Unassigned', color: '#94a3b8' }] : [])];
  const cellAppts = (r, d) => appts.filter(a => localDate(new Date(a.start)) === d && (r.id ? a.tech_ids.includes(r.id) : !a.tech_ids.length));
  const cap = list => { const h = list.reduce((s, a) => s + (new Date(a.end) - new Date(a.start)) / 36e5, 0); return { h, pct: Math.min(100, h / 8 * 100), cls: h > 10 ? 'over' : h >= 8 ? 'full' : '' }; };
  const totals = rows.map(r => days.reduce((s, d) => s + cap(cellAppts(r, d)).h, 0));
  $('#view').innerHTML = setTop('Schedule & Dispatch', `${seg}${dateNav('week', monday, 7)}${isOffice() ? '<button class="btn primary" id="newjob">+ Book job</button>' : ''}`,
    `Week of ${fmtDate(monday)} · ${appts.length} visit(s)${isOffice() ? ' · drag a visit to another day or tech (keeps its time)' : ''}`) + `
    <div class="wk"><div class="h">Tech</div>${days.map(d => `<div class="h ${d === todayStr() ? 'today' : ''}"><a href="#/schedule${qs({ view: 'board', date: d })}">${new Date(d + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'numeric', day: 'numeric' })}</a></div>`).join('')}
    ${rows.map((r, ri) => `<div class="tech"><span class="dot" style="background:${esc(r.color)}"></span> ${esc(r.name)}<div class="small muted">${num(totals[ri], 1)} h booked</div></div>
      ${days.map(d => { const list = cellAppts(r, d); const c = cap(list); return `<div class="cell" data-tech="${r.id}" data-day="${d}">
        ${r.id && list.length ? `<div class="cap ${c.cls}" title="${num(c.h, 1)} of 8 h"><i style="width:${c.pct}%"></i></div>` : ''}
        ${list.map(a => `<a class="chip st-${a.status}" draggable="${isOffice()}" data-appt="${a.id}" data-row="${r.id}" href="#/jobs/${a.job_id}"><b>${fmtTime(a.start)}–${fmtTime(a.end)}</b> ${esc(a.job_number)}<br>${esc(a.customer_name)}<br><span class="muted">${esc(a.job_title)}</span></a>`).join('')}</div>`; }).join('')}`).join('')}</div>
    <div style="margin-top:8px">${legend()}</div>`;
  bindDatePick('week');
  if (!isOffice()) return;
  $('#newjob').onclick = () => jobForm({});
  const byId = Object.fromEntries(appts.map(a => [a.id, a]));
  $$('.wk .chip').forEach(c => {
    c.addEventListener('dragstart', e => e.dataTransfer.setData('text/plain', `${c.dataset.appt}:${c.dataset.row}`));
    c.addEventListener('click', e => { if (e.metaKey || e.ctrlKey) return; e.preventDefault(); apptForm(byId[c.dataset.appt]); });
  });
  $$('.wk .cell').forEach(cell => {
    cell.addEventListener('dragover', e => { e.preventDefault(); cell.classList.add('over'); });
    cell.addEventListener('dragleave', () => cell.classList.remove('over'));
    cell.addEventListener('drop', async e => {
      e.preventDefault(); cell.classList.remove('over');
      const [aid, fromRow] = e.dataTransfer.getData('text/plain').split(':').map(Number);
      const a = byId[aid]; if (!a) return;
      const s = new Date(a.start), dur = new Date(a.end) - s;
      const ns = new Date(cell.dataset.day + 'T00:00:00'); ns.setHours(s.getHours(), s.getMinutes());
      const toRow = Number(cell.dataset.tech);
      let techs = a.tech_ids.filter(id => id !== fromRow); if (toRow && !techs.includes(toRow)) techs.push(toRow);
      const r = await act(() => PUT('/appointments/' + a.id, { start: ns.toISOString(), end: new Date(ns.getTime() + dur).toISOString(), tech_ids: techs }), `${a.job_number} moved`);
      warnConflicts(r); route();
    });
  });
}

// ---------------------------------------------------------------- dispatch console
async function viewDispatch(date, seg) {
  const d = await GET('/dispatch' + qs({ date }));
  const order = { en_route: 0, on_site: 1, dispatched: 2, scheduled: 3, done: 4 };
  const appts = [...d.appointments].sort((a, b) => (!a.tech_ids.length ? -1 : 0) - (!b.tech_ids.length ? -1 : 0) || order[a.status] - order[b.status] || a.start.localeCompare(b.start));
  const next = { scheduled: ['dispatched', 'Dispatch'], dispatched: ['en_route', 'En route'], en_route: ['on_site', 'On site'], on_site: ['done', 'Done'] };
  $('#view').innerHTML = setTop('Schedule & Dispatch', `${seg}${dateNav('dispatch', date, 1)}<button class="btn primary" id="newjob">+ Book job</button>`,
    `Dispatch console · refreshes every minute · ${d.unassigned.length ? `<span class="pill bad">${d.unassigned.length} visit(s) with no tech</span>` : 'every visit has a tech'}`) + `
    <div class="dc">
      <div class="card"><h2>Needs scheduling (${d.unscheduled.length})</h2>
        ${d.unscheduled.map(j => `<div class="tcard"><div class="row spread"><b>${esc(j.number)}</b>${pill(j.priority === 'normal' ? j.status : j.priority)}</div>
          <div>${esc(j.customer_name)}</div><div class="small muted">${esc(j.title)}</div><div class="small muted">${esc(j.address || '')}</div>
          <div class="row" style="margin-top:6px"><button class="btn sm primary" data-sched="${j.id}">Schedule</button><a class="btn sm" href="#/jobs/${j.id}">Open</a></div></div>`).join('') || '<div class="empty">Nothing waiting</div>'}</div>
      <div class="card"><h2>Today's visits (${appts.length})</h2>
        ${table([{ label: 'Time', get: a => `${fmtTime(a.start)}–${fmtTime(a.end)}` },
          { label: 'Job', html: a => `<a href="#/jobs/${a.job_id}"><b>${esc(a.job_number)}</b></a> ${a.priority === 'emergency' ? pill('emergency') : ''}<div>${esc(a.customer_name)}</div><div class="small muted">${esc(a.job_title)} · ${esc(a.address || '')}</div>` },
          { label: 'Techs', html: a => a.tech_names ? esc(a.tech_names) : '<span class="pill bad">Unassigned</span>' },
          { label: 'Status', html: a => pill(a.status) },
          { label: '', html: a => `<div class="status-btns">${next[a.status] ? `<button class="btn sm ${a.status === 'scheduled' ? 'primary' : ''}" data-st="${a.id}:${next[a.status][0]}">${next[a.status][1]}</button>` : ''}<button class="btn sm" data-edit="${a.id}">Edit</button></div>` }],
        appts, { empty: 'No visits today' })}</div>
      <div class="card"><h2>Techs</h2>${d.techs.map(t => `<div class="tcard"><div class="row spread"><b><span class="dot" style="background:${esc(t.color)}"></span> ${esc(t.name)}</b>${t.phone ? `<a href="tel:${esc(t.phone)}">📞</a>` : ''}</div>
          <div class="small">${t.clock ? `<span class="pill good">● On the clock</span> ${t.clock.job_number ? `on <a href="#/jobs/${t.clock.job_id}">${esc(t.clock.job_number)}</a>` : esc(label(t.clock.kind))} since ${fmtTime(t.clock.clock_in)}` : '<span class="muted">Off the clock</span>'}</div>
          <div class="cap ${t.booked_hours > 10 ? 'over' : t.booked_hours >= 8 ? 'full' : ''}" style="margin-top:6px"><i style="width:${Math.min(100, t.booked_hours / 8 * 100)}%"></i></div>
          <div class="small muted">${num(t.booked_hours, 1)} of 8 h booked · ${t.appointments} visit(s)</div></div>`).join('') || '<div class="empty">No techs set up</div>'}</div>
    </div>`;
  bindDatePick('dispatch');
  $('#newjob').onclick = () => jobForm({});
  const byId = Object.fromEntries(appts.map(a => [a.id, a]));
  $$('[data-sched]').forEach(b => b.onclick = () => apptForm({ job_id: Number(b.dataset.sched), start: dayISO(date, 8), end: dayISO(date, 10) }));
  $$('[data-edit]').forEach(b => b.onclick = () => apptForm(byId[b.dataset.edit]));
  $$('[data-st]').forEach(b => b.onclick = async () => { const [id, st] = b.dataset.st.split(':'); await act(() => PUT('/appointments/' + id, { status: st }), label(st)); route(); });
  S.timer = setInterval(() => { if (!document.querySelector('.modal-bg')) route(); }, 60000);
}

// ============================================================ tech: my day
async function viewMyDay2() {
  const t = todayStr();
  $('#view').innerHTML = setTop(`Hi, ${esc(S.user.name.split(' ')[0])}`, '', new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })) +
    `<div id="clock"></div><div class="card" style="margin-top:14px"><h2>Today's visits</h2><div id="today"></div></div>
     <div class="card" style="margin-top:14px"><h2>Coming up</h2><div id="soon"></div></div><div id="mypicks"></div>`;
  await clockCard($('#clock'));
  const [today, soon, picks] = await Promise.all([
    GET('/appointments' + qs({ from: dayISO(t), to: dayISO(addDaysStr(t, 1)) })),
    GET('/appointments' + qs({ from: dayISO(addDaysStr(t, 1)), to: dayISO(addDaysStr(t, 8)) })),
    GET('/pick-lists' + qs({ status: 'open,picking,picked' })),
  ]);
  const mapUrl = a => `https://maps.google.com/?q=${encodeURIComponent([a.address, a.city, a.state, a.zip].filter(Boolean).join(' '))}`;
  $('#today').innerHTML = today.length ? today.map(a => `<div class="tcard st-${a.status}" style="border-left:5px solid var(--st)">
      <div class="row spread"><b>${fmtTime(a.start)}–${fmtTime(a.end)} · <a href="#/jobs/${a.job_id}">${esc(a.job_number)}</a></b>${pill(a.status)}</div>
      <div>${esc(a.customer_name)} — ${esc(a.job_title)}</div>
      <div class="small muted">${a.address ? `<a target="_blank" rel="noopener" href="${mapUrl(a)}">${esc([a.address, a.city].filter(Boolean).join(', '))}</a>` : ''}${a.customer_phone ? ` · <a href="tel:${esc(a.customer_phone)}">${esc(a.customer_phone)}</a>` : ''}</div>
      ${a.notes ? `<div class="small" style="margin-top:4px">📝 ${esc(a.notes)}</div>` : ''}
      <div class="row big-actions" style="margin-top:8px">
        ${['scheduled', 'dispatched'].includes(a.status) ? `<button class="btn" data-st="${a.id}:en_route">🚚 En route</button>` : ''}
        ${['scheduled', 'dispatched', 'en_route'].includes(a.status) ? `<button class="btn go" data-st="${a.id}:on_site">📍 On site (clock in)</button>` : ''}
        ${a.status === 'on_site' ? `<button class="btn stop" data-st="${a.id}:done">✓ Done (clock out)</button>` : ''}
      </div></div>`).join('') : '<div class="empty">No visits scheduled today</div>';
  $('#soon').innerHTML = table([{ label: 'When', get: a => fmtDT(a.start) }, { label: 'Job', html: a => `<b>${esc(a.job_number)}</b> ${esc(a.job_title)}<div class="small muted">${esc(a.customer_name)} · ${esc(a.address || '')}</div>` }],
    soon, { onClick: a => go('#/jobs/' + a.job_id), empty: 'Nothing else this week' });
  if (picks.length) $('#mypicks').innerHTML = `<div class="card" style="margin-top:14px"><h2>Pick lists</h2>${table([{ label: '#', key: 'number' }, { label: 'Job', get: p => `${p.job_number} ${p.job_title}` }, { label: 'Needed', get: p => fmtDate(p.needed_by) }, { label: 'Status', html: p => pill(p.status) }], picks, { onClick: p => go('#/pick/' + p.id) })}</div>`;
  $$('[data-st]').forEach(b => b.onclick = async () => { const [id, st] = b.dataset.st.split(':'); await act(() => PUT('/appointments/' + id, { status: st }), label(st)); route(); });
}

// ============================================================ job: visits, budget, purchasing
function jobAppointmentsCard(j) {
  const el = $('#appts'); if (!el) return;
  el.innerHTML = `<div class="row spread"><h2>Visits (${j.appointments.length})</h2>${isOffice() ? '<button class="btn sm" id="addvisit">+ Add visit</button>' : ''}</div>
    ${table([{ label: 'When', get: a => `${fmtDT(a.start)} – ${fmtTime(a.end)}` }, { label: 'Techs', get: a => a.tech_names || 'Unassigned' }, { label: 'Status', html: a => pill(a.status) }],
      j.appointments, { empty: 'No visits scheduled', onClick: isOffice() ? a => apptForm(a) : null })}`;
  if (isOffice()) $('#addvisit').onclick = () => {
    const last = j.appointments[j.appointments.length - 1];
    const d = last ? addDaysStr(localDate(new Date(last.start)), 1) : todayStr();
    apptForm({ job_id: j.id, job_number: j.number, start: dayISO(d, 8), end: dayISO(d, 16), tech_ids: last ? last.tech_ids : j.tech_ids });
  };
}

function jobBudgetTab(j, T) {
  const rows = j.cost_codes || [];
  const sum = k => rows.reduce((s, r) => s + (r[k] || 0), 0);
  const bar = r => r.budget_hours ? `<div class="cap ${r.hours > r.budget_hours ? 'over' : r.hours > r.budget_hours * 0.85 ? 'full' : ''}" style="width:90px;display:inline-block;vertical-align:middle"><i style="width:${Math.min(100, r.hours / r.budget_hours * 100)}%"></i></div> ${pct(r.pct_hours_used)}` : '—';
  T.innerHTML = `<div class="card"><div class="row spread"><h2>Budget vs actual by cost code</h2><button class="btn primary" id="editbud">Edit budget</button></div>
    <p class="small muted">Labor is cost-coded when techs pick a code at clock-in (or the office edits the time entry). Materials take the code from the price book item, PO line or pick list.</p>
    ${table([{ label: 'Cost code', html: r => `<b>${esc(r.code)}</b> ${esc(r.name)}` },
      { label: 'Budget hrs', num: 1, get: r => r.budget_hours ? num(r.budget_hours) : '—' }, { label: 'Actual hrs', num: 1, get: r => num(r.hours) }, { label: 'Used', html: bar },
      { label: 'Labor $', num: 1, get: r => money0(r.labor_cost) },
      { label: 'Budget mat.', num: 1, get: r => r.budget_material ? money0(r.budget_material) : '—' }, { label: 'Actual mat.', num: 1, html: r => `${money0(r.material_cost)}${r.budget_material && r.material_cost > r.budget_material ? ' <span class="pill bad">over</span>' : ''}` },
      { label: 'Other', num: 1, get: r => money0(r.other_cost) }, { label: 'Total cost', num: 1, get: r => money0(r.total_cost) }], rows,
    { empty: 'No budget or cost-coded activity yet', foot: rows.length ? ['Total', { v: num(sum('budget_hours')), num: 1 }, { v: num(sum('hours')), num: 1 }, '', { v: money0(sum('labor_cost')), num: 1 }, { v: money0(sum('budget_material')), num: 1 }, { v: money0(sum('material_cost')), num: 1 }, { v: money0(sum('other_cost')), num: 1 }, { v: money0(sum('total_cost')), num: 1 }] : null })}</div>`;
  $('#editbud').onclick = () => {
    const cur = Object.fromEntries((j.budgets || []).map(b => [b.cost_code_id, b]));
    const m = modal(`<form><h2>Budget — ${esc(j.number)}</h2><p class="small muted">Hours and dollars per cost code. Converting an approved estimate fills this in from the price book.</p>
      <div class="table-wrap"><table class="items"><thead><tr><th>Cost code</th><th>Hours</th><th>Material $</th><th>Other $</th></tr></thead><tbody>
      ${S.costCodes.map(c => { const b = cur[c.id] || {}; return `<tr data-cc="${c.id}"><td>${esc(c.code)} ${esc(c.name)}</td>
        <td><input class="n" type="number" step="any" name="h" value="${b.budget_hours || ''}"></td><td><input class="n" type="number" step="any" name="m" value="${b.budget_material || ''}"></td><td><input class="n" type="number" step="any" name="o" value="${b.budget_other || ''}"></td></tr>`; }).join('')}
      </tbody></table></div><div class="actions"><button type="button" class="btn" data-x>Cancel</button><button class="btn primary">Save budget</button></div></form>`, { wide: true });
    $('[data-x]', m.el).onclick = m.close;
    $('form', m.el).onsubmit = async e => {
      e.preventDefault();
      const budgets = $$('tr[data-cc]', m.el).map(tr => ({ cost_code_id: Number(tr.dataset.cc), budget_hours: $('[name=h]', tr).value, budget_material: $('[name=m]', tr).value, budget_other: $('[name=o]', tr).value }));
      await act(() => PUT(`/jobs/${j.id}/budgets`, { budgets }), 'Budget saved'); m.close(); route();
    };
  };
}

function jobPurchasingTab(j, T) {
  const plyOn = S.settings.ply_enabled === '1';
  T.innerHTML = `<div class="grid g2">
    ${isOffice() ? `<div class="card"><div class="row spread"><h2>Purchase orders</h2><div class="row"><a class="btn sm primary" href="#/purchasing/po/new?job_id=${j.id}">+ PO for this job</a>${plyOn ? '<button class="btn sm" id="plyjob">Send job to Ply</button>' : ''}</div></div>
      ${table([{ label: 'PO', key: 'number' }, { label: 'Vendor', key: 'vendor_name' }, { label: 'Status', html: p => pill(p.status) }, { label: 'Total', num: 1, get: p => money(p.total) }, { label: 'Received', num: 1, get: p => money(p.received_value) }],
        j.purchase_orders || [], { onClick: p => go('#/purchasing/po/' + p.id), empty: 'No POs for this job' })}</div>` : ''}
    <div class="card"><div class="row spread"><h2>Pick lists</h2>${isOffice() ? '<button class="btn sm primary" id="newpick">+ Pick list</button>' : ''}</div>
      ${table([{ label: '#', key: 'number' }, { label: 'Needed', get: p => fmtDate(p.needed_by) }, { label: 'Status', html: p => pill(p.status) }], j.pick_lists, { onClick: p => go('#/pick/' + p.id), empty: 'No pick lists' })}</div></div>`;
  if (!isOffice()) return;
  if (plyOn) $('#plyjob').onclick = async () => { await act(() => POST('/integrations/ply/push-job/' + j.id), 'Job sent to Ply'); };
  $('#newpick').onclick = () => formModal({
    title: 'New pick list', okLabel: 'Create',
    fields: [{ name: 'from_estimate', label: 'Pull material lines from the approved estimate', type: 'checkbox', default: (j.estimates || []).some(e => e.status === 'approved') ? 1 : 0, full: true },
      { name: 'needed_by', label: 'Needed by', type: 'date' }, { name: 'assigned_to', label: 'Picker', type: 'select', options: techOptions() }, { name: 'notes', label: 'Notes', full: true }],
    submit: async d => { const r = await POST(`/jobs/${j.id}/pick-lists`, { ...d, from_estimate: !!d.from_estimate }); toast('Pick list created'); go('#/pick/' + r.id); },
  });
}

// ============================================================ purchasing
const PO_STATUS_TABS = [['draft,submitted,partial', 'Open'], ['draft', 'Draft'], ['submitted,partial', 'On order'], ['received', 'Received'], ['cancelled', 'Cancelled'], ['', 'All']];
async function viewPurchasing() {
  const { params } = hashParams();
  const tab = params.get('tab') || 'po';
  const top = setTop('Purchasing & Pick Lists', `<button class="btn" id="reorder">Reorder low stock</button><a class="btn primary" href="#/purchasing/po/new">+ Purchase order</a>`,
    S.settings.ply_enabled === '1' ? '<span class="pill good">Ply connected</span> POs and pick lists can be sent to Ply' : 'Ply not connected — set it up in Settings → Integrations');
  const tabs = `<div class="tabs">${[['po', 'Purchase orders'], ['pick', 'Pick lists'], ['vendors', 'Vendors']].map(([k, l]) => `<button class="${k === tab ? 'on' : ''}" data-t="${k}">${l}</button>`).join('')}</div>`;
  let body = '';
  if (tab === 'po') {
    const status = params.get('status') ?? 'draft,submitted,partial';
    const list = await GET('/purchase-orders' + qs({ status }));
    body = `<div class="card"><div class="tabs" style="border:0">${PO_STATUS_TABS.map(([v, l]) => `<button class="${v === status ? 'on' : ''}" data-s="${v}">${l}</button>`).join('')}</div>
      ${table([{ label: 'PO', html: p => `<b>${esc(p.number)}</b>` }, { label: 'Vendor', key: 'vendor_name' }, { label: 'Job', get: p => p.job_number || 'Shop stock' }, { label: 'Deliver', get: p => label(p.deliver_to) },
        { label: 'Ordered', get: p => fmtDate(p.order_date) }, { label: 'Expected', get: p => fmtDate(p.expected_date) }, { label: 'Status', html: p => `${pill(p.status)}${p.billed ? ' <span class="pill">Billed</span>' : ''}` },
        { label: 'Ply', html: p => p.ply_id ? `<span class="pill good">${esc(p.ply_status || 'sent')}</span>` : '' }, { label: 'Total', num: 1, get: p => money(p.total) }], list,
      { onClick: p => go('#/purchasing/po/' + p.id), empty: 'No purchase orders' })}</div>`;
  } else if (tab === 'pick') {
    const list = await GET('/pick-lists');
    body = `<div class="card"><p class="small muted">Create pick lists from a job's Purchasing tab. Completing a pick pulls the items from stock and charges them to the job at cost.</p>
      ${table([{ label: '#', html: p => `<b>${esc(p.number)}</b>` }, { label: 'Job', html: p => `<a href="#/jobs/${p.job_id}">${esc(p.job_number)}</a> ${esc(p.job_title)}` }, { label: 'Lines', num: 1, key: 'line_count' },
        { label: 'Needed by', get: p => fmtDate(p.needed_by) }, { label: 'Picker', get: p => p.assigned_name || '—' }, { label: 'Status', html: p => pill(p.status) }, { label: 'Ply', html: p => p.ply_id ? '<span class="pill good">sent</span>' : '' }],
      list, { onClick: p => go('#/pick/' + p.id), empty: 'No pick lists' })}</div>`;
  } else {
    const list = await loadVendors(true);
    body = `<div class="card"><div class="row spread"><h2>Vendors & supply houses</h2><button class="btn primary" id="newv">+ Vendor</button></div>
      ${table([{ label: 'Name', html: v => `<b>${esc(v.name)}</b>${v.active ? '' : ' <span class="pill">Inactive</span>'}` }, { label: 'Contact', key: 'contact' }, { label: 'Phone', key: 'phone' }, { label: 'Email', key: 'email' },
        { label: 'Account #', key: 'account_number' }, { label: 'Terms', get: v => `Net ${v.terms_days}` }, { label: 'Ply ID', key: 'ply_vendor_id' }, { label: 'POs', num: 1, key: 'po_count' }], list, { onClick: v => vendorForm(v), empty: 'No vendors yet' })}</div>`;
  }
  $('#view').innerHTML = top + tabs + body;
  $$('[data-t]').forEach(b => b.onclick = () => go('#/purchasing' + qs({ tab: b.dataset.t })));
  $$('[data-s]').forEach(b => b.onclick = () => go('#/purchasing' + qs({ tab, status: b.dataset.s })));
  if ($('#newv')) $('#newv').onclick = () => vendorForm({});
  $('#reorder').onclick = async () => {
    const r = await act(() => POST('/purchase-orders/reorder'));
    toast(r.created.length ? `Created ${r.created.length} draft PO(s)` : 'Nothing to reorder (or low items have no preferred vendor)', !r.created.length);
    route();
  };
}
async function vendorForm(v) {
  if (isAdmin()) await loadAccounts();
  formModal({
    title: v.id ? `Edit ${v.name}` : 'New vendor', values: v, wide: true,
    fields: [{ name: 'name', label: 'Name', required: true }, { name: 'contact', label: 'Contact / counter rep' }, { name: 'phone', label: 'Phone' }, { name: 'email', label: 'Email (POs)', type: 'email' },
      { name: 'address', label: 'Address', full: true }, { name: 'account_number', label: 'Our account #' }, { name: 'terms_days', label: 'Terms (days)', type: 'number', default: 30 },
      ...(isAdmin() ? [{ name: 'default_account_id', label: 'Default expense account', type: 'select', options: acctOptions('cogs', 'expense', 'asset') }] : []),
      { name: 'ply_vendor_id', label: 'Ply vendor ID' }, { name: 'notes', label: 'Notes', type: 'textarea', full: true }, { name: 'active', label: 'Active', type: 'checkbox', default: 1 }],
    submit: async d => { if (v.id) await PUT('/vendors/' + v.id, d); else await POST('/vendors', d); S.vendors = null; toast('Vendor saved'); route(); },
  });
}

async function viewPO(id) {
  const { params } = hashParams();
  const [vendors, pb, jobs] = await Promise.all([loadVendors(true), loadPricebook(true), jobPicker()]);
  let po = id === 'new' ? { lines: [], status: 'draft', job_id: params.get('job_id') ? Number(params.get('job_id')) : null, deliver_to: params.get('job_id') ? 'job' : 'shop', tax: 0, shipping: 0, order_date: todayStr() } : await GET('/purchase-orders/' + id);
  if (po.job_id && !jobs.some(([jid]) => jid === po.job_id)) jobs.unshift([po.job_id, `${po.job_number} · ${po.job_title || ''}`]);
  const locked = ['received', 'cancelled'].includes(po.status);
  const plyOn = S.settings.ply_enabled === '1';
  const row = (l, i) => `<tr data-i="${i}">
    <td><input class="desc" data-k="description" value="${esc(l.description)}" list="pblist" ${locked ? 'disabled' : ''}></td>
    <td><input class="n" type="number" step="any" data-k="qty" value="${esc(l.qty)}" ${locked ? 'disabled' : ''}></td>
    <td><input class="n" type="number" step="any" data-k="unit_cost" value="${esc(l.unit_cost)}" ${locked ? 'disabled' : ''}></td>
    <td><select data-k="cost_code_id" style="width:130px" ${locked ? 'disabled' : ''}><option value="">—</option>${S.costCodes.map(c => `<option value="${c.id}" ${String(c.id) === String(l.cost_code_id) ? 'selected' : ''}>${esc(c.code)} ${esc(c.name)}</option>`).join('')}</select></td>
    <td class="num">${num(l.qty_received || 0)}</td><td class="num" data-ext>${money((+l.qty || 0) * (+l.unit_cost || 0))}</td>
    <td>${locked || l.qty_received ? '' : `<button type="button" class="btn sm danger" data-rm="${i}">✕</button>`}</td></tr>`;
  $('#view').innerHTML = setTop(id === 'new' ? 'New purchase order' : `PO ${esc(po.number)}`, id === 'new' ? '' : `${pill(po.status)} ${po.ply_id ? `<span class="pill good">Ply: ${esc(po.ply_status || 'sent')}</span>` : ''}
      ${po.status === 'draft' ? '<button class="btn primary" id="submit">Mark ordered</button>' : ''}
      ${plyOn && po.status !== 'cancelled' ? `<button class="btn" id="ply">${po.ply_id ? 'Re-send to Ply' : 'Send to Ply'}</button>` : ''}
      ${['submitted', 'partial', 'draft'].includes(po.status) ? '<button class="btn" id="recv">Receive…</button>' : ''}
      ${isAdmin() && ['partial', 'received'].includes(po.status) && !po.billed ? '<button class="btn" id="bill">Enter vendor bill</button>' : ''}
      <button class="btn" onclick="print()">Print</button>`,
    po.job_id ? `For job <a href="#/jobs/${po.job_id}">${esc(po.job_number || '')}</a>` : 'Shop / truck stock') + `
    <form id="pof" class="stack"><div class="card"><div class="form-grid">
      ${fieldHtml({ name: 'vendor_id', label: 'Vendor', type: 'select', options: vendors.filter(v => v.active || v.id === po.vendor_id).map(v => [v.id, v.name]), required: true }, po.vendor_id)}
      ${fieldHtml({ name: 'job_id', label: 'Job (blank = stock)', type: 'select', options: jobs, blank: '— Shop stock —' }, po.job_id)}
      ${fieldHtml({ name: 'deliver_to', label: 'Deliver to', type: 'select', options: [['job', 'Job site'], ['shop', 'Shop (into stock)'], ['will_call', 'Will call (counter pickup)']], blank: false }, po.deliver_to)}
      ${fieldHtml({ name: 'expected_date', label: 'Needed / expected', type: 'date' }, po.expected_date)}
      ${fieldHtml({ name: 'notes', label: 'Notes to vendor', full: true }, po.notes)}
    </div></div>
    <div class="card"><h2>Lines</h2><datalist id="pblist">${pb.filter(p => p.kind === 'material' || p.kind === 'equipment').map(p => `<option value="${esc(p.name)}">${esc(p.code || '')} · on hand ${num(p.qty_on_hand)}</option>`).join('')}</datalist>
      <div class="table-wrap"><table class="items"><thead><tr><th>Item</th><th>Qty</th><th>Unit cost</th><th>Cost code</th><th class="num">Received</th><th class="num">Ext.</th><th></th></tr></thead><tbody id="lines"></tbody></table></div>
      ${locked ? '' : '<button type="button" class="btn" id="addl" style="margin-top:8px">+ Line</button>'}
      <div class="row" style="align-items:flex-start;margin-top:12px"><div class="grow form-grid" style="max-width:360px">${fieldHtml({ name: 'tax', label: 'Tax $', type: 'number' }, po.tax)}${fieldHtml({ name: 'shipping', label: 'Freight $', type: 'number' }, po.shipping)}</div><div class="totals" id="pot"></div></div></div>
    <div class="row no-print"><button class="btn primary">Save PO</button>${po.status === 'draft' && id !== 'new' ? '<button type="button" class="btn danger" id="del">Delete</button>' : ''}
      ${['submitted', 'partial'].includes(po.status) ? '<button type="button" class="btn danger" id="cancel">Cancel PO</button>' : ''}</div></form>
    ${id !== 'new' ? `<div class="grid g2" style="margin-top:14px"><div class="card"><h2>Receipts</h2>${table([{ label: 'Date', get: r => fmtDate(r.received_at) }, { label: 'Item', key: 'description' }, { label: 'Qty', num: 1, get: r => num(r.qty) }, { label: 'By', get: r => r.user_name || label(r.source) }], po.receipts || [], { empty: 'Nothing received yet' })}</div>
      <div class="card"><h2>Vendor bills</h2>${table([{ label: 'Invoice', get: b => b.vendor_invoice || '#' + b.id }, { label: 'Date', get: b => fmtDate(b.bill_date) }, { label: 'Status', html: b => pill(b.status) }, { label: 'Total', num: 1, get: b => money(b.total) }], po.bills || [], { onClick: isAdmin() ? b => go('#/accounting/bills/' + b.id) : null, empty: 'Not billed yet' })}</div></div>` : ''}`;
  const tb = $('#lines'), form = $('#pof');
  const totals = () => { const sub = po.lines.reduce((s, l) => s + (+l.qty || 0) * (+l.unit_cost || 0), 0); const t = sub + (+form.tax.value || 0) + (+form.shipping.value || 0);
    $('#pot').innerHTML = `<div><span>Subtotal</span><span>${money(sub)}</span></div><div class="grand"><span>Total</span><span>${money(t)}</span></div>`; };
  const draw = () => { tb.innerHTML = po.lines.map(row).join('') || '<tr><td colspan="7" class="empty">No lines</td></tr>'; totals(); };
  tb.addEventListener('input', e => {
    const tr = e.target.closest('tr[data-i]'); if (!tr) return; const l = po.lines[tr.dataset.i]; const k = e.target.dataset.k;
    l[k] = e.target.value;
    if (k === 'description') { const p = pb.find(x => x.name === e.target.value); if (p) { Object.assign(l, { pricebook_id: p.id, unit_cost: p.unit_cost, cost_code_id: l.cost_code_id || p.cost_code_id }); draw(); return; } }
    $('[data-ext]', tr).textContent = money((+l.qty || 0) * (+l.unit_cost || 0)); totals();
  });
  tb.addEventListener('change', e => { if (e.target.dataset.k === 'cost_code_id') po.lines[e.target.closest('tr').dataset.i].cost_code_id = e.target.value || null; });
  tb.addEventListener('click', e => { const b = e.target.closest('[data-rm]'); if (b) { po.lines.splice(+b.dataset.rm, 1); draw(); } });
  form.tax.oninput = totals; form.shipping.oninput = totals;
  form.job_id.onchange = () => { form.deliver_to.value = form.job_id.value ? 'job' : 'shop'; };
  if ($('#addl')) $('#addl').onclick = () => { po.lines.push({ description: '', qty: 1, unit_cost: 0 }); draw(); $$('#lines .desc').pop().focus(); };
  draw();
  form.onsubmit = async e => {
    e.preventDefault();
    const body = { vendor_id: Number(form.vendor_id.value), job_id: form.job_id.value || null, deliver_to: form.deliver_to.value, expected_date: form.expected_date.value || null,
      notes: form.notes.value, tax: Number(form.tax.value) || 0, shipping: Number(form.shipping.value) || 0, ...(locked ? {} : { lines: po.lines.filter(l => l.description) }) };
    if (id === 'new') { const r = await act(() => POST('/purchase-orders', body), 'PO saved'); go('#/purchasing/po/' + r.id); }
    else { await act(() => PUT('/purchase-orders/' + id, body), 'PO saved'); route(); }
  };
  if (id === 'new') return;
  const on = (sel, fn) => { const el = $(sel); if (el) el.onclick = fn; };
  on('#submit', async () => { await act(() => POST(`/purchase-orders/${id}/submit`, {}), 'Marked as ordered'); route(); });
  on('#ply', async () => { await act(() => POST(`/purchase-orders/${id}/submit`, { send_to_ply: true }), 'Sent to Ply'); route(); });
  on('#del', async () => { if (confirm('Delete this draft PO?')) { await act(() => DEL('/purchase-orders/' + id), 'Deleted'); go('#/purchasing'); } });
  on('#cancel', async () => { if (confirm('Cancel this PO?')) { await act(() => PUT('/purchase-orders/' + id, { status: 'cancelled' }), 'Cancelled'); route(); } });
  on('#bill', () => formModal({
    title: `Vendor bill for ${po.number}`, okLabel: 'Create bill', values: { bill_date: todayStr(), total: po.total },
    fields: [{ name: 'vendor_invoice', label: 'Vendor invoice #', required: true }, { name: 'bill_date', label: 'Invoice date', type: 'date', required: true },
      { name: 'total', label: 'Invoice total $ (difference from PO is booked as price variance)', type: 'number', full: true }],
    submit: async d => { const r = await POST(`/purchase-orders/${id}/bill`, d); toast('Bill created — it is now in Accounts Payable'); go('#/accounting/bills/' + r.id); },
  }));
  on('#recv', () => {
    const open = po.lines.filter(l => l.qty > l.qty_received);
    const m = modal(`<form><h2>Receive — ${esc(po.number)}</h2><p class="small muted">${po.job_id && po.deliver_to !== 'shop' ? 'Received items are added to the job\'s materials at PO cost.' : 'Received items go into stock (weighted-average cost).'}</p>
      <div class="table-wrap"><table class="items"><thead><tr><th>Item</th><th class="num">Open</th><th>Receiving now</th></tr></thead><tbody>
      ${open.map(l => `<tr><td>${esc(l.description)}</td><td class="num">${num(l.qty - l.qty_received)}</td><td><input class="pick-qty" type="number" step="any" min="0" data-line="${l.id}" value="${l.qty - l.qty_received}"></td></tr>`).join('')}
      </tbody></table></div><div class="actions"><button type="button" class="btn" data-x>Cancel</button><button class="btn primary">Receive</button></div></form>`);
    $('[data-x]', m.el).onclick = m.close;
    $('form', m.el).onsubmit = async e => { e.preventDefault(); const lines = $$('[data-line]', m.el).map(i => ({ po_line_id: Number(i.dataset.line), qty: Number(i.value) || 0 })).filter(l => l.qty > 0);
      await act(() => POST(`/purchase-orders/${id}/receive`, { lines }), 'Received'); m.close(); route(); };
  });
}

async function viewPickList(id) {
  const p = await GET('/pick-lists/' + id);
  const done = ['picked', 'delivered', 'cancelled'].includes(p.status);
  const plyOn = S.settings.ply_enabled === '1';
  $('#view').innerHTML = setTop(`Pick list ${esc(p.number)}`, `${pill(p.status)}
      ${!done ? '<button class="btn go" id="complete">Complete pick</button>' : ''}${p.status === 'picked' ? '<button class="btn primary" id="deliver">Mark delivered</button>' : ''}
      ${isOffice() && !done ? '<button class="btn" id="short">PO for shortages</button>' : ''}${isOffice() && plyOn ? '<button class="btn" id="ply">Send to Ply</button>' : ''}<button class="btn" onclick="print()">Print</button>`,
    `Job <a href="#/jobs/${p.job_id}">${esc(p.job_number)}</a> ${esc(p.job_title)}${p.needed_by ? ` · needed ${fmtDate(p.needed_by)}` : ''}${p.assigned_name ? ` · picker ${esc(p.assigned_name)}` : ''}`) + `
    <div class="card"><form id="pk">${table([{ label: 'Item', html: l => `<b>${esc(l.description)}</b><div class="small muted">${esc(l.sku || '')}</div>` }, { label: 'Code', get: l => l.cost_code || '—' },
      { label: 'Need', num: 1, get: l => `${num(l.qty)} ${l.unit || ''}` }, { label: 'On hand', num: 1, html: l => l.pricebook_id ? (l.qty_on_hand < l.qty ? `<span class="pill bad">${num(l.qty_on_hand)}</span>` : num(l.qty_on_hand)) : '—' },
      { label: 'Picked', html: l => done ? num(l.qty_picked) : `<input class="pick-qty" type="number" step="any" min="0" data-line="${l.id}" value="${l.qty_picked || ''}" placeholder="${l.qty}">` },
      ...(done ? [] : [{ label: '', html: l => `<button type="button" class="btn sm" data-all="${l.id}" data-q="${l.qty}">All</button>` }])], p.lines, { empty: 'No lines' })}
      ${!done ? '<div class="row" style="margin-top:12px"><button class="btn">Save progress</button></div>' : ''}</form>
      ${p.notes ? `<p>📝 ${esc(p.notes)}</p>` : ''}</div>`;
  const lines = () => $$('[data-line]').map(i => ({ id: Number(i.dataset.line), qty_picked: Number(i.value) || 0 }));
  $$('[data-all]').forEach(b => b.onclick = () => { $(`[data-line="${b.dataset.all}"]`).value = b.dataset.q; });
  if ($('#pk') && !done) $('#pk').onsubmit = async e => { e.preventDefault(); await act(() => PUT('/pick-lists/' + id, { lines: lines() }), 'Saved'); route(); };
  const on = (sel, fn) => { const el = $(sel); if (el) el.onclick = fn; };
  on('#complete', async () => {
    const l = lines(); if (!l.some(x => x.qty_picked > 0)) return toast('Enter picked quantities first', true);
    if (!confirm('Complete pick? Picked items leave stock and are charged to the job.')) return;
    await act(() => PUT('/pick-lists/' + id, { lines: l })); await act(() => POST(`/pick-lists/${id}/complete`), 'Pick complete'); route();
  });
  on('#deliver', async () => { await act(() => POST(`/pick-lists/${id}/delivered`), 'Delivered'); route(); });
  on('#ply', async () => { await act(() => POST(`/pick-lists/${id}/send-to-ply`), 'Sent to Ply'); route(); });
  on('#short', async () => {
    const vendors = await loadVendors();
    formModal({ title: 'PO for shortages', okLabel: 'Create PO', fields: [{ name: 'vendor_id', label: 'Vendor (blank = item preferred vendor)', type: 'select', options: vendors.map(v => [v.id, v.name]) }],
      submit: async d => { const r = await POST(`/pick-lists/${id}/po-shortages`, d); toast('Draft PO created'); go('#/purchasing/po/' + r.id); } });
  });
}
async function viewTechPickLists() {
  const list = await GET('/pick-lists');
  $('#view').innerHTML = setTop('Pick Lists') + `<div class="card">${table([{ label: '#', key: 'number' }, { label: 'Job', get: p => `${p.job_number} ${p.job_title}` }, { label: 'Needed', get: p => fmtDate(p.needed_by) }, { label: 'Status', html: p => pill(p.status) }],
    list, { onClick: p => go('#/pick/' + p.id), empty: 'No pick lists for you' })}</div>`;
}

// ============================================================ cost code report
async function costCodeReportView(R, from, to, sub) {
  const rows = await GET('/reports/cost-codes' + qs({ from, to }));
  const cols = [{ label: 'Cost code', html: r => `<b>${esc(r.code)}</b> ${esc(r.name)}`, csv: r => `${r.code} ${r.name}` }, { label: 'Jobs', num: 1, key: 'jobs' },
    { label: 'Hours', num: 1, get: r => num(r.hours), csv: r => r.hours }, { label: 'Labor', num: 1, get: r => money0(r.labor_cost), csv: r => r.labor_cost },
    { label: 'Materials', num: 1, get: r => money0(r.material_cost), csv: r => r.material_cost }, { label: 'Other', num: 1, get: r => money0(r.other_cost), csv: r => r.other_cost },
    { label: 'Total', num: 1, get: r => money0(r.total_cost), csv: r => r.total_cost }];
  const s = k => rows.reduce((a, r) => a + r[k], 0);
  R.innerHTML = `<div class="card"><h2>Cost by cost code — ${sub}</h2><p class="small muted">All jobs. Open a job's "Cost codes & budget" tab for budget vs actual.</p>
    ${table(cols, rows, { empty: 'No coded costs in range', foot: rows.length ? ['Total', '', { v: num(s('hours')), num: 1 }, { v: money0(s('labor_cost')), num: 1 }, { v: money0(s('material_cost')), num: 1 }, { v: money0(s('other_cost')), num: 1 }, { v: money0(s('total_cost')), num: 1 }] : null })}</div>`;
  return () => toCSV(cols, rows, `cost_codes_${from}_${to}.csv`);
}

// ============================================================ accounting (admin)
async function viewAccounting() {
  const { params } = hashParams();
  const tab = params.get('tab') || 'overview';
  await loadAccounts(true);
  const tabs = [['overview', 'Overview'], ['coa', 'Chart of accounts'], ['journal', 'Journal'], ['bills', 'Bills (A/P)'], ['statements', 'Financial statements'], ['payroll', 'Labor & payroll'], ['close', 'Close books']];
  $('#view').innerHTML = setTop('Accounting', `<a class="btn" href="#/accounting/bills/new">+ Bill</a><button class="btn primary" id="je">+ Journal entry</button>`,
    'Double-entry ledger. Invoices, payments, bills, expenses, stock usage and labor post automatically.') +
    `<div class="tabs">${tabs.map(([k, l]) => `<button class="${k === tab ? 'on' : ''}" data-t="${k}">${l}</button>`).join('')}</div><div id="acc"></div>`;
  $$('[data-t]').forEach(b => b.onclick = () => go('#/accounting' + qs({ tab: b.dataset.t })));
  $('#je').onclick = () => journalForm();
  const E = $('#acc');
  if (tab === 'overview') {
    const s = await GET('/accounting/summary');
    E.innerHTML = `${s.labor_out_of_sync ? `<div class="alert" style="margin-bottom:14px">⚠ ${s.labor_out_of_sync} week(s) of labor are not posted (or changed since posting). <a href="#/accounting?tab=payroll">Post labor</a> so job cost and the P&amp;L include payroll.</div>` : ''}
      <div class="grid g4">${kpi('Cash in bank', money0(s.cash), s.banks.map(b => `${esc(b.name)} ${money0(b.balance)}`).join(' · '))}${kpi('Receivables', money0(s.ar))}${kpi('Payables', money0(s.ap), `<a href="#/accounting?tab=bills">Bills due</a>`)}${kpi('Inventory', money0(s.inventory))}</div>
      <div class="grid g4" style="margin-top:14px">${kpi('Sales tax owed', money0(s.sales_tax))}${kpi('Accrued payroll', money0(s.accrued_payroll))}${kpi('Credit card', money0(s.credit_card))}${kpi('Books closed through', s.closed_through ? fmtDate(s.closed_through) : 'Open', '<a href="#/accounting?tab=close">Manage</a>')}</div>
      <div class="card" style="margin-top:14px"><h2>Year to date</h2>${stmtTable([['Income', s.ytd.total_income], ['Cost of goods sold', -s.ytd.total_cogs], ['Gross profit', s.ytd.gross_profit, 'sum'], ['Operating expenses', -s.ytd.total_expenses], ['Net income', s.ytd.net_income, 'sum']])}
      <a href="#/accounting?tab=statements">Full statements →</a></div>`;
  }
  if (tab === 'coa') {
    E.innerHTML = `<div class="card"><div class="row spread"><h2>Chart of accounts</h2><button class="btn" id="newacct">+ Account</button></div>
      ${table([{ label: '#', key: 'number' }, { label: 'Account', html: a => `<b>${esc(a.name)}</b>` }, { label: 'Type', get: a => label(a.type) }, { label: 'Detail', get: a => label(a.subtype || '') },
        { label: 'Balance', num: 1, get: a => money(a.balance) }, { label: '', html: a => `<button class="btn sm" data-ea="${a.id}">Edit</button>` }], S.accounts, { onClick: a => go('#/accounting/ledger/' + a.id) })}</div>`;
    $('#newacct').onclick = () => accountForm({});
    $$('[data-ea]').forEach(b => b.onclick = () => accountForm(S.accounts.find(a => a.id === Number(b.dataset.ea))));
  }
  if (tab === 'journal') {
    const from = params.get('from') || addDaysStr(todayStr(), -30), to = params.get('to') || todayStr(), src = params.get('src') || '';
    const list = await GET('/journal' + qs({ from, to, source_type: src }));
    E.innerHTML = `<div class="card"><form id="jf" class="row"><input type="date" name="from" value="${from}" style="width:auto"> to <input type="date" name="to" value="${to}" style="width:auto">
      <select name="src" style="width:auto"><option value="">All sources</option>${['manual', 'invoice', 'payment', 'bill', 'bill_payment', 'expense', 'job_material', 'labor', 'inventory_adjustment'].map(s => `<option ${s === src ? 'selected' : ''} value="${s}">${label(s)}</option>`).join('')}</select><button class="btn">Show</button></form>
      ${table([{ label: 'Date', get: e => fmtDate(e.date) }, { label: '#', key: 'id' }, { label: 'Memo', key: 'memo' }, { label: 'Source', html: e => pill(e.source_type) }, { label: 'By', get: e => e.created_by_name || 'System' }, { label: 'Amount', num: 1, get: e => money(e.amount) }],
        list, { onClick: e => showEntry(e.id), empty: 'No entries in range' })}</div>`;
    $('#jf').onsubmit = e => { e.preventDefault(); const f = e.target; go('#/accounting' + qs({ tab, from: f.from.value, to: f.to.value, src: f.src.value })); };
  }
  if (tab === 'bills') {
    const status = params.get('status') ?? 'open,partial';
    const [list, ap] = await Promise.all([GET('/bills' + qs({ status })), GET('/accounting/ap-aging')]);
    E.innerHTML = `<div class="grid g4">${kpi('Current', money0(ap.buckets.current))}${kpi('1–30 late', money0(ap.buckets.d1_30))}${kpi('31–60 late', money0(ap.buckets.d31_60))}${kpi('60+ late', money0(ap.buckets.d61_90 + ap.buckets.d90_plus))}</div>
      <div class="card" style="margin-top:14px"><div class="tabs" style="border:0">${[['open,partial', 'Unpaid'], ['paid', 'Paid'], ['void', 'Void'], ['', 'All']].map(([v, l]) => `<button class="${v === status ? 'on' : ''}" data-s="${v}">${l}</button>`).join('')}</div>
      ${table([{ label: 'Vendor', key: 'vendor_name' }, { label: 'Invoice #', key: 'vendor_invoice' }, { label: 'PO', key: 'po_number' }, { label: 'Date', get: b => fmtDate(b.bill_date) },
        { label: 'Due', html: b => `${fmtDate(b.due_date)}${['open', 'partial'].includes(b.status) && b.due_date < todayStr() ? ' <span class="pill bad">Late</span>' : ''}` }, { label: 'Status', html: b => pill(b.status) },
        { label: 'Total', num: 1, get: b => money(b.total) }, { label: 'Balance', num: 1, get: b => money(b.balance) }], list, { onClick: b => go('#/accounting/bills/' + b.id), empty: 'No bills' })}</div>`;
    $$('[data-s]').forEach(b => b.onclick = () => go('#/accounting' + qs({ tab, status: b.dataset.s })));
  }
  if (tab === 'statements') await statements(E, params);
  if (tab === 'payroll') {
    const weeks = await GET('/accounting/labor');
    E.innerHTML = `<div class="grid g2"><div class="card"><h2>Labor accrual by week</h2><p class="small muted">Posts each week's clocked hours at loaded cost (wage + burden): job time to Direct Labor (5000), shop/training/PTO to Indirect Labor (6000), against Accrued Payroll &amp; Burden (2100). Re-post if time was edited.</p>
      ${table([{ label: 'Week of', get: w => fmtDate(w.week) }, { label: 'Computed', num: 1, get: w => money(w.computed) }, { label: 'Posted', num: 1, get: w => money(w.posted) },
        { label: '', html: w => w.in_sync ? '<span class="pill good">✓ Posted</span>' : `<button class="btn sm primary" data-wk="${w.week}">Post</button>` }], [...weeks].reverse())}
      <button class="btn" id="postall" style="margin-top:10px">Post all out-of-sync weeks</button></div>
      <div class="card"><h2>Record payroll paid</h2><p class="small muted">When you run payroll (Gusto, ADP, your bank…), record the total cash that left the bank, including employer taxes. It clears Accrued Payroll.</p>
      <form id="pp" class="stack">${fieldHtml({ name: 'date', label: 'Date', type: 'date', required: true }, todayStr())}${fieldHtml({ name: 'amount', label: 'Total paid $', type: 'number', required: true })}
        ${fieldHtml({ name: 'account_id', label: 'Paid from', type: 'select', options: acctOptions('bank'), blank: false })}${fieldHtml({ name: 'memo', label: 'Memo' }, 'Payroll')}<button class="btn primary">Record payroll</button></form></div></div>`;
    $$('[data-wk]').forEach(b => b.onclick = async () => { await act(() => POST('/accounting/labor', { weeks: [b.dataset.wk] }), 'Labor posted'); route(); });
    $('#postall').onclick = async () => { const w = weeks.filter(x => !x.in_sync).map(x => x.week); if (!w.length) return toast('Everything is posted'); await act(() => POST('/accounting/labor', { weeks: w }), `${w.length} week(s) posted`); route(); };
    $('#pp').onsubmit = async e => { e.preventDefault(); const f = e.target; await act(() => POST('/accounting/payroll-payment', { date: f.date.value, amount: Number(f.amount.value), account_id: Number(f.account_id.value), memo: f.memo.value }), 'Payroll recorded'); route(); };
  }
  if (tab === 'close') {
    const s = await GET('/accounting/summary');
    E.innerHTML = `<div class="grid g2"><div class="card"><h2>Close the books</h2><p>Closing locks every entry dated on or before the date — invoices, payments, bills and expenses in that period can no longer be changed. Do this after you've reconciled the bank and filed sales tax for the month.</p>
      <form id="cl" class="row">${fieldHtml({ name: 'through', label: 'Closed through', type: 'date' }, s.closed_through)}<button class="btn primary">Save</button><button type="button" class="btn" id="reopen">Reopen all</button></form></div>
      <div class="card"><h2>Rebuild ledger</h2><p class="small muted">Re-posts every automatic entry in the open period from the source records. Use after importing data or upgrading from an earlier version. Manual journal entries are kept.</p><button class="btn" id="rebuild">Rebuild ledger</button></div></div>`;
    $('#cl').onsubmit = async e => { e.preventDefault(); await act(() => POST('/accounting/close', { through: e.target.through.value }), 'Saved'); S.settings.books_closed_through = e.target.through.value; route(); };
    $('#reopen').onclick = async () => { if (confirm('Reopen all periods?')) { await act(() => POST('/accounting/close', { through: '' }), 'Books reopened'); route(); } };
    $('#rebuild').onclick = async () => { if (!confirm('Rebuild all automatic entries in the open period?')) return; const r = await act(() => POST('/accounting/rebuild')); toast(`Re-posted ${r.reposted} entries`); };
  }
}
function stmtTable(rows) {
  return `<div class="table-wrap"><table class="stmt"><tbody>${rows.map(([l, v, cls, ind]) => `<tr class="${cls || ''}" style="--ind:${ind || 0}"><td>${esc(l)}</td><td class="num">${v == null ? '' : money(v)}</td></tr>`).join('')}</tbody></table></div>`;
}
async function statements(E, params) {
  const st = params.get('st') || 'is';
  const t = todayStr();
  const from = params.get('from') || t.slice(0, 5) + '01-01', to = params.get('to') || t, asOf = params.get('as_of') || t;
  const sub = `<div class="row" style="margin-bottom:12px">${[['is', 'Income statement'], ['bs', 'Balance sheet'], ['tb', 'Trial balance']].map(([k, l]) => `<a class="btn ${k === st ? 'primary' : ''}" href="#/accounting${qs({ tab: 'statements', st: k })}">${l}</a>`).join('')}
    <form id="sf" class="row" style="margin-left:auto">${st === 'is' ? `<input type="date" name="from" value="${from}" style="width:auto"> to <input type="date" name="to" value="${to}" style="width:auto">` : `As of <input type="date" name="as_of" value="${asOf}" style="width:auto">`}<button class="btn">Run</button><button type="button" class="btn" onclick="print()">Print</button></form></div>`;
  const link = a => `<a href="#/accounting/ledger/${a.id}">${esc(a.number)} ${esc(a.name)}</a>`;
  if (st === 'is') {
    const r = await GET('/accounting/income-statement' + qs({ from, to }));
    const sect = (title, list, total, totalLabel) => [`<tr class="head"><td>${title}</td><td></td></tr>`, ...list.map(a => `<tr style="--ind:1"><td>${link(a)}</td><td class="num">${money(a.balance)}</td></tr>`), `<tr class="sum"><td>${totalLabel}</td><td class="num">${money(total)}</td></tr>`].join('');
    E.innerHTML = sub + `<div class="card"><h2>Income statement · ${fmtDate(from)} – ${fmtDate(to)}</h2><div class="table-wrap"><table class="stmt"><tbody>
      ${sect('Income', r.income, r.total_income, 'Total income')}${sect('Cost of goods sold', r.cogs, r.total_cogs, 'Total COGS')}
      <tr class="sum"><td>Gross profit${r.total_income ? ` (${pct(r.gross_profit / r.total_income * 100)})` : ''}</td><td class="num">${money(r.gross_profit)}</td></tr>
      ${sect('Operating expenses', r.expenses, r.total_expenses, 'Total expenses')}
      <tr class="sum"><td>Net income</td><td class="num">${money(r.net_income)}</td></tr></tbody></table></div></div>`;
  }
  if (st === 'bs') {
    const r = await GET('/accounting/balance-sheet' + qs({ as_of: asOf }));
    const sect = (title, list) => [`<tr class="head"><td>${title}</td><td></td></tr>`, ...list.map(a => `<tr style="--ind:1"><td>${link(a)}</td><td class="num">${money(a.balance)}</td></tr>`)].join('');
    E.innerHTML = sub + `<div class="card"><h2>Balance sheet · as of ${fmtDate(asOf)} ${r.balanced ? '<span class="pill good">✓ Balanced</span>' : '<span class="pill bad">Out of balance</span>'}</h2><div class="table-wrap"><table class="stmt"><tbody>
      ${sect('Assets', r.assets)}<tr class="sum"><td>Total assets</td><td class="num">${money(r.total_assets)}</td></tr>
      ${sect('Liabilities', r.liabilities)}<tr class="sum"><td>Total liabilities</td><td class="num">${money(r.total_liabilities)}</td></tr>
      ${sect('Equity', r.equity)}<tr style="--ind:1"><td>Retained earnings (prior years)</td><td class="num">${money(r.prior_earnings)}</td></tr><tr style="--ind:1"><td>Net income (this year)</td><td class="num">${money(r.current_earnings)}</td></tr>
      <tr class="sum"><td>Total equity</td><td class="num">${money(r.total_equity)}</td></tr><tr class="sum"><td>Liabilities + equity</td><td class="num">${money(r.total_liabilities + r.total_equity)}</td></tr></tbody></table></div></div>`;
  }
  if (st === 'tb') {
    const r = await GET('/accounting/trial-balance' + qs({ as_of: asOf }));
    const cols = [{ label: 'Account', html: a => link(a), csv: a => `${a.number} ${a.name}` }, { label: 'Type', get: a => label(a.type) }, { label: 'Debit', num: 1, get: a => a.debit ? money(a.debit) : '', csv: a => a.debit }, { label: 'Credit', num: 1, get: a => a.credit ? money(a.credit) : '', csv: a => a.credit }];
    E.innerHTML = sub + `<div class="card"><div class="row spread"><h2>Trial balance · as of ${fmtDate(asOf)}</h2><button class="btn" id="tbcsv">CSV</button></div>${table(cols, r.rows, { foot: ['Total', '', { v: money(r.total_debit), num: 1 }, { v: money(r.total_credit), num: 1 }] })}</div>`;
    $('#tbcsv').onclick = () => toCSV(cols, r.rows, `trial_balance_${asOf}.csv`);
  }
  $('#sf').onsubmit = e => { e.preventDefault(); const f = e.target; go('#/accounting' + qs({ tab: 'statements', st, from: f.from && f.from.value, to: f.to && f.to.value, as_of: f.as_of && f.as_of.value })); };
}
function accountForm(a) {
  formModal({
    title: a.id ? `Edit ${a.number}` : 'New account', values: a,
    fields: [{ name: 'number', label: 'Number', required: true }, { name: 'name', label: 'Name', required: true },
      ...(a.id ? [] : [{ name: 'type', label: 'Type', type: 'select', options: ['asset', 'liability', 'equity', 'income', 'cogs', 'expense'], required: true }]),
      { name: 'subtype', label: 'Detail', type: 'select', options: [['bank', 'Bank account'], ['credit_card', 'Credit card'], ['fixed', 'Fixed asset']], blank: '—' },
      { name: 'description', label: 'Description', full: true }, { name: 'active', label: 'Active', type: 'checkbox', default: 1 }],
    submit: async d => { if (a.id) await PUT('/accounts/' + a.id, d); else await POST('/accounts', d); S.accounts = null; toast('Saved'); route(); },
  });
}
async function showEntry(id) {
  const e = await GET('/journal/' + id);
  const m = modal(`<h2>Journal entry #${e.id} · ${fmtDate(e.date)}</h2><p>${esc(e.memo || '')} ${pill(e.source_type)}</p>
    ${table([{ label: 'Account', get: l => `${l.number} ${l.account_name}` }, { label: 'Job', get: l => l.job_number || '' }, { label: 'Code', get: l => l.cost_code || '' }, { label: 'Memo', key: 'memo' },
      { label: 'Debit', num: 1, get: l => l.debit ? money(l.debit) : '' }, { label: 'Credit', num: 1, get: l => l.credit ? money(l.credit) : '' }], e.lines)}
    <div class="actions">${e.source_type === 'manual' ? '<button class="btn danger" id="delje">Delete entry</button>' : '<span class="small muted grow">Automatic entry — change the source record to change it.</span>'}<button class="btn" data-x>Close</button></div>`, { wide: true });
  $('[data-x]', m.el).onclick = m.close;
  if ($('#delje', m.el)) $('#delje', m.el).onclick = async () => { if (confirm('Delete this entry?')) { await act(() => DEL('/journal/' + id), 'Deleted'); m.close(); route(); } };
}
async function journalForm() {
  await loadAccounts();
  const jobs = await jobPicker();
  const acctSel = `<select data-k="account_id"><option value="">Account…</option>${S.accounts.map(a => `<option value="${a.id}">${esc(a.number)} ${esc(a.name)}</option>`).join('')}</select>`;
  const jobSel = `<select data-k="job_id"><option value="">—</option>${jobs.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('')}</select>`;
  const line = () => `<tr><td>${acctSel}</td><td><input class="n" type="number" step="any" data-k="debit"></td><td><input class="n" type="number" step="any" data-k="credit"></td><td><input data-k="memo"></td><td>${jobSel}</td></tr>`;
  const m = modal(`<form><h2>Journal entry</h2><div class="form-grid">${fieldHtml({ name: 'date', label: 'Date', type: 'date', required: true }, todayStr())}${fieldHtml({ name: 'memo', label: 'Memo' })}</div>
    <div class="table-wrap" style="margin-top:10px"><table class="items"><thead><tr><th>Account</th><th>Debit</th><th>Credit</th><th>Memo</th><th>Job</th></tr></thead><tbody id="jl">${line()}${line()}</tbody></table></div>
    <div class="row spread" style="margin-top:8px"><button type="button" class="btn" id="addjl">+ Line</button><span id="jbal" class="pill"></span></div>
    <div class="actions"><button type="button" class="btn" data-x>Cancel</button><button class="btn primary">Post entry</button></div></form>`, { wide: true });
  const read = () => $$('#jl tr', m.el).map(tr => Object.fromEntries($$('[data-k]', tr).map(i => [i.dataset.k, i.value]))).filter(l => l.account_id && (+l.debit || +l.credit));
  const bal = () => { const l = read(); const d = l.reduce((s, x) => s + (+x.debit || 0), 0), c = l.reduce((s, x) => s + (+x.credit || 0), 0);
    const el = $('#jbal', m.el); el.className = 'pill ' + (Math.abs(d - c) < 0.005 && d > 0 ? 'good' : 'warn'); el.textContent = `Debits ${money(d)} · Credits ${money(c)}`; };
  $('#jl', m.el).addEventListener('input', bal); bal();
  $('#addjl', m.el).onclick = () => { $('#jl', m.el).insertAdjacentHTML('beforeend', line()); };
  $('[data-x]', m.el).onclick = m.close;
  $('form', m.el).onsubmit = async e => { e.preventDefault(); const f = e.target;
    await act(() => POST('/journal', { date: f.date.value, memo: f.memo.value, lines: read() }), 'Entry posted'); m.close(); route(); };
}
async function viewLedger(id) {
  const { params } = hashParams();
  const t = todayStr();
  const from = params.get('from') || t.slice(0, 5) + '01-01', to = params.get('to') || t;
  const r = await GET(`/accounting/ledger/${id}` + qs({ from, to }));
  const cols = [{ label: 'Date', get: l => fmtDate(l.date) }, { label: 'Entry', html: l => `<a href="#" data-je="${l.entry_id}">#${l.entry_id}</a>`, csv: l => l.entry_id }, { label: 'Memo', get: l => l.memo || l.entry_memo },
    { label: 'Name', get: l => l.customer_name || l.vendor_name || '' }, { label: 'Job', get: l => l.job_number || '' }, { label: 'Debit', num: 1, get: l => l.debit ? money(l.debit) : '', csv: l => l.debit },
    { label: 'Credit', num: 1, get: l => l.credit ? money(l.credit) : '', csv: l => l.credit }, { label: 'Balance', num: 1, get: l => money(l.balance), csv: l => l.balance }];
  $('#view').innerHTML = setTop(`${esc(r.account.number)} · ${esc(r.account.name)}`, `<a class="btn" href="#/accounting?tab=coa">← Accounts</a><button class="btn" id="csv">CSV</button>`, `${label(r.account.type)} · account register`) + `
    <div class="card"><form id="lf" class="row"><input type="date" name="from" value="${from}" style="width:auto"> to <input type="date" name="to" value="${to}" style="width:auto"><button class="btn">Show</button></form>
    <p>Opening balance <b>${money(r.opening_balance)}</b> · Closing balance <b>${money(r.closing_balance)}</b></p>${table(cols, r.lines, { empty: 'No activity in range' })}</div>`;
  $('#lf').onsubmit = e => { e.preventDefault(); go(`#/accounting/ledger/${id}` + qs({ from: e.target.from.value, to: e.target.to.value })); };
  $('#csv').onclick = () => toCSV(cols, r.lines, `ledger_${r.account.number}_${from}_${to}.csv`);
  $$('[data-je]').forEach(a => a.onclick = e => { e.preventDefault(); showEntry(a.dataset.je); });
}
async function viewBill(id) {
  const [vendors, jobs] = await Promise.all([loadVendors(true), jobPicker(), loadAccounts(true)]);
  const b = id === 'new' ? { lines: [{}], payments: [], status: 'open', bill_date: todayStr() } : await GET('/bills/' + id);
  const locked = !!b.po_id || b.status === 'void' || (b.payments || []).length > 0;
  const acctList = S.accounts.filter(a => ['cogs', 'expense', 'asset'].includes(a.type));
  const line = (l = {}) => `<tr>
    <td><select data-k="account_id" ${locked ? 'disabled' : ''}><option value="">Account…</option>${acctList.map(a => `<option value="${a.id}" ${a.id === l.account_id ? 'selected' : ''}>${esc(a.number)} ${esc(a.name)}</option>`).join('')}</select></td>
    <td><input data-k="description" value="${esc(l.description || '')}" ${locked ? 'disabled' : ''}></td>
    <td><input class="n" type="number" step="any" data-k="amount" value="${l.amount ?? ''}" ${locked ? 'disabled' : ''}></td>
    <td><select data-k="job_id" ${locked ? 'disabled' : ''}><option value="">— Overhead —</option>${jobs.map(([v, lb]) => `<option value="${v}" ${v === l.job_id ? 'selected' : ''}>${esc(lb)}</option>`).join('')}</select></td>
    <td><select data-k="cost_code_id" style="width:120px" ${locked ? 'disabled' : ''}><option value="">—</option>${S.costCodes.map(c => `<option value="${c.id}" ${c.id === l.cost_code_id ? 'selected' : ''}>${esc(c.code)} ${esc(c.name)}</option>`).join('')}</select></td></tr>`;
  $('#view').innerHTML = setTop(id === 'new' ? 'New vendor bill' : `Bill ${esc(b.vendor_invoice || '#' + b.id)}`, id === 'new' ? '' : `${pill(b.status)}${b.po_id ? ` <a class="btn" href="#/purchasing/po/${b.po_id}">PO ${esc(b.po_number)}</a>` : ''}
      ${['open', 'partial'].includes(b.status) ? '<button class="btn primary" id="pay">Pay bill</button>' : ''}${b.status !== 'void' && !(b.payments || []).length ? '<button class="btn danger" id="void">Void</button>' : ''}`,
    'Bills post to Accounts Payable. Material lines on a job (account 5100) also show up in that job\'s costs.') + `
    <form id="bf" class="stack"><div class="card"><div class="form-grid">
      ${fieldHtml({ name: 'vendor_id', label: 'Vendor', type: 'select', options: vendors.map(v => [v.id, v.name]), required: true }, b.vendor_id)}${fieldHtml({ name: 'vendor_invoice', label: 'Vendor invoice #' }, b.vendor_invoice)}
      ${fieldHtml({ name: 'bill_date', label: 'Bill date', type: 'date', required: true }, b.bill_date)}${fieldHtml({ name: 'due_date', label: 'Due (blank = vendor terms)', type: 'date' }, b.due_date)}
      ${fieldHtml({ name: 'memo', label: 'Memo', full: true }, b.memo)}</div></div>
    <div class="card"><h2>Lines</h2>${locked && id !== 'new' ? `<p class="small muted">${b.po_id ? 'Lines come from the PO.' : 'Locked: bill is void or has payments.'}</p>` : ''}
      <div class="table-wrap"><table class="items"><thead><tr><th>Account</th><th>Description</th><th>Amount</th><th>Job</th><th>Cost code</th></tr></thead><tbody id="bl">${(b.lines.length ? b.lines : [{}]).map(line).join('')}</tbody></table></div>
      ${locked ? '' : '<button type="button" class="btn" id="addbl" style="margin-top:8px">+ Line</button>'}<div class="totals" id="btot" style="margin-top:10px"></div></div>
    ${id === 'new' || !locked ? '<div class="row"><button class="btn primary">Save bill</button></div>' : '<div class="row"><button class="btn">Save header</button></div>'}</form>
    ${id !== 'new' ? `<div class="card" style="margin-top:14px"><h2>Payments</h2>${table([{ label: 'Date', get: p => fmtDate(p.paid_at) }, { label: 'Method', get: p => label(p.method) }, { label: 'From', key: 'account_name' }, { label: 'Ref', key: 'reference' }, { label: 'Amount', num: 1, get: p => money(p.amount) },
      { label: '', html: p => `<button class="btn sm danger" data-dp="${p.id}">✕</button>` }], b.payments, { empty: 'No payments' })}</div>` : ''}`;
  const read = () => $$('#bl tr').map(tr => Object.fromEntries($$('[data-k]', tr).map(i => [i.dataset.k, i.value]))).filter(l => l.account_id && Number(l.amount));
  const tot = () => { $('#btot').innerHTML = `<div class="grand"><span>Total</span><span>${money(read().reduce((s, l) => s + Number(l.amount), 0) || b.total || 0)}</span></div>${b.paid ? `<div><span>Paid</span><span>${money(b.paid)}</span></div><div><b>Balance</b><b>${money(b.balance)}</b></div>` : ''}`; };
  $('#bl').addEventListener('input', tot); tot();
  if ($('#addbl')) $('#addbl').onclick = () => $('#bl').insertAdjacentHTML('beforeend', line());
  $('#bf').onsubmit = async e => {
    e.preventDefault(); const f = e.target;
    const body = { vendor_id: Number(f.vendor_id.value), vendor_invoice: f.vendor_invoice.value, bill_date: f.bill_date.value, due_date: f.due_date.value || undefined, memo: f.memo.value };
    if (!locked) body.lines = read();
    if (id === 'new') { const r = await act(() => POST('/bills', body), 'Bill saved'); go('#/accounting/bills/' + r.id); } else { await act(() => PUT('/bills/' + id, body), 'Saved'); route(); }
  };
  const on = (sel, fn) => { const el = $(sel); if (el) el.onclick = fn; };
  on('#pay', () => formModal({
    title: 'Pay bill', okLabel: 'Record payment', values: { amount: b.balance, paid_at: todayStr() },
    fields: [{ name: 'amount', label: 'Amount', type: 'number', required: true }, { name: 'paid_at', label: 'Date', type: 'date', required: true },
      { name: 'method', label: 'Method', type: 'select', options: ['check', 'ach', 'card', 'cash'], blank: false }, { name: 'account_id', label: 'Paid from', type: 'select', options: acctOptions('bank', 'credit_card'), blank: false },
      { name: 'reference', label: 'Check # / reference' }],
    submit: async d => { await POST(`/bills/${id}/payments`, d); toast('Payment recorded'); route(); },
  }));
  on('#void', async () => { if (confirm('Void this bill?')) { await act(() => PUT('/bills/' + id, { status: 'void' }), 'Voided'); route(); } });
  $$('[data-dp]').forEach(x => x.onclick = async () => { if (confirm('Delete this payment?')) { await act(() => DEL('/bill-payments/' + x.dataset.dp)); route(); } });
}

// ============================================================ settings additions
async function settingsExtras(el) {
  const s = S.settings;
  const cards = [];
  if (isAdmin()) cards.push(`<div class="card"><h2>Branding</h2><p class="small muted">Colors and logo used across the app and on estimates/invoices customers see.</p>
    <form id="brand"><div class="form-grid">
      ${fieldHtml({ name: 'brand_primary', label: 'Primary (buttons, links)', type: 'color' }, s.brand_primary || '#0b2a4a')}
      ${fieldHtml({ name: 'brand_accent', label: 'Accent (highlights)', type: 'color' }, s.brand_accent || '#f5b400')}
      ${fieldHtml({ name: 'brand_sidebar', label: 'Sidebar', type: 'color' }, s.brand_sidebar || '#0b1f36')}
      <label class="f"><span>Logo (PNG/JPG/SVG, under 300 KB)</span><input type="file" id="logo" accept="image/*"></label>
      ${fieldHtml({ name: 'logo_url', label: '…or logo URL', full: true }, s.logo_url && !s.logo_url.startsWith('data:') ? s.logo_url : '')}
    </div><div class="row" style="margin-top:12px">${s.logo_url ? `<img src="${esc(s.logo_url)}" alt="Logo" style="height:40px;border-radius:6px;background:#fff;padding:2px">` : ''}
      <button class="btn primary">Save branding</button><button type="button" class="btn" id="brandreset">Reset to default</button><button type="button" class="btn danger" id="logoclear">Remove logo</button></div></form></div>`);
  cards.push(`<div class="card"><div class="row spread"><h2>Cost codes</h2><button class="btn" id="newcc">+ Cost code</button></div>
    <p class="small muted">Used on time entries, materials, POs, estimates and bills for budget-vs-actual by phase. Labor codes appear at clock-in; material codes on material and PO lines.</p>
    ${table([{ label: 'Code', key: 'code' }, { label: 'Name', html: c => `${esc(c.name)}${c.active ? '' : ' <span class="pill">Inactive</span>'}` }, { label: 'Used for', get: c => ({ both: 'Labor & material', labor: 'Labor', material: 'Material', other: 'Other costs' })[c.kind] }, { label: 'Ply code', key: 'ply_code' }],
      await GET('/cost-codes?all=1'), { onClick: c => ccForm(c) })}</div>`);
  if (isAdmin()) {
    await loadAccounts();
    cards.push(`<div class="card"><h2>Scheduling & accounting defaults</h2><form id="defs"><div class="form-grid">
      ${fieldHtml({ name: 'day_start_hour', label: 'Tech board starts (hour, 0–23)', type: 'number' }, s.day_start_hour)}${fieldHtml({ name: 'day_end_hour', label: 'Tech board ends (hour)', type: 'number' }, s.day_end_hour)}
      ${fieldHtml({ name: 'default_deposit_account', label: 'Customer payments deposit to', type: 'select', options: (S.accounts || []).filter(a => a.subtype === 'bank').map(a => [a.number, `${a.number} · ${a.name}`]), blank: false }, s.default_deposit_account)}
      ${fieldHtml({ name: 'default_paid_from_account', label: 'Expenses & bills paid from', type: 'select', options: (S.accounts || []).filter(a => ['bank', 'credit_card'].includes(a.subtype)).map(a => [a.number, `${a.number} · ${a.name}`]), blank: false }, s.default_paid_from_account)}
      </div><div class="row" style="margin-top:12px"><button class="btn primary">Save defaults</button></div></form></div>`);
    const log = await GET('/integrations/ply/log');
    cards.push(`<div class="card"><h2>Integrations — Ply</h2>
      <div class="alert info" style="margin-bottom:12px">Ply doesn't publish its API reference. Get your API key, base URL and endpoint paths from your Ply rep, enter them here, then use <b>Test connection</b>. The payloads this app sends and the webhooks it accepts are documented in <code>docs/PLY_INTEGRATION.md</code>.</div>
      <form id="plyf"><div class="form-grid">
        ${fieldHtml({ name: 'ply_enabled', label: 'Enabled', type: 'checkbox', full: true }, s.ply_enabled === '1')}
        ${fieldHtml({ name: 'ply_api_base', label: 'API base URL', placeholder: 'https://api.getply.com/v1', full: true }, s.ply_api_base)}
        ${fieldHtml({ name: 'ply_api_key', label: s.ply_api_key_set ? 'API key (saved — leave blank to keep)' : 'API key', type: 'password' })}
        ${fieldHtml({ name: 'ply_webhook_secret', label: s.ply_webhook_secret_set ? 'Webhook secret (saved — blank keeps)' : 'Webhook secret', type: 'password' })}
        ${fieldHtml({ name: 'ply_path_po', label: 'PO endpoint path' }, s.ply_path_po)}${fieldHtml({ name: 'ply_path_pick_list', label: 'Pick list endpoint path' }, s.ply_path_pick_list)}
        ${fieldHtml({ name: 'ply_path_job', label: 'Job endpoint path' }, s.ply_path_job)}${fieldHtml({ name: 'ply_path_items', label: 'Items / inventory endpoint path' }, s.ply_path_items)}
      </div><p class="small">Webhook URL to give Ply: <code>${esc(location.origin)}/hooks/ply</code></p>
      <div class="row"><button class="btn primary">Save Ply settings</button><button type="button" class="btn" id="plytest">Test connection</button><button type="button" class="btn" id="plypull">Pull items & stock from Ply</button></div></form>
      <h3 style="margin-top:14px">Recent activity</h3>${table([{ label: 'When', get: l => fmtDT(l.created_at) }, { label: 'Dir', get: l => l.direction === 'in' ? '⬇ in' : '⬆ out' }, { label: 'Event', key: 'event' }, { label: 'Status', html: l => `<span class="pill ${l.status === 'ok' ? 'good' : 'bad'}">${esc(l.status)}</span>` }],
        log.slice(0, 15), { empty: 'No Ply activity yet', onClick: l => modal(`<h2>${esc(l.event)}</h2><pre style="white-space:pre-wrap;font-size:12px">${esc(l.detail)}</pre>`) })}</div>`);
  }
  el.innerHTML = `<div class="grid g2">${cards.join('')}</div>`;
  $('#newcc').onclick = () => ccForm({});
  if (!isAdmin()) return;
  const saveSettings = async (body, msg) => { S.settings = await act(() => PUT('/settings', body), msg); applyBrand(); renderShell(); route(); };
  const bf = $('#brand');
  ['brand_primary', 'brand_accent', 'brand_sidebar'].forEach(k => bf[k].addEventListener('input', () => applyBrand({ ...S.settings, brand_primary: bf.brand_primary.value, brand_accent: bf.brand_accent.value, brand_sidebar: bf.brand_sidebar.value })));
  bf.onsubmit = async e => {
    e.preventDefault();
    const body = { brand_primary: bf.brand_primary.value, brand_accent: bf.brand_accent.value, brand_sidebar: bf.brand_sidebar.value };
    const file = $('#logo').files[0];
    if (file) {
      if (file.size > 300 * 1024) return toast('Logo must be under 300 KB', true);
      body.logo_url = await new Promise(res => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(file); });
    } else if (bf.logo_url.value) body.logo_url = bf.logo_url.value;
    saveSettings(body, 'Branding saved');
  };
  $('#brandreset').onclick = () => saveSettings({ brand_primary: '#0b2a4a', brand_accent: '#f5b400', brand_sidebar: '#0b1f36' }, 'Branding reset');
  $('#logoclear').onclick = () => saveSettings({ logo_url: '' }, 'Logo removed');
  $('#defs').onsubmit = e => { e.preventDefault(); const f = e.target; saveSettings({ day_start_hour: f.day_start_hour.value, day_end_hour: f.day_end_hour.value, default_deposit_account: f.default_deposit_account.value, default_paid_from_account: f.default_paid_from_account.value }, 'Defaults saved'); };
  const pf = $('#plyf');
  pf.onsubmit = e => { e.preventDefault(); saveSettings({ ply_enabled: pf.ply_enabled.checked ? '1' : '0', ply_api_base: pf.ply_api_base.value, ply_api_key: pf.ply_api_key.value, ply_webhook_secret: pf.ply_webhook_secret.value,
    ply_path_po: pf.ply_path_po.value, ply_path_pick_list: pf.ply_path_pick_list.value, ply_path_job: pf.ply_path_job.value, ply_path_items: pf.ply_path_items.value }, 'Ply settings saved'); };
  $('#plytest').onclick = async () => { await act(() => POST('/integrations/ply/test'), 'Connected to Ply ✓'); route(); };
  $('#plypull').onclick = async () => { const r = await act(() => POST('/integrations/ply/pull-items')); toast(`Updated ${r.updated}, added ${r.created} item(s)`); route(); };
}
function ccForm(c) {
  formModal({
    title: c.id ? `Edit cost code ${c.code}` : 'New cost code', values: c,
    fields: [{ name: 'code', label: 'Code', required: true }, { name: 'name', label: 'Name', required: true },
      { name: 'kind', label: 'Used for', type: 'select', options: [['both', 'Labor & material'], ['labor', 'Labor only'], ['material', 'Material only'], ['other', 'Other costs']], blank: false, default: 'both' },
      { name: 'ply_code', label: 'Ply cost code (if different)' }, { name: 'active', label: 'Active', type: 'checkbox', default: 1 }],
    submit: async d => { if (c.id) await PUT('/cost-codes/' + c.id, d); else await POST('/cost-codes', d); await loadCostCodes(true); toast('Saved'); route(); },
  });
}

boot();
