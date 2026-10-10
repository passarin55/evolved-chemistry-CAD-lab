/* Molecule panel - placeholder. The panel implementation replaces this file. */
window.ECCL = window.ECCL || {};

ECCL.registerPanel({
  id: "molecule",
  title: "Molecule",
  group: "Chemistry",
  icon: "flask",
  description: "Analyse a molecule from SMILES: structure, descriptors, drug-likeness, critics verdict and simulated IR / UV-Vis.",
  order: 10,
  render(root, ctx) {
    const ui = ECCL.ui;
    root.appendChild(ui.card(
      { title: "Under construction", subtitle: "Molecule panel" },
      ui.notice("This panel is being built. The lab engine behind it is ready; its interface lands in the next stage.", "info"),
      ui.button("Back to dashboard", { kind: "ghost", icon: "home", onClick: () => ctx.navigate("dashboard") })
    ));
  },
});
