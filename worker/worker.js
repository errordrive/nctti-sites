/* NCTTI Sites API + user-site server — Cloudflare Worker (free tier).
 *
 * Routes (set after deploy):
 *   sites.nctti.tech/api/*   -> this worker (API)
 *   *.sites.nctti.tech/*      -> this worker (legacy; HTTPS limited by Universal SSL)
 *   *.nctti.tech/*            -> this worker (user sites; free Universal SSL covers 1 level)
 * Frontend static files live on Cloudflare Pages (same domain).
 *
 * Bindings: DB (d1). Secrets: TG_BOT_TOKEN, TG_CHANNEL_ID, TRXPAY_API_KEY,
 * TRXPAY_WEBHOOK_SECRET. Vars: ADMIN_EMAIL, BASE_DOMAIN, APP_URL.
 *
 * Design notes for the 10ms free CPU budget:
 * - Passwords: PBKDF2-HMAC-SHA256 x20k via WebCrypto (native, ~ms).
 * - Zip handling happens CLIENT-SIDE (browser unzips with fflate); the worker
 *   only proxies file bytes to Telegram. No heavy CPU here.
 * - Served site files stream DIRECTLY from Telegram every request (no edge
 *   cache, by design: zero stored state on Cloudflare).
 */

const TIERS = {
  free:     { name: "Free",     price: 0,   sites: 1,  storage_mb: 100,   badge: true,  features: ["1 subdomain", "100 MB storage", "Community showcase"] },
  starter:  { name: "Starter",  price: 29,  sites: 3,  storage_mb: 1024,  badge: false, features: ["3 subdomains", "1 GB storage", "No badge", "Custom 404 page"] },
  pro:      { name: "Pro",      price: 99,  sites: 10, storage_mb: 5120,  badge: false, features: ["10 subdomains", "5 GB storage", "Custom domain + auto SSL", "Site analytics"] },
  business: { name: "Business", price: 249, sites: 30, storage_mb: 20480, badge: false, features: ["30 subdomains", "20 GB storage", "Featured showcase slot", "Priority support"] },
};
const TIER_ORDER = ["free", "starter", "pro", "business"];
const RESERVED = new Set(["www","api","admin","mail","ftp","cpanel","webmail","ns1","ns2","app","dashboard","billing","support","status","blog","docs","help","root","test","demo","staging","static","assets","cdn","sites","login","signup","auth","oauth","account","settings","pricing","services","showcase","about","contact","terms","privacy","abuse"]);
const MAX_FILE_BYTES = 32 * 1024 * 1024; // per-file cap (Telegram allows 50MB; worker memory safe at 32MB)

const MIME = { html:"text/html; charset=utf-8", htm:"text/html; charset=utf-8", css:"text/css; charset=utf-8",
  js:"text/javascript; charset=utf-8", mjs:"text/javascript; charset=utf-8", json:"application/json",
  png:"image/png", jpg:"image/jpeg", jpeg:"image/jpeg", gif:"image/gif", svg:"image/svg+xml",
  webp:"image/webp", ico:"image/x-icon", woff:"font/woff", woff2:"font/woff2", ttf:"font/ttf",
  txt:"text/plain; charset=utf-8", xml:"application/xml", pdf:"application/pdf", mp4:"video/mp4",
  webm:"video/webm", mp3:"audio/mpeg", wav:"audio/wav" };
const mimeFor = (name) => MIME[(name.split(".").pop() || "").toLowerCase()] || "application/octet-stream";

// ---------- tiny utils ----------
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
const randToken = () => b64url(crypto.getRandomValues(new Uint8Array(32)));
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers } });
}
const ok = (data = {}, headers) => json({ ok: true, ...data }, 200, headers);
const err = (status, code, message) => json({ ok: false, error: code, message }, status);

function getCookie(req, name) {
  const h = req.headers.get("Cookie") || "";
  for (const part of h.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name)
      return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}
function sessionCookie(token, secure) {
  return `nsid=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=2592000${secure ? "; Secure" : ""}`;
}

// ---------- passwords (PBKDF2, WebCrypto-native; fast enough for 10ms budget) ----------
async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: 20000, hash: "SHA-256" }, key, 256);
  return { salt: hex(salt), hash: hex(bits) };
}
async function verifyPassword(password, saltHex, hashHex) {
  const salt = new Uint8Array(saltHex.match(/../g).map((h) => parseInt(h, 16)));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: 20000, hash: "SHA-256" }, key, 256);
  const a = hex(bits), b = hashHex;
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

