import { describe, expect, test } from "bun:test";
import { parseBunLock } from "../src/adapters/ecosystem/bunlock.ts";

const LOCK = `{
  "lockfileVersion": 2,
  "workspaces": {
    "": { "name": "root", "devDependencies": { "typescript": "5.9.2", }, },
    "packages/a": { "name": "@x/a", "dependencies": { "yaml": "^2.8.0", "@x/b": "workspace:*", }, },
  },
  "packages": {
    "@x/b": ["@x/b@workspace:packages/b"],
    "typescript": ["typescript@5.9.2", "", { "bin": { "tsc": "bin/tsc" } }, "sha512-aaa"],
    "yaml": ["yaml@2.8.1", "", {}, "sha512-bbb"],
    "@scope/pkg": ["@scope/pkg@1.0.0", "", {}, "sha512-ccc"],
    "foo/yaml": ["yaml@1.10.2", "", {}, "sha512-ddd"],
    "gitdep": ["gitdep@github:o/r#abc", {}, "abc"],
  },
}`;

describe("parseBunLock", () => {
  const pkgs = parseBunLock(LOCK);

  test("returns registry packages with name and version", () => {
    expect(pkgs).toContainEqual({ name: "yaml", version: "2.8.1" });
    expect(pkgs).toContainEqual({ name: "@scope/pkg", version: "1.0.0" });
    expect(pkgs).toContainEqual({ name: "typescript", version: "5.9.2" });
  });

  test("keeps a nested second version of the same package", () => {
    expect(pkgs).toContainEqual({ name: "yaml", version: "1.10.2" });
  });

  test("skips workspace and git entries", () => {
    expect(pkgs.find((p) => p.name === "@x/b")).toBeUndefined();
    expect(pkgs.find((p) => p.name === "gitdep")).toBeUndefined();
  });

  test("dedupes identical name@version", () => {
    const twice = parseBunLock(LOCK.replace(`"@scope/pkg"`, `"dup/yaml": ["yaml@2.8.1", "", {}, "x"],\n    "@scope/pkg"`));
    expect(twice.filter((p) => p.name === "yaml" && p.version === "2.8.1").length).toBe(1);
  });
});
