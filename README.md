# NCTTI Sites — free subdomain hosting + project showcase + services marketplace

Users sign up, claim a free subdomain (`name.sites.nctti.tech`), upload a zip of
their static site, go live instantly, and showcase it for likes. Paid plans from
৳29/month (bKash/Nagad/Rocket via TrxPay Verify). The same site sells NCTTI's
web services.

Zero-dependency Node.js + SQLite (WAL). No build step.

## Quick start (local)

```bash
cd nctti-sites
cp .env.example .env   # edit: BASE_DOMAIN, APP_URL, ADMIN_EMAIL, ...
node server.js         # -> http://localhost:3000
```

The first account whose email matches `ADMIN_EMAIL` becomes admin.

> Local dev serves the app only. User subdomains (`*.sites.nctti.tech`) are
> served by nginx on the VPS (see `ops/`).

## Environment

| Var | Purpose |
|---|---|
| `PORT` | app port (default 3000) |
| `BASE_DOMAIN` | `sites.nctti.tech` |
| `APP_URL` | public URL, used for payment return/webhook |
| `SITES_ROOT` | where deployed sites live (`./data/sites` local, `/var/www/sites` VPS) |
| `DB_PATH` | sqlite file |
| `ADMIN_EMAIL` | this email becomes admin on signup |
| `COOKIE_SECURE` | `1` in production (https) |
| `TRXPAY_API_KEY` | `tp_live_…` from TrxPay admin — **server only, never commit** |
| `TRXPAY_WEBHOOK_SECRET` | webhook HMAC secret from TrxPay admin |

## Billing flow (TrxPay Verify)

1. User picks a plan → `POST /api/billing/checkout` → backend creates a TrxPay
   **hosted payment** (key stays server-side) → browser redirects to `pay_url`.
2. Buyer pays via bKash/Nagad/Rocket and enters the TrxID on TrxPay's page.
3. TrxPay POSTs `payment.success` to `/api/webhooks/trxpay` → HMAC verified,
   deduped on `event_id` → subscription activated (30 / 365 days).

Test with a `tp_test_…` key + the TrxPay app's test-payment button.

## Deploy to VPS

1. Point DNS: `A sites.nctti.tech → VPS IP`, `A *.sites.nctti.tech → VPS IP`
   (grey cloud / DNS-only in Cloudflare).
2. `scp -r nctti-sites root@VPS:/opt/` then on the VPS:
   ```bash
   cd /opt/nctti-sites && chmod +x ops/setup-vps.sh && ./ops/setup-vps.sh
   cp .env.example .env   # fill real values (TRXPAY keys via Secure Vault)
   pm2 start server.js --name nctti-sites && pm2 save && pm2 startup
   ```
3. Test: sign up → create site `demo` → upload a zip with `index.html` →
   open `https://demo.sites.nctti.tech`.

## Safety notes (free hosting = abuse magnet)

- **Static only**: nginx never executes user files; `.php/.py/.sh` explicitly denied.
- Zip uploads are path-validated (zip-slip protection), `index.html` required.
- Free-tier sites get a small "Hosted free on NCTTI Sites" badge injected at deploy.
- Admin panel: suspend users/sites, review orders. Report abuse → suspend.

## Project layout

```
server.js            HTTP server + all routes
lib/db.js            SQLite schema + queries
lib/auth.js          scrypt auth, sessions, multipart parser
lib/sites.js         subdomain validation, safe zip deploy, quotas
lib/billing.js       tiers, TrxPay hosted payments, webhook verify
lib/env.js           tiny .env loader
public/              landing + showcase + pricing + services (index.html)
                     dashboard (app.html), admin (admin.html)
ops/                 nginx wildcard config, VPS setup script
```
