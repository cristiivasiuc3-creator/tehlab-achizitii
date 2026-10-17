/* Tehlab Achiziții — aplicație mobilă (funcționează și cu server, și ca prezentare locală) */
const LOCAL = !!window.DATA;
const $  = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? "").replace(/[&<>"']/g,
  c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const STATUS = {
  active:   ["Activă",   "b-active"],
  upcoming: ["Viitoare", "b-upcoming"],
  check:    ["De verificat", "b-check"],
  expired:  ["Expirată", "b-expired"],
};
const PER_PAGE = 15;

let state = { tab: "acas", q: "", pages: { active: 1, upcoming: 1, check: 1 } };

/* ---------------- salvări locale (mod prezentare) ---------------- */
const LS_KEY = "tehlab_saved_v1";
const lsGet = () => { try { return JSON.parse(localStorage.getItem(LS_KEY) || "{}"); } catch { return {}; } };
const lsSet = o => localStorage.setItem(LS_KEY, JSON.stringify(o));

/* ---------------- strat de date ---------------- */
async function api(path, opts = {}) {
  if (LOCAL) return localApi(path, opts);
  const r = await fetch(path, { headers: { "Content-Type": "application/json" }, ...opts });
  return r.json();
}

function localApi(path, opts = {}) {
  const D = window.DATA;
  const saved = lsGet();
  const withSaved = t => ({ ...t, saved: !!saved[t.id], note: saved[t.id]?.note || "" });

  if (path.startsWith("/api/stats")) {
    const t = D.tenders.filter(x => !x.archived);
    const now = Date.now(), in7 = now + 7 * 864e5;
    return {
      active:   t.filter(x => x.category === "active").length,
      upcoming: t.filter(x => x.category === "upcoming").length,
      check:    t.filter(x => x.category === "check").length,
      expiring7: t.filter(x => x.category === "active" && x.deadline_dt &&
                    new Date(x.deadline_dt) > now && new Date(x.deadline_dt) < in7).length,
      last_run: D.runs[0] || null,
    };
  }
  if (path.startsWith("/api/tenders/")) {
    const id = path.split("/api/tenders/")[1].split("?")[0];
    const t = D.tenders.find(x => String(x.id) === String(id));
    if (t) { const w = withSaved(t); return { ...w, saved: w.saved ? { note: w.note } : null, changes: D.changes.filter(c => String(c.tender_id) === String(id)) }; }
    return {};
  }
  if (path.startsWith("/api/tenders")) {
    const p = new URLSearchParams(path.split("?")[1] || "");
    const cats = (p.get("category") || "").split(",").filter(Boolean);
    const q = (p.get("q") || "").toLowerCase();
    let items = D.tenders.filter(x => !x.archived);
    if (cats.length) items = items.filter(x => cats.includes(x.category));
    if (q) items = items.filter(x => (x.title + " " + x.buyer + " " + (x.cpv || "")).toLowerCase().includes(q));
    const sort = p.get("sort") || "deadline";
    const key = sort.startsWith("published") ? "published_dt" : "deadline_dt";
    const dir = sort.endsWith("desc") ? -1 : 1;
    items.sort((a, b) => {
      if (!a[key]) return 1; if (!b[key]) return -1;
      return (new Date(a[key]) - new Date(b[key])) * dir;
    });
    const page = +p.get("page") || 1, per = +p.get("per_page") || PER_PAGE;
    return { items: items.slice((page - 1) * per, page * per).map(withSaved),
             total: items.length, page, per_page: per };
  }
  if (path === "/api/saved" && opts.method === "POST") {
    const id = JSON.parse(opts.body).tender_id;
    const s = lsGet(); s[id] = { note: "" }; lsSet(s); return { ok: true };
  }
  if (path.startsWith("/api/saved/")) {
    const id = path.split("/api/saved/")[1];
    const s = lsGet();
    if (opts.method === "DELETE") delete s[id];
    if (opts.method === "PATCH") s[id] = { ...s[id], ...JSON.parse(opts.body) };
    lsSet(s); return { ok: true };
  }
  if (path.startsWith("/api/runs")) return D.runs;
  if (path.startsWith("/api/changes")) return D.changes;
  if (path === "/api/refresh") return { ok: false, message:
    "Versiune de prezentare: datele sunt înghețate. În aplicația instalată, actualizarea se face automat la 2 zile." };
  if (path === "/api/refresh/status") return { running: false, message: "" };
  return {};
}

/* ---------------- utilitare ---------------- */
const fmtDate = iso => {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("ro-RO", { day: "2-digit", month: "2-digit", year: "numeric" });
};
const fmtDateTime = iso => !iso ? "—" : new Date(iso).toLocaleString("ro-RO",
  { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
const daysLeft = iso => !iso ? null : Math.ceil((new Date(iso) - Date.now()) / 864e5);

function toast(msg, ms = 4500) {
  const t = document.createElement("div");
  t.className = "toast"; t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), ms);
}

/* ---------------- header ---------------- */
async function refreshHeader() {
  const st = await api("/api/stats");
  $("#hd-updated").textContent = st.last_run
    ? "Actualizat: " + fmtDateTime(st.last_run.finished || st.last_run.started)
    : "";
  return st;
}
$("#btn-refresh").onclick = async () => {
  const r = await api("/api/refresh", { method: "POST" });
  if (!r.ok) { toast(r.message || "Eroare la actualizare"); return; }
  $("#btn-refresh").disabled = true;
  $("#btn-refresh").textContent = "Se actualizează…";
  const poll = setInterval(async () => {
    const s = await api("/api/refresh/status");
    if (!s.running) {
      clearInterval(poll);
      $("#btn-refresh").disabled = false;
      $("#btn-refresh").textContent = "Actualizează";
      toast("Datele au fost actualizate.");
      render();
    }
  }, 2000);
};

/* ---------------- card achiziție ---------------- */
function tenderCard(t) {
  const d = daysLeft(t.deadline_dt);
  const [lbl, cls] = STATUS[t.category] || [t.category, "b-expired"];
  const due = t.category === "active" && d !== null && d <= 7 && d >= 0;
  return `<div class="tcard" data-id="${t.id}">
    <h3>${esc(t.title)}</h3>
    <div class="buyer">${esc(t.buyer)}</div>
    <div class="row">
      <div class="meta">Termen: <b>${fmtDate(t.deadline_dt)}</b>
        ${due ? `<span class="badge b-due" style="margin-left:6px">${d} ZILE</span>` : ""}</div>
      <span class="badge ${cls}">${lbl}</span>
    </div>
    <div class="row" style="margin-top:8px">
      <div class="budget">${esc(t.budget || "—")} ${esc(t.currency || "MDL")}</div>
      <div class="meta">Publicat: ${fmtDate(t.published_dt)}</div>
    </div>
  </div>`;
}

/* ---------------- vederi ---------------- */
async function renderHome() {
  const st = await refreshHeader();
  const main = $("main");
  main.innerHTML = `
    <div class="stats">
      <div class="stat"><span class="dot" style="background:var(--green)"></span>Active acum
        <div class="n">${st.active}</div><div class="l">cu termen-limită viitor</div></div>
      <div class="stat"><span class="dot" style="background:var(--blue)"></span>Viitoare
        <div class="n">${st.upcoming}</div><div class="l">anunțate / în pregătire</div></div>
      <div class="stat"><span class="dot" style="background:var(--amber)"></span>De verificat
        <div class="n">${st.check}</div><div class="l">necesită atenție</div></div>
      <div class="stat"><span class="dot" style="background:var(--violet)"></span>Termen în 7 zile
        <div class="n">${st.expiring7}</div><div class="l">aproape de limită</div></div>
    </div>
    <div class="install">📲 <b>Instalează pe telefon:</b> deschide pagina în Safari sau Chrome →
      butonul <b>Distribuie</b> → <b>„Adaugă pe ecranul principal"</b>. Va arăta și se va comporta ca o aplicație.</div>
    <div class="sec-title">Termene apropiate</div>
    <div id="home-urgent"></div>
    <div class="sec-title">Cele mai recente</div>
    <div id="home-latest"></div>`;
  const in14 = new Date(Date.now() + 14 * 864e5).toISOString().slice(0, 10);
  const urg = await api(`/api/tenders?category=active&deadline_to=${in14}&per_page=6&sort=deadline`);
  $("#home-urgent").innerHTML = urg.items.length
    ? urg.items.map(tenderCard).join("")
    : `<div class="empty">Nicio achiziție cu termen în următoarele 14 zile.</div>`;
  const lat = await api("/api/tenders?category=active,upcoming&per_page=6&sort=published_desc");
  $("#home-latest").innerHTML = lat.items.length
    ? lat.items.map(tenderCard).join("")
    : `<div class="empty">Nicio achiziție recentă.</div>`;
  bindCards();
}

async function renderList(cat, append = false) {
  const page = state.pages[cat];
  const qs = new URLSearchParams({ category: cat, page, per_page: PER_PAGE, sort: "deadline" });
  if (state.q) qs.set("q", state.q);
  const data = await api("/api/tenders?" + qs);
  const main = $("main");
  if (!append) {
    main.innerHTML = `<div id="list"></div><div id="list-more"></div>`;
  }
  const list = $("#list");
  if (!append && !data.items.length) {
    list.innerHTML = `<div class="empty">Nicio achiziție găsită${state.q ? ` pentru „${esc(state.q)}”` : ""}.</div>`;
  } else {
    list.insertAdjacentHTML("beforeend", data.items.map(tenderCard).join(""));
  }
  const pages = Math.max(1, Math.ceil(data.total / data.per_page));
  $("#list-more").innerHTML = page < pages
    ? `<button class="more" id="btn-more">Arată mai multe (${data.total - page * data.per_page} rămase)</button>` : "";
  const bm = $("#btn-more");
  if (bm) bm.onclick = () => { state.pages[cat]++; renderList(cat, true); };
  bindCards();
}

async function renderSaved() {
  const data = await api("/api/tenders?per_page=200&sort=published_desc");
  const saved = data.items.filter(t => t.saved);
  const main = $("main");
  if (!saved.length) {
    main.innerHTML = `<div class="empty">Nicio achiziție salvată încă.<br>Deschide o achiziție și apasă „Salvează”.</div>`;
    return;
  }
  main.innerHTML = saved.map(tenderCard).join("");
  bindCards();
}

async function renderRuns() {
  const main = $("main");
  const runs = await api("/api/runs");
  const ch = await api("/api/changes");
  main.innerHTML = `
    <div class="sec-title">Istoric actualizări</div>
    ${runs.length ? runs.map(r => `<div class="run">
        <b>${fmtDateTime(r.started)}</b>
        <div class="muted">Verificate: ${r.scanned} · Noi: ${r.new_count} · Actualizate: ${r.updated} · Expirate: ${r.expired}</div>
        ${r.error ? `<div class="err">${esc(r.error)}</div>` : ""}
      </div>`).join("")
      : `<div class="empty">Nicio rulare încă.</div>`}
    <div class="sec-title">Modificări detectate</div>
    ${ch.length ? ch.slice(0, 30).map(c => `<div class="change">
        <b class="lnk" data-id="${c.tender_id}">${esc(c.title || c.tender_id)}</b>
        <div class="muted" style="color:var(--muted)">${fmtDateTime(c.at)} — ${esc(c.field)}:
          „${esc(c.old_value)}” → „${esc(c.new_value)}”</div>
      </div>`).join("")
      : `<div class="empty">Nicio modificare înregistrată.</div>`}`;
  bindCards();
  $$(".lnk").forEach(el => el.onclick = () => openDetail(el.dataset.id));
}

/* ---------------- detalii ---------------- */
function bindCards() {
  $$(".tcard").forEach(c => c.onclick = () => openDetail(c.dataset.id));
}

async function openDetail(id) {
  const t = await api("/api/tenders/" + id);
  const d = daysLeft(t.deadline_dt);
  const [lbl, cls] = STATUS[t.category] || [t.category, "b-expired"];
  const row = (k, v) => v ? `<div class="d-row"><b>${k}</b>${v}</div>` : "";
  const isSaved = !!(t.saved && (t.saved === true || t.saved.note !== undefined)) || !!lsGet()[id];
  const note = (t.saved && t.saved.note) || (LOCAL ? lsGet()[id]?.note : t.note) || "";
  const sheet = document.createElement("div");
  sheet.className = "sheet-bg";
  sheet.innerHTML = `<div class="sheet">
    <div class="grab"></div>
    <h2>${esc(t.title)}</h2>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:6px">
      <span class="badge ${cls}">${lbl}</span>
      ${d !== null && t.category === "active" ? `<span class="chip">${d} zile rămase</span>` : ""}
    </div>
    ${row("Autoritate contractantă", esc(t.buyer))}
    ${row("Telefon", t.buyer_phone ? `<a href="tel:${esc(t.buyer_phone)}" style="color:var(--teal-d)">${esc(t.buyer_phone)}</a>` : "")}
    ${row("Email", t.buyer_email ? `<a href="mailto:${esc(t.buyer_email)}" style="color:var(--teal-d)">${esc(t.buyer_email)}</a>` : "")}
    ${row("Data publicării", esc(t.published))}
    ${row("Termen-limită oferte", `<b style="color:var(--red)">${esc(t.deadline || "—")}</b>`)}
    ${row("Valoare estimată", (t.budget || "—") + " " + (t.currency || "MDL") + " (fără TVA)")}
    ${row("CPV", esc(t.cpv))}
    ${row("Tipul procedurii", esc(t.procedure))}
    ${row("Motiv relevanță", esc(t.relevance_reason))}
    ${t.lots ? row("Loturi", esc(t.lots)) : ""}
    ${isSaved ? `<textarea id="note" placeholder="Notă internă (responsabil, pregătirea ofertei…)">${esc(note)}</textarea>` : ""}
    <div class="actions">
      <a class="btn teal" href="${esc(t.url)}" target="_blank" rel="noopener">achizitii.md ↗</a>
      <button class="btn ${isSaved ? "red" : ""}" id="sheet-save">${isSaved ? "Elimină" : "Salvează"}</button>
    </div>
    ${isSaved ? `<div class="actions"><button class="btn ghost" id="sheet-note">Salvează nota</button></div>` : ""}
    <div class="actions"><button class="btn ghost" id="sheet-close">Închide</button></div>
  </div>`;
  document.body.appendChild(sheet);
  const close = () => { sheet.remove(); render(); };
  sheet.onclick = e => { if (e.target === sheet) close(); };
  sheet.querySelector("#sheet-close").onclick = close;
  sheet.querySelector("#sheet-save").onclick = async () => {
    if (isSaved) await api("/api/saved/" + id, { method: "DELETE" });
    else await api("/api/saved", { method: "POST", body: JSON.stringify({ tender_id: id }) });
    toast(isSaved ? "Eliminată din salvate." : "Salvată în „Salvate”.");
    close();
  };
  const nb = sheet.querySelector("#sheet-note");
  if (nb) nb.onclick = async () => {
    await api("/api/saved/" + id, { method: "PATCH",
      body: JSON.stringify({ note: sheet.querySelector("#note").value }) });
    toast("Nota a fost salvată.");
  };
}

/* ---------------- taburi ---------------- */
const TABS = {
  acas:     { title: "Prezentare generală", render: renderHome },
  active:   { title: "Achiziții active",    render: () => renderList("active") },
  upcoming: { title: "Oportunități viitoare", render: () => renderList("upcoming") },
  check:    { title: "Necesită verificare", render: () => renderList("check") },
  salvate:  { title: "Achiziții salvate",   render: renderSaved },
  rapoarte: { title: "Rapoarte și istoric", render: renderRuns },
};

function render() {
  $$("nav.tabs a").forEach(a => a.classList.toggle("active", a.dataset.tab === state.tab));
  $("#hd-title").textContent = TABS[state.tab].title;
  $(".search").style.display = ["active", "upcoming", "check"].includes(state.tab) ? "" : "none";
  TABS[state.tab].render();
}

$$("nav.tabs a").forEach(a => a.onclick = e => {
  e.preventDefault();
  state.tab = a.dataset.tab;
  render();
});

let searchTimer = null;
$("#search").addEventListener("input", e => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.q = e.target.value.trim();
    state.pages = { active: 1, upcoming: 1, check: 1 };
    render();
  }, 350);
});

render();
