// `oupdate image` with layer contents: part 1 stays today's text, further parts carry the changed files, and a layer that
// cannot be read holds. No network: fixture layers behind a fake registry source and the fake reviewer.
import { describe, expect, test } from "bun:test";
import { checkImage, renderImage } from "../src/image.ts";
import { LIMITS } from "../src/oci-fs.ts";
import { parseImageRef, type ImageLayers, type ImageRef, type OciImageSource } from "../src/adapters/oci/registry.ts";
import type { ImageEvidence } from "../src/targets/broker/answer.ts";
import { reviewDiff } from "../src/targets/compose/evidence.ts";
import { fakeReviewer } from "./targets/fake-broker.ts";
import { fakeLayers } from "./oci-helpers.ts";

const OLD = parseImageRef("registry.example/team/app-a:5.14.0");
const NEW = parseImageRef("registry.example/team/app-a:5.15.0");
const NOW = new Date(2026, 9, 26, 12, 0);
const BASE = ["/bin/sh -c #(nop) ADD file:abc in / ", "RUN /bin/sh -c apk add --no-cache s6-overlay"];
const APPROVE = "1. none\n2. Verdict: APPROVE";
const FLAG = "1. \"x\"\n2. Verdict: FLAG odd";

const ev = (config: string, history: string[] = [...BASE].reverse()): ImageEvidence => ({
  digest: `sha256:${config.repeat(64).slice(0, 64)}`,
  config: `sha256:${config.repeat(64).slice(0, 64)}`,
  entrypoint: '["/app/server"]',
  cmd: "null",
  history,
});
const OLD_EV = ev("a");
const NEW_EV = ev("b", ["RUN /bin/sh -c apk add --upgrade tzdata", ...[...BASE].reverse()]);

function source(oldImg: ImageLayers, newImg: ImageLayers, withLayers = true): OciImageSource & { layerCalls: number; expects: (string | undefined)[] } {
  const s = {
    layerCalls: 0,
    expects: [] as (string | undefined)[],
    async imageEvidence(ref: ImageRef) {
      return ref.text === OLD.text ? OLD_EV : NEW_EV;
    },
    async imageLayers(ref: ImageRef, _platform?: string, expect?: string) {
      s.layerCalls++;
      s.expects.push(expect);
      // A tag that moved since the evidence was read is refused, as the registry source does.
      if (expect !== (ref.text === OLD.text ? OLD_EV : NEW_EV).digest) throw new Error("now resolves to another manifest");
      return ref.text === OLD.text ? oldImg : newImg;
    },
  };
  if (!withLayers) delete (s as { imageLayers?: unknown }).imageLayers;
  return s;
}

const OLD_LAYERS = ["base.tar", "old-top.tar"];

async function run(newNames: string[], opts: { first?: string; second?: string; layers?: boolean; limits?: typeof LIMITS; budget?: { chunkChars: number; maxParts: number }; newOpts?: Parameters<typeof fakeLayers>[1]; withLayers?: boolean } = {}) {
  const src = source(fakeLayers(OLD_LAYERS), fakeLayers(newNames, opts.newOpts), opts.withLayers);
  const r = fakeReviewer("first-m", opts.first ?? APPROVE);
  const o = opts.second === undefined ? undefined : fakeReviewer("second-m", opts.second);
  const res = await checkImage(
    { old: OLD, new: NEW, platform: "linux/amd64", now: NOW, layers: opts.layers ?? true, layerLimits: opts.limits, layerBudget: opts.budget },
    { source: src, reviewers: { first: r.reviewer, second: o?.reviewer } },
  );
  return { res, r, o, src };
}

