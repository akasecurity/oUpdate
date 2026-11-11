import { expect, test } from "bun:test";
import { prepass, type FileMap } from "../src/prepass.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const files = (o: Record<string, string>): FileMap => new Map(Object.entries(o).map(([k, v]) => [k, enc(v)]));
const holds = (old: FileMap, now: FileMap) => prepass("npm", old, now).hard.filter((s) => s.kind === "install-script").map((s) => s.detail);

// A hook file loads lib/evil.js through an argument that is built, not spelled. Only lib/evil.js changes between the releases.
const release = (v: string, hook: string, changed = "lib/evil.js") =>
  files({
    "package.json": JSON.stringify({ name: "p", version: v, scripts: { postinstall: "node h.js" } }),
    "h.js": hook,
    "lib/a.js": "module.exports = 1\n",
    "lib/evil.js": changed === "lib/evil.js" ? `console.log("evil ${v}")\n` : "console.log('evil')\n",
    "docs/payload.txt": changed === "docs/payload.txt" ? `payload ${v}\n` : "payload\n",
  });

const built: [string, string][] = [
  ["a join of an array literal", `require(["./lib/", "evil"].join(""))`],
  ["a join of an array literal in a dynamic import", `import(["./lib/", "evil"].join(""))`],
  ["a join of an array literal in require.resolve", `require.resolve(["./lib/", "evil"].join(""))`],
  ["a joined string held by a name", `const p = ["./lib/", "evil"].join(""); require(p)`],
  ["a joined string held by a name and reassigned", `let p = "./lib/a"; p = ["./lib/", "evil"].join(""); require(p)`],
  ["a string concatenated and held by a name", `const p = "./lib/" + ["evil"].join(""); require(p)`],
  ["createRequire(...) called with a joined string", `const { createRequire } = require("module"); createRequire(__filename)(["./lib/", "evil"].join(""))`],
  ["a name bound to createRequire(...)", `const { createRequire } = require("module"); const r = createRequire(__filename); r(["./lib/", "evil"].join(""))`],
  ["a name bound to require", `const r = require; r(["./lib/", "evil"].join(""))`],
  ["module.require with a joined string", `module.require(["./lib/", "evil"].join(""))`],
  ["a joined string with a call result as the receiver", `require("./lib/x/evil".split("x/").join(""))`],
];

for (const [label, code] of built) {
  test(`${label} reads the package: the changed lib/evil.js holds`, () => {
    expect(holds(release("1.0.0", code), release("1.0.1", code)).length).toBeGreaterThan(0);
  });
}

const controls: [string, string][] = [
  ["a literal path", `require("./lib/a")`],
  ["two literals joined with +", `require("./lib/" + "a")`],
  ["path.join of literals", `const path = require("path"); require(path.join(__dirname, "lib", "a"))`],
  ["a name held literal", `const p = "./lib/a"; require(p)`],
  ["a parameter that is never called at install", `exports.main = (x) => require(x)`],
];

for (const [label, code] of controls) {
  test(`${label} stays on its file: a changed lib/evil.js or docs file is not an install change`, () => {
    expect(holds(release("1.0.0", code), release("1.0.1", code))).toEqual([]);
    expect(holds(release("1.0.0", code, "docs/payload.txt"), release("1.0.1", code, "docs/payload.txt"))).toEqual([]);
  });
}

// Several assignments, an alias next to an unresolved load, require handed on as a value, a process argument vector.
// scripts/h.js is the hook; only the file named in `changed` differs between the releases.
const nested = (v: string, hook: string, changed: string) =>
  files({
    "package.json": JSON.stringify({ name: "p", version: v, scripts: { postinstall: "node scripts/h.js" } }),
    "scripts/h.js": hook,
    "scripts/lib/a.js": "module.exports = 1\n",
    "scripts/evil.js": changed === "scripts/evil.js" ? `console.log("evil ${v}")\n` : "console.log('evil')\n",
    "x/evil.js": changed === "x/evil.js" ? `console.log("evil ${v}")\n` : "console.log('evil')\n",
    "scripts/workers/evil.js": changed === "scripts/workers/evil.js" ? `console.log("evil ${v}")\n` : "console.log('evil')\n",
    "scripts/lib/evil.js": changed === "scripts/lib/evil.js" ? `console.log("evil ${v}")\n` : "console.log('evil')\n",
  });
const PATH = `const path = require("path"); const name = "a"; `;
const later: [string, string, string][] = [
  ["a later assignment that loads another file", PATH + `let p = path.join(__dirname, "lib", name); p = atob("Li9ldmlsLmpz"); require(p);`, "scripts/evil.js"],
  ["an earlier directory restriction and a later joined string", PATH + `let p = path.join(__dirname, "lib", name); p = ["./ev", "il.js"].join(""); require(p);`, "scripts/evil.js"],
  ["an alias call that restricts and a load of an unresolved parameter", PATH + `const r = require; r(path.join(__dirname, "lib", name)); function go(x) { require(x); } go(atob("Li9ldmlsLmpz"));`, "scripts/evil.js"],
  ["require handed on as a value", `["../x/evil"].map(require)`, "x/evil.js"],
  ["import handed on as a value", `["../x/evil"].map((m) => import(m))`, "x/evil.js"],
  ["a process argument vector with a built element", `require("child_process").spawnSync("node", [["x/ev", "il.js"].join("")])`, "x/evil.js"],
];
for (const [label, code, changed] of later) {
  test(`${label} holds the changed ${changed}`, () => {
    expect(holds(nested("1.0.0", code, changed), nested("1.0.1", code, changed)).length).toBeGreaterThan(0);
  });
}
test("one restricting assignment keeps its directory; the unrelated changed file does not hold", () => {
  const code = PATH + `let p = path.join(__dirname, "lib", name); p = path.join(__dirname, "lib", name + "x"); require(p);`;
  expect(holds(nested("1.0.0", code, "x/evil.js"), nested("1.0.1", code, "x/evil.js"))).toEqual([]);
});

