import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@get-bb/plugin-sdk/app", () => ({}));

import { liveState } from "./live-state";
import { transformPaste } from "./markdown";

const around = { before: "", after: "" };
const rows = "| a | b |\n| 1 | 2 |";

afterEach(() => liveState.set(true));

describe("transformPaste", () => {
  it("repairs a pasted table while the Md switch is on", () => {
    expect(transformPaste(rows, around)).toBe("| Column 1 | Column 2 |\n| --- | --- |\n| a | b |\n| 1 | 2 |");
  });

  it("leaves every paste as it came while the Md switch is off", () => {
    liveState.set(false);
    expect(transformPaste(rows, around)).toBe(rows);
  });
});
