import { useCallback, useEffect, useRef, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { z } from "zod";
import type { deliveryRpcContract, staleWorktreesSchema } from "../delivery-contract";
import { button, errorText } from "./delivery-shared";
import { rpcFlight } from "./rpc-flight";
import { field } from "./controls";

type Stale = z.infer<typeof staleWorktreesSchema>;
const THRESHOLDS = [7, 14, 30, 60];
const READ_TTL_MS = 300_000;

export function StaleWorktreesPanel() {
  const rpc = useRpc<typeof deliveryRpcContract>();
  const [days, setDays] = useState(7),
    [data, setData] = useState<Stale | null>(null),
    [error, setError] = useState(""),
    [ticked, setTicked] = useState<string[]>([]),
    [confirming, setConfirming] = useState(false),
    [busy, setBusy] = useState(false),
    [outcome, setOutcome] = useState<Record<string, string>>({}),
    [message, setMessage] = useState("");
  const serial = useRef(0);
  const load = useCallback(
    (fresh: boolean) => {
      const seq = ++serial.current;
      setData(null);
      void rpcFlight()
        .call(`delivery_stale_worktrees:${days}`, () => rpc.call("delivery_stale_worktrees", { days }), { fresh, ttlMs: READ_TTL_MS, slowStrikes: false })
        .then(
          (value) => {
            if (seq !== serial.current) return;
            setData(value);
            setError("");
            setTicked([]);
          },
          (cause) => {
            if (seq === serial.current) setError(errorText(cause));
          },
        );
    },
    [rpc, days],
  );
  const refresh = useCallback(() => load(true), [load]);
  useEffect(() => {
    load(false);
    return () => {
      serial.current++;
    };
  }, [load]);
  const eligible = data?.rows.filter((row) => row.plan.eligible).length ?? 0;
  const chosen = data?.rows.filter((row) => ticked.includes(row.environmentId)) ?? [];
  const run = async () => {
    setBusy(true);
    try {
      const response = await rpc.call("delivery_stale_cleanup", {
        items: chosen.map((row) => ({ environmentId: row.environmentId, fingerprint: row.plan.fingerprint })),
        intent: "explicit-user-action",
      });
      rpcFlight().invalidate(`delivery_stale_worktrees:${days}`);
      setOutcome(Object.fromEntries(response.results.map((entry) => [entry.environmentId, entry.message])));
      setMessage(response.message);
      setConfirming(false);
      setTicked([]);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="space-y-3" aria-label="Stale worktrees">
      <header className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 className="font-medium">Stale worktrees</h2>
          <p className="text-xs text-muted-foreground">
            BB-managed worktrees nobody has touched for a while. Each one is checked on its owner machine; anything with local changes, a pinned or running chat, or a busy process is skipped.
          </p>
        </div>
        <div className="flex items-end gap-2">
          <button className={button} onClick={refresh}>
            Refresh
          </button>
          <label className="text-[13px]">
            Idle for at least{" "}
            <select
              className={`${field}`}
              aria-label="Idle for at least"
              value={days}
              onChange={(event) => setDays(Number(event.target.value))}
            >
              {THRESHOLDS.map((value) => (
                <option key={value} value={value}>
                  {value} days
                </option>
              ))}
            </select>
          </label>
        </div>
      </header>
      {error && <p role="alert">{error}</p>}
      {data?.guarded === false && (
        <p role="status" className="rounded-md border border-border p-3 text-[13px]">
          This BB core does not advertise protected cleanup, so nothing can be removed from here. The list below is a review of what would qualify.
        </p>
      )}
      {data?.warnings.map((warning) => (
        <p className="text-[13px]" key={warning}>
          {warning}
        </p>
      ))}
      {!data && !error && <p className="text-[13px]">Checking worktrees…</p>}
      {data && !data.rows.length && <p className="text-[13px]">No managed worktree has been idle for {days} days or more.</p>}
      {data && data.rows.length > 0 && (
        <>
          <p className="text-[13px]">
            {eligible} of {data.rows.length} can be cleaned up.
          </p>
          <div className="overflow-auto rounded-lg border border-border">
            <table className="w-full text-[13px]" aria-label="Stale worktrees">
              <thead>
                <tr>
                  <th className="p-2 text-left">
                    <span className="sr-only">Select</span>
                  </th>
                  <th className="p-2 text-left">Worktree</th>
                  <th className="p-2 text-left">Machine</th>
                  <th className="p-2 text-left">Idle</th>
                  <th className="p-2 text-left">Cleanup plan</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((row) => (
                  <tr key={row.environmentId} className="border-t">
                    <td className="p-2">
                      <input
                        type="checkbox"
                        aria-label={`Select ${row.name}`}
                        disabled={!row.plan.eligible}
                        checked={ticked.includes(row.environmentId)}
                        onChange={(event) =>
                          setTicked(event.target.checked ? [...ticked, row.environmentId] : ticked.filter((id) => id !== row.environmentId))
                        }
                      />
                    </td>
                    <td className="p-2">
                      <span className="block font-medium">{row.name}</span>
                      <span className="block text-xs text-muted-foreground">{row.branch ?? row.path}</span>
                    </td>
                    <td className="p-2">{row.hostName}</td>
                    <td className="p-2">{row.idleDays} days</td>
                    <td className="p-2 text-xs">
                      {outcome[row.environmentId] ?? (row.plan.eligible ? "Ready: nothing local to lose" : `Skipped: ${row.plan.blockers.join(" ")}`)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {chosen.length > 0 && !confirming && (
        <button className={button} onClick={() => setConfirming(true)}>
          Clean up {chosen.length} selected…
        </button>
      )}
      {confirming && (
        <div className="rounded-lg border border-border p-4 space-y-2" role="group" aria-label="Confirm protected cleanup">
          <p className="text-[13px]">
            Ask BB core to remove {chosen.map((row) => row.branch ?? row.name).join(", ")}. Each is checked again first and skipped if anything changed.
          </p>
          <div className="flex gap-2">
            <button className={button} disabled={busy} onClick={() => void run()}>
              Confirm cleanup
            </button>
            <button className={button} onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {message && <p role="status" className="text-[13px]">{message}</p>}
    </section>
  );
}
