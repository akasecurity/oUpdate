// package-lock.json / npm-shrinkwrap.json (lockfileVersion 2 and 3) -> registry packages, from the `packages` map.
// Each key is a node_modules path; the package name is the entry's `name` (an npm: alias) or the last
// node_modules segment. Skipped: the root and bundled copies (`inBundle` under a package's own node_modules, no
// tarball of their own). Git and file deps are read
// as direct dependencies with their `resolved` as the source; so are links (`link: true`, `resolved` the folder) and
// local folders outside node_modules (a workspace package, or `../x`), the key as the source: an install runs their
// code from the repo or the disk, which no registry review sees. An entry with a version but no `resolved` (with or
// without an integrity) is from the default registry, marked unhashed when it has no integrity either (the gate holds it); one with neither a resolved nor a version throws.

import { sriHashes } from "../targets/pins/npm.ts";
import { directKind, npmCanonicalTarball, npmPrivateRegistry, type LockedPackage } from "./types.ts";

interface Entry {
  name?: string;
  version?: string;
  resolved?: string;
  integrity?: string;
  link?: boolean;
  inBundle?: boolean;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

const NM = "node_modules/";

/** The node_modules key a dependency of the package at `key` resolves to: its own folder, then each parent's, up to the top. */
function resolveDep(packages: Record<string, Entry>, key: string, dep: string): string | undefined {
  let base = key;
  for (;;) {
    const cand = `${base ? `${base}/` : ""}${NM}${dep}`;
    if (Object.hasOwn(packages, cand)) return cand;
    if (!base) return undefined;
    const at = base.lastIndexOf(NM);
    base = at > 0 ? base.slice(0, at - 1) : "";
  }
}

/** Every `name@range` a dependent asks for lands on the entry it resolves to (the same range from two dependents once). */
function addDescriptors(packages: Record<string, Entry>, byKey: Map<string, LockedPackage>): void {
  const sets = new Map<LockedPackage, Set<string>>();
  for (const [key, e] of Object.entries(packages)) {
    // Dev dependencies are installed for the root and for workspace folders only (no node_modules in the path).
    const fields = key === "" || !key.includes(NM) ? [e.dependencies, e.optionalDependencies, e.peerDependencies, e.devDependencies] : [e.dependencies, e.optionalDependencies, e.peerDependencies];
    for (const deps of fields) {
      if (!deps || typeof deps !== "object") continue;
      for (const [name, range] of Object.entries(deps)) {
        const target = typeof range === "string" ? byKey.get(resolveDep(packages, key, name) ?? "") : undefined;
        if (!target) continue;
        const set = sets.get(target) ?? new Set<string>();
        set.add(`${name}@${range}`);
        sets.set(target, set);
      }
    }
  }
  for (const [p, set] of sets) p.descriptors = [...set].sort();
}

export function parseNpmLock(text: string): LockedPackage[] {
  const lock = JSON.parse(text) as { lockfileVersion?: number; packages?: Record<string, Entry> };
  if (!lock.packages || typeof lock.packages !== "object") {
    throw new Error(`lockfileVersion ${lock.lockfileVersion ?? "?"} has no packages map; regenerate it with npm 7 or later`);
  }
  const seen = new Set<string>();
  const out: LockedPackage[] = [];
  const byKey = new Map<string, LockedPackage>(); // lockfile key -> its entry, for the descriptors dependents record
  const byDedup = new Map<string, LockedPackage>();
  for (const [key, e] of Object.entries(lock.packages)) {
    const at = key.lastIndexOf(NM);
    // Only a bundled copy is skipped: it ships inside its parent's tarball, which is reviewed. That is an inBundle
    // entry in a registry package's own node_modules; the root's or a workspace's bundled dependencies (top-level
    // node_modules/x) are fetched from the registry, and so is one whose parent the lockfile does not list.
    if (key === "") continue;
    if (e.inBundle === true && at > 0) {
      const parent = lock.packages[key.slice(0, at - 1)];
      if (key.slice(0, at - 1).includes(NM) && parent && typeof parent === "object" && !parent.link) continue;
    }
    if (at < 0 || e.link) {
      const source = at < 0 ? key : typeof e.resolved === "string" && e.resolved ? e.resolved : key;
      const name = e.name ?? (at < 0 ? key : key.slice(at + NM.length));
      const version = at < 0 && typeof e.version === "string" ? e.version : source;
      const k = `${name}@${version} ${source}`;
      if (!seen.has(k)) {
        const p: LockedPackage = { name, version, source, direct: "file" };
        out.push(p);
        byDedup.set(k, p);
      }
      seen.add(k);
      byKey.set(key, byDedup.get(k)!);
      continue;
    }
    const name = e.name ?? key.slice(at + NM.length);
    const semver = typeof e.version === "string" && /^\d+\.\d+\.\d+/.test(e.version);
    let registry: string | undefined;
    let direct: LockedPackage["direct"];
    if (typeof e.resolved === "string") {
      // git+..., file:, a bare tarball URL, or a registry URL that is not that registry's tarball of name@version
      // (another package's, another version's): the install fetches it, a review of name@version would not read it.
      if (!/^https?:\/\//.test(e.resolved) || !semver || !npmCanonicalTarball(e.resolved, name, e.version as string)) direct = directKind(e.resolved);
      else registry = npmPrivateRegistry(e.resolved);
    } else if (!semver) throw new Error(`cannot read ${key}: no resolved and no registry version (${JSON.stringify(e.version ?? null)})`);
    const p: LockedPackage = { name, version: typeof e.version === "string" ? e.version : (e.resolved ?? "") };
    // No resolved and no integrity: nothing says what the install fetches or checks. The gate holds it for a person.
    if (typeof e.resolved !== "string" && e.integrity === undefined) p.unhashed = true;
    if (direct) p.direct = direct;
    // Every hash npm wrote (sha1 too) is checked on the download; one the gate cannot check throws, holding the PR.
    if (e.integrity !== undefined) {
      try {
        if (typeof e.integrity !== "string") throw new Error("integrity is not text");
        p.integrity = sriHashes(e.integrity).map((h) => h.sri).join(" ");
      } catch (err) {
        throw new Error(`cannot read ${key}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (registry) p.registry = registry;
    if (typeof e.resolved === "string") p.source = e.resolved;
    if (typeof e.integrity === "string") p.digest = e.integrity;
    // One entry per name@version and source: a nested copy of a kept version from elsewhere is its own entry.
    const k = `${name}@${e.version} ${p.source ?? ""} ${p.digest ?? ""}`;
    if (seen.has(k)) {
      byKey.set(key, byDedup.get(k)!);
      continue;
    }
    seen.add(k);
    out.push(p);
    byDedup.set(k, p);
    byKey.set(key, p);
  }
  addDescriptors(lock.packages, byKey);
  return out;
}
