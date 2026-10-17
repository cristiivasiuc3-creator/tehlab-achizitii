/* Tehlab Service — Panou de monitorizare a achizițiilor */
"use strict";

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const state = {
  route: "prezentare",
  page: 1,
  sort: "deadline",
  filters: {},
  stats: null,
};

const STATUS_LABEL = {
  active: "ACTIVĂ",
  upcoming: "PROGRAMATĂ",
  check: "DE VERIFICAT",
  expired: "EXPIRATĂ",
};

const ROUTE_CATEGORY = { active: "active", viitoare: "upcoming", verificare: "check" };
const ROUTE_TITLES = {
  prezentare: ["Monitorizare achiziții", "Oportunități relevante pentru Tehlab Service"],
  active: ["Achiziții active — 2026", "Proceduri verificate, cu termen-limită viitor"],
  viitoare: ["Urmează 2026–2027", "Proceduri anunțate oficial, depunerea încă nu a început"],
  verificare: ["Necesită verificare", "Statutul sau termenul-limită nu au putut fi confirmate"],
  salvate: ["Achiziții salvate", "Oportunitățile tale, cu note și termene"],
  rapoarte: ["Rapoarte și istoric", "Istoricul actualizărilor și exporturi"],
};

/* ---------- MOD LOCAL (versiune de prezentare, date înghețate) ---------- */
const LOCAL = typeof window !== "undefined" && !!window.DATA;

const localSaved = {
  get: () => JSON.parse(localStorage.getItem("tehlab_saved") || "{}"),
  set: (v) => localStorage.setItem("tehlab_saved", JSON.stringify(v)),
};

function localApi(url, opts = {}) {
  const u = new URL(url, "http://x");
  const path = u.pathname;
  const p = u.searchParams;
  const data = window.DATA;

  if (path === "/api/me") return { auth_required: false, authenticated: true };
  if (path === "/api/stats") {
    const s = { ...data.stats, saved: Object.keys(localSaved.get()).length };
    return s;
  }
  if (path === "/api/refresh/status")
    return { running: false, message: "", last_result: null };
  if (path === "/api/runs") return data.runs;
  if (path === "/api/changes") return data.changes;

  if (path === "/api/tenders" || path.startsWith("/api/tenders/")) {
    const single = path.match(/^\/api\/tenders\/(\w+)$/);
    let items = data.tenders.slice();
    if (single) {
      const t = items.find(x => x.id === single[1]);
      if (!t) throw new Error("404");
      const sv = localSaved.get()[t.id];
      return { ...t, changes: data.changes.filter(c => c.tender_id === t.id),
               saved: sv ? { tender_id: t.id, note: sv, done: 0 } : null };
    }
    const cat = p.get("category");
    if (cat) { const cs = cat.split(","); items = items.filter(t => cs.includes(t.category)); }
    const q = (p.get("q") || "").toLowerCase();
    if (q) items = items.filter(t => [t.title, t.buyer, t.cpv, t.id].some(v => (v || "").toLowerCase().includes(q)));
    const cpv = p.get("cpv");
    if (cpv) items = items.filter(t => (t.cpv || "").startsWith(cpv));
    const buyer = (p.get("buyer") || "").toLowerCase();
    if (buyer) items = items.filter(t => (t.buyer || "").toLowerCase().includes(buyer));
    const dto = p.get("deadline_to");
    if (dto) items = items.filter(t => t.deadline_dt && t.deadline_dt <= dto);
    const bmin = parseFloat(p.get("budget_min")); if (!isNaN(bmin)) items = items.filter(t => parseFloat((t.budget || "").replace(/\s/g, "").replace(",", ".")) >= bmin);
    const bmax = parseFloat(p.get("budget_max")); if (!isNaN(bmax)) items = items.filter(t => parseFloat((t.budget || "").replace(/\s/g, "").replace(",", ".")) <= bmax);
    const sort = p.get("sort") || "deadline";
    const val = t => parseFloat((t.budget || "").replace(/\s/g, "").replace(",", ".")) || 0;
    if (sort === "deadline_desc") items.sort((a, b) => (b.deadline_dt || "").localeCompare(a.deadline_dt || ""));
    else if (sort === "published_desc") items.sort((a, b) => (b.published_dt || "").localeCompare(a.published_dt || ""));
    else if (sort === "budget_desc") items.sort((a, b) => val(b) - val(a));
    else items.sort((a, b) => (a.deadline_dt || "9999").localeCompare(b.deadline_dt || "9999"));
    const per = Math.min(100, Math.max(5, parseInt(p.get("per_page") || 12)));
    const page = Math.max(1, parseInt(p.get("page") || 1));
    const total = items.length;
    const savedMap = localSaved.get();
    items = items.slice((page - 1) * per, page * per)
                 .map(t => ({ ...t, saved: t.id in savedMap }));
    return { items, total, page, per_page: per };
  }

  if (path === "/api/saved") {
    const m = JSON.parse(opts.body || "{}");
    const s = localSaved.get(); s[m.tender_id] = m.note || ""; localSaved.set(s);
    return { ok: true };
  }
  const sv = path.match(/^\/api\/saved\/(\w+)$/);
  if (sv) {
    const s = localSaved.get();
    if (opts.method === "DELETE") delete s[sv[1]];
    else { const m = JSON.parse(opts.body || "{}"); s[sv[1]] = m.note || ""; }
    localSaved.set(s);
    return { ok: true };
  }
  if (path === "/api/refresh")
    return { ok: false, message: "În versiunea de prezentare actualizarea e dezactivată (datele sunt înghețate)." };
  throw new Error("endpoint necunoscut: " + path);
}

