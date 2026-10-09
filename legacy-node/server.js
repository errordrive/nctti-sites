import "./lib/env.js";
import { createServer } from "node:http";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join, extname, resolve, sep } from "node:path";

import * as db from "./lib/db.js";
import {
  hashPassword, verifyPassword, newToken, parseCookies,
  sessionCookie, clearCookie, readJSON, readMultipart, readBody,
  json, ok, err,
} from "./lib/auth.js";
import { validateSubdomain, siteDir, deployZip, removeSiteDir, dirSizeBytes } from "./lib/sites.js";
import { TIERS, tierOf, limitsFor, priceFor, createHostedPayment, newOrderRef, verifyWebhook, billingConfigured } from "./lib/billing.js";

const PORT = parseInt(process.env.PORT || "3000", 10);
const BASE_DOMAIN = process.env.BASE_DOMAIN || "sites.nctti.tech";
const APP_URL = (process.env.APP_URL || `https://sites.nctti.tech`).replace(/\/$/, "");
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || "").toLowerCase();
const BADGE_MARKER = "<!-- nctti-sites-free-badge -->";

const PUB = resolve("./public");
const MIME = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".json": "application/json",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml", ".ico": "image/x-icon", ".webp": "image/webp",
  ".woff2": "font/woff2",
};

function serveStatic(res, urlPath) {
  let p = urlPath === "/" ? "/index.html" : urlPath;
  if (p === "/app") p = "/app.html";
  if (p === "/admin") p = "/admin.html";
  const file = resolve(join(PUB, "." + p));
  if (!file.startsWith(PUB + sep) || !existsSync(file) || !readFileSync) return false;
  try {
    const data = readFileSync(file);
    res.writeHead(200, {
      "Content-Type": MIME[extname(file)] || "application/octet-stream",
      "Content-Length": data.length,
      "Cache-Control": p.startsWith("/assets/") ? "public, max-age=86400" : "no-cache",
    });
    res.end(data);
    return true;
  } catch { return false; }
}

function getUser(req) {
  const cookies = parseCookies(req);
  return db.sessionUser(cookies.nsid);
}

function needAuth(req, res) {
  const u = getUser(req);
  if (!u) { err(res, 401, "auth_required", "Please log in."); return null; }
  return u;
}

function needAdmin(req, res) {
  const u = needAuth(req, res);
  if (!u) return null;
  if (!u.is_admin) { err(res, 403, "forbidden", "Admin only."); return null; }
  return u;
}

const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e || "");

// Inject the free-tier badge into index.html (once, marker-guarded).
function injectBadge(subdomain) {
  const idx = join(siteDir(subdomain), "index.html");
  if (!existsSync(idx)) return;
  let html = readFileSync(idx, "utf8");
  if (html.includes(BADGE_MARKER)) return;
  const badge = `${BADGE_MARKER}<a href="${APP_URL}" style="position:fixed;bottom:12px;right:12px;z-index:9999;background:#111827;color:#fff;font:12px/1.4 system-ui;padding:6px 10px;border-radius:999px;text-decoration:none;opacity:.85" target="_blank" rel="noopener">Hosted free on NCTTI Sites</a>`;
  html = html.replace(/<\/body\s*>/i, badge + "</body>");
  if (!html.includes(BADGE_MARKER)) html += badge;
  writeFileSync(idx, html);
}

