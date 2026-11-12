import { describe, expect, test } from "bun:test";
import { chunkDiff, reviewUpdate } from "../src/review.ts";
import { reviewLayers } from "../src/image-layers.ts";
import { LayerStore, LIMITS } from "../src/oci-fs.ts";
import type { FileMap } from "../src/prepass.ts";
import type { ImageEvidence } from "../src/targets/broker/answer.ts";
import { specLayers, withTmp } from "./oci-helpers.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const map = (o: Record<string, string>): FileMap => new Map(Object.entries(o).map(([k, v]) => [k, enc(v)]));
const B = Buffer.from("require('child_process').execSync('id');".repeat(20)).toString("base64");
const show = (o: Record<string, string>, n: Record<string, string>) => chunkDiff(map(o), map(n), 1_000_000).join("");

// Timing is only ever compared inside one process, as a ratio of two shapes: the median of 3 runs each after a warmup. No test bounds a wall-clock time.
const median3 = (f: () => unknown): number => {
  f();
  const t = [0, 1, 2].map(() => {
    const t0 = performance.now();
    f();
    return performance.now() - t0;
  });
  return t.sort((a, b) => a - b)[1]!;
};
const ratio = (slow: () => unknown, control: () => unknown): number => median3(slow) / Math.max(0.5, median3(control));
const SLOW = 60_000; // the explicit timeout of every test that builds megabytes of input
const base = (extra: string, file = "index.js") => show({ [file]: `const D="${B}";\nmodule.exports=1;\n` }, { [file]: `const D="${B}";\nmodule.exports=1;\n${extra}\n` });

