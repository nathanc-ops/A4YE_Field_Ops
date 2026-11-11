'use strict';
// Estimating dashboard — the commercial bid log (admins and managers only).
const EST = { status: '', q: '', period: 'all' };
const EST_TONE = { estimating: 'info', waiting: 'warn', in_progress: 'accent', awarded: 'good', lost: 'bad', no_bid: '' };
const EST_ICON = { estimating: '✎', waiting: '⏳', in_progress: '↻', awarded: '✓', lost: '✕', no_bid: '–' };
const estPill = (st, lbl) => `<span class="pill ${EST_TONE[st] || ''}">${EST_ICON[st] || ''} ${esc(lbl)}</span>`;
const estDays = n => n === 0 ? 'today' : n === 1 ? 'tomorrow' : n < 0 ? `${-n} day${n === -1 ? '' : 's'} late` : `in ${n} days`;

function estPeriod(p) {
  const t = new Date(), d = n => { const x = new Date(t); x.setDate(x.getDate() - n); return localDate(x); };
  return p === 'year' ? { from: `${t.getFullYear()}-01-01` } : p === '365' ? { from: d(365) } : p === '90' ? { from: d(90) } : {};
}

// one-hue horizontal bars: label · bar · value; hover shows the detail
function estBars(rows, { value, label, fmt, title }) {
  const max = Math.max(1, ...rows.map(value));
  if (!rows.length) return '<div class="empty">Nothing yet</div>';
  return `<div class="ebars" role="list">${rows.map(r => `<div class="ebar" role="listitem" title="${esc(title ? title(r) : `${label(r)}: ${fmt(value(r))}`)}">
    <span class="ebl">${esc(label(r))}</span><span class="ebt"><span class="ebf" style="width:${Math.max(value(r) > 0 ? 1.5 : 0, value(r) / max * 100)}%"></span></span><span class="ebv">${esc(fmt(value(r)))}</span></div>`).join('')}</div>`;
}

