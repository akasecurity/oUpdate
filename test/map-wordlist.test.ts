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
const TPL_LOADER = "const fs = require('fs');\nconst cfg = JSON.parse(fs.readFileSync(`${__dirname}/${[\"index\", \"js\", \"map\"].join(\".\")}`, 'utf8'));\nexports.v = cfg.v;\n";
const CONSTS = Array.from({ length: 220 }, (_, i) => `const k${i} = "k${i}";`).join("\n");
const LOAD = "const m = JSON.parse(require('fs').readFileSync(__filename + '.' + ext, 'utf8'));\n";
const REGEX_OPEN = "const r = /\\[/;\n";
const NESTED_TPL = "const t = `a${f ? `[` : \"\"}b`;\n";
const BALANCED = "const r = /[a-z]+/g; const q = `x${r.test(\"a\") ? `y` : \"z\"}`;\n";
const T8 = "const D = [" + Array.from({ length: 220 }, (_, i) => JSON.stringify("s" + i)).join(", ") + ", /\\[/];\nconst e = \"map\";\nconst n = require('fs').readFileSync([__dirname, \"index\", \"js\"].join(\".\") + \".\" + e);\nconst r = /]/;\n";
// 200 or more short strings in the array that holds the map make it a table.
const TAIL_TPL = "const n = `${__dirname}/${f}map`;\n";
const REGEX_CLASS = "const r = /[\\[]/;\n";
const cases: [string, string, boolean][] = [
  ["word list with map, bundle reads JSON: map stays hashed", `const WORDS = [\n  ${words(2048, true)}\n];\n${READS}`, false],
  ["a run-time name built from parts: map shown", `${READS}const n = ["index", "js", "map"].join(".");\n`, true],
  ["word list and a name built from parts: map shown", `const WORDS = [\n  ${words(2048, true)}\n];\n${READS}const n = ["index", "js", "map"].join(".");\n`, true],
  ["word list without map and a bare map string elsewhere: map shown", `const WORDS = [\n  ${words(2048, false)}\n];\n${READS}const e = "map";\n`, true],
  ["a few decoys around map in a small array: still shown", `${READS}const n = ["a", "b", "c", "index", "js", "map"].join(".");\n`, true],
  ["an unrelated list of 220 strings before a name built from parts: map shown", `${READS}const LIST = [\n  ${words(220, false)}\n];\nconst n = ["index", "js", "map"].join(".");\n`, true],
  ["a table of numbers beside a name built from parts: map shown", `${READS}const T = [${Array.from({ length: 260 }, (_, i) => i).join(", ")}];\nconst n = ["index", "js", "map"].join(".");\n`, true],
  ["a word list directly followed by a name built from parts: map shown", `${READS}const W = [\n  ${words(220, false)}\n]; const n = ["index", "js", "map"].join(".");\n`, true],
  ["a word list that holds map many times, one pass per file: map stays hashed", `const W = [\n  ${Array.from({ length: 3000 }, (_, i) => (i % 31 === 0 ? "\"map\"" : JSON.stringify("w" + i))).join(",\n  ")}\n];\n${READS}`, false],
  ["a word list holding map and a loader whose name is built inside a template interpolation: map shown", `const WORDS = [\n  ${words(2048, true)}\n];\n${TPL_LOADER}`, true],
  ["a regex literal with an open bracket, then a name from parts among 220 short strings: map shown", `${READS}function g(f) {\n${REGEX_OPEN}const ext = process.env.X || "map";\n${CONSTS}\n${LOAD}}\n`, true],
  ["a nested template with an open bracket, then a name from parts among 220 short strings: map shown", `${READS}function g(f) {\n${NESTED_TPL}const ext = process.env.X || "map";\n${CONSTS}\n${LOAD}}\n`, true],
  ["a word list that holds map beside regex literals and templates that balance: map stays hashed", `const WORDS = [\n  ${words(2048, true)}\n];\n${BALANCED}${READS}`, false],
  ["a regex literal in a list of 220 strings, a name from parts after it, another regex closing it: map shown", `${READS}${T8}`, true],
  ["a map string that is not a list element, among 220 short list elements: map shown", `${READS}const L = [${Array.from({ length: 220 }, (_, i) => JSON.stringify("e" + i)).join(", ")}];\nconst e = "map";\nconst n = [__dirname, "index", "js"].join(".") + "." + e;\n`, true],
  ["an extension list of 60 strings holding map in a loader: map shown", `${READS}const EXT = [\n  ${words(60, true)}\n];\n`, true],
  ["a list of 199 strings holding map: map shown (the table starts at 200)", `${READS}const EXT = [\n  ${words(199, true)}\n];\n`, true],
  ["a list of 200 strings holding map: map stays hashed", `${READS}const EXT = [\n  ${words(200, true)}\n];\n`, false],
  ["a word list holding map and a name whose last template part is map: map shown", `const WORDS = [\n  ${words(2048, true)}\n];\n${READS}${TAIL_TPL}`, true],
  ["a word list that holds map beside a regex literal with an escaped bracket: map stays hashed (only when the walk skips the regex)", `const WORDS = [\n  ${words(2048, true)}\n];\n${REGEX_CLASS}${READS}`, false],
  // Known limit: decoys before, after or around the "map" in the same array, template strings included, make it look like a table.
  ["known limit: 220 template-string decoys after map hide it", `${READS}const n = ["map", ${Array.from({ length: 220 }, (_, i) => "`w" + i + "`").join(", ")}].slice(0, 1);\n`, false],
  // Known limit: 220 decoy strings around the "map" make it look like a table, so the map stays hashed.
  ["known limit: 220 decoys around map hide it", `${READS}const n = [\n  ${words(220, true)}\n].slice(-3).join(".");\n`, false],
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
