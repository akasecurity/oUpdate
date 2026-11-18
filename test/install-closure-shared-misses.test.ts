import { expect, test } from "bun:test";
import { prepass, type FileMap } from "../src/prepass.ts";

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

// The name of docs/evil.js, spelled so that no literal in the text names it. From lib/x.js a load of "../lib/" + D is docs/evil.js; a command
// "node " + DE run from the package root is docs/evil.js. D is a constant the scan can fold; DE is held by the literal-part scan. S builds the same path at run time from a
// call on a literal that the scan cannot fold: a load or run of "../lib/" + S widens to every file when the scan reads it.
const D = `decodeURIComponent("..%2Fdocs%2Fevil.js")`;
const DE = `decodeURIComponent("docs%2Fevil.js")`;
const S = `"xx../docs/evil.js".slice(2)`;

// Entries that really load or run docs/evil.js and that the release must hold. A row is a miss when the scan does not read the shape.
const holdsRows: [string, string][] = [
  // A load or run in an argument of a call that runs a command: the scan skipped the whole argument list.
  ["a load in the callback of a run call", `${CPX}cp.exec("true", () => require("../lib/" + ${S}));\n`],
  ["a run in the callback of a run call", `${CPX}cp.exec("true", () => cp.execSync("node lib/" + ${S}));\n`],
  ["a load in the callback of a run call with options", `${CPX}cp.execFile("true", [], {}, () => require("../lib/" + ${S}));\n`],
  // A load or a run in an argument that is not a function: an option value, a wrapped call, a getter, a class body, a bound call, a sequence.
  ["a load in an option value of a run call", `${CPX}cp.execSync("true", { input: require("../lib/" + ${S}) });\n`],
  ["a load in the cwd option of a spawn", `${CPX}cp.spawn("true", [], { cwd: require("../lib/" + ${S}) });\n`],
  ["a run in an option value of a run call", `${CPX}cp.exec("true", { env: cp.execSync("node lib/" + ${S}) });\n`],
  ["a load in a call wrapping the callback", `${CPX}const wrap = (x) => x;\ncp.exec("true", {}, wrap(require("../lib/" + ${S})));\n`],
  ["a load in a getter in the options", `${CPX}cp.exec("true", { get cwd() { return require("../lib/" + ${S}); } });\n`],
  ["a load in a class static block in the arguments", `${CPX}cp.exec("true", class { static { require("../lib/" + ${S}); } });\n`],
  ["a run bound with arguments and passed as the callback", `${CPX}cp.exec("true", cp.execSync.bind(cp, "node lib/" + ${S}, {}));\n`],
  ["a load in a sequence in an option value", `${CPX}cp.exec("true", { cwd: (require("../lib/" + ${S}), ".") });\n`],
  // A callback written with the function keyword.
  ["a load in a function-keyword callback of a run call", `${CPX}cp.exec("true", function () { require("../lib/" + ${S}); });\n`],
  ["a run in a function-keyword callback of a run call", `${CPX}cp.exec("true", function () { cp.execSync("node lib/" + ${S}); });\n`],
];
for (const [label, body] of holdsRows) {
  test(`${label} holds the changed docs/evil.js`, () => {
    expect(held(body)).toBe(true);
  });
}

