import { test, expect } from "bun:test";
import { reviewUpdate } from "../src/review.ts";
import type { FileMap } from "../src/prepass.ts";

// A loader that puts a literal tail of the map's name after the file's own path (".js.map" for index.js.map) names its map: the map is shown.
// A tail is taken only from strings of code files; a package.json glob, a declaration file or a name that is no tail of the map's name does not count.
const enc = (s: string) => new TextEncoder().encode(s);
const files = (o: Record<string, string>): FileMap => new Map(Object.entries(o).map(([k, v]) => [k, enc(v)]));
const MARK = "QZMARKQZ";
const map = (seed: string) => JSON.stringify({ version: 3, file: "index.js", sources: ["a.ts"], names: [], sourcesContent: ["ok"], mappings: ("AAAA" + seed + "CAAO,aAAP,OAAO,uBAAP;").repeat(250_000) });
const LOAD = (name: string) => `const fs = require('fs');\nconst cfg = JSON.parse(fs.readFileSync(${name}, 'utf8'));\nexports.v = cfg.v;\n`;
const PKG = (extra = "") => `{"name":"lib","version":"b","main":"lib/index.js"${extra}}`;
const cases: [string, string, string, boolean][] = [
  ["replace idiom: the literal .js.map is the tail of index.js.map: map shown", LOAD("__filename.replace(/\\.js$/, '.js.map')"), PKG(), true],
  ["slice then the tail .js.map: map shown", LOAD("__filename.slice(0, -3) + '.js.map'"), PKG(), true],
  ["a tail that is no tail of the map's name (x.map): map stays hashed", LOAD("__filename + 'x.map'.slice(1)"), PKG(), false],
  ["a package.json files glob that ends in .js.map and no loader: map stays hashed", "exports.v = 2;\n", PKG(',"files":["lib/**/*.js.map"]'), false],
  ["a package.json script that names .d.ts.map and no loader: map stays hashed", "exports.v = 2;\n", PKG(',"scripts":{"clean":"del lib/**/*.d.ts.map"}'), false],
  ["a .js.map string that is only in a comment: map stays hashed", "// emit the .js.map file next to it\nexports.v = 2;\n", PKG(), false],
];
for (const [label, code, pkg, shown] of cases) test(label, async () => {
  const reviewed: string[] = [];
  await reviewUpdate({
    eco: "npm", name: "lib", from: "1.0.0", to: "1.0.1",
    registry: { latest: async () => undefined, publishedAt: async () => new Date("2020-01-01"), artifactUrls: async () => [] },
    advisories: { query: async () => [] },
    reviewer: { name: "fake", review: async (p) => (reviewed.push(p), "APPROVE\nno attack indicators found") },
    cooldownDays: 1, now: new Date("2026-10-21T00:00:00Z"), chunkChars: 60000,
    loadArtifacts: async () => ({
      old: files({ "package.json": '{"name":"lib","version":"a","main":"lib/index.js"}', "lib/index.js": "exports.v = 1;\n", "lib/index.js.map": map("A") }),
      new: files({ "package.json": pkg, "lib/index.js": code, "lib/index.js.map": map(MARK) }),
    }),
  });
  expect(reviewed.join("").includes(MARK)).toBe(shown);
}, 60_000);
