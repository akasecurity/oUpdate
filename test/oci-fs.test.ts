// The merged filesystem of an image's layers: listing, whiteouts, opaque directories, lazy fetches and the limits.
import { describe, expect, test } from "bun:test";
import { ImageTree, LayerError, LayerStore, LIMITS, MergedIndex, parseListing, sharedPrefix, type LayerListing } from "../src/oci-fs.ts";
import { fakeLayers, withTmp } from "./oci-helpers.ts";

const tree = (dir: string, names: string[], limits = LIMITS, opts: Parameters<typeof fakeLayers>[1] = {}) => {
  const img = fakeLayers(names, opts);
  const store = new LayerStore(dir, limits);
  return { img, store, t: new ImageTree(store, img.layers, img.fetchLayer) };
};
const text = (b: Uint8Array) => new TextDecoder().decode(b);

describe("parseListing", () => {
  const L = (s: string) => parseListing("sha256:x", "f", s);

  test("modes, owners, links, whiteouts and the opaque marker", () => {
    const l = L(
      [
        "drwxr-xr-x  0 0      0           0 Oct 27 23:11 ./etc/",
        "-rwsr-xr-x  0 5      6           2 Dec 31  2025 ./etc/a",
        "lrwxr-xr-x  0 0      0           0 Oct 27 23:11 ./etc/l -> /etc/a",
        "hrwsr-xr-x  0 0      0           0 Oct 27 23:11 ./etc/h link to ./etc/a",
        "-rw-r--r--  0 0      0           0 Oct 27 23:11 ./etc/.wh.gone",
        "-rw-r--r--  0 0      0           0 Oct 27 23:11 ./etc/.wh..wh..opq",
        "crw-rw-rw-  0 0      0           0 Oct 27 23:11 ./dev/null",
        "-rw-r--r--  0 0      0           2 Oct 27 23:11 ./etc/sp ace",
      ].join("\n"),
    );
    expect(l.entries.get("etc/a")).toMatchObject({ type: "file", mode: 0o4755, uid: 5, gid: 6, size: 2, member: "./etc/a" });
    expect(l.entries.get("etc/l")).toMatchObject({ type: "symlink", link: "/etc/a" });
    expect(l.entries.get("etc/h")).toMatchObject({ type: "file", size: 2, member: "./etc/a" });
    expect(l.entries.get("dev/null")!.type).toBe("device");
    expect(l.entries.get("etc/sp ace")!.size).toBe(2);
    expect([...l.whiteouts]).toEqual(["etc/gone"]);
    expect([...l.opaque]).toEqual(["etc"]);
    expect(l.entries.has("etc/.wh.gone")).toBe(false);
  });

  test("an unsafe member name, in either place a name appears, throws", () => {
    expect(() => L("-rw-r--r--  0 0      0           2 Oct 27 23:11 ../escape")).toThrow(LayerError);
    expect(() => L("-rw-r--r--  0 0      0           2 Oct 27 23:11 /abs")).toThrow(/unsafe/);
    expect(() => L("hrw-r--r--  0 0      0           0 Oct 27 23:11 a link to ../b")).toThrow(/unsafe/);
  });

  test("one spelling per path: doubled slashes and dot segments land on the canonical path, whiteouts included", () => {
    const l = L(
      [
        "-rw-r--r--  0 0      0           2 Oct 27 23:11 etc//ld.so.preload",
        "-rw-r--r--  0 0      0           2 Oct 27 23:11 ./etc/./cron.d/job",
        "-rw-r--r--  0 0      0           0 Oct 27 23:11 etc//.wh.gone",
        "-rw-r--r--  0 0      0           0 Oct 27 23:11 ./var/./.wh..wh..opq",
        "hrw-r--r--  0 0      0           0 Oct 27 23:11 etc//h link to ./etc/./cron.d/job",
      ].join("\n"),
    );
    expect([...l.entries.keys()].sort()).toEqual(["etc/cron.d/job", "etc/h", "etc/ld.so.preload"]);
    expect([...l.whiteouts]).toEqual(["etc/gone"]);
    expect([...l.opaque]).toEqual(["var"]);
    expect(l.entries.get("etc/h")!.size).toBe(2);
  });

  test("two spellings of one path in a layer are refused", () => {
    expect(() => L(["-rw-r--r--  0 0      0           2 Oct 27 23:11 etc/x", "-rw-r--r--  0 0      0           3 Oct 27 23:11 ./etc//x"].join("\n"))).toThrow(/two names for one path/);
  });

  test("a root opaque whiteout is refused, not supported", () => {
    expect(() => L("-rw-r--r--  0 0      0           0 Oct 27 23:11 ./.wh..wh..opq")).toThrow(/root opaque whiteout/);
    expect(() => L("-rw-r--r--  0 0      0           0 Oct 27 23:11 etc/.wh..wh..opq")).not.toThrow();
  });

  test("a trailing-slash spelling of a file's path collides with it; two directory spellings do not", () => {
    expect(() => L(["-rw-r--r--  0 0      0           2 Oct 27 23:11 etc/x", "drwxr-xr-x  0 0      0           0 Oct 27 23:11 etc/x/"].join("\n"))).toThrow(/two names for one path/);
    expect(() => L(["drwxr-xr-x  0 0      0           0 Oct 27 23:11 ./etc/", "drwxr-xr-x  0 0      0           0 Oct 27 23:11 etc/"].join("\n"))).not.toThrow();
  });

  test("a hard link named like another entry, and a whiteout beside an entry for its path, are refused", () => {
    expect(() => L(["-rw-r--r--  0 0      0           2 Oct 27 23:11 etc/x", "hrw-r--r--  0 0      0           0 Oct 27 23:11 ./etc//x link to etc/x"].join("\n"))).toThrow(/two names for one path/);
    expect(() => L(["-rw-r--r--  0 0      0           2 Oct 27 23:11 etc/gone", "-rw-r--r--  0 0      0           0 Oct 27 23:11 etc/.wh.gone"].join("\n"))).toThrow(/whiteout and an entry/);
  });

  test("a name or target holding bsdtar's link separator is refused, not split at a guess", () => {
    // A link named `libssl.so.3 -> libssl.so.3.0` to `true` lists exactly like a link `libssl.so.3` to `libssl.so.3.0 -> true`.
    expect(() => L("lrwxr-xr-x  0 0      0           0 Oct 27 23:11 ./usr/lib/libssl.so.3 -> libssl.so.3.0 -> true")).toThrow(/ambiguous member name/);
    expect(() => L("hrw-r--r--  0 0      0           0 Oct 27 23:11 ./usr/lib/libssl.so.3 link to x link to ./usr/lib/libssl.so.3.0")).toThrow(/ambiguous member name/);
    expect(() => L("-rw-r--r--  0 0      0           2 Oct 27 23:11 ./etc/a -> b")).toThrow(/ambiguous member name/);
    expect(() => L("lrwxr-xr-x  0 0      0           0 Oct 27 23:11 ./usr/lib/libssl.so.3 -> libssl.so.3.0")).not.toThrow();
  });

  test("a line it cannot read throws instead of being skipped", () => {
    expect(() => L("garbage")).toThrow(/unreadable listing/);
  });

  test("the entry cap throws before anything is kept", () => {
    const line = "-rw-r--r--  0 0      0           2 Oct 27 23:11 ./a";
    expect(() => parseListing("sha256:x", "f", [line, line, line].join("\n"), 2)).toThrow(/over the 2 cap/);
  });
});

