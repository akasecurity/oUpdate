import { describe, expect, test } from "bun:test";
import { classifyOutcome, reviewUpdate, chunkDiff, partLimit, CEILING_PARTS } from "../src/review.ts";
import { markTarNotes } from "../src/prepass.ts";
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

// The parts a review cuts when it reads the ranked files (setup.py here) first and the rest in sorted order.
const rankedTotal = (art: { old: FileMap; new: FileMap }) => chunkDiff(art.old, art.new, 200, ["setup.py", ...[...new Set([...art.old.keys(), ...art.new.keys()])].filter((k) => k !== "setup.py").sort()]).length;

function run(art: { old: FileMap; new: FileMap }, over: { maxParts?: number; maxStages?: number; flagCall?: number; uncapped?: boolean } = {}) {
  const prompts: string[] = [];
  const p = reviewUpdate({
    eco: "npm", name: "lib", from: "1.0.0", to: "1.0.1",
    registry: { latest: async () => undefined, publishedAt: async () => new Date("2020-01-01"), artifactUrls: async () => [] },
    advisories: { query: async () => [] },
    reviewer: { name: "fake", review: async (t) => (prompts.push(t), t.includes("EVIL") || prompts.length === over.flagCall ? "FLAG\nexfil" : "APPROVE\nno attack indicators found") },
    cooldownDays: 1, now: new Date("2026-10-21T00:00:00Z"),
    loadArtifacts: async () => art,
    chunkChars: 200,
    maxParts: over.uncapped ? undefined : (over.maxParts ?? 3),
    maxStages: over.maxStages,
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
    const art = release(12, { "lib/m5.py": "x = 2\nEVIL()\n" });
    const { r, prompts, rev } = await run(art, { maxParts: 3, maxStages: 30 });
    expect(prompts.length).toBeGreaterThan(3);
    expect(prompts.length).toBeLessThan(rankedTotal(art)); // the flag is mid-run: the parts after it are not asked
    expect(rev.detail).toContain(`FLAG on part(s) ${prompts.length} of ${rankedTotal(art)}`);
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
    expect(partLimit()).toBe(CEILING_PARTS); // no cap asked for: the diff is read up to the ceiling
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

  test("after an early stop the file count is recomputed from what was read, in the full-diff and priority tiers", async () => {
    const full = await run(release(7, { "lib/m0.py": "x = 2\nEVIL()\n" }));
    const n = Number(/(\d+) file\(s\) not reviewed$/.exec(full.rev.detail.replace(/: .*$/s, ""))?.[1]);
    expect(full.rev.detail).toMatch(/part\(s\) read, the first FLAG ended the review; \d+ file\(s\) not reviewed/);
    expect(n).toBeGreaterThanOrEqual(6); // 8 files, at most the first part or two read
    expect(n).toBeLessThan(8);
    // the priority tier: new files fill more parts than the stages allow in the full diff
    const newf = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`lib/n${i}.py`, i === 0 ? "EVIL()\n" : `y = ${i}\n`.repeat(20)]));
    const pr = await run({ old: files(plain(10, "1")), new: files({ ...plain(10, "2"), ...newf }) }, { maxParts: 3, maxStages: 2 });
    expect(pr.rev.detail).toMatch(/^fake FLAG on part\(s\) 1 of 6; 1 of 6 part\(s\) read, the first FLAG ended the review; priority files only, \d+ file\(s\) not reviewed/);
    expect(pr.rev.detail).not.toMatch(/lower-priority/);
  });

  test("a file that goes on into an unread part is not counted as read", async () => {
    const big = Array.from({ length: 60 }, (_, i) => `v${i} = ${i}`).join("\n") + "\n";
    const art = { old: files({}), new: files({ "lib/a.py": big, "lib/z.py": "y = 1\n" }) };
    const total = chunkDiff(art.old, art.new, 200).length;
    expect(total).toBeGreaterThan(4);
    const { prompts, rev } = await run(art, { flagCall: 2 });
    expect(prompts).toHaveLength(2);
    expect(rev.detail).toContain(`2 of ${total} part(s) read, the first FLAG ended the review; 2 file(s) not reviewed`);
  });

});