// Second review batch. Root layout: hook h.js at the package root, docs and lib beside it.
const rootRel = (v: string, hook: string, changed: string) =>
  files({
    "package.json": JSON.stringify({ name: "p", version: v, scripts: { postinstall: "node h.js" } }),
    "h.js": hook,
    "lib/a.js": "module.exports = 1\n",
    "lib/index.js": "module.exports = 2\n",
    "lib/notes.md": changed === "lib/notes.md" ? `evil ${v}\n` : "notes\n",
    "lib/evil.js": changed === "lib/evil.js" ? `console.log("evil ${v}")\n` : "console.log('evil')\n",
    "docs/index.js": changed === "docs/index.js" ? `console.log("evil ${v}")\n` : "console.log('evil')\n",
    "docs/payload.js": changed === "docs/payload.js" ? `console.log("evil ${v}")\n` : "console.log('evil')\n",
  });
const rootHolds = (hook: string, changed: string) => holds(rootRel("1.0.0", hook, changed), rootRel("1.0.1", hook, changed)).length > 0;
const nestHolds = (hook: string, changed: string) => holds(nested("1.0.0", hook, changed), nested("1.0.1", hook, changed)).length > 0;
const P = `const path = require("path");`;

for (const [label, hook, changed] of [
  ["path?.join with a built segment", P + ` require(path?.join(__dirname, sub + "/" + name))`, "docs/payload.js"],
  ["(path).join with a built segment", P + ` require((path).join(__dirname, sub + "/" + name))`, "docs/payload.js"],
  ["require(\"path/win32\").join with a built segment", `require(require("path/win32").join(__dirname, sub + "/" + name))`, "docs/payload.js"],
  ["a template path require with a built segment", "require(require(`path`).join(__dirname, sub + \"/\" + name))", "docs/payload.js"],
  ["path?.join naming a docs file when another index.js exists", P + ` require(path?.join(__dirname, "docs", "index.js"))`, "docs/index.js"],
] as [string, string, string][]) {
  test(`${label} keeps the precise path reading, so the changed ${changed} holds`, () => expect(rootHolds(hook, changed)).toBe(true));
}

for (const [label, hook] of [
  ["a name holding a literal head and a built tail", `const x = process.argv[2]; const p = "./lib/" + x; require(p)`],
  ["an alias of require with a literal head", `const r = require; r("./lib/" + process.argv[2])`],
  ["createRequire(f) with a literal head", `const { createRequire } = require("module"); createRequire(__filename)("./lib/" + process.argv[2])`],
  ["require.resolve with a literal head", `require.resolve("./lib/" + process.argv[2])`],
] as [string, string][]) {
  test(`${label} keeps the hook's own folder: a changed scripts/evil.js holds`, () => expect(nestHolds(hook, "scripts/evil.js")).toBe(true));
}

test("200 reassignments between names finish in bounded time, in a small file and in one over 1 MB", () => {
  const body = `let p = "./lib/a";\n` + Array.from({ length: 200 }, (_, i) => `p = q${i}; q${i} = p;\n`).join("") + `require(p);\n`;
  const big = body + "// " + "x".repeat(1_100_000) + "\n";
  for (const hook of [body, big]) {
    const t0 = performance.now();
    holds(nested("1.0.0", hook, "scripts/evil.js"), nested("1.0.1", hook, "scripts/evil.js"));
    expect(performance.now() - t0).toBeLessThan(4000);
  }
});

const ATOB = `atob("Li9ldmlsLmpz")`;
const ATOB_X = `atob("Li4veC9ldmlsLmpz")`;
const later2: [string, string, string][] = [
  ["a later assignment inside a branch", PATH + `let p = path.join(__dirname, "lib", name); if (process.env.X) p = ${ATOB}; require(p);`, "scripts/evil.js"],
  ["a require of a parameter called with an unresolved value", PATH + `require(path.join(__dirname, "lib", name)); function go(x) { require(x); } go(${ATOB});`, "scripts/evil.js"],
  ["an arrow that requires its parameter, called with an unresolved value", PATH + `require(path.join(__dirname, "lib", name)); const go = (x) => require(x); go(${ATOB});`, "scripts/evil.js"],
  ["a later assignment, target in another folder", PATH + `let p = path.join(__dirname, "lib", name); p = ${ATOB_X}; require(p);`, "x/evil.js"],
  ["an alias call and a parameter load, target in another folder", PATH + `const r = require; r(path.join(__dirname, "lib", name)); function go(x) { require(x); } go(${ATOB_X});`, "x/evil.js"],
  ["a literal then a join of pieces", `let p = "./lib/" + "a"; p = ["./lib/", "evil"].join(""); require(p)`, "lib/evil.js"],
  ["an alias three deep", `const a = require; const b = a; const c = b; c(["./lib/", "evil"].join(""))`, "lib/evil.js"],
  ["a value that starts on the line after the =", `const p =\n  ["./lib/", "evil"].join("");\nrequire(p)`, "lib/evil.js"],
  ["a destructured name", `const { p } = JSON.parse(process.argv[2]); require(p)`, "lib/evil.js"],
  ["+= with a built right side", `let p = "./lib/"; p += process.argv[2]; require(p)`, "lib/evil.js"],
  ["a join of literals that spells a docs file", `require(["./do", "cs/payload.js"].join(""))`, "docs/payload.js"],
  ["a name receiver that is a list, not the path module", `const parts = ["./lib/", "evil"]; require(parts.join(""))`, "lib/evil.js"],
  ["cluster.setupPrimary with an exec built from pieces", `const c = require("cluster"); c.setupPrimary({ exec: ["../x/", "evil.js"].join("") })`, "x/evil.js"],
];
for (const [label, hook, changed] of later2) {
  test(`${label} holds the changed ${changed}`, () => {
    const mk = changed === "scripts/evil.js" || changed === "x/evil.js" ? nestHolds : rootHolds;
    expect(mk(hook, changed)).toBe(true);
  });
}

