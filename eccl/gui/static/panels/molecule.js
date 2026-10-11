/* Molecule studio - analyse a SMILES string: structure, descriptors, drug-likeness,
 * critics-gate verdict, simulated IR / UV-Vis, plus a fingerprint similarity tool.
 */
window.ECCL = window.ECCL || {};

(function (ECCL) {
  "use strict";

  const DEFAULT_SMILES = "CC(=O)Oc1ccccc1C(=O)O";
  const SEVERITY_KIND = { OK: "ok", NOTE: "info", CONCERN: "warn", MAJOR: "bad", FATAL: "bad" };
  const SEVERITY_NAMES = ["OK", "NOTE", "CONCERN", "MAJOR", "FATAL"];
  const DESCRIPTORS = {
    mol_weight: ["Molecular weight", "g/mol"],
    logp: ["cLogP", ""],
    tpsa: ["TPSA", "Å²"],
    h_donors: ["H-bond donors", ""],
    h_acceptors: ["H-bond acceptors", ""],
    rotatable_bonds: ["Rotatable bonds", ""],
    rings: ["Rings", ""],
    aromatic_rings: ["Aromatic rings", ""],
    heavy_atoms: ["Heavy atoms", ""],
    fraction_csp3: ["Fraction Csp³", ""],
    formal_charge: ["Formal charge", ""],
    num_heteroatoms: ["Heteroatoms", ""],
  };
  const TOP_ASSIGNMENTS = 8;

  const S = {
    ctx: null, form: null, results: null, charts: [], data: null, inflight: false, queued: null,
    pendingOpts: null, lastRequested: null, saved: new Map(), savedSlot: null,
    simForm: null, simOut: null, querySynced: true, simRan: false, presets: {}, presetBySmiles: new Map(),
  };

  // ------------------------------------------------------------------ helpers

  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

  function presetName(...smiles) {
    for (const s of smiles) if (s && S.presetBySmiles.has(s)) return S.presetBySmiles.get(s);
    return null;
  }

  function fallbackCopy(text) {
    const ta = ECCL.ui.el("textarea", { style: { position: "fixed", top: "-1000px", opacity: 0 }, "aria-hidden": "true" });
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch (err) { ok = false; }
    ta.remove();
    return ok;
  }

  function copyText(text, what) {
    const ui = ECCL.ui;
    const done = (ok) => ui.toast(ok ? `${what} copied to the clipboard` : `Could not copy the ${what}`, ok ? "ok" : "warn", 2200);
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      return navigator.clipboard.writeText(text).then(() => done(true), () => done(fallbackCopy(text)));
    }
    done(fallbackCopy(text));
    return undefined;
  }

  function copyable(text, what, mono = true) {
    const ui = ECCL.ui;
    if (!text) return "—";
    return ui.el("span", { class: "mol-copy" },
      ui.el("span", { class: mono ? "mono" : null }, text),
      ui.button(null, { kind: "ghost", small: true, icon: "copy", title: `Copy ${what}`, onClick: () => copyText(text, what) }));
  }

  /** Compact stat grid (tiles down to 128 px wide; few tiles stretch). */
  function mini(...tiles) {
    return ECCL.ui.grid(4, { min: 128, fit: true }, ...tiles);
  }

  /** One-row percentage meter for table cells. */
  function confMeter(v, format) {
    return ECCL.ui.meter({ value: v, min: 0, max: 1, compact: true, label: "confidence", format });
  }

  function destroyCharts() {
    for (const c of S.charts) { try { c.destroy(); } catch (err) { /* already gone */ } }
    S.charts = [];
  }

  // ------------------------------------------------------------------ analysis flow

  function requestAnalysis(smiles, opts = {}) {
    if (!S.form) return;
    if (S.inflight) { S.queued = [smiles, opts]; return; }
    S.form.setValues({ smiles });
    syncPreset(smiles);
    S.pendingOpts = opts;
    S.form.submit();
  }

  function syncPreset(smiles) {
    const f = S.form && S.form.field("preset");
    if (f) f.setValue(presetName(String(smiles || "").trim()) || "");
  }

  async function analyze(values) {
    const ui = ECCL.ui;
    const opts = S.pendingOpts || {};
    S.pendingOpts = null;
    const smiles = values.smiles;
    const harshness = values.harshness;
    const known = S.saved.get(smiles) || (opts.record ? { id: opts.record, fromNotebook: true } : null);
    const register = opts.register !== false && !known;
    S.lastRequested = smiles;
    S.inflight = true;
    S.results.classList.add("is-stale");
    S.results.setAttribute("aria-busy", "true");
    try {
      const data = await ECCL.api.post("/api/molecule/analyze", { smiles, harshness, register });
      let saved = known;
      if (data.record_id) {
        saved = { id: data.record_id, fresh: true };
        ECCL.bus.emit("notebook:changed", { id: data.record_id, kind: "molecule" });
      }
      const canonical = data.canonical_smiles || data.smiles;
      if (saved) { S.saved.set(smiles, saved); if (canonical) S.saved.set(canonical, saved); }
      data._input = data.input_smiles || smiles;
      data._canonical = canonical || null;
      S.data = data;
      renderResults(data, saved, harshness);
      syncSimilarity(canonical || smiles);
      return data;
    } catch (err) {
      if (!S.data) S.results.replaceChildren(ui.card(ui.empty("No analysis yet. Fix the SMILES above and press Analyze.")));
      throw err;
    } finally {
      S.inflight = false;
      S.results.classList.remove("is-stale");
      S.results.removeAttribute("aria-busy");
      if (S.queued) { const q = S.queued; S.queued = null; setTimeout(() => requestAnalysis(q[0], q[1]), 0); }
    }
  }

  async function saveToNotebook() {
    const d = S.data;
    if (!d) return;
    const r = await ECCL.api.post("/api/notebook/molecule", {
      smiles: d._canonical || d._input, name: presetName(d._input, d._canonical), tags: ["analyzed"],
    });
    const saved = { id: r.id, fresh: true };
    S.saved.set(d._input, saved);
    if (d._canonical) S.saved.set(d._canonical, saved);
    paintSaved(saved);
    ECCL.bus.emit("notebook:changed", { id: r.id, kind: "molecule" });
    ECCL.ui.toast(`Saved to notebook as ${r.id}`, "ok", 2500);
  }

  function paintSaved(saved) {
    const ui = ECCL.ui;
    if (!S.savedSlot) return;
    const open = ui.button("Open notebook", { kind: "ghost", small: true, icon: "book", onClick: () => S.ctx.navigate("notebook") });
    if (saved) {
      S.savedSlot.replaceChildren(ui.icon("check"),
        ui.el("span", null, saved.fromNotebook ? "From notebook record " : saved.fresh ? "Saved to notebook as " : "Already in the notebook as "),
        ui.el("code", null, saved.id), open);
    } else {
      S.savedSlot.replaceChildren(ui.icon("info"), ui.el("span", null, "Preview only: not saved to the notebook."),
        ui.button("Save to notebook", { kind: "secondary", small: true, icon: "plus", onClick: saveToNotebook }));
    }
  }

  // ------------------------------------------------------------------ result cards

  function structureCard(d, saved) {
    const ui = ECCL.ui;
    const name = presetName(d._input, d._canonical);
    S.savedSlot = ui.el("div", { class: "mol-saved", role: "status" });
    paintSaved(saved);
    const pairs = [
      ["Canonical SMILES", d._canonical ? copyable(d._canonical, "SMILES") : ui.el("span", { class: "muted" }, "needs RDKit")],
      d._input && d._input !== d._canonical ? ["Input SMILES", ui.el("span", { class: "mono" }, d._input)] : null,
      ["Formula", d.formula ? ui.formula(d.formula) : "—"],
      ["Molar mass", num(d.molar_mass) !== null ? `${ui.fmt(d.molar_mass, 6)} g/mol` : "—"],
      ["InChIKey", copyable(d.inchi_key, "InChIKey")],
    ].filter(Boolean);
    return ui.card({ title: "Structure", icon: "flask", subtitle: name ? `Preset: ${name}` : "2-D depiction (RDKit)", class: "mol-structure" },
      ui.molecule(d.svg, { caption: name || d._canonical || d._input, width: 460 }),
      (() => { const k = ui.kv(pairs); k.classList.add("mol-ident"); return k; })(),
      S.savedSlot);
  }

  function propertiesCard(d) {
    const ui = ECCL.ui;
    const dl = d.drug_likeness;
    const ds = d.descriptors || (dl && dl.descriptors);
    if (!dl || !ds) {
      return ui.card({ title: "Properties" }, ui.notice("RDKit is not available, so descriptors and drug-likeness rules cannot be computed.", "warn"));
    }
    const qed = num(dl.qed_like), sa = num(dl.sa_proxy);
    const qedKind = qed === null ? "neutral" : qed >= 0.6 ? "ok" : qed >= 0.4 ? "warn" : "bad";
    const saKind = sa === null ? undefined : sa <= 4 ? "ok" : sa <= 6 ? "warn" : "bad";
    const qedStat = ui.stat({ label: "QED-like", value: qed, hint: "0 = poor · 1 = ideal", kind: qed === null ? undefined : qedKind });
    qedStat.classList.add("mol-meter-stat");
    qedStat.appendChild(ui.meter({ value: qed, min: 0, max: 1, label: "QED-like drug-likeness", kind: qedKind }));
    const rules = Array.isArray(dl.rules) ? dl.rules : [];
    const passed = typeof dl.rules_passed === "number" ? dl.rules_passed : rules.filter((r) => r.passed).length;
    const alerts = Array.isArray(dl.alerts) ? dl.alerts : [];
    const stats = ui.grid(4, { min: 128 },
        ui.stat({ label: "Mol. weight", value: num(ds.mol_weight), unit: "g/mol" }),
        ui.stat({ label: "cLogP", value: num(ds.logp), hint: "octanol / water" }),
        ui.stat({ label: "TPSA", value: num(ds.tpsa), unit: "Å²" }),
        ui.stat({ label: "HBD / HBA", value: `${ui.fmt(ds.h_donors)} / ${ui.fmt(ds.h_acceptors)}`, hint: "H-bond donors / acceptors" }),
        qedStat,
        ui.stat({ label: "SA proxy", value: sa, hint: "1 easy · 10 hard to make", kind: saKind }));
    return ui.card({ title: "Properties & drug-likeness", icon: "list", subtitle: "Key descriptors and the classic oral-drug filters." },
      stats,
      ui.el("div", { class: "mol-verdict" },
        ui.el("span", { class: "label-caps" }, "Rules"),
        ui.badge(`${passed} / ${rules.length} passed`, passed === rules.length ? "ok" : passed * 2 >= rules.length ? "warn" : "bad")),
      ui.table({
        columns: [
          { key: "name", label: "Rule" },
          { key: "passed", label: "Result", format: (v) => ui.badge(v ? "Pass" : "Fail", v ? "ok" : "bad") },
          { key: "violations", label: "Violations", format: (v) => (Array.isArray(v) && v.length ? v.join("; ") : "—") },
        ],
        rows: rules, sortable: false, empty: "No rules evaluated",
      }),
      ui.el("div", { class: "mol-verdict" }, ui.el("span", { class: "label-caps" }, "Structural alerts"),
        alerts.length ? alerts.map((a) => ui.badge(String(a).replace(/_/g, " "), "bad")) : ui.badge("None fired", "ok")));
  }

  function gateCard(g) {
    const ui = ECCL.ui;
    if (!g) return ui.card({ title: "Critics gate" }, ui.empty("No gate verdict returned."));
    const score = num(g.score);
    const worst = SEVERITY_NAMES[g.worst_severity] || String(g.worst_severity ?? "—");
    const crit = Array.isArray(g.critiques) ? g.critiques : [];
    return ui.card({ title: "Critics gate", icon: "shield", subtitle: "Independent critics review the structure; harshness sets how much they tolerate." },
      ui.el("div", { class: "mol-verdict" },
        (() => { const b = ui.badge(g.accepted ? "Accepted" : "Rejected", g.accepted ? "ok" : "bad"); b.classList.add("mol-big"); return b; })(),
        ui.badge(`harshness ${g.harshness || "?"}`, "neutral"),
        ui.badge(`worst: ${worst}`, SEVERITY_KIND[worst] || "neutral")),
      ui.meter({ value: score, min: 0, max: 1, label: "Gate score", kind: score === null ? "neutral" : score >= 0.8 ? "ok" : score >= 0.5 ? "warn" : "bad" }),
      Array.isArray(g.reasons) && g.reasons.length ? ui.el("ul", { class: "mol-reasons" }, g.reasons.map((r) => ui.el("li", null, r))) : null,
      ui.table({
        columns: [
          { key: "critic", label: "Critic" },
          { key: "severity_name", label: "Severity", format: (v, r) => ui.badge(v || SEVERITY_NAMES[r.severity] || "?", SEVERITY_KIND[v] || "neutral"), sortValue: (r) => r.severity },
          { key: "message", label: "Finding" },
        ],
        rows: crit, empty: "No critiques",
      }),
      g.llm_note ? ui.notice(`LLM critic: ${g.llm_note}`, "info") : null);
  }

  function uvCard(uv) {
    const ui = ECCL.ui;
    const card = (...kids) => ui.card({ title: "UV-Vis estimate", icon: "sun", subtitle: "Longest-wavelength absorption from the conjugation length (free-electron model)." }, ...kids);
    if (!uv) return card(ui.empty("No UV-Vis estimate (RDKit unavailable)."));
    const lam = num(uv.lambda_max_nm);
    const region = lam === null ? "" : lam < 380 ? "ultraviolet" : lam <= 780 ? "visible" : "near-infrared";
    // The Kuhn box model is only meaningful for linear polyenes; elsewhere the server flags it
    // (model_applicable: false) and we show the number without a colour that would vouch for it.
    const trusted = uv.model_applicable !== false;
    const head = lam === null
      ? ui.notice(uv.note || "No conjugated system: absorbs in the deep UV.", "info")
      : ui.el("div", { class: "mol-uv" },
        trusted ? ui.el("div", { class: "mol-swatch", style: { background: ui.wavelengthToColor(lam) }, title: `${ui.fmt(lam)} nm`, role: "img", "aria-label": `Colour swatch for ${ui.fmt(lam)} nm (${region})` }) : null,
        ui.el("div", null,
          ui.el("div", { class: "mol-uv-label" }, "λ", ui.el("sub", null, "max"), trusted ? null : " (Kuhn model)"),
          ui.el("div", { class: "mol-uv-value" }, ui.fmt(lam, 4), ui.el("small", null, "nm")),
          trusted
            ? ui.el("div", { class: "muted" }, lam > 780 || lam < 380 ? `${region}: swatch shown in grey (outside 380–780 nm)` : `${region}: swatch shows the absorbed colour`)
            : ui.el("div", { class: "badges" }, ui.badge("qualitative · overestimates here", "warn"))));
    return card(head,
      !trusted && lam !== null && uv.caveat ? ui.notice(uv.caveat, "warn") : null,
      mini(
        ui.stat({ label: "Conjugated bonds", value: num(uv.conjugated_bonds) }),
        ui.stat({ label: "π electrons", value: num(uv.pi_electrons) }),
        num(uv.conjugated_systems) !== null ? ui.stat({ label: "Conjugated systems", value: num(uv.conjugated_systems) }) : null),
      lam !== null && uv.note ? ui.el("p", { class: "muted" }, `Note: ${uv.note}.`) : null);
  }

  function descriptorsCard(ds) {
    const ui = ECCL.ui;
    if (!ds) return ui.card({ title: "All descriptors" }, ui.empty("No descriptors (RDKit unavailable)."));
    const pairs = Object.entries(ds).map(([k, v]) => {
      const [label, unit] = DESCRIPTORS[k] || [k.replace(/_/g, " "), ""];
      return [label, typeof v === "number" ? `${ui.fmt(v, 4)}${unit ? ` ${unit}` : ""}` : v];
    });
    return ui.card({ title: "All descriptors", icon: "table", subtitle: "RDKit descriptor panel." }, ui.kv(pairs));
  }

  function irCard(d) {
    const ui = ECCL.ui;
    const ir = d.ir;
    const card = (...kids) => ui.card({ title: "Simulated IR spectrum", icon: "spectrum", subtitle: "Group-frequency simulation from the structure; peaks are interpreted against the IR band table." }, ...kids);
    if (!ir || !Array.isArray(ir.x)) return { node: card(ui.empty("No IR simulation (RDKit unavailable).")), mount: null };
    const chartEl = ui.el("div", { class: "mol-ir-chart" });
    const interp = d.ir_interpretation || {};
    const groups = Array.isArray(interp.functional_groups) ? interp.functional_groups : [];
    const assignments = (Array.isArray(interp.assignments) ? interp.assignments : []).slice()
      .sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
    const top = assignments.slice(0, TOP_ASSIGNMENTS);
    const peaks = (Array.isArray(ir.peaks) ? ir.peaks : []).filter((p) => Number.isFinite(Number(p)));
    const excluded = (interp.structure_filter && Array.isArray(interp.structure_filter.excluded)) ? interp.structure_filter.excluded : [];
    const exclNames = Array.from(new Set(excluded.map((e) => `${e.assignment} (no ${(e.missing_elements || []).join("/")})`)));
    const node = card(chartEl,
      ui.grid(2,
        ui.el("div", { class: "section" },
          ui.el("div", { class: "label-caps" }, "Functional groups suggested"),
          groups.length ? ui.el("div", { class: "badges" }, groups.map((g) => ui.badge(g, "info"))) : ui.el("p", { class: "muted" }, "No groups assigned."),
          peaks.length ? ui.el("p", { class: "muted" }, `Simulated peaks (cm⁻¹): ${peaks.join(", ")}.`) : null,
          excluded.length ? ui.el("p", { class: "muted" }, `Ruled out by composition: ${exclNames.slice(0, 4).join(", ")}${exclNames.length > 4 ? ", …" : ""}.`) : null,
          ui.el("p", { class: "muted" }, "Band windows overlap, so one peak can support several groups; read the list as candidates, not a verdict.")),
        ui.el("div", { class: "section" },
          ui.el("div", { class: "label-caps" }, `Top assignments (${top.length} of ${assignments.length})`, ui.el("span", { class: "mol-unit" }, " · peaks in cm⁻¹")),
          ui.table({
            columns: [
              { key: "peak", label: "Peak", align: "right" },
              { key: "assignment", label: "Assignment / group", format: (v, r) => ui.el("span", { class: "mol-two" }, ui.el("span", null, v || "—"), r.group ? ui.el("small", null, r.group) : null) },
              { key: "confidence", label: "Confidence", width: 130, format: (v) => confMeter(v, (x) => `${Math.round(x * 100)}%`) },
            ],
            rows: top, empty: "No assignments", maxHeight: 340, sortable: false,
          }))));
    const mount = () => ECCL.plot.lineChart(chartEl, {
      series: [{ name: "Absorbance", x: ir.x, y: ir.y, area: true }],
      xLabel: "Wavenumber (cm⁻¹)",
      yLabel: "Absorbance (normalised)",
      xReverse: true,
      xDomain: [400, 4000],
      yDomain: [0, 1.15],
      markers: peaks.map((p) => ({ x: Number(p), label: String(p) })),
      height: 290,
    });
    return { node, mount };
  }

  function renderResults(d, saved) {
    const ui = ECCL.ui;
    destroyCharts();
    const ir = irCard(d);
    S.results.replaceChildren(
      ui.grid(2, structureCard(d, saved), propertiesCard(d)),
      ui.grid(2, gateCard(d.gate), ui.el("div", { class: "stack" }, uvCard(d.uvvis), descriptorsCard(d.descriptors))),
      ir.node,
      ui.json(d, { title: "Raw analysis JSON" }));
    if (ir.mount) S.charts.push(ir.mount());
  }

  // ------------------------------------------------------------------ similarity tool

  function parseLibrary(text) {
    const out = [];
    for (const raw of String(text || "").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const m = /^(\S+)(?:\s+(.+))?$/.exec(line);
      out.push({ smiles: m[1], name: m[2] ? m[2].trim() : presetName(m[1]) });
    }
    return out;
  }

  async function runSimilarity(values) {
    const ui = ECCL.ui;
    const lib = parseLibrary(values.library);
    if (!lib.length) throw new Error("Add at least one library SMILES (one per line).");
    S.simOut.classList.add("is-stale");
    try {
      const r = await ECCL.api.post("/api/molecule/similarity", { query: values.query, library: lib.map((x) => x.smiles) });
      const nameOf = new Map(lib.map((x) => [x.smiles, x.name]));
      const rows = (Array.isArray(r.results) ? r.results : []).map((x, i) => ({ rank: i + 1, name: nameOf.get(x.smiles) || null, ...x }));
      const best = rows[0];
      const invalid = Array.isArray(r.invalid) ? r.invalid : [];
      S.simOut.replaceChildren(...[
        mini(
          ui.stat({ label: "Closest match", value: best ? ui.fmt(best.tanimoto, 3) : "—", hint: best ? (best.name || best.smiles) : "no valid library entries" }),
          ui.stat({ label: "Library diversity", value: num(r.diversity), hint: "mean pairwise 1 − Tanimoto" }),
          ui.stat({ label: "Compared", value: rows.length, unit: rows.length === 1 ? "molecule" : "molecules", hint: invalid.length ? `${invalid.length} invalid skipped` : "all entries parsed" })),
        invalid.length ? ui.notice(`Skipped ${invalid.length} invalid SMILES: ${invalid.join(", ")}`, "warn") : null,
        ui.table({
          columns: [
            { key: "rank", label: "#", width: 36 },
            { key: "smiles", label: "Molecule", mono: false, sortValue: (r) => r.name || r.smiles,
              format: (v, r) => ui.el("span", { class: "mol-two" }, ui.el("span", null, r.name || "unnamed"), ui.el("span", { class: "mono" }, v)) },
            { key: "tanimoto", label: "Tanimoto", width: 140, format: (v) => confMeter(v, (x) => x.toFixed(3)) },
          ],
          rows, empty: "No valid library molecules", maxHeight: 360,
          onRowClick: (row) => { requestAnalysis(row.smiles, { register: true }); window.scrollTo({ top: 0, behavior: "smooth" }); },
        }),
        ui.el("p", { class: "muted" }, `Query (canonical): ${r.query || values.query}. Click a row to analyse that molecule.`),
      ].filter(Boolean));
      S.simRan = true;
      return r;
    } finally {
      S.simOut.classList.remove("is-stale");
    }
  }

  function syncSimilarity(smiles) {
    if (!S.simForm || !S.querySynced) return;
    if (ECCL.info && ECCL.info.rdkit === false) return; // fingerprints need RDKit; don't auto-run into an error
    S.simForm.setValues({ query: smiles });
    S.simForm.submit();
  }

  function similarityCard() {
    const ui = ECCL.ui;
    const libText = Object.entries(S.presets).map(([name, smi]) => `${smi} ${name}`).join("\n");
    S.simOut = ui.el("div", { class: "mol-results dimmable" }, ECCL.info && ECCL.info.rdkit === false
      ? ui.notice("Similarity search needs RDKit (Morgan fingerprints), which is not installed on the server.", "warn")
      : ui.empty("Results appear here: library molecules ranked by Tanimoto similarity to the query."));
    S.simForm = ui.form({
      fields: [
        { name: "query", label: "Query SMILES", type: "text", mono: true, required: true, placeholder: "defaults to the analysed molecule",
          onChange: () => { S.querySynced = false; } },
        { name: "library", label: "Library", type: "textarea", mono: true, rows: 8, required: true, value: libText,
          help: "One SMILES per line; text after the SMILES (separated by a space) is used as a name. Lines starting with # are ignored." },
      ],
      columns: 1,
      submitLabel: "Compare",
      submitIcon: "search",
      onSubmit: runSimilarity,
      actions: [ui.button("Use current molecule", {
        kind: "ghost", icon: "refresh", onClick: () => {
          S.querySynced = true;
          const cur = S.data ? (S.data._canonical || S.data._input) : DEFAULT_SMILES;
          S.simForm.setValues({ query: cur });
          return S.simForm.submit();
        },
      })],
    });
    return ui.card({ class: "mol-sim", title: "Similarity search", icon: "search", subtitle: "Morgan fingerprints (radius 2, 2048 bits): Tanimoto similarity of the query to each library molecule, plus the library's diversity." },
      ui.grid(2, S.simForm, S.simOut));
  }

  // ------------------------------------------------------------------ panel

  ECCL.registerPanel({
    id: "molecule",
    title: "Molecule",
    group: "Chemistry",
    icon: "flask",
    description: "Analyse a molecule from SMILES: structure, descriptors, drug-likeness, critics verdict and simulated IR / UV-Vis.",
    order: 10,
    render(root, ctx) {
      const ui = ECCL.ui;
      S.ctx = ctx;
      const info = ctx.info || ECCL.info || {};
      S.presets = (info.presets && info.presets.molecules) || {};
      S.presetBySmiles = new Map(Object.entries(S.presets).map(([k, v]) => [v, k]));
      const harshList = (info.libraries && info.libraries.harshness) || ["LENIENT", "NORMAL", "HARSH", "BRUTAL"];
      const defHarsh = String((info.config && info.config.harshness) || "HARSH").toUpperCase();

      S.form = ui.form({
        fields: [
          { name: "smiles", label: "SMILES", type: "text", mono: true, required: true, value: DEFAULT_SMILES,
            placeholder: "e.g. CC(=O)Oc1ccccc1C(=O)O", onChange: (v) => syncPreset(v) },
          { name: "preset", label: "Preset", type: "select",
            options: [{ value: "", label: "Custom…" }].concat(Object.keys(S.presets).map((k) => ({ value: k, label: k }))),
            onChange: (v) => { if (v && S.presets[v]) requestAnalysis(S.presets[v], { register: true }); } },
          { name: "harshness", label: "Critics harshness", type: "select",
            options: harshList.map((h) => ({ value: h, label: h === defHarsh ? `${h} (default)` : h })), value: harshList.includes(defHarsh) ? defHarsh : harshList[0],
            onChange: () => { if (S.data) requestAnalysis(S.form.getValues().smiles || S.data._input, { register: false }); } },
        ],
        columns: 4,
        submitLabel: "Analyze",
        submitIcon: "flask",
        onSubmit: analyze,
      });
      syncPreset(DEFAULT_SMILES);

      S.results = ui.el("div", { class: "mol-results dimmable", "aria-live": "polite" },
        ui.card(ui.el("div", { class: "inline-loading" }, ui.spinner("Analysing"), ui.el("span", null, "Analysing molecule…"))));

      root.append(
        ui.card({ class: "mol-input", title: "Molecule input", icon: "flask" },
          ui.el("p", { class: "panel-intro" },
            "Enter a SMILES string (or pick a preset) to get its structure, descriptors, drug-likeness rules, the critics-gate verdict and simulated spectra. ",
            "Analyses you run with Analyze are saved to the lab notebook; molecules opened from a link are previews until you save them."),
          S.form),
        S.results,
        similarityCard());

      const p = ctx.params || {};
      if (!p.smiles) {
        // Default view: aspirin as a preview (not saved, so opening the GUI does not fill the notebook).
        requestAnalysis(DEFAULT_SMILES, { register: false });
      }
    },
    onShow(params) {
      const smi = params && typeof params.smiles === "string" ? params.smiles.trim() : "";
      if (smi && smi !== S.lastRequested) {
        // A SMILES from the URL (any page can link here) is analysed as a preview: nothing is
        // written to the notebook until the user presses "Save to notebook".
        requestAnalysis(smi, { register: false, record: params.record || null });
      }
    },
  });
})(window.ECCL);
