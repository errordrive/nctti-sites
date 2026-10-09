// Admin panel logic.
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function toast(m) { const t = $("#toast"); t.textContent = m; t.classList.add("show"); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove("show"), 2200); }

async function api(path, opts = {}) {
  const r = await fetch(path, { headers: { "Content-Type": "application/json" }, ...opts });
  if (r.status === 401 || r.status === 403) { location.href = "/"; return; }
  const d = await r.json().catch(() => ({}));
  if (!d.ok) throw new Error(d.message || "Request failed");
  return d;
}

let view = "users";
$$(".tab").forEach((t) => t.addEventListener("click", () => {
  $$(".tab").forEach((x) => x.classList.remove("on"));
  t.classList.add("on"); view = t.dataset.v; load();
}));

async function load() {
  const box = $("#view");
  try {
    if (view === "users") {
      const d = await api("/api/admin/users");
      box.innerHTML = `<table class="tbl"><tr><th>ID</th><th>Name</th><th>Email</th><th>Admin</th><th>Status</th><th></th></tr>` +
        d.users.map((u) => `<tr><td>${u.id}</td><td>${esc(u.name)}</td><td class="mono">${esc(u.email)}</td>
          <td>${u.is_admin ? "yes" : ""}</td><td>${u.suspended ? '<span class="pill susp">suspended</span>' : '<span class="pill live">active</span>'}</td>
          <td>${u.is_admin ? "" : `<button class="btn btn-ghost btn-sm" data-su="${u.id}" data-s="${u.suspended ? 0 : 1}">${u.suspended ? "Unsuspend" : "Suspend"}</button>`}</td></tr>`).join("") + `</table>`;
      $$("[data-su]").forEach((b) => b.addEventListener("click", async () => {
        await api(`/api/admin/users/${b.dataset.su}/suspend`, { method: "POST", body: JSON.stringify({ suspended: b.dataset.s === "1" }) });
        toast("Updated."); load();
      }));
    } else if (view === "sites") {
      const d = await api("/api/admin/sites");
      box.innerHTML = `<table class="tbl"><tr><th>Subdomain</th><th>Owner</th><th>Published</th><th>Status</th><th></th></tr>` +
        d.sites.map((s) => `<tr><td class="mono">${esc(s.subdomain)}</td><td class="mono">${esc(s.owner_email)}</td>
          <td>${s.published ? "yes" : "no"}</td><td>${s.suspended ? '<span class="pill susp">suspended</span>' : '<span class="pill live">ok</span>'}</td>
          <td><a class="btn btn-ghost btn-sm" href="${s.url}" target="_blank" rel="noopener">Open</a>
          <button class="btn btn-ghost btn-sm" data-ss="${s.id}" data-s="${s.suspended ? 0 : 1}">${s.suspended ? "Unsuspend" : "Suspend"}</button></td></tr>`).join("") + `</table>`;
      $$("[data-ss]").forEach((b) => b.addEventListener("click", async () => {
        await api(`/api/admin/sites/${b.dataset.ss}/suspend`, { method: "POST", body: JSON.stringify({ suspended: b.dataset.s === "1" }) });
        toast("Updated."); load();
      }));
    } else {
      const d = await api("/api/admin/orders");
      box.innerHTML = d.orders.length ? `<table class="tbl"><tr><th>Order</th><th>User</th><th>Tier</th><th>Amount</th><th>Status</th><th>TrxID</th><th>Created</th></tr>` +
        d.orders.map((o) => `<tr><td class="mono">${esc(o.order_ref)}</td><td class="mono">${esc(o.owner_email)}</td>
          <td>${esc(o.tier)} (${esc(o.period)})</td><td>৳${o.amount}</td>
          <td>${o.status === "active" ? '<span class="pill live">active</span>' : '<span class="pill draft">pending</span>'}</td>
          <td class="mono">${esc(o.trx_id || "—")}</td><td class="mono">${esc(o.created_at)}</td></tr>`).join("") + `</table>`
        : `<div class="empty">No orders yet.</div>`;
    }
  } catch (e) { box.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}
load();
