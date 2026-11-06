import { getJson, type Registry, type RegistryDeps } from "./types.ts";

interface Packument {
  "dist-tags"?: { latest?: string };
  time?: Record<string, string>;
  versions?: Record<string, { dist?: { tarball?: string; attestations?: { provenance?: unknown }; signatures?: unknown[] }; _npmUser?: { name?: string; trustedPublisher?: unknown }; maintainers?: { name?: string }[] }>;
}

export function npmRegistry(deps: RegistryDeps = {}): Registry {
  const f = deps.fetch ?? fetch;
  const base = deps.base ?? "https://registry.npmjs.org";
  const cache = new Map<string, Promise<Packument | undefined>>();
  const doc = (name: string) => {
    let p = cache.get(name);
    if (!p) {
      p = getJson(f, `${base}/${name.replace("/", "%2f")}`, deps.timeoutMs) as Promise<Packument | undefined>;
      cache.set(name, p);
    }
    return p;
  };
  return {
    async latest(name) {
      return (await doc(name))?.["dist-tags"]?.latest;
    },
    async publishedAt(name, version) {
      const t = (await doc(name))?.time?.[version];
      return t ? new Date(t) : undefined;
    },
    async publisher(name, version) {
      const d = await doc(name);
      const v = d?.versions?.[version];
      if (!d || !v) return undefined;
      const at = (ver: string) => (d.time?.[ver] ? new Date(d.time[ver]!) : undefined);
      const publishedAt = at(version);
      let previousPublishedAt: Date | undefined;
      if (publishedAt) {
        for (const ver of Object.keys(d.versions ?? {})) {
          const t = ver === version ? undefined : at(ver);
          if (t && t < publishedAt && (!previousPublishedAt || t > previousPublishedAt)) previousPublishedAt = t;
        }
      }
      return {
        facts: {
          publishedAt,
          maintainers: (v.maintainers ?? []).map((m) => m.name).filter((n): n is string => !!n),
          publisher: v._npmUser?.name,
          provenance: !!v.dist?.attestations?.provenance,
          trusted: !!v._npmUser?.trustedPublisher,
          signed: Array.isArray(v.dist?.signatures) && v.dist.signatures.length > 0,
        },
        previousPublishedAt,
      };
    },
    async artifactUrls(name, version) {
      const t = (await doc(name))?.versions?.[version]?.dist?.tarball;
      return t ? [t] : [];
    },
  };
}

/**
 * dist.integrity of one published version (the registry's per-version document), or undefined when the
 * registry has no such version. The name goes in unencoded, as `npm view` and the build's own fetch use it.
 */
export async function npmIntegrity(name: string, version: string, deps: RegistryDeps = {}): Promise<string | undefined> {
  const f = deps.fetch ?? fetch;
  const base = deps.base ?? "https://registry.npmjs.org";
  const doc = (await getJson(f, `${base}/${name}/${encodeURIComponent(version)}`, deps.timeoutMs)) as { dist?: { integrity?: string } } | undefined;
  return doc?.dist?.integrity;
}
