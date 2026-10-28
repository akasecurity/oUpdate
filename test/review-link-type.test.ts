import { describe, expect, test } from "bun:test";
import { chunkDiff, changedFiles, reviewUpdate } from "../src/review.ts";
import { markLink, prepass, type FileMap } from "../src/prepass.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const map = (o: Record<string, Uint8Array>): FileMap => new Map(Object.entries(o));

describe("a type change with the same bytes counts as changed", () => {
  for (const [name, mk] of [
    ["file to link", () => ({ old: map({ "lib/a.py": enc("b.py") }), new: map({ "lib/a.py": markLink(enc("b.py")) }) })],
    ["link to file", () => ({ old: map({ "lib/a.py": markLink(enc("b.py")) }), new: map({ "lib/a.py": enc("b.py") }) })],
  ] as const) {
    test(`${name}: pre-pass, scanner input and diff all see it`, () => {
      const { old, new: now } = mk();
      expect(prepass("pypi", old, now).changed).toEqual(["lib/a.py"]);
      expect([...changedFiles(old, now).new.keys()]).toEqual(["lib/a.py"]);
      expect(chunkDiff(old, now, 10_000).join("")).toContain("=== lib/a.py (changed) ===");
    });
  }

  test("same type and same bytes is still unchanged", () => {
    const old = map({ "lib/a.py": markLink(enc("b.py")), "x.py": enc("1") });
    const now = map({ "lib/a.py": markLink(enc("b.py")), "x.py": enc("1") });
    expect(prepass("pypi", old, now).changed).toEqual([]);
    expect(changedFiles(old, now).new.size).toBe(0);
    expect(chunkDiff(old, now, 10_000)).toEqual([]);
  });

  test("a file turned into a link is not reviewed as unchanged by the reviewer", async () => {
    const prompts: string[] = [];
    const r = await reviewUpdate({
      eco: "pypi", name: "p", from: "1", to: "2",
      registry: { latest: async () => undefined, publishedAt: async () => new Date("2020-01-01"), artifactUrls: async () => [] },
      advisories: { query: async () => [] },
      reviewer: { name: "fake", review: async (p) => (prompts.push(p), "APPROVE\nno attack indicators found") },
      cooldownDays: 1, now: new Date("2026-10-21T00:00:00Z"),
      loadArtifacts: async () => ({ old: map({ "a.py": enc("x = 1\n") }), new: map({ "a.py": markLink(enc("x = 1\n")) }) }),
    });
    expect(prompts.length).toBeGreaterThan(0);
    expect(r.prepass?.changed).toEqual(["a.py"]);
  });
});