// ---------- Telegram storage ----------
const tgApi = (env, method) => `https://api.telegram.org/bot${env.TG_BOT_TOKEN}/${method}`;
const tgFile = (env, path) => `https://api.telegram.org/file/bot${env.TG_BOT_TOKEN}/${path}`;

async function tgSendDocument(env, filename, bytes, mime, caption) {
  const fd = new FormData();
  fd.append("chat_id", env.TG_CHANNEL_ID);
  fd.append("caption", caption);
  fd.append("document", new Blob([bytes], { type: mime }), filename);
  const r = await fetch(tgApi(env, "sendDocument"), { method: "POST", body: fd });
  const d = await r.json();
  if (!d.ok) throw new Error("telegram_upload_failed: " + (d.description || r.status));
  return { file_id: d.result.document.file_id, message_id: d.result.message_id || null };
}
async function tgDeleteMessage(env, messageId) {
  if (!messageId) return;
  try {
    await fetch(tgApi(env, "deleteMessage"), {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: env.TG_CHANNEL_ID, message_id: messageId }),
    });
  } catch { /* orphan TG file is harmless */ }
}
async function tgDownloadUrl(env, fileId) {
  const r = await fetch(tgApi(env, "getFile"), {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file_id: fileId }),
  });
  const d = await r.json();
  if (!d.ok) {
    // file deleted from Telegram -> signal so caller can clean D1 immediately
    const gone = /not found|bad request/i.test(d.description || "");
    throw new Error(gone ? "TG_GONE" : "telegram_getfile_failed");
  }
  return tgFile(env, d.result.file_path);
}