async function viewEstimating() {
  const d = await GET('/estimating' + qs({ ...estPeriod(EST.period), today: todayStr() }));
  const T = d.totals, lbl = Object.fromEntries(d.statuses.map(s => [s.key, s.label]));
  const byId = new Map(d.bids.map(b => [b.id, b]));
  const count = st => d.bids.filter(b => b.status === st).length;
  $('#view').innerHTML = setTop('Estimating', `<button class="btn" id="etpl">Estimate templates</button><button class="btn" id="eplist">Import price list</button><button class="btn" id="egc">Contractors</button><button class="btn" id="eimp">Import workbook</button><button class="btn primary" id="enew">+ New bid</button>`,
    'Commercial bids · admins and managers only') + `
    <div class="row" style="margin-bottom:12px;gap:8px;flex-wrap:wrap">
      <select id="eper" aria-label="Period">${[['all', 'All bids'], ['year', 'This year'], ['365', 'Last 12 months'], ['90', 'Last 90 days']].map(([k, v]) => `<option value="${k}" ${EST.period === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
      <span class="small muted">Bids still being estimated always show.</span></div>
    <div class="grid g4">
      ${kpi('Bids submitted', T.submitted, `${money0(T.submitted_value)} total value`)}
      ${kpi('Awarded', money0(T.awarded_value), `${T.awarded} bid${T.awarded === 1 ? '' : 's'}`)}
      ${kpi('Waiting', money0(T.waiting_value + T.in_progress_value), `${T.waiting} waiting${T.in_progress ? ` · ${T.in_progress} in progress` : ''}`)}
      ${kpi('Win rate', T.win_rate == null ? '—' : pct(T.win_rate), T.win_rate == null ? 'no bids decided yet' : `${T.awarded} of ${T.awarded + T.lost} decided · ${pct(T.win_rate_value)} of $`)}
    </div>
    <div class="grid g2" style="margin-top:14px">
      <div class="card"><h2>Bid value</h2>
        ${estBars([['Submitted', T.submitted_value, T.submitted], ['Awarded', T.awarded_value, T.awarded], ['Waiting', T.waiting_value + T.in_progress_value, T.waiting + T.in_progress], ['Lost', T.lost_value, T.lost]],
          { label: r => r[0], value: r => r[1], fmt: money0, title: r => `${r[0]}: ${money0(r[1])} · ${r[2]} bid${r[2] === 1 ? '' : 's'}` })}
      </div>
      <div class="card"><h2>Quotes per contractor</h2>
        ${estBars(d.gcs.filter(g => g.bids).sort((a, b) => b.bids - a.bids || a.name.localeCompare(b.name)),
          { label: g => g.name, value: g => g.bids, fmt: n => String(n), title: g => `${g.name}: ${g.bids} bid${g.bids === 1 ? '' : 's'} · ${money0(g.sent_value)} quoted · ${g.awarded} awarded` })}
      </div>
    </div>
    <div class="grid g2" style="margin-top:14px">
      <div class="card"><h2>Due next</h2>${d.upcoming.length ? `<div class="elist">${d.upcoming.slice(0, 8).map(u => { const b = byId.get(u.id); return `<a href="#" data-b="${b.id}" class="eli">
        <span><b>${esc(b.project_name)}</b> <span class="muted small">${esc(b.bid_number || '')}${b.gcs.length ? ' · ' + esc(b.gcs.map(g => g.name).join(', ')) : ''}</span></span>
        <span class="pill ${u.days < 0 ? 'bad' : u.days <= 2 ? 'warn' : ''}">${u.days < 0 ? '⚠ ' : ''}${fmtDate(b.due_date)}${b.due_time ? ' ' + esc(b.due_time) : ''} · ${estDays(u.days)}</span></a>`; }).join('')}</div>` : '<div class="empty">No bids being estimated with a due date</div>'}</div>
      <div class="card"><h2>Needs a check-in</h2><p class="small muted" style="margin-top:-6px">Waiting ${d.check_in_days}+ days since it went out and since the last note.</p>
        ${d.check_in.length ? `<div class="elist">${d.check_in.map(id => { const b = byId.get(id); return `<a href="#" data-b="${b.id}" class="eli">
        <span><b>${esc(b.project_name)}</b> <span class="muted small">${money0(b.bid_value)}${b.gcs.length ? ' · ' + esc(b.gcs.map(g => g.name).join(', ')) : ''}</span></span>
        <span class="small muted">sent ${fmtDate(b.submitted_date)}</span></a>`; }).join('')}</div>` : '<div class="empty">Nothing waiting on a check-in</div>'}</div>
    </div>
    <div class="card" style="margin-top:14px">
      <div class="row spread" style="flex-wrap:wrap;gap:8px"><h2 style="margin:0">Bid log</h2><input id="eq" type="search" placeholder="Search project, bid #, contractor, notes" value="${esc(EST.q)}" style="max-width:320px"></div>
      <div class="row" id="echips" style="gap:6px;flex-wrap:wrap;margin:10px 0">
        <button class="btn sm ${EST.status ? '' : 'primary'}" data-st="">All ${d.bids.length}</button>
        ${d.statuses.map(s => `<button class="btn sm ${EST.status === s.key ? 'primary' : ''}" data-st="${s.key}">${EST_ICON[s.key]} ${esc(s.label)} ${count(s.key)}</button>`).join('')}</div>
      <div id="elog"></div>
    </div>
    <div class="card" style="margin-top:14px"><h2>By contractor</h2>
      ${table([{ label: 'Contractor', key: 'name' }, { label: 'Bids', key: 'bids', num: true }, { label: '$ quoted', get: g => money0(g.sent_value), num: true },
        { label: 'Awarded', get: g => g.awarded ? `${g.awarded} · ${money0(g.awarded_value)}` : '0', num: true }, { label: 'Lost', key: 'lost', num: true }, { label: 'Waiting', key: 'waiting', num: true },
        { label: 'Win rate', get: g => pct(g.win_rate), num: true }], d.gcs.filter(g => g.bids), { empty: 'No bids sent to a contractor yet' })}
      <p class="small muted">A bid sent to two contractors counts in both rows, so the $ quoted column adds up to more than the total bid value.</p></div>`;

  const drawLog = () => {
    const q = EST.q.toLowerCase();
    const rows = d.bids.filter(b => (!EST.status || b.status === EST.status) && (!q || [b.project_name, b.bid_number, b.notes, ...b.gcs.map(g => g.name)].some(v => String(v || '').toLowerCase().includes(q))));
    $('#elog').innerHTML = table([
      { label: 'Due', html: b => b.due_date ? esc(fmtDate(b.due_date)) : '<span class="muted">—</span>' },
      { label: 'Bid #', key: 'bid_number' },
      { label: 'Project', html: b => `<b>${esc(b.project_name)}</b>${b.job_kind ? ` <span class="small muted">${b.job_kind === 'commercial' ? 'Commercial' : 'Residential'}</span>` : ''}${b.takeoff_count ? ' <span class="pill info" title="Plan takeoffs">📐 ' + b.takeoff_count + '</span>' : ''}${b.job_number ? `<br><a class="small" href="#/jobs/${b.job_id}">Job ${esc(b.job_number)}</a>` : ''}` },
      { label: 'Contractors', html: b => esc(b.gcs.map(g => g.name).join(', ')) || '<span class="muted">—</span>' },
      { label: 'Submitted', html: b => b.submitted_date ? esc(fmtDate(b.submitted_date)) : '<span class="muted">—</span>' },
      { label: 'Value', html: b => b.bid_value != null ? money0(b.bid_value) : '<span class="muted">—</span>', num: true },
      { label: 'Status', html: b => estPill(b.status, lbl[b.status]) },
      { label: 'Check-in', html: b => `<span class="small">${esc(b.notes || '')}</span>` },
    ], rows, { onClick: b => estEdit(b, d), empty: 'No bids match', foot: ['', '', `${rows.length} bid${rows.length === 1 ? '' : 's'}`, '', '', { v: money0(rows.reduce((s, b) => s + (b.bid_value || 0), 0)), num: true }, '', ''] });
    $$('#elog tbody tr').forEach((tr, i) => tr.classList.add('est-' + rows[i].status));
  };
  drawLog();
  $('#eq').oninput = e => { EST.q = e.target.value; drawLog(); };
  $$('#echips [data-st]').forEach(b => b.onclick = () => { EST.status = b.dataset.st; $$('#echips [data-st]').forEach(x => x.classList.toggle('primary', x === b)); drawLog(); });
  $('#eper').onchange = e => { EST.period = e.target.value; viewEstimating(); };
  $$('[data-b]').forEach(a => a.onclick = e => { e.preventDefault(); estEdit(byId.get(+a.dataset.b), d); });
  $('#enew').onclick = () => estEdit(null, d);
  $('#egc').onclick = () => estGcs(d);
  $('#eimp').onclick = () => estImport();
  $('#etpl').onclick = () => takeoffTemplates();
  $('#eplist').onclick = () => priceListImport();
}

function estEdit(b, d) {
  const fields = [
    { name: 'project_name', label: 'Project name', required: true, full: true },
    { name: 'bid_number', label: 'Bid #' },
    { name: 'status', label: 'Status', type: 'select', blank: false, options: d.statuses.map(s => [s.key, s.label]) },
    { name: 'job_kind', label: 'Job type (picks the takeoff template)', type: 'select', blank: '—', options: [['commercial', 'Commercial'], ['residential', 'Residential']] },
    { name: 'due_date', label: 'Bid due date', type: 'date' },
    { name: 'due_time', label: 'Due time', placeholder: 'e.g. 2:00 PM' },
    { name: 'submitted_date', label: 'Date submitted', type: 'date' },
    { name: 'bid_value', label: 'Bid value ($)', type: 'number', step: '0.01' },
    { name: 'notes', label: 'Check-in notes (who you talked to, when, what they said)', type: 'textarea', full: true },
    { name: 'job_id', label: 'Job / project (once awarded)', type: 'job', full: true, blank: '— none —', text: b && b.job_number ? `${b.job_number} · ${b.job_title || ''}` : '' },
  ];
  const sent = new Set((b ? b.gcs : []).map(g => g.id));
  const gcBoxes = `<div class="f full"><span>Sent to (general contractors)</span><div class="egcs">${d.all_gcs.filter(g => g.active || sent.has(g.id)).map(g =>
    `<label class="check"><input type="checkbox" name="gc" value="${g.id}" ${sent.has(g.id) ? 'checked' : ''}> ${esc(g.name)}</label>`).join('') || '<span class="muted small">No contractors yet — add them under Contractors.</span>'}</div></div>`;
  const plans = `<div class="f full" style="margin-top:8px"><span>Plans — Claude does the takeoff${b && b.takeoff_count ? ` · <a href="#" id="etos">${b.takeoff_count} takeoff${b.takeoff_count === 1 ? '' : 's'} on this bid</a>` : ''}</span>
    <div id="eplans"></div>
    <span class="small muted">Optional. Pick the job type above; the takeoff runs after you save (a few minutes for a big set). You review every line before it's used.</span></div>`;
  let fc = null;
  const m = formModal({ title: b ? `Bid ${b.bid_number || ''} · ${b.project_name}` : 'New bid', fields, wide: true,
    values: b || { bid_number: d.next_number, status: 'estimating' },
    extra: gcBoxes + plans + (b ? `<p class="small muted" style="margin:8px 0 0">${b.checked_in_at ? `Notes last changed ${fmtDT(b.checked_in_at)}. ` : ''}<a href="#" id="edel" style="color:var(--bad)">Delete this bid</a></p>` : ''),
    submit: async (o, form) => {
      o.gc_ids = $$('[name=gc]:checked', form).map(x => +x.value);
      const files = fc ? fc.files() : [];
      if (files.length && !o.job_kind) throw new Error('Pick the job type (commercial or residential) for the takeoff');
      planCheck(files);
      let id = b && b.id;
      if (b) await act(() => PUT(`/estimating/bids/${b.id}`, o), 'Saved'); else id = (await act(() => POST('/estimating/bids', o), 'Bid added')).id;
      if (files.length) { const t = await startTakeoff(id, o.job_kind, files); if (t) return go('#/estimating/takeoff/' + t.id); }
      viewEstimating();
    } });
  fc = fileCollector($('#eplans', m.el));
  const tos = $('#etos', m.el); if (tos) tos.onclick = async e => { e.preventDefault(); const list = await GET(`/estimating/bids/${b.id}/takeoffs`); m.close(); if (list[0]) go('#/estimating/takeoff/' + list[0].id); };
  const del = $('#edel', m.el);
  if (del) del.onclick = async e => { e.preventDefault(); if (!confirm(`Delete ${b.project_name}?`)) return; await act(() => DEL(`/estimating/bids/${b.id}`), 'Deleted'); m.close(); viewEstimating(); };
}

function estGcs(d) {
  const m = modal(`<h2>Contractors</h2><p class="small muted">The general contractors you send bids to. Turning one off hides it on new bids; its history stays.</p>
    <div class="table-wrap"><table><tbody>${d.all_gcs.map(g => `<tr><td><input data-n="${g.id}" value="${esc(g.name)}"></td>
      <td><label class="check"><input type="checkbox" data-a="${g.id}" ${g.active ? 'checked' : ''}> Active</label></td></tr>`).join('')}</tbody></table></div>
    <form id="egadd" class="row" style="gap:8px;margin-top:10px"><input name="name" placeholder="Add a contractor"><button class="btn primary sm">Add</button></form>
    <div class="actions"><button class="btn" data-x>Done</button></div>`);
  $('[data-x]', m.el).onclick = () => { m.close(); viewEstimating(); };
  $$('[data-n]', m.el).forEach(i => i.onchange = () => act(() => PUT(`/estimating/gcs/${i.dataset.n}`, { name: i.value }), 'Saved').catch(() => null));
  $$('[data-a]', m.el).forEach(i => i.onchange = () => act(() => PUT(`/estimating/gcs/${i.dataset.a}`, { active: i.checked }), 'Saved').catch(() => null));
  $('#egadd', m.el).onsubmit = async e => { e.preventDefault(); const n = e.target.name.value.trim(); if (!n) return;
    await act(() => POST('/estimating/gcs', { name: n }), 'Added').catch(() => null); m.close(); estGcs(await GET('/estimating')); };
}

function estImport() {
  const m = modal(`<h2>Import the Estimating Dashboard workbook</h2>
    <p class="small muted">Download the workbook as .xlsx and choose it here. Reads the DATA tab only: due date, bid #, project, the contractor columns marked X, date submitted, bid value, status and check-in notes.
      Bids are matched by bid #, so importing again updates them instead of adding copies. A blank status comes in as Estimating (or Waiting if it has a submitted date).</p>
    <input type="file" id="efile" accept=".xlsx"><div id="eres" style="margin-top:10px"></div>
    <div class="actions"><button class="btn" data-x>Close</button><button class="btn primary" id="ego">Import</button></div>`);
  $('[data-x]', m.el).onclick = () => { m.close(); viewEstimating(); };
  $('#ego', m.el).onclick = async () => {
    const file = $('#efile', m.el).files[0]; if (!file) return toast('Choose the .xlsx file', true);
    const data = await new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = no; r.readAsDataURL(file); });
    const r = await act(() => POST('/estimating/import', { file: data })).catch(() => null); if (!r) return;
    $('#eres', m.el).innerHTML = `<p><b>${r.created}</b> added · <b>${r.updated}</b> updated${r.skipped ? ` · ${r.skipped} skipped` : ''} · ${r.gcs} contractors</p>${r.warnings.length ? `<ul class="small">${r.warnings.map(w => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}`;
  };
}

// ---------------------------------------------------------------- plan takeoff (Claude)
const PLAN_MAX_MB = 20, PLAN_MAX_FILES = 20;
const mb = n => n < 1048576 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1048576).toFixed(1)} MB`;
const planOk = f => /\.(pdf|png|jpe?g|webp|gif)$/i.test(f.name) || /^(application\/pdf|image\/(png|jpeg|webp|gif))$/.test(f.type);
function planListHtml(files, haveBytes = 0) {
  if (!files.length) return '';
  const total = files.reduce((s, f) => s + f.size, 0) + haveBytes;
  return `<ul style="margin:6px 0">${files.map(f => `<li>${esc(f.name)} <span class="muted">${mb(f.size)}</span>${planOk(f) ? '' : ' <span class="pill bad">not a PDF or image</span>'}</li>`).join('')}</ul>
    <span class="${total > PLAN_MAX_MB * 1048576 ? 'pill bad' : 'muted'}">${files.length} file(s), ${mb(total)} together${total > PLAN_MAX_MB * 1048576 ? ` — over the ${PLAN_MAX_MB} MB limit` : ''}</span>`;
}
// pick files in as many goes as you like (any folder), or drag them in; each pick adds to the list
function fileCollector(root, { haveCount = 0, haveBytes = 0 } = {}) {
  const files = [];
  root.innerHTML = `<div class="fdrop" tabindex="0" role="button" aria-label="Add plan files"><b>Drop plan files here</b> or <span class="btn sm">Choose files…</span>
      <div class="small muted">PDF plan sets, specifications, addenda, photos. Select several at once (Ctrl/⌘ or Shift-click), or pick again to add more from another folder.</div>
      <input type="file" multiple hidden accept="application/pdf,.pdf,image/png,image/jpeg,image/webp,image/gif"></div><div class="flist small"></div>`;
  const drop = $('.fdrop', root), inp = $('input', root), list = $('.flist', root);
  const render = () => {
    if (!files.length) { list.innerHTML = ''; return; }
    const total = files.reduce((s, f) => s + f.size, 0) + haveBytes, over = total > PLAN_MAX_MB * 1048576 || files.length + haveCount > PLAN_MAX_FILES;
    list.innerHTML = `<ul class="fl">${files.map((f, i) => `<li><span>${/pdf$/i.test(f.name) || f.type === 'application/pdf' ? '📄' : '🖼'} ${esc(f.name)} <span class="muted">${mb(f.size)}</span>${planOk(f) ? '' : ' <span class="pill bad">not a PDF or image</span>'}</span>
      <button type="button" class="btn sm" data-fx="${i}" aria-label="Remove ${esc(f.name)}">✕</button></li>`).join('')}</ul>
      <span class="${over ? 'pill bad' : 'muted'}">${files.length + haveCount} file(s), ${mb(total)} of ${PLAN_MAX_MB} MB${over ? ' — over the limit' : ''}</span>
      <button type="button" class="btn sm" data-fclear style="margin-left:6px">Clear</button>`;
    $$('[data-fx]', list).forEach(x => x.onclick = () => { files.splice(+x.dataset.fx, 1); render(); });
    $('[data-fclear]', list).onclick = () => { files.length = 0; render(); };
  };
  const add = fl => { for (const f of fl) if (!files.some(g => g.name === f.name && g.size === f.size)) files.push(f); render(); };
  drop.onclick = e => { if (e.target !== inp) inp.click(); };
  drop.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); inp.click(); } };
  inp.onchange = () => { add([...inp.files]); inp.value = ''; };
  drop.ondragover = e => { e.preventDefault(); drop.classList.add('on'); };
  drop.ondragleave = () => drop.classList.remove('on');
  drop.ondrop = e => { e.preventDefault(); drop.classList.remove('on'); add([...e.dataTransfer.files]); };
  return { files: () => files.slice(), clear: () => { files.length = 0; render(); } };
}
function planCheck(files, have = { count: 0, bytes: 0 }) {
  const badF = files.find(f => !planOk(f)); if (badF) throw new Error(`${badF.name} is not a PDF or an image`);
  if (files.length + have.count > PLAN_MAX_FILES) throw new Error(`Up to ${PLAN_MAX_FILES} files per takeoff`);
  const total = files.reduce((s, f) => s + f.size, 0) + have.bytes;
  if (total > PLAN_MAX_MB * 1048576) throw new Error(`Those files come to ${mb(total)} — the limit is ${PLAN_MAX_MB} MB together. Leave out sheets that aren't electrical.`);
}
const readFile = f => new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok({ file: r.result, filename: f.name }); r.onerror = no; r.readAsDataURL(f); });
async function startTakeoff(bidId, kind, files) {
  try { planCheck(files); } catch (e) { toast(e.message, true); return null; }
  const payload = await Promise.all(files.map(readFile));
  return act(() => POST(`/estimating/bids/${bidId}/takeoff`, { kind, files: payload }), `${files.length > 1 ? `${files.length} files` : 'Plans'} sent — Claude is doing the takeoff`).catch(() => null);
}
function planFilesCard(t, id) {
  const have = t.files || [], bytes = have.reduce((s, f) => s + (f.size || 0), 0);
  return `<div class="card"><div class="row spread" style="flex-wrap:wrap;gap:8px"><h2 style="margin:0">Plan files (${have.length})</h2><span class="small muted">${bytes ? `${mb(bytes)} of ${PLAN_MAX_MB} MB` : ''}</span></div>
    ${table([{ label: 'File', html: f => `${f.mime === 'application/pdf' ? '📄' : '🖼'} ${esc(f.filename)}` }, { label: 'Size', num: 1, get: f => f.size ? mb(f.size) : '' },
      { label: '', html: f => have.length > 1 ? `<button class="btn sm" data-frm="${f.index}" aria-label="Remove ${esc(f.filename)}">Remove</button>` : '' }], have, { empty: 'No files' })}
    <div id="toaddf" style="margin-top:10px"></div>
    <div class="row" style="gap:8px;margin-top:8px;flex-wrap:wrap"><button class="btn" id="toaddfgo">Add these files</button><button class="btn primary" id="torerun2">Run the takeoff again with all files</button></div>
    <p class="small muted">Add specifications, addenda or photos of sheets, then run it again: Claude reads every file as one set, and a later addendum overrides what it changes. Running again replaces the line edits on this takeoff.</p></div>`;
}
function wirePlanFiles(t, id) {
  const have = t.files || [], bytes = have.reduce((s, f) => s + (f.size || 0), 0);
  const box = $('#toaddf'); if (!box) return;
  const fc = fileCollector(box, { haveCount: have.length, haveBytes: bytes });
  $('#toaddfgo').onclick = async () => {
    const files = fc.files(); if (!files.length) return toast('Choose the files to add', true);
    try { planCheck(files, { count: have.length, bytes }); } catch (e) { return toast(e.message, true); }
    const payload = await Promise.all(files.map(readFile));
    await act(() => POST(`/estimating/takeoffs/${id}/files`, { files: payload }), `${files.length} file(s) added`);
    viewTakeoff(id);
  };
  $$('[data-frm]').forEach(b => b.onclick = async () => { const f = have.find(x => String(x.index) === b.dataset.frm);
    if (!confirm(`Remove ${f.filename} from this takeoff?`)) return; await act(() => DEL(`/estimating/takeoffs/${id}/files/${f.index}`), 'Removed'); viewTakeoff(id); });
  $('#torerun2').onclick = async () => { if (!confirm(`Run the takeoff again with ${have.length} file(s)? Your line edits on this takeoff are replaced.`)) return; await act(() => POST(`/estimating/takeoffs/${id}/rerun`)); viewTakeoff(id); };
}
// ---------------------------------------------------------------- estimate (A4YE quote workbook model)
const EST_SCOPES = [['distribution', 'Electrical - Distribution'], ['lighting', 'Electrical - Lighting'], ['power', 'Electrical - Power'], ['fire_alarm', 'Fire Alarm'], ['data', 'Data & Telecom'], ['demo', 'Demolition - Electrical']];
const EST_PHASES = [['P1', 'P1 Demolition'], ['P2', 'P2 Rough-In'], ['P3', 'P3 Gear & Feeders'], ['P4', 'P4 Trim/Fixtures & Devices'], ['P5', 'P5 Equipment Connections'], ['P6', 'P6 Systems'], ['P7', 'P7 Closeout']];
const estPhaseL = k => (EST_PHASES.find(p => p[0] === k) || [, k])[1];
const TO_QCOLS = ['phase_code', 'phase', 'tag', 'description', 'qty', 'unit', 'material_unit', 'neca_hours', 'factor', 'adj_hours', 'labor_unit', 'total_unit', 'ext_material', 'ext_labor', 'ext_cost', 'notes'];
// the Estimate Import sheet's columns A–P (phase code = bid # - phase - cost code), so rows paste into a project's Quote Import
function takeoffRows(t, bid) {
  const prefix = String((bid && bid.bid_number) || `T${t.id}`).replace(/[^A-Za-z0-9]/g, '').slice(0, 12) || `T${t.id}`;
  return t.lines.filter(l => l.include).map(l => ({ phase_code: `${prefix}-${l.phase}-${l.phase_code || '0000'}`, phase: estPhaseL(l.phase), tag: l.tag, description: l.description, qty: l.qty, unit: l.unit,
    material_unit: l.material_unit, neca_hours: l.hours_unit, factor: l.factor, adj_hours: l.adj_hours, labor_unit: l.labor_unit, total_unit: l.total_unit,
    ext_material: l.ext_material, ext_labor: l.ext_labor, ext_cost: l.ext_cost,
    notes: [l.notes, l.source && `Plans: ${l.source}`, l.priced_from === 'AI suggestion' ? 'AI-suggested price — check' : ''].filter(Boolean).join(' · ') }));
}
async function viewTakeoff(id) {
  const { params } = hashParams(); const tab = params.get('tab') || 'lines';
  const t = await GET('/estimating/takeoffs/' + id);
  const bids = await GET('/estimating'); const bid = bids.bids.find(b => b.id === t.bid_id) || {};
  const kindL = t.kind === 'commercial' ? 'Commercial' : 'Residential';
  const head = setTop(`Estimate · ${esc(bid.project_name || 'Bid')}`, `<a class="btn" href="#/estimating">‹ Estimating</a>${t.status === 'done' ? `<button class="btn" id="toas">Assumptions</button><button class="btn" id="toxl">Workbook (.xlsx)</button><a class="btn" href="#/estimating/proposal/${id}">Proposal letter</a>` : ''}${t.status !== 'running' ? '<button class="btn" id="torerun">Run again</button><button class="btn danger" id="todel">Delete</button>' : ''}`,
    `${esc(kindL)} · ${(t.files || []).length > 1 ? `${t.files.length} files` : esc(t.filename || '')}${bid.bid_number ? ` · Bid ${esc(bid.bid_number)}` : ''}`);
  if (t.status === 'running') {
    $('#view').innerHTML = head + `<div class="card"><h2>Claude is reading the plans…</h2><p>Started ${fmtDT(t.created_at)}. A full plan set can take several minutes; this page checks every few seconds. You can leave and come back.</p><div class="tobusy" aria-hidden="true"></div></div>`;
    return setTimeout(() => { if (location.hash.startsWith('#/estimating/takeoff/' + id)) viewTakeoff(id); }, 5000);
  }
  if (t.status === 'error') {
    $('#view').innerHTML = head + `<div class="card"><div class="alert">⚠ ${esc(t.error || 'The takeoff failed')}</div></div><div style="margin-top:14px">${planFilesCard(t, id)}</div>`;
    wirePlanFiles(t, id);
  } else {
    const T = t.totals, E = t.estimate, B = E.build;
    const flags = [T.ai_priced && `${T.ai_priced} line(s) priced from Claude's suggestion — check them`, T.unpriced && `${T.unpriced} line(s) have no price`, T.low_confidence && `${T.low_confidence} low-confidence count(s)`, T.no_code && `${T.no_code} line(s) without a cost code from your list`].filter(Boolean);
    $('#view').innerHTML = head + `
      <div class="grid g4">${kpi('Material', money0(E.subtotal.material), T.derived ? `incl. ${T.derived} EMT fitting line(s)` : '')}
        ${kpi('Field labor', money0(B.labor), `${num(E.subtotal.hours, 1)} h × ${money(E.rates.blended)}/h · factor ${num(t.assumptions.productivity, 2)}`)}
        ${kpi('Direct cost', money0(B.direct), `${E.schedule.weeks} wk at ${E.schedule.crew_size} workers`)}
        ${kpi('Total quote', money0(B.total), `O&P ${num(B.op_pct, 2)}% · contingency ${num(B.contingency_pct, 2)}%`)}</div>
      ${flags.length ? `<div class="alert" style="margin-top:12px">${flags.map(esc).join(' · ')}</div>` : ''}
      ${t.applied_at ? `<p class="small"><span class="pill good">✓ Used as the bid value ${fmtDT(t.applied_at)}</span></p>` : ''}
      <div class="tabs" style="margin-top:14px">${[['lines', `Lines (${t.lines.filter(l => !l.derived).length})`], ['estimate', 'Estimate summary'], ['notes', `RFIs & notes (${(t.questions || []).length})`], ['files', `Plans (${(t.files || []).length})`]].map(([k, l]) => `<button class="${k === tab ? 'on' : ''}" data-tt="${k}">${l}</button>`).join('')}</div>
      <div id="tobody"></div>`;
    $$('[data-tt]').forEach(b => b.onclick = () => go(`#/estimating/takeoff/${id}?tab=${b.dataset.tt}`));
    const body = $('#tobody');
    if (tab === 'estimate') body.innerHTML = estimateSummaryHtml(t);
    else if (tab === 'files') { body.innerHTML = planFilesCard(t, id); wirePlanFiles(t, id); }
    else if (tab === 'notes') body.innerHTML = `<div class="grid g2">${[['Questions for the GC (RFIs)', t.questions], ['Assumptions', t.clarifications], ['Exclusions', t.exclusions], ['Sheets reviewed', t.sheets_reviewed]]
      .map(([h, list]) => `<div class="card"><h2>${h}</h2>${(list || []).length ? `<ul>${list.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : '<div class="empty">None</div>'}</div>`).join('')}</div>
      ${(t.scope_checklist || []).length ? `<div class="card" style="margin-top:14px"><h2>Scope coverage</h2><p class="small muted">What Claude says it carried for each part of a complete bid. Check anything “not shown” against the plans before you bid.</p>
        ${table([{ label: 'Category', key: 'category' }, { label: 'Status', html: c => `<span class="pill ${c.status === 'counted' ? 'good' : c.status === 'allowance' ? 'warn' : c.status === 'excluded' ? '' : 'bad'}">${esc(label(c.status))}</span>` }, { label: 'Note', key: 'note' }], t.scope_checklist)}</div>` : ''}
      <div class="card" style="margin-top:14px"><h2>Plans basis</h2><p>${esc(t.plans_basis || '—')}</p><h2>Scope</h2><p>${esc(t.scope_summary || '—')}</p></div>`;
    else body.innerHTML = linesHtml(t);
    if (tab === 'lines') wireLines(t, id, bid);
    if (tab === 'estimate') { const cs = $('#tocrew'); if (cs) cs.onchange = async () => { await act(() => PUT('/estimating/takeoffs/' + id, { assumptions: { ...t.assumptions, crew_size: Number(cs.value) || 1 } })); viewTakeoff(id); }; }
    $('#toas').onclick = () => assumptionsModal({ title: `Assumptions for this estimate (${kindL})`, A: t.assumptions, emt: t.emt, custom: !!(t.own_assumptions && (t.own_assumptions.assumptions || t.own_assumptions.emt)),
      save: async (A, emt) => { await act(() => PUT('/estimating/takeoffs/' + id, { assumptions: A, emt }), 'Saved'); viewTakeoff(id); },
      reset: async () => { await act(() => PUT('/estimating/takeoffs/' + id, { assumptions: null, emt: null }), `Back to the ${kindL} template`); viewTakeoff(id); } });
    $('#toxl').onclick = async () => {
      const res = await fetch(`/api/estimating/takeoffs/${id}/xlsx`, { headers: { Authorization: 'Bearer ' + S.token } });
      if (!res.ok) return toast('Could not build the workbook', true);
      const a = document.createElement('a'); a.href = URL.createObjectURL(await res.blob());
      a.download = (res.headers.get('content-disposition') || '').match(/filename="([^"]+)"/)?.[1] || 'estimate.xlsx'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    };
  }
  if ($('#torerun')) $('#torerun').onclick = async () => { if (!confirm('Run the takeoff again? Your line edits are replaced.')) return; await act(() => POST(`/estimating/takeoffs/${id}/rerun`)); viewTakeoff(id); };
  if ($('#todel')) $('#todel').onclick = async () => { if (!confirm('Delete this takeoff and its PDF?')) return; await act(() => DEL('/estimating/takeoffs/' + id), 'Deleted'); go('#/estimating'); };
}
function linesHtml(t) {
  const pf = { 'price book': ['good', 'Price book'], 'AI suggestion': ['warn', 'AI price — check'], 'not priced': ['bad', 'Not priced'], edited: ['info', 'Edited'] };
  const T = t.totals;
  const rowHtml = (l, i) => l.derived ? `<tr class="derived"><td></td><td>${esc(l.phase_code)}</td><td>${esc(l.phase)}</td><td colspan="2"><span class="small">↳ ${esc(l.description)}</span><div class="small muted">${esc(l.source)}</div></td>
      <td class="num">${num(l.qty)}</td><td>${esc(l.unit)}</td><td class="num">${money(l.material_unit)}</td><td class="num">${num(l.hours_unit, 3)}</td><td class="num">${num(l.factor, 2)}</td><td class="num">${money(l.ext_cost)}</td><td><span class="pill">Auto</span></td><td></td></tr>`
    : `<tr data-i="${i}" class="${l.include ? '' : 'muted'}">
      <td><input type="checkbox" data-k="include" ${l.include ? 'checked' : ''} aria-label="Include"></td>
      <td><input data-k="phase_code" value="${esc(l.phase_code)}" style="width:58px" title="${esc(l.cost_code_name || 'Not on the cost code list')}" class="${l.cost_code_ok ? '' : 'bad'}"></td>
      <td><select data-k="phase" style="width:62px" title="${esc(estPhaseL(l.phase))}">${EST_PHASES.map(([k, lab]) => `<option value="${k}" ${k === l.phase ? 'selected' : ''} title="${esc(lab)}">${k}</option>`).join('')}</select></td>
      <td><select data-k="scope" style="width:118px">${EST_SCOPES.map(([k, lab]) => `<option value="${k}" ${k === l.scope ? 'selected' : ''}>${esc(lab.replace('Electrical - ', ''))}</option>`).join('')}</select></td>
      <td><input data-k="description" value="${esc(l.description)}" style="min-width:200px">${l.tag || l.pricebook_name ? `<div class="small muted">${[l.tag && 'Tag ' + esc(l.tag), l.pricebook_name && esc(l.pricebook_name)].filter(Boolean).join(' · ')}</div>` : ''}</td>
      <td class="num"><input data-k="qty" type="number" step="any" value="${esc(l.qty)}" style="width:70px"></td>
      <td><input data-k="unit" value="${esc(l.unit)}" style="width:44px"></td>
      <td class="num"><input data-k="material_override" type="number" step="any" placeholder="${esc(l.material_unit)}" value="${l.material_override ?? ''}" style="width:74px"></td>
      <td class="num"><input data-k="hours_override" type="number" step="any" placeholder="${esc(l.hours_unit)}" value="${l.hours_override ?? ''}" style="width:62px"></td>
      <td class="num"><label class="small" title="High repetition: the crew gets faster on many identical items"><input type="checkbox" data-k="high_repetition" ${l.high_repetition ? 'checked' : ''}> HR</label><div class="small muted">× ${num(l.factor, 2)}</div></td>
      <td class="num">${money(l.ext_cost)}</td>
      <td><span class="pill ${pf[l.priced_from][0]}">${pf[l.priced_from][1]}</span></td>
      <td><span class="pill ${l.confidence === 'low' ? 'bad' : l.confidence === 'medium' ? 'warn' : 'good'}" title="${esc([l.source && 'From ' + l.source, l.notes].filter(Boolean).join(' — '))}">${esc(l.confidence || '')}</span>${l.source ? `<div class="small muted">${esc(l.source)}</div>` : ''}</td></tr>`;
  const body = EST_SCOPES.map(([k, lab]) => {
    const idx = t.lines.map((l, i) => [l, i]).filter(([l]) => l.scope === k);
    if (!idx.length) return '';
    const sub = idx.filter(([l]) => l.include).reduce((s, [l]) => s + l.ext_cost, 0);
    return `<tr class="toscope"><td colspan="11"><b>${esc(lab)}</b></td><td colspan="2" class="num"><b>${money(sub)}</b></td></tr>` + idx.map(([l, i]) => rowHtml(l, i)).join('');
  }).join('');
  return `<div class="card"><div class="row spread" style="flex-wrap:wrap;gap:8px"><h2 style="margin:0">${esc(t.project_name || 'Takeoff')}</h2>
      <div class="row" style="gap:6px;flex-wrap:wrap"><button class="btn" id="tocopy" title="Columns A–P of the Estimate Import sheet">Copy as Estimate Import rows</button><button class="btn" id="tocsv">Download CSV</button>
      <span id="tobudgetwrap"></span><button class="btn primary" id="toapply">Use ${money0(T.sell)} as the bid value</button></div></div>
      <p class="small muted">${esc(t.scope_summary || '')}</p>
      <div class="table-wrap"><table id="toltbl"><thead><tr><th></th><th>Code</th><th>Phase</th><th>Scope</th><th>Description</th><th class="num">Qty</th><th>Unit</th><th class="num">Material/unit</th><th class="num">NECA hrs/unit</th><th class="num">Factor</th><th class="num">Ext cost</th><th>Priced from</th><th>Count</th></tr></thead>
      <tbody>${body}</tbody></table></div>
      <div class="row" style="margin-top:10px;gap:8px;flex-wrap:wrap"><button class="btn" id="toadd">+ Line</button><button class="btn primary" id="tosave">Save changes</button>
        <span class="small muted">Blank material/hours use the price book, or Claude's suggestion (greyed). Hours are NECA normal; the crew factor (${num(t.assumptions.productivity, 2)}, HR ${num(t.assumptions.high_rep, 2)}; testing and preconstruction 1.00) is applied. ↳ rows are EMT fittings worked out from conduit footage.</span></div></div>`;
}
function wireLines(t, id, bid) {
  const read = () => t.lines.map((l, i) => {
    if (l.derived) return l;
    const tr = $(`#toltbl tr[data-i="${i}"]`); const g = k => $(`[data-k="${k}"]`, tr);
    return { ...l, include: g('include').checked, phase_code: g('phase_code').value.trim(), phase: g('phase').value, scope: g('scope').value, description: g('description').value,
      qty: Number(g('qty').value) || 0, unit: g('unit').value, high_repetition: g('high_repetition').checked,
      material_override: g('material_override').value === '' ? null : Number(g('material_override').value), hours_override: g('hours_override').value === '' ? null : Number(g('hours_override').value) };
  }).filter(l => !l.derived);
  const save = () => act(() => PUT('/estimating/takeoffs/' + id, { lines: read() }), 'Saved');
  $('#tosave').onclick = async () => { await save(); viewTakeoff(id); };
  $('#toadd').onclick = async () => { const lines = read(); lines.push({ description: 'New line', qty: 1, unit: 'EA', phase_code: '', scope: 'power', phase: 'P2', include: true, added: '1', confidence: 'high', source: 'Added by estimator' });
    await act(() => PUT('/estimating/takeoffs/' + id, { lines })); viewTakeoff(id); };
  $('#toapply').onclick = async () => { await save(); const r = await act(() => POST(`/estimating/takeoffs/${id}/apply`), 'Bid value updated'); toast(`Bid value set to ${money0(r.bid_value)}`); viewTakeoff(id); };
  const tsv = () => takeoffRows(t, bid).map(r => TO_QCOLS.map(k => String(r[k] ?? '').replace(/[\t\n]/g, ' ')).join('\t')).join('\n');
  $('#tocopy').onclick = async () => { await navigator.clipboard.writeText(tsv()).then(() => toast('Copied — paste into the Estimate Import sheet (column A)'), () => toast('Copy blocked by the browser — use Download CSV', true)); };
  $('#tocsv').onclick = () => toCSV(TO_QCOLS.map(k => ({ label: label(k), key: k })), takeoffRows(t, bid), `takeoff-${(bid.bid_number || id)}.csv`);
  if (bid.job_id && bid.job_is_project) {
    $('#tobudgetwrap').innerHTML = '<button class="btn" id="tobudget">Send to project budget</button>';
    $('#tobudget').onclick = async () => {
      if (!confirm(`Replace ${bid.job_number}'s cost-code budget with this estimate (${t.totals.lines} lines)?`)) return;
      await act(() => POST(`/projects/${bid.job_id}/quote-import`, { text: tsv(), source: `Estimate ${t.filename || ''}`.trim(), mode: 'replace', skip_uncoded: true }), 'Project budget updated');
    };
  }
}
function estimateSummaryHtml(t) {
  const E = t.estimate, B = E.build, P = E.productivity, A = t.assumptions;
  const line = (l, v, cls = '') => `<tr class="${cls}"><td>${l}</td><td class="num">${v}</td></tr>`;
  const maxPh = Math.max(1, ...E.phases.map(p => p.hours));
  return `<div class="grid g2">
    <div class="card"><h2>Scope categories</h2>${table([{ label: 'Scope', key: 'label' }, { label: 'Earned hrs', num: 1, get: s => num(s.hours, 1) }, { label: 'Material', num: 1, get: s => money0(s.material) }, { label: 'Labor', num: 1, get: s => money0(s.labor) }, { label: 'Total', num: 1, get: s => money0(s.total) }],
      E.scopes.filter(s => s.lines), { foot: ['Subtotal', { v: num(E.subtotal.hours, 1), num: 1 }, { v: money0(E.subtotal.material), num: 1 }, { v: money0(E.subtotal.labor), num: 1 }, { v: money0(E.subtotal.total), num: 1 }] })}
      <h3 style="margin-top:14px">Hours by phase</h3><div class="ebars">${E.phases.map(p => `<div class="ebar" title="${esc(p.label)}: ${num(p.hours, 1)} h"><span class="ebl">${esc(p.label)}</span><span class="ebt"><span class="ebf" style="width:${p.hours / maxPh * 100}%"></span></span><span class="ebv">${num(p.hours, 1)} h</span></div>`).join('')}</div></div>
    <div class="card"><h2>Quote build-up</h2><div class="table-wrap"><table class="tobuild"><tbody>
      ${line('Material', money(B.material))}${line(`Field labor (straight time, ${money(E.rates.blended)}/h blended)`, money(B.labor))}
      ${line(`Per diem${A.per_diem ? ` (${money(A.per_diem)}/worker/day, ${num(E.rates.travelled * 100, 1)}% travelled)` : ' (none)'}`, money(B.per_diem))}
      ${B.indirects.filter(x => x.value).map(x => line(`<span class="small muted">· ${esc(x.label)}</span>`, `<span class="small">${money(x.value)}</span>`)).join('')}
      ${line('Field indirects', money(B.indirects_total))}${line(`Project management (${num(B.pm_hours, 1)} h × ${money(A.pm_rate)})`, money(B.pm))}
      ${line('<b>Direct cost subtotal</b>', `<b>${money(B.direct)}</b>`, 'tot')}${line(`Design contingency (${num(B.contingency_pct, 2)}%)`, money(B.contingency))}
      ${line(`Overhead & profit (${num(B.op_pct, 2)}%)`, money(B.op))}${line(`Sales tax on material (${num(B.tax_pct, 2)}%)`, money(B.tax))}
      ${line('<b>TOTAL QUOTE — BASE (5 × 8)</b>', `<b>${money(B.total)}</b>`, 'tot')}</tbody></table></div></div>
    <div class="card"><h2>Schedule & crew</h2>
      <label class="f" style="max-width:220px"><span>Crew size (workers)</span><input id="tocrew" type="number" min="1" step="1" value="${esc(A.crew_size)}"></label>
      <p>${E.schedule.weeks} week(s) at ${A.days_week} × ${A.hours_day}, ${num(A.availability * 100, 0)}% availability · ${num(E.schedule.man_days, 1)} field man-days · ${E.schedule.net_days} working days.</p>
      <h3>Schedule options (same duration)</h3>${table([{ label: 'Option', key: 'label' }, { label: 'Paid hrs', num: 1, get: o => num(o.paid_hours, 0) }, { label: 'OT hrs', num: 1, get: o => num(o.ot_hours, 0) }, { label: 'Crew', num: 1, key: 'crew' },
        { label: 'Total', num: 1, get: o => money0(o.total) }, { label: 'vs base', num: 1, html: o => o.add == null ? '<span class="pill">Base</span>' : `<span class="pill ${o.add > 0 ? 'warn' : 'good'}">${o.add > 0 ? '+' : ''}${money0(o.add)}</span>` }], E.options)}</div>
    ${whyLowHtml(t)}
    <div class="card"><h2>Labor productivity — the bet</h2>
      <p class="small muted">Hours are bid at ${num(A.productivity, 2)} × NECA normal. If the crew only performs at NECA normal:</p>
      <div class="table-wrap"><table class="tobuild"><tbody>${line('Hours at NECA normal', num(P.neca_hours, 1))}${line('Hours as bid', num(P.bid_hours, 1))}${line('Hours removed by the productivity factor', num(P.removed, 1))}
      ${line('Downside exposure, marked up', money(P.exposure))}${line('Share of the quote', P.exposure_share == null ? '—' : pct(P.exposure_share * 100))}
      ${line('O&P left if the full downside happens', `<span class="${P.op_left < 0 ? 'bad' : ''}">${money(P.op_left)}</span>`)}</tbody></table></div></div>
  </div>`;
}
// what each thing that pulls the number down is worth, so a low takeoff can be traced
function whyLowHtml(t) {
  const C = t.estimate.checks || {}, A = t.assumptions, cov = (t.scope_checklist || []).filter(c => c.status === 'not_shown');
  const rows = [
    C.productivity_factor < 1 && [`Labor is bid at ${num(C.productivity_factor, 2)} × NECA normal`, `${money0(C.productivity_cost)} less than at NECA normal, marked up`, 'Assumptions → productivity factor 1.00 bids NECA normal'],
    C.no_material && [`${C.no_material} line(s) carry no material`, (C.no_material_lines || []).slice(0, 4).join('; ') + (C.no_material > 4 ? '…' : ''), 'Type a material/unit on the Lines tab, or run again (Claude now prices every line)'],
    C.no_hours && [`${C.no_hours} line(s) carry no labor`, (C.no_hours_lines || []).slice(0, 4).join('; ') + (C.no_hours > 4 ? '…' : ''), 'Type hrs/unit on the Lines tab'],
    cov.length && [`${cov.length} scope categor${cov.length === 1 ? 'y' : 'ies'} not found on the plans`, cov.map(c => c.category).join(', '), 'RFIs & notes → Scope coverage; add lines or allowances'],
    C.low_confidence && [`${C.low_confidence} low-confidence count(s)`, `${money0(C.low_confidence_value)} of the bid rests on them`, 'Check the counts against the sheets'],
    [`Labor cost rate ${money(C.blended_rate)}/h`, `${C.burdened_note}; overhead & profit (${num(A.op_pct, 2)}%) and contingency are added after`, 'Assumptions → crew wages and burden'],
  ].filter(Boolean);
  return `<div class="card"><h2>Why this price may be low</h2><p class="small muted">The things that most often make a takeoff come in under a hand estimate, and what each is worth here.</p>
    <div class="table-wrap"><table class="tobuild"><tbody>${rows.map(([a, b, c]) => `<tr><td><b>${esc(a)}</b><div class="small muted">${esc(b)}</div></td><td class="small">${esc(c)}</td></tr>`).join('')}</tbody></table></div></div>`;
}
// Cover & Assumptions editor: used for a job type's template and for one estimate
function assumptionsModal({ title, A, emt, instructions, effort, save, reset, custom }) {
  const n = (name, lab, v, step = 'any') => `<label class="f"><span>${lab}</span><input name="${name}" type="number" step="${step}" value="${esc(v)}"></label>`;
  const crewRow = (c, i) => `<tr data-c="${i}"><td><input data-ck="cls" value="${esc(c.cls)}"></td><td><input data-ck="base" type="number" step="any" value="${esc(c.base)}" style="width:80px"></td>
    <td><input data-ck="mix" type="number" step="any" value="${esc(c.mix)}" style="width:70px"></td><td><input data-ck="local" type="number" step="any" value="${esc(c.local)}" style="width:70px"></td><td><button type="button" class="btn sm" data-crm="${i}" aria-label="Remove">✕</button></td></tr>`;
  const m = modal(`<h2>${esc(title)}</h2>${custom ? '<p class="small"><span class="pill info">Changed for this estimate</span></p>' : ''}
    <form id="asf">
      <h3>Crew (market rates by classification)</h3>
      <div class="table-wrap"><table id="ascrew"><thead><tr><th>Classification</th><th>Base $/hr</th><th>Crew mix %</th><th>Local hire %</th><th></th></tr></thead><tbody>${A.crew.map(crewRow).join('')}</tbody></table></div>
      <button type="button" class="btn sm" id="asadd">+ Classification</button>
      <div class="form-grid" style="margin-top:10px">${n('burden', 'Labor burden factor', A.burden)}${n('productivity', 'Crew productivity factor (1.00 = NECA normal)', A.productivity)}${n('high_rep', 'High-repetition factor', A.high_rep)}</div>
      <h3>Schedule</h3><div class="form-grid">${n('crew_size', 'Crew size (workers)', A.crew_size, 1)}${n('days_week', 'Work days / week', A.days_week, 1)}${n('hours_day', 'Hours / day', A.hours_day)}${n('availability', 'Availability factor', A.availability)}${n('holidays', 'Holidays in the window', A.holidays, 1)}</div>
      <h3>Overtime</h3><div class="form-grid">${n('ot_after', 'Overtime after (hrs/week)', A.ot_after)}${n('ot_mult', 'Overtime multiplier', A.ot_mult)}${n('ot_burden', 'Variable burden on the premium', A.ot_burden)}${n('eff_5x12', 'Efficiency at 5 × 12', A.eff_5x12)}${n('eff_6x10', 'Efficiency at 6 × 10', A.eff_6x10)}</div>
      <h3>Per diem & project management</h3><div class="form-grid">${n('per_diem', 'Per diem $/worker/day (travelled)', A.per_diem)}${n('pm_rate', 'PM rate $/hr', A.pm_rate)}${n('pm_hours_week', 'PM hours / week', A.pm_hours_week)}</div>
      <h3>Field indirects</h3><div class="form-grid">${n('small_tools_pct', 'Small tools % (material + labor)', A.small_tools_pct)}${n('trucks', 'Service trucks', A.trucks)}${n('truck_week', '$ / truck / week', A.truck_week)}
        ${n('scissor_lifts', 'Scissor lifts', A.scissor_lifts)}${n('scissor_week', '$ / scissor / week', A.scissor_week)}${n('booms', 'Boom lifts', A.booms)}${n('boom_week', '$ / boom / week', A.boom_week)}
        ${n('conex_week', 'Conex / trailer $ / week', A.conex_week)}${n('safety_pct', 'Safety % of labor', A.safety_pct)}${n('mob_equip_pct', 'Mobilization – equipment %', A.mob_equip_pct)}${n('mob_crew_pct', 'Mobilization – crew travel %', A.mob_crew_pct)}</div>
      <h3>Markups</h3><div class="form-grid">${n('contingency_pct', 'Design contingency %', A.contingency_pct)}${n('op_pct', 'Overhead & profit %', A.op_pct)}${n('tax_pct', 'Sales tax on material %', A.tax_pct)}</div>
      <h3>EMT fittings from footage</h3><div class="form-grid"><label class="check"><input type="checkbox" name="emt_derive" ${emt.derive ? 'checked' : ''}> Add couplings, connectors and straps automatically</label>
        ${n('emt_couplings_per_100', 'Couplings per 100 LF', emt.couplings_per_100)}${n('emt_connectors_per_100', 'Connectors per 100 LF', emt.connectors_per_100)}${n('emt_straps_per_100', 'Straps per 100 LF', emt.straps_per_100)}${n('emt_locknuts_per_connector', 'Locknuts per connector', emt.locknuts_per_connector)}
        <label class="f"><span>Fitting type</span><select name="emt_fitting"><option value="SS" ${emt.fitting === 'SS' ? 'selected' : ''}>Set screw (dry interior)</option><option value="COMP" ${emt.fitting === 'COMP' ? 'selected' : ''}>Compression, raintight</option></select></label></div>
      ${instructions != null ? `<h3>What Claude counts for this job type</h3><textarea name="instructions" rows="6" style="width:100%">${esc(instructions)}</textarea>
        <label class="f" style="max-width:360px;margin-top:8px"><span>How hard Claude works on the takeoff</span><select name="effort">${[['high', 'High — faster, cheaper'], ['xhigh', 'Extra high (default)'], ['max', 'Max — slowest, most thorough, costs the most']].map(([v, l]) => `<option value="${v}" ${v === (effort || 'xhigh') ? 'selected' : ''}>${l}</option>`).join('')}</select></label>` : ''}
      <div class="actions">${reset ? '<button type="button" class="btn" id="asreset">Use the template</button>' : ''}<button type="button" class="btn" data-x>Cancel</button><button class="btn primary">Save</button></div></form>`, { wide: true });
  $('[data-x]', m.el).onclick = m.close;
  const wireCrew = () => $$('[data-crm]', m.el).forEach(b => b.onclick = () => { b.closest('tr').remove(); });
  wireCrew();
  $('#asadd', m.el).onclick = () => { const tb = $('#ascrew tbody', m.el); tb.insertAdjacentHTML('beforeend', crewRow({ cls: '', base: 0, mix: 0, local: 0 }, tb.children.length)); wireCrew(); };
  if (reset) $('#asreset', m.el).onclick = async () => { m.close(); await reset(); };
  $('#asf', m.el).onsubmit = async e => {
    e.preventDefault(); const f = e.target;
    const out = { crew: $$('#ascrew tbody tr', m.el).map(tr => Object.fromEntries(['cls', 'base', 'mix', 'local'].map(k => [k, $(`[data-ck="${k}"]`, tr).value]))).filter(c => c.cls || Number(c.mix)) };
    for (const el of f.elements) if (el.name && el.type === 'number' && !el.name.startsWith('emt_')) out[el.name] = el.value;
    const mix = out.crew.reduce((s, c) => s + (Number(c.mix) || 0), 0);
    if (Math.abs(mix - 100) > 0.5 && !confirm(`The crew mix adds up to ${num(mix, 1)}%, not 100%. Rates are weighted by the mix either way. Save anyway?`)) return;
    const e2 = { derive: f.emt_derive.checked, fitting: f.emt_fitting.value, couplings_per_100: f.emt_couplings_per_100.value, connectors_per_100: f.emt_connectors_per_100.value,
      straps_per_100: f.emt_straps_per_100.value, locknuts_per_connector: f.emt_locknuts_per_connector.value };
    await save(out, e2, f.instructions ? f.instructions.value : undefined, f.effort ? f.effort.value : undefined); m.close();
  };
}
async function takeoffTemplates() {
  const s = await GET('/estimating/takeoff-settings');
  const m = modal(`<h2>Estimate templates</h2>
    ${s.configured ? '<p class="small"><span class="pill good">Anthropic key saved</span> Takeoffs run on ' + esc(s.model) + '.</p>' : '<div class="alert">No Anthropic API key yet. An admin adds it in Settings → Integrations → Plan takeoff.</div>'}
    <p class="small muted">Each job type carries the quote workbook's Cover & Assumptions: crew mix and rates, productivity, overtime, per diem, indirects and markups. Every new estimate starts from these; you can change them per estimate.</p>
    <div class="row" style="gap:8px">${['commercial', 'residential'].map(k => { const tpl = s.templates[k]; return `<button class="btn" data-tk="${k}">${esc(tpl.label)} · ${money(blendRate(tpl.assumptions))}/h · O&P ${num(tpl.assumptions.op_pct, 2)}%</button>`; }).join('')}</div>
    <div class="actions"><button class="btn" data-x>Close</button></div>`);
  $('[data-x]', m.el).onclick = m.close;
  $$('[data-tk]', m.el).forEach(b => b.onclick = () => { const k = b.dataset.tk, tpl = s.templates[k]; m.close();
    assumptionsModal({ title: `${tpl.label} template`, A: tpl.assumptions, emt: tpl.emt, instructions: tpl.instructions, effort: tpl.effort,
      save: async (A, emt, instructions, effort) => { await act(() => PUT('/estimating/takeoff-settings', { templates: { [k]: { assumptions: A, emt, instructions, effort } } }), 'Template saved'); } }); });
}
const blendRate = A => { const mix = A.crew.reduce((s, c) => s + c.mix, 0) || 1; return A.crew.reduce((s, c) => s + c.base * A.burden * c.mix, 0) / mix; };
async function priceListImport() {
  const vendors = await GET('/vendors');
  const m = modal(`<h2>Import a price list</h2>
    <p class="small muted">An .xlsx with a tab whose header row has <b>Key</b>, <b>Description</b>, <b>Unit</b> and <b>Material $/Unit</b> (the EMT Conduit Pricing workbook's “EMT Price List” tab works as-is). NECA Hrs/Unit, the cost code and the vendor item # come along when present.
      Items are matched to the price book by Key, so re-importing updates prices. An old .xls has to be saved as .xlsx first.</p>
    <div class="form-grid"><label class="f"><span>Vendor these prices are from</span><select id="plv"><option value="">—</option>${vendors.filter(v => v.active).map(v => `<option value="${v.id}">${esc(v.name)}</option>`).join('')}</select></label>
      <label class="f"><span>Workbook (.xlsx)</span><input type="file" id="plf" accept=".xlsx"></label></div><div id="plres"></div>
    <div class="actions"><button class="btn" data-x>Close</button><button class="btn primary" id="plgo">Import</button></div>`);
  $('[data-x]', m.el).onclick = m.close;
  $('#plgo', m.el).onclick = async () => {
    const file = $('#plf', m.el).files[0]; if (!file) return toast('Choose the .xlsx file', true);
    const data = await new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = no; r.readAsDataURL(file); });
    const r = await act(() => POST('/estimating/price-list', { file: data, vendor_id: $('#plv', m.el).value || null })).catch(() => null); if (!r) return;
    $('#plres', m.el).innerHTML = `<p><b>${r.created}</b> added · <b>${r.updated}</b> updated${r.skipped ? ` · ${r.skipped} skipped` : ''} · from ${r.sheets.map(esc).join(', ')}</p>${r.warnings.length ? `<ul class="small">${r.warnings.slice(0, 20).map(w => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
      <p class="small muted">Check the labor hours before bidding: a price list's NECA hours may be defaults, not verified against your jobs.</p>`;
  };
}

