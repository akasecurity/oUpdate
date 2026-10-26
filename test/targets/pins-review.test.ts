// The pins diff goes to the existing reviewer with its evidence; the verdict is review.ts's parseVerdict.
import { describe, expect, test } from "bun:test";
import { VERDICT_CONTRACT } from "../../src/review.ts";
import { pinsPrompt, reviewPins, type PinsReviewInput } from "../../src/targets/pins/review.ts";
import { scripted } from "../apply/helpers.ts";

const IN: PinsReviewInput = {
  pinsPath: "img/pins.env",
  changes: [{ group: "cli", from: "1.2.3", to: "1.2.4", evidence: ["npm @scope/cli 1.2.3 -> 1.2.4, published 2026-10-01T00:00:00.000Z"] }],
  diff: "@@ line 2 @@\n-CLI_VERSION=1.2.3\n+CLI_VERSION=1.2.4",
};

describe("pins review", () => {
  test("the prompt carries the evidence, the diff and the verdict contract", () => {
    const p = pinsPrompt(IN);
    expect(p).toContain("img/pins.env");
    expect(p).toContain("[cli] 1.2.3 -> 1.2.4\n  npm @scope/cli 1.2.3 -> 1.2.4");
    expect(p).toContain("+CLI_VERSION=1.2.4");
    expect(p).toContain(VERDICT_CONTRACT);
    expect(p.indexOf("--- evidence ---")).toBeLessThan(p.indexOf("--- diff of img/pins.env ---"));
  });

  test("APPROVE passes, FLAG and a contradicting APPROVE do not", async () => {
    expect(await reviewPins(scripted(["APPROVE\nno attack indicators found"]).r, IN)).toMatchObject({ verdict: "APPROVE", detail: "scripted" });
    expect(await reviewPins(scripted(["FLAG\n+CLI_VERSION=1.2.4 has no evidence"]).r, IN)).toMatchObject({ verdict: "FLAG", detail: "scripted" });
    expect((await reviewPins(scripted(["APPROVE\nI would flag this"]).r, IN)).verdict).toBe("FLAG");
  });

  test("no reviewer or a reviewer failure is an error, never an approval", async () => {
    expect(await reviewPins(undefined, IN)).toEqual({ verdict: "error", detail: "no reviewer configured" });
    expect(await reviewPins(scripted([new Error("timed out")]).r, IN)).toEqual({ verdict: "error", detail: "scripted: timed out" });
  });

  test("the reviewer sees exactly one prompt", async () => {
    const s = scripted(["APPROVE\nfine"]);
    await reviewPins(s.r, IN);
    expect(s.prompts).toEqual([pinsPrompt(IN)]);
  });
});
