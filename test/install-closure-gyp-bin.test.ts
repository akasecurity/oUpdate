import { expect, test } from "bun:test";
import { prepass, type FileMap } from "../src/prepass.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const files = (o: Record<string, string>): FileMap => new Map(Object.entries(o).map(([k, v]) => [k, enc(v)]));
const WRITER = `const cp = require("child_process");\nconst args = ["./local.js"];\nargs[0] = decodeURIComponent("docs%2Fchanged.js");\ncp.spawnSync(process.execPath, args);\n`;
const holds = (a: FileMap, b: FileMap): boolean => prepass("npm", a, b).hard.some((s) => s.kind === "install-script");
const gyp = (acts: string[][]) =>
  JSON.stringify({ targets: [{ target_name: "t", actions: acts.map((a, i) => ({ action_name: `a${i}`, action: a, inputs: [], outputs: [`o${i}`] })) }] });

// A package with no install hook runs only its binding.gyp (the implicit node-gyp build). The bin stamp is compared for it too (whenever the install runs anything),
// so a bin retargeted between two byte-identical writer files is held by the stamp. Both sides name bin "p" and x.js, y.js are the same file.
const binMove = (pkg: (side: 0 | 1) => Record<string, unknown>, acts: string[][]) => {
  const mk = (v: string, side: 0 | 1): FileMap =>
    files({ "package.json": JSON.stringify({ name: "p", version: v, ...pkg(side) }), "x.js": WRITER, "y.js": WRITER, "docs/changed.js": "console.log(2)\n", "local.js": "1\n", "binding.gyp": gyp(acts) });
  return holds(mk("1.0.0", 0), mk("1.0.1", 1));
};
const bin = (side: 0 | 1) => ({ bin: { p: side ? "y.js" : "x.js" } });
const BOTH = [["node", "x.js"], ["node", "y.js"]];
for (const [label, run] of [
  ["npx .", ["npx", "."]],
  ["npm exec .", ["npm", "exec", "."]],
  ["npm exec -- p", ["npm", "exec", "--", "p"]],
  ["npx p", ["npx", "p"]],
] as [string, string[]][])
  for (const [kind, pkg] of [
    ["no scripts", bin],
    ["gypfile: true", (s: 0 | 1) => ({ gypfile: true, ...bin(s) })],
    ["a test script only", (s: 0 | 1) => ({ scripts: { test: "echo hi" }, ...bin(s) })],
  ] as [string, (s: 0 | 1) => Record<string, unknown>][])
    test(`a bin moved between two writer files holds when only the gyp build self-runs it (${kind}): ${label}`, () => {
      expect(binMove(pkg, [...BOTH, run])).toBe(true);
    });
test("a bin as a string moved between two writer files holds in the implicit gyp build", () => {
  expect(binMove((s) => ({ bin: s ? "y.js" : "x.js" }), [...BOTH, ["npx", "."]])).toBe(true);
});
test("control: the files named by the gyp build alone release when no bin moves", () => {
  expect(binMove(() => ({}), BOTH)).toBe(false);
  expect(binMove(() => bin(0), BOTH)).toBe(false);
});
test("a bin moved between two writer files still holds with an install hook (the bin stamp)", () => {
  expect(binMove((s) => ({ scripts: { install: "node-gyp rebuild" }, ...bin(s) }), [...BOTH, ["npx", "."]])).toBe(true);
});

// The same through the gyp forms that run a command without an action list: a `<!(...)` in a source list (OUP-373 review round 2).
test("a bin moved between two writer files holds when the gyp build runs them through <!( in sources", () => {
  const mk = (v: string, side: 0 | 1): FileMap =>
    files({
      "package.json": JSON.stringify({ name: "p", version: v, ...bin(side) }),
      "x.js": WRITER,
      "y.js": WRITER,
      "docs/changed.js": "console.log(2)\n",
      "local.js": "1\n",
      "binding.gyp": JSON.stringify({ targets: [{ target_name: "a", sources: ["<!(node x.js)", "<!(node y.js)", "<!(npx .)"] }] }),
    });
  expect(holds(mk("1.0.0", 0), mk("1.0.1", 1))).toBe(true);
});
// A bin retargeted between two plain files is held by the bin stamp whenever the install runs anything, the implicit gyp build included.
test("a bin moved between two plain files holds in a package whose only install step is the implicit gyp build", () => {
  const mk = (v: string, side: 0 | 1): FileMap =>
    files({ "package.json": JSON.stringify({ name: "p", version: v, ...bin(side) }), "x.js": "console.log(1)\n", "y.js": "console.log(1)\n", "binding.gyp": gyp([["node", "-e", "1"]]) });
  expect(holds(mk("1.0.0", 0), mk("1.0.1", 1))).toBe(true);
});
test("control: a bin moved between two plain files in a package that runs nothing at install releases", () => {
  const mk = (v: string, side: 0 | 1): FileMap =>
    files({ "package.json": JSON.stringify({ name: "p", version: v, scripts: { test: "echo hi" }, ...bin(side) }), "x.js": "console.log(1)\n", "y.js": "console.log(1)\n" });
  expect(holds(mk("1.0.0", 0), mk("1.0.1", 1))).toBe(false);
});

