/* Photonics panel - placeholder. The panel implementation replaces this file. */
window.ECCL = window.ECCL || {};

ECCL.registerPanel({
  id: "photonics",
  title: "Photonics",
  group: "Materials",
  icon: "beam",
  description: "Sellmeier dispersion, Fresnel reflectance, slab waveguides, Bragg mirrors and Fabry-Perot cavities.",
  order: 40,
  render(root, ctx) {
    const ui = ECCL.ui;
    root.appendChild(ui.card(
      { title: "Under construction", subtitle: "Photonics panel" },
      ui.notice("This panel is being built. The lab engine behind it is ready; its interface lands in the next stage.", "info"),
      ui.button("Back to dashboard", { kind: "ghost", icon: "home", onClick: () => ctx.navigate("dashboard") })
    ));
  },
});
