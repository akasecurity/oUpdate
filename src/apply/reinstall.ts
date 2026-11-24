// OUP-326 item 3: after `brew linkage --test` names formulae that link a library an upgrade removed, each is
// reinstalled once from source (`brew reinstall --formula --build-from-source <formula>`) and the linkage test is run
// again for those names; the note says "repaired" only for names that second test does not name.
//
// `brew reinstall` installs the tap's current version, so a reinstall of an outdated formula would be an unreviewed
// upgrade. A formula is reinstalled only when it is not outdated after this run's upgrade phase (read fresh here) and
// none of its dependencies (runtime, implicit and the stable build ones) is. Never reinstalled either, named in the note and the log: a formula
// brew pins or a repo's pins.json lists (read here, fresh: the run's own pinned list holds only the pinned formulae
// that were also outdated), one with a configured release check, the bun this run executes under, one in
// apply.heldByDesign or held by an unfinished release check, and a name that could be read as an option. A pin
// list, outdated list or dependency list that cannot be read (a pins.json that warns, a failed command) reinstalls
// nothing for it (fail closed). Each reinstall is bounded by apply.upgradeTimeoutMs; a failed or timed-out one is a
// FAILED entry `reinstall:<formula>` (a name only) and never stops the next. After two reinstalls in a row hit the time
// box (counted here, from 0; one that runs to its end resets it) the rest are "not tried", not FAILED. A formula with a
// dependency that is not installed (the source build would install it unreviewed) is held too. Once the run is stopping
// nothing more is started and nothing is claimed repaired. A command that times out inside the repair keeps
// the note: it says so. A dry run reinstalls nothing and says what it would do.

import { LOG_ONLY } from "./exec.ts";
import { linkageBroken } from "./kegs.ts";
import { key, pinFilter } from "./pins.ts";
import { findCheck } from "./release-checks.ts";
import { DECLARED_DEPS, holdRunningBun, last, PhaseTimeout, PKG_NAME, uniq, words, type RunCtx } from "./run-ctx.ts";

/** Two reinstalls in a row that hit the per-package time box: the rest wait for the next run (the upgrade loops' rule, counted here from 0). */
const BREAKER_AFTER = 2;

