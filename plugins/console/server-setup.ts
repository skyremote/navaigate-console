// What the first-run setup screen needs from the server: the preset the installer
// chose (`bb plugin config navaigate-skin set preset simple|pro`) and what the
// running bb can do (the core-change probes behind the feature picker).
import { z } from "zod";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { ledgerIdsPassed } from "./src/features-enabled";
import { setServerProbes } from "./server-features";

export const setupHintSchema = z.object({ preset: z.enum(["simple", "pro"]).nullable() });
export const coreProbesSchema = z.object({
  /** Set when the running bb carries the release-build marker (the update-drain SDK call). */
  releaseBuild: z.boolean(),
  /** Set when the worktree provider advertises protected cleanup version 1. */
  cleanupSafety: z.boolean(),
});
export type CoreProbesResult = z.infer<typeof coreProbesSchema>;

const PROBE_TTL_MS = 60_000;

export function createSetup(bb: BbPluginApi) {
  const settings = bb.settings.define({
    preset: {
      type: "string",
      label: "Feature preset for first-run setup",
      description: "Leave blank, or write simple or pro. The setup screen starts with that choice ticked. Setting it never changes anything on its own.",
      default: "",
    },
  });
  let cached: { until: number; value: CoreProbesResult } | null = null;

  async function probes(): Promise<CoreProbesResult> {
    if (cached && cached.until > Date.now()) return cached.value;
    const system = (bb.sdk as unknown as { system?: Record<string, unknown> }).system;
    const releaseBuild = typeof system?.experimental_acquireUpdateDrain === "function";
    let cleanupSafety = false;
    try {
      const safety = await bb.sdk.plugins.callRpc({
        pluginId: "environment-git-worktree",
        method: "experimental_cleanupSafety",
        input: {},
        outputSchema: z.object({ version: z.literal(1) }).passthrough(),
      });
      cleanupSafety = safety.version === 1;
    } catch {
      cleanupSafety = false;
    }
    const value = { releaseBuild, cleanupSafety };
    setServerProbes(ledgerIdsPassed({ ...value, nativeHistory: releaseBuild, continuationIntent: releaseBuild }));
    cached = { until: Date.now() + PROBE_TTL_MS, value };
    return value;
  }

  void probes();
  return {
    hint: async (): Promise<z.infer<typeof setupHintSchema>> => {
      const raw = String((await settings.get()).preset ?? "").trim().toLowerCase();
      return { preset: raw === "simple" || raw === "pro" ? raw : null };
    },
    probes,
  };
}