describe("checkImage with layers", () => {
  test("part 1 starts with today's diff byte for byte; the changed file is a second part; both approved lands", async () => {
    const { res, r } = await run([...OLD_LAYERS, "new-run.tar.gz"]);
    expect(res.decision).toBe("land");
    expect(res.why).toBe("approved");
    expect(res.diff.startsWith(reviewDiff(OLD_EV, NEW_EV))).toBe(true);
    expect(res.diff.split("\n")[0]).toBe("RUN /bin/sh -c apk add --upgrade tzdata");
    expect(r.prompts).toHaveLength(2);
    expect(r.prompts[0]).toContain(`| [${NEW.text}]\n| RUN /bin/sh -c apk add --upgrade tzdata\n| FILES: `);
    expect(r.prompts[1]).toContain("| === etc/s6-overlay/s6-rc.d/svc/run (changed) ===");
    expect(res.layers).toBe("layers: 3 read, 0 not read (shared by both images); 1 file part reviewed");
  });

  test("the layers are asked for by the manifest digests the evidence read, so a moved tag holds", async () => {
    const { src } = await run([...OLD_LAYERS, "new-run.tar.gz"]);
    expect(src.expects).toEqual([OLD_EV.digest, NEW_EV.digest]);
    const moved = source(fakeLayers(OLD_LAYERS), fakeLayers([...OLD_LAYERS, "new-run.tar.gz"]));
    moved.imageEvidence = async (ref) => (ref.text === OLD.text ? OLD_EV : ev("c"));
    const res = await checkImage({ old: OLD, new: NEW, platform: "linux/amd64", now: NOW, layers: true }, { source: moved, reviewers: { first: fakeReviewer("r", APPROVE).reviewer } });
    expect(res.decision).toBe("hold");
    expect(res.hits[0]).toContain("LAYERS UNREADABLE");
    expect(res.hits[0]).toContain("now resolves to");
  });

  test("an ENV added with a URL is in part 1", async () => {
    const { r } = await run([...OLD_LAYERS, "new-run.tar.gz"], { newOpts: { detail: { env: ["API=https://evil.example/x"] } } });
    expect(r.prompts[0]).toContain("| ENV +API=https://evil.example/x");
  });

  test("a FLAG holds, and the parts after it are not asked", async () => {
    const { res, r } = await run(["base.tar", "old-top.tar", "new-run.tar.gz", "new-cacert.tar"], { first: FLAG });
    expect(res.decision).toBe("hold");
    expect(res.why).toBe("review: first FLAG");
    expect(r.prompts).toHaveLength(1);
  });

  test("a write to ld.so.preload holds whatever the reviewers say", async () => {
    const { res } = await run([...OLD_LAYERS, "new-preload.tar"], { second: APPROVE });
    expect(res.decision).toBe("hold");
    expect(res.why).toMatch(/^pre-gate: \d+ hits?$/);
    expect(res.hits).toContain("startup path added: etc/ld.so.preload");
    expect(res.first).toBe("APPROVE");
  });

  test("a write spelled etc//ld.so.preload holds end to end, whatever the reviewers say", async () => {
    const { res } = await run([...OLD_LAYERS, "new-slashes.tar"], { second: APPROVE });
    expect(res.decision).toBe("hold");
    expect(res.hits).toContain("startup path added: etc/ld.so.preload");
    expect(res.first).toBe("APPROVE");
  });

  test("a root opaque whiteout holds end to end as an unreadable layer", async () => {
    const { res } = await run([...OLD_LAYERS, "new-rootopq.tar"], { second: APPROVE });
    expect(res.decision).toBe("hold");
    expect(res.hits[0]).toMatch(/^LAYERS UNREADABLE: sha256:[0-9a-f]{64}: root opaque whiteout$/);
  });

  test("a 1,000,001-byte file holds end to end: the reviewers never saw its content", async () => {
    const { res } = await run([...OLD_LAYERS, "new-big.tar.gz"], { second: APPROVE });
    expect(res.decision).toBe("hold");
    expect(res.hits).toContain("content not shown: app/server.py added (1000001 bytes, over the 1000000 byte limit)");
  });

  test("a start target that resolves to nothing holds", async () => {
    const { res } = await run([...OLD_LAYERS, "new-run.tar.gz"], { second: APPROVE });
    expect(res.decision).toBe("land");
    const src = source(fakeLayers(OLD_LAYERS), fakeLayers([...OLD_LAYERS, "new-run.tar.gz"]));
    src.imageEvidence = async (ref) => (ref.text === OLD.text ? OLD_EV : { ...NEW_EV, entrypoint: '["/missing/bin"]' });
    const held = await checkImage({ old: OLD, new: NEW, platform: "linux/amd64", now: NOW, layers: true }, { source: src, reviewers: { first: fakeReviewer("r", APPROVE).reviewer } });
    expect(held.decision).toBe("hold");
    expect(held.hits).toContain("start target unresolved: /missing/bin");
  });

  test("an apk upgrade lands on package lines alone, the files it replaced counted", async () => {
    const { res, r } = await run([...OLD_LAYERS, "new-apk.tar"]);
    expect(res.decision).toBe("land");
    expect(r.prompts).toHaveLength(1);
    expect(r.prompts[0]).toContain("| +tzdata 2024b-r0");
    expect(r.prompts[0]).not.toContain("TZ-2024b");
  });

  const unreadableCases: [string, Parameters<typeof run>[1], RegExp][] = [
    ["a blob that does not hash to its digest", { newOpts: { fail: { "new-run.tar.gz": "blob hashes to sha256:00, not sha256:11" } } }, /: blob hashes to/],
    ["a 404 on one layer", { newOpts: { fail: { "new-run.tar.gz": "registry HTTP 404 for blobs/sha256:x" } } }, /: registry HTTP 404/],
    ["a foreign media type", { newOpts: { mediaTypes: { "new-run.tar.gz": "application/vnd.docker.image.rootfs.foreign.diff.tar.gzip" } } }, /: unsupported layer media type/],
    ["a ../ member", { newOpts: {} }, /: unsafe member name: \.\.\/escape/],
    ["an entry-cap overflow", { limits: { ...LIMITS, maxEntries: 3 } }, /: layers? lists? .*cap|: layer lists/],
  ];
  for (const [name, opts, why] of unreadableCases) {
    test(`${name} holds with LAYERS UNREADABLE, whatever the reviewers say`, async () => {
      const names = name === "a ../ member" ? [...OLD_LAYERS, "new-unsafe.tar"] : [...OLD_LAYERS, "new-run.tar.gz"];
      const { res, r } = await run(names, opts);
      expect(res.decision).toBe("hold");
      expect(res.why).toBe("layers unreadable");
      expect(res.hits).toHaveLength(1);
      expect(res.hits[0]).toMatch(/^LAYERS UNREADABLE: sha256:[0-9a-f]{64}/);
      expect(res.hits[0]).toMatch(why);
      expect(r.prompts).toHaveLength(0);
      expect(res.layers).toBe("layers: not read");
    });
  }

  test("a source that cannot read layers holds when layers are asked for", async () => {
    const { res } = await run([...OLD_LAYERS, "new-run.tar.gz"], { withLayers: false });
    expect(res.decision).toBe("hold");
    expect(res.hits[0]).toContain("this source cannot read layers");
  });

  test("a diff over the part budget stops for a human and never lands, even on APPROVE", async () => {
    const { res } = await run([...OLD_LAYERS, "new-setuid.tar", "new-cacert.tar"], { budget: { chunkChars: 40, maxParts: 1 }, second: APPROVE });
    expect(res.decision).toBe("hold");
    expect(res.hits.length).toBeGreaterThan(0);
  });

  test("an over-budget diff with no hits holds with the budget as the reason", async () => {
    const { res } = await run([...OLD_LAYERS, "new-cacert.tar", "new-run.tar.gz"], { budget: { chunkChars: 40, maxParts: 1 } });
    expect(res.decision).toBe("hold");
    expect(res.why).toMatch(/^too large for model review: .*needs a human$/);
  });

  test("--no-layers: the source is not asked for layers and the result says so", async () => {
    const { res, src, r } = await run([...OLD_LAYERS, "new-run.tar.gz"], { layers: false });
    expect(src.layerCalls).toBe(0);
    expect(res.layers).toBe("layer contents not read");
    expect(res.decision).toBe("land");
    expect(r.prompts).toHaveLength(1);
    expect(renderImage(res)).toContain("  layers    layer contents not read");
  });

  test("the same config digest lands without reading layers", async () => {
    const src = source(fakeLayers(OLD_LAYERS), fakeLayers(OLD_LAYERS));
    src.imageEvidence = async () => OLD_EV;
    const res = await checkImage({ old: OLD, new: NEW, platform: "linux/amd64", now: NOW, layers: true }, { source: src, reviewers: {} });
    expect(res.why).toBe("unchanged");
    expect(src.layerCalls).toBe(0);
  });

  test("renderImage shows the layer line after the reviewer line", async () => {
    const { res } = await run([...OLD_LAYERS, "new-run.tar.gz"]);
    const lines = renderImage(res).split("\n");
    expect(lines[3]).toBe("  reviewer  first APPROVE · second not asked");
    expect(lines[4]).toMatch(/^  layers    layers: 3 read/);
  });
});
