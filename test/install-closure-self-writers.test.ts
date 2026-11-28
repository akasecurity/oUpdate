import { expect, test } from "bun:test";
import { prepass, type FileMap } from "../src/prepass.ts";
import { allowFaults } from "./fault-guard.ts";
import { classifyJs, scannerFaultCount, setJsScanSteps } from "../src/install-closure.ts";

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
  ["a preinstall self-run with a postinstall that names both files", { preinstall: "node .", postinstall: NAMED }],
  ["a preinstall self-run with a postinstall that names both files in a pipe", { preinstall: "node .", postinstall: "node x.js | cat && node y.js" }],
] as [string, Record<string, string>][])
  test(`a main moved between two writer files holds: ${label}`, () => {
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

// The receiver scan does not charge the scan steps twice: a constant spawn beside Object.assign({}, ...) passes under the limit it passed under before the
// receiver scan existed (200,467 steps; the sibling with `assigx` is cheaper for another reason: the scans that read Object.assign by name).
const passLimit = (src: string): number => {
  let lo = 0;
  let hi = 1 << 26;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    setJsScanSteps(mid);
    const before = scannerFaultCount();
    classifyJs("lib/x.js", src);
    if (scannerFaultCount() === before) hi = mid;
    else lo = mid + 1;
  }
  setJsScanSteps(undefined);
  return lo;
};
test("Object.assign into an empty object beside a constant spawn needs no more scan steps than before the receiver scan", () => {
  allowFaults();
  const file = `const cp = require("child_process");\nconst o = Object.assign({}, { a: 1 });\ncp.spawnSync(process.execPath, ["./a.js"]);\n` + 'require("./a.js", '.repeat(80) + '"x"' + ")".repeat(80) + ";\n";
  expect(passLimit(file)).toBeLessThanOrEqual(200467);
});