for (const [label, hook] of [
  ["+= on a literal name", PATH + `let p = path.join(__dirname, "lib", name); p += "evil"; require(p);`],
  ["two separate names", PATH + `const p = path.join(__dirname, "lib", name); const q = ${ATOB}; require(p); require(q);`],
  ["an alias plus a direct non-literal require", PATH + `const r = require; r(path.join(__dirname, "lib", name)); require(${ATOB});`],
  ["an alias plus import()", PATH + `const r = require; r(path.join(__dirname, "lib", name)); import(${ATOB});`],
] as [string, string][]) {
  test(`${label} still holds the changed scripts/evil.js`, () => expect(nestHolds(hook, "scripts/evil.js")).toBe(true));
}

// Third review batch.
const R = PATH + `require(path.join(__dirname, "lib", name)); `; // a restricting load: without it the hook folder floor hides the gap
const BX = `atob("Li4veC9ldmlsLmpz")`; // "../x/evil.js"
const third: [string, string, string, "root" | "nested"][] = [
  ["a package-wide trigger next to a docs prefix load", `require("./docs/" + x); ["x"].map(require)`, "docs/payload.js", "root"],
  ["a package-wide trigger next to a lib prefix load and a changed .md", `require("./lib/" + x); ["x"].map(require)`, "lib/notes.md", "root"],
  ["the module wrapper's require parameter next to a docs prefix load", `(function (require, exports, module) { require("./docs/" + x) })(require)`, "docs/payload.js", "root"],
  ["fork of a joined string from the package root", R + `require("child_process").fork(["x/ev", "il.js"].join(""))`, "x/evil.js", "nested"],
  ["an alias of a function that requires its parameter", R + `function go(x) { require(x) } const g = go; g(${BX})`, "x/evil.js", "nested"],
  ["a member call of a function that requires its parameter", R + `function go(x) { require(x) } const o = { go }; o.go(${BX})`, "x/evil.js", "nested"],
  ["go.call", R + `function go(x) { require(x) } go.call(null, ${BX})`, "x/evil.js", "nested"],
  ["go.apply", R + `function go(x) { require(x) } go.apply(null, [${BX}])`, "x/evil.js", "nested"],
  ["a destructured parameter", R + `function go({ p }) { require(p) } go({ p: ${BX} })`, "x/evil.js", "nested"],
  ["a method parameter", R + `const o = { go(x) { require(x) } }; o.go(${BX})`, "x/evil.js", "nested"],
  ["an IIFE parameter", R + `(function (x) { require(x) })(${BX})`, "x/evil.js", "nested"],
  ["an arrow IIFE parameter", R + `((x) => require(x))(${BX})`, "x/evil.js", "nested"],
  ["a callback parameter", R + `[${BX}].forEach((x) => require(x))`, "x/evil.js", "nested"],
  ["an argument vector held by a name", R + `const a = [["x/ev", "il.js"].join("")]; require("child_process").spawnSync("node", a)`, "x/evil.js", "nested"],
  ["an argument vector held by a name that is a call result", R + `const a = JSON.parse(process.argv[2]); require("child_process").spawnSync("node", a)`, "x/evil.js", "nested"],
  ["a parameter assigned inside its function", R + `function go(x) { x = x; require(x) } go(${BX})`, "x/evil.js", "nested"],
  ["an inline callback that imports its parameter", R + `["../x/evil"].map((m) => import(m))`, "x/evil.js", "nested"],
  ["assignments that disagree between a docs prefix and a lib join", `let p = "./docs/" + process.argv[2]; p = ["./lib/", "a"].join(""); require(p)`, "docs/payload.js", "root"],
  ["cluster.settings.exec set to a joined string", `const c = require("cluster"); c.settings.exec = ["../x/", "evil.js"].join("")`, "x/evil.js", "nested"],
  ["module.constructor._load of a joined string", `module.constructor._load(["../x/", "evil.js"].join(""))`, "x/evil.js", "nested"],
];
for (const [label, hook, changed, layout] of third) {
  test(`${label} holds the changed ${changed}`, () => expect((layout === "root" ? rootHolds : nestHolds)(hook, changed)).toBe(true));
}

// Cost bounds: generous, since the point is a file that took seconds (or never ended) before. Main takes tens of milliseconds.
test("1000 loader aliases in a file over 1 MB are read in bounded time", () => {
  const code = Array.from({ length: 1000 }, (_, i) => `const a${i} = require;\n`).join("") + `const pad = "${"x".repeat(1_050_000)}";\na999(process.argv[2]);\n`;
  const t0 = performance.now();
  holds(nested("1.0.0", code, "scripts/evil.js"), nested("1.0.1", code, "scripts/evil.js"));
  expect(performance.now() - t0).toBeLessThan(5000);
});

test("3000 functions of the same name in a file over 1 MB are read in bounded time", () => {
  const code = Array.from({ length: 3000 }, (_, i) => `function t(e) { return e + ${i} }\n`).join("") + `function u(e) { require(e) }\nu(${BX});\nconst pad = "${"x".repeat(1_050_000)}";\n`;
  const t0 = performance.now();
  holds(nested("1.0.0", code, "scripts/evil.js"), nested("1.0.1", code, "scripts/evil.js"));
  expect(performance.now() - t0).toBeLessThan(5000);
});

