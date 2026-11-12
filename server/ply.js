'use strict';
// Ply (getply.com) — built against the Ply Public API (https://docs.getply.com, OpenAPI 3.1, /api/v1).
//
//  Auth: API_KEY header. Production https://api.getply.com/api/v1, demo https://demo-api.getply.com/api/v1.
//  Limits: 60 requests/minute and 10,000/day per business; lists are paged (page from 0, size up to 100).
//  Ply has no webhooks, so changes in Ply (PO receipts, completed picks) are pulled: Sync now, or hourly.
//
//  Field Ops → Ply
//   job        → POST/PUT /jobs                       (Ply job = the job site location)
//   pick list  → POST /pick-lists (from your warehouse/truck → the job) + POST /pick-lists/{id}/materials
//   PO         → POST /purchase-orders with items (supplier matched by name), left as DRAFT in Ply
//  Ply → Field Ops
//   materials  → price book (cost, client price, unit, stock on hand at warehouses/trucks)
//   PO receipts (reconcile-items) → receive our PO lines;   pick list COMPLETED → complete our pick
//
//  Every Ply line must be a Ply catalog material. Lines are matched by Ply id, then SKU = item number,
//  then exact name. Items Ply doesn't have are reported; with create_missing they're added to Ply's catalog.
const D = require('./db');
const { all, get, run, settings, tx } = D;

const BASES = { production: 'https://api.getply.com/api/v1', demo: 'https://demo-api.getply.com/api/v1' };
function config(db) {
  const s = settings(db);
  const env = s.ply_env === 'demo' ? 'demo' : 'production';
  return {
    enabled: s.ply_enabled === '1' && !!s.ply_api_key, env, key: s.ply_api_key,
    base: (process.env.PLY_API_BASE || BASES[env]).replace(/\/+$/, ''),      // PLY_API_BASE only for tests
    fromLocation: s.ply_from_location_id || '', poLocation: s.ply_po_location_id || '',
  };
}
function log(db, direction, event, status, detail) {
  run(db, 'INSERT INTO integration_log (provider, direction, event, status, detail) VALUES (?,?,?,?,?)',
    'ply', direction, event, status, typeof detail === 'string' ? detail.slice(0, 4000) : JSON.stringify(detail).slice(0, 4000));
}
const err = (msg, status = 502) => Object.assign(new Error(msg), { status });
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function request(db, method, path, body, { query, quiet } = {}) {
  const c = config(db);
  if (!c.enabled) throw err('Ply is not connected. Turn it on and add the API key under Settings → Integrations – Ply.', 400);
  const url = c.base + path + (query ? '?' + new URLSearchParams(Object.entries(query).filter(([, v]) => v != null && v !== '')) : '');
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url, { method, headers: { 'Content-Type': 'application/json', Accept: 'application/json', API_KEY: c.key },
        body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) });
    } catch { throw err("Can't reach Ply right now. Check the server's internet connection and try again."); }
    const text = await res.text();
    let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text.slice(0, 500) }; }
    if (res.status === 429 && attempt < 2) {           // shared limit: 60/minute — wait for the window, then retry
      const wait = Math.min(65, Number(res.headers.get('retry-after') || res.headers.get('x-ratelimit-reset')) || 20);
      log(db, 'out', `${method} ${path}`, 'rate_limited', `waiting ${wait}s`); await sleep(wait * 1000); continue;
    }
    if (!quiet || !res.ok) log(db, 'out', `${method} ${path}`, res.ok ? 'ok' : `http_${res.status}`, { request: body, response: data });
    if (res.ok) {
      const left = Number(res.headers.get('x-ratelimit-remaining'));
      if (Number.isFinite(left) && left < 3) await sleep(Math.min(60, Number(res.headers.get('x-ratelimit-reset')) || 10) * 1000);
      return data;
    }
    const m = data.message || data.error || text.slice(0, 200);
    if (res.status === 401) throw err('Ply rejected the API key. Create a new key in Ply (Settings → Workspace → API Keys) and paste it here.');
    if (res.status === 403) throw err(`The Ply API key is missing a permission (scope) for this: ${m}. Edit the key in Ply and add the scope.`);
    if (res.status === 404) throw err(`Ply couldn't find that record (${path}). It may have been deleted in Ply.`);
    throw err(`Ply said: ${m} (HTTP ${res.status})`);
  }
}
// every page of a list endpoint
async function listAll(db, path, query = {}) {
  const out = [];
  for (let page = 0; page < 200; page++) {
    const r = await request(db, 'GET', path, null, { query: { ...query, page, size: 100 }, quiet: true });
    out.push(...(r.data || []));
    if (!r.pagination || page + 1 >= r.pagination.totalPages) break;
  }
  return out;
}

