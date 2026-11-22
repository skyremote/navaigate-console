// @vitest-environment jsdom
import React, { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { ProfileBadge, ProfileFilter, forgetSessionProfiles, profileCounts, useSessionProfiles } from "../src/session-profile-marks";
import { matchesProfile, type ProfileFilterValue } from "../src/session-profile";

beforeEach(() => forgetSessionProfiles());
afterEach(() => cleanup());

describe("the flag on a chat row", () => {
  it("shows nothing for an Online chat and a labelled flag otherwise", () => {
    const { container } = render(
      <div>
        <ProfileBadge kind={null} />
        <ProfileBadge kind={undefined} />
        <ProfileBadge kind="lean" />
        <ProfileBadge kind="local" />
        <ProfileBadge kind="local-unlocked" />
      </div>,
    );
    const badges = Array.from(container.querySelectorAll<HTMLElement>("[data-nav-part='profile-badge']"));
    expect(badges.map((b) => [b.dataset.profile, b.getAttribute("aria-label")])).toEqual([
      ["lean", "Lean"],
      ["local", "Local"],
      ["local-unlocked", "Local, unlocked"],
    ]);
  });
});

function List({ ids }: { ids: string[] }) {
  const of = useSessionProfiles(ids.map((id) => ({ id })), true);
  const [filter, setFilter] = useState<ProfileFilterValue | null>(null);
  return (
    <div>
      <ProfileFilter value={filter} onChange={setFilter} counts={profileCounts(ids, of)} />
      <ul>
        {ids.filter((id) => matchesProfile(of(id), filter)).map((id) => (
          <li key={id} data-testid="row">
            {id}
            <ProfileBadge kind={of(id)} />
          </li>
        ))}
      </ul>
    </div>
  );
}

describe("the flag list and its filter", () => {
  it("asks the server once in a batch, draws the flags and filters by them", async () => {
    const ids = ["thr_a", "thr_b", "thr_c", "thr_d"];
    const view = renderSlot({ component: List }, { ids }, {
      rpc: {
        session_profiles: () => ({ thr_b: { profile: "lean", v: 1 }, thr_c: { profile: "local", model: "ollama/q", v: 1 }, thr_d: { profile: "local-unlocked", model: "ollama/x-tuned", v: 1 } }),
      } as never,
    });
    await waitFor(() => expect(document.querySelectorAll("[data-nav-part='profile-badge']")).toHaveLength(3));
    expect(view.inspection.rpcCalls.filter((c) => c.method === "session_profiles")).toEqual([expect.objectContaining({ input: { threadIds: ids } })]);
    const item = (v: string) => document.querySelector<HTMLButtonElement>(`[data-nav-part='profile-filter-item'][data-value='${v}']`)!;
    expect(item("online").textContent).toContain("1");
    fireEvent.click(item("online"));
    expect(screen.getAllByTestId("row").map((r) => r.firstChild?.textContent)).toEqual(["thr_a"]);
    fireEvent.click(item("local-unlocked"));
    expect(screen.getAllByTestId("row").map((r) => r.firstChild?.textContent)).toEqual(["thr_d"]);
    // Pressing the chosen filter again shows every chat.
    fireEvent.click(item("local-unlocked"));
    expect(screen.getAllByTestId("row")).toHaveLength(4);
  });
});
