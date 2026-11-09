'use strict';
// Field tools: job photos & files, checklists (forms), customer sign-off, equipment records.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { all, get, run } = require('./db');

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'data', 'uploads');
// Only formats a browser can show safely. SVG/HTML are excluded on purpose (they can carry scripts).
const MIME_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'application/pdf': 'pdf' };
const MAX_BYTES = 10 * 1024 * 1024;
// magic numbers, so a renamed file can't pretend to be an image
const sniff = buf => buf[0] === 0xff && buf[1] === 0xd8 ? 'image/jpeg'
  : buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ? 'image/png'
  : buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP' ? 'image/webp'
  : buf.slice(4, 12).toString().startsWith('ftyphei') || buf.slice(4, 12).toString().startsWith('ftypmif') ? 'image/heic'
  : buf.slice(0, 5).toString() === '%PDF-' ? 'application/pdf' : null;

const EQUIP_TYPES = ['panel', 'subpanel', 'meter', 'service_disconnect', 'transfer_switch', 'generator', 'ev_charger', 'surge_protector', 'solar_inverter', 'battery', 'other'];

module.exports = function routesField(app, db, X) {
  const { wrap, bad, office, admin, pick, insert, update, mustGet, H } = X;

  // ------------------------------------------------------------ access
  const assigned = (user, jobId) => !!get(db, 'SELECT 1 x FROM job_techs WHERE job_id = ? AND user_id = ?', jobId, user.id);
  function jobFor(user, jobId) {
    const job = mustGet('jobs', jobId);
    if (user.role === 'tech' && !assigned(user, job.id)) throw bad('Not assigned to this job', 403);
    return job;
  }
  // which job (if any) an attachment's entity belongs to, for tech permission checks
  function entityJobIds(type, id) {
    if (type === 'job') return [Number(id)];
    const locId = type === 'location' ? id : (get(db, 'SELECT location_id FROM equipment WHERE id = ?', id) || {}).location_id;
    return all(db, 'SELECT id FROM jobs WHERE location_id = ?', locId).map(r => r.id);
  }
  function checkEntity(user, type, id) {
    if (!['job', 'location', 'equipment'].includes(type)) throw bad('Unknown attachment target');
    if (type === 'job') mustGet('jobs', id);
    if (type === 'location') mustGet('locations', id);
    if (type === 'equipment') mustGet('equipment', id);
    if (user.role === 'tech' && !entityJobIds(type, id).some(j => assigned(user, j))) throw bad('Not assigned to a job here', 403);
  }

  // ------------------------------------------------------------ files
  function saveFile({ data, mime, filename }) {
    const m = /^data:([^;]+);base64,(.*)$/s.exec(String(data || ''));
    const buf = Buffer.from(m ? m[2] : String(data || ''), 'base64');
    if (!buf.length) throw bad('File is empty');
    if (buf.length > MAX_BYTES) throw bad('File is larger than 10 MB');
    const real = sniff(buf);
    if (!real || !MIME_EXT[real]) throw bad('Only JPEG, PNG, WEBP, HEIC photos and PDF files are allowed');
    const sub = new Date().toISOString().slice(0, 7);
    const rel = path.join(sub, `${crypto.randomBytes(12).toString('hex')}.${MIME_EXT[real]}`);
    fs.mkdirSync(path.join(UPLOAD_DIR, sub), { recursive: true });
    fs.writeFileSync(path.join(UPLOAD_DIR, rel), buf);
    return { path: rel, mime: real, size: buf.length, filename: String(filename || `upload.${MIME_EXT[real]}`).slice(0, 200) };
  }
  H.removeUpload = rel => { try { fs.unlinkSync(path.join(UPLOAD_DIR, rel)); } catch { /* already gone */ } };
  H.saveAttachment = (user, { entity_type, entity_id, kind, tag, caption, lat, lng, data, mime, filename }) => {
    const f = saveFile({ data, mime, filename });
    return insert('attachments', { entity_type, entity_id: Number(entity_id), kind: kind || (f.mime === 'application/pdf' ? 'document' : 'photo'), tag: tag || null,
      caption: caption || null, lat: lat ?? null, lng: lng ?? null, user_id: user.id, ...f });
  };
  const attachmentRows = (type, id) => all(db, `SELECT a.id, a.entity_type, a.entity_id, a.kind, a.tag, a.filename, a.mime, a.size, a.caption, a.lat, a.lng, a.created_at, u.name user_name
    FROM attachments a LEFT JOIN users u ON u.id = a.user_id WHERE a.entity_type = ? AND a.entity_id = ? ORDER BY a.id DESC`, type, id);
  H.jobAttachments = jobId => attachmentRows('job', jobId);

  app.get('/api/attachments', wrap((req, res) => {
    checkEntity(req.user, req.query.entity_type, Number(req.query.entity_id));
    res.json(attachmentRows(req.query.entity_type, Number(req.query.entity_id)));
  }));
  app.post('/api/attachments', wrap((req, res) => {
    const b = req.body;
    checkEntity(req.user, b.entity_type, Number(b.entity_id));
    res.json({ id: H.saveAttachment(req.user, { ...b, kind: b.kind === 'signature' ? 'photo' : b.kind }) });
  }));
  app.get('/api/attachments/:id/file', wrap((req, res) => {
    const a = mustGet('attachments', req.params.id);
    checkEntity(req.user, a.entity_type, a.entity_id);
    const full = path.join(UPLOAD_DIR, a.path);
    if (!full.startsWith(path.resolve(UPLOAD_DIR)) || !fs.existsSync(full)) throw bad('File missing', 404);
    res.set({ 'Content-Type': a.mime, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, max-age=86400',
      'Content-Disposition': `inline; filename="${String(a.filename || 'file').replace(/[^\w.\- ]/g, '_')}"` });
    res.send(fs.readFileSync(full));
  }));
  app.put('/api/attachments/:id', wrap((req, res) => {
    const a = mustGet('attachments', req.params.id);
    checkEntity(req.user, a.entity_type, a.entity_id);
    update('attachments', a.id, pick(req.body, ['caption', 'tag']));
    res.json({ ok: true });
  }));
  app.delete('/api/attachments/:id', wrap((req, res) => {
    const a = mustGet('attachments', req.params.id);
    if (a.kind === 'signature') throw bad('Customer signatures cannot be deleted');
    // techs may remove only their own uploads; office may remove any
    if (req.user.role === 'tech' && a.user_id !== req.user.id) throw bad('You can only delete photos you took', 403);
    run(db, 'DELETE FROM attachments WHERE id = ?', a.id);
    try { fs.unlinkSync(path.join(UPLOAD_DIR, a.path)); } catch { /* already gone */ }
    res.json({ ok: true });
  }));

  // ------------------------------------------------------------ checklists
  const parseForm = f => ({ ...f, items: JSON.parse(f.items), answers: JSON.parse(f.answers || '{}') });
  const missingRequired = f => f.items.map((it, i) => ({ it, i })).filter(({ it, i }) => {
    if (!it.required) return false;
    const v = f.answers[i];
    return it.type === 'check' ? v !== true : v == null || v === '';
  }).map(({ it }) => it.label);
  // attach every active template that matches the job type (once per template)
  H.ensureJobForms = jobId => {
    const job = get(db, 'SELECT id, job_type, status FROM jobs WHERE id = ?', jobId);
    if (['completed', 'invoiced', 'cancelled'].includes(job.status)) return; // don't back-fill finished work
    for (const t of all(db, 'SELECT * FROM form_templates WHERE active = 1 ORDER BY sort, id')) {
      const types = t.job_types.split(',').map(s => s.trim());
      if (!types.includes('*') && !types.includes(job.job_type)) continue;
      run(db, 'INSERT OR IGNORE INTO job_forms (job_id, template_id, name, items, required_for_completion) VALUES (?,?,?,?,?)', job.id, t.id, t.name, t.items, t.required_for_completion);
    }
  };
  H.jobForms = jobId => all(db, 'SELECT f.*, u.name completed_by_name FROM job_forms f LEFT JOIN users u ON u.id = f.completed_by WHERE job_id = ? ORDER BY f.id', jobId).map(parseForm);
  // Required checklists that aren't finished — blocks completion for techs.
  // (attach first, so a job nobody opened can't skip its required lists)
  H.completionBlockers = jobId => { H.ensureJobForms(jobId); return H.jobForms(jobId).filter(f => f.required_for_completion && !f.completed_at).map(f => f.name); };

  app.get('/api/form-templates', wrap((req, res) => res.json(all(db, `SELECT * FROM form_templates ${req.query.all ? '' : 'WHERE active = 1'} ORDER BY sort, id`).map(t => ({ ...t, items: JSON.parse(t.items) })))));
  function cleanItems(items) {
    if (!Array.isArray(items) || !items.length) throw bad('Add at least one checklist item');
    return JSON.stringify(items.filter(i => i && i.label).map(i => ({ label: String(i.label).slice(0, 300), type: ['check', 'passfail', 'text', 'number'].includes(i.type) ? i.type : 'check', required: !!i.required })));
  }
  app.post('/api/form-templates', office, wrap((req, res) => {
    if (!req.body.name) throw bad('Name is required');
    res.json({ id: insert('form_templates', { ...pick(req.body, ['name', 'job_types', 'required_for_completion', 'active', 'sort']), items: cleanItems(req.body.items) }) });
  }));
  app.put('/api/form-templates/:id', office, wrap((req, res) => {
    const data = pick(req.body, ['name', 'job_types', 'required_for_completion', 'active', 'sort']);
    if (req.body.items) data.items = cleanItems(req.body.items);
    update('form_templates', req.params.id, data); res.json({ ok: true });
  }));
  app.get('/api/jobs/:id/forms', wrap((req, res) => { const job = jobFor(req.user, req.params.id); H.ensureJobForms(job.id); res.json(H.jobForms(job.id)); }));
  app.post('/api/jobs/:id/forms', office, wrap((req, res) => {
    const job = mustGet('jobs', req.params.id); const t = mustGet('form_templates', req.body.template_id);
    run(db, 'INSERT OR IGNORE INTO job_forms (job_id, template_id, name, items, required_for_completion) VALUES (?,?,?,?,?)', job.id, t.id, t.name, t.items, t.required_for_completion);
    res.json({ ok: true });
  }));
  app.put('/api/job-forms/:id', wrap((req, res) => {
    const f = parseForm(mustGet('job_forms', req.params.id));
    jobFor(req.user, f.job_id);
    if (f.completed_at && !req.body.reopen) throw bad('Checklist is complete — reopen it to change answers');
    const answers = req.body.answers && typeof req.body.answers === 'object' ? req.body.answers : f.answers;
    const next = { ...f, answers };
    let completed_at = null, completed_by = null;
    if (req.body.complete) {
      const miss = missingRequired(next);
      if (miss.length) throw bad(`Finish the required items first: ${miss.slice(0, 3).join('; ')}${miss.length > 3 ? ` (+${miss.length - 3} more)` : ''}`);
      completed_at = new Date().toISOString(); completed_by = req.user.id;
    }
    run(db, "UPDATE job_forms SET answers = ?, completed_at = ?, completed_by = ?, updated_at = datetime('now'), updated_by = ? WHERE id = ?",
      JSON.stringify(answers), completed_at, completed_by, req.user.id, f.id);
    res.json({ ok: true, failed: next.items.filter((it, i) => it.type === 'passfail' && answers[i] === 'fail').map(it => it.label) });
  }));
  app.delete('/api/job-forms/:id', office, wrap((req, res) => { run(db, 'DELETE FROM job_forms WHERE id = ?', req.params.id); res.json({ ok: true }); }));

  // ------------------------------------------------------------ completion + customer sign-off
  // Marks the job complete. Techs must finish required checklists; office can override (recorded in a note).
  app.post('/api/jobs/:id/complete', wrap((req, res) => {
    const job = jobFor(req.user, req.params.id);
    if (['invoiced', 'cancelled'].includes(job.status)) throw bad(`Job is already ${job.status}`);
    const blockers = H.completionBlockers(job.id);
    if (blockers.length && req.user.role === 'tech') throw bad(`Finish the required checklist(s) first: ${blockers.join(', ')}`);
    const b = req.body;
    let sigId = null;
    if (b.signature) {
      if (!String(b.signoff_name || '').trim()) throw bad('Type the customer’s name with their signature');
      sigId = H.saveAttachment(req.user, { entity_type: 'job', entity_id: job.id, kind: 'signature', tag: 'signoff', data: b.signature, filename: 'customer-signature.png', lat: b.lat, lng: b.lng, caption: `Signed by ${b.signoff_name}` });
    }
    run(db, `UPDATE jobs SET status = 'completed', completed_at = COALESCE(completed_at, ?), completion_notes = COALESCE(?, completion_notes),
      signoff_name = COALESCE(?, signoff_name), signoff_at = CASE WHEN ? IS NOT NULL THEN ? ELSE signoff_at END,
      signoff_attachment_id = COALESCE(?, signoff_attachment_id), signoff_note = COALESCE(?, signoff_note) WHERE id = ?`,
    new Date().toISOString(), b.completion_notes || null, sigId ? b.signoff_name.trim() : null, sigId, new Date().toISOString(), sigId, b.signoff_note || null, job.id);
    if (blockers.length) insert('job_notes', { job_id: job.id, user_id: req.user.id, body: `Completed by office without these checklists: ${blockers.join(', ')}` });
    // close out today's visits for this tech's job
    run(db, "UPDATE appointments SET status = 'done' WHERE job_id = ? AND status IN ('on_site','en_route','dispatched','scheduled') AND start <= ?", job.id, new Date().toISOString());
    if (req.user.role === 'tech') run(db, 'UPDATE time_entries SET clock_out = ?, out_lat = ?, out_lng = ?, out_acc = ? WHERE user_id = ? AND clock_out IS NULL AND job_id = ?',
      new Date().toISOString(), b.lat ?? null, b.lng ?? null, b.acc ?? null, req.user.id, job.id);
    res.json({ ok: true, overridden: blockers });
  }));

  // ------------------------------------------------------------ equipment
  const EQ = ['location_id', 'type', 'make', 'model', 'serial', 'amps', 'voltage', 'install_date', 'warranty_until', 'installed_job_id', 'status', 'notes'];
  H.locationEquipment = locId => all(db, `SELECT e.*, j.number installed_job_number, (SELECT COUNT(*) FROM attachments a WHERE a.entity_type = 'equipment' AND a.entity_id = e.id) photo_count
    FROM equipment e LEFT JOIN jobs j ON j.id = e.installed_job_id WHERE e.location_id = ? ORDER BY e.status, e.type, e.id`, locId);
  app.get('/api/equipment', wrap((req, res) => {
    checkEntity(req.user, 'location', Number(req.query.location_id));
    res.json(H.locationEquipment(Number(req.query.location_id)));
  }));
  app.post('/api/equipment', wrap((req, res) => {
    checkEntity(req.user, 'location', Number(req.body.location_id));
    if (req.body.type && !EQUIP_TYPES.includes(req.body.type)) throw bad('Unknown equipment type');
    res.json({ id: insert('equipment', { ...pick(req.body, EQ), created_by: req.user.id }) });
  }));
  app.put('/api/equipment/:id', wrap((req, res) => {
    const e = mustGet('equipment', req.params.id);
    checkEntity(req.user, 'equipment', e.id);
    update('equipment', e.id, pick(req.body, EQ.filter(k => k !== 'location_id'))); res.json({ ok: true });
  }));
  app.delete('/api/equipment/:id', office, wrap((req, res) => { run(db, 'DELETE FROM equipment WHERE id = ?', req.params.id); res.json({ ok: true }); }));
};
module.exports.EQUIP_TYPES = EQUIP_TYPES;
