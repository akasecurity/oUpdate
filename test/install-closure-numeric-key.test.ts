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

// `k` is the string "constructor" built at run time, so no literal names it. A key that only looks like a number but can hold k
// reaches Function through [][k][k]("...")(): the file is not static and the hook widens.
const K = 'const k = ["con", "structor"].join("");\n';
const reaches: [string, string][] = [
  ["a key that starts with Symbol. then a comma", `${K}exports.main = () => [][Symbol.iterator, k][Symbol.iterator, k]("return 1")();\n`],
  ["a key that starts with Symbol. then &&", `${K}exports.main = () => [][Symbol.iterator && k][Symbol.iterator && k]("return 1")();\n`],
  ["a counter shadowed by a const", `let i = 0;\nfunction f() { const i = ["con", "structor"].join(""); return [][i][i]("return 1")(); }\nexports.f = f;\n`],
  ["a counter shadowed by a parameter", `let i = 0;\nfunction f(i) { return [][i][i]("return 1")(); }\nexports.f = () => f(["con", "structor"].join(""));\n`],
  ["a counter shadowed by a later parameter", `let i = 0;\nfunction f(a, i) { return [][i][i]("return 1")(); }\nexports.f = () => f(0, ["con", "structor"].join(""));\n`],
  ["a counter shadowed by a catch binding", `let i = 0;\ntry { throw ["con", "structor"].join(""); } catch (i) { [][i][i]("return 1")(); }\n`],
  ["a counter shadowed by a destructured parameter", `let i = 0;\nfunction f({ i }) { return [][i][i]("return 1")(); }\nexports.f = () => f({ i: ["con", "structor"].join("") });\n`],
  ["a counter shadowed by a destructured arrow parameter", `let i = 0;\nconst f = ({ i }) => [][i][i]("return 1")();\nexports.f = () => f({ i: ["con", "structor"].join("") });\n`],
  ["a counter set by array destructuring", `${K}let i = 0;\n[i] = [k];\nexports.main = () => [][i][i]("return 1")();\n`],
  ["a counter set by object destructuring", `${K}let i = 0;\n({ i } = { i: k });\nexports.main = () => [][i][i]("return 1")();\n`],
  ["a counter set by a renamed destructuring key", `${K}let i = 0;\n({ a: i } = { a: k });\nexports.main = () => [][i][i]("return 1")();\n`],
  ["a counter set by for-of", `${K}let i = 0;\nfor (i of [k]) ;\nexports.main = () => [][i][i]("return 1")();\n`],
  ["a counter set by for-in", `${K}const o = {};\no[k] = 1;\nlet i = 0;\nfor (i in o) ;\nexports.main = () => [][i][i]("return 1")();\n`],
  ["a counter read through with", `let i = 0;\nwith ({ i: ["con", "structor"].join("") }) { [][i][i]("return 1")(); }\n`],
  ["a declaration continued on the next line by ||", `${K}let i = 0\n|| k;\nexports.main = () => [][i][i]("return 1")();\n`],
  ["a for header continued by ||", `${K}let i;\nfor (i = 0 || k;;) break;\nexports.main = () => [][i][i]("return 1")();\n`],
  ["a for header continued by ?:", `${K}let i;\nfor (i = 0 ? 0 : k;;) break;\nexports.main = () => [][i][i]("return 1")();\n`],
  ["a Symbol name continued by &&", `${K}const s = Symbol && k;\nexports.main = () => [][s][s]("return 1")();\n`],
  ["a Symbol name continued by ?:", `${K}const s = Symbol.for ? k : 0;\nexports.main = () => [][s][s]("return 1")();\n`],
  ["a local Symbol", `${K}const Symbol = { iterator: k };\nexports.main = () => [][Symbol.iterator][Symbol.iterator]("return 1")();\n`],
  ["length of an object", `const o = { length: ["con", "structor"].join("") };\nexports.main = () => [][o.length][o.length]("return 1")();\n`],
  ["Math as a parameter", `function f(Math) { return [][Math.max()][Math.max()]("return 1")(); }\nexports.f = () => f({ max: () => ["con", "structor"].join("") });\n`],
  ["a local Math", `const Math = { max: () => ["con", "structor"].join("") };\nexports.main = () => [][Math.max()][Math.max()]("return 1")();\n`],
  ["a Math method replaced", `Math.max = () => ["con", "structor"].join("");\nexports.main = () => [][Math.max()][Math.max()]("return 1")();\n`],
  ["an octal escape in the key", 'exports.main = () => []["\\143onstructor"]["\\143onstructor"]("return 1")();\n'],
  ["an octal escape in a function key", 'exports.main = () => (() => {})["\\143onstructor"]("return 1")();\n'],
  ["a variable named of", `var of = [].map;\nexports.main = () => of[["con", "structor"].join("")]("return 1")();\n`],
  ["a variable named await", `var await = [].map;\nexports.main = () => await[["con", "structor"].join("")]("return 1")();\n`],
  ["a counter set through parentheses", `${K}let i = 0;\n(i) = k;\nexports.main = () => [][i][i]("return 1")();\n`],
  ["a counter set by &&=", `${K}let i = 1;\ni &&= k;\nexports.main = () => [][i][i]("return 1")();\n`],
  ["a counter set by ||=", `${K}let i = 0;\ni ||= k;\nexports.main = () => [][i][i]("return 1")();\n`],
  ["a counter set by a parenthesized for-of target", `${K}let i = 0;\nfor ((i) of [k]) ;\nexports.main = () => [][i][i]("return 1")();\n`],
  ["a function declared as Symbol", 'function Symbol() { return ["con", "structor"].join(""); }\nexports.main = () => [][Symbol()][Symbol()]("return 1")();\n'],
  ["a variable named of after return", 'var of = [].map;\nexports.main = () => { return of[["con", "structor"].join("")]("return 1")(); };\n'],
  ["a variable named of after an if condition", 'var of = [].map;\nexports.main = (c) => { if (c) of[["con", "structor"].join("")]("return 1")(); };\n'],
  ["a Math method replaced by array destructuring", `${K}[Math.max] = [() => k];\nexports.main = () => [][Math.max()][Math.max()]("return 1")();\n`],
  ["a Math method replaced by object destructuring", `${K}({ x: Math.max } = { x: () => k });\nexports.main = () => [][Math.max()][Math.max()]("return 1")();\n`],
  ["a Symbol method replaced by array destructuring", `${K}[Symbol.for] = [() => k];\nexports.main = () => [][Symbol.for("")][Symbol.for("")]("return 1")();\n`],
  ["a Math method replaced as a for-of target", `${K}for (Math.max of [() => k]) ;\nexports.main = () => [][Math.max()][Math.max()]("return 1")();\n`],
  ["a counter shadowed by a parameter after 600 uses", 'let i = 0;\n' + 'i;\n'.repeat(600) + 'function f(i) { return [][i][i]("return 1")(); }\nexports.f = () => f(["con", "structor"].join(""));\n'],
  ["a counter shadowed by a parameter after 520 uses of another name", 'let pad = 0;\n' + 'pad;\n'.repeat(520) + 'let i = 0;\nfunction f(i) { return [][i][i]("return 1")(); }\nexports.f = () => f(["con", "structor"].join(""));\n'],
  ["a counter set by a pattern after an if header", `${K}let i = 0;\nif (1) [i] = [k];\nexports.main = () => [][i][i]("return 1")();\n`],
  ["a Math method replaced by a pattern after a for header", `${K}for (const x of [0]) [Math.max] = [() => k];\nexports.main = () => [][Math.max()][Math.max()]("return 1")();\n`],
  ["a Math method replaced through parentheses", `${K}(Math.max) = () => k;\nexports.main = () => [][Math.max()][Math.max()]("return 1")();\n`],
  ["a Symbol method replaced through parentheses", `${K}(Symbol.for) = () => k;\nexports.main = () => [][Symbol.for("")][Symbol.for("")]("return 1")();\n`],
  ["a Math method replaced through parentheses in a pattern", `${K}[(Math.max)] = [() => k];\nexports.main = () => [][Math.max()][Math.max()]("return 1")();\n`],
  ["a Math method replaced as a parenthesized for-of target", `${K}for ((Math.max) of [() => k]);\nexports.main = () => [][Math.max()][Math.max()]("return 1")();\n`],
  ["a function declared as Symbol after many spaces", `function${" ".repeat(16)}Symbol() { return ["con", "structor"].join(""); }\nexports.main = () => [][Symbol()][Symbol()]("return 1")();\n`],
  ["a Math method replaced as a for-of target after many spaces", `${K}for (${" ".repeat(16)}Math.max of [() => k]);\nexports.main = () => [][Math.max()][Math.max()]("return 1")();\n`],
  ["a counter set through parentheses and 24 spaces", `${K}let i = 0;\n(i)${" ".repeat(24)}= k;\nexports.main = () => [][i][i]("return 1")();\n`],
  ["a counter set by for-in after 24 spaces", `${K}const o = {};\no[k] = 1;\nlet i = 0;\nfor (${" ".repeat(24)}i in o) ;\nexports.main = () => [][i][i]("return 1")();\n`],
  ["a counter set by a pattern after an if header longer than 4096 characters", `${K}let i = 0;\nif (${"1 + ".repeat(1100)}1) [i] = [k];\nexports.main = () => [][i][i]("return 1")();\n`],
  ["a counter set by a spread", `${K}let i = 0;\n[...i] = [k];\nexports.main = () => [][i][i]("return 1")();\n`],
  ["a variable named yield", `var yield = [].map;\nexports.main = () => yield[["con", "structor"].join("")]("return 1")();\n`],
  ["a length given by a shorthand key", `${K}const length = k;\nconst o = { length };\nexports.main = () => [][o.length][o.length]("return 1")();\n`],
  ["a length given by a getter", `${K}class C { get length() { return k; } }\nconst o = new C();\nexports.main = () => [][o.length][o.length]("return 1")();\n`],
  ["a length given by a class field after a step of a variable named length", `${K}let length = 0;\nlength += 1;\nclass C { length = k; }\nconst o = new C();\nexports.main = () => [][o.length][o.length]("return 1")();\n`],
  ["a length given by a shorthand key after a reassignment", `${K}let length = 0;\nlength = k;\nconst o = { length };\nexports.main = () => [][o.length][o.length]("return 1")();\n`],
  ["a length given by a shorthand key set by a destructuring default", `${K}const { length = k } = {};\nconst o = { length };\nexports.main = () => [][o.length][o.length]("return 1")();\n`],
  ["a length given by a shorthand key declared from a call", `${K}const length = String(k);\nconst o = { a: 1, length };\nexports.main = () => [][o.length][o.length]("return 1")();\n`],
  ["a length given by a shorthand key stepped by a string", `${K}let length = 0;\nlength += k;\nconst o = { length };\nexports.main = () => [][o.length][o.length]("return 1")();\n`],
  ["a length given by a shorthand key set by an array pattern", `${K}let length = 0;\n[length] = [k];\nconst o = { length };\nexports.main = () => [][o.length][o.length]("return 1")();\n`],
  ["a length given by a shorthand key of a parameter", `const f = (length) => ({ length });\nconst o = f(["con", "structor"].join(""));\nexports.main = () => [][o.length][o.length]("return 1")();\n`],
  ["a counter declared from a name set to a string", `${K}let s = 0;\ns = k;\nlet i = 0;\nexports.main = () => { for (let i = s; ;) return [][i][i]("return 1")(); };\n`],
  ["a counter declared from a parameter", `${K}let i = 0;\nconst f = (s) => { for (let i = s; ;) return [][i][i]("return 1")(); };\nexports.main = () => f(k);\n`],
  ["a counter declared from a name stepped by a string", `${K}let s = 0;\ns += k;\nlet i = 0;\nexports.main = () => { for (let i = s; ;) return [][i][i]("return 1")(); };\n`],
  ["a counter declared from a name set by a pattern", `${K}let s = 0;\n[s] = [k];\nlet i = 0;\nexports.main = () => { for (let i = s; ;) return [][i][i]("return 1")(); };\n`],
  ["a counter declared from a global the file never declares", "let i = 0;\nexports.main = () => { for (let i = name; ;) return [][i][i](\"return 1\")(); };\n"],
  ["a counter set by an array pattern with the = after 24 spaces", `${K}let i = 0;\n[i]${" ".repeat(24)}= [k];\nexports.main = () => [][i][i]("return 1")();\n`],
  ["a length given by a class field", `${K}class C { length = k; }\nconst o = new C();\nexports.main = () => [][o.length][o.length]("return 1")();\n`],
  ["a length given by an object on the line after the =", `${K}const o =\n  { length: k };\nexports.main = () => [][o.length][o.length]("return 1")();\n`],
  ["a length given by an object on the line after ||", `${K}const b = 0;\nconst o = b ||\n{ length: k };\nexports.main = () => [][o.length][o.length]("return 1")();\n`],
  ["a length given by a function whose body opens on the next line", `${K}const f = function ()\n{ return { length: k }; };\nconst o = f();\nexports.main = () => [][o.length][o.length]("return 1")();\n`],
  ["a counter shadowed by a var for-of binding", `${K}let i = 0;\nexports.main = () => { for (var i of [k]) { [][i][i]("return 1")(); } };\n`],
  ["a length given by an object in one branch and a pick in another", `${K}const o = true ? { length: k } : ({ a: [] }).a;\nexports.main = () => [][o.length][o.length]("return 1")();\n`],
  ["a length given by an object before || and a member", `${K}const o = { length: k } || a.b;\nexports.main = () => [][o.length][o.length]("return 1")();\n`],
  ["a length given by an object in a ternary before a member", `${K}const o = c ? { length: k } : d.e;\nexports.main = () => [][o.length][o.length]("return 1")();\n`],
  ["a length given by an object beside a comma pair", `${K}const o = true ? { length: k } : ({ length: 0 }, []);\nexports.main = () => [][o.length][o.length]("return 1")();\n`],
  ["a length given by an object returned from an arrow called in place", `${K}function f() { return (() => { return { length: k }; })(); }\nconst o = f();\nexports.main = () => [][o.length][o.length]("return 1")();\n`],
  ["a length given by an object returned from a nested function the outer one returns a call of", `${K}function f() { function g() { return { length: k }; } return g(); }\nconst o = f();\nexports.main = () => [][o.length][o.length]("return 1")();\n`],
  ["a length given by an object returned from a function expression called in place", `${K}function f() { return (function () { return { length: k }; })(); }\nconst o = f();\nexports.main = () => [][o.length][o.length]("return 1")();\n`],
  ["a length given by a field after static accessor and a line break", `${K}class C { static accessor\n length = k }\nconst o = new C();\nexports.main = () => [][o.length][o.length]("return 1")();\n`],
  ["a length given by a field after a private field named static", `${K}class C { #static\n length = k }\nconst o = new C();\nexports.main = () => [][o.length][o.length]("return 1")();\n`],
  ["a length given by an object with 40 blanks before the key", `${K}const o = {\n${" ".repeat(40)}length: k };\nexports.main = () => [][o.length][o.length]("return 1")();\n`],
  ["a length given by a field after 40 blanks past a member", `${K}class C { static x\n${" ".repeat(40)}length = k }\nconst o = new C();\nexports.main = () => [][o.length][o.length]("return 1")();\n`],
  ["a length given by a nested function whose call is returned in parentheses", `${K}function f() { function g() { return { length: k }; } return (g()); }\nconst o = f();\nexports.main = () => [][o.length][o.length]("return 1")();\n`],
  ["a length given by an arrow called in place inside parentheses", `${K}function f() { return ((() => { return { length: k }; })()); }\nconst o = f();\nexports.main = () => [][o.length][o.length]("return 1")();\n`],
  ["a length given by a nested function whose result is kept and returned", `${K}function f() { function g() { return { length: k }; } const r = g(); return r; }\nconst o = f();\nexports.main = () => [][o.length][o.length]("return 1")();\n`],
  ["a length given by a nested function called with ?.", `${K}function f() { function g() { return { length: k }; } return g?.(); }\nconst o = f();\nexports.main = () => [][o.length][o.length]("return 1")();\n`],
  ["a length given by a function the caller calls", `${K}function f() { return function () { return { length: k }; }; }\nconst o = f()();\nexports.main = () => [][o.length][o.length]("return 1")();\n`],
  ["a length given by an object with a number length and a spread", `${K}function f() { return { length: 0, ...{ length: k } }; }\nconst o = f();\nexports.main = () => [][o.length][o.length]("return 1")();\n`],
  ["a length given by an object with a number length and a computed key", `${K}const o = { length: 0, ["length"]: k };\nexports.main = () => [][o.length][o.length]("return 1")();\n`],
  ["a length given by a field after a member read from .static", `${K}class C { a = b.static\n  length = k }\nconst o = new C();\nexports.main = () => [][o.length][o.length]("return 1")();\n`],
  ["a length given by an object after a function expression in a ternary", `${K}const o = false ? function () {} : { length: k };\nexports.main = () => [][o.length][o.length]("return 1")();\n`],
  ["a length given by an object after a parenthesized function expression and &&", `${K}const o = (function () {}) && { length: k };\nexports.main = () => [][o.length][o.length]("return 1")();\n`],
  ["a length given by an object with a number length and a computed getter", `${K}const o = { length: 0, get ["length"]() { return k; } };\nexports.main = () => [][o.length][o.length]("return 1")();\n`],
  ["a length given by an arrow with a block body after a blank", `${K}const f = () => { return { length: k }; };\nconst o = f();\nexports.main = () => [][o.length][o.length]("return 1")();\n`],
  ["a counter set by a for-of after a braceless do while", `${K}let i = 0;\nfor (const i of xs)\n  do use(i.n)\n  while (c)\nfor (i of [k]) { [][i][i]("return 1")(); }\n`],
  ["a counter set by a for-of after a braced do while", `${K}let i = 0;\nfor (const i of xs)\n  do { use(i.n); } while (c);\nfor (i of [k]) { [][i][i]("return 1")(); }\n`],
  ["a counter set by ||= after a braced do while with an empty body", `${K}let i = 0;\nfor (const i of xs)\n  do {} while (0)\ni ||= k;\nexports.main = () => [][i][i]("return 1")();\n`],
  ["a counter set by a for-of after a braced do while, the key read before the loop", `${K}let i = 0;\nexports.main = () => [][i][i]("return 1")();\nfor (const i of xs)\n  do { use(i.n); } while (c);\nfor (i of [k]) ;\n`],
  ["a counter set by a for-of after a braced empty do while, the key read before the loop", `${K}let i = 0;\nexports.main = () => [][i][i]("return 1")();\nfor (const i of xs)\n  do {} while (0)\nfor (i of [k]) ;\n`],
  ["a counter set by a for-of after a braceless switch", `${K}let i = 0;\nfor (const i of xs)\n  switch (i) { case 1: use(i.n) }\nfor (i of [k]) { [][i][i]("return 1")(); }\n`],
  ["a counter set by ||= after a braceless try", `${K}let i = 0;\nfor (const i of xs)\n  try { use(i.n) } catch (e) { use(e) }\ni ||= k;\nexports.main = () => [][i][i]("return 1")();\n`],
  ["a length given by an object after an arrow in a ternary", `${K}const o = c ? () => 0 : { length: k };\nexports.main = () => [][o.length][o.length]("return 1")();\n`],
  ["a length given by an object after a parenthesized arrow and ||", `${K}const o = (() => 0) || { length: k };\nexports.main = () => [][o.length][o.length]("return 1")();\n`],
  ["a length given by an object with a number length and a computed getter after 20 blanks", `${K}const o = { length: 0, get${" ".repeat(20)}["length"]() { return k; } };\nexports.main = () => [][o.length][o.length]("return 1")();\n`],
  ["a counter shadowed by a nested destructured parameter", `let i = 0;\nfunction f([{ a: i }]) { return [][i][i]("return 1")(); }\nexports.f = () => f([{ a: ["con", "structor"].join("") }]);\n`],
];

