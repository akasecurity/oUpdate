import { describe, expect, test } from "bun:test";
import { regexBlanked } from "../src/install-closure.ts";
import { prepass } from "../src/prepass.ts";

const enc = new TextEncoder();
const map = (f: Record<string, string>) => new Map(Object.entries(f).map(([k, v]) => [k, enc.encode(v)]));
const pj = JSON.stringify({ name: "x", version: "1", scripts: { postinstall: "node hook.js" } });
const head = 'const cp = require("child_process");\nconst path = require("path");\nconst d = __dirname + "/docs";\n';
// A file named only as an operand: path.join(d, "evil") resolves to docs/evil.js through the operand reader.
const spawn = 'cp.spawnSync("node", [path.join(d, "evil")]);';
// The hook's text is `body`; the new docs/evil.js runs a command.
const changed = (body: string) => {
  const o = { "package.json": pj, "hook.js": `${head}${body}\n`, "docs/evil.js": "1;\n" };
  return prepass("npm", map(o), map({ ...o, "docs/evil.js": "require('child_process').execSync('id');\n" })).hard.filter((s) => s.kind === "install-script");
};

describe("a / or * inside a regular expression literal opens no comment", () => {
  test.each([
    ["const r = /\\//;", " "],
    ['const r = /"\\//;', " "],
    ["const r = /a\\/*/;", " "],
    ["const r = /a\\/*/;", "\n"],
    ["const r = /a\\/*/;", "\nf();\n"],
    ["const r = /\\/*/g;", " "],
    ["const r = /\\/*/g;", "\n"],
    ["const r = /\\/*/g;", "\nf();\n"],
    ["const r = /[/*]/;", " "],
    ["const r = /[/*]/;", "\n"],
  ])("%s then %j then a spawn of an operand-named changed file: held", (re, sep) => {
    expect(changed(`${re}${sep}${spawn}`).map((s) => s.detail).join(" ")).toMatch(/docs\/evil\.js/);
  });
  test.each([
    ["const r = /\\//;", "\n"],
    ["const r = /\\//;", "\nf();\n"],
    ['const r = /"\\//;', "\n"],
    ['const r = /"\\//;', "\nf();\n"],
  ])("stays held as on main (a // ends at the line): %s then %j", (re, sep) => {
    expect(changed(`${re}${sep}${spawn}`).length).toBeGreaterThan(0);
  });
  test("control: a real // or /* */ comment after a regex is still a comment", () => {
    for (const body of [`const r = /a/; // ${spawn}`, `const r = /a/; /* ${spawn} */`, `const r = /\\//; // ${spawn}`, `const r = /\\/*/g; /* ${spawn} */`])
      expect(changed(body)).toEqual([]);
  });
  // The quote-only reading stays besides the new one: a template with a backtick inside ${} upsets the literal reader once the false /*
  // (which hid it in the quote-only reading) is blanked, and only the quote-only reading then reaches the real */ and the spawn after it.
  const desync = "const r = /'\\/*/; const t = `a${\"`\"}b`;";
  test("a quote and a /* in one regex body, then a template that upsets the literal reader: held, as on the quote-only reading", () => {
    expect(changed(`${desync} /* c */ ${spawn}`).map((s) => s.detail).join(" ")).toMatch(/docs\/evil\.js/);
  });
  test("control: the same line with the spawn inside the real comment is not held", () => {
    expect(changed(`${desync} /* c ${spawn} */`)).toEqual([]);
  });
  test("the blanked text: a regex body's / and * become spaces, the slashes around it and the code after it stay", () => {
    expect(regexBlanked("const r = /\\/*/g; f();")).toEqual({ quotes: undefined, all: "const r = /\\  /g; f();" });
    expect(regexBlanked("const r = /'\\/*/; f();")).toEqual({ quotes: "const r = / \\/*/; f();", all: "const r = / \\  /; f();" });
    expect(regexBlanked("const r = /'a/; f();")).toEqual({ quotes: "const r = / a/; f();", all: undefined });
    expect(regexBlanked("const r = /a/; // x")).toBeUndefined();
  });
});