async function api(url, opts = {}) {
  if (LOCAL) return localApi(url, opts);
  if (opts.body) {
    opts.headers = { "Content-Type": "application/json" };
  }
  const r = await fetch(url, opts);
  if (r.status === 401) { showLogin(); throw new Error("401"); }
  return r.json();
}

const esc = (s) => (s ?? "").toString().replace(/[&<>"']/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const fmtDate = (iso) => {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleDateString("ro-RO", { day: "2-digit", month: "2-digit", year: "numeric" });
};
const fmtDateTime = (iso) => {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString("ro-RO", { day: "2-digit", month: "2-digit", year: "numeric",
                                     hour: "2-digit", minute: "2-digit" });
};
const daysLeft = (iso) => {
  if (!iso) return null;
  return Math.ceil((new Date(iso) - Date.now()) / 86400000);
};

/* ---------------- auth ---------------- */
async function initAuth() {
  const me = await api("/api/me");
  if (me.authenticated) { $("#app").hidden = false; boot(); }
  else showLogin();
}
function showLogin() {
  $("#login-overlay").hidden = false;
  $("#app").hidden = true;
}
$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const r = await fetch("/api/login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: $("#login-pass").value }),
  });
  if (r.ok) { $("#login-overlay").hidden = true; $("#app").hidden = false; boot(); }
  else $("#login-error").hidden = false;
});
$("#btn-logout").addEventListener("click", async () => {
  await fetch("/api/logout", { method: "POST" }); location.reload();
});

/* ---------------- router ---------------- */
function router() {
  const hash = location.hash.replace("#/", "") || "prezentare";
  state.route = hash in ROUTE_TITLES ? hash : "prezentare";
  state.page = 1;
  render();
}
window.addEventListener("hashchange", router);

async function render() {
  $$("#app nav a").forEach(a =>
    a.classList.toggle("active", a.dataset.nav === state.route));
  const [t, s] = ROUTE_TITLES[state.route];
  $("#page-title").textContent = t;
  $("#page-subtitle").textContent = s;
  ["prezentare", "list", "salvate", "rapoarte"].forEach(v =>
    $("#view-" + v).hidden = true);

  if (state.route === "prezentare") { $("#view-prezentare").hidden = false; renderOverview(); }
  else if (state.route === "salvate") { $("#view-salvate").hidden = false; renderSaved(); }
  else if (state.route === "rapoarte") { $("#view-rapoarte").hidden = false; renderReports(); }
  else { $("#view-list").hidden = false; renderList(); }
}

