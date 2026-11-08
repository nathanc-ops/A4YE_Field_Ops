# Ply integration

[Ply](https://getply.com) handles purchasing and inventory for trades contractors. A4YE Field Ops can:

| Direction | What | When |
|---|---|---|
| Out → Ply | **Purchase orders** (lines, quantities, unit cost, cost code, job) | "Send to Ply" on a PO, or a PO re-sent after edits |
| Out → Ply | **Pick lists** for a job | "Send to Ply" on a pick list |
| Out → Ply | **Jobs** with their cost codes and material budgets | "Send job to Ply" on a job's Purchasing tab (also sent automatically before that job's first PO) |
| In ← Ply | **Item catalog and stock levels** | Settings → Integrations → "Pull items & stock from Ply" |
| In ← Ply | **Webhooks**: PO status, receipts, vendor invoices, inventory changes, pick progress | Real time, at `https://<your-server>/hooks/ply` |

## ⚠ Read this first

Ply does not publish a public API reference. Its site only says you can build against the API with an API key. This connector uses a **configurable REST shape**: base URL, bearer API key, and the four endpoint paths are all set in **Settings → Integrations**. The payloads below are what this app sends and expects.

**Before going live**, ask your Ply rep for:

1. The API base URL and an API key.
2. The endpoint paths for purchase orders, pick lists, jobs/projects and items/inventory.
3. Their field names. If Ply's differ from the payloads below, change the mapping in `server/ply.js` (`toPlyPO`, `toPlyPickList`, `toPlyJob`, `pullItems`, `handleEvent`). Each mapping is a single function.
4. Webhook setup: point Ply at `/hooks/ply` and agree on a shared secret.

Every request and webhook is logged under **Settings → Integrations → Recent activity** (click a row to see the full payload). Use it to debug field mismatches.

## Outbound payloads

All requests send `Authorization: Bearer <API key>` and `Content-Type: application/json`. When Ply's response includes an `id`, it's stored as the record's Ply ID, and later sends become `PUT <path>/<id>`.

### Purchase order — `POST {ply_path_po}`
```json
{
  "external_id": "PO-1001",
  "vendor": { "ply_id": "v_123", "name": "City Electric Supply", "email": "orders@example.com" },
  "job": { "external_id": "J-1005", "ply_id": "j_77", "name": "J-1005 Add 3 dedicated circuits", "customer": "Bluebird Cafe", "address": "9 Market Sq, Springfield, IL, 62701" },
  "deliver_to": "job",
  "order_date": "2026-11-06",
  "needed_by": "2026-11-08",
  "notes": "",
  "lines": [
    { "external_line_id": "12", "sku": "MAT-122", "ply_item_id": "itm_9", "description": "12/2 NM-B wire (250 ft)", "quantity": 2, "unit_cost": 118, "cost_code": "400" }
  ]
}
```

### Pick list — `POST {ply_path_pick_list}`
```json
{ "external_id": "PL-1001", "job": { "...": "same as above" }, "needed_by": "2026-11-09", "notes": "",
  "lines": [{ "external_line_id": "3", "sku": "MAT-GFCI", "description": "20A GFCI receptacle", "quantity": 3, "cost_code": "600" }] }
```

### Job — `POST {ply_path_job}`
```json
{ "external_id": "J-1005", "name": "J-1005 Add 3 dedicated circuits", "customer": "Bluebird Cafe", "address": "…",
  "cost_codes": [{ "code": "400", "name": "Rough-in", "budget_material": 300 }] }
```

### Items — `GET {ply_path_items}`
Expects an array, or `{ "items": [...] }` / `{ "data": [...] }`. Each item: `id`, `sku`, `name`, `unit`, `unit_cost` (or `cost`), `quantity_on_hand`. Items are matched by Ply ID first, then by SKU against the price book code. Unmatched items are added to the price book under the category "Ply import".

## Inbound webhooks — `POST /hooks/ply`

**Authentication** (one of these is required):
- `X-Ply-Signature: sha256=<hex>`: an HMAC-SHA256 of the raw request body, keyed with the webhook secret. **Recommended.**
- `X-Ply-Token: <webhook secret>`: a plain shared token.

Body: `{ "type": "<event>", "data": { ... } }`. The webhook returns `200 {ok:true}` when the event is applied and `422 {error}` when it can't be matched. Both outcomes are logged.

| `type` | `data` | Effect |
|---|---|---|
| `purchase_order.updated` | `external_id` or `id`, `status` | Stores Ply's status. `submitted`/`ordered`/`approved` marks a draft PO as ordered; `cancelled` cancels a draft. |
| `purchase_order.received` | `external_id` or `id`, `lines: [{ external_line_id or sku, quantity_received }]` | Receives the goods. A job PO adds job materials at PO cost; a shop PO increases stock at weighted-average cost. |
| `bill.created` / `invoice.created` | `id`, `purchase_order_external_id` or `purchase_order_id`, `invoice_number`, `date`, `total` | Creates a vendor bill in A/P from the PO. A difference between the vendor's total and the PO total is booked as a price-variance line. The same Ply invoice ID is never imported twice. |
| `inventory.updated` | `id` or `sku`, `quantity_on_hand`, `unit_cost` | Sets stock. The change posts an inventory adjustment to the ledger. |
| `pick_list.updated` | `external_id` or `id`, `status`, `lines: [{ external_line_id, quantity_picked }]` | Updates picked quantities. `picked`/`completed`/`delivered` completes the pick, which charges the materials to the job from stock. |

## How it affects job costing and the books

- **Job POs** (delivered to the job): received lines become job materials under the line's cost code. The vendor bill posts debit 5100 Job Materials / credit 2000 A/P. Job costing counts the materials once, from the receipt, not again from the bill.
- **Shop POs**: receipts add stock. The bill posts debit 1300 Inventory / credit A/P. When a pick list or a tech uses stock, it posts debit 5100 / credit 1300 at cost under the job's cost code.

## Testing without Ply

`test/ext.test.js` runs a fake Ply server. It covers sending a PO, pulling items, and signed `purchase_order.received` and `bill.created` webhooks. Copy its approach to try a real payload locally before connecting production.
