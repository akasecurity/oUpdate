import { expect, test } from "bun:test";
import { prepass, type FileMap } from "../src/prepass.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const files = (o: Record<string, string>): FileMap => new Map(Object.entries(o).map(([k, v]) => [k, enc(v)]));
const holds = (old: FileMap, now: FileMap) => prepass("npm", old, now).hard.some((s) => s.kind === "install-script");

// An entry loads docs/evil.js through a name built or decoded in the entry. Only docs/evil.js changes between the releases.
const release = (v: string, entry: string, body: string, hook = "postinstall") =>
  files({
    "package.json": JSON.stringify({ name: "p", version: v, scripts: { [hook]: `node ${entry}` } }),
    [entry]: body,
    "lib/a.js": "module.exports = 1\n",
    "a.js": "module.exports = 1\n",
    "docs/evil.js": `console.log("evil ${v}")\n`,
  });
const held = (entry: string, body: string, hook = "postinstall") => holds(release("1.0.0", entry, body, hook), release("1.0.1", entry, body, hook));
const nested = (n: string) => `${n}\nrequire("../docs/" + n);\n`;

const folded: [string, string][] = [
  ["a join of literals", `const n = ["evil", "js"].join(".");`],
  ["a + of literals", `const n = "ev" + "il.js";`],
  ["a template with no substitution", "const n = `evil.js`;"],
  ["a base64 decode", `const n = Buffer.from("ZXZpbC5qcw==", "base64").toString();`],
  ["an atob decode", `const n = atob("ZXZpbC5qcw==");`],
  ["a template of held names", 'const a = "evil"; const n = `${a}.js`;'],
  ["a name read through another name", `const m = "ev" + "il.js"; const n = m;`],
  ["a name extended with +=", `let n = "ev"; n += "il.js";`],
  ["a concat of literals", `const n = "ev".concat("il.js");`],
];
for (const [label, decl] of folded) {
  test(`${label} used in a concatenated require holds the changed docs/evil.js`, () => {
    expect(held("lib/x.js", `${decl}\nrequire("../docs/" + n);\n`)).toBe(true);
  });
}

test("the four reported shapes hold on a .js entry", () => {
  for (const decl of [`const n = ["evil","js"].join(".");`, `const n = "ev" + "il.js";`, "const n = `evil.js`;", `const n = Buffer.from("ZXZpbC5qcw==", "base64").toString();`]) {
    expect(held("lib/x.js", nested(decl))).toBe(true);
  }
});

test("the same shapes hold on a .cjs entry", () => {
  for (const decl of [`const n = ["evil","js"].join(".");`, `const n = "ev" + "il.js";`, "const n = `evil.js`;", `const n = Buffer.from("ZXZpbC5qcw==", "base64").toString();`]) {
    expect(held("lib/x.cjs", nested(decl))).toBe(true);
  }
});

test("a folded name holds from the package root, from a nested entry and from a preinstall hook", () => {
  const decl = `const n = ["evil", "js"].join(".");`;
  expect(held("x.js", `${decl}\nrequire("./docs/" + n);\n`)).toBe(true);
  expect(held("a/b/x.js", `${decl}\nrequire("../../docs/" + n);\n`)).toBe(true);
  expect(held("lib/x.js", nested(decl), "preinstall")).toBe(true);
  expect(held("lib/x.js", `${decl}\nrequire(\`../docs/\${n}\`);\n`)).toBe(true);
  expect(held("lib/x.js", `${decl}\nconst r = require;\nr("../docs/" + n);\n`)).toBe(true);
  expect(held("lib/x.js", `${decl}\nimport("../docs/" + n);\n`)).toBe(true);
});

// The shapes main already held stay held.
const controls: [string, string][] = [
  ["a plain literal", `const n = "evil.js";`],
  ["a trim", `const n = "evil.js".trim();`],
  ["String()", `const n = String("evil.js");`],
  ["a replace", `const n = "x".replace("x", "evil.js");`],
  ["a local function", `function f() { return "evil.js"; }\nconst n = f();`],
  ["an array index", `const n = ["evil.js"][0];`],
  ["an object member", `const o = { k: "evil.js" };\nconst n = o.k;`],
  ["JSON.parse", `const n = JSON.parse('"evil.js"');`],
  ["an argv default", `const n = process.argv[9] ?? "evil.js";`],
];
for (const [label, decl] of controls) {
  test(`control, ${label}: still holds the changed docs/evil.js`, () => {
    expect(held("lib/x.js", nested(decl))).toBe(true);
  });
}
test("control: the join inline in the require still holds", () => {
  expect(held("lib/x.js", `require("../docs/" + ["evil", "js"].join("."));\n`)).toBe(true);
});

