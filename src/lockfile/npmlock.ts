// package-lock.json / npm-shrinkwrap.json (lockfileVersion 2 and 3) -> registry packages, from the `packages` map.
// Each key is a node_modules path; the package name is the entry's `name` (an npm: alias) or the last
// node_modules segment. Skipped: the root and workspace folders, links, git and file deps, and bundled copies
// (no tarball of their own). An entry with an integrity but no `resolved` is from the default registry.

import { npmPrivateRegistry, sha512Sri, type LockedPackage } from "./types.ts";

interface Entry {
  name?: string;
  version?: string;
  resolved?: string;
  integrity?: string;
  link?: boolean;
}

const NM = "node_modules/";

export function parseNpmLock(text: string): LockedPackage[] {
  const lock = JSON.parse(text) as { lockfileVersion?: number; packages?: Record<string, Entry> };
  if (!lock.packages || typeof lock.packages !== "object") {
    throw new Error(`lockfileVersion ${lock.lockfileVersion ?? "?"} has no packages map; regenerate it with npm 7 or later`);
  }
  const seen = new Set<string>();
  const out: LockedPackage[] = [];
  for (const [key, e] of Object.entries(lock.packages)) {
    const at = key.lastIndexOf(NM);
    if (at < 0 || e.link || typeof e.version !== "string" || !/^\d+\.\d+\.\d+/.test(e.version)) continue;
    let registry: string | undefined;
    if (typeof e.resolved === "string") {
      if (!/^https?:\/\//.test(e.resolved)) continue; // git+..., file:
      registry = npmPrivateRegistry(e.resolved);
    } else if (!e.integrity) continue; // bundled inside its parent's tarball
    const name = e.name ?? key.slice(at + NM.length);
    const k = `${name}@${e.version}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const p: LockedPackage = { name, version: e.version };
    const integrity = sha512Sri(e.integrity);
    if (integrity) p.integrity = integrity;
    if (registry) p.registry = registry;
    out.push(p);
  }
  return out;
}
