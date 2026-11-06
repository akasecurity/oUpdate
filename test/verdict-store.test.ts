import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verdictDirOutsideRepo, verdictKey, cachedReviewer, recordResult, rollupHolds, reviewerFingerprint, storeEntries, forgetEntries, markStoreAnswer, STORE_MARK } from "../src/verdict-store.ts";
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

describe("cachedReviewer served-by", () => {
  test("it passes the inner reviewer's served-by through, and a store hit has none", async () => {
    const d = dir();
    try {
      let cur: string | undefined;
      const inner: Reviewer = { name: "m", review: async () => { cur = "worker-1"; return "FLAG\nbad"; }, lastServedBy: () => cur };
      const c = cachedReviewer(inner, d, "h", "f1");
      await c.review("p");
      expect(c.lastServedBy?.()).toBe("worker-1");
      await c.review("p"); // the FLAG is in the store now
      expect(c.storeHits).toBe(1);
      expect(c.lastServedBy?.()).toBeUndefined();
      const plain = cachedReviewer(counting("n"), d, "h", "f1");
      await plain.review("q");
      expect(plain.lastServedBy).toBeUndefined();
    } finally { rmSync(d, { recursive: true }); }
  });
});

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
    expect(reviewerFingerprint({ ...oa, expectHeaders: { "x-served-by": "local" }, servedByHeader: "x-served-by" } as never)).toBe(f);
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
      writeFileSync(join(d, "results", "bad", `${"a".repeat(64)}.json`), "{}");
      writeFileSync(join(d, "results", "bad", `${"b".repeat(64)}.json`), JSON.stringify({ host: "h", result: { decision: "hold", eco: "npm" } }));
      writeFileSync(join(d, "results", "bad", `${"c".repeat(64)}.json`), "null");
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
    writeFileSync(join(d, "results", "h", `${new Bun.CryptoHasher("sha256").update(name).digest("hex")}.json`), JSON.stringify(body));
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

const rel = { eco: "npm", name: "left-pad", from: "1.0.0", to: "1.0.1" };

describe("entry metadata", () => {
  test("a stored entry records the release and when it was written", async () => {
    const d = dir();
    try {
      const before = Date.now();
      await cachedReviewer(counting("m", "FLAG\nbad"), d, "h1", "", rel).review("x");
      const [e] = storeEntries(d);
      expect(e).toMatchObject({ key: verdictKey("m", "x"), file: join(d, verdictKey("m", "x") + ".json"), reviewer: "m", host: "h1", ...rel });
      expect(Date.parse(e!.at!)).toBeGreaterThanOrEqual(before - 1000);
    } finally { rmSync(d, { recursive: true }); }
  });
  test("an old entry without the fields still serves its FLAG and still lists", async () => {
    const d = dir();
    try {
      await Bun.write(join(d, verdictKey("m", "x") + ".json"), JSON.stringify({ reviewer: "m", host: "old", text: "FLAG\nold" }));
      const a = counting("m", "APPROVE\nnever asked");
      expect(await cachedReviewer(a, d, "h", "", rel).review("x")).toBe("FLAG\nold");
      expect(a.calls).toBe(0);
      expect(storeEntries(d)).toEqual([{ key: verdictKey("m", "x"), file: join(d, verdictKey("m", "x") + ".json"), reviewer: "m", host: "old" }]);
    } finally { rmSync(d, { recursive: true }); }
  });
  test("only key-named files holding a FLAG are listed: an APPROVE, a damaged file and a stray name are not", async () => {
    const d = dir();
    try {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(join(d, verdictKey("m", "a") + ".json"), JSON.stringify({ text: "APPROVE\nplanted", ...rel }));
      writeFileSync(join(d, verdictKey("m", "b") + ".json"), "{not json");
      writeFileSync(join(d, "notes.json"), JSON.stringify({ text: "FLAG\nx", ...rel }));
      expect(storeEntries(d)).toEqual([]);
      expect(storeEntries(join(d, "missing"))).toEqual([]);
    } finally { rmSync(d, { recursive: true }); }
  });
  test("oupdate verdicts prints the key file beside each hold", async () => {
    const d = dir();
    try {
      const { verdictsMain } = await import("../src/cli.ts");
      await cachedReviewer(counting("m", "FLAG\nbad"), d, "h1", "", rel).review("x");
      await recordResult(d, "h1", held("left-pad", "m FLAG on part(s) 1 of 1"));
      const lines: string[] = [];
      expect(await verdictsMain(["--verdict-dir", d], (l) => lines.push(l))).toBe(0);
      expect(lines[0]).toContain("left-pad 1.0.0 -> 1.0.1");
      expect(lines[0]).toContain(join(d, verdictKey("m", "x") + ".json"));
    } finally { rmSync(d, { recursive: true }); }
  });
});

