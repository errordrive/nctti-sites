// NCTTI Sites dashboard — mobile-first.
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtMB = (b) => (b / 1048576).toFixed(1) + " MB";

const ICONS = {
  globe: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 3.8 5.7 3.8 9S14.5 18.4 12 21c-2.5-2.6-3.8-5.7-3.8-9S9.5 5.6 12 3z"/></svg>',
  upload: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 16V4m0 0L8 8m4-4l4 4"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></svg>',
  edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M17 3a2.8 2.8 0 1 1 4 4L8 20l-5 1 1-5z"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m-9 0l1 13h10l1-13"/></svg>',
  dots: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="12" cy="19" r="1.8"/></svg>',
  heart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 20.5C7 16.5 3 13 3 8.8 3 6 5.2 4 7.8 4c1.7 0 3.2.9 4.2 2.3C13 5 14.5 4 16.2 4 18.8 4 21 6 21 8.8c0 4.2-4 7.7-9 11.7z"/></svg>',
  out: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 5H5v14h4m6-9l4 4-4 4m-4-4h7"/></svg>',
  rocket: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2c3 2 5 6 5 10l3 3-4 1c-1 2-2.5 3.5-4 4-1.5-.5-3-2-4-4l-4-1 3-3c0-4 2-8 5-10z"/><circle cx="12" cy="9" r="1.6"/></svg>',
  folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
  file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2h8l5 5v15H6z"/><path d="M14 2v5h5"/></svg>',
  img: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M4 18l5-5 3 3 4-4 4 4"/></svg>',
};

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg; t.classList.add("show");
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove("show"), 2600);
}

async function api(path, opts = {}) {
  const r = await fetch(path, { headers: { "Content-Type": "application/json" }, ...opts });
  if (r.status === 401) { location.href = "/"; throw new Error("auth"); }
  const d = await r.json().catch(() => ({}));
  if (!d.ok) throw new Error(d.message || "Request failed");
  return d;
}

// ---------- safe storage ----------
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};

// ---------- theme ----------
function initTheme() {
  const saved = store.get("ns-theme");
  const theme = saved || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  document.documentElement.dataset.theme = theme;
}
initTheme();
$("#theme-btn").addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  store.set("ns-theme", next);
});

// ---------- views ----------
function switchView(name) {
  $$(".view").forEach((v) => v.classList.toggle("on", v.id === "view-" + name));
  $$("#tabbar button, #segtabs button").forEach((b) => b.classList.toggle("on", b.dataset.view === name));
  closeAllSheets();
  if (name === "sites") loadSites();
  if (name === "billing") renderBilling();
  // files view is opened via openFiles(), not tabs
  $("#fab").style.display = name === "files" ? "none" : "";
}
$$("#tabbar button, #segtabs button").forEach((b) => b.addEventListener("click", () => switchView(b.dataset.view)));

// ---------- sheets ----------
function openSheet(id) { $(id).classList.add("show"); }
function closeAllSheets() { $$(".sheet-bg").forEach((s) => s.classList.remove("show")); }
$$(".sheet-bg").forEach((bg) => bg.addEventListener("click", (e) => { if (e.target === bg) bg.classList.remove("show"); }));

let confirmFn = null;
function confirmDlg(title, sub, yesLabel, fn) {
  $("#confirm-title").textContent = title;
  $("#confirm-sub").textContent = sub;
  $("#confirm-yes").textContent = yesLabel;
  confirmFn = fn;
  openSheet("#sheet-confirm");
}
$("#confirm-no").addEventListener("click", closeAllSheets);
$("#confirm-yes").addEventListener("click", () => { closeAllSheets(); confirmFn && confirmFn(); });

// ---------- state ----------
let ME = null, TIERS = null, BASE = "", SITES = [];

async function boot() {
  try {
    await bootInner();
    window.__booted = true;
  } catch (e) {
    console.error(e);
    const box = $("#sites-list");
    if (box) box.innerHTML = `<div class="empty"><b>Couldn't load dashboard</b>${esc(e.message || "Unknown error")}<br><br>
      <button class="btn btn-primary" onclick="location.reload()">Retry</button></div>`;
  }
}

