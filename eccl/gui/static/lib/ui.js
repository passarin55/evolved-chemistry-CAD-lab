/* ECCL.ui - DOM helpers and the component library.
 *
 * CSP-safe: no inline handlers, no eval. Every piece of user/server text is
 * inserted as a text node; the only innerHTML path is the `html` attribute of
 * ui.el() (trusted markup only). ui.molecule() sanitises SVG and imports it as
 * DOM nodes. See docs/gui.md section 3 for the contract.
 */
window.ECCL = window.ECCL || {};

(function (ECCL) {
  "use strict";

  const SVG_NS = "http://www.w3.org/2000/svg";
  let uidSeq = 0;
  const uid = (prefix = "eccl") => `${prefix}-${++uidSeq}`;

  // ------------------------------------------------------------------ el / svgEl

  const PROPS = new Set(["value", "checked", "selected", "indeterminate"]);
  const UNITLESS = new Set(["opacity", "zIndex", "flex", "flexGrow", "flexShrink", "fontWeight",
    "lineHeight", "order", "zoom", "gridColumnStart", "gridColumnEnd", "gridRowStart", "gridRowEnd"]);

  function setStyle(node, style) {
    if (style == null || style === false) return;
    if (typeof style === "string") { node.style.cssText = style; return; }
    for (const [k, v] of Object.entries(style)) {
      if (v == null || v === false) continue;
      const val = typeof v === "number" && !UNITLESS.has(k) && !k.startsWith("--") ? `${v}px` : String(v);
      if (k.includes("-")) node.style.setProperty(k, val);
      else node.style[k] = val;
    }
  }

  function applyAttrs(node, attrs) {
    const deferred = [];
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null) continue;
      if (k === "class" || k === "className") {
        const cls = Array.isArray(v) ? v.filter(Boolean).join(" ") : v;
        if (cls) node.setAttribute("class", cls);
      } else if (k === "style") {
        setStyle(node, v);
      } else if (k === "on") {
        for (const [evt, fn] of Object.entries(v)) if (typeof fn === "function") node.addEventListener(evt, fn);
      } else if (k === "dataset") {
        for (const [dk, dv] of Object.entries(v)) if (dv != null) node.dataset[dk] = String(dv);
      } else if (k === "html") {
        node.innerHTML = String(v); // trusted, server-generated markup only
      } else if (/^on[a-z]/i.test(k)) {
        // `onclick: fn` is accepted; string handlers are never set (CSP).
        if (typeof v === "function") node.addEventListener(k.slice(2).toLowerCase(), v);
      } else if (PROPS.has(k)) {
        deferred.push([k, v]);
      } else if (v === false) {
        continue;
      } else {
        node.setAttribute(k, v === true ? "" : String(v));
      }
    }
    return deferred;
  }

  function appendChildren(parent, children) {
    for (const c of children) {
      if (c === null || c === undefined || c === false || c === true) continue;
      if (c instanceof Node) parent.appendChild(c);
      else if (Array.isArray(c)) appendChildren(parent, c);
      else if (typeof c === "object" && typeof c[Symbol.iterator] === "function") appendChildren(parent, Array.from(c));
      else parent.appendChild(document.createTextNode(String(c)));
    }
    return parent;
  }

  function isAttrs(a) {
    return a !== null && typeof a === "object" && !(a instanceof Node) && !Array.isArray(a) &&
      typeof a[Symbol.iterator] !== "function";
  }

  function build(node, attrs, children) {
    if (!isAttrs(attrs)) { children.unshift(attrs); attrs = {}; }
    const deferred = applyAttrs(node, attrs);
    appendChildren(node, children);
    for (const [k, v] of deferred) {
      node[k] = v;
      if (k === "checked" && v) node.setAttribute("checked", "");
    }
    return node;
  }

  /** Create an HTML element. Children may be strings (text nodes), Nodes, arrays or null. */
  function el(tag, attrs, ...children) {
    return build(document.createElement(tag), attrs, children);
  }

  /** Create an SVG element (SVG namespace); same semantics as el(). */
  function svgEl(tag, attrs, ...children) {
    return build(document.createElementNS(SVG_NS, tag), attrs, children);
  }

  function clear(node) { if (node) node.replaceChildren(); return node; }

  // ------------------------------------------------------------------ icons

  // 24x24 line icons, stroke = currentColor. Strings are path data.
  const ICONS = {
    home: ["M3.5 10.4 12 3.6l8.5 6.8", "M5.6 8.9V19a1.5 1.5 0 0 0 1.5 1.5h3.4V15h3v5.5h3.4a1.5 1.5 0 0 0 1.5-1.5V8.9"],
    flask: ["M9 3.5h6", "M10 3.5v5.8L4.8 18.2a1.6 1.6 0 0 0 1.4 2.3h11.6a1.6 1.6 0 0 0 1.4-2.3L14 9.3V3.5", "M7.3 14.4h9.4"],
    atom: [{ t: "circle", cx: 12, cy: 12, r: 1.5, fill: "currentColor", stroke: "none" },
      { t: "ellipse", cx: 12, cy: 12, rx: 9.5, ry: 3.7 },
      { t: "ellipse", cx: 12, cy: 12, rx: 9.5, ry: 3.7, transform: "rotate(60 12 12)" },
      { t: "ellipse", cx: 12, cy: 12, rx: 9.5, ry: 3.7, transform: "rotate(-60 12 12)" }],
    chip: [{ t: "rect", x: 6, y: 6, width: 12, height: 12, rx: 2 }, { t: "rect", x: 9.5, y: 9.5, width: 5, height: 5, rx: 0.8 },
      "M9.5 2.5V6M14.5 2.5V6M9.5 18v3.5M14.5 18v3.5M2.5 9.5H6M2.5 14.5H6M18 9.5h3.5M18 14.5h3.5"],
    beam: ["M11 4.5 18.6 18H3.4z", "M1.5 13.4 7 11.8", "M15 11.4l7.5-2.6M15.9 13.4l6.6.5M16.9 15.3l5.4 3.1"],
    sparkle: ["M11 3.5c.6 3.9 2.6 5.9 6.5 6.5-3.9.6-5.9 2.6-6.5 6.5-.6-3.9-2.6-5.9-6.5-6.5 3.9-.6 5.9-2.6 6.5-6.5z",
      "M18.5 15c.25 1.6 1.05 2.35 2.5 2.5-1.45.15-2.25.9-2.5 2.5-.25-1.6-1.05-2.35-2.5-2.5 1.45-.15 2.25-.9 2.5-2.5z"],
    wave: ["M2 12c1.7-4.6 3.3-4.6 5 0s3.3 4.6 5 0 3.3-4.6 5 0 3.3 4.6 5 0"],
    grid: ["M5 5h14M5 12h14M5 19h14M5 5v14M12 5v14M19 5v14",
      ...[5, 12, 19].flatMap((y) => [5, 12, 19].map((x) => ({ t: "circle", cx: x, cy: y, r: 1.9, fill: "currentColor", stroke: "none" })))],
    spectrum: ["M2.5 20.5h19", "M5 20.5v-4.5M8.5 20.5V8M12 20.5v-7M15.5 20.5V4M19 20.5V11"],
    dna: ["M7 3c0 4.5 10 4.5 10 9s-10 4.5-10 9", "M17 3c0 4.5-10 4.5-10 9s10 4.5 10 9",
      "M8.7 5.7h6.6M8.7 9.3h6.6M8.7 14.7h6.6M8.7 18.3h6.6"],
    shield: ["M12 3 19.5 6v5.6c0 4.6-3.2 8.3-7.5 9.4-4.3-1.1-7.5-4.8-7.5-9.4V6z", "M8.8 12.1l2.2 2.2 4.3-4.5"],
    search: [{ t: "circle", cx: 10.5, cy: 10.5, r: 6.5 }, "M15.4 15.4 20.5 20.5"],
    chat: ["M20.5 14.5a2 2 0 0 1-2 2H9l-4.5 4v-15a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2z", "M8.5 8.5h7.5M8.5 12h4.5"],
    book: ["M5 19.5v-15A1.5 1.5 0 0 1 6.5 3H19v15H6.5A1.5 1.5 0 0 0 5 19.5 1.5 1.5 0 0 0 6.5 21H19", "M9 7.5h6"],
    play: [{ t: "path", d: "M7.5 5.1v13.8a.9.9 0 0 0 1.4.75l10.6-6.9a.9.9 0 0 0 0-1.5L8.9 4.35a.9.9 0 0 0-1.4.75z", fill: "currentColor" }],
    stop: [{ t: "rect", x: 6, y: 6, width: 12, height: 12, rx: 2, fill: "currentColor" }],
    sun: [{ t: "circle", cx: 12, cy: 12, r: 4 }, "M12 2.5v2M12 19.5v2M4.6 4.6 6 6M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4"],
    moon: ["M20 14.3A8 8 0 1 1 9.7 4a6.4 6.4 0 0 0 10.3 10.3z"],
    menu: ["M4 7h16M4 12h16M4 17h16"],
    download: ["M12 4v11", "M7.5 10.5 12 15l4.5-4.5", "M5 19.5h14"],
    upload: ["M12 15V4", "M7.5 8.5 12 4l4.5 4.5", "M5 19.5h14"],
    trash: ["M4.5 7h15", "M9.5 7V4.5h5V7", "M6.5 7l.9 12.1a1.5 1.5 0 0 0 1.5 1.4h6.2a1.5 1.5 0 0 0 1.5-1.4L17.5 7", "M10 11v6M14 11v6"],
    plus: ["M12 5v14M5 12h14"],
    refresh: ["M19.5 9.5A8 8 0 0 0 5.3 7.2", "M4.5 3.5v4h4", "M4.5 14.5a8 8 0 0 0 14.2 2.3", "M19.5 20.5v-4h-4"],
    check: ["M5 12.5l4.5 4.5L19 7.5"],
    x: ["M6.5 6.5l11 11M17.5 6.5l-11 11"],
    info: [{ t: "circle", cx: 12, cy: 12, r: 9 }, "M12 11v5.5", "M12 7.7v.1"],
    // extras used by the shell and components
    alert: ["M10.3 4.2 2.8 17.5a2 2 0 0 0 1.7 3h15a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0z", "M12 9.5v4.5", "M12 17.3v.1"],
    "chevron-down": ["M6 9.5l6 6 6-6"],
    "chevron-right": ["M9.5 6l6 6-6 6"],
    "chevron-left": ["M14.5 6l-6 6 6 6"],
    "chevron-up": ["M6 14.5l6-6 6 6"],
    copy: [{ t: "rect", x: 8.5, y: 8.5, width: 12, height: 12, rx: 2 }, "M15.5 8.5v-3a2 2 0 0 0-2-2h-8a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h3"],
    activity: ["M3 12h4l2.5-7 5 14 2.5-7h4"],
    external: ["M14 4h6v6", "M20 4l-9 9", "M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10"],
    logo: ["M12 2.8 20 7.4v9.2l-8 4.6-8-4.6V7.4z", { t: "circle", cx: 12, cy: 12, r: 3.6 }],
    table: [{ t: "rect", x: 3.5, y: 4.5, width: 17, height: 15, rx: 2 }, "M3.5 9.5h17M3.5 14.5h17M9.5 9.5v10"],
    clock: [{ t: "circle", cx: 12, cy: 12, r: 9 }, "M12 7v5l3.2 2"],
    list: ["M9 6.5h11M9 12h11M9 17.5h11", "M4.5 6.5h.1M4.5 12h.1M4.5 17.5h.1"],
    dot: [{ t: "circle", cx: 12, cy: 12, r: 3.2, fill: "currentColor", stroke: "none" }],
  };

  /** Inline SVG icon (stroke = currentColor). Unknown names render a neutral dot. */
  function icon(name, opts = {}) {
    const parts = ICONS[name] || ICONS.dot;
    const svg = svgEl("svg", {
      class: ["icon", `icon-${ICONS[name] ? name : "dot"}`, opts.class],
      viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": opts.strokeWidth || 1.8,
      "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true", focusable: "false",
      width: opts.size, height: opts.size,
    });
    for (const p of parts) {
      if (typeof p === "string") svg.appendChild(svgEl("path", { d: p }));
      else { const { t, ...attrs } = p; svg.appendChild(svgEl(t, attrs)); }
    }
    return svg;
  }
  icon.names = Object.keys(ICONS);

  // ------------------------------------------------------------------ number & text formatting

  const SUP = { 0: "⁰", 1: "¹", 2: "²", 3: "³", 4: "⁴", 5: "⁵", 6: "⁶", 7: "⁷", 8: "⁸", 9: "⁹", "-": "⁻", "+": "⁺" };
  const toSup = (s) => String(s).replace(/[0-9+-]/g, (ch) => SUP[ch]);
  const trimZeros = (s) => (s.includes(".") && !s.includes("e") ? s.replace(/\.?0+$/, "") : s);

  /** Always-scientific formatting: 1.23 × 10¹⁷ (digits = significant digits). */
  function fmtSci(value, digits = 3) {
    if (value === null || value === undefined || value === "") return "—";
    const x = typeof value === "number" ? value : Number(value);
    if (Number.isNaN(x)) return typeof value === "string" ? value : "—";
    if (!Number.isFinite(x)) return x > 0 ? "∞" : "-∞";
    if (x === 0) return "0";
    const d = Math.max(1, Math.min(21, Math.round(digits) || 3));
    const [m, e] = x.toExponential(d - 1).split("e");
    return `${trimZeros(m)}\u202f×\u202f10${toSup(parseInt(e, 10))}`;
  }

  /** Smart number formatting: scientific for |x| >= 1e5 or 0 < |x| < 1e-3, null -> "—". */
  function fmt(value, digits = 3) {
    if (value === null || value === undefined || value === "") return "—";
    if (typeof value === "boolean") return value ? "yes" : "no";
    if (typeof value === "bigint") return value.toString();
    if (typeof value !== "number") return String(value);
    if (Number.isNaN(value)) return "—";
    if (!Number.isFinite(value)) return value > 0 ? "∞" : "-∞";
    if (value === 0) return "0";
    const a = Math.abs(value);
    if (a >= 1e5 || a < 1e-3) return fmtSci(value, digits);
    if (Number.isInteger(value)) return String(value);
    const d = Math.max(1, Math.round(digits) || 3);
    const intDigits = a >= 1 ? Math.floor(Math.log10(a)) + 1 : 0;
    let s = value.toPrecision(Math.min(21, Math.max(d, intDigits)));
    if (s.includes("e")) s = String(Number(s));
    s = trimZeros(s);
    return s === "-0" ? "0" : s;
  }

  /** Render a chemical formula with subscripted counts and superscripted charges. */
  function formula(text) {
    const s = String(text ?? "");
    const root = el("span", { class: "formula" });
    let buf = "";
    const flush = () => { if (buf) { root.appendChild(document.createTextNode(buf)); buf = ""; } };
    const word = (ch) => /[A-Za-z)\]]/.test(ch || "");
    const tokenEnd = (j) => j >= s.length || /[\s,;)\]·*/]/.test(s[j]);
    let i = 0;
    while (i < s.length) {
      const ch = s[i];
      if (ch === "^") {
        let j = i + 1, sup = "";
        if (s[j] === "{") { j++; while (j < s.length && s[j] !== "}") sup += s[j++]; j++; }
        else while (j < s.length && /[0-9+-]/.test(s[j])) sup += s[j++];
        if (sup) { flush(); root.appendChild(el("sup", null, sup)); i = j; continue; }
      }
      if (/[0-9]/.test(ch) && word(s[i - 1])) {
        let j = i;
        while (j < s.length && /[0-9.]/.test(s[j])) j++;
        if (s[j - 1] === ".") j--;
        const digits = s.slice(i, j);
        if ((s[j] === "+" || s[j] === "-") && tokenEnd(j + 1)) {
          flush(); root.appendChild(el("sup", null, digits + s[j])); i = j + 1; continue;
        }
        flush(); root.appendChild(el("sub", null, digits)); i = j; continue;
      }
      if ((ch === "+" || ch === "-") && word(s[i - 1]) && tokenEnd(i + 1)) {
        flush(); root.appendChild(el("sup", null, ch)); i++; continue;
      }
      buf += ch; i++;
    }
    flush();
    return root;
  }

  /** CSS colour for a visible wavelength (380-780 nm); gray outside. */
  function wavelengthToColor(nm) {
    const w = Number(nm);
    if (!(w >= 380 && w <= 780)) return "rgb(128, 128, 128)";
    let r = 0, g = 0, b = 0;
    if (w < 440) { r = (440 - w) / 60; b = 1; }
    else if (w < 490) { g = (w - 440) / 50; b = 1; }
    else if (w < 510) { g = 1; b = (510 - w) / 20; }
    else if (w < 580) { r = (w - 510) / 70; g = 1; }
    else if (w < 645) { r = 1; g = (645 - w) / 65; }
    else r = 1;
    const f = w < 420 ? 0.3 + (0.7 * (w - 380)) / 40 : w > 700 ? 0.3 + (0.7 * (780 - w)) / 80 : 1;
    const c = (v) => Math.round(255 * Math.pow(v * f, 0.8));
    return `rgb(${c(r)}, ${c(g)}, ${c(b)})`;
  }

  // ------------------------------------------------------------------ small components

  const KINDS = { ok: "ok", success: "ok", good: "ok", warn: "warn", warning: "warn", bad: "bad", error: "bad",
    danger: "bad", info: "info", neutral: "neutral" };
  const kindOf = (k, dflt = "neutral") => KINDS[k] || dflt;
  const KIND_ICON = { ok: "check", warn: "alert", bad: "alert", info: "info", neutral: "info" };

  function errMessage(err) {
    if (err == null) return "Unknown error";
    if (typeof err === "string") return err;
    if (err.message) return err.message;
    if (err.error) return String(err.error);
    return String(err);
  }

  function badge(text, kind = "neutral") {
    const k = kindOf(kind);
    return el("span", { class: `badge badge-${k}` }, el("span", { class: "badge-dot", "aria-hidden": "true" }), text);
  }

  function spinner(label = "Loading") {
    return el("span", { class: "spinner", role: "status", "aria-label": label });
  }

  function empty(message = "Nothing to show yet") {
    return el("div", { class: "empty" }, el("span", { class: "empty-icon" }, icon("list")), el("p", { class: "empty-msg" }, message));
  }

  function errorBox(errOrMessage) {
    const err = errOrMessage;
    const status = err && typeof err === "object" ? err.status : undefined;
    const title = status === 0 ? "Server unreachable" : status >= 500 ? "Server error"
      : status >= 400 ? "Request rejected" : "Something went wrong";
    const meta = [status ? `HTTP ${status}` : null, err && typeof err === "object" && err.type ? err.type : null]
      .filter(Boolean).join(" · ");
    return el("div", { class: "error-box", role: "alert" },
      icon("alert", { class: "error-box-icon" }),
      el("div", { class: "error-box-body" },
        el("div", { class: "error-box-title" }, title),
        el("div", { class: "error-box-msg" }, errMessage(err)),
        meta ? el("div", { class: "error-box-meta" }, meta) : null));
  }

  function notice(text, kind = "info") {
    const k = kindOf(kind, "info");
    return el("div", { class: `notice notice-${k}`, role: k === "bad" ? "alert" : null },
      icon(KIND_ICON[k], { class: "notice-icon" }), el("div", { class: "notice-body" }, text));
  }

  function stat({ label, value, unit, hint, kind } = {}) {
    const v = value instanceof Node ? value : typeof value === "number" ? fmt(value, 4) : (value ?? "—");
    return el("div", { class: ["stat", kind && `stat-${kindOf(kind)}`] },
      el("div", { class: "stat-label" }, label),
      el("div", { class: "stat-value" }, el("span", { class: "stat-number" }, v),
        unit ? el("span", { class: "stat-unit" }, unit) : null),
      hint ? el("div", { class: "stat-hint" }, hint) : null);
  }

  function meter({ value, min = 0, max = 1, label, kind, format } = {}) {
    const v = value === null || value === undefined || value === "" ? NaN : Number(value);
    const ok = Number.isFinite(v);
    const span = max - min || 1;
    const pct = ok ? Math.max(0, Math.min(100, ((v - min) / span) * 100)) : 0;
    const text = !ok ? "—" : format ? format(v) : fmt(v);
    const fill = el("div", { class: "meter-fill", style: { width: `${pct}%` } });
    return el("div", { class: ["meter", `meter-${kindOf(kind, "info")}`] },
      el("div", { class: "meter-head" },
        label != null ? el("span", { class: "meter-label" }, label) : null,
        el("span", { class: "meter-value" }, text)),
      el("div", {
        class: "meter-track", role: "meter", "aria-valuemin": min, "aria-valuemax": max,
        "aria-valuenow": ok ? v : null, "aria-valuetext": text, "aria-label": typeof label === "string" ? label : "value",
      }, fill));
  }

  // ------------------------------------------------------------------ toasts

  function toastRoot() {
    let root = document.getElementById("toasts");
    if (!root) {
      root = el("div", { id: "toasts", class: "toasts", "aria-live": "polite", "aria-relevant": "additions" });
      document.body.appendChild(root);
    }
    return root;
  }

  /** Transient notification. kind: info | ok | warn | bad. ms = 0 keeps it until dismissed. */
  function toast(message, kind = "info", ms = 4000) {
    const k = kindOf(kind, "info");
    const root = toastRoot();
    let timer = 0;
    const close = () => {
      clearTimeout(timer);
      t.classList.add("is-leaving");
      setTimeout(() => t.remove(), 160);
    };
    const t = el("div", { class: `toast toast-${k}`, role: k === "bad" ? "alert" : null }, // container is aria-live
      icon(KIND_ICON[k], { class: "toast-icon" }),
      el("div", { class: "toast-msg" }, message instanceof Node ? message : errMessage(message)),
      el("button", { type: "button", class: "toast-close", "aria-label": "Dismiss notification", on: { click: close } }, icon("x")));
    const arm = () => { if (ms > 0) timer = setTimeout(close, ms); };
    t.addEventListener("pointerenter", () => clearTimeout(timer));
    t.addEventListener("pointerleave", arm);
    root.appendChild(t);
    while (root.children.length > 4) root.firstElementChild.remove();
    arm();
  }

  // ------------------------------------------------------------------ buttons

  /** Disable a button and show a spinner until the promise settles. Returns the promise. */
  function busy(buttonEl, promise) {
    const p = Promise.resolve(promise);
    if (!buttonEl) return promise && typeof promise.then === "function" ? promise : p;
    const b = buttonEl;
    b._ecclBusy = (b._ecclBusy || 0) + 1;
    if (b._ecclBusy === 1) {
      b._ecclWasDisabled = b.disabled;
      b.disabled = true;
      b.classList.add("is-busy");
      b.setAttribute("aria-busy", "true");
      b.appendChild(el("span", { class: "btn-spinner", "aria-hidden": "true" }));
    }
    const done = () => {
      b._ecclBusy = Math.max(0, (b._ecclBusy || 1) - 1);
      if (b._ecclBusy) return;
      b.disabled = !!b._ecclWasDisabled;
      b.classList.remove("is-busy");
      b.removeAttribute("aria-busy");
      b.querySelectorAll(":scope > .btn-spinner").forEach((n) => n.remove());
    };
    p.then(done, done);
    return promise && typeof promise.then === "function" ? promise : p;
  }

  function button(label, opts = {}) {
    const { kind = "secondary", onClick, icon: ic, small, title, type = "button", disabled } = opts;
    const hasLabel = label !== undefined && label !== null && label !== "";
    const b = el("button", {
      type, class: ["btn", `btn-${kind}`, small && "btn-sm", !hasLabel && ic && "btn-icon", opts.class],
      title: title || null, "aria-label": !hasLabel ? (title || ic || "button") : null, disabled: !!disabled,
    }, ic ? icon(ic) : null, hasLabel ? el("span", { class: "btn-label" }, label) : null);
    if (typeof onClick === "function") {
      b.addEventListener("click", (ev) => {
        const r = onClick(ev);
        if (r && typeof r.then === "function") {
          busy(b, r);
          r.then(null, (err) => { if (!(err && err.name === "AbortError")) toast(errMessage(err), "bad"); });
        }
      });
    }
    return b;
  }

  // ------------------------------------------------------------------ layout

  function card(opts, ...children) {
    if (typeof opts === "string") opts = { title: opts };
    if (!isAttrs(opts)) { children.unshift(opts); opts = {}; }
    const { title, subtitle, actions } = opts;
    const header = title || subtitle || actions
      ? el("div", { class: "card-header" },
        el("div", { class: "card-heading" },
          title ? el("h3", { class: "card-title" }, opts.icon ? icon(opts.icon) : null, title) : null,
          subtitle ? el("p", { class: "card-subtitle" }, subtitle) : null),
        actions ? el("div", { class: "card-actions" }, actions) : null)
      : null;
    const c = el("div", { class: ["card", opts.class] }, header, children);
    c.body = c;
    return c;
  }

  function grid(cols, ...children) {
    let n = cols;
    if (typeof n !== "number") { children.unshift(cols); n = 2; }
    n = Math.max(1, Math.min(4, Math.round(n)));
    return el("div", { class: `grid grid-${n}`, style: { "--cols": String(n) } }, children);
  }

  function section(title, ...children) {
    return el("section", { class: "section" }, title ? el("h2", { class: "section-title" }, title) : null, children);
  }

  // ------------------------------------------------------------------ fields & forms

  function normOptions(options) {
    return (options || []).map((o) => (o !== null && typeof o === "object"
      ? { key: String(o.value), value: o.value, label: o.label ?? String(o.value), disabled: !!o.disabled, icon: o.icon }
      : { key: String(o), value: o, label: String(o) }));
  }

  /** Parse plain or scientific notation: 1e17, 1.5E-3, 1.5x10^17, 2×10^-4, 10^6. NaN if invalid; null if empty. */
  function parseSci(text) {
    let s = String(text ?? "").trim();
    if (!s) return null;
    s = s.replace(/[\s_]/g, "").replace(/[−–]/g, "-");
    if (/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(s)) return Number(s);
    let m = s.match(/^([+-]?(?:\d+\.?\d*|\.\d+))[x×*·]10\^?([+-]?\d+)$/i);
    if (m) return Number(m[1]) * Math.pow(10, Number(m[2]));
    m = s.match(/^10\^([+-]?\d+)$/);
    if (m) return Math.pow(10, Number(m[1]));
    return NaN;
  }

  function sciText(v) {
    if (v === null || v === undefined || v === "") return "";
    const n = Number(v);
    if (!Number.isFinite(n)) return String(v);
    const a = Math.abs(n);
    if (a !== 0 && (a >= 1e5 || a < 1e-3)) return n.toExponential().replace("e+", "e").replace(/\.?0+e/, "e");
    return String(n);
  }

  /** Labelled form control. Returns a .field element with getValue()/setValue()/validate() and .input. */
  function field(spec = {}) {
    const type = spec.type || "text";
    const id = uid("f");
    const helpId = spec.help ? `${id}-help` : null;
    const errId = `${id}-err`;
    const mono = spec.mono ?? /smiles|formula/i.test(String(spec.name || ""));
    const wrap = el("div", { class: ["field", `field-${type}`], dataset: { name: spec.name } });
    const describedBy = [helpId, errId].filter(Boolean).join(" ");
    const base = {
      id, name: spec.name || null, "aria-describedby": describedBy, required: !!spec.required,
      disabled: !!spec.disabled, placeholder: spec.placeholder ?? null,
    };
    const labelText = spec.label ?? spec.name ?? "";
    const reqMark = spec.required ? el("span", { class: "field-req", "aria-hidden": "true" }, "*") : null;
    let input, control, getValue, setValue, output = null;

    if (type === "select") {
      const opts = normOptions(spec.options);
      input = el("select", { ...base, class: "input select" },
        opts.map((o) => el("option", { value: o.key, disabled: o.disabled }, o.label)));
      control = el("div", { class: "select-wrap" }, input);
      getValue = () => { const o = opts.find((x) => x.key === input.value); return o ? o.value : input.value; };
      setValue = (v) => {
        const o = opts.find((x) => x.value === v) || opts.find((x) => x.key === String(v));
        if (o) input.value = o.key;
      };
    } else if (type === "textarea") {
      input = el("textarea", { ...base, class: ["input", "textarea", mono && "mono"], rows: spec.rows || 4, spellcheck: mono ? "false" : null });
      control = input;
      getValue = () => input.value;
      setValue = (v) => { input.value = v == null ? "" : Array.isArray(v) ? v.join("\n") : String(v); };
    } else if (type === "checkbox") {
      input = el("input", { ...base, type: "checkbox", class: "checkbox", placeholder: null, required: null });
      control = el("label", { class: "check", for: id }, input, el("span", { class: "check-label" }, labelText));
      getValue = () => input.checked;
      setValue = (v) => { input.checked = !!v; };
    } else if (type === "range") {
      const min = spec.min ?? 0, max = spec.max ?? 100;
      input = el("input", { ...base, type: "range", class: "range", min, max, step: spec.step ?? "any", placeholder: null });
      output = el("output", { class: "range-value", for: id });
      const show = () => { output.textContent = spec.format ? spec.format(Number(input.value)) : fmt(Number(input.value)) + (spec.unit ? ` ${spec.unit}` : ""); };
      input.addEventListener("input", show);
      control = input;
      getValue = () => Number(input.value);
      setValue = (v) => { if (v !== null && v !== undefined && v !== "") input.value = String(v); show(); };
      wrap._showRange = show;
    } else if (type === "number") {
      input = el("input", {
        ...base, type: "number", class: "input", inputmode: "decimal", min: spec.min ?? null, max: spec.max ?? null,
        step: spec.step ?? "any",
      });
      control = input;
      getValue = () => (input.value.trim() === "" ? (input.validity.badInput ? NaN : null) : Number(input.value));
      setValue = (v) => { input.value = v === null || v === undefined || Number.isNaN(v) ? "" : String(v); };
    } else if (type === "sci") {
      input = el("input", {
        ...base, type: "text", class: "input", inputmode: "decimal", autocomplete: "off", spellcheck: "false",
        placeholder: spec.placeholder ?? "e.g. 1e17",
      });
      control = input;
      getValue = () => parseSci(input.value);
      setValue = (v) => { input.value = sciText(v); };
    } else {
      input = el("input", {
        ...base, type: type === "text" ? "text" : type, class: ["input", mono && "mono"],
        autocomplete: "off", spellcheck: mono ? "false" : null,
      });
      control = input;
      getValue = () => (type === "text" ? input.value.trim() : input.value);
      setValue = (v) => { input.value = v == null ? "" : String(v); };
    }

    const errEl = el("div", { class: "field-error", id: errId, "aria-live": "polite" });
    if (type === "checkbox") {
      wrap.append(control);
    } else {
      wrap.append(el("div", { class: "field-head" },
        el("label", { class: "field-label", for: id }, labelText, reqMark), output), control);
    }
    if (spec.help) wrap.append(el("div", { class: "field-help", id: helpId }, spec.help));
    wrap.append(errEl);

    const setError = (msg) => {
      errEl.textContent = msg || "";
      wrap.classList.toggle("has-error", !!msg);
      if (msg) input.setAttribute("aria-invalid", "true"); else input.removeAttribute("aria-invalid");
    };
    const validate = () => {
      const v = getValue();
      let msg = null;
      if (type === "checkbox") msg = null;
      else if (spec.required && (v === null || v === "" || (typeof v === "string" && !v.trim()))) msg = "Required";
      else if ((type === "number" || type === "sci" || type === "range") && v !== null) {
        if (Number.isNaN(v)) msg = type === "sci" ? "Enter a number (e.g. 1e17)" : "Enter a number";
        else if (spec.min !== undefined && spec.min !== null && v < spec.min) msg = `Must be ≥ ${fmt(spec.min)}`;
        else if (spec.max !== undefined && spec.max !== null && v > spec.max) msg = `Must be ≤ ${fmt(spec.max)}`;
      }
      if (!msg && typeof spec.validate === "function") msg = spec.validate(v) || null;
      setError(msg);
      return msg;
    };
    input.addEventListener("input", () => { if (wrap.classList.contains("has-error")) validate(); });
    if (typeof spec.onChange === "function") {
      input.addEventListener(type === "checkbox" || type === "select" ? "change" : "input", () => spec.onChange(getValue(), wrap));
    }

    if (spec.value !== undefined) setValue(spec.value);
    else if (type === "range") setValue((Number(spec.min ?? 0) + Number(spec.max ?? 100)) / 2);

    wrap.input = input;
    wrap.name = spec.name;
    wrap.spec = spec;
    wrap.getValue = getValue;
    wrap.setValue = setValue;
    wrap.validate = validate;
    wrap.setError = setError;
    return wrap;
  }

  /** <form> with labelled fields, a submit button with busy state, inline errors and optional live mode. */
  function form(opts = {}) {
    const { fields = [], submitLabel = "Run", onSubmit, columns = 2, live = false, actions } = opts;
    const cols = Math.max(1, Math.min(4, Math.round(columns) || 2));
    const f = el("form", { class: ["form", live && "form-live"], novalidate: true });
    const gridEl = el("div", { class: `form-grid form-cols-${cols}`, style: { "--cols": String(cols) } });
    const fieldEls = [];
    for (const spec of fields) {
      if (!spec) continue;
      if (spec instanceof Node) { gridEl.appendChild(spec); continue; }
      const fe = field(spec);
      if (spec.type === "textarea" || spec.span === "full" || spec.full) fe.classList.add("span-full");
      fieldEls.push(fe);
      gridEl.appendChild(fe);
    }
    const errorSlot = el("div", { class: "form-error" });
    const submitIcon = opts.submitIcon !== undefined ? opts.submitIcon : submitLabel === "Run" ? "play" : null;
    const submitBtn = submitLabel ? button(submitLabel, { kind: "primary", icon: submitIcon, type: "submit" }) : null;
    const extra = actions ? (Array.isArray(actions) ? actions : [actions]) : [];
    f.append(gridEl, errorSlot);
    if (submitBtn || extra.length) f.append(el("div", { class: "form-actions" }, submitBtn, extra));

    const getValues = () => {
      const out = {};
      for (const fe of fieldEls) if (fe.name) out[fe.name] = fe.getValue();
      return out;
    };
    const setValues = (obj = {}) => {
      for (const fe of fieldEls) {
        if (fe.name && Object.prototype.hasOwnProperty.call(obj, fe.name)) { fe.setValue(obj[fe.name]); fe.setError(null); }
      }
    };

    let pending = null, rerun = false, lastToast = { msg: "", at: 0 }, debounce = 0;
    const run = (fromLive = false) => {
      if (pending) { if (fromLive) rerun = true; return pending; }
      let firstBad = null;
      for (const fe of fieldEls) if (fe.validate() && !firstBad) firstBad = fe;
      if (firstBad) {
        if (!fromLive) firstBad.input.focus();
        return Promise.resolve(undefined);
      }
      const values = getValues();
      let p;
      try { p = Promise.resolve(typeof onSubmit === "function" ? onSubmit(values, f) : undefined); }
      catch (err) { p = Promise.reject(err); }
      if (submitBtn) busy(submitBtn, p);
      f.classList.add("is-pending");
      f.setAttribute("aria-busy", "true");
      pending = p.then((result) => { errorSlot.replaceChildren(); return result; }, (err) => {
        errorSlot.replaceChildren(errorBox(err));
        const msg = errMessage(err);
        const now = Date.now();
        if (!(fromLive && msg === lastToast.msg && now - lastToast.at < 5000)) toast(msg, "bad");
        lastToast = { msg, at: now };
        return undefined;
      }).finally(() => {
        pending = null;
        f.classList.remove("is-pending");
        f.removeAttribute("aria-busy");
        if (rerun) { rerun = false; run(true); }
      });
      return pending;
    };

    f.addEventListener("submit", (ev) => { ev.preventDefault(); clearTimeout(debounce); run(false); });
    if (live) {
      const schedule = () => { clearTimeout(debounce); debounce = setTimeout(() => run(true), 300); };
      f.addEventListener("input", schedule);
      f.addEventListener("change", schedule);
    }

    f.getValues = getValues;
    f.setValues = setValues;
    f.submit = () => { clearTimeout(debounce); return run(false); };
    f.field = (name) => fieldEls.find((fe) => fe.name === name) || null;
    f.fields = fieldEls;
    f.submitButton = submitBtn;
    return f;
  }

  // ------------------------------------------------------------------ segmented & tabs

  function segmented({ options = [], value, onChange, ariaLabel, small } = {}) {
    const opts = normOptions(options);
    let current = opts.find((o) => o.value === value) || opts.find((o) => o.key === String(value)) || opts[0] || null;
    const root = el("div", { class: ["segmented", small && "segmented-sm"], role: "radiogroup", "aria-label": ariaLabel || null });
    const btns = opts.map((o) => el("button", {
      type: "button", class: "seg", role: "radio", disabled: o.disabled, dataset: { value: o.key },
      on: { click: () => select(o, true) },
    }, o.icon ? icon(o.icon) : null, el("span", null, o.label)));
    root.append(...btns);
    function paint() {
      opts.forEach((o, i) => {
        const on = o === current;
        btns[i].setAttribute("aria-checked", on ? "true" : "false");
        btns[i].tabIndex = on || (!current && i === 0) ? 0 : -1;
        btns[i].classList.toggle("is-active", on);
      });
    }
    function select(o, fire, focus) {
      if (!o || o.disabled) return;
      const changed = o !== current;
      current = o;
      paint();
      if (focus) btns[opts.indexOf(o)].focus();
      if (fire && changed && typeof onChange === "function") onChange(o.value);
    }
    root.addEventListener("keydown", (ev) => {
      const enabled = opts.filter((o) => !o.disabled);
      if (!enabled.length) return;
      const i = Math.max(0, enabled.indexOf(current));
      let next = null;
      if (ev.key === "ArrowRight" || ev.key === "ArrowDown") next = enabled[(i + 1) % enabled.length];
      else if (ev.key === "ArrowLeft" || ev.key === "ArrowUp") next = enabled[(i - 1 + enabled.length) % enabled.length];
      else if (ev.key === "Home") next = enabled[0];
      else if (ev.key === "End") next = enabled[enabled.length - 1];
      if (next) { ev.preventDefault(); select(next, true, true); }
    });
    paint();
    root.getValue = () => (current ? current.value : undefined);
    root.setValue = (v) => select(opts.find((o) => o.value === v) || opts.find((o) => o.key === String(v)), false);
    Object.defineProperty(root, "value", { get: root.getValue, set: root.setValue });
    return root;
  }

  /** Tabs with lazily rendered panels (rendered on first open, kept afterwards). */
  function tabs(items = [], opts = {}) {
    const base = uid("tabs");
    const list = el("div", { class: "tabs-list", role: "tablist", "aria-label": opts.ariaLabel || null });
    const panels = el("div", { class: "tabs-panels" });
    const root = el("div", { class: "tabs" }, list, panels);
    const entries = items.map((it, i) => {
      const tabId = `${base}-t${i}`, panelId = `${base}-p${i}`;
      const btn = el("button", {
        type: "button", class: "tab", role: "tab", id: tabId, "aria-controls": panelId, "aria-selected": "false",
        tabindex: "-1", dataset: { tab: it.id },
      }, it.icon ? icon(it.icon) : null, el("span", null, it.label ?? it.id));
      const panel = el("div", { class: "tab-panel", role: "tabpanel", id: panelId, "aria-labelledby": tabId, tabindex: "0", hidden: true });
      list.appendChild(btn);
      panels.appendChild(panel);
      const entry = { item: it, btn, panel, rendered: false };
      btn.addEventListener("click", () => select(it.id));
      return entry;
    });
    let active = null;
    function renderEntry(e) {
      e.rendered = true;
      try {
        const out = typeof e.item.render === "function" ? e.item.render() : null;
        if (out && typeof out.then === "function") {
          const sp = el("div", { class: "tab-loading" }, spinner());
          e.panel.appendChild(sp);
          out.then((node) => { sp.remove(); appendChildren(e.panel, [node]); },
            (err) => { sp.remove(); e.panel.appendChild(errorBox(err)); });
        } else appendChildren(e.panel, [out]);
      } catch (err) {
        console.error("[ECCL] tab render failed", err);
        e.panel.appendChild(errorBox(err));
      }
    }
    function select(id, focus) {
      const e = entries.find((x) => x.item.id === id);
      if (!e) return;
      for (const x of entries) {
        const on = x === e;
        x.btn.setAttribute("aria-selected", on ? "true" : "false");
        x.btn.tabIndex = on ? 0 : -1;
        x.btn.classList.toggle("is-active", on);
        x.panel.hidden = !on;
      }
      if (!e.rendered) renderEntry(e);
      if (focus) e.btn.focus();
      const changed = active !== id;
      active = id;
      if (changed && typeof opts.onChange === "function") opts.onChange(id);
    }
    list.addEventListener("keydown", (ev) => {
      const i = entries.findIndex((x) => x.item.id === active);
      let j = null;
      if (ev.key === "ArrowRight") j = (i + 1) % entries.length;
      else if (ev.key === "ArrowLeft") j = (i - 1 + entries.length) % entries.length;
      else if (ev.key === "Home") j = 0;
      else if (ev.key === "End") j = entries.length - 1;
      if (j !== null && entries[j]) { ev.preventDefault(); select(entries[j].item.id, true); }
    });
    const initial = opts.initial !== undefined && entries.some((x) => x.item.id === opts.initial) ? opts.initial : items[0] && items[0].id;
    if (initial !== undefined) select(initial);
    root.select = (id) => select(id);
    root.getActive = () => active;
    return root;
  }

  // ------------------------------------------------------------------ table & key/value

  function getPath(row, key) {
    if (row == null) return undefined;
    if (Object.prototype.hasOwnProperty.call(row, key)) return row[key];
    if (typeof key === "string" && key.includes(".")) return key.split(".").reduce((o, k) => (o == null ? undefined : o[k]), row);
    return row[key];
  }

  function boolNode(v) {
    return el("span", { class: `bool bool-${v ? "yes" : "no"}` }, icon(v ? "check" : "x"), el("span", null, v ? "yes" : "no"));
  }

  function valueNode(v) {
    if (v instanceof Node) return v;
    if (typeof v === "boolean") return boolNode(v);
    if (typeof v === "number") return fmt(v, 4);
    if (v === null || v === undefined || v === "") return "—";
    if (Array.isArray(v)) return v.length ? v.map((x) => (typeof x === "number" ? fmt(x, 4) : typeof x === "object" && x !== null ? JSON.stringify(x) : String(x))).join(", ") : "—";
    if (typeof v === "object") return JSON.stringify(v);
    return String(v);
  }

  function table(opts = {}) {
    const { columns, rows, empty: emptyMsg = "No data", onRowClick, maxHeight, sortable = true, caption } = opts;
    const wrap = el("div", { class: "table-wrap" });
    if (maxHeight) wrap.style.maxHeight = typeof maxHeight === "number" ? `${maxHeight}px` : maxHeight;
    let data = Array.isArray(rows) ? rows.slice() : [];
    let sortKey = null, sortDir = 1;

    const colsFor = () => (columns && columns.length ? columns
      : Object.keys(data[0] || {}).map((k) => ({ key: k, label: k.replace(/_/g, " ") })));

    function alignFor(col) {
      if (col.align) return col.align;
      let seen = false;
      for (const r of data) {
        const v = getPath(r, col.key);
        if (v === null || v === undefined || v === "") continue;
        if (typeof v !== "number") return "left";
        seen = true;
      }
      return seen ? "right" : "left";
    }

    function sorted() {
      if (sortKey === null) return data;
      const col = colsFor().find((c) => c.key === sortKey);
      const val = (r) => (col && typeof col.sortValue === "function" ? col.sortValue(r) : getPath(r, sortKey));
      return data.map((r, i) => [r, i]).sort((a, b) => {
        const va = val(a[0]), vb = val(b[0]);
        const na = va === null || va === undefined || va === "" || (typeof va === "number" && Number.isNaN(va));
        const nb = vb === null || vb === undefined || vb === "" || (typeof vb === "number" && Number.isNaN(vb));
        if (na || nb) return na === nb ? a[1] - b[1] : na ? 1 : -1;
        let c;
        if (typeof va === "number" && typeof vb === "number") c = va - vb;
        else if (typeof va === "boolean" && typeof vb === "boolean") c = Number(va) - Number(vb);
        else c = String(va).localeCompare(String(vb), undefined, { numeric: true, sensitivity: "base" });
        return c * sortDir || a[1] - b[1];
      }).map((x) => x[0]);
    }

    function render() {
      const cols = colsFor();
      const aligns = cols.map(alignFor);
      const head = el("tr", null, cols.map((c, i) => {
        const label = c.label ?? c.key;
        const canSort = sortable && c.sortable !== false && data.length > 1;
        const active = sortKey === c.key;
        const th = el("th", {
          scope: "col", class: [`align-${aligns[i]}`, active && "is-sorted"],
          style: c.width ? { width: typeof c.width === "number" ? `${c.width}px` : c.width } : null,
          "aria-sort": active ? (sortDir > 0 ? "ascending" : "descending") : null,
        });
        if (canSort) {
          th.appendChild(el("button", {
            type: "button", class: "th-sort",
            on: { click: () => { if (sortKey === c.key) sortDir = -sortDir; else { sortKey = c.key; sortDir = 1; } render(); } },
          }, el("span", null, label), icon(active && sortDir < 0 ? "chevron-up" : "chevron-down", { class: "th-sort-icon" })));
        } else th.appendChild(typeof label === "string" ? document.createTextNode(label) : label);
        return th;
      }));
      const body = el("tbody");
      const list = sorted();
      if (!list.length) {
        body.appendChild(el("tr", { class: "table-empty" }, el("td", { colspan: cols.length || 1 }, emptyMsg)));
      }
      list.forEach((r, ri) => {
        const tr = el("tr", null, cols.map((c, i) => {
          const v = getPath(r, c.key);
          let content;
          try { content = typeof c.format === "function" ? c.format(v, r) : valueNode(v); }
          catch (err) { content = "!"; console.error("[ECCL] table format failed", err); }
          const isMono = c.mono ?? /smiles/i.test(String(c.key));
          return el("td", { class: [`align-${aligns[i]}`, isMono && "mono", aligns[i] === "right" && "num"] }, content ?? "—");
        }));
        if (typeof onRowClick === "function") {
          tr.classList.add("is-clickable");
          tr.tabIndex = 0;
          const fire = (ev) => {
            if (ev.target instanceof Element && ev.target.closest("button, a, input, select, textarea, label") &&
              ev.target.closest("tr") === tr && ev.target !== tr) return;
            onRowClick(r, ri, ev);
          };
          tr.addEventListener("click", fire);
          tr.addEventListener("keydown", (ev) => {
            if ((ev.key === "Enter" || ev.key === " ") && ev.target === tr) { ev.preventDefault(); fire(ev); }
          });
        }
        body.appendChild(tr);
      });
      const t = el("table", { class: ["table", typeof onRowClick === "function" && "table-clickable"] },
        caption ? el("caption", null, caption) : null, el("thead", null, head), body);
      wrap.replaceChildren(t);
    }
    wrap.setRows = (r) => { data = Array.isArray(r) ? r.slice() : []; render(); };
    render();
    return wrap;
  }

  function kv(objOrPairs, opts = {}) {
    const { format } = opts;
    let pairs;
    if (Array.isArray(objOrPairs)) {
      pairs = objOrPairs.map((p) => (Array.isArray(p) ? p : [p.label ?? p.key ?? p.name, p.value]));
    } else pairs = Object.entries(objOrPairs || {});
    const dl = el("dl", { class: "kv" });
    for (const [k, v] of pairs) {
      let content;
      try { content = typeof format === "function" ? format(v, k) : undefined; } catch (err) { content = undefined; }
      if (content === undefined) content = valueNode(v);
      const numeric = typeof v === "number";
      dl.appendChild(el("div", { class: "kv-row" },
        el("dt", null, typeof k === "string" ? k.replace(/_/g, " ") : k),
        el("dd", { class: numeric ? "num" : null }, content)));
    }
    if (!pairs.length) dl.appendChild(el("div", { class: "kv-row kv-empty" }, el("dd", null, "—")));
    return dl;
  }

  // ------------------------------------------------------------------ JSON viewer

  function safeStringify(obj) {
    const seen = new WeakSet();
    try {
      return JSON.stringify(obj, (k, v) => {
        if (typeof v === "object" && v !== null) { if (seen.has(v)) return "[circular]"; seen.add(v); }
        if (typeof v === "bigint") return v.toString();
        return v;
      }, 2) ?? "null";
    } catch (err) { return String(obj); }
  }

  function highlightJson(text) {
    const frag = document.createDocumentFragment();
    const re = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false)\b|\bnull\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;
    let last = 0, m;
    while ((m = re.exec(text))) {
      if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      let cls;
      if (m[1]) cls = m[2] ? "json-key" : "json-str";
      else if (m[3]) cls = "json-bool";
      else if (m[0] === "null") cls = "json-null";
      else cls = "json-num";
      if (m[1] && m[2]) {
        frag.appendChild(el("span", { class: cls }, m[1]));
        frag.appendChild(document.createTextNode(m[2]));
      } else frag.appendChild(el("span", { class: cls }, m[0]));
      last = re.lastIndex;
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    return frag;
  }

  function json(obj, opts = {}) {
    const { collapsed = true, title = "Raw JSON" } = opts;
    const meta = Array.isArray(obj) ? `${obj.length} items` : obj && typeof obj === "object" ? `${Object.keys(obj).length} keys` : typeof obj;
    const details = el("details", { class: "json-view" });
    const body = el("div", { class: "json-body" });
    details.append(el("summary", null, icon("chevron-right", { class: "json-chevron" }), el("span", { class: "json-title" }, title),
      el("span", { class: "json-meta" }, meta)), body);
    let rendered = false;
    const renderBody = () => {
      if (rendered) return;
      rendered = true;
      const text = safeStringify(obj);
      const LIMIT = 200000;
      const shown = text.length > LIMIT ? text.slice(0, LIMIT) : text;
      const copyBtn = button("Copy", {
        small: true, kind: "ghost", icon: "copy",
        onClick: () => {
          if (!navigator.clipboard) { toast("Clipboard not available", "warn"); return; }
          return navigator.clipboard.writeText(text).then(() => toast("JSON copied to clipboard", "ok", 2000));
        },
      });
      const dlBtn = button("Download", {
        small: true, kind: "ghost", icon: "download",
        onClick: () => download(`${String(title).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "data"}.json`, text),
      });
      appendChildren(body, [el("div", { class: "json-toolbar" }, copyBtn, dlBtn),
        el("pre", { class: "json-pre", tabindex: "0" }, text.length > 60000 ? shown : highlightJson(shown)),
        text.length > LIMIT ? notice(`Showing the first ${LIMIT.toLocaleString()} characters; download for the full document.`, "info") : null]);
    };
    details.addEventListener("toggle", () => { if (details.open) renderBody(); });
    if (!collapsed) { details.open = true; renderBody(); }
    return details;
  }

  // ------------------------------------------------------------------ molecule (sanitised SVG)

  const BAD_SVG_TAGS = new Set(["script", "foreignobject", "iframe", "object", "embed", "handler", "listener",
    "animate", "set", "animatemotion", "animatetransform", "image", "style", "audio", "video", "link", "meta", "base"]);

  function sanitizeSvgTree(root) {
    const walk = (node) => {
      for (const child of Array.from(node.children)) {
        if (BAD_SVG_TAGS.has(child.localName.toLowerCase())) { child.remove(); continue; }
        walk(child);
      }
      for (const attr of Array.from(node.attributes)) {
        const name = attr.name.toLowerCase();
        const value = attr.value.replace(/[\u0000-\u0020]/g, "").toLowerCase();
        if (name.startsWith("on") || value.includes("javascript:") || value.includes("vbscript:") ||
          ((name === "href" || name.endsWith(":href")) && !attr.value.trim().startsWith("#")) ||
          (name === "style" && /url\(\s*['"]?(?!#)/i.test(attr.value))) {
          node.removeAttribute(attr.name);
        }
      }
    };
    walk(root);
    return root;
  }

  function parseSvg(str) {
    const s = String(str).trim();
    if (!/^(<\?xml|<svg)/i.test(s)) return null;
    let root = null;
    try {
      const doc = new DOMParser().parseFromString(s, "image/svg+xml");
      const r = doc.documentElement;
      if (r && r.localName === "svg" && r.namespaceURI === SVG_NS && !doc.getElementsByTagName("parsererror").length) root = r;
    } catch (err) { root = null; }
    if (!root) {
      try {
        const doc = new DOMParser().parseFromString(s, "text/html");
        root = doc.querySelector("svg");
      } catch (err) { root = null; }
    }
    if (!root) return null;
    sanitizeSvgTree(root);
    const svg = document.importNode(root, true);
    if (!svg.getAttribute("viewBox")) {
      const w = parseFloat(svg.getAttribute("width")), h = parseFloat(svg.getAttribute("height"));
      if (w > 0 && h > 0) svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
    }
    svg.removeAttribute("width");
    svg.removeAttribute("height");
    svg.setAttribute("class", "molecule-svg");
    svg.setAttribute("role", "img");
    return svg;
  }

  /** White "paper" box with a sanitised RDKit depiction. */
  function molecule(svgString, opts = {}) {
    const { caption, width } = opts;
    const fig = el("figure", { class: "molecule" });
    if (width) fig.style.maxWidth = typeof width === "number" ? `${width}px` : width;
    const paper = el("div", { class: "molecule-paper" });
    const svg = typeof svgString === "string" ? parseSvg(svgString) : null;
    if (svg) {
      svg.setAttribute("aria-label", typeof caption === "string" && caption ? `Structure of ${caption}` : "Molecular structure");
      paper.appendChild(svg);
    } else {
      paper.classList.add("is-missing");
      paper.appendChild(el("div", { class: "molecule-missing" }, icon("flask"), el("span", null, "No structure available")));
    }
    fig.appendChild(paper);
    if (caption !== undefined && caption !== null && caption !== "") fig.appendChild(el("figcaption", { class: "molecule-caption" }, caption));
    return fig;
  }

  // ------------------------------------------------------------------ download

  function download(filename, text, mime = "application/json") {
    const data = typeof text === "string" ? text : safeStringify(text);
    const url = URL.createObjectURL(new Blob([data], { type: mime }));
    const a = el("a", { href: url, download: filename || "download", class: "visually-hidden" });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  ECCL.ui = {
    el, svgEl, clear, uid,
    card, grid, section, field, form, button, busy, segmented, table, kv, badge, stat, meter, toast,
    spinner, empty, errorBox, notice, json, tabs, molecule, fmt, fmtSci, formula, download, icon,
    wavelengthToColor, parseSci, errMessage,
  };
})(window.ECCL);
