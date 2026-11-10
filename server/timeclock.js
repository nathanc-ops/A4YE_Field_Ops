'use strict';
// Sync from the A4Y Time Clock (Google Sheet "A4Y Time Clock", tab "Time Entries").
//
// Two ways in, same rules:
//  - Automatic: a small read-only Apps Script web app (docs/timeclock-export.gs) returns the Time Entries and
//    Cost Codes tabs as JSON; Settings → A4Y Time Clock holds its URL and key, and the server pulls hourly.
//  - By hand: Import Data → "Time clock entries" with a CSV download of the Time Entries tab.
//
// Rules:
//  - Entry ID is the key: syncing again updates entries instead of duplicating them.
//  - Employee: matched by the time clock's Employee ID (Team → person → Time clock ID), else by exact name.
//    Someone the app doesn't know yet is added as an inactive Technician (no login) so hours aren't lost.
//    PINs and pay rates are never read.
//  - Job #: matched to a job's "Time clock job #" (or its job number). 0000 Shop / Office is shop time.
//    Unmatched numbers are kept on the entry and link automatically once a job gets that number.
//  - Cost code: "0810-L" is filed under 0810. Unknown codes are added.
//  - Times are the time clock's local time (Settings → time zone, default America/Boise).
//    Hours come from the time clock's own Hours column (it applies its own lunch rules).
const D = require('./db');
const { all, get, run, tx } = D;
const crypto = require('node:crypto');

const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
const money = v => { const n = Number(String(v ?? '').replace(/[$,\s]/g, '').replace(/^\((.*)\)$/, '-$1')); return Number.isFinite(n) ? n : null; };

// "9/11/2026 6:45 AM" / "Fri 9/11/2026" / "2026-09-11 06:45" / Date objects from Apps Script (ISO strings) → parts
function parseLocal(v) {
  if (v == null || v === '') return null;
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}T.*(Z|[+-]\d{2}:?\d{2})$/.test(s)) return { iso: new Date(s).toISOString() }; // already absolute
  let m = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?)?/);
  let y, mo, d, h = 0, mi = 0;
  if (m) { mo = +m[1]; d = +m[2]; y = +m[3] < 100 ? 2000 + +m[3] : +m[3]; if (m[4] != null) { h = +m[4]; mi = +m[5]; if (m[7]) { const pm = /p/i.test(m[7]); if (h === 12) h = pm ? 12 : 0; else if (pm) h += 12; } } }
  else if ((m = s.match(/(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/))) { y = +m[1]; mo = +m[2]; d = +m[3]; if (m[4] != null) { h = +m[4]; mi = +m[5]; } }
  else return null;
  return { y, mo, d, h, mi, hasTime: /\d:\d{2}/.test(s) };
}
// wall-clock time in a time zone → UTC ISO (handles daylight saving)
function zonedToUtc({ y, mo, d, h = 0, mi = 0 }, tz) {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const offsetAt = t => {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      .formatToParts(new Date(t)).filter(x => x.type !== 'literal').map(x => [x.type, +x.value]));
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - t;
  };
  let t = guess - offsetAt(guess);
  t = guess - offsetAt(t); // second pass settles DST edges
  return new Date(t).toISOString();
}
const toUtc = (v, tz) => { const p = parseLocal(v); if (!p) return null; return p.iso || zonedToUtc(p, tz); };

// normalise one row from either source to { id, employee_id, employee, date, start, end, hours, job, job_name, category, code, code_desc, note, source, updated, labor }
const pickKey = (row, ...names) => { for (const n of names) { const k = Object.keys(row).find(x => x.trim().toLowerCase() === n); if (k != null && row[k] !== '' && row[k] != null) return row[k]; } return null; };
function normalise(row) {
  return {
    id: pickKey(row, 'entry id', 'entryid', 'id'), employee_id: pickKey(row, 'employee id', 'employeeid', 'emp id'), employee: pickKey(row, 'employee', 'name', 'employee name'),
    date: pickKey(row, 'date'), start: pickKey(row, 'start', 'clock in', 'in'), end: pickKey(row, 'end', 'clock out', 'out'), hours: pickKey(row, 'hours', 'total hrs', 'total hours'),
    job: pickKey(row, 'job #', 'job#', 'job', 'job number'), job_name: pickKey(row, 'job name'), category: pickKey(row, 'category'),
    code: pickKey(row, 'cost code', 'code'), code_desc: pickKey(row, 'cost code description', 'description'), note: pickKey(row, 'note', 'notes'),
    source: pickKey(row, 'source'), updated: pickKey(row, 'updated'), labor: pickKey(row, 'labor amt.', 'labor amt', 'labor $', 'labor amount'),
  };
}
const SHOP_JOBS = new Set(['0000', '0', '000']);
function kindFor(e, code) {
  const base = String(code || '');
  if (base === '8130') return 'pto';
  if (base === '8080') return 'training';
  if (SHOP_JOBS.has(String(e.job || '').trim()) || /^80/.test(base)) return 'shop';
  return 'job';
}

