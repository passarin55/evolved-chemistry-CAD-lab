/* Notebook panel - placeholder. The panel implementation replaces this file. */
window.ECCL = window.ECCL || {};

ECCL.registerPanel({
  id: "notebook",
  title: "Notebook",
  group: "AI & Data",
  icon: "book",
  description: "Lab history: analyses, runs and notes. Annotate, export and import.",
  order: 130,
  render(root, ctx) {
    const ui = ECCL.ui;
    root.appendChild(ui.card(
      { title: "Under construction", subtitle: "Notebook panel" },
      ui.notice("This panel is being built. The lab engine behind it is ready; its interface lands in the next stage.", "info"),
      ui.button("Back to dashboard", { kind: "ghost", icon: "home", onClick: () => ctx.navigate("dashboard") })
    ));
  },
});
