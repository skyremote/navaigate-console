// Minimal Turso (libSQL) HTTP client: one POST to /v2/pipeline per call.
// No dependencies, server-side only. The token never leaves this process.
import { readFileSync } from "node:fs";
import { request } from "node:https";
import { homedir } from "node:os";
import { join } from "node:path";
import { withStop } from "./stop";

export type SqlArg = string | number | null;
export type Row = Record<string, string | number | null>;

export interface TursoCredentials {
  url: string; // https://<db>.turso.io
  token: string;
}

/** Parse KEY=VALUE lines (brain.env). Comments and blanks are skipped. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/** libsql://x.turso.io -> https://x.turso.io; https stays; anything else is refused. */
export function httpUrl(databaseUrl: string): string | null {
  const trimmed = databaseUrl.trim().replace(/\/+$/, "");
  if (trimmed.startsWith("libsql://")) return `https://${trimmed.slice("libsql://".length)}`;
  if (trimmed.startsWith("https://")) return trimmed;
  return null;
}

/** Credentials from ~/.config/navaigate/brain.env, or null when the machine has none. */
export function loadBrainCredentials(path = join(homedir(), ".config", "navaigate", "brain.env")): TursoCredentials | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const env = parseEnvFile(text);
  const url = env.TURSO_DATABASE_URL ? httpUrl(env.TURSO_DATABASE_URL) : null;
  const token = env.TURSO_AUTH_TOKEN ?? "";
  if (url === null || token === "") return null;
  return { url, token };
}

function encodeArg(value: SqlArg): Record<string, string> {
  if (value === null) return { type: "null" };
  if (typeof value === "number") {
    return Number.isInteger(value) ? { type: "integer", value: String(value) } : { type: "float", value: String(value) };
  }
  return { type: "text", value };
}

interface WireValue {
  type: string;
  value?: string | number;
}

function decodeValue(cell: WireValue): string | number | null {
  if (cell.type === "null" || cell.value === undefined) return null;
  if (cell.type === "integer") return Number(cell.value);
  if (cell.type === "float") return typeof cell.value === "number" ? cell.value : Number(cell.value);
  return String(cell.value);
}

/**
 * fetch-shaped POST over node:https. bb's server process has an intermittent
 * problem with the global fetch (other built-in plugins time out against
 * getbb.app the same way), so the default transport skips it.
 * `agent: false` opens a fresh connection per request: a pooled keep-alive
 * socket that sat idle while bb delivered a long message was already closed by
 * the far end and failed with "socket hang up" (seen from a machine on a VPN).
 */
export const httpsFetch = ((url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) =>
  new Promise<Response>((resolve, reject) => {
    const req = request(
      url,
      {
        method: init.method,
        headers: { ...init.headers, "Content-Length": Buffer.byteLength(init.body).toString() },
        family: 4,
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve(new Response(Buffer.concat(chunks).toString("utf8"), { status: res.statusCode ?? 0 })));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    const abort = () => req.destroy(new Error("The operation was aborted"));
    if (init.signal?.aborted) abort();
    else init.signal?.addEventListener("abort", abort, { once: true });
    req.once("close", () => init.signal?.removeEventListener("abort", abort));
    req.end(init.body);
  })) as unknown as typeof fetch;

export class TursoClient {
  constructor(
    private readonly creds: TursoCredentials,
    private readonly fetchImpl: typeof fetch = httpsFetch,
  ) {}

  /** Run statements in order in one pipeline; returns rows for each. */
  async batch(statements: { sql: string; args?: SqlArg[] }[], timeoutMs = 15_000): Promise<Row[][]> {
    const requests = [
      ...statements.map((s) => ({ type: "execute", stmt: { sql: s.sql, args: (s.args ?? []).map(encodeArg) } })),
      { type: "close" },
    ];
    const response = await this.fetchImpl(`${this.creds.url}/v2/pipeline`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.creds.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ requests }),
      signal: withStop(AbortSignal.timeout(timeoutMs))!,
    });
    if (!response.ok) throw new Error(`Turso HTTP ${response.status}`);
    const body = (await response.json()) as {
      results: {
        type: string;
        error?: { message?: string };
        response?: { result?: { cols: { name: string }[]; rows: WireValue[][] } };
      }[];
    };
    return statements.map((_, index) => {
      const result = body.results[index];
      if (result === undefined) throw new Error("Turso returned too few results");
      if (result.type !== "ok") throw new Error(`Turso error: ${result.error?.message ?? "unknown"}`);
      const table = result.response?.result;
      if (table === undefined) return [];
      return table.rows.map((cells) => {
        const row: Row = {};
        table.cols.forEach((col, i) => {
          const cell = cells[i];
          row[col.name] = cell === undefined ? null : decodeValue(cell);
        });
        return row;
      });
    });
  }

  async query(sql: string, args: SqlArg[] = []): Promise<Row[]> {
    const [rows] = await this.batch([{ sql, args }]);
    return rows ?? [];
  }
}
