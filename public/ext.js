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
const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
// pick whichever text color reads better on the given background
const inkFor = h => contrast(h, '#ffffff') >= contrast(h, '#111111') ? '#ffffff' : '#111111';
// nudge a color toward white/black until it reaches 4.5:1 against the surface
function readableOn(color, surface) {
  const toward = lum(surface) < 0.2 ? '#ffffff' : '#000000';
  let c = color;
  for (let t = 0.05; contrast(c, surface) < 4.5 && t <= 0.9; t += 0.05) c = mix(color, toward, t);
  return c;
}
function isDarkMode() { const t = themePref(); return t === 'system' ? matchMedia('(prefers-color-scheme: dark)').matches : t === 'dark'; }
function applyBrand(s = S.settings) {
  const r = document.documentElement.style;
  const primary = hexToRgb(s.brand_primary) ? s.brand_primary : null;
  const accent = hexToRgb(s.brand_accent) ? s.brand_accent : '#fa001c';
  const side = hexToRgb(s.brand_sidebar) ? s.brand_sidebar : '#0b1f36';
  r.setProperty('--brand', accent); r.setProperty('--brand-ink', inkFor(accent)); r.setProperty('--sidebar', side);
  // sidebar section labels in a red that reads on the sidebar
  r.setProperty('--brand-text', readableOn(accent, side));
  if (primary) {
    const dark = isDarkMode();
    const surface = dark ? '#151515' : '#ffffff';
    // links/text: brand color stepped until it passes 4.5:1 on the page surface
    const link = readableOn(primary, surface);
    // buttons keep the true brand color; text color is whichever contrasts better
    r.setProperty('--accent', link); r.setProperty('--accent-ink', inkFor(link));
    r.setProperty('--btn', primary); r.setProperty('--btn-ink', inkFor(primary));
    r.setProperty('--accent-soft', dark ? mix(primary, '#0a0a0a', 0.8) : mix(primary, '#ffffff', 0.9));
  } else ['--accent', '--accent-ink', '--accent-soft', '--btn', '--btn-ink'].forEach(k => r.removeProperty(k));
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

// Appointment confirmation email: preview the exact email, edit the address, add a line, send. Without SMTP set up on the
// server the send is recorded and the text copied, so it can be pasted into a text message or the office email.
async function confirmVisit(apptId, { cancelled = false, after } = {}) {
  const c = await GET(`/appointments/${apptId}/confirmation${cancelled ? '?cancelled=1' : ''}`);
  const title = cancelled ? 'Tell the customer it\'s cancelled' : c.changed ? 'Email the customer the new time' : c.confirmed_at ? 'Resend the confirmation' : 'Email the customer a confirmation';
  const m = formModal({ title, okLabel: c.smtp ? 'Send' : 'Record & copy text', wide: true, values: { to: c.to, subject: c.subject, body: c.text },
    fields: [{ name: 'to', label: `To${c.customer ? ` — ${c.customer}` : ''}`, full: true, required: true, placeholder: 'No email on file — type one' },
      { name: 'subject', label: 'Subject', full: true, required: true },
      { name: 'body', label: 'Message — edit anything for this one email', type: 'textarea', full: true, required: true }],
    extra: `<p class="small muted" style="margin:8px 0 0">${cancelled ? '' : 'A calendar invite is attached. '}Dispatch notes are never included.${c.smtp ? '' : ' <b>Email isn\'t set up on this server</b>, so the text is copied for you to paste.'}
      ${isAdmin() ? ' To change the wording for every email: <a href="#/settings">Settings → Email templates</a>.' : ''}</p>`,
    submit: async v => {
      const r = await POST(`/appointments/${apptId}/confirm`, { to: v.to, subject: v.subject, body: v.body, cancelled });
      if (r.status === 'sent') toast(`${cancelled ? 'Cancellation' : 'Confirmation'} sent to ${v.to}`);
      else if (r.status === 'failed') throw new Error(`Email failed: ${r.error || 'unknown error'}`);
      else { try { await navigator.clipboard.writeText(r.text); toast('Email isn\'t set up — the text is copied, paste it into a text or email'); } catch { prompt('Email isn\'t set up. Copy this text:', r.text); } }
      if (after) after(); else route();
    } });
  const ta = $('textarea[name=body]', m.el); if (ta) ta.rows = 13;
}
const confirmBadge = a => a.needs_reconfirm ? '<span class="cf-tag warn" title="Moved after the customer was emailed — they have the old time">⚠✉</span> '
  : a.confirmed_at ? '<span class="cf-tag" title="Customer emailed a confirmation">✉</span> ' : '';

// A visit is for a job, or for an estimate (a walkthrough to price the work). A new visit with nothing picked yet can be
// either; "estimate walkthrough" books the visit and starts a draft estimate for the customer in one step.
async function apptForm(a = {}, { onSaved, mode, day } = {}) {
  await loadUsers();
  const isNew = !a.id, fixedEst = !!a.estimate_id, fixedJob = !!a.job_id || (!isNew && !a.estimate_id);
  const choose = isNew && !fixedEst && !fixedJob;
  const link = a.estimate_id ? `<a class="btn" href="#/estimates/${a.estimate_id}">Open estimate</a>` : `<a class="btn" href="#/jobs/${a.job_id}">Open job</a>`;
  const techBoxes = `<div style="margin-top:10px"><label class="f"><span>Techs on this visit</span></label><div class="row">${S.users.filter(u => u.active).map(u =>
    `<label class="check"><input type="checkbox" name="tech" value="${u.id}" ${(a.tech_ids || []).includes(u.id) ? 'checked' : ''}> <span class="dot" style="background:${esc(u.color)}"></span>${esc(u.name)}</label>`).join('')}</div></div>
    ${a.id ? `<div class="cf-line ${a.needs_reconfirm ? 'warn' : ''}">${a.needs_reconfirm ? `⚠ Moved after the customer was emailed — they still have the old time.` : a.confirmed_at ? `✉ Confirmation emailed to ${esc(a.confirmed_to || 'the customer')} ${fmtDT(a.confirmed_at + 'Z')}` : 'The customer hasn\'t been emailed about this visit.'} <button type="button" class="btn sm" id="cfsend">${a.needs_reconfirm ? 'Email the new time' : a.confirmed_at ? 'Resend' : 'Email confirmation'}</button></div><div class="row" style="margin-top:12px">${link}<button type="button" class="btn danger" id="delappt">Delete visit</button></div>` : '<label class="check" style="margin-top:10px"><input type="checkbox" name="confirm_email" checked> Email the customer a confirmation (with a calendar invite)</label>'}`;
  const estLabel = a.estimate_id ? [a.estimate_number || a.job_number, a.customer_name, a.estimate_title].filter(Boolean).join(' · ') : '';
  const oneDay = !!(a.id && day && isMultiDay(a) && visitDays(a).includes(day));
  const dw = oneDay ? dayWindow(a, day) : null;
  const fields = [
    ...(oneDay ? [{ name: 'scope', label: `This visit runs ${visitDays(a).length} days (${fmtDate(visitDays(a)[0])} – ${fmtDate(visitDays(a).slice(-1)[0])}). Change…`, type: 'select', blank: false, full: true,
      options: [['day', `Only ${new Date(day + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })} (crew and hours for that day)`], ['all', 'Every day of the visit']] }] : []),
    ...(choose ? [{ name: 'visit_for', label: 'This visit is for', type: 'select', blank: false, full: true, options: [['job', 'A job'], ['estimate', 'An estimate walkthrough — starts a draft estimate']] }] : []),
    ...(fixedEst ? [{ name: 'estimate_label', label: 'Estimate', full: true, disabled: true }] : [{ name: 'job_id', label: 'Job', type: 'job', full: true, disabled: !isNew,
      text: a.job_id && a.job_number ? `${a.job_number} · ${a.customer_name || ''}${a.job_title ? ` · ${a.job_title}` : ''}` : '' }]),
    ...(choose ? [{ name: 'customer_id', label: 'Customer', type: 'customer', full: true }, { name: 'location_id', label: 'Address', type: 'select', options: [], full: true },
      { name: 'title', label: 'What do they want priced?', full: true, placeholder: 'e.g. Panel upgrade to 200A, EV charger in garage' }] : []),
    { name: 'start', label: 'Start', type: 'datetime', required: true }, { name: 'end', label: 'End', type: 'datetime', required: true },
    { name: 'status', label: 'Status', type: 'select', options: APPT_STATUSES, blank: false },
    { name: 'notes', label: 'Dispatch notes', full: true },
  ];
  const kindWord = fixedEst || mode === 'estimate' ? 'Estimate visit' : 'Visit';
  const m = formModal({
    title: a.id ? `${kindWord} · ${a.job_number}` : fixedEst ? 'Schedule an estimate visit' : mode === 'estimate' ? 'Book an estimate walkthrough' : 'Schedule a visit',
    values: { ...a, ...(dw ? { start: dw.start, end: dw.end, scope: 'day' } : {}), status: a.status || 'scheduled', visit_for: mode === 'estimate' ? 'estimate' : 'job', estimate_label: estLabel }, wide: true,
    extra: techBoxes + (oneDay ? '<div class="row" style="margin-top:8px"><button type="button" class="btn sm" id="dayoff">Take this day off the visit</button></div>' : ''),
    fields,
    submit: async (d, form) => {
      d.tech_ids = $$('input[name=tech]:checked', form).map(i => Number(i.value));
      const base = { start: d.start, end: d.end, status: d.status, notes: d.notes, tech_ids: d.tech_ids };
      let r;
      if (oneDay && d.scope === 'day') {
        r = await changeVisitDay(a, day, { start: d.start, end: d.end, tech_ids: d.tech_ids });
        toast(`${a.job_number}: ${fmtDate(day)} changed — the other days are as they were`); warnConflicts(r);
        return onSaved ? onSaved(r) : route();
      }
      if (oneDay && d.scope === 'all') { base.start = d.start === dw.start ? a.start : base.start; base.end = d.end === dw.end ? a.end : base.end; }
      const wantConfirm = !a.id && $('input[name=confirm_email]', form) && $('input[name=confirm_email]', form).checked;
      // a confirmed visit that moved: the customer has the old time
      const moved = a.id && a.confirmed_at && (new Date(d.start).toISOString() !== new Date(a.start).toISOString() || new Date(d.end).toISOString() !== new Date(a.end).toISOString());
      const next = id => { if (wantConfirm && id) return setTimeout(() => confirmVisit(id), 50);
        if (moved && !['cancelled', 'done'].includes(d.status) && confirm('The customer was emailed the old time. Email them the new one?')) return setTimeout(() => confirmVisit(a.id), 50); };
      if (a.id) r = await PUT('/appointments/' + a.id, base);
      else if (fixedEst) r = await POST('/appointments', { ...base, estimate_id: a.estimate_id });
      else if (choose && d.visit_for === 'estimate') {
        if (!d.customer_id) throw new Error('Pick the customer');
        r = await POST('/estimate-visits', { ...base, customer_id: d.customer_id, location_id: d.location_id || null, title: d.title });
        toast('Walkthrough booked — a draft estimate is waiting for its line items'); warnConflicts(r);
        onSaved ? onSaved(r) : route(); return next(r.id);
      } else {
        if (!d.job_id) throw new Error('Pick the job');
        r = await POST('/appointments', { ...base, job_id: d.job_id });
      }
      toast(a.id ? 'Visit updated' : 'Visit scheduled'); warnConflicts(r);
      onSaved ? onSaved(r) : route();
      next(a.id || r.id);
    },
  });
  const form = $('form', m.el), row = n => form[n] && form[n].closest('label');
  if (choose) {
    const custRow = () => { const lk = $('.lk[data-lk=customer]', m.el); return lk && lk.closest('label'); };
    const show = () => {
      const est = form.visit_for.value === 'estimate';
      for (const el of [custRow(), row('location_id'), row('title')]) if (el) el.style.display = est ? '' : 'none';
      if (row('job_id')) row('job_id').style.display = est ? 'none' : '';
    };
    form.visit_for.onchange = show; show();
    form.customer_id.addEventListener('change', async () => {
      const sel = form.location_id, cid = form.customer_id.value;
      if (!cid) { sel.innerHTML = '<option value="">—</option>'; return; }
      const c = await GET('/customers/' + cid);
      sel.innerHTML = '<option value="">—</option>' + c.locations.map(l => `<option value="${l.id}">${esc([l.label, l.address, l.city].filter(Boolean).join(' · '))}</option>`).join('');
      if (c.locations.length === 1) sel.value = c.locations[0].id;
    });
  }
  if (a.id) $('#delappt', m.el).onclick = async () => {
    if (!confirm('Delete this visit?')) return;
    const tell = a.confirmed_at && confirm('The customer was emailed a confirmation. Send them a cancellation notice first?');
    if (tell) { try { await POST(`/appointments/${a.id}/confirm`, { cancelled: true }); toast('Cancellation sent'); } catch (e) { toast(e.message, true); } }
    await act(() => DEL('/appointments/' + a.id), 'Visit deleted'); m.close(); onSaved ? onSaved() : route();
  };
  if (oneDay) {
    // switching to "every day" shows the whole visit's start and end; back to "only" shows this day's window
    const toLocal = iso => { const t = new Date(iso); t.setMinutes(t.getMinutes() - t.getTimezoneOffset()); return t.toISOString().slice(0, 16); };
    form.scope.onchange = () => { const all = form.scope.value === 'all'; form.start.value = toLocal(all ? a.start : dw.start); form.end.value = toLocal(all ? a.end : dw.end); };
    $('#dayoff', m.el).onclick = async () => {
      if (!confirm(`Take ${fmtDate(day)} off ${a.job_number}? The days before and after stay booked.`)) return;
      try { await changeVisitDay(a, day, { remove: true }); toast(`${fmtDate(day)} taken off ${a.job_number}`); m.close(); onSaved ? onSaved() : route(); } catch (err) { toast(err.message, true); }
    };
  }
  if ($('#cfsend', m.el)) $('#cfsend', m.el).onclick = () => { m.close(); confirmVisit(a.id, { after: onSaved }); };
  if (form.estimate_label) form.estimate_label.readOnly = true;
  // "Open job" / "Open estimate" navigate away: close the form with them
  $$('a.btn[href^="#/"]', m.el).forEach(x => x.addEventListener('click', () => m.close()));
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

// A multi-day visit (a commercial crew, say 7:00–3:30 from the 3rd to the 21st) is one crew window repeated each day.
// These give one day's window, list its days, and change a single day (the server splits that day out as its own visit).
const isMultiDay = a => localDate(new Date(a.start)) !== localDate(new Date(Date.parse(a.end) - 1));
function visitDays(a) { const out = []; for (let d = localDate(new Date(a.start)), last = localDate(new Date(Date.parse(a.end) - 1)); d <= last && out.length < 400; d = addDaysStr(d, 1)) out.push(d); return out; }
function dayWindow(a, day) {
  if (!isMultiDay(a)) return { start: a.start, end: a.end };
  const s = new Date(a.start), e = new Date(a.end);
  let ws = new Date(day + 'T00:00:00'); ws.setHours(s.getHours(), s.getMinutes(), 0, 0);
  let we = new Date(day + 'T00:00:00'); we.setHours(e.getHours(), e.getMinutes(), 0, 0);
  if (we <= ws) { ws = new Date(day + 'T00:00:00'); we = new Date(addDaysStr(day, 1) + 'T00:00:00'); }   // round-the-clock: the whole day
  if (ws < s) ws = s; if (we > e) we = e;
  return { start: ws.toISOString(), end: we.toISOString() };
}
const dayTag = (a, day) => { if (!isMultiDay(a)) return ''; const d = visitDays(a); return `<span class="day-tag" title="One day of a ${d.length}-day visit">Day ${d.indexOf(day) + 1}/${d.length}</span> `; };
async function changeVisitDay(a, day, { start, end, tech_ids, remove } = {}) {
  const w = dayWindow(a, day), days = visitDays(a), i = days.indexOf(day);
  const body = { day_from: dayISO(day), day_to: dayISO(addDaysStr(day, 1)), start: start || w.start, end: end || w.end, tech_ids, remove: !!remove,
    times_changed: (!!start && new Date(start).toISOString() !== w.start) || (!!end && new Date(end).toISOString() !== w.end) };
  if (i > 0) body.before_end = dayWindow(a, days[i - 1]).end;
  if (i >= 0 && i < days.length - 1) body.after_start = dayWindow(a, days[i + 1]).start;
  return POST(`/appointments/${a.id}/day`, body);
}

// Hours a visit takes up on one day (same rule as the server): a visit spanning several days is a daily crew window.
function visitHoursOnDay(a, day) {
  const d0 = new Date(day + 'T00:00:00').getTime(), d1 = d0 + 864e5, s = Date.parse(a.start), e = Date.parse(a.end);
  const overlap = (x, y) => Math.max(0, Math.min(y, d1, e) - Math.max(x, d0, s)) / 36e5;
  const st = new Date(s), en = new Date(e);
  if (st.toDateString() === en.toDateString()) return overlap(s, e);
  const ws = d0 + (st.getHours() * 60 + st.getMinutes()) * 6e4, we = d0 + (en.getHours() * 60 + en.getMinutes()) * 6e4;
  return we > ws ? overlap(ws, we) : overlap(d0, d1);
}
// Crew blocks: techs are grouped by the Title on their Team profile (Journeyman, Apprentice, Master/Foreman…).
const CREW = [['master', 'Masters & foremen'], ['journeyman', 'Journeymen'], ['apprentice', 'Apprentices'], ['other', 'Other staff']];
function crewOf(userId) {
  const t = String((S.users.find(u => u.id === userId) || {}).title || '');
  if (/apprent|helper|trainee|\bappr\b/i.test(t)) return 'apprentice';
  if (/journey|\bjw\b|\bjm\b|\bjman\b/i.test(t)) return 'journeyman';
  if (/master|foreman|supervisor|super\b/i.test(t)) return 'master';
  return 'other';
}
// rows → [{key, label, rows}] in crew order; empty groups dropped. Row id 0 (Unassigned) goes in its own block at the end.
function crewBlocks(rows) {
  const out = CREW.map(([key, label]) => ({ key, label, rows: rows.filter(r => r.id && crewOf(r.id) === key) })).filter(g => g.rows.length);
  const un = rows.filter(r => !r.id);
  if (un.length) out.push({ key: 'unassigned', label: 'Unassigned', rows: un });
  return out;
}

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
  const wins = new Map(appts.map(a => [a.id, dayWindow(a, date)])), win = a => wins.get(a.id);
  for (const r of rows) {
    const mine = appts.filter(a => r.id ? a.tech_ids.includes(r.id) : !a.tech_ids.length).sort((a, b) => win(a).start.localeCompare(win(b).start));
    const lanes = [];
    r.items = mine.map(a => { const w = win(a); let l = lanes.findIndex(end => end <= w.start); if (l < 0) { l = lanes.length; lanes.push(''); } lanes[l] = w.end; return { a, lane: l }; });
    r.lanes = Math.max(1, lanes.length);
  }
  const x = iso => Math.max(0, Math.min(H1 - H0, hoursOf(iso, date) - H0)) * hw;
  const block = (r, { a, lane }) => {
    const w = win(a), left = x(w.start), width = Math.max(28, x(w.end) - left);
    placed.set(`${r.id}:${a.id}`, a);
    return `<div class="hb-appt st-${a.status} ${a.priority === 'emergency' ? 'emergency' : ''} ${a.kind === 'estimate' ? 'est' : ''}" data-appt="${a.id}" data-row="${r.id}" style="left:${left}px;width:${width}px;top:${5 + lane * 58}px"
      title="${esc(`${fmtTime(w.start)}–${fmtTime(w.end)} ${a.job_number} ${a.customer_name} — ${a.job_title}${a.tech_names ? ' · ' + a.tech_names : ''}${isMultiDay(a) ? ` · ${fmtDate(localDate(new Date(a.start)))} to ${fmtDate(localDate(new Date(Date.parse(a.end) - 1)))}` : ''}`)}">
      <div class="t">${fmtTime(w.start)}–${fmtTime(w.end)} · ${dayTag(a, date)}${confirmBadge(a)}${a.kind === 'estimate' ? '<span class="est-tag">EST</span> ' : ''}${esc(a.job_number)}</div>
      <div class="d"><b>${esc(a.customer_name)}</b> · ${esc(a.job_title)}</div>
      <div class="d small">${esc([a.address, a.city].filter(Boolean).join(', '))}${a.tech_ids.length > 1 ? ` · 👥 ${a.tech_ids.length}` : ''}</div>
      ${isOffice() ? '<span class="rs"></span>' : ''}</div>`;
  };
  const nowH = hoursOf(new Date().toISOString(), date);
  const nowLine = date === todayStr() && nowH > H0 && nowH < H1 ? `<div class="hb-now" style="left:${(nowH - H0) * hw}px"></div>` : '';
  const hours = [...Array(H1 - H0)].map((_, i) => `<div>${hhmm(H0 + i)}</div>`).join('');

  $('#view').innerHTML = setTop('Schedule & Dispatch', `${seg}${dateNav('board', date, 1)}
      <span class="seg"><button id="zout" title="Zoom out">−</button><button id="zin" title="Zoom in">+</button></span>
      ${isOffice() ? '<button class="btn" id="newest">+ Estimate visit</button><button class="btn primary" id="newjob">+ Book job</button>' : ''}`,
    `${new Date(date + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })} · ${appts.length} visit(s)${isOffice() ? ' · drag to move or reassign, drag the right edge to resize, click an empty slot to add' : ''}`) + `
    <div class="hb-layout" style="${isOffice() ? '' : 'grid-template-columns:1fr'}">
      ${isOffice() ? `<div class="card hb-queue"><h2>Needs scheduling (${disp.unscheduled.length})</h2><p class="small muted">Drag onto a tech's row.</p>
        ${disp.unscheduled.map(j => `<div class="chip ${j.priority === 'emergency' ? 'emergency' : ''}" draggable="true" data-qjob="${j.id}" data-hours="${Math.min(8, Math.max(1, j.budget_hours || 2))}">
          <b>${esc(j.number)}</b> ${j.priority !== 'normal' ? pill(j.priority) : ''}<br>${esc(j.customer_name)}<br><span class="muted">${esc(j.title)}</span></div>`).join('') || '<div class="empty">All caught up</div>'}</div>` : ''}
      <div><div class="hb-wrap"><div class="hb" style="--hours:${H1 - H0};--hw:${hw}px">
        <div class="hb-head"><div class="hb-tech" style="background:var(--surface-2)"><b>Tech</b></div><div class="hb-hours">${hours}</div></div>
        ${crewBlocks(rows).map(g => `${isOffice() ? `<div class="crew-h crew-${g.key}"><span>${esc(g.label)}</span><span class="muted">${g.key === 'unassigned' ? `${g.rows[0].items.length} visit(s)` : `${g.rows.length} · ${num(g.rows.reduce((t, r) => t + (r.booked || 0), 0), 1)}h booked`}</span></div>` : ''}
        ${g.rows.map(r => `<div class="hb-row crew-${g.key}"><div class="hb-tech"><b><span class="dot" style="background:${esc(r.color)}"></span>${esc(r.name)}</b>
            ${r.id ? `<div class="small muted">${r.clock ? `<span class="pill good">● ${r.clock.job_number ? esc(r.clock.job_number) : label(r.clock.kind)}</span>` : 'Off clock'}${r.booked != null ? ` · ${num(r.booked, 1)}h booked` : ''}</div>` : ''}</div>
          <div class="hb-lane" data-tech="${r.id}" style="height:${r.lanes * 58 + 10}px">${r.items.map(it => block(r, it)).join('')}${nowLine}</div></div>`).join('')}`).join('')}
      </div></div><div class="row spread" style="margin-top:8px">${legend()}<span class="small muted">15-minute snap</span></div></div>
    </div>`;
  bindDatePick('board');
  $('#zin').onclick = () => { localStorage.setItem('fo_hw', Math.min(200, hw + 24)); route(); };
  $('#zout').onclick = () => { localStorage.setItem('fo_hw', Math.max(48, hw - 24)); route(); };
  $('#zout').ondblclick = $('#zin').ondblclick = () => { localStorage.removeItem('fo_hw'); route(); };
  if (!isOffice()) { $$('.hb-appt').forEach(el => el.onclick = () => { const a = appts.find(x => x.id === Number(el.dataset.appt)); go(a.href); }); return; }
  $('#newjob').onclick = () => jobForm({});
  if ($('#newest')) $('#newest').onclick = () => apptForm({ start: dayISO(date, 9), end: dayISO(date, 10) }, { mode: 'estimate' });
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
        if (!moved) return apptForm(a, { day: date });
        const multi = isMultiDay(a), w = dayWindow(a, date);
        const durH = (new Date(w.end) - new Date(w.start)) / 36e5;
        let body;
        if (mode === 'resize') {
          const startH = hoursOf(w.start, date);
          body = { end: dayISO(date, startH + snap(parseFloat(el.style.width) / hw)) };
          if (multi) body.start = w.start;
        } else {
          const startH = H0 + snap(parseFloat(el.style.left) / hw);
          const toRow = Number(target.dataset.tech);
          let techs = a.tech_ids.filter(id => id !== fromRow);
          if (toRow && !techs.includes(toRow)) techs.push(toRow);
          if (!toRow) techs = a.tech_ids.filter(id => id !== fromRow);
          body = { start: dayISO(date, startH), end: dayISO(date, startH + durH), tech_ids: techs };
        }
        // one day of a multi-day visit: only this day changes; the rest of the visit keeps its crew and hours
        try { const r = multi ? await changeVisitDay(a, date, { start: body.start, end: body.end, tech_ids: body.tech_ids || a.tech_ids }) : await PUT('/appointments/' + a.id, body);
          toast(multi ? `${a.job_number} changed for ${fmtDate(date)} only` : `${a.job_number} updated`); warnConflicts(r); } catch (err) { toast(err.message, true); }
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
  const [appts, projAll] = await Promise.all([GET('/appointments' + qs({ from: dayISO(monday), to: dayISO(addDaysStr(monday, 7)) })), isOffice() ? GET('/projects?lite=1') : []]);
  // commercial projects running this week: who's on each one, day by day (and which have nobody booked)
  const sunday = addDaysStr(monday, 6);
  const projs = projAll.filter(pj => (!pj.start_date || pj.start_date <= sunday) && (!pj.end_date || pj.end_date >= monday)
    && (pj.start_date || pj.end_date || appts.some(a => a.job_id === pj.id)));
  const techs = isOffice() ? S.users.filter(u => u.active && (u.role === 'tech' || appts.some(a => a.tech_ids.includes(u.id)))) : S.users.filter(u => u.id === S.user.id);
  const rows = [...techs.map(t => ({ id: t.id, name: t.name, color: t.color })), ...(isOffice() ? [{ id: 0, name: 'Unassigned', color: '#94a3b8' }] : [])];
  const onDay = (a, d) => Date.parse(a.start) < Date.parse(dayISO(addDaysStr(d, 1))) && Date.parse(a.end) > Date.parse(dayISO(d));
  const cellAppts = (r, d) => appts.filter(a => onDay(a, d) && (r.id ? a.tech_ids.includes(r.id) : !a.tech_ids.length)).sort((x, y) => dayWindow(x, d).start.localeCompare(dayWindow(y, d).start));
  const cap = (list, d) => { const h = list.reduce((s, a) => s + visitHoursOnDay(a, d), 0); return { h, pct: Math.min(100, h / 8 * 100), cls: h > 10 ? 'over' : h >= 8 ? 'full' : '' }; };
  const totals = new Map(rows.map(r => [r, days.reduce((s, d) => s + cap(cellAppts(r, d), d).h, 0)]));
  $('#view').innerHTML = setTop('Schedule & Dispatch', `${seg}${dateNav('week', monday, 7)}${isOffice() ? '<button class="btn" id="newest">+ Estimate visit</button><button class="btn primary" id="newjob">+ Book job</button>' : ''}`,
    `Week of ${fmtDate(monday)} · ${appts.length} visit(s)${isOffice() ? ' · drag a visit to another day or tech (keeps its time)' : ''}`) + `
    ${projs.length ? `<div class="card wk-proj"><div class="row spread"><h2 style="margin:0">Commercial projects this week</h2><span class="small muted">Crew on site each day — click a day to change that day's crew</span></div>
      <div class="table-wrap"><table><thead><tr><th>Project</th>${days.map(d => `<th class="${d === todayStr() ? 'today' : ''}">${new Date(d + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'numeric', day: 'numeric' })}</th>`).join('')}<th></th></tr></thead>
      <tbody>${projs.map(pj => `<tr><td><a href="#/jobs/${pj.id}?tab=project"><b>${esc(pj.number)}</b></a> ${esc(pj.title)}<div class="small muted">${esc(pj.customer_company || pj.customer_name)}${pj.end_date ? ` · until ${fmtDate(pj.end_date)}` : ''}</div></td>
        ${days.map(d => { const vs = appts.filter(a => a.job_id === pj.id && onDay(a, d)); const inRange = (!pj.start_date || d >= pj.start_date) && (!pj.end_date || d <= pj.end_date);
          const weekday = ![0, 6].includes(new Date(d + 'T12:00:00').getDay());
          return `<td class="${!vs.length && inRange && weekday ? 'nocrew' : ''}">${vs.map(a => `<a href="#" class="crewlink" data-pa="${a.id}" data-pd="${d}" title="${esc(`${fmtTime(dayWindow(a, d).start)}–${fmtTime(dayWindow(a, d).end)}`)}">${esc(a.tech_names ? a.tech_names.split(', ').map(n => n.split(' ')[0]).join(', ') : 'Unassigned')}</a>`).join('<br>') || (inRange && weekday ? '<span class="muted small">no crew</span>' : '')}</td>`; }).join('')}
        <td><button class="btn sm" data-pcrew="${pj.id}">+ Crew</button></td></tr>`).join('')}</tbody></table></div></div>` : ''}
    <div class="wk"><div class="h">Tech</div>${days.map(d => `<div class="h ${d === todayStr() ? 'today' : ''}"><a href="#/schedule${qs({ view: 'board', date: d })}">${new Date(d + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'numeric', day: 'numeric' })}</a></div>`).join('')}
    ${crewBlocks(rows).map(g => `${isOffice() ? `<div class="crew-h crew-${g.key}" style="grid-column:1/-1"><span>${esc(g.label)}</span><span class="muted">${g.key === 'unassigned' ? '' : `${g.rows.length} · ${num(g.rows.reduce((t, r) => t + totals.get(r), 0), 1)}h booked this week`}</span></div>` : ''}
    ${g.rows.map(r => `<div class="tech"><span class="dot" style="background:${esc(r.color)}"></span> ${esc(r.name)}<div class="small muted">${num(totals.get(r), 1)} h booked</div></div>
      ${days.map(d => { const list = cellAppts(r, d); const c = cap(list, d); return `<div class="cell" data-tech="${r.id}" data-day="${d}">
        ${r.id && list.length ? `<div class="cap ${c.cls}" title="${num(c.h, 1)} of 8 h"><i style="width:${c.pct}%"></i></div>` : ''}
        ${list.map(a => { const w = dayWindow(a, d); return `<a class="chip st-${a.status} ${a.kind === 'estimate' ? 'est' : ''} ${isMultiDay(a) ? 'multi' : ''}" draggable="${isOffice()}" data-appt="${a.id}" data-row="${r.id}" data-day="${d}" href="${a.href}"><b>${fmtTime(w.start)}–${fmtTime(w.end)}</b> ${dayTag(a, d)}${esc(a.job_number)}<br>${esc(a.customer_name)}<br><span class="muted">${esc(a.job_title)}</span></a>`; }).join('')}</div>`; }).join('')}`).join('')}`).join('')}</div>
    <div style="margin-top:8px">${legend()}</div>`;
  bindDatePick('week');
  if (!isOffice()) return;
  $('#newjob').onclick = () => jobForm({});
  if ($('#newest')) $('#newest').onclick = () => apptForm({ start: dayISO(date, 9), end: dayISO(date, 10) }, { mode: 'estimate' });
  const byId = Object.fromEntries(appts.map(a => [a.id, a]));
  $$('[data-pa]').forEach(l => l.onclick = e => { e.preventDefault(); apptForm(byId[l.dataset.pa], { day: l.dataset.pd }); });
  $$('[data-pcrew]').forEach(bt => bt.onclick = () => {
    const pj = projs.find(x => x.id === Number(bt.dataset.pcrew));
    const from = [monday, pj.start_date].filter(Boolean).sort().pop(), fri = addDaysStr(monday, 4), to = [fri, pj.end_date].filter(Boolean).sort()[0] < from ? from : [fri, pj.end_date].filter(Boolean).sort()[0];
    apptForm({ job_id: pj.id, job_number: pj.number, customer_name: pj.customer_company || pj.customer_name, job_title: pj.title, start: dayISO(from, 7), end: dayISO(to, 15.5), tech_ids: pj.foreman_id ? [pj.foreman_id] : [] });
  });
  $$('.wk .chip').forEach(c => {
    c.addEventListener('dragstart', e => e.dataTransfer.setData('text/plain', `${c.dataset.appt}:${c.dataset.row}:${c.dataset.day}`));
    c.addEventListener('click', e => { if (e.metaKey || e.ctrlKey) return; e.preventDefault(); apptForm(byId[c.dataset.appt], { day: c.dataset.day }); });
  });
  $$('.wk .cell').forEach(cell => {
    cell.addEventListener('dragover', e => { e.preventDefault(); cell.classList.add('over'); });
    cell.addEventListener('dragleave', () => cell.classList.remove('over'));
    cell.addEventListener('drop', async e => {
      e.preventDefault(); cell.classList.remove('over');
      const [aidS, fromRowS, fromDay] = e.dataTransfer.getData('text/plain').split(':');
      const aid = Number(aidS), fromRow = Number(fromRowS);
      const a = byId[aid]; if (!a) return;
      // one day of a multi-day visit dropped on another tech, same day: that day's crew changes, nothing else
      if (isMultiDay(a) && fromDay === cell.dataset.day) {
        const toRow = Number(cell.dataset.tech); if (toRow === fromRow) return;
        let crew = a.tech_ids.filter(id => id !== fromRow); if (toRow && !crew.includes(toRow)) crew.push(toRow);
        try { const r = await changeVisitDay(a, fromDay, { tech_ids: crew }); toast(`${a.job_number}: crew changed for ${fmtDate(fromDay)} only`); warnConflicts(r); } catch (err) { toast(err.message, true); }
        return route();
      }
      if (isMultiDay(a) && !confirm(`${a.job_number} runs ${visitDays(a).length} days. Move the whole visit so it starts ${fmtDate(cell.dataset.day)}?`)) return;
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
  $('#view').innerHTML = setTop('Schedule & Dispatch', `${seg}${dateNav('dispatch', date, 1)}<button class="btn" id="newest">+ Estimate visit</button><button class="btn primary" id="newjob">+ Book job</button>`,
    `Dispatch console · refreshes every minute · ${d.unassigned.length ? `<span class="pill bad">${d.unassigned.length} visit(s) with no tech</span>` : 'every visit has a tech'}`) + `
    <div class="dc">
      <div class="card"><h2>Needs scheduling (${d.unscheduled.length})</h2>
        ${d.unscheduled.map(j => `<div class="tcard"><div class="row spread"><b>${esc(j.number)}</b>${pill(j.priority === 'normal' ? j.status : j.priority)}</div>
          <div>${esc(j.customer_name)}</div><div class="small muted">${esc(j.title)}</div><div class="small muted">${esc(j.address || '')}</div>
          <div class="row" style="margin-top:6px"><button class="btn sm primary" data-sched="${j.id}">Schedule</button><a class="btn sm" href="#/jobs/${j.id}">Open</a></div></div>`).join('') || '<div class="empty">Nothing waiting</div>'}</div>
      <div class="card"><h2>Today's visits (${appts.length})</h2>
        ${table([{ label: 'Time', get: a => `${fmtTime(a.start)}–${fmtTime(a.end)}` },
          { label: 'Job', html: a => `<a href="${a.href}"><b>${esc(a.job_number)}</b></a> ${a.priority === 'emergency' ? pill('emergency') : ''}<div>${esc(a.customer_name)}</div><div class="small muted">${esc(a.job_title)} · ${esc(a.address || '')}</div>` },
          { label: 'Techs', html: a => a.tech_names ? esc(a.tech_names) : '<span class="pill bad">Unassigned</span>' },
          { label: 'Status', html: a => pill(a.status) },
          { label: '', html: a => `<div class="status-btns">${next[a.status] ? `<button class="btn sm ${a.status === 'scheduled' ? 'primary' : ''}" data-st="${a.id}:${next[a.status][0]}">${next[a.status][1]}</button>` : ''}<button class="btn sm" data-edit="${a.id}">Edit</button></div>` }],
        appts, { empty: 'No visits today' })}</div>
      <div class="card"><h2>Techs</h2>${crewBlocks(d.techs).map(g => `<div class="crew-h crew-${g.key}" style="margin:8px 0 4px"><span>${esc(g.label)}</span><span class="muted">${g.rows.length}</span></div>${g.rows.map(t => `<div class="tcard"><div class="row spread"><b><span class="dot" style="background:${esc(t.color)}"></span> ${esc(t.name)}</b>${t.phone ? `<a href="tel:${esc(t.phone)}">📞</a>` : ''}</div>
          <div class="small">${t.clock ? `<span class="pill good">● On the clock</span> ${t.clock.job_number ? `on <a href="#/jobs/${t.clock.job_id}">${esc(t.clock.job_number)}</a>` : esc(label(t.clock.kind))} since ${fmtTime(t.clock.clock_in)}` : '<span class="muted">Off the clock</span>'}</div>
          <div class="cap ${t.booked_hours > 10 ? 'over' : t.booked_hours >= 8 ? 'full' : ''}" style="margin-top:6px"><i style="width:${Math.min(100, t.booked_hours / 8 * 100)}%"></i></div>
          <div class="small muted">${num(t.booked_hours, 1)} of 8 h booked · ${t.appointments} visit(s)</div></div>`).join('')}`).join('') || '<div class="empty">No techs set up</div>'}</div>
    </div>`;
  bindDatePick('dispatch');
  $('#newjob').onclick = () => jobForm({});
  if ($('#newest')) $('#newest').onclick = () => apptForm({ start: dayISO(date, 9), end: dayISO(date, 10) }, { mode: 'estimate' });
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
    `<div id="pushnag"></div><div id="clock"></div><div class="card" style="margin-top:14px"><h2>Today's visits</h2><div id="today"></div></div>
     <div class="card" style="margin-top:14px"><h2>Coming up</h2><div id="soon"></div></div><div id="mypicks"></div>`;
  pushNag($('#pushnag'));
  await clockCard($('#clock'));
  const [today, soon, picks] = await Promise.all([
    GET('/appointments' + qs({ from: dayISO(t), to: dayISO(addDaysStr(t, 1)) })),
    GET('/appointments' + qs({ from: dayISO(addDaysStr(t, 1)), to: dayISO(addDaysStr(t, 8)) })),
    GET('/pick-lists' + qs({ status: 'open,picking,picked' })),
  ]);
  const mapUrl = a => `https://maps.google.com/?q=${encodeURIComponent([a.address, a.city, a.state, a.zip].filter(Boolean).join(' '))}`;
  $('#today').innerHTML = today.length ? today.map(a => `<div class="tcard st-${a.status}" style="border-left:5px solid var(--st)">
      <div class="row spread"><b>${fmtTime(a.start)}–${fmtTime(a.end)} · <a href="${a.href}">${esc(a.job_number)}</a></b>${pill(a.status)}</div>
      <div>${esc(a.customer_name)} — ${esc(a.job_title)}</div>
      <div class="small muted">${a.address ? `<a target="_blank" rel="noopener" href="${mapUrl(a)}">${esc([a.address, a.city].filter(Boolean).join(', '))}</a>` : ''}${a.customer_phone ? ` · <a href="tel:${esc(a.customer_phone)}">${esc(a.customer_phone)}</a>` : ''}</div>
      ${a.notes ? `<div class="small" style="margin-top:4px">📝 ${esc(a.notes)}</div>` : ''}
      <div class="row big-actions" style="margin-top:8px">
        ${['scheduled', 'dispatched'].includes(a.status) ? `<button class="btn" data-st="${a.id}:en_route">🚚 En route</button>` : ''}
        ${['scheduled', 'dispatched', 'en_route'].includes(a.status) ? `<button class="btn go" data-st="${a.id}:on_site">📍 On site (clock in)</button>` : ''}
        ${a.status === 'on_site' ? `<button class="btn stop" data-st="${a.id}:done">✓ Done (clock out)</button>` : ''}
      </div></div>`).join('') : '<div class="empty">No visits scheduled today</div>';
  $('#soon').innerHTML = table([{ label: 'When', get: a => fmtDT(a.start) }, { label: 'Job', html: a => `<b>${esc(a.job_number)}</b> ${esc(a.job_title)}<div class="small muted">${esc(a.customer_name)} · ${esc(a.address || '')}</div>` }],
    soon, { onClick: a => go(a.href), empty: 'Nothing else this week' });
  if (picks.length) $('#mypicks').innerHTML = `<div class="card" style="margin-top:14px"><h2>Pick lists</h2>${table([{ label: '#', key: 'number' }, { label: 'Job', get: p => `${p.job_number} ${p.job_title}` }, { label: 'Needed', get: p => fmtDate(p.needed_by) }, { label: 'Status', html: p => pill(p.status) }], picks, { onClick: p => go('#/pick/' + p.id) })}</div>`;
  $$('[data-st]').forEach(b => b.onclick = async () => { const [id, st] = b.dataset.st.split(':'); const loc = await getLoc(); await act(() => PUT('/appointments/' + id, { status: st, ...loc }), label(st)); route(); });
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
    extra: '<p class="small muted">You can add any material, from the price book or typed in, on the next screen.</p>',
    submit: async d => { const r = await POST(`/jobs/${j.id}/pick-lists`, { ...d, from_estimate: !!d.from_estimate }); toast(r.lines ? `Pick list created with ${r.lines} line(s)` : 'Pick list created: add material below'); go('#/pick/' + r.id); },
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
    body = `<div class="card"><div class="row spread"><p class="small muted" style="margin:0">Completing a pick pulls the items from stock and charges them to the job at cost.</p><button class="btn primary" id="newpl">+ Pick list</button></div>
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
  if ($('#newpl')) $('#newpl').onclick = async () => formModal({
    title: 'New pick list', okLabel: 'Create',
    fields: [{ name: 'job_id', label: 'Job', type: 'job', required: true, full: true },
      { name: 'from_estimate', label: "Start with the material on the job's approved estimate", type: 'checkbox', full: true },
      { name: 'needed_by', label: 'Needed by', type: 'date' }, { name: 'assigned_to', label: 'Picker', type: 'select', options: techOptions() }, { name: 'notes', label: 'Notes', full: true }],
    extra: '<p class="small muted">Add any material, from the price book or typed in, on the next screen.</p>',
    submit: async d => { const r = await POST(`/jobs/${d.job_id}/pick-lists`, { ...d, from_estimate: !!d.from_estimate }); toast(r.lines ? `Pick list created with ${r.lines} line(s)` : 'Pick list created: add material below'); go('#/pick/' + r.id); },
  });
  $$('[data-s]').forEach(b => b.onclick = () => go('#/purchasing' + qs({ tab, status: b.dataset.s })));
  if ($('#newv')) $('#newv').onclick = () => vendorForm({});
  if (tab === 'vendors') return go('#/vendors');
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
    extra: v.id ? '<p class="small" style="margin:8px 0 0"><a href="#" id="delv" style="color:var(--bad)">Delete vendor</a> <span class="muted">(only if nothing uses it — otherwise untick Active)</span></p>' : '',
    submit: async d => { if (v.id) await PUT('/vendors/' + v.id, d); else { const r = await POST('/vendors', d); S.vendors = null; toast('Vendor saved'); return go('#/vendors/' + r.id); } S.vendors = null; toast('Vendor saved'); route(); },
  });
  const del = $('#delv'); if (del) del.onclick = async e => { e.preventDefault(); if (!confirm(`Delete ${v.name}?`)) return;
    await act(() => DEL('/vendors/' + v.id), 'Vendor deleted'); S.vendors = null; $$('.modal-bg').forEach(m => m.remove()); go('#/vendors'); };
}

// ============================================================ vendors
async function viewVendors() {
  const { params } = hashParams();
  const show = params.get('show') || 'active', q = (params.get('q') || '').toLowerCase();
  const all = await GET('/vendors?detail=1');
  const seesMoney = all.some(v => v.owed !== undefined);
  const sort = listSort(params, '#/vendors', { by: 'name', dir: 'asc' }, ['owed', 'spend', 'last_po', 'open_po']);
  const keyOf = { name: v => v.name.toLowerCase(), terms: v => v.terms_days, open_po: v => v.open_po_count, last_po: v => v.last_po_date || '', owed: v => v.owed || 0, spend: v => v.spend_12mo || 0, items: v => v.item_count };
  let rows = all.filter(v => show === 'all' || (show === 'active' ? v.active : !v.active))
    .filter(v => !q || [v.name, v.contact, v.email, v.phone, v.account_number, v.notes].some(x => String(x || '').toLowerCase().includes(q)));
  const k = keyOf[sort.by] || keyOf.name, s = sort.dir === 'asc' ? 1 : -1;
  rows = rows.sort((a, b) => { const x = k(a), y = k(b); return (typeof x === 'number' ? x - y : String(x).localeCompare(String(y))) * s || a.name.localeCompare(b.name); });
  const keep = { show: params.get('show'), order: params.get('order'), dir: params.get('dir') };
  $('#view').innerHTML = setTop('Vendors', '<button class="btn primary" id="newv">+ Vendor</button>', 'Supply houses and subs you buy from') + `
    ${seesMoney ? `<div class="grid g4">${kpi('Active vendors', all.filter(v => v.active).length)}${kpi('We owe', money0(all.reduce((t, v) => t + (v.owed || 0), 0)), `${money0(all.reduce((t, v) => t + (v.overdue || 0), 0))} past due`)}
      ${kpi('Spent · last 12 months', money0(all.reduce((t, v) => t + (v.spend_12mo || 0), 0)), 'from entered bills')}${kpi('Open POs', all.reduce((t, v) => t + v.open_po_count, 0))}</div>` : ''}
    <div class="card" style="margin-top:14px">
      <div class="tabs">${[['active', 'Active'], ['inactive', 'Inactive'], ['all', 'All']].map(([v, l]) => `<button class="${v === show ? 'on' : ''}" data-s="${v}">${l} ${v === 'all' ? all.length : all.filter(x => v === 'active' ? x.active : !x.active).length}</button>`).join('')}</div>
      <form id="srch" class="filters"><input name="q" type="search" placeholder="Search name, contact, phone, email, account #" value="${esc(params.get('q') || '')}"><button class="btn">Search</button>${q ? `<a class="btn" href="#/vendors${qs({ show: keep.show })}">Clear</a>` : ''}</form>
      ${table([{ label: 'Vendor', sort: 'name', html: v => `<b>${esc(v.name)}</b>${v.active ? '' : ' <span class="pill">Inactive</span>'}${v.contact ? `<div class="small muted">${esc(v.contact)}</div>` : ''}` },
        { label: 'Phone', html: v => v.phone ? `<a href="tel:${esc(v.phone)}">${esc(v.phone)}</a>` : '' }, { label: 'Email', html: v => v.email ? `<a href="mailto:${esc(v.email)}">${esc(v.email)}</a>` : '' },
        { label: 'Account #', key: 'account_number' }, { label: 'Terms', sort: 'terms', get: v => `Net ${v.terms_days}` },
        { label: 'Items', num: 1, sort: 'items', key: 'item_count' }, { label: 'Open POs', num: 1, sort: 'open_po', get: v => v.open_po_count || '' }, { label: 'Last PO', sort: 'last_po', get: v => v.last_po_date ? fmtDate(v.last_po_date) : '' },
        ...(seesMoney ? [{ label: 'We owe', num: 1, sort: 'owed', html: v => v.owed ? `${money(v.owed)}${v.overdue ? ' <span class="pill bad">past due</span>' : ''}` : '' }, { label: '12 mo spend', num: 1, sort: 'spend', get: v => v.spend_12mo ? money0(v.spend_12mo) : '' }] : [])],
        rows, { onClick: v => go('#/vendors/' + v.id), empty: q ? 'No vendors match' : 'No vendors yet', sort })}</div>`;
  $('#newv').onclick = () => vendorForm({});
  $$('[data-s]').forEach(b => b.onclick = () => go('#/vendors' + qs({ ...keep, q: params.get('q'), show: b.dataset.s })));
  $('#srch').onsubmit = e => { e.preventDefault(); listFilterGo(e.target, '#/vendors', keep); };
}
async function viewVendor(id) {
  const v = await GET('/vendors/' + id);
  $('#view').innerHTML = setTop(esc(v.name), `<a class="btn" href="#/vendors">‹ Vendors</a><button class="btn" id="editv">Edit</button><a class="btn primary" href="#/purchasing/po/new?vendor_id=${v.id}">+ Purchase order</a>`,
    `${v.active ? '' : '<span class="pill">Inactive</span> '}${v.contact ? esc(v.contact) + ' · ' : ''}${v.phone ? `<a href="tel:${esc(v.phone)}">${esc(v.phone)}</a>` : ''}${v.email ? ` · <a href="mailto:${esc(v.email)}">${esc(v.email)}</a>` : ''}`) + `
    <div class="grid g4">${kpi('Terms', `Net ${v.terms_days}`, v.account_number ? `Our account # ${esc(v.account_number)}` : '')}
      ${kpi('Open POs', v.purchase_orders.filter(p => ['draft', 'submitted', 'partial'].includes(p.status)).length, `${v.purchase_orders.length} total`)}
      ${v.sees_bills ? kpi('We owe', money(v.owed)) + kpi('Spent · last 12 months', money0(v.spend_12mo), 'from entered bills') : kpi('Price book items', v.items.length)}</div>
    ${v.address || v.notes || v.ply_vendor_id ? `<div class="card" style="margin-top:14px">${v.address ? `<div>${esc(v.address)}</div>` : ''}${v.ply_vendor_id ? `<div class="small muted">Ply vendor ID ${esc(v.ply_vendor_id)}</div>` : ''}${v.notes ? `<div style="white-space:pre-wrap;margin-top:6px">${esc(v.notes)}</div>` : ''}</div>` : ''}
    <div class="grid g2" style="margin-top:14px">
      <div class="card"><h2>Purchase orders</h2>${table([{ label: 'PO', html: p => `<b>${esc(p.number)}</b>` }, { label: 'Job', get: p => p.job_number || 'Shop stock' }, { label: 'Ordered', get: p => fmtDate(p.order_date) },
        { label: 'Status', html: p => pill(p.status) }, { label: 'Total', num: 1, get: p => money(p.total) }], v.purchase_orders, { onClick: p => go('#/purchasing/po/' + p.id), empty: 'No purchase orders yet' })}</div>
      ${v.sees_bills ? `<div class="card"><h2>Bills</h2>${table([{ label: 'Their invoice', get: b => b.vendor_invoice || '—' }, { label: 'Date', get: b => fmtDate(b.bill_date) },
        { label: 'Due', html: b => `${fmtDate(b.due_date)}${b.balance > 0.004 && b.status !== 'void' && b.due_date && b.due_date < todayStr() ? ' <span class="pill bad">Past due</span>' : ''}` },
        { label: 'Status', html: b => pill(b.status) }, { label: 'Total', num: 1, get: b => money(b.total) }, { label: 'Owed', num: 1, get: b => b.status === 'void' ? '' : money(b.balance) }], v.bills,
        { onClick: b => go('#/accounting/bills/' + b.id), empty: 'No bills entered' })}</div>` : ''}
      <div class="card"><h2>Price book items from this vendor</h2>${table([{ label: 'Code', key: 'code' }, { label: 'Item', html: p => `${esc(p.name)}${p.active ? '' : ' <span class="pill">Inactive</span>'}` },
        { label: 'Cost', num: 1, get: p => money(p.unit_cost) }, { label: 'On hand', num: 1, html: p => `${num(p.qty_on_hand)}${p.reorder_point && p.qty_on_hand <= p.reorder_point ? ' <span class="pill warn">Reorder</span>' : ''}` }],
        v.items, { empty: 'No price book items list this vendor as preferred' })}</div>
    </div>`;
  $('#editv').onclick = () => vendorForm(v);
}

async function viewPO(id) {
  const { params } = hashParams();
  const [vendors, pb] = await Promise.all([loadVendors(true), loadPricebook(true)]);
  let po = id === 'new' ? { lines: [], status: 'draft', vendor_id: params.get('vendor_id') ? Number(params.get('vendor_id')) : null, job_id: params.get('job_id') ? Number(params.get('job_id')) : null, deliver_to: params.get('job_id') ? 'job' : 'shop', tax: 0, shipping: 0, order_date: todayStr() } : await GET('/purchase-orders/' + id);
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
      ${fieldHtml({ name: 'job_id', label: 'Job (blank = stock)', type: 'job', blank: '— Shop stock —', text: po.job_id && po.job_number ? `${po.job_number}${po.job_title ? ` · ${po.job_title}` : ''}` : '' }, po.job_id)}
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
  on('#ply', () => sendToPly(`/purchase-orders/${id}/send-to-ply`));
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
  const [p] = await Promise.all([GET('/pick-lists/' + id), loadCostCodes()]);
  const done = ['picked', 'delivered', 'cancelled'].includes(p.status);
  const plyOn = S.settings.ply_enabled === '1';
  const office = isOffice(), seeCost = office && can('see_costs');
  const edit = p.can_edit;          // add / change lines (office), add lines (tech on the job)
  const lineCols = [
    { label: 'Item', html: l => `<b>${esc(l.description)}</b><div class="small muted">${[l.sku, !l.pricebook_id ? 'custom item' : '', l.note, l.added_by_name ? `added by ${l.added_by_name}` : ''].filter(Boolean).map(esc).join(' · ')}</div>`, csv: l => l.description },
    { label: 'Code', get: l => l.cost_code || '—', csv: l => l.cost_code || '' },
    { label: 'Need', num: 1, html: l => office && edit && !l.job_material_id ? `<input class="n need-qty" type="number" step="any" min="0" data-need="${l.id}" value="${l.qty}" style="width:76px"> ${esc(l.unit || '')}` : `${num(l.qty)} ${esc(l.unit || '')}`, csv: l => l.qty },
    { label: 'Unit', html: () => '', csv: l => l.unit || 'ea', hide: 1 },
    ...(office ? [{ label: 'On hand', num: 1, html: l => l.pricebook_id ? (l.qty_on_hand < l.qty ? `<span class="pill bad">${num(l.qty_on_hand)}</span>` : num(l.qty_on_hand)) : '—', csv: l => l.pricebook_id ? l.qty_on_hand : '' }] : []),
    ...(seeCost ? [{ label: 'Unit cost', num: 1, get: l => l.unit_cost != null ? money(l.unit_cost) : '—', csv: l => l.unit_cost ?? '' }] : []),
    { label: 'Picked', html: l => done || l.job_material_id ? num(l.qty_picked) : `<input class="pick-qty" type="number" step="any" min="0" data-line="${l.id}" value="${l.qty_picked || ''}" placeholder="${l.qty}">`, csv: l => l.qty_picked || 0 },
    ...(done ? [] : [{ label: '', html: l => l.job_material_id ? '' : `<button type="button" class="btn sm" data-all="${l.id}" data-q="${l.qty}">All</button>${office && edit ? ` <button type="button" class="btn sm danger" data-rm="${l.id}" title="Remove line">✕</button>` : ''}` }]),
  ];
  $('#view').innerHTML = setTop(`Pick list ${esc(p.number)}`, `${pill(p.status)}
      ${!done && p.lines.length ? '<button class="btn go" id="complete">Complete pick</button>' : ''}${p.status === 'picked' ? '<button class="btn primary" id="deliver">Mark delivered</button>' : ''}
      ${office && !done && p.lines.length ? '<button class="btn" id="short">PO for shortages</button>' : ''}${office && plyOn && p.lines.length ? `<button class="btn" id="ply">${p.ply_id ? 'Re-send to Ply' : 'Send to Ply'}</button>` : ''}
      <button class="btn" id="plcsv">CSV</button><button class="btn" onclick="print()">Print</button>`,
    `Job <a href="#/jobs/${p.job_id}">${esc(p.job_number)}</a> ${esc(p.job_title)}${p.needed_by ? ` · needed ${fmtDate(p.needed_by)}` : ''}${p.assigned_name ? ` · picker ${esc(p.assigned_name)}` : ''}${p.ply_synced_at ? ` · sent to Ply ${fmtDT(p.ply_synced_at + 'Z')}` : ''}`) + `
    <div class="card"><form id="pk">${table(lineCols.filter(c => !c.hide), p.lines, { empty: edit ? 'No material on this list yet. Add it below.' : 'No lines' })}
      ${!done && p.lines.length ? '<div class="row no-print" style="margin-top:12px"><button class="btn">Save</button></div>' : ''}</form>
      ${edit ? `<div class="addmat no-print"><h3 style="margin:16px 0 6px">Add material</h3>
        <form id="addm" class="addmat-row">
          <div class="lk grow"><input type="hidden" name="pricebook_id"><input name="description" placeholder="Search the price book, or type any item" autocomplete="off" required></div>
          <input name="qty" type="number" step="any" min="0" placeholder="Qty" required style="width:80px">
          <input name="unit" placeholder="Unit (ea, ft, box)" style="width:120px">
          ${seeCost ? '<input name="unit_cost" type="number" step="any" min="0" placeholder="Unit cost" style="width:110px">' : ''}
          <select name="cost_code_id" style="width:220px"><option value="">Cost code…</option>${ccOptions('material').map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('')}</select>
          <input name="note" placeholder="Note (size, color, brand)" style="width:200px">
          <button class="btn primary">+ Add</button>
        </form>
        <p class="small muted">${office ? 'Price book items fill in the unit, cost and cost code. Custom items charge the job at the cost you enter.' : 'Your additions go to the office with your name on them.'}</p></div>` : ''}
      ${p.notes ? `<p>📝 ${esc(p.notes)}</p>` : ''}</div>`;
  const lines = () => $$('[data-line]').map(i => ({ id: Number(i.dataset.line), qty_picked: Number(i.value) || 0, ...(office && $(`[data-need="${i.dataset.line}"]`) ? { qty: Number($(`[data-need="${i.dataset.line}"]`).value) } : {}) }));
  $$('[data-all]').forEach(b => b.onclick = () => { const need = $(`[data-need="${b.dataset.all}"]`); $(`[data-line="${b.dataset.all}"]`).value = need ? need.value : b.dataset.q; });
  $$('[data-rm]').forEach(b => b.onclick = async () => { const l = p.lines.find(x => x.id === Number(b.dataset.rm)); if (confirm(`Remove "${l.description}" from the list?`)) { await act(() => PUT('/pick-lists/' + id, { remove: [l.id] }), 'Removed'); route(); } });
  if ($('#pk') && !done) $('#pk').onsubmit = async e => { e.preventDefault(); await act(() => PUT('/pick-lists/' + id, { lines: lines() }), 'Saved'); route(); };
  $('#plcsv').onclick = () => toCSV(lineCols, p.lines, `${p.number}_${p.job_number}.csv`);
  const af = $('#addm');
  if (af) {
    await pricebookSearch(af.description, af.pricebook_id, { onPick: it => {
      if (!it) return;
      if (it.unit && !af.unit.value) af.unit.value = it.unit;
      if (af.unit_cost && !af.unit_cost.value) af.unit_cost.value = it.unit_cost ?? '';
      if (it.cost_code_id) af.cost_code_id.value = it.cost_code_id;
      af.qty.focus();
    } });
    af.onsubmit = async e => {
      e.preventDefault();
      const d = { pricebook_id: af.pricebook_id.value || null, description: af.description.value.trim(), qty: Number(af.qty.value), unit: af.unit.value.trim() || null,
        unit_cost: af.unit_cost ? af.unit_cost.value : undefined, cost_code_id: af.cost_code_id.value || null, note: af.note.value.trim() || null };
      if (!(d.qty > 0)) { af.qty.focus(); return toast('Enter a quantity', true); }
      await act(() => PUT('/pick-lists/' + id, { lines: [d] }), `Added ${d.description}`);
      await route(); const n = $('#addm'); if (n) n.description.focus();
    };
    if (!p.lines.length) af.description.focus();
  }
  const on = (sel, fn) => { const el = $(sel); if (el) el.onclick = fn; };
  on('#complete', async () => {
    const l = lines(); if (!l.some(x => x.qty_picked > 0)) return toast('Enter picked quantities first', true);
    if (!confirm('Complete pick? Picked items leave stock and are charged to the job.')) return;
    await act(() => PUT('/pick-lists/' + id, { lines: l })); await act(() => POST(`/pick-lists/${id}/complete`), 'Pick complete'); route();
  });
  on('#deliver', async () => { await act(() => POST(`/pick-lists/${id}/delivered`), 'Delivered'); route(); });
  on('#ply', () => sendToPly(`/pick-lists/${id}/send-to-ply`));
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
  const tabs = [['overview', 'Overview'], ['banking', 'Banking'], ['coa', 'Chart of accounts'], ['journal', 'Journal'], ['bills', 'Bills (A/P)'], ['statements', 'Financial statements'], ['payroll', 'Labor & payroll'], ['close', 'Close books']];
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
  if (tab === 'banking') await bankingTab(E, params);
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
  const acctSel = `<select data-k="account_id"><option value="">Account…</option>${S.accounts.map(a => `<option value="${a.id}">${esc(a.number)} ${esc(a.name)}</option>`).join('')}</select>`;
  const line = () => `<tr><td>${acctSel}</td><td><input class="n" type="number" step="any" data-k="debit"></td><td><input class="n" type="number" step="any" data-k="credit"></td><td><input data-k="memo"></td><td>${jobPickHtml({ dataK: 'job_id', placeholder: 'Job (optional)' })}</td></tr>`;
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
  const [vendors] = await Promise.all([loadVendors(true), loadAccounts(true)]);
  const b = id === 'new' ? { lines: [{}], payments: [], status: 'open', bill_date: todayStr() } : await GET('/bills/' + id);
  const locked = !!b.po_id || b.status === 'void' || (b.payments || []).length > 0;
  const acctList = S.accounts.filter(a => ['cogs', 'expense', 'asset'].includes(a.type));
  const line = (l = {}) => `<tr>
    <td><select data-k="account_id" ${locked ? 'disabled' : ''}><option value="">Account…</option>${acctList.map(a => `<option value="${a.id}" ${a.id === l.account_id ? 'selected' : ''}>${esc(a.number)} ${esc(a.name)}</option>`).join('')}</select></td>
    <td><input data-k="description" value="${esc(l.description || '')}" ${locked ? 'disabled' : ''}></td>
    <td><input class="n" type="number" step="any" data-k="amount" value="${l.amount ?? ''}" ${locked ? 'disabled' : ''}></td>
    <td>${jobPickHtml({ dataK: 'job_id', value: l.job_id || '', text: l.job_id && l.job_number ? `${l.job_number}${l.job_title ? ` · ${l.job_title}` : ''}` : '', placeholder: 'Overhead — or type a job', disabled: locked })}</td>
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
      ${fieldHtml({ name: 'brand_primary', label: 'Primary (buttons, links)', type: 'color' }, s.brand_primary || '#e0001a')}
      ${fieldHtml({ name: 'brand_accent', label: 'Accent (highlights)', type: 'color' }, s.brand_accent || '#fa001c')}
      ${fieldHtml({ name: 'brand_sidebar', label: 'Sidebar', type: 'color' }, s.brand_sidebar || '#000000')}
      <label class="f"><span>Logo (PNG/JPG/SVG, under 300 KB)</span><input type="file" id="logo" accept="image/*"></label>
      ${fieldHtml({ name: 'logo_url', label: '…or logo URL', full: true }, s.logo_url && !s.logo_url.startsWith('data:') ? s.logo_url : '')}
      ${fieldHtml({ name: 'company_tagline', label: 'Tagline (sign-in screen)', full: true }, s.company_tagline)}
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
    cards.push(`<div class="card"><h2>Address lookup</h2>
      <p class="small">When you type a service address, the app looks it up, fills in city, state and ZIP, and saves its map location. Every address field also has a <b>Map ↗</b> button that opens Google Maps.</p>
      <p class="small">${s.google_maps_api_key_set ? '<span class="pill good">Google Maps key saved</span> Suggestions come from Google as you type.' : '<span class="pill">Free mode</span> Without a key, the free US Census lookup checks an address once you have typed the house number and street. There are no suggestions while you type.'}</p>
      <form id="geof"><div class="form-grid">
        ${fieldHtml({ name: 'google_maps_api_key', label: s.google_maps_api_key_set ? 'Google Maps API key (saved — leave blank to keep)' : 'Google Maps API key (optional)', type: 'password', full: true })}
      </div>
      <details class="small" style="margin:8px 0"><summary>How to get a key</summary><ol>
        <li>Go to console.cloud.google.com and create a project. Billing must be turned on, though light use usually stays inside Google's free monthly allowance.</li>
        <li>Under <b>APIs &amp; Services → Library</b>, enable <b>Places API (New)</b>.</li>
        <li>Under <b>Credentials → Create credentials → API key</b>, restrict the key to <b>Places API (New)</b> only.</li>
        <li>Paste it here. The key stays on your server and is never sent to browsers.</li></ol></details>
      <div class="row"><button class="btn primary">Save</button>${s.google_maps_api_key_set ? '<button type="button" class="btn danger" id="geoclear">Remove key</button>' : ''}</div></form></div>`);
    const log = await GET('/integrations/ply/log');
    let locs = []; try { locs = JSON.parse(s.ply_locations || '[]'); } catch { locs = []; }
    let last = null; try { last = JSON.parse(s.ply_last_sync || 'null'); } catch { last = null; }
    const locOpts = locs.filter(l => l.type !== 'JOB').map(l => [l.id, `${l.name}${l.type ? ` (${label(String(l.type).toLowerCase())})` : ''}`]);
    cards.push(`<div class="card"><h2>Integrations — Ply</h2>
      <p class="small muted">Uses the Ply Public API. In Ply: <b>Settings → Workspace → API Keys → Create API Key</b>. Give it these scopes: <code>jobs:write</code>, <code>pick_lists:write</code>, <code>purchase_orders:write</code>, <code>materials:write</code>, <code>materials_availability:read</code>, <code>locations:read</code>, <code>suppliers:read</code>. The key is stored on this server only.</p>
      <p class="small">${s.ply_enabled === '1' && s.ply_api_key_set ? `<span class="pill good">Enabled</span> Use Test connection to confirm the key works.${s.ply_auto_sync !== '0' ? ' Pulls PO receipts and finished picks every hour.' : ''}` : '<span class="pill">Not connected</span>'}${last && last.at ? ` Last sync ${fmtDT(last.at)}: ${last.received_lines} PO line(s) received, ${last.picks_completed} pick(s) completed${last.errors && last.errors.length ? `, <span style="color:var(--bad)">${last.errors.length} problem(s)</span>` : ''}.` : ''}</p>
      <form id="plyf"><div class="form-grid">
        ${fieldHtml({ name: 'ply_enabled', label: 'Enabled', type: 'checkbox', full: true }, s.ply_enabled === '1')}
        ${fieldHtml({ name: 'ply_api_key', label: s.ply_api_key_set ? 'API key (saved — leave blank to keep)' : 'API key', type: 'password', full: true })}
        ${fieldHtml({ name: 'ply_env', label: 'Ply account', type: 'select', options: [['production', 'Live (api.getply.com)'], ['demo', 'Demo / testing (demo-api.getply.com)']], blank: false }, s.ply_env || 'production')}
        ${fieldHtml({ name: 'ply_auto_sync', label: 'Sync every hour', type: 'checkbox' }, s.ply_auto_sync !== '0')}
        ${fieldHtml({ name: 'ply_from_location_id', label: 'Pick lists come from (warehouse or truck)', type: 'select', options: locOpts, blank: locOpts.length ? '— choose —' : 'Test connection to load your locations' }, s.ply_from_location_id)}
        ${fieldHtml({ name: 'ply_po_location_id', label: 'Shop POs deliver to', type: 'select', options: locOpts, blank: '— none —' }, s.ply_po_location_id)}
      </div>
      <div class="row" style="flex-wrap:wrap;margin-top:8px"><button class="btn primary">Save</button><button type="button" class="btn" id="plytest">Test connection</button>
        <button type="button" class="btn" id="plypull">Pull materials &amp; stock</button><button type="button" class="btn" id="plysync">Sync now</button></div></form>
      <h3 style="margin-top:14px">Recent activity</h3>${table([{ label: 'When', get: l => fmtDT(l.created_at) }, { label: 'Call', key: 'event' }, { label: 'Status', html: l => `<span class="pill ${l.status === 'ok' ? 'good' : l.status === 'rate_limited' ? 'warn' : 'bad'}">${esc(l.status)}</span>` }],
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
    const body = { brand_primary: bf.brand_primary.value, brand_accent: bf.brand_accent.value, brand_sidebar: bf.brand_sidebar.value, company_tagline: bf.company_tagline.value };
    const file = $('#logo').files[0];
    if (file) {
      if (file.size > 300 * 1024) return toast('Logo must be under 300 KB', true);
      body.logo_url = await new Promise(res => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(file); });
    } else if (bf.logo_url.value) body.logo_url = bf.logo_url.value;
    saveSettings(body, 'Branding saved');
  };
  $('#brandreset').onclick = () => saveSettings({ brand_primary: '#e0001a', brand_accent: '#fa001c', brand_sidebar: '#000000', logo_url: '/brand/a4y-logo.png' }, 'Branding reset to All 4 You defaults');
  $('#logoclear').onclick = () => saveSettings({ logo_url: '' }, 'Logo removed');
  $('#defs').onsubmit = e => { e.preventDefault(); const f = e.target; saveSettings({ day_start_hour: f.day_start_hour.value, day_end_hour: f.day_end_hour.value, default_deposit_account: f.default_deposit_account.value, default_paid_from_account: f.default_paid_from_account.value }, 'Defaults saved'); };
  $('#geof').onsubmit = e => { e.preventDefault(); const v = e.target.google_maps_api_key.value.trim(); if (!v) return toast('Paste the key first', true); saveSettings({ google_maps_api_key: v }, 'Google Maps key saved'); };
  if ($('#geoclear')) $('#geoclear').onclick = () => { if (confirm('Remove the Google Maps key? Address lookup falls back to the free US Census check.')) saveSettings({ google_maps_api_key_clear: '1' }, 'Key removed'); };
  const pf = $('#plyf');
  pf.onsubmit = e => { e.preventDefault(); saveSettings({ ply_enabled: pf.ply_enabled.checked ? '1' : '0', ply_api_key: pf.ply_api_key.value.trim(), ply_env: pf.ply_env.value,
    ply_auto_sync: pf.ply_auto_sync.checked ? '1' : '0', ply_from_location_id: pf.ply_from_location_id.value, ply_po_location_id: pf.ply_po_location_id.value }, 'Ply settings saved'); };
  $('#plytest').onclick = async () => {
    const r = await act(() => POST('/integrations/ply/test'));
    toast(`Connected to Ply ✓ ${r.materials} materials, ${r.locations.length} locations${r.suppliers != null ? `, ${r.suppliers} suppliers` : ''}`);
    if (r.suppliers_error) toast(r.suppliers_error, true);
    S.settings = await GET('/me').then(m => m.settings); route();
  };
  $('#plysync').onclick = async () => { const r = await act(() => POST('/integrations/ply/sync')); toast(`Ply: ${r.pos} PO(s) checked, ${r.received_lines} line(s) received, ${r.picks_completed} pick(s) completed`); if (r.errors.length) toast(r.errors.join('; '), true); route(); };
  $('#plypull').onclick = async () => { const r = await act(() => POST('/integrations/ply/pull-items')); toast(`Ply catalog: ${r.updated} updated (${r.linked} newly linked), ${r.created} added to the price book`); route(); };
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

// ============================================================ banking & reconciliation (admin)
const signed = n => `<span style="font-variant-numeric:tabular-nums;white-space:nowrap">${n < 0 ? '−' : '+'}${money(Math.abs(n))}</span>`;
async function bankingTab(E, params) {
  const accts = await GET('/banking/accounts');
  if (!accts.length) { E.innerHTML = '<div class="empty">No bank or credit card accounts. Add one in Chart of accounts with Detail = Bank account or Credit card.</div>'; return; }
  const acctId = Number(params.get('acct')) || accts[0].id;
  const acct = accts.find(a => a.id === acctId) || accts[0];
  const status = params.get('status') ?? 'unmatched';
  const [txs, rules, recs] = await Promise.all([GET('/banking/transactions' + qs({ account_id: acct.id, status })), GET('/banking/rules'), GET('/reconciliations' + qs({ account_id: acct.id }))]);
  const lastDone = recs.find(r => r.status === 'completed');
  E.innerHTML = `<div class="grid g4">${accts.map(a => `<a class="card kpi" href="#/accounting${qs({ tab: 'banking', acct: a.id })}" style="text-decoration:none;color:inherit;${a.id === acct.id ? 'outline:2px solid var(--brand)' : ''}">
      <div class="label">${esc(a.number)} · ${esc(a.name)}</div><div class="value">${money0(a.book_balance)}</div>
      <div class="sub">${a.to_review ? `<span class="pill warn">${a.to_review} to review</span> ` : ''}${a.last_reconciled ? `Reconciled through ${fmtDate(a.last_reconciled.statement_date)}` : 'Never reconciled'}</div></a>`).join('')}</div>
    <div class="card" style="margin-top:14px"><div class="row spread"><h2>${esc(acct.name)} — bank transactions</h2>
      <div class="row"><label class="btn"><input type="file" id="stmt" accept=".csv,.ofx,.qfx,.qbo,text/csv" style="display:none">⬆ Import statement</label>
        ${acct.subtype === 'credit_card' ? '<label class="check small"><input type="checkbox" id="flip"> Purchases show as positive in my file</label>' : ''}
        <button class="btn" id="automatch">Auto-match</button>
        <button class="btn primary" id="reconcile">${acct.open_reconciliation ? 'Resume reconciliation' : 'Reconcile'}</button></div></div>
      <p class="small muted">Download a CSV or OFX/QFX statement from your bank's website and import it. Lines that match something already in the books are matched automatically; review the rest.</p>
      <div class="tabs" style="border:0">${[['unmatched', `To review (${acct.to_review})`], ['matched', 'Matched'], ['excluded', 'Excluded'], ['', 'All']].map(([v, l]) => `<button class="${v === status ? 'on' : ''}" data-s="${v}">${l}</button>`).join('')}</div>
      ${table([{ label: 'Date', get: t => fmtDate(t.date) }, { label: 'Bank description', html: t => `${esc(t.description)}${t.reference ? ` <span class="muted small">#${esc(t.reference)}</span>` : ''}` },
        { label: 'Amount', num: 1, html: t => signed(t.amount) },
        { label: 'In the books', html: t => t.status === 'matched' ? `<span class="pill good">✓ Matched</span> <span class="small">${esc(t.match_memo || '')} · ${fmtDate(t.match_date)}</span>`
          : t.status === 'excluded' ? '<span class="pill">Excluded</span>'
          : (t.candidates && t.candidates.length ? `<span class="small">Looks like: <b>${esc(t.candidates[0].entry_memo || t.candidates[0].memo || label(t.candidates[0].source_type))}</b> · ${fmtDate(t.candidates[0].date)}</span>`
          : t.invoice_suggestions && t.invoice_suggestions.length ? `<span class="small">Payment for <b>${esc(t.invoice_suggestions[0].number)}</b> (${esc(t.invoice_suggestions[0].customer_name)})?</span>`
          : t.rule ? `<span class="small">Rule → ${esc(t.rule.account_number)} ${esc(t.rule.account_name)}</span>` : '<span class="muted small">Not in the books yet</span>') },
        { label: '', html: t => t.status === 'matched' ? `<button class="btn sm" data-unmatch="${t.id}">Unmatch</button>`
          : t.status === 'excluded' ? `<button class="btn sm" data-include="${t.id}">Include</button>`
          : `<div class="status-btns">${t.candidates && t.candidates.length ? `<button class="btn sm primary" data-match="${t.id}:${t.candidates[0].id}">Match</button>` : ''}
             ${t.invoice_suggestions && t.invoice_suggestions.length ? `<button class="btn sm primary" data-inv="${t.id}:${t.invoice_suggestions[0].id}">Apply</button>` : ''}
             <button class="btn sm ${!(t.candidates && t.candidates.length) && !(t.invoice_suggestions && t.invoice_suggestions.length) ? 'primary' : ''}" data-cat="${t.id}">${t.amount < 0 ? 'Add expense' : 'Categorize'}</button>
             <button class="btn sm" data-find="${t.id}">Find match</button><button class="btn sm" data-excl="${t.id}" title="Ignore this line (e.g. a duplicate)">✕</button></div>` }],
      txs, { empty: status === 'unmatched' ? 'Nothing to review — import a statement or reconcile.' : 'Nothing here' })}</div>
    <div class="grid g2" style="margin-top:14px">
      <div class="card"><div class="row spread"><h2>Reconciliations</h2></div>
        ${table([{ label: 'Statement ending', get: r => fmtDate(r.statement_date) }, { label: 'Ending balance', num: 1, get: r => money(r.statement_balance) }, { label: 'Status', html: r => pill(r.status === 'completed' ? 'passed' : 'open').replace(/Passed|Open/, r.status === 'completed' ? 'Reconciled' : 'In progress') },
          { label: 'By', get: r => r.completed_by_name || '' }, { label: '', html: r => r.status === 'completed' && lastDone && r.id === lastDone.id ? `<button class="btn sm" data-undo="${r.id}">Undo</button>` : '' }],
        recs, { onClick: r => go('#/accounting/reconcile/' + r.id), empty: 'No reconciliations yet' })}</div>
      <div class="card"><div class="row spread"><h2>Categorization rules</h2><button class="btn sm" id="newrule">+ Rule</button></div>
        <p class="small muted">When a bank description contains the text, "Add expense" pre-fills the account.</p>
        ${table([{ label: 'Contains', html: r => `<code>${esc(r.match_text)}</code>` }, { label: 'Direction', get: r => ({ out: 'Money out', in: 'Money in', any: 'Either' })[r.direction] }, { label: 'Account', get: r => `${r.account_number} ${r.account_name}` },
          { label: '', html: r => `<button class="btn sm danger" data-delrule="${r.id}">✕</button>` }], rules, { empty: 'No rules' })}</div></div>`;

  const reload = () => route();
  $$('[data-s]').forEach(b => b.onclick = () => go('#/accounting' + qs({ tab: 'banking', acct: acct.id, status: b.dataset.s })));
  $('#stmt').onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    const content = await f.text();
    const r = await act(() => POST('/banking/import', { account_id: acct.id, filename: f.name, content, flip: $('#flip') ? $('#flip').checked : false }));
    toast(`Imported ${r.added} new line(s)${r.duplicates ? `, skipped ${r.duplicates} already imported` : ''}; ${r.matched} matched automatically`);
    reload();
  };
  $('#automatch').onclick = async () => { const r = await act(() => POST('/banking/auto-match', { account_id: acct.id })); toast(`${r.matched} matched`); reload(); };
  $('#reconcile').onclick = () => acct.open_reconciliation ? go('#/accounting/reconcile/' + acct.open_reconciliation.id) : formModal({
    title: `Reconcile ${acct.name}`, okLabel: 'Start', values: { statement_date: todayStr() },
    fields: [
      ...(lastDone ? [] : [{ name: 'start_date', label: 'Statement start date', type: 'date', required: true }, { name: 'beginning_balance', label: 'Statement beginning balance', type: 'number', required: true }]),
      { name: 'statement_date', label: 'Statement ending date', type: 'date', required: true },
      { name: 'statement_balance', label: acct.subtype === 'credit_card' ? 'Statement balance owed' : 'Statement ending balance', type: 'number', required: true }],
    extra: lastDone ? `<p class="small muted">Beginning balance ${money(lastDone.statement_balance)}, carried from the ${fmtDate(lastDone.statement_date)} statement.</p>`
      : '<p class="small muted">First reconciliation for this account: copy the start date and beginning balance from the top of your bank statement. Transactions before the start date are treated as already included in that balance.</p>',
    submit: async d => { const r = await POST('/reconciliations', { account_id: acct.id, ...d }); go('#/accounting/reconcile/' + r.id); },
  });
  const txById = Object.fromEntries(txs.map(t => [t.id, t]));
  $$('[data-match]').forEach(b => b.onclick = async () => { const [t, l] = b.dataset.match.split(':'); await act(() => POST(`/banking/transactions/${t}/match`, { journal_line_id: Number(l) }), 'Matched'); reload(); });
  $$('[data-inv]').forEach(b => b.onclick = async () => { const [t, i] = b.dataset.inv.split(':'); await act(() => POST(`/banking/transactions/${t}/apply-invoice`, { invoice_id: Number(i) }), 'Payment recorded and matched'); reload(); });
  $$('[data-unmatch]').forEach(b => b.onclick = async () => { await act(() => POST(`/banking/transactions/${b.dataset.unmatch}/unmatch`), 'Unmatched'); reload(); });
  $$('[data-excl]').forEach(b => b.onclick = async () => { await act(() => POST(`/banking/transactions/${b.dataset.excl}/exclude`, {}), 'Excluded'); reload(); });
  $$('[data-include]').forEach(b => b.onclick = async () => { await act(() => POST(`/banking/transactions/${b.dataset.include}/exclude`, { include: true }), 'Back in review'); reload(); });
  $$('[data-undo]').forEach(b => b.onclick = async () => { if (confirm('Undo this reconciliation? Its transactions become editable again.')) { await act(() => POST(`/reconciliations/${b.dataset.undo}/undo`), 'Reconciliation reopened'); reload(); } });
  $$('[data-delrule]').forEach(b => b.onclick = async () => { await act(() => DEL('/banking/rules/' + b.dataset.delrule)); reload(); });
  $$('[data-find]').forEach(b => b.onclick = async () => {
    const t = txById[b.dataset.find];
    const list = await GET(`/banking/transactions/${t.id}/candidates`);
    const m = modal(`<h2>Match ${signed(t.amount)} · ${esc(t.description)}</h2><p class="small muted">Unreconciled ledger lines on ${esc(acct.name)} for exactly this amount, closest date first.</p>
      ${table([{ label: 'Date', get: c => fmtDate(c.date) }, { label: 'Memo', get: c => c.entry_memo || c.memo || '' }, { label: 'Name', get: c => c.name || '' }, { label: 'Source', html: c => pill(c.source_type) }, { label: '', html: c => `<button class="btn sm primary" data-pick="${c.id}">Match</button>` }],
        list, { empty: 'Nothing in the books for this amount. Use "Add expense"/"Categorize" to record it.' })}<div class="actions"><button class="btn" data-x>Close</button></div>`, { wide: true });
    $('[data-x]', m.el).onclick = m.close;
    $$('[data-pick]', m.el).forEach(p => p.onclick = async () => { await act(() => POST(`/banking/transactions/${t.id}/match`, { journal_line_id: Number(p.dataset.pick) }), 'Matched'); m.close(); reload(); });
  });
  $$('[data-cat]').forEach(b => b.onclick = async () => {
    const t = txById[b.dataset.cat];
    await loadAccounts();
    const out = t.amount < 0;
    const words = String(t.description).toUpperCase().replace(/[^A-Z ]/g, ' ').trim().split(/\s+/).slice(0, 2).join(' ');
    formModal({
      title: `${out ? 'Add expense' : 'Categorize deposit'} · ${t.description}`, okLabel: 'Save & match', wide: true,
      values: { account_id: t.rule ? t.rule.account_id : '', category: t.rule ? t.rule.category : '', vendor: t.rule ? t.rule.vendor : '', description: t.description, rule_text: words },
      fields: [{ name: 'account_id', label: out ? 'Expense account (or another bank/card = transfer)' : 'Income / source account (or another bank/card = transfer)', type: 'select',
          options: S.accounts.filter(a => a.id !== acct.id && (out ? ['expense', 'cogs', 'asset', 'liability', 'equity'] : ['income', 'liability', 'equity', 'asset']).includes(a.type)).map(a => [a.id, `${a.number} · ${a.name}`]), required: true, full: true },
        ...(out ? [{ name: 'category', label: 'Expense category', type: 'select', options: EXPENSE_CATS }, { name: 'vendor', label: 'Vendor' }] : []),
        { name: 'job_id', label: 'Job (job cost, blank = overhead)', type: 'job' }, { name: 'cost_code_id', label: 'Cost code', type: 'select', options: ccOptions() },
        { name: 'description', label: 'Memo', full: true },
        { name: 'save_rule', label: 'Remember: next time the description contains…', type: 'checkbox' }, { name: 'rule_text', label: 'Text to match' }],
      submit: async d => { await POST(`/banking/transactions/${t.id}/categorize`, { ...d, save_rule: !!d.save_rule }); toast('Recorded and matched'); reload(); },
    });
  });
  $('#newrule').onclick = async () => {
    await loadAccounts();
    formModal({ title: 'New categorization rule', fields: [{ name: 'match_text', label: 'Description contains', required: true }, { name: 'direction', label: 'Applies to', type: 'select', options: [['out', 'Money out'], ['in', 'Money in'], ['any', 'Either']], blank: false },
      { name: 'account_id', label: 'Account', type: 'select', options: acctOptions(), required: true, full: true }, { name: 'category', label: 'Expense category', type: 'select', options: EXPENSE_CATS }, { name: 'vendor', label: 'Vendor' }],
      submit: async d => { await POST('/banking/rules', d); toast('Rule saved'); reload(); } });
  };
}

async function viewReconcile(id) {
  let st = await GET('/reconciliations/' + id);
  const done = st.status === 'completed';
  const draw = () => {
    const ins = st.lines.filter(l => l.amount > 0), outs = st.lines.filter(l => l.amount < 0);
    const zero = Math.abs(st.difference) < 0.005;
    const col = (title, list) => `<div class="card"><div class="row spread"><h2>${title} (${list.filter(l => l.cleared).length}/${list.length})</h2>${done ? '' : `<span class="row"><button class="btn sm" data-all="${title}">Check all</button><button class="btn sm" data-none="${title}">Clear all</button></span>`}</div>
      ${table([{ label: '', html: l => `<input type="checkbox" data-line="${l.id}" ${l.cleared ? 'checked' : ''} ${done ? 'disabled' : ''} style="width:20px;height:20px">` },
        { label: 'Date', get: l => fmtDate(l.date) }, { label: 'Memo', html: l => `${esc(l.entry_memo || l.memo || '')}${l.name ? `<div class="small muted">${esc(l.name)}</div>` : ''}` },
        { label: '', html: l => l.bank_tx_id ? '<span class="pill good" title="Matched to an imported bank line">Bank ✓</span>' : '' }, { label: 'Amount', num: 1, html: l => signed(l.amount) }],
      list, { empty: 'None' })}</div>`;
    $('#view').innerHTML = setTop(`Reconcile ${esc(st.account_name)}`, `<a class="btn" href="#/accounting?tab=banking&acct=${st.account_id}">← Banking</a>
        ${done ? '<span class="pill good">✓ Reconciled</span>' : `<button class="btn danger" id="discard">Discard</button><button class="btn primary" id="finish" ${zero ? '' : 'disabled'}>Finish reconciliation</button>`}`,
      `Statement ending ${fmtDate(st.statement_date)}`) + `
      ${st.unmatched_bank_lines && !done ? `<div class="alert" style="margin-bottom:14px">⚠ ${st.unmatched_bank_lines} imported bank line(s) on or before this date aren't in the books yet. <a href="#/accounting?tab=banking&acct=${st.account_id}">Review them</a> first, or the difference won't reach zero.</div>` : ''}
      <div class="grid g4">
        <div class="card kpi"><div class="label">Statement ending balance</div>${done ? `<div class="value">${money(st.statement_balance)}</div>` : `<div class="row" style="margin-top:6px"><input type="number" step="any" id="sbal" value="${st.statement_balance}" style="font-size:20px;font-weight:700"></div><input type="date" id="sdate" value="${st.statement_date}" style="margin-top:6px">`}</div>
        ${kpi('Beginning balance', money(st.beginning_balance), 'from the last reconciliation')}
        ${kpi('Cleared balance', money(st.cleared_balance), `${money(st.cleared_in)} in · ${money(Math.abs(st.cleared_out))} out`)}
        <div class="card kpi" style="border-top-color:${zero ? 'var(--good)' : 'var(--bad)'}"><div class="label">Difference</div><div class="value" style="color:${zero ? 'var(--good)' : 'var(--bad)'}">${money(st.difference)}</div>
          <div class="sub">${zero ? (done ? 'Balanced' : '✓ Balanced — ready to finish') : 'Check off items that appear on the statement'}</div></div>
      </div>
      <div class="grid g2" style="margin-top:14px">${col('Deposits & credits', ins)}${col('Checks & payments', outs)}</div>`;
    if (done) return;
    $$('[data-line]').forEach(c => c.onchange = async () => { st = await PUT('/reconciliations/' + id, { line_ids: [Number(c.dataset.line)], cleared: c.checked }); draw(); });
    const bulk = (title, val) => { const list = st.lines.filter(l => title.startsWith('Deposits') ? l.amount > 0 : l.amount < 0).map(l => l.id); return PUT('/reconciliations/' + id, { line_ids: list, cleared: val }).then(r => { st = r; draw(); }); };
    $$('[data-all]').forEach(b => b.onclick = () => bulk(b.dataset.all, true));
    $$('[data-none]').forEach(b => b.onclick = () => bulk(b.dataset.none, false));
    const hdr = async () => { st = await act(() => PUT('/reconciliations/' + id, { statement_balance: Number($('#sbal').value), statement_date: $('#sdate').value })); draw(); };
    $('#sbal').onchange = hdr; $('#sdate').onchange = hdr;
    $('#finish').onclick = async () => { await act(() => POST(`/reconciliations/${id}/finish`), 'Reconciled — these transactions are now locked'); go(`#/accounting?tab=banking&acct=${st.account_id}`); };
    $('#discard').onclick = async () => { if (confirm('Discard this reconciliation? Check marks are kept.')) { await act(() => DEL('/reconciliations/' + id)); go(`#/accounting?tab=banking&acct=${st.account_id}`); } };
  };
  draw();
}
// boot() runs from field.js (last script)

// Send a pick list or PO to Ply. Items Ply's catalog doesn't have are listed first; adding them is the user's call.
async function sendToPly(path, extra = {}) {
  let r = await act(() => POST(path, extra));
  if (r.needs_confirmation) {
    if (!confirm(`These aren't in Ply's material catalog yet:\n\n• ${r.missing.join('\n• ')}\n\nAdd them to Ply's catalog and send? (Cancel to send nothing. Then link them under Price Book or add them in Ply.)`)) return;
    r = await act(() => POST(path, { ...extra, create_missing: true }));
  }
  toast(`Sent ${r.sent} line(s) to Ply${r.supplier_linked === false ? ' (no matching supplier in Ply; pick it there)' : ''}`);
  route();
  return r;
}
