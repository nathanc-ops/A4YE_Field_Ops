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

// Estimates may offer options (good / better / best). Lines with no option are included in every option.
// Top-level totals are for the chosen option: the one the customer approved, else the recommended one.
function estimateWithTotals(db, est) {
  const items = all(db, 'SELECT * FROM estimate_items WHERE estimate_id = ? ORDER BY sort, id', est.id);
  const options = all(db, 'SELECT * FROM estimate_options WHERE estimate_id = ? ORDER BY sort, id', est.id);
  if (!options.length) return { ...est, items, options: [], chosen_option_id: null, chosen_items: items, ...docTotals(est, items) };
  const common = items.filter(i => !i.option_id);
  const opts = options.map(o => {
    const its = common.concat(items.filter(i => i.option_id === o.id));
    return { ...o, ...docTotals(est, its), line_count: its.length };
  });
  const chosen = options.find(o => o.id === est.approved_option_id) || options.find(o => o.recommended) || options[0];
  const chosenItems = items.filter(i => !i.option_id || i.option_id === chosen.id);
  const totals = opts.map(o => o.total);
  return { ...est, items, options: opts, chosen_option_id: chosen.id, chosen_items: chosenItems, ...docTotals(est, chosenItems),
    price_min: Math.min(...totals), price_max: Math.max(...totals) };
}
// Lines that belong to the option the customer picked (all lines when there are no options).
function estimateChosenItems(db, estimateId) {
  const est = get(db, 'SELECT * FROM estimates WHERE id = ?', estimateId);
  return est ? estimateWithTotals(db, est).chosen_items : [];
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
  // other job costs: quick expenses + vendor bill lines (bill lines that created material rows are counted as materials)
  const other = get(db, 'SELECT COALESCE(SUM(amount),0) v FROM expenses WHERE job_id = ?', jobId).v
    + get(db, `SELECT COALESCE(SUM(bl.amount),0) v FROM bill_lines bl JOIN bills b ON b.id = bl.bill_id
               WHERE bl.job_id = ? AND b.status != 'void' AND bl.job_material_id IS NULL AND b.po_id IS NULL`, jobId).v;
  const permitFees = get(db, 'SELECT COALESCE(SUM(fee),0) v FROM permits WHERE job_id = ?', jobId).v;
  const invoices = all(db, "SELECT * FROM invoices WHERE job_id = ? AND status != 'void'", jobId).map(i => invoiceWithTotals(db, i));
  // revenue excludes sales tax (tax is a pass-through liability, not income)
  const revenue = invoices.reduce((s, i) => s + i.subtotal - i.discount, 0);
  const collected = invoices.reduce((s, i) => s + i.paid, 0);
  const totalCost = laborCost + mat.cost + other + permitFees;
  const contract = job.billing_type === 'fixed' ? require('./billing').contractValue(db, job).total : (job.contract_amount || 0);
  const basis = job.billing_type === 'fixed' ? (contract || revenue) : (revenue || contract);
  return {
    hours: r2(hours), labor_cost: r2(laborCost), materials_cost: r2(mat.cost), materials_billable: r2(mat.price),
    other_cost: r2(other), permit_fees: r2(permitFees), total_cost: r2(totalCost),
    revenue: r2(revenue), collected: r2(collected), contract_amount: contract || null, billing_type: job.billing_type,
    profit: r2(basis - totalCost), margin_pct: basis > 0 ? r2((basis - totalCost) / basis * 100) : null,
    budget_hours: job.budget_hours, hours_variance: job.budget_hours != null ? r2(job.budget_hours - hours) : null,
    budget_materials: job.budget_materials,
  };
}