describe("ImageTree", () => {
  test("a later layer overrides, a whiteout deletes, an opaque directory hides lower contents", async () => {
    await withTmp(async (dir) => {
      const { t } = tree(dir, ["base.tar", "old-top.tar", "new-wh.tar"]);
      expect((await t.resolve("etc/alpine-release"))!.size).toBe(7);
      expect(await t.resolve("etc/motd")).toBeUndefined();
      expect(await t.resolve("var/lib/app/data")).toBeUndefined();
      expect((await t.resolve("var/lib/app/fresh"))!.size).toBe(4);
      expect(await t.resolve("nothing/here")).toBeUndefined();
    });
  });

  test("without the whiteout layer the files are there", async () => {
    await withTmp(async (dir) => {
      const { t } = tree(dir, ["base.tar", "old-top.tar"]);
      expect(text(await t.read((await t.resolve("etc/motd"))!))).toBe("welcome\n");
      expect(text(await t.read((await t.resolve("var/lib/app/data"))!))).toBe("keep\n");
    });
  });

  test("under lists what any layer holds below a directory", async () => {
    await withTmp(async (dir) => {
      const { t } = tree(dir, ["base.tar", "new-wh.tar"]);
      expect((await t.under("var/lib/app")).sort()).toEqual(["var/lib/app/data", "var/lib/app/fresh"]);
    });
  });

  test("a layer is fetched when a path needs it and not before", async () => {
    await withTmp(async (dir) => {
      const { t, img } = tree(dir, ["base.tar", "old-top.tar"]);
      expect(img.fetched).toEqual([]);
      await t.resolve("app/server");
      expect(img.fetched).toEqual(["old-top.tar"]);
      await t.resolve("etc/passwd");
      expect(img.fetched).toEqual(["old-top.tar", "base.tar"]);
    });
  });

  test("a gzip layer reads like a plain one", async () => {
    await withTmp(async (dir) => {
      const { t } = tree(dir, ["base.tar", "new-run.tar.gz"]);
      expect(text(await t.read((await t.resolve("etc/s6-overlay/s6-rc.d/svc/run"))!))).toContain("8080");
    });
  });

  test("an unsupported media type, a failed fetch and an unsafe member each throw a LayerError naming the layer", async () => {
    await withTmp(async (dir) => {
      const a = tree(dir, ["base.tar"], LIMITS, { mediaTypes: { "base.tar": "application/vnd.oci.image.layer.nondistributable.v1.tar" } });
      await expect(a.t.resolve("etc/passwd")).rejects.toThrow(/unsupported layer media type/);
      const b = tree(dir, ["base.tar"], LIMITS, { fail: { "base.tar": "registry HTTP 404 for blobs/x" } });
      await expect(b.t.resolve("etc/passwd")).rejects.toThrow(/HTTP 404/);
      const c = tree(dir, ["new-unsafe.tar"]);
      await expect(c.t.resolve("escape")).rejects.toMatchObject({ digest: c.img.layers[0]!.digest, message: expect.stringContaining("unsafe member") });
    });
  });

  test("a file whose extracted bytes are not the size its header declares is refused", async () => {
    await withTmp(async (dir) => {
      const { t } = tree(dir, ["new-dup.tar"]);
      const n = (await t.resolve("etc/dupfile"))!;
      await expect(t.read(n)).rejects.toThrow(/header declares/);
    });
  });

  test("the entry cap and the content cap throw", async () => {
    await withTmp(async (dir) => {
      const a = tree(dir, ["base.tar"], { ...LIMITS, maxEntries: 3 });
      await expect(a.t.resolve("etc/passwd")).rejects.toThrow(/cap/);
      const b = tree(dir, ["base.tar"], { ...LIMITS, maxContent: 3 });
      await expect(b.t.read((await b.t.resolve("etc/passwd"))!)).rejects.toThrow(/byte cap/);
    });
  });

  test("a bsdtar call past the time limit is stopped and refused", async () => {
    await withTmp(async (dir) => {
      const { t } = tree(dir, ["base.tar"], { ...LIMITS, timeoutMs: 1 });
      await expect(MergedIndex.build(t)).rejects.toThrow(/bsdtar did not list the layer within 1 ms/);
    });
  });

  test("a listing over the entry cap is stopped while it is read", async () => {
    await withTmp(async (dir) => {
      const { t } = tree(dir, ["base.tar"], { ...LIMITS, maxEntries: 2 });
      await expect(t.resolve("etc/passwd")).rejects.toThrow(/more than 2 entries/);
    });
  });

  test("a symlink and a setuid file keep their facts", async () => {
    await withTmp(async (dir) => {
      const { t } = tree(dir, ["new-setuid.tar"]);
      expect((await t.resolve("etc/mylink"))).toMatchObject({ type: "symlink", link: "/etc/passwd" });
      expect((await t.resolve("usr/bin/su2"))!.mode & 0o4000).toBe(0o4000);
    });
  });
});

