'use strict';
// Import a whole A4YE job workbook (.xlsx, the A4YE_Job_TEMPLATE format) as a commercial project.
//
// Tab → what it becomes (the same tables the project's own sheets write, so every report recalculates from them):
//   Job Register / Cover → the job (customer, address, PM, foreman, dates, contract, retainage, time clock job #, Gantt start)
//   Estimate Import      → the cost-code budget (same parser as the project's Estimate Import sheet)
//   Cost Codes           → % complete per code, where it was typed
//   Schedule, Milestones, RFI-Submittal Log, Safety-Quality Log → those logs
//   Change Orders        → change-order estimates (approved ones add to the contract)
//   SOV, Billing Entry, Pay Apps → schedule of values and pay applications; optionally their invoices and payments
//   Labor Log            → time entries, through the A4Y Time Clock sync (Entry ID is the key, so it never duplicates the sync)
//   Cost Log             → invoiced costs as job expenses, open commitments as purchase orders
//   Weekly History       → % complete for weeks where it was typed (formula weeks are proxies, not history)
// Everything else (Dashboard, Manpower Loading, Billing Worksheet, Pay App Summary, Import Quote, Bi-Weekly Report
// tabs, Rollup, Lists) is calculated — the app rebuilds it. The Employee List tab is never read.
//
// Safe to re-run: a section the project already has data in is skipped, never overwritten. Invoices, payments and
// costs come in as history (not posted to Accounting) unless the importer asks to post them.
const X = require('./xlsx');
const D = require('./db');
const TC = require('./timeclock');
const A = require('./accounting');
const C = require('./calc');
const { all, get, run } = D;

const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
const str = v => (v == null ? '' : String(v).trim());
const num = v => { if (v == null || v === '') return null; if (typeof v === 'number') return Number.isFinite(v) ? v : null; const n = Number(String(v).replace(/[$,%\s]/g, '')); return Number.isFinite(n) ? n : null; };
const yes = v => v === true || /^(y|yes|true|x|1)$/i.test(str(v));
const pct100 = v => { const n = num(v); return n == null ? null : Math.abs(n) <= 1.0001 ? r2(n * 100) : r2(n); };   // 0.05 → 5, 5 → 5
const codeOf = v => { let s = str(v).replace(/-[LMES]$/i, ''); if (/^\d{1,4}$/.test(s)) s = s.padStart(4, '0'); return s; };
const addD = (s, n) => new Date(Date.parse(s) + n * 864e5).toISOString().slice(0, 10);
const mondayOf = s => addD(s, -((new Date(Date.parse(s)).getUTCDay() + 6) % 7));
const JOB_STATUS = { active: 'in_progress', 'in progress': 'in_progress', complete: 'completed', completed: 'completed', closed: 'completed', 'on hold': 'on_hold', hold: 'on_hold',
  awarded: 'scheduled', scheduled: 'scheduled', pending: 'unscheduled', bidding: 'unscheduled', cancelled: 'cancelled', canceled: 'cancelled' };
const CO_TO_EST = { Draft: 'draft', Pending: 'draft', Submitted: 'sent', Approved: 'approved', Rejected: 'declined', Void: 'cancelled' };
const COST_CATEGORY = { M: 'Materials (supply house)', S: 'Subcontractor', E: 'Equipment rental', O: 'Other' };
const MAX_BYTES = 30 * 1024 * 1024;

