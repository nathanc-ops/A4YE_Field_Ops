'use strict';
// Ply Public API connector, against a fake Ply that enforces the documented contract
// (API_KEY header, required fields, paged lists, 429 rate limiting).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const D = require('../server/db');

// ------------------------------------------------------------ fake Ply
const KEY = 'k_test.secret';
const ply = { noJobsRead: false, calls: [], locations: [], materials: [], suppliers: [], jobs: [], picks: [], pickItems: {}, pos: [], poItems: {}, received: {}, rateLimitOnce: false };
const uuid = () => crypto.randomUUID();
const page = (arr, q) => { const p = Number(q.get('page') || 0), size = Math.min(100, Number(q.get('size') || 20)); return { data: arr.slice(p * size, p * size + size), pagination: { page: p, size, totalElements: arr.length, totalPages: Math.max(1, Math.ceil(arr.length / size)) } }; };
const plyServer = http.createServer((req, res) => {
  let raw = ''; req.on('data', c => raw += c); req.on('end', () => {
    const u = new URL(req.url, 'http://x'), path = u.pathname.replace(/^\/api\/v1/, ''), body = raw ? JSON.parse(raw) : null;
    ply.calls.push({ method: req.method, path, body, key: req.headers.api_key });
    const send = (code, obj, headers = {}) => { res.writeHead(code, { 'Content-Type': 'application/json', 'X-RateLimit-Remaining': '50', 'X-RateLimit-Reset': '30', ...headers }); res.end(JSON.stringify(obj)); };
    const bad = m => send(400, { code: 'VALIDATION_ERROR', message: m, status: 400 });
    if (req.headers.api_key !== KEY) return send(401, { code: 'UNAUTHORIZED', message: 'Invalid API key', status: 401 });
    if (ply.rateLimitOnce) { ply.rateLimitOnce = false; return send(429, { code: 'RATE_LIMITED', message: 'Too many requests', status: 429 }, { 'Retry-After': '1' }); }
    let m;
    if (req.method === 'GET' && path === '/locations') return send(200, page(ply.locations, u.searchParams));
    if (req.method === 'GET' && path === '/materials') return send(200, page(ply.materials, u.searchParams));
    if (req.method === 'POST' && path === '/materials') { if (!body.name) return bad('name required'); const x = { id: uuid(), active: true, serialized: false, categories: body.categoryNames || [], tags: [], ...body }; ply.materials.push(x); return send(201, x); }
    if (req.method === 'GET' && path === '/materials/availability') return send(200, page(ply.materials.map(x => ({ id: x.id, name: x.name, itemNumber: x.itemNumber, costForBusiness: x.costForBusiness, inventory: x.inventory || [], totalQuantity: (x.inventory || []).reduce((t, i) => t + i.quantity, 0) })), u.searchParams));
    if (req.method === 'GET' && path === '/suppliers') { const s = (u.searchParams.get('search') || '').toLowerCase(); return send(200, page(ply.suppliers.filter(x => x.businessName.toLowerCase().includes(s)), u.searchParams)); }
    if (req.method === 'GET' && path === '/jobs') {
      if (ply.noJobsRead) return send(403, { code: 'FORBIDDEN', message: 'Missing scope jobs:read', status: 403 });
      const q = (u.searchParams.get('textToSearch') || '').toLowerCase();
      const act = u.searchParams.get('active') !== 'false';   // Ply: active defaults to true (archived jobs left out)
      return send(200, page(ply.jobs.filter(x => (x.active !== false) === act && (!q || String(x.name).toLowerCase().includes(q))), u.searchParams));
    }
    if (req.method === 'GET' && (m = path.match(/^\/jobs\/([\w-]+)$/))) { const x = ply.jobs.find(j => j.id === m[1]); return x ? send(200, x) : send(404, { message: 'not found' }); }
    if (req.method === 'GET' && path === '/pick-lists') return send(200, page([...ply.picks].reverse(), u.searchParams));
    if (req.method === 'POST' && path === '/jobs') { if (!body.name) return bad('name required'); const x = { id: uuid(), active: true, ...body }; ply.jobs.push(x); return send(200, x); }
    if (req.method === 'PUT' && (m = path.match(/^\/jobs\/([\w-]+)$/))) { const x = ply.jobs.find(j => j.id === m[1]); Object.assign(x, body); return send(200, x); }
    if (req.method === 'POST' && path === '/pick-lists') {
      if (!body.name || !body.fromLocationId || !body.toLocationId) return bad('name, fromLocationId and toLocationId are required');
      if (!ply.locations.some(l => l.id === body.fromLocationId)) return bad('fromLocationId not found');
      if (!ply.jobs.some(j => j.id === body.toLocationId)) return bad('toLocationId not found');
      const x = { id: uuid(), status: 'NEED_REFILL', materialCount: 0, kitCount: 0, ...body }; ply.picks.push(x); ply.pickItems[x.id] = []; return send(201, x);
    }
    if ((m = path.match(/^\/pick-lists\/([\w-]+)$/))) { const x = ply.picks.find(p => p.id === m[1]); if (!x) return send(404, { message: 'not found' }); if (req.method === 'PUT') Object.assign(x, body); return send(200, x); }
    if (req.method === 'POST' && (m = path.match(/^\/pick-lists\/([\w-]+)\/materials$/))) {
      if (!(body.quantity > 0)) return bad('quantity must be > 0');
      if (!ply.materials.some(x => x.id === body.materialId)) return bad('material not found');
      const x = { id: uuid(), material: { id: body.materialId }, quantity: body.quantity, note: body.note }; ply.pickItems[m[1]].push(x); return send(201, x);
    }
    if (req.method === 'GET' && path === '/purchase-orders') {
      const loc = u.searchParams.get('locationId'), after = u.searchParams.get('createdAfter');
      if (after && !/^\d{4}-\d\d-\d\d$/.test(after)) return bad('createdAfter must be a date');
      return send(200, page(ply.pos.filter(p => (!loc || (p.location && p.location.id === loc)) && (!after || String(p.createdAt || '9999') >= after)), u.searchParams));
    }
    if (req.method === 'POST' && path === '/purchase-orders') {
      if (!body.orderNumber) return bad('orderNumber required');
      for (const it of body.items || []) if (!it.materialId || !(it.quantity > 0) || !(it.price >= 0)) return bad('items need materialId, quantity > 0 and price >= 0');
      const x = { id: uuid(), createdAt: new Date().toISOString().slice(0, 19), status: 'DRAFT', orderNumber: body.orderNumber, supplier: body.supplierId ? { id: body.supplierId } : null, location: body.locationId ? { id: body.locationId } : null, itemCount: (body.items || []).length };
      ply.pos.push(x); ply.poItems[x.id] = (body.items || []).map(it => ({ id: uuid(), material: { id: it.materialId }, quantity: it.quantity, price: it.price, note: it.note })); ply.received[x.id] = [];
      return send(201, x);
    }
    if ((m = path.match(/^\/purchase-orders\/([\w-]+)$/))) { const x = ply.pos.find(p => p.id === m[1]); if (req.method === 'PUT') Object.assign(x, { orderNumber: body.orderNumber }); return send(200, x); }
    if ((m = path.match(/^\/purchase-orders\/([\w-]+)\/items$/))) {
      if (req.method === 'POST') { const it = { id: uuid(), material: { id: body.materialId }, quantity: body.quantity, price: body.price }; ply.poItems[m[1]].push(it); return send(201, it); }
      return send(200, page(ply.poItems[m[1]], u.searchParams));
    }
    if ((m = path.match(/^\/purchase-orders\/([\w-]+)\/reconcile-items$/))) return send(200, page(ply.received[m[1]], u.searchParams));
    send(404, { code: 'NOT_FOUND', message: `no route ${req.method} ${path}`, status: 404 });
  });
});