describe("a large release with no cap asked for is read in every part", () => {
  const big = (extra: Record<string, string> = {}) => release(110, extra);
  const readTotal = (rev: { detail: string }) => Number(/on (\d+) part\(s\)/.exec(rev.detail)![1]);
  test("a clean diff of more than 72 parts is read in full and lands, never held for its size", async () => {
    const art = big();
    expect(chunkDiff(art.old, art.new, 200).length).toBeGreaterThan(72);
    const { r, prompts, rev } = await run(art, { uncapped: true });
    expect(rev.verdict).toBe("pass");
    expect(readTotal(rev)).toBe(prompts.length); // every part the review cut was asked
    expect(prompts.length).toBeGreaterThan(72);
    for (let i = 0; i < 110; i++) expect(prompts.join("")).toContain(`lib/m${i}.py`);
    expect(rev.detail).not.toMatch(/too large|not reviewed/);
    expect(r.decision).toBe("land");
  });
  test("an attack in the very last part of a large diff holds", async () => {
    const { r, prompts, rev } = await run(big({ "lib/m99.py": "x = 2\nEVIL()\n" }), { uncapped: true });
    expect(rev.verdict).toBe("stop");
    expect(prompts.length).toBeGreaterThan(72);
    expect(rev.detail).toContain(`FLAG on part(s) ${prompts.length} of ${prompts.length}`); // the flagged part is the last one cut
    expect(rev.detail).not.toMatch(/too large/);
    expect(r.decision).toBe("hold");
  });
  test("an operator who passes a cap still gets the narrowing and the hold for a human", async () => {
    const { r, rev } = await run(big(), { maxParts: 2, maxStages: 2 });
    expect(rev.detail).toMatch(/too large for model review/);
    expect(r.decision).toBe("hold");
  });
  test("above the ceiling, with no cap asked for, a diff is narrowed and held as too large", async () => {
    const art = release(CEILING_PARTS / 2 + 50);
    expect(chunkDiff(art.old, art.new, 200).length).toBeGreaterThan(CEILING_PARTS);
    const { r, rev } = await run(art, { uncapped: true });
    expect(rev.detail).toMatch(/too large for model review: \d+ parts > 1200/);
    expect(r.decision).toBe("hold");
  });
  test("the reorder threshold is the caller's maxParts: over it the ranked file is read first, within it the sorted order stays", async () => {
    const over = await run(big(), { maxParts: 40, maxStages: 20 });
    expect(over.rev.verdict).toBe("pass");
    expect(readTotal(over.rev)).toBe(over.prompts.length);
    expect(over.prompts[0]).toContain("setup.py"); // 220 parts > 40: ranked first
    const within = await run(big(), { maxParts: 300, maxStages: 1 });
    expect(within.rev.verdict).toBe("pass");
    expect(within.prompts[0]).toContain("lib/m0.py"); // 220 parts <= 300: not reordered
    expect(within.prompts[0]).not.toContain("setup.py");
    expect(within.prompts[within.prompts.length - 1]).toContain("setup.py");
  });
  test("at the limit's edge, a reordered cut that packs to one part more is not used: the diff is not narrowed", async () => {
    const side = (v: string) => files({ ...Object.fromEntries(Array.from({ length: 3 }, (_, i) => [`lib/m${i}.py`, `x = ${v}\n`.repeat(3 + (i % 3))])), "setup.py": `v = ${v}\n`.repeat(8) });
    const art = { old: side("1"), new: side("2") };
    const sorted = chunkDiff(art.old, art.new, 150).length;
    const ranked = chunkDiff(art.old, art.new, 150, ["setup.py", "lib/m0.py", "lib/m1.py", "lib/m2.py"]).length;
    expect(sorted).toBe(4);
    expect(ranked).toBe(5); // the boundary: 4 parts fit a limit of 4, the reordered 5 would not
    const prompts: string[] = [];
    const r = await reviewUpdate({
      eco: "npm", name: "lib", from: "1.0.0", to: "1.0.1",
      registry: { latest: async () => undefined, publishedAt: async () => new Date("2020-01-01"), artifactUrls: async () => [] },
      advisories: { query: async () => [] },
      reviewer: { name: "fake", review: async (t) => (prompts.push(t), "APPROVE\nno attack indicators found") },
      cooldownDays: 1, now: new Date("2026-10-21T00:00:00Z"), loadArtifacts: async () => art, chunkChars: 150, maxParts: 2, maxStages: 2,
    });
    const rev = r.layers.find((l) => l.layer === "reviewer")!;
    expect(rev.detail).not.toMatch(/too large/);
    expect(rev.verdict).toBe("pass");
    expect(prompts).toHaveLength(4);
  });
});

