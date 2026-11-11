import { expect, test } from "bun:test";
import { classifyJs, hasUnbounded, provablyStatic } from "../src/install-closure.ts";
import { prepass, type FileMap } from "../src/prepass.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const files = (o: Record<string, string>): FileMap => new Map(Object.entries(o).map(([k, v]) => [k, enc(v)]));
const holds = (old: FileMap, now: FileMap) => prepass("npm", old, now).hard.filter((s) => s.kind === "install-script").map((s) => s.detail);

// The static check (provablyStatic) and the widen check (classifyJs, which reads the hazard) decide whether a file is strict from
// one function. A sloppy `return this` is the global object, so a file that is not really strict must widen; a really strict one
// must not. Both are fed the file's own source, so a template literal can never be read as a directive.
const BODY = "function f(){ return this } const g = f(); exports.main = () => typeof g;\n";
const sloppy = (prologue: string) => `${prologue}\n${BODY}`;

const release = (v: string, hook: string) =>
  files({
    "package.json": JSON.stringify({ name: "p", version: v, scripts: { postinstall: "node lib/hook.js" } }),
    "lib/hook.js": hook,
    "docs/payload.txt": `payload ${v}\n`,
  });
const widensDocs = (hook: string) => holds(release("1.0.0", hook), release("1.0.1", hook)).some((d) => d.includes("docs/payload.txt"));

const sloppyPrologues: [string, string][] = [
  ["a template spelling the directive", "`use strict`;"],
  ["a template spelling the directive, no semicolon", "`use strict`"],
  ["a template with an escape", "`use\\x20strict`;"],
  ["a template then a real directive after a non-directive", "`use strict`;\n1;\n'use strict';"],
  ["a comment spelling the directive", '// "use strict"'],
  ["a block comment spelling the directive", '/* "use strict" */'],
  ["an escaped directive string", '"use\\x20strict";'],
  ["a directive continued by !=", '"use strict"\n!= 0;'],
  ["a directive continued by a binary +", '"use strict" + "ignored";'],
  ["a template after a comment", '// "use strict"\n`use strict`;'],
  ["no prologue", ""],
  ["a hashbang then a template spelling the directive", "#!/usr/bin/env node\n`use strict`;"],
  ["a hashbang then a non-directive statement", "#!/usr/bin/env node\n1;"],
];
const strictPrologues: [string, string][] = [
  ["a double quoted directive", '"use strict";'],
  ["a single quoted directive", "'use strict';"],
  ["a directive with no semicolon", '"use strict"'],
  ["a directive after a comment", '// header\n"use strict";'],
  ["a directive after another directive", '"other";\n"use strict";'],
  ["a directive then a template", '"use strict";\n`use strict`;'],
  ["a directive followed by a unary statement", '"use strict"\n!true;'],
  ["a hashbang then a directive", '#!/usr/bin/env node\n"use strict";'],
];

for (const [label, prologue] of sloppyPrologues) {
  test(`${label}: not static, the hazard widens every file, and a changed payload outside the hook holds`, () => {
    const src = sloppy(prologue);
    expect(provablyStatic(src)).toBe(false);
    expect(classifyJs("pkg/lib/x.js", src).all).toBe(true);
    expect(widensDocs(src)).toBe(true);
  });
}
for (const [label, prologue] of strictPrologues) {
  test(`${label}: really strict, so the static check and the hazard both leave it narrow`, () => {
    const src = sloppy(prologue);
    expect(provablyStatic(src)).toBe(true);
    expect(classifyJs("pkg/lib/x.js", src).all).toBe(false);
    expect(widensDocs(src)).toBe(false);
  });
}

test("the static check and the hazard agree on every prologue", () => {
  for (const [label, prologue] of [...sloppyPrologues, ...strictPrologues]) {
    const src = sloppy(prologue);
    expect(provablyStatic(src), label).toBe(!classifyJs("pkg/lib/x.js", src).all);
  }
});

test("hasUnbounded reads the source, not the comment-free text, for the strict test", () => {
  const src = sloppy("`use strict`;");
  // The comment-free text writes the template as a quoted string; only the source tells it from a directive.
  const kept = src.replace("`use strict`", '"use strict"');
  expect(hasUnbounded(kept, src)).toBe(true);
  expect(hasUnbounded(kept, kept)).toBe(false);
});
