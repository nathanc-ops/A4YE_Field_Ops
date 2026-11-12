'use strict';
// Sales pipeline, modelled on Salesforce's Lead → Opportunity (stages, probability, close date, next step, owner)
// → Quote → Order → Invoice flow, but built from the records Field Ops already keeps, so nothing is typed twice:
//
//   Lead          a customer marked as a lead (or new in the last 60 days with nothing yet) — Salesforce's Lead
//   Estimating    an estimate being written (draft / waiting for review)                   — Opportunity: Needs analysis
//   Proposal      an estimate sent or viewed                                               — Opportunity: Proposal / quote
//   Won           an approved estimate with no job yet, or a job not yet scheduled         — Closed won → order
//   In progress   a job scheduled, dispatched, underway or on hold — even when part-billed  — Order being fulfilled
//                 (progress billing: the job card shows what's left to bill, its bills sit under Invoiced)
//   To invoice    a job completed, not fully invoiced                                      — Order ready to bill
//   Invoiced      an invoice sent and not paid                                             — Invoice open
//   Paid          an invoice paid in the last 30 days                                      — Closed (cash in)
//   Lost          an estimate declined (90 days) or a lead marked unqualified (shown on request)
//
// Each record appears once, at its furthest point: a customer with an estimate is the estimate; an estimate with a job
// is the job; a finished job with an open invoice is the invoice. A job still underway keeps its card while its progress
// bills show under Invoiced, so its amount is what's left to bill (no money counted twice). Probability gives the weighted forecast for the open stages.
const D = require('./db');
const C = require('./calc');
const { all, get, run } = D;

const STAGES = [
  { key: 'lead', label: 'Lead', prob: 10, group: 'open' },
  { key: 'estimating', label: 'Estimating', prob: 25, group: 'open' },
  { key: 'proposal', label: 'Proposal sent', prob: 50, group: 'open' },
  { key: 'won', label: 'Won — to schedule', prob: 100, group: 'booked' },
  { key: 'in_progress', label: 'In progress', prob: 100, group: 'booked' },
  { key: 'to_invoice', label: 'To invoice', prob: 100, group: 'booked' },
  { key: 'invoiced', label: 'Invoiced — awaiting payment', prob: 100, group: 'billed' },
  { key: 'paid', label: 'Paid (30 days)', prob: 100, group: 'closed' },
  { key: 'lost', label: 'Lost', prob: 0, group: 'closed' },
];
const LEAD_STATUSES = ['new', 'contacted', 'qualified', 'unqualified'];
const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
const dayOf = v => (v ? String(v).slice(0, 10) : null);

