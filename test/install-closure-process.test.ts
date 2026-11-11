import { expect, test } from "bun:test";
import { prepass, type FileMap } from "../src/prepass.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const files = (o: Record<string, string>): FileMap => new Map(Object.entries(o).map(([k, v]) => [k, enc(v)]));
const holds = (old: FileMap, now: FileMap) => prepass("npm", old, now).hard.filter((s) => s.kind === "install-script").map((s) => s.detail);

// prisma 7.10.1: an unchanged preinstall whose only builtin is node:process took every file of the package as its closure.
// Its bundled ANSI code holds a RegExp exec whose argument has a "+", which the process-runner check read as a computed command.
const ansi = 'exports.code = (D, f) => { let d = /\\d[^m]*/.exec(D.slice(f, f + 18)); return d && d.length > 0 ? d[0] : "" }\n';
const release = (v: string, preinstall: string) =>
  files({
    "package.json": JSON.stringify({ name: "cli", version: v, bin: { cli: "build/index.js" }, scripts: { preinstall: "node scripts/preinstall-entry.js" } }),
    "scripts/preinstall-entry.js": "let p\ntry { p = require('../preinstall/index.js') } catch (e) {}\nif (p) p.main()\n",
    "preinstall/index.js": preinstall,
    "build/index.js": `console.log("cli ${v}")\n`,
    "build/engine_bg.wasm": `wasm ${v}`,
  });

test("a hook whose static require graph needs only node:process keeps that graph: changed build files are not install changes", () => {
  const pre = 'var v = require("node:process"); exports.main = () => { if (v.versions.node < "18") v.exit(1) }\n' + ansi;
  expect(holds(release("1.0.0", pre), release("1.0.1", pre))).toEqual([]);
});

test("the same hook with an eval of a computed value still takes the wide closure, so the changed build files hold", () => {
  const pre = 'var v = require("node:process"); exports.main = () => eval(v.env.X)\n';
  expect(holds(release("1.0.0", pre), release("1.0.1", pre)).length).toBeGreaterThan(0);
});

test("a changed file in the static graph still holds", () => {
  const pre = (n: string) => `var v = require("node:process"); exports.main = () => v.exit(${n})\n` + ansi;
  expect(holds(release("1.0.0", pre("0")), release("1.0.1", pre("1")))).toEqual(["file preinstall/index.js"]);
});

// A name for the process module used for more than plain reads can load code the reviewer never sees: the changed build files hold.
// Not static means the hook's own directory is in the closure: an unrelated file changed there holds, which a static graph does not.
const held = (pre: string) => {
  const rel = (v: string) => release(v, pre).set("preinstall/other.js", enc(`module.exports = "${v}"\n`));
  return holds(rel("1.0.0"), rel("1.0.1")).length > 0;
};
for (const [label, pre] of [
  ["a required process module calling binding", 'var v = require("node:process"); exports.main = () => v.binding("spawn_sync").spawn({})\n'],
  ["require(process).binding without a name for it", 'exports.main = () => require("process").binding("spawn_sync")\n'],
  ["a named import of binding from node:process", 'import { binding } from "node:process"; export const main = () => binding("spawn_sync")\n'],
  ["a computed member on a required process module", 'const p = require("process"); exports.main = () => p["bind"+"ing"]("spawn_sync")\n'],
  ["the process module passed to another call", 'const p = require("process"); exports.main = () => run(p)\n'],
] as const) {
  test(`${label} is not static: its directory is in the closure`, () => expect(held(pre)).toBe(true));
}
test("plain reads through a required process module stay static", () => {
  const pre = 'const v = require("node:process"); exports.main = () => { if (v.versions.node < "18") v.stderr.write("old"); return v.cwd() }\n';
  expect(held(pre)).toBe(false);
});

// Node resolves a path as a file first and as a directory second: both are in the closure.
test("a path that reads as helper.js and as helper/index.js has both in the closure", () => {
  const pre = 'var v = require("node:process"); require("./helper"); exports.main = () => v.exit(0)\n';
  const rel = (v: string, helper: string) => release(v, pre).set("preinstall/helper.js", enc(helper)).set("preinstall/helper/package.json", enc('{"main":"index.js"}')).set("preinstall/helper/index.js", enc("module.exports = 1\n"));
  expect(holds(rel("1.0.0", "module.exports = 1\n"), rel("1.0.1", "module.exports = 2\n"))).toContain("file preinstall/helper.js");
});

