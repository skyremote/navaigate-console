// The feed: how Fleet's server hands a copy's records to the fleet-mirror
// bridge on the same Mac. One append-only NDJSON file per copy, named by the
// copy's thread id, in Fleet's plugin data folder; the bridge keeps its place
// in a cursor file beside it. Plaintext stays on this Mac (the copy's own
// timeline holds the same text).
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FeedRecord } from "./protocol";

export function feedPath(feedDir: string, threadId: string): string {
  return join(feedDir, `${safeName(threadId)}.ndjson`);
}

export function stagingPath(feedDir: string, key: string): string {
  return join(feedDir, `staging-${safeName(key)}.ndjson`);
}

export function cursorPath(feedDir: string, threadId: string): string {
  return join(feedDir, `${safeName(threadId)}.cursor.json`);
}

function safeName(name: string): string {
  return name.replace(/[^A-Za-z0-9_.-]/g, "_");
}

export function ensureFeedDir(feedDir: string): void {
  mkdirSync(feedDir, { recursive: true, mode: 0o700 });
}

/** Append records as whole lines (the bridge only reads complete lines). */
export function appendFeed(path: string, records: readonly FeedRecord[]): void {
  if (records.length === 0) return;
  appendFileSync(path, records.map((r) => `${JSON.stringify(r)}\n`).join(""), { mode: 0o600 });
}

/** Move a staged feed to the copy's name once bb has given the copy its id. */
export function promoteFeed(staging: string, path: string): void {
  if (existsSync(path)) throw new Error(`A feed for this copy already exists: ${path}`);
  renameSync(staging, path);
}

export function readCursor(path: string): number {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { next?: unknown };
    return typeof parsed.next === "number" && parsed.next >= 0 ? Math.floor(parsed.next) : 0;
  } catch {
    return 0;
  }
}

export function writeCursor(path: string, next: number): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ next, at: Date.now() }), { mode: 0o600 });
  renameSync(tmp, path);
}

/** Incremental reader: each call returns the records appended since the last call. */
export class FeedReader {
  private offset = 0;
  private partial: Buffer = Buffer.alloc(0);
  readonly records: FeedRecord[] = [];

  constructor(readonly path: string) {}

  exists(): boolean {
    return existsSync(this.path);
  }

  /** Read whatever was appended; malformed lines are skipped (and counted). */
  poll(): { added: number; bad: number } {
    let size: number;
    try {
      size = statSync(this.path).size;
    } catch {
      return { added: 0, bad: 0 };
    }
    if (size <= this.offset) return { added: 0, bad: 0 };
    const fd = openSync(this.path, "r");
    let bytes: Buffer;
    try {
      const buffer = Buffer.alloc(size - this.offset);
      let read = 0;
      while (read < buffer.length) {
        const n = readSync(fd, buffer, read, buffer.length - read, this.offset + read);
        if (n <= 0) break;
        read += n;
      }
      this.offset += read;
      bytes = Buffer.concat([this.partial, buffer.subarray(0, read)]);
    } finally {
      closeSync(fd);
    }
    // Decode only complete lines, so a character split by a half-written line stays whole.
    const end = bytes.lastIndexOf(0x0a);
    this.partial = end === -1 ? bytes : bytes.subarray(end + 1);
    if (end === -1) return { added: 0, bad: 0 };
    let added = 0;
    let bad = 0;
    for (const line of bytes.subarray(0, end).toString("utf8").split("\n")) {
      if (line.trim() === "") continue;
      try {
        this.records.push(JSON.parse(line) as FeedRecord);
        added += 1;
      } catch {
        bad += 1;
      }
    }
    return { added, bad };
  }
}
