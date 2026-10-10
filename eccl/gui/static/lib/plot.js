/* ECCL.plot - dependency-free, responsive SVG charts.
 *
 * Every chart: ECCL.plot.<kind>(targetElement, spec) clears the target, renders
 * an SVG sized to the container (re-rendered by a ResizeObserver), colours
 * everything through CSS variables (--chart-1..8, --chart-axis, --chart-grid,
 * --chart-text, --chart-bg) so theme switches restyle without JS, and returns
 * {update(spec), destroy()}. All labels are inserted as text nodes.
 */
window.ECCL = window.ECCL || {};

(function (ECCL) {
  "use strict";

  const NS = "http://www.w3.org/2000/svg";
  const MINUS = "−";
  const SUP = { 0: "⁰", 1: "¹", 2: "²", 3: "³", 4: "⁴", 5: "⁵", 6: "⁶", 7: "⁷", 8: "⁸", 9: "⁹", "-": "⁻" };
  let chartSeq = 0;

  // ------------------------------------------------------------------ tiny DOM helpers

  function s(tag, attrs, ...kids) {
    const n = document.createElementNS(NS, tag);
    if (attrs) {
      for (const k in attrs) {
        const v = attrs[k];
        if (v === null || v === undefined || v === false) continue;
        if (k === "style") { for (const sk in v) if (v[sk] != null) n.style.setProperty(sk, String(v[sk])); }
        else n.setAttribute(k, v === true ? "" : String(v));
      }
    }
    for (const c of kids) if (c !== null && c !== undefined && c !== false) n.appendChild(typeof c === "object" ? c : document.createTextNode(String(c)));
    return n;
  }

  function h(tag, cls, ...kids) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    for (const c of kids) if (c !== null && c !== undefined && c !== false) n.appendChild(typeof c === "object" ? c : document.createTextNode(String(c)));
    return n;
  }

  // ------------------------------------------------------------------ numbers & formatting

  const num = (v) => (v === null || v === undefined || v === "" || typeof v === "boolean" ? NaN : +v);
  const finite = Number.isFinite;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const sup = (n) => String(n).replace(/[0-9-]/g, (c) => SUP[c]);
  const minus = (str) => String(str).replace(/^-/, MINUS);
  const trim0 = (str) => (str.includes(".") && !str.includes("e") ? str.replace(/\.?0+$/, "") : str);
  const crisp = (v) => Math.round(v) + 0.5;

  function fmtVal(v, digits = 4) {
    if (ECCL.ui && typeof ECCL.ui.fmt === "function") return ECCL.ui.fmt(v, digits);
    return finite(v) ? String(+v.toPrecision(digits)) : "—";
  }

  function unitOf(label) {
    const m = /\(([^()]+)\)\s*$/.exec(String(label || ""));
    return m ? m[1] : "";
  }
  function nameOf(label) { return String(label || "").replace(/\s*\([^()]+\)\s*$/, ""); }
  function withUnit(v, label) { const u = unitOf(label); return u ? `${fmtVal(v)} ${u}` : fmtVal(v); }

  function tickStep(lo, hi, count) {
    const raw = Math.abs(hi - lo) / Math.max(1, count);
    if (!finite(raw) || raw <= 0) return 1;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const n = raw / mag;
    return (n >= 7.07 ? 10 : n >= 3.16 ? 5 : n >= 1.41 ? 2 : 1) * mag;
  }

  function linearTicks(lo, hi, count) {
    const step = tickStep(lo, hi, count);
    const i0 = Math.ceil(lo / step - 1e-9), i1 = Math.floor(hi / step + 1e-9);
    const ticks = [];
    for (let i = i0; i <= i1 && ticks.length < 60; i++) {
      let v = +(i * step).toPrecision(12);
      if (Object.is(v, -0)) v = 0;
      ticks.push(v);
    }
    return { ticks, step, format: linearFormatter(ticks, step) };
  }

  function linearFormatter(ticks, step) {
    const maxAbs = ticks.reduce((m, t) => Math.max(m, Math.abs(t)), 0);
    if (maxAbs >= 1e5 || (maxAbs > 0 && maxAbs < 1e-3)) {
      const E = Math.floor(Math.log10(maxAbs) + 1e-9);
      const p = Math.pow(10, E);
      const dec = clamp(-Math.floor(Math.log10(step / p) + 1e-9), 0, 6);
      return (v) => (Math.abs(v) < step * 1e-6 ? "0" : `${minus((v / p).toFixed(dec))}×10${sup(E)}`);
    }
    const dec = clamp(-Math.floor(Math.log10(step) + 1e-9), 0, 12);
    return (v) => minus((Math.abs(v) < step * 1e-6 ? 0 : v).toFixed(dec));
  }

  function logLabel(v) {
    const e = Math.log10(v), ei = Math.round(e);
    if (Math.abs(e - ei) < 1e-6) return ei >= -2 && ei <= 4 ? String(+Math.pow(10, ei).toPrecision(1)) : `10${sup(ei)}`;
    const a = Math.abs(v);
    if (a >= 1e-2 && a < 1e5) return trim0(v.toPrecision(3));
    const ex = Math.floor(Math.log10(a) + 1e-9);
    return `${trim0((v / Math.pow(10, ex)).toPrecision(2))}×10${sup(ex)}`;
  }

  function logTicks(lo, hi, count) {
    const l0 = Math.log10(lo), l1 = Math.log10(hi), span = l1 - l0;
    if (span < 1) {
      const t = linearTicks(lo, hi, count);
      return { major: t.ticks.filter((v) => v > 0), minor: [], format: t.format };
    }
    const inRange = (v) => v >= lo * (1 - 1e-9) && v <= hi * (1 + 1e-9);
    const e0 = Math.floor(l0 + 1e-9), e1 = Math.ceil(l1 - 1e-9);
    const rawStride = Math.max(1, Math.ceil(span / Math.max(1, count)));
    const stride = [1, 2, 3, 5, 10, 15, 20, 25, 50, 100].find((n) => n >= rawStride) || rawStride;
    const labelMult = span <= 2.2 && count >= 6 ? [2, 5] : [];
    let major = [], minor = [];
    for (let e = e0; e <= e1; e++) {
      const d = Math.pow(10, e);
      if (inRange(d) && ((e % stride) + stride) % stride === 0) major.push(+d.toPrecision(12));
      if (stride === 1 && span <= 9) {
        for (let m = 2; m <= 9; m++) {
          const v = +(m * d).toPrecision(12);
          if (inRange(v)) (labelMult.includes(m) ? major : minor).push(v);
        }
      }
    }
    if (major.length < 2) {
      const extra = minor.filter((v) => [2, 5].includes(Math.round(v / Math.pow(10, Math.floor(Math.log10(v) + 1e-9)))));
      major = major.concat(extra);
      minor = minor.filter((v) => !extra.includes(v));
    }
    if (major.length < 2) {
      const t = linearTicks(lo, hi, count);
      return { major: t.ticks.filter((v) => v > 0), minor: [], format: t.format };
    }
    major.sort((a, b) => a - b);
    // decades only: use 10ⁿ for every label as soon as one of them needs it (no "0.01" next to "10⁻³")
    const exps = major.map((v) => Math.log10(v));
    const decadesOnly = exps.every((e) => Math.abs(e - Math.round(e)) < 1e-6);
    if (decadesOnly && exps.some((e) => Math.round(e) < -2 || Math.round(e) > 4)) {
      return { major, minor, format: (v) => `10${sup(Math.round(Math.log10(v)))}` };
    }
    return { major, minor, format: logLabel };
  }

  function ticksFor(domain, log, count) {
    if (log) return logTicks(domain[0], domain[1], count);
    const t = linearTicks(domain[0], domain[1], count);
    return { major: t.ticks, minor: [], format: t.format };
  }

  function scale(d0, d1, r0, r1, log) {
    if (log) {
      const l0 = Math.log10(d0), l1 = Math.log10(d1);
      const k = (r1 - r0) / (l1 - l0 || 1);
      const f = (v) => (v > 0 ? r0 + (Math.log10(v) - l0) * k : NaN);
      f.invert = (p) => Math.pow(10, l0 + (p - r0) / k);
      return f;
    }
    const k = (r1 - r0) / (d1 - d0 || 1);
    const f = (v) => r0 + (v - d0) * k;
    f.invert = (p) => d0 + (p - r0) / k;
    return f;
  }

  /** Domain from an explicit [min,max] or from data, optionally niced to tick steps. */
  function resolveDomain({ given, ext, log, nice, count = 5, includeZero, pad = 0 }) {
    if (Array.isArray(given) && given.length === 2) {
      let a = num(given[0]), b = num(given[1]);
      if (finite(a) && finite(b) && a !== b && (!log || (a > 0 && b > 0))) return a < b ? [a, b] : [b, a];
    }
    let lo, hi;
    if (ext) [lo, hi] = ext; else [lo, hi] = log ? [1, 10] : [0, 1];
    if (includeZero && !log) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
    if (lo === hi) {
      if (log) { lo /= 10; hi *= 10; } else { const d = Math.abs(lo) * 0.1 || 1; lo -= d; hi += d; }
    }
    if (log) {
      if (nice) { lo = Math.pow(10, Math.floor(Math.log10(lo) + 1e-9)); hi = Math.pow(10, Math.ceil(Math.log10(hi) - 1e-9)); }
      return [lo, hi];
    }
    if (pad) {
      const p = (hi - lo) * pad;
      const lo0 = lo;
      lo -= p; hi += p;
      if (lo0 >= 0 && lo < 0) lo = 0;
    }
    if (nice) {
      for (let i = 0; i < 2; i++) {
        const st = tickStep(lo, hi, count);
        lo = Math.floor(lo / st + 1e-9) * st;
        hi = Math.ceil(hi / st - 1e-9) * st;
      }
      lo = +lo.toPrecision(12); hi = +hi.toPrecision(12);
    }
    return [lo, hi];
  }

  function growExtent(ext, v, log) {
    if (!finite(v) || (log && v <= 0)) return ext;
    if (!ext) return [v, v];
    if (v < ext[0]) ext[0] = v;
    if (v > ext[1]) ext[1] = v;
    return ext;
  }

  // ------------------------------------------------------------------ colours & text

  function colorOf(c, i) {
    if (c === undefined || c === null || c === "") return `var(--chart-${(i % 8) + 1})`;
    if (typeof c === "number") return `var(--chart-${((((c - 1) % 8) + 8) % 8) + 1})`;
    const str = String(c).trim();
    if (str.startsWith("--")) return `var(${str})`;
    if (/^chart-[1-8]$/.test(str)) return `var(--${str})`;
    return str;
  }

  function dashOf(d, i) {
    if (d === true) return "6 4";
    if (Array.isArray(d)) return d.join(" ");
    if (typeof d === "string" && d.trim()) return d;
    if (typeof d === "number" && d > 0) return `${d} ${d}`;
    return i >= 8 ? "7 3" : null; // beyond 8 series: secondary encoding instead of a 9th hue
  }

  let measureCtx = null, measureFont = null;
  function textWidth(str, size = 11) {
    if (measureCtx === null) {
      try { measureCtx = document.createElement("canvas").getContext("2d") || false; } catch (e) { measureCtx = false; }
      try { measureFont = getComputedStyle(document.body).fontFamily; } catch (e) { measureFont = null; }
      if (!measureFont) measureFont = "system-ui, sans-serif";
    }
    if (!measureCtx) return String(str).length * size * 0.6;
    measureCtx.font = `${size}px ${measureFont}`;
    return measureCtx.measureText(String(str)).width;
  }

  function ellipsize(str, maxW, size = 11) {
    str = String(str);
    if (textWidth(str, size) <= maxW) return str;
    let lo = 0, hi = str.length;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (textWidth(str.slice(0, mid) + "…", size) <= maxW) lo = mid; else hi = mid - 1; }
    return lo > 0 ? str.slice(0, lo) + "…" : "…";
  }

  // ------------------------------------------------------------------ chart frame (mount, resize, tooltip)

  function mount(target, spec, kind, draw) {
    if (!target || !(target instanceof Element)) throw new Error(`ECCL.plot.${kind}: target element required`);
    target.replaceChildren();
    const root = h("div", `chart chart-${kind}`);
    const head = h("div", "chart-head");
    const canvas = h("div", "chart-canvas");
    const tip = h("div", "chart-tooltip");
    tip.hidden = true;
    tip.setAttribute("aria-hidden", "true");
    const live = h("div", "visually-hidden");
    live.setAttribute("aria-live", "polite");
    root.append(head, canvas, tip, live);
    target.appendChild(root);

    const st = { id: ++chartSeq, kind, spec: spec || {}, root, head, canvas, tip, live, width: 0, height: 0, hidden: new Set(), destroyed: false };
    let raf = 0;
    const render = () => {
      raf = 0;
      if (st.destroyed) return;
      const w = Math.floor(canvas.clientWidth);
      if (w <= 0) return;
      st.width = w;
      hideTip(st);
      try { draw(st); } catch (err) {
        console.error(`[ECCL] plot.${kind} failed`, err);
        canvas.replaceChildren(h("div", "chart-error", `Chart error: ${err && err.message ? err.message : err}`));
      }
    };
    st.rerender = render;
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver((entries) => {
      const w = Math.floor(entries[entries.length - 1].contentRect.width);
      if (w > 0 && w !== st.width && !raf) raf = requestAnimationFrame(render);
    }) : null;
    if (ro) ro.observe(canvas);
    const initialH = num(st.spec.height);
    canvas.style.height = `${finite(initialH) && initialH > 0 ? initialH : kind === "lineChart" || kind === "levelDiagram" ? 300 : 260}px`;
    render();

    return {
      update(next) { st.spec = next || {}; if (!st.destroyed) render(); },
      destroy() {
        st.destroyed = true;
        if (ro) ro.disconnect();
        if (raf) cancelAnimationFrame(raf);
        root.remove();
      },
      get element() { return root; },
    };
  }

  function setHead(st, title, legendItems) {
    st.head.replaceChildren();
    if (title) st.head.appendChild(h("div", "chart-title", String(title)));
    if (legendItems && legendItems.length) st.head.appendChild(legend(st, legendItems));
    st.head.hidden = !st.head.childNodes.length;
  }

  function swatch(color, dash, kind) {
    const sv = s("svg", { class: "legend-swatch", width: 18, height: 10, viewBox: "0 0 18 10", "aria-hidden": "true" });
    if (kind === "rect") sv.appendChild(s("rect", { x: 3, y: 1, width: 12, height: 8, rx: 2, style: { fill: color } }));
    else sv.appendChild(s("line", { x1: 1, y1: 5, x2: 17, y2: 5, "stroke-width": 2.5, "stroke-linecap": "round", "stroke-dasharray": dash ? "4 3" : null, style: { stroke: color } }));
    return sv;
  }

  function legend(st, items) {
    const wrap = h("div", "chart-legend");
    for (const it of items) {
      const hidden = st.hidden.has(it.key);
      const btn = h("button", `legend-item${hidden ? " is-off" : ""}`, swatch(it.color, it.dash, it.kind), h("span", "legend-label", it.name));
      btn.type = "button";
      btn.setAttribute("aria-pressed", hidden ? "false" : "true");
      btn.title = hidden ? `Show ${it.name}` : `Hide ${it.name}`;
      btn.addEventListener("click", () => {
        if (st.hidden.has(it.key)) st.hidden.delete(it.key); else st.hidden.add(it.key);
        st.rerender();
      });
      wrap.appendChild(btn);
    }
    return wrap;
  }

  function tipBox(header, rows) {
    const box = h("div", "tt");
    if (header) box.appendChild(h("div", "tt-head", header));
    for (const r of rows) {
      const row = h("div", "tt-row");
      if (r.color) {
        const key = h("span", `tt-key${r.kind === "rect" ? " tt-key-rect" : ""}${r.dash ? " tt-key-dash" : ""}`);
        key.style.setProperty("--key", r.color);
        row.appendChild(key);
      }
      row.append(h("span", "tt-value", r.value), h("span", "tt-name", r.name || ""));
      box.appendChild(row);
    }
    return box;
  }

  function showTip(st, content, x, y) {
    const tip = st.tip;
    tip.replaceChildren(content);
    tip.hidden = false;
    const cw = st.canvas.clientWidth;
    const top0 = st.canvas.offsetTop;
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    let left = x + 16;
    if (left + tw > cw - 2) left = x - 16 - tw;
    if (left < 2) left = clamp(x - tw / 2, 2, Math.max(2, cw - tw - 2));
    const top = clamp(top0 + y - th / 2, top0 + 2, Math.max(top0 + 2, top0 + st.height - th - 2));
    tip.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
    st.live.textContent = content.textContent;
  }

  function hideTip(st) { st.tip.hidden = true; }

  function newSvg(st, W, H, label) {
    st.height = H;
    st.canvas.style.height = `${H}px`;
    const svg = s("svg", {
      class: "chart-svg", width: "100%", height: H, viewBox: `0 0 ${W} ${H}`, role: "img",
      "aria-label": label, tabindex: 0, focusable: "true",
    });
    st.canvas.replaceChildren(svg);
    return svg;
  }

  /** Pointer + keyboard inspection: positions = sorted pixel x (or y) per item; show(i) / hide(). */
  function attachInspector(st, svg, overlay, { count, nearest, show, hide }) {
    let idx = -1;
    const pointer = (ev) => {
      const r = svg.getBoundingClientRect();
      const sx = st.width / (r.width || st.width);
      return [(ev.clientX - r.left) * sx, (ev.clientY - r.top) * sx];
    };
    const onMove = (ev) => {
      const [px, py] = pointer(ev);
      const i = nearest(px, py);
      if (i < 0) { idx = -1; hide(); return; }
      idx = i;
      show(i, px, py);
    };
    overlay.addEventListener("pointermove", onMove);
    overlay.addEventListener("pointerdown", onMove);
    overlay.addEventListener("pointerleave", () => { idx = -1; hide(); });
    svg.addEventListener("keydown", (ev) => {
      const n = count();
      if (!n) return;
      let j = null;
      if (ev.key === "ArrowRight" || ev.key === "ArrowDown") j = idx < 0 ? 0 : Math.min(n - 1, idx + 1);
      else if (ev.key === "ArrowLeft" || ev.key === "ArrowUp") j = idx < 0 ? n - 1 : Math.max(0, idx - 1);
      else if (ev.key === "Home") j = 0;
      else if (ev.key === "End") j = n - 1;
      else if (ev.key === "Escape") { idx = -1; hide(); return; }
      if (j !== null) { ev.preventDefault(); idx = j; show(j); }
    });
    svg.addEventListener("blur", () => { idx = -1; hide(); });
  }

  /** Grid, axes, tick labels and axis titles for a cartesian plot. */
  function drawAxes(svg, g) {
    const { L, R, T, B, sx, sy, xt, yt, xLabel, yLabel, W, H, xCustom } = g;
    const grid = s("g", { class: "chart-grid", "shape-rendering": "crispEdges" });
    const axes = s("g", { class: "chart-axes", "shape-rendering": "crispEdges" });
    const labels = s("g", { class: "chart-ticks" });
    for (const v of yt.minor || []) { const y = sy(v); if (y >= T - 0.5 && y <= B + 0.5) grid.appendChild(s("line", { class: "grid-minor", x1: L, x2: R, y1: crisp(y), y2: crisp(y) })); }
    for (const v of yt.major) {
      const y = sy(v);
      if (!(y >= T - 0.5 && y <= B + 0.5)) continue;
      grid.appendChild(s("line", { class: v === 0 && !yt.log ? "grid-zero" : "grid-line", x1: L, x2: R, y1: crisp(y), y2: crisp(y) }));
      labels.appendChild(s("text", { x: L - 8, y: y, "text-anchor": "end", "dominant-baseline": "central" }, yt.format(v)));
    }
    if (xCustom) {
      for (const t of xCustom) {
        const x = sx(t.x);
        if (!(x >= L - 0.5 && x <= R + 0.5)) continue;
        grid.appendChild(s("line", { class: "grid-line grid-vertical", x1: crisp(x), x2: crisp(x), y1: T, y2: B }));
        labels.appendChild(s("text", { x, y: B + 16, "text-anchor": "middle", class: "tick-x" }, t.label));
      }
    } else {
      for (const v of xt.minor || []) {
        const x = sx(v);
        if (x >= L && x <= R) axes.appendChild(s("line", { class: "tick-minor", x1: crisp(x), x2: crisp(x), y1: B, y2: B + 3 }));
      }
      const xs = xt.major.map((v) => [v, sx(v)]).filter(([, x]) => x >= L - 0.5 && x <= R + 0.5);
      xs.forEach(([v, x], i) => {
        axes.appendChild(s("line", { class: "tick", x1: crisp(x), x2: crisp(x), y1: B, y2: B + 5 }));
        const label = xt.format(v);
        const w = textWidth(label);
        let anchor = "middle";
        if (i === 0 && x - w / 2 < 2) anchor = "start";
        if (i === xs.length - 1 && x + w / 2 > W - 2) anchor = "end";
        labels.appendChild(s("text", { x, y: B + 17, "text-anchor": anchor, class: "tick-x" }, label));
      });
    }
    axes.appendChild(s("line", { class: "axis-line", x1: L, x2: R, y1: crisp(B), y2: crisp(B) }));
    axes.appendChild(s("line", { class: "axis-line", x1: crisp(L), x2: crisp(L), y1: T, y2: B }));
    svg.append(grid, axes, labels);
    if (xLabel) svg.appendChild(s("text", { class: "axis-title", x: (L + R) / 2, y: H - 6, "text-anchor": "middle" }, String(xLabel)));
    if (yLabel) {
      const cy = (T + B) / 2;
      svg.appendChild(s("text", { class: "axis-title", x: 0, y: 0, "text-anchor": "middle", transform: `translate(13 ${cy}) rotate(-90)` }, String(yLabel)));
    }
  }

  function yAxisWidth(yt) {
    let w = 0;
    for (const v of yt.major) w = Math.max(w, textWidth(yt.format(v)));
    return w;
  }

  /** Reduce the x tick count until labels do not collide. */
  function fitXTicks(domain, log, plotW, sxFactory) {
    let count = Math.max(2, Math.floor(plotW / 80));
    let xt = ticksFor(domain, log, count);
    for (let k = 0; k < 6; k++) {
      const sx = sxFactory();
      const pos = xt.major.map((v) => [sx(v), textWidth(xt.format(v))]).sort((a, b) => a[0] - b[0]);
      let ok = true;
      for (let i = 1; i < pos.length; i++) if (pos[i][0] - pos[i - 1][0] < (pos[i][1] + pos[i - 1][1]) / 2 + 10) { ok = false; break; }
      if (ok || count <= 2) break;
      count = Math.max(2, Math.floor(count * 0.66));
      xt = ticksFor(domain, log, count);
    }
    return xt;
  }

  function emptyMessage(svg, W, H, text = "No data") {
    svg.appendChild(s("text", { class: "chart-empty", x: W / 2, y: H / 2, "text-anchor": "middle", "dominant-baseline": "central" }, text));
  }

  function labelText(x, y, text, anchor = "start", cls = "chart-annot") {
    return s("text", { class: cls, x, y, "text-anchor": anchor }, String(text));
  }

  function nearestIndex(sorted, v) {
    let lo = 0, hi = sorted.length - 1;
    if (hi < 0) return -1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (sorted[mid] < v) lo = mid; else hi = mid; }
    return Math.abs(sorted[lo] - v) <= Math.abs(sorted[hi] - v) ? lo : hi;
  }

  // ------------------------------------------------------------------ lineChart

  function lineChart(el, spec) { return mount(el, spec, "lineChart", drawLine); }

  function drawLine(st) {
    const sp = st.spec || {};
    const W = st.width;
    const H = Math.max(140, num(sp.height) || 300);
    const logX = !!sp.logX, logY = !!sp.logY;
    const series = (Array.isArray(sp.series) ? sp.series : []).filter(Boolean).map((se, i) => {
      const xs = Array.isArray(se.x) || ArrayBuffer.isView(se.x) ? se.x : [];
      const ys = Array.isArray(se.y) || ArrayBuffer.isView(se.y) ? se.y : [];
      const n = Math.min(xs.length, ys.length);
      const X = new Float64Array(n), Y = new Float64Array(n);
      for (let j = 0; j < n; j++) {
        let x = num(xs[j]), y = num(ys[j]);
        if (logX && !(x > 0)) x = NaN;
        if (logY && !(y > 0)) y = NaN;
        X[j] = x; Y[j] = y;
      }
      const name = se.name !== undefined && se.name !== null && se.name !== "" ? String(se.name) : `Series ${i + 1}`;
      return { i, key: `${i}:${name}`, name, X, Y, n, color: colorOf(se.color, i), dash: dashOf(se.dash, i),
        width: num(se.width) > 0 ? num(se.width) : 2, area: !!se.area };
    });
    const visible = series.filter((se) => !st.hidden.has(se.key));
    const showLegend = sp.legend === true ? series.length >= 1 : sp.legend !== false && series.length >= 2; // one series: the title names it
    setHead(st, sp.title, showLegend ? series.map((se) => ({ key: se.key, name: se.name, color: se.color, dash: se.dash })) : null);

    // extents from all series (stable when legend toggles)
    let xExt = null, yExt = null;
    for (const se of series) for (let j = 0; j < se.n; j++) if (finite(se.X[j]) && finite(se.Y[j])) { xExt = growExtent(xExt, se.X[j]); yExt = growExtent(yExt, se.Y[j]); }
    const points = (Array.isArray(sp.points) ? sp.points : []).filter((p) => p && finite(num(p.x)) && finite(num(p.y)) && (!logX || p.x > 0) && (!logY || p.y > 0));
    for (const p of points) { xExt = growExtent(xExt, num(p.x)); yExt = growExtent(yExt, num(p.y)); }
    const near = (v, ext) => ext && v >= ext[0] - (ext[1] - ext[0]) * 0.5 && v <= ext[1] + (ext[1] - ext[0]) * 0.5;
    const markers = (Array.isArray(sp.markers) ? sp.markers : []).filter((m) => m && finite(num(m.x)) && (!logX || m.x > 0));
    const hMarkers = (Array.isArray(sp.hMarkers) ? sp.hMarkers : []).filter((m) => m && finite(num(m.y)) && (!logY || m.y > 0));
    const yExtData = yExt ? [...yExt] : null;
    for (const m of hMarkers) if (!yExtData || near(num(m.y), yExtData)) yExt = growExtent(yExt, num(m.y));
    const xExtData = xExt ? [...xExt] : null;
    for (const m of markers) if (!xExtData || near(num(m.x), xExtData)) xExt = growExtent(xExt, num(m.x));
    const xCustom = (Array.isArray(sp.xTicks) ? sp.xTicks : []).filter((t) => t && finite(num(t.x))).map((t) => ({ x: num(t.x), label: t.label ?? fmtVal(num(t.x)) }));

    const T = 12;
    const bottomH = 24 + (sp.xLabel ? 18 : 0);
    const B = H - bottomH;
    const plotH = Math.max(20, B - T);
    const yCount = Math.max(2, Math.round(plotH / 48));
    const yDomain = resolveDomain({ given: sp.yDomain, ext: yExt, log: logY, nice: true, count: yCount });
    const yt = ticksFor(yDomain, logY, yCount);
    yt.log = logY;
    const L = Math.max(34, Math.ceil(yAxisWidth(yt)) + 14 + (sp.yLabel ? 20 : 0));
    const R = W - 16;
    const plotW = Math.max(20, R - L);
    const xDomain = resolveDomain({ given: sp.xDomain, ext: xExt, log: logX, nice: false });
    const mkSx = () => (sp.xReverse ? scale(xDomain[0], xDomain[1], R, L, logX) : scale(xDomain[0], xDomain[1], L, R, logX));
    const sx = mkSx();
    const sy = scale(yDomain[0], yDomain[1], B, T, logY);
    const xt = xCustom.length ? { major: [], minor: [], format: fmtVal } : fitXTicks(xDomain, logX, plotW, mkSx);

    const aria = [sp.title || "Line chart", series.length ? `${series.length} series: ${series.map((x) => x.name).join(", ")}` : "",
      sp.xLabel ? `x: ${sp.xLabel}` : "", sp.yLabel ? `y: ${sp.yLabel}` : "", "Use arrow keys to inspect values."].filter(Boolean).join(". ");
    const svg = newSvg(st, W, H, aria);
    const clipId = `eccl-clip-${st.id}`;
    svg.appendChild(s("defs", null, s("clipPath", { id: clipId }, s("rect", { x: L - 2, y: T - 2, width: plotW + 4, height: plotH + 4 }))));
    drawAxes(svg, { L, R, T, B, sx, sy, xt, yt, xLabel: sp.xLabel, yLabel: sp.yLabel, W, H, xCustom: xCustom.length ? xCustom : null });

    if (!xExtData) emptyMessage(svg, (L + R) / 2, (T + B) / 2, sp.empty || "No data");

    // vertical / horizontal markers (under the data)
    const markG = s("g", { class: "chart-markers", "clip-path": `url(#${clipId})` });
    for (const m of markers) {
      const x = sx(num(m.x));
      if (!finite(x)) continue;
      markG.appendChild(s("line", { class: "marker-line", x1: crisp(x), x2: crisp(x), y1: T, y2: B, style: m.color ? { stroke: colorOf(m.color, 0) } : null }));
    }
    for (const m of hMarkers) {
      const y = sy(num(m.y));
      if (!finite(y)) continue;
      markG.appendChild(s("line", { class: "marker-line", x1: L, x2: R, y1: crisp(y), y2: crisp(y), style: m.color ? { stroke: colorOf(m.color, 0) } : null }));
    }
    svg.appendChild(markG);

    // series
    const dataG = s("g", { class: "chart-data", "clip-path": `url(#${clipId})` });
    const singles = [];
    for (const se of visible) {
      let d = "", pen = false, segLen = 0, segStart = null, areaD = "", segPts = [];
      const baseY = logY ? B : clamp(sy(clamp(0, yDomain[0], yDomain[1])), T, B);
      const closeArea = () => {
        if (se.area && segPts.length > 1) {
          areaD += `M${segPts[0][0].toFixed(1)},${baseY.toFixed(1)}` + segPts.map((p) => `L${p[0].toFixed(1)},${p[1].toFixed(1)}`).join("") + `L${segPts[segPts.length - 1][0].toFixed(1)},${baseY.toFixed(1)}Z`;
        }
        segPts = [];
      };
      for (let j = 0; j < se.n; j++) {
        const xv = se.X[j], yv = se.Y[j];
        if (!finite(xv) || !finite(yv)) {
          if (segLen === 1) singles.push([segStart, se]);
          pen = false; segLen = 0; closeArea();
          continue;
        }
        const px = sx(xv), py = clamp(sy(yv), -1e5, 1e5);
        d += `${pen ? "L" : "M"}${px.toFixed(1)},${py.toFixed(1)}`;
        if (!pen) segStart = [px, py];
        if (se.area) segPts.push([px, py]);
        pen = true; segLen++;
      }
      if (segLen === 1) singles.push([segStart, se]);
      closeArea();
      if (areaD) dataG.appendChild(s("path", { class: "series-area", d: areaD, style: { fill: se.color } }));
      if (d) dataG.appendChild(s("path", { class: "series-line", d, "stroke-width": se.width, "stroke-dasharray": se.dash, style: { stroke: se.color } }));
    }
    for (const [[px, py], se] of singles) dataG.appendChild(s("circle", { class: "series-dot", cx: px, cy: py, r: 3, style: { fill: se.color } }));
    svg.appendChild(dataG);

    // annotations on top
    const annot = s("g", { class: "chart-annotations" });
    for (const p of points) {
      const px = sx(num(p.x)), py = sy(num(p.y));
      if (!(px >= L - 1 && px <= R + 1 && py >= T - 1 && py <= B + 1)) continue;
      annot.appendChild(s("circle", { class: "chart-point", cx: px, cy: py, r: 4.5, style: p.color ? { fill: colorOf(p.color, 0) } : null }));
      if (p.label !== undefined && p.label !== null && p.label !== "") {
        const w = textWidth(p.label);
        const right = px + 8 + w < R;
        annot.appendChild(labelText(right ? px + 8 : px - 8, Math.max(T + 10, py - 8), p.label, right ? "start" : "end"));
      }
    }
    const rows = [];
    for (const m of [...markers].sort((a, b) => sx(num(a.x)) - sx(num(b.x)))) {
      if (m.label === undefined || m.label === null || m.label === "") continue;
      const x = sx(num(m.x));
      if (!(x >= L - 1 && x <= R + 1)) continue;
      const w = textWidth(m.label) + 8;
      let x0 = x + 4, anchor = "start";
      if (x0 + w > R) { x0 = x - 4 - w; anchor = "end"; }
      let r = 0;
      while (rows[r] && rows[r].some(([a, b]) => !(x0 + w < a || x0 > b))) r++;
      (rows[r] = rows[r] || []).push([x0, x0 + w]);
      annot.appendChild(labelText(anchor === "start" ? x + 4 : x - 4, T + 11 + r * 14, m.label, anchor));
    }
    for (const m of hMarkers) {
      if (m.label === undefined || m.label === null || m.label === "") continue;
      const y = sy(num(m.y));
      if (!(y >= T - 1 && y <= B + 1)) continue;
      annot.appendChild(labelText(R - 4, y - 5 < T + 10 ? y + 13 : y - 5, m.label, "end"));
    }
    svg.appendChild(annot);

    // hover: crosshair snapping to the nearest x across visible series
    const hover = s("g", { class: "chart-hover", visibility: "hidden" });
    const cross = s("line", { class: "crosshair", x1: 0, x2: 0, y1: T, y2: B, "shape-rendering": "crispEdges" });
    const dots = s("g");
    hover.append(cross, dots);
    svg.appendChild(hover);
    const overlay = s("rect", { class: "chart-overlay", x: L, y: T, width: plotW, height: plotH });
    svg.appendChild(overlay);

    const perSeries = visible.map((se) => {
      const idx = [];
      for (let j = 0; j < se.n; j++) if (finite(se.X[j]) && finite(se.Y[j])) idx.push(j);
      idx.sort((a, b) => se.X[a] - se.X[b]);
      const xsSorted = idx.map((j) => se.X[j]);
      const gaps = [];
      for (let k = 1; k < xsSorted.length; k++) gaps.push(Math.abs(sx(xsSorted[k]) - sx(xsSorted[k - 1])));
      gaps.sort((a, b) => a - b);
      const med = gaps.length ? gaps[gaps.length >> 1] : 0;
      return { se, idx, xsSorted, tol: Math.max(3, med * 0.75 + 0.5) };
    });
    const allX = Array.from(new Set(perSeries.flatMap((p) => p.xsSorted))).map((x) => [sx(x), x]).sort((a, b) => a[0] - b[0]);
    const allPx = allX.map((a) => a[0]);
    const xFmt = typeof sp.xFormat === "function" ? sp.xFormat : null;
    const yFmt = typeof sp.yFormat === "function" ? sp.yFormat : null;

    attachInspector(st, svg, overlay, {
      count: () => allX.length,
      nearest: (px) => (allPx.length ? nearestIndex(allPx, px) : -1),
      hide: () => { hover.setAttribute("visibility", "hidden"); hideTip(st); },
      show: (i) => {
        const [px, xv] = allX[i];
        cross.setAttribute("x1", crisp(px)); cross.setAttribute("x2", crisp(px));
        dots.replaceChildren();
        const tipRows = [];
        let anchorY = (T + B) / 2, nY = 0, sumY = 0;
        for (const p of perSeries) {
          const k = nearestIndex(p.xsSorted, xv);
          let val = null;
          if (k >= 0) {
            const j = p.idx[k];
            if (Math.abs(sx(p.se.X[j]) - px) <= p.tol) {
              val = p.se.Y[j];
              const py = sy(val);
              if (py >= T - 1 && py <= B + 1) {
                dots.appendChild(s("circle", { class: "hover-dot", cx: sx(p.se.X[j]), cy: py, r: 4, style: { fill: p.se.color } }));
                sumY += py; nY++;
              }
            }
          }
          tipRows.push({ color: p.se.color, dash: p.se.dash, value: val === null ? "—" : yFmt ? yFmt(val, p.se.name) : fmtVal(val), name: p.se.name });
        }
        if (nY) anchorY = sumY / nY;
        const custom = xCustom.find((t) => Math.abs(sx(t.x) - px) < 0.5);
        const head = custom ? String(custom.label) : xFmt ? xFmt(xv) : withUnit(xv, sp.xLabel);
        hover.setAttribute("visibility", "visible");
        showTip(st, tipBox(head, tipRows), px, anchorY);
      },
    });
  }

  // ------------------------------------------------------------------ stickChart

  function stickChart(el, spec) { return mount(el, spec, "stickChart", drawSticks); }

  function drawSticks(st) {
    const sp = st.spec || {};
    const W = st.width;
    const H = Math.max(140, num(sp.height) || 260);
    setHead(st, sp.title, null);
    const sticks = (Array.isArray(sp.sticks) ? sp.sticks : []).filter((k) => k && finite(num(k.x)) && finite(num(k.y)))
      .map((k) => ({ x: num(k.x), y: num(k.y), label: k.label, color: k.color }));
    const bands = (Array.isArray(sp.bands) ? sp.bands : []).filter((b) => b && finite(num(b.x0)) && finite(num(b.x1)))
      .map((b) => ({ x0: Math.min(num(b.x0), num(b.x1)), x1: Math.max(num(b.x0), num(b.x1)), label: b.label, color: b.color }));
    let xExt = null, yExt = null;
    for (const k of sticks) { xExt = growExtent(xExt, k.x); yExt = growExtent(yExt, k.y); }
    for (const b of bands) { xExt = growExtent(xExt, b.x0); xExt = growExtent(xExt, b.x1); }
    const hasLabels = sticks.some((k) => k.label !== undefined && k.label !== null && k.label !== "");
    const T = hasLabels ? 26 : 12;
    const B = H - (24 + (sp.xLabel ? 18 : 0));
    const plotH = Math.max(20, B - T);
    const yCount = Math.max(2, Math.round(plotH / 48));
    const yDomain = resolveDomain({ given: sp.yDomain, ext: yExt || [0, 1], nice: true, count: yCount, includeZero: true });
    const yt = ticksFor(yDomain, false, yCount);
    const L = Math.max(34, Math.ceil(yAxisWidth(yt)) + 14 + (sp.yLabel ? 20 : 0));
    const R = W - 16;
    const plotW = Math.max(20, R - L);
    const xDomain = resolveDomain({ given: sp.xDomain, ext: xExt, nice: false, pad: xExt && xExt[0] !== xExt[1] ? 0.04 : 0 });
    const mkSx = () => (sp.xReverse ? scale(xDomain[0], xDomain[1], R, L) : scale(xDomain[0], xDomain[1], L, R));
    const sx = mkSx();
    const sy = scale(yDomain[0], yDomain[1], B, T);
    const xt = fitXTicks(xDomain, false, plotW, mkSx);
    const svg = newSvg(st, W, H, [sp.title || "Stick spectrum", `${sticks.length} peaks`, sp.xLabel ? `x: ${sp.xLabel}` : "", "Use arrow keys to inspect peaks."].filter(Boolean).join(". "));
    const clipId = `eccl-clip-${st.id}`;
    svg.appendChild(s("defs", null, s("clipPath", { id: clipId }, s("rect", { x: L, y: T - 2, width: plotW, height: plotH + 4 }))));

    const bandG = s("g", { class: "chart-bands", "clip-path": `url(#${clipId})` });
    const bandGeo = bands.map((b) => {
      const a = sx(b.x0), c = sx(b.x1);
      const x = Math.min(a, c), w = Math.max(1, Math.abs(c - a));
      bandG.appendChild(s("rect", { class: "band", x, y: T, width: w, height: plotH, style: b.color ? { fill: colorOf(b.color, 0) } : null }));
      return { b, x, w };
    });
    svg.appendChild(bandG);
    drawAxes(svg, { L, R, T, B, sx, sy, xt, yt, xLabel: sp.xLabel, yLabel: sp.yLabel, W, H });
    if (!sticks.length && !bands.length) emptyMessage(svg, (L + R) / 2, (T + B) / 2, sp.empty || "No peaks");

    const base = sy(clamp(0, yDomain[0], yDomain[1]));
    const stickG = s("g", { class: "chart-sticks", "clip-path": `url(#${clipId})` });
    const geo = sticks.map((k, i) => {
      const x = sx(k.x), y = sy(k.y);
      const line = s("line", { class: "stick", x1: x, x2: x, y1: base, y2: y, style: { stroke: colorOf(k.color, 0) } });
      stickG.appendChild(line);
      return { k, x, y, line, i };
    });
    svg.appendChild(stickG);

    // labels: tallest first, skip any that would collide
    const labelG = s("g", { class: "chart-annotations" });
    const placed = [];
    for (const g of [...geo].sort((a, b) => b.k.y - a.k.y)) {
      if (g.k.label === undefined || g.k.label === null || g.k.label === "") continue;
      if (!(g.x >= L - 1 && g.x <= R + 1)) continue;
      const text = ellipsize(g.k.label, 120, 10.5);
      const w = textWidth(text, 10.5);
      const cx = clamp(g.x, L + w / 2, R - w / 2);
      const top = Math.min(g.y, base) - 6;
      const box = [cx - w / 2 - 2, top - 11, cx + w / 2 + 2, top + 1];
      if (box[1] < 1) continue;
      if (placed.some((p) => !(box[2] < p[0] || box[0] > p[2] || box[3] < p[1] || box[1] > p[3]))) continue;
      placed.push(box);
      labelG.appendChild(labelText(cx, top, text, "middle", "chart-annot stick-label"));
    }
    // band labels: top of the plot, after peak labels (peaks win collisions); two rows max
    const overlaps = (box) => placed.some((p) => !(box[2] < p[0] || box[0] > p[2] || box[3] < p[1] || box[1] > p[3]));
    for (const g of bandGeo) {
      if (g.b.label === undefined || g.b.label === null || g.b.label === "") continue;
      const text = ellipsize(g.b.label, Math.max(g.w + 30, 40), 10);
      const tw = textWidth(text, 10);
      const cx = clamp(g.x + g.w / 2, L + tw / 2 + 2, R - tw / 2 - 2);
      for (const y of [T + 12, T + 25]) {
        const box = [cx - tw / 2 - 3, y - 10, cx + tw / 2 + 3, y + 2];
        if (overlaps(box)) continue;
        placed.push(box);
        labelG.appendChild(labelText(cx, y, text, "middle", "chart-annot band-label"));
        break;
      }
    }
    svg.appendChild(labelG);

    const overlay = s("rect", { class: "chart-overlay", x: L, y: T, width: plotW, height: plotH });
    svg.appendChild(overlay);
    const order = [...geo].sort((a, b) => a.x - b.x);
    const pxs = order.map((g) => g.x);
    let hot = null;
    const xName = nameOf(sp.xLabel) || "x", yName = nameOf(sp.yLabel) || "y";
    attachInspector(st, svg, overlay, {
      count: () => order.length,
      nearest: (px) => {
        const i = nearestIndex(pxs, px);
        if (i >= 0 && Math.abs(pxs[i] - px) <= 14) return i;
        const band = bandGeo.findIndex((g) => px >= g.x && px <= g.x + g.w);
        return band >= 0 ? order.length + band : -1;
      },
      hide: () => { if (hot) hot.classList.remove("is-hot"); hot = null; hideTip(st); },
      show: (i) => {
        if (hot) hot.classList.remove("is-hot");
        hot = null;
        if (i >= order.length) {
          const g = bandGeo[i - order.length];
          if (!g) return;
          showTip(st, tipBox(g.b.label ? String(g.b.label) : "Band", [{ value: `${fmtVal(g.b.x0)} – ${withUnit(g.b.x1, sp.xLabel)}`, name: "" }]), g.x + g.w / 2, (T + B) / 2);
          return;
        }
        const g = order[i];
        hot = g.line;
        hot.classList.add("is-hot");
        const rows = [{ value: withUnit(g.k.x, sp.xLabel), name: xName }, { value: withUnit(g.k.y, sp.yLabel), name: yName }];
        showTip(st, tipBox(g.k.label ? String(g.k.label) : "Peak", rows), g.x, Math.min(g.y, base));
      },
    });
  }

  // ------------------------------------------------------------------ barChart

  function barChart(el, spec) { return mount(el, spec, "barChart", drawBars); }

  function barPath(x, y, w, hgt, dir, r) {
    // rounded corners on the data end only; dir: up | down | right | left
    r = Math.max(0, Math.min(r, w / 2, hgt));
    if (hgt <= 0 || w <= 0) return "";
    if (dir === "up") return `M${x},${y + hgt}V${y + r}A${r},${r} 0 0 1 ${x + r},${y}H${x + w - r}A${r},${r} 0 0 1 ${x + w},${y + r}V${y + hgt}Z`;
    if (dir === "down") return `M${x},${y}V${y + hgt - r}A${r},${r} 0 0 0 ${x + r},${y + hgt}H${x + w - r}A${r},${r} 0 0 0 ${x + w},${y + hgt - r}V${y}Z`;
    // horizontal: w is the length along x, hgt the thickness
    r = Math.max(0, Math.min(r, hgt / 2, w));
    if (dir === "right") return `M${x},${y}H${x + w - r}A${r},${r} 0 0 1 ${x + w},${y + r}V${y + hgt - r}A${r},${r} 0 0 1 ${x + w - r},${y + hgt}H${x}Z`;
    return `M${x + w},${y}H${x + r}A${r},${r} 0 0 0 ${x},${y + r}V${y + hgt - r}A${r},${r} 0 0 0 ${x + r},${y + hgt}H${x + w}Z`;
  }

  function drawBars(st) {
    const sp = st.spec || {};
    const W = st.width;
    const format = typeof sp.format === "function" ? sp.format : (v) => fmtVal(v, 3);
    const bars = (Array.isArray(sp.bars) ? sp.bars : []).filter(Boolean).map((b, i) => ({ i, label: b.label ?? "", value: num(b.value), color: colorOf(b.color, 0) }));
    const horizontal = !!sp.horizontal;
    setHead(st, sp.title, null);
    let ext = [0, 0];
    for (const b of bars) if (finite(b.value)) ext = growExtent(ext, b.value);
    const n = Math.max(1, bars.length);
    const valueLabels = bars.map((b) => (finite(b.value) ? String(format(b.value)) : "—"));
    const maxValW = valueLabels.reduce((m, t) => Math.max(m, textWidth(t, 11)), 0);
    const maxBar = num(sp.barWidth) > 0 ? num(sp.barWidth) : 24;
    let svg, H, overlayItems = [];

    if (!horizontal) {
      H = Math.max(140, num(sp.height) || 260);
      const T = 20;
      // first pass: provisional left margin to know band width for label rotation
      const yCount0 = Math.max(2, Math.round((H - 60) / 48));
      const dom0 = resolveDomain({ given: sp.yDomain, ext, nice: true, count: yCount0, includeZero: true });
      const yt0 = ticksFor(dom0, false, yCount0);
      let L = Math.max(34, Math.ceil(yAxisWidth(yt0)) + 14 + (sp.yLabel ? 20 : 0));
      const R = W - 12;
      let band = (R - L) / n;
      const catLabels = bars.map((b) => String(b.label));
      const maxCatW = catLabels.reduce((m, t) => Math.max(m, textWidth(t)), 0);
      const rotate = maxCatW > band - 6;
      const catMax = rotate ? Math.min(maxCatW, 110) : band - 4;
      if (rotate && catLabels.length) {
        // a label rotated by -40° extends cos(40°)·width to the left of its bar centre
        const need = Math.min(textWidth(catLabels[0]), catMax) * 0.766 + 6 - band / 2;
        if (need > L) { L = Math.ceil(need); band = (R - L) / n; }
      }
      const bottomH = (rotate ? 12 + catMax * 0.64 + 8 : 24) + (sp.xLabel ? 18 : 0);
      const B = H - bottomH;
      const plotH = Math.max(20, B - T);
      const yCount = Math.max(2, Math.round(plotH / 48));
      const yDomain = resolveDomain({ given: sp.yDomain, ext, nice: true, count: yCount, includeZero: true });
      const yt = ticksFor(yDomain, false, yCount);
      const sy = scale(yDomain[0], yDomain[1], B, T);
      svg = newSvg(st, W, H, [sp.title || "Bar chart", `${bars.length} bars`, sp.yLabel ? `value: ${sp.yLabel}` : "", "Use arrow keys to inspect bars."].filter(Boolean).join(". "));
      drawAxes(svg, { L, R, T, B, sx: (v) => v, sy, xt: { major: [], minor: [], format: String }, yt, yLabel: sp.yLabel, xLabel: sp.xLabel, W, H });
      if (!bars.length) emptyMessage(svg, (L + R) / 2, (T + B) / 2, sp.empty || "No data");
      const zero = sy(clamp(0, yDomain[0], yDomain[1]));
      const bw = Math.max(2, Math.min(maxBar, band * 0.7));
      const barG = s("g", { class: "chart-bars" });
      const labG = s("g", { class: "chart-ticks" });
      bars.forEach((b, i) => {
        const cx = L + band * (i + 0.5);
        if (finite(b.value)) {
          const y = sy(b.value);
          const up = b.value >= 0;
          const top = Math.min(y, zero), hgt = Math.abs(zero - y);
          const path = s("path", { class: "bar", d: barPath(cx - bw / 2, top, bw, Math.max(hgt, 0.5), up ? "up" : "down", 4), style: { fill: b.color } });
          barG.appendChild(path);
          if (textWidth(valueLabels[i], 11) <= band - 2) {
            barG.appendChild(s("text", { class: "bar-value", x: cx, y: up ? top - 5 : top + hgt + 13, "text-anchor": "middle" }, valueLabels[i]));
          }
          overlayItems.push({ b, i, path, x: cx - band / 2, y: T, w: band, h: plotH, ax: cx, ay: up ? top : top + hgt });
        } else overlayItems.push({ b, i, path: null, x: cx - band / 2, y: T, w: band, h: plotH, ax: cx, ay: zero });
        const text = ellipsize(catLabels[i], catMax);
        if (rotate) labG.appendChild(s("text", { class: "tick-x", x: 0, y: 0, "text-anchor": "end", transform: `translate(${cx + 3} ${B + 12}) rotate(-40)` }, text));
        else labG.appendChild(s("text", { class: "tick-x", x: cx, y: B + 17, "text-anchor": "middle" }, text));
      });
      if (yDomain[0] < 0) barG.appendChild(s("line", { class: "axis-zero", x1: L, x2: R, y1: crisp(zero), y2: crisp(zero), "shape-rendering": "crispEdges" }));
      svg.append(barG, labG);
    } else {
      const minH = n * 22 + 40 + (sp.yLabel ? 18 : 0);
      const given = num(sp.height);
      H = finite(given) && given > 0 ? Math.max(given, minH) : Math.max(160, n * 34 + 44 + (sp.yLabel ? 18 : 0));
      const T = 8;
      const B = H - (24 + (sp.yLabel ? 18 : 0));
      const catLabels = bars.map((b) => String(b.label));
      const labelW = Math.min(catLabels.reduce((m, t) => Math.max(m, textWidth(t)), 0), W * 0.38);
      const L = Math.ceil(labelW) + 14;
      const R = W - Math.ceil(maxValW) - 14;
      const plotW = Math.max(20, R - L);
      const xDomain = resolveDomain({ given: sp.yDomain, ext, nice: true, count: Math.max(2, Math.floor(plotW / 80)), includeZero: true });
      const mkSx = () => scale(xDomain[0], xDomain[1], L, R);
      const sx = mkSx();
      const xt = fitXTicks(xDomain, false, plotW, mkSx);
      svg = newSvg(st, W, H, [sp.title || "Bar chart", `${bars.length} bars`, sp.yLabel ? `value: ${sp.yLabel}` : "", "Use arrow keys to inspect bars."].filter(Boolean).join(". "));
      // vertical gridlines + x axis
      const grid = s("g", { class: "chart-grid", "shape-rendering": "crispEdges" });
      const ticks = s("g", { class: "chart-ticks" });
      const axes = s("g", { class: "chart-axes", "shape-rendering": "crispEdges" });
      xt.major.forEach((v, i) => {
        const x = sx(v);
        grid.appendChild(s("line", { class: v === 0 ? "grid-zero" : "grid-line", x1: crisp(x), x2: crisp(x), y1: T, y2: B }));
        const label = xt.format(v);
        const w = textWidth(label);
        let anchor = "middle";
        if (i === 0 && x - w / 2 < 2) anchor = "start";
        if (i === xt.major.length - 1 && x + w / 2 > W - 2) anchor = "end";
        ticks.appendChild(s("text", { class: "tick-x", x, y: B + 17, "text-anchor": anchor }, label));
      });
      axes.appendChild(s("line", { class: "axis-line", x1: L, x2: R, y1: crisp(B), y2: crisp(B) }));
      svg.append(grid, axes, ticks);
      if (sp.yLabel) svg.appendChild(s("text", { class: "axis-title", x: (L + R) / 2, y: H - 6, "text-anchor": "middle" }, String(sp.yLabel)));
      if (!bars.length) emptyMessage(svg, (L + R) / 2, (T + B) / 2, sp.empty || "No data");
      const band = (B - T) / n;
      const bh = Math.max(2, Math.min(maxBar, band * 0.7));
      const zero = sx(clamp(0, xDomain[0], xDomain[1]));
      const barG = s("g", { class: "chart-bars" });
      bars.forEach((b, i) => {
        const cy = T + band * (i + 0.5);
        barG.appendChild(s("text", { class: "tick-y", x: L - 8, y: cy, "text-anchor": "end", "dominant-baseline": "central" }, ellipsize(catLabels[i], labelW)));
        if (finite(b.value)) {
          const x = sx(b.value);
          const right = b.value >= 0;
          const x0 = Math.min(x, zero), len = Math.abs(x - zero);
          const path = s("path", { class: "bar", d: barPath(x0, cy - bh / 2, Math.max(len, 0.5), bh, right ? "right" : "left", 4), style: { fill: b.color } });
          barG.appendChild(path);
          barG.appendChild(s("text", { class: "bar-value", x: right ? x0 + len + 6 : x0 - 6, y: cy, "text-anchor": right ? "start" : "end", "dominant-baseline": "central" }, valueLabels[i]));
          overlayItems.push({ b, i, path, x: L, y: cy - band / 2, w: plotW, h: band, ax: right ? x0 + len : x0, ay: cy });
        } else overlayItems.push({ b, i, path: null, x: L, y: cy - band / 2, w: plotW, h: band, ax: zero, ay: cy });
      });
      if (xDomain[0] < 0) barG.appendChild(s("line", { class: "axis-zero", x1: crisp(zero), x2: crisp(zero), y1: T, y2: B, "shape-rendering": "crispEdges" }));
      svg.appendChild(barG);
    }

    // per-bar hit targets (the full band)
    const hits = s("g", { class: "chart-hits" });
    for (const it of overlayItems) hits.appendChild(s("rect", { class: "chart-overlay", x: it.x, y: it.y, width: Math.max(1, it.w), height: Math.max(1, it.h), "data-i": it.i }));
    svg.appendChild(hits);
    const overlay = hits;
    let hot = null;
    attachInspector(st, svg, overlay, {
      count: () => overlayItems.length,
      nearest: (px, py) => overlayItems.findIndex((it) => px >= it.x && px <= it.x + it.w && py >= it.y && py <= it.y + it.h),
      hide: () => { svg.classList.remove("has-hot"); if (hot) hot.classList.remove("is-hot"); hot = null; hideTip(st); },
      show: (i) => {
        const it = overlayItems[i];
        if (!it) return;
        if (hot) hot.classList.remove("is-hot");
        hot = it.path;
        if (hot) { hot.classList.add("is-hot"); svg.classList.add("has-hot"); }
        showTip(st, tipBox(String(it.b.label), [{ color: it.b.color, kind: "rect", value: finite(it.b.value) ? String(format(it.b.value)) : "—", name: nameOf(sp.yLabel) }]), it.ax, it.ay);
      },
    });
  }

  // ------------------------------------------------------------------ levelDiagram

  function levelDiagram(el, spec) { return mount(el, spec, "levelDiagram", drawLevels); }

  function drawLevels(st) {
    const sp = st.spec || {};
    const W = st.width;
    const H = Math.max(160, num(sp.height) || 300);
    const yLabel = sp.yLabel === undefined ? "Energy (eV)" : sp.yLabel;
    setHead(st, sp.title, null);
    const levels = (Array.isArray(sp.levels) ? sp.levels : []).filter((l) => l && finite(num(l.e)))
      .map((l, i) => ({ i, e: num(l.e), label: l.label ?? `E${i + 1}`, color: l.color }));
    let ext = null;
    for (const l of levels) ext = growExtent(ext, l.e);
    const depth = finite(num(sp.depth)) ? num(sp.depth) : null;
    if (depth !== null) ext = growExtent(ext, depth);
    if (ext) ext = [Math.min(0, ext[0]), ext[1] + (ext[1] - Math.min(0, ext[0])) * 0.08];
    const T = 12, B = H - 12;
    const plotH = B - T;
    const yCount = Math.max(2, Math.round(plotH / 48));
    const yDomain = resolveDomain({ given: sp.yDomain, ext, nice: true, count: yCount, includeZero: true });
    const yt = ticksFor(yDomain, false, yCount);
    const L = Math.max(34, Math.ceil(yAxisWidth(yt)) + 14 + (yLabel ? 20 : 0));
    const R = W - 12;
    const plotW = Math.max(40, R - L);
    const sy = scale(yDomain[0], yDomain[1], B, T);
    const svg = newSvg(st, W, H, [sp.title || "Energy level diagram", `${levels.length} levels`, "Use arrow keys to inspect levels."].join(". "));

    const grid = s("g", { class: "chart-grid", "shape-rendering": "crispEdges" });
    const ticks = s("g", { class: "chart-ticks" });
    for (const v of yt.major) {
      const y = sy(v);
      grid.appendChild(s("line", { class: "grid-line", x1: L, x2: R, y1: crisp(y), y2: crisp(y) }));
      ticks.appendChild(s("text", { x: L - 8, y, "text-anchor": "end", "dominant-baseline": "central" }, yt.format(v)));
    }
    svg.append(grid, ticks, s("line", { class: "axis-line", x1: crisp(L), x2: crisp(L), y1: T, y2: B, "shape-rendering": "crispEdges" }));
    if (yLabel) svg.appendChild(s("text", { class: "axis-title", x: 0, y: 0, "text-anchor": "middle", transform: `translate(13 ${(T + B) / 2}) rotate(-90)` }, String(yLabel)));

    const unit = unitOf(yLabel);
    const energyText = (e) => (unit ? `${fmtVal(e)} ${unit}` : fmtVal(e));
    const labelNeed = levels.reduce((m, l) => Math.max(m, textWidth(String(l.label), 11.5) + 6 + textWidth(energyText(l.e), 11.5)), 0);
    const labelArea = clamp(labelNeed + 30, 90, Math.max(90, plotW * 0.55));
    const x0 = L + Math.max(14, Math.min(28, plotW * 0.06));
    const x1 = Math.max(x0 + 60, R - labelArea);
    const floor = sy(clamp(0, yDomain[0], yDomain[1]));
    const top = depth !== null ? sy(depth) : T;
    const barrierW = Math.min(x0 - L - 2, 16);
    const well = s("g", { class: "well" });
    if (barrierW > 4) {
      well.appendChild(s("rect", { class: "well-barrier", x: x0 - barrierW, y: top, width: barrierW, height: Math.max(0, floor - top) }));
      well.appendChild(s("rect", { class: "well-barrier", x: x1, y: top, width: barrierW, height: Math.max(0, floor - top) }));
    }
    well.appendChild(s("path", { class: "well-wall", d: `M${x0},${top}V${floor}H${x1}V${top}` }));
    if (depth !== null) {
      well.appendChild(s("line", { class: "well-wall", x1: x0 - barrierW, x2: x0, y1: top, y2: top }));
      well.appendChild(s("line", { class: "well-wall", x1: x1, x2: x1 + barrierW, y1: top, y2: top }));
    }
    svg.appendChild(well);
    if (!levels.length) emptyMessage(svg, (x0 + x1) / 2, (T + B) / 2, sp.empty || "No levels");

    const sorted = [...levels].sort((a, b) => a.e - b.e);
    const want = sorted.map((l) => sy(l.e));
    const pos = want.slice();
    const gap = 15;
    for (let i = 1; i < pos.length; i++) if (pos[i - 1] - pos[i] < gap) pos[i] = pos[i - 1] - gap; // y grows downward
    if (pos.length && pos[pos.length - 1] < T + 6) {
      const shift = T + 6 - pos[pos.length - 1];
      for (let i = 0; i < pos.length; i++) pos[i] = Math.min(B - 4, pos[i] + shift);
      for (let i = pos.length - 2; i >= 0; i--) if (pos[i] - pos[i + 1] < gap) pos[i] = pos[i + 1] + gap;
    }
    const levG = s("g", { class: "levels" });
    const lx = x1 + 22;
    const geo = sorted.map((l, i) => {
      const y = want[i];
      const line = s("line", { class: "level", x1: x0 + 5, x2: x1 - 5, y1: y, y2: y, style: { stroke: colorOf(l.color, 0) } });
      levG.appendChild(line);
      if (Math.abs(pos[i] - y) > 0.5) levG.appendChild(s("path", { class: "level-leader", d: `M${x1 + 3},${y}L${lx - 6},${pos[i]}` }));
      else levG.appendChild(s("line", { class: "level-leader", x1: x1 + 3, x2: lx - 6, y1: y, y2: y }));
      const text = s("text", { class: "level-label", x: lx, y: pos[i], "dominant-baseline": "central" },
        s("tspan", { class: "level-name" }, ellipsize(String(l.label), Math.max(24, R - lx - textWidth(energyText(l.e), 11.5) - 8), 11.5)),
        s("tspan", { class: "level-energy", dx: 6 }, energyText(l.e)));
      levG.appendChild(text);
      return { l, y, line };
    });
    svg.appendChild(levG);

    const overlay = s("rect", { class: "chart-overlay", x: L, y: T, width: plotW, height: plotH });
    svg.appendChild(overlay);
    let hot = null;
    attachInspector(st, svg, overlay, {
      count: () => geo.length,
      nearest: (px, py) => {
        let best = -1, bd = 12;
        geo.forEach((g, i) => { const d = Math.abs(g.y - py); if (d < bd) { bd = d; best = i; } });
        return best;
      },
      hide: () => { if (hot) hot.classList.remove("is-hot"); hot = null; hideTip(st); },
      show: (i) => {
        const g = geo[i];
        if (!g) return;
        if (hot) hot.classList.remove("is-hot");
        hot = g.line;
        hot.classList.add("is-hot");
        showTip(st, tipBox(String(g.l.label), [{ color: colorOf(g.l.color, 0), value: unit ? `${fmtVal(g.l.e)} ${unit}` : fmtVal(g.l.e), name: nameOf(yLabel) }]), (x0 + x1) / 2, g.y);
      },
    });
  }

  ECCL.plot = {
    lineChart, stickChart, barChart, levelDiagram,
    // exposed for reuse/testing
    _internal: { linearTicks, logTicks, resolveDomain, tickStep, logLabel },
  };
})(window.ECCL);
