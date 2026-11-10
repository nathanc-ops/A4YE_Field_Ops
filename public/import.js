'use strict';
/* Admin → Import Data: bring customers, jobs, estimates, invoices, notes, materials, accounting
   and photos over from the old system. CSV in, column matching, test run, import, undo. */

NAV.splice(NAV.findIndex(n => n.href === '#/settings'), 0, { href: '#/import', label: 'Import Data', icon: '📥', roles: ['admin'] });
ROUTES.push([/^\/import$/, () => viewImport()]);

const IMPORT_ORDER = [
  ['accounts', 'Set up your books'], ['opening_balances', 'Set up your books'],
  ['customers', 'People'], ['vendors', 'People'],
  ['cost_codes', 'Materials'], ['pricebook', 'Materials'],
  ['jobs', 'Work history'], ['estimates', 'Work history'], ['invoices', 'Work history'], ['notes', 'Work history'], ['job_materials', 'Work history'],
  ['journal', 'Accounting history'],
];
const IMP = { types: null };

async function viewImport() {
  if (!isAdmin()) { $('#view').innerHTML = '<div class="alert">Only an admin can import data.</div>'; return; }
  IMP.types = IMP.types || await GET('/import/types');
  const batches = await GET('/import/batches');
  const byKey = Object.fromEntries(IMP.types.map(t => [t.key, t]));
  const groups = [...new Set(IMPORT_ORDER.map(([, g]) => g))];
  let n = 0;
  const tile = t => `<div class="card imp-tile"><div class="row spread"><h3 style="margin:0">${++n}. ${esc(t.label)}</h3></div>
      <p class="small muted" style="margin:6px 0 10px">${esc(t.note)}</p>
      <div class="row"><button class="btn primary" data-imp="${t.key}">Import file…</button><button class="btn" data-tpl="${t.key}">Template</button></div></div>`;
  $('#view').innerHTML = setTop('Import Data', '', 'Bring your records over from ServiceTitan, Successware, Housecall, QuickBooks or a spreadsheet.') + `
    <div class="alert info" style="margin-bottom:14px"><b>How it works:</b> export each list from the old system as a <b>CSV file</b> (in Excel: File → Save As → CSV).
      Pick it here, check that the columns lined up, then <b>Test run</b>: it shows exactly what would be added and which rows have problems, without changing anything.
      <b>Import</b> when it looks right. Every import can be undone from the history below until its records are used.
      <br><b>Do them in order</b>: jobs, estimates, invoices, notes, materials and photos find their customer and job by the numbers in earlier files.</div>
    <div id="wizard"></div>
    ${groups.map(g => `<h2 style="margin:18px 0 8px">${esc(g)}</h2><div class="grid g3">${IMPORT_ORDER.filter(([, gg]) => gg === g).map(([k]) => byKey[k] ? tile(byKey[k]) : '').join('')}</div>`).join('')}
    <h2 style="margin:18px 0 8px">Photos & files</h2>
    <div class="grid g3"><div class="card imp-tile"><h3 style="margin:0">${++n}. Job photos</h3>
      <p class="small muted" style="margin:6px 0 10px">Pick a folder (or files). Each photo goes on the job whose number is in its folder or file name, e.g. <code>5001/panel.jpg</code> or <code>5001 - Smith_before.jpg</code>. A folder named after a customer puts photos on their address. JPEG, PNG, WEBP, HEIC, PDF up to 10 MB each.</p>
      <div class="row"><button class="btn primary" id="ph-folder">Choose folder…</button><button class="btn" id="ph-files">Choose files…</button></div>
      <input type="file" id="ph-in-folder" webkitdirectory multiple hidden><input type="file" id="ph-in-files" multiple accept="image/*,.heic,.pdf" hidden></div></div>
    <div class="card" style="margin-top:18px"><h2>Import history</h2>
      ${table([
        { label: 'When', get: b => fmtDT(b.created_at) }, { label: 'What', get: b => b.type === 'photos' ? 'Photos' : (byKey[b.type] || {}).label || b.type },
        { label: 'File', key: 'filename' }, { label: 'Added', num: 1, key: 'created_count' }, { label: 'Updated', num: 1, key: 'updated_count' }, { label: 'Skipped', num: 1, key: 'skipped_count' },
        { label: 'By', key: 'user_name' },
        { label: '', html: b => `${b.warnings.length ? `<button class="btn sm" data-notes="${b.id}">Notes (${b.warnings.length})</button>` : ''}
          ${b.undone_at ? `<span class="pill">Undone ${esc(fmtDate(b.undone_at.slice(0, 10)))}</span>` : b.created_count ? `<button class="btn sm" data-undo="${b.id}">Undo</button>` : ''}` },
      ], batches, { empty: 'Nothing imported yet' })}
      <p class="small muted">Undo removes what an import added. Changes it made to records that already existed (filled-in phone numbers, updated prices) stay.</p></div>`;

  $$('[data-imp]').forEach(b => b.onclick = () => startImport(byKey[b.dataset.imp]));
  $$('[data-tpl]').forEach(b => b.onclick = () => {
    const t = byKey[b.dataset.tpl];
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([t.fields.map(f => `"${f.label}"`).join(',') + '\n'], { type: 'text/csv' }));
    a.download = `${t.key}-template.csv`; a.click();
  });
  $$('[data-undo]').forEach(b => b.onclick = async () => {
    if (!confirm('Remove everything this import added?')) return;
    const r = await act(() => POST(`/import/batches/${b.dataset.undo}/undo`)); toast(`Removed ${r.removed} record(s)`); route();
  });
  $$('[data-notes]').forEach(b => b.onclick = () => {
    const bt = batches.find(x => x.id === Number(b.dataset.notes));
    const m = modal(`<h2>Import notes</h2>${issuesTable(bt.warnings)}<div class="actions"><button class="btn" data-x>Close</button></div>`, { wide: true });
    $('[data-x]', m.el).onclick = m.close;
  });
  $('#ph-folder').onclick = () => $('#ph-in-folder').click();
  $('#ph-files').onclick = () => $('#ph-in-files').click();
  $('#ph-in-folder').onchange = e => photoImport([...e.target.files]);
  $('#ph-in-files').onchange = e => photoImport([...e.target.files]);
}
const issuesTable = list => table([{ label: 'Row', get: w => w.row || '' }, { label: 'Note', key: 'message' }], list, { empty: 'None' });

