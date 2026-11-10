import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { foldKey, markUnstored, mergeArtifactPair, normalizePaths, readArtifact, unescapeMember, unstoredMembers } from "../src/artifact.ts";
import { prepass, tarNoteEntries } from "../src/prepass.ts";
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
  const zipBytes = (entries: { name: string; data: string }[]): Uint8Array => {
    const enc = new TextEncoder();
    const parts: Uint8Array[] = [];
    const central: Uint8Array[] = [];
    let off = 0;
    for (const e of entries) {
      const name = enc.encode(e.name);
      const data = enc.encode(e.data);
      const crc = Bun.hash.crc32(data) >>> 0;
      const local = new DataView(new ArrayBuffer(30));
      [[0, 0x04034b50, 4], [4, 20, 2], [6, 0x0800, 2], [8, 0, 2], [10, 0, 2], [12, 0x21, 2], [14, crc, 4], [18, data.length, 4], [22, data.length, 4], [26, name.length, 2], [28, 0, 2]].forEach(([o, v, w]) => (w === 4 ? local.setUint32(o!, v!, true) : local.setUint16(o!, v!, true)));
      const cd = new DataView(new ArrayBuffer(46));
      [[0, 0x02014b50, 4], [4, 0x0314, 2], [6, 20, 2], [8, 0x0800, 2], [10, 0, 2], [12, 0, 2], [14, 0x21, 2], [16, crc, 4], [20, data.length, 4], [24, data.length, 4], [28, name.length, 2], [30, 0, 2], [32, 0, 2], [34, 0, 2], [36, 0, 2], [38, (0o100644 << 16) >>> 0, 4], [42, off, 4]].forEach(([o, v, w]) => (w === 4 ? cd.setUint32(o!, v!, true) : cd.setUint16(o!, v!, true)));
      parts.push(new Uint8Array(local.buffer), name, data);
      central.push(new Uint8Array(cd.buffer), name);
      off += 30 + name.length + data.length;
    }
    const cdSize = central.reduce((n, c) => n + c.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    [[0, 0x06054b50, 4], [4, 0, 2], [6, 0, 2], [8, entries.length, 2], [10, entries.length, 2], [12, cdSize, 4], [16, off, 4], [20, 0, 2]].forEach(([o, v, w]) => (w === 4 ? end.setUint32(o!, v!, true) : end.setUint16(o!, v!, true)));
    const all = [...parts, ...central, new Uint8Array(end.buffer)];
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
  const load = async (before: [string, Uint8Array][], now: [string, Uint8Array][], name = "x") => {
    const sha = (b: Uint8Array) => new Bun.CryptoHasher("sha256").update(b).digest("hex");
    const bytes = new Map<string, Uint8Array>([...before, ...now].map(([n, b]) => [`https://files.example/${n}`, b]));
    const listing = (files: [string, Uint8Array][]) => files.map(([n, b]) => ({ url: `https://files.example/${n}`, filename: n, packagetype: n.endsWith(".whl") ? ("bdist_wheel" as const) : ("sdist" as const), sha256: sha(b) }));
    const registry = { latest: async () => undefined, publishedAt: async () => undefined, artifactUrls: async () => [], artifactFiles: async (_n: string, v: string) => listing(v === "1" ? before : now) };
    const fetcher = (async (u: string | URL) => new Response(bytes.get(String(u))! as unknown as BodyInit)) as unknown as typeof fetch;
    const work = join(dir, `pypi-${n++}`);
    mkdirSync(work);
    const art = await loadArtifacts({ eco: "pypi", name, from: "1", to: "2" } as ReviewArgs, registry as never, work, fetcher);
    return prepass("pypi", art.old, art.new);
  };
  const tarHolds = (r: ReturnType<typeof prepass>) => r.hard.filter((s) => s.kind === "tar-entry").map((s) => s.detail);

  for (const order of ["bz2 first", "gz first"])
    test(`a new .tar.bz2 with a link does not take the old .tar.gz as its counterpart (${order})`, async () => {
      const now: [string, Uint8Array][] = [["x-2.tar.bz2", sdist("2", true)], ["x-2.tar.gz", sdist("2", false)]];
      const r = await load([["x-1.tar.gz", sdist("1", true)]], order === "bz2 first" ? now : now.reverse());
      expect(tarHolds(r)).toContain("sdist: symlink x-2/docs/link");
    });

  test("a new file with the same bytes as a paired one still has no old side: its link holds", async () => {
    const r = await load([["x-1.tar.gz", sdist("1", true)]], [["x-2.tar.gz", sdist("2", true)], ["x-2.tar.bz2", sdist("2", true)]]);
    expect(tarHolds(r)).toEqual(["sdist: symlink x-2/docs/link"]);
    expect(r.carriedTarNotes).toEqual(["sdist: symlink x-2/docs/link"]);
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
    expect(tarHolds(r)).toEqual(["sdist: symlink x-2/docs/link"]);
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
