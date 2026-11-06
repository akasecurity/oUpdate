import { expect, test } from "bun:test";
import type { Reviewer } from "../../src/review.ts";
import { addTallies, newTally, publicTally, restoreTally, servedValuesRefusal, snapshotTally, trackServed } from "./served.ts";

const fake = (served: (string | undefined)[]): Reviewer => {
  let i = 0, cur: string | undefined;
  return { name: "r", review: async () => { cur = served[i++]; return "APPROVE"; }, lastServedBy: () => cur };
};

test("each call is counted by its served-by value, and calls not served by the requested model are counted apart", async () => {
  const t = newTally();
  const r = trackServed(fake(["m1", "m1", "other", undefined, "M1"]), "m1", t);
  for (let i = 0; i < 5; i++) await r.review("x");
  expect(t).toEqual({ calls: 5, by_value: { m1: 2, M1: 1, other: 1 }, not_requested: 1, unknown: 1 });
});

test("a reviewer that cannot say who served counts every call unknown", async () => {
  const t = newTally();
  const r = trackServed({ name: "r", review: async () => "APPROVE" }, "m1", t);
  await r.review("x");
  await r.review("x");
  expect(t).toEqual({ calls: 2, by_value: {}, not_requested: 0, unknown: 2 });
});

test("a failed call is not counted, and the error passes through", async () => {
  const t = newTally();
  const r = trackServed({ name: "r", review: async () => { throw new Error("down"); } }, "m1", t);
  await expect(r.review("x")).rejects.toThrow("down");
  expect(t.calls).toBe(0);
});

test("tallies add up", () => {
  const a = { calls: 2, by_value: { m1: 1, x: 1 }, not_requested: 1, unknown: 0 };
  const b = { calls: 3, by_value: { m1: 2 }, not_requested: 0, unknown: 1 };
  expect(addTallies([a, b])).toEqual({ calls: 5, by_value: { m1: 3, x: 1 }, not_requested: 1, unknown: 1 });
});

test("a committed tally carries counts only; the served-by values are kept out unless asked for", () => {
  const t = { calls: 5, by_value: { secret: 4, other: 1 }, not_requested: 1, unknown: 0 };
  expect(publicTally(t, false)).toEqual({ calls: 5, not_requested: 1, unknown: 0 });
  expect(JSON.stringify(publicTally(t, false))).not.toContain("secret");
  expect(publicTally(t, true)).toEqual(t);
});

test("--served-values is refused unless --out points outside the repo", () => {
  const repo = "/work/repo";
  expect(servedValuesRefusal(false, undefined, repo)).toBeUndefined();
  expect(servedValuesRefusal(false, "/work/repo/eval/limits/results", repo)).toBeUndefined();
  expect(servedValuesRefusal(true, undefined, repo)).toContain("--out");
  expect(servedValuesRefusal(true, "/work/repo/eval/limits/results", repo)).toContain("--out");
  expect(servedValuesRefusal(true, "/work/repo/eval/limits/../limits/results/x", repo)).toContain("--out");
  expect(servedValuesRefusal(true, "/work/repo", repo)).toContain("--out");
  expect(servedValuesRefusal(true, "/work/repo-other/out", repo)).toBeUndefined();
  expect(servedValuesRefusal(true, "/tmp/out", repo)).toBeUndefined();
});

test("a tally restored from a snapshot drops the calls of a failed attempt", async () => {
  const t = newTally();
  const r = trackServed(fake(["m1", "other", "m1"]), "m1", t);
  await r.review("x");
  const snap = snapshotTally(t);
  await r.review("x");
  await r.review("x");
  restoreTally(t, snap);
  expect(t).toEqual({ calls: 1, by_value: { m1: 1 }, not_requested: 0, unknown: 0 });
  await r.review("x");
  expect(t.calls).toBe(2);
});
