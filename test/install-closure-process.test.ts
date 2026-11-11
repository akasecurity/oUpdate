import { expect, test } from "bun:test";
import { hasUnbounded, processHazard, provablyStatic, scannerFaultCount } from "../src/install-closure.ts";
import { allowFaults } from "./fault-guard.ts";
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
  expect(held('const p = require("process"); const a = (p.cwd().length) / 2;\nconst b = (4) / 2;\nfunction f() {}\nconst c = 6 / 2; exports.main = () => a + b + c\n')).toBe(false);
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

// Round 9: an identifier is read whole, and leading-zero literals keep or lose the dot as JavaScript does.
for (const len of [63, 64, 65, 128, 200]) {
  test(`an identifier with a ${len}-character prefix ending in a keyword is one name (round 9)`, () => {
    const name = "a".repeat(len) + "return";
    expect(held(L2(`var ${name} = 1; ${name} / ${Y} / 1;`))).toBe(true);
    expect(held(L2(`var ${name} = 6; const q = ${name} / (2) / 3; p.cwd()`))).toBe(false);
  });
}
for (const [label, lit, dotIsNumber] of [
  ["08.", "08.", true],
  ["09.", "09.", true],
  ["0.5.", "0.5.", false],
  ["1_0.", "1_0.", true],
  ["07.", "07.", false],
  ["00.", "00.", false],
  ["0.", "0.", true],
] as const) {
  test(`${label} before a keyword is read as JavaScript reads it (round 9)`, () => {
    // A number that keeps its dot leaves "in" a keyword that opens a regex holding a quote (the use after it is code);
    // with a property dot "in" is a name, the / divides, and the quoted text is a string in JavaScript too.
    if (dotIsNumber) {
      expect(held(L2(`const b = ${lit} in /'/; ${Y} // '`))).toBe(true);
      expect(held(L2(`const b = ${lit} in /'/; p.cwd()`))).toBe(false);
    } else {
      expect(held(L2(`const b = ${lit}delete / ${Y} / 1;`))).toBe(true);
    }
  });
}
for (const w of ["default", "extends"]) {
  test(`${w} before a regex that holds a quote is a keyword (round 9)`, () => {
    expect(held(L2(`switch (1) { ${w === "default" ? "default" : "case 1"}: /'/.test("a"); } ${Y} // '`))).toBe(true);
  });
}

// Round 10: a / after a binary /, what follows a closing /, the second scan, HTML comments in a span, line-end words.
for (const [label, pre] of [
  ["a regex right after a binary division", L2(`const a = 1; const r = a / /'/.source; ${Y} // '`)],
  ["a span closed and followed by a name", L2(`const a = (1); const b = a / 2 / ${Y}; const c = (2) / 3 / p.cwd();`)],
  ["a span closed and followed by another /", L2(`const a = (1) / b / /'/.test(1); ${Y} // '`)],
  ["a division after module.exports with the use between slashes", L2(`const x = module.exports / ${Y} / 1;`)],
  ["a division after a plain require with the use between slashes", L2(`const x = require("fs") / ${Y} / 1;`)],
  ["a division after an alias statement with the use between slashes", `const p = require("process");\nconst q = require("node:process")\n/ ${Y} / 1;\n`],
  ["an HTML comment inside an ambiguous span", L2(`const a = (1) / <!-- \` / 2;\n${Y}\n// \``)],
  ["a regex on the line after break", L2(`for (;;) { break\n/'/.test(1); ${Y} // '\n }`)],
  ["a regex on the line after continue label", L2(`a: for (;;) { continue a\n/'/.test(1); ${Y} // '\n }`)],
  ["a regex on the line after debugger", L2(`debugger\n/'/.test(1); ${Y} // '`)],
  ["a division after a template expression opener", L2("const t = `${/}/.source + " + Y + "}`")],
  ["a regex-looking slash after a closing template", L2("const t = `a` / `b` / " + Y + " / 1")],
  ["a template without an expression joined to its neighbors", L2("const x = 1; const t = x`a`.in / " + Y + " / 1")],
] as const) {
  test(`${label} is not static (round 10)`, () => expect(held(pre)).toBe(true));
}
test("a regex after break on the same statement, a template, and a --> mid-line stay static (round 10)", () => {
  expect(held(L2("let n = 3; const t = `a` / 2;\nwhile (n --> 0) { p.cwd() }\nfor (;;) { break }\nconst r = /x/.test(1)"))).toBe(false);
});
test("a --> after tokens on the same line is not a comment and does not flag (round 10)", () => {
  expect(held(L2("let n = 2; if (n --> 0) { p.cwd() }"))).toBe(false);
  expect(held(L2("let n = 2;\n  -->  `\n" + Y + "\n// `"))).toBe(true);
});

// Round 11: a removed load or statement leaves a name, not a number, so a following property dot stays a dot.
for (const [label, pre] of [
  ["a property keyword after module.exports", `${A}module.exports.in /\n${Y} / 1;\n`],
  ["a property keyword after a plain require", `${A}require("fs").in /\n${Y} / 1;\n`],
  ["a property keyword after a relative require", `${A}require("./helper").in /\n${Y} / 1;\n`],
  ["typeof after module.exports", `${A}module.exports.typeof / ${Y} / 1;\n`],
  ["a computed member of a require", `${A}require("fs")["x"] / ${Y} / 1;\n`],
  ["source that already holds the placeholder name", L2(`var __removed_text__ = 1; p.cwd()`)],
] as const) {
  test(`${label} is not static (round 11)`, () => expect(held(pre)).toBe(true));
}
for (const [label, pre] of [
  ["a property keyword after module.exports on one line", `${A}module.exports.in / ${Y} / 1;\n`],
  ["a property keyword after a plain require on one line", `${A}require("fs").in / ${Y} / 1;\n`],
  ["a property keyword after a relative require on one line", `${A}require("./helper").in / ${Y} / 1;\n`],
] as const) {
  test(`${label} is not static (round 11)`, () => expect(held(pre)).toBe(true));

}
// The global process is checked like a name for the module. Loader words and a bare or computed use widen the
// closure to the whole package (the changed build files hold); other uses only make the hook not static.
const widensAll = (pre: string) => holds(release("1.0.0", pre), release("1.0.1", pre)).length > 0;
for (const [label, pre] of [
  ["an alias of process calling binding", 'const p = process; exports.main = () => p.binding("spawn_sync").spawn({})\n'],
  ["an alias of process with a computed mainModule load", 'const p = process; exports.main = () => p.mainModule["req"+"uire"]("./evil.js")\n'],
  ["process._linkedBinding", 'exports.main = () => process._linkedBinding("x")\n'],
  ["process.getBuiltinModule with a computed name", 'exports.main = () => process.getBuiltinModule("child_" + "process").execSync("node ./unreviewed.js")\n'],
  ["a computed member of process", 'exports.main = () => process["bind"+"ing"]("spawn_sync")\n'],
  ["process passed to another call", 'exports.main = () => run(process)\n'],
  ["a require of a process.env value", 'exports.main = () => require(process.env.X)\n'],
  ["an import() of a process.env value", 'exports.main = () => import(process.env.X)\n'],
  ["a require.resolve of a process.env value", 'exports.main = () => require.resolve(process.env.X)\n'],
] as const) {
  test(`${label} widens the closure to the whole package`, () => expect(widensAll(pre)).toBe(true));
}
test("the plain reads on the allowlist stay static: env.X, platform, arch, versions, argv, cwd(), exit(, exitCode, stdout.write(", () => {
  const pre = 'exports.main = () => { if (process.env.CI || process.platform === "win32" || process.arch === "x" || process.version < "v18") process.exit(1); process.exitCode = 1; process.stdout.write(process.cwd() + process.argv[2] + process.versions.node) }\n';
  expect(widensAll(pre)).toBe(false);
  expect(held(pre)).toBe(false);
});
test("another member of process (nextTick) makes the hook not static but does not widen to the whole package", () => {
  const pre = 'exports.main = () => process.nextTick(() => 1)\n';
  expect(held(pre)).toBe(true);
  expect(widensAll(pre)).toBe(false);
});
test("a word like process in a comment or a message is not a process use", () => {
  const pre = '// process the options\nexports.main = () => console.log("process done")\n';
  expect(widensAll(pre)).toBe(false);
});

// The global process under an escaped name, and a loader load that continues past the statement.
for (const [label, pre] of [
  ["an escaped global process calling binding", 'exports.main = () => \\u0070rocess.binding("spawn_sync")\n'],
  ["a braced escape of the global process calling getBuiltinModule", 'exports.main = () => \\u{70}rocess.getBuiltinModule("child_"+"process")\n'],
  ["a required process module with a member call continuing the statement", 'const x = require("process").binding("spawn_sync")\nexports.main = () => 1\n'],
] as const) {
  test(`${label} widens the closure to the whole package`, () => expect(widensAll(pre)).toBe(true));
}

// Round 12: the span of an ambiguous / must end in an operand; ( x ) / 2 / 3 on one line is not static; real plain require.
for (const [label, pre] of [
  ["a span ending in an operator", L2(`const a = (1) / 1 + / ${Y}; // /`)],
  ["a span ending in an operator and a regex that holds the use", L2(`const a = (b) / 1 * / (x) / ${Y} /`)],
  ["a plain npm_package_config require followed by a property keyword", L2(`const x = require(process.env.npm_package_config_foo).in / ${Y} / 1;`)],
  ["export default opening a regex that holds a quote", L2(`export default /'/.test(1); ${Y} // '`)],
  ["extends opening a regex that holds a quote", L2(`class K extends /'/.source {} ${Y} // '`)],
  ["an alias statement with no semicolon followed by a division holding the use", `const p = require("process")\n/ ${Y} / 1;\n`],
] as const) {
  test(`${label} is not static (round 12)`, () => expect(held(pre)).toBe(true));
}
test("two divisions after ) on one line are not static, one per line are (round 12)", () => {
  expect(held(L2("const a = (p.cwd().length) / 2 / 3;"))).toBe(true);
  expect(held(L2("const a = (p.cwd().length) / 2;\nconst b = (a) / 3;"))).toBe(false);
});
test("a division whose span ends in an operator and whose closing / opens a regex holding a quote is not static (round 12)", () => {
  expect(held(L2(`const a = (1) / 1 + /;'/.test(1); ${Y} // '`))).toBe(true);
  expect(held(L2(`const a = (1) / 1 - /,'/.test(1); ${Y} // '`))).toBe(true);
});

// Round 13: a statement without ; keeps the line break it took, so the next line starts a new token.
for (const [label, pre] of [
  ["an alias statement with no semicolon and the use on the next line", `const p = require("process")\np.binding("spawn_sync")\n`],
  ["an alias statement with no semicolon, a different name first on the next line", `const p = require("process")\nfoo()\np.binding("spawn_sync")\n`],
  ["an alias statement with no semicolon and a computed use on the next line", `const p = require("process")\np["bind"+"ing"]("spawn_sync")\n`],
  ["an alias statement with no semicolon and a loader call on the next line", `const q = require("node:process")\nq.getBuiltinModule("v"+"m")\n`],
] as const) {
  test(`${label} is not static (round 13)`, () => expect(held(pre)).toBe(true));
}
test("an alias statement with no semicolon and plain reads on the next line stays static (round 13)", () => {
  expect(held(`const p = require("process")\nexports.main = () => p.cwd()\n`)).toBe(false);
});

test("a keyword on the line after a no-semicolon alias statement is still a keyword (round 13)", () => {
  expect(held(`const p = require("process");\nconst q = require("process")\ntypeof /'/; ${Y} // '\n`)).toBe(true);
});

// Round 14: a removed statement ends like a statement (a / after it is a regex); a removed expression is a name that
// never joins the next word; every separator between a removed form and what follows.
const RX = `/'/; ${Y} // '`;
for (const [label, pre] of [
  ["an import declaration without a semicolon, then a bare regex", `import p from "process" ${RX}\n`],
  ["an import declaration without a semicolon on its own line, then a bare regex", `import p from "process"\n${RX}\n`],
  ["a literal import after an alias, then a bare regex", `const p = require("process");\nimport "fs"\n${RX}\n`],
  ["a named import after an alias, then a bare regex", `import p from "node:process";\nimport {existsSync} from "fs"\n${RX}\n`],
  ["a literal require then in and a regex", `const p = require("process");\nrequire("fs")in ${RX}\n`],
  ["a dynamic import then instanceof and a regex", `const p = require("process");\nimport("fs")instanceof ${RX}\n`],
  ["an alias without a semicolon then in directly after the paren", `const p = require("process")in ${RX}\n`],
  ["a plain const require then in directly after the paren", `const p = require("process");\nconst fs = require("fs")in ${RX}\n`],
  ["a removed form and CRLF then a keyword regex", `const p = require("process");\nconst q = require("process")\r\ntypeof ${RX}\n`],
  ["a removed form and U+2028 then a keyword regex", `const p = require("process");\nconst q = require("process") typeof ${RX}\n`],
  ["a removed form and a tab then a keyword regex", `const p = require("process");\nconst q = require("process")\t\ntypeof ${RX}\n`],
  ["a removed form and a block comment then a keyword regex", `const p = require("process");\nconst q = require("process")/*c*/\ntypeof ${RX}\n`],
  ["a removed form and a line comment then a keyword regex", `const p = require("process");\nconst q = require("process") // c\ntypeof ${RX}\n`],
  ["a removed form and a space before a semicolon then a regex", `const p = require("process");\nconst q = require("process") ;\n${RX}\n`],
] as const) {
  test(`${label} is not static (round 14)`, () => expect(held(pre)).toBe(true));
}
test("a span that ends in a keyword is not static (round 14)", () => {
  expect(held(L2(`const a = (1) / typeof / ${Y} / 1;`))).toBe(true);
  expect(held(L2("const n = (2) / 3;\nconst m = (n) / 4;\np.cwd()"))).toBe(false);
});

