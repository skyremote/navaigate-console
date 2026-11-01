import { describe, expect, it } from "vitest";
import {
  MAX_WAIT_MS,
  buildColumns,
  composeMessage,
  decidePublish,
  machineKeyForHost,
  parseDuration,
  parseRelayArgs,
  selectThreads,
  snapshotSchema,
  threadState,
  threadUrl,
  truncateUtf8,
  type Snapshot,
} from "./model";
import { TursoClient, httpUrl, parseEnvFile } from "./turso";
import { fixtureProfile } from "./lib/test-profile";

const now = 1_800_000_000_000;

function thread(id: string, machine: string, state: "running" | "idle" | "needs-you", updatedAt = now) {
  return {
    id,
    title: id,
    state,
    machine,
    projectId: "p",
    projectName: null,
    providerId: null,
    parentThreadId: null,
    createdAt: updatedAt,
    updatedAt,
    url: null,
  };
}

describe("threadState", () => {
  it("prioritises a pending question over running", () => {
    expect(threadState({ status: "running", hasPendingInteraction: true })).toBe("needs-you");
  });
  it("reads the runtime display status", () => {
    expect(threadState({ status: "active", runtime: { displayStatus: "active" } })).toBe("running");
    expect(threadState({ status: "pending", runtime: { displayStatus: "waiting-for-host" } })).toBe("queued");
    expect(threadState({ status: "error", runtime: { displayStatus: "error" } })).toBe("error");
    expect(threadState({ status: "idle", queuedWork: "pending" })).toBe("queued");
    expect(threadState({ status: "idle" })).toBe("idle");
  });
});

describe("selectThreads", () => {
  it("keeps live work and finished work from the last 7 days, and drops older", () => {
    const kept = selectThreads(
      [
        thread("old", "laptop", "idle", now - 8 * 86_400_000),
        thread("week", "laptop", "idle", now - 6 * 86_400_000),
        thread("live", "laptop", "running", now - 9 * 86_400_000),
        thread("new", "laptop", "idle"),
      ],
      now,
    );
    expect(kept.map((t) => t.id)).toEqual(["live", "new", "week"]);
  });

  it("always keeps pinned chats, however old", () => {
    const pinned = { ...thread("pinned", "laptop", "idle", now - 90 * 86_400_000), pinned: true };
    const kept = selectThreads([thread("old", "laptop", "idle", now - 30 * 86_400_000), pinned], now);
    expect(kept.map((t) => t.id)).toEqual(["pinned"]);
  });

  it("caps at 40, live first, then pinned, then the most recent", () => {
    const recent = Array.from({ length: 45 }, (_, i) => thread(`r${i}`, "laptop", "idle", now - i * 60_000));
    const pinned = { ...thread("pinned", "laptop", "idle", now - 20 * 86_400_000), pinned: true };
    const live = thread("live", "laptop", "running", now - 5 * 86_400_000);
    const kept = selectThreads([...recent, pinned, live], now);
    expect(kept).toHaveLength(40);
    expect(kept.map((t) => t.id)).toContain("pinned");
    expect(kept[0]!.id).toBe("live");
    expect(kept.map((t) => t.id)).not.toContain("r44");
  });
});

describe("buildColumns mirror flag", () => {
  it("marks the machines whose own bb can mirror its chats", () => {
    const snap = (serverId: string, key: string, features?: string[]): Snapshot => ({
      serverId,
      label: key,
      url: null,
      machineKey: key,
      machines: [{ key, label: key, online: true, capabilities: [] }],
      threads: [],
      publishedAt: now,
      ...(features ? { features } : {}),
    });
    const cols = buildColumns([snap("laptop-srv", "laptop", ["messages", "outputs", "mirror"]), snap("work-srv", "work", ["messages", "outputs"])], "laptop-srv", ["laptop"], now, fixtureProfile());
    expect(cols.find((c) => c.key === "laptop")?.mirror).toBe(true);
    expect(cols.find((c) => c.key === "work")?.mirror).toBe(false);
  });
});

