import { expect, test } from "bun:test";
import * as IC from "../src/install-closure.ts";
import { prepass, type FileMap } from "../src/prepass.ts";
import { allowFaults } from "./fault-guard.ts";
import { SHAPES } from "./index-read-timing-probe.ts";

// OUP-282: the key scans of the loader check. dangerousStringUse reads a source and says whether a string in it (or a bracket that
// spells one) names a property that reaches Function or a loader; provablyStatic is the file-level answer.
const key = (src: string) => IC.dangerousStringUse(src) || IC.processHazard(src);
const stat = (src: string) => IC.provablyStatic(src);
const enc = (s: string) => new TextEncoder().encode(s);
const rel = (v: string, hook: string): FileMap =>
  new Map(
    Object.entries({
      "package.json": JSON.stringify({ name: "p", version: v, scripts: { postinstall: "node h.js" } }),
      "h.js": hook,
      "node_modules/x/index.js": `console.log("x ${v}")\n`,
    }).map(([k, t]) => [k, enc(t)]),
  );
const held = (hook: string) => prepass("npm", rel("1.0.0", hook), rel("1.0.1", hook)).hard.some((s) => s.kind === "install-script");

// (a) a string that only holds a bracket and a quote shifts the quote parity of the two regex scans.
test("a bracket and a quote inside strings do not hide a literal key", () => {
  const src = `const a = '["'; const F = (()=>{})["constru"+"ctor"]; const b = '"]'`;
  expect(key(src)).toBe(true);
  expect(stat(src)).toBe(false);
  expect(key(`const a = '["'; const b = '"]'; x[0]`)).toBe(false);
  expect(stat(`const a = '["'; const b = '"]'; const y = x[0]`)).toBe(true);
});
test("a double-quoted opener and a template closer shift nothing either", () => {
  expect(key(`const a = "['"; const F = x["constru"+"ctor"]; const b = "']"`)).toBe(true);
  expect(key("const a = `[\"`; const F = x[\"con\"+\"structor\"]; const b = '\"]'")).toBe(true);
});

// (b) escapes in a name, in a piece and in a ${...} hole.
test("an octal escape in a name is read", () => {
  expect(key(`x["\\143onstructor"]`)).toBe(true);
  expect(key(`x["constru\\143tor"]`)).toBe(true);
  expect(key(`x["\\160rototype"]`)).toBe(true);
  expect(key(`x["\\1430"]`)).toBe(false); // c0, not a name
});
test("an escape or a continuation inside a ${...} hole of a template key is read", () => {
  expect(key("x[`${\"\\143onstructor\"}`]")).toBe(true);
  expect(key("x[`${'\\x63onstructor'}`]")).toBe(true);
  expect(key("x[`${\"constru\\\nctor\"}`]")).toBe(true);
  expect(key("x[`constru${'\\u0063tor'}`]")).toBe(true);
  expect(key("x[`${\"a\\\"b\"}`]")).toBe(false);
  expect(IC.pureLiteralKey("`${\"constru\\\nctor\"}`", true)).toBe("constructor");
  expect(IC.pureLiteralKey("`${'\\143on'}${\"struc\"}tor`", true)).toBe("constructor");
});

// (c) __proto__ and prototype are names that reach a loader too.
test("__proto__ and prototype are dangerous keys", () => {
  for (const k of ["__proto__", "prototype"]) {
    expect(key(`x["${k}"]`)).toBe(true);
    expect(stat(`const P = Foo["${k}"]`)).toBe(false);
    expect(stat(`const o = {}; o["${k}"].y = 1`)).toBe(false);
  }
  // other keys and the plain member are as they were
  expect(key(`x["proto"]`)).toBe(false);
  expect(key(`x["type"]`)).toBe(false);
  expect(stat(`const t = x["type"]; const p = x.prototype`)).toBe(true);
});

