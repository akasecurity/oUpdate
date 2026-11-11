import { expect, test } from "bun:test";
import { prepass, type FileMap } from "../src/prepass.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const files = (o: Record<string, string>): FileMap => new Map(Object.entries(o).map(([k, v]) => [k, enc(v)]));
const holds = (old: FileMap, now: FileMap) => prepass("npm", old, now).hard.filter((s) => s.kind === "install-script").map((s) => s.detail);

// A hook file loads lib/evil.js through an argument that is built, not spelled. Only lib/evil.js changes between the releases.
const release = (v: string, hook: string, changed = "lib/evil.js") =>
  files({
    "package.json": JSON.stringify({ name: "p", version: v, scripts: { postinstall: "node h.js" } }),
    "h.js": hook,
    "lib/a.js": "module.exports = 1\n",
    "lib/evil.js": changed === "lib/evil.js" ? `console.log("evil ${v}")\n` : "console.log('evil')\n",
    "docs/payload.txt": changed === "docs/payload.txt" ? `payload ${v}\n` : "payload\n",
  });

const built: [string, string][] = [
  ["a join of an array literal", `require(["./lib/", "evil"].join(""))`],
  ["a join of an array literal in a dynamic import", `import(["./lib/", "evil"].join(""))`],
  ["a join of an array literal in require.resolve", `require.resolve(["./lib/", "evil"].join(""))`],
  ["a joined string held by a name", `const p = ["./lib/", "evil"].join(""); require(p)`],
  ["a joined string held by a name and reassigned", `let p = "./lib/a"; p = ["./lib/", "evil"].join(""); require(p)`],
  ["a string concatenated and held by a name", `const p = "./lib/" + ["evil"].join(""); require(p)`],
  ["createRequire(...) called with a joined string", `const { createRequire } = require("module"); createRequire(__filename)(["./lib/", "evil"].join(""))`],
  ["a name bound to createRequire(...)", `const { createRequire } = require("module"); const r = createRequire(__filename); r(["./lib/", "evil"].join(""))`],
  ["a name bound to require", `const r = require; r(["./lib/", "evil"].join(""))`],
  ["module.require with a joined string", `module.require(["./lib/", "evil"].join(""))`],
  ["a joined string with a call result as the receiver", `require("./lib/x/evil".split("x/").join(""))`],
];

for (const [label, code] of built) {
  test(`${label} reads the package: the changed lib/evil.js holds`, () => {
    expect(holds(release("1.0.0", code), release("1.0.1", code)).length).toBeGreaterThan(0);
  });
}

const controls: [string, string][] = [
  ["a literal path", `require("./lib/a")`],
  ["two literals joined with +", `require("./lib/" + "a")`],
  ["path.join of literals", `const path = require("path"); require(path.join(__dirname, "lib", "a"))`],
  ["a name held literal", `const p = "./lib/a"; require(p)`],
  ["a parameter that is never called at install", `exports.main = (x) => require(x)`],
];

for (const [label, code] of controls) {
  test(`${label} stays on its file: a changed lib/evil.js or docs file is not an install change`, () => {
    expect(holds(release("1.0.0", code), release("1.0.1", code))).toEqual([]);
    expect(holds(release("1.0.0", code, "docs/payload.txt"), release("1.0.1", code, "docs/payload.txt"))).toEqual([]);
  });
}

// Several assignments, an alias next to an unresolved load, require handed on as a value, a process argument vector.
// scripts/h.js is the hook; only the file named in `changed` differs between the releases.
const nested = (v: string, hook: string, changed: string) =>
  files({
    "package.json": JSON.stringify({ name: "p", version: v, scripts: { postinstall: "node scripts/h.js" } }),
    "scripts/h.js": hook,
    "scripts/lib/a.js": "module.exports = 1\n",
    "scripts/evil.js": changed === "scripts/evil.js" ? `console.log("evil ${v}")\n` : "console.log('evil')\n",
    "x/evil.js": changed === "x/evil.js" ? `console.log("evil ${v}")\n` : "console.log('evil')\n",
  });
