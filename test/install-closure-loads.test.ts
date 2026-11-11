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
