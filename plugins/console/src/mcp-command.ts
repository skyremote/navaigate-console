// /mcp in a chat: Claude Code's terminal opens a server list grouped by
// config file, with a status per row. Through bb the provider bridge prints a
// one-line count instead. When the sent message is only "/mcp" (typed, or
// picked from the slash menu as Claude's /mcp or the mcp-manager skill), open
// the MCP Manager page (grouped list, live status, Re-authenticate per row).
import type { PluginComposerApi } from "@get-bb/plugin-sdk/app";
import { goToHref } from "./features-guide-nav";

export const MCP_PAGE_HREF = "/plugins/mcp-manager/inventory";

type Draft = Pick<PluginComposerApi["draft"], "text" | "mentions">;

const MCP_NAMES = new Set(["mcp", "mcp-manager"]);

function isMcpName(name: string): boolean {
  const bare = name.replace(/^[/$]/, "").toLowerCase();
  return MCP_NAMES.has(bare) || MCP_NAMES.has(bare.slice(bare.lastIndexOf(":") + 1));
}

/** True only for the bare command: "/mcp" alone, any case, surrounding spaces allowed. */
export function isMcpCommand(text: string): boolean {
  return text.trim().toLowerCase() === "/mcp";
}

/** True when the draft is only an /mcp command, as typed text or as one slash-menu pill. */
export function isMcpDraft(draft: Draft): boolean {
  const mentions = draft.mentions ?? [];
  if (mentions.length === 0) return isMcpCommand(draft.text);
  if (mentions.length !== 1) return false;
  const m = mentions[0];
  if (m.kind !== "command" || !isMcpName(m.name)) return false;
  const rest = draft.text.slice(0, m.from) + draft.text.slice(m.to);
  return rest.trim() === "";
}

export function openMcpPage(): void {
  goToHref(MCP_PAGE_HREF);
}