describe("buildColumns", () => {
  const laptopSnap: Snapshot = {
    serverId: "laptop-srv",
    label: "Laptop",
    url: "https://laptop.example.invalid",
    machineKey: "laptop",
    machines: [
      { key: "laptop", label: "Laptop", online: true, capabilities: [] },
      { key: "studio", label: "studio", online: true, capabilities: [] },
    ],
    threads: [thread("a", "laptop", "running"), thread("b", "studio", "idle")],
    publishedAt: now,
  };
  const studioSnap: Snapshot = {
    serverId: "studio-srv",
    label: "studio home",
    url: "https://studio.example.invalid",
    machineKey: "studio",
    machines: [{ key: "studio", label: "studio home", online: true, capabilities: ["NAS"] }],
    threads: [thread("c", "studio", "needs-you")],
    publishedAt: now - 10 * 60_000, // stale
  };

  it("merges a machine seen by two servers into one column", () => {
    const cols = buildColumns([laptopSnap, studioSnap], "laptop-srv", ["laptop", "studio"], now, fixtureProfile());
    expect(cols.map((c) => c.key)).toEqual(["laptop", "studio"]);
    const col = cols[1]!;
    expect(col.label).toBe("studio home");
    expect(col.serverId).toBe("studio-srv");
    expect(col.capabilities).toEqual(["NAS"]);
    expect(col.threads.map((t) => `${t.via}:${t.id}`)).toEqual(["studio-srv:c", "laptop-srv:b"]);
    expect(col.counts.needsYou).toBe(1);
    // still online because the local bb sees it connected, even though its own snapshot is stale
    expect(col.online).toBe(true);
  });

  it("marks a machine offline when only a stale snapshot mentions it", () => {
    const cols = buildColumns([{ ...laptopSnap, machines: [laptopSnap.machines[0]!] }, studioSnap], "laptop-srv", ["laptop"], now, fixtureProfile());
    expect(cols.find((c) => c.key === "studio")!.online).toBe(false);
  });
});

describe("thread account (F03)", () => {
  const account = { label: "sam", email: "sam@example.com", harness: "claude" as const };
  const owner: Snapshot = {
    serverId: "studio-srv",
    label: "studio home",
    url: null,
    machineKey: "studio",
    machines: [{ key: "studio", label: "studio home", online: true, capabilities: [] }],
    threads: [{ ...thread("with", "studio", "running"), account }, thread("without", "studio", "idle")],
    publishedAt: now,
  };

  it("keeps the account each chat runs on through the snapshot and into the board column", () => {
    const parsed = snapshotSchema.parse(JSON.parse(JSON.stringify(owner)));
    const column = buildColumns([parsed], "laptop-srv", [], now, fixtureProfile()).find((c) => c.key === "studio")!;
    expect(column.threads.find((t) => t.id === "with")?.account).toEqual(account);
    expect(column.threads.find((t) => t.id === "without")?.account).toBeUndefined();
  });

  it("still reads a snapshot from a Fleet that does not publish accounts", () => {
    expect(snapshotSchema.safeParse({ ...owner, threads: [thread("old", "studio", "idle")] }).success).toBe(true);
  });

  it("refuses a malformed account instead of showing a wrong one", () => {
    expect(snapshotSchema.safeParse({ ...owner, threads: [{ ...thread("bad", "studio", "idle"), account: { label: 3 } }] }).success).toBe(false);
  });
});

