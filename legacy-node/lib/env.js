// Zero-dependency .env loader. Import this FIRST (before any module that
// reads process.env at load time).
import { readFileSync, existsSync } from "node:fs";

try {
  if (existsSync(".env")) {
    for (const line of readFileSync(".env", "utf8").split("\n")) {
      if (!line.trim() || line.trim().startsWith("#")) continue;
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && !(m[1] in process.env)) {
        let v = m[2].trim();
        if (v.length >= 2 && ((v[0] === '"' && v.at(-1) === '"') || (v[0] === "'" && v.at(-1) === "'")))
          v = v.slice(1, -1);
        process.env[m[1]] = v;
      }
    }
  }
} catch { /* .env is optional */ }
