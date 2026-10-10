/* Spectroscopy panel - placeholder. The panel implementation replaces this file. */
window.ECCL = window.ECCL || {};

ECCL.registerPanel({
  id: "spectroscopy",
  title: "Spectroscopy",
  group: "Analysis",
  icon: "spectrum",
  description: "Interpret IR, Raman, 1H / 13C NMR and mass spectra, and cross-validate across modalities.",
  order: 80,
  render(root, ctx) {
    const ui = ECCL.ui;
    root.appendChild(ui.card(
      { title: "Under construction", subtitle: "Spectroscopy panel" },
      ui.notice("This panel is being built. The lab engine behind it is ready; its interface lands in the next stage.", "info"),
      ui.button("Back to dashboard", { kind: "ghost", icon: "home", onClick: () => ctx.navigate("dashboard") })
    ));
  },
});
