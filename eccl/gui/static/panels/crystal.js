/* Crystals panel - placeholder. The panel implementation replaces this file. */
window.ECCL = window.ECCL || {};

ECCL.registerPanel({
  id: "crystal",
  title: "Crystals",
  group: "Materials",
  icon: "grid",
  description: "Goldschmidt tolerance factor for perovskites and simulated powder XRD patterns.",
  order: 70,
  render(root, ctx) {
    const ui = ECCL.ui;
    root.appendChild(ui.card(
      { title: "Under construction", subtitle: "Crystals panel" },
      ui.notice("This panel is being built. The lab engine behind it is ready; its interface lands in the next stage.", "info"),
      ui.button("Back to dashboard", { kind: "ghost", icon: "home", onClick: () => ctx.navigate("dashboard") })
    ));
  },
});