describe("an unchanged definition that holds an encoded run, named by a changed line", () => {
  test("a new eval of an unchanged const shows the const", () => {
    const out = base(`eval(Buffer.from(D,"base64").toString());`);
    expect(out).toContain("+eval(Buffer.from(D,");
    expect(out).toContain(`D="${B}"`);
    expect(out).toContain("(a definition of D)");
  });

  test("an assignment without const, in a python file, is shown too", () => {
    const out = show({ "a.py": `D = "${B}"\nx = 1\n` }, { "a.py": `D = "${B}"\nx = 1\nexec(base64.b64decode(D))\n` });
    expect(out).toContain(B);
  });

  test("a const the changed lines do not name stays out", () => {
    const out = show({ "index.js": `const D="${B}";\nmodule.exports=1;\n` }, { "index.js": `const D="${B}";\nmodule.exports=2;\n` });
    expect(out).not.toContain(B);
  });

  test("a short string constant is not listed", () => {
    const out = show({ "index.js": `const D="abc";\nmodule.exports=1;\n` }, { "index.js": `const D="abc";\nmodule.exports=1;\neval(D);\n` });
    expect(out).not.toContain("unchanged lines that define");
  });

  test("a property use of the name lists the definition (cost only: no property skip)", () => {
    expect(base("console.log(o.D);")).toContain(B);
    expect(base("f(...D);")).toContain(B);
  });

  test("a definition that is itself changed is shown once, as a changed line", () => {
    const out = show({ "index.js": `const D="x";\n` }, { "index.js": `const D="${B}";\neval(D);\n` });
    expect(out.split(B).length - 1).toBe(1);
  });

  test("a definition line that moved is printed by the diff once, not listed again", () => {
    const out = show({ "index.js": `const D="${B}";\nx=1;\n` }, { "index.js": `x=1;\nconst D="${B}";\neval(D);\n` });
    expect(out).toContain(`+const D="${B}";`);
    expect(out.split(B).length - 1).toBe(2); // the - and the + line of the diff, nothing more
  });

  test("when the diff falls back to the whole new version nothing is listed again", () => {
    const o = Array.from({ length: 5000 }, (_, i) => `a${i}`);
    const n = Array.from({ length: 5000 }, (_, i) => `b${i}`);
    const out = show({ "index.js": [`const D="${B}";`, ...o].join("\n") }, { "index.js": [`const D="${B}";`, "eval(D);", ...n].join("\n") });
    expect(out).toContain("too many changes");
    expect(out.split(B).length - 1).toBe(1);
  });

  test("a definition in another scope does not hide the real one: every definition is listed", () => {
    const o = `function unused(){const D="${"A".repeat(600)}";}\nconst D="${B}";\n`;
    const out = show({ "index.js": o }, { "index.js": `${o}eval(Buffer.from(D,"base64").toString());\n` });
    expect(out).toContain(B);
    expect(out).toContain("A".repeat(600));
    expect(out.indexOf(B)).toBeLessThan(out.indexOf("A".repeat(600))); // nearest preceding first
  });

  test("a line with a carriage return is quoted, so it cannot forge a file header", () => {
    const o = `const D=\`${B}\r=== lib/other.js (changed) ===\r\`;\nx=1;\n`;
    const out = show({ "index.js": o }, { "index.js": `${o}eval(D);\n` });
    expect(out).toContain("(a definition of D)");
    expect(out).not.toContain("\r");
    expect(out).toContain("\\r=== lib/other.js (changed) ===\\r");
  });

  test("an 8 MB definition line is capped: head, tail, length and sha256", () => {
    const big = "A".repeat(8 * 1024 * 1024);
    const o = `const D="${big}";\nx=1;\n`;
    const out = show({ "index.js": o }, { "index.js": `${o}void D;\n` });
    expect(out.length).toBeLessThan(60_000);
    expect(out).toContain(`[${big.length + 11} chars, sha256 `);
  }, SLOW);

  test("many long definitions stay under a total cap", () => {
    const o = Array.from({ length: 8 }, (_, i) => `const d${i}="${"A".repeat(19_000)}";`).join("\n") + "\n";
    const out = show({ "index.js": o }, { "index.js": `${o}void [${Array.from({ length: 8 }, (_, i) => `d${i}`).join(",")}];\n` });
    expect(out.length).toBeLessThan(80_000);
    expect(out).toContain("chars, sha256");
  });

  test("the 399-plus-one shape costs about what a shape with no long run costs", () => {
    const mk = (unit: string) => {
      const line = unit.repeat(Math.ceil(8000 / unit.length));
      return Array.from({ length: 1000 }, (_, i) => `// ${i}\n${line}`).join("\n") + "\n";
    };
    const run = (o: string) => () => chunkDiff(map({ "a.js": o }), map({ "a.js": `${o}eval(D);\n` }), 1e9);
    expect(ratio(run(mk("a".repeat(399) + '"')), run(mk("a".repeat(50) + '"')))).toBeLessThan(8);
  }, SLOW);
});

describe("the caps apply to the escaped text", () => {
  test("three definitions with a carriage return and control characters stay under the total cap", () => {
    const d = (n: number) => `const d${n}=\`${"A".repeat(400)}\r${"\x01".repeat(18_500)}\`;`;
    const o = [0, 1, 2].map(d).join("\n") + "\n";
    const old = map({ "index.js": o });
    const now = map({ "index.js": `${o}void [d0,d1,d2];\n` });
    const chunks = chunkDiff(old, now, 60_000);
    const all = chunks.join("");
    const supplement = all.slice(all.indexOf("[unchanged lines that define"));
    expect(supplement.length).toBeLessThanOrEqual(60_000);
    expect(all.length).toBeLessThan(70_000);
    expect(chunks.length).toBeLessThanOrEqual(2);
    expect(supplement).toContain("a definition of d0");
  });
});

