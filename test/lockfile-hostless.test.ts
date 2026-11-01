import { expect, test } from "bun:test";
import { pypiPrivateIndex } from "../src/lockfile/pylock.ts";
import { npmPrivateRegistry } from "../src/lockfile/types.ts";

test("a hostless url is a private index, never read as the public one", () => {
  expect(pypiPrivateIndex("file:///srv/simple")).toBeTruthy();
  expect(npmPrivateRegistry("file:///srv/npm/a/-/a-1.0.0.tgz")).toBeTruthy();
  expect(pypiPrivateIndex("https://pypi.org/simple")).toBeUndefined();
  expect(npmPrivateRegistry("https://registry.npmjs.org/a/-/a-1.0.0.tgz")).toBeUndefined();
});
