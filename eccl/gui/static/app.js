/* ECCL core - API client, event bus, panel registry, hash router, theme and shell.
 *
 * Loaded (defer) after lib/ui.js and lib/plot.js and before panels/*.js. The
 * app starts on DOMContentLoaded, i.e. after every panel has registered:
 * fetch /api/info, build the sidebar, route to the current hash.
 */
window.ECCL = window.ECCL || {};

(function (ECCL) {
  "use strict";

  const GROUPS = ["Overview", "Chemistry", "Materials", "Analysis", "Discovery", "AI & Data"];
  const TERMINAL = new Set(["done", "error", "cancelled"]);
  const ACTIVE = new Set(["queued", "running"]);
  const THEME_KEY = "eccl.theme";
  const $ = (sel) => document.querySelector(sel);
  const ui = () => ECCL.ui;

  // ------------------------------------------------------------------ event bus

  const listeners = new Map();
  const bus = {
    on(evt, fn) {
      if (typeof fn !== "function") return () => {};
      if (!listeners.has(evt)) listeners.set(evt, new Set());
      listeners.get(evt).add(fn);
      return () => bus.off(evt, fn);
    },
    off(evt, fn) { const set = listeners.get(evt); if (set) set.delete(fn); },
    emit(evt, data) {
      const set = listeners.get(evt);
      if (!set) return;
      for (const fn of Array.from(set)) {
        try { fn(data); } catch (err) { console.error(`[ECCL] "${evt}" listener failed`, err); }
      }
    },
    once(evt, fn) { const off = bus.on(evt, (d) => { off(); fn(d); }); return off; },
  };
  ECCL.bus = bus;

  // ------------------------------------------------------------------ theme (applied before first paint of the app)

  const media = typeof window.matchMedia === "function" ? window.matchMedia("(prefers-color-scheme: dark)") : null;
  const storedTheme = () => {
    try { const t = window.localStorage.getItem(THEME_KEY); return t === "dark" || t === "light" ? t : null; }
    catch (err) { return null; }
  };
  const systemTheme = () => (media && media.matches ? "dark" : "light");
  const currentTheme = () => document.documentElement.dataset.theme || systemTheme();

  function applyTheme(theme, persist) {
    document.documentElement.dataset.theme = theme;
    if (persist) { try { window.localStorage.setItem(THEME_KEY, theme); } catch (err) { /* storage unavailable */ } }
    paintThemeToggle();
    bus.emit("theme:changed", theme);
  }
  document.documentElement.dataset.theme = storedTheme() || systemTheme();
  if (media) {
    const onSystem = () => { if (!storedTheme()) applyTheme(systemTheme(), false); };
    if (typeof media.addEventListener === "function") media.addEventListener("change", onSystem);
    else if (typeof media.addListener === "function") media.addListener(onSystem);
  }
  ECCL.theme = {
    get: currentTheme,
    set: (t) => applyTheme(t === "dark" ? "dark" : "light", true),
    toggle: () => applyTheme(currentTheme() === "dark" ? "light" : "dark", true),
  };

  // ------------------------------------------------------------------ API client

  let inflight = 0, netTimer = 0;
  function netBusy(delta) {
    inflight = Math.max(0, inflight + delta);
    const bar = $("#netbar");
    if (!bar) return;
    clearTimeout(netTimer);
    if (inflight > 0) netTimer = setTimeout(() => bar.classList.add("is-active"), 150);
    else bar.classList.remove("is-active");
  }

  function apiUrl(path) {
    let p = String(path || "");
    if (/^https?:\/\//i.test(p)) return p;
    if (!p.startsWith("/")) p = `/api/${p.replace(/^api\//, "")}`;
    return p;
  }

  async function request(method, path, body, opts = {}) {
    const quiet = !!opts.quiet;
    if (!quiet) netBusy(1);
    try {
      let res;
      try {
        res = await fetch(apiUrl(path), {
          method,
          headers: method === "GET" ? { Accept: "application/json" } : { Accept: "application/json", "Content-Type": "application/json" },
          body: method === "GET" ? undefined : JSON.stringify(body === undefined || body === null ? {} : body),
          cache: "no-store",
          credentials: "same-origin",
          signal: opts.signal,
        });
      } catch (err) {
        if (err && err.name === "AbortError") throw err;
        const e = new Error("Cannot reach the ECCL server (network error). Is it still running?");
        e.status = 0;
        e.cause = err;
        throw e;
      }
      let text = "";
      try { text = await res.text(); } catch (err) { text = ""; }
      let data = null, parsed = false;
      if (text) { try { data = JSON.parse(text); parsed = true; } catch (err) { parsed = false; } }
      if (!res.ok) {
        const msg = (data && typeof data.error === "string" && data.error) || res.statusText || `HTTP ${res.status}`;
        const e = new Error(msg);
        e.status = res.status;
        if (data && data.type) e.type = data.type;
        e.data = data;
        throw e;
      }
      if (text && !parsed) {
        const e = new Error("The server returned a response that is not valid JSON.");
        e.status = res.status;
        throw e;
      }
      return data === null ? {} : data;
    } finally {
      if (!quiet) netBusy(-1);
    }
  }

  /** Poll a background job until done|error|cancelled. Never rejects on job error. */
  function pollJob(id, opts = {}) {
    const onUpdate = typeof opts.onUpdate === "function" ? opts.onUpdate : null;
    const interval = Math.max(100, Number(opts.intervalMs) || 500);
    let since = 0, stopped = false, timer = 0, failures = 0, lastStatus = null;
    let resolveFn, rejectFn;
    const promise = new Promise((res, rej) => { resolveFn = res; rejectFn = rej; });
    const tick = async () => {
      timer = 0;
      if (stopped) return;
      let job;
      try {
        job = await request("GET", `/api/jobs/${encodeURIComponent(id)}?since=${since}`, undefined, { quiet: true });
        failures = 0;
      } catch (err) {
        if (stopped) return;
        failures += 1;
        if (err.status === 404 || failures >= 8) { stopped = true; rejectFn(err); return; }
        timer = setTimeout(tick, Math.min(5000, interval * 2 ** failures));
        return;
      }
      if (stopped || !job) return;
      let fresh = Array.isArray(job.events) ? job.events : [];
      if (typeof job.events_total === "number") {
        const expected = Math.max(0, job.events_total - since);
        if (fresh.length > expected) fresh = fresh.slice(fresh.length - expected);
        since = Math.max(since, job.events_total);
      } else since += fresh.length;
      if (job.status !== lastStatus) { lastStatus = job.status; bus.emit("jobs:changed", { id, status: job.status }); }
      if (onUpdate) { try { onUpdate(job, fresh); } catch (err) { console.error("[ECCL] pollJob onUpdate failed", err); } }
      if (TERMINAL.has(job.status)) { stopped = true; resolveFn(job); return; }
      timer = setTimeout(tick, interval);
    };
    tick();
    // After cancelPolling() no further onUpdate calls happen and the promise stays pending.
    promise.cancelPolling = () => { stopped = true; if (timer) clearTimeout(timer); timer = 0; };
    promise.jobId = id;
    return promise;
  }

  ECCL.api = {
    get: (path, opts) => request("GET", path, undefined, opts),
    post: (path, body, opts) => request("POST", path, body, opts),
    pollJob,
    cancelJob: (id) => request("POST", `/api/jobs/${encodeURIComponent(id)}/cancel`, {}).then((r) => { bus.emit("jobs:changed", { id }); return r; }),
  };

  // ------------------------------------------------------------------ panel registry

  ECCL.panels = Array.isArray(ECCL.panels) ? ECCL.panels : [];
  let started = false;

  ECCL.registerPanel = function registerPanel(def) {
    if (!def || typeof def.id !== "string" || !def.id) { console.error("[ECCL] registerPanel: a panel needs a string id", def); return; }
    if (typeof def.render !== "function") { console.error(`[ECCL] registerPanel: panel "${def.id}" needs render(root, ctx)`); return; }
    const i = ECCL.panels.findIndex((p) => p.id === def.id);
    if (i >= 0) ECCL.panels.splice(i, 1, def); else ECCL.panels.push(def);
    if (started) buildNav();
  };

  const groupIndex = (g) => { const i = GROUPS.indexOf(g); return i >= 0 ? i : GROUPS.length; };
  function sortedPanels() {
    return ECCL.panels.slice().sort((a, b) => groupIndex(a.group) - groupIndex(b.group) ||
      (Number(a.order) || 0) - (Number(b.order) || 0) || String(a.title || a.id).localeCompare(String(b.title || b.id)));
  }
  const findPanel = (id) => ECCL.panels.find((p) => p.id === id) || null;

  // ------------------------------------------------------------------ router

  function parseHash(hash) {
    let h = String(hash === undefined ? window.location.hash : hash).replace(/^#/, "");
    if (h.startsWith("/")) h = h.slice(1);
    const q = h.indexOf("?");
    let id = (q >= 0 ? h.slice(0, q) : h).replace(/\/+$/, "");
    try { id = decodeURIComponent(id); } catch (err) { /* keep raw */ }
    const params = {};
    if (q >= 0) for (const [k, v] of new URLSearchParams(h.slice(q + 1))) params[k] = v;
    return { id, params };
  }

  ECCL.navigate = function navigate(id, params = {}) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params || {})) if (v !== undefined && v !== null) qs.append(k, String(v));
    const q = qs.toString();
    const hash = `#/${encodeURIComponent(String(id))}${q ? `?${q}` : ""}`;
    if (window.location.hash === hash) route();
    else window.location.hash = hash;
  };

  const panelState = new Map(); // id -> {section, body, status, promise}
  const scrollPos = new Map();
  let activeId = null, activation = 0;

  function route() {
    if (!started) return;
    const { id, params } = parseHash();
    let def = findPanel(id);
    if (!def) {
      def = findPanel("dashboard") || sortedPanels()[0] || null;
      if (id && def && window.history && window.history.replaceState) window.history.replaceState(null, "", `#/${def.id}`);
    }
    if (!def) { showNoPanels(); return; }
    activate(def, params);
  }

  function ctxFor(def, params) {
    return { info: ECCL.info, navigate: ECCL.navigate, bus, params: { ...params }, api: ECCL.api, ui: ECCL.ui, plot: ECCL.plot, panel: def };
  }

  function createSection(def) {
    const { el, icon } = ui();
    const titleId = `panel-${def.id}-title`;
    const body = el("div", { class: "panel-body" });
    const status = el("div", { class: "panel-status", "aria-hidden": "true" });
    const section = el("section", { class: "panel", id: `panel-${def.id}`, "aria-labelledby": titleId, dataset: { panel: def.id }, hidden: true },
      el("header", { class: "panel-header" },
        el("div", { class: "panel-icon" }, icon(def.icon || "info")),
        el("div", { class: "panel-heading" },
          el("div", { class: "panel-eyebrow" }, def.group || ""),
          el("h1", { class: "panel-title", id: titleId, tabindex: "-1" }, def.title || def.id),
          def.description ? el("p", { class: "panel-desc" }, def.description) : null),
        status),
      body);
    $("#main").appendChild(section);
    const st = { section, body, status, status_: "new", promise: null };
    panelState.set(def.id, st);
    return st;
  }

  function showPanelError(def, st, err) {
    const { el, card, errorBox, button } = ui();
    const stack = err && err.stack ? String(err.stack) : "";
    st.body.replaceChildren(card({ title: "This panel failed to load", subtitle: def.title || def.id },
      errorBox(err),
      stack ? el("details", { class: "panel-error-details" }, el("summary", null, "Technical details"), el("pre", { class: "mono" }, stack)) : null,
      el("div", { class: "panel-error-actions" },
        button("Retry", { kind: "primary", icon: "refresh", onClick: () => { st.status_ = "new"; return ensureRendered(def, st).then((ok) => { if (ok && activeId === def.id) callOnShow(def, parseHash().params); }); } }),
        button("Go to dashboard", { kind: "ghost", icon: "home", onClick: () => ECCL.navigate("dashboard") }))));
  }

  function ensureRendered(def, st) {
    if (st.status_ === "ready") return Promise.resolve(true);
    if (st.status_ === "rendering") return st.promise;
    st.status_ = "rendering";
    st.body.replaceChildren();
    st.section.setAttribute("aria-busy", "true");
    const loadTimer = setTimeout(() => st.status.replaceChildren(ui().spinner("Loading panel")), 120);
    st.promise = new Promise((resolve) => resolve(def.render(st.body, ctxFor(def, parseHash().params))))
      .then(() => { st.status_ = "ready"; return true; })
      .catch((err) => {
        st.status_ = "error";
        console.error(`[ECCL] panel "${def.id}" failed to render`, err);
        showPanelError(def, st, err);
        return false;
      })
      .finally(() => {
        clearTimeout(loadTimer);
        st.status.replaceChildren();
        st.section.removeAttribute("aria-busy");
      });
    return st.promise;
  }

  function callOnShow(def, params) {
    if (typeof def.onShow !== "function") return;
    try {
      const r = def.onShow({ ...params });
      if (r && typeof r.then === "function") r.then(null, (err) => reportPanelError(def, err));
    } catch (err) { reportPanelError(def, err); }
  }

  function reportPanelError(def, err) {
    console.error(`[ECCL] panel "${def.id}" onShow failed`, err);
    ui().toast(`${def.title || def.id}: ${ui().errMessage(err)}`, "bad");
  }

  function activate(def, params) {
    const token = ++activation;
    const prev = activeId;
    if (prev && prev !== def.id) {
      scrollPos.set(prev, window.scrollY);
      const ps = panelState.get(prev);
      if (ps) ps.section.hidden = true;
    }
    activeId = def.id;
    const st = panelState.get(def.id) || createSection(def);
    st.section.hidden = false;
    paintNav(def.id);
    document.title = def.id === "dashboard" ? "ECCL · Evolved Chemistry CAD Lab" : `${def.title || def.id} · ECCL`;
    const crumb = $("#crumb");
    if (crumb) crumb.replaceChildren(ui().el("span", { class: "crumb-group" }, def.group || ""), ui().el("span", { class: "crumb-sep", "aria-hidden": "true" }, "/"), ui().el("span", { class: "crumb-title" }, def.title || def.id));
    const wasOpen = isDrawerOpen();
    closeDrawer(false);
    if (prev !== def.id) {
      window.scrollTo(0, scrollPos.get(def.id) || 0);
      if (prev !== null || wasOpen) {
        const title = st.section.querySelector(".panel-title");
        if (title) title.focus({ preventScroll: true });
      }
    }
    ensureRendered(def, st).then((ok) => { if (ok && token === activation) callOnShow(def, params); });
  }

  function showNoPanels() {
    const { el, empty } = ui();
    $("#main").replaceChildren(el("div", { class: "panel" }, empty("No panels are registered.")));
  }

  // ------------------------------------------------------------------ shell: sidebar

  function buildNav() {
    const { el, icon } = ui();
    const nav = $("#sidebar");
    if (!nav) return;
    const panels = sortedPanels();
    const groups = GROUPS.concat(Array.from(new Set(panels.map((p) => p.group).filter((g) => g && !GROUPS.includes(g)))));
    const info = ECCL.info || {};
    nav.replaceChildren(
      el("div", { class: "nav-scroll" }, groups.map((g, gi) => {
        const items = panels.filter((p) => (GROUPS.includes(p.group) || groups.includes(p.group) ? p.group === g : g === "Overview"));
        if (!items.length) return null;
        const labelId = `nav-group-${gi}`;
        return el("div", { class: "nav-group" },
          el("div", { class: "nav-group-label", id: labelId }, g),
          el("ul", { class: "nav-list", "aria-labelledby": labelId }, items.map((p) => el("li", null,
            el("a", { class: "nav-item", href: `#/${encodeURIComponent(p.id)}`, dataset: { panel: p.id } },
              icon(p.icon || "info"), el("span", { class: "nav-label" }, p.title || p.id))))));
      })),
      el("div", { class: "nav-footer" },
        el("div", { class: "nav-footer-row" }, el("span", { class: "nav-footer-name" }, "ECCL"), el("span", { class: "nav-footer-version mono" }, `v${info.version || "?"}`)),
        el("div", { class: "nav-footer-row nav-footer-muted" }, icon("dot"), el("span", null, `Local server · ${window.location.host || "offline"}`))));
    if (activeId) paintNav(activeId);
  }

  function paintNav(id) {
    document.querySelectorAll("#sidebar .nav-item").forEach((a) => {
      if (a.dataset.panel === id) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    });
  }

  // ------------------------------------------------------------------ shell: drawer (below 900 px)

  const narrow = typeof window.matchMedia === "function" ? window.matchMedia("(max-width: 899.98px)") : null;
  const isDrawerOpen = () => document.body.classList.contains("nav-open");

  function setInert(on) {
    for (const sel of ["#main", ".topbar-tools", ".brand", "#crumb"]) {
      const n = $(sel);
      if (!n) continue;
      if (on) n.setAttribute("inert", ""); else n.removeAttribute("inert");
    }
  }

  function openDrawer() {
    if (!narrow || !narrow.matches) return;
    document.body.classList.add("nav-open");
    const t = $("#nav-toggle");
    if (t) { t.setAttribute("aria-expanded", "true"); t.setAttribute("aria-label", "Close navigation"); }
    $("#scrim").hidden = false;
    setInert(true);
    const first = $("#sidebar .nav-item[aria-current]") || $("#sidebar .nav-item");
    if (first) first.focus();
  }

  function closeDrawer(restoreFocus) {
    const was = isDrawerOpen();
    document.body.classList.remove("nav-open");
    const t = $("#nav-toggle");
    if (t) { t.setAttribute("aria-expanded", "false"); t.setAttribute("aria-label", "Open navigation"); }
    const scrim = $("#scrim");
    if (scrim) scrim.hidden = true;
    setInert(false);
    if (was && restoreFocus && t) t.focus();
  }

  // ------------------------------------------------------------------ shell: top bar

  function paintThemeToggle() {
    const btn = $("#theme-toggle");
    if (!btn || !ui()) return;
    const dark = currentTheme() === "dark";
    btn.replaceChildren(ui().icon(dark ? "sun" : "moon"));
    const label = dark ? "Switch to light theme" : "Switch to dark theme";
    btn.setAttribute("aria-label", label);
    btn.title = label;
  }

  function renderChips() {
    const { el, icon } = ui();
    const info = ECCL.info || {};
    const llm = info.llm || {};
    const host = $("#status-chips");
    if (!host) return;
    const rd = !!info.rdkit;
    const backend = llm.backend ? String(llm.backend) : "unknown";
    const llmTitle = `LLM backend: ${backend}${llm.model ? ` (${llm.model})` : ""}. ${llm.reachable ? "Reachable." : "Not reachable; using the offline fallback."}`;
    host.replaceChildren(
      el("span", { class: `chip ${rd ? "chip-ok" : "chip-bad"}`, title: rd ? "RDKit is available: structure features enabled" : "RDKit is not installed: structure features are disabled" },
        icon(rd ? "check" : "x"), el("span", { class: "chip-label" }, "RDKit"),
        el("span", { class: "visually-hidden" }, rd ? " available" : " not available")),
      el("a", { class: `chip chip-link ${llm.reachable ? "chip-ok" : "chip-muted"}`, href: "#/llm", title: llmTitle, "aria-label": llmTitle },
        el("span", { class: "chip-dot", "aria-hidden": "true" }), el("span", { class: "chip-label" }, "LLM"),
        el("span", { class: "chip-value" }, backend)));
    if (!serverOnline) {
      host.prepend(el("span", { class: "chip chip-bad chip-offline", role: "status", title: "The ECCL server is not responding" },
        icon("alert"), el("span", { class: "chip-label" }, "Server offline")));
    }
  }

  async function refreshLlm(data) {
    if (data && typeof data === "object" && "backend" in data) {
      ECCL.info.llm = { ...(ECCL.info.llm || {}), ...data };
    } else {
      try { ECCL.info.llm = await request("GET", "/api/llm/status", undefined, { quiet: true }); }
      catch (err) { /* keep previous status */ }
    }
    renderChips();
  }

  // jobs indicator --------------------------------------------------

  const jobs = { list: [], timer: 0, available: true, open: false };
  let serverOnline = true;
  const JOB_KIND = { evolve: ["Evolution", "dna", "evolution"], campaign: ["Campaign", "sparkle", "evolution"], search: ["Deep search", "search", "search"] };
  const STATUS_KIND = { queued: "neutral", running: "info", done: "ok", error: "bad", cancelled: "warn" };

  async function pollJobs() {
    clearTimeout(jobs.timer);
    try {
      const r = await request("GET", "/api/jobs", undefined, { quiet: true });
      jobs.list = Array.isArray(r.jobs) ? r.jobs : [];
      jobs.available = true;
      if (!serverOnline) { serverOnline = true; renderChips(); ui().toast("Reconnected to the ECCL server", "ok", 2500); }
    } catch (err) {
      jobs.available = false;
      if (err.status === 0 && serverOnline) { serverOnline = false; renderChips(); }
    }
    const active = jobs.list.filter((j) => ACTIVE.has(j.status)).length;
    paintJobs();
    bus.emit("jobs:list", jobs.list);
    jobs.timer = setTimeout(pollJobs, active ? 3000 : 15000);
  }

  let jobsDebounce = 0;
  function scheduleJobsRefresh() { clearTimeout(jobsDebounce); jobsDebounce = setTimeout(pollJobs, 150); }

  function paintJobs() {
    const { el, icon } = ui();
    const btn = $("#jobs-btn");
    if (!btn) return;
    const active = jobs.list.filter((j) => ACTIVE.has(j.status));
    const n = active.length;
    btn.classList.toggle("is-active", n > 0);
    btn.replaceChildren(icon("activity"), el("span", { class: "jobs-label" }, n ? `${n} running` : "Jobs"));
    if (n) btn.appendChild(el("span", { class: "jobs-count", "aria-hidden": "true" }, String(n)));
    btn.setAttribute("aria-label", n ? `Background jobs: ${n} active` : "Background jobs: none active");
    if (jobs.open) paintJobsPopover();
  }

  function paintJobsPopover() {
    const { el, icon, badge, empty, meter } = ui();
    const pop = $("#jobs-pop");
    if (!pop) return;
    const items = jobs.list.slice(0, 12);
    pop.replaceChildren(
      el("div", { class: "jobs-pop-head" }, el("strong", null, "Background jobs"),
        el("span", { class: "jobs-pop-sub" }, jobs.available ? `${jobs.list.length} recent` : "unavailable")),
      !jobs.available ? el("div", { class: "jobs-pop-empty" }, "The job service did not respond.")
        : !items.length ? el("div", { class: "jobs-pop-empty" }, empty("No jobs yet. Evolution runs, campaigns and deep searches appear here."))
          : el("ul", { class: "jobs-list" }, items.map((j) => {
            const [label, ic, panel] = JOB_KIND[j.kind] || [j.kind || "Job", "activity", "dashboard"];
            const p = j.progress || {};
            const hasProgress = ACTIVE.has(j.status) && Number(p.total) > 0;
            return el("li", null, el("a", { class: "job-row", href: `#/${panel}?job=${encodeURIComponent(j.id)}`, on: { click: () => closeJobs(false) } },
              el("span", { class: "job-icon" }, icon(ic)),
              el("div", { class: "job-main" },
                el("div", { class: "job-title" }, label, el("span", { class: "job-id mono" }, j.id)),
                hasProgress ? meter({ value: Number(p.current) || 0, min: 0, max: Number(p.total), label: p.message || "progress", format: (v) => `${Math.round(v)}/${p.total}` })
                  : p.message ? el("span", { class: "job-msg" }, p.message) : null),
              badge(j.status || "?", STATUS_KIND[j.status] || "neutral")));
          })));
  }

  function openJobs() {
    jobs.open = true;
    const pop = $("#jobs-pop");
    pop.hidden = false;
    $("#jobs-btn").setAttribute("aria-expanded", "true");
    paintJobsPopover();
    pollJobs();
  }

  function closeJobs(restoreFocus) {
    if (!jobs.open) return;
    jobs.open = false;
    $("#jobs-pop").hidden = true;
    const btn = $("#jobs-btn");
    btn.setAttribute("aria-expanded", "false");
    if (restoreFocus) btn.focus();
  }

  // ------------------------------------------------------------------ shell wiring

  let wired = false;
  function wireShell() {
    if (wired) return;
    wired = true;
    const { icon } = ui();
    const toggle = $("#nav-toggle");
    toggle.replaceChildren(icon("menu"));
    toggle.addEventListener("click", () => (isDrawerOpen() ? closeDrawer(true) : openDrawer()));
    $("#scrim").addEventListener("click", () => closeDrawer(true));
    if (narrow) {
      const onWidth = () => { if (!narrow.matches) closeDrawer(false); };
      if (typeof narrow.addEventListener === "function") narrow.addEventListener("change", onWidth);
      else if (typeof narrow.addListener === "function") narrow.addListener(onWidth);
    }
    $("#theme-toggle").addEventListener("click", () => ECCL.theme.toggle());
    paintThemeToggle();

    const jobsBtn = $("#jobs-btn");
    jobsBtn.addEventListener("click", (ev) => { ev.stopPropagation(); if (jobs.open) closeJobs(false); else openJobs(); });
    document.addEventListener("click", (ev) => {
      if (jobs.open && !(ev.target instanceof Element && ev.target.closest("#jobs-pop, #jobs-btn"))) closeJobs(false);
    });
    document.addEventListener("keydown", (ev) => {
      if (ev.key !== "Escape") return;
      if (jobs.open) closeJobs(true);
      else if (isDrawerOpen()) closeDrawer(true);
    });

    const skip = $(".skip-link");
    if (skip) skip.addEventListener("click", (ev) => {
      ev.preventDefault();
      const title = activeId && panelState.get(activeId) ? panelState.get(activeId).section.querySelector(".panel-title") : null;
      (title || $("#main")).focus();
    });

    bus.on("jobs:changed", scheduleJobsRefresh);
    bus.on("llm:changed", refreshLlm);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) scheduleJobsRefresh(); });
    window.addEventListener("hashchange", route);
    window.addEventListener("unhandledrejection", (ev) => {
      const r = ev.reason;
      if (r && r.name === "AbortError") return;
      ui().toast(`Unexpected error: ${ui().errMessage(r)}`, "bad");
    });
  }

  // ------------------------------------------------------------------ boot

  function bootCard(...children) {
    const boot = $("#boot");
    boot.hidden = false;
    boot.replaceChildren(ui().el("div", { class: "boot-card" }, children));
    return boot;
  }

  function showBooting() {
    const { el, icon, spinner } = ui();
    const boot = bootCard(el("div", { class: "boot-logo" }, icon("logo")), el("div", { class: "boot-title" }, "ECCL"),
      el("div", { class: "boot-msg" }, spinner("Starting"), el("span", null, "Connecting to the lab server…")));
    boot.setAttribute("aria-busy", "true");
  }

  function showFatal(err) {
    const { el, icon, button } = ui();
    const status = err && typeof err.status === "number" ? err.status : 0;
    const title = status === 0 ? "Can't reach the ECCL server" : "The ECCL server returned an error";
    const boot = bootCard(
      el("div", { class: "boot-logo boot-logo-error" }, icon("alert")),
      el("h1", { class: "boot-error-title" }, title),
      el("p", { class: "boot-error-text" }, "The interface loaded, but the request for ", el("code", null, "/api/info"), " failed."),
      el("p", { class: "boot-error-detail mono" }, status ? `HTTP ${status}: ${ui().errMessage(err)}` : ui().errMessage(err)),
      el("p", { class: "boot-error-hint" }, "Check that ", el("code", null, "eccl gui"), " is still running in your terminal, then retry."),
      el("div", { class: "boot-actions" }, button("Retry", { kind: "primary", icon: "refresh", onClick: () => start() })));
    boot.removeAttribute("aria-busy");
    boot.setAttribute("role", "alert");
    const retry = boot.querySelector(".btn-primary");
    if (retry) retry.focus();
  }

  let booting = false;
  async function start() {
    if (started || booting) return;
    if (!ui()) { document.body.textContent = "ECCL failed to load its interface scripts."; return; }
    booting = true;
    try { await boot(); } finally { booting = false; }
  }

  async function boot() {
    $("#app").hidden = true;
    showBooting();
    const ctrl = typeof AbortController === "function" ? new AbortController() : null;
    const timeout = setTimeout(() => ctrl && ctrl.abort(), 20000);
    let info;
    try {
      info = await request("GET", "/api/info", undefined, { quiet: true, signal: ctrl ? ctrl.signal : undefined });
      if (!info || typeof info !== "object" || Array.isArray(info)) throw Object.assign(new Error("Unexpected /api/info response"), { status: 200 });
    } catch (err) {
      clearTimeout(timeout);
      const e = err && err.name === "AbortError" ? Object.assign(new Error("Timed out waiting for the server."), { status: 0 }) : err;
      showFatal(e);
      return;
    }
    clearTimeout(timeout);
    ECCL.info = info;
    info.libraries = info.libraries || {};
    info.presets = info.presets || {};
    info.llm = info.llm || { backend: "unknown", model: null, reachable: false };
    started = true;
    wireShell();
    buildNav();
    renderChips();
    paintJobs();
    const bootEl = $("#boot");
    bootEl.hidden = true;
    bootEl.removeAttribute("role");
    bootEl.removeAttribute("aria-busy");
    $("#app").hidden = false;
    route();
    pollJobs();
  }

  ECCL.start = start;
  ECCL.version = "gui-1";

  // Deferred scripts run before DOMContentLoaded, so every panel has registered by then.
  // `load` is only a safety net (start() is idempotent).
  if (document.readyState === "complete") start();
  else {
    const kick = () => {
      document.removeEventListener("DOMContentLoaded", kick);
      window.removeEventListener("load", kick);
      start();
    };
    document.addEventListener("DOMContentLoaded", kick);
    window.addEventListener("load", kick);
  }
})(window.ECCL);