// Round 15: from and import are not always import declarations.
const QX = `/'/; ${Y} // '`;
for (const [label, pre] of [
  ["a variable named from and a string on the next line", `${A}var from = 1;\nvar y = from\n"x"\n${QX}\n`],
  ["a property named import and a string on the next line", `${A}var a = {};\nvar y = a.import\n"x"\n${QX}\n`],
  ["a property named from and a string on the next line", `${A}var a = {};\nvar y = a.from\n"x"\n${QX}\n`],
  ["an import keyword, a line break and a string, then a regex", `${A}import\n"fs"\n${QX}\n`],
  ["from, a line break and a string after a clause, then a regex", `${A}import {a} from\n"fs"\n${QX}\n`],
  ["a plain npm_package_config require then in and a regex", `${A}var x = require(process.env.npm_package_config_a)in ${QX}\n`],
] as const) {
  test(`${label} is not static (round 15)`, () => expect(held(pre)).toBe(true));
}
test("an import declaration with its string on the same line stays an import (round 15)", () => {
  expect(held(`${A}import q from "fs"\nconst r = /x/.test(1)\nexports.main = () => p.cwd() + r\n`)).toBe(false);
  expect(held(`${A}import "fs"\n${QX}\n`)).toBe(true);
});
for (const [label, pre] of [
  ["a variable named from, a string, then a division that holds the use", `${A}var from = 1;\nvar y = from\n"x"\n/ ${Y} / 1;\n`],
  ["a property named import, a string, then a division that holds the use", `${A}var a = {};\nvar y = a.import\n"x"\n/ ${Y} / 1;\n`],
  ["a property named from, a string, then a division that holds the use", `${A}var a = {};\nvar y = a.from\n"x"\n/ ${Y} / 1;\n`],
] as const) {
  test(`${label} is not static (round 15, division)`, () => expect(held(pre)).toBe(true));
}

// Round 16: any gap (none, space, line break, block or line comment) between import/from and its string.
const GAPS = ["", " ", "\n", "/*c*/", " /* c */ ", "// c\n"];
const KEYWORDS: [string, (gap: string) => string][] = [
  ["import", (g) => `import${g}"fs"`],
  ["import { a } from", (g) => `import {a} from${g}"fs"`],
  ["import {a}from", (g) => `import{a}from${g}"fs"`],
  ["export * from", (g) => `export * from${g}"fs"`],
  ["export {a} from", (g) => `export {a} from${g}"fs"`],
  ["import p from", (g) => `import q from${g}"fs"`],
];
const FOLLOWS: [string, string][] = [
  ["a bare quote regex", `\n${QX}\n`],
  ["a call that holds the use", `\n(${Y})\n`],
];
for (const [kw, make] of KEYWORDS) for (const g of GAPS) for (const [fl, tail] of FOLLOWS) {
  test(`${kw} with gap ${JSON.stringify(g)} then ${fl} is not static (round 16)`, () => expect(held(`import p from "node:process";\n${make(g)}${tail}`)).toBe(true));
}
for (const pre of [
  'import{binding}from"node:process";binding("spawn_sync")\n',
  'import p from"process";p.binding("spawn_sync")\n',
  'import p from/* c */"process";p.binding("spawn_sync")\n',
  'import p from /* c */ "node:process"; p.getBuiltinModule("v"+"m")\n',
  'import/* c */p from"process";p.binding("spawn_sync")\n',
  'import*as p from"process";p.binding("spawn_sync")\n',
]) test(`a minified or commented process import is a process alias: ${JSON.stringify(pre.slice(0, 40))} (round 16)`, () => expect(held(pre)).toBe(true));
test("a minified process import with plain reads stays static (round 16)", () => {
  expect(held('import p from"node:process";exports.main=()=>p.cwd()\n')).toBe(false);
  expect(held('import*as p from"process";exports.main=()=>p.platform\n')).toBe(false);
});
test("an import declaration is a statement: a / that starts the next line is a regex and the file stays static (round 16)", () => {
  expect(held(`${A}import q from "fs"\n/x/.test(1); exports.main = () => p.cwd()\n`)).toBe(false);
});
test("a relative import written without spaces is followed to its file (round 16)", () => {
  const pre = 'import{x}from"./helper.js";import v from"node:process";export const main=()=>v.exit(x)\n';
  const rel = (ver: string, h: string) => release(ver, pre).set("preinstall/helper.js", enc(h));
  expect(holds(rel("1.0.0", "export const x = 1\n"), rel("1.0.1", "export const x = 2\n"))).toContain("file preinstall/helper.js");
});

// Round 17: comments are taken out before any pattern reads the text.
for (const [label, pre] of [
  ["code between a from and a later comment before a string", `${A}const o = {};\nvar y = o.from/*a*/ eval("1") /*b*/"x";\nexports.main = () => 1\n`],
  ["an eval hidden between two comments after from", `from/*a*/ eval("1") /*b*/"x"\nexports.main = () => 1\n`],
  ["a process alias use hidden between two comments", `import/*a*/ q.binding("spawn_sync") /*b*/ p from "process"\n`],
  ["a quote in a line comment after from, a variable named from and a division on the next line", `${A}var from = 1;\nvar y = from // "./a"\n/ ${Y} / 1;\n`],
  ["a commented dynamic import with a computed path", `import/*c*/("./" + "evil.js");\n`],
  ["a commented dynamic import of an environment value", `import /*c*/ (process.env.TARGET);\n`],
] as const) {
  test(`${label} is not static (round 17)`, () => expect(held(pre)).toBe(true));
}
test("scanning a 200 KB run of block comments, line comments and from/import words finishes quickly (round 17)", () => {
  const runs = ["/**/".repeat(50_000), "//".repeat(100_000), "from /*".repeat(30_000) + "*/", "import /**/ ".repeat(20_000), "// from \"x\"\n".repeat(15_000)];
  for (const body of runs) {
    const t0 = performance.now();
    held(`const p = require("process");\n${body}\nexports.main = () => p.cwd()\n`);
    expect(performance.now() - t0).toBeLessThan(1000);
  }
});

// A literal dynamic import with a comment around it is a literal load: the walk follows it to the file.
for (const [label, call] of [
  ["a comment between import and the paren", 'import /*c*/ ("./evil.js")'],
  ["no space and a comment between import and the paren", 'import/*c*/("./evil.js")'],
  ["a comment inside the parens before the string", 'import(/*c*/"./evil.js")'],
  ["a comment after the string", 'import("./evil.js" /*c*/)'],
] as const) {
  test(`a dynamic import with ${label} is followed to its file (round 17)`, () => {
    const pre = `var v = require("node:process"); ${call}; exports.main = () => v.exit(0)\n`;
    const rel = (ver: string, evil: string) => release(ver, pre).set("preinstall/evil.js", enc(evil));
    expect(holds(rel("1.0.0", "module.exports = 1\n"), rel("1.0.1", "module.exports = 2\n"))).toContain("file preinstall/evil.js");
  });
}

// Followed, not widened: the target is outside the hook's directory, so only following the load reaches it.
for (const [label, pre] of [
  ["a minified static import", 'import{x}from"../lib/helper.js";import v from"node:process";export const main=()=>v.exit(x)\n'],
  ["a dynamic import with a comment", 'var v = require("node:process"); import /*c*/ ("../lib/helper.js"); exports.main = () => v.exit(0)\n'],
  ["a require with a comment inside", 'var v = require("node:process"); require(/*c*/"../lib/helper.js"); exports.main = () => v.exit(0)\n'],
] as const) {
  test(`${label} is followed to a file outside the hook directory (round 18)`, () => {
    const rel = (ver: string, h: string) => release(ver, pre).set("lib/helper.js", enc(h));
    expect(holds(rel("1.0.0", "exports.x = 1\n"), rel("1.0.1", "exports.x = 2\n"))).toContain("file lib/helper.js");
  });
}

// The dot before from/import is found through any amount of whitespace.
test("a dot before from is seen however far back it lies (round 18)", () => {
  const pre = `${A}var o = {};\nvar y = o.${" ".repeat(200)}from "./a"\n/ ${Y} / 1;\n`;
  expect(held(pre)).toBe(true);
});

// A comment in an eval argument cannot end the argument list early.
test("an eval whose argument hides a closing paren in a comment still widens (round 18)", () => {
  // build/index.js is outside the hook directory: only a wide closure holds it.
  const pre = `var p = require("process"); eval(path /* ) */ + y);\nexports.main = () => p.cwd()\n`;
  expect(holds(release("1.0.0", pre), release("1.0.1", pre))).toContain("file build/index.js");
});

// Round 18: a template interpolation or brace still open at the end of the file is not static.
for (const [label, body] of [
  ["an unterminated template interpolation", "const t = `x${p.cwd()"],
  ["an unterminated interpolation inside a nested template", "const t = `a${`b` + p.cwd()"],
  ["an open brace at the end of the file", "function f() { return p.cwd()"],
] as const) {
  test(`${label} is not static (round 18)`, () => expect(held(`${A}${body}\n`)).toBe(true));
}
test("a { or ${ inside a string, a comment or a regex keeps a file static (round 18)", () => {
  for (const body of ['var s = "{ ${"; ', "var s = '}{';", "// {\nvar r = /{/;", "/* ${ */ var t = `{`;"]) {
    expect(held(`${A}${body}\nexports.main = () => p.cwd()\n`)).toBe(false);
  }
});
test("a comment between the dot and from does not hide the dot (round 18)", () => {
  expect(held(`${A}var o = {};\nvar y = o./*c*/from "./a"\n/ ${Y} / 1;\n`)).toBe(true);
});
test("balanced nested templates stay static (round 18)", () => {
  expect(held(`${A}exports.main = () => \`a\${\`b\${p.cwd()}\`}\`\n`)).toBe(false);
});

// Shapes of the bare global process that reach a loader: each must widen the closure to the whole package.
for (const [label, pre] of [
  ["process.getBuiltinModule with a computed builtin name", 'process.getBuiltinModule("child_"+"process").execSync("echo RAN", { stdio: "inherit" });\n'],
  ["process with a computed mainModule member", 'const r = process["main"+"Module"]; console.log(typeof r);\n'],
  ["globalThis.process kept in a name", 'const q = globalThis.process; console.log(typeof q.getBuiltinModule);\n'],
  ["globalThis.process passed to a call", 'run(globalThis.process);\n'],
  ["a destructured getBuiltinModule from process", 'const { getBuiltinModule: g } = process; console.log(typeof g);\n'],
  ["a destructured computed key from process", 'const { ["get"+"BuiltinModule"]: g } = process; g("vm");\n'],
  ["a descriptor read of process", 'console.log(typeof Object.getOwnPropertyDescriptor(process, "getBuiltinModule").value);\n'],
  ["process in a comma expression", 'const z = (0, process); z.dlopen();\n'],
  ["process returned from a function", 'function f() { return process } f().dlopen();\n'],
] as const) {
  test(`${label} widens the closure to the whole package (global process)`, () => expect(widensAll(pre)).toBe(true));
}
test("a computed member of globalThis widens the closure to the whole package (global process)", () => {
  expect(widensAll('const q = globalThis["pro"+"cess"]; q.dlopen();\n')).toBe(true);
  expect(widensAll('const n = globalThis.process.env.X; exports.main = () => n\n')).toBe(false);
});

// Round 4 of the global process: every use that is not a complete allowlisted read widens the closure to the whole package.
// None of these lines holds a loader word, so only the use itself can widen them.
for (const [label, pre] of [
  ["a concise arrow body that is the process object", 'exports.main = () => process\n'],
  ["process in an array", 'const a = [process]; exports.main = () => a[0]["x"]\n'],
  ["a spread of process", 'const a = {...process}; exports.main = () => a["x"]\n'],
  ["process in a template placeholder", 'exports.main = () => `${process}`\n'],
  ["an optional computed member of process", 'exports.main = () => process?.["x"]\n'],
  ["globalThis?.process as a value", 'const p = globalThis?.process; exports.main = () => p["x"]\n'],
  ["process taken from globalThis by a pattern", 'const { process: p } = globalThis; exports.main = () => p["x"]\n'],
  ["process handed to a tagged template", 'exports.main = () => ((s, p) => p["x"])`${process}`\n'],
  ["a chained computed call after process.cwd()", 'exports.main = () => process.cwd()["con"+"structor"]["con"+"structor"]("return process")()\n'],
  ["a chained call after process.env.PATH", 'exports.main = () => process.env.PATH.constructor.constructor("return process")()\n'],
  ["a computed member of a process.argv entry", 'exports.main = () => process.argv[0]["con"+"structor"]\n'],
  ["a member of process.version", 'exports.main = () => process.version.constructor\n'],
  ["a chain after process.stdout.write", 'exports.main = () => process.stdout.write("x").constructor.constructor("return 1")()\n'],
  ["the bare global object handed on", 'const g = globalThis; exports.main = () => g["x"]\n'],
] as const) {
  test(`${label} widens the closure (round 19)`, () => expect(widensAll(pre)).toBe(true));
}

