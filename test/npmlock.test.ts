import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { parseNpmLock } from "../src/lockfile/npmlock.ts";
import { parseLock } from "../src/lockfile/index.ts";

const fixture = (f: string) => Bun.file(join(import.meta.dir, "fixtures/locks", f)).text();
const SRI = (c: string) => `sha512-${c.repeat(86)}==`;

const pkgs = parseNpmLock(await fixture("package-lock-v3.json"));

describe("parseNpmLock (lockfileVersion 2 and 3)", () => {
  const find = (name: string, version?: string) => pkgs.find((p) => p.name === name && (!version || p.version === version));

  test("reads registry packages with their sha512 integrity", () => {
    expect(find("yaml", "2.8.1")).toEqual({ name: "yaml", version: "2.8.1", integrity: SRI("A") });
    expect(find("@scope/pkg")).toEqual({ name: "@scope/pkg", version: "1.0.0", integrity: SRI("E") });
  });

  test("keeps a nested second version, named by its last node_modules segment", () => {
    expect(find("yaml", "1.10.2")).toEqual({ name: "yaml", version: "1.10.2", integrity: SRI("D") });
  });

  test("an npm: alias is read under the real package name", () => {
    expect(find("my-alias")).toBeUndefined();
    expect(find("real-pkg")).toMatchObject({ version: "1.2.3" });
  });

  test("only a sha512 integrity is carried; a sha1-only entry is still reviewed, without the check", () => {
    expect(find("old-dep")).toEqual({ name: "old-dep", version: "0.4.0" });
    expect(find("legacy")?.integrity).toBe(SRI("B"));
  });

  test("skips the root, workspace links and folders, git and file deps, and bundled copies", () => {
    for (const n of ["root", "@x/b", "gitdep", "localtgz", "bundled"]) expect(find(n)).toBeUndefined();
  });

  test("a tarball from another registry is named by host; one with no resolved but an integrity is the default registry", () => {
    expect(find("@corp/ui")).toMatchObject({ version: "3.1.0", registry: "npm.corp.example" });
    expect(find("no-resolved")).toEqual({ name: "no-resolved", version: "2.0.0", integrity: SRI("D") });
  });

  test("lockfileVersion 2 reads the packages map", async () => {
    expect(parseNpmLock(await fixture("npm-shrinkwrap-v2.json"))).toEqual([{ name: "yaml", version: "2.8.1", integrity: SRI("A") }]);
  });

  test("lockfileVersion 1 throws: it has no packages map, so it is never read as empty", async () => {
    const v1 = await fixture("package-lock-v1.json");
    expect(() => parseNpmLock(v1)).toThrow(/lockfileVersion 1.*npm 7/);
  });
});

describe("lockfile names", () => {
  test("package-lock.json and npm-shrinkwrap.json are npm lockfiles", async () => {
    const text = await fixture("npm-shrinkwrap-v2.json");
    expect(parseLock("package-lock.json", text).eco).toBe("npm");
    expect(parseLock("sub/npm-shrinkwrap.json", text).pkgs.length).toBe(1);
  });
});
