import { expect, test } from "bun:test";
import { classifyJs, provablyStatic, scannerFaultCount, setJsScanSteps } from "../src/install-closure.ts";
import { allowFaults } from "./fault-guard.ts";
import { prepass, type FileMap } from "../src/prepass.ts";

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

// An object's length that the file makes up without spelling a literal { length: ... } is "constructor", so a key o.length reaches
// Function through o[o.length][o.length]("...")(). x.length is a number only when x is provably an array or a string: a literal, a
// template, a call known to give one on such a value, or a name every assignment of which is one of those.
const K = '["con", "structor"].join("")';
const chain = 'exports.main = (v) => v[o.length][o.length]("return 1")();\n';
const reaches: [string, string][] = [
  ["length from JSON.parse", `const o = JSON.parse('{"length":"constructor"}');\n${chain}`],
  ["length from Object.defineProperty", `const o = {};\nObject.defineProperty(o, "length", { value: ${K} });\n${chain}`],
  ["length from Object.defineProperties", `const o = {};\nObject.defineProperties(o, { length: { value: ${K} } });\n${chain}`],
  ["length from Object.assign", `const o = Object.assign({}, { length: ${K} });\n${chain}`],
  ["length from Object.fromEntries", `const o = Object.fromEntries([["length", ${K}]]);\n${chain}`],
  ["length from Reflect.set", `const o = {};\nReflect.set(o, "length", ${K});\n${chain}`],
  ["length from a Proxy", `const o = new Proxy({}, { get: () => ${K} });\n${chain}`],
  ["length from Object.create with a prototype", `const o = Object.create({ length: ${K} });\n${chain}`],
  ["length from __proto__", `const o = { __proto__: { length: ${K} } };\n${chain}`],
  ["length from Object.freeze of a literal", `const o = Object.freeze({ length: ${K} });\n${chain}`],
  ["length of an object picked out of an array", `const o = [{ length: ${K} }][0];\n${chain}`],
  ["length set through a string key", `const o = {};\no["length"] = ${K};\n${chain}`],
  ["pin: length of this, held on main too", `exports.main = function () { return this[this.length][this.length]("return 1")(); };\nexports.run = () => exports.main.call({ length: ${K} });\n`],
  ["a static length of a class", `class C { static length = ${K}; }\nexports.main = (v) => v[C.length][C.length]("return 1")();\n`],
  ["length on a prototype", `function C() {}\nC.prototype.length = ${K};\nconst o = new C();\n${chain}`],
  ["length from a required JSON file", `const o = require("./d.json");\n${chain}`],
  ["length through a parameter", `function f(o) { return o[o.length][o.length]("return 1")(); }\nexports.f = () => f(JSON.parse('{"length":"constructor"}'));\n`],
  ["length of a function after defineProperty", `function f() {}\nObject.defineProperty(f, "length", { value: ${K} });\nexports.main = (v) => v[f.length][f.length]("return 1")();\n`],
  ["length on Object.prototype", `Object.prototype.length = ${K};\nconst o = {};\n${chain}`],
  ["length on Object.prototype by ??=", `Object.prototype.length ??= ${K};\nconst o = {};\n${chain}`],
  ["length on Object.prototype through an alias", `const P = Object.prototype;\nP.length = ${K};\nconst o = {};\n${chain}`],
  ["pin: a counter set from a made-up length, held on main too", `const o = JSON.parse('{"length":"constructor"}');\nlet i = o.length;\nexports.main = (v) => v[i][i]("return 1")();\n`],
  ["an array made by Object.keys after Object.keys is replaced through an alias", `const O = Object;\nO[["ke", "ys"].join("")] = () => ({ length: ${K} });\nconst o = Object.keys({});\n${chain}`],
  ["an array made by Object.keys after Object.keys is replaced", `Object.keys = () => ({ length: ${K} });\nconst o = Object.keys({});\n${chain}`],
  ["an array made by Array.from after Object is read through a pattern", `const { [["fro", "m"].join("")]: d } = Array;\nArray.from = () => ({ length: ${K} });\nconst o = Array.from([]);\n${chain}`],
  ["a split replaced on String.prototype", `String.prototype.split = () => ({ length: ${K} });\nconst o = "a,b".split(",");\n${chain}`],
  ["a map replaced on Array.prototype", `Array.prototype.map = () => ({ length: ${K} });\nconst o = [1].map((v) => v);\n${chain}`],
  ["a slice replaced through an alias of Array.prototype", `const A = Array.prototype;\nA.slice = () => ({ length: ${K} });\nconst a = [1];\nconst o = a.slice();\n${chain}`],
  ["a split given an object with its own Symbol.split", `const sep = { [Symbol.split]: () => ({ length: ${K} }) };\nconst o = "a,b".split(sep);\n${chain}`],
  ["a species put on an array a method is called on", `const a = [1];\na.constructor = { [Symbol.species]: function () { return { length: ${K} }; } };\nconst o = a.map((v) => v);\n${chain}`],
  ["a slice replaced through Array.prototype.__proto__", `Array.prototype.__proto__.slice = () => ({ length: ${K} });\nconst a = [1];\nconst o = a.slice();\n${chain}`],
  ["a slice replaced through .constructor.prototype", `[].constructor.prototype.slice = () => ({ length: ${K} });\nconst a = [1];\nconst o = a.slice();\n${chain}`],
  ["a slice replaced through getPrototypeOf", `Object.getPrototypeOf([]).slice = () => ({ length: ${K} });\nconst a = [1];\nconst o = a.slice();\n${chain}`],
  ["Math.max put back through Math.__proto__", `delete Math.max;\nMath.__proto__.max = () => ${K};\nexports.main = (v) => v[Math.max()][Math.max()]("return 1")();\n`],
  ["a map replaced through a computed __proto__ key on a literal", `const c = ["__pro", "to__"].join("");\n[][c].map = () => ({ length: ${K} });\nconst o = [1].map((v) => v);\n${chain}`],
  ["a map replaced through a prototype held in a name", `const c = ["__pro", "to__"].join("");\nconst p = [][c];\np.map = () => ({ length: ${K} });\nconst o = [1].map((v) => v);\n${chain}`],
  ["a map replaced through a computed member of a name", `const c = ["__pro", "to__"].join("");\nconst a = [1];\na[c].map = () => ({ length: ${K} });\nconst o = [1].map((v) => v);\n${chain}`],
  ["a map replaced through a string __proto__ key on a literal", `[]["__proto__"].map = () => ({ length: ${K} });\nconst o = [1].map((v) => v);\n${chain}`],
  ["Object.keys replaced through a computed key on an object literal", `const c = ["__pro", "to__"].join("");\n({})[c].keys = () => ({ length: ${K} });\nconst o = Object.keys({});\n${chain}`],
  ["a slice replaced through defineProperty on a computed member", `const c = ["__pro", "to__"].join("");\nconst a = [1];\nObject.defineProperty(a[c], "slice", { value: () => ({ length: ${K} }) });\nconst o = [1].slice();\n${chain}`],
  ["a species written by a callback to its array argument", `const a = [1];\na.forEach((v, i, arr) => { arr.constructor = { [Symbol.species]: function () { return { length: ${K} }; } }; });\nconst o = a.slice();\n${chain}`],
  ["a species written through the array reverse returns", `const a = [1];\nconst b = a.reverse();\nb.constructor = { [Symbol.species]: function () { return { length: ${K} }; } };\nconst o = a.slice();\n${chain}`],
  ["a species written through the array sort returns", `const a = [1];\nconst b = a.sort();\nb.constructor = { [Symbol.species]: function () { return { length: ${K} }; } };\nconst o = a.slice();\n${chain}`],
  ["a built-in rebound by a with statement on an object the file got elsewhere", `const ctx = JSON.parse('{"Object":{}}');\nwith (ctx) { exports.o = Object.keys({}); }\nconst o = Object.keys({});\n${chain}`],
  ["a parameter with an array default beside a declaration of the name", `const o = [1];\nfunction g(o = [2]) { return o[o.length][o.length]("return 1")(); }\nexports.g = () => g(JSON.parse('{"length":"constructor"}'));\nexports.o = o;\n`],
  ["Array.prototype.__defineGetter__ replaces map", `Array.prototype.__defineGetter__("map", () => () => ({ length: ${K} }));\nconst o = [1].map((v) => v);\n${chain}`],
  ["Object.__defineGetter__ replaces keys", `Object.__defineGetter__("keys", () => () => ({ length: ${K} }));\nconst o = Object.keys({});\n${chain}`],
  ["Array.__defineGetter__ puts a species", `Array.__defineGetter__(Symbol.species, () => function () { return { length: ${K} }; });\nconst o = [1].slice();\n${chain}`],
  ["pin: a name with __defineGetter__ given a species, held on main too", `const a = [1];\na.__defineGetter__("constructor", () => ({ [Symbol.species]: function () { return { length: ${K} }; } }));\nconst o = a.slice();\n${chain}`],
  ["a name read through __lookupGetter__", `const a = [1];\nconst g = a.__lookupGetter__("x");\nconst o = a.slice();\n${chain}`],
  ["pin: a computed write at depth two with no alias, held on main too", `const c = ["__pro", "to__"].join("");\nconst a = [1];\na[c]["map"] = () => ({ length: ${K} });\nconst o = [1].map((v) => v);\n${chain}`],
  ["a string-key write at depth two", `const a = [1];\na["__proto__"]["map"] = () => ({ length: ${K} });\nconst o = [1].map((v) => v);\n${chain}`],
  ["a member written through a name given a computed member", `const c = ["__pro", "to__"].join("");\nconst a = [1];\nconst p = a[c];\np.map = () => ({ length: ${K} });\nconst o = [1].map((v) => v);\n${chain}`],
  ["a member written through a second name for a computed member", `const c = ["__pro", "to__"].join("");\nconst a = [1];\nconst p = a[c];\nconst q = p;\nq.map = () => ({ length: ${K} });\nconst o = [1].map((v) => v);\n${chain}`],
  ["an element written through a name given a computed member", `const c = ["__pro", "to__"].join("");\nconst a = [1];\nconst p = a[c];\np[["ma", "p"].join("")] = () => ({ length: ${K} });\nconst o = [1].map((v) => v);\n${chain}`],
  ["defineProperty given a name that holds a computed member", `const c = ["__pro", "to__"].join("");\nconst a = [1];\nconst p = a[c];\nObject.defineProperty(p, "map", { value: () => ({ length: ${K} }) });\nconst o = [1].map((v) => v);\n${chain}`],
  ["a use of a name outside the block that declares it", `function f() { const o = [1]; return o; }\nexports.f = f;\nexports.main = (v) => v[o.length][o.length]("return 1")();\n`],
  ["a use after the block of a declaration inside an if", `if (exports.x) { const o = [1]; exports.y = o; }\nexports.main = (v) => v[o.length][o.length]("return 1")();\n`],
  ["a write inside a link of a longer chain", `const c = ["__pro", "to__"].join("");\nconst x = [[1]];\nconst y = [1];\nx[0][y[c].map = () => ({ length: ${K} })];\nconst o = [1].map((v) => v);\n${chain}`],
  ["a write inside a link of a longer chain with a compound operator", `const c = ["__pro", "to__"].join("");\nconst x = [[1]];\nconst y = [1];\nx[0][y[c].map ??= () => ({ length: ${K} })];\nconst o = [1].map((v) => v);\n${chain}`],
  ["a name rebound by a with statement", `const o = [1];\nwith ({ o: { length: ${K} } }) { o[o.length][o.length]("return 1")(); }\n`],
  ["a built-in rebound by a with statement", `with ({ Object: { keys: () => ({ length: ${K} }) } }) { exports.o = Object.keys({}); }\nconst o = Object.keys({});\n${chain}`],
  ["an imported name beside an inner declaration of it", `import o from "./d.js";\nfunction f() { const o = [1]; return o; }\nexports.f = f;\nexports.main = (v) => v[o.length][o.length]("return 1")();\n`],
  ["a namespace import beside an inner declaration of it", `import * as o from "./d.js";\nfunction f() { const o = [1]; return o; }\nexports.f = f;\nexports.main = (v) => v[o.length][o.length]("return 1")();\n`],
  ["a parameter with an array default", `function f(o = [1]) { return o[o.length][o.length]("return 1")(); }\nexports.f = () => f(JSON.parse('{"length":"constructor"}'));\n`],
  ["a destructured name with an array default", `const { o = [1] } = JSON.parse('{"o":{"length":"constructor"}}');\nexports.main = (v) => v[o.length][o.length]("return 1")();\n`],
  ["pin: a name given an object after an array, held on main too", `let o = [1];\no = { length: ${K} };\n${chain}`],
  ["a name given a call after an array", `let o = [1];\no = JSON.parse('{"length":"constructor"}');\n${chain}`],
  ["a name that is a parameter elsewhere", `const o = [1];\nfunction g(o) { return o[o.length][o.length]("return 1")(); }\nexports.g = g;\n`],
  ["a name rebound by destructuring", `let o = [1];\n({ o } = { o: { length: ${K} } });\n${chain}`],
  ["Math.max deleted and read from Object.prototype", `Object.prototype.max = () => ${K};\ndelete Math.max;\nexports.main = (v) => v[Math.max()][Math.max()]("return 1")();\n`],
  ["Math.max deleted in parentheses", `const g = () => ${K};\ndelete (Math.max);\nObject.prototype.max = g;\nexports.main = (v) => v[Math.max()][Math.max()]("return 1")();\n`],
  ["Math.max deleted, Object.prototype.max set by defineProperty", `Object.defineProperty(Object.prototype, "max", { value: () => ${K} });\ndelete Math.max;\nexports.main = (v) => v[Math.max()][Math.max()]("return 1")();\n`],
  ["pin: Math.max deleted by a computed key, held on main too", `Object.prototype.max = () => ${K};\ndelete Math[["m", "ax"].join("")];\nexports.main = (v) => v[Math.max()][Math.max()]("return 1")();\n`],
  ["pin: Math.max deleted by Reflect.deleteProperty, held on main too", `Object.prototype.max = () => ${K};\nReflect.deleteProperty(Math, ["m", "ax"].join(""));\nexports.main = (v) => v[Math.max()][Math.max()]("return 1")();\n`],
  ["Math.max deleted and Object.prototype set through an alias", `const P = Object.prototype;\nP.max = () => ${K};\ndelete Math.max;\nexports.main = (v) => v[Math.max()][Math.max()]("return 1")();\n`],
  ["Math.max deleted and Object.prototype set by ??=", `Object.prototype.max ??= () => ${K};\ndelete Math.max;\nexports.main = (v) => v[Math.max()][Math.max()]("return 1")();\n`],
  ["Math.max read from Object.prototype after a write", `Object.prototype.max = () => ${K};\nexports.main = (v) => v[Math.max()][Math.max()]("return 1")();\n`],
];
for (const [label, src] of reaches) {
  test(`${label}: not static, the hazard widens and a changed payload holds`, () => {
    expect(provablyStatic(src)).toBe(false);
    expect(classifyJs("pkg/lib/x.js", src).all).toBe(true);
    expect(widensDocs(src)).toBe(true);
  });
}