// Fourth review batch. BX is "../x/evil.js"; R is a restricting load, so the hook folder floor cannot hide the gap.
const CP = `const cp = require("child_process"); `;
const fourth: [string, string, string][] = [
  ["require.main.require of a built path", `require.main.require(${BX})`, "x/evil.js"],
  ["module.parent.require of a built path", `module.parent.require(${BX})`, "x/evil.js"],
  ["a name bound to module, then .require", `const m = module; m.require(${BX})`, "x/evil.js"],
  ["an object holding require, then .require", `const o = { require }; o.require(${BX})`, "x/evil.js"],
  ["fork of path.join(__dirname, ...) from a hook in a folder", PATH + CP + `cp.fork(path.join(__dirname, "workers", name))`, "scripts/workers/evil.js"],
  ["fork of a literal head with a cwd option", CP + `cp.fork("./lib/" + process.argv[2], [], { cwd: __dirname })`, "scripts/lib/evil.js"],
  ["a createRequire statement longer than 200 characters", `const { createRequire } = require("module"); const r = (${"0,".repeat(110)} createRequire(__filename)); r(${BX})`, "x/evil.js"],
  ["a parameter list with a call in a default", R + `function go(x, y = String(1)) { require(x) } go(${BX})`, "x/evil.js"],
  ["an arrow with a call in a default", R + `const go = (x, y = String(1)) => require(x); go(${BX})`, "x/evil.js"],
  ["a named function expression held by a name", R + `const go = function inner(x) { require(x) }; go(${BX})`, "x/evil.js"],
  ["an exported function the file calls through exports", R + `exports.go = function (x) { require(x) }; exports.go(${BX})`, "x/evil.js"],
  ["module.exports called in its own file", R + `module.exports = function (x) { require(x) }; module.exports(${BX})`, "x/evil.js"],
  ["an export called through require(__filename)", R + `exports.go = function (x) { require(x) }; require(__filename).go(${BX})`, "x/evil.js"],
  ["a property of a parameter", R + `function go(o) { require(o.p) } go({ p: ${BX} })`, "x/evil.js"],
  ["cluster loaded through a template literal", "const c = require(`cluster`); c.setupPrimary({ exec: [\"../x/\", \"evil.js\"].join(\"\") })", "x/evil.js"],
  ["require.main.constructor._load of a built path", `require.main.constructor._load(["../x/", "evil.js"].join(""))`, "x/evil.js"],
  ["an argument vector held by a name bound to a name", R + `const a = [["x/ev", "il.js"].join("")]; const b = a; require("child_process").spawnSync("node", b)`, "x/evil.js"],
  ["an argument vector that is an expression", R + `require("child_process").spawnSync("node", process.argv.slice(2))`, "x/evil.js"],
];
for (const [label, hook, changed] of fourth) {
  test(`${label} holds the changed ${changed}`, () => expect(nestHolds(hook, changed)).toBe(true));
}

test("an exported function that requires its parameter and is only exported does not hold an unrelated changed file", () => {
  const hook = `function go(x) { require(x); }\nexports.go = go;\n`;
  expect(holds(nested("1.0.0", hook, "x/evil.js"), nested("1.0.1", hook, "x/evil.js"))).toEqual([]);
});

test("30000 distinct named functions in a file of about 1 MB are read in bounded time", () => {
  const code = Array.from({ length: 30000 }, (_, i) => `function f${i}(e) { return e }\n`).join("") + `function u(e) { require(e) }\nu(${BX});\nconst pad = "${"x".repeat(250_000)}";\n`;
  const t0 = performance.now();
  holds(nested("1.0.0", code, "x/evil.js"), nested("1.0.1", code, "x/evil.js"));
  expect(performance.now() - t0).toBeLessThan(5000);
});

// Fifth review batch.
const CR = `const { createRequire } = require("module"); `;
const fifth: [string, string, string][] = [
  ["a member import( call", `const L = {}; L.import = require; L.import("../x/" + process.argv[2])`, "x/evil.js"],
  ["createRequire on the line after the =", CR + `const r =\n  createRequire(__filename);\nr(${BX})`, "x/evil.js"],
  ["createRequire with CRLF line ends", CR + `const r =\r\n  createRequire(__filename);\r\nr(${BX})`, "x/evil.js"],
  ["createRequire after a multiline comment", CR + `const r = /* a\n b */\n  createRequire(__filename);\nr(${BX})`, "x/evil.js"],
  ["createRequire after a dot", `require("module").createRequire(__filename)(${BX})`, "x/evil.js"],
  ["module.createRequire", `module.createRequire(__filename)(${BX})`, "x/evil.js"],
  ["a recursive call by the inner name of a function expression", `const go = function inner(x) { if (x === "./lib/a") inner(${BX}); require(x); };\ngo("./lib/a");`, "x/evil.js"],
  ["a spawn element held by a name, read from the package root", `const p = "x/" + process.argv[2]; require("child_process").spawnSync("node", [p])`, "x/evil.js"],
  ["an exported function's own direct call", R + `export function go(x) { require(x) }\ngo(${BX})`, "x/evil.js"],
];
for (const [label, hook, changed] of fifth) {
  test(`${label} holds the changed ${changed}`, () => expect(nestHolds(hook, changed)).toBe(true));
}

for (const [label, hook] of [
  ["an execFile callback", `require("child_process").execFile("node", ["--version"], (err, stdout) => console.log(stdout))`],
  ["an execFile callback held by a name", `const cb = (err, stdout) => console.log(stdout); require("child_process").execFile("node", ["--version"], cb)`],
  ["a named tool run with a cwd option", `require("child_process").spawnSync("node-gyp", ["rebuild"], { cwd: __dirname })`],
] as [string, string][]) {
  test(`${label} does not hold an unrelated changed x/evil.js`, () => {
    expect(holds(nested("1.0.0", hook, "x/evil.js"), nested("1.0.1", hook, "x/evil.js"))).toEqual([]);
  });
}

test("2000 createRequire calls in a file of about 1 MB are read in bounded time", () => {
  const code = CR + Array.from({ length: 2000 }, (_, i) => `const r${i} = createRequire(__filename);\n`).join("") + `const pad = "${"x".repeat(950_000)}";\nr7(${BX});\n`;
  const t0 = performance.now();
  holds(nested("1.0.0", code, "x/evil.js"), nested("1.0.1", code, "x/evil.js"));
  expect(performance.now() - t0).toBeLessThan(5000);
});

