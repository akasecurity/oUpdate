// OUP-281: lexer misses found in the PR 231 security read (JS openers and the extension gate). Each test asserts the SAFE result.
// Threat model: the old release is honest and holds a commented-out or template-wrapped line; the attacker controls the new release
// and makes that unchanged line run. Every "new" text below was run with node 26 and printed RAN (see p231-node/).
import { describe, expect, test } from "bun:test";
import { chunkDiff } from "../src/review.ts";
import { lexMode, lineStates, newSeed } from "../src/linediff.ts";
import type { FileMap } from "../src/prepass.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const map = (o: Record<string, string>): FileMap => new Map(Object.entries(o).map(([k, v]) => [k, enc(v)]));
const P = "require('child_process').execSync('id');";
const view = (file: string, before: string, after: string) => chunkDiff(map({ [file]: before }), map({ [file]: after }), 10_000_000, undefined, false, new Set()).join("");
const added = (out: string) => out.split("\n").some((l) => l.startsWith("+") && l.includes("execSync"));
const OLD_C = `/*\n${P}\n*/\n`;
const OLD_T = `const t=\`\n${P}\n\`;\n`;

describe("openers: fake openers the lexer takes but node does not (payload must show as added)", () => {
  test("a1.1 HTML comment <!-- /* ... --> */ (CJS .js)", () => expect(added(view("index.js", OLD_C, `<!-- /*\n${P}\n--> */\n`))).toBe(true));
  test("a1.2 spread before a regex holding /* (CJS .js)", () => expect(added(view("index.js", OLD_C, `x=[.../[/*]/.source];\n${P}\n// */\n`))).toBe(true));
  test("a1.3 spread before a regex holding a backtick (template body)", () => expect(added(view("index.js", OLD_T, `x=[.../[\`]/.source];\n${P}\n// \`\n`))).toBe(true));
  // chunkDiff decodes with TextDecoder, which drops a leading BOM; lineStates is the unit that must also drop it when handed one.
  test("a1.5 BOM then hashbang holding /* (.mjs): the lines after it are code, not a comment", () => {
    const L = ["\uFEFF#! /*", P, "// */"];
    expect(lineStates(L, "js", newSeed()).kinds).toEqual(["code", "code", "code"]);
  });
  test("a1.6 `-->` at a line start is a comment in a script, taints the lines after it", () => expect(added(view("index.js", OLD_C, `/**/\n--> /*\n${P}\n// */\n`))).toBe(true));
  test("a1.7 control: a division after a number with a dot stays division (not a spread)", () => expect(added(view("index.js", OLD_C, `x=1./2/3;\n${P}\n//\n`))).toBe(true));
});

describe("openers: lexical cases the lexer gets right (controls)", () => {
  test("a2.1 regex holding /* after = (comment removed)", () => expect(added(view("index.js", OLD_C, `const r=/[/*]/;\n${P}\n//\n`))).toBe(true));
  test("a2.2 nested template in a hole closes the outer template", () => expect(added(view("index.js", OLD_T, `const t=\`\${\`\${\`a\`}\`}\`;\n${P}\n//\n`))).toBe(true));
  test("a2.3 U+2028 ends a // comment and /* opens after it (old); removed (new)", () => expect(added(view("index.js", `// x\u2028/*\n${P}\n*/\n`, `// x\n${P}\n\n`))).toBe(true));
  test("a2.4 CR inside a line ends a // comment", () => expect(added(view("index.js", `// a\r/*\n${P}\n*/\n`, `// a\r\n${P}\n\n`))).toBe(true));
  test("a2.5 string continued with backslash (old) vs closed (new)", () => expect(added(view("index.js", `s="a\\\n${P}\nb();\n`, `s="a";\n${P}\nb();\n`))).toBe(true));
});

