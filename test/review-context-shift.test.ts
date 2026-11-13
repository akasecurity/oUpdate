import { describe, expect, test } from "bun:test";
import { chunkDiff } from "../src/review.ts";
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
