import type { z } from "zod";
import type { matrixOutput } from "../delivery-contract";
import { matrixCellLabel, matrixSourceLabel } from "./delivery-model";
type Matrix = z.infer<typeof matrixOutput>;
export function DeliveryMatrixTable({ matrix }: { matrix: Matrix }) {
  const purposes = matrix.hosts[0]?.cells.map((cell) => cell.purpose) ?? [];
  if (!matrix.hosts.length) return <p className="text-[13px] text-muted-foreground">No machines are enrolled.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[13px]" aria-label="Model by task on each machine">
        <thead>
          <tr>
            <th className="py-2 pr-4 text-left text-[12px] font-medium text-muted-foreground">Task</th>
            {matrix.hosts.map((host) => (
              <th key={host.hostId} className="py-2 pr-4 text-left text-[12px] font-medium text-muted-foreground">
                {host.name}
                {host.connected ? "" : " (offline)"}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {purposes.map((purpose, row) => (
            <tr key={purpose}>
              <th scope="row" className="border-t border-border py-2 pr-4 text-left align-top font-normal">
                {purpose.replace("-", " ").replace(/^./, (c) => c.toUpperCase())}
              </th>
              {matrix.hosts.map((host) => {
                const cell = host.cells[row];
                return (
                  <td
                    key={host.hostId}
                    className="border-t border-border py-2 pr-4 align-top"
                    data-state={cell.state}
                    title={cell.reason}
                  >
                    <div className="font-mono text-[12px]">
                      {cell.choice ? `${cell.choice.providerId} / ${cell.choice.model}` : "-"}
                    </div>
                    <div className={cell.state === "applied" ? "text-success" : "text-muted-foreground"}>{matrixCellLabel(cell.state)}</div>
                    {cell.source ? <div className="text-[12px] text-muted-foreground">{matrixSourceLabel(cell.source, host.hostId)}</div> : null}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
