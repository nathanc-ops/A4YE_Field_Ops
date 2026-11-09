'use strict';
// Admin data import: CSV files from the old system, plus a folder of job photos.
const fs = require('node:fs');
const path = require('node:path');
const { all, get, run } = require('./db');
const I = require('./importer');

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'data', 'uploads');

module.exports = function routesImport(app, db, X) {
  const { wrap, bad, admin, H } = X;

  app.get('/api/import/types', admin, wrap((req, res) => res.json(I.describe())));
  app.post('/api/import/preview', admin, wrap((req, res) => res.json(I.preview(req.body.type, req.body.csv))));
  // dry_run: true runs everything and rolls it back, so the report shows exactly what would happen
  app.post('/api/import/run', admin, wrap((req, res) => {
    const b = req.body || {};
    res.json(I.runImport(db, { type: b.type, text: b.csv, mapping: b.mapping, options: b.options || {}, filename: b.filename, userId: req.user.id, dryRun: !!b.dry_run, H }));
  }));
  app.get('/api/import/batches', admin, wrap((req, res) => res.json(I.listBatches(db))));
  app.post('/api/import/batches/:id/undo', admin, wrap((req, res) => {
    res.json(I.undoBatch(db, Number(req.params.id), { removeFile: p => { try { fs.unlinkSync(path.join(UPLOAD_DIR, p)); } catch { /* already gone */ } } }));
  }));

  // ------------------------------------------------------------ photos
  // Which job a photo belongs to, from its folder names and file name: "J-1068/panel.jpg",
  // "12345 - Smith/before 1.jpg", "J-1068_after.jpg". Falls back to a customer folder → their first address.
  function targetFor(relPath) {
    const parts = String(relPath || '').split(/[\\/]+/).filter(Boolean);
    const file = (parts.pop() || '').replace(/\.[^.]+$/, '');
    const segs = [...parts.reverse(), file]; // nearest folder first
    for (const s of segs) {
      const exact = I.jobByNumber(db, s.trim());
      if (exact) return { type: 'job', id: exact.id, label: exact.number };
      // job number at the start of the name, followed by a separator
      const hit = all(db, "SELECT id, number FROM jobs WHERE ? LIKE number || '%' ORDER BY length(number) DESC LIMIT 5", s.trim())
        .find(j => !/[a-z0-9]/i.test(s.trim().charAt(j.number.length)));
      if (hit) return { type: 'job', id: hit.id, label: hit.number };
    }
    for (const s of segs.slice(0, -1)) {
      const c = I.findCustomer(db, { customer_name: s.replace(/^\d+\s*[-_]\s*/, '').trim() });
      const loc = c && get(db, 'SELECT id FROM locations WHERE customer_id = ? ORDER BY id LIMIT 1', c.id);
      if (loc) return { type: 'location', id: loc.id, label: c.name };
    }
    return null;
  }
  const tagFor = p => { const s = String(p).toLowerCase(); return ['before', 'during', 'after', 'panel', 'permit'].find(t => s.includes(t)) || 'other'; };

  app.post('/api/import/photos/start', admin, wrap((req, res) => {
    const id = Number(run(db, "INSERT INTO import_batches (type, filename, user_id) VALUES ('photos', ?, ?)", String(req.body.folder || 'Photos').slice(0, 200), req.user.id).lastInsertRowid);
    res.json({ batch_id: id });
  }));
  // test where a list of paths would land without uploading anything
  app.post('/api/import/photos/match', admin, wrap((req, res) => {
    res.json((req.body.paths || []).slice(0, 5000).map(p => ({ path: p, target: targetFor(p) })));
  }));
  app.post('/api/import/photos', admin, wrap((req, res) => {
    const b = req.body || {};
    const batch = get(db, "SELECT * FROM import_batches WHERE id = ? AND type = 'photos' AND undone_at IS NULL", Number(b.batch_id));
    if (!batch) throw bad('Start the photo import first');
    const target = targetFor(b.path || b.filename);
    const note = m => {
      const w = JSON.parse(batch.warnings || '[]'); if (w.length < 300) w.push({ row: null, message: m });
      run(db, 'UPDATE import_batches SET skipped_count = skipped_count + 1, warnings = ? WHERE id = ?', JSON.stringify(w), batch.id);
    };
    if (!target) { note(`${b.path}: no job number or customer found in the folder or file name`); return res.json({ ok: false, reason: 'no_match' }); }
    let id;
    try { id = H.saveAttachment(req.user, { entity_type: target.type, entity_id: target.id, tag: tagFor(b.path), caption: path.basename(String(b.path || '')).slice(0, 200), data: b.data, filename: b.filename }); }
    catch (e) { note(`${b.path}: ${e.message}`); return res.json({ ok: false, reason: e.message }); }
    run(db, 'INSERT INTO import_records (batch_id, entity, entity_id) VALUES (?,?,?)', batch.id, 'attachment', id);
    run(db, 'UPDATE import_batches SET created_count = created_count + 1 WHERE id = ?', batch.id);
    res.json({ ok: true, id, target });
  }));
};
