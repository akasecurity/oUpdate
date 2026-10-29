// Python lockfiles -> registry packages. uv.lock: TOML `[[package]]` tables with name, version and source; only
// `source.registry` entries come from an index. Editable and virtual sources (the project's own packages) are
// skipped; git, url, path and directory sources are read as direct dependencies with that source. poetry.lock:
// the same tables; no source is PyPI, and git, directory, file and url sources are direct dependencies.
// Names are PEP 503-normalized, so a diff pairs a version across a change in spelling.
// The sha256 hashes these lockfiles carry are kept, with the index, as the package's source and digest, so a diff
// sees a pinned version whose files changed. uv.lock also names each file's URL, and poetry.lock each file's name: those are carried as the package's
// artifacts, for the review to match each hash against the files PyPI lists for that version. A PyPI package with a
// file off PyPI's file host is a url dependency: the install fetches that file, which no review of PyPI reads.

import type { DirectKind, LockedFile, LockedPackage } from "./types.ts";

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

/** The hashes a lockfile lists for a package, sorted and joined; undefined when it lists none. */
export function digestOf(hashes: unknown[]): string | undefined {
  const hs = hashes.filter((h): h is string => typeof h === "string" && h !== "").sort();
  return hs.length ? hs.join(" ") : undefined;
}

/** Collects packages once per name@version and source, with PEP 503 names; a version that is not PEP 440 is dropped. */
export function collector() {
  const seen = new Set<string>();
  const out: LockedPackage[] = [];
  return {
    out,
    add(rawName: unknown, version: unknown, registry?: string, where: { source?: string; digest?: string; artifacts?: LockedFile[] } = {}) {
      if (typeof rawName !== "string" || typeof version !== "string" || !PY_VERSION.test(version)) return;
      const name = pep503(rawName);
      const k = `${name}@${version} ${where.source ?? ""} ${where.digest ?? ""}`;
      if (seen.has(k)) return;
      seen.add(k);
      const p: LockedPackage = { name, version };
      if (registry) p.registry = registry;
      if (where.source) p.source = where.source;
      if (where.digest) p.digest = where.digest;
      if (where.artifacts?.length) p.artifacts = where.artifacts;
      out.push(p);
    },
    /** A dependency from no index (git, url, file), named by its source; its version is whatever the lockfile says. */
    direct(rawName: unknown, version: unknown, kind: DirectKind, source: string) {
      const name = typeof rawName === "string" && rawName ? pep503(rawName) : source;
      const v = typeof version === "string" && version ? version : source;
      const k = `${name}@${v} ${source}`;
      if (seen.has(k)) return;
      seen.add(k);
      out.push({ name, version: v, source, direct: kind });
    },
  };
}

interface PyFile {
  file?: unknown;
  hash?: unknown;
  url?: unknown;
}

/** Whether a URL is a file on PyPI's file host: https, no credentials, query or fragment. */
function onPypiFiles(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.host === "files.pythonhosted.org" && !u.username && !u.password && !u.search && !u.hash;
  } catch {
    return false;
  }
}

interface UvPackage {
  name?: unknown;
  version?: unknown;
  source?: { registry?: unknown; git?: unknown; url?: unknown; path?: unknown; directory?: unknown };
  sdist?: PyFile;
  wheels?: PyFile[];
}

export function parseUvLock(text: string): LockedPackage[] {
  const lock = Bun.TOML.parse(text) as { package?: UvPackage[] };
  const c = collector();
  for (const p of lock.package ?? []) {
    const src = p.source ?? {};
    const reg = src.registry;
    if (typeof reg !== "string") {
      // editable and virtual are the project's own packages; git, url, path and directory come from no index
      if (typeof src.git === "string") c.direct(p.name, p.version, "git", `git+${src.git}`);
      else if (typeof src.url === "string") c.direct(p.name, p.version, "url", src.url);
      else if (typeof src.path === "string") c.direct(p.name, p.version, "file", `file:${src.path}`);
      else if (typeof src.directory === "string") c.direct(p.name, p.version, "file", `file:${src.directory}`);
      continue;
    }
    const files = [p.sdist, ...(p.wheels ?? [])].filter((f): f is PyFile => !!f && typeof f === "object");
    const artifacts = files.map((f) => ({ ...(typeof f.url === "string" ? { url: f.url } : {}), ...(typeof f.hash === "string" ? { hash: f.hash } : {}) }));
    const registry = pypiPrivateIndex(reg);
    const off = registry ? undefined : artifacts.find((f) => f.url !== undefined && !onPypiFiles(f.url));
    if (off) c.direct(p.name, p.version, "url", off.url!);
    else c.add(p.name, p.version, registry, { source: reg, digest: digestOf(files.map((f) => f.hash)), artifacts });
  }
  return c.out;
}

interface PoetryPackage {
  name?: unknown;
  version?: unknown;
  source?: { type?: unknown; url?: unknown; resolved_reference?: unknown; reference?: unknown };
  files?: PyFile[];
}

/** Poetry source types that are not a package index. */
const POETRY_NON_INDEX = new Set(["git", "directory", "file", "url"]);

/** poetry.lock: the same `[[package]]` shape. No source table is PyPI; a `legacy` source is a custom index. */
export function parsePoetryLock(text: string): LockedPackage[] {
  // Lock format 2 lists each package's files in the table; format 1 lists them under [metadata.files], by name.
  const lock = Bun.TOML.parse(text) as { package?: PoetryPackage[]; metadata?: { files?: Record<string, PyFile[]> } };
  const c = collector();
  for (const p of lock.package ?? []) {
    const type = p.source?.type;
    if (typeof type === "string" && POETRY_NON_INDEX.has(type)) {
      const url = String(p.source?.url ?? "");
      if (type === "git") c.direct(p.name, p.version, "git", `git+${url}#${String(p.source?.resolved_reference ?? p.source?.reference ?? "")}`);
      else if (type === "url") c.direct(p.name, p.version, "url", url);
      else c.direct(p.name, p.version, "file", `file:${url}`);
      continue;
    }
    const files = p.files ?? (typeof p.name === "string" ? lock.metadata?.files?.[p.name] : undefined) ?? [];
    const url = typeof p.source?.url === "string" ? p.source.url : undefined;
    const registry = pypiPrivateIndex(url);
    // From PyPI, each file is carried for the review to match its hash against PyPI's listing; a file with no hash holds.
    const artifacts = registry ? undefined : files.map((f) => ({ file: typeof f?.file === "string" ? f.file : "(unnamed file)", ...(typeof f?.hash === "string" ? { hash: f.hash } : {}) }));
    c.add(p.name, p.version, registry, { source: url, digest: digestOf(files.map((f) => f?.hash)), artifacts });
  }
  return c.out;
}
