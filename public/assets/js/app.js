// Dashboard logic.
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtMB = (b) => (b / 1048576).toFixed(1) + " MB";

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg; t.classList.add("show");
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove("show"), 2600);
}

async function api(path, opts = {}) {
  const r = await fetch(path, { headers: { "Content-Type": "application/json" }, ...opts });
  if (r.status === 401) { location.href = "/"; return; }
  const d = await r.json().catch(() => ({}));
  if (!d.ok) throw new Error(d.message || "Request failed");
  return d;
}

let ME = null, TIERS = null, BASE = "";

async function boot() {
  const d = await api("/api/me").catch(() => null);
  if (!d) { location.href = "/"; return; }
  ME = d;
  const t = await api("/api/tiers");
  TIERS = t.tiers; BASE = t.base_domain;
  $("#base-domain").textContent = "." + BASE;
  $("#user-name").textContent = ME.user.name;
  renderPlan();
  loadSites();
  // plan pre-selected from landing pricing?
  const q = new URLSearchParams(location.search);
  if (q.get("plan")) checkout(q.get("plan"), q.get("period") || "monthly");
  if (q.get("billing") === "done") toast("Payment received — your plan activates shortly.");
}

function renderPlan() {
  const tier = TIERS[ME.tier];
  $("#plan-banner").innerHTML = `
    <div class="plan-banner">
      <div><h3>${tier.name} plan</h3>
      <p>${ME.subscription ? `Renews ${new Date(ME.subscription.ends_at).toLocaleDateString()}` : "Free forever. Upgrade for more sites & storage."}</p></div>
      ${ME.tier === "free" ? `<a class="btn" href="#billing" style="text-decoration:none">Upgrade from ৳29</a>` : ""}
    </div>`;
  renderBilling();
}

function renderBilling() {
  const order = ["free", "starter", "pro", "business"];
  $("#billing").innerHTML = `
    <p style="color:var(--muted);font-size:14px;margin-bottom:16px">Pay with bKash, Nagad or Rocket. Payment is verified automatically.</p>
    <div class="price-grid" style="grid-template-columns:repeat(4,1fr)">
    ${order.map((k) => {
      const t = TIERS[k];
      const cur = ME.tier === k;
      return `<div class="price-card ${cur ? "hot" : ""}" style="padding:20px">
        <h3>${t.name}</h3>
        <div class="amount" style="font-size:26px">৳${t.price}<small> /mo</small></div>
        <ul style="margin:10px 0 14px">${t.features.slice(0, 3).map((f) => `<li>${esc(f)}</li>`).join("")}</ul>
        ${cur ? `<span class="pill live">Current plan</span>`
          : t.price === 0 ? `<span class="pill draft">Free</span>`
          : `<button class="btn btn-primary btn-sm" data-up="${k}">Upgrade</button>`}
      </div>`;
    }).join("")}</div>
    <div class="bill-toggle" style="justify-content:flex-start;margin:16px 0 0">
      <button class="tab on" data-p="monthly">Monthly</button>
      <button class="tab" data-p="yearly">Yearly <span class="save">2 months free</span></button>
    </div>`;
  let period = "monthly";
  $$("#billing .bill-toggle .tab").forEach((x) => x.addEventListener("click", () => {
    $$("#billing .bill-toggle .tab").forEach((y) => y.classList.remove("on"));
    x.classList.add("on"); period = x.dataset.p;
  }));
  $$("#billing [data-up]").forEach((b) => b.addEventListener("click", () => checkout(b.dataset.up, period)));
}

async function checkout(tier, period) {
  try {
    toast("Creating secure payment…");
    const d = await api("/api/billing/checkout", {
      method: "POST", body: JSON.stringify({ tier, period }),
    });
    location.href = d.pay_url;
  } catch (e) { toast(e.message); }
}

