import { expect, test } from "bun:test";
import { classifyJs, provablyStatic, scannerFaultCount, setJsScanSteps } from "../src/install-closure.ts";
import { prepass, type FileMap } from "../src/prepass.ts";
import { allowFaults } from "./fault-guard.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const files = (o: Record<string, string>): FileMap => new Map(Object.entries(o).map(([k, v]) => [k, enc(v)]));
const holds = (old: FileMap, now: FileMap) => prepass("npm", old, now).hard.filter((s) => s.kind === "install-script").map((s) => s.detail);
const release = (v: string, hook: string) =>
  files({
    "package.json": JSON.stringify({ name: "p", version: v, scripts: { postinstall: "node lib/hook.js" } }),
    "lib/hook.js": hook,
    "docs/payload.txt": `payload ${v}\n`,
  });
const widensDocs = (hook: string) => holds(release("1.0.0", hook), release("1.0.1", hook)).some((d) => d.includes("docs/payload.txt"));

// A computed member stored in a name and called later reaches Function when the key is "constructor", built at run time here.
const K = 'const k = ["con", "structor"].join("");\n';
const reaches: [string, string][] = [
  ["a function member stored then called", `${K}const f = function () {}[k];\nexports.main = () => f("return 1")();\n`],
  ["an object member stored then called", `${K}const f = {}[k];\nexports.main = () => f("return 1")();\n`],
  ["an array member stored then called", `${K}const f = [][k];\nexports.main = () => f("return 1")();\n`],
  ["a member of a parameter stored then called", `${K}exports.main = (o) => { const f = o[k]; return f("return 1")(); };\n`],
  ["a member stored by a plain assignment", `${K}let f;\nf = function () {}[k];\nexports.main = () => f("return 1")();\n`],
  ["a member stored with var", `${K}var f = function () {}[k];\nexports.main = () => f("return 1")();\n`],
  ["a stored member called with .call", `${K}const f = function () {}[k];\nexports.main = () => f.call(null, "return 1")();\n`],
  ["a stored member called with .apply", `${K}const f = function () {}[k];\nexports.main = () => f.apply(null, ["return 1"])();\n`],
  ["a stored member called through .bind", `${K}const f = function () {}[k];\nexports.main = () => f.bind(null)("return 1")();\n`],
  ["a stored member called as a tagged template", `${K}const f = function () {}[k];\nexports.main = () => f\`return 1\`();\n`],
  ["a stored member used with new", `${K}const f = function () {}[k];\nexports.main = () => new f("return 1")();\n`],
  ["a stored member called with ?.()", `${K}const f = function () {}[k];\nexports.main = () => f?.("return 1")();\n`],
  ["a stored member called in parentheses", `${K}const f = function () {}[k];\nexports.main = () => (f)("return 1")();\n`],
  ["a stored member called after a comma", `${K}const f = function () {}[k];\nexports.main = () => (0, f)("return 1")();\n`],
  ["an alias of a stored member", `${K}const f = function () {}[k];\nconst g = f;\nexports.main = () => g("return 1")();\n`],
  ["an alias four hops from a stored member", `${K}const f = function () {}[k];\nconst g = f;\nconst h = g;\nconst i = h;\nconst j = i;\nexports.main = () => j("return 1")();\n`],
  ["an alias five hops from a stored member", `${K}const f = function () {}[k];\nconst g = f;\nconst h = g;\nconst i = h;\nconst j = i;\nconst l = j;\nexports.main = () => l("return 1")();\n`],
  ["an alias in an expression", `${K}const f = function () {}[k];\nconst g = f || null;\nexports.main = () => g("return 1")();\n`],
  ["a member taken by a computed pattern key", `${K}const { [k]: f } = function () {};\nexports.main = () => f("return 1")();\n`],
  ["a member taken by a computed pattern key with a default", `${K}const { [k]: f = null } = function () {};\nexports.main = () => f("return 1")();\n`],
  ["a member taken by a computed pattern key in an assignment", `${K}let f;\n({ [k]: f } = function () {});\nexports.main = () => f("return 1")();\n`],
  ["a stored member called from a function declared first", `${K}function run() { return f("return 1")(); }\nconst f = function () {}[k];\nexports.main = run;\n`],
  ["a stored member of an object with a key that is a call", `${K}const f = function () {}[String(k)];\nexports.main = () => f("return 1")();\n`],
  ["a stored member with a key that is a name set from elsewhere", `let n = 0;\nn = ["con", "structor"].join("");\nconst f = function () {}[n];\nexports.main = () => f("return 1")();\n`],
  ["an optional member stored then called", `${K}exports.main = (o) => { const f = o?.[k]; return f("return 1")(); };\n`],
  ["a member on the next line stored then called", `${K}exports.main = (o) => { const f = o\n[k]; return f("return 1")(); };\n`],
  ["a member after a line-ending || stored then called", `${K}exports.main = (o, g) => { const f = g ||\n o[k]; return f("return 1")(); };\n`],
  ["a member stored then called through [\"call\"]", `${K}exports.main = (o) => { const f = o[k]; return f["call"](null, "return 1")(); };\n`],
  ["a member stored then called through [\"apply\"]", `${K}exports.main = (o) => { const f = o[k]; return f["apply"](null, ["return 1"])(); };\n`],
  ["a member stored then called through [\"bind\"]", `${K}exports.main = (o) => { const f = o[k]; return f["bind"](null)("return 1")(); };\n`],
  ["a member stored by ||=", `${K}exports.main = (o) => { let f; f ||= o[k]; return f("return 1")(); };\n`],
  ["a member stored by ??=", `${K}exports.main = (o) => { let f; f ??= o[k]; return f("return 1")(); };\n`],
  ["a member stored by &&=", `${K}exports.main = (o) => { let f = 1; f &&= o[k]; return f("return 1")(); };\n`],
  ["a member in an array called by index", `${K}exports.main = (o) => { const a = [o[k]]; return a[0]("return 1")(); };\n`],
  ["a member in an array taken by a pattern then called", `${K}exports.main = (o) => { const [g] = [o[k]]; return g("return 1")(); };\n`],
  ["a member in an array taken by an assignment pattern then called", `${K}exports.main = (o) => { let g; [g] = [o[k]]; return g("return 1")(); };\n`],
  ["a pattern key with a nested bracket", `${K}exports.main = (o, a) => { const { [a[0]]: f } = o; return f("return 1")(); };\n`],
  ["a pattern key after a default object", `${K}exports.main = (o) => { const { x = {}, [k]: f } = o; return f("return 1")(); };\n`],
  ["pin: a stored member as the first argument of Function.prototype.call.call, held on main too", `${K}exports.main = (o) => { const f = o[k]; return Function.prototype.call.call(f, null, "return 1")(); };\n`],
  ["pin: a stored member given to a name set from apply, held on main too", `${K}exports.main = (o) => { const f = o[k]; const run = Function.prototype.apply; return run.call(f, null, ["return 1"])(); };\n`],
  ["a stored member given to a name set from apply", `${K}exports.main = (o) => { const f = o[k]; const apply = o.apply; return apply(f, null, "return 1")(); };\n`],
  ["a stored member in a name with a non-ASCII letter", `${K}exports.main = (o) => { const ñ = o[k]; return ñ("return 1")(); };\n`],
  ["a stored member held by an arrow wrapper", `${K}exports.main = (o) => { const f = o[k]; const g = () => f; return g()("return 1")(); };\n`],
  ["a stored member held by a function wrapper", `${K}exports.main = (o) => { const f = o[k]; const g = function () { return f; }; return g()("return 1")(); };\n`],
  ["a stored member given to apply taken from Reflect", `${K}exports.main = (o) => { const f = o[k]; const { apply } = Reflect; return apply(f, null, ["return 1"])(); };\n`],
  ["a stored member given to Reflect with a string key", `${K}exports.main = (o) => { const f = o[k]; return Reflect["apply"](f, null, ["return 1"])(); };\n`],
  ["a stored member given to Reflect.apply after 60 blanks", `${K}exports.main = (o) => { const f = o[k]; return Reflect.apply(${" ".repeat(60)}f, null, ["return 1"])(); };\n`],
  ["pin: a stored member given to a name set from call.call, held on main too", `${K}exports.main = (o) => { const f = o[k]; const run = Function.prototype.call.call; return run(f, null, "return 1")(); };\n`],
  ["a stored member in a group with ||", `${K}exports.main = (o, g) => { const f = o[k]; return (f || g)("return 1")(); };\n`],
  ["a stored member in a group with ?:", `${K}exports.main = (o, g, c) => { const f = o[k]; return (c ? f : g)("return 1")(); };\n`],
  ["a stored member returned from an arrow in a ?: expression", `${K}exports.main = (o, c, g) => { const f = o[k]; const w = () => c ? f : g; return w()("return 1")(); };\n`],
  ["a stored member returned from an arrow in parentheses", `${K}exports.main = (o) => { const f = o[k]; const w = () => (f); return w()("return 1")(); };\n`],
  ["a stored member returned from a nested block of a function", `${K}exports.main = (o, c) => { const f = o[k]; const w = function () { if (c) { return f; } return null; }; return w()("return 1")(); };\n`],
  ["a stored member returned from an async arrow", `${K}exports.main = (o) => { const f = o[k]; const w = async () => f; return w().then((h) => h("return 1")()); };\n`],
  ["an arrow whose parameter default is a tainted name, returning the outer name", `${K}exports.main = (o) => { const f = o[k]; const g = (z = f) => f; return g()("return 1")(); };\n`],
  ["an arrow whose parameter default is a computed member, returning it", `${K}exports.main = (o) => { const g = (f = o[k]) => f; return g()("return 1")(); };\n`],
  ["an arrow whose pattern parameter has a computed key, returning it", `${K}exports.main = (o) => { const g = ({ [k]: f } = o) => f; return g()("return 1")(); };\n`],
  ["an arrow whose pattern parameter key is the outer stored name", `${K}exports.main = (o) => { const f = o[k]; const g = ({ f: x }) => f; return g({})("return 1")(); };\n`],
  ["a function that returns nothing but is or-ed with the stored name after its body", `${K}exports.main = (o) => { const f = o[k]; const g = function (f) {} || f; return g("return 1")(); };\n`],
  ["an arrow whose parameter default is a name set from a computed member", `${K}exports.main = (o) => { const h = o[k]; const g = (f = h) => f; return g()("return 1")(); };\n`],
  ["an arrow whose object pattern parameter is a name set from a computed member", `${K}exports.main = (o) => { const h = o[k]; const g = ({ f } = h) => f; return g()("return 1")(); };\n`],
  ["an arrow whose array pattern parameter is a name set from a computed member", `${K}exports.main = (o) => { const h = o[k]; const g = ([f] = h) => f; return g()("return 1")(); };\n`],
  ["a function whose parameter default is a name set from a computed member", `${K}exports.main = (o) => { const h = o[k]; const g = function (f = h) { return f; }; return g()("return 1")(); };\n`],
  ["a member returned by a function called at once", `${K}exports.main = (o) => { const f = (function () { return o[k]; })(); return f("return 1")(); };\n`],
  ["a member returned by an arrow called at once", `${K}exports.main = (o) => { const f = (() => { return o[k]; })(); return f("return 1")(); };\n`],
  ["a member returned by a function in a ?: group that is called", `${K}exports.main = (o, c, g) => { const f = (c ? function () { return o[k]; } : g)(); return f("return 1")(); };\n`],
  ["a member returned by a function in a || group that is called", `${K}exports.main = (o, g) => { const f = (function () { return o[k]; } || g)(); return f("return 1")(); };\n`],
  ["a member returned by a function made with new", `${K}exports.main = (o) => { const f = new function () { return o[k]; }; return f("return 1")(); };\n`],
  ["a member returned by a function in parentheses made with new", `${K}exports.main = (o) => { const f = new (function () { return o[k]; }); return f("return 1")(); };\n`],
  ["a member returned by a function used as a tag", `${K}exports.main = (o) => { const f = o.x || function () { return o[k]; }\`x\`; return f("return 1")(); };\n`],
  ["a member returned by a function called after !", `${K}exports.main = (o) => { const f = !function () { return o[k]; }(); return f("return 1")(); };\n`],
  ["a member returned by a function called on the next line", `${K}exports.main = (o) => { const f = o.x || function () { return o[k]; }\n(); return f("return 1")(); };\n`],
  ["a member returned by a function called with ?.()", `${K}exports.main = (o) => { const f = o.x || function () { return o[k]; }?.(); return f("return 1")(); };\n`],
  ["a member returned by a function called with .call", `${K}exports.main = (o) => { const f = (function () { return o[k]; }).call(this); return f("return 1")(); };\n`],
  ["a member returned by a function called with .apply", `${K}exports.main = (o) => { const f = (function () { return o[k]; }).apply(null); return f("return 1")(); };\n`],
  ["a member returned by a function called at once, with a || before it", `${K}exports.main = (o) => { const f = o.x || (function () { return o[k]; })(); return f("return 1")(); };\n`],
  ["a stored member read with ?.[0]?.( and called", `${K}exports.main = (o) => { const f = o[k]; return f?.[0]?.("return 1")(); };\n`],
  ["a stored member read with ?.[0]?.[1] and called", `${K}exports.main = (o) => { const f = o[k]; return f?.[0]?.[1]("return 1")(); };\n`],
  ["a stored member read with ?.[0].call", `${K}exports.main = (o) => { const f = o[k]; return f?.[0].call(null, "return 1")(); };\n`],
  ["a stored member read with [0].call", `${K}exports.main = (o) => { const f = o[k]; return f[0].call(null, "return 1")(); };\n`],
  ["a stored member read with [0]?.( and called", `${K}exports.main = (o) => { const f = o[k]; return f[0]?.("return 1")(); };\n`],
  ["a stored member read with [0][1] and called", `${K}exports.main = (o) => { const f = o[k]; return f[0][1]("return 1")(); };\n`],
  ["a stored member read with ?.[ and called", `${K}exports.main = (o) => { const f = o[k]; return f?.[0]("return 1")(); };\n`],
  ["a stored member read with ?.[\"call\"] and called", `${K}exports.main = (o) => { const f = o[k]; return f?.["call"](null, "return 1")(); };\n`],
  ["a stored member called inside a spread argument", `${K}exports.main = (o, g) => { const f = o[k]; return g(...f("return 1")()); };\n`],
  ["a stored member called inside an array spread", `${K}exports.main = (o) => { const f = o[k]; return [...f("return 1")()]; };\n`],
  ["a stored member passed to Reflect.apply", `${K}const f = function () {}[k];\nexports.main = () => Reflect.apply(f, null, ["return 1"])();\n`],
];
for (const [label, src] of reaches) {
  test(`${label}: not static, the hazard widens and a changed payload holds`, () => {
    expect(provablyStatic(src)).toBe(false);
    expect(classifyJs("pkg/lib/x.js", src).all).toBe(true);
    expect(widensDocs(src)).toBe(true);
  });
}

