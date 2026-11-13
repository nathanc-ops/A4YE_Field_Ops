# Ply integration

Field Ops connects to Ply through the **Ply Public API** (https://docs.getply.com). Requests go to `https://api.getply.com/api/v1`, or the demo server, with your key in the `API_KEY` header.

## Set up (about 5 minutes)

1. **In Ply:** go to **Settings → Workspace → API Keys → Create API Key**. The Public API is a Ply add-on; if you don't see API Keys, ask your Ply account manager. Name the key something like `Field Ops` and tick these scopes:
   - `jobs:read` (to find and link Ply jobs; without it, POs made in Ply can't be matched to jobs)
   - `jobs:write`
   - `pick_lists:read` (pick list status on the job)
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
- **A job's POs or pick lists from Ply aren't showing:** open the job → Purchasing → **In Ply for this job**.
  - It shows the Ply job the job is linked to, every Ply PO delivered to it (marked *not brought in yet* until imported), and the Ply pick lists going there, each with its Ply status.
  - Not linked: pick the Ply job from the list, or create it in Ply. Jobs link automatically only when the Ply job has the same job number, or the number in its name.
  - A message about a missing permission names the scope to add to the key.
- **Job numbers:** a job links to its Ply job by its **Time clock job #** (the number the field uses) or its Field Ops number, found in the Ply job's number or its name. Archived Ply jobs count too. Jobs sent to Ply carry the time clock job # when one is set. The search box on a job finds Ply jobs by number as well as name.
- **A PO that's here twice** (for example written in Ply and also entered here): open the copy to drop and press **Remove (duplicate)**.
  - It shows what removing it undoes: received material comes back off the job, and shop receipts come back out of stock. You pick the PO it duplicates, and a note goes on the job.
  - If it came from Ply, or was sent there, the Ply sync leaves that Ply PO alone from then on. It stays in Ply, so cancel it there if it shouldn't be ordered.
  - It's refused while a vendor bill is entered from it (void the bill first), or while its material is billed to the customer.
- **Which Ply POs belong to a job:** Ply's API ties a PO to a job only by where it's delivered. So a PO is brought onto a job when:
  - it's delivered to the job's linked Ply job;
  - or it's delivered to another Ply job record carrying the same job number (a second record for the same project);
  - or its order number or note names the job number (4+ characters), for POs delivered to the shop or a truck *for* the job.

  Only POs from the last 2 years are brought in. The job's **In Ply for this job** panel lists every candidate from the last 3 years: how it matched, where it was delivered, and why it isn't here if it isn't.
- **One PO still missing:** on the job, **In Ply for this job → Find a Ply PO by number**. Type the Ply order number (or part of it).
  - It shows where Ply has the PO and why it isn't on a job here.
  - **Put on this job** brings it in, received material included. A copy on another job with nothing received is moved over. One with material received has to be removed there first.

