import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CORPUS, CORPUS_SPECS, corpusPair, isCorpus } from "../acceptance/synthetic/corpus.ts";
import { lookalikeOf } from "../src/dependency-signals.ts";
import type { FileMap } from "../src/prepass.ts";

const dec = new TextDecoder();
const text = (m: FileMap) => [...m].map(([p, b]) => `${p}\n${dec.decode(b)}`).join("\n");
const changed = (p: { old: FileMap; new: FileMap }) => [...p.new].filter(([k, v]) => !p.old.has(k) || dec.decode(p.old.get(k)!) !== dec.decode(v)).map(([k]) => k);
const cases = JSON.parse(readFileSync(resolve(import.meta.dir, "../acceptance/cases.json"), "utf8")) as { id: string; set?: string; eco: string; name: string; good: string; bad: string; source?: { type: string; generator?: string } }[];
/** Hosts that appear as the clean side of a case (a registry the attack moves away from); anything else must be .invalid. */
const CLEAN_HOSTS = new Set(["registry.npmjs.org"]);

describe("the synthetic attack corpus", () => {
  test("isCorpus knows its own kinds only, never an inherited property name", () => {
    expect(isCorpus(CORPUS[0]!)).toBe(true);
    for (const g of ["toString", "constructor", "__proto__", "hasOwnProperty", "nope"]) expect(isCorpus(g), g).toBe(false);
  });

  test("the npm typosquat fixture names a dependency one edit from a popular package", () => {
    const p = corpusPair("npm-typosquat-maintainer-swap");
    const deps = Object.keys(JSON.parse(dec.decode(p.new.get("package.json")!)).dependencies);
    expect(deps).toEqual(["momnet"]);
    expect(lookalikeOf("npm", "momnet")).toBe("moment");
  });

  test("it has 20 to 30 cases, each listed in cases.json as an extended synthetic case with matching fields", () => {
    expect(CORPUS.length).toBeGreaterThanOrEqual(20);
    expect(CORPUS.length).toBeLessThanOrEqual(30);
    const listed = cases.filter((c) => c.source?.type === "synthetic" && c.source.generator && isCorpus(c.source.generator));
    expect(listed.map((c) => c.source!.generator).sort()).toEqual([...CORPUS].sort());
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
    for (const c of listed) {
      const spec = CORPUS_SPECS[c.source!.generator as keyof typeof CORPUS_SPECS];
      expect(c.id).toBe(`synthetic-${c.source!.generator}`);
      expect(c.set).toBe("extended");
      expect([c.eco, c.name, c.good, c.bad]).toEqual([spec.eco, spec.name, "1.2.0", "1.2.1"]);
    }
    expect(CORPUS.filter((k) => CORPUS_SPECS[k].eco === "npm").length).toBeGreaterThan(5);
    expect(CORPUS.filter((k) => CORPUS_SPECS[k].eco === "pypi").length).toBeGreaterThan(5);
  });

  test("each case changes more than its version number", () => {
    const norm = (b: Uint8Array) => dec.decode(b).replace(/1\.2\.[01]/g, "V");
    for (const k of CORPUS) {
      const p = corpusPair(k);
      expect(p.old.size, k).toBeGreaterThan(0);
      const real = [...p.new].filter(([f, v]) => !p.old.has(f) || norm(p.old.get(f)!) !== norm(v));
      expect(real.length, k).toBeGreaterThan(0);
    }
  });

  test("every URL and host is on a .invalid host (a clean-side registry aside), in plain text or inside a base64 string", () => {
    for (const k of CORPUS) {
      const p = corpusPair(k);
      const all = text(p.old) + "\n" + text(p.new);
      const b64 = [...all.matchAll(/"([A-Za-z0-9+/]{40,}={0,2})"/g)].map((m) => Buffer.from(m[1]!, "base64").toString());
      const seen = [all, ...b64].join("\n");
      const urls = [...seen.matchAll(/https?:\/\/[^\s"'`)\\]+/g)].map((m) => m[0]);
      for (const u of urls) {
        const host = new URL(u).hostname;
        expect(host.endsWith(".invalid") || CLEAN_HOSTS.has(host), `${k}: ${u}`).toBe(true);
      }
      for (const u of p.urls) {
        const host = u.includes("://") ? new URL(u).hostname : u;
        expect(host.endsWith(".invalid"), `${k}: ${u}`).toBe(true);
        expect(seen, `${k}: ${u}`).toContain(u);
      }
    }
  });

  test("no real-looking secret: tokens and keys are placeholders", () => {
    for (const k of CORPUS) {
      const t = text(corpusPair(k).new);
      expect(t, k).not.toMatch(/ghp_[A-Za-z0-9]{20,}|npm_[A-Za-z0-9]{30,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----/);
    }
  });

  test("the corpus loads in acceptance/run.ts with a stub reviewer, offline", () => {
    const ids = cases.filter((c) => c.source?.generator && isCorpus(c.source.generator)).map((c) => c.id);
    const dir = mkdtempSync(join(tmpdir(), "oupdate-corpus-"));
    try {
      const stub = JSON.stringify([{ type: "command", name: "stub", argv: ["sh", "-c", "cat >/dev/null; echo APPROVE; echo no attack indicators found"] }]);
      const p = Bun.spawnSync(["bun", resolve(import.meta.dir, "../acceptance/run.ts"), "--set", "extended", "--only", ids.join(","), "--reviewers", stub, "--offline"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
      expect(p.stderr.toString()).toBe("");
      expect(p.exitCode).toBe(0);
      const out = p.stdout.toString();
      for (const id of ids) {
        expect(existsSync(join(dir, "acceptance-results", `${id}-stub.json`)), id).toBe(true);
        expect(out).toMatch(new RegExp(`^CORP ${id}-stub: `, "m"));
        const r = JSON.parse(readFileSync(join(dir, "acceptance-results", `${id}-stub.json`), "utf8"));
        expect(r.layers.find((l: { layer: string }) => l.layer === "reviewer").verdict).not.toBe("error");
      }
      expect(out).not.toMatch(/^MAL /m);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