export async function linkageRepair(rt: RunCtx, bad: string[], note: string): Promise<string> {
  const { cfg, log, b, x, dryRun, brewFailed, installEnv, fs, opts } = rt;
  if (!bad.length) return note;
  const names = uniq(bad);
  const held = new Map<string, string>(); // name -> why
  const outdatedHeld: string[] = [];
  const failed: string[] = [];
  const notTried: string[] = [];
  const stoppedNames: string[] = [];
  const missingDeps: string[] = [];
  const repaired: string[] = [];
  let stillBroken: string[] = [];
  let problem = "";
  try {
    const pinnedQ = await x([cfg.brew, "list", "--pinned", "--formula"]);
    const pins = pinFilter("brew", names, { brewPinned: pinnedQ.rc === 0 ? words(pinnedQ.out) : [], files: fs.pinFiles(cfg.pinRoots) });
    const pinsOk = pinnedQ.rc === 0 && !pins.warnings.length;
    if (pinnedQ.rc !== 0) log.push(`  linkage: brew list --pinned failed (rc ${pinnedQ.rc}) — pins not read, nothing is reinstalled`);
    for (const w of pins.warnings) log.push(`  linkage: ${w} — nothing is reinstalled`);
    const listQ = await x([cfg.brew, "list", "--formula", "--full-name"]);
    const installedOk = listQ.rc === 0;
    if (!installedOk) log.push(`  linkage: brew list --formula failed (rc ${listQ.rc}) — nothing is reinstalled`);
    // Full names (tap/name; core formulae bare). A qualified member must match exactly (the same bare name in two taps is two
    // formulae); a bare member matches a full name or the last segment of one, as brew resolves a bare name.
    const installedFull = new Set(words(listQ.out));
    const installedLast = new Set(words(listQ.out).map(last));
    const isInstalled = (m: string) => (m.includes("/") ? installedFull.has(m) : installedFull.has(m) || installedLast.has(m));
    const outdatedQ = await x([cfg.brew, "outdated", "--formula"]);
    const outdatedOk = outdatedQ.rc === 0;
    if (!outdatedOk) log.push(`  linkage: brew outdated --formula failed (rc ${outdatedQ.rc}) — nothing is reinstalled`);
    const outdated = new Set(words(outdatedQ.out).map(last));
    const pinnedBy = new Map(pins.pinned.map((p) => [key(p.replace(/\(.*$/, "")), p.replace(/^[^(]*\(|\)$/g, "")] as const));
    const selfBun = new Set(holdRunningBun(names, opts.bunExec ?? process.execPath).held);
    const todo: string[] = [];
    const cache: BuildCache = new Map();
    for (const n of names) {
      const why = !PKG_NAME.test(n) || n.startsWith("-") ? "not a formula name"
        : !pinsOk ? "pins not read"
        : !outdatedOk ? "outdated list not read"
        : !installedOk ? "installed list not read"
        : pinnedBy.has(key(n)) ? `pinned: ${pinnedBy.get(key(n))}`
        : selfBun.has(n) ? "runs under it"
        : findCheck(cfg.releaseChecks, n) ? "it has a release check"
        : cfg.heldByDesign.some((h) => h === n || last(h) === last(n)) ? "held by design"
        : "";
      if (why) {
        held.set(n, why);
        log.push(`  linkage: ${n} not reinstalled (${why})`);
      } else if (outdated.has(last(n))) {
        outdatedHeld.push(n);
        log.push(`  linkage: ${n} not reinstalled (outdated: a reinstall would install the new version unreviewed)`);
      } else {
        // The set S(name) a stable source build can install or upgrade, read with the queries below (see dependencySet). A member that
        // is not installed or is outdated would be installed or upgraded unreviewed. `--formula`: a cask of the same name never answers.
        const set = await dependencySet(rt, n, cache);
        const deps = set ?? [];
        const read = set !== undefined;
        const missing = read ? deps.find((dep) => !isInstalled(dep)) : undefined;
        const stale = read ? deps.find((dep) => outdated.has(last(dep))) : undefined;
        if (!read) {
          held.set(n, "dependencies not read");
          log.push(`  linkage: ${n} not reinstalled (its dependencies could not be read)`);
        } else if (missing) {
          missingDeps.push(`${n} needs ${last(missing)}`);
          log.push(`  linkage: ${n} not reinstalled (its dependency ${last(missing)} is not installed)`);
        } else if (stale) {
          held.set(n, `depends on outdated ${last(stale)}`);
          log.push(`  linkage: ${n} not reinstalled (it depends on ${last(stale)}, which is outdated)`);
        } else todo.push(n);
      }
    }
    if (dryRun) {
      if (todo.length) log.push(`dry-run: would reinstall --build-from-source: ${todo.join(" ")}`);
    } else {
      const done: string[] = [];
      let hits = 0; // reinstalls in a row that hit the time box
      for (const n of todo) {
        if (opts.isStopping?.()) {
          stoppedNames.push(n);
          continue;
        }
        if (hits >= BREAKER_AFTER) {
          notTried.push(n);
          continue;
        }
        log.push(`  linkage: brew reinstall --formula --build-from-source ${n}`);
        const r = await x([cfg.brew, "reinstall", "--formula", "--build-from-source", n], { env: installEnv, timeoutMs: cfg.upgradeTimeoutMs, soft: true, ...LOG_ONLY });
        if (r.rc === 143 && r.err.includes("not started")) {
          stoppedNames.push(n); // the run is stopping: it never started
          continue;
        }
        hits = r.timedOut ? hits + 1 : 0;
        if (r.rc !== 0 || r.timedOut) {
          log.push(`  linkage: reinstall of ${n} ${r.timedOut ? "timed out" : `failed (rc ${r.rc})`}`);
          failed.push(n);
          await brewFailed(`reinstall:${n}`);
        } else done.push(n);
      }
      if (notTried.length) log.push(`  linkage: not tried (time box): ${notTried.join(" ")}`);
      if (stoppedNames.length) log.push(`  linkage: not tried (stopped): ${stoppedNames.join(" ")}`);
      if (done.length) {
        // The linkage test again, for the names that were reinstalled only; only what it names is still broken.
        const again = await x([cfg.brew, "linkage", "--test", ...done], { env: { HOMEBREW_DEV_CMD_RUN: "1" } });
        const named = linkageBroken(`${again.out}${again.err}`).filter((n) => done.includes(n));
        if (opts.isStopping?.() || again.rc >= 128) problem = "linkage repair interrupted";
        else if (again.rc === 0) repaired.push(...done);
        else if (named.length) {
          stillBroken = named;
          repaired.push(...done.filter((n) => !named.includes(n)));
        } else {
          stillBroken = done;
          problem = "linkage test failed, names unknown";
        }
        log.push(`  linkage: ${problem === "linkage repair interrupted" ? "interrupted" : stillBroken.length ? `still broken: ${stillBroken.join(" ")}` : "clean"} after the reinstall of ${done.join(" ")}${problem ? ` (${problem})` : ""}`);
      } else if (opts.isStopping?.()) problem = "linkage repair interrupted";
    }
  } catch (e) {
    if (!(e instanceof PhaseTimeout)) throw e;
    problem = "linkage repair timed out";
    log.push(`  linkage: a command timed out — ${problem}`);
  }
  const left = names.filter((n) => !repaired.includes(n));
  if (!left.length) return `linkage repaired by reinstall: ${repaired.join(" ")}`;
  const parts = [
    `LINKAGE FAILED: ${left.join(" ")}`,
    repaired.length ? `repaired by reinstall: ${repaired.join(" ")}` : "",
    failed.length ? `reinstall FAILED: ${failed.join(" ")}` : "",
    outdatedHeld.length ? `outdated, held: ${outdatedHeld.join(" ")}` : "",
    held.size ? `not reinstalled (held): ${[...held.keys()].join(" ")}` : "",
    missingDeps.length ? `missing dependency, held: ${missingDeps.join(", ")}` : "",
    notTried.length ? `not tried (time box): ${notTried.join(" ")}` : "",
    stoppedNames.length ? `not tried (stopped): ${stoppedNames.join(" ")}` : "",
    problem,
    "fix: brew reinstall --build-from-source <formula>",
  ].filter(Boolean);
  return parts.join("; ");
}

/** Per run: the answers for a build dependency (canonical name and its runtime/implicit dependencies), so each is asked once. */
type BuildCache = Map<string, string[] | undefined>;

const MAX_BUILD_DEPS = 20;

const jsonOf = (out: string): { formulae?: unknown } | undefined => {
  try {
    const j = JSON.parse(out) as unknown;
    return j && typeof j === "object" ? (j as { formulae?: unknown }) : undefined;
  } catch {
    return undefined;
  }
};
const strings = (v: unknown): string[] | undefined => (Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : undefined);

/**
 * What a stable source build of `name` can install or upgrade, as names; undefined when any part cannot be read (the caller holds):
 * - the recursive runtime and implicit dependencies (`brew deps --formula --include-implicit`, implicit: what unpacking the
 *   source needs, such as zstd);
 * - each stable build dependency from `brew info --json=v2 --formula` (build_dependencies), by its canonical name (an alias
 *   resolves to the formula it names: the JSON's `name`), with that build dependency's own recursive runtime and implicit
 *   dependencies (cairo -> meson -> python);
 * - the optional dependencies only when an installed keg was built with an option (any installed[].used_options is not
 *   empty: --with-libfoo), as `--include-optional`. Never `--include-build`: it lists HEAD-only build dependencies too
 *   (jq: autoconf, automake, libtool, m4), which a stable build never installs.
 */
async function dependencySet(rt: RunCtx, name: string, cache: BuildCache): Promise<string[] | undefined> {
  const { cfg, x } = rt;
  const info = await x([cfg.brew, "info", "--json=v2", "--formula", name]);
  const f = info.rc === 0 ? (jsonOf(info.out)?.formulae as { build_dependencies?: unknown; installed?: unknown }[] | undefined) : undefined;
  const build = strings(f?.[0]?.build_dependencies);
  const installed = f?.[0]?.installed;
  if (!build || !Array.isArray(installed) || build.length > MAX_BUILD_DEPS) return undefined;
  // Every installed keg must carry readable option metadata; the receipt of the active keg decides what a reinstall builds
  // (not necessarily the first listed), so an option on any of them reads the optional dependencies too.
  let optional = false;
  for (const keg of installed) {
    const used = keg && typeof keg === "object" ? strings((keg as { used_options?: unknown }).used_options) : undefined;
    if (!used) return undefined;
    if (used.length) optional = true;
  }
  const d = await x([cfg.brew, "deps", "--formula", ...(optional ? ["--include-optional"] : []), "--include-implicit", name]);
  if (d.rc !== 0) return undefined;
  const members = [...words(d.out)];
  for (const b of build) {
    if (!PKG_NAME.test(b) || b.startsWith("-")) return undefined;
    if (!cache.has(b)) cache.set(b, await buildDependency(rt, b));
    const got = cache.get(b);
    if (!got) return undefined;
    members.push(...got);
  }
  const all = uniq(members);
  return all.every((m) => PKG_NAME.test(m)) ? all : undefined;
}

/** A build dependency's canonical name (an alias resolved) and its recursive runtime and implicit dependencies. */
async function buildDependency(rt: RunCtx, b: string): Promise<string[] | undefined> {
  const { cfg, x } = rt;
  const info = await x([cfg.brew, "info", "--json=v2", "--formula", b]);
  const f = info.rc === 0 ? (jsonOf(info.out)?.formulae as { name?: unknown; full_name?: unknown }[] | undefined) : undefined;
  // The tap-qualified name when brew gives one (the same bare name in two taps is two formulae), else the name.
  const canonical = typeof f?.[0]?.full_name === "string" ? f[0].full_name : f?.[0]?.name;
  if (typeof canonical !== "string" || !PKG_NAME.test(canonical)) return undefined;
  const d = await x([cfg.brew, "deps", "--formula", "--include-implicit", canonical]);
  return d.rc === 0 ? [canonical, ...words(d.out)] : undefined;
}
