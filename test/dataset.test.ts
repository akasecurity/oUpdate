import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readSample } from "../src/dataset.ts";

const root = mkdtempSync(join(tmpdir(), "oupdate-dataset-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function tree(name: string, files: Record<string, string>): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(join(dir, p, ".."), { recursive: true });
    writeFileSync(join(dir, p), body);
  }
  return dir;
}

function zip(out: string, dir: string, pass?: string) {
  const args = ["--format", "zip", ...(pass ? ["--options", "zip:encryption=zipcrypt", "--passphrase", pass] : []), "-cf", out, "-C", dir, "."];
  const p = Bun.spawnSync(["bsdtar", ...args], { stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(new TextDecoder().decode(p.stderr));
}

describe("readSample", () => {
  test("an npm-style sample: the package/ subtree under any prefix, metadata json dropped", async () => {
    const d = tree("npm", {
      "tmp/tmpabc/@x-y/package_info.json": "{}",
      "tmp/tmpabc/@x-y/package/package.json": '{"name":"@x/y"}',
      "tmp/tmpabc/@x-y/package/dist/index.js": "x",
    });
    const z = join(root, "npm.zip");
    zip(z, d, "infected");
    const m = await readSample(z, "infected");
    expect([...m.keys()].sort()).toEqual(["package/dist/index.js", "package/package.json"]);
  });

  test("a wrapped sample: the single inner archive is read", async () => {
    const inner = tree("wheel", { "pkg/__init__.py": "", "evil.pth": "import x" });
    const innerZip = join(root, "inner.zip");
    zip(innerZip, inner);
    const outerDir = tree("outer", {});
    Bun.spawnSync(["cp", innerZip, join(outerDir, "2026-01-01-pkg-v1.0.zip")]);
    const z = join(root, "outer.zip");
    zip(z, outerDir, "infected");
    const m = await readSample(z, "infected");
    expect([...m.keys()].sort()).toEqual(["evil.pth", "pkg/__init__.py"]);
  });

  test("an unpacked sdist tree: the dir holding PKG-INFO, under any prefix", async () => {
    const d = tree("sdist", {
      "tmp/tmpq/sources/pkg-1.0/PKG-INFO": "Name: pkg",
      "tmp/tmpq/sources/pkg-1.0/pkg/__init__.py": "",
      "tmp/tmpq/sources/pkg-1.0/enterprise/dist/x.whl": "zz",
    });
    const z = join(root, "sdist.zip");
    zip(z, d, "infected");
    const m = await readSample(z, "infected");
    expect([...m.keys()].sort()).toEqual(["PKG-INFO", "enterprise/dist/x.whl", "pkg/__init__.py"]);
  });

  test("an unpacked wheel tree: the dir holding *.dist-info/METADATA, each file stored as X/X", async () => {
    const d = tree("wheeltree", {
      "tmp/tmpq/pkg/pkg/__init__.py/pkg/__init__.py": "",
      "tmp/tmpq/pkg/pkg-1.0.dist-info/METADATA/pkg-1.0.dist-info/METADATA": "Name: pkg",
      "tmp/tmpq/pkg/package_info-pkg-1.0.json": "{}",
      "tmp/tmpq/sources/pkg/README.md": "src",
    });
    const z = join(root, "wheeltree.zip");
    zip(z, d, "infected");
    const m = await readSample(z, "infected");
    expect([...m.keys()].sort()).toEqual(["pkg-1.0.dist-info/METADATA", "pkg/__init__.py"]);
  });

  test("a wrong passphrase fails loudly", async () => {
    const d = tree("npm2", { "package/package.json": "{}" });
    const z = join(root, "npm2.zip");
    zip(z, d, "infected");
    await expect(readSample(z, "wrong")).rejects.toThrow();
  });
});
