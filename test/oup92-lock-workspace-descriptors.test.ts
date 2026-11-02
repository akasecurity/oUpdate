import { expect, test } from "bun:test";
import { diffLocks } from "../src/lockdiff.ts";
import { parseBunLock } from "../src/lockfile/bunlock.ts";
import { parseNpmLock } from "../src/lockfile/npmlock.ts";
import { parsePnpmLock } from "../src/lockfile/pnpmlock.ts";

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