describe("sharedPrefix", () => {
  test("counts the leading layers two images share by digest", () => {
    const a = fakeLayers(["base.tar", "old-top.tar"]).layers;
    const b = fakeLayers(["base.tar", "new-run.tar.gz"]).layers;
    expect(sharedPrefix(a, b)).toBe(1);
    expect(sharedPrefix(a, a)).toBe(2);
    expect(sharedPrefix(a, [])).toBe(0);
  });
});

describe("MergedIndex", () => {
  const build = async (dir: string, names: string[]) => {
    const { t } = tree(dir, names);
    return MergedIndex.build(t);
  };

  test("layers merge in one pass: overrides, whiteouts and opaque directories, with implicit directories and the root", async () => {
    await withTmp(async (dir) => {
      const idx = await build(dir, ["base.tar", "old-top.tar", "new-wh.tar"]);
      expect(idx.get("etc/alpine-release")).toBeDefined();
      expect(idx.get("etc/motd")).toBeUndefined();
      expect(idx.get("var/lib/app/data")).toBeUndefined();
      expect(idx.get("var/lib/app/fresh")).toBeDefined();
      expect(idx.get("")!.type).toBe("dir");
    });
  });

  test("a hard link takes its target's content source when its layer applies, wherever the target lives", () => {
    const low = parseListing("sha256:low", "f", "-rw-r--r--  0 0      0           9 Oct 27 23:11 opt/preload");
    const high = parseListing("sha256:high", "f", "hrw-r--r--  0 0      0           0 Oct 27 23:11 etc/h link to opt/preload");
    const idx = MergedIndex.fromListings([low, high]);
    expect(idx.get("etc/h")).toMatchObject({ layer: "sha256:low", member: "opt/preload", size: 9, type: "file" });
    expect(idx.problems).toEqual([]);
    const lone = MergedIndex.fromListings([high]);
    expect(lone.problems).toEqual(["hard link target unresolved: etc/h -> opt/preload"]);
  });

  test("a layer naming one non-directory path twice is a problem, not a replay", () => {
    const row = (n: string, to: string) => `hrw-r--r--  0 0      0           0 Oct 27 23:11 ${n} link to ${to}`;
    const l = parseListing("sha256:r", "f", [row("var/cache/apt/mid", "var/cache/apt/B"), row("etc/ld.so.preload", "var/cache/apt/mid"), row("var/cache/apt/mid", "var/cache/apt/A")].join("\n"));
    expect(MergedIndex.fromListings([l]).problems).toContain("layer repeats path: var/cache/apt/mid");
    const dirs = parseListing("sha256:d", "f", ["drwxr-xr-x  0 0      0           0 Oct 27 23:11 etc/", "drwxr-xr-x  0 0      0           0 Oct 27 23:11 etc/"].join("\n"));
    expect(MergedIndex.fromListings([dirs]).problems).toEqual([]);
  });

  test("a chain of hard links resolves to the terminal content source, and a cycle or a missing end is a problem", () => {
    const low = parseListing("sha256:low", "f", "-rw-r--r--  0 0      0           9 Oct 27 23:11 data");
    const high = parseListing("sha256:high", "f", ["hrw-r--r--  0 0      0           0 Oct 27 23:11 mid link to data", "hrw-r--r--  0 0      0           0 Oct 27 23:11 top link to mid"].join("\n"));
    const idx = MergedIndex.fromListings([low, high]);
    expect(idx.get("top")).toMatchObject({ layer: "sha256:low", member: "data", size: 9 });
    expect(idx.get("mid")).toMatchObject({ layer: "sha256:low", member: "data", size: 9 });
    const cyc = parseListing("sha256:c", "f", ["hrw-r--r--  0 0      0           0 Oct 27 23:11 a link to b", "hrw-r--r--  0 0      0           0 Oct 27 23:11 b link to a"].join("\n"));
    expect(MergedIndex.fromListings([cyc]).problems).toEqual(["hard link target unresolved: a -> b", "hard link target unresolved: b -> a"]);
  });

  test("a member under a lower layer's link or file makes that path a directory, as an overlay unpack does, and is a problem", () => {
    const low = parseListing("sha256:low", "f", ["lrwxr-xr-x  0 0      0           0 Oct 27 23:11 lib -> usr/lib", "-rwxr-xr-x  0 0      0           3 Oct 27 23:11 usr/lib/run", "-rw-r--r--  0 0      0           3 Oct 27 23:11 opt"].join("\n"));
    const high = parseListing("sha256:high", "f", ["-rwxr-xr-x  0 0      0           4 Oct 27 23:11 lib/run", "-rw-r--r--  0 0      0           4 Oct 27 23:11 opt/x/y"].join("\n"));
    const idx = MergedIndex.fromListings([low, high]);
    expect(idx.get("lib")!.type).toBe("dir");
    expect(idx.resolve("lib/run")).toEqual({ final: "lib/run", links: [] });
    expect(idx.get("lib/run")!.layer).toBe("sha256:high");
    expect(idx.get("opt")!.type).toBe("dir");
    expect(idx.get("opt/x")!.type).toBe("dir");
    expect(idx.problems).toEqual(["layer writes under a lower symlink: lib/run (lib becomes a directory)", "layer writes under a lower file: opt/x/y (opt becomes a directory)"]);
  });

  test("members with no directory entries above them get implicit directories", async () => {
    await withTmp(async (dir) => {
      const idx = await build(dir, ["u5-old.tar"]);
      expect(idx.get("opt")!.type).toBe("dir");
      expect(idx.get("opt/hooks")!.type).toBe("dir");
      expect(idx.under("opt").sort()).toEqual(["opt/hooks", "opt/hooks/boot.sh"]);
    });
  });

  test("resolve follows links in every component, clamps to the root, and reports a loop or a miss", async () => {
    await withTmp(async (dir) => {
      const idx = await build(dir, ["u5-old.tar", "ep-old.tar"]);
      expect(idx.resolve("etc/init.d/boot.sh")).toEqual({ final: "opt/hooks/boot.sh", links: ["etc/init.d"] });
      expect(idx.resolve("bin/launch").final).toBe("usr/bin/launch");
      expect(idx.resolve("usr/bin/l3").final).toBe("usr/lib/real");
      expect(idx.resolve("../../../usr/lib/real").final).toBe("usr/lib/real");
      expect(idx.resolve("usr/bin/loop1").loop).toBe(true);
      expect(idx.resolve("nothing/here").final).toBeUndefined();
      expect(idx.resolve("/").final).toBe("");
    });
  });

  test("a hundred thousand mandatory-looking files over many layers merge in one pass", () => {
    const listing = (i: number): LayerListing => {
      const entries = new Map();
      for (let k = 0; k < 500; k++) {
        const path = `etc/cron.d/l${i}-f${k}`;
        entries.set(path, { path, type: "file", mode: 0o644, uid: 0, gid: 0, size: 1, layer: `sha256:${i}`, member: path });
      }
      return { digest: `sha256:${i}`, file: "", entries, whiteouts: new Set(), opaque: new Set() };
    };
    const idx = MergedIndex.fromListings(Array.from({ length: 200 }, (_, i) => listing(i)));
    expect(idx.under("etc/cron.d")).toHaveLength(100_000);
  });
});