describe("gate: extension gate: files node runs that the lexer skips (payload must show)", () => {
  test("a3.1 bin script with a node shebang and no extension", () => expect(added(view("bin/cli", `#!/usr/bin/env node\n${OLD_C}`, `#!/usr/bin/env node\n\n${P}\n\n`))).toBe(true));
  test("a3.2 .jsx required from CJS (node loads an unknown extension as .js)", () => expect(added(view("lib/x.jsx", OLD_C, `\n${P}\n\n`))).toBe(true));
  test("a3.3 python script with a shebang and no extension", () => expect(added(view("bin/tool", `#!/usr/bin/env python3\n"""\n${P}\n"""\n`, `#!/usr/bin/env python3\n\n${P}\n\n`))).toBe(true));
  test("a3.4 .pyw", () => expect(added(view("a.pyw", `"""\n${P}\n"""\n`, `\n${P}\n\n`))).toBe(true));
  test("a3.5 lexMode table: uppercase and the six js names, py", () => {
    for (const p of ["a.js", "a.JS", "a.mjs", "a.cjs", "a.ts", "a.mts", "a.cts", "A.CTS"]) expect(lexMode(p)).toBe("js");
    for (const p of ["a.py", "a.PY"]) expect(lexMode(p)).toBe("py");
    for (const p of ["a.jsx", "a.tsx", "A.JSX"]) expect(lexMode(p)).toBe("js");
    for (const p of ["a.pyw", "a.PYW"]) expect(lexMode(p)).toBe("py");
    for (const p of ["a.d.cts"]) expect(lexMode(p)).toBe("js");
    for (const p of ["a.pyi", "cli", "a.js.map", "a.ctss", "a.json", "a.sh"]) expect(lexMode(p)).toBeUndefined();
  });
  const SHAPES: [string, "js" | "py"][] = [["#!/usr/bin/env -u HOME node", "js"], ["#!/usr/bin/env -C /tmp node", "js"], ["#!/usr/bin/env -S npx tsx", "js"], ["#!/usr/bin/env -S bunx tsx", "js"], ["#!/usr/bin/env -S npx zx", "js"], ["#!/usr/bin/env zx", "js"], ["#!/usr/bin/env vite-node", "js"], ["#!/usr/bin/env ts-node-esm", "js"], ["#!/usr/bin/env esno", "js"], ["#!/usr/bin/env -S uv run --script", "py"], ["#!/usr/bin/env pipx", "py"]];
  for (const [t, mode] of SHAPES) test(`a3.7 shebang \`${t}\` reads as ${mode}`, () => expect(lexMode("bin/cli", `${t}\n`)).toBe(mode));
  test("a3.8 controls: sh, a leading space and a later line are not a shebang", () => {
    for (const t of ["#!/bin/sh\n", " #!/usr/bin/env node\n", "\n#!/usr/bin/env node\n", "#!/usr/bin/env nodemon\n", "#!/usr/bin/env -S sh -c 'echo'\n"]) expect([t, lexMode("bin/cli", t)]).toEqual([t, undefined]);
  });
  test("a3.6 lexMode by shebang: node-like and python interpreters, env options skipped, other interpreters and no shebang stay plain", () => {
    const m = (t: string) => lexMode("bin/cli", t);
    for (const t of ["#!/usr/bin/env node\n", "#!/usr/local/bin/node\n", "#!/usr/bin/env -S node --no-warnings\n", "#!/usr/bin/env FOO=1 bun\n", "#!/usr/bin/node20\r\n", "\uFEFF#!/usr/bin/env deno\n"]) expect(m(t)).toBe("js");
    for (const t of ["#!/usr/bin/env python3\n", "#!/usr/bin/python3.12 -u\n", "#!/usr/bin/env -S python -O\n"]) expect(m(t)).toBe("py");
    for (const t of ["#!/bin/sh\n", "#!/usr/bin/env ruby\n", "#!/usr/bin/env nodemon\n", "node\n", "x\n#!/usr/bin/env node\n", ""]) expect(m(t)).toBeUndefined();
    expect(lexMode("bin/cli")).toBeUndefined(); // no text: no shebang to read
  });
});

