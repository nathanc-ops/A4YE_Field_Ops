'use strict';
// Commercial projects in the A4YE job tracker format (A4YE_Job_TEMPLATE.xlsx):
//   SOV · Billing Entry · Pay Apps · Pay App Summary (AIA G702) · Billing Worksheet (G703)
//   Change Orders · RFI-Submittal Log · Safety-Quality Log · Milestones · Labor Log · Cost Log
// Column names, dropdown lists and the pay-app math follow the workbook so the numbers match it.
const D = require('./db');
const C = require('./calc');
const Bill = require('./billing');
const mailer = require('./mailer');
const { all, get, run } = D;
const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
const localDate = d => { const x = new Date(d); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; };
const today = () => localDate(Date.now());
const days = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);

// the workbook's Lists tab
const LISTS = {
  co_status: ['Draft', 'Pending', 'Submitted', 'Approved', 'Rejected', 'Void'],
  co_type: ['Owner', 'GC', 'Field Directive', 'Backcharge', 'Internal', 'Allowance Reconciliation'],
  rfi_type: ['RFI', 'Submittal', 'Shop Drawing', 'Substitution', 'Product Data', 'Closeout Doc'],
  doc_status: ['Not Started', 'Open', 'Answered', 'Approved', 'Approved as Noted', 'Revise & Resubmit', 'Rejected', 'Closed', 'Void'],
  ball_in_court: ['A4YE', 'GC', 'Owner', 'Architect', 'Engineer', 'AHJ', 'Vendor', 'Subcontractor'],
  safety_type: ['Toolbox Talk', 'Site Inspection', 'Near Miss', 'First Aid', 'Recordable Injury', 'Property Damage', 'QC Inspection', 'Punch Item', 'Observation', 'AHJ Inspection'],
  severity: ['Info', 'Low', 'Medium', 'High', 'Critical'],
  milestone_status: ['Not Started', 'On Track', 'At Risk', 'Late', 'Complete'],
  bill_status: ['Draft', 'Submitted', 'Approved', 'Paid', 'Short Paid', 'Disputed'],
  phases: ['P0', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8', 'P9'],
};
const CLOSED_DOC = new Set(['Answered', 'Approved', 'Approved as Noted', 'Rejected', 'Closed', 'Void']);
// CO status ↔ the estimate status that drives the contract
const CO_TO_EST = { Draft: 'draft', Pending: 'draft', Submitted: 'sent', Approved: 'approved', Rejected: 'declined', Void: 'cancelled' };
const EST_TO_CO = { draft: 'Draft', sent: 'Submitted', viewed: 'Submitted', approved: 'Approved', declined: 'Rejected', expired: 'Rejected', cancelled: 'Void' };

module.exports = function workbookRoutes(app, db, X) {
  const { wrap, bad, insert, update, mustGet, pick, P, baseUrl } = X;
  const s = () => D.settings(db);
  const isOffice = u => u.role === 'admin' || u.role === 'office';
  const project = (req, id, { write = false } = {}) => {
    const j = mustGet('jobs', id);
    if (!j.is_project) throw bad('That job is not set up as a commercial project');
    if (!isOffice(req.user) && (write || !P.canSee(req, j))) throw bad('Office only', 403);
    return j;
  };
  const retPct = (job, app) => app && app.retainage_pct != null ? app.retainage_pct : (job.retainage_pct || Number(s().default_retainage_pct) || 0);

  // ================================================================ SOV
  function sovLines(job) {
    const lines = all(db, 'SELECT * FROM sov_lines WHERE job_id = ? ORDER BY sort, id', job.id);
    const billed = new Map(all(db, `SELECT l.sov_line_id, SUM(l.work_this_period) w FROM pay_app_lines l JOIN pay_apps a ON a.id = l.pay_app_id WHERE a.job_id = ? GROUP BY l.sov_line_id`, job.id).map(r => [r.sov_line_id, r.w]));
    const lastApp = get(db, 'SELECT id FROM pay_apps WHERE job_id = ? ORDER BY app_no DESC LIMIT 1', job.id);
    const stored = new Map(lastApp ? all(db, 'SELECT sov_line_id, stored_balance FROM pay_app_lines WHERE pay_app_id = ?', lastApp.id).map(r => [r.sov_line_id, r.stored_balance]) : []);
    // cost to date by division (labor + material + other), from the cost-code progress rows
    const divCost = new Map();
    const divOf = new Map(all(db, 'SELECT id, division FROM cost_codes').map(c => [c.id, c.division]));
    for (const c of P.codeRows(job)) { const d = divOf.get(c.cost_code_id); if (d) divCost.set(d, (divCost.get(d) || 0) + c.total_cost); }
    return lines.map((l, i) => {
      const sv = r2(l.override_value != null ? l.override_value : l.calc_value);
      const done = r2(billed.get(l.id) || 0), st = r2(stored.get(l.id) || 0), cost = r2(['MOB', 'CO'].includes(l.division) ? 0 : divCost.get(l.division) || 0);
      return { ...l, line_no: i + 1, scheduled_value: sv, completed_to_date: done, stored, completed_and_stored: r2(done + st), pct: sv ? r2((done + st) / sv * 100) : 0,
        balance: r2(sv - done - st), cost_to_date: cost, gain_loss: ['MOB', 'CO'].includes(l.division) ? null : r2(done - cost) };
    });
  }
  function sovSummary(job) {
    const lines = sovLines(job), cv = Bill.contractValue(db, job);
    const tot = k => r2(lines.reduce((t, l) => t + (l[k] || 0), 0));
    return { lines, contract: cv, totals: { scheduled_value: tot('scheduled_value'), completed_to_date: tot('completed_to_date'), stored: tot('stored'), completed_and_stored: tot('completed_and_stored'), balance: tot('balance'), cost_to_date: tot('cost_to_date') },
      variance: r2(tot('scheduled_value') - cv.total), mobilization_pct: job.mobilization_pct ?? Number(s().mobilization_pct || 5) };
  }
  // Suggested values: mobilization % of the base contract, the rest spread over divisions by budgeted cost; one line per approved CO.
  function buildSov(job, mobPct) {
    const cv = Bill.contractValue(db, job);
    const L = Bill.laborPricer(db, job), byDiv = new Map();
    for (const b of all(db, `SELECT jb.*, cc.division, cc.division_name FROM job_budgets jb JOIN cost_codes cc ON cc.id = jb.cost_code_id WHERE jb.job_id = ? AND cc.division IS NOT NULL`, job.id)) {
      const x = byDiv.get(b.division) || { division: b.division, division_name: b.division_name, w: 0 };
      x.w += (L.crew || L.rate(b.cost_code_id) ? L.cost(b.cost_code_id, b.budget_hours) : (b.budget_hours || 0)) + (b.budget_material || 0) + (b.budget_other || 0); byDiv.set(b.division, x);
    }
    const budgets = [...byDiv.values()].filter(b => b.w > 0).sort((a, b) => String(a.division).localeCompare(String(b.division)));
    const mob = r2(cv.base * mobPct / 100), rest = r2(cv.base - mob), W = budgets.reduce((t, b) => t + b.w, 0);
    const want = [{ division: 'MOB', description: 'Mobilization', calc: mob }];
    if (W > 0) {
      let left = rest;
      budgets.forEach((b, i) => { const v = i === budgets.length - 1 ? left : r2(rest * b.w / W); left = r2(left - v); want.push({ division: b.division, description: (b.division_name || b.division).replace(/^\d{2}\s+/, ''), calc: v }); });
    } else want.push({ division: '00', description: 'Contract work', calc: rest });
    for (const co of Bill.changeOrders(db, job.id).filter(c => c.status === 'approved')) want.push({ division: 'CO', co_estimate_id: co.id, description: `${co.number} ${co.title || 'Change order'}`, calc: co.amount });
    const existing = all(db, 'SELECT * FROM sov_lines WHERE job_id = ?', job.id);
    const used = new Set();
    want.forEach((w, i) => {
      const ex = existing.find(e => !used.has(e.id) && e.division === w.division && (w.division !== 'CO' || e.co_estimate_id === w.co_estimate_id));
      if (ex) { used.add(ex.id); run(db, 'UPDATE sov_lines SET calc_value = ?, sort = ? WHERE id = ?', w.calc, i, ex.id); }
      else insert('sov_lines', { job_id: job.id, division: w.division, co_estimate_id: w.co_estimate_id || null, description: w.description, calc_value: w.calc, sort: i });
    });
    // lines no longer suggested: drop if never billed, else keep at 0
    for (const e of existing.filter(e => !used.has(e.id))) {
      if (get(db, 'SELECT 1 x FROM pay_app_lines WHERE sov_line_id = ? AND (work_this_period != 0 OR stored_balance != 0)', e.id)) run(db, 'UPDATE sov_lines SET calc_value = 0 WHERE id = ?', e.id);
      else run(db, 'DELETE FROM sov_lines WHERE id = ?', e.id);
    }
    run(db, 'UPDATE jobs SET mobilization_pct = ? WHERE id = ?', mobPct, job.id);
  }
  app.get('/api/projects/:id/sov', wrap((req, res) => res.json(sovSummary(project(req, req.params.id)))));
  app.post('/api/projects/:id/sov/build', wrap((req, res) => {
    const job = project(req, req.params.id, { write: true });
    if (job.billing_type !== 'fixed') throw bad('A schedule of values is for quoted-price (fixed) contracts');
    const mob = req.body.mobilization_pct != null && req.body.mobilization_pct !== '' ? Number(req.body.mobilization_pct) : (job.mobilization_pct ?? Number(s().mobilization_pct || 5));
    if (!(mob >= 0 && mob < 50)) throw bad('Mobilization % must be between 0 and 50');
    buildSov(job, mob); res.json(sovSummary(mustGet('jobs', job.id)));
  }));
  app.put('/api/projects/:id/sov', wrap((req, res) => {
    const job = project(req, req.params.id, { write: true });
    for (const l of req.body.lines || []) {
      const cur = get(db, 'SELECT * FROM sov_lines WHERE id = ? AND job_id = ?', l.id, job.id); if (!cur) continue;
      const ov = l.override_value === '' || l.override_value == null ? null : Number(l.override_value);
      if (ov != null && !(ov >= 0)) throw bad('Scheduled values must be 0 or more');
      update('sov_lines', cur.id, { description: l.description || cur.description, override_value: ov, notes: l.notes ?? cur.notes });
    }
    for (const a of req.body.add || []) {
      if (!a.description) throw bad('Describe the SOV line');
      insert('sov_lines', { job_id: job.id, division: String(a.division || '00').slice(0, 4), description: a.description, calc_value: 0, override_value: Number(a.override_value) || 0, sort: 999 });
    }
    for (const id of req.body.remove || []) {
      if (get(db, 'SELECT 1 x FROM pay_app_lines WHERE sov_line_id = ? AND (work_this_period != 0 OR stored_balance != 0)', id)) throw bad('That line has been billed on a pay application and can\'t be removed');
      run(db, 'DELETE FROM sov_lines WHERE id = ? AND job_id = ?', id, job.id);
    }
    res.json(sovSummary(job));
  }));

  // ================================================================ pay applications (Billing Entry + Pay Apps)
  function payApps(job) {
    const apps = all(db, 'SELECT * FROM pay_apps WHERE job_id = ? ORDER BY app_no', job.id);
    const lines = all(db, 'SELECT l.* FROM pay_app_lines l JOIN pay_apps a ON a.id = l.pay_app_id WHERE a.job_id = ?', job.id);
    let F = 0, prevH = 0, prevJ = 0;
    return apps.map(a => {
      const mine = lines.filter(l => l.pay_app_id === a.id);
      const E = r2(mine.reduce((t, l) => t + l.work_this_period, 0)), G = r2(mine.reduce((t, l) => t + l.stored_balance, 0));
      F = r2(F + E); const H = r2(F + G), Dp = retPct(job, a);
      const I = r2(H - prevH), J = r2(H * Dp / 100), K = r2(J - prevJ), L = r2(I - K);
      const inv = a.invoice_id ? get(db, 'SELECT * FROM invoices WHERE id = ?', a.invoice_id) : null;
      const invT = inv ? C.invoiceWithTotals(db, inv) : null;
      const paid = invT && invT.paid ? invT.paid : (a.amount_paid || 0);
      const datePaid = a.date_paid || (invT && invT.status === 'paid' ? (get(db, 'SELECT MAX(paid_at) d FROM payments WHERE invoice_id = ?', inv.id) || {}).d : null);
      const out = { ...a, retainage_used: Dp, work_this_period: E, work_to_date: F, stored_balance: G, completed_and_stored: H, gross_this_app: I, retainage_to_date: J, retainage_this_app: K,
        net_due: L, amount_paid: r2(paid), date_paid: datePaid, days_to_pay: a.date_submitted ? days(a.date_submitted, datePaid || today()) : null, open_balance: r2(L - paid),
        invoice_number: inv ? inv.number : null, invoice_status: inv ? inv.status : null, locked: !!(inv && inv.status !== 'void'),
        status: inv && inv.status === 'paid' ? (paid + 0.005 < L ? 'Short Paid' : 'Paid') : a.status, lines: mine };
      prevH = H; prevJ = J; return out;
    });
  }
  const appOf = (req, id) => { const a = mustGet('pay_apps', id); const job = project(req, a.job_id, { write: true }); return { a, job }; };
  app.get('/api/projects/:id/pay-apps', wrap((req, res) => {
    const job = project(req, req.params.id);
    res.json({ sov: sovSummary(job), apps: payApps(job), lists: { bill_status: LISTS.bill_status }, retainage_pct: retPct(job) });
  }));
  app.post('/api/projects/:id/pay-apps', wrap((req, res) => {
    const job = project(req, req.params.id, { write: true });
    if (!get(db, 'SELECT 1 x FROM sov_lines WHERE job_id = ?', job.id)) throw bad('Build the schedule of values first (SOV tab)');
    // one way of billing per contract: progress invoices made outside pay applications would be billed twice
    const prior = all(db, "SELECT number FROM invoices WHERE job_id = ? AND status != 'void' AND COALESCE(billing_kind, 'standard') NOT IN ('pay_app', 'tm', 'standard')", job.id);
    if (prior.length) throw bad(`This project already has progress invoice(s) ${prior.map(i => i.number).join(', ')} from the job's Billing tab. Pay applications would bill that work again. Void those invoices first, or keep billing from the Billing tab.`);
    const period = String(req.body.period_to || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(period)) throw bad('Enter the Period To date');
    const last = get(db, 'SELECT * FROM pay_apps WHERE job_id = ? ORDER BY app_no DESC LIMIT 1', job.id);
    if (last && period <= last.period_to) throw bad(`Period To must be after App #${last.app_no} (${last.period_to})`);
    const id = insert('pay_apps', { job_id: job.id, app_no: last ? last.app_no + 1 : 1, period_to: period, retainage_pct: req.body.retainage_pct === '' || req.body.retainage_pct == null ? null : Number(req.body.retainage_pct) });
    // stored materials carry forward until billed in place
    for (const l of all(db, 'SELECT id FROM sov_lines WHERE job_id = ?', job.id)) {
      const prev = last ? get(db, 'SELECT stored_balance FROM pay_app_lines WHERE pay_app_id = ? AND sov_line_id = ?', last.id, l.id) : null;
      insert('pay_app_lines', { pay_app_id: id, sov_line_id: l.id, work_this_period: 0, stored_balance: prev ? prev.stored_balance : 0 });
    }
    res.json({ id });
  }));
  app.put('/api/pay-apps/:id', wrap((req, res) => {
    const { a, job } = appOf(req, req.params.id);
    const apps = payApps(job), me = apps.find(x => x.id === a.id);
    const meta = pick(req.body, ['status', 'date_submitted', 'date_paid', 'amount_paid', 'customer_ref', 'notes']);
    if (meta.status && !LISTS.bill_status.includes(meta.status)) throw bad('Unknown status');
    if (req.body.lines || req.body.period_to !== undefined || req.body.retainage_pct !== undefined) {
      if (me.locked) throw bad(`App #${a.app_no} is on invoice ${me.invoice_number}. Void that invoice to change the billing.`);
      if (req.body.period_to !== undefined) meta.period_to = String(req.body.period_to).slice(0, 10);
      if (req.body.retainage_pct !== undefined) meta.retainage_pct = req.body.retainage_pct === '' || req.body.retainage_pct == null ? null : Number(req.body.retainage_pct);
      const sov = sovLines(job);
      for (const l of req.body.lines || []) {
        const line = sov.find(x => x.id === Number(l.sov_line_id)); if (!line) continue;
        const work = Number(l.work_this_period) || 0, stored = Math.max(0, Number(l.stored_balance) || 0);
        const others = r2(all(db, 'SELECT SUM(work_this_period) w FROM pay_app_lines WHERE sov_line_id = ? AND pay_app_id != ?', line.id, a.id)[0].w || 0);
        if (others + work + stored > line.scheduled_value + 0.005) throw bad(`${line.description}: work to date plus stored (${r2(others + work + stored)}) is more than its scheduled value (${line.scheduled_value})`);
        run(db, `INSERT INTO pay_app_lines (pay_app_id, sov_line_id, work_this_period, stored_balance) VALUES (?,?,?,?)
          ON CONFLICT(pay_app_id, sov_line_id) DO UPDATE SET work_this_period = excluded.work_this_period, stored_balance = excluded.stored_balance`, a.id, line.id, r2(work), r2(stored));
      }
    }
    if (Object.keys(meta).length) update('pay_apps', a.id, meta);
    res.json(payApps(job).find(x => x.id === a.id));
  }));
  app.delete('/api/pay-apps/:id', wrap((req, res) => {
    const { a, job } = appOf(req, req.params.id);
    const last = get(db, 'SELECT id FROM pay_apps WHERE job_id = ? ORDER BY app_no DESC LIMIT 1', job.id);
    if (last.id !== a.id) throw bad('Only the latest pay application can be deleted');
    if (payApps(job).find(x => x.id === a.id).locked) throw bad('Void its invoice first');
    run(db, 'DELETE FROM pay_apps WHERE id = ?', a.id); res.json({ ok: true });
  }));
  // Invoice for a pay app: each SOV line's work this period + change in stored materials, less retainage this app.
  function invoicePayApp(job, a, { issueDate = null } = {}) {
    const apps = payApps(job), i = apps.findIndex(x => x.id === a.id), me = apps[i], prev = apps[i - 1];
    if (me.locked) throw bad(`Already on invoice ${me.invoice_number}`);
    if (prev && !prev.locked) throw bad(`Invoice App #${prev.app_no} first`);
    if (Math.abs(me.gross_this_app) < 0.005 && Math.abs(me.retainage_this_app) < 0.005) throw bad('Nothing billed on this application yet');
    const sov = sovLines(job);
    const prevStored = new Map(prev ? prev.lines.map(l => [l.sov_line_id, l.stored_balance]) : []);
    const inv = Bill.newInvoice(db, job, { kind: 'pay_app', periodTo: me.period_to, notes: `Application for Payment #${me.app_no} · period to ${me.period_to}`, taxRate: 0 });
    for (const l of me.lines) {
      const line = sov.find(x => x.id === l.sov_line_id); if (!line) continue;
      const amt = r2(l.work_this_period + l.stored_balance - (prevStored.get(l.sov_line_id) || 0));
      if (Math.abs(amt) >= 0.005) inv.line({ description: `${line.division === 'MOB' ? 'MOB' : line.division} ${line.description}`, unit_price: amt, taxable: 0 });
    }
    if (me.retainage_this_app > 0.004) inv.line({ description: `Less retainage withheld (${me.retainage_used}%)`, unit_price: -me.retainage_this_app, taxable: 0 });
    else if (me.retainage_this_app < -0.004) inv.line({ description: 'Retainage release', unit_price: -me.retainage_this_app, taxable: 0 });
    run(db, 'UPDATE invoices SET retainage = ?, title = ? WHERE id = ?', me.retainage_this_app, `${job.title} — Pay App #${me.app_no}`, inv.id);
    if (issueDate) run(db, 'UPDATE invoices SET issue_date = ? WHERE id = ?', issueDate, inv.id);
    run(db, "UPDATE pay_apps SET invoice_id = ?, status = 'Submitted', date_submitted = COALESCE(date_submitted, ?) WHERE id = ?", inv.id, issueDate || today(), a.id);
    return inv.id;
  }
  app.post('/api/pay-apps/:id/invoice', wrap((req, res) => { const { a, job } = appOf(req, req.params.id); res.json({ invoice_id: invoicePayApp(job, a) }); }));
  // AIA G702 summary + G703 continuation sheet for one application
  app.get('/api/pay-apps/:id/print', wrap((req, res) => {
    const a = mustGet('pay_apps', req.params.id), job = project(req, a.job_id);
    const apps = payApps(job), i = apps.findIndex(x => x.id === a.id), me = apps[i], prev = apps[i - 1];
    const sov = sovLines(job), cv = Bill.contractValue(db, job);
    const prevWork = new Map(), prevStored = new Map(prev ? prev.lines.map(l => [l.sov_line_id, l.stored_balance]) : []);
    for (const x of apps.slice(0, i)) for (const l of x.lines) prevWork.set(l.sov_line_id, (prevWork.get(l.sov_line_id) || 0) + l.work_this_period);
    const g703 = sov.map((line, k) => {
      const l = me.lines.find(x => x.sov_line_id === line.id) || { work_this_period: 0, stored_balance: 0 };
      const from = r2(prevWork.get(line.id) || 0), now = r2(l.work_this_period), st = r2(l.stored_balance), tot = r2(from + now + st);
      return { item: k + 1, division: line.division, description: line.description, scheduled_value: line.scheduled_value, from_previous: from, this_period: now, stored: st,
        completed_and_stored: tot, pct: line.scheduled_value ? r2(tot / line.scheduled_value * 100) : 0, balance: r2(line.scheduled_value - tot), retainage: r2(tot * me.retainage_used / 100) };
    });
    const company = s(), cust = get(db, 'SELECT * FROM customers WHERE id = ?', job.customer_id);
    const loc = job.location_id ? get(db, 'SELECT * FROM locations WHERE id = ?', job.location_id) : null;
    const prevCerts = r2(apps.slice(0, i).reduce((t, x) => t + x.net_due, 0));
    const earnedLessRet = r2(me.completed_and_stored - me.retainage_to_date);
    res.json({
      company: { name: company.company_name, address: company.company_address, phone: company.company_phone, license: company.license_number },
      project: { number: job.number, title: job.title, address: loc ? [loc.address, loc.city, loc.state, loc.zip].filter(Boolean).join(', ') : '', customer: cust.company || cust.name },
      app: { no: me.app_no, period_to: me.period_to, retainage_pct: me.retainage_used, status: me.status, invoice_number: me.invoice_number },
      g702: { original_contract: cv.base, change_orders: cv.change_orders, contract_to_date: cv.total, completed_and_stored: me.completed_and_stored,
        retainage: me.retainage_to_date, earned_less_retainage: earnedLessRet, previous_certificates: prevCerts, current_due: r2(earnedLessRet - prevCerts),
        balance_to_finish: r2(cv.total - earnedLessRet) },
      g703,
    });
  }));

  // ================================================================ change orders (estimates with change_order = 1)
  function coRows(job) {
    const rows = all(db, 'SELECT * FROM estimates WHERE job_id = ? AND change_order = 1 ORDER BY id', job.id);
    return rows.map((e, i) => {
      const t = C.estimateWithTotals(db, e);
      const items = all(db, 'SELECT ei.*, pb.kind, cc.code FROM estimate_items ei LEFT JOIN pricebook pb ON pb.id = ei.pricebook_id LEFT JOIN cost_codes cc ON cc.id = ei.cost_code_id WHERE ei.estimate_id = ?', e.id);
      const isLabor = it => it.kind === 'labor' || /\blabor\b/i.test(it.description);
      const labor = items.filter(isLabor);
      const status = e.co_status || EST_TO_CO[e.status] || 'Draft';
      const sell = r2(t.subtotal - t.discount), cost = r2(t.est_cost);
      const submitted = e.co_submitted_at || e.sent_at;
      return { id: e.id, co_no: i + 1, number: e.number, date_initiated: (e.created_at || '').slice(0, 10), description: e.title, type: e.co_type || null, status,
        cost_code: (items.find(it => it.code) || {}).code || null, labor_hrs: r2(labor.reduce((x, it) => x + (Number(it.qty) || 0), 0)), labor_cost: r2(labor.reduce((x, it) => x + it.qty * (it.unit_cost || 0), 0)),
        total_cost: cost, sell_price: sell, margin: r2(sell - cost), margin_pct: sell ? r2((sell - cost) / sell * 100) : null, days_added: e.co_days_added, submitted: submitted ? String(submitted).slice(0, 10) : null,
        approved: e.approved_at ? String(e.approved_at).slice(0, 10) : null, days_open: submitted && !e.approved_at && !['Rejected', 'Void'].includes(status) ? days(String(submitted).slice(0, 10), today()) : null,
        reference: e.co_reference, estimate_status: e.status };
    });
  }
  app.get('/api/projects/:id/change-orders', wrap((req, res) => {
    const job = project(req, req.params.id);
    const rows = coRows(job), cfg = s();
    const sum = (f, st) => r2(rows.filter(r => st.includes(r.status)).reduce((t, r) => t + r[f], 0));
    res.json({ rows, lists: { co_status: LISTS.co_status, co_type: LISTS.co_type }, defaults: { oh_pct: Number(cfg.co_overhead_pct ?? 18), profit_pct: Number(cfg.co_profit_pct ?? 15), tax_pct: Number(cfg.material_tax_pct ?? 6), labor_rate: r2(Bill.laborRate(db, job)) },
      totals: { approved: sum('sell_price', ['Approved']), pending: sum('sell_price', ['Draft', 'Pending', 'Submitted']), approved_cost: sum('total_cost', ['Approved']) } });
  }));
  // Price a CO the way the workbook does: labor hrs × blended rate + material (+ tax) + equipment + sub + other; sell = cost × (1+OH) × (1+profit).
  app.post('/api/projects/:id/change-orders', wrap((req, res) => {
    const job = project(req, req.params.id, { write: true });
    const b = req.body, cfg = s();
    if (!String(b.description || '').trim()) throw bad('Describe the change');
    if (b.type && !LISTS.co_type.includes(b.type)) throw bad('Unknown CO type');
    const n = k => Math.max(0, Number(b[k]) || 0);
    const oh = b.oh_pct === '' || b.oh_pct == null ? Number(cfg.co_overhead_pct ?? 18) : Number(b.oh_pct), pr = b.profit_pct === '' || b.profit_pct == null ? Number(cfg.co_profit_pct ?? 15) : Number(b.profit_pct);
    const mult = (1 + oh / 100) * (1 + pr / 100), rate = r2(Bill.laborRate(db, job)), tax = r2(n('material') * Number(cfg.material_tax_pct ?? 6) / 100);
    const cc = b.cost_code_id || null;
    const items = [];
    if (n('labor_hrs')) items.push({ description: 'Labor', qty: n('labor_hrs'), unit_cost: rate, unit_price: r2(rate * mult) });
    for (const [k, d] of [['material', 'Material'], ['equipment', 'Equipment'], ['sub', 'Subcontract'], ['other', 'Other']]) if (n(k)) items.push({ description: d, qty: 1, unit_cost: n(k), unit_price: r2(n(k) * mult) });
    if (tax) items.push({ description: `Sales tax on material (${cfg.material_tax_pct ?? 6}%)`, qty: 1, unit_cost: tax, unit_price: r2(tax * mult) });
    if (!items.length) throw bad('Enter labor hours or a cost');
    const eid = insert('estimates', { number: D.nextNumber(db, 'estimates', 'EST'), customer_id: job.customer_id, location_id: job.location_id, job_id: job.id, change_order: 1,
      title: String(b.description).slice(0, 300), notes: b.notes || null, tax_rate: 0, public_token: D.token(), created_by: req.user.id, status: 'draft',
      co_type: b.type || null, co_status: 'Draft', co_days_added: b.days_added === '' || b.days_added == null ? null : Number(b.days_added), co_reference: b.reference || null });
    items.forEach((it, i) => insert('estimate_items', { estimate_id: eid, description: it.description, qty: it.qty, unit_price: it.unit_price, unit_cost: it.unit_cost, taxable: 0, cost_code_id: cc, sort: i }));
    res.json({ id: eid, sell_price: r2(items.reduce((t, it) => t + it.qty * it.unit_price, 0)) });
  }));
  app.put('/api/change-orders/:id', wrap((req, res) => {
    const e = mustGet('estimates', req.params.id);
    if (!e.change_order || !e.job_id) throw bad('Not a change order');
    const job = project(req, e.job_id, { write: true });
    const b = req.body, data = {};
    if (b.type !== undefined) { if (b.type && !LISTS.co_type.includes(b.type)) throw bad('Unknown CO type'); data.co_type = b.type || null; }
    if (b.days_added !== undefined) data.co_days_added = b.days_added === '' || b.days_added == null ? null : Number(b.days_added);
    if (b.reference !== undefined) data.co_reference = b.reference || null;
    if (b.description) data.title = String(b.description).slice(0, 300);
    if (b.status) {
      if (!LISTS.co_status.includes(b.status)) throw bad('Unknown CO status');
      if (e.status === 'approved' && b.status !== 'Approved' && get(db, "SELECT 1 x FROM sov_lines s JOIN pay_app_lines l ON l.sov_line_id = s.id WHERE s.co_estimate_id = ? AND l.work_this_period != 0", e.id))
        throw bad('This change order has been billed on a pay application. Void that first.');
      data.co_status = b.status; data.status = CO_TO_EST[b.status];
      if (b.status === 'Approved' && !e.approved_at) data.approved_at = new Date().toISOString();
      if (b.status === 'Submitted' && !e.co_submitted_at) { data.co_submitted_at = today(); if (!e.sent_at) data.sent_at = new Date().toISOString(); }
      if (b.status === 'Void') { data.cancelled_at = new Date().toISOString(); }
    }
    update('estimates', e.id, data);
    // an approved CO gets its own SOV line (when the job has an SOV)
    if (b.status === 'Approved' && get(db, 'SELECT 1 x FROM sov_lines WHERE job_id = ?', job.id) && !get(db, 'SELECT 1 x FROM sov_lines WHERE co_estimate_id = ?', e.id)) {
      const amt = r2((t => t.subtotal - t.discount)(C.estimateWithTotals(db, mustGet('estimates', e.id))));
      insert('sov_lines', { job_id: job.id, division: 'CO', co_estimate_id: e.id, description: `${e.number} ${data.title || e.title || 'Change order'}`, calc_value: amt, sort: 900 });
    }
    if (b.status && b.status !== 'Approved') run(db, 'UPDATE sov_lines SET calc_value = 0 WHERE co_estimate_id = ? AND NOT EXISTS (SELECT 1 FROM pay_app_lines l WHERE l.sov_line_id = sov_lines.id AND l.work_this_period != 0)', e.id);
    res.json({ ok: true });
  }));

  // ================================================================ RFI & submittal log, safety & quality log, milestones
  const RFI_FIELDS = ['type', 'number', 'subject', 'spec_section', 'cost_code_id', 'date_sent', 'date_needed', 'date_returned', 'status', 'ball_in_court', 'cost_impact', 'sched_impact_days', 'co_estimate_id', 'notes'];
  const SQ_FIELDS = ['date', 'type', 'description', 'severity', 'reported_by', 'corrective_action', 'owner', 'due_date', 'closed_date', 'recordable', 'lost_time_days', 'ref'];
  const MS_FIELDS = ['name', 'phase', 'baseline_date', 'forecast_date', 'actual_date', 'owner', 'critical', 'impacts_billing', 'notes', 'sort'];
  const rfiRows = job => {
    const counter = {};
    return all(db, 'SELECT r.*, cc.code cost_code, e.number co_number FROM rfis r LEFT JOIN cost_codes cc ON cc.id = r.cost_code_id LEFT JOIN estimates e ON e.id = r.co_estimate_id WHERE r.job_id = ? ORDER BY r.id', job.id).map(r => {
      const pre = String(r.type || 'RFI').slice(0, 3).toUpperCase(); counter[pre] = (counter[pre] || 0) + 1;
      const open = !CLOSED_DOC.has(r.status);
      return { ...r, ref: `${pre}-${String(counter[pre]).padStart(3, '0')}`, days_open: r.date_sent ? days(r.date_sent, r.date_returned || today()) : null,
        days_late: r.date_needed ? Math.max(0, days(r.date_needed, r.date_returned || today())) : null, overdue: open && !!r.date_needed && r.date_needed < today(), open };
    });
  };
  const sqRows = job => all(db, 'SELECT * FROM safety_items WHERE job_id = ? ORDER BY date, id', job.id).map((x, i) => ({ ...x, ref_id: `SQ-${String(i + 1).padStart(3, '0')}`,
    status: x.closed_date ? 'Closed' : x.due_date && x.due_date < today() ? 'Overdue' : 'Open', days_open: days(x.date, x.closed_date || today()) }));
  const msRows = job => all(db, 'SELECT * FROM project_milestones WHERE job_id = ? ORDER BY sort, COALESCE(baseline_date, forecast_date), id', job.id).map((m, i) => {
    const when = m.actual_date || m.forecast_date;
    const status = m.actual_date ? 'Complete' : !m.forecast_date && !m.baseline_date ? 'Not Started' : (when && when < today()) ? 'Late' : (m.baseline_date && when && when > m.baseline_date) ? 'At Risk' : 'On Track';
    return { ...m, ref: `M-${String(i + 1).padStart(3, '0')}`, variance_days: m.baseline_date && when ? days(m.baseline_date, when) : null, status, days_to_go: !m.actual_date && m.forecast_date ? days(today(), m.forecast_date) : null };
  });
  const clean = (body, fields) => { const d = pick(body, fields); for (const k of Object.keys(d)) if (d[k] === '') d[k] = null; return d; };
  function crud(kind, table, fields, rows, { required, validate, canWrite }) {
    app.get(`/api/projects/:id/${kind}`, wrap((req, res) => res.json({ rows: rows(project(req, req.params.id)), lists: LISTS })));
    app.post(`/api/projects/:id/${kind}`, wrap((req, res) => {
      const job = project(req, req.params.id, { write: !(canWrite && canWrite(req, mustGet('jobs', req.params.id))) });
      const d = clean(req.body, fields);
      for (const f of required) if (!d[f]) throw bad(`${f.replace(/_/g, ' ')} is required`);
      if (validate) validate(d);
      res.json({ id: insert(table, { ...d, job_id: job.id, ...(table !== 'project_milestones' ? { created_by: req.user.id } : {}) }) });
    }));
    app.put(`/api/${kind}/:id`, wrap((req, res) => {
      const row = mustGet(table, req.params.id);
      const job = mustGet('jobs', row.job_id);
      project(req, job.id, { write: !(canWrite && canWrite(req, job) && row.created_by === req.user.id) });
      const d = clean(req.body, fields); if (validate) validate({ ...row, ...d });
      update(table, row.id, d); res.json({ ok: true });
    }));
    app.delete(`/api/${kind}/:id`, wrap((req, res) => {
      const row = mustGet(table, req.params.id); project(req, row.job_id, { write: true });
      run(db, `DELETE FROM ${table} WHERE id = ?`, row.id); res.json({ ok: true });
    }));
  }
  crud('rfis', 'rfis', RFI_FIELDS, rfiRows, { required: ['subject'], validate: d => {
    if (d.type && !LISTS.rfi_type.includes(d.type)) throw bad('Unknown type'); if (d.status && !LISTS.doc_status.includes(d.status)) throw bad('Unknown status');
    if (d.ball_in_court && !LISTS.ball_in_court.includes(d.ball_in_court)) throw bad('Unknown ball in court'); } });
  // anyone on the project who can write daily logs can report a safety / quality item (near miss, punch item...)
  crud('safety', 'safety_items', SQ_FIELDS, sqRows, { required: ['date', 'type', 'description'], canWrite: (req, job) => req.can('daily_logs') && P.canSee(req, job), validate: d => {
    if (d.type && !LISTS.safety_type.includes(d.type)) throw bad('Unknown type'); if (d.severity && !LISTS.severity.includes(d.severity)) throw bad('Unknown severity'); } });
  crud('milestones', 'project_milestones', MS_FIELDS, msRows, { required: ['name'] });

  // ================================================================ Schedule & Gantt
  // Start, finish and budget hours drive the Gantt. Planned % is time-based against the as-of date (the workbook's
  // PerEnd); earned = budget × % complete; actual hours come from time entries on the task's cost code (or, with no
  // code, any code in the task's phase) between its start and finish — the same SUMIFS the Schedule tab uses.
  const ymd = s => (s ? String(s).slice(0, 10) : null);
  const addD = (s, n) => new Date(Date.parse(s) + n * 864e5).toISOString().slice(0, 10);
  const dow = s => new Date(Date.parse(s)).getUTCDay();
  const r1 = n => Math.round((Number(n) || 0) * 10) / 10;
  const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
  // Excel NETWORKDAYS: Mon–Fri between two dates, both ends counted; negative when b is before a
  const netDays = (a, b) => {
    if (b < a) return -netDays(b, a);
    const total = days(a, b) + 1, full = Math.floor(total / 7); let n = full * 5;
    for (let i = full * 7; i < total; i++) { const d = (dow(a) + i) % 7; if (d !== 0 && d !== 6) n++; }
    return n;
  };
  const mondayOf = s => addD(s, -((dow(s) + 6) % 7));
  const schedCfg = () => { const c = s(); const n = (k, d) => (Number(c[k]) > 0 ? Number(c[k]) : d);
    return { hours_per_day: n('sched_hours_per_day', 8), days_per_week: n('sched_days_per_week', 5), availability: n('sched_crew_availability', 0.92), max_crew: n('sched_max_crew', 10) }; };
  const TASK_STATUS = ['Not Started', 'In Progress', 'Complete', 'On Hold'];   // the Lists tab; the sheet also derives Late, Late Start, Update %, By Others
  const TASK_FIELDS = ['phase', 'area', 'name', 'cost_code_id', 'start_date', 'finish_date', 'predecessor_id', 'responsible', 'budget_hours', 'pct_complete', 'on_hold', 'notes', 'sort'];

  // craft class for the Manpower Loading split (the Labor Log's Class column): the job's foreman, else the employee's title
  const CLASSES = ['Foreman', 'Journeyman', 'Apprentice', 'Office'];
  const classOf = (u, job) => u.user_id === job.foreman_id || /foreman|super/i.test(u.title || '') ? 'Foreman' : /apprent/i.test(u.title || '') ? 'Apprentice'
    : (u.role === 'office' || u.role === 'admin') && !/journey|electric|wireman|master/i.test(u.title || '') ? 'Office' : 'Journeyman';
  // overtime the way payroll counts it: hours past the weekly threshold (Mon–Sun, all jobs) are OT, in clock-in order
  function overtimeByEntry(userIds) {
    const out = new Map(); if (!userIds.length) return out;
    const after = Number(s().overtime_weekly_hours) || 40, now = new Date().toISOString(), acc = new Map();
    for (const t of all(db, `SELECT id, user_id, clock_in, clock_out FROM time_entries WHERE user_id IN (${userIds.map(() => '?').join(',')}) ORDER BY clock_in, id`, ...userIds)) {
      const k = `${t.user_id}|${mondayOf(localDate(t.clock_in))}`, h = Math.max(0, (Date.parse(t.clock_out || now) - Date.parse(t.clock_in)) / 36e5), a = acc.get(k) || 0;
      out.set(t.id, Math.max(0, h - Math.max(0, after - a))); acc.set(k, a + h);
    }
    return out;
  }
  function laborEntries(job) {
    const now = new Date().toISOString();
    const rows = all(db, `SELECT t.id, t.user_id, t.clock_in, t.clock_out, t.cost_code_id, t.hourly_cost, cc.phase, u.title, u.role FROM time_entries t
      JOIN users u ON u.id = t.user_id LEFT JOIN cost_codes cc ON cc.id = t.cost_code_id WHERE t.job_id = ?`, job.id);
    const ot = overtimeByEntry([...new Set(rows.map(t => t.user_id))]);
    return rows.map(t => { const hours = Math.max(0, (Date.parse(t.clock_out || now) - Date.parse(t.clock_in)) / 36e5);
      return { id: t.id, user_id: t.user_id, date: localDate(t.clock_in), hours, code: t.cost_code_id, phase: t.phase, cls: classOf(t, job), ot: Math.min(hours, ot.get(t.id) || 0), cost: hours * (t.hourly_cost || 0) }; });
  }
  function taskRows(job, asOf = today(), entries = laborEntries(job)) {
    const tasks = all(db, `SELECT t.*, cc.code cost_code, cc.name cost_code_name FROM project_tasks t LEFT JOIN cost_codes cc ON cc.id = t.cost_code_id
      WHERE t.job_id = ? ORDER BY t.sort, t.start_date IS NULL, t.start_date, t.id`, job.id);
    const ref = new Map(tasks.map((t, i) => [t.id, `T-${String(i + 1).padStart(3, '0')}`]));
    const byId = new Map(tasks.map(t => [t.id, t]));
    return tasks.map(t => {
      const st = ymd(t.start_date), fin = ymd(t.finish_date), bud = t.budget_hours, pct = t.pct_complete;
      const earned = bud != null ? r1(bud * (pct || 0) / 100) : null;
      const plannedPct = st && fin ? Math.min(1, Math.max(0, (days(st, asOf) + 1) / Math.max(1, days(st, fin) + 1))) : null;
      const planned = bud != null && plannedPct != null ? r1(bud * plannedPct) : null;
      const until = fin || asOf;
      const actual = st && (t.cost_code_id || t.phase)
        ? r1(entries.filter(e => e.date >= st && e.date <= until && (t.cost_code_id ? e.code === t.cost_code_id : e.phase === t.phase)).reduce((x, e) => x + e.hours, 0)) : null;
      const status = t.on_hold ? 'On Hold' : !t.phase && bud == null ? 'By Others' : pct == null && st && asOf >= st ? 'Update %' : pct >= 100 ? 'Complete'
        : !(pct > 0) ? (st && asOf > st ? 'Late Start' : 'Not Started') : fin && asOf > fin ? 'Late' : 'In Progress';
      const pred = t.predecessor_id ? byId.get(t.predecessor_id) : null;
      const succStarts = tasks.filter(x => x.predecessor_id === t.id && x.start_date).map(x => ymd(x.start_date)).sort();
      return { ...t, ref: ref.get(t.id), job_number: job.number, work_days: st && fin ? netDays(st, fin) : null, pred_ref: pred ? ref.get(pred.id) : null,
        pred_conflict: !!(pred && pred.finish_date && st && st <= ymd(pred.finish_date)),
        earned_hours: earned, planned_pct: plannedPct != null ? Math.round(plannedPct * 1000) / 10 : null, planned_hours: planned, actual_hours: actual,
        hours_variance: actual != null ? r1((earned || 0) - actual) : null, spi: planned ? Math.round(earned / planned * 100) / 100 : null, status,
        float_days: fin && succStarts.length ? netDays(fin, succStarts[0]) - 2 : null,
        lookahead: !!(st && fin && status !== 'Complete' && fin >= addD(asOf, -7) && st <= addD(asOf, 14)) };
    });
  }
  // the Manpower Loading tab's planned/actual hours by week, from the same tasks
  function scheduleWeeks(job, rows, entries, cfg, win) {
    const dated = rows.filter(r => r.start_date && r.finish_date);
    const first = job.schedule_start || (dated.length ? dated.map(r => ymd(r.start_date)).sort()[0] : today());
    const start = win ? win.start : mondayOf(ymd(first));
    const last = [today(), ...dated.map(r => ymd(r.finish_date))].sort().pop();
    const n = win ? win.n : Math.min(104, Math.max(8, Math.ceil((days(start, last) + 1) / 7)));
    let cumP = 0, cumA = 0;
    return Array.from({ length: n }, (_, i) => {
      const ws = addD(start, i * 7), we = addD(ws, 6);
      const planned = r1(dated.reduce((x, r) => {
        const a = ymd(r.start_date), b = ymd(r.finish_date), lo = a > ws ? a : ws, hi = b < we ? b : we;
        return lo > hi || !r.budget_hours ? x : x + r.budget_hours * (days(lo, hi) + 1) / Math.max(1, days(a, b) + 1);
      }, 0));
      const wkE = entries.filter(e => e.date >= ws && e.date <= we), sumE = (f = () => true, k = 'hours') => r1(wkE.filter(f).reduce((x, e) => x + e[k], 0));
      const actual = sumE(), ot = sumE(undefined, 'ot');
      cumP += planned; cumA += actual;
      const crew = Math.round(planned / (cfg.hours_per_day * cfg.days_per_week * cfg.availability) * 10) / 10;
      return { wk: i + 1, week_start: ws, week_ending: we, planned_hours: planned, planned_crew: crew, actual_hours: actual,
        actual_crew: Math.round(actual / (cfg.hours_per_day * cfg.days_per_week) * 10) / 10, variance_hours: r1(actual - planned), cum_planned: r1(cumP), cum_actual: r1(cumA), over_max: crew > cfg.max_crew,
        by_class: Object.fromEntries(CLASSES.map(c => [c, sumE(e => e.cls === c)])), ot_hours: ot, ot_pct: actual ? Math.round(ot / actual * 1000) / 10 : null,
        headcount: new Set(wkE.map(e => e.user_id)).size };
    });
  }
  // % complete from the field: crew assigned to the job, its foreman, or someone who clocked in on it lately — not every tech who could clock in
  const canProgress = (req, job) => isOffice(req.user) ? req.can('projects') : (req.can('daily_logs') && P.onProject(req.user, job));
  app.get('/api/projects/:id/schedule', wrap((req, res) => {
    const job = project(req, req.params.id), asOf = isDate(req.query.as_of || '') ? req.query.as_of : today();
    const cfg = schedCfg(), entries = laborEntries(job), rows = taskRows(job, asOf, entries);
    const sum = k => r1(rows.reduce((x, r) => x + (r[k] || 0), 0));
    const totals = { budget_hours: sum('budget_hours'), earned_hours: sum('earned_hours'), planned_hours: sum('planned_hours'), actual_hours: sum('actual_hours') };
    totals.spi = totals.planned_hours ? Math.round(totals.earned_hours / totals.planned_hours * 100) / 100 : null;
    totals.pct_complete = totals.budget_hours ? Math.round(totals.earned_hours / totals.budget_hours * 1000) / 10 : null;
    res.json({ rows, as_of: asOf, schedule_start: job.schedule_start, weeks: scheduleWeeks(job, rows, entries, cfg), cfg, totals,
      lists: { phases: LISTS.phases, task_status: TASK_STATUS }, can_edit: isOffice(req.user) && req.can('projects'), can_progress: canProgress(req, job) });
  }));
  // ---- Manpower Loading: planned vs actual hours and crew by week, actual split by class, overtime
  const remainingPeak = weeks => Math.max(0, ...weeks.filter(w => w.week_ending >= today()).map(w => w.planned_crew));
  app.get('/api/projects/:id/manpower', wrap((req, res) => {
    const job = project(req, req.params.id), cfg = schedCfg(), entries = laborEntries(job);
    const weeks = scheduleWeeks(job, taskRows(job, today(), entries), entries, cfg);
    const t = k => r1(weeks.reduce((x, w) => x + (w[k] || 0), 0));
    res.json({ weeks, cfg, classes: CLASSES, totals: { planned_hours: t('planned_hours'), actual_hours: t('actual_hours'), ot_hours: t('ot_hours'),
      by_class: Object.fromEntries(CLASSES.map(c => [c, r1(weeks.reduce((x, w) => x + w.by_class[c], 0))])) },
      peak_planned_crew_remaining: remainingPeak(weeks), weeks_over_max: weeks.filter(w => w.over_max).length });
  }));
  // every open project together (the sheet's "ALL JOBS"): who needs how many people, week by week
  app.get('/api/manpower', wrap((req, res) => {
    if (!isOffice(req.user)) throw bad('Office only', 403);
    const cfg = schedCfg(), back = Math.min(26, Math.max(0, Number(req.query.back) || 4)), ahead = Math.min(52, Math.max(4, Number(req.query.ahead) || 16));
    const win = { start: addD(mondayOf(today()), -7 * back), n: back + ahead };
    const jobs = all(db, "SELECT * FROM jobs WHERE is_project = 1 AND status NOT IN ('completed', 'invoiced', 'cancelled') ORDER BY number");
    const per = jobs.map(job => { const e = laborEntries(job); return { job, e, weeks: scheduleWeeks(job, taskRows(job, today(), e), e, cfg, win) }; });
    const weeks = Array.from({ length: win.n }, (_, i) => {
      const ws = addD(win.start, i * 7), we = addD(ws, 6), col = per.map(p => p.weeks[i]);
      const sum = k => r1(col.reduce((x, w) => x + (w[k] || 0), 0));
      const planned = sum('planned_hours'), actual = sum('actual_hours'), ot = sum('ot_hours');
      const crew = Math.round(planned / (cfg.hours_per_day * cfg.days_per_week * cfg.availability) * 10) / 10;
      return { wk: i + 1, week_start: ws, week_ending: we, planned_hours: planned, planned_crew: crew, actual_hours: actual,
        actual_crew: Math.round(actual / (cfg.hours_per_day * cfg.days_per_week) * 10) / 10, variance_hours: r1(actual - planned), over_max: crew > cfg.max_crew,
        by_class: Object.fromEntries(CLASSES.map(c => [c, r1(col.reduce((x, w) => x + w.by_class[c], 0))])), ot_hours: ot, ot_pct: actual ? Math.round(ot / actual * 1000) / 10 : null,
        headcount: new Set(per.flatMap(p => p.e.filter(e => e.date >= ws && e.date <= we).map(e => e.user_id))).size };
    });
    res.json({ weeks, cfg, classes: CLASSES, today: today(),
      jobs: per.map(p => ({ id: p.job.id, number: p.job.number, title: p.job.title, planned_crew: p.weeks.map(w => w.planned_crew), actual_hours: p.weeks.map(w => w.actual_hours) })) });
  }));
  const cleanTask = (job, body, row = {}) => {
    const d = clean(body, TASK_FIELDS);
    for (const k of ['start_date', 'finish_date']) if (d[k] != null && !isDate(d[k])) throw bad(`${k.replace('_', ' ')} must be a date`);
    const m = { ...row, ...d };
    if (m.start_date && m.finish_date && m.finish_date < m.start_date) throw bad('Finish is before start');
    if (d.phase && !LISTS.phases.includes(d.phase)) throw bad('Unknown phase');
    for (const k of ['budget_hours', 'pct_complete', 'sort']) if (d[k] != null) { d[k] = Number(d[k]); if (!Number.isFinite(d[k]) || d[k] < 0) throw bad(`${k.replace('_', ' ')} must be a positive number`); }
    if (d.pct_complete > 100) throw bad('% complete is 0 to 100');
    if (d.on_hold !== undefined) d.on_hold = d.on_hold && d.on_hold !== '0' && d.on_hold !== 'false' ? 1 : 0;
    if (d.cost_code_id) mustGet('cost_codes', d.cost_code_id);
    if (d.predecessor_id) {
      const p = mustGet('project_tasks', d.predecessor_id);
      if (p.job_id !== job.id) throw bad('Predecessor is on another project');
      for (let x = p, hops = 0; x; x = x.predecessor_id ? get(db, 'SELECT * FROM project_tasks WHERE id = ?', x.predecessor_id) : null)
        if (x.id === row.id || ++hops > 500) throw bad('That predecessor would make a loop');
    }
    d.updated_at = new Date().toISOString();
    return d;
  };
  app.post('/api/projects/:id/schedule', wrap((req, res) => {
    const job = project(req, req.params.id, { write: true });
    const d = cleanTask(job, req.body);
    if (!d.name) throw bad('Task / activity is required');
    if (d.sort == null) d.sort = (get(db, 'SELECT MAX(sort) m FROM project_tasks WHERE job_id = ?', job.id).m || 0) + 10;
    res.json({ id: insert('project_tasks', { ...d, job_id: job.id }) });
  }));
  // the crew can post % complete from the field; everything else is the office's
  app.put('/api/schedule/:id', wrap((req, res) => {
    const row = mustGet('project_tasks', req.params.id), job = mustGet('jobs', row.job_id);
    const full = isOffice(req.user);
    project(req, job.id, { write: full });
    if (!canProgress(req, job)) throw bad('You cannot update this schedule', 403);
    const body = full ? req.body : pick(req.body || {}, ['pct_complete']);
    if (!full && body.pct_complete === undefined) throw bad('Only % complete can be updated from the field', 403);
    const d = cleanTask(job, body, row);
    if (d.name === null) throw bad('Task / activity is required');
    update('project_tasks', row.id, d); res.json({ ok: true });
  }));
  app.delete('/api/schedule/:id', wrap((req, res) => {
    const row = mustGet('project_tasks', req.params.id); project(req, row.job_id, { write: true });
    run(db, 'DELETE FROM project_tasks WHERE id = ?', row.id); res.json({ ok: true });
  }));
  // first pass at a schedule: one task per budgeted cost code that has no task yet, phase and hours from the budget
  app.post('/api/projects/:id/schedule/build', wrap((req, res) => {
    const job = project(req, req.params.id, { write: true });
    const have = new Set(all(db, 'SELECT cost_code_id FROM project_tasks WHERE job_id = ? AND cost_code_id IS NOT NULL', job.id).map(r => r.cost_code_id));
    const codes = all(db, `SELECT jb.cost_code_id, jb.budget_hours, cc.code, cc.name, cc.phase FROM job_budgets jb JOIN cost_codes cc ON cc.id = jb.cost_code_id
      WHERE jb.job_id = ? AND jb.budget_hours > 0 ORDER BY cc.phase, cc.code`, job.id).filter(c => !have.has(c.cost_code_id));
    if (!codes.length) throw bad(have.size ? 'Every budgeted labor code already has a task' : 'No labor hours budgeted by cost code yet — set the budget on the Cost Codes sheet first');
    let sort = (get(db, 'SELECT MAX(sort) m FROM project_tasks WHERE job_id = ?', job.id).m || 0);
    const start = job.start_date ? ymd(job.start_date) : null, finish = job.end_date ? ymd(job.end_date) : null;
    for (const c of codes) insert('project_tasks', { job_id: job.id, name: c.name, phase: LISTS.phases.includes(c.phase) ? c.phase : null, cost_code_id: c.cost_code_id,
      budget_hours: c.budget_hours, start_date: start, finish_date: start && finish && finish >= start ? finish : null, sort: sort += 10, updated_at: new Date().toISOString() });
    res.json({ added: codes.length });
  }));
  app.put('/api/projects/:id/schedule-start', wrap((req, res) => {
    const job = project(req, req.params.id, { write: true }), v = req.body && req.body.schedule_start;
    if (v && !isDate(v)) throw bad('Schedule start must be a date');
    update('jobs', job.id, { schedule_start: v ? mondayOf(v) : null }); res.json({ ok: true });
  }));

  // ================================================================ Labor Log and Cost Log (read views over time entries / purchasing / costs)
  app.get('/api/projects/:id/labor-log', wrap((req, res) => {
    const job = project(req, req.params.id), now = new Date().toISOString();
    const rows = all(db, `SELECT t.*, u.name employee, u.title class, cc.code cost_code, cc.name cost_code_name FROM time_entries t JOIN users u ON u.id = t.user_id
      LEFT JOIN cost_codes cc ON cc.id = t.cost_code_id WHERE t.job_id = ? ORDER BY t.clock_in DESC LIMIT 2000`, job.id).map(t => {
      const h = r2((Date.parse(t.clock_out || now) - Date.parse(t.clock_in)) / 36e5), d = new Date(t.clock_in), wk = new Date(d); wk.setDate(d.getDate() + ((7 - d.getDay()) % 7));
      return { id: t.id, week_ending: localDate(wk), employee: t.employee, class: t.class, date: localDate(d), start: t.clock_in, end: t.clock_out, hours: h, kind: t.kind,
        cost_code: t.cost_code, cost_code_name: t.cost_code_name, note: t.notes, source: t.source || (t.external_id ? 'A4Y Time Clock' : 'Field Ops clock'), labor_cost: r2(h * (t.hourly_cost || 0)) };
    });
    res.json({ rows, totals: { hours: r2(rows.reduce((x, r) => x + r.hours, 0)), labor_cost: r2(rows.reduce((x, r) => x + r.labor_cost, 0)) } });
  }));
  function costLog(job) {
    const typeOf = cat => /sub/i.test(cat || '') ? 'S' : /equip|rental/i.test(cat || '') ? 'E' : /material|supply/i.test(cat || '') ? 'M' : 'O';
    const rows = [];
    for (const l of all(db, `SELECT l.*, p.number po_number, p.status po_status, p.order_date, v.name vendor, cc.code cost_code FROM po_lines l JOIN purchase_orders p ON p.id = l.po_id
        JOIN vendors v ON v.id = p.vendor_id LEFT JOIN cost_codes cc ON cc.id = l.cost_code_id WHERE p.job_id = ? AND p.status != 'cancelled'`, job.id)) {
      const committed = r2(l.qty * l.unit_cost), recv = r2(l.qty_received * l.unit_cost);
      rows.push({ date: l.order_date || null, cost_code: l.cost_code, type: 'M', vendor: l.vendor, ref: l.po_number, description: l.description,
        status: l.qty_received >= l.qty - 1e-9 ? 'Received' : l.qty_received > 0 ? 'Partly received' : ['draft'].includes(l.po_status) ? 'Draft PO' : 'Committed (PO)',
        committed_cost: committed, invoiced_cost: recv, total_cost: recv, open_commit: l.po_status === 'draft' ? 0 : r2(Math.max(0, committed - recv)) });
    }
    for (const m of all(db, `SELECT m.*, cc.code cost_code FROM job_materials m LEFT JOIN cost_codes cc ON cc.id = m.cost_code_id WHERE m.job_id = ? AND (m.source IS NULL OR m.source != 'po')`, job.id))
      rows.push({ date: m.used_on, cost_code: m.cost_code, type: 'M', vendor: m.source === 'stock' ? 'Shop stock' : m.source === 'pick list' ? 'Pick list' : m.source === 'customer' ? 'Customer supplied' : 'Supply house',
        ref: null, description: m.description, status: 'Used', committed_cost: null, invoiced_cost: r2(m.qty * m.unit_cost), total_cost: r2(m.qty * m.unit_cost), open_commit: 0 });
    for (const e of all(db, 'SELECT e.*, cc.code cost_code FROM expenses e LEFT JOIN cost_codes cc ON cc.id = e.cost_code_id WHERE e.job_id = ?', job.id))
      rows.push({ date: e.date, cost_code: e.cost_code, type: typeOf(e.category), vendor: e.vendor, ref: e.reference || null, description: e.description || e.category, status: 'Paid',
        committed_cost: null, invoiced_cost: r2(e.amount), total_cost: r2(e.amount), open_commit: 0 });
    for (const b of all(db, `SELECT bl.*, bi.vendor_invoice, bi.bill_date, v.name vendor, cc.code cost_code FROM bill_lines bl JOIN bills bi ON bi.id = bl.bill_id JOIN vendors v ON v.id = bi.vendor_id
        LEFT JOIN cost_codes cc ON cc.id = bl.cost_code_id WHERE bl.job_id = ? AND bi.status != 'void' AND bl.job_material_id IS NULL AND bi.po_id IS NULL`, job.id))
      rows.push({ date: b.bill_date, cost_code: b.cost_code, type: 'O', vendor: b.vendor, ref: b.vendor_invoice, description: b.description, status: 'Invoiced', committed_cost: null, invoiced_cost: r2(b.amount), total_cost: r2(b.amount), open_commit: 0 });
    rows.sort((x, y) => String(y.date || '').localeCompare(String(x.date || '')));
    const t = k => r2(rows.reduce((x, r) => x + (r[k] || 0), 0));
    return { rows, totals: { committed_cost: t('committed_cost'), invoiced_cost: t('invoiced_cost'), total_cost: t('total_cost'), open_commit: t('open_commit') } };
  }
  app.get('/api/projects/:id/cost-log', wrap((req, res) => res.json(costLog(project(req, req.params.id)))));

  // ================================================================ Weekly History & trends (earned value by week)
  // Every row recalculates from the logs, so a back-dated entry still lands in the right week. % complete per week is
  // what was recorded for that week (captured automatically each week, or typed over by the PM); weeks with nothing
  // recorded fall back to hours burned ÷ budget hours, like the workbook. Money is cumulative through each week ending.
  const weekEnd = d => addD(mondayOf(d), 6);
  const currentPct = job => { const p = Bill.fixedSummary(db, job.id).percent_complete; return p == null ? null : Math.min(100, Math.max(0, p)); };
  function snapshotProgress(job) {
    const pct = currentPct(job); if (pct == null) return;
    run(db, `INSERT INTO project_progress (job_id, week_ending, pct_complete, source) VALUES (?, ?, ?, 'auto')
      ON CONFLICT(job_id, week_ending) DO UPDATE SET pct_complete = excluded.pct_complete, updated_at = datetime('now') WHERE project_progress.source = 'auto'`, job.id, weekEnd(today()), r2(pct));
  }
  app.locals.snapshotProgress = () => { for (const j of all(db, "SELECT * FROM jobs WHERE is_project = 1 AND status NOT IN ('completed', 'invoiced', 'cancelled')")) snapshotProgress(j); };
  function weeklyHistory(job) {
    snapshotProgress(job);
    const cfg = schedCfg(), entries = laborEntries(job), tasks = taskRows(job, today(), entries), log = costLog(job).rows;
    const bh = get(db, 'SELECT SUM(budget_hours) h FROM job_budgets WHERE job_id = ?', job.id).h ?? job.budget_hours ?? 0;
    const baseBudget = Bill.budgetCost(db, job) || 0, contract = job.contract_amount || 0;
    const cos = all(db, 'SELECT * FROM estimates WHERE job_id = ? AND change_order = 1', job.id).map(e => { const t = C.estimateWithTotals(db, e);
      return { status: e.status, approved: ymd(e.approved_at), created: ymd(e.created_at), price: r2(t.subtotal - t.discount), cost: r2(t.est_cost) }; });
    const invs = Bill.fixedSummary(db, job.id).invoices.filter(i => i.status !== 'void' && i.status !== 'draft');
    const pays = all(db, `SELECT p.amount, p.paid_at FROM payments p JOIN invoices i ON i.id = p.invoice_id WHERE i.job_id = ? AND i.status != 'void'`, job.id);
    const rfis = all(db, 'SELECT date_sent, date_returned, status FROM rfis WHERE job_id = ?', job.id);
    const sq = all(db, 'SELECT date, closed_date FROM safety_items WHERE job_id = ?', job.id);
    const stored = new Map(all(db, 'SELECT * FROM project_progress WHERE job_id = ?', job.id).map(r => [r.week_ending, r]));
    const firsts = [job.schedule_start, ymd(job.start_date), ...tasks.map(t => ymd(t.start_date)), ...entries.map(e => e.date)].filter(Boolean).sort();
    const end = weekEnd(today());
    let we = weekEnd(firsts[0] || today());
    if (days(we, end) / 7 > 103) we = addD(end, -7 * 103);
    const plannedThrough = d => tasks.reduce((x, r) => { const a = ymd(r.start_date), b = ymd(r.finish_date);
      if (!a || !b || !r.budget_hours || d < a) return x; return x + r.budget_hours * Math.min(1, (days(a, d) + 1) / Math.max(1, days(a, b) + 1)); }, 0);
    const out = [];
    for (let wk = 1; we <= end; wk++, we = addD(we, 7)) {
      const ws = addD(we, -6), upto = e => e.date <= we;
      const approved = cos.filter(c => c.status === 'approved' && c.approved && c.approved <= we);
      const revContract = r2(contract + approved.reduce((x, c) => x + c.price, 0)), revBudget = r2(baseBudget + approved.reduce((x, c) => x + c.cost, 0));
      const actualHrs = r1(entries.filter(upto).reduce((x, e) => x + e.hours, 0));
      const rec = stored.get(we);
      const rawPct = rec ? rec.pct_complete : bh ? Math.min(100, actualHrs / bh * 100) : null, pct = rawPct == null ? null : Math.round(rawPct * 10) / 10;
      const plannedHrs = r1(plannedThrough(we));
      const ac = r2(entries.filter(upto).reduce((x, e) => x + e.cost, 0) + log.filter(r => r.date && r.date <= we).reduce((x, r) => x + (r.total_cost || 0), 0));
      const ev = pct == null ? null : Math.round(revBudget * pct / 100);
      const earnedHrs = pct == null ? null : r1(bh * pct / 100);
      const proj = pct == null ? null : pct > 2 ? Math.round(ac / (pct / 100)) : revBudget;
      out.push({ wk, week_start: ws, week_ending: we, revised_contract: revContract, revised_budget: revBudget, pct_complete: pct,
        pct_source: rec ? rec.source : 'hours', pct_note: rec ? rec.note : null,
        pv: bh ? Math.round(revBudget * Math.min(plannedHrs, bh) / bh) : null, ev, ac, open_commit: r2(log.filter(r => r.date && r.date <= we).reduce((x, r) => x + (r.open_commit || 0), 0)),
        cpi: ev != null && ac >= 0.05 * revBudget && ac > 0 ? Math.round(ev / ac * 100) / 100 : null,
        planned_hours: plannedHrs, earned_hours: earnedHrs, actual_hours: actualHrs,
        spi: earnedHrs != null && plannedHrs >= 0.05 * bh && plannedHrs > 0 ? Math.round(earnedHrs / plannedHrs * 100) / 100 : null,
        projected_cost: proj, projected_margin_pct: proj != null && revContract ? Math.round((revContract - proj) / revContract * 1000) / 10 : null,
        billed: r2(invs.filter(i => ymd(i.issue_date) <= we).reduce((x, i) => x + i.amount, 0)), cash: r2(pays.filter(p => ymd(p.paid_at) <= we).reduce((x, p) => x + p.amount, 0)),
        pending_co: r2(cos.filter(c => c.created <= we && ['draft', 'sent', 'viewed'].includes(c.status)).reduce((x, c) => x + c.price, 0)),
        open_rfis: rfis.filter(r => r.date_sent && r.date_sent <= we && (!r.date_returned || r.date_returned > we) && !['Closed', 'Void'].includes(r.status)).length,
        open_safety: sq.filter(x => x.date <= we && (!x.closed_date || x.closed_date > we)).length,
        crew: Math.round(entries.filter(e => e.date >= ws && e.date <= we).reduce((x, e) => x + e.hours, 0) / (cfg.hours_per_day * cfg.days_per_week) * 10) / 10 });
    }
    return { weeks: out, budget_hours: bh, current_week_ending: end };
  }
  app.get('/api/projects/:id/weekly-history', wrap((req, res) => res.json(weeklyHistory(project(req, req.params.id)))));
  // the PM types over a week's % complete with what was actually reported (blank goes back to automatic)
  app.put('/api/projects/:id/progress', wrap((req, res) => {
    const job = project(req, req.params.id, { write: true }), b = req.body || {};
    if (!isDate(b.week_ending || '')) throw bad('week_ending must be a date');
    const we = weekEnd(b.week_ending);
    if (we > weekEnd(today())) throw bad('That week has not happened yet');
    if (b.pct_complete === null || b.pct_complete === '') { run(db, 'DELETE FROM project_progress WHERE job_id = ? AND week_ending = ?', job.id, we); return res.json({ ok: true }); }
    const pct = Number(b.pct_complete);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) throw bad('% complete is 0 to 100');
    run(db, `INSERT INTO project_progress (job_id, week_ending, pct_complete, source, note, updated_by) VALUES (?, ?, ?, 'manual', ?, ?)
      ON CONFLICT(job_id, week_ending) DO UPDATE SET pct_complete = excluded.pct_complete, source = 'manual', note = excluded.note, updated_by = excluded.updated_by, updated_at = datetime('now')`,
      job.id, we, pct, b.note || null, req.user.id);
    res.json({ ok: true });
  }));

  // ================================================================ Bi-Weekly Report
  // The workbook's Bi-Weekly Project Report, built from the other sheets for a 14-day period. The narrative is typed per
  // period; issuing it freezes a copy of the numbers so the report a GC received never changes. The GC copy leaves out
  // budget cost, cost to date, commitments, projected cost/margin and CO cost — anything that shows our margin.
  const PHASE_NAMES = { P0: 'Preconstruction', P1: 'Demolition', P2: 'Rough-In', P3: 'Gear & Feeders', P4: 'Trim, Fixtures & Devices', P5: 'Equipment Connections',
    P6: 'Systems', P7: 'Closeout', P8: 'Warranty & Service', P9: 'General Conditions, Indirects & Overhead' };
  const NARRATIVE = ['progress', 'plan_next', 'issues', 'decisions', 'notes'];
  function biweekly(job, pe) {
    const from = addD(pe, -13), cfg = schedCfg();
    const info = get(db, `SELECT j.number, j.title, j.status, j.start_date, j.end_date, j.contract_amount, j.gc_contact, j.gc_phone, j.gc_email, c.name customer_name, c.company,
        l.address, l.city, l.state, l.zip, pm.name pm_name, fm.name foreman_name FROM jobs j JOIN customers c ON c.id = j.customer_id LEFT JOIN locations l ON l.id = j.location_id
        LEFT JOIN users pm ON pm.id = j.project_manager_id LEFT JOIN users fm ON fm.id = j.foreman_id WHERE j.id = ?`, job.id);
    const hist = weeklyHistory(job), w = hist.weeks.find(x => x.week_ending >= pe) || hist.weeks[hist.weeks.length - 1] || {};
    const b = Bill.fixedSummary(db, job.id);
    const eac = w.projected_cost ?? null, revised = b.contract.total;
    const financial = { original_contract: b.contract.base, approved_co: b.contract.change_orders, revised_contract: revised, budget_cost: w.revised_budget ?? null,
      actual_cost: w.ac ?? null, open_commit: w.open_commit ?? null, projected_cost: eac, projected_margin: eac == null ? null : r2(revised - eac),
      projected_margin_pct: eac == null || !revised ? null : Math.round((revised - eac) / revised * 1000) / 10, billed: b.billed_to_date, retainage_held: b.retainage_held,
      cash: w.cash ?? null, over_under: b.over_under, pending_co: w.pending_co ?? 0, pct_complete: w.pct_complete ?? null, cpi: w.cpi ?? null, spi: w.spi ?? null,
      hours_used: w.actual_hours ?? 0, budget_hours: hist.budget_hours };
    // cost by phase from the cost codes (budget at the crew rate, earned from each code's % complete)
    const L = Bill.laborPricer(db, job), log = costLog(job).rows;
    const phaseOf = new Map(all(db, 'SELECT id, code, phase FROM cost_codes').map(c => [c.id, c.phase]));
    const commitBy = {}; for (const r of log) if (r.cost_code && r.open_commit) commitBy[r.cost_code] = (commitBy[r.cost_code] || 0) + r.open_commit;
    const ph = {};
    for (const c of P.codeRows(job)) {
      const key = PHASE_NAMES[phaseOf.get(c.cost_code_id)] ? phaseOf.get(c.cost_code_id) : 'other';
      const budget = L.cost(c.cost_code_id, c.budget_hours) + (c.budget_material || 0) + (c.budget_other || 0), actual = (c.labor_cost || 0) + (c.material_cost || 0) + (c.other_cost || 0);
      const pct = c.percent_complete || 0, x = ph[key] = ph[key] || { budget: 0, earned: 0, actual: 0, commit: 0, projected: 0 };
      x.budget += budget; x.earned += budget * pct / 100; x.actual += actual; x.commit += commitBy[c.code] || 0;
      x.projected += pct > 2 ? actual / (pct / 100) : Math.max(budget, actual + (commitBy[c.code] || 0));
    }
    const phases = [...Object.keys(PHASE_NAMES), 'other'].filter(k => ph[k] || k !== 'other').map(k => { const x = ph[k] || { budget: 0, earned: 0, actual: 0, commit: 0, projected: 0 };
      return { phase: k === 'other' ? '—' : k, name: k === 'other' ? 'Uncoded / no phase' : PHASE_NAMES[k], budget: r2(x.budget), earned: r2(x.earned), actual: r2(x.actual), commit: r2(x.commit),
        variance: r2(x.budget - x.actual - x.commit), cpi: x.actual ? Math.round(x.earned / x.actual * 100) / 100 : null, pct: x.budget ? Math.round(x.earned / x.budget * 1000) / 10 : null, projected: r2(x.projected) }; });
    // production this period
    const entries = laborEntries(job).filter(e => e.date >= from && e.date <= pe), hrs = entries.reduce((x, e) => x + e.hours, 0);
    const ms = schedCfg(), mw = scheduleWeeks(job, taskRows(job, pe), laborEntries(job), cfg).filter(x => x.week_ending >= pe);
    const production = { from, to: pe, labor_hours: r1(hrs), ot_hours: r1(entries.reduce((x, e) => x + e.ot, 0)), labor_cost: r2(entries.reduce((x, e) => x + e.cost, 0)),
      material_cost: r2(log.filter(r => r.date && r.date >= from && r.date <= pe).reduce((x, r) => x + (r.total_cost || 0), 0)),
      avg_crew: Math.round(hrs / (Math.max(1, netDays(from, pe)) * ms.hours_per_day) * 10) / 10, peak_planned_crew: mw.length ? Math.max(...mw.map(x => x.planned_crew)) : 0,
      people: new Set(entries.map(e => e.user_id)).size };
    const pick = (o, keys) => Object.fromEntries(keys.map(k => [k, o[k] ?? null]));
    return { generated_at: new Date().toISOString(), period_end: pe, period_start: from, company: pick(s(), ['company_name', 'company_address', 'company_phone', 'company_email']),
      info, financial, phases, production,
      lookahead: taskRows(job, pe).filter(t => t.lookahead).map(t => pick(t, ['ref', 'name', 'cost_code', 'start_date', 'finish_date', 'budget_hours', 'pct_complete', 'actual_hours', 'spi', 'status'])),
      milestones: msRows(job).filter(m => m.status !== 'Complete').map(m => pick(m, ['ref', 'name', 'owner', 'baseline_date', 'forecast_date', 'variance_days', 'days_to_go', 'status', 'critical'])),
      rfis: rfiRows(job).filter(r => r.open).map(r => pick(r, ['ref', 'subject', 'type', 'number', 'date_sent', 'date_needed', 'days_open', 'days_late', 'ball_in_court', 'cost_impact'])),
      change_orders: coRows(job).filter(c => !['Approved', 'Rejected', 'Void'].includes(c.status)).map(c => pick(c, ['co_no', 'number', 'description', 'type', 'status', 'sell_price', 'total_cost', 'margin_pct', 'days_added', 'submitted'])),
      safety: sqRows(job).filter(x => x.status !== 'Closed').map(x => pick(x, ['ref_id', 'description', 'type', 'severity', 'date', 'due_date', 'days_open', 'owner', 'status', 'corrective_action'])) };
  }
  // what a GC must not see: our budget, costs, commitments and margins
  function gcCopy(d) {
    const x = JSON.parse(JSON.stringify(d));
    for (const k of ['budget_cost', 'actual_cost', 'open_commit', 'projected_cost', 'projected_margin', 'projected_margin_pct', 'cpi']) delete x.financial[k];
    delete x.phases; delete x.production.labor_cost; delete x.production.material_cost;
    for (const c of x.change_orders) { delete c.total_cost; delete c.margin_pct; }
    x.gc_copy = true; return x;
  }
  const reportRow = (job, pe) => get(db, 'SELECT * FROM project_reports WHERE job_id = ? AND period_end = ?', job.id, pe);
  const periodEnd = q => { const pe = isDate(q || '') ? q : today(); if (pe > today()) throw bad('The period has not ended yet'); return pe; };
  app.get('/api/projects/:id/reports', wrap((req, res) => {
    const job = project(req, req.params.id, { write: true });
    res.json(all(db, `SELECT r.id, r.period_end, r.status, r.issued_at, r.sent_at, r.sent_to, r.viewed_at, u.name prepared_by_name FROM project_reports r LEFT JOIN users u ON u.id = r.prepared_by
      WHERE r.job_id = ? ORDER BY r.period_end DESC`, job.id));
  }));
  app.get('/api/projects/:id/biweekly', wrap((req, res) => {
    const job = project(req, req.params.id, { write: true }), pe = periodEnd(req.query.period_end), row = reportRow(job, pe);
    let data = row && row.status === 'issued' && row.snapshot ? JSON.parse(row.snapshot) : biweekly(job, pe);
    if (req.query.gc === '1' || !req.can('see_costs')) data = gcCopy(data);
    const prep = row && row.prepared_by ? get(db, 'SELECT name FROM users WHERE id = ?', row.prepared_by) : null;
    res.json({ data, report: row ? { ...pick(row, ['id', 'status', 'issued_at', 'sent_at', 'sent_to', 'viewed_at', ...NARRATIVE]), prepared_by_name: prep && prep.name, public_url: row.public_token && row.status === 'issued' ? `${baseUrl(req)}/p/report/${row.public_token}` : null } : null, can_see_costs: req.can('see_costs') });
  }));
  app.put('/api/projects/:id/biweekly', wrap((req, res) => {
    const job = project(req, req.params.id, { write: true }), pe = periodEnd(req.body && req.body.period_end), row = reportRow(job, pe);
    if (row && row.status === 'issued') throw bad('This report was issued — reopen it to edit');
    const d = clean(req.body, NARRATIVE);
    if (row) update('project_reports', row.id, { ...d, prepared_by: req.user.id }); else insert('project_reports', { job_id: job.id, period_end: pe, ...d, prepared_by: req.user.id });
    res.json({ ok: true });
  }));
  app.post('/api/projects/:id/biweekly/issue', wrap((req, res) => {
    const job = project(req, req.params.id, { write: true }), pe = periodEnd(req.body && req.body.period_end);
    let row = reportRow(job, pe);
    if (row && row.status === 'issued') throw bad('Already issued');
    if (!row) row = { id: insert('project_reports', { job_id: job.id, period_end: pe, prepared_by: req.user.id }) };
    update('project_reports', row.id, { status: 'issued', issued_at: new Date().toISOString(), issued_by: req.user.id, snapshot: JSON.stringify(biweekly(job, pe)) });
    res.json({ ok: true, id: row.id });
  }));
  // ---- email an issued report to the GC: always the GC copy, as a link to the frozen report (no attachment to go stale)
  const EMAIL = /^[^@\s,;<>]+@[^@\s,;<>]+\.[^@\s,;<>]+$/;
  const emails = (v, label) => { const list = String(v || '').split(/[,;\s]+/).map(x => x.trim()).filter(Boolean);
    for (const e of list) if (!EMAIL.test(e)) throw bad(`${label}: "${e}" is not an email address`);
    if (list.length > 10) throw bad(`${label}: 10 addresses at most`); return list; };
  const htmlEsc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtD = d => d ? new Date(String(d).slice(0, 10) + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '';
  const usd = n => n == null ? '—' : (Number(n) || 0).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  app.get('/api/projects/:id/biweekly/recipients', wrap((req, res) => {
    const job = project(req, req.params.id, { write: true });
    const c = get(db, 'SELECT email, name FROM customers WHERE id = ?', job.customer_id) || {};
    res.json({ to: job.gc_email || c.email || '', gc_contact: job.gc_contact || c.name || '', cc: req.user.email || '', smtp: !!process.env.SMTP_HOST });
  }));
  app.post('/api/projects/:id/biweekly/email', wrap(async (req, res) => {
    const job = project(req, req.params.id, { write: true }), b = req.body || {}, pe = periodEnd(b.period_end);
    const to = emails(b.to, 'To'), cc = emails(b.cc, 'Cc');
    if (!to.length) throw bad('Who should get it? Add the GC\'s email');
    let row = reportRow(job, pe);
    if (!row || row.status !== 'issued') throw bad('Issue the report first — only an issued report, with its numbers frozen, can be sent');
    if (!row.public_token) { update('project_reports', row.id, { public_token: D.token() }); row = reportRow(job, pe); }
    const d = gcCopy(JSON.parse(row.snapshot)), F = d.financial, cfg = s();
    const url = `${baseUrl(req)}/p/report/${row.public_token}`;
    const greet = String(b.greeting || '').trim() || (job.gc_contact ? `Hi ${String(job.gc_contact).split(/\s+/)[0]},` : 'Hello,');
    const msg = String(b.message || '').trim() || `Here is our bi-weekly report for ${job.title}, ${fmtD(d.period_start)} to ${fmtD(d.period_end)}.`;
    const facts = [['% complete', F.pct_complete == null ? '—' : `${F.pct_complete}%`], ['Schedule (SPI)', F.spi == null ? '—' : Number(F.spi).toFixed(2)],
      ['Revised contract', usd(F.revised_contract)], ['Billed to date', usd(F.billed)], ['Pending change orders', usd(F.pending_co)],
      ['Open RFIs / submittals', d.rfis.length], ['Tasks in the next two weeks', d.lookahead.length]];
    const subject = `Bi-weekly report: ${job.number} ${job.title} (period ending ${fmtD(pe)})`;
    const text = [greet, '', msg, '', ...facts.map(([k, v]) => `${k}: ${v}`), ...(row.decisions ? ['', `Decisions needed from you:\n${row.decisions}`] : []),
      '', `Full report: ${url}`, '', `${req.user.name}`, cfg.company_name || '', cfg.company_phone || ''].join('\n');
    const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#16191f;max-width:620px">
      <p>${htmlEsc(greet)}</p><p>${htmlEsc(msg).replace(/\n/g, '<br>')}</p>
      <table style="border-collapse:collapse;margin:12px 0;font-size:14px">${facts.map(([k, v]) => `<tr><td style="padding:4px 16px 4px 0;color:#4b5563">${htmlEsc(k)}</td><td style="padding:4px 0"><b>${htmlEsc(v)}</b></td></tr>`).join('')}</table>
      ${row.decisions ? `<p style="background:#fef3c7;padding:10px 12px;border-left:3px solid #b45309"><b>Decisions needed from you</b><br>${htmlEsc(row.decisions).replace(/\n/g, '<br>')}</p>` : ''}
      <p style="margin:18px 0"><a href="${htmlEsc(url)}" style="background:#fa001c;color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px;font-weight:bold">Open the full report</a></p>
      <p style="color:#6b7280;font-size:12px">The report can be printed or saved as a PDF from that page.</p>
      <p>${htmlEsc(req.user.name)}<br>${htmlEsc(cfg.company_name || '')}${cfg.company_phone ? `<br>${htmlEsc(cfg.company_phone)}` : ''}</p></div>`;
    const r = await mailer.send(db, { to: to.join(', '), cc: cc.join(', ') || undefined, replyTo: req.user.email || undefined, subject, text, html, related: `report:${row.id}` });
    if (r.status !== 'failed') update('project_reports', row.id, { sent_at: new Date().toISOString(), sent_to: [...to, ...cc].join(', ') });
    res.json({ ...r, url });
  }));
  // what the GC sees at the link: the frozen report, GC copy, with the narrative
  app.locals.publicReport = (tokenValue, { staff = false } = {}) => {
    const row = tokenValue && get(db, "SELECT * FROM project_reports WHERE public_token = ? AND status = 'issued'", tokenValue);
    if (!row || !row.snapshot) throw bad('This report link is no longer valid — ask for a new one', 404);
    if (!row.viewed_at && !staff) run(db, "UPDATE project_reports SET viewed_at = datetime('now') WHERE id = ?", row.id);
    const prep = row.prepared_by ? get(db, 'SELECT name FROM users WHERE id = ?', row.prepared_by) : null;
    return { data: gcCopy(JSON.parse(row.snapshot)), report: { status: 'issued', issued_at: row.issued_at, prepared_by_name: prep && prep.name, ...Object.fromEntries(NARRATIVE.map(k => [k, row[k]])) } };
  };
  app.post('/api/project-reports/:id/reopen', wrap((req, res) => {
    const row = mustGet('project_reports', req.params.id); project(req, row.job_id, { write: true });
    if (req.user.role !== 'admin') throw bad('Only an admin can reopen an issued report', 403);
    // the link a GC may already have stops working: the numbers behind it are about to change
    update('project_reports', row.id, { status: 'draft', issued_at: null, issued_by: null, snapshot: null, public_token: null }); res.json({ ok: true });
  }));

  // ================================================================ Estimate Import → Import Quote → budget
  // Paste the quote workbook's scope-tab rows (columns A–P, straight from Excel) and they become the project's budget by
  // cost code, like the job template: the code is read from the Phase Code (LAB-P2-0810-L, P2-0810-L, 0810-L or 0810),
  // subtotal and no-quantity rows are skipped, hours = qty × adjusted hrs/unit (or NECA hrs × factor), material $ =
  // Ext. Material or qty × material/unit. Labor $ uses Ext. Labor when given, else hours × the job's crew rate.
  // Cost types S (sub), E (equipment) and O (other) budget as "other"; everything else as material.
  const QCOLS = ['phase_code', 'phase', 'tag', 'description', 'qty', 'unit', 'material_unit', 'neca_hours', 'factor', 'adj_hours', 'labor_unit', 'total_unit', 'ext_material', 'ext_labor', 'ext_cost', 'notes'];
  const num = v => { if (v == null) return null; const t = String(v).replace(/[$,\s]/g, '').replace(/^\((.*)\)$/, '-$1'); if (t === '' || t === '-') return null; const n = Number(t); return Number.isFinite(n) ? n : null; };
  const isCode = x => /^\d{4}$/.test(x || '');
  function parseQuote(job, text, { source = null, overrides = {} } = {}) {
    if (!text || !String(text).trim()) throw bad('Paste the quote rows first');
    const raw = String(text).replace(/\r/g, '').split('\n');
    if (raw.length > 2000) throw bad('That is more than 2,000 rows — import one scope tab at a time');
    const delim = raw.some(l => l.includes('\t')) ? '\t' : ',';
    const splitCsv = l => { const out = []; let cur = '', q = false; for (let i = 0; i < l.length; i++) { const ch = l[i];
      if (q) { if (ch === '"' && l[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; } else if (ch === '"') q = true; else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch; }
      out.push(cur); return out; };
    const codes = new Map(all(db, 'SELECT id, code, name, phase FROM cost_codes').map(c => [c.code, c]));
    const rate = Bill.laborRate(db, job);
    const lines = [];
    raw.forEach((l, i) => {
      if (!l.trim()) return;
      const cells = delim === '\t' ? l.split('\t') : splitCsv(l);
      const r = Object.fromEntries(QCOLS.map((k, c) => [k, (cells[c] ?? '').trim()]));
      if (/^phase\s*code$/i.test(r.phase_code) || /^description$/i.test(r.description)) return;   // a pasted header row
      const qty = num(r.qty), ov = overrides[i] || {};
      const include = !!r.description && qty != null && qty !== 0 && !/subtotal/i.test(`${r.phase_code} ${r.phase} ${r.description}`);
      const seg = r.phase_code.split('-').map(x => x.trim());
      let code = '', area = '', type = '';
      if (isCode(seg[2])) { code = seg[2]; area = seg[0]; type = seg[3] || ''; } else if (isCode(seg[0])) { code = seg[0]; type = seg[1] || ''; } else if (isCode(seg[1])) { code = seg[1]; type = seg[2] || ''; }
      if (ov.code) code = /^\d+$/.test(String(ov.code)) ? String(ov.code).padStart(4, '0').slice(0, 4) : String(ov.code).slice(0, 4);
      if (ov.area != null && ov.area !== '') area = ov.area;
      type = (type || 'L').toUpperCase();
      const cc = codes.get(code);
      const hrsUnit = num(r.adj_hours) ?? (num(r.neca_hours) != null ? num(r.neca_hours) * (num(r.factor) ?? 1) : 0);
      const material = include ? (num(r.ext_material) ?? r2((qty || 0) * (num(r.material_unit) || 0))) : 0;
      const hours = include ? r2((qty || 0) * hrsUnit) : 0;
      const labor = include ? (num(r.ext_labor) ?? r2(hours * rate)) : 0;
      const status = !include ? 'Skipped — no qty, or a subtotal row' : !code ? 'NO COST CODE — type one' : !cc ? `Code ${code} is not on the cost code list` : 'OK';
      lines.push({ row: i, ...r, qty, include, code, area, cost_type: type, cost_code_id: cc ? cc.id : null, cost_code_name: cc ? cc.name : null, code_phase: cc ? cc.phase : null,
        hours_unit: hrsUnit, material, hours, labor, total: r2(material + labor), status, source });
    });
    const ok = lines.filter(x => x.status === 'OK');
    const byCode = {};
    for (const x of ok) { const b = byCode[x.cost_code_id] = byCode[x.cost_code_id] || { cost_code_id: x.cost_code_id, code: x.code, name: x.cost_code_name, phase: x.code_phase, budget_hours: 0, budget_material: 0, budget_other: 0, labor: 0 };
      b.budget_hours += x.hours; b.labor += x.labor; if (['S', 'E', 'O'].includes(x.cost_type)) b.budget_other += x.material; else b.budget_material += x.material; }
    const current = new Map(all(db, 'SELECT * FROM job_budgets WHERE job_id = ?', job.id).map(b => [b.cost_code_id, b]));
    const budget = Object.values(byCode).map(b => ({ ...b, budget_hours: r2(b.budget_hours), budget_material: r2(b.budget_material), budget_other: r2(b.budget_other), labor: r2(b.labor),
      current_hours: current.get(b.cost_code_id)?.budget_hours ?? null, current_material: current.get(b.cost_code_id)?.budget_material ?? null })).sort((a, b) => a.code.localeCompare(b.code));
    const t = k => r2(ok.reduce((x, l) => x + l[k], 0));
    return { lines, budget, labor_rate: r2(rate), totals: { lines: ok.length, skipped: lines.filter(x => !x.include).length, need_code: lines.filter(x => x.include && x.status !== 'OK').length,
      hours: t('hours'), material: t('material'), labor: t('labor'), total: t('total') }, removed: [...current.values()].filter(b => !byCode[b.cost_code_id]).length };
  }
  app.post('/api/projects/:id/quote-import/preview', wrap((req, res) => {
    const job = project(req, req.params.id, { write: true }), b = req.body || {};
    res.json(parseQuote(job, b.text, { source: b.source, overrides: b.overrides || {} }));
  }));
  function applyQuote(job, b, userId) {
    const mode = b.mode === 'add' ? 'add' : 'replace';
    const p = parseQuote(job, b.text, { source: b.source, overrides: b.overrides || {} });
    if (!p.totals.lines) throw bad('No importable lines — every row was skipped or needs a cost code');
    if (p.totals.need_code && !b.skip_uncoded) throw bad(`${p.totals.need_code} line(s) need a cost code — fix them or choose to skip them`);
    const importId = `${Date.now().toString(36)}-${userId}`;
    const progress = new Map(all(db, 'SELECT cost_code_id, percent_complete FROM job_budgets WHERE job_id = ? AND percent_complete IS NOT NULL', job.id).map(r => [r.cost_code_id, r.percent_complete]));
    if (mode === 'replace') { run(db, 'DELETE FROM job_budgets WHERE job_id = ?', job.id); run(db, 'DELETE FROM project_quote_lines WHERE job_id = ?', job.id); }
    for (const x of p.budget) {
      run(db, `INSERT INTO job_budgets (job_id, cost_code_id, budget_hours, budget_material, budget_other) VALUES (?,?,?,?,?)
        ON CONFLICT(job_id, cost_code_id) DO UPDATE SET budget_hours = budget_hours + excluded.budget_hours, budget_material = budget_material + excluded.budget_material, budget_other = budget_other + excluded.budget_other`,
        job.id, x.cost_code_id, x.budget_hours, x.budget_material, x.budget_other);
    }
    for (const [cc, pct] of progress) run(db, 'UPDATE job_budgets SET percent_complete = ? WHERE job_id = ? AND cost_code_id = ?', pct, job.id, cc);
    let sort = get(db, 'SELECT MAX(sort) m FROM project_quote_lines WHERE job_id = ?', job.id).m || 0;
    for (const x of p.lines.filter(l => l.status === 'OK'))
      insert('project_quote_lines', { job_id: job.id, import_id: importId, source: b.source || null, area: x.area || null, cost_code_id: x.cost_code_id, cost_type: x.cost_type, phase_code: x.phase_code || null,
        tag: x.tag || null, description: x.description, qty: x.qty, unit: x.unit || null, material_unit: num(x.material_unit), hours_unit: x.hours_unit, ext_material: x.material, ext_hours: x.hours,
        ext_labor: x.labor, ext_total: x.total, notes: x.notes || null, sort: sort += 1, imported_by: userId });
    const t = get(db, 'SELECT SUM(budget_hours) h, SUM(budget_material) m FROM job_budgets WHERE job_id = ?', job.id);
    update('jobs', job.id, { budget_hours: r2(t.h || 0), budget_materials: r2(t.m || 0) });
    return { ok: true, import_id: importId, mode, lines: p.totals.lines, codes: p.budget.length, totals: p.totals };
  }
  app.post('/api/projects/:id/quote-import', wrap((req, res) => res.json(applyQuote(project(req, req.params.id, { write: true }), req.body || {}, req.user.id))));
  // the Import Quote sheet: every imported line, by cost code
  app.get('/api/projects/:id/quote-lines', wrap((req, res) => {
    const job = project(req, req.params.id, { write: true });
    const rows = all(db, `SELECT q.*, cc.code cost_code, cc.name cost_code_name, cc.phase, u.name imported_by_name FROM project_quote_lines q LEFT JOIN cost_codes cc ON cc.id = q.cost_code_id
      LEFT JOIN users u ON u.id = q.imported_by WHERE q.job_id = ? ORDER BY q.sort, q.id`, job.id);
    const t = k => r2(rows.reduce((x, r) => x + (r[k] || 0), 0));
    res.json({ rows, totals: { ext_material: t('ext_material'), ext_hours: t('ext_hours'), ext_labor: t('ext_labor'), ext_total: t('ext_total') },
      imports: all(db, `SELECT import_id, source, COUNT(*) lines, MIN(imported_at) imported_at, SUM(ext_total) total FROM project_quote_lines WHERE job_id = ? GROUP BY import_id, source ORDER BY MIN(id)`, job.id) });
  }));
  app.delete('/api/projects/:id/quote-import/:importId', wrap((req, res) => {
    const job = project(req, req.params.id, { write: true });
    const lines = all(db, 'SELECT * FROM project_quote_lines WHERE job_id = ? AND import_id = ?', job.id, req.params.importId);
    if (!lines.length) throw bad('Import not found', 404);
    // take that import's amounts back out of the budget
    for (const l of lines) {
      const other = ['S', 'E', 'O'].includes(l.cost_type);
      run(db, `UPDATE job_budgets SET budget_hours = MAX(0, budget_hours - ?), budget_material = MAX(0, budget_material - ?), budget_other = MAX(0, budget_other - ?) WHERE job_id = ? AND cost_code_id = ?`,
        l.ext_hours, other ? 0 : l.ext_material, other ? l.ext_material : 0, job.id, l.cost_code_id);
    }
    run(db, 'DELETE FROM job_budgets WHERE job_id = ? AND budget_hours < 0.005 AND budget_material < 0.005 AND budget_other < 0.005 AND percent_complete IS NULL', job.id);
    run(db, 'DELETE FROM project_quote_lines WHERE job_id = ? AND import_id = ?', job.id, req.params.importId);
    const t = get(db, 'SELECT SUM(budget_hours) h, SUM(budget_material) m FROM job_budgets WHERE job_id = ?', job.id);
    update('jobs', job.id, { budget_hours: r2(t.h || 0), budget_materials: r2(t.m || 0) });
    res.json({ ok: true, removed: lines.length });
  }));

  // counts for dashboards and flags
  return {
    exceptions(job) {
      const r = rfiRows(job), sq = sqRows(job), ms = msRows(job), tk = taskRows(job);
      return { tasks_late: tk.filter(x => x.status === 'Late' || x.status === 'Late Start').length, tasks_update: tk.filter(x => x.status === 'Update %').length, rfis_open: r.filter(x => x.open).length, rfis_overdue: r.filter(x => x.overdue).length, safety_open: sq.filter(x => x.status !== 'Closed').length,
        safety_overdue: sq.filter(x => x.status === 'Overdue').length, milestones_late: ms.filter(x => x.status === 'Late').length, milestones_at_risk: ms.filter(x => x.status === 'At Risk').length,
        pay_apps_over_45: payApps(job).filter(a => a.date_submitted && a.open_balance > 0.005 && days(a.date_submitted, today()) > 45).length };
    },
    LISTS,
    taskRows,
    applyQuote, invoicePayApp, payApps, snapshotProgress,
    manpowerPeak: job => { const e = laborEntries(job); return remainingPeak(scheduleWeeks(job, taskRows(job, today(), e), e, schedCfg())); },
  };
};
