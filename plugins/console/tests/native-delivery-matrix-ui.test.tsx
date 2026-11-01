// @vitest-environment jsdom
import React from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DeliveryMatrixTable } from "../src/delivery-matrix";
import { matrixSourceLabel } from "../src/delivery-model";
const choice = {
  providerId: "codex",
  model: "gpt-5.5",
  reasoningLevel: "medium",
};
const purposes = ["title", "commit", "pull-request", "review", "research"] as const;
const cells = (state: "applied" | "unset" | "unverified") =>
  purposes.map((purpose) => ({
    purpose,
    choice: state === "unset" ? null : choice,
    source: state === "unset" ? null : { projectId: "p", hostId: null },
    state,
    reason: `${state} reason`,
  }));
afterEach(cleanup);
describe("delivery matrix table", () => {
  it("shows one column per machine with its state and the model chosen", () => {
    const view = render(
      <DeliveryMatrixTable
        matrix={{
          revision: 1,
          readAt: 0,
          hosts: [
            {
              hostId: "m1",
              name: "Studio",
              connected: true,
              cells: cells("applied"),
            },
            {
              hostId: "m5",
              name: "Laptop",
              connected: true,
              cells: cells("unset"),
            },
            {
              hostId: "m4",
              name: "Work",
              connected: false,
              cells: cells("unverified"),
            },
          ],
        }}
      />,
    );
    const heads = [...view.container.querySelectorAll("thead th")].map((node) => node.textContent);
    expect(heads).toEqual(["Task", "Studio", "Laptop", "Work (offline)"]);
    const first = view.container.querySelectorAll("tbody tr")[0];
    const text = [...first.querySelectorAll("td")].map((node) => node.textContent);
    expect(text).toEqual([
      "codex / gpt-5.5AppliedInherited from all machines",
      "-Not set",
      "codex / gpt-5.5Not checkedInherited from all machines",
    ]);
    expect(first.querySelectorAll("td")[1].getAttribute("title")).toBe("unset reason");
  });
  it("says so when no machine is enrolled", () => {
    const view = render(<DeliveryMatrixTable matrix={{ revision: 0, readAt: 0, hosts: [] }} />);
    expect(view.container.textContent).toContain("No machines are enrolled");
  });
  it("says whether each machine has its own value or inherits one", () => {
    expect(matrixSourceLabel({ projectId: "p", hostId: "m4" }, "m4")).toBe("Set for this machine");
    expect(matrixSourceLabel({ projectId: "p", hostId: null }, "m5")).toBe("Inherited from all machines");
    expect(matrixSourceLabel({ projectId: null, hostId: null }, "m5")).toBe("Inherited from all machines");
    expect(matrixSourceLabel(null, "m5")).toBe("");
  });
  it("shows Work value, Laptop inherited value and the offline Work as not applied", () => {
    const own = { ...cells("applied")[0], source: { projectId: "p", hostId: "m4" } };
    const inherited = { ...cells("applied")[0], source: { projectId: "p", hostId: null } };
    const view = render(
      <DeliveryMatrixTable
        matrix={{
          revision: 2,
          readAt: 0,
          hosts: [
            { hostId: "m4", name: "Work", connected: false, cells: [{ ...own, state: "unverified" as const }] },
            { hostId: "m5", name: "Laptop", connected: true, cells: [inherited] },
          ],
        }}
      />,
    );
    const row = view.container.querySelector("tbody tr")!;
    const [m4, m5] = [...row.querySelectorAll("td")].map((node) => node.textContent);
    expect(m4).toBe("codex / gpt-5.5Not checkedSet for this machine");
    expect(m5).toBe("codex / gpt-5.5AppliedInherited from all machines");
  });
});
