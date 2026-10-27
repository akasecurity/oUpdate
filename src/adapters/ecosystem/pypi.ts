import { getJson, type ArtifactFile, type Registry, type RegistryDeps } from "./types.ts";

interface Release {
  urls?: { packagetype?: string; url?: string; filename?: string; digests?: { sha256?: string }; upload_time_iso_8601?: string }[];
}

export function pypiRegistry(deps: RegistryDeps = {}): Registry {
  const f = deps.fetch ?? fetch;
  const base = deps.base ?? "https://pypi.org/pypi";
  const release = (name: string, version: string) => getJson(f, `${base}/${name}/${version}/json`) as Promise<Release | undefined>;
  return {
    async latest(name) {
      const d = (await getJson(f, `${base}/${name}/json`)) as { info?: { version?: string } } | undefined;
      return d?.info?.version;
    },
    async publishedAt(name, version) {
      const times = ((await release(name, version))?.urls ?? []).map((u) => u.upload_time_iso_8601).filter((t): t is string => !!t);
      if (times.length === 0) return undefined;
      return new Date(Math.min(...times.map((t) => Date.parse(t))));
    },
    async artifactUrls(name, version) {
      const urls = (await release(name, version))?.urls ?? [];
      const rank = (t?: string) => (t === "bdist_wheel" ? 0 : t === "sdist" ? 1 : 2);
      return urls
        .filter((u) => u.url)
        .sort((a, b) => rank(a.packagetype) - rank(b.packagetype))
        .map((u) => u.url!);
    },
    async artifactFiles(name, version) {
      const out: ArtifactFile[] = [];
      for (const u of (await release(name, version))?.urls ?? []) {
        // Eggs and other legacy types are not installed by pip or uv.
        if (!u.url || (u.packagetype !== "bdist_wheel" && u.packagetype !== "sdist")) continue;
        out.push({ url: u.url, filename: u.filename ?? u.url.split("/").pop()!, packagetype: u.packagetype, sha256: u.digests?.sha256 });
      }
      return out;
    },
  };
}