// ------------------------------------------------------------ connection test + locations
async function test(db) {
  const [locs, mats, sups] = await Promise.all([
    listAll(db, '/locations'),
    request(db, 'GET', '/materials', null, { query: { page: 0, size: 1 } }),
    request(db, 'GET', '/suppliers', null, { query: { page: 0, size: 1 } }).catch(e => ({ error: e.message })),
  ]);
  return { ok: true, locations: locs.filter(l => !l.archived && l.active !== false).map(l => ({ id: l.id, name: l.name, type: l.type, number: l.number })),
    materials: mats.pagination ? mats.pagination.totalElements : (mats.data || []).length,
    suppliers: sups.pagination ? sups.pagination.totalElements : null, suppliers_error: sups.error || null };
}

// ------------------------------------------------------------ materials ↔ price book
// Ply catalog → price book. Stock counts warehouses and trucks (not material already sent to jobs).
async function pullItems(db) {
  const [mats, avail] = await Promise.all([listAll(db, '/materials'), listAll(db, '/materials/availability')]);
  const qty = new Map(avail.map(a => [a.id, (a.inventory || []).filter(i => !i.location || i.location.type !== 'JOB').reduce((t, i) => t + (Number(i.quantity) || 0), 0)]));
  let updated = 0, created = 0, linked = 0;
  for (const m of mats) {
    if (m.active === false || m.materialType === 'TEMPORARY_LINE_ITEM') continue;
    let row = get(db, 'SELECT * FROM pricebook WHERE ply_item_id = ?', m.id);
    if (!row && m.itemNumber) row = get(db, 'SELECT * FROM pricebook WHERE ply_item_id IS NULL AND lower(code) = lower(?)', m.itemNumber);
    if (!row) row = get(db, 'SELECT * FROM pricebook WHERE ply_item_id IS NULL AND lower(trim(name)) = lower(trim(?))', m.name);
    const onHand = qty.has(m.id) ? Math.round(qty.get(m.id) * 1000) / 1000 : null;
    if (row) {
      if (!row.ply_item_id) linked++;
      run(db, `UPDATE pricebook SET ply_item_id = ?, unit_cost = COALESCE(?, unit_cost), qty_on_hand = COALESCE(?, qty_on_hand), unit = COALESCE(unit, ?) WHERE id = ?`,
        m.id, m.costForBusiness ?? null, onHand, m.measurementUnit ? m.measurementUnit.toLowerCase() : null, row.id);
      updated++;
    } else {
      const cost = Number(m.costForBusiness) || 0;
      run(db, "INSERT INTO pricebook (code, name, kind, unit, unit_cost, unit_price, qty_on_hand, ply_item_id, category, description) VALUES (?,?,?,?,?,?,?,?,?,?)",
        m.itemNumber || null, m.name, 'material', m.measurementUnit ? m.measurementUnit.toLowerCase() : 'ea', cost,
        Number(m.costForClient) || Math.round(cost * 1.35 * 100) / 100, onHand || 0, m.id, (m.categories && m.categories[0]) || 'Ply', m.description || null);
      created++;
    }
  }
  return { updated, created, linked, materials: mats.length };
}
// a Ply material id for one of our lines: linked price-book item, else find it in Ply by SKU/name, else (optionally) create it
async function materialFor(db, line, { createMissing, cache }) {
  if (line.ply_item_id) return line.ply_item_id;
  const key = `${line.sku || ''}|${String(line.description).toLowerCase().trim()}`;
  if (cache.has(key)) return cache.get(key);
  if (!cache.catalog) cache.catalog = await listAll(db, '/materials');
  const hit = cache.catalog.find(m => m.active !== false && line.sku && m.itemNumber && m.itemNumber.toLowerCase() === String(line.sku).toLowerCase())
    || cache.catalog.find(m => m.active !== false && m.name.toLowerCase().trim() === String(line.description).toLowerCase().trim());
  let id = hit ? hit.id : null;
  if (!id && createMissing) {
    const made = await request(db, 'POST', '/materials', { name: String(line.description).slice(0, 500), itemNumber: line.sku || undefined,
      description: line.note || undefined, categoryNames: line.cost_code_name ? [line.cost_code_name] : undefined });
    id = made.id; cache.catalog.push(made);
  }
  if (id && line.pricebook_id) run(db, 'UPDATE pricebook SET ply_item_id = COALESCE(ply_item_id, ?) WHERE id = ?', id, line.pricebook_id);
  cache.set(key, id); return id;
}
// A4YE cost codes are 4-digit bases; for material the job tracker uses Full Code base-M (e.g. 0810-M).
const matCode = (ply, code) => ply || (code && /^\d{4}$/.test(code) ? `${code}-M` : code) || undefined;