let server, base, db;
const tok = {}, ids = {};
async function call(method, p, body) {
  const res = await fetch(base + '/api' + p, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok.admin }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json() };
}
before(async () => {
  plyServer.listen(0); await new Promise(r => plyServer.once('listening', r));
  process.env.PLY_API_BASE = `http://127.0.0.1:${plyServer.address().port}/api/v1`;
  const { createApp } = require('../server/app');
  db = D.open(':memory:');
  server = createApp(db).listen(0); await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  tok.admin = (await call('POST', '/setup', { name: 'Owner', email: 'o@x.com', password: 'longenough' })).data.token;
  // Ply side: a warehouse, a truck, 130 catalog items (forces paging), a supplier
  ply.locations.push({ id: uuid(), name: 'Shop Warehouse', type: 'WAREHOUSE', active: true }, { id: uuid(), name: 'Truck 3', type: 'TRUCK', active: true });
  for (let i = 0; i < 128; i++) ply.materials.push({ id: uuid(), name: `Filler item ${i}`, itemNumber: `F-${i}`, active: true, costForBusiness: 1, measurementUnit: 'EA', categories: [], tags: [] });
  ply.materials.push({ id: uuid(), name: '20A GFCI receptacle', itemNumber: 'MAT-GFCI', active: true, costForBusiness: 16.5, costForClient: 40, measurementUnit: 'EA', categories: ['Devices'], tags: [],
    inventory: [{ location: { id: ply.locations[0].id, type: 'WAREHOUSE' }, quantity: 40 }, { location: { id: ply.locations[1].id, type: 'TRUCK' }, quantity: 6 }, { location: { id: 'j', type: 'JOB' }, quantity: 99 }] });
  ply.materials.push({ id: uuid(), name: 'Wago 221 lever nuts (100pk)', itemNumber: 'WAGO-221', active: true, costForBusiness: 30, measurementUnit: 'BX', categories: [], tags: [] });
  ply.suppliers.push({ id: uuid(), businessName: 'City Electric Supply', additionalContacts: [] });
  ids.cust = (await call('POST', '/customers', { name: 'Summit GC', company: 'Summit Builders', phone: '208-555-0100', location: { address: '100 Tower Rd', city: 'Boise', state: 'ID', zip: '83702' } })).data.id;
  ids.job = (await call('POST', '/jobs', { customer_id: ids.cust, title: 'Medical office TI' })).data.id;
  ids.gfci = (await call('POST', '/pricebook', { code: 'MAT-GFCI', name: 'GFCI 20A', kind: 'material', unit_cost: 20, unit_price: 40, qty_on_hand: 10 })).data.id;
  ids.vendor = (await call('POST', '/vendors', { name: 'City Electric Supply' })).data.id;
});
after(() => { server.close(); plyServer.close(); delete process.env.PLY_API_BASE; });

