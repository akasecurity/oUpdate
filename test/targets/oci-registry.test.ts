// The Docker Hub index read: index digest from the bytes, linux/amd64 and linux/arm64 only, every
// manifest and config checked against its digest, newest build time.
import { describe, expect, test } from "bun:test";
import { dockerHubSource, parseImageRef, registrySource, sha256Digest } from "../../src/adapters/oci/registry.ts";

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

// The standalone image check's read: any registry, anonymous bearer auth from the 401 challenge, one
// platform's manifest and config, mapped to the same ImageEvidence a broker reach sends.
const IMG_CONFIG = "application/vnd.oci.image.config.v1+json";
const HIST = [
  { created_by: "/bin/sh -c #(nop) ADD file:abc in / " },
  { empty_layer: true },
  { created_by: "RUN /bin/sh -c apk add --no-cache curl # buildkit" },
];

interface RegFx {
  challenge?: "bearer" | "bare" | "none";
  single?: { os: string; architecture: string };
  tamper?: "manifest" | "blob";
  badEntry?: boolean;
  entrypoint?: unknown;
  cmd?: unknown;
  /** Also serve the index under this digest: a registry answering a digest ref with other bytes. */
  serveAs?: string;
  /** The challenge's token realm. */
  realm?: string;
  /** Answer the config blob with a 307 to this URL, which serves it. */
  redirect?: string;
}

function registry(fx: RegFx = {}) {
  const served = new Map<string, { bytes: Uint8Array; type: string }>();
  const plat: Record<string, { os: string; architecture: string; variant?: string }> = {
    amd64: { os: "linux", architecture: "amd64" },
    arm64: { os: "linux", architecture: "arm64", variant: "v8" },
  };
  const entries: unknown[] = [];
  const digests: Record<string, string> = {};
  for (const [arch, p] of Object.entries(fx.single ? { one: fx.single } : plat)) {
    const cfg = enc({
      architecture: p.architecture,
      os: p.os,
      config: { Entrypoint: "entrypoint" in fx ? fx.entrypoint : ["/init"], ...("cmd" in fx ? { Cmd: fx.cmd } : {}) },
      history: [...HIST, { created_by: `LABEL arch=${arch}` }],
    });
    const cd = sha256Digest(cfg);
    served.set(`blobs/${cd}`, { bytes: fx.tamper === "blob" ? enc({ swapped: true }) : cfg, type: IMG_CONFIG });
    const man = enc({ schemaVersion: 2, mediaType: MAN, config: { mediaType: IMG_CONFIG, digest: cd }, layers: [] });
    const md = sha256Digest(man);
    digests[arch] = md;
    digests[`${arch}-config`] = cd;
    if (fx.single) served.set("manifests/1.0", { bytes: man, type: MAN });
    served.set(`manifests/${md}`, { bytes: fx.tamper === "manifest" ? enc({ swapped: true }) : man, type: MAN });
    entries.push({ mediaType: MAN, digest: fx.badEntry ? "sha256:../../x" : md, platform: p });
  }
  if (!fx.single) {
    const idx = enc({ schemaVersion: 2, mediaType: IDX, manifests: entries });
    digests.index = sha256Digest(idx);
    served.set("manifests/1.0", { bytes: idx, type: IDX });
    served.set(`manifests/${digests.index}`, { bytes: idx, type: IDX });
    if (fx.serveAs) served.set(`manifests/${fx.serveAs}`, { bytes: idx, type: IDX });
  }
  const calls: { url: string; auth: string }[] = [];
  const challenge = fx.challenge ?? "bearer";
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const auth = new Headers(init?.headers).get("authorization") ?? "";
    calls.push({ url, auth });
    if (url.startsWith("https://auth.example/token?") || url.startsWith("http://auth.example/token?")) return Response.json({ token: "anon" });
    if (fx.redirect && url === fx.redirect) return new Response(new Uint8Array(served.get(`blobs/${digests["amd64-config"]}`)!.bytes), { headers: { "content-type": IMG_CONFIG } });
    const path = url.replace("https://registry.example/v2/team/app-a/", "");
    if (challenge !== "none" && auth !== "Bearer anon") {
      const headers: Record<string, string> = challenge === "bearer" ? { "www-authenticate": `Bearer realm="${fx.realm ?? "https://auth.example/token"}",service="registry.example",scope="repository:team/app-a:pull"` } : {};
      return new Response("unauthorized", { status: 401, headers });
    }
    if (fx.redirect && path === `blobs/${digests["amd64-config"]}`) return new Response(null, { status: 307, headers: { location: fx.redirect } });
    const s = served.get(path);
    if (!s) return new Response("no", { status: 404 });
    return new Response(new Uint8Array(s.bytes), { headers: { "content-type": s.type } });
  }) as unknown as typeof fetch;
  return { src: registrySource({ fetch: f }), calls, digests };
}

