import { describe, expect, test } from "bun:test";
import { classifyJs, holdsWriteSpawn, installView } from "../src/install-closure.ts";
import { prepass, type FileMap } from "../src/prepass.ts";

// OUP-334: a file that writes to a loader surface (a start file or .bin through any file-system binding, a PATH write, a prototype write on a module root)
// and starts a process or loads code is held, whatever the spelling. The hold is its own record (wsFiles): the other files of the package are files the release
// shows, and the reach, the tier flags and every detail the other rules compute stay exactly as they were. The spawns here name an absolute literal command,
// so the older rules that look for a write beside a spawn of an unknown command do not hold them.
const enc = (s: string) => new TextEncoder().encode(s);
const files = (o: Record<string, string>): FileMap => new Map(Object.entries(o).map(([k, v]) => [k, enc(v)]));
const details = (old: FileMap, now: FileMap) => prepass("npm", old, now).hard.filter((s) => s.kind === "install-script").map((s) => s.detail);

// lib/x.js is the hook file (unchanged); deep/other.js is in no folder the hook file names and changes between the releases.
const release = (v: string, body: string) =>
  files({
    "package.json": JSON.stringify({ name: "p", version: "1.0." + v, scripts: { postinstall: "node lib/x.js" } }),
    "lib/x.js": body,
    "deep/other.js": `console.log("other ${v}")\n`,
  });
const held = (body: string) => details(release("0", body), release("1", body)).includes("file deep/other.js");
const CP = `const cp = require("child_process");\n`;
const FS = `const fs = require("fs");\n`;
const RUN = `cp.execSync("/bin/ls");\n`;