// These stay static: nothing here is a use of the process object that could reach a loader.
for (const [label, pre] of [
  ["a property named process", 'exports.main = (x) => x.process(1)\n'],
  ["an object key named process", 'exports.main = () => ({ a: 1, process: 2 })\n'],
  ["a parameter named process that is only declared", 'exports.main = function (process) { return 1 }\n'],
  ["an arrow parameter named process", 'exports.main = (a, process) => 1\n'],
  ["the words process and binding inside a message", 'exports.main = () => console.log("error: process failed", "build/Release/binding.node", "binding.gyp")\n'],
  ["destructuring allowlisted members of process", 'const { platform, argv } = process; exports.main = () => platform + argv[2]\n'],
  ["complete reads", 'exports.main = () => [process.env.NODE_ENV === "production", process.platform === "win32", process.cwd() + "/x", process.argv.slice(2), process.env.HOME.split("/").length]\n'],
  ["process.exit and stdout.write", 'exports.main = () => { process.stdout.write("ok"); process.exit(1) }\n'],
] as const) {
  test(`${label} stays static (round 19)`, () => expect(held(pre)).toBe(false));
}
test("a non-ASCII identifier is not static but does not widen to the whole package (round 19)", () => {
  const pre = 'const café = 1; exports.main = () => café\n';
  expect(held(pre)).toBe(true);
  expect(widensAll(pre)).toBe(false);
});
test("a file the scan cannot read that never names process does not widen to the whole package (round 19)", () => {
  expect(widensAll('exports.main = () => a / b / c\nexports.k = (x) => x\n) /\n')).toBe(false);
});
test("a destructuring of a member that is not on the allowlist widens (round 19)", () => {
  expect(widensAll('const { x } = process; exports.main = () => x["y"]\n')).toBe(true);
});

// The global object handed on is as good as process: it widens however it is handed on.
for (const [label, pre] of [
  ["a call argument", 'function f(g) { return g["x"] }\nexports.main = () => f(globalThis)\n'],
  ["an array element", 'exports.main = () => [globalThis][0]["x"]\n'],
  ["a return value", 'function f() { return globalThis }\nexports.main = () => f()["x"]\n'],
  ["a default parameter", 'exports.main = (g = globalThis) => g["x"]\n'],
  ["new f(globalThis)", 'exports.main = () => new F(globalThis)\n'],
  ["the global alias passed on", 'exports.main = () => f(global)\n'],
  ["a bare this at the top level", 'const t = this; exports.main = () => t["x"]\n'],
] as const) {
  test(`${label} of the global object widens the closure (round 20)`, () => expect(widensAll(pre)).toBe(true));
}
for (const [label, pre] of [
  ["typeof globalThis", 'exports.main = () => typeof globalThis\n'],
  ["a member read of globalThis", 'exports.main = () => globalThis.setTimeout(() => 1, 1)\n'],
  ["this inside a function", 'exports.main = function () { return this.x }\n'],
  ["a loop index into argv", 'exports.main = () => { for (let i = 2; i < process.argv.length; i++) if (process.argv[i] === "-v") return 1 }\n'],
] as const) {
  test(`${label} stays static (round 20)`, () => expect(held(pre)).toBe(false));
}

// Round 21: callbacks, renamed bindings, typeof chains, the global under other spellings, indirect eval, process loaded other ways.
for (const [label, pre] of [
  ["a callback passed to a method on argv", 'exports.main = () => process.argv.map((v, i, a) => a["x"])\n'],
  ["a callback passed to replace on cwd()", 'exports.main = () => process.cwd().replace(/./, (...a) => a["x"])\n'],
  ["a renamed destructured member", 'const { argv: a } = process; exports.main = () => a["x"]\n'],
  ["a typeof operand followed by a call chain", 'exports.main = () => typeof process["x"]("y")\n'],
  ["a typeof operand followed by a member call", 'exports.main = () => typeof process.a.b()\n'],
  ["a parenthesized globalThis", 'exports.main = () => (globalThis).process\n'],
  ["globalThis.globalThis.process", 'exports.main = () => globalThis.globalThis.process\n'],
  ["a doubled global", 'exports.main = () => global.global["x"]\n'],
  ["a comma expression ending in globalThis", 'exports.main = () => (0, globalThis)["x"]\n'],
  ["globalThis as an arrow body", 'exports.main = () => globalThis\n'],
  ["process next to a no-break space", 'exports.main = () => [\u00a0process]\n'],
  ["process next to a byte order mark", 'exports.main = () => [\ufeffprocess]\n'],
  ["process next to a line separator", 'exports.main = () => [\u2028process]\n'],
  ["a process member that loads code", 'exports.main = () => process.dlopen({}, "x")\n'],
  ["require of the process module followed by a computed member", 'exports.main = () => require("process")["x"]\n'],
  ["import() of the process module", 'exports.main = () => import("process")\n'],
  ["import { default as p } from the process module", 'import { default as p } from "process"; exports.main = () => p["x"]\n'],
  ["an indirect eval", 'exports.main = () => (0, eval)(process.env.X)\n'],
  ["an optional eval", 'exports.main = () => eval?.(process.env.X)\n'],
  ["new Function", 'exports.main = () => new Function(process.env.X)\n'],
  ["globalThis.eval", 'exports.main = () => globalThis.eval(process.env.X)\n'],
  ["a computed member of window", 'exports.main = () => window["ev" + "al"](process.env.X)\n'],
  ["setTimeout given a string", 'exports.main = () => setTimeout("run()" + process.env.X, 1)\n'],
  ["a require with a string fallback", 'exports.main = () => require(process.env.X || "./a")\n'],
  ["a require with a string prepended to process", 'exports.main = () => require("" + process.env.X)\n'],
  ["a require of a template holding process", 'exports.main = () => require(`${process.env.X}`)\n'],
  ["a function property named function with process as argument", 'exports.main = () => api.function(process)\n'],
] as const) {
  test(`${label} widens the closure (round 21)`, () => expect(widensAll(pre)).toBe(true));
}
for (const [label, pre] of [
  ["a label named process", 'exports.main = () => { process: for (;;) { break process } }\n'],
  ["a class field named process", 'class C { process = 1 }\nexports.main = () => new C()\n'],
  ["typeof process", 'exports.main = () => typeof process === "undefined"\n'],
  ["in process", 'exports.main = () => "env" in process\n'],
  ["a binding variable", 'const binding = 1; exports.main = () => binding\n'],
  ["a message that names require and eval", 'exports.main = () => console.log("require eval constructor child_process")\n'],
  ["a literal-argument method on cwd()", 'exports.main = () => process.cwd().split("/").slice(1).join("/")\n'],
] as const) {
  test(`${label} stays static (round 21)`, () => expect(held(pre)).toBe(false));
}
for (const [label, pre] of [
  ["a computed env key", 'const k = "X"; exports.main = () => process.env[k]\n'],
  ["an optional call of a process member", 'exports.main = () => process.getuid?.()\n'],
  ["a loop index into argv", 'exports.main = () => { for (let i = 0; i < 3; i++) process.argv[i] }\n'],
] as const) {
  test(`${label} does not widen the closure (round 21)`, () => expect(widensAll(pre)).toBe(false));
}

// Round 22: a timer given code through the global object, and labels and class fields named global.
for (const [label, pre] of [
  ["globalThis.setTimeout given a string", 'exports.main = () => globalThis.setTimeout("run()" + process.env.X, 0)\n'],
  ["global.setInterval given a built string", 'exports.main = () => global.setInterval("a" + process.env.X, 0)\n'],
  ["window.setTimeout given a template", 'exports.main = () => window.setTimeout(`run(${process.env.X})`, 0)\n'],
] as const) {
  test(`${label} widens the closure (round 22)`, () => expect(widensAll(pre)).toBe(true));
}
for (const [label, pre] of [
  ["a label named global", 'exports.main = () => { global: for (;;) { break global } }\n'],
  ["a class field named global", 'class C { global = 1 }\nexports.main = () => new C()\n'],
] as const) {
  test(`${label} stays static (round 22)`, () => expect(held(pre)).toBe(false));
}

// Round 24: dangerous property names as strings, operands that do not end, calls that return process, the function keyword by
// its neighbors, package-root reads, exact module names, an explicit list of global members, assignments through a read.
for (const [label, pre] of [
  ["a computed constructor chain with string keys", 'exports.main = () => []["constructor"]["constructor"](process.env.X)()\n'],
  ["a computed constructor chain with a name holding the key", 'const k = "constructor";\nexports.main = () => [][k][k](process.env.X)()\n'],
  ["typeof of a globalThis chain that goes on", 'exports.main = () => typeof globalThis.globalThis.process["main" + "Module"]["req" + "uire"]("../docs/x")\n'],
  ["process.on whose result is used", 'exports.main = () => { const p = process.on("x", () => 1); return p["y"] }\n'],
  ["a property named function taking process", 'exports.main = () => api. function(process)\n'],
  ["an object key named function next to a call with process", 'exports.main = () => ({ function: 1, a: run(process) })\n'],
  ["a class field named function next to a call with process", 'class C { function = run(process) }\nexports.main = () => new C()\n'],
  ["a name ending in function taking process", 'exports.main = () => éfunction(process)\n'],
  ["a manifest path in front of a string", 'exports.main = () => require(process.env.npm_package_json + "/../docs/x.js")\n'],
  ["window?.eval", 'exports.main = () => window?.eval(process.env.X)\n'],
  ["self?.eval", 'exports.main = () => self?.eval(process.env.X)\n'],
  ["an assignment through a read of a non-literal", 'exports.main = () => { process.env.NODE_OPTIONS = process.env.Y || "" }\n'],
  ["a global member that is not on the list", 'exports.main = () => globalThis.Error\n'],
] as const) {
  test(`${label} widens the closure (round 24)`, () => expect(widensAll(pre)).toBe(true));
}
for (const [label, pre] of [
  ["process.on as a statement", 'exports.main = () => { process.on("exit", () => 1);\n process.once("x", () => 2) }\n'],
  ["a require of a package whose name starts with process", 'exports.main = () => require("process-nextick-args")\n'],
  ["an assignment of a literal through a read", 'exports.main = () => { process.env.X = "1"; process.exitCode = 1 }\n'],
  ["typeof globalThis compared", 'exports.main = () => typeof globalThis === "undefined"\n'],
  ["a require of cwd() in front of a string", 'exports.main = () => require(process.cwd() + "/tools/x.js")\n'],
] as const) {
  test(`${label} does not widen the closure (round 24)`, () => expect(widensAll(pre)).toBe(false));
}

// Common hook idioms stay precise (round 25).
for (const [label, pre] of [
  ["process.on exit with an arrow callback", 'process.on("exit", () => console.log("bye"));\nexports.main = () => 1\n'],
  ["process.on SIGINT with a function callback", 'process.on("SIGINT", function () { process.exit(1) });\nexports.main = () => 1\n'],
  ["process.once uncaughtException as the last statement", 'exports.main = () => 1\nprocess.once("uncaughtException", (e) => { console.error(e) })\n'],
] as const) {
  test(`${label} is static (round 25)`, () => expect(held(pre)).toBe(false));
}
for (const [label, pre] of [
  ["require of path.join(process.cwd(), ...)", 'const path = require("path");\nexports.main = () => require(path.join(process.cwd(), "x.js"))\n'],
  ["require of path.resolve(process.cwd(), ...)", 'const path = require("path");\nexports.main = () => require(path.resolve(process.cwd(), "tools", "x.js"))\n'],
] as const) {
  test(`${label} does not widen the closure (round 25)`, () => expect(widensAll(pre)).toBe(false));
}
test("process.on with a non-literal event name is not static (round 25)", () => {
  expect(held('const e = "exit";\nprocess.on(e, () => 1);\nexports.main = () => 1\n')).toBe(true);
});
test("process.on whose result is chained is not static (round 25)", () => {
  expect(held('process.on("exit", () => 1).on("x", () => 2);\nexports.main = () => 1\n')).toBe(true);
});

// Round 26: literal-only bracket keys, a field named function, templates holding a module name.
for (const [label, pre] of [
  ["a template key that spells constructor", 'exports.main = () => [][`${"constructor"}`][`${"constructor"}`](process.env.X)()\n'],
  ["a concatenated key that spells constructor", 'exports.main = () => []["" + "constructor"]["" + "constructor"](process.env.X)()\n'],
  ["a parenthesized key that spells constructor", 'exports.main = () => [][("constructor")][("constructor")](process.env.X)()\n'],
  ["a parenthesized concatenation that spells constructor", 'exports.main = () => [][("con" + "structor")][("con" + "structor")](process.env.X)()\n'],
  ["a class field named function before a call with process", 'class C { function; x = run(process) }\nexports.main = () => new C()\n'],
  ["a class field with a value named function before a call with process", 'class C { function = 1; x = run(process) }\nexports.main = () => new C()\n'],
  ["a method named function before a field with process", 'class C { function() {} x = run(process) }\nexports.main = () => new C()\n'],
  ["an object key named function before a call with process", 'exports.main = () => { ({ function: 1 }); run(process) }\n'],
  ["require of a template holding process", 'const p = require(`process`);\nexports.main = () => p["x"]\n'],
  ["require of a template holding node:process", 'const p = require(`node:process`);\nexports.main = () => p["x"]\n'],
  ["import() of a template holding process", 'exports.main = () => import(`process`)\n'],
  ["require.resolve of a template holding process", 'exports.main = () => require.resolve(`process`)\n'],
  ["require of a template with a literal substitution", 'const p = require(`${"process"}`);\nexports.main = () => p["x"]\n'],
] as const) {
  test(`${label} widens the closure (round 26)`, () => expect(widensAll(pre)).toBe(true));
}
test("a template with no substitution is still a plain string elsewhere (round 26)", () => {
  expect(held('exports.main = () => `hello world`\n')).toBe(false);
});

