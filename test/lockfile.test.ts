import { describe, expect, test } from "bun:test";
import { lockKind, parseLock, LOCK_NAMES } from "../src/lockfile/index.ts";

describe("parseLock", () => {
  test("picks the parser and ecosystem by base name, in any directory", () => {
    const text = `{"lockfileVersion":1,"packages":{"yaml":["yaml@2.8.1","",{},"sha512-${"X".repeat(86)}=="],}}`;
    expect(parseLock("sub/dir/bun.lock", text)).toMatchObject({ eco: "npm", pkgs: [{ name: "yaml", version: "2.8.1" }] });
    expect(LOCK_NAMES).toContain("bun.lock");
  });

  test("an unknown lockfile name throws instead of reading as no packages", () => {
    expect(() => lockKind("yarn.lock")).toThrow(/unsupported lockfile yarn.lock/);
    expect(() => parseLock("bun.lockb", "")).toThrow(/unsupported/);
  });
});