// ------------------------------------------------------------ CSV wizard
function startImport(t) {
  const inp = document.createElement('input'); inp.type = 'file'; inp.accept = '.csv,.txt,.tsv,text/csv';
  inp.onchange = async () => {
    const file = inp.files[0]; if (!file) return;
    if (/\.xlsx?$/i.test(file.name)) return toast('That is an Excel file. Open it in Excel and use File → Save As → CSV, then pick the CSV.', true);
    const text = await file.text();
    const pre = await act(() => POST('/import/preview', { type: t.key, csv: text }));
    Object.assign(IMP, { t, file: file.name, text, headers: pre.headers, mapping: pre.mapping, sample: pre.sample, rows: pre.row_count,
      options: Object.fromEntries((t.options || []).map(o => [o.key, o.default ?? ''])) });
    renderWizard();
  };
  inp.click();
}
function renderWizard(report) {
  const { t, headers, mapping, sample } = IMP;
  const colIdx = h => headers.indexOf(h);
  const ex = h => { const i = colIdx(h); return i < 0 ? '' : sample.map(r => r[i]).filter(Boolean).slice(0, 2).join(' · '); };
  const unused = headers.filter(h => !Object.values(mapping).includes(h));
  const w = $('#wizard');
  w.innerHTML = `<div class="card" style="border:2px solid var(--brand, #e0001a)">
    <div class="row spread"><h2 style="margin:0">Import ${esc(t.label.toLowerCase())} from “${esc(IMP.file)}”</h2><button class="btn" id="wz-x">Close</button></div>
    <p class="muted small">${IMP.rows} row(s). Match each field to a column in your file; anything set to “not in file” is left blank.</p>
    <div class="table-wrap"><table><thead><tr><th>Field here</th><th>Column in your file</th><th>Example from file</th></tr></thead><tbody>
      ${t.fields.map(f => `<tr><td>${esc(f.label)}${f.required ? ' <span class="pill warn">required</span>' : ''}</td>
        <td><select data-map="${f.key}"><option value="">— not in file —</option>${headers.map(h => `<option ${mapping[f.key] === h ? 'selected' : ''}>${esc(h)}</option>`).join('')}</select></td>
        <td class="small muted">${esc(ex(mapping[f.key]))}</td></tr>`).join('')}
    </tbody></table></div>
    ${unused.length ? `<p class="small muted">Columns not used: ${unused.map(esc).join(', ')}</p>` : ''}
    ${(t.options || []).length ? `<div class="form-grid" style="margin-top:10px">${t.options.map(o => o.type === 'date'
      ? `<label class="f"><span>${esc(o.label)}</span><input type="date" data-opt="${o.key}" value="${esc(IMP.options[o.key] || '')}"></label>`
      : `<label class="check full"><input type="checkbox" data-opt="${o.key}" ${IMP.options[o.key] ? 'checked' : ''}> ${esc(o.label)}</label>${o.help ? `<p class="small muted full" style="margin:0 0 6px 26px">${esc(o.help)}</p>` : ''}`).join('')}</div>` : ''}
    <div class="row" style="margin-top:12px"><button class="btn" id="wz-test">Test run</button><button class="btn primary" id="wz-go">Import</button></div>
    <div id="wz-report">${report ? reportHtml(report) : ''}</div></div>`;
  w.scrollIntoView({ behavior: 'smooth', block: 'start' });
  $$('[data-map]', w).forEach(s => s.onchange = () => { IMP.mapping[s.dataset.map] = s.value || undefined; if (!s.value) delete IMP.mapping[s.dataset.map]; renderWizard(); });
  $$('[data-opt]', w).forEach(i => i.onchange = () => { IMP.options[i.dataset.opt] = i.type === 'checkbox' ? i.checked : i.value; });
  $('#wz-x', w).onclick = () => { w.innerHTML = ''; };
  const send = dry => POST('/import/run', { type: t.key, csv: IMP.text, mapping: IMP.mapping, filename: IMP.file, dry_run: dry,
    options: { ...IMP.options, tz_offset: new Date().getTimezoneOffset() } });
  $('#wz-test', w).onclick = async () => { const r = await act(() => send(true)); $('#wz-report', w).innerHTML = reportHtml(r); };
  $('#wz-go', w).onclick = async () => {
    const btn = $('#wz-go', w); btn.disabled = true;
    try {
      const r = await act(() => send(false));
      toast(r.created_total || r.updated ? 'Imported' : 'Nothing was imported', !(r.created_total || r.updated));
      await viewImport();
      $('#wizard').innerHTML = `<div class="card"><div class="row spread"><h2 style="margin:0">Imported ${esc(t.label.toLowerCase())} from “${esc(IMP.file)}”</h2><button class="btn" onclick="this.closest('.card').remove()">Close</button></div>${reportHtml(r)}</div>`;
    } finally { btn.disabled = false; }
  };
}
const ENTITY_LABEL = { customer: 'customers', location: 'service addresses', job: 'jobs', estimate: 'estimates', invoice: 'invoices', payment: 'payments', job_note: 'job notes',
  pricebook: 'price book items', job_material: 'material lines', vendor: 'vendors', account: 'accounts', journal_entry: 'journal entries' };
