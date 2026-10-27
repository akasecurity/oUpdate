// A multi-arch image index read from a Docker Hub repository: the index digest a FROM line pins and the
// build time of its linux/amd64 and linux/arm64 images. Every manifest and config blob is hashed and
// compared with the digest it was fetched by, so nothing between oupdate and the registry can swap one
// in, and a digest is checked for shape before it goes into a URL.
//
// registrySource reads one platform's image from any registry that allows anonymous pulls (the 401 bearer challenge,
// followed with no credentials) and maps its config blob to the ImageEvidence the NAS sends for `oupdate image`.

import { jsonArgv, type ImageEvidence } from "../../targets/nas/answer.ts";

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
  manifests?: { digest?: string; platform?: { os?: string; architecture?: string; variant?: string } }[];
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

/** An image reference, `[registry/]repo[:tag|@sha256:…]`, with Docker's defaults applied. */
export interface ImageRef {
  /** `docker.io` for a name with no registry. */
  registry: string;
  /** With `library/` added for a bare Docker Hub name. */
  repository: string;
  /** The digest when one is given, else the tag (`latest` by default). */
  reference: string;
  /** The reference as it was written. */
  text: string;
}

const COMPONENT = /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*$/;
const HOST = /^(?:localhost|[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*)(?::[0-9]{1,5})?$/;

export function parseImageRef(s: string): ImageRef {
  let rest = s;
  let digest: string | undefined;
  const at = rest.indexOf("@");
  if (at >= 0) {
    digest = rest.slice(at + 1);
    rest = rest.slice(0, at);
    if (!DIGEST.test(digest)) throw new Error(`not a sha256 digest: ${digest}`);
  }
  let tag: string | undefined;
  const colon = rest.lastIndexOf(":");
  if (colon > rest.lastIndexOf("/")) {
    tag = rest.slice(colon + 1);
    rest = rest.slice(0, colon);
    if (!TAG.test(tag)) throw new Error(`not an image tag: ${tag}`);
  }
  const parts = rest.split("/");
  let registry = "docker.io";
  if (parts.length > 1 && /[.:]|^localhost$/.test(parts[0]!)) {
    registry = parts.shift()!;
    if (!HOST.test(registry)) throw new Error(`not a registry host: ${registry}`);
    if (registry === "index.docker.io") registry = "docker.io";
  }
  if (!parts.every((c) => COMPONENT.test(c))) throw new Error(`not an image name: ${s || "(empty)"}`);
  if (registry === "docker.io" && parts.length === 1) parts.unshift("library");
  return { registry, repository: parts.join("/"), reference: digest ?? tag ?? "latest", text: s };
}

export interface OciImageSource {
  /** One platform's evidence; `platform` is `os/arch[/variant]`. Throws when anything cannot be read or verified. */
  imageEvidence(ref: ImageRef, platform: string): Promise<ImageEvidence>;
}

interface ImageConfig {
  os?: string;
  architecture?: string;
  variant?: string;
  config?: { Entrypoint?: unknown; Cmd?: unknown };
  history?: { created_by?: unknown }[];
}

/** The `Bearer realm=…,service=…,scope=…` challenge's parameters; undefined for any other challenge. */
function bearerChallenge(h: string | null): Record<string, string> | undefined {
  const m = /^\s*Bearer\s+(.*)$/i.exec(h ?? "");
  if (!m) return undefined;
  const params: Record<string, string> = {};
  for (const p of m[1]!.matchAll(/([A-Za-z_]+)="([^"]*)"/g)) params[p[1]!.toLowerCase()] = p[2]!;
  return params.realm ? params : undefined;
}

export function registrySource(deps: { fetch?: typeof fetch } = {}): OciImageSource {
  const f = deps.fetch ?? fetch;
  return {
    async imageEvidence(ref, platform) {
      const [os, arch, variant] = platform.split("/");
      const base = `https://${ref.registry === "docker.io" ? "registry-1.docker.io" : ref.registry}/v2/${ref.repository}/`;
      const label = `${ref.repository}${DIGEST.test(ref.reference) ? "@" : ":"}${ref.reference}`;
      let token: string | undefined;
      const send = (path: string, accept: string[]) =>
        f(base + path, {
          headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), accept: accept.join(", "), "user-agent": "oupdate" },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      const get = async (path: string, accept: string[]) => {
        let r = await send(path, accept);
        const challenge = r.status === 401 && !token ? bearerChallenge(r.headers.get("www-authenticate")) : undefined;
        if (challenge) {
          const u = new URL(challenge.realm!);
          if (challenge.service) u.searchParams.set("service", challenge.service);
          if (challenge.scope) u.searchParams.set("scope", challenge.scope);
          const tr = await f(u, { headers: { "user-agent": "oupdate" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
          if (!tr.ok) throw new Error(`registry token HTTP ${tr.status}`);
          const t = (await tr.json()) as { token?: unknown; access_token?: unknown };
          const got = typeof t.token === "string" && t.token ? t.token : t.access_token;
          if (typeof got !== "string" || !got) throw new Error("registry token missing");
          token = got;
          r = await send(path, accept);
        }
        if (!r.ok) throw new Error(`registry HTTP ${r.status} for ${path}`);
        return { bytes: new Uint8Array(await r.arrayBuffer()), type: (r.headers.get("content-type") ?? "").split(";")[0]!.trim(), said: r.headers.get("docker-content-digest") ?? undefined };
      };

      const top = await get(`manifests/${ref.reference}`, [...INDEX_TYPES, ...MANIFEST_TYPES]);
      const topDigest = sha256Digest(top.bytes);
      if (DIGEST.test(ref.reference) && topDigest !== ref.reference) throw new Error(`${label}: the bytes served hash to ${topDigest}, which does not hash to ${ref.reference}`);
      if (top.said !== undefined && top.said !== topDigest) throw new Error(`${label} bytes hash to ${topDigest}, the registry says ${top.said}`);
      const doc = parseJson<IndexDoc & { manifests?: { platform?: { variant?: string } }[] }>(top.bytes, "manifest");
      const type = doc.mediaType ?? top.type;
      let man = top;
      let single = true;
      if (INDEX_TYPES.includes(type)) {
        single = false;
        const hits = (doc.manifests ?? []).filter((m) => m.platform?.os === os && m.platform?.architecture === arch && (!variant || m.platform?.variant === variant));
        if (hits.length !== 1) throw new Error(`${label} has ${hits.length} ${platform} images`);
        const md = hits[0]!.digest ?? "";
        if (!DIGEST.test(md)) throw new Error(`${platform} entry is not a sha256 digest`);
        man = await get(`manifests/${md}`, MANIFEST_TYPES);
        if (sha256Digest(man.bytes) !== md) throw new Error(`${platform} manifest does not hash to ${md}`);
      } else if (!MANIFEST_TYPES.includes(type)) throw new Error(`${label} is not an image manifest or index (${type || "no media type"})`);
      const digest = sha256Digest(man.bytes);
      const cd = parseJson<{ config?: { digest?: string } }>(man.bytes, `${platform} manifest`).config?.digest ?? "";
      if (!DIGEST.test(cd)) throw new Error(`${platform} config is not a sha256 digest`);
      const blob = await get(`blobs/${cd}`, CONFIG_TYPES);
      if (sha256Digest(blob.bytes) !== cd) throw new Error(`${platform} config does not hash to ${cd}`);
      const cfg = parseJson<ImageConfig>(blob.bytes, `${platform} config`);
      if (single && (cfg.os !== os || cfg.architecture !== arch || (variant && cfg.variant !== variant)))
        throw new Error(`${label} is ${[cfg.os, cfg.architecture, cfg.variant].filter(Boolean).join("/")}, not ${platform}`);
      const argv = (field: "Entrypoint" | "Cmd") => {
        const v = jsonArgv(JSON.stringify(cfg.config?.[field] ?? null));
        if (v === undefined) throw new Error(`${label}: ${field} is not null or a string array`);
        return v;
      };
      return {
        digest,
        config: cd,
        entrypoint: argv("Entrypoint"),
        cmd: argv("Cmd"),
        // docker history order: newest first; an entry with no created_by prints as an empty line.
        history: (cfg.history ?? []).map((h) => (typeof h.created_by === "string" ? h.created_by : "")).reverse(),
      };
    },
  };
}
