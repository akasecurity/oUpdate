// The os-packages review: the broker's origin verdict, the cooldown from first sight, the 200-name cap,
// then both models on a fenced prompt that carries only checked names and versions.
import { describe, expect, test } from "bun:test";
import { pkgKey } from "../../src/targets/gce/answer.ts";
import { aptPrompt, aptRules, packageLine, reviewApt } from "../../src/targets/gce/review.ts";
import { inv } from "./fake-gce.ts";
import { fakeReviewer } from "./fake-nas.ts";

const NOW = new Date("2026-10-26T03:00:00Z");
const DAYS_AGO = (d: number) => new Date(NOW.getTime() - d * 86_400_000);
const firstAll = (i: ReturnType<typeof inv>, d: Date) => new Map(i.candidates.map((c) => [pkgKey(c), d]));

describe("aptRules", () => {
  test("security-pocket candidates past the cooldown are eligible; the broker's holds stay held", () => {
    const i = inv();
    const r = aptRules(i, firstAll(i, DAYS_AGO(3)), NOW, 2);
    expect(r.eligible.map(pkgKey)).toEqual(["openssl", "libssl3t64"]);
    expect(r.held).toEqual([{ key: "curl", why: "broker: the candidate is newer than the security index lists" }]);
  });

  test("a candidate first seen inside the cooldown is held; cooldown 0 holds nothing", () => {
    const i = inv();
    expect(aptRules(i, firstAll(i, DAYS_AGO(1)), NOW, 2).held.map((h) => h.why)).toEqual(["cooldown: 24.0 h old, cooldown 2 d", "cooldown: 24.0 h old, cooldown 2 d", "broker: the candidate is newer than the security index lists"]);
    expect(aptRules(i, firstAll(i, NOW), NOW, 0).eligible).toHaveLength(2);
  });

  test("at most 200 names go in one job; the rest wait", () => {
    const names = Array.from({ length: 201 }, (_, n) => `pkg-${String(n).padStart(3, "0")}`);
    const i = inv({ installed: names.map((n) => [n, "1.0-1"]), candidates: names.map((n) => ({ name: n, installed: "1.0-1", available: "1.0-2" })) });
    const r = aptRules(i, firstAll(i, DAYS_AGO(3)), NOW, 2);
    expect(r.eligible).toHaveLength(200);
    expect(r.held).toEqual([{ key: "pkg-200", why: "over the 200-name job cap; next run" }]);
  });
});

describe("aptPrompt and reviewApt", () => {
  test("every package line sits inside the untrusted-data fence, after the verdict contract (Review Focus 2)", () => {
    const i = inv();
    const p = aptPrompt({ vm: "vm-a", os: "ubuntu 24.04", packages: i.candidates.slice(0, 2) });
    expect(packageLine(i.candidates[1]!)).toBe("libssl3t64 3.0.13-0ubuntu3.4 -> 3.0.13-0ubuntu3.5 (noble-security)");
    const fence = p.slice(p.indexOf("<<<BEGIN UNTRUSTED DATA: packages>>>"), p.indexOf("<<<END UNTRUSTED DATA: packages>>>"));
    expect(fence).toContain("| openssl 3.0.13-0ubuntu3.4 -> 3.0.13-0ubuntu3.5 (noble-security)");
    expect(fence.split("\n").slice(1).every((l) => l.startsWith("|") || l === "")).toBe(true);
    expect(p.indexOf("Output format:")).toBeLessThan(p.indexOf("<<<BEGIN UNTRUSTED DATA: vm>>>"));
    expect(p).not.toContain("the candidate is newer");
  });

  test("both models must approve; a primary FLAG never asks the second model", async () => {
    const primary = fakeReviewer("first-model", "APPROVE");
    const secondary = fakeReviewer("secondary-model", "FLAG\n1. openssl changes upstream");
    expect(await reviewApt({ primary: primary.reviewer, secondary: secondary.reviewer }, "p")).toMatchObject({ primary: "APPROVE", secondary: "FLAG", approved: false });
    const flag = fakeReviewer("first-model", "FLAG\nno");
    const unused = fakeReviewer("secondary-model", "APPROVE");
    expect(await reviewApt({ primary: flag.reviewer, secondary: unused.reviewer }, "p")).toMatchObject({ primary: "FLAG", secondary: "not asked", approved: false });
    expect(unused.prompts).toHaveLength(0);
    const ok = await reviewApt({ primary: fakeReviewer("r", "APPROVE").reviewer, secondary: fakeReviewer("o", "APPROVE").reviewer }, "p");
    expect(ok.approved).toBe(true);
  });
});