// ---------------------------------------------------------------- proposal letter
const PROP_SCOPE = { distribution: 'Distribution', lighting: 'Lighting', power: 'Power', fire_alarm: 'Fire Alarm', data: 'Data & Telecom', demo: 'Demolition' };
function proposalFromTakeoff(p) {
  const T = p.takeoff, gc = p.gcs[0] || '', project = (p.bid && p.bid.project_name) || T.project_name || 'the project';
  const scopes = EST_SCOPES.map(([k]) => k).filter(k => T.lines.some(l => l.scope === k));
  return {
    date: new Date().toLocaleDateString('en-US'), re: `${project} – Electrical Proposal`, gc, greeting: 'Hello,',
    intro: `Thank you for the opportunity to provide ${gc || 'you'} with a pricing proposal for the ${project}.${T.scope_summary ? ' ' + T.scope_summary : ''}`,
    basis: T.plans_basis ? `This proposal is based on ${T.plans_basis.replace(/\.$/, '')}. No addenda had been received at the time of this proposal.` : '',
    pricing: T.tax_pct > 0 ? 'Our base bid is shown below. It includes Idaho sales tax on materials.' : 'Our base bid is shown below.',
    bids: [{ label: 'ELECTRICAL BASE BID', amount: Math.round(T.total * 100) / 100 }], credit: null,
    validity: 'Pricing is valid for 30 days from submission.',
    closing: `Our team at ${p.company.name || 'our company'} remains committed to delivering high-quality workmanship, adhering to project timelines, and ensuring all installations meet code and project requirements.`,
    sections: scopes.map(k => ({ title: PROP_SCOPE[k], note: '', rows: T.lines.filter(l => l.scope === k).map(l => ({ tag: l.tag || '—', description: l.description, qty: l.qty, unit: l.unit })) })),
    conditions: [...p.defaults.conditions], exclusions: [...new Set([...(T.exclusions || []), ...p.defaults.exclusions])], clarifications: [...(T.clarifications || [])], qualifications: [...p.defaults.qualifications],
  };
}
async function viewProposal(id) {
  const p = await GET(`/estimating/takeoffs/${id}/proposal`);
  let d = p.draft || proposalFromTakeoff(p);
  const C = p.company;
  const lh = () => `<div class="pl-head"><div><div class="pl-co">${esc(C.name || '')}</div>${(C.address || '').split(/\n|,\s*(?=[A-Z][a-z]+,?\s+[A-Z]{2}\b)/).map(x => `<div>${esc(x)}</div>`).join('')}${C.phone ? `<div>${esc(C.phone)}</div>` : ''}${C.website ? `<div><u>${esc(C.website)}</u></div>` : ''}<div>${esc(d.date)}</div></div>
    ${C.logo ? `<img src="${esc(C.logo)}" alt="" class="pl-logo">` : ''}</div>`;
  const list = a => (a || []).filter(Boolean).length ? `<ul>${a.filter(Boolean).map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : '';
  const preview = () => `<div class="pl-page">${lh()}
      <p>Re: &nbsp;${esc(d.re)}</p><p>${esc(d.greeting)}</p>${[d.intro, d.basis, d.pricing].filter(Boolean).map(x => `<p>${esc(x)}</p>`).join('')}
      ${d.bids.map(b => `<div class="pl-bid">${esc(b.label)}: ${money(b.amount)}</div>`).join('')}
      ${d.credit && d.credit.amount ? `<div class="pl-bid sm">${esc(d.credit.label || 'Credit')}: (${money(Math.abs(d.credit.amount))})</div>` : ''}
      <p>${esc(d.validity)}</p><p>${esc(d.closing)}</p></div>
    <div class="pl-page pl-break">${lh()}<h2>Inclusions</h2>
      ${d.sections.map((s, i) => `<h3>${i + 1}. ${esc(s.title)}</h3>${s.note ? `<p class="pl-note">${esc(s.note)}</p>` : ''}
        <table class="pl-tbl"><thead><tr><th>Tag</th><th>Description</th><th>Qty</th><th>Unit</th></tr></thead><tbody>${s.rows.map(r => `<tr><td>${esc(r.tag)}</td><td>${esc(r.description)}</td><td>${esc(Number(r.qty).toLocaleString('en-US'))}</td><td>${esc(r.unit)}</td></tr>`).join('')}</tbody></table>`).join('')}
      ${d.conditions.filter(Boolean).length ? `<h2>General Conditions & Clarifications</h2>${list(d.conditions)}` : ''}
      ${d.exclusions.filter(Boolean).length ? `<h2>Exclusions</h2>${list(d.exclusions)}` : ''}
      ${d.clarifications.filter(Boolean).length ? `<h2>Clarifications & Assumptions</h2>${list(d.clarifications)}` : ''}
      ${d.qualifications.filter(Boolean).length ? `<h2>Proposal Qualifications</h2>${list(d.qualifications)}` : ''}</div>`;
  const ta = (k, rows = 3) => `<textarea data-pk="${k}" rows="${rows}">${esc(d[k] || '')}</textarea>`;
  const lines = k => `<textarea data-pl="${k}" rows="5" title="One per line">${esc((d[k] || []).join('\n'))}</textarea>`;
  $('#view').innerHTML = setTop('Proposal letter', `<a class="btn" href="#/estimating/takeoff/${id}">‹ Estimate</a><button class="btn" id="plreset">Rebuild from estimate</button><button class="btn" id="plsave">Save draft</button><button class="btn primary" onclick="print()">Print / Save as PDF</button>`,
    `${esc(p.bid.project_name || '')}${p.gcs.length ? ' · to ' + esc(p.gcs.join(', ')) : ''}`) + `
    <div class="pl-wrap"><div class="card no-print pl-edit">
      <div class="form-grid"><label class="f"><span>Date</span><input data-pk="date" value="${esc(d.date)}"></label><label class="f"><span>Greeting</span><input data-pk="greeting" value="${esc(d.greeting)}"></label>
        <label class="f full"><span>Re:</span><input data-pk="re" value="${esc(d.re)}"></label></div>
      <label class="f full"><span>Opening</span>${ta('intro', 4)}</label><label class="f full"><span>Plans basis</span>${ta('basis', 3)}</label><label class="f full"><span>Pricing sentence</span>${ta('pricing', 2)}</label>
      <h3>Bid amounts</h3><div id="plbids">${d.bids.map((b, i) => `<div class="row" style="gap:6px;margin-bottom:6px"><input data-bl="${i}" value="${esc(b.label)}" style="flex:1"><input data-ba="${i}" type="number" step="0.01" value="${esc(b.amount)}" style="width:140px"><button type="button" class="btn sm" data-brm="${i}" aria-label="Remove">✕</button></div>`).join('')}</div>
      <div class="row" style="gap:6px"><button type="button" class="btn sm" id="pladdbid">+ Base bid</button><label class="small">Award credit <input id="plcredit" type="number" step="0.01" value="${esc(d.credit ? d.credit.amount : '')}" style="width:120px" placeholder="none"></label></div>
      <label class="f full"><span>Validity</span>${ta('validity', 1)}</label><label class="f full"><span>Closing</span>${ta('closing', 3)}</label>
      <h3>Inclusions</h3><p class="small muted">One row per line: Tag | Description | Qty | Unit</p>
      ${d.sections.map((s, i) => `<div class="pl-sec"><input data-st="${i}" value="${esc(s.title)}"><input data-sn="${i}" value="${esc(s.note)}" placeholder="Note under the heading (sheets, details)"><textarea data-sr="${i}" rows="5">${esc(s.rows.map(r => [r.tag, r.description, r.qty, r.unit].join(' | ')).join('\n'))}</textarea></div>`).join('')}
      <h3>Lists (one per line)</h3>
      <label class="f full"><span>General conditions & clarifications</span>${lines('conditions')}</label><label class="f full"><span>Exclusions</span>${lines('exclusions')}</label>
      <label class="f full"><span>Clarifications & assumptions</span>${lines('clarifications')}</label><label class="f full"><span>Proposal qualifications</span>${lines('qualifications')}</label>
      <label class="check"><input type="checkbox" id="pldef"> Save the conditions, exclusions and qualifications as my standard lists</label>
      ${(p.takeoff.questions || []).length ? `<div class="alert info" style="margin-top:10px"><b>Open RFIs from the takeoff</b> (not printed): <ul>${p.takeoff.questions.map(q => `<li>${esc(q)}</li>`).join('')}</ul></div>` : ''}
    </div><div class="pl-doc" id="pldoc">${preview()}</div></div>`;
  const read = () => {
    const v = k => { const el = $(`[data-pk="${k}"]`); return el ? el.value : d[k]; };
    const L = k => $(`[data-pl="${k}"]`).value.split('\n').map(x => x.trim()).filter(Boolean);
    const credit = $('#plcredit').value;
    return { ...d, ...Object.fromEntries(['date', 're', 'greeting', 'intro', 'basis', 'pricing', 'validity', 'closing'].map(k => [k, v(k)])),
      bids: $$('[data-bl]').map(el => ({ label: el.value, amount: Number($(`[data-ba="${el.dataset.bl}"]`).value) || 0 })),
      credit: credit ? { label: 'Combined Award Credit', amount: Number(credit) } : null,
      sections: d.sections.map((s, i) => ({ title: $(`[data-st="${i}"]`).value, note: $(`[data-sn="${i}"]`).value,
        rows: $(`[data-sr="${i}"]`).value.split('\n').filter(x => x.trim()).map(x => { const [tag, description, qty, unit] = x.split('|').map(y => (y || '').trim()); return { tag, description, qty: Number(String(qty).replace(/,/g, '')) || qty || '', unit }; }) })),
      conditions: L('conditions'), exclusions: L('exclusions'), clarifications: L('clarifications'), qualifications: L('qualifications') };
  };
  const refresh = () => { d = read(); $('#pldoc').innerHTML = preview(); };
  $$('.pl-edit input, .pl-edit textarea').forEach(el => el.addEventListener('input', refresh));
  $('#pladdbid').onclick = () => { d = read(); d.bids.push({ label: 'ALTERNATE', amount: 0 }); viewProposalDraft(id, d); };
  $$('[data-brm]').forEach(b => b.onclick = () => { d = read(); d.bids.splice(+b.dataset.brm, 1); viewProposalDraft(id, d); });
  $('#plsave').onclick = async () => { d = read(); const save_defaults = $('#pldef').checked;
    await act(() => PUT(`/estimating/takeoffs/${id}/proposal`, { draft: { ...d, std_conditions: d.conditions, std_exclusions: d.exclusions, std_qualifications: d.qualifications }, save_defaults }), save_defaults ? 'Saved, and the lists are now your standard' : 'Draft saved'); };
  $('#plreset').onclick = async () => { if (!confirm('Rebuild the letter from the estimate? Your edits to this draft are lost.')) return; await act(() => PUT(`/estimating/takeoffs/${id}/proposal`, { draft: null })); viewProposal(id); };
}
// re-render the editor with an unsaved draft (adding or removing a bid line)
async function viewProposalDraft(id, d) { await act(() => PUT(`/estimating/takeoffs/${id}/proposal`, { draft: d })); viewProposal(id); }