/* ---------------- overview ---------------- */
async function renderOverview() {
  const st = await api("/api/stats");
  state.stats = st;
  updateTopbar(st);

  const icons = {
    active: `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="none" stroke="#16a34a" stroke-width="2"/><circle cx="12" cy="12" r="3.5" fill="#16a34a"/></svg>`,
    upcoming: `<svg viewBox="0 0 24 24"><path d="M19 4h-1V2h-2v2H8V2H6v2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zm0 16H5V10h14v10z" fill="#2563eb"/></svg>`,
    check: `<svg viewBox="0 0 24 24"><path d="M15.5 14h-.79l-.28-.27a6.5 6.5 0 1 0-.7.7l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0A4.5 4.5 0 1 1 14 9.5 4.5 4.5 0 0 1 9.5 14z" fill="#d97706"/></svg>`,
    expiring7: `<svg viewBox="0 0 24 24"><path d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2zm1 11h-2V7h2zm0 4h-2v-2h2z" fill="#7c3aed"/></svg>`,
  };
  const bgc = { active: "#dcfce7", upcoming: "#dbeafe", check: "#fef3c7", expiring7: "#ede9fe" };
  const cards = [
    ["active", "Active acum", st.active, "Achiziții cu termen-limită viitor"],
    ["upcoming", "Urmează", st.upcoming, "Achiziții viitoare / anunțate"],
    ["check", "De verificat", st.check, "Necesită confirmarea statusului"],
    ["expiring7", "Termen în 7 zile", st.expiring7, "Aproape de termenul-limită"],
  ];
  $("#stat-cards").innerHTML = cards.map(([k, ttl, n, lbl]) => `
    <div class="card">
      <div class="ic" style="background:${bgc[k]}">${icons[k]}</div>
      <div class="ttl">${ttl}</div>
      <div class="num">${n}</div>
      <div class="lbl">${lbl}</div>
    </div>`).join("");

  const badge = $("#nav-check-badge");
  if (st.check > 0) { badge.textContent = st.check; badge.hidden = false; }

  // prioritate: termene apropiate
  const pri = await api("/api/tenders?category=active&deadline_to=" +
    new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10) + "&per_page=8");
  $("#priorities").innerHTML = pri.items.length ? pri.items.map(t => {
    const d = daysLeft(t.deadline_dt);
    return `<div class="prio-item">
      <div class="prio-date">${fmtDate(t.deadline_dt)}</div>
      <div><div class="prio-title t-title" data-id="${t.id}">${esc(t.title)}</div>
      <div class="prio-buyer">${esc(t.buyer)}</div></div>
      ${d !== null ? `<span class="chip">${d} zile</span>` : ""}
    </div>`;
  }).join("") : `<div class="empty">Nicio achiziție cu termen apropiat.</div>`;

  const lat = await api("/api/tenders?sort=published_desc&per_page=6&category=active,upcoming");
  $("#latest").innerHTML = lat.items.map(t => `
    <div class="prio-item">
      <div class="prio-date">${fmtDate(t.published_dt)}</div>
      <div><div class="prio-title t-title" data-id="${t.id}">${esc(t.title)}</div>
      <div class="prio-buyer">${esc(t.buyer)} · ${esc(t.budget || "—")} MDL</div></div>
      <span class="st st-${t.category}">${STATUS_LABEL[t.category]}</span>
    </div>`).join("");
  bindTitles();
}

function updateTopbar(st) {
  $("#updated-at").textContent = st.last_run
    ? "Actualizat: " + fmtDateTime(st.last_run.finished || st.last_run.started)
    : "Nicio actualizare încă";
  $("#btn-logout").hidden = !($("#login-overlay") && false);
}

