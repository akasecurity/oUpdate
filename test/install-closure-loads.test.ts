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
