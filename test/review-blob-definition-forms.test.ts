import { describe, expect, test } from "bun:test";
import { chunkDiff, encodedRunNames } from "../src/review.ts";
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

// Main's selection, kept as it was: the plain form NAME = "<run>", at most 16 names per line.
function mainNames(l: string): string[] {
  const found: string[] = [];
  let start = -1;
  const isEnc = (c: number) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 43 || c === 47 || c === 61 || c === 95 || c === 45;
  for (let i = 0; i <= l.length; i++) {
    if (i < l.length && isEnc(l.charCodeAt(i))) {
      if (start < 0) start = i;
      continue;
    }
    if (start >= 0 && i - start >= 400 && found.length < 16) {
      const lead = /([\p{L}_$][\p{L}\p{N}\p{M}\p{Pc}_$\u200C\u200D]*)\s*=\s*['"`]?$/u.exec(l.slice(Math.max(0, start - 80), start));
      if (lead) found.push(lead[1]!);
    }
    start = -1;
  }
  return found;
}

describe("the selection is main's plus extra names, never fewer", () => {
  const cutDiff = (def: string, use: string) => {
    const cut = new Set<string>();
    diff(def, use, "index.js", cut);
    return cut.size;
  };
  const big = "A".repeat(30_000);
  test("names main selected still hold when cut: a property named default, a 65-character name, pass, done, a 78-character name", () => {
    expect(cutDiff(`o.default = "${big}"; `, "eval(o.default)")).toBe(1);
    expect(cutDiff(`const ${"D".repeat(65)} = "${big}";`, `eval(${"D".repeat(65)})`)).toBe(1);
    expect(cutDiff(`const ${"D".repeat(78)} = "${big}";`, `eval(${"D".repeat(78)})`)).toBe(1);
    expect(cutDiff(`const pass="${big}";`, "eval(pass)")).toBe(1);
    expect(cutDiff(`exports.default="${big}";`, "eval(exports.default)")).toBe(1);
    expect(cutDiff(`done="${big}"`, "eval($done)")).toBe(1);
  });
  test("16 decoy runs that bind no name before D do not hide D", () => {
    const decoys = Array.from({ length: 16 }, (_, i) => `"${String.fromCharCode(66 + (i % 20)).repeat(450)}${i}"`).join(",");
    const def = `const a=[${decoys}];const q=[${decoys}]; const D="${B}";`;
    expect(diff(def, "eval(D)")).toContain("(a definition of");
    expect(diff(`x=[${decoys},D="${B}"]`, "eval(D)")).toContain(B);
  });
  test("controls: an unrelated name before the statement, and a data URI, select nothing", () => {
    expect(diff(`const status=1;const D="${B}";`, "status++;")).not.toContain(B);
    expect(diff(`const u="data:image/png;base64,${B}";`, `const m = "image png base64 charset utf";`)).not.toContain(B);
    expect(diff(`var a=1;function D(){return "${B}"}`, "var from = 1; var as = 2; var of = 3; async function f(){ await g(); }")).not.toContain(B);
  });
  test("differential: on a generated corpus the names are a superset of main's", () => {
    let seed = 7;
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n);
    const words = ["default", "pass", "done", "then", "is", "None", "status", "from", "static", "D", "exports", "const", "function"];
    const wrap = ["", "(", "Buffer.from(", "[", "{k:", "()=>", "return "];
    for (let n = 0; n < 400; n++) {
      let line = "";
      for (let d = 0, k = rnd(41); d < k; d++) line += `"${"x".repeat(400 + rnd(5))}",`;
      const name = rnd(3) === 0 ? words[rnd(words.length)]! : "N".repeat(1 + rnd(90));
      line += `${rnd(2) ? "const " : ""}${rnd(2) ? "o." : ""}${name} = ${wrap[rnd(wrap.length)]}"${B}"`;
      const got = new Set(encodedRunNames(line));
      for (const x of mainNames(line)) expect(got.has(x), `${x} in ${line.slice(0, 60)}`).toBe(true);
    }
  });

  test("a $-prefixed name does not hide the plain name's definition (JS and shell)", () => {
    const big = "A".repeat(30_000);
    const cut = new Set<string>();
    diff(`const D="${big}";\nconst $D=("${"B".repeat(450)}");`, "eval($D)", "index.js", cut);
    expect([...cut]).toEqual(["index.js"]);
    const cut2 = new Set<string>();
    const b64 = "Q".repeat(30_000);
    diff(`PAYLOAD="${b64}"\necho $PAYLOAD "${"R".repeat(450)}"`, "echo $PAYLOAD | base64 -d | sh", "run.sh", cut2);
    expect([...cut2]).toEqual(["run.sh"]);
  });

  test("controls: a comma declaration or a comment beside the definition selects nothing", () => {
    const big = "A".repeat(30_000);
    expect(cutDiff(`const status=1,D=("${big}");`, "status++;")).toBe(0);
    expect(cutDiff(`/* status */ const D=("${big}");`, "status++;")).toBe(0);
    expect(cutDiff(`const status=1,D=("${big}");`, "eval(D);")).toBe(1);
    expect(cutDiff(`f(a,b),D=("${big}");`, "eval(D);")).toBe(1);
    expect(cutDiff(`const o={k:1,D:"${big}"};`, "eval(D);")).toBe(1);
  });

  test("differential on selected definitions: every definition main selects is listed on head", () => {
    let seed = 11;
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n);
    const names = ["D", "$D", "$$D", "PAYLOAD", "$PAYLOAD", "default", "pass", "status"];
    for (let n = 0; n < 300; n++) {
      const defs = Array.from({ length: 1 + rnd(4) }, (_, i) => ({ name: names[rnd(names.length)]!, run: String.fromCharCode(65 + i).repeat(450) + i }));
      const lines = defs.map((d) => `${rnd(2) ? "const " : ""}${d.name} = ${["", "(", "Buffer.from(", "["][rnd(4)]}"${d.run}"`);
      const used = names.filter(() => rnd(3) === 0);
      const out = diff(lines.join("\n"), `use(${used.join(",")});`);
      // main's rule: a line is selected when its defined name, or a used token stripped of its leading $, is that name
      for (const d of defs) {
        const mainSelects = used.some((u) => u === d.name || u.replace(/^\$+/, "") === d.name);
        if (mainSelects) expect(out, `${d.name} used ${used}`).toContain(d.run);
      }
    }
  });
});
