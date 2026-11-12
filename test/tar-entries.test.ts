import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { foldKey, markUnstored, mergeArtifactPair, normalizePaths, readArtifact, unescapeMember, unstoredMembers } from "../src/artifact.ts";
import { hasZipEnd, recordPaths, zipNameNotes } from "../src/zip-names.ts";
import { markLink, prepass, tarNoteEntries } from "../src/prepass.ts";
import { carriedNote } from "../src/review.ts";
import { loadArtifacts, type ReviewArgs } from "../src/cli.ts";

// ustar members, including two entries with one name. npm keeps the earlier
// regular file and skips a link; the entry list is what we hold on.
function tarBytes(entries: { name: string; type: "file" | "sym" | "hard" | "dir"; data: string }[]): Uint8Array {
  const enc = new TextEncoder();
  const blocks: Uint8Array[] = [];
  const put = (header: Uint8Array, off: number, text: string) => {
    const bytes = enc.encode(text);
    header.set(bytes.subarray(0, Math.min(bytes.length, header.length - off)), off);
  };
  for (const entry of entries) {
    const header = new Uint8Array(512);
    put(header, 0, entry.name);
    // A directory member needs +x or the extract cannot be removed (ENOTEMPTY).
    put(header, 100, entry.type === "dir" ? "0000755\0" : "0000644\0");
    put(header, 108, "0000000\0");
    put(header, 116, "0000000\0");
    const body = entry.type === "file" ? enc.encode(entry.data) : new Uint8Array();
    put(header, 124, body.length.toString(8).padStart(11, "0") + "\0");
    put(header, 136, "00000000000\0");
    header.fill(0x20, 148, 156);
    header[156] = (entry.type === "file" ? "0" : entry.type === "sym" ? "2" : entry.type === "hard" ? "1" : "5").charCodeAt(0);
    if (entry.type === "sym" || entry.type === "hard") put(header, 157, entry.data);
    put(header, 257, "ustar\0");
    put(header, 263, "00");
    let sum = 0;
    for (const b of header) sum += b;
    put(header, 148, sum.toString(8).padStart(6, "0") + "\0 ");
    blocks.push(header);
    if (body.length) {
      const padded = new Uint8Array(Math.ceil(body.length / 512) * 512);
      padded.set(body);
      blocks.push(padded);
    }
  }
  blocks.push(new Uint8Array(1024));
  const out = new Uint8Array(blocks.reduce((n, b) => n + b.length, 0));
  let at = 0;
  for (const block of blocks) {
    out.set(block, at);
    at += block.length;
  }
  return out;
}

const dir = mkdtempSync(join(tmpdir(), "oup-tar-"));
let n = 0;

async function details(old: Uint8Array, now: Uint8Array): Promise<string> {
  const a = join(dir, `${n++}-old.tar`);
  const b = join(dir, `${n}-new.tar`);
  writeFileSync(a, old);
  writeFileSync(b, now);
  const oldFiles = normalizePaths(await readArtifact(a));
  const newFiles = normalizePaths(await readArtifact(b));
  return prepass("npm", oldFiles, newFiles).hard.map((s) => s.detail).join(" ");
}

const pj = (name: string) => JSON.stringify({ name, version: "1.0.0", scripts: { postinstall: "node install.js" } });
// The old release each "holds" case updates from: a plain package with none of the shapes, so the shape is new.
const clean = () => tarBytes([{ name: "package/package.json", type: "file", data: pj("clean-old") }, { name: "package/install.js", type: "file", data: "// benign\n" }]);
const benign = "// benign\n";
const payload = "require('child_process').execSync('id')\n";

describe("tar entry list", () => {
  test("a symlink member holds even when it reuses a regular file's name", async () => {
    const members = (body: string) => tarBytes([
      { name: "package/package.json", type: "file", data: pj("a-sym") },
      { name: "package/lib.js", type: "file", data: benign },
      { name: "package/install.js", type: "file", data: body },
      { name: "package/install.js", type: "sym", data: "lib.js" },
    ]);
    expect(await details(clean(), members(payload))).toMatch(/symlink/);
  });

  test("a hardlink member holds", async () => {
    const members = (body: string) => tarBytes([
      { name: "package/package.json", type: "file", data: pj("e-hard") },
      { name: "package/lib.js", type: "file", data: benign },
      { name: "package/install.js", type: "file", data: body },
      { name: "package/install.js", type: "hard", data: "package/lib.js" },
    ]);
    expect(await details(clean(), members(payload))).toMatch(/hardlink/);
  });

  test("a case-fold collision holds", async () => {
    const members = (body: string) => tarBytes([
      { name: "package/README.md", type: "file", data: "readme" },
      { name: "package/package.json", type: "file", data: pj("c-case") },
      { name: "package/install.js", type: "file", data: body },
      { name: "package/Install.js", type: "file", data: benign },
    ]);
    expect(await details(clean(), members(payload))).toMatch(/case-fold/);
  });

  test("two top dirs hold", async () => {
    const members = (body: string) => tarBytes([
      { name: "zz/install.js", type: "file", data: benign },
      { name: "package/package.json", type: "file", data: pj("b-two2") },
      { name: "package/install.js", type: "file", data: body },
    ]);
    expect(await details(clean(), members(payload))).toMatch(/top dirs/);
  });

  test("one top dir of regular files is not a tar-entry hold", async () => {
    const members = (readme: string) => tarBytes([
      { name: "package/package.json", type: "file", data: pj("clean") },
      { name: "package/install.js", type: "file", data: benign },
      { name: "package/README.md", type: "file", data: readme },
    ]);
    expect(await details(members("a"), members("b"))).not.toMatch(/symlink|hardlink|case-fold|top dirs|duplicate path|root file|node_modules|non-ascii/);
  });

  test("a root file beside package/ holds", async () => {
    const members = (body: string) => tarBytes([
      { name: "install.js", type: "file", data: benign },
      { name: "package/package.json", type: "file", data: pj("f-root") },
      { name: "package/install.js", type: "file", data: body },
    ]);
    expect(await details(clean(), members(payload))).toMatch(/root file/);
  });

  test("a bundled node_modules member holds", async () => {
    const members = (body: string) => tarBytes([
      { name: "package/package.json", type: "file", data: pj("k-bun") },
      { name: "package/index.js", type: "file", data: benign },
      { name: "package/node_modules/kevil/package.json", type: "file", data: pj("kevil") },
      { name: "package/node_modules/kevil/p.js", type: "file", data: body },
    ]);
    expect(await details(clean(), members(payload))).toMatch(/node_modules/);
  });

  test("a non-ascii member name holds", async () => {
    const members = (body: string) => tarBytes([
      { name: "package/package.json", type: "file", data: pj("g-ls") },
      { name: "package/install.js", type: "file", data: body },
      { name: "package/in\u017ftall.js", type: "file", data: benign },
    ]);
    expect(await details(clean(), members(payload))).toMatch(/non-ascii/);
  });

  test("a dot segment and an empty segment are the same path", async () => {
    const dot = (body: string) => tarBytes([
      { name: "package/package.json", type: "file", data: pj("h-dot") },
      { name: "package/install.js", type: "file", data: body },
      { name: "package/./install.js", type: "file", data: benign },
    ]);
    const slash = (body: string) => tarBytes([
      { name: "package/package.json", type: "file", data: pj("h-ds") },
      { name: "package/install.js", type: "file", data: body },
      { name: "package//install.js", type: "file", data: benign },
    ]);
    expect(await details(dot(benign), dot(payload))).toMatch(/duplicate path/);
    expect(await details(slash(benign), slash(payload))).toMatch(/duplicate path/);
  });

  test("a package directory entry is not a root file", async () => {
    const members = (readme: string) => tarBytes([
      { name: "package/", type: "dir", data: "" },
      { name: "package/package.json", type: "file", data: pj("clean-dir") },
      { name: "package/install.js", type: "file", data: benign },
      { name: "package/README.md", type: "file", data: readme },
    ]);
    expect(await details(members("a"), members("b"))).not.toMatch(/symlink|hardlink|case-fold|top dirs|duplicate path|root file|node_modules|non-ascii/);
  });
});

describe("a tar note the old release had too", () => {
  async function pre(old: Uint8Array | undefined, now: Uint8Array) {
    const b = join(dir, `${n++}-new.tar`);
    writeFileSync(b, now);
    let oldFiles = new Map() as Awaited<ReturnType<typeof readArtifact>>;
    if (old) {
      const a = join(dir, `${n++}-old.tar`);
      writeFileSync(a, old);
      oldFiles = normalizePaths(await readArtifact(a));
    }
    return prepass("pypi", oldFiles, normalizePaths(await readArtifact(b)));
  }
  // Each release has its own top dir (x-1.0.0/, x-1.0.1/), as a forge or sdist tarball does.
  const rel = (v: string, extra: { name: string; type: "file" | "sym" | "hard" | "dir"; data: string }[]) =>
    tarBytes([{ name: `x-${v}/README.md`, type: "file", data: v }, ...extra.map((e) => ({ ...e, name: `x-${v}/${e.name}` }))]);
  const shapes: [string, { name: string; type: "file" | "sym" | "hard" | "dir"; data: string }[]][] = [
    ["a docs symlink to a file in the tree", [{ name: "CODE.md", type: "file", data: "c" }, { name: "docs/CODE.md", type: "sym", data: "../CODE.md" }]],
    ["hash-named CRL symlinks in testdata", [{ name: "testdata/crl/5.crl", type: "file", data: "crl" }, { name: "testdata/crl/0b35a562.r0", type: "sym", data: "5.crl" }]],
    ["a non-ascii test file name", [{ name: "testdata/\u0645\u0644\u0641.txt", type: "file", data: "f" }]],
    ["a homoglyph fixture beside the real name", [{ name: "invalid/gradle-wrapper.jar", type: "file", data: "j" }, { name: "invalid/gradl\u0435-wrapper.jar", type: "file", data: "j" }]],
    ["a hardlink to a file in the tree", [{ name: "a.txt", type: "file", data: "a" }, { name: "b.txt", type: "hard", data: "x-VER/a.txt" }]],
  ];
  for (const [label, extra] of shapes)
    test(`${label}, unchanged across versions, does not hold and is shown as carried over`, async () => {
      const fix = (v: string) => extra.map((e) => (e.type === "hard" ? { ...e, data: e.data.replace("VER", v) } : e));
      const r = await pre(rel("1.0.0", fix("1.0.0")), rel("1.0.1", fix("1.0.1")));
      expect(r.hard.filter((s) => s.kind === "tar-entry")).toEqual([]);
      expect(r.carriedTarNotes?.length, label).toBeGreaterThan(0);
      expect(carriedNote(r)).toStartWith("; carried over from the old release (no hold): ");
    });
  test("an added link, a changed link target, an added homoglyph and a first release still hold", async () => {
    const link = (t: string) => [{ name: "testdata/crl/5.crl", type: "file" as const, data: "crl" }, { name: "testdata/crl/6.crl", type: "file" as const, data: "crl6" }, { name: "testdata/crl/0b35a562.r0", type: "sym" as const, data: t }];
    const hold = async (old: Uint8Array | undefined, now: Uint8Array) => (await pre(old, now)).hard.filter((s) => s.kind === "tar-entry").map((s) => s.detail);
    expect(await hold(rel("1.0.0", link("5.crl").slice(0, 2)), rel("1.0.1", link("5.crl")))).toEqual(["symlink x-1.0.1/testdata/crl/0b35a562.r0"]);
    expect(await hold(rel("1.0.0", link("5.crl")), rel("1.0.1", link("6.crl")))).toEqual(["symlink x-1.0.1/testdata/crl/0b35a562.r0"]);
    const jar = [{ name: "invalid/gradle-wrapper.jar", type: "file" as const, data: "j" }];
    expect(await hold(rel("1.0.0", jar), rel("1.0.1", [...jar, { name: "invalid/gradl\u0435-wrapper.jar", type: "file", data: "j" }]))).toEqual(["non-ascii x-1.0.1/invalid/gradl\u0435-wrapper.jar"]);
    expect(await hold(undefined, rel("1.0.1", link("5.crl")))).toEqual(["symlink x-1.0.1/testdata/crl/0b35a562.r0"]);
  });
  test("a duplicate path the old release had too still holds: what an installer writes can differ from the file read", async () => {
    const dup = (v: string, body: string) => rel(v, [{ name: "install.js", type: "file", data: body }, { name: "./install.js", type: "file", data: "// benign\n" }]);
    const r = await pre(dup("1.0.0", "// benign\n"), dup("1.0.1", "require('child_process').execSync('id')\n"));
    expect(r.hard.map((s) => s.detail)).toEqual(["duplicate path x-1.0.1/install.js"]);
  });
});