// (d) a key built at runtime from pieces of a dangerous name: a piece is the whole name or 5+ characters of it that are not one of
// its words (main, type, create, link, Module, Trace, Stack are ordinary words).
test("a key put together from pieces of a dangerous name is dangerous", () => {
  expect(key(`F[k + "uctor"]`)).toBe(true); // 5 characters
  expect(key(`F[k + "ctor"]`)).toBe(false); // 4 characters
  expect(key(`F["constr" + k]`)).toBe(true);
  expect(key(`F[["constr", "uctor"].join("")]`)).toBe(true);
  expect(key(`F[String.fromCharCode(99) + "onstructor"]`)).toBe(true);
  expect(key(`F[a["b" + "protot"]]`)).toBe(true);
  expect(key(`F[a ? "prototype" : "b"]`)).toBe(true); // a whole name is a piece
  expect(key(`"a"["constr" + k]`)).toBe(true); // the receiver is a string
  expect(key("`a`[k + 'uctor']")).toBe(true); // or a template
  expect(key("x[`${k}uctor`]")).toBe(true); // a template with a substitution: its text is a piece
  expect(key("x[`constr${k}`]")).toBe(true);
  expect(key("x[`${k}ctor`]")).toBe(false);
  expect(key(`a[0][k + "uctor"]`)).toBe(true); // after ]
  expect(key(`F [k + "uctor"]`)).toBe(true); // after a space
  expect(key(`"a" [k + "uctor"]`)).toBe(true); // after a string and a space
  expect(key(`x?.[k + "uctor"]`)).toBe(true); // an optional index
  expect(stat(`const k = "constr"; const F = (()=>{})[k + "uctor"]`)).toBe(false);
  // ordinary words inside a dangerous name are not pieces
  for (const w of ["main", "type", "create", "link", "Module", "Trace", "Stack", "proto", "builtin", "require", "function"]) {
    expect(key(`p[argv ? "browser" : "${w}"]`)).toBe(false);
    expect(key(`el[x + "${w}"]`)).toBe(false);
  }
  // controls: an index with no such piece, an array literal and a call argument are not keys
  expect(key(`a[i]; a[i + 1]; a["x" + i]; a[i]["type"]`)).toBe(false);
  expect(key(`const l = ["type", "stru", "proto"]; f(["type" + 1])`)).toBe(false);
  expect(key(`a[b.length - 1]; a["con" + i]`)).toBe(false);
  expect(key(`x[("uctor")]`)).toBe(false); // a pure literal that is not a name, with a parenthesis
  expect(key(`x["uctor"]`)).toBe(false);
  expect(stat(`const n = items[i + "_label"]; const l = ["type", "name"]`)).toBe(true);
});
test("__proto__ and prototype are names as the key of an index only", () => {
  expect(key(`Object.defineProperty(F, "prototype", { writable: false })`)).toBe(false);
  expect(key(`names.indexOf("prototype") + names.indexOf("__proto__")`)).toBe(false);
  expect(key(`hasOwnProperty.call(o, "prototype")`)).toBe(false);
  expect(key(`x["prototype"]; y["__proto__"]`)).toBe(true);
});
test("every name main had is still one: _linkedBinding too", () => {
  for (const n of ["constructor", "getBuiltinModule", "mainModule", "linkedBinding", "_linkedBinding", "createRequire", "prepareStackTrace", "getThis", "getFunction"]) {
    expect(key(`p.f("${n}")`)).toBe(true);
    expect(key(`x["${n}"]`)).toBe(true);
  }
});

// (f) a NUL in a load.
test("a NUL in the name of a load widens the release like any unresolved load", () => {
  expect(held(`require("x")`)).toBe(true);
  expect(held(`require("x\u0000")`)).toBe(true);
  expect(held(`require("x\\u0000")`)).toBe(true);
  expect(held(`require("x\\x00")`)).toBe(true);
  expect(held(`const fs = require("fs"); fs.readFileSync("a")`)).toBe(false);
  // stripLiteralLoad alone: a builtin that stays in the text, with a NUL after it
  expect(stat(`require("child_process\\x00")`)).toBe(false);
  expect(stat(`require("child_process\u0000")`)).toBe(false);
  expect(stat(`require("fs\\u0000")`)).toBe(true);
});

