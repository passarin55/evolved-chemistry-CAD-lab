/* Quantum panel - four tight-binding / confinement calculators in tabs: graphene bands along
 * Γ-K-M-Γ, a 1-D tight-binding chain with its density of states, infinite quantum-well levels
 * and Brus-equation quantum-dot emission. Each tab auto-runs on first open and re-runs live.
 *
 * Endpoints: /api/quantum/{graphene,tb1d,well,qdot}.
 */
window.ECCL = window.ECCL || {};

(function (ECCL) {
  "use strict";

  const HBAR_EVS = 6.582119569e-16; // reduced Planck constant (eV s), for the Fermi velocity
  const A_CC_M = 1.42e-10; // graphene C-C bond length (m)
  const TABS = ["graphene", "chain", "well", "dot"];
  const MASS_PRESETS = [
    { value: "GaAs", label: "GaAs", m: 0.067 },
    { value: "InAs", label: "InAs", m: 0.023 },
    { value: "free", label: "Free e⁻", m: 1.0 },
    { value: "custom", label: "Custom", m: null },
  ];
  const STRIP_RADII = [1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5, 6];

  const CSS = `
#panel-quantum .qm-intro { color: var(--text-2); max-width: 90ch; }
#panel-quantum .qm-stack { display: flex; flex-direction: column; gap: var(--gap); min-width: 0; }
#panel-quantum .qm-stack > * + * { margin-top: 0; }
#panel-quantum .qm-results { transition: opacity 0.15s ease; }
#panel-quantum .qm-results.is-busy { opacity: 0.55; }
#panel-quantum .qm-tiles { --grid-min: 150px; }
#panel-quantum .qm-loading {
  display: flex; align-items: center; justify-content: center; gap: 8px; min-height: 120px;
  color: var(--text-3); font-size: 13px;
}
#panel-quantum .qm-presets .segmented { display: flex; width: 100%; }
#panel-quantum .qm-presets .seg { flex: 1 1 auto; justify-content: center; padding-left: 8px; padding-right: 8px; }
#panel-quantum .qm-swatch {
  display: inline-block; flex: none; width: 13px; height: 13px; border-radius: 4px;
  border: 1px solid var(--border-strong); vertical-align: -2px;
}
#panel-quantum .qm-cell { display: inline-flex; align-items: center; gap: 7px; white-space: nowrap; }
#panel-quantum .qm-big-swatch {
  height: 46px; margin-top: 10px; border-radius: var(--radius);
  border: 1px solid var(--border-strong); box-shadow: inset 0 0 0 3px rgba(255, 255, 255, 0.16);
}
#panel-quantum .qm-strip { display: grid; grid-template-columns: repeat(10, minmax(0, 1fr)); gap: 8px; }
@media (max-width: 720px) { #panel-quantum .qm-strip { grid-template-columns: repeat(5, minmax(0, 1fr)); } }
#panel-quantum .qm-chip {
  display: flex; flex-direction: column; align-items: stretch; gap: 4px; min-width: 0; padding: 6px;
  border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--surface);
  color: var(--text); font: inherit; cursor: pointer; text-align: center;
}
#panel-quantum .qm-chip:hover { border-color: var(--border-strong); background: var(--surface-2); }
#panel-quantum .qm-chip[aria-pressed="true"] { border-color: var(--accent); box-shadow: 0 0 0 2px var(--focus-ring); }
#panel-quantum .qm-chip-color { height: 34px; border-radius: 6px; border: 1px solid var(--border-strong); }
#panel-quantum .qm-chip-r { font-size: 12px; font-weight: 650; font-variant-numeric: tabular-nums; white-space: nowrap; }
#panel-quantum .qm-chip-nm { font-size: 11.5px; color: var(--text-3); font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#panel-quantum .qm-muted { color: var(--text-3); font-size: 12.5px; }
`;

  function injectStyle() {
    if (document.getElementById("eccl-css-quantum")) return;
    const st = document.createElement("style");
    st.id = "eccl-css-quantum";
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  // ------------------------------------------------------------------ helpers

  const ui = () => ECCL.ui;
  const el = (...a) => ECCL.ui.el(...a);
  const num = (v) => (v === null || v === undefined || v === "" ? NaN : Number(v));
  const isNum = (v) => Number.isFinite(num(v));
  const fmt = (v, d = 4) => ui().fmt(v, d).replace(/^-(?=[\d.])/, "−"); // typographic minus
  const loading = () => el("div", { class: "qm-loading" }, ui().spinner(), el("span", null, "Computing…"));
  /** After a failed first run, stop the placeholders spinning (the form shows the error). */
  const settle = (root) => root.querySelectorAll(".qm-loading").forEach((n) => n.replaceChildren(el("span", null, "No result yet: see the error above.")));

  function bandName(nm) {
    const w = num(nm);
    if (!Number.isFinite(w)) return "";
    if (w < 380) return "ultraviolet";
    if (w < 450) return "violet";
    if (w < 495) return "blue";
    if (w < 570) return "green";
    if (w < 590) return "yellow";
    if (w < 620) return "orange";
    if (w <= 750) return "red";
    if (w <= 1400) return "near infrared";
    return "infrared";
  }

  const swatch = (nm) => el("span", { class: "qm-swatch", "aria-hidden": "true", style: { background: ui().wavelengthToColor(nm) }, title: bandName(nm) });

  function chartSlot(kind) {
    const host = el("div", null, loading());
    let chart = null;
    return {
      el: host,
      set(spec) { if (chart) chart.update(spec); else chart = ECCL.plot[kind](host, spec); },
    };
  }

  function statGrid(labels) {
    const g = ui().grid(4, labels.map((label) => ui().stat({ label, value: "—" })));
    g.classList.add("qm-tiles");
    return g;
  }

  /** Linear interpolation of ys at x over ascending xs (null outside). */
  function interp(xs, ys, x) {
    for (let i = 1; i < xs.length; i++) {
      const x0 = num(xs[i - 1]), x1 = num(xs[i]);
      if (!(x >= x0 && x <= x1)) continue;
      const y0 = num(ys[i - 1]), y1 = num(ys[i]);
      if (!Number.isFinite(y0) || !Number.isFinite(y1)) return null;
      return x1 === x0 ? y0 : y0 + ((x - x0) / (x1 - x0)) * (y1 - y0);
    }
    return null;
  }

  /**
   * A calculator: live form card above a results column that dims while a run is pending.
   * run(values) -> Promise<result>; show(result, values) paints. Returns {root, form, submit}.
   */
  function calculator(opts) {
    const U = ui();
    const results = el("div", { class: "qm-results qm-stack" }, opts.results);
    let dimTimer = 0, lastKey = null;
    const setBusy = (on) => {
      clearTimeout(dimTimer);
      if (on) dimTimer = setTimeout(() => results.classList.add("is-busy"), 150);
      else results.classList.remove("is-busy");
      results.setAttribute("aria-busy", on ? "true" : "false");
    };
    const form = U.form({
      fields: opts.fields, columns: opts.columns || 3, live: true, submitLabel: "Calculate", submitIcon: "play",
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
    /** Submit, and once more if values changed while a run was in flight (programmatic edits). */
    const submit = () => Promise.resolve(form.submit()).then(() => (JSON.stringify(form.getValues()) !== lastKey ? form.submit() : undefined));
    const card = U.card({ title: opts.title, subtitle: opts.subtitle }, form);
    return { root: el("div", { class: "qm-stack" }, card, results), form, submit };
  }

  /** Label + segmented presets as a form-grid node, wired to a numeric field of the form. */
  function presetNode(label, help, seg) {
    return el("div", { class: "field qm-presets" },
      el("div", { class: "field-head" }, el("span", { class: "field-label" }, label)), seg,
      help ? el("div", { class: "field-help" }, help) : null);
  }

  // ------------------------------------------------------------------ tab: graphene

  function grapheneTab() {
    const U = ui(), api = ECCL.api;
    const stats = statGrid(["Band character", "Minimum direct gap", "π-band width", "Fermi velocity"]);
    const chart = chartSlot("lineChart");
    const chartCard = U.card({ title: "Band structure", subtitle: "Nearest-neighbour tight binding, E(k) = ±t|f(k)|. The π and π* bands touch at K: the Dirac point." }, chart.el);
    let ticks = [];
    const xFormat = (i) => {
      for (let j = 1; j < ticks.length; j++) {
        const a = ticks[j - 1], b = ticks[j];
        if (i >= a.x && i <= b.x) return `${a.label} → ${b.label} · ${Math.round((100 * (i - a.x)) / Math.max(1, b.x - a.x))} %`;
      }
      return `k-point ${i}`;
    };
    const calc = calculator({
      title: "Graphene π bands",
      subtitle: "Honeycomb lattice with one pz orbital per carbon; slide the hopping energy t.",
      columns: 1,
      fields: [{ name: "hopping", label: "Hopping energy t", type: "range", value: 2.7, min: 1, max: 4, step: 0.05, unit: "eV", help: "≈ 2.7 eV for graphene (the band runs from −3t to +3t)" }],
      results: [stats, chartCard],
      run: (v) => api.post("/api/quantum/graphene", { hopping: v.hopping, points: 120 }),
      show: (res, v) => {
        const gap = num(res.min_direct_gap);
        const dirac = !!res.is_dirac_semimetal;
        const all = (res.upper || []).concat(res.lower || []).map(num).filter(Number.isFinite);
        const width = all.length ? Math.max(...all) - Math.min(...all) : null;
        const vF = (3 * num(v.hopping) * A_CC_M) / (2 * HBAR_EVS);
        stats.replaceChildren(
          U.stat({
            label: "Band character", value: U.badge(dirac ? "Dirac semimetal" : "Gapped", dirac ? "ok" : "warn"),
            hint: dirac ? "Gapless, linear cones at K" : "A gap opened at K",
          }),
          U.stat({
            label: "Minimum direct gap", value: Math.abs(gap) < 1e-6 ? "≈ 0" : fmt(gap, 3), unit: "eV",
            hint: Math.abs(gap) < 1e-6 ? `Numerically ${ui().fmtSci(gap, 2)} eV` : "Smallest E₊ − E₋ on the path",
          }),
          U.stat({ label: "π-band width", value: fmt(width, 4), unit: "eV", hint: "6t, from Γ (−3t) to Γ (+3t)" }),
          U.stat({ label: "Fermi velocity", value: fmt(vF / 1e6, 3), unit: "× 10⁶ m/s", hint: "vF = 3ta / 2ħ, a = 1.42 Å" }));
        const k = res.k_index || [];
        ticks = (res.ticks || []).map((t) => ({ x: num(t.index), label: /^(g|gamma)$/i.test(String(t.label)) ? "Γ" : String(t.label) }));
        const kPoint = ticks.find((t) => t.label === "K");
        chart.set({
          height: 330, xLabel: "Wave vector along Γ–K–M–Γ", yLabel: "Energy (eV)", xTicks: ticks, xFormat,
          series: [{ name: "π* (conduction)", x: k, y: res.upper || [] }, { name: "π (valence)", x: k, y: res.lower || [] }],
          hMarkers: [{ y: 0, label: "Fermi level EF = 0" }],
          points: kPoint ? [{ x: kPoint.x, y: 0, label: "Dirac point" }] : [],
        });
      },
    });
    calc.submit();
    return calc.root;
  }

  // ------------------------------------------------------------------ tab: 1-D chain

  function chainTab() {
    const U = ui(), api = ECCL.api;
    const stats = statGrid(["Bandwidth", "Band bottom", "Band top", "Band centre"]);
    const band = chartSlot("lineChart");
    const dos = chartSlot("lineChart");
    const PI = Math.PI;
    const kTicks = [{ x: -PI, label: "−π/a" }, { x: -PI / 2, label: "−π/2a" }, { x: 0, label: "0" }, { x: PI / 2, label: "π/2a" }, { x: PI, label: "π/a" }];
    const calc = calculator({
      title: "1-D tight-binding chain",
      subtitle: "One orbital per site: E(k) = ε₀ − 2t cos(ka). The density of states piles up at the band edges (van Hove singularities).",
      columns: 2,
      fields: [
        { name: "onsite", label: "On-site energy ε₀ (eV)", type: "number", value: 0, min: -100, max: 100, step: 0.1, required: true },
        { name: "hopping", label: "Hopping t (eV)", type: "number", value: 1, min: -100, max: 100, step: 0.1, required: true, help: "Negative t flips the band" },
      ],
      results: [stats, U.grid(2,
        U.card({ title: "Dispersion E(k)", subtitle: "First Brillouin zone" }, band.el),
        U.card({ title: "Density of states", subtitle: "Histogram of a dense k sampling" }, dos.el))],
      run: (v) => api.post("/api/quantum/tb1d", { onsite: v.onsite, hopping: v.hopping, points: 201 }),
      show: (res, v) => {
        stats.replaceChildren(
          U.stat({ label: "Bandwidth", value: fmt(res.bandwidth, 4), unit: "eV", hint: "4|t|" }),
          U.stat({ label: "Band bottom", value: fmt(res.e_min, 4), unit: "eV" }),
          U.stat({ label: "Band top", value: fmt(res.e_max, 4), unit: "eV" }),
          U.stat({ label: "Band centre", value: fmt(v.onsite, 4), unit: "eV", hint: "ε₀" }));
        band.set({
          height: 280, xLabel: "Wave vector k", yLabel: "Energy (eV)", xTicks: kTicks,
          xFormat: (k) => `k = ${fmt(k / PI, 3)} π/a`,
          series: [{ name: "E(k)", x: res.k || [], y: res.energy || [] }],
          hMarkers: [{ y: num(v.onsite), label: "ε₀" }],
        });
        const d = res.dos || {};
        const edges = num(res.bandwidth) > 0 ? [{ x: num(res.e_min), label: "band bottom" }, { x: num(res.e_max), label: "band top" }] : [];
        dos.set({
          height: 280, xLabel: "Energy (eV)", yLabel: "DOS (states per bin)",
          series: [{ name: "DOS", x: d.energy || [], y: d.dos || [], area: true, color: 3 }],
          markers: edges,
        });
      },
    });
    calc.submit();
    return calc.root;
  }

  // ------------------------------------------------------------------ tab: quantum well

  function wellTab() {
    const U = ui(), api = ECCL.api;
    const stats = statGrid(["Ground state E₁", "E₁ → E₂ transition", "Its wavelength", "Levels"]);
    const diagram = chartSlot("levelDiagram");
    const tableHost = el("div", null, loading());
    const matchMass = (m) => { const hit = MASS_PRESETS.find((p) => p.m !== null && Math.abs(p.m - num(m)) < 1e-9); return hit ? hit.value : "custom"; };
    let calc = null;
    const seg = U.segmented({
      options: MASS_PRESETS.map((p) => ({ value: p.value, label: p.label })), value: "GaAs", ariaLabel: "Effective-mass presets",
      onChange: (val) => {
        const p = MASS_PRESETS.find((x) => x.value === val);
        const f = calc.form.field("m_eff");
        if (p && p.m !== null) { f.setValue(p.m); f.setError(null); calc.submit(); } else f.input.focus();
      },
    });
    calc = calculator({
      title: "Infinite quantum well",
      subtitle: "Particle in a box: Eₙ = n²π²ħ² / (2m*L²). Narrower wells and lighter carriers push the levels up.",
      columns: 3,
      fields: [
        presetNode("Material preset", "Electron effective mass in units of mₑ", seg),
        { name: "m_eff", label: "Effective mass m*/mₑ", type: "number", value: 0.067, min: 0.001, max: 100, step: 0.001, required: true, onChange: (v) => seg.setValue(matchMass(v)) },
        { name: "n_levels", label: "Number of levels", type: "number", value: 5, min: 1, max: 20, step: 1, required: true, validate: (v) => (v !== null && !Number.isInteger(v) ? "Whole number" : null) },
        { name: "width_nm", label: "Well width L", type: "range", value: 5, min: 1, max: 20, step: 0.1, unit: "nm", span: "full" },
      ],
      results: [stats, U.grid(2,
        U.card({ title: "Energy levels", subtitle: "Measured from the bottom of the well" }, diagram.el),
        U.card({ title: "Intersubband transitions", subtitle: "Photon energy and wavelength for every pair of levels" }, tableHost))],
      run: (v) => api.post("/api/quantum/well", { width_nm: v.width_nm, m_eff: v.m_eff, n_levels: v.n_levels }),
      show: (res) => {
        const lv = res.levels_ev || [];
        const tr = res.transitions || [];
        const t12 = tr.find((t) => t.from === 1 && t.to === 2);
        stats.replaceChildren(
          U.stat({ label: "Ground state E₁", value: fmt(res.confinement_ev, 4), unit: "eV", hint: `${fmt(num(res.confinement_ev) * 1000, 4)} meV confinement energy` }),
          U.stat({ label: "E₁ → E₂ transition", value: t12 ? fmt(t12.energy_ev, 4) : "—", unit: "eV", hint: "3 E₁" }),
          U.stat({
            label: "Its wavelength", unit: "nm",
            value: t12 ? el("span", { class: "qm-cell" }, swatch(t12.wavelength_nm), fmt(t12.wavelength_nm, 4)) : "—",
            hint: t12 ? `${bandName(t12.wavelength_nm)}` : "Needs two levels",
          }),
          U.stat({ label: "Levels", value: lv.length, hint: `Top level ${fmt(lv[lv.length - 1], 4)} eV` }));
        diagram.set({
          height: Math.max(300, Math.min(520, 26 * lv.length + 120)), yLabel: "Energy (eV)",
          levels: lv.map((e, i) => ({ e, label: `n = ${i + 1}` })),
        });
        tableHost.replaceChildren(U.table({
          rows: tr, maxHeight: 360, empty: "Add a second level to see transitions",
          columns: [
            { key: "from", label: "Transition", align: "left", sortValue: (r) => r.from * 100 + r.to, format: (x, r) => `${r.from} → ${r.to}` },
            { key: "energy_ev", label: "ΔE (eV)", format: (x) => fmt(x, 4) },
            {
              key: "wavelength_nm", label: "λ (nm)", align: "right",
              format: (x) => el("span", { class: "qm-cell" }, swatch(x), fmt(x, 4)),
            },
            { key: "region", label: "Region", sortValue: (r) => r.wavelength_nm, format: (x, r) => bandName(r.wavelength_nm) },
          ],
        }));
      },
    });
    calc.submit();
    return calc.root;
  }

  // ------------------------------------------------------------------ tab: quantum dot

  function dotTab() {
    const U = ui(), api = ECCL.api;
    const semis = (ECCL.info.libraries && ECCL.info.libraries.semiconductors) || [];
    if (!semis.length) return U.notice("The server did not report any semiconductors.", "warn");
    const names = semis.map((s) => s.name);
    const stats = statGrid(["Confined gap", "Confinement shift", "Coulomb term", "Emission"]);
    const gapChart = chartSlot("lineChart");
    const emChart = chartSlot("lineChart");
    const strip = el("div", { class: "qm-strip", role: "group", "aria-label": "Emission colour by radius" });
    let calc = null;
    const calcRef = () => calc;
    calc = calculator({
      title: "Quantum dot (Brus model)",
      subtitle: "A spherical nanocrystal: confinement widens the gap as 1/R², the electron–hole Coulomb attraction narrows it as 1/R.",
      columns: 2,
      fields: [
        {
          name: "semiconductor", label: "Semiconductor", type: "select", value: names.includes("CdTe") ? "CdTe" : names[0],
          options: semis.map((s) => ({ value: s.name, label: `${s.name}${s.label && s.label !== s.name ? ` (${s.label})` : ""} · Eg ${fmt(s.eg_300k, 3)} eV` })),
        },
        { name: "radius_nm", label: "Dot radius R", type: "range", value: 2.5, min: 1, max: 8, step: 0.05, unit: "nm" },
      ],
      results: [
        stats,
        U.grid(2,
          U.card({ title: "Gap vs radius", subtitle: "Confined gap approaches the bulk value for large dots" }, gapChart.el),
          U.card({ title: "Emission vs radius", subtitle: "Band-edge emission wavelength, hc / E_gap" }, emChart.el)),
        U.card({ title: "Size-to-colour strip", subtitle: "Emission colour for radii 1.5–6 nm; grey is outside the visible range. Click a swatch to use that radius." }, strip),
      ],
      run: (v) => api.post("/api/quantum/qdot", { semiconductor: v.semiconductor, radius_nm: v.radius_nm, r_min: 1, r_max: 8, points: 141 }),
      show: (res, v) => {
        const s = res.single || {};
        const nm = num(s.emission_nm);
        const r = num(v.radius_nm);
        const bulkNm = isNum(res.bulk_gap_ev) ? 1239.84198 / num(res.bulk_gap_ev) : null;
        const emission = U.stat({ label: "Emission", value: fmt(nm, 4), unit: "nm", hint: `${bandName(nm)}${bulkNm ? ` · bulk ${fmt(bulkNm, 4)} nm` : ""}` });
        emission.appendChild(el("div", { class: "qm-big-swatch", style: { background: U.wavelengthToColor(nm) }, role: "img", "aria-label": `Emission colour: ${bandName(nm)}` }));
        stats.replaceChildren(
          U.stat({ label: "Confined gap", value: fmt(s.confined_gap_ev, 4), unit: "eV", hint: `Bulk ${fmt(res.bulk_gap_ev, 3)} eV` }),
          U.stat({ label: "Confinement shift", value: `+${fmt(s.confinement_shift_ev, 4)}`, unit: "eV", hint: "ħ²π²/2R² (1/mₑ + 1/mₕ)" }),
          U.stat({ label: "Coulomb term", value: `−${fmt(s.coulomb_ev, 4)}`, unit: "eV", hint: "1.8 e² / 4πεR" }),
          emission);
        const c = res.curve || {};
        const rr = c.radius_nm || [];
        const marker = [{ x: r, label: `R = ${fmt(r, 3)} nm` }];
        gapChart.set({
          height: 270, xLabel: "Radius (nm)", yLabel: "Band gap (eV)",
          series: [{ name: "Confined gap", x: rr, y: c.gap_ev || [] }],
          hMarkers: isNum(res.bulk_gap_ev) ? [{ y: num(res.bulk_gap_ev), label: `bulk Eg = ${fmt(res.bulk_gap_ev, 3)} eV` }] : [],
          markers: marker, points: isNum(s.confined_gap_ev) ? [{ x: r, y: num(s.confined_gap_ev) }] : [],
        });
        emChart.set({
          height: 270, xLabel: "Radius (nm)", yLabel: "Emission wavelength (nm)",
          series: [{ name: "Emission", x: rr, y: c.emission_nm || [], color: 2 }],
          markers: marker, points: isNum(nm) ? [{ x: r, y: nm }] : [],
        });
        const nearest = STRIP_RADII.reduce((best, x) => (Math.abs(x - r) < Math.abs(best - r) ? x : best), STRIP_RADII[0]);
        strip.replaceChildren(...STRIP_RADII.map((radius) => {
          const w = interp(rr, c.emission_nm || [], radius);
          return el("button", {
            type: "button", class: "qm-chip", "aria-pressed": radius === nearest && Math.abs(radius - r) < 0.26 ? "true" : "false",
            title: w === null ? `R = ${radius} nm` : `R = ${radius} nm: ${fmt(w, 4)} nm (${bandName(w)})`,
            on: { click: () => { calcRef().form.setValues({ radius_nm: radius }); calcRef().submit(); } },
          },
          el("span", { class: "qm-chip-color", style: { background: U.wavelengthToColor(w) }, "aria-hidden": "true" }),
          el("span", { class: "qm-chip-r" }, `${radius} nm`),
          el("span", { class: "qm-chip-nm" }, w === null ? "—" : `${fmt(w, 3)} nm`));
        }));
      },
    });
    calc.submit();
    return calc.root;
  }

  // ------------------------------------------------------------------ panel

  let tabsEl = null;

  ECCL.registerPanel({
    id: "quantum",
    title: "Quantum",
    group: "Materials",
    icon: "wave",
    description: "Tight-binding bands, graphene Dirac cones, quantum-well levels and quantum-dot emission.",
    order: 60,
    render(root, ctx) {
      injectStyle();
      const U = ui();
      const initial = ctx && ctx.params && TABS.includes(ctx.params.tab) ? ctx.params.tab : "graphene";
      tabsEl = U.tabs([
        { id: "graphene", label: "Graphene", icon: "grid", render: grapheneTab },
        { id: "chain", label: "1D chain", icon: "activity", render: chainTab },
        { id: "well", label: "Quantum well", icon: "list", render: wellTab },
        { id: "dot", label: "Quantum dot", icon: "sparkle", render: dotTab },
      ], { initial, ariaLabel: "Quantum calculators" });
      root.append(
        el("p", { class: "qm-intro" }, "Small quantum models of electrons in materials: band structures from tight binding (graphene and a 1-D chain), discrete levels in a quantum well, and the size-tunable colour of quantum dots. Every calculator updates as you change its inputs."),
        tabsEl);
    },
    onShow(params) {
      if (tabsEl && params && TABS.includes(params.tab)) tabsEl.select(params.tab);
    },
  });
})(window.ECCL);
