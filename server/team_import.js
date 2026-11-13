'use strict';
// Team → Import list: a pasted Google Sheet / CSV with Name, Email, Phone (and optionally Role / Title).
// People already on the team (matched by email, then by name) get their email and phone updated; anyone not
// matched is added. Nothing else about an existing person changes (role, wage, permissions, password).
// New people never get the app's Admin role from a sheet: the sheet's role text picks Technician / Office /
// Manager, and the text itself becomes their title. Admins promote by hand.
const crypto = require('node:crypto');
const { parseRows } = require('./importer');

const key = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const FLAG = /[⚠️❗❓]|\(\?\)/g;   // ⚠️ ❗ ❓ markers people put in a sheet to say "check this"
const flagged = s => /[\u26A0\u2757\u2753]|\(\?\)/.test(String(s || ''));

function cleanEmail(s) {
  const raw = String(s || '');
  const m = raw.match(/[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  return { value: m ? m[0].toLowerCase() : '', flagged: flagged(raw), bad: !!raw.replace(FLAG, '').trim() && !m };
}
function cleanPhone(s) {
  const raw = String(s || '');
  const digits = raw.replace(/\D/g, '');
  const ten = digits.length === 11 && digits[0] === '1' ? digits.slice(1) : digits;
  const value = ten.length === 10 ? `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}` : raw.replace(FLAG, '').trim();
  return { value, flagged: flagged(raw), bad: !!value && ten.length !== 10 };
}
// "Field Tech – Commercial" → tech; "Admin – Service/Estimates/Manager" → manager; "Admin – Office" → office
function roleFrom(text) {
  const t = String(text || '').toLowerCase();
  if (!t) return 'tech';
  if (/tech|electrician|apprentice|journeyman|foreman|helper|installer/.test(t)) return 'tech';
  if (/manager|supervisor|estimat/.test(t)) return 'manager';
  if (/office|admin|dispatch|account|bookkeep|reception|sales/.test(t)) return 'office';
  return 'tech';
}

function columns(headers) {
  const h = headers.map(key), find = (...names) => h.findIndex(x => names.some(n => x === n || x.startsWith(n)));
  return { name: find('name', 'fullname', 'employee'), email: find('email', 'emailaddress', 'login'),
    phone: find('phone', 'cell', 'mobile', 'phonenumber'), role: find('role', 'position', 'title', 'jobtitle') };
}

// What would happen: one entry per sheet row. Nothing is written.
function plan(db, text) {
  const rows = parseRows(text);
  if (rows.length < 2) throw Object.assign(new Error('Paste the list with its heading row (Name, Email, Phone…) first'), { status: 400 });
  const col = columns(rows[0]);
  if (col.name < 0) throw Object.assign(new Error('No "Name" column found in the heading row'), { status: 400 });
  if (col.email < 0 && col.phone < 0) throw Object.assign(new Error('No "Email" or "Phone" column found in the heading row'), { status: 400 });
  const users = db.prepare('SELECT id, name, email, phone, role, title, active FROM users').all();
  const byEmail = new Map(users.map(u => [String(u.email).toLowerCase(), u]));
  const byName = new Map(); for (const u of users) { const k = key(u.name); byName.set(k, byName.has(k) ? null : u); }   // null = two people share it
  const seen = new Set();
  return rows.slice(1).map((r, i) => {
    const cell = c => (c >= 0 ? r[c] || '' : '');
    const name = cell(col.name).replace(FLAG, '').trim();
    const em = col.email >= 0 ? cleanEmail(cell(col.email)) : { value: '' };
    const ph = col.phone >= 0 ? cleanPhone(cell(col.phone)) : { value: '' };
    const roleText = cell(col.role).replace(FLAG, '').trim();
    const out = { row: i + 2, name, email: em.value, phone: ph.value, role_text: roleText, warnings: [] };
    if (em.flagged) out.warnings.push('The sheet marks this email ⚠️ — check it');
    if (ph.flagged) out.warnings.push('The sheet marks this phone ⚠️ — check it');
    if (em.bad) out.warnings.push(`"${cell(col.email)}" isn't an email address; email left as it is`);
    if (ph.bad) out.warnings.push(`"${ph.value}" isn't a 10-digit phone number`);
    if (!name) return { ...out, action: 'skip', reason: 'No name' };
    const nk = key(name);
    if (seen.has(nk) || (em.value && seen.has(em.value))) return { ...out, action: 'skip', reason: 'Listed twice in the sheet' };
    seen.add(nk); if (em.value) seen.add(em.value);
    let u = em.value ? byEmail.get(em.value) : null, how = 'email';
    // the email is someone else's but the name is an exact match for another person: trust the name
    if (u && key(u.name) !== nk && byName.get(nk)) u = null;
    if (!u) { u = byName.get(nk); how = 'name'; if (u === null) return { ...out, action: 'skip', reason: 'Two people on the team have this name — edit them by hand' }; }
    if (u) {
      const changes = {};
      if (em.value && em.value !== String(u.email).toLowerCase()) {
        const owner = byEmail.get(em.value);
        if (owner && owner.id !== u.id) out.warnings.push(`${em.value} already belongs to ${owner.name}; email not changed`);
        else changes.email = { from: u.email, to: em.value };
      }
      if (ph.value && ph.value !== (u.phone || '')) changes.phone = { from: u.phone || '', to: ph.value };
      return { ...out, action: Object.keys(changes).length ? 'update' : 'same', user_id: u.id, matched_by: how, current_name: u.name, changes };
    }
    if (!em.value) return { ...out, action: 'skip', reason: 'New person with no usable email (it is their login)' };
    if (byEmail.get(em.value)) return { ...out, action: 'skip', reason: `${em.value} already belongs to ${byEmail.get(em.value).name}` };
    return { ...out, action: 'add', role: roleFrom(roleText), title: roleText };
  });
}

// Write the plan. newPassword (8+) makes new people active with that starting password; without it they're added
// inactive with a random password, to be set (and Active ticked) on their Team page.
function apply(db, text, { newPassword, hashPassword } = {}) {
  if (newPassword && newPassword.length < 8) throw Object.assign(new Error('Starting password must be 8+ characters'), { status: 400 });
  const items = plan(db, text);
  // the route runs inside one transaction (app.js wrap), so a failure part-way saves nothing
    for (const it of items) {
      if (it.action === 'update') {
        const sets = Object.keys(it.changes);
        db.prepare(`UPDATE users SET ${sets.map(k => `${k} = ?`).join(', ')} WHERE id = ?`).run(...sets.map(k => it.changes[k].to), it.user_id);
      } else if (it.action === 'add') {
        const pw = newPassword || crypto.randomBytes(18).toString('base64url');
        const r = db.prepare('INSERT INTO users (name, email, phone, role, title, active, password_hash, permissions) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(it.name, it.email, it.phone || null, it.role, it.title || null, newPassword ? 1 : 0, hashPassword(pw), null);   // null permissions = the role's defaults
        it.user_id = Number(r.lastInsertRowid);
      }
    }
  return items;
}

module.exports = { plan, apply, roleFrom, cleanPhone, cleanEmail };