describe("a signal that names no file of the release", () => {
  test("in the reorder, a skipped tar entry takes no room in a part and prints no empty header", async () => {
    const art = release(12);
    markTarNotes(art.new, [{ note: "skipped evil/skipped-entry", key: "skipped evil/skipped-entry", kind: "skipped" }]);
    const { prompts } = await run(art, { maxParts: 3, maxStages: 30 });
    expect(prompts.length).toBeGreaterThan(0);
    expect(prompts.join("\n")).not.toContain("=== evil/skipped-entry");
    expect(prompts[0]).toContain("setup.py"); // the real ranked file comes first
  });
  test("the ranked tier itself reads no phantom: signal files alone over the limit, a skipped tar entry among the ranked paths", async () => {
    const art = release(12, { "setup.py": "v = 3\n".repeat(120) }); // setup.py alone is several parts, so the narrowing reaches the ranked tier
    markTarNotes(art.new, [{ note: "skipped evil/skipped-entry", key: "skipped evil/skipped-entry", kind: "skipped" }]);
    const { prompts, rev } = await run(art, { maxParts: 1, maxStages: 1 });
    expect(rev.detail).toMatch(/too large for model review: \d+ parts > 1 \(signal files alone\)/); // the tier is the ranked one
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("setup.py"); // the real file takes the one slot
    expect(prompts.join("\n")).not.toContain("=== evil/skipped-entry");
  });
});

