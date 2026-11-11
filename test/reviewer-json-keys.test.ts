import { describe, expect, test } from "bun:test";
import { hasDuplicateKey } from "../src/adapters/reviewer/json-keys.ts";

describe("hasDuplicateKey", () => {
  test("a key twice in one object, at any depth, decoded", () => {
    for (const t of ['{"a":1,"a":2}', '{"x":{"a":1,"b":{"c":1},"a":2}}', '[{"a":1},{"b":[{"c":1,"c":2}]}]', '{"choices":[],"\\u0063hoices":[]}', '{ "a" : 1 , "a" : 2 }'])
      expect(hasDuplicateKey(t), t).toBe(true);
  });
  test("the same key in sibling or nested objects, and keys inside string values, are no repeat", () => {
    for (const t of ['{"a":1,"b":{"a":2}}', '[{"a":1},{"a":2}]', '{"a":"\\"a\\":1,{\\"a\\"","b":"a"}', '{"a":["a","a"],"b":1}', '{"s":"}{,","a":1,"t":"]["}', "[]", '"a"', "1", "{}"])
      expect(hasDuplicateKey(t), t).toBe(false);
  });
  test("linear on a large answer", () => {
    const big = JSON.stringify({ choices: [{ message: { content: "x".repeat(2_000_000) } }], keys: Object.fromEntries(Array.from({ length: 100_000 }, (_, i) => [`k${i}`, i])) });
    const t0 = performance.now();
    expect(hasDuplicateKey(big)).toBe(false);
    expect(performance.now() - t0).toBeLessThan(1000);
  });
  // A scan that went quadratic (a rescan per key or per level) would take about 64x the time on 8x the input. The best of
  // three runs, after a warm-up, keeps timer noise out; 40x leaves room for a slow host.
  test("stays linear as the input grows 8x: many keys, and deep nesting of objects and lists", () => {
    const best = (t: string) => {
      hasDuplicateKey(t);
      let m = Infinity;
      for (let r = 0; r < 3; r++) {
        const t0 = performance.now();
        expect(hasDuplicateKey(t)).toBe(false);
        m = Math.min(m, performance.now() - t0);
      }
      return Math.max(m, 0.5);
    };
    const shapes: [string, (n: number) => string][] = [
      ["keys", (n) => JSON.stringify(Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, "v"])))],
      ["objects", (n) => '{"a":'.repeat(n) + "1" + "}".repeat(n)],
      ["mixed", (n) => '{"a":['.repeat(n) + "1" + "]}".repeat(n)],
    ];
    for (const [name, make] of shapes) {
      const small = best(make(20_000));
      const large = best(make(160_000));
      expect(large / small, `${name}: ${small.toFixed(1)} ms then ${large.toFixed(1)} ms`).toBeLessThan(40);
    }
  });
});
