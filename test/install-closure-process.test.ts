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
  ["destructuring allowlisted members of process", 'const { env, platform, argv } = process; exports.main = () => env.X + platform + argv[2]\n'],
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
