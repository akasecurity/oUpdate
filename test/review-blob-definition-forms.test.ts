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

// A seeded generator over the full 32 bits (mulberry32): rnd(n) is uniform on 0..n-1.
const makeRng = (seed: number) => {
  let a = seed >>> 0;
  return (n: number) => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n);
  };
};

// The selection of the merged main, copied as the oracle: the head's names and its listed and held definitions must be a superset of what this selects.
const BLOB_RUN = 400;
const IDENT = /[\p{L}_$][\p{L}\p{N}\p{M}\p{Pc}_$\u200C\u200D]*/gu;
const BLOB_LEAD = 200; // characters before a run searched for the extra names that bind it
const BLOB_EXTRA_RUNS = 16;
const BLOB_NAMES_PER_RUN = 3;
// Words that are no name in the window before a run (the extra names only: the selection of `NAME = "<run>"` above reads every name): reserved words,
// words that start a value or an access, and the words of a data URI or an inline map (`data:image/png;base64,`).
const NOT_A_NAME = new Set(("break case catch class const continue debugger default delete do else enum export extends false finally for function if import in instanceof let new null return super switch this throw true try typeof var void while with yield " +
  "def lambda and or not is elif pass raise global nonlocal None True False del except then fi done esac from static as of async await get set " +
  "base64 data image png jpeg jpg gif webp svg xml charset utf application json octet stream text plain html font woff woff2 ttf otf wasm javascript css audio video mp3 mp4 mpeg ogg zip pdf").split(" "));

