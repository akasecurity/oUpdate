import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { installView } from "../src/install-closure.ts";
import { prepass, type FileMap } from "../src/prepass.ts";

// A file reached by a string that never spells its extension (node resolves `docs/evil` to docs/evil.js) is in the closure
// like one reached by `docs/evil.js`, whether the directory is lib, docs or test.
const enc = (s: string) => new TextEncoder().encode(s);
const toMap = (o: Record<string, string>): FileMap => new Map(Object.entries(o).map(([k, v]) => [k, enc(v)]));

type Hook = "root" | "nested" | "beside";
const HOOKS: Hook[] = ["root", "nested", "beside"];
const TARGETS = ["lib", "docs", "test"];

// The path of <dir>/evil, spelled without an extension, from the loader file's directory.
const pathExpr = (dir: string, up: string) => `require("path").join(__dirname, "${up}", ["${dir}", "evil"].join("/"))`;
const B = (up: string) => `require("path").join(__dirname, "${up}", "b.js")`;

type Shape = { name: string; body: (p: string, up: string) => string; esm?: boolean };
const SHAPES: Shape[] = [
  { name: "require.main.require", body: (p) => `require.main.require(${p});` },
  { name: "destructured _load", body: (p) => `const { _load } = require("module"); _load(${p});` },
  { name: "Reflect.get(Module, _load)", body: (p) => `const M = require("module"); Reflect.get(M, "_load")(${p});` },
  { name: "Reflect.apply(Module._load)", body: (p) => `const M = require("module"); Reflect.apply(M._load, M, [${p}]);` },
  { name: "Module._load.call", body: (p) => `const M = require("module"); M._load.call(M, ${p});` },
  { name: "cluster.setupMaster exec", body: (p) => `const c = require("cluster"); c.setupMaster({ exec: ${p} }); c.fork();` },
  { name: "Object.assign(cluster.settings)", body: (p) => `const c = require("cluster"); Object.assign(c.settings, { exec: ${p} }); c.fork();` },
  { name: "cluster.settings.exec =", body: (p) => `const c = require("cluster"); c.settings.exec = ${p}; c.fork();` },
  { name: "child_process.fork", body: (p) => `require("child_process").fork(${p});` },
  { name: "Worker(path)", body: (p) => `const { Worker } = require("worker_threads"); new Worker(${p});` },
  { name: "fork execArgv --require", body: (p, up) => `require("child_process").fork(${B(up)}, [], { execArgv: ["--require", ${p}] });` },
  { name: "process.execArgv push --require + fork", body: (p, up) => `process.execArgv.push("--require", ${p}); require("child_process").fork(${B(up)});` },
  {
    name: "Worker(url) in an ES module",
    esm: true,
    body: (_p, up) => `import { Worker } from "node:worker_threads"; new Worker(new URL(["${up}/DIR/", "evil"].join(""), import.meta.url));`,
  },
];

// The files of one release: only <dir>/evil.js changes between versions.
function layout(shape: Shape, hook: Hook, dir: string, v: string, extra: Record<string, string> = {}): Record<string, string> {
  const ldir = hook === "root" ? "" : hook === "nested" ? "lib" : dir;
  const up = ldir ? ".." : ".";
  const ext = shape.esm ? "mjs" : "js";
  const body = shape.body(pathExpr(dir, up), up).replaceAll("DIR", dir);
  const loaderFile = ldir ? `${ldir}/x.${ext}` : `h.${ext}`;
  const hookFile = hook === "root" ? loaderFile : "h.js";
  const hookText = hook === "root" ? `${body}\n` : shape.esm ? `import("./${loaderFile}");\n` : `require("./${loaderFile}");\n`;
  return {
    "package.json": JSON.stringify({ name: "p", version: v, scripts: { postinstall: `node ${hookFile}` } }),
    [hookFile]: hookText,
    ...(hook === "root" ? {} : { [loaderFile]: `${body}\n` }),
    "b.js": "1\n",
    [`${dir}/evil.js`]: `require("fs").writeFileSync(process.env.MARK, "${v}"); if (process.connected) process.disconnect();\n`,
    ...extra,
  };
}
const held = (a: Record<string, string>, b: Record<string, string>) => prepass("npm", toMap(a), toMap(b)).hard.some((s) => s.kind === "install-script");

