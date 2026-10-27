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
    expect(find("charset-normalizer")).toMatchObject([{ name: "charset-normalizer", version: "3.4.0" }]);
    expect(find("charset-normalizer")[0]!.integrity).toBeUndefined();
  });

  test("keeps both versions a fork in the resolution locks", () => {
    expect(find("numpy").map((p) => p.version)).toEqual(["1.26.4", "2.1.3"]);
  });

  test("a package from an index other than PyPI is named by host", () => {
    expect(find("corp-auth")).toMatchObject([{ name: "corp-auth", version: "4.2.0", registry: "pypi.corp.example" }]);
    expect(find("torch")).toMatchObject([{ name: "torch", version: "2.5.1+cpu", registry: "download.pytorch.org" }]);
  });

  test("skips editable and virtual sources; git, directory, path and url sources are direct, with their source", () => {
    for (const n of ["demo-app", "demo-tools"]) expect(find(n)).toEqual([]);
    expect(find("gitdep")).toEqual([{ name: "gitdep", version: "0.3.0", direct: "git", source: "git+https://git.example/acme/gitdep?rev=main#0123456789abcdef0123456789abcdef01234567" }]);
    expect(find("localpkg")).toEqual([{ name: "localpkg", version: "1.0.0", direct: "file", source: "file:../localpkg" }]);
    expect(find("wheelfile")).toEqual([{ name: "wheelfile", version: "1.0.0", direct: "file", source: "file:vendor/wheelfile-1.0.0-py3-none-any.whl" }]);
    expect(find("urldep")).toEqual([{ name: "urldep", version: "2.0.0", direct: "url", source: "https://downloads.example/urldep-2.0.0.tar.gz" }]);
    expect(pkgs.filter((p) => !p.direct).length).toBe(5);
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
    expect(find("certifi")).toMatchObject([{ name: "certifi", version: "2024.8.30" }]);
    expect(find("typing-extensions")).toMatchObject([{ name: "typing-extensions", version: "4.12.2" }]);
    expect(find("requests")).toMatchObject([{ name: "requests", version: "2.32.3" }]);
  });

  test("a legacy source is an index: named by host unless it is PyPI", () => {
    expect(find("corp-auth")).toMatchObject([{ name: "corp-auth", version: "4.2.0", registry: "pypi.corp.example" }]);
    expect(find("mirrored")).toMatchObject([{ name: "mirrored", version: "1.0.1" }]);
  });

  test("git, directory, file and url sources are direct, with their source", () => {
    expect(find("gitdep")).toEqual([{ name: "gitdep", version: "0.3.0", direct: "git", source: "git+https://git.example/acme/gitdep.git#0123456789abcdef0123456789abcdef01234567" }]);
    expect(find("localpkg")).toMatchObject([{ direct: "file", source: "file:../localpkg" }]);
    expect(find("wheelfile")).toMatchObject([{ direct: "file", source: "file:vendor/wheelfile-1.0.0-py3-none-any.whl" }]);
    expect(find("urldep")).toMatchObject([{ direct: "url", source: "https://downloads.example/urldep-2.0.0.tar.gz" }]);
    expect(pkgs.filter((p) => !p.direct).length).toBe(5);
  });

  test("poetry.lock is a pypi lockfile the gate looks for at the repo root", async () => {
    expect(parseLock("poetry.lock", await fixture("poetry.lock")).eco).toBe("pypi");
    expect(LOCK_NAMES).toContain("poetry.lock");
  });
});

// Adversarial read 0.2.3 r7 (Codex 2): uv.lock's file URLs and hashes were dropped on a bump, so demo 1.0.1 with an
// attacker-hosted wheel URL (and its sha256) was reviewed as PyPI's demo 1.0.1 and passed.
describe("uv.lock files", () => {
  const H = (c: string) => `sha256:${c.repeat(64)}`;
  const PY = "https://files.pythonhosted.org/packages/ab/cd";
  const lock = (reg: string, wheel: string) => `version = 1\n[[package]]\nname = "Demo"\nversion = "1.0.1"\nsource = { registry = "${reg}" }\nsdist = { url = "${PY}/demo-1.0.1.tar.gz", hash = "${H("a")}", size = 10 }\nwheels = [{ url = "${wheel}", hash = "${H("b")}", size = 10 }]\n`;

  test("each locked file's url and hash are carried, sdist and wheels", () => {
    expect(parseUvLock(lock("https://pypi.org/simple", `${PY}/demo-1.0.1-py3-none-any.whl`))).toEqual([{
      name: "demo", version: "1.0.1", source: "https://pypi.org/simple", digest: `${H("a")} ${H("b")}`,
      artifacts: [{ url: `${PY}/demo-1.0.1.tar.gz`, hash: H("a") }, { url: `${PY}/demo-1.0.1-py3-none-any.whl`, hash: H("b") }],
    }]);
  });

  test("from PyPI, a file that is not on PyPI's file host is a url dependency", () => {
    for (const url of ["https://evil.example/demo-1.0.1-py3-none-any.whl", "http://files.pythonhosted.org/x.whl", `${PY}/x.whl?y=1`, "https://u:p@files.pythonhosted.org/x.whl"]) {
      expect(parseUvLock(lock("https://pypi.org/simple", url))).toEqual([{ name: "demo", version: "1.0.1", source: url, direct: "url" }]);
    }
  });

  test("a private index's files may live on its own host", () => {
    expect(parseUvLock(lock("https://pypi.corp.example/simple", "https://pypi.corp.example/f/demo.whl"))[0]).toMatchObject({ registry: "pypi.corp.example", artifacts: expect.any(Array) });
  });
});
