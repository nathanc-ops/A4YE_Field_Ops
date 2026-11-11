'use strict';
// Weekly KPIs, the way the A4YE KPI Dashboard sheet runs them:
//  - A week is Sunday–Saturday, named by its Sunday (2026-11-01). Pages are due DUE_DAYS after the Saturday, at DUE_TIME,
//    company time zone (3 → Tuesday 11:59 PM).
//  - Each metric has an owner. The owner's Field Ops user fills in that page. Everyone sees only their own page, except
//    people with "see everyone's numbers" (the sheet's MASTER_VIEWERS). People with "fill in anyone's page" (the
//    sheet's ADMINS) can enter or correct any page and set targets. Admins have both.
//  - Inputs: manual (typed), auto (the sheet pulled these from Housecall Pro / Ply / the time clock; here they are typed
//    until Field Ops is the source), calc (a formula of other metric IDs, e.g. K6/K5, B14/(B4/7), N6*OT_RATE).
//  - Status: Higher/Lower against the target. Within BAND (25%) of the target is yellow, beyond is red. Info metrics have
//    no status; a metric with no target says "set target"; no number says "no data".
//  - A red row needs a Cause and a Fix before the page can be submitted.
// Definitions, settings and history come in from the sheet (download it as .xlsx) — nothing about the company's metrics
// or people is in this code.
const D = require('./db');
const P = require('./perms');
const X = require('./xlsx');
const { all, get, run } = D;

const DEFAULT_HEADLINES = 'B4,N27,B18,B15,N39,J5,K7,N5,J12,N17';
const num = v => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : Number(v));
const str = v => (v == null ? '' : String(v).trim());

