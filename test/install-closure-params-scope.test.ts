import { expect, test } from "bun:test";
import { prepass, type FileMap } from "../src/prepass.ts";
import { setJsScanSteps } from "../src/install-closure.ts";
import { allowFaults } from "./fault-guard.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const files = (o: Record<string, string>): FileMap => new Map(Object.entries(o).map(([k, v]) => [k, enc(v)]));
const release = (v: string, body: string): FileMap =>
  files({
    "package.json": JSON.stringify({ name: "p", version: v, scripts: { postinstall: "node lib/x.js" } }),
    "lib/x.js": body,
    "lib/a.js": "module.exports = 1\n",
    "docs/evil.js": `console.log("evil ${v}")\n`,
  });
const held = (body: string): boolean => prepass("npm", release("1.0.0", body), release("1.0.1", body)).hard.some((s) => s.kind === "install-script");
const D = `decodeURIComponent("..%2Fdocs%2Fevil.js")`;
const N = `var n = "../lib/" + ${D};\n`;

for (const [label, body] of [
  ["a function elsewhere binds the same name with a plain default", `${N}function g(n, q = 1) {}\nrequire(n);\n`],
  ["an if condition with a string parenthesis holds the name", `${N}if (log(n, "(")) {}\nrequire(n);\n`],
  ["an arrow function elsewhere binds the same name", `${N}const g = (n, q = 1) => q;\nrequire(n);\n`],
  ["a catch clause elsewhere binds the same name", `${N}try { f(); } catch (n) {}\nrequire(n);\n`],
  ["a single-name arrow elsewhere binds the same name", `${N}const g = n => n;\nrequire(n);\n`],
  ["resolve of the name", `${N}function g(n, q = 1) {}\nrequire.resolve(n);\n`],
] as [string, string][]) {
  test(`${label}: the bare-name load outside the function is held`, () => {
    expect(held(body)).toBe(true);
  });
}

// Controls: what is kept, and why. A load of a bare name that has no value in the file (`require(x)`, a parameter read inside its own function, or a name
// from outside) is left to the existing handling, as before: the release rested on "no value here", which this change does not touch. Only a name that
// also has a value here (an assignment) is read as that value, so a parameter of the same name elsewhere no longer lends it a release.
for (const [label, body] of [
  ["a parameter read inside its own function", `function g(n, q = 1) { return require(n); }\ng(1);\n`],
  ["a bare name with no value and no function", `require(n);\n`],
  ["an arrow parameter read inside its own function", `const g = (n) => require(n);\ng(1);\n`],
] as [string, string][]) {
  test(`control: ${label} is not held`, () => {
    expect(held(body)).toBe(false);
  });
}

// Bounds (absolute, no floor): long runs of one word and of `$` names in parameter lists and before the load.
for (const size of [64_000, 256_000]) {
  for (const [label, filler] of [
    ["one long word", "w".repeat(size)],
    ["a run of $ names", "$a, ".repeat(size / 4)],
    ["a long run of parameter lists", "function g(n, q = 1) {}\n".repeat(size / 24)],
  ] as [string, string][]) {
    test(`${label} at ${size} bytes: the bare-name load is held within 5 s`, () => {
      const body = `${N}function h(${label === "a long run of parameter lists" ? "" : filler.slice(0, 200)}n) {}\n${label === "a long run of parameter lists" ? filler : `var z = "${filler}";\n`}require(n);\n`;
      const t0 = performance.now();
      const r = held(body);
      const ms = performance.now() - t0;
      expect(ms).toBeLessThan(5000);
      expect(r).toBe(true);
    });
  }
}

// The boundary of the scan limit: `var n = f(); function g(n) {} require(n);` is held at 951 and 952 steps, whichever of the two ways it is held (the
// hold fires before the cap: the `scanner fault` detail is replaced by a file hold at the few limits where it does; held either way).
const heldAt = (limit: number, body: string): boolean => {
  setJsScanSteps(limit);
  try {
    return held(body);
  } finally {
    setJsScanSteps(undefined);
  }
};
for (const limit of [951, 952]) {
  test(`var n = f(); function g(n) {} require(n); is held at a scan limit of ${limit}`, () => {
    allowFaults();
    expect(heldAt(limit, `var n = f();\nfunction g(n) {}\nrequire(n);\n`)).toBe(true);
  });
}

// The price: shapes the old reading released and this one holds (a false hold: the load is of a constant, but a name of the same spelling is bound
// by a parameter list). Each asserts HELD, so a later narrowing is deliberate.
for (const [label, body] of [
  ["a parameter default that is a literal path", `function d(n = "./a") { return require(n); }\n`],
  ["an arrow parameter default that is a literal path", `const f = (m = "./a") => require(m);\n`],
  ["a parameter assigned a literal in the function", `function load(name) { name = "./a.js"; return require(name); }\n`],
  ["a constant name bound again as a parameter elsewhere", `const name = "./a.js"; function load(name) { return require(name); }\n`],
] as [string, string][]) {
  test(`false hold (stated): ${label} is held`, () => {
    expect(held(body)).toBe(true);
  });
}

// Real unsafe cases inside the function that the head now holds.
for (const [label, body] of [
  ["a parameter assigned a dynamic path in the function", `function r(n) { n = "../lib/" + ${D}; return require(n); }\n`],
  ["a parameter whose default is a dynamic path", `function r(n = "../lib/" + ${D}) { return require(n); }\n`],
  ["a destructured parameter whose default is dynamic", `function r({ n = ${D} }) { return require(n); }\n`],
] as [string, string][]) {
  test(`unsafe in-function load: ${label} is held`, () => {
    expect(held(body)).toBe(true);
  });
}
