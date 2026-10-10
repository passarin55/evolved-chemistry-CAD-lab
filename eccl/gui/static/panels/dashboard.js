/* Dashboard panel - lab overview: status tiles, quick analyze, module launcher and recent activity. */
window.ECCL = window.ECCL || {};

(function (ECCL) {
  "use strict";

  const GROUPS = ["Overview", "Chemistry", "Materials", "Analysis", "Discovery", "AI & Data"];
  const KIND_BADGE = { molecule: "info", material: "info", run: "ok", note: "neutral" };
  const QUICK = ["aspirin", "caffeine", "ibuprofen", "paracetamol"];
  const RECENT = 8;

  // Panel-local styles (scoped to #panel-dashboard); see the report for moving them into styles.css.
  const CSS = `
#panel-dashboard .dsh-hero {
  display: grid; gap: 20px 32px; align-items: center;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 340px), 1fr));
  padding: 22px 24px;
  background: linear-gradient(135deg, var(--accent-soft), var(--surface) 62%);
  border-color: var(--accent-border);
}
#panel-dashboard .dsh-hero > * + * { margin-top: 0; }
#panel-dashboard .dsh-brand { display: flex; align-items: flex-start; gap: 16px; min-width: 0; }
#panel-dashboard .dsh-logo {
  width: 52px; height: 52px; flex: none; display: grid; place-items: center;
  border-radius: 14px; background: var(--accent-strong); color: #fff; box-shadow: var(--shadow-sm);
}
#panel-dashboard .dsh-logo .icon { width: 30px; height: 30px; }
#panel-dashboard .dsh-name { font-size: 24px; font-weight: 700; letter-spacing: -0.01em; line-height: 1.2; }
#panel-dashboard .dsh-mission { margin-top: 6px; color: var(--text-2); max-width: 60ch; }
#panel-dashboard .dsh-meta { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 12px; }
#panel-dashboard .dsh-quick {
  padding: 14px 16px; border: 1px solid var(--border); border-radius: var(--radius-lg);
  background: var(--surface); box-shadow: var(--shadow-xs); min-width: 0;
}
#panel-dashboard .dsh-quick-title { font-size: 14px; font-weight: 650; display: flex; align-items: center; gap: 8px; }
#panel-dashboard .dsh-quick-title .icon { width: 17px; height: 17px; color: var(--accent); }
#panel-dashboard .dsh-quick-sub { font-size: 12.5px; color: var(--text-3); margin: 2px 0 10px; }
#panel-dashboard .dsh-quick .form-actions { margin-top: 10px; }
#panel-dashboard .dsh-examples { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; margin-top: 8px; font-size: 12.5px; color: var(--text-3); }
#panel-dashboard .dsh-tile-slot { display: grid; }
#panel-dashboard .dsh-tile { display: block; height: 100%; color: inherit; text-decoration: none; border-radius: var(--radius-lg); }
#panel-dashboard .dsh-tile .stat { height: 100%; transition: border-color 0.12s ease, box-shadow 0.12s ease; }
#panel-dashboard a.dsh-tile:hover .stat { border-color: var(--accent-border); box-shadow: var(--shadow-sm); }
#panel-dashboard .dsh-tile .stat-number { font-size: 21px; }
#panel-dashboard .dsh-group + .dsh-group { margin-top: 18px; }
#panel-dashboard .dsh-group-title {
  font-size: 12px; font-weight: 650; letter-spacing: 0.06em; text-transform: uppercase;
  color: var(--text-3); margin: 0 0 8px;
}
#panel-dashboard .dsh-mods { display: grid; gap: 12px; grid-template-columns: repeat(auto-fill, minmax(min(100%, 250px), 1fr)); }
#panel-dashboard .dsh-mod {
  display: flex; align-items: flex-start; gap: 12px; min-width: 0; padding: 14px;
  border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface);
  color: var(--text); text-decoration: none; box-shadow: var(--shadow-xs);
  transition: border-color 0.12s ease, box-shadow 0.12s ease, transform 0.12s ease;
}
#panel-dashboard .dsh-mod:hover { border-color: var(--accent-border); box-shadow: var(--shadow-md); transform: translateY(-1px); text-decoration: none; }
#panel-dashboard .dsh-mod-icon {
  width: 36px; height: 36px; flex: none; display: grid; place-items: center; border-radius: 10px;
  background: var(--accent-soft); border: 1px solid var(--accent-border); color: var(--accent);
}
#panel-dashboard .dsh-mod-icon .icon { width: 19px; height: 19px; }
#panel-dashboard .dsh-mod-body { min-width: 0; flex: 1; }
#panel-dashboard .dsh-mod-title { display: flex; align-items: center; gap: 4px; font-weight: 650; font-size: 14px; }
#panel-dashboard .dsh-mod-title .icon { width: 15px; height: 15px; color: var(--text-3); margin-left: auto; transition: transform 0.12s ease; }
#panel-dashboard .dsh-mod:hover .dsh-mod-title .icon { color: var(--accent); transform: translateX(2px); }
#panel-dashboard .dsh-mod-desc {
  margin-top: 3px; font-size: 12.5px; color: var(--text-2); line-height: 1.45;
  display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden;
}
#panel-dashboard .dsh-acts { list-style: none; margin: 0; padding: 0; }
#panel-dashboard .dsh-act {
  display: flex; align-items: center; gap: 10px; min-width: 0; padding: 9px 8px; margin: 0 -8px;
  border-radius: var(--radius); color: var(--text); text-decoration: none;
}
#panel-dashboard .dsh-acts li + li .dsh-act { border-top: 1px solid var(--border-subtle); border-radius: 0 0 var(--radius) var(--radius); }
#panel-dashboard .dsh-act:hover { background: var(--row-hover); text-decoration: none; }
#panel-dashboard .dsh-act .badge { flex: none; min-width: 78px; justify-content: center; }
#panel-dashboard .dsh-act-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#panel-dashboard .dsh-act-time { flex: none; font-size: 12px; color: var(--text-3); white-space: nowrap; font-variant-numeric: tabular-nums; }
#panel-dashboard .dsh-act-id { font-size: 11.5px; color: var(--text-3); margin-left: 6px; }
@media (max-width: 520px) {
  #panel-dashboard .dsh-hero { padding: 16px; }
  #panel-dashboard .dsh-name { font-size: 20px; }
  #panel-dashboard .dsh-logo { width: 44px; height: 44px; }
  #panel-dashboard .dsh-act .badge { min-width: 0; }
  #panel-dashboard .dsh-act-id { display: none; }
  #panel-dashboard .dsh-mods { gap: 8px; }
  #panel-dashboard .dsh-mod { padding: 10px 12px; }
  #panel-dashboard .dsh-mod-desc { -webkit-line-clamp: 2; }
}`;

  function injectStyle() {
    if (document.getElementById("eccl-css-dashboard")) return;
    const st = document.createElement("style");
    st.id = "eccl-css-dashboard";
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  /** Seconds-or-ms epoch (or ISO string) -> Date, or null. */
  function toDate(ts) {
    if (ts === null || ts === undefined || ts === "") return null;
    if (typeof ts === "number") return new Date(ts < 1e12 ? ts * 1000 : ts);
    const n = Number(ts);
    if (Number.isFinite(n)) return toDate(n);
    const d = new Date(ts);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  function relTime(ts) {
    const d = toDate(ts);
    if (!d) return "—";
    const s = Math.round((Date.now() - d.getTime()) / 1000);
    if (s < 45) return "just now";
    if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    if (s < 7 * 86400) return `${Math.round(s / 86400)} d ago`;
    return d.toLocaleDateString();
  }

  function hashFor(id, params) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params || {})) if (v !== undefined && v !== null && v !== "") q.append(k, String(v));
    const qs = q.toString();
    return `#/${encodeURIComponent(id)}${qs ? `?${qs}` : ""}`;
  }

  /** "echo (offline, deterministic)" -> ["echo", "offline, deterministic"]. */
  function splitBackend(backend) {
    const s = String(backend || "unknown");
    const m = /^(.*?)\s*\((.*)\)\s*$/.exec(s);
    return m ? [m[1] || s, m[2]] : [s, ""];
  }

  const S = { ctx: null, tiles: {}, activity: null, notice: null, lastRefresh: 0, nbCount: null, nbLatest: null, jobs: null };

  // ------------------------------------------------------------------ status tiles

  function tile(key, href, spec) {
    const ui = ECCL.ui;
    const node = ui.stat(spec);
    const wrap = href
      ? ui.el("a", { class: "dsh-tile", href, title: spec.title || null }, node)
      : ui.el("div", { class: "dsh-tile" }, node);
    const holder = S.tiles[key];
    if (holder) holder.replaceChildren(wrap);
    return wrap;
  }

  function paintRdkit() {
    const ok = !!(S.ctx.info || ECCL.info || {}).rdkit;
    tile("rdkit", null, {
      label: "RDKit",
      value: ok ? "Available" : "Not installed",
      kind: ok ? "ok" : "bad",
      hint: ok ? "Depiction, descriptors, fingerprints" : "Structure features are disabled",
    });
  }

  function paintLlm() {
    const llm = (ECCL.info && ECCL.info.llm) || {};
    const [name, detail] = splitBackend(llm.backend);
    const reach = !!llm.reachable;
    const hint = reach
      ? ["Reachable", llm.model ? `model ${llm.model}` : detail].filter(Boolean).join(" · ")
      : `No server reachable${detail ? `: ${detail} fallback` : ": offline fallback"}`;
    tile("llm", "#/llm", { label: "LLM backend", value: name, kind: reach ? "ok" : "warn", hint, title: "Open the LLM console" });
    paintNotice();
  }

  function paintNotebook() {
    if (S.nbCount === null) {
      tile("notebook", "#/notebook", { label: "Lab notebook", value: ECCL.ui.spinner("Loading notebook"), hint: "Loading…" });
      return;
    }
    if (S.nbCount === undefined) {
      tile("notebook", "#/notebook", { label: "Lab notebook", value: "—", hint: "Notebook unavailable", kind: "bad" });
      return;
    }
    tile("notebook", "#/notebook", {
      label: "Lab notebook", value: S.nbCount, unit: S.nbCount === 1 ? "record" : "records",
      hint: S.nbLatest ? `Latest ${relTime(S.nbLatest)}` : "Empty: results are saved here", title: "Open the notebook",
    });
  }

  function paintJobs() {
    const list = S.jobs;
    if (list === null) {
      tile("jobs", "#/evolution", { label: "Background jobs", value: ECCL.ui.spinner("Loading jobs"), hint: "Loading…" });
      return;
    }
    if (list === undefined) {
      tile("jobs", "#/evolution", { label: "Background jobs", value: "—", hint: "Job service unavailable", kind: "bad" });
      return;
    }
    const running = list.filter((j) => j.status === "running").length;
    const queued = list.filter((j) => j.status === "queued").length;
    const finished = list.length - running - queued;
    tile("jobs", "#/evolution", {
      label: "Background jobs", value: running, unit: "running", kind: running || queued ? "info" : undefined,
      hint: `${queued} queued · ${finished} finished`, title: "Evolution runs, campaigns and deep searches",
    });
  }

  function paintNotice() {
    if (!S.notice) return;
    const ui = ECCL.ui;
    const llm = (ECCL.info && ECCL.info.llm) || {};
    const reach = !!llm.reachable;
    const body = ui.el("span", null,
      ui.el("strong", null, reach ? "LLM connected. " : "Offline mode. "),
      reach
        ? `AI features use the ${splitBackend(llm.backend)[0]} backend. `
        : "No local LLM server answered, so chat, the LLM critic and search synthesis use the deterministic offline client (placeholder answers). ",
      "Deep search needs outbound HTTPS to PubChem, Wikipedia, arXiv, Crossref and DuckDuckGo; without it every provider reports a failure. ",
      "Everything else runs locally.");
    S.notice.replaceChildren(ui.notice(body, reach ? "info" : "warn"));
  }

  // ------------------------------------------------------------------ data

  async function loadNotebook() {
    try {
      const nb = await ECCL.api.get("/api/notebook");
      const records = Array.isArray(nb.records) ? nb.records : [];
      S.nbCount = typeof nb.count === "number" ? nb.count : records.length;
      S.nbLatest = records.length ? records[0].created : null;
      paintNotebook();
      paintActivity(records.slice(0, RECENT), null);
    } catch (err) {
      S.nbCount = undefined;
      paintNotebook();
      paintActivity(null, err);
    }
  }

  async function loadJobs() {
    try {
      const r = await ECCL.api.get("/api/jobs", { quiet: true });
      S.jobs = Array.isArray(r.jobs) ? r.jobs : [];
    } catch (err) {
      S.jobs = undefined;
    }
    paintJobs();
  }

  function refresh() {
    S.lastRefresh = Date.now();
    return Promise.all([loadNotebook(), loadJobs()]);
  }

  // ------------------------------------------------------------------ recent activity

  function recordLink(rec) {
    const p = rec.payload || {};
    if (rec.kind === "molecule" && p.smiles) return hashFor("molecule", { smiles: p.smiles, record: rec.id });
    return hashFor("notebook", { id: rec.id });
  }

  function paintActivity(records, err) {
    const ui = ECCL.ui;
    if (!S.activity) return;
    if (err) { S.activity.replaceChildren(ui.errorBox(err)); return; }
    if (!records.length) {
      S.activity.replaceChildren(ui.empty("No lab activity yet. Analyse a molecule or start an evolution run and it will show up here."));
      return;
    }
    S.activity.replaceChildren(ui.el("ul", { class: "dsh-acts" }, records.map((rec) => {
      const d = toDate(rec.created);
      return ui.el("li", null, ui.el("a", { class: "dsh-act", href: recordLink(rec), title: rec.summary || rec.kind },
        ui.badge(rec.kind || "record", KIND_BADGE[rec.kind] || "neutral"),
        ui.el("span", { class: "dsh-act-text" }, rec.summary || rec.kind || "record",
          ui.el("span", { class: "dsh-act-id mono" }, rec.id || "")),
        ui.el("time", { class: "dsh-act-time", datetime: d ? d.toISOString() : null, title: d ? d.toLocaleString() : null }, relTime(rec.created))));
    })));
  }

  // ------------------------------------------------------------------ layout

  function hero(ctx) {
    const ui = ECCL.ui;
    const info = ctx.info || {};
    const presets = (info.presets && info.presets.molecules) || {};
    const quickForm = ui.form({
      fields: [{
        name: "smiles", label: "SMILES", type: "text", mono: true, required: true,
        placeholder: "e.g. CC(=O)Oc1ccccc1C(=O)O",
      }],
      columns: 1,
      submitLabel: "Analyze",
      submitIcon: "flask",
      onSubmit: (v) => { ctx.navigate("molecule", { smiles: v.smiles }); },
    });
    const examples = QUICK.filter((k) => presets[k]);
    return ui.card({ class: "dsh-hero" },
      ui.el("div", null,
        ui.el("div", { class: "dsh-brand" },
          ui.el("div", { class: "dsh-logo" }, ui.icon("logo")),
          ui.el("div", { style: { minWidth: 0 } },
            ui.el("h2", { class: "dsh-name" }, "Evolved Chemistry CAD Lab"),
            ui.el("p", { class: "dsh-mission" },
              "A local, offline-first workbench to analyse molecules and materials, then evolve better candidates under a panel of harsh critics."),
            ui.el("div", { class: "dsh-meta" },
              ui.badge(`version ${info.version || "?"}`, "info"),
              ui.badge(`${ECCL.panels.filter((p) => p.id !== "dashboard").length} modules`, "neutral"),
              ui.badge(`local server · ${window.location.host || "offline"}`, "neutral"))))),
      ui.el("div", { class: "dsh-quick" },
        ui.el("div", { class: "dsh-quick-title" }, ui.icon("flask"), "Quick analyze"),
        ui.el("p", { class: "dsh-quick-sub" }, "Paste a SMILES string to open it in the Molecule studio."),
        quickForm,
        examples.length ? ui.el("div", { class: "dsh-examples" }, ui.el("span", null, "Try:"),
          examples.map((k) => ui.button(k, { kind: "ghost", small: true, onClick: () => ctx.navigate("molecule", { smiles: presets[k] }) }))) : null));
  }

  function launcher(ctx) {
    const ui = ECCL.ui;
    const panels = ECCL.panels.filter((p) => p && p.id !== "dashboard");
    const groups = GROUPS.concat(Array.from(new Set(panels.map((p) => p.group).filter((g) => g && !GROUPS.includes(g)))));
    const blocks = groups.map((g) => {
      const items = panels.filter((p) => (p.group || "Overview") === g)
        .sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0) || String(a.title || a.id).localeCompare(String(b.title || b.id)));
      if (!items.length) return null;
      return ui.el("div", { class: "dsh-group" },
        ui.el("h3", { class: "dsh-group-title" }, g),
        ui.el("div", { class: "dsh-mods" }, items.map((p) => ui.el("a", {
          class: "dsh-mod", href: hashFor(p.id), dataset: { panel: p.id },
          on: { click: (ev) => { if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.button) return; ev.preventDefault(); ctx.navigate(p.id); } },
        },
        ui.el("span", { class: "dsh-mod-icon" }, ui.icon(p.icon || "info")),
        ui.el("span", { class: "dsh-mod-body" },
          ui.el("span", { class: "dsh-mod-title" }, p.title || p.id, ui.icon("chevron-right")),
          p.description ? ui.el("span", { class: "dsh-mod-desc" }, p.description) : null)))));
    });
    return ui.section("Modules", blocks);
  }

  // ------------------------------------------------------------------ panel

  ECCL.registerPanel({
    id: "dashboard",
    title: "Dashboard",
    group: "Overview",
    icon: "home",
    description: "Lab overview: capabilities, quick actions and recent activity.",
    order: 0,
    render(root, ctx) {
      const ui = ECCL.ui;
      injectStyle();
      S.ctx = ctx;
      for (const k of ["rdkit", "llm", "notebook", "jobs"]) S.tiles[k] = ui.el("div", { class: "dsh-tile-slot" });
      S.notice = ui.el("div");
      S.activity = ui.el("div", null, ui.el("div", { class: "tab-loading" }, ui.spinner("Loading activity")));

      const activityCard = ui.card({
        title: "Recent activity",
        subtitle: `The last ${RECENT} notebook records: analyses, runs and notes.`,
        actions: [
          ui.button("Refresh", { kind: "ghost", small: true, icon: "refresh", onClick: () => refresh() }),
          ui.button("Open notebook", { kind: "secondary", small: true, icon: "book", onClick: () => ctx.navigate("notebook") }),
        ],
      }, S.activity);

      root.append(
        hero(ctx),
        ui.grid(4, S.tiles.rdkit, S.tiles.llm, S.tiles.notebook, S.tiles.jobs),
        S.notice,
        activityCard,
        launcher(ctx));

      paintRdkit();
      paintLlm();
      paintNotebook();
      paintJobs();

      ctx.bus.on("notebook:changed", () => { loadNotebook(); });
      // the shell re-polls /api/jobs on "jobs:changed" and broadcasts the list as "jobs:list"
      ctx.bus.on("jobs:list",(list) => { if (Array.isArray(list)) { S.jobs = list; paintJobs(); } });
      ctx.bus.on("llm:changed", (data) => {
        if (data && typeof data === "object" && "backend" in data) {
          ECCL.info.llm = { ...(ECCL.info.llm || {}), ...data };
          paintLlm();
        } else {
          ECCL.api.get("/api/llm/status", { quiet: true }).then((st) => { ECCL.info.llm = st; paintLlm(); }, () => {});
        }
      });
      refresh();
    },
    onShow() {
      // render() has just loaded everything on first activation; afterwards refresh (cheap).
      if (Date.now() - S.lastRefresh > 1500) refresh();
    },
  });
})(window.ECCL);
