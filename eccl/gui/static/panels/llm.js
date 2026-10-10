/* LLM assistant panel - placeholder. The panel implementation replaces this file. */
window.ECCL = window.ECCL || {};

ECCL.registerPanel({
  id: "llm",
  title: "LLM assistant",
  group: "AI & Data",
  icon: "chat",
  description: "Configure the local language-model backend and chat with the lab assistant.",
  order: 120,
  render(root, ctx) {
    const ui = ECCL.ui;
    root.appendChild(ui.card(
      { title: "Under construction", subtitle: "LLM assistant panel" },
      ui.notice("This panel is being built. The lab engine behind it is ready; its interface lands in the next stage.", "info"),
      ui.button("Back to dashboard", { kind: "ghost", icon: "home", onClick: () => ctx.navigate("dashboard") })
    ));
  },
});