// These held before the numeric reading too: they pin that it does not lose them.
const pinned: [string, string][] = [
  ["a counter set after 24 spaces", `${K}let i = 0;\ni${" ".repeat(24)}= k;\nexports.main = () => [][i][i]("return 1")();\n`],
  ["a counter stepped by k after 24 spaces (+=)", `${K}let i = 0;\ni${" ".repeat(24)}+= k;\nexports.main = () => [][i][i]("return 1")();\n`],
  ["a counter stepped by k after 24 spaces (-=)", `${K}let i = 0;\ni${" ".repeat(24)}-= k;\nexports.main = () => [][i][i]("return 1")();\n`],
  ["a counter multiplied in place after 24 spaces", `const a = [() => 1];\nlet i = 0;\ni${" ".repeat(24)}*= 2;\na[i]();\n`],
  ["a counter stepped by a negative literal (+=)", "const a = [() => 1];\nlet i = 0;\ni += -1;\na[i]();\n"],
  ["a counter stepped by a negative literal (-=)", "const a = [() => 1];\nlet i = 0;\ni -= -1;\na[i]();\n"],
  ["a Symbol set in a for header that declares nothing", "const a = [() => 1];\nfor (i = Symbol.iterator;;) { a[i](); break; }\n"],
  ["a counter multiplied in place", "const a = [() => 1];\nlet i = 0;\ni *= 2;\na[i]();\n"],
  ["a counter stepped by k on the line after a --", `${K}const a = [() => 1];\nlet y = 1;\nlet i = 0;\ny--\ni += k;\na[i]();\n`],
  ["a counter shadowed by a parameter default", `let i = 0;\nfunction f(i = ["con", "structor"].join("")) { return [][i][i]("return 1")(); }\nexports.f = f;\n`],
  ["a counter set by a destructuring default", `${K}let i = 0;\n({ i = k } = {});\nexports.main = () => [][i][i]("return 1")();\n`],
  ["a counter beside an unparenthesized arrow parameter of the same name", `${K}let i = 0;\ni = k;\nconst f = i=>i+1;\nexports.f = f;\nexports.main = () => [][i][i]("return 1")();\n`],
  ["a counter set on the line after an expression-bodied arrow", `${K}let i = 0;\nconst g = i => 0\ni = k;\nexports.main = () => [][i][i]("return 1")();\n`],
  ["a counter set in the other branch of a ?: after an arrow", `${K}let i = 0;\nconst g = 0 ? (i) => 0 : i = k;\nexports.main = () => [][i][i]("return 1")();\n`],
  ["a counter set in a block after a call", `${K}let i = 0;\nString(i)\n{ i = k; }\nexports.main = () => [][i][i]("return 1")();\n`],
  ["a counter set in a static block of a class whose base is a call", `${K}let i = 0;\nconst f = (x) => Object;\nclass A extends f(i) { static { i = k; } }\nexports.main = () => [][i][i]("return 1")();\n`],
  ["a counter set after a semicolon-free arrow, read before it", `${K}let i = 0\nexports.main = () => [][i][i]("return 1")();\nconst g = (i) => 0\ni = k\n`],
  ["a counter whose name an unparenthesized arrow parameter reuses", "const a = [() => 1];\nlet i = 0;\na[i]();\nconst f = i=>i+1;\nexports.f = f;\n"],
  ["a counter set from the length of an object", `const o = { length: ["con", "structor"].join("") };\nlet i = o.length;\nexports.main = () => [][i][i]("return 1")();\n`],
  ["a counter set from a length plus a string", `${K}const a = [1];\nlet i = a.length + k;\nexports.main = () => [][i][i]("return 1")();\n`],
  ["a counter set from a length that is a string", `${K}const length = k;\nconst o = { length };\nlet i = o.length;\nexports.main = () => [][i][i]("return 1")();\n`],
  ["a counter shadowed by a destructured parameter with a default", `let i = 0;\nconst f = ({ i = 0 }) => [][i][i]("return 1")();\nexports.f = () => f({ i: ["con", "structor"].join("") });\n`],
];

