import { getJson, type Registry, type RegistryDeps } from "./types.ts";

interface Packument {
  "dist-tags"?: { latest?: string };
  time?: Record<string, string>;
  versions?: Record<string, { dist?: { tarball?: string } }>;
}

export function npmRegistry(deps: RegistryDeps = {}): Registry {
  const f = deps.fetch ?? fetch;
  const base = deps.base ?? "https://registry.npmjs.org";
  const cache = new Map<string, Promise<Packument | undefined>>();
  const doc = (name: string) => {
    let p = cache.get(name);
    if (!p) {
      p = getJson(f, `${base}/${name.replace("/", "%2f")}`) as Promise<Packument | undefined>;
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
    async artifactUrls(name, version) {
      const t = (await doc(name))?.versions?.[version]?.dist?.tarball;
      return t ? [t] : [];
    },
  };
}
