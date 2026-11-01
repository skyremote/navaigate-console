import { describe, expect, it } from "vitest";
import {
  PREFERRED_MODEL,
  curlExample,
  defaultModelFor,
  deliveriesFor,
  deliveryLabel,
  deliveryTone,
  draftProblem,
  emptyDraft,
  slugifyHookName,
} from "../src/webhooks-model";

describe("webhook form model", () => {
  it("folds a typed name into the hook alphabet", () => {
    expect(slugifyHookName("CI Failed.v2!")).toBe("ci-failed-v2");
    expect(slugifyHookName("a".repeat(80))).toHaveLength(48);
  });

  it("starts Claude on Sonnet 5.5 when listed and otherwise on the provider default", () => {
    const models = [{ model: "claude-opus-5-5" }, { model: PREFERRED_MODEL }, { model: "x", isDefault: true }];
    expect(defaultModelFor("claude-code", models)).toBe(PREFERRED_MODEL);
    expect(defaultModelFor("codex", models)).toBe("x");
    expect(defaultModelFor("claude-code", [{ model: "a" }, { model: "b" }])).toBe("a");
    expect(defaultModelFor("claude-code", [])).toBeNull();
    expect(emptyDraft().providerId).toBe("claude-code");
  });

  it("names the first thing missing from a draft", () => {
    const good = { ...emptyDraft(), name: "ci", projectId: "p", model: "m", prompt: "go" };
    expect(draftProblem(good, [], false)).toBeNull();
    expect(draftProblem({ ...good, name: "" }, [], false)).toMatch(/name/);
    expect(draftProblem(good, ["ci"], false)).toMatch(/already exists/);
    expect(draftProblem(good, ["ci"], true)).toBeNull();
    expect(draftProblem({ ...good, projectId: "" }, [], false)).toMatch(/project/);
    expect(draftProblem({ ...good, model: "" }, [], false)).toMatch(/model/);
    expect(draftProblem({ ...good, prompt: "  " }, [], false)).toMatch(/what the agent should do/);
    expect(draftProblem({ ...good, coalesceSeconds: 4000 }, [], false)).toMatch(/3600/);
  });

  it("builds a sender example that reads the secret from the environment", () => {
    const text = curlExample("https://laptop.example.test/api/v1/plugins/p/http/automation-hook", "ci");
    expect(text).toContain("x-nav-hook: ci");
    expect(text).toContain('-hmac "$WEBHOOK_SECRET"');
    expect(text).toContain("v1.ci.$TS.$DELIVERY.$BODY");
  });

  it("labels deliveries and filters them by hook", () => {
    expect(deliveryLabel("held")).toMatch(/offline/);
    expect(deliveryTone("owner-accepted")).toBe("good");
    expect(deliveryTone("refused")).toBe("bad");
    expect(deliveryTone("held")).toBe("wait");
    const rows = [{ hookId: "a" }, { hookId: "b" }] as never[];
    expect(deliveriesFor(rows, "a")).toHaveLength(1);
    expect(deliveriesFor(rows, null)).toHaveLength(2);
  });
});
