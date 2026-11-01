// bb 0.6.104 opens a plugin's side tab with `openTab`; the 0.6.75 SDK this plugin is built against
// calls it `experimental_openTab` and wants the surface named. Whichever the running bb has is used,
// so the eye button works on both.
type PreviewTab = { id: string; context: { kind: "thread" }; availability: "action" };

type PanelController = {
  openTab?: (options: { tab: PreviewTab; title: string }) => boolean;
  experimental_openTab?: (options: { surface: { kind: "current" }; tab: PreviewTab; title: string }) => boolean;
};

export function openPreviewTab(panel: unknown, id: string): boolean {
  const controller = panel as PanelController;
  const tab: PreviewTab = { id, context: { kind: "thread" }, availability: "action" };
  if (typeof controller.openTab === "function") return controller.openTab({ tab, title: "Preview" });
  if (typeof controller.experimental_openTab === "function") {
    return controller.experimental_openTab({ surface: { kind: "current" }, tab, title: "Preview" });
  }
  return false;
}
