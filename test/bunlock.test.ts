import { describe, expect, test } from "bun:test";
import { parseBunLock } from "../src/lockfile/bunlock.ts";
import { diffLocks } from "../src/lockdiff.ts";

const LOCK = `{
  "lockfileVersion": 2,
  "workspaces": {
    "": { "name": "root", "devDependencies": { "typescript": "5.9.2", }, },
    "packages/a": { "name": "@x/a", "dependencies": { "yaml": "^2.8.0", "@x/b": "workspace:*", }, },
  },
  "packages": {
    "@x/b": ["@x/b@workspace:packages/b"],
    "typescript": ["typescript@5.9.2", "", { "bin": { "tsc": "bin/tsc" } }, "sha1-qUPrMeIDqWcUgN6EdBPTCCs/AYs="],
    "yaml": ["yaml@2.8.1", "", {}, "sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=="],
    "@scope/pkg": ["@scope/pkg@1.0.0", "", {}, "sha512-CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC=="],
    "foo/yaml": ["yaml@1.10.2", "", {}, "sha512-DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD=="],
    "gitdep": ["gitdep@github:o/r#abc", {}, "abc"],
    "@corp/ui": ["@corp/ui@3.1.0", "https://npm.corp.example/", {}, "sha512-EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE=="],
    "left-pad": ["left-pad@1.3.0", "https://registry.npmjs.org/", {}, "sha512-FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF=="],
  },
}`;

describe("parseBunLock", () => {
  const pkgs = parseBunLock(LOCK);

  test("returns registry packages with name and version", () => {
    expect(pkgs).toContainEqual(expect.objectContaining({ name: "yaml", version: "2.8.1", integrity: "sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==" }));
    expect(pkgs).toContainEqual(expect.objectContaining({ name: "@scope/pkg", version: "1.0.0" }));
    expect(pkgs).toContainEqual(expect.objectContaining({ name: "typescript", version: "5.9.2" }));
  });

  // Adversarial read 0.2.3 r7 (Codex 1): a sha1 integrity was dropped, so the download went unchecked.
  test("carries every hash as the integrity (sha1 too); one the download cannot check throws", () => {
    expect(pkgs.find((p) => p.name === "yaml" && p.version === "2.8.1")?.integrity).toBe("sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==");
    expect(pkgs.find((p) => p.name === "typescript")?.integrity).toBe("sha1-qUPrMeIDqWcUgN6EdBPTCCs/AYs=");
    for (const bad of ["sha512-x", "md5-1B2M2Y8AsgTpgAmY7PhCfg=="]) expect(() => parseBunLock(`{"packages":{"ms":["ms@2.1.3","",{},"${bad}"]}}`)).toThrow(/ms@2.1.3.*integrity/);
  });

  test("a private tarball url that is not a .tgz is a url dependency, not a private registry", () => {
    const one = (url: string) => parseBunLock(`{"packages":{"ms":["ms@2.1.3","${url}",{},"sha1-qUPrMeIDqWcUgN6EdBPTCCs/AYs="]}}`);
    for (const url of ["https://npm.corp.example/evil/-/evil-6.6.6.tar.bz2", "https://npm.corp.example/evil/-/evil-6.6.6.tar.xz", "https://codeload.github.com/org/repo/tar.gz/v2.1.3", "https://files.example.com/pkgs/ms-2.1.3.tar.bz2/"]) {
      const p = one(url)[0]!;
      expect(p.direct).toBe("url");
      expect(p.source).toBe(url);
      expect(p.registry).toBeUndefined();
    }
    expect(one("https://npm.corp.example/")[0]).toMatchObject({ registry: "npm.corp.example" });
    expect(one("https://npm.corp.example/")[0]!.direct).toBeUndefined();
    expect(one("https://artifacts.example/repository/npm-private/")[0]).toMatchObject({ registry: "artifacts.example" });
    expect(one("https://artifacts.example/repository/npm-private/")[0]!.direct).toBeUndefined();
  });

  test("a tarball url that is not the registry's own for name@version is a url dependency", () => {
    const one = (url: string) => parseBunLock(`{"packages":{"ms":["ms@2.1.3","${url}",{},"sha1-qUPrMeIDqWcUgN6EdBPTCCs/AYs="]}}`);
    expect(one("https://registry.npmjs.org/evil/-/evil-6.6.6.tgz")).toMatchObject([{ name: "ms", version: "2.1.3", direct: "url", source: "https://registry.npmjs.org/evil/-/evil-6.6.6.tgz" }]);
    expect(one("https://npm.corp.example/evil/-/evil-6.6.6.tgz")).toMatchObject([{ direct: "url" }]);
    expect(one("https://registry.npmjs.org/ms/-/ms-2.1.3.tgz")[0]!.direct).toBeUndefined();
    expect(one("https://npm.corp.example/ms/-/ms-2.1.3.tgz")[0]).toMatchObject({ registry: "npm.corp.example" });
  });

  test("names a non-default registry by host; the default one (empty or npmjs) is left out", () => {
    expect(pkgs.find((p) => p.name === "@corp/ui")?.registry).toBe("npm.corp.example");
    expect(pkgs.find((p) => p.name === "left-pad")?.registry).toBeUndefined();
    expect(pkgs.find((p) => p.name === "typescript")?.registry).toBeUndefined();
  });

  test("keeps a nested second version of the same package", () => {
    expect(pkgs).toContainEqual(expect.objectContaining({ name: "yaml", version: "1.10.2" }));
  });

  test("skips workspace entries; a git entry is direct, with its spec as the source", () => {
    expect(pkgs.find((p) => p.name === "@x/b")).toBeUndefined();
    expect(pkgs.find((p) => p.name === "gitdep")).toEqual({ name: "gitdep", version: "github:o/r#abc", source: "github:o/r#abc", direct: "git" });
    const url = parseBunLock(`{"packages":{"x":["@s/x@https://evil.example/x.tgz",{}],"y":["y@link:../y",{}],"z":["z@git+ssh://git@h.example/z.git#1",{}]}}`);
    expect(url.map((p) => [p.name, p.direct, p.source])).toEqual([["@s/x", "url", "https://evil.example/x.tgz"], ["y", "file", "link:../y"], ["z", "git", "git+ssh://git@h.example/z.git#1"]]);
  });

  test("dedupes identical entries; the same name@version with another source or hash is kept apart", () => {
    const sri = "sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==";
    const twice = parseBunLock(LOCK.replace(`"@scope/pkg"`, `"dup/yaml": ["yaml@2.8.1", "", {}, "${sri}"],\n    "@scope/pkg"`));
    expect(twice.filter((p) => p.name === "yaml" && p.version === "2.8.1").length).toBe(1);
    const other = parseBunLock(LOCK.replace(`"@scope/pkg"`, `"dup/yaml": ["yaml@2.8.1", "https://evil.example/", {}, "sha512-ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ=="],\n    "@scope/pkg"`));
    expect(other.filter((p) => p.name === "yaml" && p.version === "2.8.1").length).toBe(2);
  });

  test("carries the registry and the integrity as written, for a diff to see a swap", () => {
    expect(pkgs.find((p) => p.name === "@corp/ui")).toMatchObject({ source: "https://npm.corp.example/", digest: "sha512-EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE==" });
    expect(pkgs.find((p) => p.name === "typescript")).toMatchObject({ digest: "sha1-qUPrMeIDqWcUgN6EdBPTCCs/AYs=" });
    expect(pkgs.find((p) => p.name === "typescript")?.source).toBeUndefined();
  });

  test("a direct entry with credentials in its URL reaches the diff without them", () => {
    const lock = (url: string) => `{"packages":{"x":["x@${url}",{}],"y":["y@1.0.0","",{},"sha1-qUPrMeIDqWcUgN6EdBPTCCs/AYs="]}}`;
    const old = parseBunLock(lock("git+https://example.test/x.git#a"));
    const now = parseBunLock(lock("git+https://dave:tok2@example.test/x.git#b"));
    const d = diffLocks(old, now);
    expect(d).toHaveLength(1);
    expect(d[0]!.direct).toBe("git");
    expect(JSON.stringify(d)).not.toMatch(/tok2|dave/);
  });
});

