'use strict';
/* Field tools: GPS stamps, job photos & files, checklists, customer sign-off, equipment.
   Loaded last; starts the app (boot) once every view is defined. */

// ============================================================ location
// Best-effort phone location for punches. Never blocks a clock-in: gives up after 5 s or if denied.
let locDenied = false;
function getLoc() {
  if (locDenied || !navigator.geolocation) return Promise.resolve({});
  return new Promise(res => {
    const done = v => { clearTimeout(t); res(v); };
    const t = setTimeout(() => done({}), 5000);
    navigator.geolocation.getCurrentPosition(
      p => done({ lat: +p.coords.latitude.toFixed(6), lng: +p.coords.longitude.toFixed(6), acc: Math.round(p.coords.accuracy) }),
      e => { if (e.code === 1) locDenied = true; done({}); },
      { enableHighAccuracy: true, timeout: 4500, maximumAge: 60000 });
  });
}

// ============================================================ files
// Images are fetched with the auth header and shown from a blob URL (no token in the URL).
const blobCache = new Map();
async function authImg(id) {
  if (blobCache.has(id)) return blobCache.get(id);
  const r = await fetch(`/api/attachments/${id}/file`, { headers: { Authorization: 'Bearer ' + S.token } });
  if (!r.ok) throw new Error('Could not load file');
  const u = URL.createObjectURL(await r.blob());
  blobCache.set(id, u);
  return u;
}
const readAsDataURL = blob => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(blob); });
// Shrink phone photos (often 4–12 MB) to ≤1600 px JPEG before upload: faster on cell data, plenty for documentation.
async function prepareUpload(file) {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) return { data: await readAsDataURL(file), filename: file.name };
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas'); c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.82));
    return { data: await readAsDataURL(blob), filename: file.name.replace(/\.\w+$/, '') + '.jpg' };
  } catch { return { data: await readAsDataURL(file), filename: file.name }; }
}
async function uploadFiles(files, target, { tag, onProgress } = {}) {
  const loc = await getLoc();
  let n = 0;
  for (const f of files) {
    if (f.size > 25 * 1024 * 1024) { toast(`${f.name} is too large`, true); continue; }
    onProgress && onProgress(++n, files.length);
    const up = await prepareUpload(f);
    await POST('/attachments', { ...target, tag, ...loc, ...up });
  }
}
const PHOTO_TAGS = [['before', 'Before'], ['during', 'During'], ['after', 'After'], ['panel', 'Panel / labels'], ['permit', 'Permit / inspection'], ['damage', 'Existing damage'], ['other', 'Other']];

