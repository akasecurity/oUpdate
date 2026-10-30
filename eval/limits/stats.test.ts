import { expect, test } from "bun:test";
import { wilson } from "./stats.ts";

test("wilson interval matches known values", () => {
  const a = wilson(10, 10);
  expect(a.hi).toBe(1);
  expect(a.lo).toBeCloseTo(0.7225, 3);
  const b = wilson(5, 10);
  expect(b.lo).toBeCloseTo(0.2366, 3);
  expect(b.hi).toBeCloseTo(0.7634, 3);
  expect(wilson(0, 0)).toEqual({ lo: 0, hi: 1 });
});
