import { expect, test } from "bun:test";
import { classifyJs, provablyStatic } from "../src/install-closure.ts";
import { prepass, type FileMap } from "../src/prepass.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const files = (o: Record<string, string>): FileMap => new Map(Object.entries(o).map(([k, v]) => [k, enc(v)]));
// An unchanged postinstall hook; only lib/evil.js and lib/evil.mjs change between the releases.
const release = (v: string, hook: string) =>
  files({
    "package.json": JSON.stringify({ name: "p", version: v, scripts: { postinstall: "node h.js" } }),
    "h.js": hook,
    "lib/a.js": "module.exports = 1\n",
    "build.js": "module.exports = 2\n",
    "lib/evil.js": `console.log("evil ${v}")\n`,
    "lib/evil.mjs": `console.log("evil ${v}")\n`,
  });
const held = (hook: string) => prepass("npm", release("1.0.0", hook), release("1.0.1", hook)).hard.some((s) => s.kind === "install-script");

const J = `["./lib/", "evil"].join("")`;
const JM = `["./lib/", "evil.mjs"].join("")`;

const loaders: [string, string][] = [
  ["Module._load with a built path", `require("module")._load(${J})`],
  ["Module._load through a bracket", `require("module")["_load"](${J})`],
  ["_load of a destructured name", `const { _load } = require("module"); _load(${J})`],
  ["module.constructor through a bracket", `module.constructor["_load"](${J})`],
  ["module.register with a built path", `require("module").register(${JM})`],
  ["register imported by name", `import { register } from "node:module"; register(${JM}, import.meta.url)`],
  ["register through a bracket", `const M = require("module"); M["register"](${JM})`],
  ["register held as a value", `const r = require("module").register; r(${JM})`],
  ["node:test run with built files (require)", `require("node:test").run({ files: [${J}] })`],
  ["node:test run with built files (import)", `import { run } from "node:test"; run({ files: [${J}] })`],
  ["node:test run through an alias", `import { run as r } from "node:test"; r({ files: [${J}] })`],
  ["node:test default export .run", `const test = require("node:test"); test.run({ files: [${J}] })`],
  ["cluster settings object with a built exec", `const c = require("cluster"); c.settings = { exec: ${J} }; c.fork()`],
  ["cluster named through a variable", `const n = "cluster"; const c = require(n); c.setupPrimary({ exec: ${J} }); c.fork()`],
  ["cluster settings destructured, exec assigned bare", `const { settings } = require("cluster"); settings.exec = ${J}; require("cluster").fork()`],
  ["cluster settings through a with block", `with (require("cluster")) { settings.exec = ${J}; fork() }`],
  ["cluster settings assigned on the load itself", `require("cluster").settings = { exec: ${J} }; require("cluster").fork()`],
  ["cluster settings exec through a bracket key", `const { settings } = require("cluster"); settings["exec"] = ${J}; require("cluster").fork()`],
  ["cluster.setupPrimary with a built exec", `const c = require("cluster"); c.setupPrimary({ exec: ${J} }); c.fork()`],
];
for (const [name, hook] of loaders) {
  test(`a loader with a non-literal target holds the changed file: ${name}`, () => {
    expect(held(hook)).toBe(true);
  });
}

