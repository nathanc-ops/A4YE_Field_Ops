'use strict';
// Money math, job costing and reporting. All report SQL lives here.
const { all, get, settings } = require('./db');

const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
const hoursBetween = (a, b) => (new Date(b) - new Date(a)) / 3600000;

// Totals for an estimate or invoice given its line items.
function docTotals(doc, items) {
  let subtotal = 0, taxableBase = 0, cost = 0;
  for (const it of items) {
    const line = (Number(it.qty) || 0) * (Number(it.unit_price) || 0);
    subtotal += line;
    if (it.taxable) taxableBase += line;
    cost += (Number(it.qty) || 0) * (Number(it.unit_cost) || 0);
  }
  const discount = Math.min(Number(doc.discount) || 0, subtotal);
  // discount is applied proportionally to the taxable base
  const taxableAfterDiscount = subtotal > 0 ? taxableBase * (1 - discount / subtotal) : 0;
  const tax = taxableAfterDiscount * (Number(doc.tax_rate) || 0) / 100;
  const total = subtotal - discount + tax;
  const net = subtotal - discount;
  return {
    subtotal: r2(subtotal), discount: r2(discount), tax: r2(tax), total: r2(total),
    est_cost: r2(cost), est_margin_pct: net > 0 ? r2((net - cost) / net * 100) : 0,
  };
}

function invoiceWithTotals(db, inv) {
  const items = all(db, 'SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY sort, id', inv.id);
  const payments = all(db, 'SELECT * FROM payments WHERE invoice_id = ? ORDER BY paid_at, id', inv.id);
  const t = docTotals(inv, items);
  const paid = r2(payments.reduce((s, p) => s + p.amount, 0));
  return { ...inv, items, payments, ...t, paid, balance: r2(t.total - paid) };
}

function estimateWithTotals(db, est) {
  const items = all(db, 'SELECT * FROM estimate_items WHERE estimate_id = ? ORDER BY sort, id', est.id);
  return { ...est, items, ...docTotals(est, items) };
}

// Recompute invoice status from payments (never touches draft/void).
function refreshInvoiceStatus(db, invoiceId) {
  const inv = get(db, 'SELECT * FROM invoices WHERE id = ?', invoiceId);
  if (!inv || inv.status === 'void' || inv.status === 'draft') return;
  const full = invoiceWithTotals(db, inv);
  const status = full.balance <= 0.004 ? 'paid' : full.paid > 0 ? 'partial' : 'sent';
  db.prepare('UPDATE invoices SET status = ? WHERE id = ?').run(status, invoiceId);
}

// ---------------------------------------------------------------- job costing
function jobCosting(db, jobId) {
  const job = get(db, 'SELECT * FROM jobs WHERE id = ?', jobId);
  if (!job) return null;
  const now = new Date().toISOString();
  const time = all(db, 'SELECT * FROM time_entries WHERE job_id = ?', jobId);
  let hours = 0, laborCost = 0;
  for (const t of time) {
    const h = Math.max(0, hoursBetween(t.clock_in, t.clock_out || now));
    hours += h; laborCost += h * t.hourly_cost;
  }
  const mat = get(db, `SELECT COALESCE(SUM(qty*unit_cost),0) cost, COALESCE(SUM(CASE WHEN billable THEN qty*unit_price ELSE 0 END),0) price
                       FROM job_materials WHERE job_id = ?`, jobId);
  const other = get(db, 'SELECT COALESCE(SUM(amount),0) v FROM expenses WHERE job_id = ?', jobId).v;
  const permitFees = get(db, 'SELECT COALESCE(SUM(fee),0) v FROM permits WHERE job_id = ?', jobId).v;
  const invoices = all(db, "SELECT * FROM invoices WHERE job_id = ? AND status != 'void'", jobId).map(i => invoiceWithTotals(db, i));
  // revenue excludes sales tax (tax is a pass-through liability, not income)
  const revenue = invoices.reduce((s, i) => s + i.subtotal - i.discount, 0);
  const collected = invoices.reduce((s, i) => s + i.paid, 0);
  const totalCost = laborCost + mat.cost + other + permitFees;
  const basis = revenue || job.contract_amount || 0;
  return {
    hours: r2(hours), labor_cost: r2(laborCost), materials_cost: r2(mat.cost), materials_billable: r2(mat.price),
    other_cost: r2(other), permit_fees: r2(permitFees), total_cost: r2(totalCost),
    revenue: r2(revenue), collected: r2(collected), contract_amount: job.contract_amount,
    profit: r2(basis - totalCost), margin_pct: basis > 0 ? r2((basis - totalCost) / basis * 100) : null,
    budget_hours: job.budget_hours, hours_variance: job.budget_hours != null ? r2(job.budget_hours - hours) : null,
    budget_materials: job.budget_materials,
  };
}

