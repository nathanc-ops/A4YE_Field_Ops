'use strict';
// Importing a whole A4YE job workbook (.xlsx). The workbook is built here, cell by cell, in the template's layout —
// no real job data in the repository.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const D = require('../server/db');
const X = require('../server/xlsx');
const { createApp } = require('../server/app');

// ---- a minimal .xlsx writer (stored zip entries) — enough for the reader under test
function zip(files) {
  const parts = [], dir = []; let off = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text, 'utf8'), nm = Buffer.from(name), crc = zlib.crc32(data);
    const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt32LE(crc, 14); h.writeUInt32LE(data.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(nm.length, 26);
    parts.push(h, nm, data);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt32LE(crc, 16); c.writeUInt32LE(data.length, 20); c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(nm.length, 28); c.writeUInt32LE(off, 42); dir.push(c, nm);
    off += 30 + nm.length + data.length;
  }
  const cd = Buffer.concat(dir), e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(Object.keys(files).length, 8); e.writeUInt16LE(Object.keys(files).length, 10); e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cd, e]);
}
const xmlEsc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function xlsx(sheets) {
  const names = Object.keys(sheets), files = {};
  files['xl/workbook.xml'] = `<?xml version="1.0"?><workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${names.map((n, i) => `<sheet name="${xmlEsc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`;
  files['xl/_rels/workbook.xml.rels'] = `<?xml version="1.0"?><Relationships>${names.map((n, i) => `<Relationship Id="rId${i + 1}" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}</Relationships>`;
  names.forEach((n, i) => {
    const byRow = {};
    for (const [ref, v] of Object.entries(sheets[n])) { const r = +ref.match(/\d+/)[0]; (byRow[r] = byRow[r] || []).push([ref, v]); }
    const cell = (ref, v) => {
      const f = v && typeof v === 'object' && 'f' in v, val = f ? v.v : v;
      const fx = f ? `<f>${xmlEsc(v.f)}</f>` : '';
      if (val == null) return `<c r="${ref}">${fx}</c>`;
      if (typeof val === 'number') return `<c r="${ref}">${fx}<v>${val}</v></c>`;
      return f ? `<c r="${ref}" t="str">${fx}<v>${xmlEsc(val)}</v></c>` : `<c r="${ref}" t="inlineStr"><is><t>${xmlEsc(val)}</t></is></c>`;
    };
    files[`xl/worksheets/sheet${i + 1}.xml`] = `<?xml version="1.0"?><worksheet><sheetData>${Object.keys(byRow).sort((a, b) => a - b).map(r => `<row r="${r}">${byRow[r].map(([ref, v]) => cell(ref, v)).join('')}</row>`).join('')}</sheetData></worksheet>`;
  });
  return zip(files);
}
const serial = iso => Date.parse(iso + 'T00:00:00Z') / 864e5 + 25569;
const T = (...c) => c;

function workbook({ jobNo = '2699001', contract = 100000 } = {}) {
  const row = (letters, r, vals) => Object.fromEntries(vals.map((v, i) => [`${letters[i]}${r}`, v]).filter(([, v]) => v !== undefined && v !== ''));
  const cols = n => Array.from({ length: n }, (_, i) => X.colName(i + 1));
  return xlsx({
    'Cover': { A25: 'Blended burdened field rate  ($/hr)', B25: 40, A29: 'Default retainage %', B29: 0.05, A37: 'Schedule start (Gantt week 1)', B37: serial('2026-09-21') },
    'Job Register': { A5: 'Job #', ...row(cols(39), 6, [jobNo, 'Test Lab TI', 'Acme Builders', '100 Main St, Boise ID', 'TI - Lab', 'Chris Manager', 'Pat Foreman', 'Active', serial('2026-09-01'),
      serial('2026-10-05'), serial('2027-03-31'), 12000, contract, { f: 'SUMIFS(...)', v: 5000 }, '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', { f: 'x', v: 8 }, '', 0.1, 'Night work in lab', 0.04]) },
    'Estimate Import': { ...row(cols(16), 6, T('LAB-P2-0810-L', 'Rough-In', '', '3/4" EMT', 1000, 'ft', 1.2, 0.04, '', '', '', '', '', 1600, '', '')),
      ...row(cols(16), 7, T('1010-L', 'Trim', '', 'Receptacles', 40, 'ea', 3.5, '', '', 0.5, '', '', '', 800, '', '')),
      ...row(cols(16), 8, T('', '', '', 'Rough-in subtotal', 1, '', '', '', '', '', '', '', '', '', '', '')) },
    'Cost Codes': { A5: 'Code', N5: '% Complete', A6: '0810-L', B6: '0810', N6: 0.25, A7: '1010-L', B7: '1010', N7: { f: 'O7/M7', v: 0 } },
    'Schedule': { ...row(cols(22), 6, T('T-001', jobNo, 'P2', 'LAB', 'Rough-in lab', '0810', serial('2026-10-05'), serial('2026-10-30'), { f: 'NETWORKDAYS', v: 20 }, '', 'Pat', 40, 0.5, '', '', '', '', '', '', { f: 'x', v: 'In Progress' }, '', 'first')),
      ...row(cols(22), 7, T('T-002', jobNo, 'P4', 'LAB', 'Trim lab', '1010-L', serial('2026-11-02'), serial('2026-11-13'), '', 'T-001', 'Pat', 20, '', '', '', '', '', '', '', '', '', '')),
      ...row(cols(22), 8, T('T-003', jobNo, '', 'ALL', 'Owner move-in', '', serial('2027-03-30'), serial('2027-03-31'), '', 'HC 241', 'GC', '', '', '', '', '', '', '', '', '', '', '')) },
    'Milestones': row(cols(15), 6, T('M-001', jobNo, 'Rough-in inspection', 'P3', serial('2026-10-31'), serial('2026-11-03'), '', '', 'Owner', '', 'Yes', '', '', 'AHJ')),
    'Change Orders': { ...row(cols(29), 6, T('CO-01', jobNo, 'Test Lab TI', serial('2026-10-10'), 'Add lab receptacles', 'GC', 'Approved', '1010', 10, 1, 500, 300, 0, 0, 0, 18, 818, 0.18, 0.15, 5000, '', '', 2, serial('2026-10-11'), serial('2026-10-12'), '', 'RFI-001', 'priced per walk')),
      ...row(cols(29), 7, T('CO-02', jobNo, 'Test Lab TI', serial('2026-10-20'), 'Extra data drops', 'Owner', 'Submitted', '', 0, 0, 0, 0, 0, 1200, 0, 0, 1200, 0.18, 0.15, 1600, '', '', 0, serial('2026-10-21'), '', '', '', '')),
      // the template's status summary under the log (rows 129+) — not change orders
      A129: 'Status', E129: 'Days Added', A130: 'Draft', E130: { f: 'SUMIFS()', v: 0 }, A133: 'Approved', E133: { f: 'SUMIFS()', v: 2 }, G133: 'Approved' },
    'SOV': { ...row(cols(13), 6, T(1, 'MOB', '', 'Mobilization', 4000, 4000, '', '', '', '', '', '', '')), ...row(cols(13), 7, T(2, '08', '', 'Raceway', 60000, '', '', '', '', '', '', '', '')),
      ...row(cols(13), 8, T(3, '10', '', 'Devices', 36000, '', '', '', '', '', '', '', '')), ...row(cols(13), 9, T(4, 'CO', 'CO-01', 'CO-01 Add lab receptacles', 5000, '', '', '', '', '', '', '', '')),
      B70: 'TOTAL', D70: 'Contract total', G70: { f: 'SUM()', v: 105000 } },
    'Billing Entry': { A6: 1, B6: 'MOB', H6: 4000, A7: 2, B7: '08', H7: 10000, AG7: 2000, I7: 15000, A8: 3, B8: '10', A9: 4, B9: 'CO' },
    'Pay Apps': { ...row(cols(20), 6, T(1, serial('2026-10-31'), '', 0.1, '', '', '', '', { f: 'x', v: 16000 }, '', '', 14400, serial('2026-11-01'), serial('2026-11-20'), 14400, '', '', 'Paid', 'CHK 1234', '')),
      ...row(cols(20), 7, T(2, serial('2026-11-30'), '', 0.1, '', '', '', '', { f: 'x', v: 13000 }, '', '', '', '', '', '', '', '', '', '', '')), A8: 3 },
    'RFI-Submittal Log': row(cols(19), 6, T('RFI-001', 'RFI', jobNo, '01', 'Receptacle heights in lab', 'E201', '1010', serial('2026-10-06'), serial('2026-10-09'), serial('2026-10-08'), '', '', 'Answered', 'Architect', 5000, 2, 'CO-01', 'see CO')),
    'Safety-Quality Log': row(cols(17), 6, T('SQ-001', serial('2026-10-07'), jobNo, 'Toolbox Talk', 'Ladder safety', '', 'Pat Foreman', '', '', '', serial('2026-10-07'), 'Closed', '', '', '', '', '')),
    'Labor Log': { ...row(cols(22), 6, T(serial('2026-10-11'), 'TEST-E1', 'EMP-1', 'Pat Foreman', 'Mon 10/5/2026', serial('2026-10-05') + 7 / 24, serial('2026-10-05') + 15.5 / 24, 8, jobNo, 'Test Lab TI', '08 Raceway', '0810-L', 'EMT', '', 'Clock', '', 8, 0, 360, 'Foreman', 'P2', '')),
      ...row(cols(22), 7, T(serial('2026-10-11'), 'TEST-E2', 'EMP-2', 'Sam Apprentice', 'Tue 10/6/2026', serial('2026-10-06') + 7 / 24, serial('2026-10-06') + 11 / 24, 4, jobNo, 'Test Lab TI', '08 Raceway', '0810-L', 'EMT', '', 'Clock', '', 4, 0, 100, 'Apprentice', 'P2', '')),
      ...row(cols(22), 8, T(serial('2026-10-11'), 'TEST-E3', 'EMP-2', 'Sam Apprentice', 'Wed 10/7/2026', serial('2026-10-07') + 7 / 24, serial('2026-10-07') + 11 / 24, 4, '0000', 'Shop', '80 Shop', '8010-L', 'Shop', '', 'Clock', '', 4, 0, 100, 'Apprentice', 'P9', '')) },
    'Cost Log': { ...row(cols(23), 6, T('CL-1', serial('2026-10-06'), jobNo, 'Test Lab TI', '0810', 'M', '0810-M', '08', 'EMT', 'Supply House', 'INV-77', 'EMT and fittings', 'Invoiced', 1200, 1200, 72, 1272, 0, '', 'Yes', '', 'Manual', '')),
      ...row(cols(23), 7, T('CL-2', serial('2026-10-08'), jobNo, 'Test Lab TI', '1010', 'M', '1010-M', '10', 'Devices', 'Supply House', 'PO-9001', 'Devices', 'Committed (PO)', 900, 0, 0, 0, 900, '', 'Yes', '', 'Manual', '')),
      ...row(cols(23), 8, T('CL-3', serial('2026-10-09'), jobNo, 'Test Lab TI', '0810', 'S', '0810-S', '08', 'Core drilling', 'Core Co', 'C-55', 'Core drill', 'Invoiced', 0, 400, 0, 400, 0, '', '', '', 'Manual', '')) },
    'Weekly History': { ...row(cols(5), 6, T(1, serial('2026-10-11'), 100000, 70000, 0.12)), ...row(cols(5), 7, T(2, serial('2026-10-18'), 100000, 70000, { f: 'M7/SUM()', v: 0.2 })) },
    'Employee List': { A6: 'never read', B6: 'PIN 1234', C6: 99.99 },
  });
}

let server, base, db;
const tok = {};
async function call(who, method, p, body) {
  const res = await fetch(base + '/api' + p, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok[who] }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json() };
}
before(async () => {
  db = D.open(':memory:');
  server = createApp(db).listen(0); await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  tok.admin = (await call(null, 'POST', '/setup', { name: 'Owner', email: 'o@x.com', password: 'longenough' })).data.token;
  await call('admin', 'POST', '/users', { name: 'Pat Foreman', email: 'pat@x.com', password: 'password123', role: 'tech', title: 'Foreman', hourly_wage: 40 });
  await call('admin', 'POST', '/users', { name: 'Ann Office', email: 'ann@x.com', password: 'password123', role: 'office' });
  tok.office = (await call(null, 'POST', '/login', { email: 'ann@x.com', password: 'password123' })).data.token;
});
after(() => server.close());

test('the .xlsx reader: values, shared/inline strings, formula flags, dates', () => {
  const wb = X.read(workbook());
  assert.ok(wb.sheetNames.includes('Job Register'));
  const jr = wb.sheet('Job Register');
  assert.equal(jr.val('B6'), 'Test Lab TI'); assert.equal(jr.val('M6'), 100000);
  assert.deepEqual(jr.cell('N6'), { v: 5000, f: true, err: null });
  assert.equal(X.dateOf(jr.val('J6')), '2026-10-05');
  assert.equal(X.dateTimeOf(wb.sheet('Labor Log').val('F6')), '2026-10-05 07:00');
  assert.throws(() => X.read(Buffer.from('not a zip at all, just text')), /Not an .xlsx/);
});

test('preview: job, sections, people, skips; office users cannot import', async () => {
  const file = workbook().toString('base64');
  assert.equal((await call('office', 'POST', '/import/job-workbook/preview', { file })).status, 403);
  assert.equal((await call('admin', 'POST', '/import/job-workbook/preview', { file: Buffer.from('hello').toString('base64') })).status, 400);
  const r = await call('admin', 'POST', '/import/job-workbook/preview', { file });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const p = r.data;
  assert.equal(p.job.number, '2699001'); assert.equal(p.job.client, 'Acme Builders'); assert.equal(p.job.retainage_pct, 10); assert.equal(p.job.schedule_start, '2026-09-21');
  assert.equal(p.target, null); assert.equal(p.foreman, 'matched'); assert.match(p.pm, /not on Team/);
  const S = Object.fromEntries(p.sections.map(s => [s.key, s]));
  assert.equal(S.tasks.count, 3); assert.equal(S.cos.count, 2); assert.equal(S.apps.count, 2); assert.equal(S.labor.count, 3); assert.equal(S.cost.count, 3);
  assert.equal(S.history.count, 1, 'only the typed week');
  assert.equal(p.people['Pat Foreman'], 'matched'); assert.match(p.people['Sam Apprentice'], /new/);
  assert.match(p.not_imported, /Dashboard/);
  assert.doesNotMatch(JSON.stringify(p), /PIN 1234|never read/, 'Employee List is never read');
});

test('import: every tab lands where the project sheets read it, numbers match the workbook, re-run is a no-op', async () => {
  const file = workbook().toString('base64');
  const r = await call('admin', 'POST', '/import/job-workbook', { file, file_name: 'Test Lab TI.xlsx' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const o = r.data, jid = o.job_id;
  assert.equal(o.created_job, true);
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jid);
  assert.equal(job.is_project, 1); assert.equal(job.timeclock_job, '2699001'); assert.equal(job.contract_amount, 100000); assert.equal(job.retainage_pct, 10);
  assert.equal(job.mobilization_pct, 4); assert.equal(job.schedule_start, '2026-09-21'); assert.equal(job.start_date, '2026-10-05');
  assert.equal(db.prepare('SELECT name FROM users WHERE id = ?').get(job.foreman_id).name, 'Pat Foreman');
  assert.equal(job.project_manager_id, null);
  assert.equal(db.prepare('SELECT company FROM customers WHERE id = ?').get(job.customer_id).company, 'Acme Builders');
  assert.equal(db.prepare('SELECT value FROM settings WHERE key = ?').get('blended_labor_rate').value, '40');
  // budget: 1000 ft × 0.04 = 40 h + 1600 labor + 1200 material; 20 h + 800 + 140
  assert.deepEqual(o.done.budget, { imported: 2, codes: 2, total: 3740, percent_complete: 1 });
  const b0810 = db.prepare("SELECT jb.* FROM job_budgets jb JOIN cost_codes cc ON cc.id = jb.cost_code_id WHERE jb.job_id = ? AND cc.code = '0810'").get(jid);
  assert.equal(b0810.budget_hours, 40); assert.equal(b0810.percent_complete, 25, 'typed % only; the formula one is ignored');
  // schedule with predecessors; free-text preds kept in notes
  const tasks = (await call('admin', 'GET', `/projects/${jid}/schedule`)).data.rows;
  assert.equal(tasks.length, 3); assert.equal(tasks[0].pct_complete, 50); assert.equal(tasks[1].pred_ref, 'T-001'); assert.match(tasks[2].notes, /Pred: HC 241/);
  // COs: approved one in the contract at the exact sell price and cost
  const cos = (await call('admin', 'GET', `/projects/${jid}/change-orders`)).data;
  assert.equal(cos.totals.approved, 5000); assert.equal(cos.totals.approved_cost, 818); assert.equal(cos.totals.pending, 1600);
  assert.equal(cos.rows[0].labor_hrs, 10);
  assert.equal(o.check.contract_here, 105000); assert.equal(o.check.contract_workbook, 105000);
  // SOV + pay apps: G702 math matches the workbook's gross, invoice + payment created as history
  const pa = (await call('admin', 'GET', `/projects/${jid}/pay-apps`)).data.apps;
  assert.equal(pa.length, 2);
  assert.equal(pa[0].gross_this_app, 16000); assert.equal(pa[0].retainage_this_app, 1600); assert.equal(pa[0].net_due, 14400); assert.equal(pa[0].status, 'Paid');
  assert.equal(pa[1].gross_this_app, 13000, 'app 2: 15000 work + stored drawn down from 2000');
  assert.ok(!o.warnings.some(w => /Pay App/.test(w)), o.warnings.join('; '));
  const inv = db.prepare("SELECT * FROM invoices WHERE job_id = ? AND billing_kind = 'pay_app' ORDER BY id").all(jid);
  assert.equal(inv.length, 2); assert.equal(inv[0].status, 'paid'); assert.equal(inv[0].issue_date, '2026-11-01'); assert.equal(inv[0].ledger_skip, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM journal_entries WHERE source_type = ? AND source_id = ?').get('invoice', inv[0].id).n, 0, 'history, not posted');
  assert.equal(db.prepare('SELECT SUM(amount) a FROM payments WHERE invoice_id = ?').get(inv[0].id).a, 14400);
  // logs
  const rfi = db.prepare('SELECT * FROM rfis WHERE job_id = ?').get(jid);
  assert.equal(rfi.status, 'Answered'); assert.equal(rfi.ball_in_court, 'Architect'); assert.ok(rfi.co_estimate_id, 'linked to the CO');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM safety_items WHERE job_id = ?').get(jid).n, 1);
  assert.equal(db.prepare('SELECT critical FROM project_milestones WHERE job_id = ?').get(jid).critical, 1);
  // labor through the time clock rules: this job's rows only, keyed by Entry ID, unknown people added inactive
  assert.equal(o.done.labor.created, 2); assert.deepEqual(o.done.labor.people_added, ['Sam Apprentice']);
  const te = db.prepare('SELECT * FROM time_entries WHERE job_id = ? ORDER BY clock_in').all(jid);
  assert.equal(te.length, 2); assert.equal(te[0].external_id, 'TEST-E1'); assert.equal(te[0].hourly_wage, 45, 'labor $ ÷ hours');
  assert.equal(o.check.labor_hours_here, 12);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM time_entries WHERE external_id = ?').get('TEST-E3').n, 0, 'shop row on another job # left out');
  // cost log: invoiced → expenses (history), open → PO
  const ex = db.prepare('SELECT * FROM expenses WHERE job_id = ? ORDER BY id').all(jid);
  assert.deepEqual(ex.map(e => [e.category, e.amount, e.ledger_skip]), [['Materials (supply house)', 1272, 1], ['Subcontractor', 400, 1]]);
  const po = db.prepare('SELECT * FROM purchase_orders WHERE job_id = ?').all(jid);
  assert.equal(po.length, 1); assert.equal(po[0].number, 'PO-9001');
  assert.equal(db.prepare('SELECT unit_cost FROM po_lines WHERE po_id = ?').get(po[0].id).unit_cost, 900);
  // weekly history: the typed week is recorded progress
  const pr = db.prepare('SELECT * FROM project_progress WHERE job_id = ?').all(jid);
  assert.equal(pr.length, 1); assert.equal(pr[0].week_ending, '2026-10-11'); assert.equal(pr[0].pct_complete, 12); assert.equal(pr[0].source, 'manual');
  // every project sheet opens on the imported job
  for (const p of ['schedule', 'manpower', 'weekly-history', 'biweekly', 'sov', 'cost-log', 'labor-log']) assert.equal((await call('admin', 'GET', `/projects/${jid}/${p}`)).status, 200, p);
  // re-run: same project, nothing duplicated
  const again = (await call('admin', 'POST', '/import/job-workbook', { file })).data;
  assert.equal(again.job_id, jid); assert.equal(again.created_job, false);
  for (const k of ['budget', 'tasks', 'milestones', 'cos', 'sov', 'apps', 'rfis', 'safety', 'cost']) assert.ok(again.done[k].skipped, k);
  assert.equal(again.done.labor.created, 0); assert.equal(again.done.labor.unchanged, 2);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM invoices WHERE job_id = ?').get(jid).n, 2);
});

test('options: no invoices; post to Accounting', async () => {
  const a = (await call('admin', 'POST', '/import/job-workbook', { file: workbook({ jobNo: '2699002' }).toString('base64'), create_invoices: false })).data;
  assert.equal(db.prepare('SELECT COUNT(*) n FROM invoices WHERE job_id = ?').get(a.job_id).n, 0);
  assert.equal((await call('admin', 'GET', `/projects/${a.job_id}/pay-apps`)).data.apps[0].status, 'Paid', 'status still from the workbook');
  const b = (await call('admin', 'POST', '/import/job-workbook', { file: workbook({ jobNo: '2699003' }).toString('base64'), post_to_ledger: true })).data;
  const inv = db.prepare("SELECT * FROM invoices WHERE job_id = ? ORDER BY id").get(b.job_id);
  assert.equal(inv.ledger_skip, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM journal_entries WHERE source_type = ? AND source_id = ?').get('invoice', inv.id).n, 1);
  const e = db.prepare('SELECT * FROM expenses WHERE job_id = ? ORDER BY id').get(b.job_id);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM journal_entries WHERE source_type = ? AND source_id = ?').get('expense', e.id).n, 1);
});

test('summary blocks under the logs are not entries; a suspicious job # is flagged and can be corrected', async () => {
  const file = workbook({ jobNo: '7824', contract: 7824 }).toString('base64');
  const p = (await call('admin', 'POST', '/import/job-workbook/preview', { file, file_name: 'A4YE_Job_6424_Sample.xlsx' })).data;
  const S = Object.fromEntries(p.sections.map(x => [x.key, x]));
  assert.equal(S.cos.count, 2, 'rows 129+ are the status summary'); assert.equal(S.sov.count, 4, 'row 70 is the total');
  assert.equal(p.job_number_doubts.length, 2);
  assert.match(p.job_number_doubts.join(' '), /same as the contract amount/); assert.match(p.job_number_doubts.join(' '), /file name says job 6424/);
  // corrected in the preview: the project gets 6424 and the time clock rows for 6424 are its own
  const fixed = (await call('admin', 'POST', '/import/job-workbook/preview', { file, file_name: 'A4YE_Job_6424_Sample.xlsx', job_number: '6424' })).data;
  assert.equal(fixed.job.number, '6424'); assert.equal(fixed.job.original_number, '7824'); assert.deepEqual(fixed.job_number_doubts, []);
  const r = (await call('admin', 'POST', '/import/job-workbook', { file, file_name: 'A4YE_Job_6424_Sample.xlsx', job_number: '6424' })).data;
  assert.equal(db.prepare('SELECT timeclock_job FROM jobs WHERE id = ?').get(r.job_id).timeclock_job, '6424');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM estimates WHERE job_id = ? AND change_order = 1').get(r.job_id).n, 2);
  assert.equal((await call('admin', 'POST', '/import/job-workbook/preview', { file, job_number: 'bad number!' })).status, 400);
});
