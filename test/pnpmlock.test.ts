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
    expect(find("@babel/core")).toMatchObject({ name: "@babel/core", version: "7.24.0", integrity: SRI("A") });
    expect(find("yaml", "2.8.1")).toMatchObject({ name: "yaml", version: "2.8.1", integrity: SRI("B") });
    expect(find("yaml", "1.10.2")).toMatchObject({ name: "yaml", version: "1.10.2", integrity: SRI("C") });
  });

  test("a sha1-only entry carries its sha1 as the integrity, for the download to check", () => {
    expect(find("old-dep")).toMatchObject({ name: "old-dep", version: "0.4.0", integrity: "sha1-qUPrMeIDqWcUgN6EdBPTCCs/AYs=" });
  });

  // Adversarial read 0.2.3 r7 (Codex 1): a pnpm tarball was checked only for its host and a sha1 integrity was dropped,
  // so ms 2.1.3 pointing at another package's tarball and its sha1 was reviewed as public ms@2.1.3 and passed.
  test("a tarball that is not the registry's own for name@version is a url dependency; every hash is carried", () => {
    const lock = (res: string) => `lockfileVersion: '9.0'\nimporters:\n  .: {}\npackages:\n  ms@2.1.3:\n    resolution: {${res}}\n`;
    const evil = "https://registry.npmjs.org/evil/-/evil-6.6.6.tgz";
    expect(parsePnpmLock(lock(`integrity: sha1-qUPrMeIDqWcUgN6EdBPTCCs/AYs=, tarball: ${evil}`))).toMatchObject([{ name: "ms", version: "2.1.3", direct: "url", source: evil }]);
    expect(parsePnpmLock(lock(`integrity: ${SRI("A")}, tarball: https://npm.corp.example/ms/-/ms-2.1.4.tgz`))).toMatchObject([{ direct: "url" }]);
    expect(parsePnpmLock(lock(`integrity: ${SRI("A")}, tarball: https://registry.npmjs.org/ms/-/ms-2.1.3.tgz`))).toEqual([{ name: "ms", version: "2.1.3", integrity: SRI("A"), source: "https://registry.npmjs.org/ms/-/ms-2.1.3.tgz", digest: SRI("A") }]);
    expect(parsePnpmLock(lock(`integrity: ${SRI("A")} sha1-qUPrMeIDqWcUgN6EdBPTCCs/AYs=`))[0]!.integrity).toBe(`${SRI("A")} sha1-qUPrMeIDqWcUgN6EdBPTCCs/AYs=`);
  });

  // Adversarial read 0.2.3 r7 (Opus): a registry entry with neither a tarball nor an integrity was skipped, so a bump
  // written that way reached no review.
  test("a registry entry with neither a tarball nor an integrity is read, marked unhashed, and never throws", () => {
    for (const res of ["{}", "{engines: {node: '>=6'}}"]) {
      expect(parsePnpmLock(`lockfileVersion: '9.0'\nimporters:\n  .: {}\npackages:\n  ms@2.1.3:\n    resolution: ${res}\n`)).toEqual([{ name: "ms", version: "2.1.3", unhashed: true }]);
    }
    expect(parsePnpmLock(`lockfileVersion: '9.0'\nimporters:\n  .: {}\npackages:\n  ms@2.1.3: {}\n`)).toEqual([{ name: "ms", version: "2.1.3", unhashed: true }]);
  });

  test("an integrity the download cannot check throws, so the PR holds", () => {
    const lock = (i: string) => `lockfileVersion: '9.0'\nimporters:\n  .: {}\npackages:\n  ms@2.1.3:\n    resolution: {integrity: '${i}'}\n`;
    for (const bad of ["md5-1B2M2Y8AsgTpgAmY7PhCfg==", "sha512-x", `${SRI("A")} x`]) expect(() => parsePnpmLock(lock(bad))).toThrow(/ms@2.1.3.*integrity/);
  });

  test("url, git and directory entries are direct, with their source; workspace links are not packages", () => {
    expect(find("@x/b")).toBeUndefined();
    expect(find("gitdep")).toMatchObject({ version: "1.0.0", direct: "url", source: "https://codeload.github.com/o/gitdep/tar.gz/0123456789abcdef0123456789abcdef01234567" });
    expect(find("repodep")).toMatchObject({ version: "1.0.0", direct: "git", source: "git+https://github.com/o/repodep.git#0123456789abcdef0123456789abcdef01234567" });
    expect(find("localdir")).toMatchObject({ direct: "file", source: "file:vendor/localdir" });
    expect(v9.filter((p) => !p.direct).length).toBe(5);
  });

  // Adversarial read 0.2.3 final (Codex 3): importers were never read, so `version: link:../payload` beside an
  // unchanged packages map was no change at all.
  test("an importer link or file: dependency outside the workspace is a direct file dep; a link to an importer is not", () => {
    const lock = `lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      a:\n        specifier: 2.0.0\n        version: link:../payload\n      w:\n        specifier: workspace:*\n        version: link:packages/w\n  packages/w:\n    devDependencies:\n      c:\n        specifier: file:../../c\n        version: file:../../c\n      d:\n        specifier: ^1.0.0\n        version: link:../../../payload\n      e:\n        specifier: ^1.0.0\n        version: 1.0.0(peer@1.0.0)\npackages: {}\n`;
    expect(parsePnpmLock(lock)).toEqual([
      { name: "a", version: "link:../payload", source: "link:../payload", direct: "file" },
      { name: "c", version: "file:c", source: "file:c", direct: "file" },
      { name: "d", version: "link:../payload", source: "link:../payload", direct: "file" },
    ]);
  });

  test("v5 and v6 importers are read too, and a single-project lockfile's top-level dependencies", () => {
    const v6 = `lockfileVersion: '6.0'\ndependencies:\n  a:\n    specifier: 2.0.0\n    version: link:../payload\n`;
    const v5 = `lockfileVersion: 5.4\nimporters:\n  .:\n    specifiers:\n      a: 2.0.0\n    dependencies:\n      a: link:../payload\n`;
    for (const l of [v6, v5]) expect(parsePnpmLock(l)).toEqual([{ name: "a", version: "link:../payload", source: "link:../payload", direct: "file" }]);
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
    expect(parsePnpmLock(await fixture("pnpm-lock-v6.yaml"))).toMatchObject(want);
  });

  test("v5: /name/version keys, _peer suffixes stripped", async () => {
    expect(parsePnpmLock(await fixture("pnpm-lock-v5.yaml"))).toMatchObject(want);
  });

  test("pnpm-lock.yaml is an npm lockfile", async () => {
    expect(parseLock("pnpm-lock.yaml", await fixture("pnpm-lock-v6.yaml")).eco).toBe("npm");
  });
});