function ingest(db, rows, { costCodes = [], userId = null } = {}) {
  const s = D.settings(db);
  const tz = s.timezone || 'America/Boise';
  const burden = Number(s.burden_default_pct ?? 35);
  const out = { created: 0, updated: 0, unchanged: 0, skipped: 0, linked: 0, people_added: [], codes_added: [], unmatched_jobs: {}, problems: [] };
  return tx(db, () => {
    // cost codes tab (optional): keep names/visibility in step with the time clock
    for (const c of costCodes) {
      const code = String(pickKey(c, 'code') || '').trim().replace(/-[LMES]$/i, ''); if (!code) continue;
      const name = String(pickKey(c, 'description', 'name') || code).slice(0, 120), cat = pickKey(c, 'category'), hide = /^(true|yes|1)$/i.test(String(pickKey(c, 'hide') ?? ''));
      const div = (String(cat || '').match(/^(\d{2})/) || [])[1] || code.slice(0, 2);
      const ex = get(db, 'SELECT * FROM cost_codes WHERE code = ?', code);
      if (ex) run(db, 'UPDATE cost_codes SET name = ?, active = ?, division = COALESCE(division, ?), division_name = COALESCE(?, division_name) WHERE id = ?', name, hide ? 0 : 1, div, cat, ex.id);
      else { run(db, "INSERT INTO cost_codes (code, name, kind, active, division, division_name, details) VALUES (?,?,'both',?,?,?,?)", code, name, hide ? 0 : 1, div, cat, pickKey(c, 'details')); out.codes_added.push(code); }
    }
    const userCache = new Map(), codeCache = new Map(), jobCache = new Map();
    const findUser = e => {
      const key = `${e.employee_id || ''}|${e.employee || ''}`;
      if (userCache.has(key)) return userCache.get(key);
      let u = e.employee_id ? get(db, 'SELECT * FROM users WHERE timeclock_id = ?', String(e.employee_id)) : null;
      if (!u && e.employee) u = get(db, 'SELECT * FROM users WHERE lower(trim(name)) = lower(trim(?))', String(e.employee));
      if (u && e.employee_id && !u.timeclock_id) run(db, 'UPDATE users SET timeclock_id = ? WHERE id = ?', String(e.employee_id), u.id);
      if (!u && e.employee) {
        // keep the hours: add them as an inactive tech (no login) — link or activate them under Team
        const email = `timeclock-${String(e.employee_id || e.employee).toLowerCase().replace(/[^a-z0-9]+/g, '-')}@no-login.invalid`;
        const id = Number(run(db, `INSERT INTO users (name, email, password_hash, role, active, burden_pct, timeclock_id) VALUES (?,?,?,'tech',0,?,?)`,
          String(e.employee).slice(0, 120), email, D.hashPassword(crypto.randomBytes(24).toString('hex')), burden, e.employee_id ? String(e.employee_id) : null).lastInsertRowid);
        u = get(db, 'SELECT * FROM users WHERE id = ?', id); out.people_added.push(u.name);
      }
      userCache.set(key, u); return u;
    };
    const findCode = (raw, desc) => {
      const code = String(raw || '').trim().replace(/-[LMES]$/i, ''); if (!code) return null;
      if (codeCache.has(code)) return codeCache.get(code);
      let c = get(db, 'SELECT id FROM cost_codes WHERE code = ?', code);
      if (!c) { c = { id: Number(run(db, "INSERT INTO cost_codes (code, name, kind, active, division) VALUES (?,?,'both',1,?)", code, String(desc || code).slice(0, 120), code.slice(0, 2)).lastInsertRowid) }; out.codes_added.push(code); }
      codeCache.set(code, c.id); return c.id;
    };
    const findJob = num => {
      const n = String(num || '').trim(); if (!n || SHOP_JOBS.has(n)) return null;
      if (jobCache.has(n)) return jobCache.get(n);
      const j = get(db, 'SELECT id FROM jobs WHERE timeclock_job = ? OR number = ? ORDER BY timeclock_job = ? DESC LIMIT 1', n, n, n);
      jobCache.set(n, j ? j.id : null); return j ? j.id : null;
    };
    for (const raw of rows) {
      const e = normalise(raw);
      if (!e.id) { out.skipped++; continue; }
      const u = findUser(e);
      if (!u) { out.skipped++; out.problems.push(`${e.id}: no employee`); continue; }
      let clockIn = toUtc(e.start, tz) || null;
      const hours = Number(String(e.hours ?? '').replace(/[^0-9.-]/g, ''));
      if (!clockIn) { const d = parseLocal(e.date); if (!d) { out.skipped++; out.problems.push(`${e.id}: no date`); continue; } clockIn = zonedToUtc({ ...d, h: 8, mi: 0 }, tz); }
      // open punch (no End yet) stays open; otherwise the time clock's Hours decide the length
      const hasEnd = e.end != null && String(e.end).trim() !== '';
      const clockOut = !hasEnd ? null : Number.isFinite(hours) && hours >= 0 ? new Date(Date.parse(clockIn) + hours * 36e5).toISOString() : toUtc(e.end, tz);
      const ccId = findCode(e.code, e.code_desc);
      const base = String(e.code || '').trim().replace(/-[LMES]$/i, '');
      const jobId = findJob(e.job);
      const extJob = SHOP_JOBS.has(String(e.job || '').trim()) ? null : (e.job ? String(e.job).trim() : null);
      if (extJob && !jobId) out.unmatched_jobs[extJob] = e.job_name || out.unmatched_jobs[extJob] || '';
      const labor = money(e.labor);
      const wage = labor != null && hours > 0 ? r2(labor / hours) : (u.hourly_wage || 0);
      const data = { user_id: u.id, job_id: jobId, kind: kindFor(e, base), clock_in: clockIn, clock_out: clockOut, cost_code_id: ccId,
        hourly_wage: wage, hourly_cost: r2(wage * (1 + (u.burden_pct ?? burden) / 100)), notes: e.note ? String(e.note).slice(0, 500) : null,
        ext_job: extJob, source: `A4Y Time Clock${e.source ? ` (${e.source})` : ''}`, labor_amount: labor };
      const ex = get(db, 'SELECT * FROM time_entries WHERE external_id = ?', String(e.id));
      if (ex) {
        const changed = Object.entries(data).some(([k, v]) => (ex[k] ?? null) !== (v ?? null) && !(typeof v === 'number' && Math.abs((ex[k] || 0) - v) < 0.005));
        if (changed) { const cols = Object.keys(data); run(db, `UPDATE time_entries SET ${cols.map(c => `${c} = ?`).join(', ')} WHERE id = ?`, ...cols.map(c => data[c]), ex.id); out.updated++; }
        else out.unchanged++;
      } else {
        const cols = [...Object.keys(data), 'external_id'];
        run(db, `INSERT INTO time_entries (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(',')})`, ...Object.values(data), String(e.id));
        out.created++;
      }
    }
    out.linked = relink(db);
    run(db, "INSERT INTO settings (key, value) VALUES ('timeclock_last_sync', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      JSON.stringify({ at: new Date().toISOString(), created: out.created, updated: out.updated, unchanged: out.unchanged, unmatched_jobs: out.unmatched_jobs, people_added: out.people_added, by: userId }));
    return out;
  });
}
// entries whose time clock Job # now belongs to a job get attached to it
function relink(db) {
  return run(db, `UPDATE time_entries SET job_id = (SELECT j.id FROM jobs j WHERE j.timeclock_job = time_entries.ext_job ORDER BY j.id LIMIT 1)
    WHERE ext_job IS NOT NULL AND job_id IS NULL AND EXISTS (SELECT 1 FROM jobs j WHERE j.timeclock_job = time_entries.ext_job)`).changes;
}

// Pull from the Apps Script export (docs/timeclock-export.gs). Returns the ingest summary.
async function pull(db, { userId = null, fetchImpl = fetch } = {}) {
  const s = D.settings(db);
  const url = String(s.timeclock_url || '').trim();
  if (!/^https:\/\/script\.google(usercontent)?\.com\//.test(url)) { const e = new Error('Set the time clock export link first (Settings → A4Y Time Clock). It starts with https://script.google.com/'); e.status = 400; throw e; }
  const u = new URL(url); u.searchParams.set('key', s.timeclock_key || ''); u.searchParams.set('since', String(Number(s.timeclock_days || 60)));
  let r;
  try { r = await fetchImpl(u.toString(), { redirect: 'follow', signal: AbortSignal.timeout(30000) }); }
  catch { const e = new Error("Can't reach the time clock export. Check the link and that the server has internet access."); e.status = 502; throw e; }
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = null; }
  if (!r.ok || !data) { const e = new Error(/<html/i.test(text) ? 'The link returned a web page, not data. Use the export script\'s link (docs/TIMECLOCK.md), deployed with access "Anyone".' : `Time clock export failed (HTTP ${r.status})`); e.status = 502; throw e; }
  if (data.error) { const e = new Error(`Time clock export: ${data.error}`); e.status = 502; throw e; }
  return ingest(db, data.entries || [], { costCodes: data.cost_codes || [], userId });
}

module.exports = { ingest, pull, relink, parseLocal, zonedToUtc, toUtc };