for (const [label, src] of [...reaches, ...pinned.map(([l, v]) => [`pin: ${l}, held on main too`, v] as [string, string])]) {
  test(`${label}: not static, the hazard widens and a changed payload holds`, () => {
    expect(provablyStatic(src)).toBe(false);
    expect(classifyJs("pkg/lib/x.js", src).all).toBe(true);
    expect(widensDocs(src)).toBe(true);
  });
}

// What the numeric reading is for: counters, a fixed array's length, Math and Symbol keys stay static.
const stays: [string, string][] = [
  ["a counter loop", "const a = [() => 1];\nfor (let i = 0; i < a.length; i++) a[i]();\n"],
  ["two loops with the same counter", "const a = [() => 1];\nfor (let i = 0; i < a.length; i++) a[i]();\nfor (let i = 0; i < 2; i += 1) a[i]();\n"],
  ["nested counters", "const g = [[() => 1]];\nfor (let r = 0; r < 1; r++) for (let c = 0; c < 1; c++) g[r][c]();\n"],
  ["a counter with no semicolons", "const a = [() => 1]\nlet i = 0\nwhile (i < 1) { a[i](); i++ }\n"],
  ["an index from the end of a fixed array", "const a = [() => 1];\na[a.length - 1]();\n"],
  ["a Math key", "const a = [() => 1];\na[Math.floor(1 / 2)]();\n"],
  ["a guarded Symbol key", "exports.i = (n, e) => null != e && \"undefined\" != typeof Symbol && e[Symbol.hasInstance] ? !!e[Symbol.hasInstance](n) : n instanceof e;\n"],
  ["a Symbol key", "const o = { [Symbol.iterator]: () => 1 };\no[Symbol.iterator]();\n"],
  ["a counter with more than 512 uses", "const a = [() => 1];\nlet i = 0;\n" + "i++;\n".repeat(520) + "a[i]();\n"],
  ["a counter read with no semicolons", "const a = [() => 1]\nfor (let i = 0; i < a.length; i++) {\n  const n = i\n  a[i]()\n}\n"],
  ["a for-of over an indexed array literal after a destructuring head", "const a = [[() => 1]];\nfor (const [f] of [a][0]) f();\n"],
  ["a minified for-of over an indexed array literal", "const a = [[() => 1]];\nfor(const[f]of[a][0])f();\n"],
  ["a destructuring default that reads Math", "const a = [() => 1];\nconst { random = Math.random } = {};\nexports.r = random;\na[Math.floor(1 / 2)]();\n"],
  ["a parameter elsewhere named like a counter", "const a = [() => 1];\nfor (let i = 0; i < 1; i++) a[i]();\nfunction f(i) { return i + 1; }\nexports.f = f;\n"],
  ["an arrow parameter elsewhere named like a counter", "const a = [() => 1];\nfor (let i = 0; i < 1; i++) a[i]();\nexports.g = [1].map((x, i) => x + i);\nexports.h = (i) => i;\n"],
  ["a counter inside 33 groups", "const a = [() => 1];\nlet i = 0;\n" + "(".repeat(33) + "i" + ")".repeat(33) + ";\na[i]();\n"],
  ["a method read on a counter", "const a = [() => 1];\nfor (let i = 0; i < 1; i++) { console.log(i.toString(16)); a[i](); }\n"],
  ["a for-of over an array literal then an index", "const a = [() => 1];\nfor (const f of [a][0]) f();\n"],
  ["a counter counting down from a length", "const g = [[() => 1]];\nfor (let i = 0; i < 1; i++) g[i][0]();\nfor (let i = g.length - 1; i >= 0; i--) g[i][0]();\n"],
  ["a counter declared from a counted name set in place", "const a = [[() => 1]];\nlet start = 0;\nfor (let i = 0; i < 1; i++) start = i;\nfor (let i = start; i < 1; ++i) a[i][0]();\n"],
  ["counters declared from each other", "const a = [[() => 1]];\nlet end = a.length;\nfor (let i = 0; i < end; i++) end = i + 1;\nfor (let i = end - 1; i >= 0; --i) a[i][0]();\n"],
  ["a counter beside a semicolon-free arrow with a parameter of the same name", "const handlers = [() => 1]\nlet i = 0\nconst next = (i) => i + 1\nfor (; i < 1; i++) handlers[i]()\nexports.next = next\n"],
  ["a counter beside a class method with a parameter of the same name", "const a = [() => 1];\nfor (let i = 0; i < 1; i++) a[i]();\nclass C { m(i) { return i + 1; } }\nexports.C = C;\n"],
  ["a counter beside an object method with a parameter of the same name", "const a = [() => 1];\nfor (let i = 0; i < 1; i++) a[i]();\nexports.o = { m(i) { return i + 1; } };\n"],
  ["a counter beside a catch binding of the same name", "const a = [() => 1];\nfor (let e = 0; e < 1; e++) a[e]();\ntry { a[0](); } catch (e) { console.log(e); }\n"],
  ["a counter beside a rest parameter of the same name", "const a = [() => 1];\nfor (let r = 0; r < 1; r++) a[r]();\nexports.g = (...r) => r;\n"],
  ["a counter beside a method of an exported default object", "const a = [() => 1];\nfor (let i = 0; i < 1; i++) a[i]();\nexport default { m(i) { return i + 1; } };\n"],
  ["a counter beside a method of an object after ||", "const a = [() => 1];\nfor (let i = 0; i < 1; i++) a[i]();\nexports.o = exports.o || { m(i) { return i + 1; } };\n"],
  ["a counter beside a method of an object after ??", "const a = [() => 1];\nfor (let i = 0; i < 1; i++) a[i]();\nexports.o = exports.o ?? { m(i) { return i + 1; } };\n"],
  ["a counter beside a method of an object after !", "const a = [() => 1];\nfor (let i = 0; i < 1; i++) a[i]();\nexports.o = !{ m(i) { return i + 1; } };\n"],
  ["a counter beside a method of an object after yield", "const a = [() => 1];\nfor (let i = 0; i < 1; i++) a[i]();\nexports.g = function* () { yield { m(i) { return i + 1; } }; };\n"],
  ["a counter beside a method of a class whose base is a call", "const a = [() => 1];\nfor (let i = 0; i < 1; i++) a[i]();\nconst mixin = (B) => B;\nclass B {}\nclass A extends mixin(B) { m(i) { return i + 1; } }\nexports.A = A;\n"],
  ["a counter beside a method after a field with no semicolon", "const a = [() => 1];\nfor (let i = 0; i < 1; i++) a[i]();\nclass A {\n  count = 0\n  add(i) { return i + 1; }\n}\nexports.A = A;\n"],
  ["a counter beside a computed method name", "const a = [() => 1];\nfor (let i = 0; i < 1; i++) a[i]();\nconst n = \"m\";\nexports.o = { [n](i) { return i + 1; } };\n"],
  ["a counter beside a quoted method name", "const a = [() => 1];\nfor (let i = 0; i < 1; i++) a[i]();\nexports.o = { \"m\"(i) { return i + 1; } };\n"],
  ["a counter beside a function with a default parameter after it", "const a = [() => 1];\nfor (let i = 0; i < 1; i++) a[i]();\nfunction f(i, opts = {}) { return i + opts; }\nexports.f = f;\n"],
  ["the last element of a new Array beside a class with a length field", "class C { length = 0; }\nexports.C = C;\nconst a = [() => 1];\nconst x = new Array(2);\na[x.length - 1]();\n"],
  ["the last row of a grid made by Array.from", "exports.run = (h, w) => {\n  const grid = Array.from({ length: h }, () => Array.from({ length: w }, () => () => 1));\n  return grid[grid.length - 1][0]();\n};\n"],
  ["a counter beside a regular expression flag of the same letter", "const a = [[() => 1]];\nfor (var i = 0; i < 1; i++) a[i][0]();\nexports.t = (s) => /x/i.test(s);\n"],
  ["the last element of Array.of a variable named length", "const length = 0;\nconst x = Array.of(length, () => 1);\nx[x.length - 1]();\n"],
  ["a counter beside a destructured parameter of the same name", "const a = [() => 1];\nfor (let i = 0; i < 1; i++) a[i]();\nexports.f = ({ i }) => i;\n"],
  ["a counter beside a braceless for-of in code with no semicolons", "const a = [() => 1]\nfor (const i of [1]) console.log(i)\nfor (let i = 0; i < 1; i++) a[i]()\n"],
  ["a counter beside a braceless for-in over a comma body", "const a = [() => 1]\nfor (const i in [1]) console.log(i), a.length\nfor (let i = 0; i < 1; i++) a[i]()\n"],
  ["a counter beside a braceless for-of over an if", "const a = [() => 1]\nfor (let i = 0; i < 1; i++) a[i]()\nfor (const i of [{ n: 1 }])\n  if (i)\n    console.log(i.n)\n"],
  ["a counter beside a braceless for-of over an if and an else", "const a = [() => 1]\nfor (let i = 0; i < 1; i++) a[i]()\nfor (const i of [{ n: 1 }])\n  if (i) f(i)\n  else g(i.n)\n"],
  ["a counter beside a braceless for-of over a nested for-of", "const a = [() => 1]\nfor (let i = 0; i < 1; i++) a[i]()\nfor (const i of xs)\n  for (const j of ys)\n    use(i.n)\n"],
  ["a counter beside a braceless for-of over a while", "const a = [() => 1]\nfor (let i = 0; i < 1; i++) a[i]()\nfor (const i of xs)\n  while (c)\n    use(i.n)\n"],
  ["a counter beside a braceless for-of over a do while", "const a = [() => 1]\nfor (let i = 0; i < 1; i++) a[i]()\n" + "for (const i of xs)\n  do { use(i.n); } while (c)\n"],
  ["a counter beside a braceless for-of over a switch with the brace on the next line", "const a = [() => 1]\nfor (let i = 0; i < 1; i++) a[i]()\n" + "for (const i of xs)\n  switch (i.n)\n  {\n  case 1: use(i.n)\n  }\n"],
  ["a counter beside a braceless for-of over a try with the catch on the next line", "const a = [() => 1]\nfor (let i = 0; i < 1; i++) a[i]()\n" + "for (const i of xs)\n  try { use(i.n); }\n  catch (e) { use(i.m); }\n"],
  ["a counter beside a braceless for-of over a labelled loop", "const a = [() => 1]\nfor (let i = 0; i < 1; i++) a[i]()\n" + "for (const i of xs)\n  lab: for (const j of ys) use(i.n)\n"],
  ["a counter loop after a braceless for-of over a braced do while", "const a = [() => 1]\nfor (let i = 0; i < 1; i++) a[i]()\n" + "for (const i of xs)\n  do { use(i.n); } while (c);\nfor (let i = 0; i < 1; i++) a[i]()\n"],
  ["a counter loop and a parameter named like it after a braceless for-of over a braced do while", "const a = [() => 1]\nfor (let i = 0; i < 1; i++) a[i]()\n" + "for (const i of xs)\n  do { use(i.n); } while (c);\nexports.q = (i) => i + 1\nfor (let i = 0; i < 1; i++) a[i]()\n"],
  ["a counter beside a const for-of binding of the same name", "const a = [() => 1];\nfor (let i = 0; i < 1; i++) a[i]();\nfor (const i of [1]) console.log(i);\n"],
  ["a counter beside a let for-of pattern of the same name", "const a = [() => 1];\nfor (let i = 0; i < 1; i++) a[i]();\nfor (let [i] of [[1]]) console.log(i);\n"],
  ...["|=", "&=", "^=", "<<=", ">>=", ">>>=", "**="].map((op) => [`a counter set in place by ${op} 1`, `const a = [() => 1];\nlet i = 0;\ni ${op} 1;\na[i]();\n`] as [string, string]),
];
for (const [label, src] of stays) {
  test(`${label}: stays static`, () => {
    expect(provablyStatic(src)).toBe(true);
    expect(classifyJs("pkg/lib/x.js", src).all).toBe(false);
  });
}

