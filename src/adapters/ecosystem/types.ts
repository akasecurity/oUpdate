/** One installable file of a release, with the digest the registry publishes for it. */
export interface ArtifactFile {
  url: string;
  filename: string;
  packagetype: "bdist_wheel" | "sdist";
  sha256?: string;
}

export interface Registry {
  latest(name: string): Promise<string | undefined>;
  publishedAt(name: string, version: string): Promise<Date | undefined>;
  artifactUrls(name: string, version: string): Promise<string[]>;
  /** Every wheel and sdist of a release (PyPI), so a review can read each one an installer might pick. */
  artifactFiles?(name: string, version: string): Promise<ArtifactFile[]>;
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