describe("a write to a loader surface beside a start holds the package files (each row goes red with the rule off)", () => {
  test.each([
    ["a start file appended", `${FS}${CP}fs.appendFileSync(process.env.HOME + "/.bashrc", "x");\n${RUN}`],
    ["an npmrc written", `${FS}${CP}fs.writeFileSync(".npmrc", "x");\n${RUN}`],
    ["sitecustomize written", `${FS}${CP}fs.writeFileSync("sitecustomize.py", "x");\n${RUN}`],
    ["a renamed destructured member", `const { writeFileSync: w } = require("fs");\n${CP}w(".zshrc", "x");\n${RUN}`],
    ["the binding handed to a helper", `${FS}${CP}helper(fs, ".profile");\n${RUN}`],
    ["fs/promises", `const fsp = require("fs/promises");\n${CP}fsp.writeFile("x.pth", "import os");\n${RUN}`],
    ["promises taken by destructuring and renamed", `const { promises: fsp } = require("fs");\n${CP}fsp.writeFile(".bashrc", "x");\n${RUN}`],
    ["promises imported under another name", `import { promises as fsp } from "node:fs";\nimport { execSync } from "node:child_process";\nfsp.writeFile(".bashrc", "x");\nexecSync("/bin/ls");\n`],
    ["a name bound to fs.promises", `${FS}${CP}const p = fs.promises;\np.writeFile(".npmrc", "x");\n${RUN}`],
    ["an inline load of fs", `${CP}require("fs").writeFileSync(".bashrc", "x");\n${RUN}`],
    ["a NODE_OPTIONS file", `${FS}${CP}fs.writeFileSync(".env", "NODE_OPTIONS=--require ./x.js");\n${RUN}`],
    ["an import of fs", `import fs from "node:fs";\nimport { execSync } from "node:child_process";\nfs.rmSync(".bashrc");\nexecSync("/bin/ls");\n`],
    ["a usercustomize file", `${FS}${CP}fs.writeFileSync("usercustomize.py", "x");\n${RUN}`],
    ["a login profile", `${FS}${CP}fs.writeFileSync(process.env.HOME + "/.zprofile", "x");\n${RUN}`],
    ["Reflect.defineProperty on the module constructor", `${CP}Reflect.defineProperty(module.constructor, "prototype", { value: 1 });\n${RUN}`],
    ["__proto__ on the module constructor", `${CP}module.constructor.__proto__ = {};\n${RUN}`],
    ["a module root's prototype with a _load call as the only start", `module.constructor.prototype.__proto__ = module.constructor;\nmodule.constructor.prototype._load(__dirname + "/../da" + "ta/h.js", null, false);\n`],
    ["the binding handed on after another argument", `${FS}${CP}helper(0, fs, ".profile");\n${RUN}`],
    ["the binding handed on inside an object", `${FS}${CP}helper({ fs }, ".profile");\n${RUN}`],
    ["a name bound to the binding", `${FS}${CP}const f = fs;\nf.writeFileSync(".profile", "x");\n${RUN}`],
    ["a default and a named import of fs", `import _, { writeFileSync as w } from "node:fs";\nimport { execSync } from "node:child_process";\nw(".profile", "x");\nexecSync("/bin/ls");\n`],
    ["a default import and promises under another name", `import _, { promises as fsp } from "node:fs";\nimport { execSync } from "node:child_process";\nfsp.writeFile(".profile", "x");\nexecSync("/bin/ls");\n`],
    ["a comma declarator", `const cp = require("child_process"), fs = require("fs");\nfs.writeFileSync(".profile", "x");\ncp.execSync("/bin/ls");\n`],
    ["a member taken from require(fs).promises", `const { writeFile } = require("fs").promises;\n${CP}writeFile(".profile", "x");\n${RUN}`],
    ["an awaited import of fs/promises", `const fsp = await import("node:fs/promises");\n${CP}fsp.writeFile(".profile", "x");\n${RUN}`],
    ["an awaited import of fs", `const fs = await import("fs");\n${CP}fs.writeFileSync(".profile", "x");\n${RUN}`],
    ["an inline awaited import of fs", `${CP}(await import("fs")).writeFileSync(".profile", "x");\n${RUN}`],
    ["module.require of fs", `const fs = module.require("fs");\n${CP}fs.writeFileSync(".profile", "x");\n${RUN}`],
    ["_load through call on a module root's prototype", `module.constructor.prototype.__proto__ = module.constructor;\nconst P = module.constructor.prototype;\nP._load.call(P, __dirname + "/../da" + "ta/h.js", null, false);\n`],
    ["_load through apply on a module root's prototype", `module.constructor.prototype.__proto__ = module.constructor;\nconst P = module.constructor.prototype;\nP._load.apply(P, ["./h.js"]);\n`],
    ["a prototype write through a name bound to the module builtin", `const M = require("module");\n${CP}M.prototype._load = function () {};\n${RUN}`],
    ["a prototype write through an imported module builtin", `import Module from "node:module";\nimport { execSync } from "node:child_process";\nObject.defineProperty(Module.prototype, "_compile", { value: 1 });\nexecSync("/bin/ls");\n`],
    ["a default import beside a read-only named import of fs", `import fs, { constants } from "node:fs";\nimport { execSync } from "node:child_process";\nfs.writeFileSync(".bashrc", "x");\nexecSync("/bin/ls");\n`],
    ["fs.promises of an awaited import bound to a name", `const p = (await import("node:fs")).promises;\n${CP}p.writeFile(".profile", "x");\n${RUN}`],
    ["a keyed hand-off of the binding", `${FS}${CP}helper({ f: fs }, ".profile");\n${RUN}`],
    ["a keyed hand-off of the binding under its own name", `${FS}${CP}helper({ fs: fs }, ".profile");\n${RUN}`],
    ["a renamed member taken from the binding", `${FS}${CP}const { writeFileSync: w } = fs;\nw(".profile", "x");\n${RUN}`],
    ["a member taken from fs.promises", `${FS}${CP}const { writeFile } = fs.promises;\nwriteFile(".profile", "x");\n${RUN}`],
    ["a member taken from a nested promises pattern", `const { promises: { writeFile } } = require("fs");\n${CP}writeFile(".profile", "x");\n${RUN}`],
    ["fs.promises handed on", `${FS}${CP}helper(fs.promises, ".profile");\n${RUN}`],
    ["setPrototypeOf on the module constructor", `${CP}Object.setPrototypeOf(module.constructor, {});\n${RUN}`],
    ["_load through an optional call", `module.constructor.prototype.__proto__ = module.constructor;\nconst P = module.constructor.prototype;\nP._load?.call(P, "./h.js");\n`],
    ["_load through bind", `module.constructor.prototype.__proto__ = module.constructor;\nconst P = module.constructor.prototype;\nP._load.bind(P)("./h.js");\n`],
    ["a chain of two names bound to the binding", `${FS}${CP}const f = fs;\nconst g = f;\ng.writeFileSync(".profile", "x");\n${RUN}`],
    ["a default import with a namespace import of fs", `import x, * as y from "node:fs";\nimport { execSync } from "node:child_process";\ny.writeFileSync(".profile", "x");\nexecSync("/bin/ls");\n`],
    ["a prototype write on require.main's constructor", `${CP}require.main.constructor.prototype = {};\n${RUN}`],
    ["Reflect.set of prototype on the module constructor", `${CP}Reflect.set(module.constructor, "prototype", {});\n${RUN}`],
    ["a vm load as the only start", `${FS}fs.writeFileSync(".bashrc", "x");\nconst vm = require("vm");\n`],
    ["a cluster load as the only start", `${FS}fs.writeFileSync(".bashrc", "x");\nconst c = require("cluster");\n`],
    ["a worker_threads load as the only start", `${FS}fs.writeFileSync(".bashrc", "x");\nconst w = require("worker_threads");\n`],
    ["a default and a namespace import of fs, written through the default", `import fs, * as ns from "node:fs";\nimport { execSync } from "node:child_process";\nfs.writeFileSync(".bashrc", "x");\nexecSync("/bin/ls");\n`],
    ["a minified namespace import of fs", `import*as f from"fs";\nimport{execSync}from"node:child_process";\nf.writeFileSync(".bashrc","x");\nexecSync("/bin/ls");\n`],
    ["a minified default and namespace import of fs", `import fs,*as ns from"fs";\nimport{execSync}from"node:child_process";\nfs.writeFileSync(".bashrc","x");\nexecSync("/bin/ls");\n`],
    ["_load through an optional call with no other start", `module.constructor.prototype.__proto__ = module.constructor;\nconst P = module.constructor.prototype;\nP._load?.("./h.js");\n`],
    ["a write on a name bound through getBuiltinModule", `const M = process.getBuiltinModule("module");\n${CP}M.prototype._load = function () {};\n${RUN}`],
    ["a write on a name bound through an awaited import", `const M = await import("node:module");\n${CP}M.prototype._load = function () {};\n${RUN}`],
    ["a write on a namespace import of the module builtin", `import * as M from "node:module";\nimport { execSync } from "node:child_process";\nM.prototype._load = function () {};\nexecSync("/bin/ls");\n`],
    ["a minified default and named import of fs", `import f,{a}from"fs";\nimport{execSync}from"node:child_process";\nf.writeFileSync(".bashrc","x");\nexecSync("/bin/ls");\n`],
    ["a minified namespace import of the module builtin", `import*as M from"node:module";\nimport{execSync}from"node:child_process";\nM.prototype._load=function(){};\nexecSync("/bin/ls");\n`],
    ["a minified default and namespace import of the module builtin", `import D,*as M from"module";\nimport{execSync}from"node:child_process";\nM.prototype._load=function(){};\nexecSync("/bin/ls");\n`],
    ["_load through an optional call with a space", `module.constructor.prototype.__proto__ = module.constructor;\nconst P = module.constructor.prototype;\nP._load?. ("./h.js");\n`],
    ["a function named await that writes through its argument", `${FS}${CP}function await(m) { m.writeFileSync(".bashrc", "x"); }\nawait(fs);\n${RUN}`],
    ["a vm load beside a start-file write", `${FS}const vm = require("vm");\nfs.writeFileSync(".bashrc", "x");\nvm.runInThisContext("1");\n`],
  ])("%s", (_n, body) => expect(held(body)).toBe(true));
});

