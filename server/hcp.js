'use strict';
// Housecall Pro → Field Ops: pull customers (with addresses and notes), estimates (options, line items, notes) and
// jobs (status, schedule, techs, notes) from the Housecall Pro public API and bring Field Ops up to date.
//
//  API: https://api.housecallpro.com, header "Authorization: Token <API key>". The API is on Housecall Pro's MAX
//  plan; an admin makes the key in Housecall Pro under App Store → API. Lists page from 1 (page, page_size) and answer
//  with page / total_pages / total_items beside the records. Money is in cents.
//
//  Rules ("Housecall Pro wins, blanks ignored"):
//   customers  matched by HCP id, then old-system id, email, phone, exact name. Non-blank HCP values replace ours.
//              HCP's customer notes go in their own field (shown on the customer) so nothing typed here is lost.
//   estimates  matched by HCP id, then estimate number. New ones come over whole (options + lines). Existing ones get
//              status (approved / declined / sent) and notes; their lines are left alone.
//   jobs       matched by HCP id, then job number (HCP's "invoice number"). Status, schedule, description, address
//              and techs follow HCP — except a job already Invoiced here stays Invoiced, and On hold / Dispatched stay
//              unless HCP says it's finished or cancelled. Titles, billing type and money are never touched.
//   notes      job and estimate notes are kept by HCP note id: a re-pull updates them instead of adding copies.
const D = require('./db');
const { all, get, run, settings, tx } = D;
const Imp = require('./importer');

const BASE = () => (process.env.HCP_API_BASE || 'https://api.housecallpro.com').replace(/\/+$/, '');   // env only for tests
const err = (msg, status = 502) => Object.assign(new Error(msg), { status });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const clip = (s, n) => (s == null ? s : String(s).slice(0, n));
const blank = v => v == null || String(v).trim() === '';
const cents = v => (v == null || v === '' ? null : Math.round(Number(v)) / 100);

function key(db) { const k = settings(db).hcp_api_key; if (!k) throw err('Add the Housecall Pro API key under Settings → Housecall Pro first.', 400); return k; }

async function request(db, path, query) {
  const url = BASE() + path + (query ? '?' + new URLSearchParams(Object.entries(query).filter(([, v]) => v != null && v !== '')) : '');
  for (let attempt = 0; ; attempt++) {
    let res;
    try { res = await fetch(url, { headers: { Authorization: `Token ${key(db)}`, Accept: 'application/json' }, signal: AbortSignal.timeout(45000) }); }
    catch (e) { if (e.status) throw e; if (attempt < 2) { await sleep(3000); continue; } throw err("Can't reach Housecall Pro. Check the server's internet connection and try again."); }
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      const wait = Math.min(90, Number(res.headers.get('retry-after') || res.headers.get('ratelimit-reset')) || 15 * (attempt + 1));
      await sleep(wait * 1000); continue;
    }
    const text = await res.text();
    let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text.slice(0, 300) }; }
    if (res.ok) return data;
    if (res.status === 401) throw err('Housecall Pro refused the API key (401). Check it under Settings → Housecall Pro.', 400);
    if (res.status === 403) throw err('Housecall Pro says this account may not use the API (403). The API needs the MAX plan.', 400);
    throw err(`Housecall Pro ${path}: ${res.status} ${data.message || data.error || text.slice(0, 200)}`);
  }
}
// every page of a list. since (ISO): newest-updated first, stop once a whole page is older than that.
async function pageAll(db, path, name, { since, onPage } = {}) {
  const out = [];
  for (let page = 1; ; page++) {
    const r = await request(db, path, { page, page_size: 100, sort_by: since ? 'updated_at' : 'created_at', sort_direction: since ? 'desc' : 'asc' });
    const recs = r[name] || r.data || [];
    const fresh = since ? recs.filter(x => !x.updated_at || x.updated_at >= since) : recs;
    out.push(...fresh); if (onPage) onPage(out.length, r.total_items);
    if (!recs.length || page >= (r.total_pages || 1) || (since && fresh.length < recs.length)) return out;
  }
}

