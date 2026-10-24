// Stuck tracking, ported from the previous updater's su_track_stuck and su_brew_track_pending. A package
// still pending after its run is counted; once it has been pending STUCK_AFTER runs in a row it
// is reported as stuck. State is one line per item: "<lane>\t<item>\t<runs>\t<first seen>", where
// an item is "<name>=<target version>", so a new target starts a fresh count. Each call rebuilds
// only its own lane and carries the others through untouched. Pure: the caller reads and writes
// the state file, and skips tracking in a dry run.

export interface Tracked {
  state: string;
  /** "<item>(<runs> runs, since <date>)" for every item at or past the threshold. */
  stuck: string[];
}

export function trackStuck(state: string, lane: string, pending: string[], o: { today: string; after: number; exclude?: string[] }): Tracked {
  const rows = state.split("\n").filter(Boolean).map((l) => l.split("\t"));
  const kept = rows.filter((r) => r[0] !== lane);
  const mine = new Map(rows.filter((r) => r[0] === lane).map((r) => [r[1] ?? "", r] as const));
  const exclude = new Set(o.exclude ?? []);
  const out = kept.map((r) => r.join("\t"));
  const stuck: string[] = [];
  for (const item of pending) {
    if (exclude.has(item)) continue;
    const prev = mine.get(item);
    const runs = (Number.parseInt(prev?.[2] ?? "", 10) || 0) + 1;
    const first = prev?.[3] || o.today;
    out.push([lane, item, String(runs), first].join("\t"));
    if (runs >= o.after) stuck.push(`${item}(${runs} runs, since ${first})`);
  }
  return { state: out.length ? `${out.join("\n")}\n` : "", stuck };
}

/**
 * The brew lane's pending items from `brew outdated --json=v2`: "<name>=<current version>" for
 * every formula and cask not held (excluded casks and pinned tools are outdated by design). Names
 * match held entries in full or by their last segment. Anything malformed is a failed query
 * (undefined), never an empty list: the caller keeps the previous state and marks the phase failed.
 */
export function pendingFromOutdated(json: string, held: string[]): string[] | undefined {
  let data: { formulae?: unknown; casks?: unknown };
  try {
    data = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (!data || !Array.isArray(data.formulae) || !Array.isArray(data.casks)) return undefined;
  const skip = new Set(held);
  const out: string[] = [];
  for (const item of [...data.formulae, ...data.casks] as Record<string, unknown>[]) {
    const name = item?.name ?? item?.token;
    if (typeof name !== "string" || /\s/.test(name) || !name) return undefined;
    if (skip.has(name) || skip.has(name.split("/").at(-1)!)) continue;
    const target = item.current_version;
    if (typeof target !== "string" || !target || /\s/.test(target)) return undefined;
    out.push(`${name}=${target}`);
  }
  return out;
}
