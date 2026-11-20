import { expect, test } from "bun:test";
import { classifyJs, pathScanCount } from "../src/install-closure.ts";
import { prepass } from "../src/prepass.ts";

// The names bound to the path module are read off a file once, not once per alias: a pass per alias reads the whole file again for each of
// them, which grows with the square of the file (24,000 aliases, 709 KB: 56 s). The passes made must not grow with the aliases, and the tier of
// the statement after them is the one main gives.
const NONE = { all: false, pkg: false, tests: false, flows: false, same: false, dirs: [] as string[], lits: [] as string[] };
const aliases = (n: number): string => Array.from({ length: n }, (_, i) => `const f${i}=require("path")\n`).join("");
const shapes: [string, string, unknown][] = [
  ["a join through a name bound to the module", 'const p7=require("path");\nrequire(p7.join(__dirname, "a.js"));\n', { ...NONE, lits: ["lib/a.js"] }],
  ["a join stored in a name", 'const p7=require("path"); const j7 = p7.join;\nrequire(j7(__dirname, "a.js"));\n', { ...NONE, pkg: true, tests: true, flows: true }],
  ["a join taken out of a bound name by a pattern", 'const q7=require("path"); const { join: j7 } = q7;\nrequire(j7(__dirname, "a.js"));\n', { ...NONE, pkg: true, tests: true, flows: true }],
];
const run = (tail: string, n: number): { passes: number; tier: unknown } => {
  const before = pathScanCount();
  const tier = classifyJs("lib/x.js", aliases(n) + tail);
  return { passes: pathScanCount() - before, tier };
};
for (const [name, tail, tier] of shapes) {
  test(`${name} costs the same passes over the file at ten times the aliases`, () => {
    const small = run(tail, 100);
    const large = run(tail, 1000);
    expect(small.tier).toEqual(tier);
    expect(large.tier).toEqual(tier);
    expect(small.passes).toBeGreaterThan(0);
    expect(large.passes).toBeLessThanOrEqual(small.passes);
  });
}

// A pass that reads every name at once must still skip a statement that starts inside text an earlier match of the same name read: a name that ends
// in a keyword (p$var) holds one, and a pattern out of that name in an inert string must not bind a join. With one, the call below counts as a
// join of a path and the release stops holding the files only the docs changed in.
const enc = (s: string) => new TextEncoder().encode(s);
const release = (v: string, hook: string) =>
  new Map(
    Object.entries({
      "package.json": JSON.stringify({ name: "p", version: v, scripts: { preinstall: "node lib/hook.js" } }),
      "lib/hook.js": hook,
      "README.md": `readme ${v}\n`,
      "docs/guide.md": `guide ${v}\n`,
    }).map(([k, t]) => [k, enc(t)]),
  );
const held = (hook: string): string[] => prepass("npm", release("1.0.0", hook), release("1.0.1", hook)).hard.map((r) => r.detail);
const BOTH = ["file README.md", "file docs/guide.md"];
const joins: [string, string][] = [
  [
    "a pattern inside a string after a name that ends in a keyword",
    'const p$var = require("path"); const s = "const {join} = p$var{resolve: r} = p$var"; function r(a, b) { return a + "/../../evil"; } require(r(process.cwd(), "x.js"));\n',
  ],
  ["the same file without the string", 'const p$var = require("path"); function r(a, b) { return a + "/../../evil"; } require(r(process.cwd(), "x.js"));\n'],
  // The filter: a name that is not the path module binds no join, however the statement reads.
  ["a join taken out of a name that is not the path module", 'const q = require("path"); const other = require("fs"); const { join } = other; require(join(process.cwd(), "x.js"));\n'],
  ["a join stored from a name that is not the path module", 'const q = require("path"); const other = require("fs"); const j = other.join; require(j(process.cwd(), "x.js"));\n'],
];
for (const [name, hook] of joins) {
  test(`${name} holds the files the hook can reach`, () => {
    expect(held(hook)).toEqual(BOTH);
  });
}

// The per-name resume: a match of a name is skipped only when it starts inside text an earlier match of that same name read, and a skipped
// match does not move the resume point. Each row binds a join through a pattern read out of an inert string, so a join that was wrongly skipped
// turns the literal require below into a widened one (all: true) instead of lits ["lib/a.js"].
const chains: [string, string][] = [
  [
    "a chain of three patterns on one name that ends in a keyword",
    'const p$var = require("path"); const s = "const {a} = p$var{b} = p$var{join} = p$var"; require(join(__dirname, "a.js"));\n',
  ],
  [
    "two names interleaved: the pattern is out of the name another pattern did not read",
    'const q$var = require("path"); const p = require("path"); const s = "const {a} = q$var{join} = p"; require(join(__dirname, "a.js"));\n',
  ],
  [
    "a name that is not bound before a bound one",
    'const p = require("path"); const s = "const {a} = other$var{join} = p"; require(join(__dirname, "a.js"));\n',
  ],
];
for (const [name, src] of chains) {
  test(`${name} binds the join`, () => {
    const tier = classifyJs("lib/x.js", src);
    expect(tier.lits).toEqual(["lib/a.js"]);
    expect(tier.all).toBe(false);
  });
}