const APP_A = (reference: string) => parseImageRef(`registry.example/team/app-a${reference}`);

describe("parseImageRef", () => {
  test("docker.io and library/ are the defaults, latest the default tag", () => {
    expect(parseImageRef("alpine")).toMatchObject({ registry: "docker.io", repository: "library/alpine", reference: "latest" });
    expect(parseImageRef("grafana/grafana:11.2.0")).toMatchObject({ registry: "docker.io", repository: "grafana/grafana", reference: "11.2.0" });
    expect(parseImageRef("registry.example/team/app-a:5.14.0")).toMatchObject({ registry: "registry.example", repository: "team/app-a", reference: "5.14.0", text: "registry.example/team/app-a:5.14.0" });
    expect(parseImageRef("localhost:5000/app:1")).toMatchObject({ registry: "localhost:5000", repository: "app", reference: "1" });
  });

  test("a digest ref, with or without a tag, uses the digest", () => {
    const d = `sha256:${"a".repeat(64)}`;
    expect(parseImageRef(`ghcr.io/o/app@${d}`)).toMatchObject({ registry: "ghcr.io", repository: "o/app", reference: d });
    expect(parseImageRef(`ghcr.io/o/app:1.0@${d}`)).toMatchObject({ reference: d, text: `ghcr.io/o/app:1.0@${d}` });
  });

  test("a bad tag, digest or name is an error", () => {
    expect(() => parseImageRef("alpine:1.0;x")).toThrow("not an image tag");
    expect(() => parseImageRef("alpine@sha256:abc")).toThrow("not a sha256 digest");
    expect(() => parseImageRef("Alpine/UPPER:1")).toThrow("not an image name");
    expect(() => parseImageRef("")).toThrow("not an image name");
  });
});