// Ordinary stored members stay static.
const ES = "\"use strict\";\nObject.defineProperty(exports, \"__esModule\", { value: true });\n";
const stays: [string, string][] = [
  ["a member stored by name and called", "const obj = { m: () => 1 };\nconst f = obj.m;\nf();\n"],
  ["a fixed array's first element stored and called", "const arr = [() => 1];\nconst g = arr[0];\ng();\n"],
  ["an element stored by a counter in a loop", "const fns = [() => 1];\nfor (let i = 0; i < fns.length; i++) { const g = fns[i]; g(); }\n"],
  ["the last element of a fixed array stored and called", "const fns = [() => 1];\nconst g = fns[fns.length - 1];\ng();\n"],
  ["a stored arrow that reads a computed member in its body", "const get = (o, k) => o[k];\nexports.get = get;\nget({}, 1);\n"],
  ["a stored function expression that reads a computed member in its body", "const get = function (o, k) { return o[k]; };\nget({}, 1);\n"],
  ["a stored async arrow with a body that reads a computed member", "const get = async (o, k) => { return o[k]; };\nget({}, 1);\n"],
  ["a stored arrow that returns an array of names", "const pair = (a, b) => { return [a, b]; };\npair(1, 2);\n"],
  ["a pattern that takes names from an array of names", "const fa = () => 1;\nconst fb = () => 2;\nconst [a, b] = [fa, fb];\na();\nb();\n"],
  ["a member on the next line that is a plain property", "const o = { m: () => 1 };\nconst f = o\n.m;\nf();\n"],
  ["a name given a function that returns an array of names, called at once and again", "const a = () => 1;\nconst b = () => 2;\nconst x = (function () { return [a, b]; })();\nx[0]();\n"],
  ["an async IIFE that passes a stored member to a call", "const urls = { a: 1 };\nconst p = \"a\";\n(async () => {\n  const url = urls[`${p}-${p}`];\n  await download(url);\n})();\nfunction download(u) { return u; }\n"],
  ["a function called with .call that passes a stored member to a call", "const o = { a: 1 };\nconst k = \"a\";\n(function () {\n  const v = o[k];\n  use(v);\n}).call(null);\nfunction use(v) { return v; }\n"],
  ["a stored member given to hasOwnProperty.call as the object", "const o = { a: {} };\nconst k = \"a\";\nconst v = o[k];\nObject.prototype.hasOwnProperty.call(v, \"x\");\n"],
  ["a stored member given to fn.apply as this", "const o = { a: {} };\nconst k = \"a\";\nconst fn = () => 1;\nconst v = o[k];\nfn.apply(v, []);\n"],
  ["a stored member given to a name set from console.log.bind", "const o = { a: 1 };\nconst k = \"a\";\nconst log = console.log.bind(console);\nconst v = o[k];\nlog(v);\n"],
  ["an IIFE that walks Object.entries in a for-of head", "const m = { a: 1 };\nconst x = (() => {\n  for (const [a, b] of Object.entries(m)) {\n    sink(a, b);\n  }\n})();\nfunction sink() {}\nx();\n"],
  ["a function with no semicolon then a computed member on the next line", "const o = { a: 1 };\nconst k = \"a\";\nconst f = function () {}\nconst x = o[k]\nf()\nexports.x = x\n"],
  ["a download wrapper that reads a stored member inside a call", "const PLATFORMS = { a: 'x' };\nconst target = PLATFORMS[`${process.platform}-${process.arch}`];\nconst install = async () => { const res = await fetch(base + target); return res; };\ninstall();\n"],
  ["a wrapper that stores a member in its body and passes it to a call", "const BINS = { a: 'x' };\nconst main = async () => { const bin = BINS[process.platform]; await download(bin); };\nmain().catch(fail);\nfunction download(b) { return b; }\nfunction fail() {}\n"],
  ["an arrow whose parameter shares its name with a stored member elsewhere", "const twos = (buf) => { var sum = 0; for (var i = buf.length - 1; i > -1; i--) { var byte = Number(buf[i]); sum += byte; } return sum; };\nconst onesComp = (byte) => (0xff ^ byte) & 0xff;\nonesComp(1);\ntwos([1]);\n"],
  ["a function whose parameter shares its name with a stored member elsewhere", "const o = { a: 1 };\nconst k = \"a\";\nconst v = o[k];\nconst wrap = function (v) { return v; };\nwrap(1);\n"],
  ["a TypeScript __createBinding helper called", ES + "var __createBinding = (this && this.__createBinding) || (Object.create ? (function (o, m, k, k2) {\n  if (k2 === undefined) k2 = k;\n  Object.defineProperty(o, k2, { enumerable: true, get: function () { return m[k]; } });\n}) : (function (o, m, k, k2) {\n  if (k2 === undefined) k2 = k;\n  o[k2] = m[k];\n}));\nconst a = {}, b = { x: 1 };\n__createBinding(a, b, \"x\");\n"],
  ["a TypeScript __assign helper called", ES + "var __assign = (this && this.__assign) || function () {\n  __assign = Object.assign || function (t) {\n    for (var s, i = 1, n = arguments.length; i < n; i++) {\n      s = arguments[i];\n      for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p)) t[p] = s[p];\n    }\n    return t;\n  };\n  return __assign.apply(this, arguments);\n};\nvar d = __assign({}, { a: 1 });\n"],
  ["a Babel _extends helper called", ES + "function _extends() {\n  _extends = Object.assign ? Object.assign.bind() : function (target) {\n    for (var i = 1; i < arguments.length; i++) { var source = arguments[i]; for (var key in source) { target[key] = source[key]; } }\n    return target;\n  };\n  return _extends.apply(this, arguments);\n}\n_extends({}, { a: 1 });\n"],
  ["a stored table entry read with [0].length", "const T = { a: ['x'] };\nconst entry = T[process.platform];\nexports.n = entry[0].length;\n"],
  ["a stored table entry read with [0] + 1", "const T = { a: [1] };\nconst entry = T[process.platform];\nexports.n = entry[0] + 1;\n"],
  ["a stored table entry read with ?.[0]", "const PLATFORMS = { a: ['x'] };\nconst key = process.platform;\nconst entry = PLATFORMS[key];\nconst url = entry?.[0];\nexports.url = url;\n"],
  ["a stored table entry read with ?.[\"url\"]", "const PLATFORMS = { a: { url: 'x' } };\nconst key = process.platform;\nconst entry = PLATFORMS[key];\nconst url = entry?.[\"url\"];\nexports.url = url;\n"],
  ["a computed member stored and never called", `${K}const o = {};\nconst v = o[k];\nexports.v = v;\n`],
  ["a computed member stored and only read", `${K}const o = {};\nconst v = o[k];\nexports.n = v + 1;\n`],
  ["a stored name beside a call of another name", `${K}const o = {};\nconst v = o[k];\nconst f = () => 1;\nexports.v = v;\nf();\n`],
  ["a member with a quoted key stored and called", "const o = { a: () => 1 };\nconst f = o[\"a\"];\nf();\n"],
  ["a member with an empty-string key stored and called", "const o = { a: () => 1 };\nconst f = o[\"\"];\nf();\n"],
  ["an array stored by a number key", "const a = [[() => 1]];\nconst b = a[0];\nb[0]();\n"],
];
for (const [label, src] of stays) {
  test(`${label}: stays static`, () => {
    expect(provablyStatic(src)).toBe(true);
    expect(classifyJs("pkg/lib/x.js", src).all).toBe(false);
  });
}

