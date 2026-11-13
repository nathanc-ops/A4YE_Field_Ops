# Housecall Pro → Field Ops

Settings → **Housecall Pro** pulls customers, estimates and jobs (with their notes) from the Housecall Pro public API
and brings Field Ops up to date. It only reads from Housecall Pro; nothing is sent back.

## Setup
- The Housecall Pro API is on the **MAX** plan. An admin creates the key in Housecall Pro: App Store → API.
- Paste the key into Settings → Housecall Pro → Save key → **Test connection**.
- The first time, use **Pull everything**. After that, **Pull changes now** reads only records updated in Housecall
  Pro since the last finished pull.
- The pull runs on the server in the background. You can leave the page; the card shows progress and the result.

## What comes over
| Housecall Pro | Field Ops |
|---|---|
| Customer name, company, email, mobile/home/work phone, lead source | Customer (Housecall Pro wins; a blank in Housecall Pro never erases anything) |
| Customer notes | "Notes from Housecall Pro" on the customer (your own notes are kept separately) |
| Customer addresses | Locations |
| Estimate (options, line items) | New estimates come over whole, with good/better/best options and multi-line descriptions |
| Estimate option status | Approved / declined / sent, and which option was approved. Existing estimates' lines are left alone |
| Estimate option notes | The estimate's **Internal notes** (never on the customer's copy) |
| Job status, schedule, description, address, assigned employees | Job (and the schedule board) |
| Job notes | Job notes, labeled "Housecall Pro" |

## Matching and rules
- Customers: Housecall Pro id → old-system id → email → phone → exact name.
- Estimates: Housecall Pro id → estimate number. Jobs: Housecall Pro id → job number (Housecall Pro's "invoice number").
- Notes are kept by their Housecall Pro note id, so pulling again updates a changed note instead of adding a copy.
- A job already **Invoiced** here stays Invoiced. **On hold** and **Dispatched** stay unless Housecall Pro says the job
  is finished or cancelled. Job titles, billing type and money are never changed.
- Assigned employees are matched to Team members by email, then by name. Anyone not found is listed under
  "things to check" — add them in Team and pull again.
- **See what Housecall Pro sends** shows the raw first record of each list, to check field names on a real account.
