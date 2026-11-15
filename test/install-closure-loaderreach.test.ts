import { describe, expect, test } from "bun:test";
import { classifyJs, installView } from "../src/install-closure.ts";

const enc = new TextEncoder();
// The loaded name is built at run time, so only reading every file reaches docs/evil.js.
const name = 'const f = "./docs/" + ["ev", "il"].join("") + ".js";\n';
const reaches = (body: string) => {
  const o = { "package.json": JSON.stringify({ name: "x", version: "1.0.0", scripts: { postinstall: "node hook.js" } }), "hook.js": `${name}${body}\n`, "docs/evil.js": "1;\n", "README.md": "x\n", "lib/a.js": "1;\n" };
  return installView(new Map(Object.entries(o).map(([k, v]) => [k, enc.encode(v)]))).files.includes("docs/evil.js");
};

describe("the loader reached through a computed member, as this, or through Reflect", () => {
  test.each([
    'const p = module.constructor.prototype; const k = "req" + "uire"; p[k].call(module, f);',
    'const k = "req" + "uire"; const g = module.constructor.prototype[k]; g.apply(module, [f]);',
    'const p = module.constructor.prototype; const k = "req" + "uire"; p[k].bind(module)(f);',
    "const R = Reflect; R.apply(require, null, [f]);",
    'const R = Reflect; R.get(module, "require")(f);',
    "Reflect.apply(require, null, [f]);",
    "Reflect.apply(module.require, module, [f]);",
    "const { apply } = Reflect; apply(require, null, [f]);",
    "const { apply: run } = Reflect; run(require, null, [f]);",
    "let R = globalThis.Reflect; R.apply(require, null, [f]);",
    "const c = require.cache; const m = Object.values(c)[0]; const L = m.require; L.call(m, f);",
    "const m = Object.values(require.cache)[0]; const { require: r } = m; r(f);",
    "const m = Object.values(require.cache)[0]; m.constructor._load(f, m);",
    "const m = Object.values(require.cache)[0]; const ld = m.constructor; new ld(f).load(f);",
    "const v = Object.values(require?.cache); v[0].constructor._load(f);",
    "const v = Object.values(module.constructor._cache); v[0].constructor._load(f);",
    'const M = require("module"); M._load(f);',
    "const s = `${require(\"module\")._load(f)}`;",
    "const c = require.cache; const d1 = c; const d2 = d1; const d3 = d2; const d4 = d3; const d5 = d4; const d6 = d5; Object.values(d6)[0].require(f);",
    "const c = require.cache.length && require.cache; Object.values(c)[0].require(f);",
    "const c = Object.keys(require.cache).length ? require.cache : null; Object.values(c)[0].require(f);",
    "require.main.require(\"module\")._load(f);",
    "module.exports = require; Reflect.apply(module.exports, null, [f]);",
    "module.exports.r = require; Reflect.apply(module.exports.r, null, [f]);",
    "module.exports.box = module; Reflect.apply(module.exports.box.require, null, [f]);",
    "require.resolve = module.require; require.resolve.call(module, f);",
    "const M = require('module'); M._load.apply(M, [f]);",
    "const re = /\"/; require('module')._load(f);",
    "const q = /\"/g; const L = require(\"module\"); L._load(f);",
    "require(\"module\") /*                                                                      */ ._load(f);",
    "const M = /*                                                                                          */ require(\"module\"); M._load(f);",
    "const M                                                                                          = require(\"module\"); M._load(f);",
    "module.require(\"module\")._load(f);",
    "module.go = function (f) { return this.constructor._load(f); }; module.go(f);",
    "const resolve = module.constructor.prototype.require; resolve.call(module, f);",
    "const re = /'/; const s = 'require(\"module\")._load(f)'; obj._load(x);",
    "class A { static _load() {} m() { return this.constructor._load(); } } A.x = module.constructor._load;",
    "module.constructor._load(f, module);",
    'require("node:module")._load(f);',
    "const c = require.cache; const ld = c.length && Object.values(c)[0].constructor; new ld(f).load(f);",
    "const ld = require.cache.length && Object.values(require.cache)[0].constructor; new ld(f).load(f);",
    "let ld; if (Object.keys(require.cache).length) ld = Object.values(require.cache)[0].constructor; new ld(f).load(f);",
    "module.exports.require = module.require; Reflect.apply(module.exports.require, module, [f]);",
    'const p = module.constructor.prototype; const k = "req" + "uire"; p[k].call(module.parent, f);',
    'const p = module.constructor.prototype; const k = "req" + "uire"; p[k].call(require.cache[key], f);',
    "const c0 = require.cache; const c1 = require.cache; const c2 = require.cache; const c3 = require.cache; const c4 = require.cache; const c5 = require.cache; const c6 = require.cache; const c7 = require.cache; const c8 = require.cache; const c9 = require.cache; const c10 = require.cache; const c11 = require.cache; const c12 = require.cache; const c13 = require.cache; const c14 = require.cache; const c15 = require.cache; const c16 = require.cache; const ld = Object.values(c16)[0].constructor; new ld(f).load(f);",
    "const c0 = require.cache; const c1 = require.cache; const c2 = require.cache; const c3 = require.cache; const c4 = require.cache; const c5 = require.cache; const c6 = require.cache; const c7 = require.cache; const c8 = require.cache; const c9 = require.cache; const c10 = require.cache; const c11 = require.cache; const c12 = require.cache; const c13 = require.cache; const c14 = require.cache; const c15 = require.cache; const c16 = require.cache; const d = c16; const ld = Object.values(d)[0].constructor; new ld(f).load(f);",
    "const M = require('node:module'); M._load(f, module);",
    "const c = require.cache; const k = Object.keys(c)[0]; c[k].require(f);",
    'const { construct } = Reflect; const M = construct(module.constructor, [f]);',
  ])("%s: every file is read", (body) => {
    expect(reaches(body)).toBe(true);
  });
  test.each([
    "(function () { module.exports = 1; }).call(module.exports);",
    '(function () { this.a = 1; }).call(module.exports); require("./lib/a.js");',
    "Reflect.apply(Math.max, null, [1, 2]);",
    "const R = Reflect; R.ownKeys({ a: 1 });",
    'Reflect.get({ a: 1 }, "a");',
    "const { ownKeys } = Reflect; ownKeys({ a: 1 });",
    "module.exports = { a: 1 }; module.exports.b = 2;",
    'if (Object.prototype.hasOwnProperty.call(module, "id")) module.exports = 1;',
    'const t = Object.prototype.toString.call(require); module.exports = t;',
    "const cacheSize = 1; const requireCache = {}; module.exports = { cacheSize, requireCache };",
    'const n = Object.keys(require.cache).length; require("./lib/a.js"); module.exports = n;',
    'for (const k of Object.keys(require.cache)) delete require.cache[k]; require("./lib/a.js");',
    'const n = Object.entries(require.cache).length; class C { constructor() {} } require("./lib/a.js");',
    'const n = Object.keys(require.cache).length; const x = obj.require; require("./lib/a.js");',
    'if (Reflect.has(module, "id")) require("./lib/a.js");',
    'const k = "a"; const e = Reflect.get(require.cache, k); require("./lib/a.js");',
    'Reflect.defineProperty(module.exports, "a", { value: 1 }); require("./lib/a.js");',
    'const R = Reflect; R.ownKeys(module); require("./lib/a.js");',
    'const { has } = Reflect; has(module, "id"); require("./lib/a.js");',
    'this._load(x); require("./lib/a.js");',
    'if (module.constructor._cache && module.constructor._cache[k]) delete module.constructor._cache[k]; require("./lib/a.js");',
    'const r = require.resolve.bind(require); require("./lib/a.js");',
    'const r = require.resolve.call(require, "x"); require("./lib/a.js");',
    'module.exports = require("./lib/a.js"); module.exports.x = module.exports.y;',
    'module.exports = module.exports || {}; const r = require.resolve.bind(require); require("./lib/a.js");',
    'const c = require.cache; delete c[k]; class C { constructor() {} } require("./lib/a.js");',
    'const c = require.cache, x = obj.require; delete c.k; require("./lib/a.js");',
    'const c = module.constructor._cache; delete c[k]; require("./lib/a.js");',
    'const M = require("./parser"); M._load(input); require("./lib/a.js");',
    'require("./x")._load(y); require("./lib/a.js");',
    'const cacheCount = Object.keys(require.cache).length; cacheCount.constructor; require("./lib/a.js");',
    'const n = Object.keys(require.cache).length, x = obj.require; require("./lib/a.js");',
    'const s = require.cache.size; const t = s.constructor; require("./lib/a.js");',
    'const c0 = require.cache; const c1 = require.cache; const c2 = require.cache; const c3 = require.cache; const c4 = require.cache; const c5 = require.cache; const c6 = require.cache; const c7 = require.cache; const c8 = require.cache; const c9 = require.cache; const c10 = require.cache; const c11 = require.cache; const c12 = require.cache; const c13 = require.cache; const c14 = require.cache; const c15 = require.cache; const c16 = require.cache; require("./lib/a.js");',
    'const parts = String.prototype.split.call(module.filename, "/"); require("./lib/a.js");',
    'const own = Object.keys.call(null, module.exports); require("./lib/a.js");',
    'fn.call(module.id, 1); g.apply(require.resolve, []); require("./lib/a.js");',
    'Reflect.apply(module.exports.fn, null, []); require("./lib/a.js");',
    'Reflect.get(module.exports, "a")(1); require("./lib/a.js");',
    'const n = Object.keys(module.constructor._cache).length; require("./lib/a.js");',
  ])("control, as on main: %s reads no docs file", (body) => {
    expect(reaches(body)).toBe(false);
  });
});