// A NUL is read after decoding in a load only: a command string with an escape and a NUL is read as it was, and a detail main gives at
// a scan limit is still given.
const hookPkg = (v: string, hook: string, extra: Record<string, string>): FileMap =>
  new Map(
    Object.entries({
      "package.json": JSON.stringify({ name: "p", version: v, scripts: { postinstall: "node lib/x.js" } }),
      "lib/x.js": hook,
      ...extra,
    }).map(([k, t]) => [k, enc(t)]),
  );
const hard = (hook: string, extra: (v: string) => Record<string, string>, limit?: number) => {
  IC.setJsScanSteps(limit);
  try {
    return prepass("npm", hookPkg("1.0.0", hook, extra("1.0.0")), hookPkg("1.0.1", hook, extra("1.0.1"))).hard.map((h) => `${h.kind}:${h.detail}`);
  } finally {
    IC.setJsScanSteps(undefined);
  }
};
test("a command string with an escape and a NUL still reads its file", () => {
  const hook = 'const cp = require("child_process");\ncp.execSync("node d\\x65ep/other.js \\x00");\n';
  expect(hard(hook, (v) => ({ "deep/other.js": `//${v}` }))).toContain("install-script:file deep/other.js");
  const sh = 'const cp = require("child_process");\ncp.spawnSync("sh", ["-c", "node d\\x65ep/other.js \\x00"]);\n';
  expect(hard(sh, (v) => ({ "deep/other.js": `//${v}` }))).toContain("install-script:file deep/other.js");
});
test("a load with a NUL at a scan limit still gives the scanner fault", () => {
  allowFaults();
  expect(hard('require("x\\x00")', (v) => ({ "README.md": v }), 30)).toContain("install-script:scanner fault");
  expect(hard('require("x\\u0000")', (v) => ({ "README.md": v }), 30)).toContain("install-script:scanner fault");
});

// An index after a keyword is an array literal, and an optional chain is an index.
test("a keyword before a bracket makes an array literal; ?. makes an index", () => {
  expect(stat(`for (const f of ["main", "module", "type"]) log(f);`)).toBe(true);
  expect(stat(`function f(k) { return [k, "proto"]; }`)).toBe(true);
  expect(stat(`function f(k) { return [k + "type"]; }`)).toBe(true);
  expect(key(`x?.[k + "uctor"]`)).toBe(true);
  expect(key(`x?.["constr" + "uctor"]`)).toBe(true);
  expect(key(`a[0][k + "uctor"]`)).toBe(true);
  expect(key(`F [k + "uctor"]`)).toBe(true);
  expect(key(`"a" [k + "uctor"]`)).toBe(true);
});

