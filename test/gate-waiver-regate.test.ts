import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gateWaivers, loadReviewWaivers, parseReviewArgs } from "../src/cli.ts";
import { MARKER, runGate, verdictLine, type Change } from "../src/gate.ts";
import type { Forge, Pull, StatusState } from "../src/adapters/forge/types.ts";
import type { ReviewResult } from "../src/review.ts";
import { addWaiver, findWaiver, saveWaivers, listWaivers, removeWaiver, sha256Hex, waiverFingerprint, waiversFor, waiversPath, type Waiver } from "../src/waiver.ts";

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
function forgeWith(state: StatusState, line: string, fileset: Record<string, string> = files) {
  const pr: Pull = { number: 1, headRef: "renovate/yaml", headSha: "h1", baseSha: "b", author: "renovate[bot]", headRepo: "o/r", baseRepo: "o/r" };
  let status: StatusState = state;
  let body = `${MARKER}\n${line}\n`;
  const forge: Forge = {
    self: async () => "gate",
    openPulls: async () => [pr],
    readFile: async (_r, sha, path) => fileset[`${sha}:${path}`],
    changedFiles: async () => ["bun.lock"],
    statusOf: async () => ({ state: status, creator: "gate" }),
    setStatus: async (_r, _s, s) => void (status = s.state),
    ownComment: async () => body,
    upsertComment: async (_r, _n, _m, b) => void (body = b),
  };
  return { forge, body: () => body };
}
const result = (c: Change, decision: "land" | "hold"): ReviewResult => ({ eco: c.eco, name: c.name, from: c.from ?? "", to: c.to, decision, layers: decision === "hold" ? [{ layer: "reviewer", verdict: "stop", detail: "binary file(s) engine.wasm" }] : [], flagged: false } as unknown as ReviewResult);

/** A waiver for the one package change these PRs carry (yaml 2.8.1 -> 2.8.3), and the line a verdict reached under it records. */
const mine = (over: Partial<Waiver> = {}) => waiver({ name: "yaml", version: "2.8.3", ...over });
const line = (state: StatusState, ...list: Waiver[]) => verdictLine("h1", state, list.length ? waiverFingerprint(list) : undefined);

