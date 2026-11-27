import { expect, test } from "bun:test";
import { prepass, type FileMap } from "../src/prepass.ts";
import { allowFaults } from "./fault-guard.ts";
import { classifyJs, scannerFaultCount, setJsScanSteps } from "../src/install-closure.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const files = (o: Record<string, string>): FileMap => new Map(Object.entries(o).map(([k, v]) => [k, enc(v)]));
const CPX = `const cp = require("child_process");\n`;

// An entry at lib/x.js is the postinstall hook; only docs/evil.js changes between the releases. A file under docs/ is outside the package tier, so
// the release holds it only when the scan reaches it by name, by a literal prefix or by widening to every file.
const release = (v: string, body: string): FileMap =>
  files({
    "package.json": JSON.stringify({ name: "p", version: v, scripts: { postinstall: "node lib/x.js" } }),
    "lib/x.js": body,
    "lib/a.js": "module.exports = 1\n",
    "docs/evil.js": `console.log("evil ${v}")\n`,
  });
const held = (body: string): boolean => prepass("npm", release("1.0.0", body), release("1.0.1", body)).hard.some((s) => s.kind === "install-script");

// A command argument spelled so that no literal in the text names docs/evil.js, run from the package root.
const DE = `decodeURIComponent("docs%2Fevil.js")`;