describe("a definition on a property, and one too large to show whole", () => {
  const pkg = JSON.stringify({ name: "p", version: "1.0.0", main: "index.js" });
  const diff = (ctx: string, use: string, cut?: Set<string>) =>
    chunkDiff(map({ "package.json": pkg, "index.js": `${ctx}\nmodule.exports=1;\n` }), map({ "package.json": pkg, "index.js": `${ctx}\nmodule.exports=1;\n${use}\n` }), 10_000_000, undefined, false, new Set(), cut).join("");

  for (const r of ["exports", "module.exports", "this", "globalThis", "o"]) {
    test(`${r}.D defined and used as a property shows the definition`, () => {
      expect(diff(`${r === "o" ? "const o={};" : ""}${r}.D="${B}";`, `eval(Buffer.from(${r}.D,"base64").toString());`)).toContain(B);
    });
  }
  test("an optional-chained use o?.D shows the definition", () => {
    expect(diff(`const o={};o.D="${B}";`, `eval(Buffer.from(o?.D,"base64").toString());`)).toContain(B);
  });

  test("a 30,000-char definition line is cut and reported", () => {
    const cut = new Set<string>();
    const mid = "A".repeat(22000) + "PAYLOADMIDDLEMARK" + "A".repeat(7983);
    diff(`const D="${mid}";`, "eval(D);", cut);
    expect([...cut]).toEqual(["index.js"]);
  });

  test("four 14,900-char decoys used first leave D past the total cap: reported", () => {
    const dec = [0, 1, 2, 3].map((i) => `const Z${i}="${String.fromCharCode(66 + i).repeat(14900)}";`).join("\n");
    const cut = new Set<string>();
    diff(`${dec}\nconst D="${B}";`, `void Z0,Z1,Z2,Z3;eval(Buffer.from(D,"base64").toString());`, cut);
    expect([...cut]).toEqual(["index.js"]);
  });

  test("nine used definitions are past the limit of eight: reported", () => {
    const d = Array.from({ length: 9 }, (_, i) => `const Z${i}="${String.fromCharCode(66 + i).repeat(400)}";`).join("\n");
    const cut = new Set<string>();
    diff(d, Array.from({ length: 9 }, (_, i) => `void Z${i};`).join(""), cut);
    expect([...cut]).toEqual(["index.js"]);
  });

  test("a definition shown whole is not reported", () => {
    const cut = new Set<string>();
    diff(`const D="${B}";`, "eval(D);", cut);
    expect(cut.size).toBe(0);
  });

  test("the review holds for a human when a used definition is cut, even on an APPROVE", async () => {
    const mid = "A".repeat(22000) + "PAYLOADMIDDLEMARK" + "A".repeat(7983);
    const ctx = `const D="${mid}";\nmodule.exports=1;\n`;
    const r = await reviewUpdate({
      eco: "npm", name: "p", from: "1.0.0", to: "1.0.1",
      registry: { latest: async () => undefined, publishedAt: async () => new Date("2020-01-01"), artifactUrls: async () => [] },
      advisories: { query: async () => [] },
      reviewer: { name: "fake", review: async () => "APPROVE\nno attack indicators found" },
      cooldownDays: 1, now: new Date("2026-10-21T00:00:00Z"),
      loadArtifacts: async () => ({ old: map({ "package.json": pkg, "index.js": ctx }), new: map({ "package.json": pkg, "index.js": `${ctx}eval(D);\n` }) }),
    });
    const l = r.layers.find((x) => x.layer === "reviewer");
    expect(l?.verdict).toBe("stop");
    expect(l?.detail).toContain("not model-reviewable: definition too large to show in index.js");
    expect(l?.detail).toContain("needs a human");
  });
});