// The length of each fixed array is read from one index of the file, not a rescan per name.
test("8,000 fixed arrays each indexed by its own length are read from one index, under the step budget, and stay static", () => {
  let src = "";
  for (let n = 0; n < 8000; n++) src += `const a${n} = [() => 1]; a${n}[a${n}.length - 1]();\n`;
  const before = scannerFaultCount();
  const t = performance.now();
  expect(provablyStatic(src)).toBe(true);
  expect(scannerFaultCount() - before).toBe(0);
  expect(performance.now() - t).toBeLessThan(10_000); // a rescan per name took seconds; the bound only catches that
});

// Parameter spans are indexed: a use asks one binary search, not every span (300,000 arrows each with a parameter i).
test("300,000 arrows with a parameter named like a counter read under the step budget and stay static", () => {
  const src = "const a = [() => 1];\nfor (let i = 0; i < 1; i++) a[i]();\n" + "(i)=>0;".repeat(300_000);
  const before = scannerFaultCount();
  const t = performance.now();
  expect(provablyStatic(src)).toBe(true);
  expect(scannerFaultCount() - before).toBe(0);
  expect(performance.now() - t).toBeLessThan(10_000); // a scan of every span per use took minutes; the bound only catches that
});

// Every level of the binding climb is charged, also when its brackets are adjacent: a deep group around many uses trips the
// budget (and holds) instead of running uncharged.
test("a counter used 2,000 times inside 100,000 groups is charged per level and ends", () => {
  allowFaults(); // the budget trip is the point: it reads as a hold
  const src = "const a = [() => 1];\nlet i = 0;\n" + "(".repeat(100_000) + "i,".repeat(2000) + "0" + ")".repeat(100_000) + ";\na[i]();\n";
  const t = performance.now();
  expect(provablyStatic(src)).toBe(false);
  expect(performance.now() - t).toBeLessThan(10_000);
});

