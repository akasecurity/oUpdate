import { expect, test } from "bun:test";
import { prepass, type FileMap } from "../src/prepass.ts";
import { allowFaults } from "./fault-guard.ts";
import { classifyJs, scannerFaultCount, setJsScanSteps } from "../src/install-closure.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const files = (o: Record<string, string>): FileMap => new Map(Object.entries(o).map(([k, v]) => [k, enc(v)]));

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

// The name of docs/evil.js, spelled so that no literal in the text names it: from lib/x.js a load of "../lib/" + D is docs/evil.js.
const D = `decodeURIComponent("..%2Fdocs%2Fevil.js")`;

// A parameter list or a destructuring whose default value is a string that holds a bracket: the scan back from the closing bracket stopped at the
// one inside the string, so the parameter or the bound name was not read as one and the load of it read as a constant. Each row loads
// docs/evil.js through a name that the call or the destructuring rebinds.
const rows: [string, string][] = [
  ["a parameter list with a default that is a string holding a parenthesis", `var n = "a.js";\nfunction f(n, q = "(") { return require("../lib/" + n); }\nf(${D});\n`],
  ["a destructuring with a default that is a string holding a brace", `var n = "a.js";\nfunction f(o) { const { n, x = "{" } = o; return require("../lib/" + n); }\nf({ n: ${D} });\n`],
  ["a parameter list with a default that is a single-quoted string holding a parenthesis", `var n = "a.js";\nfunction f(n, q = '(') { return require("../lib/" + n); }\nf(${D});\n`],
  ["a parameter list with a default that is a string holding a bracket", `var n = "a.js";\nfunction f(n, q = "[") { return require("../lib/" + n); }\nf(${D});\n`],
  ["an arrow function parameter list with a string default holding a parenthesis", `var n = "a.js";\nconst f = (n, q = "(") => require("../lib/" + n);\nf(${D});\n`],
  ["a method parameter list with a string default holding a parenthesis", `var n = "a.js";\nconst o = { m(n, q = "(") { return require("../lib/" + n); } };\no.m(${D});\n`],
  ["a destructuring with a string default holding a bracket", `var n = "a.js";\nfunction f(o) { const [n, x = "["] = o; return require("../lib/" + n); }\nf([${D}]);\n`],
  ["a parameter list with a default holding a string with an escaped quote and a parenthesis", `var n = "a.js";\nfunction f(n, q = "\\"(") { return require("../lib/" + n); }\nf(${D});\n`],
  ["a parameter list with a default holding a string with a parenthesis and then an escaped quote", `var n = "a.js";\nfunction f(n, q = "(\\"") { return require("../lib/" + n); }\nf(${D});\n`],
  ["a parameter list with two string defaults, one holding a parenthesis", `var n = "a.js";\nfunction f(n, p = "x", q = "(") { return require("../lib/" + n); }\nf(${D});\n`],
  // The same shapes after code that opened a template or a regular expression earlier in the file.
  ["a string default holding a parenthesis after a template", "var t = `${1}`;\nvar n = \"a.js\";\nfunction f(n, q = \"(\") { return require(\"../lib/\" + n); }\nf(" + D + ");\n"],
  ["a string default holding a parenthesis after a regular expression with a brace", `var r = /}/;\nvar n = "a.js";\nfunction f(n, q = "(") { return require("../lib/" + n); }\nf(${D});\n`],
  ["a string default holding a parenthesis after a keyword regular expression with a bracket", `var r = typeof /(/;\nvar n = "a.js";\nfunction f(n, q = "(") { return require("../lib/" + n); }\nf(${D});\n`],
];
for (const [label, body] of rows) {
  test(`${label} holds the changed docs/evil.js`, () => {
    expect(held(body)).toBe(true);
  });
}

// Shapes that are held today (pins), each next to the rows it differs from by the one thing it names.
const pins: [string, string][] = [
  ["a bare-name load of a name that a function binds with a string default holding a parenthesis", "var n = \"../lib/\" + decodeURIComponent(\"..%2Fdocs%2Fevil.js\");\nfunction g(n, q = \"(\") { return q; }\nrequire(n);\n"],
  ["a bare-name load of a name that an arrow function binds with a string default holding a parenthesis", "var n = \"../lib/\" + decodeURIComponent(\"..%2Fdocs%2Fevil.js\");\nconst g = (n, q = \"(\") => q;\nrequire(n);\n"],
  ["a bare-name load of a name that a class head call binds with a string holding a parenthesis", "var n = \"../lib/\" + decodeURIComponent(\"..%2Fdocs%2Fevil.js\");\nclass A extends mix(n, \"(\") {}\nrequire(n);\n"],
  ["a bare-name resolve of a name that a function binds with a string default holding a parenthesis", "var n = \"../lib/\" + decodeURIComponent(\"..%2Fdocs%2Fevil.js\");\nfunction g(n, q = \"(\") { return q; }\nrequire.resolve(n);\n"],
  ["a bare-name module.require of a name that a function binds with a string default holding a parenthesis", "var n = \"../lib/\" + decodeURIComponent(\"..%2Fdocs%2Fevil.js\");\nfunction g(n, q = \"(\") { return q; }\nmodule.require(n);\n"],
  ["a bare-name import of a name that a function binds with a string default holding a parenthesis", "var n = \"../lib/\" + decodeURIComponent(\"..%2Fdocs%2Fevil.js\");\nfunction g(n, q = \"(\") { return q; }\nimport(n);\n"],
  ["a parameter list with a default that is a string holding a closing parenthesis", `var n = "a.js";\nfunction f(n, q = ")") { return require("../lib/" + n); }\nf(${D});\n`],
  ["a parameter list with a plain default", `var n = "a.js";\nfunction f(n, q = 1) { return require("../lib/" + n); }\nf(${D});\n`],
  ["a parameter list with a string default that holds no bracket", `var n = "a.js";\nfunction f(n, q = "x") { return require("../lib/" + n); }\nf(${D});\n`],
  ["a destructuring with a string default that holds no bracket", `var n = "a.js";\nfunction f(o) { const { n, x = "y" } = o; return require("../lib/" + n); }\nf({ n: ${D} });\n`],
  ["an if condition that holds a string with a parenthesis", `var n = ${D};\nif (n !== "(") { require("../lib/" + n); }\n`],
  ["a load of a constant name", `require("../lib/" + ${D});\n`],
];
for (const [label, body] of pins) {
  test(`pin: ${label} holds the changed docs/evil.js`, () => {
    expect(held(body)).toBe(true);
  });
}

