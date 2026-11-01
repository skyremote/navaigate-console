export type FeatureStatus =
  | { kind: "live" }
  | { kind: "partly" }
  | { kind: "blocked"; reason: string };

export type ShowMe =
  | { kind: "panel"; path: string }
  | { kind: "route"; href: string; label: string }
  | { kind: "compose" }
  | { kind: "chat"; hint: string }
  | { kind: "none"; reason: string };

/** What the live check on a real build found. RECHECK means it was fixed after that check and has not been seen working since. */
export interface Evidence {
  verdict: "PASS" | "FAIL" | "UNVERIFIED" | "RECHECK";
  note: string;
  date: string;
  build: string;
}

/**
 * Where a tick of the feature picker takes effect. "inline" means the control sits inside a shared view and the code must check the tick there.
 * "plugin" means the feature is a whole separate plugin: it is switched on or off in bb's plugin settings, so the picker records no tick for it.
 */
export type PickerEnforced = "registration" | "server" | "inline" | "always" | "plugin";

export interface FeaturePicker {
  default: "on" | "off";
  /** public-address, two-machines, brain, core:<ledger id> or feature:<id>. */
  requires: readonly string[];
  presets: readonly ("simple" | "pro")[];
  enforced: PickerEnforced;
  /** Where in the code the tick is honoured. */
  gate: string;
  /** The plugin that holds the gate. */
  plugin: string;
  /** Core changes whose absence reduces the feature without hiding it. */
  degradesWithout?: readonly string[];
  /** Core changes that only make the feature better; nothing is hidden. */
  improvedBy?: readonly string[];
}

export interface CoreProbe {
  kind: string;
  detail: string;
}

/** A change our bb build has that upstream bb may lack. effect: hide the features, reduce them, or none. */
export interface CoreChange {
  id: string;
  summary: string;
  route: "upstreamable" | "release-build" | "plugin-fallback";
  effect: "hide" | "reduce" | "none";
  upstreamPr: string | null;
  minCore: string | null;
  features: readonly string[];
  probe: CoreProbe;
}

export interface Feature {
  id: string;
  name: string;
  description: string;
  area: string;
  surface: string;
  status: FeatureStatus;
  where: string;
  gap: string;
  evidence: Evidence;
  showMe: ShowMe;
  edition: "both" | "private";
  /** Present when edition is both. */
  picker?: FeaturePicker;
  /** Present when edition is private. */
  privateReason?: string;
}

export function statusLabel(status: FeatureStatus): string {
  switch (status.kind) {
    case "live": return "Live";
    case "partly": return "Partly live";
    case "blocked": return `Blocked: ${status.reason}`;
  }
}
