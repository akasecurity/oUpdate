import { test, expect } from "bun:test";
import { reviewUpdate } from "../src/review.ts";
import type { FileMap } from "../src/prepass.ts";
const enc = (s: string) => new TextEncoder().encode(s);
const files = (o: Record<string, string>): FileMap => new Map(Object.entries(o).map(([k, v]) => [k, enc(v)]));
const SPAWN = "require('child_process').exec(process.env.Q)";
type M = { sources: string[]; sc?: (string | null)[]; names?: string[] };
const map = (seed: string, big: boolean, m: M) => JSON.stringify({ version: 3, file: "index.js", sources: m.sources, names: m.names ?? [], sourcesContent: m.sc ?? m.sources.map(() => "ok"), mappings: ("AAAA" + seed + "CAAO,aAAP,OAAO,uBAAP;").repeat(big ? 250_000 : 20) });
const READDIR = (src: string) => `const fs = require('fs');\nconst f = fs.readdirSync(__dirname).find((f) => f.endsWith('map'));\nconst m = JSON.parse(fs.readFileSync(__dirname + '/' + f, 'utf8'));\nrequire('vm').runInThisContext(${src});\nexports.v = 2;\n`;
// The map is named by a folded string ('js.m' + 'ap'), not a bare .map, and read at index k through a split key.
const FOLDED = (k: string) => `const m = JSON.parse(require('fs').readFileSync(__filename.replace(/js$/, 'js.m' + 'ap'), 'utf8'));\nrequire('vm').runInThisContext(m['sources'+'Content'][${k}]);\nexports.v = 2;\n`;
const SC1 = "m['sources'+'Content'][1]";
const A = SPAWN.slice(0, 26), B = SPAWN.slice(26);
const cases: [string, string, M, M][] = [
  ["D1 duplicate names, payload first, old single clean", READDIR(SC1), { sources: ["a.ts"], sc: ["clean"] }, { sources: ["a.ts", "a.ts"], sc: [SPAWN, "clean"] }],
  ["D2 duplicate names swapped in new", READDIR("m['sources'+'Content'][0]"), { sources: ["a.ts", "a.ts"], sc: [SPAWN, "clean"] }, { sources: ["a.ts", "a.ts"], sc: ["clean", SPAWN] }],
  ["D3 duplicate names, payload second, old duplicates", READDIR(SC1), { sources: ["a.ts", "a.ts"], sc: ["ok", "ok"] }, { sources: ["a.ts", "a.ts"], sc: ["ok", SPAWN] }],
  ["D4 old [a,a]=[clean,P0], new [a,a]=[P0,P1]: both entries by index", FOLDED("0"), { sources: ["a.ts", "a.ts"], sc: ["clean", "require('child_process').exec(process.env.P0)"] }, { sources: ["a.ts", "a.ts"], sc: ["require('child_process').exec(process.env.P0)", "require('child_process').exec(process.env.P1)"] }],
  ["D5 old [a,a]=[clean,SPAWN], new swapped [SPAWN,clean], loader reads [0]", FOLDED("0"), { sources: ["a.ts", "a.ts"], sc: ["clean", SPAWN] }, { sources: ["a.ts", "a.ts"], sc: [SPAWN, "clean"] }],
  ["S3 shift: old [a,a]=[clean,P] -> new [a,a,a]=[clean,clean,P], loader reads [2]", FOLDED("2"), { sources: ["a.ts", "a.ts"], sc: ["clean", SPAWN] }, { sources: ["a.ts", "a.ts", "a.ts"], sc: ["clean", "clean", SPAWN] }],
  ["S5 reorder with distinct names: old [x,a]=[clean,P] -> new [a,x]=[P,clean], loader reads [0]", FOLDED("0"), { sources: ["x.ts", "a.ts"], sc: ["clean", SPAWN] }, { sources: ["a.ts", "x.ts"], sc: [SPAWN, "clean"] }],
  ["N1 names split, loader reverses", READDIR("m.names.reverse().join('')"), { sources: ["a.ts"] }, { sources: ["a.ts"], names: [B, A] }],
  ["N2 names split, forward join", READDIR("m.names.join('')"), { sources: ["a.ts"] }, { sources: ["a.ts"], names: [A, B] }],
];
for (const big of [true, false]) for (const [label, code, o, n] of cases) test(label + " big=" + big, async () => {
  const reviewed: string[] = [];
  const r = await reviewUpdate({
    eco: "npm", name: "lib", from: "1.0.0", to: "1.0.1",
    registry: { latest: async () => undefined, publishedAt: async () => new Date("2020-01-01"), artifactUrls: async () => [] },
    advisories: { query: async () => [] },
    reviewer: { name: "fake", review: async (p) => (reviewed.push(p), "APPROVE\nno attack indicators found") },
    cooldownDays: 1, now: new Date("2026-10-21T00:00:00Z"), chunkChars: 60000,
    loadArtifacts: async () => ({
      old: files({ "package.json": '{"name":"lib","version":"a","main":"lib/index.js"}', "lib/index.js": "exports.v = 1;\n", "lib/index.js.map": map("a", big, o) }),
      new: files({ "package.json": '{"name":"lib","version":"b","main":"lib/index.js"}', "lib/index.js": code, "lib/index.js.map": map("b", big, n) }),
    }),
  });
  const t = reviewed.join("");
  // A padded map lists each changed entry (the loader names its map by a folded string, so it stays hashed); a small map is shown whole as a token diff, where a changed word appears as {+word+}.
  const shown = /^D[45]/.test(label)
    ? big
      ? (t.match(/=== lib\/index\.js\.map sourcesContent a\.ts \(/g) ?? []).length === 2 && t.includes(label.startsWith("D5") ? "process.env.Q" : "process.env.P1")
      : t.includes(label.startsWith("D5") ? "process.env.Q" : "process.env.P0") && (label.startsWith("D5") || t.includes("{+P1+}"))
    : (n.names?.length ? t.includes("require(") : true) && t.includes("process.env.Q");
  expect({ label, big, decision: r.decision, payloadShown: shown }).toMatchObject({ payloadShown: true });
}, 60000);

// Names split inside "child_process" and put back in reverse by a loader that finds the map with endsWith('map'): no element and no forward join matches a pattern.
// A padded map must treat it exactly as a small one does (today both are shown in full, since the loader holds a bare "map" string and reads JSON); this pins parity, not the outcome.
test("names split inside child_process, reversed by a readdir loader: a padded map and a small map are treated alike", async () => {
  const X = "require('child", Y = "_process').exec(process.env.Q)";
  const outcome = async (big: boolean) => {
    const reviewed: string[] = [];
    await reviewUpdate({
      eco: "npm", name: "lib", from: "1.0.0", to: "1.0.1",
      registry: { latest: async () => undefined, publishedAt: async () => new Date("2020-01-01"), artifactUrls: async () => [] },
      advisories: { query: async () => [] },
      reviewer: { name: "fake", review: async (p) => (reviewed.push(p), "APPROVE\nno attack indicators found") },
      cooldownDays: 1, now: new Date("2026-10-21T00:00:00Z"), chunkChars: 60000,
      loadArtifacts: async () => ({
        old: files({ "package.json": '{"name":"lib","version":"a","main":"lib/index.js"}', "lib/index.js": "exports.v = 1;\n", "lib/index.js.map": map("a", big, { sources: ["a.ts"] }) }),
        new: files({ "package.json": '{"name":"lib","version":"b","main":"lib/index.js"}', "lib/index.js": READDIR("m.names.reverse().join('')"), "lib/index.js.map": map("b", big, { sources: ["a.ts"], names: [Y, X] }) }),
      }),
    });
    const t = reviewed.join("");
    return t.includes("process.env.Q") && t.includes("require('child");
  };
  expect(await outcome(true)).toBe(await outcome(false));
}, 60000);

// The bare "map" string counts only in a file that itself reads files and calls JSON.parse. The string in one file and the loader in another is not a name: the map stays hashed, and a payload split across names is hidden (a known limit, pinned here so the per-file scope cannot widen unseen).
const REVLOADER = `const fs = require('fs');\nconst f = fs.readdirSync(__dirname).find((f) => f.endsWith('pam'.split('').reverse().join('')));\nconst m = JSON.parse(fs.readFileSync(__dirname + '/' + f, 'utf8'));\nrequire('vm').runInThisContext(m.names.reverse().join(''));\nexports.v = 2;\n`;
test("the map string in one file and the loader in another: the per-file scope keeps the map hashed, the same file shows it", async () => {
  const X = "require('child", Y = "_process').exec(process.env.Q)";
  const shown = async (big: boolean, loader: string, other: string) => {
    const reviewed: string[] = [];
    await reviewUpdate({
      eco: "npm", name: "lib", from: "1.0.0", to: "1.0.1",
      registry: { latest: async () => undefined, publishedAt: async () => new Date("2020-01-01"), artifactUrls: async () => [] },
      advisories: { query: async () => [] },
      reviewer: { name: "fake", review: async (p) => (reviewed.push(p), "APPROVE\nno attack indicators found") },
      cooldownDays: 1, now: new Date("2026-10-21T00:00:00Z"), chunkChars: 60000,
      loadArtifacts: async () => ({
        old: files({ "package.json": '{"name":"lib","version":"a","main":"lib/index.js"}', "lib/index.js": "exports.v = 1;\n", "lib/index.js.map": map("a", big, { sources: ["a.ts"] }) }),
        new: files({ "package.json": '{"name":"lib","version":"b","main":"lib/index.js"}', "lib/index.js": loader, "lib/util.js": other, "lib/index.js.map": map("b", big, { sources: ["a.ts"], names: [Y, X] }) }),
      }),
    });
    const t = reviewed.join("");
    return t.includes("process.env.Q") && t.includes("require('child");
  };
  for (const big of [true, false]) {
    expect(await shown(big, REVLOADER, "exports.kinds = ['map', 'set'];\n")).toBe(false); // "map" in util.js, loader in index.js: hidden
    expect(await shown(big, REVLOADER.replace("exports.v = 2;", "exports.v = 2; exports.k = 'map';"), "exports.x = 1;\n")).toBe(true); // "map" in the loader file itself: shown
  }
}, 120000);