describe("helpers", () => {
  it("maps host names to machine keys", () => {
    expect(machineKeyForHost("studio", {}, fixtureProfile())).toBe("studio");
    expect(machineKeyForHost("Sam’s laptop MacBook Pro", {}, fixtureProfile())).toBe("laptop");
    expect(machineKeyForHost("Studio", { Studio: "studio" }, fixtureProfile())).toBe("studio");
    expect(machineKeyForHost("studio-host", {}, fixtureProfile())).toBe("studio");
    expect(machineKeyForHost("Guest iMac", {}, fixtureProfile())).toBe("Guest iMac");
  });
  it("builds thread links in bb's route shape", () => {
    expect(threadUrl("https://laptop.example.invalid/", "p1", "t1", false)).toBe("https://laptop.example.invalid/projects/p1/threads/t1");
    expect(threadUrl("https://laptop.example.invalid", "p1", "t1", true)).toBe("https://laptop.example.invalid/threads/t1");
    expect(threadUrl(null, "p1", "t1", false)).toBeNull();
  });
  it("parses brain.env and converts the database URL", () => {
    expect(parseEnvFile("# c\nA=1\nB=\"two\"\n\nbad\n")).toEqual({ A: "1", B: "two" });
    expect(httpUrl("libsql://x.turso.io")).toBe("https://x.turso.io");
    expect(httpUrl("file:///tmp/x")).toBeNull();
  });
});

describe("TursoClient", () => {
  it("encodes args and decodes typed rows", async () => {
    let sent: unknown = null;
    const fake = (async (_url: string, init: { body: string }) => {
      sent = JSON.parse(init.body);
      return new Response(
        JSON.stringify({
          results: [
            {
              type: "ok",
              response: {
                result: {
                  cols: [{ name: "n" }, { name: "s" }, { name: "z" }],
                  rows: [[{ type: "integer", value: "42" }, { type: "text", value: "hi" }, { type: "null" }]],
                },
              },
            },
            { type: "ok" },
          ],
        }),
      );
    }) as unknown as typeof fetch;
    const client = new TursoClient({ url: "https://x", token: "t" }, fake);
    const rows = await client.query("SELECT ?, ?, ?", [1, "a", null]);
    expect(rows).toEqual([{ n: 42, s: "hi", z: null }]);
    expect((sent as { requests: { stmt?: { args: unknown[] } }[] }).requests[0]!.stmt!.args).toEqual([
      { type: "integer", value: "1" },
      { type: "text", value: "a" },
      { type: "null" },
    ]);
  });
  it("surfaces statement errors", async () => {
    const fake = (async () =>
      new Response(JSON.stringify({ results: [{ type: "error", error: { message: "no such table" } }, { type: "ok" }] }))) as unknown as typeof fetch;
    await expect(new TursoClient({ url: "https://x", token: "t" }, fake).query("SELECT 1")).rejects.toThrow("no such table");
  });
});

describe("truncateUtf8", () => {
  it("passes short text through untouched", () => {
    expect(truncateUtf8("PONG", 64)).toEqual({ text: "PONG", truncated: false });
    expect(truncateUtf8("abcd", 4)).toEqual({ text: "abcd", truncated: false });
  });
  it("cuts at the byte limit", () => {
    expect(truncateUtf8("abcdef", 4)).toEqual({ text: "abcd", truncated: true });
  });
  it("never splits a multi-byte character", () => {
    // "é" is 2 bytes, "€" is 3, "😀" is 4 (a surrogate pair in JS)
    expect(truncateUtf8("aé", 2)).toEqual({ text: "a", truncated: true });
    expect(truncateUtf8("ab€", 4)).toEqual({ text: "ab", truncated: true });
    expect(truncateUtf8("😀😀", 5)).toEqual({ text: "😀", truncated: true });
    expect(truncateUtf8("😀", 3)).toEqual({ text: "", truncated: true });
  });
  it("caps a large answer at 64 KB", () => {
    const big = "€".repeat(30_000); // 90,000 bytes
    const cut = truncateUtf8(big, 64 * 1024);
    expect(cut.truncated).toBe(true);
    expect(new TextEncoder().encode(cut.text).length).toBeLessThanOrEqual(64 * 1024);
    expect(cut.text).toBe("€".repeat(Math.floor((64 * 1024) / 3)));
  });
});