/* ---------------- lista achiziții ---------------- */
function currentFilters() {
  const f = {};
  const q = $("#f-q").value.trim(); if (q) f.q = q;
  const cpv = $("#f-cpv").value.trim(); if (cpv) f.cpv = cpv;
  const buyer = $("#f-buyer").value.trim(); if (buyer) f.buyer = buyer;
  const bmin = $("#f-budget-min").value; if (bmin) f.budget_min = bmin;
  const bmax = $("#f-budget-max").value; if (bmax) f.budget_max = bmax;
  const dto = $("#f-deadline-to").value; if (dto) f.deadline_to = dto;
  return f;
}

async function renderList() {
  const cat = ROUTE_CATEGORY[state.route];
  const f = currentFilters();
  const qs = new URLSearchParams({ category: cat, page: state.page, per_page: 12,
    sort: state.sort, ...f });
  const data = await api("/api/tenders?" + qs);
  const body = $("#tenders-body");
  if (!data.items.length) {
    body.innerHTML = `<tr><td colspan="7" class="empty">Nicio achiziție găsită cu aceste filtre.</td></tr>`;
  } else {
    body.innerHTML = data.items.map(t => {
      const d = daysLeft(t.deadline_dt);
      const due = d !== null && d <= 7 && t.category === "active";
      return `<tr>
        <td><span class="t-title" data-id="${t.id}">${esc(t.title)}</span>
            <div class="t-cpv">CPV: ${esc((t.cpv || "").split(" - ")[0] || "—")} · ${esc(t.procedure || "")}</div></td>
        <td>${esc(t.buyer)}</td>
        <td>${fmtDate(t.published_dt)}</td>
        <td>${fmtDate(t.deadline_dt)}${due ? `<div><span class="st st-due">ÎN ${d} ZILE</span></div>` : ""}</td>
        <td style="white-space:nowrap">${esc(t.budget || "—")} ${esc(t.currency || "MDL")}</td>
        <td><span class="st st-${t.category}">${STATUS_LABEL[t.category]}</span></td>
        <td><button class="btn small ghost btn-save" data-id="${t.id}">${t.saved ? "✓ Salvat" : "Salvează"}</button></td>
      </tr>`;
    }).join("");
  }
  const pages = Math.max(1, Math.ceil(data.total / data.per_page));
  $("#table-count").textContent = `Afișate ${data.items.length} din ${data.total}`;
  $("#pg-info").textContent = `${data.page} / ${pages}`;
  $("#pg-prev").disabled = data.page <= 1;
  $("#pg-next").disabled = data.page >= pages;
  bindTitles();
  $$(".btn-save").forEach(b => b.onclick = () => toggleSave(b.dataset.id, b));
}

$("#f-apply").onclick = () => { state.page = 1; renderList(); };
$("#f-clear").onclick = () => {
  ["#f-q", "#f-cpv", "#f-buyer", "#f-budget-min", "#f-budget-max", "#f-deadline-to"]
    .forEach(s => $(s).value = "");
  state.page = 1; renderList();
};
$("#f-q").addEventListener("keydown", e => { if (e.key === "Enter") { state.page = 1; renderList(); } });
$("#pg-prev").onclick = () => { state.page--; renderList(); };
$("#pg-next").onclick = () => { state.page++; renderList(); };
$$(".table th.sortable").forEach(th => th.onclick = () => {
  state.sort = state.sort === "deadline" ? "deadline_desc" : "deadline";
  renderList();
});

/* ---------------- detalii (modal) ---------------- */
function bindTitles() {
  $$(".t-title").forEach(el => el.onclick = () => openDetail(el.dataset.id));
}

