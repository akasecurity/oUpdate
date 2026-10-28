// pnpm-lock.yaml -> registry packages, from the `packages` keys:
//   v9: name@version   v6: /name@version(peer@x)   v5 and older: /name/version_peer@x+y
// Peer suffixes are stripped. Url, git and directory entries (no registry version) are read as direct
// dependencies with their tarball, repo or directory as the source. An importer's own `link:` or `file:` resolution
// is a direct file dependency, its path taken from the lockfile's folder, unless it links to another importer (a
// workspace package, not a package). A tarball resolution names its registry: a non-default host is a private registry.
// A tarball that is not that registry's tarball of name@version is a url dependency, as in package-lock.json, and
// every hash of the integrity is checked on the download; one the gate cannot check throws, holding the PR.

import { posix } from "node:path";
import { sriHashes } from "../targets/pins/npm.ts";
import { directKind, npmCanonicalTarball, npmPrivateRegistry, type LockedPackage } from "./types.ts";

interface Entry {
  name?: string;
  version?: string;
  resolution?: { integrity?: string; tarball?: string; type?: string; repo?: string; commit?: string; directory?: string };
}

/** A url, git or directory entry: its name (the entry's, else the key's up to the first @ past a scope) and source. */
function directEntry(key: string, e: Entry): LockedPackage | undefined {
  const res = e.resolution ?? {};
  const k = key.replace(/^\//, "");
  const cut = k.indexOf("@", 1);
  const name = e.name ?? (cut > 0 ? k.slice(0, cut) : k);
  const source = res.type === "git" ? `git+${res.repo ?? ""}#${res.commit ?? ""}` : res.type === "directory" ? `file:${res.directory ?? ""}` : (res.tarball ?? (cut > 0 ? k.slice(cut + 1) : k));
  if (!name) return undefined;
  const p: LockedPackage = { name, version: e.version ?? source, source, direct: res.type === "git" ? "git" : directKind(source) };
  if (typeof res.integrity === "string") p.digest = res.integrity;
  return p;
}

function keyId(key: string, v: number): { name: string; version: string } | undefined {
  const k = key.replace(/^\//, "").replace(/\(.*$/, "");
  const cut = v >= 6 ? k.lastIndexOf("@") : k.lastIndexOf("/");
  if (cut <= 0) return undefined;
  return { name: k.slice(0, cut), version: v >= 6 ? k.slice(cut + 1) : k.slice(cut + 1).replace(/_.*$/, "") };
}

const IMPORTER_FIELDS = ["dependencies", "devDependencies", "optionalDependencies"];

/**
 * The importers' (the project's own folders') `link:` and `file:` resolutions, as direct file dependencies with the
 * path from the lockfile's folder. A single-project lockfile keeps them at the top level. v6 and later write
 * `{ specifier, version }`, v5 the version alone. A link to another importer is a workspace package and skipped.
 */
function importerLocals(lock: Record<string, unknown>): LockedPackage[] {
  const rec = (o: unknown) => (o && typeof o === "object" ? (o as Record<string, unknown>) : {});
  const importers = lock.importers === undefined ? { ".": lock } : rec(lock.importers);
  const folders = new Set(Object.keys(importers).map((k) => posix.normalize(k)));
  const out: LockedPackage[] = [];
  for (const [at, imp] of Object.entries(importers)) {
    for (const field of IMPORTER_FIELDS) {
      for (const [name, dep] of Object.entries(rec(rec(imp)[field]))) {
        const resolved = typeof dep === "string" ? dep : rec(dep).version;
        const m = typeof resolved === "string" ? /^(link|file):(.*)$/.exec(resolved) : null;
        if (!m) continue;
        const path = posix.normalize(posix.join(at, m[2]!));
        if (m[1] === "link" && folders.has(path)) continue;
        const source = `${m[1]}:${path}`;
        out.push({ name, version: source, source, direct: "file" });
      }
    }
  }
  return out;
}

export function parsePnpmLock(text: string): LockedPackage[] {
  const lock = Bun.YAML.parse(text) as { lockfileVersion?: string | number; packages?: Record<string, Entry> };
  const v = Number.parseFloat(String(lock.lockfileVersion ?? ""));
  if (!Number.isFinite(v)) throw new Error("pnpm-lock.yaml has no lockfileVersion");
  const seen = new Set<string>();
  const out: LockedPackage[] = [];
  for (const d of importerLocals(lock as Record<string, unknown>)) {
    const k = `${d.name}@${d.version} ${d.source}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(d);
  }
  for (const [key, e] of Object.entries(lock.packages ?? {})) {
    const id = keyId(key, v);
    const res = e?.resolution ?? {};
    if (!id || !/^\d+\.\d+\.\d+/.test(id.version) || res.type || (res.tarball !== undefined && !/^https?:\/\//.test(res.tarball))) {
      // url, git, file: specs and git or directory resolutions
      const d = directEntry(key, e ?? {});
      const k = d && `${d.name}@${d.version} ${d.source}`;
      if (!d || seen.has(k!)) continue;
      seen.add(k!);
      out.push(d);
      continue;
    }
    let registry: string | undefined;
    let direct: LockedPackage["direct"];
    if (res.tarball !== undefined) {
      // Another package's or version's tarball: the install fetches it, a review of name@version would not read it.
      if (!npmCanonicalTarball(res.tarball, id.name, id.version)) direct = "url";
      else registry = npmPrivateRegistry(res.tarball);
    }
    const p: LockedPackage = { ...id };
    // No tarball and no integrity: nothing says what the install fetches or checks. The gate holds it for a person.
    if (res.tarball === undefined && !res.integrity) p.unhashed = true;
    if (direct) p.direct = direct;
    if (res.integrity !== undefined) {
      try {
        if (typeof res.integrity !== "string") throw new Error("integrity is not text");
        p.integrity = sriHashes(res.integrity).map((h) => h.sri).join(" ");
      } catch (err) {
        throw new Error(`cannot read ${key}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (registry) p.registry = registry;
    if (typeof res.tarball === "string") p.source = res.tarball;
    if (typeof res.integrity === "string") p.digest = res.integrity;
    const k = `${id.name}@${id.version} ${p.source ?? ""} ${p.digest ?? ""}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(p);
  }
  return out;
}