async function bootInner() {
  $("#sites-list").innerHTML = `<div class="skel" style="height:120px;margin-bottom:12px"></div><div class="skel" style="height:120px"></div>`;
  const d = await api("/api/me").catch(() => null);
  if (!d) { location.href = "/"; return; }
  ME = d;
  const t = await api("/api/tiers");
  TIERS = t.tiers; BASE = t.base_domain;
  $("#base-domain").textContent = BASE;
  $("#plan-pill").textContent = TIERS[ME.tier].name;
  const q = new URLSearchParams(location.search);
  renderAccount();
  await loadSites();
  if (q.get("plan")) { switchView("billing"); checkout(q.get("plan"), q.get("period") || "monthly"); }
  if (q.get("billing") === "done") { switchView("billing"); toast("Payment received — plan activates shortly."); }
}

// ---------- sites ----------
const usedMB = () => SITES.reduce((a, s) => a + (s.storage_bytes || 0), 0) / 1048576;

async function loadSites() {
  const box = $("#sites-list");
  try {
    const d = await api("/api/sites");
    SITES = d.sites;
    const lim = d.limits;
    $("#quota-line").textContent =
      `${SITES.length}/${lim.sites} sites · ${usedMB().toFixed(1)}/${lim.storage_mb} MB used`;
    if (!SITES.length) {
      box.innerHTML = `<div class="empty">${ICONS.rocket}<b>No sites yet</b>Your first site takes 10 seconds.<br><br>
        <button class="btn btn-primary" onclick="openSheet('#sheet-site')">Create a site</button></div>`;
      return;
    }
    box.innerHTML = SITES.map((s) => {
      const pct = Math.min(100, (s.storage_bytes / (lim.storage_mb * 1048576)) * 100);
      return `<div class="site-card">
        <div class="site-top">
          <div class="avatar">${esc((s.title || s.subdomain).slice(0, 1))}</div>
          <div class="site-meta">
            <div class="t">${esc(s.title || s.subdomain)}</div>
            <a class="u" href="${s.url}" target="_blank" rel="noopener">${s.subdomain}.${BASE}</a>
            <div class="stats"><span>${ICONS.heart.replace("<svg", '<svg width="13" height="13" style="vertical-align:-2px"')} ${s.likes}</span><span>${fmtMB(s.storage_bytes)}</span></div>
          </div>
          <span class="pill ${s.suspended ? "susp" : s.published ? "live" : "draft"}">${s.suspended ? "suspended" : s.published ? "live" : "draft"}</span>
        </div>
        <div class="meter"><i style="width:${pct.toFixed(1)}%"></i></div>
        <div class="site-actions">
          <button class="btn btn-primary btn-sm" data-files="${s.id}">${ICONS.folder} Files</button>
          <button class="btn btn-ghost btn-sm" data-open="${s.url}">${ICONS.globe} Visit</button>
          <div class="kebab">
            <button class="btn btn-ghost btn-sm" data-kebab="${s.id}" aria-label="More">${ICONS.dots}</button>
            <div class="kebab-menu" id="menu-${s.id}">
              <button data-upload="${s.id}">${ICONS.upload} Deploy zip</button>
              <button data-edit="${s.id}">${ICONS.edit} Edit details</button>
              <button data-del="${s.id}" class="danger">${ICONS.trash} Delete site</button>
            </div>
          </div>
        </div>
        <div class="pub-row">
          <div class="lbl">Showcase<small>${s.published ? "Visible publicly" : "Only you can see it"}</small></div>
          <label class="switch"><input type="checkbox" data-pub="${s.id}" ${s.published ? "checked" : ""} ${s.suspended ? "disabled" : ""}><span class="tr"></span></label>
        </div>
      </div>`;
    }).join("");
    bindSiteActions();
  } catch (e) { box.innerHTML = `<div class="empty">Couldn't load sites.</div>`; }
}