// An argument array of a run call that is changed after its literal value: the scan read the literal and took the array as constant.
const rows: [string, string][] = [
  ["an argv array pushed to after its literal", `${CPX}const args = [];\nargs.push(${DE});\ncp.spawnSync(process.execPath, args);\n`],
  ["an argv array written by index after its literal", `${CPX}const args = ["lib/a.js"];\nargs[0] = ${DE};\ncp.spawnSync(process.execPath, args);\n`],
  ["an argv array with unshift", `${CPX}const args = ["lib/a.js"];\nargs.unshift(${DE});\ncp.spawnSync(process.execPath, args);\n`],
  ["an argv array with splice", `${CPX}const args = ["lib/a.js"];\nargs.splice(0, 1, ${DE});\ncp.spawnSync(process.execPath, args);\n`],
  ["an argv array with fill", `${CPX}const args = ["lib/a.js"];\nargs.fill(${DE});\ncp.spawnSync(process.execPath, args);\n`],
  ["an argv array pushed to through a computed member", `${CPX}const args = [];\nargs["push"](${DE});\ncp.spawnSync(process.execPath, args);\n`],
  ["an argv array pushed to through an optional chain", `${CPX}const args = [];\nargs?.push(${DE});\ncp.spawnSync(process.execPath, args);\n`],
  ["an argv array pushed to through Array.prototype.push.call", `${CPX}const args = [];\nArray.prototype.push.call(args, ${DE});\ncp.spawnSync(process.execPath, args);\n`],
  ["an argv array changed by Object.assign", `${CPX}const args = ["lib/a.js"];\nObject.assign(args, [${DE}]);\ncp.spawnSync(process.execPath, args);\n`],
  ["an argv array changed by an index compound write", `${CPX}const args = ["lib/"];\nargs[0] += ${DE};\ncp.spawnSync(process.execPath, args);\n`],
  ["an argv array written by a computed index", `${CPX}const args = ["lib/a.js"];\nlet i = 0;\nargs[i + 0] = ${DE};\ncp.spawnSync(process.execPath, args);\n`],
  ["an argv array written through a name that holds the same array", `${CPX}const args = [];\nconst b = args;\nb.push(${DE});\ncp.spawnSync(process.execPath, args);\n`],
  ["an argv array written through a name that holds the same array, in the other direction", `${CPX}const args = [];\nconst b = args;\nargs.push(${DE});\ncp.spawnSync(process.execPath, b);\n`],
  ["an argv array pushed to inside a helper that takes it as a parameter", `${CPX}function add(a) { a.push(${DE}); }\nconst args = [];\nadd(args);\ncp.spawnSync(process.execPath, args);\n`],
  ["an argv array written by index in a callback", `${CPX}const args = ["lib/a.js"];\n[1].forEach(() => { args[0] = ${DE}; });\ncp.spawnSync(process.execPath, args);\n`],
  ["an argv array pushed to through Reflect.apply, whose second argument is the array", `${CPX}const args = [];\nReflect.apply(Array.prototype.push, args, [${DE}]);\ncp.spawnSync(process.execPath, args);\n`],
  ["an argv array pushed to through Array.prototype.push.apply", `${CPX}const args = [];\nArray.prototype.push.apply(args, [${DE}]);\ncp.spawnSync(process.execPath, args);\n`],
  ["an argv array changed by Object.defineProperty", `${CPX}const args = ["lib/a.js"];\nObject.defineProperty(args, "0", { value: ${DE} });\ncp.spawnSync(process.execPath, args);\n`],
  ["an argv array changed by Object.defineProperties", `${CPX}const args = ["lib/a.js"];\nObject.defineProperties(args, { 0: { value: ${DE} } });\ncp.spawnSync(process.execPath, args);\n`],
  ["an argv array changed by Reflect.set", `${CPX}const args = ["lib/a.js"];\nReflect.set(args, 0, ${DE});\ncp.spawnSync(process.execPath, args);\n`],
  ["an argv array written by index as the binding of a for-of", `${CPX}const args = ["lib/a.js"];\nfor (args[0] of [${DE}]);\ncp.spawnSync(process.execPath, args);\n`],
  ["an argv array pushed to through a parenthesized name", `${CPX}const args = [];\n(args).push(${DE});\ncp.spawnSync(process.execPath, args);\n`],
  ["an argv array written by index through a parenthesized name", `${CPX}const args = ["lib/a.js"];\n(args)[0] = ${DE};\ncp.spawnSync(process.execPath, args);\n`],
  ["an argv array written through a name that holds it in parentheses", `${CPX}const args = [];\nconst b = (args);\nb.push(${DE});\ncp.spawnSync(process.execPath, args);\n`],
  ["an argv array written through a name that holds it or an empty array", `${CPX}const args = [];\nconst b = args || [];\nb.push(${DE});\ncp.spawnSync(process.execPath, args);\n`],
  ["an argv array written through a name two aliases away", `${CPX}const args = [];\nconst b = args;\nconst c = b;\nc.push(${DE});\ncp.spawnSync(process.execPath, args);\n`],
  ["an argv array written through a name two aliases away, in the other direction", `${CPX}const args = [];\nconst b = args;\nconst c = b;\nargs.push(${DE});\ncp.spawnSync(process.execPath, c);\n`],
  ["an argv array written by an index bracket that does not close in 400 characters", `${CPX}const args = ["lib/a.js"];\nargs[0${" ".repeat(450)}] = ${DE};\ncp.spawnSync(process.execPath, args);\n`],
  ["an argv array in parentheses with a helper that writes to its parameter", `${CPX}function add(a) { a.push(${DE}); }\nconst args = (["lib/a.js"]);\nadd(args);\ncp.spawnSync(process.execPath, args);\n`],
];
for (const [label, body] of rows) {
  test(`${label} holds the changed docs/evil.js`, () => {
    expect(held(body)).toBe(true);
  });
}

// Shapes that are held today (pins), each next to the rows it differs from by the one thing it names.
const pins: [string, string][] = [
  ["an argv array set whole by assignment", `${CPX}let args = ["lib/a.js"];\nargs = [${DE}];\ncp.spawnSync(process.execPath, args);\n`],
  ["an argv array spread into a new array", `${CPX}const a = [${DE}];\ncp.spawnSync(process.execPath, [...a]);\n`],
  ["an argv array that holds the command as a literal element", `${CPX}cp.spawnSync(process.execPath, [${DE}]);\n`],
  ["a write to an array the run call does not read, then a run of a constant", `${CPX}const other = [];\nother.push(1);\ncp.spawnSync(process.execPath, [${DE}]);\n`],
  ["an argv array written to before a load by a constant name", `const args = [];\nargs.push(1);\nrequire("../lib/" + decodeURIComponent("..%2Fdocs%2Fevil.js"));\n`],
];
for (const [label, body] of pins) {
  test(`pin: ${label} holds the changed docs/evil.js`, () => {
    expect(held(body)).toBe(true);
  });
}

