import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MARKER, runGate, verdictLine, type Change } from "../src/gate.ts";
import type { Forge, Pull, StatusState } from "../src/adapters/forge/types.ts";
import type { ReviewResult } from "../src/review.ts";
import { addWaiver, findWaiver, listWaivers, sha256Hex, waiverFingerprint, waiversPath, type Waiver } from "../src/waiver.ts";

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "regate-")); dirs.push(d); return d; };
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

const waiver = (over: Partial<Waiver> = {}): Waiver => ({ eco: "npm", name: "p", version: "2.0.0", sha256: sha256Hex(new Uint8Array([1])), reason: "known build", who: "alice", at: "2026-11-03T10:00:00.000Z", ...over });

describe("waiverFingerprint", () => {
  test("changes when a waiver is added or removed, not when a reason, person or time changes, and ignores order", () => {
    const a = waiver(), b = waiver({ name: "q" });
    expect(waiverFingerprint([a, b])).toBe(waiverFingerprint([b, a]));
    expect(waiverFingerprint([a, b])).not.toBe(waiverFingerprint([a]));
    expect(waiverFingerprint([a])).not.toBe(waiverFingerprint([]));
    expect(waiverFingerprint([a])).toBe(waiverFingerprint([{ ...a, reason: "other", who: "bob", at: "2027-01-01T00:00:00.000Z" }]));
    expect(waiverFingerprint([a])).not.toBe(waiverFingerprint([{ ...a, sha256: sha256Hex(new Uint8Array([2])) }]));
  });
});

describe("verdictLine", () => {
  test("is the plain line without a fingerprint and names the fingerprint with one", () => {
    expect(verdictLine("h1", "failure")).toBe("<!-- oupdate-verdict: h1 failure -->");
    expect(verdictLine("h1", "failure", "abc123")).toBe("<!-- oupdate-verdict: h1 failure waivers:abc123 -->");
  });
});

const SRI = `sha512-${"X".repeat(86)}==`;
const LOCK = (v: string) => `{"lockfileVersion":1,"packages":{"yaml":["yaml@${v}","",{},"${SRI}"],}}`;
const files: Record<string, string> = { "b:bun.lock": LOCK("2.8.1"), "h1:bun.lock": LOCK("2.8.3") };

/** One renovate PR whose head already has a final status and the gate's own comment. */
function forgeWith(state: StatusState, line: string) {
  const pr: Pull = { number: 1, headRef: "renovate/yaml", headSha: "h1", baseSha: "b", author: "renovate[bot]", headRepo: "o/r", baseRepo: "o/r" };
  let status: StatusState = state;
  let body = `${MARKER}\n${line}\n`;
  const forge: Forge = {
    self: async () => "gate",
    openPulls: async () => [pr],
    readFile: async (_r, sha, path) => files[`${sha}:${path}`],
    changedFiles: async () => ["bun.lock"],
    statusOf: async () => ({ state: status, creator: "gate" }),
    setStatus: async (_r, _s, s) => void (status = s.state),
    ownComment: async () => body,
    upsertComment: async (_r, _n, _m, b) => void (body = b),
  };
  return { forge, body: () => body };
}
const result = (c: Change, decision: "land" | "hold"): ReviewResult => ({ eco: c.eco, name: c.name, from: c.from ?? "", to: c.to, decision, layers: decision === "hold" ? [{ layer: "reviewer", verdict: "stop", detail: "binary file(s) engine.wasm" }] : [], flagged: false } as unknown as ReviewResult);