for (const shape of SHAPES) {
  for (const dir of TARGETS) {
    test(`${shape.name}: a changed ${dir}/evil named without its extension holds`, () => {
      for (const hook of HOOKS) {
        expect(held(layout(shape, hook, dir, "1.0.0"), layout(shape, hook, dir, "1.0.1"))).toBe(true);
      }
    });
  }
}

test("a plain extension-less require literal still holds", () => {
  for (const dir of TARGETS) {
    const f = (v: string) => ({
      "package.json": JSON.stringify({ name: "p", version: v, scripts: { postinstall: "node h.js" } }),
      "h.js": `require("./${dir}/evil");\n`,
      [`${dir}/evil.js`]: `console.log("${v}")\n`,
    });
    expect(held(f("1.0.0"), f("1.0.1"))).toBe(true);
  }
});

test("a changed extension-less-named file no string of the hook spells stays quiet", () => {
  for (const dir of TARGETS) {
    const f = (v: string) => ({
      "package.json": JSON.stringify({ name: "p", version: v, scripts: { postinstall: "node h.js" } }),
      "h.js": `require("./b.js");\n`,
      "b.js": "1\n",
      [`${dir}/evil.js`]: `console.log("${v}")\n`,
    });
    expect(held(f("1.0.0"), f("1.0.1"))).toBe(false);
  }
});

test("an unchanged extension-less target stays quiet", () => {
  for (const shape of SHAPES) {
    const same = layout(shape, "root", "docs", "1.0.0");
    const next = { ...same, "package.json": same["package.json"]!.replace("1.0.0", "1.0.1") };
    expect(held(same, next)).toBe(false);
  }
});

// A bare quoted word names a file by its stem only as an operand of a path call (join, resolve, fork, spawn, Worker, new URL) or as an
// item of an array a .join( closes. The same word in a log line, a comparison or a require specifier (a package or built-in module name,
// never a file of the package) leaves the same-stem file out.
// A hook that is not provably static (it loads b.js through require.main.require) and names no other file.
const nonStaticHook = (body: string) => `require.main.require(require("path").join(__dirname, "b.js"));\n${body}\n`;
const release = (v: string, hook: string, changed: Record<string, string> = {}, extra: Record<string, string> = {}) => ({
  "package.json": JSON.stringify({ name: "p", version: v, scripts: { postinstall: "node h.js" } }),
  "h.js": hook,
  "b.js": "1\n",
  ...Object.fromEntries(Object.entries(changed).map(([k, body]) => [k, `${body}${v}\n`])),
  ...extra,
});

test("a quoted word that is not the operand of a path call leaves the same-stem file out", () => {
  const hook = nonStaticHook(`const s = "evil"; console.log("evil", s === "evil");`);
  for (const dir of TARGETS) {
    expect(held(release("1.0.0", hook, { [`${dir}/evil.js`]: "//" }), release("1.0.1", hook, { [`${dir}/evil.js`]: "//" }))).toBe(false);
  }
});

test("a bare word in a path call holds the same-stem file", () => {
  const hook = nonStaticHook(`require("child_process").fork(require("path").join(__dirname, "evil"));`);
  for (const dir of TARGETS) {
    expect(held(release("1.0.0", hook, { [`${dir}/evil.js`]: "//" }), release("1.0.1", hook, { [`${dir}/evil.js`]: "//" }))).toBe(true);
  }
});

// A word with a directory part (docs/evil) is a path wherever it is quoted, in a call or a variable.
test("a slash path with no extension holds the file it resolves to", () => {
  for (const dir of TARGETS) {
    for (const hook of [
      `require("child_process").fork(require("path").join(__dirname, "${dir}/evil"));\n`,
      `const x = "${dir}/evil";\nrequire(require("path").join(__dirname, x));\n`,
    ]) {
      expect(held(release("1.0.0", hook, { [`${dir}/evil.js`]: "//" }), release("1.0.1", hook, { [`${dir}/evil.js`]: "//" }))).toBe(true);
    }
  }
});

