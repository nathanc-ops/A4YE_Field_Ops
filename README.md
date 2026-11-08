# A4YE Field Ops

Field service management for residential and commercial electrical contractors. It covers an hourly tech board and dispatch, estimates with online approval, invoicing, a time clock, cost-coded job costing, purchasing and pick lists (with a Ply connector), and built-in double-entry accounting. It's self-hosted and runs as one Node process with a SQLite file. No subscription, no build step.

## Quick start

```bash
npm install
npm run seed      # optional: load demo data (admin@example.com / password123)
npm start         # http://localhost:3000
```

If you skip the seed, the first visit asks you to create the owner (admin) account.

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
| **Quoted-price jobs** | The contract equals the approved quote plus **change orders the customer signs online** (an estimate created on a quoted job becomes a change order automatically). Bill by deposit, **schedule of values** (milestone templates: 30/40/30, 50/50, 5-phase commercial), **% complete**, a set amount, or **final**. If the job is one-shot, the final invoice shows the quote's line items. Optional **retainage** is withheld on each progress bill and released on the final. You can't bill past the contract; extra work needs a change order. Shows earned vs billed (over/under-billing) and projected profit. Time and materials are tracked for costing only. |
| **Time & material jobs** | Labor at the job's rate or each tech's bill rate, **rounded up to the billing increment** (15 min default), with travel optional. Materials at price-book price or **cost + markup**. Billable expenses (rentals, etc.) at markup, plus an optional **trip charge**. Optional **not-to-exceed** cap: billing past it requires confirmation. Bill everything or **through a date** (weekly billing on long jobs). Each hour, part and expense is billed **once**: it's stamped with its invoice and **locked**, and voiding the invoice releases it to be billed again. |
| **WIP & unbilled report** | Quoted jobs: contract, cost to date, % complete, earned, billed, over/under-billed, retainage and projected profit (the work-in-progress schedule banks and bonding companies ask for). T&M jobs: unbilled hours and dollars and room left under the NTE. Exports to CSV. |
| **Cost codes** | 16 electrical phase codes by default (Rough-in, Service & Distribution, Trim, Lighting, EV/Generators, Permits, …), editable in Settings. Codes apply to time (picked at clock-in), materials, PO and pick-list lines, estimate lines, bills and expenses. Converting an approved estimate builds each job's **budget by cost code** (hours and material), and every job has a budget-vs-actual tab. |
| **Purchasing** | Vendors, purchase orders (to a job or into shop stock) and receiving. Job deliveries become job materials at PO cost; shop deliveries add stock at weighted-average cost. One click turns a PO into a vendor bill and records any price variance. Also does reorders from low stock and POs for pick-list shortages. |
| **Pick lists** | Built from the approved estimate or by hand, picked on a phone or tablet. Completing a pick charges the materials to the job from stock. |
| **Ply** | Sends POs, pick lists and jobs with cost codes to Ply; pulls Ply's items and stock; accepts signed webhooks for receipts, vendor invoices, inventory and pick progress. See [docs/PLY_INTEGRATION.md](docs/PLY_INTEGRATION.md). |
| **Accounting (admin)** | Double-entry general ledger and chart of accounts set up for an electrical contractor. Invoices, payments, vendor bills, bill payments, expenses, stock usage and weekly labor accruals post **automatically**. Also: manual journal entries, A/P with bill payments, account registers, income statement, balance sheet, trial balance, A/P aging, recording payroll payments and closing the books (which locks the period). |
| **Banking (admin)** | Import bank and credit card statements (CSV, OFX, QFX — every bank exports these; re-importing the same file never duplicates). Lines that match something already in the books (customer payments, bill payments, expenses, transfers) are **matched automatically**. For the rest: **Add expense** (pre-filled by categorization rules like SHELL → Fuel; lands in Expenses and job costing), **Apply** a deposit to the open invoice with that balance, record a transfer between your own accounts, or exclude. **Reconcile** against each statement: check off cleared items until the difference is $0.00, then finish; reconciled transactions are locked until the reconciliation is undone. |
| **Branding** | All 4 You Electrical theme out of the box: logo red #FA001C (buttons #E0001A for readable white text) on black, Barlow / Barlow Condensed type, the A4 logo and the "Powered by people. Built All 4 You." sign-in screen. Colors, logo and tagline can be changed in Settings → Branding and apply to the app and to the estimate/invoice pages customers see. Button and link colors are adjusted automatically to keep text readable in light and dark mode. **Dark mode is the default**; each person can choose Light or Match device in Settings → Appearance (saved per device). Customer estimates and invoices always print on white. |
| **Reports** | P&L (revenue by segment → COGS → gross profit → overhead → net), 12-month trend, job costing (budget vs actual, margin), hours on job, payroll with weekly overtime, tech performance (utilization, revenue/hour), A/R aging, estimate close rate and lead-source ROI. CSV export and print on all of them. |
| **Roles** | **Admin**: everything. **Office**: everything except team and settings. **Tech**: their own jobs, the clock and material logging. Techs never see costs, wages or financials. |

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

