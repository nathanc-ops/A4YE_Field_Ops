# Ply integration

Field Ops connects to Ply through the **Ply Public API** (https://docs.getply.com). Requests go to `https://api.getply.com/api/v1`, or the demo server, with your key in the `API_KEY` header.

## Set up (about 5 minutes)

1. **In Ply:** go to **Settings → Workspace → API Keys → Create API Key**. The Public API is a Ply add-on; if you don't see API Keys, ask your Ply account manager. Name the key something like `Field Ops` and tick these scopes:
   - `jobs:write`
   - `pick_lists:write`
   - `purchase_orders:write`
   - `purchase_orders:read` (to bring in POs written in Ply)
   - `materials:write`
   - `materials_availability:read`
   - `locations:read`
   - `suppliers:read`

   Copy the key. Ply shows it only once.
2. **In Field Ops:** go to **Settings → Integrations – Ply**:
   - tick **Enabled**;
   - paste the key and press **Save**;
   - press **Test connection**, which loads your Ply warehouses and trucks;
   - choose **Pick lists come from** (and optionally **Shop POs deliver to**), then **Save** again.
3. Press **Pull materials & stock** once. This links your price book to Ply's catalog: matched by Ply ID, then SKU = Ply item number, then exact name. Ply items you don't have yet are added to the price book.

Keep the key out of email, chat and source code. It lives only in the server's settings and is never sent back to a browser. If a key is ever exposed, delete it in Ply and create a new one.

## What syncs

| Action in Field Ops | In Ply |
|---|---|
| **Send job to Ply** (job → Purchasing tab), or automatically on the first pick list or PO for a job | A Ply **job** (name, number, client, address). An existing Ply job with the same number is linked instead of duplicated. |
| **Send to Ply** on a pick list | A Ply **pick list** from your chosen warehouse or truck **to the job**, with each line as a catalog material. A line's cost code is noted as the material code, e.g. `0810-M`. Re-sending adds only new lines. |
| **Send to Ply** on a PO | A Ply **purchase order**, left as **Draft** so you send it to the supplier from Ply. The supplier is matched by name; the PO is delivered to the job (or your shop location) with your prices. |
| **Pull materials & stock** | Price book cost, client price, unit, and stock on hand. Stock counts warehouses and trucks, not material already at jobs. |
| **PO written in Ply** for a job (delivered to the job's Ply location) | Brought in hourly, or with **Check Ply for POs** on the job's Purchasing tab. It becomes a PO on the job (badge **Ply** plus Ply's order number), its supplier is matched to a vendor or added, and its lines link to price-book items where the Ply material is linked. It is logged in the job's notes. Lines added in Ply later come in too, and receipts in Ply charge the job as usual. A Ply job that has the same number as a Field Ops job is linked automatically. |
| **Sync now**, and hourly | PO status; receipts entered in Ply receive the matching PO lines here (stock or job materials, as usual); a pick list Ply marks **Completed** completes here and charges the job. |

## Items Ply doesn't have

Every Ply line must be a Ply catalog material. When a pick list or PO has lines Ply's catalog doesn't have, such as an item typed in by hand, Field Ops lists them and asks before adding them to Ply's catalog. Say no, and nothing is sent. You can add or link them in Ply, then send again.

## Limits and errors

- Ply allows 60 requests a minute and 10,000 a day per business. Field Ops waits and retries when Ply says to slow down.
- **"Rejected the API key":** create a new key in Ply.
- **"Missing a permission (scope)":** edit the key in Ply and add the scope named in the message.
- Every call is logged under Settings → Integrations – Ply → Recent activity. Click a row to see what was sent and returned.
- Ply has no webhooks, so Field Ops pulls changes. The old `/hooks/ply` address is no longer used.
- **POs written in Ply:**
  - Only POs created in the last 180 days, and delivered to a job's Ply location, are brought in. POs to a warehouse or truck are left alone.
  - The API gives one total, so tax and shipping arrive together as one amount (Ply total minus the lines).
  - Edits to a line's quantity or price in Ply after import aren't copied. Fix them on the PO here.