// The ESM loader flags and the test runner's files read the path as spelled (no extension search), so a bare stem there loads nothing.
test("an extension-less path under an ESM loader flag or the test runner stays quiet", () => {
  for (const hook of [
    nonStaticHook(`require("node:test").run({ files: [["docs", "evil"].join("/")], isolation: "none" });`),
    nonStaticHook(`require("child_process").fork(require("path").join(__dirname, "b.js"), [], { execArgv: ["--import", ["docs", "evil"].join("/")] });`),
  ]) {
    expect(held(release("1.0.0", hook, { "docs/evil.js": "//" }), release("1.0.1", hook, { "docs/evil.js": "//" }))).toBe(false);
  }
});

// A path call nested in a wrapper, an import() or beside a loader flag still holds: only the string a callee or flag reads as spelled is dropped.
const P = (stem: string) => `require("path").join(__dirname, "..", ["docs", "${stem}"].join("/"))`;
const nested = (body: string, stem: string, v: string) => ({
  "package.json": JSON.stringify({ name: "p", version: v, scripts: { postinstall: "node h.js" } }),
  "h.js": `require("./lib/x.js");\n`,
  "lib/x.js": `require.main.require(${P("b")});\n${body}\n`,
  "b.js": "1\n",
  [`docs/${stem}.js`]: `//${v}\n`,
});
const CP = `const cp = require("child_process");`;
const GO = "const go = (a) => a;";
const NESTED: [string, (stem: string) => string][] = [
  ["a user run wrapper around require.main.require", (s) => `const run = (p) => require.main.require(p); run(${P(s)});`],
  ["a user run call around require.main.require", (s) => `function run(x) { return x; } run(require.main.require(${P(s)}));`],
  ["--import beside --require in an argument array", (s) => `${GO} go(["--import", "data:text/javascript,0", "--require", ${P(s)}]);`],
  ["--import beside --require in an options object", (s) => `${GO} go({ execArgv: ["--import", "data:text/javascript,0", "--require", ${P(s)}] });`],
  ["a --import case label in the enclosing block", (s) => `function f(a) { switch (a) { case "--import": break; default: require.main.require(${P(s)}); } } f(1);`],
  ["a --loader constant in the enclosing block", (s) => `function f() { const F = "--loader"; require.main.require(${P(s)}); } f();`],
  ["a program word as a path component", (s) => `require.main.require(${P(s)});`],
];
for (const [name, body] of NESTED) {
  test(`${name}: a changed same-stem file holds`, () => {
    const stem = name.startsWith("a program word") ? "node" : "evil";
    expect(held(nested(body(stem), stem, "1.0.0"), nested(body(stem), stem, "1.0.1"))).toBe(true);
  });
}

test("a program word as the command, or a string a callee or flag reads as spelled, stays quiet", () => {
  const quiet = [
    `const cp = require("child_process"); cp.spawn("node", ["b.js"]); cp.execFile("npm", ["run"]);`,
    `import("node"); require("node:test").run({ files: ["node"] });`,
    `${GO} go(["--import", "node", "--experimental-loader", ["docs", "node"].join("/")]);`,
  ];
  for (const body of quiet) expect(held(nested(body, "node", "1.0.0"), nested(body, "node", "1.0.1"))).toBe(false);
});

// The hook is the root file itself, so nothing but the fork or spawn it runs reaches the changed file.
const rootHook = (hook: string, v: string, changed = "docs/evil.js", extra: Record<string, string> = {}) => ({
  "package.json": JSON.stringify({ name: "p", version: v, scripts: { postinstall: "node h.js" } }),
  "h.js": hook,
  "b.js": "1\n",
  ...extra,
  [changed]: `//${v}\n`,
});
const FORK = `require("child_process").fork(require("path").join(__dirname, "b.js"), [], { execArgv: ["--import", "data:text/javascript,0", "--require", require("path").join(__dirname, "docs", "evil")] });`;

test("a --require beside an --import in fork's execArgv holds, also inside a block that names a loader flag", () => {
  for (const hook of [`${FORK}\n`, `{\n  const F = "--loader";\n  ${FORK}\n}\n`]) {
    expect(held(rootHook(hook, "1.0.0"), rootHook(hook, "1.0.1"))).toBe(true);
  }
});