// A string literal with an escape names the file the escape spells.
test("a require with an escaped path is followed to the file it names", () => {
  const pre = 'var v = require("node:process"); require("./\\x65vil.js"); exports.main = () => v.exit(0)\n';
  const rel = (v: string, evil: string) => release(v, pre).set("preinstall/evil.js", enc(evil));
  expect(holds(rel("1.0.0", "module.exports = 1\n"), rel("1.0.1", "module.exports = 2\n"))).toContain("file preinstall/evil.js");
});

// A name that starts with $ or holds an escape or non-ASCII character is still a name for the process module.
const via = (decl: string, use: string) => `${decl}\nexports.main = () => ${use}\n`;
const run = "('../build/evil.js')";
for (const [label, pre] of [
  ["a $ name for the process module used to reach the loader", via("const $p = require('process');", `$p['getBuiltinModule']('mo'+'dule')['createRequire'](__filename)${run}`)],
  ["a name after a $ prefix inside another word", via("const a$p = require('process');", `a$p['getBuiltinModule']('mo'+'dule')['createRequire'](__filename)${run}`)],
  ["a let name with $ used as a value", via("let $ = require('node:process');", "run($)")],
  ["a var name with an underscore and $ passed on", via("var _$ = require('process');", "run(_$)")],
  ["a non-ASCII name used as a value", via("const é = require('process');", "run(é)")],
  ["a unicode escape in the name", via("const \\u0070 = require('process');", `p['getBuiltinModule']('mo'+'dule')['createRequire'](__filename)${run}`)],
  ["a destructured getBuiltinModule", via("const { getBuiltinModule: g } = require('process');", `g('module').createRequire(__filename)${run}`)],
  ["an escaped process specifier", via("const p = require('node:\\x70rocess');", `p.getBuiltinModule('mo'+'dule').createRequire(__filename)${run}`)],
  ["an escaped process specifier with a unicode escape", via("const p = require('\\u0070rocess');", `p.getBuiltinModule('mo'+'dule').createRequire(__filename)${run}`)],
  ["an escaped process specifier with a code point escape", via("const p = require('node:\\u{70}rocess');", `p.getBuiltinModule('mo'+'dule').createRequire(__filename)${run}`)],
  ["an escaped process specifier in an import", "import p from 'node:\\x70rocess';\nexport const main = () => p.getBuiltinModule('mo'+'dule').createRequire(import.meta.url)('../build/evil.js')\n"],
  ["a template-literal process specifier", via("const p = require(`process`);", `p.getBuiltinModule('mo'+'dule').createRequire(__filename)${run}`)],
] as const) {
  test(`${label} is not static`, () => expect(held(pre)).toBe(true));
}
test("a $ name for the process module used for plain reads stays static", () => {
  expect(held(via("const $p = require('process');", "$p.env.HOME")  )).toBe(false);
});
test("an escaped specifier for a builtin that is static stays static", () => {
  expect(held(via("const fs = require('\\x66s');", "fs.existsSync('x')"))).toBe(false);
});

// Round 2: the alias must be a whole statement, and escapes must not hide a name or a load.
const rd = "require('fs').readFileSync(__dirname + '/../build/payload.js', 'utf8')";
for (const [label, pre] of [
  ["a process load followed by a member call on the same statement", `const r = require("process").getBuiltinModule("v"+"m").runInThisContext(${rd})\nexports.main = () => 1\n`],
  ["a process load followed by binding", 'const x = require("process").binding("spawn_sync").spawn({})\nexports.main = () => 1\n'],
  ["a process load followed by a computed member", 'const x = require("process")["bind"+"ing"]("spawn_sync")\nexports.main = () => 1\n'],
  ["a process load whose member access is on the next line", 'const x = require("process");\n.binding("spawn_sync")\nexports.main = () => 1\n'],
  ["a process load without a semicolon followed by a member on the next line", 'const x = require("process")\n.binding("spawn_sync")\nexports.main = () => 1\n'],
  ["a process load without a semicolon followed by a bracket on the next line", 'const x = require("process")\n["binding"]("spawn_sync")\nexports.main = () => 1\n'],
  ["a process load followed by a call", 'const x = require("process")(1)\nexports.main = () => 1\n'],
  ["a p$ name used for binding", via("const p$ = require('process');", "p$.binding('spawn_sync')")],
  ["an escaped child_process", via("const c = require('\\x63hild_process');", "c.execSync('node build/index.js')")],
  ["an escaped process with binding", `exports.main = () => require("pro\\x63ess").binding("spawn_sync")\n`],
  ["an escaped node:module", `exports.main = () => require("node:\\x6dodule")._load("../build/payload.js")\n`],
  ["a unicode-escaped vm", `exports.main = () => require("\\u0076m").runInThisContext(${rd})\n`],
  ["an escaped alias identifier", `const p = require("process"); exports.main = () => \\u0070.binding("spawn_sync")\n`],
  ["an escaped require identifier", `exports.main = () => \\u0072equire("../build/payload.js")\n`],
  ["an escaped eval identifier", `exports.main = () => \\u0065val(${rd})\n`],
] as const) {
  test(`${label} is not static (round 2)`, () => expect(held(pre)).toBe(true));
}
test("an alias statement ending in a semicolon or a newline stays static", () => {
  expect(held('const p = require("process");\nconst q = require("node:process")\nexports.main = () => p.cwd() + q.platform\n')).toBe(false);
});
test("a backslash inside a string that is not an identifier does not make the file not static", () => {
  expect(held('const p = require("process"); exports.main = () => p.cwd() + "a\\u0041b"\n')).toBe(false);
});

