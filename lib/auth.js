import { randomBytes, scrypt as _scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(_scrypt);

export async function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const hash = (await scrypt(password, salt, 64)).toString("hex");
  return { salt, hash };
}

export async function verifyPassword(password, salt, hash) {
  const h = (await scrypt(password, salt, 64)).toString("hex");
  const a = Buffer.from(h, "hex");
  const b = Buffer.from(hash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

export const newToken = () => randomBytes(32).toString("hex");

// ---------- cookies ----------
export function parseCookies(req) {
  const out = {};
  const h = req.headers.cookie;
  if (!h) return out;
  for (const part of h.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function sessionCookie(token) {
  const secure = process.env.COOKIE_SECURE === "1" ? "; Secure" : "";
  return `nsid=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=2592000${secure}`;
}

export function clearCookie() {
  return "nsid=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0";
}

// ---------- body parsing ----------
export function readBody(req, maxBytes = 60 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > maxBytes) {
        req.destroy();
        reject(new Error("body_too_large"));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export async function readJSON(req) {
  const buf = await readBody(req, 1024 * 1024);
  try {
    return JSON.parse(buf.toString("utf8"));
  } catch {
    throw new Error("bad_json");
  }
}

// Minimal multipart/form-data parser (single file + text fields). Binary-safe.
export async function readMultipart(req, maxBytes = 60 * 1024 * 1024) {
  const ct = req.headers["content-type"] || "";
  const m = ct.match(/boundary=(.+)$/);
  if (!m) throw new Error("no_boundary");
  const boundary = Buffer.from("--" + m[1].trim().replace(/"/g, ""));
  const buf = await readBody(req, maxBytes);

  const fields = {};
  let file = null;
  let start = 0;
  while (true) {
    const bIdx = buf.indexOf(boundary, start);
    if (bIdx === -1) break;
    const partStart = bIdx + boundary.length;
    // skip \r\n after boundary
    let p = partStart;
    if (buf[p] === 13 && buf[p + 1] === 10) p += 2;
    // final boundary ends with --
    if (buf[p] === 45 && buf[p + 1] === 45) break;
    const headerEnd = buf.indexOf("\r\n\r\n", p);
    if (headerEnd === -1) break;
    const header = buf.slice(p, headerEnd).toString("latin1");
    const dataStart = headerEnd + 4;
    let dataEnd = buf.indexOf(boundary, dataStart);
    if (dataEnd === -1) break;
    dataEnd -= 2; // strip trailing \r\n before boundary
    const name = (header.match(/name="([^"]+)"/) || [])[1];
    const filename = (header.match(/filename="([^"]*)"/) || [])[1];
    const data = buf.slice(dataStart, dataEnd);
    if (filename !== undefined && filename !== "") {
      file = { field: name, filename, data };
    } else if (name) {
      fields[name] = data.toString("utf8");
    }
    start = dataEnd + 2;
  }
  return { fields, file };
}

// ---------- responses ----------
export function json(res, status, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(body);
}

export const ok = (res, obj = {}, headers) => json(res, 200, { ok: true, ...obj }, headers);
export const err = (res, status, code, message) =>
  json(res, status, { ok: false, error: code, message });