// ------------------------------------------------------------ jobs
function toPlyJob(db, jobId) {
  const j = get(db, `SELECT j.*, c.name customer, c.company, c.phone, l.address, l.city, l.state, l.zip FROM jobs j JOIN customers c ON c.id = j.customer_id
    LEFT JOIN locations l ON l.id = COALESCE(j.location_id, (SELECT id FROM locations WHERE customer_id = j.customer_id ORDER BY id LIMIT 1)) WHERE j.id = ?`, jobId);
  const addr = j.address ? { address: String(j.address).slice(0, 125), city: j.city || undefined, state: j.state || undefined, zipCode: j.zip || undefined } : undefined;
  return { name: `${j.number} ${j.title}`.slice(0, 500), number: j.number, client: { name: (j.company || j.customer || '').slice(0, 255), phoneNumber: j.phone ? String(j.phone).slice(0, 50) : undefined },
    scheduledAt: j.scheduled_start || undefined, note: [j.description, j.timeclock_job ? `Time clock job # ${j.timeclock_job}` : ''].filter(Boolean).join('\n').slice(0, 5000) || undefined, address: addr };
}
async function pushJob(db, jobId) {
  const j = get(db, 'SELECT id, ply_id FROM jobs WHERE id = ?', jobId);
  const body = toPlyJob(db, jobId);
  let r;
  if (j.ply_id) r = await request(db, 'PUT', `/jobs/${encodeURIComponent(j.ply_id)}`, body);
  else {
    // already in Ply under this job number (e.g. created by hand)? link instead of duplicating
    const existing = (await listAll(db, '/jobs')).find(x => x.number && x.number === body.number);
    r = existing || await request(db, 'POST', '/jobs', body);
  }
  run(db, 'UPDATE jobs SET ply_id = ? WHERE id = ?', String(r.id), jobId);
  return { ply_id: r.id, name: r.name || body.name };
}
const ensureJob = async (db, jobId) => { const j = get(db, 'SELECT ply_id FROM jobs WHERE id = ?', jobId); return j.ply_id || (await pushJob(db, jobId)).ply_id; };