function bindSiteActions() {
  $$("[data-files]").forEach((b) => b.addEventListener("click", () => openFiles(b.dataset.files)));
  $$("[data-upload]").forEach((b) => b.addEventListener("click", () => openUpload(b.dataset.upload)));
  $$("[data-open]").forEach((b) => b.addEventListener("click", () => window.open(b.dataset.open, "_blank", "noopener")));
  $$("[data-kebab]").forEach((b) => b.addEventListener("click", (e) => {
    e.stopPropagation();
    const menu = $("#menu-" + b.dataset.kebab);
    const was = menu.classList.contains("show");
    $$(".kebab-menu").forEach((m) => m.classList.remove("show"));
    if (!was) menu.classList.add("show");
  }));
  document.addEventListener("click", () => $$(".kebab-menu").forEach((m) => m.classList.remove("show")), { once: true });
  $$("[data-pub]").forEach((sw) => sw.addEventListener("change", async () => {
    const id = sw.dataset.pub, want = sw.checked;
    sw.disabled = true;
    try {
      await api(`/api/sites/${id}`, { method: "PATCH", body: JSON.stringify({ published: want }) });
      toast(want ? "Published to showcase!" : "Unpublished.");
      loadSites();
    } catch (e) { toast(e.message); sw.checked = !want; sw.disabled = false; }
  }));
  $$("[data-edit]").forEach((b) => b.addEventListener("click", async () => {
    const s = SITES.find((x) => x.id == b.dataset.edit);
    const title = prompt("Site title:", s.title || "");
    if (title === null) return;
    const desc = prompt("Short description (for showcase):", s.description || "");
    try {
      await api(`/api/sites/${s.id}`, { method: "PATCH", body: JSON.stringify({ title, description: desc || "" }) });
      toast("Saved."); loadSites();
    } catch (e) { toast(e.message); }
  }));
  $$("[data-del]").forEach((b) => b.addEventListener("click", () => {
    const s = SITES.find((x) => x.id == b.dataset.del);
    confirmDlg("Delete this site?", `${s.subdomain}.${BASE} will go offline permanently.`, "Delete", async () => {
      try { await api(`/api/sites/${s.id}`, { method: "DELETE" }); toast("Site deleted."); loadSites(); }
      catch (e) { toast(e.message); }
    });
  }));
}

// new site
$("#fab").addEventListener("click", () => { $("#site-err").classList.remove("show"); openSheet("#sheet-site"); });
$("#create-site").addEventListener("click", async () => {
  const btn = $("#create-site"), errBox = $("#site-err");
  errBox.classList.remove("show"); btn.disabled = true;
  btn.textContent = "Creating…";
  try {
    const d = await api("/api/sites", { method: "POST", body: JSON.stringify({
      subdomain: $("#new-sub").value.trim(), title: $("#new-title").value.trim() }) });
    btn.textContent = "Loading starter site…";
    try {
      await deployStarter(d.site);
      toast("Your site is live!");
    } catch (e) {
      toast("Site created — starter page appears once file storage connects.");
    }
    closeAllSheets();
    $("#new-sub").value = ""; $("#new-title").value = "";
    await loadSites();
    openFiles(d.site.id);
  } catch (e) { errBox.textContent = e.message; errBox.classList.add("show"); }
  finally { btn.disabled = false; btn.textContent = "Create site"; }
});

// Deploy the default starter website so users instantly see the file -> URL model.
const STARTER_FILES = ["index.html", "about.html", "styles.css", "script.js"];
async function deployStarter(site) {
  for (const name of STARTER_FILES) {
    let text = await (await fetch(`/templates/starter/${name}?v=2`)).text();
    text = text.split("{{SUBDOMAIN}}").join(site.subdomain);
    let bytes = new TextEncoder().encode(text);
    if (ME.tier === "free" && name === "index.html") {
      try { bytes = injectBadge(new TextDecoder().decode(bytes)); } catch {}
    }
    const r = await fetch(`/api/sites/${site.id}/files`, {
      method: "POST", headers: { "X-Filename": name }, body: bytes });
    const d = await r.json().catch(() => ({}));
    if (!d.ok) throw new Error(d.message || `Starter deploy failed at ${name}`);
  }
  await api(`/api/sites/${site.id}/deploy-complete`, { method: "POST" });
}

// ---------- upload sheet ----------
let uploadSiteId = null, zipFile = null;
function openUpload(siteId) {
  uploadSiteId = siteId;
  zipFile = null;
  $("#upload-err").classList.remove("show");
  $("#upl-list").innerHTML = "";
  $("#pbar").style.display = "none";
  $("#start-upload").disabled = true;
  const s = SITES.find((x) => x.id == siteId);
  $("#upload-sub").textContent = `Deploying to ${s.subdomain}.${BASE}`;
  openSheet("#sheet-upload");
}
const dz = $("#dropzone");
dz.addEventListener("click", () => $("#zip-input").click());
$("#zip-input").addEventListener("change", (e) => { if (e.target.files[0]) pickZip(e.target.files[0]); });
["dragover", "dragenter"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add("over"); }));
["dragleave", "drop"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove("over"); }));
dz.addEventListener("drop", (e) => { const f = e.dataTransfer.files[0]; if (f) pickZip(f); });