// Round 27: every position a dangerous name can take, escapes, the dot spelling of the constructor chain, a line break before
// a chained call, writes decided by their target, the previous token before a global, typeof members, a template specifier.
// A changed payload file outside the hook directory must hold: that tells "everything" from "the package".
const widensDocs = (pre: string) => {
  const rel = (v: string) => release(v, pre).set("docs/payload.txt", enc(`payload ${v}\n`));
  return holds(rel("1.0.0"), rel("1.0.1")).some((d) => d.includes("docs/payload.txt"));
};
for (const [label, pre] of [
  ["a dot constructor chain", 'exports.main = () => [].constructor.constructor(process.env.X)()\n'],
  ["a bracket on constructor", 'exports.main = () => [].constructor["constructor"](process.env.X)()\n'],
  ["a constructor call with a computed argument", 'exports.main = () => (() => 1).constructor(process.env.X)()\n'],
  ["a parenthesized key", 'exports.main = () => [][("constructor")][("constructor")](process.env.X)()\n'],
  ["a key after ||", 'exports.main = (a) => [][a || "constructor"][a || "constructor"](process.env.X)()\n'],
  ["a key in a ternary", 'exports.main = (a) => [][a ? "constructor" : ""][a ? "constructor" : ""](process.env.X)()\n'],
  ["a key after an empty string", 'exports.main = () => [][("" + "constructor")][("" + "constructor")](process.env.X)()\n'],
  ["a key as a later array element", 'const ks = ["a", "constructor"];\nexports.main = () => [][ks[1]][ks[1]](process.env.X)()\n'],
  ["a key as an object value", 'const o = { k: "constructor" };\nexports.main = () => [][o.k][o.k](process.env.X)()\n'],
  ["a key returned by an arrow", 'const k = () => "constructor";\nexports.main = () => [][k()][k()](process.env.X)()\n'],
  ["a key passed as an argument", 'exports.main = () => get([], "constructor")(process.env.X)()\n'],
  ["an escaped key", 'exports.main = () => []["constru\\x63tor"]["constru\\u0063tor"](process.env.X)()\n'],
  ["an escaped key with a code point escape", 'const k = "constru\\u{63}tor";\nexports.main = () => [][k][k](process.env.X)()\n'],
  ["a chained call on the next line after process.on", 'process.on("x", () => 1)\n.dlopen(m, p)\nexports.main = () => 1\n'],
  ["an optional chained call on the next line after process.on", 'process.on("x", () => 1)\n?.execve("a")\nexports.main = () => 1\n'],
  ["an assignment of a literal to NODE_OPTIONS", 'exports.main = () => { process.env.NODE_OPTIONS = "--require ./docs/x.js" }\n'],
  ["a compound assignment to NODE_OPTIONS", 'exports.main = () => { process.env.NODE_OPTIONS += " --require ./docs/x.js" }\n'],
  ["an or-assignment to NODE_OPTIONS", 'exports.main = () => { process.env.NODE_OPTIONS ||= "--require ./docs/x.js" }\n'],
  ["an assignment to NODE_PATH", 'exports.main = () => { process.env.NODE_PATH = "./docs" }\n'],
  ["an assignment of a template to PATH", 'exports.main = (d) => { process.env.PATH = `${d}:/bin` }\n'],
  ["an assignment to an npm_config_ variable", 'exports.main = () => { process.env.npm_config_prefix = "./docs" }\n'],
  ["an assignment to a computed env key", 'exports.main = (k) => { process.env[k] = "1" }\n'],
  ["an assignment to a member that is not on the list", 'exports.main = () => { process.argv = [] }\n'],
  ["a ternary consequent global on an indented line", 'exports.main = (c) => c ?\n                global : 1\n'],
  ["a template specifier of the process module", 'const p = require(`process`); exports.main = () => p.dlopen({}, "x")\n'],
] as const) {
  test(`${label} widens the closure (round 27)`, () => expect(widensAll(pre)).toBe(true));
}
for (const [label, pre] of [
  ["a dot constructor chain", 'exports.main = () => [].constructor.constructor(process.env.X)()\n'],
  ["an escaped key", 'exports.main = () => []["constru\\x63tor"]["constru\\u0063tor"](process.env.X)()\n'],
  ["an assignment of a literal to NODE_OPTIONS", 'exports.main = () => { process.env.NODE_OPTIONS = "--require ./docs/x.js" }\n'],
] as const) {
  test(`${label} holds a changed payload outside the hook directory (round 27)`, () => expect(widensDocs(pre)).toBe(true));
}
test("a hook with no unbounded use does not hold a changed payload (round 27)", () => {
  expect(widensDocs('exports.main = () => 1\n')).toBe(false);
});
for (const [label, pre] of [
  ["a comparison with constructor", 'exports.main = (key) => key === "constructor" || key !== "mainModule" || "getThis" == key\n'],
  ["a case label of constructor", 'exports.main = (k) => { switch (k) { case "constructor": return 1 } }\n'],
  ["constructor as the left side of in", 'exports.main = (o) => "constructor" in o\n'],
  ["constructor as an object key", 'exports.main = () => ({ "constructor": 1, a: 2 })\n'],
  ["process.exitCode set to a variable", 'exports.main = (code) => { process.exitCode = code }\n'],
  ["process.exitCode set to a ternary", 'exports.main = (failed) => { process.exitCode = failed ? 1 : 0 }\n'],
  ["a plain env key set to a built string", 'exports.main = (dir) => { process.env.FOO = dir + "/x" }\n'],
  ["a plain env key set to a template", 'exports.main = (dir) => { process.env.FOO = `${dir}/x` }\n'],
  ["process.on with a statement on the next line", 'process.on("exit", () => 1)\nconsole.log("x")\nexports.main = () => 1\n'],
  ["typeof of a runtime global", 'exports.main = () => [typeof globalThis.Bun, typeof globalThis.Deno, typeof global.gc]\n'],
  ["globalThis.Object.keys", 'exports.main = () => globalThis.Object.keys({})\n'],
  ["the platform as a file name selector", 'exports.main = () => require("./bin/" + process.platform)\n'],
] as const) {
  test(`${label} does not widen the closure (round 27)`, () => expect(widensAll(pre)).toBe(false));
}
test("a class field named function with no initializer before a method taking process widens (round 27)", () => {
  expect(widensAll('class C { function;\n m = run(process) }\nexports.main = () => new C()\n')).toBe(true);
});
for (const [label, pre] of [
  ["in before a global chain", 'exports.main = (o) => "x" in globalThis.document\n'],
  ["instanceof with a global chain", 'exports.main = (o) => o instanceof globalThis.URL\n'],
] as const) {
  test(`${label} stays static (round 27)`, () => expect(held(pre)).toBe(false));
}

// Round 28: writes through a pattern, a loop head, ++, -- and delete follow the target rule; a join with a computed suffix.
for (const [label, pre] of [
  ["an array pattern target", 'exports.main = () => { [process.env.NODE_OPTIONS] = ["--require ./docs/payload.txt"] }\n'],
  ["an object pattern target", 'exports.main = () => { ({ x: process.env.NODE_OPTIONS } = { x: "--require ./docs/payload.txt" }) }\n'],
  ["a nested pattern target", 'exports.main = () => { [{ a: process.env.PATH }] = [{ a: "./docs" }] }\n'],
  ["a for-of head target", 'exports.main = (xs) => { for (process.env.NODE_OPTIONS of xs) { } }\n'],
  ["a for-in head target", 'exports.main = (o) => { for (process.env.NODE_PATH in o) { } }\n'],
  ["an increment of a steering variable", 'exports.main = () => { process.env.NODE_OPTIONS++ }\n'],
  ["a delete of a steering variable", 'exports.main = () => { delete process.env.PATH }\n'],
  ["Object.assign on process.env", 'exports.main = (o) => { Object.assign(process.env, o) }\n'],
  ["Object.defineProperty on process.env", 'exports.main = () => { Object.defineProperty(process.env, "NODE_OPTIONS", { value: "--require ./docs/payload.txt" }) }\n'],
  ["Reflect.set on process.env", 'exports.main = () => { Reflect.set(process.env, "NODE_OPTIONS", "--require ./docs/payload.txt") }\n'],
  ["a whole env replacement", 'exports.main = (o) => { process.env = o }\n'],
  ["a computed env key write", 'exports.main = (k, v) => { process.env[k] = v }\n'],
  ["a join with a spread suffix", 'const path = require("path");\nexports.main = (x) => require(path.join(process.cwd(), "hooks", ...x))\n'],
  ["a join with a name as the second segment", 'const path = require("path");\nexports.main = (x) => require(path.join(process.cwd(), x))\n'],
  ["a join with a call as a later segment", 'const path = require("path");\nexports.main = (x) => require(path.join(process.cwd(), "a", f(x)))\n'],
] as const) {
  test(`${label} widens the closure (round 28)`, () => expect(widensAll(pre)).toBe(true));
}
for (const [label, pre] of [
  ["an array pattern target", 'exports.main = () => { [process.env.NODE_OPTIONS] = ["--require ./docs/payload.txt"] }\n'],
  ["an object pattern target", 'exports.main = () => { ({ x: process.env.NODE_OPTIONS } = { x: "--require ./docs/payload.txt" }) }\n'],
  ["a join with a spread suffix", 'const path = require("path");\nexports.main = (x) => require(path.join(process.cwd(), "hooks", ...x))\n'],
] as const) {
  test(`${label} holds a changed payload outside the hook directory (round 28)`, () => expect(widensDocs(pre)).toBe(true));
}
for (const [label, pre] of [
  ["an array pattern into exitCode", 'exports.main = (c) => { [process.exitCode] = [c] }\n'],
  ["an increment of exitCode", 'exports.main = () => { process.exitCode++ }\n'],
  ["a delete of a plain env key", 'exports.main = () => { delete process.env.FOO }\n'],
  ["a computed index that reads an env value", 'exports.main = (a) => { a[process.env.NODE_OPTIONS] = 1 }\n'],
  ["a spread of process.env", 'exports.main = () => ({ ...process.env, X: "1" })\n'],
  ["a join with literal segments only", 'const path = require("path");\nexports.main = () => require(path.join(process.cwd(), "hooks", "x.js"))\n'],
] as const) {
  test(`${label} does not widen the closure (round 28)`, () => expect(widensAll(pre)).toBe(false));
}

// Round 28b: keys of a destructuring pattern, a ternary far from its key, a keyword before a line break, steering names as keys
// or through an alias, comments and ternaries around .constructor, the join callee.
const pad = " ".repeat(60);
for (const [label, pre] of [
  ["a quoted pattern key chain", 'exports.main = () => { const { "constructor": { "constructor": F } } = []; return F(process.env.X)() }\n'],
  ["a bare pattern key chain", 'exports.main = () => { const { constructor: { constructor: F } } = []; return F(process.env.X)() }\n'],
  ["a parameter pattern key chain", 'exports.main = ({ "constructor": { "constructor": F } }) => F(process.env.X)()\n'],
  ["a bare parameter pattern key chain", 'exports.main = ({ constructor: { constructor: F } }) => F(process.env.X)()\n'],
  ["an assignment pattern key chain", 'let F; exports.main = () => { ({ "constructor": { "constructor": F } } = []); return F(process.env.X)() }\n'],
  ["a ternary consequent far from its key", `exports.main = (c) => [][c ?${pad}"constructor" : ""][c ?${pad}"constructor" : ""](process.env.X)()\n`],
  ["an await before process.on on the next line", 'const p = await\nprocess.on("exit", () => 1)\nexports.main = () => p["x"]\n'],
  ["export default before process.on on the next line", 'export default\nprocess.on("exit", () => 1)\n'],
  ["a spawn env object with NODE_OPTIONS", 'exports.main = () => run("node", { env: { ...process.env, NODE_OPTIONS: "--require ./docs/payload.txt" } })\n'],
  ["a spawn env object with a quoted LD_PRELOAD key", 'exports.main = () => run("node", { env: { ...process.env, "LD_PRELOAD": "./docs/payload.txt" } })\n'],
  ["an alias of process.env written through", 'exports.main = () => { const e = process.env; e.NODE_OPTIONS = "--require ./docs/payload.txt" }\n'],
  ["process.env passed to a call", 'exports.main = () => run(process.env)\n'],
  ["a join named by something other than path", 'const path = require("path");\nfunction join(a, b) { return b }\nexports.main = (x) => require(path.join(process.cwd(), x))\n'],
] as const) {
  test(`${label} widens the closure (round 28b)`, () => expect(widensAll(pre)).toBe(true));
}
for (const [label, pre] of [
  ["a quoted pattern key chain", 'exports.main = () => { const { "constructor": { "constructor": F } } = []; return F(process.env.X)() }\n'],
  ["a bare pattern key chain", 'exports.main = () => { const { constructor: { constructor: F } } = []; return F(process.env.X)() }\n'],
  ["a spawn env object with NODE_OPTIONS", 'exports.main = () => run("node", { env: { ...process.env, NODE_OPTIONS: "--require ./docs/payload.txt" } })\n'],
] as const) {
  test(`${label} holds a changed payload outside the hook directory (round 28b)`, () => expect(widensDocs(pre)).toBe(true));
}
for (const [label, pre] of [
  ["an object literal with a constructor key", 'function Foo() {}\nFoo.prototype = { constructor: Foo };\nexports.main = () => new Foo()\n'],
  ["an object literal with a quoted constructor key", 'function Foo() {}\nFoo.prototype = { "constructor": Foo };\nexports.main = () => new Foo()\n'],
  ["a comment that names .constructor(x)", '// obj.constructor(x)\nexports.main = () => 1\n'],
  ["a message that names .constructor(x)", 'exports.main = () => console.log("obj.constructor(x)")\n'],
  ["a ternary after .constructor", 'exports.main = (x) => x.constructor ? [1] : [2]\n'],
  ["a spread of process.env", 'exports.main = () => ({ ...process.env, X: "1" })\n'],
  ["process.on after a statement on the previous line", 'const a = 1\nprocess.on("exit", () => 1)\nexports.main = () => a\n'],
  ["an env object with an ordinary key", 'exports.main = () => run("node", { env: { ...process.env, FOO: "1" } })\n'],
  ["path.join of cwd() with literal segments", 'const path = require("path");\nexports.main = () => require(path.join(process.cwd(), "a", "b.js"))\n'],
] as const) {
  test(`${label} does not widen the closure (round 28b)`, () => expect(widensAll(pre)).toBe(false));
}