// ------------------------------------------------------------ pick lists
function pickLines(db, plId) {
  return all(db, `SELECT pl.*, pb.code sku, pb.ply_item_id, cc.code cost_code, cc.name cost_code_name, cc.ply_code FROM pick_list_lines pl
    LEFT JOIN pricebook pb ON pb.id = pl.pricebook_id LEFT JOIN cost_codes cc ON cc.id = pl.cost_code_id WHERE pick_list_id = ? ORDER BY pl.id`, plId);
}
function toPlyPickList(db, plId) {
  const p = get(db, 'SELECT p.*, j.number job_number FROM pick_lists p JOIN jobs j ON j.id = p.job_id WHERE p.id = ?', plId);
  return { header: { name: `${p.number} · ${p.job_number}`, note: p.notes || undefined, requestDate: p.needed_by || undefined },
    lines: pickLines(db, plId).map(l => ({ id: l.id, description: l.description, quantity: l.qty, materialId: l.ply_item_id || null, note: [l.note, matCode(l.ply_code, l.cost_code)].filter(Boolean).join(' · ') || undefined })) };
}
async function pushPickList(db, plId, { createMissing = false } = {}) {
  const c = config(db);
  if (!c.fromLocation) throw err('Choose which Ply warehouse or truck pick lists come from (Settings → Integrations – Ply → Test connection).', 400);
  const p = get(db, 'SELECT * FROM pick_lists WHERE id = ?', plId);
  const lines = pickLines(db, plId).filter(l => !l.ply_line_id);
  const cache = new Map();
  const ids = []; const missing = [];
  for (const l of lines) { const id = await materialFor(db, l, { createMissing, cache }); if (id) ids.push([l, id]); else missing.push(l.description); }
  if (missing.length && !createMissing) return { sent: 0, missing, needs_confirmation: true };
  const toJob = await ensureJob(db, p.job_id);
  const h = toPlyPickList(db, plId).header;
  let plyId = p.ply_id;
  if (!plyId) { const r = await request(db, 'POST', '/pick-lists', { ...h, fromLocationId: c.fromLocation, toLocationId: toJob }); plyId = r.id; }
  else await request(db, 'PUT', `/pick-lists/${encodeURIComponent(plyId)}`, h);
  run(db, "UPDATE pick_lists SET ply_id = ?, ply_synced_at = datetime('now') WHERE id = ?", String(plyId), plId);
  for (const [l, mid] of ids) {
    const r = await request(db, 'POST', `/pick-lists/${encodeURIComponent(plyId)}/materials`, { materialId: mid, quantity: l.qty, note: [l.note, matCode(l.ply_code, l.cost_code)].filter(Boolean).join(' · ') || undefined });
    run(db, 'UPDATE pick_list_lines SET ply_line_id = ? WHERE id = ?', String(r.id), l.id);
  }
  return { sent: ids.length, ply_id: plyId, missing };
}

// ------------------------------------------------------------ purchase orders
function poLines(db, poId) {
  return all(db, `SELECT pl.*, pb.code sku, pb.ply_item_id, cc.code cost_code, cc.name cost_code_name, cc.ply_code FROM po_lines pl
    LEFT JOIN pricebook pb ON pb.id = pl.pricebook_id LEFT JOIN cost_codes cc ON cc.id = pl.cost_code_id WHERE po_id = ? ORDER BY sort, id`, poId);
}
function toPlyPO(db, poId) {
  const po = get(db, 'SELECT p.*, v.name vendor_name, v.ply_vendor_id FROM purchase_orders p JOIN vendors v ON v.id = p.vendor_id WHERE p.id = ?', poId);
  return { orderNumber: po.number, supplier: po.vendor_name, supplierId: po.ply_vendor_id || null, note: po.notes || undefined, dueDate: po.expected_date || undefined,
    items: poLines(db, poId).map(l => ({ id: l.id, description: l.description, materialId: l.ply_item_id || null, quantity: l.qty, price: Number(l.unit_cost) || 0, note: matCode(l.ply_code, l.cost_code) })) };
}
async function supplierFor(db, vendorId) {
  const v = get(db, 'SELECT * FROM vendors WHERE id = ?', vendorId);
  if (v.ply_vendor_id) return v.ply_vendor_id;
  const hits = (await request(db, 'GET', '/suppliers', null, { query: { search: v.name, page: 0, size: 20 } })).data || [];
  const s = hits.find(x => String(x.businessName).toLowerCase().trim() === String(v.name).toLowerCase().trim());
  if (s) run(db, 'UPDATE vendors SET ply_vendor_id = ? WHERE id = ?', s.id, v.id);
  return s ? s.id : null;
}
async function pushPO(db, poId, { createMissing = false } = {}) {
  const c = config(db);
  const po = get(db, 'SELECT * FROM purchase_orders WHERE id = ?', poId);
  const lines = poLines(db, poId).filter(l => !l.ply_line_id);
  const cache = new Map(); const ready = []; const missing = [];
  for (const l of lines) { const id = await materialFor(db, l, { createMissing, cache }); if (id) ready.push([l, id]); else missing.push(l.description); }
  if (missing.length && !createMissing) return { sent: 0, missing, needs_confirmation: true };
  const supplierId = await supplierFor(db, po.vendor_id);
  const locationId = po.deliver_to === 'job' && po.job_id ? await ensureJob(db, po.job_id) : (c.poLocation || undefined);
  const item = ([l, mid]) => ({ materialId: mid, quantity: l.qty, price: Math.max(0, Number(l.unit_cost) || 0), note: [l.sku ? null : l.description, matCode(l.ply_code, l.cost_code)].filter(Boolean).join(' · ') || undefined });
  let plyId = po.ply_id, r;
  if (!plyId) {
    r = await request(db, 'POST', '/purchase-orders', { orderNumber: po.number, supplierId: supplierId || undefined, locationId, note: po.notes || undefined, dueDate: po.expected_date || undefined, items: ready.map(item) });
    plyId = r.id;
  } else {
    r = await request(db, 'PUT', `/purchase-orders/${encodeURIComponent(plyId)}`, { orderNumber: po.number, supplierId: supplierId || undefined, locationId, note: po.notes || undefined, dueDate: po.expected_date || undefined });
    for (const x of ready) await request(db, 'POST', `/purchase-orders/${encodeURIComponent(plyId)}/items`, item(x));
  }
  // remember which Ply line is which of ours (receipts come back per Ply line)
  const plyItems = await listAll(db, `/purchase-orders/${encodeURIComponent(plyId)}/items`);
  const taken = new Set(all(db, 'SELECT ply_line_id FROM po_lines WHERE po_id = ? AND ply_line_id IS NOT NULL', poId).map(x => x.ply_line_id));
  for (const [l, mid] of ready) {
    const m = plyItems.find(x => !taken.has(x.id) && x.material && x.material.id === mid && Math.abs(Number(x.quantity) - l.qty) < 1e-9) || plyItems.find(x => !taken.has(x.id) && x.material && x.material.id === mid);
    if (m) { taken.add(m.id); run(db, 'UPDATE po_lines SET ply_line_id = ? WHERE id = ?', m.id, l.id); }
  }
  run(db, "UPDATE purchase_orders SET ply_id = ?, ply_status = ?, ply_synced_at = datetime('now') WHERE id = ?", String(plyId), (r && r.status) || 'DRAFT', poId);
  return { sent: ready.length, ply_id: plyId, status: (r && r.status) || 'DRAFT', supplier_linked: !!supplierId, missing };
}

