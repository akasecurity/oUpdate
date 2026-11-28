import { expect, test } from "bun:test";
import { prepass, type FileMap } from "../src/prepass.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const files = (o: Record<string, string>): FileMap => new Map(Object.entries(o).map(([k, v]) => [k, enc(v)]));
const WRITER = `const cp = require("child_process");\nconst args = ["./local.js"];\nargs[0] = decodeURIComponent("docs%2Fchanged.js");\ncp.spawnSync(process.execPath, args);\n`;
const PLAIN = "console.log(1)\n";
const holds = (a: FileMap, b: FileMap): boolean => prepass("npm", a, b).hard.some((s) => s.kind === "install-script");

// A main moved x.js -> y.js between two byte-identical writer files (nothing else changes but the version): the files the hooks reach are the same on both
// sides, so only the file `node .` runs tells the releases apart.
const pair = (scripts: Record<string, string>, body = WRITER) => {
  const mk = (v: string, main: string): FileMap =>
    files({ "package.json": JSON.stringify({ name: "p", version: v, main, scripts }), "x.js": body, "y.js": body, "docs/changed.js": "console.log(2)\n", "local.js": "1\n" });
  return holds(mk("1.0.0", "x.js"), mk("1.0.1", "y.js"));
};
const NAMED = "node x.js && node y.js";
for (const [label, scripts] of [
  ["npx . with no bin runs main: the files are named by the same hook", { postinstall: `${NAMED} && npx .` }],
  ["npx . with no bin in a pipe, the files named by an earlier hook", { preinstall: NAMED, postinstall: "npx . | cat" }],
  ["the self-run is inside an unresolved line: echo $X | cat && node .", { postinstall: "echo $X | cat && node ." }],
  ["the self-run is a stage of an unresolved line: echo $X | node .", { postinstall: "echo $X | node ." }],
  ["an unresolved line beside the self-run in another hook", { preinstall: `echo $X | cat; ${NAMED}`, postinstall: "echo $X | cat && node ." }],
  ["the self-run shares the line that names both files, as a pipe", { postinstall: `${NAMED} && node . | cat` }],
  ["the self-run shares the line that names both files, in a subshell", { postinstall: `${NAMED} && (node .)` }],
  ["the self-run shares the line that names both files, with a redirect", { postinstall: `${NAMED} && node . > out` }],
  ["the self-run shares the line that names both files, with a backslash", { postinstall: `${NAMED} && \\node .` }],
  ["the self-run is spelled with a backslash inside the word: n\\ode .", { postinstall: `${NAMED} && n\\ode .` }],
  ["the self-run is spelled with a backslash on the dot: node \\.", { postinstall: `${NAMED} && node \\.` }],
  ["a backslash self-run inside an unresolved line", { postinstall: "echo $X | cat && n\\ode ." }],
] as [string, Record<string, string>][])
  test(`a main moved between two writer files holds: ${label}`, () => {
    expect(pair(scripts)).toBe(true);
  });
for (const [label, scripts] of [
  ["a preinstall self-run with a postinstall that names both files", { preinstall: "node .", postinstall: NAMED }],
  ["a preinstall self-run with a postinstall that names both files in a pipe", { preinstall: "node .", postinstall: "node x.js | cat && node y.js" }],
] as [string, Record<string, string>][])
  test(`pin: a main moved between two writer files holds (held before this change too): ${label}`, () => {
    expect(pair(scripts)).toBe(true);
  });
test("pin: the same hooks over two plain files release, as the parent releases them", () => {
  expect(pair({ postinstall: "echo $X | cat && node ." }, PLAIN)).toBe(false);
  expect(pair({ preinstall: "node .", postinstall: NAMED }, PLAIN)).toBe(false);
});

// A stop in one replayed line does not end the replay of the next: the first line's `node .` stops on main "/bad", the second names a bin that runs docs/b.js.
test("a replayed line that stops does not hide the next line's bin", () => {
  const mk = (v: string): FileMap =>
    files({
      "package.json": JSON.stringify({ name: "p", version: v, main: "/bad", bin: { p: "docs/b.js" }, scripts: { preinstall: "echo $FOO | cat && node .", postinstall: "echo $FOO | cat && p" } }),
      "docs/b.js": `console.log("${v}")\n`,
    });
  expect(holds(mk("1.0.0"), mk("1.0.1"))).toBe(true);
});