describe("decidePublish", () => {
  const base = { state: "idle" as const, hash: "h1", empty: false, threadUpdatedAt: 1000, lastDeliveredAt: null };
  it("publishes a first answer", () => {
    expect(decidePublish({ ...base, published: undefined })).toBe(true);
  });
  it("never publishes while the thread is working", () => {
    expect(decidePublish({ ...base, state: "running", published: undefined })).toBe(false);
    expect(decidePublish({ ...base, state: "needs-you", published: undefined })).toBe(false);
    expect(decidePublish({ ...base, state: "queued", published: undefined })).toBe(false);
  });
  it("skips an idle thread with no answer yet, but reports an error even without one", () => {
    expect(decidePublish({ ...base, empty: true, published: undefined })).toBe(false);
    expect(decidePublish({ ...base, state: "error", empty: true, published: undefined })).toBe(true);
  });
  it("publishes a changed answer or state, and skips an unchanged one", () => {
    const published = { hash: "h1", state: "idle", updatedAt: 900 };
    expect(decidePublish({ ...base, published })).toBe(false);
    expect(decidePublish({ ...base, hash: "h2", published })).toBe(true);
    expect(decidePublish({ ...base, state: "error", published })).toBe(true);
  });
  it("republishes an identical answer after a delivered message's turn has finished", () => {
    const published = { hash: "h1", state: "idle", updatedAt: 900 };
    // delivered at 950, the thread settled again at 1000: a new turn with the same answer ("PONG" twice)
    expect(decidePublish({ ...base, lastDeliveredAt: 950, threadUpdatedAt: 1000, published })).toBe(true);
    // the thread has not moved since the delivery: that turn is not over
    expect(decidePublish({ ...base, lastDeliveredAt: 950, threadUpdatedAt: 940, published })).toBe(false);
    // already republished after that delivery
    expect(decidePublish({ ...base, lastDeliveredAt: 950, threadUpdatedAt: 1000, published: { ...published, updatedAt: 960 } })).toBe(false);
  });
});

describe("parseDuration", () => {
  it("reads units and bare seconds", () => {
    expect(parseDuration("20m")).toBe(1_200_000);
    expect(parseDuration("90s")).toBe(90_000);
    expect(parseDuration("1h")).toBe(3_600_000);
    expect(parseDuration("500ms")).toBe(500);
    expect(parseDuration("45")).toBe(45_000);
  });
  it("rejects anything else", () => {
    expect(parseDuration("soon")).toBeNull();
    expect(parseDuration("-5m")).toBeNull();
    expect(parseDuration("5 m")).toBeNull();
  });
});

