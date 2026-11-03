import { describe, expect, test } from "bun:test";
import { reviewUpdate, chunkDiff, partLimit } from "../src/review.ts";
import { syntheticPair } from "../acceptance/synthetic/generate.ts";
import type { FileMap } from "../src/prepass.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const files = (o: Record<string, string>): FileMap => new Map(Object.entries(o).map(([k, v]) => [k, enc(v)]));

// A release whose diff needs many reviewer parts. A reviewer FLAGs the part that carries EVIL.
const plain = (n: number, v: string) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`lib/m${i}.py`, `x = ${v}\n`.repeat(20)]));
const release = (n: number, extra: Record<string, string> = {}) => ({
  old: files({ ...plain(n, "1"), "setup.py": "v = 1\n" }),
  new: files({ ...plain(n, "2"), "setup.py": "v = 2\n", ...extra }),
});

function run(art: { old: FileMap; new: FileMap }, over: { maxParts?: number; maxStages?: number } = {}) {
  const prompts: string[] = [];
  const p = reviewUpdate({
    eco: "npm", name: "lib", from: "1.0.0", to: "1.0.1",
    registry: { latest: async () => undefined, publishedAt: async () => new Date("2020-01-01"), artifactUrls: async () => [] },
    advisories: { query: async () => [] },
    reviewer: { name: "fake", review: async (t) => (prompts.push(t), t.includes("EVIL") ? "FLAG\nexfil" : "APPROVE\nno attack indicators found") },
    cooldownDays: 1, now: new Date("2026-10-21T00:00:00Z"),
    loadArtifacts: async () => art,
    chunkChars: 200,
    maxParts: 3,
    ...over,
  });
  return p.then((r) => ({ r, prompts, rev: r.layers.find((l) => l.layer === "reviewer")! }));
}

describe("staged review of a large diff", () => {
  test("a clean diff over one stage is read in full and lands", async () => {
    const art = release(7);
    const total = chunkDiff(art.old, art.new, 200).length;
    expect(total).toBeGreaterThan(3);
    const { r, prompts, rev } = await run(art);
    expect(prompts).toHaveLength(total);
    expect(prompts.join("")).toContain("lib/m0.py");
    expect(rev).toMatchObject({ verdict: "pass" });
    expect(rev.detail).not.toMatch(/too large/);
    expect(r.decision).toBe("land");
  });

  // One bad part in each tier of the old narrowing: a low-priority file, a priority file and a new file.
  for (const [name, extra] of [
    ["a low-priority file", { "lib/m7.py": "x = 2\nEVIL()\n" }],
    ["a priority file", { "setup.py": "v = 2\nEVIL()\n" }],
    ["a new file", { "lib/new.py": "EVIL()\n" }],
  ] as [string, Record<string, string>][])
    test(`a bad part in ${name} stops as a model detection`, async () => {
      const { r, rev } = await run(release(7, extra));
      expect(rev.verdict).toBe("stop");
      expect(rev.detail).toMatch(/fake FLAG on part\(s\)/);
      expect(rev.detail).not.toMatch(/too large/);
      expect(r.decision).toBe("hold");
    });

  test("the first FLAG ends the review: later parts are not asked and the detail counts what was read", async () => {
    const art = release(12, { "lib/m0.py": "x = 2\nEVIL()\n" });
    const total = chunkDiff(art.old, art.new, 200).length;
    const { prompts, rev } = await run(art, { maxParts: 3, maxStages: 30 });
    expect(rev.detail).toMatch(/fake FLAG/);
    expect(prompts.length).toBeLessThan(total);
    expect(prompts[prompts.length - 1]).toContain("EVIL");
    expect(prompts.slice(0, -1).join("")).not.toContain("EVIL");
    expect(rev.detail).toContain(`part(s) ${prompts.length} of ${total}; ${prompts.length} of ${total} part(s) read, the first FLAG ended the review`);
  });

  test("all-APPROVE stages carry on: a FLAG in a later stage still stops, and nothing after it is asked", async () => {
    const art = release(12, { "lib/m9.py": "x = 2\nEVIL()\n" });
    const total = chunkDiff(art.old, art.new, 200).length;
    const { r, prompts, rev } = await run(art, { maxParts: 3, maxStages: 30 });
    expect(prompts.length).toBeGreaterThan(3);
    expect(prompts.length).toBeLessThan(total);
    expect(rev.detail).toContain(`FLAG on part(s) ${prompts.length} of ${total}`);
    expect(r.decision).toBe("hold");
  });

  test("a ranked review that stops on its first FLAG counts the parts it read and the rest as not reviewed", async () => {
    const pair = syntheticPair("needle-in-300");
    const prompts: string[] = [];
    const r = await reviewUpdate({
      eco: "npm", name: "synthetic-strkit", from: "1.4.0", to: "1.4.1",
      registry: { latest: async () => undefined, publishedAt: async () => undefined, artifactUrls: async () => [] },
      advisories: { query: async () => [] },
      reviewer: { name: "stub", review: async (p) => (prompts.push(p), "FLAG\nloader") },
      cooldownDays: 7, now: new Date(), only: ["prepass", "reviewer"], loadArtifacts: async () => pair, maxStages: 1,
    });
    const d = r.layers.find((l) => l.layer === "reviewer")!.detail;
    expect(prompts).toHaveLength(1);
    expect(d).toMatch(/^stub FLAG on ranked part\(s\) 1 of 1 reviewed; \d+ parts not reviewed, \d+ file\(s\) not reviewed$/);
    expect(Number(/; (\d+) parts not reviewed/.exec(d)![1])).toBeGreaterThan(10);
  });

  test("a bad stage count never switches narrowing off", () => {
    expect(partLimit()).toBe(72);
    expect(partLimit(undefined, NaN)).toBe(72);
    expect(partLimit(NaN, undefined)).toBe(72);
    expect(partLimit(3, 0)).toBe(18);
    expect(partLimit(3, Infinity)).toBe(18);
    expect(partLimit(3, 2)).toBe(6);
  });

  test("budget edge: a diff of exactly maxParts * maxStages parts is read in full", async () => {
    const art = release(7);
    const total = chunkDiff(art.old, art.new, 200).length;
    const { prompts, rev } = await run(art, { maxParts: 1, maxStages: total });
    expect(prompts).toHaveLength(total);
    expect(rev.verdict).toBe("pass");
  });

  test("budget edge: one part over maxParts * maxStages is narrowed and held for a human", async () => {
    const art = release(7);
    const total = chunkDiff(art.old, art.new, 200).length;
    const { r, rev } = await run(art, { maxParts: 1, maxStages: total - 1 });
    expect(rev.verdict).toBe("stop");
    expect(rev.detail).toMatch(new RegExp(`^too large for model review: ${total} parts > ${total - 1} \\(full diff\\)`));
    expect(r.decision).toBe("hold");
  });

  test("maxStages 1 keeps the single-stage budget", async () => {
    const { prompts, rev } = await run(release(7), { maxStages: 1 });
    expect(rev.detail).toMatch(/^too large for model review: \d+ parts > 3 \(full diff\)/);
    expect(prompts.join("")).not.toContain("lib/m0.py");
  });

  test("a bad low-priority file past the ceiling is the old narrowing: held, never landed", async () => {
    const { r, rev } = await run(release(7, { "lib/m7.py": "x = 2\nEVIL()\n" }), { maxStages: 1 });
    expect(rev.verdict).toBe("stop");
    expect(r.decision).toBe("hold");
  });
});
