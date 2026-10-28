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
    expect(find("yaml", "2.8.1")).toMatchObject({ name: "yaml", version: "2.8.1", integrity: SRI("A") });
    expect(find("@scope/pkg")).toMatchObject({ name: "@scope/pkg", version: "1.0.0", integrity: SRI("E") });
  });

  test("keeps a nested second version, named by its last node_modules segment", () => {
    expect(find("yaml", "1.10.2")).toMatchObject({ name: "yaml", version: "1.10.2", integrity: SRI("D") });
  });

  test("an npm: alias is read under the real package name", () => {
    expect(find("my-alias")).toBeUndefined();
    expect(find("real-pkg")).toMatchObject({ version: "1.2.3" });
  });

  // Adversarial read 0.2.3 final (Codex 1): only sha512 was carried, so a sha1-only entry was reviewed unchecked.
  test("every SRI hash is carried, sha1 too, for the download to be checked against all of them", () => {
    expect(find("old-dep")).toMatchObject({ name: "old-dep", version: "0.4.0", integrity: "sha1-qUPrMeIDqWcUgN6EdBPTCCs/AYs=" });
    expect(find("legacy")?.integrity).toBe(`${SRI("B")} sha1-qUPrMeIDqWcUgN6EdBPTCCs/AYs=`);
  });

  test("an integrity the gate cannot check (another algorithm, a malformed hash) throws, so the PR holds", () => {
    const lock = (integrity: string) => JSON.stringify({ lockfileVersion: 3, packages: { "": { name: "root" }, "node_modules/a": { version: "1.0.0", resolved: "https://registry.npmjs.org/a/-/a-1.0.0.tgz", integrity } } });
    for (const bad of ["md5-1B2M2Y8AsgTpgAmY7PhCfg==", "sha512-$(id)", `${SRI("A")} x`]) expect(() => parseNpmLock(lock(bad))).toThrow(/integrity/);
  });

  // Adversarial read 0.2.3 final (Codex 1): a bump whose resolved named another package's tarball was reviewed as the
  // registry's name@version while the install fetched the other one.
  test("a registry tarball that is not the canonical one for name@version is a url dependency, never a registry version", () => {
    const lock = (name: string, e: object) => JSON.stringify({ lockfileVersion: 3, packages: { "": { name: "root" }, [`node_modules/${name}`]: { version: "2.1.3", integrity: SRI("A"), ...e } } });
    const one = (name: string, resolved: string) => parseNpmLock(lock(name, { resolved }))[0];
    expect(one("ms", "https://registry.npmjs.org/ms/-/ms-2.1.3.tgz")).not.toHaveProperty("direct");
    expect(one("@s/ms", "https://registry.npmjs.org/@s/ms/-/ms-2.1.3.tgz")).not.toHaveProperty("direct");
    expect(one("@s/ms", "https://registry.npmjs.org/@s%2fms/-/ms-2.1.3.tgz")).not.toHaveProperty("direct");
    expect(one("ms", "https://registry.yarnpkg.com/ms/-/ms-2.1.3.tgz")).not.toHaveProperty("direct");
    expect(one("ms", "https://npm.corp.example/api/npm/ms/-/ms-2.1.3.tgz")).toMatchObject({ registry: "npm.corp.example" });
    for (const bad of [
      "https://registry.npmjs.org/evil/-/evil-6.6.6.tgz",
      "https://registry.npmjs.org/ms/-/ms-2.1.2.tgz",
      "https://registry.npmjs.org/x/ms/-/ms-2.1.3.tgz",
      "https://registry.npmjs.org/ms/-/ms-2.1.3.tgz?v=evil",
      "https://npm.corp.example/evil/-/evil-6.6.6.tgz",
    ]) expect([bad, one("ms", bad)]).toEqual([bad, expect.objectContaining({ direct: "url", source: bad })]);
  });

  test("skips the root and bundled copies", () => {
    for (const n of ["root", "bundled"]) expect(find(n)).toBeUndefined();
  });

  test("a link and a local folder outside node_modules are direct file deps with their path as the source", () => {
    expect(pkgs.filter((p) => p.name === "@x/b")).toEqual([
      { name: "@x/b", version: "packages/b", source: "packages/b", direct: "file" },
      { name: "@x/b", version: "0.0.1", source: "packages/b", direct: "file" },
    ]);
    const evil = JSON.stringify({ lockfileVersion: 3, packages: { "": { name: "root" }, "node_modules/evil": { resolved: "../evil", link: true }, "../evil": { name: "evil", version: "1.0.0" } } });
    expect(parseNpmLock(evil)).toEqual([
      { name: "evil", version: "../evil", source: "../evil", direct: "file" },
      { name: "evil", version: "1.0.0", source: "../evil", direct: "file" },
    ]);
  });

  test("git and file deps are direct, with their resolved as the source", () => {
    expect(find("gitdep")).toEqual({ name: "gitdep", version: "1.0.0", direct: "git", source: "git+ssh://git@github.com/o/gitdep.git#0123456789abcdef0123456789abcdef01234567" });
    expect(find("localtgz")).toMatchObject({ version: "1.0.0", direct: "file", source: "file:vendor/localtgz-1.0.0.tgz" });
  });

  test("a tarball from another registry is named by host; one with no resolved but an integrity is the default registry", () => {
    expect(find("@corp/ui")).toMatchObject({ version: "3.1.0", registry: "npm.corp.example" });
    expect(find("no-resolved")).toMatchObject({ name: "no-resolved", version: "2.0.0", integrity: SRI("D") });
  });

  // Adversarial read 0.2.3 final (Opus 1): an entry with no resolved and no integrity was read as bundled and
  // dropped, so a bump npm wrote that way reached no review while `npm ci` fetched it from the registry.
  test("only an inBundle entry is skipped; one with no resolved or integrity is read, marked unhashed, and never throws", () => {
    const lock = (e: object) => JSON.stringify({ lockfileVersion: 3, packages: { "": { name: "root" }, "node_modules/a": e, "node_modules/p": { version: "1.0.0", resolved: "https://registry.npmjs.org/p/-/p-1.0.0.tgz" }, "node_modules/p/node_modules/b": { version: "1.0.0", inBundle: true } } });
    const p = { name: "p", version: "1.0.0", source: "https://registry.npmjs.org/p/-/p-1.0.0.tgz" };
    expect(parseNpmLock(lock({ version: "2.0.0" }))).toEqual([{ name: "a", version: "2.0.0", unhashed: true }, p]);
    expect(parseNpmLock(lock({ name: "real", version: "2.0.0", dev: true }))).toEqual([{ name: "real", version: "2.0.0", unhashed: true }, p]);
    // An integrity or a resolved alone is something the install checks or fetches: not unhashed.
    expect(parseNpmLock(lock({ version: "2.0.0", integrity: SRI("A") }))[0]!.unhashed).toBeUndefined();
  });

  // Adversarial read 0.2.3 r7 (Opus a): with the root's bundleDependencies, npm marks the top-level entry and its
  // hoisted dependencies inBundle, yet `npm ci` fetches them from the registry; they were skipped, so a bump passed unreviewed.
  test("inBundle is skipped only inside a registry package's own node_modules; the root's bundled deps are packages", () => {
    const foo = { version: "2.0.0", resolved: "https://registry.npmjs.org/foo/-/foo-2.0.0.tgz", integrity: SRI("A"), inBundle: true };
    const lock = JSON.stringify({ lockfileVersion: 3, packages: { "": { name: "root", bundleDependencies: ["foo"], dependencies: { foo: "^2" } }, "node_modules/foo": foo, "node_modules/dep": { ...foo, resolved: "https://registry.npmjs.org/dep/-/dep-2.0.0.tgz" }, "packages/w": { name: "w", version: "1.0.0" }, "packages/w/node_modules/x": { ...foo, resolved: "https://registry.npmjs.org/x/-/x-2.0.0.tgz" }, "node_modules/gone/node_modules/y": { ...foo, resolved: "https://registry.npmjs.org/y/-/y-2.0.0.tgz" } } });
    expect(parseNpmLock(lock).filter((p) => !p.direct).map((p) => `${p.name}@${p.version}`)).toEqual(["foo@2.0.0", "dep@2.0.0", "x@2.0.0", "y@2.0.0"]);
  });

  test("an entry with no resolved or integrity and no registry version throws, so the PR holds", () => {
    const lock = (e: object) => JSON.stringify({ lockfileVersion: 3, packages: { "": { name: "root" }, "node_modules/a": e } });
    for (const e of [{}, { version: "github:o/a" }, { version: "latest" }]) expect(() => parseNpmLock(lock(e))).toThrow(/node_modules\/a/);
  });

  test("carries resolved and integrity as written, for a diff to see a swap", () => {
    expect(find("yaml", "2.8.1")?.digest).toBe(SRI("A"));
    expect(find("@corp/ui")?.source).toMatch(/^https:\/\/npm\.corp\.example\//);
  });

  test("lockfileVersion 2 reads the packages map", async () => {
    expect(parseNpmLock(await fixture("npm-shrinkwrap-v2.json"))).toMatchObject([{ name: "yaml", version: "2.8.1", integrity: SRI("A") }]);
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
