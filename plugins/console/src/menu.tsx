// Right-click menus for the rail, on the host's shimmed Radix context menu so
// they stack correctly against bb's own overlays. Look: a tight paper card,
// hairline separators, a 2px gold marker on the focused row, and submenus
// that branch out sideways (the branched-menu feel the owner referenced).
import type { ReactNode } from "react";
import * as CM from "@radix-ui/react-context-menu";
import * as DM from "@radix-ui/react-dropdown-menu";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import { usePortalScopeProps } from "@/lib/portal-scope";
import { cn } from "@/lib/utils";

const panel =
  "z-50 min-w-[208px] overflow-hidden rounded-lg border border-border bg-popover p-1 text-[13px] text-foreground shadow-lg " +
  "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95";

const row =
  "relative flex h-8 cursor-default select-none items-center gap-2.5 rounded-md pl-3 pr-2 outline-none " +
  "data-[highlighted]:bg-accent data-[disabled]:pointer-events-none data-[disabled]:opacity-45 " +
  "before:absolute before:inset-y-1.5 before:left-0 before:w-[2px] before:rounded-full before:bg-transparent data-[highlighted]:before:bg-foreground";

export function Menu({ trigger, children }: { trigger: ReactNode; children: ReactNode }) {
  const scope = usePortalScopeProps();
  return (
    <CM.Root modal={false}>
      <CM.Trigger asChild>{trigger}</CM.Trigger>
      <CM.Portal>
        <CM.Content {...scope} className={panel} collisionPadding={8}>
          {children}
        </CM.Content>
      </CM.Portal>
    </CM.Root>
  );
}

export function MenuItem({
  icon,
  label,
  hint,
  danger,
  disabled,
  checked,
  swatch,
  lead,
  onSelect,
}: {
  icon?: string;
  label: string;
  hint?: string;
  danger?: boolean;
  disabled?: boolean;
  checked?: boolean;
  swatch?: string;
  lead?: ReactNode;
  onSelect: () => void;
}) {
  return (
    <CM.Item className={cn(row, danger && "text-destructive-text")} disabled={disabled} onSelect={onSelect}>
      {lead ? (
        <span className="flex size-4 shrink-0 items-center justify-center">{lead}</span>
      ) : swatch ? (
        <span aria-hidden className="mx-[3px] inline-block size-2.5 shrink-0 rounded-[3px]" style={{ background: swatch }} />
      ) : icon ? (
        <Icon name={icon} className="size-4 shrink-0 text-muted-foreground" />
      ) : (
        <span className="size-4 shrink-0" />
      )}
      <span className="flex-1 truncate">{label}</span>
      {checked ? <Icon name="Check" className="size-3.5 text-muted-foreground" /> : hint ? <span className="text-[11px] text-muted-foreground">{hint}</span> : null}
    </CM.Item>
  );
}

export function MenuSub({ icon, lead, label, children, onOpen }: { icon?: string; lead?: ReactNode; label: string; children: ReactNode; onOpen?: () => void }) {
  const scope = usePortalScopeProps();
  return (
    <CM.Sub onOpenChange={(open) => (open && onOpen ? onOpen() : undefined)}>
      <CM.SubTrigger className={cn(row, "data-[state=open]:bg-accent")}>
        {lead ? (
          <span className="flex size-4 shrink-0 items-center justify-center">{lead}</span>
        ) : icon ? (
          <Icon name={icon} className="size-4 shrink-0 text-muted-foreground" />
        ) : (
          <span className="size-4 shrink-0" />
        )}
        <span className="flex-1 truncate">{label}</span>
        <Icon name="ChevronRight" className="size-3.5 text-muted-foreground" />
      </CM.SubTrigger>
      <CM.Portal>
        <CM.SubContent {...scope} className={cn(panel, "max-h-[60vh] overflow-y-auto")} sideOffset={6} collisionPadding={8}>
          {children}
        </CM.SubContent>
      </CM.Portal>
    </CM.Sub>
  );
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <CM.Label className="px-3 pb-1 pt-2 text-[12px] font-medium text-muted-foreground">{children}</CM.Label>;
}

export function MenuSeparator() {
  return <CM.Separator className="mx-2 my-1 h-px bg-border" />;
}

/* ---------------- Click-to-open dropdown (same look, same rows) ---------------- */


