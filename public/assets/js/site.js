// Landing page logic: auth modal, showcase, pricing, services.
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove("show"), 2600);
}

async function api(path, opts = {}) {
  const r = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  const d = await r.json().catch(() => ({}));
  if (!d.ok) throw new Error(d.message || "Request failed");
  return d;
}

// ---------- auth modal ----------
let mode = "signup";
const modal = $("#auth-modal");

function openAuth(m) {
  mode = m;
  $("#auth-title").textContent = m === "signup" ? "Create your account" : "Welcome back";
  $("#auth-sub").textContent = m === "signup" ? "Free subdomain included. No credit card." : "Log in to manage your sites.";
  $("#name-field").style.display = m === "signup" ? "" : "none";
  $("#auth-go").textContent = m === "signup" ? "Create free account" : "Log in";
  $("#auth-toggle").textContent = m === "signup" ? "Log in" : "Sign up";
  $("#auth-switch").firstChild.textContent = m === "signup" ? "Already have an account? " : "New here? ";
  $("#auth-err").classList.remove("show");
  modal.classList.add("show");
}
modal.addEventListener("click", (e) => { if (e.target === modal) modal.classList.remove("show"); });
$("#auth-toggle").addEventListener("click", (e) => { e.preventDefault(); openAuth(mode === "signup" ? "login" : "signup"); });
$$("[data-auth]").forEach((b) => b.addEventListener("click", () => openAuth(b.dataset.auth)));

$("#auth-go").addEventListener("click", async () => {
  const btn = $("#auth-go");
  const errBox = $("#auth-err");
  errBox.classList.remove("show");
  btn.disabled = true;
  try {
    const body = {
      email: $("#auth-email").value.trim(),
      password: $("#auth-pass").value,
    };
    if (mode === "signup") body.name = $("#auth-name").value.trim();
    const d = await api(mode === "signup" ? "/api/signup" : "/api/login", {
      method: "POST", body: JSON.stringify(body),
    });
    toast(mode === "signup" ? `Welcome, ${d.user.name}!` : "Logged in.");
    setTimeout(() => (location.href = "/app"), 600);
  } catch (e) {
    errBox.textContent = e.message;
    errBox.classList.add("show");
  } finally {
    btn.disabled = false;
  }
});

// ---------- nav state ----------
api("/api/me").then((d) => {
  $("#nav-auth").innerHTML =
    `<a class="btn btn-ghost btn-sm" href="/app">Dashboard</a>` +
    (d.user.is_admin ? `<a class="btn btn-ghost btn-sm" href="/admin">Admin</a>` : "");
}).catch(() => {});

// ---------- showcase ----------
let sort = "trending";
async function loadShowcase() {
  const grid = $("#showcase-grid");
  try {
    const d = await api(`/api/showcase?sort=${sort}`);
    if (!d.items.length) {
      grid.innerHTML = `<div class="empty">No projects yet — yours could be the first.</div>`;
      return;
    }
    grid.innerHTML = d.items.map((s) => `
      <div class="show-card">
        <div class="t">${esc(s.title || s.subdomain)}</div>
        <a class="u" href="${s.url}" target="_blank" rel="noopener">${s.url.replace("https://", "")}</a>
        <div class="d">${esc(s.description || "No description yet.")}</div>
        <div class="row">
          <span style="font-size:13px;color:var(--muted)">by ${esc(s.owner)}</span>
          <button class="like-btn ${s.liked ? "liked" : ""}" data-id="${s.id}">♥ ${s.likes}</button>
        </div>
      </div>`).join("");
    $$(".like-btn").forEach((b) => b.addEventListener("click", async () => {
      try {
        const r = await api(`/api/sites/${b.dataset.id}/like`, { method: "POST" });
        b.classList.toggle("liked", r.liked);
        b.textContent = `♥ ${r.likes}`;
      } catch (e) { toast("Log in to like projects."); openAuth("login"); }
    }));
  } catch { grid.innerHTML = `<div class="empty">Couldn't load showcase.</div>`; }
}
$$(".tab[data-sort]").forEach((t) => t.addEventListener("click", () => {
  $$(".tab[data-sort]").forEach((x) => x.classList.remove("on"));
  t.classList.add("on");
  sort = t.dataset.sort;
  loadShowcase();
}));
function esc(s) { return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

// ---------- pricing ----------
let period = "monthly";
const ORDER = ["free", "starter", "pro", "business"];
async function loadPricing() {
  const d = await api("/api/tiers");
  const grid = $("#pricing-grid");
  grid.innerHTML = ORDER.map((key) => {
    const t = d.tiers[key];
    const price = period === "yearly" && t.price ? t.price * 10 : t.price;
    const per = t.price === 0 ? "forever" : (period === "yearly" ? "/year" : "/month");
    return `<div class="price-card ${key === "starter" ? "hot" : ""}">
      ${key === "starter" ? `<span class="badge">POPULAR</span>` : ""}
      <h3>${t.name}</h3>
      <div class="amount">৳${price}<small> ${per}</small></div>
      <ul>${t.features.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>
      ${t.price === 0
        ? `<button class="btn btn-ghost" data-auth="signup" style="width:100%">Start free</button>`
        : `<button class="btn ${key === "starter" ? "btn-primary" : "btn-ghost"}" data-plan="${key}" style="width:100%">Choose ${t.name}</button>`}
    </div>`;
  }).join("");
  $$("#pricing-grid [data-auth]").forEach((b) => b.addEventListener("click", () => openAuth("signup")));
  $$("#pricing-grid [data-plan]").forEach((b) => b.addEventListener("click", async () => {
    try { await api("/api/me"); location.href = `/app?plan=${b.dataset.plan}&period=${period}`; }
    catch { openAuth("signup"); toast("Create a free account first, then upgrade."); }
  }));
}
$$(".bill-toggle .tab").forEach((t) => t.addEventListener("click", () => {
  $$(".bill-toggle .tab").forEach((x) => x.classList.remove("on"));
  t.classList.add("on");
  period = t.dataset.period;
  loadPricing();
}));

// ---------- services (NCTTI agency) ----------
const SERVICES = [
  { t: "Business Websites", p: "৳35K – ৳70K", d: "Fast, modern websites that turn visitors into customers." },
  { t: "E-commerce Stores", p: "৳60K – ৳1.5L", d: "bKash/Nagad-ready online stores built to sell." },
  { t: "AI Chatbots", p: "৳50K – ৳1.2L", d: "Bangla + English AI support bots for your business." },
  { t: "Custom MVPs", p: "৳2L – ৳6L", d: "Your startup idea, designed and built end-to-end." },
  { t: "Mobile Apps", p: "৳2.5L – ৳8L", d: "Android & iOS apps with clean, native-feeling UX." },
  { t: "Marketing Retainer", p: "৳25K – ৳60K/mo", d: "Content, ads and growth — handled monthly." },
];
$("#services-grid").innerHTML = SERVICES.map((s) => `
  <div class="card"><h3>${s.t}</h3>
  <div style="font-weight:800;color:var(--brand);margin:4px 0 8px">${s.p}</div>
  <p>${s.d}</p></div>`).join("");

loadShowcase();
loadPricing();
