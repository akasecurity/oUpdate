import { expect, test } from "bun:test";
import { classifyJs, provablyStatic } from "../src/install-closure.ts";
import { prepass, type FileMap } from "../src/prepass.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const files = (o: Record<string, string>): FileMap => new Map(Object.entries(o).map(([k, v]) => [k, enc(v)]));
const holds = (old: FileMap, now: FileMap) => prepass("npm", old, now).hard.filter((s) => s.kind === "install-script").map((s) => s.detail);

// A sloppy `return this` is the global object, so a file not known to be strict widens: an unchanged hook still holds when only
// docs/payload.txt changes.
const BODY = "function f(){ return this } const g = f(); exports.main = () => typeof g;\n";
const src = (prologue: string) => `${prologue}\n${BODY}`;
const release = (v: string, hook: string) =>
  files({
    "package.json": JSON.stringify({ name: "p", version: v, scripts: { postinstall: "node lib/hook.js" } }),
    "lib/hook.js": hook,
    "docs/payload.txt": `payload ${v}\n`,
  });
const widensDocs = (hook: string) => holds(release("1.0.0", hook), release("1.0.1", hook)).some((d) => d.includes("docs/payload.txt"));
const held = (s: string) => {
  expect(provablyStatic(s)).toBe(false);
  expect(classifyJs("pkg/lib/x.js", s).all).toBe(true);
  expect(widensDocs(s)).toBe(true);
};

// A hashbang or line comment ended by a lone CR, U+2028 or U+2029: the spec ends it there, but where a runtime ends it is not
// certain, so nothing after it is read as a directive and the file widens.
const lone: [string, string][] = [
  ["CR", "\r"],
  ["U+2028", "\u2028"],
  ["U+2029", "\u2029"],
];
for (const [n, t] of lone) {
  for (const [label, prologue] of [
    [`a hashbang ended by ${n}, a template, then a directive`, `#!/usr/bin/env node${t}\`use strict\`;\n"use strict";`],
    [`a line comment ended by ${n}, a template, then a directive`, `// header${t}\`use strict\`;\n"use strict";`],
    [`a hashbang ended by ${n}, then a directive`, `#!/usr/bin/env node${t}"use strict";`],
    [`a line comment ended by ${n}, then a directive`, `// header${t}"use strict";`],
    [`a hashbang ended by ${n}, another directive, then the directive`, `#!/usr/bin/env node${t}"x";${t}"use strict";`],
    [`a line comment ended by ${n}, another directive, then the directive`, `// header${t}"x";\n"use strict";`],
  ] as const) {
    test(`${label}: not known strict, so the hook widens`, () => held(src(prologue)));
  }
}

// LF and CR LF end a hashbang or line comment in every runtime: the directive after one is read, a template is not one.
for (const [n, t] of [["LF", "\n"], ["CR LF", "\r\n"]] as const) {
  test(`a hashbang and a line comment ended by ${n}, then a directive: strict, so the hook does not widen`, () => {
    for (const prologue of [`#!/usr/bin/env node${t}"use strict";`, `// header${t}"use strict";`]) {
      const s = src(prologue);
      expect(provablyStatic(s), prologue).toBe(true);
      expect(classifyJs("pkg/lib/x.js", s).all, prologue).toBe(false);
      expect(widensDocs(s), prologue).toBe(false);
    }
  });
  test(`a hashbang and a line comment ended by ${n}, a template, then a directive: sloppy, so the hook widens`, () => {
    for (const prologue of [`#!/usr/bin/env node${t}\`use strict\`;\n"use strict";`, `// header${t}\`use strict\`;\n"use strict";`]) held(src(prologue));
  });
}

// A directive read before a comment with an uncertain end is kept.
test("a directive before a line comment ended by a lone CR stays strict", () => {
  const s = src(`"use strict"; // header\r1;`);
  expect(classifyJs("pkg/lib/x.js", s).all).toBe(false);
});