// ------------------------------------------------------------------ dates (YYYY-MM-DD, calendar arithmetic in UTC)
const addDays = (d, n) => { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const sundayOf = d => { const x = new Date(d + 'T12:00:00Z'); return addDays(d, -x.getUTCDay()); };
const isSunday = d => /^\d{4}-\d\d-\d\d$/.test(d) && new Date(d + 'T12:00:00Z').getUTCDay() === 0;
// wall clock "YYYY-MM-DD HH:MM" in a time zone
function localNow(tz, at = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(at).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}
// a wall-clock time in tz → UTC ISO (the offset that applies at that moment)
function localToUtc(local, tz) {
  const m = String(local).match(/^(\d{4}-\d\d-\d\d)[ T](\d\d):(\d\d)/); if (!m) return null;
  const guess = Date.parse(`${m[1]}T${m[2]}:${m[3]}:00Z`);
  const shown = Date.parse(localNow(tz, new Date(guess)).replace(' ', 'T') + ':00Z');
  return new Date(guess - (shown - guess)).toISOString();
}
const quarterOf = d => `${d.slice(0, 4)}Q${Math.floor((Number(d.slice(5, 7)) - 1) / 3) + 1}`;

// ------------------------------------------------------------------ formulas: + - * / ( ), metric IDs, setting constants
function parseRule(rule) {
  const toks = []; const re = /\s*(\d+(?:\.\d+)?|[A-Za-z_][A-Za-z0-9_]*|[-+*/()])/y; let m, i = 0; const s = String(rule || '');
  while (i < s.length) { re.lastIndex = i; m = re.exec(s); if (!m) { if (/^\s*$/.test(s.slice(i))) break; throw new Error(`Can't read the formula "${rule}"`); } toks.push(m[1]); i = re.lastIndex; }
  let k = 0;
  const peek = () => toks[k], next = () => toks[k++];
  function factor() {
    const t = next();
    if (t === undefined) throw new Error(`The formula "${rule}" ends too early`);
    if (t === '(') { const e = expr(); if (next() !== ')') throw new Error(`A bracket isn't closed in "${rule}"`); return e; }
    if (t === '-') { const f = factor(); return { op: 'neg', a: f }; }
    if (/^\d/.test(t)) return { n: Number(t) };
    if (/^[A-Z]+\d+$/.test(t)) return { id: t };
    if (/^[A-Za-z_]/.test(t)) return { c: t.toUpperCase() };
    throw new Error(`Unexpected "${t}" in "${rule}"`);
  }
  function term() { let a = factor(); while (peek() === '*' || peek() === '/') { const op = next(); a = { op, a, b: factor() }; } return a; }
  function expr() { let a = term(); while (peek() === '+' || peek() === '-') { const op = next(); a = { op, a, b: term() }; } return a; }
  const tree = expr();
  if (k !== toks.length) throw new Error(`Unexpected "${toks[k]}" in "${rule}"`);
  return tree;
}
const refsOf = t => !t ? [] : t.id ? [t.id] : [...refsOf(t.a), ...refsOf(t.b)];
function evalTree(t, look, consts) {
  if ('n' in t) return t.n;
  if (t.id) return look(t.id);
  if (t.c) return consts[t.c] ?? null;
  const a = evalTree(t.a, look, consts); if (a == null) return null;
  if (t.op === 'neg') return -a;
  const b = evalTree(t.b, look, consts); if (b == null) return null;
  if (t.op === '+') return a + b; if (t.op === '-') return a - b; if (t.op === '*') return a * b;
  return b === 0 ? null : a / b;
}

module.exports = function kpiRoutes(app, db, { wrap, bad, admin }) {
  const S = () => D.settings(db);
  const cfg = () => {
    const s = S(), tz = (() => { try { new Intl.DateTimeFormat('en-US', { timeZone: s.timezone || 'America/Boise' }); return s.timezone || 'America/Boise'; } catch { return 'America/Boise'; } })();
    return { tz, band: num(s.kpi_band) ?? 0.25, otRate: num(s.kpi_ot_rate), dueDays: num(s.kpi_due_days) ?? 3, dueTime: /^\d\d:\d\d$/.test(s.kpi_due_time || '') ? s.kpi_due_time : '23:59',
      history: Math.min(52, Math.max(4, num(s.kpi_history_weeks) ?? 12)), headlines: str(s.kpi_headlines || DEFAULT_HEADLINES).split(/[\s,]+/).filter(Boolean) };
  };
  const consts = c => ({ OT_RATE: c.otRate, BAND: c.band });
  const perms = user => P.effective(user, S());
  // KPIs are for office staff, managers and admins; technicians never see them, even if linked to a page
  const KPI_ROLES = ['admin', 'manager', 'office'];
  const access = user => {
    if (!KPI_ROLES.includes(user.role)) return { view_all: false, edit_all: false, owners: [], any: false };
    const p = perms(user), owns = all(db, 'SELECT id FROM kpi_owners WHERE user_id = ?', user.id).map(r => r.id);
    return { view_all: !!p.kpi_view_all, edit_all: !!p.kpi_edit_all, owners: owns, any: !!(p.kpi_view_all || p.kpi_edit_all || owns.length) && !!get(db, 'SELECT 1 x FROM kpi_metrics LIMIT 1') };
  };
  app.locals.kpiAccess = access;
  const canSee = (a, ownerId) => a.view_all || a.edit_all || a.owners.includes(ownerId);
  const canEdit = (a, ownerId) => a.edit_all || a.owners.includes(ownerId);
  const label = user => user.email || user.name;

  // the week to fill in now: the last complete Sunday–Saturday
  const currentWeek = c => addDays(sundayOf(localNow(c.tz).slice(0, 10)), -7);
  const dueOf = (week, c) => `${addDays(week, 6 + c.dueDays)} ${c.dueTime}`;

  // ---------------------------------------------------------------- numbers for a set of weeks (with calcs worked out)
  const metricsAll = () => all(db, 'SELECT m.*, o.name owner FROM kpi_metrics m JOIN kpi_owners o ON o.id = m.owner_id ORDER BY o.sort, o.name, m.sort, m.id');
  const trees = new Map();
  const treeOf = m => { if (!trees.has(m.rule)) { try { trees.set(m.rule, parseRule(m.rule)); } catch { trees.set(m.rule, null); } } return trees.get(m.rule); };
  function valuesFor(weeks, metrics, c) {
    const byId = new Map(metrics.map(m => [m.id, m]));
    const raw = new Map(); // week → Map(id → row)
    if (weeks.length) for (const r of all(db, `SELECT * FROM kpi_values WHERE week IN (${weeks.map(() => '?').join(',')})`, ...weeks)) {
      if (!raw.has(r.week)) raw.set(r.week, new Map()); raw.get(r.week).set(r.metric_id, r);
    }
    const out = new Map();
    for (const w of weeks) {
      const rows = raw.get(w) || new Map(), memo = new Map();
      const look = (id, seen = new Set()) => {
        if (memo.has(id)) return memo.get(id);
        const m = byId.get(id); let v = null;
        if (m && m.input === 'calc') {
          if (seen.has(id)) return null; seen.add(id);
          const t = treeOf(m); v = t ? evalTree(t, x => look(x, seen), consts(c)) : null;
          seen.delete(id);
        } else if (rows.has(id)) v = rows.get(id).value;
        memo.set(id, v); return v;
      };
      const vals = new Map();
      for (const m of metrics) vals.set(m.id, { value: look(m.id), row: rows.get(m.id) || null });
      out.set(w, vals);
    }
    return out;
  }
  function status(m, v, c) {
    if (m.better === 'Info') return 'info';
    if (m.target == null) return 'set_target';
    if (v == null) return 'no_data';
    const t = m.target;
    if (m.better === 'Higher') return v >= t ? 'green' : v >= t - Math.abs(t) * c.band ? 'yellow' : 'red';
    return v <= t ? 'green' : v <= t + Math.abs(t) * c.band ? 'yellow' : 'red';
  }
  const latestNotes = (week, ids) => {
    const map = new Map(); if (!ids.length) return map;
    for (const n of all(db, `SELECT * FROM kpi_notes WHERE week = ? AND metric_id IN (${ids.map(() => '?').join(',')}) ORDER BY at, id`, week, ...ids)) map.set(n.metric_id, n);
    return map;
  };
  const weeksBack = (week, n) => Array.from({ length: n }, (_, i) => addDays(week, -7 * (n - 1 - i)));
  const subsOf = (week, ownerId) => all(db, 'SELECT at, by_label FROM kpi_submissions WHERE week = ? AND owner_id = ? ORDER BY at', week, ownerId);
  function reportState(week, ownerId, c) {
    const subs = subsOf(week, ownerId), due = dueOf(week, c);
    if (subs.length) { const first = localNow(c.tz, new Date(subs[0].at)); return { state: first > due ? 'late' : 'in', at: subs[subs.length - 1].at, first_at: subs[0].at, by: subs[subs.length - 1].by_label }; }
    return { state: localNow(c.tz) > due ? 'missing' : 'open' };
  }
  const weekParam = (v, c) => { const w = str(v) || currentWeek(c); if (!isSunday(w)) throw bad('Week must be the Sunday date it starts on (YYYY-MM-DD)'); return w; };

  // ---------------------------------------------------------------- routes
  app.get('/api/kpi/me', (req, res) => {
    const a = access(req.user), c = cfg();
    const owners = all(db, 'SELECT o.id, o.name, o.user_id, u.name user_name FROM kpi_owners o LEFT JOIN users u ON u.id = o.user_id ORDER BY o.sort, o.name').filter(o => canSee(a, o.id));
    res.json({ ...a, owners, week: currentWeek(c), weeks: weeksBack(currentWeek(c), 26).reverse(), admin: req.user.role === 'admin' });
  });

  // one owner's page for a week
  app.get('/api/kpi/page', wrap((req, res) => {
    const a = access(req.user), c = cfg(), week = weekParam(req.query.week, c);
    const owner = get(db, 'SELECT o.*, u.name user_name FROM kpi_owners o LEFT JOIN users u ON u.id = o.user_id WHERE o.id = ?', Number(req.query.owner));
    if (!owner) throw bad('No such KPI page', 404);
    if (!canSee(a, owner.id)) throw bad('That page belongs to someone else', 403);
    const all_ = metricsAll(), mine = all_.filter(m => m.owner_id === owner.id && m.active);
    const hist = weeksBack(week, c.history), vals = valuesFor(hist, all_, c), notes = latestNotes(week, mine.map(m => m.id));
    const sections = [];
    for (const m of mine) {
      const v = vals.get(week).get(m.id), st = status(m, v.value, c), n = notes.get(m.id);
      let sec = sections.find(s => s.name === m.section); if (!sec) sections.push(sec = { name: m.section, metrics: [] });
      sec.metrics.push({ id: m.id, metric: m.metric, unit: m.unit, better: m.better, target: m.target, input: m.input, rule: m.rule, source: m.source, how: m.how, target_note: m.target_note,
        value: v.value, status: st, entered_by: v.row ? v.row.by_label : null, entered_at: v.row ? v.row.at : null,
        note: n ? { cause: n.cause, fix: n.fix, by: n.by_label, at: n.at } : null, needs_note: st === 'red',
        trend: hist.map(w => ({ week: w, value: vals.get(w).get(m.id).value })) });
    }
    res.json({ week, week_end: addDays(week, 6), due: dueOf(week, c), tz: c.tz, owner: { id: owner.id, name: owner.name, user_name: owner.user_name },
      can_edit: canEdit(a, owner.id), report: reportState(week, owner.id, c), submissions: subsOf(week, owner.id), band: c.band, sections });
  }));

  // save (and optionally submit) a page: { values: {K1: 150, K2: null}, notes: {K2: {cause, fix}}, submit: true }
  app.put('/api/kpi/page', wrap((req, res) => {
    const a = access(req.user), c = cfg(), b = req.body || {}, week = weekParam(b.week, c);
    const owner = get(db, 'SELECT * FROM kpi_owners WHERE id = ?', Number(b.owner)); if (!owner) throw bad('No such KPI page', 404);
    if (!canEdit(a, owner.id)) throw bad('Only the page\'s owner (or someone allowed to fill in anyone\'s page) can enter these numbers', 403);
    const mine = new Map(all(db, 'SELECT * FROM kpi_metrics WHERE owner_id = ? AND active = 1', owner.id).map(m => [m.id, m]));
    const now = new Date().toISOString(), who = label(req.user), onBehalf = owner.user_id !== req.user.id;
    let changed = 0;
    for (const [id, raw] of Object.entries(b.values || {})) {
      const m = mine.get(id); if (!m) throw bad(`${id} isn't on ${owner.name}'s page`);
      if (m.input === 'calc') continue;
      const v = raw === '' || raw == null ? null : Number(raw);
      if (v != null && !Number.isFinite(v)) throw bad(`${id} ${m.metric}: "${raw}" isn't a number`);
      const cur = get(db, 'SELECT value FROM kpi_values WHERE week = ? AND metric_id = ?', week, id);
      if (v == null) { if (cur) { run(db, 'DELETE FROM kpi_values WHERE week = ? AND metric_id = ?', week, id); changed++; } continue; }
      if (cur && cur.value === v) continue;
      run(db, `INSERT INTO kpi_values (week, metric_id, value, origin, user_id, by_label, at) VALUES (?,?,?,?,?,?,?)
        ON CONFLICT(week, metric_id) DO UPDATE SET value = excluded.value, origin = excluded.origin, user_id = excluded.user_id, by_label = excluded.by_label, at = excluded.at`,
        week, id, v, 'manual', req.user.id, onBehalf ? `${who} for ${owner.name}` : who, now);
      changed++;
    }
    const prev = latestNotes(week, [...mine.keys()]);
    for (const [id, n] of Object.entries(b.notes || {})) {
      if (!mine.has(id)) throw bad(`${id} isn't on ${owner.name}'s page`);
      const cause = str(n && n.cause).slice(0, 2000), fix = str(n && n.fix).slice(0, 2000), p = prev.get(id);
      if (!cause && !fix) continue;
      if (p && p.cause === cause && p.fix === fix) continue;
      run(db, 'INSERT OR IGNORE INTO kpi_notes (week, metric_id, cause, fix, user_id, by_label, at) VALUES (?,?,?,?,?,?,?)', week, id, cause, fix, req.user.id, who, now);
      changed++;
    }
    let submitted = false, need = [];
    if (b.submit) {
      const all_ = metricsAll(), vals = valuesFor([week], all_, c).get(week), notes = latestNotes(week, [...mine.keys()]);
      need = [...mine.values()].filter(m => status(m, vals.get(m.id).value, c) === 'red').filter(m => { const n = notes.get(m.id); return !(n && n.cause && n.fix); }).map(m => ({ id: m.id, metric: m.metric }));
      if (!need.length) { run(db, 'INSERT OR IGNORE INTO kpi_submissions (week, owner_id, user_id, by_label, at) VALUES (?,?,?,?,?)', week, owner.id, req.user.id, who, now); submitted = true; }
    }
    res.json({ ok: true, changed, submitted, need_notes: need });
  }));

  // the company scorecard (see-everyone only)
  app.get('/api/kpi/dashboard', wrap((req, res) => {
    const a = access(req.user), c = cfg(), week = weekParam(req.query.week, c);
    if (!a.view_all && !a.edit_all) throw bad('The company scorecard is for people who can see everyone\'s numbers', 403);
    const metrics = metricsAll().filter(m => m.active);
    const q = quarterOf(week), qWeeks = weeksBack(week, 14).filter(w => quarterOf(w) === q);
    const vals = valuesFor([...new Set([...qWeeks, week])], metrics, c), now = vals.get(week);
    const notes = latestNotes(week, metrics.map(m => m.id));
    const health = { green: 0, yellow: 0, red: 0, no_data: 0, set_target: 0 };
    const rows = metrics.map(m => { const v = now.get(m.id).value, st = status(m, v, c); if (st in health) health[st]++; return { m, v, st }; });
    const owners = all(db, 'SELECT o.id, o.name, u.name user_name FROM kpi_owners o LEFT JOIN users u ON u.id = o.user_id ORDER BY o.sort, o.name');
    const qAvg = id => { const xs = qWeeks.map(w => vals.get(w).get(id).value).filter(v => v != null); return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null; };
    const pub = r => ({ id: r.m.id, metric: r.m.metric, owner: r.m.owner, unit: r.m.unit, better: r.m.better, target: r.m.target, value: r.v, status: r.st });
    const headlines = c.headlines.map(id => rows.find(r => r.m.id === id)).filter(Boolean).map(r => ({ ...pub(r), qtr_avg: qAvg(r.m.id) }));
    // the constraint: the section furthest from its targets (share of scored metrics that are green; yellow counts half)
    const secs = new Map();
    for (const r of rows) {
      if (!['green', 'yellow', 'red'].includes(r.st)) continue;
      const k = `${r.m.owner}|${r.m.section}`; if (!secs.has(k)) secs.set(k, { owner: r.m.owner, section: r.m.section, green: 0, yellow: 0, red: 0 });
      secs.get(k)[r.st]++;
    }
    const sections = [...secs.values()].map(s => ({ ...s, score: (s.green + s.yellow / 2) / (s.green + s.yellow + s.red) })).sort((x, y) => x.score - y.score);
    res.json({ week, week_end: addDays(week, 6), due: dueOf(week, c), quarter: q, quarter_weeks: qWeeks.length, health,
      reports: owners.map(o => ({ ...o, ...reportState(week, o.id, c) })), headlines, constraint: sections[0] || null, sections,
      red: rows.filter(r => r.st === 'red').map(r => ({ ...pub(r), note: notes.get(r.m.id) ? { cause: notes.get(r.m.id).cause, fix: notes.get(r.m.id).fix } : null })) });
  }));

  // ---------------------------------------------------------------- set-up: metrics, targets, owners, settings
  const editAll = (req, res, next) => (access(req.user).edit_all ? next() : next(bad('Only people allowed to fill in anyone\'s page can change KPI set-up', 403)));
  app.get('/api/kpi/setup', editAll, (req, res) => {
    const c = cfg();
    res.json({ owners: all(db, 'SELECT o.*, u.name user_name, (SELECT COUNT(*) FROM kpi_metrics m WHERE m.owner_id = o.id AND m.active = 1) metrics FROM kpi_owners o LEFT JOIN users u ON u.id = o.user_id ORDER BY o.sort, o.name'),
      metrics: metricsAll(), settings: { band: c.band, ot_rate: c.otRate, due_days: c.dueDays, due_time: c.dueTime, history_weeks: c.history, headlines: c.headlines.join(', ') },
      users: all(db, "SELECT id, name, email, role FROM users WHERE active = 1 AND role IN ('admin','manager','office') ORDER BY name") });
  });
  app.put('/api/kpi/metrics/:id', editAll, wrap((req, res) => {
    const m = get(db, 'SELECT * FROM kpi_metrics WHERE id = ?', req.params.id); if (!m) throw bad('No such metric', 404);
    const b = req.body || {}, up = {};
    if ('target' in b) { const t = b.target === '' || b.target == null ? null : Number(b.target); if (t != null && !Number.isFinite(t)) throw bad('Target must be a number'); up.target = t; }
    if ('target_note' in b) up.target_note = str(b.target_note) || null;
    if ('active' in b) up.active = b.active ? 1 : 0;
    if ('owner_id' in b) { if (!get(db, 'SELECT 1 x FROM kpi_owners WHERE id = ?', Number(b.owner_id))) throw bad('No such owner'); up.owner_id = Number(b.owner_id); }
    if ('better' in b) { if (!['Higher', 'Lower', 'Info'].includes(b.better)) throw bad('Better must be Higher, Lower or Info'); up.better = b.better; }
    for (const [k, v] of Object.entries(up)) run(db, `UPDATE kpi_metrics SET ${k} = ? WHERE id = ?`, v, m.id);
    res.json({ ok: true });
  }));
  app.put('/api/kpi/owners/:id', editAll, wrap((req, res) => {
    const o = get(db, 'SELECT * FROM kpi_owners WHERE id = ?', Number(req.params.id)); if (!o) throw bad('No such owner', 404);
    const uid = req.body.user_id === '' || req.body.user_id == null ? null : Number(req.body.user_id);
    const u = uid != null && get(db, 'SELECT role FROM users WHERE id = ?', uid);
    if (uid != null && !u) throw bad('No such user');
    if (u && !KPI_ROLES.includes(u.role)) throw bad('KPI pages are for office staff, managers and admins — that person is a technician');
    run(db, 'UPDATE kpi_owners SET user_id = ? WHERE id = ?', uid, o.id);
    res.json({ ok: true });
  }));
  app.put('/api/kpi/settings', editAll, wrap((req, res) => {
    const b = req.body || {}, up = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    if ('band' in b) { const v = Number(b.band); if (!(v >= 0 && v <= 1)) throw bad('Yellow band is a share between 0 and 1 (0.25 = 25%)'); up.run('kpi_band', String(v)); }
    if ('ot_rate' in b) up.run('kpi_ot_rate', b.ot_rate === '' || b.ot_rate == null ? '' : String(Number(b.ot_rate)));
    if ('due_days' in b) { const v = Number(b.due_days); if (!(Number.isInteger(v) && v >= 0 && v <= 14)) throw bad('Due days: 0 to 14'); up.run('kpi_due_days', String(v)); }
    if ('due_time' in b) { if (!/^\d\d:\d\d$/.test(str(b.due_time))) throw bad('Due time like 23:59'); up.run('kpi_due_time', str(b.due_time)); }
    if ('history_weeks' in b) up.run('kpi_history_weeks', String(Math.min(52, Math.max(4, Number(b.history_weeks) || 12))));
    if ('headlines' in b) {
      const ids = str(b.headlines).split(/[\s,]+/).filter(Boolean);
      const unknown = ids.filter(id => !get(db, 'SELECT 1 x FROM kpi_metrics WHERE id = ?', id));
      if (unknown.length) throw bad(`No metric ${unknown.join(', ')}`);
      up.run('kpi_headlines', ids.join(','));
    }
    res.json({ ok: true });
  }));

  // ---------------------------------------------------------------- import the KPI Dashboard workbook (File → Download → .xlsx)
  // Reads Metrics, Settings, Values, Notes, Submissions. Never reads the HCP_*, Ply_*, Clock_* data tabs.
  function readWorkbook(b) {
    if (!b || !b.file) throw bad('Choose the KPI Dashboard workbook (.xlsx)');
    const buf = Buffer.from(String(b.file).replace(/^data:[^,]*,/, ''), 'base64');
    if (buf.length > 40 * 1024 * 1024) throw bad('That file is over 40 MB');
    let wb; try { wb = X.read(buf); } catch (e) { throw bad(e.message); }
    if (!wb.sheet('Metrics')) throw bad('That workbook has no Metrics tab — download the A4YE KPI Dashboard sheet as .xlsx');
    // a tab → array of objects keyed by its header row
    const table = name => {
      const sh = wb.sheet(name); if (!sh) return [];
      const head = []; for (let col = 1; col <= 30; col++) { const h = str(sh.val(1, col)); if (h) head[col] = h; }
      const out = [];
      for (let r = 2; r <= sh.maxRow; r++) {
        const o = {}; let any = false;
        head.forEach((h, col) => { if (!h) return; const v = sh.val(r, col); o[h] = v; if (v != null && v !== '') any = true; });
        if (any) out.push(o);
      }
      return out;
    };
    return { metrics: table('Metrics'), settings: table('Settings'), values: table('Values'), notes: table('Notes'), submissions: table('Submissions') };
  }
  const emailsIn = v => str(v).toLowerCase().split(/[\s,;]+/).filter(e => e.includes('@'));
  function plan(t) {
    const set = Object.fromEntries(t.settings.map(r => [str(r.Key), r.Value]));
    const owners = [...new Set(t.metrics.map(r => str(r.Owner)).filter(Boolean))];
    const userByEmail = e => e ? get(db, 'SELECT id, name, email, role FROM users WHERE lower(email) = ?', e) : null;
    // a technician can't hold a KPI page or KPI permissions: reported, not linked
    const ownerMap = owners.map(name => {
      const e = str(set[`EMAIL_${name}`]).toLowerCase(), u = userByEmail(e), ok = u && KPI_ROLES.includes(u.role);
      return { name, email: e || null, user: ok ? { id: u.id, name: u.name } : null, tech: u && !ok ? u.name : null };
    });
    const grants = [];
    for (const [key, perm] of [['ADMINS', 'kpi_edit_all'], ['MASTER_VIEWERS', 'kpi_view_all']]) for (const e of emailsIn(set[key])) {
      const u = userByEmail(e), ok = u && KPI_ROLES.includes(u.role);
      grants.push({ email: e, perm, user: ok ? { id: u.id, name: u.name, role: u.role } : null, tech: u && !ok ? u.name : null });
    }
    // ADMINS can edit any page, so they can see every page too
    for (const g of grants.filter(x => x.perm === 'kpi_edit_all')) if (!grants.some(x => x.perm === 'kpi_view_all' && x.email === g.email)) grants.push({ ...g, perm: 'kpi_view_all' });
    const bad_ = [];
    for (const r of t.metrics) if (str(r.Input).toLowerCase() === 'calc') { try { parseRule(r.Rule); } catch (e) { bad_.push(`${r.ID}: ${e.message}`); } }
    return { set, ownerMap, grants, problems: bad_ };
  }
  app.post('/api/import/kpi-workbook/preview', admin, wrap((req, res) => {
    const t = readWorkbook(req.body), p = plan(t);
    res.json({ metrics: t.metrics.length, owners: p.ownerMap, grants: p.grants, values: t.values.length, notes: t.notes.length, submissions: t.submissions.length, problems: p.problems,
      settings: { band: p.set.BAND, ot_rate: p.set.OT_RATE, due_days: p.set.DUE_DAYS_AFTER_WEEK_END, due_time: p.set.DUE_TIME, history_weeks: p.set.HISTORY_WEEKS, timezone: p.set.TIMEZONE } });
  }));
  app.post('/api/import/kpi-workbook', admin, wrap((req, res) => {
    const t = readWorkbook(req.body), p = plan(t), c = cfg(), tz = str(p.set.TIMEZONE) || c.tz;
    if (p.problems.length) throw bad(`Some formulas can't be read: ${p.problems.join('; ')}`);
    const up = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    for (const [k, key] of [['BAND', 'kpi_band'], ['OT_RATE', 'kpi_ot_rate'], ['DUE_DAYS_AFTER_WEEK_END', 'kpi_due_days'], ['DUE_TIME', 'kpi_due_time'], ['HISTORY_WEEKS', 'kpi_history_weeks']])
      if (str(p.set[k])) up.run(key, str(p.set[k]));
    // owners, in the order they first appear; keep an existing link to a user unless the sheet names a matching email
    p.ownerMap.forEach((o, i) => {
      run(db, 'INSERT INTO kpi_owners (name, sort) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET sort = excluded.sort', o.name, i);
      if (o.user) run(db, 'UPDATE kpi_owners SET user_id = ? WHERE name = ?', o.user.id, o.name);
    });
    const ownerId = n => get(db, 'SELECT id FROM kpi_owners WHERE name = ?', n).id;
    const pct = (unit, v) => v; // targets in the sheet are already fractions for % (0.06 = 6%)
    t.metrics.forEach((r, i) => {
      const id = str(r.ID); if (!/^[A-Z]+\d+$/.test(id)) return;
      const better = ['Higher', 'Lower', 'Info'].find(x => x.toLowerCase() === str(r.Better).toLowerCase()) || 'Info';
      const input = ['manual', 'calc', 'auto'].find(x => x === str(r.Input).toLowerCase()) || 'manual';
      run(db, `INSERT INTO kpi_metrics (id, owner_id, section, metric, unit, better, target, input, rule, source, how, target_note, active, sort) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET owner_id = excluded.owner_id, section = excluded.section, metric = excluded.metric, unit = excluded.unit, better = excluded.better,
          target = excluded.target, input = excluded.input, rule = excluded.rule, source = excluded.source, how = excluded.how, target_note = excluded.target_note,
          active = excluded.active, sort = excluded.sort`,
        id, ownerId(str(r.Owner)), str(r.Section), str(r.Metric) || id, str(r.Unit) || '#', better, pct(r.Unit, num(r.Target)), input,
        input === 'calc' ? str(r.Rule) : null, str(r.Source) || null, str(r['How measured']) || null, str(r['Target note']) || null, str(r.Active).toUpperCase() === 'N' ? 0 : 1, i);
    });
    trees.clear();
    // permissions: the sheet's ADMINS and MASTER_VIEWERS, for people who aren't Field Ops admins already (they have everything)
    const s = S(), changedUsers = new Set();
    for (const g of p.grants) {
      if (!g.user || g.user.role === 'admin') continue; // admins have everything already
      const u = get(db, 'SELECT * FROM users WHERE id = ?', g.user.id), want = { ...P.effective(u, s), [g.perm]: true };
      run(db, 'UPDATE users SET permissions = ? WHERE id = ?', P.overridesFrom(u.role, want, s), u.id); changedUsers.add(u.name);
    }
    // history: values (newer wins), cause/fix notes, submissions
    const userId = e => { const u = e && get(db, 'SELECT id FROM users WHERE lower(email) = ?', str(e).toLowerCase()); return u ? u.id : null; };
    const when = v => { const s2 = X.dateTimeOf(v); return s2 && /^\d{4}-\d\d-\d\d \d\d:\d\d/.test(s2) ? localToUtc(s2, tz) : new Date().toISOString(); };
    const wk = v => { const d = X.dateOf(v); return d && isSunday(d) ? d : null; };
    const known = new Set(all(db, 'SELECT id FROM kpi_metrics').map(r => r.id));
    let nv = 0, nn = 0, ns = 0;
    for (const r of t.values) {
      const w = wk(r.Week), id = str(r.ID), v = num(r.Value); if (!w || !known.has(id) || v == null) continue;
      const at = when(r['Entered at']);
      const x = run(db, `INSERT INTO kpi_values (week, metric_id, value, origin, user_id, by_label, at) VALUES (?,?,?,?,?,?,?)
        ON CONFLICT(week, metric_id) DO UPDATE SET value = excluded.value, origin = excluded.origin, user_id = excluded.user_id, by_label = excluded.by_label, at = excluded.at
        WHERE excluded.at > kpi_values.at`, w, id, v, str(r.Origin) || 'manual', userId(r['Entered by']), str(r['Entered by']) || 'KPI sheet', at);
      nv += Number(x.changes);
    }
    for (const r of t.notes) {
      const w = wk(r.Week), id = str(r.ID); if (!w || !known.has(id) || !(str(r.Cause) || str(r.Fix))) continue;
      nn += Number(run(db, 'INSERT OR IGNORE INTO kpi_notes (week, metric_id, cause, fix, user_id, by_label, at) VALUES (?,?,?,?,?,?,?)', w, id, str(r.Cause), str(r.Fix), userId(r.By), str(r.By) || 'KPI sheet', when(r.At)).changes);
    }
    for (const r of t.submissions) {
      const w = wk(r.Week), o = get(db, 'SELECT id FROM kpi_owners WHERE name = ?', str(r.Owner)); if (!w || !o) continue;
      ns += Number(run(db, 'INSERT OR IGNORE INTO kpi_submissions (week, owner_id, user_id, by_label, at) VALUES (?,?,?,?,?)', w, o.id, userId(r.By), str(r.By) || 'KPI sheet', when(r['Submitted at'])).changes);
    }
    res.json({ ok: true, metrics: t.metrics.length, owners: p.ownerMap, permissions_for: [...changedUsers], unmatched_emails: [...new Set(p.grants.filter(g => !g.user && !g.tech).map(g => g.email))],
      skipped_technicians: [...new Set([...p.grants, ...p.ownerMap].filter(g => g.tech).map(g => g.tech))],
      values: nv, notes: nn, submissions: ns });
  }));
};
module.exports.parseRule = parseRule;
module.exports.evalTree = evalTree;
module.exports.localToUtc = localToUtc;