function pickZip(f) {
  if (!/\.zip$/i.test(f.name)) { $("#upload-err").textContent = "Please choose a .zip file."; $("#upload-err").classList.add("show"); return; }
  zipFile = f;
  $("#upload-err").classList.remove("show");
  $("#upl-list").innerHTML = `<div class="upl-row"><span class="n">${esc(f.name)}</span><span class="st">${fmtMB(f.size)} ready</span></div>`;
  $("#start-upload").disabled = false;
}

const BADGE = "<!-- nctti-sites-free-badge -->";
function injectBadge(html) {
  if (html.includes(BADGE)) return new TextEncoder().encode(html);
  const b = `${BADGE}<a href="https://sites.nctti.tech" style="position:fixed;bottom:12px;right:12px;z-index:9999;background:#111827;color:#fff;font:12px/1.4 system-ui;padding:6px 10px;border-radius:999px;text-decoration:none;opacity:.85" target="_blank" rel="noopener">Hosted free on NCTTI Sites</a>`;
  return new TextEncoder().encode(/<\/body\s*>/i.test(html) ? html.replace(/<\/body\s*>/i, b + "</body>") : html + b);
}
const zipSafe = (n) => n && !n.startsWith("/") && !/^[a-zA-Z]:/.test(n) &&
  !n.split("/").some((p) => p === ".." || p === "") && !n.includes("__MACOSX");

$("#start-upload").addEventListener("click", async () => {
  if (!zipFile) return;
  const btn = $("#start-upload"), errBox = $("#upload-err"), list = $("#upl-list"), bar = $("#pbar");
  errBox.classList.remove("show"); btn.disabled = true;
  bar.style.display = ""; bar.firstElementChild.style.width = "2%";
  try {
    const buf = new Uint8Array(await zipFile.arrayBuffer());
    let entries;
    try { entries = fflate.unzipSync(buf); } catch { throw new Error("Invalid zip file."); }
    let files = Object.entries(entries).filter(([n]) => !n.endsWith("/") && zipSafe(n));
    if (!files.length) throw new Error("Zip is empty or has unsafe paths.");
    const tops = new Set(files.map(([n]) => n.split("/")[0]));
    if (tops.size === 1) {
      const top = [...tops][0];
      if (files.every(([n]) => n === top || n.startsWith(top + "/")))
        files = files.map(([n, d]) => [n.slice(top.length + 1), d]).filter(([n]) => n && zipSafe(n));
    }
    if (!files.some(([n]) => n.toLowerCase() === "index.html"))
      throw new Error("index.html not found — it must be the entry page.");
    const free = ME.tier === "free";
    let done = 0;
    list.innerHTML = "";
    for (const [name, data] of files) {
      const row = document.createElement("div");
      row.className = "upl-row";
      row.innerHTML = `<span class="n">${esc(name)}</span><span class="st">uploading…</span>`;
      list.appendChild(row);
      let bytes = data;
      if (free && name.toLowerCase() === "index.html") {
        try { bytes = injectBadge(new TextDecoder().decode(data)); } catch { /* keep binary */ }
      }
      const r = await fetch(`/api/sites/${uploadSiteId}/files`, {
        method: "POST", headers: { "X-Filename": name }, body: bytes });
      const d = await r.json().catch(() => ({}));
      const st = row.querySelector(".st");
      if (!d.ok) { st.textContent = "failed"; st.classList.add("bad"); throw new Error(d.message || `Failed at ${name}`); }
      st.textContent = "done"; st.classList.add("ok");
      done++;
      bar.firstElementChild.style.width = Math.round((done / files.length) * 100) + "%";
    }
    const fin = await api(`/api/sites/${uploadSiteId}/deploy-complete`, { method: "POST" });
    toast(`Deployed ${fin.files} files — site is live!`);
    closeAllSheets(); loadSites();
  } catch (e) { errBox.textContent = e.message; errBox.classList.add("show"); }
  finally { btn.disabled = false; }
});

// ---------- file manager (cPanel-style) ----------
let FM = { siteId: null, site: null, files: [], dir: "" };

function openFiles(siteId) {
  FM = { siteId, site: SITES.find((x) => x.id == siteId), files: [], dir: "" };
  $("#files-title").textContent = FM.site.subdomain + "." + BASE;
  loadFmFiles();
  switchView("files");
}
$("#files-back").addEventListener("click", () => switchView("sites"));

