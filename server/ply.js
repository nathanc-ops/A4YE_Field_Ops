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
      const rl = res.headers.get('x-ratelimit-remaining'), left = rl == null || rl === '' ? NaN : Number(rl);   // no header: don't guess, carry on
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
  const num = j.timeclock_job || j.number;   // the job # the field and Ply go by (A4Y time clock job #), else ours
  return { name: `${num} ${j.title}`.slice(0, 500), number: num, client: { name: (j.company || j.customer || '').slice(0, 255), phoneNumber: j.phone ? String(j.phone).slice(0, 50) : undefined },
    scheduledAt: j.scheduled_start || undefined, note: [j.description, j.timeclock_job ? `Time clock job # ${j.timeclock_job}` : ''].filter(Boolean).join('\n').slice(0, 5000) || undefined, address: addr };
}
async function pushJob(db, jobId) {
  const j = get(db, 'SELECT id, ply_id FROM jobs WHERE id = ?', jobId);
  const body = toPlyJob(db, jobId);
  let r;
  if (j.ply_id) r = await request(db, 'PUT', `/jobs/${encodeURIComponent(j.ply_id)}`, body);
  else {
    // already in Ply under this job number (e.g. created by hand)? link instead of duplicating
    const existing = (await allPlyJobs(db)).find(x => x.number && norm(x.number) === norm(body.number));
    r = existing || await request(db, 'POST', '/jobs', body);
    if (!existing) plyJobsCache = { at: 0, list: null };
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
  run(db, "UPDATE pick_lists SET ply_id = ?, ply_status = COALESCE(ply_status, 'NEED_REFILL'), ply_synced_at = datetime('now') WHERE id = ?", String(plyId), plId);
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

// Which Ply job is this one: same job number, else a Ply job name that carries our job number ("J-1068 Panel upgrade"),
// else a Ply job name that is our title. Only an unambiguous match counts.
const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
function matchPlyJob(j, plyJobs) {
  const nums = [...new Set([norm(j.timeclock_job), norm(j.number)].filter(Boolean))], title = norm(j.title);
  const one = list => (list.length === 1 ? list[0] : null);
  for (const num of nums) {
    const m = one(plyJobs.filter(x => x.number && norm(x.number) === num)) || one(plyJobs.filter(x => (` ${norm(x.name)} `).includes(` ${num} `)));
    if (m) return m;
  }
  return title.length >= 6 ? one(plyJobs.filter(x => norm(x.name) === title || norm(x.name).endsWith(` ${title}`))) : null;
}
// every Ply job, open and archived (a job finished in Ply can still have POs). Read fresh for matching; type-ahead
// search reuses one read for 30 seconds so typing doesn't spend the 60-a-minute limit (cleared when we create a Ply job)
let plyJobsCache = { at: 0, list: null };
async function allPlyJobs(db, { cached = false } = {}) {
  if (cached && plyJobsCache.list && Date.now() - plyJobsCache.at < 30e3) return plyJobsCache.list;
  const list = [...await listAll(db, '/jobs'), ...await listAll(db, '/jobs', { active: false })];
  if (cached) plyJobsCache = { at: Date.now(), list };   // only type-ahead search reads it back
  return list;
}
// find Ply jobs by a number or words: Ply's own search only reads names, so numbers are matched here too
async function searchPlyJobs(db, q, { archived = false, list = null, cached = false } = {}) {
  const t = norm(q); if (t.length < 2) return [];
  if (cached && !list) {   // nothing in the saved read? Ply may have a job added since: read it again before saying none
    const hits = await searchPlyJobs(db, q, { archived, list: await allPlyJobs(db, { cached: true }) });
    if (hits.length) return hits;
    return searchPlyJobs(db, q, { archived, list: await allPlyJobs(db) });
  }
  list = (list || await allPlyJobs(db, { cached })).filter(x => archived || x.active !== false);
  const hit = x => norm(x.number) === t || norm(x.number).includes(t) || norm(x.name).includes(t);
  return list.filter(hit).sort((a, b) => (norm(b.number) === t) - (norm(a.number) === t) || (a.active === false) - (b.active === false) || String(a.name).localeCompare(String(b.name)));
}

// Which job a Ply PO belongs to. Ply's API ties a PO to a job only by where it's delivered, so, in order:
//   1. delivered to the job's linked Ply job;
//   2. delivered to another Ply job record carrying the same job number (a second record for the same project);
//   3. its order number or note names the job number (POs delivered to the shop or a truck "for" the job).
// Only an unambiguous match counts; numbers shorter than 4 characters aren't used for 3.
const LOOKBACK_DAYS = 730;
function poMatcher(db, plyJobs) {
  const jobs = all(db, "SELECT id, number, title, ply_id, timeclock_job FROM jobs WHERE status != 'cancelled'");
  const byLoc = new Map(), how = new Map();
  for (const j of jobs) if (j.ply_id) { byLoc.set(String(j.ply_id), j); how.set(String(j.ply_id), 'delivered to its Ply job'); }
  const numsOf = j => [...new Set([norm(j.timeclock_job), norm(j.number)].filter(Boolean))];
  if (plyJobs) for (const x of plyJobs) {
    if (byLoc.has(String(x.id))) continue;
    const owners = jobs.filter(j => numsOf(j).some(n => norm(x.number) === n || (` ${norm(x.name)} `).includes(` ${n} `)));
    if (owners.length === 1) { byLoc.set(String(x.id), owners[0]); how.set(String(x.id), `delivered to the Ply job "${x.name}", which carries its number`); }
  }
  const tokens = jobs.map(j => ({ j, nums: numsOf(j).filter(n => n.replace(/\D/g, '').length >= 4) })).filter(t => t.nums.length);
  return p => {
    const loc = p.location && String(p.location.id);
    if (loc && byLoc.has(loc)) return { job: byLoc.get(loc), why: how.get(loc) };
    const text = ` ${norm(p.orderNumber)} ${norm(p.note)} `;
    const hits = tokens.filter(t => t.nums.some(n => text.includes(` ${n} `)));
    if (hits.length === 1) return { job: hits[0].j, why: `its ${(` ${norm(p.orderNumber)} `).includes(` ${hits[0].nums.find(n => text.includes(` ${n} `))} `) ? 'order number' : 'note'} names the job number${p.location && p.location.name ? ` (delivered to ${p.location.name})` : ''}` };
    return null;
  };
}

// Everything Ply has for one job, read live for the job's Purchasing tab: its Ply job, POs delivered there (and whether
// each is here yet), and pick lists going there with their status. Each part says why if it can't be read.
async function jobPly(db, jobId) {
  const j = get(db, 'SELECT id, number, title, ply_id, timeclock_job FROM jobs WHERE id = ?', jobId);
  const out = { linked: !!j.ply_id, ply_job: null, suggestions: [], pos: [], pick_lists: [], errors: [], numbers: [j.timeclock_job, j.number].filter(Boolean) };
  const note = (what, scope, e) => out.errors.push(`${what}: ${e.message}${/permission|scope/i.test(e.message) ? ` — add ${scope} to the Ply API key` : ''}`);
  if (!j.ply_id) {
    try {
      // by the time clock job # and the job number (in Ply's number or name), then each main word of the title
      const words = [...new Set(norm(j.title).split(' ').filter(w => w.length > 3 && !/^(the|and|with|from|install|replace|repair|service)$/.test(w)))].slice(0, 3);
      const found = [], every = await allPlyJobs(db);
      for (const q of [j.timeclock_job, j.number, ...words].filter(Boolean)) found.push(...await searchPlyJobs(db, q, { archived: true, list: every }));
      const taken = new Set(all(db, 'SELECT ply_id FROM jobs WHERE ply_id IS NOT NULL').map(x => x.ply_id));
      const seen = new Set(); out.suggestions = found.filter(x => !seen.has(x.id) && seen.add(x.id) && !taken.has(String(x.id))).slice(0, 12).map(x => ({ id: x.id, name: x.name, number: x.number || null, active: x.active !== false }));
    } catch (e) { note('Looking up Ply jobs', 'jobs:read', e); }
    return out;
  }
  try { const r = await request(db, 'GET', `/jobs/${encodeURIComponent(j.ply_id)}`, null, { quiet: true }); out.ply_job = { id: r.id, name: r.name, number: r.number || null, active: r.active !== false }; }
  catch (e) { note('Reading the Ply job', 'jobs:read', e); }
  try {
    // delivered to the linked Ply job, plus anything the import would match to this job (other Ply job records with its
    // number, an order number or note naming it), plus POs that name the number but match more than one job
    let plyJobs = null; try { plyJobs = await allPlyJobs(db); } catch { /* reported above if it matters */ }
    const match = poMatcher(db, plyJobs);
    const since = new Date(Date.now() - LOOKBACK_DAYS * 864e5).toISOString().slice(0, 10);
    const every = await listAll(db, '/purchase-orders', { createdAfter: new Date(Date.now() - 3 * 365 * 864e5).toISOString().slice(0, 10) });
    const nums = [norm(j.timeclock_job), norm(j.number)].filter(n => n && n.replace(/\D/g, '').length >= 4);
    const pos = every.filter(p => { const m = match(p); if (m && m.job.id === j.id) return true;
      return (p.location && String(p.location.id) === String(j.ply_id)) || nums.some(n => (` ${norm(p.orderNumber)} ${norm(p.note)} `).includes(` ${n} `)); });
    out.pos = pos.map(p => {
      const m = match(p), mine = m && m.job.id === j.id, old = String(p.createdAt || '').slice(0, 10) < since;
      const why = mine ? m.why : m ? `matched to ${m.job.number} instead` : `delivered to ${(p.location && p.location.name) || 'a location that is not this job'}, and the job number in it matches more than one job`; const here = get(db, 'SELECT id, number, status FROM purchase_orders WHERE ply_id = ?', String(p.id)), ign = get(db, 'SELECT reason FROM ply_ignored WHERE ply_id = ?', String(p.id));
      return { id: p.id, order_number: p.orderNumber || null, status: p.status, supplier: p.supplier && p.supplier.name, total: p.totalCost ?? p.subtotal ?? null, created_at: p.createdAt, due_date: p.dueDate || null,
        received_at: p.receivedAt || null, here: here ? { id: here.id, number: here.number, status: here.status } : null, removed: ign ? ign.reason || 'removed as a duplicate' : null,
        location: p.location && p.location.name || null, why, importable: mine && !old, old }; });
  } catch (e) { note('Reading POs', 'purchase_orders:read', e); }
  try {
    // the API can't filter pick lists by destination: read the newest few hundred and keep the ones going to this job
    const picks = [];
    for (let page = 0; page < 3; page++) {
      const r = await request(db, 'GET', '/pick-lists', null, { query: { page, size: 100, sort: 'createdAt,desc' }, quiet: true });
      picks.push(...(r.data || [])); if (!r.pagination || page + 1 >= r.pagination.totalPages) break;
    }
    out.pick_lists = picks.filter(p => p.toLocation && String(p.toLocation.id) === String(j.ply_id)).map(p => {
      const here = get(db, 'SELECT id, number FROM pick_lists WHERE ply_id = ?', String(p.id));
      return { id: p.id, name: p.name, status: p.status, from: p.fromLocation && p.fromLocation.name, items: (p.materialCount || 0) + (p.kitCount || 0),
        request_date: p.requestDate || null, completed_at: p.completedAt || null, created_at: p.createdAt, here: here ? { id: here.id, number: here.number } : null };
    });
  } catch (e) { note('Reading pick lists', 'pick_lists:read', e); }
  return out;
}

// POs created in Ply for a job (delivered to the job's Ply location) → a PO on the job here, logged in the job's notes.
// One listing call covers every job; open jobs not yet linked to Ply are linked when Ply has a job with the same number.
// one Ply PO onto one job here: vendor (by Ply link, then name; added if new), lines, a note on the job, receipts
async function importOnePO(db, H, p, job, why) {
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
      `${num} logged from Ply${p.orderNumber ? ` (${p.orderNumber})` : ''}: ${sname}, ${items.length} line(s), $${(Number(p.totalCost) || sub).toFixed(2)} — ${String(p.status || '').toLowerCase().replace(/_/g, ' ')}${why ? ` (${why})` : ''}`);
    return id;
  });
  const received_lines = ['PARTIALLY_RECEIVED', 'RECEIVED'].includes(p.status) ? await pullReceipts(db, H, get(db, 'SELECT * FROM purchase_orders WHERE id = ?', poId)) : 0;
  return { po_id: poId, received_lines };
}

