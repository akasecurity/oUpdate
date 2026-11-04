import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verdictDirOutsideRepo, verdictKey, cachedReviewer, recordResult, rollupHolds, reviewerFingerprint } from "../src/verdict-store.ts";
import type { LayerVerdict, Reviewer, ReviewResult } from "../src/review.ts";

/** Runs fn with the working directory inside a throwaway git checkout, so the tests do not depend on where they run. */
async function inCheckout(fn: (root: string) => void): Promise<void> {
  const { mkdirSync, realpathSync } = await import("node:fs");
  const root = realpathSync(mkdtempSync(join(tmpdir(), "verdict-co-")));
  const prev = process.cwd();
  try {
    mkdirSync(join(root, ".git"));
    process.chdir(root);
    fn(root);
  } finally { process.chdir(prev); rmSync(root, { recursive: true }); }
}

const dir = () => mkdtempSync(join(tmpdir(), "verdict-test-"));
const counting = (name: string, answer = "APPROVE\nfine") => {
  const r: Reviewer & { calls: number } = { calls: 0, name, review: async (_p: string) => (r.calls++, answer) };
  return r;
};

describe("verdictKey", () => {
  test("same reviewer and prompt give the same key; either changing gives another", () => {
    expect(verdictKey("m", "p")).toBe(verdictKey("m", "p"));
    expect(verdictKey("m", "p")).not.toBe(verdictKey("m", "p2"));
    expect(verdictKey("m", "p")).not.toBe(verdictKey("n", "p"));
    expect(verdictKey("ab", "c")).not.toBe(verdictKey("a", "bc"));
    expect(verdictKey("m", "p")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("reviewer fingerprint", () => {
  const oa = { type: "openai" as const, name: "m", baseUrls: ["http://a"], model: "x1", maxTokens: 100, timeoutMs: 5 };
  test("a changed model or setting that shapes the answer is another fingerprint", () => {
    expect(reviewerFingerprint(oa)).not.toBe(reviewerFingerprint({ ...oa, model: "x2" }));
    expect(reviewerFingerprint(oa)).not.toBe(reviewerFingerprint({ ...oa, maxTokens: 200 }));
    expect(reviewerFingerprint(oa)).not.toBe(reviewerFingerprint({ ...oa, extraBody: { temperature: 1 } }));
    const c = { type: "command" as const, name: "m", argv: ["rv", "--model", "a"] };
    expect(reviewerFingerprint(c)).not.toBe(reviewerFingerprint({ ...c, argv: ["rv", "--model", "b"] }));
  });
  test("where it runs does not matter: url, timeout, headers, key variable, work root, key order", () => {
    const f = reviewerFingerprint(oa);
    expect(reviewerFingerprint({ ...oa, baseUrls: ["http://b", "http://c"], timeoutMs: 99, headers: { a: "b" }, apiKeyEnv: "K", retryDelaysMs: [1] } as never)).toBe(f);
    expect(reviewerFingerprint({ timeoutMs: 5, maxTokens: 100, model: "x1", baseUrls: ["z"], name: "m", type: "openai" })).toBe(f);
    const c = { type: "command" as const, name: "m", argv: ["rv"] };
    expect(reviewerFingerprint({ ...c, workRoot: "/tmp/a", timeoutMs: 1 })).toBe(reviewerFingerprint(c));
  });
  test("the fingerprint is part of the key and of the cache hit", async () => {
    expect(verdictKey("m", "p", "f1")).not.toBe(verdictKey("m", "p", "f2"));
    const d = dir();
    try {
      const a = counting("m", "FLAG\nx"), b = counting("m", "FLAG\nx");
      await cachedReviewer(a, d, "h", "f1").review("x");
      await cachedReviewer(b, d, "h", "f2").review("x");
      await cachedReviewer(counting("m", "FLAG\nx"), d, "h", "f1").review("x");
      expect([a.calls, b.calls]).toEqual([1, 1]);
    } finally { rmSync(d, { recursive: true }); }
  });
});

describe("cachedReviewer", () => {
  const FLAG = "FLAG\nfetches code";
  test("a second host with the same diff reuses a FLAG answer", async () => {
    const d = dir();
    try {
      const a = counting("m", FLAG), b = counting("m", "APPROVE\nnever asked");
      expect(await cachedReviewer(a, d, "host-1").review("diff")).toBe(FLAG);
      expect(await cachedReviewer(b, d, "host-2").review("diff")).toBe(FLAG);
      expect([a.calls, b.calls]).toEqual([1, 0]);
    } finally { rmSync(d, { recursive: true }); }
  });
  test("an APPROVE is never stored and never served", async () => {
    const d = dir();
    try {
      const a = counting("m"), b = counting("m");
      await cachedReviewer(a, d, "h1").review("x");
      expect(readdirSync(d)).toEqual([]);
      await cachedReviewer(b, d, "h2").review("x");
      expect([a.calls, b.calls]).toEqual([1, 1]);
    } finally { rmSync(d, { recursive: true }); }
  });
  test("a planted APPROVE under the exact key is ignored: the reviewer runs and its own answer decides", async () => {
    const d = dir();
    try {
      await Bun.write(join(d, verdictKey("m", "x") + ".json"), JSON.stringify({ reviewer: "m", host: "evil", text: "APPROVE\nplanted" }));
      const a = counting("m", FLAG);
      expect(await cachedReviewer(a, d, "h").review("x")).toBe(FLAG);
      expect(a.calls).toBe(1);
      const ok = counting("m", "APPROVE\nreal");
      await Bun.write(join(d, verdictKey("m", "y") + ".json"), JSON.stringify({ reviewer: "m", host: "evil", text: "APPROVE\nplanted" }));
      expect(await cachedReviewer(ok, d, "h").review("y")).toBe("APPROVE\nreal");
      expect(ok.calls).toBe(1);
    } finally { rmSync(d, { recursive: true }); }
  });
  test("a different prompt or reviewer name is reviewed again", async () => {
    const d = dir();
    try {
      const a = counting("m", FLAG), o = counting("other", FLAG);
      await cachedReviewer(a, d, "h").review("one");
      await cachedReviewer(a, d, "h").review("two");
      await cachedReviewer(o, d, "h").review("one");
      expect([a.calls, o.calls]).toEqual([2, 1]);
    } finally { rmSync(d, { recursive: true }); }
  });
  test("an error or empty answer is never stored", async () => {
    const d = dir();
    try {
      const boom: Reviewer = { name: "m", review: async () => { throw new Error("down"); } };
      await expect(cachedReviewer(boom, d, "h").review("x")).rejects.toThrow("down");
      await cachedReviewer(counting("m", "  \n"), d, "h").review("x");
      expect(readdirSync(d)).toEqual([]);
    } finally { rmSync(d, { recursive: true }); }
  });
  test("a damaged entry is a miss, not a crash", async () => {
    const d = dir();
    try {
      await Bun.write(join(d, verdictKey("m", "x") + ".json"), "{not json");
      const a = counting("m", FLAG);
      expect(await cachedReviewer(a, d, "h").review("x")).toBe(FLAG);
      expect(a.calls).toBe(1);
    } finally { rmSync(d, { recursive: true }); }
  });
  test("the reviewer's name and ready check are kept", async () => {
    const d = dir();
    try {
      const w = cachedReviewer({ ...counting("m"), ready: async () => "down" }, d, "h");
      expect(w.name).toBe("m");
      expect(await w.ready!()).toBe("down");
    } finally { rmSync(d, { recursive: true }); }
  });
});

const held = (name: string, detail: string, decision: "hold" | "land" = "hold"): ReviewResult => ({
  eco: "npm", name, from: "1.0.0", to: "1.0.1", decision,
  layers: [{ layer: "reviewer", verdict: decision === "hold" ? "stop" : "pass", detail }],
});

describe("rollupHolds", () => {
  test("one hold per package release and reason, with every host that hit it", async () => {
    const d = dir();
    try {
      for (const h of ["h3", "h1", "h2"]) await recordResult(d, h, held("left-pad", "m FLAG on part(s) 1 of 1"));
      await recordResult(d, "h1", held("other", "too large for model review: 9 parts > 8 (full diff)"));
      await recordResult(d, "h2", held("other", "a different reason"));
      await recordResult(d, "h1", held("fine", "m APPROVE on 1 part(s)", "land"));
      const rows = await rollupHolds(d);
      expect(rows.length).toBe(3);
      expect(rows.find((r) => r.name === "left-pad")).toEqual({ eco: "npm", name: "left-pad", from: "1.0.0", to: "1.0.1", reason: "reviewer: m FLAG on part(s) 1 of 1", hosts: ["h1", "h2", "h3"] });
      expect(rows.map((r) => r.name).sort()).toEqual(["left-pad", "other", "other"]);
    } finally { rmSync(d, { recursive: true }); }
  });
  test("a host recording the same release again replaces its entry", async () => {
    const d = dir();
    try {
      await recordResult(d, "h1", held("p", "m FLAG on part(s) 1 of 1"));
      await recordResult(d, "h1", held("p", "m APPROVE on 1 part(s)", "land"));
      expect(await rollupHolds(d)).toEqual([]);
    } finally { rmSync(d, { recursive: true }); }
  });
  test("a host name cannot escape the store", async () => {
    const d = dir();
    try {
      await recordResult(d, "../../evil", held("p", "x"));
      expect((await rollupHolds(d))[0]!.hosts).toEqual(["../../evil"]);
      expect(readdirSync(join(d, "results")).length).toBe(1);
    } finally { rmSync(d, { recursive: true }); }
  });
});

describe("--verdict-dir", () => {
  test("review and gate take it", async () => {
    const { parseReviewArgs, parseGateArgs } = await import("../src/cli.ts");
    expect(parseReviewArgs(["npm", "p", "1", "2", "--verdict-dir", "/s"]).verdictDir).toBe("/s");
    expect(parseReviewArgs(["npm", "p", "1", "2"]).verdictDir).toBeUndefined();
    expect(parseGateArgs(["--endpoint", "e", "--repo", "o/r", "--token-file", "t", "--verdict-dir", "/s"]).verdictDir).toBe("/s");
  });
});

describe("gate refuses a verdict dir inside the checkout", () => {
  test("inside the cwd, inside the repo root above the cwd, or inside the workspace is refused; a sibling is fine", async () => {
    const root = mkdtempSync(join(tmpdir(), "verdict-repo-"));
    const other = mkdtempSync(join(tmpdir(), "verdict-other-"));
    try {
      const { mkdirSync, symlinkSync } = await import("node:fs");
      mkdirSync(join(root, ".git"));
      mkdirSync(join(root, "sub", "deep"), { recursive: true });
      expect(() => verdictDirOutsideRepo(join(root, "store"), root, {})).toThrow(/inside/);
      expect(() => verdictDirOutsideRepo(root, root, {})).toThrow(/inside/);
      expect(() => verdictDirOutsideRepo(join(root, "store"), join(root, "sub", "deep"), {})).toThrow(/inside/);
      expect(() => verdictDirOutsideRepo(join(other, "store"), other, { GITHUB_WORKSPACE: other })).toThrow(/inside/);
      symlinkSync(root, join(other, "link"));
      expect(() => verdictDirOutsideRepo(join(other, "link", "store"), root, {})).toThrow(/inside/);
      expect(() => verdictDirOutsideRepo(join(other, "store"), root, {})).not.toThrow();
    } finally { rmSync(root, { recursive: true }); rmSync(other, { recursive: true }); }
  });
  test("a directory whose name starts with two dots inside the checkout is refused", async () => {
    const root = mkdtempSync(join(tmpdir(), "verdict-dots-"));
    try {
      const { mkdirSync } = await import("node:fs");
      mkdirSync(join(root, ".git"));
      expect(() => verdictDirOutsideRepo(join(root, "..store"), root, {})).toThrow(/inside/);
      expect(() => verdictDirOutsideRepo(join(root, "..", "elsewhere-" + Date.now()), root, {})).not.toThrow();
    } finally { rmSync(root, { recursive: true }); }
  });
  test("parseGateArgs applies it", async () => {
    const { parseGateArgs } = await import("../src/cli.ts");
    await inCheckout((root) => {
      expect(() => parseGateArgs(["--endpoint", "e", "--repo", "o/r", "--token-file", "t", "--verdict-dir", join(root, "store")])).toThrow(/inside/);
    });
  });
});

describe("shared folder hardening", () => {
  test("only the git root and the CI workspace are roots: a plain working directory is not", async () => {
    const root = mkdtempSync(join(tmpdir(), "verdict-plain-"));
    const ws = mkdtempSync(join(tmpdir(), "verdict-ws-"));
    try {
      expect(() => verdictDirOutsideRepo(join(root, "store"), root, {})).not.toThrow();
      expect(() => verdictDirOutsideRepo(join(ws, "store"), root, { GITHUB_WORKSPACE: ws })).toThrow(/inside/);
    } finally { rmSync(root, { recursive: true }); rmSync(ws, { recursive: true }); }
  });
  test("review args refuse a verdict dir inside the checkout like gate args do", async () => {
    const { parseReviewArgs } = await import("../src/cli.ts");
    await inCheckout((root) => {
      expect(() => parseReviewArgs(["npm", "p", "1.0.0", "1.0.1", "--verdict-dir", join(root, "store")])).toThrow(/inside/);
    });
  });
  test("a stray file, a wrong-shaped record and a record with terminal escapes do not break the roll-up", async () => {
    const d = dir();
    try {
      const { mkdirSync, writeFileSync } = await import("node:fs");
      await recordResult(d, "h1", held("p", "m FLAG on part(s) 1 of 1"));
      writeFileSync(join(d, "results", ".DS_Store"), "x");
      mkdirSync(join(d, "results", "bad"));
      writeFileSync(join(d, "results", "bad", "a.json"), "{}");
      writeFileSync(join(d, "results", "bad", "b.json"), JSON.stringify({ host: "h", result: { decision: "hold", eco: "npm" } }));
      writeFileSync(join(d, "results", "bad", "c.json"), "null");
      await recordResult(d, "h\u001b]52;c;eA==\u0007x", held("q", "m FLAG\u001b[2J on part(s) 1 of 1"));
      const rows = await rollupHolds(d);
      expect(rows.map((r) => r.name).sort()).toEqual(["p", "q"]);
      expect(rows.flatMap((r) => [r.eco, r.name, r.from, r.to, r.reason, ...r.hosts]).join("")).not.toContain("\u001b");
    } finally { rmSync(d, { recursive: true }); }
  });
});

describe("roll-up shape and cooldown", () => {
  const rec = (host: string, result: unknown) => ({ host, result });
  const put = async (d: string, name: string, body: unknown) => {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(join(d, "results", "h"), { recursive: true });
    writeFileSync(join(d, "results", "h", `${name}.json`), JSON.stringify(body));
  };
  const base = { eco: "npm", name: "p", from: "1.0.0", to: "1.0.1", decision: "hold" };
  test("a record with valid strings but missing, non-array or non-object layers is skipped", async () => {
    const d = dir();
    try {
      await recordResult(d, "h1", held("ok", "m FLAG on part(s) 1 of 1"));
      await put(d, "a", rec("h", base));
      await put(d, "b", rec("h", { ...base, layers: "x" }));
      await put(d, "c", rec("h", { ...base, layers: [null] }));
      await put(d, "d", rec("h", { ...base, layers: [{ layer: "reviewer" }] }));
      expect((await rollupHolds(d)).map((r) => r.name)).toEqual(["ok"]);
    } finally { rmSync(d, { recursive: true }); }
  });
  test("terminal escapes in name, eco, from and to are stripped", async () => {
    const d = dir();
    try {
      await put(d, "e", rec("h", { eco: "n\u001b[2Jpm", name: "p\u001b]52;c;eA==\u0007q", from: "1\u001b[2J", to: "2\u001b[2J", decision: "hold", layers: [{ layer: "reviewer", verdict: "stop", detail: "x" }] }));
      const rows = await rollupHolds(d);
      expect(rows.length).toBe(1);
      expect([rows[0]!.eco, rows[0]!.name, rows[0]!.from, rows[0]!.to].join("")).not.toContain("\u001b");
    } finally { rmSync(d, { recursive: true }); }
  });
  test("a cooldown stop never names a hold: cooldown-only releases are not listed and a FLAG shows its own reason", async () => {
    const d = dir();
    try {
      const cool = (age: string): LayerVerdict => ({ layer: "cooldown", verdict: "stop", detail: `held: ${age} h old, cooldown 2 d` });
      await recordResult(d, "h1", { ...held("waiting", ""), layers: [cool("3.1")] });
      await recordResult(d, "h2", { ...held("both", ""), layers: [cool("5.7"), { layer: "reviewer", verdict: "stop", detail: "m FLAG on part(s) 1 of 1" } as LayerVerdict] });
      await recordResult(d, "h3", { ...held("both", ""), layers: [cool("9.2"), { layer: "reviewer", verdict: "stop", detail: "m FLAG on part(s) 1 of 1" } as LayerVerdict] });
      const rows = await rollupHolds(d);
      expect(rows.length).toBe(1);
      expect(rows[0]).toMatchObject({ name: "both", reason: "reviewer: m FLAG on part(s) 1 of 1", hosts: ["h2", "h3"] });
    } finally { rmSync(d, { recursive: true }); }
  });
  test("an unwritable store does not lose a FLAG answer", async () => {
    const d = dir();
    try {
      const { writeFileSync } = await import("node:fs");
      const blocker = join(d, "file");
      writeFileSync(blocker, "x");
      const inner = counting("m", "FLAG\nbad");
      const rv = cachedReviewer(inner, join(blocker, "store"), "h1");
      expect(await rv.review("p")).toBe("FLAG\nbad");
    } finally { rmSync(d, { recursive: true }); }
  });
});
