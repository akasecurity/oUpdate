import { expect, test } from "bun:test";
import { classifyJs, provablyStatic } from "../src/install-closure.ts";
import { prepass, type FileMap } from "../src/prepass.ts";

// A hook that starts an import declaration is an ES module: its package says so, and it has no require.
const isEsm = (src: string) => /(?:^|[;\n])\s*import\s+[\w{*"']/.test(src);
const enc = (s: string) => new TextEncoder().encode(s);
const files = (o: Record<string, string>): FileMap => new Map(Object.entries(o).map(([k, v]) => [k, enc(v)]));
// An unchanged postinstall hook; only lib/evil.js and lib/evil.mjs change between the releases.
const release = (v: string, hook: string) =>
  files({
    "package.json": JSON.stringify({ name: "p", version: v, ...(isEsm(hook) ? { type: "module" } : {}), scripts: { postinstall: "node h.js" } }),
    "h.js": hook,
    "lib/a.js": "module.exports = 1\n",
    "build.js": "module.exports = 2\n",
    "lib/evil.js": `console.log("evil ${v}")\n`,
    "lib/evil.mjs": `console.log("evil ${v}")\n`,
  });
const held = (hook: string) => prepass("npm", release("1.0.0", hook), release("1.0.1", hook)).hard.some((s) => s.kind === "install-script");

const J = `["./lib/", "evil"].join("")`;
const JM = `require("url").pathToFileURL(__dirname + "/lib/evil.mjs").href`;
const JM_ESM = `new URL("./lib/evil.mjs", import.meta.url).href`;

const loaders: [string, string][] = [
  ["Module._load with a built path", `require("module")._load(${J})`],
  ["Module._load through a bracket", `require("module")["_load"](${J})`],
  ["_load of a destructured name", `const { _load } = require("module"); _load(${J})`],
  ["module.constructor through a bracket", `module.constructor["_load"](${J})`],
  ["module.register with a built path", `require("module").register(${JM})`],
  ["register imported by name", `import { register } from "node:module"; register(${JM_ESM}, import.meta.url)`],
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
  ["module.register in a string given to eval", `const M = require("module"); const T = ${JM}; eval("M.register(T)")`],
  ["cluster.setupPrimary in a string given to eval", `const c = require("cluster"); const T = ${J}; eval("c.setupPrimary({ exec: T })"); c.fork()`],
  ["cluster settings.exec in a string given to eval", `const c = require("cluster"); const T = ${J}; eval("c.settings.exec = T"); c.fork()`],
  ["module._load in a string given to vm.runInNewContext", `const vm = require("vm"); const J = ${J}; vm.runInNewContext("M._load(p)", { M: require("module"), p: J })`],
  ["module._load in a string given to vm.compileFunction", `const vm = require("vm"); const J = ${J}; vm.compileFunction("M._load(p)", ["M", "p"])(require("module"), J)`],
  ["module._load in a string given to vm.runInThisContext", `const vm = require("vm"); globalThis.M = require("module"); globalThis.J = ${J}; vm.runInThisContext("M._load(J)")`],
  ["module._load in a string given to a vm Script", `const vm = require("vm"); globalThis.M = require("module"); globalThis.J = ${J}; new vm.Script("M._load(J)").runInThisContext()`],
  ["Reflect.get of _load after padding strings", `const M = require("module"); const pad = "xxxxxxxxxx"; const T = ${J}; Reflect.get(M, "_load")(T); console.log(T, M)`],
  ["module.constructor.register beside a cluster load", `require("cluster"); module.constructor.register(${JM})`],
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
  const base: Record<string, string> = { "package.json": JSON.stringify({ name: "p", version: v, ...(isEsm(hookSrc) ? { type: "module" } : {}), scripts }), "index.js": "console.log('idx')\n", ...extra, [hookPath]: hookSrc };
  for (const d of ["lib", "test"]) for (const ext of ["js", "mjs"]) base[`${d}/evil.${ext}`] = changed === `${d}/evil.${ext}` ? `console.log("evil ${v}")\n` : "console.log('evil')\n";
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
  ["a read of a member named register", `require("module"); const o = { register: 1 }; console.log(o.register)`],
  ["a settings assignment in a class beside a module string", `class Store { constructor() { this.settings = {} } }; if (pkg.type === "module") console.log(new Store())`],
  ["service worker register with a module type", `navigator.serviceWorker.register("/sw.js", { type: "module" })`],
  ["a register call on another package beside a module string", `require("ts-node").register(); const t = { type: "module" }`],
  ["a plugin register with a module string", `fastify.register(plugin); const t = "module"`],
  ["a method named register beside a module string", `const o = { register(x) { return x } }; o.register(1); const t = "module"`],
  ["a run of another receiver beside node:test", `require("node:test"); db.prepare("select 1").run()`],
  ["a run of a package receiver beside node:test", `const db = require("better-sqlite3"); require("node:test"); db.run("select 1")`],
  ["a bracket read of cluster settings", `const c = require("cluster"); console.log(c["settings"])`],
  ["a bracket key of module inside a string", `require("cluster"); console.log('module["_load"]')`],
  ["a bracket key of constructor inside a string", `require("cluster"); console.log('constructor["register"]')`],
  ["a usage message that names a settings key", `const c = require("cluster"); log('usage: get(c, "settings")')`],
  ["a cluster binding and a settings string given to console.log", `const c = require("cluster"); console.log(c, "settings")`],
  ["a padded cluster binding and a settings string given to console.log", `const c = require("cluster"); const pad = "xxxxxxxxxx"; console.log(pad, c, "settings")`],
  ["a test of a module member in an if", `const M = require("module"); if (M.register) console.log(1)`],
  ["a negated module member", `const m = require("module"); console.log(!!m._load)`],
  ["a copy from cluster settings", `const c = require("cluster"); const o = Object.assign({}, c.settings); console.log(o)`],
  ["a read of cluster settings by Reflect.get in console.log", `const c = require("cluster"); console.log(Reflect.get(c, "settings"))`],
  ["a message that holds module.constructor.register", `require("cluster"); console.log("module.constructor.register")`],
  ["this.constructor.register beside a cluster load", `require("cluster"); class A { go() { this.constructor.register(this) } }`],
  ["a property named module with a register method", `require("cluster"); app.module.register(x)`],
  ["a message that names module.register", `require("cluster"); throw new Error("module.register failed")`],
  ["a timer and a deprecation message that names m.register", `const m = require("module"); setTimeout(done, 10); log("m.register is deprecated")`],
  ["typeof a module member", `const m = require("module"); console.log(typeof m.register)`],
  ["typeof a node:test member", `const t = require("node:test"); console.log(typeof t.run)`],
  ["a bracket assignment of a key named register beside module", `const m = require("module"); routes["register"] = fn`],
  ["a bracket assignment of a key named run beside node:test", `require("node:test"); opts["run"] = true`],
  ["run set on a receiver bound to a non-literal require", `const t = require("node:test"); const n = "node:path"; const p = require(n); p.run = () => 42; console.log(p.run())`],
  ["settings set on a receiver bound to a non-literal require", `const cluster = require("cluster"); const conf = require(confPath); conf.settings = {}`],
  ["a read of run through a parameter named like the receiver", `const t = require("node:test"); function f(t) { return t.run } console.log(f({ run: 42 }))`],
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
const median3 = (make: () => string) => {
  const xs: number[] = [];
  for (let i = 0; i < 3; i++) {
    const src = make();
    const start = performance.now();
    classifyJs("h.js", src);
    xs.push(performance.now() - start);
  }
  return xs.sort((a, b) => a - b)[1] ?? 0;
};
const shapes: [string, (n: number) => string][] = [
  ["bracket keys in a string beside module", (n) => `require("module");console.log("${"['_load']".repeat(n / 9)}")`],
  ["bracket keys in code beside module", (n) => `const m = require("module"); ${"m['x'];".repeat(n / 7)}`],
  ["braces in one string beside node:test", (n) => `const t = require("node:test"); console.log("${"{".repeat(n)}")\n`],
  ["nested open braces with run beside node:test", (n) => `require("node:test"); ${"{ run; ".repeat(n / 7)}${"}".repeat(n / 7)}\n`],
  ["brackets in a string beside cluster", (n) => `const c = require("cluster"); console.log("${'["'.repeat(n / 2)}")\n`],
  ["padding strings before a Reflect.get of _load", (n) => `const M = require("module");\n${'const pad = "xxxxxxxxxx";\n'.repeat(n / 25)}Reflect.get(M, "_load")(p)`],
  ["many settings hand-offs beside cluster", (n) => `const c = require("cluster"); ${"f(c.settings, 1);".repeat(n / 17)}`],
  ["a long run of require.cache[ opens", (n) => `require("cluster"); ${"require.cache[".repeat(n / 14)}`],
  ["a long run of spaces beside cluster", (n) => `require("cluster"); ${" ".repeat(n)}`],
  ["a long run of line breaks beside cluster", (n) => `require("cluster");${"\n".repeat(n)}`],
  ["a long run of this-dot-constructor members", (n) => `require("cluster"); ${"this.constructor.".repeat(n / 17)}`],
  ["a long run of constructor members", (n) => `require("cluster"); ${"x.constructor.".repeat(n / 14)}`],
  ["many bound names beside module", (n) => `const a = require("module");\n${"const x = require(n);\n".repeat(n / 22)}`],
];
// The same shape at 1 MB, 2 MB and 4 MB (times under 20 ms count as 20): the least-squares slope of log time against log size over the three points is about 1 for a linear read and
// about 2 for a quadratic one. Observed slopes on the nine shapes run from 0.6 to 1.3; the bound leaves room for noise and is far below 2.
const slopeOf = (sizes: number[], times: number[]): number => {
  const xs = sizes.map((n) => Math.log(n));
  const ys = times.map((t) => Math.log(Math.max(t, 20)));
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let num = 0;
  let den = 0;
  for (let i = 0; i < xs.length; i++) {
    num += ((xs[i] ?? 0) - mx) * ((ys[i] ?? 0) - my);
    den += ((xs[i] ?? 0) - mx) ** 2;
  }
  return num / den;
};
for (const [name, make] of shapes) {
  test(`reading a long text is linear in its size: ${name}`, () => {
    median3(() => make(1 << 18));
    // A slow machine inflates one reading: the bound has to fail on every attempt, as a quadratic read does.
    const slopes: number[] = [];
    const sizes = [1 << 20, 1 << 21, 1 << 22];
    for (let attempt = 0; attempt < 3; attempt++) {
      const slope = slopeOf(sizes, sizes.map((n) => median3(() => make(n))));
      slopes.push(slope);
      if (slope < 1.4) break;
    }
    expect(Math.min(...slopes)).toBeLessThan(1.4);
  }, 60000);
}

// The loader or the settings object handed to a call, with a literal extension-less path: Reflect and Object read the member by a string or take the
// settings object whole, so the member never appears as code after the binding.
const handOffs: [string, (t: string) => string][] = [
  ["Reflect.get of _load", (t) => `const M = require("module"); Reflect.get(M, "_load")(${t})`],
  ["Object.assign on cluster settings", (t) => `const c = require("cluster"); Object.assign(c.settings, { exec: ${t} }); c.fork()`],
  ["Object.assign on settings destructured from cluster", (t) => `const { settings, fork } = require("cluster"); Object.assign(settings, { exec: ${t} }); fork()`],
  ["a quoted settings object then a quoted exec key", (t) => `const c = require("cluster"); c["settings"]["exec"] = ${t}; c.fork()`],
  ["Reflect.set of exec on cluster settings", (t) => `const c = require("cluster"); Reflect.set(c.settings, "exec", ${t}); c.fork()`],
];
for (const [name, code] of handOffs) {
  for (const dir of ["lib", "test"]) {
    const t = `"./${dir}/evil"`;
    const changed = `${dir}/evil.js`;
    test(`${name}: held at the hook, the package-root file, a nested file and a preinstall hook (${changed})`, () => {
      expect(heldAt("h.js", code(t), { postinstall: "node h.js" }, {}, changed)).toBe(true);
      expect(heldAt("index.js", code(t), { postinstall: "node index.js" }, {}, changed)).toBe(true);
      expect(heldAt("h.js", `require("./sub/loader.js")\n`, { postinstall: "node h.js" }, { "sub/loader.js": code(t) }, changed)).toBe(true);
      expect(heldAt("h.js", code(t), { preinstall: "node h.js" }, {}, changed)).toBe(true);
    });
  }
}

// Padding strings before the call, of every count and length: the string that names the member is read from the same text as the window around it,
// so no count or length hides the call.
const padded: [string, (t: string) => string][] = [
  ["Reflect.get of _load", (t) => `const M = require("module"); PADS const T = ${t}; Reflect.get(M, "_load")(T); console.log(T, M)`],
  ["Object.assign on cluster settings", (t) => `const c = require("cluster"); PADS const T = ${t}; Object.assign(c.settings, { exec: T }); c.fork()`],
  ["Reflect.set of exec on cluster settings", (t) => `const c = require("cluster"); PADS const T = ${t}; Reflect.set(c.settings, "exec", T); c.fork()`],
];
for (const [name, code] of padded) {
  for (const dir of ["lib", "test"]) {
    test(`${name}: held for every padding count and length (${dir})`, () => {
      const t = `["./${dir}/", "evil"].join("")`;
      for (let count = 0; count <= 20; count++) {
        for (const len of [1, 5, 10, 40, 200]) {
          const pads = Array.from({ length: count }, (_, i) => `const s${i} = "${"x".repeat(len)}";`).join(" ");
          const hook = code(t).replace("PADS", pads);
          if (!heldAt("h.js", hook, { postinstall: "node h.js" }, {}, `${dir}/evil.js`)) throw new Error(`not held with ${count} pads of ${len}`);
        }
      }
    });
  }
}

// A string of code given to a vm call, for module and for cluster.
const vmForms: [string, (builtin: string, call: string, t: string) => string][] = [
  ["runInNewContext", (b, call, t) => `const vm = require("vm"); vm.runInNewContext("${call}", { M: require("${b}"), p: ${t} })`],
  ["compileFunction", (b, call, t) => `const vm = require("vm"); vm.compileFunction("${call}", ["M", "p"])(require("${b}"), ${t})`],
  ["a Script run in a new context", (b, call, t) => `const vm = require("vm"); new vm.Script("${call}").runInNewContext({ M: require("${b}"), p: ${t} })`],
  ["runInThisContext with globals", (b, call, t) => `const vm = require("vm"); globalThis.M = require("${b}"); globalThis.p = ${t}; vm.runInThisContext("${call}")`],
  ["runInContext with createContext", (b, call, t) => `const vm = require("vm"); const ctx = vm.createContext({ M: require("${b}"), p: ${t} }); vm.runInContext("${call}", ctx)`],
];
for (const [name, form] of vmForms) {
  for (const [builtin, call] of [["module", "M._load(p)"], ["cluster", "M.setupPrimary({ exec: p }); M.fork()"]] as [string, string][]) {
    for (const dir of ["lib", "test"]) {
      test(`${builtin} loader in a string given to vm, ${name}: held (${dir})`, () => {
        const t = `["./${dir}/", "evil"].join("")`;
        expect(heldAt("h.js", form(builtin, call, t), { postinstall: "node h.js" }, {}, `${dir}/evil.js`)).toBe(true);
      });
    }
  }
}

// A vm verb renamed, destructured, called through a bracket or imported: the string it runs is still read as code once the file loads vm.
const vmRenamed: [string, (b: string, call: string, t: string) => string][] = [
  ["a destructured compileFunction", (b, call, t) => `const J = ${t}; const { compileFunction: cf } = require("vm"); cf("${call}", ["M", "p"])(require("${b}"), J)`],
  ["a destructured runInNewContext", (b, call, t) => `const J = ${t}; const { runInNewContext: run } = require("vm"); run("${call}", { M: require("${b}"), p: J })`],
  ["a bracket call of runInNewContext", (b, call, t) => `const J = ${t}; const vm = require("vm"); vm["runInNewContext"]("${call}", { M: require("${b}"), p: J })`],
  ["an import with an alias", (b, call, t) => `import { runInNewContext as run } from "node:vm"; import B from "node:${b}"; const J = ${t}; run("${call}", { M: B, p: J })`],
  ["a bracket call on the load itself", (b, call, t) => `const J = ${t}; require("node:vm")["runInNewContext"]("${call}", { M: require("${b}"), p: J })`],
  ["a compileFunction held in a name", (b, call, t) => `const J = ${t}; const r = require("vm").compileFunction; r("${call}", ["M", "p"])(require("${b}"), J)`],
  ["a namespace import", (b, call, t) => `import * as vm from "node:vm"; import B from "node:${b}"; const J = ${t}; vm.runInNewContext("${call}", { M: B, p: J })`],
];
for (const [name, form] of vmRenamed) {
  for (const [builtin, call] of [["module", "M._load(p)"], ["cluster", "M.setupPrimary({ exec: p }); M.fork()"]] as [string, string][]) {
    for (const dir of ["lib", "test"]) {
      test(`${builtin} loader in a string given to vm through ${name}: held (${dir})`, () => {
        expect(heldAt("h.js", form(builtin, call, `["./${dir}/", "evil"].join("")`), { postinstall: "node h.js" }, {}, `${dir}/evil.js`)).toBe(true);
      });
    }
  }
}

// vm loaded through a name that is not one plain string: built from pieces, held by a variable, spelled with an escape.
const vmSpellings: [string, string, string][] = [
  ["a name built from pieces", "", `require("v" + "m")`],
  ["a name held by a variable", `const n = "vm"; `, "require(n)"],
  ["a name spelled with an escape", "", `require("\\x76m")`],
];
const vmComputedForms: [string, (vm: string, b: string, call: string, t: string) => string][] = [
  ["runInNewContext", (vm, b, call, t) => `${vm}.runInNewContext("${call}", { M: require("${b}"), p: ${t} })`],
  ["compileFunction", (vm, b, call, t) => `${vm}.compileFunction("${call}", ["M", "p"])(require("${b}"), ${t})`],
  ["a renamed runInNewContext", (vm, b, call, t) => `const { runInNewContext: r } = ${vm}; r("${call}", { M: require("${b}"), p: ${t} })`],
  ["a renamed compileFunction", (vm, b, call, t) => `const { compileFunction: cf } = ${vm}; cf("${call}", ["M", "p"])(require("${b}"), ${t})`],
  ["runInContext", (vm, b, call, t) => `const vm = ${vm}; vm.runInContext("${call}", vm.createContext({ M: require("${b}"), p: ${t} }))`],
];
for (const [spelling, pre, expr] of vmSpellings) {
  for (const [name, form] of vmComputedForms) {
    for (const [builtin, call] of [["module", "M._load(p)"], ["cluster", "M.setupPrimary({ exec: p }); M.fork()"]] as [string, string][]) {
      for (const dir of ["lib", "test"]) {
        test(`${builtin} loader in a string given to vm loaded by ${spelling}, ${name}: held (${dir})`, () => {
          const hook = `${pre}${form(expr, builtin, call, `["./${dir}/", "evil"].join("")`)}`;
          expect(heldAt("h.js", hook, { postinstall: "node h.js" }, {}, `${dir}/evil.js`)).toBe(true);
        });
      }
    }
  }
}

// Any constructor chain ending in register or _load is held, whatever the receiver is called or how the path is built; only this.constructor is a class method.
const chainTarget = (dir: string) => `"file://" + __dirname + String.fromCharCode(${Array.from(`/${dir}/evil.mjs`).map((c) => c.charCodeAt(0)).join(",")})`;
const chains: [string, (u: string, p: string) => string][] = [
  ["an alias of module", (u) => `require("cluster"); const M = module; M.constructor.register(${u})`],
  ["a comma expression", (u) => `require("cluster"); (0, module).constructor.register(${u})`],
  ["the prototype of the constructor", (u) => `require("cluster"); const Module = module.constructor; Module.prototype.constructor.register(${u})`],
  ["a quoted constructor key", (u) => `require("cluster"); module["constructor"].register(${u})`],
  ["optional chaining", (u) => `require("cluster"); module?.constructor?.register(${u})`],
  ["module.parent", (u) => `require("cluster"); module.parent.constructor.register(${u})`],
  ["module.children", (u) => `require("cluster"); module.children[0].constructor.register(${u})`],
  ["a name bound to the constructor, _load", (_u, p) => `require("cluster"); const M = module.constructor; M._load(${p})`],
  ["a quoted constructor key, _load", (_u, p) => `require("cluster"); module["constructor"]._load(${p})`],
  ["optional chaining, _load", (_u, p) => `require("cluster"); module?.constructor?._load(${p})`],
];
for (const [name, code] of chains) {
  for (const dir of ["lib", "test"]) {
    test(`a loader through a constructor chain, ${name}: held (${dir})`, () => {
      const ext = name.endsWith("_load") ? "js" : "mjs";
      expect(heldAt("h.js", code(chainTarget(dir), `["./${dir}/", "evil"].join("")`), { postinstall: "node h.js" }, {}, `${dir}/evil.${ext}`)).toBe(true);
    });
  }
}

// Code run from a string through a call that is not spelled eval, Function or a vm verb.
test("a string run through .constructor( holds", () => {
  expect(heldAt("h.js", `(function () {}).constructor("M", "p", "return M._load(p)")(require("module"), ${J})`, { postinstall: "node h.js" }, {}, "lib/evil.js")).toBe(true);
});
test("vm loaded through a createRequire result holds", () => {
  expect(heldAt("h.js", `const r = require("module").createRequire(__filename); const { runInNewContext: run } = r("vm"); run("M._load(p)", { M: require("module"), p: ${J} })`, { postinstall: "node h.js" }, {}, "lib/evil.js")).toBe(true);
  expect(heldAt("h.js", `import { createRequire } from "node:module"; const r = createRequire(import.meta.url); const J = ${J}; const { runInNewContext: run } = r("node:vm"); run("M._load(p)", { M: r("module"), p: J })`, { postinstall: "node h.js" }, {}, "lib/evil.js")).toBe(true);
});

// Whitespace or a line break inside the parentheses of a literal load does not make it computed: the file stays in code position.
const spaced: [string, string][] = [
  ["a space before the name", `require( "cluster"); console.log("module.register")`],
  ["a line break before the name", `require(\n"cluster"); console.log("module.register")`],
  ["a wrapped dynamic import", `import(\n  "./x.js"\n); console.log("module.register")`],
];
for (const [name, hook] of spaced) {
  test(`a literal load with whitespace inside is not a computed load: ${name}`, () => {
    expect(held(hook)).toBe(false);
  });
}
test("a literal load with whitespace inside still sees its loader", () => {
  expect(held(`const c = require(\n  "cluster"\n); c.setupPrimary({ exec: ${J} }); c.fork()`)).toBe(true);
  expect(held(`const c = require( "cluster" ); c.setupPrimary({ exec: ${J} }); c.fork()`)).toBe(true);
});

// Accepted costs of the conservative rule: held although nothing is loaded.
const accepted: [string, string][] = [
  ["a class method register called through a constructor", `require("cluster"); class Foo { static register(x) { console.log(x) } } const app = new Foo(); app.constructor.register("ok")`],
  ["a main property with a constructor register", `require("cluster"); app.main.constructor.register("ok")`],
  ["a dynamic require and a warning that names module.register", `const plugin = require(pluginPath); console.warn("module.register() is unavailable")`],
  ["a dynamic require and a string with a bracket key", `const p = require(dyn); console.log('module["register"]')`],
  ["a local function named like a vm verb", `require("cluster"); function compileFunction() { return 1 } compileFunction(); console.log("module.register")`],
];
for (const [name, hook] of accepted) {
  test(`accepted cost, held: ${name}`, () => {
    expect(held(hook)).toBe(true);
  });
}

// register behind any constructor chain, but not behind this.
const registerChains: [string, string][] = [
  ["the prototype of module", `require("cluster"); Object.getPrototypeOf(module).constructor.register(JM)`],
  ["__proto__ of module", `require("cluster"); module.__proto__.constructor.register(JM)`],
  ["the cache entry of this file", `require("cluster"); require.cache[__filename].constructor.register(JM)`],
];
for (const [name, code] of registerChains) {
  test(`constructor.register behind ${name}: held`, () => {
    expect(heldAt("h.js", code.replace("JM", JM), { postinstall: "node h.js" }, {}, "lib/evil.mjs")).toBe(true);
  });
}

// Shapes held at the previous head: they stay held.
const kept: [string, string][] = [
  ["settings.exec assigned after a destructure", `const { settings } = require("cluster"); settings.exec = "./lib/evil"; require("cluster").fork()`],
  ["a receiver alias", `const c = require("cluster"); const k = c; k.setupPrimary({ exec: "./lib/evil" }); k.fork()`],
  ["a quoted settings object then a quoted exec key", `const c = require("cluster"); c["settings"]["exec"] = "./lib/evil"; c.fork()`],
  ["a with block over the load", `with (require("cluster")) { setupPrimary({ exec: "./lib/evil" }); fork() }`],
  ["a rebind after a shadowing function", `const c = require("cluster"); (function (c) { return c })(1); c.setupPrimary({ exec: "./lib/evil" }); c.fork()`],
  ["a computed member of module", `const M = require("module"); const k = "_load"; M[k]("./lib/evil")`],
  ["process.mainModule.constructor._load", `process.mainModule.constructor._load("./lib/evil")`],
  ["module.constructor through a bracket", `module.constructor["_load"]("./lib/evil")`],
];
for (const [name, code] of kept) {
  test(`still held: ${name}`, () => {
    expect(heldAt("h.js", code, { postinstall: "node h.js" }, {}, "lib/evil.js")).toBe(true);
  });
}

for (const [name, code] of [
  ["a bracket read of cluster settings", `const c = require("cluster"); console.log(c["settings"])`],
  ["typeof a module member", `const m = require("module"); console.log(typeof m.register)`],
  ["typeof a node:test member", `const t = require("node:test"); console.log(typeof t.run)`],
] as [string, string][]) {
  test(`${name} is not a load in a root file, a nested file or a preinstall hook`, () => {
    expect(heldAt("index.js", code, { postinstall: "node index.js" }, {}, "lib/evil.js")).toBe(false);
    expect(heldAt("h.js", `require("./sub/loader.js")\n`, { postinstall: "node h.js" }, { "sub/loader.js": code }, "lib/evil.js")).toBe(false);
    expect(heldAt("h.js", code, { preinstall: "node h.js" }, {}, "lib/evil.js")).toBe(false);
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