function fieldPhotosTab(j, T) {
  const items = j.attachments;
  const filter = hashParams().params.get('tag') || '';
  const shown = items.filter(a => !filter || a.tag === filter);
  T.innerHTML = `<div class="card"><div class="row spread"><h2>Photos & files</h2>
      <div class="row"><select id="ptag" style="width:auto">${PHOTO_TAGS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>
        <label class="btn primary"><input type="file" id="pcam" accept="image/*" capture="environment" multiple style="display:none">📷 Take photo</label>
        <label class="btn"><input type="file" id="pfile" accept="image/*,application/pdf" multiple style="display:none">⬆ Upload</label></div></div>
    <div class="tabs" style="border:0"><button class="${!filter ? 'on' : ''}" data-ft="">All (${items.length})</button>${PHOTO_TAGS.filter(([v]) => items.some(a => a.tag === v)).map(([v, l]) => `<button class="${filter === v ? 'on' : ''}" data-ft="${v}">${l} (${items.filter(a => a.tag === v).length})</button>`).join('')}</div>
    <div id="pprog" class="small muted"></div>
    <div class="gallery">${shown.map(a => `<figure class="ph" data-att="${a.id}">${a.mime === 'application/pdf' ? '<div class="pdf">📄 PDF</div>' : `<img alt="${esc(a.caption || a.filename)}" data-src="${a.id}">`}
      <figcaption>${a.kind === 'signature' ? '✍ Signature' : esc(label(a.tag || a.kind))} · ${esc(a.user_name || '')}<br><span class="muted">${fmtDT(a.created_at)}</span>${a.caption ? `<br>${esc(a.caption)}` : ''}</figcaption></figure>`).join('') || '<div class="empty">No photos yet. Take before, during and after shots — they protect you on callbacks and disputes.</div>'}</div></div>`;
  $$('img[data-src]', T).forEach(img => authImg(img.dataset.src).then(u => { img.src = u; }).catch(() => { img.alt = 'Could not load'; }));
  $$('[data-ft]', T).forEach(b => b.onclick = () => go(`#/jobs/${j.id}?tab=photos${b.dataset.ft ? '&tag=' + b.dataset.ft : ''}`));
  const onPick = async e => {
    const files = [...e.target.files]; if (!files.length) return;
    try {
      await uploadFiles(files, { entity_type: 'job', entity_id: j.id }, { tag: $('#ptag').value, onProgress: (i, n) => { $('#pprog').textContent = `Uploading ${i} of ${n}…`; } });
      toast(`${files.length} file(s) added`);
    } catch (err) { toast(err.message, true); }
    route();
  };
  $('#pcam').onchange = onPick; $('#pfile').onchange = onPick;
  $$('[data-att]', T).forEach(f => f.onclick = () => photoViewer(items.find(a => a.id === Number(f.dataset.att))));
}
async function photoViewer(a) {
  const url = await authImg(a.id);
  const mine = a.user_name === S.user.name;
  const m = modal(`<div class="row spread"><h2>${esc(a.filename || 'File')}</h2><span class="muted small">${esc(a.user_name || '')} · ${fmtDT(a.created_at)}</span></div>
    ${a.mime === 'application/pdf' ? `<p><a class="btn primary" href="${url}" target="_blank" rel="noopener">Open PDF</a></p>` : `<img src="${url}" alt="" style="width:100%;max-height:65vh;object-fit:contain;background:#000;border-radius:8px">`}
    ${a.lat != null ? `<p class="small"><a target="_blank" rel="noopener" href="https://maps.google.com/?q=${a.lat},${a.lng}">📍 Taken here</a></p>` : ''}
    ${a.kind === 'signature' ? '' : `<div class="form-grid" style="margin-top:10px">${fieldHtml({ name: 'caption', label: 'Caption', full: true }, a.caption)}${fieldHtml({ name: 'tag', label: 'Tag', type: 'select', options: PHOTO_TAGS, blank: false }, a.tag || 'other')}</div>`}
    <div class="actions">${a.kind !== 'signature' && (isOffice() || mine) ? '<button class="btn danger" id="pdel">Delete</button>' : ''}<a class="btn" href="${url}" download="${esc(a.filename || 'file')}">Download</a>
      ${a.kind === 'signature' ? '' : '<button class="btn primary" id="psave">Save</button>'}<button class="btn" data-x>Close</button></div>`, { wide: true });
  $('[data-x]', m.el).onclick = m.close;
  if ($('#psave', m.el)) $('#psave', m.el).onclick = async () => { await act(() => PUT('/attachments/' + a.id, { caption: $('[name=caption]', m.el).value, tag: $('[name=tag]', m.el).value }), 'Saved'); m.close(); route(); };
  if ($('#pdel', m.el)) $('#pdel', m.el).onclick = async () => { if (confirm('Delete this file?')) { await act(() => DEL('/attachments/' + a.id), 'Deleted'); m.close(); route(); } };
}