describe("forget", () => {
  test("by key stem: deletes that entry, prints it, the next review asks again", async () => {
    const d = dir();
    try {
      await cachedReviewer(counting("m", "FLAG\nbad"), d, "h1", "", rel).review("x");
      const key = verdictKey("m", "x");
      expect(forgetEntries(d, key)).toEqual([join(d, key + ".json")]);
      expect(readdirSync(d)).toEqual([]);
      const b = counting("m");
      await cachedReviewer(b, d, "h2", "", rel).review("x");
      expect(b.calls).toBe(1);
    } finally { rmSync(d, { recursive: true }); }
  });
  test("by release: deletes every entry of that release and no other", async () => {
    const d = dir();
    try {
      await cachedReviewer(counting("m", "FLAG\na"), d, "h", "", rel).review("part1");
      await cachedReviewer(counting("m", "FLAG\nb"), d, "h", "", rel).review("part2");
      await cachedReviewer(counting("m", "FLAG\nc"), d, "h", "", { ...rel, to: "1.0.2" }).review("other");
      expect(forgetEntries(d, "npm:left-pad@1.0.0>1.0.1").sort()).toEqual([verdictKey("m", "part1"), verdictKey("m", "part2")].map((k) => join(d, k + ".json")).sort());
      expect(readdirSync(d)).toEqual([verdictKey("m", "other") + ".json"]);
    } finally { rmSync(d, { recursive: true }); }
  });
  test("a scoped name and an empty from parse", async () => {
    const d = dir();
    try {
      const scoped = { eco: "npm", name: "@s/p", from: "", to: "2.0.0" };
      await cachedReviewer(counting("m", "FLAG\na"), d, "h", "", scoped).review("x");
      expect(forgetEntries(d, "npm:@s/p@>2.0.0")).toEqual([join(d, verdictKey("m", "x") + ".json")]);
    } finally { rmSync(d, { recursive: true }); }
  });
  test("no match is nothing to forget, exit 0; a malformed target is refused", async () => {
    const d = dir();
    try {
      const { verdictsMain } = await import("../src/cli.ts");
      const lines: string[] = [];
      expect(await verdictsMain(["--verdict-dir", d, "--forget", "a".repeat(64)], (l) => lines.push(l))).toBe(0);
      expect(await verdictsMain(["--forget", "npm:x@1>2", "--verdict-dir", d], (l) => lines.push(l))).toBe(0);
      expect(lines).toEqual(["nothing to forget", "nothing to forget"]);
      await expect(verdictsMain(["--verdict-dir", d, "--forget", "../../etc/passwd"], () => {})).rejects.toThrow(/usage/);
      await expect(verdictsMain(["--verdict-dir", d, "--forget"], () => {})).rejects.toThrow(/usage/);
    } finally { rmSync(d, { recursive: true }); }
  });
  test("oupdate verdicts --forget prints each file it deleted", async () => {
    const d = dir();
    try {
      const { verdictsMain } = await import("../src/cli.ts");
      await cachedReviewer(counting("m", "FLAG\nbad"), d, "h1", "", rel).review("x");
      const lines: string[] = [];
      expect(await verdictsMain(["--verdict-dir", d, "--forget", "npm:left-pad@1.0.0>1.0.1"], (l) => lines.push(l))).toBe(0);
      expect(lines).toEqual([`forgot ${join(d, verdictKey("m", "x") + ".json")}`]);
    } finally { rmSync(d, { recursive: true }); }
  });
});