// The new reads are record-only: each runs after the scan it adds to, charges nothing and takes no early out, so the first scan limit a
// text passes under (and the detail at a limit below it) is main's. Measured on main (460c71c9), provablyStatic / processHazard / classifyJs.
const firstCleanLimit = (f: (s: string) => unknown, src: string) => {
  const clean = (n: number) => {
    IC.setJsScanSteps(n);
    const before = IC.scannerFaultCount();
    f(src);
    IC.setJsScanSteps(undefined);
    return IC.scannerFaultCount() === before;
  };
  let lo = 1;
  let hi = 1 << 22;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (clean(mid)) hi = mid;
    else lo = mid + 1;
  }
  return lo;
};
const CUTS: [string, string, number, number, number][] = [
  ['x["prototype"]', 'x["prototype"]', 99, 66, 256],
  ["a hex escape in a template hole", 'x[`constr${"\\x75ctor"}`]', 172, 108, 438],
  ["an octal escape in a template hole", 'x[`constr${"\\165ctor"}`]', 172, 108, 438],
  ["a line continuation in a template hole", 'x[`constr${"u\\\nctor"}`]', 168, 105, 425],
  ['require("x\\x00")', 'require("x\\x00")', 93, 76, 319],
  ['require("node:fs\\x00")', 'require("node:fs\\x00")', 120, 94, 427],
  ['require("node:fs\\u0000")', 'require("node:fs\\u0000")', 128, 100, 463],
  ['if (k) ["protot" + k]', 'if (k) ["protot" + k]', 221, 141, 506],
  ['x[foo("protot")]', 'x[foo("protot")]', 143, 90, 344],
  ['["prototype"]', '["prototype"]', 84, 57, 227],
  ['a["b"+c]; x 2,000', 'a["b"+c];'.repeat(2000), 222_000, 138_000, 485_128],
];
for (const [name, src, st, hz, cl] of CUTS) {
  test(`first clean scan limit of ${name} is main's`, () => {
    allowFaults();
    expect(firstCleanLimit(IC.provablyStatic, src)).toBe(st);
    expect(firstCleanLimit(IC.processHazard, src)).toBe(hz);
    expect(firstCleanLimit((s) => IC.classifyJs("lib/x.js", s), src)).toBe(cl);
  });
}
test("a builtin with a NUL stays as main reads it, and a changed file it hides is still held", () => {
  allowFaults();
  const hookOf = (l: string) => `${l};\nrequire("./deep/other.js");`;
  for (const l of ['require("node:fs\\x00")', 'require("node:fs\\u0000")', 'require("node:path\\x00x")', 'require("child_process\\x00")']) {
    expect(stat(l)).toBe(false); // as main (the NUL name is not an allowlisted builtin)
    expect(hard(hookOf(l), (v) => ({ "deep/other.js": `//${v}`, "lib/y.js": `//${v}` }))).toContain("install-script:file deep/other.js");
  }
});
// A package with its own scripts and main; the files change (the version is in each) between the releases.
const pkgHard = (script: string, main: string, files: Record<string, string>, changing: string[], limit?: number) => {
  const mk = (v: string): FileMap =>
    new Map(
      Object.entries({ "package.json": JSON.stringify({ name: "p", version: v, main, scripts: { postinstall: script } }), ...files, ...Object.fromEntries(changing.map((k) => [k, `//${v}${k}`])) }).map(([k, t]) => [k, enc(t)]),
    );
  IC.setJsScanSteps(limit);
  try {
    return prepass("npm", mk("1.0.0"), mk("1.0.1")).hard.map((h) => `${h.kind}:${h.detail}`);
  } finally {
    IC.setJsScanSteps(undefined);
  }
};
// A write-and-spawn file that also holds a built key keeps the files main's record gives (the index read only adds the whole-package tier).
test("a built key beside a write-and-spawn file keeps main's file detail", () => {
  const body = 'const fs = require("fs");\nconst cp = require("child_process");\nfs.writeFileSync(".npmrc", "x");\ncp.execSync("/bin/ls");\nconst r = require.resolve(x);\n';
  for (const key of ['x[k+"uctor"];', 'o["__proto__"].a = 1;', ""]) {
    const got = pkgHard("node . | cat && node a?b", "lib/x.js", { "lib/x.js": body + key, "deep/other.js": "" }, ["deep/other.js"]);
    expect(got).toContain("install-script:file deep/other.js");
    expect(got).toContain("install-script:glob");
  }
});
// Stated replacements: where the new hold fires first, the detail differs from main's but the package is HELD (the rows assert held, not
// the text): a new reach drops the cap (main glob, here file README.md); a NUL name followed into a changed file at a scan limit (main
// scanner fault, here file lib/y.js); a builtin with a NUL left in the text so the widening scan runs and faults (main file deep/other.js).
test("the shapes where a new hold replaces a detail are held", () => {
  allowFaults();
  // main [glob] at each of these: the default limit and 298..450 give [file README.md], 127..297 give [scanner fault]
  const globKey = (limit?: number) => pkgHard("node h.js && node a?b", "h.js", { "h.js": 'x[k+"uctor"];', "README.md": "" }, ["README.md"], limit);
  expect(globKey()).toEqual(["install-script:file README.md"]);
  expect(globKey(300)).toEqual(["install-script:file README.md"]);
  expect(globKey(200)).toEqual(["install-script:scanner fault"]);
  expect(pkgHard("node h.js", "h.js", { "h.js": 'require("./lib/y.js\\x00");', "lib/y.js": "" }, ["lib/y.js"], 80).length).toBeGreaterThan(0);
  expect(pkgHard("node . | cat", "h.js", { "h.js": 'require("child_process\\x00");\nrequire("./deep/other.js");', "deep/other.js": "" }, ["deep/other.js"], 500).length).toBeGreaterThan(0);
  expect(pkgHard("node . | cat", "h.js", { "h.js": 'require("child_process\\x00");\nrequire("./deep/other.js");', "deep/other.js": "" }, ["deep/other.js"]).length).toBeGreaterThan(0);
});
// The index read puts a hook's text on the whole-package tier (classifyJs): a changed file the hook never loads is held. Main held none.
test("a built key in a hook holds the whole package", () => {
  for (const hook of ['x[k+"uctor"];', 'x["prototype"];', 'o["__proto__"].a = 1;', 'const a = \'["\'; x["constru"+"ctor"]; const b = \'"]\';']) {
    expect(pkgHard("node h.js", "h.js", { "h.js": hook, "README.md": "" }, ["README.md"])).toEqual(["install-script:file README.md"]);
  }
  expect(pkgHard("node h.js", "h.js", { "h.js": 'x[i];', "README.md": "" }, ["README.md"])).toEqual([]);
});
// The mechanisms by which a new hold gives another detail than main's (each row is held, in the window measured on a 4% grid of limits;
// ws is the write-and-spawn body of the test above, "base" is main 7a6b92a3).
const WS = 'const fs = require("fs");\nconst cp = require("child_process");\nfs.writeFileSync(".npmrc", "x");\ncp.execSync("/bin/ls");\nconst r = require.resolve(x);\n';
const EXEC = 'const cp = require("child_process");\ncp.execSync("/bin/ls");\n';
test("a new hold that makes a charged widening scan fault where main held for the glob", () => {
  allowFaults(); // base [glob] at 129-348, head [scanner fault]
  expect(pkgHard("node h.js && node a?b", "h.js", { "h.js": 'x[k+"uctor"];' }, [], 200)).toEqual(["install-script:scanner fault"]);
});
test("a new hold that fires first hides main's later scanner fault", () => {
  allowFaults(); // base [scanner fault] at 2097-2359 (exec body) and 4609-5185 (ws body), head [file README.md]
  expect(pkgHard("node h.js", "h.js", { "h.js": 'require("./lib/sub.js");', "lib/sub.js": EXEC + 'x[k+"uctor"];' }, ["README.md"], 2200)).toEqual(["install-script:file README.md"]);
  expect(pkgHard("node h.js", "h.js", { "h.js": 'require("./lib/sub.js");', "lib/sub.js": WS + 'x[k+"uctor"];' }, ["README.md"], 4800)).toEqual(["install-script:file README.md"]);
});
test("a NUL name followed into a changed file is held where main faulted", () => {
  allowFaults(); // base [scanner fault] at 28-108 (node_modules/x) and 58-565 (relative, with eval), head [file ...]
  expect(pkgHard("node h.js", "h.js", { "h.js": 'require("x\\x00");', "node_modules/x/index.js": "" }, ["node_modules/x/index.js"], 60)).toEqual(["install-script:file node_modules/x/index.js"]);
  expect(pkgHard("node h.js", "h.js", { "h.js": 'eval(x);\nrequire("./lib/y.js\\x00");', "lib/y.js": "" }, ["lib/y.js"], 200)).toEqual(["install-script:file lib/y.js"]);
});
test("a new reach that holds for the file main also gave drops main's glob", () => {
  // base [glob, file lib/y.js], head [file lib/y.js] (unset, and the limits from 4260 up)
  for (const hook of [WS + 'x[k+"uctor"];', WS + 'require("./lib/y.js\\x00");']) {
    expect(pkgHard("node h.js && node a?b", "h.js", { "h.js": hook, "lib/y.js": "" }, ["lib/y.js"])).toEqual(["install-script:file lib/y.js"]);
  }
});
test('import "child_process\\x00" reads a limit lower than main (provablyStatic 120 -> 64) and is still held', () => {
  allowFaults();
  expect(firstCleanLimit(IC.provablyStatic, 'import "child_process\\x00"')).toBe(64);
  expect(firstCleanLimit(IC.processHazard, 'import "child_process\\x00"')).toBe(96);
  expect(pkgHard("node h.js | cat", "h.js", { "h.js": 'import "child_process\\x00";\nrequire("./deep/other.js");', "deep/other.js": "" }, ["deep/other.js"])).toContain("install-script:file deep/other.js");
});
// A NUL name queued once per distinct name: N loads of one name add one lookup, not N (head 1.05x the same loads without the NUL, 1.8x with
// the queue kept per load).
test("repeated loads of one NUL name add one lookup, not one each", () => {
  const files: Record<string, string> = {};
  for (let i = 0; i < 3000; i++) files[`d${i % 50}/f${i}.txt`] = "a";
  const time = (name: string) => {
    const hook = `require("${name}");\n`.repeat(4000);
    let best = Infinity;
    for (let r = 0; r < 3; r++) {
      const mk = (v: string): FileMap => new Map(Object.entries({ "package.json": JSON.stringify({ name: "p", version: v, scripts: { postinstall: "node h.js" } }), "h.js": hook, ...Object.fromEntries(Object.entries(files).map(([k, s]) => [k, s + v])) }).map(([k, s]) => [k, enc(s)]));
      const a = mk("1.0.0");
      const b = mk("1.0.1");
      const t0 = performance.now();
      prepass("npm", a, b);
      best = Math.min(best, performance.now() - t0);
    }
    return best;
  };
  const plain = time("missing");
  const nul = time("missing\\x00");
  expect(nul / plain).toBeLessThan(1.4);
});
// A .jsx file is followed through a NUL name like a .js one.
test("a NUL name followed into a changed .jsx file is held where main faulted", () => {
  allowFaults();
  expect(pkgHard("node h.js", "h.js", { "h.js": 'require("./lib/y.jsx\\x00");', "lib/y.jsx": "" }, ["lib/y.jsx"], 80)).toEqual(["install-script:file lib/y.jsx"]);
});
// Mechanism 1 with a pipe: a key and a relative load, base [file lib/y.js], head [scanner fault] at about 297-950.
test("a new hold with a relative load in a piped package faults where main held the file", () => {
  allowFaults();
  expect(pkgHard("node . | cat", "h.js", { "h.js": 'x[k+"uctor"];\nrequire("./lib/y.js");', "lib/y.js": "" }, ["lib/y.js"], 500)).toEqual(["install-script:scanner fault"]);
});
// The cut-point exception of the NUL strip: a builtin up to a NUL stays in the text, so provablyStatic reads 78 where main read 141 (the
// import form 64, main 120). At every limit from 1 to 140 the answer is not static (a fault or a hold), never clean-and-static.
test('require("child_process\\x00") has first clean provablyStatic limit 78 and is never static below 141', () => {
  allowFaults();
  const src = 'require("child_process\\x00");';
  expect(firstCleanLimit(IC.provablyStatic, src)).toBe(78);
  for (let limit = 1; limit <= 140; limit++) {
    IC.setJsScanSteps(limit);
    try {
      expect(IC.provablyStatic(src)).toBe(false);
    } finally {
      IC.setJsScanSteps(undefined);
    }
  }
});
// The lexer's slash look-ahead is quadratic on 'f() / [' repeated; the index read reruns it with no limit, but only after the scan that charged
// it has finished, so what it costs is under the gate's budget (200 steps per character and 5,000,000), and beyond that main's scan has
// faulted and the result is a hold before the index read runs.
test("a text whose slash look-ahead is over the budget is held by every entry", () => {
  allowFaults();
  const src = "f() / [".repeat(800) + "0" + "]".repeat(800);
  expect(IC.provablyStatic(src)).toBe(false);
  expect(IC.processHazard(src)).toBe(true);
  expect(IC.classifyJs("lib/x.js", src).all).toBe(true);
});
// A hole is a substitution only in a template: in a quoted string it is text, so the key is not prototype.
test("a hole-looking text in a quoted string is not a hole", () => {
  expect(key("x['pro${\"to\"}type']")).toBe(false);
  expect(key('x["pro${\'to\'}type"]')).toBe(false);
  expect(pkgHard("node h.js", "h.js", { "h.js": "x['pro${\"to\"}type'];", "README.md": "" }, ["README.md"])).toEqual([]);
});
// A template made of holes only, one of them escaped, reads through the wide decoder in the index read.
test("a template of holes with an escape is a dangerous key", () => {
  expect(IC.processHazard("x[`${\"pro\"}${\"\\x74o\"}${\"type\"}`]")).toBe(true);
});
// Priced false holds: ordinary code the index read holds (a piece 5 or more characters of a name, a statement that ends at a newline).
test("the priced false holds stay held", () => {
  for (const src of ['o[k + "struct"]', 'o[k + "nding"]', 'x[pre + "_proto"]', 'x[k + "getThi"]', 'x[(a, "protot")]', 'x[{a: "protot"}.a]', 'while (1) { break\n["prototype"]; }']) expect(key(src)).toBe(true);
});
test("a load with a NUL gives the scanner fault at every limit main does", () => {
  allowFaults();
  for (const name of ['require("x\\x00")', 'require("x\\u0000")', 'require("node:fs\\x00")', 'require("node:fs\\u0000")']) {
    // 400 is under the first clean classifyJs limit of the node:fs names (427, 463) and over the x names' (319)
    for (const limit of name.includes("node:fs") ? [30, 90, 400] : [30, 90]) {
      // main gives the fault at 30 and 90 for each of the four names; a fixed limit, not the cut point head computes
      expect(hard(name, (v) => ({ "README.md": v }), limit)).toContain("install-script:scanner fault");
    }
  }
});

