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

// The rendering of the diff is exactly main's; shifted lines come after it as separate whole pairs.
describe("main's output is the floor", () => {
  const head = (f: string) => `=== ${f} (changed) ===\n`;
  const suffix = "; " + "clean(); ".repeat(35) + "KEEP_THIS_TEXT(); " + "clean(); ".repeat(35);
  const L = (s: string) => s + suffix;
  const kept = (out: string) => out.split("KEEP_THIS_TEXT").length - 1;

  test("a shift that merges hunks of long lines does not elide what main shows in full", () => {
    const b = [L("/*"), L("old2"), L("PAYLOAD"), L("*/")].join("\n");
    const a = [L("new1"), L("PAYLOAD"), L("new3"), L("new4")].join("\n");
    const out = view("index.js", b, a);
    expect(out.startsWith(head("index.js") + renderLineDiff(b, a))).toBe(true);
    expect(kept(out)).toBeGreaterThanOrEqual(kept(renderLineDiff(b, a)));
  });
  test("an off-by-one pairing of long changed lines keeps main's full lines", () => {
    const b = [L("old1"), L("/*"), L("old2"), L("PAYLOAD"), L("*/"), L("old3")].join("\n");
    const a = [L("new1"), L("old2x"), L("PAYLOAD"), L("new2"), L("new3")].join("\n");
    const out = view("index.js", b, a);
    expect(out.startsWith(head("index.js") + renderLineDiff(b, a))).toBe(true);
  });
  test("a deep template prefix does not change what is shown", () => {
    const pre = "const t=" + "`${".repeat(17) + "1" + "}`".repeat(17) + ";\n";
    const b = pre + [L("old1"), L("old2"), L("same"), L("old3")].join("\n");
    const a = pre + [L("new1"), L("same"), L("new2"), L("new3")].join("\n");
    const out = view("index.js", b, a);
    expect(out.startsWith(head("index.js") + renderLineDiff(b, a))).toBe(true);
    expect(out).toBe(head("index.js") + renderLineDiff(b, a));
  });
  test("past 40 open holes an unchanged line stays out and a real shift is still shown", () => {
    const deep = "`${".repeat(40) + "1" + "}`".repeat(40) + ";\n";
    expect(view("index.js", `${deep}UNCHANGED();\nversion(1);\n`, `${deep}UNCHANGED();\nversion(2);\n`)).not.toContain("UNCHANGED");
    const out = view("index.js", `${deep}/*\n${P}\n*/\n`, `${deep}\n${P}\n\n`);
    expect(added(out)).toBe(true);
  });
  test("a million lines at depth 31 stay bounded", () => {
    const pre = "`${".repeat(31) + "\n";
    const body = "\n".repeat(1_000_000);
    const t0 = performance.now();
    const out = view("index.js", pre + body + "a();\n", pre + body + "b();\n");
    expect(performance.now() - t0).toBeLessThan(5000);
    expect(out).toContain("+b();");
  });
  test("a generated differential: main's lines are always a prefix of the output", () => {
    let seed = 12345;
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), seed % n);
    const pool = ["/*", "*/", "`", "`${", "}`", "${", "}", "{", '"', "'", "\\", "/[/*]/", "if (a) /x/.test(y);", "return /[/*]/;", "x();", "PAYLOAD();", "// c", "a /* b", "end */", "", "  "];
    const line = () => Array.from({ length: 1 + rnd(3) }, () => pool[rnd(pool.length)]!).join(rnd(2) ? " " : "") + (rnd(6) === 0 ? " ".repeat(500) + "z" : "");
    for (let n = 0; n < 300; n++) {
      const base = Array.from({ length: 2 + rnd(10) }, line);
      const next = base.map((l) => (rnd(3) === 0 ? line() : l)).filter(() => rnd(8) !== 0);
      const [b, a] = [base.join("\n"), next.join("\n")];
      if (b === a) continue;
      const out = view("index.js", b, a);
      expect(out.startsWith(head("index.js") + renderLineDiff(b, a))).toBe(true);
    }
  });
});

describe("the lexer reads the forms the audits named", () => {
  test("a regex after the paren of an if head is a regex: a changed regex does not over-show the code after it", () => {
    const b = `if (ok) /[/*]/.test(x);\nconst a=1;\nconst b=2;\n`;
    const a = `if (ok) /ok/.test(x);\nconst a=1;\nconst b=2;\n`;
    expect(view("index.js", b, a)).toBe(`=== index.js (changed) ===\n` + renderLineDiff(b, a));
  });
  test("a regex after a keyword that follows another word is a regex", () => {
    const b = `else return /[/*]/;\nconst a=1;\nconst b=2;\n`;
    const a = `else return /ok/;\nconst a=1;\nconst b=2;\n`;
    expect(view("index.js", b, a)).toBe(`=== index.js (changed) ===\n` + renderLineDiff(b, a));
  });
  test("a division after a call paren is a division: a block comment opened after it is seen", () => {
    expect(added(view("index.js", `f(1) /* x\n${P}\n*/\n`, `f(1) x\n${P}\n\n`))).toBe(true);
  });
  test("a CRLF file with a continued string keeps its state", () => {
    const b = `const s="x\\\r\n${P}//";\r\nend();`;
    const a = `const s="x";\r\n${P}//";\r\nend();`;
    expect(added(view("index.js", b, a))).toBe(true);
  });
  test("a clean CRLF file shows what main shows", () => {
    const b = `/* a */\r\nconst a=1;\r\nconst b=2;\r\n`;
    const a = `/* b */\r\nconst a=1;\r\nconst b=2;\r\n`;
    expect(view("index.js", b, a)).toBe(`=== index.js (changed) ===\n` + renderLineDiff(b, a));
  });
});

