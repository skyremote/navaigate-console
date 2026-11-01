// Tags: the owner's own labels. One "Tags" button beside Select opens a dropdown:
// tick tags to filter the rail (chats with any of them), Clear, New tag…, and
// Manage tags to rename, recolour or delete. While a filter is on, the active
// tags show as small removable chips on the same row (right-click one for the
// same rename, recolour and delete). Rows show their tags as small swatches.
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { tnum } from "./shared";
import { DropCheck, DropItem, DropLabel, DropSeparator, DropSub, Dropdown, Menu, MenuItem, MenuSeparator, MenuSub } from "./menu";
import { TAG_COLORS, TAG_CSS, type RailOps, type Tag, type TagColor } from "./rail-state";

export function TagSwatches({ tags }: { tags: Tag[] }) {
  if (tags.length === 0) return null;
  return (
    <span className="flex shrink-0 items-center gap-1" title={tags.map((t) => t.name).join(", ")}>
      {tags.slice(0, 3).map((t) => (
        <span key={t.id} aria-hidden className="inline-block size-2 rounded-[2px]" style={{ background: TAG_CSS[t.color] }} />
      ))}
      {tags.length > 3 ? <span className="text-[11px] text-muted-foreground">+{tags.length - 3}</span> : null}
    </span>
  );
}

export function TagInput({ onSubmit, onCancel, placeholder = "New tag", initialColor = "gold" }: { onSubmit: (name: string, color: TagColor) => void; onCancel: () => void; placeholder?: string; initialColor?: TagColor }) {
  const ref = useRef<HTMLInputElement>(null);
  const [color, setColor] = useState<TagColor>(initialColor);
  useEffect(() => ref.current?.focus(), []);
  return (
    <div className="flex h-7 items-center gap-1.5 rounded-full border border-ring bg-background pl-2 pr-1">
      <button
        type="button"
        aria-label="Change colour"
        title="Change colour"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setColor((c) => TAG_COLORS[(TAG_COLORS.indexOf(c) + 1) % TAG_COLORS.length])}
        className="size-3 shrink-0 rounded-[3px]"
        style={{ background: TAG_CSS[color] }}
      />
      <input
        ref={ref}
        placeholder={placeholder}
        maxLength={32}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            const v = e.currentTarget.value.trim();
            if (v) onSubmit(v, color);
            else onCancel();
          } else if (e.key === "Escape") onCancel();
        }}
        onBlur={onCancel}
        className="h-6 w-24 bg-transparent text-[12px] text-foreground outline-none placeholder:text-muted-foreground"
      />
    </div>
  );
}

/** bb's icon set has no tag, so a small one drawn to match its 1.5 stroke. */
function TagGlyph() {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 12.2V4.5A1.5 1.5 0 0 1 4.5 3h7.7a1.5 1.5 0 0 1 1.06.44l7.3 7.3a1.5 1.5 0 0 1 0 2.12l-7.7 7.7a1.5 1.5 0 0 1-2.12 0l-7.3-7.3A1.5 1.5 0 0 1 3 12.2Z" />
      <circle cx="8" cy="8" r="1.4" />
    </svg>
  );
}

/** The tag filter's inline input: a new tag, or renaming one. Shown under the row. */
export type TagEdit = { kind: "new" } | { kind: "rename"; id: string } | null;

const capital = (c: string) => c.charAt(0).toUpperCase() + c.slice(1);

/** The compact "Tags" control: one button that opens the tag dropdown. */
export function TagFilter({
  ops,
  counts,
  value,
  onChange,
  setEdit,
}: {
  ops: RailOps;
  counts: Map<string, number>;
  value: string[];
  onChange: (tagIds: string[]) => void;
  setEdit: (e: TagEdit) => void;
}) {
  const tags = ops.state.tags;
  const active = tags.filter((t) => value.includes(t.id));
  // An item that opens the inline input keeps focus there instead of on the button.
  const keepFocus = useRef(false);
  const toggle = (id: string, on: boolean) => onChange(on ? [...value.filter((v) => v !== id), id] : value.filter((v) => v !== id));
  const startEdit = (e: TagEdit) => {
    keepFocus.current = true;
    setEdit(e);
  };
  const remove = (t: Tag) => {
    if (value.includes(t.id)) onChange(value.filter((v) => v !== t.id));
    void ops.deleteTag(t.id);
  };
  return (
    <Dropdown
        side="bottom"
        onCloseAutoFocus={(e) => {
          if (keepFocus.current) {
            e.preventDefault();
            keepFocus.current = false;
          }
        }}
        trigger={
          <button
            type="button"
            aria-label={active.length ? `Tags, ${active.length} active` : "Tags"}
            className={cn(
              "inline-flex h-7 shrink-0 items-center gap-1 rounded-full border px-2.5 text-[12px] transition-colors data-[state=open]:bg-accent",
              active.length ? "border-foreground text-foreground" : "border-border text-muted-foreground hover:text-foreground",
            )}
          >
            <TagGlyph />
            Tags
            {active.length ? <span className="text-foreground" style={tnum}>· {active.length}</span> : null}
            <Icon name="ChevronDown" className="size-3 text-muted-foreground" />
          </button>
        }
      >
        <DropLabel>Show chats with any of</DropLabel>
        {tags.length === 0 ? <DropItem label="No tags yet" disabled onSelect={() => undefined} /> : null}
        {tags.map((t) => (
          <DropCheck
            key={t.id}
            swatch={TAG_CSS[t.color]}
            label={t.name}
            hint={String(counts.get(t.id) ?? 0)}
            checked={value.includes(t.id)}
            onCheckedChange={(on) => toggle(t.id, on)}
          />
        ))}
        <DropSeparator />
        <DropItem icon="X" label="Clear" disabled={active.length === 0} onSelect={() => onChange([])} />
        <DropItem icon="Plus" label="New tag…" onSelect={() => startEdit({ kind: "new" })} />
        {tags.length > 0 ? (
          <DropSub icon="Settings" label="Manage tags">
            {tags.map((t) => (
              <DropSub key={t.id} swatch={TAG_CSS[t.color]} label={t.name}>
                <DropItem icon="Edit" label="Rename" onSelect={() => startEdit({ kind: "rename", id: t.id })} />
                <DropSub icon="Settings" label="Colour">
                  {TAG_COLORS.map((c) => (
                    <DropItem key={c} swatch={TAG_CSS[c]} label={capital(c)} checked={t.color === c} onSelect={() => void ops.updateTag(t.id, { color: c })} />
                  ))}
                </DropSub>
                <DropSeparator />
                <DropItem icon="Trash2" label="Delete tag" hint="chats stay" danger onSelect={() => remove(t)} />
              </DropSub>
            ))}
          </DropSub>
        ) : null}
    </Dropdown>
  );
}

