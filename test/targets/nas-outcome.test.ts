// The caller reads every rc the way the broker counts it (CRB-b128 §4.4); anything not in the table is unknown.
import { describe, expect, test } from "bun:test";
import { mergeOutcome, rcText, readFailure, suspends, writeOutcome } from "../../src/targets/nas/outcome.ts";
import type { WriteVerb } from "../../src/targets/nas/verbs.ts";

describe("write outcomes", () => {
  test.each([
    ["compose.apply", 0, "ok"], ["compose.apply", 2, "no-change"], ["compose.apply", 3, "no-change"], ["compose.apply", 4, "no-change"],
    ["compose.apply", 5, "no-change"], ["compose.apply", 6, "failed"], ["compose.apply", 7, "unknown"], ["compose.apply", 8, "unknown"],
    ["compose.apply", 9, "no-change"], ["compose.apply", 1, "unknown"], ["compose.apply", undefined, "unknown"],
    ["image.prune", 0, "ok"], ["image.prune", 3, "failed"], ["image.prune", 4, "unknown"], ["image.prune", 6, "unknown"], ["image.prune", 9, "no-change"],
    ["plugin.update", 0, "ok"], ["plugin.update", 3, "failed"], ["plugin.update", 4, "no-change"], ["plugin.update", 6, "unknown"], ["plugin.update", 7, "unknown"],
  ] as [WriteVerb, number | undefined, string][])("%s rc %p is %s (Review Focus 3)", (verb, rc, want) => {
    expect(writeOutcome(verb, rc)).toBe(want as never);
  });

  test("the broker's outcome must agree, else unknown (Review Focus 3)", () => {
    expect(mergeOutcome("ok", "ok")).toBe("ok");
    expect(mergeOutcome("ok", "failed")).toBe("unknown");
    expect(mergeOutcome("no-change", "something-else")).toBe("unknown");
  });

  test("failed and unknown suspend the standing entry", () => {
    expect([suspends("failed"), suspends("unknown"), suspends("no-change"), suspends("ok")]).toEqual([true, true, false, false]);
  });

  test("rc text", () => {
    expect(rcText(6)).toBe("failed after a change, rolled back");
    expect(rcText(42)).toBe("not a known rc");
  });
});

describe("read failures", () => {
  test.each([
    [0, undefined],
    [undefined, "no final marker: outcome unknown"],
    [2, "refused by the NAS grammar (rc 2)"],
    [3, "a tool failed on the NAS (rc 3)"],
    [5, "busy: another write or plugin check holds the lock (rc 5)"],
    [7, "deadline on the NAS (rc 7)"],
    [4, "rc 4: outcome unknown"],
  ])("rc %p", (rc, why) => expect(readFailure(rc)).toBe(why));
});