/** The names an encoded run of BLOB_RUN or more characters is assigned to on this line (`D = "<run>"`, `o.D = "<run>"`). */
function oracleLead(l: string): string[] {
  const found: string[] = [];
  let start = -1;
  const isEnc = (c: number) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 43 || c === 47 || c === 61 || c === 95 || c === 45;
  for (let i = 0; i <= l.length; i++) {
    if (i < l.length && isEnc(l.charCodeAt(i))) {
      if (start < 0) start = i;
      continue;
    }
    if (start >= 0 && i - start >= BLOB_RUN && found.length < 16) {
      const lead = /([\p{L}_$][\p{L}\p{N}\p{M}\p{Pc}_$\u200C\u200D]*)\s*=\s*['"`]?$/u.exec(l.slice(Math.max(0, start - 80), start));
      if (lead) found.push(lead[1]!);
    }
    start = -1;
  }
  return found;
}

/** Extra names, added to the ones above and never instead of them: the names in the statement before each run (back to the last `;` or the last `,` outside brackets, comments blanked, at most BLOB_LEAD characters) that bind or wrap it
 *  (`D = Buffer.from("<run>")`, `function D() { return "<run>" }`, `{ D: "<run>" }`, `D = ["<run>"]`), the 3 nearest. */
function oracleWindow(l: string): string[] {
  const found: string[] = [];
  let start = -1;
  let runs = 0;
  const isEnc = (c: number) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 43 || c === 47 || c === 61 || c === 95 || c === 45;
  for (let i = 0; i <= l.length; i++) {
    if (i < l.length && isEnc(l.charCodeAt(i))) {
      if (start < 0) start = i;
      continue;
    }
    if (start >= 0 && i - start >= BLOB_RUN && runs++ < BLOB_EXTRA_RUNS) {
      // Comments are blanked, then the statement is cut at its last `;` and at its last `,` outside any bracket (`const a=1,D=("<run>")`).
      let lead = l.slice(Math.max(0, start - BLOB_LEAD), start).replace(/\/\*[^]*?\*\//g, " ");
      lead = lead.slice(lead.lastIndexOf(";") + 1);
      for (let k = lead.length - 1, depth = 0; k >= 0; k--) {
        const c = lead[k]!;
        if (c === ")" || c === "]" || c === "}") depth++;
        else if (c === "(" || c === "[" || c === "{") depth--;
        else if (c === "," && depth <= 0) {
          lead = lead.slice(k + 1);
          break;
        }
      }
      const names: string[] = [];
      for (const m of lead.matchAll(IDENT)) {
        const a = lead[m.index! - 1];
        const b = lead[m.index! + m[0].length];
        // A receiver (`Buffer` in `Buffer.from`) is read from, not a name; a token beside `+`, `/` or `-` is a piece of an encoded run.
        if (b === "." || a === "+" || a === "/" || b === "+" || b === "/" || a === "-" || b === "-" || NOT_A_NAME.has(m[0])) continue;
        names.push(m[0]);
      }
      found.push(...names.slice(-BLOB_NAMES_PER_RUN));
    }
    start = -1;
  }
  return found;
}

const oracleNames = (l: string): string[] => [...new Set([...oracleLead(l), ...oracleWindow(l)])];

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

  test("the generator draws every value, uniformly enough, with no overflow", () => {
    const rnd = makeRng(1);
    const first = Array.from({ length: 50 }, () => rnd(8));
    expect(new Set(first).size).toBeGreaterThanOrEqual(6);
    const counts = new Array(8).fill(0);
    for (let i = 0; i < 8000; i++) counts[rnd(8)]++;
    for (const c of counts) expect(c).toBeGreaterThan(800);
  });

  // Shapes the merged main selects through the window: each holds on a use of the name, and must keep holding.
  const FLOOR: [string, string, string, string][] = [
    ["a call", `f(D) + "${big}"`, "use(D);", "index.js"],
    ["an expression group", `const x = (D) + "${big}"`, "use(D);", "index.js"],
    ["a python walrus", `(D := x) + "${big}"`, "use(D)", "a.py"],
    ["an indirect call with a comma", `(0, o.D)("${big}")`, "use(D);", "index.js"],
    ["a called group", `(D)("${big}")`, "use(D);", "index.js"],
    ["a parenthesized target", `(D) = "${big}"`, "use(D);", "index.js"],
    ["an if before the definition", `if (D) x = ["${big}"]`, "use(D);", "index.js"],
    ["a tuple", `(a, E) = "${big}"`, "use(E)", "a.py"],
    ["brackets inside strings", `x = "(", D = ")" + "${big}"`, "use(D);", "index.js"],
    ["the last parameter", `function D(a,b){return "${big}"}`, "use(b);", "index.js"],
    ["a then call", `A = p.then(r => r || "${big}")`, "use(A);", "index.js"],
  ];
  for (const [name, def, use, file] of FLOOR) {
    test(`the merged main's selection is kept: ${name}`, () => {
      const cut = new Set<string>();
      diff(def, use, file, cut);
      expect([...cut], name).toHaveLength(1);
    });
  }

  test("a shell then, done or pass is not a name: a clean shell file with a repeated loop holds nothing", () => {
    const sh = (u: string) => cutDiff(`for x in a; do echo ok; done # ${"R".repeat(30_000)}`, u);
    expect(sh("for y in b; do echo ok; done")).toBe(0);
    expect(sh("if a; then echo ok; fi")).toBe(0);
  });

  test("the comma cut keeps a name in a call, a list and a parameter list", () => {
    expect(cutDiff(`function D(a, b) { return "${big}" }`, "eval(D());")).toBe(1);
    expect(cutDiff(`D = f(x, "${big}");`, "eval(D);")).toBe(1);
    expect(cutDiff(`D = [x, "${big}"];`, "eval(D);")).toBe(1);
    expect(cutDiff(`const pre=1, D = f(x, "${big}");`, "eval(D);")).toBe(1);
    expect(cutDiff(`const pre=1, D = f(x, "${big}");`, "pre++;")).toBe(0);
    // Arguments and parameters are not in a binding position: a minified call names nothing new.
    expect(cutDiff(`n(e,t,"${big}")`, "use(e);")).toBe(0);
  });

  test("the generator draws every value, uniformly enough, with no overflow", () => {
    const rnd = makeRng(1);
    const first = Array.from({ length: 50 }, () => rnd(8));
    expect(new Set(first).size).toBeGreaterThanOrEqual(6);
    const counts = new Array(8).fill(0);
    for (let i = 0; i < 8000; i++) counts[rnd(8)]++;
    for (const c of counts) expect(c).toBeGreaterThan(800);
  });

  test("differential against the merged main's selection: names, listed definitions and holds are a superset", () => {
    const rnd = makeRng(11);
    const names = ["D", "$D", "$$D", "PAYLOAD", "$PAYLOAD", "pass", "done", "then", "default", "A", "E"];
    const forms = [
      (n: string, r: string) => `const ${n} = "${r}"`,
      (n: string, r: string) => `${n} = ("${r}")`,
      (n: string, r: string) => `const ${n} = Buffer.from("${r}")`,
      (n: string, r: string) => `const pre=1, ${n} = "${r}"`,
      (n: string, r: string) => `${n} = f(x, "${r}")`,
      (n: string, r: string) => `${n} = [x, "${r}"]`,
      (n: string, r: string) => `function ${n}(a, b) { return "${r}" }`,
      (n: string, r: string) => `const o = {k: 1, ${n}: "${r}"}`,
      (n: string, r: string) => `/* pre */ ${n} = "${r}"`,
      (n: string, r: string) => `f(${n}) + "${r}"`,
      (n: string, r: string) => `const x = (${n}) + "${r}"`,
      (n: string, r: string) => `(0, o.${n})("${r}")`,
      (n: string, r: string) => `(${n}) = "${r}"`,
      (n: string, r: string) => `if (${n}) x = ["${r}"]`,
      (n: string, r: string) => `(a, ${n}) = "${r}"`,
      (n: string, r: string) => `x = "(", ${n} = ")" + "${r}"`,
      (n: string, r: string) => `${n} = p.then(r => r || "${r}")`,
      (n: string, r: string) => `for x in a; do echo ok; done # ${r} ${n}`,
      (n: string, r: string) => `n(e, t, "${r}") // ${n}`,
      (n: string, r: string) => `${n} = "${r}"`,
    ];
    const seenName = new Set<string>();
    const seenForm = new Set<number>();
    for (let n = 0; n < 500; n++) {
      const defs = Array.from({ length: 1 + rnd(4) }, (_, i) => ({ name: names[rnd(names.length)]!, f: rnd(forms.length), run: String.fromCharCode(65 + i).repeat(450) + i }));
      const lines = defs.map((d) => forms[d.f]!(d.name, d.run));
      for (const d of defs) { seenName.add(d.name); seenForm.add(d.f); }
      const used = [...names, "pre", "e", "a", "b", "r"].filter(() => rnd(3) === 0);
      // names: every name the merged main selects for a line is selected on head
      for (const l of lines) {
        const got = new Set(encodedRunNames(l));
        for (const x of oracleNames(l)) expect(got.has(x), `${x} in ${l.slice(0, 60)}`).toBe(true);
      }
      // definitions: a line the merged main's rule selects (a name it selects, or its $-stripped use) is listed on head
      const out = diff(lines.join(";\n"), `use(${used.join(",")});`);
      defs.forEach((d, i) => {
        const sel = oracleNames(lines[i]!).some((x) => used.some((u) => u === x || u.replace(/^\$+/, "") === x));
        if (sel) expect(out, `${d.name} form ${d.f} used ${used}`).toContain(d.run);
      });
    }
    // holds: a single cut definition holds on head whenever it holds under the oracle's names
    for (let n = 0; n < 200; n++) {
      const d = { name: names[rnd(names.length)]!, f: rnd(forms.length) };
      const line = forms[d.f]!(d.name, "A".repeat(30_000));
      const used = [...names, "e", "a", "b", "r"].filter(() => rnd(3) === 0);
      const sel = oracleNames(line).some((x) => used.some((u) => u === x || u.replace(/^\$+/, "") === x));
      const cut = new Set<string>();
      diff(line, `use(${used.join(",")});`, "index.js", cut);
      if (sel) expect(cut.size, `${d.name} form ${d.f} used ${used}`).toBe(1);
    }
    expect(seenName.size).toBe(names.length);
    expect(seenForm.size).toBe(forms.length);
  });
});