test("a function wrapper around require.main.require holds the path it is handed", () => {
  const call = `run(require("path").join(__dirname, "..", ["docs", "evil"].join("/")));`;
  for (const wrap of [`function run(p) { return require.main.require(p); }`, `const run = (p) => require.main.require(p);`]) {
    const files = (v: string) => ({ ...rootHook("", v), "package.json": JSON.stringify({ name: "p", version: v, scripts: { postinstall: "node scripts/h.js" } }), "scripts/h.js": `${wrap}\n${call}\n` });
    expect(held(files("1.0.0"), files("1.0.1"))).toBe(true);
  }
});

// node runs the first argument of a node command from the working directory: a bare name there is a root file, not a same-stem file anywhere. The other arguments are not paths.
test("the arguments of a spawned command are not same-stem paths", () => {
  for (const hook of [
    `require("child_process").spawnSync("node", ["index"], { stdio: "inherit" });\n`,
    `require("child_process").spawnSync("npm", ["index", "run"]);\n`,
    `require("child_process").fork(require("path").join(__dirname, "b.js"), ["index"]);\n`,
  ]) {
    const files = (v: string) => rootHook(hook, v, "lib/index.js", { "index.js": "module.exports = 1;\n" });
    expect(held(files("1.0.0"), files("1.0.1"))).toBe(false);
  }
  const root = (v: string) => rootHook(`require("child_process").spawnSync("node", ["evil"]);\n`, v, "evil.js");
  expect(held(root("1.0.0"), root("1.0.1"))).toBe(true);
});

// The hook runs from scripts/, so the package root is no sibling of it: a root file is reached only by the script a spawn names.
const scriptsHook = (hook: string, v: string, changed = "evil.js", extra: Record<string, string> = {}) => ({
  "package.json": JSON.stringify({ name: "p", version: v, scripts: { postinstall: "node scripts/h.js" } }),
  "scripts/h.js": hook,
  "b.js": "1\n",
  ...extra,
  [changed]: `//${v}\n`,
});

test("flags before the script, and a path or .exe or ternary command, still hold the changed file", () => {
  const CPR = `require("child_process")`;
  for (const hook of [
    `${CPR}.spawn("node", ["-r", "./evil", "b.js"]);\n`,
    `${CPR}.spawn("node", ["--no-warnings", "evil"]);\n`,
    `${CPR}.spawn("node", ["--no-warnings", "--no-deprecation", "evil"]);\n`,
    `${CPR}.spawn("/usr/bin/node", ["evil"]);\n`,
    `${CPR}.spawn("node.exe", ["evil"]);\n`,
    `const c = Math.random() > 0.5; ${CPR}.spawn(c ? "node.exe" : "node", ["evil"]);\n`,
    `const c = Math.random() > 0.5; ${CPR}.spawn(c ? "nodejs.exe" : "/opt/x/node", ["evil"]);\n`,
  ]) {
    const files = (v: string) => scriptsHook(hook, v, "docs/evil.js");
    expect(held(files("1.0.0"), files("1.0.1"))).toBe(true);
  }
});

// Words in the options object after the args array (a stdio array of quoted words) must not move the command word out of its place:
// a program named node is still the node whose script is the next word, and lib/node.js holds as it did before.
test("a node command with an options object of quoted words still holds a changed file named node.js", () => {
  const CPR = `require("child_process")`;
  const stdio = (n: number) => `[${["ignore", "inherit", "inherit", "pipe"].slice(0, n).map((w) => `"${w}"`).join(", ")}]`;
  const hooks = [
    // Three and four quoted words in the options (two are not held, before or now), then a flag before the script, an env array, a shell option beside the array,
    // and a ternary command.
    ...[3, 4].map((n) => `${CPR}.spawn("node", ["--no-warnings", "build"], { stdio: ${stdio(n)} });\n`),
    ...[3, 4].map((n) => `${CPR}.spawn("node", ["build"], { stdio: ${stdio(n)} });\n`),
    ...[3, 4].map((n) => `${CPR}.spawnSync("node", ["build"], { stdio: ${stdio(n)} });\n`),
    `${CPR}.spawn("node", ["build"], { env: ["a", "b", "c"] });\n`,
    `${CPR}.spawn("node", ["build"], { stdio: ${stdio(3)}, shell: "sh" });\n`,
    `const c = Math.random() > 0.5; ${CPR}.spawn(c ? "npm" : "node", ["build"], { stdio: ${stdio(3)} });\n`,
    `const c = Math.random() > 0.5; ${CPR}.spawn(c ? "node" : "npm", ["build"], { stdio: ${stdio(4)} });\n`,
  ];
  for (const hook of hooks) {
    const files = (v: string) => scriptsHook(hook, v, "lib/node.js");
    expect(held(files("1.0.0"), files("1.0.1"))).toBe(true);
  }
});

