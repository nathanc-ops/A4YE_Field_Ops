# A4YE Field Ops

Field service management for residential and commercial electrical contractors: booking and dispatch, estimates with online approval, invoicing, time clock, material tracking, job costing, and P&L reporting. It's self-hosted and runs as one Node process with a SQLite file. No subscription, no build step.

## Quick start

```bash
npm install
npm run seed      # optional: load demo data (admin@example.com / password123)
npm start         # http://localhost:3000
```

If you skip the seed, the first visit asks you to create the owner (admin) account.

Requires **Node 22.13+**. It uses Node's built-in `node:sqlite`, so there are no native modules to compile. Data lives in `data/fieldops.db`; set `DB_PATH` to put it somewhere else. **Back up that file.** It is your entire business record.

## What it does

| Area | Features |
|---|---|
| **Booking & dispatch** | Weekly dispatch board by tech. Drag jobs between techs and days, and drag unscheduled jobs onto the board. Supports priorities and emergencies, multi-tech jobs and job types. |
| **Customers** | Residential and commercial, with multiple service locations per customer. Tracks service size, panel info, access notes, tax-exempt status, custom payment terms and lead source. |
| **Estimates** | Line-item editor with price book lookup and your cost/margin shown live (internal only). Sends a link where the customer views, e-signs and approves or declines. Approved estimates convert to a job (budget hours and materials are filled in from the price book) or to an invoice. |
| **Invoices** | Build from the approved estimate, or from logged labor (each tech's bill rate) plus billable materials. Partial payments, void, overdue flags and a customer-facing invoice page. |
| **Time clock** | Techs clock in on a job from their phone. Switching jobs auto-closes the last entry. Time types: job, travel, shop, training, PTO. The office can add or edit entries. Every entry snapshots the wage and loaded cost at the time it's logged. |
| **Materials & inventory** | Techs log materials per job. Truck/shop stock decrements on-hand quantity, and low-stock alerts are driven by reorder points. |
| **Permits & inspections** | Permit number, AHJ, status (applied → issued → rough → final → passed), inspection dates and fees. Fees count as job cost. |
| **Service agreements** | Maintenance plans and memberships, annual recurring revenue, next-visit tracking and one-click visit job creation. |
| **Expenses** | Expenses tied to a job are job cost (subs, rentals, supply runs). Untied expenses are overhead. |
| **Reports** | P&L (revenue by segment → COGS → gross profit → overhead → net), 12-month trend, job costing (budget vs actual, margin), hours on job, payroll with weekly overtime, tech performance (utilization, revenue/hour), A/R aging, estimate close rate and lead-source ROI. CSV export and print on all of them. |
| **Roles** | **Admin**: everything. **Office**: everything except team and settings. **Tech**: their own jobs, the clock and material logging. Techs never see costs, wages or financials. |

### How the numbers are calculated

- **Labor cost** = hours × loaded rate, where the loaded rate is wage × (1 + burden %). Set each employee's wage and burden (payroll taxes, workers' comp, benefits) on the Team page. Wrong burden percentages make every margin wrong.
- **Revenue** is accrual-basis. It counts sent, partial and paid invoices by issue date and excludes sales tax.
- **COGS** = direct labor on jobs + materials used + permit fees + job-tied expenses.
- **Overhead** = untied expenses + non-billable labor (shop, training, PTO).
- **Overtime** = hours over the weekly threshold (Mon–Sun) at the multiplier you set in Settings.

## Email

Without SMTP settings, **Send** marks the document as sent and copies the customer link so you can text or email it yourself. To send directly:

```bash
SMTP_HOST=smtp.yourprovider.com SMTP_PORT=587 SMTP_USER=... SMTP_PASS=... SMTP_FROM="All 4 You Electrical <office@yourdomain.com>" \
PUBLIC_URL=https://ops.yourdomain.com npm start
```

`PUBLIC_URL` controls the links in emails, so set it to the address customers can actually reach.

## Not built yet (be aware before you rely on it)

- **Online card payments.** Invoices show how to pay but have no Stripe/Square checkout. Payments are recorded manually.
- **Accounting sync.** Nothing pushes to QuickBooks or Xero. Use the CSV exports, or have your bookkeeper key them in.
- **SMS, GPS tracking, photo uploads, offline mode.** The tech view is mobile-friendly but needs a signal.
- **Multi-company and audit log.** It's single-company, and edits are not versioned.
- **Hosting & backups.** You need to run this somewhere (a small VPS or office PC), put HTTPS in front of it (e.g. Caddy), and back up `data/fieldops.db` nightly.

## Development

```bash
npm run dev       # restarts on change
npm test          # API + calculation tests
```

- `server/db.js` — schema and helpers
- `server/calc.js` — totals, job costing and all report math
- `server/app.js` — REST API and role checks
- `public/app.js` — single-page UI (vanilla JS)
- `public/doc.html` — customer-facing estimate/invoice page
