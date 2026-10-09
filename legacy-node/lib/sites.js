import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, rmSync, readdirSync, statSync, renameSync, existsSync } from "node:fs";
import { join, resolve, sep } from "node:path";

const execFileP = promisify(execFile);

const RESERVED = new Set([
  "www", "api", "admin", "mail", "ftp", "cpanel", "webmail", "ns1", "ns2",
  "app", "dashboard", "billing", "support", "status", "blog", "docs", "help",
  "root", "test", "demo", "staging", "static", "assets", "cdn", "sites",
  "login", "signup", "auth", "oauth", "account", "settings", "pricing",
  "services", "showcase", "about", "contact", "terms", "privacy", "abuse",
]);

export function validateSubdomain(sub) {
  if (typeof sub !== "string") return "Subdomain must be text.";
  const s = sub.toLowerCase().trim();
  if (s.length < 3 || s.length > 30) return "Subdomain must be 3–30 characters.";
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(s))
    return "Only lowercase letters, numbers and hyphens (can't start/end with hyphen).";
  if (RESERVED.has(s)) return "That subdomain is reserved.";
  return null;
}

export function siteDir(subdomain) {
  const root = resolve(process.env.SITES_ROOT || "./data/sites");
  return join(root, subdomain.toLowerCase());
}

// List zip entries safely via `unzip -Z1`.
async function zipEntries(zipPath) {
  const { stdout } = await execFileP("unzip", ["-Z1", zipPath]);
  return stdout.split("\n").map((s) => s.trim()).filter(Boolean);
}

function isSafeEntry(name) {
  if (!name || name.startsWith("/") || name.startsWith("\\")) return false;
  if (/^[a-zA-Z]:/.test(name)) return false; // windows drive
  const parts = name.split("/");
  if (parts.some((p) => p === ".." || p === "")) return false;
  if (name.includes("__MACOSX")) return false;
  return true;
}

export function dirSizeBytes(dir) {
  let total = 0;
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else total += statSync(p).size;
    }
  };
  if (existsSync(dir)) walk(dir);
  return total;
}

// Deploy a zip buffer to the site's directory. Returns {files, bytes}.
export async function deployZip(subdomain, zipBuffer, maxBytes) {
  if (zipBuffer.length > maxBytes)
    throw new Error(`Zip is too large (limit ${(maxBytes / 1024 / 1024) | 0} MB).`);
  if (zipBuffer[0] !== 0x50 || zipBuffer[1] !== 0x4b)
    throw new Error("Not a valid zip file.");

  const dir = siteDir(subdomain);
  const tmpZip = join(dir, ".upload.tmp.zip");
  mkdirSync(dir, { recursive: true });

  const { writeFileSync, rmSync: rm } = await import("node:fs");
  writeFileSync(tmpZip, zipBuffer);
  try {
    const entries = await zipEntries(tmpZip);
    const files = entries.filter((e) => !e.endsWith("/"));
    if (!files.length) throw new Error("Zip is empty.");
    for (const e of files) {
      if (!isSafeEntry(e)) throw new Error(`Unsafe path in zip: ${e}`);
    }
    // wipe previous deploy (keep nothing stale)
    for (const e of readdirSync(dir)) {
      if (e === ".upload.tmp.zip") continue;
      rm(join(dir, e), { recursive: true, force: true });
    }
    await execFileP("unzip", ["-oq", tmpZip, "-d", dir]);

    // unwrap single top-level folder (common when zipping a project folder)
    let top = readdirSync(dir).filter((e) => e !== ".upload.tmp.zip");
    if (top.length === 1 && statSync(join(dir, top[0])).isDirectory()) {
      const inner = join(dir, top[0]);
      for (const e of readdirSync(inner)) renameSync(join(inner, e), join(dir, e));
      rm(inner, { recursive: true, force: true });
      top = readdirSync(dir).filter((e) => e !== ".upload.tmp.zip");
    }
    if (!top.some((e) => e.toLowerCase() === "index.html"))
      throw new Error("index.html not found in zip (required as the entry page).");

    const bytes = dirSizeBytes(dir);
    return { files: files.length, bytes };
  } finally {
    rm(tmpZip, { force: true });
  }
}

export function removeSiteDir(subdomain) {
  rmSync(siteDir(subdomain), { recursive: true, force: true });
}
