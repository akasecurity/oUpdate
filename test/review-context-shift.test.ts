import { describe, expect, test } from "bun:test";
import { chunkDiff } from "../src/review.ts";
import { renderLineDiff } from "../src/linediff.ts";
import type { FileMap } from "../src/prepass.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const map = (o: Record<string, string>): FileMap => new Map(Object.entries(o).map(([k, v]) => [k, enc(v)]));
const P = "require('child_process').execSync('id');";
const view = (file: string, before: string, after: string) => chunkDiff(map({ [file]: before }), map({ [file]: after }), 10_000_000, undefined, false, new Set()).join("");
const added = (out: string) => out.split("\n").some((l) => l.startsWith("+") && l.includes("execSync"));

// A line both versions hold keeps its text, but when its lexical context changes (a comment, a template or a string becomes code)
// it is what the install now runs: the reviewer view shows it as added, not only the delimiters that moved.
const shifts: [string, string, string, string][] = [
  ["a block comment whose markers are removed", `a();\n/*\n${P}\n*/\nb();\n`, `a();\n\n${P}\n\nb();\n`, "index.js"],
  ["a block comment opened on the payload line", `a();\n/* x\n${P}\n*/\nb();\n`, `a();\nx\n${P}\n\nb();\n`, "index.js"],
  ["a block comment closed early", `a();\n/*\n${P}\nmore\n*/\nb();\n`, `a();\n/*\n*/\n${P}\nmore\n*/\nb();\n`, "index.js"],
  ["a template body that becomes code", `a();\nconst t=\`\n${P}\n\`;\nb();\n`, `a();\nconst t=1;\n${P}\nb();\n`, "index.js"],
  ["a template closed earlier", `a();\nconst t=\`x\n${P}\ny\`;\n`, `a();\nconst t=\`x\`;\n${P}\ny\`;\n`, "index.js"],
  ["a template hole that closes the template", `a();\nconst t=\`\${1}\n${P}\n\`;\n`, `a();\nconst t=\`\${1}\`;\n${P}\n\`;\n`, "index.js"],
  ["a string continued over a line end", `a();\nconst s="x\\\n${P}\\\n";\n`, `a();\nconst s="x";\n${P}\n`, "index.js"],
  ["a python docstring that is removed", `a()\n"""\n${P}\n"""\nb()\n`, `a()\n\n${P}\n\nb()\n`, "a.py"],
  ["a python triple-quoted string with single quotes", `a()\n'''\n${P}\n'''\nb()\n`, `a()\n\n${P}\n\nb()\n`, "a.py"],
];
describe("a line whose lexical context changed is shown as added", () => {
  for (const [name, b, a, f] of shifts) {
    test(name, () => expect(added(view(f, b, a))).toBe(true));
  }
});

// Clean controls: the context is the same on both sides, so the unchanged payload line stays out of the view.
const same: [string, string, string, string][] = [
  ["a comment that stays a comment", `a();\n/*\n${P}\n*/\nb();\n`, `a();\n/*\n${P}\n*/\nb();\nc();\n`, "index.js"],
  ["a template that stays a template", `a();\nconst t=\`\n${P}\n\`;\n`, `a();\nconst t=\`\n${P}\n\`;\nc();\n`, "index.js"],
  ["a template with a hole before the payload", `const t=\`\${a}\n${P}\n\`;\nb();\n`, `const t=\`\${a}\n${P}\n\`;\nb(1);\n`, "index.js"],
  ["code above a regex and a division", `const r=/[/*]/;\nconst d=4 / 2;\n${P}\n`, `const r=/[/*]/;\nconst d=4 / 3;\n${P}\n`, "index.js"],
  ["a python docstring that stays", `a()\n"""\n${P}\n"""\n`, `a()\n"""\n${P}\n"""\nb()\n`, "a.py"],
  ["a line comment with a block opener", `// /*\n${P}\nb();\n`, `// /*\n${P}\nb(1);\n`, "index.js"],
];
describe("control: an unchanged context lists nothing extra", () => {
  for (const [name, b, a, f] of same) {
    test(name, () => expect(added(view(f, b, a))).toBe(false));
  }
});