describe("read time budget", () => {
  const base = (art: { old: FileMap; new: FileMap }, extra: Record<string, unknown>, delayMs: number) => {
    const prompts: string[] = [];
    const p = reviewUpdate({
      eco: "npm", name: "lib", from: "1.0.0", to: "1.0.1",
      registry: { latest: async () => undefined, publishedAt: async () => new Date("2020-01-01"), artifactUrls: async () => [] },
      advisories: { query: async () => [] },
      reviewer: { name: "fake", review: async (t) => (prompts.push(t), await Bun.sleep(delayMs), "APPROVE\nno attack indicators found") },
      cooldownDays: 1, now: new Date("2026-10-21T00:00:00Z"),
      loadArtifacts: async () => art,
      chunkChars: 200,
      ...extra,
    });
    return p.then((r) => ({ r, prompts, rev: r.layers.find((l) => l.layer === "reviewer")! }));
  };

  test("a spent budget holds the rest as unread and never lands", async () => {
    const art = release(12);
    const total = chunkDiff(art.old, art.new, 200).length;
    const { r, prompts, rev } = await base(art, { maxReadMs: 1 }, 10);
    expect(prompts.length).toBeGreaterThanOrEqual(1);
    expect(prompts.length).toBeLessThan(total);
    expect(rev.verdict).toBe("stop");
    expect(rev.detail).toContain(`${prompts.length} of ${total} part(s) read, the read time budget of 1 ms ran out`);
    expect(rev.detail).toContain("needs a human");
    expect(r.decision).toBe("hold");
    // a spent budget is a hold for a person, never scored as a detection
    expect(classifyOutcome(r)).toBe("held-human");
  });

  test("a spent budget on a narrowed review keeps the tier reasons and the parts count", async () => {
    const pair = syntheticPair("needle-in-300");
    const prompts: string[] = [];
    const r = await reviewUpdate({
      eco: "npm", name: "synthetic-strkit", from: "1.4.0", to: "1.4.1",
      registry: { latest: async () => undefined, publishedAt: async () => undefined, artifactUrls: async () => [] },
      advisories: { query: async () => [] },
      reviewer: { name: "stub", review: async (p) => (prompts.push(p), await Bun.sleep(10), "APPROVE\nfine") },
      cooldownDays: 7, now: new Date(), only: ["prepass", "reviewer"], loadArtifacts: async () => pair, maxParts: 3, maxStages: 1, maxReadMs: 1,
    });
    const d = r.layers.find((l) => l.layer === "reviewer")!.detail;
    expect(prompts.length).toBeLessThan(3);
    expect(d).toMatch(/^\d+ of \d+ part\(s\) read, the read time budget of 1 ms ran out; \d+ file\(s\) not reviewed; too large for model review: \d+ parts > 3 \(full diff\); too large for model review: \d+ parts > 3 \(signal files alone\); \d+ ranked parts not reviewed; needs a human$/);
    // the count is the ranked parts less the prompts actually sent, the same ranked total the tier reason names
    const total = Number(/(\d+) parts > 3 \(signal files alone\)/.exec(d)![1]);
    expect(total).toBeGreaterThan(10);
    expect(Number(/; (\d+) ranked parts not reviewed/.exec(d)![1])).toBe(total - prompts.length);
    expect(r.decision).toBe("hold");
    expect(classifyOutcome(r)).toBe("held-human");
  });

  // The tiers below the ranked one: the review was narrowed to the priority files, or to the signal files, and the budget then ran out.
  describe("a spent budget keeps the tier that narrowed the review", () => {
    const plainFiles = (v: string) => Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`lib/m${i}.py`, `x = ${v}\n`.repeat(20)]));
    const newFiles = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`lib/n${i}.py`, `y = ${i}\n`.repeat(30)]));
    const net = (pad: number) => "a = 1\nimport subprocess; subprocess.run(['sh'])\n" + "b = 2\n".repeat(pad);
    const spent = async (added: Record<string, string>, maxParts: number) => {
      const art = { old: files({ ...plainFiles("1"), "setup.py": "v = 1\n", "lib/net.py": "a = 1\n" }), new: files({ ...plainFiles("2"), "setup.py": "v = 2\n", "lib/net.py": net(0), ...added }) };
      const prompts: string[] = [];
      const r = await reviewUpdate({
        eco: "npm", name: "lib", from: "1.0.0", to: "1.0.1",
        registry: { latest: async () => undefined, publishedAt: async () => new Date("2020-01-01"), artifactUrls: async () => [] },
        advisories: { query: async () => [] },
        reviewer: { name: "fake", review: async (t) => (prompts.push(t), await Bun.sleep(10), "APPROVE\nno attack indicators found") },
        cooldownDays: 1, now: new Date("2026-10-21T00:00:00Z"),
        loadArtifacts: async () => art, chunkChars: 200, maxParts, maxStages: 1, maxReadMs: 1,
      });
      return { r, prompts, d: r.layers.find((l) => l.layer === "reviewer")!.detail };
    };

    test("priority files: the full-diff reason stays, no ranked count", async () => {
      const { r, prompts, d } = await spent(newFiles(3), 8);
      expect(prompts).toHaveLength(1);
      expect(d).toMatch(/^1 of \d+ part\(s\) read, the read time budget of 1 ms ran out; \d+ file\(s\) not reviewed; too large for model review: \d+ parts > 8 \(full diff\); needs a human$/);
      expect(r.decision).toBe("hold");
      expect(classifyOutcome(r)).toBe("held-human");
    });

    test("signal files: both reasons stay, no ranked count", async () => {
      const { r, prompts, d } = await spent({ ...newFiles(8), "lib/net.py": net(120) }, 6);
      expect(prompts).toHaveLength(1);
      expect(d).toMatch(/^1 of \d+ part\(s\) read, the read time budget of 1 ms ran out; \d+ file\(s\) not reviewed; too large for model review: \d+ parts > 6 \(full diff\); too large for model review: \d+ parts > 6 \(priority files alone\); needs a human$/);
      expect(r.decision).toBe("hold");
      expect(classifyOutcome(r)).toBe("held-human");
    });
  });

  test("a budget the read fits in changes nothing", async () => {
    const art = release(12);
    const total = chunkDiff(art.old, art.new, 200).length;
    const { r, prompts, rev } = await base(art, { maxReadMs: 600_000 }, 0);
    expect(prompts).toHaveLength(total);
    expect(rev.verdict).toBe("pass");
    expect(r.decision).toBe("land");
  });

  test("no budget, or a bad one, reads every part as before", async () => {
    const art = release(12);
    const total = chunkDiff(art.old, art.new, 200).length;
    for (const maxReadMs of [undefined, 0, -5, Number.NaN]) {
      const { prompts, rev } = await base(art, { maxReadMs }, 2);
      expect(prompts).toHaveLength(total);
      expect(rev.verdict).toBe("pass");
    }
  });

  test("a FLAG before the budget runs out is still the reason", async () => {
    const art = release(12, { "lib/m0.py": "x = 2\nEVIL()\n" });
    const prompts: string[] = [];
    const r = await reviewUpdate({
      eco: "npm", name: "lib", from: "1.0.0", to: "1.0.1",
      registry: { latest: async () => undefined, publishedAt: async () => new Date("2020-01-01"), artifactUrls: async () => [] },
      advisories: { query: async () => [] },
      reviewer: { name: "fake", review: async (t) => (prompts.push(t), t.includes("EVIL") ? "FLAG\nexfil" : "APPROVE\nno attack indicators found") },
      cooldownDays: 1, now: new Date("2026-10-21T00:00:00Z"),
      loadArtifacts: async () => art, chunkChars: 200, maxReadMs: 600_000,
    });
    expect(r.layers.find((l) => l.layer === "reviewer")!.detail).toMatch(/fake FLAG/);
  });
});
