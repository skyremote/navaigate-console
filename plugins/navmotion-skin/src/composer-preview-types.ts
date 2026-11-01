// The live-preview shapes the chat box understands on bb builds that draw Markdown
// constructs and table grids (see the core ledger entry `composer-live-preview`).
// The published plugin SDK this plugin builds against does not export them yet, so
// they are declared here, matching the core's app-contract. On a bb that does not
// know these fields the composer ignores them and the Markdown still formats as typed.

export type ComposerTableAlign = "left" | "center" | "right" | null;

export interface ComposerHiddenRange {
  from: number;
  to: number;
  className?: string;
}

export interface ComposerTablePreview {
  header: readonly string[];
  align: readonly ComposerTableAlign[];
  rows: readonly (readonly string[])[];
}

export interface ComposerEffectRange {
  from: number;
  to: number;
  hidden?: readonly ComposerHiddenRange[];
  table?: ComposerTablePreview;
}