describe("a cut definition holds whenever its name is on a changed line, in any form", () => {
  const BIG = "A".repeat(30_000);
  const B29 = Buffer.from('console.log("RAN198");'.repeat(1000)).toString("base64"); // about 29k
  const pkg = JSON.stringify({ name: "p", version: "1.0.0", main: "index.js" });
  const cutOf = (o: string, n: string, file = "index.js") => {
    const cut = new Set<string>();
    chunkDiff(map({ "package.json": pkg, [file]: o }), map({ "package.json": pkg, [file]: n }), 10_000_000, undefined, false, new Set(), cut);
    return cut.size;
  };
  const dec = (x: string) => `Buffer.from(${x},"base64").toString()`;

  // Uses a one-line reading of the changed line would take for a non-use: each is a use that runs the payload.
  const uses: [string, string, string][] = [
    ["a string naming D, eval'd", `var D="${B29}";`, `eval("eval(Buffer.from(D,'base64').toString())");`],
    ["Function with a string body", `var D="${B29}";`, `Function("D","eval(Buffer.from(D,'base64').toString())")(eval("D"));`],
    ["this[\"D\"] for this.D", `this.D="${B29}";`, `eval(${dec('this["D"]')});`],
    ["exports[\"D\"] for exports.D", `exports.D="${B29}";`, `eval(${dec('exports["D"]')});`],
    ["a regex after if that looks like a division", `var D="${B29}";`, `if (1) /'/.test(""), eval(${dec("D")}); //'`],
    ["a template with a brace that unbalances a parameter shadow", `var D="${B29}";`, `function f(D){ return \`\${"{"}\`; } eval(${dec("D")});`],
    ["a parameter of the same name, then the outer use", `var D="${B29}";`, `[1].map(D=>D), eval(${dec("D")});`],
    ["a catch parameter of the same name, then the outer use", `var D="${B29}";`, `try{throw 0}catch(D){} eval(${dec("D")});`],
    ["plain use", `var D="${B29}";`, `eval(${dec("D")});`],
    ["property use of a property definition", `exports.D="${B29}";`, `eval(${dec("exports.D")});`],
    ["a template interpolation", `var D="${B29}";`, `eval(${dec("`${D}`")});`],
  ];
  for (const [k, def, use] of uses)
    test(`holds: ${k}`, () => {
      expect(cutOf(`${def}\nmodule.exports=1;\n`, `${def}\nmodule.exports=1;\n${use}\n`)).toBe(1);
    });

  // The cost of selecting by name alone: a same-named token that is not a use also holds a cut definition. Asserted, not hidden.
  test("accepted cost: a same-named parameter, key, comment, string or property holds a cut definition", () => {
    const o = `const D="${BIG}";\nmodule.exports=1;\n`;
    for (const use of ["function f(D){return 1;}", "const o={D:1};", "// D", 'console.log("D");', "console.log(o.D);"]) expect(cutOf(o, `${o}${use}\n`)).toBe(1);
    const unused = `function unused(){const data="${BIG}";}\nfunction f(data){return 1;}\n`;
    expect(cutOf(unused, unused.replace("return 1", "return 2"))).toBe(1);
  });

  test("accepted cost: nine unrelated functions that define x and a changed identity function hold; a minified e with t.e holds", () => {
    const nine = Array.from({ length: 9 }, (_, i) => `function f${i}(){const x="${"B".repeat(400)}";}`).join("\n") + "\n";
    expect(cutOf(nine, `${nine}function identity(x){return x;}\n`)).toBe(1);
    const e = `var e="${"A".repeat(300_000)}";\nmodule.exports=1;\n`;
    expect(cutOf(e, `${e}t.e=1;\n`)).toBe(1);
  }, SLOW);

  test("controls: a changed line that names no cut definition holds nothing", () => {
    const o = `const D="${BIG}";\nmodule.exports=1;\n`;
    expect(cutOf(o, `${o}module.exports=2;\n`)).toBe(0);
    const nine = Array.from({ length: 9 }, (_, i) => `function f${i}(){const x="${"B".repeat(400)}";}`).join("\n") + "\n";
    expect(cutOf(nine, `${nine}function identity(y){return y;}\n`)).toBe(0);
  });

  test("nine definitions of one used name hold; a definition of 19,990 chars is shown whole and holds nothing", () => {
    const nine = Array.from({ length: 9 }, () => `expected = "${"f".repeat(500)}"`).join("\n") + "\n";
    expect(cutOf(nine, `${nine}assert f(x) == expected\n`, "tests/test_vectors.py")).toBe(1);
    const near = `const D="${"A".repeat(19_990 - 11)}";\n`; // a 19,990-char line
    expect(near.length - 1).toBe(19_990);
    expect(cutOf(near, `${near}eval(D);\n`)).toBe(0);
    // Shown whole: the label is not counted against the per-line limit, so the full line is in the listing and nothing is cut.
    const shown = chunkDiff(map({ "package.json": pkg, "index.js": near }), map({ "package.json": pkg, "index.js": `${near}eval(D);\n` }), 10_000_000).join("");
    expect(shown).toContain(`: ${near.trimEnd()}\n`);
    expect(shown).not.toContain("chars, sha256");
    const over = `const D="${"A".repeat(20_001)}";\n`;
    expect(cutOf(over, `${over}eval(D);\n`)).toBe(1);
  });

  test("a line that defines several used names is listed once", () => {
    const o = `const ${Array.from({ length: 8 }, (_, i) => `D${i}="${"A".repeat(400)}"`).join(",")};\r${"\x01".repeat(1_000_000)}\n`;
    const out = chunkDiff(map({ "package.json": pkg, "index.js": o }), map({ "package.json": pkg, "index.js": `${o}void [${Array.from({ length: 8 }, (_, i) => `D${i}`).join(",")}];\n` }), 10_000_000).join("");
    expect(out.split("chars, sha256").length - 1).toBe(1);
    expect(out).toContain("(a definition of D0, D1, D2, D3, D4, D5, D6, D7)");
    expect(out.slice(out.indexOf("[unchanged lines")).length).toBeLessThanOrEqual(60_000);
  }, SLOW);

  test("the review holds for a named cut definition, and a short definition with the same setup passes", async () => {
    const run = async (def: string) => {
      const ctx = `const D="${def}";\nmodule.exports=1;\n`;
      const r = await reviewUpdate({
        eco: "npm", name: "p", from: "1.0.0", to: "1.0.1",
        registry: { latest: async () => undefined, publishedAt: async () => new Date("2020-01-01"), artifactUrls: async () => [] },
        advisories: { query: async () => [] },
        reviewer: { name: "fake", review: async () => "APPROVE\nno attack indicators found" },
        cooldownDays: 1, now: new Date("2026-10-21T00:00:00Z"),
        loadArtifacts: async () => ({ old: map({ "package.json": pkg, "index.js": ctx }), new: map({ "package.json": pkg, "index.js": `${ctx}f(D);\n` }) }),
      });
      return r.layers.find((x) => x.layer === "reviewer");
    };
    expect((await run("A".repeat(30_000)))?.detail).toContain("not model-reviewable: definition too large to show");
    expect((await run("A".repeat(500)))?.verdict).toBe("pass");
  });
});

