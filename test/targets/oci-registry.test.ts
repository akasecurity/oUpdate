// The Docker Hub index read: index digest from the bytes, linux/amd64 and linux/arm64 only, every
// manifest and config checked against its digest, newest build time.
import { describe, expect, test } from "bun:test";
import { dockerHubSource, sha256Digest } from "../../src/adapters/oci/registry.ts";

const MAN = "application/vnd.oci.image.manifest.v1+json";
const IDX = "application/vnd.oci.image.index.v1+json";
const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));
const CREATED: Record<string, string> = { amd64: "2026-10-01T21:20:00Z", arm64: "2026-10-01T21:23:00Z", s390x: "2026-10-01T21:30:00Z" };

interface Fx { drop?: string; tamper?: string; noCreated?: string; badEntry?: boolean; said?: string; single?: boolean; tokenStatus?: number }

function hub(fx: Fx = {}) {
  const served = new Map<string, Uint8Array>();
  const manifests: unknown[] = [];
  for (const arch of ["amd64", "arm64", "s390x"]) {
    if (arch === fx.drop) continue;
    const cfg = enc(arch === fx.noCreated ? {} : { created: CREATED[arch] });
    const cd = sha256Digest(cfg);
    served.set(`blobs/${cd}`, cfg);
    const man = enc({ schemaVersion: 2, mediaType: MAN, config: { digest: cd }, layers: [] });
    const md = sha256Digest(man);
    served.set(`manifests/${md}`, arch === fx.tamper ? enc({ swapped: true }) : man);
    manifests.push({ mediaType: MAN, digest: fx.badEntry && arch === "arm64" ? "sha256:../../other" : md, platform: { os: "linux", architecture: arch } });
  }
  const index = enc(fx.single ? { schemaVersion: 2, mediaType: MAN, config: {}, layers: [] } : { schemaVersion: 2, mediaType: IDX, manifests });
  served.set("manifests/1.0", index);
  const auth: string[] = [];
  const paths: string[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://auth.docker.io/token")) return fx.tokenStatus ? new Response("no", { status: fx.tokenStatus }) : Response.json({ token: "t0k" });
    const path = url.replace("https://registry-1.docker.io/v2/library/sample/", "");
    paths.push(path);
    auth.push(new Headers(init?.headers).get("authorization") ?? "");
    const b = served.get(path);
    if (!b) return new Response("no", { status: 404 });
    const headers: Record<string, string> = { "content-type": path === "manifests/1.0" ? (fx.single ? MAN : IDX) : MAN };
    if (path === "manifests/1.0") headers["docker-content-digest"] = fx.said ?? sha256Digest(index);
    return new Response(new Uint8Array(b), { headers });
  }) as unknown as typeof fetch;
  return { src: dockerHubSource({ fetch: f }), auth, paths, indexDigest: sha256Digest(index) };
}

describe("dockerHubSource", () => {
  test("reads the index digest and the amd64 and arm64 build times", async () => {
    const h = hub();
    const idx = await h.src.index("library/sample", "1.0");
    expect(idx.digest).toBe(h.indexDigest);
    expect(idx.images.map((i) => [i.arch, i.created?.toISOString()])).toEqual([["amd64", "2026-10-01T21:20:00.000Z"], ["arm64", "2026-10-01T21:23:00.000Z"]]);
    expect(idx.created?.toISOString()).toBe("2026-10-01T21:23:00.000Z");
    expect(new Set(h.auth)).toEqual(new Set(["Bearer t0k"]));
    // The index, then one manifest and one config per wanted arch: the s390x image is never fetched.
    expect(h.paths).toHaveLength(5);
  });

  test("a config with no created time leaves created undefined", async () => {
    const idx = await hub({ noCreated: "amd64" }).src.index("library/sample", "1.0");
    expect(idx.images[0]!.created).toBeUndefined();
    expect(idx.created).toBeUndefined();
  });

  // Review Focus 5: content addressing is checked at every hop.
  test("index bytes that do not match the registry's digest are refused", async () => {
    await expect(hub({ said: `sha256:${"0".repeat(64)}` }).src.index("library/sample", "1.0")).rejects.toThrow("the registry says sha256:" + "0".repeat(64));
  });

  test("a swapped manifest is refused", async () => {
    await expect(hub({ tamper: "arm64" }).src.index("library/sample", "1.0")).rejects.toThrow("linux/arm64 manifest does not hash to sha256:");
  });

  test("a malformed digest never reaches a URL", async () => {
    const h = hub({ badEntry: true });
    await expect(h.src.index("library/sample", "1.0")).rejects.toThrow("linux/arm64 entry is not a sha256 digest");
    expect(h.paths.some((p) => p.includes(".."))).toBe(false);
  });

  test("a missing arch or a single-arch manifest is refused", async () => {
    await expect(hub({ drop: "arm64" }).src.index("library/sample", "1.0")).rejects.toThrow("library/sample:1.0 has 0 linux/arm64 images");
    await expect(hub({ single: true }).src.index("library/sample", "1.0")).rejects.toThrow("library/sample:1.0 is not a multi-arch index");
  });

  test("a bad tag or a token failure is an error", async () => {
    await expect(hub().src.index("library/sample", "1.0;x")).rejects.toThrow("not an image tag: 1.0;x");
    await expect(hub({ tokenStatus: 503 }).src.index("library/sample", "1.0")).rejects.toThrow("registry token HTTP 503");
  });
});
