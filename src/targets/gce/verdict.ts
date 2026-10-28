// The patch request's verdict (a verdict per package, APPROVE or HOLD, the reviewer ids and the evidence
// sha). Its keys, its item set and the sha's input are the broker's caller contract; a change lands in this file only.
// items names every candidate of the VM's latest inventory and nothing else (the review read: no other inventory is read
// before the patch), keyed by the inventory's name strings; the sha is sha256 over each inventory answer's
// re-serialized object in ascending seq, through broker/broker.ts evidenceSha.

import { evidenceSha } from "../broker/broker.ts";
import type { Inventory } from "./answer.ts";
import type { GceSession } from "./broker.ts";

export interface PatchVerdict {
  items: Record<string, "APPROVE" | "HOLD">;
  /** The configured reviewers' names, under the broker's two keys (broker/broker.ts verdictReviewers). */
  reviewers: Record<string, string>;
  evidence_sha256: string;
}

export function patchVerdict(inv: Inventory, approve: ReadonlySet<string>, reviewers: PatchVerdict["reviewers"], s: GceSession): PatchVerdict {
  // Names pass PKG (lowercase first character), so no key can be "__proto__".
  const names = [...new Set(inv.candidates.map((c) => c.name))].sort();
  return { items: Object.fromEntries(names.map((n) => [n, approve.has(n) ? "APPROVE" : "HOLD"])), reviewers, evidence_sha256: evidenceSha({ evidence: s.evidence }) };
}

export const approvedNames = (v: PatchVerdict): string[] => Object.keys(v.items).filter((n) => v.items[n] === "APPROVE");