// A literal argument array that is never written to stays constant: nothing widens to every file.
for (const [label, body] of [
  ["a literal argv array of a file the release did not change", `${CPX}const args = ["lib/a.js"];\ncp.spawnSync(process.execPath, args);\n`],
  ["a literal argv array read by index", `${CPX}const args = ["lib/a.js"];\nconst first = args[0];\ncp.spawnSync(process.execPath, args);\n`],
  ["another array pushed to and a literal argv array that is not", `${CPX}const log = [];\nlog.push("x");\nconst args = ["lib/a.js"];\ncp.spawnSync(process.execPath, args);\n`],
  ["an array compared by index, not written", `${CPX}const args = ["lib/a.js"];\nif (args[0] == "lib/a.js") cp.spawnSync(process.execPath, args);\n`],
] as [string, string][]) {
  test(`pin: ${label} does not hold docs/evil.js`, () => {
    expect(held(body)).toBe(false);
  });
}

// The widening for a written array is not an early end of the scan: the scans after it run as they do for a file with no write in it, so a file they
// fault on is held as a fault, not released. A file that pushes to its argv array (`pusx` is no method: the same text without the write) passes under a
// scan limit no lower than the one without the write.
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
test("a file with a write to its argv array passes under a scan limit no lower than the same file without it", () => {
  allowFaults();
  const file = (method: string) => `${CPX}const args = ["./a.js"];\nargs.${method}(${DE});\ncp.spawnSync(process.execPath, args);\n` + 'require("./a.js", '.repeat(80) + '"x"' + ")".repeat(80) + ";\n";
  expect(passLimit(file("push"))).toBeGreaterThanOrEqual(passLimit(file("pusx")));
  setJsScanSteps(passLimit(file("push")) - 1);
  const before = scannerFaultCount();
  expect(classifyJs("lib/x.js", file("push")).all).toBe(true);
  expect(scannerFaultCount() - before).toBe(1);
  setJsScanSteps(undefined);
});

// A scan limit shared by the whole run (prepass): a file the scan faults on is held as `install-script|scanner fault`, and a release that only bumps
// the version is held with it. The second read of the names a string default or a write hides is not main's reading of the arguments of a run call,
// and one name it widens on must not skip the second reads of the later calls: they cost scan steps, and a file that passes under a limit the file
// without the skip faults under is released with its manifest. The file below has both a default holding a bracket (OUP-254 B) and an argument array
// pushed to (this change); the limits are inside the window where the file faults with the second read run for every call (77,280 up to the
// smallest passing limit, 77,370, before this change skipped it). They move with the step counts of the scans.
test("a file with a hidden parameter and a written argument array is held under a limit the second reads of every call fault on", () => {
  allowFaults();
  const body =
    `var cp = require("child_process");\nvar n = "a.js";\nfunction f(n, q = "(") {}\nvar args = ["a.js"]; args.push(x);\ncp.spawnSync("node", args);\n` +
    `cp.execSync("node", ["x", function(){ require("./" + n); }]);\n`.repeat(40);
  for (const limit of [77290, 77330, 77360]) {
    setJsScanSteps(limit);
    try {
      // A release that only bumps the version: only a fault (or a widening that reaches a manifest) holds it.
      const same = (v: string): FileMap =>
        files({
          "package.json": JSON.stringify({ name: "p", version: v, scripts: { postinstall: "node lib/x.js" } }),
          "lib/x.js": body,
          "lib/a.js": "1\n",
          "lib/sub/package.json": JSON.stringify({ name: "s", version: "1.0.0", main: "a.js" }),
          "docs/evil.js": "e\n",
        });
      expect(prepass("npm", same("1.0.0"), same("1.0.1")).hard.some((s) => s.kind === "install-script")).toBe(true);
    } finally {
      setJsScanSteps(undefined);
    }
  }
});

