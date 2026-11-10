'use strict';
// Scheduling estimates: a visit can be a walkthrough to price work, before there is any job.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const D = require('../server/db');
const { createApp } = require('../server/app');

let server, base, db;
const tok = {}, ids = {};
async function call(who, method, p, body) {
  const res = await fetch(base + '/api' + p, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok[who] }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json() };
}
// local wall-clock time tomorrow → ISO
const at = (h, m = 0, dayOffset = 1) => { const d = new Date(); d.setDate(d.getDate() + dayOffset); d.setHours(h, m, 0, 0); return d.toISOString(); };
const day = (dayOffset = 1) => { const d = new Date(); d.setDate(d.getDate() + dayOffset); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

before(async () => {
  db = D.open(':memory:');
  server = createApp(db).listen(0); await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  tok.admin = (await call(null, 'POST', '/setup', { name: 'Owner', email: 'o@x.com', password: 'longenough' })).data.token;
  ids.dana = (await call('admin', 'POST', '/users', { name: 'Dana', email: 'dana@x.com', password: 'password123', role: 'tech', hourly_wage: 36, burden_pct: 25 })).data.id;
  ids.sam = (await call('admin', 'POST', '/users', { name: 'Sam', email: 'sam@x.com', password: 'password123', role: 'tech', hourly_wage: 22 })).data.id;
  tok.dana = (await call(null, 'POST', '/login', { email: 'dana@x.com', password: 'password123' })).data.token;
  tok.sam = (await call(null, 'POST', '/login', { email: 'sam@x.com', password: 'password123' })).data.token;
  ids.cust = (await call('admin', 'POST', '/customers', { name: 'Maria Lopez', phone: '555-0101', location: { address: '12 Elm St', city: 'Boise' } })).data.id;
  ids.loc = db.prepare('SELECT id FROM locations WHERE customer_id = ?').get(ids.cust).id;
  ids.other = (await call('admin', 'POST', '/customers', { name: 'Other Co', location: { address: '9 Oak Ave' } })).data.id;
  ids.otherLoc = db.prepare('SELECT id FROM locations WHERE customer_id = ?').get(ids.other).id;
});
after(() => server.close());

test('book a walkthrough: draft estimate + scheduled visit in one step; shows on the schedule as an estimate', async () => {
  assert.equal((await call('admin', 'POST', '/estimate-visits', { customer_id: ids.cust, location_id: ids.otherLoc, start: at(9), end: at(10) })).status, 400, "someone else's address");
  assert.equal((await call('admin', 'POST', '/estimate-visits', { customer_id: ids.cust, start: at(10), end: at(9) })).status, 400, 'end before start');
  const r = await call('admin', 'POST', '/estimate-visits', { customer_id: ids.cust, location_id: ids.loc, title: 'Panel upgrade to 200A', start: at(9), end: at(10, 30), tech_ids: [ids.dana], notes: 'Gate code 1234' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  ids.visit = r.data.id; ids.est = r.data.estimate_id;
  const e = db.prepare('SELECT * FROM estimates WHERE id = ?').get(ids.est);
  assert.equal(e.status, 'draft'); assert.equal(e.title, 'Panel upgrade to 200A'); assert.equal(e.location_id, ids.loc); assert.equal(e.job_id, null);
  assert.match(e.number, /^EST-/);
  const list = (await call('admin', 'GET', `/appointments?from=${encodeURIComponent(at(0))}&to=${encodeURIComponent(at(23, 59))}`)).data;
  const v = list.find(x => x.id === ids.visit);
  assert.equal(v.kind, 'estimate'); assert.equal(v.href, `#/estimates/${ids.est}`); assert.equal(v.job_id, null); assert.equal(v.estimate_id, ids.est);
  assert.equal(v.job_number, e.number); assert.equal(v.job_title, 'Estimate visit: Panel upgrade to 200A');
  assert.equal(v.customer_name, 'Maria Lopez'); assert.equal(v.address, '12 Elm St'); assert.deepEqual(v.tech_ids, [ids.dana]);
  // no job got created or crewed
  assert.equal(db.prepare('SELECT COUNT(*) n FROM jobs').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM job_techs').get().n, 0);
  // the estimate lists its visits
  const full = (await call('admin', 'GET', `/estimates/${ids.est}`)).data;
  assert.equal(full.visits.length, 1); assert.equal(full.visits[0].notes, 'Gate code 1234');
  // dispatch counts the hours on Dana's day
  const disp = (await call('admin', 'GET', `/dispatch?date=${day()}`)).data;
  assert.ok(disp.appointments.some(a => a.id === ids.visit));
  assert.equal(disp.techs.find(t => t.id === ids.dana).booked_hours, 1.5);
});

test('a second visit on an existing estimate; one target only; double-booking is flagged against job visits too', async () => {
  assert.equal((await call('admin', 'POST', '/appointments', { start: at(13), end: at(14) })).status, 400, 'job or estimate required');
  const job = (await call('admin', 'POST', '/jobs', { customer_id: ids.other, title: 'Fix outlet' })).data.id;
  assert.equal((await call('admin', 'POST', '/appointments', { job_id: job, estimate_id: ids.est, start: at(13), end: at(14) })).status, 400, 'not both');
  const jv = await call('admin', 'POST', '/appointments', { job_id: job, start: at(10), end: at(11), tech_ids: [ids.dana] });
  assert.equal(jv.status, 200);
  assert.equal(jv.data.conflicts.length, 1, 'overlaps the 9–10:30 walkthrough');
  assert.equal(jv.data.conflicts[0].job_number, db.prepare('SELECT number FROM estimates WHERE id = ?').get(ids.est).number);
  const second = await call('admin', 'POST', '/appointments', { estimate_id: ids.est, start: at(15, 0, 3), end: at(16, 0, 3), tech_ids: [ids.sam] });
  assert.equal(second.status, 200, JSON.stringify(second.data));
  assert.equal((await call('admin', 'GET', `/estimates/${ids.est}`)).data.visits.length, 2);
  // move it; the job's schedule window is untouched by estimate visits
  assert.equal((await call('admin', 'PUT', `/appointments/${second.data.id}`, { start: at(8, 0, 3), end: at(9, 0, 3) })).status, 200);
  const j = db.prepare('SELECT * FROM jobs WHERE id = ?').get(job);
  assert.equal(j.scheduled_start, new Date(at(10)).toISOString()); assert.equal(j.status, 'scheduled');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM job_techs WHERE user_id = ?').get(ids.sam).n, 0, 'Sam was not added to any job crew');
});

test('the tech booked on the walkthrough sees it, opens the estimate, and the visit drives their time clock', async () => {
  const mine = (await call('dana', 'GET', `/appointments?from=${encodeURIComponent(at(0))}&to=${encodeURIComponent(at(23, 59))}`)).data;
  assert.ok(mine.some(a => a.id === ids.visit && a.kind === 'estimate'));
  const e = await call('dana', 'GET', `/estimates/${ids.est}`);
  assert.equal(e.status, 200, JSON.stringify(e.data)); assert.equal(e.data.visits.length, 2);
  assert.ok((await call('dana', 'GET', '/estimates')).data.some(x => x.id === ids.est), 'in their estimate list');
  // Sam is on the other visit for the same estimate; a tech on neither can't open it
  const third = (await call('admin', 'POST', '/users', { name: 'Lee', email: 'lee@x.com', password: 'password123', role: 'tech' })).data.id;
  tok.lee = (await call(null, 'POST', '/login', { email: 'lee@x.com', password: 'password123' })).data.token;
  assert.equal((await call('lee', 'GET', `/estimates/${ids.est}`)).status, 403);
  assert.ok(third);
  // the tech builds the price on site
  const pb = (await call('admin', 'POST', '/pricebook', { name: '200A panel upgrade', kind: 'service', unit_price: 3200, unit_cost: 1400 })).data.id;
  const put = await call('dana', 'PUT', `/estimates/${ids.est}`, { items: [{ pricebook_id: pb, description: '200A panel upgrade', qty: 1, unit_price: 3200 }] });
  assert.equal(put.status, 200, JSON.stringify(put.data));
  // en route → on site → done: travel then site time, no job attached, closed by the visit
  for (const st of ['en_route', 'on_site']) assert.equal((await call('dana', 'PUT', `/appointments/${ids.visit}`, { status: st })).status, 200);
  let te = db.prepare('SELECT * FROM time_entries WHERE user_id = ? ORDER BY id').all(ids.dana);
  assert.deepEqual(te.map(t => t.kind), ['travel', 'job']); assert.equal(te[1].job_id, null); assert.equal(te[1].appointment_id, ids.visit);
  assert.match(te[1].notes, /^Estimate visit EST-/); assert.ok(te[0].clock_out, 'travel closed on arrival');
  assert.equal((await call('dana', 'PUT', `/appointments/${ids.visit}`, { status: 'done' })).status, 200);
  te = db.prepare('SELECT * FROM time_entries WHERE user_id = ? ORDER BY id').all(ids.dana);
  assert.ok(te[1].clock_out, 'site time closed when the visit is done');
  assert.equal(db.prepare('SELECT status FROM appointments WHERE id = ?').get(ids.visit).status, 'done');
});

test('cancelling the estimate cancels its open visits; deleting it removes them', async () => {
  const r = await call('admin', 'POST', '/estimate-visits', { customer_id: ids.cust, title: 'EV charger', start: at(11, 0, 4), end: at(12, 0, 4), tech_ids: [ids.sam] });
  assert.equal((await call('admin', 'POST', `/estimates/${r.data.estimate_id}/cancel`, { reason: 'Customer went with someone else' })).status, 200);
  assert.equal(db.prepare('SELECT status FROM appointments WHERE id = ?').get(r.data.id).status, 'cancelled');
  assert.equal((await call('admin', 'POST', '/appointments', { estimate_id: r.data.estimate_id, start: at(11, 0, 5), end: at(12, 0, 5) })).status, 400, 'no visits for a cancelled estimate');
  // the earlier estimate: the done visit stays done when cancelled
  assert.equal((await call('admin', 'POST', `/estimates/${ids.est}/cancel`, {})).status, 200);
  assert.equal(db.prepare('SELECT status FROM appointments WHERE id = ?').get(ids.visit).status, 'done');
  db.prepare('DELETE FROM estimate_items WHERE estimate_id = ?').run(r.data.estimate_id);
  db.prepare('DELETE FROM estimates WHERE id = ?').run(r.data.estimate_id);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM appointments WHERE estimate_id = ?').get(r.data.estimate_id).n, 0, 'cascade');
  // office users without the scheduling permission can't book one
  const ann = (await call('admin', 'POST', '/users', { name: 'Ann', email: 'ann@x.com', password: 'password123', role: 'office', perms: { jobs: false } })).data.id;
  assert.ok(ann);
  tok.ann = (await call(null, 'POST', '/login', { email: 'ann@x.com', password: 'password123' })).data.token;
  assert.equal((await call('ann', 'POST', '/estimate-visits', { customer_id: ids.cust, start: at(9, 0, 6), end: at(10, 0, 6) })).status, 403);
});
