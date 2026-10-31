import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { parseYarnLock, yarnMembers } from "../src/lockfile/yarnlock.ts";
import { parseLock } from "../src/lockfile/index.ts";

const fixture = (f: string) => Bun.file(join(import.meta.dir, "fixtures/locks", f)).text();
const SRI = (c: string) => `sha512-${c.repeat(86)}==`;
const v1 = parseYarnLock(await fixture("yarn-v1.lock"));
const berry = parseYarnLock(await fixture("yarn-berry.lock"));
const find = (l: typeof v1, name: string) => l.find((p) => p.name === name);

describe("parseYarnLock v1", () => {
  test("reads scoped and plain names, sharing one entry across ranges, with the integrity", () => {
    expect(find(v1, "@babel/core")).toMatchObject({ version: "7.24.0", integrity: SRI("A") });
    expect(v1.filter((p) => p.name === "yaml")).toMatchObject([{ version: "1.10.2", integrity: SRI("B") }]);
  });
  test("a sha1 after the resolved URL is the integrity when none is written; a bad one or none is unhashed", () => {
    expect(find(v1, "sha-only")).toMatchObject({ integrity: "sha1-qUPrMeIDqWcU3HqLHQ08CCv/AYg=", source: "https://registry.yarnpkg.com/sha-only/-/sha-only-1.0.0.tgz" });
    expect(find(v1, "old-dep")).toMatchObject({ unhashed: true });
  });
  test("an npm: alias is the real package", () => {
    expect(find(v1, "real-pkg")).toMatchObject({ version: "2.0.1" });
    expect(find(v1, "my-alias")).toBeUndefined();
  });
  test("another package's tarball is a url dependency; a git entry is a git dependency", () => {
    expect(find(v1, "evil")).toMatchObject({ direct: "url" });
    expect(find(v1, "gitdep")).toMatchObject({ direct: "git" });
  });
  test("a malformed line, a missing version or a bad integrity throws; so does a file that is neither format", () => {
    expect(() => parseYarnLock("# yarn lockfile v1\n\nfoo@^1:\n  resolved \"x\"\n")).toThrow(/no version/);
    expect(() => parseYarnLock("# yarn lockfile v1\n\nfoo bar\n")).toThrow(/cannot read yarn.lock line/);
    expect(() => parseYarnLock('# yarn lockfile v1\n\nfoo@^1:\n  version "1.0.0"\n  resolved "https://registry.yarnpkg.com/foo/-/foo-1.0.0.tgz"\n  integrity md5-zzz\n')).toThrow(/cannot read foo@1.0.0/);
    expect(() => parseYarnLock("nothing here")).toThrow(/neither/);
  });
  test("a lockfile with no packages reads empty", () => {
    expect(parseYarnLock("# yarn lockfile v1\n\n\n")).toEqual([]);
  });
});

describe("parseYarnLock berry", () => {
  test("reads npm entries with the checksum as the digest, never as an integrity to check", () => {
    expect(find(berry, "@babel/core")).toEqual({ name: "@babel/core", version: "7.24.0", digest: "10c0/aaaa" });
    expect(berry.filter((p) => p.name === "yaml")).toHaveLength(1);
  });
  test("an alias is the real package; an entry with no checksum is unhashed", () => {
    expect(find(berry, "real-pkg")).toMatchObject({ version: "2.0.1" });
    expect(find(berry, "no-sum")).toMatchObject({ unhashed: true });
  });
  test("workspace and patch entries are the project's own and are skipped", () => {
    expect(berry.map((p) => p.name).sort()).toEqual(["@babel/core", "gitdep", "localdep", "no-sum", "real-pkg", "yaml"]);
  });
  test("git and file sources are direct dependencies", () => {
    expect(find(berry, "gitdep")).toMatchObject({ direct: "git" });
    expect(find(berry, "localdep")).toMatchObject({ direct: "file" });
  });
  test("workspace folders are the members", async () => {
    expect(yarnMembers(await fixture("yarn-berry.lock"))).toEqual(["packages/web"]);
    expect(yarnMembers(await fixture("yarn-v1.lock"))).toEqual([]);
  });
  test("an entry with no resolution throws", () => {
    expect(() => parseYarnLock("__metadata:\n  version: 8\n\n\"a@npm:1\":\n  version: 1.0.0\n")).toThrow(/no resolution/);
  });
});

test("yarn.lock is read as an npm lockfile by name", async () => {
  expect(parseLock("yarn.lock", await fixture("yarn-v1.lock")).eco).toBe("npm");
});