test("5000 nested calls in a file of about 1 MB are read in bounded time", () => {
  const code = `${"f(".repeat(5000)}1${")".repeat(5000)};\nconst pad = "${"x".repeat(950_000)}";\nrequire(${BX});\n`;
  const t0 = performance.now();
  holds(nested("1.0.0", code, "x/evil.js"), nested("1.0.1", code, "x/evil.js"));
  expect(performance.now() - t0).toBeLessThan(5000);
});

// A loader handed on any way but an immediate call (the enumerated family of the fo16 probe, trimmed).
const LOADER_VALUES: [string, string][] = [
  ["require", "require"],
  ["module.require.bind", "module.require.bind(module)"],
  ["createRequire", `require("module").createRequire(__filename)`],
];
const HANDED: [string, (v: string) => string][] = [
  ["an optional call", (v) => `const r = ${v}; r?.(${BX});`],
  ["a parenthesized call", (v) => `const r = ${v}; (r)(${BX});`],
  [".call", (v) => `const r = ${v}; r.call(null, ${BX});`],
  [".apply", (v) => `const r = ${v}; r.apply(null, [${BX}]);`],
  ["Reflect.apply", (v) => `const r = ${v}; Reflect.apply(r, null, [${BX}]);`],
  ["a member held loader", (v) => `const L = {}; L.load = ${v}; L.load.call(null, ${BX});`],
  ["a logical default", (v) => `const r = null || ${v}; r(${BX});`],
  ["a member named import called directly", (v) => `const L = {}; L.import = ${v}; L.import(${BX});`],
  ["an object literal member named import", (v) => `const L = { import: ${v} }; L.import(${BX});`],
];
for (const [lname, lv] of LOADER_VALUES) {
  for (const [cname, f] of HANDED) {
    test(`${lname} through ${cname} holds the changed x/evil.js`, () => expect(nestHolds(R + f(lv), "x/evil.js")).toBe(true));
  }
}

for (const [label, hook] of [
  ["a function that takes require as a parameter", `function wrap(require, exports, module) { return require("./lib/a"); }`],
  ["typeof require", `if (typeof require !== "undefined") { require("./lib/a") }`],
  ["require.main === module", `if (require.main === module) { require("./lib/a") }`],
  ["require.cache", `delete require.cache[require.resolve("./lib/a")]; require("./lib/a")`],
] as [string, string][]) {
  test(`${label} does not hold an unrelated changed x/evil.js`, () => {
    expect(holds(nested("1.0.0", hook, "x/evil.js"), nested("1.0.1", hook, "x/evil.js"))).toEqual([]);
  });
}

// Sixth review batch.
const MAKE = `const { createRequire: make } = require("module"); `;
for (const [label, hook] of [
  ["an assignment before the loader in the same statement", MAKE + `let other; const r = (other = 1, make(__filename)); r("../x/" + process.argv[2]);`],
  ["a statement too long to read, with an assignment found in it", MAKE + `let other; const r =${" ".repeat(3100)}(other = 1, make(__filename)); r(${BX});`],
] as [string, string][]) {
  test(`${label} holds the changed x/evil.js`, () => expect(nestHolds(hook, "x/evil.js")).toBe(true));
}

// Isolating: nothing here is read as a loader handed on, so only the fix under test can see the load.
test("a member import( call on an ordinary object is read as a load", () => {
  expect(nestHolds(`const L = require("./lib/a"); L.import("../x/" + process.argv[2]);`, "x/evil.js")).toBe(true);
});

const quiet: [string, string][] = [
  ["require as an object key", `const opts = { require: true }; require("./lib/a");`],
  ["require as a word in a list of strings", `const words = ["node", "require"]; require("./lib/a");`],
  ["require in a flag string", `const flag = "--require"; require("./lib/a");`],
  ["require in an AMD define list", `define(["require", "exports"], function (require, exports) { return require("./lib/a"); });`],
  ["require in an error message", `const msg = "Dynamic requires are not supported: use commonjsRequire or require"; require("./lib/a");`],
  ["a createRequire alias that resolves and reads its cache", CR + `const req = createRequire(__filename); req.resolve("./lib/a"); void req.cache; req("./lib/a");`],
  ["a one-letter alias next to a mode string", CR + `const r = createRequire(__filename); r("./lib/a"); const mode = "r"; const eol = "\\r\\n";`],
  ["module.exports = require", `module.exports = require;\nrequire("./lib/a");`],
  ["an arrow whose parameters include require", `const f = (require, exports, module) => require("./lib/a");`],
  ["a wrapped createRequire assignment called with a literal", CR + `const r =\n  createRequire(__filename);\nr("./lib/a");`],
];
for (const [label, hook] of quiet) {
  test(`${label} does not hold an unrelated changed x/evil.js`, () => {
    expect(holds(nested("1.0.0", hook, "x/evil.js"), nested("1.0.1", hook, "x/evil.js"))).toEqual([]);
  });
}

test("a wrapped createRequire assignment is a loader: its call with a built path holds", () => {
  expect(nestHolds(CR + `const r =\n  createRequire(__filename);\nr(${BX});`, "x/evil.js")).toBe(true);
});

test("40000 createRequire aliases in a file of about 1 MB are read in bounded time", () => {
  const code = CR + Array.from({ length: 40000 }, (_, i) => `const a${i} = createRequire(f);\n`).join("") + `a7(${BX});\n`;
  const t0 = performance.now();
  holds(nested("1.0.0", code, "x/evil.js"), nested("1.0.1", code, "x/evil.js"));
  expect(performance.now() - t0).toBeLessThan(5000);
});

