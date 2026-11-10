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
const ply = { calls: [], locations: [], materials: [], suppliers: [], jobs: [], picks: [], pickItems: {}, pos: [], poItems: {}, received: {}, rateLimitOnce: false };
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
    if (req.method === 'GET' && path === '/jobs') return send(200, page(ply.jobs, u.searchParams));
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
    if (req.method === 'POST' && path === '/purchase-orders') {
      if (!body.orderNumber) return bad('orderNumber required');
      for (const it of body.items || []) if (!it.materialId || !(it.quantity > 0) || !(it.price >= 0)) return bad('items need materialId, quantity > 0 and price >= 0');
      const x = { id: uuid(), status: 'DRAFT', orderNumber: body.orderNumber, supplier: body.supplierId ? { id: body.supplierId } : null, location: body.locationId ? { id: body.locationId } : null, itemCount: (body.items || []).length };
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