describe("roll-up release id", () => {
  test("releases whose hyphen-joined ids collide are kept apart", async () => {
    const d = dir();
    try {
      const a: ReviewResult = { ...held("a-b", "m FLAG on part(s) 1 of 1"), from: "1", to: "2" };
      const b: ReviewResult = { ...held("a", "m FLAG on part(s) 1 of 1"), from: "b-1", to: "2" };
      await recordResult(d, "h1", a);
      await recordResult(d, "h1", b);
      expect((await rollupHolds(d)).map((r) => `${r.name} ${r.from}`).sort()).toEqual(["a b-1", "a-b 1"]);
    } finally { rmSync(d, { recursive: true }); }
  });
  test("a record left under the old hyphen-joined file name is not rolled up next to its hashed successor", async () => {
    const d = dir();
    try {
      await recordResult(d, "h1", held("p", "m FLAG on part(s) 1 of 1"));
      const { mkdirSync, writeFileSync } = await import("node:fs");
      mkdirSync(join(d, "results", "h1"), { recursive: true });
      writeFileSync(join(d, "results", "h1", "npm-q-1.0.0-1.0.1.json"), JSON.stringify({ host: "h1", result: held("q", "m FLAG on part(s) 1 of 1") }));
      expect((await rollupHolds(d)).map((r) => r.name)).toEqual(["p"]);
    } finally { rmSync(d, { recursive: true }); }
  });
  test("a very long package name still records", async () => {
    const d = dir();
    try {
      await recordResult(d, "h1", held("x".repeat(400), "m FLAG on part(s) 1 of 1"));
      expect((await rollupHolds(d)).length).toBe(1);
      expect(readdirSync(join(d, "results", "h1"))[0]).toMatch(/^[0-9a-f]{64}\.json$/);
    } finally { rmSync(d, { recursive: true }); }
  });
});

describe("a reused answer is marked", () => {
  test("the wrapper counts the answers it served from the store", async () => {
    const d = dir();
    try {
      const first = cachedReviewer(counting("m", "FLAG\nbad"), d, "h1");
      await first.review("x");
      expect(first.storeHits).toBe(0);
      const second = cachedReviewer(counting("m"), d, "h2");
      await second.review("x");
      await second.review("y");
      expect(second.storeHits).toBe(1);
    } finally { rmSync(d, { recursive: true }); }
  });
  test("the reviewer layer's reason says it came from the shared store; other layers and a fresh answer are untouched", () => {
    const r: ReviewResult = { ...held("p", "m FLAG on part(s) 1 of 1"), layers: [{ layer: "prepass", verdict: "pass", detail: "clean" }, { layer: "reviewer", verdict: "stop", detail: "m FLAG on part(s) 1 of 1" }] };
    expect(markStoreAnswer(r, 0)).toEqual(r);
    const m = markStoreAnswer(r, 1);
    expect(m.layers[0]!.detail).toBe("clean");
    expect(m.layers[1]!.detail).toBe(`m FLAG on part(s) 1 of 1${STORE_MARK}`);
  });
  test("the roll-up gives the host that paid and the host that reused one row", async () => {
    const d = dir();
    try {
      await recordResult(d, "h1", held("p", "m FLAG on part(s) 1 of 1"));
      await recordResult(d, "h2", markStoreAnswer(held("p", "m FLAG on part(s) 1 of 1"), 1));
      const rows = await rollupHolds(d);
      expect(rows.length).toBe(1);
      expect(rows[0]).toMatchObject({ reason: "reviewer: m FLAG on part(s) 1 of 1", hosts: ["h1", "h2"] });
    } finally { rmSync(d, { recursive: true }); }
  });
});