async function openDetail(id) {
  const t = await api("/api/tenders/" + id);
  const row = (k, v) => v ? `<div><b>${k}</b>${v}</div>` : "";
  $("#modal-content").innerHTML = `
    <h2 style="font-size:20px;margin-right:40px">${esc(t.title)}</h2>
    <p style="margin-top:6px"><span class="st st-${t.category}">${STATUS_LABEL[t.category]}</span>
      <span class="muted" style="margin-left:8px;font-size:12px">Motiv relevanță: ${esc(t.relevance_reason || "—")}</span></p>
    <div class="d-grid">
      ${row("Autoritate contractantă", esc(t.buyer))}
      ${row("IDNO", esc(t.buyer_idno))}
      ${row("Telefon", esc(t.buyer_phone))}
      ${row("Email", esc(t.buyer_email))}
      ${row("Data publicării", esc(t.published))}
      ${row("Termen-limită oferte", `<b style="color:var(--red)">${esc(t.deadline || "—")}</b>`)}
      ${row("Valoare estimată", (t.budget || "—") + " " + (t.currency || "MDL") + " (fără TVA)")}
      ${row("CPV", esc(t.cpv))}
      ${row("Tipul procedurii", esc(t.procedure))}
      ${row("MTender ID", esc(t.mtender_id))}
      ${row("Ultima verificare", fmtDateTime(t.last_checked))}
      ${row("Prima observare", fmtDateTime(t.first_seen))}
    </div>
    ${t.lots ? `<div style="margin-top:14px"><b style="font-size:12px;color:var(--muted)">LOTURI</b><p>${esc(t.lots)}</p></div>` : ""}
    ${t.changes && t.changes.length ? `<div style="margin-top:14px"><b style="font-size:12px;color:var(--muted)">ISTORIC MODIFICĂRI</b>
      ${t.changes.map(c => `<p style="font-size:12.5px;margin-top:4px">· ${fmtDateTime(c.at)} — ${esc(c.field)}: „${esc(c.old_value)}” → „${esc(c.new_value)}”</p>`).join("")}</div>` : ""}
    <div style="margin-top:20px;display:flex;gap:10px">
      <a class="btn" href="${esc(t.url)}" target="_blank" rel="noopener">Deschide pe achizitii.md ↗</a>
      <button class="btn ghost" id="modal-save">${t.saved ? "Elimină din salvate" : "Salvează"}</button>
    </div>`;
  $("#modal").hidden = false;
  $("#modal-save").onclick = () => toggleSave(t.id, $("#modal-save"), true, t.saved);
}
$("#modal-close").onclick = () => $("#modal").hidden = true;
$("#modal").addEventListener("click", e => { if (e.target.id === "modal") $("#modal").hidden = true; });
document.addEventListener("keydown", e => { if (e.key === "Escape") $("#modal").hidden = true; });

/* ---------------- salvate ---------------- */
async function toggleSave(id, btn, inModal = false, isSaved = false) {
  if (btn.textContent.includes("Elimină") || (!inModal && btn.textContent.includes("✓"))) {
    await api("/api/saved/" + id, { method: "DELETE" });
    if (inModal) { $("#modal").hidden = true; render(); }
    else { btn.textContent = "Salvează"; }
  } else {
    await api("/api/saved", { method: "POST", body: JSON.stringify({ tender_id: id }) });
    if (inModal) { $("#modal").hidden = true; render(); }
    else { btn.textContent = "✓ Salvat"; }
  }
}

