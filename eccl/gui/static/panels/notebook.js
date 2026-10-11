/* Notebook panel - the lab history kept by the shared Workbench: molecules,
 * materials, evolution / campaign runs and notes. Filter, search, inspect,
 * annotate, delete, and export / import the whole notebook as JSON.
 */
window.ECCL = window.ECCL || {};

(function (ECCL) {
  "use strict";

  const KINDS = [
    { value: "all", label: "All" },
    { value: "molecule", label: "Molecules" },
    { value: "material", label: "Materials" },
    { value: "run", label: "Runs" },
    { value: "note", label: "Notes" },
  ];
  const KIND_BADGE = { molecule: "info", material: "ok", run: "neutral", note: "neutral" };
  const KIND_ICON = { molecule: "flask", material: "chip", run: "dna", note: "book" };
  const MAX_IMPORT_BYTES = 2 * 1024 * 1024 - 64 * 1024; // request bodies are capped at 2 MB
  const MAX_TAGS = 20;
  const MAX_TAG_LEN = 60;
  const CONFIRM_MS = 6000;

  // Panel-local styles, scoped to #panel-notebook.
  const CSS = `
#panel-notebook .nb-intro { color: var(--text-2); max-width: 92ch; }
#panel-notebook .nb-top { display: grid; gap: var(--gap); grid-template-columns: minmax(0, 1fr); align-items: start; }
@media (min-width: 1100px) { #panel-notebook .nb-top { grid-template-columns: minmax(0, 1.4fr) minmax(320px, 1fr); } }
#panel-notebook .nb-top > * + *, #panel-notebook .nb-main > * + *, #panel-notebook .nb-side > * + * { margin-top: 0; }
#panel-notebook .nb-main { display: grid; gap: var(--gap); grid-template-columns: minmax(0, 1fr); align-items: start; }
@media (min-width: 1200px) { #panel-notebook .nb-main { grid-template-columns: minmax(0, 1.75fr) minmax(320px, 1fr); } }
#panel-notebook .nb-side { display: flex; flex-direction: column; gap: var(--gap); min-width: 0; }
@media (min-width: 1200px) { #panel-notebook .nb-side { position: sticky; top: calc(var(--topbar-h) + 16px); } }
#panel-notebook .nb-stats { display: grid; gap: 10px; grid-template-columns: repeat(auto-fit, minmax(min(100%, 92px), 1fr)); }
#panel-notebook .nb-stats > * + * { margin-top: 0; }
#panel-notebook .nb-stats .stat { padding: 10px 12px; }
#panel-notebook .nb-stats .stat-number { font-size: 20px; }
#panel-notebook .nb-filters { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 10px 12px; }
#panel-notebook .nb-filters .field { flex: 1 1 200px; }
#panel-notebook .nb-filters .segmented { align-self: flex-end; }
#panel-notebook .nb-count { font-size: 12.5px; color: var(--text-3); }
#panel-notebook .nb-file { display: none; }
#panel-notebook .table td { vertical-align: middle; }
#panel-notebook .nb-sumcell { display: flex; flex-direction: column; gap: 5px; min-width: 140px; }
#panel-notebook .nb-records .table th, #panel-notebook .nb-records .table td { padding-left: 10px; padding-right: 10px; }
#panel-notebook .nb-summary { max-width: 52ch; overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
#panel-notebook .nb-id { font-size: 12px; color: var(--text-2); white-space: nowrap; }
#panel-notebook .nb-time { white-space: nowrap; color: var(--text-2); font-size: 12.5px; }
#panel-notebook .nb-when { display: flex; flex-direction: column; line-height: 1.35; }
#panel-notebook .nb-when span + span { color: var(--text-3); font-size: 12px; }
#panel-notebook .nb-tags { display: flex; flex-wrap: wrap; gap: 4px; min-width: 60px; }
#panel-notebook .nb-tag { cursor: pointer; font: inherit; font-size: 12px; font-weight: 600; }
#panel-notebook .nb-tag:hover { border-color: var(--border-strong); color: var(--text); }
#panel-notebook .nb-del { display: flex; justify-content: flex-end; gap: 4px; white-space: nowrap; }
#panel-notebook tr.is-selected td { background: var(--accent-soft); }
#panel-notebook tr.is-selected td:first-child { box-shadow: inset 3px 0 0 var(--accent); }
#panel-notebook .nb-loading { display: flex; align-items: center; gap: 10px; color: var(--text-2); }
#panel-notebook .nb-note-text { white-space: pre-wrap; overflow-wrap: anywhere; padding: 10px 12px; border-radius: var(--radius); background: var(--surface-2); border: 1px solid var(--border-subtle); }
#panel-notebook .nb-actions { display: flex; flex-wrap: wrap; gap: 8px; }
#panel-notebook .nb-actions > * + * { margin-top: 0; }
#panel-notebook .nb-detail .molecule { max-width: 340px; margin: 0 auto; }
#panel-notebook .nb-detail-title { min-width: 0; overflow-wrap: anywhere; }
#panel-notebook .nb-depict-wait { display: grid; place-items: center; aspect-ratio: 4 / 3; max-width: 340px; margin: 0 auto; border: 1px dashed var(--border-strong); border-radius: var(--radius-md); }
#panel-notebook .nb-empty-actions { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; }
@media (max-width: 640px) {
  #panel-notebook .table th, #panel-notebook .table td { padding-left: 8px; padding-right: 8px; }
  #panel-notebook .nb-sumcell { min-width: 160px; }
  #panel-notebook .nb-filters .seg { padding-left: 8px; padding-right: 8px; }
}
`;

  function injectStyle() {
    if (document.getElementById("eccl-css-notebook")) return;
    const st = document.createElement("style");
    st.id = "eccl-css-notebook";
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  const S = {
    ctx: null, records: [], name: "", kind: "all", q: "", selectedId: null, selectNext: null,
    loaded: false, loading: null, renderedOnce: false, depictToken: 0,
    statsEl: null, tableSlot: null, countEl: null, detailCard: null, errorSlot: null, fileInput: null, subtitleEl: null,
  };

  // ------------------------------------------------------------------ helpers

  /** Replace a node's children; null / false entries are skipped and arrays flattened (unlike replaceChildren). */
  function fill(node, ...kids) {
    node.replaceChildren(...kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false));
    return node;
  }

  function fmtTime(created) {
    const t = Number(created);
    if (!Number.isFinite(t)) return "—";
    try {
      return new Date(t * 1000).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    } catch (err) { return new Date(t * 1000).toISOString(); }
  }

  /** Local date and time as two short strings, e.g. ["Oct 10", "10:58 PM"]. */
  function dateParts(created) {
    const t = Number(created);
    if (!Number.isFinite(t)) return ["—", ""];
    const d = new Date(t * 1000);
    const sameYear = d.getFullYear() === new Date().getFullYear();
    try {
      return [d.toLocaleDateString(undefined, sameYear ? { month: "short", day: "numeric" } : { year: "numeric", month: "short", day: "numeric" }),
        d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })];
    } catch (err) { return [d.toISOString().slice(0, 10), d.toISOString().slice(11, 16)]; }
  }

  function isoTime(created) {
    const t = Number(created);
    return Number.isFinite(t) ? new Date(t * 1000).toISOString() : "";
  }

  function parseTags(text) {
    const out = [];
    for (const t of String(text || "").split(",").map((x) => x.trim()).filter(Boolean)) if (!out.includes(t)) out.push(t);
    return out;
  }

  function tagsError(text) {
    const tags = parseTags(text);
    if (tags.length > MAX_TAGS) return `At most ${MAX_TAGS} tags`;
    const long = tags.find((t) => t.length > MAX_TAG_LEN);
    if (long) return `Tags are limited to ${MAX_TAG_LEN} characters`;
    return null;
  }

  function matches(r, q) {
    if (!q) return true;
    const hay = [r.id, r.kind, r.summary, ...(r.tags || [])].join("\u0001").toLowerCase();
    return q.split(/\s+/).filter(Boolean).every((term) => hay.includes(term));
  }

  function filtered() {
    const q = S.q.trim().toLowerCase();
    return S.records.filter((r) => (S.kind === "all" || r.kind === S.kind) && matches(r, q));
  }

  function changed(detail) { ECCL.bus.emit("notebook:changed", detail || {}); }

  function stamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
  }

  // ------------------------------------------------------------------ data

  function refresh() {
    if (S.loading) { S.again = true; return S.loading; }
    S.loading = ECCL.api.get("/api/notebook").then((data) => {
      S.records = Array.isArray(data.records) ? data.records : [];
      S.name = data.name || "";
      S.loaded = true;
      S.errorSlot.replaceChildren();
      if (S.selectNext && S.records.some((r) => r.id === S.selectNext)) S.selectedId = S.selectNext;
      S.selectNext = null;
      if (S.selectedId && !S.records.some((r) => r.id === S.selectedId)) S.selectedId = null;
      if (!S.selectedId && !S.renderedOnce && S.records.length) S.selectedId = S.records[0].id;
      S.renderedOnce = true;
      paintAll();
    }, (err) => {
      fill(S.errorSlot, ECCL.ui.errorBox(err));
      if (!S.loaded) fill(S.tableSlot, ECCL.ui.empty("The notebook could not be loaded."));
    }).finally(() => {
      S.loading = null;
      if (S.again) { S.again = false; refresh(); }
    });
    return S.loading;
  }

  // ------------------------------------------------------------------ painting

  function paintAll() {
    paintStats();
    paintTable();
    paintDetail();
  }

  function paintStats() {
    const ui = ECCL.ui;
    const count = (k) => S.records.filter((r) => r.kind === k).length;
    fill(S.statsEl, 
      ui.stat({ label: "Records", value: S.records.length, kind: "info" }),
      ui.stat({ label: "Molecules", value: count("molecule") }),
      ui.stat({ label: "Materials", value: count("material") }),
      ui.stat({ label: "Runs", value: count("run") }),
      ui.stat({ label: "Notes", value: count("note") }));
    if (S.subtitleEl) S.subtitleEl.textContent = S.name ? `Notebook "${S.name}" · kept in memory by this server session; export to keep a copy.` : "";
  }

  function tagButton(tag) {
    return ECCL.ui.el("button", {
      type: "button", class: "badge badge-neutral nb-tag", title: `Show records tagged “${tag}”`,
      on: { click: () => { S.q = tag; S.search.setValue(tag); paintTable(); } },
    }, tag);
  }

  function deleteCell(r) {
    const ui = ECCL.ui;
    const cell = ui.el("div", { class: "nb-del" });
    let timer = 0;
    const idle = (focus) => {
      clearTimeout(timer);
      const b = ui.button(null, { kind: "ghost", small: true, icon: "trash", title: `Delete ${r.id}`, onClick: arm });
      fill(cell, b);
      if (focus) b.focus();
    };
    const arm = () => {
      const yes = ui.button("Delete", {
        kind: "danger", small: true, icon: "trash", title: `Permanently delete ${r.id}`,
        onClick: () => { clearTimeout(timer); return removeRecord(r.id); },
      });
      const no = ui.button("Cancel", { kind: "ghost", small: true, onClick: () => idle(true) });
      fill(cell, yes, no);
      yes.focus();
      timer = setTimeout(() => { if (cell.isConnected && !yes.disabled) idle(cell.contains(document.activeElement)); }, CONFIRM_MS);
    };
    idle(false);
    return cell;
  }

  function removeRecord(id) {
    return ECCL.api.post("/api/notebook/delete", { id }).then(() => {
      ECCL.ui.toast(`Deleted ${id}`, "ok", 2500);
      if (S.selectedId === id) S.selectedId = null;
      S.records = S.records.filter((r) => r.id !== id);
      paintAll();
      changed({ id, action: "delete" });
    });
  }

  function paintTable() {
    const ui = ECCL.ui;
    const rows = filtered();
    const total = S.records.length;
    S.countEl.textContent = total ? (rows.length === total ? `${total} record${total === 1 ? "" : "s"}` : `${rows.length} of ${total} records`) : "";
    if (!total) {
      fill(S.tableSlot, ui.el("div", { class: "empty" },
        ui.el("span", { class: "empty-icon" }, ui.icon("book")),
        ui.el("p", { class: "empty-msg" }, "The notebook is empty. Molecule analyses, evolution runs and campaigns are recorded here automatically; you can also add notes or import an exported notebook."),
        ui.el("div", { class: "nb-empty-actions" },
          ui.button("Analyse a molecule", { small: true, icon: "flask", onClick: () => S.ctx.navigate("molecule") }),
          ui.button("Write a note", { small: true, icon: "plus", onClick: () => S.noteForm.field("text").input.focus() }))));
      return;
    }
    const table = ui.table({
      columns: [
        { key: "kind", label: "Kind", format: (v) => ui.badge(v, KIND_BADGE[v] || "neutral") },
        { key: "id", label: "ID", format: (v) => ui.el("span", { class: "mono nb-id", dataset: { rid: v } }, v) },
        { key: "summary", label: "Summary", format: (v) => ui.el("div", { class: "nb-sumcell" }, ui.el("div", { class: "nb-summary", title: v || "" }, v || "—")) },
        {
          key: "tags", label: "Tags", sortValue: (r) => (r.tags || []).join(", "),
          format: (v) => (Array.isArray(v) && v.length ? ui.el("div", { class: "nb-tags" }, v.map(tagButton)) : ui.el("span", { class: "nb-time" }, "—")),
        },
        {
          key: "created", label: "Created", align: "left",
          format: (v) => ui.el("time", { class: "nb-time nb-when", datetime: isoTime(v), title: fmtTime(v) }, dateParts(v).map((x) => ui.el("span", null, x))),
        },
        { key: "_del", label: "", sortable: false, align: "right", format: (v, r) => deleteCell(r) },
      ],
      rows,
      empty: "No records match the filter.",
      maxHeight: 560,
      onRowClick: (r) => select(r.id),
    });
    fill(S.tableSlot, table);
    markSelected();
  }

  function markSelected() {
    S.tableSlot.querySelectorAll("tr.is-selected").forEach((tr) => { tr.classList.remove("is-selected"); tr.removeAttribute("aria-selected"); });
    if (!S.selectedId) return;
    for (const span of S.tableSlot.querySelectorAll(".nb-id")) {
      if (span.dataset.rid === S.selectedId) {
        const tr = span.closest("tr");
        if (tr) { tr.classList.add("is-selected"); tr.setAttribute("aria-selected", "true"); }
      }
    }
  }

  function select(id) {
    S.selectedId = id;
    markSelected();
    paintDetail();
    if (window.matchMedia && window.matchMedia("(max-width: 1199.98px)").matches && S.detailCard) {
      S.detailCard.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  function paintDetail() {
    const ui = ECCL.ui;
    const r = S.records.find((x) => x.id === S.selectedId);
    const card = S.detailCard;
    const key = r ? `r:${r.id}` : `none:${S.records.length ? 1 : 0}:${S.loaded ? 1 : 0}`;
    if (card.dataset.key === key) return; // unchanged selection: keep the depiction instead of redrawing it
    card.dataset.key = key;
    S.depictToken += 1;
    if (!r) {
      fill(card, ui.el("div", { class: "card-header" }, ui.el("div", { class: "card-heading" }, ui.el("h3", { class: "card-title" }, ui.icon("info"), "Record details"))),
        ui.empty(S.records.length ? "Select a record to see its details." : "Nothing recorded yet."));
      return;
    }
    const p = r.payload && typeof r.payload === "object" ? r.payload : {};
    const parts = [];
    const actions = [];
    if (r.kind === "molecule" && p.smiles) {
      const slot = ui.el("div", { class: "nb-depict-wait" }, ui.spinner("Drawing structure"));
      parts.push(slot);
      depict(slot, p.smiles, p.name || p.smiles);
      parts.push(ui.kv([["SMILES", ui.el("span", { class: "mono" }, p.smiles)], ["Name", p.name || "—"],
        ["Formula", p.formula ? ui.formula(p.formula) : "—"], ["Molar mass", typeof p.molar_mass === "number" ? `${ui.fmt(p.molar_mass, 5)} g/mol` : "—"]]));
      actions.push(ui.button("Open in Molecule Studio", { kind: "primary", small: true, icon: "flask", onClick: () => S.ctx.navigate("molecule", { smiles: p.smiles, record: r.id }) }));
    } else if (r.kind === "note") {
      parts.push(ui.el("div", { class: "nb-note-text" }, String(p.text == null ? "" : p.text)));
    } else if (r.kind === "run") {
      const best = p.best && typeof p.best === "object" ? p.best : null;
      const pairs = [["Type", p.type || "run"]];
      if (p.title) pairs.push(["Title", p.title]);
      if (best && best.smiles) pairs.push(["Best", ui.el("span", { class: "mono" }, best.smiles)]);
      if (best && typeof best.fitness === "number") pairs.push(["Best fitness", ui.fmt(best.fitness, 4)]);
      if (Array.isArray(p.history)) pairs.push(["Generations", p.history.length]);
      if (Array.isArray(p.winners)) pairs.push(["Winners", p.winners.length]);
      parts.push(ui.kv(pairs));
      if (best && best.smiles) actions.push(ui.button("Open best in Molecule Studio", { small: true, icon: "flask", onClick: () => S.ctx.navigate("molecule", { smiles: best.smiles }) }));
    } else if (r.kind === "material") {
      parts.push(ui.kv([["Name", p.name || "—"], ["Formula", p.formula ? ui.formula(p.formula) : "—"]]));
    }
    let size = 0;
    try { size = JSON.stringify(p).length; } catch (err) { size = 0; }
    const title = r.kind === "molecule" ? (p.name || p.smiles || "Molecule")
      : r.kind === "note" ? "Note"
        : r.kind === "material" ? (p.name || p.formula || "Material")
          : r.kind === "run" ? (p.type === "evolution" ? "Evolution run" : p.type === "campaign" ? `Campaign${p.title ? `: ${p.title}` : ""}` : String(p.type || "Run"))
            : (r.summary || r.id);
    fill(card, 
      ui.el("div", { class: "card-header" },
        ui.el("div", { class: "card-heading" },
          ui.el("h3", { class: "card-title" }, ui.icon(KIND_ICON[r.kind] || "info"), ui.el("span", { class: "nb-detail-title" }, title)),
          ui.el("p", { class: "card-subtitle" }, ui.el("span", { class: "mono" }, r.id), ` · ${fmtTime(r.created)}`))),
      ui.el("div", { class: "nb-tags" }, ui.badge(r.kind, KIND_BADGE[r.kind] || "neutral"), (r.tags || []).map(tagButton)),
      parts,
      actions.length ? ui.el("div", { class: "nb-actions" }, actions) : null,
      ui.json(p, { title: "Payload", collapsed: size > 4000 }));
  }

  function depict(slot, smiles, caption) {
    const token = S.depictToken;
    ECCL.api.post("/api/molecule/depict", { smiles, width: 320, height: 240 }).then((d) => {
      if (token !== S.depictToken || !slot.isConnected) return;
      slot.replaceWith(ECCL.ui.molecule(d && d.svg, { caption }));
    }, (err) => {
      if (token !== S.depictToken || !slot.isConnected) return;
      slot.replaceWith(ECCL.ui.notice(`No depiction: ${ECCL.ui.errMessage(err)}`, "warn"));
    });
  }

  // ------------------------------------------------------------------ export / import

  function exportNotebook() {
    return ECCL.api.get("/api/notebook/export").then((data) => {
      const n = Array.isArray(data.records) ? data.records.length : 0;
      ECCL.ui.download(`eccl-notebook-${(data.name || "lab").replace(/[^A-Za-z0-9_-]+/g, "-")}-${stamp()}.json`, JSON.stringify(data, null, 2));
      ECCL.ui.toast(`Exported ${n} record${n === 1 ? "" : "s"}`, "ok", 2500);
    });
  }

  function importFile(file) {
    const ui = ECCL.ui;
    if (!file) return Promise.resolve();
    if (file.size > MAX_IMPORT_BYTES) {
      return Promise.reject(new Error(`${file.name} is ${(file.size / 1048576).toFixed(1)} MB; imports are limited to about 2 MB.`));
    }
    return file.text().then((text) => {
      let data;
      try { data = JSON.parse(text); } catch (err) { throw new Error(`${file.name} is not valid JSON (${err.message}).`); }
      if (Array.isArray(data)) data = { records: data };
      if (!data || typeof data !== "object" || !Array.isArray(data.records)) {
        throw new Error(`${file.name} is not an ECCL notebook export (expected an object with a "records" list).`);
      }
      return ECCL.api.post("/api/notebook/import", { data, merge: true });
    }).then((res) => {
      const n = typeof res.imported === "number" ? res.imported : null;
      ui.toast(n === null ? `Import complete; the notebook holds ${res.count} records.`
        : `Imported ${n} record${n === 1 ? "" : "s"}; the notebook now holds ${res.count}.`, "ok");
      changed({ action: "import" });
    });
  }

  // ------------------------------------------------------------------ cards

  function overviewCard() {
    const ui = ECCL.ui;
    S.fileInput = ui.el("input", { type: "file", accept: ".json,application/json", class: "nb-file", "aria-hidden": "true", tabindex: "-1" });
    const importBtn = ui.button("Import", { icon: "upload", title: "Merge records from an exported JSON file", onClick: () => { S.fileInput.click(); } });
    S.fileInput.addEventListener("change", () => {
      const file = S.fileInput.files && S.fileInput.files[0];
      const p = importFile(file).then(() => S.errorSlot.replaceChildren(), (err) => {
        fill(S.errorSlot, ui.errorBox(err));
        ui.toast(ui.errMessage(err), "bad");
      }).finally(() => { S.fileInput.value = ""; });
      ui.busy(importBtn, p);
    });
    S.statsEl = ui.el("div", { class: "nb-stats" });
    S.errorSlot = ui.el("div", { class: "form-error" });
    const card = ui.card({
      title: "Lab notebook", icon: "book",
      actions: [
        ui.button(null, { kind: "ghost", icon: "refresh", title: "Refresh", onClick: () => refresh() }),
        ui.button("Export", { icon: "download", title: "Download the whole notebook as JSON", onClick: exportNotebook }),
        importBtn,
      ],
    }, S.statsEl, filtersRow(), S.errorSlot, S.fileInput);
    S.subtitleEl = ui.el("p", { class: "card-subtitle" });
    const heading = card.querySelector(".card-heading");
    if (heading) heading.appendChild(S.subtitleEl);
    return card;
  }

  function noteCard() {
    const ui = ECCL.ui;
    S.noteForm = ui.form({
      fields: [
        { name: "text", label: "Note", type: "textarea", rows: 3, required: true, placeholder: "An observation, idea or next step…" },
        { name: "tags", label: "Tags", type: "text", placeholder: "comma, separated, tags", help: `Optional; up to ${MAX_TAGS}.`, validate: tagsError, span: "full" },
      ],
      columns: 1, submitLabel: "Add note", submitIcon: "plus",
      onSubmit: (v) => ECCL.api.post("/api/notebook/note", { text: v.text, tags: parseTags(v.tags) }).then((res) => {
        S.noteForm.setValues({ text: "", tags: "" });
        S.selectNext = res.id;
        ui.toast("Note added to the notebook", "ok", 2500);
        changed({ id: res.id, action: "note" });
      }),
    });
    return ui.card({ title: "Add a note", icon: "plus", subtitle: "Annotate your work; notes are exported with everything else." }, S.noteForm);
  }

  function filtersRow() {
    const ui = ECCL.ui;
    S.kindSeg = ui.segmented({ options: KINDS, value: S.kind, ariaLabel: "Record kind", onChange: (v) => { S.kind = v; paintTable(); } });
    S.search = ui.field({ name: "q", label: "Search", type: "text", placeholder: "text, id or tag", onChange: (v) => { S.q = v || ""; paintTable(); } });
    return ui.el("div", { class: "nb-filters" }, S.kindSeg, S.search);
  }

  function recordsCard() {
    const ui = ECCL.ui;
    S.countEl = ui.el("span", { class: "nb-count", "aria-live": "polite" });
    S.tableSlot = ui.el("div", null, ui.el("div", { class: "nb-loading" }, ui.spinner("Loading"), ui.el("span", null, "Loading notebook…")));
    return ui.card({ class: "nb-records", title: "Records", icon: "list", subtitle: "Newest first. Click a row for details; click a tag to filter by it.", actions: S.countEl }, S.tableSlot);
  }

  // ------------------------------------------------------------------ panel

  ECCL.registerPanel({
    id: "notebook",
    title: "Notebook",
    group: "AI & Data",
    icon: "book",
    description: "Lab history: analyses, runs and notes. Annotate, export and import.",
    order: 130,
    render(root, ctx) {
      const ui = ECCL.ui;
      injectStyle();
      S.ctx = ctx;
      S.detailCard = ui.card({ class: "nb-detail" });
      root.append(
        ui.el("p", { class: "nb-intro" },
          "Everything the lab records lands here: molecules you analyse, evolution runs and campaigns, materials and your own notes. ",
          "Filter and search the history, open a molecule back in the studio, and export or import the notebook as JSON."),
        ui.el("div", { class: "nb-top" }, overviewCard(), noteCard()),
        ui.el("div", { class: "nb-main" }, recordsCard(), ui.el("div", { class: "nb-side" }, S.detailCard)));
      paintDetail();
      paintStats();
      ctx.bus.on("notebook:changed", () => { refresh(); });
      const p = ctx.params || {};
      if (p.record) S.selectNext = String(p.record);
      S.shown = false;
      return refresh();
    },
    onShow(params) {
      const p = params || {};
      if (p.record && p.record !== S.selectedId) {
        if (S.records.some((r) => r.id === p.record)) select(p.record); else S.selectNext = String(p.record);
      }
      if (S.shown) refresh(); // render() already loaded it the first time
      S.shown = true;
    },
  });
})(window.ECCL);
