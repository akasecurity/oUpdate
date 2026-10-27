import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { parseRequirements } from "../src/lockfile/requirements.ts";
import { LOCK_NAMES, lockKind, parseLock } from "../src/lockfile/index.ts";

const text = await Bun.file(join(import.meta.dir, "fixtures/locks/requirements.txt")).text();
const pkgs = parseRequirements(text);

describe("parseRequirements", () => {
  test("reads name==version pins, PEP 503 names, across extras, markers, hashes, comments and line continuations", () => {
    expect(pkgs).toEqual([
      { name: "certifi", version: "2024.8.30" },
      { name: "charset-normalizer", version: "3.4.0" },
      { name: "requests", version: "2.32.3" },
      { name: "urllib3", version: "2.2.3" },
      { name: "typing-extensions", version: "4.12.2" },
    ]);
  });

  test("skips includes, options, editables, direct references, ranges, wildcards and === pins", () => {
    for (const n of ["localpkg", "editable", "gitdep", "wheelfile", "flask", "django", "numpy", "exact", "pinned-range", "unpinned"]) {
      expect(pkgs.find((p) => p.name === n)).toBeUndefined();
    }
  });

  test("an --index-url other than PyPI names every pin by that host, wherever the option sits", () => {
    const corp = "requests==2.32.3\n--index-url https://user@pypi.corp.example/simple\nidna==3.10\n";
    expect(parseRequirements(corp)).toEqual([
      { name: "requests", version: "2.32.3", registry: "pypi.corp.example" },
      { name: "idna", version: "3.10", registry: "pypi.corp.example" },
    ]);
    expect(parseRequirements("-i https://pypi.corp.example/simple\nidna==3.10\n")[0]!.registry).toBe("pypi.corp.example");
    expect(parseRequirements("--index-url=https://pypi.org/simple\nidna==3.10\n")).toEqual([{ name: "idna", version: "3.10" }]);
  });

  test("named only by --lock: requirements*.txt and *.lock.txt are pypi, but never auto-detected", () => {
    expect(parseLock("deploy/requirements.txt", text).eco).toBe("pypi");
    expect(lockKind("requirements-dev.txt").eco).toBe("pypi");
    expect(lockKind("prod.lock.txt").eco).toBe("pypi");
    expect(() => lockKind("notes.txt")).toThrow(/unsupported lockfile notes.txt/);
    for (const n of LOCK_NAMES) expect(n).not.toMatch(/\.txt$/);
  });
});