const PATH = `const path = require("path"); const name = "a"; `;
const later: [string, string, string][] = [
  ["a later assignment that loads another file", PATH + `let p = path.join(__dirname, "lib", name); p = atob("Li9ldmlsLmpz"); require(p);`, "scripts/evil.js"],
  ["an earlier directory restriction and a later joined string", PATH + `let p = path.join(__dirname, "lib", name); p = ["./ev", "il.js"].join(""); require(p);`, "scripts/evil.js"],
  ["an alias call that restricts and a load of an unresolved parameter", PATH + `const r = require; r(path.join(__dirname, "lib", name)); function go(x) { require(x); } go(atob("Li9ldmlsLmpz"));`, "scripts/evil.js"],
  ["require handed on as a value", `["../x/evil"].map(require)`, "x/evil.js"],
  ["import handed on as a value", `["../x/evil"].map((m) => import(m)); [import].length`, "x/evil.js"],
  ["a process argument vector with a built element", `require("child_process").spawnSync("node", [["x/ev", "il.js"].join("")])`, "x/evil.js"],
];
for (const [label, code, changed] of later) {
  test(`${label} holds the changed ${changed}`, () => {
    expect(holds(nested("1.0.0", code, changed), nested("1.0.1", code, changed)).length).toBeGreaterThan(0);
  });
}
test("one restricting assignment keeps its directory; the unrelated changed file does not hold", () => {
  const code = PATH + `let p = path.join(__dirname, "lib", name); p = path.join(__dirname, "lib", name + "x"); require(p);`;
  expect(holds(nested("1.0.0", code, "x/evil.js"), nested("1.0.1", code, "x/evil.js"))).toEqual([]);
});

// Second review batch. Root layout: hook h.js at the package root, docs and lib beside it.
const rootRel = (v: string, hook: string, changed: string) =>
  files({
    "package.json": JSON.stringify({ name: "p", version: v, scripts: { postinstall: "node h.js" } }),
    "h.js": hook,
    "lib/a.js": "module.exports = 1\n",
    "lib/index.js": "module.exports = 2\n",
    "lib/evil.js": changed === "lib/evil.js" ? `console.log("evil ${v}")\n` : "console.log('evil')\n",
    "docs/index.js": changed === "docs/index.js" ? `console.log("evil ${v}")\n` : "console.log('evil')\n",
    "docs/payload.js": changed === "docs/payload.js" ? `console.log("evil ${v}")\n` : "console.log('evil')\n",
  });
const rootHolds = (hook: string, changed: string) => holds(rootRel("1.0.0", hook, changed), rootRel("1.0.1", hook, changed)).length > 0;
const nestHolds = (hook: string, changed: string) => holds(nested("1.0.0", hook, changed), nested("1.0.1", hook, changed)).length > 0;
const P = `const path = require("path");`;

for (const [label, hook, changed] of [
  ["path?.join with a built segment", P + ` require(path?.join(__dirname, sub + "/" + name))`, "docs/payload.js"],
  ["(path).join with a built segment", P + ` require((path).join(__dirname, sub + "/" + name))`, "docs/payload.js"],
  ["require(\"path/win32\").join with a built segment", `require(require("path/win32").join(__dirname, sub + "/" + name))`, "docs/payload.js"],
  ["a template path require with a built segment", "require(require(`path`).join(__dirname, sub + \"/\" + name))", "docs/payload.js"],
  ["path?.join naming a docs file when another index.js exists", P + ` require(path?.join(__dirname, "docs", "index.js"))`, "docs/index.js"],
] as [string, string, string][]) {
  test(`${label} keeps the precise path reading, so the changed ${changed} holds`, () => expect(rootHolds(hook, changed)).toBe(true));
}

for (const [label, hook] of [
  ["a name holding a literal head and a built tail", `const x = process.argv[2]; const p = "./lib/" + x; require(p)`],
  ["an alias of require with a literal head", `const r = require; r("./lib/" + process.argv[2])`],
  ["createRequire(f) with a literal head", `const { createRequire } = require("module"); createRequire(__filename)("./lib/" + process.argv[2])`],
  ["require.resolve with a literal head", `require.resolve("./lib/" + process.argv[2])`],
] as [string, string][]) {
  test(`${label} keeps the hook's own folder: a changed scripts/evil.js holds`, () => expect(nestHolds(hook, "scripts/evil.js")).toBe(true));
}

