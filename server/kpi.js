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
//    no status; no number says "no data"; a number with no target set isn't scored (shown as info, target "not set").
//  - A yellow or red row needs a Cause and a Fix before the page can be submitted (the Command Center web app's rule).
//  - An auto number (pulled, or imported from the sheet) shows as "auto". Replacing it keeps the auto number beside the
//    typed one and needs a reason.
// Definitions, settings and history come in from the sheet (download it as .xlsx) — nothing about the company's metrics
// or people is in this code.
const D = require('./db');
const P = require('./perms');
const X = require('./xlsx');
const KpiAuto = require('./kpi_auto');
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
  const NEEDS = st => st === 'red' || st === 'yellow';
  const explained = n => !!(n && str(n.cause) && str(n.fix));
  const updatedAt = () => (get(db, 'SELECT MAX(at) at FROM (SELECT MAX(at) at FROM kpi_values UNION ALL SELECT MAX(auto_at) FROM kpi_values UNION ALL SELECT MAX(at) FROM kpi_notes UNION ALL SELECT MAX(at) FROM kpi_submissions)') || {}).at || null;
  // the web app's statusOf: yellow only exists for a target above zero
  function status(m, v, c) {
    if (m.better === 'Info') return 'info';
    if (v == null || Number.isNaN(v)) return 'no_data';
    if (m.target == null) return 'no_target';
    const t = m.target, b = c.band;
    if (m.better === 'Higher') return v >= t ? 'green' : (t > 0 && v >= t * (1 - b)) ? 'yellow' : 'red';
    return v <= t ? 'green' : (t > 0 && v <= t * (1 + b)) ? 'yellow' : 'red';
  }
  // ...and red when it has moved the wrong way 3 weeks running (4 numbers in a row, each worse than the last)
  function scored(m, trend, c) {
    const v = trend[trend.length - 1]; let st = status(m, v, c), wrong = false;
    if (st === 'green' || st === 'yellow') {
      const t = trend.slice(-4);
      if (t.length === 4 && t.every(x => x != null)) {
        wrong = [1, 2, 3].every(i => (m.better === 'Higher' ? t[i] < t[i - 1] : t[i] > t[i - 1]));
        if (wrong) st = 'red';
      }
    }
    return { status: st, wrong_way: wrong };
  }
  // ---------------------------------------------------------------- auto numbers from Field Ops' own records
  const AUTO = KpiAuto(db, { localNow, localToUtc, addDays });
  // works out each auto metric for the weeks asked for and keeps it beside the KPI as its auto number. A Feed number from
  // the sheet still wins; a reasoned override still wins; a plain typed number gives way (as in the web app).
  function refreshAuto(weeks, metrics, c) {
    const autos = metrics.filter(m => m.input === 'auto' && AUTO.RULES[m.rule]);
    if (!autos.length) return;
    const from = AUTO.startWeek(c, sundayOf), last = addDays(currentWeek(c), 7);
    if (!from) return;
    const X = AUTO.context(c), now = Date.now(), at = new Date().toISOString(), memo = new Map();
    for (const w of weeks) {
      if (w < from || w > last) continue;
      const ended = now > AUTO.satNight(w, c.tz);
      for (const m of autos) {
        const row = get(db, 'SELECT * FROM kpi_values WHERE week = ? AND metric_id = ?', w, m.id);
        if (row && String(row.auto_source || '').startsWith('Feed:')) continue;
        if (AUTO.NOW_ONLY.has(m.rule)) {
          const frozen = row && String(row.auto_source || '').startsWith('Field Ops') && Date.parse(row.auto_at) >= AUTO.satNight(w, c.tz);
          if (frozen || (ended && w < currentWeek(c))) continue;   // "now" numbers can't be rebuilt for an older week
        }
        const k = `${m.rule}|${w}`;
        if (!memo.has(k)) memo.set(k, AUTO.compute(m.rule, w, c, X));
        const res = memo.get(k); if (!res) continue;
        const src = `Field Ops: ${AUTO.RULES[m.rule]}`, det = res.detail.length ? JSON.stringify(res.detail) : null;
        if (row && row.auto_value === res.value && row.auto_source === src && (row.detail || null) === det && !(row.origin === 'manual' && !row.reason)) continue;
        if (row) {
          const keepOverride = row.origin === 'manual' && row.reason;
          run(db, `UPDATE kpi_values SET auto_value = ?, auto_source = ?, auto_at = ?, auto_link = NULL, auto_note = ?, detail = ?,
            value = CASE WHEN ? THEN value ELSE ? END, origin = CASE WHEN ? THEN origin ELSE 'auto' END, reason = CASE WHEN ? THEN reason ELSE NULL END WHERE week = ? AND metric_id = ?`,
            res.value, src, at, res.note, det, keepOverride ? 1 : 0, res.value, keepOverride ? 1 : 0, keepOverride ? 1 : 0, w, m.id);
        } else {
          run(db, `INSERT INTO kpi_values (week, metric_id, value, origin, by_label, at, auto_value, auto_at, auto_source, auto_note, detail) VALUES (?,?,?,'auto','Field Ops',?,?,?,?,?,?)`,
            w, m.id, res.value, at, res.value, at, src, res.note, det);
        }
      }
    }
  }
  // every metric for one week: value, stored row, status, trend (oldest → this week)
  function score(week, metrics, c) {
    const hist = weeksBack(week, Math.max(4, c.history));
    refreshAuto(hist, metrics, c);
    const vals = valuesFor(hist, metrics, c), out = new Map();
    for (const m of metrics) {
      const trend = hist.map(w => vals.get(w).get(m.id).value), cur = vals.get(week).get(m.id);
      out.set(m.id, { value: cur.value, row: cur.row, trend: trend.slice(-c.history), weeks: hist.slice(-c.history), ...scored(m, trend, c) });
    }
    return out;
  }
  // where a number came from, in the web app's words: auto, feed, entered (manual), override, calc, or missing (none)
  const originOf = (m, row, v) => m.input === 'calc' ? 'calc' : (!row || v == null) ? 'none'
    : row.origin === 'auto' ? (String(row.auto_source || '').startsWith('Feed:') ? 'feed' : 'auto') : row.auto_value != null ? 'override' : 'manual';
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
    // the week in progress too (the web app offers it), then the last 26 finished weeks
    res.json({ ...a, owners, week: currentWeek(c), weeks: [addDays(currentWeek(c), 7), ...weeksBack(currentWeek(c), 26).reverse()], admin: req.user.role === 'admin' });
  });

  // a metric as the browser sees it this week
  function pubMetric(m, sc, n, c) {
    const row = sc.row;
    return { id: m.id, owner_id: m.owner_id, owner: m.owner, section: m.section, metric: m.metric, unit: m.unit, better: m.better, target: m.target, input: m.input, rule: m.rule,
      source: m.source, how: m.how, target_note: m.target_note, value: sc.value, status: sc.status, wrong_way: sc.wrong_way, trend: sc.trend,
      origin: originOf(m, row, sc.value), auto_value: row ? row.auto_value : null, auto_source: row ? row.auto_source : null, auto_link: row ? row.auto_link : null,
      reason: row ? row.reason : null, entered_by: row ? row.by_label : null, entered_at: row ? row.at : null,
      note: n ? { cause: n.cause, fix: n.fix, by: n.by_label, at: n.at } : null, needs_note: NEEDS(sc.status) && !explained(n) };
  }
  const extrasOf = (week, ownerIds) => ownerIds.length ? all(db, `SELECT x.*, o.name owner FROM kpi_extras x JOIN kpi_owners o ON o.id = x.owner_id
    WHERE x.week = ? AND x.owner_id IN (${ownerIds.map(() => '?').join(',')}) ORDER BY x.at, x.id`, week, ...ownerIds) : [];
  // the IDs a set of metrics' formulas read, all the way down (a limited viewer still sees these, as inputs)
  function inputsOf(list, byId) {
    const keep = new Set(), walk = m => { if (!m || m.input !== 'calc') return; for (const id of refsOf(treeOf(m))) if (!keep.has(id)) { keep.add(id); walk(byId.get(id)); } };
    list.forEach(walk); return keep;
  }

  // one owner's page for a week
  app.get('/api/kpi/page', wrap((req, res) => {
    const a = access(req.user), c = cfg(), week = weekParam(req.query.week, c);
    const owner = get(db, 'SELECT o.*, u.name user_name FROM kpi_owners o LEFT JOIN users u ON u.id = o.user_id WHERE o.id = ?', Number(req.query.owner));
    if (!owner) throw bad('No such KPI page', 404);
    if (!canSee(a, owner.id)) throw bad('That page belongs to someone else', 403);
    const all_ = metricsAll().filter(m => m.active), byId = new Map(all_.map(m => [m.id, m])), mine = all_.filter(m => m.owner_id === owner.id);
    const sc = score(week, all_, c), notes = latestNotes(week, mine.map(m => m.id));
    const sections = [];
    for (const m of mine) {
      let sec = sections.find(s => s.name === m.section); if (!sec) sections.push(sec = { name: m.section, metrics: [] });
      sec.metrics.push(pubMetric(m, sc.get(m.id), notes.get(m.id), c));
    }
    // other pages' numbers this page's formulas read, so the browser can re-work the formulas as numbers are typed
    const others = {};
    for (const id of inputsOf(mine, byId)) { const m = byId.get(id); if (m && m.owner_id !== owner.id) others[id] = { value: sc.get(id).value, metric: m.metric, unit: m.unit }; }
    const flat = sections.flatMap(x => x.metrics);
    res.json({ week, week_end: addDays(week, 6), due: dueOf(week, c), tz: c.tz, owner: { id: owner.id, name: owner.name, user_name: owner.user_name },
      can_edit: canEdit(a, owner.id), report: reportState(week, owner.id, c), submissions: subsOf(week, owner.id), band: c.band, ot_rate: c.otRate, sections, others,
      extras: extrasOf(week, [owner.id]), weeks: sc.size ? [...sc.values()][0].weeks : [],
      counts: { total: flat.length, with_number: flat.filter(x => x.value != null).length, need_note: flat.filter(x => x.needs_note).length },
      updated_at: updatedAt(), signed_in_as: req.user.email });
  }));

  // save (and optionally submit) a page:
  // { values: {K1: 150, K2: null}, reasons: {B1: 'why'}, notes: {K2: {cause, fix}}, extras: [{item, value, explanation}], submit: true }
  app.put('/api/kpi/page', wrap((req, res) => {
    const a = access(req.user), c = cfg(), b = req.body || {}, week = weekParam(b.week, c);
    const owner = get(db, 'SELECT * FROM kpi_owners WHERE id = ?', Number(b.owner)); if (!owner) throw bad('No such KPI page', 404);
    if (!canEdit(a, owner.id)) throw bad('Only the page\'s owner (or someone allowed to fill in anyone\'s page) can enter these numbers', 403);
    const mine = new Map(all(db, 'SELECT * FROM kpi_metrics WHERE owner_id = ? AND active = 1', owner.id).map(m => [m.id, m]));
    const now = new Date().toISOString(), who = label(req.user), onBehalf = owner.user_id !== req.user.id;
    let changed = 0; const whyMissing = [];
    const by = onBehalf ? `${who} for ${owner.name}` : who;
    const log = (id, v, origin, reason) => run(db, 'INSERT OR IGNORE INTO kpi_value_log (week, metric_id, value, origin, reason, user_id, by_label, at) VALUES (?,?,?,?,?,?,?,?)', week, id, v, origin, reason || null, req.user.id, by, now);
    // extra items first: each needs an explanation (checked before anything is written)
    const extras = (Array.isArray(b.extras) ? b.extras : []).map(x => ({ item: str(x && x.item).slice(0, 200), value: str(x && x.value).slice(0, 100), explanation: str(x && x.explanation).slice(0, 2000) })).filter(x => x.item);
    for (const x of extras) if (!x.explanation) throw bad(`Extra item "${x.item}": an explanation is required for anything outside your assigned KPIs`);
    for (const [id, raw] of Object.entries(b.values || {})) {
      const m = mine.get(id); if (!m) throw bad(`${id} isn't on ${owner.name}'s page`);
      if (m.input === 'calc') continue;
      const v = raw === '' || raw == null ? null : Number(raw);
      if (v != null && !Number.isFinite(v)) throw bad(`${id} ${m.metric}: "${raw}" isn't a number`);
      const cur = get(db, 'SELECT * FROM kpi_values WHERE week = ? AND metric_id = ?', week, id);
      const reason = str((b.reasons || {})[id]).slice(0, 1000) || null;
      if (cur && cur.auto_value != null) {
        // an auto or feed number: blank (or the same number) = keep it; anything else overrides it and needs a reason
        if (v == null || v === cur.auto_value) {
          if (cur.origin !== 'auto' || cur.value !== cur.auto_value) {
            run(db, "UPDATE kpi_values SET value = auto_value, origin = 'auto', reason = NULL, user_id = ?, by_label = ?, at = ? WHERE week = ? AND metric_id = ?", req.user.id, by, now, week, id);
            log(id, null, 'cleared', 'Back to the auto number'); changed++;
          }
          continue;
        }
        const why = reason || (cur.origin === 'manual' && cur.value === v ? cur.reason : null);
        if (!why) { whyMissing.push(`${id} ${m.metric}`); continue; }
        if (cur.value === v && cur.reason === why && cur.origin === 'manual') continue;
        run(db, "UPDATE kpi_values SET value = ?, origin = 'manual', reason = ?, user_id = ?, by_label = ?, at = ? WHERE week = ? AND metric_id = ?", v, why, req.user.id, by, now, week, id);
        log(id, v, 'override', why); changed++; continue;
      }
      if (v == null) { if (cur) { run(db, 'DELETE FROM kpi_values WHERE week = ? AND metric_id = ?', week, id); log(id, null, 'cleared'); changed++; } continue; }
      if (cur && cur.value === v) continue;
      run(db, `INSERT INTO kpi_values (week, metric_id, value, origin, user_id, by_label, at) VALUES (?,?,?,?,?,?,?)
        ON CONFLICT(week, metric_id) DO UPDATE SET value = excluded.value, origin = excluded.origin, user_id = excluded.user_id, by_label = excluded.by_label, at = excluded.at`,
        week, id, v, 'manual', req.user.id, by, now);
      log(id, v, 'manual'); changed++;
    }
    if (whyMissing.length) throw bad(`Give a reason for replacing the automatic number: ${whyMissing.join(', ')}`);
    const prev = latestNotes(week, [...mine.keys()]);
    for (const [id, n] of Object.entries(b.notes || {})) {
      if (!mine.has(id)) throw bad(`${id} isn't on ${owner.name}'s page`);
      const cause = str(n && n.cause).slice(0, 2000), fix = str(n && n.fix).slice(0, 2000), p = prev.get(id);
      if (!cause && !fix && !p) continue;
      if (p && p.cause === cause && p.fix === fix) continue;
      run(db, 'INSERT OR IGNORE INTO kpi_notes (week, metric_id, cause, fix, user_id, by_label, at) VALUES (?,?,?,?,?,?,?)', week, id, cause, fix, req.user.id, who, now);
      changed++;
    }
    for (const x of extras) { run(db, 'INSERT OR IGNORE INTO kpi_extras (week, owner_id, item, value, explanation, user_id, by_label, at) VALUES (?,?,?,?,?,?,?,?)', week, owner.id, x.item, x.value || null, x.explanation, req.user.id, by, now); changed++; }
    let submitted = false, need = [], blank = [];
    if (b.submit) {
      const all_ = metricsAll().filter(m => m.active), sc = score(week, all_, c), notes = latestNotes(week, [...mine.keys()]);
      need = [...mine.values()].filter(m => NEEDS(sc.get(m.id).status) && !explained(notes.get(m.id))).map(m => ({ id: m.id, metric: m.metric }));
      blank = [...mine.values()].filter(m => m.input !== 'calc' && sc.get(m.id).value == null).map(m => ({ id: m.id, metric: m.metric }));
      if (!need.length) { run(db, 'INSERT OR IGNORE INTO kpi_submissions (week, owner_id, user_id, by_label, at) VALUES (?,?,?,?,?)', week, owner.id, req.user.id, who, now); submitted = true; }
    }
    res.json({ ok: true, changed, submitted, need_notes: need, blank });
  }));

  // the team overview (see-everyone only)
  app.get('/api/kpi/dashboard', wrap((req, res) => {
    const a = access(req.user), c = cfg(), week = weekParam(req.query.week, c);
    if (!a.view_all && !a.edit_all) throw bad('The team overview is for people who can see everyone\'s numbers', 403);
    const metrics = metricsAll().filter(m => m.active), sc = score(week, metrics, c);
    const notes = latestNotes(week, metrics.map(m => m.id));
    const kpis = metrics.map(m => pubMetric(m, sc.get(m.id), notes.get(m.id), c));
    const health = { green: 0, yellow: 0, red: 0, no_data: 0, info: 0, no_target: 0 };
    for (const k of kpis) health[k.status]++;
    const owners = all(db, 'SELECT o.id, o.name, o.user_id, u.name user_name, u.color FROM kpi_owners o LEFT JOIN users u ON u.id = o.user_id ORDER BY o.sort, o.name');
    const reports = owners.map(o => {
      const mine = kpis.filter(k => k.owner_id === o.id), cnt = st => mine.filter(k => k.status === st).length;
      return { ...o, ...reportState(week, o.id, c), green: cnt('green'), yellow: cnt('yellow'), red: cnt('red'), no_data: cnt('no_data'), info: cnt('info'),
        total: mine.length, with_number: mine.filter(k => k.value != null).length, need_note: mine.filter(k => k.needs_note).length };
    });
    const scoredN = health.green + health.yellow + health.red;
    res.json({ week, week_end: addDays(week, 6), due: dueOf(week, c), health, updated_at: updatedAt(), band: c.band, weeks: sc.size ? [...sc.values()][0].weeks : [],
      on_target_pct: scoredN ? Math.round(health.green / scoredN * 100) : null, scored: scoredN,
      submitted: reports.filter(r => r.state === 'in' || r.state === 'late').length, waiting_on: reports.filter(r => !(r.state === 'in' || r.state === 'late')).map(r => r.name),
      need_note: kpis.filter(k => k.needs_note).length, kpis, reports, extras: extrasOf(week, owners.map(o => o.id)) });
  }));

  // one KPI in depth: trend, where the number came from, a formula's inputs, line items, cause and fix, every entry this week
  app.get('/api/kpi/metric/:id', wrap((req, res) => {
    const a = access(req.user), c = cfg(), week = weekParam(req.query.week, c);
    const all_ = metricsAll().filter(m => m.active), byId = new Map(all_.map(m => [m.id, m])), m = byId.get(req.params.id);
    if (!m) throw bad('No such KPI', 404);
    // visible: your own pages' KPIs and what their formulas read; everything for people who see everyone
    const mineIds = new Set(all_.filter(x => a.owners.includes(x.owner_id)).map(x => x.id));
    const visible = canSee(a, m.owner_id) || inputsOf(all_.filter(x => mineIds.has(x.id)), byId).has(m.id);
    if (!visible) throw bad('That KPI belongs to someone else', 403);
    const sc = score(week, all_, c), me = sc.get(m.id), n = latestNotes(week, [m.id]).get(m.id);
    const rows = new Map(all(db, `SELECT * FROM kpi_values WHERE metric_id = ? AND week IN (${me.weeks.map(() => '?').join(',')})`, m.id, ...me.weeks).map(r => [r.week, r]));
    let detail = []; try { detail = me.row && me.row.detail ? JSON.parse(me.row.detail) : []; } catch { detail = []; }
    const inputs = m.input === 'calc' ? [...new Set(refsOf(treeOf(m)))].map(id => byId.has(id) ? { id, metric: byId.get(id).metric, unit: byId.get(id).unit, value: sc.get(id).value, origin: originOf(byId.get(id), sc.get(id).row, sc.get(id).value) } : null).filter(Boolean) : [];
    const consts_ = m.input === 'calc' && /OT_RATE/i.test(m.rule || '') ? [{ name: 'OT rate (Settings)', value: c.otRate, unit: '$' }] : [];
    res.json({ ...pubMetric(m, me, n, c), week, weeks: me.weeks, detail: Array.isArray(detail) ? detail : [], auto_note: me.row ? me.row.auto_note : null, inputs, consts: consts_,
      by_week: me.weeks.map((w, i) => ({ week: w, value: me.trend[i], origin: originOf(m, rows.get(w), me.trend[i]) })),
      history: all(db, 'SELECT value, origin, reason, by_label, at FROM kpi_value_log WHERE week = ? AND metric_id = ? ORDER BY at DESC, id DESC', week, m.id) });
  }));

  // ---------------------------------------------------------------- set-up: metrics, targets, owners, settings
  const editAll = (req, res, next) => (access(req.user).edit_all ? next() : next(bad('Only people allowed to fill in anyone\'s page can change KPI set-up', 403)));
  app.get('/api/kpi/setup', editAll, (req, res) => {
    const c = cfg();
    res.json({ owners: all(db, 'SELECT o.*, u.name user_name, (SELECT COUNT(*) FROM kpi_metrics m WHERE m.owner_id = o.id AND m.active = 1) metrics FROM kpi_owners o LEFT JOIN users u ON u.id = o.user_id ORDER BY o.sort, o.name'),
      metrics: metricsAll(), settings: { band: c.band, ot_rate: c.otRate, due_days: c.dueDays, due_time: c.dueTime, history_weeks: c.history, headlines: c.headlines.join(', '),
        auto_from: S().kpi_auto_from || '', auto_from_effective: AUTO.startWeek(c, sundayOf), non_job_numbers: S().kpi_non_job_numbers || '0000, 0500, 1000',
        tardy_grace_min: num(S().kpi_tardy_grace_min) ?? 5, ot_after: num(S().overtime_weekly_hours) ?? 40 },
      rules: Object.entries(AUTO.RULES).map(([k, d]) => ({ key: k, desc: d })),
      users: all(db, "SELECT id, name, email, role FROM users WHERE active = 1 AND role IN ('admin','manager','office') ORDER BY name") });
  });
  // a new KPI row (one the sheet didn't have, e.g. attendance): ids are X1, X2… so they never collide with the sheet's
  app.post('/api/kpi/metrics', editAll, wrap((req, res) => {
    const b = req.body || {};
    const owner = get(db, 'SELECT id FROM kpi_owners WHERE id = ?', Number(b.owner_id)); if (!owner) throw bad('Pick whose page it goes on');
    const metric = str(b.metric); if (!metric) throw bad('Name the KPI');
    const rule = str(b.rule); if (rule && !AUTO.RULES[rule]) throw bad('Unknown Field Ops number');
    const better = ['Higher', 'Lower', 'Info'].includes(b.better) ? b.better : 'Info';
    const unit = ['#', '$', '%', 'hrs', 'days', 'min'].includes(b.unit) ? b.unit : '#';
    const t = b.target === '' || b.target == null ? null : Number(b.target); if (t != null && !Number.isFinite(t)) throw bad('Target must be a number');
    const n = all(db, "SELECT id FROM kpi_metrics WHERE id LIKE 'X%'").reduce((mx, r) => Math.max(mx, Number(String(r.id).slice(1)) || 0), 0) + 1;
    const sort = (get(db, 'SELECT MAX(sort) s FROM kpi_metrics WHERE owner_id = ?', owner.id) || {}).s || 0;
    run(db, 'INSERT INTO kpi_metrics (id, owner_id, section, metric, unit, better, target, input, rule, active, sort) VALUES (?,?,?,?,?,?,?,?,?,1,?)',
      `X${n}`, owner.id, str(b.section) || 'Attendance', metric, unit, better, t, rule ? 'auto' : 'manual', rule || null, sort + 1);
    res.json({ id: `X${n}` });
  }));
  app.put('/api/kpi/metrics/:id', editAll, wrap((req, res) => {
    const m = get(db, 'SELECT * FROM kpi_metrics WHERE id = ?', req.params.id); if (!m) throw bad('No such metric', 404);
    const b = req.body || {}, up = {};
    if ('target' in b) { const t = b.target === '' || b.target == null ? null : Number(b.target); if (t != null && !Number.isFinite(t)) throw bad('Target must be a number'); up.target = t; }
    if ('target_note' in b) up.target_note = str(b.target_note) || null;
    if ('active' in b) up.active = b.active ? 1 : 0;
    if ('owner_id' in b) { if (!get(db, 'SELECT 1 x FROM kpi_owners WHERE id = ?', Number(b.owner_id))) throw bad('No such owner'); up.owner_id = Number(b.owner_id); }
    if ('better' in b) { if (!['Higher', 'Lower', 'Info'].includes(b.better)) throw bad('Better must be Higher, Lower or Info'); up.better = b.better; }
    if ('rule' in b && m.input !== 'calc') {   // which Field Ops number fills an auto (or typed) metric; blank = typed by hand
      const r = str(b.rule);
      if (r && !AUTO.RULES[r]) throw bad('Unknown Field Ops number');
      up.rule = r || null; up.input = r ? 'auto' : 'manual';
    }
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
    if ('auto_from' in b) { const v = str(b.auto_from); if (v && !/^\d{4}-\d\d-\d\d$/.test(v)) throw bad('Start week like 2026-11-01'); up.run('kpi_auto_from', v ? sundayOf(v) : ''); }
    if ('non_job_numbers' in b) up.run('kpi_non_job_numbers', str(b.non_job_numbers).slice(0, 200));
    if ('tardy_grace_min' in b) { const v = Number(b.tardy_grace_min); if (!(v >= 0 && v <= 120)) throw bad('Grace minutes: 0 to 120'); up.run('kpi_tardy_grace_min', String(v)); }
    if ('headlines' in b) {
      const ids = str(b.headlines).split(/[\s,]+/).filter(Boolean);
      const unknown = ids.filter(id => !get(db, 'SELECT 1 x FROM kpi_metrics WHERE id = ?', id));
      if (unknown.length) throw bad(`No metric ${unknown.join(', ')}`);
      up.run('kpi_headlines', ids.join(','));
    }
    res.json({ ok: true });
  }));

  // ---------------------------------------------------------------- import the KPI Dashboard workbook (File → Download → .xlsx)
  // Reads Metrics, Settings, Values, Notes, Submissions, Extras, Feed, FeedDetail and Snapshots. Never reads the HCP_*, Ply_*,
  // Clock_* data tabs.
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
    // Snapshots and FeedDetail carry line items (customer names, invoice numbers) for the drill-down; they stay on this server
    return { metrics: table('Metrics'), settings: table('Settings'), values: table('Values'), notes: table('Notes'), submissions: table('Submissions'),
      snapshots: table('Snapshots'), feed: table('Feed'), feedDetail: table('FeedDetail'), extras: table('Extras') };
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
    res.json({ metrics: t.metrics.length, owners: p.ownerMap, grants: p.grants, values: t.values.length + t.snapshots.length + t.feed.length, notes: t.notes.length, submissions: t.submissions.length,
      extras: t.extras.length, problems: p.problems,
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
        input === 'manual' ? null : str(r.Rule) || null, str(r.Source) || null, str(r['How measured']) || null, str(r['Target note']) || null, str(r.Active).toUpperCase() === 'N' ? 0 : 1, i);
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
    let nv = 0, nn = 0, ns = 0, nx = 0;
    // automatic numbers: Snapshots, then Feed rows (Feed wins, as in the web app). Kept as the auto number beside any typed one.
    const setAuto = (w, id, v, at, src, link, note, detail) => {
      const x = run(db, `INSERT INTO kpi_values (week, metric_id, value, origin, by_label, at, auto_value, auto_at, auto_source, auto_link, auto_note, detail) VALUES (?,?,?,'auto',?,?,?,?,?,?,?,?)
        ON CONFLICT(week, metric_id) DO UPDATE SET auto_value = excluded.auto_value, auto_at = excluded.auto_at, auto_source = excluded.auto_source, auto_link = excluded.auto_link,
          auto_note = excluded.auto_note, detail = excluded.detail, value = CASE WHEN kpi_values.origin = 'auto' THEN excluded.auto_value ELSE kpi_values.value END
        WHERE kpi_values.auto_value IS NOT excluded.auto_value OR kpi_values.auto_source IS NOT excluded.auto_source OR kpi_values.detail IS NOT excluded.detail
          OR kpi_values.auto_link IS NOT excluded.auto_link OR kpi_values.auto_note IS NOT excluded.auto_note`, w, id, v, src, at, v, at, src, link || null, note || null, detail || null);
      nv += Number(x.changes);
    };
    const jsonList = v => { try { const a = JSON.parse(String(v || '')); return Array.isArray(a) && a.length ? JSON.stringify(a) : null; } catch { return null; } };
    for (const r of t.values.filter(x => str(x.Origin).toLowerCase() === 'auto')) {   // older sheets wrote pulled numbers into Values
      const w = wk(r.Week), id = str(r.ID), v = num(r.Value); if (!w || !known.has(id) || v == null) continue;
      setAuto(w, id, v, when(r['Entered at']), str(r.Source) || 'KPI sheet', null, null, null);
    }
    for (const r of t.snapshots) {
      const w = wk(r.Week), id = str(r.ID), v = num(r.Value); if (!w || !known.has(id) || v == null) continue;
      setAuto(w, id, v, when(r['Taken at']), str(r.Source) || 'Snapshot', null, null, jsonList(r.Detail));
    }
    const lines = new Map();
    for (const d of t.feedDetail) {
      const w = wk(d.Week), id = str(d.ID); if (!w || !id) continue;
      const k = `${w}|${id}`; if (!lines.has(k)) lines.set(k, []);
      lines.get(k).push({ label: str(d.Label), amount: num(d.Amount), ref: str(d.Ref), link: str(d.Link) });
    }
    for (const r of t.feed) {
      const w = wk(r.Week), id = str(r.ID), v = num(r.Value); if (!w || !known.has(id) || v == null) continue;
      const items = lines.get(`${w}|${id}`);
      setAuto(w, id, v, new Date().toISOString(), `Feed: ${str(r.Source) || 'unnamed source'}`, str(r.Link), str(r.Note), items && items.length ? JSON.stringify(items) : null);
    }
    // typed entries, oldest first: every one goes in the history; the newest per week and KPI decides the number
    // (precedence as in the web app: override > auto/feed > entered; a cleared entry goes back to the auto number)
    const entries = t.values.map(r => ({ r, w: wk(r.Week), id: str(r.ID), at: when(r['Entered at']), origin: str(r.Origin).toLowerCase() || 'manual' }))
      .filter(e => e.w && known.has(e.id) && e.origin !== 'auto').sort((x, y) => (x.at < y.at ? -1 : x.at > y.at ? 1 : 0));
    const latest = new Map();
    for (const e of entries) {
      const v = num(e.r.Value), byLabel = str(e.r['Entered by']) || 'KPI sheet';
      nv += Number(run(db, 'INSERT OR IGNORE INTO kpi_value_log (week, metric_id, value, origin, reason, user_id, by_label, at) VALUES (?,?,?,?,?,?,?,?)',
        e.w, e.id, v, v == null ? 'cleared' : e.origin, str(e.r.Reason) || null, userId(e.r['Entered by']), byLabel, e.at).changes);
      latest.set(`${e.w}|${e.id}`, { ...e, v, byLabel });
    }
    for (const e of latest.values()) {
      const cur = get(db, 'SELECT * FROM kpi_values WHERE week = ? AND metric_id = ?', e.w, e.id);
      if (cur && cur.origin !== 'auto' && cur.at > e.at) continue;          // typed in Field Ops since: keep it
      const hasAuto = cur && cur.auto_value != null;
      if (e.v != null && (e.origin === 'override' || !hasAuto)) {
        if (cur && cur.origin === 'manual' && cur.value === e.v && cur.at === e.at) continue;
        run(db, `INSERT INTO kpi_values (week, metric_id, value, origin, user_id, by_label, at, reason) VALUES (?,?,?,'manual',?,?,?,?)
          ON CONFLICT(week, metric_id) DO UPDATE SET value = excluded.value, origin = 'manual', user_id = excluded.user_id, by_label = excluded.by_label, at = excluded.at, reason = excluded.reason`,
          e.w, e.id, e.v, userId(e.r['Entered by']), e.byLabel, e.at, e.origin === 'override' ? (str(e.r.Reason) || null) : null);
      } else if (hasAuto) {
        if (cur.origin !== 'auto') run(db, "UPDATE kpi_values SET value = auto_value, origin = 'auto', reason = NULL WHERE week = ? AND metric_id = ?", e.w, e.id);
      } else if (cur) run(db, 'DELETE FROM kpi_values WHERE week = ? AND metric_id = ?', e.w, e.id);
    }
    for (const r of t.notes) {
      const w = wk(r.Week), id = str(r.ID); if (!w || !known.has(id) || !(str(r.Cause) || str(r.Fix))) continue;
      nn += Number(run(db, 'INSERT OR IGNORE INTO kpi_notes (week, metric_id, cause, fix, user_id, by_label, at) VALUES (?,?,?,?,?,?,?)', w, id, str(r.Cause), str(r.Fix), userId(r.By), str(r.By) || 'KPI sheet', when(r.At)).changes);
    }
    for (const r of t.submissions) {
      const w = wk(r.Week), o = get(db, 'SELECT id FROM kpi_owners WHERE name = ?', str(r.Owner)); if (!w || !o) continue;
      ns += Number(run(db, 'INSERT OR IGNORE INTO kpi_submissions (week, owner_id, user_id, by_label, at) VALUES (?,?,?,?,?)', w, o.id, userId(r.By), str(r.By) || 'KPI sheet', when(r['Submitted at'])).changes);
    }
    for (const r of t.extras) {
      const w = wk(r.Week), o = get(db, 'SELECT id FROM kpi_owners WHERE name = ?', str(r.Owner)); if (!w || !o || !str(r.Item)) continue;
      nx += Number(run(db, 'INSERT OR IGNORE INTO kpi_extras (week, owner_id, item, value, explanation, user_id, by_label, at) VALUES (?,?,?,?,?,?,?,?)',
        w, o.id, str(r.Item), str(r.Value) || null, str(r.Explanation) || '—', userId(r.By), str(r.By) || 'KPI sheet', when(r.At)).changes);
    }
    res.json({ ok: true, metrics: t.metrics.length, owners: p.ownerMap, permissions_for: [...changedUsers], unmatched_emails: [...new Set(p.grants.filter(g => !g.user && !g.tech).map(g => g.email))],
      skipped_technicians: [...new Set([...p.grants, ...p.ownerMap].filter(g => g.tech).map(g => g.tech))],
      values: nv, notes: nn, submissions: ns, extras: nx });
  }));
};
module.exports.parseRule = parseRule;
module.exports.evalTree = evalTree;
module.exports.localToUtc = localToUtc;
