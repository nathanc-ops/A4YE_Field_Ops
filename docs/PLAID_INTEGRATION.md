# Plaid bank feeds

Bank and credit card transactions come into **Accounting → Banking** every hour on their own, instead of downloading and importing statements. They land in the same "To review" list as an imported statement, so auto-match, **Add expense**, categorization rules and reconciliation all work the same way.

## What you need

1. **A Plaid account** at [dashboard.plaid.com](https://dashboard.plaid.com), signed up as the business.
   - **Sandbox** keys work right away, with fake banks. Use them to try it out.
   - **Production** (real banks) needs Plaid to approve you: company profile, the security questionnaire, and access to the **Transactions** product. Plaid bills per connected account per month. Check their current pricing before you connect.
2. **Field Ops online over HTTPS** (see [DEPLOY.md](DEPLOY.md)) if any of your banks use OAuth. Chase, Capital One, Wells Fargo, Bank of America and others send you to their own website to sign in. Smaller banks and credit unions usually sign in inside Plaid's window and work on any copy of the app.

## Setup

1. In Plaid: **Developers → Keys**. Copy the **client ID** and the **secret** for the environment you're using (sandbox and production have different secrets).
2. In Field Ops: **Settings → Integrations – Plaid**. Paste the client ID and secret, pick the environment, and Save. The secret stays on the server; browsers never see it.
   - You can set `PLAID_CLIENT_ID`, `PLAID_SECRET` and `PLAID_ENV` as server environment variables instead. They take priority over Settings.
3. For OAuth banks: in Plaid, under **Developers → API → Allowed redirect URIs**, add `https://ops.all4youelectrical.com/plaid-oauth.html` (your address). Paste the same address in **OAuth redirect URI** in Settings.
4. **Accounting → Banking → Connect a bank.** Plaid's window opens. Whoever holds the bank login signs in there. In sandbox, use `user_good` / `pass_good`.
5. **Choose where each account goes**: each checking, savings or card account feeds one bank or credit card account in your chart of accounts, or "Don't import". Set **Bring in from** to the day after the last statement you imported by hand (that's the suggested date), so nothing comes in twice. Save & sync.

## How it behaves

- **Hourly sync** for every connected bank (turn it off in Settings), plus **Sync now** on the Banking tab.
- **Only settled transactions.** Pending charges are skipped and come in once they post.
- **Signs:** money out is negative and money in is positive, for both bank and card accounts. A card purchase is money out and a card payment is money in, the same as an imported statement.
- **Nothing is posted to the ledger by the feed itself.** Lines wait in To review until they're matched to something already in the books, turned into an expense, applied to an invoice, or excluded.
- If the bank **changes** a transaction, the line updates only if nobody has acted on it yet. If the bank **removes** one, it disappears only if it's still unreviewed. Matched and reconciled lines are never touched.
- **A bank needs you to sign in again** (password changed, consent expired, typically every 12–24 months for OAuth banks): the bank shows **Sign in again**, and syncing for it pauses until you do. Nothing is lost; it catches up afterward.
- **Disconnect** (✕) removes the connection at Plaid. Lines already brought in stay in your books.
- An account is synced only once **every** account at that bank is mapped or set to "Don't import". That way transactions for an account nobody has mapped yet don't get skipped for good.

## Security

- Bank usernames and passwords go to Plaid, inside Plaid's window. This app never receives them.
- Plaid's **access token** for each bank is stored only in `data/fieldops.db` and is never sent to browsers or written to the activity log. Anyone who has the database file **and** your Plaid secret could read your transactions, so protect backups of `data/` the way you'd protect bank statements.
- Only **Admin** users can see or use bank feeds.
- Never put the Plaid secret in the code or commit it to GitHub. This repository is public.

## Troubleshooting

Settings → Integrations – Plaid → **Recent activity** lists each call to Plaid. Click a row to see Plaid's error code.

| Message | Meaning |
|---|---|
| `INVALID_API_KEYS` | Client ID or secret is wrong, or it's the sandbox secret with Production selected (or the other way round). |
| `ITEM_LOGIN_REQUIRED` | The bank wants the account holder to sign in again. Click **Sign in again**. |
| `INVALID_FIELD … redirect_uri` | The OAuth redirect URI in Settings isn't on Plaid's allowed list exactly (https, same path). |
| `PRODUCTS_NOT_SUPPORTED` / institution not supported | That bank doesn't offer transactions through Plaid. Keep importing its statements. |
