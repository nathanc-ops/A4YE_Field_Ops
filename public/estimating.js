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
  $('#view').innerHTML = setTop('Estimating', `<button class="btn" id="egc">Contractors</button><button class="btn" id="eimp">Import workbook</button><button class="btn primary" id="enew">+ New bid</button>`,
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
      { label: 'Project', html: b => `<b>${esc(b.project_name)}</b>${b.job_number ? `<br><a class="small" href="#/jobs/${b.job_id}">Job ${esc(b.job_number)}</a>` : ''}` },
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
}

function estEdit(b, d) {
  const fields = [
    { name: 'project_name', label: 'Project name', required: true, full: true },
    { name: 'bid_number', label: 'Bid #' },
    { name: 'status', label: 'Status', type: 'select', blank: false, options: d.statuses.map(s => [s.key, s.label]) },
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
  const m = formModal({ title: b ? `Bid ${b.bid_number || ''} · ${b.project_name}` : 'New bid', fields, wide: true,
    values: b || { bid_number: d.next_number, status: 'estimating' },
    extra: gcBoxes + (b ? `<p class="small muted" style="margin:8px 0 0">${b.checked_in_at ? `Notes last changed ${fmtDT(b.checked_in_at)}. ` : ''}<a href="#" id="edel" style="color:var(--bad)">Delete this bid</a></p>` : ''),
    submit: async (o, form) => {
      o.gc_ids = $$('[name=gc]:checked', form).map(x => +x.value);
      if (b) await act(() => PUT(`/estimating/bids/${b.id}`, o), 'Saved'); else await act(() => POST('/estimating/bids', o), 'Bid added');
      viewEstimating();
    } });
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
