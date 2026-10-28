// One registry package a lockfile pins.

export interface LockedPackage {
  name: string;
  version: string;
  /** SRI of the tarball the install fetches, when the lockfile records one: every hash it records. */
  integrity?: string;
  /** Host of the registry it comes from, set only when that is not the public default (a private registry). */
  registry?: string;
  /** Where the lockfile says the install fetches it from (a tarball URL, a registry URL), as written. */
  source?: string;
  /** Every hash the lockfile records for it, as written (all algorithms, all files): a swap changes it. */
  digest?: string;
  /** Each file the lockfile pins for it (uv.lock's sdist and wheels), with its URL and hash as written. */
  artifacts?: LockedFile[];
  /** Set for a registry package whose lockfile entry records neither where it is fetched from nor a hash: nothing says what the install checks. */
  unhashed?: boolean;
  /** Set for a dependency that comes from no registry: a git repo, a URL or a local file or folder (`source`). */
  direct?: DirectKind;
}

export type DirectKind = "git" | "url" | "file";

/** One file a lockfile pins for a package: where the install fetches it and the hash it checks. */
export interface LockedFile {
  url?: string;
  hash?: string;
}

/** What kind of non-registry source a lockfile spec or resolved value names. */
export function directKind(spec: string): DirectKind {
  if (/^(git\+|git:|github:|gitlab:|bitbucket:|ssh:)/.test(spec) || /\.git(#|\?|$)/.test(spec)) return "git";
  if (/^https?:/.test(spec)) return "url";
  return "file";
}

/**
 * Whether an npm tarball URL is the registry's own tarball for name@version: `<name>/-/<base>-<version>.tgz`, the
 * whole path on the public registry, the end of it on another (which may serve from a path prefix), with no query
 * or fragment. Any other URL is not the version a registry review reads.
 */
export function npmCanonicalTarball(url: string, name: string, version: string): boolean {
  let u: URL, path: string;
  try {
    u = new URL(url);
    path = decodeURIComponent(u.pathname);
  } catch {
    return false;
  }
  if (u.search || u.hash || u.username || u.password) return false;
  const want = `/${name}/-/${name.slice(name.lastIndexOf("/") + 1)}-${version}.tgz`;
  return NPM_DEFAULT_HOSTS.has(u.host) ? path === want : path.endsWith(want);
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