test("200 reassignments between names finish in bounded time, in a small file and in one over 1 MB", () => {
  const body = `let p = "./lib/a";\n` + Array.from({ length: 200 }, (_, i) => `p = q${i}; q${i} = p;\n`).join("") + `require(p);\n`;
  const big = body + "// " + "x".repeat(1_100_000) + "\n";
  for (const hook of [body, big]) {
    const t0 = performance.now();
    holds(nested("1.0.0", hook, "scripts/evil.js"), nested("1.0.1", hook, "scripts/evil.js"));
    expect(performance.now() - t0).toBeLessThan(4000);
  }
});

const ATOB = `atob("Li9ldmlsLmpz")`;
const ATOB_X = `atob("Li4veC9ldmlsLmpz")`;
const later2: [string, string, string][] = [
  ["a later assignment inside a branch", PATH + `let p = path.join(__dirname, "lib", name); if (process.env.X) p = ${ATOB}; require(p);`, "scripts/evil.js"],
  ["a require of a parameter called with an unresolved value", PATH + `require(path.join(__dirname, "lib", name)); function go(x) { require(x); } go(${ATOB});`, "scripts/evil.js"],
  ["an arrow that requires its parameter, called with an unresolved value", PATH + `require(path.join(__dirname, "lib", name)); const go = (x) => require(x); go(${ATOB});`, "scripts/evil.js"],
  ["a later assignment, target in another folder", PATH + `let p = path.join(__dirname, "lib", name); p = ${ATOB_X}; require(p);`, "x/evil.js"],
  ["an alias call and a parameter load, target in another folder", PATH + `const r = require; r(path.join(__dirname, "lib", name)); function go(x) { require(x); } go(${ATOB_X});`, "x/evil.js"],
  ["a literal then a join of pieces", `let p = "./lib/" + "a"; p = ["./lib/", "evil"].join(""); require(p)`, "lib/evil.js"],
  ["an alias three deep", `const a = require; const b = a; const c = b; c(["./lib/", "evil"].join(""))`, "lib/evil.js"],
  ["a value that starts on the line after the =", `const p =\n  ["./lib/", "evil"].join("");\nrequire(p)`, "lib/evil.js"],
  ["a destructured name", `const { p } = JSON.parse(process.argv[2]); require(p)`, "lib/evil.js"],
  ["+= with a built right side", `let p = "./lib/"; p += process.argv[2]; require(p)`, "lib/evil.js"],
  ["a join of literals that spells a docs file", `require(["./do", "cs/payload.js"].join(""))`, "docs/payload.js"],
  ["a name receiver that is a list, not the path module", `const parts = ["./lib/", "evil"]; require(parts.join(""))`, "lib/evil.js"],
  ["cluster.setupPrimary with an exec built from pieces", `const c = require("cluster"); c.setupPrimary({ exec: ["../x/", "evil.js"].join("") })`, "x/evil.js"],
];
for (const [label, hook, changed] of later2) {
  test(`${label} holds the changed ${changed}`, () => {
    const mk = changed === "scripts/evil.js" || changed === "x/evil.js" ? nestHolds : rootHolds;
    expect(mk(hook, changed)).toBe(true);
  });
}

for (const [label, hook] of [
  ["+= on a literal name", PATH + `let p = path.join(__dirname, "lib", name); p += "evil"; require(p);`],
  ["two separate names", PATH + `const p = path.join(__dirname, "lib", name); const q = ${ATOB}; require(p); require(q);`],
  ["an alias plus a direct non-literal require", PATH + `const r = require; r(path.join(__dirname, "lib", name)); require(${ATOB});`],
  ["an alias plus import()", PATH + `const r = require; r(path.join(__dirname, "lib", name)); import(${ATOB});`],
] as [string, string][]) {
  test(`${label} still holds the changed scripts/evil.js`, () => expect(nestHolds(hook, "scripts/evil.js")).toBe(true));
}