// A name many counters start from is read once: its value's trailing blanks are not walked again per counter.
test("4,000 counters declared from one name set before 8 MB of blanks read under the step budget and stay static", () => {
  const src = "const a = [() => 1];\nlet s = 0" + " ".repeat(8 * 1024 * 1024) + ";\n" + "for (let i = s;;) break;\n".repeat(4000) + "for (let i = 0; i < 1; i++) a[i]();\n";
  const before = scannerFaultCount();
  expect(provablyStatic(src)).toBe(true);
  expect(scannerFaultCount() - before).toBe(0);
});

// Budget rows for the cost the reading must charge or avoid. Each runs under a fixed step limit of 40 per character, about twice
// what the reading spends on it (a step count is the same on every machine), so a reading that spends more faults here. Where the
// previous head's cost was uncharged, it spent no steps on it and only the wall-time bound sees it.
const fast = (src: string) => {
  setJsScanSteps(40 * src.length);
  try {
    const before = scannerFaultCount();
    const t = performance.now();
    const v = provablyStatic(src);
    return { v, faults: scannerFaultCount() - before, ms: performance.now() - t };
  } finally {
    setJsScanSteps(undefined);
  }
};
test("a 4 MB method name before a list of a counter's name is walked with a bound", () => {
  const r = fast("const a = [() => 1];\nlet i = 0;\na[i]();\nexports.o = ({" + "A".repeat(4 * 1024 * 1024) + "(" + "i,".repeat(2000) + "i) {}});\n");
  expect(r.v).toBe(true);
  expect(r.faults).toBe(0);
  expect(r.ms).toBeLessThan(10_000); // the old walk was uncharged (about 23 s)
});
test("300 counters read main's counter reading once, under the step budget", () => {
  const src = Array.from({ length: 300 }, (_, i) => `let c${i} = 0; c${i}++;`).join("\n") + "\nconst a = [() => 1];\n" + Array.from({ length: 300 }, (_, i) => `a[c${i}]();`).join("\n") + "\n" + "x;".repeat(200_000);
  const r = fast(src);
  expect(r.v).toBe(true);
  expect(r.faults).toBe(0); // the old reading charged the whole file per name and tripped the budget
});

// Walking the nested function heads of a text for the returns of an outer function is linear in steps.

test("3,000 braceless ifs with elses after a for-of are read under the step budget and stay static", () => {
  // for (const i of xs) if (c) f(i) else if (c) f(i) ... else g(i.n): the use of i.n at the end is the loop's only if the chain is read through
  const src = "const a = [() => 1]\nfor (let i = 0; i < 1; i++) a[i]()\nfor (const i of xs)\n" + "if (c) f(i)\nelse ".repeat(3000) + "g(i.n)\n";
  setJsScanSteps(40 * src.length);
  try {
    const before = scannerFaultCount();
    expect(provablyStatic(src)).toBe(true);
    expect(scannerFaultCount() - before).toBe(0);
  } finally {
    setJsScanSteps(undefined);
  }
});
