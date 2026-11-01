// Logos for projects and folders in the rail.
// A project's own icon comes from bb (an image found in the project, or a
// generated monogram) and is read from experimental_icon on the sidebar's
// project. A look chosen in project-folders (an emoji or a symbol, keyed
// p:<project> and f:<folder>) wins over it and is the only icon a plain folder
// has. The chooser writes to whichever store the choice belongs to.
import { useEffect, useState, type ReactNode } from "react";
import { experimental_Icon as Icon, useSdk } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { ItemStyles } from "./folders";
import { field } from "./controls";
import { ensureRailLook } from "./rail-look";

export type CoreIcon = { imageUrl: string | null; monogram: string; hue: number };
type CoreProjectIcon = { kind: "file"; path: string } | { kind: "monogram"; text: string; color: string };

/** The icon bb drew for a project; hosts older than the icon feature send none. */
export function coreIconOf(project: object | undefined): CoreIcon | undefined {
  return (project as { experimental_icon?: CoreIcon } | undefined)?.experimental_icon;
}

const SWATCHES = [
  ["red", 25], ["orange", 50], ["amber", 75], ["green", 150], ["teal", 185], ["sky", 235],
  ["blue", 260], ["indigo", 275], ["violet", 295], ["purple", 310], ["pink", 350], ["rose", 10],
] as const;

export const EMOJIS = ["📁", "🚀", "💼", "🧾", "📈", "🎬", "🎓", "🛠️", "🧪", "📚", "🎨", "🏠", "✈️", "💡", "🔒", "🧠", "🤖", "📣", "🗂️", "⭐"];
export const SYMBOLS = ["Folder", "Briefcase", "Rocket", "Receipt", "BarChart3", "Film", "GraduationCap", "Wrench", "FlaskConical", "BookOpen", "Palette", "Home", "Plane", "Lightbulb", "Lock", "Brain", "Bot", "Megaphone", "Star", "Globe"];

const monogramStyle = (hue: number) => ({
  color: `oklch(var(--nav-mono-l, 0.45) 0.14 ${hue})`,
  backgroundColor: `color-mix(in oklab, oklch(0.62 0.14 ${hue}) 18%, transparent)`,
});

function Monogram({ icon, size }: { icon: CoreIcon; size: number }) {
  return (
    <span
      aria-hidden
      data-project-icon="monogram"
      className="inline-flex shrink-0 items-center justify-center rounded-[4px] text-[11px] font-medium leading-none"
      style={{ width: size, height: size, ...monogramStyle(icon.hue) }}
    >
      {icon.monogram}
    </span>
  );
}

/** A project's bb icon: its image, or the monogram when there is none or it fails to load. */
export function ProjectGlyph({ icon, size = 16 }: { icon: CoreIcon; size?: number }) {
  const [failed, setFailed] = useState<string | null>(null);
  if (icon.imageUrl === null || failed === icon.imageUrl) return <Monogram icon={icon} size={size} />;
  return (
    <img
      alt=""
      aria-hidden
      data-project-icon="image"
      src={icon.imageUrl}
      loading="lazy"
      draggable={false}
      className="shrink-0 rounded-[4px] object-contain"
      style={{ width: size, height: size }}
      onError={() => setFailed(icon.imageUrl)}
    />
  );
}

/** A look chosen in project-folders: "emoji:🚀" or "icon:Rocket". */
export function StyleGlyph({ value, size = 16 }: { value: string; size?: number }) {
  if (value.startsWith("emoji:"))
    return (
      <span aria-hidden data-project-icon="emoji" className="inline-flex shrink-0 items-center justify-center leading-none" style={{ width: size, height: size, fontSize: size - 3 }}>
        {value.slice(6)}
      </span>
    );
  return <Icon name={value.slice(5)} aria-hidden data-project-icon="symbol" className="shrink-0" style={{ width: size, height: size }} />;
}

/** What to draw in front of a heading or folder: the chosen look first, then bb's own icon, else nothing. */
export function HeadingGlyph({ chosen, core, size }: { chosen?: string; core?: CoreIcon; size?: number }): ReactNode {
  if (chosen) return <StyleGlyph value={chosen} size={size} />;
  if (core) return <ProjectGlyph icon={core} size={size} />;
  return null;
}

