/* LLM assistant panel - show and configure the language-model backend (Ollama,
 * any OpenAI-compatible server such as LM Studio, or the offline echo
 * fallback) and chat with it. The whole conversation is sent with every
 * request; replies are rendered as plain text with whitespace preserved.
 */
window.ECCL = window.ECCL || {};

(function (ECCL) {
  "use strict";

  const DEFAULT_SYSTEM = "You are a careful scientific assistant for a chemistry and materials lab. " +
    "Be precise and concise, give units, state your assumptions and uncertainty, and say plainly when you do not know.";
  const BACKEND_LABEL = {
    auto: "auto: try Ollama, then OpenAI-compatible, else offline",
    ollama: "ollama: local Ollama server",
    openai: "openai: OpenAI-compatible (LM Studio, vLLM, llama.cpp)",
    echo: "echo: offline placeholder (no model)",
  };
  const URL_PLACEHOLDER = { ollama: "http://localhost:11434", openai: "http://localhost:1234/v1", auto: "blank = each backend's default", echo: "not used by the echo backend" };
  const MODEL_PLACEHOLDER = { ollama: "llama3.1", openai: "local-model", auto: "blank = backend default", echo: "not used" };
  const QUICK = [
    { label: "Explain the Shockley–Queisser limit", text: "Explain the Shockley–Queisser limit for single-junction solar cells: where the ~33% maximum comes from, which assumptions it rests on, and how tandem cells get around it." },
    { label: "Critique aspirin", text: "Critique aspirin (SMILES CC(=O)Oc1ccccc1C(=O)O) as a drug candidate: strengths, liabilities, and one structural change you would explore." },
    { label: "Interpret an IR spectrum", text: "An IR spectrum shows a broad band at 3300 cm-1 and sharp bands at 1715 and 1250 cm-1. Which functional groups are consistent with this, and what other measurement would you use to confirm?" },
    { label: "Plan a perovskite screen", text: "Outline a quick computational screen for lead-free halide perovskites with band gaps near 1.3 eV. Which descriptors (tolerance factor, octahedral factor, ...) would you compute, and in what order?" },
  ];

  const S = {
    ctx: null, status: null, requested: null, statusEl: null, form: null,
    messages: [], msgsEl: null, input: null, sendBtn: null, clearBtn: null, chips: [], chatErr: null,
    system: null, temperature: null, maxTokens: null, pending: false,
  };
  const ui = () => ECCL.ui;
  const api = () => ECCL.api;
  const isEcho = (name) => /^echo/i.test(String(name || ""));

  // ------------------------------------------------------------------ status

  function setStatus(st) {
    S.status = st;
    paintStatus();
  }

  function paintStatus() {
    const { el, kv, badge, notice, spinner } = ui();
    const st = S.status;
    if (!st) { S.statusEl.replaceChildren(el("div", { class: "llm-meta" }, spinner("Loading"), " checking the backend…")); return; }
    const echo = isEcho(st.backend) || !st.reachable;
    // what was asked for survives a fallback (and a page reload) in configured_* from the server
    const req = S.requested || (st.configured_backend
      ? { backend: st.configured_backend, base_url: st.configured_base_url || null, model: st.configured_model || null } : null);
    const pairs = [
      ["Active backend", el("span", { class: "mono" }, st.backend || "unknown")],
      ["Model", st.model || (req && req.model ? `${req.model} (requested)` : "—")],
      ["Reachable", echo ? badge("no · offline fallback", "warn") : badge("yes", "ok")],
      ["Configured backend", st.configured_backend || (req && req.backend) || "auto"],
      ["Base URL", st.base_url ? el("span", { class: "mono" }, st.base_url) : (req && req.base_url ? el("span", { class: "mono" }, `${req.base_url} (requested)`) : "—")],
    ];
    const nodes = [kv(pairs)];
    if (st.fallback && req) {
      nodes.push(notice(`ECCL could not reach the ${req.backend} backend${req.base_url ? ` at ${req.base_url}` : ""}, so it fell back to the offline echo client.`, "bad"));
    }
    if (echo) {
      nodes.push(notice(el("div", null,
        el("strong", null, "The offline echo fallback is active. "),
        "No local model answered, so chat replies are deterministic placeholders rather than generated text. Every other ECCL tool works without an LLM. To enable real answers, run a local model and point ECCL at it:",
        el("ol", { class: "llm-howto" },
          el("li", null, el("strong", null, "Ollama: "), "install it, run ", el("code", null, "ollama pull llama3.1"), " and keep ", el("code", null, "ollama serve"),
            " running; then choose backend ", el("code", null, "ollama"), " with base URL ", el("code", null, "http://localhost:11434"), "."),
          el("li", null, el("strong", null, "LM Studio: "), "load a model and start the local server (Developer tab); then choose backend ", el("code", null, "openai"),
            " with base URL ", el("code", null, "http://localhost:1234/v1"), " and the model's identifier."),
          el("li", null, "Or start ECCL with ", el("code", null, "ECCL_LLM_BACKEND"), ", ", el("code", null, "ECCL_LLM_BASE_URL"), " and ", el("code", null, "ECCL_LLM_MODEL"), " set.")),
        el("div", { class: "llm-meta", style: { margin: "6px 0 0" } }, "The ECCL server makes these requests, so \"localhost\" means the machine running eccl gui.")), "info"));
    } else {
      nodes.push(notice(`Chat requests go to ${st.backend}${st.base_url ? ` at ${st.base_url}` : ""}.`, "ok"));
    }
    S.statusEl.replaceChildren(...nodes);
  }

  async function refreshStatus() {
    const st = await api().get("/api/llm/status");
    setStatus(st);
    ECCL.bus.emit("llm:changed", st);
    return st;
  }

  // ------------------------------------------------------------------ configure

  function buildConfigForm() {
    const { form } = ui();
    const backends = (ECCL.info.libraries && ECCL.info.libraries.llm_backends) || Object.keys(BACKEND_LABEL);
    // prefill from the live status (configured_*), falling back to the startup config
    const st = ECCL.info.llm || {};
    const cfg = ECCL.info.config || {};
    const want = st.configured_backend || cfg.llm_backend;
    const initial = backends.includes(want) ? want : backends[0];
    const baseUrl = st.configured_base_url ?? cfg.llm_base_url ?? "";
    const modelName = st.configured_model ?? cfg.llm_model ?? "";
    S.form = form({
      columns: 1,
      submitLabel: "Apply",
      submitIcon: "check",
      fields: [
        { name: "backend", label: "Backend", type: "select", value: initial,
          options: backends.map((b) => ({ value: b, label: BACKEND_LABEL[b] || b })),
          onChange: (v) => paintPlaceholders(v) },
        { name: "base_url", label: "Base URL", type: "text", value: baseUrl || "", mono: true,
          help: "Leave blank for the backend's default address.",
          validate: (v) => (v && !/^https?:\/\/[^\s/]+/i.test(v) ? "Must be an http:// or https:// URL, e.g. http://localhost:11434" : null) },
        { name: "model", label: "Model", type: "text", value: modelName || "", mono: true, help: "Model name or identifier; blank = backend default." },
      ],
      onSubmit: configure,
    });
    paintPlaceholders(initial);
    return S.form;
  }

  function paintPlaceholders(backend) {
    const url = S.form.field("base_url"), model = S.form.field("model");
    url.input.placeholder = URL_PLACEHOLDER[backend] || "http://localhost:11434";
    model.input.placeholder = MODEL_PLACEHOLDER[backend] || "";
    url.input.disabled = backend === "echo";
    model.input.disabled = backend === "echo";
  }

  async function configure(values) {
    const body = { backend: values.backend, base_url: values.backend === "echo" ? null : (values.base_url || null), model: values.backend === "echo" ? null : (values.model || null) };
    S.requested = body;
    const st = await api().post("/api/llm/configure", body);
    setStatus(st);
    ECCL.bus.emit("llm:changed", st);
    if (st.fallback) ui().toast(`Could not reach ${body.backend}${body.base_url ? ` at ${body.base_url}` : ""}; using the offline fallback.`, "warn", 6000);
    else if (isEcho(st.backend)) ui().toast(body.backend === "echo" ? "Using the offline echo backend." : "No local model found; using the offline fallback.", body.backend === "echo" ? "info" : "warn");
    else ui().toast(`Connected to ${st.backend}`, "ok");
    return st;
  }

  // ------------------------------------------------------------------ chat

  function bubble(msg) {
    const { el } = ui();
    const fallback = msg.role === "assistant" && isEcho(msg.backend);
    const meta = msg.role === "assistant"
      ? [msg.backend, msg.model && !String(msg.backend || "").includes(msg.model) ? msg.model : null,
        Number.isFinite(msg.ms) ? (msg.ms < 1000 ? `${Math.max(1, Math.round(msg.ms))} ms` : `${(msg.ms / 1000).toFixed(1)} s`) : null].filter(Boolean).join(" · ")
      : "You";
    return el("div", { class: ["llm-msg", `is-${msg.role}`, fallback && "is-fallback"] },
      el("div", { class: "visually-hidden" }, msg.role === "user" ? "You said:" : "Assistant said:"),
      el("div", { class: "llm-bubble" }, msg.content),
      el("div", { class: "llm-meta" }, meta));
  }

  function paintMessages() {
    const { el, empty, spinner } = ui();
    const nodes = S.messages.map(bubble);
    if (S.pending) {
      nodes.push(el("div", { class: "llm-msg is-assistant llm-pending", role: "status" },
        el("div", { class: "llm-bubble" }, spinner("Waiting for the model"), "Thinking…"),
        el("div", { class: "llm-meta" }, (S.status && S.status.backend) || "assistant")));
    }
    if (!nodes.length) nodes.push(empty("No messages yet. Ask a question below or pick a quick prompt."));
    S.msgsEl.replaceChildren(...nodes);
    S.msgsEl.scrollTop = S.msgsEl.scrollHeight;
  }

  function setPending(on) {
    S.pending = !!on;
    for (const c of S.chips) c.disabled = !!on;
    S.clearBtn.disabled = !!on;
    paintMessages();
  }

  function readSettings() {
    let bad = null;
    for (const f of [S.temperature, S.maxTokens]) { const m = f.validate(); if (m && !bad) bad = [f, m]; }
    if (bad) { bad[0].input.focus(); throw ui().inputError(`${bad[0].spec.label}: ${bad[1]}`); }
    return { temperature: S.temperature.getValue(), max_tokens: S.maxTokens.getValue() };
  }

  function send(text) {
    if (S.pending) return Promise.resolve();
    const content = String(text ?? S.input.getValue()).trim();
    S.input.setError(null);
    S.chatErr.replaceChildren();
    if (!content) {
      S.input.setError("Type a message first");
      S.input.input.focus();
      return Promise.resolve();
    }
    let settings;
    try { settings = readSettings(); }
    catch (err) { S.chatErr.replaceChildren(ui().notice(ui().errMessage(err), "bad")); return Promise.resolve(); }
    const msg = { role: "user", content };
    S.messages.push(msg);
    S.input.setValue("");
    const body = {
      messages: S.messages.map((m) => ({ role: m.role, content: m.content })),
      system: S.system.getValue().trim() || null,
      ...settings,
    };
    setPending(true);
    const t0 = performance.now();
    const p = api().post("/api/llm/chat", body).then((r) => {
      S.messages.push({ role: "assistant", content: String(r.text ?? ""), backend: r.backend, model: r.model, ms: performance.now() - t0 });
      setPending(false);
      S.input.input.focus();
    }, (err) => {
      // Take the unanswered message back so the history stays user/assistant alternating.
      const i = S.messages.lastIndexOf(msg);
      if (i >= 0) S.messages.splice(i, 1);
      if (!S.input.getValue()) S.input.setValue(content);
      setPending(false);
      S.chatErr.replaceChildren(ui().errorBox(err));
      ui().toast(`Chat failed: ${ui().errMessage(err)}`, "bad");
    });
    ui().busy(S.sendBtn, p);
    return p;
  }

  function clearChat() {
    if (S.pending) return;
    S.messages = [];
    S.chatErr.replaceChildren();
    S.input.setError(null);
    paintMessages();
    S.input.input.focus();
  }

  function buildChat() {
    const { el, card, field, button, icon } = ui();
    S.system = field({ name: "system", label: "System prompt", type: "textarea", rows: 3, value: DEFAULT_SYSTEM, help: "Sent with every request; leave blank for none." });
    const systemBox = el("details", { class: "llm-system" },
      el("summary", null, "System prompt"),
      S.system,
      el("div", { class: "llm-system-actions" }, button("Reset to default", { small: true, kind: "ghost", icon: "refresh", onClick: () => S.system.setValue(DEFAULT_SYSTEM) })));
    S.temperature = field({ name: "temperature", label: "Temperature", type: "range", min: 0, max: 2, step: 0.05, value: 0.2, format: (v) => v.toFixed(2), help: "0 = deterministic, higher = more varied" });
    S.maxTokens = field({ name: "max_tokens", label: "Max tokens", type: "number", min: 1, max: 65536, step: 1, value: 1024, required: true,
      validate: (v) => (v !== null && !Number.isInteger(v) ? "Enter a whole number" : null), help: "Upper bound on the reply length" });
    S.chips = QUICK.map((q) => el("button", { type: "button", class: "chip-btn", title: q.text, on: { click: () => send(q.text) } }, icon("sparkle"), q.label));
    S.msgsEl = el("div", { class: "llm-msgs", role: "log", "aria-live": "polite", "aria-label": "Conversation" });
    S.input = field({ name: "message", label: "Message", type: "textarea", rows: 3, placeholder: "Ask about a molecule, a material or a measurement…" });
    S.input.input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing && !ev.altKey && !ev.ctrlKey && !ev.metaKey) {
        ev.preventDefault();
        send();
      }
    });
    S.sendBtn = button("Send", { kind: "primary", icon: "play", onClick: () => send() });
    S.clearBtn = button("Clear", { kind: "ghost", icon: "trash", onClick: clearChat, title: "Clear the conversation" });
    S.chatErr = el("div", { class: "llm-chat-error" });
    return card({ title: "Chat", subtitle: "The full conversation is sent with every message.", icon: "chat" },
      systemBox,
      el("div", { class: "llm-settings" }, S.temperature, S.maxTokens),
      el("div", { class: "chips", role: "group", "aria-label": "Quick prompts" }, S.chips),
      S.msgsEl,
      S.chatErr,
      el("div", { class: "llm-composer" }, S.input,
        el("div", { class: "llm-composer-actions" }, S.sendBtn, S.clearBtn,
          el("span", { class: "llm-hint" }, el("kbd", null, "Enter"), " to send · ", el("kbd", null, "Shift"), "+", el("kbd", null, "Enter"), " for a new line"))));
  }

  // ------------------------------------------------------------------ panel

  function render(root, ctx) {
    S.ctx = ctx;
    const { el, card, button } = ui();
    S.statusEl = el("div", { class: "llm-status" });
    const refresh = button("Refresh", { small: true, kind: "ghost", icon: "refresh", onClick: refreshStatus, title: "Ask the server for the current backend status" });
    root.append(
      el("p", { class: "panel-intro" },
        "Connect ECCL to a local language model (Ollama, LM Studio or any OpenAI-compatible server) and chat with it. " +
        "The same backend writes deep-search briefings and the optional LLM critic; without one, ECCL uses a clearly labelled offline placeholder."),
      el("div", { class: "llm-top" },
        card({ title: "Backend status", icon: "activity", actions: refresh }, S.statusEl),
        card({ title: "Configure", subtitle: "Applying probes the backend; an unreachable one falls back to offline.", icon: "chip" }, buildConfigForm())),
      buildChat());
    setStatus(ECCL.info.llm || null);
    paintMessages();
    ctx.bus.on("llm:changed", (st) => { if (st && typeof st === "object" && "backend" in st && st !== S.status) { S.status = { ...(S.status || {}), ...st }; paintStatus(); } });
    refreshStatus().catch((err) => { S.statusEl.replaceChildren(ui().errorBox(err)); });
  }

  ECCL.registerPanel({
    id: "llm",
    title: "LLM assistant",
    group: "AI & Data",
    icon: "chat",
    description: "Configure the local language-model backend and chat with the lab assistant.",
    order: 120,
    render,
  });
})(window.ECCL);