/** While a tag filter is on: the active tags as small removable chips, one row, then "+N". */
export function TagChips({ ops, value, onChange, setEdit }: { ops: RailOps; value: string[]; onChange: (tagIds: string[]) => void; setEdit: (e: TagEdit) => void }) {
  const active = ops.state.tags.filter((t) => value.includes(t.id));
  if (active.length === 0) return null;
  const SHOWN = 3;
  const drop = (id: string) => onChange(value.filter((v) => v !== id));
  return (
    <div className="mx-1 -mt-1.5 mb-3 flex min-w-0 flex-nowrap items-center gap-1 overflow-hidden" role="group" aria-label="Active tag filters">
      {active.slice(0, SHOWN).map((t) => (
        <TagMenu
          key={t.id}
          tag={t}
          ops={ops}
          onRename={() => setEdit({ kind: "rename", id: t.id })}
          onDelete={() => {
            drop(t.id);
            void ops.deleteTag(t.id);
          }}
        >
          <span className="inline-flex h-6 min-w-[3.75rem] max-w-[92px] shrink items-center gap-1 rounded-full border border-border pl-2 pr-0.5 text-[12px] text-foreground">
            <span aria-hidden className="inline-block size-2 shrink-0 rounded-[2px]" style={{ background: TAG_CSS[t.color] }} />
            <span className="min-w-0 truncate">{t.name}</span>
            <button
              type="button"
              aria-label={`Remove the ${t.name} filter`}
              title="Remove this filter"
              onClick={() => drop(t.id)}
              className="inline-flex size-5 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <Icon name="X" className="size-3" />
            </button>
          </span>
        </TagMenu>
      ))}
      {active.length > SHOWN ? (
        <span className="shrink-0 text-[12px] text-muted-foreground" style={tnum} title={active.slice(SHOWN).map((t) => t.name).join(", ")}>
          +{active.length - SHOWN}
        </span>
      ) : null}
    </div>
  );
}

/** Right-click menu on an active tag chip: the same rename, recolour and delete as Manage tags. */
function TagMenu({ tag, ops, onRename, onDelete, children }: { tag: Tag; ops: RailOps; onRename: () => void; onDelete: () => void; children: ReactNode }) {
  return (
    <Menu trigger={children}>
      <MenuItem icon="Edit" label="Rename" onSelect={onRename} />
      <MenuSub icon="Settings" label="Colour">
        {TAG_COLORS.map((c) => (
          <MenuItem key={c} swatch={TAG_CSS[c]} label={capital(c)} checked={tag.color === c} onSelect={() => void ops.updateTag(tag.id, { color: c })} />
        ))}
      </MenuSub>
      <MenuSeparator />
      <MenuItem icon="Trash2" label="Delete tag" hint="chats stay" danger onSelect={onDelete} />
    </Menu>
  );
}

/** The inline input under the filter row, for New tag… and Rename. */
export function TagEditor({ ops, edit, setEdit, onCreated }: { ops: RailOps; edit: TagEdit; setEdit: (e: TagEdit) => void; onCreated?: (tag: Tag) => void }) {
  if (!edit) return null;
  const renaming = edit.kind === "rename" ? ops.state.tags.find((t) => t.id === edit.id) : undefined;
  if (edit.kind === "rename" && !renaming) return null;
  return (
    <div className="mx-1 mb-2 flex">
      <TagInput
        key={renaming?.id ?? "new"}
        placeholder={renaming?.name ?? "New tag"}
        initialColor={renaming?.color}
        onCancel={() => setEdit(null)}
        onSubmit={(name, color) => {
          setEdit(null);
          if (renaming) {
            void ops.updateTag(renaming.id, { name, color });
            return;
          }
          ops.createTag(name, color).then(
            (tag) => onCreated?.(tag),
            (e) => toast.error("Could not create tag", { description: e instanceof Error ? e.message : String(e) }),
          );
        }}
      />
    </div>
  );
}
