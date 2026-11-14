import { expect, test } from "bun:test";
import { classifyJs, provablyStatic } from "../src/install-closure.ts";
import { prepass, type FileMap } from "../src/prepass.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const files = (o: Record<string, string>): FileMap => new Map(Object.entries(o).map(([k, v]) => [k, enc(v)]));
const holds = (old: FileMap, now: FileMap) => prepass("npm", old, now).hard.filter((s) => s.kind === "install-script").map((s) => s.detail);
const release = (v: string, hook: string) =>
  files({
    "package.json": JSON.stringify({ name: "p", version: v, scripts: { postinstall: "node lib/hook.js" } }),
    "lib/hook.js": hook,
    "docs/payload.txt": `payload ${v}\n`,
  });
const widensDocs = (hook: string) => holds(release("1.0.0", hook), release("1.0.1", hook)).some((d) => d.includes("docs/payload.txt"));

// A backslash before a line terminator (LF, CR, CR LF, U+2028, U+2029) is a line continuation: it adds no character, so
// `constru\<LF>ctor` is the name constructor, in a template and in a quoted string alike. The two CR LF rows in quoted strings
// already held before (such a file did not read): they pin that.
const ends: [string, string][] = [
  ["LF", "\n"],
  ["CR", "\r"],
  ["CR LF", "\r\n"],
  ["U+2028", "\u2028"],
  ["U+2029", "\u2029"],
];
const quotes: [string, string][] = [
  ["a template", "`"],
  ["a double quoted string", '"'],
  ["a single quoted string", "'"],
];

for (const [en, t] of ends) {
  for (const [qn, q] of quotes) {
    const key = `${q}constru\\${t}ctor${q}`;
    // A CR LF continuation in a quoted string already held before (the file did not read): those two rows are pins.
    const pin = en === "CR LF" && q !== "`" ? "pin: " : "";
    test(`${pin}a line continuation by ${en} in ${qn} spells constructor: not static, and the hook widens`, () => {
      const src = `const F = (() => {})[${key}];\nF("return process")();\n`;
      expect(provablyStatic(src)).toBe(false);
      expect(classifyJs("pkg/lib/x.js", src).all).toBe(true);
      expect(widensDocs(src)).toBe(true);
    });
  }
}

// A load whose name holds a line continuation or \0 stays unresolved, as before: the load is not read as a fixed module, so
// the hook still widens when another file changes.
const loadRelease = (v: string, hook: string) =>
  files({
    "package.json": JSON.stringify({ name: "p", version: "1.0.0", scripts: { postinstall: "node lib/hook.js" } }),
    "lib/hook.js": hook,
    "lib/helper.js": "module.exports = 1;\n",
    "lib/payload.js": `module.exports = ${v};\n`,
  });
for (const hook of ["require(\"f\\\ns\");\n", "require(\"./help\\\ner.js\");\n", "require(\"fs\\0\");\n", "require(\"child_process\\0\");\n"]) {
  test(`pin: a load named with a line continuation or \\0 still widens: ${JSON.stringify(hook)}`, () => {
    expect(holds(loadRelease("1", hook), loadRelease("2", hook)).some((d) => d.includes("lib/payload.js"))).toBe(true);
  });
}

test("a key joined from literals with a line continuation spells constructor: not static, and the hook widens", () => {
  for (const key of [`"constru\\\n" + "ctor"`, `"con" + \`stru\\\nctor\``]) {
    const src = `const F = (() => {})[${key}];\nexports.F = F;\n`;
    expect(provablyStatic(src), key).toBe(false);
    expect(classifyJs("pkg/lib/x.js", src).all, key).toBe(true);
    expect(widensDocs(src), key).toBe(true);
  }
});

// A CR LF continuation in a quoted piece already held before (such a file did not read): this pins it.
test("pin: a key joined from literals with a CR LF continuation in a quoted piece spells constructor, held on main too", () => {
  const key = `("constru\\\r\n") + 'ctor'`;
  const src = `const F = (() => {})[${key}];\nexports.F = F;\n`;
  expect(provablyStatic(src)).toBe(false);
  expect(classifyJs("pkg/lib/x.js", src).all).toBe(true);
  expect(widensDocs(src)).toBe(true);
});

test("a line continuation in plain data stays static", () => {
  for (const src of ['exports.x = "hello \\\nworld";\n', "exports.x = `hello \\\r\nworld`;\n"]) {
    expect(provablyStatic(src), src).toBe(true);
  }
});

// A string that holds an opening bracket and a line continuation does not hide a real key after it. These held before too
// (the literal-key scan found the key): they pin that the new reading does not lose it.
for (const [en, t] of [["LF", "\n"], ["CR", "\r"], ["U+2028", "\u2028"]] as const) {
  test(`pin: a string holding [" and a continuation by ${en} before a joined key: the key is still read, held on main too`, () => {
    const src = `const a = '["\\${t}'; const F = (() => {})["constru" + "ctor"]; const b = "]";\nexports.F = F;\n`;
    expect(provablyStatic(src)).toBe(false);
    expect(classifyJs("pkg/lib/x.js", src).all).toBe(true);
    expect(widensDocs(src)).toBe(true);
  });
}

test("an escaped ${ is text, and a quoted string has no substitution: such a key is not constructor", () => {
  for (const key of ["\"con\\x24{'structor'}\"", "`con\\${\"structor\"}`"]) {
    const src = `const F = (() => {})[${key}];\nexports.F = F;\n`;
    expect(provablyStatic(src), key).toBe(true);
    expect(classifyJs("pkg/lib/x.js", src).all, key).toBe(false);
    expect(widensDocs(src), key).toBe(false);
  }
});
