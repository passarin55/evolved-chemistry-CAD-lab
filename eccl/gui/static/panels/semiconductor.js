/* Semiconductor lab panel - band gap vs temperature, carriers and doping, pn junctions,
 * Shockley-Queisser screening and a library comparison.
 *
 * Endpoints: /api/semiconductor/analyze (live, debounced), /api/semiconductor/curves
 * (per material) and /api/semiconductor/compare (per temperature).
 */
window.ECCL = window.ECCL || {};

(function (ECCL) {
  "use strict";

  const T_MIN = 50, T_MAX = 800, T_DEFAULT = 300;
  const DOPING_MAX = 1e24;
  const CURVE_POINTS = 151;
  let panelApi = null; // set by render(); used by onShow to honour ?material=

  const DOPING_PRESETS = [
    { label: "Intrinsic", title: "No dopants", values: { n_donor: null, n_acceptor: null } },
    { label: "n-type", title: "Donors 1e17 cm⁻³", values: { n_donor: 1e17, n_acceptor: null } },
    { label: "p-type", title: "Acceptors 1e17 cm⁻³", values: { n_donor: null, n_acceptor: 1e17 } },
    { label: "pn junction", title: "Donors 1e17, acceptors 1e16 cm⁻³", values: { n_donor: 1e17, n_acceptor: 1e16 } },
  ];

  // ------------------------------------------------------------------ small helpers

  const ui = () => ECCL.ui;
  const el = (...a) => ECCL.ui.el(...a);
  const num = (v) => (v === null || v === undefined || v === "" ? NaN : Number(v));
  const isNum = (v) => Number.isFinite(num(v));
  const cap = (s) => { const t = String(s || ""); return t ? t[0].toUpperCase() + t.slice(1) : t; };
  const sci = (v, d = 3) => ui().fmtSci(v, d);
  const fmt = (v, d = 3) => ui().fmt(v, d);

  /** Name of the spectral region a wavelength (nm) falls in. */
  function spectralRegion(nm) {
    const w = num(nm);
    if (!Number.isFinite(w)) return "unknown";
    if (w < 380) return "ultraviolet";
    if (w < 450) return "violet";
    if (w < 495) return "blue";
    if (w < 570) return "green";
    if (w < 590) return "yellow";
    if (w < 620) return "orange";
    if (w <= 780) return "red";
    if (w <= 1400) return "near-infrared";
    if (w <= 3000) return "short-wave infrared";
    return "infrared";
  }

  /** Small colour chip for a wavelength (gray outside the visible band). */
  function swatch(nm) {
    return el("span", {
      "aria-hidden": "true",
      style: {
        display: "inline-block", width: "14px", height: "14px", flex: "none", borderRadius: "4px",
        background: ui().wavelengthToColor(nm), border: "1px solid var(--border-strong)",
      },
    });
  }

  const inline = (...kids) => el("span", { style: { display: "inline-flex", alignItems: "center", gap: "8px" } }, ...kids);
  const textValue = (t) => el("span", { style: { fontSize: "16px", lineHeight: "1.35", overflowWrap: "normal" } }, t);
  const muted = (t) => el("span", { style: { color: "var(--text-3)", fontSize: "12.5px" } }, t);

  /** Linear interpolation on sorted xs (optionally in log space for positive ys). */
  function interp(xs, ys, x, log = false) {
    let best = null;
    for (let i = 1; i < xs.length; i++) {
      const x0 = num(xs[i - 1]), x1 = num(xs[i]);
      if (!(x >= Math.min(x0, x1) && x <= Math.max(x0, x1))) continue;
      let y0 = num(ys[i - 1]), y1 = num(ys[i]);
      if (!Number.isFinite(y0) || !Number.isFinite(y1)) continue;
      if (log) { if (y0 <= 0 || y1 <= 0) continue; y0 = Math.log10(y0); y1 = Math.log10(y1); }
      const f = x1 === x0 ? 0 : (x - x0) / (x1 - x0);
      best = y0 + f * (y1 - y0);
      break;
    }
    if (best === null) return null;
    return log ? Math.pow(10, best) : best;
  }

  /** Re-submit a form, and once more if the values changed while a run was in flight. */
  function resubmit(form, st) {
    return Promise.resolve(form.submit()).then(() => {
      if (JSON.stringify(form.getValues()) !== st.lastKey) return form.submit();
      return undefined;
    });
  }

  // ------------------------------------------------------------------ panel

  function render(root, ctx) {
    const U = ECCL.ui, P = ECCL.plot, api = ECCL.api;
    const libs = (ECCL.info && ECCL.info.libraries && ECCL.info.libraries.semiconductors) || [];
    if (!libs.length) {
      root.appendChild(U.card({ title: "Semiconductor lab" }, U.notice("The server did not report a semiconductor library.", "warn")));
      return;
    }
    const byName = new Map(libs.map((s) => [s.name, s]));
    const labelOf = (name) => (byName.get(name) ? byName.get(name).label || name : name);
    const pick = (p) => {
      const want = p && (p.material || p.name);
      if (!want) return null;
      if (byName.has(want)) return want;
      const hit = libs.find((s) => s.label === want || String(s.name).toLowerCase() === String(want).toLowerCase());
      return hit ? hit.name : null;
    };
    const initial = pick(ctx && ctx.params) || (byName.has("Si") ? "Si" : libs[0].name);

    const st = {
      lastKey: null, name: initial, T: T_DEFAULT, nd: 0, na: 0,
      curves: null, curvesFor: null, compare: null, compareT: null, res: null, dimTimer: 0,
    };

    // ---------------------------------------------------------------- controls
    let form = null;
    form = U.form({
      columns: 4,
      live: true,
      submitLabel: "Analyze",
      submitIcon: "play",
      fields: [
        {
          name: "name", label: "Material", type: "select", value: initial,
          options: libs.map((s) => ({ value: s.name, label: `${s.label || s.name} · ${fmt(s.eg_300k)} eV` })),
        },
        {
          name: "temperature_k", label: "Temperature", type: "range", min: T_MIN, max: T_MAX, step: 5, value: T_DEFAULT,
          format: (v) => `${Math.round(v)} K`, onChange: (v) => previewTemperature(v),
        },
        {
          name: "n_donor", label: "Donor density (cm⁻³)", type: "sci", value: 1e17, min: 0, max: DOPING_MAX,
          placeholder: "0 = none, e.g. 1e17", help: "Nd: n-type dopants",
        },
        {
          name: "n_acceptor", label: "Acceptor density (cm⁻³)", type: "sci", value: 1e16, min: 0, max: DOPING_MAX,
          placeholder: "0 = none, e.g. 1e16", help: "Na: p-type dopants",
        },
      ],
      onSubmit: (values) => analyze(values),
    });

    const formGrid = form.querySelector(".form-grid");
    if (formGrid) formGrid.style.setProperty("--grid-min", "140px"); // two inputs per row on phones
    const presetBar = el("div", { style: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: "6px" } },
      el("span", { style: { fontSize: "12.5px", color: "var(--text-3)", marginRight: "2px" } }, "Doping"),
      DOPING_PRESETS.map((p) => U.button(p.label, {
        small: true, kind: "secondary", title: p.title,
        onClick: () => { form.setValues(p.values); return resubmit(form, st); },
      })));

    const controls = U.card({
      title: "Material & conditions",
      subtitle: "Pick a semiconductor, set temperature and doping; the analysis re-runs as you edit.",
      actions: presetBar,
    }, form);

    // ---------------------------------------------------------------- results skeleton
    const statsEl = U.grid(3);
    statsEl.style.setProperty("--grid-min", "150px");
    const placeholderStats = () => ["Band gap", "Absorption edge", "Intrinsic carriers nᵢ", "Shockley–Queisser limit",
      "Classification", "Band gap type"].map((label) => U.stat({ label, value: "—" }));
    statsEl.append(...placeholderStats());

    const carriersBody = el("div", null, U.spinner("Loading"));
    const pnBody = el("div", null, U.spinner("Loading"));
    const paramsBody = el("div", null, U.spinner("Loading"));
    const carriersCard = U.card({ title: "Carriers", subtitle: "Full ionisation and charge neutrality (n − p = Nd − Na)" }, carriersBody);
    const pnCard = U.card({ title: "pn junction", subtitle: "Abrupt junction: Nd on the n side, Na on the p side" }, pnBody);
    const paramsCard = U.card({ title: "Material parameters", subtitle: "Library values used by the models" }, paramsBody);

    const egHost = el("div"), niHost = el("div"), sqHost = el("div"), barHost = el("div");
    const egCard = U.card({ title: "Band gap vs temperature", subtitle: "Varshni relation Eg(T) = Eg(0) − αT²/(T + β)" }, egHost);
    const niCard = U.card({ title: "Intrinsic carrier density vs temperature", subtitle: "nᵢ = √(Nc·Nv)·exp(−Eg / 2kT); the material turns intrinsic where nᵢ reaches the doping level" }, niHost);
    const sqCard = U.card({ title: "Shockley–Queisser efficiency vs band gap", subtitle: "Single-junction limit (analytic fit); marker = selected material at T" }, sqHost);
    const barCard = U.card({ title: "Band gaps across the library", subtitle: "At the chosen temperature; the highlighted bar is the selected material" }, barHost);

    const compareTitle = el("span", null, "Library comparison");
    const compareCard = U.card({ title: compareTitle, subtitle: "Every library material at the chosen temperature. Click a row to analyse that material." });

    const results = el("div", { style: { display: "flex", flexDirection: "column", gap: "var(--gap)", transition: "opacity 0.15s ease" } },
      statsEl,
      U.grid(3, carriersCard, pnCard, paramsCard),
      U.grid(2, egCard, niCard),
      U.grid(2, sqCard, barCard),
      compareCard);

    root.append(controls, results);

    const chartBase = { height: 260, empty: "Loading…" };
    const egChart = P.lineChart(egHost, { ...chartBase, series: [], xLabel: "Temperature (K)", yLabel: "Band gap (eV)" });
    const niChart = P.lineChart(niHost, { ...chartBase, series: [], logY: true, xLabel: "Temperature (K)", yLabel: "nᵢ (cm⁻³)" });
    const sqChart = P.lineChart(sqHost, { ...chartBase, series: [], xLabel: "Band gap (eV)", yLabel: "SQ efficiency (%)" });
    const barChart = P.barChart(barHost, { ...chartBase, bars: [], yLabel: "Band gap (eV)", format: (v) => fmt(v, 3) });

    const compareTable = U.table({
      columns: [
        {
          key: "label", label: "Material",
          format: (v, r) => inline(el("span", { style: { fontWeight: r.name === st.name ? "650" : null } }, v || r.name),
            r.name === st.name ? U.badge("selected", "info") : null),
        },
        { key: "bandgap_ev", label: "Eg (eV)", format: (v) => fmt(v, 4) },
        { key: "direct_gap", label: "Gap", format: (v) => (v ? "direct" : "indirect") },
        { key: "absorption_edge_nm", label: "Edge (nm)", format: (v) => (isNum(v) ? inline(swatch(v), fmt(v, 4)) : "—") },
        { key: "ni_cm3", label: "nᵢ (cm⁻³)", format: (v) => sci(v, 3) },
        { key: "sq_efficiency_pct", label: "SQ limit (%)", format: (v) => fmt(v, 3) },
        { key: "classification", label: "Class", format: (v) => cap(v) },
      ],
      rows: [],
      empty: "Loading…",
      onRowClick: (row) => selectMaterial(row.name),
    });
    compareCard.appendChild(compareTable);

    // ---------------------------------------------------------------- behaviour

    function setDim(on) {
      clearTimeout(st.dimTimer);
      if (on) st.dimTimer = setTimeout(() => { results.style.opacity = "0.55"; }, 150);
      else results.style.opacity = st.stale ? "0.45" : "";
      results.setAttribute("aria-busy", on ? "true" : "false");
    }

    async function analyze(values) {
      st.lastKey = JSON.stringify(values);
      const name = values.name;
      const T = Math.round(num(values.temperature_k));
      const nd = isNum(values.n_donor) ? num(values.n_donor) : 0;
      const na = isNum(values.n_acceptor) ? num(values.n_acceptor) : 0;
      setDim(true);
      try {
        const [res, curves, compare] = await Promise.all([
          api.post("/api/semiconductor/analyze", { name, temperature_k: T, n_donor: nd, n_acceptor: na }),
          st.curvesFor === name && st.curves ? st.curves
            : api.post("/api/semiconductor/curves", { name, t_min: T_MIN, t_max: T_MAX, points: CURVE_POINTS }),
          st.compareT === T && st.compare ? st.compare : api.post("/api/semiconductor/compare", { temperature_k: T }),
        ]);
        Object.assign(st, { name, T, nd, na, res, curves, curvesFor: name, compare, compareT: T, stale: false });
        renderAll();
        return res;
      } catch (err) {
        st.stale = true; // keep the last valid result, dimmed; the form shows the error
        throw err;
      } finally {
        setDim(false);
      }
    }

    function selectMaterial(name) {
      if (!byName.has(name)) return;
      form.setValues({ name });
      resubmit(form, st);
    }

    function renderAll() {
      renderStats();
      renderCarriers();
      renderJunction();
      renderParams();
      renderCurveCharts(st.T);
      renderSq();
      renderCompare();
    }

    function renderStats() {
      const r = st.res, p = r.params || {};
      const sq = r.shockley_queisser || {};
      const edge = r.absorption_edge_nm;
      const direct = !!r.direct_gap;
      const verdict = String(sq.verdict || "");
      const sqKind = /excellent/.test(verdict) ? "ok" : /poor/.test(verdict) ? "warn" : "info";
      const cls = String(r.classification || "");
      statsEl.replaceChildren(
        U.stat({ label: `Band gap at ${st.T} K`, value: r.bandgap_eV, unit: "eV", hint: `${fmt(p.eg_300k)} eV at 300 K · ${fmt(p.eg0)} eV at 0 K` }),
        U.stat({
          label: "Absorption edge",
          value: isNum(edge) ? inline(swatch(edge), fmt(edge, 4)) : "—",
          unit: "nm",
          hint: isNum(edge) ? `${cap(spectralRegion(edge))}: absorbs wavelengths shorter than this` : null,
        }),
        U.stat({ label: "Intrinsic carriers nᵢ", value: sci(r.intrinsic_carrier_cm3, 3), unit: "cm⁻³", hint: `Thermally generated electron-hole pairs at ${st.T} K` }),
        U.stat({ label: "Shockley–Queisser limit", value: sq.sq_efficiency_pct, unit: "%", hint: verdict ? cap(verdict) : null, kind: sqKind }),
        U.stat({
          label: "Classification", value: textValue(cap(cls)),
          hint: "< 3 eV semiconductor · 3–4 eV wide-gap · > 4 eV insulator",
        }),
        U.stat({
          label: "Band gap type",
          value: U.badge(direct ? "Direct gap" : "Indirect gap", direct ? "info" : "neutral"),
          hint: direct ? "Strong band-edge absorption and efficient light emission (LEDs, lasers)"
            : "Phonon-assisted transitions: weak emitter, needs thicker absorbers",
        }));
    }

    function renderCarriers() {
      const c = st.res.carriers;
      if (!c) {
        carriersBody.replaceChildren(U.notice("Intrinsic material. Enter a donor or acceptor density to compute n, p and the Fermi level.", "neutral"));
        return;
      }
      const n = num(c.n), p = num(c.p);
      // full ionisation: the majority carrier follows the net doping
      const type = st.nd > st.na ? "n-type" : st.na > st.nd ? "p-type" : "compensated";
      const underflow = !(n > 0) || !(p > 0) || !Number.isFinite(n) || !Number.isFinite(p);
      const off = num(c.fermi_offset_ev);
      const offText = Number.isFinite(off) && !underflow ? `${off > 0 ? "+" : off < 0 ? "−" : ""}${fmt(Math.abs(off), 4)} eV` : "—";
      const net = Math.abs(st.nd - st.na);
      carriersBody.replaceChildren(...[
        el("div", { style: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: "8px", marginBottom: "6px" } },
          U.badge(type, "info"), muted(`net doping |Nd − Na| = ${sci(net, 3)} cm⁻³`)),
        underflow ? U.notice(`nᵢ is only ${sci(c.n_i, 2)} cm⁻³ at ${st.T} K, so the carrier model underflows here; n, p and the Fermi offset are not reliable.`, "warn") : null,
        U.kv([
          ["Electrons n", `${sci(c.n, 3)} cm⁻³`],
          ["Holes p", `${sci(c.p, 3)} cm⁻³`],
          ["Intrinsic nᵢ", `${sci(c.n_i, 3)} cm⁻³`],
          ["Fermi offset EF − Eᵢ", offText],
        ]),
      ].filter(Boolean));
    }

    function renderJunction() {
      const pn = st.res.pn_junction;
      if (!pn) {
        pnBody.replaceChildren(U.notice("Set both a donor and an acceptor density to model an abrupt pn junction.", "neutral"));
        return;
      }
      const w = num(pn.depletion_width_nm);
      const vbi = num(pn.built_in_potential_V);
      const eg = num(st.res.bandgap_eV);
      pnBody.replaceChildren(U.kv([
        ["Built-in potential Vbi", `${fmt(vbi, 4)} V`],
        ["Depletion width W", Number.isFinite(w) ? (w >= 1000 ? `${fmt(w / 1000, 4)} µm` : `${fmt(w, 4)} nm`) : "—"],
        ["qVbi / Eg", Number.isFinite(vbi) && eg > 0 ? `${fmt((vbi / eg) * 100, 3)} %` : "—"],
        ["n side / p side", `${sci(st.nd, 2)} / ${sci(st.na, 2)} cm⁻³`],
      ]));
    }

    function renderParams() {
      const p = st.res.params || {};
      paramsBody.replaceChildren(
        U.kv([
          ["Material", p.label && p.label !== p.name ? `${p.label} (${p.name})` : (p.name || st.name)],
          ["Eg at 300 K", `${fmt(p.eg_300k, 4)} eV`],
          ["Eg at 0 K", `${fmt(p.eg0, 4)} eV`],
          ["Varshni α", `${sci(p.varshni_alpha, 3)} eV/K`],
          ["Varshni β", `${fmt(p.varshni_beta, 4)} K`],
          ["Electron mass mₑ*/m₀", fmt(p.me_eff, 4)],
          ["Hole mass mₕ*/m₀", fmt(p.mh_eff, 4)],
          ["Permittivity εᵣ", fmt(p.eps_r, 4)],
        ]),
        U.json(st.res, { title: "Raw analysis" }));
    }

    function niDomain(curves, niAtT, dop) {
      const vals = (curves.ni_cm3 || []).map(num).filter((v) => v > 0);
      if (!vals.length) return undefined;
      const lo = Math.min(...vals), hi = Math.max(...vals, dop || 0);
      // below ~1 carrier per cm³ the curve is physically "zero": clip there unless the chosen point is lower
      const floor = Math.max(lo, Math.min(1, niAtT > 0 ? niAtT / 100 : 1));
      return [Math.pow(10, Math.floor(Math.log10(floor))), Math.pow(10, Math.ceil(Math.log10(hi * 1.5)))];
    }

    function renderCurveCharts(T, preview = false) {
      const c = st.curves;
      if (!c) return;
      const label = labelOf(st.name);
      const egAtT = !preview && st.res ? num(st.res.bandgap_eV) : interp(c.temperature, c.bandgap_ev, T);
      const niAtT = !preview && st.res ? num(st.res.intrinsic_carrier_cm3) : interp(c.temperature, c.ni_cm3, T, true);
      const tLabel = `${Math.round(T)} K`;
      egChart.update({
        height: 260, xLabel: "Temperature (K)", yLabel: "Band gap (eV)", xDomain: [T_MIN, T_MAX],
        series: [{ name: `${label} Eg`, x: c.temperature, y: c.bandgap_ev }],
        markers: [{ x: T, label: tLabel }],
        points: Number.isFinite(egAtT) ? [{ x: T, y: egAtT, label: `${fmt(egAtT, 4)} eV` }] : [],
        xFormat: (v) => `${fmt(v, 4)} K`, yFormat: (v) => `${fmt(v, 4)} eV`,
      });
      const dop = Math.max(st.nd || 0, st.na || 0);
      const series = [{ name: `${label} nᵢ`, x: c.temperature, y: c.ni_cm3 }];
      if (dop > 0) series.push({ name: `Doping ${sci(dop, 2)} cm⁻³`, x: c.temperature, y: c.temperature.map(() => dop), dash: true, color: "--chart-marker", width: 1.5 });
      niChart.update({
        height: 260, logY: true, xLabel: "Temperature (K)", yLabel: "nᵢ (cm⁻³)", xDomain: [T_MIN, T_MAX],
        yDomain: niDomain(c, niAtT, dop),
        empty: "nᵢ underflows over this range",
        series,
        markers: [{ x: T, label: tLabel }],
        points: niAtT > 0 ? [{ x: T, y: niAtT, label: sci(niAtT, 3) }] : [],
        xFormat: (v) => `${fmt(v, 4)} K`, yFormat: (v) => `${sci(v, 3)} cm⁻³`,
      });
    }

    function renderSq() {
      const c = st.curves, r = st.res;
      if (!c || !c.sq) return;
      const eg = num(r.bandgap_eV);
      const eff = num((r.shockley_queisser || {}).sq_efficiency_pct);
      const xs = c.sq.bandgap_ev || [];
      const lo = Math.min(...xs.map(num)), hi = Math.max(...xs.map(num));
      const inRange = eg >= lo && eg <= hi;
      sqChart.update({
        height: 260, xLabel: "Band gap (eV)", yLabel: "SQ efficiency (%)",
        xDomain: [lo, hi], yDomain: [0, 40],
        series: [{ name: "SQ limit", x: xs, y: c.sq.efficiency_pct }],
        markers: inRange ? [{ x: eg, label: labelOf(st.name) }] : [],
        points: inRange && Number.isFinite(eff) ? [{ x: eg, y: eff, label: `${fmt(eff, 3)} %` }] : [],
        xFormat: (v) => `${fmt(v, 3)} eV`, yFormat: (v) => `${fmt(v, 3)} %`,
        empty: "No data",
      });
    }

    function renderCompare() {
      const rows = (st.compare && st.compare.rows) || [];
      compareTitle.textContent = `Library comparison at ${st.T} K`;
      compareTable.setRows(rows);
      const sorted = rows.slice().sort((a, b) => num(a.bandgap_ev) - num(b.bandgap_ev));
      barChart.update({
        height: 260, yLabel: `Band gap at ${st.T} K (eV)`, format: (v) => fmt(v, 3),
        bars: sorted.map((r) => ({ label: r.label || r.name, value: r.bandgap_ev, color: r.name === st.name ? "chart-2" : "chart-1" })),
      });
    }

    /** Move the temperature markers instantly while the slider is dragged (the debounced run follows). */
    function previewTemperature(v) {
      const T = Math.round(num(v));
      if (!Number.isFinite(T) || !st.curves || st.curvesFor !== form.getValues().name) return;
      renderCurveCharts(T, true);
    }

    panelApi = { pick, selectMaterial, current: () => st.name };

    form.submit();
  }

  ECCL.registerPanel({
    id: "semiconductor",
    title: "Semiconductors",
    group: "Materials",
    icon: "chip",
    description: "Band gap vs temperature, carriers and doping, pn junctions and Shockley-Queisser screening for a library of semiconductors.",
    order: 30,
    render,
    onShow(params) {
      if (!panelApi) return;
      const name = panelApi.pick(params);
      if (name && name !== panelApi.current()) panelApi.selectMaterial(name);
    },
  });
})(window.ECCL);