// After a statement keyword a bracket opens an array literal, not an index; after any other word it is an index.
test("a bracket after each statement keyword is an array literal", () => {
  for (const kw of ["await", "yield", "return", "export", "default", "case", "throw", "typeof", "void", "new", "delete", "in", "of", "else", "do", "instanceof", "extends"]) {
    expect(key(`${kw} ["constr" + k]`)).toBe(false);
    expect(key(`${kw}["constr" + k]`)).toBe(false);
    expect(key(`x = 1; ${kw}  ["uctor" + k]`)).toBe(false);
    expect(key(`${kw}x ["constr" + k]`)).toBe(true); // a longer word is a name
    expect(key(`a${kw} ["constr" + k]`)).toBe(true);
  }
  expect(key("`a${b}c`[\"constr\" + k]")).toBe(true); // a template with a substitution is a receiver
});

// A standalone array, a control-flow head and a call argument are not an index key.
test("an array, an if (...) head and a string in a call are not an index", () => {
  for (const src of [`["prototype"]`, `function f() { return ["prototype"]; }`, `if (k) ["protot" + k]`, `while (k) ["protot" + k]`, `for (;;) ["protot" + k]`, `x[foo("protot")]`, `x[a.b("constr", "uctor")]`]) {
    expect(key(src)).toBe(false);
    expect(stat(src)).toBe(true);
  }
  expect(key(`x[(k + "uctor")]`)).toBe(true); // a grouping paren is not a call
  expect(key(`f(k)["constr" + k]`)).toBe(true); // a ) that closes a call is a receiver
  expect(key(`F[a["b" + "protot"]]`)).toBe(true);
});