// A binding.gyp at any depth is an implicit build for the reader, so the bin stamp is compared for it too (not only for a root one).
const nested = (gypPath: string, form: "actions" | "sources" | "runner", run: string[], pkg: (side: 0 | 1) => Record<string, unknown>, scripts?: Record<string, string>) => {
  const gypText = form === "sources" ? JSON.stringify({ targets: [{ target_name: "a", sources: [...BOTH, run].map((a) => `<!(${a.join(" ")})`) }] }) : gyp([...BOTH, form === "runner" ? ["node", "runner.js"] : run]);
  const mk = (v: string, side: 0 | 1): FileMap =>
    files({
      "package.json": JSON.stringify({ name: "p", version: v, ...(scripts ? { scripts } : {}), ...pkg(side) }),
      "x.js": WRITER,
      "y.js": WRITER,
      "docs/changed.js": "console.log(2)\n",
      "local.js": "1\n",
      [gypPath]: gypText,
      ...(form === "runner" ? { "runner.js": `require("child_process").execSync(${JSON.stringify(run.join(" "))});\n` } : {}),
    });
  return holds(mk("1.0.0", 0), mk("1.0.1", 1));
};
for (const [gypPath, form] of [["deps/binding.gyp", "actions"], ["src/binding.gyp", "sources"], ["a/b/c/binding.gyp", "actions"], ["deps/binding.gyp", "runner"]] as const)
  for (const run of [["npx", "."], ["npm", "exec", "."], ["npm", "exec", "--", "p"], ["npx", "p"]])
    test(`a bin moved between two writer files holds with the gyp file at ${gypPath} (${form}): ${run.join(" ")}`, () => {
      expect(nested(gypPath, form, run, bin)).toBe(true);
    });
for (const [label, pkg] of [
  ["as a string", (s: 0 | 1) => ({ bin: s ? "y.js" : "x.js" })],
  ["removed", (s: 0 | 1) => (s ? {} : { bin: { p: "x.js" } })],
  ["added", (s: 0 | 1) => (s ? { bin: { p: "y.js" } } : {})],
] as [string, (s: 0 | 1) => Record<string, unknown>][])
  test(`a bin ${label} between two writer files holds with a nested gyp file and no install hook`, () => {
    expect(nested("deps/binding.gyp", "actions", ["npx", "."], pkg, { prepack: "echo hi" })).toBe(true);
  });
test("control: a nested gyp file that no install builds (gypfile: false) with a bin move releases, as the public main does", () => {
  const mk = (v: string, side: 0 | 1): FileMap =>
    files({ "package.json": JSON.stringify({ name: "p", version: v, gypfile: false, ...bin(side) }), "x.js": "console.log(1)\n", "y.js": "console.log(1)\n", "deps/binding.gyp": gyp([["node", "-e", "1"]]) });
  // gypfile: false, no hook: nothing runs at install, so a bin move alone is no hold (the public main releases it too).
  expect(holds(mk("1.0.0", 0), mk("1.0.1", 1))).toBe(false);
});

// A self-run by the package's own name (`npx p`, `npm exec -- p@1`, `npx @s/p`) runs the package whose name it is: a rename between two byte-identical writer
// files, with the bin text unchanged, switches the self-run on or off, so the name is part of what the stamp compares.
const rename = (n1: string, n2: string, run: string[], where: "postinstall" | "gyp" | "deps-gyp" | "gyp+prepare") => {
  const rs = run.join(" ");
  const scripts = where === "postinstall" ? { postinstall: `node x.js && node y.js && ${rs}` } : where === "gyp+prepare" ? { prepare: "echo hi" } : undefined;
  const mk = (v: string, name: string): FileMap =>
    files({
      "package.json": JSON.stringify({ name, version: v, bin: { p: "x.js" }, ...(scripts ? { scripts } : {}) }),
      "x.js": WRITER,
      "y.js": WRITER,
      "docs/changed.js": "console.log(2)\n",
      "local.js": "1\n",
      ...(where === "postinstall" ? {} : { [where === "deps-gyp" ? "deps/binding.gyp" : "binding.gyp"]: gyp([...BOTH, run]) }),
    });
  return holds(mk("1.0.0", n1), mk("1.0.1", n2));
};
for (const [n1, n2] of [["p", "q"], ["q", "p"], ["p", "P"], ["@s/p", "@t/p"]] as const)
  for (const run of [["npx", "p"], ["npx", "p@1"], ["npm", "exec", "--", "p"], ["npm", "exec", "--", "p@1"], ["npx", "@s/p"]])
    for (const where of ["postinstall", "gyp", "deps-gyp", "gyp+prepare"] as const)
      test(`a package renamed ${n1} -> ${n2} holds, the install runs ${run.join(" ")} (${where})`, () => {
        expect(rename(n1, n2, run, where)).toBe(true);
      });
test("control: the same name and the same bin release when the install runs the same files", () => {
  expect(rename("p", "p", ["npx", "p"], "postinstall")).toBe(false);
  expect(rename("p", "p", ["npx", "p"], "gyp")).toBe(false);
});