// Ordinary .length code on a provable array or string stays static.
const stays: [string, string][] = [
  ["a fixed array's last index", "const a = [() => 1];\na[a.length - 1]();\n"],
  ["a declaration used in a nested function", "const a = [() => 1];\nfunction f() { return a[a.length - 1](); }\nf();\n"],
  ["a declaration inside a function and used there", "function f() { const a = [() => 1]; return a[a.length - 1](); }\nf();\n"],
  ["two functions each with an array of the same name", "function f() { const a = [() => 1]; return a[a.length - 1](); }\nfunction g() { const a = [() => 2]; return a[a.length - 1](); }\nf(); g();\n"],
  ["reads and element writes of a name given an array", "const a = [() => 1];\na[0] = () => 2;\na[a.length - 1]();\n"],
  ["a name given a computed member that nothing writes through", "const m = { a: [() => 1] };\nconst k = \"a\";\nconst p = m[k];\nconst b = [() => 1];\np.x;\nb[b.length - 1]();\n"],
  ["a string's split", "const p = \"a,b\".split(\",\");\np[p.length - 1]();\n"],
  ["a slice of a fixed array", "const a = [() => 1];\nconst b = a.slice(0);\nb[b.length - 1]();\n"],
  ["a map and a filter of an array literal", "const b = [() => 1].map((f) => f).filter(Boolean);\nb[b.length - 1]();\n"],
  ["a template", "const s = `abc`;\nconst a = [() => 1];\na[s.length - 3]();\n"],
  ["Object.keys of anything", "const o = { a: 1 };\nconst k = Object.keys(o);\nconst a = [() => 1];\na[k.length - 1]();\n"],
  ["Array.from and Array.of", "const k = Array.from({ length: 2 });\nconst j = Array.of(1);\nconst a = [() => 1];\na[k.length - 2]();\na[j.length - 1]();\n"],
  ["String(...)", "const s = String(1);\nconst a = [() => 1];\na[s.length - 1]();\n"],
  ["a name given an array twice", "let a = [() => 1];\na = [() => 2];\na[a.length - 1]();\n"],
  ["a name given its own concat", "let a = [() => 1];\na = a.concat([() => 2]);\na[a.length - 1]();\n"],
  ["a name stepped by +=", "let s = \"a\";\ns += \"b\";\nconst a = [() => 1];\na[s.length - 2]();\n"],
  ["a fixed array passed to a function", "const a = [() => 1];\nconst f = (v) => v;\nf(a);\na[a.length - 1]();\n"],
  ["a fixed array beside JSON.parse and Object.defineProperty", "const a = [() => 1];\nconst cfg = JSON.parse('{}');\nObject.defineProperty(exports, \"x\", { value: cfg });\na[a.length - 1]();\n"],
  ["a fixed array beside the compiled-module marker", "Object.defineProperty(exports, \"__esModule\", { value: true });\nconst a = [() => 1];\na[a.length - 1]();\n"],
  ["a fixed array beside Object.prototype.hasOwnProperty.call", "const own = Object.prototype.hasOwnProperty;\nconst a = [() => 1];\nObject.prototype.hasOwnProperty.call(a, 0);\na[a.length - 1]();\n"],
  ["an ES import beside a length-keyed call", "import path from \"node:path\";\nconst a = [() => 1];\na[a.length - 1]();\n"],
  ["an ES import of a built-in used in the array", "import os from \"node:os\";\nconst a = [() => os.arch()];\na[a.length - 1]();\n"],
  ["an ES import with a braced clause beside a length-keyed call", "import { join, \"x-y\" as xy } from \"node:path\";\nconst a = [() => 1];\na[a.length - 1]();\n"],
  ["pin: an ES import followed by 1,100 lines and a length-keyed call, static on main too", "import path from \"node:path\";\n" + "const z = 1;\n".repeat(1100) + "const a = [() => 1];\na[a.length - 1]();\n"],
  ["a declarator after a comma given an array", "const x = 1, a = [() => 1];\na[a.length - 1]();\n"],
  ["a declarator after a comma given an array of functions with var", "var n = 0, fns = [function () { return 1; }];\nfns[fns.length - 1]();\n"],
  ["a declarator after a comma after an object literal", "const o = { m: 1 }, a = [() => 1];\na[a.length - 1]();\n"],
  ["a string split by a regular expression with a flag", "const p = \"a,b\".split(/,/g);\nconst a = [() => 1];\na[p.length - 2]();\n"],
  ["a template with a substitution", "const dir = \"x\";\nconst p = `${dir}/bin`;\nconst a = [() => 1];\na[p.length - 6]();\n"],
  ["a template with two substitutions", "const d = \"x\", e = \"y\";\nconst p = `${d}/${e}`;\nconst a = [() => 1];\na[p.length - 3]();\n"],
  ["a string replaced by a regular expression", "const p = \"abc\".replace(/b/g, \"x\");\nconst a = [() => 1];\na[p.length - 3]();\n"],
  ["a string with substring, padStart and charAt", "const p = \"abc\".substring(1).padStart(4, \"-\").charAt(0);\nconst a = [() => 1];\na[p.length - 1]();\n"],
  ["a let array whose length is assigned", "let a = [() => 1];\na.length = 1;\na[a.length - 1]();\n"],
  ["Math with a delete of another name", "const a = [() => 1];\nconst o = { x: 1 };\ndelete o.x;\na[Math.floor(1 / 2)]();\n"],
  ["Math.max read with no prototype write", "const a = [() => 1];\na[Math.max(1)]();\n"],
  ["Math beside a read of Object.prototype members", "const a = [() => 1];\nconst own = Object.prototype.hasOwnProperty;\na[Math.max(1)]();\n"],
];
for (const [label, src] of stays) {
  test(`${label}: stays static`, () => {
    expect(provablyStatic(src)).toBe(true);
    expect(classifyJs("pkg/lib/x.js", src).all).toBe(false);
  });
}

