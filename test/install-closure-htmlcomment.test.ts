import { expect, test } from "bun:test";
import { classifyJs, hasUnbounded, processHazard, provablyStatic } from "../src/install-closure.ts";

// A CommonJS file is a sloppy script: node reads `<!--` as a comment to the end of the line anywhere, and `-->` as one at the start of a
// line (after only whitespace or comments). An ES module reads both as operators. The scanner cannot tell the two apart from the text,
// so a file with either outside a string, template, regular expression or comment is read both ways at once: it widens to every file.
const RUN = `.execSync("echo REACHED",{stdio:"inherit"})`;
const JC = `["child_","pro","cess"].join("")`;
const LOAD = `arguments[1](${JC})${RUN}`;
const M = "const m = () => 0;";
const BLOCK = `{ m(1)\n{ ${LOAD} } }`;
const all = (src: string, key = "pkg/lib/x.js") => classifyJs(key, src).all;

// Every row below was run under node as a CommonJS file: the loader reads the module wrapper's arguments and runs the payload.
const reaches: [string, string][] = [
  ["a line-start --> comment hides the load that follows", `0\n--> x\n${LOAD}`],
  ["a <!-- comment after code hides the load on the next line", `0; <!-- x\n${LOAD}`],
  ["--> with CRLF line ends", `0\r\n--> x\r\n${LOAD}`],
  ["--> after a line separator", `0\u2028--> x\u2028${LOAD}`],
  ["--> after a paragraph separator", `0\u2029--> x\u2029${LOAD}`],
  ["--> after a block comment at line start", `0\n/* c */ --> x\n${LOAD}`],
  ["--> after a block comment that ends the previous line", `0 /*\n*/ --> x\n${LOAD}`],
  ["--> indented", `0\n   \t--> x\n${LOAD}`],
  ["<!-- with CRLF line ends", `0; <!-- x\r\n${LOAD}`],
  ["<!-- at the very start", `<!-- x\n${LOAD}`],
  ["--> at the very start", `--> x\n${LOAD}`],
  ["--> then the call on a block line", `${M}\n--> x\n${BLOCK}`],
  ["--> = then the call on a block line", `${M}\n--> =\n${BLOCK}`],
  ["<!-- < then the call on a block line", `${M} <!-- <\n${BLOCK}`],
  ["<!-- = then the call on a block line", `${M} <!-- =\n${BLOCK}`],
  ["<!-- after a string", `"a"; <!-- x\n${LOAD}`],
  ["<!-- after a regular expression", `/a/g; <!-- x\n${LOAD}`],
  ["<!-- after a template", "`a`; <!-- x\n" + LOAD],
  // A / the scan cannot settle as a regular expression or a division must not end the check for the comment.
  ["<!-- after a regular expression that follows an if", `if (true) /a/ <!-- x\n${LOAD}`],
  ["--> after a regular expression that follows an if", `if (true) /a/\n--> x\n${LOAD}`],
  ["<!-- after a regular expression that follows a while", `while (false) /a/ <!-- x\n${LOAD}`],
  ["<!-- after a regular expression that follows a for", `for (;false;) /a/ <!-- x\n${LOAD}`],
  ["<!-- after a regular expression that follows a block", `{ }\n/a/ <!-- x\n${LOAD}`],
  ["<!-- after a regular expression with a bracketed slash", `var r = /[/]/ <!-- x\n${LOAD}`],
  ["<!-- after a division by a parenthesis", `var a = 4, b = 2; (a) / b <!-- x\n${LOAD}`],
  ["--> after a division by a parenthesis", `var a = 4, b = 2; (a) / b\n--> x\n${LOAD}`],
  ["<!-- after a division of a bracket", `var a = [4], b = 2; a[0] / b <!-- x\n${LOAD}`],
  ["--> after a division of a bracket", `var a = [4], b = 2; a[0] / b\n--> x\n${LOAD}`],
  ["<!-- after a division of a braced expression", `({}) / 2 <!-- x\n${LOAD}`],
  ["<!-- after a division of an increment", `var a = 4; a++ / 2 <!-- x\n${LOAD}`],
  ["<!-- after a plain division", `var a = 4, b = 2; a / b <!-- x\n${LOAD}`],
  ["--> after a plain division", `var a = 4, b = 2; a / b\n--> x\n${LOAD}`],
  // The scan reads a / as a regular expression where node reads a division: a <!-- inside the scan's "regular expression" is a comment
  // opener, and the template the line then closes with a backtick would hide the load.
  ["<!-- after a function expression and a division, a backtick on the comment line", "const x = function(){}\n/ 1 <!-- / + `\n" + LOAD + "\n--> `"],
  ["<!-- after a class expression and a division, a backtick on the comment line", "const x = class {}\n/ 1 <!-- / + `\n" + LOAD + "\n--> `"],
  ["<!-- after an object and a division, a backtick on the comment line", "const x = {}\n/ 1 <!-- / + `\n" + LOAD + "\n--> `"],
  ["<!-- after an increment and a division, a backtick on the comment line", "var a = 1; a++ / 1 <!-- / + `\n" + LOAD + "\n--> `"],
  ["<!-- after a parenthesis and a division, a backtick on the comment line", "(1) / 1 <!-- / + `\n" + LOAD + "\n--> `"],
  // A string may hold a line or paragraph separator (ES2019) and may continue over a CRLF.
  ["<!-- after a string holding a line separator, a backtick on the comment line", "const s = \"a\u2028\"; <!-- `\n" + LOAD + "\n--> `"],
  ["<!-- after a string holding a paragraph separator, a backtick on the comment line", "const s = \"a\u2029\"; <!-- `\n" + LOAD + "\n--> `"],
  ["<!-- after a string continued over a CRLF, a backtick on the comment line", "const s = \"a\\\r\nb\"; <!-- `\n" + LOAD + "\n--> `"],
  ["the load after a string holding a line separator, no comment", `const s = "a\u2028";\n${LOAD}`],
  ["the load after a division the scan cannot settle, no comment", `var a = 1; (0)/a/1\n${LOAD}`],
  ["<!-- after a division the scan cannot settle, a backtick on the comment line", "var a = 1; (0)/a/1\n<!-- `\n" + LOAD + "\n--> `"],
  // A non-ASCII name ends at a line separator: the --> that starts the next line is a comment and its backtick opens nothing.
  ["--> after a non-ASCII name and a line separator, a backtick on the comment line", "var é\u2028--> `\n" + LOAD + "\n--> `"],
  ["--> after a non-ASCII name and a paragraph separator, a backtick on the comment line", "var é\u2029--> `\n" + LOAD + "\n--> `"],
  ["--> after a non-ASCII name and a no-break space, then a line feed", "var é\u00a0\n--> `\n" + LOAD + "\n--> `"],
];

