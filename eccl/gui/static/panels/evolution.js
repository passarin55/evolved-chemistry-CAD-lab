/* Evolution panel - evolve molecules with the multi-objective genetic algorithm,
 * or run a discovery campaign (optional deep-search grounding + evolution +
 * analysis of the winners). Runs are background jobs: the panel streams the
 * per-generation fitness into a live chart, depicts the best-so-far molecule,
 * logs events and renders the hall of fame when the job finishes.
 */
window.ECCL = window.ECCL || {};

(function (ECCL) {
  "use strict";

  const JOB_KINDS = new Set(["evolve", "campaign"]);
  const ACTIVE = new Set(["queued", "running"]);
  const STATUS_KIND = { queued: "neutral", running: "info", done: "ok", error: "bad", cancelled: "warn" };
  const KIND_LABEL = { evolve: "Evolve", campaign: "Campaign" };
  const DEPICT_EVERY_MS = 1200;
  const MAX_LOG = 250;

  const ASPIRIN = "CC(=O)Oc1ccccc1C(=O)O";
  const NOVELTY_LIBRARY = [
    "CC(=O)Oc1ccccc1C(=O)O",
    "CN1C=NC2=C1C(=O)N(C(=O)N2C)C",
    "CC(C)Cc1ccc(cc1)C(C)C(=O)O",
    "CC(=O)Nc1ccc(O)cc1",
  ];

  /* Objective terms (docs/gui.md "Evolve spec"). `on` = enabled by default. */
  const OBJECTIVES = [
    { key: "druglike", label: "Drug-likeness", on: true, weight: 1.0,
      help: "QED-like desirability, minus 0.15 per structural alert." },
    { key: "mol_weight", label: "Molecular weight", on: true, weight: 0.6, target: 320, tolerance: 50, unit: "g/mol",
      help: "Gaussian reward for hitting a target molar mass." },
    { key: "logp", label: "logP", on: false, weight: 0.5, target: 2.5, tolerance: 1.0, unit: "",
      help: "Gaussian reward for a target lipophilicity (Crippen logP)." },
    { key: "tpsa", label: "TPSA", on: false, weight: 0.5, target: 80, tolerance: 30, unit: "Å²",
      help: "Gaussian reward for a target topological polar surface area." },
    { key: "synthesizability", label: "Synthesizability", on: true, weight: 0.5,
      help: "Inverted synthetic-accessibility proxy (easy to make = 1)." },
    { key: "similarity", label: "Similarity", on: false, weight: 0.7, reference: ASPIRIN,
      help: "Tanimoto similarity to a reference molecule (scaffold hopping)." },
    { key: "novelty", label: "Novelty", on: false, weight: 0.5, library: NOVELTY_LIBRARY,
      help: "1 − max similarity to a known library (rewards new chemotypes)." },
  ];
  const TERM_LABEL = Object.fromEntries(OBJECTIVES.map((o) => [o.key, o.label]));

  const GA_DEFAULTS = {
    population: 30, generations: 12, seed: null, elitism: 2, mutation_rate: 0.6, crossover_rate: 0.4,
    patience: 0, use_gate: true, harshness: "HARSH", seeds: "",
  };
  const CAMPAIGN_DEFAULTS = { title: "Discovery campaign", ground_query: "", top_n: 3 };

  const CSS = `
#panel-evolution .evo-intro { color: var(--text-2); max-width: 92ch; }
#panel-evolution .evo-modebar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 14px; }
#panel-evolution .evo-modehint { color: var(--text-3); font-size: 13px; min-width: 0; flex: 1 1 260px; }
#panel-evolution .evo-top { display: grid; gap: var(--gap); grid-template-columns: minmax(0, 1fr); align-items: start; }
@media (min-width: 1100px) { #panel-evolution .evo-top { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); } }
#panel-evolution .evo-top > * + * { margin-top: 0; }
#panel-evolution .evo-obj-list { display: grid; gap: 10px; grid-template-columns: repeat(auto-fill, minmax(min(100%, 420px), 1fr)); align-items: stretch; }
#panel-evolution .evo-obj { display: grid; grid-template-columns: minmax(0, 1fr) minmax(140px, 0.75fr); gap: 4px 16px; padding: 12px 14px; border: 1px solid var(--accent-border); border-radius: var(--radius-md); background: var(--surface-2); align-items: start; transition: border-color 0.12s ease; }
#panel-evolution .evo-obj.is-off { border-color: var(--border-subtle); }
#panel-evolution .evo-obj > * + * { margin-top: 0; }
#panel-evolution .evo-obj-name .check { min-height: 24px; font-weight: 650; }
#panel-evolution .evo-obj-name .field-error { display: none; }
#panel-evolution .evo-obj-help { margin: 2px 0 0 26px; font-size: 12px; color: var(--text-3); }
#panel-evolution .evo-obj-weight .range { margin-top: 2px; }
#panel-evolution .evo-obj-params { grid-column: 1 / -1; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px 12px; padding-left: 26px; margin-top: 4px; }
#panel-evolution .evo-obj-params > .span-full { grid-column: 1 / -1; }
#panel-evolution .evo-obj.is-off .evo-obj-weight, #panel-evolution .evo-obj.is-off .evo-obj-help { opacity: 0.6; }
#panel-evolution .evo-obj.is-off .evo-obj-params { display: none; }
#panel-evolution .evo-obj-summary { font-size: 12.5px; color: var(--text-3); }
#panel-evolution .evo-campaign { display: flex; flex-direction: column; gap: 10px; padding: 12px; border: 1px solid var(--accent-border); border-radius: var(--radius-md); background: var(--accent-soft); }
#panel-evolution .evo-campaign-title { display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 650; color: var(--accent); }
#panel-evolution .evo-campaign-title .icon { width: 16px; height: 16px; }
#panel-evolution .evo-campaign-grid { display: grid; gap: 10px 14px; grid-template-columns: repeat(auto-fill, minmax(min(100%, 200px), 1fr)); }
#panel-evolution .evo-campaign-grid .span-full { grid-column: 1 / -1; }
#panel-evolution .evo-status { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; min-width: 0; font-size: 13px; color: var(--text-2); }
#panel-evolution .evo-status .mono { color: var(--text-3); font-size: 12px; }
#panel-evolution .evo-best { display: grid; grid-template-columns: minmax(0, 200px) minmax(0, 1fr); gap: 14px; align-items: start; }
#panel-evolution .evo-best > * + * { margin-top: 0; }
#panel-evolution .evo-best-info { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
#panel-evolution .evo-best-info > * + * { margin-top: 0; }
#panel-evolution .evo-smiles { font-family: var(--font-mono); font-size: 12.5px; color: var(--text); word-break: break-all; overflow-wrap: anywhere; }
#panel-evolution .evo-muted { color: var(--text-3); font-size: 12.5px; }
#panel-evolution .evo-log-wrap > summary { cursor: pointer; font-size: 13px; font-weight: 600; color: var(--text-2); }
#panel-evolution .evo-log { list-style: none; margin: 8px 0 0; padding: 8px 10px; max-height: 180px; overflow: auto; background: var(--code-bg); border: 1px solid var(--border); border-radius: var(--radius); font: 12px/1.6 var(--font-mono); color: var(--text-2); }
#panel-evolution .evo-log li { white-space: pre-wrap; overflow-wrap: anywhere; }
#panel-evolution .evo-log .t { color: var(--text-3); margin-right: 6px; }
#panel-evolution .evo-log .is-bad { color: var(--bad); }
#panel-evolution .evo-log .is-ok { color: var(--ok); }
#panel-evolution .evo-log .is-warn { color: var(--warn); }
#panel-evolution .evo-hof .card { display: flex; flex-direction: column; gap: 10px; }
#panel-evolution .evo-hof .card > * + * { margin-top: 0; }
#panel-evolution .evo-card-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
#panel-evolution .evo-rank { display: inline-flex; align-items: center; gap: 8px; font-weight: 650; font-size: 14px; }
#panel-evolution .evo-rank-n { display: inline-grid; place-items: center; min-width: 26px; height: 26px; padding: 0 6px; border-radius: 8px; background: var(--accent-soft); color: var(--accent); font-size: 12.5px; font-weight: 700; border: 1px solid var(--accent-border); }
#panel-evolution .evo-breakdown { display: flex; flex-direction: column; gap: 6px; }
#panel-evolution .evo-breakdown .meter-head { font-size: 12px; margin-bottom: 3px; }
#panel-evolution .evo-breakdown .meter-track { height: 5px; }
#panel-evolution .evo-badges { display: flex; flex-wrap: wrap; gap: 5px; }
#panel-evolution .evo-badges .badge { height: 20px; font-size: 11.5px; font-weight: 550; }
#panel-evolution .evo-card-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: auto; padding-top: 4px; }
#panel-evolution .evo-card-actions .btn { max-width: 100%; }
#panel-evolution .evo-card-actions .btn-label { overflow: hidden; text-overflow: ellipsis; }
#panel-evolution .evo-hof .grid, #panel-evolution .evo-winners.grid { --grid-min: 230px; }
#panel-evolution .evo-sublabel { font-size: 11.5px; font-weight: 650; letter-spacing: 0.05em; text-transform: uppercase; color: var(--text-3); }
#panel-evolution .evo-notes { margin: 0; padding-left: 18px; color: var(--text-2); }
#panel-evolution .evo-notes li + li { margin-top: 4px; }
#panel-evolution .evo-prov { display: flex; flex-direction: column; gap: 6px; }
#panel-evolution .evo-prov-row { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 6px 10px; min-width: 0; }
#panel-evolution .evo-prov-row details { flex: 1 1 220px; min-width: 0; font-size: 12px; color: var(--text-3); }
#panel-evolution .evo-prov-row summary { cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#panel-evolution .evo-prov-row details p { margin-top: 4px; font-family: var(--font-mono); word-break: break-all; }
#panel-evolution .evo-synthesis { white-space: pre-wrap; overflow-wrap: anywhere; padding: 10px 12px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface-2); font-size: 13.5px; }
#panel-evolution .evo-history .badge { height: 20px; font-size: 11.5px; }
#panel-evolution .evo-history .evo-viewing { margin-left: 6px; }
#panel-evolution .evo-stats.grid { --grid-min: 150px; }
#panel-evolution .evo-best-mol .molecule { transition: opacity 0.2s ease; }
#panel-evolution .evo-best-mol .molecule.is-stale { opacity: 0.5; }
#panel-evolution .evo-mini-mol .molecule-paper { aspect-ratio: 4 / 3; }
#panel-evolution .evo-mini-mol .molecule-missing .spinner { margin-bottom: 2px; }
@media (max-width: 560px) {
  #panel-evolution .evo-obj { grid-template-columns: minmax(0, 1fr); }
  #panel-evolution .evo-obj-params, #panel-evolution .evo-obj-help { padding-left: 0; margin-left: 0; }
  #panel-evolution .evo-best { grid-template-columns: minmax(0, 1fr); }
  #panel-evolution .evo-best .molecule { max-width: 260px; }
}
`;

  function injectStyle() {
    if (document.getElementById("eccl-css-evolution")) return;
    const st = document.createElement("style");
    st.id = "eccl-css-evolution";
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  const S = {
    ctx: null, mode: "evolve", seg: null, modeHint: null, rows: [], objSummary: null,
    form: null, campaign: null, campaignFields: {}, cancelBtns: [], resetBtn: null,
    statusEl: null, progressEl: null, chart: null, bestEl: null, logEl: null, liveCard: null,
    resultsEl: null, historyEl: null, historySig: "", jobs: [],
    view: null,        // {id, kind, total, history[], lastMsg, status, best}
    loadSeq: 0, autoNote: null,
    poll: null, token: 0, running: false,
    depict: { pending: null, shown: null, busy: false, last: 0, timer: 0 },
    svgCache: new Map(), depictChain: Promise.resolve(),
  };

  const ui = () => ECCL.ui;
  const api = () => ECCL.api;

  // ------------------------------------------------------------------ small helpers

  function splitSmiles(text) {
    return String(text || "").split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
  }

  function clockTime(ts) {
    if (!Number.isFinite(ts)) return "—";
    try { return new Date(ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }); }
    catch (err) { return "—"; }
  }

  function withClass(node, cls) { node.classList.add(cls); return node; }

  function fit3(v) { return Number.isFinite(v) ? v.toFixed(3) : "—"; }

  function fitKind(v) { return v >= 0.8 ? "ok" : v >= 0.5 ? "info" : "warn"; }

  function intValidator(v) { return v !== null && !Number.isInteger(v) ? "Enter a whole number" : null; }

  function cachedDepiction(slot, smiles, svg) {
    const { molecule, el, spinner, icon } = ui();
    if (svg) { S.svgCache.set(smiles, svg); slot.replaceChildren(molecule(svg)); return; }
    if (S.svgCache.has(smiles)) { slot.replaceChildren(molecule(S.svgCache.get(smiles))); return; }
    slot.replaceChildren(el("figure", { class: "molecule" }, el("div", { class: "molecule-paper is-missing" },
      el("div", { class: "molecule-missing" }, spinner("Depicting"), el("span", null, "Depicting…")))));
    S.depictChain = S.depictChain.then(() => api().post("/api/molecule/depict", { smiles, width: 280, height: 210 }, { quiet: true })
      .then((r) => { S.svgCache.set(smiles, r.svg); if (slot.isConnected) slot.replaceChildren(molecule(r.svg)); },
        () => { if (slot.isConnected) slot.replaceChildren(el("figure", { class: "molecule" }, el("div", { class: "molecule-paper is-missing" }, el("div", { class: "molecule-missing" }, icon("flask"), el("span", null, "No depiction"))))); }));
  }

  // ------------------------------------------------------------------ objective builder

  function buildObjectiveRow(def) {
    const { el, field } = ui();
    const row = el("div", { class: "evo-obj", dataset: { term: def.key } });
    const enable = field({ name: `obj_${def.key}_on`, label: def.label, type: "checkbox", value: def.on });
    const weight = field({
      name: `obj_${def.key}_w`, label: "Weight", type: "range", min: 0, max: 2, step: 0.05, value: def.weight,
      format: (v) => v.toFixed(2),
    });
    const params = {};
    let paramsEl = null;
    if ("target" in def) {
      const u = def.unit ? ` (${def.unit})` : "";
      params.target = field({ name: `obj_${def.key}_target`, label: `Target${u}`, type: "number", value: def.target, step: "any", required: true });
      params.tolerance = field({ name: `obj_${def.key}_tol`, label: `± tolerance${u}`, type: "number", value: def.tolerance, step: "any", min: 1e-6, required: true });
      paramsEl = el("div", { class: "evo-obj-params" }, params.target, params.tolerance);
    } else if ("reference" in def) {
      params.reference = field({ name: `obj_${def.key}_ref`, label: "Reference SMILES", type: "text", value: def.reference, mono: true, placeholder: "e.g. CC(=O)Oc1ccccc1C(=O)O" });
      params.reference.classList.add("span-full");
      paramsEl = el("div", { class: "evo-obj-params" }, params.reference);
    } else if ("library" in def) {
      params.library = field({ name: `obj_${def.key}_lib`, label: "Library (one SMILES per line)", type: "textarea", rows: 3, value: def.library.join("\n"), mono: true });
      params.library.classList.add("span-full");
      paramsEl = el("div", { class: "evo-obj-params" }, params.library);
    }
    row.append(el("div", { class: "evo-obj-name" }, enable, el("p", { class: "evo-obj-help" }, def.help)), el("div", { class: "evo-obj-weight" }, weight));
    if (paramsEl) row.appendChild(paramsEl);

    const r = { def, row, enable, weight, params };
    const paint = () => { row.classList.toggle("is-off", !enable.getValue()); updateObjSummary(); };
    enable.input.addEventListener("change", paint);
    // Editing a dimmed (disabled) term switches it on.
    const autoOn = () => { if (!enable.getValue()) { enable.setValue(true); paint(); } else updateObjSummary(); };
    weight.input.addEventListener("input", autoOn);
    for (const p of Object.values(params)) p.input.addEventListener("input", autoOn);
    r.paint = paint;
    row.classList.toggle("is-off", !def.on);
    return r;
  }

  function updateObjSummary() {
    if (!S.objSummary) return;
    const active = S.rows.filter((r) => r.enable.getValue() && r.weight.getValue() > 0);
    const total = active.reduce((a, r) => a + r.weight.getValue(), 0);
    S.objSummary.textContent = active.length
      ? `${active.length} active term${active.length === 1 ? "" : "s"} · total weight ${total.toFixed(2)} · fitness = weighted mean of term scores (0–1)`
      : "No active term: enable at least one objective with a weight above 0.";
    S.objSummary.style.color = active.length ? "" : "var(--bad)";
  }

  /** Validate the objective rows and return the `objectives` object; throws on bad input. */
  function readObjectives() {
    const out = {};
    let firstBad = null;
    const fail = (fieldEl, msg) => { fieldEl.setError(msg); if (!firstBad) firstBad = { fieldEl, msg }; };
    for (const r of S.rows) {
      for (const p of Object.values(r.params)) p.setError(null);
      if (!r.enable.getValue()) continue;
      const w = r.weight.getValue();
      if (!(w > 0)) continue;
      const entry = { weight: Math.round(w * 100) / 100 };
      if (r.params.target) {
        const t = r.params.target.getValue(), tol = r.params.tolerance.getValue();
        if (t === null || !Number.isFinite(t)) fail(r.params.target, "Enter a target value");
        if (tol === null || !Number.isFinite(tol) || tol <= 0) fail(r.params.tolerance, "Tolerance must be > 0");
        entry.target = t; entry.tolerance = tol;
      } else if (r.params.reference) {
        const ref = r.params.reference.getValue();
        if (!ref) fail(r.params.reference, "Enter a reference SMILES");
        entry.reference = ref;
      } else if (r.params.library) {
        const lib = splitSmiles(r.params.library.getValue());
        if (!lib.length) fail(r.params.library, "Enter at least one SMILES");
        entry.library = lib;
      }
      out[r.def.key] = entry;
    }
    if (firstBad) {
      firstBad.fieldEl.input.focus();
      throw new Error(`${firstBad.fieldEl.spec.label}: ${firstBad.msg}`);
    }
    if (!Object.keys(out).length) throw new Error("Enable at least one objective term with a weight above 0.");
    return out;
  }

  // ------------------------------------------------------------------ setup form

  function buildCampaignBlock() {
    const { el, field, icon } = ui();
    const f = {
      title: field({ name: "title", label: "Campaign title", type: "text", value: CAMPAIGN_DEFAULTS.title, required: true }),
      ground_query: field({
        name: "ground_query", label: "Deep-search grounding query (optional)", type: "text", value: CAMPAIGN_DEFAULTS.ground_query,
        placeholder: "e.g. kinase inhibitor scaffolds", help: "Runs a literature search before evolving. Needs outbound network access; offline it adds ~6 s and a note.",
      }),
      top_n: field({ name: "top_n", label: "Winners to analyse", type: "number", value: CAMPAIGN_DEFAULTS.top_n, min: 1, max: 10, step: 1, required: true, validate: intValidator }),
    };
    f.ground_query.classList.add("span-full");
    S.campaignFields = f;
    return el("div", { class: "evo-campaign span-full", hidden: S.mode !== "campaign" },
      el("div", { class: "evo-campaign-title" }, icon("sparkle"), "Campaign extras"),
      el("div", { class: "evo-campaign-grid" }, f.title, f.top_n, f.ground_query));
  }

  function buildSetupForm() {
    const { form, button } = ui();
    const harshness = (ECCL.info.libraries && ECCL.info.libraries.harshness) || ["LENIENT", "NORMAL", "HARSH", "BRUTAL"];
    S.campaign = buildCampaignBlock();
    const cancel = button("Cancel run", { kind: "danger", icon: "stop", onClick: cancelRun });
    cancel.hidden = true;
    S.cancelBtns.push(cancel);
    S.resetBtn = button("Reset defaults", { kind: "ghost", icon: "refresh", onClick: resetDefaults });
    S.form = form({
      columns: 2,
      submitLabel: "Start evolution",
      submitIcon: "play",
      actions: [cancel, S.resetBtn],
      fields: [
        S.campaign,
        { name: "population", label: "Population", type: "number", value: GA_DEFAULTS.population, min: 4, max: 500, step: 1, required: true, validate: intValidator, help: "Molecules per generation (4–500)" },
        { name: "generations", label: "Generations", type: "number", value: GA_DEFAULTS.generations, min: 1, max: 500, step: 1, required: true, validate: intValidator, help: "1–500" },
        { name: "seed", label: "Random seed", type: "number", value: null, step: 1, placeholder: "random", validate: intValidator, help: "Blank = a new random run each time" },
        { name: "elitism", label: "Elitism", type: "number", value: GA_DEFAULTS.elitism, min: 0, max: 500, step: 1, required: true, validate: intValidator, help: "Best individuals copied unchanged" },
        { name: "mutation_rate", label: "Mutation rate", type: "range", value: GA_DEFAULTS.mutation_rate, min: 0, max: 1, step: 0.05, format: (v) => v.toFixed(2) },
        { name: "crossover_rate", label: "Crossover rate", type: "range", value: GA_DEFAULTS.crossover_rate, min: 0, max: 1, step: 0.05, format: (v) => v.toFixed(2) },
        { name: "patience", label: "Patience", type: "number", value: GA_DEFAULTS.patience, min: 0, max: 500, step: 1, required: true, validate: intValidator, help: "Stop after N generations without improvement (0 = never)" },
        { name: "harshness", label: "Gate harshness", type: "select", options: harshness, value: GA_DEFAULTS.harshness, help: "How strictly the critics veto offspring" },
        { name: "use_gate", label: "Screen offspring with the critics gate", type: "checkbox", value: GA_DEFAULTS.use_gate, span: "full",
          onChange: (v) => { const h = S.form && S.form.field("harshness"); if (h) h.input.disabled = !v; } },
        { name: "seeds", label: "Seed SMILES (optional)", type: "textarea", rows: 3, value: GA_DEFAULTS.seeds, mono: true,
          placeholder: "One SMILES per line. Blank = the built-in seed set.", help: "Starting population; invalid SMILES are rejected before the run starts." },
      ],
      onSubmit: startRun,
    });
    return S.form;
  }

  function setMode(mode) {
    S.mode = mode === "campaign" ? "campaign" : "evolve";
    if (S.seg && S.seg.getValue() !== S.mode) S.seg.setValue(S.mode);
    if (S.campaign) S.campaign.hidden = S.mode !== "campaign";
    if (S.form && S.form.submitButton) {
      const lbl = S.form.submitButton.querySelector(".btn-label");
      if (lbl) lbl.textContent = S.mode === "campaign" ? "Start campaign" : "Start evolution";
    }
    if (S.modeHint) {
      S.modeHint.textContent = S.mode === "campaign"
        ? "Campaign: optional literature grounding, then evolution, then IR / drug-likeness / gate analysis of the top molecules."
        : "Evolve: run the genetic algorithm and inspect the hall of fame.";
    }
  }

  function buildSpec(values) {
    const objectives = readObjectives();
    const pop = values.population, elit = values.elitism;
    if (Number.isFinite(pop) && Number.isFinite(elit) && elit > pop) {
      const f = S.form.field("elitism");
      f.setError("Must not exceed the population");
      f.input.focus();
      throw new Error("Elitism must not exceed the population size.");
    }
    const seeds = splitSmiles(values.seeds);
    const spec = {
      objectives,
      population: pop, generations: values.generations, seed: values.seed === null ? null : values.seed,
      elitism: elit, mutation_rate: values.mutation_rate, crossover_rate: values.crossover_rate,
      patience: values.patience, use_gate: !!values.use_gate, harshness: values.harshness,
      seeds: seeds.length ? seeds : null,
    };
    if (S.mode === "campaign") {
      const f = S.campaignFields;
      let bad = null;
      for (const fe of [f.title, f.top_n, f.ground_query]) { const m = fe.validate(); if (m && !bad) bad = [fe, m]; }
      if (bad) { bad[0].input.focus(); throw new Error(`${bad[0].spec.label}: ${bad[1]}`); }
      spec.title = f.title.getValue();
      spec.ground_query = f.ground_query.getValue() || null;
      spec.top_n = f.top_n.getValue();
    }
    return spec;
  }

  async function startRun(values) {
    if (S.running) throw new Error("A run is already in progress. Cancel it or wait for it to finish.");
    const spec = buildSpec(values);
    const kind = S.mode;
    const r = await api().post(kind === "campaign" ? "/api/campaign/start" : "/api/evolve/start", spec);
    S.loadSeq += 1;
    ECCL.bus.emit("jobs:changed", { id: r.job_id, status: "queued" });
    if (!S.autoNote) ui().toast(`${kind === "campaign" ? "Campaign" : "Evolution"} started (${r.job_id})`, "info", 2500);
    // After the form's busy state settles, so the submit button state is not overwritten.
    setTimeout(() => track(r.job_id, kind, { generations: spec.generations, params: spec }), 0);
    return r;
  }

  function resetDefaults() {
    S.form.setValues(GA_DEFAULTS);
    const h = S.form.field("harshness");
    if (h) h.input.disabled = false;
    for (const r of S.rows) {
      r.enable.setValue(r.def.on);
      r.weight.setValue(r.def.weight);
      if (r.params.target) { r.params.target.setValue(r.def.target); r.params.tolerance.setValue(r.def.tolerance); }
      if (r.params.reference) r.params.reference.setValue(r.def.reference);
      if (r.params.library) r.params.library.setValue(r.def.library.join("\n"));
      for (const p of Object.values(r.params)) p.setError(null);
      r.paint();
    }
    for (const [k, fe] of Object.entries(S.campaignFields)) { fe.setValue(CAMPAIGN_DEFAULTS[k]); fe.setError(null); }
    ui().toast("Settings reset to defaults", "info", 2000);
  }

  /** Copy a job's request parameters back into the forms. */
  function applyParams(params, kind) {
    if (!params) return;
    setMode(kind);
    const objs = params.objectives || {};
    for (const r of S.rows) {
      const o = objs[r.def.key];
      r.enable.setValue(!!o);
      if (o) {
        if (Number.isFinite(o.weight)) r.weight.setValue(Math.min(2, o.weight));
        if (r.params.target && Number.isFinite(o.target)) r.params.target.setValue(o.target);
        if (r.params.tolerance && Number.isFinite(o.tolerance)) r.params.tolerance.setValue(o.tolerance);
        if (r.params.reference && o.reference) r.params.reference.setValue(o.reference);
        if (r.params.library && Array.isArray(o.library)) r.params.library.setValue(o.library.join("\n"));
      }
      r.paint();
    }
    const v = {};
    for (const k of ["population", "generations", "seed", "elitism", "mutation_rate", "crossover_rate", "patience", "use_gate", "harshness"]) {
      if (k in params) v[k] = params[k];
    }
    v.seeds = Array.isArray(params.seeds) ? params.seeds.join("\n") : "";
    S.form.setValues(v);
    const h = S.form.field("harshness");
    if (h) h.input.disabled = params.use_gate === false;
    if (kind === "campaign") {
      if (params.title) S.campaignFields.title.setValue(params.title);
      S.campaignFields.ground_query.setValue(params.ground_query || "");
      if (Number.isFinite(params.top_n)) S.campaignFields.top_n.setValue(params.top_n);
    }
    ui().toast("Settings loaded from the job; press Start to run them again", "ok", 3000);
    S.form.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // ------------------------------------------------------------------ live view

  function buildLiveCard() {
    const { el, card, button, empty } = ui();
    S.statusEl = el("div", { class: "evo-status" }, el("span", null, "No run yet."));
    S.progressEl = el("div", { class: "evo-progress" });
    const chartEl = el("div", { class: "evo-chart" });
    S.bestEl = el("div", { class: "evo-best-wrap" }, empty("The best molecule so far appears here while a run is in progress."));
    S.logEl = el("ol", { class: "evo-log", "aria-live": "off" });
    const cancel = button("Cancel", { kind: "danger", small: true, icon: "stop", onClick: cancelRun });
    cancel.hidden = true;
    S.cancelBtns.push(cancel);
    S.liveCard = card({ title: "Live run", subtitle: "Fitness per generation, best-so-far molecule and event log", icon: "activity", actions: cancel },
      S.statusEl, S.progressEl, chartEl,
      el("div", { class: "evo-sublabel" }, "Best so far"), S.bestEl,
      el("details", { class: "evo-log-wrap", open: true }, el("summary", null, "Event log"), S.logEl));
    S.chart = ECCL.plot.lineChart(chartEl, chartSpec([], null));
    return S.liveCard;
  }

  function chartSpec(history, total) {
    const gens = history.map((h) => h.generation);
    const t = Number(total) || 0;
    const spec = {
      title: "Population fitness",
      series: [
        { name: "Best", x: gens, y: history.map((h) => h.best), color: 1, width: 2.5 },
        { name: "Mean", x: gens, y: history.map((h) => h.mean), color: 2 },
        { name: "Worst", x: gens, y: history.map((h) => h.worst), color: 3, dash: true },
      ],
      xLabel: "Generation",
      yLabel: "Fitness (weighted score, 0–1)",
      yDomain: [0, 1],
      height: 260,
      empty: "Start a run to see fitness by generation",
      xFormat: (v) => `Generation ${Math.round(v)}`,
      yFormat: (v) => ui().fmt(v, 3),
    };
    if (t > 1) spec.xDomain = [1, t];
    if (t > 1 && t <= 12) spec.xTicks = Array.from({ length: t }, (_, i) => ({ x: i + 1, label: String(i + 1) }));
    return spec;
  }

  function log(text, kind) {
    const { el } = ui();
    const now = new Date();
    const t = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}`;
    S.logEl.appendChild(el("li", { class: kind ? `is-${kind}` : null }, el("span", { class: "t" }, t), text));
    while (S.logEl.children.length > MAX_LOG) S.logEl.firstElementChild.remove();
    S.logEl.scrollTop = S.logEl.scrollHeight;
  }

  function setRunning(on) {
    S.running = !!on;
    for (const b of S.cancelBtns) { b.hidden = !on; b.disabled = false; }
    if (S.form && S.form.submitButton) S.form.submitButton.hidden = !!on;
  }

  function paintStatus(job) {
    const { el, badge, meter } = ui();
    const v = S.view;
    const p = (job && job.progress) || {};
    const status = (job && job.status) || "queued";
    S.statusEl.replaceChildren(
      badge(status, STATUS_KIND[status] || "neutral"),
      el("span", null, `${KIND_LABEL[v.kind] || v.kind} · ${p.message || status}`),
      el("span", { class: "mono" }, v.id));
    const total = Number(p.total) || Number(v.total) || 0;
    const cur = Number(p.current) || 0;
    S.progressEl.replaceChildren(meter({
      value: total ? cur : 0, min: 0, max: total || 1, label: "Generations",
      kind: status === "error" ? "bad" : status === "cancelled" ? "warn" : status === "done" ? "ok" : "info",
      format: () => (total ? `${cur} / ${total}` : "—"),
    }));
  }

  function paintBest(best, svg) {
    const { el, stat, meter, button, molecule } = ui();
    if (!best || !best.smiles) return;
    const molSlot = el("div", { class: "evo-best-mol" });
    if (svg) molSlot.appendChild(molecule(svg));
    else if (S.depict.node) {
      // Keep the previous depiction (dimmed) until the throttled depiction of the new best arrives.
      S.depict.node.classList.toggle("is-stale", S.depict.shown !== best.smiles);
      molSlot.appendChild(S.depict.node);
    } else molSlot.appendChild(molecule(null));
    S.bestEl.replaceChildren(el("div", { class: "evo-best" }, molSlot,
      el("div", { class: "evo-best-info" },
        stat({ label: "Best fitness", value: fit3(best.fitness), hint: best.generation ? `found in generation ${best.generation}` : null, kind: fitKind(best.fitness) }),
        meter({ value: best.fitness, label: "Fitness", kind: fitKind(best.fitness), format: (x) => x.toFixed(3) }),
        el("div", { class: "evo-smiles", title: best.smiles }, best.smiles),
        best.unique ? el("div", { class: "evo-muted" }, `${best.unique} unique molecules in generation ${best.generation}`) : null,
        el("div", null, button("Open in Molecule Studio", { small: true, icon: "flask", onClick: () => S.ctx.navigate("molecule", { smiles: best.smiles }) })))));
    S.bestEl.dataset.smiles = best.smiles;
  }

  /** Depict the best-so-far SMILES, at most once every DEPICT_EVERY_MS. */
  function queueDepict(smiles, token) {
    const d = S.depict;
    d.pending = smiles;
    if (d.busy || smiles === d.shown) return;
    clearTimeout(d.timer);
    d.timer = setTimeout(() => runDepict(token), Math.max(0, d.last + DEPICT_EVERY_MS - Date.now()));
  }

  async function runDepict(token) {
    const d = S.depict;
    const smi = d.pending;
    if (!smi || smi === d.shown || token !== S.token) return;
    d.busy = true;
    d.last = Date.now();
    try {
      const r = S.svgCache.has(smi) ? { svg: S.svgCache.get(smi) } : await api().post("/api/molecule/depict", { smiles: smi, width: 320, height: 240 }, { quiet: true });
      S.svgCache.set(smi, r.svg);
      if (token !== S.token) return;
      d.shown = smi;
      d.node = ui().molecule(r.svg);
      const slot = S.bestEl.querySelector(".evo-best-mol");
      if (slot && S.bestEl.dataset.smiles === smi) slot.replaceChildren(d.node);
    } catch (err) {
      d.shown = smi; // invalid / undepictable: keep the placeholder
    } finally {
      d.busy = false;
      if (token === S.token && d.pending && d.pending !== d.shown) queueDepict(d.pending, token);
    }
  }

  function resetView(id, kind, total) {
    S.token += 1;
    if (S.poll && S.poll.cancelPolling) S.poll.cancelPolling();
    S.poll = null;
    clearTimeout(S.depict.timer);
    S.depict = { pending: null, shown: null, busy: false, last: 0, timer: 0, node: null };
    S.view = { id, kind, total: total || null, history: [], lastMsg: "", status: null, best: null };
    S.logEl.replaceChildren();
    S.bestEl.replaceChildren(ui().empty("Waiting for the first generation…"));
    delete S.bestEl.dataset.smiles;
    S.chart.update(chartSpec([], total));
    paintHistory();
    return S.token;
  }

  function ingestEvents(events, token) {
    const v = S.view;
    let newest = null;
    for (const e of events || []) {
      if (!e || typeof e.generation !== "number") continue;
      v.history.push(e);
      newest = e;
      log(`gen ${String(e.generation).padStart(3)}  best ${ui().fmt(e.best, 3)}  mean ${ui().fmt(e.mean, 3)}  worst ${ui().fmt(e.worst, 3)}  unique ${e.unique}`);
      if (!v.best || e.best > v.best.fitness) v.best = { smiles: e.best_smiles, fitness: e.best, generation: e.generation, unique: e.unique };
      else v.best.unique = e.unique;
    }
    if (newest) {
      S.chart.update(chartSpec(v.history, v.total));
      if (v.best && v.best.smiles) {
        paintBest(v.best);
        queueDepict(v.best.smiles, token);
      }
    }
  }

  function onUpdate(job, fresh, token) {
    if (token !== S.token) return;
    const v = S.view;
    if (job.progress && Number(job.progress.total)) v.total = Number(job.progress.total);
    const msg = job.progress && job.progress.message;
    // Generation, final and cancel messages are logged elsewhere.
    if (msg && msg !== v.lastMsg && !/^(generation \d+|finished|cancel|failed|running$|queued$)/.test(msg)) log(msg);
    if (msg) v.lastMsg = msg;
    if (job.status !== v.status) {
      if (job.status === "running" && v.status) log("running");
      v.status = job.status;
    }
    ingestEvents(fresh, token);
    paintStatus(job);
  }

  /** Follow a (possibly running) job in the live view. */
  function track(id, kind, opts = {}) {
    const token = resetView(id, kind, opts.generations);
    setRunning(true);
    if (S.autoNote) { log(S.autoNote); S.autoNote = null; }
    log(`${KIND_LABEL[kind] || kind} job ${id} submitted`);
    paintStatus({ status: "queued", progress: { current: 0, total: opts.generations || null, message: "queued" } });
    S.resultsEl.replaceChildren(ui().notice("The run is in progress. Results appear here when it finishes.", "info"));
    const poll = api().pollJob(id, { onUpdate: (job, fresh) => onUpdate(job, fresh, token), intervalMs: 500 });
    S.poll = poll;
    poll.then((job) => { if (token === S.token) finish(job, token, true); },
      (err) => {
        if (token !== S.token) return;
        setRunning(false);
        log(`lost track of the job: ${ui().errMessage(err)}`, "bad");
        S.resultsEl.replaceChildren(ui().errorBox(err));
      });
  }

  function finish(job, token, live) {
    setRunning(false);
    const v = S.view;
    v.status = job.status;
    paintStatus(job);
    if (job.status === "done") {
      if (live) {
        log(job.progress && job.progress.message ? job.progress.message : "finished", "ok");
        ECCL.bus.emit("notebook:changed", { source: "evolution", job: job.id });
        const best = job.kind === "campaign" ? job.result && job.result.evolution && job.result.evolution.best : job.result && job.result.best;
        ui().toast(`${KIND_LABEL[job.kind] || "Run"} finished${best ? ` · best fitness ${ui().fmt(best.fitness, 3)}` : ""}`, "ok");
      }
      renderResult(job);
    } else if (job.status === "cancelled") {
      if (live) log("cancelled", "warn");
      S.resultsEl.replaceChildren(ui().notice(`The run was cancelled after ${v.history.length} generation${v.history.length === 1 ? "" : "s"}. The chart keeps the generations that completed.`, "warn"));
    } else if (job.status === "error") {
      if (live) log(`failed: ${job.error || "unknown error"}`, "bad");
      S.resultsEl.replaceChildren(ui().errorBox({ message: job.error || "The job failed.", type: job.error_type }));
    }
    refreshJobs();
  }

  async function cancelRun() {
    const v = S.view;
    if (!v || !S.running) return;
    for (const b of S.cancelBtns) b.disabled = true;
    log("cancel requested; stops at the next generation", "warn");
    try {
      await api().cancelJob(v.id);
    } catch (err) {
      for (const b of S.cancelBtns) b.disabled = false;
      throw err;
    }
  }

  // ------------------------------------------------------------------ results

  function breakdownNode(breakdown, weights) {
    const { el, meter } = ui();
    const entries = Object.entries(breakdown || {});
    if (!entries.length) return null;
    return el("div", { class: "evo-breakdown" }, entries.map(([k, val]) => meter({
      value: val, label: `${TERM_LABEL[k] || k}${weights && weights[k] ? ` ×${ui().fmt(weights[k].weight, 3)}` : ""}`,
      kind: "neutral", format: (x) => x.toFixed(2),
    })));
  }

  function openButtons(smiles, tag) {
    const { el, button } = ui();
    return el("div", { class: "evo-card-actions" },
      button("Open in Molecule Studio", { small: true, icon: "flask", onClick: () => S.ctx.navigate("molecule", { smiles }) }),
      button(null, {
        small: true, kind: "ghost", icon: "book", title: "Save this molecule to the lab notebook",
        onClick: () => api().post("/api/notebook/molecule", { smiles, tags: [tag] }).then(() => {
          ECCL.bus.emit("notebook:changed", { source: "evolution" });
          ui().toast("Saved to the notebook", "ok", 2000);
        }),
      }));
  }

  function hofCard(ind, rank, weights, tag) {
    const { el, card, meter, badge } = ui();
    const slot = el("div", { class: "evo-mini-mol" });
    cachedDepiction(slot, ind.smiles, ind.svg);
    return card({ class: "evo-hof-card" },
      el("div", { class: "evo-card-head" },
        el("span", { class: "evo-rank" }, el("span", { class: "evo-rank-n" }, `#${rank}`), fit3(ind.fitness)),
        Number.isFinite(ind.generation) ? badge(`gen ${ind.generation}`, "neutral") : null),
      slot,
      el("div", { class: "evo-smiles", title: ind.smiles }, ind.smiles),
      meter({ value: ind.fitness, label: "Fitness", kind: fitKind(ind.fitness), format: (x) => x.toFixed(3) }),
      breakdownNode(ind.breakdown, weights),
      openButtons(ind.smiles, tag));
  }

  function statsRow(job, best, evaluations, history) {
    const { grid, stat } = ui();
    const total = (job.params && job.params.generations) || (job.progress && job.progress.total);
    const dur = job.finished && job.started ? job.finished - job.started : null;
    const stopped = total && history.length < total;
    const last = history[history.length - 1];
    const s = grid(4,
      stat({ label: "Best fitness", value: best ? fit3(best.fitness) : null, hint: best && best.generation ? `generation ${best.generation}` : null, kind: best ? fitKind(best.fitness) : null }),
      stat({ label: "Evaluations", value: evaluations, hint: "fitness calls (cached repeats excluded)" }),
      stat({ label: "Generations", value: history.length, unit: total ? `/ ${total}` : null, hint: stopped ? "stopped early (patience)" : "completed" }),
      stat({ label: "Run time", value: dur !== null ? Number(dur.toFixed(dur < 10 ? 2 : 1)) : null, unit: "s", hint: last ? `${last.unique} unique in last generation` : null }));
    s.classList.add("evo-stats");
    return s;
  }

  function renderResult(job) {
    const { el, section, card, grid, button, json, empty } = ui();
    const r = job.result || {};
    const isCampaign = job.kind === "campaign";
    const evo = isCampaign ? (r.evolution || {}) : r;
    const history = Array.isArray(evo.history) ? evo.history : [];
    const weights = job.params && job.params.objectives;
    const hof = Array.isArray(evo.hall_of_fame) ? evo.hall_of_fame : [];
    const reuse = button("Reuse settings", { small: true, kind: "ghost", icon: "refresh", onClick: () => applyParams(job.params, job.kind) });
    const nodes = [statsRow(job, evo.best, evo.evaluations, history)];

    if (isCampaign) {
      const winners = Array.isArray(r.winners) ? r.winners : [];
      nodes.push(card({ title: r.title || "Campaign winners", subtitle: `Top ${winners.length} molecules analysed: drug-likeness, simulated IR, critics gate`, icon: "sparkle", actions: reuse },
        winners.length ? withClass(grid(3, winners.map((w, i) => winnerCard(w, i + 1, weights))), "evo-winners") : empty("No winners were produced.")));
      nodes.push(grid(2, notesCard(r.notes), groundingCard(r.grounding, job.params && job.params.ground_query)));
      const rest = hof.slice(winners.length);
      if (rest.length) {
        nodes.push(card({ title: "Rest of the hall of fame", subtitle: "Other high scorers from the evolutionary stage", icon: "list" },
          el("div", { class: "evo-hof" }, grid(4, rest.map((ind, i) => hofCard({ smiles: ind.smiles, fitness: ind.fitness, generation: ind.generation, breakdown: ind.breakdown }, winners.length + i + 1, weights, "campaign"))))));
      }
    } else {
      nodes.push(card({ title: "Hall of fame", subtitle: `${hof.length} best unique molecules, best first. Breakdown bars are unweighted term scores (0–1).`, icon: "dna", actions: reuse },
        hof.length ? el("div", { class: "evo-hof" }, grid(3, hof.map((ind, i) => hofCard(ind, i + 1, weights, "evolution")))) : empty("The hall of fame is empty.")));
    }
    nodes.push(json(r, { title: "Raw result JSON" }));
    S.resultsEl.replaceChildren(section(`Results · ${KIND_LABEL[job.kind] || job.kind} ${job.id}`, nodes));
  }

  function winnerCard(w, rank, weights) {
    const { el, card, meter, badge, formula } = ui();
    const slot = el("div", { class: "evo-mini-mol" });
    cachedDepiction(slot, w.smiles, w.svg);
    const g = w.gate || null;
    const dl = w.drug_likeness || null;
    const groups = Array.isArray(w.ir_interpretation) ? w.ir_interpretation : [];
    const gateBadge = g ? badge(`gate ${g.accepted ? "accepted" : "rejected"} · ${ui().fmt(g.score, 2)}`, g.accepted ? "ok" : "bad") : badge("gate n/a", "neutral");
    if (g && Array.isArray(g.reasons)) gateBadge.title = g.reasons.join("; ");
    const facts = [];
    if (dl) facts.push(`${dl.rules_passed}/${(dl.rules || []).length} drug-likeness rules`, `QED-like ${ui().fmt(dl.qed_like, 2)}`, `SA ${ui().fmt(dl.sa_proxy, 3)}`);
    if (w.uvvis && Number.isFinite(w.uvvis.lambda_max_nm)) facts.push(`λmax ≈ ${ui().fmt(w.uvvis.lambda_max_nm, 3)} nm (Kuhn)`);
    return card({ class: "evo-hof-card" },
      el("div", { class: "evo-card-head" },
        el("span", { class: "evo-rank" }, el("span", { class: "evo-rank-n" }, `#${rank}`), fit3(w.fitness)),
        gateBadge),
      slot,
      el("div", { class: "evo-smiles", title: w.smiles }, w.smiles),
      w.formula ? el("div", { class: "evo-muted" }, formula(w.formula), w.molar_mass ? ` · ${ui().fmt(w.molar_mass, 4)} g/mol` : "") : null,
      meter({ value: w.fitness, label: "Fitness", kind: fitKind(w.fitness), format: (x) => x.toFixed(3) }),
      facts.length ? el("div", { class: "evo-muted" }, facts.join(" · ")) : null,
      groups.length ? el("div", null, el("div", { class: "evo-sublabel" }, "IR interpretation"),
        el("div", { class: "evo-badges", style: { marginTop: "4px" } }, groups.map((gname) => badge(gname, "info")))) : null,
      w.error ? ui().notice(w.error, "warn") : null,
      breakdownNode(w.objective_breakdown, weights),
      openButtons(w.smiles, "campaign"));
  }

  function notesCard(notes) {
    const { el, card, empty } = ui();
    const list = Array.isArray(notes) ? notes : [];
    return card({ title: "Campaign notes", icon: "info" },
      list.length ? el("ul", { class: "evo-notes" }, list.map((n) => el("li", null, String(n)))) : empty("No notes."));
  }

  function groundingCard(g, query) {
    const { el, card, badge, notice } = ui();
    if (!g) {
      return card({ title: "Grounding", icon: "search" },
        notice(query ? "No grounding report was returned." : "No grounding query was given, so the campaign went straight to evolution. Add a deep-search query to ground it in the literature.", "neutral"));
    }
    const used = Array.isArray(g.providers_used) ? g.providers_used : [];
    const failed = g.providers_failed && typeof g.providers_failed === "object" ? Object.entries(g.providers_failed) : [];
    const rows = [
      ...used.map((p) => el("div", { class: "evo-prov-row" }, badge(p, "ok"), el("span", { class: "evo-muted" }, "answered"))),
      ...failed.map(([p, reason]) => el("div", { class: "evo-prov-row" }, badge(p, "bad"),
        el("details", null, el("summary", { title: String(reason) }, String(reason)), el("p", null, String(reason))))),
    ];
    const results = Array.isArray(g.results) ? g.results : [];
    const allFailed = !used.length && failed.length;
    return card({ title: "Grounding", subtitle: `“${g.query || query || ""}” · ${results.length} result${results.length === 1 ? "" : "s"}`, icon: "search" },
      allFailed ? notice("Every search provider failed. Outbound HTTPS looks blocked or the machine is offline; grounding works when network access is allowed.", "warn") : null,
      rows.length ? el("div", { class: "evo-prov" }, rows) : null,
      el("div", { class: "evo-sublabel" }, `Synthesis · LLM ${(ECCL.info.llm && ECCL.info.llm.backend) || "unknown"}`),
      g.synthesis ? el("div", { class: "evo-synthesis" }, String(g.synthesis))
        : el("p", { class: "evo-muted" }, results.length ? "No synthesis was produced." : "No synthesis: there were no search results to ground it in."),
      results.length ? el("details", null, el("summary", null, `${results.length} source${results.length === 1 ? "" : "s"}`),
        el("ul", { class: "evo-notes" }, results.slice(0, 20).map((it) => el("li", null, `${it.title || "(untitled)"} — ${it.source || ""}`)))) : null);
  }

  // ------------------------------------------------------------------ job loading & history

  async function loadJob(id) {
    if (!id) return;
    if (S.view && S.view.id === id && (S.running || S.view.status === "done")) return;
    const seq = ++S.loadSeq;
    let job;
    try {
      job = await api().get(`/api/jobs/${encodeURIComponent(id)}`);
    } catch (err) {
      if (seq !== S.loadSeq) return;
      ui().toast(err.status === 404 ? `Job ${id} is no longer available (the server keeps the last 50).` : ui().errMessage(err), "bad");
      return;
    }
    if (seq !== S.loadSeq) return; // a newer load superseded this one
    if (!JOB_KINDS.has(job.kind)) {
      ui().toast(`Job ${id} is a ${job.kind} job; open it in its own panel.`, "warn");
      return;
    }
    const total = (job.params && job.params.generations) || (job.progress && job.progress.total);
    if (ACTIVE.has(job.status)) {
      setMode(job.kind);
      track(id, job.kind, { generations: total });
      return;
    }
    const token = resetView(id, job.kind, total);
    setRunning(false);
    log(`loaded ${KIND_LABEL[job.kind] || job.kind} job ${id} (${job.status}, started ${clockTime(job.started || job.created)})`);
    ingestEvents(job.events, token);
    const evo = job.kind === "campaign" ? job.result && job.result.evolution : job.result;
    if (evo && Array.isArray(evo.history) && !S.view.history.length) {
      S.view.history = evo.history.slice();
      S.chart.update(chartSpec(S.view.history, total));
    }
    if (evo && evo.best) {
      const svg = job.kind === "campaign"
        ? ((job.result.winners || []).find((w) => w.smiles === evo.best.smiles) || {}).svg
        : evo.best.svg;
      S.view.best = { smiles: evo.best.smiles, fitness: evo.best.fitness, generation: evo.best.generation };
      paintBest(S.view.best, svg || null);
      if (!svg) queueDepict(evo.best.smiles, token);
    }
    finish(job, token, false);
    paintHistory();
  }

  async function refreshJobs() {
    try {
      const r = await api().get("/api/jobs", { quiet: true });
      setJobs(Array.isArray(r.jobs) ? r.jobs : []);
    } catch (err) { /* the top-bar indicator reports server problems */ }
  }

  function setJobs(list) {
    S.jobs = (list || []).filter((j) => JOB_KINDS.has(j.kind));
    const sig = S.jobs.map((j) => `${j.id}:${j.status}:${j.progress && j.progress.current}`).join("|") + `|${S.view ? S.view.id : ""}`;
    if (sig === S.historySig) return;
    S.historySig = sig;
    paintHistory();
  }

  function paintHistory() {
    if (!S.historyEl) return;
    const { el, table, badge } = ui();
    S.historySig = S.jobs.map((j) => `${j.id}:${j.status}:${j.progress && j.progress.current}`).join("|") + `|${S.view ? S.view.id : ""}`;
    S.historyEl.replaceChildren(table({
      columns: [
        { key: "kind", label: "Kind", format: (v) => badge(KIND_LABEL[v] || v, v === "campaign" ? "info" : "neutral") },
        { key: "id", label: "Job", mono: true, format: (v) => el("span", null, v, S.view && S.view.id === v ? el("span", { class: "evo-viewing" }, badge("viewing", "info")) : null) },
        { key: "status", label: "Status", format: (v) => badge(v, STATUS_KIND[v] || "neutral") },
        { key: "created", label: "Started", format: (v, row) => clockTime(row.started || v), sortValue: (row) => row.created },
        { key: "progress", label: "Progress", sortable: false, format: (p) => (p && p.message) || "—" },
      ],
      rows: S.jobs,
      empty: "No evolution or campaign jobs yet.",
      maxHeight: 320,
      onRowClick: (row) => S.ctx.navigate("evolution", { job: row.id }),
    }));
  }

  // ------------------------------------------------------------------ panel

  async function initialLoad(params) {
    let jobs = [];
    try { jobs = (await api().get("/api/jobs", { quiet: true })).jobs || []; } catch (err) { jobs = []; }
    setJobs(jobs);
    if ((params && params.job) || S.view) return; // onShow loads the requested job / the user already started one
    const mine = jobs.filter((j) => JOB_KINDS.has(j.kind));
    const pick = mine.find((j) => ACTIVE.has(j.status)) || mine.find((j) => j.status === "done");
    if (pick) { await loadJob(pick.id); return; }
    S.autoNote = "no previous runs on this server, so a quick default evolution (30 molecules × 12 generations) was started";
    S.form.submit();
  }

  function render(root, ctx) {
    injectStyle();
    S.ctx = ctx;
    const { el, card, segmented, notice, section } = ui();

    S.seg = segmented({
      options: [{ value: "evolve", label: "Evolve", icon: "dna" }, { value: "campaign", label: "Campaign", icon: "sparkle" }],
      value: S.mode, ariaLabel: "Run mode", onChange: setMode,
    });
    S.modeHint = el("p", { class: "evo-modehint" });

    S.rows = OBJECTIVES.map(buildObjectiveRow);
    S.objSummary = el("p", { class: "evo-obj-summary", role: "status" });
    const objCard = card({ title: "Objectives", subtitle: "Tick a term to include it (its settings appear); the slider sets its weight (0–2).", icon: "spectrum" },
      el("div", { class: "evo-obj-list" }, S.rows.map((r) => r.row)), S.objSummary);

    const setupCard = card({ title: "Genetic algorithm", subtitle: "Small defaults finish in a few seconds.", icon: "dna" }, buildSetupForm());
    S.resultsEl = el("div", { class: "evo-results" });
    S.historyEl = el("div", { class: "evo-history" });

    ui().clear(root).append(...[
      el("p", { class: "evo-intro" },
        "Evolve new molecules with a genetic algorithm: SMILES are mutated and recombined, scored by a weighted blend of objectives, " +
        "and the critics gate vetoes implausible offspring. Campaign mode adds optional literature grounding and a full analysis of the winners."),
      ECCL.info.rdkit ? null : notice("RDKit is not installed on the server, so molecules cannot be parsed or scored: evolution runs will fail.", "warn"),
      el("div", { class: "evo-modebar" }, S.seg, S.modeHint),
      objCard,
      el("div", { class: "evo-top" }, setupCard, buildLiveCard()),
      S.resultsEl,
      section("Job history", card({ title: "Evolution & campaign jobs", subtitle: "Click a row to load its result (the server keeps the last 50 jobs).", icon: "clock" }, S.historyEl)),
    ].filter(Boolean));

    setMode(S.mode);
    updateObjSummary();
    paintHistory();
    S.resultsEl.replaceChildren(ui().empty("Results of the selected run appear here."));
    ctx.bus.on("jobs:list", setJobs);
    initialLoad(ctx.params).catch((err) => console.error("[ECCL] evolution: initial load failed", err));
  }

  ECCL.registerPanel({
    id: "evolution",
    title: "Evolution",
    group: "Discovery",
    icon: "dna",
    description: "Evolve new molecules with a multi-objective genetic algorithm and run discovery campaigns.",
    order: 90,
    render,
    onShow(params) {
      if (params && params.job) loadJob(params.job);
    },
  });
})(window.ECCL);