// ---------------------------------------------------------------- reports
// Time entries overlapping [from, to) — hours are clipped to the range.
function timeInRange(db, from, to, extraWhere = '', ...params) {
  const now = new Date().toISOString();
  const rows = all(db, `SELECT t.*, u.name user_name, j.number job_number, j.title job_title, cc.code cost_code, cc.name cost_code_name
    FROM time_entries t JOIN users u ON u.id = t.user_id LEFT JOIN jobs j ON j.id = t.job_id LEFT JOIN cost_codes cc ON cc.id = t.cost_code_id
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
// Hours a visit takes up on one day. A visit spanning several days (e.g. 7 AM Mon to 3 PM Fri) is a daily
// 7–3 crew window, not 100 straight hours, so each day counts its start-to-end time of day.
// `after` (ms) counts only the part of the visit after that moment (what's still ahead today).
function visitHoursOnDay(a, day, after = -Infinity) {
  const d0 = new Date(day + 'T00:00:00').getTime(), d1 = d0 + 864e5, s = Date.parse(a.start), e = Date.parse(a.end);
  const overlap = (x, y) => Math.max(0, Math.min(y, d1, e) - Math.max(x, d0, s, after)) / 36e5;
  const st = new Date(s), en = new Date(e);
  const multiDay = st.toDateString() !== en.toDateString();
  if (!multiDay) return overlap(s, e);
  const ws = d0 + (st.getHours() * 60 + st.getMinutes()) * 6e4, we = d0 + (en.getHours() * 60 + en.getMinutes()) * 6e4;
  return we > ws ? overlap(ws, we) : overlap(d0, d1);
}
const startOfDay = d => new Date(d + 'T00:00:00').toISOString();
// The workweek: payroll, overtime and the time clock's week all start on this day (Settings → Company → Workweek starts).
const weekStartDow = s => (s && s.workweek_start === 'mon' ? 1 : 0);              // 0 = Sunday (default), 1 = Monday
const daysIntoWeek = (jsDay, s) => (jsDay - weekStartDow(s) + 7) % 7;

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

// One workweek (same weeks as payroll) for everyone: hours worked so far, hours scheduled, and what the week is headed for.
// projected = worked so far + the scheduled visit time still ahead. Flags against the overtime threshold.
function weekHours(db, anyDay, nowIso = new Date().toISOString()) {
  const s = settings(db), otAfter = Number(s.overtime_weekly_hours) || 40;
  const d = new Date(anyDay + 'T00:00:00'); d.setDate(d.getDate() - daysIntoWeek(d.getDay(), s));
  const days = [...Array(7)].map((_, i) => { const x = new Date(d); x.setDate(d.getDate() + i); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; });
  const from = startOfDay(days[0]), to = endOfDay(days[6]), now = Date.parse(nowIso);
  const users = all(db, "SELECT id, name, role, color, pay_type FROM users WHERE active = 1 ORDER BY CASE role WHEN 'tech' THEN 0 ELSE 1 END, name");
  const by = new Map(users.map(u => [u.id, { user_id: u.id, name: u.name, role: u.role, color: u.color, salaried: u.pay_type === 'salary', worked: Array(7).fill(0), scheduled: Array(7).fill(0), ahead: 0, on_clock: false }]));
  // time entries, split across the days they touch (an entry past midnight counts on both)
  const entries = all(db, `SELECT user_id, clock_in, clock_out FROM time_entries WHERE clock_in < ? AND COALESCE(clock_out, ?) > ?`, to, nowIso, from);
  for (const t of entries) {
    const u = by.get(t.user_id); if (!u) continue;
    if (!t.clock_out) u.on_clock = true;
    const a = Date.parse(t.clock_in), b = Math.min(Date.parse(t.clock_out || nowIso), now);
    days.forEach((day, i) => { const d0 = new Date(day + 'T00:00:00').getTime(); u.worked[i] += Math.max(0, Math.min(b, d0 + 864e5) - Math.max(a, d0)) / 36e5; });
  }
  const visits = all(db, `SELECT a.id, a.start, a.end, at.user_id FROM appointments a JOIN appointment_techs at ON at.appointment_id = a.id
    WHERE a.status != 'cancelled' AND a.start < ? AND a.end > ?`, to, from);
  for (const v of visits) {
    const u = by.get(v.user_id); if (!u) continue;
    days.forEach((day, i) => { u.scheduled[i] += visitHoursOnDay(v, day); u.ahead += visitHoursOnDay(v, day, now); });
  }
  const rows = [...by.values()].map(u => {
    const worked = r2(u.worked.reduce((x, y) => x + y, 0)), scheduled = r2(u.scheduled.reduce((x, y) => x + y, 0)), ahead = r2(u.ahead);
    const projected = r2(worked + ahead);
    const flags = [];
    if (u.salaried) return { ...u, worked_by_day: u.worked.map(r2), scheduled_by_day: u.scheduled.map(r2), worked, scheduled, ahead, projected, overtime: 0, projected_overtime: 0, flags };   // exempt: no overtime
    if (worked > otAfter) flags.push('over');
    else if (projected > otAfter) flags.push('projected');
    if (scheduled > otAfter) flags.push('scheduled');
    return { ...u, worked_by_day: u.worked.map(r2), scheduled_by_day: u.scheduled.map(r2), worked, scheduled, ahead, projected,
      overtime: r2(Math.max(0, worked - otAfter)), projected_overtime: r2(Math.max(0, projected - otAfter)), flags };
  }).filter(u => u.role === 'tech' || u.worked || u.scheduled);
  return { week: days[0], days, ot_after: otAfter, now: nowIso, rows };
}

// Weekly payroll with overtime over the configured threshold, per workweek (Sunday or Monday start, from Settings).
function payroll(db, from, to) {
  const s = settings(db);
  const otAfter = Number(s.overtime_weekly_hours) || 40;
  const otMult = Number(s.overtime_multiplier) || 1.5;
  const time = timeInRange(db, startOfDay(from), endOfDay(to));
  const pay = new Map(all(db, "SELECT id, pay_type, salary_annual FROM users").map(u => [u.id, u]));
  const byUser = new Map();
  for (const t of time) {
    if (!byUser.has(t.user_id)) byUser.set(t.user_id, { user_id: t.user_id, name: t.user_name, weeks: {}, by_kind: {}, wage: t.hourly_wage });
    const u = byUser.get(t.user_id);
    const d = new Date(t.clock_in); d.setDate(d.getDate() - daysIntoWeek(d.getDay(), s));
    const wk = d.toISOString().slice(0, 10);
    u.weeks[wk] = u.weeks[wk] || { hours: 0, pay_base: 0, entries: [] };
    u.weeks[wk].hours += t.hours;
    u.weeks[wk].entries.push(t);
    u.by_kind[t.kind] = (u.by_kind[t.kind] || 0) + t.hours;
  }
  const rows = [];
  const days = Math.round((new Date(to + 'T12:00:00') - new Date(from + 'T12:00:00')) / 864e5) + 1;
  for (const u of byUser.values()) {
    const p = pay.get(u.user_id) || {};
    if (p.pay_type === 'salary') {   // exempt: no overtime; salary for the days in the range (yearly ÷ 52 per week)
      const hrs = Object.values(u.weeks).reduce((a, w) => a + w.hours, 0);
      rows.push({ user_id: u.user_id, name: u.name, pay_type: 'salary', regular_hours: r2(hrs), overtime_hours: 0, total_hours: r2(hrs),
        by_kind: Object.fromEntries(Object.entries(u.by_kind).map(([k, v]) => [k, r2(v)])), gross_pay: r2((Number(p.salary_annual) || 0) / 52 * days / 7) });
      continue;
    }
    let reg = 0, ot = 0, gross = 0;
    for (const w of Object.values(u.weeks)) {
      let acc = 0;
      for (const e of w.entries) {
        // PTO is paid at the regular rate and isn't time worked, so it never pushes anyone into overtime
        const regPart = e.kind === 'pto' ? e.hours : Math.max(0, Math.min(e.hours, otAfter - acc));
        const otPart = e.hours - regPart;
        if (e.kind !== 'pto') acc += e.hours;
        reg += regPart; ot += otPart;
        gross += regPart * e.hourly_wage + otPart * e.hourly_wage * otMult;
      }
    }
    rows.push({ user_id: u.user_id, name: u.name, pay_type: 'hourly', regular_hours: r2(reg), overtime_hours: r2(ot), total_hours: r2(reg + ot),
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
  const rows = all(db, "SELECT e.*, u.name created_by_name FROM estimates e LEFT JOIN users u ON u.id = e.created_by WHERE e.status != 'cancelled' AND date(e.created_at) >= ? AND date(e.created_at) <= ?", from, to)
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

// Budget vs actual for each cost code on a job.
function jobCostCodes(db, jobId) {
  const now = new Date().toISOString();
  const map = new Map();
  const row = (id, code, name) => {
    const k = id || 0;
    if (!map.has(k)) map.set(k, { cost_code_id: id || null, code: code || '—', name: name || 'Uncoded', budget_hours: 0, budget_material: 0, budget_other: 0, hours: 0, labor_cost: 0, material_cost: 0, other_cost: 0 });
    return map.get(k);
  };
  for (const b of all(db, 'SELECT jb.*, cc.code, cc.name FROM job_budgets jb JOIN cost_codes cc ON cc.id = jb.cost_code_id WHERE jb.job_id = ?', jobId))
    Object.assign(row(b.cost_code_id, b.code, b.name), { budget_hours: b.budget_hours, budget_material: b.budget_material, budget_other: b.budget_other });
  for (const t of all(db, 'SELECT t.*, cc.code, cc.name FROM time_entries t LEFT JOIN cost_codes cc ON cc.id = t.cost_code_id WHERE t.job_id = ?', jobId)) {
    const h = Math.max(0, hoursBetween(t.clock_in, t.clock_out || now)); const r = row(t.cost_code_id, t.code, t.name);
    r.hours += h; r.labor_cost += h * t.hourly_cost;
  }
  for (const m of all(db, 'SELECT m.*, cc.code, cc.name FROM job_materials m LEFT JOIN cost_codes cc ON cc.id = m.cost_code_id WHERE m.job_id = ?', jobId))
    row(m.cost_code_id, m.code, m.name).material_cost += m.qty * m.unit_cost;
  for (const e of all(db, 'SELECT e.amount, e.cost_code_id, cc.code, cc.name FROM expenses e LEFT JOIN cost_codes cc ON cc.id = e.cost_code_id WHERE e.job_id = ?', jobId))
    row(e.cost_code_id, e.code, e.name).other_cost += e.amount;
  for (const l of all(db, `SELECT bl.amount, bl.cost_code_id, cc.code, cc.name FROM bill_lines bl JOIN bills b ON b.id = bl.bill_id LEFT JOIN cost_codes cc ON cc.id = bl.cost_code_id
      WHERE bl.job_id = ? AND b.status != 'void' AND bl.job_material_id IS NULL AND b.po_id IS NULL`, jobId))
    row(l.cost_code_id, l.code, l.name).other_cost += l.amount;
  const permitCode = get(db, "SELECT id, code, name FROM cost_codes WHERE code IN ('5050', '980') ORDER BY active DESC, code = '5050' DESC LIMIT 1");
  for (const p of all(db, 'SELECT fee FROM permits WHERE job_id = ? AND fee > 0', jobId))
    row(permitCode && permitCode.id, permitCode && permitCode.code, permitCode && permitCode.name).other_cost += p.fee;
  return [...map.values()].map(r => {
    const budget = r.budget_material + r.budget_other;
    const cost = r.labor_cost + r.material_cost + r.other_cost;
    return { ...r, hours: r2(r.hours), labor_cost: r2(r.labor_cost), material_cost: r2(r.material_cost), other_cost: r2(r.other_cost), total_cost: r2(cost),
      hours_variance: r2(r.budget_hours - r.hours), material_variance: r2(r.budget_material - r.material_cost), pct_hours_used: r.budget_hours ? r2(r.hours / r.budget_hours * 100) : null, budget_cost: r2(budget) };
  }).sort((a, b) => String(a.code).localeCompare(String(b.code)));
}

// Cost-code totals across all jobs for a date range (labor by clock-in date, materials by use date).
function costCodeReport(db, from, to) {
  const map = new Map();
  const row = (id, code, name) => { const k = id || 0; if (!map.has(k)) map.set(k, { cost_code_id: id || null, code: code || '—', name: name || 'Uncoded', hours: 0, labor_cost: 0, material_cost: 0, other_cost: 0, jobs: new Set() }); return map.get(k); };
  for (const t of timeInRange(db, startOfDay(from), endOfDay(to))) {
    if (!t.job_id) continue;
    const r = row(t.cost_code_id, t.cost_code, t.cost_code_name); r.hours += t.hours; r.labor_cost += t.hours * t.hourly_cost; r.jobs.add(t.job_id);
  }
  for (const m of all(db, 'SELECT m.*, cc.code, cc.name FROM job_materials m LEFT JOIN cost_codes cc ON cc.id = m.cost_code_id WHERE m.used_on BETWEEN ? AND ?', from, to)) {
    const r = row(m.cost_code_id, m.code, m.name); r.material_cost += m.qty * m.unit_cost; r.jobs.add(m.job_id);
  }
  for (const e of all(db, 'SELECT e.*, cc.code, cc.name FROM expenses e LEFT JOIN cost_codes cc ON cc.id = e.cost_code_id WHERE e.job_id IS NOT NULL AND e.date BETWEEN ? AND ?', from, to)) {
    const r = row(e.cost_code_id, e.code, e.name); r.other_cost += e.amount; r.jobs.add(e.job_id);
  }
  return [...map.values()].map(r => ({ ...r, jobs: r.jobs.size, hours: r2(r.hours), labor_cost: r2(r.labor_cost), material_cost: r2(r.material_cost), other_cost: r2(r.other_cost),
    total_cost: r2(r.labor_cost + r.material_cost + r.other_cost) })).sort((a, b) => String(a.code).localeCompare(String(b.code)));
}

module.exports = {
  weekStartDow, daysIntoWeek,
  visitHoursOnDay, weekHours,
  estimateChosenItems, jobCostCodes, costCodeReport,
  r2, docTotals, invoiceWithTotals, estimateWithTotals, refreshInvoiceStatus, jobCosting,
  profitAndLoss, monthlyTrend, hoursByJob, payroll, arAging, techPerformance, estimateConversion,
  jobCostingReport, revenueBySource, timeInRange, startOfDay, endOfDay,
};
