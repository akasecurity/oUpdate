// The gce-patch reach's verbs as oupdate asks them: each read verb's answer cap and deadline, and the value
// rules that every package name, version, id and time must pass. The caps and deadlines are the broker spec;
// a change lands in this file only. An answer over its cap is refused by the broker and again here, never cut. The
// instance and vulns verbs exist on the broker but this leg does not ask them.

export type GceReadVerb = "inventory" | "job.status";

export const GCE_READ_VERBS: Record<GceReadVerb, { capBytes: number; deadlineS: number }> = {
  // The full installed set, plus the broker's streamed archive-index check of every candidate (three suites, the broker spec).
  inventory: { capBytes: 2 * 1024 * 1024, deadlineS: 300 },
  "job.status": { capBytes: 4 * 1024, deadlineS: 30 },
};
/** The patch verb's own deadline (the broker's pre-execute re-reads, §2.1), on top of the leg's card wait. */
export const PATCH_DEADLINE_S = 300;

/** apt.exclusivePackages: 1 to 200 names, each of this form. */
export const PKG = /^[a-z0-9][a-z0-9+.-]{0,127}$/;
export const MAX_NAMES = 200;
/** A Debian version as dpkg writes it: an optional epoch, the upstream part, an optional revision. */
export const DEB_VERSION = /^[0-9][A-Za-z0-9.+~:-]{0,127}$/;
export const SUITE = /^[a-z]{2,20}-security$/;
export const INSTANCE_ID = /^\d{1,20}$/;
/** The broker's run id and its process boot id: 32 lowercase hex characters each. */
export const RUN_ID = /^[0-9a-f]{32}$/;
export const BOOT_ID = RUN_ID;
export const JOB_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;

/** An RFC 3339 UTC time as epoch ms; fractions past ms are cut, so a later time never reads as earlier. Else undefined. */
export function parseTime(s: string): number | undefined {
  if (!TIME.test(s)) return undefined;
  const ms = Date.parse(s.replace(/(\.\d{3})\d+Z$/, "$1Z"));
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 19) === s.slice(0, 19) ? ms : undefined;
}
