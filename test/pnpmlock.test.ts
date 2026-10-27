import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { parsePnpmLock } from "../src/lockfile/pnpmlock.ts";
import { parseLock } from "../src/lockfile/index.ts";

const fixture = (f: string) => Bun.file(join(import.meta.dir, "fixtures/locks", f)).text();
const SRI = (c: string) => `sha512-${c.repeat(86)}==`;

const v9 = parsePnpmLock(await fixture("pnpm-lock-v9.yaml"));
const find = (name: string, version?: string) => v9.find((p) => p.name === name && (!version || p.version === version));

describe("parsePnpmLock v9", () => {
  test("reads scoped and plain name@version keys with their sha512 integrity", () => {
    expect(find("@babel/core")).toEqual({ name: "@babel/core", version: "7.24.0", integrity: SRI("A") });
    expect(find("yaml", "2.8.1")).toEqual({ name: "yaml", version: "2.8.1", integrity: SRI("B") });
    expect(find("yaml", "1.10.2")).toEqual({ name: "yaml", version: "1.10.2", integrity: SRI("C") });
  });

  test("a sha1-only entry is kept without an integrity", () => {
    expect(find("old-dep")).toEqual({ name: "old-dep", version: "0.4.0" });
  });

  test("skips url, git and directory entries and workspace links", () => {
    for (const n of ["gitdep", "repodep", "localdir", "@x/b"]) expect(find(n)).toBeUndefined();
    expect(v9.length).toBe(5);
  });

  test("a tarball from another registry is named by host", () => {
    expect(find("@corp/ui")).toMatchObject({ version: "3.1.0", registry: "npm.corp.example" });
  });
});

describe("older pnpm lockfiles", () => {
  const want = [
    { name: "@babel/core", version: "7.24.0", integrity: SRI("A") },
    { name: "yaml", version: "2.8.1", integrity: SRI("B") },
    { name: "@vue/runtime", version: "3.4.0", integrity: SRI("C") },
  ];

  test("v6: /name@version keys, peer suffixes in parentheses stripped", async () => {
    expect(parsePnpmLock(await fixture("pnpm-lock-v6.yaml"))).toEqual(want);
  });

  test("v5: /name/version keys, _peer suffixes stripped", async () => {
    expect(parsePnpmLock(await fixture("pnpm-lock-v5.yaml"))).toEqual(want);
  });

  test("pnpm-lock.yaml is an npm lockfile", async () => {
    expect(parseLock("pnpm-lock.yaml", await fixture("pnpm-lock-v6.yaml")).eco).toBe("npm");
  });
});