describe("parseRelayArgs", () => {
  const ok = (argv: string[]) => {
    const r = parseRelayArgs(argv, fixtureProfile());
    if (!r.ok) throw new Error(r.error);
    return r.command;
  };
  const err = (argv: string[]) => {
    const r = parseRelayArgs(argv, fixtureProfile());
    if (r.ok) throw new Error(`expected an error for ${argv.join(" ")}`);
    return r.error;
  };

  it("parses ask with defaults", () => {
    expect(ok(["ask", "work", "Print", "the", "output", "of", "hostname"])).toEqual({
      kind: "ask",
      machine: "work",
      prompt: "Print the output of hostname",
      messageFile: null,
      timeoutMs: 20 * 60_000,
      json: false,
    });
  });
  it("accepts options anywhere and in --key=value form", () => {
    expect(ok(["ask", "--timeout=5m", "studio", "hi", "--json", "--message-file", "/tmp/t.md"])).toMatchObject({
      machine: "studio",
      prompt: "hi",
      messageFile: "/tmp/t.md",
      timeoutMs: 300_000,
      json: true,
    });
  });
  it("lets a file stand in for the prompt", () => {
    expect(ok(["ask", "work", "--message-file", "notes.md"])).toMatchObject({ prompt: "", messageFile: "notes.md" });
  });
  it("treats everything after a bare -- as text", () => {
    expect(ok(["ask", "work", "--", "explain", "--json", "and", "--wait"])).toMatchObject({ prompt: "explain --json and --wait", json: false });
  });
  it("parses tell, and a timeout implies --wait", () => {
    expect(ok(["tell", "work", "thr_svacsjrvqs", "Reply", "with", "PONG"])).toMatchObject({
      kind: "tell",
      threadId: "thr_svacsjrvqs",
      message: "Reply with PONG",
      wait: false,
    });
    expect(ok(["tell", "work", "thr_svacsjrvqs", "PONG?", "--wait"])).toMatchObject({ wait: true, timeoutMs: 20 * 60_000 });
    expect(ok(["tell", "work", "thr_svacsjrvqs", "--message-file", "/tmp/call.md", "--timeout", "90s"])).toMatchObject({
      message: "",
      messageFile: "/tmp/call.md",
      wait: true,
      timeoutMs: 90_000,
    });
  });
  it("parses output and result", () => {
    expect(ok(["output", "studio", "thr_abc123", "--json"])).toEqual({ kind: "output", machine: "studio", threadId: "thr_abc123", json: true });
    expect(ok(["result", "0123ABCD-0000-0000-0000-000000000001", "--wait", "--timeout", "30m"])).toEqual({
      kind: "result",
      commandId: "0123abcd-0000-0000-0000-000000000001",
      wait: true,
      timeoutMs: 30 * 60_000,
      json: false,
    });
    expect(ok(["result", "0123abcd-0000-0000-0000-000000000001"])).toMatchObject({ wait: false });
  });
  it("answers --help per command", () => {
    expect(ok(["tell", "--help"])).toEqual({ kind: "help", command: "tell" });
    expect(ok(["result", "-h"])).toEqual({ kind: "help", command: "result" });
  });
  it("reports what is missing or wrong", () => {
    expect(err(["ask"])).toMatch(/Missing <machine>/);
    expect(err(["ask", "work"])).toMatch(/Missing <prompt>/);
    expect(err(["tell", "work"])).toMatch(/Missing <thread-id>/);
    expect(err(["tell", "work", "thr_abc123"])).toMatch(/Missing <message>/);
    expect(err(["tell", "work", "not a thread", "hi"])).toMatch(/Not a thread id/);
    expect(err(["output", "work", "thr_abc123", "extra"])).toMatch(/Unexpected argument/);
    expect(err(["result", "nope!"])).toMatch(/Not a fleet command or request id/);
    expect(err(["ask", "work", "hi", "--force"])).toMatch(/Unknown option '--force'.*bare --/);
    expect(err(["output", "work", "thr_abc123", "--wait"])).toMatch(/Unknown option '--wait'/);
    expect(err(["ask", "work", "hi", "--timeout", "soon"])).toMatch(/Invalid --timeout/);
    expect(err(["ask", "work", "hi", "--timeout", "2h"])).toMatch(/at most 60m/);
    expect(err(["ask", "work", "hi", "--timeout"])).toMatch(/--timeout needs a value/);
    expect(err(["tell", "work", "thr_abc123", "--wait=yes", "hi"])).toMatch(/takes no value/);
    expect(err(["status"])).toMatch(/Unknown command/);
  });
  it("keeps the wait cap at 60 minutes", () => {
    expect(MAX_WAIT_MS).toBe(3_600_000);
    expect(ok(["ask", "work", "hi", "--timeout", "60m"])).toMatchObject({ timeoutMs: 3_600_000 });
  });
});

describe("composeMessage", () => {
  it("puts typed words before the file text", () => {
    expect(composeMessage("File this call:", "Alice: hi\nBob: hello\n")).toBe("File this call:\n\nAlice: hi\nBob: hello\n");
    expect(composeMessage("", "only the file")).toBe("only the file");
    expect(composeMessage("only words", null)).toBe("only words");
  });
});

describe("snapshot features", () => {
  it("keeps the two-way marker and still reads a snapshot from an older Fleet", () => {
    const old = { serverId: "work", label: "work", url: null, machineKey: "work", machines: [], threads: [], publishedAt: 1 };
    expect(snapshotSchema.parse(old).features).toBeUndefined();
    expect(snapshotSchema.parse({ ...old, features: ["messages", "outputs"] }).features).toEqual(["messages", "outputs"]);
  });
});
