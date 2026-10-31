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
  test("workspace and patch entries are listed by resolution as file sources", () => {
    expect(berry.map((p) => p.name).sort()).toEqual(["@babel/core", "gitdep", "localdep", "no-sum", "real-pkg", "root", "typescript", "web", "yaml"]);
    expect(find(berry, "web")).toMatchObject({ direct: "file", version: "workspace:packages/web" });
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

describe("hostile yarn.lock", () => {
  const B = (body: string) => `__metadata:\n  version: 8\n\n${body}`;
  const npm = (loc: string, extra = "") => B(`"foo@npm:1.0.0":\n  version: 1.0.0\n  resolution: "${loc}"\n  checksum: abc\n${extra}`);
  test("a berry archive URL change shows as a different package", () => {
    const a = parseYarnLock(npm("foo@npm:1.0.0::__archiveUrl=https%3A%2F%2Fgood.test%2Fa.tgz"));
    const b = parseYarnLock(npm("foo@npm:1.0.0::__archiveUrl=https%3A%2F%2Fevil.test%2Fa.tgz"));
    expect(a[0]!.source).not.toBe(b[0]!.source);
    expect(a[0]!.direct).toBe("url");
  });
  test("a resolution that disagrees with the version throws", () => {
    expect(() => parseYarnLock(npm("foo@npm:9.9.9"))).toThrow(/does not match/);
  });
  test("a patch resolution swap shows", () => {
    const patch = (h: string) => B(`"foo@patch:foo@npm:1.0.0#./${h}.patch::version=1.0.0&hash=${h}":\n  version: 1.0.0\n  resolution: "foo@patch:foo@npm:1.0.0#./${h}.patch::version=1.0.0&hash=${h}"\n`);
    expect(parseYarnLock(patch("aaaa"))[0]!.version).not.toBe(parseYarnLock(patch("bbbb"))[0]!.version);
  });
  test("a non-string checksum throws", () => {
    expect(() => parseYarnLock(B(`"foo@npm:1.0.0":\n  version: 1.0.0\n  resolution: "foo@npm:1.0.0"\n  checksum: 111\n`))).toThrow(/checksum/);
  });
  test("a duplicate berry entry or field throws", () => {
    const e = `"foo@npm:1.0.0":\n  version: 1.0.0\n  resolution: "foo@npm:1.0.0"\n  checksum: abc\n`;
    expect(() => parseYarnLock(B(e + "\n" + e))).toThrow(/duplicate/);
    expect(() => parseYarnLock(npm("foo@npm:1.0.0", "  checksum: def\n"))).toThrow(/duplicate/);
  });
  test("a duplicate entry or field in another spelling throws", () => {
    const body = (k: string) => `${k}:\n  version: 1.0.0\n  resolution: "foo@npm:1.0.0"\n  checksum: abc\n`;
    expect(() => parseYarnLock(B(body("foo@npm:^1") + "\n" + body('"foo@npm:^1"')))).toThrow(/duplicate/);
    expect(() => parseYarnLock(npm("foo@npm:1.0.0", '  "checksum": def\n'))).toThrow(/duplicate/);
    expect(() => parseYarnLock(B('"foo@npm:^1": {version: 1.0.0}\n'))).toThrow(/cannot read/);
  });
  test("v1: deeper indentation outside a nested map, a repeated entry, mixed names, a lone quote throw", () => {
    const h = "# yarn lockfile v1\n\n";
    const e = 'foo@^1:\n  version "1.0.0"\n';
    expect(() => parseYarnLock(h + e + '    resolved "https://evil.test/a.tgz"\n')).toThrow(/indentation/);
    expect(() => parseYarnLock(h + '    garbage\n')).toThrow();
    expect(() => parseYarnLock(h + e + "\n" + e)).toThrow(/duplicate/);
    expect(() => parseYarnLock(h + 'foo@^1, bar@^1:\n  version "1.0.0"\n')).toThrow(/two packages/);
    expect(() => parseYarnLock(h + e + '  "\n')).toThrow();
    expect(parseYarnLock(h + e + '  dependencies:\n    bar "^1"\n')).toHaveLength(1);
  });
  test("v1: a quoted descriptor with a comma stays whole", () => {
    const p = parseYarnLock('# yarn lockfile v1\n\n"foo@https://host/a,b.tgz":\n  version "1.0.0"\n  resolved "https://host/a,b.tgz"\n');
    expect(p[0]).toMatchObject({ name: "foo", source: "https://host/a,b.tgz" });
  });
  test("v1: a duplicate field or odd indentation throws", () => {
    const h = "# yarn lockfile v1\n\nfoo@^1:\n  version \"1.0.0\"\n";
    expect(() => parseYarnLock(h + '  resolved "https://a/x.tgz"\n  resolved "https://b/x.tgz"\n')).toThrow(/duplicate/);
    expect(() => parseYarnLock(h + '   resolved "https://a/x.tgz"\n')).toThrow(/indentation/);
  });
});

test("yarn.lock is read as an npm lockfile by name", async () => {
  expect(parseLock("yarn.lock", await fixture("yarn-v1.lock")).eco).toBe("npm");
});