async function router(req, res) {
  const url = new URL(req.url, "http://x");
  const path = url.pathname;
  const method = req.method;

  try {
    // ---------- public API ----------
    if (path === "/api/tiers" && method === "GET")
      return ok(res, { tiers: TIERS, base_domain: BASE_DOMAIN });

    if (path === "/api/showcase" && method === "GET") {
      const u = getUser(req);
      const items = db.showcase(url.searchParams.get("sort") || "trending", 24, u?.id || null)
        .map((s) => ({
          id: s.id, subdomain: s.subdomain, title: s.title,
          description: s.description, owner: s.owner_name,
          likes: s.like_count, liked: !!s.liked,
          url: `https://${s.subdomain}.${BASE_DOMAIN}`,
          created_at: s.created_at,
        }));
      return ok(res, { items });
    }

    if (path === "/api/signup" && method === "POST") {
      const { name, email, password } = await readJSON(req);
      if (!name || name.trim().length < 2) return err(res, 400, "bad_name", "Please enter your name.");
      if (!validEmail(email)) return err(res, 400, "bad_email", "Invalid email address.");
      if (!password || password.length < 8) return err(res, 400, "weak_password", "Password must be at least 8 characters.");
      if (db.userByEmail(email)) return err(res, 409, "email_taken", "An account with this email already exists.");
      const { salt, hash } = await hashPassword(password);
      const isAdmin = ADMIN_EMAIL && email.toLowerCase() === ADMIN_EMAIL;
      const user = db.createUser(name.trim().slice(0, 60), email, hash, salt, isAdmin);
      const token = newToken();
      db.createSession(user.id, token);
      return ok(res, { user: publicUser(user) }, { "Set-Cookie": sessionCookie(token) });
    }

    if (path === "/api/login" && method === "POST") {
      const { email, password } = await readJSON(req);
      const user = db.userByEmail(email || "");
      if (!user || !(await verifyPassword(password || "", user.pass_salt, user.pass_hash)))
        return err(res, 401, "bad_credentials", "Wrong email or password.");
      if (user.suspended) return err(res, 403, "suspended", "This account is suspended.");
      const token = newToken();
      db.createSession(user.id, token);
      return ok(res, { user: publicUser(user) }, { "Set-Cookie": sessionCookie(token) });
    }

    if (path === "/api/logout" && method === "POST") {
      const c = parseCookies(req);
      if (c.nsid) db.deleteSession(c.nsid);
      return ok(res, {}, { "Set-Cookie": clearCookie() });
    }

    if (path === "/api/me" && method === "GET") {
      const u = needAuth(req, res); if (!u) return;
      const sub = db.activeSubscription(u.id);
      return ok(res, { user: publicUser(u), tier: tierOf(sub), subscription: sub && {
        tier: sub.tier, period: sub.period, ends_at: sub.ends_at } });
    }

    // ---------- sites ----------
    if (path === "/api/sites" && method === "GET") {
      const u = needAuth(req, res); if (!u) return;
      const sub = db.activeSubscription(u.id);
      const tier = tierOf(sub), lim = limitsFor(tier);
      const sites = db.sitesByUser(u.id).map((s) => ({
        ...s, url: `https://${s.subdomain}.${BASE_DOMAIN}`, likes: db.likeCount(s.id),
      }));
      return ok(res, { sites, tier, limits: lim });
    }

    if (path === "/api/sites" && method === "POST") {
      const u = needAuth(req, res); if (!u) return;
      const { subdomain, title } = await readJSON(req);
      const v = validateSubdomain(subdomain);
      if (v) return err(res, 400, "bad_subdomain", v);
      if (db.siteBySubdomain(subdomain)) return err(res, 409, "taken", "That subdomain is already taken.");
      const lim = limitsFor(tierOf(db.activeSubscription(u.id)));
      if (db.siteCountByUser(u.id) >= lim.sites)
        return err(res, 403, "limit_reached", `Your ${lim.name} plan allows ${lim.sites} site(s). Upgrade to add more.`);
      const site = db.createSite(u.id, subdomain, title);
      return ok(res, { site: { ...site, url: `https://${site.subdomain}.${BASE_DOMAIN}` } });
    }

    let m;
    if ((m = path.match(/^\/api\/sites\/(\d+)$/))) {
      const u = needAuth(req, res); if (!u) return;
      const site = db.siteById(+m[1]);
      if (!site || (site.user_id !== u.id && !u.is_admin)) return err(res, 404, "not_found", "Site not found.");

      if (method === "PATCH") {
        const { title, description, published } = await readJSON(req);
        const fields = {};
        if (title !== undefined) fields.title = String(title).slice(0, 80);
        if (description !== undefined) fields.description = String(description).slice(0, 200);
        if (published !== undefined) {
          if (published && site.storage_bytes === 0)
            return err(res, 400, "empty_site", "Deploy your site first, then publish it.");
          fields.published = published ? 1 : 0;
        }
        db.updateSite(site.id, fields);
        return ok(res, { site: db.siteById(site.id) });
      }
      if (method === "DELETE") {
        removeSiteDir(site.subdomain);
        db.deleteSite(site.id);
        return ok(res, {});
      }
      return err(res, 405, "method_not_allowed", "");
    }

    if ((m = path.match(/^\/api\/sites\/(\d+)\/deploy$/)) && method === "POST") {
      const u = needAuth(req, res); if (!u) return;
      const site = db.siteById(+m[1]);
      if (!site || site.user_id !== u.id) return err(res, 404, "not_found", "Site not found.");
      if (site.suspended) return err(res, 403, "suspended", "This site is suspended.");
      const lim = limitsFor(tierOf(db.activeSubscription(u.id)));
      const { file } = await readMultipart(req, 60 * 1024 * 1024).catch(() => ({}));
      if (!file) return err(res, 400, "no_file", "Upload a .zip file.");
      if (!/\.zip$/i.test(file.filename)) return err(res, 400, "not_zip", "Only .zip files are accepted.");
      // quota: total across user's sites must fit the tier
      const usedByOthers = db.sitesByUser(u.id)
        .filter((s) => s.id !== site.id).reduce((a, s) => a + s.storage_bytes, 0);
      const maxBytes = lim.storage_mb * 1024 * 1024;
      if (usedByOthers + file.data.length > maxBytes)
        return err(res, 403, "quota", `Storage limit reached (${lim.storage_mb} MB on your plan).`);
      try {
        const { files: n, bytes } = await deployZip(site.subdomain, file.data, maxBytes);
        db.updateSite(site.id, { storage_bytes: bytes });
        if (tierOf(db.activeSubscription(u.id)) === "free") injectBadge(site.subdomain);
        return ok(res, { files: n, bytes, url: `https://${site.subdomain}.${BASE_DOMAIN}` });
      } catch (e) {
        return err(res, 400, "deploy_failed", e.message);
      }
    }

    if ((m = path.match(/^\/api\/sites\/(\d+)\/like$/)) && method === "POST") {
      const u = needAuth(req, res); if (!u) return;
      const site = db.siteById(+m[1]);
      if (!site || !site.published || site.suspended) return err(res, 404, "not_found", "Site not found.");
      const liked = db.toggleLike(u.id, site.id);
      return ok(res, { liked, likes: db.likeCount(site.id) });
    }

    // ---------- billing ----------
    if (path === "/api/billing/checkout" && method === "POST") {
      const u = needAuth(req, res); if (!u) return;
      if (!billingConfigured()) return err(res, 503, "billing_off", "Online payment is not enabled yet. Contact support.");
      const { tier, period } = await readJSON(req);
      if (!TIERS[tier] || TIERS[tier].price === 0) return err(res, 400, "bad_tier", "Invalid plan.");
      if (!["monthly", "yearly"].includes(period)) return err(res, 400, "bad_period", "Invalid period.");
      const amount = priceFor(tier, period);
      const orderRef = newOrderRef(u.id);
      db.createSubscription(u.id, tier, period, amount, orderRef);
      try {
        const pay = await createHostedPayment({
          amount, orderRef,
          customerName: u.name,
          returnUrl: `${APP_URL}/app?billing=done`,
          webhookUrl: `${APP_URL}/api/webhooks/trxpay`,
        });
        db.prepare("UPDATE subscriptions SET payment_id = ? WHERE order_ref = ?").run(pay.payment_id, orderRef);
        return ok(res, { pay_url: pay.pay_url });
      } catch (e) {
        return err(res, 502, "pay_failed", e.detail || "Could not start payment. Try again.");
      }
    }

    if (path === "/api/webhooks/trxpay" && method === "POST") {
      const raw = await readBody(req, 1024 * 1024);
      const sig = req.headers["x-trxpay-signature"] || "";
      if (!verifyWebhook(raw, sig)) return err(res, 401, "bad_sig", "");
      let evt;
      try { evt = JSON.parse(raw.toString("utf8")); } catch { return err(res, 400, "bad_json", ""); }
      if (evt.event === "payment.success" && evt.event_id && !db.webhookSeen(evt.event_id)) {
        if (evt.order_ref) db.activateSubscription(evt.order_ref, evt.payment_id, evt.trx_id);
      }
      return ok(res, {});
    }

    // ---------- admin ----------
    if (path === "/api/admin/users" && method === "GET") {
      if (!needAdmin(req, res)) return;
      return ok(res, { users: db.allUsers() });
    }
    if (path === "/api/admin/sites" && method === "GET") {
      if (!needAdmin(req, res)) return;
      return ok(res, { sites: db.allSites().map((s) => ({ ...s, url: `https://${s.subdomain}.${BASE_DOMAIN}` })) });
    }
    if (path === "/api/admin/orders" && method === "GET") {
      if (!needAdmin(req, res)) return;
      return ok(res, { orders: db.allSubs() });
    }
    if ((m = path.match(/^\/api\/admin\/users\/(\d+)\/suspend$/)) && method === "POST") {
      if (!needAdmin(req, res)) return;
      const { suspended } = await readJSON(req);
      db.prepare("UPDATE users SET suspended = ? WHERE id = ?").run(suspended ? 1 : 0, +m[1]);
      return ok(res, {});
    }
    if ((m = path.match(/^\/api\/admin\/sites\/(\d+)\/suspend$/)) && method === "POST") {
      if (!needAdmin(req, res)) return;
      const { suspended } = await readJSON(req);
      db.prepare("UPDATE sites SET suspended = ? WHERE id = ?").run(suspended ? 1 : 0, +m[1]);
      return ok(res, {});
    }

    // ---------- static ----------
    if (method === "GET" && serveStatic(res, path)) return;
    return err(res, 404, "not_found", "Not found.");
  } catch (e) {
    console.error("request failed:", e);
    if (!res.headersSent) err(res, 500, "server_error", "Something went wrong.");
  }
}

function publicUser(u) {
  return { id: u.id, name: u.name, email: u.email, is_admin: !!u.is_admin };
}

createServer((req, res) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  router(req, res);
}).listen(PORT, () => console.log(`NCTTI Sites on :${PORT} (base domain: ${BASE_DOMAIN})`));
