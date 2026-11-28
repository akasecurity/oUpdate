import { expect, test } from "bun:test";
import { prepass, type FileMap } from "../src/prepass.ts";
import { allowFaults } from "./fault-guard.ts";
import { scannerFaultCount } from "../src/install-closure.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const files = (o: Record<string, string>): FileMap => new Map(Object.entries(o).map(([k, v]) => [k, enc(v)]));

// The receiver scan of a call charges the span it splits at its commas (splitTop) on top of its own count. A file of 16,247 characters (250 spaces after the
// comma of an `Object.assign({}, ...)`, 650 nested `require("./a.js", ...)` calls and 3,624 trailing spaces) faults the scan because of that second charge;
// without it the file passes and a release that only bumps the version is let through. The charge is a fail-closed overhold and it stays. This test pins code
// that did not change in this review round: it goes red when the charge is removed again.
test("a file of 650 nested require calls under an Object.assign with spaces is held as a scanner fault, and a version bump is held with it", () => {
  allowFaults();
  const body = `Object.assign({},${" ".repeat(250)}${'require("./a.js", '.repeat(650)}"x"${")".repeat(650)});${" ".repeat(3624)}\n`;
  const mk = (v: string): FileMap =>
    files({ "package.json": JSON.stringify({ name: "p", version: v, scripts: { install: "node lib/x.js" } }), "lib/x.js": body, "lib/a.js": "1\n" });
  const before = scannerFaultCount();
  const r = prepass("npm", mk("1.0.0"), mk("1.0.1"));
  expect(r.hard.some((s) => s.kind === "install-script")).toBe(true);
  expect(scannerFaultCount() - before).toBeGreaterThan(0);
});

// A scanner fault in a replayed line (an unresolved expansion beside a pipe) holds the package: the replay ran the same scan under the same limit, and a fault there is
// no stop of the line. The file of the test above is main, run through `node .` on the replayed line; only lib/a.js changes.
test("a scanner fault in the file a replayed line runs holds the package", () => {
  allowFaults();
  const body = `Object.assign({},${" ".repeat(250)}${'require("./a.js", '.repeat(650)}"x"${")".repeat(650)});${" ".repeat(3624)}\n`;
  for (const line of ["echo $X | node .", "echo $X | cat && node .", "echo $X | cat && npx ."]) {
    const mk = (v: string, a: string): FileMap =>
      files({ "package.json": JSON.stringify({ name: "p", version: v, main: "lib/x.js", scripts: { install: line } }), "lib/x.js": body, "lib/a.js": a });
    const before = scannerFaultCount();
    expect({ line, held: prepass("npm", mk("1.0.0", "1\n"), mk("1.0.1", "2\n")).hard.some((s) => s.kind === "install-script") }).toEqual({ line, held: true });
    expect(scannerFaultCount() - before).toBeGreaterThan(0);
  }
});
