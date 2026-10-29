import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { parseRequirements } from "../src/lockfile/requirements.ts";
import { diffLocks } from "../src/lockdiff.ts";
import { LOCK_NAMES, lockKind, parseLock } from "../src/lockfile/index.ts";

const text = await Bun.file(join(import.meta.dir, "fixtures/locks/requirements.txt")).text();
const pkgs = parseRequirements(text);

describe("parseRequirements", () => {
  test("reads name==version pins, PEP 503 names, across extras, markers, hashes, comments and line continuations", () => {
    expect(pkgs.filter((p) => !p.direct)).toMatchObject([
      { name: "certifi", version: "2024.8.30" },
      { name: "charset-normalizer", version: "3.4.0" },
      { name: "requests", version: "2.32.3" },
      { name: "urllib3", version: "2.2.3" },
      { name: "typing-extensions", version: "4.12.2" },
    ]);
  });

  test("a line it cannot read as a pin throws, never drops out: includes, ranges, wildcards, ===, bare URLs and paths", () => {
    for (const line of ["-r base.txt", "-c constraints.txt", "--requirement=extra.txt", "--constraint c.txt", "flask>=3.0", "django~=5.1", "numpy==2.1.*", "exact===1.0-weird", "pinned-range==1.0,>=0.5", "unpinned",
      "https://evil.example/pkg-1.0-py3-none-any.whl", "./vendor/pkg", "/srv/pkg.tar.gz", "git+https://evil.example/pkg.git", "--some-new-option x"]) {
      expect(() => parseRequirements(`idna==3.10\n${line}\n`)).toThrow(/unsupported requirements line/);
    }
    expect(() => parseRequirements("--trusted-host mirror.example\n--require-hashes\n--only-binary :all:\nidna==3.10\n")).not.toThrow();
  });

  test("--extra-index-url and --find-links mark every pin private and change its source, so an unchanged pin reads as swapped", () => {
    const pin = "idna==3.10\n";
    for (const opt of ["--extra-index-url https://evil.example/simple", "--extra-index-url=https://evil.example/simple", "-f https://evil.example/wheels/", "--find-links ./wheels"]) {
      const [p] = parseRequirements(`${opt}\n${pin}`);
      expect([opt, p!.registry]).toEqual([opt, opt.includes("evil") ? "evil.example" : "./wheels"]);
      expect(diffLocks(parseRequirements(pin), parseRequirements(`${pin}${opt}\n`))[0]!.swapped).toBeDefined();
    }
  });

  test("editables and direct references are direct dependencies with their source", () => {
    expect(pkgs.filter((p) => p.direct)).toEqual([
      { name: "./localpkg", version: "./localpkg", source: "./localpkg", direct: "file" },
      { name: "editable", version: "git+https://git.example/acme/editable.git#egg=editable", source: "git+https://git.example/acme/editable.git#egg=editable", direct: "git" },
      { name: "gitdep", version: "git+https://git.example/acme/gitdep.git@main", source: "git+https://git.example/acme/gitdep.git@main", direct: "git" },
      { name: "wheelfile", version: "file:///srv/wheels/wheelfile-1.0.0-py3-none-any.whl", source: "file:///srv/wheels/wheelfile-1.0.0-py3-none-any.whl", direct: "file" },
    ]);
  });

  test("an --index-url other than PyPI names every pin by that host, wherever the option sits", () => {
    const corp = "requests==2.32.3\n--index-url https://user@pypi.corp.example/simple\nidna==3.10\n";
    expect(parseRequirements(corp)).toMatchObject([
      { name: "requests", version: "2.32.3", registry: "pypi.corp.example" },
      { name: "idna", version: "3.10", registry: "pypi.corp.example" },
    ]);
    expect(parseRequirements("-i https://pypi.corp.example/simple\nidna==3.10\n")[0]!.registry).toBe("pypi.corp.example");
    expect(parseRequirements("--index-url=https://pypi.org/simple\nidna==3.10\n")).toMatchObject([{ name: "idna", version: "3.10" }]);
  });

  test("a pin's --hash values are its digest, sorted, so a diff sees them change", () => {
    const h = (c: string) => `sha256:${c.repeat(64)}`;
    expect(parseRequirements(`idna==3.10 --hash=${h("b")} --hash=${h("a")}\n`)[0]!.digest).toBe(`${h("a")} ${h("b")}`);
  });

  test("from PyPI, each --hash is carried as a file to match against PyPI's listing; a pin with none carries none", () => {
    const h = (c: string) => `sha256:${c.repeat(64)}`;
    const [a, b] = parseRequirements(`idna==3.10 --hash=${h("b")} --hash=${h("a")}\nsix==1.16.0\n`);
    expect(a!.artifacts).toEqual([{ file: "requirements.txt", hash: h("b") }, { file: "requirements.txt", hash: h("a") }]);
    expect(b!.artifacts).toBeUndefined();
    expect(parseRequirements(`--index-url https://pypi.corp.example/simple\nidna==3.10 --hash=${h("a")}\n`)[0]!.artifacts).toBeUndefined();
  });

  test("named only by --lock: requirements*.txt and *.lock.txt are pypi, but never auto-detected", () => {
    expect(parseLock("deploy/requirements.txt", text).eco).toBe("pypi");
    expect(lockKind("requirements-dev.txt").eco).toBe("pypi");
    expect(lockKind("prod.lock.txt").eco).toBe("pypi");
    expect(() => lockKind("notes.txt")).toThrow(/unsupported lockfile notes.txt/);
    for (const n of LOCK_NAMES) expect(n).not.toMatch(/\.txt$/);
  });
});