test('not connected: clear message; wrong key: clear message', async () => {
  const r = await call('POST', '/integrations/ply/test');
  assert.equal(r.status, 400); assert.match(r.data.error, /not connected/i);
  await call('PUT', '/settings', { ply_enabled: '1', ply_api_key: 'wrong' });
  const w = await call('POST', '/integrations/ply/test');
  assert.equal(w.status, 502); assert.match(w.data.error, /rejected the API key/);
});

test('test connection: API_KEY header, locations listed and saved for the pickers', async () => {
  await call('PUT', '/settings', { ply_api_key: KEY });
  const r = await call('POST', '/integrations/ply/test');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.locations.length, 2); assert.equal(r.data.materials, 130); assert.equal(r.data.suppliers, 1);
  assert.ok(ply.calls.every(c => c.key === KEY || c.key === 'wrong'));
  assert.equal((await call('GET', '/me')).data.settings.ply_api_key, '', 'key never sent back to the browser');
  assert.equal(JSON.parse(db.prepare("SELECT value FROM settings WHERE key = 'ply_locations'").get().value).length, 2);
});

test('pull materials: pages through the whole catalog, links by SKU, stock counts warehouses + trucks only', async () => {
  const r = await call('POST', '/integrations/ply/pull-items');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.materials, 130); assert.equal(r.data.linked, 1); assert.equal(r.data.created, 129);
  const g = db.prepare('SELECT * FROM pricebook WHERE id = ?').get(ids.gfci);
  assert.equal(g.ply_item_id, ply.materials[128].id); assert.equal(g.unit_cost, 16.5); assert.equal(g.qty_on_hand, 46, '40 warehouse + 6 truck; job stock not counted');
  assert.equal(db.prepare("SELECT unit FROM pricebook WHERE code = 'WAGO-221'").get().unit, 'bx');
});

