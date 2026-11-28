import { expect, test } from "bun:test";
import { prepass, type FileMap } from "../src/prepass.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const files = (o: Record<string, string>): FileMap => new Map(Object.entries(o).map(([k, v]) => [k, enc(v)]));
const holds = (a: FileMap, b: FileMap): boolean => prepass("npm", a, b).hard.some((s) => s.kind === "install-script");
const WRITER = `const cp = require("child_process");\nconst args = ["./local.js"];\nargs[0] = decodeURIComponent("docs%2Fchanged.js");\ncp.spawnSync(process.execPath, args);\n`;

// The bin stamp is compared only when the install runs something (src/prepass.ts `installRuns`). Each row is one way it can, and moves a bin between two byte-identical writer files, so
// the stamp alone holds the release. A row runs three ways: the entry on both sides, only on the old side and only on the new one. What each way pins differs:
//  - both sides: the pair of terms for that entry (old and new). Dropping a whole term turns its row red (hook, gyp, files, otherInstallEntry: see the mutants in the commit message).
//  - one side only: for the entries that live in package.json or add a file (a hook, gypfile, prebuild.test, a gyp below the root) the entry is itself a change between the two versions, and
//    another comparison holds the release, so dropping the term of one side alone turns no row red. That is not pinned here; only otherInstallEntry's two sides are (its rows go red per side).
// The control, the same bin move with no install entry, releases.
const pkg = (side: 0 | 1, extra: Record<string, unknown>) => JSON.stringify({ name: "p", version: side ? "1.0.1" : "1.0.0", bin: { p: side ? "y.js" : "x.js" }, ...extra });
const side = (s: 0 | 1, extra: Record<string, unknown>, more: Record<string, string>): FileMap =>
  files({ "package.json": pkg(s, extra), "x.js": WRITER, "y.js": WRITER, "docs/changed.js": "console.log(2)\n", "local.js": "1\n", ...more });
const moved = (has: [boolean, boolean], extra: Record<string, unknown>, more: Record<string, string>) =>
  holds(side(0, has[0] ? extra : {}, has[0] ? more : {}), side(1, has[1] ? extra : {}, has[1] ? more : {}));

const GYP = JSON.stringify({ targets: [{ target_name: "t", actions: [{ action_name: "a", action: ["echo", "hi"], inputs: [], outputs: ["o"] }] }] });
const ROWS: [string, Record<string, unknown>, Record<string, string>][] = [
  ["an install hook that does not name the writers", { scripts: { postinstall: "echo hi" } }, {}],
  ["a root gypfile: true with no binding.gyp", { gypfile: true }, {}],
  ["a bundled dependency with an install hook", {}, { "node_modules/d/package.json": JSON.stringify({ name: "d", version: "1.0.0", scripts: { postinstall: "echo hi" } }) }],
  // gypfile: false turns the implicit build off, so the view reads no gyp and no file: only the bundled binding.gyp (otherInstallEntry) makes the install run.
  ["a bundled dependency with a binding.gyp (gypfile: false, no gyp read)", { gypfile: false }, { "node_modules/d/binding.gyp": "{}" }],
  ["a manifest field that names a file the view reads (prebuild.test)", { prebuild: { test: "x.js" } }, {}],
  ["a binding.gyp below the root (read by the view, no other entry)", {}, { "deps/binding.gyp": GYP }],
];
for (const [label, extra, more] of ROWS)
  for (const [where, has] of [["both sides", [true, true]], ["the old side only", [true, false]], ["the new side only", [false, true]]] as [string, [boolean, boolean]][])
    test(`a bin moved between two writer files holds when the install runs only ${label}: ${where}`, () => {
      expect(moved(has, extra, more)).toBe(true);
    });
test("control: the same bin move with no install entry releases", () => {
  expect(moved([false, false], {}, {})).toBe(false);
});