/** Makes a FIFO at path, or returns false when mkfifo is missing so the caller can skip. */
const fifo = async (path: string): Promise<boolean> => {
  const { execFileSync } = await import("node:child_process");
  try {
    execFileSync("mkfifo", [path], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

describe("a non-regular file in the store is skipped, not read", () => {
  test("a FIFO under the exact key is a miss: the reviewer is asked and the review finishes", async () => {
    const d = dir();
    try {
      if (!(await fifo(join(d, verdictKey("m", "x") + ".json")))) return;
      const a = counting("m", "FLAG\nlive");
      expect(await cachedReviewer(a, d, "h").review("x")).toBe("FLAG\nlive");
      expect(a.calls).toBe(1);
    } finally { rmSync(d, { recursive: true }); }
  });
  test("a directory under the exact key is a miss too", async () => {
    const d = dir();
    try {
      const { mkdirSync } = await import("node:fs");
      mkdirSync(join(d, verdictKey("m", "x") + ".json"));
      const a = counting("m", "APPROVE\nlive");
      expect(await cachedReviewer(a, d, "h").review("x")).toBe("APPROVE\nlive");
      expect(a.calls).toBe(1);
    } finally { rmSync(d, { recursive: true }); }
  });
  test("a symlink to a regular entry is still followed", async () => {
    const d = dir();
    try {
      const { symlinkSync, writeFileSync } = await import("node:fs");
      writeFileSync(join(d, "real"), JSON.stringify({ text: "FLAG\nlinked", ...rel }));
      symlinkSync(join(d, "real"), join(d, verdictKey("m", "x") + ".json"));
      const a = counting("m", "APPROVE\nnever asked");
      expect(await cachedReviewer(a, d, "h").review("x")).toBe("FLAG\nlinked");
      expect(a.calls).toBe(0);
      expect(storeEntries(d).map((e) => e.key)).toEqual([verdictKey("m", "x")]);
    } finally { rmSync(d, { recursive: true }); }
  });
  test("storeEntries lists the regular entries and skips a FIFO", async () => {
    const d = dir();
    try {
      await cachedReviewer(counting("m", "FLAG\nbad"), d, "h1", "", rel).review("x");
      if (!(await fifo(join(d, "f".repeat(64) + ".json")))) return;
      expect(storeEntries(d).map((e) => e.key)).toEqual([verdictKey("m", "x")]);
    } finally { rmSync(d, { recursive: true }); }
  });
  test("rollupHolds rolls up the regular records and skips a FIFO", async () => {
    const d = dir();
    try {
      await recordResult(d, "h1", held("p", "m FLAG on part(s) 1 of 1"));
      if (!(await fifo(join(d, "results", "h1", "f".repeat(64) + ".json")))) return;
      expect((await rollupHolds(d)).map((r) => r.name)).toEqual(["p"]);
    } finally { rmSync(d, { recursive: true }); }
  });
});

describe("planted non-string release fields", () => {
  test("an entry with a number for eco, name, from or to lists without that field, and the listing does not crash", async () => {
    const d = dir();
    try {
      const { writeFileSync } = await import("node:fs");
      const { verdictsMain } = await import("../src/cli.ts");
      writeFileSync(join(d, verdictKey("m", "a") + ".json"), JSON.stringify({ text: "FLAG\nx", eco: 1, name: { a: 1 }, from: ["1"], to: null }));
      expect(storeEntries(d)).toEqual([{ key: verdictKey("m", "a"), file: join(d, verdictKey("m", "a") + ".json") }]);
      await recordResult(d, "h1", held("left-pad", "m FLAG on part(s) 1 of 1"));
      const lines: string[] = [];
      expect(await verdictsMain(["--verdict-dir", d], (l) => lines.push(l))).toBe(0);
      expect(lines[0]).toContain("left-pad 1.0.0 -> 1.0.1");
    } finally { rmSync(d, { recursive: true }); }
  });
  test("a result record with a number for eco, name, from or to is dropped from the roll-up", async () => {
    const d = dir();
    try {
      const { mkdirSync, writeFileSync } = await import("node:fs");
      await recordResult(d, "h1", held("ok", "m FLAG on part(s) 1 of 1"));
      mkdirSync(join(d, "results", "h"), { recursive: true });
      const layers = [{ layer: "reviewer", verdict: "stop", detail: "x" }];
      const base = { eco: "npm", name: "p", from: "1", to: "2", decision: "hold", layers };
      for (const [i, k] of ["eco", "name", "from", "to"].entries()) writeFileSync(join(d, "results", "h", `${String(i).repeat(64)}.json`), JSON.stringify({ host: "h", result: { ...base, [k]: 1 } }));
      expect((await rollupHolds(d)).map((r) => r.name)).toEqual(["ok"]);
    } finally { rmSync(d, { recursive: true }); }
  });
});

describe("store mark", () => {
  test("a reason already carrying the mark does not get it twice", () => {
    const once = markStoreAnswer(held("p", "m FLAG on part(s) 1 of 1"), 1);
    const twice = markStoreAnswer(once, 2);
    expect(twice.layers[0]!.detail).toBe(`m FLAG on part(s) 1 of 1${STORE_MARK}`);
  });
});

describe("verdicts listing: entry files and the forget hint", () => {
  test("a hold row naming another layer first still shows the stored FLAG entry that names the release", async () => {
    const d = dir();
    try {
      const { verdictsMain } = await import("../src/cli.ts");
      await cachedReviewer(counting("m", "FLAG\nbad"), d, "h1", "", rel).review("x");
      await recordResult(d, "h1", { ...held("left-pad", ""), layers: [{ layer: "prepass", verdict: "stop", detail: "install script added" }] });
      const lines: string[] = [];
      await verdictsMain(["--verdict-dir", d], (l) => lines.push(l));
      expect(lines[0]).toContain("prepass: install script added");
      expect(lines[0]).toContain(`entry: ${join(d, verdictKey("m", "x") + ".json")}`);
    } finally { rmSync(d, { recursive: true }); }
  });
  test("a reviewer stop that is not a stored FLAG gets no forget hint", async () => {
    const d = dir();
    try {
      const { verdictsMain } = await import("../src/cli.ts");
      await recordResult(d, "h1", held("left-pad", "m read time budget of 500 ms ran out; needs a human"));
      const lines: string[] = [];
      await verdictsMain(["--verdict-dir", d], (l) => lines.push(l));
      expect(lines[0]).toContain("read time budget");
      expect(lines[0]).not.toContain("--forget <key> takes a key");
    } finally { rmSync(d, { recursive: true }); }
  });
  test("a reviewer hold with no matching entry says the key comes from the store directory", async () => {
    const d = dir();
    try {
      const { verdictsMain } = await import("../src/cli.ts");
      await Bun.write(join(d, verdictKey("m", "x") + ".json"), JSON.stringify({ reviewer: "m", host: "old", text: "FLAG\nold" }));
      await recordResult(d, "h1", held("left-pad", "m FLAG on part(s) 1 of 1"));
      const lines: string[] = [];
      await verdictsMain(["--verdict-dir", d], (l) => lines.push(l));
      expect(lines[0]).not.toContain("entry: /");
      expect(lines[0]).toContain(`--forget <key> takes a key from ${d}`);
      expect(lines[0]!.split("\n").length).toBe(1);
    } finally { rmSync(d, { recursive: true }); }
  });
});

describe("forget by release matches the listing", () => {
  test("a name carrying a dropped character is forgotten by the name the listing shows", async () => {
    const d = dir();
    try {
      await cachedReviewer(counting("m", "FLAG\nbad"), d, "h", "", { ...rel, name: "left\u200b-pad" }).review("x");
      expect(forgetEntries(d, "npm:left-pad@1.0.0>1.0.1")).toEqual([join(d, verdictKey("m", "x") + ".json")]);
      expect(readdirSync(d)).toEqual([]);
    } finally { rmSync(d, { recursive: true }); }
  });
});

describe("parsers use the env they are given", () => {
  test("review and gate check --verdict-dir and --state-dir against the passed workspace", async () => {
    const { parseReviewArgs, parseGateArgs } = await import("../src/cli.ts");
    const ws = mkdtempSync(join(tmpdir(), "verdict-envws-"));
    try {
      const env = { GITHUB_WORKSPACE: ws };
      const g = ["--endpoint", "e", "--repo", "o/r", "--token-file", "t"];
      expect(() => parseReviewArgs(["npm", "p", "1", "2", "--verdict-dir", join(ws, "s")], env)).toThrow(/inside/);
      expect(() => parseReviewArgs(["npm", "p", "1", "2", "--state-dir", join(ws, "s")], env)).toThrow(/inside/);
      expect(() => parseGateArgs([...g, "--state-dir", join(ws, "s")], env)).toThrow(/inside/);
      expect(() => parseReviewArgs(["npm", "p", "1", "2", "--verdict-dir", join(ws, "s")], {})).not.toThrow();
    } finally { rmSync(ws, { recursive: true }); }
  });
});