module.exports = function jobImportRoutes(app, db, H) {
  const { wrap, bad, update, WB } = H;
  const insert = (table, data) => H.insert(table, Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined)));
  const L = WB.LISTS;

  function load(b) {
    if (!b || !b.file) throw bad('Choose the job workbook (.xlsx)');
    const buf = Buffer.from(String(b.file).replace(/^data:[^,]*,/, ''), 'base64');
    if (buf.length > MAX_BYTES) throw bad('That file is over 30 MB');
    let wb; try { wb = X.read(buf); } catch (e) { throw bad(e.message); }
    if (!wb.sheet('Job Register')) throw bad('That isn\'t an A4YE job workbook — it has no Job Register tab');
    return wb;
  }
  const rowsOf = (sh, keyCol, max = 2005) => { const out = []; if (!sh) return out; for (let r = 6; r <= Math.min(sh.maxRow, max); r++) if (str(sh.val(r, keyCol))) out.push(r); return out; };
  const cc = new Map();
  const codeId = raw => { const c = codeOf(raw); if (!c) return null; if (!cc.has(c)) cc.set(c, (get(db, 'SELECT id FROM cost_codes WHERE code = ?', c) || {}).id || null); return cc.get(c); };
  const userByName = n => n ? get(db, "SELECT id, name FROM users WHERE lower(trim(name)) = lower(trim(?)) AND email NOT LIKE '%@no-login.invalid'", n) || get(db, 'SELECT id, name FROM users WHERE lower(trim(name)) = lower(trim(?))', n) : null;

  // ------------------------------------------------------------ read every tab into plain rows
  function parse(wb) {
    const w = [], col = X.colNum;
    const jr = wb.sheet('Job Register'), cover = wb.sheet('Cover');
    const coverVal = label => { if (!cover) return null; for (let r = 1; r <= Math.min(cover.maxRow, 120); r++) for (let c = 1; c <= 4; c++)
      if (str(cover.val(r, c)).toLowerCase().startsWith(label)) return cover.val(r, c + 1); return null; };
    const J = n => jr.val(6, col(n));
    const job = { number: str(J('A')), name: str(J('B')), client: str(J('C')), address: str(J('D')), type: str(J('E')), pm: str(J('F')), foreman: str(J('G')), status: str(J('H')),
      award: X.dateOf(J('I')), start: X.dateOf(J('J')), finish: X.dateOf(J('K')), sf: num(J('L')), contract: num(J('M')), approved_co: num(J('N')), retainage_pct: pct100(J('AK')),
      notes: str(J('AL')), mobilization_pct: pct100(J('AM')), billed: num(J('AE')), cash: num(J('AG')), labor_hours: num(J('AI')),
      schedule_start: X.dateOf(coverVal('schedule start')), blended_rate: num(coverVal('blended burdened field rate')), default_retainage: pct100(coverVal('default retainage')) };
    if (!job.number && !job.name) throw bad('The Job Register tab has no job in row 6');

    const sch = wb.sheet('Schedule');
    const tasks = rowsOf(sch, col('E'), 400).map(r => ({ row: r, ref: str(sch.val(r, 1)), phase: str(sch.val(r, 3)), area: str(sch.val(r, 4)), name: str(sch.val(r, 5)), code: sch.val(r, 6),
      start: X.dateOf(sch.val(r, 7)), finish: X.dateOf(sch.val(r, 8)), pred: str(sch.val(r, 10)), responsible: str(sch.val(r, 11)), budget: num(sch.val(r, 12)),
      pct: sch.cell(r, 13).f ? null : pct100(sch.val(r, 13)), notes: str(sch.val(r, 22)) }));

    const ms = wb.sheet('Milestones');
    const milestones = rowsOf(ms, col('C'), 200).map(r => ({ name: str(ms.val(r, 3)), phase: str(ms.val(r, 4)), baseline: X.dateOf(ms.val(r, 5)), forecast: X.dateOf(ms.val(r, 6)),
      actual: X.dateOf(ms.val(r, 7)), owner: str(ms.val(r, 9)), critical: yes(ms.val(r, 11)), billing: yes(ms.val(r, 12)), notes: str(ms.val(r, 14)) }));

    const co = wb.sheet('Change Orders');
    const cos = rowsOf(co, col('E'), 300).map(r => { const v = c => co.val(r, col(c));
      return { no: str(v('A')), initiated: X.dateOf(v('D')), description: str(v('E')), type: str(v('F')), status: str(v('G')) || 'Draft', code: v('H'), labor_hrs: num(v('I')) || 0,
        labor: num(v('K')) || 0, material: num(v('L')) || 0, equipment: num(v('M')) || 0, sub: num(v('N')) || 0, other: num(v('O')) || 0, tax: num(v('P')) || 0,
        cost: num(v('Q')) || 0, sell: num(v('T')) || 0, days: num(v('W')), submitted: X.dateOf(v('X')), approved: X.dateOf(v('Y')), reference: str(v('AA')), notes: str(v('AB')) }; });

    const sv = wb.sheet('SOV');
    const sov = rowsOf(sv, col('D'), 200).map(r => ({ line: num(sv.val(r, 1)) ?? r - 5, division: str(sv.val(r, 2)), co_no: str(sv.val(r, 3)), description: str(sv.val(r, 4)),
      calc: num(sv.val(r, 5)), override: sv.cell(r, 6).f ? null : num(sv.val(r, 6)), notes: str(sv.val(r, 13)) })).filter(x => x.division);

    const pa = wb.sheet('Pay Apps'), be = wb.sheet('Billing Entry');
    const apps = [];
    if (pa) for (let r = 6; r <= 29; r++) {
      const period = X.dateOf(pa.val(r, 2)); if (!period) continue;
      const k = num(pa.val(r, 1)) || r - 5;
      const lines = [];
      if (be) for (let br = 6; br <= Math.min(be.maxRow, 200); br++) {
        const line = num(be.val(br, 1)); if (line == null) continue;
        const work = num(be.val(br, 8 + k - 1)) || 0, stored = num(be.val(br, 33 + k - 1)) || 0;
        if (work || stored) lines.push({ line, work, stored });
      }
      apps.push({ app_no: k, period_to: period, retainage_pct: pa.cell(r, 3).f ? null : pct100(pa.val(r, 3)), gross: num(pa.val(r, 9)), net_due: num(pa.val(r, 12)),
        submitted: X.dateOf(pa.val(r, 13)), paid_date: X.dateOf(pa.val(r, 14)), paid: num(pa.val(r, 15)) || 0, status: str(pa.val(r, 18)), ref: str(pa.val(r, 19)), notes: str(pa.val(r, 20)), lines });
    }

    const rf = wb.sheet('RFI-Submittal Log');
    const rfis = rowsOf(rf, col('E'), 300).map(r => { const v = c => rf.val(r, col(c));
      return { type: str(v('B')) || 'RFI', number: str(v('D')), subject: str(v('E')), spec: str(v('F')), code: v('G'), sent: X.dateOf(v('H')), needed: X.dateOf(v('I')), returned: X.dateOf(v('J')),
        status: str(v('M')), ball: str(v('N')), cost: num(v('O')), days: num(v('P')), co_no: str(v('Q')), notes: str(v('R')) }; });

    const sq = wb.sheet('Safety-Quality Log');
    const safety = rowsOf(sq, col('E'), 300).map(r => { const v = c => sq.val(r, col(c));
      return { date: X.dateOf(v('B')), type: str(v('D')), description: str(v('E')), severity: str(v('F')), reported: str(v('G')), action: str(v('H')), owner: str(v('I')), due: X.dateOf(v('J')),
        closed: X.dateOf(v('K')), recordable: yes(v('M')), lost: num(v('N')), ref: str(v('P')) }; }).filter(x => x.date && x.type);

    const ll = wb.sheet('Labor Log');
    const labor = rowsOf(ll, col('B')).map(r => { const v = c => ll.val(r, col(c));
      return { 'Entry ID': str(v('B')), 'Employee ID': str(v('C')), Employee: str(v('D')), Date: v('E') == null ? '' : (typeof v('E') === 'number' ? X.dateOf(v('E')) : str(v('E'))),
        Start: X.dateTimeOf(v('F')) || '', End: X.dateTimeOf(v('G')) || '', 'Total Hrs': v('H') ?? '', 'Job #': str(v('I')), 'Job Name': str(v('J')), Category: str(v('K')), 'Cost Code': str(v('L')),
        'Cost Code Description': str(v('M')), Note: str(v('N')), Source: str(v('O')), 'Labor $': v('S') ?? '' }; });

    const cl = wb.sheet('Cost Log');
    const cost = rowsOf(cl, col('A'), 400).map(r => { const v = c => cl.val(r, col(c));
      return { id: str(v('A')), date: X.dateOf(v('B')), code: v('E'), type: str(v('F')).toUpperCase(), vendor: str(v('J')), ref: str(v('K')), description: str(v('L')) || str(v('I')),
        status: str(v('M')), committed: num(v('N')) || 0, invoiced: num(v('O')) || 0, total: num(v('Q')) || 0, open: num(v('R')) || 0, billable: yes(v('T')) }; })
      .filter(x => x.total > 0.004 || x.open > 0.004);

    const wh = wb.sheet('Weekly History');
    const history = rowsOf(wh, col('B'), 200).filter(r => !wh.cell(r, 5).f && num(wh.val(r, 5)) != null).map(r => ({ week_ending: X.dateOf(wh.val(r, 2)), pct: pct100(wh.val(r, 5)) })).filter(x => x.week_ending);

    // the quote rows, A–P as the Estimate Import sheet takes them; column S/T overrides carried along
    const ei = wb.sheet('Estimate Import');
    const qLines = [], overrides = {};
    if (ei) for (let r = 6; r <= Math.min(ei.maxRow, 605); r++) {
      const vals = []; for (let c = 1; c <= 16; c++) { const x = ei.val(r, c); vals.push(x == null ? '' : String(x).replace(/[\t\r\n]+/g, ' ')); }
      if (vals.every(x => x === '')) continue;
      const s = str(ei.val(r, 19)), t = str(ei.val(r, 20));
      if (s || t) overrides[qLines.length] = { ...(s ? { code: s } : {}), ...(t ? { area: t } : {}) };
      qLines.push(vals.join('\t'));
    }
    const cct = wb.sheet('Cost Codes');
    const codePct = [];
    if (cct) for (let r = 6; r <= Math.min(cct.maxRow, 200); r++) { const c = cct.cell(r, col('N')); if (c.v != null && !c.f && num(c.v) != null) codePct.push({ code: cct.val(r, col('B')) || cct.val(r, 1), pct: pct100(c.v) }); }

    const bwTabs = wb.sheetNames.filter(n => /^Bi-Weekly Report/.test(n));
    return { job, tasks, milestones, cos, sov, apps, rfis, safety, labor, cost, history, quote: { text: qLines.join('\n'), lines: qLines.length, overrides }, codePct, bwTabs, warnings: w };
  }

  // what's already there decides what gets skipped
  function existing(jobId) {
    if (!jobId) return {};
    const n = (sql) => get(db, sql, jobId).n;
    return { tasks: n('SELECT COUNT(*) n FROM project_tasks WHERE job_id = ?'), milestones: n('SELECT COUNT(*) n FROM project_milestones WHERE job_id = ?'),
      rfis: n('SELECT COUNT(*) n FROM rfis WHERE job_id = ?'), safety: n('SELECT COUNT(*) n FROM safety_items WHERE job_id = ?'),
      cos: n('SELECT COUNT(*) n FROM estimates WHERE job_id = ? AND change_order = 1'), sov: n('SELECT COUNT(*) n FROM sov_lines WHERE job_id = ?'),
      apps: n('SELECT COUNT(*) n FROM pay_apps WHERE job_id = ?'), budget: n('SELECT COUNT(*) n FROM job_budgets WHERE job_id = ?'),
      cost: n('SELECT (SELECT COUNT(*) FROM expenses WHERE job_id = ?1) + (SELECT COUNT(*) FROM purchase_orders WHERE job_id = ?1) n') };
  }
  const findJob = number => number ? get(db, 'SELECT * FROM jobs WHERE timeclock_job = ? OR number = ? ORDER BY timeclock_job = ? DESC LIMIT 1', number, number, number) : null;

  function preview(P, target) {
    const ex = existing(target && target.id);
    const skip = (k, label) => ex[k] ? `the project already has ${ex[k]} ${label}` : null;
    const people = {};
    for (const e of P.labor) { const k = e.Employee || e['Employee ID']; if (!k || people[k]) continue;
      const u = (e['Employee ID'] && get(db, 'SELECT id FROM users WHERE timeclock_id = ?', e['Employee ID'])) || userByName(e.Employee); people[k] = u ? 'matched' : 'new (added as an inactive tech, like the time clock sync)'; }
    const known = new Set(all(db, 'SELECT code FROM cost_codes').map(c => c.code));
    const unknownCodes = [...new Set([...P.tasks.map(t => t.code), ...P.rfis.map(r => r.code), ...P.cos.map(c => c.code), ...P.cost.map(c => c.code)].map(codeOf).filter(c => c && !known.has(c)))];
    const extTime = P.labor.filter(e => e['Entry ID'] && get(db, 'SELECT 1 x FROM time_entries WHERE external_id = ?', e['Entry ID'])).length;
    const mismatchedJob = P.labor.filter(e => e['Job #'] && e['Job #'] !== P.job.number).length;
    const sec = (key, label, count, skipReason, detail) => ({ key, label, count, skip: count ? skipReason : 'nothing on that tab', detail });
    return {
      job: P.job, target: target ? { id: target.id, number: target.number, title: target.title, timeclock_job: target.timeclock_job } : null,
      pm: P.job.pm ? (userByName(P.job.pm) ? 'matched' : 'not on Team — left blank') : null, foreman: P.job.foreman ? (userByName(P.job.foreman) ? 'matched' : 'not on Team — left blank') : null,
      sections: [
        sec('budget', 'Estimate Import → budget by cost code', P.quote.lines, skip('budget', 'cost-code budget rows'), `${P.quote.lines} quote rows${P.codePct.length ? `, % complete on ${P.codePct.length} codes` : ''}`),
        sec('tasks', 'Schedule', P.tasks.length, skip('tasks', 'schedule tasks')),
        sec('milestones', 'Milestones', P.milestones.length, skip('milestones', 'milestones')),
        sec('cos', 'Change Orders', P.cos.length, skip('cos', 'change orders'), `${P.cos.filter(c => c.status === 'Approved').length} approved`),
        sec('sov', 'SOV', P.sov.length, skip('sov', 'SOV lines')),
        sec('apps', 'Pay Apps + Billing Entry', P.apps.length, skip('apps', 'pay applications') || (P.apps.length && !P.sov.length ? 'needs the SOV tab' : null) || (ex.sov ? 'the SOV is already set up here — pay apps only come in with their SOV' : null),
          P.apps.map(a => `#${a.app_no} to ${a.period_to}: gross ${a.gross ?? 0}`).join('; ')),
        sec('rfis', 'RFI-Submittal Log', P.rfis.length, skip('rfis', 'RFIs / submittals')),
        sec('safety', 'Safety-Quality Log', P.safety.length, skip('safety', 'safety items')),
        sec('labor', 'Labor Log → time entries', P.labor.length, null, `${extTime} already synced from the A4Y Time Clock (updated, not duplicated)${mismatchedJob ? `; ${mismatchedJob} rows for other job numbers are left out` : ''}`),
        sec('cost', 'Cost Log', P.cost.length, skip('cost', 'expenses / purchase orders'), `${P.cost.filter(c => c.total > 0.004).length} invoiced costs, ${P.cost.filter(c => c.open > 0.004).length} open commitments`),
        sec('history', 'Weekly History (typed % only)', P.history.length, null, P.history.length ? '' : 'every week on that tab is a formula (hours proxy), so there is no reported progress to keep'),
      ],
      people, unknown_codes: unknownCodes, not_imported: ['Dashboard', 'Manpower Loading', 'Billing Worksheet', 'Pay App Summary', 'Import Quote', 'Rollup', 'Lists', ...P.bwTabs].join(', '),
    };
  }

  // ------------------------------------------------------------ write it
  function apply(P, req, opts) {
    const out = { job_id: null, created_job: false, done: {}, warnings: [] };
    const post = !!opts.post_to_ledger, makeInvoices = opts.create_invoices !== false;
    const J = P.job;
    let job = opts.job_id ? get(db, 'SELECT * FROM jobs WHERE id = ?', Number(opts.job_id)) : findJob(J.number);
    if (opts.job_id && !job) throw bad('That project no longer exists');
    const pm = userByName(J.pm), fm = userByName(J.foreman);
    if (J.pm && !pm) out.warnings.push(`Project manager "${J.pm}" isn't on Team — left blank`);
    if (J.foreman && !fm) out.warnings.push(`Foreman "${J.foreman}" isn't on Team — left blank`);
    if (!job) {
      let cust = J.client ? get(db, 'SELECT * FROM customers WHERE lower(trim(name)) = lower(trim(?)) OR lower(trim(company)) = lower(trim(?)) ORDER BY id LIMIT 1', J.client, J.client) : null;
      if (!cust) cust = { id: insert('customers', { name: J.client || J.name || 'Imported GC', company: J.client || null, type: 'commercial' }) };
      let loc = null;
      if (J.address) loc = get(db, 'SELECT id FROM locations WHERE customer_id = ? AND lower(address) = lower(?)', cust.id, J.address) || { id: insert('locations', { customer_id: cust.id, label: J.name || null, address: J.address }) };
      const id = insert('jobs', { number: D.nextNumber(db, 'jobs', 'J'), customer_id: cust.id, location_id: loc ? loc.id : null, title: J.name || `Job ${J.number}`,
        description: [J.type, J.sf ? `${Number(J.sf).toLocaleString('en-US')} SF` : '', J.award ? `Awarded ${J.award}` : '', J.notes].filter(Boolean).join(' · ') || null,
        job_type: 'commercial', status: JOB_STATUS[J.status.toLowerCase()] || (J.start && J.start <= new Date().toISOString().slice(0, 10) ? 'in_progress' : 'scheduled'),
        billing_type: 'fixed', is_project: 1, contract_amount: J.contract || 0, retainage_pct: J.retainage_pct ?? J.default_retainage ?? null, mobilization_pct: J.mobilization_pct,
        start_date: J.start, end_date: J.finish, project_manager_id: pm ? pm.id : null, foreman_id: fm ? fm.id : null, timeclock_job: J.number || null,
        schedule_start: J.schedule_start ? mondayOf(J.schedule_start) : null });
      if (fm) run(db, 'INSERT OR IGNORE INTO job_techs (job_id, user_id) VALUES (?, ?)', id, fm.id);
      job = get(db, 'SELECT * FROM jobs WHERE id = ?', id); out.created_job = true;
    } else {
      // an existing project: fill what's blank, never overwrite
      const fill = {}; const blank = k => job[k] == null || job[k] === '';
      if (!job.is_project) fill.is_project = 1;
      if (blank('timeclock_job') && J.number) fill.timeclock_job = J.number;
      if (blank('schedule_start') && J.schedule_start) fill.schedule_start = mondayOf(J.schedule_start);
      if (!job.contract_amount && J.contract) fill.contract_amount = J.contract;
      if (blank('start_date') && J.start) fill.start_date = J.start; if (blank('end_date') && J.finish) fill.end_date = J.finish;
      if (blank('project_manager_id') && pm) fill.project_manager_id = pm.id; if (blank('foreman_id') && fm) fill.foreman_id = fm.id;
      if (blank('retainage_pct') && (J.retainage_pct ?? J.default_retainage) != null) fill.retainage_pct = J.retainage_pct ?? J.default_retainage;
      if (blank('mobilization_pct') && J.mobilization_pct != null) fill.mobilization_pct = J.mobilization_pct;
      if (Object.keys(fill).length) update('jobs', job.id, fill);
      job = get(db, 'SELECT * FROM jobs WHERE id = ?', job.id);
    }
    out.job_id = job.id;
    if (J.blended_rate && !Number(D.settings(db).blended_labor_rate)) run(db, "INSERT INTO settings (key, value) VALUES ('blended_labor_rate', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", String(J.blended_rate));
    const ex = existing(job.id), done = out.done, skipped = (k, why) => { done[k] = { skipped: why }; };

    // budget from the quote
    if (!P.quote.lines) skipped('budget', 'no quote rows');
    else if (ex.budget) skipped('budget', `the project already has a budget on ${ex.budget} cost codes`);
    else {
      try {
        const r = WB.applyQuote(job, { text: P.quote.text, overrides: P.quote.overrides, mode: 'replace', skip_uncoded: true, source: opts.file_name || 'Job workbook' }, req.user.id);
        done.budget = { imported: r.lines, codes: r.codes, total: r.totals.total };
        if (r.totals.need_code) out.warnings.push(`${r.totals.need_code} quote line(s) had no usable cost code and were left out — see Estimate Import`);
        let n = 0; for (const p of P.codePct) { const id = codeId(p.code); if (id && p.pct != null) n += run(db, 'UPDATE job_budgets SET percent_complete = ? WHERE job_id = ? AND cost_code_id = ?', p.pct, job.id, id).changes; }
        if (n) done.budget.percent_complete = n;
      } catch (e) { skipped('budget', e.message); }
    }
    // schedule (Pred. "T-003" links up; anything else is kept in the notes)
    if (!P.tasks.length) skipped('tasks', 'no tasks'); else if (ex.tasks) skipped('tasks', `already has ${ex.tasks} tasks`);
    else {
      const ids = new Map(); let sort = 0;
      for (const t of P.tasks) {
        const notes = [t.notes, t.pred && !/^T-\d+$/i.test(t.pred) ? `Pred: ${t.pred}` : ''].filter(Boolean).join(' · ') || null;
        const id = insert('project_tasks', { job_id: job.id, phase: L.phases.includes(t.phase) ? t.phase : null, area: t.area || null, name: t.name.slice(0, 300), cost_code_id: codeId(t.code),
          start_date: t.start, finish_date: t.finish && t.start && t.finish < t.start ? t.start : t.finish, responsible: t.responsible || null, budget_hours: t.budget,
          pct_complete: t.pct == null ? null : Math.min(100, Math.max(0, t.pct)), notes, sort: sort += 10, updated_at: new Date().toISOString() });
        if (t.ref) ids.set(t.ref.toUpperCase(), id);
      }
      for (const t of P.tasks) if (/^T-\d+$/i.test(t.pred) && ids.get(t.pred.toUpperCase()) && ids.get(t.ref.toUpperCase()) !== ids.get(t.pred.toUpperCase()))
        run(db, 'UPDATE project_tasks SET predecessor_id = ? WHERE id = ?', ids.get(t.pred.toUpperCase()), ids.get(t.ref.toUpperCase()));
      done.tasks = { imported: P.tasks.length };
    }
    if (!P.milestones.length) skipped('milestones', 'none'); else if (ex.milestones) skipped('milestones', `already has ${ex.milestones}`);
    else { P.milestones.forEach((m, i) => insert('project_milestones', { job_id: job.id, name: m.name, phase: L.phases.includes(m.phase) ? m.phase : null, baseline_date: m.baseline,
      forecast_date: m.forecast, actual_date: m.actual, owner: m.owner || null, critical: m.critical ? 1 : 0, impacts_billing: m.billing ? 1 : 0, notes: m.notes || null, sort: (i + 1) * 10 })); done.milestones = { imported: P.milestones.length }; }

    // change orders → CO estimates, priced line by line so the sell price and cost match the log exactly
    const coIds = new Map();
    if (!P.cos.length) skipped('cos', 'none'); else if (ex.cos) skipped('cos', `already has ${ex.cos}`);
    else {
      for (const c of P.cos) {
        const status = L.co_status.includes(c.status) ? c.status : 'Draft';
        const number = c.no && !get(db, 'SELECT 1 x FROM estimates WHERE number = ?', c.no) ? c.no : D.nextNumber(db, 'estimates', 'EST');
        const eid = insert('estimates', { number, customer_id: job.customer_id, location_id: job.location_id, job_id: job.id, title: c.description.slice(0, 300), status: CO_TO_EST[status],
          tax_rate: 0, notes: c.notes || null, public_token: D.token(), change_order: 1, co_type: L.co_type.includes(c.type) ? c.type : null, co_status: status, co_days_added: c.days,
          co_reference: c.reference || null, co_submitted_at: c.submitted, sent_at: c.submitted, approved_at: status === 'Approved' ? (c.approved || c.submitted || c.initiated) : null,
          declined_at: status === 'Rejected' ? (c.approved || c.submitted) : null, created_by: req.user.id, created_at: c.initiated ? `${c.initiated} 12:00:00` : undefined });
        const parts = [['Labor', c.labor, c.labor_hrs], ['Material', c.material + c.tax], ['Equipment', c.equipment], ['Subcontract', c.sub], ['Other', c.other]].filter(p => p[1] > 0.004);
        const totalCost = parts.reduce((t, p) => t + p[1], 0), ccid = codeId(c.code);
        if (!parts.length) parts.push(['Change order', 0]);
        let soldSoFar = 0;
        parts.forEach(([what, costAmt, hrs], i) => {
          const sell = i === parts.length - 1 ? r2(c.sell - soldSoFar) : r2(totalCost ? c.sell * costAmt / totalCost : 0); soldSoFar += sell;
          const qty = what === 'Labor' && hrs > 0 ? hrs : 1;
          run(db, 'INSERT INTO estimate_items (estimate_id, description, qty, unit_price, unit_cost, taxable, cost_code_id, sort) VALUES (?,?,?,?,?,0,?,?)',
            eid, `${what} — ${c.description}`.slice(0, 300), qty, qty ? sell / qty : sell, qty ? costAmt / qty : costAmt, ccid, i);
        });
        if (c.no) coIds.set(c.no, eid);
      }
      done.cos = { imported: P.cos.length, approved: P.cos.filter(c => c.status === 'Approved').length };
    }
    // SOV, then pay apps with their billing-entry lines, then (optionally) the invoices and payments
    const sovIds = new Map();
    if (!P.sov.length) skipped('sov', 'none'); else if (ex.sov) skipped('sov', `already has ${ex.sov} SOV lines`);
    else {
      for (const s of P.sov) sovIds.set(s.line, insert('sov_lines', { job_id: job.id, division: s.division, co_estimate_id: s.co_no ? coIds.get(s.co_no) || null : null,
        description: s.description, calc_value: s.calc, override_value: s.override, notes: s.notes || null, sort: s.line }));
      done.sov = { imported: P.sov.length };
    }
    if (!P.apps.length) skipped('apps', 'none'); else if (ex.apps) skipped('apps', `already has ${ex.apps} pay applications`); else if (!sovIds.size) skipped('apps', 'pay apps only come in with their SOV');
    else {
      const appIds = [];
      for (const a of P.apps.sort((x, y) => x.app_no - y.app_no)) {
        const id = insert('pay_apps', { job_id: job.id, app_no: a.app_no, period_to: a.period_to, retainage_pct: a.retainage_pct, status: 'Draft', notes: a.notes || null, customer_ref: a.ref || null });
        for (const l of a.lines) { const sid = sovIds.get(l.line); if (sid) insert('pay_app_lines', { pay_app_id: id, sov_line_id: sid, work_this_period: l.work, stored_balance: l.stored }); else out.warnings.push(`Pay App #${a.app_no}: Billing Entry line ${l.line} has no SOV line`); }
        appIds.push({ id, a });
      }
      // check the math against what the workbook calculated
      const calc = WB.payApps(job);
      for (const { a } of appIds) { const m = calc.find(x => x.app_no === a.app_no); if (m && a.gross != null && Math.abs(m.gross_this_app - a.gross) > 0.02) out.warnings.push(`Pay App #${a.app_no}: gross here ${m.gross_this_app.toFixed(2)} vs workbook ${a.gross.toFixed(2)}`); }
      let invoiced = 0, payments = 0;
      for (const { id, a } of appIds) {
        const row = get(db, 'SELECT * FROM pay_apps WHERE id = ?', id), m = calc.find(x => x.app_no === a.app_no);
        let invId = null;
        if (makeInvoices && m && (Math.abs(m.gross_this_app) > 0.004 || Math.abs(m.retainage_this_app) > 0.004)) {
          invId = WB.invoicePayApp(job, row, { issueDate: a.submitted || a.period_to });
          run(db, "UPDATE invoices SET status = 'sent', sent_at = ?, ledger_skip = ? WHERE id = ?", `${a.submitted || a.period_to} 12:00:00`, post ? 0 : 1, invId);
          if (a.paid > 0.004) { insert('payments', { invoice_id: invId, amount: r2(a.paid), method: 'check', reference: a.ref || 'Imported', paid_at: a.paid_date || a.submitted || a.period_to, ledger_skip: post ? 0 : 1 }); payments++; }
          C.refreshInvoiceStatus(db, invId);
          if (post) { try { A.postInvoice(db, invId); for (const p of all(db, 'SELECT id FROM payments WHERE invoice_id = ?', invId)) A.postPayment(db, p.id); }
            catch (e) { run(db, 'UPDATE invoices SET ledger_skip = 1 WHERE id = ?', invId); run(db, 'UPDATE payments SET ledger_skip = 1 WHERE invoice_id = ?', invId); out.warnings.push(`Pay App #${a.app_no} invoice not posted to Accounting: ${e.message}`); } }
          invoiced++;
        }
        const st = L.bill_status.includes(a.status) ? a.status : a.paid > 0.004 ? (a.net_due != null && a.paid + 0.01 < a.net_due ? 'Short Paid' : 'Paid') : (a.submitted || invId ? 'Submitted' : 'Draft');
        update('pay_apps', id, { status: st, date_submitted: a.submitted || (st !== 'Draft' ? a.period_to : null), date_paid: a.paid_date, amount_paid: a.paid || null });
      }
      done.apps = { imported: appIds.length, invoices: invoiced, payments };
    }
    if (!P.rfis.length) skipped('rfis', 'none'); else if (ex.rfis) skipped('rfis', `already has ${ex.rfis}`);
    else { for (const r of P.rfis) insert('rfis', { job_id: job.id, type: L.rfi_type.includes(r.type) ? r.type : 'RFI', number: r.number || null, subject: r.subject.slice(0, 500), spec_section: r.spec || null,
      cost_code_id: codeId(r.code), date_sent: r.sent, date_needed: r.needed, date_returned: r.returned, status: L.doc_status.includes(r.status) ? r.status : 'Open',
      ball_in_court: L.ball_in_court.includes(r.ball) ? r.ball : null, cost_impact: r.cost, sched_impact_days: r.days, co_estimate_id: r.co_no ? coIds.get(r.co_no) || null : null, notes: r.notes || null, created_by: req.user.id });
      done.rfis = { imported: P.rfis.length }; }
    if (!P.safety.length) skipped('safety', 'none'); else if (ex.safety) skipped('safety', `already has ${ex.safety}`);
    else { for (const q of P.safety) insert('safety_items', { job_id: job.id, date: q.date, type: L.safety_type.includes(q.type) ? q.type : 'Observation', description: q.description,
      severity: L.severity.includes(q.severity) ? q.severity : null, reported_by: q.reported || null, corrective_action: q.action || null, owner: q.owner || null, due_date: q.due,
      closed_date: q.closed, recordable: q.recordable ? 1 : 0, lost_time_days: q.lost, ref: q.ref || null, created_by: req.user.id });
      done.safety = { imported: P.safety.length }; }

    // labor: through the time clock sync, so Entry IDs line up with it; keep the sync's own "last sync" note untouched
    const mine = P.labor.filter(e => e['Entry ID'] && (!e['Job #'] || e['Job #'] === J.number || e['Job #'] === job.timeclock_job));
    if (!mine.length) skipped('labor', P.labor.length ? 'no rows for this job number' : 'none');
    else {
      const lastSync = (get(db, "SELECT value FROM settings WHERE key = 'timeclock_last_sync'") || {}).value;
      const r = TC.ingest(db, mine, { userId: req.user.id });
      if (lastSync == null) run(db, "DELETE FROM settings WHERE key = 'timeclock_last_sync'"); else run(db, "UPDATE settings SET value = ? WHERE key = 'timeclock_last_sync'", lastSync);
      done.labor = { created: r.created, updated: r.updated, unchanged: r.unchanged, skipped: r.skipped, people_added: r.people_added, codes_added: r.codes_added };
      if (r.people_added.length) out.warnings.push(`Added as inactive techs (no login): ${r.people_added.join(', ')} — give them a login under Team if they need one`);
    }
    // the PM and foreman may only exist now, added from the Labor Log
    { const cur = get(db, 'SELECT project_manager_id, foreman_id FROM jobs WHERE id = ?', job.id), fill = {};
      if (!cur.project_manager_id && J.pm) { const u = userByName(J.pm); if (u) fill.project_manager_id = u.id; }
      if (!cur.foreman_id && J.foreman) { const u = userByName(J.foreman); if (u) { fill.foreman_id = u.id; run(db, 'INSERT OR IGNORE INTO job_techs (job_id, user_id) VALUES (?, ?)', job.id, u.id); } }
      if (Object.keys(fill).length) { update('jobs', job.id, fill); out.warnings = out.warnings.filter(w => !(fill.project_manager_id && w.startsWith('Project manager')) && !(fill.foreman_id && w.startsWith('Foreman'))); } }
    // cost log: invoiced costs → job expenses (history), open commitments → purchase orders grouped by vendor + PO #
    if (!P.cost.length) skipped('cost', 'none'); else if (ex.cost) skipped('cost', 'the project already has expenses or purchase orders');
    else {
      const vendorId = name => { const n = name || 'Unknown vendor'; const v = get(db, 'SELECT id FROM vendors WHERE lower(trim(name)) = lower(trim(?))', n); return v ? v.id : insert('vendors', { name: n }); };
      let exp = 0, poLines = 0; const pos = new Map();
      for (const c of P.cost) {
        if (c.total > 0.004) {
          const id = insert('expenses', { date: c.date || job.start_date || new Date().toISOString().slice(0, 10), category: COST_CATEGORY[c.type] || 'Other', vendor: c.vendor || null,
            description: [c.description, c.ref ? `#${c.ref}` : '', c.id].filter(Boolean).join(' · ').slice(0, 300), amount: r2(c.total), job_id: job.id, cost_code_id: codeId(c.code), billable: c.billable ? 1 : 0, ledger_skip: post ? 0 : 1 });
          if (post) { try { A.postExpense(db, id); } catch (e) { run(db, 'UPDATE expenses SET ledger_skip = 1 WHERE id = ?', id); out.warnings.push(`Cost ${c.id} not posted to Accounting: ${e.message}`); } }
          exp++;
        }
        if (c.open > 0.004) {
          const key = `${c.vendor}|${c.ref}`;
          if (!pos.has(key)) { const number = c.ref && !get(db, 'SELECT 1 x FROM purchase_orders WHERE number = ?', c.ref) ? c.ref : D.nextNumber(db, 'purchase_orders', 'PO');
            pos.set(key, insert('purchase_orders', { number, vendor_id: vendorId(c.vendor), job_id: job.id, status: 'submitted', deliver_to: 'job', order_date: c.date, notes: 'From the job workbook Cost Log', created_by: req.user.id })); }
          insert('po_lines', { po_id: pos.get(key), description: (c.description || 'Material').slice(0, 300), qty: 1, qty_received: 0, unit_cost: r2(c.open), cost_code_id: codeId(c.code), sort: poLines++ });
        }
      }
      done.cost = { expenses: exp, purchase_orders: pos.size, po_lines: poLines };
    }
    // reported progress, typed weeks only
    if (!P.history.length) skipped('history', 'no typed % complete');
    else { let n = 0; for (const h of P.history) { const we = addD(mondayOf(h.week_ending), 6);
      n += run(db, `INSERT INTO project_progress (job_id, week_ending, pct_complete, source, note, updated_by) VALUES (?, ?, ?, 'manual', 'From the job workbook', ?)
        ON CONFLICT(job_id, week_ending) DO NOTHING`, job.id, we, h.pct, req.user.id).changes; } done.history = { imported: n }; }

    const tot = get(db, 'SELECT SUM(budget_hours) h, SUM(budget_material) m FROM job_budgets WHERE job_id = ?', job.id);
    if (tot.h != null) update('jobs', job.id, { budget_hours: r2(tot.h), budget_materials: r2(tot.m || 0) });
    // compare the headline numbers with what the workbook showed
    const Bill = require('./billing');
    const cv = Bill.contractValue(db, get(db, 'SELECT * FROM jobs WHERE id = ?', job.id));
    out.check = { contract_here: cv.total, contract_workbook: J.contract != null ? r2(J.contract + (J.approved_co || 0)) : null,
      budget_here: Bill.budgetCost(db, get(db, 'SELECT * FROM jobs WHERE id = ?', job.id)), labor_hours_here: r2(get(db, "SELECT SUM((julianday(clock_out) - julianday(clock_in)) * 24) h FROM time_entries WHERE job_id = ? AND clock_out IS NOT NULL", job.id).h || 0), labor_hours_workbook: J.labor_hours };
    if (out.check.contract_workbook != null && Math.abs(out.check.contract_here - out.check.contract_workbook) > 0.02) out.warnings.push(`Revised contract here ${out.check.contract_here} vs workbook ${out.check.contract_workbook}`);
    return out;
  }

  const adminOnly = req => { if (req.user.role !== 'admin') throw bad('Only an admin can import a job workbook', 403); };
  app.post('/api/import/job-workbook/preview', wrap((req, res) => {
    adminOnly(req);
    const P = parse(load(req.body));
    const target = req.body.job_id ? get(db, 'SELECT * FROM jobs WHERE id = ?', Number(req.body.job_id)) : findJob(P.job.number);
    res.json(preview(P, target));
  }));
  app.post('/api/import/job-workbook', wrap((req, res) => {
    adminOnly(req);
    const P = parse(load(req.body));
    res.json(apply(P, req, { job_id: req.body.job_id || null, create_invoices: req.body.create_invoices !== false, post_to_ledger: !!req.body.post_to_ledger, file_name: req.body.file_name }));
  }));
};
