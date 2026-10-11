/* Reactions panel - formula calculator, exact reaction balancer and stoichiometry. */
window.ECCL = window.ECCL || {};

(function (ECCL) {
  "use strict";

  const DEFAULT_FORMULA = "Ca10(PO4)6(OH)2";
  const DEFAULT_REACTION = "Propane combustion";
  const ROLE_COLOR = { reactant: "chart-1", product: "chart-2" };

  const S = {
    ctx: null, presets: [],
    fml: { form: null, out: null, err: null, chart: null, seq: 0 },
    rx: { form: null, out: null, last: null },
    st: { body: null, form: null, out: null, err: null, chart: null, seq: 0 },
  };

  // ------------------------------------------------------------------ helpers

  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

  /** "C3H8, O2" or "C3H8 + O2" -> ["C3H8", "O2"] (charges are not supported by the parser). */
  function splitSpecies(text) {
    return String(text || "").split(/\s*[,+;]\s*/).map((s) => s.trim()).filter(Boolean);
  }

  /** Element order as in a Hill formula: C, H, then alphabetical (alphabetical if no carbon). */
  function hillOrder(elements) {
    const els = elements.slice().sort((a, b) => a.localeCompare(b));
    if (!els.includes("C")) return els;
    return ["C"].concat(els.includes("H") ? ["H"] : [], els.filter((e) => e !== "C" && e !== "H"));
  }

  function legend(items) {
    const ui = ECCL.ui;
    return ui.el("div", { class: "rx-legend", "aria-hidden": "true" }, items.map(([label, color]) =>
      ui.el("span", null, ui.el("span", { class: "rx-swatch", style: { background: `var(--${color})` } }), label)));
  }

  /** Compact stat grid (tiles down to 140 px wide; few tiles stretch). */
  function mini(...tiles) {
    return ECCL.ui.grid(4, { min: 140, fit: true }, ...tiles);
  }

  /** Inline equation with subscripted formulae, e.g. for prose. */
  function inlineEquation(d) {
    const ui = ECCL.ui;
    const side = (terms) => terms.map((t, i) => [i ? " + " : "", t.coeff !== 1 ? `${t.coeff} ` : "", ui.formula(t.formula)]);
    return ui.el("span", { class: "rx-inline-eq" }, side(d.reactants || []), " → ", side(d.products || []));
  }

  const SUB = { 0: "₀", 1: "₁", 2: "₂", 3: "₃", 4: "₄", 5: "₅", 6: "₆", 7: "₇", 8: "₈", 9: "₉" };
  /** "C3H8" -> "C₃H₈" for SVG chart labels, which cannot hold <sub> elements. */
  const subscripted = (f) => String(f || "").replace(/([A-Za-z)\]])(\d+)/g, (m, a, d) => a + d.replace(/\d/g, (x) => SUB[x]));

  function destroy(chart) { if (chart) { try { chart.destroy(); } catch (err) { /* gone */ } } return null; }

  // ------------------------------------------------------------------ 1. formula calculator

  async function calcFormula(values) {
    const ui = ECCL.ui;
    const f = S.fml;
    const seq = ++f.seq;
    f.out.classList.add("is-stale");
    let d;
    try {
      d = await ECCL.api.post("/api/formula", { formula: values.formula });
    } catch (err) {
      if (seq !== f.seq) return;
      f.chartCol.classList.add("is-stale");
      throw err; // the live form shows it inline (live forms do not toast)
    }
    if (seq !== f.seq) return;
    f.out.classList.remove("is-stale");
    f.chartCol.classList.remove("is-stale");
    const counts = d.counts || {};
    const fractions = d.mass_fractions || {};
    const M = num(d.molar_mass);
    const order = hillOrder(Object.keys(counts));
    const atoms = order.reduce((s, el) => s + (Number(counts[el]) || 0), 0);
    const rows = order.map((el) => ({
      element: el, count: counts[el], mass: M !== null && num(fractions[el]) !== null ? fractions[el] * M : null,
      pct: num(fractions[el]) !== null ? fractions[el] * 100 : null,
    }));
    const hillStat = ui.stat({ label: "Hill formula", value: ui.formula(d.hill || ""), hint: "C, H, then alphabetical" });
    hillStat.classList.add("rx-stat-formula");
    f.stats.replaceChildren(mini(
      ui.stat({ label: "Molar mass", value: M === null ? null : ui.fmt(M, 7), unit: "g/mol", hint: "standard atomic weights" }),
      hillStat,
      ui.stat({ label: "Atoms", value: atoms, unit: "per formula unit", hint: `${order.length} element${order.length === 1 ? "" : "s"}` })));
    f.table.replaceChildren(ui.table({
      columns: [
        { key: "element", label: "Element" },
        { key: "count", label: "Atoms" },
        { key: "mass", label: "Mass (g/mol)", format: (v) => (v === null ? "—" : ui.fmt(v, 5)) },
        { key: "pct", label: "Mass %", format: (v) => (v === null ? "—" : v.toFixed(2)) },
      ],
      rows, empty: "No elements", sortable: false,
    }));
    const bars = rows.slice().sort((a, b) => (b.pct || 0) - (a.pct || 0)).map((r) => ({ label: r.element, value: r.pct }));
    const spec = { bars, horizontal: true, yLabel: "Mass fraction (%)", yDomain: [0, 100], height: 250, format: (v) => `${v.toFixed(1)} %` };
    if (f.chart) f.chart.update(spec); else f.chart = ECCL.plot.barChart(f.chartEl, spec);
    f.caption.replaceChildren("Mass fractions of ", ui.formula(d.formula));
  }

  function formulaCard() {
    const ui = ECCL.ui;
    const f = S.fml;
    f.stats = ui.el("div", null, ui.spinner("Calculating"));
    f.table = ui.el("div");
    f.chartEl = ui.el("div");
    f.caption = ui.el("div", { class: "rx-cap" }, "Mass fractions");
    f.form = ui.form({
      fields: [{
        name: "formula", label: "Chemical formula", type: "text", mono: true, required: true, value: DEFAULT_FORMULA,
        placeholder: "e.g. Fe2(SO4)3 or CuSO4·5H2O",
        help: "Brackets and hydrate dots are supported. Results update as you type.",
      }],
      columns: 1,
      live: true,
      submitLabel: "Calculate",
      submitIcon: "refresh",
      onSubmit: calcFormula,
    });
    f.out = ui.el("div", { class: "rx-out dimmable" }, f.stats, f.table);
    f.chartCol = ui.el("div", { class: "rx-col rx-out dimmable" }, f.caption, f.chartEl);
    return ui.card({ title: "Formula calculator", icon: "grid", subtitle: "Molar mass, Hill formula, element counts and mass composition of any formula." },
      ui.grid(2, ui.el("div", { class: "rx-col" }, f.form, f.out), f.chartCol));
  }

  // ------------------------------------------------------------------ 2. reaction balancer

  function equationNode(d) {
    const ui = ECCL.ui;
    const side = (terms) => {
      const out = [];
      terms.forEach((t, i) => {
        if (i) out.push(ui.el("span", { class: "rx-op", "aria-hidden": "true" }, "+"));
        out.push(ui.el("span", { class: "rx-term" },
          t.coeff !== 1 ? ui.el("span", { class: "rx-coef" }, String(t.coeff)) : null,
          ui.formula(t.formula)));
      });
      return out;
    };
    const text = String(d.equation || "").replace("->", "→");
    return ui.el("div", { class: "rx-eq", role: "img", "aria-label": `Balanced equation: ${text}` },
      side(d.reactants || []), ui.el("span", { class: "rx-arrow", "aria-hidden": "true" }, "→"), side(d.products || []));
  }

  async function balanceReaction(values) {
    const ui = ECCL.ui;
    const reactants = splitSpecies(values.reactants);
    const products = splitSpecies(values.products);
    if (!reactants.length) throw ui.inputError("Enter at least one reactant formula.");
    if (!products.length) throw ui.inputError("Enter at least one product formula.");
    const out = S.rx.out;
    out.classList.add("is-stale");
    let d;
    try {
      d = await ECCL.api.post("/api/reaction/balance", { reactants, products });
    } catch (err) {
      if (S.st.body) S.st.body.classList.add("is-stale");
      throw err; // shown inline by the form
    }
    out.classList.remove("is-stale");
    S.rx.last = { reactants, products, data: d };
    const mbe = num(d.mass_balance_error);
    const rows = [].concat(
      (d.reactants || []).map((t) => ({ role: "reactant", ...t })),
      (d.products || []).map((t) => ({ role: "product", ...t })))
      .map((r) => ({ ...r, total: num(r.molar_mass) !== null ? r.coeff * r.molar_mass : null }));
    const sumR = rows.filter((r) => r.role === "reactant").reduce((s, r) => s + (r.total || 0), 0);
    const sumP = rows.filter((r) => r.role === "product").reduce((s, r) => s + (r.total || 0), 0);
    const balanced = mbe !== null && mbe < 1e-6;
    out.replaceChildren(
      equationNode(d),
      ui.el("div", { class: "rx-badges" },
        ui.badge(balanced ? "Mass balanced" : "Mass not balanced", balanced ? "ok" : "warn"),
        ui.badge(`mass balance error Δm = ${ui.fmt(mbe, 3)} g/mol`, "neutral"),
        ui.badge(`${rows.length} species`, "neutral")),
      mini(
        ui.stat({ label: "Σ ν·M reactants", value: sumR, unit: "g/mol", hint: "mass consumed per mole of reaction" }),
        ui.stat({ label: "Σ ν·M products", value: sumP, unit: "g/mol", hint: "mass formed per mole of reaction" })),
      ui.table({
        columns: [
          { key: "formula", label: "Species", format: (v, r) => ui.el("span", { class: "rx-two" }, ui.formula(v), ui.el("small", null, r.role)) },
          { key: "coeff", label: "ν" },
          { key: "molar_mass", label: "M (g/mol)", format: (v) => ui.fmt(v, 6) },
          { key: "total", label: "ν × M (g/mol)", format: (v) => ui.fmt(v, 6) },
        ],
        rows, sortable: false,
      }));
    buildStoichiometry(reactants, products, d);
    return d;
  }

  function matchPreset(values) {
    const r = splitSpecies(values.reactants).join(","), p = splitSpecies(values.products).join(",");
    const hit = S.presets.find((x) => x.reactants.join(",") === r && x.products.join(",") === p);
    return hit ? hit.name : "";
  }

  function applyPreset(name) {
    const preset = S.presets.find((x) => x.name === name);
    if (!preset || !S.rx.form) return;
    S.rx.form.setValues({ preset: preset.name, reactants: preset.reactants.join(", "), products: preset.products.join(", ") });
    S.rx.form.submit();
  }

  function balancerCard() {
    const ui = ECCL.ui;
    const syncPreset = () => { const f = S.rx.form; if (f) f.field("preset").setValue(matchPreset(f.getValues())); };
    S.rx.form = ui.form({
      fields: [
        { name: "preset", label: "Preset reaction", type: "select",
          options: [{ value: "", label: "Custom…" }].concat(S.presets.map((r) => ({ value: r.name, label: r.name }))),
          onChange: (v) => { if (v) applyPreset(v); } },
        { name: "reactants", label: "Reactants", type: "text", mono: true, required: true, placeholder: "e.g. C3H8, O2",
          help: "Formulas separated by commas or +", onChange: syncPreset },
        { name: "products", label: "Products", type: "text", mono: true, required: true, placeholder: "e.g. CO2, H2O",
          help: "Formulas separated by commas or +", onChange: syncPreset },
      ],
      columns: 3,
      submitLabel: "Balance",
      submitIcon: "atom",
      onSubmit: balanceReaction,
    });
    S.rx.out = ui.el("div", { class: "rx-out dimmable", "aria-live": "polite" }, ui.el("div", { class: "rx-placeholder" }, ui.spinner("Balancing")));
    return ui.card({ title: "Reaction balancer", icon: "atom", subtitle: "Finds the smallest whole-number coefficients that conserve every element (exact rational null-space)." },
      S.rx.form, S.rx.out);
  }

  // ------------------------------------------------------------------ 3. stoichiometry

  async function calcStoichiometry(values) {
    const ui = ECCL.ui;
    const st = S.st;
    const rx = S.rx.last;
    if (!rx) return;
    const seq = ++st.seq;
    st.out.classList.add("is-stale");
    let d;
    try {
      d = await ECCL.api.post("/api/reaction/stoichiometry", {
        reactants: rx.reactants, products: rx.products, basis: values.basis, moles: values.moles,
      });
    } catch (err) {
      if (seq !== st.seq) return;
      throw err; // shown inline by the live form (no toast while typing)
    }
    if (seq !== st.seq) return;
    st.out.classList.remove("is-stale");
    st.body.classList.remove("is-stale");
    const role = new Map();
    for (const t of rx.data.reactants || []) role.set(t.formula, "reactant");
    for (const t of rx.data.products || []) if (!role.has(t.formula)) role.set(t.formula, "product");
    const coeffs = d.coefficients || {};
    const species = Object.keys(d.moles || {});
    const rows = species.map((f) => ({
      formula: f, role: role.get(f) || "", coeff: coeffs[f], moles: d.moles[f], grams: (d.grams || {})[f], basis: f === d.basis,
    }));
    const massR = rows.filter((r) => r.role === "reactant").reduce((s, r) => s + (num(r.grams) || 0), 0);
    const massP = rows.filter((r) => r.role === "product").reduce((s, r) => s + (num(r.grams) || 0), 0);
    st.table.replaceChildren(
      mini(
        ui.stat({ label: "Reactants consumed", value: massR, unit: "g" }),
        ui.stat({ label: "Products formed", value: massP, unit: "g" })),
      ui.table({
        columns: [
          { key: "formula", label: "Species", format: (v, r) => ui.el("span", { class: "rx-two" },
            ui.el("span", null, ui.formula(v), r.basis ? ui.badge("basis", "info") : null), ui.el("small", null, r.role)) },
          { key: "coeff", label: "ν" },
          { key: "moles", label: "Amount (mol)", format: (v) => ui.fmt(v, 5) },
          { key: "grams", label: "Mass (g)", format: (v) => ui.fmt(v, 5) },
        ],
        rows, sortable: false,
      }));
    const spec = {
      bars: rows.map((r) => ({ label: subscripted(r.formula), value: num(r.grams), color: ROLE_COLOR[r.role] || "chart-1" })),
      yLabel: "Mass (g)", height: 280, format: (v) => ui.fmt(v, 4),
    };
    if (st.chart) st.chart.update(spec); else st.chart = ECCL.plot.barChart(st.chartEl, spec);
    st.caption.replaceChildren(`Mass of each species for ${ui.fmt(d.basis_moles ?? values.moles, 4)} mol `, ui.formula(d.basis));
  }

  function buildStoichiometry(reactants, products, d) {
    const ui = ECCL.ui;
    const st = S.st;
    const prev = st.form ? st.form.getValues() : null;
    const species = [].concat(reactants.map((f) => [f, "reactant"]), products.map((f) => [f, "product"]))
      .filter(([f], i, arr) => arr.findIndex(([g]) => g === f) === i);
    const basis = prev && species.some(([f]) => f === prev.basis) ? prev.basis : species[0][0];
    const moles = prev && Number.isFinite(prev.moles) && prev.moles > 0 ? prev.moles : 1;
    st.chart = destroy(st.chart);
    st.table = ui.el("div", null, ui.spinner("Calculating"));
    st.chartEl = ui.el("div");
    st.caption = ui.el("div", { class: "rx-cap" }, "Masses");
    st.out = ui.el("div", { class: "rx-out dimmable" }, st.table);
    st.form = ui.form({
      fields: [
        { name: "basis", label: "Basis species", type: "select", value: basis,
          options: species.map(([f, role]) => ({ value: f, label: `${f} (${role})` })) },
        { name: "moles", label: "Amount of basis (mol)", type: "number", min: 0, step: "any", required: true, value: moles,
          validate: (v) => (v === 0 ? "Must be greater than 0" : null) },
      ],
      columns: 2,
      live: true,
      submitLabel: "Calculate",
      submitIcon: "refresh",
      onSubmit: calcStoichiometry,
    });
    st.body.classList.remove("is-stale");
    st.body.replaceChildren(
      ui.el("p", { class: "panel-intro" }, "Scale the balanced equation ", inlineEquation(d),
        ": pick the species you know the amount of and every other amount follows from the coefficients."),
      ui.grid(2,
        ui.el("div", { class: "rx-col" }, st.form, st.out),
        ui.el("div", { class: "rx-col rx-out dimmable" }, st.caption, st.chartEl,
          legend([["Reactants (consumed)", ROLE_COLOR.reactant], ["Products (formed)", ROLE_COLOR.product]]))));
    st.form.submit();
  }

  function stoichiometryCard() {
    const ui = ECCL.ui;
    S.st.body = ui.el("div", { class: "rx-out dimmable" }, ui.empty("Balance a reaction above to enable stoichiometry."));
    return ui.card({ title: "Stoichiometry", icon: "flask", subtitle: "Moles and grams of every species for a chosen amount of one of them." }, S.st.body);
  }

  // ------------------------------------------------------------------ panel

  ECCL.registerPanel({
    id: "reactions",
    title: "Reactions",
    group: "Chemistry",
    icon: "atom",
    description: "Formula algebra, molar masses, exact reaction balancing and stoichiometry.",
    order: 20,
    render(root, ctx) {
      const ui = ECCL.ui;
      S.ctx = ctx;
      const info = ctx.info || ECCL.info || {};
      S.presets = ((info.presets && info.presets.reactions) || [])
        .filter((r) => r && r.name && Array.isArray(r.reactants) && Array.isArray(r.products));
      root.append(
        ui.el("p", { class: "panel-intro" },
          "Work with chemical formulas and reactions: compute molar masses and composition, balance an equation exactly, then scale it to real amounts."),
        formulaCard(),
        balancerCard(),
        stoichiometryCard());
      S.fml.form.submit();
      if (S.presets.some((r) => r.name === DEFAULT_REACTION)) applyPreset(DEFAULT_REACTION);
      else if (S.presets.length) applyPreset(S.presets[0].name);
      else {
        S.rx.form.setValues({ reactants: "C3H8, O2", products: "CO2, H2O" });
        S.rx.form.submit();
      }
    },
  });
})(window.ECCL);
