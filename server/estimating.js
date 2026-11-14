'use strict';
// Estimating dashboard: the commercial bid log (the "Estimating Dashboard" workbook's DATA tab) inside Field Ops.
// One row per bid: due date, bid #, project, the GCs it went to, date submitted, value, status, check-in notes.
// Admins and managers only.
const D = require('./db');
const X = require('./xlsx');
const { all, get, run } = D;

const STATUSES = ['estimating', 'waiting', 'in_progress', 'awarded', 'lost', 'no_bid'];
const STATUS_LABEL = { estimating: 'Estimating', waiting: 'Waiting', in_progress: 'In progress', awarded: 'Awarded', lost: 'Lost', no_bid: 'No bid' };
const statusOf = s => {
  s = String(s || '').trim().toLowerCase();
  if (!s) return 'estimating';
  return /award|won/.test(s) ? 'awarded' : /no ?bid|pass/.test(s) ? 'no_bid' : /lost|declin/.test(s) ? 'lost'
    : /progress|revis/.test(s) ? 'in_progress' : /wait|pending|submitted|out/.test(s) ? 'waiting' : /estimat/.test(s) ? 'estimating' : null;
};
const CHECK_IN_DAYS = 14;
const str = v => v == null ? '' : String(v).trim();
const r2 = n => Math.round(n * 100) / 100;

