'use strict';
const { open } = require('./db');
const { createApp } = require('./app');

const db = open();
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || undefined; // set HOST=127.0.0.1 on a server so only the HTTPS proxy can reach it
const server = createApp(db).listen(port, host, () => console.log(`A4YE Field Ops running at http://${host || 'localhost'}:${port}`));
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
// finish requests in flight and close the database cleanly on restart/shutdown
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { server.close(() => { try { db.close(); } catch { /* already closed */ } process.exit(0); }); server.closeIdleConnections(); setTimeout(() => process.exit(0), 5000).unref(); });