## Email

Without SMTP settings, **Send** marks the document as sent and copies the customer link so you can text or email it yourself. To send directly:

```bash
SMTP_HOST=smtp.yourprovider.com SMTP_PORT=587 SMTP_USER=... SMTP_PASS=... SMTP_FROM="All 4 You Electrical <office@yourdomain.com>" \
PUBLIC_URL=https://ops.yourdomain.com npm start
```

`PUBLIC_URL` controls the links in emails, so set it to the address customers can actually reach.

## Not built yet (be aware before you rely on it)

- **Online card payments.** Invoices show how to pay but have no Stripe/Square checkout. Payments are recorded manually.
- **Live bank feeds.** Statements are imported as files (CSV, OFX, QFX). Pulling transactions in automatically needs a bank-data aggregator such as Plaid: a paid account, API keys and their approval. Imported transactions already flow into the same matching, so a feed can be added later without changing the review or reconcile steps.
- **Payroll tax filing.** Labor is accrued at loaded cost and you record what payroll actually paid. Gross-to-net, tax deposits and W-2s still need a payroll provider.
- **Ply's real API.** The connector is built and tested against a stand-in Ply API, but Ply doesn't publish its specification. Confirm endpoints and field names with Ply before relying on it (see docs/PLY_INTEGRATION.md).
- **SMS, GPS tracking, photo uploads, offline mode.** The tech view is mobile-friendly but needs a signal.
- **Multi-company and audit log.** It's single-company, and edits are not versioned.
- **Hosting & backups.** You need to run this somewhere (a small VPS or office PC), put HTTPS in front of it (e.g. Caddy), and back up `data/fieldops.db` nightly.

## Development

```bash
npm run dev       # restarts on change
npm test          # API + calculation tests
```

- `server/db.js` — schema and helpers
- `server/calc.js` — totals, job costing, cost-code and operational report math
- `server/accounting.js` — general ledger posting rules and financial statements
- `server/routes_ext.js` — visits/dispatch, cost codes, purchasing, pick lists, accounting API, Ply webhook
- `server/ply.js` — Ply connector (payload mapping lives here)
- `server/banking.js` / `server/routes_bank.js` — statement parsing, matching, rules, reconciliation
- `server/routes_field.js` / `public/field.js` — photos & files, checklists, sign-off, GPS, equipment
- `server/billing.js` / `public/billing.js` — quoted-price vs time & material billing, WIP report
- `server/migrations.js` — versioned schema upgrades (existing databases upgrade automatically on start)
- `server/app.js` — REST API and role checks
- `public/app.js` — single-page UI (vanilla JS)
- `public/ext.js` — tech board, week and dispatch views, purchasing, accounting, settings additions, branding
- `public/doc.html` — customer-facing estimate/invoice page