// The index-write scan, the alias walk and the read of the written names count in a counter of their own (never in the one of the second read of
// string defaults, OUP-254 B): a file that makes the index scan expensive (300 lines of an unclosed `a[a[...` string, 400 steps each) must still
// hold a release through a parameter that a string default hides.
test("a file with a costly index scan and a hidden parameter holds the changed docs/evil.js", () => {
  const body = `var s = "${"a[".repeat(363)}";\n`.repeat(300) + `var n = "a.js";\nfunction f(n, q = "(") { return require("./" + n); }\nf(decodeURIComponent("..%2Fdocs%2Fevil.js"));\n`;
  expect(prepass("npm", release("1.0.0", body), release("1.0.1", body)).hard.some((s) => s.kind === "install-script")).toBe(true);
});
test("the same with nested index brackets in code", () => {
  const body = `x = ${"a[".repeat(200)}0${"]".repeat(200)};\n`.repeat(4) + `var n = "a.js";\nfunction f(n, q = "(") { return require("./" + n); }\nf(decodeURIComponent("..%2Fdocs%2Fevil.js"));\n`;
  expect(prepass("npm", release("1.0.0", body), release("1.0.1", body)).hard.some((s) => s.kind === "install-script")).toBe(true);
});

// The read of the written names takes every step the second read of the string defaults takes (it is a separate read, on its own memo): under a
// limit the file faults on with B alone, a version-only release is held. The limits are inside the window below the smallest passing limit of B
// (37,317) and at or above the one of the same file with the written name left out of the second read (36,465); they move with the step counts.
test("a hidden default and an argument array pushed to and read by 40 run calls is held under the limits where the second read faults", () => {
  allowFaults();
  const body =
    `var cp = require("child_process");\nvar n = "a.js";\nfunction f(n, q = "(") {}\nvar args = ["a.js"];\nargs.push(decodeURIComponent("..%2Fdocs%2Fevil.js"));\n` +
    `cp.spawnSync("node", args);\n`.repeat(40) +
    `require("./" + n);\n`;
  const same = (v: string): FileMap =>
    files({
      "package.json": JSON.stringify({ name: "p", version: v, scripts: { postinstall: "node lib/x.js" } }),
      "lib/x.js": body,
      "lib/a.js": "1\n",
      "lib/sub/package.json": JSON.stringify({ name: "s", version: "1.0.0", main: "a.js" }),
      "docs/evil.js": "e\n",
    });
  for (const limit of [36600, 36832, 37200, 37300]) {
    setJsScanSteps(limit);
    try {
      expect(prepass("npm", same("1.0.0"), same("1.0.1")).hard.some((s) => s.kind === "install-script")).toBe(true);
    } finally {
      setJsScanSteps(undefined);
    }
  }
});

// A widening that only the read of the written names finds is applied after the literals of the files scanned are read: widening first takes every
// file in, and a literal that reaches docs/addon.node by its stem finds it taken in, so the scan raises no stop (script depth) that it raises
// without the widening. The hook below reaches 62 more files, then a stem that names an addon, then an argument array written by index.
test("a written argument array in a file that reaches the scan cap holds as the file without the write holds", () => {
  const mk = (ver: string): FileMap => {
    const o: Record<string, string> = {
      "package.json": JSON.stringify({ name: "x", version: ver, scripts: { postinstall: "node h0.js" } }),
      "h0.js": `require("./h1.js");\nconst path = require("path");\nconst cp = require("child_process");\nconst a = [];\na[0] = process.argv[2];\ncp.spawnSync("echo", a);\npath.join("x", "addon");\n`,
      "h63.js": "1;\n",
      "docs/addon.node": "x",
    };
    for (let i = 1; i <= 62; i++) o[`h${i}.js`] = `require("./h${i + 1}.js");\n`;
    return files(o);
  };
  const details = prepass("npm", mk("1.0.0"), mk("1.0.1")).hard.map((s) => `${s.kind}|${s.detail ?? ""}`);
  expect(details).toContain("install-script|unresolved: script depth");
});