// These spellings are already held by main (its older rules hold them, with the rule off too): the rule adds nothing for them, so they are a separate count,
// not evidence for the rule. They stay as the fail-closed spelling list.
describe("already held by main: the older rules hold these with the rule off", () => {
  test.each([
    ["a prototype on the module constructor through a string key", `${CP}const C = module["constructor"];\nC.prototype = {};\n${RUN}`],
    ["a __proto__ write on a name bound to process.mainModule", `${CP}const m = process.mainModule;\nm.__proto__ = {};\n${RUN}`],
    ["the binding called", `${FS}${CP}fs(".profile");\n${RUN}`],
    ["a computed member", `${FS}${CP}const k = "write" + "FileSync";\nfs[k]("node_modules/.bin/ls", "x");\n${RUN}`],
    ["a prototype key on the main module's constructor through a destructured name", `${CP}const { constructor: C } = require.main;\nC.prototype = {};\n${RUN}`],
    ["a PATH write", `${CP}process.env.PATH = "bin:" + process.env.PATH;\n${RUN}`],
    ["a PATH key of an env option", `${CP}cp.execFileSync("/bin/ls", [], { env: { PATH: "bin" } });\n`],
    ["a PATH write beside a vm run (no child-process word)", `const vm = require("vm");\nprocess.env.PATH = "bin:" + process.env.PATH;\nvm.runInThisContext("1");\n`],
    ["a PATH assign of the environment beside a spawn", `Object.assign(process.env, { PATH: "bin" });\nrequire("child_process").spawnSync("/bin/ls");\n`],
  ])("%s", (_n, body) => expect(held(body)).toBe(true));
});