// Round 3: a backslash or a non-ASCII character in code makes the file not static; text in strings and comments does not.
for (const [label, pre] of [
  ["a computed getBuiltinModule member on an alias", `const p = require("process"); exports.main = () => p["getBuiltinModule"]("mo"+"dule")["createRequire"](__filename)("../build/evil.js")\n`],
  ["a no-break space before the use", `const p = require("process");\u00a0exports.main = () => p["bind"+"ing"]("spawn_sync")\n`],
  ["a line separator before the use", `const p = require("process");\u2028exports.main = () => p["bind"+"ing"]("spawn_sync")\n`],
  ["a braced code point escape for the name", `const p = require("process"); \\u{70}.getBuiltinModule("child_"+"process")\n`],
  ["an escaped name in a template expression", "const p = require(\"process\"); exports.main = () => `${\\u0070.binding('spawn_sync')}`\n"],
  ["a non-ASCII name", `const é = 1; const p = require("process"); exports.main = () => run(é)\n`],
] as const) {
  test(`${label} is not static (round 3)`, () => expect(held(pre)).toBe(true));
}
test("non-ASCII text and escapes inside strings, comments and regular expressions stay static", () => {
  expect(held('// Zoë \\u0041\n/* é */ const p = require("process");\nconst re = /[\\u0000-\\u001f"\']/;\nexports.main = () => "é\\u0041" + `ü ${p.cwd()} é` + p.platform + re.test("x") + (1 / 2) / 3\n')).toBe(false);
});
test("an unterminated string makes the file not static", () => {
  expect(held('const p = require("process"); exports.main = () => "oops\n')).toBe(true);
});

// Node's require tries X, X.js, X.json and X.node before the directory, never X.cjs: a changed helper/index.js is loaded.
test("an unchanged helper.cjs beside a changed helper/index.js: the directory index is in the closure", () => {
  const pre = 'var v = require("node:process"); require("./helper"); exports.main = () => v.exit(0)\n';
  const rel = (v: string, idx: string) => release(v, pre).set("preinstall/helper.cjs", enc("module.exports = 1\n")).set("preinstall/helper/index.js", enc(idx));
  expect(holds(rel("1.0.0", "module.exports = 1\n"), rel("1.0.1", "module.exports = 2\n"))).toContain("file preinstall/helper/index.js");
});

// Round 4: a / after } or ) read both ways, and every line terminator ends a line comment.
for (const [label, pre] of [
  ["a division after } that would read as a regex body hiding the use", 'const p = require("process"); const n = {} / p.binding("spawn_sync") / 1;\nexports.main = () => n\n'],
  ["a division after ) that would read as a regex body hiding the use", 'const p = require("process"); const n = (1) / p.binding("spawn_sync") / 1;\nexports.main = () => n\n'],
  ["a line comment ended by a carriage return", 'const p = require("process"); // comment\rp.binding("spawn_sync");\nexports.main = () => 1\n'],
  ["a line comment ended by U+2028", 'const p = require("process"); // comment\u2028p.binding("spawn_sync");\nexports.main = () => 1\n'],
  ["a line comment ended by U+2029", 'const p = require("process"); // comment\u2029p.binding("spawn_sync");\nexports.main = () => 1\n'],
  ["a regex after a keyword that holds a quote", 'const p = require("process"); exports.main = () => { return /\'/.test(1) + p.binding("spawn_sync") + \'\' }\n'],
] as const) {
  test(`${label} is not static (round 4)`, () => expect(held(pre)).toBe(true));
}
test("ordinary divisions and regexes after ) and } stay static", () => {
  expect(held('const p = require("process"); const a = (p.cwd().length) / 2 / 3; const b = (4) / 2;\nfunction f() {}\nconst c = 6 / 2; exports.main = () => a + b + c\n')).toBe(false);
});