async function loadFmFiles() {
  const box = $("#files-list");
  box.innerHTML = `<div class="skel" style="height:62px;margin-bottom:8px"></div><div class="skel" style="height:62px;margin-bottom:8px"></div><div class="skel" style="height:62px"></div>`;
  try {
    const d = await api(`/api/sites/${FM.siteId}/files`);
    FM.files = d.files;
    renderFm();
  } catch (e) { box.innerHTML = `<div class="empty">Couldn't load files.</div>`; }
}

function fmEntries() {
  // build folder listing for FM.dir from flat file list
  const prefix = FM.dir ? FM.dir + "/" : "";
  const dirs = new Set(), files = [];
  for (const f of FM.files) {
    const rel = f.path.startsWith("/") ? f.path.slice(1) : f.path;
    if (!rel.startsWith(prefix)) continue;
    const rest = rel.slice(prefix.length);
    if (!rest) continue;
    const slash = rest.indexOf("/");
    if (slash === -1) files.push({ ...f, name: rest });
    else dirs.add(rest.slice(0, slash));
  }
  return { dirs: [...dirs].sort(), files: files.sort((a, b) => a.name.localeCompare(b.name)) };
}

function fileIcon(name) {
  if (/\.(png|jpe?g|gif|webp|svg|ico)$/i.test(name)) return ICONS.img;
  return ICONS.file;
}

function renderFm() {
  const { dirs, files } = fmEntries();
  // breadcrumbs
  const parts = FM.dir ? FM.dir.split("/") : [];
  let crumbs = `<button data-crumb="" class="${!FM.dir ? "on" : ""}">/</button>`;
  let acc = "";
  parts.forEach((p, i) => {
    acc += (acc ? "/" : "") + p;
    crumbs += `<button data-crumb="${esc(acc)}" class="${i === parts.length - 1 ? "on" : ""}">${esc(p)}</button>`;
  });
  $("#crumbs").innerHTML = crumbs;
  $$("#crumbs [data-crumb]").forEach((b) => b.addEventListener("click", () => { FM.dir = b.dataset.crumb; renderFm(); }));
  $("#files-sub").textContent = `${FM.files.length} files · tap a file to open its URL`;

  const box = $("#files-list");
  if (!dirs.length && !files.length) {
    box.innerHTML = `<div class="empty">${ICONS.folder}<b>Empty folder</b>Upload files with the + button above.</div>`;
    return;
  }
  box.innerHTML =
    dirs.map((d) => `<div class="frow dir" data-dir="${esc(d)}">
        <div class="fic">${ICONS.folder}</div>
        <div class="fn">${esc(d)}<small>folder</small></div>
      </div>`).join("") +
    files.map((f) => {
      const full = (FM.dir ? FM.dir + "/" : "") + f.name;
      const url = `https://${FM.site.subdomain}.${BASE}/${full}`;
      return `<div class="frow" data-file="${esc(full)}">
        <div class="fic">${fileIcon(f.name)}</div>
        <div class="fn">${esc(f.name)}<small>${fmtMB(f.size)}${f.name === "index.html" && !FM.dir ? " · homepage" : ""}</small></div>
        <button class="fopen" data-openfile="${esc(url)}">Open</button>
        <button class="fdel" data-delfile="${esc(full)}" aria-label="Delete">${ICONS.trash}</button>
      </div>`;
    }).join("");
  $$("#files-list [data-dir]").forEach((el) => el.addEventListener("click", () => {
    FM.dir = FM.dir ? FM.dir + "/" + el.dataset.dir : el.dataset.dir;
    renderFm();
  }));
  $$("#files-list [data-openfile]").forEach((b) => b.addEventListener("click", (e) => {
    e.stopPropagation(); window.open(b.dataset.openfile, "_blank", "noopener");
  }));
  $$("#files-list [data-delfile]").forEach((b) => b.addEventListener("click", (e) => {
    e.stopPropagation();
    const p = b.dataset.delfile;
    confirmDlg("Delete file?", "/" + p + " will be removed from your site.", "Delete", async () => {
      try {
        await api(`/api/sites/${FM.siteId}/files`, { method: "DELETE", body: JSON.stringify({ path: "/" + p }) });
        toast("File deleted.");
        loadFmFiles(); loadSites();
      } catch (err) { toast(err.message); }
    });
  }));
}