test('pick list → Ply: needs a source location; creates the job, the pick list and its materials; asks before adding custom items', async () => {
  const pl = (await call('POST', `/jobs/${ids.job}/pick-lists`, { needed_by: '2026-11-14', notes: 'Stage by 7am' })).data.id;
  await call('PUT', `/pick-lists/${pl}`, { lines: [{ pricebook_id: ids.gfci, qty: 12 }, { description: '3/4" EMT set-screw connector', qty: 50, unit: 'ea', unit_cost: 0.42, cost_code_id: db.prepare("SELECT id FROM cost_codes WHERE code = '0810'").get().id }] });
  let r = await call('POST', `/pick-lists/${pl}/send-to-ply`);
  assert.equal(r.status, 400); assert.match(r.data.error, /warehouse or truck/);
  await call('PUT', '/settings', { ply_from_location_id: ply.locations[0].id });
  r = await call('POST', `/pick-lists/${pl}/send-to-ply`);
  assert.equal(r.data.needs_confirmation, true); assert.deepEqual(r.data.missing, ['3/4" EMT set-screw connector']);
  assert.equal(ply.picks.length, 0, 'nothing sent until confirmed');
  ply.rateLimitOnce = true;   // a 429 on the way: retried, not failed
  r = await call('POST', `/pick-lists/${pl}/send-to-ply`, { create_missing: true });
  assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.sent, 2);
  const job = ply.jobs[0];
  assert.equal(job.number, db.prepare('SELECT number FROM jobs WHERE id = ?').get(ids.job).number);
  assert.equal(job.client.name, 'Summit Builders'); assert.equal(job.address.city, 'Boise');
  const p = ply.picks[0];
  assert.equal(p.fromLocationId, ply.locations[0].id); assert.equal(p.toLocationId, job.id); assert.equal(p.requestDate, '2026-11-14'); assert.equal(p.note, 'Stage by 7am');
  const items = ply.pickItems[p.id];
  assert.equal(items.length, 2); assert.equal(items[0].quantity, 12);
  assert.match(items[1].note, /0810-M/);
  assert.ok(ply.materials.some(m => m.name === '3/4" EMT set-screw connector'), 'custom item added to Ply catalog after confirmation');
  // re-send adds only new lines
  await call('PUT', `/pick-lists/${pl}`, { lines: [{ pricebook_id: ids.gfci, qty: 2, note: 'spares' }] });
  r = await call('POST', `/pick-lists/${pl}/send-to-ply`);
  assert.equal(r.data.sent, 1); assert.equal(ply.picks.length, 1); assert.equal(ply.pickItems[p.id].length, 3);
  // Ply completes the pick → our pick completes and charges the job
  p.status = 'COMPLETED';
  const s = await call('POST', '/integrations/ply/sync');
  assert.equal(s.data.picks_completed, 1);
  assert.equal(db.prepare('SELECT status FROM pick_lists WHERE id = ?').get(pl).status, 'picked');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM job_materials WHERE job_id = ?').get(ids.job).n, 3);
});

test('PO → Ply: supplier matched by name, delivered to the job, prices sent; receipts in Ply receive our lines', async () => {
  const po = (await call('POST', '/purchase-orders', { vendor_id: ids.vendor, job_id: ids.job, deliver_to: 'job', expected_date: '2026-11-20', lines: [
    { pricebook_id: ids.gfci, description: 'GFCI', qty: 10, unit_cost: 16.5 },
    { description: 'Wago 221 lever nuts (100pk)', qty: 3, unit_cost: 30 } ] })).data.id;
  const r = await call('POST', `/purchase-orders/${po}/send-to-ply`);
  assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.sent, 2); assert.equal(r.data.supplier_linked, true);
  const sent = ply.pos[0];
  assert.equal(sent.orderNumber, db.prepare('SELECT number FROM purchase_orders WHERE id = ?').get(po).number);
  assert.equal(sent.supplier.id, ply.suppliers[0].id); assert.equal(sent.location.id, ply.jobs[0].id);
  assert.deepEqual(ply.poItems[sent.id].map(i => [i.quantity, i.price]), [[10, 16.5], [3, 30]]);
  assert.equal(db.prepare('SELECT ply_vendor_id FROM vendors WHERE id = ?').get(ids.vendor).ply_vendor_id, ply.suppliers[0].id);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM po_lines WHERE po_id = ? AND ply_line_id IS NOT NULL').get(po).n, 2);
  // received in Ply: 6 GFCI now, the rest later
  const [gl, wl] = ply.poItems[sent.id];
  sent.status = 'PARTIALLY_RECEIVED'; ply.received[sent.id].push({ id: uuid(), purchaseOrderItemId: gl.id, quantity: 6, price: 16.5 });
  let s = await call('POST', '/integrations/ply/sync');
  assert.equal(s.data.received_lines, 1);
  assert.equal(db.prepare('SELECT qty_received FROM po_lines WHERE po_id = ? AND ply_line_id = ?').get(po, gl.id).qty_received, 6);
  s = await call('POST', '/integrations/ply/sync');
  assert.equal(s.data.received_lines, 0, 'same receipt is not counted twice');
  sent.status = 'RECEIVED'; ply.received[sent.id].push({ id: uuid(), purchaseOrderItemId: gl.id, quantity: 4 }, { id: uuid(), purchaseOrderItemId: wl.id, quantity: 3 });
  await call('POST', '/integrations/ply/sync');
  assert.equal(db.prepare('SELECT status FROM purchase_orders WHERE id = ?').get(po).status, 'received');
  // the old webhook address now explains itself
  const hook = await fetch(base + '/hooks/ply', { method: 'POST' });
  assert.equal(hook.status, 410);
});

