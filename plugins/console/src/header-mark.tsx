// The NavAIgate orb and name in bb's sidebar header row. Click: Home.
import { useBbNavigate, type ExperimentalSidebarHeaderProps } from "@get-bb/plugin-sdk/app";
import { LogoOrb } from "./orb";

export function HeaderMark({ width }: ExperimentalSidebarHeaderProps) {
  const nav = useBbNavigate();
  return (
    <button
      type="button"
      onClick={() => nav.toPluginPanel("home")}
      data-nav-part="header-mark"
      className="flex h-full min-w-0 items-center gap-2 overflow-hidden rounded-md px-1 text-left hover:bg-muted/40"
      style={{ maxWidth: width }}
      title="NavAIgate Home"
    >
      <LogoOrb size={20} />
      {width > 110 ? <span className="truncate text-[13px] font-medium tracking-tight text-foreground">NavAIgate</span> : null}
    </button>
  );
}
