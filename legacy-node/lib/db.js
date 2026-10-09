import "./env.js";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const dbPath = process.env.DB_PATH || "./data/nctti-sites.db";
mkdirSync(dirname(dbPath), { recursive: true });

export const db = new DatabaseSync(dbPath);
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  pass_hash TEXT NOT NULL,
  pass_salt TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  suspended INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subdomain TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  published INTEGER NOT NULL DEFAULT 0,
  suspended INTEGER NOT NULL DEFAULT 0,
  storage_bytes INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS likes (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, site_id)
);
CREATE TABLE IF NOT EXISTS subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tier TEXT NOT NULL,
  period TEXT NOT NULL DEFAULT 'monthly',
  status TEXT NOT NULL DEFAULT 'pending',
  amount INTEGER NOT NULL,
  order_ref TEXT NOT NULL UNIQUE,
  payment_id TEXT,
  trx_id TEXT,
  starts_at TEXT,
  ends_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS webhook_events (
  event_id TEXT PRIMARY KEY,
  received_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sites_user ON sites(user_id);
CREATE INDEX IF NOT EXISTS idx_sites_published ON sites(published);
CREATE INDEX IF NOT EXISTS idx_subs_user ON subscriptions(user_id);
`);

// ---- users ----
export const userByEmail = (email) =>
  db.prepare("SELECT * FROM users WHERE email = ?").get(email.toLowerCase());
export const userById = (id) =>
  db.prepare("SELECT * FROM users WHERE id = ?").get(id);
export function createUser(name, email, hash, salt, isAdmin) {
  const r = db
    .prepare(
      "INSERT INTO users (name, email, pass_hash, pass_salt, is_admin) VALUES (?,?,?,?,?)"
    )
    .run(name, email.toLowerCase(), hash, salt, isAdmin ? 1 : 0);
  return userById(r.lastInsertRowid);
}

// ---- sessions ----
export function createSession(userId, token, days = 30) {
  db.prepare(
    "INSERT INTO sessions (token, user_id, expires_at) VALUES (?,?, datetime('now', ?))"
  ).run(token, userId, `+${days} days`);
}
export function sessionUser(token) {
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token = ? AND s.expires_at > datetime('now') AND u.suspended = 0`
    )
    .get(token);
  return row || null;
}
export function deleteSession(token) {
  db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
}

// ---- sites ----
export const siteBySubdomain = (sub) =>
  db.prepare("SELECT * FROM sites WHERE subdomain = ?").get(sub.toLowerCase());
export const siteById = (id) =>
  db.prepare("SELECT * FROM sites WHERE id = ?").get(id);
export const sitesByUser = (userId) =>
  db.prepare("SELECT * FROM sites WHERE user_id = ? ORDER BY created_at DESC").all(userId);
export const siteCountByUser = (userId) =>
  db.prepare("SELECT COUNT(*) c FROM sites WHERE user_id = ?").get(userId).c;
export function createSite(userId, subdomain, title) {
  const r = db
    .prepare("INSERT INTO sites (user_id, subdomain, title) VALUES (?,?,?)")
    .run(userId, subdomain.toLowerCase(), title || subdomain);
  return siteById(r.lastInsertRowid);
}
export function updateSite(id, fields) {
  const keys = Object.keys(fields);
  const set = keys.map((k) => `${k} = ?`).join(", ");
  db.prepare(`UPDATE sites SET ${set} WHERE id = ?`).run(...keys.map((k) => fields[k]), id);
}
export function deleteSite(id) {
  db.prepare("DELETE FROM sites WHERE id = ?").run(id);
}

// ---- likes ----
export function toggleLike(userId, siteId) {
  const existing = db
    .prepare("SELECT 1 FROM likes WHERE user_id = ? AND site_id = ?")
    .get(userId, siteId);
  if (existing) {
    db.prepare("DELETE FROM likes WHERE user_id = ? AND site_id = ?").run(userId, siteId);
    return false;
  }
  db.prepare("INSERT INTO likes (user_id, site_id) VALUES (?,?)").run(userId, siteId);
  return true;
}
export const likeCount = (siteId) =>
  db.prepare("SELECT COUNT(*) c FROM likes WHERE site_id = ?").get(siteId).c;
export const likedBy = (userId, siteId) =>
  !!db.prepare("SELECT 1 FROM likes WHERE user_id = ? AND site_id = ?").get(userId, siteId);

// ---- showcase ----
export function showcase(sort = "trending", limit = 24, viewerId = null) {
  const order =
    sort === "new" ? "s.created_at DESC" : "like_count DESC, s.created_at DESC";
  const rows = db
    .prepare(
      `SELECT s.*, u.name AS owner_name,
              (SELECT COUNT(*) FROM likes l WHERE l.site_id = s.id) AS like_count
       FROM sites s JOIN users u ON u.id = s.user_id
       WHERE s.published = 1 AND s.suspended = 0 AND u.suspended = 0
       ORDER BY ${order} LIMIT ?`
    )
    .all(limit);
  if (viewerId) {
    for (const r of rows) r.liked = likedBy(viewerId, r.id);
  }
  return rows;
}

// ---- subscriptions ----
export function activeSubscription(userId) {
  return db
    .prepare(
      `SELECT * FROM subscriptions WHERE user_id = ? AND status = 'active'
       AND ends_at > datetime('now') ORDER BY ends_at DESC LIMIT 1`
    )
    .get(userId);
}
export function createSubscription(userId, tier, period, amount, orderRef) {
  const r = db
    .prepare(
      `INSERT INTO subscriptions (user_id, tier, period, amount, order_ref)
       VALUES (?,?,?,?,?)`
    )
    .run(userId, tier, period, amount, orderRef);
  return db.prepare("SELECT * FROM subscriptions WHERE id = ?").get(r.lastInsertRowid);
}
export const subByOrderRef = (ref) =>
  db.prepare("SELECT * FROM subscriptions WHERE order_ref = ?").get(ref);
export function activateSubscription(orderRef, paymentId, trxId) {
  const sub = subByOrderRef(orderRef);
  if (!sub || sub.status === "active") return sub;
  const days = sub.period === "yearly" ? 365 : 30;
  db.prepare(
    `UPDATE subscriptions SET status='active', payment_id=?, trx_id=?,
     starts_at=datetime('now'), ends_at=datetime('now', ?) WHERE order_ref = ?`
  ).run(paymentId, trxId, `+${days} days`, orderRef);
  return subByOrderRef(orderRef);
}
export function webhookSeen(eventId) {
  const r = db
    .prepare("INSERT OR IGNORE INTO webhook_events (event_id) VALUES (?)")
    .run(eventId);
  return r.changes === 0; // true if already seen
}

// ---- admin ----
export const allUsers = () =>
  db.prepare("SELECT id,name,email,is_admin,suspended,created_at FROM users ORDER BY id").all();
export const allSites = () =>
  db.prepare(
    `SELECT s.*, u.email AS owner_email FROM sites s
     JOIN users u ON u.id = s.user_id ORDER BY s.created_at DESC`
  ).all();
export const allSubs = () =>
  db.prepare(
    `SELECT s.*, u.email AS owner_email FROM subscriptions s
     JOIN users u ON u.id = s.user_id ORDER BY s.created_at DESC LIMIT 200`
  ).all();
