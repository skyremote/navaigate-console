// Companions check for Set up: the other plugins the workspace leans on, each
// shown as installed, turned off or missing, with the line that installs it and
// a Copy button. Projects & Sections and Agent Board are made by other people
// (MIT) and install from their own repositories; Tasks ships with bb but is
// opt-in. Nothing here installs anything by itself.
import { useCallback, useEffect, useState } from "react";
import { useSdk } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { PROJECT_FOLDERS_INSTALL } from "./folders";

/** One command that installs and configures the whole set. */
export const INSTALL_ALL = "curl -fsSL https://raw.githubusercontent.com/skyremote/navaigate-console/main/install.sh | bash";

const COMPANIONS = [
  { id: "project-folders", label: "Projects & Sections", by: "VKirill, MIT", powers: "Folders in the rail and Move to folder.", install: PROJECT_FOLDERS_INSTALL },
  { id: "agent-board", label: "Agent Board", by: "aaronphifer, MIT", powers: "A live board of the agents working in a chat.", install: "bb plugin install git:https://github.com/aaronphifer/bb-plugin-agent-board.git@semver:^0.6.1" },
  { id: "kanban", label: "Kanban", by: "NavAIgate", powers: "Every chat as a card on a board.", install: "bb plugin install git:https://github.com/skyremote/navaigate-console.git@main --plugin kanban" },
  { id: "tasks", label: "Tasks", by: "built into bb", powers: "To-do and the Board.", install: "bb plugin install tasks" },
] as const;

type State = "installed" | "off" | "missing";

function copy(text: string) {
  void navigator.clipboard.writeText(text).then(
    () => toast.success("Copied. Paste it into a terminal or a bb chat, then reload bb."),
    () => toast.message(text),
  );
}

export function CompanionsCheck() {
  const sdk = useSdk();
  const [states, setStates] = useState<Record<string, State> | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await sdk.plugins.list();
      const byId = new Map(res.plugins.map((p) => [p.id, p]));
      const next: Record<string, State> = {};
      for (const c of COMPANIONS) {
        const p = byId.get(c.id);
        next[c.id] = !p ? "missing" : p.enabled ? "installed" : "off";
      }
      setStates(next);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [sdk]);

  useEffect(() => {
    void load();
  }, [load]);

  const missing = states ? COMPANIONS.filter((c) => states[c.id] !== "installed").length : 0;

  return (
    <div className="flex flex-col gap-2 border-t border-border pt-3">
      <div className="flex items-center gap-2">
        <span className="text-[13px] font-medium text-foreground">Companions</span>
        {states ? (
          <span className="text-[12px] text-muted-foreground">{missing === 0 ? "all installed" : `${missing} to install`}</span>
        ) : null}
        <button type="button" className="ml-auto text-[12px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline" onClick={() => void load()}>
          Check again
        </button>
      </div>
      {failed ? <p className="text-[12px] text-muted-foreground">Couldn't read the installed plugins from bb. The install lines below still work.</p> : null}
      {COMPANIONS.map((c) => {
        const s = states?.[c.id];
        const line = s === "off" ? `bb plugin enable ${c.id}` : c.install;
        return (
          <div key={c.id} className="flex flex-col gap-1">
            <div className="flex items-center gap-2 text-[12.5px]">
              <span className="font-medium text-foreground">{c.label}</span>
              <span className="text-muted-foreground">({c.by})</span>
              <span
                className="ml-auto rounded-full border border-border px-2 py-0.5 text-[11px]"
                style={{ color: s === "installed" ? "var(--success)" : undefined }}
              >
                {s === "installed" ? "Installed" : s === "off" ? "Turned off" : s === "missing" ? "Missing" : "Checking"}
              </span>
            </div>
            <div className="text-[12px] text-muted-foreground">{c.powers}</div>
            {s && s !== "installed" ? (
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded-md border border-border bg-muted/40 px-2 py-1 text-[11.5px]" title={line}>{line}</code>
                <button type="button" className="rounded-md border border-border px-2 py-1 text-[12px] hover:bg-accent" onClick={() => copy(line)}>
                  Copy
                </button>
              </div>
            ) : null}
          </div>
        );
      })}
      {missing > 0 ? (
        <div className="flex flex-col gap-1 pt-1">
          <div className="text-[12px] text-muted-foreground">Or install and set up everything at once, in a terminal:</div>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-md border border-border bg-muted/40 px-2 py-1 text-[11.5px]" title={INSTALL_ALL}>{INSTALL_ALL}</code>
            <button type="button" className="rounded-md border border-border px-2 py-1 text-[12px] hover:bg-accent" onClick={() => copy(INSTALL_ALL)}>
              Copy
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