describe("a verdict is kept only while the waivers that apply to the PR's packages are unchanged", () => {
  const hold = async (c: Change) => result(c, "hold");

  test("the same relevant waivers keep the final verdict, with no review", async () => {
    const { forge } = forgeWith("failure", line("failure", mine()));
    const seen: string[] = [];
    const out = await runGate({ forge, repo: "o/r", waivers: [mine()], review: async (c) => (seen.push(c.name), result(c, "hold")) });
    expect(out.map((p) => p.state)).toEqual(["skipped"]);
    expect(seen).toEqual([]);
  });

  test("a waiver for a package in the PR, added after a plain-line hold, re-gates it, and the landing records the fingerprint", async () => {
    const { forge, body } = forgeWith("failure", line("failure"));
    const seen: string[] = [];
    const out = await runGate({ forge, repo: "o/r", waivers: [mine()], review: async (c) => (seen.push(c.name), result(c, "land")) });
    expect(seen).toEqual(["yaml"]);
    expect(out.map((p) => p.state)).toEqual(["success"]);
    expect(body()).toContain(line("success", mine()));
  });

  test("a relevant waiver removed after a landing recorded with its fingerprint re-gates, and a hold fails closed", async () => {
    const { forge, body } = forgeWith("success", line("success", mine()));
    const out = await runGate({ forge, repo: "o/r", waivers: [], review: hold });
    expect(out.map((p) => p.state)).toEqual(["failure"]);
    expect(body()).toContain(line("failure"));
    expect(body()).not.toContain("waivers:");
  });

  test("a waiver for another package, another version or another ecosystem is not relevant: adding or removing it keeps the verdict", async () => {
    const others = [waiver({ name: "left-pad", version: "1.0.0" }), mine({ version: "2.8.4" }), mine({ eco: "pypi" })];
    for (const [state, kept] of [["failure", line("failure")], ["success", line("success")]] as const) {
      for (const list of [undefined, [], others]) {
        const { forge } = forgeWith(state, kept);
        const out = await runGate({ forge, repo: "o/r", waivers: list, review: async (c) => { throw new Error(`reviewed ${c.name}`); } });
        expect(out.map((p) => p.state)).toEqual(["skipped"]);
      }
    }
    // and the same from the other side: a verdict recorded under a relevant waiver does not stand once only unrelated ones are left
    const { forge } = forgeWith("failure", line("failure", mine()));
    const seen: string[] = [];
    await runGate({ forge, repo: "o/r", waivers: others, review: async (c) => (seen.push(c.name), result(c, "hold")) });
    expect(seen).toEqual(["yaml"]);
  });

  test("a hold written before fingerprints existed is reviewed again once a relevant waiver is in the store, and only then", async () => {
    const { forge } = forgeWith("failure", line("failure"));
    const seen: string[] = [];
    await runGate({ forge, repo: "o/r", waivers: [mine()], review: async (c) => (seen.push(c.name), result(c, "hold")) });
    expect(seen).toEqual(["yaml"]);
    const again: string[] = [];
    const fresh = forgeWith("failure", line("failure"));
    await runGate({ forge: fresh.forge, repo: "o/r", waivers: [], review: async (c) => (again.push(c.name), result(c, "hold")) });
    expect(again).toEqual([]); // an empty store changes nothing after an upgrade
  });

  test("relevance reads names as the store does: trimmed, and PyPI spellings as one package", async () => {
    const trimmed = mine({ name: " yaml ", version: " 2.8.3 " });
    const { forge } = forgeWith("failure", line("failure"));
    const seen: string[] = [];
    await runGate({ forge, repo: "o/r", waivers: [trimmed], review: async (c) => (seen.push(c.name), result(c, "hold")) });
    expect(seen).toEqual(["yaml"]); // a waiver typed with spaces still applies, so the plain-line hold is reviewed again
    expect(waiversFor([waiver({ eco: "pypi", name: "My_Pkg.Core", version: "1.0" })], [{ eco: "pypi", name: "my-pkg-core", version: "1.0" }])).toHaveLength(1);
    expect(waiversFor([waiver({ eco: "pypi", name: "My_Pkg.Core", version: "1.0" })], [{ eco: "pypi", name: "my-pkg-other", version: "1.0" }])).toHaveLength(0);
    expect(waiversFor([waiver({ name: "Left_Pad", version: "1.0" })], [{ eco: "npm", name: "left-pad", version: "1.0" }])).toHaveLength(0); // npm names match exactly
  });

  test("a PR with no relevant waiver is written with the plain line, whatever the store holds", async () => {
    for (const list of [undefined, [], [waiver({ name: "left-pad", version: "1.0.0" })]]) {
      const { forge, body } = forgeWith("failure", verdictLine("h0", "failure"));
      await runGate({ forge, repo: "o/r", waivers: list, review: hold });
      expect(body()).toContain("<!-- oupdate-verdict: h1 failure -->");
    }
  });

  test("a read of the lockfile that fails for a PR with a final verdict does not keep the verdict by guesswork: the PR is held and says why", async () => {
    const { forge } = forgeWith("failure", line("failure"));
    const broken = { ...forge, readFile: async () => { throw new Error("forge unreachable"); } } as Forge;
    const out = await runGate({ forge: broken, repo: "o/r", waivers: [waiver({ name: "left-pad", version: "1.0.0" })], review: hold }); // a store with a waiver: the packages must be read to know it does not apply
    expect(out.map((p) => p.state)).toEqual(["pending"]);
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

  test("a save whose rename fails removes its temporary file and reports the error", () => {
    const d = tmp();
    addWaiver(d, waiver());
    const before = readdirSync(d);
    expect(() => saveWaivers(d, [], () => { throw new Error("rename failed"); })).toThrow("rename failed");
    expect(readdirSync(d)).toEqual(before);
    expect(listWaivers(d)).toHaveLength(1); // the store is untouched
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

describe("a review uses the list a gate run read", () => {
  test("a list given to a review is the one it uses, whatever the store holds later", () => {
    const d = tmp();
    addWaiver(d, waiver());
    const given = listWaivers(d);
    addWaiver(d, waiver({ name: "q" })); // added while the run is going
    const review = parseReviewArgs(["npm", "p", "1.0.0", "2.0.0"]);
    review.stateDir = d;
    review.waivers = given;
    expect(loadReviewWaivers(review)).toHaveLength(1); // the store now has two; the review still uses the list the run read
    expect(loadReviewWaivers({ ...review, waivers: undefined })).toHaveLength(2);
  });
});

describe("remove finds a waiver by the key as typed, spaces and all", () => {
  test("a key with spaces around the name and version removes the stored record", () => {
    const d = tmp();
    addWaiver(d, waiver());
    const key = { eco: "npm" as const, name: " p ", version: "\t2.0.0 ", sha256: waiver().sha256 };
    expect(removeWaiver(d, key)).toBe(1);
    expect(listWaivers(d)).toEqual([]);
  });
});

describe("keeping a verdict with no waivers reads no lockfile", () => {
  for (const [label, list] of [["no store", undefined], ["an empty store", []]] as [string, Waiver[] | undefined][]) {
    for (const state of ["success", "failure"] as const) {
      test(`a kept ${state} with ${label} makes no lockfile read and survives a failing read`, async () => {
        const { forge } = forgeWith(state, line(state));
        let reads = 0, listed = 0;
        const counted: Forge = { ...forge, readFile: async () => { reads++; throw new Error("forge unreachable"); }, changedFiles: async () => { listed++; throw new Error("forge unreachable"); } };
        const out = await runGate({ forge: counted, repo: "o/r", waivers: list, review: async (c) => { throw new Error(`reviewed ${c.name}`); } });
        expect(out.map((p) => p.state)).toEqual(["skipped"]);
        expect([reads, listed]).toEqual([0, 0]);
      });
    }
  }

  test("a final verdict whose comment is missing, or names another head, is still reviewed", async () => {
    const { forge } = forgeWith("failure", verdictLine("h0", "failure"));
    const seen: string[] = [];
    await runGate({ forge, repo: "o/r", review: async (c) => (seen.push(c.name), result(c, "hold")) });
    expect(seen).toEqual(["yaml"]);
  });
});

describe("a gate run reads the waiver store at the start", () => {
  test("no state dir means no list; a state dir gives its list", () => {
    expect(gateWaivers({})).toBeUndefined();
    const d = tmp();
    expect(gateWaivers({ stateDir: d })).toEqual([]);
    addWaiver(d, waiver());
    expect(gateWaivers({ stateDir: d })).toHaveLength(1);
  });

  test("a damaged waivers.json fails the read, naming the file, so the run stops before any pull request", () => {
    const d = tmp();
    writeFileSync(waiversPath(d), "x");
    expect(() => gateWaivers({ stateDir: d })).toThrow(/waivers\.json/);
    writeFileSync(waiversPath(d), "{}");
    expect(() => gateWaivers({ stateDir: d })).toThrow(/waivers\.json/);
  });
});
