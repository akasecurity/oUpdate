// A multi-arch image index read from a Docker Hub repository: the index digest a FROM line pins and the
// build time of its linux/amd64 and linux/arm64 images. Every manifest and config blob is hashed and
// compared with the digest it was fetched by, so nothing between oupdate and the registry can swap one
// in, and a digest is checked for shape before it goes into a URL.

export interface OciImage {
  arch: string;
  digest: string;
  created: Date | undefined;
}

export interface OciIndex {
  /** sha256 of the index bytes, the value a FROM line pins. */
  digest: string;
  images: OciImage[];
  /** The latest `created` among the images; undefined when any is missing. */
  created: Date | undefined;
}

export interface OciSource {
  index(repository: string, tag: string): Promise<OciIndex>;
}

export const INDEX_TYPES = ["application/vnd.oci.image.index.v1+json", "application/vnd.docker.distribution.manifest.list.v2+json"];
export const MANIFEST_TYPES = ["application/vnd.oci.image.manifest.v1+json", "application/vnd.docker.distribution.manifest.v2+json"];
const CONFIG_TYPES = ["application/vnd.oci.image.config.v1+json", "application/vnd.docker.container.image.v1+json", "application/octet-stream"];
export const DIGEST = /^sha256:[0-9a-f]{64}$/;
const TAG = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const ARCHES = ["amd64", "arm64"];
const TIMEOUT_MS = 60_000;
const dec = new TextDecoder();

export const sha256Digest = (b: Uint8Array) => `sha256:${new Bun.CryptoHasher("sha256").update(b).digest("hex")}`;

interface IndexDoc {
  mediaType?: string;
  manifests?: { digest?: string; platform?: { os?: string; architecture?: string } }[];
}

function parseJson<T>(b: Uint8Array, what: string): T {
  try {
    return JSON.parse(dec.decode(b)) as T;
  } catch {
    throw new Error(`${what} is not JSON`);
  }
}

function when(s: string | undefined): Date | undefined {
  if (!s) return undefined;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export function dockerHubSource(deps: { fetch?: typeof fetch } = {}): OciSource {
  const f = deps.fetch ?? fetch;
  return {
    async index(repository, tag) {
      if (!TAG.test(tag)) throw new Error(`not an image tag: ${tag}`);
      const tr = await f(`https://auth.docker.io/token?service=registry.docker.io&scope=repository:${repository}:pull`, { headers: { "user-agent": "oupdate" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!tr.ok) throw new Error(`registry token HTTP ${tr.status}`);
      const token = ((await tr.json()) as { token?: unknown }).token;
      if (typeof token !== "string" || !token) throw new Error("registry token missing");
      const get = async (path: string, accept: string[]) => {
        const r = await f(`https://registry-1.docker.io/v2/${repository}/${path}`, {
          headers: { authorization: `Bearer ${token}`, accept: accept.join(", "), "user-agent": "oupdate" },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!r.ok) throw new Error(`registry HTTP ${r.status} for ${path}`);
        return { bytes: new Uint8Array(await r.arrayBuffer()), type: (r.headers.get("content-type") ?? "").split(";")[0]!.trim(), said: r.headers.get("docker-content-digest") ?? undefined };
      };
      const idx = await get(`manifests/${tag}`, [...INDEX_TYPES, ...MANIFEST_TYPES]);
      const digest = sha256Digest(idx.bytes);
      if (idx.said !== undefined && idx.said !== digest) throw new Error(`index bytes hash to ${digest}, the registry says ${idx.said}`);
      const doc = parseJson<IndexDoc>(idx.bytes, "index");
      const type = doc.mediaType ?? idx.type;
      if (!INDEX_TYPES.includes(type)) throw new Error(`${repository}:${tag} is not a multi-arch index (${type || "no media type"})`);
      const images: OciImage[] = [];
      for (const arch of ARCHES) {
        const hits = (doc.manifests ?? []).filter((m) => m.platform?.os === "linux" && m.platform?.architecture === arch);
        if (hits.length !== 1) throw new Error(`${repository}:${tag} has ${hits.length} linux/${arch} images`);
        const md = hits[0]!.digest ?? "";
        if (!DIGEST.test(md)) throw new Error(`linux/${arch} entry is not a sha256 digest`);
        const man = await get(`manifests/${md}`, MANIFEST_TYPES);
        if (sha256Digest(man.bytes) !== md) throw new Error(`linux/${arch} manifest does not hash to ${md}`);
        const cd = parseJson<{ config?: { digest?: string } }>(man.bytes, `linux/${arch} manifest`).config?.digest ?? "";
        if (!DIGEST.test(cd)) throw new Error(`linux/${arch} config is not a sha256 digest`);
        const blob = await get(`blobs/${cd}`, CONFIG_TYPES);
        if (sha256Digest(blob.bytes) !== cd) throw new Error(`linux/${arch} config does not hash to ${cd}`);
        images.push({ arch, digest: md, created: when(parseJson<{ created?: string }>(blob.bytes, `linux/${arch} config`).created) });
      }
      const created = images.every((i) => i.created) ? new Date(Math.max(...images.map((i) => i.created!.getTime()))) : undefined;
      return { digest, images, created };
    },
  };
}
