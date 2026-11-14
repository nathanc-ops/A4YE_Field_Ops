'use strict';
// Commercial bids: a file cabinet per bid whose folders mirror the company's Google Drive project template
// (Commercial Estimating → Bid folders). Any file type — sent one file at a time as raw bytes. Only PDFs and photos
// (recognised from their bytes) ever open in the browser; everything else is served as a plain download.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const D = require('./db');
const { all, get, run, settings } = D;

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'data', 'uploads');
const MAX_FILE = 150 * 1024 * 1024;   // the raw upload route accepts 160 MB
// The Drive template every bid/project folder is copied from (folder names only; "/" separates levels)
const DEFAULT_FOLDERS = [
  '001 - Precon', '001 - Precon/001 - Customer Supplied Documents', '001 - Precon/002 - Vendor Quotes', '001 - Precon/003 - Estimate',
  '001 - Precon/004 - Proposal', '001 - Precon/005 - RFI',
  '002 - Safety', '003 - Company Admin & Staffing',
  '004 - Project Docs', '004 - Project Docs/001 - Specs', '004 - Project Docs/002 - Contracts', '004 - Project Docs/003 - Submittals',
  '004 - Project Docs/003 - Submittals/00 - PENDING', '004 - Project Docs/003 - Submittals/01 - APPROVED', '004 - Project Docs/003 - Submittals/03 - ARCHIVE',
  '004 - Project Docs/004 - POs',
  '005 - Schedules', '006 - QA-QC', '007 - Warranty', '008 - Fleet & Tooling',
];
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });

