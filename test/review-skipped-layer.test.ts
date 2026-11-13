import { describe, expect, test } from "bun:test";
import { reviewUpdate, classifyOutcome, type LayerName, type ReviewResult } from "../src/review.ts";

const input = (only: LayerName[]) => ({
  eco: "pypi" as const, name: "p", from: "1", to: "2",
  registry: { latest: async () => undefined, publishedAt: async () => new Date("2020-01-01"), artifactUrls: async () => [] },
  advisories: { query: async () => [] },
  reviewer: undefined,
  cooldownDays: 1, now: new Date("2026-10-21T00:00:00Z"),
  loadArtifacts: async () => ({ old: new Map(), new: new Map() }),
  only,
});

describe("a skipped layer is not a pass", () => {
  test("with nothing but skipped layers the release is held", async () => {
    const r = await reviewUpdate(input(["gate"]));
    expect(r.layers.every((l) => l.verdict === "skipped")).toBe(true);
    expect(r.decision).toBe("hold");
    expect(classifyOutcome(r)).not.toBe("passed");
  });

  test("with another layer passing, skipped layers still land as before", async () => {
    const r = await reviewUpdate(input(["cooldown", "prepass"]));
    expect(r.layers.find((l) => l.layer === "prepass")?.verdict).toBe("pass");
    expect(r.decision).toBe("land");
  });
});

describe("landing needs a layer that reads code", () => {
  test("cooldown or advisory passing alone holds", async () => {
    for (const only of [["cooldown"], ["advisory"], ["cooldown", "advisory"]] as LayerName[][]) {
      expect((await reviewUpdate(input(only))).decision).toBe("hold");
    }
  });
  test("a pre-pass pass with the rest skipped lands", async () => {
    expect((await reviewUpdate(input(["prepass"]))).decision).toBe("land");
  });
});

test("a layer that errored is never read as a hold for a limit: the error ranks above held-human, a real stop above both", () => {
  const mk = (...layers: [LayerName, "pass" | "stop" | "error", string][]): ReviewResult => ({ eco: "npm", name: "p", from: "1", to: "2", decision: "hold", layers: layers.map(([layer, verdict, detail]) => ({ layer, verdict, detail })) });
  const limit: [LayerName, "stop", string] = ["reviewer", "stop", "too large for model review: 90 parts > 72 (full diff); needs a human"];
  expect(classifyOutcome(mk(limit))).toBe("held-human");
  expect(classifyOutcome(mk(["scan", "error", "scanner crashed"], limit))).toBe("error");
  expect(classifyOutcome(mk(["scan", "error", "scanner crashed"], ["prepass", "stop", "install script"], limit))).toBe("stopped");
});

test("a stop from advisory or cooldown beside a layer that errored is an error, not stopped; a malicious entry or a code-layer stop still stops", () => {
  const mk = (layers: [LayerName, "pass" | "stop" | "error", string][], malicious?: string[]): ReviewResult => ({ eco: "npm", name: "p", from: "1", to: "2", decision: "hold", malicious, layers: layers.map(([layer, verdict, detail]) => ({ layer, verdict, detail })) });
  const adv: [LayerName, "stop", string] = ["advisory", "stop", "introduces: GHSA-x (high): a vulnerability"];
  const load: [LayerName, "error", string] = ["prepass", "error", "could not load the artifact"];
  expect(classifyOutcome(mk([adv]))).toBe("stopped");
  expect(classifyOutcome(mk([adv, load]))).toBe("error");
  expect(classifyOutcome(mk([["cooldown", "stop", "published 1 day ago"], load]))).toBe("error");
  expect(classifyOutcome(mk([adv, load], ["MAL-1"]))).toBe("stopped");
  expect(classifyOutcome(mk([adv, load, ["reviewer", "stop", "FLAG: install hook posts credentials"]]))).toBe("stopped");
});