for (const [name, src] of reaches) {
  test(`${name}: the file widens to every file`, () => {
    expect(all(src)).toBe(true);
  });
}

test("an .mjs file with the same text widens too, since a module reads the tail of the line as code", () => {
  expect(all(`const b = 1; 0 <!--b; ${LOAD}`, "pkg/lib/x.mjs")).toBe(true);
  expect(all(`0\n--> x\n${LOAD}`, "pkg/lib/x.mjs")).toBe(true);
  expect(all(`0; <!-- x\n${LOAD}`, "pkg/lib/x.cjs")).toBe(true);
});

test("processHazard and hasUnbounded read the same file as a hazard", () => {
  const src = `0; <!-- x\n${LOAD}`;
  expect(processHazard(src)).toBe(true);
  expect(hasUnbounded(src, src)).toBe(true);
});

test("a file and inline node -e code take the same path: not provably static, then classifyJs decides", () => {
  for (const src of [`0; <!-- x\n${LOAD}`, `if (true) /a/ <!-- x\n${LOAD}`, `var a = 1; (0)/a/1\n${LOAD}`]) {
    expect(provablyStatic(src)).toBe(false);
    expect(all(src, "-e")).toBe(true);
    expect(all(src, "pkg/scripts/x.js")).toBe(true);
  }
});

test("the plain call without a comment widens, as before", () => {
  expect(all(LOAD)).toBe(true);
});

// Controls: none of these holds a comment node reads, so each stays as it was.
const quiet: [string, string][] = [
  ["a benign file", "module.exports = 1;"],
  ["<!-- inside a string", `const s = "<!--"; module.exports = s;`],
  ["--> inside a single-quoted string at line start of the text", `const s = '\\\n--> x'; module.exports = s;`],
  ["<!-- inside a template", "const s = `<!-- ${1}\n--> x`; module.exports = s;"],
  ["<!-- inside a regular expression", "const r = /<!--/; module.exports = r;"],
  ["--> inside a regular expression on its own line", "const r =\n/-->/;\nmodule.exports = r;"],
  ["x --> 0 in the middle of a line is a decrement and a comparison", "let x = 3; while (x --> 0) {}\nmodule.exports = x;"],
  ["--> after code on the same line is not a comment", "let x = 3; x --> 0;\nmodule.exports = x;"],
  ["<!-- inside a line comment", "// <!-- x\nmodule.exports = 1;"],
  ["<!-- inside a block comment", "/* <!-- */ module.exports = 1;"],
  ["--> inside a block comment", "/*\n--> x\n*/ module.exports = 1;"],
  ["--> inside a line comment", "// x\n// --> y\nmodule.exports = 1;"],
  ["a hashbang line", "#!/usr/bin/env node\nmodule.exports = 1;"],
  ["a regular expression after an if, no comment", `if (true) /a/.test("a");\nmodule.exports = 1;`],
  ["a division by a parenthesis, no comment", "var a = 4, b = 2; (a) / b;\nmodule.exports = a;"],
  ["a string holding <!-- after a division", `var a = 4, b = 2; (a) / b; var s = "<!--";\nmodule.exports = s;`],
  ["a string holding --> at a line start after an if and a regular expression", `if (true) /a/.test("\\\n--> x");\nmodule.exports = 1;`],
  ["a string holding a line separator", `const s = "a\u2028b";\nmodule.exports = s;`],
  ["a string continued over a CRLF", `const s = "a\\\r\nb";\nmodule.exports = s;`],
  ["a non-ASCII name", `const é = 1; module.exports = é;`],
];

for (const [name, src] of quiet) {
  test(`control, ${name}: still not widened`, () => {
    expect(all(src)).toBe(false);
    expect(all(src, "pkg/lib/x.mjs")).toBe(false);
  });
}

test("a <!-- inside a regular expression the scan cannot settle widens: the known cost of testing the raw text", () => {
  expect(all(`if (true) /<!--/.test("a");\nmodule.exports = 1;`)).toBe(true);
});

test("a benign file with a real <!-- or line-start --> comment widens: the known cost", () => {
  expect(all("module.exports = 1; <!-- note")).toBe(true);
  expect(all("module.exports = 1;\n--> note")).toBe(true);
});
