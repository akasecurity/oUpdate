// After the brew upgrades: kegs left unlinked, broken linkage, and processes still running from a
// keg brew deleted. Ported from the previous updater's relink, linkage, lsof map,
// keg holder and stale-keg checks.
//
// Stale kegs: one lsof pass finds every process mapping a file under the Cellar whose keg
// directory is gone. A deferred service (config; its restart waits for an idle window) is handed
// to its handoff. This oupdate run and its ancestors are never restarted. Every other stale pid
// that launchd started (ppid 1) is looked up in launchd itself (`launchctl print system`, then
// `launchctl print gui/<uid>`) and restarted by that label. Only when launchd has no row for it is
// the label found by a plist name that is exactly the package or process name (or ends in "." and
// it), once per package, and restarted only when launchd runs that pid under it and the pid's
// executable is in the keg. An unmatched, unconfirmed or ambiguous label is never guessed at. With staleKegUnlisted "report" only
// a label in labelRestart is restarted; any other is named in the note. A re-scan then reports what
// is still stale. lsof failing is a reported failure, never "nothing stale".

import { basename, dirname } from "node:path";
import { isStopping, type Exec } from "./exec.ts";
import { kegHolders, type Holder } from "./holders.ts";
import { matchOwner, parsePrint, type QueuedOwner, type StaleOwner } from "./owner-waiter.ts";

export { kegHolders, type Holder };

export interface KegEnv {
  exec: Exec;
  isDir(path: string): Promise<boolean>;
  exists(path: string): Promise<boolean>;
  /** File names in a directory; [] when it cannot be read. */
  listDir(path: string): Promise<string[]>;
  home: string;
  uid: number;
  /**
   * Runs the read-only launchctl queries. Their timeout is an answer (fall back to the plist name),
   * not a stop of the step, so the run passes an exec that does not stop the step; env.exec otherwise.
   */
  query?: Exec;
  /** This run's pid (process.pid by default): it and its ancestors are never restarted. */
  selfPid?: number;
  /** Starts a command detached (the labelRestart owner commands); its stderr goes to the file. */
  spawnDetached?(argv: string[], stderrFile: string): Promise<number>;
}

/**
 * Per launchd label: "skip" (never restarted here), "kickstart" (restarted as usual, listed so it is
 * restarted under staleKegUnlisted "report"), or an owner command run detached with the label appended.
 */
export type LabelRestart = Record<string, "skip" | "kickstart" | string[]>;

/** How every package on one restarted target is accounted for; `said` names it in the log. */
interface Outcome {
  said: string;
  record: (pkg: string) => void;
}

/**
 * The pids with a mapped file under <caskroom>/<cask>/ or under one of the cask's app bundles
 * (a cask upgrade removes both, and the bin links with them), distinct, in numeric order.
 */
export function caskRunning(lsofOut: string, caskroom: string, cask: string, apps: string[]): string[] {
  const roots = [`${caskroom}/${cask}/`, ...apps.map((a) => `${a.replace(/\/$/, "")}/`)];
  const pids = new Set<string>();
  for (const line of lsofOut.split("\n")) {
    const f = line.trim().split(/\s+/);
    const name = f.at(-1) ?? "";
    if (f[1] && roots.some((r) => name.startsWith(r))) pids.add(f[1]);
  }
  return [...pids].sort((a, b) => Number(a) - Number(b));
}

/**
 * lsof's txt and mem maps, or undefined when lsof cannot run, fails or prints nothing. `strict` (a
 * scan a release check relies on): output without lsof's COMMAND header is unusable too, never "no
 * process on the keg".
 */
export async function lsofMaps(env: KegEnv, bin: string, log: string[], strict = false): Promise<string | undefined> {
  const r = await env.exec([bin, "-nP", "-w", "-d", "txt,mem"]);
  if (r.rc === 127) log.push(`  stale-keg: ${bin} is not executable`);
  else if (r.rc !== 0) log.push(`  stale-keg: ${bin} exited non-zero`);
  else if (!r.out.trim()) log.push(`  stale-keg: ${bin} returned nothing`);
  else if (strict && !r.out.split("\n").some((l) => l.startsWith("COMMAND"))) log.push(`  stale-keg: ${bin} printed no COMMAND header`);
  else return r.out;
  return undefined;
}

/** The pid's executable: its first txt map in lsof output (lsof lists it first), or undefined. */
export function exePath(lsofOut: string, pid: string): string | undefined {
  for (const line of lsofOut.split("\n")) {
    const f = line.trim().split(/\s+/);
    if (f[1] === pid && f[3] === "txt") return f.at(-1);
  }
  return undefined;
}

const isPid = (s: string) => s !== "" && [...s].every((ch) => ch >= "0" && ch <= "9");

/**
 * The labels of exactly this pid in the `services = {` block of `launchctl print system` or
 * `launchctl print gui/<uid>`, whose rows are "<pid> <flags or -> <tab><label>". Other blocks are
 * never read.
 */