test('POs made in Ply for a job are logged on the job; a Ply job with the same number gets linked; receipts charge the job', async () => {
  // a job that was set up in Ply by hand, with the same number, and a PO a foreman wrote in Ply
  const cust = (await call('POST', '/customers', { name: 'Ply Hand Customer' })).data.id;
  const jobId = (await call('POST', '/jobs', { customer_id: cust, title: 'Hand job' })).data.id;
  const num = db.prepare('SELECT number FROM jobs WHERE id = ?').get(jobId).number;
  const plyJob = { id: uuid(), name: `${num} Hand job`, number: num, active: true }; ply.jobs.push(plyJob);
  const mat = ply.materials[0];
  const pbLinked = db.prepare('SELECT id FROM pricebook WHERE ply_item_id = ?').get(mat.id);
  const supplier = { id: uuid(), name: 'Valley Electric Supply' };
  const handPo = { id: uuid(), createdAt: new Date().toISOString().slice(0, 19), orderNumber: 'PLY-77', status: 'SENT', supplier, location: { id: plyJob.id, name: plyJob.name }, totalCost: 262.5, itemCount: 2, note: 'Rush' };
  ply.pos.push(handPo);
  ply.poItems[handPo.id] = [{ id: uuid(), material: { id: mat.id, name: mat.name }, quantity: 5, price: 20 }, { id: uuid(), material: { id: uuid(), name: '3/4 EMT strap' }, variation: { id: uuid(), name: '1-hole' }, quantity: 50, price: 3 }];
  ply.received[handPo.id] = [];
  // and one to the warehouse, which isn't a job's
  ply.pos.push({ id: uuid(), createdAt: handPo.createdAt, orderNumber: 'PLY-78', status: 'SENT', supplier, location: { id: ply.locations[0].id }, itemCount: 0 });
  ply.poItems[ply.pos[ply.pos.length - 1].id] = [];
  let s = (await call('POST', '/integrations/ply/sync')).data;
  assert.equal(s.imported_pos, 1, JSON.stringify(s)); assert.ok(s.linked_jobs >= 1);
  assert.equal(db.prepare('SELECT ply_id FROM jobs WHERE id = ?').get(jobId).ply_id, plyJob.id);
  const po = db.prepare('SELECT * FROM purchase_orders WHERE ply_id = ?').get(handPo.id);
  assert.equal(po.job_id, jobId); assert.equal(po.status, 'submitted'); assert.equal(po.source, 'ply'); assert.equal(po.ply_number, 'PLY-77');
  assert.equal(po.shipping, 12.5, 'tax / shipping = Ply total − lines'); assert.match(po.notes, /Ply PLY-77 — Rush/);
  assert.equal(db.prepare('SELECT name FROM vendors WHERE id = ?').get(po.vendor_id).name, 'Valley Electric Supply');
  const lines = db.prepare('SELECT * FROM po_lines WHERE po_id = ? ORDER BY sort').all(po.id);
  assert.deepEqual(lines.map(l => [l.description, l.qty, l.unit_cost]), [[mat.name, 5, 20], ['3/4 EMT strap — 1-hole', 50, 3]]);
  if (pbLinked) assert.equal(lines[0].pricebook_id, pbLinked.id, 'linked to the price book item');
  const note = db.prepare('SELECT body FROM job_notes WHERE job_id = ? ORDER BY id DESC').get(jobId).body;
  assert.match(note, new RegExp(`${po.number} logged from Ply \\(PLY-77\\): Valley Electric Supply, 2 line\\(s\\), \\$262.50 — sent`));
  assert.equal((await call('GET', `/jobs/${jobId}`)).data.purchase_orders.length, 1, 'on the job\'s Purchasing tab');
  // a second sync doesn't duplicate; a line added in Ply comes in; receipts charge the job
  ply.poItems[handPo.id].push({ id: uuid(), material: { id: uuid(), name: 'Ground rod' }, quantity: 1, price: 18 });
  s = (await call('POST', '/integrations/ply/sync')).data;
  assert.equal(s.imported_pos, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM purchase_orders WHERE ply_id = ?').get(handPo.id).n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM po_lines WHERE po_id = ?').get(po.id).n, 3);
  handPo.status = 'RECEIVED';
  for (const it of ply.poItems[handPo.id]) ply.received[handPo.id].push({ id: uuid(), purchaseOrderItemId: it.id, quantity: it.quantity });
  s = (await call('POST', '/integrations/ply/sync')).data;
  assert.equal(s.received_lines, 3);
  assert.equal(db.prepare('SELECT status FROM purchase_orders WHERE id = ?').get(po.id).status, 'received');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM job_materials WHERE job_id = ?').get(jobId).n, 3, 'received to the job: charged as job materials');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM purchase_orders WHERE notes LIKE 'Ply PLY-78%'").get().n, 0, 'warehouse PO not put on a job');
});

