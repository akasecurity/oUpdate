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
  ["a template whose text after the interpolation is the tail: map shown", LOAD("`${__filename.slice(0, -3)}.js.map`"), PKG(), true],
  ["a template with two interpolations reads the text after the last one: map shown", LOAD("`${__dirname}/${__filename.slice(0, -3)}.js.map`"), PKG(), true],
  ["a template whose interpolation holds braces reads the text after the last }: map shown", LOAD("`${({a: 1}).a && __filename.slice(0, -3)}.js.map`"), PKG(), true],
  ["a template whose tail is one character before .map: the floor applies to the tail, map stays hashed", LOAD("`${__filename.slice(0, -1)}s.map`"), PKG(), false],
  ["a template with a trailing interpolation after the tail: map shown", LOAD("`${__filename.slice(0, -3)}.js.map${String('')}`"), PKG(), true],
  ["a template whose first literal is the tail, joined after the file path with a trailing interpolation: map shown", LOAD("__filename.slice(0, -3) + `.js.map${String('')}`"), PKG(), true],
  ["a template whose first literal ends in the tail: map shown", LOAD("`x.js.map${__filename}`"), PKG(), true],
  ["a plain string with a closing brace before the tail is not a tail of the name: map stays hashed", LOAD("__filename + 'a}.js.map'"), PKG(), false],
  ["a template with no tail after the interpolation: map stays hashed", LOAD("`${__filename}.js`"), PKG(), false],
  ["slice then the tail .js.map: map shown", LOAD("__filename.slice(0, -3) + '.js.map'"), PKG(), true],
  ["a tail that is no tail of the map's name (xjs.map): map stays hashed", LOAD("__filename + 'xjs.map'.slice(1)"), PKG(), false],
  ["a lone code string .js.map with no loader still shows the map (it fails toward showing)", "exports.ext = '.js.map';\nexports.v = 2;\n", PKG(), true],
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

const kept: [string, Record<string, string>][] = [
  ["a README quoting a template tail and no loader: map stays hashed", { "README.md": "Maps: \`\${name}.js.map\`\n" }],
  ["a declaration file quoting a template tail: map stays hashed", { "lib/index.d.ts": "export declare const m: \`\${string}.js.map\`;\n" }],
  ["a README quoting .js.map and no loader: map stays hashed", { "README.md": "Maps: `fs.readFileSync('.js.map')` see '.js.map'\n" }],
  ["a declaration file quoting .js.map: map stays hashed", { "lib/index.d.ts": "export declare const m: '.js.map';\n" }],
  ["a one-character tail s.map in code and no loader: map stays hashed", { "lib/util.js": "exports.ext = 's.map';\n" }],
];
for (const [label, extra] of kept) test(label, async () => {
  const reviewed: string[] = [];
  await reviewUpdate({
    eco: "npm", name: "lib", from: "1.0.0", to: "1.0.1",
    registry: { latest: async () => undefined, publishedAt: async () => new Date("2020-01-01"), artifactUrls: async () => [] },
    advisories: { query: async () => [] },
    reviewer: { name: "fake", review: async (p) => (reviewed.push(p), "APPROVE\nno attack indicators found") },
    cooldownDays: 1, now: new Date("2026-10-21T00:00:00Z"), chunkChars: 60000,
    loadArtifacts: async () => ({
      old: files({ "package.json": '{"name":"lib","version":"a","main":"lib/index.js"}', "lib/index.js": "exports.v = 1;\n", "lib/index.js.map": map("A") }),
      new: files({ "package.json": PKG(), "lib/index.js": "exports.v = 2;\n", "lib/index.js.map": map(MARK), ...extra }),
    }),
  });
  expect(reviewed.join("").includes(MARK)).toBe(false);
}, 60_000);