describe("controls: the same parts without the pair stay released", () => {
  test.each([
    ["a plain file write beside a start", `${FS}${CP}fs.writeFileSync("out.txt", "x");\n${RUN}`],
    ["a prototype on a class beside a start", `${CP}function F() {}\nF.prototype = {};\n${RUN}`],
    ["a class prototype and a type: \"module\" string beside a start", `${CP}function F() {}\nF.prototype = {};\nconst o = { type: "module" };\n${RUN}`],
    ["a class prototype beside the module builtin imported for createRequire and a start", `import { createRequire } from "node:module";\nimport { execSync } from "node:child_process";\nclass Foo {}\nFoo.prototype = {};\nconst r = createRequire(import.meta.url);\nexecSync("/bin/ls");\n`],
    ["a read of the module builtin's prototype beside a start", `const M = require("module");\n${CP}const c = M.prototype._compile;\nconst d = M.__proto__;\n${RUN}`],
    ["a typeof check of an imported module builtin's prototype beside a start", `import Module from "node:module";\nimport { execSync } from "node:child_process";\nif (typeof Module.prototype._compile === "function") console.log(1);\nexecSync("/bin/ls");\n`],
    ["fs.read, fs.Stats and fs.globSync beside a loader-surface name and a start", `${FS}${CP}fs.read(0, Buffer.alloc(1), 0, 1, 0, cb);\nconst s = new fs.Stats();\nfs.globSync("node_modules/.bin/*");\n${RUN}`],
    ["the binding in the head of if, while and switch", `${FS}${CP}fs.readFileSync(".profile");\nif (fs) { x(); }\nwhile (fs) { y(); }\nswitch (fs) { }\nfunction g() { return (fs); }\nconst t = typeof (fs);\n${RUN}`],
    ["a read-only file-system use beside a start", `${FS}${CP}fs.readFileSync(".bashrc");\n${RUN}`],
    ["a start-file write with no start", `${FS}fs.appendFileSync(".bashrc", "x");\nconst r = require.resolve(x);\n`],
    ["a start with no write", `${CP}${RUN}`],
    ["a start-file name that is only read as text", `${CP}const s = ".bashrc";\n${RUN}`],
    ["a profile member of an options object beside a write and a start", `${FS}${CP}fs.mkdirSync("out");\nconst on = opts.profile;\n${RUN}`],
    // A file with nothing dynamic in it is never read by the scan; this one has a resolve call so it is read, and its exec( is a member call of something that is no child process.
    ["a regex exec beside a loader-name write", `${FS}fs.writeFileSync(".bashrc", "x");\nconst r = require.resolve(x);\nre.exec("a");\n`],
  ])("%s", (_n, body) => expect(held(body)).toBe(false));
});

