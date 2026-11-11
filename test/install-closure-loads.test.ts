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
  ["require as a destructured key", `const opts = { require: 1 }; const { require: flag } = opts; require("./lib/a");`],
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
