// Where the owner is (home: NAS direct; away: NAS through the always-on Mac) and which bb project to
// start a new chat in: the chip under the greeting on the new-thread screen.
import { useFeature } from "./use-feature";
import { useEffect, useState } from "react";
import { experimental_useSidebarThreads as useSidebarThreads, useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import { cn } from "@/lib/utils";
import type { rpcContract } from "../server";
import { consoleSection } from "../lib/profile-console";
import { useProfile } from "./use-profile";
import { mac, macLabel } from "./words";

type Where = { mode: "home" | "away"; m1: boolean };

export function useWhere() {
  const rpc = useRpc<typeof rpcContract>();
  const [where, setWhere] = useState<Where | null>(null);
  useEffect(() => {
    let live = true;
    const load = () => rpc.call("nas_where").then((w) => live && setWhere(w), () => undefined);
    load();
    const t = window.setInterval(load, 120_000);
    return () => {
      live = false;
      window.clearInterval(t);
    };
  }, [rpc]);
  return where;
}

/** The bb project to start NAS work in, by where the owner is (the project names come from the profile). */
export function useNasProjects() {
  const { projects } = useSidebarThreads();
  const sec = consoleSection(useProfile());
  const find = (name: string | null) => (name ? projects.find((p) => p.name === name)?.id ?? null : null);
  return { home: find(sec.nasProject), away: find(sec.nasAwayProject) };
}

export function WhereBadge({ where }: { where: Where | null }) {
  useProfile();
  if (!where) return <span className="text-[12px] text-muted-foreground">Checking where you are…</span>;
  const away = where.mode === "away";
  return (
    <span className="inline-flex items-center gap-1.5 text-[12px] text-muted-foreground">
      <span className="size-1.5 rounded-full" style={{ background: away ? "var(--warning)" : "var(--success)" }} />
      {away ? (where.m1 ? `Away · NAS through ${mac()}` : `Away · ${macLabel()} not reachable`) : "Home · NAS direct"}
    </span>
  );
}

/** Under the greeting: where you are, and the project to start in (highlighted). */
export function WhereChip() {
  const chipOn = useFeature("EXTRA-V");
  const where = useWhere();
  const projects = useNasProjects();
  const sec = consoleSection(useProfile());
  const nav = useBbNavigate();
  if (!chipOn || !where || (!projects.home && !projects.away)) return null;
  const away = where.mode === "away";
  const pill = (label: string, id: string | null, recommended: boolean) =>
    id ? (
      <button
        type="button"
        onClick={() => nav.toProject(id)}
        className={cn("rounded-full border px-3 py-1 text-[12px]", recommended ? "font-medium text-foreground" : "border-border text-muted-foreground hover:text-foreground")}
        style={recommended ? { borderColor: "var(--foreground)" } : undefined}
        title={recommended ? "Recommended for where you are" : undefined}
      >
        {label}
      </button>
    ) : null;
  return (
    <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
      <WhereBadge where={where} />
      {pill(sec.nasProject ?? "", projects.home, !away)}
      {pill(sec.nasAwayProject ?? "", projects.away, away)}
    </div>
  );
}
