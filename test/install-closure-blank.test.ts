import { expect, test } from "bun:test";
import { classifyJs, processHazard, provablyStatic } from "../src/install-closure.ts";

// A file with a long run of blank lines must read in linear time. The strict-file check looked for an import or export
// declaration at the start of a line with a pattern whose whitespace part swallowed the rest of the run at every line break.

const B = "function f(){ return this } const g = f(); console.log(typeof g)\n";

// Verdicts recorded from the previous reader: a declaration at a line start makes the file strict, so a sloppy this is harmless.
const ROWS: [string, string, boolean][] = [
  ["plain", B, false],
  ["export after blanks", "\n\n\nexport const x = 1;\n" + B, true],
  ["export after spaces", "   \n \t\n  export const x = 1;\n" + B, true],
  ["import after crlf", "\r\n\r\n\r\nimport x from 'y';\n" + B, true],
  ["import at start", "import x from 'y';\n" + B, true],
  ["export at start", "export default 1;\n" + B, true],
  ["blank run then a statement", "var a = 1;\n" + "\n".repeat(50) + B, false],
  ["dotted import after blanks", "const o = {}; o.\n\n\n\nimport\nx = 1;\n" + B, false],
  ["dotted export then a real import", "const o = {}; o.\n\nexport\nconst k = 1;\n\n\nimport z from 'q';\n" + B, true],
  ["import word glued", "\n\nimporter = 1;\n" + B, false],
  ["export in a line after code", "var a = 1; export const x = 1;\n" + B, false],
  ["blanks between statements and an export", "a = 1;\n\n  \n\t\n\nexport function f() {}\n" + B, true],
  ["two blank runs then an import", "a = 1;\n\n\n\nb = 2;\n\n\n\nimport q from 'r';\n" + B, true],
  ["dotted import then a glued export line", "const o = {}; o.\nimport\nexport default x;\n" + B, false],
  ["import then a newline and a word", "import\nx from 'y';\n" + B, true],
  ["import with crlf lines", "a = 1;\r\n\r\nimport {x} from 'y';\r\n" + B, true],
  ["export star after a bare cr", "a = 1;\r\rexport * from 'y';\n" + B, false],
  ["export after a tab line", "a = 1;\n\t\t\n\texport {};\n" + B, true],
  ["export async", "\n\nexport async function f() {}\n" + B, true],
  ["a directive then blanks", '"use strict";\n\n\n' + B, true],
];
for (const [name, src, expected] of ROWS) {
  test(`strict verdict: ${name}`, () => {
    expect(provablyStatic(src)).toBe(expected);
    expect(processHazard(src)).toBe(!expected);
  });
}

// 8 MB of one kind of whitespace after a readable statement, and the same behind a declaration.
const SHAPES: [string, (n: number) => string][] = [
  ["blank lines", (n) => "var a=1;\n" + "\n".repeat(n)],
  ["crlf lines", (n) => "var a=1;\r\n" + "\r\n".repeat(n / 2)],
  ["space and newline", (n) => "var a=1;\n" + " \n".repeat(n / 2)],
  ["tab and newline", (n) => "var a=1;\n" + "\t\n".repeat(n / 2)],
  ["bare carriage returns", (n) => "var a=1;\r" + "\r".repeat(n)],
  ["spaces", (n) => "var a=1;\n" + " ".repeat(n)],
  ["tabs", (n) => "var a=1;\n" + "\t".repeat(n)],
  ["blank lines between words", (n) => "a\n" + "\n".repeat(n) + "b"],
  ["blank lines then an import", (n) => "var a=1;\n" + "\n".repeat(n) + "import x from 'y';\n"],
  ["blank lines behind a dotted import", (n) => "o.\nimport\n" + "\n".repeat(n) + "x = 1;\n"],
];
const MB = 8 * 1024 * 1024;
for (const [name, mk] of SHAPES) {
  test(`8 MB of ${name} reads in linear time`, () => {
    const src = mk(MB);
    const t0 = performance.now();
    provablyStatic(src);
    const t1 = performance.now();
    classifyJs("pkg/lib/x.js", src);
    const t2 = performance.now();
    expect(t1 - t0).toBeLessThan(5000);
    expect(t2 - t1).toBeLessThan(5000);
  }, 30000);
}

// Small enough to run on the quadratic reader too, so this fails there: 64 KiB of blank lines took seconds.
test("64 KiB of blank lines is read in well under a second", () => {
  const src = "var a=1;\n" + "\n".repeat(64 * 1024);
  const t0 = performance.now();
  provablyStatic(src);
  expect(performance.now() - t0).toBeLessThan(1000);
}, 60000);
test("64 KiB of CRLF blank lines is read in well under a second", () => {
  const src = "var a=1;\r\n" + "\r\n".repeat(32 * 1024);
  const t0 = performance.now();
  provablyStatic(src);
  expect(performance.now() - t0).toBeLessThan(1000);
}, 60000);
