// OUP-326 item 3: pins that cannot be read are warnings (a pin read that fails must not look like "no pins").
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pinFilter, readPinFiles } from "../../src/apply/pins.ts";

const root = mkdtempSync(join(tmpdir(), "oupdate-pins-"));
const locked: string[] = [];
afterAll(() => {
  for (const p of locked) chmodSync(p, 0o755);
  rmSync(root, { recursive: true, force: true });
});
const warn = (files: ReturnType<typeof readPinFiles>) => pinFilter("brew", ["good-a"], { files }).warnings;

describe("readPinFiles: a read that fails is a warning, a file that is not there is silent", () => {
  test("a root that does not exist and a repo with no pins.json hold and warn nothing", () => {
    mkdirSync(join(root, "ok", "repo"), { recursive: true });
    expect(warn(readPinFiles([join(root, "missing"), join(root, "ok")]))).toEqual([]);
  });
  const notRoot = process.getuid?.() === 0;
  test("a pins.json that is a directory warns", () => {
    const r = join(root, "dir-pins");
    mkdirSync(join(r, "repo", "pins.json"), { recursive: true });
    const w = warn(readPinFiles([r]));
    expect(w).toHaveLength(1);
    expect(w[0]).toContain(join(r, "repo", "pins.json"));
  });
  test.skipIf(notRoot)("a root that cannot be read warns", () => {
    const r = join(root, "locked-root");
    mkdirSync(r);
    chmodSync(r, 0o000);
    locked.push(r);
    const w = warn(readPinFiles([r]));
    expect(w).toHaveLength(1);
    expect(w[0]).toContain(r);
  });
  test.skipIf(notRoot)("a repo folder that cannot be looked into warns", () => {
    const r = join(root, "locked-repo");
    mkdirSync(join(r, "repo"), { recursive: true });
    chmodSync(join(r, "repo"), 0o000);
    locked.push(join(r, "repo"));
    const w = warn(readPinFiles([r]));
    expect(w).toHaveLength(1);
    expect(w[0]).toContain(join(r, "repo", "pins.json"));
  });
});

describe("pinFilter", () => {
  const file = (text: string) => [{ repo: "r", path: "/r/pins.json", text }];
  test.each([["a list", '{"brew":["good-a"]}'], ["a string", '{"brew":"good-a"}'], ["a number", '{"brew":1}']])("a brew section that is %s warns", (_n, text) => {
    expect(pinFilter("brew", ["good-a"], { files: file(text) }).warnings).toEqual(['WARNING: /r/pins.json: "brew" is not an object, holds nothing']);
  });
  test("a missing section is silent", () => {
    expect(pinFilter("brew", ["good-a"], { files: file('{"cask":{"x":"1"}}') }).warnings).toEqual([]);
  });
  test("lookup is case-insensitive on both sides and compares the last segment", () => {
    expect(pinFilter("brew", ["foo@2"], { files: [], brewPinned: ["acme/tools/Foo@2"] }).pinned).toEqual(["foo@2(brew pin)"]);
    expect(pinFilter("brew", ["Foo@2"], { files: file('{"brew":{"acme/tools/foo@2":"1"}}') }).pinned).toEqual(["Foo@2(r)"]);
  });
});
