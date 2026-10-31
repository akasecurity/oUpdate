// Two lockfile package lists -> the package versions a change brings in. Each
// new version pairs with the old version it most likely replaced: one the
// change removed if there is one, else the highest old version of that name.

import type { DirectKind, LockedFile, LockedPackage } from "./lockfile/types.ts";

export interface LockChange {
  name: string;
  from: string | null; // null: a package the old lockfile did not have
  to: string;
  /** SRI of the old / new tarball, from the lockfiles, when they record one (every hash in it is checked). */
  fromIntegrity?: string;
  toIntegrity?: string;
  /** The files the new version's lockfile entry pins (uv.lock), each of which the review must match to the registry's. */
  toArtifacts?: LockedFile[];
  /** Host of the non-default registry the new version comes from, if it does. */
  registry?: string;
  /** Set when the version is the same but its source or hashes in the lockfile changed: what they were and are. */
  swapped?: { from: string; to: string };
  /** Set when the lockfile records neither a source nor a hash for the new version. */
  unhashed?: boolean;
  /** Set when the new version comes from no registry (git, url, file); `source` says where. */
  direct?: DirectKind;
  source?: string;
}

function cmp(a: string, b: string): number {
  const pa = a.split(/[.+-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
  const pb = b.split(/[.+-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i], y = pb[i];
    if (x === y) continue;
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (typeof x === "number" && typeof y === "number") return x - y;
    return String(x) < String(y) ? -1 : 1;
  }
  return 0;
}

const mask = (s: string) => s.replace(/\/\/[^/@\s]*@/, "//");

/** Source (without any user:password in a URL) and hashes of a locked package, as one string to show. Never compared. */
const where = (p: LockedPackage) => [p.source && mask(p.source), p.digest].filter(Boolean).join(" ");

/** What the install fetches, compared as separate fields and with any credentials in the URL kept. */
const origin = (p: LockedPackage) => JSON.stringify([p.source ?? null, p.digest ?? null]);

export function diffLocks(oldPkgs: LockedPackage[], newPkgs: LockedPackage[]): LockChange[] {
  const key = (p: LockedPackage) => `${p.name}@${p.version}`;
  const full = (p: LockedPackage) => JSON.stringify([key(p), origin(p)]);
  const oldKeys = new Set(oldPkgs.map(key));
  const oldFull = new Set(oldPkgs.map(full));
  const newKeys = new Set(newPkgs.map(key));
  const out: LockChange[] = [];
  for (const p of newPkgs) {
    if (oldFull.has(full(p))) continue;
    if (oldKeys.has(key(p))) {
      // The same version from somewhere else, or with other bytes: name@version alone would call this unchanged.
      const was = oldPkgs.find((o) => key(o) === key(p))!;
      const c: LockChange = { name: p.name, from: p.version, to: p.version, swapped: { from: where(was), to: where(p) } };
      // Same shown text: say why they differ without showing credentials.
      if (c.swapped!.from === c.swapped!.to) c.swapped!.to += " (differs only in URL credentials or field boundaries)";
      if (was.integrity) c.fromIntegrity = was.integrity;
      if (p.integrity) c.toIntegrity = p.integrity;
      if (p.artifacts) c.toArtifacts = p.artifacts;
      if (p.registry) c.registry = p.registry;
      if (p.unhashed) c.unhashed = true;
      if (p.direct) Object.assign(c, { direct: p.direct, source: p.source });
      out.push(c);
      continue;
    }
    const olds = oldPkgs.filter((o) => o.name === p.name).map((o) => o.version);
    const removed = olds.filter((v) => !newKeys.has(`${p.name}@${v}`));
    const pool = (removed.length ? removed : olds).sort(cmp);
    const from = pool.at(-1) ?? null;
    const c: LockChange = { name: p.name, from, to: p.version };
    const fromIntegrity = from === null ? undefined : oldPkgs.find((o) => o.name === p.name && o.version === from)?.integrity;
    if (fromIntegrity) c.fromIntegrity = fromIntegrity;
    if (p.integrity) c.toIntegrity = p.integrity;
    if (p.artifacts) c.toArtifacts = p.artifacts;
    if (p.registry) c.registry = p.registry;
    if (p.unhashed) c.unhashed = true;
    if (p.direct) Object.assign(c, { direct: p.direct, source: p.source });
    out.push(c);
  }
  return out;
}