describe("private names and the taint (OUP-281 review)", () => {
  const src = () => Bun.file(new URL("../src/linediff.ts", import.meta.url)).text();
  test("p0 src/linediff.ts holds no literal U+FEFF (write it as an escape)", async () => expect((await src()).includes("\uFEFF")).toBe(false));
  // `this.#default / 2 /*`: a private name is a property, so `/` after it divides and `/*` opens a comment that hides the payload line.
  for (const w of ["default", "in", "return", "of", "new"]) {
    test(`p1 this.#${w} / 2 /* is a division, the next line a comment`, () => {
      const L = [`class A { m(){ return this.#${w} / 2 /*`, "payload();", "*/ } }"];
      expect(lineStates(L, "js", newSeed()).kinds).toEqual(["code", "comment", "code"]);
    });
  }
  test("p2 controls: a public property and a plain private name divide too", () => {
    for (const t of ["return this.default / 2 /*", "return this.#x / 2 /*"]) expect(lineStates([t, "payload();", "*/ x"], "js", newSeed()).kinds).toEqual(["code", "comment", "code"]);
  });
  test("p3 `x-->0 /*` in mid-line is an operator, so the next line is a comment", () => {
    expect(lineStates(["x-->0 /*", "payload();", "*/ x"], "js", newSeed()).kinds).toEqual(["code", "comment", "code"]);
  });
  const taintShown = (a: string[], b: string[], mode: "js" | "py") => {
    const seed = newSeed();
    return lineStates(a, mode, seed).states[1] !== lineStates(b, mode, seed).states[1];
  };
  test("p4 a line-start `-->` taints the state of the lines after it", () => expect(taintShown(["--> x", "y"], ["// x", "y"], "js")).toBe(true));
  test("p5 `<!--` taints the state of the lines after it", () => expect(taintShown(["a <!-- x", "y"], ["a // x", "y"], "js")).toBe(true));
  test("p6 an f-string closed with more `}` than `{` (negative depth) taints", () => expect(taintShown([`x = f'}'`, "y"], [`x = f'a'`, "y"], "py")).toBe(true));
  test("p7 an f-string closed with an open `{` taints", () => expect(taintShown([`x = f'{'`, "y"], [`x = f'a'`, "y"], "py")).toBe(true));
  test("p8 a balanced f-string hole does not taint", () => expect(taintShown([`x = f'{a}'`, "y"], [`x = f'a'`, "y"], "py")).toBe(false));
  // `default` is a regex word only right after `export`: as a JSX prop or a bare name it is not, and a regex guess there hides the payload line.
  for (const t of ["x = <A default />; /*", "x = <A default/>; /*", "x = <A b default />; /*"]) {
    test(`p9 \`${t}\` is code, the next line a comment`, () => expect(lineStates([t, "payload();", "*/ x"], "js", newSeed()).kinds).toEqual(["code", "comment", "code"]));
  }
  test("p10 controls: `x.default / 2` and `this.#default / 2` divide", () => {
    const k = (t: string) => lineStates([t, "payload();", "*/ x"], "js", newSeed()).kinds;
    expect(k("x = x.default / 2 /*")).toEqual(["code", "comment", "code"]);
    expect(k("x = this.#default / 2 /*")).toEqual(["code", "comment", "code"]);
  });
  // `export default /` is read as a division, as on main (a regex reading there narrows JSX cases; the module reading is OUP-328).
  const OLD_X = `x = 1; /*\n${P}\n//*/\n`;
  const TRAIL = ` s = "/ /*";`;
  const jsx: [string, string][] = [
    ["<A export default /> split on one line", `x = <A export default />;${TRAIL}`],
    ["<A export\\ndefault /> split over two lines", `x = <A export\ndefault />;${TRAIL}`],
    ["<export default /> tag", `x = <export default />;${TRAIL}`],
    ["<a.export default /> property before default", `x = <a.export default />;${TRAIL}`],
    ["<A export foo />", `x = <A export foo />;${TRAIL}`],
    ["<A b={1} default />", `x = <A b={1} default />;${TRAIL}`],
  ];
  for (const [name, line] of jsx) test(`p11 ${name}: the payload line shows`, () => expect(added(view("index.js", OLD_X, `${line}\n${P}\n//*/\n`))).toBe(true));
  // An old text that already holds an `export default /` line or `<!--` must not make the same payload line compare unchanged.
  const olds: [string, string, string][] = [
    ["p13a", `export default /re/;\n/*\n${P}\n*/\n`, `export default /re/;\n\n${P}\n\n`],
    ["p13b", `<!-- x\n/*\n${P}\n*/\n`, `<!-- x\n\n${P}\n\n`],
    ["p13c", `export default /a/ /*\n${P}\n*/\n`, `export default /a/ /**/;\n${P}\n//\n`],
    ["p13f", `<!-- x\nexport default /a/ /*\n${P}\n*/\n`, `<!-- x\nexport default /a/ /**/;\n${P}\n//\n`],
  ];
  for (const [n, o, w] of olds) test(`${n} old text with a taint source: the payload line shows`, () => expect(added(view("index.mjs", o, w))).toBe(true));
});
