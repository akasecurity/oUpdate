import { test, expect } from "bun:test";
import { reviewUpdate } from "../src/review.ts";
import type { FileMap } from "../src/prepass.ts";
const enc = (s: string) => new TextEncoder().encode(s);
const files = (o: Record<string, string>): FileMap => new Map(Object.entries(o).map(([k, v]) => [k, enc(v)]));
const SPAWN = "require('child_process').exec(process.env.Q)";
const map = (seed: string, big: boolean, sources: string[], sc: (string | null)[]) => JSON.stringify({ version: 3, file: "index.js", sources, names: [], sourcesContent: sc, mappings: ("AAAA" + seed + "CAAO,aAAP,OAAO,uBAAP;").repeat(big ? 250_000 : 20) });
const LD = "const m = JSON.parse(require('fs').readFileSync(__filename + '.map', 'utf8'));\nrequire('vm').runInThisContext(m['sources'+'Content'][1]);\nexports.v = 2;\n";
const cases: [string, string, string[], (string | null)[], string[], (string | null)[]][] = [
  ["X1 extra sourcesContent entry beyond sources, loader", LD, ["../src/index.ts"], ["ok"], ["../src/index.ts"], ["ok", SPAWN]],
  ["X2 extra entry, loader replace js.map", LD.replace("__filename + '.map'", "__filename.replace(/js$/, 'js.map')"), ["../src/index.ts"], ["ok"], ["../src/index.ts"], ["ok", SPAWN]],
  ["X2b extra entry, no loader", "exports.v = 2;\n", ["../src/index.ts"], ["ok"], ["../src/index.ts"], ["ok", SPAWN]],
  ["X3 duplicate source name, payload in 2nd", LD, ["../src/index.ts"], ["ok"], ["../src/index.ts", "../src/index.ts"], ["ok", SPAWN]],
  ["X4 control: own source", LD, ["../src/index.ts"], ["ok"], ["../src/index.ts", "../src/b.ts"], ["ok", SPAWN]],
];
for (const big of [true, false]) for (const [label, code, os, osc, ns, nsc] of cases) test(label + " big=" + big, async () => {
  const reviewed: string[] = [];
  const r = await reviewUpdate({
    eco: "npm", name: "lib", from: "1.0.0", to: "1.0.1",
    registry: { latest: async () => undefined, publishedAt: async () => new Date("2020-01-01"), artifactUrls: async () => [] },
    advisories: { query: async () => [] },
    reviewer: { name: "fake", review: async (p) => (reviewed.push(p), "APPROVE\nno attack indicators found") },
    cooldownDays: 1, now: new Date("2026-10-21T00:00:00Z"), chunkChars: 60000,
    loadArtifacts: async () => ({
      old: files({ "package.json": '{"name":"lib","version":"a","main":"lib/index.js"}', "lib/index.js": "exports.v = 1;\n", "lib/index.js.map": map("a", big, os, osc) }),
      new: files({ "package.json": '{"name":"lib","version":"b","main":"lib/index.js"}', "lib/index.js": code, "lib/index.js.map": map("b", big, ns, nsc) }),
    }),
  });
  expect({ label, big, decision: r.decision, payloadShown: reviewed.join("").includes("process.env.Q") }).toMatchObject({ payloadShown: true });
}, 60000);
