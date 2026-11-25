import { describe, expect, test } from "bun:test";
import { npmParts } from "../src/host/npm-line.ts";

describe("npmParts", () => {
  test("parts are split on the writers' semicolon", () => {
    expect(npmParts("FAILED — tool; upgraded: other; claude-code: 2.4.0")).toEqual(["FAILED — tool", "upgraded: other", "claude-code: 2.4.0"]);
  });
  test("the split is on the writers' semicolon and space: a bare semicolon inside a part stays in it", () => {
    expect(npmParts("upgraded: a;b; FAILED — c")).toEqual(["upgraded: a;b", "FAILED — c"]);
  });
  test("a batch hold keeps the rest of its reason whole, up to the claude-code part", () => {
    expect(npmParts("FLAGGED — FLAG: warning; ERROR — x; FAILED — y; claude-code: 2.4.0")).toEqual(["FLAGGED — FLAG: warning; ERROR — x; FAILED — y", "claude-code: 2.4.0"]);
    expect(npmParts("STRUCTURAL FLAG — a; FAILED — b")).toEqual(["STRUCTURAL FLAG — a; FAILED — b"]);
  });
  test("an off-version flag is no reason: the parts after it stay parts", () => {
    expect(npmParts("FLAGGED — a installed 1, reviewed 2; ERROR — pending query failed")).toEqual(["FLAGGED — a installed 1, reviewed 2", "ERROR — pending query failed"]);
  });
  test("a hold that merely starts like the off-version form is a hold", () => {
    expect(npmParts("FLAGGED — a installed 1, reviewed 2 and more; FAILED — z")).toEqual(["FLAGGED — a installed 1, reviewed 2 and more; FAILED — z"]);
  });
});