// ------------------------------------------------------------ customers + addresses
const notesText = n => (Array.isArray(n) ? n.map(x => (x && (x.content || x.text)) || '').filter(Boolean).join('\n\n') : n || '');
function upsertLocation(db, customerId, a) {
  if (!a || !(a.street || a.city)) return null;
  const street = [a.street, a.street_line_2].filter(Boolean).join(', ');
  let l = a.id ? get(db, 'SELECT * FROM locations WHERE hcp_id = ?', a.id) : null;
  if (!l && street) l = get(db, 'SELECT * FROM locations WHERE customer_id = ? AND lower(address) = ?', customerId, street.toLowerCase());
  const data = { address: clip(street, 200), city: clip(a.city, 80), state: clip(a.state, 40), zip: clip(a.zip, 20) };
  if (l) {
    const set = Object.entries(data).filter(([k, v]) => !blank(v) && v !== l[k]);
    if (a.id && l.hcp_id !== a.id) set.push(['hcp_id', a.id]);
    if (set.length) run(db, `UPDATE locations SET ${set.map(([k]) => `${k} = ?`).join(', ')} WHERE id = ?`, ...set.map(([, v]) => v), l.id);
    return l.id;
  }
  return Number(run(db, 'INSERT INTO locations (customer_id, label, address, city, state, zip, hcp_id) VALUES (?,?,?,?,?,?,?)',
    customerId, clip(a.type === 'billing' ? 'Billing' : 'Service', 40), data.address || '', data.city, data.state, data.zip, a.id || null).lastInsertRowid);
}
function upsertCustomer(db, c, stats) {
  const person = [c.first_name, c.last_name].filter(Boolean).join(' ').trim();
  const name = person || c.company || c.email || c.mobile_number || 'Housecall Pro customer';
  const phones = [c.mobile_number, c.home_number, c.work_number].filter(Boolean);
  const data = { name: clip(name, 200), company: clip(c.company, 200), email: clip(c.email, 200), phone: clip(phones[0], 40),
    alt_phone: clip(phones.find(p => p.replace(/\D/g, '') !== String(phones[0]).replace(/\D/g, '')), 40), lead_source: clip(c.lead_source, 80),
    hcp_notes: clip(notesText(c.notes), 20000) };
  let cur = get(db, 'SELECT * FROM customers WHERE hcp_id = ?', c.id) || get(db, 'SELECT * FROM customers WHERE external_id = ?', c.id)
    || Imp.findCustomer(db, { email: c.email, phone: phones[0], name });
  let id;
  if (cur) {
    const set = Object.entries(data).filter(([k, v]) => !blank(v) && v !== cur[k]);
    if (cur.hcp_id !== c.id) set.push(['hcp_id', c.id]);
    if (set.length) { run(db, `UPDATE customers SET ${set.map(([k]) => `${k} = ?`).join(', ')} WHERE id = ?`, ...set.map(([, v]) => v), cur.id); if (stats) stats.updated++; }
    else if (stats) stats.same++;
    id = cur.id;
  } else {
    const commercial = !!(c.company && !person);
    id = Number(run(db, `INSERT INTO customers (type, name, company, email, phone, alt_phone, lead_source, hcp_notes, hcp_id${c.created_at ? ', created_at' : ''})
      VALUES (?,?,?,?,?,?,?,?,?${c.created_at ? ',?' : ''})`, commercial ? 'commercial' : 'residential', data.name, data.company || null, data.email || null,
      data.phone || null, data.alt_phone || null, data.lead_source || null, data.hcp_notes || null, c.id, ...(c.created_at ? [c.created_at.replace('T', ' ').slice(0, 19)] : [])).lastInsertRowid);
    if (stats) stats.created++;
  }
  for (const a of c.addresses || []) upsertLocation(db, id, a);
  return id;
}
function customerFor(db, c, stats) {
  if (!c || !c.id) return null;
  const known = get(db, 'SELECT id FROM customers WHERE hcp_id = ?', c.id);
  return known ? known.id : upsertCustomer(db, c, stats);
}

