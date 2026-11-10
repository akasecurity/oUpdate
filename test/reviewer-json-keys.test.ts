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
});
