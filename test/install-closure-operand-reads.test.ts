import { expect, test } from "bun:test";
import { classifyJs, operandReadCount, type JsTier } from "../src/install-closure.ts";

// A slash after a bracket may divide or start a regular expression; the scan reads the span to the next slash both ways, and the division reading
// asks whether the span ends in a name or a number. That question is read from the end of the span once: a pattern that tries every start inside
// a run of name characters reads the run to its end each time, which grows with the square of the span when the run is not the last token.
// The first rows pin the tier main returns for the spans the read decides (a number run then a name character, a run of spaces, a keyword-free end)
// and the characters it charges; the last row runs the real path at a size where the pattern took 40 to 49 s and the read takes milliseconds.
const CLOSED = { all: true, pkg: false, tests: false, flows: false, same: false, dirs: [] as string[], lits: [] as string[] };
const OPEN = { ...CLOSED, all: false };
const shapes: [string, (len: number) => string, JsTier][] = [
  ["a span of names that ends the expression", (len) => `x = (1) /${"a".repeat(len)}/;\n`, OPEN],
  ["a span of digits that ends the expression", (len) => `x = (1) /${"1".repeat(len)}/;\n`, OPEN],
  ["a span of dotted numbers that ends the expression", (len) => `x = (1) /1${".1".repeat(len / 2)}/;\n`, OPEN],
  ["a span of names that ends in a plus", (len) => `x = (1) /${"a".repeat(len)}+/;\n`, CLOSED],
  ["a span of names that ends in a name after a space", (len) => `x = (1) /${"a".repeat(len)} b/;\n`, OPEN],
  ["a span of names followed by a name after the slash", (len) => `x = (1) /${"a".repeat(len)}/ 1;\n`, CLOSED],
  ["a number run then a name character", () => "x = (1) /1$/;\n", OPEN],
  ["a dotted number run then a name character", () => "x = (1) /1.5$/;\n", OPEN],
  ["a number run then a name character then a plus", () => "x = (1) /1$ +/;\n", CLOSED],
  ["a name then a long run of spaces", () => `x = (1) /a${" ".repeat(40)}/;\n`, OPEN],
  ["a name then spaces and tabs then a plus", () => `x = (1) /a ${"\t".repeat(30)}+/;\n`, CLOSED],
];
for (const [name, source, tier] of shapes) {
  test(`${name} gives the tier main returns, reading a multiple of its length`, () => {
    for (const len of [1000, 4000]) {
      const before = operandReadCount();
      const got = classifyJs("lib/x.js", source(len));
      const reads = operandReadCount() - before;
      expect(got).toEqual(tier);
      expect(reads).toBeGreaterThan(0);
      expect(reads).toBeLessThanOrEqual(16 * len + 100);
    }
  });
}

// Wall time, at a size and bound far from both: a span of 100,000 name characters then a plus took 40 to 49 s with the pattern (the ratio to now is
// above 200); the bound is 3 s, so a slow machine does not flake it and a return of the quadratic read fails it.
test("a span of 100,000 name characters then a plus is read in seconds, not tens of seconds", () => {
  const source = `x = (1) /${"a".repeat(100_000)}+/;\n`;
  const t = performance.now();
  const got = classifyJs("lib/x.js", source);
  const ms = performance.now() - t;
  expect(got).toEqual(CLOSED);
  expect(ms).toBeLessThan(3000);
}, 120_000);
