'use strict';
// Ply (getply.com) connector.
//
// IMPORTANT: Ply does not publish its API reference. This connector is built against a
// configurable REST shape (base URL, API key, endpoint paths in Settings → Integrations)
// and a documented webhook contract (docs/PLY_INTEGRATION.md). Before going live, get
// Ply's API docs from your Ply rep and adjust the paths/field mapping in toPly*() below.
const crypto = require('node:crypto');
const { all, get, run, settings } = require('./db');

function config(db) {
  const s = settings(db);
  return {
    enabled: s.ply_enabled === '1' && !!s.ply_api_base && !!s.ply_api_key,
    base: (s.ply_api_base || '').replace(/\/+$/, ''), key: s.ply_api_key, secret: s.ply_webhook_secret,
    paths: { po: s.ply_path_po, pick_list: s.ply_path_pick_list, job: s.ply_path_job, items: s.ply_path_items },
  };
}
function log(db, direction, event, status, detail) {
  run(db, 'INSERT INTO integration_log (provider, direction, event, status, detail) VALUES (?,?,?,?,?)',
    'ply', direction, event, status, typeof detail === 'string' ? detail.slice(0, 4000) : JSON.stringify(detail).slice(0, 4000));
}

async function request(db, method, path, body) {
  const c = config(db);
  if (!c.enabled) throw Object.assign(new Error('Ply integration is not enabled — set it up in Settings → Integrations'), { status: 400 });
  const res = await fetch(c.base + path, {
    method, headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${c.key}` },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  log(db, 'out', `${method} ${path}`, res.ok ? 'ok' : `http_${res.status}`, { request: body, response: data });
  if (!res.ok) throw Object.assign(new Error(`Ply returned ${res.status}: ${data.error || data.message || text.slice(0, 200)}`), { status: 502 });
  return data;
}

// ------------------------------------------------------------ outbound payloads
function jobRef(db, jobId) {
  if (!jobId) return null;
  const j = get(db, `SELECT j.id, j.number, j.title, j.ply_id, c.name customer, l.address, l.city, l.state, l.zip
    FROM jobs j JOIN customers c ON c.id = j.customer_id LEFT JOIN locations l ON l.id = j.location_id WHERE j.id = ?`, jobId);
  return j && { external_id: j.number, ply_id: j.ply_id || undefined, name: `${j.number} ${j.title}`, customer: j.customer,
    address: [j.address, j.city, j.state, j.zip].filter(Boolean).join(', ') };
}
function toPlyJob(db, jobId) {
  const j = jobRef(db, jobId);
  const codes = all(db, `SELECT cc.code, cc.name, cc.ply_code, jb.budget_hours, jb.budget_material FROM job_budgets jb JOIN cost_codes cc ON cc.id = jb.cost_code_id WHERE jb.job_id = ?`, jobId);
  return { ...j, cost_codes: codes.map(c => ({ code: c.ply_code || c.code, name: c.name, budget_material: c.budget_material })) };
}
function toPlyPO(db, poId) {
  const po = get(db, 'SELECT p.*, v.name vendor_name, v.ply_vendor_id, v.email vendor_email FROM purchase_orders p JOIN vendors v ON v.id = p.vendor_id WHERE p.id = ?', poId);
  const lines = all(db, `SELECT pl.*, pb.code sku, pb.ply_item_id, cc.code cost_code, cc.ply_code FROM po_lines pl
    LEFT JOIN pricebook pb ON pb.id = pl.pricebook_id LEFT JOIN cost_codes cc ON cc.id = pl.cost_code_id WHERE po_id = ? ORDER BY sort, id`, poId);
  return {
    external_id: po.number, vendor: { ply_id: po.ply_vendor_id || undefined, name: po.vendor_name, email: po.vendor_email },
    job: jobRef(db, po.job_id), deliver_to: po.deliver_to, order_date: po.order_date, needed_by: po.expected_date, notes: po.notes,
    lines: lines.map(l => ({ external_line_id: String(l.id), sku: l.sku, ply_item_id: l.ply_item_id || undefined, description: l.description,
      quantity: l.qty, unit_cost: l.unit_cost, cost_code: matCode(l.ply_code, l.cost_code) })),
  };
}
// A4YE cost codes are 4-digit bases; for material the job tracker uses Full Code base-M (e.g. 0810-M).
const matCode = (ply, code) => ply || (code && /^\d{4}$/.test(code) ? `${code}-M` : code) || undefined;
function toPlyPickList(db, plId) {
  const p = get(db, 'SELECT * FROM pick_lists WHERE id = ?', plId);
  const lines = all(db, `SELECT pl.*, COALESCE(pl.unit, pb.unit) unit, pb.code sku, pb.ply_item_id, cc.code cost_code, cc.ply_code FROM pick_list_lines pl
    LEFT JOIN pricebook pb ON pb.id = pl.pricebook_id LEFT JOIN cost_codes cc ON cc.id = pl.cost_code_id WHERE pick_list_id = ?`, plId);
  return { external_id: p.number, job: jobRef(db, p.job_id), needed_by: p.needed_by, notes: p.notes,
    lines: lines.map(l => ({ external_line_id: String(l.id), sku: l.sku, ply_item_id: l.ply_item_id || undefined, description: l.description, quantity: l.qty, unit: l.unit || undefined, note: l.note || undefined, cost_code: matCode(l.ply_code, l.cost_code) })) };
}

async function pushJob(db, jobId) {
  const c = config(db);
  const r = await request(db, 'POST', c.paths.job, toPlyJob(db, jobId));
  if (r && r.id) run(db, 'UPDATE jobs SET ply_id = ? WHERE id = ?', String(r.id), jobId);
  return r;
}
async function pushPO(db, poId) {
  const c = config(db);
  const po = get(db, 'SELECT job_id, ply_id FROM purchase_orders WHERE id = ?', poId);
  if (po.job_id) { const j = get(db, 'SELECT ply_id FROM jobs WHERE id = ?', po.job_id); if (!j.ply_id) await pushJob(db, po.job_id).catch(() => {}); }
  const r = po.ply_id ? await request(db, 'PUT', `${c.paths.po}/${encodeURIComponent(po.ply_id)}`, toPlyPO(db, poId)) : await request(db, 'POST', c.paths.po, toPlyPO(db, poId));
  run(db, "UPDATE purchase_orders SET ply_id = COALESCE(?, ply_id), ply_status = ?, ply_synced_at = datetime('now') WHERE id = ?", r && r.id ? String(r.id) : null, (r && r.status) || 'sent', poId);
  return r;
}
async function pushPickList(db, plId) {
  const c = config(db);
  const r = await request(db, 'POST', c.paths.pick_list, toPlyPickList(db, plId));
  run(db, "UPDATE pick_lists SET ply_id = COALESCE(?, ply_id), ply_synced_at = datetime('now') WHERE id = ?", r && r.id ? String(r.id) : null, plId);
  return r;
}
// Pull Ply's item catalog / stock into the price book (matches on ply_item_id, then SKU/code).
async function pullItems(db) {
  const c = config(db);
  const r = await request(db, 'GET', c.paths.items);
  const items = Array.isArray(r) ? r : (r.items || r.data || []);
  let updated = 0, created = 0;
  for (const it of items) {
    const id = it.id != null ? String(it.id) : null;
    const row = (id && get(db, 'SELECT * FROM pricebook WHERE ply_item_id = ?', id)) || (it.sku && get(db, 'SELECT * FROM pricebook WHERE code = ?', it.sku));
    const qty = it.quantity_on_hand ?? it.qty_on_hand;
    const cost = it.unit_cost ?? it.cost;
    if (row) {
      run(db, 'UPDATE pricebook SET ply_item_id = COALESCE(?, ply_item_id), qty_on_hand = COALESCE(?, qty_on_hand), unit_cost = COALESCE(?, unit_cost) WHERE id = ?', id, qty ?? null, cost ?? null, row.id);
      updated++;
    } else if (it.name || it.description) {
      run(db, "INSERT INTO pricebook (code, name, kind, unit, unit_cost, unit_price, qty_on_hand, ply_item_id, category) VALUES (?,?,?,?,?,?,?,?, 'Ply import')",
        it.sku || null, it.name || it.description, 'material', it.unit || 'ea', cost || 0, it.unit_price || (cost ? Math.round(cost * 1.5 * 100) / 100 : 0), qty || 0, id);
      created++;
    }
  }
  return { updated, created };
}

// ------------------------------------------------------------ inbound webhooks
function verify(db, req) {
  const { secret } = config(db);
  if (!secret) return false;
  const sig = req.get('x-ply-signature') || '';
  if (sig) {
    const expected = crypto.createHmac('sha256', secret).update(req.rawBody || '').digest('hex');
    const a = Buffer.from(sig.replace(/^sha256=/, '')), b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
  const tok = req.get('x-ply-token') || '';
  return tok.length === secret.length && crypto.timingSafeEqual(Buffer.from(tok), Buffer.from(secret));
}

// handlers receive the parsed event and the purchasing helpers (to reuse receive/bill logic)
function findPO(db, d) {
  return (d.external_id && get(db, 'SELECT * FROM purchase_orders WHERE number = ?', d.external_id))
    || (d.id != null && get(db, 'SELECT * FROM purchase_orders WHERE ply_id = ?', String(d.id)))
    || (d.purchase_order_id != null && get(db, 'SELECT * FROM purchase_orders WHERE ply_id = ?', String(d.purchase_order_id)));
}
function handleEvent(db, P, evt) {
  const type = evt.type || evt.event;
  const d = evt.data || evt;
  switch (type) {
    case 'purchase_order.updated': {
      const po = findPO(db, d); if (!po) throw new Error('PO not found');
      run(db, "UPDATE purchase_orders SET ply_status = ?, ply_id = COALESCE(ply_id, ?), ply_synced_at = datetime('now') WHERE id = ?", d.status || null, d.id != null ? String(d.id) : null, po.id);
      if (d.status === 'cancelled' && po.status === 'draft') run(db, "UPDATE purchase_orders SET status = 'cancelled' WHERE id = ?", po.id);
      if (['submitted', 'ordered', 'approved'].includes(d.status) && po.status === 'draft') run(db, "UPDATE purchase_orders SET status = 'submitted' WHERE id = ?", po.id);
      return { po: po.number };
    }
    case 'purchase_order.received': {
      const po = findPO(db, d); if (!po) throw new Error('PO not found');
      const lines = (d.lines || []).map(l => {
        const pl = (l.external_line_id && get(db, 'SELECT id FROM po_lines WHERE id = ? AND po_id = ?', Number(l.external_line_id), po.id))
          || (l.sku && get(db, 'SELECT pl.id FROM po_lines pl JOIN pricebook pb ON pb.id = pl.pricebook_id WHERE pl.po_id = ? AND pb.code = ?', po.id, l.sku));
        return pl ? { po_line_id: pl.id, qty: Number(l.quantity_received ?? l.quantity ?? l.qty) } : null;
      }).filter(Boolean);
      P.receivePO(po.id, lines, null, 'ply');
      return { po: po.number, lines: lines.length };
    }
    case 'bill.created': case 'invoice.created': {
      const po = findPO(db, { external_id: d.purchase_order_external_id, purchase_order_id: d.purchase_order_id });
      if (!po) throw new Error('PO not found for vendor bill');
      if (d.id != null && get(db, 'SELECT id FROM bills WHERE ply_id = ?', String(d.id))) return { duplicate: true };
      const billId = P.billFromPO(po.id, { vendor_invoice: d.invoice_number || d.number, bill_date: d.date, total: d.total, ply_id: d.id != null ? String(d.id) : null });
      return { bill_id: billId };
    }
    case 'inventory.updated': {
      const row = (d.id != null && get(db, 'SELECT * FROM pricebook WHERE ply_item_id = ?', String(d.id))) || (d.sku && get(db, 'SELECT * FROM pricebook WHERE code = ?', d.sku));
      if (!row) throw new Error('Item not found');
      const qty = d.quantity_on_hand ?? d.qty_on_hand;
      if (qty != null) P.setStock(row.id, Number(qty), 'Ply inventory sync');
      if (d.unit_cost != null) run(db, 'UPDATE pricebook SET unit_cost = ? WHERE id = ?', Number(d.unit_cost), row.id);
      return { item: row.name };
    }
    case 'pick_list.updated': {
      const pl = (d.external_id && get(db, 'SELECT * FROM pick_lists WHERE number = ?', d.external_id)) || (d.id != null && get(db, 'SELECT * FROM pick_lists WHERE ply_id = ?', String(d.id)));
      if (!pl) throw new Error('Pick list not found');
      for (const l of d.lines || []) if (l.external_line_id) run(db, 'UPDATE pick_list_lines SET qty_picked = ? WHERE id = ? AND pick_list_id = ?', Number(l.quantity_picked ?? 0), Number(l.external_line_id), pl.id);
      if (['picked', 'completed', 'delivered'].includes(d.status)) P.completePickList(pl.id, null);
      return { pick_list: pl.number };
    }
    default: throw new Error(`Unhandled event type: ${type}`);
  }
}

module.exports = { config, request, pushJob, pushPO, pushPickList, pullItems, verify, handleEvent, log, toPlyPO, toPlyPickList, toPlyJob };
