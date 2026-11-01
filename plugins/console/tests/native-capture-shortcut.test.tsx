// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { registerContextWorkspace } from "../src/context-workspace";

type Shortcut = {
  key: string;
  mod?: boolean;
  alt?: boolean;
  shift?: boolean;
};
type Command = { id: string; defaultShortcut?: Shortcut };

function registered() {
  const commands: Command[] = [];
  const app = {
    composer: {
      customize() {},
      experimental_registerCommand(command: Command) {
        commands.push(command);
      },
    },
    slots: { messageAction() {} },
  };
  registerContextWorkspace(app as never);
  return commands;
}

const signature = (s: Shortcut) =>
  [s.mod && "mod", s.alt && "alt", s.shift && "shift", s.key.toLowerCase()]
    .filter(Boolean)
    .join("+");

describe("capture window shortcut", () => {
  it("does not use Cmd+Alt+S, which the screen-share mod toggles first", () => {
    const capture = registered().find((c) => c.id === "capture-window");
    expect(capture?.defaultShortcut).toBeDefined();
    expect(signature(capture!.defaultShortcut!)).not.toBe("mod+alt+s");
  });

  it("keeps every workspace command on its own shortcut", () => {
    const sigs = registered()
      .filter((c) => c.defaultShortcut)
      .map((c) => signature(c.defaultShortcut!));
    expect(new Set(sigs).size).toBe(sigs.length);
  });
});
