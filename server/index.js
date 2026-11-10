'use strict';
const { open } = require('./db');
const { createApp } = require('./app');

const db = open();
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || undefined; // set HOST=127.0.0.1 on a server so only the HTTPS proxy can reach it
const app = createApp(db);
const server = app.listen(port, host, () => console.log(`A4YE Field Ops running at http://${host || 'localhost'}:${port}`));
// A4Y Time Clock: pull new and changed entries every hour when an export link is set (Settings → A4Y Time Clock)
const TC = require('./timeclock');
const D = require('./db');
const autoSync = async () => {
  const s = D.settings(db);
  if (!s.timeclock_url || s.timeclock_auto === '0') return;
  try { const r = await TC.pull(db); if (r.created || r.updated) console.log(`Time clock sync: ${r.created} new, ${r.updated} changed`); }
  catch (e) { console.error('Time clock sync failed:', e.message); }
};
setTimeout(autoSync, 20000).unref();
setInterval(autoSync, 60 * 60 * 1000).unref();
// Ply has no webhooks: pull PO receipts and completed picks hourly when connected
const Ply = require('./ply');
const plySync = async () => {
  const s = D.settings(db);
  if (s.ply_enabled !== '1' || !s.ply_api_key || s.ply_auto_sync === '0') return;
  try { const r = await Ply.syncStatus(db, app.locals.H); if (r.received_lines || r.picks_completed) console.log(`Ply sync: ${r.received_lines} PO lines received, ${r.picks_completed} picks completed`); }
  catch (e) { console.error('Ply sync failed:', e.message); }
};
setTimeout(plySync, 40000).unref();
setInterval(plySync, 60 * 60 * 1000).unref();
// finish requests in flight and close the database cleanly on restart/shutdown
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { server.close(() => { try { db.close(); } catch { /* already closed */ } process.exit(0); }); server.closeIdleConnections(); setTimeout(() => process.exit(0), 5000).unref(); });
