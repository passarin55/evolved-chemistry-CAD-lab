/* Spectroscopy panel - interpret IR / Raman / 1H / 13C peak lists against the
 * reference band tables, explain EI mass spectra as neutral losses,
 * cross-validate several modalities, simulate an IR spectrum from SMILES and
 * browse the reference library.
 */
window.ECCL = window.ECCL || {};

(function (ECCL) {
  "use strict";

  const MOD = {
    IR: { label: "IR", unit: "cm⁻¹", tol: 5, range: [400, 4000], reverse: true, axis: "Wavenumber (cm⁻¹)" },
    raman: { label: "Raman", unit: "cm⁻¹", tol: 5, range: [100, 3200], reverse: false, axis: "Raman shift (cm⁻¹)" },
    "1H": { label: "¹H NMR", unit: "ppm", tol: 0.3, range: [0, 13], reverse: true, axis: "Chemical shift δ (ppm)" },
    "13C": { label: "¹³C NMR", unit: "ppm", tol: 0.3, range: [0, 220], reverse: true, axis: "Chemical shift δ (ppm)" },
  };
  const MAX_PEAKS = 500;
  const MAX_CROSS_ROWS = 3;
  const DEFAULT_SIM_SMILES = "CC(=O)Oc1ccccc1C(=O)O";
  const MS_EXAMPLE = { ion: 122, fragments: [105, 94, 77, 51], label: "benzoic acid, C7H6O2" };
  const CROSS_EXAMPLE = [
    { modality: "IR", peaks: [3050, 1690, 1600, 1290, 710] },
    { modality: "1H", peaks: [12.5, 8.1, 7.5] },
    { modality: "13C", peaks: [172, 133, 130, 128] },
  ];
  const FALLBACK_PRESETS = [{ name: "Carboxylic acid (IR)", modality: "IR", peaks: [3000, 1715, 1280, 940] }];
  const TAB_IDS = ["interpret", "ms", "cross", "simulate", "library"];

  // Panel-local styles, scoped to #panel-spectroscopy.
  const CSS = `
#panel-spectroscopy .sp-intro { color: var(--text-2); max-width: 92ch; }
#panel-spectroscopy .sp-stack { display: flex; flex-direction: column; gap: var(--gap); min-width: 0; }
#panel-spectroscopy .sp-stack > * + * { margin-top: 0; }
#panel-spectroscopy .sp-results { transition: opacity 0.15s ease; }
#panel-spectroscopy .sp-results.is-stale { opacity: 0.55; }
#panel-spectroscopy .sp-loading { display: flex; align-items: center; gap: 10px; color: var(--text-2); }
#panel-spectroscopy .sp-presets { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
#panel-spectroscopy .sp-presets-label { font-size: 12.5px; font-weight: 500; color: var(--text-2); margin-right: 4px; }
#panel-spectroscopy .sp-badges { display: flex; flex-wrap: wrap; gap: 6px; }
#panel-spectroscopy .sp-badges > * + * { margin-top: 0; }
#panel-spectroscopy .sp-muted { font-size: 12.5px; color: var(--text-3); }
#panel-spectroscopy .sp-legend { display: flex; flex-wrap: wrap; gap: 6px 16px; font-size: 12px; color: var(--text-2); }
#panel-spectroscopy .sp-key { display: inline-flex; align-items: center; gap: 6px; }
#panel-spectroscopy .sp-swatch { width: 12px; height: 12px; border-radius: 3px; flex: none; }
#panel-spectroscopy .sp-swatch-line { width: 3px; height: 13px; border-radius: 2px; }
#panel-spectroscopy .sp-swatch-c1 { background: var(--chart-1); }
#panel-spectroscopy .sp-swatch-c2 { background: var(--chart-2); }
#panel-spectroscopy .sp-swatch-muted { background: var(--chart-marker); }
#panel-spectroscopy .sp-swatch-band { background: var(--chart-band); opacity: 0.25; border: 1px solid var(--chart-band); }
#panel-spectroscopy .sp-assign { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; min-width: 0; }
#panel-spectroscopy .sp-assign small { flex-basis: 100%; font-size: 12px; color: var(--text-3); }
#panel-spectroscopy .sp-conf { min-width: 110px; }
#panel-spectroscopy .sp-conf .meter-head { margin-bottom: 3px; justify-content: flex-end; }
#panel-spectroscopy .table td { vertical-align: middle; }
#panel-spectroscopy .grid.sp-stats { --grid-min: 140px; }
#panel-spectroscopy .sp-mod-field .segmented { align-self: flex-start; }
#panel-spectroscopy .sp-cross-rows { display: flex; flex-direction: column; gap: 12px; }
#panel-spectroscopy .sp-cross-row {
  display: grid; grid-template-columns: minmax(130px, 170px) minmax(0, 1fr) auto; gap: 10px; align-items: start;
  padding: 10px 12px; border: 1px solid var(--border-subtle); border-radius: var(--radius-md); background: var(--surface-2);
}
#panel-spectroscopy .sp-cross-row .sp-row-remove { margin-top: 22px; }
#panel-spectroscopy .sp-cross-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: var(--space-4); }
#panel-spectroscopy .sp-lib-controls { display: grid; grid-template-columns: minmax(160px, 240px) minmax(0, 1fr) auto; gap: 12px; align-items: end; }
#panel-spectroscopy .sp-lib-count { font-size: 12.5px; color: var(--text-3); padding-bottom: 8px; white-space: nowrap; }
#panel-spectroscopy .sp-bar-wrap { max-width: 560px; }
#panel-spectroscopy .sp-sub { font-size: 12px; font-weight: 650; letter-spacing: 0.06em; text-transform: uppercase; color: var(--text-3); }
#panel-spectroscopy .sp-actions { display: flex; flex-wrap: wrap; gap: 8px; }
#panel-spectroscopy .sp-actions > * + * { margin-top: 0; }
@media (max-width: 640px) {
  #panel-spectroscopy .sp-cross-row { grid-template-columns: minmax(0, 1fr) auto; }
  #panel-spectroscopy .sp-cross-row > .field-text { grid-column: 1 / -1; grid-row: 2; }
  #panel-spectroscopy .sp-lib-controls { grid-template-columns: minmax(0, 1fr); }
  #panel-spectroscopy .sp-lib-count { padding-bottom: 0; }
  #panel-spectroscopy .table th, #panel-spectroscopy .table td { padding-left: 8px; padding-right: 8px; }
}
`;

  function injectStyle() {
    if (document.getElementById("eccl-css-spectroscopy")) return;
    const st = document.createElement("style");
    st.id = "eccl-css-spectroscopy";
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  const S = {
    ctx: null, tabs: null, mods: Object.keys(MOD), charts: {},
    interp: { modality: "IR" }, ms: {}, cross: {}, sim: { pendingSmiles: null }, lib: { data: null, modality: "IR", filter: "" },
  };

  // ------------------------------------------------------------------ helpers

  /** Replace a node's children; null / false entries are skipped and arrays flattened (unlike replaceChildren). */
  function fill(node, ...kids) {
    node.replaceChildren(...kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false));
    return node;
  }

  const fmt = (v, d) => ECCL.ui.fmt(v, d);
  const pct = (v) => `${Math.round(v * 100)}%`;
  const modInfo = (m) => MOD[m] || MOD.IR;

  /** Split a peak list on commas, semicolons, spaces or new lines. */
  function parsePeaks(text) {
    const parts = String(text == null ? "" : text).split(/[\s,;]+/).filter(Boolean);
    const bad = parts.filter((p) => !Number.isFinite(Number(p)));
    return { values: parts.map(Number), bad };
  }

  function peaksError(text) {
    const { values, bad } = parsePeaks(text);
    if (!values.length) return "Enter at least one peak";
    if (bad.length) return `Not a number: ${bad.slice(0, 3).map((b) => `“${b}”`).join(", ")}${bad.length > 3 ? "…" : ""}`;
    if (values.length > MAX_PEAKS) return `Too many peaks (${values.length}); the maximum is ${MAX_PEAKS}`;
    return null;
  }

  function chart(group, kind, el, spec) {
    const h = ECCL.plot[kind](el, spec);
    (S.charts[group] = S.charts[group] || []).push(h);
    return h;
  }

  function dropCharts(group) {
    for (const h of S.charts[group] || []) { try { h.destroy(); } catch (err) { /* already gone */ } }
    S.charts[group] = [];
  }

  function confKind(c) { return c >= 0.75 ? "ok" : c >= 0.5 ? "info" : "warn"; }

  function confMeter(c) {
    const m = ECCL.ui.meter({ value: c, min: 0, max: 1, kind: confKind(c), format: pct, label: "confidence" });
    m.classList.add("sp-conf");
    const label = m.querySelector(".meter-label");
    if (label) label.remove();
    return m;
  }

  function legendKey(swatchClass, text) {
    const ui = ECCL.ui;
    return ui.el("span", { class: "sp-key" }, ui.el("span", { class: `sp-swatch ${swatchClass}`, "aria-hidden": "true" }), text);
  }

  function loadingCard(text) {
    const ui = ECCL.ui;
    return ui.card(ui.el("div", { class: "sp-loading" }, ui.spinner(text), ui.el("span", null, text)));
  }

  function setStale(el, on) { if (el) el.classList.toggle("is-stale", !!on); }

  /** Submit a ui.form now, or once more after the request it is already running. */
  function submitLatest(form) {
    if (form.classList.contains("is-pending")) return form.submit().then(() => form.submit());
    return form.submit();
  }

  /** Best (highest-confidence) assignment per peak. */
  function bestByPeak(assignments) {
    const best = new Map();
    for (const a of assignments || []) {
      const cur = best.get(a.peak);
      if (!cur || a.confidence > cur.confidence) best.set(a.peak, a);
    }
    return best;
  }

  function domainFor(m, xs) {
    const vals = modInfo(m).range.concat(xs.filter((x) => Number.isFinite(x)));
    return [Math.min(...vals), Math.max(...vals)];
  }

  function groupBadges(groups, kind = "info", emptyText = "No functional groups matched.") {
    const ui = ECCL.ui;
    if (!groups || !groups.length) return ui.el("p", { class: "sp-muted" }, emptyText);
    return ui.el("div", { class: "sp-badges" }, groups.map((g) => ui.badge(g, typeof kind === "function" ? kind(g) : kind)));
  }

  function assignmentsTable(assignments, unit, opts = {}) {
    const ui = ECCL.ui;
    const best = bestByPeak(assignments);
    const rows = (assignments || []).filter((a) => !opts.bestOnly || best.get(a.peak) === a)
      .map((a) => ({ ...a, isBest: best.get(a.peak) === a }));
    return ui.table({
      columns: [
        { key: "peak", label: `Peak (${unit})`, format: (v) => fmt(v, 4), align: "right" },
        {
          key: "assignment", label: "Assignment",
          format: (v, r) => ui.el("div", { class: "sp-assign" }, ui.el("span", null, v),
            r.isBest && !opts.bestOnly ? ui.badge("best", "ok") : null,
            opts.bestOnly ? ui.el("small", null, r.group) : r.note ? ui.el("small", null, r.note) : null),
        },
        opts.bestOnly ? null : { key: "group", label: "Group" },
        { key: "confidence", label: "Confidence", format: (v) => confMeter(v), width: opts.bestOnly ? 120 : 150, align: "right" },
        opts.bestOnly ? null : {
          key: "window", label: `Window (${unit})`, sortValue: (r) => (r.window ? r.window[0] : null),
          format: (w) => (Array.isArray(w) ? `${fmt(w[0], 4)}–${fmt(w[1], 4)}` : "—"),
        },
      ].filter(Boolean),
      rows,
      empty: "No peak matched a reference band.",
      maxHeight: opts.maxHeight || 440,
    });
  }

  // ------------------------------------------------------------------ Interpret

  function setModality(m) {
    const I = S.interp;
    I.modality = MOD[m] ? m : "IR";
    if (I.seg && I.seg.getValue() !== I.modality) I.seg.setValue(I.modality);
    if (!I.form) return;
    const M = modInfo(I.modality);
    const tol = I.form.field("tolerance");
    if (tol) {
      tol.input.placeholder = `default ${M.tol}`;
      const help = tol.querySelector(".field-help");
      if (help) help.textContent = `Extra window (${M.unit}) allowed outside each reference band. Leave empty for the default.`;
      const lab = tol.querySelector(".field-label");
      if (lab && lab.firstChild) lab.firstChild.nodeValue = `Tolerance (${M.unit})`;
    }
    const pk = I.form.field("peaks");
    if (pk) {
      const lab = pk.querySelector(".field-label");
      if (lab && lab.firstChild) lab.firstChild.nodeValue = `Peak positions (${M.unit})`;
      pk.input.placeholder = I.modality === "IR" ? "e.g. 3000, 1715, 1280" : I.modality === "raman" ? "e.g. 1350 1582 2690"
        : I.modality === "1H" ? "e.g. 1.2, 2.1, 7.3" : "e.g. 14, 61, 128, 170";
    }
  }

  function applyPreset(p) {
    const I = S.interp;
    setModality(p.modality);
    I.form.setValues({ peaks: (p.peaks || []).join(", "), tolerance: null });
    return submitLatest(I.form);
  }

  function interpretTab() {
    const ui = ECCL.ui;
    const I = S.interp;
    const info = S.ctx.info || ECCL.info || {};
    const presets = (info.presets && Array.isArray(info.presets.spectra) && info.presets.spectra.length) ? info.presets.spectra : FALLBACK_PRESETS;
    const pending = I.pending || null;
    I.pending = null;
    const first = pending || presets[0];
    I.modality = MOD[first.modality] ? first.modality : "IR";

    I.seg = ui.segmented({
      options: S.mods.map((m) => ({ value: m, label: MOD[m].label })), value: I.modality, ariaLabel: "Modality",
      onChange: (m) => setModality(m),
    });
    const modField = ui.el("div", { class: "field sp-mod-field" },
      ui.el("div", { class: "field-head" }, ui.el("span", { class: "field-label" }, "Modality")), I.seg);
    I.form = ui.form({
      fields: [
        modField,
        { name: "tolerance", label: "Tolerance", type: "number", min: 0, max: 10000, help: " " },
        { name: "peaks", label: "Peak positions", type: "textarea", rows: 3, mono: true, required: true,
          value: (first.peaks || []).join(", "), help: "Separate values with commas, spaces or new lines.", validate: peaksError },
      ],
      columns: 2, submitLabel: "Interpret", submitIcon: "spectrum", onSubmit: runInterpret,
    });
    setModality(I.modality);

    const presetRow = ui.el("div", { class: "sp-presets" }, ui.el("span", { class: "sp-presets-label" }, "Examples"),
      presets.map((p) => ui.button(p.name, { small: true, onClick: () => applyPreset(p), title: `${MOD[p.modality] ? MOD[p.modality].label : p.modality}: ${(p.peaks || []).join(", ")}` })));

    I.results = ui.el("div", { class: "sp-results sp-stack", "aria-live": "polite" }, loadingCard("Interpreting peaks…"));
    const node = ui.el("div", { class: "sp-stack" },
      ui.card({ title: "Peak list", icon: "spectrum", subtitle: "Match observed peaks to the reference windows; each peak keeps its top three candidates." },
        presetRow, I.form),
      I.results);
    I.form.submit();
    return node;
  }

  function runInterpret(values) {
    const I = S.interp;
    const modality = I.modality;
    const peaks = parsePeaks(values.peaks).values;
    const body = { modality, peaks };
    if (values.tolerance !== null && values.tolerance !== undefined) body.tolerance = values.tolerance;
    setStale(I.results, true);
    return ECCL.api.post("/api/spectro/interpret", body).then(
      (data) => { setStale(I.results, false); renderInterpret(data, peaks, modality); },
      (err) => {
        setStale(I.results, false);
        if (I.results.querySelector(".sp-loading")) fill(I.results, ECCL.ui.empty("Fix the input above to see an interpretation."));
        throw err;
      });
  }

  function renderInterpret(data, peaks, modality) {
    const ui = ECCL.ui;
    const I = S.interp;
    dropCharts("interp");
    const M = modInfo(modality);
    const best = bestByPeak(data.assignments);
    const unique = Array.from(new Set(peaks));
    const unassigned = Array.isArray(data.unassigned) ? data.unassigned : [];
    const assigned = unique.filter((p) => best.has(p));
    const groups = data.functional_groups || [];
    const meanConf = assigned.length ? assigned.reduce((s, p) => s + best.get(p).confidence, 0) / assigned.length : null;

    const sticks = unique.map((p) => {
      const b = best.get(p);
      return { x: p, y: b ? b.confidence : 0, label: b ? b.group : "unassigned", color: b ? "chart-1" : "chart-2" };
    });
    const bandMap = new Map();
    for (const b of best.values()) {
      const w = b.window || [];
      const key = `${w[0]}|${w[1]}|${b.assignment}`;
      if (w.length === 2 && !bandMap.has(key)) bandMap.set(key, { x0: w[0], x1: w[1], label: b.assignment });
    }
    const bands = Array.from(bandMap.values());
    const xDomain = domainFor(modality, unique.concat(bands.flatMap((b) => [b.x0, b.x1])));
    const chartEl = ui.el("div");

    const unassignedBody = unassigned.length
      ? [ui.el("div", { class: "sp-badges" }, unassigned.map((p) => ui.badge(`${fmt(p, 4)} ${M.unit}`, "warn"))),
        ui.el("p", { class: "sp-muted" }, `No reference band lies within the tolerance of these peaks. Try a larger tolerance or another modality.`)]
      : ui.notice("Every peak matched at least one reference band.", "ok");

    fill(I.results, 
      ui.notice(data.summary || "No summary returned.", assigned.length ? "info" : "warn"),
      ui.el("div", { class: "grid grid-4 sp-stats", style: { "--cols": "4" } },
        ui.stat({ label: "Peaks", value: unique.length, hint: M.label }),
        ui.stat({ label: "Assigned", value: assigned.length, kind: assigned.length ? "ok" : "warn", hint: meanConf === null ? "no matches" : `mean best confidence ${pct(meanConf)}` }),
        ui.stat({ label: "Unassigned", value: unassigned.length, kind: unassigned.length ? "warn" : null }),
        ui.stat({ label: "Functional groups", value: groups.length, kind: "info" })),
      ui.card({
        title: "Peaks and best-match windows", icon: "spectrum",
        subtitle: `${M.label}: stick height is the confidence of each peak's best assignment; ${M.reverse ? "x axis runs high → low, as is convention" : "x axis increases left to right, as is convention for Raman"}.`,
      }, chartEl,
      ui.el("div", { class: "sp-legend" },
        legendKey("sp-swatch-line sp-swatch-c1", "Assigned peak"),
        legendKey("sp-swatch-line sp-swatch-c2", "Unassigned peak (?)"),
        legendKey("sp-swatch-band", "Reference window of the best match"))),
      ui.grid(2,
        ui.card({ title: "Functional groups", subtitle: "Union of every candidate assignment" }, groupBadges(groups)),
        ui.card({ title: "Unassigned peaks", subtitle: unassigned.length ? `${unassigned.length} of ${unique.length}` : null }, unassignedBody)),
      ui.card({ title: "Assignments", icon: "table", subtitle: "Up to three overlapping reference windows per peak, ranked by confidence (1 at the band centre, 0.5 at its edge)." },
        assignmentsTable(data.assignments, M.unit)));

    chart("interp", "stickChart", chartEl, {
      sticks, bands, xDomain, xReverse: M.reverse, yDomain: [0, 1], height: 300,
      xLabel: M.axis, yLabel: "Best-match confidence", empty: "No peaks",
    });
  }

  // ------------------------------------------------------------------ Mass spec

  function msTab() {
    const ui = ECCL.ui;
    const P = S.ms;
    P.form = ui.form({
      fields: [
        { name: "molecular_ion", label: "Molecular ion M⁺ (m/z)", type: "number", min: 1, max: 1e6, required: true, value: MS_EXAMPLE.ion },
        { name: "tolerance", label: "Matching tolerance (Da)", type: "number", min: 0, max: 100, value: 0.5, help: "How close M⁺ − fragment must be to a tabulated loss." },
        { name: "fragments", label: "Fragment ions (m/z)", type: "textarea", rows: 2, mono: true, required: true,
          value: MS_EXAMPLE.fragments.join(", "), help: "Separate values with commas, spaces or new lines.", validate: peaksError },
      ],
      columns: 2, submitLabel: "Explain fragments", submitIcon: "spectrum", onSubmit: runMs,
    });
    P.results = ui.el("div", { class: "sp-results sp-stack", "aria-live": "polite" }, loadingCard("Explaining fragments…"));
    const node = ui.el("div", { class: "sp-stack" },
      ui.card({ title: "EI mass spectrum", icon: "spectrum", subtitle: `Each fragment is explained as a neutral loss from the molecular ion. Prefilled with ${MS_EXAMPLE.label}.` },
        P.form),
      P.results);
    P.form.submit();
    return node;
  }

  function runMs(values) {
    const P = S.ms;
    const fragments = parsePeaks(values.fragments).values;
    const body = { molecular_ion: values.molecular_ion, fragments };
    if (values.tolerance !== null && values.tolerance !== undefined) body.tolerance = values.tolerance;
    setStale(P.results, true);
    return ECCL.api.post("/api/spectro/ms", body).then(
      (data) => { setStale(P.results, false); renderMs(data, fragments, values.molecular_ion); },
      (err) => {
        setStale(P.results, false);
        if (P.results.querySelector(".sp-loading")) fill(P.results, ECCL.ui.empty("Fix the input above to see the neutral-loss analysis."));
        throw err;
      });
  }

  function shortLoss(label) { return String(label || "").split(/\s*[/(]\s*/)[0].trim(); }

  function renderMs(data, fragments, ionIn) {
    const ui = ECCL.ui;
    const P = S.ms;
    dropCharts("ms");
    const ion = Number.isFinite(data.molecular_ion) ? data.molecular_ion : ionIn;
    const losses = Array.isArray(data.losses) ? data.losses : [];
    const explained = losses.filter((l) => l.assignment && l.assignment !== "unassigned");
    const byFragment = new Map(losses.map((l) => [l.fragment, l]));
    const ignored = Array.from(new Set(fragments.filter((f) => !(f < ion))));

    const sticks = [{ x: ion, y: 1, label: `M⁺ ${fmt(ion, 5)}`, color: "chart-2" }];
    for (const f of Array.from(new Set(fragments))) {
      if (f === ion) continue;
      const l = byFragment.get(f);
      const ok = l && l.assignment !== "unassigned";
      sticks.push({ x: f, y: 1, label: ok ? `−${fmt(l.loss_mass, 4)} ${shortLoss(l.assignment)}` : fmt(f, 5), color: ok ? "chart-1" : "--chart-marker" });
    }
    const maxX = Math.max(ion, ...fragments);
    const chartEl = ui.el("div");

    fill(P.results, 
      ui.notice(data.summary || "No summary returned.", explained.length ? "info" : "warn"),
      ignored.length ? ui.notice(`Ignored ${ignored.length} fragment(s) at or above M⁺ (${ignored.map((f) => fmt(f, 5)).join(", ")}): a fragment must be lighter than the molecular ion.`, "warn") : null,
      ui.el("div", { class: "grid grid-4 sp-stats", style: { "--cols": "4" } },
        ui.stat({ label: "Molecular ion M⁺", value: ion, unit: "m/z" }),
        ui.stat({ label: "Fragments analysed", value: losses.length }),
        ui.stat({ label: "Explained", value: explained.length, kind: explained.length ? "ok" : "warn", hint: losses.length ? `${pct(explained.length / losses.length)} of fragments` : null }),
        ui.stat({ label: "Unexplained", value: losses.length - explained.length, kind: losses.length - explained.length ? "warn" : null })),
      ui.card({ title: "Stick spectrum", icon: "spectrum", subtitle: "Peaks are drawn at unit height (intensities are not part of the analysis); labels give the neutral loss from M⁺." },
        chartEl,
        ui.el("div", { class: "sp-legend" },
          legendKey("sp-swatch-line sp-swatch-c2", "Molecular ion M⁺"),
          legendKey("sp-swatch-line sp-swatch-c1", "Explained fragment"),
          legendKey("sp-swatch-line sp-swatch-muted", "Unexplained fragment"))),
      ui.card({
        title: "Neutral losses", icon: "table", subtitle: "Loss = M⁺ − fragment, matched against common EI neutral losses.",
        actions: ui.button("Reference losses", { kind: "ghost", small: true, icon: "book", onClick: () => openLibrary("neutral_losses") }),
      },
      ui.table({
        columns: [
          { key: "fragment", label: "Fragment (m/z)", format: (v) => fmt(v, 5), align: "right" },
          { key: "loss_mass", label: "Loss (Da)", format: (v) => `−${fmt(v, 5)}`, align: "right" },
          { key: "assignment", label: "Neutral lost", format: (v) => (v && v !== "unassigned" ? ui.badge(v, "ok") : ui.badge("unassigned", "neutral")) },
        ],
        rows: losses,
        empty: "No fragment lighter than M⁺.",
        maxHeight: 420,
      })));

    chart("ms", "stickChart", chartEl, {
      sticks, xDomain: [0, maxX * 1.06], yDomain: [0, 1], height: 280,
      xLabel: "m/z", yLabel: "Peak (unit height)",
    });
  }

  // ------------------------------------------------------------------ Cross-validate

  function crossRow(spec) {
    const ui = ECCL.ui;
    const C = S.cross;
    const sel = ui.field({ name: "modality", label: "Modality", type: "select", options: S.mods.map((m) => ({ value: m, label: MOD[m].label })), value: spec.modality });
    const peaks = ui.field({
      name: "peaks", label: "Peaks", type: "text", mono: true, required: true, value: (spec.peaks || []).join(", "),
      placeholder: "comma- or space-separated", validate: peaksError,
    });
    const row = ui.el("div", { class: "sp-cross-row" }, sel, peaks);
    const remove = ui.button(null, {
      kind: "ghost", small: true, icon: "trash", title: "Remove this modality",
      onClick: () => { C.rows = C.rows.filter((r) => r.row !== row); row.remove(); paintCrossButtons(); },
    });
    remove.classList.add("sp-row-remove");
    row.appendChild(remove);
    const entry = { row, sel, peaks, remove };
    sel.input.addEventListener("change", () => { peaks.input.placeholder = `values in ${modInfo(sel.getValue()).unit}`; });
    return entry;
  }

  function addCrossRow(spec) {
    const C = S.cross;
    if (C.rows.length >= MAX_CROSS_ROWS) return;
    const used = new Set(C.rows.map((r) => r.sel.getValue()));
    const modality = spec ? spec.modality : (S.mods.find((m) => !used.has(m)) || S.mods[0]);
    const e = crossRow(spec || { modality, peaks: [] });
    C.rows.push(e);
    C.list.appendChild(e.row);
    paintCrossButtons();
    if (!spec) e.peaks.input.focus();
  }

  function paintCrossButtons() {
    const C = S.cross;
    C.addBtn.disabled = C.rows.length >= MAX_CROSS_ROWS;
    for (const r of C.rows) r.remove.disabled = C.rows.length <= 1;
  }

  function crossTab() {
    const ui = ECCL.ui;
    const C = S.cross;
    C.rows = [];
    C.list = ui.el("div", { class: "sp-cross-rows" });
    C.errorSlot = ui.el("div", { class: "form-error" });
    C.addBtn = ui.button("Add modality", { icon: "plus", onClick: () => addCrossRow(null) });
    C.runBtn = ui.button("Cross-validate", { kind: "primary", icon: "check", type: "submit" });
    C.form = ui.el("form", { class: "form", novalidate: true, on: { submit: (ev) => { ev.preventDefault(); runCross(); } } },
      C.list, C.errorSlot,
      ui.el("div", { class: "sp-cross-actions" }, C.runBtn, C.addBtn,
        ui.button("Reset example", { kind: "ghost", icon: "refresh", onClick: () => { resetCross(); return runCross(); } })));
    C.results = ui.el("div", { class: "sp-results sp-stack", "aria-live": "polite" }, loadingCard("Cross-validating…"));
    resetCross();
    const node = ui.el("div", { class: "sp-stack" },
      ui.card({ title: "Modalities", icon: "spectrum", subtitle: `Up to ${MAX_CROSS_ROWS} peak lists; a functional group seen in two or more modalities counts as corroborated. Prefilled with benzoic acid.` },
        C.form),
      C.results);
    runCross();
    return node;
  }

  function resetCross() {
    const C = S.cross;
    C.rows = [];
    C.list.replaceChildren();
    C.errorSlot.replaceChildren();
    for (const spec of CROSS_EXAMPLE) addCrossRow(spec);
  }

  function runCross() {
    const C = S.cross;
    let firstBad = null;
    for (const r of C.rows) if (r.peaks.validate() && !firstBad) firstBad = r.peaks;
    if (firstBad) { firstBad.input.focus(); return Promise.resolve(); }
    const sets = C.rows.map((r) => ({ modality: r.sel.getValue(), peaks: parsePeaks(r.peaks.getValue()).values }));
    setStale(C.results, true);
    const p = ECCL.api.post("/api/spectro/crossvalidate", { sets }).then((data) => {
      C.errorSlot.replaceChildren();
      setStale(C.results, false);
      renderCross(data, sets);
    }, (err) => {
      setStale(C.results, false);
      fill(C.errorSlot, ECCL.ui.errorBox(err));
      if (C.results.querySelector(".sp-loading")) fill(C.results, ECCL.ui.empty("Fix the input above to cross-validate."));
      ECCL.ui.toast(ECCL.ui.errMessage(err), "bad");
    });
    ECCL.ui.busy(C.runBtn, p);
    return p;
  }

  function renderCross(data, sets) {
    const ui = ECCL.ui;
    const C = S.cross;
    dropCharts("cross");
    const cross = data.cross || {};
    const counts = cross.evidence_counts || {};
    const corroborated = cross.corroborated_groups || [];
    const corrSet = new Set(corroborated);
    const allGroups = cross.all_groups || Object.keys(counts);
    const bars = Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([g, n]) => ({ label: g, value: n, color: corrSet.has(g) ? "chart-1" : "--chart-marker" }));
    const chartEl = ui.el("div");
    const interps = Array.isArray(data.interpretations) ? data.interpretations : [];
    const single = allGroups.filter((g) => !corrSet.has(g));

    fill(C.results, 
      ui.el("div", { class: "grid grid-3 sp-stats", style: { "--cols": "3" } },
        ui.stat({ label: "Modalities", value: sets.length, hint: sets.map((s) => modInfo(s.modality).label).join(" · ") }),
        ui.stat({ label: "Groups suggested", value: allGroups.length }),
        ui.stat({ label: "Corroborated", value: corroborated.length, kind: corroborated.length ? "ok" : "warn", hint: "seen in ≥ 2 modalities" })),
      ui.grid(2,
        ui.card({ title: "Corroborated groups", icon: "check", subtitle: "Supported by at least two independent modalities" },
          corroborated.length
            ? ui.el("div", { class: "sp-badges" }, corroborated.map((g) => ui.badge(`${g} · ${counts[g]}×`, "ok")))
            : ui.notice(sets.length < 2 ? "Add a second modality: corroboration needs at least two peak lists." : "No functional group is supported by two or more modalities.", "warn"),
          ui.el("p", { class: "sp-muted" }, "Agreement between techniques that probe different physics (bond vibrations, proton and carbon environments) is much stronger evidence than any single table match."),
          single.length ? ui.el("div", { class: "sp-sub" }, `Single-modality suggestions (${single.length})`) : null,
          single.length ? groupBadges(single, "neutral") : null),
        ui.card({ title: "Evidence per functional group", icon: "spectrum", subtitle: "Number of modalities whose interpretation includes each group" },
          ui.el("div", { class: "sp-bar-wrap" }, chartEl),
          ui.el("div", { class: "sp-legend" },
            legendKey("sp-swatch-c1", "Corroborated (≥ 2 modalities)"),
            legendKey("sp-swatch-muted", "Single modality")))),
      ui.grid(Math.min(3, Math.max(1, interps.length)), interps.map((it, i) => {
        const M = modInfo(it.modality);
        const n = sets[i] ? sets[i].peaks.length : 0;
        return ui.card({ title: M.label, subtitle: `${n} peak${n === 1 ? "" : "s"} · ${(it.functional_groups || []).length} group(s) · ${(it.unassigned || []).length} unassigned` },
          groupBadges(it.functional_groups, (g) => (corrSet.has(g) ? "ok" : "neutral")),
          ui.el("p", { class: "sp-muted" }, it.summary || ""));
      })));

    chart("cross", "barChart", chartEl, {
      bars, horizontal: true, yLabel: "Modalities with evidence", yDomain: [0, MAX_CROSS_ROWS],
      format: (v) => String(Math.round(v)), empty: "No groups",
    });
  }

  // ------------------------------------------------------------------ Simulate IR

  function simulateTab() {
    const ui = ECCL.ui;
    const P = S.sim;
    const info = S.ctx.info || ECCL.info || {};
    const presets = (info.presets && info.presets.molecules) || {};
    const initial = P.pendingSmiles || DEFAULT_SIM_SMILES;
    P.pendingSmiles = null;
    P.form = ui.form({
      fields: [
        { name: "smiles", label: "SMILES", type: "text", mono: true, required: true, value: initial, placeholder: "e.g. CC(=O)Oc1ccccc1C(=O)O" },
        { name: "preset", label: "Preset", type: "select",
          options: [{ value: "", label: "Custom…" }].concat(Object.keys(presets).map((k) => ({ value: k, label: k }))),
          value: Object.keys(presets).find((k) => presets[k] === initial) || "",
          onChange: (v) => { if (v && presets[v]) { P.form.setValues({ smiles: presets[v] }); submitLatest(P.form); } } },
      ],
      columns: 2, submitLabel: "Simulate", submitIcon: "play", onSubmit: runSim,
    });
    P.form.field("smiles").input.addEventListener("input", () => {
      const sel = P.form.field("preset");
      const v = P.form.field("smiles").getValue();
      sel.setValue(Object.keys(presets).find((k) => presets[k] === v) || "");
    });
    P.results = ui.el("div", { class: "sp-results sp-stack", "aria-live": "polite" }, loadingCard("Simulating IR spectrum…"));
    const node = ui.el("div", { class: "sp-stack" },
      ui.card({ title: "Molecule", icon: "flask", subtitle: "Predict an IR spectrum from characteristic group frequencies, then interpret its peaks." }, P.form),
      P.results);
    P.form.submit();
    return node;
  }

  function runSim(values) {
    const P = S.sim;
    setStale(P.results, true);
    return ECCL.api.post("/api/spectro/simulate_ir", { smiles: values.smiles }).then(
      (data) => { setStale(P.results, false); renderSim(data, values.smiles); },
      (err) => {
        setStale(P.results, false);
        if (P.results.querySelector(".sp-loading")) fill(P.results, ECCL.ui.empty("Enter a valid SMILES string to simulate its IR spectrum."));
        throw err;
      });
  }

  function renderSim(data, smilesIn) {
    const ui = ECCL.ui;
    const P = S.sim;
    dropCharts("sim");
    const smiles = data.smiles || smilesIn;
    const interp = data.interpretation || {};
    const peaks = Array.isArray(data.peaks) ? data.peaks : [];
    const chartEl = ui.el("div");
    const actions = ui.el("div", { class: "sp-actions" },
      ui.button("Open in Molecule Studio", { icon: "flask", small: true, onClick: () => S.ctx.navigate("molecule", { smiles }) }),
      peaks.length ? ui.button("Interpret these peaks", { icon: "spectrum", small: true, onClick: () => sendToInterpret("IR", peaks) }) : null);

    fill(P.results, 
      ui.card({ title: "Simulated IR spectrum", icon: "spectrum", subtitle: smiles, actions }, chartEl,
        ui.el("p", { class: "sp-muted" }, `${peaks.length} characteristic band${peaks.length === 1 ? "" : "s"} (dashed markers). Absorbance is normalised to the strongest band; x axis runs high → low, as is convention.`)),
      ui.grid(2,
        ui.card({ title: "Interpretation", subtitle: "Groups recovered from the simulated peaks" },
          groupBadges(interp.functional_groups),
          interp.summary ? ui.notice(interp.summary, "info") : null),
        ui.card({ title: "Best assignment per peak", icon: "table" },
          assignmentsTable(interp.assignments, "cm⁻¹", { bestOnly: true, maxHeight: 360 }))));

    chart("sim", "lineChart", chartEl, {
      series: [{ name: "Absorbance", x: data.x || [], y: data.y || [], area: true }],
      xLabel: "Wavenumber (cm⁻¹)", yLabel: "Absorbance (normalised)", xReverse: true, legend: false, height: 300,
      markers: peaks.map((p) => ({ x: p, label: fmt(p, 4) })),
    });
  }

  function sendToInterpret(modality, peaks) {
    const I = S.interp;
    if (!I.form) { I.pending = { modality, peaks }; selectTab("interpret"); return undefined; } // first render consumes it
    selectTab("interpret");
    setModality(modality);
    I.form.setValues({ peaks: peaks.join(", "), tolerance: null });
    return submitLatest(I.form);
  }

  // ------------------------------------------------------------------ Reference library

  const LIB_OPTIONS = [
    { value: "IR", label: "IR bands" }, { value: "raman", label: "Raman bands" }, { value: "1H", label: "¹H NMR shifts" },
    { value: "13C", label: "¹³C NMR shifts" }, { value: "neutral_losses", label: "MS neutral losses" },
  ];

  function libraryTab() {
    const ui = ECCL.ui;
    const L = S.lib;
    L.select = ui.field({ name: "library", label: "Table", type: "select", options: LIB_OPTIONS, value: L.modality, onChange: (v) => { L.modality = v; paintLibrary(); } });
    L.search = ui.field({ name: "filter", label: "Filter", type: "text", placeholder: "assignment, group, note or a value (e.g. 1715)", onChange: (v) => { L.filter = v; paintLibrary(); } });
    L.count = ui.el("div", { class: "sp-lib-count", "aria-live": "polite" });
    L.tableSlot = ui.el("div", null, loadingCard("Loading reference tables…"));
    const node = ui.card({ title: "Reference library", icon: "book", subtitle: "The textbook windows the interpreter matches against. A numeric filter finds every band containing that value." },
      ui.el("div", { class: "sp-lib-controls" }, L.select, L.search, L.count), L.tableSlot);
    loadLibrary();
    return node;
  }

  function loadLibrary() {
    const L = S.lib;
    if (!L.promise) {
      L.promise = ECCL.api.get("/api/spectro/tables").then((d) => { L.data = d; return d; }, (err) => { L.promise = null; throw err; });
    }
    return L.promise.then(() => paintLibrary(), (err) => {
      if (L.tableSlot) fill(L.tableSlot, ECCL.ui.errorBox(err), ECCL.ui.button("Retry", { icon: "refresh", onClick: () => loadLibrary() }));
    });
  }

  function paintLibrary() {
    const ui = ECCL.ui;
    const L = S.lib;
    if (!L.data || !L.tableSlot) return;
    const q = String(L.filter || "").trim().toLowerCase();
    const qNum = q && Number.isFinite(Number(q)) ? Number(q) : null;
    let table, total, shown;
    if (L.modality === "neutral_losses") {
      const rows = Object.entries(L.data.neutral_losses || {}).map(([mass, label]) => ({ mass: Number(mass), label }))
        .sort((a, b) => a.mass - b.mass);
      const hit = rows.filter((r) => !q || (qNum !== null ? Math.abs(r.mass - qNum) <= 0.5 : r.label.toLowerCase().includes(q) || String(r.mass).includes(q)));
      total = rows.length; shown = hit.length;
      table = ui.table({
        columns: [
          { key: "mass", label: "Loss (Da)", format: (v) => `−${v}`, align: "right" },
          { key: "label", label: "Neutral fragment" },
        ],
        rows: hit, empty: "No neutral loss matches the filter.", maxHeight: 520,
      });
    } else {
      const M = modInfo(L.modality);
      const rows = Array.isArray(L.data[L.modality]) ? L.data[L.modality] : [];
      const hit = rows.filter((r) => {
        if (!q) return true;
        if (qNum !== null && qNum >= r.low && qNum <= r.high) return true;
        return [r.assignment, r.group, r.intensity, r.note].some((t) => String(t || "").toLowerCase().includes(q));
      });
      total = rows.length; shown = hit.length;
      table = ui.table({
        columns: [
          { key: "low", label: `Range (${M.unit})`, format: (v, r) => `${fmt(r.low, 4)}–${fmt(r.high, 4)}`, align: "right" },
          { key: "assignment", label: "Assignment" },
          { key: "group", label: "Group", format: (v) => ui.badge(v, "info") },
          { key: "intensity", label: "Intensity", format: (v) => v || "—" },
          { key: "note", label: "Note", format: (v) => v || "—" },
        ],
        rows: hit, empty: "No band matches the filter.", maxHeight: 520,
      });
    }
    L.count.textContent = q ? `${shown} of ${total} entries` : `${total} entries`;
    fill(L.tableSlot, table);
  }

  function openLibrary(which) {
    S.lib.modality = which;
    S.lib.filter = "";
    selectTab("library");
    if (S.lib.select) { S.lib.select.setValue(which); S.lib.search.setValue(""); paintLibrary(); }
  }

  // ------------------------------------------------------------------ tabs & panel

  function selectTab(id) {
    if (S.tabs && TAB_IDS.includes(id)) S.tabs.select(id);
  }

  ECCL.registerPanel({
    id: "spectroscopy",
    title: "Spectroscopy",
    group: "Analysis",
    icon: "spectrum",
    description: "Interpret IR, Raman, 1H / 13C NMR and mass spectra, and cross-validate across modalities.",
    order: 80,
    render(root, ctx) {
      const ui = ECCL.ui;
      injectStyle();
      S.ctx = ctx;
      const info = ctx.info || ECCL.info || {};
      const mods = (info.libraries && info.libraries.spectro_modalities) || [];
      const known = mods.filter((m) => MOD[m]);
      if (known.length) S.mods = known;
      const params = ctx.params || {};
      if (params.peaks) S.interp.pending = { modality: MOD[params.modality] ? params.modality : "IR", peaks: parsePeaks(params.peaks).values };
      if (params.smiles) S.sim.pendingSmiles = String(params.smiles).trim();
      const initial = TAB_IDS.includes(params.tab) ? params.tab : params.smiles ? "simulate" : "interpret";

      S.tabs = ui.tabs([
        { id: "interpret", label: "Interpret", icon: "spectrum", render: interpretTab },
        { id: "ms", label: "Mass spec", icon: "activity", render: msTab },
        { id: "cross", label: "Cross-validate", icon: "check", render: crossTab },
        { id: "simulate", label: "Simulate IR", icon: "flask", render: simulateTab },
        { id: "library", label: "Reference library", icon: "book", render: libraryTab },
      ], { initial, ariaLabel: "Spectroscopy tools" });

      root.append(
        ui.el("p", { class: "sp-intro" },
          "Paste peak positions from a spectrometer to get ranked functional-group assignments from reference band tables, ",
          "explain mass-spec fragments as neutral losses, check which groups two or more techniques agree on, or simulate an IR spectrum from a structure."),
        S.tabs);
      S.lastParams = JSON.stringify(params);
    },
    onShow(params) {
      const p = params || {};
      const key = JSON.stringify(p);
      if (key === S.lastParams) return;
      S.lastParams = key;
      if (p.smiles) {
        const smi = String(p.smiles).trim();
        selectTab("simulate");
        if (S.sim.form) { S.sim.form.setValues({ smiles: smi }); submitLatest(S.sim.form); } else S.sim.pendingSmiles = smi;
      } else if (p.peaks) {
        sendToInterpret(MOD[p.modality] ? p.modality : "IR", parsePeaks(p.peaks).values.filter(Number.isFinite));
      } else if (TAB_IDS.includes(p.tab)) {
        selectTab(p.tab);
      }
    },
  });
})(window.ECCL);
