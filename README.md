# A4YE Field Ops

Field service management for residential and commercial electrical contractors. It covers an hourly tech board and dispatch, estimates with online approval, invoicing, a time clock, cost-coded job costing, purchasing and pick lists (with a Ply connector), and built-in double-entry accounting. It's self-hosted and runs as one Node process with a SQLite file. No subscription, no build step.

## Quick start

```bash
npm install
npm run seed      # optional: load demo data (admin@example.com / password123)
npm start         # http://localhost:3000
```

If you skip the seed, the first visit asks you to create the owner (admin) account.

**Windows:** if PowerShell says *running scripts is disabled on this system*, type `npm.cmd` instead of `npm` (for example `npm.cmd install`), or use Command Prompt. Two shortcuts you can double-click:
- `start-windows.bat` starts the program and opens it in the browser. Keep its window open while you use it.
- `update-windows.bat` backs up `data\fieldops.db`, downloads the latest version from GitHub and starts it. It needs [Git](https://git-scm.com/download/win), and works even if you first downloaded the code as a ZIP.

**Putting it online** for the crew: see [docs/DEPLOY.md](docs/DEPLOY.md). It covers a DigitalOcean server at ops.all4youelectrical.com with HTTPS, nightly and off-site backups, and one-command updates.

**On phones:** the crew can install it from the browser today (iPhone Safari → Share → *Add to Home Screen*; Android Chrome → *Install app*). For App Store and Google Play builds, see [docs/MOBILE_APPS.md](docs/MOBILE_APPS.md); the native projects are in `mobile/`.

Requires **Node 22.13+**. It uses Node's built-in `node:sqlite`, so there are no native modules to compile. Data lives in `data/fieldops.db` and uploaded photos in `data/uploads/`; set `DB_PATH` / `UPLOAD_DIR` to put them somewhere else. **Back up the `data/` folder** (database and photos). It is your entire business record.

## What it does

| Area | Features |
|---|---|
| **Tech board (hourly)** | One row per tech across the working day, with several visits per tech per day. Overlapping visits stack instead of hiding each other. Drag a visit to move it in time (15-minute snap) or onto another tech; drag its right edge to resize it. Click an empty slot to add a visit, or drag jobs in from the "needs scheduling" queue. Shows a now-line, who's on the clock and booked hours. Double-bookings are flagged. |
| **Week view** | Techs × days, with a capacity bar per day (booked vs. 8 h). Drag visits between days and techs; each visit keeps its time of day. |
| **Dispatch console** | Unscheduled and emergency queue, today's visits in status order (Dispatch → En route → On site → Done), and tech cards showing clock status and booked hours. Refreshes every minute. |
| **Visits (appointments)** | A job can have many visits, each with its own crew and time. That covers multi-day commercial work and return trips. On the tech's My Day screen, **On site** clocks the tech in and **Done** clocks them out. |
| **Customers** | Residential and commercial, with multiple service locations per customer. Tracks service size, panel info, access notes, tax-exempt status, custom payment terms and lead source. |
| **Estimates** | Line-item editor with price book lookup and your cost/margin shown live (internal only). Sends a link where the customer views, e-signs and approves or declines. Approved estimates convert to a job (budget hours and materials are filled in from the price book) or to an invoice. |
| **Invoices** | Build from the approved estimate, or from logged labor (each tech's bill rate) plus billable materials. Partial payments, void, overdue flags and a customer-facing invoice page. |
| **Time clock** | Techs clock in on a job from their phone. Switching jobs auto-closes the last entry. Time types: job, travel, shop, training, PTO. The office can add or edit entries. Every entry snapshots the wage and loaded cost at the time it's logged. |
| **Materials & inventory** | Techs log materials per job. Truck/shop stock decrements on-hand quantity, and low-stock alerts are driven by reorder points. |
| **Permits & inspections** | Permit number, AHJ, status (applied → issued → rough → final → passed), inspection dates and fees. Fees count as job cost. |
| **Service agreements** | Maintenance plans and memberships, annual recurring revenue, next-visit tracking and one-click visit job creation. |
| **Expenses** | Expenses tied to a job are job cost (subs, rentals, supply runs). Untied expenses are overhead. |
| **Checklists** | Electrical templates attach automatically by job type: job-start safety (PPE, LOTO, live-dead-live), service diagnostic, panel upgrade / service change (GES, bonding, torque, AFCI/GFCI, working clearance, NEC 230.67 surge), EV charger, generator / interlock, final walkthrough. Pass / Fail / N/A, number and text answers; answers save as you tap. Required lists must be finished before a tech can complete the job (office can override; the override is noted on the job). Templates are editable in Settings. |
| **Photos & files** | Take photos from the phone camera, tagged before / during / after / panel / permit / damage. Photos shrink to 1600 px before upload to save cell data and carry a GPS stamp. PDFs accepted. Files are checked by content (not by name) and served only to signed-in users who are allowed to see that job. |
| **Customer sign-off** | **Complete job** collects what was done and the customer's signature and printed name on the tech's screen. The sign-off shows on the job and on the customer's invoice page, and signatures can't be deleted. |
| **GPS punches** | Clock-in, clock-out, en route, on site and done record the phone's location when the tech allows it (it never blocks a punch). Timesheets show 📍 map links. |
| **Equipment records** | Panels, meters, disconnects, transfer switches, generators, EV chargers, surge protectors, solar and batteries at each address: make, model, serial, rating, install date, warranty, the job that installed it, and data-plate photos. Shown on the job and the customer. |
| **Good / better / best** | Any estimate can offer 2–4 options (one click sets up Good / Better ★ / Best). Lines on the "In every option" tab (permit, trip charge) are shared; each option has its own lines, description, price with tax, and your internal cost and margin. Customers see the options side by side with your recommendation highlighted, tap one, and sign. The office can also record the choice ("Mark approved" asks which option). The chosen option sets the job's contract, cost-code budget, pick list and final invoice. Lists show the price range until the customer chooses. Techs get a **Present to customer** button on their job so the customer can choose and sign on the tech's tablet. |
| **Field estimating** | Techs build estimates (including good/better/best and change orders) on their own jobs from a tablet or phone. **Price-book prices are enforced**: the server reprices every price-book line, so a tech can't lower a price. Customer, location, tax and terms come from the job and office settings. **Costs and margins are hidden from techs** unless you turn them on; techs see a "Pricing OK" check per option instead. **Guardrails** (Settings → Field estimating): a discount cap (10% default), a margin floor (35% default), and a policy for custom lines (review / allow / block). Inside the guardrails the tech taps **Present to customer**, and the customer picks and signs on the spot. Outside them the estimate goes to **office review**: the customer can look but can't sign. The office gets a dashboard alert and an "Needs review" tab, then approves the pricing or sends it back with a note. Every step is logged on the job. If a customer approves a tech's quote on a T&M job, the Billing tab offers **Bill as quoted price**. |
| **Quoted-price jobs** | The contract equals the approved quote plus **change orders the customer signs online** (an estimate created on a quoted job becomes a change order automatically). Bill by deposit, **schedule of values** (milestone templates: 30/40/30, 50/50, 5-phase commercial), **% complete**, a set amount, or **final**. If the job is one-shot, the final invoice shows the quote's line items. Optional **retainage** is withheld on each progress bill and released on the final. You can't bill past the contract; extra work needs a change order. Shows earned vs billed (over/under-billing) and projected profit. Time and materials are tracked for costing only. |
| **Time & material jobs** | Labor at the job's rate or each tech's bill rate, **rounded up to the billing increment** (15 min default, with 30 seconds' grace), with travel optional. Materials at price-book price or **cost + markup**. Billable expenses (rentals, etc.) at markup, plus an optional **trip charge**. Optional **not-to-exceed** cap: billing past it requires confirmation. Bill everything or **through a date** (weekly billing on long jobs). Each hour, part and expense is billed **once**: it's stamped with its invoice and **locked**, and voiding the invoice releases it to be billed again. |
| **WIP & unbilled report** | Quoted jobs: contract, cost to date, % complete, earned, billed, over/under-billed, retainage and projected profit (the work-in-progress schedule banks and bonding companies ask for). T&M jobs: unbilled hours and dollars and room left under the NTE. Exports to CSV. |
| **Cost codes** | 16 electrical phase codes by default (Rough-in, Service & Distribution, Trim, Lighting, EV/Generators, Permits, …), editable in Settings. Codes apply to time (picked at clock-in), materials, PO and pick-list lines, estimate lines, bills and expenses. Converting an approved estimate builds each job's **budget by cost code** (hours and material), and every job has a budget-vs-actual tab. |
| **Purchasing** | Vendors, purchase orders (to a job or into shop stock) and receiving. Job deliveries become job materials at PO cost; shop deliveries add stock at weighted-average cost. One click turns a PO into a vendor bill and records any price variance. Also does reorders from low stock and POs for pick-list shortages. |
| **Pick lists** | Built from the approved estimate or by hand, picked on a phone or tablet. Completing a pick charges the materials to the job from stock. |
| **Ply** | Uses the Ply Public API. Sends jobs, pick lists (from your warehouse or truck to the job) and draft POs to Ply. Pulls Ply's catalog, costs and stock into the price book. PO receipts and completed picks in Ply sync back hourly. See [docs/PLY_INTEGRATION.md](docs/PLY_INTEGRATION.md). |
| **Accounting (admin)** | Double-entry general ledger and chart of accounts set up for an electrical contractor. Invoices, payments, vendor bills, bill payments, expenses, stock usage and weekly labor accruals post **automatically**. Also: manual journal entries, A/P with bill payments, account registers, income statement, balance sheet, trial balance, A/P aging, recording payroll payments and closing the books (which locks the period). |
| **Banking (admin)** | Import bank and credit card statements (CSV, OFX, QFX — every bank exports these; re-importing the same file never duplicates). Lines that match something already in the books (customer payments, bill payments, expenses, transfers) are **matched automatically**. For the rest: **Add expense** (pre-filled by categorization rules like SHELL → Fuel; lands in Expenses and job costing), **Apply** a deposit to the open invoice with that balance, record a transfer between your own accounts, or exclude. **Reconcile** against each statement: check off cleared items until the difference is $0.00, then finish; reconciled transactions are locked until the reconciliation is undone. |
| **Branding** | All 4 You Electrical theme out of the box: logo red #FA001C (buttons #E0001A for readable white text) on black, Barlow / Barlow Condensed type, the A4 logo and the "Powered by people. Built All 4 You." sign-in screen. Colors, logo and tagline can be changed in Settings → Branding and apply to the app and to the estimate/invoice pages customers see. Button and link colors are adjusted automatically to keep text readable in light and dark mode. **Dark mode is the default**; each person can choose Light or Match device in Settings → Appearance (saved per device). Customer estimates and invoices always print on white. |
| **Reports** | P&L (revenue by segment → COGS → gross profit → overhead → net), 12-month trend, job costing (budget vs actual, margin), hours on job, payroll with weekly overtime, tech performance (utilization, revenue/hour), A/R aging, estimate close rate and lead-source ROI. CSV export and print on all of them. |
| **Roles** | **Admin**: everything. **Office**: everything except team and settings. **Tech**: their own jobs, the clock, material logging, checklists and photos, and estimates on their jobs within your guardrails. Techs never see wages or financials, and see costs only if you allow it. |

### How the numbers are calculated

- **Labor cost** = hours × loaded rate, where the loaded rate is wage × (1 + burden %). Set each employee's wage and burden (payroll taxes, workers' comp, benefits) on the Team page. Wrong burden percentages make every margin wrong.
- **Revenue** is accrual-basis. It counts sent, partial and paid invoices by issue date and excludes sales tax.
- **COGS** = direct labor on jobs + materials used + permit fees + job-tied expenses.
- **Overhead** = untied expenses + non-billable labor (shop, training, PTO).
- **Overtime** = hours over the weekly threshold (Mon–Sun) at the multiplier you set in Settings.
- There are two P&Ls on purpose. **Reports → Profit & Loss** is the operational view, built live from jobs, time and materials. **Accounting → Income statement** comes from the posted ledger. They match only once labor has been posted (Accounting → Labor & payroll) and every bill or expense has been entered.

### Accounting: how things post

| Event | Debit | Credit |
|---|---|---|
| Invoice sent | 1200 A/R (total) | 4000/4100 Revenue (res./comm., net of discount), 2200 Sales tax |
| Customer payment | 1000 Checking (or the account chosen) | 1200 A/R |
| Vendor bill (job PO / shop PO / other) | 5100 Job materials / 1300 Inventory / the line's account | 2000 A/P |
| Bill payment | 2000 A/P | Bank or credit card |
| Stock used on a job (tech log or pick list) | 5100 Job materials | 1300 Inventory |
| Expense (paid immediately) | By category, or the account chosen | Bank or credit card |
| Weekly labor (loaded cost) | 5000 Direct labor / 6000 Indirect labor | 2100 Accrued payroll |
| Payroll paid | 2100 Accrued payroll | Bank |
| Inventory count change | 1300 / 5900 | 5900 / 1300 |

Editing or voiding a source record re-posts its entry. Entries dated on or before **Books closed through** can't change: the whole edit is rolled back. The same goes for any transaction that appears on a completed bank reconciliation: undo the reconciliation first.

### Banking workflow

1. Download your statement from the bank as CSV or OFX/QFX. In **Accounting → Banking**, pick the account and choose **Import statement**.
2. Work the **To review** list: **Match**, **Apply** (a customer deposit), **Add expense** or **Categorize**, or ✕ to exclude a duplicate.
3. Choose **Reconcile** and enter the statement's ending date and balance. On an account's very first reconciliation, also enter the statement's start date and beginning balance. Matched lines arrive already checked; check anything else on the statement until the difference is $0.00, then choose **Finish**. When upgrading a database from an earlier version, run **Accounting → Close books → Rebuild ledger** once.

## Moving over from your old system

**Import Data** (admin only, in the sidebar) brings records over as CSV files exported from ServiceTitan, Successware, Housecall, QuickBooks or a spreadsheet. In Excel, use File → Save As → CSV.

1. **Pick the file.** Columns are matched to fields automatically from the names those systems use. Fix any match in the drop-downs.
2. **Test run.** This runs the whole import and then throws it away. It shows exactly what would be added or updated, and which rows have problems and why.
3. **Import.** Rows with problems are left out; everything else goes in.
4. **Undo** any import from the history. This removes what it added, unless those records have been used since (for example, a new job on an imported customer).

Import in this order, because later files find their customer and job by the IDs and numbers in earlier ones:

| Order | What | Notes |
|---|---|---|
| 1 | **Chart of accounts**, then **opening balances** | Opening balances are the trial balance from your old books on your start date. Any difference goes to *3950 Opening Balance Equity*, which should be zero when you're done. |
| 2 | **Customers**, **vendors** | Matched to existing records by old-system ID, email, phone, then name. Matches fill in missing details instead of creating duplicates. A service address on the row adds a location. |
| 3 | **Materials & price book** | Matched by code, then name, and updated. |
| 4 | **Jobs** | Old job numbers are kept. Technicians are matched to your team by name. Open jobs with a date land on the schedule board. |
| 5 | **Estimates**, **invoices & payments** | Either one row per document, or one row per line item with the number repeated. An *Option* column builds good/better/best. *Amount paid* or *Balance due* records the payment. |
| 6 | **Notes**, **materials used on jobs**, **journal entries** | Notes go on the job, or on the customer when there's no job number. Material history counts toward job costing without changing stock. |
| 7 | **Photos** | Pick a folder. Each photo goes on the job whose number is in its folder or file name (`5001/panel.jpg`, `5001 - Smith_before.jpg`). |

**Imported invoices stay off the books by default.** Your opening balances already include receivables as one total, so posting every old invoice would count that revenue twice. Old invoices still show on customers, jobs and sales reports. A payment you record on an imported open invoice from now on posts normally. Tick *Post these invoices and payments to the books* only if you are not importing opening balances.

## Email

Set it up in the app: **Settings → Email** (admins). Pick the provider, enter the sign-in and the address to send from, and press **Send test email**; a failed test says why in plain words (wrong key, blocked port, unverified sender). The password or API key is stored as a secret and never shown again. Until email is set up, **Send** marks the document as sent and copies the link or text so you can send it yourself, and every message is listed under Settings → Email → Recent messages.

- **Use a sending service on a DigitalOcean server.** DigitalOcean blocks outgoing mail ports 25, 465 and 587 on many accounts, so connect on port **2525**. Postmark (recommended), SendGrid and Brevo all accept it, as does Amazon SES on 2587. Each will have you verify your domain with a few DNS records (SPF/DKIM) so mail lands in inboxes instead of spam.
- **Twilio Email (new Twilio Console, SK keys):** pick *Twilio Email (API key SK…)*. It sends over the Twilio Email API on normal HTTPS, so mail-port blocks don't apply. Username = the API key SID (starts with `SK`), password = the key's secret. Authenticate the domain under Email → Domains first. Twilio's API can't set Reply-To or CC: CC'd people get their own copy, and each message ends with "To reply, email <company email>". (An `SG.` key from app.sendgrid.com uses the *SendGrid SMTP* preset instead.)
- **Microsoft 365:** Microsoft has been turning off password sign-in for SMTP, so a mailbox password usually no longer works. Send through one of the services above using your domain.
- **Google Workspace:** works with an App Password, if the server can reach port 587.
- **Sending from a no-reply address** (e.g. `noreply@yourdomain.com`): every email carries a Reply-To of the **company email** in Settings → Company, so customers who press Reply still reach the office. Invoice and estimate emails say "Questions? Reply to this email or call …". Settings → Email shows where replies go, and warns if the company email is blank. With Postmark, SendGrid, Brevo or SES the no-reply address needs no mailbox, only the verified domain. With Google Workspace or Microsoft 365 it must be a real mailbox or an alias the account may send as.
- **Email wording** (Settings → Email templates, admins): the subject and message of estimate, invoice, job-visit, estimate-visit and cancellation emails. Plain text with `{placeholders}` (click to insert) and a live preview. A line whose placeholder is empty (no crew yet, no extra note) is left out, `Label: value` lines become a neat list, and a line ending in `{link}` becomes a button. The Send window shows each email filled in and editable, so a one-off change doesn't touch the template. "Back to default" restores the built-in wording.

`SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS` and `SMTP_FROM` on the server still work, and take priority over Settings when set.

`PUBLIC_URL` controls the links in emails, so set it to the address customers can actually reach.

## Jobs on hold

Putting a job **on hold** (status menu, Edit, or a tech's phone) requires a **reason** and a **follow-up date**; the server refuses it without them.
- The job shows a banner: who put it on hold, when, why, and the follow-up date (overdue in red), with **Change follow-up** and **Add to my calendar** (.ics).
- The follow-up is a **task for a person**: picked when the job goes on hold (default: **Settings → Follow-up tasks for jobs on hold go to**, e.g. the office person who chases holds; blank = whoever puts it on hold). It can be handed to someone else from the job's banner.
- The task shows on **Schedule → Week** in that person's row (office staff get an **Office** row; it takes no booked hours), on the **Dashboard** when due or overdue (your own first), and under the status in the Jobs list.
- The person with the task gets an all-day **calendar invite** by email. After saving, a message says whether it was emailed or why not (email not set up, no email on their user, or the provider refused it); every attempt is listed on the job’s **Emails & calls** tab. Moving the date updates the same event; taking the job off hold cancels it.
- Every change is written to the job's notes, so the history stays after the hold ends.

## Pipeline (🧭)

A Salesforce-style board of every deal, from lead to paid. Stages are worked out from the records you already keep, so nothing is entered twice. Each customer, estimate, job or invoice appears once, at the furthest point it has reached:

| Stage | What's in it | Salesforce equivalent |
|---|---|---|
| Lead (10%) | Customers marked as leads (**+ Lead**), or new in the last 60 days with nothing else yet | Lead |
| Estimating (25%) | Estimates being written | Opportunity: needs analysis |
| Proposal sent (50%) | Estimates sent or viewed (flagged when the price has expired) | Proposal / quote |
| Won — to schedule | Approved estimates with no job, and unscheduled jobs | Closed won → order |
| In progress | Jobs scheduled, dispatched, underway or on hold | Order fulfilment |
| To invoice | Completed jobs not fully invoiced | Ready to bill |
| Invoiced | Sent invoices with a balance (flagged when past due) | Open invoice |
| Paid | Invoices paid in the last 30 days | Cash in |
| Lost | Declined estimates and unqualified leads, each with a reason (**Show lost**) | Closed lost |

- **Totals at the top:** open pipeline, with a forecast weighted by each stage's probability; booked work (won but not billed); money awaiting payment; and the 90-day win rate.
- **Filters:** owner, residential or commercial, and search.
- **Click a card** to set its owner, **next step** with a date (overdue ones turn red), and expected decision date. The card also has the action that moves the deal on: + Estimate, Won → mark approved, Lost (asks why), Convert to job, Schedule it, or Bill job.
- **Drag a card** to another column, or onto a stage arrow at the top (handy when the column is scrolled out of view). On a phone, use **Move to…** in the card's panel. Each move does what the matching button does, and asks for anything it needs:
  - a lead → Estimating opens a new estimate for them;
  - an estimate → Proposal emails it (or, with no email, marks it sent);
  - → Won asks which option was chosen;
  - → In progress also creates the job and opens the schedule form;
  - → Lost asks why;
  - a job → To invoice opens Complete job, and → Invoiced opens its Billing tab;
  - an invoice → Paid records the payment.

  Columns a card can't go to fade while you drag. Moving backwards (say, a job back to Proposal) is refused, so open the record to undo something.
- **The stage bar** at the top of every customer (lead), estimate and job shows where it is, with its next step.

## Reports → Jobs

A list of every job in the date range. **Dates are** picks which date counts: created, scheduled/start, or completed.
- Filters: status (or "Open"), job type, service vs projects, and tech.
- Each row shows techs, status, on-hold reason with days on hold, follow-up date and who has it, created/scheduled/completed dates, hours, contract, invoiced amount, and cost and margin for people allowed to see costs.
- The top cards show totals, with a count of jobs per status underneath. **Export CSV** downloads the list.
- **Click a job** for its one-page report: customer and site, dates, scope and completion notes, visits, hours by person, materials, permits, estimates and invoices, emails and calls, and notes. Use **Print / save as PDF** to print or save it.

## Emails & calls

Each **customer**, **job** (tab **Emails & calls**), **estimate** (under the lines) and **Estimating takeoff** (tab **Calls & emails**) has a communication log.
- **Emails** appear automatically: every email this app sent about that record (estimates, invoices, visit confirmations, project reports, hold follow-up invites), with the send status and the full text. The customer page rolls up everything sent about their jobs, estimates and invoices. Emails to staff are tagged **staff**.
- **Calls, texts, emails sent from Outlook and meetings** are logged by hand with **+ Log a call**: direction, who, outcome (Left voicemail, Talked, Scheduled…), minutes and notes. Tapping the phone number on the card offers to log the call. A call logged on an estimate or job also shows on the customer.
- Not captured: **replies, incoming mail, and mail sent from Outlook**. The app doesn't read a mailbox. **Phone calls aren't recorded automatically** either; there is no phone-system connection. Log the ones that matter.
- Techs see a **Calls** tab on jobs they're assigned to and can log calls there; they don't see emails. Only whoever logged an entry (or an admin/manager) can edit or delete it.

## Lists: filter and sort

Customers, Jobs, Estimates and Invoices: click a column heading to sort (click again to flip). Filters sit above each list; the URL keeps filters, sort and page, so Back and bookmarks work.
- **Customers:** search, type, lead source, date added. Sort by name, newest, or number of jobs.
- **Jobs:** status tabs, search, job type, service vs commercial project, billing (fixed / T&M), tech, scheduled date range. Sort by job # (J-9 before J-10), customer, type, scheduled, completed, status.
- **Estimates:** status tabs (incl. Open = sent or viewed), search (#, customer, title, job #), created date range. Sort by #, customer, title, created, status, margin, total. The total row covers every match, not just the page.
- **Invoices:** status tabs, search (#, customer, job #), issued date range, overdue only. Sort by #, customer, job, issued, due, status, total, balance. Total and balance cover every match.
- Estimates and invoices used to stop at the newest 500; they now page through everything.

## Vendors (🏭 Vendors)

Its own menu item (for anyone with Purchasing or Accounting; the old Purchasing → Vendors tab opens it). Search, Active / Inactive / All, sortable columns.
- Each vendor's page: contact details, terms, open POs, purchase orders, bills, and the price book items that list it as preferred. **+ Purchase order** starts a PO with the vendor already picked.
- Money from bills (we owe, past due, last 12 months' spend) shows only to admins and people with Accounting.
- **Contacts:** as many people per vendor as you need (counter rep, outside sales, AP…), each with role, email, phone and notes; **Email all** opens one email to everyone. Mark who **Gets POs**: a PO's **✉ Email PO** button opens an email to them with the lines filled in (or to the vendor's main email when nobody is marked). Existing contacts moved into the list automatically.
- **Delete** works only for a vendor nothing uses; one with POs, bills, items or entries has to be made inactive so that history keeps its vendor. Names must be unique.

## Time Clock: week at a glance (office, managers, admins)

Everyone's Monday–Sunday week (same weeks as payroll): hours worked each day, hours scheduled on the board, and projected = worked so far + scheduled time still ahead. Flags against **Overtime after** (Settings, default 40):
- **Over 40 now:** clocked hours are already past it (anyone on the clock counts up to now).
- **Headed over 40:** worked + what's still scheduled goes past it.
- **Scheduled over 40:** the board has them booked for more than 40 this week.
A visit spanning several days counts its daily window (Mon–Fri 7–3 = 8 h a day). Technicians don't see this view. The same card is on the Dashboard.

## Estimating dashboard (📐 Estimating)

The commercial bid log from the Estimating Dashboard workbook. **Admins and managers only**: office staff and technicians don't see it, and the server refuses them.
- **Import:** Estimating → Import workbook. Reads the DATA tab only (due date, bid #, project, the contractor columns marked X, date submitted, bid value, status, check-in notes). Bids match by bid #, so importing again updates them instead of adding copies.
- **Totals use the sheet's formulas:** bids submitted (has a submitted date), total value, awarded, waiting. Added: win rate (awarded ÷ awarded + lost, by count and by $) and results per contractor.
- **Due next** lists bids still being estimated, by due date; late ones are flagged. **Needs a check-in** lists bids waiting 14+ days since they went out and since the notes last changed.
- A bid sent to two contractors counts under both, so the per-contractor $ adds up to more than the total (the sheet's "Bid Value % per Contractor" chart had the same double count).
- Add or edit bids on the page; adding a submitted date moves a bid from Estimating to Waiting.
- **Plan takeoff by Claude:** on a bid, pick the job type (Commercial / Residential) and attach the plan files: one or more PDFs (plan sets, specifications, addenda) and photos of sheets (PNG, JPEG, WEBP, GIF), up to 40 files, 150 MB per file and 500 MB per takeoff. Files are uploaded one at a time (with progress), then sent to Anthropic's Files API once and kept there 90 days, so running again doesn't re-send them; what limits a run is Claude's 600 pages per request (the Plans tab shows an approximate page count). Claude reads them as one set; a later addendum overrides what it changes. The takeoff's **Plans & instructions** tab adds or removes files and runs it again; files picked but not yet uploaded are uploaded first when you run. Files can be picked several at once, in several picks from different folders, or dragged in; each pick adds to the list and ✕ removes one.
  - **Instructions for Claude on this estimate:** a text box on the bid form and on the takeoff's **Plans & instructions** tab (e.g. MC above ceilings, EMT where exposed; owner-furnished fixtures; which areas are in scope; exclusions; alternates). Claude follows them over the job type's template; they're saved with the estimate and used each time it runs. Crew rates, productivity factor and markups stay under Assumptions.
  - **Guarding against underbidding:** Claude prices every line (its own material price and NECA hours where the price book has none, flagged **AI price — check**), carries the full scope of a commercial electrical bid (branch raceway and wire, boxes and supports, feeders, terminations, grounding, equipment connections, controls, firestopping, temporary power, testing and closeout, permits) with allowances where the plans are thin, and reports a **Scope coverage** checklist (RFIs & notes tab). The **Why this price may be low** panel (Estimate summary) shows what the productivity factor, unpriced lines, missing categories and low-confidence counts are worth. **How hard Claude works** (high / extra high / max) is set per template; extra high is the default. Claude reads the plans and returns the takeoff as **Estimate Import rows** (cost code, area, tag, description, qty, unit…), with the sheet each count came from, a confidence level, RFIs, assumptions and exclusions.
  - Pricing is done by Field Ops, not the model: a line matching a **price book** item uses its cost and labor hours; otherwise Claude's suggested labor unit / material price is used and flagged **AI price — check**; anything left is **Not priced**. Every line can be edited, excluded or overridden; extra lines can be added.
  - **Estimates follow the A4YE electrical quote workbook.** Each line sits on a scope tab (Distribution, Lighting, Power, Fire Alarm, Data & Telecom, Demolition) and a phase (P1 Demolition … P7 Closeout), with the workbook's columns A–P: material $/unit, NECA normal hrs/unit, productivity factor, adjusted hrs, labor $/unit, extensions.
  - **Estimate templates** (Estimating → Estimate templates), one per job type, carry the workbook's Cover & Assumptions: crew classifications with base wage, crew mix and local-hire share; burden; productivity factor (commercial 0.75, residential 1.00), high-repetition factor; overtime threshold, multiplier, premium burden and 5×12 / 6×10 efficiency; per diem; PM rate and hours per week; field indirects (small tools, trucks, lifts, conex, safety, mobilization); contingency, overhead & profit, sales tax; what Claude counts. **Assumptions** on an estimate changes them for that job only.
  - The **Estimate summary** tab is the workbook's Summary: scope categories, hours by phase, the quote build-up (material, straight-time labor at the blended crew rate, per diem, field indirects, project management, contingency, O&P, tax, total), crew size → duration, the 5×12 and 6×10 schedule options, and the labor-productivity downside if the crew only performs at NECA normal. Engineering, testing and preconstruction codes (01xx, 50xx) get no productivity reduction.
  - **EMT fittings** (couplings, connectors, straps, locknuts) are added from conduit footage with the EMT takeoff calculator's ratios (per 100 LF; set screw or compression), using the price book's SSCPLG-/SSCONN-/CCPLG-/CCONN-/STRAP-/LOCKNUT-<size> items.
  - **Import price list** loads a price-list workbook (e.g. the EMT Conduit Pricing workbook's “EMT Price List” tab: Key, Description, Unit, Material $/Unit, NECA Hrs/Unit, cost code, vendor item #) into the price book, matched by Key, tagged to a vendor.
  - **Workbook (.xlsx)** downloads the estimate as Cover & Assumptions, Summary, one tab per scope and Schedule & Crew, with live formulas.
  - **Proposal letter** builds the bid letter from the estimate in the A4YE proposal layout: letterhead, Re:, opening, plans basis, base bid(s) and optional combined-award credit, validity, closing; then Inclusions by scope (Tag, Description, Qty, Unit — no prices), General Conditions & Clarifications, Exclusions, Clarifications & Assumptions and Proposal Qualifications. Everything is editable, the draft is saved with the estimate, and the standard lists can be saved as the company default. **Print / Save as PDF** gives the letter.
  - **Commercial proposals** (estimates of commercial jobs) follow the company's commercial proposal template: letterhead repeated on every printed page; Re:, greeting, opening; one total line ("The total amount of our bid is $…"); validity and closing; Inclusions grouped by system (Lighting, Branch Power Devices, Distribution, Foodservice / Mechanical / other Equipment Connections, Fire Alarm, Data / Telecom / Low Voltage, Demolition) with a note under each heading (from the takeoff), listing fixtures, devices and equipment (raceway, wire and feeder lines can be shown with a tick); General Conditions & Clarifications, Exclusions, Clarifications & Assumptions with the change-order unit-rate table, Proposal Qualifications (the tax line follows the estimate), Terms and Acceptance, the client acknowledgment lines, and "Sincerely" with the signer and signature image.
  - **Standard text & template** (on a commercial proposal): **Import from Word (.docx)** reads the company's template — total line, validity, closing, the standard lists, unit rates, terms, acceptance sentence, signer and signature image — into the database for review; lines that name sheets, general notes, spec sections or panels are set aside as job-specific. Nothing from the template is stored in the app's code; the signature is served only to admins and managers.
  - **Use … as the bid value** writes the total quote to the bid. **Copy as Estimate Import rows** / **Download CSV** give columns A–P (phase code = bid # - phase - cost code); once the bid is linked to a commercial project, **Send to project budget** loads them into its cost-code budget.
  - Needs an Anthropic API key (Settings → Integrations → Plan takeoff; stored on the server, never sent to browsers). Runs on Claude Opus 5.5 with Anthropic's automatic fallback if a request is declined; each takeoff shows the tokens it used. Admins and managers only.

## Weekly KPIs (🎯 KPIs)

The A4YE KPI Dashboard sheet, inside Field Ops, with the same people and rules.
- **Setting it up:** admins import it once under **KPIs → Import from sheet**. Download the Google Sheet as .xlsx first. The import reads the Metrics, Settings, Values, Notes, Submissions, Extras, Feed, FeedDetail and Snapshots tabs.
- **Who can use KPIs:** office staff, managers and admins. Technicians can't hold a KPI page or KPI permissions, and the import reports any it skips.
- **Each person fills in their own page.** The import links each page to a Field Ops user by the sheet's `EMAIL_<Name>` settings, and the link can be changed under **KPIs → Targets & set-up**.
- **Permissions:**
  - People with **"KPIs: see everyone's numbers"** (the sheet's `MASTER_VIEWERS`) also see every page and the company **Scorecard**.
  - People with **"KPIs: fill in or correct anyone's page, set targets"** (the sheet's `ADMINS`) can enter any page and edit targets.
  - The import gives both permissions to matching users; they can also be switched per person under **Team**. Admins have both.
- **The week** runs Sunday–Saturday. Pages are due the set number of days after the Saturday (3 = Tuesday 11:59 PM, company time zone). They show as submitted, submitted late, or missing.
- **Rows:**
  - *Manual* rows are typed in.
  - *Auto* rows are worked out from Field Ops records, not Housecall Pro: jobs (commercial projects included), estimates, invoices, payments, the schedule (with moved appointments counted as reschedules), the time clock and purchase orders. Pick the source per row under **KPIs → Targets & set-up → Filled from**.
  - **Start with the week of** (same page) protects history: weeks before it keep what came from the sheet or was typed. Left blank, it starts with the first week Field Ops has records for.
  - A/R ageing and open estimates are rebuilt as of Saturday night. Headcount and inventory can only be read live, so they freeze when the week ends.
  - *Calc* rows work out their formula, including from other pages (`B14/(B4/7)`, `N6*OT_RATE`).
- **Looks and works like the KPI Command Center web app:** Team overview tiles, a coloured bar, Team cards that filter the KPI list, and "click any KPI to see where its number came from". Each person has a page with Save draft / Submit week at the bottom.
- **Status (the web app's rules):** within the yellow band (25%) of a target above zero is yellow; past it is red. A green or yellow number that has moved the wrong way 3 weeks running is red (↘3). **Every yellow or red row needs a Cause and a Fix** before the week can be submitted. A number with no target shows NO TARGET and isn't scored.
- **Where numbers come from:** auto (Snapshots), feed (the Feed tab, with FeedDetail line items), entered, override (replacing an auto/feed number, reason required), calc. An override beats feed, feed beats auto, and auto beats an entered number. Every entry is kept and shown in the drill-down.
- **Extra items:** "Anything else worth reporting?" on each page; each needs an explanation, and they're listed on the Team overview.
- **Auto numbers** (from the sheet's Snapshots and auto values) show a blue *auto* badge. *Replace this number* keeps the automatic one beside yours and asks why you replaced it.
- **Scorecard:** shows who has reported, how many metrics are on, close or off target, headline numbers against the quarter's weekly average, the constraint (the section furthest from target), and every off-target row with its cause and fix.

## Phone notifications

Techs get a phone notice when they're put on a job or visit, when its time changes, or when they're taken off it or it's cancelled.
- **Who gets one:** the person who made the change doesn't. A finished visit, or one already in the past, doesn't notify.
- **One notice per change:** one save that adds someone and moves the time sends them a single "New job" with the new time.
- **Turning it on:** each person does it on their own phone, from **🔔 Notifications** in the menu (techs also get a banner on My Day).
- **Browser and Home Screen app:** standard Web Push with keys the server makes itself, so there's nothing to sign up for. iPhone needs the Home Screen app, iOS 16.4+.
- **Store apps:** need an Apple push key and a Firebase key, entered in **Settings → Push notifications**. See [docs/MOBILE_APPS.md](docs/MOBILE_APPS.md).

## Address lookup

When you type a service address on a customer or location, the app looks it up. It fills in city, state and ZIP, saves the map location, and marks the address **✓ Verified**. Every address field also has a **Map ↗** button that opens Google Maps so you can see the place.

- **Free (default):** uses the US Census address database. It only checks an address once the house number and street are typed, and gives no suggestions while you type.
- **Google (recommended):** under Settings → Address lookup, paste a Google Maps API key with **Places API (New)** enabled. You then get suggestions as you type. The key stays on the server.

## Employee permissions

**Team → click a person** shows permission checkboxes under their role.
- **Office:** turn on or off customers, jobs and schedule, projects, estimates, invoices, purchasing, price book, expenses, timesheets, business reports, accounting, and seeing costs.
- **Manager:** everything Office can do, all switched on to start (accounting included). Also starts with both company-wide KPI permissions. Team, Settings and Import stay admin-only.
- **Technician:** field estimates, seeing costs, daily logs, and clocking into any open project. Technicians never get KPIs.
- **KPIs (office, managers and admins only):** "see everyone's numbers" and "fill in or correct anyone's page". On for managers, off for office until switched on.

Each role starts from sensible defaults; a "custom permissions" tag shows who differs. Admins always have everything, and Team, Settings and Import stay admin-only.

People without **See costs** never receive costs, wages or margins from the server. When they edit an estimate, the hidden costs are kept.

## Commercial projects

Tick **Commercial project** when booking a job, or use **Projects → + New project**. That adds a project manager, a foreman, start and target-completion dates, and a site contact.

The **Project** tab on the job shows:
- % complete, labor hours vs budget, contract and billed-to-date, and over/under-billing.
- **Progress by cost code.** The PM or the foreman enters % complete for each code. The page then works out earned hours, productivity (earned ÷ used) and forecast hours at completion.
- Crew on site today, hours by week, and **daily logs** (work performed, delays, safety, visitors, deliveries). Each log also shows that day's time clock hours.

The **Projects** page lists every open project with flags:
- forecast over budget;
- a cost code that has used up its hours;
- past the target completion date;
- under-billed;
- crew on site but no daily log.

**Time clock on projects:**
- Crews can clock in on any open project (each person's permission controls this).
- A cost code is required, and the project's budgeted codes are listed first. Both are switchable under Settings → Commercial projects.
- To load your cost-code list from another system, use **Import Data → Cost codes**.

## Commercial dashboard

**Commercial Projects** opens a company roll-up of every project, laid out like the A4YE Master Tracker.
- **Executive summary.**
- **Contract & margin:** revised contract, projected cost (EAC), and projected margin vs the target (Settings, default 18%).
- **Cost:** budget, actual, open commitments (POs sent, not yet received) and cost variance.
- **Performance:**
  - CPI = earned ÷ actual cost;
  - SPI = earned ÷ planned hours, on a straight line from start to target completion;
  - labor hours and crew on site.
- **Billing:** billed, cash, retainage, over/under.
- **Exceptions & watch list, job snapshot, hours by week, and budget vs actual by division.**

People without **See costs** get the hours-and-progress version. Export CSV and Print are on the page.

## Project workbook (A4YE job tracker format)

A commercial project's **Project** tab is laid out like `A4YE_Job_TEMPLATE.xlsx`, with sheets in the same order. Column names, dropdown lists and formulas follow the workbook.

| Sheet | What it does |
|---|---|
| Dashboard | KPIs, flags, team, crew today, hours by week |
| Estimate Import | Paste the quote workbook's scope-tab rows (columns A–P, straight from Excel) or load a CSV. The cost code comes from the Phase Code (`LAB-P2-0810-L`, `P2-0810-L`, `0810-L`, `0810`); subtotal and no-quantity rows are skipped; lines without a usable code can be given one in the preview. Hours = qty × adjusted hrs/unit (or NECA hrs × production factor); material = Ext. Material or qty × material/unit; cost types S/E/O budget as "other". **Replace** makes the quote the whole budget (keeping % complete already reported on codes that stay); **Add** stacks an addendum or another tab. Every imported line is kept (the workbook's Import Quote tab), and any import can be undone. Codes that came from a quote are priced at the quote's own labor $/hour, so the project's budget cost equals the quote total (checked against a real job workbook: 239 lines, 38 codes, $178,707.56 to the cent); hand-entered codes use the crew rate, falling back to the **blended burdened field rate** in Settings → Commercial projects. |
| Schedule | Tasks (T-001…) with phase, area, cost code, start/finish, predecessor, budget hours and % complete, drawn as a weekly Gantt. Work days (Mon–Fri), planned % against an as-of date, earned and planned hours, actual hours from the time clock on the task's code (or phase) between its dates, SPI, float to the next task, and the workbook's statuses (Not Started, In Progress, Late Start, Late, Update %, Complete, On Hold, By Others). Weekly planned hours, planned crew and actual hours run under the Gantt, and weeks over the max crew are flagged. Includes a 3-week look-ahead filter, **Build from budget** (one task per budgeted labor code), and CSV/print. The crew on the job can post % complete from the field. |
| Manpower Loading | Per week: planned hours and crew from the Schedule, actual hours and crew from the time clock, variance, cumulative planned/actual, Foreman / Journeyman / Apprentice / Office hours, OT hours and OT %, people on site, and weeks over the max crew. Class is the job's foreman, else the employee's title (Apprentice…, Foreman…, office staff = Office, everyone else Journeyman). OT is hours past the weekly overtime threshold across all of that person's jobs, the same rule payroll uses. The Commercial Projects dashboard rolls every open project into a company manpower view (4 weeks back, 16 ahead) with planned crew by project. |
| Weekly History | One row per week since the job started, cumulative through each week ending: revised contract and budget (approved COs by approval date), % complete, PV / EV / AC, open commitments, CPI, planned / earned / actual hours, SPI, projected cost and margin, billed, cash received, pending COs, open RFIs and safety items, crew. Drawn as an earned-value S-curve (hours instead of dollars for anyone without cost access). The current % complete is recorded automatically every week (hourly, so the week's last value sticks); the PM can type over any past week with what was actually reported, and the automatic capture never overwrites a typed week. Weeks before tracking started fall back to hours burned ÷ budget hours, like the workbook. |
| Bi-Weekly Report | The workbook's printable report for a 14-day period: project information, financial summary, cost by phase (P0–P9), production this period (hours, OT, labor and material cost, average crew, peak planned crew ahead), two-week look-ahead, open milestones, RFIs, unexecuted change orders, open safety items, and a typed narrative (progress, plan, issues, decisions needed, notes). **GC copy** leaves out budget, cost, commitments, margin, CPI, cost by phase and CO cost, and is the only version shown to office users without cost access. **Issue** freezes the numbers so a sent report never changes; an admin can reopen it. **Email to GC** (or **Issue & email**) sends the GC contact a short summary (% complete, SPI, contract, billed, pending COs, decisions needed) and a link to the issued report; the link only ever shows the GC copy, needs no login, and stops working if the report is reopened. The sheet shows who it went to and when the GC first opened it. Without SMTP set up, the send is recorded and the link copied for you to paste into your own email. Saved reports are listed by period. Print / PDF always prints light. |
| Cost Codes | Budget vs actual and % complete by code: earned hours, productivity, forecast |
| Labor Log | Every punch on the project, from the A4Y Time Clock sync and the Field Ops clock |
| Cost Log | POs (committed until received), material used, expenses and vendor bills, with open commitments |
| Change Orders | Priced like the workbook: labor hrs × blended rate + material (+ tax) + equipment + sub + other, then overhead % and profit % (Settings defaults 18% / 15% / 6%). Type, status, days added, days open. Approved COs add to the contract and to the SOV. |
| SOV | A mobilization line, one line per budgeted division, and one per approved CO. Suggested values come from the budget, with overrides; it warns when the total doesn't equal the contract. |
| Billing Entry | For each application: work completed this period and materials stored, by SOV line |
| Pay Apps | Work to date, stored, gross, retainage to date and per app, net due, paid, days to pay, open balance. **Invoice** creates the invoice and locks the app. |
| Pay App (G702/G703) | Printable Application and Certificate for Payment with its continuation sheet |
| RFI-Submittal / Safety-Quality / Milestones | The workbook's logs, with IDs (RFI-001, SQ-001, M-001), days open/late, and overdue / late / at-risk status |
| Daily Logs | Work performed, delays, safety, visitors, deliveries, plus that day's time clock hours |

Crew planning settings (hours/day, days/week, crew availability, max crew) are under Settings → Commercial projects; the defaults match the workbook's Cover tab (8 / 5 / 0.92 / 10).

Overdue RFIs and safety items, late or late-starting schedule tasks, late milestones, and pay apps unpaid after 45 days show as project flags and on the commercial dashboard.

A project bills **either** by pay application **or** from the job's Billing tab, never both, so work can't be billed twice.

Every tab of the job template now has a sheet here. Two shortcuts to know about: schedule float only measures the gap to the next task that names this one as its predecessor (no full critical path), and a late predecessor doesn't move the tasks after it.

### Importing an existing job workbook

**Commercial Projects → Import job workbook** (admins) takes a job's whole A4YE workbook (.xlsx) and turns it into a project. A preview shows what each tab becomes before anything is saved.

| Tab | Becomes |
|---|---|
| Job Register, Cover | The project: customer (matched by name or added), address, PM and foreman (matched to Team by name), dates, contract, retainage, mobilization %, time clock job #, Gantt start; the Cover's blended rate fills Settings if it's empty |
| Estimate Import, Cost Codes | The cost-code budget (same parser as the Estimate Import sheet) and any typed % complete |
| Schedule, Milestones, RFI-Submittal Log, Safety-Quality Log | Those logs. `T-###` predecessors link up; other Pred. text (e.g. the GC's schedule line) is kept in the task notes |
| Change Orders | Change-order estimates at the log's exact sell price and cost; approved ones add to the contract |
| SOV, Billing Entry, Pay Apps | The schedule of values and every pay application with its per-line work and stored materials. The G702 math is re-checked against the workbook's gross. Optionally creates each app's invoice and recorded payment |
| Labor Log | Time entries through the A4Y Time Clock sync rules: Entry ID is the key, so rows already synced are updated, never duplicated; people the app doesn't know are added as inactive techs |
| Cost Log | Invoiced costs as job expenses; open commitments as purchase orders (grouped by vendor and PO #) |
| Weekly History | % complete only for weeks where it was typed — formula weeks are hours proxies, not reported progress |

Dashboard, Manpower Loading, Billing Worksheet, Pay App Summary, Import Quote, the Bi-Weekly Report copies and Rollup are calculated, so the app rebuilds them. **The Employee List tab is never read.**

- **Each tab is read only over the rows the template's own formulas read** (Change Orders 6–125, SOV 6–65, Schedule 6–155…), so the status summaries and totals under the logs are never taken for entries.
- **The job # is checked.** It links the project to the A4Y Time Clock, so the preview flags a job # that equals the contract amount or differs from the number in the file name, and lets you correct it before importing.
- **Re-running is safe.** If a project with that time clock job # exists, the import goes into it, fills only blank job fields, and skips any section the project already has.
- **Accounting.** Imported invoices, payments and costs count on the project (billed to date, cash, cost to date) but are **not posted to Accounting** unless you tick that box, since they're normally already in your books.
- **Checked on three real job files** (up to 239 quote lines, 98 tasks, 24 RFIs, 46 labor punches, pay apps): revised contract, budget cost, labor hours and the pay app's gross / retainage / net due all matched the workbook.
- The .xlsx reader is built in (no add-on library); it reads the values Excel last calculated and knows which cells were formulas.

## A4Y Time Clock and cost codes

The cost code list is the A4YE list (0110 Estimating & Takeoff … 9060 Overtime Premium, divisions 01–90). The time clock's `0810-L` is code `0810` here.

Time entries sync from the A4Y Time Clock Google Sheet, either hourly through a small read-only export script or by CSV upload. They're matched by Entry ID, employee, **Time clock job #** and cost code. See [docs/TIMECLOCK.md](docs/TIMECLOCK.md).

## Estimate visits

A visit on the schedule can be for a job **or for an estimate**: a walkthrough to see the work and price it, before any job exists.

- **Book one from the schedule:** **+ Estimate visit** on the tech board (or click an empty slot and pick "An estimate walkthrough"). Choose the customer, address, what they want priced, the time and the tech. A draft estimate is created with the visit.
- **Or from the estimate:** **+ Schedule visit** in the estimate's *Site visits* card. An estimate can have several visits.
- **On the schedule:** estimate visits show on the tech board, week view, dispatch list and dashboard with a dashed outline and an **EST** tag, and open the estimate when clicked. They count toward a tech's booked hours and in double-booking warnings, but don't change any job's schedule or crew.
- **For the tech:** the tech booked on the visit sees it in their day, can open that estimate and build the price on site (the usual field-estimating guardrails apply), and En route / On site / Done clock their travel and site time against the visit.
- **Cancelling** an estimate cancels its upcoming visits; finished visits stay as they were.

### Appointment confirmation emails

Any visit (job or estimate walkthrough) can email the customer a confirmation with a calendar invite (.ics) attached. Booking a visit offers it with a checkbox, and an existing visit has **Email confirmation / Resend** in its form. You see the exact email before it goes and can change the address or add a line.

- Times are written in the **company time zone** (Settings → A4Y Time Clock → Company time zone, default America/Boise), whatever time zone the server runs in.
- **Dispatch notes are never included.** The email has the date and time, address, what the visit is for, and the first names of who's coming, plus your phone number. Replies go to the company email in Settings.
- **Moving a confirmed visit** asks whether to email the new time, and the visit shows ⚠✉ on the board until the customer is told. The calendar invite keeps the same ID, so it moves the event in their calendar instead of adding a second one.
- **Deleting a confirmed visit** offers to send a cancellation notice.
- Without email set up on the server, the send is recorded and the text is copied so you can paste it into a text message.

## Multi-day visits (commercial crews)

A visit can span several days, e.g. a crew 7:00–3:30 from the 16th to the 20th. It is one crew window repeated each day.

- **Shown every day it covers:** on the week view, day board and dispatch, at that day's hours, tagged *Day 3/5*. The week view also has a **Commercial projects this week** strip. It shows who is on each project each day, highlights weekdays with no crew, and has **+ Crew** to book one.
- **Change one day:** open a day of the visit and choose *Only Wednesday* to change that day's crew or hours. On the week view you can also drag the day's chip onto another tech; on the day board, drag or resize it. That day becomes its own visit, and the days before and after keep their crew and hours. Time already clocked stays with the day it was clocked on.
- **Take a day off** (a weekend, a day the site is shut) from the same form. It's refused if someone already clocked time that day.
- Choose *Every day of the visit* to change the whole visit as before.
- A customer who was emailed a confirmation is only flagged when a day's **hours** change, not its crew.

## Schedule blocks

The tech board, week view and dispatch list group people by the **Title** on their Team profile:
- Masters & foremen
- Journeymen
- Apprentices
- Other staff

Spellings like "Journeyman Electrician", "JW", "1st-year apprentice" and "Helper" are recognized. To move someone to a different block, change their title.

## En route and the customer's "on the way" email

When a tech taps **🚚 En route** (My Day, or the office on Dispatch), the app asks **about how many minutes away?** It prefills a rough drive time from the phone's location to the service address: straight-line distance × 1.35 at 35 mph. Then it:
- starts travel time, as before;
- keeps the arrival time on the visit, shown on Dispatch and the tech's day;
- emails the customer "*Dana from All 4 You Electrical is on the way … should arrive at about 10:45 AM*". The wording is the **Technician on the way** template under Settings → Email templates.

The tech can untick the email. **Settings → Scheduling & accounting defaults → Email the customer when a tech taps En route** turns it off for everyone. If the customer wasn't told, the app says why: no email on file, or email not set up. Text messages are not built: they need a Twilio phone number registered for business texting (A2P 10DLC).

## Pick lists from the field

Techs can **ask for material**: Pick Lists → **+ Ask for material**, or the job's **Pick lists** tab.
- This starts a pick list on a job they're on, optionally filled from the approved estimate.
- They add price-book or typed items, and can change or remove **their own** lines until picking starts.
- Costs they type are ignored. The office sees who asked, and picks, sends to Ply, or makes a PO for shortages as usual.

## Time off & attendance

**Schedule → 🌴 Time off / attendance** (Week view or Tech board; or double-click a person's day on the Week view) logs:
- **Time off** (planned; paid or unpaid; a range of days, or hours of one day)
- **Called in sick** (paid or not)
- **Absent** (tick **No call / no show** when they didn't call)
- **In late** and **Left early** (minutes)

What happens with each entry:
- **On the schedule:** entries show as chips on the person's days, and full days off are shaded. Office staff with an entry get a row too.
- **Booking warnings:**
  - Booking someone on a day off warns you, the same way a double-booking does.
  - Adding time off over days they're already booked lists those jobs so you can move them.
- **Who sees what:** techs see their own entries on their schedule, without the office's note. Only office staff, managers and admins add or change entries.
- **KPI tracker:** **KPIs → Targets & set-up → + Add a KPI** adds a row filled automatically from attendance. The available numbers are:
  - days of time off
  - sick days
  - absent days
  - no-call days
  - unplanned days out (sick + absent)
  - times late
  - minutes late
  - times left early

  Each counts all employees for the week. Multi-day ranges count weekdays; a part day counts as hours ÷ 8. Click the number to see who and when.
- **Payroll:** scheduled time off doesn't put PTO hours on the time clock or payroll. Record paid hours there as before.

## Not built yet (be aware before you rely on it)

- **Online card payments.** Invoices show how to pay but have no Stripe/Square checkout. Payments are recorded manually.
- **Live bank feeds.** Statements are imported as files (CSV, OFX, QFX). Pulling transactions in automatically needs a bank-data aggregator such as Plaid: a paid account, API keys and their approval. Imported transactions already flow into the same matching, so a feed can be added later without changing the review or reconcile steps.
- **Payroll tax filing.** Labor is accrued at loaded cost and you record what payroll actually paid. Gross-to-net, tax deposits and W-2s still need a payroll provider.
- **Ply, live.** The connector follows Ply's published API (OpenAPI spec at docs.getply.com) and is tested against a stand-in that enforces it, but hasn't run against a live Ply account yet. Try it on one pick list and one PO first.
- **Automatic call and inbox capture.** Calls and replies are logged by hand on the Emails & calls card; there's no phone system or mailbox connection.
- **SMS and offline mode.** The tech view is mobile-friendly but needs a signal.
- **Excel files and direct connections to the old system.** Imports take CSV files (the project Estimate Import also takes rows pasted straight from Excel). Save other Excel sheets as CSV first. There's no live connection to ServiceTitan or Successware.
- **Multi-company and audit log.** It's single-company, and edits are not versioned.
- **Hosting is on you.** `deploy/` sets up a DigitalOcean server (see docs/DEPLOY.md), but you own the server, its bills and its backups. Test a restore before you rely on it.

## Development

```bash
npm run dev       # restarts on change
npm test          # API + calculation tests
```

- `server/db.js` — schema and helpers
- `server/calc.js` — totals, job costing, cost-code and operational report math
- `server/accounting.js` — general ledger posting rules and financial statements
- `server/routes_ext.js` — visits/dispatch, cost codes, purchasing, pick lists, accounting API, Ply routes
- `server/ply.js` — Ply Public API connector (jobs, pick lists, POs, catalog/stock, status sync)
- `server/banking.js` / `server/routes_bank.js` — statement parsing, matching, rules, reconciliation
- `server/routes_field.js` / `public/field.js` — photos & files, checklists, sign-off, GPS, equipment
- `server/billing.js` / `public/billing.js` — quoted-price vs time & material billing, WIP report
- `server/tech_estimates.js` — tech estimate routes, price guardrails, office review
- `server/importer.js` / `server/routes_import.js` / `public/import.js` — CSV and photo import, column matching, test runs, undo
- `deploy/` — server setup, update, backup and restore scripts; `scripts/backup.js` — safe live database copy (`npm run backup`)
- `server/migrations.js` — versioned schema upgrades (existing databases upgrade automatically on start)
- `server/app.js` — REST API and role checks
- `public/app.js` — single-page UI (vanilla JS)
- `public/ext.js` — tech board, week and dispatch views, purchasing, accounting, settings additions, branding
- `public/doc.html` — customer-facing estimate/invoice page
