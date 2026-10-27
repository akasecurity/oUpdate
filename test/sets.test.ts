import { expect, test } from "bun:test";
import { inSet, loadSets, parseSet, setCounts, setOf } from "../acceptance/sets.ts";

test("an entry without a set is core; an unknown set is an error", () => {
  expect(setOf({ id: "a" })).toBe("core");
  expect(setOf({ id: "a", set: "extended" })).toBe("extended");
  expect(() => setOf({ id: "a", set: "extnded" as never })).toThrow("a");
  expect(inSet({ id: "a" }, "core")).toBe(true);
  expect(inSet({ id: "a" }, "extended")).toBe(false);
  expect(inSet({ id: "a", set: "extended" }, "all")).toBe(true);
});

test("--set defaults to core and rejects an unknown name", () => {
  expect(parseSet(undefined)).toBe("core");
  expect(parseSet("extended")).toBe("extended");
  expect(parseSet("all")).toBe("all");
  expect(() => parseSet("big")).toThrow("core,extended,all");
});

test("counts per set: attacks are real releases (replay included, synthetic not)", () => {
  const cases = [
    { id: "r", source: { type: "replay" } },
    { id: "d", source: { type: "datadog" } },
    { id: "s", source: { type: "synthetic" } },
    { id: "x", set: "extended" as const, source: { type: "datadog" } },
  ];
  const controls = [{ id: "c" }, { id: "cx", set: "extended" as const }];
  const core = setCounts({ cases, controls }, "core");
  expect([core.attacks, core.dataset, core.controls]).toEqual([2, 1, 1]);
  expect([...core.attackIds]).toEqual(["r", "d"]);
  const ext = setCounts({ cases, controls }, "extended");
  expect([ext.attacks, ext.dataset, ext.controls]).toEqual([1, 1, 1]);
  expect([...ext.controlIds]).toEqual(["cx"]);
  expect(setCounts({ cases, controls }, "all").attacks).toBe(3);
});

test("the shipped JSON: core stays the published 9 attacks and 8 controls; extended is 17 and 17", () => {
  const sets = loadSets();
  const core = setCounts(sets, "core");
  expect([core.attacks, core.dataset, core.controls]).toEqual([9, 8, 8]);
  const ext = setCounts(sets, "extended");
  expect([ext.attacks, ext.dataset, ext.controls]).toEqual([17, 17, 17]);
  expect(sets.cases.filter((c) => c.source?.type === "synthetic").every((c) => setOf(c) === "core")).toBe(true);
});