// The same loader code in a file the install hook or the package root runs: the hook file at the package root, a hook that requires a
// nested loader file, a preinstall hook. The changed file is under lib/ or test/ (docs/ is left out by design: a literal-free docs load is not followed).
const place = (hookPath: string, hookSrc: string, scripts: Record<string, string>, extra: Record<string, string>) => (v: string, changed: string) => {
  const base: Record<string, string> = { "package.json": JSON.stringify({ name: "p", version: v, scripts }), "index.js": "console.log('idx')\n", ...extra, [hookPath]: hookSrc };
  for (const d of ["lib", "test"]) base[`${d}/evil.js`] = changed === `${d}/evil.js` ? `console.log("evil ${v}")\n` : "console.log('evil')\n";
  return files(base);
};
const heldAt = (hookPath: string, hookSrc: string, scripts: Record<string, string>, extra: Record<string, string>, changed: string) => {
  const m = place(hookPath, hookSrc, scripts, extra);
  return prepass("npm", m("1.0.0", changed), m("1.0.1", changed)).hard.some((s) => s.kind === "install-script");
};
const rooted: [string, (t: string) => string][] = [
  ["Module._load through a bracket", (t) => `require("module")["_load"](${t})`],
  ["node:test run (require)", (t) => `require("node:test").run({ files: [${t}] })`],
  ["node:test run (import)", (t) => `import { run } from "node:test"; run({ files: [${t}] })`],
  ["node:test run through an alias", (t) => `import { run as r } from "node:test"; r({ files: [${t}] })`],
  ["node:test default export .run", (t) => `const test = require("node:test"); test.run({ files: [${t}] })`],
  ["cluster settings object with a built exec", (t) => `const c = require("cluster"); c.settings = { exec: ${t} }; c.fork()`],
  ["cluster settings destructured, exec assigned bare", (t) => `const { settings } = require("cluster"); settings.exec = ${t}; require("cluster").fork()`],
  ["cluster settings through a with block", (t) => `with (require("cluster")) { settings.exec = ${t}; fork() }`],
  ["cluster named through a variable", (t) => `const n = "cluster"; const c = require(n); c.setupPrimary({ exec: ${t} }); c.fork()`],
];
for (const [name, code] of rooted) {
  for (const dir of ["lib", "test"]) {
    const t = `["./${dir}/", "evil"].join("")`;
    const changed = `${dir}/evil.js`;
    test(`${name}: the loader in the package-root file the hook runs holds ${changed}`, () => {
      expect(heldAt("index.js", code(t), { postinstall: "node index.js" }, {}, changed)).toBe(true);
    });
    test(`${name}: the loader in a nested file the hook requires holds ${changed}`, () => {
      expect(heldAt("h.js", `require("./sub/loader.js")\n`, { postinstall: "node h.js" }, { "sub/loader.js": code(t) }, changed)).toBe(true);
    });
    test(`${name}: the loader in a preinstall hook holds ${changed}`, () => {
      expect(heldAt("h.js", code(t), { preinstall: "node h.js" }, {}, changed)).toBe(true);
    });
  }
}

// Benign hook files that name one of the builtins and use one of the member words without loading a file: only lib/evil.js changes and the
// hook must not widen to it.
const benign: [string, string][] = [
  ["a local function named run beside node:test", `const test = require("node:test"); function run() { return 42 }; console.log(run())`],
  ["a local object named module with a settings key", `const module = { settings: 1 }; console.log("module", module.settings)`],
  ["a read of cluster settings", `const c = require("cluster"); console.log(c.settings)`],
  ["a register package and a sourceType string", `require("@babel/register")({ sourceType: "module" }); require("./build.js")`],
  ["a type check and a settings variable", `const pkg = require("./package.json"); if (pkg.type === "module") console.log(1); const settings = { color: true }; console.log(settings)`],
  ["a settings file name", `fs.writeFileSync(".vscode/settings.json", "{}")`],
  ["a settings file name beside a module require", `const m = require("module"); require("fs").writeFileSync(".vscode/settings.json", "{}"); console.log(m.builtinModules.length)`],
];
for (const [name, hook] of benign) {
  test(`a benign hook is not widened: ${name}`, () => {
    expect(held(hook)).toBe(false);
  });
  test(`a benign hook file is not a package-wide loader: ${name}`, () => {
    const t = classifyJs("h.js", `${hook}\n`);
    expect([t.pkg, t.tests, t.flows]).toEqual([false, false, false]);
  });
}
for (const stmt of [`require("_stream_wrap")`, `require("node:_stream_wrap")`, `import "_stream_wrap"`, `import { a } from "node:_stream_wrap"`]) {
  test(`${stmt} is not static (it reaches net)`, () => {
    expect(provablyStatic(`${stmt}\nexports.main = () => 1\n`)).toBe(false);
  });
}