// Seventh review batch: loaders reached through a destructuring key, a computed key, an export, a default value.
const SEVENTH = `require("./lib/a");\n`;
for (const [label, hook] of [
  ["a renaming destructure of require from module, called", `const { require: r } = module;\nr(${BX});`],
  ["a renaming destructure of require from module, called with call()", `const { require: r } = module;\nr.call(module, ${BX});`],
  ["a renaming destructure of require from require.main", `const { require: r } = require.main;\nr.call(require.main, ${BX});`],
  ["a nested renaming destructure", `const { m: { require: r } } = { m: module };\nr.call(module, ${BX});`],
  ["a renaming destructure after another key", `const { a, require: r } = module;\nr(${BX});`],
  ["a computed string key of module", `module["require"](${BX});`],
  ["a computed template key of module", `module[\`require\`](${BX});`],
  ["module.exports set to require and then called", `module.exports = require;\nmodule.exports(${BX});`],
  ["module.exports set to require and held by another name", `module.exports = require;\nconst e = module.exports;\ne(${BX});`],
  ["a default value of require in an arrow", `const f = (load = null || require) => load(${BX});\nf();`],
  ["a default value of require in a function", `function f(cb = require) { cb(${BX}); }\nf();`],
  ["require in an array default", `const f = (a = [require]) => a[0](${BX});\nf();`],
  ["a name that ends in function before the list", `myfunction(require);`],
  ["a member named function before the list", `o.function(require);`],
] as [string, string][]) {
  test(`${label} holds the changed x/evil.js`, () => expect(nestHolds(SEVENTH + hook, "x/evil.js")).toBe(true));
}

for (const [label, hook] of [
  ["a createRequire binding first in a function body", CR + `function f(load, opts = {}) {\n  const r = createRequire(__filename);\n  return r("./lib/a");\n}`],
  ["a createRequire binding first in an arrow body", CR + `const f = (load, opts) => {\n  const r = createRequire(__filename);\n  return r("./lib/a");\n};`],
  ["a createRequire binding first in a try body", CR + `try {\n  const r = createRequire(__filename);\n  r("./lib/a");\n} catch {}`],
  ["an exported createRequire binding", CR + `export const r = createRequire(__filename);\nr("./lib/a");`],
  ["a createRequire binding after another declarator", CR + `const a = 1, r = createRequire(__filename);\nr("./lib/a");`],
  ["an alias named r next to a regular expression", CR + `const r = createRequire(__filename);\nr("./lib/a");\nconst re = /r/g;\nre.test("r");`],
] as [string, string][]) {
  test(`${label} does not hold an unrelated changed x/evil.js`, () => {
    expect(holds(nested("1.0.0", hook, "x/evil.js"), nested("1.0.1", hook, "x/evil.js"))).toEqual([]);
  });
}

for (const [label, hook] of [
  ["a function that takes require with a default as a parameter", `function wrap(a, require = null) { return a; }`],
  ["a call that passes an object with a require key", `console.log({ require: true });`],
] as [string, string][]) {
  test(`${label} does not hold an unrelated changed x/evil.js`, () => {
    expect(holds(nested("1.0.0", SEVENTH + hook, "x/evil.js"), nested("1.0.1", SEVENTH + hook, "x/evil.js"))).toEqual([]);
  });
}

// Eighth review batch: a loader key that binds a name in a parameter, catch or for-of pattern; computed keys on other receivers; method parameters.
for (const [label, hook] of [
  ["a destructuring parameter that renames require", `function f({ require: r }) { r.call(module, ${BX}); }\nf(module);`],
  ["a catch binding that renames require", `try { throw module; } catch ({ require: r }) { r.call(module, ${BX}); }`],
  ["a for-of binding that renames require", `for (const { require: r } of [module]) { r.call(module, ${BX}); }`],
  ["a nested destructuring parameter that renames require", `function f({ m: { require: r } }) { r.call(module, ${BX}); }\nf({ m: module });`],
  ["a computed key on a name bound to module", `const m = module;\nm["require"](${BX});`],
  ["a computed key on module.parent", `module.parent["require"](${BX});`],
] as [string, string][]) {
  test(`${label} holds the changed x/evil.js`, () => expect(nestHolds(SEVENTH + hook, "x/evil.js")).toBe(true));
}

for (const [label, hook] of [
  ["a method that takes require as a parameter", `const o = { f(require) { return 1; } };\no.f(1);`],
  ["a class method that takes require as a parameter", `class C { m(require) { return 1; } static s(require, b) { return b; } }\nnew C().m(1);`],
  ["a getter-free async method that takes require", `const o = { async f(require) { return 1; }, *g(require) { yield 1; } };\no.f(1);`],
  ["a catch clause that names its binding require", `try { run(); } catch (require) { console.log(1); }`],
] as [string, string][]) {
  test(`${label} does not hold an unrelated changed x/evil.js`, () => {
    expect(holds(nested("1.0.0", SEVENTH + hook, "x/evil.js"), nested("1.0.1", SEVENTH + hook, "x/evil.js"))).toEqual([]);
  });
}

// Ninth review batch: every computed require key holds unless its receiver is provably a literal; quoted and computed method names; a method called require.
for (const [label, hook] of [
  ["a computed key on a name from an object destructure", `const { m } = { m: module };\nm["require"](${BX});`],
  ["a computed key on a name from an array destructure", `const [m] = [module];\nm["require"](${BX});`],
  ["a computed key on a comma expression", `(0, module)["require"](${BX});`],
  ["a computed key on a ternary", `(1 ? module : null)["require"](${BX});`],
  ["a computed key on a nullish choice", `(module.parent ?? module)["require"](${BX});`],
  ["a computed key on a function result", `function g() { return module; }\ng()["require"](${BX});`],
  ["a computed key on an arrow result", `const g = () => module;\ng()["require"](${BX});`],
  ["a computed key on a parameter", `(function (m) { m["require"](${BX}); })(module);`],
  ["a computed key on a catch binding", `try { throw module; } catch (m) { m["require"](${BX}); }`],
  ["a computed key on a for-of binding", `for (const m of [module]) { m["require"](${BX}); }`],
  ["a computed key on a cache entry", `require.cache[__filename]["require"](${BX});`],
  ["a computed key on a member of an object holding module", `const m = module;\nconst w = { m };\nw.m["require"](${BX});`],
  ["a computed key through an optional chain", `module?.["require"]?.(${BX});`],
  ["a computed key on a parenthesized module", `(module)["require"](${BX});`],
  ["a computed key on a copy of an alias", `const m = module;\nconst n = m;\nn["require"](${BX});`],
  ["Reflect.get of require from module", `Reflect.get(module, "require")(${BX});`],
] as [string, string][]) {
  test(`${label} holds the changed x/evil.js`, () => expect(nestHolds(SEVENTH + hook, "x/evil.js")).toBe(true));
}