// ------------------------------------------------------------ notes
function syncNotes(db, table, fk, ownerId, notes, prefix = '') {
  let n = 0;
  for (const x of Array.isArray(notes) ? notes : []) {
    const body = String((x && (x.content || x.text)) || '').trim(); if (!body || !x.id) continue;
    const text = clip(prefix + body, 20000);
    const have = get(db, `SELECT id, body FROM ${table} WHERE hcp_id = ?`, x.id);
    if (have) { if (have.body !== text) { run(db, `UPDATE ${table} SET body = ? WHERE id = ?`, text, have.id); n++; } }
    else { run(db, `INSERT INTO ${table} (${fk}, user_id, body, hcp_id${x.created_at ? ', created_at' : ''}) VALUES (?, NULL, ?, ?${x.created_at ? ', ?' : ''})`,
      ownerId, text, x.id, ...(x.created_at ? [String(x.created_at).replace('T', ' ').slice(0, 19)] : [])); n++; }
  }
  return n;
}

// ------------------------------------------------------------ estimates
const OPT_STATUS = o => String(o.approval_status || o.status || '').toLowerCase();
function estimateStatus(e) {
  const st = (e.options || []).map(OPT_STATUS);
  if (st.some(s => /approved|accepted/.test(s))) return 'approved';
  if (st.length && st.every(s => /declin|reject/.test(s))) return 'declined';
  if (st.some(s => /awaiting|sent|pending/.test(s))) return 'sent';
  return 'draft';
}
async function optionLines(db, e, o) {
  if (Array.isArray(o.line_items)) return o.line_items;
  try { return await pageAll(db, `/estimates/${encodeURIComponent(e.id)}/options/${encodeURIComponent(o.id)}/line_items`, 'line_items'); }
  catch (x) { if (x.status === 400) throw x; return null; }   // can't read the lines: fall back to the option's total
}
async function syncEstimate(db, e, ctx) {
  const num = String(e.estimate_number || '').trim();
  let est = get(db, 'SELECT * FROM estimates WHERE hcp_id = ?', e.id) || (num ? get(db, 'SELECT * FROM estimates WHERE number = ? AND (hcp_id IS NULL OR hcp_id = ?)', num, e.id) : null);
  const status = estimateStatus(e), multi = (e.options || []).length > 1;
  if (!est) {
    const custId = tx(db, () => customerFor(db, e.customer, ctx.stats.customers));
    if (!custId) { ctx.problem(`Estimate ${num || e.id}: no customer on it; skipped`); return; }
    const cust = get(db, 'SELECT * FROM customers WHERE id = ?', custId);
    const date = String(e.created_at || '').slice(0, 10);
    const head = { number: num && !get(db, 'SELECT 1 x FROM estimates WHERE number = ?', num) ? num : '', customer_name: cust.name, customer_email: cust.email || '',
      customer_phone: cust.phone || '', status, date, title: clip(((e.options || [])[0] || {}).name || '', 200) };
    const recs = []; let row = 1;
    for (const o of e.options || []) {
      const lines = await optionLines(db, e, o);
      const option = multi ? o.name || `Option ${o.option_number || recs.length + 1}` : '';
      if (lines && lines.length) for (const l of lines) recs.push({ ...head, _row: row++, option,
        item: [l.name, l.description && l.description !== l.name ? l.description : ''].filter(Boolean).join('\n') || 'Item',
        qty: String(l.quantity ?? 1), unit_price: String(cents(l.unit_price) ?? 0), unit_cost: String(cents(l.unit_cost) ?? 0), taxable: l.taxable === false ? 'no' : 'yes' });
      else recs.push({ ...head, _row: row++, option, item: o.name || 'Estimate', qty: '1', unit_price: String(cents(o.total_amount) ?? 0), taxable: 'no' });
    }
    if (!recs.length) recs.push({ ...head, _row: 1, total: '0' });
    const r = Imp.importRecords(db, { type: 'estimates', recs, filename: 'Housecall Pro', userId: ctx.userId, H: ctx.H });
    if (r.error_count) { ctx.problem(`Estimate ${num || e.id}: ${r.errors.map(x => x.message).join('; ')}`); return; }
    const newId = (r.created_ids.find(([k]) => k === 'estimate') || [])[1]; if (!newId) return;
    est = get(db, 'SELECT * FROM estimates WHERE id = ?', newId);
    const loc = e.address ? upsertLocation(db, custId, e.address) : null;
    run(db, 'UPDATE estimates SET hcp_id = ?, customer_id = ?, location_id = COALESCE(?, location_id) WHERE id = ?', e.id, custId, loc, est.id);
    ctx.stats.estimates.created++;
  } else {
    tx(db, () => {
      const set = [];
      if (est.hcp_id !== e.id) set.push(['hcp_id', e.id]);
      const rank = { draft: 0, sent: 1, viewed: 1 };
      if (status !== est.status && !['approved', 'declined', 'expired'].includes(est.status) && (status === 'approved' || status === 'declined' || (rank[status] ?? 0) > (rank[est.status] ?? 0))) {
        set.push(['status', status]);
        if (status === 'approved') set.push(['approved_at', est.approved_at || String(e.updated_at || new Date().toISOString()).replace('T', ' ').slice(0, 19)]);
        if (status === 'declined') set.push(['declined_at', est.declined_at || String(e.updated_at || new Date().toISOString()).replace('T', ' ').slice(0, 19)]);
        if (status === 'sent' && !est.sent_at) set.push(['sent_at', String(e.created_at || new Date().toISOString()).replace('T', ' ').slice(0, 19)]);
      }
      if (set.length) { run(db, `UPDATE estimates SET ${set.map(([k]) => `${k} = ?`).join(', ')} WHERE id = ?`, ...set.map(([, v]) => v), est.id); ctx.stats.estimates.updated++; }
      else ctx.stats.estimates.same++;
    });
  }
  // which option the customer chose
  const won = (e.options || []).find(o => /approved|accepted/.test(OPT_STATUS(o)));
  if (won && multi && !est.approved_option_id) {
    const opt = get(db, 'SELECT id FROM estimate_options WHERE estimate_id = ? AND lower(name) = ?', est.id, String(won.name || '').toLowerCase());
    if (opt) run(db, 'UPDATE estimates SET approved_option_id = ? WHERE id = ?', opt.id, est.id);
  }
  tx(db, () => { for (const o of e.options || []) ctx.stats.notes += syncNotes(db, 'estimate_notes', 'estimate_id', est.id, o.notes, multi && o.name ? `[${o.name}] ` : ''); });
}

