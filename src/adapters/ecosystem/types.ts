import { timed } from "../http.ts";
import type { VersionPublisher } from "../../publisher-signals.ts";

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
  /** Who published a release and how, where the registry's metadata says (npm); undefined for an unknown version. */
  publisher?(name: string, version: string): Promise<VersionPublisher | undefined>;
}

export interface RegistryDeps {
  fetch?: typeof fetch;
  base?: string;
  /** Limit for one request in milliseconds; the default is HTTP_TIMEOUT_MS. */
  timeoutMs?: number;
}

export async function getJson(f: typeof fetch, url: string, timeoutMs?: number): Promise<unknown | undefined> {
  return timed(url, async (init) => {
    const r = await f(url, { headers: { accept: "application/json" }, ...init });
    if (r.status === 404) { await r.body?.cancel().catch(() => {}); return undefined; }
    if (!r.ok) { await r.body?.cancel().catch(() => {}); throw new Error(`registry ${r.status} for ${url}`); }
    return r.json();
  }, timeoutMs);
}
