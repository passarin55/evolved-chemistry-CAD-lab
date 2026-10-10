/* Semiconductors panel - placeholder. The panel implementation replaces this file. */
window.ECCL = window.ECCL || {};

ECCL.registerPanel({
  id: "semiconductor",
  title: "Semiconductors",
  group: "Materials",
  icon: "chip",
  description: "Band gap vs temperature, carriers and doping, Fermi level and Shockley-Queisser screening.",
  order: 30,
  render(root, ctx) {
    const ui = ECCL.ui;
    root.appendChild(ui.card(
      { title: "Under construction", subtitle: "Semiconductors panel" },
      ui.notice("This panel is being built. The lab engine behind it is ready; its interface lands in the next stage.", "info"),
      ui.button("Back to dashboard", { kind: "ghost", icon: "home", onClick: () => ctx.navigate("dashboard") })
    ));
  },
});
