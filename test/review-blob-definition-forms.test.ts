import { describe, expect, test } from "bun:test";
import { chunkDiff } from "../src/review.ts";
import type { FileMap } from "../src/prepass.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const map = (o: Record<string, string>): FileMap => new Map(Object.entries(o).map(([k, v]) => [k, enc(v)]));
const B = Buffer.from("require('child_process').execSync('id');".repeat(20)).toString("base64");
const USE = `eval(Buffer.from(D,"base64").toString());`;
const diff = (def: string, use = USE, file = "index.js", cut?: Set<string>) =>
  chunkDiff(map({ [file]: `${def}\nmodule.exports=1;\n` }), map({ [file]: `${def}\nmodule.exports=1;\n${use}\n` }), 10_000_000, undefined, false, new Set(), cut).join("");

// Each form binds the name D to an encoded run on one unchanged line; a changed line that names D must list that line.
const FORMS: Record<string, string> = {
  "a parenthesized string": `const D=("${B}");`,
  "Buffer.from of the run": `const D=Buffer.from("${B}");`,
  "String of the run": `const D=String("${B}");`,
  "a function that returns it": `function D(){return "${B}"}`,
  "an arrow function that returns it": `const D=()=>"${B}";`,
  "a class static field": `class D{static v="${B}"}`,
  "an object literal key": `const o={D:"${B}"};`,
  "an array element": `const D=["${B}"];`,
  "a destructuring default": `const {D="${B}"}={};`,
  "a comment before the equals sign": `const D /*x*/ = "${B}";`,
  "a python def that returns it": `def D(): return "${B}"`,
  "a python lambda": `D = lambda: "${B}"`,
};

describe("a definition of a used name that is not NAME = \"run\" is listed too", () => {
  for (const [name, def] of Object.entries(FORMS)) {
    test(`${name} is listed`, () => {
      const out = diff(def, USE, name.startsWith("a python") ? "a.py" : "index.js");
      expect(out).toContain(B);
      expect(out).toMatch(/\(a definition of (\w+, )*D(, \w+)*\)/);
    });
  }

  test("a cut definition of each form holds", () => {
    const big = "A".repeat(30_000);
    for (const [name, def] of Object.entries(FORMS)) {
      const cut = new Set<string>();
      diff(def.replace(B, big), USE, name.startsWith("a python") ? "a.py" : "index.js", cut);
      expect([...cut], name).toHaveLength(1);
    }
  });

  test("controls: a name no changed line uses lists nothing, and a reserved word is not a name", () => {
    expect(diff(`const D=("${B}");`, "f(E);")).not.toContain(B);
    expect(diff(`function D(){return "${B}"}`, "const x = 1; if (x) return;")).not.toContain(B);
    expect(diff(`function D(){return "${B}"}`, "class K{}")).not.toContain(B);
  });

  test("the form NAME = \"run\" still lists as before", () => {
    expect(diff(`const D="${B}";`)).toContain("(a definition of D)");
  });
});