module.exports = function estimating(app, db, { wrap, bad, BF }) {
  const only = (req, res, next) => ['admin', 'manager'].includes(req.user.role) ? next() : res.status(403).json({ error: 'The estimating dashboard is for admins and managers' });

  const gcs = () => all(db, 'SELECT * FROM bid_gcs ORDER BY active DESC, sort, name COLLATE NOCASE');
  const gcIdFor = name => {
    name = str(name); if (!name) return null;
    const g = get(db, 'SELECT id FROM bid_gcs WHERE name = ? COLLATE NOCASE', name);
    if (g) return g.id;
    const sort = (get(db, 'SELECT MAX(sort) m FROM bid_gcs').m || 0) + 1;
    return Number(run(db, 'INSERT INTO bid_gcs (name, sort) VALUES (?,?)', name, sort).lastInsertRowid);
  };
  const setGcs = (bidId, ids) => {
    run(db, 'DELETE FROM bid_gc_links WHERE bid_id = ?', bidId);
    for (const id of new Set((ids || []).map(Number).filter(Boolean))) run(db, 'INSERT OR IGNORE INTO bid_gc_links (bid_id, gc_id) VALUES (?,?)', bidId, id);
  };
  const nextNumber = () => {
    const n = all(db, 'SELECT bid_number FROM bids').map(b => Number(b.bid_number)).filter(Number.isFinite);
    return n.length ? String(Math.max(...n) + 1) : '';
  };
  const bidsWithGcs = () => {
    const links = all(db, 'SELECT l.bid_id, g.id, g.name FROM bid_gc_links l JOIN bid_gcs g ON g.id = l.gc_id ORDER BY g.sort, g.name');
    const by = new Map(); for (const l of links) { if (!by.has(l.bid_id)) by.set(l.bid_id, []); by.get(l.bid_id).push({ id: l.id, name: l.name }); }
    return all(db, `SELECT b.*, j.number job_number, j.title job_title, j.is_project job_is_project,
      (SELECT COUNT(*) FROM takeoffs t WHERE t.bid_id = b.id) takeoff_count, (SELECT COUNT(*) FROM bid_files bf WHERE bf.bid_id = b.id) file_count FROM bids b LEFT JOIN jobs j ON j.id = b.job_id
      ORDER BY CASE WHEN b.status = 'estimating' THEN 0 ELSE 1 END, COALESCE(b.due_date, b.submitted_date) DESC, b.id DESC`)
      .map(b => ({ ...b, gcs: by.get(b.id) || [] }));
  };
  const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 864e5);

  // the numbers: same definitions as the workbook's CALCS tab, plus win rate and per-GC results
  function summary(bids, today) {
    const sent = bids.filter(b => b.submitted_date || ['waiting', 'in_progress', 'awarded', 'lost'].includes(b.status));
    const sum = list => r2(list.reduce((s, b) => s + (Number(b.bid_value) || 0), 0));
    const of = st => bids.filter(b => b.status === st);
    const won = of('awarded'), lost = of('lost');
    const decided = won.length + lost.length, decidedValue = sum(won) + sum(lost);
    const totals = {
      submitted: sent.length, submitted_value: sum(sent),
      awarded: won.length, awarded_value: sum(won), waiting: of('waiting').length, waiting_value: sum(of('waiting')),
      in_progress: of('in_progress').length, in_progress_value: sum(of('in_progress')),
      lost: lost.length, lost_value: sum(lost), no_bid: of('no_bid').length, estimating: of('estimating').length,
      win_rate: decided ? r2(won.length / decided * 100) : null, win_rate_value: decidedValue ? r2(sum(won) / decidedValue * 100) : null,
    };
    const perGc = gcs().map(g => {
      const mine = bids.filter(b => b.gcs.some(x => x.id === g.id));
      const mineSent = mine.filter(b => sent.includes(b)), w = mine.filter(b => b.status === 'awarded'), l = mine.filter(b => b.status === 'lost');
      return { id: g.id, name: g.name, active: g.active, bids: mine.length, sent: mineSent.length, sent_value: sum(mineSent),
        awarded: w.length, awarded_value: sum(w), lost: l.length, waiting: mine.filter(b => b.status === 'waiting' || b.status === 'in_progress').length,
        win_rate: w.length + l.length ? r2(w.length / (w.length + l.length) * 100) : null };
    }).filter(g => g.bids || g.active);
    const upcoming = bids.filter(b => b.status === 'estimating' && b.due_date).map(b => ({ id: b.id, days: daysBetween(today, b.due_date) }))
      .sort((a, b) => a.days - b.days);
    const checkIn = bids.filter(b => ['waiting', 'in_progress'].includes(b.status) && b.submitted_date && daysBetween(b.submitted_date, today) >= CHECK_IN_DAYS
      && (!b.checked_in_at || daysBetween(b.checked_in_at.slice(0, 10), today) >= CHECK_IN_DAYS)).map(b => b.id);
    return { totals, gcs: perGc, upcoming, check_in: checkIn, check_in_days: CHECK_IN_DAYS };
  }

  app.get('/api/estimating', only, wrap((req, res) => {
    const today = str(req.query.today).match(/^\d{4}-\d\d-\d\d$/) ? req.query.today : new Date().toISOString().slice(0, 10);
    let bids = bidsWithGcs();
    const from = str(req.query.from), to = str(req.query.to);
    const dateOf = b => b.submitted_date || b.due_date || (b.created_at || '').slice(0, 10);
    if (from) bids = bids.filter(b => b.status === 'estimating' || dateOf(b) >= from);
    if (to) bids = bids.filter(b => b.status === 'estimating' || dateOf(b) <= to);
    res.json({ bids, ...summary(bids, today), statuses: STATUSES.map(k => ({ key: k, label: STATUS_LABEL[k] })), all_gcs: gcs(), next_number: nextNumber() });
  }));

  const clean = (b, old = {}) => {
    const o = {};
    if ('project_name' in b) { o.project_name = str(b.project_name).slice(0, 200); if (!o.project_name) throw bad('Project name is required'); }
    if ('bid_number' in b) o.bid_number = str(b.bid_number).slice(0, 40) || null;
    for (const k of ['due_date', 'submitted_date']) if (k in b) {
      const v = str(b[k]); if (v && !/^\d{4}-\d\d-\d\d$/.test(v)) throw bad('Dates must be YYYY-MM-DD'); o[k] = v || null;
    }
    if ('due_time' in b) o.due_time = str(b.due_time).slice(0, 20) || null;
    if ('bid_value' in b) { const v = b.bid_value === '' || b.bid_value == null ? null : Number(String(b.bid_value).replace(/[$,]/g, '')); if (v != null && !Number.isFinite(v)) throw bad('Bid value must be a number'); o.bid_value = v; }
    if ('status' in b) { if (!STATUSES.includes(b.status)) throw bad('Unknown status'); o.status = b.status; }
    if ('notes' in b) { o.notes = str(b.notes).slice(0, 4000) || null; if ((o.notes || null) !== (old.notes || null)) o.checked_in_at = new Date().toISOString().slice(0, 19).replace('T', ' '); }
    if ('job_id' in b) o.job_id = b.job_id ? Number(b.job_id) : null;
    if ('job_kind' in b) { if (b.job_kind && !['commercial', 'residential'].includes(b.job_kind)) throw bad('Job type is commercial or residential'); o.job_kind = b.job_kind || null; }
    if (o.job_id && !get(db, 'SELECT id FROM jobs WHERE id = ?', o.job_id)) throw bad('Job not found');
    if (o.bid_number && get(db, 'SELECT id FROM bids WHERE bid_number = ? AND id != ?', o.bid_number, old.id || 0)) throw bad(`Bid ${o.bid_number} already exists`);
    // submitting a bid moves it out of "estimating"
    if (o.submitted_date && !old.submitted_date && (o.status || old.status || 'estimating') === 'estimating') o.status = 'waiting';
    return o;
  };
  const save = (id, o) => {
    const keys = Object.keys(o); if (!keys.length) return;
    run(db, `UPDATE bids SET ${keys.map(k => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`, ...keys.map(k => o[k]), id);
  };

  app.post('/api/estimating/bids', only, wrap((req, res) => {
    const b = req.body || {};
    const o = clean({ status: 'estimating', ...b, project_name: b.project_name ?? '' });
    const id = Number(run(db, 'INSERT INTO bids (project_name, created_by) VALUES (?,?)', o.project_name, req.user.id).lastInsertRowid);
    save(id, o);
    if (b.gc_ids) setGcs(id, b.gc_ids);
    res.json({ id });
  }));
  app.put('/api/estimating/bids/:id', only, wrap((req, res) => {
    const old = get(db, 'SELECT * FROM bids WHERE id = ?', +req.params.id); if (!old) throw bad('Bid not found', 404);
    save(old.id, clean(req.body || {}, old));
    if (req.body && req.body.gc_ids) setGcs(old.id, req.body.gc_ids);
    res.json({ ok: true });
  }));
  app.delete('/api/estimating/bids/:id', only, wrap((req, res) => {
    if (BF) BF.removeBidFiles(+req.params.id);   // the stored files go with it (rows cascade)
    run(db, 'DELETE FROM bids WHERE id = ?', +req.params.id); res.json({ ok: true });
  }));

  // general contractors the bids go to
  app.post('/api/estimating/gcs', only, wrap((req, res) => {
    const name = str((req.body || {}).name).slice(0, 80); if (!name) throw bad('Name is required');
    if (get(db, 'SELECT id FROM bid_gcs WHERE name = ? COLLATE NOCASE', name)) throw bad(`${name} is already on the list`);
    res.json({ id: gcIdFor(name) });
  }));
  app.put('/api/estimating/gcs/:id', only, wrap((req, res) => {
    const g = get(db, 'SELECT * FROM bid_gcs WHERE id = ?', +req.params.id); if (!g) throw bad('Not found', 404);
    const b = req.body || {};
    const name = 'name' in b ? str(b.name).slice(0, 80) : g.name; if (!name) throw bad('Name is required');
    if (get(db, 'SELECT id FROM bid_gcs WHERE name = ? COLLATE NOCASE AND id != ?', name, g.id)) throw bad(`${name} is already on the list`);
    run(db, 'UPDATE bid_gcs SET name = ?, active = ? WHERE id = ?', name, 'active' in b ? (b.active ? 1 : 0) : g.active, g.id);
    res.json({ ok: true });
  }));

  // ---------------------------------------------------------------- import the Estimating Dashboard workbook
  // Reads the DATA tab only: row 1 headers, row 2 the GC names under "Contractor", bids from row 3. Matches by bid #, so it can be re-run.
  app.post('/api/estimating/import', only, wrap((req, res) => {
    const b = req.body || {};
    if (!b.file) throw bad('Choose the Estimating Dashboard workbook (.xlsx)');
    const buf = Buffer.from(String(b.file).replace(/^data:[^,]*,/, ''), 'base64');
    if (buf.length > 20 * 1024 * 1024) throw bad('That file is over 20 MB');
    let wb; try { wb = X.read(buf); } catch (e) { throw bad(e.message); }
    const name = wb.sheetNames.find(n => n.trim().toUpperCase() === 'DATA')
      || wb.sheetNames.find(n => { const s = wb.sheet(n); for (let c = 1; c <= 30; c++) if (/bid number/i.test(str(s.val(1, c)))) return true; return false; });
    if (!name) throw bad('No DATA tab with a "Bid Number" column in that workbook');
    const sh = wb.sheet(name);
    const col = {}; let maxCol = 0;
    for (let c = 1; c <= 60; c++) { const h = str(sh.val(1, c)).toLowerCase(); if (h) { maxCol = c; col[h] = col[h] || c; } }
    const find = re => { const k = Object.keys(col).find(h => re.test(h)); return k ? col[k] : null; };
    const C = { due: find(/due/), number: find(/bid (number|#|no)/), project: find(/project/), gc: find(/contractor|^gc/), submitted: find(/submitted/),
      value: find(/value|amount/), status: find(/status/), notes: find(/check|note/) };
    if (!C.project) throw bad('No "Project Name" column on the DATA tab');
    const gcEnd = C.gc ? Math.min(...[C.submitted, C.value, C.status, C.notes].filter(c => c && c > C.gc), maxCol + 1) : null;
    const gcCols = [];
    if (C.gc) for (let c = C.gc; c < gcEnd; c++) { const n = str(sh.val(2, c)); if (n) gcCols.push({ c, id: gcIdFor(n) }); }
    const dataStart = C.gc && gcCols.length ? 3 : 2;
    const out = { created: 0, updated: 0, skipped: 0, gcs: gcCols.length, warnings: [] };
    for (let r = dataStart; r <= sh.maxRow; r++) {
      const project = str(sh.val(r, C.project)), number = C.number ? str(sh.val(r, C.number)) : '';
      if (!project && !number) continue;
      if (!project) { out.skipped++; out.warnings.push(`Row ${r}: bid ${number} has no project name; skipped`); continue; }
      const rawStatus = C.status ? str(sh.val(r, C.status)) : '';
      let status = statusOf(rawStatus);
      if (!status) { out.warnings.push(`Row ${r}: status "${rawStatus}" not recognised; set to Waiting`); status = 'waiting'; }
      const val = C.value ? sh.val(r, C.value) : null;
      const data = {
        project_name: project.slice(0, 200), bid_number: number.replace(/\.0+$/, '').slice(0, 40) || null,
        due_date: C.due ? X.dateOf(sh.val(r, C.due)) : null, submitted_date: C.submitted ? X.dateOf(sh.val(r, C.submitted)) : null,
        bid_value: typeof val === 'number' ? val : val ? Number(String(val).replace(/[$,]/g, '')) || null : null,
        status, notes: C.notes ? str(sh.val(r, C.notes)).slice(0, 4000) || null : null,
      };
      if (data.status === 'estimating' && data.submitted_date) data.status = 'waiting';
      const sentTo = gcCols.filter(g => /^x$|^y(es)?$|^1$|✓|✔/i.test(str(sh.val(r, g.c)))).map(g => g.id);
      const existing = data.bid_number ? get(db, 'SELECT * FROM bids WHERE bid_number = ?', data.bid_number) : get(db, 'SELECT * FROM bids WHERE bid_number IS NULL AND project_name = ?', data.project_name);
      let id;
      if (existing) { id = existing.id; save(id, data); out.updated++; }
      else { id = Number(run(db, 'INSERT INTO bids (project_name, created_by) VALUES (?,?)', data.project_name, req.user.id).lastInsertRowid); save(id, data); out.created++; }
      setGcs(id, sentTo);
    }
    res.json(out);
  }));
};
module.exports.STATUSES = STATUSES;
module.exports.statusOf = statusOf;