// a folder path from the browser: trimmed parts, no "..", no empty levels
function cleanFolder(f) {
  const parts = String(f || '').split('/').map(p => p.replace(/[\\<>:"|?*\u0000-\u001f]/g, '').trim()).filter(p => p && p !== '.' && p !== '..');
  if (!parts.length) throw bad('Pick a folder');
  if (parts.some(p => p.length > 80) || parts.length > 6) throw bad('Folder name too long');
  return parts.join('/');
}
function template(db) {
  const raw = settings(db).bid_folder_template;
  const list = raw ? String(raw).split(/\r?\n/).map(s => s.trim()).filter(Boolean) : DEFAULT_FOLDERS;
  const out = new Set();
  for (const f of list) { try { const c = cleanFolder(f); const parts = c.split('/'); parts.forEach((_, i) => out.add(parts.slice(0, i + 1).join('/'))); } catch { /* skip a bad line */ } }
  return [...out];
}

// What a file really is, from its bytes (and, for Office files, its name): PDF, Word, Excel, or a photo
function kindOf(buf, filename) {
  const ext = (String(filename).match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase() || '';
  if (buf.subarray(0, 5).toString() === '%PDF-') return { mime: 'application/pdf', ext: 'pdf' };
  if (buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) {          // zip: modern Office
    const head = buf.subarray(0, Math.min(buf.length, 64 * 1024)).toString('latin1');
    if (/word\//.test(head) || ext === 'docx') return { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', ext: 'docx' };
    if (/xl\//.test(head) || ext === 'xlsx' || ext === 'xlsm') return ext === 'xlsm'
      ? { mime: 'application/vnd.ms-excel.sheet.macroEnabled.12', ext: 'xlsm' }
      : { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: 'xlsx' };
    return null;
  }
  if (buf.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) {   // old Office (.doc / .xls)
    if (ext === 'doc') return { mime: 'application/msword', ext: 'doc' };
    if (ext === 'xls') return { mime: 'application/vnd.ms-excel', ext: 'xls' };
    return null;
  }
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  if (buf[0] === 0x89 && buf.subarray(1, 4).toString() === 'PNG') return { mime: 'image/png', ext: 'png' };
  return null;
}

module.exports = function bidFiles(app, db, { wrap }) {
  const only = (req, res, next) => ['admin', 'manager'].includes(req.user.role) ? next() : res.status(403).json({ error: 'Bid files are for admins and managers' });
  const bidOf = id => { const b = get(db, 'SELECT id, bid_number, project_name, job_id FROM bids WHERE id = ?', +id); if (!b) throw bad('Not found', 404); return b; };
  // every folder the bid has: the template, folders added on this bid, and folders its files are in
  const foldersOf = bidId => {
    const out = new Set(template(db));
    const more = [...all(db, 'SELECT folder FROM bid_folders WHERE bid_id = ?', bidId).map(r => r.folder), ...all(db, 'SELECT DISTINCT folder FROM bid_files WHERE bid_id = ?', bidId).map(r => r.folder)];
    for (const f of more) { const p = f.split('/'); p.forEach((_, i) => out.add(p.slice(0, i + 1).join('/'))); }
    return [...out];
  };
  // a folder with the same name (any letter case) at the same level is the same folder: use the one already there
  const sameFolder = (bidId, folder) => {
    const have = new Map(foldersOf(bidId).map(f => [f.toLowerCase(), f]));
    const parts = folder.split('/'); let cur = '';
    for (const p of parts) { const next = cur ? `${cur}/${p}` : p; cur = have.get(next.toLowerCase()) || next; }
    return cur;
  };
  const fileOf = (bid, fid) => { const f = get(db, 'SELECT * FROM bid_files WHERE id = ? AND bid_id = ?', +fid, bid.id); if (!f) throw bad('Not found', 404); return f; };

  app.get('/api/estimating/bids/:id/files', only, wrap((req, res) => {
    const b = bidOf(req.params.id);
    const files = all(db, `SELECT f.id, f.folder, f.filename, f.mime, f.size, f.created_at, u.name user_name FROM bid_files f
      LEFT JOIN users u ON u.id = f.user_id WHERE f.bid_id = ? ORDER BY lower(f.filename)`, b.id);
    res.json({ bid: b, folders: foldersOf(b.id).sort((x, y) => x.localeCompare(y, undefined, { numeric: true })), files, max_mb: MAX_FILE / 1048576 });
  }));
  // one file, raw bytes in the body (?folder=…&filename=…)
  app.post('/api/estimating/bids/:id/files', only, wrap((req, res) => {
    const b = bidOf(req.params.id);
    const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const filename = String(req.query.filename || 'file').replace(/[\\/\u0000-\u001f]/g, '_').slice(0, 200);
    if (!buf.length) throw bad(`${filename} is empty`);
    if (buf.length > MAX_FILE) throw bad(`${filename} is larger than ${MAX_FILE / 1048576} MB`);
    // any file is kept; types we recognise get their real type, the rest are stored as plain bytes (download only)
    const k = kindOf(buf, filename) || { mime: 'application/octet-stream', ext: ((filename.match(/\.([a-z0-9]{1,8})$/i) || [])[1] || 'bin').toLowerCase() };
    const folder = sameFolder(b.id, cleanFolder(req.query.folder));
    const rel = path.join('bids', String(b.id), `${crypto.randomBytes(12).toString('hex')}.${k.ext}`);
    fs.mkdirSync(path.join(UPLOAD_DIR, 'bids', String(b.id)), { recursive: true });
    fs.writeFileSync(path.join(UPLOAD_DIR, rel), buf);
    // a file with the same name in the same folder is replaced (the new copy wins)
    const old = get(db, 'SELECT id, path FROM bid_files WHERE bid_id = ? AND folder = ? AND lower(filename) = ?', b.id, folder, filename.toLowerCase());
    let id;
    if (old) {
      run(db, "UPDATE bid_files SET filename = ?, mime = ?, size = ?, path = ?, user_id = ?, created_at = datetime('now') WHERE id = ?", filename, k.mime, buf.length, rel, req.user.id, old.id);
      try { fs.unlinkSync(path.join(UPLOAD_DIR, old.path)); } catch { /* already gone */ }
      id = old.id;
    } else id = Number(run(db, 'INSERT INTO bid_files (bid_id, folder, filename, mime, size, path, user_id) VALUES (?,?,?,?,?,?,?)',
      b.id, folder, filename, k.mime, buf.length, rel, req.user.id).lastInsertRowid);
    res.json({ id, folder, mime: k.mime, replaced: !!old });
  }));
  app.get('/api/estimating/bids/:id/files/:fid', only, wrap((req, res) => {
    const f = fileOf(bidOf(req.params.id), req.params.fid);
    const inline = req.query.download ? 'attachment' : (/^(application\/pdf|image\/)/.test(f.mime) ? 'inline' : 'attachment');
    res.setHeader('Content-Type', f.mime);
    res.setHeader('Content-Disposition', `${inline}; filename*=UTF-8''${encodeURIComponent(f.filename)}`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.sendFile(path.join(UPLOAD_DIR, f.path), err => { if (err && !res.headersSent) res.status(404).json({ error: 'The file is missing on the server' }); });
  }));
  // move to another folder and/or rename
  app.put('/api/estimating/bids/:id/files/:fid', only, wrap((req, res) => {
    const f = fileOf(bidOf(req.params.id), req.params.fid);
    const folder = req.body.folder !== undefined ? cleanFolder(req.body.folder) : f.folder;
    let name = req.body.filename !== undefined ? String(req.body.filename).replace(/[\\/\u0000-\u001f]/g, '_').trim().slice(0, 200) : f.filename;
    if (!name) throw bad('Give the file a name');
    const ext = (f.filename.match(/\.[a-z0-9]+$/i) || [''])[0];
    if (ext && !name.toLowerCase().endsWith(ext.toLowerCase())) name += ext;   // keep the extension so it still opens
    run(db, 'UPDATE bid_files SET folder = ?, filename = ? WHERE id = ?', folder, name, f.id);
    res.json({ ok: true, folder, filename: name });
  }));
  app.delete('/api/estimating/bids/:id/files/:fid', only, wrap((req, res) => {
    const f = fileOf(bidOf(req.params.id), req.params.fid);
    run(db, 'DELETE FROM bid_files WHERE id = ?', f.id);
    try { fs.unlinkSync(path.join(UPLOAD_DIR, f.path)); } catch { /* already gone */ }
    res.json({ ok: true });
  }));
  // an extra folder on this bid only (the template is in Settings)
  app.post('/api/estimating/bids/:id/folders', only, wrap((req, res) => {
    const b = bidOf(req.params.id);
    const list = (Array.isArray(req.body.folders) ? req.body.folders : [req.body.folder]).slice(0, 500);
    const made = list.map(f => {
      const folder = sameFolder(b.id, cleanFolder(f));
      if (!foldersOf(b.id).includes(folder)) run(db, 'INSERT OR IGNORE INTO bid_folders (bid_id, folder) VALUES (?,?)', b.id, folder);
      return folder;
    });
    res.json({ ok: true, folder: made[0], folders: made });
  }));
  app.get('/api/estimating/bid-folders', only, (req, res) => res.json({ folders: template(db), default: DEFAULT_FOLDERS, custom: !!settings(db).bid_folder_template }));
  // the bid behind a project (for its Files button)
  app.get('/api/estimating/bid-for-job/:jobId', only, wrap((req, res) => res.json(get(db, 'SELECT id, bid_number, project_name FROM bids WHERE job_id = ? ORDER BY id DESC LIMIT 1', +req.params.jobId) || null)));
  // files go with a deleted bid
  return { removeBidFiles: bidId => { for (const f of all(db, 'SELECT path FROM bid_files WHERE bid_id = ?', bidId)) { try { fs.unlinkSync(path.join(UPLOAD_DIR, f.path)); } catch { /* gone */ } } } };
};
module.exports.DEFAULT_FOLDERS = DEFAULT_FOLDERS;
module.exports.kindOf = kindOf;
module.exports.cleanFolder = cleanFolder;