for (const [label, hook] of [
  ["a method with a quoted name that takes require", `const o = { "f"(require) { return 1; } };\no.f(1);`],
  ["a method with a computed name that takes require", `const o = { ["f"](require) { return 1; } };\no.f(1);`],
  ["a method named require", `const o = { require(x) { return x; } };\no.require(1);`],
  ["a class method named require", `class C { require(x) { return x; } }\nnew C().require(1);`],
] as [string, string][]) {
  test(`${label} does not hold an unrelated changed x/evil.js`, () => {
    expect(holds(nested("1.0.0", SEVENTH + hook, "x/evil.js"), nested("1.0.1", SEVENTH + hook, "x/evil.js"))).toEqual([]);
  });
}

// Tenth review batch: no receiver is excused from the computed require key; the data-object forms stay documented holds.
for (const [label, hook] of [
  ["a computed key after a function that declares its own module", `function unused() { const module = {}; }\nmodule["require"](${BX});`],
  ["a computed key after a function that declares var module", `function unused() { var module = {}; }\nmodule["require"](${BX});`],
  ["a computed key on a name bound to an empty object and module", `const m = {} && module;\nm["require"](${BX});`],
  ["a computed key on an object whose prototype is set to module", `const m = {};\nm.__proto__ = module;\nm["require"](${BX});`],
  ["a computed key on an object whose quoted prototype is set to module", `const m = {};\nm["__proto__"] = module;\nm["require"](${BX});`],
  ["a computed key on an object that a function later points at module", `const m = {};\nfunction setup() { m.__proto__ = module; }\nsetup();\nm["require"](${BX});`],
  ["a destructured require key from a plain object (documented hold)", `const opts = { require: 1 };\nconst { require: flag } = opts;`],
  ["a computed require key on a data object (documented hold)", `const options = { require: true };\nconsole.log(options["require"]);`],
  ["Reflect.get of a require key on a data object (documented hold)", `const opts = { require: true };\nReflect.get(opts, "require");`],
  ["a name as the value of a require key (documented hold)", `const enabled = true;\nconst options = { require: enabled };\nconsole.log(options);`],
] as [string, string][]) {
  test(`${label} holds the changed x/evil.js`, () => expect(nestHolds(SEVENTH + hook, "x/evil.js")).toBe(true));
}

for (const [label, hook] of [
  ["a method whose body brace follows many spaces", `const o = { require(x)${" ".repeat(20)}{ return x; } };\no.require(1);`],
  ["a class method that takes require with many spaces before the brace", `class C { m(require)${" ".repeat(30)}{ return 1; } }\nnew C().m(1);`],
  ["an arrow that takes require with many spaces before the arrow", `const f = (require)${" ".repeat(30)}=> 1;\nf(1);`],
  ["a require key with a number, a string and null values", `const a = { require: 1, b: { require: "x" }, c: { require: null }, d: { require: false } };\nconsole.log(a);`],
] as [string, string][]) {
  test(`${label} does not hold an unrelated changed x/evil.js`, () => {
    expect(holds(nested("1.0.0", SEVENTH + hook, "x/evil.js"), nested("1.0.1", SEVENTH + hook, "x/evil.js"))).toEqual([]);
  });
}

test("a block after a call on the next line is not a method body", () => {
  expect(nestHolds(SEVENTH + `{\n  require(${BX})\n  { }\n}`, "x/evil.js")).toBe(true);
  expect(nestHolds(SEVENTH + `if (1) {\n  require(${BX})\n  { }\n}`, "x/evil.js")).toBe(true);
});

// Eleventh review batch: a loader name before a line-broken brace is a call; Reflect and Object reads by the string key hold on any receiver.
for (const [label, hook] of [
  ["a method head whose brace is on the next line (accepted false hold)", `const o = {\n  require(x)\n  { return x; }\n};\no.require(1);`],
  ["a method taking require whose brace is on the next line (accepted false hold)", `const o = {\n  f(require)\n  { return 1; }\n};\no.f(1);`],
  ["a call and a block inside a label block", `L: {\n  require(${BX})\n  {}\n}`],
  ["a call and a block inside a case block", `switch (1) { case 1: {\n  require(${BX})\n  {}\n} }`],
  ["a call and a block inside a default block", `switch (1) { default: {\n  require(${BX})\n  {}\n} }`],
  ["a call and a block inside an if label block", `if (1) L: {\n  require(${BX})\n  {}\n}`],
  ["a call and a block inside a do label block", `do L: {\n  require(${BX})\n  {}\n} while (0);`],
  ["a call and a block inside a catch label block", `try { throw 0 } catch (e) { L: {\n  require(${BX})\n  {}\n} }`],
  ["a call and a block inside an arrow label block", `(() => { L: {\n  require(${BX})\n  {}\n} })();`],
  ["a call split across lines before a block inside a label block", `L: {\n  require\n  (${BX})\n  {}\n}`],
  ["Reflect.get with a parenthesized receiver", `Reflect.get((module), "require").call(module, ${BX});`],
  ["a descriptor read through the prototype of module", `Object.getOwnPropertyDescriptor(Object.getPrototypeOf(module), "require").value.call(module, ${BX});`],
  ["a Reflect.get receiver on several lines", `Reflect.get(\n  (\n    module\n  ),\n  "require"\n).call(module, ${BX});`],
] as [string, string][]) {
  test(`${label} holds the changed x/evil.js`, () => expect(nestHolds(SEVENTH + hook, "x/evil.js")).toBe(true));
}