test("each entry records the ranges its dependents ask for, nested copies included", () => {
  const h = "sha512-" + Buffer.alloc(64, 1).toString("base64");
  const lock = `{
    "lockfileVersion": 1,
    "workspaces": { "": { "name": "r", "dependencies": { "a": "^1.0.0" }, "devDependencies": { "@s/d": "~2.0.0" } } },
    "packages": {
      "a": ["a@1.2.0", "", { "dependencies": { "b": "^1" } }, "${h}"],
      "b": ["b@1.0.0", "", {}, "${h}"],
      "@s/d": ["@s/d@2.0.1", "", { "dependencies": { "b": "^2" } }, "${h}"],
      "@s/d/b": ["b@2.0.0", "", {}, "${h}"],
    }
  }`;
  const got = Object.fromEntries(parseBunLock(lock).map((p) => [`${p.name}@${p.version}`, p.descriptors]));
  expect(got).toEqual({ "a@1.2.0": ["a@^1.0.0"], "b@1.0.0": ["b@^1"], "@s/d@2.0.1": ["@s/d@~2.0.0"], "b@2.0.0": ["b@^2"] });
});

test("a workspace's dependencies resolve from the workspace's own nested copy before the root", () => {
  const h = "sha512-" + Buffer.alloc(64, 1).toString("base64");
  const lock = `{
    "lockfileVersion": 1,
    "workspaces": {
      "": { "name": "r", "dependencies": { "dep": "^1.0.0" } },
      "packages/a": { "name": "@x/a", "dependencies": { "dep": "^2.0.0" } },
    },
    "packages": {
      "dep": ["dep@1.0.0", "", {}, "${h}"],
      "@x/a/dep": ["dep@2.0.0", "", {}, "${h}"],
    }
  }`;
  const got = Object.fromEntries(parseBunLock(lock).map((p) => [`${p.name}@${p.version}`, p.descriptors]));
  expect(got).toEqual({ "dep@1.0.0": ["dep@^1.0.0"], "dep@2.0.0": ["dep@^2.0.0"] });
});

test("a workspace folder named like a package does not take that package's nested copy", () => {
  const h = "sha512-" + Buffer.alloc(64, 1).toString("base64");
  const lock = `{
    "lockfileVersion": 1,
    "workspaces": {
      "": { "name": "r" },
      "config": { "name": "@x/config", "dependencies": { "json5": "^2.0.0" } },
    },
    "packages": {
      "json5": ["json5@2.2.3", "", {}, "${h}"],
      "config": ["config@3.0.0", "", { "dependencies": { "json5": "^1.0.0" } }, "${h}"],
      "config/json5": ["json5@1.0.2", "", {}, "${h}"],
    }
  }`;
  const got = Object.fromEntries(parseBunLock(lock).map((p) => [`${p.name}@${p.version}`, p.descriptors]));
  expect(got["json5@2.2.3"]).toEqual(["json5@^2.0.0"]);
  expect(got["json5@1.0.2"]).toEqual(["json5@^1.0.0"]);
});
