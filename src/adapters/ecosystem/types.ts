export interface Registry {
  latest(name: string): Promise<string | undefined>;
  publishedAt(name: string, version: string): Promise<Date | undefined>;
  artifactUrls(name: string, version: string): Promise<string[]>;
}

export interface RegistryDeps {
  fetch?: typeof fetch;
  base?: string;
}

export async function getJson(f: typeof fetch, url: string): Promise<unknown | undefined> {
  const r = await f(url, { headers: { accept: "application/json" } });
  if (r.status === 404) return undefined;
  if (!r.ok) throw new Error(`registry ${r.status} for ${url}`);
  return r.json();
}
