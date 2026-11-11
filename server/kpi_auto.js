'use strict';
// KPI auto numbers, worked out from Field Ops' own records — the same rules the KPI Command Center script ran against
// Housecall Pro, Ply and the A4Y Time Clock, keyed by the same rule names, so metrics imported from the sheet fill in.
//
//  - A week is Sunday–Saturday in the company time zone. Dates stored as plain days (issue date, paid date) are already
//    local; stored instants (created, completed, clock-in) are turned into the local day before they're compared.
//  - "As of Saturday night" numbers (A/R aging, open estimates) are rebuilt from dates, so any week can be worked out.
//    Headcount and inventory only exist as "now", so they're taken once a week ends and then never rewritten.
//  - Weeks before Settings › "Field Ops numbers start" aren't touched: those keep what came from the sheet or was typed.
//
// Each rule returns { value, detail: [{label, amount, ref}], note, unit } or null (nothing to say for that week).
const D = require('./db');
const C = require('./calc');
const { all, get } = D;
const r2 = n => Math.round(n * 100) / 100;

const RULES = {
  hcp_jobs_scheduled: 'Jobs booked Sun–Sat that have a scheduled time (cancelled left out; commercial projects included)',
  hcp_jobs_completed: 'Jobs marked completed Sun–Sat (cancelled left out; commercial projects included)',
  hcp_revenue_completed: 'Jobs completed Sun–Sat: invoiced total for the job, or its contract amount when not invoiced yet (commercial projects included)',
  hcp_estimates_created: 'Estimates created Sun–Sat (change orders left out)',
  hcp_bids_count: 'Estimates created Sun–Sat, won + open + lost (change orders left out)',
  hcp_bids_value: 'Largest option of each estimate created Sun–Sat',
  hcp_bids_won_count: 'Estimates created Sun–Sat that have since been approved',
  hcp_bids_won_value: 'Approved totals of estimates created Sun–Sat that have since been approved',
  hcp_est_sent: 'Estimates sent to the customer Sun–Sat',
  hcp_est_won: 'Estimates approved Sun–Sat',
  hcp_est_won_value: 'Approved option totals of estimates approved Sun–Sat',
  hcp_est_won_new: 'Estimates approved Sun–Sat from customers with no earlier job or estimate',
  hcp_est_won_repeat: 'Estimates approved Sun–Sat from customers seen before',
  hcp_cancels: 'Jobs cancelled Sun–Sat, plus scheduled visits moved to a different time',
  hcp_inv_sent: 'Invoices sent Sun–Sat (invoice date when there is no sent date), voided left out',
  hcp_inv_sent_value: 'Total of invoices sent Sun–Sat',
  hcp_days_to_invoice: 'Average days from job completed to invoice sent, for invoices sent Sun–Sat',
  hcp_inv_paid: 'Invoices with a payment recorded Sun–Sat',
  hcp_inv_paid_value: 'Payments recorded Sun–Sat',
  hcp_days_scheduled: 'One per tech per day with a scheduled job visit Sun–Sat (multi-day visits count each day)',
  snap_open_estimates: 'Estimates not yet approved, declined, cancelled or expired, as of Saturday night (largest option each)',
  snap_ar_0_30: 'Unpaid invoice balances 0–30 days old, as of Saturday night',
  snap_ar_31_60: 'Unpaid invoice balances 31–60 days old, as of Saturday night',
  snap_ar_61_90: 'Unpaid invoice balances 61–90 days old, as of Saturday night',
  snap_ar_90_plus: 'Unpaid invoice balances over 90 days old, as of Saturday night',
  snap_headcount_field: 'Active technicians, taken when the week ends',
  snap_headcount_office: 'Active office staff, managers and admins, taken when the week ends',
  clock_paid_hours: 'Time clock: technicians\' hours Sun–Sat (PTO not counted)',
  clock_onsite_hours: 'Time clock: technicians\' hours on a real job (not shop, travel, training or the non-job numbers in Settings)',
  clock_overtime: 'Time clock: hours over the weekly overtime limit, per technician',
  clock_days_worked: 'Scheduled tech-days that have a time clock punch the same day',
  clock_tardies: 'Days a tech\'s first punch was later than their first scheduled visit (plus the grace minutes)',
  ply_materials: 'Purchase orders placed Sun–Sat, drafts and cancelled left out',
  ply_unassigned: 'Purchase orders placed Sun–Sat with no job',
  ply_inventory: 'Price-book stock on hand × cost, taken when the week ends',
};
// numbers that only exist "now" are frozen once the week is over; the rest can be rebuilt for any week
const NOW_ONLY = new Set(['snap_headcount_field', 'snap_headcount_office', 'ply_inventory']);