// ---------------------------------------------------------------- reports
// Time entries overlapping [from, to) — hours are clipped to the range.
function timeInRange(db, from, to, extraWhere = '', ...params) {
  const now = new Date().toISOString();
  const rows = all(db, `SELECT t.*, u.name user_name, j.number job_number, j.title job_title
    FROM time_entries t JOIN users u ON u.id = t.user_id LEFT JOIN jobs j ON j.id = t.job_id
    WHERE t.clock_in < ? AND COALESCE(t.clock_out, ?) > ? ${extraWhere}
    ORDER BY t.clock_in`, to, now, from, ...params);
  for (const t of rows) {
    const s = new Date(Math.max(new Date(t.clock_in), new Date(from)));
    const e = new Date(Math.min(new Date(t.clock_out || now), new Date(to)));
    t.hours = Math.max(0, (e - s) / 3600000);
  }
  return rows;
}

const endOfDay = d => new Date(new Date(d + 'T00:00:00').getTime() + 86400000).toISOString();
const startOfDay = d => new Date(d + 'T00:00:00').toISOString();

function profitAndLoss(db, from, to) {
  const invs = all(db, "SELECT * FROM invoices WHERE status != 'draft' AND status != 'void' AND issue_date >= ? AND issue_date <= ?", from, to)
    .map(i => invoiceWithTotals(db, i));
  const revenueByType = {};
  let revenue = 0, salesTax = 0;
  for (const i of invs) {
    const net = i.subtotal - i.discount;
    revenue += net; salesTax += i.tax;
    const job = i.job_id ? get(db, 'SELECT job_type FROM jobs WHERE id = ?', i.job_id) : null;
    const cust = get(db, 'SELECT type FROM customers WHERE id = ?', i.customer_id);
    const key = `${cust ? cust.type : 'unknown'} / ${job ? job.job_type : 'no job'}`;
    revenueByType[key] = (revenueByType[key] || 0) + net;
  }
  const collected = get(db, 'SELECT COALESCE(SUM(amount),0) v FROM payments WHERE paid_at >= ? AND paid_at <= ?', from, to).v;

  const time = timeInRange(db, startOfDay(from), endOfDay(to));
  let directLabor = 0, indirectLabor = 0, directHours = 0, indirectHours = 0;
  for (const t of time) {
    const c = t.hours * t.hourly_cost;
    if (t.job_id && (t.kind === 'job' || t.kind === 'travel')) { directLabor += c; directHours += t.hours; }
    else { indirectLabor += c; indirectHours += t.hours; }
  }
  const materials = get(db, 'SELECT COALESCE(SUM(qty*unit_cost),0) v FROM job_materials WHERE used_on >= ? AND used_on <= ?', from, to).v;
  const permitFees = get(db, 'SELECT COALESCE(SUM(fee),0) v FROM permits WHERE COALESCE(applied_date, date(created_at)) >= ? AND COALESCE(applied_date, date(created_at)) <= ?', from, to).v;
  const jobExpenses = all(db, 'SELECT category, SUM(amount) amount FROM expenses WHERE job_id IS NOT NULL AND date >= ? AND date <= ? GROUP BY category ORDER BY amount DESC', from, to);
  const overhead = all(db, 'SELECT category, SUM(amount) amount FROM expenses WHERE job_id IS NULL AND date >= ? AND date <= ? GROUP BY category ORDER BY amount DESC', from, to);
  const jobExpTotal = jobExpenses.reduce((s, e) => s + e.amount, 0);
  const overheadTotal = overhead.reduce((s, e) => s + e.amount, 0) + indirectLabor;
  const cogs = directLabor + materials + jobExpTotal + permitFees;
  const gross = revenue - cogs;
  const net = gross - overheadTotal;
  return {
    from, to,
    revenue: r2(revenue), sales_tax_collected: r2(salesTax), cash_collected: r2(collected),
    revenue_by_segment: Object.entries(revenueByType).map(([segment, amount]) => ({ segment, amount: r2(amount) })).sort((a, b) => b.amount - a.amount),
    cogs: {
      direct_labor: r2(directLabor), direct_hours: r2(directHours), materials: r2(materials), permit_fees: r2(permitFees),
      job_expenses: jobExpenses.map(e => ({ ...e, amount: r2(e.amount) })), total: r2(cogs),
    },
    gross_profit: r2(gross), gross_margin_pct: revenue > 0 ? r2(gross / revenue * 100) : 0,
    overhead: {
      indirect_labor: r2(indirectLabor), indirect_hours: r2(indirectHours),
      expenses: overhead.map(e => ({ ...e, amount: r2(e.amount) })), total: r2(overheadTotal),
    },
    net_profit: r2(net), net_margin_pct: revenue > 0 ? r2(net / revenue * 100) : 0,
    note: 'Accrual basis: revenue = non-draft, non-void invoices by issue date, excluding sales tax. Labor cost = hours x loaded rate (wage + burden).',
  };
}

