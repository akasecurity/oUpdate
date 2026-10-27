import { describe, expect, test } from "bun:test";
import { parseBunLock } from "../src/lockfile/bunlock.ts";

const LOCK = `{
  "lockfileVersion": 2,
  "workspaces": {
    "": { "name": "root", "devDependencies": { "typescript": "5.9.2", }, },
    "packages/a": { "name": "@x/a", "dependencies": { "yaml": "^2.8.0", "@x/b": "workspace:*", }, },
  },
  "packages": {
    "@x/b": ["@x/b@workspace:packages/b"],
    "typescript": ["typescript@5.9.2", "", { "bin": { "tsc": "bin/tsc" } }, "sha512-aaa"],
    "yaml": ["yaml@2.8.1", "", {}, "sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=="],
    "@scope/pkg": ["@scope/pkg@1.0.0", "", {}, "sha512-ccc"],
    "foo/yaml": ["yaml@1.10.2", "", {}, "sha512-ddd"],
    "gitdep": ["gitdep@github:o/r#abc", {}, "abc"],
    "@corp/ui": ["@corp/ui@3.1.0", "https://npm.corp.example/", {}, "sha512-eee"],
    "left-pad": ["left-pad@1.3.0", "https://registry.npmjs.org/", {}, "sha512-fff"],
  },
}`;

describe("parseBunLock", () => {
  const pkgs = parseBunLock(LOCK);

  test("returns registry packages with name and version", () => {
    expect(pkgs).toContainEqual({ name: "yaml", version: "2.8.1", integrity: "sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==" });
    expect(pkgs).toContainEqual({ name: "@scope/pkg", version: "1.0.0" });
    expect(pkgs).toContainEqual({ name: "typescript", version: "5.9.2" });
  });

  test("carries a full sha512 SRI as the integrity; anything else (short, sha1) is left out", () => {
    expect(pkgs.find((p) => p.name === "yaml" && p.version === "2.8.1")?.integrity).toBe("sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==");
    expect(pkgs.find((p) => p.name === "typescript")?.integrity).toBeUndefined();
  });

  test("names a non-default registry by host; the default one (empty or npmjs) is left out", () => {
    expect(pkgs.find((p) => p.name === "@corp/ui")?.registry).toBe("npm.corp.example");
    expect(pkgs.find((p) => p.name === "left-pad")?.registry).toBeUndefined();
    expect(pkgs.find((p) => p.name === "typescript")?.registry).toBeUndefined();
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