export type IconTarget = { kind: "project"; id: string; name: string } | { kind: "folder"; id: string; name: string };

export type IconStore = {
  styles: ItemStyles;
  setIcon(kind: "project" | "folder", id: string, icon: string | null): Promise<void>;
};

type ProjectsSdk = {
  projects: {
    get(args: { projectId: string }): Promise<{ icon?: CoreProjectIcon | null }>;
    iconCandidates(args: { projectId: string }): Promise<{ candidates: string[] }>;
    update(args: { projectId: string; icon: CoreProjectIcon | null }): Promise<unknown>;
  };
};

const candidateUrl = (projectId: string, path: string) =>
  `/api/v1/projects/${encodeURIComponent(projectId)}/files/${path.split("/").map(encodeURIComponent).join("/")}`;

const cell = "inline-flex size-8 items-center justify-center rounded-md border border-transparent text-base hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring aria-pressed:border-ring aria-pressed:bg-accent";
const row = "flex min-h-9 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50";

export function IconDialog({ target, store, onClose }: { target: IconTarget | null; store: IconStore; onClose: () => void }) {
  ensureRailLook();
  return (
    <Dialog open={target !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent>{target ? <IconDialogBody key={`${target.kind}:${target.id}`} target={target} store={store} onClose={onClose} /> : null}</DialogContent>
    </Dialog>
  );
}

function IconDialogBody({ target, store, onClose }: { target: IconTarget; store: IconStore; onClose: () => void }) {
  const sdk = useSdk() as unknown as ProjectsSdk;
  const isProject = target.kind === "project";
  const chosen = store.styles[`${isProject ? "p" : "f"}:${target.id}`]?.icon;
  const [state, setState] = useState<{ status: "loading" | "ready" | "error"; icon: CoreProjectIcon | null; candidates: string[] }>({ status: isProject ? "loading" : "ready", icon: null, candidates: [] });
  const [pending, setPending] = useState(false);
  const [text, setText] = useState("");
  const [color, setColor] = useState<(typeof SWATCHES)[number][0]>("blue");
  const [custom, setCustom] = useState("");

  useEffect(() => {
    if (!isProject) return;
    let live = true;
    void Promise.all([sdk.projects.get({ projectId: target.id }), sdk.projects.iconCandidates({ projectId: target.id })]).then(
      ([project, found]) => {
        if (!live) return;
        setState({ status: "ready", icon: project.icon ?? null, candidates: found.candidates });
        const saved = project.icon;
        if (saved?.kind === "monogram") {
          setText(saved.text);
          setColor(SWATCHES.find(([c]) => c === saved.color)?.[0] ?? "blue");
        }
      },
      () => live && setState({ status: "error", icon: null, candidates: [] }),
    );
    return () => {
      live = false;
    };
  }, [isProject, sdk, target.id]);

  const run = async (job: () => Promise<unknown>, failure: string) => {
    setPending(true);
    try {
      await job();
      onClose();
    } catch (e) {
      toast.error(failure, { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setPending(false);
    }
  };
  const saveCore = (icon: CoreProjectIcon | null) =>
    run(async () => {
      await sdk.projects.update({ projectId: target.id, icon });
      if (chosen) await store.setIcon("project", target.id, null);
    }, "Could not change the project icon");
  const saveChosen = (icon: string | null) => run(() => store.setIcon(target.kind, target.id, icon), "Could not save the icon");
  const monogram = text.trim();
  const hue = SWATCHES.find(([c]) => c === color)?.[1] ?? 260;

  return (
    <>
      <DialogHeader>
        <DialogTitle>{isProject ? "Project icon" : "Folder icon"}</DialogTitle>
        <DialogDescription>
          {isProject
            ? `Choose how ${target.name} shows in the sidebar: an icon file found in the project, a generated one, or an emoji.`
            : `Choose an emoji or symbol for ${target.name}.`}
        </DialogDescription>
      </DialogHeader>
      <div className="max-h-[60dvh] space-y-4 overflow-y-auto" data-nav-part="icon-dialog">
        <button type="button" className={row} disabled={pending} aria-pressed={isProject ? state.status === "ready" && state.icon === null && !chosen : !chosen} onClick={() => (isProject ? void saveCore(null) : void saveChosen(null))}>
          {isProject ? "Automatic (found in the project, else generated)" : "No icon"}
        </button>
        {isProject ? (
          <>
            <div className="space-y-1">
              <p className="text-sm font-medium">Icon files in the project</p>
              {state.status === "loading" ? <p className="text-sm text-muted-foreground">Looking for icons…</p> : null}
              {state.status === "error" ? <p className="text-sm text-destructive-text">Could not read the project folder.</p> : null}
              {state.status === "ready" && state.candidates.length === 0 ? <p className="text-sm text-muted-foreground">No icon files found.</p> : null}
              {state.candidates.map((path) => (
                <button key={path} type="button" className={row} disabled={pending} aria-pressed={!chosen && state.icon?.kind === "file" && state.icon.path === path} onClick={() => void saveCore({ kind: "file", path })}>
                  <img alt="" src={candidateUrl(target.id, path)} className="size-6 shrink-0 rounded-[4px] object-contain" />
                  <span className="min-w-0 truncate">{path}</span>
                </button>
              ))}
            </div>
            <form
              className="space-y-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (monogram) void saveCore({ kind: "monogram", text: monogram, color });
              }}
            >
              <p className="text-sm font-medium">Generated icon</p>
              <div className="flex items-center gap-2">
                <Monogram icon={{ imageUrl: null, monogram: monogram || "?", hue }} size={24} />
                <input
                  aria-label="Monogram"
                  value={text}
                  maxLength={2}
                  autoCapitalize="characters"
                  spellCheck={false}
                  disabled={pending}
                  className={`${field} h-8 w-16`}
                  onChange={(e) => setText(e.target.value)}
                />
                <button type="submit" disabled={pending || !monogram} className="h-8 rounded-md border border-input px-3 text-sm hover:bg-accent disabled:opacity-50">
                  Use generated icon
                </button>
              </div>
              <div className="flex flex-wrap gap-1.5" role="group" aria-label="Colour">
                {SWATCHES.map(([name, h]) => (
                  <button key={name} type="button" aria-label={name} aria-pressed={name === color} disabled={pending} className={cn("size-5 rounded-full outline-none ring-offset-2 ring-offset-background focus-visible:ring-2 focus-visible:ring-ring", name === color && "ring-2 ring-ring")} style={{ backgroundColor: `oklch(0.62 0.14 ${h})` }} onClick={() => setColor(name)} />
                ))}
              </div>
            </form>
          </>
        ) : null}
        <div className="space-y-1">
          <p className="text-sm font-medium">Emoji</p>
          <div className="flex flex-wrap gap-1" role="group" aria-label="Emoji">
            {EMOJIS.map((e) => (
              <button key={e} type="button" className={cell} aria-label={e} aria-pressed={chosen === `emoji:${e}`} disabled={pending} onClick={() => void saveChosen(`emoji:${e}`)}>
                {e}
              </button>
            ))}
          </div>
          <form
            className="flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const v = custom.trim();
              if (v) void saveChosen(`emoji:${v}`);
            }}
          >
            <input aria-label="Any emoji" value={custom} maxLength={16} disabled={pending} placeholder="Any emoji" className={`${field} h-8 w-28`} onChange={(e) => setCustom(e.target.value)} />
            <button type="submit" disabled={pending || !custom.trim()} className="h-8 rounded-md border border-input px-3 text-sm hover:bg-accent disabled:opacity-50">
              Use emoji
            </button>
          </form>
        </div>
        <div className="space-y-1">
          <p className="text-sm font-medium">Symbol</p>
          <div className="flex flex-wrap gap-1" role="group" aria-label="Symbol">
            {SYMBOLS.map((name) => (
              <button key={name} type="button" className={cell} aria-label={name} aria-pressed={chosen === `icon:${name}`} disabled={pending} onClick={() => void saveChosen(`icon:${name}`)}>
                <Icon name={name} className="size-4" />
              </button>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
