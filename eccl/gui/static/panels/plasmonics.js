/* Plasmonics panel - placeholder. The panel implementation replaces this file. */
window.ECCL = window.ECCL || {};

ECCL.registerPanel({
  id: "plasmonics",
  title: "Plasmonics",
  group: "Materials",
  icon: "sparkle",
  description: "Drude metals, nanosphere LSPR and Mie cross-sections, surface-plasmon polaritons.",
  order: 50,
  render(root, ctx) {
    const ui = ECCL.ui;
    root.appendChild(ui.card(
      { title: "Under construction", subtitle: "Plasmonics panel" },
      ui.notice("This panel is being built. The lab engine behind it is ready; its interface lands in the next stage.", "info"),
      ui.button("Back to dashboard", { kind: "ghost", icon: "home", onClick: () => ctx.navigate("dashboard") })
    ));
  },
});