test("flags and program commands stay quiet when no same-stem file changed", () => {
  for (const hook of [
    `require("child_process").spawn("node", ["index"]);\n`,
    `require("child_process").spawn("node", ["--no-warnings", "index"]);\n`,
    `require("child_process").spawn("/usr/bin/node", ["index"]);\n`,
    `require("child_process").spawn("npm", ["install"]);\n`,
    `require("child_process").spawn("sh", ["-c", "test"]);\n`,
    `require("child_process").spawn("node.exe", ["-v"]);\n`,
  ]) {
    const files = (v: string) => rootHook(hook, v, "lib/index.js", { "index.js": "module.exports = 1;\n", "docs/test.js": "//" });
    expect(held(files("1.0.0"), files("1.0.1"))).toBe(false);
  }
});

// node resolves a bare script from the working directory: the file, .js, .json, .node or a directory's index.js.
test("a bare script a node command runs holds the file node resolves it to", () => {
  const hook = `require("child_process").spawn("node", ["evil"]);\n`;
  for (const changed of ["evil.node", "evil/index.js", "evil.js"]) {
    const files = (v: string) => scriptsHook(hook, v, changed);
    expect(held(files("1.0.0"), files("1.0.1"))).toBe(true);
  }
  const elsewhere = (v: string) => scriptsHook(hook, v, "lib/evil/index.js");
  expect(held(elsewhere("1.0.0"), elsewhere("1.0.1"))).toBe(false);
});

// A subscript key is not the args array. Each of these also reads a hook that is not provably static, so only the spawn reaches the file.
test("a subscript in the command is not the args array", () => {
  for (const cmd of [`process.env["NODE"] ?? "node"`, `cmds["node"]`, `process.env["npm_node_execpath"] || "node"`, `process.env["NODE"]`, `cmds["nodejs"]`]) {
    const hook = `const cmds = {}; require("child_process").spawn(${cmd}, ["evil"]);\n`;
    const files = (v: string) => scriptsHook(hook, v, "docs/evil.js");
    expect(held(files("1.0.0"), files("1.0.1"))).toBe(true);
  }
});

// The shapes below were held before the node-args change, so the change must still hold them. The prefix makes the hook not provably static,
// and b.js does not change, so the file is reached only through the later spawn.
test("a program word spelled as a path, a subscript key or a leading flag still names the file it did", () => {
  const cases: [string, string][] = [
    [`require("child_process").spawn("./make")`, "docs/make.js"],
    [`require("child_process").spawn("../make")`, "docs/make.js"],
    [`require("child_process").spawn(process.env["evil"])`, "docs/evil.js"],
    [`require("child_process").spawn(bins["evil"])`, "docs/evil.js"],
    [`require("child_process").spawnSync(process.execPath, argv["evil"])`, "docs/evil.js"],
    [`require("child_process").execFile(process.execPath, ARGS["evil"])`, "docs/evil.js"],
    [`require("child_process").spawn("node", ["-v", "evil"])`, "docs/-v.js"],
    [`require("child_process").spawn("node", ["--evil"])`, "docs/--evil.js"],
    [`export default ["..", "evil"].join("/")`, "evil.js"],
    [`if (x) ["..", "docs", "evil"].join("/")`, "docs/evil.js"],
  ];
  for (const [body, changed] of cases) {
    const hook = nonStaticHook(`const bins = {}, argv = {}, ARGS = {}; ${body};`);
    const files = (v: string) => rootHook(hook, v, changed);
    expect(held(files("1.0.0"), files("1.0.1"))).toBe(true);
  }
});

test("fork takes a module path, so a program name there is a file name", () => {
  for (const name of ["make", "tar"]) {
    const hook = `require("child_process").fork("${name}");\n`;
    const files = (v: string) => rootHook(hook, v, `docs/${name}.js`);
    expect(held(files("1.0.0"), files("1.0.1"))).toBe(true);
  }
});