// Round 28c: a literal with a constructor key in a condition, a join without the path module, entries naming a steering variable.
for (const [label, pre] of [
  ["an object literal with a constructor key inside an if condition", 'exports.main = (f) => { if (f({ constructor: 1 })) { return 1 } }\n'],
  ["an object literal with a constructor key inside a while condition", 'exports.main = (f) => { while (f({ constructor: 1 })) { return 1 } }\n'],
  ["an object literal with a constructor key as a statement argument", 'exports.main = (f) => { f({ constructor: 1 }); return 1 }\n'],
  ["an object literal with a constructor key returned", 'exports.main = () => { return { constructor: 1 } }\n'],
  ["an array literal that does not start with a steering name", 'exports.main = () => ["HOME", "PATH"]\n'],
  ["an index by a steering name", 'exports.main = (e) => e["PATH"]\n'],
] as const) {
  test(`${label} does not widen the closure (round 28c)`, () => expect(widensAll(pre)).toBe(false));
}
for (const [label, pre] of [
  ["a join of cwd() when the file loads no path module", 'exports.main = () => require(path.join(process.cwd(), "x.js"))\n'],
  ["entries that start with a steering name", 'exports.main = () => run("node", { env: Object.fromEntries([["NODE_OPTIONS", "--require ./docs/payload.txt"]]) })\n'],
  ["a parameter default with a constructor key", 'exports.main = (a = { constructor: 1 }) => a\nfunction g({ constructor: { constructor: F } }) { return F(process.env.X)() }\n'],
] as const) {
  test(`${label} widens the closure (round 28c)`, () => expect(widensAll(pre)).toBe(true));
}

// Round 28d: a process member inside a pattern is a write only when it is the target.
for (const [label, pre] of [
  ["a pattern element that indexes another value by a steering variable", 'exports.main = (a) => { [a[process.env.NODE_OPTIONS]] = [1] }\n'],
  ["a default initializer that reads cwd()", 'exports.main = () => { let x; [x = process.cwd()] = [] }\n'],
  ["a default initializer that reads a steering variable", 'exports.main = () => { let x; [x = process.env.PATH] = [] }\n'],
] as const) {
  test(`${label} does not widen the closure (round 28d)`, () => expect(widensAll(pre)).toBe(false));
}
for (const [label, pre] of [
  ["a target with a default value", 'exports.main = () => { [process.env.NODE_OPTIONS = "x"] = [] }\n'],
  ["a later array element target", 'exports.main = (a) => { let x; [x, process.env.NODE_OPTIONS] = [1, 2] }\n'],
  ["a rest target", 'exports.main = () => { [...process.env.NODE_OPTIONS] = [1] }\n'],
  ["an object pattern value target", 'exports.main = () => { ({ a: process.env.PATH } = { a: 1 }) }\n'],
] as const) {
  test(`${label} widens the closure (round 28d)`, () => expect(widensAll(pre)).toBe(true));
}

// White space of any length between a pattern and what follows it, or between a write and its operator.
const gap = "\n" + " ".repeat(40);
for (const [label, pre] of [
  ["a bare parameter pattern before a far function body", `exports.main = function(${gap}{ constructor: { constructor: F } }${gap})${gap}{ return F(process.env.X)() }\n`],
  ["a quoted parameter pattern before a far function body", `exports.main = function(${gap}{ "constructor": { "constructor": F } }${gap})${gap}{ return F(process.env.X)() }\n`],
  ["a pattern with a far =", `let F;\nexports.main = () => { ({ "constructor": { "constructor": F } }${gap}= []); return F(process.env.X)() }\n`],
  ["a far ++ on a steering variable", `exports.main = () => { process.env.NODE_OPTIONS${gap}++ }\n`],
  ["a far delete of a steering variable", `exports.main = () => { delete${gap}process.env.PATH }\n`],
  ["a pattern target followed by a far =", `exports.main = () => { [process.env.NODE_OPTIONS]${gap}= [1] }\n`],
] as const) {
  test(`${label} widens the closure (round 28d)`, () => expect(widensAll(pre)).toBe(true));
}

// Round 28e: reads inside patterns, a bare process.env as a copy or a reader argument, for heads, case, join bindings, steering keys.
for (const [label, pre] of [
  ["a default initializer in a parameter pattern", 'function build({ root = process.cwd() } = {}) { return root }\nexports.main = () => build()\n'],
  ["defaults in a destructuring declaration", 'exports.main = (opts) => { const { cwd = process.cwd(), platform = process.platform } = opts; return [cwd, platform] }\n'],
  ["a computed key in a pattern", 'exports.main = (impls) => { const { [process.platform]: impl } = impls; return impl }\n'],
  ["a line ending in i++ before process.stdout.write", 'exports.main = (s) => { let i = 0\ni++\nprocess.stdout.write(s) }\n'],
  ["an object key named ENV", 'exports.main = () => ({ ENV: "production", PATH: "x" })\n'],
  ["a destructured PATH from the environment", 'exports.main = () => { const { PATH: p } = process.env; return p }\n'],
  ["a join bound from the path module", 'const { join } = require("node:path");\nexports.main = () => require(join(process.cwd(), "x.js"))\n'],
  ["a join through a local alias of the path module", 'const p = require("node:path");\nexports.main = () => require(p.join(process.cwd(), "x.js"))\n'],
  ["path.posix.join", 'const path = require("path");\nexports.main = () => require(path.posix.join(process.cwd(), "x.js"))\n'],
] as const) {
  test(`${label} does not widen the closure (round 28e)`, () => expect(widensAll(pre)).toBe(false));
}
for (const [label, pre] of [
  ["a for-of head with an array pattern target", 'exports.main = (xs) => { for ([process.env.NODE_OPTIONS] of xs) { } }\n'],
  ["a for-of head with an object pattern target", 'exports.main = (xs) => { for ({ a: process.env.PATH } of xs) { } }\n'],
  ["a for-of head with a computed env key", 'exports.main = (xs, k) => { for (process.env[k] of xs) { } }\n'],
  ["a lower-case steering variable written", 'exports.main = () => { process.env.node_options = "--require ./docs/payload.txt" }\n'],
  ["a mixed-case steering key in an object", 'exports.main = () => run("node", { env: { ...process.env, Node_Options: "--require ./docs/payload.txt" } })\n'],
  ["a join that is a local function", 'const path = require("path");\nfunction join(a, b) { return b }\nexports.main = () => require(join(process.cwd(), "x.js"))\n'],
  ["a resolve that is a local function with path loaded", 'const path = require("path");\nfunction resolve(a, b) { return b }\nexports.main = (x) => require(resolve(process.cwd(), "x.js"))\n'],
  ["a steering name written on a copied environment", 'exports.main = () => { const env = {}; env.NODE_OPTIONS = "--require ./docs/payload.txt"; return env }\n'],
  ["a steering name written through an index on a copy", 'exports.main = () => { const env = {}; env["NODE_OPTIONS"] = "--require ./docs/payload.txt"; return env }\n'],
  ["a computed steering key in a literal", 'exports.main = () => ({ ["NODE_OPTIONS"]: "--require ./docs/payload.txt" })\n'],
  ["process.env bound to a name", 'exports.main = () => { const e = process.env; return e }\n'],
  ["process.env returned", 'exports.main = () => process.env\n'],
  ["a bracket pattern after else", 'exports.main = (v, c) => { if (c) { } else [process.env.NODE_OPTIONS] = [v] }\n'],
  ["a delete of a parenthesized steering variable", 'exports.main = () => { delete (process.env.PATH) }\n'],
] as const) {
  test(`${label} widens the closure (round 28e)`, () => expect(widensAll(pre)).toBe(true));
}

// Round 28f: the live process.env must not escape through an object, a binding or a reader with a second argument.
const K = '["NODE_", "OPTIONS"].join("")';
for (const [label, pre] of [
  ["an env object bound and written through", `const o = { env: process.env };\nexports.main = () => { o.env[${K}] = "--require ./docs/payload.txt" }\n`],
  ["an env object written through Reflect.set", `const o = { env: process.env };\nexports.main = () => { Reflect.set(o.env, ${K}, "--require ./docs/payload.txt") }\n`],
  ["an env object written through Object.assign", `const o = { env: process.env };\nexports.main = () => { Object.assign(o.env, { [${K}]: "--require ./docs/payload.txt" }) }\n`],
  ["an env object taken out by a pattern", `let e;\nexports.main = () => { ({ e } = { e: process.env }); e[${K}] = "--require ./docs/payload.txt" }\n`],
  ["an env object passed to a function that writes", `function f(o) { o.env[${K}] = "--require ./docs/payload.txt" }\nexports.main = () => f({ env: process.env })\n`],
  ["an env object in an array", `const a = [{ env: process.env }];\nexports.main = () => { a[0].env[${K}] = "--require ./docs/payload.txt" }\n`],
  ["an env object with a method", `exports.main = () => ({ env: process.env, m() { this.env[${K}] = "--require ./docs/payload.txt" } }).m()\n`],
  ["a JSON.stringify replacer", `exports.main = () => JSON.stringify(process.env, function (k, v) { this[${K}] = "--require ./docs/payload.txt"; return v })\n`],
] as const) {
  test(`${label} holds a changed payload outside the hook directory (round 28f)`, () => expect(widensDocs(pre)).toBe(true));
}
for (const [label, pre] of [
  ["a function that only has String in its name", 'exports.main = () => { const e = asString(process.env); return e }\n'],
  ["a method named String", 'exports.main = () => { const e = obj.String(process.env); e.PATH = "/x"; return e }\n'],
  ["a shadowed Object", 'const Object = { keys: (e) => e };\nexports.main = () => { const e = Object.keys(process.env); e.PATH = "/tmp/bin" }\n'],
  ["a shadowed JSON", 'const JSON = { stringify: (e) => e };\nexports.main = () => { const e = JSON.stringify(process.env); e.PATH = "/tmp/bin" }\n'],
  ["a String call that assigns", 'exports.main = () => { let e; String(e = process.env); e.PATH = "/x" }\n'],
  ["a conditional else branch returned", 'exports.main = (c) => { return c ? {} : process.env }\n'],
  ["a conditional else branch bound", 'exports.main = (c) => { const e = c ? 0 : process.env; return e }\n'],
  ["a line break before ++ and its operand", 'exports.main = () => { let a;\n++\nprocess.env.PATH }\n'],
  ["a far delete with parentheses", `exports.main = () => { delete${gap}(process.env.PATH) }\n`],
  ["a far for head with an index", `exports.main = (xs, k) => { for${gap}(process.env[k] of xs) { } }\n`],
  ["a parenthesized array pattern target", 'exports.main = (v) => { [(process.env.NODE_OPTIONS)] = [v] }\n'],
  ["a parenthesized object pattern target", 'exports.main = (o) => { ({ a: (process.env.PATH) } = o) }\n'],
  ["a parenthesized target in a for-of head", 'exports.main = (xs) => { for ([(process.env.NODE_OPTIONS)] of xs) { } }\n'],
  ["a pattern after an if header", 'exports.main = (c, v) => { if (c) [process.env.NODE_OPTIONS] = [v] }\n'],
  ["a PATH key next to a spread of process.env", 'exports.main = () => run("x", { env: { ...process.env, PATH: "./docs/bin:" + process.env.PATH } })\n'],
  ["a PATH key under an env key", 'exports.main = (d) => ({ env: { PATH: d } })\n'],
] as const) {
  test(`${label} widens the closure (round 28f)`, () => expect(widensAll(pre)).toBe(true));
}
for (const [label, pre] of [
  ["a statement ending in i++ before the next line", 'exports.main = (s) => { let i = 0\ni++\nprocess.stdout.write(s) }\n'],
  ["a PATH key in an unrelated object", 'exports.main = () => ({ PATH: "x" })\n'],
  ["a join bound by const x = require(path).join", 'const join = require("path").join;\nexports.main = () => require(join(process.cwd(), "x.js"))\n'],
] as const) {
  test(`${label} does not widen the closure (round 28f)`, () => expect(widensAll(pre)).toBe(false));
}