// The read is charged: assignments with long values and many stored names stay under the step budget.
test("20,000 stored names each read once stay under the step budget without a fault", () => {
  let src = "const o = {};\n";
  for (let n = 0; n < 20000; n++) src += `const v${n} = o[k${n}];\n`;
  const before = scannerFaultCount();
  provablyStatic(src);
  expect(scannerFaultCount() - before).toBe(0);
});
test("a 4 MB text of assignments reads under a tight step limit without a fault", () => {
  const src = "a=1,b=2,".repeat(500_000) + "c=3;\n";
  allowFaults();
  setJsScanSteps(40 * src.length);
  try {
    const before = scannerFaultCount();
    provablyStatic(src);
    expect(scannerFaultCount() - before).toBe(0);
  } finally {
    setJsScanSteps(undefined);
  }
});

// Aliases set in reverse order of the file are followed one hop per pass: four hops are read, a fifth is a hold even when nothing calls it.
const rev = (names: string[], call: string) =>
  `${K}let ${names.join(", ")};\nfunction setup() { ${names.slice(1).map((n, x) => `${n} = ${names[x]!};`).reverse().join(" ")} }\n${names[0]} = function () {}[k];\n${call}\n`;
test("an alias four hops from a stored member, set in reverse order, then called: not static", () => {
  const src = rev(["f", "g", "h", "i", "j"], 'exports.main = () => j("return 1")();');
  expect(provablyStatic(src)).toBe(false);
  expect(classifyJs("pkg/lib/x.js", src).all).toBe(true);
});
test("an alias five hops from a stored member, set in reverse order, that nothing calls: held", () => {
  const src = rev(["f", "g", "h", "i", "j", "l"], "exports.l = l;");
  expect(provablyStatic(src)).toBe(false);
});