test('Ply job matching by name, a job listing refused, linking by hand, and the job\'s live Ply panel (POs + pick list status)', async () => {
  const cust = (await call('POST', '/customers', { name: 'Sample Utility Co' })).data.id;
  const jobA = (await call('POST', '/jobs', { customer_id: cust, title: 'Riverside arc flash study' })).data.id;
  const jobB = (await call('POST', '/jobs', { customer_id: cust, title: 'Pump station feeder' })).data.id;
  // Ply has jobs with no number: one named like our title, one named something else
  const pA = { id: uuid(), name: 'Riverside Arc Flash Study', active: true }, pB = { id: uuid(), name: 'Pump stn - feeder replacement', active: true };
  ply.jobs.push(pA, pB);
  const sup = { id: uuid(), name: 'Valley Electric Supply' };
  const poA = { id: uuid(), createdAt: new Date().toISOString().slice(0, 19), orderNumber: 'PLY-201', status: 'RECEIVED', supplier: sup, location: { id: pA.id }, totalCost: 100, itemCount: 1, receivedAt: new Date().toISOString() };
  const poB = { id: uuid(), createdAt: poA.createdAt, orderNumber: 'PLY-202', status: 'SENT', supplier: sup, location: { id: pB.id }, totalCost: 50, itemCount: 1 };
  ply.pos.push(poA, poB);
  ply.poItems[poA.id] = [{ id: uuid(), material: { id: uuid(), name: 'Arc flash labels' }, quantity: 10, price: 10 }]; ply.received[poA.id] = [{ id: uuid(), purchaseOrderItemId: ply.poItems[poA.id][0].id, quantity: 10 }];
  ply.poItems[poB.id] = [{ id: uuid(), material: { id: uuid(), name: '500 kcmil' }, quantity: 1, price: 50 }]; ply.received[poB.id] = [];
  // 1) the key can't list jobs: already-linked jobs still import, and the reason is reported
  ply.noJobsRead = true;
  let s = (await call('POST', '/integrations/ply/sync')).data;
  assert.ok(s.errors.some(e => /jobs:read/.test(e)), JSON.stringify(s.errors));
  ply.noJobsRead = false;
  // 2) matched by name (title), received PO lands on the job, received
  s = (await call('POST', '/integrations/ply/sync')).data;
  assert.equal(db.prepare('SELECT ply_id FROM jobs WHERE id = ?').get(jobA).ply_id, pA.id);
  const here = db.prepare('SELECT * FROM purchase_orders WHERE ply_id = ?').get(poA.id);
  assert.equal(here.job_id, jobA); assert.equal(here.status, 'received');
  // 3) not matched → the panel offers likely Ply jobs; link by hand brings its PO in
  assert.equal(db.prepare('SELECT ply_id FROM jobs WHERE id = ?').get(jobB).ply_id, null);
  let p = (await call('GET', `/jobs/${jobB}/ply`)).data;
  assert.equal(p.linked, false); assert.ok(p.suggestions.some(x => x.id === pB.id), JSON.stringify(p.suggestions));
  assert.match((await call('PUT', `/jobs/${jobB}/ply-link`, { ply_id: pA.id })).data.error, /already linked/);
  const lk = (await call('PUT', `/jobs/${jobB}/ply-link`, { ply_id: pB.id })).data;
  assert.equal(lk.imported.imported, 1);
  // 4) the live panel: Ply job, its POs (here or not), pick lists going there with status
  ply.picks.push({ id: uuid(), name: 'Feeder lugs', status: 'ASSEMBLED', materialCount: 2, kitCount: 0, fromLocation: { id: ply.locations[0].id, name: 'Main Warehouse', type: 'WAREHOUSE' }, toLocation: { id: pB.id, name: pB.name, type: 'JOB' }, createdAt: new Date().toISOString() });
  ply.picks.push({ id: uuid(), name: 'Other job pick', status: 'NEED_REFILL', materialCount: 1, kitCount: 0, toLocation: { id: uuid(), name: 'x', type: 'JOB' }, createdAt: new Date().toISOString() });
  p = (await call('GET', `/jobs/${jobB}/ply`)).data;
  assert.equal(p.linked, true); assert.equal(p.ply_job.name, pB.name);
  assert.deepEqual(p.pos.map(x => [x.order_number, x.status, !!x.here]), [['PLY-202', 'SENT', true]]);
  assert.deepEqual(p.pick_lists.map(x => [x.name, x.status, x.from, x.items]), [['Feeder lugs', 'ASSEMBLED', 'Main Warehouse', 2]]);
  // 5) our own pick lists keep their Ply status from the sync
  const sent = db.prepare('SELECT * FROM pick_lists WHERE ply_id IS NOT NULL').get();
  if (sent) { const x = ply.picks.find(k => k.id === sent.ply_id); x.status = 'ASSEMBLED'; db.prepare("UPDATE pick_lists SET status = 'open' WHERE id = ?").run(sent.id);
    await call('POST', '/integrations/ply/sync'); assert.equal(db.prepare('SELECT ply_status FROM pick_lists WHERE id = ?').get(sent.id).ply_status, 'ASSEMBLED'); }
});

