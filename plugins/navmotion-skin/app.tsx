// bb-plugin-navmotion-skin: the NavMotion look for bb, plus Markdown in the chat box.
//
//   Skins          bb.themes (package.json)          NavMotion Dots, Live and Tunnel palettes
//   Motion layer   experimental_appOverlay           moving grounds, click ripples, focus pull
//   Skin button    experimental_sidebarFooter        every skin one click away
//   Markdown       composer.customize + tabs         live preview in the chat box (Md button), a side preview
//
// The motion layer only runs while a NavMotion skin is chosen. Pick any other skin and the
// layer removes everything it added.
import "./app.css";
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { MotionLayer } from "./src/motion-layer";
import { SkinMenu } from "./src/skin-menu";
import { MARKDOWN_EFFECTS, PLUS_MENU, LiveToggle, PreviewAction, PreviewPanel, NewThreadPreviewPanel, PREVIEW_ID, transformPaste } from "./src/markdown";

export default definePluginApp((app) => {
  app.slots.experimental_appOverlay({ id: "motion-layer", component: MotionLayer });

  app.experimental_sidebarFooter.register({
    kind: "disclosure",
    id: "skin",
    label: "Skin",
    icon: "Palette",
    component: SkinMenu,
  });

  // transformPaste and the construct fields in the effects are understood by bb builds with live
  // preview (core ledger: composer-live-preview); other builds ignore them. Passed as a value so
  // the published SDK types, which do not list them yet, still accept it.
  const MARKDOWN_RICH_TEXT = { effects: MARKDOWN_EFFECTS, transformPaste };
  app.composer.customize({
    id: "markdown",
    actions: [
      { id: "live", component: LiveToggle },
      { id: "preview", component: PreviewAction },
    ],
    plusMenu: PLUS_MENU,
    richText: MARKDOWN_RICH_TEXT,
  });

  app.slots.experimental_tab({
    context: { kind: "thread" },
    availability: "action",
    id: PREVIEW_ID,
    title: "Preview",
    icon: "Eye",
    layout: "flush",
    component: PreviewPanel,
  });

  app.slots.experimental_newThreadPanelAction({
    id: PREVIEW_ID,
    title: "Preview",
    icon: "Eye",
    layout: "flush",
    component: NewThreadPreviewPanel,
  });
});
