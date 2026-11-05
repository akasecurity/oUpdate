import { test, expect } from "bun:test";
import { reviewUpdate } from "../src/review.ts";
import type { FileMap } from "../src/prepass.ts";

// A bundle that carries a word list (the BIP39 list has "map") and also reads JSON must not show every map of its package: the bare word "map"
// counts as a run-time name tail only when it is not one of many words in a table.
const enc = (s: string) => new TextEncoder().encode(s);
const files = (o: Record<string, string>): FileMap => new Map(Object.entries(o).map(([k, v]) => [k, enc(v)]));
const MARK = "QZMARKQZ";
const map = (seed: string) => JSON.stringify({ version: 3, file: "index.js", sources: ["a.ts"], names: [], sourcesContent: ["ok"], mappings: ("AAAA" + seed + "CAAO,aAAP,OAAO,uBAAP;").repeat(250_000) });
const words = (n: number, withMap: boolean) => Array.from({ length: n }, (_, i) => (withMap && i === n >> 1 ? "map" : "w" + i.toString(36))).map((w) => JSON.stringify(w)).join(",\n  ");
const READS = "const fs = require('fs');\nconst cfg = JSON.parse(fs.readFileSync(__dirname + '/cfg.json', 'utf8'));\nexports.v = cfg.v;\n";
const cases: [string, string, boolean][] = [
  ["word list with map, bundle reads JSON: map stays hashed", `const WORDS = [\n  ${words(2048, true)}\n];\n${READS}`, false],
  ["a run-time name built from parts: map shown", `${READS}const n = ["index", "js", "map"].join(".");\n`, true],
  ["word list and a name built from parts: map shown", `const WORDS = [\n  ${words(2048, true)}\n];\n${READS}const n = ["index", "js", "map"].join(".");\n`, true],
  ["word list without map and a bare map string elsewhere: map shown", `const WORDS = [\n  ${words(2048, false)}\n];\n${READS}const e = "map";\n`, true],
  ["a few decoys around map in a small array: still shown", `${READS}const n = ["a", "b", "c", "index", "js", "map"].join(".");\n`, true],
  // Known limit: 40 decoy strings around the "map" make it look like a table, so the map stays hashed.
  ["known limit: 40 decoys around map hide it", `${READS}const n = [\n  ${words(40, true)}\n].slice(-3).join(".");\n`, false],
];
for (const [label, code, shown] of cases) test(label, async () => {
  const reviewed: string[] = [];
  await reviewUpdate({
    eco: "npm", name: "lib", from: "1.0.0", to: "1.0.1",
    registry: { latest: async () => undefined, publishedAt: async () => new Date("2020-01-01"), artifactUrls: async () => [] },
    advisories: { query: async () => [] },
    reviewer: { name: "fake", review: async (p) => (reviewed.push(p), "APPROVE\nno attack indicators found") },
    cooldownDays: 1, now: new Date("2026-10-21T00:00:00Z"), chunkChars: 60000,
    loadArtifacts: async () => ({
      old: files({ "package.json": '{"name":"lib","version":"a","main":"lib/index.js"}', "lib/index.js": "exports.v = 1;\n", "lib/index.js.map": map("A") }),
      new: files({ "package.json": '{"name":"lib","version":"b","main":"lib/index.js"}', "lib/index.js": code, "lib/index.js.map": map(MARK) }),
    }),
  });
  expect(reviewed.join("").includes(MARK)).toBe(shown);
}, 60_000);
