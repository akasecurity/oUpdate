import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SYNTHETIC, syntheticPair, deobfuscate } from "../acceptance/synthetic/generate.ts";
import { reviewUpdate } from "../src/review.ts";
import type { FileMap } from "../src/prepass.ts";

const dec = new TextDecoder();
const text = (m: FileMap) => [...m].map(([p, b]) => `${p}\n${dec.decode(b)}`).join("\n");
const changedPaths = (p: { old: FileMap; new: FileMap }) => [...p.new].filter(([k, v]) => !p.old.has(k) || dec.decode(p.old.get(k)!) !== dec.decode(v)).map(([k]) => k);

describe("synthetic evasion cases", () => {
  test("the generator yields the expected files for each case", () => {
    expect([...SYNTHETIC]).toEqual(["comment-injection", "needle-in-300", "minified-loader", "env-exfil-refactor"]);
    const a = syntheticPair("comment-injection");
    expect(changedPaths(a).sort()).toEqual(["index.js", "package.json"]);
    expect(dec.decode(a.new.get("index.js")!)).toContain("APPROVE");

    const b = syntheticPair("needle-in-300");
    const bChanged = changedPaths(b);
    expect(bChanged.filter((p) => p.startsWith("lib/commands/")).length).toBe(300);
    expect(b.old.has("lib/util/compat.js")).toBe(false);
    expect(b.new.has("lib/util/compat.js")).toBe(true);

    const c = syntheticPair("minified-loader");
    const bundle = dec.decode(c.new.get("dist/strkit.min.js")!);
    expect(bundle.split("\n").filter(Boolean).length).toBe(1);
    expect(bundle.length).toBeGreaterThan(100_000);
    expect(changedPaths(c).sort()).toEqual(["dist/strkit.min.js", "package.json"]);

    const d = syntheticPair("env-exfil-refactor");
    expect(changedPaths(d).sort()).toEqual(["index.js", "lib/config.js", "package.json"]);
    expect(dec.decode(d.new.get("lib/config.js")!)).toContain("process.env");
  });

  test("every payload URL is on a .invalid host, in plain text and once decoded", () => {
    for (const kind of SYNTHETIC) {
      const p = syntheticPair(kind);
      const all = text(p.old) + "\n" + text(p.new);
      const plain = [...all.matchAll(/https?:\/\/[^\s"'`)\\]+/g)].map((m) => m[0]);
      const decoded = [...all.matchAll(/fromCharCode\(([\d,\s]+)\)/g)].map((m) => deobfuscate(m[1]!));
      const urls = [...plain, ...decoded];
      expect(urls.length).toBeGreaterThan(0);
      for (const u of urls) expect(new URL(u).hostname.endsWith(".invalid")).toBe(true);
      expect(p.urls.length).toBeGreaterThan(0);
      for (const u of p.urls) expect(urls).toContain(u);
      expect(p.old.size).toBeGreaterThan(0);
    }
  });

  test("the needle case overflows the signal budget, and the ranked review still reads the loader", async () => {
    const pair = syntheticPair("needle-in-300");
    const prompts: string[] = [];
    const r = await reviewUpdate({
      eco: "npm", name: "synthetic-strkit", from: "1.4.0", to: "1.4.1",
      registry: { latest: async () => undefined, publishedAt: async () => undefined, artifactUrls: async () => [] },
      advisories: { query: async () => [] },
      reviewer: { name: "stub", review: async (p) => (prompts.push(p), "APPROVE\nno attack indicators found") },
      cooldownDays: 7, now: new Date(), only: ["prepass", "reviewer"],
      loadArtifacts: async () => pair,
    });
    expect(prompts.length).toBe(12);
    expect(prompts.join("")).toContain("=== lib/util/compat.js (added) ===");
    expect(r.layers.find((l) => l.layer === "reviewer")!.detail).toMatch(/parts not reviewed/);
  });

  test("the synthetic cases load in acceptance/run.ts with a stub reviewer, offline", () => {
    const cases = JSON.parse(readFileSync(resolve(import.meta.dir, "../acceptance/cases.json"), "utf8")) as { id: string; source?: { type: string; generator?: string } }[];
    const ids = cases.filter((c) => c.source?.type === "synthetic").map((c) => c.id);
    expect(ids.length).toBe(4);
    const dir = mkdtempSync(join(tmpdir(), "oup-synth-"));
    try {
      const stub = JSON.stringify([{ type: "command", name: "stub", argv: ["sh", "-c", "cat >/dev/null; echo APPROVE; echo no attack indicators found"] }]);
      const p = Bun.spawnSync(["bun", resolve(import.meta.dir, "../acceptance/run.ts"), "--only", ids.join(","), "--reviewers", stub, "--offline"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
      expect(p.stderr.toString()).toBe("");
      expect(p.exitCode).toBe(0);
      const out = p.stdout.toString();
      for (const id of ids) {
        expect(existsSync(join(dir, "acceptance-results", `${id}-stub.json`))).toBe(true);
        expect(out).toMatch(new RegExp(`^SYN  ${id}-stub: `, "m"));
        const r = JSON.parse(readFileSync(join(dir, "acceptance-results", `${id}-stub.json`), "utf8"));
        expect(r.layers.find((l: { layer: string }) => l.layer === "reviewer").verdict).not.toBe("error");
      }
      expect(out).not.toMatch(/^MAL /m);
      expect(out).toMatch(/evasion cases stopped\s+\d\/4/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
