import { AttentionPage, RetryAttention } from "./src/attention";
import { WebhookSettings } from "./src/webhooks";
import { StashPage } from "./src/stash";
import { registerContextWorkspace } from "./src/context-workspace";
import { RailCommandEngine, registerRailCommands } from "./src/rail-commands";
import { toggleNav } from "./src/nav-fold";
// bb-plugin-navaigate-skin — the NavAIgate platform look for bb.
//
//   Rail          experimental_threadList   run-sheet sidebar, real folders, harness marks, right-click
//   Control room  homepageSection           one strip across every harness
//   ::nav-chart   messageDirective          charts inside replies
//   Usage dock    experimental_appOverlay   context + plan limits under the chat box
//   Chips         experimental_appOverlay   Run on the always-on Mac, Move to the always-on Mac and back, hold for sub-agents, Claude account, under the chat box
//   Tabs          experimental_appOverlay   Chrome-style strip of open chats; dock via bb's split
//
// Styling follows the Slate system.
// Colours come only from host tokens; the bundled NavAIgate theme drives them.
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { DeliveryPanel } from "./src/delivery";
import { DeliveryHeaderButton, deliveryTabOpen } from "./src/delivery-header";
import { Rail } from "./src/rail";
import { ControlRoom } from "./src/control-room";
import { NavChart } from "./src/chart";
import { UsageDock } from "./src/usage-dock";
import { ComposerChips } from "./src/composer-chips";
import { ComposerBridge } from "./src/composer-bridge";
import { ComposerThreadDrop } from "./src/composer-thread-drop";
import { NavLinks, NavPipeline } from "./src/directives";
import { AgentsPanel } from "./src/agents";
import { Boundary } from "./src/boundary";
import { OUTSIDE_FILE_EXTENSIONS, OutsideFileOpener } from "./src/outside-file-opener";
import { CalendarPage } from "./src/calendar";
import { DashboardPage } from "./src/dashboard";
import { M1HeaderButton, M1Panel } from "./src/m1";
import { HomePage } from "./src/home";
import { NewThreadHero } from "./src/new-thread-hero";
import { InboxPage } from "./src/inbox-page";
import { HeaderMark } from "./src/header-mark";
import { toggleMode } from "./src/mode-toggle";
import { FeaturesGuide } from "./src/features-guide";
import { FEATURES_GUIDE_PATH, openFeaturesGuide } from "./src/features-guide-nav";
import { TodoBoard, TodoHeaderButton, TodoPanel } from "./src/todo";
import { TabStrip } from "./src/tabs";
import { VoiceEngine, VoiceHeaderButton, VoicePanel, voice } from "./src/voice";
import { NativeConversationOverlay, NativeConversationPanel, NativeConversationComposerScope, NativeModelsComposer, NativeModelsHeader } from "./src/native-sessions";
import { mac } from "./src/words";
import { ProfileLoader } from "./src/profile-loader";
import type { ComponentType } from "react";
import { gated, registerAtLoad as at, useFeature } from "./src/use-feature";
import { pageGate } from "./src/feature-off";
import { SETUP_PATH } from "./src/setup-model";
import { SetupPage, SetupSettings } from "./src/setup";

// Both ticks name the same drop; each hook runs on every render.
function ThreadDropGate() {
  const a = useFeature("F57");
  const b = useFeature("EXTRA-D");
  return a || b ? <ComposerThreadDrop /> : null;
}

