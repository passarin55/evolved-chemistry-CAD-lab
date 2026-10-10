/* Photonics panel - Sellmeier dispersion, Fresnel reflectance, slab waveguides, Bragg mirrors
 * and Fabry-Perot cavities, one tab each. Every tab auto-runs with defaults and re-runs live
 * (debounced) as inputs change.
 *
 * Endpoints: /api/photonics/{dispersion,fresnel,waveguide,dbr,cavity}.
 */
window.ECCL = window.ECCL || {};

(function (ECCL) {
  "use strict";

  const C_LIGHT = 299792458; // m/s, for unit conversions only
  const TABS = ["dispersion", "fresnel", "waveguide", "dbr", "cavity"];
  let panelApi = null; // set by render(); used by onShow to honour ?tab=

  // ------------------------------------------------------------------ small helpers

  const ui = () => ECCL.ui;
  const el = (...a) => ECCL.ui.el(...a);
  const num = (v) => (v === null || v === undefined || v === "" ? NaN : Number(v));
  const isNum = (v) => Number.isFinite(num(v));
  const fmt = (v, d = 4) => ui().fmt(v, d);
  const sci = (v, d = 3) => ui().fmtSci(v, d);

  /** Scale a value into an SI-prefixed string, e.g. 1.5e11 Hz -> "150 GHz". */
  function prefixed(v, unit, digits = 4) {
    const x = num(v);
    if (!Number.isFinite(x)) return "—";
    if (x === 0) return `0 ${unit}`;
    const P = [[1e15, "P"], [1e12, "T"], [1e9, "G"], [1e6, "M"], [1e3, "k"], [1, ""], [1e-3, "m"], [1e-6, "µ"], [1e-9, "n"], [1e-12, "p"], [1e-15, "f"]];
    const a = Math.abs(x);
    const hit = P.find(([f]) => a >= f) || P[P.length - 1];
    return `${fmt(x / hit[0], digits)} ${hit[1]}${unit}`;
  }

  /** Reflectance (0..1) as a percentage with enough digits to show how close it is to 100 %. */
  function pct(r) {
    const x = num(r);
    if (!Number.isFinite(x)) return "—";
    const p = x * 100;
    if (x >= 1) return "100";
    if (x < 0.99) return fmt(p, 4);
    const leak = 1 - x; // e.g. 1e-5 -> 5 decimals
    const dec = Math.min(8, Math.max(2, Math.ceil(-Math.log10(leak * 100)) + 1));
    return p.toFixed(dec).replace(/\.?0+$/, "");
  }

  function interp(xs, ys, x) {
    for (let i = 1; i < xs.length; i++) {
      const x0 = num(xs[i - 1]), x1 = num(xs[i]);
      if (!(x >= Math.min(x0, x1) && x <= Math.max(x0, x1))) continue;
      const y0 = num(ys[i - 1]), y1 = num(ys[i]);
      if (!Number.isFinite(y0) || !Number.isFinite(y1)) continue;
      return x1 === x0 ? y0 : y0 + ((x - x0) / (x1 - x0)) * (y1 - y0);
    }
    return null;
  }

  const textValue = (t) => el("span", { style: { fontSize: "16px", lineHeight: "1.35", overflowWrap: "normal" } }, t);
  const column = (...kids) => el("div", { style: { display: "flex", flexDirection: "column", gap: "var(--gap)" } }, ...kids);

  /** Stat grid that keeps two tiles per row on phones. */
  function statGrid(labels) {
    const g = ui().grid(4, labels.map((label) => ui().stat({ label, value: "—" })));
    g.style.setProperty("--grid-min", "150px");
    return g;
  }

  /** Re-submit a form, and once more if the values changed while a run was in flight. */
  function resubmit(form, st) {
    return Promise.resolve(form.submit()).then(() => {
      if (JSON.stringify(form.getValues()) !== st.lastKey) return form.submit();
      return undefined;
    });
  }

  /**
   * A calculator tab: inputs card (live form + optional presets) above a results column.
   * run(values) -> Promise<result>; show(result, values) paints the results.
   */
  function calcView(opts) {
    const U = ui();
    const st = { lastKey: null, dimTimer: 0, stale: false };
    const results = column(...opts.results);
    results.style.transition = "opacity 0.15s ease";
    const setDim = (on) => {
      clearTimeout(st.dimTimer);
      if (on) st.dimTimer = setTimeout(() => { results.style.opacity = "0.55"; }, 150);
      else results.style.opacity = st.stale ? "0.45" : "";
      results.setAttribute("aria-busy", on ? "true" : "false");
    };
    let form = null;
    form = U.form({
      fields: opts.fields,
      columns: opts.columns || 4,
      live: true,
      submitLabel: "Calculate",
      submitIcon: "play",
      onSubmit: async (values) => {
        st.lastKey = JSON.stringify(values);
        setDim(true);
        try {
          const res = await opts.run(values, form);
          st.stale = false;
          opts.show(res, values);
          return res;
        } catch (err) {
          st.stale = true; // keep the last valid result, dimmed; the form shows the error inline
          throw err;
        } finally {
          setDim(false);
        }
      },
    });
    const formGrid = form.querySelector(".form-grid");
    if (formGrid) formGrid.style.setProperty("--grid-min", "140px"); // two numeric inputs per row on phones
    const presets = opts.presets && opts.presets.length
      ? el("div", { style: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: "6px" } },
        el("span", { style: { fontSize: "12.5px", color: "var(--text-3)", marginRight: "2px" } }, "Presets"),
        opts.presets.map((p) => U.button(p.label, {
          small: true, kind: "secondary", title: p.title || null,
          onClick: () => { form.setValues(p.values); return resubmit(form, st); },
        })))
      : null;
    const card = U.card({ title: opts.title, subtitle: opts.subtitle, actions: presets }, form);
    const root = column(card, results);
    return { root, form, run: () => resubmit(form, st) };
  }

  // ------------------------------------------------------------------ tabs

  function dispersionTab() {
    const U = ui(), P = ECCL.plot, api = ECCL.api;
    const mats = (ECCL.info.libraries && ECCL.info.libraries.sellmeier) || [];
    if (!mats.length) return U.notice("The server did not report any Sellmeier materials.", "warn");
    const stats = statGrid(["n at 589 nm (nD)", "n at 1550 nm", "Group index at 1550 nm", "Abbe number VD"]);
    const host = el("div");
    const note = el("div");
    const chartCard = U.card({ title: "Index vs wavelength", subtitle: "Phase index n and group index n − λ·dn/dλ (dashed)" }, host, note);
    const ref = new Map(); // material -> reference indices (F, C, 1550 nm), fetched once
    let chart = null;

    const refIndices = (material) => {
      if (ref.has(material)) return ref.get(material);
      const p = Promise.all([
        api.post("/api/photonics/dispersion", { material, lambda_min_nm: 486.13, lambda_max_nm: 656.27, points: 2 }),
        api.post("/api/photonics/dispersion", { material, lambda_min_nm: 1550, lambda_max_nm: 1551, points: 2 }),
      ]).then(([fc, ir]) => {
        const at = (r, lam) => { const i = (r.wavelength_nm || []).findIndex((w) => Math.abs(num(w) - lam) < 0.01); return i; };
        const iF = at(fc, 486.13), iC = at(fc, 656.27), i15 = at(ir, 1550);
        return {
          nD: fc.n_589nm,
          nF: iF >= 0 ? fc.n[iF] : null, nC: iC >= 0 ? fc.n[iC] : null,
          n1550: i15 >= 0 ? ir.n[i15] : null, ng1550: i15 >= 0 ? ir.group_index[i15] : null,
        };
      }).catch(() => null); // reference values are a bonus; the main curve still renders
      ref.set(material, p);
      return p;
    };

    const view = calcView({
      title: "Sellmeier dispersion",
      subtitle: "How the refractive index of an optical material changes with wavelength, from its Sellmeier fit.",
      columns: 3,
      fields: [
        { name: "material", label: "Material", type: "select", options: mats, value: mats.includes("SiO2") ? "SiO2" : mats[0] },
        { name: "lambda_min_nm", label: "λ min (nm)", type: "number", value: 300, min: 100, max: 20000, step: 10, required: true },
        {
          name: "lambda_max_nm", label: "λ max (nm)", type: "number", value: 2000, min: 100, max: 20000, step: 10, required: true,
          validate: (v) => { const lo = view && view.form.field("lambda_min_nm").getValue(); return isNum(lo) && isNum(v) && v <= lo ? "Must be greater than λ min" : null; },
        },
      ],
      results: [stats, chartCard],
      run: async (v) => {
        const [res, r] = await Promise.all([
          api.post("/api/photonics/dispersion", { material: v.material, lambda_min_nm: v.lambda_min_nm, lambda_max_nm: v.lambda_max_nm, points: 241 }),
          refIndices(v.material),
        ]);
        return { res, ref: r };
      },
      show: ({ res, ref: r }, v) => {
        const wl = res.wavelength_nm || [];
        const n1550 = r && isNum(r.n1550) ? num(r.n1550) : interp(wl, res.n || [], 1550);
        const ng1550 = r && isNum(r.ng1550) ? num(r.ng1550) : interp(wl, res.group_index || [], 1550);
        const nD = isNum(res.n_589nm) ? num(res.n_589nm) : r && r.nD;
        const abbe = r && isNum(r.nF) && isNum(r.nC) && isNum(nD) && num(r.nF) !== num(r.nC) ? (nD - 1) / (num(r.nF) - num(r.nC)) : null;
        stats.replaceChildren(
          U.stat({ label: "n at 589 nm (nD)", value: isNum(nD) ? fmt(nD, 6) : "—", hint: "Sodium D line, the usual catalogue value" }),
          U.stat({ label: "n at 1550 nm", value: isNum(n1550) ? fmt(n1550, 6) : "—", hint: "Telecom C band" }),
          U.stat({ label: "Group index at 1550 nm", value: isNum(ng1550) ? fmt(ng1550, 6) : "—", hint: "Pulses travel at c divided by this" }),
          U.stat({
            label: "Abbe number VD", value: isNum(abbe) ? fmt(abbe, 4) : "—",
            hint: isNum(abbe) ? (abbe > 50 ? "Low dispersion (crown-like)" : "High dispersion (flint-like)") : "Needs n at 486, 589 and 656 nm",
          }));
        const lo = num(v.lambda_min_nm), hi = num(v.lambda_max_nm);
        const markers = [{ x: 589.3, label: "589 nm" }, { x: 1550, label: "1550 nm" }].filter((m) => m.x >= lo && m.x <= hi);
        const spec = {
          height: 300, xLabel: "Wavelength (nm)", yLabel: "Index", xDomain: [lo, hi], markers,
          empty: "No physical Sellmeier points in this range",
          series: [
            { name: "Phase index n", x: wl, y: res.n || [] },
            { name: "Group index", x: wl, y: res.group_index || [], dash: true },
          ],
          xFormat: (x) => `${fmt(x, 5)} nm`, yFormat: (y) => fmt(y, 6),
        };
        if (chart) chart.update(spec); else chart = P.lineChart(host, spec);
        const omitted = num(res.omitted) || 0;
        note.replaceChildren(...(omitted > 0
          ? [U.notice(`${omitted} sample${omitted === 1 ? "" : "s"} omitted where the Sellmeier fit is non-physical (near an absorption resonance). Treat values at the short-wavelength end with care.`, "warn")]
          : []));
      },
    });
    view.run();
    return view.root;
  }

  function fresnelTab() {
    const U = ui(), P = ECCL.plot, api = ECCL.api;
    const stats = statGrid(["Reflectance at 0°", "Brewster angle θB", "Critical angle θc", "Rs at θB"]);
    const host = el("div");
    const chartCard = U.card({ title: "Reflectance vs angle of incidence", subtitle: "s (TE), p (TM) and unpolarised power reflectance" }, host);
    let chart = null;
    const view = calcView({
      title: "Fresnel reflection",
      subtitle: "Reflectance of a flat interface from medium 1 into medium 2, for every angle of incidence.",
      columns: 4,
      fields: [
        { name: "n1", label: "n₁ (incident side)", type: "number", value: 1.0, min: 0.01, max: 100, step: 0.01, required: true },
        { name: "n2", label: "n₂ (transmitted side)", type: "number", value: 1.5, min: 0.01, max: 100, step: 0.01, required: true },
      ],
      presets: [
        { label: "Air → glass", values: { n1: 1.0, n2: 1.5 } },
        { label: "Glass → air (TIR)", values: { n1: 1.5, n2: 1.0 } },
        { label: "Air → Si", title: "Silicon, n = 3.48 at 1550 nm", values: { n1: 1.0, n2: 3.48 } },
      ],
      results: [stats, chartCard],
      run: (v) => api.post("/api/photonics/fresnel", { n1: v.n1, n2: v.n2, points: 181 }),
      show: (res) => {
        const ang = res.angle_deg || [];
        const toPct = (arr) => (arr || []).map((y) => (isNum(y) ? num(y) * 100 : null));
        const R0 = (res.R || [])[0];
        const b = num(res.brewster_deg), c = res.critical_deg;
        const rsB = interp(ang, res.Rs || [], b);
        stats.replaceChildren(
          U.stat({ label: "Reflectance at 0°", value: pct(R0), unit: "%", hint: isNum(R0) ? `Transmitted ${pct(1 - num(R0))} % at normal incidence` : null }),
          U.stat({ label: "Brewster angle θB", value: isNum(b) ? `${fmt(b, 4)}°` : "—", hint: "p-polarised reflection vanishes" }),
          isNum(c)
            ? U.stat({ label: "Critical angle θc", value: `${fmt(num(c), 4)}°`, hint: "Total internal reflection beyond this angle", kind: "info" })
            : U.stat({ label: "Critical angle θc", value: textValue("None"), hint: "No TIR: light enters an optically denser medium (n₁ ≤ n₂)" }),
          U.stat({ label: "Rs at θB", value: isNum(rsB) ? pct(rsB) : "—", unit: "%", hint: "Reflected light is purely s-polarised here" }));
        const markers = [{ x: b, label: `θB ${fmt(b, 3)}°` }];
        if (isNum(c)) markers.push({ x: num(c), label: `θc ${fmt(num(c), 3)}°` });
        const spec = {
          height: 300, xLabel: "Angle of incidence (°)", yLabel: "Reflectance (%)", xDomain: [0, 90], yDomain: [0, 100],
          xTicks: [0, 15, 30, 45, 60, 75, 90].map((x) => ({ x, label: `${x}°` })),
          series: [
            { name: "Rs (s-pol)", x: ang, y: toPct(res.Rs) },
            { name: "Rp (p-pol)", x: ang, y: toPct(res.Rp) },
            { name: "R (unpolarised)", x: ang, y: toPct(res.R), dash: true },
          ],
          markers,
          xFormat: (x) => `${fmt(x, 4)}°`, yFormat: (y) => `${fmt(y, 4)} %`,
        };
        if (chart) chart.update(spec); else chart = P.lineChart(host, spec);
      },
    });
    view.run();
    return view.root;
  }

  /** Turn a sampled integer staircase into a series with vertical risers at the midpoints. */
  function staircase(xs, ys) {
    const X = [], Y = [];
    for (let i = 0; i < xs.length; i++) {
      const x = num(xs[i]), y = num(ys[i]);
      if (i > 0 && y !== num(ys[i - 1])) {
        const xm = (num(xs[i - 1]) + x) / 2;
        X.push(xm, xm); Y.push(num(ys[i - 1]), y);
      }
      X.push(x); Y.push(y);
    }
    return { x: X, y: Y };
  }

  function waveguideTab() {
    const U = ui(), P = ECCL.plot, api = ECCL.api;
    const stats = statGrid(["V-number", "Guided modes", "Single-mode?", "Single-mode cutoff"]);
    const host = el("div");
    const chartCard = U.card({ title: "Guided modes vs core thickness", subtitle: "Symmetric slab estimate at the chosen wavelength; the dot is your design" }, host);
    let chart = null;
    const view = calcView({
      title: "Slab waveguide",
      subtitle: "Estimate how many modes a symmetric planar waveguide guides, from its V-number.",
      columns: 4,
      fields: [
        { name: "core_index", label: "Core index", type: "number", value: 3.48, min: 0.01, max: 100, step: 0.001, required: true },
        {
          name: "clad_index", label: "Cladding index", type: "number", value: 1.444, min: 0.01, max: 100, step: 0.001, required: true,
          validate: (v) => { const core = view && view.form.field("core_index").getValue(); return isNum(core) && isNum(v) && v >= core ? "Must be below the core index to guide light" : null; },
        },
        { name: "thickness_nm", label: "Core thickness (nm)", type: "number", value: 220, min: 0.1, max: 1e7, step: 1, required: true },
        { name: "wavelength_nm", label: "Wavelength (nm)", type: "number", value: 1550, min: 1, max: 1e7, step: 1, required: true },
      ],
      presets: [
        { label: "SOI 220 nm @ 1550", title: "Silicon core, oxide cladding", values: { core_index: 3.48, clad_index: 1.444, thickness_nm: 220, wavelength_nm: 1550 } },
        { label: "SiN 400 nm @ 1550", title: "Silicon nitride core, oxide cladding", values: { core_index: 2.0, clad_index: 1.444, thickness_nm: 400, wavelength_nm: 1550 } },
        { label: "Fibre-like", title: "Weakly guiding: Δn = 0.005, 6 µm core", values: { core_index: 1.45, clad_index: 1.445, thickness_nm: 6000, wavelength_nm: 1550 } },
      ],
      results: [stats, chartCard],
      run: (v) => api.post("/api/photonics/waveguide", {
        core_index: v.core_index, clad_index: v.clad_index, thickness_nm: v.thickness_nm, wavelength_nm: v.wavelength_nm,
      }),
      show: (res, v) => {
        const V = num(res.v_number), modes = num(res.num_modes_estimate);
        const na = Math.sqrt(Math.max(0, num(v.core_index) ** 2 - num(v.clad_index) ** 2));
        const single = !!res.single_mode;
        const cutoff = num(res.cutoff_wavelength_nm);
        stats.replaceChildren(
          U.stat({ label: "V-number", value: V, hint: `NA = ${fmt(na, 4)}; V = π·d·NA / λ` }),
          U.stat({ label: "Guided modes", value: modes, hint: "Per polarisation, symmetric slab estimate" }),
          U.stat({
            label: "Single-mode?", value: U.badge(single ? "Single-mode" : "Multimode", single ? "ok" : "warn"),
            hint: `V ${single ? "<" : "≥"} π/2 ≈ 1.571`,
          }),
          U.stat({ label: "Single-mode cutoff", value: cutoff, unit: "nm", hint: `Single-mode for λ > ${fmt(cutoff, 4)} nm` }));
        const sw = res.sweep || {};
        const stairs = staircase(sw.thickness_nm || [], sw.num_modes || []);
        const t = num(v.thickness_nm);
        const maxModes = Math.max(1, ...(sw.num_modes || []).map(num).filter(Number.isFinite));
        const markers = [{ x: t, label: `${fmt(t, 4)} nm` }];
        // thickness where V = π/2, from the API's cutoff: cutoff = 2·d·NA -> d_sm = d·λ / cutoff
        const tSm = cutoff > 0 ? (t * num(v.wavelength_nm)) / cutoff : NaN;
        const xs = (sw.thickness_nm || []).map(num);
        if (Number.isFinite(tSm) && tSm >= Math.min(...xs) && tSm <= Math.max(...xs) && Math.abs(tSm - t) / t > 0.04) {
          markers.push({ x: tSm, label: "single-mode limit" });
        }
        const spec = {
          height: 280, xLabel: "Core thickness (nm)", yLabel: "Guided modes", yDomain: [0, Math.max(4, maxModes + 1)],
          series: [{ name: "Guided modes", x: stairs.x, y: stairs.y }],
          markers,
          points: [{ x: t, y: modes, label: `${modes} mode${modes === 1 ? "" : "s"}` }],
          xFormat: (x) => `${fmt(x, 4)} nm`, yFormat: (y) => `${fmt(y, 3)}`,
        };
        if (chart) chart.update(spec); else chart = P.lineChart(host, spec);
      },
    });
    view.run();
    return view.root;
  }

  function dbrTab() {
    const U = ui(), P = ECCL.plot, api = ECCL.api;
    const stats = statGrid(["Bragg wavelength", "Quarter-wave layers", "Peak reflectance", "Pairs for R ≥ 99 %"]);
    const host = el("div");
    let mode = "r", last = null, chart = null;
    const toggle = U.segmented({
      small: true, ariaLabel: "Reflectance scale", value: mode,
      options: [{ value: "r", label: "Reflectance" }, { value: "leak", label: "Leakage 1 − R (log)" }],
      onChange: (m) => { mode = m; if (last) draw(last.res, last.v); },
    });
    const note = el("div");
    const chartCard = U.card({ title: "Peak reflectance vs number of pairs", subtitle: "Quarter-wave stack: incident medium | (HL)ᴺ | substrate, at the Bragg wavelength", actions: toggle }, host, note);

    function draw(res, v) {
      const pairs = res.pairs || [];
      const R = (res.reflectance || []).map(num);
      const N = num(v.max_pairs);
      const rN = R[R.length - 1];
      const xTicks = N <= 12 ? pairs.map((x) => ({ x, label: String(x) })) : undefined;
      let spec;
      if (mode === "leak") {
        const leak = R.map((r) => (r < 1 ? 1 - r : null));
        spec = {
          height: 280, logY: true, xLabel: "Layer pairs N", yLabel: "Leakage 1 − R", xDomain: [1, Math.max(2, N)], xTicks,
          series: [{ name: "1 − R", x: pairs, y: leak }],
          hMarkers: [{ y: 0.01, label: "R = 99 %" }],
          xFormat: (x) => `${x} pair${x === 1 ? "" : "s"}`, yFormat: (y) => sci(y, 3),
          empty: "1 − R is below the API's 10⁻⁸ precision",
        };
        note.replaceChildren(...(R.some((r) => r >= 1)
          ? [U.notice("Points where 1 − R falls below about 10⁻⁸ are beyond the precision of the returned reflectance and are left out.", "neutral")]
          : []));
      } else {
        spec = {
          height: 280, xLabel: "Layer pairs N", yLabel: "Reflectance (%)", xDomain: [1, Math.max(2, N)], yDomain: [0, 100], xTicks,
          series: [{ name: "Peak reflectance", x: pairs, y: R.map((r) => r * 100) }],
          hMarkers: [{ y: 99, label: "99 %" }],
          points: isNum(rN) ? [{ x: N, y: rN * 100 }] : [],
          xFormat: (x) => `${x} pair${x === 1 ? "" : "s"}`, yFormat: (y) => `${pct(y / 100)} %`,
        };
        note.replaceChildren();
      }
      if (chart) chart.update(spec); else chart = P.lineChart(host, spec);
    }

    const view = calcView({
      title: "Distributed Bragg reflector",
      subtitle: "Stack quarter-wave layers of high and low index to build a mirror; see how reflectance grows with each pair.",
      columns: 3,
      fields: [
        { name: "n_high", label: "n high (H)", type: "number", value: 2.35, min: 0.01, max: 100, step: 0.01, required: true },
        { name: "n_low", label: "n low (L)", type: "number", value: 1.45, min: 0.01, max: 100, step: 0.01, required: true },
        { name: "design_wavelength_nm", label: "Design λ (nm)", type: "number", value: 1550, min: 1, max: 1e7, step: 1, required: true },
        { name: "n_in", label: "n incident medium", type: "number", value: 1.0, min: 0.01, max: 100, step: 0.01, required: true },
        { name: "n_out", label: "n substrate", type: "number", value: 1.52, min: 0.01, max: 100, step: 0.01, required: true },
        {
          name: "max_pairs", label: "Max pairs", type: "number", value: 20, min: 1, max: 200, step: 1, required: true,
          validate: (v) => (isNum(v) && !Number.isInteger(v) ? "Whole number of pairs" : null),
        },
      ],
      presets: [
        { label: "TiO₂ / SiO₂", title: "Dielectric mirror on glass at 1550 nm", values: { n_high: 2.35, n_low: 1.45, n_in: 1.0, n_out: 1.52, max_pairs: 20, design_wavelength_nm: 1550 } },
        { label: "Si / SiO₂", title: "High-contrast stack at 1550 nm", values: { n_high: 3.48, n_low: 1.444, n_in: 1.0, n_out: 1.444, max_pairs: 10, design_wavelength_nm: 1550 } },
        { label: "GaAs / AlAs", title: "VCSEL mirror on GaAs at 980 nm", values: { n_high: 3.52, n_low: 2.95, n_in: 1.0, n_out: 3.52, max_pairs: 30, design_wavelength_nm: 980 } },
      ],
      results: [stats, chartCard],
      run: (v) => api.post("/api/photonics/dbr", {
        n_high: v.n_high, n_low: v.n_low, n_in: v.n_in, n_out: v.n_out, max_pairs: v.max_pairs, design_wavelength_nm: v.design_wavelength_nm,
      }),
      show: (res, v) => {
        last = { res, v };
        const R = (res.reflectance || []).map(num);
        const pairs = res.pairs || [];
        const rN = R[R.length - 1];
        const i99 = R.findIndex((r) => r >= 0.99);
        const leak = isNum(rN) ? 1 - rN : NaN;
        stats.replaceChildren(
          U.stat({ label: "Bragg wavelength", value: num(res.bragg_wavelength_nm), unit: "nm", hint: "Centre of the stop band" }),
          U.stat({
            label: "Quarter-wave layers", value: `${fmt(res.d_high_nm, 4)} / ${fmt(res.d_low_nm, 4)}`, unit: "nm",
            hint: "H / L thickness, d = λ / 4n",
          }),
          U.stat({
            label: `Peak reflectance (${pairs.length} pairs)`, value: pct(rN), unit: "%",
            hint: !isNum(rN) ? null : leak > 0 ? `1 − R = ${sci(leak, 2)}` : "1 − R below 10⁻⁸ (API precision)",
            kind: rN >= 0.99 ? "ok" : null,
          }),
          U.stat({
            label: "Pairs for R ≥ 99 %", value: i99 >= 0 ? num(pairs[i99]) : textValue(`more than ${pairs.length}`),
            hint: i99 >= 0 ? `${pct(R[i99])} % at ${pairs[i99]} pairs` : "Increase max pairs or the index contrast",
          }));
        draw(res, v);
      },
    });
    view.run();
    return view.root;
  }

  function cavityTab() {
    const U = ui(), api = ECCL.api;
    const stats = statGrid(["Finesse", "Free spectral range", "Linewidth", "Q factor"]);
    const explain = el("div", null, U.notice("Calculating…", "info"));
    const freqBody = el("div");
    const freqCard = U.card({ title: "Frequency and time domain", subtitle: "Unit conversions of the results above" }, freqBody);
    const view = calcView({
      title: "Fabry–Pérot cavity",
      subtitle: "Two parallel mirrors of reflectance R a distance L apart: how sharp and how far apart the resonances are.",
      columns: 4,
      fields: [
        {
          name: "reflectance", label: "Mirror reflectance R", type: "number", value: 0.99, min: 0, max: 1, step: 0.001, required: true,
          validate: (v) => (isNum(v) && (v <= 0 || v >= 1) ? "Must be strictly between 0 and 1" : null),
        },
        {
          name: "length_nm", label: "Length L (nm)", type: "sci", value: 1e6, required: true, help: "1 mm = 1e6 nm",
          validate: (v) => (isNum(v) && v <= 0 ? "Must be greater than 0" : isNum(v) && v > 1e15 ? "At most 1e15 nm" : null),
        },
        { name: "wavelength_nm", label: "Wavelength (nm)", type: "number", value: 1550, min: 0.001, max: 1e9, step: 1, required: true },
        { name: "n", label: "Refractive index n", type: "number", value: 1.0, min: 0.01, max: 100, step: 0.01, required: true },
      ],
      presets: [
        { label: "Glass etalon", title: "1 mm, n = 1.5, R = 0.9", values: { reflectance: 0.9, length_nm: 1e6, wavelength_nm: 1550, n: 1.5 } },
        { label: "High-finesse", title: "10 cm air gap, R = 0.9999 at 1064 nm", values: { reflectance: 0.9999, length_nm: 1e8, wavelength_nm: 1064, n: 1.0 } },
        { label: "Microcavity", title: "2 µm GaAs-like spacer, R = 0.995 at 980 nm", values: { reflectance: 0.995, length_nm: 2000, wavelength_nm: 980, n: 3.5 } },
      ],
      results: [stats, explain, freqCard],
      run: (v) => api.post("/api/photonics/cavity", { reflectance: v.reflectance, length_nm: v.length_nm, wavelength_nm: v.wavelength_nm, n: v.n }),
      show: (res, v) => {
        const F = num(res.finesse), fsr = num(res.fsr_nm), lw = num(res.linewidth_nm), Q = num(res.Q);
        const lam = num(v.wavelength_nm);
        const dnu = (C_LIGHT * fsr * 1e9) / (lam * lam); // Hz: c·Δλ/λ² (nm -> m)
        const dnuLine = Number.isFinite(F) && F > 0 ? dnu / F : NaN;
        const tau = dnuLine > 0 ? 1 / (2 * Math.PI * dnuLine) : NaN;
        const lenText = prefixed(num(v.length_nm) * 1e-9, "m", 3);
        stats.replaceChildren(
          U.stat({ label: "Finesse", value: F, hint: "F = π√R / (1 − R)" }),
          U.stat({ label: "Free spectral range", value: fsr, unit: "nm", hint: `Δν = ${prefixed(dnu, "Hz", 4)}` }),
          U.stat({ label: "Linewidth", value: lw, unit: "nm", hint: `δν = ${prefixed(dnuLine, "Hz", 4)}` }),
          U.stat({ label: "Q factor", value: Q, hint: "Q = λ / δλ" }));
        explain.replaceChildren(U.notice(
          `With R = ${fmt(num(v.reflectance), 6)} and L = ${lenText}, resonances repeat every ${fmt(fsr, 4)} nm and are ${fmt(lw, 4)} nm wide, so about ${fmt(F, 4)} linewidths fit between neighbouring modes; light survives roughly ${fmt(F / (2 * Math.PI), 3)} round trips.`,
          "info"));
        freqBody.replaceChildren(U.kv([
          ["Free spectral range Δν", prefixed(dnu, "Hz", 4)],
          ["Linewidth δν", prefixed(dnuLine, "Hz", 4)],
          ["Round-trip time", prefixed(dnu > 0 ? 1 / dnu : NaN, "s", 4)],
          ["Photon lifetime τ", prefixed(tau, "s", 4)],
        ]));
      },
    });
    view.run();
    return view.root;
  }

  // ------------------------------------------------------------------ panel

  function render(root, ctx) {
    const U = ECCL.ui;
    const wanted = ctx && ctx.params && TABS.includes(ctx.params.tab) ? ctx.params.tab : "dispersion";
    let ready = false;
    const tabs = U.tabs([
      { id: "dispersion", label: "Dispersion", icon: "spectrum", render: dispersionTab },
      { id: "fresnel", label: "Fresnel", icon: "beam", render: fresnelTab },
      { id: "waveguide", label: "Waveguide", icon: "activity", render: waveguideTab },
      { id: "dbr", label: "DBR", icon: "list", render: dbrTab },
      { id: "cavity", label: "Cavity", icon: "wave", render: cavityTab },
    ], {
      initial: wanted,
      ariaLabel: "Photonics tools",
      onChange: (id) => {
        // keep the URL in step with the open tab without triggering a route change
        if (!ready || !window.history || !window.history.replaceState) return;
        if (!/^#\/photonics(\?|$)/.test(window.location.hash)) return;
        window.history.replaceState(null, "", `#/photonics?tab=${encodeURIComponent(id)}`);
      },
    });
    ready = true;
    // let the five tabs wrap onto a second row on phones instead of hiding behind a scroll
    const list = tabs.querySelector(".tabs-list");
    if (list) list.style.flexWrap = "wrap";
    root.appendChild(tabs);
    panelApi = { select: (id) => { if (TABS.includes(id) && tabs.getActive() !== id) tabs.select(id); } };
  }

  ECCL.registerPanel({
    id: "photonics",
    title: "Photonics",
    group: "Materials",
    icon: "beam",
    description: "Sellmeier dispersion, Fresnel reflectance, slab waveguides, Bragg mirrors and Fabry-Perot cavities.",
    order: 40,
    render,
    onShow(params) {
      if (panelApi && params && params.tab) panelApi.select(params.tab);
    },
  });
})(window.ECCL);