// Additive only: every detail the package gets without the rule is still there, and the tier flags are the ones the other rules set.
describe("the rule adds its own hold and leaves the other readings alone", () => {
  const HOOK = `const fs = require("fs");\nconst cp = require("child_process");\nfs.writeFileSync(".npmrc", "x");\ncp.execSync("/bin/ls");\n`;
  test("a retarget the hook's evaluated code reads stays held", () => {
    const rel = (b: string) => files({
      "package.json": JSON.stringify({ name: "x", version: "1.0.0", scripts: { postinstall: `node hook.js && node -e "require('./sub/' + process.platform)"` } }),
      "hook.js": HOOK, "sub/loader.js": `require("./nested");\n`, "sub/nested/package.json": JSON.stringify({ main: `../../lib/${b}.js` }),
      "lib/a.js": "module.exports = 1;\n", "lib/b.js": "module.exports = 2;\n",
    });
    const d = details(rel("a"), rel("b"));
    expect(d).toContain("file lib/a.js");
    expect(d).toContain("file lib/b.js");
    expect(installView(rel("a")).wsFiles).toContain("lib/a.js");
  });
  test("a glob cap detail stays beside the file the rule adds", () => {
    const rel = (c: string) => files({
      "package.json": JSON.stringify({ name: "x", version: "1", scripts: { postinstall: "node hook.js && node a?b" } }),
      "hook.js": HOOK, "lib/y.js": c,
    });
    const d = details(rel("1\n"), rel("2\n"));
    expect(d).toContain("glob");
    expect(d).toContain("file lib/y.js");
  });
  test("a doc the hook names stays in the gyp file set", () => {
    const view = installView(files({
      "package.json": JSON.stringify({ name: "x", version: "1", scripts: { postinstall: "node hook.js README.md" } }),
      "binding.gyp": `{'targets':[{'target_name':'a','sources':['<!(node hook.js)']}]}`,
      "README.md": "x", "hook.js": HOOK,
    }));
    expect(view.gypFiles).toContain("README.md");
    expect(view.wsFiles).toContain("hook.js");
  });
  test("the tier flags are the ones the other rules set", () => {
    const t = classifyJs("lib/x.js", `${FS}${CP}fs.writeFileSync(".npmrc", "x");\n${RUN}`);
    expect([t.all, t.pkg, t.tests, t.flows, t.same]).toEqual([false, false, false, false, false]);
    expect(holdsWriteSpawn("lib/x.js", `${FS}${CP}fs.writeFileSync(".npmrc", "x");\n${RUN}`)).toBe(true);
  });
  test("a file that is held whole already adds nothing to the record", () => {
    const body = `${FS}${CP}fs.writeFileSync(".npmrc", "x");\n${RUN}require(process.argv[2]);\n`;
    expect(details(release("0", body), release("1", body))).toEqual(["file deep/other.js"]);
    expect(installView(release("0", body)).wsFiles).toEqual([]);
  });
  // The hook line reaches the file through the stage pass (a pipe), through the old backslash reading only (a file name with a backslash), and a doc stays out.
  const WS = `${FS}${CP}fs.writeFileSync(".npmrc", "x");\n${RUN}const r = require.resolve(x);\n`;
  const pkg = (v: string, post: string, o: Record<string, string> = {}) => files({ "package.json": JSON.stringify({ name: "p", version: "1." + v, main: "lib/x.js", scripts: { postinstall: post } }), ...o });
  test("a hook file the stage pass reads holds", () => {
    const r = (v: string) => pkg(v, "node . | cat", { "lib/x.js": WS, "deep/other.js": "o" + v });
    expect(details(r("0"), r("1"))).toContain("file deep/other.js");
  });
  test("a hook file only the old backslash reading reads holds", () => {
    const r = (v: string) => pkg(v, "node lib\\x.js", { "lib\\x.js": WS, "deep/other.js": "o" + v });
    expect(details(r("0"), r("1"))).toContain("file deep/other.js");
  });
  test("a doc that changes beside a hook file is no detail", () => {
    const r = (v: string) => pkg(v, "node lib/x.js", { "lib/x.js": WS, "deep/other.js": "o", "README.md": "r" + v });
    expect(details(r("0"), r("1"))).toEqual([]);
    expect(installView(r("0")).wsFiles).toEqual(["deep/other.js", "lib/x.js"]);
  });
  test("the narrow reading leaves the record empty", () => {
    const v = installView(pkg("0", "node lib/x.js && node a?b", { "lib/x.js": WS, "deep/other.js": "o" }));
    expect(v.narrow?.wsFiles).toEqual([]);
    expect(v.wsFiles).toContain("deep/other.js");
  });
});

