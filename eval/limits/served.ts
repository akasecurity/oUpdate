// Who served each reviewer call in a limits run: the router can answer a call from a fallback model when the requested one is busy,
// and the same code then scores differently. Counts only; the results file stays free of where the reviewer is reached.

import { isAbsolute, relative, resolve } from "node:path";
import type { Reviewer } from "../../src/review.ts";

export interface ServedTally {
  /** Answered calls. */
  calls: number;
  /** Answered calls per served-by value, as the endpoint wrote it. */
  by_value: Record<string, number>;
  /** Calls whose served-by value names another model than the requested one. */
  not_requested: number;
  /** Calls with no served-by value (the endpoint or reviewer does not say). */
  unknown: number;
}

export const newTally = (): ServedTally => ({ calls: 0, by_value: {}, not_requested: 0, unknown: 0 });

export function addTallies(ts: ServedTally[]): ServedTally {
  const out = newTally();
  for (const t of ts) {
    out.calls += t.calls;
    out.not_requested += t.not_requested;
    out.unknown += t.unknown;
    for (const [k, n] of Object.entries(t.by_value)) out.by_value[k] = (out.by_value[k] ?? 0) + n;
  }
  return out;
}

/** The tally as a results file may carry it: counts only, since the served-by values name where answers came from. `withValues` keeps them (a local run asked for them). */
export function publicTally(t: ServedTally, withValues: boolean): Omit<ServedTally, "by_value"> & { by_value?: Record<string, number> } {
  const { by_value, ...counts } = t;
  return withValues ? t : counts;
}

/** Why --served-values cannot run, or undefined when it can: the values name where answers came from, so they go only to an --out folder outside the repo (results under eval/limits are tracked and public). */
export function servedValuesRefusal(withValues: boolean, out: string | undefined, repoRoot: string): string | undefined {
  if (!withValues) return undefined;
  const msg = "--served-values needs --out <dir> outside the repo: served-by values must not land in a tracked results folder";
  if (!out) return msg;
  const rel = relative(resolve(repoRoot), resolve(out));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)) ? msg : undefined;
}

export const snapshotTally = (t: ServedTally): ServedTally => ({ ...t, by_value: { ...t.by_value } });
/** Puts `t` back to `snap`, in place (a retried attempt must not count the calls of the failed one). */
export function restoreTally(t: ServedTally, snap: ServedTally): void {
  Object.assign(t, snapshotTally(snap));
}

/** The reviewer with every answered call counted into `tally`; `requested` is the model the spec asked for (undefined: none to compare, so no call is "not requested"). */
export function trackServed(reviewer: Reviewer, requested: string | undefined, tally: ServedTally): Reviewer {
  return {
    ...reviewer,
    review: async (prompt) => {
      const text = await reviewer.review(prompt);
      const by = reviewer.lastServedBy?.();
      tally.calls++;
      if (by === undefined) tally.unknown++;
      else {
        tally.by_value[by] = (tally.by_value[by] ?? 0) + 1;
        // Names match exactly except for case; a router that names its worker differently from the model counts as not requested.
        if (requested !== undefined && by.toLowerCase() !== requested.toLowerCase()) tally.not_requested++;
      }
      return text;
    },
  };
}