describe("_load of the module builtin only (classifyJs)", () => {
  test.each(["const c = require.cache.length && require.cache; Object.values(c)[0].require(f);","const c = Object.keys(require.cache).length ? require.cache : null; Object.values(c)[0].require(f);","require.main.require(\"module\")._load(f);","module.exports = require; Reflect.apply(module.exports, null, [f]);","module.exports.r = require; Reflect.apply(module.exports.r, null, [f]);","module.exports.box = module; Reflect.apply(module.exports.box.require, null, [f]);","module.exports.box = module; const k = 'req' + 'uire'; Object.prototype.x.call(module.exports.box, f); g.apply(module.exports, [f]);","require.resolve = module.require; require.resolve.call(module, f);","require.resolve = module.require; g.call(require.resolve, f);","Module._load.call(Module, f);","Module._load?.(f);", "get().require(\"module\")._load(f);", "const M = module.require(\"module\"); M._load(f);", "const M = require.main.require('node:module'); M._load(f);", "exports.x = require; const { apply } = Reflect; apply(module.exports, null, [f]);", "const { apply } = Reflect; apply(module.exports.require, null, [f]);", "module.exports = require; const { apply } = Reflect; apply(module.exports, null, [f]);", "require(\"module\")._load.call(null, f);", "require(\"module\")._load?.(f);","const M = require('module'); M._load.apply(M, [f]);","const c = require.cache; const d1 = c; const d2 = d1; const d3 = d2; const d4 = d3; const d5 = d4; const d6 = d5; Object.values(d6)[0].require(f);"])("%s reads every file", (code) => {
    expect(classifyJs("a.js", code).all).toBe(true);
  });
  test.each(['require( /* c */ "node:module")._load(f);', 'require(                                                                 "module")._load(f);', 'const M = require("module"); M._load(f);', 'require("node:module")._load(f);', "const M = require('node:module'); M._load(f);"])("%s reads every file", (code) => {
    expect(classifyJs("a.js", code).all).toBe(true);
  });
  test.each(["module.exports = require(\"./lib/a.js\"); module.exports.x = module.exports.y; const r = require.resolve.bind(require);","module.exports = module.exports || {}; fn.call(module.exports, 1);","const n = Object.keys(require.cache).length; const m = n ? 1 : 2;"])("control, as on main: %s", (code) => {
    expect(classifyJs("a.js", code).all).toBe(false);
  });
  test.each(['/* require("module")._load(f); */ const x = obj._load;', '// const M = require("module");\nM._load(x);', 'const M = require("./parser"); M._load(input);', 'require("./x")._load(y);', 'const M = require("modules"); M._load(x);'])("control, as on main: %s", (code) => {
    expect(classifyJs("a.js", code).all).toBe(false);
  });
});
