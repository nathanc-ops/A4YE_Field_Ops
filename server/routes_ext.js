'use strict';
// Scheduling (appointments), cost codes & budgets, purchasing (vendors, POs, receiving, pick lists),
// accounting (chart of accounts, journal, bills/AP, financial statements) and the Ply connector.
const D = require('./db');
const C = require('./calc');
const A = require('./accounting');
const Ply = require('./ply');

const { all, get, run, tx } = D;
const r2 = C.r2;

module.exports = function routesExt(app, db, X) {
  const { wrap, bad, insert, update, mustGet, pick, today, addDays, office, admin, H } = X;

  // ================================================================ appointments
  H.appointments = (where, params = []) => all(db, `SELECT a.*, j.number job_number, j.title job_title, j.status job_status, j.priority, j.job_type, j.customer_id,
      c.name customer_name, c.type customer_type, c.phone customer_phone, l.address, l.city, l.state, l.zip,
      (SELECT GROUP_CONCAT(at.user_id) FROM appointment_techs at WHERE at.appointment_id = a.id) tech_ids,
      (SELECT GROUP_CONCAT(u.name, ', ') FROM appointment_techs at JOIN users u ON u.id = at.user_id WHERE at.appointment_id = a.id) tech_names
    FROM appointments a JOIN jobs j ON j.id = a.job_id JOIN customers c ON c.id = j.customer_id LEFT JOIN locations l ON l.id = j.location_id
    WHERE ${where} ORDER BY a.start`, ...params).map(a => ({ ...a, tech_ids: a.tech_ids ? String(a.tech_ids).split(',').map(Number) : [] }));

  function setApptTechs(apptId, jobId, ids) {
    if (!Array.isArray(ids)) return;
    run(db, 'DELETE FROM appointment_techs WHERE appointment_id = ?', apptId);
    for (const uid of ids) {
      run(db, 'INSERT OR IGNORE INTO appointment_techs (appointment_id, user_id) VALUES (?,?)', apptId, uid);
      run(db, 'INSERT OR IGNORE INTO job_techs (job_id, user_id) VALUES (?,?)', jobId, uid); // crew on the job
    }
  }
  // Keep the job's summary window (first start / last end) in line with its appointments.
  function syncJobSchedule(jobId) {
    const w = get(db, "SELECT MIN(start) s, MAX(end) e, COUNT(*) n FROM appointments WHERE job_id = ? AND status != 'cancelled'", jobId);
    const job = get(db, 'SELECT status FROM jobs WHERE id = ?', jobId);
    run(db, 'UPDATE jobs SET scheduled_start = ?, scheduled_end = ? WHERE id = ?', w.s, w.e, jobId);
    if (w.n && job.status === 'unscheduled') run(db, "UPDATE jobs SET status = 'scheduled' WHERE id = ?", jobId);
    if (!w.n && job.status === 'scheduled') run(db, "UPDATE jobs SET status = 'unscheduled' WHERE id = ?", jobId);
  }
  H.syncJobSchedule = syncJobSchedule;
  // Back-compat for the job form's single start/end: create or move the only appointment.
  H.syncSingleAppointment = (jobId, start, end, techIds) => {
    const appts = all(db, "SELECT id FROM appointments WHERE job_id = ? AND status != 'cancelled'", jobId);
    if (appts.length > 1) return syncJobSchedule(jobId); // multi-visit jobs are scheduled per visit
    end = end || new Date(new Date(start).getTime() + 2 * 3600e3).toISOString();
    let id;
    if (appts.length) { id = appts[0].id; run(db, 'UPDATE appointments SET start = ?, end = ? WHERE id = ?', start, end, id); }
    else id = insert('appointments', { job_id: jobId, start, end });
    if (Array.isArray(techIds)) setApptTechs(id, jobId, techIds);
    syncJobSchedule(jobId);
  };
  function checkTimes(start, end) {
    if (!start || !end) throw bad('Start and end are required');
    if (new Date(end) <= new Date(start)) throw bad('End must be after start');
  }

  app.get('/api/appointments', wrap((req, res) => {
    const from = req.query.from || C.startOfDay(today()), to = req.query.to || C.endOfDay(today());
    const p = [to, from]; let w = 'a.start < ? AND a.end > ?';
    if (!req.query.include_cancelled) w += " AND a.status != 'cancelled'";
    if (req.user.role === 'tech') { w += ' AND EXISTS (SELECT 1 FROM appointment_techs at WHERE at.appointment_id = a.id AND at.user_id = ?)'; p.push(req.user.id); }
    res.json(H.appointments(w, p));
  }));
  app.post('/api/appointments', office, wrap((req, res) => {
    const b = req.body; const job = mustGet('jobs', b.job_id);
    checkTimes(b.start, b.end);
    const id = insert('appointments', { job_id: job.id, start: new Date(b.start).toISOString(), end: new Date(b.end).toISOString(), notes: b.notes || null, status: b.status || 'scheduled' });
    setApptTechs(id, job.id, b.tech_ids || []);
    syncJobSchedule(job.id);
    res.json({ id, conflicts: conflicts(id) });
  }));
  app.put('/api/appointments/:id', wrap((req, res) => {
    const a = mustGet('appointments', req.params.id);
    if (req.user.role === 'tech') {
      // techs can only advance the status of their own visits
      if (!get(db, 'SELECT 1 x FROM appointment_techs WHERE appointment_id = ? AND user_id = ?', a.id, req.user.id)) throw bad('Not your appointment', 403);
      return res.json(techStatus(a, req.body.status, req.user));
    }
    const data = pick(req.body, ['start', 'end', 'status', 'notes']);
    for (const k of ['start', 'end']) if (data[k]) data[k] = new Date(data[k]).toISOString();
    checkTimes(data.start || a.start, data.end || a.end);
    update('appointments', a.id, data);
    setApptTechs(a.id, a.job_id, req.body.tech_ids);
    if (data.status === 'dispatched') run(db, "UPDATE jobs SET status = 'dispatched' WHERE id = ? AND status IN ('scheduled','unscheduled')", a.job_id);
    syncJobSchedule(a.job_id);
    res.json({ ok: true, conflicts: conflicts(a.id) });
  }));
  app.delete('/api/appointments/:id', office, wrap((req, res) => {
    const a = mustGet('appointments', req.params.id);
    run(db, 'DELETE FROM appointments WHERE id = ?', a.id); syncJobSchedule(a.job_id); res.json({ ok: true });
  }));
  // Overlaps for any tech on this appointment (double-booking warning, not a hard stop).
  function conflicts(apptId) {
    const a = get(db, 'SELECT * FROM appointments WHERE id = ?', apptId);
    return all(db, `SELECT DISTINCT u.name, a2.id appointment_id, j.number job_number, a2.start, a2.end FROM appointment_techs t1
      JOIN appointment_techs t2 ON t2.user_id = t1.user_id AND t2.appointment_id != t1.appointment_id
      JOIN appointments a2 ON a2.id = t2.appointment_id AND a2.status != 'cancelled' JOIN users u ON u.id = t1.user_id JOIN jobs j ON j.id = a2.job_id
      WHERE t1.appointment_id = ? AND a2.start < ? AND a2.end > ?`, apptId, a.end, a.start);
  }
  // En route / on site / done from the field. On site clocks the tech in; done clocks them out.
  function techStatus(a, status, user) {
    if (!['dispatched', 'en_route', 'on_site', 'done'].includes(status)) throw bad('Invalid status');
    run(db, 'UPDATE appointments SET status = ? WHERE id = ?', status, a.id);
    const now = new Date().toISOString();
    const u = get(db, 'SELECT * FROM users WHERE id = ?', user.id);
    const rate = r2(u.hourly_wage * (1 + (u.burden_pct || 0) / 100));
    if (status === 'en_route' || status === 'on_site') {
      run(db, 'UPDATE time_entries SET clock_out = ? WHERE user_id = ? AND clock_out IS NULL', now, u.id);
      insert('time_entries', { user_id: u.id, job_id: a.job_id, appointment_id: a.id, kind: status === 'en_route' ? 'travel' : 'job', clock_in: now, hourly_cost: rate, hourly_wage: u.hourly_wage });
      if (status === 'on_site') run(db, "UPDATE jobs SET status = 'in_progress' WHERE id = ? AND status IN ('scheduled','dispatched','unscheduled')", a.job_id);
    }
    if (status === 'done') run(db, 'UPDATE time_entries SET clock_out = ? WHERE user_id = ? AND clock_out IS NULL AND job_id = ?', now, u.id, a.job_id);
    return { ok: true };
  }

  // Tech availability for the dispatch view: scheduled hours today + what they're clocked into.
  app.get('/api/dispatch', office, wrap((req, res) => {
    const day = req.query.date || today();
    const from = C.startOfDay(day), to = C.endOfDay(day);
    const appts = H.appointments("a.start < ? AND a.end > ? AND a.status != 'cancelled'", [to, from]);
    const techs = all(db, "SELECT id, name, color, title, phone FROM users WHERE active = 1 AND role = 'tech' ORDER BY name").map(u => {
      const mine = appts.filter(a => a.tech_ids.includes(u.id));
      const clock = get(db, `SELECT t.*, j.number job_number FROM time_entries t LEFT JOIN jobs j ON j.id = t.job_id WHERE t.user_id = ? AND t.clock_out IS NULL`, u.id);
      return { ...u, booked_hours: r2(mine.reduce((s, a) => s + (new Date(a.end) - new Date(a.start)) / 36e5, 0)), appointments: mine.length, clock };
    });
    const unscheduled = all(db, `${X.jobSelect} WHERE j.status = 'unscheduled' OR (j.status IN ('scheduled','dispatched','on_hold','in_progress')
      AND NOT EXISTS (SELECT 1 FROM appointments a WHERE a.job_id = j.id AND a.status NOT IN ('cancelled','done') AND a.end > ?)) ORDER BY CASE j.priority WHEN 'emergency' THEN 0 WHEN 'high' THEN 1 ELSE 2 END, j.id`, from).map(X.fixTechs);
    res.json({ date: day, appointments: appts, techs, unscheduled, unassigned: appts.filter(a => !a.tech_ids.length) });
  }));

  // ================================================================ cost codes & budgets
  app.get('/api/cost-codes', wrap((req, res) => res.json(all(db, `SELECT * FROM cost_codes ${req.query.all ? '' : 'WHERE active = 1'} ORDER BY code`))));
  app.post('/api/cost-codes', office, wrap((req, res) => {
    if (!req.body.code || !req.body.name) throw bad('Code and name are required');
    res.json({ id: insert('cost_codes', pick(req.body, ['code', 'name', 'kind', 'active', 'ply_code'])) });
  }));
  app.put('/api/cost-codes/:id', office, wrap((req, res) => { update('cost_codes', req.params.id, pick(req.body, ['code', 'name', 'kind', 'active', 'ply_code'])); res.json({ ok: true }); }));

  function setBudgets(jobId, rows) {
    run(db, 'DELETE FROM job_budgets WHERE job_id = ?', jobId);
    for (const b of rows) {
      if (!b.cost_code_id) continue;
      if (!(Number(b.budget_hours) || Number(b.budget_material) || Number(b.budget_other))) continue;
      run(db, `INSERT INTO job_budgets (job_id, cost_code_id, budget_hours, budget_material, budget_other) VALUES (?,?,?,?,?)
        ON CONFLICT(job_id, cost_code_id) DO UPDATE SET budget_hours = budget_hours + excluded.budget_hours, budget_material = budget_material + excluded.budget_material, budget_other = budget_other + excluded.budget_other`,
      jobId, b.cost_code_id, Number(b.budget_hours) || 0, Number(b.budget_material) || 0, Number(b.budget_other) || 0);
    }
    const t = get(db, 'SELECT SUM(budget_hours) h, SUM(budget_material) m FROM job_budgets WHERE job_id = ?', jobId);
    if (t.h != null) run(db, 'UPDATE jobs SET budget_hours = ?, budget_materials = ? WHERE id = ?', r2(t.h), r2(t.m), jobId);
  }
  // Approved estimate → budget per cost code (flat-rate labor hours and material cost from the price book).
  H.budgetsFromEstimate = (jobId, estimateId) => {
    const items = all(db, `SELECT ei.*, pb.labor_hours, pb.kind, pb.cost_code_id pb_code FROM estimate_items ei LEFT JOIN pricebook pb ON pb.id = ei.pricebook_id WHERE estimate_id = ?`, estimateId);
    const fallback = get(db, "SELECT id FROM cost_codes WHERE code = '400'");
    const rows = items.map(it => {
      const code = it.cost_code_id || it.pb_code || (fallback && fallback.id);
      const hours = (it.labor_hours || 0) * it.qty;
      const isMat = it.kind === 'material';
      // flat-rate service lines: cost covers material; labor tracked as hours
      return { cost_code_id: code, budget_hours: hours, budget_material: isMat || it.kind === 'service' ? it.unit_cost * it.qty : 0, budget_other: it.kind === 'equipment' ? it.unit_cost * it.qty : 0 };
    });
    setBudgets(jobId, rows);
  };
  app.put('/api/jobs/:id/budgets', office, wrap((req, res) => { mustGet('jobs', req.params.id); setBudgets(Number(req.params.id), req.body.budgets || []); res.json({ ok: true }); }));
  app.get('/api/reports/cost-codes', office, wrap((req, res) => res.json(C.costCodeReport(db, req.query.from || today().slice(0, 8) + '01', req.query.to || today()))));

  // ================================================================ vendors
  const VENDOR_FIELDS = ['name', 'contact', 'email', 'phone', 'address', 'account_number', 'terms_days', 'default_account_id', 'ply_vendor_id', 'active', 'notes'];
  app.get('/api/vendors', office, wrap((req, res) => res.json(all(db, `SELECT v.*,
    (SELECT COUNT(*) FROM purchase_orders p WHERE p.vendor_id = v.id) po_count FROM vendors v ORDER BY active DESC, name`))));
  app.post('/api/vendors', office, wrap((req, res) => { if (!req.body.name) throw bad('Vendor name is required'); res.json({ id: insert('vendors', pick(req.body, VENDOR_FIELDS)) }); }));
  app.put('/api/vendors/:id', office, wrap((req, res) => { update('vendors', req.params.id, pick(req.body, VENDOR_FIELDS)); res.json({ ok: true }); }));

  // ================================================================ purchase orders
  H.poTotals = po => {
    const lines = all(db, `SELECT pl.*, cc.code cost_code, pb.code sku, pb.qty_on_hand FROM po_lines pl LEFT JOIN cost_codes cc ON cc.id = pl.cost_code_id
      LEFT JOIN pricebook pb ON pb.id = pl.pricebook_id WHERE po_id = ? ORDER BY sort, id`, po.id);
    const subtotal = r2(lines.reduce((s, l) => s + l.qty * l.unit_cost, 0));
    const received_value = r2(lines.reduce((s, l) => s + l.qty_received * l.unit_cost, 0));
    const billed = get(db, "SELECT COUNT(*) n FROM bills WHERE po_id = ? AND status != 'void'", po.id).n > 0;
    return { ...po, lines, subtotal, total: r2(subtotal + (po.tax || 0) + (po.shipping || 0)), received_value, billed };
  };
  function savePOLines(poId, lines) {
    if (!Array.isArray(lines)) return;
    const keep = new Set();
    lines.forEach((l, i) => {
      if (!l.description) return;
      const data = { pricebook_id: l.pricebook_id || null, description: l.description, qty: Number(l.qty) || 0, unit_cost: Number(l.unit_cost) || 0, cost_code_id: l.cost_code_id || null, sort: i };
      if (l.id && get(db, 'SELECT 1 x FROM po_lines WHERE id = ? AND po_id = ?', l.id, poId)) { update('po_lines', l.id, data); keep.add(Number(l.id)); }
      else keep.add(insert('po_lines', { po_id: poId, ...data }));
    });
    for (const l of all(db, 'SELECT id, qty_received FROM po_lines WHERE po_id = ?', poId))
      if (!keep.has(l.id)) { if (l.qty_received > 0) throw bad('Cannot remove a line that has been received'); run(db, 'DELETE FROM po_lines WHERE id = ?', l.id); }
  }
  const PO_FIELDS = ['vendor_id', 'job_id', 'deliver_to', 'order_date', 'expected_date', 'tax', 'shipping', 'notes'];
  app.get('/api/purchase-orders', office, wrap((req, res) => {
    const where = [], p = [];
    if (req.query.status) { where.push(`p.status IN (${req.query.status.split(',').map(() => '?').join(',')})`); p.push(...req.query.status.split(',')); }
    if (req.query.job_id) { where.push('p.job_id = ?'); p.push(req.query.job_id); }
    res.json(all(db, `SELECT p.*, v.name vendor_name, j.number job_number FROM purchase_orders p JOIN vendors v ON v.id = p.vendor_id LEFT JOIN jobs j ON j.id = p.job_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY p.id DESC LIMIT 500`, ...p).map(H.poTotals));
  }));
  app.get('/api/purchase-orders/:id', office, wrap((req, res) => {
    const po = H.poTotals(get(db, `SELECT p.*, v.name vendor_name, v.email vendor_email, j.number job_number, j.title job_title FROM purchase_orders p
      JOIN vendors v ON v.id = p.vendor_id LEFT JOIN jobs j ON j.id = p.job_id WHERE p.id = ?`, req.params.id) || (() => { throw bad('Not found', 404); })());
    po.receipts = all(db, `SELECT r.*, pl.description, u.name user_name FROM po_receipts r JOIN po_lines pl ON pl.id = r.po_line_id LEFT JOIN users u ON u.id = r.user_id WHERE pl.po_id = ? ORDER BY r.id DESC`, po.id);
    po.bills = all(db, 'SELECT * FROM bills WHERE po_id = ? ORDER BY id DESC', po.id).map(b => A.billTotals(db, b));
    res.json(po);
  }));
  app.post('/api/purchase-orders', office, wrap((req, res) => {
    const b = req.body;
    if (!b.vendor_id) throw bad('Vendor is required');
    const id = insert('purchase_orders', { ...pick(b, PO_FIELDS), deliver_to: b.deliver_to || (b.job_id ? 'job' : 'shop'), number: D.nextNumber(db, 'purchase_orders', 'PO'), created_by: req.user.id });
    savePOLines(id, b.lines || []);
    res.json({ id });
  }));
  app.put('/api/purchase-orders/:id', office, wrap((req, res) => {
    const po = mustGet('purchase_orders', req.params.id);
    if (['received', 'cancelled'].includes(po.status) && req.body.lines) throw bad(`PO is ${po.status} — lines are locked`);
    update('purchase_orders', po.id, { ...pick(req.body, PO_FIELDS), ...(req.body.status === 'cancelled' ? { status: 'cancelled' } : {}) });
    savePOLines(po.id, req.body.lines);
    res.json({ ok: true });
  }));
  app.delete('/api/purchase-orders/:id', office, wrap((req, res) => {
    const po = mustGet('purchase_orders', req.params.id);
    if (po.status !== 'draft') throw bad('Only draft POs can be deleted — cancel it instead');
    run(db, 'DELETE FROM purchase_orders WHERE id = ?', po.id); res.json({ ok: true });
  }));
  app.post('/api/purchase-orders/:id/submit', office, wrap(async (req, res) => {
    const po = mustGet('purchase_orders', req.params.id);
    if (!get(db, 'SELECT COUNT(*) n FROM po_lines WHERE po_id = ?', po.id).n) throw bad('PO has no lines');
    if (po.status === 'draft') run(db, "UPDATE purchase_orders SET status = 'submitted', order_date = ? WHERE id = ?", today(), po.id);
    let ply = null;
    if (req.body.send_to_ply) ply = await Ply.pushPO(db, po.id);
    res.json({ ok: true, ply });
  }));

  // Receive goods. Job POs become job materials at PO cost; shop POs go into stock (weighted-average cost).
  H.receivePO = (poId, lines, userId, source = 'manual') => {
    const po = mustGet('purchase_orders', poId);
    if (po.status === 'cancelled') throw bad('PO is cancelled');
    for (const r of lines) {
      const qty = Number(r.qty); if (!(qty > 0)) continue;
      const l = get(db, 'SELECT * FROM po_lines WHERE id = ? AND po_id = ?', r.po_line_id, po.id);
      if (!l) throw bad('PO line not found');
      if (l.qty_received + qty > l.qty + 1e-9 && source !== 'ply') throw bad(`Receiving ${qty} of "${l.description}" exceeds the ${l.qty - l.qty_received} still open`);
      run(db, 'UPDATE po_lines SET qty_received = qty_received + ? WHERE id = ?', qty, l.id);
      let jmId = null;
      if (po.job_id && po.deliver_to !== 'shop') {
        const pb = l.pricebook_id ? get(db, 'SELECT unit_price FROM pricebook WHERE id = ?', l.pricebook_id) : null;
        jmId = insert('job_materials', { job_id: po.job_id, pricebook_id: l.pricebook_id, description: l.description, qty, unit_cost: l.unit_cost,
          unit_price: pb ? pb.unit_price : r2(l.unit_cost * 1.5), billable: 1, source: 'po', po_line_id: l.id, cost_code_id: l.cost_code_id, user_id: userId, used_on: today() });
      } else if (l.pricebook_id) {
        const pb = get(db, 'SELECT qty_on_hand, unit_cost FROM pricebook WHERE id = ?', l.pricebook_id);
        const oh = Math.max(0, pb.qty_on_hand);
        const avg = oh + qty > 0 ? r2((oh * pb.unit_cost + qty * l.unit_cost) / (oh + qty)) : l.unit_cost;
        run(db, 'UPDATE pricebook SET qty_on_hand = qty_on_hand + ?, unit_cost = ? WHERE id = ?', qty, avg, l.pricebook_id);
      }
      insert('po_receipts', { po_line_id: l.id, qty, job_material_id: jmId, user_id: userId, source });
    }
    const t = get(db, 'SELECT SUM(qty) q, SUM(MIN(qty_received, qty)) r FROM po_lines WHERE po_id = ?', po.id);
    run(db, 'UPDATE purchase_orders SET status = ? WHERE id = ?', t.r >= t.q - 1e-9 ? 'received' : t.r > 0 ? 'partial' : po.status === 'draft' ? 'submitted' : po.status, po.id);
  };
  app.post('/api/purchase-orders/:id/receive', office, wrap((req, res) => {
    const po = mustGet('purchase_orders', req.params.id);
    const lines = req.body.all
      ? all(db, 'SELECT id po_line_id, qty - qty_received qty FROM po_lines WHERE po_id = ? AND qty > qty_received', po.id)
      : (req.body.lines || []);
    H.receivePO(po.id, lines, req.user.id);
    res.json({ ok: true });
  }));

  // Vendor bill from a PO: job deliveries cost to Job Materials, shop deliveries to Inventory.
  H.billFromPO = (poId, { vendor_invoice, bill_date, total, ply_id } = {}) => {
    const po = H.poTotals(mustGet('purchase_orders', poId));
    const vendor = mustGet('vendors', po.vendor_id);
    const toJob = po.job_id && po.deliver_to !== 'shop';
    const acct = A.accountId(db, toJob ? '5100' : '1300');
    const date = bill_date || today();
    const billId = insert('bills', { vendor_id: vendor.id, po_id: po.id, vendor_invoice: vendor_invoice || null, bill_date: date, due_date: addDays(date, vendor.terms_days || 30), ply_id: ply_id || null, memo: `PO ${po.number}` });
    for (const l of po.lines) {
      const qty = l.qty_received > 0 ? l.qty_received : l.qty;
      insert('bill_lines', { bill_id: billId, account_id: acct, description: `${qty} × ${l.description}`, amount: r2(qty * l.unit_cost), job_id: toJob ? po.job_id : null, cost_code_id: l.cost_code_id });
    }
    if (po.tax) insert('bill_lines', { bill_id: billId, account_id: acct, description: 'Sales tax', amount: po.tax, job_id: toJob ? po.job_id : null });
    if (po.shipping) insert('bill_lines', { bill_id: billId, account_id: acct, description: 'Freight / delivery', amount: po.shipping, job_id: toJob ? po.job_id : null });
    // Supplier invoice total differs from PO? book the difference so AP matches what we actually owe.
    const sum = get(db, 'SELECT SUM(amount) s FROM bill_lines WHERE bill_id = ?', billId).s || 0;
    if (total != null && Math.abs(Number(total) - sum) >= 0.01)
      insert('bill_lines', { bill_id: billId, account_id: acct, description: 'Price variance vs PO', amount: r2(Number(total) - sum), job_id: toJob ? po.job_id : null });
    A.postBill(db, billId);
    return billId;
  };
  app.post('/api/purchase-orders/:id/bill', office, wrap((req, res) => res.json({ id: H.billFromPO(Number(req.params.id), req.body) })));

  // Reorder: one draft PO per vendor for every stocked item at/below its reorder point.
  app.post('/api/purchase-orders/reorder', office, wrap((req, res) => {
    const items = all(db, "SELECT * FROM pricebook WHERE active = 1 AND kind = 'material' AND reorder_point > 0 AND qty_on_hand <= reorder_point");
    const byVendor = new Map();
    for (const it of items) {
      const vid = it.vendor_id || (it.vendor && (get(db, 'SELECT id FROM vendors WHERE name = ?', it.vendor) || {}).id) || req.body.vendor_id;
      if (!vid) continue;
      if (!byVendor.has(vid)) byVendor.set(vid, []);
      // order back up to 2× the reorder point
      byVendor.get(vid).push({ pricebook_id: it.id, description: it.name, qty: Math.max(1, Math.ceil(it.reorder_point * 2 - it.qty_on_hand)), unit_cost: it.unit_cost, cost_code_id: it.cost_code_id });
    }
    const created = [];
    for (const [vid, lines] of byVendor) {
      const id = insert('purchase_orders', { vendor_id: vid, deliver_to: 'shop', number: D.nextNumber(db, 'purchase_orders', 'PO'), created_by: req.user.id, notes: 'Stock reorder' });
      savePOLines(id, lines); created.push(id);
    }
    res.json({ created, skipped_without_vendor: items.length - [...byVendor.values()].reduce((s, l) => s + l.length, 0) });
  }));

  // ================================================================ pick lists
  app.get('/api/pick-lists', wrap((req, res) => {
    const where = [], p = [];
    if (req.query.status) { where.push(`pl.status IN (${req.query.status.split(',').map(() => '?').join(',')})`); p.push(...req.query.status.split(',')); }
    if (req.user.role === 'tech') { where.push('(pl.assigned_to = ? OR EXISTS (SELECT 1 FROM job_techs jt WHERE jt.job_id = pl.job_id AND jt.user_id = ?))'); p.push(req.user.id, req.user.id); }
    res.json(all(db, `SELECT pl.*, j.number job_number, j.title job_title, u.name assigned_name,
      (SELECT COUNT(*) FROM pick_list_lines l WHERE l.pick_list_id = pl.id) line_count FROM pick_lists pl JOIN jobs j ON j.id = pl.job_id LEFT JOIN users u ON u.id = pl.assigned_to
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY CASE pl.status WHEN 'open' THEN 0 WHEN 'picking' THEN 1 ELSE 2 END, COALESCE(pl.needed_by, '9999'), pl.id DESC`, ...p));
  }));
  app.get('/api/pick-lists/:id', wrap((req, res) => {
    const pl = get(db, `SELECT pl.*, j.number job_number, j.title job_title, u.name assigned_name FROM pick_lists pl JOIN jobs j ON j.id = pl.job_id LEFT JOIN users u ON u.id = pl.assigned_to WHERE pl.id = ?`, req.params.id);
    if (!pl) throw bad('Not found', 404);
    pl.lines = all(db, `SELECT l.*, pb.code sku, pb.qty_on_hand, pb.unit, cc.code cost_code FROM pick_list_lines l LEFT JOIN pricebook pb ON pb.id = l.pricebook_id
      LEFT JOIN cost_codes cc ON cc.id = l.cost_code_id WHERE pick_list_id = ? ORDER BY pb.category, l.description`, pl.id);
    res.json(pl);
  }));
  // New pick list for a job. from_estimate pulls material lines off the approved estimate.
  app.post('/api/jobs/:id/pick-lists', office, wrap((req, res) => {
    const job = mustGet('jobs', req.params.id);
    const id = insert('pick_lists', { number: D.nextNumber(db, 'pick_lists', 'PL'), job_id: job.id, needed_by: req.body.needed_by || null, assigned_to: req.body.assigned_to || null, notes: req.body.notes || null });
    let lines = req.body.lines || [];
    if (req.body.from_estimate) {
      const est = get(db, "SELECT id FROM estimates WHERE job_id = ? AND status = 'approved' ORDER BY id DESC LIMIT 1", job.id);
      if (!est) throw bad('This job has no approved estimate to pull materials from');
      lines = all(db, `SELECT ei.pricebook_id, ei.description, ei.qty, COALESCE(ei.cost_code_id, pb.cost_code_id) cost_code_id FROM estimate_items ei
        JOIN pricebook pb ON pb.id = ei.pricebook_id WHERE ei.estimate_id = ? AND pb.kind = 'material'`, est.id);
      if (!lines.length) throw bad('The approved estimate has no stocked material lines — add lines manually');
    }
    for (const l of lines) if (l.description) insert('pick_list_lines', { pick_list_id: id, pricebook_id: l.pricebook_id || null, description: l.description, qty: Number(l.qty) || 1, cost_code_id: l.cost_code_id || null });
    res.json({ id });
  }));
  app.put('/api/pick-lists/:id', wrap((req, res) => {
    const pl = mustGet('pick_lists', req.params.id);
    if (['delivered', 'cancelled'].includes(pl.status)) throw bad(`Pick list is ${pl.status}`);
    if (req.user.role !== 'tech') update('pick_lists', pl.id, pick(req.body, ['needed_by', 'assigned_to', 'notes', ...(req.body.status === 'cancelled' ? ['status'] : [])]));
    for (const l of req.body.lines || []) {
      if (l.id) run(db, 'UPDATE pick_list_lines SET qty_picked = ? WHERE id = ? AND pick_list_id = ?', Number(l.qty_picked) || 0, l.id, pl.id);
      else if (l.description && req.user.role !== 'tech') insert('pick_list_lines', { pick_list_id: pl.id, pricebook_id: l.pricebook_id || null, description: l.description, qty: Number(l.qty) || 1, cost_code_id: l.cost_code_id || null });
    }
    if (pl.status === 'open' && (req.body.lines || []).some(l => Number(l.qty_picked) > 0)) run(db, "UPDATE pick_lists SET status = 'picking' WHERE id = ?", pl.id);
    res.json({ ok: true });
  }));
  // Finish picking: everything picked leaves stock and is charged to the job at current cost.
  H.completePickList = (plId, userId) => {
    const pl = mustGet('pick_lists', plId);
    if (['delivered', 'cancelled'].includes(pl.status)) throw bad(`Pick list is ${pl.status}`);
    for (const l of all(db, 'SELECT * FROM pick_list_lines WHERE pick_list_id = ? AND qty_picked > 0 AND job_material_id IS NULL', pl.id)) {
      const pb = l.pricebook_id ? get(db, 'SELECT * FROM pricebook WHERE id = ?', l.pricebook_id) : null;
      const mid = insert('job_materials', { job_id: pl.job_id, pricebook_id: l.pricebook_id, description: l.description, qty: l.qty_picked, unit_cost: pb ? pb.unit_cost : 0,
        unit_price: pb ? pb.unit_price : 0, billable: 1, source: pb ? 'stock' : 'customer', cost_code_id: l.cost_code_id || (pb && pb.cost_code_id), user_id: userId, used_on: today() });
      if (pb) run(db, 'UPDATE pricebook SET qty_on_hand = qty_on_hand - ? WHERE id = ?', l.qty_picked, pb.id);
      run(db, 'UPDATE pick_list_lines SET job_material_id = ? WHERE id = ?', mid, l.id);
      A.postJobMaterial(db, mid);
    }
    run(db, "UPDATE pick_lists SET status = 'picked' WHERE id = ?", pl.id);
  };
  app.post('/api/pick-lists/:id/complete', wrap((req, res) => { H.completePickList(Number(req.params.id), req.user.id); res.json({ ok: true }); }));
  app.post('/api/pick-lists/:id/delivered', wrap((req, res) => {
    const pl = mustGet('pick_lists', req.params.id);
    if (pl.status !== 'picked') H.completePickList(pl.id, req.user.id);
    run(db, "UPDATE pick_lists SET status = 'delivered' WHERE id = ?", pl.id); res.json({ ok: true });
  }));
  // Shortages → one draft PO to the chosen vendor, delivered to the job.
  app.post('/api/pick-lists/:id/po-shortages', office, wrap((req, res) => {
    const pl = mustGet('pick_lists', req.params.id);
    const lines = all(db, `SELECT l.*, pb.qty_on_hand, pb.unit_cost, pb.vendor_id FROM pick_list_lines l LEFT JOIN pricebook pb ON pb.id = l.pricebook_id WHERE pick_list_id = ?`, pl.id)
      .map(l => ({ ...l, short: r2(l.qty - Math.max(0, l.qty_on_hand ?? 0)) })).filter(l => l.short > 0);
    if (!lines.length) throw bad('Nothing is short — everything is in stock');
    const vendorId = req.body.vendor_id || lines.find(l => l.vendor_id)?.vendor_id;
    if (!vendorId) throw bad('Pick a vendor for the shortage PO');
    const id = insert('purchase_orders', { vendor_id: vendorId, job_id: pl.job_id, deliver_to: 'job', number: D.nextNumber(db, 'purchase_orders', 'PO'), created_by: req.user.id, notes: `Shortages from ${pl.number}` });
    savePOLines(id, lines.map(l => ({ pricebook_id: l.pricebook_id, description: l.description, qty: l.short, unit_cost: l.unit_cost || 0, cost_code_id: l.cost_code_id })));
    res.json({ id });
  }));
  app.post('/api/pick-lists/:id/send-to-ply', office, wrap(async (req, res) => res.json(await Ply.pushPickList(db, Number(req.params.id)))));

  H.setStock = (pricebookId, qty, memo) => {
    const pb = mustGet('pricebook', pricebookId);
    if (qty === pb.qty_on_hand) return;
    run(db, 'UPDATE pricebook SET qty_on_hand = ? WHERE id = ?', qty, pb.id);
    A.postInventoryAdjustment(db, { pricebookId: pb.id, delta: qty - pb.qty_on_hand, unitCost: pb.unit_cost });
  };

  // ================================================================ accounting (admin only)
  app.get('/api/accounts', office, wrap((req, res) => {
    const bal = A.balances(db, { to: req.query.as_of || '9999-12-31' });
    res.json(bal.filter(a => req.query.all || a.active));
  }));
  app.post('/api/accounts', admin, wrap((req, res) => {
    if (!req.body.number || !req.body.name || !req.body.type) throw bad('Number, name and type are required');
    res.json({ id: insert('accounts', pick(req.body, ['number', 'name', 'type', 'subtype', 'description', 'active'])) });
  }));
  app.put('/api/accounts/:id', admin, wrap((req, res) => { update('accounts', req.params.id, pick(req.body, ['number', 'name', 'subtype', 'description', 'active'])); res.json({ ok: true }); }));

  app.get('/api/journal', admin, wrap((req, res) => {
    const from = req.query.from || '0000-01-01', to = req.query.to || '9999-12-31';
    const where = ['je.date >= ?', 'je.date <= ?'], p = [from, to];
    if (req.query.source_type) { where.push('je.source_type = ?'); p.push(req.query.source_type); }
    const entries = all(db, `SELECT je.*, u.name created_by_name, (SELECT SUM(debit) FROM journal_lines WHERE entry_id = je.id) amount FROM journal_entries je
      LEFT JOIN users u ON u.id = je.created_by WHERE ${where.join(' AND ')} ORDER BY je.date DESC, je.id DESC LIMIT 500`, ...p);
    res.json(entries.map(e => ({ ...e, amount: r2(e.amount) })));
  }));
  app.get('/api/journal/:id', admin, wrap((req, res) => {
    const e = mustGet('journal_entries', req.params.id);
    e.lines = all(db, `SELECT jl.*, a.number, a.name account_name, j.number job_number, cc.code cost_code FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
      LEFT JOIN jobs j ON j.id = jl.job_id LEFT JOIN cost_codes cc ON cc.id = jl.cost_code_id WHERE entry_id = ? ORDER BY jl.id`, e.id);
    res.json(e);
  }));
  app.post('/api/journal', admin, wrap((req, res) => {
    const lines = (req.body.lines || []).map(l => ({ account: l.account_id, debit: Number(l.debit) || 0, credit: Number(l.credit) || 0, memo: l.memo, job_id: l.job_id || null, cost_code_id: l.cost_code_id || null }));
    if (lines.length < 2) throw bad('A journal entry needs at least two lines');
    res.json({ id: A.post(db, { date: req.body.date || today(), memo: req.body.memo, source_type: 'manual', created_by: req.user.id, lines }) });
  }));
  app.delete('/api/journal/:id', admin, wrap((req, res) => {
    const e = mustGet('journal_entries', req.params.id);
    if (e.source_type !== 'manual') throw bad('Automatic entries are removed by changing the source record (invoice, bill, expense…)');
    A.assertOpen(db, e.date);
    A.assertNotReconciled(db, e.id);
    run(db, 'DELETE FROM journal_entries WHERE id = ?', e.id); res.json({ ok: true });
  }));

  // bills (accounts payable)
  app.get('/api/bills', admin, wrap((req, res) => {
    const where = [], p = [];
    if (req.query.status) { where.push(`b.status IN (${req.query.status.split(',').map(() => '?').join(',')})`); p.push(...req.query.status.split(',')); }
    res.json(all(db, `SELECT b.*, v.name vendor_name, po.number po_number FROM bills b JOIN vendors v ON v.id = b.vendor_id LEFT JOIN purchase_orders po ON po.id = b.po_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY b.bill_date DESC, b.id DESC LIMIT 500`, ...p).map(b => A.billTotals(db, b)));
  }));
  app.get('/api/bills/:id', admin, wrap((req, res) => {
    const b = A.billTotals(db, get(db, `SELECT b.*, v.name vendor_name, po.number po_number FROM bills b JOIN vendors v ON v.id = b.vendor_id LEFT JOIN purchase_orders po ON po.id = b.po_id WHERE b.id = ?`, req.params.id) || (() => { throw bad('Not found', 404); })());
    res.json(b);
  }));
  function saveBillLines(billId, lines) {
    for (const l of all(db, 'SELECT job_material_id FROM bill_lines WHERE bill_id = ? AND job_material_id IS NOT NULL', billId)) run(db, 'DELETE FROM job_materials WHERE id = ?', l.job_material_id);
    run(db, 'DELETE FROM bill_lines WHERE bill_id = ?', billId);
    const bill = get(db, 'SELECT * FROM bills WHERE id = ?', billId);
    const matAcct = A.accountId(db, '5100');
    for (const l of lines) {
      if (!l.account_id || !Number(l.amount)) continue;
      let jm = null;
      // non-PO materials billed to a job also show up on that job's material list for job costing
      if (!bill.po_id && l.job_id && Number(l.account_id) === matAcct && l.add_to_job_materials !== false)
        jm = insert('job_materials', { job_id: l.job_id, description: l.description || 'Materials per vendor bill', qty: 1, unit_cost: Number(l.amount), unit_price: 0, billable: 0, source: 'bill', cost_code_id: l.cost_code_id || null, used_on: bill.bill_date });
      insert('bill_lines', { bill_id: billId, account_id: l.account_id, description: l.description || null, amount: Number(l.amount), job_id: l.job_id || null, cost_code_id: l.cost_code_id || null, job_material_id: jm });
    }
  }
  app.post('/api/bills', admin, wrap((req, res) => {
    const b = req.body; const v = mustGet('vendors', b.vendor_id);
    const date = b.bill_date || today();
    const id = insert('bills', { vendor_id: v.id, vendor_invoice: b.vendor_invoice || null, bill_date: date, due_date: b.due_date || addDays(date, v.terms_days || 30), memo: b.memo || null });
    saveBillLines(id, b.lines || []);
    if (!get(db, 'SELECT COUNT(*) n FROM bill_lines WHERE bill_id = ?', id).n) throw bad('Add at least one line with an account and amount');
    A.postBill(db, id);
    res.json({ id });
  }));
  app.put('/api/bills/:id', admin, wrap((req, res) => {
    const b = mustGet('bills', req.params.id);
    A.assertOpen(db, b.bill_date);
    if (req.body.status === 'void') {
      if (get(db, 'SELECT COUNT(*) n FROM bill_payments WHERE bill_id = ?', b.id).n) throw bad('Remove payments before voiding');
      run(db, "UPDATE bills SET status = 'void' WHERE id = ?", b.id); A.postBill(db, b.id); return res.json({ ok: true });
    }
    update('bills', b.id, pick(req.body, ['vendor_invoice', 'bill_date', 'due_date', 'memo']));
    if (req.body.lines) {
      if (b.po_id) throw bad('Lines on a PO bill come from the PO');
      saveBillLines(b.id, req.body.lines);
    }
    A.refreshBillStatus(db, b.id); A.postBill(db, b.id);
    res.json({ ok: true });
  }));
  app.post('/api/bills/:id/payments', admin, wrap((req, res) => {
    const b = A.billTotals(db, mustGet('bills', req.params.id));
    if (b.status === 'void') throw bad('Bill is void');
    const amount = Number(req.body.amount);
    if (!(amount > 0)) throw bad('Amount must be greater than zero');
    if (amount > b.balance + 0.005) throw bad(`Payment is more than the ${b.balance} balance`);
    const id = insert('bill_payments', { bill_id: b.id, amount, paid_at: req.body.paid_at || today(), method: req.body.method || 'check', reference: req.body.reference || null,
      account_id: req.body.account_id || A.accountId(db, D.settings(db).default_paid_from_account || '1000') });
    A.refreshBillStatus(db, b.id); A.postBillPayment(db, id);
    res.json({ id });
  }));
  app.delete('/api/bill-payments/:id', admin, wrap((req, res) => {
    const p = mustGet('bill_payments', req.params.id);
    A.unpost(db, 'bill_payment', p.id); run(db, 'DELETE FROM bill_payments WHERE id = ?', p.id); A.refreshBillStatus(db, p.bill_id); res.json({ ok: true });
  }));

  // labor accrual & payroll
  app.get('/api/accounting/labor', admin, wrap((req, res) => res.json(A.laborStatus(db, req.query.from || addDays(today(), -56), req.query.to || today()))));
  app.post('/api/accounting/labor', admin, wrap((req, res) => {
    const weeks = req.body.weeks || [];
    res.json(weeks.map(w => A.postLaborWeek(db, A.mondayOf(w), req.user.id)));
  }));
  app.post('/api/accounting/payroll-payment', admin, wrap((req, res) => {
    const amt = Number(req.body.amount); if (!(amt > 0)) throw bad('Amount is required');
    res.json({ id: A.post(db, { date: req.body.date || today(), memo: req.body.memo || 'Payroll paid', source_type: 'manual', created_by: req.user.id, lines: [
      { account: '2100', debit: amt }, { account: req.body.account_id || '1000', credit: amt }] }) });
  }));
  app.post('/api/accounting/rebuild', admin, wrap((req, res) => res.json(A.rebuild(db))));
  app.post('/api/accounting/close', admin, wrap((req, res) => {
    const d = req.body.through || '';
    if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) throw bad('Date must be YYYY-MM-DD');
    run(db, "INSERT INTO settings (key, value) VALUES ('books_closed_through', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", d);
    res.json({ books_closed_through: d });
  }));
  app.get('/api/accounting/trial-balance', admin, wrap((req, res) => res.json(A.trialBalance(db, req.query.as_of || today()))));
  app.get('/api/accounting/balance-sheet', admin, wrap((req, res) => res.json(A.balanceSheet(db, req.query.as_of || today()))));
  app.get('/api/accounting/income-statement', admin, wrap((req, res) => res.json(A.incomeStatement(db, req.query.from || today().slice(0, 5) + '01-01', req.query.to || today()))));
  app.get('/api/accounting/ledger/:accountId', admin, wrap((req, res) => res.json(A.generalLedger(db, Number(req.params.accountId), req.query.from || today().slice(0, 5) + '01-01', req.query.to || today()))));
  app.get('/api/accounting/ap-aging', admin, wrap((req, res) => res.json(A.apAging(db))));
  app.get('/api/accounting/summary', admin, wrap((req, res) => {
    const t = today();
    const bal = A.balances(db, { to: t });
    const by = n => (bal.find(a => a.number === n) || {}).balance || 0;
    const banks = bal.filter(a => a.subtype === 'bank');
    res.json({ cash: r2(banks.reduce((s, a) => s + a.balance, 0)), banks, ar: by('1200'), ap: by('2000'), inventory: by('1300'), sales_tax: by('2200'), accrued_payroll: by('2100'),
      credit_card: by('2050'), ytd: A.incomeStatement(db, t.slice(0, 5) + '01-01', t), closed_through: A.closedThrough(db),
      labor_out_of_sync: A.laborStatus(db, addDays(t, -56), t).filter(w => !w.in_sync).length });
  }));

  // ================================================================ Ply
  app.get('/api/integrations/ply/log', admin, wrap((req, res) => res.json(all(db, "SELECT * FROM integration_log WHERE provider = 'ply' ORDER BY id DESC LIMIT 100"))));
  app.post('/api/integrations/ply/test', admin, wrap(async (req, res) => {
    const c = Ply.config(db);
    const r = await Ply.request(db, 'GET', c.paths.items + '?limit=1');
    res.json({ ok: true, sample: r });
  }));
  app.post('/api/integrations/ply/pull-items', admin, wrap(async (req, res) => res.json(await Ply.pullItems(db))));
  app.post('/api/integrations/ply/push-job/:id', office, wrap(async (req, res) => res.json(await Ply.pushJob(db, Number(req.params.id)))));
  app.get('/api/integrations/ply/preview/:kind/:id', admin, wrap((req, res) => {
    const f = { po: Ply.toPlyPO, pick_list: Ply.toPlyPickList, job: Ply.toPlyJob }[req.params.kind];
    if (!f) throw bad('Unknown kind'); res.json(f(db, Number(req.params.id)));
  }));
};

// Webhook endpoint lives outside /api auth (Ply calls it with a shared secret).
module.exports.webhook = function plyWebhook(app, db, X) {
  app.post('/hooks/ply', (req, res) => {
    if (!Ply.verify(db, req)) { Ply.log(db, 'in', 'webhook', 'rejected', 'bad or missing signature'); return res.status(401).json({ error: 'Invalid signature' }); }
    const evt = req.body || {};
    try {
      const result = tx(db, () => Ply.handleEvent(db, X.H, evt));
      Ply.log(db, 'in', evt.type || evt.event || 'unknown', 'ok', { event: evt, result });
      res.json({ ok: true, result });
    } catch (e) {
      Ply.log(db, 'in', evt.type || evt.event || 'unknown', 'error', { event: evt, error: e.message });
      res.status(422).json({ error: e.message });
    }
  });
};
