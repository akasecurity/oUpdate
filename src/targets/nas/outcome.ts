// What a NAS verb's rc means to the caller (CRB-b128 §1.2, §4.4). Writes use the broker's own RC to outcome table, so
// the caller and the broker count an attempt the same way. Any rc not in the table, or no marker at all, is `unknown`. A
// `failed` or `unknown` write suspends the broker's standing entry until William approves a Re-arm card.

import type { WriteVerb } from "./verbs.ts";

export type WriteOutcome = "ok" | "failed" | "unknown" | "no-change";
const OUTCOMES: readonly string[] = ["ok", "failed", "unknown", "no-change"];

const RC_TEXT: Readonly<Record<number, string>> = {
  0: "ok",
  2: "refused by the grammar",
  3: "a tool failed",
  4: "bound value mismatch, nothing changed",
  5: "busy",
  6: "failed after a change, rolled back",
  7: "deadline",
  8: "restore failed",
  9: "an apply ran under 20 h ago",
};
export const rcText = (rc: number): string => RC_TEXT[rc] ?? "not a known rc";

export function writeOutcome(verb: WriteVerb, rc: number | undefined): WriteOutcome {
  switch (rc) {
    case 0:
      return "ok";
    case 2:
    case 5:
    case 9:
      return "no-change";
    // compose.apply emits 3 only before step 5, when no tag has moved (design review of rev 3d, L-1).
    case 3:
      return verb === "compose.apply" ? "no-change" : "failed";
    case 4:
      return verb === "image.prune" ? "unknown" : "no-change";
    case 6:
      return verb === "compose.apply" ? "failed" : "unknown";
    default:
      return "unknown";
  }
}

/** The broker's outcome field, when it sends one, must equal the caller's reading; any disagreement is unknown. */
export function mergeOutcome(caller: WriteOutcome, broker: string): WriteOutcome {
  return OUTCOMES.includes(broker) && broker === caller ? caller : "unknown";
}

export const suspends = (o: WriteOutcome): boolean => o === "failed" || o === "unknown";

/** Why a read failed, from its rc; undefined for rc 0. */
export function readFailure(rc: number | undefined): string | undefined {
  if (rc === 0) return undefined;
  if (rc === undefined) return "no final marker: outcome unknown";
  if (rc === 2) return "refused by the NAS grammar (rc 2)";
  if (rc === 3) return "a tool failed on the NAS (rc 3)";
  if (rc === 5) return "busy: another write or plugin check holds the lock (rc 5)";
  if (rc === 7) return "deadline on the NAS (rc 7)";
  return `rc ${rc}: outcome unknown`;
}