// ---------- auth helpers ----------
async function currentUser(req, env) {
  const token = getCookie(req, "nsid");
  if (!token) return null;
  const row = await env.DB.prepare(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token = ? AND s.expires_at > datetime('now') AND u.suspended = 0`
  ).bind(token).first();
  return row || null;
}
const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email, is_admin: !!u.is_admin });
const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e || "");

async function activeSub(env, userId) {
  return env.DB.prepare(
    `SELECT * FROM subscriptions WHERE user_id = ? AND status = 'active'
     AND ends_at > datetime('now') ORDER BY ends_at DESC LIMIT 1`
  ).bind(userId).first();
}
const tierOf = (sub) => (sub ? sub.tier : "free");
const priceFor = (tier, period) => {
  const t = TIERS[tier];
  if (!t || !t.price) return 0;
  return period === "yearly" ? t.price * 10 : t.price;
};

// ---------- API routes ----------
function validateSubdomain(sub) {
  if (typeof sub !== "string") return "Subdomain must be text.";
  const s = sub.toLowerCase().trim();
  if (s.length < 3 || s.length > 30) return "Subdomain must be 3–30 characters.";
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(s))
    return "Only lowercase letters, numbers and hyphens (can't start/end with hyphen).";
  if (RESERVED.has(s)) return "That subdomain is reserved.";
  return null;
}
const isSafePath = (p) =>
  typeof p === "string" && p.length > 0 && p.length <= 200 &&
  p.startsWith("/") && !p.includes("\\") && !p.includes("__MACOSX") &&
  p.split("/").every((seg, i) => i === 0 ? seg === "" : seg !== "" && seg !== "." && seg !== "..");

async function apiRouter(req, env, ctx, url) {
  const base = env.BASE_DOMAIN || "sites.nctti.tech";
  const appUrl = env.APP_URL || "https://sites.nctti.tech";
  const path = url.pathname.replace(/^\/api/, "") || "/";
  const method = req.method;
  const body = async () => req.json().catch(() => ({}));
  const secure = new URL(req.url).protocol === "https:";

  // ----- public -----
  if (path === "/tiers" && method === "GET")
    return ok({ tiers: TIERS, base_domain: base });

  if (path === "/showcase" && method === "GET") {
    const u = await currentUser(req, env);
    const sort = url.searchParams.get("sort") === "new" ? "s.created_at DESC" : "like_count DESC, s.created_at DESC";
    const rows = await env.DB.prepare(
      `SELECT s.id, s.subdomain, s.title, s.description, s.created_at, u.name AS owner_name,
              (SELECT COUNT(*) FROM likes l WHERE l.site_id = s.id) AS like_count
       FROM sites s JOIN users u ON u.id = s.user_id
       WHERE s.published = 1 AND s.suspended = 0 AND u.suspended = 0
       ORDER BY ${sort} LIMIT 24`
    ).all();
    const items = (rows.results || []).map((s) => ({
      id: s.id, subdomain: s.subdomain, title: s.title, description: s.description,
      owner: s.owner_name, likes: s.like_count, liked: false,
      url: `https://${s.subdomain}.nctti.tech`, created_at: s.created_at,
    }));
    if (u) {
      const likedRows = await env.DB.prepare(
        `SELECT site_id FROM likes WHERE user_id = ? AND site_id IN (${items.map(() => "?").join(",") || "NULL"})`
      ).bind(u.id, ...items.map((i) => i.id)).all();
      const set = new Set((likedRows.results || []).map((r) => r.site_id));
      items.forEach((i) => (i.liked = set.has(i.id)));
    }
    return ok({ items });
  }

  if (path === "/signup" && method === "POST") {
    const { name, email, password } = await body();
    if (!name || name.trim().length < 2) return err(400, "bad_name", "Please enter your name.");
    if (!validEmail(email)) return err(400, "bad_email", "Invalid email address.");
    if (!password || password.length < 8) return err(400, "weak_password", "Password must be at least 8 characters.");
    const exists = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email.toLowerCase()).first();
    if (exists) return err(409, "email_taken", "An account with this email already exists.");
    const { salt, hash } = await hashPassword(password);
    const isAdmin = env.ADMIN_EMAIL && email.toLowerCase() === env.ADMIN_EMAIL.toLowerCase() ? 1 : 0;
    const r = await env.DB.prepare(
      "INSERT INTO users (name, email, pass_hash, pass_salt, is_admin) VALUES (?,?,?,?,?)"
    ).bind(name.trim().slice(0, 60), email.toLowerCase(), hash, salt, isAdmin).run();
    const user = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(r.meta.last_row_id).first();
    const token = randToken();
    await env.DB.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?,?, datetime('now','+30 days'))").bind(token, user.id).run();
    return ok({ user: publicUser(user) }, { "Set-Cookie": sessionCookie(token, secure) });
  }

  if (path === "/login" && method === "POST") {
    const { email, password } = await body();
    const user = await env.DB.prepare("SELECT * FROM users WHERE email = ?").bind((email || "").toLowerCase()).first();
    if (!user || !(await verifyPassword(password || "", user.pass_salt, user.pass_hash)))
      return err(401, "bad_credentials", "Wrong email or password.");
    if (user.suspended) return err(403, "suspended", "This account is suspended.");
    const token = randToken();
    await env.DB.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?,?, datetime('now','+30 days'))").bind(token, user.id).run();
    return ok({ user: publicUser(user) }, { "Set-Cookie": sessionCookie(token, secure) });
  }

  if (path === "/logout" && method === "POST") {
    const t = getCookie(req, "nsid");
    if (t) await env.DB.prepare("DELETE FROM sessions WHERE token = ?").bind(t).run();
    return ok({}, { "Set-Cookie": "nsid=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0" });
  }

  // ----- authed -----
  const me = async () => {
    const u = await currentUser(req, env);
    return u;
  };

  if (path === "/me" && method === "GET") {
    const u = await me();
    if (!u) return err(401, "auth_required", "Please log in.");
    const sub = await activeSub(env, u.id);
    return ok({ user: publicUser(u), tier: tierOf(sub),
      subscription: sub ? { tier: sub.tier, period: sub.period, ends_at: sub.ends_at } : null });
  }

  if (path === "/sites" && method === "GET") {
    const u = await me();
    if (!u) return err(401, "auth_required", "Please log in.");
    const tier = tierOf(await activeSub(env, u.id));
    const rows = await env.DB.prepare("SELECT * FROM sites WHERE user_id = ? ORDER BY created_at DESC").bind(u.id).all();
    const sites = await Promise.all((rows.results || []).map(async (s) => ({
      ...s, url: `https://${s.subdomain}.nctti.tech`,
      likes: (await env.DB.prepare("SELECT COUNT(*) c FROM likes WHERE site_id = ?").bind(s.id).first()).c,
    })));
    return ok({ sites, tier, limits: TIERS[tier] });
  }

  if (path === "/sites" && method === "POST") {
    const u = await me();
    if (!u) return err(401, "auth_required", "Please log in.");
    const { subdomain, title } = await body();
    const v = validateSubdomain(subdomain);
    if (v) return err(400, "bad_subdomain", v);
    const taken = await env.DB.prepare("SELECT id FROM sites WHERE subdomain = ?").bind(subdomain.toLowerCase()).first();
    if (taken) return err(409, "taken", "That subdomain is already taken.");
    const lim = TIERS[tierOf(await activeSub(env, u.id))];
    const count = (await env.DB.prepare("SELECT COUNT(*) c FROM sites WHERE user_id = ?").bind(u.id).first()).c;
    if (count >= lim.sites) return err(403, "limit_reached", `Your ${lim.name} plan allows ${lim.sites} site(s). Upgrade to add more.`);
    const r = await env.DB.prepare("INSERT INTO sites (user_id, subdomain, title) VALUES (?,?,?)")
      .bind(u.id, subdomain.toLowerCase(), (title || subdomain).slice(0, 80)).run();
    const site = await env.DB.prepare("SELECT * FROM sites WHERE id = ?").bind(r.meta.last_row_id).first();
    return ok({ site: { ...site, url: `https://${site.subdomain}.nctti.tech` } });
  }

  let m;
  if ((m = path.match(/^\/sites\/(\d+)$/))) {
    const u = await me();
    if (!u) return err(401, "auth_required", "Please log in.");
    const site = await env.DB.prepare("SELECT * FROM sites WHERE id = ?").bind(+m[1]).first();
    if (!site || (site.user_id !== u.id && !u.is_admin)) return err(404, "not_found", "Site not found.");
    if (method === "PATCH") {
      const { title, description, published } = await body();
      const fields = [], vals = [];
      if (title !== undefined) { fields.push("title = ?"); vals.push(String(title).slice(0, 80)); }
      if (description !== undefined) { fields.push("description = ?"); vals.push(String(description).slice(0, 200)); }
      if (published !== undefined) {
        if (published) {
          const hasIndex = await env.DB.prepare("SELECT 1 FROM site_files WHERE site_id = ? AND path = '/index.html'").bind(site.id).first();
          if (!hasIndex) return err(400, "empty_site", "Deploy your site first, then publish it.");
        }
        fields.push("published = ?"); vals.push(published ? 1 : 0);
      }
      if (fields.length) await env.DB.prepare(`UPDATE sites SET ${fields.join(", ")} WHERE id = ?`).bind(...vals, site.id).run();
      return ok({ site: await env.DB.prepare("SELECT * FROM sites WHERE id = ?").bind(site.id).first() });
    }
    if (method === "DELETE") {
      await env.DB.batch([
        env.DB.prepare("DELETE FROM site_files WHERE site_id = ?").bind(site.id),
        env.DB.prepare("DELETE FROM likes WHERE site_id = ?").bind(site.id),
        env.DB.prepare("DELETE FROM sites WHERE id = ?").bind(site.id),
      ]);
      return ok({});
    }
    return err(405, "method_not_allowed", "");
  }

  // Per-file upload (browser unzips client-side; sends raw bytes + X-Filename).
  if ((m = path.match(/^\/sites\/(\d+)\/files$/)) && method === "POST") {
    const u = await me();
    if (!u) return err(401, "auth_required", "Please log in.");
    const site = await env.DB.prepare("SELECT * FROM sites WHERE id = ?").bind(+m[1]).first();
    if (!site || site.user_id !== u.id) return err(404, "not_found", "Site not found.");
    if (site.suspended) return err(403, "suspended", "This site is suspended.");
    const filename = req.headers.get("X-Filename") || "";
    const fpath = "/" + filename.replace(/^\/+/, "");
    if (!isSafePath(fpath)) return err(400, "bad_path", "Unsafe file path.");
    const bytes = new Uint8Array(await req.arrayBuffer());
    if (!bytes.length) return err(400, "empty_file", "Empty file.");
    if (bytes.length > MAX_FILE_BYTES) return err(400, "too_large", "File exceeds 32 MB.");
    const lim = TIERS[tierOf(await activeSub(env, u.id))];
    const totalRow = await env.DB.prepare(
      "SELECT COALESCE(SUM(size),0) AS s FROM site_files WHERE site_id IN (SELECT id FROM sites WHERE user_id = ?)"
    ).bind(u.id).first();
    if ((totalRow.s || 0) + bytes.length > lim.storage_mb * 1024 * 1024)
      return err(403, "quota", `Storage limit reached (${lim.storage_mb} MB on your plan).`);
    const mime = mimeFor(fpath);
    let tg;
    try {
      tg = await tgSendDocument(env, fpath.split("/").pop() || "file", bytes, mime, `${site.subdomain}:${fpath}`);
    } catch (e) {
      return err(502, "upload_failed", "Could not store file. Try again.");
    }
    // if replacing, remove the old Telegram message so storage doesn't leak
    const old = await env.DB.prepare("SELECT tg_msg_id FROM site_files WHERE site_id = ? AND path = ?").bind(site.id, fpath).first();
    if (old && old.tg_msg_id) await tgDeleteMessage(env, old.tg_msg_id);
    await env.DB.prepare(
      "INSERT INTO site_files (site_id, path, file_id, tg_msg_id, size, mime) VALUES (?,?,?,?,?,?) ON CONFLICT(site_id, path) DO UPDATE SET file_id=excluded.file_id, tg_msg_id=excluded.tg_msg_id, size=excluded.size, mime=excluded.mime"
    ).bind(site.id, fpath, tg.file_id, tg.message_id, bytes.length, mime).run();
    return ok({ path: fpath, size: bytes.length });
  }

  // File manager: list files
  if ((m = path.match(/^\/sites\/(\d+)\/files$/)) && method === "GET") {
    const u = await me();
    if (!u) return err(401, "auth_required", "Please log in.");
    const site = await env.DB.prepare("SELECT * FROM sites WHERE id = ?").bind(+m[1]).first();
    if (!site || site.user_id !== u.id) return err(404, "not_found", "Site not found.");
    const rows = await env.DB.prepare(
      "SELECT path, size, mime FROM site_files WHERE site_id = ? ORDER BY path"
    ).bind(site.id).all();
    return ok({ files: rows.results || [] });
  }

  // File manager: delete one file
  if ((m = path.match(/^\/sites\/(\d+)\/files$/)) && method === "DELETE") {
    const u = await me();
    if (!u) return err(401, "auth_required", "Please log in.");
    const site = await env.DB.prepare("SELECT * FROM sites WHERE id = ?").bind(+m[1]).first();
    if (!site || site.user_id !== u.id) return err(404, "not_found", "Site not found.");
    const body = await req.json().catch(() => ({}));
    const fpath = "/" + String(body.path || "").replace(/^\/+/, "");
    if (!isSafePath(fpath)) return err(400, "bad_path", "Unsafe file path.");
    const row = await env.DB.prepare("SELECT tg_msg_id FROM site_files WHERE site_id = ? AND path = ?").bind(site.id, fpath).first();
    await env.DB.prepare("DELETE FROM site_files WHERE site_id = ? AND path = ?").bind(site.id, fpath).run();
    // also delete from Telegram so storage doesn't leak
    if (row && row.tg_msg_id) await tgDeleteMessage(env, row.tg_msg_id);
    const total = await env.DB.prepare("SELECT COALESCE(SUM(size),0) s FROM site_files WHERE site_id = ?").bind(site.id).first();
    await env.DB.prepare("UPDATE sites SET storage_bytes = ? WHERE id = ?").bind(total.s || 0, site.id).run();
    return ok({ deleted: fpath });
  }

  // File manager: read raw content (for view/edit), text files only
  if ((m = path.match(/^\/sites\/(\d+)\/file-content$/)) && method === "GET") {
    const u = await me();
    if (!u) return err(401, "auth_required", "Please log in.");
    const site = await env.DB.prepare("SELECT * FROM sites WHERE id = ?").bind(+m[1]).first();
    if (!site || site.user_id !== u.id) return err(404, "not_found", "Site not found.");
    const qp = new URL(req.url).searchParams.get("path") || "";
    const fpath = "/" + qp.replace(/^\/+/, "");
    if (!isSafePath(fpath)) return err(400, "bad_path", "Unsafe file path.");
    const f = await env.DB.prepare("SELECT * FROM site_files WHERE site_id = ? AND path = ?").bind(site.id, fpath).first();
    if (!f) return err(404, "not_found", "File not found.");
    if (f.size > 512 * 1024) return err(400, "too_large", "File too large to edit here.");
    let dl;
    try { dl = await tgDownloadUrl(env, f.file_id); }
    catch (e) {
      if (e.message === "TG_GONE") {
        await env.DB.prepare("DELETE FROM site_files WHERE site_id = ? AND path = ?").bind(site.id, fpath).run();
        return err(404, "gone", "File was deleted from storage.");
      }
      return err(502, "storage_error", "Could not read file.");
    }
    const up = await fetch(dl);
    if (!up.ok) return err(502, "storage_error", "Could not read file.");
    const text = await up.text();
    return ok({ path: fpath, mime: f.mime, size: f.size, content: text });
  }

  // File manager: edit (replace content of a text file)
  if ((m = path.match(/^\/sites\/(\d+)\/files$/)) && method === "PUT") {
    const u = await me();
    if (!u) return err(401, "auth_required", "Please log in.");
    const site = await env.DB.prepare("SELECT * FROM sites WHERE id = ?").bind(+m[1]).first();
    if (!site || site.user_id !== u.id) return err(404, "not_found", "Site not found.");
    if (site.suspended) return err(403, "suspended", "This site is suspended.");
    const body = await req.json().catch(() => ({}));
    const fpath = "/" + String(body.path || "").replace(/^\/+/, "");
    const content = String(body.content ?? "");
    if (!isSafePath(fpath)) return err(400, "bad_path", "Unsafe file path.");
    if (content.length > MAX_FILE_BYTES) return err(400, "too_large", "File exceeds 32 MB.");
    const old = await env.DB.prepare("SELECT * FROM site_files WHERE site_id = ? AND path = ?").bind(site.id, fpath).first();
    if (!old) return err(404, "not_found", "File not found.");
    const bytes = new TextEncoder().encode(content);
    let tg;
    try {
      tg = await tgSendDocument(env, fpath.split("/").pop() || "file", bytes, old.mime, `${site.subdomain}:${fpath}`);
    } catch (e) {
      return err(502, "upload_failed", "Could not save file. Try again.");
    }
    if (old.tg_msg_id) await tgDeleteMessage(env, old.tg_msg_id);
    await env.DB.prepare(
      "UPDATE site_files SET file_id = ?, tg_msg_id = ?, size = ? WHERE site_id = ? AND path = ?"
    ).bind(tg.file_id, tg.message_id, bytes.length, site.id, fpath).run();
    const total = await env.DB.prepare("SELECT COALESCE(SUM(size),0) s FROM site_files WHERE site_id = ?").bind(site.id).first();
    await env.DB.prepare("UPDATE sites SET storage_bytes = ? WHERE id = ?").bind(total.s || 0, site.id).run();
    return ok({ path: fpath, size: bytes.length });
  }

  if ((m = path.match(/^\/sites\/(\d+)\/deploy-complete$/)) && method === "POST") {
    const u = await me();
    if (!u) return err(401, "auth_required", "Please log in.");
    const site = await env.DB.prepare("SELECT * FROM sites WHERE id = ?").bind(+m[1]).first();
    if (!site || site.user_id !== u.id) return err(404, "not_found", "Site not found.");
    const hasIndex = await env.DB.prepare("SELECT 1 FROM site_files WHERE site_id = ? AND path = '/index.html'").bind(site.id).first();
    if (!hasIndex) return err(400, "empty_site", "index.html not found in upload.");
    const total = await env.DB.prepare("SELECT COALESCE(SUM(size),0) s, COUNT(*) c FROM site_files WHERE site_id = ?").bind(site.id).first();
    await env.DB.prepare("UPDATE sites SET storage_bytes = ? WHERE id = ?").bind(total.s, site.id).run();
    return ok({ files: total.c, bytes: total.s, url: `https://${site.subdomain}.nctti.tech` });
  }

  if ((m = path.match(/^\/sites\/(\d+)\/like$/)) && method === "POST") {
    const u = await me();
    if (!u) return err(401, "auth_required", "Please log in.");
    const site = await env.DB.prepare("SELECT * FROM sites WHERE id = ?").bind(+m[1]).first();
    if (!site || !site.published || site.suspended) return err(404, "not_found", "Site not found.");
    const ex = await env.DB.prepare("SELECT 1 FROM likes WHERE user_id = ? AND site_id = ?").bind(u.id, site.id).first();
    let liked;
    if (ex) { await env.DB.prepare("DELETE FROM likes WHERE user_id = ? AND site_id = ?").bind(u.id, site.id).run(); liked = false; }
    else { await env.DB.prepare("INSERT INTO likes (user_id, site_id) VALUES (?,?)").bind(u.id, site.id).run(); liked = true; }
    const likes = (await env.DB.prepare("SELECT COUNT(*) c FROM likes WHERE site_id = ?").bind(site.id).first()).c;
    return ok({ liked, likes });
  }

  // ----- billing -----
  if (path === "/billing/checkout" && method === "POST") {
    const u = await me();
    if (!u) return err(401, "auth_required", "Please log in.");
    if (!env.TRPAY_API_KEY) return err(503, "billing_off", "Online payment is not enabled yet. Contact support.");
    const { tier, period } = await body();
    if (!TIERS[tier] || !TIERS[tier].price) return err(400, "bad_tier", "Invalid plan.");
    if (!["monthly", "yearly"].includes(period)) return err(400, "bad_period", "Invalid period.");
    const amount = priceFor(tier, period);
    const orderRef = ("NS-" + u.id + "-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)).toUpperCase();
    await env.DB.prepare("INSERT INTO subscriptions (user_id, tier, period, amount, order_ref) VALUES (?,?,?,?,?)")
      .bind(u.id, tier, period, amount, orderRef).run();
    const r = await fetch("https://trxpay.nctti.tech/api/v1/payments", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.TRPAY_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ amount, order_ref: orderRef, customer_name: u.name,
        return_url: `${appUrl}/app?billing=done`,
        webhook_url: `${appUrl}/api/webhooks/trxpay`,
        expires_in: 1800, metadata: { product: "nctti-sites-subscription" } }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return err(502, "pay_failed", data.message || "Could not start payment. Try again.");
    await env.DB.prepare("UPDATE subscriptions SET payment_id = ? WHERE order_ref = ?").bind(data.payment_id, orderRef).run();
    return ok({ pay_url: data.pay_url });
  }

  if (path === "/webhooks/trxpay" && method === "POST") {
    const raw = new Uint8Array(await req.arrayBuffer());
    const sigHex = req.headers.get("x-trxpay-signature") || "";
    const secret = env.TRPAY_WEBHOOK_SECRET || "";
    let valid = false;
    if (secret && sigHex) {
      const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      const mac = await crypto.subtle.sign("HMAC", key, raw);
      const a = hex(mac);
      valid = a.length === sigHex.length && (() => { let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ sigHex.charCodeAt(i); return d === 0; })();
    }
    if (!valid) return err(401, "bad_sig", "");
    const evt = JSON.parse(new TextDecoder().decode(raw));
    if (evt.event === "payment.success" && evt.event_id) {
      const seen = await env.DB.prepare("INSERT OR IGNORE INTO webhook_events (event_id) VALUES (?)").bind(evt.event_id).run();
      if (seen.meta.changes > 0 && evt.order_ref) {
        const sub = await env.DB.prepare("SELECT * FROM subscriptions WHERE order_ref = ?").bind(evt.order_ref).first();
        if (sub && sub.status !== "active") {
          const days = sub.period === "yearly" ? 365 : 30;
          await env.DB.prepare(
            `UPDATE subscriptions SET status='active', payment_id=?, trx_id=?, starts_at=datetime('now'), ends_at=datetime('now','+${days} days') WHERE order_ref = ?`
          ).bind(evt.payment_id, evt.trx_id, evt.order_ref).run();
        }
      }
    }
    return ok({});
  }

  // ----- admin -----
  const admin = await me();
  if (path.startsWith("/admin")) {
    if (!admin || !admin.is_admin) return err(403, "forbidden", "Admin only.");
    if (path === "/admin/users" && method === "GET") {
      const rows = await env.DB.prepare("SELECT id,name,email,is_admin,suspended,created_at FROM users ORDER BY id").all();
      return ok({ users: rows.results || [] });
    }
    if (path === "/admin/sites" && method === "GET") {
      const rows = await env.DB.prepare(
        "SELECT s.*, u.email AS owner_email FROM sites s JOIN users u ON u.id = s.user_id ORDER BY s.created_at DESC").all();
      return ok({ sites: (rows.results || []).map((s) => ({ ...s, url: `https://${s.subdomain}.nctti.tech` })) });
    }
    if (path === "/admin/orders" && method === "GET") {
      const rows = await env.DB.prepare(
        "SELECT s.*, u.email AS owner_email FROM subscriptions s JOIN users u ON u.id = s.user_id ORDER BY s.created_at DESC LIMIT 200").all();
      return ok({ orders: rows.results || [] });
    }
    let am;
    if ((am = path.match(/^\/admin\/users\/(\d+)\/suspend$/)) && method === "POST") {
      const { suspended } = await body();
      await env.DB.prepare("UPDATE users SET suspended = ? WHERE id = ?").bind(suspended ? 1 : 0, +am[1]).run();
      return ok({});
    }
    if ((am = path.match(/^\/admin\/sites\/(\d+)\/suspend$/)) && method === "POST") {
      const { suspended } = await body();
      await env.DB.prepare("UPDATE sites SET suspended = ? WHERE id = ?").bind(suspended ? 1 : 0, +am[1]).run();
      return ok({});
    }
  }

  return err(404, "not_found", "Not found.");
}

