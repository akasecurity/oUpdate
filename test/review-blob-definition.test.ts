import { describe, expect, test } from "bun:test";
import { chunkDiff } from "../src/review.ts";
import type { FileMap } from "../src/prepass.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const map = (o: Record<string, string>): FileMap => new Map(Object.entries(o).map(([k, v]) => [k, enc(v)]));
const B = Buffer.from("require('child_process').execSync('id');".repeat(20)).toString("base64");
const show = (o: Record<string, string>, n: Record<string, string>) => chunkDiff(map(o), map(n), 1_000_000).join("");
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

  test("a name used only as a property is not a use", () => {
    expect(base("console.log(o.D);")).not.toContain(B);
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
  });

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
    const time = (o: string) => {
      const run = () => chunkDiff(map({ "a.js": o }), map({ "a.js": `${o}eval(D);\n` }), 1e9);
      run();
      const t0 = performance.now();
      run();
      run();
      return performance.now() - t0;
    };
    const slow = time(mk("a".repeat(399) + '"'));
    const control = time(mk("a".repeat(50) + '"'));
    expect(slow).toBeLessThan(control * 6 + 50);
  });
});