test('search Ply jobs by name while linking: open ones, archived on request, and which are already linked', async () => {
  ply.jobs.push({ id: uuid(), name: 'Westside clinic remodel', number: 'W-77', active: true, address: { address: '9 Elm St', city: 'Springfield' } },
    { id: uuid(), name: 'Westside clinic phase 1', active: false });
  assert.deepEqual((await call('GET', '/integrations/ply/jobs?q=w')).data, [], 'needs 2 letters');
  let r = (await call('GET', '/integrations/ply/jobs?q=westside')).data;
  assert.deepEqual(r.map(x => x.name), ['Westside clinic remodel']); assert.equal(r[0].number, 'W-77'); assert.equal(r[0].address, '9 Elm St, Springfield'); assert.equal(r[0].linked_to, null);
  r = (await call('GET', '/integrations/ply/jobs?q=westside&archived=1')).data;
  assert.deepEqual(r.map(x => [x.name, x.active]), [['Westside clinic remodel', true], ['Westside clinic phase 1', false]]);
  const linked = ply.jobs.find(x => db.prepare('SELECT 1 FROM jobs WHERE ply_id = ?').get(x.id));
  if (linked) { const hit = (await call('GET', '/integrations/ply/jobs?q=' + encodeURIComponent(linked.name.slice(0, 6)))).data.find(x => x.id === linked.id); if (hit) assert.ok(hit.linked_to, 'shows it is taken'); }
});