// ------------------------------------------------------------ jobs
const JOB_STATUS = (j) => {
  const s = String(j.work_status || '').toLowerCase();
  if (j.canceled_at || /cancel/.test(s)) return 'cancelled';
  if (/complete/.test(s)) return 'completed';
  if (/progress/.test(s)) return 'in_progress';
  if (/^scheduled/.test(s)) return 'scheduled';
  if (/unscheduled|needs/.test(s)) return 'unscheduled';
  return null;
};
function techIdsFor(db, emps) {
  const users = all(db, 'SELECT id, name, email FROM users');
  const ids = [], missing = [];
  for (const e of emps || []) {
    const nm = [e.first_name, e.last_name].filter(Boolean).join(' ').trim().toLowerCase();
    const u = users.find(x => e.email && (x.email || '').toLowerCase() === String(e.email).toLowerCase()) || users.find(x => nm && x.name.toLowerCase() === nm);
    if (u) ids.push(u.id); else if (nm || e.email) missing.push([e.first_name, e.last_name].filter(Boolean).join(' ').trim() || e.email);
  }
  return { ids: [...new Set(ids)], missing };
}
function syncJob(db, j, ctx) {
  tx(db, () => {
    const num = String(j.invoice_number ?? '').trim();
    let job = get(db, 'SELECT * FROM jobs WHERE hcp_id = ?', j.id) || (num ? get(db, 'SELECT * FROM jobs WHERE number = ? AND (hcp_id IS NULL OR hcp_id = ?)', num, j.id) : null);
    const custId = job ? job.customer_id : customerFor(db, j.customer, ctx.stats.customers);
    if (!custId) { ctx.problem(`Job ${num || j.id}: no customer on it; skipped`); return; }
    const loc = j.address ? upsertLocation(db, custId, j.address) : null;
    const hs = JOB_STATUS(j), sch = j.schedule || {}, ts = j.work_timestamps || {};
    const start = sch.scheduled_start || null, end = sch.scheduled_end && start && sch.scheduled_end > start ? sch.scheduled_end : null;
    const done = ts.completed_at ? String(ts.completed_at).replace('T', ' ').slice(0, 19) : null;
    const { ids: techs, missing } = techIdsFor(db, j.assigned_employees);
    if (missing.length) ctx.problem(`Job ${num || j.id}: no team member for ${missing.join(', ')} (add them in Team, then pull again)`);
    const desc = clip(String(j.description || '').trim(), 5000), jtype = ((j.job_fields || {}).job_type || {}).name;
    let id;
    if (job) {
      const set = [];
      const keep = job.status === 'invoiced' ? true : ['on_hold', 'dispatched'].includes(job.status) ? !['completed', 'cancelled'].includes(hs) : false;
      if (hs && hs !== job.status && !keep) set.push(['status', hs]);
      if (hs === 'cancelled' && !job.cancelled_at) set.push(['cancelled_at', String(j.canceled_at || new Date().toISOString()).replace('T', ' ').slice(0, 19)]);
      if (desc && desc !== job.description) set.push(['description', desc]);
      if (start && start !== job.scheduled_start) set.push(['scheduled_start', start]);
      if (end && end !== job.scheduled_end) set.push(['scheduled_end', end]);
      if (done && !job.completed_at) set.push(['completed_at', done]);
      if (loc && loc !== job.location_id) set.push(['location_id', loc]);
      if (!blank(j.lead_source) && j.lead_source !== job.lead_source) set.push(['lead_source', clip(j.lead_source, 80)]);
      if (job.hcp_id !== j.id) set.push(['hcp_id', j.id]);
      if (set.length) { run(db, `UPDATE jobs SET ${set.map(([k]) => `${k} = ?`).join(', ')} WHERE id = ?`, ...set.map(([, v]) => v), job.id); ctx.stats.jobs.updated++; }
      else ctx.stats.jobs.same++;
      id = job.id;
    } else {
      const number = num && !get(db, 'SELECT 1 x FROM jobs WHERE number = ?', num) ? num : D.nextNumber(db, 'jobs', 'J');
      if (num && number !== num) ctx.problem(`Job ${num}: that number is already used here by another job; brought in as ${number}`);
      const status = hs || (done ? 'completed' : start ? 'scheduled' : 'unscheduled');
      id = Number(run(db, `INSERT INTO jobs (number, customer_id, location_id, title, description, job_type, status, scheduled_start, scheduled_end, lead_source, completed_at,
          cancelled_at, hcp_id${j.created_at ? ', created_at' : ''}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?${j.created_at ? ',?' : ''})`,
        number, custId, loc || (get(db, 'SELECT id FROM locations WHERE customer_id = ? ORDER BY id LIMIT 1', custId) || {}).id || null,
        clip(desc.split(/\r?\n/)[0] || jtype || 'Housecall Pro job', 120), desc || null,
        (String(jtype || 'service').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'service'), status, start, end, clip(j.lead_source, 80) || null,
        done || (status === 'completed' && start ? start.slice(0, 10) + ' 17:00:00' : null), status === 'cancelled' ? String(j.canceled_at || new Date().toISOString()).replace('T', ' ').slice(0, 19) : null,
        j.id, ...(j.created_at ? [String(j.created_at).replace('T', ' ').slice(0, 19)] : [])).lastInsertRowid);
      ctx.stats.jobs.created++;
    }
    // techs follow HCP when HCP names anyone we know
    if (techs.length) {
      const have = all(db, 'SELECT user_id FROM job_techs WHERE job_id = ?', id).map(r => r.user_id);
      if (have.length !== techs.length || have.some(u => !techs.includes(u))) {
        run(db, 'DELETE FROM job_techs WHERE job_id = ?', id);
        for (const u of techs) run(db, 'INSERT OR IGNORE INTO job_techs (job_id, user_id) VALUES (?,?)', id, u);
      }
    }
    const cur = get(db, 'SELECT status, scheduled_start, scheduled_end FROM jobs WHERE id = ?', id);
    if (cur.scheduled_start && ['scheduled', 'dispatched', 'in_progress', 'on_hold'].includes(cur.status) && ctx.H.syncSingleAppointment)
      ctx.H.syncSingleAppointment(id, cur.scheduled_start, cur.scheduled_end, techs.length ? techs : undefined);
    // the estimate it came from
    for (const eid of [j.original_estimate_id, ...(j.original_estimate_uuids || [])].filter(Boolean))
      run(db, 'UPDATE estimates SET job_id = ? WHERE hcp_id = ? AND job_id IS NULL', id, eid);
    ctx.stats.notes += syncNotes(db, 'job_notes', 'job_id', id, j.notes);
  });
}

