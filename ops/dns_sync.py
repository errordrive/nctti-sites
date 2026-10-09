#!/usr/bin/env python3
"""Sync NCTTI Sites user subdomains: D1 sites <-> Cloudflare DNS + worker routes.
Creates A {sub}.nctti.tech -> 192.0.2.1 (proxied) AND worker route
{sub}.nctti.tech/* -> nctti-sites-api for active sites.
Create-only for DNS (never deletes: other infra shares the IP); routes for
deleted sites are removed (exact-match, safe).
"""
import sys, json
sys.path.insert(0, "/opt/hatch/skills/skill-creator/bin")
from dynamic_credentials import add_surrogate_to_request, read_json_response
import urllib.request, urllib.error

ACCT = "308972df8e06497294cab9b1db4ee6c5"
ZONE = "14b1e59cda870d704f14f340cbb5e80a"
D1 = "3fcf58e4-fc57-4da4-9f21-29a689763ca4"
RESERVED = {"www","api","app","admin","blog","support","help","status","cdn","static",
            "dev","staging","demo","test","mail","email","vpn","music","shop","store",
            "ai","trxpay","messenger","tv","sites","pay","billing","docs","forum"}

def api(method, path, data=None):
    r = urllib.request.Request(f"https://api.cloudflare.com/client/v4{path}",
                               data=json.dumps(data).encode() if data else None,
                               method=method)
    if data: r.add_header("Content-Type", "application/json")
    add_surrogate_to_request(r, "custom.cloudflare", allowed_hosts=("api.cloudflare.com",))
    try:
        return read_json_response(urllib.request.urlopen(r, timeout=60))
    except urllib.error.HTTPError as e:
        print("API ERROR", method, path, e.code, e.read().decode()[:200])
        return None

# 1. active sites from D1
d = api("POST", f"/accounts/{ACCT}/d1/database/{D1}/query",
        {"sql": "SELECT subdomain FROM sites WHERE suspended = 0"})
active = set()
if d and d.get("success"):
    for row in (d.get("result") or [{}])[0].get("results", []):
        active.add(row["subdomain"])
print(f"active sites: {len(active)}")

# 2. current DNS records (single-level *.nctti.tech)
d = api("GET", f"/zones/{ZONE}/dns_records?per_page=100")
owned = {}  # subdomain -> record_id
if d and d.get("success"):
    for rec in d.get("result", []):
        name = rec["name"]
        if (rec["type"] == "A" and rec["content"] == "192.0.2.1" and rec["proxied"]
                and name.endswith(".nctti.tech")):
            sub = name[:-len(".nctti.tech")]
            if sub and "." not in sub and sub not in RESERVED and sub != "*":
                owned[sub] = rec["id"]
print(f"managed DNS records: {len(owned)}")

# 3. create missing DNS (NEVER auto-delete: other infra like livetv-api/ytprobe
#    also uses 192.0.2.1; stale records 404 harmlessly via the worker)
for sub in sorted(active - set(owned)):
    if sub in RESERVED or "." in sub:
        continue
    r = api("POST", f"/zones/{ZONE}/dns_records",
            {"type": "A", "name": f"{sub}.nctti.tech",
             "content": "192.0.2.1", "proxied": True})
    print(("+" if r and r.get("success") else "FAIL"), f"DNS {sub}.nctti.tech")

# 4. worker routes: exact per-subdomain routes (a wildcard route would hijack
#    sites.nctti.tech itself, so we never use one)
d = api("GET", f"/zones/{ZONE}/workers/routes")
existing_routes = {}
if d and d.get("success"):
    for rt in d.get("result", []):
        if rt.get("script") == "nctti-sites-api":
            existing_routes[rt["pattern"]] = rt["id"]
for sub in sorted(active):
    if sub in RESERVED or "." in sub:
        continue
    pat = f"{sub}.nctti.tech/*"
    if pat not in existing_routes:
        r = api("POST", f"/zones/{ZONE}/workers/routes",
                {"pattern": pat, "script": "nctti-sites-api"})
        print(("+ route" if r and r.get("success") else "FAIL route"), pat)
for pat, rid in sorted(existing_routes.items()):
    # remove routes for sites no longer active (exact match only; never wildcards)
    if pat.endswith(".nctti.tech/*") and not pat.startswith("*."):
        sub = pat[:-len(".nctti.tech/*")]
        if sub not in active and sub not in RESERVED:
            r = api("DELETE", f"/zones/{ZONE}/workers/routes/{rid}")
            print(("- route" if r and r.get("success") else "FAIL route", pat))
print("done")