// ------------------------------------------------------------ pull changes from Ply (no webhooks)
// receipts entered in Ply → receive the matching PO lines here (stock or job materials, as usual)
async function pullReceipts(db, H, po) {
  const rec = await listAll(db, `/purchase-orders/${encodeURIComponent(po.ply_id)}/reconcile-items`);
  const byLine = new Map(); for (const x of rec) byLine.set(x.purchaseOrderItemId, (byLine.get(x.purchaseOrderItemId) || 0) + (Number(x.quantity) || 0));
  const lines = [];
  for (const [plyLine, q] of byLine) {
    const l = get(db, 'SELECT * FROM po_lines WHERE po_id = ? AND ply_line_id = ?', po.id, plyLine);
    if (l && q - l.qty_received > 1e-9) lines.push({ po_line_id: l.id, qty: Math.round((q - l.qty_received) * 1000) / 1000 });
  }
  if (lines.length) H.receivePO(po.id, lines, null, 'ply');
  return lines.length;
}
// a Ply line → a PO line here (price-book item when the Ply material is linked to one)
function lineFromPly(db, poId, it, sort) {
  const pb = it.material && it.material.id ? get(db, 'SELECT id, name, cost_code_id FROM pricebook WHERE ply_item_id = ?', it.material.id) : null;
  const name = [it.material && it.material.name, it.variation && it.variation.name].filter(Boolean).join(' — ') || (pb && pb.name) || it.note || 'Ply item';
  run(db, 'INSERT INTO po_lines (po_id, pricebook_id, description, qty, unit_cost, cost_code_id, sort, ply_line_id) VALUES (?,?,?,?,?,?,?,?)',
    poId, pb ? pb.id : null, String(name).slice(0, 300), Number(it.quantity) || 0, Math.max(0, Number(it.price) || 0), pb ? pb.cost_code_id : null, sort, String(it.id));
}
async function addNewItems(db, po) {
  const have = new Set(all(db, 'SELECT ply_line_id FROM po_lines WHERE po_id = ? AND ply_line_id IS NOT NULL', po.id).map(x => x.ply_line_id));
  const items = await listAll(db, `/purchase-orders/${encodeURIComponent(po.ply_id)}/items`);
  let n = all(db, 'SELECT COUNT(*) n FROM po_lines WHERE po_id = ?', po.id)[0].n;
  for (const it of items) if (!have.has(String(it.id))) lineFromPly(db, po.id, it, n++);
}
const PLY_PO_STATUS = { DRAFT: 'draft', WAITING_FOR_APPROVAL: 'draft', SENT: 'submitted', CONFIRMED: 'submitted', PAID: 'submitted', PARTIALLY_RECEIVED: 'submitted', RECEIVED: 'submitted', ARCHIVED: 'submitted',
  CANCELED: 'cancelled', DECLINED: 'cancelled', EXPIRED: 'cancelled' };