// What the allow-list gives up: an array or string the file cannot show (a parameter, a property, a call result) reads as unknown.
// A write of .length that is not a number literal holds, whatever kind the name seems to have (main's reading, kept).
const KL = 'const K = ["con", "structor"].join("");\n';
const lengthWrites: [string, string][] = [
  ["an alias of an array with its own slice, then a length write", `${KL}const a = [1];\nconst b = a;\na.slice = () => ({});\nlet o = b.slice();\no.length = K;\nexports.main = (v) => v[o.length][o.length]("return 1")();\n`],
  ["an inner function's arguments with a length write", `${KL}exports.f = function () { let arguments = [1]; return (function () { arguments.length = K; return (v) => v[arguments.length][arguments.length]("return 1")(); })(); };\n`],
  ["a replace with an object that has its own Symbol.replace", `${KL}const r = { [Symbol.replace]: () => ({ length: K }) };\nconst p = "abc".replace(r, "");\nexports.main = (v) => v[p.length][p.length]("return 1")();\n`],
  ["an undeclared global after a private member named var", `${KL}this.a = { length: K };\nclass C { #var = 0; static m(c) { c.#var\n x = 1, a = [1]; } }\nC.m(new C());\nexports.main = (v) => v[a.length][a.length]("return 1")();\n`],
  ["an undeclared global after a member named var on its own line", `${KL}this.a = { length: K };\nconst o = {};\no.\nvar\n x = 1, a = [1];\nexports.main = (v) => v[a.length][a.length]("return 1")();\n`],
  ["a name made a number by += with a length write", `${KL}Number.prototype.length = K;\nlet o = [1];\no.valueOf = () => 0;\no += 1;\no.length = K;\nexports.main = (v) => v[o.length][o.length]("return 1")();\n`],
];
for (const [label, src] of lengthWrites) {
  test(`${label}: not static, the hazard widens`, () => {
    expect(provablyStatic(src)).toBe(false);
    expect(classifyJs("pkg/lib/x.js", src).all).toBe(true);
  });
}