describe("carried tar notes after review (each lets a new or changed note pass if wrong)", () => {
  type E = { name: string; type: "file" | "sym" | "hard" | "dir"; data: string };
  const read = async (bytes: Uint8Array) => {
    const p = join(dir, `${n++}-r.tar`);
    writeFileSync(p, bytes);
    return normalizePaths(await readArtifact(p));
  };
  const holds = (r: ReturnType<typeof prepass>) => r.hard.filter((s) => s.kind === "tar-entry").map((s) => s.detail);
  const rel = (v: string, extra: E[]) => tarBytes([{ name: `x-${v}/README.md`, type: "file", data: v }, ...extra.map((e) => ({ ...e, name: `x-${v}/${e.name}` }))]);
  const link = (target: string): E[] => [{ name: "a.txt", type: "file", data: "a" }, { name: "b.txt", type: "file", data: "b" }, { name: "docs/link", type: "sym", data: target }];

  test("a merged pair reads its own link: an sdist link retargeted beside a wheel's unchanged one holds", async () => {
    const into = { old: new Map(), new: new Map() } as { old: Map<string, Uint8Array>; new: Map<string, Uint8Array> };
    mergeArtifactPair(into, "x-1.0.1-py3-none-any.whl", await read(rel("1.0.0", link("../a.txt"))), await read(rel("1.0.1", link("../a.txt"))));
    mergeArtifactPair(into, "x-1.0.1.tar.gz", await read(rel("1.0.0", link("../a.txt"))), await read(rel("1.0.1", link("../b.txt"))));
    const r = prepass("pypi", into.old, into.new);
    expect(holds(r)).toEqual(["x-1.0.1.tar.gz: symlink x-1.0.1/docs/link"]);
    expect(r.carriedTarNotes).toEqual(["x-1.0.1-py3-none-any.whl: symlink x-1.0.1/docs/link"]);
  });

  test("old notes are not pooled across pairs: an unpaired new artifact's note holds though another pair's old side had it", async () => {
    const into = { old: new Map(), new: new Map() } as { old: Map<string, Uint8Array>; new: Map<string, Uint8Array> };
    mergeArtifactPair(into, "x-1.0.1-py3-none-any.whl", await read(rel("1.0.0", link("../a.txt"))), await read(rel("1.0.1", link("../a.txt"))));
    mergeArtifactPair(into, "x-1.0.1.tar.gz", new Map(), await read(rel("1.0.1", [...link("../a.txt"), { name: "testdata/\u0645.txt", type: "file", data: "m" }])));
    const r = prepass("pypi", into.old, into.new);
    expect(holds(r).sort()).toEqual(["x-1.0.1.tar.gz: non-ascii x-1.0.1/testdata/\u0645.txt", "x-1.0.1.tar.gz: symlink x-1.0.1/docs/link"]);
  });

  test("a hardlink retargeted to a file with identical bytes holds: the target name is compared, not the bytes", async () => {
    const files = (target: string): E[] => [{ name: "a.txt", type: "file", data: "same" }, { name: "c.txt", type: "file", data: "same" }, { name: "b.txt", type: "hard", data: target }];
    const r = prepass("pypi", await read(rel("1.0.0", files("x-1.0.0/a.txt"))), await read(rel("1.0.1", files("x-1.0.1/c.txt"))));
    expect(holds(r)).toEqual(["hardlink x-1.0.1/b.txt"]);
  });

  test("two notes on one collapsed key both hold: demo-1.data and demo-2.data collide after normalizing", async () => {
    const one: E[] = [{ name: "demo-1.data/\u00e9.txt", type: "file", data: "e" }];
    const r = prepass("pypi", await read(rel("1.0.0", one)), await read(rel("1.0.1", [...one, { name: "demo-2.data/\u00e9.txt", type: "file", data: "e" }])));
    expect(holds(r).filter((d) => d.startsWith("non-ascii"))).toHaveLength(2);
    expect(holds(r)).toContain("path collision demo-VERSION.data/\u00e9.txt (demo-1.data/\u00e9.txt, demo-2.data/\u00e9.txt)");
    expect(r.carriedTarNotes).toBeUndefined();
  });

  test("top dirs compare as a list: {a, 'b c'} and {'a b', c} both read 'top dirs a b c' and still hold", async () => {
    const tops = (dirs: string[]) => tarBytes(dirs.map((d) => ({ name: `${d}/f.txt`, type: "file" as const, data: d })));
    const r = prepass("pypi", await read(tops(["a", "b c"])), await read(tops(["a b", "c"])));
    expect(holds(r)).toContain("top dirs a b c");
  });

  test("a bundled node_modules member always holds, even when the old release had it", async () => {
    const nm = (body: string): E[] => [{ name: "node_modules/dep/index.js", type: "file", data: body }];
    const r = prepass("pypi", await read(rel("1.0.0", nm("module.exports=1\n"))), await read(rel("1.0.1", nm("require('child_process').execSync('id')\n"))));
    expect(holds(r)).toContain("node_modules x-1.0.1/node_modules/dep/index.js");
  });

  // Codex round 2: two paths of one release that normalize to one key leave one file in the map.
  test("a symlink on a normalized collision holds: demo-1.data/link and demo-2.data/link, only one retargeted", async () => {
    // Only the first one changes; the later, unchanged one is the file the map keeps.
    const links = (first: string): E[] => [...link("../a.txt"), { name: "demo-1.data/link", type: "sym", data: first }, { name: "demo-2.data/link", type: "sym", data: "../a.txt" }];
    const r = prepass("pypi", await read(rel("1.0.0", links("../a.txt"))), await read(rel("1.0.1", links("../b.txt"))));
    expect(holds(r)).toEqual(expect.arrayContaining(["symlink x-1.0.1/demo-1.data/link", "symlink x-1.0.1/demo-2.data/link"]));
  });

  test("a hardlink retargeted across a normalized collision holds: demo-1.data/a to demo-2.data/a", async () => {
    const files = (target: string): E[] => [{ name: "demo-1.data/a", type: "file", data: "a" }, { name: "demo-2.data/a", type: "file", data: "a" }, { name: "b.txt", type: "hard", data: target }];
    const r = prepass("pypi", await read(rel("1.0.0", files("x-1.0.0/demo-1.data/a"))), await read(rel("1.0.1", files("x-1.0.1/demo-2.data/a"))));
    expect(holds(r)).toContain("hardlink x-1.0.1/b.txt");
  });

  test("two artifacts with one pair label never share notes: the second sdist's changed link holds", async () => {
    const into = { old: new Map(), new: new Map() } as { old: Map<string, Uint8Array>; new: Map<string, Uint8Array> };
    const old = await read(rel("1.0.0", link("../a.txt")));
    mergeArtifactPair(into, "sdist", old, await read(rel("1.0.1", link("../a.txt"))));
    mergeArtifactPair(into, "sdist", old, await read(rel("1.0.1", link("../b.txt"))));
    const r = prepass("pypi", into.old, into.new);
    expect(holds(r)).toEqual(["sdist: symlink x-1.0.1/docs/link"]);
  });

  test("a link spelled x/./docs/link is the same note as x/docs/link: unchanged across versions it is carried over", async () => {
    const dotted = (extra: E[]) => extra.map((e) => (e.name === "docs/link" ? { ...e, name: "./docs/link" } : e));
    const r = prepass("pypi", await read(rel("1.0.0", dotted(link("../a.txt")))), await read(rel("1.0.1", link("../a.txt"))));
    expect(holds(r)).toEqual([]);
    expect(r.carriedTarNotes?.length).toBe(1);
    const s = prepass("pypi", await read(rel("1.0.0", link("../a.txt"))), await read(rel("1.0.1", dotted(link("../a.txt")))));
    expect(holds(s)).toEqual([]);
    expect(s.carriedTarNotes?.length).toBe(1);
  });

  // Codex round 3: a path collision with no note on it (a top dir pair, or two versioned .data dirs) read one file for two.
  test("a path collision is a hold of its own, with no other note: two top dirs, and demo-1.data/x beside demo-2.data/x", async () => {
    const tops = (payload: string) => tarBytes([{ name: "package/install.js", type: "file", data: payload }, { name: "other/install.js", type: "file", data: "// benign\n" }]);
    const r = prepass("pypi", await read(tops("// benign\n")), await read(tops("require('child_process').execSync('id')\n")));
    expect(holds(r)).toContain("path collision install.js (other/install.js, package/install.js)");
    const data = (body: string): E[] => [{ name: "demo-1.data/x", type: "file", data: body }, { name: "demo-2.data/x", type: "file", data: "x" }];
    const d = prepass("pypi", await read(rel("1.0.0", data("x"))), await read(rel("1.0.1", data("y"))));
    expect(holds(d)).toEqual(["path collision demo-VERSION.data/x (demo-1.data/x, demo-2.data/x)"]);
  });

  test("a note only the old release had does not hold", async () => {
    const r = prepass("pypi", await read(rel("1.0.0", link("../a.txt"))), await read(rel("1.0.1", link("../a.txt").slice(0, 2))));
    expect(holds(r)).toEqual([]);
  });
  test("NFC/NFD twin names are a case-fold collision that holds, though the old release had the same twins", async () => {
    // One filesystem stores the twins as one file (the map then reads only one), another writes both and imports one.
    const nfc = "pkg/\u00e9.py";
    const nfd = "pkg/e\u0301.py";
    const twins = (v: string, body: string) => rel(v, [{ name: nfc, type: "file", data: body }, { name: nfd, type: "file", data: "BENIGN\n" }]);
    const r = prepass("pypi", await read(twins("1.0.0", "BENIGN\n")), await read(twins("1.0.1", payload)));
    expect(holds(r).some((d) => d.startsWith("case-fold "))).toBe(true);
  });

  test("a Kelvin sign and a fullwidth letter fold onto their plain twins", async () => {
    for (const [a, b] of [["pkg/\u212aey.py", "pkg/key.py"], ["pkg/\uff41.py", "pkg/a.py"]] as const) {
      const files = (v: string) => rel(v, [{ name: a, type: "file", data: "x" }, { name: b, type: "file", data: "x" }]);
      const r = prepass("pypi", await read(files("1.0.0")), await read(files("1.0.1")));
      expect(holds(r).some((d) => d.startsWith("case-fold ")), a).toBe(true);
    }
  });

  // Codex round 6: the two top dirs are canonically one name in different case, so they merge on such a filesystem.
  const greek = (body: string) => tarBytes([
    { name: "\u0390/README.md", type: "file", data: "r" },
    { name: "\u0390/pkg/x.py", type: "file", data: body },
    { name: "\u03aa\u0301/pkg/x.py", type: "file", data: "BENIGN\n" },
  ]);

  test("twin directories canonically equal in another case are a case-fold collision that holds", async () => {
    const r = prepass("pypi", await read(greek("BENIGN\n")), await read(greek(payload)));
    expect(holds(r).some((d) => d.startsWith("case-fold "))).toBe(true);
  });

  test("foldKey matches whenever the decomposed lower-case names match", () => {
    const points = ["\u0390", "\u03aa\u0301", "\u03ca\u0301", "\u0399\u0308\u0301", "\u03b9\u0308\u0301", "\u03c2", "\u03c3", "\u03a3", "\u212a", "K", "k", "\u00df", "ss", "SS", "\u1e9e", "\u0131", "i", "I", "\u0130", "\uff41", "a", "A", "\u00e9", "e\u0301", "E\u0301", "\u00c9"];
    const names = points.flatMap((p) => [p, `x${p}`, `${p}x`, `d/${p}.py`, `${p}/${p}`]);
    const canon = (x: string) => x.normalize("NFD").toLowerCase();
    let pairs = 0;
    for (const a of names) for (const b of names) {
      if (canon(a) !== canon(b)) continue;
      pairs++;
      expect(foldKey(a), `${escape(a)} ${escape(b)}`).toBe(foldKey(b));
    }
    expect(pairs).toBeGreaterThan(names.length);
    expect(foldKey("\u212aey")).toBe(foldKey("key"));
    expect(foldKey("\u00df")).toBe(foldKey("SS"));
    expect(foldKey("\uff41")).toBe(foldKey("A"));
  });

  test("a member the tree does not hold under its own name marks each of its notes collided, and only those", () => {
    // A hand-built listing and tree, so both branches run on any filesystem: the twin stored as one file, and both kept.
    const nfc = "x/\u00e9.py";
    const nfd = "x/e\u0301.py";
    const listing = ["d---------  0 0 0 0 Jan  1  2020 x/", `-rw-r--r--  0 0 0 1 Jan  1  2020 ${nfc}`, `-rw-r--r--  0 0 0 1 Jan  1  2020 ${nfd}`];
    const members = ["x/", nfc, nfd];
    const notes = [
      { note: `non-ascii ${nfc}`, key: "a", kind: "non-ascii", raw: [nfc], paths: [nfc] },
      { note: `non-ascii ${nfd}`, key: "b", kind: "non-ascii", raw: [nfd], paths: [nfd] },
      { note: "symlink x/", key: "c", kind: "symlink", raw: ["x/"], paths: ["x"] },
    ];
    const one = new Map([[nfc, new Uint8Array([1])]]);
    expect([...unstoredMembers(listing, members, one)]).toEqual([nfd]);
    expect(markUnstored(notes, unstoredMembers(listing, members, one)).map((t) => [t.note, !!t.collided])).toEqual([[`non-ascii ${nfc}`, false], [`non-ascii ${nfd}`, true], ["symlink x/", false], [`not stored under its own name ${nfd}`, true]]);
    const both = new Map([[nfc, new Uint8Array([1])], [nfd, new Uint8Array([2])]]);
    expect([...unstoredMembers(listing, members, both)]).toEqual([]);
    expect(markUnstored(notes, unstoredMembers(listing, members, both)).map((t) => !!t.collided)).toEqual([false, false, false]);
  });

  test("with only HOME and PATH in the env, non-ascii and homoglyph names read as named and their notes hold", async () => {
    const odd = "d/\u0645\u0644\u0641.txt";
    const homoglyph = "invalid/gradl\u0435-wrapper.jar";
    const jar = { name: "invalid/gradle-wrapper.jar", type: "file" as const, data: "j" };
    const oldTar = join(dir, `${n++}-locale-old.tar`);
    const newTar = join(dir, `${n++}-locale-new.tar`);
    writeFileSync(oldTar, rel("1.0.0", [jar]));
    writeFileSync(newTar, rel("1.0.1", [jar, { name: odd, type: "file", data: "m" }, { name: homoglyph, type: "file", data: "j" }]));
    // A child run as a LaunchDaemon runs: the env holds only HOME and PATH, no LANG, LC_ALL or LC_CTYPE.
    const at = (f: string) => JSON.stringify(join(import.meta.dir, "../src", f));
    const code = [
      `const a = await import(${at("artifact.ts")});`,
      `const pp = await import(${at("prepass.ts")});`,
      `const m = await a.readArtifact(${JSON.stringify(newTar)});`,
      `const r = pp.prepass("pypi", a.normalizePaths(await a.readArtifact(${JSON.stringify(oldTar)})), a.normalizePaths(m));`,
      "console.log(JSON.stringify({ notes: pp.tarNoteEntries(m).map((t) => [t.note, !!t.collided]), holds: r.hard.filter((h) => h.kind === 'tar-entry').map((h) => h.detail).sort(), carried: r.carriedTarNotes ?? [] }));",
    ].join(" ");
    const child = Bun.spawnSync(["/usr/bin/env", "-i", `HOME=${process.env.HOME ?? ""}`, `PATH=${process.env.PATH ?? ""}`, process.execPath, "-e", code], { stdout: "pipe", stderr: "pipe" });
    expect(new TextDecoder().decode(child.stderr)).toBe("");
    const out = JSON.parse(new TextDecoder().decode(child.stdout));
    expect(out.notes).toContainEqual([`non-ascii x-1.0.1/${odd}`, false]);
    expect(out.notes).toContainEqual([`non-ascii x-1.0.1/${homoglyph}`, false]);
    expect(out.holds).toEqual([`non-ascii x-1.0.1/${odd}`, `non-ascii x-1.0.1/${homoglyph}`].sort());
    expect(out.carried).toEqual([]);
  });

  // Codex round 7: npm's strip drops the first component, so names distinct in the archive become twins after it.
  for (const [label, a, b] of [["case", "one/Dir/x.py", "two/dir/x.py"], ["form", "one/\u00e9/x.py", "two/e\u0301/x.py"]] as const) {
    test(`two members that become ${label} twins only after the strip are a case-fold collision that holds`, async () => {
      const files = (body: string) => tarBytes([{ name: a, type: "file", data: body }, { name: b, type: "file", data: "BENIGN\n" }]);
      const r = prepass("pypi", await read(files("BENIGN\n")), await read(files(payload)));
      expect(holds(r).some((d) => d.startsWith("case-fold "))).toBe(true);
      // Only the top-dir note, which names no file, carries: each note on a twin is collided.
      expect(r.carriedTarNotes ?? []).toEqual(["top dirs one two"]);
    });
  }

  // A bsdtar that lacks a locale prints this line, keeps the C locale and exits 0. The stand-in lacks C.UTF-8 only, or
  // every locale, and is first on PATH in a child whose env holds only HOME and PATH.
  const lacking = (mode: "c-utf8" | "all") => {
    const bin = join(dir, `bin-${mode}`);
    mkdirSync(bin, { recursive: true });
    const real = Bun.which("bsdtar")!;
    const lacks = mode === "all" ? "true" : '[ "$LC_ALL" = "C.UTF-8" ]';
    writeFileSync(join(bin, "bsdtar"), `#!/bin/sh\nif ${lacks}; then echo "bsdtar: Failed to set default locale" >&2; LC_ALL=C exec ${real} "$@"; fi\nexec ${real} "$@"\n`, { mode: 0o755 });
    return bin;
  };
  const prepassIn = (bin: string, oldTar: string, newTar: string) => {
    const at = (x: string) => JSON.stringify(join(import.meta.dir, "../src", x));
    const code = [
      `const a = await import(${at("artifact.ts")});`,
      `const pp = await import(${at("prepass.ts")});`,
      `const r = pp.prepass("pypi", a.normalizePaths(await a.readArtifact(${JSON.stringify(oldTar)})), a.normalizePaths(await a.readArtifact(${JSON.stringify(newTar)})));`,
      "console.log(JSON.stringify({ holds: r.hard.filter((h) => h.kind === 'tar-entry').map((h) => h.detail).sort(), carried: r.carriedTarNotes ?? [] }));",
    ].join(" ");
    const child = Bun.spawnSync(["/usr/bin/env", "-i", `HOME=${process.env.HOME ?? ""}`, `PATH=${bin}:${process.env.PATH ?? ""}`, process.execPath, "-e", code], { stdout: "pipe", stderr: "pipe" });
    expect(new TextDecoder().decode(child.stderr)).toBe("");
    return JSON.parse(new TextDecoder().decode(child.stdout)) as { holds: string[]; carried: string[] };
  };
  const localePair = () => {
    const jar = { name: "invalid/gradle-wrapper.jar", type: "file" as const, data: "j" };
    const oldTar = join(dir, `${n++}-lc-old.tar`);
    const newTar = join(dir, `${n++}-lc-new.tar`);
    writeFileSync(oldTar, rel("1.0.0", [jar, { name: "pkg/\u00e9.py", type: "file", data: "BENIGN\n" }]));
    writeFileSync(newTar, rel("1.0.1", [jar, { name: "pkg/\u00e9.py", type: "file", data: payload }]));
    return [oldTar, newTar] as const;
  };

  test("a bsdtar without C.UTF-8 is run under another UTF-8 locale it has, so a non-ascii name is read as named", () => {
    const [oldTar, newTar] = localePair();
    const r = prepassIn(lacking("c-utf8"), oldTar, newTar);
    expect(r.holds).toEqual([]);
    expect(r.carried).toEqual(["non-ascii x-1.0.1/pkg/\u00e9.py"]);
  });

  test("a bsdtar with no UTF-8 locale at all holds: the names it lists are escapes", () => {
    const [oldTar, newTar] = localePair();
    const r = prepassIn(lacking("all"), oldTar, newTar);
    expect(r.holds).toContain("unreadable tar entry names (bsdtar has no UTF-8 locale)");
    // The escapes are read back to the name's bytes, so the note is on the right name; the listing still holds.
    expect(r.carried).toEqual(["non-ascii x-1.0.1/pkg/\u00e9.py"]);
  });

  // Codex round 8: an inner "./" or a repeated "/" is collapsed on disk, so the member is found and the twin seen.
  for (const [label, a] of [["an inner ./", "one/Dir/./\u00e9.py"], ["a repeated /", "one/Dir//\u00e9.py"]] as const) {
    test(`a member spelled with ${label} becomes a twin after the strip and holds`, async () => {
      const files = (body: string) => tarBytes([{ name: a, type: "file", data: body }, { name: "two/dir/\u00e9.py", type: "file", data: "BENIGN\n" }]);
      const r = prepass("pypi", await read(files("BENIGN\n")), await read(files(payload)));
      expect(holds(r)).toContain("case-fold Dir dir");
      expect(r.carriedTarNotes ?? []).toEqual(["top dirs one two"]);
    });
  }

  test("case twins in a map with no tar member list still get a fold note after the move", () => {
    const zip: Map<string, Uint8Array> = new Map([["pkg/Foo.py", new Uint8Array([1])], ["pkg/foo.py", new Uint8Array([2])]]);
    expect(tarNoteEntries(normalizePaths(zip)).map((t) => [t.note, !!t.collided])).toEqual([["case-fold Foo.py foo.py", true]]);
  });

  // A stored (uncompressed) zip with UTF-8 names, members in the order given: two names a folding filesystem writes as one.
  // `stored`: the data bytes as written (else `data`, stored); `method`/`localMethod`: the central and local method.
  type ZipIn = { name: string; data: string; mode?: number; extra?: Uint8Array; flags?: number; stored?: Uint8Array; method?: number; localMethod?: number; crc?: number; usize?: number; madeBy?: number; needs?: number; localFlags?: number };
  // `prefix`: bytes before the archive (a stub); `zip64`: a ZIP64 end record and locator before the ordinary end record.
  // `count`: the end record's entry count, when it should not match the directory.
  const zipBytes = (entries: ZipIn[], opts: { prefix?: string; zip64?: boolean; zip64Mode?: number; count?: number; prefixBytes?: Uint8Array } = {}): Uint8Array => {
    const enc = new TextEncoder();
    const parts: Uint8Array[] = [];
    const central: Uint8Array[] = [];
    let off = 0;
    for (const e of entries) {
      const name = enc.encode(e.name);
      const data = e.stored ?? enc.encode(e.data);
      const crc = e.crc ?? Bun.hash.crc32(data) >>> 0;
      const usize = e.usize ?? data.length;
      const extra = e.extra ?? new Uint8Array();
      const flags = e.flags ?? 0x0800;
      const local = new DataView(new ArrayBuffer(30));
      [[0, 0x04034b50, 4], [4, 20, 2], [6, e.localFlags ?? flags, 2], [8, e.localMethod ?? e.method ?? 0, 2], [10, 0, 2], [12, 0x21, 2], [14, crc, 4], [18, data.length, 4], [22, usize, 4], [26, name.length, 2], [28, extra.length, 2]].forEach(([o, v, w]) => (w === 4 ? local.setUint32(o!, v!, true) : local.setUint16(o!, v!, true)));
      const cd = new DataView(new ArrayBuffer(46));
      [[0, 0x02014b50, 4], [4, e.madeBy ?? 0x0314, 2], [6, e.needs ?? 20, 2], [8, flags, 2], [10, e.method ?? 0, 2], [12, 0, 2], [14, 0x21, 2], [16, crc, 4], [20, data.length, 4], [24, usize, 4], [28, name.length, 2], [30, extra.length, 2], [32, 0, 2], [34, 0, 2], [36, 0, 2], [38, ((e.mode ?? 0o100644) << 16) >>> 0, 4], [42, off, 4]].forEach(([o, v, w]) => (w === 4 ? cd.setUint32(o!, v!, true) : cd.setUint16(o!, v!, true)));
      parts.push(new Uint8Array(local.buffer), name, extra, data);
      central.push(new Uint8Array(cd.buffer), name, extra);
      off += 30 + name.length + extra.length + data.length;
    }
    const cdSize = central.reduce((n, c) => n + c.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    [[0, 0x06054b50, 4], [4, 0, 2], [6, 0, 2], [8, opts.count ?? entries.length, 2], [10, opts.count ?? entries.length, 2], [12, cdSize, 4], [16, off, 4], [20, 0, 2]].forEach(([o, v, w]) => (w === 4 ? end.setUint32(o!, v!, true) : end.setUint16(o!, v!, true)));
    const z64: Uint8Array[] = [];
    // zip64Mode: the ZIP64 record names a second directory, the same entries with the last one in that mode; the
    // ordinary end record names the first.
    let z64Offset = off;
    let z64Size = cdSize;
    if (opts.zip64Mode !== undefined) {
      const alt = central.map((c) => c.slice());
      // The mode goes on the last member only: an empty member with a link mode is a link with no target, which Linux
      // libarchive will not write.
      new DataView(alt[alt.length - 3]!.buffer).setUint32(38, (opts.zip64Mode << 16) >>> 0, true);
      z64.push(...alt);
      z64Offset = off + cdSize;
      z64Size = alt.reduce((n, c) => n + c.length, 0);
    }
    if (opts.zip64 || opts.zip64Mode !== undefined) {
      const rec = new DataView(new ArrayBuffer(56));
      rec.setUint32(0, 0x06064b50, true);
      rec.setBigUint64(4, 44n, true);
      rec.setUint16(12, 45, true);
      rec.setUint16(14, 45, true);
      rec.setBigUint64(24, BigInt(entries.length), true);
      rec.setBigUint64(32, BigInt(entries.length), true);
      rec.setBigUint64(40, BigInt(z64Size), true);
      rec.setBigUint64(48, BigInt(z64Offset), true);
      const loc = new DataView(new ArrayBuffer(20));
      loc.setUint32(0, 0x07064b50, true);
      loc.setBigUint64(8, BigInt(z64Offset + z64Size), true);
      loc.setUint32(16, 1, true);
      z64.push(new Uint8Array(rec.buffer), new Uint8Array(loc.buffer));
    }
    const all = [opts.prefixBytes ?? new TextEncoder().encode(opts.prefix ?? ""), ...parts, ...central, ...z64, new Uint8Array(end.buffer)];
    const out = new Uint8Array(all.reduce((n, c) => n + c.length, 0));
    let at = 0;
    for (const c of all) {
      out.set(c, at);
      at += c.length;
    }
    return out;
  };
  const readZip = async (bytes: Uint8Array) => {
    const p = join(dir, `${n++}-w.zip`);
    writeFileSync(p, bytes);
    return normalizePaths(await readArtifact(p));
  };

  // A wheel's twins unpack to one file on a folding filesystem; a Linux install writes both, and imports either.
  for (const [label, a, b] of [["NFC/NFD", "pkg/\u00e9.py", "pkg/e\u0301.py"], ["case", "pkg/foo.py", "pkg/FOO.py"]] as const) {
    for (const payloadFirst of [true, false]) {
      test(`zip ${label} twins hold with the payload member ${payloadFirst ? "first" : "second"}`, async () => {
        const wheel = (evil: boolean) => {
          const one = { name: a, data: evil && payloadFirst ? payload : "BENIGN\n" };
          const two = { name: b, data: evil && !payloadFirst ? payload : "BENIGN\n" };
          return zipBytes([one, two, { name: "pkg/__init__.py", data: "" }]);
        };
        const r = prepass("pypi", await readZip(wheel(false)), await readZip(wheel(true)));
        // bsdtar on macOS lists both forms of a zip name in one form (a repeated name); elsewhere they are twins.
        expect(holds(r).some((d) => d.startsWith("case-fold ") || d.startsWith("duplicate path "))).toBe(true);
        expect(r.carriedTarNotes ?? []).toEqual([]);
      });
    }
  }

  test("a zip with no twins gets no name note: its root module and non-ascii name are what a wheel holds", async () => {
    const wheel = () => zipBytes([{ name: "six.py", data: "x" }, { name: "pkg/\u00e9.py", data: "y" }]);
    const r = prepass("pypi", await readZip(wheel()), await readZip(wheel()));
    expect(holds(r)).toEqual([]);
  });

  // Opus round 9: bsdtar prints a backslash as \\ and a control character as \ooo even under a UTF-8 locale.
  test("a member name with a backslash or a tab is read back to its own name, so it is not an unstored member", async () => {
    const files = () => rel("1.0.0", [{ name: "pkg/a\\b.py", type: "file", data: "x" }, { name: "pkg/c\td.py", type: "file", data: "y" }]);
    const r = prepass("pypi", await read(files()), await read(files()));
    expect(holds(r)).toEqual([]);
    expect(unescapeMember("pkg/a\\\\b\\011c\\303\\251\\td.py")).toBe("pkg/a\\b\tc\u00e9\td.py");
  });

  // pip reads a wheel with Python's zipfile, oUpdate with bsdtar: each member they read otherwise holds.
  const unicodePath = (header: string, shown: string) => {
    const name = new TextEncoder().encode(shown);
    const x = new DataView(new ArrayBuffer(4 + 5 + name.length));
    x.setUint16(0, 0x7075, true);
    x.setUint16(2, 5 + name.length, true);
    x.setUint8(4, 1);
    x.setUint32(5, Bun.hash.crc32(new TextEncoder().encode(header)) >>> 0, true);
    const out = new Uint8Array(x.buffer);
    out.set(name, 9);
    return out;
  };
  const distInfo = (files: string[]): ZipIn[] => [
    { name: "x-1.0.dist-info/WHEEL", data: "Wheel-Version: 1.0\n" },
    { name: "x-1.0.dist-info/METADATA", data: "Name: x\n" },
    { name: "x-1.0.dist-info/RECORD", data: [...files, "x-1.0.dist-info/WHEEL", "x-1.0.dist-info/METADATA", "x-1.0.dist-info/RECORD"].map((p) => `${p},,\n`).join("") },
  ];
  const zipHolds = async (old: ZipIn[], now: ZipIn[], opts: { prefix?: string; zip64?: boolean; zip64Mode?: number } = {}) => holds(prepass("pypi", await readZip(zipBytes(old, opts)), await readZip(zipBytes(now, opts))));
  const plain: ZipIn[] = [{ name: "pkg/__init__.py", data: "" }, { name: "pkg/\u00e9.py", data: "e" }, { name: "README.txt", data: "r" }];

  test("a clean wheel whose RECORD matches its members has no zip member hold", async () => {
    const wheel = [...plain, ...distInfo(plain.map((e) => e.name))];
    expect(await zipHolds(wheel, wheel)).toEqual([]);
  });

  test("a Unicode Path extra that names a member otherwise to bsdtar holds, and RECORD's name for it is not in the tree", async () => {
    const old = [...plain, ...distInfo(plain.map((e) => e.name))];
    const evil = [{ name: "pkg/__init__.py", data: "" }, { name: "pkg/\u00e9.py", data: "e" }, { name: "evil.pth", data: payload, extra: unicodePath("evil.pth", "README.txt") }];
    const h = await zipHolds(old, [...evil, ...distInfo(evil.map((e) => e.name))]);
    expect(h).toContain("zip member evil.pth: a Unicode Path or Comment extra field names it otherwise to bsdtar");
    expect(h).toContain("zip member evil.pth: the wheel RECORD names it, the unpacked archive has no such file");
  });

  test("a backslash in a zip member name holds: pip writes it as part of one top-level file name", async () => {
    const old = [...plain, ...distInfo(plain.map((e) => e.name))];
    const evil = [...plain, { name: "pkg\\evil.py", data: payload }];
    expect(await zipHolds(old, [...evil, ...distInfo(evil.map((e) => e.name))])).toContain("zip member pkg\\evil.py: a backslash in the name (pip writes it as part of the file name)");
  });

  for (const [label, mode] of [["a directory", 0o040755], ["a symlink", 0o120777]] as const) {
    test(`a zip file member whose mode says ${label} holds: pip writes a regular file with its data`, async () => {
      const old = [...plain, { name: "pkg/evil.py", data: "BENIGN\n" }];
      const now = [...plain, { name: "pkg/evil.py", data: payload, mode }];
      expect(await zipHolds([...old, ...distInfo(old.map((e) => e.name))], [...now, ...distInfo(now.map((e) => e.name))])).toContain(`zip member pkg/evil.py: mode ${mode.toString(8)} is not a regular file, which pip writes`);
    });
  }

  test("a zip behind a prepended stub gets every zip check: a directory mode on a file member holds", async () => {
    const old = [...plain, { name: "victim.py", data: "BENIGN\n", mode: 0o040755 }];
    const now = [...plain, { name: "victim.py", data: payload, mode: 0o040755 }];
    const h = await zipHolds([...old, ...distInfo(old.map((e) => e.name))], [...now, ...distInfo(now.map((e) => e.name))], { prefix: "STUB" });
    expect(h).toContain("zip member victim.py: mode 40755 is not a regular file, which pip writes");
  });

  test("a clean wheel behind a prepended stub has no hold", async () => {
    const wheel = [...plain, ...distInfo(plain.map((e) => e.name))];
    expect(await zipHolds(wheel, wheel, { prefix: "STUB" })).toEqual([]);
  });

  test("a small zip with a ZIP64 end record its ordinary fields do not need is read, not held as unreadable", async () => {
    const one = [{ name: "pkg/__init__.py", data: "x" }];
    expect(await zipHolds(one, one, { zip64: true })).toEqual([]);
  });

  test("a ZIP64 record is used whenever its locator is there: its directory's symlink mode holds", async () => {
    const files = [{ name: "pkg/__init__.py", data: "" }, { name: "pkg/a.py", data: "x" }];
    const h = await zipHolds(files, files, { zip64Mode: 0o120777 });
    expect(h).toContain("zip member pkg/a.py: mode 120777 is not a regular file, which pip writes");
    // A reader that takes the ordinary end record sees the first directory: the two records disagreeing holds too.
    expect(h.some((d) => d.startsWith("zip member (archive): the end records and the directory disagree: the end record names"))).toBe(true);
  });

  test("a member whose local method differs from the central one holds, and so does content zipfile reads otherwise", () => {
    // Local header says deflate, central says stored: bsdtar inflates, zipfile reads the deflate bytes as the file.
    const benign = new TextEncoder().encode("VALUE = 'benign'\n");
    const deflated = new Uint8Array(require("node:zlib").deflateRawSync(benign));
    const p = join(dir, `${n++}-method.zip`);
    writeFileSync(p, zipBytes([{ name: "x/__init__.py", data: "", stored: deflated, method: 0, localMethod: 8 }]));
    const notes = zipNameNotes(p, ["x/__init__.py"], new Map([["x/__init__.py", benign]])).map((t) => t.note);
    expect(notes).toContain("zip member x/__init__.py: local and central headers differ: local method 8, central 0");
    expect(notes).toContain("zip member x/__init__.py: content zipfile reads differs from the extracted file");
  });

  test("a deflated member zipfile and bsdtar read alike adds no note", () => {
    const body = new TextEncoder().encode("VALUE = 'same'\n".repeat(20));
    const deflated = new Uint8Array(require("node:zlib").deflateRawSync(body));
    const p = join(dir, `${n++}-deflate.zip`);
    writeFileSync(p, zipBytes([{ name: "x/__init__.py", data: "", stored: deflated, method: 8, crc: Bun.hash.crc32(body) >>> 0, usize: body.length }]));
    expect(zipNameNotes(p, ["x/__init__.py"], new Map([["x/__init__.py", body]]))).toEqual([]);
  });

  // A ustar tar with ./pkg/mod.py benign, then a zip with ./pkg/mod.py as the payload. bsdtar reads
  // the tar, pip the zip.
  test("a tar that is also a zip holds, and the zip's ./ member is compared at the path it is written to", async () => {
    const meta = (v: string): E[] => [{ name: "pkg/__init__.py", type: "file", data: "" }, { name: `x-${v}.dist-info/METADATA`, type: "file", data: "Name: x\n" }];
    const tarHalf = tarBytes([{ name: "./pkg/mod.py", type: "file", data: "VALUE = 0\n" }, ...meta("1.0")]);
    const zipped = (body: string, prefixBytes?: Uint8Array) => zipBytes([{ name: "./pkg/mod.py", data: body }, { name: "pkg/__init__.py", data: "" }, { name: "x-1.0.dist-info/METADATA", data: "Name: x\n" }], { prefixBytes });
    const p = join(dir, `${n++}-poly.whl`);
    writeFileSync(p, zipped(payload, tarHalf));
    const notes = tarNoteEntries(await readArtifact(p)).map((t) => t.note);
    expect(notes).toContain("a tar that is also a zip: bsdtar reads one (POSIX ustar format), zipfile the other");
    expect(notes).toContain("zip member ./pkg/mod.py: content zipfile reads differs from the extracted file");
  });

  test("a tar behind a stub, then a zip, holds: the bytes before the zip hold a tar header", async () => {
    const tarHalf = tarBytes([{ name: "./pkg/mod.py", type: "file", data: "VALUE = 0\n" }]);
    const stub = new TextEncoder().encode("#!/bin/sh\nexit 0\n");
    const pre = new Uint8Array(stub.length + tarHalf.length);
    pre.set(stub);
    pre.set(tarHalf, stub.length);
    const p = join(dir, `${n++}-stubpoly.whl`);
    writeFileSync(p, zipBytes([{ name: "./pkg/mod.py", data: payload }, { name: "pkg/__init__.py", data: "" }], { prefixBytes: pre }));
    expect(tarNoteEntries(await readArtifact(p)).map((t) => t.note)).toContain("zip member (archive): a tar header sits before the zip: bsdtar can read the tar, zipfile reads the zip");
  });

  for (const scheme of ["purelib", "platlib"]) {
    test(`a .data/${scheme} member and a root member at one path hold: pip writes the .data copy over the root one`, () => {
      const p = join(dir, `${n++}-datawins-${scheme}.zip`);
      const names = ["pkg/a.py", `x-1.0.data/${scheme}/pkg/a.py`, "pkg/__init__.py"];
      writeFileSync(p, zipBytes([{ name: names[0]!, data: "GOOD\n" }, { name: names[1]!, data: payload }, { name: names[2]!, data: "" }]));
      const body = (m: string) => (m === "pkg/__init__.py" ? "" : m === "pkg/a.py" ? "GOOD\n" : payload);
      const tree = new Map<string, Uint8Array>(names.map((m) => [m, new TextEncoder().encode(body(m))] as const));
      const notes = zipNameNotes(p, names, tree).map((t) => t.note);
      expect(notes.some((m) => m.startsWith(`zip member x-1.0.data/${scheme}/pkg/a.py: two members zipfile reads are written at pkg/a.py (pip installs a .data`))).toBe(true);
    });
  }

  test("a .data scripts member beside a root member of the same subpath is two files, not one", () => {
    const p = join(dir, `${n++}-datascripts.zip`);
    writeFileSync(p, zipBytes([{ name: "pkg/a.py", data: "A" }, { name: "x-1.0.data/scripts/pkg/a.py", data: "B" }]));
    const names = ["pkg/a.py", "x-1.0.data/scripts/pkg/a.py"];
    const tree = new Map<string, Uint8Array>([["pkg/a.py", new TextEncoder().encode("A")], ["x-1.0.data/scripts/pkg/a.py", new TextEncoder().encode("B")]]);
    expect(zipNameNotes(p, names, tree).map((t) => t.note).filter((m) => m.includes("two members"))).toEqual([]);
  });

  // The "two members ... written at" notes for a wheel of these members (each holding its own name as data).
  // `purelib`: the wheel's Root-Is-Purelib value, in a WHEEL file added to the member list (pip's root is platlib unless true).
  const writerNotes = (label: string, members: string[], purelib = "true", wheelBody?: string) => {
    const names = members.includes("x-1.0.dist-info/WHEEL") ? members : [...members, "x-1.0.dist-info/WHEEL"];
    const body = (name: string) => (name === "x-1.0.dist-info/WHEEL" ? wheelBody ?? `Wheel-Version: 1.0\nRoot-Is-Purelib: ${purelib}\n` : name);
    const p = join(dir, `${n++}-${label}.whl`);
    writeFileSync(p, zipBytes(names.map((name) => ({ name, data: body(name) }))));
    const tree = new Map<string, Uint8Array>(names.map((name) => [name.split("/").filter((x) => x !== "" && x !== ".").join("/"), new TextEncoder().encode(body(name))] as const));
    return zipNameNotes(p, names, tree).map((t) => t.note).filter((m) => m.includes("two members zipfile reads are written at") || m.includes("pip --target replaces"));
  };
  const collide = (label: string, names: string[], atLeast = 2, purelib = "true") => test(`${label}: two members pip writes to one file hold`, () => expect(writerNotes("collide", names, purelib).length).toBeGreaterThanOrEqual(atLeast));
  const cleanBody = (label: string, names: string[], wheelBody: string) => test(`${label}: not held`, () => expect(writerNotes("cleanbody", names, "true", wheelBody)).toEqual([]));
  const collideBody = (label: string, names: string[], wheelBody: string) => test(`${label}: held`, () => expect(writerNotes("collidebody", names, "true", wheelBody).length).toBeGreaterThanOrEqual(1));
  const clean = (label: string, names: string[], purelib = "true") => test(`${label}: not held`, () => expect(writerNotes("clean", names, purelib)).toEqual([]));

  collide("a .data/purelib copy in another case than the root member", ["pkg/a.py", "x-1.0.data/purelib/PKG/a.py"]);
  collide("a .data/platlib copy with a case-twin file name", ["pkg/a.py", "x-1.0.data/platlib/pkg/A.py"]);
  collide("a .data/data member through lib/python3.9/site-packages", ["pkg/a.py", "x-1.0.data/data/lib/python3.9/site-packages/pkg/a.py"]);
  collide("a .data/data member through lib64/python3.12/dist-packages", ["pkg/a.py", "x-1.0.data/data/lib64/python3.12/dist-packages/pkg/a.py"]);
  collide("a .data/data member through Lib/site-packages", ["pkg/a.py", "x-1.0.data/data/Lib/site-packages/pkg/a.py"]);
  collide("a .data/data member through lib/python/ (the --target layout)", ["pkg/a.py", "x-1.0.data/data/lib/python/pkg/a.py"]);
  collide("a .data/scripts member whose path goes through site-packages", ["pkg/a.py", "x-1.0.data/scripts/site-packages/pkg/a.py"]);
  collide("a .data/data/bin member and a .data/scripts member", ["x-1.0.data/scripts/foo", "x-1.0.data/data/bin/foo"]);
  collide("a .data/data/include/site member and a .data/headers member", ["x-1.0.data/headers/h.h", "x-1.0.data/data/include/site/python3.9/x/h.h"]);
  collide("a .data/data/Include/Site/Python3.9 member (other case) and a .data/headers member", ["x-1.0.data/headers/h.h", "x-1.0.data/data/Include/Site/Python3.9/x/h.h"]);
  collide("a .data/data/BIN member and a .data/scripts member", ["x-1.0.data/scripts/run", "x-1.0.data/data/BIN/run"]);
  collide("a .data/data/Lib/Python/ member (other case) and a root member", ["pkg/a.py", "x-1.0.data/data/LIB/PYTHON/pkg/a.py"]);
  collide("a .data/data/include/python3.9/<dist> member (--prefix, --user) and a .data/headers member", ["x-1.0.data/headers/h.h", "x-1.0.data/data/include/python3.9/demo/h.h"]);
  collide("a .data/data/include/python/<dist> member (--home) and a .data/headers member", ["x-1.0.data/headers/h.h", "x-1.0.data/data/include/python/demo/h.h"]);
  collide("a .data/data/Include/<dist> member (Windows) and a .data/headers member", ["x-1.0.data/headers/h.h", "x-1.0.data/data/Include/demo/h.h"]);
  collide("a .data/data/Python39/Scripts member (the Windows user layout) and a .data/scripts member", ["x-1.0.data/scripts/run", "x-1.0.data/data/Python39/Scripts/run"]);
  collide("a .data/data/Python39/Include/<dist> member (the Windows user layout) and a .data/headers member", ["x-1.0.data/headers/h.h", "x-1.0.data/data/Python39/Include/x/h.h"]);
  collide("a .data/data/Scripts member (Windows) and a .data/scripts member", ["x-1.0.data/scripts/tool", "x-1.0.data/data/Scripts/tool"]);
  collide("a .data/data member and a root member at one path (--target merges them, the .data copy wins)", ["pkg/a.py", "x-1.0.data/data/pkg/a.py"], 1);
  collide("a .data/data directory that replaces the root directory of the same name on a --target upgrade", ["pkg/__init__.py", "x-1.0.data/data/pkg/c.py"], 1);
  collide("a .data/scripts member that replaces the root bin/ on a --target upgrade", ["bin/tool", "x-1.0.data/scripts/tool"], 1);
  collide("a .data/headers member that replaces the root include/ on a --target upgrade", ["include/h.h", "x-1.0.data/headers/other.h"], 1);
  collide("a .data/data/scripts member and a root scripts/ directory (--target upgrade leaves the payload)", ["scripts/x.py", "x-1.0.data/data/scripts/__init__.py"], 1);
  collide("a .data/data/python39/Scripts member and a root python39/ directory", ["python39/x.py", "x-1.0.data/data/python39/Scripts/run"], 1);
  collide("a .data/scripts member and a root Scripts/ directory (Windows --target)", ["Scripts/tool", "x-1.0.data/scripts/tool"], 1);
  collide("a .data/scripts member under lib/python/ and a .data/data/bin member at the same path", ["x-1.0.data/scripts/lib/python/pkg/a.py", "x-1.0.data/data/bin/lib/python/pkg/a.py"]);
  collide("a Python313-32 user directory (32-bit) before Scripts", ["x-1.0.data/scripts/run", "x-1.0.data/data/Python313-32/Scripts/run"]);
  collide("a Python313t user directory (free-threaded) before Include", ["x-1.0.data/headers/h.h", "x-1.0.data/data/Python313t/Include/x/h.h"]);

  test("a path component that ends in a period or a space holds: Windows reads it as the name without it", () => {
    const p = join(dir, `${n++}-winname.zip`);
    const names = ["pkg/a.py", "x-1.0.data/purelib/pkg/a.py.", "pkg /b.py", "./pkg/ok.py"];
    writeFileSync(p, zipBytes(names.map((name) => ({ name, data: name }))));
    const tree = new Map<string, Uint8Array>(names.map((name) => [name.split("/").filter((x) => x !== "" && x !== ".").join("/"), new TextEncoder().encode(name)] as const));
    const notes = zipNameNotes(p, names, tree).map((x) => x.note);
    expect(notes).toContain('zip member x-1.0.data/purelib/pkg/a.py.: a path component ends in a period or space ("a.py."), which Windows reads as the name without it');
    expect(notes).toContain('zip member pkg /b.py: a path component ends in a period or space ("pkg "), which Windows reads as the name without it');
    expect(notes.filter((m) => m.includes("pkg/ok.py") && m.includes("period or space"))).toEqual([]);
  });

  collide("a .data/data path through site-packages and the same path kept as a data path under a root directory", ["pkg/site-packages/zzz.py", "x-1.0.data/data/pkg/site-packages/zzz.py"], 1);
  collide("a .data/data Python39/Scripts member and a root Python39/ directory", ["Python39/t.py", "x-1.0.data/data/Python39/Scripts/t.py"], 1);
  collide("a .data/platlib member beside a root member of the same directory (--target drops one)", ["pkg/__init__.py", "x-1.0.data/platlib/pkg/_impl.py"], 1);
  collide("a .data/purelib member beside a root member when the root is platlib (Root-Is-Purelib false)", ["pkg/__init__.py", "x-1.0.data/purelib/pkg/_impl.py"], 1, "false");
  // pip reads WHEEL as email headers and needs the first Root-Is-Purelib value to be "true"; any other shape is an unknown root home.
  const rootAndData = ["pkg/a.py", "x-1.0.data/purelib/pkg/b.py"];
  collideBody("Root-Is-Purelib: true with a trailing space", rootAndData, "Wheel-Version: 1.0\nRoot-Is-Purelib: true \n");
  collideBody("Root-Is-Purelib false then true (pip takes the first)", rootAndData, "Wheel-Version: 1.0\nRoot-Is-Purelib: false\nRoot-Is-Purelib: true\n");
  collideBody("Root-Is-Purelib true after a blank line (body text to pip)", rootAndData, "Wheel-Version: 1.0\n\nRoot-Is-Purelib: true\n");
  collideBody("Root-Is-Purelib folded onto a continuation line", rootAndData, "Wheel-Version: 1.0\nRoot-Is-Purelib:\n true\n");
  collideBody("no Root-Is-Purelib header", rootAndData, "Wheel-Version: 1.0\n");
  collideBody("a header name with a space before Root-Is-Purelib (pip ends the headers there)", rootAndData, "Wheel-Version: 1.0\nBad Name: x\nRoot-Is-Purelib: true\n");
  collideBody("a NUL in a header name before Root-Is-Purelib", rootAndData, "Wheel-Version: 1.0\nG\u0000: x\nRoot-Is-Purelib: true\n");
  collideBody("a BOM before the first header", rootAndData, "\uFEFFWheel-Version: 1.0\nRoot-Is-Purelib: true\n");
  collideBody("a control character inside a header value", rootAndData, "Wheel-Version: 1.\u00010\nRoot-Is-Purelib: true\n");
  collideBody("a tab inside a header value is not printable ASCII", rootAndData, "Wheel-Version: 1\t0\nRoot-Is-Purelib: true\n");
  // pip reads the WHEEL of the one raw top-level .dist-info directory; a second WHEEL reached through ./ is not the one it reads.
  test("a WHEEL behind ./ in another dist-info does not decide the root home: pip reads the raw top-level one", () => {
    const names = ["pkg/a.py", "x-1.0.data/purelib/pkg/b.py", "x-1.0.dist-info/WHEEL", "./y-1.0.dist-info/WHEEL"];
    const body = (name: string) => (name === "x-1.0.dist-info/WHEEL" ? "Wheel-Version: 1.0\nRoot-Is-Purelib: false\n" : name.endsWith("WHEEL") ? "Wheel-Version: 1.0\nRoot-Is-Purelib: true\n" : name);
    const p = join(dir, `${n++}-wheelpick.whl`);
    writeFileSync(p, zipBytes(names.map((name) => ({ name, data: body(name) }))));
    const tree = new Map<string, Uint8Array>(names.map((name) => [name.split("/").filter((x) => x !== "" && x !== ".").join("/"), new TextEncoder().encode(body(name))] as const));
    expect(zipNameNotes(p, names, tree).map((x) => x.note).filter((m) => m.includes("pip --target replaces")).length).toBeGreaterThanOrEqual(1);
  });
  collideBody("a From line inside the header block (pip's parser skips it)", rootAndData, "Wheel-Version: 1.0\nFrom x\nRoot-Is-Purelib: true\n");
  collideBody("a header name with a space (Built By) before Root-Is-Purelib", rootAndData, "Wheel-Version: 1.0\nBuilt By: t\nRoot-Is-Purelib: true\n");
  collideBody("a non-ASCII header name before Root-Is-Purelib", rootAndData, "Wheel-Version: 1.0\nG\u00e9n\u00e9rateur: t\nRoot-Is-Purelib: true\n");
  cleanBody("a plain Root-Is-Purelib: true with CRLF line ends and the same members: merged", rootAndData, "Wheel-Version: 1.0\r\nRoot-Is-Purelib: true\r\n");
  // A console_scripts or gui_scripts launcher pip generates replaces a .data/scripts member of the same name.
  const launcherNotes = (entryPoints: string, members: string[]) => {
    const names = [...members, "x-1.0.dist-info/WHEEL", "x-1.0.dist-info/RECORD", "x-1.0.dist-info/entry_points.txt"];
    const body = (name: string) => (name === "x-1.0.dist-info/WHEEL" ? "Wheel-Version: 1.0\nRoot-Is-Purelib: true\n" : name === "x-1.0.dist-info/entry_points.txt" ? entryPoints : name === "x-1.0.dist-info/RECORD" ? "" : name);
    const p = join(dir, `${n++}-launcher.whl`);
    writeFileSync(p, zipBytes(names.map((name) => ({ name, data: body(name) }))));
    const tree = new Map<string, Uint8Array>(names.map((name) => [name, new TextEncoder().encode(body(name))] as const));
    return zipNameNotes(p, names, tree).map((x) => x.note).filter((m) => /entry.point/.test(m));
  };
  test("a .data/scripts member named like a console_scripts entry is held", () => expect(launcherNotes("[console_scripts]\ntool = pkg:main\n", ["pkg/__init__.py", "x-1.0.data/scripts/tool"]).length).toBe(1));
  test("a .data/scripts member named like a gui_scripts entry's Windows launcher is held", () => expect(launcherNotes("[gui_scripts]\nTool = pkg:main\n", ["pkg/__init__.py", "x-1.0.data/scripts/tool.exe"]).length).toBe(1));
  const scripts = ["pkg/__init__.py", "x-1.0.data/scripts/evil"];
  test("an indented entry (pip strips each line) holds", () => expect(launcherNotes("[console_scripts]\n  evil = pkg:main\n", scripts).length).toBe(1));
  test("a tab-indented gui_scripts entry holds", () => expect(launcherNotes("[gui_scripts]\n\tevil = pkg:main\n", scripts).length).toBe(1));
  test("section names are compared as importlib.metadata does: strip('[]'), then exactly", () => {
    expect(launcherNotes("[Console_Scripts]\nevil = pkg:main\n", scripts)).toEqual([]);
    expect(launcherNotes("[[console_scripts]]\nevil = pkg:main\n", scripts).length).toBe(1);
    expect(launcherNotes("[console_scripts]]\nevil = pkg:main\n", scripts).length).toBe(1);
  });
  test("Python's strip removes \\x1f, which JavaScript's trim does not: a \\x1f-led entry holds", () => expect(launcherNotes("[console_scripts]\n\x1fevil = pkg:main\n", scripts).length).toBe(1));
  test("on Windows distlib drops a .py extension before .exe, so Tool.py overwrites Tool.exe", () => expect(launcherNotes("[console_scripts]\nTool.py = pkg:main\n", ["pkg/__init__.py", "x-1.0.data/scripts/Tool.exe"]).length).toBe(1));
  test("an entry name with whitespace holds every scripts member: distlib names the launcher from the last space", () => expect(launcherNotes("[console_scripts]\nmy tool = pkg:main\n", ["pkg/__init__.py", "x-1.0.data/scripts/ tool"]).length).toBe(1));
  test("a hyphenated entry name is read normally: another scripts member stays clean", () => expect(launcherNotes("[console_scripts]\nmy-tool = pkg:main\n", ["pkg/__init__.py", "x-1.0.data/scripts/helper"])).toEqual([]));
  test("a section with spaces inside its brackets is console_scripts to pkg_resources (pip 21): the launcher holds", () => expect(launcherNotes("[ console_scripts ]\nevil = pkg:main\n", scripts).length).toBe(1));
  test("tool.py and tool.pyw beside a tool entry are not launcher destinations (pip writes tool, or tool.exe on Windows)", () => {
    expect(launcherNotes("[console_scripts]\ntool = pkg:main\n", ["pkg/__init__.py", "x-1.0.data/scripts/tool.py"])).toEqual([]);
    expect(launcherNotes("[console_scripts]\ntool = pkg:main\n", ["pkg/__init__.py", "x-1.0.data/scripts/tool.pyw"])).toEqual([]);
  });
  test("pip skips a scripts member by basename (EP.pya, and one in a subdirectory), so the reviewed member never lands", () => {
    expect(launcherNotes("[console_scripts]\ntool = pkg:main\n", ["pkg/__init__.py", "x-1.0.data/scripts/tool.pya"]).length).toBe(1);
    expect(launcherNotes("[console_scripts]\ntool = pkg:main\n", ["pkg/__init__.py", "x-1.0.data/scripts/sub/tool"]).length).toBe(1);
  });
  test("tool-script.pyw is no pip launcher for a gui entry tool: not held", () => expect(launcherNotes("[gui_scripts]\ntool = pkg:main\n", ["pkg/__init__.py", "x-1.0.data/scripts/tool-script.pyw"])).toEqual([]));
  test("an entry name with a colon holds (pip splits at the first =)", () => expect(launcherNotes("[console_scripts]\na:b = pkg:main\n", ["pkg/__init__.py", "x-1.0.data/scripts/a:b"]).length).toBe(1));
  test("a ;-prefixed name is an entry (only # starts a comment)", () => expect(launcherNotes("[console_scripts]\n;x = pkg:main\n", ["pkg/__init__.py", "x-1.0.data/scripts/;x"]).length).toBe(1));
  test("a # line is a comment, not an entry", () => expect(launcherNotes("[console_scripts]\n# evil = pkg:main\n", scripts)).toEqual([]));
  test("a pip entry holds the pip3 and pip3.12 scripts members", () => {
    expect(launcherNotes("[console_scripts]\npip = pkg:main\n", ["pkg/__init__.py", "x-1.0.data/scripts/pip3"]).length).toBe(1);
    expect(launcherNotes("[console_scripts]\npip = pkg:main\n", ["pkg/__init__.py", "x-1.0.data/scripts/pip3.12"]).length).toBe(1);
  });
  test("an easy_install entry holds the easy_install-3.12 scripts member", () => expect(launcherNotes("[console_scripts]\neasy_install = pkg:main\n", ["pkg/__init__.py", "x-1.0.data/scripts/easy_install-3.12"]).length).toBe(1));
  test("pip3 is not held when the entry points do not name pip", () => expect(launcherNotes("[console_scripts]\ntool = pkg:main\n", ["pkg/__init__.py", "x-1.0.data/scripts/pip3"])).toEqual([]));
  test("an entry_points.txt that cannot be read cleanly holds every scripts member", () => {
    expect(launcherNotes("\uFEFF[console_scripts]\ntool = pkg:main\n", scripts).length).toBe(1);
    expect(launcherNotes("[console_scripts]\ntool = pkg:main\n[console_scripts]\nother = pkg:main\n", scripts).length).toBe(1);
    expect(launcherNotes("[console_scripts]\nno equals sign\n", scripts).length).toBe(1);
  });
  test("a .data/scripts member with another name than the entry points is not held", () => expect(launcherNotes("[console_scripts]\ntool = pkg:main\n[other]\nhelper = pkg:x\n", ["pkg/__init__.py", "x-1.0.data/scripts/helper"])).toEqual([]));
  cleanBody("Root-Is-Purelib: True (any case after the colon) with the same members: merged", rootAndData, "Wheel-Version: 1.0\nRoot-Is-Purelib: True\n");
  cleanBody("a plain Root-Is-Purelib: true with the same members: merged", rootAndData, "Wheel-Version: 1.0\nRoot-Is-Purelib: true\nTag: py3-none-any\n");
  clean("a .data/purelib member beside a root member when the root is purelib: one staging directory", ["pkg/__init__.py", "x-1.0.data/purelib/pkg/_impl.py"]);
  clean("a .data/platlib member beside a root member when the root is platlib: one staging directory", ["pkg/__init__.py", "x-1.0.data/platlib/pkg/_impl.py"], "false");
  collide("three data members: lib/python/qq twice and lib64/python/qq once (a fresh --target install skips run.py)", ["x-1.0.data/data/lib/python/qq/__init__.py", "x-1.0.data/data/lib/python/qq/guard.py", "x-1.0.data/data/lib64/python/qq/run.py"], 1);
  collide("lib/pypy beside lib64/pypy with one directory name", ["x-1.0.data/data/lib/pypy/qq/a.py", "x-1.0.data/data/lib64/pypy/qq/b.py"], 1);
  collide("lib/python3.9/site-packages beside lib64/python3.9/site-packages with one directory name", ["x-1.0.data/data/lib/python3.9/site-packages/pkg/a.py", "x-1.0.data/data/lib64/python3.9/site-packages/pkg/b.py"], 1);
  collide("Lib/site-packages beside DLLs/python with one directory name (Windows)", ["x-1.0.data/data/Lib/site-packages/pkg/a.py", "x-1.0.data/data/DLLs/python/pkg/b.py"], 1);
  collide("data lib and data lib64 homes with one directory name: two homes", ["x-1.0.data/data/lib/python/pkg/a.py", "x-1.0.data/data/lib64/python/pkg/b.py"], 1);
  clean("a .data/headers member and a .data/data/include member: one data home in the --target layout", ["x-1.0.data/headers/demo.h", "x-1.0.data/data/include/other.h"]);
  clean("a .data/scripts member under a site-packages directory: only the data scheme has lib homes", ["pkg/__init__.py", "x-1.0.data/scripts/tools/site-packages/pkg/b.py"]);
  collide("a .data/platlib directory beside a .data/purelib directory of the same name", ["x-1.0.data/purelib/pkg/a.py", "x-1.0.data/platlib/pkg/b.py"], 1);
  collide("a .data/data/lib-64/python member (platlibdir can be any name) and a root member", ["pkg/a.py", "x-1.0.data/data/lib-64/python/pkg/a.py"]);
  test("two data members in one lib directory, with no root member of that name, are not held", () => {
    expect(writerNotes("onehome", ["x-1.0.data/data/lib/python/pkg/a.py", "x-1.0.data/data/lib/python/pkg/b.py", "pkg2/ok.py"])).toEqual([]);
  });
  collide("a .data/data/lib64/python member (platlibdir lib64, distutils unix_home) and a root member", ["pkg/a.py", "x-1.0.data/data/lib64/python/pkg/a.py"]);
  collide("a .data/data/lib64/python directory that would replace the root pkg/ on a --target upgrade", ["pkg/__init__.py", "x-1.0.data/data/lib64/python/pkg/c.py"], 1);
  collide("a .data/data/libx32/python3.9/site-packages directory that would replace the root pkg/", ["pkg/__init__.py", "x-1.0.data/data/libx32/python3.9/site-packages/pkg/c.py"], 1);
  collide("a .data/data/lib32/pypy member and a root member", ["x/mod.py", "x-1.0.data/data/lib32/pypy/x/mod.py"]);
  collide("PyPy's purelib lib/pypy and a root member", ["x/mod.py", "x-1.0.data/data/lib/pypy/x/mod.py"]);
  collide("PyPy headers under include/pypy3.10/<dist> (--prefix) and a .data/headers member", ["x-1.0.data/headers/h.h", "x-1.0.data/data/include/pypy3.10/d/h.h"]);
  collide("PyPy headers under include/pypy/<dist> (--target) and a .data/headers member", ["x-1.0.data/headers/h.h", "x-1.0.data/data/include/pypy/d/h.h"]);
  collide("a Python313-arm64 user directory before Scripts", ["x-1.0.data/scripts/run", "x-1.0.data/data/Python313-arm64/Scripts/run"]);
  collide("a PyPy310 user directory before Scripts", ["x-1.0.data/scripts/run", "x-1.0.data/data/PyPy310/Scripts/run"]);
  collide("a dist directory named python-x: the headers path reads two ways and both are kept", ["x-1.0.data/headers/sub/h.h", "x-1.0.data/data/Include/python-x/sub/h.h"]);
  // A member whose path has a Windows alias or invalid name holds; the second list is clean.
  const winHold = (label: string, names: string[], expected: string) =>
    test(`${label}: holds as a Windows name alias or invalid name`, () => {
      const p = join(dir, `${n++}-winalias.zip`);
      writeFileSync(p, zipBytes(names.map((name) => ({ name, data: name }))));
      const tree = new Map<string, Uint8Array>(names.map((name) => [name.split("/").filter((x) => x !== "" && x !== ".").join("/"), new TextEncoder().encode(name)] as const));
      expect(zipNameNotes(p, names, tree).map((x) => x.note).some((m) => m.includes("which Windows reads as") && m.includes(expected))).toBe(true);
    });
  winHold("an NTFS stream suffix", ["pkg/a.py", "pkg/a.py::$DATA"], "colon");
  winHold("an NTFS stream suffix behind a .data/purelib prefix", ["pkg/a.py", "x-1.0.data/purelib/pkg/a.py::$data"], "colon");
  winHold("a drive-relative first segment", ["pkg/a.py", "C:pkg/a.py"], "colon");
  winHold("an NTFS directory stream", ["pkg/a.py", "pkg::$INDEX_ALLOCATION/a.py"], "colon");
  winHold("an 8.3 name made of an earlier tilde", ["foo~barbaz/a.py", "FOO~BA~1/a.py"], "8.3 short name");
  winHold("a device name with a space before the dot", ["pkg/CON .py"], "reserved device name");
  winHold("a device name with a space before another extension", ["pkg/NUL .txt"], "reserved device name");
  winHold("a superscript-digit device name", ["pkg/COM\u00b9.py"], "reserved device name");
  winHold("a second superscript-digit device name", ["pkg/LPT\u00b2"], "reserved device name");
  winHold("CONIN$", ["pkg/CONIN$"], "reserved device name");
  winHold("CONOUT$ with an extension", ["pkg/CONOUT$.txt"], "reserved device name");
  winHold("an 8.3 short name", ["mypackage/__init__.py", "MYPACK~1/__init__.py"], "8.3 short name");
  winHold("an invalid character", ["pkg/a<b>.py"], "character Windows refuses");
  winHold("a control character", ["pkg/a\u0001.py"], "character Windows refuses");
  winHold("a reserved device name", ["pkg/con.txt"], "reserved device name");
  winHold("a numbered device name", ["pkg/COM1"], "reserved device name");

  test("names with a tilde that are not 8.3, or that only contain a device name, are not held", () => {
    const names = ["pkg/foo~bar.py", "pkg/console.py", "pkg/auxiliary.py", "pkg/nullable.py", "pkg/comma.py", "pkg/aux_py.py", "pkg/nulltype.py", "pkg/nullsafe.py", "pkg/con_duct.py", "pkg/auxlib.py", "pkg/comtypes/__init__.py", "pkg/long~1234567.py"];
    const p = join(dir, `${n++}-winclean.zip`);
    writeFileSync(p, zipBytes(names.map((name) => ({ name, data: name }))));
    const tree = new Map<string, Uint8Array>(names.map((name) => [name, new TextEncoder().encode(name)] as const));
    expect(zipNameNotes(p, names, tree).map((x) => x.note).filter((m) => m.includes("Windows"))).toEqual([]);
  });

  collide("scripts in two .data directories", ["a-1.0.data/scripts/run", "b-1.0.data/scripts/run"]);
  collide("purelib and platlib in two .data directories", ["a-1.0.data/purelib/p.py", "b-1.0.data/platlib/p.py"]);
  collide("headers in two .data directories", ["a-1.0.data/headers/h.h", "b-1.0.data/headers/h.h"]);

  test("a wheel that uses purelib, platlib, scripts, headers and data with no overlap has no writer note", () => {
    expect(writerNotes("nooverlap", [
      "pkg/a.py",
      "x-1.0.dist-info/WHEEL",
      "x-1.0.data/purelib/pure.py",
      "x-1.0.data/platlib/plat.so",
      "x-1.0.data/scripts/run",
      "x-1.0.data/headers/h.h",
      "x-1.0.data/data/share/doc/x/README",
      "x-1.0.data/data/etc/x.conf",
      "x-1.0.data/data/lib/python3.9/site-packages/other/b.py",
      "x-1.0.data/data/include/site/python3.9/x/other.h",
      "x-1.0.data/data/Scripts/other.exe",
      "x-1.0.data/data/Include/y/third.h",
      "x-1.0.data/headers/fourth.h",
      "x-1.0.data/scripts/fifth",
    ])).toEqual([]);
  });

  // A newc cpio archive of regular files, for the bytes ahead of a zip.
  const cpioBytes = (files: { name: string; data: string }[]): Uint8Array => {
    const enc = new TextEncoder();
    const parts: number[] = [];
    const hex = (v: number) => v.toString(16).padStart(8, "0");
    const pad = () => { while (parts.length % 4) parts.push(0); };
    for (const f of [...files, { name: "TRAILER!!!", data: "" }]) {
      const name = enc.encode(f.name + "\0");
      const data = enc.encode(f.data);
      const isTrailer = f.name === "TRAILER!!!";
      parts.push(...enc.encode("070701" + [1, isTrailer ? 0 : 0o100644, 0, 0, 1, 0, data.length, 0, 0, 0, 0, name.length, 0].map(hex).join("")), ...name);
      pad();
      parts.push(...data);
      pad();
    }
    return new Uint8Array(parts);
  };

  test("a zip behind a cpio archive holds: bsdtar's own format is not zip", async () => {
    const p = join(dir, `${n++}-cpiopoly.whl`);
    writeFileSync(p, zipBytes([{ name: "pkg/mod.py", data: payload }, { name: "pkg/__init__.py", data: "" }], { prefixBytes: cpioBytes([{ name: "pkg/mod.py", data: "VALUE = 0\n" }]) }));
    const notes = tarNoteEntries(await readArtifact(p)).map((t) => t.note);
    expect(notes.some((m) => m.startsWith("a tar that is also a zip: bsdtar reads one (ASCII cpio"))).toBe(true);
  });

  test("a zip directory entry whose path is a file or a link in the unpacked tree holds", () => {
    const p = join(dir, `${n++}-dirfile.zip`);
    writeFileSync(p, zipBytes([{ name: "pkg/evil.py/", data: "", mode: 0o040755 }, { name: "pkg/lnk/", data: "", mode: 0o040755 }, { name: "pkg/ok/", data: "", mode: 0o040755 }]));
    const tree = new Map<string, Uint8Array>([["pkg/evil.py", new TextEncoder().encode("EVIL")], ["pkg/lnk", markLink(new TextEncoder().encode("x"))]]);
    const notes = zipNameNotes(p, ["pkg/evil.py/", "pkg/lnk/", "pkg/ok/"], tree).map((t) => t.note);
    expect(notes).toContain("zip member pkg/evil.py/: zipfile makes a directory of it, the unpacked archive has a file at pkg/evil.py");
    expect(notes).toContain("zip member pkg/lnk/: zipfile makes a directory of it, the unpacked archive has a link at pkg/lnk");
    expect(notes.filter((m) => m.includes("pkg/ok/"))).toEqual([]);
  });

  test("a valid zip followed by the four bytes of an end record signature holds: CPython raises BadZipFile", () => {
    const p = join(dir, `${n++}-pk0506.zip`);
    const z = zipBytes([{ name: "pkg/a.py", data: "A" }]);
    const bytes = new Uint8Array(z.length + 4);
    bytes.set(z);
    bytes.set([0x50, 0x4b, 0x05, 0x06], z.length);
    writeFileSync(p, bytes);
    expect(hasZipEnd(p)).toBe(true);
    const notes = zipNameNotes(p, ["pkg/a.py"], new Map([["pkg/a.py", new TextEncoder().encode("A")]])).map((t) => t.note);
    expect(notes.some((m) => m.startsWith("unreadable zip directory: truncated end of central directory record"))).toBe(true);
  });

  test("a signature inside the last 22 bytes of an archive whose end record has no comment is not the record (CPython's fast path)", () => {
    // The comment length is zero, so the last 22 bytes are the record whatever they contain.
    const p = join(dir, `${n++}-fast.zip`);
    writeFileSync(p, zipBytes([{ name: "pkg/a.py", data: "A" }]));
    expect(zipNameNotes(p, ["pkg/a.py"], new Map([["pkg/a.py", new TextEncoder().encode("A")]]))).toEqual([]);
  });

  // D1 (evil) R1 (its size field spans D2 and R2) D2 (benign) R2, a locator naming R1, an end record of placeholders.
  const layoutBytes = (evil: ZipIn[], benign: ZipIn[]): Uint8Array => {
    const split = (z: Uint8Array) => {
      const v = new DataView(z.buffer, z.byteOffset, z.byteLength);
      const e = z.length - 22;
      const off = v.getUint32(e + 16, true);
      const size = v.getUint32(e + 12, true);
      return { locals: z.slice(0, off), cd: z.slice(off, off + size), count: v.getUint16(e + 10, true) };
    };
    const a = split(zipBytes(evil));
    const b = split(zipBytes(benign));
    // D2 points at the benign locals, which sit after the evil ones.
    const d2 = b.cd.slice();
    const dv = new DataView(d2.buffer);
    for (let i = 0; i < d2.length; ) {
      dv.setUint32(i + 42, dv.getUint32(i + 42, true) + a.locals.length, true);
      i += 46 + dv.getUint16(i + 28, true) + dv.getUint16(i + 30, true) + dv.getUint16(i + 32, true);
    }
    const rec = (size: number, count: number, cdSize: number, cdOffset: number) => {
      const r = new DataView(new ArrayBuffer(56));
      r.setUint32(0, 0x06064b50, true);
      r.setBigUint64(4, BigInt(size), true);
      r.setUint16(12, 45, true);
      r.setUint16(14, 45, true);
      r.setBigUint64(24, BigInt(count), true);
      r.setBigUint64(32, BigInt(count), true);
      r.setBigUint64(40, BigInt(cdSize), true);
      r.setBigUint64(48, BigInt(cdOffset), true);
      return new Uint8Array(r.buffer);
    };
    const d1At = a.locals.length + b.locals.length;
    const r1At = d1At + a.cd.length;
    const d2At = r1At + 56;
    const loc = new DataView(new ArrayBuffer(20));
    loc.setUint32(0, 0x07064b50, true);
    loc.setBigUint64(8, BigInt(r1At), true);
    loc.setUint32(16, 1, true);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, 0xffff, true);
    end.setUint16(10, 0xffff, true);
    end.setUint32(12, 0xffffffff, true);
    end.setUint32(16, 0xffffffff, true);
    // The b locals' offsets are unshifted in the file: D1's entries read the evil ones from offset 0.
    const all = [a.locals, b.locals, a.cd, rec(44 + d2.length + 56, a.count, a.cd.length, d1At), d2, rec(44, b.count, d2.length, d2At), new Uint8Array(loc.buffer), new Uint8Array(end.buffer)];
    const out = new Uint8Array(all.reduce((m, c) => m + c.length, 0));
    let at = 0;
    for (const c of all) (out.set(c, at), (at += c.length));
    return out;
  };

  test("a ZIP64 locator that names a record other than the one before it holds, and the locator's directory is the one read", () => {
    const p = join(dir, `${n++}-layout.whl`);
    writeFileSync(p, layoutBytes([{ name: "pkg/mod.py", data: payload }], [{ name: "pkg/mod.py", data: "VALUE = 0\n" }]));
    const notes = zipNameNotes(p, ["pkg/mod.py"], new Map([["pkg/mod.py", new TextEncoder().encode(payload)]])).map((t) => t.note);
    expect(notes.some((m) => m.startsWith("zip member (archive): the end records and the directory disagree: the ZIP64 locator names a record at"))).toBe(true);
    // The locator's directory (the evil one) is what zipfile reads: its content matches the tree, so no content note.
    expect(notes.some((m) => m.includes("content zipfile reads differs"))).toBe(false);
  });

  test("the read budget counts a stored member once, so a member as large as the budget does not spend it twice over", () => {
    const body = "x".repeat(60);
    const mk = (count: number) => {
      const p = join(dir, `${n++}-budget.zip`);
      const names = Array.from({ length: count }, (_, i) => `pkg/m${i}.py`);
      writeFileSync(p, zipBytes(names.map((name) => ({ name, data: body }))));
      return zipNameNotes(p, names, new Map(names.map((name) => [name, new TextEncoder().encode(body)] as const)), 100).map((t) => t.note);
    };
    expect(mk(1)).toEqual([]);
    expect(mk(2).some((m) => m.includes("read budget of 100 bytes is spent"))).toBe(true);
  });

  test("a local name is decoded with the central header's UTF-8 flag, as zipfile does", () => {
    const p = join(dir, `${n++}-localflag.zip`);
    writeFileSync(p, zipBytes([{ name: "pkg/\u00e9.py", data: "A", flags: 0x0800, localFlags: 0 }]));
    const notes = zipNameNotes(p, ["pkg/\u00e9.py"], new Map([["pkg/\u00e9.py", new TextEncoder().encode("A")]])).map((t) => t.note);
    expect(notes.filter((m) => m.includes("local and central headers differ"))).toEqual([]);
  });

  test("zipfile's content is compared at the written path: no file there, a link there, or two members there hold", () => {
    const p = join(dir, `${n++}-paths.zip`);
    writeFileSync(p, zipBytes([{ name: "./pkg/a.py", data: "A" }, { name: "pkg/b.py", data: "B" }, { name: "pkg/c.py", data: "C" }, { name: "pkg/./c.py", data: "C2" }]));
    const tree = new Map<string, Uint8Array>([["pkg/b.py", markLink(new TextEncoder().encode("a.py"))], ["pkg/c.py", new TextEncoder().encode("C")]]);
    const notes = zipNameNotes(p, ["./pkg/a.py", "pkg/b.py", "pkg/c.py", "pkg/./c.py"], tree).map((t) => t.note);
    expect(notes).toContain("zip member ./pkg/a.py: zipfile writes it, the unpacked archive has no file at pkg/a.py");
    expect(notes).toContain("zip member pkg/b.py: zipfile writes a file, the unpacked archive has a link at pkg/b.py");
    expect(notes).toContain("zip member pkg/./c.py: two members zipfile reads are written at pkg/c.py");
  });

  for (const [label, entry, why] of [
    ["patched data", { flags: 0x0800 | 0x20 }, "compressed patched data (flag bit 5)"],
    ["strong encryption", { flags: 0x0800 | 0x40 }, "strong encryption (flag bit 6)"],
    ["zip version 9.9", { needs: 99 }, "it needs zip version 9.9"],
  ] as const) {
    test(`a member zipfile refuses (${label}) holds although bsdtar reads it`, () => {
      const p = join(dir, `${n++}-refused.zip`);
      writeFileSync(p, zipBytes([{ name: "pkg/a.py", data: "A", ...entry }]));
      expect(zipNameNotes(p, ["pkg/a.py"], new Map([["pkg/a.py", new TextEncoder().encode("A")]])).map((t) => t.note)).toContain(`zip member pkg/a.py: zipfile cannot read it: ${why}`);
    });
  }

  test("the directory is walked by its byte size: an end record count of 1 over two members holds as a count mismatch", () => {
    const p = join(dir, `${n++}-count.zip`);
    writeFileSync(p, zipBytes([{ name: "pkg/a.py", data: "A" }, { name: "pkg/b.py", data: "B" }], { count: 1 }));
    const tree = new Map([["pkg/a.py", new TextEncoder().encode("A")], ["pkg/b.py", new TextEncoder().encode("B")]]);
    expect(zipNameNotes(p, ["pkg/a.py", "pkg/b.py"], tree).map((t) => t.note)).toEqual(["zip member (archive): the end records and the directory disagree: the end record counts 1 entries, the directory holds 2"]);
  });

  test("a RECORD path with a newline in its quoted field is read as pip reads it: the newline is gone, so the path is another file", async () => {
    const files = [{ name: "pkg/__init__.py", data: "" }, { name: "pkg/a\nb.py", data: "x" }];
    const wheel = [...files, ...distInfo([])];
    const rec = wheel.find((e) => e.name.endsWith("/RECORD"))!;
    rec.data = `pkg/__init__.py,,\n"pkg/a\nb.py",,\n` + rec.data;
    expect((await zipHolds(wheel, wheel)).some((d) => d.includes("holding a character Windows refuses"))).toBe(true);
    expect(await zipHolds(wheel, wheel)).toContain("zip member pkg/ab.py: the wheel RECORD names it, the unpacked archive has no such file");
  });

  // Each expected list is what Python's csv.reader(text.splitlines()) gives for the first field of each row.
  test("RECORD rows are split as csv.reader(text.splitlines()) splits them", () => {
    const cases: [string, string[]][] = [
      ['"a\nb",1\nx"y,2\n../e,,\nq\x0cz,,', ["ab", 'x"y', "../e", "q", "z"]],
      ['"a"b,1\n"c""d",2\n"e","f\n', ["ab", 'c"d', "e"]],
      ["a,b\r\nc,d\r\n\r\ne,f", ["a", "c", "e"]],
      ["a\x1cb\x1dc\x1ed\x85e\u2028f\u2029g", ["a", "b", "c", "d", "e", "f", "g"]],
    ];
    for (const [text, want] of cases) expect(recordPaths(text).paths).toEqual(want);
    expect(recordPaths("a\0b,1").bad).toBeDefined();
    // pip keeps a row with an empty path (it resolves to the install directory) and fails on a blank row: both are unreadable.
    expect(recordPaths(",,\na,,\n").bad).toBeDefined();
    expect(recordPaths("a,,\n\nb,,\n").bad).toBeDefined();
    expect(recordPaths("a,,\nb,,\n").bad).toBeUndefined();
  });

  const recordWheel = (name: string, rec: string, recName = "x-1.0.1.dist-info/RECORD") => {
    const p = join(dir, `${n++}-${name}.whl`);
    const files = [{ name: "x-1.0.1.dist-info/METADATA", data: "Name: x\n" }, { name: "x-1.0.1.dist-info/WHEEL", data: "Wheel-Version: 1.0\n" }, { name: "pkg/__init__.py", data: "" }];
    writeFileSync(p, zipBytes([...files, { name: recName, data: rec }]));
    const all = [...files, { name: recName, data: rec }];
    const names = all.map((e) => e.name);
    const tree = new Map<string, Uint8Array>(all.map((e) => [writtenCollapsed(e.name), new TextEncoder().encode(e.data)] as const));
    return zipNameNotes(p, names, tree).map((t) => t.note);
  };
  const writtenCollapsed = (m: string) => m.split("/").filter((x) => x !== "" && x !== ".").join("/");
  const okRec = "x-1.0.1.dist-info/METADATA,,\nx-1.0.1.dist-info/WHEEL,,\npkg/__init__.py,,\n";
  const escapeNote = "zip member ../../../evil: the wheel RECORD names it, the unpacked archive has no such file";

  for (const recName of ["x-1.0.1.dist-info/./RECORD", "x-1.0.1.dist-info//RECORD"]) {
    test(`a RECORD written as ${recName} is the RECORD pip uninstalls by: its rows are checked`, () => {
      expect(recordWheel("recdot", okRec + "../../../evil,,\n", recName)).toContain(escapeNote);
    });
  }

  test("a quote inside a field does not swallow the next RECORD row, and a form feed starts a new row", () => {
    expect(recordWheel("recquote", 'x-1.0.1.dist-info/METADATA,sha256=a"b,1\n../../../evil,,\nx-1.0.1.dist-info/WHEEL,sha256=c"d,1\npkg/__init__.py,,\n')).toContain(escapeNote);
    expect(recordWheel("recff", "x-1.0.1.dist-info/METADATA,,\x0c../../../evil,,\nx-1.0.1.dist-info/WHEEL,,\npkg/__init__.py,,\n")).toContain(escapeNote);
  });

  test("a RECORD row with an empty path or a blank row holds as unreadable", () => {
    expect(recordWheel("recempty", okRec + ",,\n").some((m) => m.includes("cannot be read as pip reads it"))).toBe(true);
    expect(recordWheel("recblank", okRec + "\n\n").some((m) => m.includes("cannot be read as pip reads it"))).toBe(true);
  });
  test("a UTF-8 BOM stays in RECORD's first path, as Python keeps it: the path matches no member", () => {
    expect(recordWheel("recbom", "\uFEFFx-1.0.1.dist-info/METADATA,,\nx-1.0.1.dist-info/WHEEL,,\npkg/__init__.py,,\n").some((m) => m.includes("the wheel RECORD names it"))).toBe(true);
  });
  test("a ZIP64 archive with bytes before it reads clean: the record offsets are the writer's, without the prefix", () => {
    const names = ["pkg/__init__.py", "pkg/a.py"];
    const p = join(dir, `${n++}-z64prefix.zip`);
    writeFileSync(p, zipBytes(names.map((name) => ({ name, data: name })), { zip64: true, prefix: "#!/bin/sh\n" }));
    const tree = new Map<string, Uint8Array>(names.map((name) => [name, new TextEncoder().encode(name)] as const));
    expect(zipNameNotes(p, names, tree)).toEqual([]);
  });
  test("a ZIP64 record hidden behind extensible data holds: an older zipfile looks just before the locator", () => {
    const names = ["pkg/__init__.py", "pkg/a.py"];
    const base = zipBytes(names.map((name) => ({ name, data: name })), { zip64: true });
    const dv = new DataView(base.buffer, base.byteOffset, base.byteLength);
    let r = -1;
    for (let i = 0; i + 4 <= base.length; i++) if (dv.getUint32(i, true) === 0x06064b50) r = i;
    expect(r).toBeGreaterThan(0);
    const padded = new Uint8Array(base.length + 8);
    padded.set(base.subarray(0, r + 56), 0);
    padded.set(base.subarray(r + 56), r + 64);
    new DataView(padded.buffer).setBigUint64(r + 4, 52n, true);
    const p = join(dir, `${n++}-z64ext.zip`);
    writeFileSync(p, padded);
    const tree = new Map<string, Uint8Array>(names.map((name) => [name, new TextEncoder().encode(name)] as const));
    expect(zipNameNotes(p, names, tree).map((x) => x.note).some((m) => m.includes("the ZIP64 record is not directly before its locator"))).toBe(true);
    const plain = join(dir, `${n++}-z64plain.zip`);
    writeFileSync(plain, base);
    expect(zipNameNotes(plain, names, tree)).toEqual([]);
  });
  test("a clean RECORD, with a repeated path and quoted fields, adds no note", () => {
    expect(recordWheel("recclean", okRec + 'pkg/__init__.py,"sha256=a,b",1\n"pkg/__init__.py",,\n')).toEqual([]);
  });

  // A wheel whose zip members (and so unpacked tree files) are `members`, with the given RECORD.
  // `treeKeys` maps a member name to the key the unpacked tree holds it under (a macOS extraction decomposes names).
  const treeWheel = (name: string, members: string[], rec: string, treeKeys = new Map<string, string>()) => {
    const p = join(dir, `${n++}-${name}.whl`);
    const files = [{ name: "x-1.0.1.dist-info/METADATA", data: "Name: x\n" }, { name: "x-1.0.1.dist-info/WHEEL", data: "Wheel-Version: 1.0\n" }, ...members.map((m) => ({ name: m, data: "" })), { name: "x-1.0.1.dist-info/RECORD", data: rec }];
    writeFileSync(p, zipBytes(files));
    const tree = new Map<string, Uint8Array>(files.map((e) => [writtenCollapsed(treeKeys.get(e.name) ?? e.name), new TextEncoder().encode(e.data)] as const));
    return zipNameNotes(p, files.map((e) => e.name), tree).map((t) => t.note);
  };
  const recOf = (...paths: string[]) => "x-1.0.1.dist-info/METADATA,,\nx-1.0.1.dist-info/WHEEL,,\n" + paths.map((p) => `${p},,\n`).join("");
  const recordNotes = (notes: string[]) => notes.filter((m) => m.includes("the wheel RECORD"));
  const nfc = "pkg/caf\u00e9.py";
  const nfd = "pkg/cafe\u0301.py";
  const onlyNorm = (p: string) => `zip member ${p}: the wheel RECORD names it, the unpacked archive has a file of that name only after Unicode normalization`;
  const absent = (p: string) => `zip member ${p}: the wheel RECORD names it, the unpacked archive has no such file`;

  test("a RECORD row that matches a tree file only after normalization holds, and every other row stays as before", () => {
    // held
    expect(treeWheel("recnfcrow", [nfd], recOf(nfc))).toEqual([onlyNorm(nfc)]);
    expect(treeWheel("recnfdrow", [nfc], recOf(nfd))).toEqual([onlyNorm(nfd)]);
    expect(treeWheel("recnoexact", ["pkg/a.py", nfd], recOf("pkg/a.py", nfc))).toEqual([onlyNorm(nfc)]);
    expect(treeWheel("recabsent", ["pkg/a.py"], recOf("pkg/b.py"))).toEqual([absent("pkg/b.py")]);
    // a case-only difference is not a normalization match: main held it as an absent file, and so does this
    expect(treeWheel("reccase", ["pkg/a.py"], recOf("pkg/A.py"))).toEqual([absent("pkg/A.py")]);
    // quiet
    expect(treeWheel("recascii", ["pkg/a.py"], recOf("pkg/a.py"))).toEqual([]);
    expect(recordNotes(treeWheel("recexactnfc", [nfc], recOf(nfc)))).toEqual([]);
    expect(recordNotes(treeWheel("recexactnfd", [nfd], recOf(nfd)))).toEqual([]);
    // the zip wrote the row's name, so a host without normalization installs that file even where the tree key is decomposed
    expect(recordNotes(treeWheel("recwrittennfc", [nfc], recOf(nfc), new Map([[nfc, nfd]])))).toEqual([]);
    expect(recordNotes(treeWheel("recwrittennfd", [nfd], recOf(nfc), new Map([[nfd, nfd]])))).toEqual([onlyNorm(nfc)]);
    expect(treeWheel("recdistinfo", ["pkg/a.py"], recOf("pkg/a.py", "x-1.0.1.dist-info/RECORD"))).toEqual([]);
  });

  test("a RECORD row naming one of a normalization-equal pair of files is quiet when its exact name is in the tree", () => {
    // main matched the row in NFD and stayed quiet; an exact match still does
    expect(recordNotes(treeWheel("rectwinnfc", [nfc, nfd], recOf(nfc)))).toEqual([]);
    expect(recordNotes(treeWheel("rectwinnfd", [nfc, nfd], recOf(nfd)))).toEqual([]);
  });

  test("RECORD rows are matched in time linear in their count and length", () => {
    // Every row names a tree file under a long accented name, so each row is normalized and looked up and none holds.
    const run = (rows: number) => {
      const members = Array.from({ length: rows }, (_, i) => `pkg/${"d\u00e9".repeat(150)}${i}.py`);
      const files = [{ name: "x-1.0.1.dist-info/METADATA", data: "Name: x\n" }, { name: "x-1.0.1.dist-info/WHEEL", data: "Wheel-Version: 1.0\n" }, ...members.map((m) => ({ name: m, data: "" })), { name: "x-1.0.1.dist-info/RECORD", data: recOf(...members) }];
      const p = join(dir, `${n++}-recperf${rows}.whl`);
      writeFileSync(p, zipBytes(files));
      const tree = new Map<string, Uint8Array>(files.map((e) => [e.name, new TextEncoder().encode(e.data)] as const));
      const names = files.map((e) => e.name);
      const t0 = performance.now();
      const notes = zipNameNotes(p, names, tree).length;
      return { notes, ms: performance.now() - t0 };
    };
    run(500);
    const small = run(2000);
    const big = run(8000);
    console.log(`recperf small ${small.ms.toFixed(1)} ms, big ${big.ms.toFixed(1)} ms, ratio ${(big.ms / small.ms).toFixed(2)}`);
    expect(small.notes + big.notes).toBe(0);
    expect(small.ms).toBeGreaterThan(10);
    // 4x the rows: linear is about 4x, a quadratic is about 16x
    expect(big.ms / small.ms).toBeLessThan(6);
    expect(big.ms).toBeLessThan(20_000);
  });

  test("a RECORD over the row cap holds with its distinct paths counted once, and repeats do not reach it", () => {
    const many = Array.from({ length: 10_001 }, (_, i) => `pkg/m${i}.py,,\n`).join("");
    expect(recordWheel("reccap", okRec + many).some((m) => m.includes("lists 10004 distinct paths, over the 10000 that are checked"))).toBe(true);
    expect(recordWheel("recrepeat", okRec + "pkg/__init__.py,,\n".repeat(12_000))).toEqual([]);
  });

  test("a mode is read whatever the host byte says, as zipfile and pip read it", async () => {
    const old = [...plain, { name: "pkg/evil.py", data: "BENIGN\n" }];
    const now = [...plain, { name: "pkg/evil.py", data: payload, mode: 0o040755, madeBy: 45 }];
    expect(await zipHolds(old, now)).toContain("zip member pkg/evil.py: mode 40755 is not a regular file, which pip writes");
  });

  test("a zip directory entry with data holds", async () => {
    const now = [...plain, { name: "pkg/data/", data: payload, mode: 0o040755 }];
    expect(await zipHolds(plain, now)).toContain(`zip member pkg/data/: a directory entry with ${payload.length} bytes of data`);
  });

  test("a member name with a format character is read back to its own name: bsdtar prints its lead byte raw", async () => {
    const files = () => rel("1.0.0", [{ name: "pkg/a\u200b.py", type: "file", data: "x" }, { name: "pkg/b\u200e.py", type: "file", data: "y" }]);
    const r = prepass("pypi", await read(files()), await read(files()));
    expect(holds(r)).toEqual([]);
  });

  test("an unchanged non-ascii file that folds into the same copy in a second artifact still carries", async () => {
    const into = { old: new Map(), new: new Map() } as { old: Map<string, Uint8Array>; new: Map<string, Uint8Array> };
    const one = (v: string) => rel(v, [{ name: "pkg/\u00e9.py", type: "file", data: "BENIGN\n" }]);
    mergeArtifactPair(into, "x-1.0.1-py3-none-any.whl", await read(one("1.0.0")), await read(one("1.0.1")));
    mergeArtifactPair(into, "x-1.0.1.tar.gz", await read(one("1.0.0")), await read(one("1.0.1")));
    const r = prepass("pypi", into.old, into.new);
    expect(holds(r)).toEqual([]);
    expect(r.carriedTarNotes).toEqual(["x-1.0.1-py3-none-any.whl: non-ascii x-1.0.1/pkg/\u00e9.py", "x-1.0.1.tar.gz: non-ascii x-1.0.1/pkg/\u00e9.py"]);
  });
});