test("a function body under run( or import( is code: its join arrays name files", () => {
  const hook = nonStaticHook(`require("node:test").run(() => { require.main.require(["..", "docs", "evil"].join("/")); });`);
  const files = (v: string) => release(v, hook, { "docs/evil.js": "//" });
  expect(held(files("1.0.0"), files("1.0.1"))).toBe(true);
});

// Time of one installView over a hook; the best of three runs.
const holdTime = (hook: string): number => {
  let best = Infinity;
  for (let r = 0; r < 3; r++) {
    const t = performance.now();
    held(rootHook(hook, "1.0.0", "docs/evil.js"), rootHook(hook, "1.0.1", "docs/evil.js"));
    best = Math.min(best, performance.now() - t);
  }
  return best;
};

// Every array a command call closes once looked through all the words before it for node: time grew with words times arrays.
test("many args arrays or object literals in one command call scan in linear time", () => {
  const shapes: [string, (n: number) => string, number][] = [
    ["objects and empty arrays after a custom command", (n) => `require("child_process").spawn("custom", ${'{x:"evil"},[],'.repeat(n)} () => {});\n`, 1],
    ["as many words as empty arrays", (n) => `require("child_process").spawn("a", ${`"${"a ".repeat(200)}", `.repeat(n / 200)}${"[],".repeat(n)} 0);\n`, 4],
  ];
  for (const [name, hook, scale] of shapes) {
    const t4 = holdTime(hook(4000 / scale));
    const t8 = holdTime(hook(8000 / scale));
    const t16 = holdTime(hook(16000 / scale));
    const label = `${name}: ${t4.toFixed(0)} / ${t8.toFixed(0)} / ${t16.toFixed(0)} ms at size 1x / 2x / 4x`;
    expect(`${label}: ${t16 < 3000}`).toBe(`${label}: true`);
    // 4x the size: linear is about 4x, quadratic about 16x.
    expect(`${label}: ${t16 / Math.max(t4, 25) < 9}`).toBe(`${label}: true`);
  }
}, 120_000);

test("a word in a log line stays quiet when an unrelated file of that stem changes", () => {
  const hook = `require.main.require(require("path").join(__dirname, "b.js")); console.log("test");\n`;
  for (const stem of ["test", "index", "lib", "main"]) {
    const dir = stem === "test" ? "docs" : "lib";
    expect(held(release("1.0.0", hook, { [`${dir}/${stem}.js`]: "//" }), release("1.0.1", hook, { [`${dir}/${stem}.js`]: "//" }))).toBe(false);
  }
});

test("built-in module names and event words never pull a same-stem file in", () => {
  const words = ["path", "util", "events", "stream", "http", "crypto", "module", "child_process", "node", "error", "exit", "close", "data", "utf8", "darwin", "linux", "win32", "arm64"];
  const hook = nonStaticHook(
    `${words.map((w, i) => `const m${i} = require("${w}");`).join(" ")} const names = ${JSON.stringify(words)}; require("child_process").spawn("node", ["b.js"]);`,
  );
  const changed = Object.fromEntries(words.map((w) => [`lib/${w}.js`, "//"]));
  expect(held(release("1.0.0", hook, changed), release("1.0.1", hook, changed))).toBe(false);
});

// A file the hook walk scanned first is scanned again under a gyp command, so what it reaches is a gyp file too (scripts-off roots read gypFiles).
for (const [label, token, entry] of [
  ["a dotted name", "build.js", "build.js"],
  ["a bare name", "build", "build.js"],
  ["a path with no extension", "lib/build", "lib/build.js"],
] as const) {
  test(`the files a gyp action reaches stay gyp files when the hook walk named the script by ${label}`, () => {
    const files: Record<string, string> = {
      "package.json": JSON.stringify({ name: "p", version: "1.0.0", scripts: { postinstall: "node h.js" } }),
      "h.js": `require(process.env.X); require("path").join(__dirname, "${token}");\n`,
      "build.js": `require("./child.js");\n`,
      "lib/build.js": `require("../child.js");\n`,
      "child.js": "1\n",
      "binding.gyp": `{'targets':[{'target_name':'a','actions':[{'action_name':'x','inputs':[],'outputs':[],'action':['node','${entry}']}]}]}`,
    };
    const view = installView(toMap(files));
    expect(view.hold).toBeUndefined();
    expect(view.gypFiles).toContain(entry);
    expect(view.gypFiles).toContain("child.js");
  });
}

