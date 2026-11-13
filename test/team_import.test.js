'use strict';
// Team → Import list: update email/phone of people already here, add the rest. Made-up people only.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const D = require('../server/db');
const { createApp } = require('../server/app');
const TI = require('../server/team_import');

let server, base, db; const tok = {};
async function call(who, method, p, body) {
  const res = await fetch(base + '/api' + p, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok[who] }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json() };
}
before(async () => {
  db = D.open(':memory:');
  server = createApp(db).listen(0); await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  tok.admin = (await call(null, 'POST', '/setup', { name: 'Owner Person', email: 'owner@example.com', password: 'longenough' })).data.token;
  await call('admin', 'POST', '/users', { name: 'Pat Sample', email: 'pat.old@example.com', password: 'password123', role: 'tech', phone: '555-000-0000', hourly_wage: 30 });
  await call('admin', 'POST', '/users', { name: 'Robin Example', email: 'robin@example.com', password: 'password123', role: 'office' });
});
after(() => server.close());

// pasted straight from Google Sheets: tab-separated, en-dash role text, ⚠️ markers
const SHEET = [
  'Name\tRole\tEmail\tPhone',
  'Owner Person\tAdmin – Manager/Office\towner@example.com\t(555) 100-0001',
  'Pat Sample\tField Tech – Commercial\tpat.new@example.com\t555.100.0002',
  'Robin Example\tAdmin – Office\trobin@example.com ⚠️\t(555) 100-0003',
  'Casey Newhire\tAdmin – Service/Estimates/Manager\tcasey@example.com\t(555) 100-0004 ⚠️',
  'Jordan Fresh\tField Tech\tjordan@example.com\t5551000005',
  'No Email Person\tField Tech\t\t(555) 100-0006',
].join('\n');

test('roles from the sheet text never give Admin', () => {
  assert.equal(TI.roleFrom('Field Tech – Commercial/Service'), 'tech');
  assert.equal(TI.roleFrom('Admin – Service/Estimates/Manager'), 'manager');
  assert.equal(TI.roleFrom('Admin – Office'), 'office');
  assert.equal(TI.roleFrom('Admin – Manager/Office'), 'manager');
  assert.equal(TI.cleanPhone('555.100.0002').value, '(555) 100-0002');
  assert.equal(TI.cleanEmail('a@example.com ⚠️').value, 'a@example.com');
});

test('preview writes nothing; apply updates matches and adds the rest', async () => {
  const pv = await call('admin', 'POST', '/users/import', { csv: SHEET });
  assert.equal(pv.status, 200);
  const by = Object.fromEntries(pv.data.items.map(i => [i.name, i]));
  assert.equal(by['Owner Person'].action, 'update');
  assert.deepEqual(Object.keys(by['Owner Person'].changes), ['phone']);
  assert.equal(by['Pat Sample'].action, 'update'); assert.equal(by['Pat Sample'].matched_by, 'name');
  assert.equal(by['Pat Sample'].changes.email.to, 'pat.new@example.com');
  assert.match(by['Robin Example'].warnings.join(), /marks this email/);
  assert.equal(by['Casey Newhire'].action, 'add'); assert.equal(by['Casey Newhire'].role, 'manager');
  assert.match(by['Casey Newhire'].warnings.join(), /marks this phone/);
  assert.equal(by['No Email Person'].action, 'skip');
  assert.equal((await call('admin', 'GET', '/users')).data.length, 3, 'preview saved nothing');

  const ap = await call('admin', 'POST', '/users/import', { csv: SHEET, apply: true });
  assert.equal(ap.status, 200);
  const users = (await call('admin', 'GET', '/users')).data, u = n => users.find(x => x.name === n);
  assert.equal(users.length, 5);
  assert.equal(u('Pat Sample').email, 'pat.new@example.com'); assert.equal(u('Pat Sample').phone, '(555) 100-0002');
  assert.equal(u('Pat Sample').role, 'tech'); assert.equal(u('Pat Sample').hourly_wage, 30, 'wage untouched');
  assert.equal(u('Owner Person').role, 'admin');
  assert.equal(u('Robin Example').phone, '(555) 100-0003');
  assert.equal(u('Casey Newhire').role, 'manager'); assert.equal(u('Casey Newhire').title, 'Admin – Service/Estimates/Manager');
  assert.equal(u('Casey Newhire').active, 0, 'no starting password → added inactive');
  assert.equal(u('Jordan Fresh').phone, '(555) 100-0005');
  // the old login still works for the updated person, under the new email
  const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'pat.new@example.com', password: 'password123' }) });
  assert.equal(login.status, 200);
  // running it again changes nothing
  const again = (await call('admin', 'POST', '/users/import', { csv: SHEET })).data.items;
  assert.ok(again.every(i => i.action === 'same' || i.action === 'skip'), JSON.stringify(again.map(i => [i.name, i.action])));
});

test('a starting password adds people active and able to sign in; non-admins are refused', async () => {
  const csv = 'Name,Email,Phone\nSam Starter,sam@example.com,555-100-0007';
  assert.equal((await call('admin', 'POST', '/users/import', { csv, apply: true, start_password: 'short' })).status, 400);
  await call('admin', 'POST', '/users/import', { csv, apply: true, start_password: 'welcome-2026' });
  const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'sam@example.com', password: 'welcome-2026' }) });
  assert.equal(login.status, 200);
  tok.sam = (await login.json()).token;
  assert.equal((await call('sam', 'POST', '/users/import', { csv })).status, 403);
});

test('an email that belongs to someone else is not moved', async () => {
  const items = (await call('admin', 'POST', '/users/import', { csv: 'Name,Email\nRobin Example,sam@example.com' })).data.items;
  assert.equal(items[0].action, 'same'); assert.match(items[0].warnings.join(), /already belongs to Sam Starter/);
});
