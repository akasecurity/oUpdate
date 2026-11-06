// Who served each reviewer call in a limits run: the router can answer a call from a fallback model when the requested one is busy,
// and the same code then scores differently. Counts only; the results file stays free of where the reviewer is reached.

import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Reviewer } from "../../src/review.ts";

export interface ServedTally {
  /** Answered reviewer calls: one call is one chunk sent to the reviewer, so a review of a large release counts several. */
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
  const rel = relative(realish(repoRoot), realish(out));
  const inside = rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
  return inside ? msg : undefined;
}

// The path with symlinks resolved as far as it exists, the rest appended as written: a folder not made yet still lands where its parent really is.
function realish(p: string): string {
  const rest: string[] = [];
  let cur = resolve(p);
  while (!existsSync(cur) && dirname(cur) !== cur) { rest.unshift(basename(cur)); cur = dirname(cur); }
  return join(realpathSync(cur), ...rest);
}

export const snapshotTally = (t: ServedTally): ServedTally => ({ ...t, by_value: { ...t.by_value } });
/** Puts `t` back to `snap`, in place (a retried attempt must not count the calls of the failed one). */
export function restoreTally(t: ServedTally, snap: ServedTally): void {
  Object.assign(t, snapshotTally(snap));
}

/**
 * The reviewer with every answered call counted into `tally`; `requested` is the model the spec asked for (undefined: none to compare,
 * so no call is "not requested"). The result is a view of the same reviewer: its methods run on the original object, so a class
 * reviewer keeps its methods and fields. The served-by value is read after each call from that one reviewer, which is right while
 * calls run one at a time; a parallel eval would have to capture it per call. A spread or Object.assign copy of the view keeps the
 * tracked `review` of a plain-object reviewer, but a class reviewer's copy loses `review` and every other prototype method; and each
 * read of a method other than `review` returns a new bound function (compare methods on the original reviewer). A reviewer wrapped by the verdict store reports no served-by for a store hit,
 * so such a call would count as unknown; the limits eval does not use the store.
 */
export function trackServed(reviewer: Reviewer, requested: string | undefined, tally: ServedTally): Reviewer {
  const review = async (prompt: string) => {
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
  };
  return new Proxy(reviewer, {
    get(target, prop) {
      if (prop === "review") return review;
      const v = Reflect.get(target, prop, target);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

/** The one-line summary of a tally for the results report. */
export const servedLine = (t: ReturnType<typeof publicTally>): string =>
  `served by: ${t.calls} reviewer calls (each call is one chunk sent to the reviewer, not one review); ${t.not_requested} not served by the requested model; ${t.unknown} with no served-by header${t.by_value && Object.keys(t.by_value).length ? `; by value ${Object.entries(t.by_value).map(([k, n]) => `${k} ${n}`).join(", ")}` : ""}`;