// Entries that name no computed path, or whose names are not built from literals, stay quiet when only a doc changes.
const quiet: [string, string, string][] = [
  ["a literal name", "lib/x.js", `const n = "a.js";\nrequire("./" + "a.js");\nconsole.log(n);\n`],
  ["a path.join of literals", "lib/x.js", `const path = require("path");\nrequire(path.join(__dirname, "a.js"));\n`],
  ["a plain require", "lib/x.js", `require("./a.js");\n`],
  ["a folded name that is only printed", "lib/x.js", `const n = ["evil", "js"].join(".");\nconsole.log(n);\nrequire("./a");\n`],
  ["a plain-literal name in a concatenated require of a literal-headed file", "lib/x.js", `const n = "a.js";\nrequire("./" + n);\n`],
  ["a root entry with a plain require", "x.js", `require("./lib/a");\n`],
];
for (const [label, entry, body] of quiet) {
  test(`${label} stays quiet when only docs/evil.js changes`, () => {
    expect(held(entry, body)).toBe(false);
  });
}

// Time is judged against the same shape at a smaller size on the same host (median of 3), never against a fixed number of seconds.
const median = (f: () => void): number => {
  const ts = [0, 0, 0].map(() => {
    const s = performance.now();
    f();
    return performance.now() - s;
  });
  return ts.sort((a, b) => a - b)[1]!;
};
const FLOOR_MS = 50;

test("a file near 1 MB with many folded names and computed requires is read in time that follows the number of names", () => {
  const make = (names: number) => Array.from({ length: names }, (_, i) => `const n${i} = "a" + "${i}";\nrequire("../lib/" + n${i});\n`).join("") + `const pad = "${"x".repeat(850_000)}";\n`;
  expect(held("lib/x.js", make(3000))).toBe(true);
  const small = median(() => held("lib/x.js", make(300)));
  const big = median(() => held("lib/x.js", make(3000)));
  expect(big / Math.max(small, FLOOR_MS)).toBeLessThan(12);
}, 600_000);

// A command that runs docs/evil.js through a folded name: the runner forms read the name like a require does.
const RUN = `const cp = require("child_process");\n`;
const runners: [string, string][] = [
  ["execSync", `cp.execSync("node docs/" + n);`],
  ["exec", `cp.exec("node docs/" + n);`],
  ["execFileSync", `cp.execFileSync("node", ["docs/" + n]);`],
  ["spawnSync", `cp.spawnSync("node", ["docs/" + n]);`],
  ["spawnSync with a command string", `cp.spawnSync("node docs/" + n, { shell: true });`],
  ["execSync with a template", "cp.execSync(`node docs/${n}`);"],
];
for (const [label, call] of runners) {
  for (const [how, decl] of [["a join", `const n = ["evil", "js"].join(".");`], ["a decode", `const n = Buffer.from("ZXZpbC5qcw==", "base64").toString();`], ["a +", `const n = "ev" + "il.js";`]] as [string, string][]) {
    test(`${label} with a name built by ${how} holds the changed docs/evil.js`, () => {
      expect(held("lib/x.js", `${RUN}${decl}\n${call}\n`)).toBe(true);
    });
  }
  test(`control, ${label} with a plain literal name still holds the changed docs/evil.js`, () => {
    expect(held("lib/x.js", `${RUN}const n = "evil.js";\n${call}\n`)).toBe(true);
  });
}
test("a runner that names no folded name stays quiet when only docs/evil.js changes", () => {
  expect(held("lib/x.js", `${RUN}const n = ["a", "js"].join(".");\ncp.execSync("node lib/a.js");\nconsole.log(n);\n`)).toBe(false);
});

// A decode inside the argument of a load: the target is not in the text, so every file is possible.