function monthlyTrend(db, months = 12) {
  const out = [];
  const d = new Date(); d.setDate(1);
  for (let i = months - 1; i >= 0; i--) {
    const s = new Date(d.getFullYear(), d.getMonth() - i, 1);
    const e = new Date(d.getFullYear(), d.getMonth() - i + 1, 0);
    const f = x => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
    const p = profitAndLoss(db, f(s), f(e));
    out.push({ month: f(s).slice(0, 7), revenue: p.revenue, cogs: p.cogs.total, overhead: p.overhead.total, net: p.net_profit, gross_margin_pct: p.gross_margin_pct });
  }
  return out;
}

function hoursByJob(db, from, to, userId) {
  const time = timeInRange(db, startOfDay(from), endOfDay(to), userId ? 'AND t.user_id = ?' : '', ...(userId ? [userId] : []));
  const jobs = new Map();
  for (const t of time) {
    const key = t.job_id || 0;
    if (!jobs.has(key)) {
      const job = t.job_id ? get(db, 'SELECT budget_hours, status FROM jobs WHERE id = ?', t.job_id) : null;
      jobs.set(key, { job_id: t.job_id, job_number: t.job_number || '—', job_title: t.job_title || 'Non-job time (shop/training/PTO)',
        budget_hours: job ? job.budget_hours : null, status: job ? job.status : null, hours: 0, labor_cost: 0, techs: {} });
    }
    const j = jobs.get(key);
    j.hours += t.hours; j.labor_cost += t.hours * t.hourly_cost;
    j.techs[t.user_name] = (j.techs[t.user_name] || 0) + t.hours;
  }
  return [...jobs.values()].map(j => ({
    ...j, hours: r2(j.hours), labor_cost: r2(j.labor_cost),
    techs: Object.entries(j.techs).map(([name, h]) => ({ name, hours: r2(h) })),
  })).sort((a, b) => b.hours - a.hours);
}