// A private name after the dot is a member name, never the keyword that follows it on the next line.
const privateNames: [string, string][] = [
  ["c.#new then a line feed and a write of Array", `${KL}class C { #new = 0; static m(c) { c.#new\n Array = () => ({ length: K }); } }\nC.m(new C());\nconst o = Array(1);\nexports.main = (v) => v[o.length][o.length]("return 1")();\n`],
  ["c.#new then a line feed and a function write of Array", `${KL}class C { #new = 0; static m(c) { c.#new\n Array = function () { return { length: K }; }; } }\nC.m(new C());\nconst o = Array(1);\nexports.main = (v) => v[o.length][o.length]("return 1")();\n`],
  ["pin: c.#typeof then a line feed and a write of Math, held on main too", "class C { #typeof = 0; static m(c) { c.#typeof\n Math = { max: () => 1 }; } }\nC.m(new C());\nconst a = [() => 1];\na[Math.max(0)]();\n"],
];
for (const [label, src] of privateNames) {
  test(`${label}: not static`, () => {
    expect(provablyStatic(src)).toBe(false);
  });
}

// A private method's parameter named like a keyword binds like any other method's.
const privateMethods: [string, string][] = [
  ["pin: a private method named catch with a parameter used as a key", 'class C { #catch(e) { return a[e][e]("return 1")(); } m(k) { return this.#catch(k); } }\nconst a = [() => 1];\nlet e = 0;\na[e]();\n'],
  ["a static private method named catch", 'class C { static #catch(e) { return a[e][e]("return 1")(); } m(k) { return C.#catch(k); } }\nconst a = [() => 1];\nlet e = 0;\na[e]();\n'],
  ["an async private method named if", 'class C { async #if(e) { return a[e][e]("return 1")(); } m(k) { return this.#if(k); } }\nconst a = [() => 1];\nlet e = 0;\na[e]();\n'],
];
for (const [label, src] of privateMethods) {
  test(`${label}: not static`, () => {
    expect(provablyStatic(src)).toBe(false);
  });
}