test("a join with a decoded segment, after a literal join of the same file's folder, holds the changed docs/evil.js", () => {
  const body = `const path = require("path");\nrequire(path.join(__dirname, "lib", "a"));\nconst r = require;\nr(path.join(__dirname, atob("Li4vZG9jcy9ldmlsLmpz")));\n`;
  expect(held("scripts/h.js", body)).toBe(true);
});
test("a direct decode in a concatenated or joined require path holds the changed docs/evil.js", () => {
  for (const body of [
    `require("../docs/" + atob("ZXZpbC5qcw=="));\n`,
    `require("../docs/" + Buffer.from("ZXZpbC5qcw==", "base64").toString());\n`,
    `const path = require("path");\nrequire(path.join(__dirname, "../docs", atob("ZXZpbC5qcw==")));\n`,
    "require(`../docs/${atob(\"ZXZpbC5qcw==\")}`);\n",
  ]) expect(held("lib/x.js", body)).toBe(true);
});
test("a plain literal require beside a decode that is not in a path stays quiet when only docs/evil.js changes", () => {
  expect(held("lib/x.js", `require("./a.js");\nconsole.log(atob("aGk="));\n`)).toBe(false);
});

// Shapes that build no path from literals stay quiet when only docs/evil.js changes.
const CP = `const cp = require("child_process");\n`;
const benign: [string, string][] = [
  ["a literal argv array in spawnSync", `${CP}const args = ["rebuild"];\ncp.spawnSync("node-gyp", args, { stdio: "inherit" });\n`],
  ["a literal stdio array", `${CP}const stdio = ["inherit", "inherit", "inherit"];\ncp.spawnSync("node-gyp", ["rebuild"], { stdio });\n`],
  ["a literal argv array in execFile", `${CP}const args = ["a.js"];\ncp.execFile("node", args);\n`],
  ["a literal argv array in fork", `${CP}const args = ["x"];\ncp.fork("./a.js", args);\n`],
  ["a parenthesized literal in a require path", `const n = ("a.js");\nrequire("./" + n);\n`],
  ["a folded name only in an exec option", `${CP}const n = ["a", "b"].join("");\ncp.execSync("echo hi", { cwd: n });\n`],
  ["a folded name only in an exec callback", `${CP}const n = ["a", "b"].join("");\ncp.exec("git rev-parse HEAD", (e, out) => console.log(out.replace(/"/g, ""), n));\n`],
  ["a regex exec and a database exec", `const m = /a"b/.exec("x");\nconst db = { exec() {} };\nconst n = ["a", "b"].join("");\ndb.exec(n);\n`],
  ["+= on a value that is not known", `${CP}let bin = require("os").tmpdir();\nif (process.platform === "win32") bin += ".exe";\ncp.execFileSync(bin);\n`],
  ["an escaped-quote literal", `const q = "\\"";\nrequire("./" + q + "a");\n`],
];
for (const [label, body] of benign) {
  test(`${label} stays quiet when only docs/evil.js changes`, () => {
    expect(held("lib/x.js", body)).toBe(false);
  });
}

// One name with many bindings is read in time that grows with the file. Templates are sized small: the scan that blanks template text
// is itself slow on thousands of them, with or without a fold.
const bindings = (kind: "plain" | "template", size: number) => {
  const q = kind === "plain" ? '"' : "`";
  return Array.from({ length: Math.floor((size * 1_000_000) / 22) }, (_, i) => `n=${q}value_${i}${q};\n`).join("") + `require("./" + n);\n`;
};
test("one name with many plain bindings is read in time that grows with the file, 0.25 to 4 MB", () => {
  const t = [0.25, 1, 4].map((mb) => {
    const body = bindings("plain", mb);
    return median(() => held("lib/x.js", body));
  });
  expect(t[1]! / Math.max(t[0]!, FLOOR_MS)).toBeLessThan(12);
  expect(t[2]! / Math.max(t[1]!, FLOOR_MS)).toBeLessThan(12);
}, 600_000);
test("one name with many template bindings is read in time that grows with the file, 0.02 to 0.05 MB", () => {
  const small = bindings("template", 0.02);
  const big = bindings("template", 0.05);
  expect(median(() => held("lib/x.js", big)) / Math.max(median(() => held("lib/x.js", small)), FLOOR_MS)).toBeLessThan(25);
}, 600_000);