// a Ply PO by its order number (a person looking for one that didn't land on a job): where it went and why
async function findPlyPO(db, q) {
  const t = norm(String(q).replace(/^#/, '')); if (t.length < 3) return [];
  let plyJobs = null; try { plyJobs = await allPlyJobs(db); } catch { /* the match just can't use other Ply job records */ }
  const match = poMatcher(db, plyJobs), since = new Date(Date.now() - LOOKBACK_DAYS * 864e5).toISOString().slice(0, 10);
  const found = [];
  for (let page = 0; page < 60 && found.length < 10; page++) {   // newest first; up to 6,000 POs
    const r = await request(db, 'GET', '/purchase-orders', null, { query: { page, size: 100, sort: 'createdAt,desc' }, quiet: true });
    for (const p of r.data || []) if (norm(p.orderNumber).includes(t) || norm(p.note).includes(t)) found.push(p);
    if (!r.pagination || page + 1 >= r.pagination.totalPages) break;
  }
  return found.map(p => {
    const here = get(db, 'SELECT p.id, p.number, p.job_id, j.number job_number FROM purchase_orders p LEFT JOIN jobs j ON j.id = p.job_id WHERE p.ply_id = ?', String(p.id));
    const ign = get(db, 'SELECT reason FROM ply_ignored WHERE ply_id = ?', String(p.id)), m = match(p), old = String(p.createdAt || '').slice(0, 10) < since;
    const plyJob = plyJobs && p.location ? plyJobs.find(x => String(x.id) === String(p.location.id)) : null;
    const reason = here ? `It's here as ${here.number}${here.job_number ? ` on ${here.job_number}` : ' (not on a job)'}.`
      : ign ? `It was removed here as a duplicate (${ign.reason || 'no reason given'}), so the sync leaves it alone.`
      : m && old ? `It matches ${m.job.number} (${m.why}) but is older than 2 years, so the sync doesn't bring it in.`
      : m ? `It matches ${m.job.number} (${m.why}). It should come in at the next sync, or press Put on this job.`
      : plyJob ? `It's delivered to the Ply job "${plyJob.name}", which isn't linked to any job here and doesn't carry a job number that matches one.`
      : `It's delivered to ${(p.location && p.location.name) || 'no location'}, which isn't a job, and neither its order number nor its note names a job number.`;
    return { id: p.id, order_number: p.orderNumber || null, status: p.status, supplier: p.supplier && p.supplier.name, total: p.totalCost ?? p.subtotal ?? null,
      created_at: p.createdAt || null, location: p.location && p.location.name || null, location_is_job: !!plyJob, here: here || null, removed: !!ign, match: m ? { job_id: m.job.id, job_number: m.job.number, why: m.why } : null, reason };
  });
}
// put a Ply PO on a job by hand (a person knows it's this job's). Already here on another job with nothing received: moved.
async function attachPlyPO(db, H, jobId, plyPoId, user) {
  const job = get(db, 'SELECT id, number FROM jobs WHERE id = ?', jobId);
  const here = get(db, 'SELECT * FROM purchase_orders WHERE ply_id = ?', String(plyPoId));
  if (here) {
    if (here.job_id === job.id) return { already: true, po_id: here.id, number: here.number };
    const got = get(db, 'SELECT COUNT(*) n FROM po_receipts r JOIN po_lines l ON l.id = r.po_line_id WHERE l.po_id = ?', here.id).n;
    if (got) throw err(`It's already here as ${here.number}${here.job_id ? ' on another job' : ''} with material received. Remove that copy (Remove duplicate) first, then put it on this job.`, 400);
    run(db, "UPDATE purchase_orders SET job_id = ?, deliver_to = 'job' WHERE id = ?", job.id, here.id);
    run(db, 'INSERT INTO job_notes (job_id, user_id, body) VALUES (?,?,?)', job.id, user ? user.id : null, `${here.number}${here.ply_number ? ` (Ply ${here.ply_number})` : ''} moved onto this job`);
    return { moved: true, po_id: here.id, number: here.number };
  }
  run(db, 'DELETE FROM ply_ignored WHERE ply_id = ?', String(plyPoId));
  const p = await request(db, 'GET', `/purchase-orders/${encodeURIComponent(plyPoId)}`, null, { quiet: true });
  const r = await importOnePO(db, H, p, job, `put on this job by ${user ? user.name : 'hand'}`);
  return { imported: true, po_id: r.po_id, number: get(db, 'SELECT number FROM purchase_orders WHERE id = ?', r.po_id).number, received_lines: r.received_lines };
}

async function importJobPOs(db, H, { days = LOOKBACK_DAYS } = {}) {
  const out = { imported: 0, linked_jobs: 0, received_lines: 0, skipped: 0, errors: [] };
  // link open jobs to Ply jobs made by hand in Ply (same job number)
  const unlinked = all(db, "SELECT id, number, title, timeclock_job FROM jobs WHERE ply_id IS NULL AND status NOT IN ('cancelled')");
  let plyJobs = null;
  try { plyJobs = await allPlyJobs(db); } catch (e) { out.errors.push(`Reading Ply jobs: ${e.message}${/permission|scope/i.test(e.message) ? ' (the key needs jobs:read)' : ''}`); }
  if (unlinked.length && plyJobs) {
    try {
      for (const j of unlinked) {
        const m = matchPlyJob(j, plyJobs);
        if (m && !get(db, 'SELECT 1 x FROM jobs WHERE ply_id = ?', String(m.id))) { run(db, 'UPDATE jobs SET ply_id = ? WHERE id = ?', String(m.id), j.id); out.linked_jobs++; }
      }
    } catch (e) { out.errors.push(`Linking jobs to Ply: ${e.message}${/permission|scope/i.test(e.message) ? ' (the key needs jobs:read)' : ''}`); }   // jobs already linked still get their POs
  }
  const match = poMatcher(db, plyJobs);
  const since = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
  const pos = await listAll(db, '/purchase-orders', { createdAfter: since });
  for (const p of pos) {
    const m = match(p), job = m && m.job;
    if (!job) continue;                                                       // to a warehouse or truck with no job named, or someone else's job
    if (get(db, 'SELECT 1 x FROM purchase_orders WHERE ply_id = ?', String(p.id))) continue;   // ours, or already imported
    if (get(db, 'SELECT 1 x FROM ply_ignored WHERE ply_id = ?', String(p.id))) continue;          // removed here as a duplicate
    try {
      const r = await importOnePO(db, H, p, job, m.why && !/^delivered to its Ply job$/.test(m.why) ? `matched: ${m.why}` : null);
      out.imported++; out.received_lines += r.received_lines;
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
      run(db, 'UPDATE pick_lists SET ply_status = ?, ply_completed_at = ?, ply_synced_at = datetime(\'now\') WHERE id = ?', r.status || null, r.completedAt || null, pl.id);
      if (r.status === 'COMPLETED') {
        run(db, 'UPDATE pick_list_lines SET qty_picked = qty WHERE pick_list_id = ? AND ply_line_id IS NOT NULL AND (qty_picked IS NULL OR qty_picked = 0)', pl.id);
        H.completePickList(pl.id, null); out.picks_completed++;
      }
    } catch (e) { out.errors.push(`${pl.number}: ${e.message}`); }
  }
  run(db, "INSERT INTO settings (key, value) VALUES ('ply_last_sync', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", JSON.stringify({ at: new Date().toISOString(), ...out }));
  return out;
}

module.exports = { config, request, listAll, test, pullItems, pushJob, pushPO, pushPickList, syncStatus, importJobPOs, jobPly, matchPlyJob, searchPlyJobs, findPlyPO, attachPlyPO, log, toPlyPO, toPlyPickList, toPlyJob, BASES };