// POs created in Ply for a job (delivered to the job's Ply location) → a PO on the job here, logged in the job's notes.
// One listing call covers every job; open jobs not yet linked to Ply are linked when Ply has a job with the same number.
async function importJobPOs(db, H, { days = 180 } = {}) {
  const out = { imported: 0, linked_jobs: 0, received_lines: 0, skipped: 0, errors: [] };
  // link open jobs to Ply jobs made by hand in Ply (same job number)
  const unlinked = all(db, "SELECT id, number FROM jobs WHERE ply_id IS NULL AND status NOT IN ('cancelled')");
  if (unlinked.length) {
    const plyJobs = await listAll(db, '/jobs');
    const byNum = new Map(plyJobs.filter(x => x.number).map(x => [String(x.number).trim().toLowerCase(), x]));
    for (const j of unlinked) {
      const m = byNum.get(String(j.number).trim().toLowerCase());
      if (m && !get(db, 'SELECT 1 x FROM jobs WHERE ply_id = ?', String(m.id))) { run(db, 'UPDATE jobs SET ply_id = ? WHERE id = ?', String(m.id), j.id); out.linked_jobs++; }
    }
  }
  const jobs = new Map(all(db, "SELECT id, number, ply_id FROM jobs WHERE ply_id IS NOT NULL").map(j => [String(j.ply_id), j]));
  if (!jobs.size) return out;
  const since = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
  const pos = await listAll(db, '/purchase-orders', { createdAfter: since });
  for (const p of pos) {
    const job = p.location && jobs.get(String(p.location.id));
    if (!job) continue;                                                       // to a warehouse, truck or someone else's job
    if (get(db, 'SELECT 1 x FROM purchase_orders WHERE ply_id = ?', String(p.id))) continue;   // ours, or already imported
    try {
      // supplier → vendor (by Ply link, then exact name; added if new)
      let vendor = p.supplier && p.supplier.id ? get(db, 'SELECT id FROM vendors WHERE ply_vendor_id = ?', String(p.supplier.id)) : null;
      const sname = (p.supplier && p.supplier.name) || 'Ply supplier (not named)';
      if (!vendor) vendor = get(db, 'SELECT id FROM vendors WHERE lower(trim(name)) = lower(trim(?))', sname);
      if (vendor && p.supplier && p.supplier.id) run(db, 'UPDATE vendors SET ply_vendor_id = COALESCE(ply_vendor_id, ?) WHERE id = ?', String(p.supplier.id), vendor.id);
      const vendorId = vendor ? vendor.id : Number(run(db, 'INSERT INTO vendors (name, ply_vendor_id, notes) VALUES (?,?,?)', sname, p.supplier ? String(p.supplier.id) : null, 'Added from a Ply purchase order').lastInsertRowid);
      const items = await listAll(db, `/purchase-orders/${encodeURIComponent(p.id)}/items`);
      const sub = items.reduce((s, it) => s + (Number(it.quantity) || 0) * (Number(it.price) || 0), 0);
      const extra = Math.max(0, Math.round(((Number(p.totalCost) || 0) - sub) * 100) / 100);   // tax / shipping, which the API doesn't break out
      const poId = tx(db, () => {
        const id = Number(run(db, `INSERT INTO purchase_orders (number, vendor_id, job_id, status, deliver_to, order_date, expected_date, shipping, notes, ply_id, ply_status, ply_synced_at, source, ply_number)
          VALUES (?,?,?,?, 'job', ?, ?, ?, ?, ?, ?, datetime('now'), 'ply', ?)`, D.nextNumber(db, 'purchase_orders', 'PO'), vendorId, job.id, PLY_PO_STATUS[p.status] || 'submitted',
          String(p.createdAt || '').slice(0, 10) || null, p.dueDate || null, extra, [p.orderNumber ? `Ply ${p.orderNumber}` : 'From Ply', p.note].filter(Boolean).join(' — '),
          String(p.id), p.status || null, p.orderNumber || null).lastInsertRowid);
        items.forEach((it, i) => lineFromPly(db, id, it, i));
        const num = get(db, 'SELECT number FROM purchase_orders WHERE id = ?', id).number;
        run(db, 'INSERT INTO job_notes (job_id, user_id, body) VALUES (?,?,?)', job.id, null,
          `${num} logged from Ply${p.orderNumber ? ` (${p.orderNumber})` : ''}: ${sname}, ${items.length} line(s), $${(Number(p.totalCost) || sub).toFixed(2)} — ${String(p.status || '').toLowerCase().replace(/_/g, ' ')}`);
        return id;
      });
      out.imported++;
      if (['PARTIALLY_RECEIVED', 'RECEIVED'].includes(p.status)) out.received_lines += await pullReceipts(db, H, get(db, 'SELECT * FROM purchase_orders WHERE id = ?', poId));
    } catch (e) { out.errors.push(`${p.orderNumber || p.id}: ${e.message}`); }
  }
  log(db, 'in', 'import_job_pos', out.errors.length ? 'partial' : 'ok', out);
  return out;
}

