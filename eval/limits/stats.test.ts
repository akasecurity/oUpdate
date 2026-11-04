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
  expect(readScope("3 of 12 part(s) read, the read time budget of 1 ms ran out; 4 file(s) not reviewed; needs a human")).toBe("partial");
  expect(readScope("1 of 3 part(s) read, the read time budget of 1 ms ran out; 4 file(s) not reviewed; too large for model review: 9 parts > 6 (signal files alone); 20 ranked parts not reviewed; needs a human")).toBe("partial");
  expect(readScope("not model-reviewable: 0 parts to review; 1 file(s) added; needs a human")).toBe("none");
  expect(readScope("too large for model review: 9 parts > 6 (signal files alone); needs a human")).toBe("none");
  expect(readScope("too large for model review: 9 parts > 6 (priority files alone); needs a human")).toBe("none");
  expect(readScope("too large for model review: 9 parts > 6 (full diff); no priority files to review; needs a human")).toBe("none");
  expect(readScope("m FLAG on part(s) 1 of 2: 0 parts to review")).toBe("full");
  expect(readScope("m FLAG on part(s) 1 of 2: no priority files to review")).toBe("priority");
  expect(readScope("over budget; m APPROVE on the priority files (2 part(s)); needs a human")).toBe("priority");
  expect(scopeNote({ full: 8, priority: 2, signal: 0, ranked: 0 })).toBe("full 8, priority 2");
});
