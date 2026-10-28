import { describe, expect, test } from "bun:test";
import { reviewUpdate, classifyOutcome, type LayerName } from "../src/review.ts";

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
