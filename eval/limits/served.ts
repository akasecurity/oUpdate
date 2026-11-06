// Who served each reviewer call in a limits run: the router can answer a call from a fallback model when the requested one is busy,
// and the same code then scores differently. Counts only; the results file stays free of where the reviewer is reached.

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
        if (requested !== undefined && by.toLowerCase() !== requested.toLowerCase()) tally.not_requested++;
      }
      return text;
    },
  };
}
