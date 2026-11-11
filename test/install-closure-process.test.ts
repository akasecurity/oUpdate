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
  expect(held(`${A}var s = require("fs"); eval(s.readFileSync /* ) */ + x);\nexports.main = () => 1\n`)).toBe(true);
});

// Round 18: a template interpolation or brace still open at the end of the file is not static.
for (const [label, body] of [
  ["an unterminated template interpolation", "const t = `x${p.cwd()"],
  ["an unterminated interpolation inside a nested template", "const t = `a${`b${p.cwd()`}"],
  ["an open brace at the end of the file", "function f() { return p.cwd()"],
] as const) {
  test(`${label} is not static (round 18)`, () => expect(held(`${A}${body}\n`)).toBe(true));
}
test("balanced nested templates stay static (round 18)", () => {
  expect(held(`${A}exports.main = () => \`a\${\`b\${p.cwd()}\`}\`\n`)).toBe(false);
});