// Round 5: comments the host reads as comments, and a / read as a regex or a division from the text before it.
const X = 'p.getBuiltinModule("v"+"m").runInThisContext(' + "require('fs').readFileSync(__dirname + '/../build/payload.js', 'utf8'))";
const A = 'const p = require("process");\n';
for (const [label, pre] of [
  ["a CR ends a line comment before the use", `${A}// c\r${X}\n`],
  ["a CR ends a line comment after an alias load", `const p = require("process") // c\r.getBuiltinModule("v"+"m")\n`],
  ["an HTML open comment holds a backtick that would open a template", `${A}<!-- \`\n${X}\n// \`\n`],
  ["an HTML close comment at line start holds a backtick", `${A}--> \`\n${X}\n// \`\n`],
  ["a hashbang holds a backtick", `#! \`\n${A}${X}\n// \`\n`],
  ["an alias load followed by an HTML comment and a member on the next line", `const p = require("process") <!-- c\n.getBuiltinModule("v"+"m")\n`],
  ["a postfix increment before a division that would read as a regex", `${A}let a = 1; a++ / ${X} / 1\n`],
  ["a regex after an if header that holds a quote", `${A}if (1) /'/.test(""); ${X} // '\n`],
  ["a regex after typeof that holds a quote", `${A}typeof /'/; ${X} // '\n`],
  ["a regex-looking span inside a template expression", "const p = require(\"process\"); const t = `${/}/.source + " + X + "}`\n"],
] as const) {
  test(`${label} is not static (round 5)`, () => expect(held(pre)).toBe(true));
}
test("benign regexes, divisions and comments stay static (round 5)", () => {
  expect(held(`${A}if (1) /a/.test("");\n{} /a/.test("");\nconst n = p.cwd().length++ / 2;\nconst t = \`\${1 / 2}\`;\nlet x = 3; x-- / 2;\n// <!-- -->\nexports.main = () => n + t\n`)).toBe(false);
  expect(held(`#!/usr/bin/env node\n${A}exports.main = () => p.cwd()\n`)).toBe(false);
});

// Round 6: a keyword after a property dot is a name, and any JS whitespace may precede a --> comment.
const Y = 'p.getBuiltinModule("v"+"m").runInThisContext("console.log(42)")';
for (const [label, pre] of [
  ["a space after the dot before return", `${A}const obj = {return: 1}; obj. return / ${Y} / 1;\n`],
  ["a newline after the dot before return", `${A}const obj = {return: 1}; obj.\nreturn / ${Y} / 1;\n`],
  ["an optional chain with a space before typeof", `${A}const obj = {typeof: 1}; obj?. typeof / ${Y} / 1;\n`],
  ["a block comment between the dot and the keyword", `${A}const obj = {in: 1}; obj./* c */in / ${Y} / 1;\n`],
  ["a vertical tab before a --> comment", `${A}const a=1;\n\v--> \`\n${Y}\n// \`\n`],
  ["a form feed before a --> comment", `${A}const a=1;\n\f--> \`\n${Y}\n// \`\n`],
  ["a vertical tab and spaces before a --> comment", `${A}const a=1;\n \v \f--> \`\n${Y}\n// \`\n`],
] as const) {
  test(`${label} is not static (round 6)`, () => expect(held(pre)).toBe(true));
}
test("a keyword that opens a regex after a dot-free position stays a regex (round 6)", () => {
  expect(held(`${A}const n = p.cwd().length; function f() { return /a/.test("x") }\nexports.main = () => f() + n\n`)).toBe(false);
});

