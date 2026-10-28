// Shadow comparison against the previous updater: (a) what changed since the previous snapshot vs what its
// summary says it upgraded; (b) what is still outdated vs what it held (flagged, stuck, failed, repo-pinned,
// cask-excluded; a flagged npm batch holds every outdated npm global). A brew node upgrade also changes the npm global,
// since the node bottle ships its own npm. Names match on their last path segment (the summary names core formulae
// short, taps in full).

import type { Item, Outdated } from "./collect.ts";
import type { PrevSummary } from "./prev-log.ts";

const COVERED = new Set(["brew-formula", "brew-cask", "npm-global"]);
const key = (name: string) => name.split("/").at(-1)!;

function diff(inv: string[], summary: string[]): { onlyInventory: string[]; onlyPrevious: string[] } {
  const ik = new Map(inv.map((n) => [key(n), n]));
  const sk = new Map(summary.map((n) => [key(n), n]));
  return {
    onlyInventory: [...ik].filter(([k]) => !sk.has(k)).map(([, n]) => n).sort(),
    onlyPrevious: [...sk].filter(([k]) => !ik.has(k)).map(([, n]) => n).sort(),
  };
}

export interface Comparison {
  upgraded: { baseline: boolean; onlyInventory: string[]; onlyPrevious: string[] };
  held: { onlyInventory: string[]; onlyPrevious: string[] };
  agree: boolean;
}

export function compareRun(a: { prev: Item[] | undefined; cur: Item[]; outdated: Outdated[]; summary: PrevSummary }): Comparison {
  const outdated = a.outdated.filter((o) => COVERED.has(o.kind) && !o.pinned);
  const held = diff(
    outdated.map((o) => o.name),
    [
      ...a.summary.brew.flagged, ...a.summary.brew.stuck, ...a.summary.brew.failed, ...(a.summary.brew.pinned ?? []), ...(a.summary.brew.excluded ?? []),
      ...(a.summary.npm.flagged ? outdated.filter((o) => o.kind === "npm-global").map((o) => o.name) : []),
      ...(a.summary.npm.failed ?? []),
    ],
  );
  let upgraded: Comparison["upgraded"] = { baseline: false, onlyInventory: [], onlyPrevious: [] };
  if (a.prev) {
    const before = new Map(a.prev.map((i) => [`${i.kind}:${i.name}`, i.version]));
    const changed = a.cur.filter((i) => COVERED.has(i.kind) && before.get(`${i.kind}:${i.name}`) !== i.version).map((i) => i.name);
    const nodeNpm = a.summary.brew.upgraded.includes("node") && changed.includes("npm") ? ["npm"] : [];
    upgraded = { baseline: true, ...diff(changed, [...a.summary.brew.upgraded, ...a.summary.npm.upgraded, ...nodeNpm]) };
  }
  const empty = (d: { onlyInventory: string[]; onlyPrevious: string[] }) => !d.onlyInventory.length && !d.onlyPrevious.length;
  return { upgraded, held, agree: empty(upgraded) && empty(held) };
}

function mondayMs(date: string): number {
  const d = new Date(`${date}T00:00:00Z`);
  return d.getTime() - ((d.getUTCDay() + 6) % 7) * 86400000;
}

// Consecutive weeks, ending at the latest week with a report, in which every report agreed.
// A seed run (no previous snapshot, baseline false) had nothing to compare, so it is left out.
export function weeklyStreak(reports: { date: string; agree: boolean; baseline?: boolean }[]): number {
  const weeks = new Map<number, boolean>();
  for (const r of reports) {
    if (r.baseline === false) continue;
    const m = mondayMs(r.date);
    weeks.set(m, (weeks.get(m) ?? true) && r.agree);
  }
  const sorted = [...weeks].sort((x, y) => y[0] - x[0]);
  let n = 0;
  for (let i = 0; i < sorted.length; i++) {
    if (!sorted[i]![1]) break;
    if (i > 0 && sorted[i - 1]![0] - sorted[i]![0] !== 7 * 86400000) break;
    n++;
  }
  return n;
}