module.exports = function kpiAuto(db, h) {
  const { localNow, localToUtc, addDays } = h;

  function context(c) {
    const s = D.settings(db), tz = c.tz;
    const day = v => {
      if (v == null || v === '') return null;
      const t = String(v);
      if (/^\d{4}-\d\d-\d\d$/.test(t)) return t;
      const ms = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(t) ? t : t.replace(' ', 'T') + 'Z');
      return Number.isNaN(ms) ? null : localNow(tz, new Date(ms)).slice(0, 10);
    };
    const ms = v => { if (!v) return null; const t = String(v); const x = Date.parse(/^\d{4}-\d\d-\d\d$/.test(t) ? `${t}T12:00:00Z` : /[zZ]|[+-]\d\d:?\d\d$/.test(t) ? t : t.replace(' ', 'T') + 'Z'); return Number.isNaN(x) ? null : x; };
    const memo = new Map(), once = (k, f) => { if (!memo.has(k)) memo.set(k, f()); return memo.get(k); };
    const estimates = () => once('est', () => all(db, 'SELECT * FROM estimates').map(e => {
      const t = C.estimateWithTotals(db, e);
      const chosen = t.options.length ? (t.options.find(o => o.id === e.approved_option_id) || null) : null;
      return { ...e, big: t.options.length ? t.price_max : t.total, approvedTotal: e.approved_at ? (chosen ? chosen.total : t.total) : null };
    }));
    const customerName = id => once(`c${id}`, () => (get(db, 'SELECT COALESCE(NULLIF(company, \'\'), name) n FROM customers WHERE id = ?', id) || {}).n || 'Customer');
    return {
      tz, s, day, ms, once, estimates, customerName,
      jobs: () => once('jobs', () => all(db, 'SELECT * FROM jobs')),
      invoices: () => once('inv', () => all(db, "SELECT * FROM invoices WHERE status != 'void'").map(i => C.invoiceWithTotals(db, i))),
      payments: () => once('pay', () => all(db, 'SELECT p.*, i.number inv_number, i.customer_id FROM payments p JOIN invoices i ON i.id = p.invoice_id')),
      visits: () => once('vis', () => all(db, `SELECT a.id, a.start, a.end, a.job_id, j.number job_number, t.user_id, u.name FROM appointments a JOIN appointment_techs t ON t.appointment_id = a.id
        JOIN users u ON u.id = t.user_id LEFT JOIN jobs j ON j.id = a.job_id WHERE a.status != 'cancelled' AND u.role = 'tech'`)),
      punches: () => once('tp', () => all(db, `SELECT t.*, u.name, u.role, j.number job_number FROM time_entries t JOIN users u ON u.id = t.user_id LEFT JOIN jobs j ON j.id = t.job_id WHERE u.role = 'tech'`)),
      pos: () => once('po', () => all(db, "SELECT p.*, v.name vendor, j.number job_number FROM purchase_orders p LEFT JOIN vendors v ON v.id = p.vendor_id LEFT JOIN jobs j ON j.id = p.job_id WHERE p.status NOT IN ('draft','cancelled')")
        .map(p => { const sub = (get(db, 'SELECT SUM(qty * unit_cost) t FROM po_lines WHERE po_id = ?', p.id) || {}).t || 0; return { ...p, total: r2(sub + (p.tax || 0) + (p.shipping || 0)) }; })),
      list: v => String(v || '').toLowerCase().split(/[\s,]+/).filter(Boolean),
    };
  }

  // Saturday 11:59:59 PM local, as a UTC instant
  const satNight = (week, tz) => Date.parse(localToUtc(`${addDays(week, 6)} 23:59`, tz)) + 59e3;

  function compute(rule, week, c, X) {
    const inWeek = d => d && d >= week && d <= addDays(week, 6);
    const sat = satNight(week, c.tz), detail = [];
    const out = (value, unit = '#', note = RULES[rule]) => ({ value: value == null ? null : r2(value), detail, note, unit });
    switch (rule) {
      case 'hcp_jobs_scheduled': case 'hcp_jobs_completed': case 'hcp_revenue_completed': {
        const done = rule !== 'hcp_jobs_scheduled'; let total = 0;
        for (const j of X.jobs()) {
          if (j.status === 'cancelled') continue;
          if (done ? !inWeek(X.day(j.completed_at)) : !(inWeek(X.day(j.created_at)) && (j.scheduled_start || j.start_date))) continue;
          const inv = X.invoices().filter(i => i.job_id === j.id), invoiced = r2(inv.reduce((s, i) => s + i.total, 0));
          const amt = invoiced || Number(j.contract_amount) || 0;
          total += rule === 'hcp_revenue_completed' ? amt : 1;
          detail.push({ label: `${j.number} · ${X.customerName(j.customer_id)} · ${j.title || ''}`, amount: amt || null,
            ref: done ? `completed ${X.day(j.completed_at)}${invoiced ? '' : amt ? ' · contract amount (not invoiced yet)' : ''}` : `booked ${X.day(j.created_at)}, for ${X.day(j.scheduled_start || j.start_date)}` });
        }
        return out(total, rule === 'hcp_revenue_completed' ? '$' : '#');
      }
      case 'hcp_estimates_created': case 'hcp_bids_count': case 'hcp_bids_value': case 'hcp_bids_won_count': case 'hcp_bids_won_value':
      case 'hcp_est_sent': case 'hcp_est_won': case 'hcp_est_won_value': case 'hcp_est_won_new': case 'hcp_est_won_repeat': {
        const field = /^hcp_est_(won|sent)/.test(rule) ? (rule === 'hcp_est_sent' ? 'sent_at' : 'approved_at') : 'created_at';
        const wonOnly = rule === 'hcp_bids_won_count' || rule === 'hcp_bids_won_value';
        const money = /value$/.test(rule), sumWon = rule === 'hcp_est_won_value' || rule === 'hcp_bids_won_value';
        let first = null;
        if (rule === 'hcp_est_won_new' || rule === 'hcp_est_won_repeat') first = X.once('first', () => {
          const f = new Map(), see = (cid, t) => { if (cid && t != null && (!f.has(cid) || t < f.get(cid))) f.set(cid, t); };
          X.jobs().forEach(j => see(j.customer_id, X.ms(j.created_at))); X.estimates().forEach(e => see(e.customer_id, X.ms(e.created_at)));
          return f;
        });
        let total = 0;
        for (const e of X.estimates()) {
          if (e.change_order || !inWeek(X.day(e[field]))) continue;
          if (wonOnly && !e.approved_at) continue;
          let tag = '';
          if (first) {
            const isNew = (first.get(e.customer_id) ?? Infinity) >= X.ms(e.created_at);
            if ((rule === 'hcp_est_won_new') !== isNew) continue;
            tag = isNew ? ' · first job or estimate for this customer' : ' · customer seen before';
          }
          const amt = sumWon ? e.approvedTotal : e.big;
          total += money ? (amt || 0) : 1;
          detail.push({ label: `${e.number} · ${X.customerName(e.customer_id)}${e.title ? ` · ${e.title}` : ''}`, amount: amt,
            ref: `created ${X.day(e.created_at)}${e.sent_at ? ` · sent ${X.day(e.sent_at)}` : ''}${e.approved_at ? ` · approved ${X.day(e.approved_at)}` : ''}${tag}` });
        }
        return out(total, money ? '$' : '#');
      }
      case 'hcp_cancels': {
        for (const j of X.jobs()) if (j.status === 'cancelled' && inWeek(X.day(j.cancelled_at))) detail.push({ label: `${j.number} · ${X.customerName(j.customer_id)} · cancelled`, amount: null, ref: `${X.day(j.cancelled_at)}${j.cancel_reason ? ` · ${j.cancel_reason}` : ''}` });
        for (const r of X.once('moves', () => all(db, 'SELECT m.*, j.number, j.customer_id FROM appointment_moves m LEFT JOIN jobs j ON j.id = m.job_id')))
          if (inWeek(X.day(r.at))) detail.push({ label: `${r.number || 'Visit'} · ${X.customerName(r.customer_id)} · rescheduled`, amount: null, ref: `${X.day(r.at)} · was ${X.day(r.from_start)}, now ${X.day(r.to_start)}` });
        return out(detail.length);
      }
      case 'hcp_inv_sent': case 'hcp_inv_sent_value': case 'hcp_days_to_invoice': {
        let total = 0, n = 0;
        for (const i of X.invoices()) {
          const sent = i.sent_at || (i.status !== 'draft' ? i.issue_date : null);
          if (!inWeek(X.day(sent))) continue;
          if (rule === 'hcp_days_to_invoice') {
            const j = i.job_id && X.jobs().find(x => x.id === i.job_id), done = j && X.ms(j.completed_at), at = X.ms(sent);
            if (!done || !at) continue;
            const days = Math.max(0, (at - done) / 864e5); total += days; n++;
            detail.push({ label: `${i.number} · ${X.customerName(i.customer_id)}`, amount: r2(days), ref: `job ${j.number} completed ${X.day(j.completed_at)} · invoice sent ${X.day(sent)}` });
            continue;
          }
          total += rule === 'hcp_inv_sent_value' ? i.total : 1;
          detail.push({ label: `${i.number} · ${X.customerName(i.customer_id)}`, amount: i.total, ref: `${i.sent_at ? 'sent' : 'dated'} ${X.day(sent)} · ${i.status}` });
        }
        if (rule === 'hcp_days_to_invoice') return n ? out(total / n, 'days') : null;
        return out(total, rule === 'hcp_inv_sent_value' ? '$' : '#');
      }
      case 'hcp_inv_paid': case 'hcp_inv_paid_value': {
        const seen = new Set(); let total = 0;
        for (const p of X.payments()) {
          if (!inWeek(X.day(p.paid_at))) continue;
          total += p.amount; seen.add(p.invoice_id);
          detail.push({ label: `${p.inv_number} · ${X.customerName(p.customer_id)}`, amount: p.amount, ref: `paid ${X.day(p.paid_at)} · ${p.method || ''}` });
        }
        return rule === 'hcp_inv_paid' ? out(seen.size) : out(total, '$');
      }
      case 'snap_open_estimates': {
        let total = 0; const satDay = addDays(week, 6);
        for (const e of X.estimates()) {
          const t = X.ms(e.created_at);
          if (e.change_order || t == null || t > sat) continue;
          const closedBy = [e.approved_at, e.declined_at, e.cancelled_at].some(x => x && X.ms(x) <= sat) || (e.valid_until && e.valid_until < satDay && !e.approved_at);
          if (closedBy) continue;
          total += e.big || 0;
          detail.push({ label: `${e.number} · ${X.customerName(e.customer_id)}`, amount: e.big, ref: `created ${X.day(e.created_at)}${e.sent_at ? ` · sent ${X.day(e.sent_at)}` : ''}` });
        }
        return out(total, '$');
      }
      case 'snap_ar_0_30': case 'snap_ar_31_60': case 'snap_ar_61_90': case 'snap_ar_90_plus': {
        const [lo, hi] = { snap_ar_0_30: [0, 30], snap_ar_31_60: [31, 60], snap_ar_61_90: [61, 90], snap_ar_90_plus: [91, 1e9] }[rule];
        let total = 0;
        for (const i of X.invoices()) {
          if (i.status === 'draft') continue;
          const from = X.ms(i.sent_at || i.issue_date); if (from == null || from > sat) continue;
          const paid = i.payments.filter(p => (X.ms(p.paid_at) ?? Infinity) <= sat).reduce((s, p) => s + p.amount, 0);
          const due = r2(i.total - paid); if (due <= 0.004) continue;
          const age = Math.floor((sat - from) / 864e5); if (age < lo || age > hi) continue;
          total += due;
          detail.push({ label: `${i.number} · ${X.customerName(i.customer_id)}`, amount: due, ref: `${age} days old` });
        }
        return out(total, '$');
      }
      case 'snap_headcount_field': case 'snap_headcount_office': {
        const roles = rule === 'snap_headcount_field' ? ['tech'] : ['admin', 'manager', 'office'];
        const people = all(db, `SELECT name, role, title FROM users WHERE active = 1 AND role IN (${roles.map(() => '?').join(',')}) ORDER BY name`, ...roles);
        people.forEach(u => detail.push({ label: u.name, amount: 1, ref: u.title || u.role }));
        return out(people.length);
      }
      case 'hcp_days_scheduled': case 'clock_days_worked': case 'clock_tardies': {
        const sched = new Map();
        for (const v of X.visits()) {
          if (!v.job_id) continue;
          for (let d = X.day(v.start), end = X.day(v.end), g = 0; d && d <= end && g < 31; d = addDays(d, 1), g++) {
            if (!inWeek(d)) continue;
            const k = `${v.user_id}|${d}`, startMs = d === X.day(v.start) ? X.ms(v.start) : null;
            const cur = sched.get(k) || { name: v.name, day: d, start: null, job: v.job_number, user: v.user_id };
            if (startMs != null && (cur.start == null || startMs < cur.start)) { cur.start = startMs; cur.job = v.job_number; }
            sched.set(k, cur);
          }
        }
        if (rule === 'hcp_days_scheduled') {
          const by = new Map(); for (const x of sched.values()) { if (!by.has(x.name)) by.set(x.name, []); by.get(x.name).push(x.day.slice(5)); }
          for (const [n, ds] of by) detail.push({ label: n, amount: ds.length, ref: `scheduled ${ds.sort().join(', ')}` });
          return out(sched.size);
        }
        const first = new Map();
        for (const p of X.punches()) { const d = X.day(p.clock_in), k = `${p.user_id}|${d}`, t = X.ms(p.clock_in); if (!first.has(k) || t < first.get(k)) first.set(k, t); }
        const grace = (Number(X.s.kpi_tardy_grace_min) || 5) * 6e4, hm = t => new Date(t).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: c.tz });
        let n = 0;
        for (const [k, x] of [...sched.entries()].sort()) {
          const p = first.get(k);
          if (rule === 'clock_days_worked') { if (!p) continue; n++; detail.push({ label: `${x.name} · ${x.day}`, amount: 1, ref: `first punch ${hm(p)} · job ${x.job || ''}` }); continue; }
          if (!p || x.start == null || p <= x.start + grace) continue;
          n++; detail.push({ label: `${x.name} · ${x.day}`, amount: Math.round((p - x.start) / 6e4), ref: `first visit ${hm(x.start)} (${x.job || ''}), first punch ${hm(p)} · amount = minutes late` });
        }
        return out(n);
      }
      case 'clock_paid_hours': case 'clock_onsite_hours': case 'clock_overtime': {
        const nonJob = X.list(X.s.kpi_non_job_numbers || '0000, 0500, 1000'), otAfter = Number(X.s.overtime_weekly_hours) || 40;
        const per = new Map();
        for (const p of X.punches()) {
          if (!inWeek(X.day(p.clock_in)) || !p.clock_out || p.kind === 'pto') continue;
          const h_ = Math.max(0, (X.ms(p.clock_out) - X.ms(p.clock_in)) / 36e5);
          const onJob = p.kind === 'job' && p.job_id && !nonJob.includes(String(p.job_number || '').toLowerCase());
          const x = per.get(p.user_id) || { name: p.name, paid: 0, on: 0, n: 0 };
          x.paid += h_; if (onJob) x.on += h_; x.n++; per.set(p.user_id, x);
        }
        let total = 0;
        for (const x of [...per.values()].sort((a, b) => a.name.localeCompare(b.name))) {
          const v = rule === 'clock_paid_hours' ? x.paid : rule === 'clock_onsite_hours' ? x.on : Math.max(0, x.paid - otAfter);
          if (rule === 'clock_overtime' && v <= 0) continue;
          total += v; detail.push({ label: x.name, amount: r2(v), ref: `${r2(x.paid)} h paid, ${r2(x.on)} h on job sites (${x.n} punches)` });
        }
        return out(total, 'hrs');
      }
      case 'ply_materials': case 'ply_unassigned': {
        let total = 0;
        for (const p of X.pos()) {
          if (!inWeek(X.day(p.order_date || p.created_at))) continue;
          if (rule === 'ply_unassigned' && p.job_id) continue;
          total += p.total;
          detail.push({ label: `${p.vendor || 'Vendor'} · PO ${p.number}`, amount: p.total, ref: `${p.job_number ? `job ${p.job_number}` : 'no job'} · ${p.status} · ${X.day(p.order_date || p.created_at)}` });
        }
        return out(total, '$');
      }
      case 'ply_inventory': {
        const rows = all(db, "SELECT code, name, qty_on_hand q, unit_cost c FROM pricebook WHERE active = 1 AND qty_on_hand > 0 ORDER BY name");
        let total = 0; rows.forEach(r => { const v = r.q * (r.c || 0); total += v; detail.push({ label: `${r.code || ''} ${r.name}`.trim(), amount: r2(v), ref: `${r.q} on hand × ${r.c}` }); });
        return out(total, '$');
      }
      default: return null;
    }
  }

  // first week Field Ops numbers are used for: the setting, else the earliest week Field Ops has records for
  function startWeek(c, sundayOf) {
    const set = String(D.settings(db).kpi_auto_from || '').trim();
    if (/^\d{4}-\d\d-\d\d$/.test(set)) return sundayOf(set);
    const r = get(db, `SELECT MIN(t) t FROM (SELECT MIN(created_at) t FROM jobs UNION ALL SELECT MIN(created_at) FROM invoices UNION ALL SELECT MIN(clock_in) FROM time_entries UNION ALL SELECT MIN(created_at) FROM estimates)`);
    if (!r || !r.t) return null;
    return sundayOf(localNow(c.tz, new Date(Date.parse(String(r.t).replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(r.t) ? '' : 'Z')))).slice(0, 10));
  }

  return { RULES, NOW_ONLY, compute, context, satNight, startWeek };
};
module.exports.RULES = RULES;
