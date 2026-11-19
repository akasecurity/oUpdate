import { expect, test } from "bun:test";
import { prepass, type FileMap } from "../src/prepass.ts";
import { allowFaults } from "./fault-guard.ts";
import { classifyJs, scannerFaultCount, setJsScanSteps } from "../src/install-closure.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const files = (o: Record<string, string>): FileMap => new Map(Object.entries(o).map(([k, v]) => [k, enc(v)]));
const release = (v: string, body: string): FileMap =>
  files({
    "package.json": JSON.stringify({ name: "p", version: v, scripts: { postinstall: "node lib/x.js" } }),
    "lib/x.js": body,
    "docs/evil.js": "console.log(1)\n",
  });
const held = (body: string): boolean => prepass("npm", release("1.0.0", body), release("1.0.1", body)).hard.some((s) => s.kind === "install-script");

// Only the manifest version changes between the releases.
// Run calls nested in the arguments of run calls: the scan reads inside the arguments. What it reads there is work main does not do, so it must not
// end the scan early (a file that the scans after it fault on would be released) and must not spend the budget the later stops are measured against.
const nest = (n: number, names: number): string =>
  `const cp = require("child_process");\n` +
  (names ? `const s = "${Array.from({ length: names }, (_, i) => `createRequire:c${i}`).join(" ")}";\n` : "") +
  `cp.spawnSync(process.execPath, ["./a.js"], { x: `.repeat(n) + "1" + " })".repeat(n) + ";\n";

test("200 nested run calls and a string of names are held at the default limit", () => {
  allowFaults();
  expect(held(nest(200, 50))).toBe(true);
});
test("a few nested run calls of a literal file are not held", () => {
  expect(held(nest(3, 0))).toBe(false);
});

// The file with no string of names faults under every scan limit below 6.37M steps on the parent of the change (the scan reaches the stops after the
// nested runs): a fault is a hold, so under each limit from 5.5M to 6.3M the scan must fault here too, not end early with a widening and no fault.
test("200 nested run calls fault under every scan limit below the limit the parent passes under", () => {
  allowFaults();
  const src = nest(200, 0);
  for (let n = 5_500_000; n <= 6_300_000; n += 50_000) {
    setJsScanSteps(n);
    const before = scannerFaultCount();
    classifyJs("lib/x.js", src);
    setJsScanSteps(undefined);
    expect(scannerFaultCount() > before).toBe(true);
  }
});

// A receiver walk inside the arguments of a run call (`a["]"].require(0)`, each bracket in a string counted) is work main does not do either: it
// must not spend the budget the later stops are measured against.
const walk = (pad: number): string =>
  `const cp = require("child_process");\n` +
  `const s = "${Array.from({ length: 100 }, (_, i) => `createRequire:c${i}`).join(" ")}";\n` +
  `/*${" ".repeat(pad)}*/\n` +
  `cp.spawnSync(process.execPath, ["./a.js"], ` + `a["]"].require(0), `.repeat(20000) + `1);\n`;
test("20000 receiver walks inside a run call are held at the default limit", () => {
  allowFaults();
  expect(held(walk(16000))).toBe(true);
});
test("receiver walks inside a run call are held at the paddings the parent of the change holds (up to 16000)", () => {
  allowFaults();
  for (const pad of [14000, 15000, 16000]) expect(held(walk(pad))).toBe(true);
}, 60000);

// The work of main and the work inside run calls, together past the budget, widens (the release before this one widened there).
test("run calls inside a run call, with 40 names summed, widen once the two kinds of work pass the budget together", () => {
  const names = Array.from({ length: 40 }, (_, i) => `const a${i} = "qqqqqqqqqq";\n`).join("");
  for (const m of [171, 175, 181]) {
    const body = `const cp = require("child_process");\n${names}const nK = ${Array.from({ length: 40 }, (_, i) => `a${i}`).join(" + ")};\ncp.exec("ls", () => [` + "cp.execSync(nK), ".repeat(m) + "1]);\n";
    expect(classifyJs("lib/x.js", body).all).toBe(true);
  }
});

// The work inside run calls is not spent from the budget the later stops are measured against: the file below passes under a scan limit that is
// no lower than the one PR A (the release before this one) passes under (measured there: 150317, 234349 and 303387 steps for 100, 175 and 300 calls).
// With the work counted in `spent` the file passed under 135195, 173795 and 238129: below the limit it is held under on PR A.
test("run calls inside a run call, with 40 names, fault under every scan limit below the one PR A passes under", () => {
  allowFaults();
  const names = Array.from({ length: 40 }, (_, i) => `const a${i} = "qqqqqqqqqq";\n`).join("");
  for (const [m, pass] of [[100, 150317], [175, 234349], [300, 303387]] as const) {
    const body = `const cp = require("child_process");\n${names}const nK = ${Array.from({ length: 40 }, (_, i) => `a${i}`).join(" + ")};\ncp.exec("ls", () => [` + "cp.execSync(nK), ".repeat(m) + "1]);\n";
    for (const n of [pass - 1, pass - 5000, 60000]) {
      setJsScanSteps(n);
      const before = scannerFaultCount();
      classifyJs("lib/x.js", body);
      setJsScanSteps(undefined);
      expect(scannerFaultCount() > before).toBe(true);
    }
  }
});

