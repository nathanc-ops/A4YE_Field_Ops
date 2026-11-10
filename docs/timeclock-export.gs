/**
 * A4Y Time Clock → Field Ops export (read-only).
 *
 * A separate, standalone Apps Script project. It does NOT change your time clock app or its sheet.
 * It hands the "Time Entries" and "Cost Codes" tabs to your Field Ops server as JSON, only to callers
 * that know the secret key. It never reads the Employees tab (PINs, pay rates).
 *
 * Setup: see docs/TIMECLOCK.md.
 */
const SHEET_ID = 'PASTE_THE_A4Y_TIME_CLOCK_SHEET_ID_HERE';   // from the sheet's address: docs.google.com/spreadsheets/d/<THIS PART>/edit

function doGet(e) {
  const key = PropertiesService.getScriptProperties().getProperty('EXPORT_KEY');
  if (!key || !e || !e.parameter || e.parameter.key !== key) return json_({ error: 'Not allowed: wrong or missing key' });
  const days = Math.min(Math.max(Number(e.parameter.since) || 60, 1), 3660);
  const cutoff = new Date(Date.now() - days * 864e5);
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const entries = table_(ss.getSheetByName('Time Entries')).filter(function (r) {
    const d = new Date(String(r['Date'] || '').replace(/^[A-Za-z]{3}\s+/, ''));
    return isNaN(d) || d >= cutoff;   // keep rows with an unreadable date so nothing silently disappears
  });
  const codes = table_(ss.getSheetByName('Cost Codes'));
  return json_({ sheet: ss.getName(), exported_at: new Date().toISOString(), since_days: days, entries: entries, cost_codes: codes });
}

// rows as objects keyed by the header row, using the values exactly as the sheet shows them
function table_(sh) {
  if (!sh) return [];
  const v = sh.getDataRange().getDisplayValues();
  if (v.length < 2) return [];
  const head = v[0].map(function (h) { return String(h).trim(); });
  const out = [];
  for (let i = 1; i < v.length; i++) {
    if (!v[i].some(function (c) { return String(c).trim() !== ''; })) continue;
    const o = {};
    head.forEach(function (h, j) { if (h) o[h] = v[i][j]; });
    out.push(o);
  }
  return out;
}
function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