describe("registrySource", () => {
  test("follows the 401 bearer challenge anonymously and reads one platform's evidence", async () => {
    const r = registry();
    const e = await r.src.imageEvidence(APP_A(":1.0"), "linux/amd64");
    expect(e.digest).toBe(r.digests.amd64);
    expect(e.config).toBe(r.digests["amd64-config"]);
    expect(e.entrypoint).toBe('["/init"]');
    expect(e.cmd).toBe("null");
    // Newest first, as docker history prints it; an entry with no created_by is an empty line.
    expect(e.history).toEqual(["LABEL arch=amd64", "RUN /bin/sh -c apk add --no-cache curl # buildkit", "", "/bin/sh -c #(nop) ADD file:abc in / "]);
    const tok = r.calls.find((c) => c.url.startsWith("https://auth.example/token?"))!;
    expect(new URL(tok.url).searchParams.get("service")).toBe("registry.example");
    expect(new URL(tok.url).searchParams.get("scope")).toBe("repository:team/app-a:pull");
    expect(tok.auth).toBe("");
    // One token, then every later request carries it.
    expect(r.calls.filter((c) => c.url.startsWith("https://auth.example/")).length).toBe(1);
    expect(r.calls.at(-1)!.auth).toBe("Bearer anon");
  });

  test("a token realm that is not https is refused before it is asked", async () => {
    const r = registry({ realm: "http://auth.example/token" });
    await expect(r.src.imageEvidence(APP_A(":1.0"), "linux/amd64")).rejects.toThrow("registry token realm is not https: http://auth.example");
    expect(r.calls.some((c) => c.url.startsWith("http://auth.example/"))).toBe(false);
  });

  test("a redirect to another origin is followed without the token; a redirect to plain http is refused", async () => {
    const r = registry({ redirect: "https://cdn.example/blob/config" });
    expect((await r.src.imageEvidence(APP_A(":1.0"), "linux/amd64")).config).toBe(r.digests["amd64-config"]);
    const cdn = r.calls.filter((c) => c.url.startsWith("https://cdn.example/"));
    expect(cdn).toHaveLength(1);
    expect(cdn[0]!.auth).toBe("");
    await expect(registry({ redirect: "http://cdn.example/blob/config" }).src.imageEvidence(APP_A(":1.0"), "linux/amd64")).rejects.toThrow("registry redirect to a non-https URL");
  });

  test("an arm64 platform picks the arm64 entry, with or without the variant", async () => {
    const r = registry();
    expect((await r.src.imageEvidence(APP_A(":1.0"), "linux/arm64")).digest).toBe(r.digests.arm64);
    expect((await r.src.imageEvidence(APP_A(":1.0"), "linux/arm64/v8")).digest).toBe(r.digests.arm64);
    await expect(r.src.imageEvidence(APP_A(":1.0"), "linux/s390x")).rejects.toThrow("has 0 linux/s390x images");
  });

  test("a registry that needs no auth is read directly; a 401 with no challenge is an error", async () => {
    const open = registry({ challenge: "none" });
    expect((await open.src.imageEvidence(APP_A(":1.0"), "linux/amd64")).digest).toBe(open.digests.amd64);
    expect(open.calls.every((c) => c.auth === "")).toBe(true);
    await expect(registry({ challenge: "bare" }).src.imageEvidence(APP_A(":1.0"), "linux/amd64")).rejects.toThrow("registry HTTP 401");
  });

  test("Entrypoint and Cmd are canonical JSON as a broker reach decodes them", async () => {
    const e = await registry({ entrypoint: null, cmd: ["sh", "-c", "run"] }).src.imageEvidence(APP_A(":1.0"), "linux/amd64");
    expect(e.entrypoint).toBe("null");
    expect(e.cmd).toBe('["sh","-c","run"]');
    await expect(registry({ entrypoint: "a string" }).src.imageEvidence(APP_A(":1.0"), "linux/amd64")).rejects.toThrow("Entrypoint is not null or a string array");
  });

  test("a single-platform image is accepted only for its own platform", async () => {
    const r = registry({ single: { os: "linux", architecture: "amd64" } });
    expect((await r.src.imageEvidence(APP_A(":1.0"), "linux/amd64")).history[0]).toBe("LABEL arch=one");
    await expect(r.src.imageEvidence(APP_A(":1.0"), "linux/arm64")).rejects.toThrow("is linux/amd64, not linux/arm64");
  });

  test("a digest ref must hash to itself", async () => {
    const r = registry();
    expect((await r.src.imageEvidence(APP_A(`@${r.digests.index}`), "linux/amd64")).digest).toBe(r.digests.amd64);
    const other = `sha256:${"0".repeat(64)}`;
    await expect(registry({ serveAs: other }).src.imageEvidence(APP_A(`@${other}`), "linux/amd64")).rejects.toThrow(`does not hash to ${other}`);
  });

  test("a swapped manifest or config blob, or a malformed entry digest, is refused", async () => {
    await expect(registry({ tamper: "manifest" }).src.imageEvidence(APP_A(":1.0"), "linux/amd64")).rejects.toThrow("linux/amd64 manifest does not hash to sha256:");
    await expect(registry({ tamper: "blob" }).src.imageEvidence(APP_A(":1.0"), "linux/amd64")).rejects.toThrow("linux/amd64 config does not hash to sha256:");
    const bad = registry({ badEntry: true });
    await expect(bad.src.imageEvidence(APP_A(":1.0"), "linux/amd64")).rejects.toThrow("linux/amd64 entry is not a sha256 digest");
    expect(bad.calls.some((c) => c.url.includes(".."))).toBe(false);
  });
});
