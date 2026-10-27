// bun.lock (text lockfile, JSON with trailing commas) -> registry packages.
// Workspace entries are skipped (the repo's own packages). Git, github, file,
// link and tarball URL entries are read as direct dependencies, the spec as
// their source: they have no registry version to check. A registry entry's second field names its registry (empty is
// the default); a tarball there that is not that registry's tarball of name@version is a url dependency, as in
// package-lock.json. Every hash of the integrity is checked on the download; one the gate cannot check throws.

import { sriHashes } from "../targets/pins/npm.ts";
import { directKind, npmCanonicalTarball, npmPrivateRegistry, type LockedPackage } from "./types.ts";

/**
 * Whether a bun.lock registry field is a registry the review reads name@version from: the registry's own tarball of
 * it, a private registry's base, or the public registry's root. A tarball or any other path is not.
 */
function registryField(url: string, name: string, version: string): boolean {
  if (npmCanonicalTarball(url, name, version)) return true;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (!/^https?:$/.test(u.protocol) || u.search || u.hash || u.username || u.password || /\.(tgz|tar|tar\.gz)$/i.test(u.pathname)) return false;
  return npmPrivateRegistry(url) !== undefined || u.pathname === "/";
}

export function stripTrailingCommas(text: string): string {
  // Commas before a closing bracket, outside strings.
  let out = "";
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inStr) {
      out += c;
      if (c === "\\") out += text[++i] ?? "";
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      continue;
    }
    if (c === ",") {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j]!)) j++;
      if (text[j] === "}" || text[j] === "]") continue;
    }
    out += c;
  }
  return out;
}

export function parseBunLock(text: string): LockedPackage[] {
  const lock = JSON.parse(stripTrailingCommas(text)) as { packages?: Record<string, unknown[]> };
  const seen = new Set<string>();
  const out: LockedPackage[] = [];
  for (const entry of Object.values(lock.packages ?? {})) {
    const spec = entry[0];
    if (typeof spec !== "string") continue;
    const at = spec.lastIndexOf("@");
    if (at <= 0) continue;
    const name = spec.slice(0, at);
    const version = spec.slice(at + 1);
    if (!/^\d+\.\d+\.\d+/.test(version)) {
      // workspace:, github:, git+..., file:, link:, a tarball URL. The name ends at the first @ past a scope.
      const cut = spec.indexOf("@", 1);
      const source = spec.slice(cut + 1);
      if (cut <= 0 || source.startsWith("workspace:")) continue;
      const k = `${spec.slice(0, cut)}@${source}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ name: spec.slice(0, cut), version: source, source, direct: directKind(source.replace(/^link:/, "file:")) });
      continue;
    }
    // A registry entry is [spec, registry, info, integrity].
    const p: LockedPackage = { name, version };
    if (entry[3] !== undefined && entry[3] !== "") {
      try {
        if (typeof entry[3] !== "string") throw new Error("integrity is not text");
        p.integrity = sriHashes(entry[3]).map((h) => h.sri).join(" ");
      } catch (err) {
        throw new Error(`cannot read ${spec}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (typeof entry[1] === "string" && entry[1] && !registryField(entry[1], name, version)) p.direct = "url";
    const registry = p.direct ? undefined : npmPrivateRegistry(entry[1]);
    if (registry) p.registry = registry;
    if (typeof entry[1] === "string" && entry[1]) p.source = entry[1];
    if (typeof entry[3] === "string") p.digest = entry[3];
    const key = `${name}@${version} ${p.source ?? ""} ${p.digest ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}
