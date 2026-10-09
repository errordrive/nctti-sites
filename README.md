# NCTTI Sites — free subdomain hosting + project showcase + services marketplace

Users sign up, claim a free subdomain (`name.sites.nctti.tech`), upload a zip of
their static site, go live instantly, and showcase it for likes. Paid plans from
৳29/month (bKash/Nagad/Rocket via TrxPay Verify). The same site sells NCTTI's
web services.

**100% free infrastructure — no VPS:**
- **Frontend** → Cloudflare Pages (`public/`)
- **Backend** → Cloudflare Worker (`worker/worker.js`, free tier, 10ms CPU budget)
- **Database** → Cloudflare D1 (SQLite, free tier)
- **File storage** → private Telegram channel via Bot API (Worker streams files,
  cached at the edge). This is Telegram-as-a-CDN, for real.

## Setup (one time)

1. **Telegram storage bot**: talk to `@BotFather` → `/newbot` → copy the token.
   Create a **private channel**, add the bot as **admin**.
2. **D1**: already created (`nctti-sites`). Apply schema:
   `worker/schema.sql` via the Cloudflare API.
3. **Worker secrets** (never commit):
   `TG_BOT_TOKEN`, `TG_CHANNEL_ID` (e.g. `-1001234567890`),
   `ADMIN_EMAIL`, `TRXPAY_API_KEY`, `TRXPAY_WEBHOOK_SECRET`.
4. Deploy Pages from `public/` → custom domain `sites.nctti.tech`.
5. Deploy the Worker, then add routes:
   - `sites.nctti.tech/api/*` → worker
   - `*.sites.nctti.tech/*` → worker

## How deploys work (CPU-budget safe)

The browser unzips locally (fflate, no Worker CPU), then uploads files one by
one to `POST /api/sites/:id/files` (raw bytes + `X-Filename` header). The Worker
forwards each file to the Telegram channel via `sendDocument` and stores the
`file_id` in D1. Serving: D1 lookup → edge cache → Telegram `getFile` stream.

Free-tier sites get a "Hosted free on NCTTI Sites" badge injected into
`index.html` **in the browser** before upload.

## Billing (TrxPay Verify)

Same flow as v1: checkout → TrxPay hosted payment → `payment.success` webhook
(HMAC verified) → subscription activated (30/365 days). Without TrxPay keys,
billing endpoints return `billing_off` — free tier works fully.

## Layout

```
public/        landing + showcase + pricing + services, dashboard, admin
worker/
  worker.js    API + user-site file server (single file, zero npm deps)
  schema.sql   D1 schema
legacy-node/   v1 Node.js implementation (tested, kept for reference)
```

## Limits to know (free tiers)

- Workers: 100k req/day, 10ms CPU/req — all hot paths are I/O-bound, fine.
- D1: 5GB, 25M reads/day — fine.
- Telegram Bot API: 50MB/file upload, 20MB/file download — site files are small.
- Passwords: PBKDF2-HMAC-SHA256 x20k (WebCrypto-native; scrypt would blow the
  10ms CPU budget — documented tradeoff for free tier).