// A writer file reached only by the replay records the files it can change: main is the writer, only deep/other.js changes.
test("a writer file only the replayed line runs holds a changed file of the package", () => {
  const w = `require("fs").writeFileSync(".npmrc", "x");\nrequire("child_process").spawnSync("/bin/ls");\n`;
  const mk = (v: string): FileMap =>
    files({
      "package.json": JSON.stringify({ name: "p", version: v, main: "lib/w.js", scripts: { postinstall: "echo $FOO | cat && node ." } }),
      "lib/w.js": w,
      "deep/other.js": `console.log("${v}")\n`,
    });
  expect(holds(mk("1.0.0"), mk("1.0.1"))).toBe(true);
});

// Bin files are no self-run target of a main: `npx .` runs the bins when the package has any, `node .` runs main. A record of every bin file on both sides
// made the two sides' sets alike and hid a main moved between two writer files that are also bins.
const binPair = (bin: Record<string, string>, scripts: Record<string, string>, body = WRITER) => {
  const mk = (v: string, main: string): FileMap =>
    files({ "package.json": JSON.stringify({ name: "p", version: v, main, bin, scripts }), "x.js": body, "y.js": body, "docs/changed.js": "console.log(2)\n", "local.js": "1\n" });
  return holds(mk("1.0.0", "x.js"), mk("1.0.1", "y.js"));
};
const BINS = { p: "y.js", q: "x.js" };
for (const [label, scripts] of [
  ["node . in one hook, npx . in another", { preinstall: `${NAMED} && node .`, postinstall: "npx ." }],
  ["a preinstall that names both files and an unresolved line with npx .", { preinstall: `${NAMED} && node .`, postinstall: "echo $FOO | cat && npx ." }],
  ["npx . in a pipe", { preinstall: `${NAMED} && node .`, postinstall: "npx . | cat" }],
  ["npx . in a subshell", { preinstall: `${NAMED} && node .`, postinstall: "(npx .)" }],
  ["npx . with a redirect", { preinstall: `${NAMED} && node .`, postinstall: "npx . > out" }],
  ["npx . behind a backslash", { preinstall: `${NAMED} && node .`, postinstall: "\\npx ." }],
  ["npx . behind an unresolved line as a stage", { preinstall: `${NAMED} && node .`, postinstall: "echo $X | npx ." }],
  ["install npx . and postinstall node .", { install: "npx .", postinstall: `${NAMED} && node .` }],
] as [string, Record<string, string>][])
  test(`a main moved between two writer files that are also bins holds: ${label}`, () => {
    expect(binPair(BINS, scripts)).toBe(true);
  });
test("a main moved between two writer files and two bins, hooks named as the review has them", () => {
  const bin = { a: "docs/a.js", b: "docs/b.js" };
  const mk = (v: string, main: string): FileMap =>
    files({
      "package.json": JSON.stringify({ name: "p", version: v, main, bin, scripts: { preinstall: "node docs/a.js && node docs/b.js && node .", postinstall: "echo $FOO | cat && npx ." } }),
      "docs/a.js": WRITER,
      "docs/b.js": WRITER,
      "docs/changed.js": "console.log(2)\n",
      "local.js": "1\n",
    });
  expect(holds(mk("1.0.0", "docs/a.js"), mk("1.0.1", "docs/b.js"))).toBe(true);
});

// A runner word that names no bin of the package reads no self-run target: a main moved between two writer files then releases, as it does without the word.
// (readSelfTargets is asked with a fresh empty list for it by the marker of a command a scanned file runs; the main record is for the package's own target list only.)
test("pin (the public main releases it too; red only when the identity check of readSelfTargets is dropped): a file that runs npx of another package beside the files that name both writers releases", () => {
  const body = WRITER + `cp.execSync("npx other-package");\n`;
  const mk = (v: string, main: string): FileMap =>
    files({ "package.json": JSON.stringify({ name: "p", version: v, main, scripts: { postinstall: NAMED } }), "x.js": body, "y.js": body, "docs/changed.js": "console.log(2)\n", "local.js": "1\n" });
  expect(holds(mk("1.0.0", "x.js"), mk("1.0.1", "y.js"))).toBe(false);
});
