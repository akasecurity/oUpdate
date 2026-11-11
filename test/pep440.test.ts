import { describe, expect, test } from "bun:test";
import { normalizeVersion } from "../src/pep440.ts";

describe("normalizeVersion", () => {
  const same: [string, string][] = [
    ["1.0", "1.0.0"],
    ["1", "1.0.0.0"],
    ["1.0-1", "1.0.post1"],
    ["1.0.post", "1.0-post0"],
    ["1.0RC1", "1.0rc1"],
    ["1.0c1", "1.0pre1"],
    ["1.0alpha", "1.0a0"],
    ["v1.0", "1.0"],
    ["1.0.dev", "1.0-dev0"],
    ["0!1.0", "1.0"],
    ["1.0+Ubuntu-1", "1.0+ubuntu.1"],
    [" 1.0 ", "1.0"],
    ["1.007", "1.7"],
  ];
  for (const [a, b] of same) test(`${a} is ${b}`, () => expect(normalizeVersion(a)).toBe(normalizeVersion(b)!));

  const different: [string, string][] = [
    ["1.0", "1.0.1"],
    ["1.0", "1.0.post1"],
    ["1.0", "1.0rc1"],
    ["1.0", "1!1.0"],
    ["1.0.post1", "2.post1"],
    ["1.0+a", "1.0"],
    ["10", "1"],
  ];
  for (const [a, b] of different) test(`${a} is not ${b}`, () => expect(normalizeVersion(a)).not.toBe(normalizeVersion(b)));

  test("a string that is no version is undefined", () => {
    for (const bad of ["", "one", "1.", "1..0", "1.0.tar", "1.0/../2", "x1", "1.0 2.0"]) expect(normalizeVersion(bad)).toBeUndefined();
  });
});
