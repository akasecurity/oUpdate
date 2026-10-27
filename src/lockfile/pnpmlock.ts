// pnpm-lock.yaml -> registry packages, from the `packages` keys:
//   v9: name@version   v6: /name@version(peer@x)   v5 and older: /name/version_peer@x+y
// Peer suffixes are stripped. Skipped: url, git and directory entries (no registry version) and workspace links
// (only in importers). A tarball resolution names its registry: a non-default host is a private registry.

import { npmPrivateRegistry, sha512Sri, type LockedPackage } from "./types.ts";

interface Entry {
  resolution?: { integrity?: string; tarball?: string; type?: string };
}

function keyId(key: string, v: number): { name: string; version: string } | undefined {
  const k = key.replace(/^\//, "").replace(/\(.*$/, "");
  const cut = v >= 6 ? k.lastIndexOf("@") : k.lastIndexOf("/");
  if (cut <= 0) return undefined;
  return { name: k.slice(0, cut), version: v >= 6 ? k.slice(cut + 1) : k.slice(cut + 1).replace(/_.*$/, "") };
}

export function parsePnpmLock(text: string): LockedPackage[] {
  const lock = Bun.YAML.parse(text) as { lockfileVersion?: string | number; packages?: Record<string, Entry> };
  const v = Number.parseFloat(String(lock.lockfileVersion ?? ""));
  if (!Number.isFinite(v)) throw new Error("pnpm-lock.yaml has no lockfileVersion");
  const seen = new Set<string>();
  const out: LockedPackage[] = [];
  for (const [key, e] of Object.entries(lock.packages ?? {})) {
    const id = keyId(key, v);
    if (!id || !/^\d+\.\d+\.\d+/.test(id.version)) continue; // url, git, file: and link: specs
    const res = e?.resolution ?? {};
    if (res.type) continue; // git, directory
    let registry: string | undefined;
    if (res.tarball !== undefined) {
      if (!/^https?:\/\//.test(res.tarball)) continue;
      registry = npmPrivateRegistry(res.tarball);
    } else if (!res.integrity) continue;
    const k = `${id.name}@${id.version}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const p: LockedPackage = { ...id };
    const integrity = sha512Sri(res.integrity);
    if (integrity) p.integrity = integrity;
    if (registry) p.registry = registry;
    out.push(p);
  }
  return out;
}
