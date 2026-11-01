// Start a real bb chat from a Home card: same project lookup and navigation as the Ask box.
import { useMemo, useState } from "react";
import { experimental_useSidebarThreads as useSidebarThreads, useBbNavigate, useSdk } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { useWhere } from "./nas";
import { useProfile } from "./use-profile";
import { consoleSection } from "../lib/profile-console";

export const PROVIDER_ID = { claude: "claude-code", codex: "codex", cursor: "acp-cursor" } as const;

/**
 * Every chat the plugin starts runs in Full access, never Auto (the owner's rule, 7 Oct 2026).
 * The fields we choose are marked "explicit" so the server keeps them instead of
 * re-deriving them from the project's remembered defaults.
 */
export function fullAccess<T extends Record<string, unknown>>(args: T) {
  const sources: Record<string, "explicit"> = { permissionMode: "explicit" };
  for (const k of ["providerId", "model", "reasoningLevel", "serviceTier"]) if (args[k] !== undefined) sources[k] = "explicit";
  return { ...args, permissionMode: "full" as const, executionInputSources: sources };
}

/**
 * The project new work starts in. At home: the project on the NAS. Away, or until we know:
 * the project in the local NAS mirror, because starting a chat on the NAS over Tailscale hangs.
 * Both names come from the profile.
 */
export function useWorkProject() {
  const { projects } = useSidebarThreads();
  const where = useWhere();
  const profile = useProfile();
  return useMemo(() => {
    const sec = consoleSection(profile);
    const named = (n: string | null) => (n ? projects.find((p) => p.name === n) : undefined);
    const fallback = (sec.nasProject ? projects.find((p) => p.name.toLowerCase().includes(sec.nasProject!.toLowerCase())) : undefined) ?? projects[0];
    const home = named(sec.nasProject);
    const away = named(sec.nasAwayProject);
    return where?.mode === "home" ? home ?? away ?? fallback : away ?? home ?? fallback;
  }, [projects, where, profile]);
}

export function useSpawn() {
  const sdk = useSdk();
  const nav = useBbNavigate();
  const project = useWorkProject();
  const [busy, setBusy] = useState<string | null>(null);

  const spawn = async (key: string, title: string, prompt: string, providerId: string = PROVIDER_ID.claude) => {
    if (!project || busy) return false;
    setBusy(key);
    try {
      const made = await sdk.threads.spawn(
        fullAccess({
          projectId: project.id,
          environment: { type: "project-default" },
          providerId,
          title: title.slice(0, 80),
          visibility: "visible",
          prompt,
        }) as Parameters<typeof sdk.threads.spawn>[0],
      );
      nav.toThread((made as { id: string }).id);
      return true;
    } catch (e) {
      toast.error("Could not start the chat", { description: e instanceof Error ? e.message : String(e) });
      return false;
    } finally {
      setBusy(null);
    }
  };
  return { spawn, busy, ready: !!project, projectName: project?.name ?? null };
}
