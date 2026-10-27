import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { parsePoetryLock, parseUvLock, pep503 } from "../src/lockfile/pylock.ts";
import { LOCK_NAMES, parseLock } from "../src/lockfile/index.ts";

const fixture = (f: string) => Bun.file(join(import.meta.dir, "fixtures/locks", f)).text();

describe("pep503", () => {
  test("lowercases and folds runs of -, _ and . to one -", () => {
    expect(pep503("Charset_Normalizer")).toBe("charset-normalizer");
    expect(pep503("zope.interface")).toBe("zope-interface");
    expect(pep503("A__b-.C")).toBe("a-b-c");
  });
});

const uv = parseUvLock(await fixture("uv.lock"));

describe("parseUvLock", () => {
  const pkgs = uv;
  const find = (name: string, version?: string) => pkgs.filter((p) => p.name === name && (!version || p.version === version));

  test("reads registry packages with PEP 503 names and no integrity (sha256 is not checked)", () => {
    expect(find("charset-normalizer")).toEqual([{ name: "charset-normalizer", version: "3.4.0" }]);
  });

  test("keeps both versions a fork in the resolution locks", () => {
    expect(find("numpy").map((p) => p.version)).toEqual(["1.26.4", "2.1.3"]);
  });

  test("a package from an index other than PyPI is named by host", () => {
    expect(find("corp-auth")).toEqual([{ name: "corp-auth", version: "4.2.0", registry: "pypi.corp.example" }]);
    expect(find("torch")).toEqual([{ name: "torch", version: "2.5.1+cpu", registry: "download.pytorch.org" }]);
  });

  test("skips editable, virtual, git, directory, path and url sources", () => {
    for (const n of ["demo-app", "demo-tools", "gitdep", "localpkg", "wheelfile", "urldep"]) expect(find(n)).toEqual([]);
    expect(pkgs.length).toBe(5);
  });

  test("uv.lock is a pypi lockfile the gate looks for at the repo root", async () => {
    expect(parseLock("svc/uv.lock", await fixture("uv.lock")).eco).toBe("pypi");
    expect(LOCK_NAMES).toContain("uv.lock");
  });

  test("a file that is not TOML throws", () => {
    expect(() => parseUvLock("[[package]\nname = ")).toThrow();
  });
});

const poetry = parsePoetryLock(await fixture("poetry.lock"));

describe("parsePoetryLock", () => {
  const pkgs = poetry;
  const find = (name: string) => pkgs.filter((p) => p.name === name);

  test("reads PyPI packages (no source table) with PEP 503 names", () => {
    expect(find("certifi")).toEqual([{ name: "certifi", version: "2024.8.30" }]);
    expect(find("typing-extensions")).toEqual([{ name: "typing-extensions", version: "4.12.2" }]);
    expect(find("requests")).toEqual([{ name: "requests", version: "2.32.3" }]);
  });

  test("a legacy source is an index: named by host unless it is PyPI", () => {
    expect(find("corp-auth")).toEqual([{ name: "corp-auth", version: "4.2.0", registry: "pypi.corp.example" }]);
    expect(find("mirrored")).toEqual([{ name: "mirrored", version: "1.0.1" }]);
  });

  test("skips git, directory, file and url sources", () => {
    for (const n of ["gitdep", "localpkg", "wheelfile", "urldep"]) expect(find(n)).toEqual([]);
    expect(pkgs.length).toBe(5);
  });

  test("poetry.lock is a pypi lockfile the gate looks for at the repo root", async () => {
    expect(parseLock("poetry.lock", await fixture("poetry.lock")).eco).toBe("pypi");
    expect(LOCK_NAMES).toContain("poetry.lock");
  });
});
