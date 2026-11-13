'use strict';
// Staff who aren't techs (a service manager running calls) can be put on the schedule like a tech.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const D = require('../server/db');
const { createApp } = require('../server/app');

let server, base, db; const tok = {};
async function call(who, method, p, body) {
  const res = await fetch(base + '/api' + p, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok[who] }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json() };
}
before(async () => {
  db = D.open(':memory:');
  server = createApp(db).listen(0); await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  tok.admin = (await call(null, 'POST', '/setup', { name: 'Owner', email: 'o@x.com', password: 'longenough' })).data.token;
});
after(() => server.close());

test('Show on the schedule puts a non-tech on Dispatch and in the user list the boards read', async () => {
  await call('admin', 'POST', '/users', { name: 'Field Tech', email: 't@x.com', password: 'password123', role: 'tech' });
  const sm = (await call('admin', 'POST', '/users', { name: 'Service Manager', email: 'sm@x.com', password: 'password123', role: 'manager', title: 'Service Manager' })).data.id;
  await call('admin', 'POST', '/users', { name: 'Desk', email: 'd@x.com', password: 'password123', role: 'office' });
  let names = (await call('admin', 'GET', '/dispatch')).data.techs.map(t => t.name);
  assert.deepEqual(names, ['Field Tech'], 'off by default');
  await call('admin', 'PUT', `/users/${sm}`, { on_schedule: 1 });
  names = (await call('admin', 'GET', '/dispatch')).data.techs.map(t => t.name);
  assert.deepEqual(names, ['Field Tech', 'Service Manager'], 'on Dispatch now; plain office staff still not');
  assert.equal((await call('admin', 'GET', '/users')).data.find(u => u.id === sm).on_schedule, 1, 'the boards read it from the user list');
  await call('admin', 'PUT', `/users/${sm}`, { on_schedule: 0 });
  assert.deepEqual((await call('admin', 'GET', '/dispatch')).data.techs.map(t => t.name), ['Field Tech']);
});
