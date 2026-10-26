// Image groups: a new index digest under the fixed tag, and the apt snapshot id that follows the newest
// image build (the first midnight UTC after it), only when that snapshot is published.
import { describe, expect, test } from "bun:test";
import type { OciIndex, OciSource } from "../../src/adapters/oci/registry.ts";
import type { OciGroup } from "../../src/targets/pins/config.ts";
import { discoverOci, snapshotAfter, type SnapshotSource } from "../../src/targets/pins/oci.ts";

const OLD = `sha256:${"1".repeat(64)}`;
const NEW = `sha256:${"2".repeat(64)}`;
const G: OciGroup = { source: "oci-index", name: "base", registry: "docker-hub", repository: "library/sample", tagKey: "IMAGE_TAG", digestKey: "IMAGE_DIGEST", snapshot: { key: "APT_SNAPSHOT", base: "https://snapshot.example.com/ubuntu", suite: "noble" }, propose: true };
const CUR = new Map([["IMAGE_TAG", "24.04"], ["IMAGE_DIGEST", OLD], ["APT_SNAPSHOT", "20260919T000000Z"]]);
const BUILT = new Date("2026-10-01T21:23:00Z");
// null means "no build time" (an explicit undefined would take the default).
const index = (digest: string, built: Date | null = BUILT): OciIndex => {
  const created = built ?? undefined;
  return { digest, created, images: [{ arch: "amd64", digest: `sha256:${"a".repeat(64)}`, created }, { arch: "arm64", digest: `sha256:${"b".repeat(64)}`, created }] };
};
const oci = (r: OciIndex | Error): OciSource => ({
  index: async () => {
    if (r instanceof Error) throw r;
    return r;
  },
});
const snap = (ok: boolean) => {
  const asked: string[] = [];
  const s: SnapshotSource = { exists: async (b, id, suite) => (asked.push(`${b}/${id}/${suite}`), ok) };
  return { s, asked };
};

describe("oci pins", () => {
  test("snapshotAfter is the first midnight UTC strictly after the build", () => {
    expect(snapshotAfter(new Date("2026-09-18T21:23:00Z"))).toBe("20260919T000000Z");
    expect(snapshotAfter(new Date("2026-09-19T00:00:00Z"))).toBe("20260920T000000Z");
    expect(snapshotAfter(new Date("2026-12-31T23:00:00Z"))).toBe("20270101T000000Z");
  });

  test("the pinned digest is current", async () => {
    expect(await discoverOci(G, CUR, oci(index(OLD)), snap(true).s)).toEqual({ state: "current", group: "base", version: "sha256:111111111111" });
  });

  test("a new digest brings the snapshot id that follows its build", async () => {
    const { s, asked } = snap(true);
    const d = await discoverOci(G, CUR, oci(index(NEW)), s);
    expect(d).toMatchObject({ state: "newer", group: "base", from: "sha256:111111111111", to: "sha256:222222222222", publishedAt: BUILT });
    if (d.state !== "newer") throw new Error("not newer");
    expect(d.values).toEqual({ IMAGE_DIGEST: NEW, APT_SNAPSHOT: "20261002T000000Z" });
    expect(asked).toEqual(["https://snapshot.example.com/ubuntu/20261002T000000Z/noble"]);
    expect(d.evidence[0]).toBe(`library/sample:24.04 index ${NEW} (was ${OLD})`);
  });

  test("an unpublished snapshot is held, not trouble", async () => {
    expect(await discoverOci(G, CUR, oci(index(NEW)), snap(false).s)).toEqual({ state: "held", group: "base", why: "apt snapshot 20261002T000000Z has no noble InRelease yet" });
  });

  test("no build time, an older derived snapshot or a registry error is an error", async () => {
    expect(await discoverOci(G, CUR, oci(index(NEW, null)), snap(true).s)).toEqual({ state: "error", group: "base", why: "image build time unknown: no apt snapshot id can be derived" });
    const later = new Map([...CUR, ["APT_SNAPSHOT", "20261101T000000Z"]]);
    expect(await discoverOci(G, later, oci(index(NEW)), snap(true).s)).toEqual({ state: "error", group: "base", why: "derived snapshot 20261002T000000Z is older than the pinned 20261101T000000Z" });
    expect(await discoverOci(G, CUR, oci(new Error("registry HTTP 500 for manifests/24.04")), snap(true).s)).toEqual({ state: "error", group: "base", why: "library/sample:24.04: registry HTTP 500 for manifests/24.04" });
  });

  test("a group without a snapshot changes the digest only", async () => {
    const { snapshot: _s, ...noSnap } = G;
    const d = await discoverOci(noSnap, CUR, oci(index(NEW, null)), snap(true).s);
    expect(d).toMatchObject({ state: "newer", values: { IMAGE_DIGEST: NEW }, publishedAt: undefined });
  });
});
