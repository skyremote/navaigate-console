import { describe, expect, it } from "vitest";
import { isReceiptId, mergeSent, statusLabel, type BoardCommand, type SentRow } from "./sent-receipts";

const receipt = (over: Partial<Parameters<typeof mergeSent>[1][number]> = {}) => ({ id: "job-ui-ask-0001", kind: "ask" as const, status: "completed", machine: "studio", threadId: "thr_a", url: "https://studio/t/thr_a", commandId: null, delivery: "started", updatedAt: 2_000, ...over });
const command = (over: Partial<BoardCommand> = {}): BoardCommand => ({ id: "cmd-12345678", targetServer: "studio-srv", targetMachine: "studio", title: "Check the build", status: "started", threadUrl: "https://studio/t/thr_b", error: null, createdAt: 1_000, ...over });

describe("isReceiptId", () => {
  it("accepts request ids and command ids and rejects anything the server would refuse", () => {
    expect(isReceiptId("job-ui-ask-0001")).toBe(true);
    expect(isReceiptId("  0123abcd-0000-0000-0000-000000000002 ")).toBe(true);
    expect(isReceiptId("short")).toBe(false);
    expect(isReceiptId("has space inside")).toBe(false);
    expect(isReceiptId("")).toBe(false);
  });
});

describe("mergeSent", () => {
  it("lists asks and tells from here newest first", () => {
    const rows = mergeSent([], [receipt({ updatedAt: 2_000 }), receipt({ id: "tell-ui-0000001", kind: "tell", delivery: "sent", updatedAt: 3_000, threadId: "thr_c" })]);
    expect(rows.map((row) => [row.kind, row.machine, row.at])).toEqual([["tell", "studio", 3_000], ["ask", "studio", 2_000]]);
  });

  it("shows a brain command once even when it also has a receipt", () => {
    const rows = mergeSent([command({ id: "cmd-dup-000001", createdAt: 1_500 })], [receipt({ commandId: "cmd-dup-000001", delivery: "sent", threadId: null, url: null })]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "ask", readId: "job-ui-ask-0001" });
  });

  it("keeps older brain commands that have no receipt and lets them be read by command id", () => {
    const rows = mergeSent([command()], []);
    expect(rows).toEqual([expect.objectContaining({ kind: "start", machine: "studio", title: "Check the build", readId: "cmd-12345678", url: "https://studio/t/thr_b", status: "started" })]);
  });

  it("only offers to read an answer for asks and starts, not for tells", () => {
    const rows: SentRow[] = mergeSent([], [receipt(), receipt({ id: "tell-ui-0000001", kind: "tell", updatedAt: 3_000 })]);
    expect(rows.find((row) => row.kind === "tell")!.canRead).toBe(false);
    expect(rows.find((row) => row.kind === "ask")!.canRead).toBe(true);
  });
});

describe("statusLabel", () => {
  it("uses plain words for each outcome and never claims a delivery that is unknown", () => {
    expect(statusLabel({ kind: "tell", status: "completed", delivery: "sent" })).toBe("delivered");
    expect(statusLabel({ kind: "tell", status: "completed", delivery: "queued" })).toBe("queued on the machine");
    expect(statusLabel({ kind: "ask", status: "completed", delivery: "started" })).toBe("started");
    expect(statusLabel({ kind: "ask", status: "completed", delivery: "sent" })).toBe("sent, waiting for the machine");
    expect(statusLabel({ kind: "ask", status: "dispatching", delivery: null })).toBe("result not known: check before sending again");
    expect(statusLabel({ kind: "tell", status: "unavailable", delivery: null })).toBe("not sent");
    expect(statusLabel({ kind: "ask", status: "rejected", delivery: null })).toBe("refused");
  });
});