export function serviceLabels(out: string, pid: string): string[] {
  const labels: string[] = [];
  let inside = false;
  for (const line of out.split("\n")) {
    const t = line.trim();
    if (!inside) {
      inside = t === "services = {";
      continue;
    }
    if (t === "}") break;
    const tab = line.lastIndexOf("\t");
    if (tab < 0) continue;
    const head = line.slice(0, tab).trim().split(/\s+/);
    const label = line.slice(tab + 1).trim();
    if (head.length === 2 && isPid(head[0]!) && head[0] === pid && label) labels.push(label);
  }
  return labels;
}

export interface KegOptions {
  brew: string;
  lsof: string;
  dryRun: boolean;
  host: string;
  logFile?: string;
  notify: (text: string) => void | Promise<void>;
  /** Packages (or process names containing them) whose restart is handed off instead of kickstarted. */
  deferred: string[];
  /** Hands a deferred service's stale keg over; returns the note for the summary, if any. Called in a dry run too: it must honour dryRun itself. */
  handoff: (keg: string, service: string) => Promise<string | undefined>;
  /** A narrow root helper that restarts a daemon by package name, for the packages it allows. */
  restartHelper?: { path: string; packages: string[] };
  /** Labels whose restart belongs to their owner, matched literally; checked before the helper and kickstart. */
  labelRestart?: LabelRestart;
  /** A label not in labelRestart: "kickstart" (absent too) restarts it, "report" only names it in the note. */
  staleKegUnlisted?: "kickstart" | "report";
  /** Job runner commands whose detached jobs are named, never restarted (config.ts jobRunners). */
  jobRunners?: readonly string[];
  /** stderr of a detached owner command. */
  detachedLog?: string;
  /** Labels the restart step already handed to their owner command this run (label → command name). */
  ownerHanded?: ReadonlyMap<string, string>;
  /** Counts the still-stale packages in the stale-keg lane; returns the stuck entries. */
  trackStuck: (still: string[]) => string[];
  /** The caller's log: lines land there as they are made, so a check stopped part-way keeps them. */
  log?: string[];
  /** Labels (globs) restarted only at an idle moment by the owner waiter; before labelRestart and staleKegUnlisted. */
  staleOwners?: StaleOwner[];
  /** Queues the matched jobs and starts the waiter; returns its note. Not called in a dry run. */
  queueOwners?: (items: QueuedOwner[]) => Promise<string>;
  /** Labels whose waiter restart failed: never queued again until the operator clears them. */
  ownerFailed?: ReadonlySet<string>;
  /** Labels the last waiter held as busy: queued again, counted as held busy. */
  ownerBusy?: ReadonlySet<string>;
  /**
   * A release check's formula racks, each with the one keg its owners must run (the candidate, or the
   * restored version after a rollback): every other keg of the rack counts as stale though it is on
   * disk (the previous keg the check keeps, and any older retained one).
   */
  releaseRacks?: ReadonlyMap<string, string>;
}

/**
 * How a package's stale holders were handled, in the order the STALE KEG note names them. Counted
 * per launchd target, or per pid for job runner jobs and orphans.
 */
const CATEGORIES = ["restarted", "waiting", "busy", "failed", "jobs", "orphans", "left", "reported"] as const;
type Category = (typeof CATEGORIES)[number];

/** `--job <id>` of a `<runner> run` command line for one of `runners` ("?" without one), or undefined when it is not one. */
export function runnerJob(command: string, runners: readonly string[]): string | undefined {
  const named = runners.some((r) => new RegExp(`(^|[\\s/])${r.replace(/[.]/g, "\\.")}(\\s|\\/)`).test(command));
  if (!named || !/\srun(\s|$)/.test(command)) return undefined;
  return command.match(/\s--job\s+(\S+)/)?.[1] ?? "?";
}

/** One category of a package's outcomes, as the STALE KEG note names it. */
function describeOutcome(c: Category, ids: string[]): string {
  const n = ids.length;
  switch (c) {
    case "restarted": return `restarted ${n}`;
    case "waiting": return `waiting for idle restart ${n}`;
    case "busy": return `held busy ${n}`;
    case "failed": return `FAILED ${n}`;
    case "jobs": return `runner jobs on old keg ${n}: ${ids.join(" ")}`;
    case "orphans": return `orphans ${n}: pid ${ids.join(" ")}`;
    case "left": return `restart left to its owner${n > 1 ? ` ${n}` : ""}`;
    case "reported": return `reported only, not on the restart list${n > 1 ? ` ${n}` : ""}`;
  }
}

const words = (s: string) => s.split(/\s+/).filter(Boolean);

async function send(o: KegOptions, log: string[], text: string) {
  try {
    await o.notify(text);
  } catch {
    log.push("  the notice could not be sent");
  }
}

/**
 * `scanned: false`: the cellar or lsof could not be read, so no process was looked at.
 * `unresolved`: the keg directories with a stale process whose owner was not found (no label, an
 * ambiguous one, a label launchd does not show running it, a job not restarted) or whose owner could
 * not be queued: a release check on one of them cannot know its owner was restarted.
 */
export interface StaleKegResult {
  note: string;
  log: string[];
  scanned?: false;
  unresolved: Set<string>;
}

