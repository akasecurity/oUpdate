// registrySource().imageLayers: the layer list and config detail of one platform's image, and a blob fetch that checks
// size and sha256. No network: a route table of bytes by URL.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseImageRef, registrySource, sha256Digest } from "../src/adapters/oci/registry.ts";

const enc = new TextEncoder();
const REF = parseImageRef("example.com/app:1");
const MAN_TYPE = "application/vnd.oci.image.manifest.v1+json";

interface Route {
  body: Uint8Array | string;
  type?: string;
  status?: number;
}

function fakeRegistry(routes: Record<string, Route>, calls: string[] = []): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const r = routes[url];
    if (!r) return new Response("not found", { status: 404 });
    return new Response(r.body as BodyInit, { status: r.status ?? 200, headers: { "content-type": r.type ?? "application/octet-stream" } });
  }) as typeof fetch;
}

/** An image whose layers are the given blobs; `lie` replaces the bytes a layer's URL serves. */
function image(layerBytes: Uint8Array[], opts: { lie?: Record<number, Uint8Array>; mediaType?: string; config?: object; urls?: boolean } = {}) {
  const config = enc.encode(JSON.stringify({ architecture: "amd64", os: "linux", config: { Env: ["A=1"], User: "app", Volumes: { "/data": {} }, ...opts.config }, history: [] }));
  const cd = sha256Digest(config);
  const layers = layerBytes.map((b) => ({ mediaType: opts.mediaType ?? "application/vnd.oci.image.layer.v1.tar", digest: sha256Digest(b), size: b.length, ...(opts.urls ? { urls: ["https://elsewhere.example/x"] } : {}) }));
  const manifest = enc.encode(JSON.stringify({ schemaVersion: 2, mediaType: MAN_TYPE, config: { mediaType: "application/vnd.oci.image.config.v1+json", digest: cd, size: config.length }, layers }));
  const base = "https://example.com/v2/app/";
  const routes: Record<string, Route> = {
    [`${base}manifests/1`]: { body: manifest, type: MAN_TYPE },
    [`${base}blobs/${cd}`]: { body: config },
  };
  layerBytes.forEach((b, i) => (routes[`${base}blobs/${layers[i]!.digest}`] = { body: opts.lie?.[i] ?? b }));
  return routes;
}

function tmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "oup28-reg-"));
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

describe("imageLayers", () => {
  const A = enc.encode("layer one bytes");
  const B = enc.encode("layer two bytes, longer");

  test("lists the layers oldest first with the config detail", async () => {
    const got = await registrySource({ fetch: fakeRegistry(image([A, B])) }).imageLayers!(REF, "linux/amd64");
    expect(got.layers.map((l) => [l.digest, l.size])).toEqual([[sha256Digest(A), A.length], [sha256Digest(B), B.length]]);
    expect(got.detail.env).toEqual(["A=1"]);
    expect(got.detail.user).toBe("app");
    expect(got.detail.volumes).toEqual(["/data"]);
  });

  test("a fetched layer is written whole and nothing is fetched before it is asked for", async () => {
    const calls: string[] = [];
    const got = await registrySource({ fetch: fakeRegistry(image([A, B]), calls) }).imageLayers!(REF, "linux/amd64");
    expect(calls.some((u) => u.includes("blobs/sha256:" + sha256Digest(A).slice(7)))).toBe(false);
    await tmp(async (dir) => {
      await got.fetchLayer(got.layers[1]!, join(dir, "b"));
      expect(readFileSync(join(dir, "b"))).toEqual(Buffer.from(B));
    });
    expect(calls.filter((u) => u.includes(sha256Digest(B))).length).toBe(1);
    expect(calls.some((u) => u.includes(sha256Digest(A)))).toBe(false);
  });

  test("a blob that does not hash to its digest is refused", async () => {
    const liar = enc.encode("layer one bytez");
    const got = await registrySource({ fetch: fakeRegistry(image([A], { lie: { 0: liar } })) }).imageLayers!(REF, "linux/amd64");
    await tmp(async (dir) => {
      await expect(got.fetchLayer(got.layers[0]!, join(dir, "a"))).rejects.toThrow(/hashes to/);
    });
  });

  test("a blob longer than its manifest size is refused", async () => {
    const got = await registrySource({ fetch: fakeRegistry(image([A], { lie: { 0: enc.encode("layer one bytes and more") } })) }).imageLayers!(REF, "linux/amd64");
    await tmp(async (dir) => {
      await expect(got.fetchLayer(got.layers[0]!, join(dir, "a"))).rejects.toThrow(/larger than/);
    });
  });

  test("an HTTP error on a layer is an error", async () => {
    const routes = image([A, B]);
    delete routes[`https://example.com/v2/app/blobs/${sha256Digest(B)}`];
    const got = await registrySource({ fetch: fakeRegistry(routes) }).imageLayers!(REF, "linux/amd64");
    await tmp(async (dir) => {
      await expect(got.fetchLayer(got.layers[1]!, join(dir, "b"))).rejects.toThrow(/HTTP 404/);
    });
  });

  test("a layer with urls is marked foreign", async () => {
    const got = await registrySource({ fetch: fakeRegistry(image([A], { urls: true })) }).imageLayers!(REF, "linux/amd64");
    expect(got.layers[0]!.mediaType).toContain("(foreign)");
  });

  test("a manifest that is not the one already read is refused", async () => {
    const reg = registrySource({ fetch: fakeRegistry(image([A])) });
    const first = await reg.imageEvidence(REF, "linux/amd64");
    expect((await reg.imageLayers!(REF, "linux/amd64", first.digest)).layers).toHaveLength(1);
    await expect(reg.imageLayers!(REF, "linux/amd64", `sha256:${"0".repeat(64)}`)).rejects.toThrow(/now resolves to/);
  });

  test("imageEvidence still answers for the same image", async () => {
    const e = await registrySource({ fetch: fakeRegistry(image([A])) }).imageEvidence(REF, "linux/amd64");
    expect(e.entrypoint).toBe("null");
  });
});
