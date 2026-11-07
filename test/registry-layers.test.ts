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

describe("a layer download has a limit in total", () => {
  test("a blob that keeps arriving without end fails at the total the source was given", async () => {
    const A = enc.encode("a".repeat(500)); // larger than what arrives before the total
    const routes = image([A]);
    const real = fakeRegistry(routes);
    const endless = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes(`blobs/${sha256Digest(A)}`)) {
        const sig = init?.signal;
        return new Response(new ReadableStream({
          start(c) { sig?.addEventListener("abort", () => c.error(sig.reason)); },
          async pull(c) { await Bun.sleep(20); if (!sig?.aborted) c.enqueue(enc.encode("x")); },
        }));
      }
      return real(input, init);
    }) as typeof fetch;
    const got = await registrySource({ fetch: endless, downloadTimeoutMs: 5000, downloadTotalMs: 300 }).imageLayers!(REF, "linux/amd64");
    await tmp(async (dir) => {
      await expect(got.fetchLayer(got.layers[0]!, join(dir, "a"))).rejects.toThrow(/timed out after 300 ms in total/);
    });
  });
});

describe("a document that is JSON but not an object is refused by name", () => {
  const NULL = enc.encode("null");
  const nullDigest = sha256Digest(NULL);
  const base = "https://example.com/v2/app/";
  const INDEX_TYPE = "application/vnd.oci.image.index.v1+json";
  const read = (routes: Record<string, Route>) => registrySource({ fetch: fakeRegistry(routes) }).imageEvidence(REF, "linux/amd64");
  const message = (p: Promise<unknown>) => p.then(() => "resolved", (e: Error) => e.message);

  test("a tag that serves null", async () => {
    expect(await message(read({ [`${base}manifests/1`]: { body: NULL, type: MAN_TYPE } }))).toBe("manifest is not a JSON object");
  });

  test("an array or a scalar is refused the same way", async () => {
    for (const body of ["[1]", "5", '"s"']) {
      expect(await message(read({ [`${base}manifests/1`]: { body, type: MAN_TYPE } })), body).toBe("manifest is not a JSON object");
    }
  });

  test("an index entry that serves null", async () => {
    const index = JSON.stringify({ schemaVersion: 2, mediaType: INDEX_TYPE, manifests: [{ digest: nullDigest, platform: { os: "linux", architecture: "amd64" } }] });
    const routes = { [`${base}manifests/1`]: { body: index, type: INDEX_TYPE }, [`${base}manifests/${nullDigest}`]: { body: NULL, type: MAN_TYPE } };
    expect(await message(read(routes))).toBe("linux/amd64 manifest is not a JSON object");
  });

  test("a config that serves null", async () => {
    const manifest = JSON.stringify({ schemaVersion: 2, mediaType: MAN_TYPE, config: { mediaType: "application/vnd.oci.image.config.v1+json", digest: nullDigest, size: 4 }, layers: [] });
    const routes = { [`${base}manifests/1`]: { body: manifest, type: MAN_TYPE }, [`${base}blobs/${nullDigest}`]: { body: NULL } };
    expect(await message(read(routes))).toBe("linux/amd64 config is not a JSON object");
  });
});