// Round 28g: a reader or a spawn that the file can redefine does not make the environment harmless.
const KK = '["NODE_", "OPTIONS"].join("")';
for (const [label, pre] of [
  ["a reassigned Object.keys", `Object.keys = (e) => { e[${KK}] = "--require ./docs/payload.txt"; return [] };\nexports.main = () => Object.keys(process.env)\n`],
  ["a reassigned global String", `globalThis.String = (e) => { e[${KK}] = "--require ./docs/payload.txt"; return "" };\nexports.main = () => String(process.env)\n`],
  ["a toString hook on Object.prototype", `Object.prototype.toString = function () { this[${KK}] = "--require ./docs/payload.txt"; return "" };\nexports.main = () => String(process.env)\n`],
  ["a toJSON hook defined on Object.prototype", `Object.defineProperty(Object.prototype, "toJSON", { value() { this[${KK}] = "--require ./docs/payload.txt"; return 1 } });\nexports.main = () => JSON.stringify(process.env)\n`],
  ["a hook on Object.prototype with Object.keys of the environment", `Object.prototype.k = function () { this[${KK}] = "--require ./docs/payload.txt" };\nexports.main = () => Object.keys(process.env)\n`],
  ["a local function named spawn", `function spawn(a, o) { o.env[${KK}] = "--require ./docs/payload.txt" }\nexports.main = () => spawn("x", { env: process.env })\n`],
  ["a method named spawn", `const o = { spawn: (a, x) => { x.env[${KK}] = "--require ./docs/payload.txt" } };\nexports.main = () => o.spawn("x", { env: process.env })\n`],
  ["a local arrow named exec", `const exec = (a, x) => { x.env[${KK}] = "--require ./docs/payload.txt" };\nexports.main = () => exec("x", { env: process.env })\n`],
  ["a computed PATH key beside a spread of the environment", `exports.main = () => ({ ...process.env, [["PA", "TH"].join("")]: "./docs/bin" })\n`],
  ["String of the environment", 'exports.main = () => String(process.env)\n'],
  ["JSON.stringify of the environment", 'exports.main = () => JSON.stringify(process.env)\n'],
] as const) {
  test(`${label} holds a changed payload outside the hook directory (round 28g)`, () => expect(widensDocs(pre)).toBe(true));
}

// Round 28h: a differently named process alias, bound joins, isolated spawn checks, binding contexts, PATH keys.
const KH = '["NODE_", "OPTIONS"].join("")';
const SP = 'const { spawn } = require("node:child_process");\n';
test("a process alias of another length in a reader does not throw and leaves no scanner fault (round 28h)", async () => {
  const { scannerFaultCount } = await import("../src/install-closure.ts");
  const before = scannerFaultCount();
  for (const pre of [
    'const proc = require("process");\nconst { spawn } = require("node:child_process");\nexports.main = () => spawn("x", [], { env: proc.env })\n',
    'const p = require("node:process");\nexports.main = () => Object.keys(p.env)\n',
    'const processModule = require("process");\nexports.main = () => Object.entries(processModule.env)\n',
  ]) expect(typeof widensAll(pre)).toBe("boolean");
  expect(scannerFaultCount()).toBe(before);
});
for (const [label, pre] of [
  ["a name for the process module bound and written through", 'const proc = require("process");\nexports.main = () => { const e = proc.env; e[["NODE_", "OPTIONS"].join("")] = "--require ./docs/payload.txt" }\n'],
  ["a join bound with bind", 'const j = require("path").join.bind(null, "/elsewhere");\nexports.main = () => require(j(process.cwd(), "x.js"))\n'],
  ["a join bound with bind on a module name", 'const p = require("path");\nconst j = p.join.bind(null, "/elsewhere");\nexports.main = () => require(j(process.cwd(), "x.js"))\n'],
  ["env in spawn options next to a __proto__ key", `${SP}exports.main = () => spawn("x", [], { __proto__: P, env: process.env })\n`],
  ["env in spawn options next to a getter", `${SP}exports.main = () => spawn("x", [], { get z() { return 1 }, env: process.env })\n`],
  ["env in spawn options next to a method", `${SP}exports.main = () => spawn("x", [], { z() { return 1 }, env: process.env })\n`],
  ["env in a literal that is not a direct argument", `${SP}exports.main = (c) => spawn("x", [], c && { env: process.env })\n`],
  ["env in spawn options followed by an operator", `${SP}exports.main = () => spawn("x", [], { env: process.env + "" })\n`],
  ["a destructured spawn that the file redefines", 'const { spawn } = require("node:child_process");\nfunction run() { spawn = (a, b, o) => { o.env[["NODE_", "OPTIONS"].join("")] = "--require ./docs/payload.txt" } }\nexports.main = () => spawn("x", [], { env: process.env })\n'],
  ["a spawn name shadowed by a function", `${SP}function spawn(a, b, o) { o.env[["NODE_", "OPTIONS"].join("")] = "--require ./docs/payload.txt" }\nexports.main = () => spawn("x", [], { env: process.env })\n`],
  ["a with block next to Object.keys of the environment", 'exports.main = (o) => { with (o) { return Object.keys(process.env) } }\n'],
  ["a member call spelled with a space after the dot", 'exports.main = (obj) => obj. Object.keys(process.env)\n'],
  ["Object bound by an array pattern", 'const [Object] = [{ keys: (e) => { e[["NODE_", "OPTIONS"].join("")] = "--require ./docs/payload.txt"; return [] } }];\nexports.main = () => Object.keys(process.env)\n'],
  ["Object bound by a destructured arrow parameter", 'const f = ({ Object }) => Object.keys(process.env);\nexports.main = () => f({ Object: { keys: (e) => { e[["NODE_", "OPTIONS"].join("")] = "x"; return [] } } })\n'],
  ["Object bound by a catch pattern", 'exports.main = () => { try { throw { Object: { keys: (e) => { e[["NODE_", "OPTIONS"].join("")] = "x"; return [] } } } } catch ({ Object }) { return Object.keys(process.env) } }\n'],
  ["Object bound by a function parameter", 'function f(Object) { return Object.keys(process.env) }\nexports.main = () => f({ keys: (e) => { e[["NODE_", "OPTIONS"].join("")] = "x"; return [] } })\n'],
  ["Object.values after a reassignment of Object.values", 'Object.values = (e) => { e[["NODE_", "OPTIONS"].join("")] = "--require ./docs/payload.txt"; return [] };\nexports.main = () => Object.values(process.env)\n'],
  ["Object.assign of the environment with a PATH key", 'exports.main = (d) => Object.assign({}, process.env, { PATH: d })\n'],
  ["a shorthand PATH next to a spread of the environment", 'exports.main = (PATH) => ({ ...process.env, PATH })\n'],
  ["opts.env set to an object with PATH", 'exports.main = (d, opts) => { opts.env = { PATH: d } }\n'],
  ["a quoted env key holding a PATH key", 'exports.main = (d) => ({ "env": { PATH: d } })\n'],
  ["a PATH assigned on a copy of the environment", 'exports.main = (d) => { const copy = { ...process.env }; copy.PATH = d; return copy }\n'],
  ["an entries pair that starts with PATH", 'exports.main = (d) => Object.fromEntries([["PATH", d]].concat(Object.entries(process.env)))\n'],
] as const) {
  test(`${label} widens the closure (round 28h)`, () => expect(widensAll(pre)).toBe(true));
}
for (const [label, pre] of [
  ["a join bound without bind", 'const join = require("path").join;\nexports.main = () => require(join(process.cwd(), "x.js"))\n'],
] as const) {
  test(`${label} does not widen the closure (round 28h)`, () => expect(widensAll(pre)).toBe(false));
}

// Round 28i: the live process.env is never handed on: not to a spawn, not to Object readers, not to any function. A name that
// the file can reassign or alias (cp.spawn = ..., Object[k] = ..., const O = Object) cannot be trusted, so nothing is trusted.
const KI = '["NODE_", "OPTIONS"].join("")';
for (const [label, pre] of [
  ["a reassigned child_process member", `const cp = require("child_process");\ncp.spawn = (a, b, x) => { x.env[${KI}] = "--require ./docs/payload.txt" };\nexports.main = () => cp.spawn("x", [], { env: process.env })\n`],
  ["a computed write to a child_process member", `const cp = require("child_process");\ncp[["sp", "awn"].join("")] = (a, b, x) => { x.env[${KI}] = "--require ./docs/payload.txt" };\nexports.main = () => cp.spawn("x", [], { env: process.env })\n`],
  ["a computed write to an Object member", `Object[["ke", "ys"].join("")] = (e) => { e[${KI}] = "--require ./docs/payload.txt"; return [] };\nexports.main = () => Object.keys(process.env)\n`],
  ["an alias of Object written through", `const O = Object;\nO.keys = (e) => { e[${KI}] = "--require ./docs/payload.txt"; return [] };\nexports.main = () => Object.keys(process.env)\n`],
] as const) {
  test(`${label} holds a changed payload outside the hook directory (round 28i)`, () => expect(widensDocs(pre)).toBe(true));
}
for (const [label, pre] of [
  ["env passed as a spawn option", 'const { spawn } = require("node:child_process");\nexports.main = () => spawn("node", ["a.js"], { env: process.env })\n'],
  ["Object.keys of process.env", 'exports.main = () => Object.keys(process.env).length\n'],
  ["Object.entries of process.env", 'exports.main = () => Object.entries(process.env).length\n'],
  ["Object.assign into a new object", 'exports.main = () => Object.assign({}, process.env, { A: "1" })\n'],
  ["env handed straight to a spawn call", 'const { spawn } = require("node:child_process");\nexports.main = () => spawn("node", ["a.js"], { env: process.env, stdio: "inherit" })\n'],
  ["env handed straight to cp.fork", 'const cp = require("child_process");\nexports.main = () => cp.fork("a.js", { env: process.env })\n'],
  ["env handed to an imported spawn under another name", 'import { spawn as sp } from "node:child_process";\nexports.main = () => sp("node", { env: process.env })\n'],
  ["a name for the process module in a spawn", 'const proc = require("process");\nconst { spawn } = require("node:child_process");\nexports.main = () => spawn("x", [], { env: proc.env })\n'],
  ["console.log(Object) next to Object.entries of the environment", 'console.log(Object);\nexports.main = () => Object.entries(process.env)\n'],
  ["console.log(String) next to Object.values of the environment", 'console.log(String);\nexports.main = () => Object.values(process.env)\n'],
  ["Object.values of the environment", 'exports.main = () => Object.values(process.env).length\n'],
] as const) {
  test(`${label} widens the closure (round 28i)`, () => expect(widensAll(pre)).toBe(true));
}

// Round 28j: a pattern that rebinds Object.keys, and an inline child_process spawn with the environment: neither is trusted.
test("a pattern assignment into Object.keys before Object.keys of the environment holds the payload (round 28j)", () => {
  expect(widensDocs('const helper = (e) => { e[["NODE_", "OPTIONS"].join("")] = "--require ./docs/payload.txt"; return [] };\n({ keys: Object.keys } = { keys: helper });\nexports.main = () => Object.keys(process.env)\n')).toBe(true);
});
test("an inline child_process spawn with the environment widens: the accepted cost of not trusting spawn (round 28j)", () => {
  expect(widensAll('exports.main = () => require("child_process").spawn("node", ["-e", ""], { env: process.env })\n')).toBe(true);
});

// Round 28k: speed on a large minified file, and a fault in each scanner entry point reads as "widen everything".
test("a 1 MB minified hook with 100k brackets and 10k process.env mentions is scanned in under 4 seconds (round 28k)", () => {
  let hook = "";
  for (let i = 0; i < 10000; i++) hook += `f(a[${i}],{b:[(${i})]},process.env.X${i});`;
  while (hook.length < 1_000_000) hook += "g(h({a:[1,(2)]}));";
  const rel = (v: string) => release(v, hook);
  const started = performance.now();
  holds(rel("1.0.0"), rel("1.0.1"));
  expect(performance.now() - started).toBeLessThan(4000);
});

const withThrowOn = (marker: string, fn: () => void) => {
  const real = RegExp.prototype.test;
  RegExp.prototype.test = function (this: RegExp, text: string): boolean {
    if (this.source.includes(marker)) throw new Error("injected fault");
    return real.call(this, text);
  };
  try {
    fn();
  } finally {
    RegExp.prototype.test = real;
  }
};
for (const [label, marker, verdict, pre, normal] of [
  ["the static check", "worker_threads", held, 'exports.main = () => 1\n', false],
  ["the hazard scan", String.raw`require\s*\.\s*resolve`, widensAll, 'exports.main = (x) => require(x)\n', false],
  ["the unbounded scan", String.raw`constructor\s*(?:\?\.|\.)\s*constructor`, widensAll, 'exports.main = (x) => require(x)\n', false],
] as const) {
  test(`a fault in ${label} widens the closure and is counted (round 28k)`, () => {
    allowFaults();
    const before = scannerFaultCount();
    let widened = false;
    withThrowOn(marker, () => {
      widened = verdict(pre);
    });
    expect(widened).toBe(true);
    expect(scannerFaultCount()).toBeGreaterThan(before);
    // The next ordinary scan works.
    expect(verdict(pre)).toBe(normal);
  });
}