export default definePluginApp((app) => {
  // Setup is always reachable: a page, and a short block in Settings.
  app.slots.navPanel({ id: "setup", title: "Setup", icon: "Settings", path: SETUP_PATH, component: () => <Boundary label="Setup"><SetupPage /></Boundary> });
  app.slots.settingsSection({ id: "setup", title: "Console setup", description: "Your name, your Macs, optional addresses and which features are on.", component: () => <Boundary label="Console setup"><SetupSettings /></Boundary> });
  // Pages, tabs and menu items below are registered only when their feature is on at load (src/use-feature.ts);
  // a change made in setup reaches the sidebar after a reload. Components also draw nothing, or an "off" note, while their feature is off.
  if (at("F51")) app.slots.settingsSection({ id: "webhooks", title: "Automation webhooks", description: "Start an agent task from a signed webhook, with a secret, a public URL and recent deliveries.", component: gated("F51", () => <Boundary label="Automation webhooks"><WebhookSettings /></Boundary>) });
  if (at("F30")) app.slots.navPanel({ id: "work-needs-you", title: "Work needs you", icon: "Inbox", path: "work-needs-you", component: pageGate("F30", () => <Boundary label="Work needs you"><AttentionPage /></Boundary>) });
  if (at("EXTRA-A")) app.slots.navPanel({ id: "stash", title: "Stash", icon: "Archive", path: "stash", component: pageGate("EXTRA-A", () => <Boundary label="Stash"><StashPage /></Boundary>) });
  app.slots.experimental_tab({ context: { kind: "thread" }, availability: "action", id: "provider-retry", title: "Quota retry", icon: "Clock", component: ({ threadId }) => <RetryAttention threadId={threadId} /> });
  // Delivery is one page with a view per feature; it is registered while any of its views is on, and each view follows its own tick.
  const deliveryAtLoad = ["F63", "F67", "F68", "F73", "F75", "F79", "F80", "F81"].some(at);
  if (deliveryAtLoad) app.slots.navPanel({ id: "delivery", title: "Delivery", icon: "GitPullRequest", path: "delivery", component: () => <Boundary label="Delivery"><DeliveryPanel /></Boundary> });
  if (deliveryAtLoad) app.slots.experimental_tab({ context: { kind: "thread" }, availability: "action", id: "delivery", title: "Delivery", icon: "GitPullRequest", layout: "flush", component: ({ threadId }) => <Boundary label="Delivery"><DeliveryPanel threadId={threadId} /></Boundary> });
  if (deliveryAtLoad && at("F72")) app.commands.register({ id: "open-delivery", title: "Workspace: PR delivery, worktrees, review, research and diagnosis", defaultShortcut: { key: "y", mod: true, shift: true }, isAvailable: (context) => !!context.threadId, run: (context) => { context.experimental_panel.openTab(deliveryTabOpen as never); } });
  registerContextWorkspace(app);
  registerRailCommands(app);
  if (at("F72")) app.commands.register({ id: "toggle-navigation", title: "Workspace: fold or unfold the navigation", defaultShortcut: { key: "b", mod: true, shift: true }, run: () => toggleNav() });
  app.slots.experimental_appOverlay({ id: "profile-loader", component: ProfileLoader });
  app.slots.experimental_appOverlay({ id: "rail-commands", component: RailCommandEngine });
  // Existing custom header controls still use BB's documented runtime adapter.
  const headerSlots = app.slots as typeof app.slots & {
    experimental_threadHeaderAction(registration: { id: string; title: string; component: import("react").ComponentType<{ threadId: string; projectId: string; isCompactViewport: boolean }> }): void;
  };
  headerSlots.experimental_threadHeaderAction({ id: "conversation-models", title: "Conversation models", component: gated("F04", NativeModelsHeader as ComponentType<{ threadId: string; projectId: string; isCompactViewport: boolean }>) });
  if (deliveryAtLoad) headerSlots.experimental_threadHeaderAction({ id: "delivery-button", title: "Delivery", component: ({ threadId }) => <Boundary label="Delivery button" compact><DeliveryHeaderButton threadId={threadId} /></Boundary> });
  app.slots.experimental_appOverlay({ id: "native-conversations", component: gated("F04", NativeConversationOverlay) });
  app.composer.customize({ id: "conversation-models", scopes: ["thread"], banners: [{ id: "scope", chrome: "bare", component: gated("F04", () => <Boundary label="Conversation scope" compact><NativeConversationComposerScope /></Boundary>) }], actions: [{ id: "models", component: gated("F04", () => <Boundary label="Models" compact><NativeModelsComposer /></Boundary>) }] });
  app.slots.experimental_tab({ context: { kind: "thread" }, availability: "action", id: "native-conversation", title: "Conversation", icon: "MessagesSquare", layout: "flush", useVisible: () => useFeature("F04"), component: ({ threadId }) => <Boundary label="Conversation"><NativeConversationPanel threadId={threadId} /></Boundary> });
  app.slots.experimental_threadList({
    id: "rail",
    title: "NavAIgate rail",
    description: "Run-sheet sidebar: NOW card, harness filter, real folders from project-folders, right-click on everything.",
    component: Rail,
  });
  app.slots.homepageSection({ id: "control-room", title: "Control room", component: gated("EXTRA-N", ControlRoom) });
  if (at("EXTRA-AC")) app.slots.fileOpener({ id: "outside-project-files", title: "Files saved outside the project", extensions: OUTSIDE_FILE_EXTENSIONS, component: (p) => <Boundary label="File link"><OutsideFileOpener {...p} /></Boundary> });
  if (at("F54")) {
    app.slots.messageDirective({ id: "nav-chart", component: NavChart });
    app.slots.messageDirective({ id: "nav-links", component: (p) => <Boundary label="Link cards" compact><NavLinks {...p} /></Boundary> });
    app.slots.messageDirective({ id: "nav-pipeline", component: (p) => <Boundary label="Pipeline" compact><NavPipeline {...p} /></Boundary> });
  }
  app.slots.experimental_appOverlay({ id: "usage-dock", component: gated("F48", UsageDock) });
  // Send to the always-on Mac and the Claude account chip, in the row under the chat box.
  app.slots.experimental_appOverlay({ id: "composer-chips", component: () => <Boundary label="Composer chips" compact><ComposerChips /></Boundary> });
  // Drop a chat from the rail on the chat box to add it as context.
  app.slots.experimental_appOverlay({ id: "composer-thread-drop", component: ThreadDropGate });
  // Invisible: hands each composer's API to the chips (draft text, machine picker).
  app.composer.customize({ id: "chips-bridge", scopes: ["new-thread", "thread"], actions: [{ id: "bridge", component: ComposerBridge }] });
  // Chrome-style tab strip across the top; docking rides on bb's own split.
  app.slots.experimental_appOverlay({ id: "tabs", component: gated("EXTRA-T", () => <Boundary label="Tabs" compact><TabStrip /></Boundary>) });
  app.slots.experimental_appOverlay({ id: "new-thread-hero", component: gated("EXTRA-U", NewThreadHero) });
  // Agents: the orchestration space on the right — family map, log, spin up.
  app.slots.experimental_tab({ context: { kind: "thread" }, availability: "action",
    id: "agents",
    title: "Agents",
    icon: "navaigate-skin/agents",
    layout: "flush",
    useVisible: () => useFeature("EXTRA-AF"),
    component: ({ threadId }) => (
      <Boundary label="Agents panel">
        <AgentsPanel threadId={threadId} />
      </Boundary>
    ),
  });
  if (at("EXTRA-AF") && at("F72")) app.commands.register({
    id: "open-agents",
    title: "Workspace: open agents",
    defaultShortcut: { key: "a", mod: true, shift: true },
    run: (ctx) => {
      if (!ctx.threadId) return;
      try {
        ctx.experimental_panel.openTab({ tab: { id: "agents", context: { kind: "thread" }, availability: "action" }, title: "Agents" });
      } catch (e) {
        console.error("[navaigate-skin] open agents failed", e);
      }
    },
  });
  // To-do: right-hand panel in any chat, a Board page, a header button and ⌘⇧D.
  app.slots.experimental_tab({ context: { kind: "thread" }, availability: "action",
    id: "todo",
    title: "To-do",
    icon: "navaigate-skin/todo",
    layout: "flush",
    useVisible: () => useFeature("EXTRA-R"),
    component: ({ threadId }) => <TodoPanel threadId={threadId} />,
  });
  headerSlots.experimental_threadHeaderAction({ id: "todo-button", title: "To-do", component: gated("EXTRA-R", ({ threadId }: { threadId: string; projectId: string; isCompactViewport: boolean }) => <TodoHeaderButton threadId={threadId} />) });
  // On the always-on Mac: a chat handed to the home Mac shows its live progress here.
  app.slots.experimental_tab({ context: { kind: "thread" }, availability: "action",
    id: "m1",
    title: `On ${mac()}`,
    icon: "navaigate-skin/workspace",
    layout: "flush",
    useVisible: () => useFeature("EXTRA-AE"),
    component: ({ threadId }) => (
      <Boundary label={`On ${mac()}`}>
        <M1Panel threadId={threadId} />
      </Boundary>
    ),
  });
  headerSlots.experimental_threadHeaderAction({ id: "m1-button", title: `On ${mac()}`, component: gated("EXTRA-AE", ({ threadId }: { threadId: string; projectId: string; isCompactViewport: boolean }) => <M1HeaderButton threadId={threadId} />) });
  if (at("EXTRA-R")) app.slots.navPanel({ id: "board", title: "Board", icon: "navaigate-skin/board", path: "board", component: pageGate("EXTRA-R", () => <TodoBoard />) });
  // Home: the NavAIgate front page (logo orb, brief, Jev, subscriptions, money).
  if (at("EXTRA-N")) app.slots.navPanel({
    id: "home",
    title: "Home",
    icon: "Home",
    path: "home",
    component: pageGate("EXTRA-N", () => <Boundary label="Home"><HomePage /></Boundary>),
  });
  // Calendar: month view of both Google Calendars, day panel, ask box, booking links.
  if (at("EXTRA-J")) app.slots.navPanel({
    id: "calendar",
    title: "Calendar",
    icon: "Calendar",
    path: "calendar",
    component: pageGate("EXTRA-J", () => <Boundary label="Calendar"><CalendarPage /></Boundary>),
  });
  // Inbox: all mail from three Gmail accounts, read-only; Sort with Jev puts every email in a pile.
  if (at("EXTRA-I")) app.slots.navPanel({
    id: "inbox",
    title: "Inbox",
    icon: "Mail",
    path: "inbox",
    component: pageGate("EXTRA-I", () => <Boundary label="Inbox"><InboxPage /></Boundary>),
  });
  // NavAIgate mark in bb's sidebar header (choose it in Settings, Appearance).
  // bb 0.46 removed the sidebar-header slot (get-bb/bb#5229). Register it only where it
  // still exists, so newer bb versions don't fail the whole plugin.
  const slots = app.slots as unknown as Record<string, unknown>;
  if (typeof slots.experimental_sidebarHeader === "function") {
    try {
      (slots.experimental_sidebarHeader as (registration: unknown) => void)({ id: "navaigate-header", title: "NavAIgate", description: "The NavAIgate orb and name at the top of the sidebar.", component: HeaderMark });
    } catch {
      /* slot gone in this bb version */
    }
  }
  // Keep navigation with bb's bundled Navigation plugin. Registering a list here
  // makes Automatic choose it instead of bb's left icon rail on a fresh install.
  // The NavAIgate thread list above remains independent of navigation placement.
  // Dashboard: any local web app you run, framed as a page in bb (setting: Dashboards).
  if (at("EXTRA-S")) app.slots.navPanel({
    id: "dashboard",
    title: "Dashboard",
    icon: "AppWindow",
    path: "dashboard",
    component: pageGate("EXTRA-S", () => <Boundary label="Dashboard"><DashboardPage /></Boundary>),
  });
  if (at("EXTRA-R") && at("F72")) app.commands.register({
    id: "open-todo",
    title: "Workspace: open to-do",
    defaultShortcut: { key: "d", mod: true, shift: true },
    run: (ctx) => {
      if (ctx.threadId && ctx.experimental_panel.openTab({ tab: { id: "todo", context: { kind: "thread" }, availability: "action" }, title: "To-do" })) return;
      window.history.pushState({}, "", "/plugins/navaigate-skin/board");
      window.dispatchEvent(new PopStateEvent("popstate", { state: {} }));
    },
  });
  // Voice agent (Savvy on ElevenLabs): one engine for the whole window, a Talk
  // button in each chat header, a Voice tab with the transcript, and ⌘⇧E.
  app.slots.experimental_appOverlay({ id: "voice-engine", component: gated("EXTRA-Q", VoiceEngine) });
  app.slots.experimental_tab({ context: { kind: "thread" }, availability: "action", id: "voice", title: "Voice", icon: "Mic", layout: "flush", useVisible: () => useFeature("EXTRA-Q"), component: () => <VoicePanel /> });
  headerSlots.experimental_threadHeaderAction({ id: "voice-button", title: "Talk to Savvy", component: gated("EXTRA-Q", () => <VoiceHeaderButton />) });
  if (at("EXTRA-Q") && at("F72")) app.commands.register({
    id: "voice-toggle",
    title: "Workspace: talk to Savvy",
    defaultShortcut: { key: "e", mod: true, shift: true },
    run: (ctx) => {
      if (ctx.threadId) ctx.experimental_panel.openTab({ tab: { id: "voice", context: { kind: "thread" }, availability: "action" }, title: "Voice" });
      voice.toggle();
    },
  });
  // The guide is always on: it is where a switched-off feature is explained and setup is reached.
  app.slots.navPanel({ id: "features", title: "Features", icon: "navaigate-skin/guide", path: FEATURES_GUIDE_PATH, component: () => <Boundary label="Features"><FeaturesGuide /></Boundary> });
  app.commands.register({ id: "open-features-guide", title: "Workspace: features guide", run: () => openFeaturesGuide() });
  app.experimental_sidebarFooter.register({
    kind: "action",
    id: "features-guide",
    label: "Features guide",
    icon: "navaigate-skin/guide",
    onActivate: () => openFeaturesGuide(),
  });
  if (at("EXTRA-Z")) app.experimental_sidebarFooter.register({
    kind: "action",
    id: "light-dark",
    label: "Switch light / dark mode",
    icon: "navaigate-skin/contrast",
    onActivate: () => toggleMode(),
  });
});