export function Dropdown({ trigger, children, align = "start", side = "top", onCloseAutoFocus }: {
  trigger: ReactNode;
  children: ReactNode;
  align?: "start" | "center" | "end";
  side?: "top" | "bottom" | "right";
  /** Call event.preventDefault() to keep focus where an item moved it (an inline input, say). */
  onCloseAutoFocus?: (event: Event) => void;
}) {
  const scope = usePortalScopeProps();
  return (
    <DM.Root modal={false}>
      <DM.Trigger asChild>{trigger}</DM.Trigger>
      <DM.Portal>
        <DM.Content {...scope} className={cn(panel, "max-h-[70vh] overflow-y-auto")} align={align} side={side} sideOffset={6} collisionPadding={8} onCloseAutoFocus={onCloseAutoFocus}>
          {children}
        </DM.Content>
      </DM.Portal>
    </DM.Root>
  );
}

export function DropItem({ icon, label, hint, danger, disabled, checked, onSelect, swatch, lead }: {
  lead?: ReactNode;
  icon?: string;
  label: string;
  hint?: string;
  danger?: boolean;
  disabled?: boolean;
  checked?: boolean;
  swatch?: string;
  onSelect: () => void;
}) {
  return (
    <DM.Item className={cn(row, danger && "text-destructive-text")} disabled={disabled} onSelect={onSelect}>
      {lead ? (
        <span className="flex size-4 shrink-0 items-center justify-center">{lead}</span>
      ) : swatch ? (
        <span aria-hidden className="inline-block size-2.5 shrink-0 rounded-[3px]" style={{ background: swatch }} />
      ) : icon ? (
        <Icon name={icon} className="size-4 shrink-0 text-muted-foreground" />
      ) : (
        <span className="size-4 shrink-0" />
      )}
      <span className="flex-1 truncate">{label}</span>
      {checked ? <Icon name="Check" className="size-3.5 text-muted-foreground" /> : hint ? <span className="text-[11px] text-muted-foreground">{hint}</span> : null}
    </DM.Item>
  );
}

export function DropSeparator() {
  return <DM.Separator className="mx-2 my-1 h-px bg-border" />;
}

export function DropLabel({ children }: { children: ReactNode }) {
  return <DM.Label className="px-3 pb-1 pt-2 text-[12px] font-medium text-muted-foreground">{children}</DM.Label>;
}

/** A checkbox row that stays open on select, for picking several at once. */
export function DropCheck({ label, hint, swatch, checked, onCheckedChange }: {
  label: string;
  hint?: string;
  swatch?: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <DM.CheckboxItem
      className={row}
      checked={checked}
      onCheckedChange={onCheckedChange}
      onSelect={(e) => e.preventDefault()}
    >
      <span
        aria-hidden
        className={cn(
          "flex size-4 shrink-0 items-center justify-center rounded-[4px] border",
          checked ? "border-foreground bg-foreground text-background" : "border-border",
        )}
      >
        {checked ? <Icon name="Check" className="size-3" /> : null}
      </span>
      {swatch ? <span aria-hidden className="inline-block size-2.5 shrink-0 rounded-[3px]" style={{ background: swatch }} /> : null}
      <span className="flex-1 truncate">{label}</span>
      {hint ? <span className="text-[11px] text-muted-foreground" style={{ fontVariantNumeric: "tabular-nums" }}>{hint}</span> : null}
    </DM.CheckboxItem>
  );
}

export function DropSub({ icon, swatch, label, children }: { icon?: string; swatch?: string; label: string; children: ReactNode }) {
  const scope = usePortalScopeProps();
  return (
    <DM.Sub>
      <DM.SubTrigger className={cn(row, "data-[state=open]:bg-accent")}>
        {swatch ? (
          <span aria-hidden className="mx-[3px] inline-block size-2.5 shrink-0 rounded-[3px]" style={{ background: swatch }} />
        ) : icon ? (
          <Icon name={icon} className="size-4 shrink-0 text-muted-foreground" />
        ) : (
          <span className="size-4 shrink-0" />
        )}
        <span className="flex-1 truncate">{label}</span>
        <Icon name="ChevronRight" className="size-3.5 text-muted-foreground" />
      </DM.SubTrigger>
      <DM.Portal>
        <DM.SubContent {...scope} className={cn(panel, "max-h-[60vh] overflow-y-auto")} sideOffset={6} collisionPadding={8}>
          {children}
        </DM.SubContent>
      </DM.Portal>
    </DM.Sub>
  );
}