// Member words that are not a load of a file: a string that holds a bracket key, a read of a member, a receiver that is not the builtin.
const benign2: [string, string][] = [
  ["a bracket key inside a string beside cluster", `const c = require("cluster"); console.log('x["settings"]')`],
  ["a bracket key inside a string beside node:test", `require("node:test"); console.log('x["run"]')`],
  ["a read of a member named run", `const t = require("node:test"); const o = { run: 42 }; console.log(o.run)`],
  ["a read of a member named register", `require("cluster"); const o = { register: 1 }; console.log(o.register)`],
  ["a settings assignment in a class beside a module string", `class Store { constructor() { this.settings = {} } }; if (pkg.type === "module") console.log(new Store())`],
  ["service worker register with a module type", `navigator.serviceWorker.register("/sw.js", { type: "module" })`],
  ["a register call on another package beside a module string", `require("ts-node").register(); const t = { type: "module" }`],
  ["a plugin register with a module string", `fastify.register(plugin); const t = "module"`],
  ["a method named register beside a module string", `const o = { register(x) { return x } }; o.register(1); const t = "module"`],
  ["a run of another receiver beside node:test", `require("node:test"); db.prepare("select 1").run()`],
  ["a run of a package receiver beside node:test", `const db = require("better-sqlite3"); require("node:test"); db.run("select 1")`],
  ["a settings assignment on another receiver beside cluster", `const c = require("cluster"); const o = {}; o.settings = 1; console.log(c.isPrimary)`],
];
for (const [name, hook] of benign2) {
  test(`a benign hook is not widened: ${name}`, () => {
    expect(held(hook)).toBe(false);
    const t = classifyJs("h.js", `${hook}\n`);
    expect([t.pkg, t.tests, t.flows]).toEqual([false, false, false]);
  });
}

// The trigger reads the text once: a long benign text must not cost more than a small multiple of reading it.
const timed = (src: string) => {
  const start = performance.now();
  classifyJs("h.js", src);
  return performance.now() - start;
};
const shapes: [string, (n: number) => string][] = [
  ["braces in one string beside node:test", (n) => `const t = require("node:test"); console.log("${"{".repeat(n)}")\n`],
  ["nested open braces with run beside node:test", (n) => `require("node:test"); ${"{ run; ".repeat(n / 6)}${"}".repeat(n / 6)}\n`],
  ["brackets in a string beside cluster", (n) => `const c = require("cluster"); console.log("${'["'.repeat(n / 2)}")\n`],
  ["many bound names beside module", (n) => `const a = require("module");\n${"const x = require(n);\n".repeat(n / 22)}`],
];
for (const [name, make] of shapes) {
  test(`reading a long text stays linear: ${name}`, () => {
    timed(make(1 << 16));
    const small = Math.max(timed(make(1 << 16)), 5);
    const big = timed(make(1 << 20));
    expect(big).toBeLessThan(small * 16 * 4 + 400);
  });
}

test("a file that names none of these builtins and only uses the words run and register is not widened", () => {
  expect(held(`const registry = { register(x) { return x } }; function run() { return 1 }; registry.register(run()); run()\n`)).toBe(false);
  expect(held(`const s = "settings"; const t = "test"; module.exports = { run: () => s + t }\n`)).toBe(false);
});

// Underscore builtins are node builtins too: _http_* and _tls_* can run code, so they are not plain package names.
for (const mod of ["_http_agent", "_http_client", "_http_common", "_http_incoming", "_http_outgoing", "_http_server", "_tls_common", "_tls_wrap", "node:_http_server"]) {
  test(`a load of ${mod} is not static`, () => {
    for (const stmt of [`require("${mod}")`, `import "${mod}"`, `import { a } from "${mod}"`, `export * from "${mod}"`])
      expect(provablyStatic(`${stmt}\nexports.main = () => 1\n`)).toBe(false);
  });
}
for (const mod of ["_stream_duplex", "_stream_passthrough", "_stream_readable", "_stream_transform", "_stream_writable", "stream", "fs", "lodash"]) {
  test(`a load of ${mod} stays static`, () => {
    for (const stmt of [`require("${mod}")`, `import "${mod}"`, `import { a } from "${mod}"`])
      expect(provablyStatic(`${stmt}\nexports.main = () => 1\n`)).toBe(true);
  });
}
