/* Critics gate panel - screen a list of SMILES through the panel of rule-based
 * critics (plus an optional LLM reviewer) at a chosen harshness, inspect each
 * critic's verdict, and sweep all harshness levels to see the strictness ladder.
 */
window.ECCL = window.ECCL || {};

(function (ECCL) {
  "use strict";

  const SEVERITY = ["OK", "NOTE", "CONCERN", "MAJOR", "FATAL"];
  const SEV_KIND = { OK: "ok", NOTE: "info", CONCERN: "warn", MAJOR: "bad", FATAL: "bad" };
  const SEV_TEXT = {
    OK: "Critic satisfied.",
    NOTE: "Informational; only BRUTAL rejects it.",
    CONCERN: "Worth a look; HARSH and BRUTAL reject it.",
    MAJOR: "Likely disqualifying; rejected from NORMAL up.",
    FATAL: "Hard reject at every level.",
  };
  const LEVELS = {
    LENIENT: { threshold: "FATAL", text: "Rejects only FATAL findings. Salts, tiny molecules and structural alerts all pass." },
    NORMAL: { threshold: "MAJOR", text: "Rejects MAJOR or worse: salts and mixtures, fewer than 4 heavy atoms, very poor drug-likeness, two or more structural alerts, very hard synthesis." },
    HARSH: { threshold: "CONCERN", text: "The default. Also rejects CONCERNs: a single structural alert, borderline drug-likeness, a challenging synthesis or more than 70 heavy atoms." },
    BRUTAL: { threshold: "NOTE", text: "Accepts only molecules on which every critic is strictly OK; even an informational NOTE fails." },
  };
  const CRITICS = [
    ["validity", "parses to a real structure"],
    ["connectivity", "one covalent component (no salts or mixtures)"],
    ["size", "4–70 heavy atoms"],
    ["druglikeness", "QED-like ≥ 0.5 and at most one rule failure"],
    ["safety", "no structural alerts (triage, not a safety call)"],
    ["synthesizability", "SA proxy ≤ 6"],
    ["llm_reviewer", "optional devil's advocate; can only make the gate stricter"],
  ];
  const DEFAULT_LIST = [
    ["aspirin", "CC(=O)Oc1ccccc1C(=O)O", "aspirin"],
    ["ethanol", "CCO", "ethanol"],
    ["nitrobenzene", "O=[N+]([O-])c1ccccc1", "nitrobenzene"],
    [null, "CCO.O", "ethanol + water (mixture)"],
    ["ibuprofen", "CC(C)Cc1ccc(cc1)C(C)C(=O)O", "ibuprofen"],
    [null, "C1CC(", "broken SMILES"],
  ];
  const MAX_SMILES = 500;
  const STATUS = {
    accepted: { label: "Accepted", kind: "ok", order: 0 },
    rejected: { label: "Rejected", kind: "bad", order: 1 },
    invalid: { label: "Invalid", kind: "warn", order: 2 },
  };

  // Panel-local styles, scoped to #panel-gate.
  const CSS = `
#panel-gate .gate-intro { color: var(--text-2); max-width: 92ch; }
#panel-gate .gate-stack { display: flex; flex-direction: column; gap: var(--gap); min-width: 0; }
#panel-gate .gate-stack > * + * { margin-top: 0; }
#panel-gate .gate-top { display: grid; gap: var(--gap); grid-template-columns: minmax(0, 1fr); align-items: start; }
@media (min-width: 1100px) { #panel-gate .gate-top { grid-template-columns: minmax(0, 1.3fr) minmax(320px, 1fr); } }
#panel-gate .gate-top > * + * { margin-top: 0; }
#panel-gate .gate-results { transition: opacity 0.15s ease; }
#panel-gate .gate-results.is-stale { opacity: 0.55; }
#panel-gate .gate-loading { display: flex; align-items: center; gap: 10px; color: var(--text-2); }
#panel-gate .gate-count { font-size: 12px; color: var(--text-3); }
#panel-gate .field > .segmented { align-self: flex-start; }
#panel-gate .gate-llm-hint { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; font-size: 12px; color: var(--text-3); margin-top: 2px; }
#panel-gate .gate-llm-hint .btn { margin-left: -6px; }
#panel-gate .grid.gate-stats { --grid-min: 150px; }
#panel-gate .gate-rate .meter { margin-top: 10px; }
#panel-gate .gate-rate .meter-head { display: none; }
#panel-gate .table td { vertical-align: middle; }
#panel-gate .gate-smi { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
#panel-gate .gate-smi small { font-family: var(--font-sans); font-size: 12px; color: var(--text-3); word-break: normal; }
#panel-gate .gate-score { min-width: 96px; }
#panel-gate .gate-score .meter-head { margin-bottom: 3px; justify-content: flex-end; }
#panel-gate .gate-reason { min-width: 180px; color: var(--text-2); }
#panel-gate .gate-reason small { color: var(--text-3); white-space: nowrap; }
#panel-gate .gate-chev { display: inline-grid; place-items: center; color: var(--text-3); }
#panel-gate .gate-chev .icon { width: 16px; height: 16px; transition: transform 0.15s ease; }
#panel-gate tr.is-expanded .gate-chev .icon { transform: rotate(90deg); color: var(--accent); }
#panel-gate tr.is-expanded td { background: var(--row-hover); }
#panel-gate tr.gate-detail-row td, #panel-gate tr.gate-detail-row:hover td { background: var(--surface-2); padding: 0; cursor: default; }
#panel-gate .gate-detail {
  position: sticky; left: 0; box-sizing: border-box;
  max-width: min(100%, calc(100vw - 48px)); padding: 12px 16px 14px 44px;
  display: flex; flex-direction: column; gap: 12px; font-family: var(--font-sans); word-break: normal;
}
#panel-gate .gate-crit { display: grid; grid-template-columns: minmax(110px, max-content) 92px minmax(0, 1fr); gap: 8px 14px; align-items: baseline; }
#panel-gate .gate-crit-name { font-family: var(--font-mono); font-size: 12.5px; font-weight: 600; color: var(--text); }
#panel-gate .gate-crit-msg { color: var(--text); overflow-wrap: anywhere; }
#panel-gate .gate-crit-ev { display: block; font-size: 12px; color: var(--text-3); margin-top: 1px; }
#panel-gate .gate-detail-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
#panel-gate .gate-llm-note summary { cursor: pointer; font-size: 12.5px; color: var(--text-2); }
#panel-gate .gate-llm-note p { margin-top: 6px; font-size: 12.5px; color: var(--text-2); white-space: pre-wrap; overflow-wrap: anywhere; }
#panel-gate .gate-levels { display: flex; flex-direction: column; gap: 10px; margin: 0; padding: 0; list-style: none; }
#panel-gate .gate-level { padding: 8px 10px; border: 1px solid var(--border-subtle); border-radius: var(--radius); }
#panel-gate .gate-level.is-current { border-color: var(--accent-border); background: var(--accent-soft); }
#panel-gate .gate-level-head { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 8px; }
#panel-gate .gate-level-name { font-weight: 650; font-size: 13px; letter-spacing: 0.02em; }
#panel-gate .gate-level p { margin-top: 3px; font-size: 12.5px; color: var(--text-2); }
#panel-gate .gate-sub { font-size: 12px; font-weight: 650; letter-spacing: 0.06em; text-transform: uppercase; color: var(--text-3); }
#panel-gate .gate-legend { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 6px 10px; align-items: center; font-size: 12.5px; color: var(--text-2); }
#panel-gate .gate-critics { margin: 0; padding-left: 18px; font-size: 12.5px; color: var(--text-2); }
#panel-gate .gate-critics li + li { margin-top: 2px; }
#panel-gate .gate-critics code { font-size: 12px; }
#panel-gate .gate-sweep-chart { max-width: 760px; }
#panel-gate .gate-critics-box summary { cursor: pointer; font-size: 12.5px; font-weight: 600; color: var(--text-2); }
#panel-gate .gate-critics-box[open] summary { margin-bottom: 6px; }
#panel-gate .gate-matrix td:not(:first-child), #panel-gate .gate-matrix th:not(:first-child) { text-align: center; }
@media (max-width: 640px) {
  #panel-gate .table th, #panel-gate .table td { padding-left: 8px; padding-right: 8px; }
  #panel-gate .gate-detail { padding: 12px; }
  #panel-gate .gate-crit { grid-template-columns: minmax(0, 1fr) max-content; }
  #panel-gate .gate-crit-msg { grid-column: 1 / -1; margin-top: -4px; padding-bottom: 6px; border-bottom: 1px solid var(--border-subtle); }
}
`;

  function injectStyle() {
    if (document.getElementById("eccl-css-gate")) return;
    const st = document.createElement("style");
    st.id = "eccl-css-gate";
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  const S = {
    ctx: null, form: null, seg: null, levels: Object.keys(LEVELS), harshness: "HARSH", presetBySmiles: new Map(),
    results: null, sweepSlot: null, explainer: null, countEl: null, llmHint: null, charts: [], lastScreen: null,
  };

  // ------------------------------------------------------------------ helpers

  /** Replace a node's children; null / false entries are skipped and arrays flattened (unlike replaceChildren). */
  function fill(node, ...kids) {
    node.replaceChildren(...kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false));
    return node;
  }

  const pct = (v) => `${Math.round(Number(v) * 100)}%`;
  const sevName = (n) => SEVERITY[n] || String(n);

  /** One molecule per line: SMILES, optionally followed by a label after whitespace. '#' lines are comments. */
  function parseInput(text) {
    const items = [];
    const seen = new Set();
    let dup = 0;
    for (const raw of String(text == null ? "" : text).split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const m = line.match(/^(\S+)(?:\s+(.*))?$/);
      const smiles = m[1];
      if (seen.has(smiles)) { dup += 1; continue; }
      seen.add(smiles);
      items.push({ smiles, name: (m[2] || "").trim() || S.presetBySmiles.get(smiles) || "" });
    }
    return { items, dup };
  }

  function inputError(text) {
    const { items } = parseInput(text);
    if (!items.length) return "Enter at least one SMILES (one per line)";
    if (items.length > MAX_SMILES) return `Too many molecules (${items.length}); the maximum is ${MAX_SMILES}`;
    return null;
  }

  function llmStatus() {
    const llm = (ECCL.info && ECCL.info.llm) || {};
    return { reachable: !!llm.reachable, backend: llm.backend || "unknown" };
  }

  function statusOf(v) {
    if (!v || v.error) return "invalid";
    return v.accepted ? "accepted" : "rejected";
  }

  function scoreMeter(v) {
    const m = ECCL.ui.meter({ value: v, min: 0, max: 1, kind: v >= 0.999 ? "ok" : v >= 0.66 ? "info" : "warn", format: pct, label: "critics passed" });
    m.classList.add("gate-score");
    const lab = m.querySelector(".meter-label");
    if (lab) lab.remove();
    return m;
  }

  function evidenceText(ev) {
    if (!ev || typeof ev !== "object") return "";
    return Object.entries(ev).map(([k, v]) => {
      let s;
      if (Array.isArray(v)) s = v.length ? v.join(", ") : "none";
      else if (typeof v === "number") s = ECCL.ui.fmt(v, 3);
      else if (v && typeof v === "object") s = JSON.stringify(v);
      else s = String(v);
      return `${k.replace(/_/g, " ")}: ${s}`;
    }).join(" · ");
  }

  function destroyCharts() {
    for (const c of S.charts) { try { c.destroy(); } catch (err) { /* already gone */ } }
    S.charts = [];
  }

  // ------------------------------------------------------------------ explainer

  function explainerCard() {
    const ui = ECCL.ui;
    S.explainer = ui.el("ol", { class: "gate-levels" });
    paintExplainer();
    return ui.card({ title: "How the gate decides", icon: "info", subtitle: "Every critic grades the molecule; the verdict is a rejection when the worst severity reaches the level's threshold." },
      S.explainer,
      ui.el("div", { class: "gate-sub" }, "Severity legend"),
      ui.el("div", { class: "gate-legend" }, SEVERITY.flatMap((s) => [ui.badge(s, SEV_KIND[s]), ui.el("span", null, SEV_TEXT[s])]),
        ui.badge("INVALID", "warn"), ui.el("span", null, "Unparseable SMILES are always rejected.")),
      ui.el("details", { class: "gate-critics-box" },
        ui.el("summary", null, `The ${CRITICS.length - 1} rule-based critics (+ optional LLM reviewer)`),
        ui.el("ul", { class: "gate-critics" }, CRITICS.map(([name, text]) => ui.el("li", null, ui.el("code", null, name), ` ${text}`)))));
  }

  function paintExplainer() {
    const ui = ECCL.ui;
    if (!S.explainer) return;
    fill(S.explainer, ...S.levels.map((lv) => {
      const d = LEVELS[lv] || { threshold: "?", text: "" };
      const current = lv === S.harshness;
      return ui.el("li", { class: ["gate-level", current && "is-current"], "aria-current": current ? "true" : null },
        ui.el("div", { class: "gate-level-head" },
          ui.el("span", { class: "gate-level-name" }, lv),
          ui.badge(`rejects ${d.threshold}${d.threshold === "FATAL" ? "" : " or worse"}`, SEV_KIND[d.threshold] || "neutral"),
          current ? ui.badge("selected", "info") : null),
        ui.el("p", null, d.text));
    }));
  }

  // ------------------------------------------------------------------ input

  function defaultText(info) {
    const presets = (info.presets && info.presets.molecules) || {};
    return DEFAULT_LIST.map(([key, fallback, label]) => `${(key && presets[key]) || fallback}  ${label}`).join("\n");
  }

  function paintLlm() {
    const ui = ECCL.ui;
    if (!S.form) return;
    const fe = S.form.field("use_llm");
    const st = llmStatus();
    fe.input.disabled = !st.reachable;
    if (!st.reachable) fe.input.checked = false;
    fe.classList.toggle("is-disabled", !st.reachable);
    fill(S.llmHint, ...(st.reachable
      ? [`Backend: ${st.backend}. Adds an "llm_reviewer" critic; it can only make the verdict stricter.`]
      : [`No LLM is reachable (${st.backend}), so the LLM critic is unavailable.`,
        ui.button("Configure in the LLM panel", { kind: "ghost", small: true, icon: "chat", onClick: () => S.ctx.navigate("llm") })]));
  }

  function updateCount() {
    if (!S.form || !S.countEl) return;
    const { items, dup } = parseInput(S.form.field("smiles").getValue());
    S.countEl.textContent = `${items.length} molecule${items.length === 1 ? "" : "s"}${dup ? ` · ${dup} duplicate line${dup === 1 ? "" : "s"} ignored` : ""} · max ${MAX_SMILES}`;
  }

  function inputCard(info) {
    const ui = ECCL.ui;
    S.seg = ui.segmented({
      options: S.levels.map((l) => ({ value: l, label: l })), value: S.harshness, ariaLabel: "Harshness",
      onChange: (v) => { S.harshness = v; paintExplainer(); if (S.lastScreen) submitLatest(); },
    });
    const segField = ui.el("div", { class: "field span-full" },
      ui.el("div", { class: "field-head" }, ui.el("span", { class: "field-label" }, "Harshness")), S.seg,
      ui.el("div", { class: "field-help" }, "Changing the level re-screens the list."));
    const sweepBtn = ui.button("Harshness sweep", { icon: "activity", onClick: runSweep, title: "Screen the same list at all four levels" });
    S.form = ui.form({
      fields: [
        { name: "smiles", label: "Molecules (one SMILES per line, optional label after a space)", type: "textarea", rows: 9, mono: true, required: true,
          value: defaultText(info), validate: inputError, onChange: updateCount },
        segField,
        { name: "use_llm", label: "Add the LLM devil's-advocate critic", type: "checkbox", value: false, span: "full" },
      ],
      columns: 2, submitLabel: "Screen", submitIcon: "shield", onSubmit: runScreen, actions: [sweepBtn],
    });
    S.countEl = ui.el("div", { class: "gate-count", "aria-live": "polite" });
    S.form.field("smiles").appendChild(S.countEl);
    S.llmHint = ui.el("div", { class: "gate-llm-hint" });
    S.form.field("use_llm").appendChild(S.llmHint);
    paintLlm();
    updateCount();
    return ui.card({ title: "Candidates", icon: "shield", subtitle: "Prefilled with a mixed set: two drugs, a too-small molecule, a nitro aromatic, a mixture and a typo." }, S.form);
  }

  function submitLatest() {
    if (S.form.classList.contains("is-pending")) return S.form.submit().then(() => S.form.submit());
    return S.form.submit();
  }

  // ------------------------------------------------------------------ screen

  function runScreen(values) {
    const { items } = parseInput(values.smiles);
    const harshness = S.harshness;
    const useLlm = !!values.use_llm && llmStatus().reachable;
    S.results.classList.add("is-stale");
    return ECCL.api.post("/api/gate/screen", { smiles: items.map((i) => i.smiles), harshness, use_llm: useLlm }).then((data) => {
      S.results.classList.remove("is-stale");
      S.lastScreen = { data, items, harshness, useLlm };
      renderScreen(S.lastScreen);
    }, (err) => {
      S.results.classList.remove("is-stale");
      if (S.results.querySelector(".gate-loading")) fill(S.results, ECCL.ui.empty("Fix the input above to screen the list."));
      throw err;
    });
  }

  function rowsFor(data, items) {
    const verdicts = data.verdicts || {};
    return items.map((it, i) => {
      const v = verdicts[it.smiles] || { accepted: false, error: "no verdict returned" };
      const status = statusOf(v);
      const reasons = Array.isArray(v.reasons) ? v.reasons : [];
      return {
        n: i + 1, smiles: it.smiles, name: it.name, status, verdict: v,
        score: status === "invalid" ? null : v.score,
        worst: status === "invalid" ? null : v.worst_severity,
        reason: status === "invalid" ? (v.error || "could not parse") : reasons[0] || "—",
        more: Math.max(0, reasons.length - 1),
      };
    });
  }

  function renderScreen({ data, items, harshness, useLlm }) {
    const ui = ECCL.ui;
    const rows = rowsFor(data, items);
    const nAcc = rows.filter((r) => r.status === "accepted").length;
    const nRej = rows.filter((r) => r.status === "rejected").length;
    const nInv = rows.filter((r) => r.status === "invalid").length;
    const rate = typeof data.pass_rate === "number" ? data.pass_rate : rows.length ? nAcc / rows.length : 0;

    const rateStat = ui.stat({ label: "Pass rate", value: pct(rate), hint: `at ${harshness}${useLlm ? " + LLM critic" : ""}` });
    rateStat.classList.add("gate-rate");
    rateStat.appendChild(ui.meter({ value: rate, min: 0, max: 1, kind: "info", format: pct, label: "Pass rate" }));
    const stats = ui.grid(4,
      rateStat,
      ui.stat({ label: "Accepted", value: nAcc, kind: "ok", hint: `of ${rows.length}` }),
      ui.stat({ label: "Rejected", value: nRej + nInv, kind: nRej + nInv ? "bad" : null, hint: nInv ? `incl. ${nInv} invalid SMILES` : "by the critics" }),
      ui.stat({ label: "Critics per molecule", value: useLlm ? 7 : 6, hint: useLlm ? "6 rules + LLM reviewer" : "rule-based" }));
    stats.classList.add("gate-stats");

    const table = ui.table({
      columns: [
        { key: "_exp", label: "", width: 30, sortable: false, format: () => ui.el("span", { class: "gate-chev", "aria-hidden": "true" }, ui.icon("chevron-right")) },
        { key: "smiles", label: "SMILES", format: (v, r) => ui.el("div", { class: "gate-smi" }, ui.el("span", null, v), r.name ? ui.el("small", null, r.name) : null) },
        { key: "status", label: "Verdict", sortValue: (r) => STATUS[r.status].order, format: (v) => ui.badge(STATUS[v].label, STATUS[v].kind) },
        { key: "score", label: "Score", align: "right", width: 130, format: (v) => (v === null || v === undefined ? "—" : scoreMeter(v)) },
        { key: "worst", label: "Worst severity", sortValue: (r) => (r.worst === null ? 9 : r.worst),
          format: (v, r) => (r.status === "invalid" ? ui.badge("INVALID", "warn") : ui.badge(sevName(v), SEV_KIND[sevName(v)] || "neutral")) },
        { key: "reason", label: "Top reason", format: (v, r) => ui.el("div", { class: "gate-reason" }, v, r.more ? ui.el("small", null, ` +${r.more} more`) : null) },
      ],
      rows,
      empty: "No molecules screened.",
      onRowClick: (r, i, ev) => toggleDetail(r, ev.currentTarget instanceof Element ? ev.currentTarget : (ev.target instanceof Element ? ev.target.closest("tr") : null)),
    });
    table.querySelectorAll("tbody tr.is-clickable").forEach((tr) => tr.setAttribute("aria-expanded", "false"));

    fill(S.results, stats,
      ui.card({ title: "Verdicts", icon: "table", subtitle: "Click a row (or press Enter) to see every critic's verdict." }, table));
  }

  function toggleDetail(r, tr) {
    if (!tr) return;
    const next = tr.nextElementSibling;
    if (next && next.classList.contains("gate-detail-row")) {
      next.remove();
      tr.classList.remove("is-expanded");
      tr.setAttribute("aria-expanded", "false");
      return;
    }
    const cols = tr.children.length || 6;
    tr.classList.add("is-expanded");
    tr.setAttribute("aria-expanded", "true");
    tr.after(ECCL.ui.el("tr", { class: "gate-detail-row" }, ECCL.ui.el("td", { colspan: cols }, detailContent(r))));
  }

  function detailContent(r) {
    const ui = ECCL.ui;
    const v = r.verdict || {};
    const box = ui.el("div", { class: "gate-detail" });
    if (r.status === "invalid") {
      box.append(ui.notice(`${v.error || "The SMILES could not be parsed."} Check for unclosed rings or branches, unknown atoms or stray characters.`, "warn"));
      return box;
    }
    const crits = Array.isArray(v.critiques) ? v.critiques : [];
    box.append(ui.el("div", { class: "gate-crit", role: "list", "aria-label": `Critic breakdown for ${r.smiles}` },
      crits.flatMap((c) => {
        const name = c.severity_name || sevName(c.severity);
        const ev = evidenceText(c.evidence);
        return [
          ui.el("span", { class: "gate-crit-name", role: "listitem" }, c.critic),
          ui.el("span", null, ui.badge(name, SEV_KIND[name] || "neutral")),
          ui.el("span", { class: "gate-crit-msg" }, c.message, ev ? ui.el("small", { class: "gate-crit-ev" }, ev) : null),
        ];
      })));
    if (v.llm_note) {
      box.append(ui.el("details", { class: "gate-llm-note" }, ui.el("summary", null, "LLM reviewer note"), ui.el("p", null, v.llm_note)));
    }
    box.append(ui.el("div", { class: "gate-detail-actions" },
      ui.button("Open in Molecule Studio", { small: true, icon: "flask", onClick: () => S.ctx.navigate("molecule", { smiles: r.smiles }) }),
      ui.el("span", { class: "gate-count" }, `${v.harshness || S.harshness}: ${(v.reasons || []).join("; ") || "—"}`)));
    return box;
  }

  // ------------------------------------------------------------------ sweep

  function runSweep() {
    const ui = ECCL.ui;
    const fe = S.form.field("smiles");
    if (fe.validate()) { fe.input.focus(); return undefined; }
    const { items } = parseInput(fe.getValue());
    const useLlm = !!S.form.field("use_llm").getValue() && llmStatus().reachable;
    const smiles = items.map((i) => i.smiles);
    S.sweepSlot.classList.add("is-stale");
    if (!S.sweepSlot.querySelector(".gate-matrix")) {
      fill(S.sweepSlot, ui.el("div", { class: "gate-loading" }, ui.spinner("Sweeping"), ui.el("span", null, `Screening ${smiles.length} molecules at ${S.levels.length} levels…`)));
    }
    return Promise.all(S.levels.map((h) => ECCL.api.post("/api/gate/screen", { smiles, harshness: h, use_llm: useLlm })))
      .then((results) => { S.sweepSlot.classList.remove("is-stale"); renderSweep(items, results, useLlm); },
        (err) => {
          S.sweepSlot.classList.remove("is-stale");
          fill(S.sweepSlot, ui.errorBox(err));
          throw err;
        });
  }

  function renderSweep(items, results, useLlm) {
    const ui = ECCL.ui;
    destroyCharts();
    const levels = S.levels;
    const rows = items.map((it) => {
      const row = { smiles: it.smiles, name: it.name, pass: [] };
      levels.forEach((lv, i) => {
        const v = (results[i].verdicts || {})[it.smiles];
        const st = statusOf(v);
        row[lv] = st;
        row.pass.push(st === "accepted");
      });
      const firstFail = row.pass.indexOf(false);
      row.strictest = firstFail === -1 ? levels.length - 1 : firstFail - 1;
      row.monotonic = row.pass.every((p, i) => i === 0 || !p || row.pass[i - 1]);
      row.invalid = levels.every((lv) => row[lv] === "invalid");
      return row;
    });
    const violations = rows.filter((r) => !r.monotonic);
    const rates = results.map((r) => (typeof r.pass_rate === "number" ? r.pass_rate : 0));
    const ratesMonotonic = rates.every((r, i) => i === 0 || r <= rates[i - 1] + 1e-9);

    const badgeFor = (st) => (st === "accepted" ? ui.badge("pass", "ok") : st === "invalid" ? ui.badge("invalid", "warn") : ui.badge("fail", "bad"));
    const table = ui.table({
      columns: [
        { key: "smiles", label: "SMILES", format: (v, r) => ui.el("div", { class: "gate-smi" }, ui.el("span", null, v), r.name ? ui.el("small", null, r.name) : null) },
        ...levels.map((lv, i) => ({ key: lv, label: `${lv} · ${pct(rates[i])}`, format: (v) => badgeFor(v), sortValue: (r) => (r[lv] === "accepted" ? 1 : 0) })),
        { key: "strictest", label: "Strictest level passed", mono: false,
          format: (v, r) => (r.invalid ? ui.badge("never (invalid)", "warn") : v < 0 ? ui.badge("none", "bad") : ui.badge(levels[v], v === levels.length - 1 ? "ok" : "neutral")) },
      ],
      rows, empty: "No molecules.",
    });
    table.classList.add("gate-matrix");

    const chartEl = ui.el("div");
    fill(S.sweepSlot, 
      violations.length || !ratesMonotonic
        ? ui.notice(`Strictness is not monotonic for ${violations.length} molecule(s): ${violations.map((r) => r.smiles).join(", ")}.`, "warn")
        : ui.notice("Strictness is monotonic: every molecule rejected at a level is also rejected at every harsher level, so the pass rate never rises.", "ok"),
      ui.el("div", { class: "gate-sweep-chart" }, chartEl),
      table,
      useLlm ? ui.el("p", { class: "gate-count" }, "Sweep includes the LLM critic.") : null);
    S.charts.push(ECCL.plot.barChart(chartEl, {
      bars: levels.map((lv, i) => ({ label: lv, value: rates[i] * 100, color: "chart-1" })),
      horizontal: true, yLabel: "Pass rate (%)", yDomain: [0, 100], format: (v) => `${Math.round(v)}%`,
    }));
  }

  function sweepCard() {
    const ui = ECCL.ui;
    S.sweepSlot = ui.el("div", { class: "gate-stack gate-results", "aria-live": "polite" },
      ui.empty("Run the sweep to screen the same list at LENIENT, NORMAL, HARSH and BRUTAL and see which molecules survive each level."));
    return ui.card({
      title: "Harshness sweep", icon: "activity", subtitle: "Pass / fail for every molecule at every level",
      actions: ui.button("Run sweep", { small: true, icon: "play", onClick: runSweep }),
    }, S.sweepSlot);
  }

  // ------------------------------------------------------------------ panel

  ECCL.registerPanel({
    id: "gate",
    title: "Critics gate",
    group: "Discovery",
    icon: "shield",
    description: "Screen candidate molecules through the panel of skeptical critics at a chosen harshness.",
    order: 100,
    render(root, ctx) {
      const ui = ECCL.ui;
      injectStyle();
      S.ctx = ctx;
      const info = ctx.info || ECCL.info || {};
      const lv = (info.libraries && info.libraries.harshness) || [];
      if (lv.length) S.levels = lv.slice();
      S.harshness = S.levels.includes("HARSH") ? "HARSH" : S.levels[0];
      const presets = (info.presets && info.presets.molecules) || {};
      S.presetBySmiles = new Map(Object.entries(presets).map(([k, v]) => [v, k]));

      S.results = ui.el("div", { class: "gate-stack gate-results", "aria-live": "polite" },
        ui.card(ui.el("div", { class: "gate-loading" }, ui.spinner("Screening"), ui.el("span", null, "Screening candidates…"))));

      root.append(
        ui.el("p", { class: "gate-intro" },
          "The critics gate is the skeptical filter between generated molecules and your attention: six rule-based critics (and optionally an LLM) grade each candidate, ",
          "and the harshness level decides which severities are fatal. Paste SMILES, pick a level, and inspect why each molecule passed or failed."),
        ui.el("div", { class: "gate-top" }, inputCard(info), explainerCard()),
        S.results,
        sweepCard());

      ctx.bus.on("llm:changed", (data) => {
        if (data && typeof data === "object" && "reachable" in data) {
          ECCL.info.llm = { ...(ECCL.info.llm || {}), ...data };
          paintLlm();
        } else {
          ECCL.api.get("/api/llm/status", { quiet: true }).then((st) => { ECCL.info.llm = { ...(ECCL.info.llm || {}), ...st }; paintLlm(); }, () => {});
        }
      });

      const p = ctx.params || {};
      if (p.smiles) S.form.setValues({ smiles: String(p.smiles).split(/[,\n]/).map((x) => x.trim()).filter(Boolean).join("\n") });
      updateCount();
      S.form.submit();
    },
    onShow(params) {
      paintLlm();
      const p = params || {};
      if (p.smiles && S.form) {
        const text = String(p.smiles).split(/[,\n]/).map((x) => x.trim()).filter(Boolean).join("\n");
        if (text && text !== S.form.field("smiles").getValue()) { S.form.setValues({ smiles: text }); updateCount(); submitLatest(); }
      }
    },
  });
})(window.ECCL);
