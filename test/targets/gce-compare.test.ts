// The caller's post-check: the full installed set after the job against the one the review read bound. Only an approved
// package moving to its reviewed version is a clean change.
import { describe, expect, test } from "bun:test";
import { compareInventory } from "../../src/targets/gce/compare.ts";
import { after, CANDS, inv, OS_INFO } from "./fake-gce.ts";

const BEFORE = inv();
const NEW = "3.0.13-0ubuntu3.5";
const REVIEWED = new Map([["openssl", NEW], ["libssl3t64", NEW]]);
const post = (moves: Record<string, string | null>, over: Parameters<typeof inv>[0] = {}) => inv({ installed: after(moves), candidates: [CANDS[2]!], updateTime: "2026-10-26T03:21:00Z", ...over });
const CLEAN = { "openssl": NEW, "libssl3t64": NEW };

describe("compareInventory", () => {
  test("approved packages at their reviewed version and nothing else changed is clean", () => {
    expect(compareInventory(BEFORE, post(CLEAN), REVIEWED)).toEqual({ patched: ["libssl3t64", "openssl"], notInstalled: [], unapproved: [] });
  });

  test.each([
    ["a dependency upgraded alongside", { ...CLEAN, "bash": "5.2.21-2ubuntu5" }, ["bash 5.2.21-2ubuntu4 -> 5.2.21-2ubuntu5"]],
    ["a package added", { ...CLEAN, "libnew1": "1.0-1" }, ["libnew1 added at 1.0-1"]],
    ["a package removed", { ...CLEAN, "bash": null }, ["bash removed (was 5.2.21-2ubuntu4)"]],
    ["an approved package at another version", { ...CLEAN, "openssl": "3.0.13-0ubuntu3.6" }, ["openssl 3.0.13-0ubuntu3.4 -> 3.0.13-0ubuntu3.6 (reviewed 3.0.13-0ubuntu3.5)"]],
    ["an approved package removed", { ...CLEAN, "openssl": null }, ["openssl 3.0.13-0ubuntu3.4 -> removed (reviewed 3.0.13-0ubuntu3.5)"]],
  ])("%s is unapproved (Review Focus 5)", (_what, moves, unapproved) => {
    expect(compareInventory(BEFORE, post(moves as Record<string, string | null>), REVIEWED).unapproved).toEqual(unapproved);
  });

  test("an approved package that did not move is not installed (Review Focus 5)", () => {
    const d = compareInventory(BEFORE, post({ "openssl": NEW }), REVIEWED);
    expect(d).toEqual({ patched: ["openssl"], notInstalled: ["libssl3t64 still 3.0.13-0ubuntu3.4 (reviewed 3.0.13-0ubuntu3.5)"], unapproved: [] });
  });

  test("another instance or another OS is unapproved (Review Focus 5)", () => {
    expect(compareInventory(BEFORE, post(CLEAN, { instanceId: "1000000000000000002" }), REVIEWED).unapproved).toEqual(["instance id 1000000000000000001 -> 1000000000000000002"]);
    expect(compareInventory(BEFORE, post(CLEAN, { os: { ...OS_INFO, version: "24.10" } }), REVIEWED).unapproved).toEqual(["os ubuntu 24.04 x86_64 -> ubuntu 24.10 x86_64"]);
  });
});