// ============================================================ checklists
function fieldFormsTab(j, T) {
  const formHtml = f => {
    const done = !!f.completed_at;
    return `<div class="card form-card ${done ? 'done' : ''}" data-form="${f.id}"><div class="row spread"><h2>${esc(f.name)} ${f.required_for_completion ? '<span class="pill warn">Required to complete job</span>' : ''}</h2>
      ${done ? `<span class="pill good">✓ Done · ${esc(f.completed_by_name || '')} · ${fmtDT(f.completed_at)}</span>` : ''}</div>
      ${f.items.map((it, i) => { const v = f.answers[i]; const dis = done ? 'disabled' : '';
        const req = it.required ? '<span class="req" title="Required">*</span>' : '';
        if (it.type === 'check') return `<label class="ck"><input type="checkbox" data-i="${i}" ${v === true ? 'checked' : ''} ${dis}><span>${esc(it.label)}${req}</span></label>`;
        if (it.type === 'passfail') return `<div class="pf ${v === 'fail' ? 'fail' : ''}"><span>${esc(it.label)}${req}</span><span class="seg">${[['pass', 'Pass'], ['fail', 'Fail'], ['na', 'N/A']].map(([k, l]) => `<button type="button" data-i="${i}" data-v="${k}" class="${v === k ? 'on' : ''}" ${dis}>${l}</button>`).join('')}</span></div>`;
        return `<label class="f" style="margin:8px 0"><span>${esc(it.label)}${req}</span><input type="${it.type === 'number' ? 'number' : 'text'}" step="any" data-i="${i}" value="${esc(v ?? '')}" ${dis}></label>`;
      }).join('')}
      <div class="row" style="margin-top:10px">${done ? '<button class="btn" data-reopen>Reopen</button>' : '<button class="btn" data-save>Save progress</button><button class="btn go" data-done>✓ Mark complete</button>'}
        ${isOffice() && !done ? '<button class="btn danger" data-rm style="margin-left:auto">Remove</button>' : ''}</div></div>`;
  };
  T.innerHTML = `${isOffice() ? '<div class="row" style="margin-bottom:12px"><select id="addform" style="width:auto"><option value="">+ Add a checklist…</option></select></div>' : ''}
    <div class="stack">${j.forms.map(formHtml).join('') || '<div class="empty">No checklists for this job type.</div>'}</div>`;
  if (isOffice()) GET('/form-templates').then(ts => {
    const have = new Set(j.forms.map(f => f.template_id));
    $('#addform').insertAdjacentHTML('beforeend', ts.filter(t => !have.has(t.id)).map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join(''));
    $('#addform').onchange = async e => { if (!e.target.value) return; await act(() => POST(`/jobs/${j.id}/forms`, { template_id: Number(e.target.value) }), 'Checklist added'); route(); };
  });
  $$('[data-form]', T).forEach(card => {
    const f = j.forms.find(x => x.id === Number(card.dataset.form));
    const answers = { ...f.answers };
    // every tap saves shortly after, so a redraw (or a dropped phone) never loses answers
    let timer = null, pending = Promise.resolve();
    const autosave = () => { clearTimeout(timer); timer = setTimeout(() => { pending = PUT(`/job-forms/${f.id}`, { answers }).catch(err => toast('Not saved: ' + err.message, true)); }, 500); };
    const flush = async () => { if (timer) { clearTimeout(timer); timer = null; pending = PUT(`/job-forms/${f.id}`, { answers }); } await pending; };
    $$('input[data-i]', card).forEach(inp => inp.addEventListener(inp.type === 'checkbox' ? 'change' : 'input', () => {
      answers[inp.dataset.i] = inp.type === 'checkbox' ? inp.checked : inp.type === 'number' ? (inp.value === '' ? '' : Number(inp.value)) : inp.value;
      autosave();
    }));
    $$('button[data-v]', card).forEach(b => b.onclick = () => {
      answers[b.dataset.i] = b.dataset.v;
      $$(`button[data-i="${b.dataset.i}"]`, card).forEach(x => x.classList.toggle('on', x === b));
      b.closest('.pf').classList.toggle('fail', b.dataset.v === 'fail');
      autosave();
    });
    card._flush = flush;
    const save = async complete => {
      // save every other open checklist first so the redraw keeps their answers too
      await Promise.all($$('[data-form]', T).filter(c => c !== card && c._flush).map(c => c._flush().catch(() => {})));
      clearTimeout(timer);
      const r = await act(() => PUT(`/job-forms/${f.id}`, { answers, complete }), complete ? 'Checklist complete' : 'Saved');
      if (r.failed && r.failed.length) toast(`⚠ Failed: ${r.failed.join('; ')} — note the fix or recommendation`, true);
      route();
    };
    if ($('[data-save]', card)) $('[data-save]', card).onclick = () => save(false);
    if ($('[data-done]', card)) $('[data-done]', card).onclick = () => save(true);
    if ($('[data-reopen]', card)) $('[data-reopen]', card).onclick = async () => { await act(() => PUT(`/job-forms/${f.id}`, { reopen: true }), 'Reopened'); route(); };
    if ($('[data-rm]', card)) $('[data-rm]', card).onclick = async () => { if (confirm('Remove this checklist from the job?')) { await act(() => DEL('/job-forms/' + f.id)); route(); } };
  });
}

