// The one fleet board every surface reads. The Rail, the Home machines card and
// the control room all show it, so a single store owns the request and the
// timer while any of them is mounted, and each hook only subscribes.
import { useEffect, useSyncExternalStore } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../server";
import type { FleetBoardResult } from "../server-fleet";
import { rpcFlight } from "./rpc-flight";
import { keepIfSame } from "./stable";
import { startVisiblePoll } from "./visible-poll";

const REFRESH_MS = 15_000;
const BOARD_TTL_MS = 5_000;
const KEEP_BOARD_MS = 3 * 60_000;
const STALE_BOARD_MS = 30_000;

export type FleetBoardView = FleetBoardResult & { stale?: boolean };

type BoardRpc = { call: (method: "fleet_board", input: null) => Promise<FleetBoardResult> };

let holders = 0;
let rpc: BoardRpc | null = null;
let snapshot: FleetBoardView | null = null;
let failed = false;
let epoch = 0;
let stop: (() => void) | null = null;
const listeners = new Set<() => void>();

const publish = (next: FleetBoardView | null) => {
  if (next === snapshot) return;
  // The board is read every 15 s and comes back as a new object; subscribers
  // re-render only when something on it differs.
  if (next && snapshot && keepIfSame(snapshot, next) === snapshot) return;
  snapshot = next;
  for (const listener of listeners) listener();
};

async function readBoard(source: BoardRpc): Promise<FleetBoardResult> {
  const board = await source.call("fleet_board", null);
  if (!board.available) throw Object.assign(new Error(board.error ?? "Fleet board unavailable"), { code: "transport_error" });
  return board;
}

function load(fresh = false) {
  const source = rpc;
  if (!source) return;
  const mine = epoch;
  const flight = rpcFlight();
  const isStale = () => {
    const age = flight.ageOf("fleet_board");
    return age !== null && age >= STALE_BOARD_MS;
  };
  flight
    .call("fleet_board", () => readBoard(source), { ttlMs: BOARD_TTL_MS, maxStaleMs: KEEP_BOARD_MS, slowStrikes: false, fresh: fresh || failed })
    .then(
      (result) => {
        failed = false;
        if (mine === epoch) publish(isStale() ? { ...result, stale: true } : result);
      },
      (cause: unknown) => {
        failed = true;
        if (mine !== epoch) return;
        const age = flight.ageOf("fleet_board");
        if (age !== null && age < KEEP_BOARD_MS) {
          if (snapshot && isStale()) publish({ ...snapshot, stale: true });
          return;
        }
        publish({ available: false, board: null, error: cause instanceof Error ? cause.message : String(cause) });
      },
    );
}

const refocus = () => load(true);

function attach(source: BoardRpc): () => void {
  holders++;
  rpc = source;
  if (holders === 1) {
    load();
    window.addEventListener("focus", refocus);
    const stopPoll = startVisiblePoll(() => load(), REFRESH_MS);
    stop = () => {
      stopPoll();
      window.removeEventListener("focus", refocus);
    };
  }
  return () => {
    holders--;
    if (holders > 0) return;
    stop?.();
    stop = null;
    rpc = null;
    epoch++;
    failed = false;
    publish(null);
  };
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const read = () => snapshot;

/** Fleet's board, refreshed every 15 seconds while the window is shown, by one timer however many places use it. A focus, or the first poll after a failure, asks for fresh data. Null until the first answer; `stale` is set while an answer older than 30 seconds is still being shown. */
export function useFleetBoard(): FleetBoardView | null {
  const source = useRpc<typeof rpcContract>();
  useEffect(() => attach(source), [source]);
  return useSyncExternalStore(subscribe, read);
}