// ---------- user site serving (Telegram storage, direct every request) ----------
async function serveSite(req, env, ctx, sub, pathname) {
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(sub)) return new Response("Not found", { status: 404 });
  const site = await env.DB.prepare("SELECT * FROM sites WHERE subdomain = ? AND suspended = 0").bind(sub).first();
  if (!site) return new Response("Site not found", { status: 404 });

  let p = pathname.split("?")[0];
  try { p = decodeURIComponent(p); } catch { return new Response("Bad path", { status: 400 }); }
  if (!isSafePath(p) && p !== "/") return new Response("Not found", { status: 404 });
  if (p === "/") p = "/index.html";
  if (p.endsWith("/")) p += "index.html";

  const f = await env.DB.prepare("SELECT * FROM site_files WHERE site_id = ? AND path = ?").bind(site.id, p).first();
  if (!f) return new Response("Not found", { status: 404 });
  let dl;
  try { dl = await tgDownloadUrl(env, f.file_id); }
  catch (e) {
    // immediate action: file was deleted from Telegram -> drop the stale D1 row
    if (e.message === "TG_GONE") {
      ctx.waitUntil(env.DB.prepare("DELETE FROM site_files WHERE site_id = ? AND path = ?").bind(site.id, p).run());
      return new Response("Not found", { status: 404 });
    }
    return new Response("Storage error", { status: 502 });
  }
  const up = await fetch(dl);
  if (!up.ok) return new Response("Storage error", { status: 502 });
  const dl2 = up.headers.get("content-length");
  return new Response(up.body, { headers: {
    "Content-Type": f.mime,
    "Content-Length": dl2 || String(f.size),
    "X-Content-Type-Options": "nosniff",
    ...(req.url.includes("download=1") ? { "Content-Disposition": `attachment; filename="${p.split("/").pop()}"` } : {}),
  }});
}