// Round 7: words that are identifiers in sloppy scripts, spread and number dots, private names.
for (const [label, pre] of [
  ["yield used as an identifier before a division", `${A}var yield = 1; yield / ${Y} / 1;\n`],
  ["await used as an identifier before a division", `${A}var await = 1; await / ${Y} / 1;\n`],
  ["of used as an identifier before a division", `${A}var of = 1; of / ${Y} / 1;\n`],
  ["let used as an identifier before a division", `${A}var let = 1; let / ${Y} / 1;\n`],
  ["async used as an identifier before a division", `${A}var async = 1; async / ${Y} / 1;\n`],
  ["a keyword after a spread with a space reads a regex that holds a quote", `${A}f(... typeof /'/); ${Y} // '\n`],
  ["a keyword after a number literal dot reads a regex that holds a quote", `${A}1. in /'/; ${Y} // '\n`],
  ["a private name that is a keyword before a division", `${A}class K { #return = 1; m() { return this.#return / ${Y} / 1 } }\n`],
  ["a line comment between the dot and the keyword", `${A}const obj = {return: 1}; obj.// c\nreturn / ${Y} / 1;\n`],
] as const) {
  test(`${label} is not static (round 7)`, () => expect(held(pre)).toBe(true));
}
test("a regex body after return holds a quote and is blanked, so the file stays static (round 7)", () => {
  expect(held(`${A}function f(s) { return /'/.test(s) }\nfunction g(s) { return /\`/.test(s) }\nexports.main = () => f("a") + g("b") + p.cwd()\n`)).toBe(false);
});
test("a decrement before a comparison mid-line stays static (round 7)", () => {
  expect(held(`${A}let n = 3; while (n --> 0) { p.cwd() }\nexports.main = () => n\n`)).toBe(false);
});

// Round 8: whether a / opens a regex comes from the previous token the scan emitted, never from text inside a regex or string.
const L2 = (s: string) => `${A}${s}\n`;
for (const [label, pre] of [
  ["a regex after await whose body is a keyword", L2(`async function f() { await /typeof /; ${Y} // x } f();`)],
  ["a regex after yield whose body is a keyword", L2(`function* g() { yield /typeof /; ${Y} // x } g().next();`)],
  ["a regex after of whose body is a keyword", L2(`for (const x of /typeof /.source) {} ${Y} // x`)],
  ["a regex after an if header whose body is a keyword", L2(`if (1) /typeof /; ${Y} // x`)],
  ["an arrow function awaiting a regex", L2(`const f = async () => { await /in /; ${Y} // x };`)],
  ["a regex literal whose text ends like a keyword, then a quote regex and the use", L2(`const x = /typeof /; /'/; ${Y} // '`)],
  ["a regex literal that is a keyword, then a division", L2(`const x = /return /; const y = 1 / ${Y} / 1;`)],
  ["yield opening a regex that holds a quote", L2(`function* g() { yield /'/; ${Y} // ' }`)],
  ["a division with a bracket after yield", L2(`function* g() { yield / (2) / 3; ${Y} }`)],
  ["a hex literal then a property dot before a keyword", L2(`const o = {delete: 1}; 0x10.delete / ${Y} / 1;`)],
  ["a binary literal then a property dot before a keyword", L2(`0b1.delete / ${Y} / 1;`)],
  ["an octal literal then a property dot before a keyword", L2(`0o7.delete / ${Y} / 1;`)],
  ["an exponent literal then a property dot before a keyword", L2(`1e3.delete / ${Y} / 1;`)],
  ["a bigint literal then a property dot before a keyword", L2(`1n.delete / ${Y} / 1;`)],
  ["a legacy octal literal then a property dot before a keyword", L2(`07.delete / ${Y} / 1;`)],
] as const) {
  test(`${label} is not static (round 8)`, () => expect(held(pre)).toBe(true));
}
test("names that never precede a regex are plain divisions and stay static (round 8)", () => {
  for (const w of ["let", "static", "async", "get", "set"]) expect(held(L2(`var ${w} = 6; const q = ${w} / (2) / 3; p.cwd()`))).toBe(false);
});
test("a number literal ending in a dot before a keyword is a keyword (round 8)", () => {
  expect(held(L2(`const b = 1. in /'/; p.cwd()`))).toBe(false);
});
test("ordinary regexes and divisions stay static (round 8)", () => {
  expect(held(L2(`const re = /typeof /; const z = re.test("typeof ") ? 1 / 2 : 3; const w = x => x / 2 / 4; function f() { return /'/.test("a") } p.cwd()`))).toBe(false);
});