export async function staleKegCheck(env: KegEnv, o: KegOptions): Promise<StaleKegResult> {
  const log: string[] = o.log ?? [];
  const c = await env.exec([o.brew, "--cellar"]);
  const cellar = c.rc === 0 ? c.out.trim() : "";
  /** Kegs whose stale process was not resolved to an owner (see StaleKegResult). */
  const unresolvedKegs = new Set<string>();
  /** A keg of a release check's rack other than the one its owners must run: stale though on disk. */
  const isRetired = (keg: string) => {
    const expect = o.releaseRacks?.get(dirname(keg));
    return expect !== undefined && keg !== expect;
  };
  if (!cellar || !(await env.isDir(cellar))) return { note: "", log, scanned: false, unresolved: unresolvedKegs };
  // A release check's keg among them: an lsof answer that is not lsof's is no scan.
  const strict = !!o.releaseRacks?.size;
  const maps = await lsofMaps(env, o.lsof, log, strict);
  if (maps === undefined) {
    const note = `STALE-KEG CHECK FAILED: lsof unusable (${o.lsof})`;
    log.push(`  ${note}`);
    return { note, log, scanned: false, unresolved: unresolvedKegs };
  }
  const held = kegHolders(maps, cellar);
  if (!held.length) return { note: "", log, unresolved: unresolvedKegs };

  const stale: string[] = [];
  const handed: string[] = [];
  const unresolved: string[] = [];
  /** Handoff notes in order; an owner's carries its package, dropped once the re-scan finds the package gone. */
  const handoffNotes: { pkg?: string; text: string }[] = [];
  const addNote = (text: string, pkg?: string) => void (handoffNotes.some((n) => n.text === text) || handoffNotes.push({ pkg, text }));
  const deferredHanded = new Set<string>();
  /** pid+package pairs left alone on purpose (this run, a user process): the re-scan does not count them. */
  const leftAlone = new Set<string>();
  const pair = (pid: string, pkg: string) => `${pid}\t${pkg}`;
  /**
   * One restart per launchd target per run. Its outcome (restarted, handed to the owner, left to
   * the owner, unresolved) is recorded for the package that made it, and again for every later
   * package on the same target, so each of them is accounted for the same way.
   */
  const restarted = new Map<string, Outcome>();
  /** Per package, per category, the targets (or pids) handled that way: every one is named in the note. */
  const marks = new Map<string, Map<Category, Set<string>>>();
  const mark = (pkg: string, c: Category, id: string) => {
    if (c === "orphans") misses++;
    let m = marks.get(pkg);
    if (!m) marks.set(pkg, (m = new Map()));
    let ids = m.get(c);
    if (!ids) m.set(c, (ids = new Set()));
    ids.add(id);
  };
  /** Jobs for the owner waiter, queued once after the walk. */
  const ownerQueue: QueuedOwner[] = [];
  /** Counts every unresolved entry and orphan as it is recorded (deduplicated or not): a holder that added one is unresolved. */
  let misses = 0;
  const add = (list: string[], v: string) => {
    if (list === unresolved) misses++;
    if (!list.includes(v)) list.push(v);
  };
  const ps = async (field: string, pid: string) => (await env.exec(["ps", "-o", `${field}=`, "-p", pid])).out.split("\n")[0]?.trim() ?? "";
  /** pid, then its parents up to (not including) launchd; read-only, bounded, stops on a loop. */
  const ancestry = async (pid: string) => {
    const chain: string[] = [];
    for (let p = pid; isPid(p) && p !== "0" && p !== "1" && !chain.includes(p) && chain.length < 64; p = await ps("ppid", p)) chain.push(p);
    return chain;
  };
  let selfChain: Promise<string[]> | undefined;
  const isSelf = async (pid: string) => (await (selfChain ??= ancestry(String(env.selfPid ?? process.pid)))).includes(pid);
  // launchd's own answer, asked once per check and only when a holder needs a label. A query that
  // fails, times out or throws is a note; the plist name match then decides.
  const queries = new Map<string, Promise<string | undefined>>();
  const ask = (argv: string[]) => {
    const key = argv.join(" ");
    let q = queries.get(key);
    if (!q) {
      q = (async () => {
        try {
          const r = await (env.query ?? env.exec)(argv);
          if (r.timedOut) log.push(`    ${key} timed out — falling back to the plist name`);
          else if (r.rc !== 0) log.push(`    ${key} failed (rc ${r.rc}) — falling back to the plist name`);
          else return r.out;
        } catch (e) {
          log.push(`    ${key} failed (${e instanceof Error ? e.message : String(e)}) — falling back to the plist name`);
        }
        return undefined;
      })();
      queries.set(key, q);
    }
    return q;
  };
  /**
   * The pid's job: system services first, then the user's gui domain (a label found there is truly
   * in gui/<uid>). More than one label for the pid is "ambiguous": nothing further is tried.
   */
  const launchdLabel = async (pid: string): Promise<{ label: string; system: boolean } | "ambiguous" | undefined> => {
    for (const system of [true, false]) {
      const argv = ["launchctl", "print", system ? "system" : `gui/${env.uid}`];
      const out = await ask(argv);
      if (out === undefined) continue;
      const labels = [...new Set(serviceLabels(out, pid))];
      if (labels.length === 1) return { label: labels[0]!, system };
      if (labels.length > 1) {
        log.push(`    ${argv.join(" ")}: pid ${pid} runs under ${labels.join(" ")} — not guessing`);
        return "ambiguous";
      }
    }
    return undefined;
  };
  /** Whether a launchd services query (system or the user's gui domain) failed this check, or printed no services block. */
  const launchdUnread = async () => {
    for (const d of ["system", `gui/${env.uid}`]) {
      const out = await ask(["launchctl", "print", d]);
      if (out === undefined || !out.split("\n").some((l) => l.trim() === "services = {")) return true;
    }
    return false;
  };
  /**
   * The plist-name candidates of a package: a label that is the package or process name, or ends in
   * "." and it (sh.brew.<pkg>, homebrew.mxcl.<pkg>). Never a name that merely contains it: that
   * could be an unrelated service.
   */
  const byName = async (pkg: string, comm: string) => {
    const names = [pkg, comm].filter(Boolean);
    const candidates: string[] = [];
    for (const dir of ["/Library/LaunchDaemons", `${env.home}/Library/LaunchAgents`]) {
      for (const f of await env.listDir(dir)) {
        const label = basename(f, ".plist");
        if (f.endsWith(".plist") && names.some((n) => label === n || label.endsWith(`.${n}`))) candidates.push(`${dir}/${f}`);
      }
    }
    return candidates;
  };
  /**
   * Why a label found by its plist name is not proven to own this pid ("" when it is): launchd must
   * run exactly this pid under it, and the pid's executable (its first txt map) must be a file of the keg.
   */
  const unproven = async (label: string, target: string, pid: string, keg: string) => {
    const shown = await ask(["launchctl", "print", target]);
    if (shown === undefined || parsePrint(shown).pid !== pid) return `launchd does not run pid ${pid} under it`;
    const exe = exePath(maps, pid);
    if (!exe?.startsWith(`${keg}/`)) return `pid ${pid} runs ${exe ?? "an unknown executable"}, not a file of ${basename(keg)}`;
    return "";
  };
  /** The restart of one label; the restart helper (it takes a package) only for a name-matched label. */
  const restart = async (pkg: string, label: string, system: boolean, helper: boolean, pid: string, keg: string) => {
    const target = system ? `system/${label}` : `gui/${env.uid}/${label}`;
    const done = restarted.get(target);
    if (done) {
      // Every keg the target maps keeps its association: a release check's keg needs the owner
      // queued for it (restarted inline), whatever the first keg on this target made of it.
      const own = await retiredOwner(pkg, label, target, helper, pid, keg);
      if (own) {
        own.record(pkg);
        return;
      }
      log.push(`    ${target} already ${done.said} this run`);
      done.record(pkg);
      return;
    }
    const out = await restartOnce(pkg, label, target, system, helper, pid, keg);
    restarted.set(target, out);
    out.record(pkg);
  };
  const ownerHanded = (by: string, label: string): Outcome => ({
    said: `handed to ${by}`,
    record: (p) => {
      addNote(`STALE KEG: ${p} handed to ${by} (${label})`, p);
      add(handed, p);
    },
  });
  const nothing = (said: string): Outcome => ({ said, record: () => {} });
  const restartedOutcome = (target: string): Outcome => ({ said: "restarted", record: (p) => mark(p, "restarted", target) });
  /**
   * A target already handled this run, met again on a keg a release check keeps: its owner is queued
   * for this keg too (once per target and keg). Undefined when the label is no owner or the keg is not one.
   */
  const retiredOwner = async (pkg: string, label: string, target: string, helper: boolean, pid: string, keg: string): Promise<Outcome | undefined> => {
    if (!isRetired(keg) || !matchOwner(o.staleOwners, label)) return undefined;
    if (ownerQueue.some((q) => q.target === target && q.keg === keg)) return undefined;
    return queueOwner(pkg, label, target, helper, pid, keg);
  };
  /** An owner restarted at an idle moment: queued for the waiter (a release check's, inline); undefined when the label is no owner. */
  const queueOwner = async (pkg: string, label: string, target: string, helper: boolean, pid: string, keg: string): Promise<Outcome | undefined> => {
    const owner = matchOwner(o.staleOwners, label);
    if (owner) {
      // A release check's owner (on a retired keg) is restarted inline whatever an earlier run's restart did.
      if (o.ownerFailed?.has(label) && !isRetired(keg)) {
        log.push(`    ${pkg}: ${label} restart FAILED earlier — not retried`);
        return { said: "failed earlier", record: (p) => mark(p, "failed", target) };
      }
      // A label found by the plist name (helper) is not proven to own this pid: queue it only when
      // launchd shows the label running exactly this pid, else it may be an unrelated service.
      if (helper) {
        const shown = await ask(["launchctl", "print", target]);
        if (shown === undefined || parsePrint(shown).pid !== pid) {
          log.push(`    ${label} matched by plist name, but launchd does not run pid ${pid} under it — reported as an orphan`);
          return { said: "reported as an orphan", record: (p) => mark(p, "orphans", pid) };
        }
      }
      if (o.dryRun) {
        log.push(`    dry-run: would queue ${target} for an idle restart`);
        return nothing("said it would queue");
      }
      ownerQueue.push({ label, target, pid, keg, ...(owner.probe ? { probe: owner.probe } : {}), ...(owner.health ? { health: owner.health } : {}),
        ...(owner.restart ? { restart: owner.restart } : {}), ...(owner.healthWithinSec ? { healthWithinSec: owner.healthWithinSec } : {}) });
      log.push(`    ${pkg}: ${label} queued for an idle restart`);
      const c: Category = o.ownerBusy?.has(label) ? "busy" : "waiting";
      return { said: "queued for an idle restart", record: (p) => mark(p, c, target) };
    }
    return undefined;
  };
  /** Makes the restart; returns how a package on this target is accounted for. */
  const restartOnce = async (pkg: string, label: string, target: string, system: boolean, helper: boolean, pid: string, keg: string): Promise<Outcome> => {
    // An owner restarted at an idle moment: queued for the waiter, before any other policy.
    const owned = await queueOwner(pkg, label, target, helper, pid, keg);
    if (owned) return owned;
    const policy = Object.hasOwn(o.labelRestart ?? {}, label) ? o.labelRestart![label] : undefined;
    if (policy === "skip") {
      log.push(o.dryRun ? `    dry-run: would leave ${target} to its owner` : `    ${pkg}: ${label} restart left to its owner`);
      return { said: "left to its owner", record: (p) => mark(p, "left", target) };
    }
    if (policy === undefined && o.staleKegUnlisted === "report") {
      log.push(o.dryRun ? `    dry-run: would report ${target} only (not on the restart list)` : `    ${pkg}: ${label} not on the restart list — reported only`);
      return { said: "reported only", record: (p) => mark(p, "reported", target) };
    }
    if (policy !== undefined && policy !== "kickstart") {
      const by = basename(policy[0] ?? "");
      // Step 2 already handed this label to its owner this run: never a second spawn.
      const earlier = o.ownerHanded?.get(label);
      if (earlier !== undefined) {
        log.push(`    ${label} was handed to ${earlier} by the restart step this run`);
        return ownerHanded(earlier, label);
      }
      if (o.dryRun) {
        log.push(`    dry-run: would hand ${label} to ${by}`);
        return nothing(`said it would hand to ${by}`);
      }
      if (isStopping()) {
        log.push(`    ${label} not handed to ${by}: oupdate is stopping`);
        return { said: `not handed to ${by}`, record: (p) => addNote(`STALE KEG: ${p} not handed to ${by} (${label}): oupdate is stopping`) };
      }
      try {
        if (!env.spawnDetached || !o.detachedLog) throw new Error("no detached spawn here");
        // Not waited for: the next run's stale-keg check shows whether it worked. Until a run finds
        // the package gone, its note keeps the word a status reader counts.
        await env.spawnDetached([...policy, label], o.detachedLog);
        log.push(`    handed ${label} to ${by}`);
        return ownerHanded(by, label);
      } catch (e) {
        log.push(`    ${label} could not be handed to ${by} (${e instanceof Error ? e.message : String(e)})`);
        return { said: `failed to hand to ${by}`, record: (p) => add(unresolved, `${p}(${label} handoff to ${by} failed)`) };
      }
    }
    if (system) {
      let kicked = false;
      if (o.dryRun) {
        log.push(`    dry-run: would kickstart ${target}`);
        kicked = true;
      } else {
        if (helper && o.restartHelper?.packages.includes(pkg) && (await env.exists(o.restartHelper.path))) {
          if ((await env.exec(["sudo", "-n", o.restartHelper.path, pkg])).rc === 0) {
            log.push(`    restarted ${target} (via ${basename(o.restartHelper.path)})`);
            kicked = true;
          }
        }
        if (!kicked && (await env.exec(["sudo", "-n", "launchctl", "kickstart", "-k", target])).rc === 0) {
          log.push(`    restarted ${target}`);
          kicked = true;
        }
      }
      if (kicked) return o.dryRun ? nothing("said it would kickstart") : restartedOutcome(target);
      log.push(`    cannot restart unattended — run: sudo launchctl kickstart -k ${target}`);
      return { said: "failed to restart", record: (p) => add(unresolved, `${p}(${target})`) };
    }
    if (o.dryRun) {
      log.push(`    dry-run: would kickstart ${target}`);
      return nothing("said it would kickstart");
    }
    if ((await env.exec(["launchctl", "kickstart", "-k", target])).rc === 0) {
      log.push(`    restarted ${target}`);
      return restartedOutcome(target);
    }
    log.push(`    cannot restart — run: launchctl kickstart -k ${target}`);
    return { said: "failed to restart", record: (p) => add(unresolved, `${p}(gui/${label})`) };
  };

  // The plist-name fallback and its operator notes are once per package; launchd lookups per pid.
  const nameDone = new Set<string>();
  /** One stale holder handled; returns early once it is accounted for. */
  const handle = async (h: Holder) => {
    const retired = isRetired(h.keg);
    if (!retired && (await env.isDir(h.keg))) return; // keg still on disk: not stale
    const comm = basename(await ps("comm", h.pid));
    const cmd = await ps("command", h.pid);
    const staleLine = `  STALE KEG: ${h.pkg} — pid ${h.pid} (${cmd || "?"}) still running from ${basename(h.keg)}, ${retired ? "a keg a release check retires (its owners must leave it)" : "which no longer exists"}`;
    if (await isSelf(h.pid)) {
      // Restarting it would stop this run part-way; the next run starts on the new keg.
      log.push(staleLine, `    ${h.pkg}: pid ${h.pid} is this oupdate run — restarts with its next run`);
      leftAlone.add(pair(h.pid, h.pkg));
      return;
    }
    // A deferred service goes to its handoff whichever stale keg pins it: its own, or a
    // dependency keg it maps. The handoff is told which service matched. One handoff per service
    // per run; another process on the same dependency keg is still handled below.
    const svc = o.deferred.find((d) => d !== "" && (h.pkg === d || (comm !== "" && comm.includes(d))));
    if (svc !== undefined) {
      add(stale, h.pkg);
      add(handed, h.pkg);
      log.push(staleLine);
      if (deferredHanded.has(svc)) log.push("    already handed to the waiter this run");
      else {
        const n = await o.handoff(h.keg, svc);
        if (n) addNote(n);
        deferredHanded.add(svc);
      }
      return;
    }
    const ppid = (await ps("ppid", h.pid)).trim();
    log.push(staleLine);
    // On a release check's keg an unread parent is no answer (the process may be its owner's child):
    // unresolved, never left alone.
    if (retired && !isPid(ppid)) {
      log.push(`    parent of pid ${h.pid} could not be read — not resolved`);
      add(stale, h.pkg);
      add(unresolved, `${h.pkg}(parent unreadable)`);
      return;
    }

    // A job's main pid has launchd as its parent: only then can its pid name the job (any other
    // match would be pid reuse).
    if (ppid === "1") {
      const ld = await launchdLabel(h.pid);
      if (ld === "ambiguous") {
        add(stale, h.pkg);
        add(unresolved, `${h.pkg}(ambiguous label)`);
        return;
      }
      if (ld) {
        log.push(`    label ${ld.label} (from launchctl, pid ${h.pid})`);
        add(stale, h.pkg);
        await restart(h.pkg, ld.label, ld.system, false, h.pid, h.keg);
        return;
      }
      // No launchd job of its own: a job runner's detached job (live work, it ends on its own)
      // is named, never restarted, not by a plist name either.
      const job = runnerJob(cmd, o.jobRunners ?? []);
      if (job !== undefined) {
        log.push(`    runner job ${job} (pid ${h.pid}) — not restarted, it ends on its own`);
        add(stale, h.pkg);
        mark(h.pkg, "jobs", `${job} (pid ${h.pid})`);
        return;
      }
    }

    if (ppid !== "1") {
      // A process launchd did not start (a shell's bun, say) is never restarted, not by a plist
      // name either: that would bounce an unrelated job. It resolves itself. A launchd job among
      // its parents is named for a look, never restarted through the chain (it may be a terminal
      // or ssh session).
      // Only a DIRECT child of a job's own pid counts (the wrapper case: a plist runs a shell that
      // runs the binary). A deeper chain (a shell in a session under some daemon) is logged only.
      let parent: { label: string; system: boolean } | undefined;
      for (const a of (await ancestry(ppid)).slice(0, 16)) {
        if (await isSelf(a)) break;
        const ld = await launchdLabel(a);
        if (ld === "ambiguous") break;
        if (ld) {
          if (a === ppid) {
            log.push(`    child of ${ld.label} (pid ${a}) — needs a look`);
            parent = ld;
          } else log.push(`    child of ${ld.label} via pid ${a} — not counted`);
          break;
        }
      }
      // On a release check's keg, launchd unread is no answer (the parent may be its owner's job):
      // unresolved, never left alone.
      if (parent === undefined && retired && (await launchdUnread())) {
        log.push(`    launchd's services could not be read for pid ${h.pid}'s parents — not resolved`);
        add(stale, h.pkg);
        add(unresolved, `${h.pkg}(launchd unreadable)`);
        return;
      }
      if (parent === undefined) {
        leftAlone.add(pair(h.pid, h.pkg)); // an interactive process, or deeper under a job
        return;
      }
      add(stale, h.pkg);
      // The job's restart this run (step 2's owner handoff, or this step's own outcome) covers its child.
      const target = parent.system ? `system/${parent.label}` : `gui/${env.uid}/${parent.label}`;
      const byOwner = o.ownerHanded?.get(parent.label);
      const done = byOwner !== undefined ? ownerHanded(byOwner, parent.label) : restarted.get(target);
      // Its job handled for another keg: a release check's keg still needs the job queued for it.
      const own = done && byOwner === undefined ? await retiredOwner(h.pkg, parent.label, target, false, ppid, h.keg) : undefined;
      if (own) {
        log.push(`    its job ${target} is queued for this keg too`);
        own.record(h.pkg);
        return;
      }
      if (done) {
        log.push(`    its job ${target} was already ${done.said} this run`);
        done.record(h.pkg);
        return;
      }
      // Never restarted through the chain: named, noticed and counted toward stuck.
      add(unresolved, `${h.pkg}(child of ${parent.label})`);
      return;
    }
    const candidates = await byName(h.pkg, comm);
    add(stale, h.pkg);
    if (candidates.length === 0) {
      // An orphan: no job, no plist. Named with its pid, never restarted.
      mark(h.pkg, "orphans", h.pid);
      if (nameDone.has(h.pkg)) return;
      nameDone.add(h.pkg);
      log.push("    launchd-owned (ppid 1) but no matching plist — label needs a look");
      add(unresolved, `${h.pkg}(no label found)`);
      return;
    }
    if (nameDone.has(h.pkg)) {
      log.push("    already handled by the plist name this run");
      return;
    }
    nameDone.add(h.pkg);
    if (candidates.length > 1) {
      log.push(`    ambiguous — ${candidates.map((p) => basename(p)).join(" ")} all match; not guessing`);
      add(unresolved, `${h.pkg}(ambiguous label)`);
      return;
    }
    const plist = candidates[0]!;
    const label = basename(plist, ".plist");
    const system = plist.startsWith("/Library/LaunchDaemons/");
    const why = await unproven(label, system ? `system/${label}` : `gui/${env.uid}/${label}`, h.pid, h.keg);
    if (why) {
      log.push(`    ${label} matched by plist name, but ${why} — reported as an orphan`);
      mark(h.pkg, "orphans", h.pid);
      return;
    }
    log.push(`    label ${label} (from the plist name)`);
    await restart(h.pkg, label, system, true, h.pid, h.keg);
  };
  for (const h of held) {
    const before = misses;
    await handle(h);
    if (misses > before) unresolvedKegs.add(h.keg);
  }

  if (ownerQueue.length && !o.dryRun) {
    let n: string;
    try {
      if (!o.queueOwners) {
        n = `owner restart waiter FAILED: not wired here, ${ownerQueue.map((q) => q.label).join(" ")} not queued`;
        for (const q of ownerQueue) unresolvedKegs.add(q.keg);
      } else n = await o.queueOwners(ownerQueue);
    } catch (e) {
      n = `owner restart waiter FAILED (${e instanceof Error ? e.message : String(e)})`;
      // Not known to be queued: no owner of these kegs is known to restart.
      for (const q of ownerQueue) unresolvedKegs.add(q.keg);
    }
    if (n) addNote(n);
  }

  if (!stale.length) return { note: "", log, unresolved: unresolvedKegs };
  const handoffNote = handoffNotes.map((n) => n.text).join("; ");
  if (o.dryRun) return { note: handoffNote, log, unresolved: unresolvedKegs };

  // Verify rather than assume: a kickstart of the wrong label is a silent no-op.
  const again = await lsofMaps(env, o.lsof, log, strict);
  if (again === undefined) {
    const failed = `STALE-KEG CHECK FAILED: lsof unusable on re-scan (${o.lsof})`;
    log.push(`  ${failed}`);
    // The handoff already happened: it stays in the note.
    return { note: handoffNote ? `${failed}; ${handoffNote}` : failed, log, unresolved: unresolvedKegs };
  }
  const still: string[] = [];
  for (const h of kegHolders(again, cellar)) {
    if (leftAlone.has(pair(h.pid, h.pkg)) || (!isRetired(h.keg) && (await env.isDir(h.keg)))) continue;
    if (stale.includes(h.pkg)) add(still, h.pkg);
  }
  // A handed-off package is expected to still be stale (its handoff owns it), so it is not an
  // alarm, unless another process on it was unresolved, left to its owner or reported only. It still
  // counts toward stuck.
  const unhanded = still.filter((p) => !handed.includes(p) || marks.has(p) || unresolved.some((u) => u.startsWith(`${p}(`)));
  const resolved = stale.filter((p) => !still.includes(p));
  const stuck = o.trackStuck(still);
  let note = "";
  if (unhanded.length) {
    // Every outcome of the package, counted: none masks another. No ";" inside, the summary parser splits there.
    const named = unhanded.map((p) => {
      const m = marks.get(p);
      const parts = m ? CATEGORIES.filter((c) => m.has(c)).map((c) => describeOutcome(c, [...m.get(c)!])) : [];
      return parts.length ? `${p}(${parts.join(", ")})` : p;
    });
    note = `STALE KEG: ${named.join(" ")} still running from a deleted keg`;
    await send(o, log, `⚠️ <b>${o.host} stale keg</b>\n${unhanded.join(" ")} is serving from a Cellar path brew deleted.\n${unresolved.length ? `Needs an operator: ${unresolved.join(" ")} ` : ""}`);
  }
  if (resolved.length) {
    log.push(`  stale-keg: resolved by restart: ${resolved.join(" ")}`);
    note = `${note ? `${note}; ` : ""}restarted onto new keg: ${resolved.join(" ")}`;
  }
  // An owner's handoff for a package the re-scan found gone is done: "restarted onto new keg" says so.
  const kept = handoffNotes.filter((n) => n.pkg === undefined || !resolved.includes(n.pkg)).map((n) => n.text).join("; ");
  if (kept) note = `${note ? `${note}; ` : ""}${kept}`;
  if (stuck.length) note = `${note} [${stuck.join(" ")} ]`;
  return { note, log, unresolved: unresolvedKegs };
}