// The patterns run in linear time: a run of spaces or thousands of bindings or lines must not cost the product of the two. The small size is long enough to
// measure, and the big one has an absolute bound too, so a ratio cannot hide a slow rule.
const fastest = (f: () => void): number => {
  let best = Infinity;
  for (let i = 0; i < 3; i++) {
    const t = performance.now();
    f();
    best = Math.min(best, performance.now() - t);
  }
  return best;
};
describe("the rule is linear in the size of the file", () => {
  test.each([
    ["spaces after prototype", (n: number) => `module.constructor.prototype${" ".repeat(n)}+ 1;\n`],
    ["spaces in a prototype bracket", (n: number) => `x.prototype${" ".repeat(n)}]${" ".repeat(n)}`],
    ["spaces in a destructured fs import", (n: number) => `const {${" ".repeat(n)}a${" ".repeat(n)}} = require("fs");\n`],
    ["spaces after .PATH", (n: number) => `${FS}${CP}process.env.PATH${" ".repeat(n)}+ "x";\n`],
    ["many file-system bindings", (n: number) => Array.from({ length: n / 8 }, (_, i) => `const f${i} = require("fs"); f${i}.readFileSync(1);`).join("\n")],
    ["many calls of the binding, the matching one last", (n: number) => `${FS}${"g(x, 1);\n".repeat(n / 4)}g(fs, 1);\n`],
  ])("%s", (_n, make) => {
    // Absolute bounds, no floor: a pattern that is quadratic in the run takes seconds at these sizes.
    for (const n of [64000, 256000]) {
      const big = fastest(() => classifyJs("lib/x.js", make(n)));
      expect(big, `${n} chars: ${big.toFixed(0)} ms`).toBeLessThan(1500);
    }
  }, 30_000);
});