// The main work and the work inside run calls, taken together past the budget, widen, also when either kind grows after the last read inside a
// run call: (1A) the work inside a run call first, the main work after it closes; (1B) the last nested run call crosses the budget with no call after.
test("work inside a run call, then main work after it, widens once the two together pass the budget", () => {
  const m = `module.parent.require("./a.js", `.repeat(15) + `"${"q".repeat(10_000)}"` + `)`.repeat(15);
  const src = `const cp = require("child_process");\n` + `cp.exec("ls", () => {\n ${m};\n});\n` + `${m};\n`;
  expect(classifyJs("lib/x.js", src).all).toBe(true);
});
// A receiver walk after the last read inside a run call (`a["]"]["]"]["]"]["]"]["]"].require(0)`, the sum 40 names and 170 calls reach just under
// the budget before it): its walk counts, and the sum past the budget widens.
test("a receiver walk inside a run call that takes the sum past the budget widens", () => {
  const nK = Array.from({ length: 40 }, (_, i) => `a${i}`).join(" + ");
  const names = `const a0 = "${"q".repeat(20)}";\n` + Array.from({ length: 39 }, (_, i) => `const a${i + 1} = "qqqqqqqqqq";\n`).join("");
  for (const pad of [145, 155, 165]) {
    const body = CP + names + `const nK = ${nK};\n` + `cp.exec("ls", () => [` + "cp.execSync(nK), ".repeat(170) + `a["]"]["]"]["]"]["]"]["]"].require(0)]);\n` + " ".repeat(pad);
    expect(classifyJs("lib/x.js", body).all).toBe(true);
  }
});

// Once the file has widened, the nested run call after it is stepped over: no walk of it, no read of it. The file below passes under a scan limit that
// is a few steps above the one the previous release passes under (measured 4880531 there, 5180623 here); without the stepping over it needs 5230629,
// and without the guard of a read after a widening 5330644.
test("a run call nested after a widening is stepped over", () => {
  const body = CP + `cp.exec("ls", () => { f(a)(b); cp.exec("ls", () => { ${"x; ".repeat(50_000)}}); });\n`;
  setJsScanSteps(5_200_000);
  const before = scannerFaultCount();
  classifyJs("lib/x.js", body);
  setJsScanSteps(undefined);
  expect(scannerFaultCount()).toBe(before);
});

// A nested run call is counted once: the file below (118 names, 9 nested run calls over 100 kB) faults under every scan limit below the one the
// previous release passes under (31885382); counting each call's arguments twice stepped over the later calls sooner and passed under less.
test("9 nested run calls over 100 kB fault under every scan limit below the one the previous release passes under", () => {
  allowFaults();
  const unit = `cp.spawnSync(process.execPath, ["./a.js"], { x: `;
  const body = CP + `const s = "${Array.from({ length: 118 }, (_, i) => `createRequire:c${i}`).join(" ")}";\n` + unit.repeat(9) + `"${"q".repeat(100_000)}"` + " })".repeat(9) + ";\n";
  for (const n of [31_885_381, 31_600_000, 25_000_000]) {
    setJsScanSteps(n);
    const before = scannerFaultCount();
    classifyJs("lib/x.js", body);
    setJsScanSteps(undefined);
    expect(scannerFaultCount() > before).toBe(true);
  }
});

// A run call followed by a call, and a curried call inside the arguments of a run call, cannot be resolved: the file widens to every file, and the
// scans after it still run (a widening is no early return).
const CP = `const cp = require("child_process");\n`;
const tail = (n: number): string => 'require("./a.js", '.repeat(n) + '"x"' + ")".repeat(n) + ";\n";
test("a call on the result of a run call widens to every file", () => {
  expect(classifyJs("lib/x.js", `${CP}cp.spawnSync(process.execPath, ["./a.js"])(1);\n`).all).toBe(true);
});
test("a curried call inside the arguments of a run call widens to every file", () => {
  expect(classifyJs("lib/x.js", `${CP}cp.spawnSync(process.execPath, [f(a)(b)]);\n`).all).toBe(true);
});
test("a call on a run call that is not read as a load, in a file past the scan limit of its later scans, is held as a fault", () => {
  allowFaults();
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
  for (const widen of [`cp.exec("ls", () => 1)(1);\n`, `cp.exec("ls", () => f(a)(b));\n`, `var foo = bar();\ncp.exec("ls", () => cp.execSync(foo + "x"));\n`]) {
    const same = widen.replace("(1)", "").replace("(b)", "").replace("foo + ", "");
    expect(passLimit(CP + widen + tail(60))).toBeGreaterThanOrEqual(passLimit(CP + same + tail(60)) - 50);
  }
});