/** `brew linkage --test` over every installed formula: a dependent left linking a removed dylib is named and alerted. */
export async function linkageCheck(env: KegEnv, o: Pick<KegOptions, "brew" | "host" | "logFile" | "notify" | "log">): Promise<{ note: string; log: string[] }> {
  const log: string[] = o.log ?? [];
  const list = await env.exec([o.brew, "list", "--formula"]);
  if (list.rc === 127) return { note: "", log }; // no brew on this host: nothing to check
  if (list.rc !== 0) {
    const note = "LINKAGE CHECK FAILED: brew list --formula failed, linkage not checked";
    log.push(`  ${note}`);
    return { note, log };
  }
  const formulae = words(list.out);
  if (!formulae.length) return { note: "", log };
  const r = await env.exec([o.brew, "linkage", "--test", ...formulae]);
  if (r.rc === 0) return { note: "", log };
  const out = `${r.out}${r.err}`;
  const bad = new Set<string>();
  let f = "";
  for (const line of out.split("\n")) {
    const m = line.match(/^==> Checking (\S+).* linkage/);
    if (m) {
      f = m[1]!;
      continue;
    }
    if (/^(Missing libraries|Broken dependencies):/.test(line) && f) bad.add(f);
  }
  const names = [...bad].sort().join(" ");
  const note = `LINKAGE FAILED: ${names || "brew linkage --test (unparsed, see log)"}; fix: brew reinstall --build-from-source <formula>`;
  log.push(`  ${note}`);
  const lines = out.split("\n");
  const excerpt: string[] = [];
  lines.forEach((l, i) => {
    if (/^(==> Checking|Missing libraries|Broken dependencies)/.test(l)) for (const x of lines.slice(i, i + 5)) if (!/^==> Checking .* linkage$/.test(x)) excerpt.push(`    ${x}`);
  });
  log.push(...excerpt.slice(0, 40));
  try {
    await o.notify(`⚠️ <b>${o.host} brew: broken linkage</b>\n${names || "see log"}: a library they link was upgraded away. Fix: brew reinstall --build-from-source <formula>\nLog: ${o.logFile ?? ""}`);
  } catch {
    log.push("  the notice could not be sent");
  }
  return { note, log };
}