async function renderSaved() {
  const data = await api("/api/tenders?per_page=100");
  const saved = data.items.filter(t => t.saved);
  // ia și salvatele care nu mai sunt pe prima pagină
  const el = $("#saved-list");
  if (!saved.length) { el.innerHTML = `<div class="empty">Nicio achiziție salvată încă. Deschide o achiziție și apasă „Salvează”.</div>`; return; }
  el.innerHTML = saved.map(t => `
    <div class="saved-item" data-id="${t.id}">
      <h4 class="t-title" data-id="${t.id}">${esc(t.title)}</h4>
      <div class="muted" style="font-size:12.5px">${esc(t.buyer)} · termen: ${esc(t.deadline || "—")} · ${esc(t.budget || "—")} MDL</div>
      <textarea placeholder="Notă internă (ex: persoana responsabilă, pregătirea ofertei…)"></textarea>
      <div style="margin-top:8px;display:flex;gap:10px">
        <button class="btn small">Salvează nota</button>
        <button class="btn small ghost rm">Elimină</button>
      </div>
    </div>`).join("");
  // atașează notele existente
  for (const t of saved) {
    const d = await api("/api/tenders/" + t.id);
    const card = el.querySelector(`.saved-item[data-id="${t.id}"]`);
    const ta = card.querySelector("textarea");
    ta.value = d.saved?.note || "";
    card.querySelector(".btn").onclick = async () => {
      await api("/api/saved/" + t.id, { method: "PATCH", body: JSON.stringify({ note: ta.value, done: false }) });
    };
    card.querySelector(".rm").onclick = async () => {
      await api("/api/saved/" + t.id, { method: "DELETE" }); renderSaved();
    };
  }
  bindTitles();
}

/* ---------------- rapoarte ---------------- */
async function renderReports() {
  const runs = await api("/api/runs");
  $("#runs-body").innerHTML = runs.length ? runs.map(r => `
    <tr><td>${fmtDateTime(r.started)}</td><td>${r.scanned}</td><td>${r.new_count}</td>
        <td>${r.updated}</td><td>${r.expired}</td>
        <td style="color:var(--red)">${esc(r.error || "")}</td></tr>`).join("")
    : `<tr><td colspan="6" class="empty">Nicio rulare încă. Apasă „Actualizează acum”.</td></tr>`;
  const ch = await api("/api/changes");
  $("#changes-body").innerHTML = ch.length ? ch.map(c => `
    <tr><td>${fmtDateTime(c.at)}</td><td class="t-title" data-id="${c.tender_id}">${esc(c.title || c.tender_id)}</td>
        <td>${esc(c.field)}</td><td>${esc(c.old_value)}</td><td>${esc(c.new_value)}</td></tr>`).join("")
    : `<tr><td colspan="5" class="empty">Nicio modificare înregistrată.</td></tr>`;
  const qs = new URLSearchParams({ ...currentFilters() });
  if (LOCAL) {
    $("#export-csv").removeAttribute("href");
    $("#export-pdf").removeAttribute("href");
    $("#export-csv").classList.add("ghost");
    $("#export-pdf").classList.add("ghost");
    $("#export-csv").textContent = "Export CSV — doar în versiunea cu server";
    $("#export-pdf").textContent = "Export PDF — doar în versiunea cu server";
  } else {
    $("#export-csv").href = "/api/export.csv?" + qs;
    $("#export-pdf").href = "/api/export.pdf?" + qs;
  }
  bindTitles();
}

/* ---------------- refresh ---------------- */
let pollTimer = null;
$("#btn-refresh").onclick = async () => {
  const r = await api("/api/refresh", { method: "POST" });
  if (LOCAL) {
    $("#refresh-status").hidden = false;
    $("#refresh-status-msg").textContent =
      "Versiune de prezentare: datele sunt înghețate (16.10.2026). Actualizarea automată funcționează în versiunea cu server.";
    setTimeout(() => { $("#refresh-status").hidden = true; }, 6000);
    return;
  }
  if (!r.ok) { $("#refresh-status").hidden = false; $("#refresh-status-msg").textContent = r.message; return; }
  pollRefresh();
};
async function pollRefresh() {
  clearTimeout(pollTimer);
  const st = await api("/api/refresh/status");
  $("#refresh-status").hidden = !st.running;
  $("#btn-refresh").disabled = st.running;
  $("#btn-refresh-label").textContent = st.running ? "Actualizare…" : "Actualizează acum";
  $("#refresh-status-msg").textContent = st.message;
  if (st.running) pollTimer = setTimeout(pollRefresh, 2000);
  else { $("#refresh-status").hidden = true; render(); }
}

/* ---------------- boot ---------------- */
let booted = false;
function boot() {
  if (booted) { render(); return; }
  booted = true;
  router();
  pollRefresh();
}
initAuth();
