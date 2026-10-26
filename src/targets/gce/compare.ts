// The caller's own post-check (spec §5 caller rules; CRB-b129 §2.3): the full installed set after the job against the
// one the review read bound. Every change must be an approved package moving to its reviewed version. Anything else is
// an unapproved change: a dependency upgraded or added, a removal, a downgrade, an approved package at another version,
// another instance or another OS. An approved package still at its old version did not install. This is detection,
// not prevention.

import { pkgKey, type Inventory } from "./answer.ts";

export interface InventoryDiff {
  /** name:arch keys now at their reviewed version. */
  patched: string[];
  notInstalled: string[];
  unapproved: string[];
}

const osLine = (i: Inventory) => `${i.os.shortName} ${i.os.version} ${i.os.architecture}`;

/** `reviewed` maps each approved name:arch to its reviewed candidate version. */
export function compareInventory(before: Inventory, after: Inventory, reviewed: ReadonlyMap<string, string>): InventoryDiff {
  const out: InventoryDiff = { patched: [], notInstalled: [], unapproved: [] };
  if (after.instanceId !== before.instanceId) out.unapproved.push(`instance id ${before.instanceId} -> ${after.instanceId}`);
  if (osLine(after) !== osLine(before)) out.unapproved.push(`os ${osLine(before)} -> ${osLine(after)}`);
  const was = new Map(before.installed.map((p) => [pkgKey(p), p.version]));
  const now = new Map(after.installed.map((p) => [pkgKey(p), p.version]));
  for (const key of [...new Set([...was.keys(), ...now.keys(), ...reviewed.keys()])].sort()) {
    const a = was.get(key);
    const b = now.get(key);
    const want = reviewed.get(key);
    if (want !== undefined) {
      if (b === want) out.patched.push(key);
      else if (a !== undefined && b === a) out.notInstalled.push(`${key} still ${a} (reviewed ${want})`);
      else out.unapproved.push(`${key} ${a ?? "absent"} -> ${b ?? "removed"} (reviewed ${want})`);
    } else if (a !== b) out.unapproved.push(a === undefined ? `${key} added at ${b}` : b === undefined ? `${key} removed (was ${a})` : `${key} ${a} -> ${b}`);
  }
  return out;
}
