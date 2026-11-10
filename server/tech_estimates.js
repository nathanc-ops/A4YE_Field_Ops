'use strict';
// Techs building estimates in the field.
//
// Guardrails (Settings → Field estimating):
//  • price-book items always use price-book price and cost (techs can't change them)
//  • custom lines: allowed, sent to office review (default), or blocked
//  • discount cap and margin floor per option
//  • costs and margins hidden from techs unless tech_see_costs = 1
// If any guardrail trips, the estimate is "pending review": the customer can see it but can't sign
// until the office approves the pricing. Inside the guardrails the tech can present and close on site.
//
// These handlers are registered before the office estimate routes; non-tech users fall through to them.
const D = require('./db');
const C = require('./calc');
const { all, get, run, settings } = D;

const r2 = C.r2;

module.exports = function techEstimates(app, db, X) {
  const { wrap, bad, mustGet, pick, insert, update, saveItems, saveOptions, baseUrl, today, addDays, office, H } = X;
  const techOnly = (req, res, next) => (req.user.role === 'tech' ? next() : next('route'));
  // req given → this person's own switches (Team → permissions); the company settings are only the defaults
  const cfg = req => {
    const s = settings(db);
    return { enabled: req ? req.can('field_estimates') : s.tech_estimates !== '0', seeCosts: req ? req.can('see_costs') : s.tech_see_costs === '1', maxDiscount: Number(s.tech_max_discount_pct) || 0,
      minMargin: Number(s.tech_min_margin_pct) || 0, custom: s.tech_custom_lines || 'review', s };
  };
  const assigned = (user, jobId) => jobId && !!get(db, 'SELECT 1 x FROM job_techs WHERE job_id = ? AND user_id = ?', jobId, user.id);
  // the tech booked on an estimate visit can open and build that estimate on site
  const onVisit = (user, estimateId) => !!get(db, 'SELECT 1 x FROM appointments a JOIN appointment_techs t ON t.appointment_id = a.id WHERE a.estimate_id = ? AND t.user_id = ?', estimateId, user.id);
  function techEstimate(user, id) {
    const e = mustGet('estimates', id);
    if (!assigned(user, e.job_id) && !onVisit(user, e.id)) throw bad('This estimate is not on one of your jobs or visits', 403);
    return e;
  }

  // ---------------------------------------------------------------- guardrails
  // Evaluates the saved estimate with real costs. Returns reasons it needs office review + a per-option pass flag.
  function evaluate(estId) {
    const c = cfg();
    const est = get(db, 'SELECT * FROM estimates WHERE id = ?', estId);
    const full = C.estimateWithTotals(db, est);
    const reasons = [];
    const custom = full.items.filter(i => !i.pricebook_id);
    if (custom.length && c.custom === 'review') reasons.push(`${custom.length} custom line(s) not from the price book`);
    const groups = full.options.length ? full.options.map(o => ({ name: o.name, items: full.items.filter(i => !i.option_id || i.option_id === o.id), subtotal: o.subtotal, discount: o.discount, cost: o.est_cost }))
      : [{ name: null, items: full.items, subtotal: full.subtotal, discount: full.discount, cost: full.est_cost }];
    const checks = groups.map(g => {
      const net = g.subtotal - g.discount;
      const margin = net > 0 ? (net - g.cost) / net * 100 : 0;
      const discPct = g.subtotal > 0 ? g.discount / g.subtotal * 100 : 0;
      const ok = { margin: margin >= c.minMargin - 1e-9, discount: discPct <= c.maxDiscount + 1e-9 };
      const label = g.name ? `“${g.name}”` : 'Estimate';
      if (!ok.discount) reasons.push(`${label} discount ${r2(discPct)}% is over the ${c.maxDiscount}% limit`);
      if (!ok.margin) reasons.push(`${label} margin is below the ${c.minMargin}% minimum`);
      return { name: g.name, margin_ok: ok.margin, discount_ok: ok.discount, margin: r2(margin) };
    });
    return { reasons, checks };
  }
  function applyReview(estId, userId) {
    const ev = evaluate(estId);
    const est = get(db, 'SELECT review_status FROM estimates WHERE id = ?', estId);
    if (ev.reasons.length) {
      run(db, "UPDATE estimates SET review_status = 'pending', review_reasons = ?, review_note = NULL WHERE id = ?", JSON.stringify(ev.reasons), estId);
      const e = get(db, 'SELECT number, job_id FROM estimates WHERE id = ?', estId);
      if (est.review_status !== 'pending' && e.job_id) insert('job_notes', { job_id: e.job_id, user_id: userId, body: `${e.number} needs office review: ${ev.reasons.join('; ')}` });
    } else run(db, "UPDATE estimates SET review_status = CASE WHEN review_status = 'approved' THEN 'approved' ELSE NULL END, review_reasons = NULL WHERE id = ?", estId);
    return ev;
  }

  // Price-book lines are repriced from the price book; custom lines follow the custom-line policy.
  function cleanItems(items, req) {
    const c = cfg(req);
    return (items || []).filter(i => i && i.description).map(it => {
      if (it.pricebook_id) {
        const p = get(db, 'SELECT * FROM pricebook WHERE id = ? AND active = 1', it.pricebook_id);
        if (!p) throw bad(`Price book item for “${it.description}” not found`);
        return { ...it, unit_price: p.unit_price, unit_cost: p.unit_cost, taxable: p.taxable, cost_code_id: it.cost_code_id || p.cost_code_id };
      }
      if (c.custom === 'block') throw bad(`“${it.description}” isn't in the price book. Pick a price-book item, or ask the office to add one.`);
      if (!(Number(it.unit_price) >= 0)) throw bad('Custom lines need a price');
      return { ...it, pricebook_id: null, unit_cost: c.seeCosts ? Number(it.unit_cost) || 0 : 0 };
    });
  }
  // What a tech may see of an estimate.
  function forTech(req, e) {
    const c = cfg(req);
    const full = C.estimateWithTotals(db, e);
    const ev = evaluate(e.id);
    full.guard = { checks: c.seeCosts ? ev.checks : ev.checks.map(({ margin, ...rest }) => rest), max_discount_pct: c.maxDiscount, min_margin_pct: c.seeCosts ? c.minMargin : undefined, custom_lines: c.custom, see_costs: c.seeCosts };
    full.review_reasons = e.review_reasons ? JSON.parse(e.review_reasons) : [];
    if (!c.seeCosts) {
      for (const it of [...full.items, ...full.chosen_items]) delete it.unit_cost;
      for (const o of full.options) { delete o.est_cost; delete o.est_margin_pct; }
      delete full.est_cost; delete full.est_margin_pct;
    }
    full.customer = get(db, 'SELECT id, name, company, email, phone, tax_exempt FROM customers WHERE id = ?', e.customer_id);
    full.public_url = `${baseUrl(req)}/p/estimate/${e.public_token}`;
    full.tech_view = true;
    return full;
  }

  // ---------------------------------------------------------------- tech routes
  app.get('/api/estimates', techOnly, wrap((req, res) => {
    const c = cfg(req);
    const rows = all(db, `SELECT e.*, c.name customer_name, j.number job_number FROM estimates e JOIN customers c ON c.id = e.customer_id LEFT JOIN jobs j ON j.id = e.job_id
      WHERE EXISTS (SELECT 1 FROM job_techs jt WHERE jt.job_id = e.job_id AND jt.user_id = ?1)
         OR EXISTS (SELECT 1 FROM appointments a JOIN appointment_techs t ON t.appointment_id = a.id WHERE a.estimate_id = e.id AND t.user_id = ?1) ORDER BY e.id DESC LIMIT 200`, req.user.id);
    res.json(rows.map(e => { const f = C.estimateWithTotals(db, e); if (!c.seeCosts) { delete f.est_cost; delete f.est_margin_pct; for (const o of f.options) { delete o.est_cost; delete o.est_margin_pct; } for (const it of [...f.items, ...f.chosen_items]) delete it.unit_cost; } return f; }));
  }));
  app.get('/api/estimates/:id', techOnly, wrap((req, res) => { const e = techEstimate(req.user, req.params.id); res.json({ ...forTech(req, e), visits: H.appointments('a.estimate_id = ?', [e.id]) }); }));
  app.post('/api/estimates', techOnly, wrap((req, res) => {
    const c = cfg(req);
    if (!c.enabled) throw bad('Field estimating is turned off — ask the office', 403);
    const b = req.body;
    const job = b.job_id ? get(db, 'SELECT * FROM jobs WHERE id = ?', b.job_id) : null;
    if (!job || !assigned(req.user, job.id)) throw bad('Start an estimate from one of your jobs', 403);
    const cust = mustGet('customers', job.customer_id);
    const changeOrder = job.billing_type === 'fixed' && (job.contract_amount > 0 || get(db, "SELECT 1 x FROM estimates WHERE job_id = ? AND status = 'approved'", job.id)) ? 1 : 0;
    const items = cleanItems(b.items, req);
    const eid = insert('estimates', {
      customer_id: job.customer_id, location_id: job.location_id, job_id: job.id, change_order: changeOrder,
      title: b.title || (changeOrder ? `Change order — ${job.title}` : job.title), notes: b.notes || null, discount: Number(b.discount) || 0,
      number: D.nextNumber(db, 'estimates', 'EST'), public_token: D.token(), created_by: req.user.id,
      tax_rate: cust.tax_exempt ? 0 : Number(c.s.default_tax_rate), terms: c.s.estimate_terms, valid_until: addDays(today(), Number(c.s.estimate_valid_days) || 30),
    });
    saveItems('estimate_items', 'estimate_id', eid, items, saveOptions(eid, b.options) || []);
    const ev = applyReview(eid, req.user.id);
    res.json({ id: eid, review: ev.reasons });
  }));
  app.put('/api/estimates/:id', techOnly, wrap((req, res) => {
    const e = techEstimate(req.user, req.params.id);
    if (e.status === 'approved') throw bad('Approved estimates are locked — start a change order');
    if (['declined', 'expired', 'cancelled'].includes(e.status)) throw bad(`This estimate is ${e.status}`);
    if (req.body.status) throw bad('Only the customer or the office can approve or decline', 403);
    update('estimates', e.id, { ...pick(req.body, ['title', 'notes']), ...(req.body.discount != null ? { discount: Number(req.body.discount) || 0 } : {}) });
    if (req.body.items) saveItems('estimate_items', 'estimate_id', e.id, cleanItems(req.body.items, req), saveOptions(e.id, req.body.options) || (req.body.options ? [] : undefined));
    // any change by the tech after office approval is re-checked from scratch
    if (e.review_status === 'approved' && (req.body.items || req.body.discount != null)) run(db, 'UPDATE estimates SET review_status = NULL WHERE id = ?', e.id);
    const ev = applyReview(e.id, req.user.id);
    res.json({ ok: true, review: ev.reasons });
  }));
  app.delete('/api/estimates/:id', techOnly, wrap((req, res) => {
    const e = techEstimate(req.user, req.params.id);
    if (e.created_by !== req.user.id || e.status !== 'draft') throw bad('You can delete only your own drafts', 403);
    run(db, 'DELETE FROM estimates WHERE id = ?', e.id); res.json({ ok: true });
  }));
  // Put it in front of the customer: makes it signable (unless it's waiting on office review).
  app.post('/api/estimates/:id/present', wrap((req, res) => {
    const e = req.user.role === 'tech' ? techEstimate(req.user, req.params.id) : mustGet('estimates', req.params.id);
    if (e.status === 'cancelled') throw bad('This estimate is cancelled');
    if (e.review_status === 'pending') throw bad('Waiting for the office to approve pricing. The customer can look, but can\'t sign yet.');
    if (e.status === 'draft') run(db, "UPDATE estimates SET status = 'sent', sent_at = datetime('now') WHERE id = ?", e.id);
    res.json({ url: `${baseUrl(req)}/p/estimate/${e.public_token}` });
  }));

  // ---------------------------------------------------------------- office review
  app.post('/api/estimates/:id/review', office, wrap((req, res) => {
    const e = mustGet('estimates', req.params.id);
    const decision = req.body.decision;
    if (!['approve', 'reject'].includes(decision)) throw bad('Approve or send back');
    if (decision === 'reject' && !String(req.body.note || '').trim()) throw bad('Tell the tech what to change');
    run(db, "UPDATE estimates SET review_status = ?, review_note = ?, reviewed_by = ?, reviewed_at = datetime('now') WHERE id = ?",
      decision === 'approve' ? 'approved' : 'rejected', req.body.note || null, req.user.id, e.id);
    if (e.job_id) insert('job_notes', { job_id: e.job_id, user_id: req.user.id, body: decision === 'approve' ? `Office approved pricing on ${e.number}${req.body.note ? `: ${req.body.note}` : ''}` : `Office sent ${e.number} back: ${req.body.note}` });
    res.json({ ok: true });
  }));
  app.get('/api/estimates-review', office, wrap((req, res) => res.json(all(db, `SELECT e.id, e.number, e.title, e.review_reasons, e.created_at, u.name created_by_name, c.name customer_name, j.number job_number
    FROM estimates e JOIN customers c ON c.id = e.customer_id LEFT JOIN users u ON u.id = e.created_by LEFT JOIN jobs j ON j.id = e.job_id
    WHERE e.review_status = 'pending' ORDER BY e.id`).map(r => ({ ...r, review_reasons: JSON.parse(r.review_reasons || '[]') })))));
  app.get('/api/estimates/:id/guard', office, wrap((req, res) => { mustGet('estimates', req.params.id); res.json(evaluate(Number(req.params.id))); }));
};