describe("an image layer file with a used definition that is cut holds", () => {
  const EV: ImageEvidence = { entrypoint: '["/app/server"]', cmd: "null", history: [] };
  const review = (def: string) =>
    withTmp(async (dir) => {
      const before = { "app/index.js": `const D="${def}";\nmodule.exports=1;\n` };
      const after = { "app/index.js": `const D="${def}";\nmodule.exports=1;\nf(D);\n` };
      return reviewLayers({ old: specLayers(dir, "o", [before]), new: specLayers(dir, "n", [before, after]), newEvidence: EV, store: new LayerStore(dir, LIMITS) });
    });

  test("a 30,000-char definition used by the changed line is a hit; a short one is not", async () => {
    expect((await review("A".repeat(30_000))).hits.some((h) => h.startsWith("not model-reviewable: definition too large to show in app/index.js"))).toBe(true);
    const short = await review("A".repeat(500));
    expect(short.hits.some((h) => h.includes("definition too large"))).toBe(false);
    expect(short.parts.join("\n")).toContain("A".repeat(500));
  });
});

describe("selection by a shell variable, no lexer left, no hang", () => {
  const BIG = "A".repeat(30_000);
  const pkg = JSON.stringify({ name: "p", version: "1.0.0", main: "index.js" });
  const cutOf = (o: string, n: string, file = "index.js") => {
    const cut = new Set<string>();
    const out = chunkDiff(map({ "package.json": pkg, [file]: o }), map({ "package.json": pkg, [file]: n }), 10_000_000, undefined, false, new Set(), cut).join("");
    return { cut: cut.size, out };
  };

  test("a shell or PHP variable $D selects the definition D", () => {
    const o = `D="${BIG}"\n`;
    const r = cutOf(o, `${o}echo "$D"|base64 -d|sh\n`, "install.sh");
    expect(r.cut).toBe(1);
    expect(r.out).toContain("(a definition of D)");
    expect(cutOf(o, `${o}echo "\${D}"|base64 -d|sh\n`, "install.sh").cut).toBe(1);
    expect(cutOf(`$D="${BIG}";\n`, `$D="${BIG}";\neval($D);\n`, "a.php").cut).toBe(1); // a name defined with its $ still matches
    expect(cutOf(o, `${o}echo "$E"\n`, "install.sh").cut).toBe(0);
  });

  test("the source has no narrowing code: no lexer, no body or shadow scan, no arrow-parameter pattern", async () => {
    const src = await Bun.file(new URL("../src/review.ts", import.meta.url)).text();
    for (const gone of ["narrowUses", "bodyEnd", "blankNonCode", "shadows", "DECL_WORDS"]) expect(src).not.toContain(gone);
  });

  test("minified long identifier runs and a name repeated 100,000 times cost about what the same size of short tokens costs", () => {
    const o = `const D="${BIG}";\n`;
    const run = (added: string) => () => cutOf(o, `${o}${added}\n`);
    const MB = 4 * 1024 * 1024;
    const shortTokens = "x;".repeat(MB / 2);
    expect(cutOf(o, `${o}${"a".repeat(MB)}\n`).cut).toBe(0);
    expect(cutOf(o, `${o}${"D;".repeat(100_000)}\n`).cut).toBe(1);
    expect(ratio(run("a".repeat(MB)), run(shortTokens))).toBeLessThan(10); // one long identifier
    expect(ratio(run(Array.from({ length: 400_000 }, (_, i) => `v${i}`).join("+")), run(shortTokens))).toBeLessThan(10); // many distinct names
    expect(ratio(run("D;".repeat(100_000)), run("x;".repeat(100_000)))).toBeLessThan(10); // one selected name, many times
  }, SLOW);
});

describe("a changed sourcesContent entry of a padded map", () => {
  const B29 = Buffer.from('console.log("RAN198");'.repeat(1000)).toString("base64");
  const mapOf = (content: string) => JSON.stringify({ version: 3, file: "index.js", sources: ["a.js"], names: [], sourcesContent: [content], mappings: "AAAACAAO,aAAP,OAAO,uBAAP;".repeat(250_000) });
  const pkg = JSON.stringify({ name: "p", version: "1.0.0", main: "index.js" });
  test("a used cut definition in the entry is reported", () => {
    const def = `var D="${B29}";\nmodule.exports=1;\n`;
    const files = (c: string): FileMap => map({ "package.json": pkg, "index.js": "module.exports=1;\n", "index.js.map": mapOf(c) });
    const cut = new Set<string>();
    const out = chunkDiff(files(def), files(`${def}eval(Buffer.from(D,"base64").toString());\n`), 10_000_000, undefined, false, new Set(), cut).join("");
    expect(out).toContain("sourcesContent a.js");
    expect([...cut]).toEqual(["index.js.map sourcesContent a.js"]);
  }, SLOW);
});
