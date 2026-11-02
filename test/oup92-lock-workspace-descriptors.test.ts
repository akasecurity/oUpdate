import { expect, test } from "bun:test";
import { diffLocks } from "../src/lockdiff.ts";
import { parseBunLock } from "../src/lockfile/bunlock.ts";
import { parseNpmLock } from "../src/lockfile/npmlock.ts";
import { parsePnpmLock } from "../src/lockfile/pnpmlock.ts";
import { descriptorOf } from "../src/lockfile/types.ts";

const h = (n: number) => "sha512-" + Buffer.alloc(64, n).toString("base64");

// Two workspaces ask the same range. Old: a gets dep 1.0.0 and b gets 1.1.0. New: they trade places.
const bun = (aVer: string, bVer: string) => `{
  "lockfileVersion": 1,
  "workspaces": {
    "": { "name": "r" },
    "pkgs/a": { "name": "@x/a", "dependencies": { "dep": "^1.0.0" } },
    "pkgs/b": { "name": "@x/b", "dependencies": { "dep": "^1.0.0" } },
  },
  "packages": {
    "@x/a/dep": ["dep@${aVer}", "", {}, "${h(aVer === "1.0.0" ? 1 : 2)}"],
    "@x/b/dep": ["dep@${bVer}", "", {}, "${h(bVer === "1.0.0" ? 1 : 2)}"],
  }
}`;

test("bun: the same range in two workspaces is two descriptors", () => {
  const dep = parseBunLock(bun("1.0.0", "1.1.0")).map((p) => p.descriptors);
  expect(dep).toEqual([["dep@^1.0.0 [pkgs/a]"], ["dep@^1.0.0 [pkgs/b]"]]);
});

test("bun: two workspaces trading what one range resolves to is a change", () => {
  const d = diffLocks(parseBunLock(bun("1.0.0", "1.1.0")), parseBunLock(bun("1.1.0", "1.0.0")));
  expect(d.length).toBeGreaterThan(0);
  expect(d.every((c) => c.swapped)).toBe(true);
});

test("pnpm: an importer's specifiers carry its folder, the root's do not", () => {
  const lock = `lockfileVersion: '9.0'
importers:
  .:
    dependencies:
      foo:
        specifier: ^1.0.0
        version: 1.2.0
  packages/a:
    dependencies:
      foo:
        specifier: ^1.0.0
        version: 1.2.0
packages:
  foo@1.2.0:
    resolution: {integrity: ${h(1)}}
snapshots:
  foo@1.2.0: {}
`;
  expect(parsePnpmLock(lock)[0]!.descriptors).toEqual(["foo@^1.0.0", "foo@^1.0.0 [packages/a]"]);
});

test("npm: a workspace folder's ranges carry the folder", () => {
  const lock = JSON.stringify({
    lockfileVersion: 3,
    packages: {
      "": { name: "r", workspaces: ["pkgs/*"] },
      "pkgs/a": { name: "a", version: "1.0.0", dependencies: { dep: "^1.0.0" } },
      "node_modules/dep": { version: "1.0.0", resolved: "https://registry.npmjs.org/dep/-/dep-1.0.0.tgz", integrity: h(1) },
    },
  });
  expect(parseNpmLock(lock).find((p) => p.name === "dep")!.descriptors).toEqual(["dep@^1.0.0 [pkgs/a]"]);
});

const pnpm = (aVer: string, bVer: string, aDir = "packages/a") => `lockfileVersion: '9.0'
importers:
  ${aDir}:
    dependencies:
      foo:
        specifier: ^1.0.0
        version: ${aVer}
  packages/b:
    dependencies:
      foo:
        specifier: ^1.0.0
        version: ${bVer}
packages:
  foo@1.0.0:
    resolution: {integrity: ${h(1)}}
  foo@1.1.0:
    resolution: {integrity: ${h(2)}}
snapshots:
  foo@1.0.0: {}
  foo@1.1.0: {}
`;

const npm = (aVer: string, bVer: string, aDir = "pkgs/a") => {
  const e = (v: string) => ({ version: v, resolved: `https://registry.npmjs.org/dep/-/dep-${v}.tgz`, integrity: h(v === "1.0.0" ? 1 : 2) });
  return JSON.stringify({
    lockfileVersion: 3,
    packages: {
      "": { name: "r", workspaces: ["pkgs/*", "libs/*"] },
      [aDir]: { name: "a", version: "1.0.0", dependencies: { dep: "^1.0.0" } },
      "pkgs/b": { name: "b", version: "1.0.0", dependencies: { dep: "^1.0.0" } },
      [`${aDir}/node_modules/dep`]: e(aVer),
      "pkgs/b/node_modules/dep": e(bVer),
    },
  });
};

test("pnpm: two importers trading what one range resolves to is a change", () => {
  const d = diffLocks(parsePnpmLock(pnpm("1.0.0", "1.1.0")), parsePnpmLock(pnpm("1.1.0", "1.0.0")));
  expect(d.length).toBeGreaterThan(0);
  expect(d.every((c) => c.swapped)).toBe(true);
});

test("npm: two workspaces trading what one range resolves to is a change", () => {
  const d = diffLocks(parseNpmLock(npm("1.0.0", "1.1.0")), parseNpmLock(npm("1.1.0", "1.0.0")));
  expect(d.length).toBeGreaterThan(0);
  expect(d.every((c) => c.swapped)).toBe(true);
});

test("moving a workspace folder alone is no change", () => {
  expect(diffLocks(parsePnpmLock(pnpm("1.0.0", "1.1.0")), parsePnpmLock(pnpm("1.0.0", "1.1.0", "libs/a")))).toEqual([]);
  // npm also records the workspace itself as a link whose folder moved: that is reported, the dependency is not.
  const moved = diffLocks(parseNpmLock(npm("1.0.0", "1.1.0")), parseNpmLock(npm("1.0.0", "1.1.0", "libs/a")));
  expect(moved.filter((c) => c.name === "dep")).toEqual([]);
});

test("a descriptor does not collide across the name, range and scope splits tried here", () => {
  expect(descriptorOf("d", "^1 [x", "y")).not.toBe(descriptorOf("d", "^1", "x [y"));
  expect(descriptorOf("d", "^1.0.0 [pkgs/a]")).not.toBe(descriptorOf("d", "^1.0.0", "pkgs/a"));
  expect(descriptorOf("d", "^1", "a")).toBe("d@^1 [a]");
  expect(descriptorOf("d", "^1")).toBe("d@^1");
  expect(descriptorOf("a@b", "c")).not.toBe(descriptorOf("a", "b@c"));
  expect(descriptorOf("@s/p", "^1")).toBe("@s/p@^1");
  expect(descriptorOf("", "@x")).not.toBe(descriptorOf("@", "x"));
  expect(descriptorOf("", "a/@")).not.toBe(descriptorOf("@a/", ""));
  expect(descriptorOf("", "s/pkg@r")).not.toBe(descriptorOf("@s/pkg", "r"));
});
