import { describe, expect, test } from "bun:test";
import { chunkDiff } from "../src/review.ts";
import type { FileMap } from "../src/prepass.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const map = (o: Record<string, string>): FileMap => new Map(Object.entries(o).map(([k, v]) => [k, enc(v)]));
const B = Buffer.from("require('child_process').execSync('id');".repeat(20)).toString("base64");
const show = (o: Record<string, string>, n: Record<string, string>) => chunkDiff(map(o), map(n), 1_000_000).join("");

describe("an unchanged definition that holds an encoded run, named by a changed line", () => {
  test("a new eval of an unchanged const shows the const", () => {
    const out = show({ "index.js": `const D="${B}";\nmodule.exports=1;\n` }, { "index.js": `const D="${B}";\nmodule.exports=1;\neval(Buffer.from(D,"base64").toString());\n` });
    expect(out).toContain("+eval(Buffer.from(D,");
    expect(out).toContain(`D="${B}"`);
    expect(out).toContain("unchanged lines that define a name");
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

  test("a definition that is itself changed is shown once, as a changed line", () => {
    const out = show({ "index.js": `const D="x";\n` }, { "index.js": `const D="${B}";\neval(D);\n` });
    expect(out.split(B).length - 1).toBe(1);
  });

  test("a large file of long lines stays quick", () => {
    const filler = Array.from({ length: 2000 }, (_, i) => `const v${i}="${"a".repeat(4000)}";`).join("\n");
    const t0 = performance.now();
    show({ "index.js": `${filler}\nconst D="${B}";\n` }, { "index.js": `${filler}\nconst D="${B}";\neval(D);\n` });
    expect(performance.now() - t0).toBeLessThan(5000);
  });
});