// The head of a function or class value is read up to its body, and every nested value is read to its end: both are charged, so a
// crafted text ends in a hold under the step budget in bounded time instead of a long read.
test("200,000 class heads before one distant body read in bounded time", () => {
  const src = "const o = {};\nconst k = 'x';\nconst v = o[k];\n" + "a=class ".repeat(200_000) + "{}\n";
  allowFaults();
  const t = performance.now();
  const before = scannerFaultCount();
  const verdict = provablyStatic(src);
  expect(performance.now() - t).toBeLessThan(5_000);
  expect(verdict === false || scannerFaultCount() > before).toBe(true);
});
// Each function in a group walks out through the group: the blanks before the group's parenthesis are read once per function, so they are charged.
test("5,000 functions in one group after 100,000 blanks read in bounded time and hold", () => {
  const src = "const o = {};\nconst k = 'x';\nt=o[k];\nx=" + " ".repeat(100_000) + "(" + "function(){}||".repeat(5_000) + "g);\n";
  allowFaults();
  setJsScanSteps(20 * src.length);
  try {
    const t = performance.now();
    const before = scannerFaultCount();
    const verdict = provablyStatic(src);
    expect(performance.now() - t).toBeLessThan(5_000);
    expect(verdict === false || scannerFaultCount() > before).toBe(true);
  } finally {
    setJsScanSteps(undefined);
  }
});
// A file over a million characters that is not static still names the files it loads: the file it requires is read as well.
test("a large file with a stored computed member still follows the file it requires", () => {
  const pad = "\n//" + "x".repeat(1_000_000);
  const pkg = (desc: string) => JSON.stringify({ name: "p", version: "1.0.0", description: desc, scripts: { postinstall: "node lib/hook.js" } });
  const mk = (desc: string): FileMap =>
    files({
      "package.json": pkg(desc),
      "lib/hook.js": 'const k = ["a"].join("");\nconst o = { a: () => 1 };\nconst f = o[k];\nf();\nrequire("./sub/helper.js");' + pad,
      "lib/sub/helper.js": 'require("child_process").execSync(process.env.npm_package_description);\n',
    });
  expect(holds(mk("one"), mk("two")).length).toBeGreaterThan(0);
});
test("3,000 nested stores with one computed member read in bounded time", () => {
  const src = "const o = {};\nconst k = 'x';\n" + "a=(".repeat(3_000) + "o[k]" + ")".repeat(3_000) + ";\n";
  allowFaults();
  const t = performance.now();
  const before = scannerFaultCount();
  const verdict = provablyStatic(src);
  expect(performance.now() - t).toBeLessThan(5_000);
  expect(verdict === false || scannerFaultCount() > before).toBe(true);
});
// A function value is read for its result, so nested function stores each re-reading their body are charged: a deep nest fails closed.
test("2,000 nested function stores with padding read in bounded time and hold", () => {
  const src = "const o = {};\nconst k = 'x';\nt=o[k];\n" + "a=function(){ ".repeat(2_000) + " ".repeat(200_000) + "}".repeat(2_000) + ";\n";
  allowFaults();
  setJsScanSteps(200 * src.length);
  try {
    const t = performance.now();
    const before = scannerFaultCount();
    const verdict = provablyStatic(src);
    expect(performance.now() - t).toBeLessThan(5_000);
    expect(verdict === false || scannerFaultCount() > before).toBe(true);
  } finally {
    setJsScanSteps(undefined);
  }
});
test("512 class heads sharing one body followed by blanks read in bounded time", () => {
  const src = "const o = {};\nconst k = 'x';\nt=o[k];\n" + "a=class ".repeat(512) + "{}" + " ".repeat(200_000) + "\nx\n";
  allowFaults();
  setJsScanSteps(20 * src.length);
  try {
    const t = performance.now();
    const before = scannerFaultCount();
    const verdict = provablyStatic(src);
    expect(performance.now() - t).toBeLessThan(5_000);
    expect(verdict === false || scannerFaultCount() > before).toBe(true);
  } finally {
    setJsScanSteps(undefined);
  }
});