// Shapes that are held today (pins), each next to the rows it differs from by the one thing it names.
const pins: [string, string][] = [
  ["a chain variable read inside a run call and again after it at a deeper depth", "const cp = require(\"child_process\");\nconst v0 = \"true\";\nconst v1 = ((((((v0))))));\ncp.exec(\"true\", () => cp.exec(v1));\ncp.exec((((v1))));\n"],
  ["a path.resolve chain read inside a run call and again after it at a deeper depth", "const cp = require(\"child_process\");\nconst path = require(\"path\");\nconst p1 = path.resolve(\"a\");\nconst p2 = path.resolve(p1, \"b\");\nconst p3 = path.resolve(p2, \"c\");\nconst p4 = path.resolve(p3, \"d\");\ncp.exec(\"true\", () => cp.execFile(p4));\ncp.execFile(path.resolve(p4, \"e\"));\n"],
  ["a regex opened before the run call that encloses its argument list, a brace in the list", "const cp = require(\"child_process\");\n`${void /(cp.exec(\"true\", { ))/}`;\ncp.exec(zz);\n`${1}`;\n"],
  ["the same with the payload run below the template", "const cp = require(\"child_process\");\nconst cmd = \"node xxdocs/evil.js\".replace(\"xx\", \"\");\n`${void /(cp.exec(\"true\", { ))/}`;\ncp.exec(cmd);\n`${1}`;\n"],
  ["a division after x++ with the closing brace on a later line", "const cp = require(\"child_process\");\nlet x = 1;\n`${cp.exec(\"true\", () => x++ / 2)\n}`;\nvar s = `${1}exec(zz)`;\n"],
  ["a division after x++ with a carriage return", "const cp = require(\"child_process\");\nlet x = 1;\n`${cp.exec(\"true\", () => x++ / 2)\r\n}`;\r\nvar s = `${1}exec(zz)`;\r\n"],
  ["a division after x-- with the closing brace on a later line", "const cp = require(\"child_process\");\nlet x = 1;\n`${cp.exec(\"true\", () => x-- / 2)\n}`;\nvar s = `${1}exec(zz)`;\n"],
  ["a division after x-- with a carriage return", "const cp = require(\"child_process\");\nlet x = 1;\n`${cp.exec(\"true\", () => x-- / 2)\r\n}`;\r\nvar s = `${1}exec(zz)`;\r\n"],
  ["a division after an empty block with the closing brace on a later line", "const cp = require(\"child_process\");\nlet x = 1;\n`${cp.exec(\"true\", () => 1 + {} / 2)\n}`;\nvar s = `${1}exec(zz)`;\n"],
  ["a division after an empty block with a carriage return", "const cp = require(\"child_process\");\nlet x = 1;\n`${cp.exec(\"true\", () => 1 + {} / 2)\r\n}`;\r\nvar s = `${1}exec(zz)`;\r\n"],
  ["a keyword-like word: a ?. before a regex", "const cp = require(\"child_process\");\n`${cp.exec(\"true\", () => a?./}/ / 1, require(\"../lib/\" + \"xx../docs/evil.js\".slice(2)))}`;\n"],
  ["a regex after a division slash", "const cp = require(\"child_process\");\n`${cp.exec(\"true\", () => 1 / /}/ / 1, require(\"../lib/\" + \"xx../docs/evil.js\".slice(2)))}`;\n"],
  ["a regex after a division slash, two", "const cp = require(\"child_process\");\n`${cp.exec(\"true\", () => 2 / /}/ / 1, require(\"../lib/\" + \"xx../docs/evil.js\".slice(2)))}`;\n"],
  ["a regex after a name and a division slash", "const cp = require(\"child_process\");\n`${cp.exec(\"true\", () => x / /}/ / 1, require(\"../lib/\" + \"xx../docs/evil.js\".slice(2)))}`;\n"],
  ["void and a no-break space before a regex holding a brace", "const cp = require(\"child_process\");\n`${cp.exec(\"true\", () => void\u00A0/}/ / 1, require(\"../lib/\" + \"xx../docs/evil.js\".slice(2)))}`;\n"],
  ["void and U+2028 before a regex holding a brace", "const cp = require(\"child_process\");\n`${cp.exec(\"true\", () => void\u2028/}/ / 1, require(\"../lib/\" + \"xx../docs/evil.js\".slice(2)))}`;\n"],
  ["void and U+2029 before a regex holding a brace", "const cp = require(\"child_process\");\n`${cp.exec(\"true\", () => void\u2029/}/ / 1, require(\"../lib/\" + \"xx../docs/evil.js\".slice(2)))}`;\n"],
  ["void and a byte order mark before a regex holding a brace", "const cp = require(\"child_process\");\n`${cp.exec(\"true\", () => void\uFEFF/}/ / 1, require(\"../lib/\" + \"xx../docs/evil.js\".slice(2)))}`;\n"],
  ["a regex after a division slash with ++", "const cp = require(\"child_process\");\n`${cp.exec(\"true\", () => x++ / /}/ / 1, require(\"../lib/\" + \"xx../docs/evil.js\".slice(2)))}`;\n"],
  ["a line comment between a keyword and a regex", "const cp = require(\"child_process\");\n`${cp.exec(\"true\", () => void // c\n/}/ / 1, require(\"../lib/\" + \"xx../docs/evil.js\".slice(2)))}`;\n"],
  ["a block comment before a regex", "const cp = require(\"child_process\");\n`${cp.exec(\"true\", () => void /* c */ /}/ / 1, require(\"../lib/\" + \"xx../docs/evil.js\".slice(2)))}`;\n"],
  ["a spread before a regex holding a brace, in a callback inside a template", "const cp = require(\"child_process\");\n`${cp.exec(\"true\", () => [.../}/ / 1], require(\"../lib/\" + \"xx../docs/evil.js\".slice(2)))}`;\n"],
  ["a spread before a regex holding a brace, in a callback with no template", "const cp = require(\"child_process\");\n(x => { cp.exec(\"true\", () => [.../}/ / 1]); })(1);\n"],
  // A slash after a keyword that closeAt and the scan read as division, over a regex that holds a bracket: closeAt ends early, so the old step
  // holds these on main by accident and they must stay held.
  ["a keyword regex void /}/ in a callback inside a template", "const cp = require(\"child_process\");\n`${cp.exec(\"true\", () => void /}/ / 1, require(\"../lib/\" + \"xx../docs/evil.js\".slice(2)))}`;\n"],
  ["a keyword regex void /}/ in a callback with no template", "const cp = require(\"child_process\");\n(x => { cp.exec(\"true\", () => void /}/ / 1); })(1);\n"],
  ["a keyword regex return /}/ in a block callback", "const cp = require(\"child_process\");\nconst t = `${cp.exec(\"t\", s => {\n return /}/.test(s)\n}, require(\"../lib/\" + \"xx../docs/evil.js\".slice(2)))}`;\n"],
  ["a keyword regex typeof /}/ in a block callback", "const cp = require(\"child_process\");\nconst t = `${cp.exec(\"t\", s => {\n return typeof /}/\n}, require(\"../lib/\" + \"xx../docs/evil.js\".slice(2)))}`;\n"],
  ["a keyword regex void /}/ in a block callback", "const cp = require(\"child_process\");\nconst t = `${cp.exec(\"t\", s => {\n return void /}/\n}, require(\"../lib/\" + \"xx../docs/evil.js\".slice(2)))}`;\n"],
  // A template in the arguments of a run call keeps the step over the whole list (main's read: closeAt ends a template at its first backtick, so
  // these are held on main by the jump and must stay held).
  ["a run call whose callback holds a template with a backtick in a substitution", "const cp = require(\"child_process\");\ncp.exec(\"true\", () => `${\"`\"+\")\"}`, \"x\");var s = \"exec(zz)\";\n"],
  ["a template with a nested template inside an arrow function", "const cp = require(\"child_process\");\n(x => { cp.exec(\"true\", () => `${`)${1}`}`); })(1);\n"],
  ["a load outside a callback", `${CPX}cp.exec("true");\nrequire("../lib/" + ${S});\n`],
  ["a run through a name bound to the run function", `${CPX}const run = cp.execSync;\nrun("node " + ${DE});\n`],
  ["a load of a constant name", `require("../lib/" + ${D});\n`],
];
for (const [label, body] of pins) {
  test(`pin: ${label} holds the changed docs/evil.js`, () => {
    expect(held(body)).toBe(true);
  });
}


// A callback that loads a literal file the release did not change does not widen to every file.
for (const [label, body] of [
  ["a callback that loads a literal file", `${CPX}cp.exec("true", () => require("./a.js"));\n`],
  ["a run call with no callback and a literal command", `${CPX}cp.execSync("true");\n`],
] as [string, string][]) {
  test(`pin: ${label} does not hold docs/evil.js`, () => {
    expect(held(body)).toBe(false);
  });
}
