/* Crystals panel - Goldschmidt tolerance factor for ABX3 perovskites (with a zone gauge and a
 * comparison of the library presets) and simulated cubic powder XRD patterns.
 * Both forms auto-run with defaults (CsPbI3, silicon) and re-run live.
 *
 * Endpoints: /api/crystal/{tolerance,xrd}.
 */
window.ECCL = window.ECCL || {};

(function (ECCL) {
  "use strict";

  const T_MIN = 0.6, T_MAX = 1.2;
  const ZONES = [
    { lo: 0.6, hi: 0.71, name: "Non-perovskite", short: "Non-p.", range: "t < 0.71", kind: "bad" },
    { lo: 0.71, hi: 0.8, name: "Distorted", short: "Dist.", range: "0.71 – 0.80", kind: "warn" },
    { lo: 0.8, hi: 1.0, name: "Perovskite", short: "Perov.", range: "0.80 – 1.00", kind: "ok" },
    { lo: 1.0, hi: 1.2, name: "Hexagonal", short: "Hex.", range: "t > 1.00", kind: "bad" },
  ];
  const WAVELENGTHS = [
    { value: "Cu", label: "Cu Kα", ang: 1.5406 },
    { value: "Mo", label: "Mo Kα", ang: 0.7107 },
    { value: "Co", label: "Co Kα", ang: 1.789 },
    { value: "custom", label: "Custom", ang: null },
  ];
  const ION_NAMES = { "MA+": "methylammonium", "FA+": "formamidinium" };
  const CUSTOM = "__custom__";

  const CSS = `
#panel-crystal .cr-intro { color: var(--text-2); max-width: 90ch; }
#panel-crystal .cr-stack { display: flex; flex-direction: column; gap: var(--gap); min-width: 0; }
#panel-crystal .cr-stack > * + * { margin-top: 0; }
#panel-crystal .cr-results { transition: opacity 0.15s ease; }
#panel-crystal .cr-results.is-busy { opacity: 0.55; }
#panel-crystal .cr-tiles { --grid-min: 150px; }
#panel-crystal .cr-loading {
  display: flex; align-items: center; justify-content: center; gap: 8px; min-height: 110px;
  color: var(--text-3); font-size: 13px;
}
#panel-crystal .cr-presets .segmented { display: flex; width: 100%; }
#panel-crystal .cr-presets .seg { flex: 1 1 auto; justify-content: center; padding-left: 8px; padding-right: 8px; }
@media (min-width: 900px) { #panel-crystal .cr-presets.cr-span2 { grid-column: span 2; } }
#panel-crystal .cr-gauge { width: 100%; min-height: 104px; }
#panel-crystal .cr-gauge svg { display: block; width: 100%; overflow: visible; }
#panel-crystal .cr-gauge text { font-family: var(--font-sans); }
#panel-crystal .cr-legend { display: flex; flex-wrap: wrap; gap: 6px 18px; font-size: 12.5px; color: var(--text-2); }
#panel-crystal .cr-legend-item { display: inline-flex; align-items: center; gap: 7px; }
#panel-crystal .cr-legend-key { width: 14px; height: 10px; border-radius: 3px; border: 1px solid; flex: none; }
#panel-crystal .cr-legend-range { color: var(--text-3); font-variant-numeric: tabular-nums; }
#panel-crystal .cr-verdict { font-size: 13px; color: var(--text-2); margin-top: 6px; }
#panel-crystal .cr-verdict-badge { display: inline-flex; max-width: 100%; }
#panel-crystal .cr-verdict-badge .badge { max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
@media (min-width: 640px) { #panel-crystal .cr-verdict-badge .badge { height: 26px; font-size: 13px; padding: 0 11px; } }
#panel-crystal .cr-radii { font-size: 17px; font-variant-numeric: tabular-nums; white-space: nowrap; }
@media (max-width: 640px) { #panel-crystal .cr-radii { font-size: 14.5px; } }
#panel-crystal .cr-hkl { font-family: var(--font-mono); font-size: 12.5px; white-space: nowrap; }
#panel-crystal .cr-muted { color: var(--text-3); font-size: 12.5px; }
`;

  function injectStyle() {
    if (document.getElementById("eccl-css-crystal")) return;
    const st = document.createElement("style");
    st.id = "eccl-css-crystal";
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  // ------------------------------------------------------------------ helpers

  const ui = () => ECCL.ui;
  const el = (...a) => ECCL.ui.el(...a);
  const num = (v) => (v === null || v === undefined || v === "" ? NaN : Number(v));
  const isNum = (v) => Number.isFinite(num(v));
  const fmt = (v, d = 4) => ui().fmt(v, d).replace(/^-(?=[\d.])/, "−"); // typographic minus
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const put = (node, ...kids) => node.replaceChildren(...kids.filter((k) => k !== null && k !== undefined && k !== false));
  const loading = () => el("div", { class: "cr-loading" }, ui().spinner(), el("span", null, "Computing…"));
  /** After a failed first run, stop the placeholders spinning (the form shows the error). */
  const settle = (root) => root.querySelectorAll(".cr-loading").forEach((n) => n.replaceChildren(el("span", null, "No result yet: see the error above.")));

  const SUP = { 0: "⁰", 1: "¹", 2: "²", 3: "³", 4: "⁴", 5: "⁵", 6: "⁶", 7: "⁷", 8: "⁸", 9: "⁹" };
  /** "Pb2+" -> "Pb²⁺", "I-" -> "I⁻". */
  function prettyIon(key) {
    const m = /^([A-Za-z]+)(\d*)([+-])$/.exec(String(key));
    if (!m) return String(key);
    return `${m[1]}${m[2].replace(/\d/g, (d) => SUP[d])}${m[3] === "+" ? "⁺" : "⁻"}`;
  }
  const ionLabel = (key, r) => `${prettyIon(key)}${ION_NAMES[key] ? ` (${ION_NAMES[key]})` : ""} · ${fmt(r, 3)} Å`;
  const hklText = (hkl) => (Array.isArray(hkl) ? `(${hkl.join(" ")})` : String(hkl ?? ""));
  const hklShort = (hkl) => (Array.isArray(hkl) && hkl.every((h) => Math.abs(h) < 10) ? `(${hkl.join("")})` : hklText(hkl));

  function verdictKind(verdict, t) {
    const v = String(verdict || "").toLowerCase();
    let k = !isNum(t) ? "neutral" : t < 0.71 ? "bad" : t < 0.8 ? "warn" : t <= 1.0 ? "ok" : "bad";
    if (k === "ok" && v.includes("octahedral factor out")) k = "warn";
    return k;
  }
  /** Zone name for t (badge text); the engine's full verdict string is shown alongside. */
  const verdictShort = (verdict, t) => {
    const z = !isNum(t) ? null : ZONES.find((zz) => t < zz.hi) || ZONES[ZONES.length - 1];
    return z ? z.name : String(verdict || "—");
  };

  function chartSlot(kind) {
    const host = el("div", null, loading());
    let chart = null;
    return { el: host, set(spec) { if (chart) chart.update(spec); else chart = ECCL.plot[kind](host, spec); } };
  }

  /** Live form card + results column that dims while pending. */
  function calculator(opts) {
    const U = ui();
    const results = el("div", { class: "cr-results cr-stack" }, opts.results);
    let dimTimer = 0, lastKey = null;
    const setBusy = (on) => {
      clearTimeout(dimTimer);
      if (on) dimTimer = setTimeout(() => results.classList.add("is-busy"), 150);
      else results.classList.remove("is-busy");
      results.setAttribute("aria-busy", on ? "true" : "false");
    };
    const form = U.form({
      fields: opts.fields, columns: opts.columns || 4, live: true, submitLabel: "Calculate", submitIcon: "play",
      onSubmit: async (values) => {
        lastKey = JSON.stringify(values);
        setBusy(true);
        try {
          const res = await opts.run(values);
          opts.show(res, values);
          return res;
        } catch (err) {
          settle(results);
          throw err;
        } finally { setBusy(false); }
      },
    });
    const submit = () => Promise.resolve(form.submit()).then(() => (JSON.stringify(form.getValues()) !== lastKey ? form.submit() : undefined));
    return { form, submit, card: U.card({ title: opts.title, subtitle: opts.subtitle }, form), results };
  }

  // ------------------------------------------------------------------ tolerance gauge (ui.svgEl)

  /** Horizontal 0.6-1.2 scale with coloured zones and a needle at t; redrawn at the real width. */
  function toleranceGauge() {
    const U = ui();
    const host = el("div", { class: "cr-gauge" });
    let t = null, lastW = 0;
    const draw = () => {
      const W = Math.floor(host.clientWidth);
      if (W <= 0) return;
      lastW = W;
      const H = 104, L = 14, R = W - 14, barY = 40, barH = 22;
      const sx = (v) => L + ((clamp(v, T_MIN, T_MAX) - T_MIN) / (T_MAX - T_MIN)) * (R - L);
      const has = isNum(t);
      const label = has ? `Tolerance factor ${fmt(t, 4)}: ${verdictShort("", t)}` : "Tolerance factor gauge";
      const svg = U.svgEl("svg", { viewBox: `0 0 ${W} ${H}`, height: H, role: "img", "aria-label": label });
      for (const z of ZONES) {
        const x0 = sx(z.lo), x1 = sx(z.hi);
        svg.appendChild(U.svgEl("rect", { x: x0, y: barY, width: Math.max(0, x1 - x0), height: barH, style: { fill: `var(--${z.kind}-soft)` } }));
        svg.appendChild(U.svgEl("rect", { x: x0, y: barY + barH - 4, width: Math.max(0, x1 - x0), height: 4, style: { fill: `var(--${z.kind})` } }));
        const w = x1 - x0 - 8;
        const text = z.name.length * 6.3 <= w ? z.name : z.short.length * 6.3 <= w ? z.short : null;
        if (text) svg.appendChild(U.svgEl("text", { x: (x0 + x1) / 2, y: barY + 13, "text-anchor": "middle", "font-size": 11, "font-weight": 600, style: { fill: `var(--${z.kind})` } }, text));
      }
      for (const b of [0.71, 0.8, 1.0]) {
        svg.appendChild(U.svgEl("line", { x1: sx(b), x2: sx(b), y1: barY, y2: barY + barH, "stroke-width": 2, style: { stroke: "var(--surface)" } }));
      }
      svg.appendChild(U.svgEl("rect", { x: L, y: barY, width: R - L, height: barH, rx: 3, fill: "none", style: { stroke: "var(--border-strong)" } }));
      for (let i = 0; i <= 6; i++) {
        const v = +(T_MIN + i * 0.1).toFixed(1);
        const x = sx(v);
        svg.appendChild(U.svgEl("line", { x1: x, x2: x, y1: barY + barH, y2: barY + barH + 5, style: { stroke: "var(--chart-axis)" } }));
        svg.appendChild(U.svgEl("text", { x, y: barY + barH + 18, "text-anchor": i === 0 ? "start" : i === 6 ? "end" : "middle", "font-size": 11, style: { fill: "var(--chart-text)" } }, v.toFixed(1)));
      }
      if (has) {
        const x = sx(t);
        const off = t < T_MIN ? "◀ " : t > T_MAX ? " ▶" : "";
        const txt = `${t < T_MIN ? off : ""}t = ${fmt(t, 4)}${t > T_MAX ? off : ""}`;
        const tw = txt.length * 7;
        const anchor = x - tw / 2 < 2 ? "start" : x + tw / 2 > W - 2 ? "end" : "middle";
        svg.appendChild(U.svgEl("line", { x1: x, x2: x, y1: barY - 9, y2: barY + barH + 4, "stroke-width": 2.5, "stroke-linecap": "round", style: { stroke: "var(--text)" } }));
        svg.appendChild(U.svgEl("path", { d: `M${x - 6},${barY - 15} L${x + 6},${barY - 15} L${x},${barY - 7} Z`, style: { fill: "var(--text)" } }));
        svg.appendChild(U.svgEl("text", { x: anchor === "start" ? Math.max(2, x - 6) : anchor === "end" ? Math.min(W - 2, x + 6) : x, y: barY - 20, "text-anchor": anchor, "font-size": 12.5, "font-weight": 650, style: { fill: "var(--text)" } }, txt));
      }
      host.replaceChildren(svg);
    };
    if (typeof ResizeObserver === "function") {
      new ResizeObserver((entries) => { const w = Math.floor(entries[entries.length - 1].contentRect.width); if (w > 0 && w !== lastW) draw(); }).observe(host);
    }
    const legend = el("div", { class: "cr-legend", "aria-hidden": "true" }, ZONES.map((z) => el("span", { class: "cr-legend-item" },
      el("span", { class: "cr-legend-key", style: { background: `var(--${z.kind}-soft)`, borderColor: `var(--${z.kind})` } }),
      el("span", null, z.name), el("span", { class: "cr-legend-range" }, z.range))));
    return { el: el("div", { class: "cr-stack" }, host, legend), set(v) { t = isNum(v) ? num(v) : null; draw(); } };
  }

  // ------------------------------------------------------------------ section: tolerance

  function toleranceSection() {
    const U = ui(), api = ECCL.api;
    const radii = (ECCL.info.libraries && ECCL.info.libraries.ionic_radii) || {};
    const presets = (ECCL.info.presets && ECCL.info.presets.perovskites) || [];
    const keys = Object.keys(radii);
    const cations = keys.filter((k) => /\+$/.test(k));
    const anions = keys.filter((k) => /-$/.test(k));
    if (!cations.length || !anions.length) return U.notice("The server did not report an ionic-radii table.", "warn");
    const opt = (k) => ({ value: k, label: ionLabel(k, radii[k]) });
    const first = presets.find((p) => p.name === "CsPbI3") || presets[0] || { a: cations[0], b: cations[0], x: anions[0] };
    const matchPreset = (v) => { const p = presets.find((pp) => pp.a === v.a_ion && pp.b === v.b_ion && pp.x === v.x_ion); return p ? p.name : CUSTOM; };

    const stats = U.grid(4, ["Tolerance factor t", "Octahedral factor μ", "Verdict", "Ionic radii"].map((label) => U.stat({ label, value: "—" })));
    stats.classList.add("cr-tiles");
    const gauge = toleranceGauge();
    const verdictLine = el("p", { class: "cr-verdict" });
    const cmpHost = el("div", null, loading());
    let calc = null;
    const syncPreset = () => { const f = calc.form.field("preset"); if (f) f.setValue(matchPreset(calc.form.getValues())); };

    calc = calculator({
      title: "A, B and X ions",
      subtitle: "t = (rA + rX) / (√2 (rB + rX)) for an ABX₃ perovskite; μ = rB / rX checks that the B cation fits its octahedron.",
      columns: 4,
      fields: [
        {
          name: "preset", label: "Preset", type: "select", value: first.name || CUSTOM,
          options: presets.map((p) => ({ value: p.name, label: p.name })).concat([{ value: CUSTOM, label: "Custom" }]),
          onChange: (v) => { const p = presets.find((pp) => pp.name === v); if (p) calc.form.setValues({ a_ion: p.a, b_ion: p.b, x_ion: p.x }); },
        },
        { name: "a_ion", label: "A-site cation", type: "select", value: first.a, options: cations.map(opt), onChange: syncPreset },
        { name: "b_ion", label: "B-site cation", type: "select", value: first.b, options: cations.map(opt), onChange: syncPreset },
        { name: "x_ion", label: "X-site anion", type: "select", value: first.x, options: anions.map(opt), onChange: syncPreset },
      ],
      results: [stats, U.card({ title: "Stability gauge", subtitle: "Where t falls on the empirical Goldschmidt scale" }, gauge.el, verdictLine)],
      run: (v) => api.post("/api/crystal/tolerance", { a_ion: v.a_ion, b_ion: v.b_ion, x_ion: v.x_ion }),
      show: (res) => {
        const t = num(res.t), mu = num(res.octahedral_mu);
        const kind = verdictKind(res.verdict, t);
        const muOk = mu >= 0.41 && mu <= 0.9;
        const r = res.radii || {};
        stats.replaceChildren(
          U.stat({ label: "Tolerance factor t", value: fmt(t, 4), kind, hint: "Ideal cubic ≈ 0.9 – 1.0" }),
          U.stat({ label: "Octahedral factor μ", value: fmt(mu, 4), kind: muOk ? "ok" : "warn", hint: muOk ? "Within 0.41 – 0.90" : "Outside 0.41 – 0.90" }),
          U.stat({
            label: "Verdict", value: el("span", { class: "cr-verdict-badge" }, U.badge(verdictShort(res.verdict, t), kind)),
            hint: !muOk ? "B cation too small or large for its BX₆ octahedron" : kind === "ok" ? "Cubic or tetragonal perovskite likely" : kind === "warn" ? "Tilted, lower-symmetry perovskite" : "Perovskite unlikely",
          }),
          U.stat({ label: "Ionic radii", value: el("span", { class: "cr-radii" }, `${fmt(r.a, 3)} / ${fmt(r.b, 3)} / ${fmt(r.x, 3)}`), hint: "rA / rB / rX in Å (Shannon)" }));
        gauge.set(t);
        verdictLine.textContent = `Engine verdict: ${res.verdict || "—"}`;
      },
    });

    // comparison of every preset
    Promise.all(presets.map((p) => api.post("/api/crystal/tolerance", { a_ion: p.a, b_ion: p.b, x_ion: p.x })
      .then((r) => ({ name: p.name, a: p.a, b: p.b, x: p.x, t: r.t, mu: r.octahedral_mu, verdict: r.verdict }))))
      .then((rows) => {
        cmpHost.replaceChildren(U.table({
          rows,
          onRowClick: (row) => { calc.form.setValues({ preset: row.name, a_ion: row.a, b_ion: row.b, x_ion: row.x }); calc.submit(); },
          columns: [
            { key: "name", label: "Compound", format: (v) => U.formula(v) },
            { key: "a", label: "A", format: prettyIon },
            { key: "b", label: "B", format: prettyIon },
            { key: "x", label: "X", format: prettyIon },
            { key: "t", label: "t", format: (v) => fmt(v, 4) },
            { key: "mu", label: "μ", format: (v) => fmt(v, 4) },
            { key: "verdict", label: "Verdict", sortValue: (row) => row.t, format: (v, row) => U.badge(verdictShort(v, num(row.t)), verdictKind(v, num(row.t))) },
          ],
        }));
      })
      .catch((err) => cmpHost.replaceChildren(U.errorBox(err)));

    calc.submit();
    return U.section("Perovskite tolerance",
      el("div", { class: "cr-stack" }, calc.card, calc.results,
        U.card({ title: "Preset comparison", subtitle: "All library perovskites. Click a row to load it above." }, cmpHost)));
  }

  // ------------------------------------------------------------------ section: XRD

  function xrdSection() {
    const U = ui(), api = ECCL.api;
    const presets = (ECCL.info.presets && ECCL.info.presets.crystals) || [];
    const structures = (ECCL.info.libraries && ECCL.info.libraries.structures) || ["diamond"];
    const first = presets.find((p) => /silicon/i.test(p.name)) || presets[0] || { name: CUSTOM, formula: "Si", a: 5.431, structure: "diamond", formula_units: 8 };
    const matchPreset = (v) => {
      const p = presets.find((pp) => pp.formula === v.formula && Math.abs(num(pp.a) - num(v.a)) < 1e-9 && pp.structure === v.structure && num(pp.formula_units) === num(v.formula_units));
      return p ? p.name : CUSTOM;
    };
    const matchLambda = (ang) => { const w = WAVELENGTHS.find((x) => x.ang !== null && Math.abs(x.ang - num(ang)) < 1e-9); return w ? w.value : "custom"; };

    const stats = U.grid(4, ["Density", "Reflections", "Strongest peak", "Cell volume"].map((label) => U.stat({ label, value: "—" })));
    stats.classList.add("cr-tiles");
    const pattern = chartSlot("lineChart");
    const sticks = chartSlot("stickChart");
    const note = el("div");
    const tableHost = el("div", null, loading());
    let calc = null;
    const seg = U.segmented({
      options: WAVELENGTHS.map((w) => ({ value: w.value, label: w.label })), value: "Cu", ariaLabel: "X-ray source",
      onChange: (val) => {
        const w = WAVELENGTHS.find((x) => x.value === val);
        const f = calc.form.field("wavelength_ang");
        if (w && w.ang !== null) { f.setValue(w.ang); f.setError(null); calc.submit(); } else f.input.focus();
      },
    });
    const syncPreset = () => { calc.form.field("preset").setValue(matchPreset(calc.form.getValues())); };
    const segNode = el("div", { class: "field cr-presets cr-span2" },
      el("div", { class: "field-head" }, el("span", { class: "field-label" }, "X-ray source")), seg);

    calc = calculator({
      title: "Crystal & X-ray source",
      subtitle: "Bragg reflections of a cubic lattice for the chosen structure type, with a simulated broadened pattern.",
      columns: 4,
      fields: [
        {
          name: "preset", label: "Crystal preset", type: "select", value: first.name,
          options: presets.map((p) => ({ value: p.name, label: `${p.name} (${p.structure})` })).concat([{ value: CUSTOM, label: "Custom" }]),
          onChange: (v) => {
            const p = presets.find((pp) => pp.name === v);
            if (p) calc.form.setValues({ formula: p.formula, a: p.a, structure: p.structure, formula_units: p.formula_units });
          },
        },
        { name: "formula", label: "Formula", type: "text", value: first.formula, required: true, placeholder: "e.g. GaAs", onChange: syncPreset },
        { name: "a", label: "Lattice constant a (Å)", type: "number", value: first.a, min: 0.5, max: 100, step: 0.001, required: true, onChange: syncPreset },
        { name: "structure", label: "Structure", type: "select", value: first.structure, options: structures, onChange: syncPreset },
        {
          name: "formula_units", label: "Formula units per cell Z", type: "number", value: first.formula_units, min: 1, max: 256, step: 1, required: true, onChange: syncPreset,
          validate: (v) => (v !== null && !Number.isInteger(v) ? "Whole number" : null),
        },
        segNode,
        {
          name: "wavelength_ang", label: "Wavelength λ (Å)", type: "number", value: 1.5406, min: 0.05, max: 10, step: 0.0001, required: true,
          onChange: (v) => seg.setValue(matchLambda(v)),
        },
      ],
      results: [
        stats,
        U.card({ title: "Diffraction pattern", subtitle: "Gaussian-broadened pattern (top) and the underlying reflections with their Miller indices (bottom)" },
          pattern.el, sticks.el, note),
        U.card({ title: "Reflections", subtitle: "Allowed {hkl} families below 2θ = 90°" }, tableHost),
      ],
      run: (v) => api.post("/api/crystal/xrd", { formula: v.formula, a: v.a, structure: v.structure, formula_units: v.formula_units, wavelength_ang: v.wavelength_ang, max_2theta: 90 }),
      show: (res, v) => {
        const refl = res.reflections || [];
        const strongest = refl.reduce((best, r) => (best === null || num(r.rel_intensity) > num(best.rel_intensity) ? r : best), null);
        const a = num(res.lattice_a ?? v.a);
        stats.replaceChildren(
          U.stat({ label: "Density", value: fmt(res.density_g_cm3, 4), unit: "g/cm³", hint: `${res.formula_units ?? v.formula_units} × ${res.formula || v.formula} per a³` }),
          U.stat({ label: "Reflections", value: refl.length, hint: `λ = ${fmt(res.wavelength_ang ?? v.wavelength_ang, 5)} Å, 2θ ≤ 90°` }),
          U.stat({
            label: "Strongest peak", value: strongest ? hklText(strongest.hkl) : "—",
            hint: strongest ? `2θ = ${fmt(strongest.two_theta, 4)}°, d = ${fmt(strongest.d_spacing, 4)} Å` : "No reflections in range",
          }),
          U.stat({ label: "Cell volume", value: isNum(a) ? fmt(a * a * a, 4) : "—", unit: "Å³", hint: `Cubic, a = ${fmt(a, 5)} Å` }));
        const pat = res.pattern || {};
        const xs = pat.two_theta || [];
        const domain = xs.length ? [num(xs[0]), num(xs[xs.length - 1])] : [5, 90];
        pattern.set({
          height: 270, xLabel: "2θ (°)", yLabel: "Intensity (a.u.)", xDomain: domain, yDomain: [0, 105],
          series: [{ name: res.formula || v.formula, x: xs, y: pat.intensity || [], area: true }],
          empty: "No reflections below 90°",
        });
        sticks.set({
          height: 230, xLabel: "2θ (°)", yLabel: "Relative intensity", xDomain: domain, yDomain: [0, 100],
          sticks: refl.map((r) => ({ x: r.two_theta, y: r.rel_intensity, label: hklShort(r.hkl) })),
          empty: "No reflections below 90°",
        });
        put(note, pat.note ? U.notice(pat.note, "neutral") : null);
        tableHost.replaceChildren(U.table({
          rows: refl, maxHeight: 360, empty: "No reflections below 2θ = 90° for this lattice and wavelength",
          columns: [
            { key: "hkl", label: "hkl", sortValue: (r) => num(r.two_theta), format: (h) => el("span", { class: "cr-hkl" }, hklText(h)) },
            { key: "two_theta", label: "2θ (°)", format: (x) => fmt(x, 5) },
            { key: "d_spacing", label: "d (Å)", format: (x) => fmt(x, 5) },
            { key: "multiplicity", label: "Multiplicity" },
            { key: "rel_intensity", label: "Rel. intensity", format: (x) => fmt(x, 3) },
          ],
        }));
      },
    });
    calc.submit();
    return U.section("Powder X-ray diffraction", el("div", { class: "cr-stack" }, calc.card, calc.results));
  }

  // ------------------------------------------------------------------ panel

  ECCL.registerPanel({
    id: "crystal",
    title: "Crystals",
    group: "Materials",
    icon: "grid",
    description: "Goldschmidt tolerance factor for perovskites and simulated powder XRD patterns.",
    order: 70,
    render(root) {
      injectStyle();
      root.append(
        el("p", { class: "cr-intro" }, "Two quick crystal-chemistry checks: whether an A, B, X ion combination can form a stable ABX₃ perovskite (Goldschmidt tolerance and octahedral factors), and what a cubic crystal's powder X-ray diffraction pattern looks like for a given lattice, structure type and X-ray source."),
        toleranceSection(),
        xrdSection());
    },
  });
})(window.ECCL);
