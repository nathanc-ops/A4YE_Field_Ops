'use strict';
// Job billing — two separate models:
//
//  FIXED (quoted price): contract = approved quote + approved change orders. Billed by deposit,
//  milestone (schedule of values), percent complete, a set amount, or final. Optional retainage is
//  withheld on each progress bill and released on the final. Costs are tracked but never billed.
//
//  T&M (time & material): every time entry, material line and billable expense is billed once.
//  Labor at the job's rate (or each tech's bill rate), rounded up to the billing increment;
//  materials at price-book price or cost + markup; optional trip charge; optional not-to-exceed cap.
//  Billed items are stamped with their invoice and locked; voiding the invoice releases them.
const D = require('./db');
const C = require('./calc');
const { all, get, run, settings } = D;

const r2 = C.r2;
const err = (m, s = 400) => Object.assign(new Error(m), { status: s });
const today = () => new Date().toISOString().slice(0, 10);
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00'); x.setDate(x.getDate() + n); return x.toISOString().slice(0, 10); };

function invoicesFor(db, jobId) {
  return all(db, "SELECT * FROM invoices WHERE job_id = ? AND status != 'void' ORDER BY issue_date, id", jobId).map(i => C.invoiceWithTotals(db, i));
}
// Amount billed toward the job's price (net of discount, before tax; withheld retainage counts as billed).
const billedToward = invs => r2(invs.reduce((s, i) => s + (i.subtotal - i.discount) + (i.retainage || 0), 0));

// ------------------------------------------------------------ fixed price
function changeOrders(db, jobId) {
  return all(db, 'SELECT * FROM estimates WHERE job_id = ? AND change_order = 1 ORDER BY id', jobId)
    .map(e => { const t = C.estimateWithTotals(db, e); return { id: e.id, number: e.number, title: e.title, status: e.status, amount: r2(t.subtotal - t.discount), approved_at: e.approved_at }; });
}
function contractValue(db, job) {
  const cos = changeOrders(db, job.id).filter(c => c.status === 'approved');
  return { base: r2(job.contract_amount || 0), change_orders: r2(cos.reduce((s, c) => s + c.amount, 0)), total: r2((job.contract_amount || 0) + cos.reduce((s, c) => s + c.amount, 0)) };
}
// Estimated total cost from the budget (hours × average loaded rate of the job's techs + material + other).
// Average loaded labor cost per hour for the job's crew (or all techs when no one is assigned).
function laborRate(db, job) {
  return get(db, `SELECT AVG(u.hourly_wage * (1 + u.burden_pct / 100.0)) r FROM job_techs jt JOIN users u ON u.id = jt.user_id WHERE jt.job_id = ? AND u.hourly_wage > 0`, job.id).r
    || get(db, "SELECT AVG(hourly_wage * (1 + burden_pct / 100.0)) r FROM users WHERE role = 'tech' AND active = 1 AND hourly_wage > 0").r || 0;
}
function budgetCost(db, job) {
  const b = get(db, 'SELECT SUM(budget_hours) h, SUM(budget_material) m, SUM(budget_other) o FROM job_budgets WHERE job_id = ?', job.id);
  const hours = b.h ?? job.budget_hours ?? 0, mat = b.m ?? job.budget_materials ?? 0, other = b.o ?? 0;
  const total = hours * laborRate(db, job) + mat + other;
  return total > 0 ? r2(total) : null;
}
// % complete rolled up from the per-cost-code % complete the PM/foreman enters, weighted by each code's budget
// (hours at the crew rate + material + other). Codes not yet marked count as 0%. null when nothing has been entered.
function codesPercent(db, job) {
  const rows = all(db, 'SELECT * FROM job_budgets WHERE job_id = ?', job.id);
  if (!rows.some(r => r.percent_complete != null)) return null;
  const rate = laborRate(db, job);
  let w = 0, done = 0;
  for (const r of rows) {
    const weight = (r.budget_hours || 0) * (rate || 1) + (r.budget_material || 0) + (r.budget_other || 0);
    w += weight; done += weight * Math.min(100, Math.max(0, r.percent_complete || 0)) / 100;
  }
  return w > 0 ? r2(done / w * 100) : null;
}
function milestonesFor(db, job, contract) {
  return all(db, 'SELECT m.*, i.number invoice_number, i.status invoice_status FROM billing_milestones m LEFT JOIN invoices i ON i.id = m.invoice_id WHERE m.job_id = ? ORDER BY m.sort, m.id', job.id)
    .map(m => ({ ...m, value: r2(m.amount != null ? m.amount : contract * (m.pct || 0) / 100), billed: !!m.invoice_id }));
}
function fixedSummary(db, jobId) {
  const job = get(db, 'SELECT * FROM jobs WHERE id = ?', jobId);
  const cv = contractValue(db, job);
  const invs = invoicesFor(db, jobId);
  const billed = billedToward(invs);
  const retainageHeld = r2(invs.reduce((s, i) => s + (i.retainage || 0), 0));
  const cost = C.jobCosting(db, jobId);
  const estCost = budgetCost(db, job);
  const costPct = estCost ? Math.min(100, cost.total_cost / estCost * 100) : null;
  const codesPct = codesPercent(db, job);
  const pct = job.percent_complete != null ? job.percent_complete : codesPct != null ? codesPct : costPct;
  const earned = pct != null ? r2(cv.total * pct / 100) : null;
  const projectedCost = estCost != null ? Math.max(estCost, cost.total_cost) : cost.total_cost;
  return {
    billing_type: 'fixed', contract: cv, change_orders: changeOrders(db, jobId), milestones: milestonesFor(db, job, cv.total),
    billed_to_date: billed, billed_pct: cv.total ? r2(billed / cv.total * 100) : 0, remaining: r2(cv.total - billed),
    retainage_pct: job.retainage_pct || 0, retainage_held: retainageHeld,
    collected: r2(invs.reduce((s, i) => s + i.paid, 0)), outstanding: r2(invs.reduce((s, i) => s + i.balance, 0)),
    cost_to_date: cost.total_cost, estimated_cost: estCost, cost_pct_complete: costPct != null ? r2(costPct) : null,
    percent_complete: pct != null ? r2(pct) : null, percent_source: job.percent_complete != null ? 'entered' : codesPct != null ? 'cost_codes' : costPct != null ? 'cost' : null,
    earned, over_under: earned != null ? r2(billed - earned) : null, // + over-billed (ahead), − under-billed (behind)
    projected_profit: r2(cv.total - projectedCost), projected_margin_pct: cv.total ? r2((cv.total - projectedCost) / cv.total * 100) : null,
    invoices: invs.map(i => ({ id: i.id, number: i.number, kind: i.billing_kind, issue_date: i.issue_date, status: i.status, amount: r2(i.subtotal - i.discount + (i.retainage || 0)), retainage: i.retainage, total: i.total, balance: i.balance })),
  };
}