async function loadSites() {
  const d = await api("/api/sites");
  const box = $("#sites");
  if (!d.sites.length) {
    box.innerHTML = `<div class="empty">No sites yet. Create your first one — it takes 10 seconds.</div>`;
    return;
  }
  box.innerHTML = d.sites.map((s) => `
    <div class="site-row" data-id="${s.id}">
      <div class="info">
        <div class="t">${esc(s.title || s.subdomain)}</div>
        <a class="u" href="${s.url}" target="_blank" rel="noopener">${s.subdomain}.${BASE}</a>
        <div style="font-size:12.5px;color:var(--muted);margin-top:4px">${fmtMB(s.storage_bytes)} used · ♥ ${s.likes}</div>
      </div>
      <span class="pill ${s.suspended ? "susp" : s.published ? "live" : "draft"}">${s.suspended ? "suspended" : s.published ? "live" : "draft"}</span>
      <label class="btn btn-ghost btn-sm" style="cursor:pointer">Upload zip<input type="file" accept=".zip" hidden data-deploy="${s.id}"></label>
      <button class="btn btn-ghost btn-sm" data-pub="${s.id}">${s.published ? "Unpublish" : "Publish"}</button>
      <button class="btn btn-ghost btn-sm" data-edit="${s.id}">Edit</button>
      <button class="btn btn-danger btn-sm" data-del="${s.id}">Delete</button>
    </div>`).join("");

  $$("[data-deploy]").forEach((inp) => inp.addEventListener("change", async () => {
    const f = inp.files[0]; if (!f) return;
    toast("Uploading & deploying…");
    const fd = new FormData(); fd.append("file", f);
    try {
      const r = await fetch(`/api/sites/${inp.dataset.deploy}/deploy`, { method: "POST", body: fd });
      const dd = await r.json();
      if (!dd.ok) throw new Error(dd.message);
      toast(`Deployed ${dd.files} files.`);
      loadSites();
    } catch (e) { toast(e.message); }
    inp.value = "";
  }));
  $$("[data-pub]").forEach((b) => b.addEventListener("click", async () => {
    try {
      const cur = b.textContent.trim() === "Unpublish";
      await api(`/api/sites/${b.dataset.pub}`, { method: "PATCH", body: JSON.stringify({ published: !cur }) });
      toast(cur ? "Unpublished." : "Published to showcase!");
      loadSites();
    } catch (e) { toast(e.message); }
  }));
  $$("[data-del]").forEach((b) => b.addEventListener("click", async () => {
    if (!confirm("Delete this site permanently?")) return;
    await api(`/api/sites/${b.dataset.del}`, { method: "DELETE" });
    toast("Site deleted."); loadSites();
  }));
  $$("[data-edit]").forEach((b) => b.addEventListener("click", async () => {
    const row = b.closest(".site-row");
    const id = b.dataset.edit;
    const title = prompt("Site title:", row.querySelector(".t").textContent);
    if (title === null) return;
    const desc = prompt("Short description (for showcase):", "");
    try {
      await api(`/api/sites/${id}`, { method: "PATCH", body: JSON.stringify({ title, description: desc || "" }) });
      toast("Saved."); loadSites();
    } catch (e) { toast(e.message); }
  }));
}

// new site modal
const modal = $("#site-modal");
$("#new-site-btn").addEventListener("click", () => { $("#site-err").classList.remove("show"); modal.classList.add("show"); });
modal.addEventListener("click", (e) => { if (e.target === modal) modal.classList.remove("show"); });
$("#create-site").addEventListener("click", async () => {
  const btn = $("#create-site"), errBox = $("#site-err");
  errBox.classList.remove("show"); btn.disabled = true;
  try {
    const d = await api("/api/sites", { method: "POST", body: JSON.stringify({
      subdomain: $("#new-sub").value.trim(), title: $("#new-title").value.trim(),
    })});
    modal.classList.remove("show");
    $("#new-sub").value = ""; $("#new-title").value = "";
    toast(`Created! Upload a zip to go live.`);
    loadSites();
  } catch (e) { errBox.textContent = e.message; errBox.classList.add("show"); }
  finally { btn.disabled = false; }
});

$("#logout").addEventListener("click", async () => {
  await fetch("/api/logout", { method: "POST" });
  location.href = "/";
});

boot();