// upload into current folder
$("#files-upload-btn").addEventListener("click", () => $("#files-input").click());
$("#files-input").addEventListener("change", async (e) => {
  const picked = [...e.target.files];
  e.target.value = "";
  if (!picked.length) return;
  toast(`Uploading ${picked.length} file(s)…`);
  let okN = 0;
  for (const f of picked) {
    const name = (FM.dir ? FM.dir + "/" : "") + f.name;
    try {
      let bytes = new Uint8Array(await f.arrayBuffer());
      if (ME.tier === "free" && name.toLowerCase() === "index.html" && !FM.dir) {
        try { bytes = injectBadge(new TextDecoder().decode(bytes)); } catch {}
      }
      const r = await fetch(`/api/sites/${FM.siteId}/files`, {
        method: "POST", headers: { "X-Filename": name }, body: bytes });
      const d = await r.json().catch(() => ({}));
      if (d.ok) okN++;
      else toast(d.message || `Failed: ${f.name}`);
    } catch { toast(`Failed: ${f.name}`); }
  }
  if (okN) { toast(`Uploaded ${okN} file(s).`); loadFmFiles(); loadSites(); }
});

// ---------- billing ----------
let billPeriod = "monthly";
async function renderBilling() {
  const box = $("#billing-box");
  const sub = ME.subscription;
  box.innerHTML = `<div class="plan-hero"><h3>${TIERS[ME.tier].name} plan</h3>
    <p>${sub ? `Active until ${new Date(sub.ends_at).toLocaleDateString()}` : "Free forever. Upgrade for more sites & storage."}</p></div>
    <div style="display:flex;gap:8px;margin-bottom:14px">
      <button class="btn btn-ghost btn-sm" data-p="monthly" style="${billPeriod === "monthly" ? "border-color:var(--brand);color:var(--brand)" : ""}">Monthly</button>
      <button class="btn btn-ghost btn-sm" data-p="yearly" style="${billPeriod === "yearly" ? "border-color:var(--brand);color:var(--brand)" : ""}">Yearly · 2 months free</button>
    </div>
    <div id="tier-list"></div>`;
  $$("#billing-box [data-p]").forEach((b) => b.addEventListener("click", () => { billPeriod = b.dataset.p; renderBilling(); }));
  const tl = $("#tier-list");
  tl.innerHTML = ["starter", "pro", "business"].map((k) => {
    const t = TIERS[k];
    const price = billPeriod === "yearly" ? t.price * 10 : t.price;
    const cur = ME.tier === k;
    return `<div class="tier-card ${cur ? "cur" : ""}">
      <div class="top"><h4>${t.name}</h4><div class="amt">৳${price}<small>/${billPeriod === "yearly" ? "yr" : "mo"}</small></div></div>
      <ul>${t.features.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>
      ${cur ? `<span class="pill live">Current plan</span>`
        : `<button class="btn ${k === "starter" ? "btn-primary" : "btn-ghost"} btn-block" data-up="${k}">Upgrade to ${t.name}</button>`}
    </div>`;
  }).join("");
  $$("#tier-list [data-up]").forEach((b) => b.addEventListener("click", () => checkout(b.dataset.up, billPeriod)));
}

async function checkout(tier, period) {
  try {
    toast("Creating secure payment…");
    const d = await api("/api/billing/checkout", { method: "POST", body: JSON.stringify({ tier, period }) });
    location.href = d.pay_url;
  } catch (e) { toast(e.message); }
}

// ---------- account ----------
function renderAccount() {
  const initial = (ME.user.name || "?").slice(0, 1).toUpperCase();
  $("#account-box").innerHTML = `
    <div class="acct-card"><div class="avatar">${esc(initial)}</div>
      <div><div class="n">${esc(ME.user.name)}</div><div class="e">${esc(ME.user.email)}</div></div></div>
    <button class="list-row" id="row-showcase">${ICONS.globe} View public showcase <span class="chev">›</span></button>
    <button class="list-row danger" id="row-logout">${ICONS.out} Log out <span class="chev">›</span></button>`;
  $("#row-showcase").addEventListener("click", () => (location.href = "/#showcase"));
  $("#row-logout").addEventListener("click", async () => {
    await fetch("/api/logout", { method: "POST" });
    location.href = "/";
  });
}

boot();