function newInvoice(db, job, { kind, notes, periodTo, estimateId, taxRate, discount }) {
  const s = settings(db);
  const cust = get(db, 'SELECT * FROM customers WHERE id = ?', job.customer_id);
  const issue = today();
  const id = Number(run(db, `INSERT INTO invoices (number, customer_id, job_id, estimate_id, issue_date, due_date, tax_rate, discount, notes, terms, public_token, billing_kind, period_to, title)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, D.nextNumber(db, 'invoices', 'INV'), job.customer_id, job.id, estimateId || null, issue,
  addDays(issue, cust.payment_terms_days ?? Number(s.invoice_terms_days)), cust.tax_exempt ? 0 : (taxRate ?? Number(s.default_tax_rate)), discount || 0,
  notes || null, s.invoice_terms, D.token(), kind, periodTo || null, job.title || null).lastInsertRowid);
  let sort = 0;
  const line = (o) => run(db, 'INSERT INTO invoice_items (invoice_id, pricebook_id, description, qty, unit_price, unit_cost, taxable, cost_code_id, sort) VALUES (?,?,?,?,?,?,?,?,?)',
    id, o.pricebook_id || null, o.description, o.qty ?? 1, r2(o.unit_price), o.unit_cost || 0, o.taxable ? 1 : 0, o.cost_code_id || null, sort++);
  return { id, line };
}

function billFixed(db, jobId, b) {
  const job = get(db, 'SELECT * FROM jobs WHERE id = ?', jobId);
  if (!job) throw err('Job not found', 404);
  if (job.billing_type !== 'fixed') throw err('This is a time & material job — use T&M billing');
  const sm = fixedSummary(db, jobId);
  const contract = sm.contract.total;
  const mode = b.mode;
  if (!['deposit', 'milestone', 'percent', 'amount', 'final'].includes(mode)) throw err('Choose deposit, milestone, percent, amount or final');
  if (!contract && mode !== 'deposit' && mode !== 'amount') throw err('Set the contract amount (approve the quote) before progress billing');
  const taxableLines = settings(db).fixed_lines_taxable === '1';
  let gross, label, milestone = null;
  if (mode === 'deposit') {
    gross = b.amount != null && b.amount !== '' ? Number(b.amount) : contract * Number(b.pct || 0) / 100;
    label = `Deposit${b.pct ? ` (${b.pct}% of contract)` : ''}`;
  } else if (mode === 'milestone') {
    milestone = sm.milestones.find(m => m.id === Number(b.milestone_id));
    if (!milestone) throw err('Milestone not found');
    if (milestone.billed) throw err(`“${milestone.name}” was already billed on ${milestone.invoice_number}`);
    gross = milestone.value; label = `Progress billing — ${milestone.name}${milestone.pct ? ` (${milestone.pct}%)` : ''}`;
  } else if (mode === 'percent') {
    const pct = Number(b.pct);
    if (!(pct > 0 && pct <= 100)) throw err('Percent complete must be between 0 and 100');
    gross = contract * pct / 100 - sm.billed_to_date;
    if (gross <= 0.004) throw err(`Already billed ${sm.billed_pct}% — nothing more to bill at ${pct}%`);
    label = `Progress billing — ${pct}% complete`;
    run(db, 'UPDATE jobs SET percent_complete = ? WHERE id = ?', pct, job.id);
  } else if (mode === 'amount') {
    gross = Number(b.amount); label = b.description || 'Progress billing';
  } else {
    gross = sm.remaining; label = 'Final billing — balance of contract';
  }
  gross = r2(gross);
  if (mode !== 'final' && !(gross > 0)) throw err('Amount must be greater than zero');
  if (mode !== 'final' && contract && gross > sm.remaining + 0.005) throw err(`That bills ${gross.toFixed(2)} but only ${sm.remaining.toFixed(2)} of the contract is left. Add a change order for extra work.`);
  if (mode === 'final' && gross <= 0.004 && sm.retainage_held <= 0.004) throw err('Contract is fully billed — nothing left, and no retainage to release');

  const summary = `Contract ${money(contract)}${sm.contract.change_orders ? ` (incl. change orders ${money(sm.contract.change_orders)})` : ''} · billed before this invoice ${money(sm.billed_to_date)} · this invoice ${money(gross)} · remaining after ${money(sm.remaining - gross)}`;
  const base = get(db, "SELECT * FROM estimates WHERE job_id = ? AND change_order = 0 AND status = 'approved' ORDER BY id LIMIT 1", job.id);
  const inv = newInvoice(db, job, { kind: mode, notes: summary, estimateId: base && base.id, taxRate: base ? base.tax_rate : undefined });
  const nothingBilledYet = sm.invoices.length === 0 && !sm.milestones.some(m => m.billed);
  if (mode === 'final' && nothingBilledYet && base) {
    // one-shot job: show the quote's line items (and approved change orders) instead of a lump sum
    const ests = [base.id, ...sm.change_orders.filter(c => c.status === 'approved').map(c => c.id)];
    for (const eid of ests) {
      const est = get(db, 'SELECT * FROM estimates WHERE id = ?', eid);
      for (const it of C.estimateChosenItems(db, eid))
        inv.line({ ...it, description: est.change_order ? `${est.number} change order — ${it.description}` : it.description });
    }
    if (base.discount) run(db, 'UPDATE invoices SET discount = ? WHERE id = ?', base.discount, inv.id);
    // lines are gross of the quote's discount; contract total already nets it, so keep the invoice equal to remaining
    const t = C.invoiceWithTotals(db, get(db, 'SELECT * FROM invoices WHERE id = ?', inv.id));
    const diff = r2(gross - (t.subtotal - t.discount));
    if (Math.abs(diff) >= 0.01) inv.line({ description: 'Contract adjustment', unit_price: diff, taxable: 0 });
  } else if (gross > 0.004) inv.line({ description: `${label} — ${job.number} ${job.title}`, unit_price: gross, taxable: taxableLines });

  let retainage = 0;
  if (mode === 'final' && sm.retainage_held > 0.004) {
    inv.line({ description: 'Retainage release', unit_price: sm.retainage_held, taxable: 0 });
    retainage = -sm.retainage_held;
  } else if (mode !== 'final' && job.retainage_pct > 0) {
    retainage = r2(gross * job.retainage_pct / 100);
    inv.line({ description: `Less retainage withheld (${job.retainage_pct}%)`, unit_price: -retainage, taxable: 0 });
  }
  run(db, 'UPDATE invoices SET retainage = ? WHERE id = ?', retainage, inv.id);
  if (milestone) run(db, 'UPDATE billing_milestones SET invoice_id = ? WHERE id = ?', inv.id, milestone.id);
  if (mode === 'final' && job.status === 'completed') run(db, "UPDATE jobs SET status = 'invoiced' WHERE id = ?", job.id);
  return inv.id;
}

// ------------------------------------------------------------ time & material
function markupPct(db, job) {
  if (job.material_markup_pct != null) return job.material_markup_pct;
  const d = settings(db).tm_default_markup_pct;
  return d !== '' && d != null ? Number(d) : null;
}
function tmSummary(db, jobId, through) {
  const job = get(db, 'SELECT * FROM jobs WHERE id = ?', jobId);
  const s = settings(db);
  const inc = Math.max(1, Number(s.tm_billing_increment_minutes) || 15) / 60;
  const until = through ? C.endOfDay(through) : '9999';
  const kinds = job.bill_travel ? "('job','travel')" : "('job')";
  const entries = all(db, `SELECT t.*, u.name user_name, u.bill_rate FROM time_entries t JOIN users u ON u.id = t.user_id
    WHERE t.job_id = ? AND t.kind IN ${kinds} AND t.billable = 1 AND t.invoice_id IS NULL AND t.clock_out IS NOT NULL AND t.clock_in < ? ORDER BY t.clock_in`, jobId, until);
  const stillOpen = get(db, 'SELECT COUNT(*) n FROM time_entries WHERE job_id = ? AND clock_out IS NULL', jobId).n;
  const byTech = new Map();
  for (const t of entries) {
    const rate = job.labor_rate ?? t.bill_rate ?? 0;
    const key = `${t.user_id}:${rate}`;
    const g = byTech.get(key) || { user_id: t.user_id, name: t.user_name, rate, hours: 0, cost: 0, first: t.clock_in, last: t.clock_in, entry_ids: [] };
    const h = (new Date(t.clock_out) - new Date(t.clock_in)) / 36e5;
    g.hours += h; g.cost += h * t.hourly_cost; g.last = t.clock_in; g.entry_ids.push(t.id);
    byTech.set(key, g);
  }
  const labor = [...byTech.values()].map(g => {
    // round each tech's total up to the increment, with 30 s grace so 4:00:02 bills as 4.00 h, not 4.25
    const billHours = Math.ceil(Math.max(0, g.hours - 0.5 / 60) / inc - 1e-9) * inc;
    return { ...g, hours: r2(g.hours), bill_hours: r2(billHours), amount: r2(billHours * g.rate), unit_cost: g.hours ? r2(g.cost / g.hours) : 0 };
  });
  const mk = markupPct(db, job);
  const materials = all(db, `SELECT m.*, pb.taxable pb_taxable FROM job_materials m LEFT JOIN pricebook pb ON pb.id = m.pricebook_id
    WHERE m.job_id = ? AND m.billable = 1 AND m.invoice_id IS NULL AND m.used_on <= ? ORDER BY m.used_on, m.id`, jobId, through || '9999')
    .map(m => { const price = mk != null ? r2(m.unit_cost * (1 + mk / 100)) : m.unit_price; return { ...m, bill_price: price, amount: r2(price * m.qty) }; });
  const expenses = all(db, 'SELECT * FROM expenses WHERE job_id = ? AND billable = 1 AND invoice_id IS NULL AND date <= ? ORDER BY date, id', jobId, through || '9999')
    .map(e => ({ ...e, bill_amount: r2(e.amount * (1 + (mk || 0) / 100)) }));
  const trip = job.trip_charge > 0 && !job.trip_invoice_id ? r2(job.trip_charge) : 0;
  const invs = invoicesFor(db, jobId);
  const billed = billedToward(invs);
  const sum = a => r2(a.reduce((s, x) => s + x, 0));
  const unbilled = { labor: sum(labor.map(l => l.amount)), materials: sum(materials.map(m => m.amount)), expenses: sum(expenses.map(e => e.bill_amount)), trip };
  unbilled.total = r2(unbilled.labor + unbilled.materials + unbilled.expenses + unbilled.trip);
  return {
    billing_type: 'tm', labor_rate: job.labor_rate, markup_pct: mk, increment_minutes: Math.round(inc * 60), bill_travel: !!job.bill_travel,
    labor, materials, expenses, trip, unbilled, open_time_entries: stillOpen,
    billed_to_date: billed, collected: r2(invs.reduce((s, i) => s + i.paid, 0)), outstanding: r2(invs.reduce((s, i) => s + i.balance, 0)),
    nte: job.nte_amount, nte_remaining: job.nte_amount != null ? r2(job.nte_amount - billed) : null,
    nte_after: job.nte_amount != null ? r2(job.nte_amount - billed - unbilled.total) : null,
    cost_to_date: C.jobCosting(db, jobId).total_cost,
    invoices: invs.map(i => ({ id: i.id, number: i.number, kind: i.billing_kind, issue_date: i.issue_date, period_to: i.period_to, status: i.status, amount: r2(i.subtotal - i.discount), total: i.total, balance: i.balance })),
  };
}
function billTM(db, jobId, b = {}) {
  const job = get(db, 'SELECT * FROM jobs WHERE id = ?', jobId);
  if (!job) throw err('Job not found', 404);
  if (job.billing_type !== 'tm') throw err('This is a quoted-price job — use progress or final billing');
  const inc = { labor: true, materials: true, expenses: true, trip: true, ...(b.include || {}) };
  const sm = tmSummary(db, jobId, b.through);
  const total = (inc.labor ? sm.unbilled.labor : 0) + (inc.materials ? sm.unbilled.materials : 0) + (inc.expenses ? sm.unbilled.expenses : 0) + (inc.trip ? sm.unbilled.trip : 0);
  if (total <= 0.004) throw err(sm.open_time_entries ? 'Nothing billable yet — someone is still clocked in on this job' : 'Nothing unbilled on this job');
  if (job.nte_amount != null && sm.billed_to_date + total > job.nte_amount + 0.005 && !b.allow_over_nte)
    throw err(`This invoice (${money(total)}) would take the job to ${money(sm.billed_to_date + total)}, over its not-to-exceed of ${money(job.nte_amount)}. Get the customer's approval to raise the NTE, or confirm to bill anyway.`);
  const s = settings(db);
  const fmt = iso => new Date(iso).toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' });
  const inv = newInvoice(db, job, { kind: 'tm', periodTo: b.through || today(),
    notes: `Time & material billing${b.through ? ` through ${b.through}` : ''}. Labor billed in ${sm.increment_minutes}-minute increments.${job.nte_amount != null ? ` Not-to-exceed ${money(job.nte_amount)}; billed to date after this invoice ${money(sm.billed_to_date + total)}.` : ''}` });
  if (inc.trip && sm.trip) { inv.line({ description: 'Trip / service charge', unit_price: sm.trip, taxable: 0 }); run(db, 'UPDATE jobs SET trip_invoice_id = ? WHERE id = ?', inv.id, job.id); }
  if (inc.labor) for (const l of sm.labor) {
    const dates = fmt(l.first) === fmt(l.last) ? fmt(l.first) : `${fmt(l.first)}–${fmt(l.last)}`;
    inv.line({ description: `Electrical labor — ${l.name} (${dates})`, qty: l.bill_hours, unit_price: l.rate, unit_cost: l.unit_cost, taxable: 0 });
    run(db, `UPDATE time_entries SET invoice_id = ? WHERE id IN (${l.entry_ids.map(() => '?').join(',')})`, inv.id, ...l.entry_ids);
  }
  if (inc.materials) for (const m of sm.materials) {
    inv.line({ pricebook_id: m.pricebook_id, description: m.description, qty: m.qty, unit_price: m.bill_price, unit_cost: m.unit_cost, cost_code_id: m.cost_code_id,
      taxable: s.tm_material_taxable === '1' && (m.pb_taxable ?? 1) });
    run(db, 'UPDATE job_materials SET invoice_id = ?, invoiced = 1 WHERE id = ?', inv.id, m.id);
  }
  if (inc.expenses) for (const e of sm.expenses) {
    inv.line({ description: [e.category, e.vendor, e.description].filter(Boolean).join(' — '), unit_price: e.bill_amount, unit_cost: e.amount, cost_code_id: e.cost_code_id, taxable: 0 });
    run(db, 'UPDATE expenses SET invoice_id = ? WHERE id = ?', inv.id, e.id);
  }
  return inv.id;
}

// ------------------------------------------------------------ shared
// Voiding/deleting an invoice frees what it billed so it can be billed again.
function releaseInvoice(db, invoiceId) {
  run(db, 'UPDATE time_entries SET invoice_id = NULL WHERE invoice_id = ?', invoiceId);
  run(db, 'UPDATE job_materials SET invoice_id = NULL, invoiced = 0 WHERE invoice_id = ?', invoiceId);
  run(db, 'UPDATE expenses SET invoice_id = NULL WHERE invoice_id = ?', invoiceId);
  run(db, 'UPDATE billing_milestones SET invoice_id = NULL WHERE invoice_id = ?', invoiceId);
  run(db, 'UPDATE jobs SET trip_invoice_id = NULL WHERE trip_invoice_id = ?', invoiceId);
}
// Billed time/materials/expenses can't change underneath their invoice.
function assertUnbilled(db, table, id) {
  const r = get(db, `SELECT invoice_id FROM ${table} WHERE id = ?`, id);
  if (!r || !r.invoice_id) return;
  if (r.invoice_id === -1) throw err('This was billed before the billing upgrade and is locked');
  const inv = get(db, "SELECT number, status FROM invoices WHERE id = ?", r.invoice_id);
  if (inv && inv.status !== 'void') throw err(`Already billed on ${inv.number}. Void that invoice (or delete it while it's a draft) to change this.`);
}
function jobBilling(db, jobId, through) {
  const job = get(db, 'SELECT billing_type FROM jobs WHERE id = ?', jobId);
  return job.billing_type === 'fixed' ? fixedSummary(db, jobId) : tmSummary(db, jobId, through);
}
// Work-in-progress & unbilled report: every open (not cancelled) job with billing activity.
function wipReport(db) {
  const jobs = all(db, `SELECT j.id, j.number, j.title, j.status, j.billing_type, c.name customer_name FROM jobs j JOIN customers c ON c.id = j.customer_id
    WHERE j.status != 'cancelled' AND (j.status != 'invoiced' OR j.billing_type = 'tm') ORDER BY j.id DESC`);
  const fixed = [], tm = [];
  for (const j of jobs) {
    if (j.billing_type === 'fixed') {
      const s = fixedSummary(db, j.id);
      if (!s.contract.total && !s.billed_to_date) continue;
      fixed.push({ ...j, contract: s.contract.total, cost_to_date: s.cost_to_date, estimated_cost: s.estimated_cost, percent_complete: s.percent_complete, earned: s.earned, billed: s.billed_to_date,
        over_under: s.over_under, remaining: s.remaining, retainage_held: s.retainage_held, projected_profit: s.projected_profit });
    } else {
      const s = tmSummary(db, j.id);
      if (!s.unbilled.total && (!s.billed_to_date || j.status === 'invoiced')) continue; // nothing waiting to bill
      tm.push({ ...j, unbilled: s.unbilled.total, unbilled_hours: r2(s.labor.reduce((x, l) => x + l.bill_hours, 0)), billed: s.billed_to_date, nte: s.nte, nte_after: s.nte_after, cost_to_date: s.cost_to_date, open_time_entries: s.open_time_entries });
    }
  }
  const sum = (a, k) => r2(a.reduce((s, x) => s + (x[k] || 0), 0));
  return { fixed, tm, totals: { contract: sum(fixed, 'contract'), billed_fixed: sum(fixed, 'billed'), over_billed: sum(fixed.filter(f => f.over_under > 0), 'over_under'),
    under_billed: r2(-sum(fixed.filter(f => f.over_under < 0), 'over_under')), retainage_held: sum(fixed, 'retainage_held'), unbilled_tm: sum(tm, 'unbilled') } };
}
function money(n) { return (Number(n) || 0).toLocaleString('en-US', { style: 'currency', currency: 'USD' }); }

module.exports = { laborRate, codesPercent, contractValue, fixedSummary, billFixed, tmSummary, billTM, releaseInvoice, assertUnbilled, jobBilling, wipReport, changeOrders };