// Codex round 3: the pypi files of a release pair by name with the version swapped, never by label and listing order.
describe("pypi files pair with their own old file", () => {
  type E = { name: string; type: "file" | "sym" | "hard" | "dir"; data: string };
  // \`flavor\` gives each format its own bytes, so a second file is never folded into the first one's copy.
  const sdist = (v: string, withLink: boolean, flavor = "gz") => tarBytes([
    { name: `x-${v}/setup.py`, type: "file", data: `setup(fmt="${flavor}")\n` },
    { name: `x-${v}/m.py`, type: "file", data: `x = "${flavor}"\n` },
    { name: `x-${v}/a.txt`, type: "file", data: "a" },
    ...(withLink ? [{ name: `x-${v}/docs/link`, type: "sym" as const, data: "../a.txt" } as E] : []),
  ]);
  const load = async (before: [string, Uint8Array][], now: [string, Uint8Array][], name = "x", from = "1", to = "2") => {
    const sha = (b: Uint8Array) => new Bun.CryptoHasher("sha256").update(b).digest("hex");
    const bytes = new Map<string, Uint8Array>([...before, ...now].map(([n, b]) => [`https://files.example/${n}`, b]));
    const listing = (files: [string, Uint8Array][]) => files.map(([n, b]) => ({ url: `https://files.example/${n}`, filename: n, packagetype: n.endsWith(".whl") ? ("bdist_wheel" as const) : ("sdist" as const), sha256: sha(b) }));
    const registry = { latest: async () => undefined, publishedAt: async () => undefined, artifactUrls: async () => [], artifactFiles: async (_n: string, v: string) => listing(v === from ? before : now) };
    const fetcher = (async (u: string | URL) => new Response(bytes.get(String(u))! as unknown as BodyInit)) as unknown as typeof fetch;
    const work = join(dir, `pypi-${n++}`);
    mkdirSync(work);
    const art = await loadArtifacts({ eco: "pypi", name, from, to } as ReviewArgs, registry as never, work, fetcher);
    return prepass("pypi", art.old, art.new);
  };
  const tarHolds = (r: ReturnType<typeof prepass>) => r.hard.filter((s) => s.kind === "tar-entry").map((s) => s.detail);

  for (const order of ["bz2 first", "gz first"])
    test(`a new .tar.bz2 with a link does not take the old .tar.gz as its counterpart (${order})`, async () => {
      const now: [string, Uint8Array][] = [["x-2.tar.bz2", sdist("2", true)], ["x-2.tar.gz", sdist("2", false)]];
      const r = await load([["x-1.tar.gz", sdist("1", true)]], order === "bz2 first" ? now : now.reverse());
      expect(tarHolds(r)).toContain("x-2.tar.bz2: symlink x-2/docs/link");
    });

  test("a new file with the same bytes as a paired one still has no old side: its link holds", async () => {
    const r = await load([["x-1.tar.gz", sdist("1", true)]], [["x-2.tar.gz", sdist("2", true)], ["x-2.tar.bz2", sdist("2", true)]]);
    expect(tarHolds(r)).toEqual(["x-2.tar.bz2: symlink x-2/docs/link"]);
    expect(r.carriedTarNotes).toEqual(["x-2.tar.gz: symlink x-2/docs/link"]);
  });

  // Each pairs, so its unchanged link carries; a file that did not pair would hold it.
  const pairs: [string, string, string, string][] = [
    ["a PEP 625 rename", "Foo-Bar", "Foo-Bar-1.tar.gz", "foo_bar-2.tar.gz"],
    ["a name holding -<version>", "py-1-utils", "py-1-utils-1.tar.gz", "py-1-utils-2.tar.gz"],
    ["a wheel with a build tag", "x", "x-1-py3-none-any.whl", "x-2-1-py3-none-any.whl"],
  ];
  for (const [label, name, before, after] of pairs)
    test(`${label} pairs: ${before} with ${after}`, async () => {
      const r = await load([[before, sdist("1", true)]], [[after, sdist("2", true)]], name);
      expect(tarHolds(r)).toEqual([]);
      expect(r.carriedTarNotes?.length).toBe(1);
    });

  test("a version needs a boundary: x-10.tar.gz does not pair with x-20.tar.gz for 1 -> 2", async () => {
    const r = await load([["x-10.tar.gz", sdist("1", true)]], [["x-20.tar.gz", sdist("2", true)]]);
    expect(tarHolds(r)).toEqual(["x-20.tar.gz: symlink x-2/docs/link"]);
  });

  test("a changed sdist format pairs when each release has exactly one sdist: x-1.zip with x-2.tar.gz", async () => {
    const r = await load([["x-1.zip", sdist("1", true, "zip")]], [["x-2.tar.gz", sdist("2", true)]]);
    expect(tarHolds(r)).toEqual([]);
    expect(r.carriedTarNotes).toEqual(["x-2.tar.gz: symlink x-2/docs/link"]);
  });

  test("a changed sdist format does not pair when a release has two sdists", async () => {
    const r = await load([["x-1.zip", sdist("1", true, "zip")], ["x-1.tar.xz", sdist("1", true, "xz")]], [["x-2.tar.gz", sdist("2", true)]]);
    expect(tarHolds(r)).toEqual(["x-2.tar.gz: symlink x-2/docs/link"]);
  });

  // A version is compared as PEP 440 spells it, so the file name and the release need not use one spelling.
  const spellings: [string, string, string, string, string][] = [
    ["1.0 is 1.0.0", "x-1.0.tar.gz", "x-2.0.tar.gz", "1.0.0", "2.0.0"],
    ["1 is 1.0", "x-1.tar.gz", "x-2.tar.gz", "1.0", "2.0"],
    ["1.0-1 is 1.0.post1", "x-1.0-1.tar.gz", "x-2.0-1.tar.gz", "1.0.post1", "2.0.post1"],
    ["1.0RC1 is 1.0rc1 (wheel)", "x-1.0RC1-py3-none-any.whl", "x-2.0RC1-py3-none-any.whl", "1.0rc1", "2.0rc1"],
    ["1.0alpha1 is 1.0a1", "x-1.0alpha1.tar.gz", "x-2.0alpha1.tar.gz", "1.0a1", "2.0a1"],
    ["1.0.0.post0 is 1.post0", "x-1.0.0.post0.tar.gz", "x-2.0.0.post0.tar.gz", "1.post0", "2.post0"],
  ];
  for (const [label, before, after, from, to] of spellings)
    test(`version spellings pair: ${label}`, async () => {
      const r = await load([[before, sdist("1", true)]], [[after, sdist("2", true)]], "x", from, to);
      expect(tarHolds(r)).toEqual([]);
      expect(r.carriedTarNotes?.length).toBe(1);
    });

  test("a dot after the version does not end it: x-1.post1 and x-2.post1 are not releases 1 and 2", async () => {
    const r = await load([["x-1.post1.tar.gz", sdist("1", true)]], [["x-2.post1.tar.gz", sdist("2", true)]]);
    expect(tarHolds(r)).toEqual(["x-2.post1.tar.gz: symlink x-2/docs/link"]);
  });

  test("an unrecognized sdist extension pairs with nothing", async () => {
    const odd = await load([["x-1.tar.gz.sig", sdist("1", true)]], [["x-2.tar.gz.sig", sdist("2", true)]]);
    expect(tarHolds(odd)).toEqual(["x-2.tar.gz.sig: symlink x-2/docs/link"]);
  });

  test("another sdist of any project name keeps cross-format pairing off: x-1.zip, other-1.tar.gz and x-2.tar.gz", async () => {
    const r = await load([["x-1.zip", sdist("1", true, "zip")], ["other-1.tar.gz", sdist("1", true, "other")]], [["x-2.tar.gz", sdist("2", true)]]);
    expect(tarHolds(r)).toEqual(["x-2.tar.gz: symlink x-2/docs/link"]);
  });

  test("a NUL in a file name does not make a note name another file: both names are shown whole", async () => {
    const other = tarBytes([{ name: "x-2/setup.py", type: "file", data: "setup()\n" }, { name: "x-2/a.txt", type: "file", data: "a" }, { name: "x-2/b.txt", type: "file", data: "b" }, { name: "x-2/docs/link", type: "sym", data: "../b.txt" }]);
    const r = await load([["x-1.tar.gz", sdist("1", true)]], [["x-2.tar.gz", sdist("2", true)], ["x-2.tar.gz\u0000other-2.tar.gz", other]]);
    expect(tarHolds(r)).toEqual(["x-2.tar.gz\\x00other-2.tar.gz: symlink x-2/docs/link"]);
    expect(r.carriedTarNotes).toEqual(["x-2.tar.gz: symlink x-2/docs/link"]);
  });

  test("a long file name is cut in the detail, not the note's path", async () => {
    const r = await load([["x-1.tar.gz", sdist("1", true)]], [["x-2.tar.gz", sdist("2", false)], [`x-2-${"a".repeat(300)}.tar.gz`, sdist("2", true, "long")]]);
    const hold = r.hard.find((h) => h.kind === "tar-entry");
    expect(hold?.detail.length).toBeLessThanOrEqual(200);
    expect(hold?.detail).toEndWith(": symlink x-2/docs/link");
  });

  test("names that differ only by a backslash and a control character are shown apart", async () => {
    const r = await load([["x-1-py3-none-a\u0000b.whl", sdist("1", true)]], [["x-2-py3-none-a\u0000b.whl", sdist("2", true, "a")], ["x-2-py3-none-a\\x00b.whl", sdist("2", true, "b")]]);
    expect(r.carriedTarNotes).toEqual(["x-2-py3-none-a\\x00b.whl: symlink x-2/docs/link"]);
    expect(tarHolds(r)).toEqual(["x-2-py3-none-a\\\\x00b.whl: symlink x-2/docs/link"]);
  });

  test("two long names that differ at the end are shown apart, keep the path, and a 60-character name is shown whole", async () => {
    const wheel = (end: string) => `x-2-py3-none-${"a".repeat(50)}${end}.whl`;
    const r = await load([[`x-1-py3-none-${"a".repeat(50)}A.whl`, sdist("1", true)]], [[wheel("A"), sdist("2", true, "a")], [wheel("B"), sdist("2", true, "b")]]);
    const carried = r.carriedTarNotes![0]!;
    const held = tarHolds(r)[0]!;
    expect(carried).toEndWith(": symlink x-2/docs/link");
    expect(held).toEndWith(": symlink x-2/docs/link");
    expect(carried.split(": ")[0]).not.toBe(held.split(": ")[0]);
    expect(held.split(": ")[0]!.length).toBeLessThanOrEqual(60);
    const whole = `x-2-${"a".repeat(49)}.tar.gz`;
    expect(whole.length).toBe(60);
    const w = await load([["x-1.tar.gz", sdist("1", true)]], [[whole, sdist("2", true)]], "x", "1", "2");
    expect(tarHolds(w)).toEqual([`${whole}: symlink x-2/docs/link`]);
  });

  test("a name that spells a cut label is not shown as one: a literal ~ stays distinguishable", async () => {
    const long = `x-2-py3-none-${"a".repeat(60)}.whl`;
    const hash = new Bun.CryptoHasher("sha256").update(long).digest("hex").slice(0, 6);
    const spelled = `x-2-py3-none-aaaaaaaaaaa~${hash}~aaaaaaaaaaaaaaaaaaaa.whl`;
    expect(spelled.length).toBe(56);
    const r = await load([[`x-1-py3-none-${"a".repeat(60)}.whl`, sdist("1", true)]], [[long, sdist("2", true, "a")], [spelled, sdist("2", true, "b")]]);
    const carried = r.carriedTarNotes![0]!.split(": ")[0]!;
    const held = tarHolds(r)[0]!.split(": ")[0]!;
    expect(carried).toBe(`x-2-py3-none-aaaaaaaaaaa~${hash}~aaaaaaaaaaaaaaaaaaaa.whl`);
    expect(held).toBe(`x-2-py3-none-aaaaaaaaaaa\\~${hash}\\~aaaaaaaaaaaaaaaaaaaa.whl`);
  });

  test("a version that is no PEP 440 version pairs by the same string: x-1.0-final with x-2.0-final", async () => {
    const r = await load([["x-1.0-final.tar.gz", sdist("1", true)]], [["x-2.0-final.tar.gz", sdist("2", true)]], "x", "1.0-final", "2.0-final");
    expect(tarHolds(r)).toEqual([]);
    expect(r.carriedTarNotes?.length).toBe(1);
    const w = await load([["x-1.0_final-py3-none-any.whl", sdist("1", true)]], [["x-2.0_final-py3-none-any.whl", sdist("2", true)]], "x", "1.0_final", "2.0_final");
    expect(tarHolds(w)).toEqual([]);
  });

  test("a wheel with a raw - in its project name pairs: foo-bar-1.0-py3-none-any.whl", async () => {
    const r = await load([["foo-bar-1.0-py3-none-any.whl", sdist("1", true)]], [["foo-bar-2.0-py3-none-any.whl", sdist("2", true)]], "foo-bar", "1.0", "2.0");
    expect(tarHolds(r)).toEqual([]);
    expect(r.carriedTarNotes?.length).toBe(1);
  });

  test("a note shows its own file's name: two sdists name the one whose link changed", async () => {
    const changed = tarBytes([{ name: "x-2/setup.py", type: "file", data: 'setup(fmt="zip")\n' }, { name: "x-2/a.txt", type: "file", data: "a" }, { name: "x-2/b.txt", type: "file", data: "b" }, { name: "x-2/docs/link", type: "sym", data: "../b.txt" }]);
    const r = await load([["x-1.tar.gz", sdist("1", true)], ["x-1.zip", sdist("1", true, "zip")]], [["x-2.tar.gz", sdist("2", true)], ["x-2.zip", changed]]);
    expect(tarHolds(r)).toEqual(["x-2.zip: symlink x-2/docs/link"]);
    expect(r.carriedTarNotes).toEqual(["x-2.tar.gz: symlink x-2/docs/link"]);
  });

  test("a note of an artifact read through a copy points at the file that copy was placed at", async () => {
    const zip = sdist("2", true, "zip");
    const r = await load([["x-1.tar.gz", sdist("1", true)]], [["x-2.tar.gz", sdist("2", true)], ["x-2.zip", zip], ["x-2.tar.bz2", zip]]);
    const paths = r.hard.filter((s) => s.kind === "tar-entry").map((s) => [s.detail, s.path]);
    expect(paths).toEqual(expect.arrayContaining([["x-2.zip: symlink x-2/docs/link", "x-2.zip/docs/link"], ["x-2.tar.bz2: symlink x-2/docs/link", "x-2.zip/docs/link"]]));
  });

  test("two distinct sdists each pair with their own old file: an unchanged link carries, unchanged files are not added", async () => {
    const r = await load([["x-1.tar.gz", sdist("1", true)], ["x-1.zip", sdist("1", true, "zip")]], [["x-2.zip", sdist("2", true, "zip")], ["x-2.tar.gz", sdist("2", true)]]);
    expect(tarHolds(r)).toEqual([]);
    expect(r.added.filter((p) => /setup\.py|m\.py/.test(p))).toEqual([]);
  });
});

test("a normal npm tarball with directory entries (package/, ./package/) has no path collision", async () => {
  const p = join(dir, `${n++}-dirs.tar`);
  writeFileSync(p, tarBytes([{ name: "package/", type: "dir", data: "" }, { name: "./package/", type: "dir", data: "" }, { name: "package/package.json", type: "file", data: pj("dirs") }, { name: "package/install.js", type: "file", data: benign }]));
  const files = normalizePaths(await readArtifact(p));
  expect(prepass("npm", files, files).hard.filter((s) => s.detail.includes("path collision"))).toEqual([]);
});

test("tar entry fixtures are removed", () => {
  rmSync(dir, { recursive: true, force: true });
});