// Round 28l: a fault inside the closure walk is a hold, never a narrow closure, through the whole prepass.
const withThrowOnMatchAll = (inFunction: string, fn: () => void) => {
  const real = String.prototype.matchAll;
  String.prototype.matchAll = function (this: string, re: RegExp): ReturnType<typeof real> {
    if (new Error().stack?.includes(inFunction)) throw new RangeError("injected fault");
    return real.call(this, re);
  };
  try {
    fn();
  } finally {
    String.prototype.matchAll = real;
  }
};
const withSub = (v: string, hook = 'require("./sub/payload.js");\n') =>
  files({
    "package.json": JSON.stringify({ name: "cli", version: v, scripts: { install: "node hook.js" } }),
    "hook.js": hook,
    "sub/payload.js": `module.exports = "${v}"\n`,
  });
test("the walk of a file's literal loads finds a changed payload without a fault (round 28l)", () => {
  expect(holds(withSub("1"), withSub("2")).length).toBeGreaterThan(0);
});
for (const [label, marker] of [
  ["followLoads", "followLoadsScan"],
  ["classifyJs", "classifyJsScan"],
  ["widenJs", "widenJsScan"],
] as const) {
  test(`a fault in ${label} holds the changed payload through the full prepass (round 28l)`, () => {
    allowFaults();
    const before = scannerFaultCount();
    let found: string[] = [];
    withThrowOnMatchAll(marker, () => {
      const hook = label === "followLoads" ? undefined : 'require("./sub/payload.js");\nrequire(process.argv[2]);\n';
      found = holds(withSub("1", hook), withSub("2", hook));
    });
    expect(scannerFaultCount()).toBeGreaterThan(before);
    expect(found.length).toBeGreaterThan(0);
  });
}
test("a fault in classifyJs widens a non-static hook to the whole package (round 28l)", () => {
  allowFaults();
  let widened = false;
  withThrowOnMatchAll("classifyJsScan", () => {
    widened = widensAll('exports.main = (x) => require(x)\n');
  });
  expect(widened).toBe(true);
});

// Round 28m: each scanner entry point answers conservatively on its own fault, a deep chain and mismatched brackets are read
// cautiously, the environment object bound by destructuring and compound writes of PATH.
const faultOn = (marker: string, fn: () => void) => {
  allowFaults();
  const real = RegExp.prototype.test;
  RegExp.prototype.test = function (this: RegExp, text: string): boolean {
    if (this.source.includes(marker)) throw new Error("injected fault");
    return real.call(this, text);
  };
  try {
    fn();
  } finally {
    RegExp.prototype.test = real;
  }
};
test("provablyStatic answers not static on its own fault (round 28m)", () => {
  const before = scannerFaultCount();
  faultOn("worker_threads", () => expect(provablyStatic("exports.main = () => 1\n")).toBe(false));
  expect(scannerFaultCount()).toBe(before + 1);
});
test("processHazard answers hazard on its own fault (round 28m)", () => {
  const before = scannerFaultCount();
  faultOn(String.raw`require\s*\.\s*resolve`, () => expect(processHazard("exports.main = (x) => require(x)\n")).toBe(true));
  expect(scannerFaultCount()).toBe(before + 1);
});
test("hasUnbounded answers unbounded on its own fault (round 28m)", () => {
  const before = scannerFaultCount();
  faultOn(String.raw`constructor\s*(?:\?\.|\.)\s*constructor`, () => expect(hasUnbounded("exports.main = (x) => require(x)\n", "exports.main = (x) => require(x)\n")).toBe(true));
  expect(scannerFaultCount()).toBe(before + 1);
});
test("a pattern nested deeper than the chain cap reads cautiously, a shallow one does not widen (round 28m)", () => {
  const nest = (n: number) => `exports.main = () => ${"[".repeat(n)}process.platform${"]".repeat(n)}\n`;
  expect(widensAll(nest(8))).toBe(false);
  expect(widensAll(nest(80))).toBe(true);
});
test("mismatched brackets are not static and widen (round 28m)", () => {
  expect(provablyStatic("exports.main = () => [ ( process.platform ]\n")).toBe(false);
  expect(processHazard("exports.main = () => [ ( process.platform ]\n")).toBe(true);
  expect(processHazard("exports.main = () => [ ( ]\n")).toBe(false);
});
for (const [label, pre] of [
  ["env destructured out of process", 'const { env } = process;\nexports.main = () => { env[["NODE_", "OPTIONS"].join("")] = "--require ./docs/payload.txt" }\n'],
  ["an or-assignment of an env object with PATH", 'exports.main = (d, opts) => { opts.env ||= { PATH: d } }\n'],
  ["a nullish assignment of an env object with PATH", 'exports.main = (d, opts) => { opts.env ??= { PATH: d } }\n'],
  ["an and-assignment of an env object with PATH", 'exports.main = (d, opts) => { opts.env &&= { PATH: d } }\n'],
] as const) {
  test(`${label} widens the closure (round 28m)`, () => expect(widensAll(pre)).toBe(true));
}
test("env destructured out of process holds a changed payload (round 28m)", () => {
  expect(widensDocs('const { env } = process;\nexports.main = () => { env[["NODE_", "OPTIONS"].join("")] = "--require ./docs/payload.txt" }\n')).toBe(true);
});

// A computed key that is not a number or one plain string, then called, indexed again or used with new, reaches Function from any
// value ("".["con"+"structor"]["con"+"structor"](code)()). The name is built from parts here so no file spells it whole.
const CTOR = ["con", "structor"].join("");
const FN_ARGS = '("return 1")()';
for (const [label, pre] of [
  ["a key built with join", `const k = ["con", "structor"].join(""); exports.main = () => [][k][k]${FN_ARGS}\n`],
  ["a template key with a substitution", 'const a = "struc"; exports.main = () => [][`con${a}tor`][`con${a}tor`]' + FN_ARGS + "\n"],
  ["an escaped template key", `exports.main = () => [][\`${["constru", "\\x63", "tor"].join("")}\`][\`${["constru", "\\x63", "tor"].join("")}\`]${FN_ARGS}\n`],
  ["a tagged template key", 'const t = (s) => s[0]; exports.main = () => [][t`' + CTOR + '`][t`' + CTOR + "`]" + FN_ARGS + "\n"],
  ["a key that is a function parameter", `function f(k) { return [][k][k]${FN_ARGS} }\nexports.main = () => f(["con", "structor"].join(""))\n`],
  ["a key from fromCharCode", `const k = String.fromCharCode(99, 111, 110, 115, 116, 114, 117, 99, 116, 111, 114); exports.main = () => [][k][k]${FN_ARGS}\n`],
  ["a guarded key used later", `function f(x) { return x === "${CTOR}" ? [][x][x]${FN_ARGS} : 0 }\nexports.main = () => f("${CTOR}")\n`],
  ["a case label then the use", `function f(x) { switch (x) { case "${CTOR}": return [][x][x]${FN_ARGS} } }\nexports.main = () => f("${CTOR}")\n`],
  ["two literals joined into the key", `exports.main = () => [][ "con" + "structor" ][ "con" + "structor" ]${FN_ARGS}\n`],
  ["new through a computed key", `function f(k) { return new [][k][k]("return 1") }\nexports.main = () => f("${CTOR}")()\n`],
  ["an optional chain through a computed key", `function f(k) { return []?.[k]?.[k]?.("return 1")() }\nexports.main = () => f("${CTOR}")\n`],
  ["a key held by a name then called", `function f(o, k) { return o[k]("return 1") }\nexports.main = () => f([].map, "${CTOR}")\n`],
] as const) {
  test(`${label} holds a changed payload (computed chain)`, () => expect(widensDocs(pre)).toBe(true));
}
for (const [label, pre] of [
  ["a read of an array element by a counter", "const a = [1, 2]; let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; exports.main = () => s\n"],
  ["a computed read used as a value", "function g(o, key) { return o[key] }\nexports.main = () => g\n"],
  ["a literal index", "exports.main = () => [1, 2][0]\n"],
  ["a nested literal index", "const t = [[1, 2], [3, 4]]; exports.main = () => t[1][0]\n"],
  ["a key that is a plain string literal", 'const o = { run() { return 1 } }; exports.main = () => o["run"]()\n'],
] as const) {
  test(`${label} stays static (computed chain)`, () => expect(widensDocs(pre)).toBe(false));
}

