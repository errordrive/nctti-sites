import { createHmac, timingSafeEqual, randomBytes } from "node:crypto";

export const TIERS = {
  free:     { name: "Free",     price: 0,   sites: 1,  storage_mb: 100,   badge: true,  features: ["1 subdomain", "100 MB storage", "Community showcase"] },
  starter:  { name: "Starter",  price: 29,  sites: 3,  storage_mb: 1024,  badge: false, features: ["3 subdomains", "1 GB storage", "No badge", "Custom 404 page"] },
  pro:      { name: "Pro",      price: 99,  sites: 10, storage_mb: 5120,  badge: false, features: ["10 subdomains", "5 GB storage", "Custom domain + auto SSL", "Site analytics"] },
  business: { name: "Business", price: 249, sites: 30, storage_mb: 20480, badge: false, features: ["30 subdomains", "20 GB storage", "Featured showcase slot", "Priority support"] },
};

export function tierOf(subscription) {
  if (subscription && subscription.status === "active") return subscription.tier;
  return "free";
}

export function limitsFor(tier) {
  return TIERS[tier] || TIERS.free;
}

export function priceFor(tier, period) {
  const t = TIERS[tier];
  if (!t || t.price === 0) return 0;
  return period === "yearly" ? t.price * 10 : t.price; // yearly = 2 months free
}

const TRX_BASE = "https://trxpay.nctti.tech";

export function billingConfigured() {
  return !!process.env.TRPAY_API_KEY;
}

// Canonical env: TRXPAY_API_KEY (see .env.example).
function apiKey() {
  return process.env.TRPAY_API_KEY || "";
}

// Create a TrxPay hosted payment (server-to-server; key never hits the browser).
export async function createHostedPayment({ amount, orderRef, customerName, customerPhone, returnUrl, webhookUrl }) {
  const key = apiKey();
  if (!key) throw new Error("billing_not_configured");
  const res = await fetch(`${TRX_BASE}/api/v1/payments`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      amount,
      order_ref: orderRef,
      customer_name: customerName,
      customer_phone: customerPhone,
      return_url: returnUrl,
      webhook_url: webhookUrl,
      expires_in: 1800,
      metadata: { product: "nctti-sites-subscription" },
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(data.error || "payment_create_failed");
    e.detail = data.message;
    throw e;
  }
  return data; // { payment_id, pay_url, ... }
}

export function newOrderRef(userId) {
  return `NS-${userId}-${Date.now().toString(36)}${randomBytes(3).toString("hex")}`.toUpperCase();
}

// Verify TrxPay webhook signature. Returns true/false.
export function verifyWebhook(rawBody, signature) {
  const secret = process.env.TRPAY_WEBHOOK_SECRET || "";
  if (!secret || !signature) return false;
  const sig = createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(sig);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}