// A literal load of a file the release did not change does not widen to every file, with or without a string default holding a bracket.
for (const [label, body] of [
  ["a parameter list with a string default holding a parenthesis around a literal load", `function f(n, q = "(") { return require("./a.js"); }\nf(1);\n`],
  ["a destructuring with a string default holding a brace around a literal load", `function f(o) { const { n, x = "{" } = o; return require("./a.js"); }\nf({});\n`],
  ["an if condition that holds a string with a parenthesis around a load of a name that holds a literal", `var n = "a.js";\nif (n !== "(") { require("./" + n); }\n`],
] as [string, string][]) {
  test(`pin: ${label} does not hold docs/evil.js`, () => {
    expect(held(body)).toBe(false);
  });
}

// The new reading adds no step to the budget the scan stops at: the smallest scan limit a file passes under does not depend on the string defaults in it.
// A file past the limit is held (a fault); a file the reading of defaults would carry under it must not be released instead.
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
// The scan that reads the defaults must not end earlier than main's does. A load through a parameter that a string default hides (`"("`) is
// widened to every file once the scans after it have run, as a file whose default holds no bracket is (`"x"`: read as before, the scans after it
// are skipped). The first file spends the steps of those scans, so it faults under a limit that the second passes; the widening is not an early
// return that releases a file those scans fault on.
test("a load through a parameter hidden by a string default is held by a scan the later scans fault on", () => {
  allowFaults();
  const file = (q: string) => `var n = "a.js";\nfunction f(n, q = ${q}) { return require("./" + n); }\n` + 'require("./a.js", '.repeat(60) + '"x"' + ")".repeat(60) + ";\n";
  // The nested loads cost about 2,300 steps in the scans after the default's reading; a second read that ended the scan early would spend almost
  // none of them (25 steps more than the file with no bracket).
  expect(passLimit(file('"("')) - passLimit(file('"x"'))).toBeGreaterThan(1500);
  setJsScanSteps(passLimit(file('"("')) - 1);
  const before = scannerFaultCount();
  expect(classifyJs("lib/x.js", file('"("')).all).toBe(true);
  expect(scannerFaultCount() - before).toBe(1);
  setJsScanSteps(undefined);
});

// A scan limit shared by the whole run (prepass): a file the scan faults on is held as `install-script|scanner fault`, and a release that only
// bumps the version, or retargets a nested manifest, is held with it. The second read of a default is not main's reading of the arguments of a run
// call: it must not stop that reading for the run calls after it (it has its own flag and counter), or the file passes under a limit a654acf3 faults
// under, and the release goes through. The limits are inside the window a654acf3 holds this file in (about 74,300 and up to its smallest passing
// limit, 75,475); they move with the step counts of the scans, and the smallest limit this file passes under stays at or above 75,475.
const runCalls = `var cp = require("child_process");\nvar n = "a.js";\nfunction f(n, q = "(") {}\n` + `cp.execSync("node", ["x", function(){ require("./" + n); }]);\n`.repeat(40);
const heldUnder = (limit: number, body: string, nested: boolean): boolean => {
  setJsScanSteps(limit);
  try {
    const rel = (v: string): FileMap =>
      files({
        "package.json": JSON.stringify({ name: "p", version: v, scripts: { postinstall: "node lib/x.js" } }),
        "lib/x.js": body,
        "lib/a.js": "module.exports = 1\n",
        "lib/sub/package.json": JSON.stringify({ name: "s", version: "1.0.0", main: nested && v !== "1.0.0" ? "../../docs/evil.js" : "a.js" }),
        "docs/evil.js": "console.log(1)\n",
      });
    return prepass("npm", rel("1.0.0"), rel("1.0.1")).hard.some((s) => s.kind === "install-script");
  } finally {
    setJsScanSteps(undefined);
  }
};
for (const nested of [false, true]) {
  test(`a file the scan faults on under a limit is held, not released, when the release is ${nested ? "a nested manifest retarget" : "a version bump"}`, () => {
    allowFaults();
    for (const limit of [74300, 74700, 75000, 75400]) expect(heldUnder(limit, runCalls, nested)).toBe(true);
  });
}