// Weekly payroll with overtime over the configured threshold (per ISO week starting Monday).
function payroll(db, from, to) {
  const s = settings(db);
  const otAfter = Number(s.overtime_weekly_hours) || 40;
  const otMult = Number(s.overtime_multiplier) || 1.5;
  const time = timeInRange(db, startOfDay(from), endOfDay(to));
  const byUser = new Map();
  for (const t of time) {
    if (!byUser.has(t.user_id)) byUser.set(t.user_id, { user_id: t.user_id, name: t.user_name, weeks: {}, by_kind: {}, wage: t.hourly_wage });
    const u = byUser.get(t.user_id);
    const d = new Date(t.clock_in); const day = (d.getDay() + 6) % 7; d.setDate(d.getDate() - day);
    const wk = d.toISOString().slice(0, 10);
    u.weeks[wk] = u.weeks[wk] || { hours: 0, pay_base: 0, entries: [] };
    u.weeks[wk].hours += t.hours;
    u.weeks[wk].entries.push(t);
    u.by_kind[t.kind] = (u.by_kind[t.kind] || 0) + t.hours;
  }
  const rows = [];
  for (const u of byUser.values()) {
    let reg = 0, ot = 0, gross = 0;
    for (const w of Object.values(u.weeks)) {
      let acc = 0;
      for (const e of w.entries) {
        const regPart = Math.max(0, Math.min(e.hours, otAfter - acc));
        const otPart = e.hours - regPart;
        acc += e.hours;
        reg += regPart; ot += otPart;
        gross += regPart * e.hourly_wage + otPart * e.hourly_wage * otMult;
      }
    }
    rows.push({ user_id: u.user_id, name: u.name, regular_hours: r2(reg), overtime_hours: r2(ot), total_hours: r2(reg + ot),
      by_kind: Object.fromEntries(Object.entries(u.by_kind).map(([k, v]) => [k, r2(v)])), gross_pay: r2(gross) });
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

function arAging(db) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const invs = all(db, `SELECT i.*, c.name customer_name FROM invoices i JOIN customers c ON c.id = i.customer_id
    WHERE i.status IN ('sent','partial')`).map(i => invoiceWithTotals(db, i)).filter(i => i.balance > 0.004);
  const buckets = { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0 };
  const rows = invs.map(i => {
    const due = new Date((i.due_date || i.issue_date) + 'T00:00:00');
    const days = Math.floor((today - due) / 86400000);
    const b = days <= 0 ? 'current' : days <= 30 ? 'd1_30' : days <= 60 ? 'd31_60' : days <= 90 ? 'd61_90' : 'd90_plus';
    buckets[b] += i.balance;
    return { id: i.id, number: i.number, customer_name: i.customer_name, customer_id: i.customer_id, issue_date: i.issue_date, due_date: i.due_date, days_past_due: Math.max(0, days), bucket: b, total: i.total, balance: i.balance };
  }).sort((a, b) => b.days_past_due - a.days_past_due);
  for (const k in buckets) buckets[k] = r2(buckets[k]);
  return { buckets, total: r2(rows.reduce((s, r) => s + r.balance, 0)), invoices: rows };
}

function techPerformance(db, from, to) {
  const users = all(db, 'SELECT id, name, bill_rate FROM users WHERE active = 1 ORDER BY name');
  const time = timeInRange(db, startOfDay(from), endOfDay(to));
  return users.map(u => {
    const mine = time.filter(t => t.user_id === u.id);
    const total = mine.reduce((s, t) => s + t.hours, 0);
    const onJob = mine.filter(t => t.job_id && t.kind === 'job').reduce((s, t) => s + t.hours, 0);
    const jobIds = [...new Set(mine.filter(t => t.job_id).map(t => t.job_id))];
    // attribute invoiced revenue on each job proportionally to this tech's share of hours on that job
    let revenue = 0;
    for (const jid of jobIds) {
      const c = jobCosting(db, jid);
      if (!c || !c.revenue || !c.hours) continue;
      const myHours = mine.filter(t => t.job_id === jid).reduce((s, t) => s + t.hours, 0);
      revenue += c.revenue * Math.min(1, myHours / c.hours);
    }
    const completed = get(db, `SELECT COUNT(*) n FROM jobs j JOIN job_techs jt ON jt.job_id = j.id WHERE jt.user_id = ? AND j.completed_at >= ? AND j.completed_at < ?`, u.id, startOfDay(from), endOfDay(to)).n;
    return { user_id: u.id, name: u.name, total_hours: r2(total), job_hours: r2(onJob), utilization_pct: total ? r2(onJob / total * 100) : 0,
      jobs_worked: jobIds.length, jobs_completed: completed, revenue_attributed: r2(revenue), revenue_per_hour: total ? r2(revenue / total) : 0 };
  });
}

function estimateConversion(db, from, to) {
  const rows = all(db, "SELECT e.*, u.name created_by_name FROM estimates e LEFT JOIN users u ON u.id = e.created_by WHERE date(e.created_at) >= ? AND date(e.created_at) <= ?", from, to)
    .map(e => estimateWithTotals(db, e));
  const sent = rows.filter(e => e.status !== 'draft');
  const won = rows.filter(e => e.status === 'approved');
  const lost = rows.filter(e => e.status === 'declined' || e.status === 'expired');
  const sum = a => r2(a.reduce((s, e) => s + e.total, 0));
  return {
    count: rows.length, sent: sent.length, approved: won.length, declined: lost.length,
    open: sent.filter(e => ['sent', 'viewed'].includes(e.status)).length,
    close_rate_pct: sent.length ? r2(won.length / sent.length * 100) : 0,
    sent_value: sum(sent), approved_value: sum(won), open_value: sum(sent.filter(e => ['sent', 'viewed'].includes(e.status))),
    avg_ticket: won.length ? r2(sum(won) / won.length) : 0,
  };
}

function jobCostingReport(db, from, to) {
  const jobs = all(db, `SELECT j.id, j.number, j.title, j.status, j.job_type, c.name customer_name, c.type customer_type
    FROM jobs j JOIN customers c ON c.id = j.customer_id
    WHERE j.status != 'cancelled' AND date(COALESCE(j.completed_at, j.scheduled_start, j.created_at)) BETWEEN ? AND ?
    ORDER BY j.id DESC`, from, to);
  return jobs.map(j => ({ ...j, ...jobCosting(db, j.id) }));
}

function revenueBySource(db, from, to) {
  return all(db, `SELECT COALESCE(j.lead_source, c.lead_source, 'Unknown') source, COUNT(DISTINCT j.id) jobs
    FROM jobs j JOIN customers c ON c.id = j.customer_id
    WHERE date(j.created_at) BETWEEN ? AND ? GROUP BY source ORDER BY jobs DESC`, from, to)
    .map(r => {
      const ids = all(db, `SELECT j.id FROM jobs j JOIN customers c ON c.id = j.customer_id
        WHERE date(j.created_at) BETWEEN ? AND ? AND COALESCE(j.lead_source, c.lead_source, 'Unknown') = ?`, from, to, r.source).map(x => x.id);
      const revenue = ids.reduce((s, id) => s + (jobCosting(db, id).revenue || 0), 0);
      return { ...r, revenue: r2(revenue) };
    });
}

module.exports = {
  r2, docTotals, invoiceWithTotals, estimateWithTotals, refreshInvoiceStatus, jobCosting,
  profitAndLoss, monthlyTrend, hoursByJob, payroll, arAging, techPerformance, estimateConversion,
  jobCostingReport, revenueBySource, timeInRange, startOfDay, endOfDay,
};