describe("the last lexer round", () => {
  const plainView = (f: string, b: string, a: string) => `=== ${f} (changed) ===\n` + renderLineDiff(b, a);
  test("a slash after a property named return is a division: the block comment after it is seen", () => {
    expect(added(view("index.js", `obj.return / 2; /*\n${P}\n*/\n`, `obj.return / 2;\n${P}\n\n`))).toBe(true);
  });
  test("a slash after x++ is a division: the block comment after it is seen", () => {
    expect(added(view("index.js", `x++ / 2; /*\n${P}\n*/\n`, `x++ / 2;\n${P}\n\n`))).toBe(true);
    expect(added(view("index.js", `x-- / 2; /*\n${P}\n*/\n`, `x-- / 2;\n${P}\n\n`))).toBe(true);
  });
  test("a block comment between return and a regex does not hide the regex", () => {
    const b = `return /* c */ /[/*]/;\nconst a=1;\nconst b=2;\n`;
    const a = `return /* c */ /ok/;\nconst a=1;\nconst b=2;\n`;
    expect(view("index.js", b, a)).toBe(plainView("index.js", b, a));
  });
  test("a line comment between return and a regex does not hide the regex", () => {
    const b = `return // c\n/[/*]/;\nconst a=1;\nconst b=2;\n`;
    const a = `return // c\n/ok/;\nconst a=1;\nconst b=2;\n`;
    expect(view("index.js", b, a)).toBe(plainView("index.js", b, a));
  });
  test("U+2028 and U+2029 end a line comment", () => {
    for (const t of [" ", " "]) expect(added(view("index.js", `// c${t}/*\n${P}\n*/\n`, `// c${t}\n${P}\n\n`))).toBe(true);
  });
  test("a lone CR ends a line comment", () => {
    expect(added(view("index.js", `// c\r/*\n${P}\n*/\n`, `// c\r\n${P}\n\n`))).toBe(true);
  });
  test("a shifted line with U+2028 prints it escaped", () => {
    const line = `${P} `;
    const out = view("index.js", `/*\n${line}\n*/\n`, `\n${line}\n\n`);
    expect(out).toContain("\\u2028");
    expect(out.includes(" ")).toBe(false);
  });
  test("JSX and TSX files keep the plain diff", () => {
    for (const f of ["a.jsx", "a.tsx"]) {
      const b = `/*\n${P}\n*/\n`;
      const a = `\n${P}\n\n`;
      expect(view(f, b, a)).toBe(plainView(f, b, a));
    }
  });
  test("one 1 MB line of nested template holes stays fast", () => {
    const line = "`${".repeat(333_333);
    const t0 = performance.now();
    const out = view("index.js", `${line}\nx();\n`, `${line}\ny();\n`);
    expect(performance.now() - t0).toBeLessThan(5000);
    expect(out).toContain("+y();");
  });
});

describe("the final lexer round", () => {
  const plainView = (f: string, b: string, a: string) => `=== ${f} (changed) ===\n` + renderLineDiff(b, a);
  test("U+2028 does not end a python comment", () => {
    const b = `# c """\nP()\nend()\n`;
    const a = `# c x\nP()\nend()\n`;
    expect(view("a.py", b, a)).toBe(plainView("a.py", b, a));
  });
  test("a property whose name has a non-ASCII letter before return is a property", () => {
    expect(added(view("index.js", `obj.πreturn / 2; /*\n${P}\n*/\n`, `obj.πreturn / 2;\n${P}\n\n`))).toBe(true);
  });
  test("the paren of a for await head is followed by a regex", () => {
    const b = `for await (const x of y) /[/*]/.test(x);\nconst a=1;\nconst b=2;\n`;
    const a = `for await (const x of y) /ok/.test(x);\nconst a=1;\nconst b=2;\n`;
    expect(view("index.js", b, a)).toBe(plainView("index.js", b, a));
  });
  test("a string line that ends in an even run of backslashes is not a continuation", () => {
    const b = `const s="abc\\\\\nconst a=1;\nconst b=2;\n`;
    const a = `const s="abc";\nconst a=1;\nconst b=2;\n`;
    expect(view("index.js", b, a)).toBe(plainView("index.js", b, a));
  });
  test("a hashbang ends at U+2028", () => {
    expect(added(view("cli.js", `#!/usr/bin/env node /*\n${P}\n*/\n`, `#!/usr/bin/env node \n${P}\n\n`))).toBe(true);
  });
  test("the reviewer prompt explains an identical pair", () => {
    const text = require("node:fs").readFileSync(new URL("../src/review.ts", import.meta.url), "utf8");
    expect(text).toContain("an identical \\`-\\` and \\`+\\` pair there is a line whose text did not change but whose meaning did");
  });
});
