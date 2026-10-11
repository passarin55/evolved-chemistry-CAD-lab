/* Deep search panel - multi-provider literature search with query expansion,
 * de-duplication / ranking and an optional LLM synthesis grounded in the
 * retrieved snippets. Runs as a background job; the panel streams per-provider
 * status, then shows the ranked results, the sub-queries and the synthesis.
 */
window.ECCL = window.ECCL || {};

(function (ECCL) {
  "use strict";

  const ACTIVE = new Set(["queued", "running"]);
  const STATUS_KIND = { queued: "neutral", running: "info", done: "ok", error: "bad", cancelled: "warn" };
  const PROVIDER_INFO = {
    pubchem: "PubChem compounds (formula, MW, SMILES)",
    wikipedia: "Wikipedia articles",
    arxiv: "arXiv preprints",
    crossref: "Crossref journal metadata (DOI, citations)",
    duckduckgo: "DuckDuckGo instant answers",
  };
  const EXAMPLES = ["perovskite solar cell stability", "aspirin mechanism of action", "graphene Raman spectroscopy", "metal-organic frameworks CO2 capture"];
  const RECENT_KEY = "eccl.search.recent";
  const MAX_RECENT = 12;

  const CSS = `
#panel-search .srch-intro { color: var(--text-2); max-width: 92ch; }
#panel-search .srch-top { display: grid; gap: var(--gap); grid-template-columns: minmax(0, 1fr); align-items: start; }
@media (min-width: 1100px) { #panel-search .srch-top { grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr); } }
#panel-search .srch-top > * + * { margin-top: 0; }
#panel-search .srch-providers { border: 0; margin: 0; padding: 0; min-width: 0; }
#panel-search .srch-prov-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
#panel-search .srch-prov-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 150px), 1fr)); gap: 0 14px; }
#panel-search .srch-prov-grid .check { min-height: 30px; }
#panel-search .srch-prov-grid .field-error { display: none; }
#panel-search .srch-providers .field-error:not(:empty) { margin-top: 4px; }
#panel-search .srch-status { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; font-size: 13px; color: var(--text-2); min-width: 0; }
#panel-search .srch-status .mono { color: var(--text-3); font-size: 12px; }
#panel-search .srch-plist { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
#panel-search .srch-plist > li { display: grid; grid-template-columns: minmax(96px, max-content) minmax(0, 1fr); gap: 4px 12px; align-items: start; padding: 8px 0; border-top: 1px solid var(--border-subtle); }
#panel-search .srch-plist > li:first-child { border-top: 0; }
#panel-search .srch-pname { display: flex; align-items: center; gap: 6px; }
#panel-search .srch-pdetail { min-width: 0; font-size: 12.5px; color: var(--text-2); }
#panel-search .srch-pdetail details summary { cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-3); }
#panel-search .srch-pdetail details p { margin-top: 4px; font-family: var(--font-mono); font-size: 12px; word-break: break-all; color: var(--text-2); }
#panel-search .srch-pdesc { display: block; font-size: 12px; color: var(--text-3); }
#panel-search .srch-chips { display: flex; flex-wrap: wrap; gap: 6px; }
#panel-search .srch-chip { display: inline-flex; align-items: center; gap: 6px; max-width: 100%; padding: 4px 11px; border: 1px solid var(--border); border-radius: 999px; background: var(--surface-2); color: var(--text-2); font-size: 12.5px; cursor: pointer; text-align: left; overflow-wrap: anywhere; }
#panel-search .srch-chip:hover { border-color: var(--accent-border); background: var(--accent-soft); color: var(--accent); }
#panel-search .srch-chip .icon { width: 13px; height: 13px; flex: none; }
#panel-search .srch-chip.is-main { border-color: var(--accent-border); color: var(--accent); background: var(--accent-soft); font-weight: 600; }
#panel-search .srch-result { display: flex; flex-direction: column; gap: 8px; }
#panel-search .srch-result > * + * { margin-top: 0; }
#panel-search .srch-rhead { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
#panel-search .srch-rtitle { font-size: 14.5px; font-weight: 650; line-height: 1.35; overflow-wrap: anywhere; min-width: 0; }
#panel-search .srch-rtitle a { text-decoration: none; }
#panel-search .srch-rtitle a:hover { text-decoration: underline; }
#panel-search .srch-rtitle .icon { width: 13px; height: 13px; margin-left: 4px; color: var(--text-3); vertical-align: -1px; }
#panel-search .srch-host { font-size: 12px; color: var(--text-3); overflow-wrap: anywhere; }
#panel-search .srch-snippet { color: var(--text-2); font-size: 13.5px; overflow-wrap: anywhere; white-space: pre-line; }
#panel-search .srch-result .kv { grid-template-columns: repeat(auto-fill, minmax(min(100%, 180px), 1fr)); }
#panel-search .srch-result .kv dd { font-family: var(--font-mono); font-size: 12.5px; }
#panel-search .srch-synth { white-space: pre-wrap; overflow-wrap: anywhere; padding: 12px 14px; border: 1px solid var(--border); border-left: 3px solid var(--accent); border-radius: var(--radius); background: var(--surface-2); font-size: 13.5px; line-height: 1.6; }
#panel-search .srch-muted { color: var(--text-3); font-size: 13px; }
#panel-search .srch-recent { list-style: none; margin: 0; padding: 0; }
#panel-search .srch-recent > li { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 6px 12px; padding: 9px 0; border-top: 1px solid var(--border-subtle); }
#panel-search .srch-recent > li:first-child { border-top: 0; }
#panel-search .srch-recent-main { min-width: 0; flex: 1 1 220px; }
#panel-search .srch-recent-q { font-weight: 600; overflow-wrap: anywhere; }
#panel-search .srch-recent-meta { font-size: 12px; color: var(--text-3); }
#panel-search .srch-recent-actions { display: flex; gap: 6px; flex: none; }
#panel-search .srch-stats.grid { --grid-min: 140px; }
`;

  function injectStyle() {
    if (document.getElementById("eccl-css-search")) return;
    const st = document.createElement("style");
    st.id = "eccl-css-search";
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  const S = {
    ctx: null, form: null, provFields: [], provError: null, cancelBtn: null,
    statusEl: null, progressEl: null, plistEl: null, resultsEl: null, recentEl: null,
    view: null, poll: null, token: 0, running: false, recent: [], loadSeq: 0,
  };
  const ui = () => ECCL.ui;
  const api = () => ECCL.api;

  // ------------------------------------------------------------------ helpers

  function safeUrl(u) {
    if (typeof u !== "string" || !u.trim()) return null;
    try {
      const x = new URL(u.trim());
      return x.protocol === "http:" || x.protocol === "https:" ? x : null;
    } catch (err) { return null; }
  }

  function providerNames() {
    const list = ECCL.info.libraries && ECCL.info.libraries.search_providers;
    return Array.isArray(list) && list.length ? list : Object.keys(PROVIDER_INFO);
  }

  function llmBackend() { return (ECCL.info.llm && ECCL.info.llm.backend) || "unknown"; }
  function isEcho(name) { return /^echo/i.test(String(name || "")); }

  function clockTime(ms) {
    try { return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); } catch (err) { return ""; }
  }

  function loadRecent() {
    try {
      const raw = window.sessionStorage.getItem(RECENT_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr.filter((r) => r && typeof r.query === "string").slice(0, MAX_RECENT) : [];
    } catch (err) { return []; }
  }

  function saveRecent() {
    try { window.sessionStorage.setItem(RECENT_KEY, JSON.stringify(S.recent.slice(0, MAX_RECENT))); } catch (err) { /* storage unavailable */ }
  }

  // ------------------------------------------------------------------ form

  function buildProviders() {
    const { el, field, button } = ui();
    S.provFields = providerNames().map((name) => {
      const f = field({ name: `prov_${name}`, label: name, type: "checkbox", value: true });
      f.title = PROVIDER_INFO[name] || name;
      f.provider = name;
      f.input.addEventListener("change", () => S.provError.replaceChildren());
      return f;
    });
    S.provError = el("div", { class: "field-error srch-prov-error", role: "alert" });
    const setAll = (on) => { for (const f of S.provFields) f.setValue(on); S.provError.replaceChildren(); };
    return el("fieldset", { class: "srch-providers span-full" },
      el("legend", { class: "visually-hidden" }, "Providers"),
      el("div", { class: "srch-prov-head" },
        el("span", { class: "field-label", "aria-hidden": "true" }, "Providers"),
        el("div", null,
          button("All", { small: true, kind: "ghost", onClick: () => setAll(true) }),
          button("None", { small: true, kind: "ghost", onClick: () => setAll(false) }))),
      el("div", { class: "srch-prov-grid" }, S.provFields),
      S.provError);
  }

  function buildForm() {
    const { form, button } = ui();
    S.cancelBtn = button("Cancel", { kind: "danger", icon: "stop", onClick: cancelSearch });
    S.cancelBtn.hidden = true;
    S.form = form({
      columns: 2,
      submitLabel: "Search",
      submitIcon: "search",
      actions: [S.cancelBtn],
      fields: [
        { name: "query", label: "Research question", type: "text", value: EXAMPLES[0], required: true, span: "full",
          placeholder: "e.g. perovskite solar cell stability", validate: (v) => (v && v.length > 500 ? "Keep it under 500 characters" : null) },
        buildProviders(),
        { name: "per_provider", label: "Results per provider", type: "number", value: 4, min: 1, max: 20, step: 1, required: true,
          help: "Per provider and sub-query (1–20)", validate: (v) => (v !== null && !Number.isInteger(v) ? "Enter a whole number" : null) },
        { name: "expand", label: "Expand the query (3 extra sub-queries)", type: "checkbox", value: true, span: "full" },
        { name: "synthesise", label: "Synthesise a cited briefing with the LLM", type: "checkbox", value: true, span: "full" },
      ],
      onSubmit: startSearch,
    });
    return S.form;
  }

  /** Mirror a job's request in the form (query, options, providers). */
  function applyParams(params) {
    if (!params || S.running) return;
    const v = {};
    if (typeof params.query === "string") v.query = params.query;
    if (Number.isFinite(params.per_provider)) v.per_provider = params.per_provider;
    if (typeof params.expand === "boolean") v.expand = params.expand;
    if (typeof params.synthesise === "boolean") v.synthesise = params.synthesise;
    S.form.setValues(v);
    if (Array.isArray(params.providers) && params.providers.length) {
      for (const f of S.provFields) f.setValue(params.providers.includes(f.provider));
    }
    S.provError.replaceChildren();
  }

  function selectedProviders() { return S.provFields.filter((f) => f.getValue()).map((f) => f.provider); }

  async function startSearch(values) {
    if (S.running) throw new Error("A search is already running. Cancel it or wait for it to finish.");
    const providers = selectedProviders();
    if (!providers.length) {
      S.provError.textContent = "Select at least one provider";
      if (S.provFields[0]) S.provFields[0].input.focus();
      throw new Error("Select at least one search provider.");
    }
    const body = { query: values.query, per_provider: values.per_provider, expand: !!values.expand, synthesise: !!values.synthesise, providers };
    const r = await api().post("/api/search/start", body);
    S.loadSeq += 1;
    ECCL.bus.emit("jobs:changed", { id: r.job_id, status: "queued" });
    remember({ ...body, jobId: r.job_id, at: Date.now(), status: "queued", llm: llmBackend() });
    setTimeout(() => track(r.job_id, body), 0);
    return r;
  }

  function runQuery(q, extra) {
    if (S.running) { ui().toast("A search is already running.", "warn"); return; }
    S.form.setValues({ query: q, ...(extra || {}) });
    S.form.submit();
  }

  async function cancelSearch() {
    if (!S.view || !S.running) return;
    S.cancelBtn.disabled = true;
    try {
      await api().cancelJob(S.view.id);
      ui().toast("Cancelling: the provider request in flight finishes first.", "info", 3000);
    } catch (err) { S.cancelBtn.disabled = false; throw err; }
  }

  function setRunning(on) {
    S.running = !!on;
    S.cancelBtn.hidden = !on;
    S.cancelBtn.disabled = false;
    if (S.form.submitButton) S.form.submitButton.hidden = !!on;
  }

  // ------------------------------------------------------------------ recent searches

  function remember(entry) {
    S.recent = [entry, ...S.recent.filter((r) => r.jobId !== entry.jobId)].slice(0, MAX_RECENT);
    saveRecent();
    paintRecent();
  }

  function updateRecent(jobId, patch) {
    const r = S.recent.find((x) => x.jobId === jobId);
    if (!r) return;
    Object.assign(r, patch);
    saveRecent();
    paintRecent();
  }

  function paintRecent() {
    const { el, button, badge, empty } = ui();
    if (!S.recentEl) return;
    if (!S.recent.length) {
      S.recentEl.replaceChildren(empty("Searches you run in this browser session are listed here so you can re-run them."));
      return;
    }
    S.recentEl.replaceChildren(el("ul", { class: "srch-recent" }, S.recent.map((r) => {
      const meta = [
        clockTime(r.at),
        `${(r.providers || []).length} provider${(r.providers || []).length === 1 ? "" : "s"}`,
        r.status === "done" ? `${r.nResults || 0} result${r.nResults === 1 ? "" : "s"} · ${r.nUsed || 0} answered` : null,
      ].filter(Boolean).join(" · ");
      return el("li", null,
        el("div", { class: "srch-recent-main" }, el("div", { class: "srch-recent-q" }, r.query), el("div", { class: "srch-recent-meta" }, meta)),
        el("div", { class: "srch-recent-actions" },
          badge(r.status || "?", STATUS_KIND[r.status] || "neutral"),
          button("View", { small: true, kind: "ghost", title: "Show this search's result", onClick: () => S.ctx.navigate("search", { job: r.jobId }) }),
          button("Re-run", {
            small: true, icon: "refresh", title: "Run this search again",
            onClick: () => {
              const vals = { per_provider: r.per_provider || 4, expand: r.expand !== false, synthesise: r.synthesise !== false };
              for (const f of S.provFields) f.setValue(!r.providers || r.providers.includes(f.provider));
              runQuery(r.query, vals);
            },
          })));
    })));
  }

  // ------------------------------------------------------------------ live status

  function resetView(id, params) {
    S.token += 1;
    if (S.poll && S.poll.cancelPolling) S.poll.cancelPolling();
    S.poll = null;
    const names = (params && Array.isArray(params.providers) && params.providers.length) ? params.providers : providerNames();
    S.view = { id, params: params || {}, providers: names, state: Object.fromEntries(names.map((n) => [n, { status: "pending", detail: "" }])), current: null, status: null };
    paintProviders();
    return S.token;
  }

  function paintProviders() {
    const { el, badge, spinner } = ui();
    const v = S.view;
    if (!v) return;
    S.plistEl.replaceChildren(el("ul", { class: "srch-plist" }, v.providers.map((name) => {
      const st = v.state[name] || { status: "pending" };
      let b, detail;
      if (st.status === "ok") { b = badge(name, "ok"); detail = el("span", null, st.detail || "answered"); }
      else if (st.status === "failed") {
        b = badge(name, "bad");
        const reason = String(st.detail || "failed");
        detail = el("details", null, el("summary", { title: reason }, reason), el("p", null, reason));
      } else if (ACTIVE.has(v.status) && v.current === name) { b = badge(name, "info"); detail = el("span", { class: "srch-pname" }, spinner("Querying"), "querying…"); }
      else if (ACTIVE.has(v.status)) { b = badge(name, "neutral"); detail = el("span", { class: "srch-muted" }, "waiting"); }
      else { b = badge(name, "neutral"); detail = el("span", { class: "srch-muted" }, v.status === "cancelled" ? "not queried (cancelled)" : "no status reported"); }
      return el("li", null, el("div", { class: "srch-pname" }, b),
        el("div", { class: "srch-pdetail" }, detail, el("span", { class: "srch-pdesc" }, PROVIDER_INFO[name] || "")));
    })));
  }

  function paintStatus(job) {
    const { el, badge, meter } = ui();
    const p = job.progress || {};
    const total = Number(p.total) || S.view.providers.length;
    const cur = Number(p.current) || 0;
    S.statusEl.replaceChildren(badge(job.status, STATUS_KIND[job.status] || "neutral"),
      el("span", null, p.message || job.status), el("span", { class: "mono" }, job.id));
    S.progressEl.replaceChildren(meter({
      value: cur, min: 0, max: total || 1, label: "Providers finished",
      kind: job.status === "error" ? "bad" : job.status === "cancelled" ? "warn" : job.status === "done" ? "ok" : "info",
      format: () => `${cur} / ${total}`,
    }));
  }

  function applyEvents(events) {
    for (const e of events || []) {
      if (!e || !e.provider) continue;
      if (!S.view.state[e.provider]) { S.view.providers.push(e.provider); }
      S.view.state[e.provider] = { status: e.status === "ok" ? "ok" : "failed", detail: e.detail || "" };
    }
  }

  function onUpdate(job, fresh, token) {
    if (token !== S.token) return;
    S.view.status = job.status;
    const m = /^querying (\S+)/.exec((job.progress && job.progress.message) || "");
    S.view.current = m ? m[1] : null;
    applyEvents(fresh);
    paintStatus(job);
    paintProviders();
  }

  function track(id, params) {
    const token = resetView(id, params);
    setRunning(true);
    S.view.status = "queued";
    paintStatus({ id, status: "queued", progress: { current: 0, total: S.view.providers.length, message: "queued" } });
    paintProviders();
    S.resultsEl.replaceChildren(ui().notice(`Searching ${S.view.providers.length} provider${S.view.providers.length === 1 ? "" : "s"} for “${params.query}”… Each provider is queried once per sub-query; unreachable hosts can take a few seconds to fail.`, "info"));
    const poll = api().pollJob(id, { onUpdate: (job, fresh) => onUpdate(job, fresh, token) });
    S.poll = poll;
    poll.then((job) => { if (token === S.token) finish(job, true); }, (err) => {
      if (token !== S.token) return;
      setRunning(false);
      S.resultsEl.replaceChildren(ui().errorBox(err));
    });
  }

  function finish(job, live) {
    setRunning(false);
    S.view.status = job.status;
    S.view.current = null;
    const r = job.result;
    if (r) {
      for (const p of r.providers_used || []) if (!S.view.state[p] || S.view.state[p].status !== "ok") S.view.state[p] = { status: "ok", detail: (S.view.state[p] && S.view.state[p].detail) || "answered" };
      for (const [p, reason] of Object.entries(r.providers_failed || {})) {
        if (!S.view.providers.includes(p)) S.view.providers.push(p);
        S.view.state[p] = { status: "failed", detail: reason };
      }
    }
    paintStatus(job);
    paintProviders();
    if (job.status === "done" && r) {
      renderResult(job);
      updateRecent(job.id, { status: "done", nResults: (r.results || []).length, nUsed: (r.providers_used || []).length });
      if (live) {
        const n = (r.results || []).length;
        ui().toast(n ? `Search finished: ${n} result${n === 1 ? "" : "s"}` : "Search finished with no results", n ? "ok" : "warn");
      }
    } else if (job.status === "cancelled") {
      updateRecent(job.id, { status: "cancelled" });
      S.resultsEl.replaceChildren(ui().notice("The search was cancelled before it finished.", "warn"));
    } else if (job.status === "error") {
      updateRecent(job.id, { status: "error" });
      S.resultsEl.replaceChildren(ui().errorBox({ message: job.error || "The search failed.", type: job.error_type }));
    }
  }

  // ------------------------------------------------------------------ results

  function resultCard(item, rank) {
    const { el, card, badge, kv, icon } = ui();
    const url = safeUrl(item.url);
    const title = String(item.title || "(untitled)");
    const titleNode = url
      ? el("a", { href: url.href, target: "_blank", rel: "noopener noreferrer", title: url.href }, title, icon("external"))
      : el("span", null, title);
    const data = item.data && typeof item.data === "object" ? Object.entries(item.data).filter(([, v]) => v !== null && v !== undefined && v !== "") : [];
    return card({ class: "srch-result" },
      el("div", { class: "srch-rhead" },
        el("div", { class: "srch-rtitle" }, titleNode),
        badge(item.source || "source", "info")),
      url ? el("div", { class: "srch-host" }, `#${rank} · ${url.hostname}`) : el("div", { class: "srch-host" }, `#${rank}${item.url ? " · link withheld (not http/https)" : " · no link"}`),
      item.snippet ? el("p", { class: "srch-snippet" }, String(item.snippet)) : null,
      data.length ? kv(data.map(([k, v]) => [k === "doi" ? "DOI" : k.replace(/_/g, " "), typeof v === "object" ? JSON.stringify(v) : v])) : null);
  }

  function renderResult(job) {
    const { el, card, grid, stat, notice, empty, button, json, icon, section, badge } = ui();
    const r = job.result || {};
    const results = Array.isArray(r.results) ? r.results : [];
    const used = Array.isArray(r.providers_used) ? r.providers_used : [];
    const failed = Object.keys(r.providers_failed || {});
    const asked = (job.params && job.params.providers) || used.concat(failed);
    const backend = (S.recent.find((x) => x.jobId === job.id) || {}).llm || llmBackend();
    const nodes = [];

    if (!used.length && failed.length) {
      nodes.push(notice(el("span", null, el("strong", null, "Every provider failed. "),
        "Outbound HTTPS appears to be blocked (or this machine is offline), so no literature could be retrieved. " +
        "The providers work normally when the ECCL server has network access; the provider list above shows each error."), "warn"));
    } else if (failed.length) {
      nodes.push(notice(`${failed.length} of ${asked.length} providers failed; results come from ${used.join(", ")}.`, "neutral"));
    }

    const stats = grid(4,
      stat({ label: "Results", value: results.length, hint: "after de-duplication and ranking" }),
      stat({ label: "Providers answered", value: used.length, unit: `/ ${asked.length}`, kind: used.length ? "ok" : "bad" }),
      stat({ label: "Sub-queries", value: (r.subqueries || []).length, hint: job.params && job.params.expand === false ? "expansion off" : "query + expansions" }),
      stat({ label: "Run time", value: job.finished && job.started ? Number((job.finished - job.started).toFixed(1)) : null, unit: "s" }));
    stats.classList.add("srch-stats");
    nodes.push(stats);

    const subs = Array.isArray(r.subqueries) ? r.subqueries : [];
    if (subs.length) {
      nodes.push(card({ title: "Sub-queries", subtitle: "Each one is sent to every provider. Click one to search for it on its own.", icon: "list" },
        el("div", { class: "srch-chips" }, subs.map((q, i) => el("button", {
          type: "button", class: ["srch-chip", i === 0 && "is-main"], title: `Search for “${q}”`,
          on: { click: () => runQuery(q, { expand: false }) },
        }, icon("search"), q)))));
    }

    const synth = job.params && job.params.synthesise === false
      ? el("p", { class: "srch-muted" }, "Synthesis was switched off for this search.")
      : r.synthesis
        ? el("div", { class: "srch-synth" }, String(r.synthesis))
        : el("p", { class: "srch-muted" }, results.length ? "The LLM returned no synthesis." : "No synthesis: there were no retrieved sources to ground it in (the briefing only cites retrieved snippets).");
    nodes.push(card({
      title: "Synthesis", subtitle: "A short briefing that may only cite the retrieved sources", icon: "chat",
      actions: badge(`LLM: ${backend}`, isEcho(backend) ? "warn" : "info"),
    }, synth,
    isEcho(backend) && r.synthesis ? notice("The offline echo fallback produced this placeholder; it is not generated text. Configure a local model to get a real briefing.", "warn") : null,
    isEcho(backend) ? el("div", null, button("Configure a local LLM", { small: true, kind: "ghost", icon: "chat", onClick: () => S.ctx.navigate("llm") })) : null));

    nodes.push(results.length
      ? card({ title: `Results (${results.length})`, subtitle: "Ranked by query-term overlap; PubChem and Crossref get a small bonus for structured data.", icon: "book" },
        grid(2, results.map((it, i) => resultCard(it, i + 1))))
      : card({ title: "Results", icon: "book" }, empty(used.length ? "The providers answered but returned nothing relevant." : "No results: no provider could be reached.")));

    nodes.push(json(r, { title: "Raw search report" }));
    S.resultsEl.replaceChildren(section(`Results · “${r.query || (job.params && job.params.query) || ""}”`, nodes));
  }

  function showIntroState() {
    const { el, card, icon } = ui();
    S.resultsEl.replaceChildren(card({ title: "Try a search", subtitle: "Pick an example or type your own question above.", icon: "sparkle" },
      el("div", { class: "srch-chips" }, EXAMPLES.map((q) => el("button", {
        type: "button", class: "srch-chip", on: { click: () => runQuery(q) },
      }, icon("search"), q)))));
  }

  // ------------------------------------------------------------------ job loading

  async function loadJob(id) {
    if (!id || (S.view && S.view.id === id && (S.running || S.view.status === "done"))) return;
    const seq = ++S.loadSeq;
    let job;
    try { job = await api().get(`/api/jobs/${encodeURIComponent(id)}`); }
    catch (err) {
      if (seq !== S.loadSeq) return;
      ui().toast(err.status === 404 ? `Search job ${id} is no longer available (the server keeps the last 50 jobs).` : ui().errMessage(err), "bad");
      return;
    }
    if (seq !== S.loadSeq) return; // a newer load superseded this one
    if (job.kind !== "search") { ui().toast(`Job ${id} is not a search job.`, "warn"); return; }
    applyParams(job.params);
    if (ACTIVE.has(job.status)) { track(id, job.params || {}); return; }
    resetView(id, job.params || {});
    S.view.status = job.status;
    applyEvents(job.events);
    if (!S.recent.some((r) => r.jobId === id) && job.params) {
      remember({ ...job.params, jobId: id, at: (job.created || Date.now() / 1000) * 1000, status: job.status, llm: llmBackend() });
    }
    finish(job, false);
  }

  async function initialLoad(params) {
    if (params && params.job) return; // onShow loads it
    let jobs = [];
    try { jobs = (await api().get("/api/jobs", { quiet: true })).jobs || []; } catch (err) { jobs = []; }
    if (S.view) return; // the user started a search meanwhile
    const mine = jobs.filter((j) => j.kind === "search");
    const pick = mine.find((j) => ACTIVE.has(j.status)) || mine.find((j) => j.status === "done");
    if (pick) await loadJob(pick.id);
    else showIntroState();
  }

  // ------------------------------------------------------------------ panel

  function render(root, ctx) {
    injectStyle();
    S.ctx = ctx;
    S.recent = loadRecent();
    const { el, card, empty, section } = ui();
    S.statusEl = el("div", { class: "srch-status" }, el("span", { class: "srch-muted" }, "Idle"));
    S.progressEl = el("div");
    S.plistEl = el("div", null, empty("Run a search to see which providers answer."));
    S.resultsEl = el("div", { class: "srch-results" });
    S.recentEl = el("div");

    root.append(
      el("p", { class: "srch-intro" },
        "Ask a research question: ECCL expands it into sub-queries, fans out to PubChem, Wikipedia, arXiv, Crossref and DuckDuckGo, " +
        "de-duplicates and ranks the hits, then (optionally) has the configured LLM write a short briefing that cites only those sources."),
      el("div", { class: "srch-top" },
        card({ title: "Query", icon: "search" }, buildForm()),
        card({ title: "Provider status", subtitle: "Live per-provider outcome of the current search", icon: "activity" }, S.statusEl, S.progressEl, S.plistEl)),
      S.resultsEl,
      section("Recent searches", card({ title: "This session", subtitle: "Kept in this browser tab only", icon: "clock" }, S.recentEl)));
    paintRecent();
    initialLoad(ctx.params).catch((err) => console.error("[ECCL] search: initial load failed", err));
  }

  ECCL.registerPanel({
    id: "search",
    title: "Deep search",
    group: "AI & Data",
    icon: "search",
    description: "Multi-provider literature search with query expansion, ranking and grounded synthesis.",
    order: 110,
    render,
    onShow(params) {
      if (params && params.job) loadJob(params.job);
    },
  });
})(window.ECCL);