// Nested run calls whose arguments the scan walks again, each in turn: the walk is counted, and past the budget the file widens.
test("30 nested run calls over 100 kB widen to every file", () => {
  const unit = `cp.spawnSync(process.execPath, ["./a.js"], { x: `;
  expect(classifyJs("lib/x.js", CP + unit.repeat(30) + `"${"q".repeat(100_000)}"` + " })".repeat(30) + ";\n").all).toBe(true);
});

// The sum of the main work and the work inside run calls widens only past the budget: at the budget exactly it does not (40 names, 170 calls inside a
// run call and a call that costs nothing: the sum is the budget with 17 characters in the first name and 108 of trailing blanks; one character fewer, 8 more steps).
const edge = (v: number, pad: number): string => {
  const nK = Array.from({ length: 40 }, (_, i) => `a${i}`).join(" + ");
  const names = `const a0 = "${"q".repeat(v)}";\n` + Array.from({ length: 39 }, (_, i) => `const a${i + 1} = "qqqqqqqqqq";\n`).join("");
  return CP + names + `const nK = ${nK};\n` + `cp.exec("ls", () => [` + "cp.execSync(nK), ".repeat(170) + `o.m()]);\n` + " ".repeat(pad);
};
test("the sum of the two kinds of work at the budget exactly does not widen; 8 steps past it does", () => {
  expect(classifyJs("lib/x.js", edge(17, 108)).all).toBe(false);
  expect(classifyJs("lib/x.js", edge(17, 107)).all).toBe(true);
});

// A `.require(` call inside the arguments of a run call is counted, not widened.
test("a receiver walk inside the arguments of a run call alone does not widen", () => {
  expect(classifyJs("lib/x.js", CP + `cp.exec("ls", () => [a["]"].require(0), 1]);\n`).all).toBe(false);
});

// A walk at the top level is main's own work, charged to `spent` (not to the separate counter): past the budget by itself it ends the scan, as on
// the previous release. Measured pass limit 22926702 steps (charged to the other counter: 23136673).
test("receiver walks at the top level end the scan when they pass the budget alone", () => {
  allowFaults();
  const body = CP + `f(` + `a["]"].require(0), `.repeat(40000) + `1);\n` + "x; ".repeat(50000) + "\n";
  setJsScanSteps(23_000_000);
  const before = scannerFaultCount();
  classifyJs("lib/x.js", body);
  setJsScanSteps(undefined);
  expect(scannerFaultCount()).toBe(before);
});

// The checks of the sum before and after a read inside a run call: past the budget the read (before) or the rest of the arguments (after) is skipped.
// With 4000 calls inside a run call the file is held at the default limit only if the walk of all of them is skipped (head: skipped from call ~86).
test("4000 calls inside a run call over 40 long names are not held at the default limit (the walk stops once the sum passes the budget)", () => {
  const names = Array.from({ length: 40 }, (_, i) => `const a${i} = "${"q".repeat(200)}";\n`).join("");
  const nK = Array.from({ length: 40 }, (_, i) => `a${i}`).join(" + ");
  expect(held(CP + names + `const nK = ${nK};\ncp.exec("ls", () => [` + "cp.execSync(nK), ".repeat(4000) + "1]);\n")).toBe(false);
}, 60000);
// The check before a read alone: the sum is past the budget before the read of a 100 kB literal inside the second run call (6459343 steps; 6559355 without it).
const nested = (d: number, s: number): string => `module.parent.require("./a.js", `.repeat(d) + `"${"q".repeat(s)}"` + `)`.repeat(d);
test("a read inside a run call after the sum has passed the budget is skipped", () => {
  const mm = nested(60, 10000);
  const body = CP + `cp.exec("ls", () => {\n ${mm};\n});\n${mm};\ncp.exec("ls", () => [cp.execSync("a", "${"q".repeat(100000)}")]);\n`;
  setJsScanSteps(6_500_000);
  const before = scannerFaultCount();
  classifyJs("lib/x.js", body);
  setJsScanSteps(undefined);
  expect(scannerFaultCount()).toBe(before);
});
// The check after a read alone: the sum passes the budget at the read of the second run call, and the arguments after it (50000 brackets) are stepped over
// (13334340 steps; 13434350 without it).
test("the rest of the arguments of a run call is stepped over once the sum has passed the budget", () => {
  const body = CP + `cp.exec("ls", () => {\n ${nested(56, 10000)};\n});\n${nested(85, 10000)};\ncp.exec("ls", () => cp.spawnSync(process.execPath, ["./a.js"], { a: [${"[], ".repeat(50000)}1] }));\n`;
  setJsScanSteps(13_400_000);
  const before = scannerFaultCount();
  classifyJs("lib/x.js", body);
  setJsScanSteps(undefined);
  expect(scannerFaultCount()).toBe(before);
});
