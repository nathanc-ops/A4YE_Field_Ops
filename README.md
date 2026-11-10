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
| **Ply** | Sends POs, pick lists and jobs with cost codes to Ply; pulls Ply's items and stock; accepts signed webhooks for receipts, vendor invoices, inventory and pick progress. See [docs/PLY_INTEGRATION.md](docs/PLY_INTEGRATION.md). |
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

Without SMTP settings, **Send** marks the document as sent and copies the customer link so you can text or email it yourself. To send directly:

```bash
SMTP_HOST=smtp.yourprovider.com SMTP_PORT=587 SMTP_USER=... SMTP_PASS=... SMTP_FROM="All 4 You Electrical <office@yourdomain.com>" \
PUBLIC_URL=https://ops.yourdomain.com npm start
```

`PUBLIC_URL` controls the links in emails, so set it to the address customers can actually reach.

## Address lookup

When you type a service address on a customer or location, the app looks it up. It fills in city, state and ZIP, saves the map location, and marks the address **✓ Verified**. Every address field also has a **Map ↗** button that opens Google Maps so you can see the place.

- **Free (default):** uses the US Census address database. It only checks an address once the house number and street are typed, and gives no suggestions while you type.
- **Google (recommended):** under Settings → Address lookup, paste a Google Maps API key with **Places API (New)** enabled. You then get suggestions as you type. The key stays on the server.

## Employee permissions

**Team → click a person** shows permission checkboxes under their role.
- **Office:** turn on or off customers, jobs and schedule, projects, estimates, invoices, purchasing, price book, expenses, timesheets, business reports, accounting, and seeing costs.
- **Technician:** field estimates, seeing costs, daily logs, and clocking into any open project.

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

## A4Y Time Clock and cost codes

The cost code list is the A4YE list (0110 Estimating & Takeoff … 9060 Overtime Premium, divisions 01–90). The time clock's `0810-L` is code `0810` here.

Time entries sync from the A4Y Time Clock Google Sheet, either hourly through a small read-only export script or by CSV upload. They're matched by Entry ID, employee, **Time clock job #** and cost code. See [docs/TIMECLOCK.md](docs/TIMECLOCK.md).

## Schedule blocks

The tech board, week view and dispatch list group people by the **Title** on their Team profile:
- Masters & foremen
- Journeymen
- Apprentices
- Other staff

Spellings like "Journeyman Electrician", "JW", "1st-year apprentice" and "Helper" are recognized. To move someone to a different block, change their title.

## Not built yet (be aware before you rely on it)

- **Online card payments.** Invoices show how to pay but have no Stripe/Square checkout. Payments are recorded manually.
- **Live bank feeds.** Statements are imported as files (CSV, OFX, QFX). Pulling transactions in automatically needs a bank-data aggregator such as Plaid: a paid account, API keys and their approval. Imported transactions already flow into the same matching, so a feed can be added later without changing the review or reconcile steps.
- **Payroll tax filing.** Labor is accrued at loaded cost and you record what payroll actually paid. Gross-to-net, tax deposits and W-2s still need a payroll provider.
- **Ply's real API.** The connector is built and tested against a stand-in Ply API, but Ply doesn't publish its specification. Confirm endpoints and field names with Ply before relying on it (see docs/PLY_INTEGRATION.md).
- **SMS and offline mode.** The tech view is mobile-friendly but needs a signal.
- **Excel files and direct connections to the old system.** Imports take CSV files. Save Excel sheets as CSV first. There's no live connection to ServiceTitan or Successware.
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
- `server/routes_ext.js` — visits/dispatch, cost codes, purchasing, pick lists, accounting API, Ply webhook
- `server/ply.js` — Ply connector (payload mapping lives here)
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
