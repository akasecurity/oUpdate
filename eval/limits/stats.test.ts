import { expect, test } from "bun:test";
import { readScope, scopeNote, wilson } from "./stats.ts";

test("wilson interval matches known values", () => {
  const a = wilson(10, 10);
  expect(a.hi).toBe(1);
  expect(a.lo).toBeCloseTo(0.7225, 3);
  const b = wilson(5, 10);
  expect(b.lo).toBeCloseTo(0.2366, 3);
  expect(b.hi).toBeCloseTo(0.7634, 3);
  expect(wilson(0, 0)).toEqual({ lo: 0, hi: 1 });
});

test("readScope names a narrowed review and defaults to a full read", () => {
  expect(readScope("")).toBe("full");
  expect(readScope("m FLAG on part(s) 1 of 2: reason")).toBe("full");
  expect(readScope("over budget; m APPROVE on the priority files (2 part(s)); needs a human")).toBe("priority");
  expect(readScope("m FLAG on signal part(s) 1 of 1; note")).toBe("signal");
  expect(readScope("m FLAG on ranked part(s) 1 of 3 reviewed; note")).toBe("ranked");
  expect(scopeNote({ full: 8, priority: 2, signal: 0, ranked: 0 })).toBe("full 8, priority 2");
});