// One name's length indexes an array many times: its uses are read once, so the scan stays under a tight step limit.
test("2,000 indexings by one array's length stay static under a tight step limit", () => {
  const src = "const a = [() => 1];\n" + "a[a.length - 1]();\n".repeat(2_000);
  setJsScanSteps(100 * src.length);
  try {
    const before = scannerFaultCount();
    expect(provablyStatic(src)).toBe(true);
    expect(scannerFaultCount() - before).toBe(0);
  } finally {
    setJsScanSteps(undefined);
  }
});

// A file over a million characters that is not static still names the files it loads: the file it requires is read as well.
test("a large file with a length from JSON still follows the file it requires", () => {
  const pad = "\n//" + "x".repeat(1_000_000);
  const pkg = (desc: string) => JSON.stringify({ name: "p", version: "1.0.0", description: desc, scripts: { postinstall: "node lib/hook.js" } });
  const mk = (desc: string): FileMap =>
    files({
      "package.json": pkg(desc),
      "lib/hook.js": 'const o = JSON.parse("{}");\nexports.main = (v) => v[o.length][o.length]("return 1")();\nrequire("./sub/helper.js");' + pad,
      "lib/sub/helper.js": 'require("child_process").execSync(process.env.npm_package_description);\n',
    });
  expect(holds(mk("one"), mk("two")).length).toBeGreaterThan(0);
});