// The read of the written names passes its budget (about 670 bytes of unclosed `a[` strings cost 400 steps each): the file widens, as it does
// with fewer such lines, instead of releasing the release.
test("a written argument array in a file whose index scan passes its budget holds the changed docs/evil.js", () => {
  const body = `var s = "${"a[".repeat(25)}";\n`.repeat(12) + `var cp = require("child_process");\nvar args = ["lib/a.js"];\nargs.push(decodeURIComponent("..%2Fdocs%2Fevil.js"));\ncp.spawnSync(process.execPath, args);\n`;
  expect(prepass("npm", release("1.0.0", body), release("1.0.1", body)).hard.some((s) => s.kind === "install-script")).toBe(true);
});

// The read of the written names is not charged to the counter of the second read of string defaults: a hidden default, an unrelated write and 40
// run calls with a name made of 150 parts hold the changed docs/evil.js.
test("a hidden default with an unrelated write and run calls on a long name holds the changed docs/evil.js", () => {
  const parts = Array.from({ length: 150 }, (_, i) => `var a${i} = "x${i}";\n`).join("");
  const p = `var p = ${Array.from({ length: 150 }, (_, i) => `a${i}`).join(" + ")};\n`;
  const body = `var cp = require("child_process");\n${parts}${p}var n = "a.js";\nfunction f(n, q = "(") {}\nvar other = [];\nother.push(1);\n` + `cp.spawnSync("node", [p]);\n`.repeat(40) + `require("./" + n);\n`;
  expect(prepass("npm", release("1.0.0", body), release("1.0.1", body)).hard.some((s) => s.kind === "install-script")).toBe(true);
});

// The widening of the read of the written names must not settle an addon for the stem lookup of a LATER file: early.js writes the argument array, then
// h0.js reaches 62 more files and names docs/addon.node by its stem, and the scan raises the stop (script depth) as it does without the write.
for (const [name, cmd] of [["&&", "node early.js && node h0.js"], ["a pipe", "node early.js | node h0.js"]] as const) {
  test(`an argv write in an earlier hook ${name} a later hook that reaches the scan cap and names an addon by stem holds on script depth`, () => {
    const mk = (ver: string): FileMap => {
      const o: Record<string, string> = {
        "package.json": JSON.stringify({ name: "x", version: ver, scripts: { postinstall: cmd } }),
        "early.js": `${CPX}const a = [];\na[0] = process.argv[2];\ncp.spawnSync("echo", a);\n`,
        "h0.js": `require("./h1.js");\nconst path = require("path");\n${CPX}cp.spawnSync("echo", ["hello"]);\npath.join("x", "addon");\n`,
        "h62.js": "1;\n",
        "docs/addon.node": "x",
      };
      for (let i = 1; i <= 61; i++) o[`h${i}.js`] = `require("./h${i + 1}.js");\n`;
      return files(o);
    };
    const details = prepass("npm", mk("1.0.0"), mk("1.0.1")).hard.map((s) => `${s.kind}|${s.detail ?? ""}`);
    expect(details).toContain("install-script|unresolved: script depth");
  });
}

// The index scan stops at its budget before it reaches the write by index: the file widens, as it does with a push (which the other read finds).
test("a written argument array after an index scan that stops at its budget holds the changed docs/evil.js", () => {
  const nest = `x = ${"a[".repeat(130)}${"]".repeat(130)};\n`.repeat(10);
  const body = `${CPX}${nest}const args = ["lib/a.js"];\nargs[0] = ${DE};\ncp.spawnSync(process.execPath, args);\n`;
  expect(held(body)).toBe(true);
});