// Twelfth review batch: a read of the loader by a key the file builds, through Reflect or Object.
for (const [label, hook] of [
  ["Reflect.get of module by a name holding require", `const k = "require";\nReflect.get(module, k).call(module, ${BX});`],
  ["Reflect.get of module by a joined key", `Reflect.get(module, ["req", "uire"].join("")).call(module, ${BX});`],
  ["a descriptor of the prototype of module by a name", `const k = "require";\nObject.getOwnPropertyDescriptor(Object.getPrototypeOf(module), k).value.call(module, ${BX});`],
  ["Reflect.getOwnPropertyDescriptor of require.main by a name", `const k = "require";\nReflect.getOwnPropertyDescriptor(Object.getPrototypeOf(require.main), k).value.call(module, ${BX});`],
  ["Object.entries of module", `const e = Object.entries(Object.getPrototypeOf(module));\nconst r = e.find(([n]) => n === "req" + "uire")[1];\nr.call(module, ${BX});`],
  ["Object.assign from module", `const t = Object.assign({}, Object.getPrototypeOf(module));\nt["re" + "quire"].call(module, ${BX});`],
  ["Reflect.get of a name bound to module by a name", `const m = module;\nconst k = "require";\nReflect.get(m, k).call(module, ${BX});`],
  ["Reflect.get of module.parent by a name", `const k = "require";\nReflect.get(module.parent, k).call(module, ${BX});`],
] as [string, string][]) {
  test(`${label} holds the changed x/evil.js`, () => expect(nestHolds(SEVENTH + hook, "x/evil.js")).toBe(true));
}

for (const [label, hook] of [
  ["Object.assign into module.exports", `Object.assign(module.exports, { a: 1 });`],
  ["Object.entries of require.cache", `const n = Object.entries(require.cache).length;`],
  ["Reflect.get on an unrelated object by a name", `const o = { a: 1 };\nconst k = "a";\nReflect.get(o, k);`],
] as [string, string][]) {
  test(`${label} does not hold an unrelated changed x/evil.js`, () => {
    expect(holds(nested("1.0.0", SEVENTH + hook, "x/evil.js"), nested("1.0.1", SEVENTH + hook, "x/evil.js"))).toEqual([]);
  });
}

// Thirteenth review batch: a data key or a shadowing parameter named module is not the loader.
for (const [label, hook] of [
  ["Object.entries of an object with a module key", `Object.entries({ module: 1 });`],
  ["Object.assign of an object with a module key", `Object.assign({}, { module: 1 });`],
  ["Reflect.get of a data object by the key module", `Reflect.get({ a: 1 }, "module");`],
  ["Object.entries of an object with a require key and a module string", `Object.entries({ require: "module" });`],
] as [string, string][]) {
  test(`${label} does not hold an unrelated changed x/evil.js`, () => {
    expect(holds(nested("1.0.0", SEVENTH + hook, "x/evil.js"), nested("1.0.1", SEVENTH + hook, "x/evil.js"))).toEqual([]);
  });
}
for (const [label, hook] of [
  ["a Reflect.get of module after a function with a module parameter", `function f(module) { return module; }\nconst k = "require";\nReflect.get(module, k).call(module, ${BX});`],
  ["an Object.entries of module with a data key beside it", `const d = Object.entries({ module: 1 });\nconst e = Object.entries(Object.getPrototypeOf(module));\ne.find(([n]) => n === "req" + "uire")[1].call(module, ${BX});`],
] as [string, string][]) {
  test(`${label} holds the changed x/evil.js`, () => expect(nestHolds(SEVENTH + hook, "x/evil.js")).toBe(true));
}

// Fourteenth review batch: a parameter named module proves nothing about what is passed; it may hold the real module.
for (const [label, hook] of [
  ["a function parameter named module holding the real module (documented hold)", `function f(module) { Object.entries(module); }\nf({ a: 1 });`],
  ["an arrow parameter named module (documented hold)", `const f = (module) => Object.assign({}, module);\nf({ a: 1 });`],
  ["a function expression called with the real module", `const k = "require";\n(function (module) { Reflect.get(module, k).call(module, ${BX}); })(module);`],
  ["an arrow called with the real module", `const k = "require";\n((module) => Reflect.get(module, k).call(module, ${BX}))(module);`],
  ["an arrow parameter defaulting to require.main", `const k = "require";\n((module = require.main) => Reflect.get(module, k).call(module, ${BX}))();`],
  ["a function called with a name bound to module", `const k = "require";\nconst M = module;\n(function (module) { Reflect.get(module, k).call(module, ${BX}); })(M);`],
  ["a closure over a parameter named module passed the real module", `const k = "require";\nfunction outer(module) { return () => Reflect.get(module, k).call(module, ${BX}); }\nouter(module)();`],
  ["a regex with a brace in a function with a module parameter", `const k = "require";\n(function (module) { /{/; })(0);\nReflect.get(module, k).call(module, ${BX});`],
  ["a template with a brace in a function with a module parameter", "const k = \"require\";\n(function (module) { `{`; })(0);\nReflect.get(module, k).call(module, " + BX + ");"],
] as [string, string][]) {
  test(`${label} holds the changed x/evil.js`, () => expect(nestHolds(SEVENTH + hook, "x/evil.js")).toBe(true));
}

// Fifteenth review batch: the declared-function forms of the brace-in-regex and brace-in-template cases, and a var module cost.
for (const [label, hook] of [
  ["a declared function with a module parameter and a brace in a regex, then the real module read", `function unused(module) { const re = /{/; }\nconst k = "require";\nReflect.get(module, k).call(module, ${BX});`],
  ["a declared function with a module parameter and a brace in a template, then the real module read", "function unused(module) { const t = `{`; }\nconst k = \"require\";\nReflect.get(module, k).call(module, " + BX + ");"],
  ["a var module object read with Object.entries (documented hold)", `var module = { a: 1 };\nObject.entries(module);`],
] as [string, string][]) {
  test(`${label} holds the changed x/evil.js`, () => expect(nestHolds(SEVENTH + hook, "x/evil.js")).toBe(true));
}