module.exports = function pipelineRoutes(app, db, { wrap, bad, office, today, addDays }) {
  function build({ includeLost = false } = {}) {
    const t = today(), cards = [];
    const users = new Map(all(db, 'SELECT id, name FROM users').map(u => [u.id, u.name]));
    const add = c => cards.push({ ...c, owner_name: c.owner_id ? users.get(c.owner_id) || null : null, amount: r2(c.amount),
      age_days: c.since ? Math.max(0, Math.floor((Date.parse(t) - Date.parse(dayOf(c.since))) / 864e5)) : null,
      overdue: !!(c.next_step_date && c.next_step_date < t) });

    // ---- invoices (furthest along)
    const invoices = all(db, "SELECT i.*, c.name customer_name, c.type customer_type FROM invoices i JOIN customers c ON c.id = i.customer_id WHERE i.status NOT IN ('void')")
      .map(i => ({ ...C.invoiceWithTotals(db, i), customer_name: i.customer_name, customer_type: i.customer_type }));
    const jobsWithInvoice = new Map();
    for (const i of invoices) {
      if (i.job_id) jobsWithInvoice.set(i.job_id, (jobsWithInvoice.get(i.job_id) || 0) + (i.subtotal - i.discount));
      if (i.status === 'draft') continue;
      if (i.balance > 0.005) {
        add({ kind: 'invoice', id: i.id, stage: 'invoiced', href: `#/invoices/${i.id}`, number: i.number, title: i.title || '', customer_id: i.customer_id, customer_name: i.customer_name,
          customer_type: i.customer_type, amount: i.balance, since: i.sent_at || i.issue_date, close_date: i.due_date, job_id: i.job_id,
          flag: i.due_date && i.due_date < t ? `${Math.floor((Date.parse(t) - Date.parse(i.due_date)) / 864e5)} days past due` : '' });
      } else {
        const last = (get(db, 'SELECT MAX(paid_at) d FROM payments WHERE invoice_id = ?', i.id) || {}).d;
        if (last && dayOf(last) >= addDays(t, -30))
          add({ kind: 'invoice', id: i.id, stage: 'paid', href: `#/invoices/${i.id}`, number: i.number, title: i.title || '', customer_id: i.customer_id, customer_name: i.customer_name,
            customer_type: i.customer_type, amount: i.total, since: last, job_id: i.job_id });
      }
    }

    // ---- jobs
    const jobs = all(db, `SELECT j.*, c.name customer_name, c.type customer_type FROM jobs j JOIN customers c ON c.id = j.customer_id
      WHERE j.status NOT IN ('cancelled')`);
    const jobOfEstimate = new Set();
    for (const j of jobs) {
      const est = get(db, "SELECT * FROM estimates WHERE job_id = ? AND status = 'approved' AND COALESCE(change_order, 0) = 0 ORDER BY id LIMIT 1", j.id);
      if (est) jobOfEstimate.add(est.id);
      for (const e of all(db, 'SELECT id FROM estimates WHERE job_id = ?', j.id)) jobOfEstimate.add(e.id);
      // the job's value: a fixed-price job's contract with approved change orders; otherwise its contract or approved estimate
      const contract = j.billing_type === 'fixed' ? Number(require('./billing').contractValue(db, j).total) || 0 : 0;
      const value = contract || Number(j.contract_amount) || (est ? approvedTotal(est) : 0);
      const invoiced = jobsWithInvoice.get(j.id) || 0, left = Math.max(0, value - invoiced);
      const active = ['unscheduled', 'scheduled', 'dispatched', 'in_progress', 'on_hold'].includes(j.status);
      let stage = null, since = null;
      // Work still going on stays where the work is, even when it's been billed in part (progress billing / pay apps on a
      // commercial project, a deposit on a service job): the bills show under Invoiced, the job shows what's left to bill.
      if (j.status === 'unscheduled') { stage = 'won'; since = est ? est.approved_at : j.created_at; }
      else if (active) { stage = 'in_progress'; since = j.scheduled_start || j.start_date || j.created_at; }
      else if (j.status === 'completed' || j.status === 'invoiced') {
        // done: whatever isn't billed yet is to invoice; fully billed jobs are on their invoices
        if (invoiced > 0 ? left <= 1 : j.status === 'invoiced') continue;
        stage = 'to_invoice'; since = j.completed_at || j.created_at;
      }
      if (!stage) continue;
      const pct = value > 0 ? Math.round(invoiced / value * 100) : null;
      add({ kind: 'job', id: j.id, stage, href: `#/jobs/${j.id}`, number: j.number, title: j.title || '', customer_id: j.customer_id, customer_name: j.customer_name, customer_type: j.customer_type,
        amount: invoiced > 0 ? left : value, contract_value: value, billed: Math.round(invoiced * 100) / 100, billed_pct: invoiced > 0 ? pct : null, is_project: !!j.is_project,
        since, owner_id: j.pipeline_owner_id || j.project_manager_id || (est && (est.owner_id || est.created_by)) || null,
        next_step: j.next_step, next_step_date: j.next_step_date, close_date: j.end_date || null,
        flag: j.status === 'on_hold' ? `on hold: ${String(j.hold_reason || '').slice(0, 60)}` : !value ? 'no contract or estimate amount' : '' });
    }

    // ---- estimates (not change orders, not on a job)
    const ests = all(db, `SELECT e.*, c.name customer_name, c.type customer_type FROM estimates e JOIN customers c ON c.id = e.customer_id
      WHERE COALESCE(e.change_order, 0) = 0 AND e.status != 'cancelled'`);
    const custWithDeal = new Set(cards.map(c => c.customer_id));
    for (const e of ests) {
      if (e.job_id || jobOfEstimate.has(e.id)) continue;
      const tot = C.estimateWithTotals(db, e);
      const big = tot.options.length ? tot.price_max : tot.total;
      let stage = null, since = null, amount = big;
      if (e.status === 'draft') { stage = 'estimating'; since = e.created_at; }
      else if (['sent', 'viewed'].includes(e.status)) { stage = 'proposal'; since = e.sent_at || e.created_at; }
      else if (e.status === 'expired') { stage = 'proposal'; since = e.sent_at || e.created_at; }
      else if (e.status === 'approved') { stage = 'won'; since = e.approved_at; amount = approvedTotal(e); }
      else if (e.status === 'declined') { if (!includeLost || dayOf(e.declined_at || e.created_at) < addDays(t, -90)) continue; stage = 'lost'; since = e.declined_at || e.created_at; }
      if (!stage) continue;
      custWithDeal.add(e.customer_id);
      const expired = ['sent', 'viewed', 'expired'].includes(e.status) && e.valid_until && e.valid_until < t;
      add({ kind: 'estimate', id: e.id, stage, href: `#/estimates/${e.id}`, number: e.number, title: e.title || '', customer_id: e.customer_id, customer_name: e.customer_name, customer_type: e.customer_type,
        amount, since, owner_id: e.owner_id || e.created_by || null, next_step: e.next_step, next_step_date: e.next_step_date, close_date: e.close_date || e.valid_until || null,
        lost_reason: e.lost_reason || null, status: e.status,
        flag: e.review_status === 'pending' ? 'needs office review' : expired ? `price expired ${e.valid_until}` : e.status === 'viewed' ? 'customer viewed it' : '' });
    }

    // ---- leads: marked as leads, or new in the last 60 days with nothing else yet
    const leads = all(db, `SELECT c.* FROM customers c WHERE (c.lead_status IN ('new','contacted','qualified') OR (c.lead_status IS NULL AND date(c.created_at) >= ?)
        ${includeLost ? "OR c.lead_status = 'unqualified'" : ''})
      AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.customer_id = c.id AND j.status != 'cancelled') AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.customer_id = c.id AND i.status != 'void')`, addDays(t, -60));
    for (const c of leads) {
      if (custWithDeal.has(c.id) && c.lead_status !== 'unqualified') continue;
      const lost = c.lead_status === 'unqualified';
      if (lost && dayOf(c.lead_status_at || c.created_at) < addDays(t, -90)) continue;
      add({ kind: 'lead', id: c.id, stage: lost ? 'lost' : 'lead', href: `#/customers/${c.id}`, number: '', title: c.company ? c.name : (c.lead_source ? `via ${c.lead_source}` : ''),
        customer_id: c.id, customer_name: c.company || c.name, customer_type: c.type, amount: c.est_value || 0, since: c.lead_status_at || c.created_at, owner_id: c.owner_id || null,
        next_step: c.next_step, next_step_date: c.next_step_date, close_date: null, lead_status: c.lead_status || 'new', lost_reason: lost ? c.lost_reason : null,
        flag: !c.phone && !c.email ? 'no phone or email' : '' });
    }
    return cards;
  }
  function approvedTotal(e) {
    const t = C.estimateWithTotals(db, e);
    if (!t.options.length) return t.total;
    const o = t.options.find(x => x.id === e.approved_option_id);
    return o ? o.total : t.price_max;
  }

  app.get('/api/pipeline', office, wrap((req, res) => {
    let cards = build({ includeLost: req.query.lost === '1' });
    if (req.query.owner_id === 'none') cards = cards.filter(c => !c.owner_id);
    else if (req.query.owner_id) cards = cards.filter(c => c.owner_id === Number(req.query.owner_id));
    if (req.query.type) cards = cards.filter(c => c.customer_type === req.query.type);
    if (req.query.q) { const q = String(req.query.q).toLowerCase(); cards = cards.filter(c => `${c.customer_name} ${c.title} ${c.number}`.toLowerCase().includes(q)); }
    const stages = STAGES.filter(s => s.key !== 'lost' || req.query.lost === '1').map(s => {
      const list = cards.filter(c => c.stage === s.key);
      const amount = r2(list.reduce((a, c) => a + c.amount, 0));
      return { ...s, count: list.length, amount, weighted: r2(amount * s.prob / 100) };
    });
    const sum = g => r2(stages.filter(s => s.group === g).reduce((a, s) => a + s.amount, 0));
    const open = stages.filter(s => s.group === 'open');
    // win rate: estimates decided in the last 90 days
    const decided = get(db, `SELECT SUM(status = 'approved') won, COUNT(*) n FROM estimates WHERE COALESCE(change_order, 0) = 0 AND status IN ('approved','declined')
      AND date(COALESCE(approved_at, declined_at, created_at)) >= ?`, addDays(today(), -90));
    res.json({ stages, cards, totals: { open: sum('open'), weighted: r2(open.reduce((a, s) => a + s.weighted, 0)), booked: sum('booked'), billed: sum('billed'), closed: sum('closed'),
      overdue_steps: cards.filter(c => c.overdue).length, win_rate: decided && decided.n ? Math.round(decided.won / decided.n * 100) : null, decided: decided ? decided.n : 0 } });
  }));

  // the stage a single record is at (the "path" bar on a customer, estimate or job)
  app.get('/api/pipeline/path', office, wrap((req, res) => {
    const kind = ['lead', 'estimate', 'job', 'invoice'].includes(req.query.kind) ? req.query.kind : null, id = Number(req.query.id);
    if (!kind || !id) throw bad('Which record?');
    const cards = build({ includeLost: true });
    let c = cards.find(x => x.kind === kind && x.id === id);
    // a job that has moved on to an invoice, or an estimate that became a job: follow it
    if (!c && kind === 'estimate') { const e = get(db, 'SELECT job_id FROM estimates WHERE id = ?', id); if (e && e.job_id) c = cards.find(x => x.kind === 'job' && x.id === e.job_id) || cards.find(x => x.kind === 'invoice' && x.job_id === e.job_id); }
    if (!c && kind === 'job') c = cards.find(x => x.kind === 'invoice' && x.job_id === id);
    res.json({ stages: STAGES.map(s => ({ key: s.key, label: s.label })), card: c || null });
  }));

  // next step / owner / expected close (Salesforce's "Next Step" and "Close Date"); lead status and value on a lead
  app.put('/api/pipeline/:kind/:id', office, wrap((req, res) => {
    const { kind } = req.params, id = Number(req.params.id), b = req.body || {};
    const table = { lead: 'customers', estimate: 'estimates', job: 'jobs' }[kind];
    if (!table) throw bad('Next steps go on a lead, estimate or job');
    if (!get(db, `SELECT 1 x FROM ${table} WHERE id = ?`, id)) throw bad('Not found', 404);
    const up = {};
    if ('next_step' in b) up.next_step = String(b.next_step || '').trim().slice(0, 300) || null;
    if ('next_step_date' in b) { if (b.next_step_date && !/^\d{4}-\d\d-\d\d$/.test(b.next_step_date)) throw bad('Next step date?'); up.next_step_date = b.next_step_date || null; }
    if ('owner_id' in b) { if (b.owner_id && !get(db, 'SELECT 1 x FROM users WHERE id = ? AND active = 1', Number(b.owner_id))) throw bad('Pick an active user'); up[kind === 'job' ? 'pipeline_owner_id' : 'owner_id'] = b.owner_id ? Number(b.owner_id) : null; }
    if (kind === 'estimate' && 'close_date' in b) up.close_date = b.close_date || null;
    if (kind === 'estimate' && 'lost_reason' in b) up.lost_reason = String(b.lost_reason || '').trim().slice(0, 300) || null;
    if (kind === 'lead') {
      if ('lead_status' in b) {
        if (b.lead_status && !LEAD_STATUSES.includes(b.lead_status)) throw bad('Lead status: new, contacted, qualified or unqualified');
        if (b.lead_status === 'unqualified' && !String(b.lost_reason || '').trim()) throw bad('Say why the lead is unqualified');
        up.lead_status = b.lead_status || null; up.lead_status_at = new Date().toISOString();
      }
      if ('lost_reason' in b) up.lost_reason = String(b.lost_reason || '').trim().slice(0, 300) || null;
      if ('est_value' in b) { const v = b.est_value === '' || b.est_value == null ? null : Number(b.est_value); if (v != null && !(v >= 0)) throw bad('Value must be a number'); up.est_value = v; }
    }
    const keys = Object.keys(up); if (!keys.length) return res.json({ ok: true });
    run(db, `UPDATE ${table} SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map(k => up[k]), id);
    res.json({ ok: true });
  }));
};
module.exports.STAGES = STAGES;
