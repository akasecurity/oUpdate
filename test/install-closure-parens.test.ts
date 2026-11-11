import { expect, test } from "bun:test";
import { classifyJs, processHazard, provablyStatic } from "../src/install-closure.ts";

// The kind of a { after a ) depends on the ( that closes it. That ( is found once per file, not by a walk back from every
// brace, so nested groups before braces read in linear time and the verdicts stay what the walk back gave.

const LOAD = 'const r = arguments[1]; r("child_"+"pro"+"cess")';

// Verdicts recorded from the walk back: provablyStatic and processHazard are each other's opposites here.
const ROWS: [string, string, boolean][] = [
  ["a paren group, then a next-line block", `(1)\n{ ${LOAD} }`, false],
  ["a nested group", `((1))\n{ ${LOAD} }`, false],
  ["three levels", `(((1)))\n{ ${LOAD} }`, false],
  ["a call with groups inside", `f((a), (b))\n{ ${LOAD} }`, false],
  ["a nested call", `g(h(1))\n{ ${LOAD} }`, false],
  ["a call chain", `f(a)(b)(c)\n{ ${LOAD} }`, false],
  ["void group", `void (0)\n{ ${LOAD} }`, false],
  ["if with a nested condition", `if ((a) && (b))\n{ ${LOAD} }`, false],
  ["a function head with nested defaults", `function f(a = (1), b = g((2)))\n{ return arguments[0] }\nf()`, true],
  ["an async function head", `async function f(a, b = (1))\n{ return arguments[0] }\nf()`, true],
  ["a generator head", `function* f(a)\n{ return arguments[0] }\nf()`, true],
  ["a same-line body", `function f(a, b = (1)) { return arguments[0] }\nf()`, true],
  ["a same-line block after a group", `if ((a)) { ${LOAD} }`, false],
  ["a method of an object", `const o = { m((a), b)\n{ return arguments[0] } }; o.m()`, true],
  ["a class method", `class A { m(a = (1))\n{ return arguments[0] } }`, true],
  ["a group in a string", `x = "(((("; f(1)\n{ ${LOAD} }`, false],
  ["a function head after many groups", `a((1)); b((2)); function f(x)\n{ return arguments[0] }\nf()`, true],
];
for (const [name, src, expected] of ROWS) {
  test(`verdict: ${name}`, () => {
    expect(provablyStatic(src)).toBe(expected);
    expect(processHazard(src)).toBe(!expected);
  });
}

// Unbalanced parens: not provably static, and a file the scan cannot read is always a hazard.
for (const [name, src] of [
  ["a close without an open", `)\n{ ${LOAD} }`],
  ["an open without a close", `(\n{ ${LOAD} }`],
  ["a group after a close", `() )\n{ ${LOAD} }`],
  ["a group after an extra open", `( ()\n{ ${LOAD} }`],
] as const) {
  test(`verdict: ${name}`, () => {
    expect(provablyStatic(src)).toBe(false);
    expect(processHazard(src)).toBe(true);
  });
}

// A long parameter list still reads as a function head: the walk is not bounded, so the body's own arguments is the function's.
test("a function with 10,000 parameters and a next-line body that reads arguments stays static", () => {
  const params = Array.from({ length: 10000 }, (_, i) => `a${i}`).join(", ");
  const src = `function f(${params})\n{ return arguments[0] }\nf()\n`;
  expect(provablyStatic(src)).toBe(true);
});

test("a call with 10,000 arguments and a next-line block that reads arguments is the module wrapper's", () => {
  const args = Array.from({ length: 10000 }, (_, i) => `a${i}`).join(", ");
  const src = `f(${args})\n{ ${LOAD} }\n`;
  expect(provablyStatic(src)).toBe(false);
});

// The same verdicts on both sides of many groups: the table of matches is built over the whole file once.
test("a function head and a call statement after thousands of closed groups keep their kinds", () => {
  const filler = "g((a), (b));\n".repeat(5000);
  expect(provablyStatic(`${filler}function f(x)\n{ return arguments[0] }\nf()\n`)).toBe(true);
  expect(provablyStatic(`${filler}f(1)\n{ ${LOAD} }\n`)).toBe(false);
});

// Shapes with a ) before a { at depth: each must read in linear time.
const SHAPES: [string, (n: number) => string][] = [
  ["nested groups before next-line blocks", (n) => "x = " + "(".repeat(n / 4) + "0" + ")\n{}".repeat(n / 4)],
  ["nested groups before same-line blocks", (n) => "x = " + "(".repeat(n / 4) + "0" + "){}".repeat(n / 4)],
  ["nested conditions", (n) => "if " + "(".repeat(n / 4) + "1" + ")".repeat(n / 4) + "\n{}\n"],
  ["nested calls with blocks", (n) => "g(f(h(1)))\n{}\n".repeat(n / 14)],
  ["a long parameter list", (n) => "function f(" + "a,".repeat(n / 2) + "z)\n{ return arguments[0] }\n"],
  ["a call chain", (n) => "f" + "(a)".repeat(n / 3) + "\n{}"],
];
const time = (src: string, run: (s: string) => unknown): number => {
  const t0 = performance.now();
  run(src);
  return performance.now() - t0;
};
for (const [name, make] of SHAPES) {
  test(`128 KiB of ${name} reads in under 1 s`, () => {
    expect(time(make(128 * 1024), (s) => classifyJs("pkg/lib/x.js", s))).toBeLessThan(1000);
  });
  test(`8 MB of ${name} reads in under 10 s`, () => {
    expect(time(make(8 * 1024 * 1024), (s) => classifyJs("pkg/lib/x.js", s))).toBeLessThan(10000);
    expect(time(make(8 * 1024 * 1024), (s) => provablyStatic(s))).toBeLessThan(10000);
  }, 60000);
}