// ============================================================ completion + signature
function signaturePad(canvas) {
  const ctx = canvas.getContext('2d');
  const ratio = window.devicePixelRatio || 1;
  const fit = () => { const w = canvas.clientWidth, h = canvas.clientHeight; canvas.width = w * ratio; canvas.height = h * ratio; ctx.scale(ratio, ratio); ctx.lineWidth = 2.4; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#111'; ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); };
  fit();
  let drawing = false, empty = true, last = null;
  const pt = e => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  canvas.addEventListener('pointerdown', e => { drawing = true; last = pt(e); canvas.setPointerCapture(e.pointerId); e.preventDefault(); });
  canvas.addEventListener('pointermove', e => { if (!drawing) return; const p = pt(e); ctx.beginPath(); ctx.moveTo(...last); ctx.lineTo(...p); ctx.stroke(); last = p; empty = false; });
  ['pointerup', 'pointercancel'].forEach(t => canvas.addEventListener(t, () => { drawing = false; }));
  return { clear: () => { ctx.setTransform(1, 0, 0, 1, 0, 0); fit(); empty = true; }, isEmpty: () => empty, toDataURL: () => canvas.toDataURL('image/png') };
}
async function completeJobModal(j) {
  const blockers = j.completion_blockers || [];
  const techBlocked = blockers.length && !isOffice();
  const m = modal(`<form><h2>Complete ${esc(j.number)}</h2>
    ${blockers.length ? `<div class="alert" style="margin-bottom:10px">${techBlocked ? 'Finish these before completing' : 'Not finished (you can override as office)'}: <b>${blockers.map(esc).join(', ')}</b>. <a href="#/jobs/${j.id}?tab=forms" data-x>Open checklists</a></div>` : ''}
    ${fieldHtml({ name: 'completion_notes', label: 'What was done (shows on the job; helps the office invoice)', type: 'textarea', full: true }, j.completion_notes)}
    <h3 style="margin-top:14px">Customer sign-off</h3>
    <p class="small muted">Have the customer sign to accept the work. Their name and signature appear on the job and their invoice.</p>
    <canvas id="sig" class="sigpad"></canvas>
    <div class="row" style="margin-top:6px"><button type="button" class="btn sm" id="sigclear">Clear</button><span class="grow"></span></div>
    <div class="form-grid" style="margin-top:8px">${fieldHtml({ name: 'signoff_name', label: 'Customer name (printed)' }, j.customer_name)}${fieldHtml({ name: 'signoff_note', label: 'Customer comment (optional)' })}
      ${fieldHtml({ name: 'nosig', label: 'Customer not available to sign', type: 'checkbox', full: true })}</div>
    <div class="actions"><button type="button" class="btn" data-x>Cancel</button><button class="btn go" ${techBlocked ? 'disabled' : ''}>✓ Complete job</button></div></form>`, { wide: true });
  $$('[data-x]', m.el).forEach(x => x.addEventListener('click', m.close));
  const pad = signaturePad($('#sig', m.el));
  $('#sigclear', m.el).onclick = pad.clear;
  $('form', m.el).onsubmit = async e => {
    e.preventDefault();
    const f = e.target;
    if (!f.nosig.checked && pad.isEmpty()) return toast('Get the customer’s signature, or tick “Customer not available to sign”', true);
    const body = { completion_notes: f.completion_notes.value || null, signoff_note: f.signoff_note.value || null, ...(await getLoc()) };
    if (!f.nosig.checked) Object.assign(body, { signature: pad.toDataURL(), signoff_name: f.signoff_name.value });
    const r = await act(() => POST(`/jobs/${j.id}/complete`, body), 'Job completed');
    if (r.overridden && r.overridden.length) toast(`Completed without: ${r.overridden.join(', ')} (noted on the job)`, true);
    m.close(); route();
  };
}

// ============================================================ equipment
const EQUIP_TYPES = [['panel', 'Panel'], ['subpanel', 'Subpanel'], ['meter', 'Meter'], ['service_disconnect', 'Service disconnect'], ['transfer_switch', 'Transfer switch / interlock'],
  ['generator', 'Generator'], ['ev_charger', 'EV charger'], ['surge_protector', 'Surge protector'], ['solar_inverter', 'Solar inverter'], ['battery', 'Battery storage'], ['other', 'Other']];
const equipLabel = t => (EQUIP_TYPES.find(x => x[0] === t) || [, label(t)])[1];
function fieldEquipmentTab(j, T) {
  if (!j.location_id) { T.innerHTML = '<div class="empty">Set a service location on this job to track equipment there.</div>'; return; }
  T.innerHTML = `<div class="card"><div class="row spread"><h2>Equipment at ${esc((j.location || {}).address || 'this location')}</h2><button class="btn primary" id="addeq">+ Add equipment</button></div>
    <p class="small muted">Record panels, meters, generators and chargers with make, model and serial. History stays with the address for future service calls and warranty claims.</p>
    ${table([{ label: 'Type', html: e => `<b>${esc(equipLabel(e.type))}</b>${e.status === 'removed' ? ' <span class="pill">Removed</span>' : ''}` }, { label: 'Make / model', get: e => [e.make, e.model].filter(Boolean).join(' ') },
      { label: 'Serial', key: 'serial' }, { label: 'Rating', get: e => [e.amps && `${e.amps} A`, e.voltage].filter(Boolean).join(' · ') }, { label: 'Installed', get: e => e.install_date ? fmtDate(e.install_date) : (e.installed_job_number || '') },
      { label: 'Warranty', html: e => e.warranty_until ? (e.warranty_until < todayStr() ? `<span class="pill">Expired ${fmtDate(e.warranty_until)}</span>` : `<span class="pill good">Until ${fmtDate(e.warranty_until)}</span>`) : '' },
      { label: 'Photos', num: 1, key: 'photo_count' }], j.equipment, { onClick: e => equipmentForm(j, e), empty: 'Nothing recorded at this address yet' })}</div>`;
  $('#addeq').onclick = () => equipmentForm(j, {});
}
async function equipmentForm(j, e) {
  const m = formModal({
    title: e.id ? `${equipLabel(e.type)} · ${e.make || ''} ${e.model || ''}` : 'Add equipment', values: e, wide: true, okLabel: 'Save',
    fields: [{ name: 'type', label: 'Type', type: 'select', options: EQUIP_TYPES, blank: false, default: 'panel' }, { name: 'status', label: 'Status', type: 'select', options: [['active', 'In service'], ['removed', 'Removed / replaced']], blank: false },
      { name: 'make', label: 'Make' }, { name: 'model', label: 'Model' }, { name: 'serial', label: 'Serial #' }, { name: 'amps', label: 'Amps' },
      { name: 'voltage', label: 'Voltage / phase (e.g. 120/240 1PH)' }, { name: 'install_date', label: 'Installed', type: 'date' }, { name: 'warranty_until', label: 'Warranty until', type: 'date' },
      { name: 'installed_here', label: `Installed on this job (${j.number})`, type: 'checkbox', default: e.installed_job_id === j.id ? 1 : 0 }, { name: 'notes', label: 'Notes', type: 'textarea', full: true }],
    extra: `${e.id ? `<div class="row" style="margin-top:10px"><label class="btn"><input type="file" id="eqphoto" accept="image/*" capture="environment" style="display:none">📷 Data-plate photo</label><span id="eqphotos" class="row"></span>${isOffice() ? '<button type="button" class="btn danger" id="eqdel" style="margin-left:auto">Delete</button>' : ''}</div>` : '<p class="small muted">Save first, then add a photo of the data plate.</p>'}`,
    submit: async d => {
      const body = { ...d, installed_job_id: d.installed_here ? j.id : (e.installed_job_id === j.id ? null : e.installed_job_id || null) };
      delete body.installed_here;
      if (e.id) await PUT('/equipment/' + e.id, body); else await POST('/equipment', { ...body, location_id: j.location_id });
      toast('Equipment saved'); route();
    },
  });
  if (!e.id) return;
  const list = await GET(`/attachments?entity_type=equipment&entity_id=${e.id}`);
  for (const a of list) authImg(a.id).then(u => { $('#eqphotos', m.el).insertAdjacentHTML('beforeend', `<img src="${u}" alt="" style="height:48px;border-radius:6px">`); });
  $('#eqphoto', m.el).onchange = async ev => { if (!ev.target.files.length) return; await act(() => uploadFiles([...ev.target.files], { entity_type: 'equipment', entity_id: e.id }, { tag: 'panel' }), 'Photo added'); m.close(); route(); };
  if ($('#eqdel', m.el)) $('#eqdel', m.el).onclick = async () => { if (confirm('Delete this equipment record?')) { await act(() => DEL('/equipment/' + e.id)); m.close(); route(); } };
}
function customerEquipmentCard(c) {
  const rows = c.locations.flatMap(l => l.equipment.map(e => ({ ...e, address: l.address })));
  if (!rows.length) return '';
  return `<div class="card"><h2>Equipment on site</h2>${table([{ label: 'Where', key: 'address' }, { label: 'Type', get: e => equipLabel(e.type) }, { label: 'Make / model', get: e => [e.make, e.model].filter(Boolean).join(' ') },
    { label: 'Serial', key: 'serial' }, { label: 'Warranty', get: e => e.warranty_until ? fmtDate(e.warranty_until) : '' }], rows)}</div>`;
}

// ============================================================ settings: checklist templates
const _settingsExtras = settingsExtras;
settingsExtras = async function (el) { // eslint-disable-line no-func-assign
  await _settingsExtras(el);
  if (!isOffice()) return;
  if (isAdmin()) {
    const s = S.settings;
    el.insertAdjacentHTML('beforeend', `<div class="card"><h2>Field estimating</h2><p class="small muted">Lets techs build estimates on their jobs and close them on site. Inside these limits the customer can sign right away; outside them the estimate waits for office review.</p>
      <form id="fef"><div class="form-grid">
        ${fieldHtml({ name: 'tech_estimates', label: 'Techs can build estimates', type: 'checkbox', full: true }, s.tech_estimates !== '0')}
        ${fieldHtml({ name: 'tech_max_discount_pct', label: 'Max discount without review (%)', type: 'number' }, s.tech_max_discount_pct)}
        ${fieldHtml({ name: 'tech_min_margin_pct', label: 'Minimum margin without review (%)', type: 'number' }, s.tech_min_margin_pct)}
        ${fieldHtml({ name: 'tech_custom_lines', label: 'Custom (non-price-book) lines', type: 'select', options: [['review', 'Allowed — send to office review'], ['allow', 'Allowed — no review'], ['block', 'Not allowed']], blank: false, full: true }, s.tech_custom_lines)}
        ${fieldHtml({ name: 'tech_see_costs', label: 'Techs can see costs and margins (off = prices only)', type: 'checkbox', full: true }, s.tech_see_costs === '1')}
      </div><button class="btn primary" style="margin-top:10px">Save</button></form></div>`);
    $('#fef').onsubmit = async e => { e.preventDefault(); const f = e.target;
      S.settings = await act(() => PUT('/settings', { tech_estimates: f.tech_estimates.checked ? '1' : '0', tech_see_costs: f.tech_see_costs.checked ? '1' : '0',
        tech_max_discount_pct: f.tech_max_discount_pct.value, tech_min_margin_pct: f.tech_min_margin_pct.value, tech_custom_lines: f.tech_custom_lines.value }), 'Field estimating saved'); };
    el.insertAdjacentHTML('beforeend', `<div class="card"><h2>Commercial projects</h2>
      <p class="small muted">How the time clock works on jobs marked “Commercial project”. These are company defaults; you can change them per person under Team.</p>
      <form id="pjf"><div class="form-grid">
        ${fieldHtml({ name: 'project_require_cost_code', label: 'Require a cost code when clocking in on a project', type: 'checkbox', full: true }, s.project_require_cost_code !== '0')}
        ${fieldHtml({ name: 'project_clock_any', label: 'Techs can clock in on any open project (not only ones they are assigned to)', type: 'checkbox', full: true }, s.project_clock_any !== '0')}
        ${fieldHtml({ name: 'project_target_margin', label: 'Target margin % (dashboard flags projects below it)', type: 'number' }, s.project_target_margin ?? 18)}
        ${fieldHtml({ name: 'sched_hours_per_day', label: 'Schedule: hours per day', type: 'number' }, s.sched_hours_per_day ?? 8)}
        ${fieldHtml({ name: 'sched_days_per_week', label: 'Schedule: days per week', type: 'number' }, s.sched_days_per_week ?? 5)}
        ${fieldHtml({ name: 'sched_crew_availability', label: 'Schedule: crew availability factor (0–1)', type: 'number' }, s.sched_crew_availability ?? 0.92)}
        ${fieldHtml({ name: 'sched_max_crew', label: 'Schedule: max crew size (weeks above it are flagged)', type: 'number' }, s.sched_max_crew ?? 10)}
      </div><p class="small">Cost codes are under <b>Cost codes</b> on this page. To bring in the list from another system, use <a href="#/import">Import Data → Cost codes</a>.</p>
      <button class="btn primary" style="margin-top:6px">Save</button></form></div>`);
    $('#pjf').onsubmit = async e => { e.preventDefault(); const f = e.target;
      S.settings = await act(() => PUT('/settings', { project_require_cost_code: f.project_require_cost_code.checked ? '1' : '0', project_clock_any: f.project_clock_any.checked ? '1' : '0', project_target_margin: f.project_target_margin.value || '18',
        sched_hours_per_day: f.sched_hours_per_day.value || '8', sched_days_per_week: f.sched_days_per_week.value || '5', sched_crew_availability: f.sched_crew_availability.value || '0.92', sched_max_crew: f.sched_max_crew.value || '10' }), 'Project settings saved'); };
    await timeclockCard(el, s);
  }
  const ts = await GET('/form-templates?all=1');
  el.insertAdjacentHTML('beforeend', `<div class="card"><div class="row spread"><h2>Checklist templates</h2><button class="btn" id="newtpl">+ Checklist</button></div>
    <p class="small muted">Attached automatically to jobs of the listed types. "Required" checklists must be finished before a tech can complete the job.</p>
    ${table([{ label: 'Name', html: t => `<b>${esc(t.name)}</b>${t.active ? '' : ' <span class="pill">Inactive</span>'}` }, { label: 'Job types', get: t => t.job_types === '*' ? 'All jobs' : t.job_types.split(',').map(label).join(', ') },
      { label: 'Items', num: 1, get: t => t.items.length }, { label: 'Required', html: t => t.required_for_completion ? '<span class="pill warn">Required</span>' : '' }], ts, { onClick: t => templateForm(t) })}</div>`);
  $('#newtpl').onclick = () => templateForm({ items: [{ label: '', type: 'check', required: true }], job_types: '*', active: 1 });
};
function templateForm(t) {
  const row = (it = {}) => `<tr><td><input data-k="label" value="${esc(it.label || '')}" placeholder="Checklist item"></td>
    <td><select data-k="type">${[['check', 'Checkbox'], ['passfail', 'Pass / Fail / N/A'], ['text', 'Text'], ['number', 'Number']].map(([v, l]) => `<option value="${v}" ${it.type === v ? 'selected' : ''}>${l}</option>`).join('')}</select></td>
    <td style="text-align:center"><input type="checkbox" data-k="required" ${it.required ? 'checked' : ''} style="width:auto"></td><td><button type="button" class="btn sm danger" data-rmrow>✕</button></td></tr>`;
  const m = modal(`<form><h2>${t.id ? 'Edit checklist' : 'New checklist'}</h2><div class="form-grid">
      ${fieldHtml({ name: 'name', label: 'Name', required: true, full: true }, t.name)}
      ${fieldHtml({ name: 'job_types', label: 'Job types (comma list, or * for all)', full: true }, t.job_types)}
      ${fieldHtml({ name: 'required_for_completion', label: 'Required before a tech can complete the job', type: 'checkbox' }, t.required_for_completion)}${fieldHtml({ name: 'active', label: 'Active', type: 'checkbox' }, t.active)}</div>
    <div class="table-wrap" style="margin-top:10px"><table class="items"><thead><tr><th>Item</th><th>Answer</th><th>Required</th><th></th></tr></thead><tbody id="tplrows">${t.items.map(row).join('')}</tbody></table></div>
    <button type="button" class="btn" id="addrow" style="margin-top:8px">+ Item</button>
    <p class="small muted">Job types: ${JOB_TYPES.join(', ')}. Changes apply to jobs that get this checklist from now on; checklists already on jobs keep their items.</p>
    <div class="actions"><button type="button" class="btn" data-x>Cancel</button><button class="btn primary">Save</button></div></form>`, { wide: true });
  $('[data-x]', m.el).onclick = m.close;
  $('#addrow', m.el).onclick = () => $('#tplrows', m.el).insertAdjacentHTML('beforeend', row({ type: 'check', required: true }));
  $('#tplrows', m.el).addEventListener('click', e => { if (e.target.closest('[data-rmrow]')) e.target.closest('tr').remove(); });
  $('form', m.el).onsubmit = async e => {
    e.preventDefault(); const f = e.target;
    const items = $$('#tplrows tr', m.el).map(tr => ({ label: $('[data-k=label]', tr).value.trim(), type: $('[data-k=type]', tr).value, required: $('[data-k=required]', tr).checked })).filter(i => i.label);
    const body = { name: f.name.value, job_types: f.job_types.value.trim() || '*', required_for_completion: f.required_for_completion.checked ? 1 : 0, active: f.active.checked ? 1 : 0, items };
    await act(() => t.id ? PUT('/form-templates/' + t.id, body) : POST('/form-templates', body), 'Checklist saved'); m.close(); route();
  };
}

boot();

// ---------------------------------------------------------------- A4Y Time Clock sync (docs/TIMECLOCK.md)
async function timeclockCard(el, s) {
  const st = await GET('/timeclock/status');
  const last = st.last;
  el.insertAdjacentHTML('beforeend', `<div class="card"><h2>A4Y Time Clock</h2>
    <p class="small muted">Crews keep using the A4Y Time Clock. Its entries come in here by Entry ID (re-syncing never duplicates), matched to people, projects (by <b>Time clock job #</b>) and cost codes. Setup steps: <code>docs/TIMECLOCK.md</code>.</p>
    <p class="small">${st.configured ? `<span class="pill good">Connected</span> ${st.auto ? 'Syncs every hour.' : 'Automatic sync is off.'}` : '<span class="pill">Not connected</span> Paste the export link and key below, or upload a CSV.'}
      ${st.entries} entries synced.${last && last.at ? ` Last sync ${fmtDT(last.at)}: ${last.created} new, ${last.updated} changed.` : ''}</p>
    ${st.unlinked.length ? `<div class="alert" style="margin:8px 0"><b>Time clock job numbers not linked to a job yet</b> (hours are kept and attach as soon as a job gets the number under Edit → Time clock job #):
      <div class="small" style="margin-top:4px">${st.unlinked.map(u => `#${esc(u.ext_job)} · ${u.n} entries · ${num(u.hours, 1)} h`).join('<br>')}</div></div>` : ''}
    ${last && last.people_added && last.people_added.length ? `<div class="alert info" style="margin:8px 0">Added as inactive technicians (no login) so their hours count: ${last.people_added.map(esc).join(', ')}. Link or activate them under Team.</div>` : ''}
    <form id="tcf"><div class="form-grid">
      ${fieldHtml({ name: 'timeclock_url', label: 'Export link (Apps Script web app URL)', full: true, placeholder: 'https://script.google.com/macros/s/…/exec' }, s.timeclock_url)}
      ${fieldHtml({ name: 'timeclock_key', label: s.timeclock_key_set ? 'Export key (saved — leave blank to keep)' : 'Export key', type: 'password' })}
      ${fieldHtml({ name: 'timezone', label: 'Time zone of the time clock', type: 'select', options: ['America/Boise', 'America/Denver', 'America/Los_Angeles', 'America/Phoenix', 'America/Chicago', 'America/New_York'], blank: false }, s.timezone || 'America/Boise')}
      ${fieldHtml({ name: 'timeclock_auto', label: 'Sync automatically every hour', type: 'checkbox', full: true }, s.timeclock_auto !== '0')}
    </div><div class="row" style="margin-top:8px;flex-wrap:wrap"><button class="btn primary">Save</button><button type="button" class="btn" id="tcsync" ${st.configured ? '' : 'disabled'}>Sync now</button>
      <label class="btn">Upload CSV…<input type="file" id="tccsv" accept=".csv,text/csv" hidden></label></div></form></div>`);
  const report = r => {
    toast(`Time clock: ${r.created} new, ${r.updated} changed, ${r.unchanged} unchanged`);
    const notes = [];
    if (Object.keys(r.unmatched_jobs).length) notes.push(`Job numbers with no matching job yet: ${Object.entries(r.unmatched_jobs).map(([k, v]) => `#${k}${v ? ` ${v}` : ''}`).join(', ')}`);
    if (r.people_added.length) notes.push(`Added as inactive technicians: ${r.people_added.join(', ')}`);
    if (r.codes_added.length) notes.push(`New cost codes: ${r.codes_added.join(', ')}`);
    if (notes.length) alert(notes.join('\n\n'));
    route();
  };
  $('#tcf').onsubmit = async e => { e.preventDefault(); const f = e.target;
    S.settings = await act(() => PUT('/settings', { timeclock_url: f.timeclock_url.value.trim(), timeclock_key: f.timeclock_key.value, timezone: f.timezone.value, timeclock_auto: f.timeclock_auto.checked ? '1' : '0' }), 'Time clock settings saved'); route(); };
  $('#tcsync').onclick = async () => { const b = $('#tcsync'); b.disabled = true; b.textContent = 'Syncing…'; try { report(await act(() => POST('/timeclock/sync'))); } finally { b.disabled = false; b.textContent = 'Sync now'; } };
  $('#tccsv').onchange = async e => { const file = e.target.files[0]; if (!file) return; const csv = await file.text(); report(await act(() => POST('/timeclock/upload', { csv }))); };
}
