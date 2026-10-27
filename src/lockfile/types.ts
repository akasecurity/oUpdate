// One registry package a lockfile pins.

import { SRI } from "../targets/pins/npm.ts";

export interface LockedPackage {
  name: string;
  version: string;
  /** sha512 SRI of the tarball the install fetches, when the lockfile records one. */
  integrity?: string;
  /** Host of the registry it comes from, set only when that is not the public default (a private registry). */
  registry?: string;
}

/**
 * The sha512 SRI in a lockfile's integrity field (npm may list several hashes, space-separated), or undefined.
 * Only sha512 is kept: the download check computes sha512, so an older sha1 entry would always mismatch.
 */
export function sha512Sri(field: unknown): string | undefined {
  if (typeof field !== "string") return undefined;
  return field.split(/\s+/).find((h) => SRI.test(h));
}

/** Hosts that serve the public npm registry. */
const NPM_DEFAULT_HOSTS = new Set(["registry.npmjs.org", "registry.npmjs.com", "registry.yarnpkg.com"]);

/** The host of an npm registry or tarball URL when it is not the public registry; undefined for the default or no URL. */
export function npmPrivateRegistry(url: unknown): string | undefined {
  if (typeof url !== "string" || !url) return undefined;
  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    return url;
  }
  return NPM_DEFAULT_HOSTS.has(host) ? undefined : host;
}
