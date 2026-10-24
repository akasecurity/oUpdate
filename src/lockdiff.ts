// Two lockfile package lists -> the package versions a change brings in. Each
// new version pairs with the old version it most likely replaced: one the
// change removed if there is one, else the highest old version of that name.

import type { LockedPackage } from "./adapters/ecosystem/bunlock.ts";

export interface LockChange {
  name: string;
  from: string | null; // null: a package the old lockfile did not have
  to: string;
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

export function diffLocks(oldPkgs: LockedPackage[], newPkgs: LockedPackage[]): LockChange[] {
  const key = (p: LockedPackage) => `${p.name}@${p.version}`;
  const oldKeys = new Set(oldPkgs.map(key));
  const newKeys = new Set(newPkgs.map(key));
  const out: LockChange[] = [];
  for (const p of newPkgs) {
    if (oldKeys.has(key(p))) continue;
    const olds = oldPkgs.filter((o) => o.name === p.name).map((o) => o.version);
    const removed = olds.filter((v) => !newKeys.has(`${p.name}@${v}`));
    const pool = (removed.length ? removed : olds).sort(cmp);
    out.push({ name: p.name, from: pool.at(-1) ?? null, to: p.version });
  }
  return out;
}
