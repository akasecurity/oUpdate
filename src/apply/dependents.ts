// OUP-326 item 4: formulae that use each other are upgraded as one `brew upgrade a b c`, so a dependent never keeps linking
// a library the upgrade of what it uses just removed. Only the Type A list that is about to be upgraded is regrouped.
//
// A formula is widened only by dependents that are themselves in that list (so never a pinned one, one held by a Type A
// review, a Type B or unknown-tap one, a cask, the bun this run executes under, or one waiting on a gated formula), and
// that are not also release-checked, in apply.heldByDesign (the exact name, as the stuck report reads it) or waiting on a
// release check's unfinished record. If any installed, outdated dependent of a formula is not such a member, its
// dependents could not be read (a failed or timed-out command, a line that is not a package name or that could be read as
// an option), the formula upgrades alone, as before: it is then in no set at all, whoever lists it. Sets that share a
// member are one set.
//
// Order: a set is upgraded where its LAST member was, so a formula one of its members uses is never made to wait for it
// and the run's stop rules (the time-box breaker) see the set after what came before it. A member that would be moved
// past a formula it uses or that uses it (or one whose dependents were not read) is taken out of the set and upgrades
// alone, where it was. The read is `brew uses --installed --recursive --formula <name>` (read only, so a dry run makes it too).

import { findCheck } from "./release-checks.ts";
import { last, PhaseTimeout, PKG_NAME, type RunCtx } from "./run-ctx.ts";

const safe = (n: string) => PKG_NAME.test(n) && !n.startsWith("-");

/**
 * The upgrade units for `names` (the Type A formulae that will be upgraded, in order): each unit is one `brew upgrade`.
 * `outdated` is every formula brew listed outdated this run, before any hold took one out of `names`.
 */
export async function upgradeUnits(rt: RunCtx, names: string[], outdated: string[]): Promise<string[][]> {
  const { cfg, log, x, rcPending, rcBroken, rcUnchecked } = rt;
  if (names.length < 2) return names.map((n) => [n]);
  const bare = (n: string) => last(n);
  const eligible = new Set(names.filter((n) => safe(n)
    && !findCheck(cfg.releaseChecks, n)
    && !cfg.heldByDesign.includes(n)
    && !rcPending.has(bare(n)) && !rcBroken.includes(bare(n)) && !rcUnchecked.has(bare(n))));
  const byBare = new Map(names.map((n) => [bare(n), n] as const));
  const outdatedBare = new Set(outdated.map(bare));
  // Each formula whose dependents were read: their bare names. Absent: not read (or not eligible to be read).
  const uses = new Map<string, Set<string>>();
  const alone = new Set(names.filter((n) => !eligible.has(n)));
  for (const f of names) {
    if (!eligible.has(f)) continue;
    let deps: string[] | undefined;
    try {
      const u = await x([cfg.brew, "uses", "--installed", "--recursive", "--formula", f]);
      // Each LINE is one package name: a line with a space or any other content is unreadable, not several names.
      const lines = u.out.split("\n").map((l) => l.trim()).filter(Boolean);
      deps = u.rc === 0 && lines.every(safe) ? lines : undefined;
    } catch (e) {
      if (!(e instanceof PhaseTimeout)) throw e;
      log.push(`  ${bare(f)}: the read of its dependents timed out`);
    }
    if (deps === undefined) {
      log.push(`  ${bare(f)}: upgraded alone — its dependents could not be read`);
      alone.add(f);
      continue;
    }
    uses.set(f, new Set(deps.map(bare)));
    const blocked = deps.find((d) => outdatedBare.has(bare(d)) && !eligible.has(byBare.get(bare(d)) ?? ""));
    if (blocked !== undefined) {
      log.push(`  ${bare(f)}: upgraded alone — its outdated dependent ${bare(blocked)} is held or not upgraded in this list`);
      alone.add(f);
    }
  }
  const parent = new Map(names.map((n) => [n, n] as const));
  const find = (n: string): string => (parent.get(n) === n ? n : find(parent.get(n)!));
  for (const f of names) {
    if (alone.has(f)) continue;
    for (const d of uses.get(f)!) {
      const m = byBare.get(d);
      if (m !== undefined && m !== f && !alone.has(m)) parent.set(find(m), find(f));
    }
  }
  const comps = new Map<string, string[]>();
  for (const n of names) comps.set(find(n), [...(comps.get(find(n)) ?? []), n]);
  const at = (n: string) => names.indexOf(n);
  const related = (m: string, y: string) => !uses.has(y) || uses.get(m)!.has(bare(y)) || uses.get(y)!.has(bare(m));
  const units: { at: number; members: string[] }[] = [];
  for (const members of comps.values()) {
    let set = members;
    // A member moves to the last member's place: it must not pass a formula it uses or that uses it, or one not read.
    for (let again = set.length > 1; again;) {
      again = false;
      const end = at(set.at(-1)!);
      for (const m of set) {
        const y = names.find((n) => at(n) > at(m) && at(n) < end && !set.includes(n) && related(m, n));
        if (y === undefined) continue;
        log.push(`  ${bare(m)}: upgraded alone — upgrading it with ${bare(set.at(-1)!)} would move it past ${bare(y)}`);
        units.push({ at: at(m), members: [m] });
        set = set.filter((n) => n !== m);
        again = set.length > 1;
        break;
      }
    }
    if (set.length) units.push({ at: at(set.at(-1)!), members: set });
  }
  return units.sort((a, b) => a.at - b.at).map((u) => u.members);
}
