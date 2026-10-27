// Python lockfiles -> registry packages. uv.lock: TOML `[[package]]` tables with name, version and source; only
// `source.registry` entries come from an index (editable, virtual, git, directory, path and url sources are
// skipped). poetry.lock: the same tables; no source is PyPI, git, directory, file and url sources are skipped.
// Names are PEP 503-normalized, so a diff pairs a version across a change in spelling.
// The sha256 hashes these lockfiles carry are not passed on: the download check verifies sha512 only, and a
// lockfile lists one hash per wheel while the review downloads one file.

import type { LockedPackage } from "./types.ts";

/** PEP 503 normalized name: lowercase, each run of -, _ and . folded to one -. */
export function pep503(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, "-");
}

/** A PEP 440 version as lockfiles write it (optional epoch, release digits, any pre/post/dev/local tail). */
const PY_VERSION = /^(\d+!)?\d+(\.\d+)*[A-Za-z0-9.+_-]*$/;

/** Hosts that serve the public PyPI index and its files. */
const PYPI_DEFAULT_HOSTS = new Set(["pypi.org", "pypi.python.org", "files.pythonhosted.org"]);

/** The host of a Python index URL when it is not PyPI; undefined for PyPI or no URL. */
export function pypiPrivateIndex(url: unknown): string | undefined {
  if (typeof url !== "string" || !url) return undefined;
  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    return url;
  }
  return PYPI_DEFAULT_HOSTS.has(host) ? undefined : host;
}

/** Collects packages once per name@version, with PEP 503 names; a version that is not PEP 440 is dropped. */
export function collector() {
  const seen = new Set<string>();
  const out: LockedPackage[] = [];
  return {
    out,
    add(rawName: unknown, version: unknown, registry?: string) {
      if (typeof rawName !== "string" || typeof version !== "string" || !PY_VERSION.test(version)) return;
      const name = pep503(rawName);
      const k = `${name}@${version}`;
      if (seen.has(k)) return;
      seen.add(k);
      const p: LockedPackage = { name, version };
      if (registry) p.registry = registry;
      out.push(p);
    },
  };
}

interface UvPackage {
  name?: unknown;
  version?: unknown;
  source?: { registry?: unknown };
}

export function parseUvLock(text: string): LockedPackage[] {
  const lock = Bun.TOML.parse(text) as { package?: UvPackage[] };
  const c = collector();
  for (const p of lock.package ?? []) {
    const reg = p.source?.registry;
    if (typeof reg !== "string") continue; // editable, virtual, git, directory, path, url
    c.add(p.name, p.version, pypiPrivateIndex(reg));
  }
  return c.out;
}

interface PoetryPackage {
  name?: unknown;
  version?: unknown;
  source?: { type?: unknown; url?: unknown };
}

/** Poetry source types that are not a package index. */
const POETRY_NON_INDEX = new Set(["git", "directory", "file", "url"]);

/** poetry.lock: the same `[[package]]` shape. No source table is PyPI; a `legacy` source is a custom index. */
export function parsePoetryLock(text: string): LockedPackage[] {
  const lock = Bun.TOML.parse(text) as { package?: PoetryPackage[] };
  const c = collector();
  for (const p of lock.package ?? []) {
    const type = p.source?.type;
    if (typeof type === "string" && POETRY_NON_INDEX.has(type)) continue;
    c.add(p.name, p.version, pypiPrivateIndex(p.source?.url));
  }
  return c.out;
}