/**
 * Formulae this run upgraded that brew left unlinked (an interrupted upgrade): relinked before any
 * restart, so a daemon is not restarted onto a missing symlink. Only this run's upgrades, never a
 * keg a host keeps unlinked on purpose; keg-only formulae are skipped.
 */
export async function relinkUpgraded(env: KegEnv, pkgs: string[], o: Pick<KegOptions, "brew" | "log">): Promise<{ note: string; log: string[] }> {
  const log: string[] = o.log ?? [];
  if (!pkgs.length) return { note: "", log };
  const p = await env.exec([o.brew, "--prefix"]);
  if (p.rc !== 0) return { note: "", log };
  const linkdir = `${p.out.trim()}/var/homebrew/linked`;
  if (!(await env.isDir(linkdir))) return { note: "", log };
  let kegOnly = new Set<string>();
  const info = await env.exec([o.brew, "info", "--json=v2", ...pkgs]);
  try {
    const d = JSON.parse(info.out) as { formulae?: { name?: string; keg_only?: boolean }[] };
    kegOnly = new Set((d.formulae ?? []).filter((f) => f?.keg_only).map((f) => f.name ?? ""));
  } catch {
    kegOnly = new Set();
  }
  const relinked: string[] = [];
  const failed: string[] = [];
  for (const pkg of pkgs) {
    if (kegOnly.has(pkg)) continue;
    if (await env.exists(`${linkdir}/${pkg}`)) continue;
    log.push(`  ${pkg}: upgraded but NOT linked — relinking before restart`);
    if ((await env.exec([o.brew, "link", pkg])).rc === 0 && (await env.exists(`${linkdir}/${pkg}`))) {
      relinked.push(pkg);
      continue;
    }
    // The prefix symlink can survive while brew's linked/ record is gone; brew link then refuses.
    // unlink only touches this formula's own symlinks. Never --overwrite: it clobbers other formulae.
    if ((await env.exec([o.brew, "unlink", pkg])).rc === 0 && (await env.exec([o.brew, "link", pkg])).rc === 0 && (await env.exists(`${linkdir}/${pkg}`))) {
      log.push("    (cleared a stale prefix symlink first)");
      relinked.push(pkg);
    } else failed.push(pkg);
  }
  const note = failed.length ? `UNLINKED KEG: brew link failed for ${failed.join(" ")}` : relinked.length ? `relinked after upgrade: ${relinked.join(" ")}` : "";
  if (note) log.push(`  ${note}`);
  return { note, log };
}