async function syncStatus(db, H) {
  const out = { pos: 0, received_lines: 0, picks_completed: 0, errors: [] };
  try { const im = await importJobPOs(db, H); out.imported_pos = im.imported; out.linked_jobs = im.linked_jobs; out.received_lines += im.received_lines; out.errors.push(...im.errors); }
  catch (e) { out.errors.push(`Importing job POs: ${e.message}`); }
  for (const po of all(db, "SELECT * FROM purchase_orders WHERE ply_id IS NOT NULL AND status NOT IN ('received','cancelled')")) {
    try {
      const r = await request(db, 'GET', `/purchase-orders/${encodeURIComponent(po.ply_id)}`, null, { quiet: true });
      run(db, "UPDATE purchase_orders SET ply_status = ?, ply_synced_at = datetime('now') WHERE id = ?", r.status || null, po.id);
      if (['CANCELED', 'DECLINED', 'EXPIRED'].includes(r.status) && po.status === 'draft') run(db, "UPDATE purchase_orders SET status = 'cancelled' WHERE id = ?", po.id);
      if (['SENT', 'CONFIRMED', 'PAID'].includes(r.status) && po.status === 'draft') run(db, "UPDATE purchase_orders SET status = 'submitted' WHERE id = ?", po.id);
      if (po.source === 'ply' && !['RECEIVED', 'ARCHIVED'].includes(r.status)) await addNewItems(db, po);   // lines added in Ply after we imported it
      if (['PARTIALLY_RECEIVED', 'RECEIVED'].includes(r.status)) out.received_lines += await pullReceipts(db, H, po);
      out.pos++;
    } catch (e) { out.errors.push(`${po.number}: ${e.message}`); }
  }
  for (const pl of all(db, "SELECT * FROM pick_lists WHERE ply_id IS NOT NULL AND status IN ('open','picking')")) {
    try {
      const r = await request(db, 'GET', `/pick-lists/${encodeURIComponent(pl.ply_id)}`, null, { quiet: true });
      if (r.status === 'COMPLETED') {
        run(db, 'UPDATE pick_list_lines SET qty_picked = qty WHERE pick_list_id = ? AND ply_line_id IS NOT NULL AND (qty_picked IS NULL OR qty_picked = 0)', pl.id);
        H.completePickList(pl.id, null); out.picks_completed++;
      }
    } catch (e) { out.errors.push(`${pl.number}: ${e.message}`); }
  }
  run(db, "INSERT INTO settings (key, value) VALUES ('ply_last_sync', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", JSON.stringify({ at: new Date().toISOString(), ...out }));
  return out;
}

module.exports = { config, request, listAll, test, pullItems, pushJob, pushPO, pushPickList, syncStatus, importJobPOs, log, toPlyPO, toPlyPickList, toPlyJob, BASES };
