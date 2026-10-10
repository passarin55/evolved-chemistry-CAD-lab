/* Plasmonics panel - nanosphere LSPR with dipole cross-sections, the Drude permittivity behind
 * it, surface-plasmon polaritons on a flat interface and a side-by-side metal comparison.
 * The particle form is live: every change re-runs the sphere, Drude, SPP and comparison views.
 *
 * Endpoints: /api/plasmonics/{sphere,drude,spp}.
 */
window.ECCL = window.ECCL || {};

(function (ECCL) {
  "use strict";

  const HC_EV_NM = 1239.84198; // photon energy (eV) x wavelength (nm)
  const SCAN_MAX_EV = 6.0; // upper end of the engine's LSPR scan (plasmonics.lspr_sphere)
  const METAL_NAMES = { Au: "Gold", Ag: "Silver", Al: "Aluminium", Cu: "Copper", Na: "Sodium" };
  const MEDIA = [
    { value: "vacuum", label: "Vacuum", eps: 1.0 },
    { value: "water", label: "Water", eps: 1.77 },
    { value: "glass", label: "Glass", eps: 2.25 },
    { value: "custom", label: "Custom", eps: null },
  ];

  const CSS = `
#panel-plasmonics .pl-intro { color: var(--text-2); max-width: 90ch; }
#panel-plasmonics .pl-results { transition: opacity 0.15s ease; }
#panel-plasmonics .pl-results.is-busy { opacity: 0.55; }
#panel-plasmonics .pl-stack { display: flex; flex-direction: column; gap: var(--gap); min-width: 0; }
#panel-plasmonics .pl-stack > * + * { margin-top: 0; }
#panel-plasmonics .pl-tiles { --grid-min: 150px; }
#panel-plasmonics .pl-tiles-sm { --grid-min: 120px; }
#panel-plasmonics .pl-medium .segmented { display: flex; width: 100%; }
#panel-plasmonics .pl-medium .seg { flex: 1 1 auto; justify-content: center; padding-left: 8px; padding-right: 8px; }
#panel-plasmonics .pl-swatch {
  display: inline-block; flex: none; width: 18px; height: 18px; margin-right: 8px; border-radius: 5px;
  border: 1px solid var(--border-strong); vertical-align: -3px;
}
#panel-plasmonics .pl-swatch-sm { width: 13px; height: 13px; margin-right: 7px; border-radius: 4px; vertical-align: -2px; }
#panel-plasmonics .pl-res { display: inline-flex; align-items: center; }
#panel-plasmonics .pl-cell { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
#panel-plasmonics .pl-muted { color: var(--text-3); font-size: 12.5px; }
#panel-plasmonics .pl-loading {
  display: flex; align-items: center; justify-content: center; gap: 8px; min-height: 120px;
  color: var(--text-3); font-size: 13px;
}
#panel-plasmonics .pl-sub { font-size: 12px; font-weight: 650; letter-spacing: 0.06em; text-transform: uppercase; color: var(--text-3); }
#panel-plasmonics .pl-meter { margin-top: 2px; }
`;

  function injectStyle() {
    if (document.getElementById("eccl-css-plasmonics")) return;
    const st = document.createElement("style");
    st.id = "eccl-css-plasmonics";
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  // ------------------------------------------------------------------ helpers

  const ui = () => ECCL.ui;
  const el = (...a) => ECCL.ui.el(...a);
  const num = (v) => (v === null || v === undefined || v === "" ? NaN : Number(v));
  const isNum = (v) => Number.isFinite(num(v));
  const fmt = (v, d = 4) => ui().fmt(v, d).replace(/^-(?=[\d.])/, "−"); // typographic minus
  const metalLabel = (m) => (METAL_NAMES[m] ? `${m} · ${METAL_NAMES[m]}` : String(m));

  /** Spectral region of a vacuum wavelength, for hints next to colour swatches. */
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

  function swatch(nm, small) {
    return el("span", {
      class: ["pl-swatch", small && "pl-swatch-sm"], "aria-hidden": "true",
      style: { background: ui().wavelengthToColor(nm) }, title: bandName(nm),
    });
  }

  /** Replace a node's children; null/undefined/false children are skipped (replaceChildren(null) would print "null"). */
  const put = (node, ...kids) => node.replaceChildren(...kids.filter((k) => k !== null && k !== undefined && k !== false));

  const loading = (text = "Computing…") => el("div", { class: "pl-loading" }, ui().spinner(), el("span", null, text));
  /** After a failed run, stop placeholders spinning (the form shows the error). */
  const settle = (root) => root.querySelectorAll(".pl-loading").forEach((n) => n.replaceChildren(el("span", null, "No result yet: see the error above.")));

  /** A chart host that shows a loading row until the first spec arrives. */
  function chartSlot(kind) {
    const host = el("div", null, loading());
    let chart = null;
    return {
      el: host,
      set(spec) {
        if (chart) chart.update(spec);
        else chart = ECCL.plot[kind](host, spec);
      },
      fail(err) { if (!chart) host.replaceChildren(ui().errorBox(err)); },
    };
  }

  function metalParams(name) {
    const list = (ECCL.info.libraries && ECCL.info.libraries.metals) || [];
    return list.find((m) => m.name === name) || null;
  }

  /** Quasi-static Fröhlich estimate wp / sqrt(eps_inf + 2 eps_m), used to size the plot windows. */
  function frohlich(metal, epsM) {
    const p = metalParams(metal);
    if (!p || !isNum(p.wp_ev)) return null;
    const ev = num(p.wp_ev) / Math.sqrt(num(p.eps_inf || 1) + 2 * epsM);
    return { ev, nm: HC_EV_NM / ev };
  }

  /** Wavelength window that contains the resonance (the API's default is 300-900 nm). */
  function spectrumRange(est) {
    if (!est) return [300, 900];
    const lo = est.nm * 0.6 < 300 ? Math.max(50, Math.floor((est.nm * 0.6) / 10) * 10) : 300;
    const hi = Math.min(5000, Math.max(900, Math.ceil((est.nm * 1.6) / 100) * 100));
    return [lo, hi];
  }

  const mediumFor = (eps) => {
    const hit = MEDIA.find((m) => m.eps !== null && Math.abs(m.eps - num(eps)) < 1e-9);
    return hit ? hit.value : "custom";
  };

  /** Run form.submit() and once more if the given key changed while it was in flight. */
  function resubmit(form, keyOf, lastKey) {
    return Promise.resolve(form.submit()).then(() => (keyOf() !== lastKey() ? form.submit() : undefined));
  }

  // ------------------------------------------------------------------ panel

  function render(root) {
    injectStyle();
    const U = ui(), api = ECCL.api;
    const metals = ((ECCL.info.libraries && ECCL.info.libraries.metals) || []).map((m) => m.name);
    if (!metals.length) {
      root.appendChild(U.notice("The server did not report any Drude metals, so there is nothing to model.", "warn"));
      return;
    }
    const S = { lastKey: null, drude: new Map(), cmpKey: null, cmpToken: 0, sppMetal: null, sppKey: null, lspr: null };

    // ---------------- inputs
    const seg = U.segmented({
      options: MEDIA.map((m) => ({ value: m.value, label: m.label })), value: "water", ariaLabel: "Surrounding medium",
      onChange: (val) => {
        const m = MEDIA.find((x) => x.value === val);
        const epsField = form.field("medium_eps");
        if (m && m.eps !== null) { epsField.setValue(m.eps); epsField.setError(null); submitMain(); }
        else epsField.input.focus();
      },
    });
    const mediumNode = el("div", { class: "field pl-medium" },
      el("div", { class: "field-head" }, el("span", { class: "field-label" }, "Surrounding medium")), seg,
      el("div", { class: "field-help" }, "Presets set the permittivity; type your own value to go custom."));

    const results = el("div", { class: "pl-results pl-stack" });
    let dimTimer = 0;
    const setBusy = (on) => {
      clearTimeout(dimTimer);
      if (on) dimTimer = setTimeout(() => results.classList.add("is-busy"), 150);
      else results.classList.remove("is-busy");
      results.setAttribute("aria-busy", on ? "true" : "false");
    };

    const form = U.form({
      columns: 3, live: true, submitLabel: "Calculate", submitIcon: "play",
      fields: [
        { name: "metal", label: "Metal", type: "select", value: metals.includes("Au") ? "Au" : metals[0], options: metals.map((m) => ({ value: m, label: metalLabel(m) })) },
        mediumNode,
        {
          name: "medium_eps", label: "Medium permittivity εm", type: "number", value: 1.77, min: 1, max: 100, step: 0.01, required: true,
          help: "εm = n² (water n = 1.33)", onChange: (v) => seg.setValue(mediumFor(v)),
        },
        { name: "radius_nm", label: "Particle radius", type: "range", value: 20, min: 2, max: 60, step: 1, unit: "nm", span: "full",
          help: "The quasi-static resonance does not move with size; the cross-sections grow as r³ (absorption) and r⁶ (scattering)." },
      ],
      onSubmit: async (v) => {
        S.lastKey = JSON.stringify(v);
        setBusy(true);
        try { await runMain(v); } catch (err) { settle(root); throw err; } finally { setBusy(false); }
      },
    });

    // ---------------- result skeleton
    const lsprStats = U.grid(4, ["Resonance", "Resonance energy", "Linewidth (FWHM)", "Quality factor"].map((label) => U.stat({ label, value: "—" })));
    lsprStats.classList.add("pl-tiles");
    const clipNote = el("div");

    const spectrum = chartSlot("lineChart");
    const xsecTiles = U.grid(3, ["σ ext", "σ sca", "σ abs"].map((label) => U.stat({ label, value: "—" })));
    xsecTiles.classList.add("pl-tiles-sm");
    const xsecExtra = el("div");
    const spectrumCard = U.card({ title: "Extinction spectrum", subtitle: "Dipole (quasi-static Mie) cross-sections of the sphere; the dashed line marks the LSPR." },
      spectrum.el, el("div", { class: "pl-sub" }, "At resonance"), xsecTiles, xsecExtra);

    const drude = chartSlot("lineChart");
    const drudeKv = el("div");
    const drudeCard = U.card({ title: "Drude permittivity", subtitle: "ε(ω) = ε∞ − ωp² / (ω² + iγω). The sphere resonates where ε′ meets the Fröhlich line −2εm." },
      drude.el, drudeKv);

    results.append(lsprStats, clipNote, U.grid(2, spectrumCard, drudeCard));

    // ---------------- SPP card
    const sppStats = U.grid(4, ["Effective index", "Propagation length", "Field confinement", "SPP resonance"].map((label) => U.stat({ label, value: "—" })));
    sppStats.classList.add("pl-tiles");
    const sppNote = el("div");
    const sppNeff = chartSlot("lineChart");
    const sppLen = chartSlot("lineChart");
    const sppForm = U.form({
      columns: 2, live: true, submitLabel: "Calculate", submitIcon: "play",
      fields: [
        { name: "photon_ev", label: "Photon energy (eV)", type: "number", value: 2.0, min: 0.05, max: 50, step: 0.05, required: true, help: "2.0 eV ≈ 620 nm" },
        { name: "eps_dielectric", label: "Dielectric permittivity εd", type: "number", value: 1.0, min: 1, max: 100, step: 0.01, required: true, help: "The medium above the metal film" },
      ],
      actions: U.button("Use particle medium", {
        kind: "ghost", icon: "refresh", small: true, title: "Copy εm from the particle settings",
        onClick: () => {
          const eps = form.field("medium_eps").getValue();
          if (!isNum(eps)) return undefined;
          sppForm.setValues({ eps_dielectric: eps });
          return sppForm.submit();
        },
      }),
      onSubmit: async (v) => {
        const metal = form.field("metal").getValue();
        S.sppMetal = metal;
        S.sppKey = JSON.stringify(v);
        let res;
        try { res = await api.post("/api/plasmonics/spp", { metal, photon_ev: v.photon_ev, eps_dielectric: v.eps_dielectric }); }
        catch (err) { settle(sppCard); throw err; }
        paintSpp(res, v);
        return res;
      },
    });
    const sppMetalLine = el("p", { class: "pl-muted" });
    const sppCard = U.card({ title: "Surface plasmon polariton", subtitle: "A bound surface wave on a flat metal / dielectric interface: how slow, how far and how tightly confined." },
      sppMetalLine, sppForm, sppNote, sppStats,
      U.grid(2, U.card({ title: "Dispersion: effective index" }, sppNeff.el), U.card({ title: "Dispersion: propagation length" }, sppLen.el)));

    // ---------------- comparison card
    const cmpRes = chartSlot("barChart");
    const cmpQ = chartSlot("barChart");
    const cmpTable = el("div", null, loading());
    const cmpFoot = el("div");
    const cmpSub = el("span");
    const cmpCard = U.card({ title: "Metal comparison", subtitle: cmpSub },
      U.grid(2, cmpRes.el, cmpQ.el), cmpTable, cmpFoot);

    root.append(
      el("p", { class: "pl-intro" }, "Model a metal nanosphere in a dielectric: where its localized surface plasmon resonance (LSPR) sits, how sharp it is, and how strongly it extinguishes, scatters and absorbs light. Below, the same metal as a flat film carrying surface plasmon polaritons, and all library metals side by side."),
      U.card({ title: "Particle & environment", subtitle: "Changes apply live." }, form),
      results, sppCard, cmpCard);

    // ---------------- runners

    /** Programmatic re-run that is not lost if a live run is already in flight. */
    function submitMain() {
      return resubmit(form, () => JSON.stringify(form.getValues()), () => S.lastKey);
    }

    function drudeFor(metal, est) {
      const evMax = Math.max(6, Math.ceil((est ? est.ev : 4) * 1.4));
      const key = `${metal}|${evMax}`;
      if (!S.drude.has(key)) {
        const p = api.post("/api/plasmonics/drude", { metal, ev_min: 0.5, ev_max: evMax, points: 241 });
        p.catch(() => S.drude.delete(key)); // retry next time
        S.drude.set(key, p);
      }
      return S.drude.get(key);
    }

    async function runMain(v) {
      const est = frohlich(v.metal, v.medium_eps);
      const range = spectrumRange(est);
      const [sph, dr] = await Promise.all([
        api.post("/api/plasmonics/sphere", { metal: v.metal, radius_nm: v.radius_nm, medium_eps: v.medium_eps, nm_min: range[0], nm_max: range[1], points: 301 }),
        drudeFor(v.metal, est),
      ]);
      paintLspr(sph, v, est, range);
      paintDrude(dr, v, sph, est);
      refreshCompare(v);
      sppMetalLine.replaceChildren("Metal: ", el("strong", null, metalLabel(v.metal)), " (from the particle settings above).");
      if (S.sppMetal !== v.metal) runSpp();
    }

    function runSpp() {
      const metalNow = () => form.field("metal").getValue();
      return resubmit(sppForm, metalNow, () => S.sppMetal).catch(() => undefined);
    }

    // ---------------- painters

    function paintLspr(res, v, est, range) {
      const l = res.lspr || {};
      const at = res.at_resonance || {};
      const clipped = isNum(l.resonance_ev) && num(l.resonance_ev) >= SCAN_MAX_EV - 0.005;
      S.lspr = l;
      const nm = num(l.resonance_nm);
      lsprStats.replaceChildren(
        U.stat({
          label: "Resonance", unit: "nm", kind: clipped ? "warn" : null,
          value: el("span", { class: "pl-res" }, swatch(nm), fmt(nm, 4)),
          hint: clipped ? "Clipped at the engine's 6 eV scan limit" : `Extinction peak in the ${bandName(nm)}`,
        }),
        U.stat({ label: "Resonance energy", value: fmt(l.resonance_ev, 4), unit: "eV", hint: "Where ε′(ω) = −2εm" }),
        U.stat({ label: "Linewidth (FWHM)", value: fmt(l.fwhm_ev, 3), unit: "eV", hint: clipped ? "Not reliable: peak is at the scan edge" : "Set by the Drude damping γ" }),
        U.stat({ label: "Quality factor", value: fmt(l.quality_factor, 4), hint: "Q = E_res / FWHM" }));
      put(clipNote, clipped && est
        ? U.notice(`The LSPR of ${v.metal} in εm = ${fmt(v.medium_eps)} lies above the engine's 6 eV scan window, so the reported resonance, linewidth and Q are pinned to the window edge. The quasi-static estimate ωp/√(ε∞ + 2εm) is ${fmt(est.ev, 4)} eV (${fmt(est.nm, 4)} nm); the spectrum below is computed point by point and shows the true peak.`, "warn")
        : null);

      const sp = res.spectrum || {};
      const x = sp.wavelength_nm || [];
      spectrum.set({
        height: 300, xLabel: "Wavelength (nm)", yLabel: "Cross-section (nm²)", xDomain: range,
        series: [
          { name: "Extinction", x, y: sp.c_ext || [] },
          { name: "Scattering", x, y: sp.c_sca || [] },
          { name: "Absorption", x, y: sp.c_abs || [] },
        ],
        markers: isNum(nm) ? [{ x: nm, label: `LSPR ${fmt(nm, 4)} nm` }] : [],
      });

      const r = num(v.radius_nm);
      const geo = Math.PI * r * r;
      const ext = num(at.C_ext_nm2), sca = num(at.C_sca_nm2), ab = num(at.C_abs_nm2);
      xsecTiles.replaceChildren(
        U.stat({ label: "Extinction σext", value: ext, unit: "nm²" }),
        U.stat({ label: "Scattering σsca", value: sca, unit: "nm²" }),
        U.stat({ label: "Absorption σabs", value: ab, unit: "nm²" }));
      const share = ext > 0 ? sca / ext : NaN;
      xsecExtra.replaceChildren(
        el("div", { class: "pl-meter" }, U.meter({
          value: share, min: 0, max: 1, label: "Scattering share of extinction", kind: "info",
          format: (s) => `${fmt(s * 100, 3)} %`,
        })),
        U.kv([
          ["Geometric area πr²", `${fmt(geo, 4)} nm²`],
          ["Efficiency Qext = σext/πr²", isNum(ext) ? fmt(ext / geo, 4) : "—"],
        ]));
    }

    function paintDrude(res, v, sph, est) {
      const epsM = num(v.medium_eps);
      const yF = -2 * epsM;
      const re = res.eps_real || [];
      let maxRe = -Infinity;
      for (const y of re) if (isNum(y)) maxRe = Math.max(maxRe, num(y));
      const hi = Math.min(40, Math.max(5, Math.ceil((maxRe + 3) / 5) * 5));
      const lo = -Math.max(20, Math.ceil((3 * Math.abs(yF)) / 5) * 5);
      const lspr = sph.lspr || {};
      const clipped = isNum(lspr.resonance_ev) && num(lspr.resonance_ev) >= SCAN_MAX_EV - 0.005;
      const resEv = clipped && est ? est.ev : num(lspr.resonance_ev);
      drude.set({
        height: 300, xLabel: "Photon energy (eV)", yLabel: "Relative permittivity ε", yDomain: [lo, hi],
        series: [
          { name: "ε′ (real)", x: res.photon_ev || [], y: re },
          { name: "ε″ (imaginary)", x: res.photon_ev || [], y: res.eps_imag || [] },
        ],
        hMarkers: [{ y: yF, label: `Fröhlich: ε′ = −2εm = ${fmt(yF, 3)}` }],
        markers: isNum(resEv) ? [{ x: resEv, label: `LSPR ${fmt(resEv, 3)} eV` }] : [],
      });
      const p = res.params || metalParams(v.metal) || {};
      const bulk = isNum(p.wp_ev) && isNum(p.eps_inf) ? num(p.wp_ev) / Math.sqrt(num(p.eps_inf)) : null;
      drudeKv.replaceChildren(U.kv([
        ["Plasma energy ħωp", `${fmt(p.wp_ev)} eV`],
        ["Damping ħγ", `${fmt(p.gamma_ev)} eV`],
        ["Background ε∞", fmt(p.eps_inf)],
        ["ε′ = 0 at ωp/√ε∞", bulk === null ? "—" : `${fmt(bulk, 4)} eV`],
      ]));
    }

    function paintSpp(res, v) {
      const s = res.spp || {};
      const bound = res.bound !== false;
      const k = bound ? null : "warn";
      sppStats.replaceChildren(
        U.stat({ label: "Effective index", value: fmt(s.neff, 4), kind: k, hint: "k_spp / k₀ (light line = √εd)" }),
        U.stat({ label: "Propagation length", value: fmt(s.propagation_length_um, 4), unit: "µm", kind: k, hint: "1/e intensity decay along the surface" }),
        U.stat({ label: "Field confinement", value: fmt(s.confinement_nm, 4), unit: "nm", kind: k, hint: "1/e field depth into the dielectric" }),
        U.stat({ label: "SPP resonance", value: fmt(res.resonance_ev, 4), unit: "eV", hint: `${fmt(res.resonance_nm, 4)} nm · ωp/√(ε∞ + εd)` }));
      put(sppNote, bound ? null : U.notice(
        `${fmt(v.photon_ev)} eV is above the surface-plasmon resonance (${fmt(res.resonance_ev, 4)} eV), so this interface supports no bound SPP; the values above are outside the model's validity. Pick an energy below the resonance.`, "warn"));
      const d = res.dispersion || {};
      const ev = num(v.photon_ev);
      const evs = (d.photon_ev || []).map(num).filter(Number.isFinite);
      const inRange = evs.length && ev >= Math.min(...evs) && ev <= Math.max(...evs);
      const markers = inRange ? [{ x: ev, label: `${fmt(ev, 3)} eV` }] : [];
      const lightLine = Math.sqrt(num(v.eps_dielectric));
      sppNeff.set({
        height: 250, xLabel: "Photon energy (eV)", yLabel: "Effective index n_eff",
        series: [{ name: "n_eff", x: d.photon_ev || [], y: d.neff || [] }],
        hMarkers: [{ y: lightLine, label: `light line √εd = ${fmt(lightLine, 3)}` }],
        markers, points: inRange && bound && isNum(s.neff) ? [{ x: ev, y: num(s.neff) }] : [],
      });
      sppLen.set({
        height: 250, xLabel: "Photon energy (eV)", yLabel: "Propagation length (µm)", logY: true,
        series: [{ name: "Propagation length", x: d.photon_ev || [], y: d.propagation_length_um || [], color: 2 }],
        markers, points: inRange && bound && isNum(s.propagation_length_um) && num(s.propagation_length_um) > 0 ? [{ x: ev, y: num(s.propagation_length_um) }] : [],
      });
    }

    function refreshCompare(v) {
      const key = `${v.radius_nm}|${v.medium_eps}`;
      cmpSub.textContent = `Every library metal as a ${fmt(v.radius_nm)} nm sphere in εm = ${fmt(v.medium_eps)}, following the particle settings. Click a row to load that metal.`;
      if (key === S.cmpKey) { markSelected(v.metal); return; }
      S.cmpKey = key;
      const token = ++S.cmpToken;
      Promise.all(metals.map((m) => api.post("/api/plasmonics/sphere", { metal: m, radius_nm: v.radius_nm, medium_eps: v.medium_eps, points: 2 })))
        .then((list) => {
          if (token !== S.cmpToken) return;
          S.cmpRows = list.map((r) => {
            const l = r.lspr || {}, at = r.at_resonance || {};
            const ext = num(at.C_ext_nm2), sca = num(at.C_sca_nm2);
            return {
              metal: r.metal, resonance_nm: l.resonance_nm, resonance_ev: l.resonance_ev, fwhm_ev: l.fwhm_ev,
              q: l.quality_factor, c_ext: at.C_ext_nm2, share: ext > 0 ? (100 * sca) / ext : null,
              clipped: isNum(l.resonance_ev) && num(l.resonance_ev) >= SCAN_MAX_EV - 0.005,
            };
          });
          paintCompare(form.field("metal").getValue());
        })
        .catch((err) => {
          if (token !== S.cmpToken) return;
          S.cmpKey = null;
          cmpTable.replaceChildren(U.errorBox(err));
          cmpRes.fail(err); cmpQ.fail(err);
        });
    }

    function markSelected(metal) { if (S.cmpRows) paintCompare(metal); }

    function paintCompare(selected) {
      const rows = S.cmpRows || [];
      const anyClip = rows.some((r) => r.clipped);
      cmpRes.set({
        title: "LSPR wavelength", yLabel: "Resonance (nm)", height: 240,
        bars: rows.map((r) => ({ label: r.metal, value: r.resonance_nm })), format: (x) => fmt(x, 4),
      });
      cmpQ.set({
        title: "Quality factor", yLabel: "Q", height: 240,
        bars: rows.map((r) => ({ label: r.metal, value: r.q })), format: (x) => fmt(x, 3),
      });
      cmpTable.replaceChildren(U.table({
        rows,
        onRowClick: (r) => {
          if (r.metal === form.field("metal").getValue()) return;
          form.setValues({ metal: r.metal });
          submitMain();
        },
        columns: [
          {
            key: "metal", label: "Metal", sortValue: (r) => r.metal,
            format: (m) => el("span", { class: "pl-cell" }, metalLabel(m), m === selected ? U.badge("selected", "info") : null),
          },
          {
            key: "resonance_nm", label: "Resonance (nm)", align: "right",
            format: (x, r) => el("span", { class: "pl-cell" }, swatch(x, true), fmt(x, 4), r.clipped ? "*" : null),
          },
          { key: "resonance_ev", label: "Energy (eV)", format: (x) => fmt(x, 4) },
          { key: "fwhm_ev", label: "FWHM (eV)", format: (x) => fmt(x, 3) },
          { key: "q", label: "Q", format: (x) => fmt(x, 4) },
          { key: "c_ext", label: "σext at LSPR (nm²)", format: (x) => fmt(x, 4) },
          { key: "share", label: "Scattering share (%)", format: (x) => fmt(x, 3) },
        ],
      }));
      put(cmpFoot, anyClip
        ? el("p", { class: "pl-muted" }, "* Resonance above the engine's 6 eV scan window: the value is pinned to the window edge, so its linewidth and Q are not meaningful.")
        : null);
    }

    // first view: populated with gold in water
    S.form = form;
    S.submit = submitMain;
    S.seg = seg;
    S.metals = metals;
    panelState = S;
    form.submit();
  }

  let panelState = null;

  ECCL.registerPanel({
    id: "plasmonics",
    title: "Plasmonics",
    group: "Materials",
    icon: "sparkle",
    description: "Drude metals, nanosphere LSPR and Mie cross-sections, surface-plasmon polaritons.",
    order: 50,
    render,
    onShow(params) {
      const S = panelState;
      if (!S || !params) return;
      const patch = {};
      if (params.metal && S.metals.includes(params.metal)) patch.metal = params.metal;
      if (isNum(params.radius_nm)) patch.radius_nm = Math.max(2, Math.min(60, num(params.radius_nm)));
      if (isNum(params.medium_eps) && num(params.medium_eps) >= 1) { patch.medium_eps = num(params.medium_eps); S.seg.setValue(mediumFor(patch.medium_eps)); }
      if (Object.keys(patch).length) { S.form.setValues(patch); S.submit(); }
    },
  });
})(window.ECCL);
