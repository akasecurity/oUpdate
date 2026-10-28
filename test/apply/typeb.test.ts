// Ported from the previous updater's tap-approval and Type B cases: the review routing,
// the install-time tap pin, the off-tap dependency gate and the advisory review of unapproved taps.
import { afterAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { awaitingTapApproval, offTapDepsCurrent, tapUnchangedSinceReview, typeBReview, typeBUpgrades, type TypeBOptions } from "../../src/apply/typeb.ts";
import type { Reviewer } from "../../src/review.ts";
import { scripted } from "./helpers.ts";
import { APPROVE, cleanupFixtures, fixture, git, OFFICIAL, SOURCE, TAP, type Fx } from "./tap-fixture.ts";

afterAll(cleanupFixtures);

const FLAG = 'FLAG\n1. FLAG: "(var/\\"tool\\").mkpath" indicator 5';

function opts() {
  const notices: string[] = [];
  const o: TypeBOptions = { officialTaps: OFFICIAL, host: "fixture", notify: (t) => void notices.push(t) };
  return { o, notices };
}

async function upgradeRun(f: Fx, r: Reviewer, extra: { dryRun?: boolean; upgradeRc?: number } = {}) {
  const fx = fixture(f);
  const { o, notices } = opts();
  const upgrades: string[] = [];
  const run = await typeBUpgrades(fx.env, r, [{ pkg: "tool", tap: TAP }], {
    ...o, dryRun: extra.dryRun ?? false, upgrade: async (n) => (upgrades.push(n), extra.upgradeRc ?? 0),
  });
  return { run, upgrades, notices, fx };
}

describe("typeBReview", () => {
  test("versions that cannot be read → rc 2, no reviewer call", async () => {
    const fx = fixture({ installed: "" });
    const { r, prompts } = scripted([], APPROVE);
    const v = await typeBReview(fx.env, r, "tool", TAP, opts().o);
    expect(v.rc).toBe(2);
    expect(prompts).toHaveLength(0);
    expect(v.log[0]).toBe("tool: could not read versions (old= new=1.1) — FLAG");
  });
  test("a prebuilt formula APPROVEd → rc 0, kind formula-only, prebuilt, the pin recorded", async () => {
    const fx = fixture();
    const { r } = scripted([], APPROVE);
    const v = await typeBReview(fx.env, r, "tool", TAP, opts().o);
    expect(v).toMatchObject({ rc: 0, kind: "formula-only, prebuilt" });
    expect(v.pin).toEqual({ pkg: "tool", tapDir: fx.tap, head: fx.head, rbPath: "Formula/tool.rb" });
  });
  test("a FLAG reports its kind; a review that could not be made reports none", async () => {
    const { r } = scripted([FLAG]);
    expect(await typeBReview(fixture().env, r, "tool", TAP, opts().o)).toMatchObject({ rc: 1, kind: "formula-only, prebuilt" });
    const v = await typeBReview(fixture({ rbPath: "Formula/missing.rb" }).env, scripted([], APPROVE).r, "tool", TAP, opts().o);
    expect(v.rc).toBe(2);
    expect(v.kind).toBeUndefined();
  });
  test("a source-built package is held after its formula APPROVEs: the source review is not in this version", async () => {
    const fx = fixture({ oldUrl: SOURCE("1.0"), newUrl: SOURCE("1.1") });
    const { o, notices } = opts();
    const v = await typeBReview(fx.env, scripted([], APPROVE).r, "tool", TAP, o);
    expect(v.rc).toBe(2);
    expect(v.pin).toBeUndefined();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("source-built: the source diff review is not in this oupdate version — held for manual review");
  });
});

describe("typeBUpgrades", () => {
  test("an approved tap whose review APPROVEs is upgraded", async () => {
    const { run, upgrades } = await upgradeRun({}, scripted([], APPROVE).r);
    expect(upgrades).toEqual([`${TAP}/tool`]);
    expect(run).toMatchObject({ upgraded: ["tool"], upgradedFull: [`${TAP}/tool`], flagged: false, failed: [] });
  });
  test("an approved tap whose review FLAGs is not upgraded", async () => {
    const { run, upgrades } = await upgradeRun({}, scripted([FLAG]).r);
    expect(upgrades).toEqual([]);
    expect(run.flagged).toBe(true);
  });
  test("dry-run reviews and changes nothing", async () => {
    const { run, upgrades } = await upgradeRun({}, scripted([], APPROVE).r, { dryRun: true });
    expect(upgrades).toEqual([]);
    expect(run.log).toContain("  dry-run: would upgrade tool");
  });
  test("a failed brew upgrade is recorded as failed, flagged, logged and notified", async () => {
    const { run, notices } = await upgradeRun({}, scripted([], APPROVE).r, { upgradeRc: 1 });
    expect(run).toMatchObject({ upgraded: [], failed: ["tool"], flagged: true });
    expect(run.log).toContain("  tool: upgrade FAILED — continuing");
    expect(notices.at(-1)).toBe("fixture brew FAILED: tool; log: -");
  });
  test("a HEAD install is held without a review", async () => {
    const { r, prompts } = scripted([], APPROVE);
    const { run, upgrades, notices } = await upgradeRun({ installed: "tool HEAD-abc1234" }, r);
    expect(prompts).toHaveLength(0);
    expect(upgrades).toEqual([]);
    expect(run.flagged).toBe(true);
    expect(notices[0]).toStartWith("⚠️ <b>fixture Type B FLAG — tool (HEAD)</b>");
  });
  // A reviewer that changes the tap while it reviews: the change lands after the HEAD was pinned.
  const mutating = (change: (tap: string) => void): { r: Reviewer; tap: { dir?: string } } => {
    const tap: { dir?: string } = {};
    return { tap, r: { name: "m", review: async () => (change(tap.dir!), APPROVE) } };
  };
  for (const [label, change, reason] of [
    ["the tap HEAD moved", (t: string) => { writeFileSync(join(t, "Formula/helper.rb"), "class Helper < Formula\nend\n# moved\n"); git(t, "commit", "-qam", "moved"); }, "tap HEAD moved"],
    ["the formula edited in the working tree", (t: string) => writeFileSync(join(t, "Formula/tool.rb"), "# dirty\n"), "uncommitted or untracked changes in the tap"],
    ["an untracked file anywhere in the tap", (t: string) => writeFileSync(join(t, "new.rb"), "x = 1\n"), "uncommitted or untracked changes in the tap"],
  ] as const) {
    test(`I2/Mc ${label} after the review → not upgraded`, async () => {
      const m = mutating(change);
      const fx = fixture();
      m.tap.dir = fx.tap;
      const { o, notices } = opts();
      const upgrades: string[] = [];
      const run = await typeBUpgrades(fx.env, m.r, [{ pkg: "tool", tap: TAP }], { ...o, dryRun: false, upgrade: async (n) => (upgrades.push(n), 0) });
      expect(upgrades).toEqual([]);
      expect(run.flagged).toBe(true);
      expect(notices.at(-1)).toContain(`tap changed after review (${reason}`);
    });
  }
  test("off-tap: an outdated off-tap dependency → not upgraded, named", async () => {
    const { run, upgrades, notices } = await upgradeRun({ deps: "openssl@3 evil/tap/libx", outdated: { "evil/tap/libx": "evil/tap/libx\n" } }, scripted([], APPROVE).r);
    expect(upgrades).toEqual([]);
    expect(run.flagged).toBe(true);
    expect(notices.at(-1)).toContain("off-tap dependency outdated and not reviewed this run: evil/tap/libx");
  });
  test("off-tap: an up-to-date off-tap dependency, or an outdated core one, does not hold", async () => {
    const { upgrades } = await upgradeRun({ deps: "openssl@3 evil/tap/libx Homebrew/Core/zlib", outdated: { "openssl@3": "openssl@3\n", "Homebrew/Core/zlib": "Homebrew/Core/zlib\n" } }, scripted([], APPROVE).r);
    expect(upgrades).toEqual([`${TAP}/tool`]);
  });
});

describe("offTapDepsCurrent", () => {
  const check = async (f: Fx, done: string[]) => {
    const fx = fixture(f);
    const { o, notices } = opts();
    const log: string[] = [];
    return { ok: await offTapDepsCurrent(fx.env, "tool", TAP, done, o, log), notices, log };
  };
  test("R3 a core xz upgraded earlier does not excuse an outdated x/tap/xz; the same full name does", async () => {
    const f: Fx = { deps: "x/tap/xz", outdated: { "x/tap/xz": "x/tap/xz\n" } };
    expect((await check(f, ["xz"])).ok).toBe(false);
    expect((await check(f, ["x/tap/xz"])).ok).toBe(true);
  });
  test("Rm brew outdated erroring on an off-tap dependency fails closed", async () => {
    const v = await check({ deps: "evil/tap/libx", outdated: { "evil/tap/libx": new Error("rc 1") } }, []);
    expect(v.ok).toBe(false);
    expect(v.notices[0]).toContain("could not check whether evil/tap/libx is outdated (brew outdated rc 1)");
  });
  test("a dependency list that cannot be read fails closed", async () => {
    const v = await check({ deps: new Error("rc 1") }, []);
    expect(v.ok).toBe(false);
    expect(v.notices[0]).toContain("could not list its installed dependencies");
  });
});

describe("tapUnchangedSinceReview", () => {
  test("no pin, or a pin for another package → not upgraded", async () => {
    const fx = fixture();
    const { o, notices } = opts();
    expect(await tapUnchangedSinceReview(fx.env, "tool", undefined, o, [])).toBe(false);
    expect(await tapUnchangedSinceReview(fx.env, "tool", { pkg: "other", tapDir: fx.tap, head: fx.head, rbPath: "Formula/tool.rb" }, o, [])).toBe(false);
    expect(notices[0]).toContain("no reviewed tap state recorded for tool");
    expect(await tapUnchangedSinceReview(fx.env, "tool", { pkg: "tool", tapDir: fx.tap, head: fx.head, rbPath: "Formula/tool.rb" }, o, [])).toBe(true);
  });
});

describe("awaitingTapApproval", () => {
  const VERBOSE = `${TAP}/tool (1.0) < 1.1\nexample/tf/tfapp (1.5) < 1.6\n`;
  for (const [label, answer, want] of [
    ["APPROVE", APPROVE, "APPROVE (formula-only, prebuilt)"],
    ["FLAG", FLAG, "FLAG (formula-only, prebuilt)"],
  ] as const) {
    test(`an unapproved tap gets an advisory review (${label}), never installed, notices only logged`, async () => {
      const fx = fixture();
      const { o, notices } = opts();
      const v = await awaitingTapApproval(fx.env, scripted([], answer).r, [{ pkg: "tool", tap: TAP }], [{ pkg: "tfapp", tap: "example/tf" }], VERBOSE, o);
      expect(v.items).toBe(`${TAP} (tool 1.0→1.1, review: ${want}); example/tf (tfapp 1.5→1.6, review: n/a (cask))`);
      expect(notices).toEqual([]);
      if (label === "FLAG") expect(v.log).toContain("[advisory — not notified] ⚠️ fixture Type B FLAG — tool (formula)");
    });
  }
  test("a review that could not be made is n/a with no kind", async () => {
    const fx = fixture({ installed: "" });
    const v = await awaitingTapApproval(fx.env, scripted([], APPROVE).r, [{ pkg: "tool", tap: TAP }], [], VERBOSE, opts().o);
    expect(v.items).toBe(`${TAP} (tool 1.0→1.1, review: n/a)`);
  });
  test("an unresolved cask tap is named as such", async () => {
    const v = await awaitingTapApproval(fixture().env, scripted([], APPROVE).r, [], [{ pkg: "app", tap: "tap-unresolved" }], "app (1) < 2\n", opts().o);
    expect(v.items).toBe("(unresolved tap) (app 1→2, review: n/a (cask))");
  });
  test("C an advisory review, then a real Type B FLAG in the same run: the real one is notified", async () => {
    const fx = fixture();
    const { o, notices } = opts();
    await awaitingTapApproval(fx.env, scripted([], FLAG).r, [{ pkg: "tool", tap: TAP }], [], VERBOSE, o);
    expect(notices).toEqual([]);
    await typeBUpgrades(fx.env, scripted([], FLAG).r, [{ pkg: "tool", tap: TAP }], { ...o, dryRun: false, upgrade: async () => 0 });
    expect(notices.some((n) => n.startsWith("⚠️ <b>fixture Type B FLAG — tool (formula)</b>"))).toBe(true);
  });
});