// A this in sloppy code, the module wrapper's arguments and CallSite objects hand out the global object or require.
// The use of the object is a plain call: only this rule, not the computed-key or process rules, can make these files not static.
const ENVW = (g: string) => `${g}.run()`;
const SLOPPY_THIS = "(function () { return this })()";
for (const [label, pre] of [
  ["a sloppy function returning this, indexed with a built key", `exports.main = () => { const g = ${SLOPPY_THIS}; ${ENVW("g")} }\n`],
  ["a sloppy function returning this.process", `function f() { return this.process }\nexports.main = () => { f().run() }\n`],
  ["a sloppy function binding this to a name", `function f() { const g = this; return g }\nexports.main = () => { ${ENVW("f()")} }\n`],
  ["this from call() with no argument", `exports.main = () => { const t = (function () { return this }).call(); ${ENVW("t")} }\n`],
  ["a string that only starts with the directive", `"use strict" + "ignored"; exports.main = () => { const g = ${SLOPPY_THIS}; ${ENVW("g")} };\n`],
  ["a line that starts with the word import", `imported = 1;\nexports.main = () => { const g = ${SLOPPY_THIS}; ${ENVW("g")} }\n`],
  ["a line that starts with the word importer", `importer = 1;\nexports.main = () => { const g = ${SLOPPY_THIS}; ${ENVW("g")} }\n`],
  ["a directive continued on a far-indented line", `"use strict"\n${" ".repeat(12)}+ 0;\nexports.main = () => { const g = ${SLOPPY_THIS}; ${ENVW("g")} }\n`],
  ["a directive continued by instanceof on the next line", `"use strict"\ninstanceof Object;\nexports.main = () => { const g = ${SLOPPY_THIS}; ${ENVW("g")} }\n`],
  ["a directive continued by in on the next line", `"use strict"\nin {};\nexports.main = () => { const g = ${SLOPPY_THIS}; ${ENVW("g")} }\n`],
  ["a member named import before a line that starts with a name", `const o = {}; o.\nimport\nx = 1;\nexports.main = () => { const g = ${SLOPPY_THIS}; ${ENVW("g")} }\n`],
  ["a member named export before a line that starts with const", `const o = {}; o.\nexport\nconst k = 1;\nexports.main = () => { const g = ${SLOPPY_THIS}; ${ENVW("g")} }\n`],
  ["a directive continued by !=", `"use strict"\n!= 0;\nexports.main = () => { const g = ${SLOPPY_THIS}; ${ENVW("g")} }\n`],
  ["a directive continued by !==", `"use strict"\n!== 0;\nexports.main = () => { const g = ${SLOPPY_THIS}; ${ENVW("g")} }\n`],
  ["a template directive with a comment that quotes the directive", `// "use strict"\n\`use strict\`;\nexports.main = () => { const g = ${SLOPPY_THIS}; ${ENVW("g")} }\n`],
  ["a template directive with a quoted directive inside a function", `\`use strict\`;\nfunction f() { "use strict"; }\nexports.main = () => { const g = ${SLOPPY_THIS}; ${ENVW("g")} }\n`],
  ["a template directive followed by a function that returns this", "`use strict`;\nfunction f(){ return this } const g = f(); console.log(typeof g)"],
  ["a template directive without a semicolon", "`use strict`\nfunction f(){ return this } const g = f(); console.log(typeof g)"],
  ["a template and then a real directive", "`x`;\n\"use strict\";\nfunction f(){ return this } const g = f(); console.log(typeof g)"],
  ["a template directive written with escapes", "`use\\x20strict`;\nfunction f(){ return this } const g = f(); console.log(typeof g)"],
  ["a template directive after a block comment", "/* c */ `use strict`;\nfunction f(){ return this } const g = f(); console.log(typeof g)"],
  ["a template directive after a line comment", "// c\n`use strict`;\nfunction f(){ return this } const g = f(); console.log(typeof g)"],
  ["a template literal that spells the directive", `\`use strict\`;\nexports.main = () => { const g = ${SLOPPY_THIS}; ${ENVW("g")} }\n`],
  ["a directive that a continuing line turns into an expression", `"use strict"\n+ "x";\nexports.main = () => { const g = ${SLOPPY_THIS}; ${ENVW("g")} }\n`],
  ["a spread of this", `const o = { ...this }; ${ENVW("o")};\nexports.main = () => 1\n`],
  ["a spread of arguments", `const o = [...arguments]; ${ENVW("o")};\nexports.main = () => 1\n`],
  ["the top-level this of a strict file", `"use strict";\nconst t = this; ${ENVW("t")};\nexports.main = () => 1\n`],
  ["typeof on a call chain through this", `var r = typeof this[0][1](1);\nexports.main = () => r\n`],
  ["in on a call chain through this", `var r = "x" in this[0][1](1);\nexports.main = () => r\n`],
] as const) {
  test(`${label} is not static`, () => expect(held(pre)).toBe(true));
}
// A { on the line after a ) that is not a parameter list is a block (automatic semicolon insertion), so arguments in it is
// the module wrapper's, not a function's own.
const ASI_BODY = 'const r = arguments[1]; r("child_"+"pro"+"cess")';
const GB = 'const { ["getBuiltin"+"Module"]: gb } = p; gb("child_"+"pro"+"cess");';
for (const [label, pre] of [
  ["arguments in a block after a parenthesized statement", `let x = (1)\n{ ${ASI_BODY} }\nexports.main = () => x\n`],
  ["arguments in a block after void (0)", `void (0)\n{ ${ASI_BODY} }\nexports.main = () => 1\n`],
  ["arguments in a block after typeof (0)", `typeof (0)\n{ ${ASI_BODY} }\nexports.main = () => 1\n`],
  ["arguments in a block after delete (0)", `delete (0)\n{ ${ASI_BODY} }\nexports.main = () => 1\n`],
  ["arguments in a block after a call statement", `f(1)\n{ ${ASI_BODY} }\nexports.main = () => 1\n`],
  ["arguments in a block after a parenthesized statement with CRLF", `let x = (1)\r\n{ ${ASI_BODY} }\nexports.main = () => x\n`],
  ["arguments in a block after a call with a comment between", `f(1) // c\n{ ${ASI_BODY} }\nexports.main = () => 1\n`],
  ["a template directive and then an arguments block", `\`use strict\`\nlet x = (1)\n{ ${ASI_BODY} }\nexports.main = () => x\n`],
  ["arguments in a block after a parenthesized statement that follows a function", `function f(a) { return 1 }\nlet x = (1)\n{ ${ASI_BODY} }\nexports.main = () => x\n`],
  ["a function with its body on the next line and then an arguments block", `function f(a)\n{ return 1 }\nlet x = (1)\n{ ${ASI_BODY} }\nexports.main = () => x\n`],
  // Already held before this change and kept: the value of a sloppy this, a call site's this through an alias of Error, and a
  // template that spells the directive.
  ["this.valueOf() handed on", `function f(){ return this.valueOf() }\nconst p = f().process;\n${GB}\nexports.main = () => 1\n`],
  ["a call site's this through an alias of Error", `const E = Error;\nE.prepareStackTrace = (e, s) => s;\nconst t = new E().stack[0].getThis();\nconst p = t.process;\n${GB}\nexports.main = () => 1\n`],
  ["a template directive and then this handed on", `\`use strict\`;\nfunction f(){ return this }\nconst p = f().process;\n${GB}\nexports.main = () => 1\n`],
] as const) {
  test(`${label} is not static (asi blocks)`, () => expect(held(pre)).toBe(true));
}
for (const [label, pre] of [
  ["arguments in a function declaration with its body on the next line", "function f(a)\n{ return arguments[0] }\nexports.main = () => f(1)\n"],
  ["arguments in a generator declaration with its body on the next line", "function* g(a)\n{ yield arguments[0] }\nexports.main = () => g(1)\n"],
  ["arguments in an async function declaration with its body on the next line", "async function h(a)\n{ return arguments[0] }\nexports.main = () => h(1)\n"],
  ["arguments in a function expression with its body on the next line", "const f = function (a)\n{ return arguments[0] }\nexports.main = () => f(1)\n"],
  ["arguments.length in a block after a parenthesized statement", "let x = (1)\n{ const n = arguments.length }\nexports.main = () => x\n"],
  ["a block after an if with a condition", "if (1)\n{ const y = 2 }\nexports.main = () => 1\n"],
  ["a block after a while", "while (0)\n{ const y = 2 }\nexports.main = () => 1\n"],
  ["arguments in a function with its body on the same line", "function f(a) { return arguments[0] }\nexports.main = () => f(1)\n"],
  ["arguments in a method with its body on the same line", "const o = { m(a) { return arguments[0] } }\nexports.main = () => o.m(1)\n"],
] as const) {
  test(`${label} stays static (asi blocks)`, () => expect(held(pre)).toBe(false));
}
// The function head is found by scanning the whole text, not a window, and a property or a longer identifier named function
// is not the keyword.
const PAD = " ".repeat(72);
for (const [label, pre] of [
  ["a property named function padded past a scan window", `const a = { function() { return 0 } };\na.function${PAD}(1)\n{ ${ASI_BODY} }\nexports.main = () => 1\n`],
  ["an identifier ending in function padded past a scan window", `const xfunction = () => 0;\nxfunction${PAD}(1)\n{ ${ASI_BODY} }\nexports.main = () => 1\n`],
  ["a property named function with a space after the dot", `const o = { function() { return 0 } };\no. function(1)\n{ ${ASI_BODY} }\nexports.main = () => 1\n`],
  ["an optional-chain call named function with a space", `const o = { function() { return 0 } };\no?. function(1)\n{ ${ASI_BODY} }\nexports.main = () => 1\n`],
  ["a property named function on the next line", `const o = { function() { return 0 } };\no\n.function(1)\n{ ${ASI_BODY} }\nexports.main = () => 1\n`],
  ["an identifier with a non-ASCII letter before function", `const ñfunction = () => 0;\nñfunction(1)\n{ ${ASI_BODY} }\nexports.main = () => 1\n`],
  ["an identifier that spells function with a unicode escape", `const \\u0066unction = () => 0;\n\\u0066unction(1)\n{ ${ASI_BODY} }\nexports.main = () => 1\n`],
  ["new on a property named function", `const o = { function: class {} };\nnew o. function(1)\n{ ${ASI_BODY} }\nexports.main = () => 1\n`],
  ["a call statement and a block inside a plain block", `if (x) { f(1)\n{ ${ASI_BODY} } }\nexports.main = () => 1\n`],
  ["a call statement and a block inside a bare block", `{ f(1)\n{ ${ASI_BODY} } }\nexports.main = () => 1\n`],
  ["a call statement and a block inside a case block", `switch (1) { case 1: { f(1)\n{ ${ASI_BODY} } } }\nexports.main = () => 1\n`],
] as const) {
  test(`${label} is not static (asi head)`, () => expect(held(pre)).toBe(true));
}
for (const [label, pre] of [
  ["a declaration with a 72-character name", `function ${"f".repeat(72)}(a)\n{ return arguments[0] }\nexports.main = () => 1\n`],
  ["a declaration with 80 spaces before the name", `function${" ".repeat(80)}f(a)\n{ return arguments[0] }\nexports.main = () => f(1)\n`],
  ["a generator declaration with a long gap", `function${" ".repeat(80)}*${" ".repeat(80)}g(a)\n{ yield arguments[0] }\nexports.main = () => g(1)\n`],
  ["an anonymous function expression with a long gap", `const f = function${" ".repeat(80)}(a)\n{ return arguments[0] }\nexports.main = () => f(1)\n`],
  ["a strict object method with its body on the next line", '"use strict";\nconst o = { m()\n{ return this } };\nexports.main = () => o.m()\n'],
  ["a strict object getter with its body on the next line", '"use strict";\nconst o = { get g()\n{ return this } };\nexports.main = () => o.g\n'],
  ["a strict object async generator method on the next line", '"use strict";\nconst o = { async *gen(a)\n{ return this } };\nexports.main = () => o.gen(1)\n'],
  ["a second strict object method with its body on the next line", '"use strict";\nconst o = { a: 1, m(b)\n{ return this } };\nexports.main = () => o.m(1)\n'],
  ["a computed strict object method with its body on the next line", '"use strict";\nconst k = "m";\nconst o = { [k](a)\n{ return this } };\nexports.main = () => o.m(1)\n'],
  ["a class method with arguments and its body on the next line", "class A { m(a)\n{ return arguments[0] } }\nexports.main = () => new A()\n"],
  ["a static class method with its body on the next line", '"use strict";\nclass A { static m(a)\n{ return this } }\nexports.main = () => A.m(1)\n'],
  ["an object method with arguments and its body on the next line", "const o = { m(a)\n{ return arguments[0] } };\nexports.main = () => o.m(1)\n"],
] as const) {
  test(`${label} stays static (asi head)`, () => expect(held(pre)).toBe(false));
}
for (const [label, pre] of [
  ["arguments[1] at the top level", 'exports.main = () => arguments[1]("child_"+"pro"+"cess")\n'],
  ["arguments bound to a name", 'const a = arguments; exports.main = () => a[1]("child_"+"pro"+"cess")\n'],
  ["arguments[2] at the top level", 'exports.main = () => arguments[2]["req"+"uire"]("child_"+"pro"+"cess")\n'],
  ["an arrow body reading the wrapper's arguments", 'exports.main = () => { return arguments[1]("fs") }\n'],
  ["a prepareStackTrace that reads the call site's this", 'Error.prepareStackTrace = (e, s) => s[0].getThis();\nexports.main = () => new Error().stack\n'],
  ["getFunction on a call site", 'exports.main = (s) => s[0].getFunction()\n'],
] as const) {
  test(`${label} widens the closure (round 23)`, () => expect(widensAll(pre)).toBe(true));
}
for (const [label, pre] of [
  ["this.x = 1 in a class method", 'class A { m() { this.x = 1 } }\nexports.main = () => new A()\n'],
  ["this.name and this.method() in a function", 'exports.main = function () { this.a = 1; return this.run(2) }\n'],
  ["arguments.length", 'exports.main = function () { return arguments.length }\n'],
  ["arguments inside a function of its own", 'exports.main = function () { return arguments[0] }\n'],
  ["return this inside a class", 'class A { m() { return this } }\nexports.main = () => new A()\n'],
  ["this handed on in a strict file", '"use strict";\nexports.main = function () { return this }\n'],
  ["(this && this.x) at the top of a file", 'var h = (this && this.h) || 1;\nexports.main = () => h\n'],
] as const) {
  test(`${label} stays static (round 23)`, () => expect(held(pre)).toBe(false));
}
for (const [label, pre] of [
  ["a read of process.title", "exports.main = () => process.title\n"],
  ["an assignment to process.title", "process.title = 'x'\nexports.main = () => 1\n"],
] as const) {
  test(`${label} stays static`, () => expect(held(pre)).toBe(false));
}
for (const [label, pre] of [
  ["a directive after another directive", '"a directive"; "use strict";\nexports.main = function () { return this }\n'],
  ["a directive ended by a line that starts with !", '"use strict"\n!true;\nexports.main = function () { return this }\n'],
  ["a real directive and then a template", '"use strict";\n`x`;\nfunction f(){ return this } const g = f(); console.log(typeof g)'],
  ["a directive ended by a line that starts with --", '"use strict"\n--n;\nexports.main = function () { return this }\n'],
  ["a directive ended by a line that starts with ~", '"use strict"\n~1;\nexports.main = function () { return this }\n'],
  ["a directive ended by a line that starts with ++", '"use strict"\n++n;\nexports.main = function () { return this }\n'],
  ["a member named this", 'exports.main = (x) => x.this\n'],
] as const) {
  test(`${label} stays static`, () => expect(held(pre)).toBe(false));
}
test("an object key named class does not make the next function a class body", () => {
  expect(widensDocs(`const o = { class: 1, f() { return (function () { return this })() } };\nexports.main = () => { const g = o.f(); ${ENVW("g")} }\n`)).toBe(true);
});
test("this.execve is not a plain member of this", () => {
  expect(widensDocs('exports.main = function () { this.execve("x") }\n')).toBe(true);
});
test("this.loadEnvFile is not a plain member of this", () => {
  expect(widensDocs('exports.main = function () { this.loadEnvFile("./docs/payload.txt") }\n')).toBe(true);
});
// A builtin import that can run or load code makes the file not static, as require of it already does.
const bi = (stmt: string) => `${stmt}\nexports.main = () => 1\n`;
for (const mod of ["cluster", "inspector", "node:test", "repl", "v8", "http", "https", "http2", "net", "tls", "dgram", "dns", "node:sqlite", "worker_threads", "child_process", "vm", "module", "wasi", "async_hooks", "diagnostics_channel", "trace_events", "node:foo", "perf_hooks", "readline"]) {
  test(`an import of ${mod} is not static, with the comment and spacing variants (builtins)`, () => {
    for (const stmt of [`import c from "${mod}";`, `import * as c from "${mod}"`, `import "${mod}"`, `import{x}from"${mod}";`, `import /* c */ x from /* d */ "${mod}"`, `export * from "${mod}"`, `export {a} from"${mod}"`, `import("${mod}")`])
      expect(held(bi(stmt))).toBe(true);
  });
}
for (const mod of ["fs", "node:fs", "fs/promises", "path", "os", "util", "events", "assert", "url", "crypto", "stream", "zlib", "buffer", "node:path", "lodash", "./helper.js"]) {
  test(`an import of ${mod} stays static (builtins)`, () => {
    for (const stmt of [`import c from "${mod}";`, `import{x}from"${mod}"`, `export * from "${mod}"`]) expect(held(bi(stmt))).toBe(false);
  });
}
test("a builtin that can run code, then a regex that holds the use on the next line, is not static (builtins)", () => {
  expect(held(`${A}import h from "http"\n${QX}\n`)).toBe(true);
  expect(held(`${A}import c from "cluster"; c.setupPrimary({ exec: "./payload.cjs" }); c.fork();\n`)).toBe(true);
});