function reportHtml(r) {
  const made = Object.entries(r.created || {}).map(([k, v]) => `<b>${v}</b> ${esc(ENTITY_LABEL[k] || k)}`).join(', ');
  return `<div class="alert ${r.error_count ? 'warn' : 'good'}" style="margin-top:12px">${r.dry_run ? '<b>Test run — nothing was saved.</b> ' : ''}
      ${made ? `${r.dry_run ? 'Would add' : 'Added'} ${made}.` : 'Nothing new to add.'}
      ${r.updated ? ` ${r.dry_run ? 'Would update' : 'Updated'} <b>${r.updated}</b> existing.` : ''}${r.skipped ? ` Skipped <b>${r.skipped}</b>.` : ''}
      ${r.error_count ? ` <b>${r.error_count}</b> row(s) have problems and ${r.dry_run ? 'would be' : 'were'} left out:` : ''}</div>
    ${r.error_count ? issuesTable(r.errors) : ''}
    ${r.warnings.length ? `<details style="margin-top:8px"><summary>${r.warnings.length} note(s)</summary>${issuesTable(r.warnings)}</details>` : ''}`;
}

// ------------------------------------------------------------ photos
const PHOTO_EXT = /\.(jpe?g|png|webp|heic|heif|pdf)$/i;
async function photoImport(files) {
  const all = files.filter(f => PHOTO_EXT.test(f.name));
  const big = all.filter(f => f.size > 10 * 1024 * 1024), ok = all.filter(f => f.size <= 10 * 1024 * 1024);
  if (!ok.length) return toast('No photos or PDFs in that selection', true);
  const pathOf = f => f.webkitRelativePath || f.name;
  const matches = await act(() => POST('/import/photos/match', { paths: ok.map(pathOf) }));
  const hit = matches.filter(m => m.target), miss = matches.filter(m => !m.target);
  const per = {}; for (const m of hit) per[m.target.label] = (per[m.target.label] || 0) + 1;
  const m = modal(`<h2>Import ${ok.length} photo(s)</h2>
    <p><b>${hit.length}</b> found their job or customer${miss.length ? `, <b>${miss.length}</b> didn't and will be skipped` : ''}${big.length ? `; ${big.length} over 10 MB skipped` : ''}${files.length - all.length ? `; ${files.length - all.length} other file(s) ignored` : ''}.</p>
    ${hit.length ? `<details><summary>Where they go</summary>${table([{ label: 'Job / customer', key: 'k' }, { label: 'Photos', num: 1, key: 'v' }], Object.entries(per).map(([k, v]) => ({ k, v })))}</details>` : ''}
    ${miss.length ? `<details><summary>No match</summary><ul class="small">${miss.slice(0, 50).map(x => `<li>${esc(x.path)}</li>`).join('')}${miss.length > 50 ? `<li>…and ${miss.length - 50} more</li>` : ''}</ul>
      <p class="small muted">Rename the folder or file so it starts with the job number, then pick them again.</p></details>` : ''}
    <div id="ph-prog" class="small" style="margin-top:10px"></div>
    <div class="actions"><button class="btn" data-x>Cancel</button><button class="btn primary" id="ph-go" ${hit.length ? '' : 'disabled'}>Upload ${hit.length}</button></div>`, { wide: true });
  let stop = false;
  $('[data-x]', m.el).onclick = () => { stop = true; m.close(); };
  $('#ph-go', m.el).onclick = async () => {
    $('#ph-go', m.el).disabled = true;
    const folder = ok[0].webkitRelativePath ? ok[0].webkitRelativePath.split('/')[0] : `${ok.length} file(s)`;
    const { batch_id } = await act(() => POST('/import/photos/start', { folder }));
    const todo = ok.filter((f, i) => matches[i].target);
    const total = todo.length;
    let done = 0, failed = 0;
    const prog = $('#ph-prog', m.el);
    const show = () => { prog.innerHTML = `<div style="height:8px;background:var(--border);border-radius:4px"><div style="height:8px;width:${Math.round(done / total * 100)}%;background:var(--brand,#e0001a);border-radius:4px"></div></div>${done} of ${total} uploaded${failed ? `, ${failed} failed` : ''}`; };
    show();
    const worker = async () => {
      while (todo.length && !stop) {
        const f = todo.shift();
        try {
          const data = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(f); });
          const r = await POST('/import/photos', { batch_id, path: pathOf(f), filename: f.name, data });
          if (!r.ok) failed++;
        } catch { failed++; }
        done++; show();
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    done = total; show();
    toast(`Uploaded ${total - failed} photo(s)${failed ? `, ${failed} failed (see the import notes)` : ''}`, !!failed);
    m.close(); route();
  };
}