// Never throws, and every new read is linear: absolute bounds, no floor.
const lcg = (seed: number) => () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
test("random text of brackets, quotes and escapes never throws", () => {
  const next = lcg(282);
  const alphabet = ["[", "]", '"', "'", "`", "${", "}", "\\", "\n", "+", "constr", "uctor", "x", "(", ")", " ", "$", "\\x6", "\\14", ".join("];
  for (let n = 0; n < 400; n++) {
    let s = "";
    for (let k = 0; k < 60; k++) s += alphabet[Math.floor(next() * alphabet.length)];
    expect(() => key(s)).not.toThrow();
    expect(() => stat(s)).not.toThrow();
    expect(() => IC.classifyJs("h.js", s)).not.toThrow();
  }
});
// No bound here is a number of milliseconds a runner must meet, and the timing is taken in a fresh bun process (one per shape,
// test/index-read-timing-probe.ts), not in the process of the whole run, whose heap and collections the timing would otherwise include. A sized
// shape is timed at 262,144 and 524,288 characters in the one process and the larger may take at most 3 times the smaller (a linear read gives
// about 2; a quadratic one gives 4) with a floor of 60 ms for the smaller. Both sizes are past a step: a shape such as a run of ${word} holes takes
// 3.8, 7.2, 178.9 and 358 ms at 65,536, 131,072, 262,144 and 524,288 characters on the CI runner (main's own function: 2.7, 4.4, 130.6, 260.0),
// then exactly 2 times per doubling, so a ratio from 65,536 could not be a bound for it; past the step the read is linear. The 65,536 point is
// not timed. A fixed 60,000-bracket shape may take at most 8 times a plain text of the same length and a fixed 60,000-bracket shape may take at most 8 times a plain text of the same length
// ('a[0];' repeated) timed in the same process (measured at most 1.4). The 10 s ceiling is only a sanity cap.
const CEILING = 10_000;
// CI runs bun test with its default 5 s per-test timeout, and a probe runs 3 timings of key and stat at four sizes. On the CI runner (x64, about
// 3.5 times the time of a dev arm64 machine: processHazard of 524,288 characters of $word takes 1,958 ms there against about 470) one shape
// takes about 12 s and the two template runs, with the 5 MB point (one run, linear: about 10 times 524,288, so about 40 s), about 60 s. So every
// probe test has an explicit timeout above that, and the 5 MB point has a ceiling of its own.
const PROBE_TIMEOUT = 120_000;
const BIG_TIMEOUT = 300_000;
const MB5_CEILING = 90_000;
type Pair = { key: number; stat: number };
const probe = (name: string): Record<string, Pair> => {
  const r = Bun.spawnSync([process.execPath, "test/index-read-timing-probe.ts", name], { cwd: new URL("..", import.meta.url).pathname });
  if (r.exitCode !== 0) throw new Error(`probe ${name}: ${r.stderr.toString()}`);
  return JSON.parse(r.stdout.toString());
};
for (const [name] of SHAPES) {
  if (name.startsWith("60,000")) {
    test(`${name} takes at most 8 times a plain text of the same length`, () => {
      const { src, plain } = probe(name);
      for (const what of ["key", "stat"] as const) {
        expect(`${what} ${src![what] <= Math.max(8 * plain![what], 60) && src![what] < CEILING}`).toBe(`${what} true`);
      }
    }, PROBE_TIMEOUT);
  } else {
    test(`${name} at 524,288 takes at most 3 times 262,144`, () => {
      const { small, large, mb5 } = probe(name);
      for (const what of ["key", "stat"] as const) {
        expect(`${what} ${large![what] <= Math.max(3 * small![what], 60) && large![what] < CEILING}`).toBe(`${what} true`);
      }
      // 5 MB (one run) takes at most 14 times 524,288 (linear is about 10), under its own ceiling
      if (mb5) {
        console.log(`timing 5 MB ${name} key=${mb5.key.toFixed(0)} stat=${mb5.stat.toFixed(0)} at 524,288 key=${large.key.toFixed(0)} stat=${large.stat.toFixed(0)}`);
        for (const what of ["key", "stat"] as const) {
          expect(`${what} ${mb5[what] <= 14 * large![what] && mb5[what] < MB5_CEILING}`).toBe(`${what} true`);
        }
      }
    }, name.startsWith("a run of $") && !name.includes("holes") ? BIG_TIMEOUT : PROBE_TIMEOUT);
  }
}