// The ground-truth run needs a real node on PATH: a host without one skips it, and CI (CI set) fails instead.
const nodeProbe = spawnSync("node", ["--version"], { stdio: "ignore" });
const hasNode = nodeProbe.error === undefined && nodeProbe.status === 0;

test("node is available for the ground-truth run in CI", () => {
  if (process.env.CI) expect(hasNode).toBe(true);
  else if (!hasNode) console.warn("node is not on PATH: the ground-truth run below is skipped");
});

test.skipIf(!hasNode)("node really runs the extension-less target for the shapes that hold", () => {
  const dir = "docs";
  for (const shape of SHAPES) {
    const root = mkdtempSync(join(tmpdir(), "noext-"));
    try {
      const files = layout(shape, "root", dir, "1.0.1");
      const pkg = join(root, "p");
      for (const [p, c] of Object.entries(files)) {
        mkdirSync(dirname(join(pkg, p)), { recursive: true });
        writeFileSync(join(pkg, p), c);
      }
      const run = (JSON.parse(files["package.json"]!) as { scripts: { postinstall: string } }).scripts.postinstall;
      const r = spawnSync("sh", ["-c", run], { cwd: pkg, env: { ...process.env, MARK: join(root, "RAN") }, timeout: 20000, encoding: "utf8" });
      const ran = existsSync(join(root, "RAN"));
      expect(`${shape.name}: ${ran ? "ran" : `did not run (status ${r.status}, ${r.error?.message ?? String(r.stderr).split("\n").find((l) => /Error/.test(l)) ?? "no error line"})`}`).toBe(`${shape.name}: ran`);
      expect(held(layout(shape, "root", dir, "1.0.0"), files)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
}, 120_000);

// The same flag-before-script and path-command shapes, run by real node from the package root. The hook sits in scripts/, so the root
// file is reached only by the spawn, and the command is spelled with the path of the node binary found on PATH.
const foundNode = hasNode ? Bun.which("node") : null;
const nodePath = foundNode ? resolve(foundNode) : "";
const nodePathAbsolute = isAbsolute(nodePath);

test("the node binary found on PATH has an absolute path in CI", () => {
  if (process.env.CI && hasNode) expect(nodePathAbsolute).toBe(true);
  else if (hasNode && !nodePathAbsolute) console.warn("the node path is not absolute: the path-spelled run below is skipped");
});

test.skipIf(!hasNode || !nodePathAbsolute)("node really runs the script of a spawn with a flag before it or a path-spelled command", () => {
  const CPR = `require("child_process")`;
  for (const hook of [
    `${CPR}.spawnSync("node", ["--no-warnings", "evil"], { stdio: "ignore" });\n`,
    `${CPR}.spawnSync("node", ["-r", "./evil", "b.js"], { stdio: "ignore" });\n`,
    `${CPR}.spawnSync(${JSON.stringify(nodePath)}, ["evil"], { stdio: "ignore" });\n`,
    `${CPR}.spawnSync(${JSON.stringify(nodePath)}, ["--no-warnings", "evil"], { stdio: "ignore" });\n`,
  ]) {
    const root = mkdtempSync(join(tmpdir(), "nodeargs-"));
    try {
      const files: Record<string, string> = { ...scriptsHook(hook, "1.0.1", "evil.js"), "evil.js": `require("fs").writeFileSync(process.env.MARK, "1");\n` };
      const pkg = join(root, "p");
      for (const [p, c] of Object.entries(files)) {
        mkdirSync(dirname(join(pkg, p)), { recursive: true });
        writeFileSync(join(pkg, p), c);
      }
      spawnSync("sh", ["-c", "node scripts/h.js"], { cwd: pkg, env: { ...process.env, MARK: join(root, "RAN") }, timeout: 20000 });
      expect(existsSync(join(root, "RAN"))).toBe(true);
      expect(held(scriptsHook(hook, "1.0.0", "evil.js"), files)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
}, 60_000);
