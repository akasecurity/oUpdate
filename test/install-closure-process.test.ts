import { expect, test } from "bun:test";
import { prepass, type FileMap } from "../src/prepass.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const files = (o: Record<string, string>): FileMap => new Map(Object.entries(o).map(([k, v]) => [k, enc(v)]));
const holds = (old: FileMap, now: FileMap) => prepass("npm", old, now).hard.filter((s) => s.kind === "install-script").map((s) => s.detail);

// prisma 7.10.1: an unchanged preinstall whose only builtin is node:process took every file of the package as its closure.
// Its bundled ANSI code holds a RegExp exec whose argument has a "+", which the process-runner check read as a computed command.
const ansi = 'exports.code = (D, f) => { let d = /\\d[^m]*/.exec(D.slice(f, f + 18)); return d && d.length > 0 ? d[0] : "" }\n';
const release = (v: string, preinstall: string) =>
  files({
    "package.json": JSON.stringify({ name: "cli", version: v, bin: { cli: "build/index.js" }, scripts: { preinstall: "node scripts/preinstall-entry.js" } }),
    "scripts/preinstall-entry.js": "let p\ntry { p = require('../preinstall/index.js') } catch (e) {}\nif (p) p.main()\n",
    "preinstall/index.js": preinstall,
    "build/index.js": `console.log("cli ${v}")\n`,
    "build/engine_bg.wasm": `wasm ${v}`,
  });

test("a hook whose static require graph needs only node:process keeps that graph: changed build files are not install changes", () => {
  const pre = 'var v = require("node:process"); exports.main = () => { if (v.versions.node < "18") v.exit(1) }\n' + ansi;
  expect(holds(release("1.0.0", pre), release("1.0.1", pre))).toEqual([]);
});

test("the same hook with an eval of a computed value still takes the wide closure, so the changed build files hold", () => {
  const pre = 'var v = require("node:process"); exports.main = () => eval(v.env.X)\n';
  expect(holds(release("1.0.0", pre), release("1.0.1", pre)).length).toBeGreaterThan(0);
});

test("a changed file in the static graph still holds", () => {
  const pre = (n: string) => `var v = require("node:process"); exports.main = () => v.exit(${n})\n` + ansi;
  expect(holds(release("1.0.0", pre("0")), release("1.0.1", pre("1")))).toEqual(["file preinstall/index.js"]);
});

// A name for the process module used for more than plain reads can load code the reviewer never sees: the changed build files hold.
// Not static means the hook's own directory is in the closure: an unrelated file changed there holds, which a static graph does not.
const held = (pre: string) => {
  const rel = (v: string) => release(v, pre).set("preinstall/other.js", enc(`module.exports = "${v}"\n`));
  return holds(rel("1.0.0"), rel("1.0.1")).length > 0;
};
for (const [label, pre] of [
  ["a required process module calling binding", 'var v = require("node:process"); exports.main = () => v.binding("spawn_sync").spawn({})\n'],
  ["require(process).binding without a name for it", 'exports.main = () => require("process").binding("spawn_sync")\n'],
  ["a named import of binding from node:process", 'import { binding } from "node:process"; export const main = () => binding("spawn_sync")\n'],
  ["a computed member on a required process module", 'const p = require("process"); exports.main = () => p["bind"+"ing"]("spawn_sync")\n'],
  ["the process module passed to another call", 'const p = require("process"); exports.main = () => run(p)\n'],
] as const) {
  test(`${label} is not static: its directory is in the closure`, () => expect(held(pre)).toBe(true));
}
test("plain reads through a required process module stay static", () => {
  const pre = 'const v = require("node:process"); exports.main = () => { if (v.versions.node < "18") v.stderr.write("old"); return v.cwd() }\n';
  expect(held(pre)).toBe(false);
});

// Node resolves a path as a file first and as a directory second: both are in the closure.
test("a path that reads as helper.js and as helper/index.js has both in the closure", () => {
  const pre = 'var v = require("node:process"); require("./helper"); exports.main = () => v.exit(0)\n';
  const rel = (v: string, helper: string) => release(v, pre).set("preinstall/helper.js", enc(helper)).set("preinstall/helper/package.json", enc('{"main":"index.js"}')).set("preinstall/helper/index.js", enc("module.exports = 1\n"));
  expect(holds(rel("1.0.0", "module.exports = 1\n"), rel("1.0.1", "module.exports = 2\n"))).toContain("file preinstall/helper.js");
});

// A string literal with an escape names the file the escape spells.
test("a require with an escaped path is followed to the file it names", () => {
  const pre = 'var v = require("node:process"); require("./\\x65vil.js"); exports.main = () => v.exit(0)\n';
  const rel = (v: string, evil: string) => release(v, pre).set("preinstall/evil.js", enc(evil));
  expect(holds(rel("1.0.0", "module.exports = 1\n"), rel("1.0.1", "module.exports = 2\n"))).toContain("file preinstall/evil.js");
});
