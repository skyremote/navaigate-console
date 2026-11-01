import { useState } from "react";
import { experimental_saveFile as saveFile, useRpc } from "@get-bb/plugin-sdk/app";
import type { z } from "zod";
import type { deliveryRpcContract, doctorReportSchema } from "../delivery-contract";
import { button, errorText } from "./delivery-shared";
import { mac, macLabel, machineName } from "./words";
import { useProfile } from "./use-profile";

type Report = z.infer<typeof doctorReportSchema>;

export function FleetDoctorPanel() {
  useProfile();
  const rpc = useRpc<typeof deliveryRpcContract>();
  const [report, setReport] = useState<Report | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const run = async () => {
    setBusy(true);
    setError("");
    try {
      setReport(await rpc.call("delivery_fleet_doctor", null));
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="rounded-lg border border-border p-4 space-y-3" aria-label="Fleet doctor">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="font-medium">Fleet doctor</h2>
          <p className="text-xs text-muted-foreground">
            Reads the broker and every machine's route in one go: the exact error the broker returned, whether {mac()} answers over SSH, and which machine has no route.
          </p>
        </div>
        <button className={button} disabled={busy} onClick={() => void run()}>
          {busy ? "Checking the fleet…" : "Run fleet doctor"}
        </button>
      </header>
      {error && <p role="alert">{error}</p>}
      {report && (
        <>
          <p className="text-[13px]">
            This bb is {machineName(report.self.machine)} on {report.self.appVersion ?? "an unknown version"}. Broker {report.broker.state}
            {report.broker.directM1 ? `; direct ${macLabel()} link ${report.broker.directM1}` : ""}.
          </p>
          <p className="rounded-md border border-border p-3 text-[13px] break-words" aria-label="Broker error">
            Broker error: {report.broker.error ?? "none"}
          </p>
          <ul className="space-y-2">
            {report.machines.map((machine) => (
              <li key={machine.machine} aria-label={machineName(machine.machine)} className="rounded-md border border-border p-3 text-[13px]">
                <p className="font-medium">
                  {machineName(machine.machine)}{" "}
                  {machine.error
                    ? `Unreadable: ${machine.error}`
                    : machine.ok
                      ? `OK · route ${machine.activeRoute}${machine.appVersion ? ` · bb ${machine.appVersion}` : ""}`
                      : "No route"}
                </p>
                {!machine.error && (
                  <ul className="text-xs">
                    {machine.routes.map((route) => (
                      <li key={route.kind}>
                        {route.kind} {route.state}
                        {route.detail ? ` (${route.detail})` : ""}
                      </li>
                    ))}
                    <li>binding: {machine.binding}</li>
                  </ul>
                )}
              </li>
            ))}
          </ul>
          <button
            className={button}
            onClick={() =>
              void saveFile({
                fileName: "bb-fleet-doctor.txt",
                blob: new Blob([report.text], { type: "text/plain" }),
              }).then(
                (outcome) => {
                  if (outcome === "failed") setError("The native/browser save could not start.");
                },
                (cause) => setError(errorText(cause)),
              )
            }
          >
            Save doctor report
          </button>
        </>
      )}
    </section>
  );
}