// ------------------------------------------------------------ the pull
let state = { running: false };
function status(db) {
  let last = null; try { last = JSON.parse(settings(db).hcp_last_sync || 'null'); } catch { last = null; }
  return { ...state, last, key_set: !!settings(db).hcp_api_key };
}
// full: every record; otherwise only what changed in HCP since the last finished pull
function start(db, { userId, H = {}, full = false } = {}) {
  if (state.running) throw err('A Housecall Pro pull is already running', 409);
  key(db);
  const prev = status(db).last;
  const since = !full && prev && prev.finished_at && !prev.failed ? prev.started_at : null;
  const stats = { customers: { created: 0, updated: 0, same: 0 }, estimates: { created: 0, updated: 0, same: 0 }, jobs: { created: 0, updated: 0, same: 0 }, notes: 0 };
  const problems = [];
  state = { running: true, phase: 'customers', done: 0, total: null, started_at: new Date().toISOString(), since, stats, problems };
  const ctx = { userId, H, stats, problem: m => { if (problems.length < 500) problems.push(m); } };
  const each = async (label, path, name, fn) => {
    state.phase = label; state.done = 0; state.total = null;
    const recs = await pageAll(db, path, name, { since, onPage: (n, t) => { state.total = since ? null : t; } });
    state.total = recs.length;
    for (const r of recs) {
      try { await fn(r); } catch (e) { if (e.status === 400) throw e; ctx.problem(`${label} ${r.invoice_number || r.estimate_number || r.id}: ${e.message}`); }
      state.done++;
    }
  };
  const done = (failed, message) => {
    const summary = { started_at: state.started_at, finished_at: new Date().toISOString(), full: !since, stats, problems: problems.slice(0, 200), problem_count: problems.length, failed: !!failed, message };
    run(db, "INSERT INTO settings (key, value) VALUES ('hcp_last_sync', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", JSON.stringify(summary));
    state = { running: false };
  };
  (async () => {
    try {
      await each('customers', '/customers', 'customers', c => tx(db, () => upsertCustomer(db, c, stats.customers)));
      await each('estimates', '/estimates', 'estimates', e => syncEstimate(db, e, ctx));
      await each('jobs', '/jobs', 'jobs', j => syncJob(db, j, ctx));
      done(false);
    } catch (e) { done(true, e.message); }
  })();
  return status(db);
}
// what HCP actually sends for one record of a kind (to check field names against a real account)
async function peek(db, what) {
  const path = { customers: '/customers', jobs: '/jobs', estimates: '/estimates', employees: '/employees' }[what];
  if (!path) throw err('Pick customers, jobs, estimates or employees', 400);
  const r = await request(db, path, { page: 1, page_size: 1 });
  return { total_items: r.total_items, first: (r[what] || r.data || [])[0] || null };
}
async function test(db) {
  const r = await request(db, '/customers', { page: 1, page_size: 1 });
  const j = await request(db, '/jobs', { page: 1, page_size: 1 });
  const e = await request(db, '/estimates', { page: 1, page_size: 1 });
  return { customers: r.total_items ?? null, jobs: j.total_items ?? null, estimates: e.total_items ?? null };
}
const _waitIdle = async () => { while (state.running) await sleep(20); };   // tests

module.exports = { start, status, peek, test, _waitIdle, upsertCustomer, JOB_STATUS, estimateStatus };