// ---------- entry ----------
const RESERVED_SUBS = new Set([
  "www", "api", "app", "admin", "blog", "support", "help", "status", "cdn", "static",
  "dev", "staging", "demo", "test", "mail", "email", "vpn", "music", "shop", "store",
  "ai", "trxpay", "messenger", "tv", "sites", "pay", "billing", "docs", "forum",
]);

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const host = url.hostname.toLowerCase();
    const base = (env.BASE_DOMAIN || "sites.nctti.tech").toLowerCase();
    try {
      if (host === base) {
        if (url.pathname.startsWith("/api/")) return apiRouter(req, env, ctx, url);
        return new Response("Not found", { status: 404 }); // Pages serves the frontend
      }
      // User sites on *.nctti.tech (single-level: free Universal SSL covers it)
      if (host.endsWith(".nctti.tech")) {
        const sub = host.slice(0, -".nctti.tech".length);
        if (sub && !sub.includes(".") && !RESERVED_SUBS.has(sub)) {
          return serveSite(req, env, ctx, sub, url.pathname);
        }
        return new Response("Not found", { status: 404 });
      }
      if (host.endsWith("." + base)) {
        const sub = host.slice(0, -(base.length + 1));
        return serveSite(req, env, ctx, sub, url.pathname);
      }
      return new Response("Not found", { status: 404 });
    } catch (e) {
      return err(500, "server_error", "Something went wrong.");
    }
  },
};
