import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readArtifact, normalizePaths } from "../src/artifact.ts";

const root = mkdtempSync(join(tmpdir(), "oupdate-artifact-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

async function pack(name: string, format: "tgz" | "zip", files: Record<string, string>): Promise<string> {
  const src = join(root, `${name}-src`);
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(join(src, p, ".."), { recursive: true });
    writeFileSync(join(src, p), body);
  }
  const out = join(root, `${name}.${format === "tgz" ? "tgz" : "whl"}`);
  const args = format === "tgz" ? ["-czf", out, "-C", src, "."] : ["--format", "zip", "-cf", out, "-C", src, "."];
  const p = Bun.spawnSync(["bsdtar", ...args]);
  if (p.exitCode !== 0) throw new Error(new TextDecoder().decode(p.stderr));
  return out;
}

describe("readArtifact", () => {
  test("reads a tgz into a path map without touching the working tree", async () => {
    const f = await pack("a", "tgz", { "package/package.json": "{}", "package/index.js": "x" });
    const m = await readArtifact(f);
    expect([...m.keys()].sort()).toEqual(["package/index.js", "package/package.json"]);
    expect(new TextDecoder().decode(m.get("package/index.js"))).toBe("x");
  });

  test("reads a wheel (zip)", async () => {
    const f = await pack("b", "zip", { "cook.pth": "import cook", "pkg/__init__.py": "" });
    const m = await readArtifact(f);
    expect(m.has("cook.pth")).toBe(true);
    expect(m.has("pkg/__init__.py")).toBe(true);
  });

  test("strips a leading ./ from member names", async () => {
    const f = await pack("c", "tgz", { "a.txt": "1" });
    const m = await readArtifact(f);
    expect(m.has("a.txt")).toBe(true);
  });

  test("an archive with a path escaping its root is refused", async () => {
    const src = join(root, "evil-src");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "x"), "1");
    const out = join(root, "evil.tar");
    // -s rewrites the member name to ../escape at pack time.
    const p = Bun.spawnSync(["bsdtar", "-cf", out, "-C", src, "-s", ",^x$,../escape,", "x"]);
    expect(p.exitCode).toBe(0);
    await expect(readArtifact(out)).rejects.toThrow(/unsafe member/);
    expect(existsSync(join(root, "escape"))).toBe(false);
  });
});

describe("normalizePaths", () => {
  const m = (keys: string[]) => new Map(keys.map((k) => [k, new Uint8Array()]));

  test("strips a single shared top dir (sdist name-version/)", () => {
    expect([...normalizePaths(m(["litellm-1.106.2/pyproject.toml", "litellm-1.106.2/litellm/a.py"])).keys()].sort()).toEqual(["litellm/a.py", "pyproject.toml"]);
  });

  test("keeps paths when there is no single top dir (wheel)", () => {
    expect([...normalizePaths(m(["litellm/a.py", "cook.pth"])).keys()].sort()).toEqual(["cook.pth", "litellm/a.py"]);
  });

  test("replaces the version in wheel .dist-info and .data dirs", () => {
    expect([...normalizePaths(m(["litellm/a.py", "litellm-1.107.0.dist-info/METADATA", "litellm-1.107.0.data/purelib/cook.pth"])).keys()].sort()).toEqual([
      "litellm-VERSION.data/purelib/cook.pth",
      "litellm-VERSION.dist-info/METADATA",
      "litellm/a.py",
    ]);
  });

  test("npm package/ top dir is stripped too", () => {
    expect([...normalizePaths(m(["package/package.json", "package/index.js"])).keys()].sort()).toEqual(["index.js", "package.json"]);
  });
});
