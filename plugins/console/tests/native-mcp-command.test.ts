import { describe, expect, it } from "vitest";
import { isMcpCommand, isMcpDraft, MCP_PAGE_HREF } from "../src/mcp-command";

const pill = (name: string, text: string, from = 0, to = text.length) => ({
  text,
  mentions: [{ kind: "command" as const, trigger: "/" as const, name, source: "skill" as const, origin: "user" as const, argumentHint: null, label: name, from, to }],
});

describe("isMcpCommand", () => {
  it("matches the bare command", () => {
    expect(isMcpCommand("/mcp")).toBe(true);
    expect(isMcpCommand("  /MCP \n")).toBe(true);
  });
  it("ignores anything else", () => {
    expect(isMcpCommand("/mcp foo")).toBe(false);
    expect(isMcpCommand("check /mcp please")).toBe(false);
    expect(isMcpCommand("/mcp-manager")).toBe(false);
    expect(isMcpCommand("")).toBe(false);
  });
});

describe("isMcpDraft", () => {
  it("matches typed /mcp", () => {
    expect(isMcpDraft({ text: "/mcp", mentions: [] })).toBe(true);
  });
  it("matches a slash-menu pill for /mcp or the mcp-manager skill", () => {
    expect(isMcpDraft(pill("mcp", "/mcp"))).toBe(true);
    expect(isMcpDraft(pill("mcp-manager", "mcp-manager "))).toBe(true);
    expect(isMcpDraft(pill("bb-global-skills:mcp-manager", "/bb-global-skills:mcp-manager"))).toBe(true);
  });
  it("ignores a pill with a message after it, or another command", () => {
    expect(isMcpDraft(pill("mcp-manager", "mcp-manager list Codex", 0, 11))).toBe(false);
    expect(isMcpDraft(pill("deep-research", "/deep-research"))).toBe(false);
    expect(isMcpDraft({ text: "hello", mentions: [] })).toBe(false);
  });
  it("points at the MCP Manager page", () => {
    expect(MCP_PAGE_HREF).toBe("/plugins/mcp-manager/inventory");
  });
});

describe("the /mcp feature switch", () => {
  it("is off for the community edition until ticked, and on in the private edition", async () => {
    const { MCP_FEATURE } = await import("../src/composer-bridge");
    const { isFeatureEnabled } = await import("../src/features-enabled");
    const { fixtureProfile } = await import("./setup-profile");
    const base = fixtureProfile();
    expect(isFeatureEnabled({ ...base, edition: "community", features: { preset: "custom", picks: {} } }, MCP_FEATURE)).toBe(false);
    expect(isFeatureEnabled({ ...base, edition: "community", features: { preset: "custom", picks: { [MCP_FEATURE]: true } } }, MCP_FEATURE)).toBe(true);
    expect(isFeatureEnabled({ ...base, edition: "private" }, MCP_FEATURE)).toBe(true);
  });
});