// A write to a built-in's member spelled with a line feed after the dot is the same write (x.\nnew\nArray = f is x.new.Array = f here, but the
// word before the dot is not the keyword new: a global Array(1) with a length made up is read as a made-up array length).
test("a member named new, written with a line feed after the dot, then a global Array call: not static", () => {
  const src = 'const K = ["con", "structor"].join("");\nconst x = {};\nx.\nnew\nArray = () => ({ length: K });\nconst o = Array(1);\nexports.main = (v) => v[o.length][o.length]("return 1")();\n';
  expect(provablyStatic(src)).toBe(false);
  expect(classifyJs("pkg/lib/x.js", src).all).toBe(true);
  expect(widensDocs(src)).toBe(true);
});

// A decimal literal's trailing dot ends the literal: the keyword on the next line (valid through ASI) is still a keyword.
const KW = 'const K = ["con", "structor"].join("");\n';
const afterDot: [string, string][] = [
  ["pin: a function named Array after 1., held on main too", `${KW}1.\nfunction Array() { return { length: K }; }\nconst o = Array(1);\nexports.main = (v) => v[o.length][o.length]("return 1")();\n`],
  ["pin: a for-of head writing Math.max after 1., held on main too", "const a = [() => 1];\n1.\nfor (Math.max of [() => 1]);\na[Math.max(0)]();\n"],
  ["delete Math.max after 1.", "const a = [() => 1];\n1.\ndelete Math.max;\na[Math.max(0)]();\n"],
  ["a for-in head writing a name after 1.", "let i = [() => 1];\nconst o = { x: 1 };\n1.\nfor (i in o);\nconst a = [() => 1];\na[i.length - 1]();\n"],
];
// A long literal: the underscore is exactly 80 characters before the dot.
afterDot.push(["a 121-character literal with underscores before the dot, then a function named Array", `${KW}${"1_".repeat(40) + "1".repeat(41)}.\nfunction Array() { return { length: K }; }\nconst o = Array(1);\nexports.main = (v) => v[o.length][o.length]("return 1")();\n`]);
for (const [label, src] of afterDot) {
  test(`${label}: not static`, () => {
    expect(provablyStatic(src)).toBe(false);
  });
}

