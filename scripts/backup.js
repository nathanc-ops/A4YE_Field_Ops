'use strict';
// Consistent copy of the live database (safe while the app is running), named by date/time.
//   npm run backup                    -> data/backups/fieldops-YYYY-MM-DD-HHMM.db
//   node scripts/backup.js /some/dir  -> written there instead
// Keeps the newest BACKUP_KEEP (default 30) copies in that folder.
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'fieldops.db');
const outDir = process.argv[2] || process.env.BACKUP_DIR || path.join(path.dirname(dbPath), 'backups');
const keep = Number(process.env.BACKUP_KEEP || 30);
if (!fs.existsSync(dbPath)) { console.error(`No database at ${dbPath}`); process.exit(1); }
fs.mkdirSync(outDir, { recursive: true });
const d = new Date(), p2 = n => String(n).padStart(2, '0');
const out = path.join(outDir, `fieldops-${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}.db`);
if (fs.existsSync(out)) fs.unlinkSync(out);
const db = new DatabaseSync(dbPath);
db.exec('PRAGMA busy_timeout = 10000');
db.prepare('VACUUM INTO ?').run(out);
db.close();
const check = new DatabaseSync(out, { readOnly: true });
const ok = check.prepare('PRAGMA integrity_check').get();
check.close();
if (Object.values(ok)[0] !== 'ok') { console.error('Backup failed its integrity check:', ok); process.exit(1); }
const old = fs.readdirSync(outDir).filter(f => /^fieldops-.*\.db$/.test(f)).sort().reverse().slice(keep);
for (const f of old) fs.unlinkSync(path.join(outDir, f));
console.log(out);