// The shift only adds lines: a definition of an encoded run that sits on a line whose context changed is still listed in full,
// as it was before the shift existed, and a long identical line is shown whole, not as a token diff of nothing.
describe("a context shift keeps the unchanged-line treatment", () => {
  const X = "x".repeat(510);
  const A = "A".repeat(600);
  test("the definition on a shifted line is listed in full and shown whole", () => {
    const out = view("index.js", `const t=\`${X}\nconst D="${A}";\n\`; //${X}`, `const t=0; //${X}\nconst D="${A}";\neval(D); //${X}`);
    expect(out).toContain(`(a definition of D)`);
    expect(out).toContain(`+const D="${A}";`);
    expect(out).toContain(`-const D="${A}";`);
  });
  test("with every paired line over 500 characters", () => {
    const L = (s: string) => `${s}${"y".repeat(520)}`;
    const out = view("index.js", `${L("a")}\n/*\n${L("c")}\n*/\n${L("e")}`, `${L("a")}\n\n${L("c")}\n\n${L("e")}`);
    expect(out).toContain(`+${L("c")}`);
  });
});

describe("the lexer is bounded", () => {
  test("8,000 lines that each open a template hole stay fast", () => {
    const body = "`${\n".repeat(8000);
    const t0 = performance.now();
    const out = view("index.js", body + "a();\n", body + "b();\n");
    expect(performance.now() - t0).toBeLessThan(1500);
    expect(out).toContain("+b();");
  });
});

describe("control: a clean file is shown as the plain diff shows it", () => {
  const plain = (file: string, b: string, a: string) => view(file, b, a);
  const asMain = (file: string, b: string, a: string) => `=== ${file} (changed) ===\n` + renderLineDiff(b, a);
  const cases: [string, string, string, string][] = [
    ["a regex after return", "index.js", `function f(){return /[/*]/;}\nconst a=1;\nconst b=2;\n`, `function f(){return /ok/;}\nconst a=1;\nconst b=2;\n`],
    ["a regex after a comma and a paren", "index.js", `x(/[/*]/, /a\`/);\nconst a=1;\nconst b=2;\n`, `x(/ok/, /a\`/);\nconst a=1;\nconst b=2;\n`],
    ["a hashbang that ends in a comment opener", "cli.js", `#!/usr/bin/env node /*\nconst a=1;\nconst b=2;\n`, `#!/usr/bin/env node\nconst a=1;\nconst b=2;\n`],
    ["a markdown file with a stray backtick", "README.md", `a \` b\nline 2\nline 3\n`, `a b\nline 2\nline 3\n`],
    ["a shell file with a quote and a backtick", "install.sh", `echo "it's\nline 2\n\`x\nline 4\n`, `echo it\nline 2\n\`x\nline 4\n`],
    ["a changelog with an odd backtick", "CHANGELOG", `\`\nentry\nmore\n`, `x\nentry\nmore\n`],
    ["a template hole with nested braces", "index.js", `const t=\`\${(()=>{ if(1) {} return {a:1}; })()}\`;\nconst u=1;\nconst v=2;\n`, `const t=\`\${(()=>{ if(2) {} return {a:1}; })()}\`;\nconst u=1;\nconst v=2;\n`],
    ["comments, regexes and templates edited in place", "index.js", `/* a */\nconst r=/x\\/*/;\nconst t=\`a\${1}\`;\nm();\n`, `/* b */\nconst r=/y\\/*/;\nconst t=\`b\${2}\`;\nm();\n`],
  ];
  for (const [name, f, b, a] of cases) test(name, () => expect(plain(f, b, a)).toBe(asMain(f, b, a)));
});

describe("braces inside a template hole", () => {
  test("a hole with a block that closes, then a payload line", () => {
    const b = "const t=`${{a:1}}`;\nconst u=1;\n";
    expect(added(view("index.js", b, b + "x();\n"))).toBe(false);
    const before = `const t=\`\${(()=>{ if(true) {}\n${P}\nreturn 1;})()}\`;\n`;
    const after = `const t=\`\${(()=>{ if(true) {}\n${P}\nreturn 1;})()}\`;\nx();\n`;
    // the payload sits in code in both versions: not a context change
    expect(added(view("index.js", before, after))).toBe(false);
  });
  test("a payload line in a hole that becomes plain code is shown (a superset)", () => {
    const before = `const t=\`\${(()=>{ if(true) {}\n${P}\nreturn 1;})()}\`;\n`;
    const after = `const t=1;(()=>{ if(true) {}\n${P}\nreturn 1;})();\n`;
    expect(added(view("index.js", before, after))).toBe(true);
  });
});