const unknown: [string, string][] = [
  ["pin: a let array whose length is stepped with --, held on main too", "let a = [() => 1, () => 2];\na.length--;\na[a.length - 1]();\n"],
  ["pin: a let array whose length is reduced with -=, held on main too", "let a = [() => 1, () => 2];\na.length -= 1;\na[a.length - 1]();\n"],
  ["a parameter's last index", "function f(a) { return a[a.length - 1][0]; }\nexports.f = f;\n"],
  ["a map of a name (its callback gets the array)", "const a = [() => 1];\nconst b = a.map((f) => f);\nb[b.length - 1]();\n"],
  ["a call result's last index", "const g = () => [() => 1];\nconst x = g();\nx[x.length - 1]();\n"],
];
for (const [label, src] of unknown) {
  test(`${label}: not provably an array, held`, () => {
    expect(provablyStatic(src)).toBe(false);
  });
}

// Every name's reading and every built-in check is read once per scan, charged to the budget.
test("8,000 fixed arrays each indexed by their own length read under the step budget and stay static", () => {
  let src = "";
  for (let n = 0; n < 8000; n++) src += `const a${n} = [() => 1]; a${n}[a${n}.length - 1]();\n`;
  const before = scannerFaultCount();
  expect(provablyStatic(src)).toBe(true);
  expect(scannerFaultCount() - before).toBe(0);
});
test("8,000 chained names each read once are read under the step budget without a fault", () => {
  let src = "const a0 = [() => 1];\n";
  for (let n = 1; n < 8000; n++) src += `const a${n} = a${n - 1}.slice(); a${n}[a${n}.length - 1]();\n`;
  const before = scannerFaultCount();
  expect(provablyStatic(src)).toBe(false);
  expect(scannerFaultCount() - before).toBe(0);
});
test("a 4 MB text with Object.prototype members and a length key reads under a tight step limit", () => {
  const src = "const a = [() => 1];\na[a.length - 1]();\n" + "Object.prototype.hasOwnProperty.call(a, 0);\n".repeat(90_000);
  setJsScanSteps(40 * src.length);
  try {
    const before = scannerFaultCount();
    expect(provablyStatic(src)).toBe(true);
    expect(scannerFaultCount() - before).toBe(0);
  } finally {
    setJsScanSteps(undefined);
  }
});

