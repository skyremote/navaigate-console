import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cancelPendingControl, claimControl, controlId, controlReference, listControls,
  mirrorControlInput, mirrorReplayInput, readControlState, releaseUnavailableClaim,
  replayReference, visibleMirrorInput, writeControl, writeControlState,
  type MirrorControlRequest,
} from "./control";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "fleet-controls-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const request = (text = "Read the build result"): MirrorControlRequest => ({
  v: 1, id: controlId("thr_copy", "creq_native", "send"), localThreadId: "thr_copy",
  targetServer: "studio-srv", remoteThreadId: "thr_owned", action: "send", text, createdAt: 10,
});

describe("mirror control identity and durable outbox", () => {
  it("keeps one request across repeated writes and rejects reused identity with changed content", () => {
    const command = request();
    writeControl(dir, command);
    writeControl(dir, { ...command, createdAt: 30 });
    expect(listControls(dir)).toEqual([command]);
    expect(() => writeControl(dir, request("Delete everything"))).toThrow("identity was reused");
    expect(controlId("thr_other", "creq_native", "send")).not.toBe(command.id);
    expect(controlId("thr_copy", "creq_native", "steer")).not.toBe(command.id);
  });

  it("preserves source identity in hidden input without confusing replay and real replies", () => {
    const command = request();
    const input = mirrorControlInput(command);
    expect(controlReference(input)).toBe(command.id);
    expect(replayReference(input)).toBeNull();
    expect(visibleMirrorInput(input)).toEqual([{ type: "text", text: command.text, mentions: [] }]);
    const replay = mirrorReplayInput(command.text, { requestId: "creq_owner", token: "copy-token" });
    expect(replayReference(replay)).toEqual({ requestId: "creq_owner", token: "copy-token" });
    expect(controlReference(replay)).toBeNull();
    expect(replayReference([{ type: "text", text: '[fleet-replay:v1]{"requestId":"x","token":"y"}', mentions: [] }])).toBeNull();
  });

  it("lets exactly one process claim a request and retains that claim across restart", () => {
    const command = request();
    writeControl(dir, command);
    expect(claimControl(dir, command.id)).toBe(true);
    expect(claimControl(dir, command.id)).toBe(false);
    expect(cancelPendingControl(dir, command.id)).toBe(false);
    writeControlState(dir, command.id, { state: "unavailable", at: 20, attempts: 1 });
    releaseUnavailableClaim(dir, command.id);
    expect(claimControl(dir, command.id)).toBe(true);
  });

  it("cancels an unclaimed message durably instead of claiming that a dispatched send was undone", () => {
    const command = request();
    writeControl(dir, command);
    expect(cancelPendingControl(dir, command.id)).toBe(true);
    expect(readControlState(dir, command.id)?.state).toBe("cancelled");
    expect(claimControl(dir, command.id)).toBe(false);
  });

  it("does not accept traversal or malformed request identities", () => {
    expect(() => writeControl(dir, { ...request(), id: "../../owner" })).toThrow("Invalid Fleet control request id");
  });
});