describe("a verdict reached under other waivers is reviewed again", () => {
  test("the same fingerprint keeps the final verdict", async () => {
    const { forge } = forgeWith("failure", verdictLine("h1", "failure", "aaaa"));
    const seen: string[] = [];
    const out = await runGate({ forge, repo: "o/r", waiverPrint: "aaaa", review: async (c) => (seen.push(c.name), result(c, "hold")) });
    expect(out.map((p) => p.state)).toEqual(["skipped"]);
    expect(seen).toEqual([]);
  });

  test("a waiver added after a hold re-gates the PR, the review lands it, and the new comment records the new fingerprint", async () => {
    const { forge, body } = forgeWith("failure", verdictLine("h1", "failure", "aaaa"));
    const seen: string[] = [];
    const out = await runGate({ forge, repo: "o/r", waiverPrint: "bbbb", review: async (c) => (seen.push(c.name), result(c, "land")) });
    expect(seen).toEqual(["yaml"]);
    expect(out.map((p) => p.state)).toEqual(["success"]);
    expect(body()).toContain(verdictLine("h1", "success", "bbbb"));
  });

  test("a verdict written before fingerprints existed is reviewed again once the run has a waiver store", async () => {
    const { forge } = forgeWith("failure", verdictLine("h1", "failure"));
    const seen: string[] = [];
    await runGate({ forge, repo: "o/r", waiverPrint: "aaaa", review: async (c) => (seen.push(c.name), result(c, "hold")) });
    expect(seen).toEqual(["yaml"]);
  });

  test("a waiver removed after a landing re-gates the PR and a hold fails closed", async () => {
    const { forge, body } = forgeWith("success", verdictLine("h1", "success", "bbbb"));
    const out = await runGate({ forge, repo: "o/r", waiverPrint: "aaaa", review: async (c) => result(c, "hold") });
    expect(out.map((p) => p.state)).toEqual(["failure"]);
    expect(body()).toContain(verdictLine("h1", "failure", "aaaa"));
  });

  test("a run with no waiver store keeps a final verdict and writes the plain line, as before", async () => {
    const kept = forgeWith("failure", verdictLine("h1", "failure"));
    expect((await runGate({ forge: kept.forge, repo: "o/r", review: async (c) => result(c, "hold") })).map((p) => p.state)).toEqual(["skipped"]);
    const fresh = forgeWith("failure", verdictLine("h0", "failure"));
    await runGate({ forge: fresh.forge, repo: "o/r", review: async (c) => result(c, "hold") });
    expect(fresh.body()).toContain("<!-- oupdate-verdict: h1 failure -->");
  });
});

describe("the waiver store", () => {
  test("a leftover file at the old fixed temporary name does not block a save", () => {
    const d = tmp();
    mkdirSync(`${waiversPath(d)}.tmp`, { recursive: true });
    addWaiver(d, waiver());
    expect(listWaivers(d)).toHaveLength(1);
  });

  test("a save leaves no temporary file behind", () => {
    const d = tmp();
    addWaiver(d, waiver());
    addWaiver(d, waiver({ version: "3.0.0" }));
    expect(readdirSync(d)).toEqual(["waivers.json"]);
    expect(existsSync(waiversPath(d))).toBe(true);
  });

  test("a name and version are stored trimmed and found without the spaces", () => {
    const d = tmp();
    addWaiver(d, waiver({ name: " p ", version: " 2.0.0\n" }));
    const [w] = listWaivers(d);
    expect([w!.name, w!.version]).toEqual(["p", "2.0.0"]);
    expect(findWaiver(listWaivers(d), { eco: "npm", name: "p", version: "2.0.0", sha256: w!.sha256 })).toBeDefined();
  });

  test("a PyPI name matches in any spelling PyPI treats as one package; an npm name matches exactly", () => {
    const py = [waiver({ eco: "pypi", name: "My_Pkg.Core" })];
    const key = (name: string, eco: "npm" | "pypi") => ({ eco, name, version: "2.0.0", sha256: py[0]!.sha256 });
    expect(findWaiver(py, key("my-pkg-core", "pypi"))).toBeDefined();
    expect(findWaiver(py, key("my_pkg__core", "pypi"))).toBeDefined();
    expect(findWaiver(py, key("my-pkg-other", "pypi"))).toBeUndefined();
    const npm = [waiver({ name: "Left_Pad" })];
    expect(findWaiver(npm, { ...key("left-pad", "npm"), sha256: npm[0]!.sha256 })).toBeUndefined();
  });
});
