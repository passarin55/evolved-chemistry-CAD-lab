/* Dashboard panel - placeholder. The panel implementation replaces this file. */
window.ECCL = window.ECCL || {};

ECCL.registerPanel({
  id: "dashboard",
  title: "Dashboard",
  group: "Overview",
  icon: "home",
  description: "Lab overview: capabilities, quick actions and recent activity.",
  order: 0,
  render(root, ctx) {
    const ui = ECCL.ui;
    root.appendChild(ui.card(
      { title: "Under construction", subtitle: "Dashboard panel" },
      ui.notice("This panel is being built. The lab engine behind it is ready; its interface lands in the next stage.", "info"),
      ui.grid(3, ECCL.panels
        .filter((p) => p.id !== "dashboard")
        .sort((a, b) => (a.order || 0) - (b.order || 0))
        .map((p) => ui.button(p.title, { icon: p.icon, onClick: () => ctx.navigate(p.id) })))
    ));
  },
});