// A long member chain after a computed member is one match of one scan: its cost is its length, not its square.
test("a 60,000-link member chain after a computed member reads under the step budget without a fault", () => {
  const src = "const x = [{}];\nconst a = [() => 1].slice();\na[a.length - 1]();\nconst y = x[0]" + ".a[0]".repeat(60_000) + ";\n";
  const before = scannerFaultCount();
  const t = performance.now();
  expect(provablyStatic(src)).toBe(true);
  expect(scannerFaultCount() - before).toBe(0);
  expect(performance.now() - t).toBeLessThan(2_000); // the old pattern took about 4.6 s here and was uncharged: only this bound sees it
});

// A scan leaves no cache for the next one: the same text read twice answers the same at every step limit, so a rescan that is cheaper
// because a cache survived cannot pass where the first scan faulted.
test("the same text read twice answers the same at every step limit", () => {
  allowFaults();
  const src = "const a = [() => 1].slice();\na[a.length - 1]();\n" + "x[0].a[0].b = 1;\nconst q = [].slice();\n".repeat(60);
  const run = (limit: number) => {
    setJsScanSteps(limit);
    try {
      const before = scannerFaultCount();
      const v = provablyStatic(src);
      return [v, scannerFaultCount() - before];
    } finally {
      setJsScanSteps(undefined);
    }
  };
  for (let limit = 200; limit < 40_000; limit += 150) {
    const first = run(limit);
    expect(run(limit)).toEqual(first);
  }
});
