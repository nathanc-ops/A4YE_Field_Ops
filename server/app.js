'use strict';
const express = require('express');
const path = require('node:path');
const D = require('./db');
const C = require('./calc');
const mailer = require('./mailer');
const A = require('./accounting');
const Bill = require('./billing');
const Geo = require('./geo');
const P = require('./perms');
const TC = require('./timeclock');

const { all, get, run, tx } = D;

function createApp(db) {
  const app = express();
  app.set('trust proxy', 'loopback'); // behind Caddy on the same machine: use the visitor's real IP
  app.disable('x-powered-by');
  // photo uploads arrive as base64 JSON (10 MB file ≈ 13.4 MB encoded); everything else stays small
  const keepRaw = (req, res, buf) => { req.rawBody = buf; };
  const bigJson = express.json({ limit: '15mb', verify: keepRaw }), smallJson = express.json({ limit: '2mb', verify: keepRaw });
  const importJson = express.json({ limit: '40mb' }); // CSV exports from the old system can be large
  const rawUpload = express.raw({ type: () => true, limit: '160mb' });   // plan files, one at a time
  app.use((req, res, next) => /^\/api\/estimating\/takeoffs\/\d+\/upload$/.test(req.path) ? rawUpload(req, res, next) : next());
  app.use((req, res, next) => /^\/api\/estimating\/takeoffs\/\d+\/upload$/.test(req.path) ? next() : (req.path === '/api/attachments' || req.path === '/api/import/photos' ? bigJson
    : req.path.startsWith('/api/import/') || req.path === '/api/estimating/import' || req.path === '/api/estimating/price-list' || /^\/api\/estimating\/(bids\/\d+\/takeoff|takeoffs\/\d+\/files)$/.test(req.path) ? importJson : smallJson)(req, res, next));

  // ------------------------------------------------------------ helpers
  // Sync handlers run inside one transaction, so a failed ledger posting rolls back the whole change.
  const wrap = fn => (req, res, next) => {
    try {
      if (fn.constructor.name === 'AsyncFunction') fn(req, res).catch(next);
      else tx(db, () => fn(req, res));
    } catch (e) { next(e); }
  };
  const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
  const today = () => new Date().toISOString().slice(0, 10);
  const addDays = (d, n) => { const x = new Date(d + 'T00:00:00'); x.setDate(x.getDate() + n); return x.toISOString().slice(0, 10); };
  const pick = (obj, keys) => Object.fromEntries(keys.filter(k => obj[k] !== undefined).map(k => [k, obj[k] === '' ? null : obj[k]]));
  const baseUrl = req => process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
  // the line under customer emails: replying reaches the office (Reply-To is the company email) even from a no-reply sender

  function insert(table, data) {
    const keys = Object.keys(data);
    if (!keys.length) throw bad('No fields');
    const info = run(db, `INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, ...keys.map(k => data[k]));
    return Number(info.lastInsertRowid);
  }
  function update(table, id, data) {
    const keys = Object.keys(data);
    if (!keys.length) return;
    run(db, `UPDATE ${table} SET ${keys.map(k => `${k} = ?`).join(',')} WHERE id = ?`, ...keys.map(k => data[k]), id);
  }
  function mustGet(table, id) {
    const r = get(db, `SELECT * FROM ${table} WHERE id = ?`, id);
    if (!r) throw bad('Not found', 404);
    return r;
  }

  const H = {}; // helpers shared with routes_ext.js (populated there)

  // ------------------------------------------------------------ auth
  function auth(req, res, next) {
    const h = req.get('authorization') || '';
    const tok = h.startsWith('Bearer ') ? h.slice(7) : null;
    const u = tok && get(db, `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND u.active = 1`, tok);
    if (!u) return res.status(401).json({ error: 'Not signed in' });
    delete u.password_hash;
    req.user = u; req.token = tok;
    req.perms = P.effective(u, D.settings(db));
    req.can = k => !!req.perms[k];
    next();
  }
  const role = (...roles) => (req, res, next) => roles.includes(req.user.role) ? next() : res.status(403).json({ error: 'You do not have permission for this' });
  const office = role('admin', 'manager', 'office');
  // admin-only routes also open to an office person who was given that area's permission (e.g. Accounting)
  const admin = (req, res, next) => req.user.role === 'admin' || ((req.user.role === 'office' || req.user.role === 'manager') && req.permGranted)
    ? next() : res.status(403).json({ error: 'You do not have permission for this' });

  app.get('/api/setup', wrap((req, res) => {
    const s = D.settings(db);
    res.json({ needs_setup: get(db, 'SELECT COUNT(*) n FROM users').n === 0,
      brand: { company_name: s.company_name, logo_url: s.logo_url, tagline: s.company_tagline, brand_primary: s.brand_primary } });
  }));
  app.post('/api/setup', wrap((req, res) => {
    if (get(db, 'SELECT COUNT(*) n FROM users').n > 0) throw bad('Already set up');
    const { name, email, password, company_name } = req.body;
    if (!name || !email || !password || password.length < 8) throw bad('Name, email and a password of 8+ characters are required');
    const id = insert('users', { name, email, password_hash: D.hashPassword(password), role: 'admin' });
    if (company_name) run(db, "UPDATE settings SET value = ? WHERE key = 'company_name'", company_name);
    const tok = D.token(); run(db, 'INSERT INTO sessions (token, user_id) VALUES (?,?)', tok, id);
    res.json({ token: tok });
  }));
  // Slow down password guessing: 8 misses for an email or 30 from one address locks it for 15 minutes.
  const fails = new Map();
  const LOCK_MS = 15 * 60e3;
  const failKey = (k, limit) => { const f = fails.get(k); return f && Date.now() - f.first < LOCK_MS && f.n >= limit; };
  const addFail = k => { const f = fails.get(k); if (!f || Date.now() - f.first >= LOCK_MS) fails.set(k, { n: 1, first: Date.now() }); else f.n++; if (fails.size > 10000) fails.clear(); };
  app.get('/healthz', (req, res) => { try { get(db, 'SELECT 1 x'); res.json({ ok: true }); } catch { res.status(500).json({ ok: false }); } });
  app.post('/api/login', wrap((req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    const kE = 'e:' + email, kI = 'i:' + req.ip;
    if (failKey(kE, 8) || failKey(kI, 30)) throw bad('Too many failed sign-ins. Wait 15 minutes and try again, or ask an admin to reset your password.', 429);
    const u = get(db, 'SELECT * FROM users WHERE lower(email) = ? AND active = 1', email);
    if (!u || !D.verifyPassword(String(req.body.password || ''), u.password_hash)) { addFail(kE); addFail(kI); throw bad('Wrong email or password', 401); }
    fails.delete(kE);
    const tok = D.token(); run(db, 'INSERT INTO sessions (token, user_id) VALUES (?,?)', tok, u.id);
    res.json({ token: tok });
  }));

  // ------------------------------------------------------------ public (customer-facing) docs
  // Signed-in office staff opening a customer link: may preview drafts, and doesn't count as the customer viewing it.
  const staffFrom = req => {
    const h = req.get('authorization') || '';
    if (!h.startsWith('Bearer ')) return null;
    const u = get(db, 'SELECT u.id, u.role FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND u.active = 1', h.slice(7));
    return u && u.role !== 'tech' ? u : null;
  };
  function publicDoc(kind, tokenValue, { staff = null } = {}) {
    const s = D.settings(db);
    const company = { name: s.company_name, phone: s.company_phone, email: s.company_email, address: s.company_address, license: s.license_number,
      logo_url: s.logo_url, brand_primary: s.brand_primary, brand_accent: s.brand_accent };
    if (kind === 'estimate') {
      const e = get(db, 'SELECT * FROM estimates WHERE public_token = ?', tokenValue);
      if (!e) throw bad('Not found', 404);
      if (e.status === 'sent' && !staff) { run(db, "UPDATE estimates SET status = 'viewed', viewed_at = datetime('now') WHERE id = ?", e.id); e.status = 'viewed'; }
      const full = C.estimateWithTotals(db, e);
      for (const it of [...full.items, ...full.chosen_items]) delete it.unit_cost;
      for (const o of full.options) { delete o.est_cost; delete o.est_margin_pct; }
      delete full.est_cost; delete full.est_margin_pct;
      full.pending_review = e.review_status === 'pending';
      delete full.review_reasons; delete full.review_note;
      return { kind, company, doc: full, staff_preview: !!staff, customer: get(db, 'SELECT name, company, email, phone, billing_address FROM customers WHERE id = ?', e.customer_id),
        location: e.location_id ? get(db, 'SELECT * FROM locations WHERE id = ?', e.location_id) : null };
    }
    const i = get(db, 'SELECT * FROM invoices WHERE public_token = ?', tokenValue);
    if (!i) throw bad('Not found', 404);
    if (i.status === 'draft' && !staff) throw bad(`This invoice hasn't been sent yet. Please contact ${s.company_name || 'us'}${s.company_phone ? ` at ${s.company_phone}` : ''} if you were expecting it.`, 404);
    const full = C.invoiceWithTotals(db, i);
    for (const it of full.items) delete it.unit_cost;
    delete full.est_cost; delete full.est_margin_pct;
    const job = i.job_id ? get(db, 'SELECT number, title, location_id, signoff_name, signoff_at FROM jobs WHERE id = ?', i.job_id) : null;
    return { kind, company, doc: full, staff_preview: !!staff, customer: get(db, 'SELECT name, company, email, phone, billing_address FROM customers WHERE id = ?', i.customer_id),
      job, location: job && job.location_id ? get(db, 'SELECT * FROM locations WHERE id = ?', job.location_id) : null };
  }
  app.get('/api/public/:kind(estimate|invoice)/:token', wrap((req, res) => res.json(publicDoc(req.params.kind, req.params.token, { staff: staffFrom(req) }))));
  // an issued bi-weekly project report, GC copy only (built in workbook.js)
  app.get('/api/public/report/:token', wrap((req, res) => { if (!app.locals.publicReport) throw bad('Not found', 404); res.json(app.locals.publicReport(req.params.token, { staff: !!staffFrom(req) })); }));
  app.post('/api/public/estimate/:token/respond', wrap((req, res) => {
    const e = get(db, 'SELECT * FROM estimates WHERE public_token = ?', req.params.token);
    if (!e) throw bad('Not found', 404);
    if (e.status === 'cancelled') throw bad('This estimate has been withdrawn. Please contact us for an updated quote.');
    if (!['sent', 'viewed'].includes(e.status)) throw bad(`This estimate is already ${e.status}`);
    if (e.review_status === 'pending' && req.body.decision === 'approve') throw bad('Your technician is confirming this pricing with the office. You can approve once it’s confirmed — usually within minutes.');
    if (req.body.decision === 'approve') {
      const sig = String(req.body.signature_name || '').trim();
      if (!sig) throw bad('Please type your name to sign');
      const opts = all(db, 'SELECT id FROM estimate_options WHERE estimate_id = ?', e.id).map(o => o.id);
      const optionId = opts.length ? Number(req.body.option_id) : null;
      if (opts.length && !opts.includes(optionId)) throw bad('Please choose an option');
      run(db, "UPDATE estimates SET status = 'approved', approved_at = datetime('now'), signature_name = ?, approved_option_id = ? WHERE id = ?", sig, optionId, e.id);
    } else if (req.body.decision === 'decline') {
      run(db, "UPDATE estimates SET status = 'declined', declined_at = datetime('now') WHERE id = ?", e.id);
    } else throw bad('Unknown decision');
    res.json(publicDoc('estimate', req.params.token));
  }));

  // everything below requires sign-in
  app.use('/api', auth);
  const Push = require('./push');
  app.use('/api', Push.middleware); // notices go out after a change is saved
  // Per-employee permissions for office staff: one rule table (perms.js) decides which area a request belongs to.
  const COST_KEYS = new Set(['unit_cost', 'est_cost', 'est_margin_pct', 'hourly_cost', 'hourly_wage', 'burden_pct', 'labor_cost', 'materials_cost', 'material_cost',
    'other_cost', 'total_cost', 'cost_to_date', 'estimated_cost', 'projected_profit', 'projected_margin_pct', 'profit', 'margin_pct', 'budget_cost', 'budget_material',
    'budget_other', 'budget_materials', 'material_variance', 'loaded_rate', 'loaded_cost', 'permit_fees', 'forecast_cost', 'cost_variance',
    'committed_cost', 'invoiced_cost', 'open_commit', 'cost_to_date', 'gain_loss', 'margin', 'labor_rate', 'approved_cost']);
  const stripCosts = v => {
    if (Array.isArray(v)) { v.forEach(stripCosts); return v; }
    if (v && typeof v === 'object') for (const k of Object.keys(v)) { if (COST_KEYS.has(k)) delete v[k]; else stripCosts(v[k]); }
    return v;
  };
  app.use('/api', (req, res, next) => {
    if (req.user.role !== 'office' && req.user.role !== 'manager') return next();
    const rule = P.ruleFor(req.method, req.originalUrl.split('?')[0]);
    if (rule) {
      if (!req.can(rule.perm)) return res.status(403).json({ error: `You don't have permission for ${P.LABEL[rule.perm]}. Ask the owner to turn it on under Team.` });
      req.permGranted = true;
    }
    if (!req.can('see_costs')) { const json = res.json.bind(res); res.json = body => json(stripCosts(body)); }
    next();
  });

  const SECRET_KEYS = ['ply_api_key', 'ply_webhook_secret', 'google_maps_api_key', 'timeclock_key', 'smtp_pass', 'vapid_private_key', 'apns_key_p8', 'fcm_service_account', 'anthropic_api_key'];
  function publicSettings(user) {
    const s = D.settings(db);
    for (const k of SECRET_KEYS) { s[k + '_set'] = s[k] ? '1' : ''; s[k] = ''; }
    delete s.proposal_commercial; // signature + standard text: served only to estimators by /api/estimating/proposal-template
    if (user.role === 'tech') for (const k of Object.keys(s)) if (k.startsWith('ply_') || k.startsWith('default_') && k.endsWith('_account')) delete s[k];
    return s;
  }
  app.get('/api/me', (req, res) => {
    const { permissions, ...user } = req.user;
    res.json({ user: { ...user, perms: req.perms, kpi: app.locals.kpiAccess ? app.locals.kpiAccess(req.user).any : false }, settings: publicSettings(req.user) });
  });
  app.get('/api/permissions', admin, (req, res) => {
    const s = D.settings(db);
    res.json({ list: P.PERMS, defaults: { manager: P.defaults('manager', s), office: P.defaults('office', s), tech: P.defaults('tech', s), admin: P.defaults('admin', s) } });
  });
  app.post('/api/logout', wrap((req, res) => { run(db, 'DELETE FROM sessions WHERE token = ?', req.token); res.json({ ok: true }); }));
  app.post('/api/me/password', wrap((req, res) => {
    const u = get(db, 'SELECT * FROM users WHERE id = ?', req.user.id);
    if (!D.verifyPassword(String(req.body.current || ''), u.password_hash)) throw bad('Current password is wrong');
    if (String(req.body.next || '').length < 8) throw bad('New password must be 8+ characters');
    run(db, 'UPDATE users SET password_hash = ? WHERE id = ?', D.hashPassword(req.body.next), u.id);
    res.json({ ok: true });
  }));

  // ------------------------------------------------------------ settings
  app.put('/api/settings', admin, wrap((req, res) => {
    const up = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    for (const [k, v] of Object.entries(req.body || {})) {
      if (k.endsWith('_set')) continue;
      if (k.endsWith('_clear')) { const base = k.slice(0, -6); if (SECRET_KEYS.includes(base) && v) up.run(base, ''); continue; }
      if (SECRET_KEYS.includes(k) && !v) continue; // blank = keep existing secret
      if (k === 'smtp_pass') { up.run(k, String(v).replace(/\s+/g, '')); continue; } // pasted keys pick up stray spaces/newlines
      up.run(k, String(v ?? ''));
    }
    res.json(publicSettings(req.user));
  }));

  // ------------------------------------------------------------ email (Settings → Email)
  app.get('/api/settings/email', admin, (req, res) => {
    const s = D.settings(db), c = mailer.config(db);
    let last = null; try { last = s.smtp_last_test ? JSON.parse(s.smtp_last_test) : null; } catch { /* ignore */ }
    res.json({ configured: !!c, source: c ? c.source : null, server_env: !!process.env.SMTP_HOST, from: c ? c.from : null,
      host: s.smtp_host || '', port: s.smtp_port || '', security: s.smtp_security || '', user: s.smtp_user || '', pass_set: !!s.smtp_pass,
      from_name: s.smtp_from_name || '', from_email: s.smtp_from_email || '', last_test: last,
      reply_to: c ? mailer.defaultReplyTo(db, c.from) || null : (s.company_email || null), no_reply_sender: c ? mailer.isNoReply(c.from) : false,
      ...(process.env.SMTP_HOST ? { env: { host: process.env.SMTP_HOST, port: process.env.SMTP_PORT || '587', user: process.env.SMTP_USER || '' } } : {}) });
  });
  app.post('/api/settings/email-test', admin, wrap(async (req, res) => {
    const b = req.body || {}, to = String(b.to || '').trim();
    if (!/^[^@\s,;<>]+@[^@\s,;<>]+\.[^@\s,;<>]+$/.test(to)) throw bad('Enter the address to send the test to');
    const o = Object.fromEntries(['host', 'port', 'security', 'user', 'pass', 'from_name', 'from_email'].map(k => [k, b[k]]));
    const r = await mailer.test(db, to, o);
    db.prepare("INSERT INTO settings (key, value) VALUES ('smtp_last_test', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(JSON.stringify({ at: new Date().toISOString(), ok: r.ok, to, error: r.error || null, by: req.user.name }));
    res.json(r);
  }));

  // ------------------------------------------------------------ users / employees
  const USER_FIELDS = ['name', 'email', 'role', 'phone', 'title', 'license_number', 'hourly_wage', 'burden_pct', 'bill_rate', 'color', 'active', 'timeclock_id'];
  app.get('/api/users', wrap((req, res) => {
    const cols = req.user.role === 'tech' ? 'id, name, role, color, title, active' : 'id, name, email, role, phone, title, license_number, hourly_wage, burden_pct, bill_rate, color, active, created_at, permissions';
    const s = D.settings(db);
    res.json(all(db, `SELECT ${cols} FROM users ORDER BY active DESC, name`).map(u => {
      if (req.user.role !== 'admin') { delete u.permissions; return u; }
      const { permissions, ...rest } = u;
      return { ...rest, perms: P.effective(u, s), custom_perms: Object.keys(JSON.parse(permissions || '{}')) };
    }));
  }));
  app.post('/api/users', admin, wrap((req, res) => {
    if (!req.body.password || req.body.password.length < 8) throw bad('Password must be 8+ characters');
    const id = insert('users', { ...pick(req.body, USER_FIELDS), password_hash: D.hashPassword(req.body.password),
      permissions: P.overridesFrom(req.body.role || 'tech', req.body.perms, D.settings(db)) });
    res.json({ id });
  }));
  app.put('/api/users/:id', admin, wrap((req, res) => {
    const data = pick(req.body, USER_FIELDS);
    const target = get(db, 'SELECT * FROM users WHERE id = ?', req.params.id);
    if (!target) throw bad('Not found', 404);
    if (req.body.perms !== undefined || data.role) data.permissions = P.overridesFrom(data.role || target.role, req.body.perms !== undefined ? req.body.perms : P.effective(target, D.settings(db)), D.settings(db));
    if (Number(req.params.id) === req.user.id && data.role && data.role !== 'admin') throw bad("You can't take admin away from yourself");
    if (req.body.password) { if (req.body.password.length < 8) throw bad('Password must be 8+ characters'); data.password_hash = D.hashPassword(req.body.password); }
    update('users', req.params.id, data);
    if (data.active === 0 || data.active === false) run(db, 'DELETE FROM sessions WHERE user_id = ?', req.params.id);
    res.json({ ok: true });
  }));

  // ------------------------------------------------------------ customers & locations
  const CUST_FIELDS = ['type', 'name', 'company', 'email', 'phone', 'alt_phone', 'billing_address', 'lead_source', 'tax_exempt', 'payment_terms_days', 'notes', 'lead_status', 'est_value', 'owner_id', 'next_step', 'next_step_date'];
  const LOC_FIELDS = ['label', 'address', 'city', 'state', 'zip', 'service_size', 'panel_info', 'access_notes', 'lat', 'lng', 'verified_at'];

  // ------------------------------------------------------------ address lookup (see geo.js)
  app.get('/api/address/suggest', office, wrap(async (req, res) => {
    res.json({ ...(await Geo.suggest(D.settings(db), req.query.q, req.query.session)), google: !!(D.settings(db).google_maps_api_key || process.env.GOOGLE_MAPS_API_KEY) });
  }));
  app.get('/api/address/details', office, wrap(async (req, res) => res.json(await Geo.details(D.settings(db), req.query.id, req.query.session))));
  // Search: every word must match somewhere (name, company, email, any service address, old-system id);
  // digits also match phone numbers however they were typed. Paged: X-Total-Count says how many match in all.
  const digitsOnly = col => `REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(COALESCE(${col}, ''), ' ', ''), '-', ''), '(', ''), ')', ''), '.', ''), '+', '')`;
  // ---- list filters & sorting shared by customers, jobs, estimates and invoices
  const isDay = s => /^\d{4}-\d\d-\d\d$/.test(String(s || ''));
  const dirOf = q => String(q.dir || '').toLowerCase() === 'asc' ? 'ASC' : String(q.dir || '').toLowerCase() === 'desc' ? 'DESC' : null;
  // every word must match one of the columns
  function words(q, cols, where, p) {
    for (const word of String(q || '').trim().split(/\s+/).filter(Boolean).slice(0, 6)) {
      const like = `%${word.replace(/[%_\\]/g, m => '\\' + m)}%`;
      where.push(`(${cols.map(c => `${c} LIKE ? ESCAPE '\\'`).join(' OR ')})`); cols.forEach(() => p.push(like));
    }
  }
  function custOrder(q, sortName) {
    const d = dirOf(q);
    if (q.order === 'created') return `c.created_at ${d || 'DESC'}`;
    if (q.order === 'jobs') return `job_count ${d || 'DESC'}, ${sortName}`;
    return `${sortName} ${d || 'ASC'}`;
  }
  function jobOrder(q) {
    const d = dirOf(q), by = {
      number: [`LENGTH(j.number) {d}, j.number {d}`, 'DESC'], customer: ['LOWER(COALESCE(NULLIF(c.company, \'\'), c.name)) {d}', 'ASC'],
      title: ['LOWER(j.title) {d}', 'ASC'], created: ['j.created_at {d}', 'DESC'], completed: ["COALESCE(j.completed_at, '') {d}", 'DESC'],
      status: [`CASE j.status ${['unscheduled', 'scheduled', 'dispatched', 'in_progress', 'on_hold', 'completed', 'invoiced', 'cancelled'].map((s, i) => `WHEN '${s}' THEN ${i}`).join(' ')} END {d}`, 'ASC'],
      type: ['j.job_type {d}', 'ASC'], scheduled: ["COALESCE(j.scheduled_start, '9999') {d}", 'ASC'] }[q.order];
    return by ? `${by[0].replace(/\{d\}/g, d || by[1])}, j.id DESC` : "COALESCE(j.scheduled_start, '9999'), j.id DESC";
  }
  // sort computed rows in JS (totals aren't columns), then page; X-Total-Count and X-Sums describe every match
  function pageOut(res, q, rows, keys, def, sums) {
    const key = keys[q.order] ? q.order : def, get = keys[key];
    const text = typeof rows.map(get).find(v => v != null && v !== '') === 'string' && !['created', 'issued', 'due'].includes(key);
    const d = dirOf(q) || (text && key !== 'number' ? 'ASC' : 'DESC'), sign = d === 'ASC' ? 1 : -1;
    rows.sort((a, b) => { const x = get(a), y = get(b);
      const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x ?? '').localeCompare(String(y ?? ''), undefined, { numeric: true, sensitivity: 'base' });
      return c * sign || b.id - a.id; });
    const limit = Math.min(Math.max(Number(q.limit) || 200, 1), 1000), offset = Math.max(Number(q.offset) || 0, 0);
    res.set('X-Total-Count', String(rows.length));
    if (sums) res.set('X-Sums', JSON.stringify(Object.fromEntries(Object.entries(sums).map(([k, v]) => [k, C.r2(v)]))));
    res.json(rows.slice(offset, offset + limit));
  }
  app.get('/api/customers', wrap((req, res) => {
    const where = [], p = [];
    for (const word of String(req.query.q || '').trim().split(/\s+/).filter(Boolean).slice(0, 6)) {
      const like = `%${word.replace(/[%_\\]/g, m => '\\' + m)}%`;
      const ors = ["c.name LIKE ? ESCAPE '\\'", "c.company LIKE ? ESCAPE '\\'", "c.email LIKE ? ESCAPE '\\'", "c.external_id LIKE ? ESCAPE '\\'",
        "EXISTS (SELECT 1 FROM locations l WHERE l.customer_id = c.id AND (l.address LIKE ? ESCAPE '\\' OR l.city LIKE ? ESCAPE '\\' OR l.zip LIKE ? ESCAPE '\\' OR l.label LIKE ? ESCAPE '\\'))"];
      p.push(like, like, like, like, like, like, like, like);
      const dg = word.replace(/\D/g, '');
      if (dg.length >= 3 && dg.length >= word.replace(/[\s().+-]/g, '').length) { ors.push(`${digitsOnly('c.phone')} LIKE ?`, `${digitsOnly('c.alt_phone')} LIKE ?`); p.push(`%${dg}%`, `%${dg}%`); }
      where.push(`(${ors.join(' OR ')})`);
    }
    if (req.query.type) { where.push('c.type = ?'); p.push(req.query.type); }
    if (req.query.lead_source) { where.push('c.lead_source = ?'); p.push(req.query.lead_source); }
    if (isDay(req.query.created_from)) { where.push('c.created_at >= ?'); p.push(req.query.created_from); }
    if (isDay(req.query.created_to)) { where.push("c.created_at < date(?, '+1 day')"); p.push(req.query.created_to); }
    // default: people by last name, businesses by name; sort=first files people by first name as typed
    const sortName = req.query.sort === 'first' ? "LOWER(COALESCE(NULLIF(c.company, ''), c.name))" : 'cust_sort(c.name, c.company)';
    if (/^[a-z]$/i.test(req.query.letter || '')) { where.push(`UPPER(SUBSTR(${sortName}, 1, 1)) = ?`); p.push(req.query.letter.toUpperCase()); }
    else if (req.query.letter === '#') where.push(`UPPER(SUBSTR(${sortName}, 1, 1)) NOT BETWEEN 'A' AND 'Z'`);
    const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 1000), offset = Math.max(Number(req.query.offset) || 0, 0);
    res.set('X-Total-Count', String(get(db, `SELECT COUNT(*) n FROM customers c ${w}`, ...p).n));
    res.json(all(db, `SELECT c.*, (SELECT COUNT(*) FROM jobs j WHERE j.customer_id = c.id) job_count,
      (SELECT address || COALESCE(', ' || city, '') FROM locations l WHERE l.customer_id = c.id ORDER BY id LIMIT 1) primary_address
      FROM customers c ${w} ORDER BY ${custOrder(req.query, sortName)}, c.id LIMIT ? OFFSET ?`, ...p, limit, offset));
  }));
  app.get('/api/customers/:id', wrap((req, res) => {
    const c = mustGet('customers', req.params.id);
    c.locations = all(db, 'SELECT * FROM locations WHERE customer_id = ? ORDER BY id', c.id).map(l => ({ ...l, equipment: H.locationEquipment(l.id) }));
    c.jobs = all(db, 'SELECT id, number, title, status, scheduled_start, job_type FROM jobs WHERE customer_id = ? ORDER BY id DESC', c.id);
    c.estimates = all(db, 'SELECT * FROM estimates WHERE customer_id = ? ORDER BY id DESC', c.id).map(e => C.estimateWithTotals(db, e));
    c.invoices = all(db, 'SELECT * FROM invoices WHERE customer_id = ? ORDER BY id DESC', c.id).map(i => C.invoiceWithTotals(db, i));
    c.agreements = all(db, 'SELECT * FROM agreements WHERE customer_id = ? ORDER BY id DESC', c.id);
    c.lifetime_revenue = C.r2(c.invoices.filter(i => !['draft', 'void'].includes(i.status)).reduce((s, i) => s + i.subtotal - i.discount, 0));
    c.balance = C.r2(c.invoices.filter(i => ['sent', 'partial'].includes(i.status)).reduce((s, i) => s + i.balance, 0));
    res.json(c);
  }));
  app.post('/api/customers', office, wrap((req, res) => {
    if (!req.body.name) throw bad('Customer name is required');
    const id = tx(db, () => {
      const cid = insert('customers', pick(req.body, CUST_FIELDS));
      if (req.body.location && req.body.location.address) insert('locations', { customer_id: cid, ...pick(req.body.location, LOC_FIELDS) });
      return cid;
    });
    res.json({ id });
  }));
  app.put('/api/customers/:id', office, wrap((req, res) => { mustGet('customers', req.params.id); update('customers', req.params.id, pick(req.body, CUST_FIELDS)); res.json({ ok: true }); }));
  app.delete('/api/customers/:id', admin, wrap((req, res) => {
    const n = get(db, 'SELECT (SELECT COUNT(*) FROM jobs WHERE customer_id = ?) + (SELECT COUNT(*) FROM invoices WHERE customer_id = ?) + (SELECT COUNT(*) FROM estimates WHERE customer_id = ?) n', req.params.id, req.params.id, req.params.id).n;
    if (n) throw bad('Customer has jobs, estimates or invoices and cannot be deleted');
    run(db, 'DELETE FROM customers WHERE id = ?', req.params.id); res.json({ ok: true });
  }));
  app.post('/api/customers/:id/locations', office, wrap((req, res) => {
    if (!req.body.address) throw bad('Address is required');
    res.json({ id: insert('locations', { customer_id: Number(req.params.id), ...pick(req.body, LOC_FIELDS) }) });
  }));
  app.put('/api/locations/:id', office, wrap((req, res) => { update('locations', req.params.id, pick(req.body, LOC_FIELDS)); res.json({ ok: true }); }));

  // ------------------------------------------------------------ price book / inventory
  const PB_FIELDS = ['code', 'name', 'description', 'category', 'kind', 'unit', 'unit_cost', 'unit_price', 'labor_hours', 'taxable', 'qty_on_hand', 'reorder_point', 'vendor', 'active', 'cost_code_id', 'vendor_id', 'ply_item_id'];
  app.get('/api/pricebook', wrap((req, res) => {
    const q = `%${req.query.q || ''}%`;
    const rows = all(db, `SELECT * FROM pricebook WHERE (name LIKE ? OR code LIKE ? OR category LIKE ?) ${req.query.all ? '' : 'AND active = 1'} ORDER BY category, name`, q, q, q);
    if (req.user.role === 'tech') for (const r of rows) delete r.unit_cost;
    res.json(rows);
  }));
  app.post('/api/pricebook', office, wrap((req, res) => { if (!req.body.name) throw bad('Name is required'); res.json({ id: insert('pricebook', pick(req.body, PB_FIELDS)) }); }));
  app.put('/api/pricebook/:id', office, wrap((req, res) => {
    const before = mustGet('pricebook', req.params.id);
    const data = pick(req.body, PB_FIELDS);
    update('pricebook', before.id, data);
    // a manual change to on-hand quantity is a physical count adjustment
    if (data.qty_on_hand != null && Number(data.qty_on_hand) !== before.qty_on_hand && before.kind === 'material')
      A.postInventoryAdjustment(db, { pricebookId: before.id, delta: Number(data.qty_on_hand) - before.qty_on_hand, unitCost: data.unit_cost ?? before.unit_cost, userId: req.user.id });
    res.json({ ok: true });
  }));

  // ------------------------------------------------------------ jobs
  const JOB_FIELDS = ['customer_id', 'location_id', 'title', 'description', 'job_type', 'priority', 'status', 'scheduled_start', 'scheduled_end',
    'lead_source', 'po_number', 'contract_amount', 'budget_hours', 'budget_materials', 'completion_notes',
    'billing_type', 'retainage_pct', 'percent_complete', 'labor_rate', 'material_markup_pct', 'trip_charge', 'nte_amount', 'bill_travel',
    'is_project', 'project_manager_id', 'foreman_id', 'start_date', 'end_date', 'gc_contact', 'gc_phone', 'gc_email', 'timeclock_job'];
  // A blank box means "use the default" for columns that can't be empty (the form blanks the other billing type's fields).
  const JOB_NOT_BLANK = { retainage_pct: 0, bill_travel: 1, job_type: 'service', priority: 'normal', billing_type: 'tm', is_project: 0 };
  const jobData = body => { const d = pick(body, JOB_FIELDS); for (const [k, v] of Object.entries(JOB_NOT_BLANK)) if (k in d && (d[k] === null || d[k] === '')) d[k] = v; return d; };
  const jobSelect = `SELECT j.*, c.name customer_name, c.company customer_company, c.type customer_type, c.phone customer_phone,
    l.address, l.city, l.state, l.zip,
    (SELECT GROUP_CONCAT(u.name, ', ') FROM job_techs jt JOIN users u ON u.id = jt.user_id WHERE jt.job_id = j.id) tech_names,
    (SELECT GROUP_CONCAT(jt.user_id) FROM job_techs jt WHERE jt.job_id = j.id) tech_ids
    FROM jobs j JOIN customers c ON c.id = j.customer_id LEFT JOIN locations l ON l.id = j.location_id`;
  const fixTechs = j => ({ ...j, tech_ids: j.tech_ids ? String(j.tech_ids).split(',').map(Number) : [] });
  function setTechs(jobId, ids) {
    if (!Array.isArray(ids)) return;
    const before = new Set(all(db, 'SELECT user_id FROM job_techs WHERE job_id = ?', jobId).map(r => r.user_id));
    run(db, 'DELETE FROM job_techs WHERE job_id = ?', jobId);
    for (const uid of ids) run(db, 'INSERT OR IGNORE INTO job_techs (job_id, user_id) VALUES (?,?)', jobId, uid);
    // put on a job: a phone notice (dropped if the same change also puts them on a visit, which says more)
    const j = get(db, 'SELECT status FROM jobs WHERE id = ?', jobId);
    if (j && !['completed', 'cancelled', 'invoiced', 'closed'].includes(j.status)) for (const uid of new Set(ids.map(Number))) if (!before.has(uid)) Push.queue({ type: 'job', user_id: uid, job_id: jobId });
  }
  app.get('/api/jobs', wrap((req, res) => {
    const where = [], p = [];
    if (req.query.status) { where.push(`j.status IN (${req.query.status.split(',').map(() => '?').join(',')})`); p.push(...req.query.status.split(',')); }
    if (req.query.from) { where.push('j.scheduled_end >= ?'); p.push(req.query.from); }
    if (req.query.to) { where.push('j.scheduled_start < ?'); p.push(req.query.to); }
    if (req.query.customer_id) { where.push('j.customer_id = ?'); p.push(req.query.customer_id); }
    if (req.query.job_type) { where.push('j.job_type = ?'); p.push(req.query.job_type); }
    if (req.query.billing_type) { where.push('j.billing_type = ?'); p.push(req.query.billing_type); }
    if (req.query.kind === 'project') where.push('j.is_project = 1'); else if (req.query.kind === 'service') where.push('COALESCE(j.is_project, 0) = 0');
    if (req.query.tech_id) { where.push('EXISTS (SELECT 1 FROM job_techs jt2 WHERE jt2.job_id = j.id AND jt2.user_id = ?)'); p.push(req.query.tech_id); }
    if (isDay(req.query.sched_from)) { where.push('j.scheduled_start >= ?'); p.push(C.startOfDay(req.query.sched_from)); }
    if (isDay(req.query.sched_to)) { where.push('j.scheduled_start < ?'); p.push(C.endOfDay(req.query.sched_to)); }
    if (req.query.unscheduled_only) where.push('j.scheduled_start IS NULL');
    // search like the customer list: every word must match somewhere (job #, time clock #, title, customer, address, PO)
    const q = String(req.query.q || '').trim();
    for (const word of q.split(/\s+/).filter(Boolean).slice(0, 6)) {
      const like = `%${word.replace(/[%_\\]/g, m => '\\' + m)}%`;
      where.push(`(j.number LIKE ?1 ESCAPE '\\' OR j.timeclock_job LIKE ?1 ESCAPE '\\' OR j.title LIKE ?1 ESCAPE '\\' OR j.po_number LIKE ?1 ESCAPE '\\'
        OR c.name LIKE ?1 ESCAPE '\\' OR c.company LIKE ?1 ESCAPE '\\' OR l.address LIKE ?1 ESCAPE '\\' OR l.city LIKE ?1 ESCAPE '\\')`.replace(/\?1/g, () => { p.push(like); return '?'; }));
    }
    if (req.user.role === 'tech' || req.query.mine) { where.push('EXISTS (SELECT 1 FROM job_techs jt WHERE jt.job_id = j.id AND jt.user_id = ?)'); p.push(req.user.id); }
    const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const limit = Math.min(Math.max(Number(req.query.limit) || 1000, 1), 1000);
    res.set('X-Total-Count', String(get(db, `SELECT COUNT(*) n FROM jobs j JOIN customers c ON c.id = j.customer_id LEFT JOIN locations l ON l.id = j.location_id ${w}`, ...p).n));
    // a picker search puts the job whose number was typed first, then open work, then newest; the job list keeps schedule order
    const order = req.query.picker
      ? `CASE WHEN lower(j.number) = lower(?) OR lower(j.number) = lower('J-' || ?) OR j.timeclock_job = ? THEN 0 WHEN j.number LIKE ? OR j.timeclock_job LIKE ? THEN 1 ELSE 2 END,
         CASE WHEN j.status IN ('cancelled') THEN 2 WHEN j.status IN ('completed', 'invoiced') THEN 1 ELSE 0 END, j.id DESC`
      : jobOrder(req.query);
    const op = req.query.picker ? [q, q, q, `${q}%`, `${q}%`] : [];
    res.json(all(db, `${jobSelect} ${w} ORDER BY ${order} LIMIT ?`, ...p, ...op, limit).map(fixTechs));
  }));
  app.get('/api/jobs/:id', wrap((req, res) => {
    const j = get(db, `${jobSelect} WHERE j.id = ?`, req.params.id);
    if (!j) throw bad('Not found', 404);
    const job = fixTechs(j);
    if (req.user.role === 'tech' && !job.tech_ids.includes(req.user.id)) throw bad('Not assigned to this job', 403);
    if (job.hold_by) job.hold_by_name = (get(db, 'SELECT name FROM users WHERE id = ?', job.hold_by) || {}).name || null;
    if (job.hold_assignee) job.hold_assignee_name = (get(db, 'SELECT name FROM users WHERE id = ?', job.hold_assignee) || {}).name || null;
    job.location = job.location_id ? get(db, 'SELECT * FROM locations WHERE id = ?', job.location_id) : null;
    job.time = all(db, 'SELECT t.*, u.name user_name, cc.code cost_code FROM time_entries t JOIN users u ON u.id = t.user_id LEFT JOIN cost_codes cc ON cc.id = t.cost_code_id WHERE t.job_id = ? ORDER BY clock_in DESC', job.id);
    job.materials = all(db, 'SELECT m.*, u.name user_name, cc.code cost_code FROM job_materials m LEFT JOIN users u ON u.id = m.user_id LEFT JOIN cost_codes cc ON cc.id = m.cost_code_id WHERE job_id = ? ORDER BY m.id DESC', job.id);
    job.notes = all(db, 'SELECT n.*, u.name user_name FROM job_notes n LEFT JOIN users u ON u.id = n.user_id WHERE job_id = ? ORDER BY n.id DESC', job.id);
    job.permits = all(db, 'SELECT * FROM permits WHERE job_id = ? ORDER BY id', job.id);
    job.appointments = H.appointments('a.job_id = ?', [job.id]);
    H.ensureJobForms(job.id);
    job.forms = H.jobForms(job.id);
    job.completion_blockers = H.completionBlockers(job.id);
    if (req.user.role === 'admin') job.delete_blockers = H.jobDeleteBlockers(job.id);
    job.attachments = H.jobAttachments(job.id);
    job.equipment = job.location_id ? H.locationEquipment(job.location_id) : [];
    job.pick_lists = all(db, 'SELECT * FROM pick_lists WHERE job_id = ? ORDER BY id DESC', job.id);
    job.budgets = all(db, 'SELECT jb.*, cc.code, cc.name FROM job_budgets jb JOIN cost_codes cc ON cc.id = jb.cost_code_id WHERE job_id = ? ORDER BY cc.code', job.id);
    if (req.user.role !== 'tech') {
      job.expenses = all(db, 'SELECT * FROM expenses WHERE job_id = ? ORDER BY date DESC', job.id);
      job.estimates = all(db, 'SELECT * FROM estimates WHERE job_id = ? ORDER BY id DESC', job.id).map(e => C.estimateWithTotals(db, e));
      job.invoices = all(db, 'SELECT * FROM invoices WHERE job_id = ? ORDER BY id DESC', job.id).map(i => C.invoiceWithTotals(db, i));
      job.costing = C.jobCosting(db, job.id);
      job.cost_codes = C.jobCostCodes(db, job.id);
      job.purchase_orders = all(db, 'SELECT p.*, v.name vendor_name FROM purchase_orders p JOIN vendors v ON v.id = p.vendor_id WHERE p.job_id = ? ORDER BY p.id DESC', job.id).map(H.poTotals);
    } else {
      // techs can present the job's estimates to the customer (customer-facing link only, no costs)
      job.present = all(db, "SELECT * FROM estimates WHERE job_id = ? AND status IN ('draft','sent','viewed','approved') ORDER BY id DESC", job.id).map(e => {
        const t = C.estimateWithTotals(db, e);
        return { id: e.id, review_status: e.review_status, number: e.number, title: e.title, status: e.status, change_order: e.change_order, options: t.options.length, price_min: t.price_min ?? t.total, price_max: t.price_max ?? t.total,
          url: `${baseUrl(req)}/p/estimate/${e.public_token}` };
      });
      for (const m of job.materials) delete m.unit_cost;
      for (const t of job.time) { delete t.hourly_cost; delete t.hourly_wage; }
    }
    res.json(job);
  }));
  app.post('/api/jobs', office, wrap(async (req, res) => {
    const data = jobData(req.body);
    if (!data.customer_id || !data.title) throw bad('Customer and job title are required');
    if (!data.status) data.status = data.scheduled_start ? 'scheduled' : 'unscheduled';
    if (data.status === 'on_hold') holdChange({ status: 'new' }, data, req.body, req.user);
    if (!data.billing_type) data.billing_type = data.contract_amount > 0 ? 'fixed' : 'tm';
    const id = tx(db, () => {
      const jid = insert('jobs', { ...data, number: D.nextNumber(db, 'jobs', 'J') });
      setTechs(jid, req.body.tech_ids);
      if (data.scheduled_start) H.syncSingleAppointment(jid, data.scheduled_start, data.scheduled_end, req.body.tech_ids);
      if (data.timeclock_job) TC.relink(db);
      if (data.status === 'on_hold') run(db, 'INSERT INTO job_notes (job_id, user_id, body) VALUES (?,?,?)', jid, req.user.id, `Put on hold: ${data.hold_reason} — follow up ${data.hold_follow_up} (${(get(db, 'SELECT name FROM users WHERE id = ?', data.hold_assignee) || {}).name || ''})`);
      return jid;
    });
    const invite = data.status === 'on_hold' && req.body.hold_invite !== false ? await holdInvite(id, false) : null;
    res.json({ id, invite });
  }));
  // job numbering (Settings → Job numbers): what the next new job will be, and dropping an old prefix from existing jobs
  const prefixPlan = prefix => {
    const rows = all(db, 'SELECT id, number FROM jobs WHERE substr(number, 1, ?) = ? AND length(number) > ?', prefix.length, prefix, prefix.length);
    const out = { change: [], clash: [] };
    for (const r of rows) {
      const plain = r.number.slice(prefix.length);
      const other = get(db, 'SELECT number FROM jobs WHERE lower(number) = lower(?) AND id != ?', plain, r.id);
      (other ? out.clash : out.change).push({ id: r.id, from: r.number, to: plain, ...(other ? { taken_by: other.number } : {}) });
    }
    return out;
  };
  app.get('/api/settings/job-numbers', wrap((req, res) => {
    if (req.user.role !== 'admin') throw bad('Admins only', 403);
    const s = D.settings(db), prefix = s.job_number_prefix == null ? 'J-' : s.job_number_prefix;
    const plan = prefixPlan('J-');
    res.json({ prefix, next: D.nextJobNumber(db), next_floor: s.job_number_next || '', with_j_prefix: plan.change.length + plan.clash.length, clashes: plan.clash.slice(0, 20), clash_count: plan.clash.length });
  }));
  app.post('/api/jobs/remove-prefix', wrap((req, res) => {
    if (req.user.role !== 'admin') throw bad('Only an admin can renumber jobs', 403);
    const prefix = String((req.body || {}).prefix ?? 'J-');
    if (!prefix || prefix.length > 10) throw bad('Which prefix should come off?');
    const plan = prefixPlan(prefix);
    if (req.body.dry_run) return res.json({ would_change: plan.change.length, clashes: plan.clash });
    for (const c of plan.change) {
      update('jobs', c.id, { number: c.to });
      insert('job_notes', { job_id: c.id, user_id: req.user.id, body: `Job number changed from ${c.from} to ${c.to} (prefix removed)` });
    }
    res.json({ changed: plan.change.length, skipped: plan.clash, next: D.nextJobNumber(db) });
  }));
  // admins can renumber a job (e.g. to match the number used on paperwork or the time clock)
  app.put('/api/jobs/:id/number', wrap((req, res) => {
    if (req.user.role !== 'admin') throw bad('Only an admin can change a job number', 403);
    const job = mustGet('jobs', req.params.id);
    const number = String((req.body || {}).number || '').trim();
    if (!number) throw bad('Enter the new job number');
    if (number.length > 30 || !/^[A-Za-z0-9][A-Za-z0-9 ._\/#-]*$/.test(number)) throw bad('Job numbers use letters, numbers, spaces and - . _ / # (30 characters at most)');
    if (number === job.number) return res.json({ ok: true, number });
    const clash = get(db, 'SELECT number FROM jobs WHERE lower(number) = lower(?) AND id != ?', number, job.id);
    if (clash) throw bad(`Job ${clash.number} already exists`);
    update('jobs', job.id, { number });
    insert('job_notes', { job_id: job.id, user_id: req.user.id, body: `Job number changed from ${job.number} to ${number}` });
    res.json({ ok: true, number, next_new_job: D.nextJobNumber(db) });
  }));
  // ---- on hold: a reason and a follow-up date are required; the follow-up goes on the schedule and, as an
  //      all-day calendar invite, to whoever put the job on hold (moved = same event updated, off hold = cancelled)
  function holdChange(job, data, body, user) {
    const reason = String(body.hold_reason ?? '').trim(), follow = String(body.hold_follow_up ?? '').trim();
    const entering = data.status === 'on_hold' && job.status !== 'on_hold';
    const leaving = data.status && data.status !== 'on_hold' && job.status === 'on_hold';
    const editing = !entering && !leaving && job.status === 'on_hold' && (body.hold_reason !== undefined || body.hold_follow_up !== undefined || body.hold_assignee !== undefined);
    if (entering || editing) {
      const r = entering ? reason : (reason || job.hold_reason || '');
      const f = entering ? follow : (follow || job.hold_follow_up || '');
      if (r.length < 3) throw bad('Give a reason for putting the job on hold');
      if (!isDay(f)) throw bad('Pick a follow-up date for the job on hold');
      if (f < today() && f !== job.hold_follow_up) throw bad('The follow-up date is in the past');
      Object.assign(data, { hold_reason: r.slice(0, 1000), hold_follow_up: f, hold_seq: (job.hold_seq || 0) + 1 });
      if (entering) Object.assign(data, { hold_at: new Date().toISOString(), hold_by: user.id });
      const who = Number(body.hold_assignee) || (entering ? 0 : job.hold_assignee) || Number(D.settings(db).hold_followup_assignee) || user.id;
      const ok = get(db, 'SELECT id, name FROM users WHERE id = ? AND active = 1', who);
      if (!ok) throw bad('Pick who follows up (an active user)');
      const reassigned = editing && ok.id !== job.hold_assignee;
      data.hold_assignee = ok.id;
      if (!job.id) return null;
      const moved = editing && f !== job.hold_follow_up, reworded = editing && r !== job.hold_reason;
      if (editing && !moved && !reworded && !reassigned) return null;
      return { note: entering ? `Put on hold: ${r} — follow up ${f} (${ok.name})` : [moved && `Follow-up moved to ${f}`, reworded && `Hold reason: ${r}`, reassigned && `Follow-up now with ${ok.name}`].filter(Boolean).join('. '),
        after: () => body.hold_invite !== false ? holdInvite(job.id, false) : null };
    }
    if (leaving) {
      Object.assign(data, { hold_reason: null, hold_follow_up: null, hold_at: null, hold_by: null, hold_assignee: null, hold_seq: (job.hold_seq || 0) + 1 });
      const was = { ...job };
      return { note: `Taken off hold (was: ${job.hold_reason || 'no reason recorded'})`, after: () => holdInvite(was.id, true, was) };
    }
    return null;
  }
  // the follow-up as an all-day calendar event (RFC 5545)
  function holdIcs(j, cancelled = false) {
    const d = String(j.hold_follow_up).replace(/-/g, ''), next = addDays(j.hold_follow_up, 1).replace(/-/g, '');
    const esc = v => String(v ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//A4YE Field Ops//Job follow-ups//EN', 'CALSCALE:GREGORIAN', `METHOD:${cancelled ? 'CANCEL' : 'PUBLISH'}`, 'BEGIN:VEVENT',
      `UID:job-hold-${j.id}@fieldops`, `SEQUENCE:${j.hold_seq || 0}`, `DTSTAMP:${stamp}`, `DTSTART;VALUE=DATE:${d}`, `DTEND;VALUE=DATE:${next}`,
      `SUMMARY:${esc(`Task: follow up on ${j.number} (on hold) — ${j.title || ''}`)}`, `DESCRIPTION:${esc(`${j.customer_name ? j.customer_name + '. ' : ''}On hold: ${j.hold_reason || ''}`)}`,
      'TRANSP:TRANSPARENT', `STATUS:${cancelled ? 'CANCELLED' : 'CONFIRMED'}`,
      ...(cancelled ? [] : ['BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${esc(`Follow up on ${j.number}`)}`, 'TRIGGER:PT8H', 'END:VALARM']),
      'END:VEVENT', 'END:VCALENDAR'].join('\r\n') + '\r\n';
  }
  async function holdInvite(jobId, cancelled, snapshot) {
    try {
      const j = snapshot ? { ...snapshot, hold_seq: (snapshot.hold_seq || 0) + 1, customer_name: (get(db, 'SELECT name FROM customers WHERE id = ?', snapshot.customer_id) || {}).name }
        : get(db, 'SELECT j.*, c.name customer_name FROM jobs j JOIN customers c ON c.id = j.customer_id WHERE j.id = ?', jobId);
      if (!j || !j.hold_follow_up || !(j.hold_assignee || j.hold_by)) return null;
      const u = get(db, 'SELECT name, email FROM users WHERE id = ?', j.hold_assignee || j.hold_by);
      if (!u || !u.email) return { status: 'no_email', name: u && u.name, error: `${(u && u.name) || 'That person'} has no email address on their user (Team)` };
      const subject = cancelled ? `Off hold: ${j.number} — follow-up cancelled` : `Follow up ${j.hold_follow_up}: ${j.number} on hold`;
      const text = cancelled ? `${j.number} ${j.title || ''} is no longer on hold, so the follow-up on ${j.hold_follow_up} is cancelled.`
        : `${j.number} ${j.title || ''}${j.customer_name ? ` (${j.customer_name})` : ''} is on hold.\n\nReason: ${j.hold_reason}\nFollow up: ${j.hold_follow_up}\n\nThe attached calendar invite puts the follow-up on your calendar.`;
      const r = await mailer.send(db, { to: u.email, subject, text, related: `job:${j.id}`,
        attachments: [{ filename: cancelled ? 'follow-up-cancelled.ics' : 'follow-up.ics', content: holdIcs(j, cancelled), contentType: `text/calendar; charset=utf-8; method=${cancelled ? 'CANCEL' : 'PUBLISH'}` }] });
      return { status: r.status, to: u.email, name: u.name, error: r.error || (r.status === 'not_configured' ? 'Email isn\'t set up (Settings → Email)' : null) };
    } catch (e) { return { status: 'failed', error: e.message }; }   // the follow-up is still on the schedule and the job
  }
  app.get('/api/jobs/:id/hold.ics', office, wrap((req, res) => {
    const j = get(db, 'SELECT j.*, c.name customer_name FROM jobs j JOIN customers c ON c.id = j.customer_id WHERE j.id = ?', +req.params.id);
    if (!j || j.status !== 'on_hold' || !j.hold_follow_up) throw bad('This job is not on hold', 404);
    res.set('Content-Type', 'text/calendar; charset=utf-8'); res.set('Content-Disposition', `attachment; filename="follow-up-${j.number}.ics"`);
    res.send(holdIcs(j));
  }));
  // on-hold follow-ups for the schedule (a date range) and the dashboard (due or overdue)
  app.get('/api/job-follow-ups', office, wrap((req, res) => {
    const from = isDay(req.query.from) ? req.query.from : '0000-01-01', to = isDay(req.query.to) ? req.query.to : '9999-12-31';
    res.json(all(db, `SELECT j.id, j.number, j.title, j.hold_reason, j.hold_follow_up, j.hold_at, j.hold_assignee, c.name customer_name, u.name hold_by_name, a.name assignee_name
      FROM jobs j JOIN customers c ON c.id = j.customer_id LEFT JOIN users u ON u.id = j.hold_by LEFT JOIN users a ON a.id = j.hold_assignee
      WHERE j.status = 'on_hold' AND j.hold_follow_up BETWEEN ? AND ? ORDER BY j.hold_follow_up, j.number`, from, to));
  }));
  app.put('/api/jobs/:id', wrap(async (req, res) => {
    const job = mustGet('jobs', req.params.id);
    let data = jobData(req.body);
    if (req.user.role === 'tech') {
      const assigned = get(db, 'SELECT 1 x FROM job_techs WHERE job_id = ? AND user_id = ?', job.id, req.user.id);
      if (!assigned) throw bad('Not assigned to this job', 403);
      data = pick(req.body, ['status', 'completion_notes']);   // + hold_reason / hold_follow_up, read by holdChange()
      if (data.status && !['dispatched', 'in_progress', 'on_hold', 'completed'].includes(data.status)) throw bad('Techs cannot set that status', 403);
      if (data.status === 'completed' && job.status !== 'completed') {
        const blockers = H.completionBlockers(job.id);
        if (blockers.length) throw bad(`Finish the required checklist(s) first: ${blockers.join(', ')}`);
      }
    }
    if (data.status === 'cancelled' && job.status !== 'cancelled') {
      if (req.user.role === 'tech') throw bad('Techs cannot cancel jobs', 403);
      delete data.status;
      tx(db, () => H.cancelJob(job, req.user, req.body.cancel_reason));
    } else if (job.status === 'cancelled' && data.status && data.status !== 'cancelled') throw bad('Reopen the job first');
    if (data.status === 'completed' && job.status !== 'completed') data.completed_at = new Date().toISOString();
    if (data.scheduled_start && job.status === 'unscheduled' && !data.status) data.status = 'scheduled';
    const hold = holdChange(job, data, req.body, req.user);
    tx(db, () => {
      update('jobs', job.id, data);
      if (hold) run(db, 'INSERT INTO job_notes (job_id, user_id, body) VALUES (?,?,?)', job.id, req.user.id, hold.note);
      if (data.timeclock_job) TC.relink(db);
      if (req.user.role !== 'tech') {
        setTechs(job.id, req.body.tech_ids);
        if (data.scheduled_start) H.syncSingleAppointment(job.id, data.scheduled_start, data.scheduled_end, req.body.tech_ids);
      }
    });
    const invite = hold ? await hold.after() : null;   // say whether the calendar invite went, so a failure isn't silent
    res.json({ ok: true, invite });
  }));
  // Cancel: the job stays on record (searchable, reportable) but leaves the board, and its open paperwork is closed out.
  H.cancelJob = (job, user, reason) => {
    if (job.status === 'cancelled') throw bad('Job is already cancelled');
    if (job.status === 'invoiced') throw bad('Job is invoiced — void its invoices first, then cancel');
    reason = String(reason || '').trim().slice(0, 500);
    const now = new Date().toISOString();
    const done = {
      visits: run(db, "UPDATE appointments SET status = 'cancelled' WHERE job_id = ? AND status NOT IN ('done','cancelled')", job.id).changes,
      estimates: run(db, "UPDATE estimates SET status = 'cancelled', cancelled_at = ?, cancel_reason = ?, review_status = CASE WHEN review_status = 'pending' THEN NULL ELSE review_status END WHERE job_id = ? AND status IN ('draft','sent','viewed')", now, 'Job cancelled', job.id).changes,
      pick_lists: run(db, "UPDATE pick_lists SET status = 'cancelled' WHERE job_id = ? AND status IN ('open','picking')", job.id).changes,
      purchase_orders: run(db, "UPDATE purchase_orders SET status = 'cancelled' WHERE job_id = ? AND status = 'draft'", job.id).changes,
    };
    run(db, "UPDATE jobs SET status = 'cancelled', cancelled_at = ?, cancel_reason = ? WHERE id = ?", now, reason || null, job.id);
    insert('job_notes', { job_id: job.id, user_id: user.id, body: `Job cancelled${reason ? `: ${reason}` : ''}` });
    // things that still need a person: money already billed and orders already with the vendor
    const warnings = [];
    const inv = get(db, "SELECT COUNT(*) n FROM invoices WHERE job_id = ? AND status != 'void'", job.id).n;
    if (inv) warnings.push(`${inv} invoice(s) are still open on this job. Void or credit them if the customer won't be paying.`);
    const po = get(db, "SELECT COUNT(*) n FROM purchase_orders WHERE job_id = ? AND status IN ('submitted','partial')", job.id).n;
    if (po) warnings.push(`${po} purchase order(s) were already sent to the vendor. Call to cancel or arrange a return.`);
    return { ...done, warnings };
  };
  app.post('/api/jobs/:id/cancel', office, wrap((req, res) => {
    const job = mustGet('jobs', req.params.id);
    res.json(tx(db, () => H.cancelJob(job, req.user, req.body.reason)));
  }));
  app.post('/api/jobs/:id/reopen', office, wrap((req, res) => {
    const job = mustGet('jobs', req.params.id);
    if (job.status !== 'cancelled') throw bad('Only cancelled jobs can be reopened');
    tx(db, () => {
      // visits and estimates stay cancelled: reschedule and re-quote deliberately rather than resurrecting stale ones
      run(db, "UPDATE jobs SET status = 'unscheduled', cancelled_at = NULL, cancel_reason = NULL WHERE id = ?", job.id);
      insert('job_notes', { job_id: job.id, user_id: req.user.id, body: 'Job reopened' });
    });
    res.json({ ok: true });
  }));
  // Delete: only for jobs entered by mistake. Anything with money, hours or a customer signature attached must be cancelled instead.
  H.jobDeleteBlockers = id => {
    const n = sql => get(db, sql, id).n;
    const why = [
      [n('SELECT COUNT(*) n FROM invoices WHERE job_id = ?'), 'invoice(s)'],
      [n('SELECT COUNT(*) n FROM time_entries WHERE job_id = ?'), 'time entr(ies)'],
      [n('SELECT COUNT(*) n FROM job_materials WHERE job_id = ?'), 'material line(s)'],
      [n('SELECT COUNT(*) n FROM expenses WHERE job_id = ?'), 'expense(s)'],
      [n('SELECT COUNT(*) n FROM purchase_orders WHERE job_id = ?'), 'purchase order(s)'],
      [n('SELECT COUNT(*) n FROM bill_lines WHERE job_id = ?'), 'vendor bill line(s)'],
      [n('SELECT COUNT(*) n FROM journal_lines WHERE job_id = ?'), 'accounting entr(ies)'],
      [n("SELECT COUNT(*) n FROM attachments WHERE entity_type = 'job' AND entity_id = ? AND kind = 'signature'"), 'customer signature(s)'],
    ];
    return why.filter(([c]) => c).map(([c, l]) => `${c} ${l}`);
  };
  app.delete('/api/jobs/:id', admin, wrap((req, res) => {
    const job = mustGet('jobs', req.params.id);
    const blockers = H.jobDeleteBlockers(job.id);
    if (blockers.length) throw bad(`This job has ${blockers.join(', ')}. Cancel it instead, so the history is kept.`);
    const files = all(db, "SELECT path FROM attachments WHERE entity_type = 'job' AND entity_id = ?", job.id).map(a => a.path);
    tx(db, () => {
      run(db, 'UPDATE estimates SET job_id = NULL WHERE job_id = ?', job.id);
      run(db, "DELETE FROM attachments WHERE entity_type = 'job' AND entity_id = ?", job.id);
      run(db, 'DELETE FROM jobs WHERE id = ?', job.id);
    });
    for (const f of files) H.removeUpload(f);
    res.json({ ok: true, files: files.length });
  }));
  app.post('/api/jobs/:id/notes', wrap((req, res) => {
    if (!req.body.body) throw bad('Note is empty');
    res.json({ id: insert('job_notes', { job_id: Number(req.params.id), user_id: req.user.id, body: req.body.body }) });
  }));

  // job materials (techs can log what they used)
  app.post('/api/jobs/:id/materials', wrap((req, res) => {
    const job = mustGet('jobs', req.params.id);
    const b = req.body;
    let data = { job_id: job.id, user_id: req.user.id, qty: Number(b.qty) || 1, billable: b.billable === undefined ? 1 : (b.billable ? 1 : 0),
      source: b.source || 'stock', used_on: b.used_on || today(), cost_code_id: b.cost_code_id || null };
    if (b.pricebook_id) {
      const pb = mustGet('pricebook', b.pricebook_id);
      Object.assign(data, { pricebook_id: pb.id, description: b.description || pb.name, unit_cost: pb.unit_cost, unit_price: pb.unit_price });
      if (!data.cost_code_id) data.cost_code_id = pb.cost_code_id || null;
      if (req.user.role !== 'tech' && b.unit_cost != null && b.unit_cost !== '' && Number.isFinite(Number(b.unit_cost))) data.unit_cost = Number(b.unit_cost); // blank = price book cost
      if ((data.source === 'stock')) run(db, 'UPDATE pricebook SET qty_on_hand = qty_on_hand - ? WHERE id = ?', data.qty, pb.id);
    } else {
      if (!b.description) throw bad('Description is required');
      Object.assign(data, { description: b.description, unit_cost: Number(b.unit_cost) || 0, unit_price: Number(b.unit_price) || 0 });
    }
    const mid = insert('job_materials', data);
    A.postJobMaterial(db, mid);
    res.json({ id: mid });
  }));
  app.delete('/api/materials/:id', office, wrap((req, res) => {
    const m = mustGet('job_materials', req.params.id);
    Bill.assertUnbilled(db, 'job_materials', m.id);
    if (m.pricebook_id && m.source === 'stock') run(db, 'UPDATE pricebook SET qty_on_hand = qty_on_hand + ? WHERE id = ?', m.qty, m.pricebook_id);
    A.unpost(db, 'job_material', m.id);
    run(db, 'DELETE FROM job_materials WHERE id = ?', m.id); res.json({ ok: true });
  }));

  // invoice a job the way it's priced: quoted jobs bill the balance of the contract, T&M jobs bill everything unbilled
  app.post('/api/jobs/:id/invoice', office, wrap((req, res) => {
    const job = mustGet('jobs', req.params.id);
    res.json({ id: job.billing_type === 'fixed' ? Bill.billFixed(db, job.id, { mode: 'final' }) : Bill.billTM(db, job.id, req.body || {}) });
  }));

  // ------------------------------------------------------------ time clock
  function loadedRate(u) { return C.r2(u.hourly_wage * (1 + (u.burden_pct || 0) / 100)); }
  // optional location from the phone; ignored unless it's a plausible coordinate
  function gps(b) {
    const lat = Number(b.lat), lng = Number(b.lng);
    const ok = Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && (lat || lng);
    return ok ? { lat, lng, acc: Number.isFinite(Number(b.acc)) ? Math.round(Number(b.acc)) : null } : { lat: null, lng: null, acc: null };
  }
  H.gps = gps;
  app.get('/api/time/status', wrap((req, res) => {
    res.json({ open: get(db, `SELECT t.*, j.number job_number, j.title job_title, cc.code cost_code, cc.name cost_code_name FROM time_entries t LEFT JOIN jobs j ON j.id = t.job_id LEFT JOIN cost_codes cc ON cc.id = t.cost_code_id WHERE t.user_id = ? AND t.clock_out IS NULL ORDER BY id DESC LIMIT 1`, req.user.id) });
  }));
  // What this person can clock into: their assigned jobs, plus open commercial projects (all of them if allowed).
  app.get('/api/time/options', wrap((req, res) => {
    const open = "j.status IN ('unscheduled','scheduled','dispatched','in_progress','on_hold')";
    const mine = all(db, `SELECT j.id, j.number, j.title, j.is_project, c.name customer_name FROM jobs j JOIN customers c ON c.id = j.customer_id
      WHERE ${open} AND EXISTS (SELECT 1 FROM job_techs jt WHERE jt.job_id = j.id AND jt.user_id = ?) ORDER BY j.scheduled_start, j.id`, req.user.id);
    const anyProject = req.user.role !== 'tech' || req.can('any_project');
    const projects = all(db, `SELECT j.id, j.number, j.title, j.is_project, c.name customer_name FROM jobs j JOIN customers c ON c.id = j.customer_id
      WHERE ${open} AND j.is_project = 1 ${anyProject ? '' : 'AND (EXISTS (SELECT 1 FROM job_techs jt WHERE jt.job_id = j.id AND jt.user_id = ?) OR j.foreman_id = ?)'} ORDER BY j.number`,
      ...(anyProject ? [] : [req.user.id, req.user.id]));
    const codes = id => all(db, 'SELECT cost_code_id FROM job_budgets WHERE job_id = ?', id).map(r => r.cost_code_id);
    res.json({ jobs: mine.filter(j => !j.is_project), projects: projects.map(p => ({ ...p, cost_code_ids: codes(p.id) })),
      require_cost_code: D.settings(db).project_require_cost_code !== '0' });
  }));
  // ---- A4Y Time Clock sync (server/timeclock.js)
  app.get('/api/timeclock/status', office, wrap((req, res) => {
    const s = D.settings(db);
    let last = null; try { last = JSON.parse(s.timeclock_last_sync || 'null'); } catch { /* none yet */ }
    res.json({ configured: !!s.timeclock_url, auto: s.timeclock_auto !== '0', timezone: s.timezone, last,
      entries: get(db, 'SELECT COUNT(*) n FROM time_entries WHERE external_id IS NOT NULL').n,
      unlinked: all(db, `SELECT ext_job, COUNT(*) n, ROUND(SUM((julianday(COALESCE(clock_out, clock_in)) - julianday(clock_in)) * 24), 1) hours FROM time_entries
        WHERE ext_job IS NOT NULL AND job_id IS NULL GROUP BY ext_job ORDER BY n DESC`) });
  }));
  app.post('/api/timeclock/sync', office, wrap(async (req, res) => res.json(await TC.pull(db, { userId: req.user.id }))));
  app.post('/api/timeclock/upload', office, wrap((req, res) => {
    const rows = require('./importer').parseRows(String(req.body.csv || ''));
    if (rows.length < 2) throw bad('That file has no rows. Download the "Time Entries" tab as CSV and try again.');
    const head = rows[0].map(h => String(h).trim());
    if (!head.some(h => /entry id/i.test(h))) throw bad('No "Entry ID" column. Use the "Time Entries" tab of the A4Y Time Clock sheet.');
    res.json(TC.ingest(db, rows.slice(1).map(r => Object.fromEntries(head.map((h, i) => [h, r[i]]))), { userId: req.user.id }));
  }));
  app.get('/api/time/clocked-in', office, wrap((req, res) => {
    res.json(all(db, `SELECT t.*, u.name user_name, j.number job_number, j.title job_title FROM time_entries t JOIN users u ON u.id = t.user_id LEFT JOIN jobs j ON j.id = t.job_id WHERE t.clock_out IS NULL ORDER BY t.clock_in`));
  }));
  app.post('/api/time/clock-in', wrap((req, res) => {
    const now = new Date().toISOString();
    const u = get(db, 'SELECT * FROM users WHERE id = ?', req.user.id);
    const kind = req.body.kind || (req.body.job_id ? 'job' : 'shop');
    const pj = req.body.job_id ? get(db, 'SELECT id, number, is_project FROM jobs WHERE id = ?', req.body.job_id) : null;
    if (req.body.job_id && !pj) throw bad('That job no longer exists');
    if (pj && pj.is_project && kind === 'job' && !req.body.cost_code_id && D.settings(db).project_require_cost_code !== '0')
      throw bad(`Pick a cost code for ${pj.number}: commercial projects track hours by cost code`);
    if (req.body.cost_code_id && !get(db, 'SELECT 1 x FROM cost_codes WHERE id = ? AND active = 1', req.body.cost_code_id)) throw bad('That cost code is not active');
    tx(db, () => {
      // switching jobs closes the open entry automatically
      const g = gps(req.body);
      run(db, 'UPDATE time_entries SET clock_out = ?, out_lat = ?, out_lng = ?, out_acc = ? WHERE user_id = ? AND clock_out IS NULL', now, g.lat, g.lng, g.acc, u.id);
      insert('time_entries', { user_id: u.id, job_id: req.body.job_id || null, kind, clock_in: now, hourly_cost: loadedRate(u), hourly_wage: u.hourly_wage, notes: req.body.notes || null,
        cost_code_id: req.body.cost_code_id || null, appointment_id: req.body.appointment_id || null, in_lat: g.lat, in_lng: g.lng, in_acc: g.acc });
      if (req.body.job_id && kind === 'job') run(db, "UPDATE jobs SET status = 'in_progress' WHERE id = ? AND status IN ('scheduled','dispatched','unscheduled')", req.body.job_id);
    });
    res.json({ ok: true });
  }));
  app.post('/api/time/clock-out', wrap((req, res) => {
    const g = gps(req.body);
    const info = run(db, 'UPDATE time_entries SET clock_out = ?, notes = COALESCE(?, notes), out_lat = ?, out_lng = ?, out_acc = ? WHERE user_id = ? AND clock_out IS NULL',
      new Date().toISOString(), req.body.notes || null, g.lat, g.lng, g.acc, req.user.id);
    if (!info.changes) throw bad('You are not clocked in');
    res.json({ ok: true });
  }));
  app.get('/api/time', wrap((req, res) => {
    const from = req.query.from || addDays(today(), -14), to = req.query.to || today();
    const userId = req.user.role === 'tech' ? req.user.id : (req.query.user_id || null);
    const rows = C.timeInRange(db, C.startOfDay(from), C.endOfDay(to), userId ? 'AND t.user_id = ?' : '', ...(userId ? [userId] : []));
    if (req.user.role === 'tech') for (const r of rows) { delete r.hourly_cost; delete r.hourly_wage; }
    res.json(rows.map(r => ({ ...r, hours: C.r2(r.hours) })).reverse());
  }));
  // everyone's week at a glance (office, managers, admins): worked, scheduled, projected, overtime flags
  app.get('/api/time/week', office, wrap((req, res) => {
    const day = /^\d{4}-\d\d-\d\d$/.test(req.query.week || '') ? req.query.week : today();
    res.json(C.weekHours(db, day));
  }));
  app.post('/api/time', office, wrap((req, res) => {
    const u = mustGet('users', req.body.user_id);
    if (!req.body.clock_in || !req.body.clock_out) throw bad('Start and end time are required');
    if (new Date(req.body.clock_out) <= new Date(req.body.clock_in)) throw bad('End must be after start');
    res.json({ id: insert('time_entries', { user_id: u.id, job_id: req.body.job_id || null, kind: req.body.kind || 'job',
      clock_in: new Date(req.body.clock_in).toISOString(), clock_out: new Date(req.body.clock_out).toISOString(),
      hourly_cost: loadedRate(u), hourly_wage: u.hourly_wage, notes: req.body.notes || null, cost_code_id: req.body.cost_code_id || null }) });
  }));
  app.put('/api/time/:id', office, wrap((req, res) => {
    Bill.assertUnbilled(db, 'time_entries', Number(req.params.id));
    const data = pick(req.body, ['job_id', 'kind', 'clock_in', 'clock_out', 'notes', 'cost_code_id', 'user_id', 'billable']);
    for (const k of ['clock_in', 'clock_out']) if (data[k]) data[k] = new Date(data[k]).toISOString();
    const te = mustGet('time_entries', req.params.id);
    if (data.user_id && Number(data.user_id) !== te.user_id) { const u = mustGet('users', data.user_id); data.hourly_cost = loadedRate(u); data.hourly_wage = u.hourly_wage; }
    update('time_entries', te.id, data); res.json({ ok: true });
  }));
  app.delete('/api/time/:id', office, wrap((req, res) => { Bill.assertUnbilled(db, 'time_entries', Number(req.params.id)); run(db, 'DELETE FROM time_entries WHERE id = ?', req.params.id); res.json({ ok: true }); }));

  // ------------------------------------------------------------ estimates
  // techs' estimate routes come first; office users fall through to the routes below
  require('./tech_estimates')(app, db, { wrap, bad, mustGet, pick, insert, update, saveItems, saveOptions, baseUrl, today, addDays, office, H });
  const DOC_FIELDS = ['customer_id', 'title', 'tax_rate', 'discount', 'notes', 'terms'];
  function saveItems(table, fk, id, items, optionIds) {
    if (!Array.isArray(items)) return;
    // someone who can't see costs never receives unit_cost, so a line without one keeps the cost it had (or the price book's)
    const prevCost = new Map(all(db, `SELECT id, unit_cost FROM ${table} WHERE ${fk} = ?`, id).map(r => [r.id, r.unit_cost]));
    const pbCost = pid => pid ? (get(db, 'SELECT unit_cost FROM pricebook WHERE id = ?', pid) || {}).unit_cost : undefined;
    run(db, `DELETE FROM ${table} WHERE ${fk} = ?`, id);
    items.forEach((it, i) => {
      if (!it.description) return;
      const option = optionIds ? (it.option_index != null && it.option_index !== '' ? optionIds[Number(it.option_index)] ?? null : null) : undefined;
      insert(table, { [fk]: id, pricebook_id: it.pricebook_id || null, description: it.description, qty: Number(it.qty) || 0,
        unit_price: Number(it.unit_price) || 0, unit_cost: it.unit_cost !== undefined ? Number(it.unit_cost) || 0 : prevCost.get(it.id) ?? pbCost(it.pricebook_id) ?? 0, taxable: it.taxable ? 1 : 0, cost_code_id: it.cost_code_id || null, sort: i,
        ...(option !== undefined ? { option_id: option } : it.option_id ? { option_id: it.option_id } : {}) });
    });
  }
  // Replace an estimate's options; returns new ids in order so items can refer to them by index.
  function saveOptions(estimateId, options) {
    if (!Array.isArray(options)) return null;
    run(db, 'DELETE FROM estimate_options WHERE estimate_id = ?', estimateId);
    if (options.length === 1) throw bad('Offer at least two options, or remove options to quote a single price');
    if (options.length > 4) throw bad('Up to four options');
    const rec = options.findIndex(o => o.recommended);
    return options.map((o, i) => insert('estimate_options', { estimate_id: estimateId, name: String(o.name || `Option ${i + 1}`).slice(0, 60),
      description: o.description || null, recommended: i === (rec < 0 ? Math.min(1, options.length - 1) : rec) ? 1 : 0, sort: i }));
  }
  app.get('/api/estimates', office, wrap((req, res) => {
    const p = [], where = [];
    if (req.query.status === 'review') where.push("e.review_status = 'pending'");
    else if (req.query.status) { where.push(`e.status IN (${req.query.status.split(',').map(() => '?').join(',')})`); p.push(...req.query.status.split(',')); }
    words(req.query.q, ['e.number', 'e.title', 'c.name', 'c.company', 'j.number'], where, p);
    if (isDay(req.query.from)) { where.push('e.created_at >= ?'); p.push(req.query.from); }
    if (isDay(req.query.to)) { where.push("e.created_at < date(?, '+1 day')"); p.push(req.query.to); }
    if (req.query.created_by) { where.push('e.created_by = ?'); p.push(req.query.created_by); }
    const rows = all(db, `SELECT e.*, c.name customer_name, c.type customer_type, j.number job_number FROM estimates e JOIN customers c ON c.id = e.customer_id
      LEFT JOIN jobs j ON j.id = e.job_id ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY e.id DESC`, ...p).map(e => C.estimateWithTotals(db, e));
    pageOut(res, req.query, rows, {
      number: e => e.number, created: e => e.created_at, customer: e => e.customer_name, title: e => e.title || '', status: e => e.status,
      total: e => e.total, margin: e => e.est_margin_pct ?? -1e9 }, 'created', { total: rows.reduce((s, e) => s + (e.total || 0), 0) });
  }));
  app.get('/api/estimates/:id', office, wrap((req, res) => {
    const e = C.estimateWithTotals(db, mustGet('estimates', req.params.id));
    e.customer = get(db, 'SELECT * FROM customers WHERE id = ?', e.customer_id);
    e.public_url = `${baseUrl(req)}/p/estimate/${e.public_token}`;
    e.visits = H.appointments('a.estimate_id = ?', [e.id]);
    res.json(e);
  }));
  app.post('/api/estimates', office, wrap((req, res) => {
    const s = D.settings(db);
    const b = req.body;
    if (!b.customer_id) throw bad('Customer is required');
    const cust = mustGet('customers', b.customer_id);
    const forJob = b.job_id ? get(db, 'SELECT * FROM jobs WHERE id = ?', b.job_id) : null;
    const changeOrder = b.change_order != null ? (b.change_order ? 1 : 0)
      : forJob && forJob.billing_type === 'fixed' && (forJob.contract_amount > 0 || get(db, "SELECT 1 x FROM estimates WHERE job_id = ? AND status = 'approved'", forJob.id)) ? 1 : 0;
    const id = tx(db, () => {
      const eid = insert('estimates', {
        ...pick(b, DOC_FIELDS), location_id: b.location_id || null, job_id: b.job_id || null, change_order: changeOrder,
        number: D.nextNumber(db, 'estimates', 'EST'), public_token: D.token(), created_by: req.user.id,
        tax_rate: b.tax_rate ?? (cust.tax_exempt ? 0 : Number(s.default_tax_rate)), terms: b.terms ?? s.estimate_terms,
        valid_until: b.valid_until || addDays(today(), Number(s.estimate_valid_days) || 30),
      });
      saveItems('estimate_items', 'estimate_id', eid, b.items, saveOptions(eid, b.options) || []);
      return eid;
    });
    res.json({ id });
  }));
  app.put('/api/estimates/:id', office, wrap((req, res) => {
    const e = mustGet('estimates', req.params.id);
    if (e.status === 'cancelled') throw bad('Estimate is cancelled — reopen it to make changes');
    if (req.body.status === 'cancelled') throw bad('Use Cancel estimate');
    if (e.status === 'approved' && req.body.items) throw bad('Approved estimates cannot be edited — create a change order (new estimate) instead');
    if (req.body.options && e.status === 'approved') throw bad('Approved estimates cannot be edited');
    tx(db, () => {
      update('estimates', e.id, { ...pick(req.body, [...DOC_FIELDS, 'valid_until', 'location_id', 'job_id']), ...(req.body.status ? { status: req.body.status } : {}) });
      if (req.body.items) saveItems('estimate_items', 'estimate_id', e.id, req.body.items, saveOptions(e.id, req.body.options) || (req.body.options ? [] : undefined));
      // approving an estimate with options records which option the customer chose
      if (req.body.status === 'approved') {
        if (e.review_status === 'pending') run(db, "UPDATE estimates SET review_status = 'approved', reviewed_by = ?, reviewed_at = datetime('now') WHERE id = ?", req.user.id, e.id);
        const opts = all(db, 'SELECT id FROM estimate_options WHERE estimate_id = ?', e.id).map(o => o.id);
        if (opts.length) {
          const pickId = Number(req.body.approved_option_id);
          if (!opts.includes(pickId)) throw bad('Choose which option the customer approved');
          run(db, "UPDATE estimates SET approved_option_id = ?, approved_at = COALESCE(approved_at, datetime('now')) WHERE id = ?", pickId, e.id);
        } else run(db, "UPDATE estimates SET approved_at = COALESCE(approved_at, datetime('now')) WHERE id = ?", e.id);
      }
    });
    res.json({ ok: true });
  }));
  app.delete('/api/estimates/:id', office, wrap((req, res) => {
    const e = mustGet('estimates', req.params.id);
    if (e.status === 'approved') throw bad('Approved estimates cannot be deleted. Cancel it instead, so the signed record is kept.');
    tx(db, () => {
      run(db, 'UPDATE invoices SET estimate_id = NULL WHERE estimate_id = ?', e.id);
      run(db, 'DELETE FROM estimates WHERE id = ?', e.id);
    });
    res.json({ ok: true });
  }));
  // Cancel: withdrawn by us (customer changed plans, duplicate, re-quoted). Unlike "declined", it doesn't count as a lost sale,
  // and the customer link stops accepting a signature.
  app.post('/api/estimates/:id/cancel', office, wrap((req, res) => {
    const e = mustGet('estimates', req.params.id);
    if (e.status === 'cancelled') throw bad('Estimate is already cancelled');
    const inv = get(db, "SELECT COUNT(*) n FROM invoices WHERE estimate_id = ? AND status != 'void'", e.id).n;
    if (inv) throw bad(`This estimate has ${inv} invoice(s) made from it. Void them first.`);
    const reason = String(req.body.reason || '').trim().slice(0, 500) || null;
    tx(db, () => {
      run(db, "UPDATE estimates SET status = 'cancelled', cancelled_at = datetime('now'), cancel_reason = ?, review_status = CASE WHEN review_status = 'pending' THEN NULL ELSE review_status END WHERE id = ?", reason, e.id);
      run(db, "UPDATE appointments SET status = 'cancelled' WHERE estimate_id = ? AND status NOT IN ('done','cancelled')", e.id);
      if (e.job_id) insert('job_notes', { job_id: e.job_id, user_id: req.user.id, body: `${e.change_order ? 'Change order' : 'Estimate'} ${e.number} cancelled${e.status === 'approved' ? ' (it had been approved)' : ''}${reason ? `: ${reason}` : ''}` });
    });
    res.json({ ok: true, was_approved: e.status === 'approved' });
  }));
  app.post('/api/estimates/:id/reopen', office, wrap((req, res) => {
    const e = mustGet('estimates', req.params.id);
    if (e.status !== 'cancelled') throw bad('Only cancelled estimates can be reopened');
    // back to draft: a fresh signature is needed, so any earlier approval is cleared
    run(db, "UPDATE estimates SET status = 'draft', cancelled_at = NULL, cancel_reason = NULL, approved_at = NULL, approved_option_id = NULL, signature_name = NULL WHERE id = ?", e.id);
    res.json({ ok: true });
  }));
  // the email as it will go out (Send window shows it, editable)
  const ET = require('./email_templates');
  function estimateEmail(req, e, cust, edit) {
    const vars = { ...ET.baseVars(db, cust, req.body && req.body.message), estimate_number: e.number, estimate_title: e.title || '', estimate_total: ET.usd(e.total),
      valid_until: ET.fmtDate(e.valid_until), link: `${baseUrl(req)}/p/estimate/${e.public_token}` };
    return { ...ET.render(db, 'estimate', vars, edit), url: vars.link };
  }
  app.get('/api/estimates/:id/email', office, wrap((req, res) => {
    const e = C.estimateWithTotals(db, mustGet('estimates', req.params.id)), cust = mustGet('customers', e.customer_id);
    const m = estimateEmail(req, e, cust);
    res.json({ to: cust.email || '', subject: m.subject, body: m.text, url: m.url, smtp: mailer.configured(db) });
  }));
  app.post('/api/estimates/:id/send', office, wrap(async (req, res) => {
    const e = C.estimateWithTotals(db, mustGet('estimates', req.params.id));
    if (e.status === 'cancelled') throw bad('Estimate is cancelled — reopen it first');
    const cust = mustGet('customers', e.customer_id);
    const to = req.body.to || cust.email;
    if (!to) throw bad('Customer has no email address');
    const m = estimateEmail(req, e, cust, { subject: req.body.subject, body: req.body.body }), url = m.url;
    const r = await mailer.send(db, { to, related: `estimate:${e.id}`, subject: m.subject, text: m.text, html: m.html });
    if (e.status === 'draft') run(db, "UPDATE estimates SET status = 'sent', sent_at = datetime('now') WHERE id = ?", e.id);
    if (e.review_status === 'pending') run(db, "UPDATE estimates SET review_status = 'approved', reviewed_by = ?, reviewed_at = datetime('now') WHERE id = ?", req.user.id, e.id);
    res.json({ ...r, url, subject: m.subject, text: m.text });
  }));
  // approved estimate -> job (book the work)
  app.post('/api/estimates/:id/convert-to-job', office, wrap((req, res) => {
    const e = C.estimateWithTotals(db, mustGet('estimates', req.params.id));
    if (e.status === 'cancelled') throw bad('Estimate is cancelled');
    if (e.job_id) return res.json({ id: e.job_id });
    if (e.options.length && !e.approved_option_id) throw bad('Record which option the customer chose (approve the estimate) before converting');
    const labor = e.chosen_items.reduce((s, it) => {
      const pb = it.pricebook_id ? get(db, 'SELECT labor_hours, kind FROM pricebook WHERE id = ?', it.pricebook_id) : null;
      return s + (pb ? pb.labor_hours * it.qty : 0);
    }, 0);
    const mats = e.chosen_items.reduce((s, it) => {
      const pb = it.pricebook_id ? get(db, 'SELECT kind FROM pricebook WHERE id = ?', it.pricebook_id) : null;
      return s + (pb && pb.kind === 'material' ? it.unit_cost * it.qty : 0);
    }, 0);
    const id = tx(db, () => {
      const jid = insert('jobs', { number: D.nextNumber(db, 'jobs', 'J'), customer_id: e.customer_id, location_id: e.location_id, title: e.title || `Work per ${e.number}`,
        description: e.notes, job_type: req.body.job_type || 'install', status: 'unscheduled', contract_amount: C.r2(e.subtotal - e.discount), billing_type: 'fixed',
        budget_hours: labor ? C.r2(labor) : null, budget_materials: mats ? C.r2(mats) : null });
      run(db, 'UPDATE estimates SET job_id = ? WHERE id = ?', jid, e.id);
      H.budgetsFromEstimate(jid, e.id);
      return jid;
    });
    res.json({ id });
  }));
  app.post('/api/estimates/:id/convert-to-invoice', office, wrap((req, res) => {
    const e = mustGet('estimates', req.params.id);
    if (e.status === 'cancelled') throw bad('Estimate is cancelled');
    const s = D.settings(db);
    const cust = mustGet('customers', e.customer_id);
    const id = tx(db, () => {
      const iid = insert('invoices', { number: D.nextNumber(db, 'invoices', 'INV'), customer_id: e.customer_id, job_id: e.job_id, estimate_id: e.id, title: e.title,
        issue_date: today(), due_date: addDays(today(), cust.payment_terms_days ?? Number(s.invoice_terms_days)), tax_rate: e.tax_rate, discount: e.discount,
        notes: e.notes, terms: s.invoice_terms, public_token: D.token() });
      if (all(db, 'SELECT 1 FROM estimate_options WHERE estimate_id = ?', e.id).length && !e.approved_option_id) throw bad('Record which option the customer chose before invoicing');
      C.estimateChosenItems(db, e.id).forEach((it, i) =>
        insert('invoice_items', { invoice_id: iid, pricebook_id: it.pricebook_id, description: it.description, qty: it.qty, unit_price: it.unit_price, unit_cost: it.unit_cost, taxable: it.taxable, cost_code_id: it.cost_code_id, sort: i }));
      return iid;
    });
    res.json({ id });
  }));

  // ------------------------------------------------------------ invoices & payments
  app.get('/api/invoices', office, wrap((req, res) => {
    const p = [], where = [];
    if (req.query.status) { where.push(`i.status IN (${req.query.status.split(',').map(() => '?').join(',')})`); p.push(...req.query.status.split(',')); }
    words(req.query.q, ['i.number', 'c.name', 'c.company', 'j.number', 'j.title'], where, p);
    if (isDay(req.query.from)) { where.push('i.issue_date >= ?'); p.push(req.query.from); }
    if (isDay(req.query.to)) { where.push('i.issue_date <= ?'); p.push(req.query.to); }
    if (req.query.overdue) { where.push("i.status IN ('sent','partial') AND i.due_date < ?"); p.push(today()); }
    const rows = all(db, `SELECT i.*, c.name customer_name, j.number job_number FROM invoices i JOIN customers c ON c.id = i.customer_id LEFT JOIN jobs j ON j.id = i.job_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY i.id DESC`, ...p).map(i => C.invoiceWithTotals(db, i));
    pageOut(res, req.query, rows, {
      number: i => i.number, issued: i => i.issue_date || '', due: i => i.due_date || '', customer: i => i.customer_name, job: i => i.job_number || '',
      status: i => i.status, total: i => i.total, balance: i => i.balance }, 'issued',
      { total: rows.reduce((s, i) => s + (i.total || 0), 0), balance: rows.reduce((s, i) => s + (i.balance || 0), 0) });
  }));
  app.get('/api/invoices/:id', office, wrap((req, res) => {
    const i = C.invoiceWithTotals(db, mustGet('invoices', req.params.id));
    i.customer = get(db, 'SELECT * FROM customers WHERE id = ?', i.customer_id);
    i.public_url = `${baseUrl(req)}/p/invoice/${i.public_token}`;
    res.json(i);
  }));
  app.post('/api/invoices', office, wrap((req, res) => {
    const s = D.settings(db);
    const b = req.body;
    if (!b.customer_id) throw bad('Customer is required');
    const cust = mustGet('customers', b.customer_id);
    const id = tx(db, () => {
      const iid = insert('invoices', { ...pick(b, DOC_FIELDS), job_id: b.job_id || null, number: D.nextNumber(db, 'invoices', 'INV'), public_token: D.token(),
        issue_date: b.issue_date || today(), due_date: b.due_date || addDays(b.issue_date || today(), cust.payment_terms_days ?? Number(s.invoice_terms_days)),
        tax_rate: b.tax_rate ?? (cust.tax_exempt ? 0 : Number(s.default_tax_rate)), terms: b.terms ?? s.invoice_terms });
      saveItems('invoice_items', 'invoice_id', iid, b.items);
      return iid;
    });
    res.json({ id });
  }));
  app.put('/api/invoices/:id', office, wrap((req, res) => {
    const inv = mustGet('invoices', req.params.id);
    if (inv.status === 'void') throw bad('Voided invoices cannot be edited');
    if (req.body.items && get(db, 'SELECT COUNT(*) n FROM payments WHERE invoice_id = ?', inv.id).n) throw bad('Invoice has payments — remove them before changing line items');
    tx(db, () => {
      update('invoices', inv.id, pick(req.body, [...DOC_FIELDS, 'issue_date', 'due_date', 'job_id']));
      saveItems('invoice_items', 'invoice_id', inv.id, req.body.items);
      if (req.body.status === 'void') { run(db, "UPDATE invoices SET status = 'void' WHERE id = ?", inv.id); Bill.releaseInvoice(db, inv.id); }
    });
    C.refreshInvoiceStatus(db, inv.id);
    A.postInvoice(db, inv.id);
    res.json({ ok: true });
  }));
  app.delete('/api/invoices/:id', admin, wrap((req, res) => {
    const inv = mustGet('invoices', req.params.id);
    if (inv.status !== 'draft') throw bad('Only drafts can be deleted — void it instead');
    Bill.releaseInvoice(db, inv.id);
    run(db, 'DELETE FROM invoices WHERE id = ?', inv.id); res.json({ ok: true });
  }));
  function invoiceEmail(req, inv, cust, edit) {
    const job = inv.job_id ? get(db, 'SELECT title FROM jobs WHERE id = ?', inv.job_id) : null;
    const vars = { ...ET.baseVars(db, cust, req.body && req.body.message), invoice_number: inv.number, invoice_total: ET.usd(inv.total), amount_due: ET.usd(inv.balance),
      due_date: ET.fmtDate(inv.due_date) || 'on receipt', job_title: (job && job.title) || '', link: `${baseUrl(req)}/p/invoice/${inv.public_token}` };
    return { ...ET.render(db, 'invoice', vars, edit), url: vars.link };
  }
  app.get('/api/invoices/:id/email', office, wrap((req, res) => {
    const inv = C.invoiceWithTotals(db, mustGet('invoices', req.params.id)), cust = mustGet('customers', inv.customer_id);
    const m = invoiceEmail(req, inv, cust);
    res.json({ to: cust.email || '', subject: m.subject, body: m.text, url: m.url, smtp: mailer.configured(db) });
  }));
  app.post('/api/invoices/:id/send', office, wrap(async (req, res) => {
    const inv = C.invoiceWithTotals(db, mustGet('invoices', req.params.id));
    if (inv.status === 'void') throw bad('Invoice is void');
    const cust = mustGet('customers', inv.customer_id);
    const to = req.body.to || cust.email;
    if (!to) throw bad('Customer has no email address');
    tx(db, () => {
      if (inv.status === 'draft') run(db, "UPDATE invoices SET status = 'sent', sent_at = datetime('now') WHERE id = ?", inv.id);
      C.refreshInvoiceStatus(db, inv.id);
      A.postInvoice(db, inv.id);
    });
    const m = invoiceEmail(req, C.invoiceWithTotals(db, mustGet('invoices', inv.id)), cust, { subject: req.body.subject, body: req.body.body }), url = m.url;
    const r = await mailer.send(db, { to, related: `invoice:${inv.id}`, subject: m.subject, text: m.text, html: m.html });
    res.json({ ...r, url, subject: m.subject, text: m.text });
  }));
  app.post('/api/invoices/:id/payments', office, wrap((req, res) => {
    const inv = mustGet('invoices', req.params.id);
    if (inv.status === 'void') throw bad('Invoice is void');
    const amount = Number(req.body.amount);
    if (!(amount > 0)) throw bad('Amount must be greater than zero');
    if (inv.status === 'draft') run(db, "UPDATE invoices SET status = 'sent', sent_at = COALESCE(sent_at, datetime('now')) WHERE id = ?", inv.id);
    const id = insert('payments', { invoice_id: inv.id, amount, method: req.body.method || 'check', reference: req.body.reference || null, paid_at: req.body.paid_at || today(),
      deposit_account_id: req.body.deposit_account_id || null });
    C.refreshInvoiceStatus(db, inv.id);
    A.postInvoice(db, inv.id);
    A.postPayment(db, id);
    res.json({ id });
  }));
  app.delete('/api/payments/:id', admin, wrap((req, res) => {
    const p = mustGet('payments', req.params.id);
    A.unpost(db, 'payment', p.id);
    run(db, 'DELETE FROM payments WHERE id = ?', p.id); C.refreshInvoiceStatus(db, p.invoice_id); res.json({ ok: true });
  }));

  // ------------------------------------------------------------ expenses, permits, agreements
  const EXP_FIELDS = ['date', 'category', 'vendor', 'description', 'amount', 'job_id', 'cost_code_id', 'account_id', 'paid_from_account_id', 'billable'];
  app.get('/api/expenses', office, wrap((req, res) => {
    const from = req.query.from || '0000', to = req.query.to || '9999';
    res.json(all(db, 'SELECT e.*, j.number job_number, cc.code cost_code, a.number account_number, a.name account_name FROM expenses e LEFT JOIN jobs j ON j.id = e.job_id LEFT JOIN cost_codes cc ON cc.id = e.cost_code_id LEFT JOIN accounts a ON a.id = e.account_id WHERE e.date >= ? AND e.date <= ? ORDER BY e.date DESC, e.id DESC LIMIT 1000', from, to));
  }));
  app.post('/api/expenses', office, wrap((req, res) => {
    if (!req.body.category || !(Number(req.body.amount) > 0)) throw bad('Category and a positive amount are required');
    const id = insert('expenses', pick(req.body, EXP_FIELDS));
    A.postExpense(db, id);
    res.json({ id });
  }));
  app.put('/api/expenses/:id', office, wrap((req, res) => {
    const e = mustGet('expenses', req.params.id);
    A.assertOpen(db, e.date);
    Bill.assertUnbilled(db, 'expenses', e.id);
    update('expenses', e.id, pick(req.body, EXP_FIELDS)); A.postExpense(db, e.id); res.json({ ok: true });
  }));
  app.delete('/api/expenses/:id', office, wrap((req, res) => { Bill.assertUnbilled(db, 'expenses', Number(req.params.id)); A.unpost(db, 'expense', Number(req.params.id)); run(db, 'DELETE FROM expenses WHERE id = ?', req.params.id); res.json({ ok: true }); }));

  const PERMIT_FIELDS = ['job_id', 'permit_number', 'jurisdiction', 'permit_type', 'status', 'applied_date', 'issued_date', 'inspection_date', 'expires_date', 'fee', 'inspector', 'notes'];
  app.get('/api/permits', wrap((req, res) => {
    res.json(all(db, `SELECT p.*, j.number job_number, j.title job_title, c.name customer_name, l.address FROM permits p JOIN jobs j ON j.id = p.job_id
      JOIN customers c ON c.id = j.customer_id LEFT JOIN locations l ON l.id = j.location_id
      ${req.query.open ? "WHERE p.status NOT IN ('passed','closed')" : ''} ORDER BY COALESCE(p.inspection_date, '9999'), p.id DESC`));
  }));
  app.post('/api/permits', office, wrap((req, res) => { if (!req.body.job_id) throw bad('Job is required'); res.json({ id: insert('permits', pick(req.body, PERMIT_FIELDS)) }); }));
  app.put('/api/permits/:id', office, wrap((req, res) => { update('permits', req.params.id, pick(req.body, PERMIT_FIELDS)); res.json({ ok: true }); }));
  app.delete('/api/permits/:id', office, wrap((req, res) => { run(db, 'DELETE FROM permits WHERE id = ?', req.params.id); res.json({ ok: true }); }));

  const AGR_FIELDS = ['customer_id', 'location_id', 'name', 'price', 'billing_frequency', 'visits_per_year', 'start_date', 'end_date', 'next_visit', 'status', 'notes'];
  app.get('/api/agreements', office, wrap((req, res) => {
    res.json(all(db, `SELECT a.*, c.name customer_name, l.address FROM agreements a JOIN customers c ON c.id = a.customer_id LEFT JOIN locations l ON l.id = a.location_id ORDER BY a.status, COALESCE(a.next_visit, '9999')`));
  }));
  app.post('/api/agreements', office, wrap((req, res) => { if (!req.body.customer_id || !req.body.name) throw bad('Customer and name are required'); res.json({ id: insert('agreements', pick(req.body, AGR_FIELDS)) }); }));
  app.put('/api/agreements/:id', office, wrap((req, res) => { update('agreements', req.params.id, pick(req.body, AGR_FIELDS)); res.json({ ok: true }); }));
  // schedule the next maintenance visit as a job and advance next_visit
  app.post('/api/agreements/:id/create-visit', office, wrap((req, res) => {
    const a = mustGet('agreements', req.params.id);
    const id = tx(db, () => {
      const jid = insert('jobs', { number: D.nextNumber(db, 'jobs', 'J'), customer_id: a.customer_id, location_id: a.location_id, title: `${a.name} — maintenance visit`,
        job_type: 'maintenance', status: 'unscheduled', description: a.notes });
      const months = Math.max(1, Math.round(12 / Math.max(1, a.visits_per_year)));
      const base = a.next_visit || today();
      const d = new Date(base + 'T00:00:00'); d.setMonth(d.getMonth() + months);
      run(db, 'UPDATE agreements SET next_visit = ? WHERE id = ?', d.toISOString().slice(0, 10), a.id);
      return jid;
    });
    res.json({ id });
  }));

  app.get('/api/outbox', office, wrap((req, res) => res.json(all(db, 'SELECT * FROM outbox ORDER BY id DESC LIMIT 200'))));

  // ------------------------------------------------------------ communication log
  // Emails the app sent (outbox, matched by its related key) plus calls/texts/meetings logged by hand,
  // for one customer (everything on their jobs, estimates and invoices too), job, estimate or bid.
  // The office sees it all; a tech sees and logs calls on jobs they're assigned to (no emails).
  const COMM_KINDS = ['call', 'text', 'email', 'meeting'];
  function commScope(q, user) {
    const n = k => (q[k] != null && q[k] !== '' ? Number(q[k]) : null);
    const s = { customer_id: n('customer_id'), job_id: n('job_id'), estimate_id: n('estimate_id'), bid_id: n('bid_id') };
    const set = Object.entries(s).filter(([, v]) => v != null);
    if (set.length !== 1 || !Number.isInteger(set[0][1])) throw bad('Say which customer, job, estimate or bid');
    const isOff = ['admin', 'manager', 'office'].includes(user.role);
    if (!isOff) {
      if (!s.job_id || !get(db, 'SELECT 1 FROM job_techs WHERE job_id = ? AND user_id = ?', s.job_id, user.id)) throw bad('Not assigned to this job', 403);
    }
    const exists = { customer_id: 'customers', job_id: 'jobs', estimate_id: 'estimates', bid_id: 'bids' }[set[0][0]];
    if (!get(db, `SELECT 1 FROM ${exists} WHERE id = ?`, set[0][1])) throw bad('Not found', 404);
    return { ...s, key: set[0][0], id: set[0][1], office: isOff };
  }
  function commEmails(sc) {
    const id = sc.id;
    let keys;   // SQL that yields the outbox.related values belonging to this record
    if (sc.key === 'customer_id') keys = [`SELECT 'job:' || id FROM jobs WHERE customer_id = ${id}`, `SELECT 'estimate:' || id FROM estimates WHERE customer_id = ${id}`,
      `SELECT 'invoice:' || id FROM invoices WHERE customer_id = ${id}`, `SELECT 'appointment:' || a.id FROM appointments a JOIN jobs j ON j.id = a.job_id WHERE j.customer_id = ${id}`,
      `SELECT 'report:' || r.id FROM project_reports r JOIN jobs j ON j.id = r.job_id WHERE j.customer_id = ${id}`];
    else if (sc.key === 'job_id') keys = [`SELECT 'job:${id}'`, `SELECT 'estimate:' || id FROM estimates WHERE job_id = ${id}`, `SELECT 'invoice:' || id FROM invoices WHERE job_id = ${id}`,
      `SELECT 'appointment:' || id FROM appointments WHERE job_id = ${id}`, `SELECT 'report:' || id FROM project_reports WHERE job_id = ${id}`];
    else if (sc.key === 'estimate_id') keys = [`SELECT 'estimate:${id}'`];
    else keys = [`SELECT 'bid:${id}'`];
    const staff = new Set(all(db, 'SELECT lower(email) e FROM users WHERE email IS NOT NULL').map(r => r.e));
    return all(db, `SELECT id, to_email, subject, body, status, error, related, created_at FROM outbox WHERE related IN (${keys.join(' UNION ALL ')}) ORDER BY id DESC LIMIT 300`)
      .map(o => ({ type: 'email', id: o.id, at: o.created_at.replace(' ', 'T') + 'Z', direction: 'out', to: o.to_email, subject: o.subject, body: o.body, status: o.status, error: o.error, related: o.related,
        internal: String(o.to_email).split(/,\s*/).every(a => staff.has(a.trim().toLowerCase())) }));
  }
  function commLogs(sc) {
    const where = sc.key === 'customer_id' ? 'l.customer_id = ?' : `l.${sc.key} = ?`;
    return all(db, `SELECT l.*, u.name user_name, j.number job_number, e.number estimate_number, b.project_name bid_name FROM comm_log l
      LEFT JOIN users u ON u.id = l.user_id LEFT JOIN jobs j ON j.id = l.job_id LEFT JOIN estimates e ON e.id = l.estimate_id LEFT JOIN bids b ON b.id = l.bid_id
      WHERE ${where} ORDER BY l.occurred_at DESC, l.id DESC LIMIT 300`, sc.id).map(l => ({ type: 'log', ...l, at: l.occurred_at }));
  }
  app.get('/api/comms', wrap((req, res) => {
    const sc = commScope(req.query, req.user);
    const items = [...(sc.office ? commEmails(sc) : []), ...commLogs(sc)].sort((a, b) => String(b.at).localeCompare(String(a.at)));
    res.json({ items, emails: sc.office });
  }));
  function commData(body, prev) {
    const d = pick(body, ['kind', 'direction', 'contact', 'phone', 'outcome', 'body', 'duration_min', 'occurred_at']);
    if (d.kind !== undefined && !COMM_KINDS.includes(d.kind)) throw bad('Pick call, text, email or meeting');
    if (d.direction !== undefined && !['in', 'out'].includes(d.direction)) throw bad('Incoming or outgoing?');
    for (const k of ['contact', 'phone', 'outcome']) if (d[k] !== undefined) d[k] = String(d[k] ?? '').trim().slice(0, 200) || null;
    if (d.body !== undefined) d.body = String(d.body ?? '').trim().slice(0, 5000) || null;
    if (d.duration_min !== undefined) { const m = Math.round(Number(d.duration_min)); d.duration_min = d.duration_min === '' || d.duration_min == null || !Number.isFinite(m) || m < 0 ? null : Math.min(m, 1440); }
    if (d.occurred_at !== undefined) { const t = new Date(d.occurred_at); if (!d.occurred_at || isNaN(t)) throw bad('When was it?'); if (t > new Date(Date.now() + 5 * 60e3)) throw bad('That time is in the future'); d.occurred_at = t.toISOString(); }
    const m = { ...prev, ...d };
    if (!m.outcome && !m.body) throw bad('Add what it was about (an outcome or notes)');
    return d;
  }
  app.post('/api/comms', wrap((req, res) => {
    const sc = commScope(req.body, req.user);
    const d = commData({ kind: 'call', direction: 'out', occurred_at: new Date().toISOString(), ...req.body });
    // tie it to the customer too, so the customer page rolls everything up
    let customer = sc.customer_id;
    if (sc.job_id) customer = get(db, 'SELECT customer_id FROM jobs WHERE id = ?', sc.job_id).customer_id;
    if (sc.estimate_id) { const e = get(db, 'SELECT customer_id, job_id FROM estimates WHERE id = ?', sc.estimate_id); customer = e.customer_id; d.job_id = e.job_id || null; }
    const id = insert('comm_log', { ...d, customer_id: customer || null, job_id: sc.job_id ?? d.job_id ?? null, estimate_id: sc.estimate_id, bid_id: sc.bid_id, user_id: req.user.id });
    res.json({ id });
  }));
  const commRow = req => {
    const l = get(db, 'SELECT * FROM comm_log WHERE id = ?', +req.params.id);
    if (!l) throw bad('Not found', 404);
    if (!(['admin', 'manager'].includes(req.user.role) || l.user_id === req.user.id)) throw bad('Only who logged it (or an admin) can change it', 403);
    return l;
  };
  app.put('/api/comms/:id', wrap((req, res) => { const l = commRow(req); update('comm_log', l.id, commData(req.body, l)); res.json({ ok: true }); }));
  app.delete('/api/comms/:id', wrap((req, res) => { const l = commRow(req); run(db, 'DELETE FROM comm_log WHERE id = ?', l.id); res.json({ ok: true }); }));

  // ------------------------------------------------------------ dashboard & reports
  app.get('/api/dashboard', office, wrap((req, res) => {
    const t = today();
    const monthStart = t.slice(0, 8) + '01';
    const money = req.can('reports'); // revenue, margins, receivables only for people with business reports
    const pl = money ? C.profitAndLoss(db, monthStart, t) : undefined;
    const ar = money ? C.arAging(db) : undefined;
    const s = D.settings(db);
    const dayStart = C.startOfDay(t), dayEnd = C.endOfDay(t);
    res.json({ money,
      today_jobs: H.appointments("a.start < ? AND a.end >= ? AND a.status != 'cancelled'", [dayEnd, dayStart]),
      unscheduled: get(db, "SELECT COUNT(*) n FROM jobs WHERE status = 'unscheduled'").n,
      to_invoice: all(db, `${jobSelect} WHERE j.status = 'completed' ORDER BY j.completed_at`).map(fixTechs),
      wip: money ? Bill.wipReport(db).totals : undefined,
      estimates_review: get(db, "SELECT COUNT(*) n FROM estimates WHERE review_status = 'pending'").n,
      clocked_in: all(db, 'SELECT t.*, u.name user_name, j.number job_number, j.title job_title FROM time_entries t JOIN users u ON u.id = t.user_id LEFT JOIN jobs j ON j.id = t.job_id WHERE t.clock_out IS NULL'),
      open_estimates: money ? C.estimateConversion(db, '0000-01-01', t) : undefined,
      ar, mtd: pl,
      target_gross_margin: Number(s.target_gross_margin) || 0,
      follow_ups_due: all(db, `SELECT j.id, j.number, j.title, j.hold_reason, j.hold_follow_up, j.hold_assignee, a.name assignee_name FROM jobs j LEFT JOIN users a ON a.id = j.hold_assignee
        WHERE j.status = 'on_hold' AND (j.hold_follow_up IS NULL OR j.hold_follow_up <= ?) ORDER BY (j.hold_assignee = ${Number(req.user.id)}) DESC, j.hold_follow_up LIMIT 15`, t),
      inspections_upcoming: all(db, `SELECT p.*, j.number job_number, j.title job_title FROM permits p JOIN jobs j ON j.id = p.job_id WHERE p.inspection_date >= ? AND p.status NOT IN ('passed','closed') ORDER BY p.inspection_date LIMIT 10`, t),
      low_stock: all(db, 'SELECT id, code, name, qty_on_hand, reorder_point FROM pricebook WHERE active = 1 AND reorder_point > 0 AND qty_on_hand <= reorder_point ORDER BY name'),
      agreements_due: all(db, `SELECT a.*, c.name customer_name FROM agreements a JOIN customers c ON c.id = a.customer_id WHERE a.status = 'active' AND a.next_visit <= ? ORDER BY a.next_visit`, addDays(t, 30)),
      trend: money ? C.monthlyTrend(db, 6) : undefined,
    });
  }));
  const range = req => ({ from: req.query.from || today().slice(0, 8) + '01', to: req.query.to || today() });
  app.get('/api/reports/pl', office, wrap((req, res) => { const { from, to } = range(req); res.json(C.profitAndLoss(db, from, to)); }));
  app.get('/api/reports/trend', office, wrap((req, res) => res.json(C.monthlyTrend(db, Math.min(36, Number(req.query.months) || 12)))));
  app.get('/api/reports/hours-by-job', office, wrap((req, res) => { const { from, to } = range(req); res.json(C.hoursByJob(db, from, to, req.query.user_id)); }));
  app.get('/api/reports/payroll', office, wrap((req, res) => { const { from, to } = range(req); res.json(C.payroll(db, from, to)); }));
  app.get('/api/reports/ar-aging', office, wrap((req, res) => res.json(C.arAging(db))));
  app.get('/api/reports/tech-performance', office, wrap((req, res) => { const { from, to } = range(req); res.json(C.techPerformance(db, from, to)); }));
  // Permits report: filter by which date (applied/issued/inspection/expires), status group and jurisdiction.
  app.get('/api/reports/permits', office, wrap((req, res) => {
    const { from, to } = range(req);
    const DATE = { applied: 'COALESCE(p.applied_date, date(p.created_at))', issued: 'p.issued_date', inspection: 'p.inspection_date', expires: 'p.expires_date' };
    const by = DATE[req.query.by] ? req.query.by : 'applied';
    const where = [`${DATE[by]} BETWEEN ? AND ?`], prm = [from, to];
    const OPEN = "p.status NOT IN ('passed','closed')";
    if (req.query.status === 'open') where.push(OPEN);
    else if (req.query.status === 'attention') where.push(`(p.status = 'failed' OR (${OPEN} AND ((p.inspection_date < ? AND p.status IN ('rough_scheduled','final_scheduled')) OR p.expires_date <= ?)))`), prm.push(today(), addDays(today(), 30));
    else if (req.query.status && req.query.status !== 'all') { const st = String(req.query.status).split(','); where.push(`p.status IN (${st.map(() => '?').join(',')})`); prm.push(...st); }
    if (req.query.jurisdiction) { where.push('p.jurisdiction = ?'); prm.push(req.query.jurisdiction); }
    const rows = all(db, `SELECT p.*, j.number job_number, j.title job_title, j.status job_status, c.name customer_name, c.company customer_company,
        TRIM(COALESCE(l.address, '') || COALESCE(', ' || l.city, '')) address,
        (SELECT GROUP_CONCAT(u.name, ', ') FROM job_techs jt JOIN users u ON u.id = jt.user_id WHERE jt.job_id = j.id) techs
      FROM permits p JOIN jobs j ON j.id = p.job_id JOIN customers c ON c.id = j.customer_id LEFT JOIN locations l ON l.id = j.location_id
      WHERE ${where.join(' AND ')} ORDER BY ${DATE[by]}, p.id`, ...prm);
    const t = today(), soon = addDays(t, 30);
    for (const r of rows) {
      const open = !['passed', 'closed'].includes(r.status);
      r.flags = [
        r.status === 'failed' && 'Failed inspection',
        open && ['rough_scheduled', 'final_scheduled'].includes(r.status) && r.inspection_date && r.inspection_date < t && 'Inspection date passed. Update the result.',
        open && r.expires_date && r.expires_date < t && 'Expired',
        open && r.expires_date && r.expires_date >= t && r.expires_date <= soon && 'Expires within 30 days',
        open && ['completed', 'invoiced'].includes(r.job_status) && 'Job finished but permit not closed',
      ].filter(Boolean);
      r.days_open = r.applied_date ? Math.round((Date.parse(['passed', 'closed'].includes(r.status) && r.inspection_date ? r.inspection_date : t) - Date.parse(r.applied_date)) / 864e5) : null;
    }
    const tally = key => Object.entries(rows.reduce((m, r) => { const k = r[key] || '(none)'; m[k] = m[k] || { count: 0, fees: 0 }; m[k].count++; m[k].fees = C.r2(m[k].fees + (r.fee || 0)); return m; }, {}))
      .map(([k, v]) => ({ [key]: k, ...v })).sort((a, b) => b.count - a.count);
    res.json({ from, to, by, rows, summary: {
      count: rows.length, fees: C.r2(rows.reduce((a, r) => a + (r.fee || 0), 0)),
      open: rows.filter(r => !['passed', 'closed'].includes(r.status)).length, passed: rows.filter(r => ['passed', 'closed'].includes(r.status)).length,
      failed: rows.filter(r => r.status === 'failed').length, attention: rows.filter(r => r.flags.length).length,
      by_status: tally('status'), by_jurisdiction: tally('jurisdiction'),
      jurisdictions: all(db, "SELECT DISTINCT jurisdiction FROM permits WHERE jurisdiction IS NOT NULL AND jurisdiction != '' ORDER BY jurisdiction").map(r => r.jurisdiction),
    } });
  }));
  app.get('/api/reports/estimates', office, wrap((req, res) => { const { from, to } = range(req); res.json(C.estimateConversion(db, from, to)); }));
  // Jobs report: every job in a date range (by created / scheduled / completed date) with filters, status,
  // hold details, hours and money. Cost fields are removed for people without "see costs".
  app.get('/api/reports/jobs', office, wrap((req, res) => {
    const { from, to } = range(req), q = req.query;
    const by = { created: 'j.created_at', scheduled: 'COALESCE(j.scheduled_start, j.start_date)', completed: 'j.completed_at' }[q.date_by] || 'j.created_at';
    const where = [`date(${by}) BETWEEN ? AND ?`], args = [from, to];
    if (q.status === 'open') where.push("j.status NOT IN ('completed','invoiced','cancelled')");
    else if (q.status) { const st = String(q.status).split(',').filter(Boolean); where.push(`j.status IN (${st.map(() => '?').join(',')})`); args.push(...st); }
    else where.push("j.status != 'cancelled'");
    if (q.job_type) { where.push('j.job_type = ?'); args.push(q.job_type); }
    if (q.customer_id) { where.push('j.customer_id = ?'); args.push(+q.customer_id); }
    if (q.tech_id) { where.push('EXISTS (SELECT 1 FROM job_techs t WHERE t.job_id = j.id AND t.user_id = ?)'); args.push(+q.tech_id); }
    if (q.kind === 'project') where.push('j.is_project = 1'); else if (q.kind === 'service') where.push('COALESCE(j.is_project, 0) = 0');
    const rows = all(db, `SELECT j.id, j.number, j.title, j.status, j.job_type, j.billing_type, j.is_project, j.created_at, j.scheduled_start, j.completed_at, j.start_date,
        j.hold_reason, j.hold_follow_up, j.hold_at, c.id customer_id, c.name customer_name, ha.name hold_assignee_name,
        (SELECT GROUP_CONCAT(u.name, ', ') FROM job_techs t JOIN users u ON u.id = t.user_id WHERE t.job_id = j.id) tech_names,
        (SELECT COUNT(*) FROM appointments a WHERE a.job_id = j.id AND a.status != 'cancelled') visits
      FROM jobs j JOIN customers c ON c.id = j.customer_id LEFT JOIN users ha ON ha.id = j.hold_assignee
      WHERE ${where.join(' AND ')} ORDER BY ${by} DESC, j.id DESC LIMIT 2000`, ...args);
    const out = rows.map(j => {
      const k = C.jobCosting(db, j.id);
      return { ...j, hours: k.hours, contract_amount: k.contract_amount, revenue: k.revenue, collected: k.collected, total_cost: k.total_cost, profit: k.profit, margin_pct: k.margin_pct,
        days_on_hold: j.status === 'on_hold' && j.hold_at ? Math.max(0, Math.floor((Date.now() - new Date(j.hold_at)) / 864e5)) : null };
    });
    const sum = f => Math.round(out.reduce((s, r) => s + (Number(r[f]) || 0), 0) * 100) / 100;
    const by_status = {}; for (const r of out) by_status[r.status] = (by_status[r.status] || 0) + 1;
    res.json({ rows: out, totals: { jobs: out.length, hours: sum('hours'), contract_amount: sum('contract_amount'), revenue: sum('revenue'), collected: sum('collected'), total_cost: sum('total_cost'), profit: sum('profit') }, by_status });
  }));
  app.get('/api/reports/job-costing', office, wrap((req, res) => { const { from, to } = range(req); res.json(C.jobCostingReport(db, from, to)); }));
  app.get('/api/reports/lead-sources', office, wrap((req, res) => { const { from, to } = range(req); res.json(C.revenueBySource(db, from, to)); }));

  require('./routes_ext').webhook(app, db, { H });
  require('./routes_bank')(app, db, { wrap, bad, admin, pick, insert, update });
  require('./routes_field')(app, db, { wrap, bad, office, admin, pick, insert, update, mustGet, H });
  // ------------------------------------------------------------ job billing (fixed price vs T&M)
  app.get('/api/jobs/:id/billing', office, wrap((req, res) => { mustGet('jobs', req.params.id); res.json(Bill.jobBilling(db, Number(req.params.id), req.query.through)); }));
  app.post('/api/jobs/:id/bill-fixed', office, wrap((req, res) => {
    if (get(db, 'SELECT 1 x FROM pay_apps WHERE job_id = ?', req.params.id)) throw bad('This project bills by pay application (Project → Billing Entry / Pay Apps). Billing it here too would bill the work twice.');
    res.json({ id: Bill.billFixed(db, Number(req.params.id), req.body) });
  }));
  app.post('/api/jobs/:id/bill-tm', office, wrap((req, res) => res.json({ id: Bill.billTM(db, Number(req.params.id), req.body) })));
  const MS_TEMPLATES = { standard: [['Deposit', 30], ['Rough-in complete', 40], ['Final / trim complete', 30]], half: [['Deposit', 50], ['Completion', 50]],
    commercial: [['Mobilization', 10], ['Underground / rough-in', 35], ['Service & distribution', 25], ['Trim & devices', 20], ['Final / punch list', 10]] };
  app.post('/api/jobs/:id/milestones', office, wrap((req, res) => {
    const job = mustGet('jobs', req.params.id);
    if (job.billing_type !== 'fixed') throw bad('Milestones are for quoted-price jobs');
    const rows = req.body.template ? (MS_TEMPLATES[req.body.template] || (() => { throw bad('Unknown template'); })()).map(([name, pct]) => ({ name, pct })) : [req.body];
    const n = get(db, 'SELECT COUNT(*) n FROM billing_milestones WHERE job_id = ?', job.id).n;
    rows.forEach((m, i) => {
      if (!m.name || (m.pct == null && m.amount == null)) throw bad('Milestone needs a name and a percent or amount');
      insert('billing_milestones', { job_id: job.id, name: m.name, pct: m.pct === '' ? null : m.pct ?? null, amount: m.amount === '' ? null : m.amount ?? null, sort: n + i });
    });
    res.json({ ok: true });
  }));
  app.put('/api/milestones/:id', office, wrap((req, res) => {
    const m = mustGet('billing_milestones', req.params.id);
    if (m.invoice_id) throw bad('Already billed — void the invoice to change it');
    update('billing_milestones', m.id, pick(req.body, ['name', 'pct', 'amount', 'sort'])); res.json({ ok: true });
  }));
  app.delete('/api/milestones/:id', office, wrap((req, res) => {
    const m = mustGet('billing_milestones', req.params.id);
    if (m.invoice_id) throw bad('Already billed — void the invoice first');
    run(db, 'DELETE FROM billing_milestones WHERE id = ?', m.id); res.json({ ok: true });
  }));
  app.get('/api/reports/wip', office, wrap((req, res) => res.json(Bill.wipReport(db))));
  require('./routes_import')(app, db, { wrap, bad, admin, H });
  const hooks = {};
  const PR = require('./projects')(app, db, { wrap, bad, insert, update, mustGet, pick, jobSelect, fixTechs, addDays, hooks });
  const WB = require('./workbook')(app, db, { wrap, bad, insert, update, mustGet, pick, P: PR, baseUrl });
  hooks.exceptions = WB.exceptions;
  require('./job_import')(app, db, { wrap, bad, insert, update, WB });
  require('./routes_ext')(app, db, { wrap, bad, insert, update, mustGet, pick, today, addDays, office, admin, role, baseUrl, H, jobSelect, fixTechs, loadedRate });
  require('./appt_confirm')(app, db, { wrap, bad, mustGet, H });
  require('./email_templates').routes(app, db, { wrap, bad, admin });
  Push.routes(app, db, { wrap, bad, admin });
  require('./kpi')(app, db, { wrap, bad, admin });
  require('./estimating')(app, db, { wrap, bad });
  require('./takeoff')(app, db, { wrap, bad });
  require('./pipeline')(app, db, { wrap, bad, office, today, addDays });

  // ------------------------------------------------------------ static
  const pub = path.join(__dirname, '..', 'public');
  // the service worker must be re-checked on every load, or phones keep running an old app
  app.get('/sw.js', (req, res) => { res.set('Cache-Control', 'no-cache'); res.set('Service-Worker-Allowed', '/'); res.sendFile(path.join(pub, 'sw.js')); });
  app.use(express.static(pub));
  app.get('/p/:kind(estimate|invoice)/:token', (req, res) => res.sendFile(path.join(pub, 'doc.html')));
  app.get('/p/report/:token', (req, res) => res.sendFile(path.join(pub, 'report.html')));
  app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(pub, 'index.html')));

  app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    let status = err.status || 500, msg = err.message;
    if (/UNIQUE constraint failed: users.email/.test(msg)) { status = 400; msg = 'That email is already in use'; }
    else if (/CHECK constraint|FOREIGN KEY|NOT NULL/.test(msg)) { status = 400; msg = 'Invalid data: ' + msg; }
    if (status >= 500) console.error(err);
    res.status(status).json({ error: msg });
  });
  app.locals.H = H; // purchasing helpers for background jobs (Ply sync)
  return app;
}

module.exports = { createApp };