// A run of word characters is read by every pattern that starts on an identifier: each of them has a lookbehind, so a start inside the run fails at once. The bound is
// absolute (a quadratic pattern takes tens of seconds at these sizes; a linear one tens of milliseconds), so no floor can hide it.
describe("a long run of word characters costs linear time", () => {
  test.each([
    ["one word", (n: number) => "a".repeat(n)],
    ["one word after an equals sign", (n: number) => `x = ${"a".repeat(n)}`],
    ["a long hex string literal beside a start", (n: number) => `const b = Buffer.from("${"ab".repeat(n / 2)}", "hex");\nexecSync(process.argv[2]);\n`],
    ["a long name after an fs load", (n: number) => `${FS}${"f".repeat(n)}`],
    ["a run of $import", (n: number) => "$import".repeat(n / 7)],
    ["import$import_ repeated", (n: number) => "import$import_".repeat(n / 14)],
    ["import followed by a long name", (n: number) => `import ${"a$".repeat(n / 2)}`],
    ["import followed by spaces and commas", (n: number) => `import a${" ".repeat(n)},${" ".repeat(n)}`],
    ["a run of import words", (n: number) => "import a, ".repeat(n / 10)],
    ["a long default import name", (n: number) => `import ${"a".repeat(n)} from "node:module";\n`],
  ])("%s", (_n, make) => {
    for (const n of [64000, 256000]) {
      const t = performance.now();
      classifyJs("lib/x.js", make(n));
      const ms = performance.now() - t;
      expect(ms, `${n} chars: ${ms.toFixed(0)} ms`).toBeLessThan(1000);
    }
  }, 30_000);
  test("a hook file with a long hex string through the whole view", () => {
    const t = performance.now();
    installView(files({ "package.json": JSON.stringify({ name: "p", version: "1", scripts: { postinstall: "node lib/x.js" } }), "lib/x.js": `const b = Buffer.from("${"ab".repeat(32000)}", "hex");\nexecSync(process.argv[2]);\n` }));
    expect(performance.now() - t).toBeLessThan(1000);
  }, 30_000);
});

describe("a record on one side only holds", () => {
  const WS = `const fs = require("fs");\nconst cp = require("child_process");\nfs.writeFileSync(".npmrc", "x");\ncp.execSync("/bin/ls");\nconst r = require.resolve(x);\n`;
  const PLAIN = `const cp = require("child_process");\ncp.execSync("/bin/ls");\nconst r = require.resolve(x);\n`;
  const rel = (v: string, hook: string, other: string) => files({ "package.json": JSON.stringify({ name: "p", version: "1." + v, scripts: { postinstall: "node lib/x.js" } }), "lib/x.js": hook, "deep/other.js": other });
  test("only the old release has a hook file with the pair", () => {
    expect(details(rel("0", WS, "a"), rel("1", PLAIN, "b"))).toContain("file deep/other.js");
  });
  test("only the new release has a hook file with the pair", () => {
    expect(details(rel("0", PLAIN, "a"), rel("1", WS, "b"))).toContain("file deep/other.js");
  });
});

describe("the module receiver and the inline fs load read the file once", () => {
  test("160,000 spaces after a literal fs load", () => {
    const t = performance.now();
    classifyJs("lib/x.js", `require("fs")${" ".repeat(160000)};\nconst r = require.resolve(x);`);
    expect(performance.now() - t).toBeLessThan(1000);
  });
  test("20,000 bindings of the module builtin", () => {
    const body = Array.from({ length: 20000 }, (_, i) => `const m${i}=require("module");`).join("\n");
    const t = performance.now();
    classifyJs("lib/x.js", body);
    expect(performance.now() - t).toBeLessThan(1000);
  }, 30_000);
  test("55,000 bindings of the module builtin keep main's glob detail", () => {
    const big = Array.from({ length: 55000 }, (_, i) => `const m${i}=require("module");`).join("\n");
    const rel = (v: string) => files({ "package.json": JSON.stringify({ name: "p", version: "1." + v, scripts: { postinstall: "node big.js && node a?b" } }), "big.js": big, "README.md": "r" + v });
    expect(details(rel("0"), rel("1"))).toEqual(["glob"]);
  }, 30_000);
});
