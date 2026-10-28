// The host apply run, ported from the previous updater's host script: the brew phase, then the npm phase,
// then one summary block in that updater's own format ("=== <host> summary ===", "  brew: ...",
// "  npm:  ..."), so the host shadow parser (src/host/prev-log.ts) and any log reader read it
// unchanged, then the end-of-run notice.
//
// Order: waiter report → brew (update → outdated → excludes and pins → tap tiers → Type A review
// → Type A upgrades → Type B) → relink and restarts → cleanup → deferred casks with Gatekeeper
// (snapshot before each upgrade; release, then check after it) → stale keg → release checks →
// linkage → stuck → npm. A formula with a release check (release-checks.ts) keeps its previous
// keg through the upgrade, its owner is restarted inline after the stale-keg check (which retires
// every keg of the formula but the one the check expects), then its check decides; the pre-check
// gate (release-checks.ts) scans the formula's kegs right before every check.
//
// Fail closed: a failed query is a FAILED entry, an unusable state file is reported, an
// unavailable reviewer holds what it was asked about. A command that times out is a FAILED entry
// ("timeout:<command>", or the package for an upgrade), that step stops, and the run goes on to
// the next. Progress is recorded as it happens, so what a stopped step already upgraded is still
// reported, relinked, restarted and cleaned up. Every log line goes to opts.onLine as it is made.
//
// A dry run runs every check and changes nothing on disk: no brew update, no HEAD fetch, no
// upgrade, restart, cleanup, waiter start or state write, and every notice is logged, never sent.
// Its header and summary block are named so neither parser takes it for a run.
//
// Not ported here (each held or reported, never silently skipped): the HEAD-install review
// (typeb.ts holds a HEAD install), the source-diff review (typeb.ts holds a source-built package),
// the deferred service's build-toolchain preflight, the pip CA bridge around brew install, the
// browser-specific dequarantine (the Gatekeeper release covers casks generally), the tap revision
// log lines and the App Store phase ("not checked" in the summary).
//
// The Claude Code native update (the previous updater's Claude step) runs in the npm phase after npm,
// when apply.claudeCode names an executable binary.

import { realpathSync } from "node:fs";
import { DEFAULT_COMPAT } from "../targets/compat.ts";
import { basename, dirname, join } from "node:path";
import { appBundleUpgrade, realAppNet, type AppNet } from "./appbundle.ts";
import { isStopping as execStopping, onStop } from "./exec.ts";
import type { Reviewer } from "../review.ts";
import { makeReviewer } from "../adapters/reviewer/spec.ts";
import type { ApplyConfig } from "./config.ts";
import type { Exec } from "./exec.ts";
import type { BrewFormulaInfo } from "./formula.ts";
import type { ApplyFs } from "./fs.ts";
import { gkCheck, gkRelease, gkRevert, gkSnapshot, realGates, type GkEnv, type GkOptions, type GkPrior } from "./gatekeeper.ts";
import { caskRunning, kegHolders, linkageCheck, lsofMaps, relinkUpgraded, staleKegCheck, type Holder, type KegEnv } from "./kegs.ts";
import { npmSection, type NpmRun } from "./npm.ts";
import { matchOwner, ownerDir, ownerFiles, ownerOps, ownerWaiterReport, queueOwners, realHttpStatus, realReleaseLock, realTakeLock, type OwnerReport, type OwnerWaiterEnv, type QueuedOwner } from "./owner-waiter.ts";
import { asUser, brewView, resume, findCheck, shortName, holdFailed, holdPath, holdState, loadPending, pendingPath, readHold, runHook, savePending, trustState, type PendingCheck, type ReleaseEnv } from "./release-checks.ts";
import { heldFromPinned, pinFilter } from "./pins.ts";
import { restartUpgraded } from "./restarts.ts";
import { pendingFromOutdated, trackStuck } from "./stuck.ts";
import { loadApprovedTaps, outdatedVersions, tapIn } from "./taps.ts";
import { typeAReview } from "./typea.ts";
import { awaitingTapApproval, typeBUpgrades, type TypeBEnv, type TypeBOptions, type TypeBRun } from "./typeb.ts";
import { handoff, waiterReport, type DeferredService, type WaiterEnv } from "./waiter.ts";

/** The Gatekeeper steps of the cask phase; the real ones read the Caskroom. */
export interface GkOps {
  snapshot(cask: string): Promise<GkPrior>;
  release(cask: string, prior: GkPrior): Promise<string[]>;
  check(cask: string): Promise<{ note: string; log: string[] }>;
}

export interface ApplyOptions {
  dryRun: boolean;
  /** Default: the config's reviewer; none configured is an unavailable reviewer (everything it would judge is held). */
  reviewer?: Reviewer;
  now?: Date;
  /** True once a signal is stopping oupdate: the done notice is not sent. */
  isStopping?: () => boolean;
  /** Every line of the run, the summary block included, as it is produced. */
  onLine?: (line: string) => void;
  /** Test seams, as the previous updater's tests mocked these functions. */
  gk?: GkOps;
  typeB?: { upgrades: typeof typeBUpgrades; awaiting: typeof awaitingTapApproval };
  /** The app-bundle phase's network and file operations. */
  appNet?: AppNet;
  /** Starts the owner restart waiter (`oupdate host --stale-owners-waiter`), set by the CLI; absent: staleOwners jobs are queued, not started. */
  ownerWaiterArgv?: string[];
  /** The clock and health fetch of a release check's inline owner restart (default: real). */
  ownerClock?: { now(): number; sleep(ms: number): Promise<void>; httpStatus(url: string): Promise<number> };
  /** The owner waiter's lock, taken around a release check's inline restarts and checks (default: the real flock). */
  ownerLock?: { take(path: string): Promise<boolean>; release(path: string): Promise<void> };
  /** This run's bun binary (default: process.execPath). Homebrew's bun formula is held out of the upgrade set. */
  bunExec?: string;
  /** The previous updater's name the run header and done notice keep (compat.ts; default host-update). */
  previousUpdater?: string;
  /** Job runner commands when the config names none (compat.ts). */
  jobRunners?: readonly string[];
}

export interface ApplyResult {
  /** The run body, as the previous updater logged it, and the end-of-run notice after the summary. */
  log: string[];
  /** The summary block. */
  summary: string[];
  rc: 0 | 1;
}

class PhaseTimeout extends Error {}

const p2 = (n: number) => String(n).padStart(2, "0");
const day = (d: Date) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
const words = (s: string) => s.split(/\s+/).filter(Boolean);
/**
 * `brew deps` flags for what an upgrade may install: the candidate's declared dependencies (any flag
 * here turns off the installed keg's runtime list), recursive, with build (a source build) and
 * optional (an install's --with options) ones.
 */
const DECLARED_DEPS = ["--include-build", "--include-optional"];
/** A formula or cask name, bare or tap-qualified, as `brew deps` lists it. */
const PKG_NAME = /^[\w@.+-]+(\/[\w@.+-]+){0,2}$/;
const uniq = (xs: string[]) => [...new Set(xs)];
const last = (n: string) => n.split("/").at(-1)!;

/**
 * True when `execPath` is Homebrew's bun formula: a Cellar keg, or the stable bin link that
 * resolves into one. A host run that upgrades that formula replaces the binary it is running.
 */
export function runsUnderBrewBun(execPath: string): boolean {
  let path = execPath;
  try {
    path = realpathSync(execPath);
  } catch {
    // Not on disk (a test path, or a keg already removed): judge the path as given.
  }
  const segs = path.split("/");
  const i = segs.lastIndexOf("Cellar");
  return i >= 0 && segs[i + 1] === "bun";
}

/** Drops formulae named bun when this process is that Homebrew formula. */
export function holdRunningBun(names: string[], execPath: string): { kept: string[]; held: string[] } {
  if (!runsUnderBrewBun(execPath)) return { kept: names, held: [] };
  const held: string[] = [];
  const kept: string[] = [];
  for (const n of names) (last(n) === "bun" ? held : kept).push(n);
  return { kept, held };
}

/** A name is listed when an entry equals it or their last path segments are equal (bare or tap-qualified, literal). */
/**
 * The FAILED entry for a command that timed out: the package for an upgrade (a brew name by its
 * last segment, an npm name whole), else "timeout:<program>[-<subcommand>]", looking through
 * `sudo -n` and `git -C <dir>`.
 */
export function timeoutToken(argv: string[]): string {
  let a = [...argv];
  if (basename(a[0] ?? "") === "sudo") {
    a = a.slice(1);
    while (a[0]?.startsWith("-")) a = a.slice(1);
  }
  const prog = basename(a[0] ?? "?");
  let rest = a.slice(1);
  if (prog === "git" && rest[0] === "-C") rest = rest.slice(2);
  if (prog === "brew" && rest[0] === "upgrade") return last(rest.at(-1) ?? "?");
  if (prog === "npm" && rest[0] === "update") return rest.at(-1) ?? "?";
  // install -g <name>@<version>: the name without its version (a scope's leading @ kept).
  if (prog === "npm" && rest[0] === "install") return (rest.at(-1) ?? "?").replace(/(?<=.)@[^@/]*$/, "");
  const sub = ["brew", "git", "npm", "launchctl", "claude"].includes(prog) ? rest.find((x) => !x.startsWith("-")) : undefined;
  return `timeout:${prog}${sub ? `-${sub}` : ""}`;
}

export const named = (entries: Iterable<string>, name: string) => {
  for (const e of entries) if (e === name || last(e) === last(name)) return true;
  return false;
};

const unavailable: Reviewer = {
  name: "none",
  review: async () => {
    throw new Error("no reviewer configured");
  },
};

/** Logs a notice's first line and sends it through the config's notify command; a dry run only logs. */
export function makeNotify(cfg: ApplyConfig, exec: Exec, dryRun: boolean, log: string[]) {
  return async (text: string) => {
    const plain = text.replace(/<\/?b>/g, "");
    const first = plain.split("\n")[0]!;
    if (dryRun) {
      log.push(`[dry-run — not notified] ${first}`);
      return;
    }
    log.push(`[notify] ${first}`);
    if (!cfg.notify?.length) return;
    const r = await exec([...cfg.notify, plain], { timeoutMs: 60_000 });
    if (r.rc !== 0) log.push("  the notice could not be sent");
  };
}

/** The real Gatekeeper env, or undefined when brew cannot say where the Caskroom and prefix are. */
async function gkEnv(cfg: ApplyConfig, exec: Exec): Promise<GkEnv | undefined> {
  const q = async (arg: string) => {
    const r = await exec([cfg.brew, arg]);
    return r.rc === 0 ? r.out.trim() : "";
  };
  const caskroom = await q("--caskroom");
  const prefix = await q("--prefix");
  if (!caskroom.startsWith("/") || !prefix.startsWith("/")) return undefined;
  return { exec, caskroom, prefix, stateDir: cfg.stateDir, ...realGates(exec) };
}

/** Gatekeeper steps that say they could not run: the cask still upgrades, its note says unchecked. */
const gkUnchecked: GkOps = {
  snapshot: async () => ({ prior: "unknown", team: "" }),
  release: async (cask) => [`  ${cask}: Gatekeeper not checked — brew --caskroom / --prefix unreadable; quarantine kept`],
  check: async (cask) => ({ note: `${cask}: not checked`, log: [] }),
};

/**
 * The operator's one-offs: release a cask nobody ever approved, or put back what a release
 * removed. rc 1 when nothing was released or restored.
 */
export async function gatekeeperAction(cfg: ApplyConfig, exec: Exec, action: "approve" | "revert", cask: string): Promise<{ lines: string[]; rc: 0 | 1 }> {
  const count = (lines: string[], re: RegExp) => lines.reduce((n, l) => n + Number(l.match(re)?.[1] ?? 0), 0);
  if (action === "revert") {
    const lines = await gkRevert({ exec, caskroom: "", prefix: "", stateDir: cfg.stateDir, ...realGates(exec) }, cask);
    return { lines, rc: count(lines, /restored quarantine on (\d+) file/) > 0 ? 0 : 1 };
  }
  const env = await gkEnv(cfg, exec);
  if (!env) return { lines: [`  ${cask}: cannot resolve brew --caskroom / --prefix — nothing released`], rc: 1 };
  const lines: string[] = [];
  const o: GkOptions = { dryRun: false, host: cfg.host, logFile: cfg.logFile, notify: makeNotify(cfg, exec, false, lines) };
  const released = await gkRelease(env, cask, o, "approve");
  lines.push(...released);
  if (!released.length) lines.push(`  ${cask}: nothing quarantined to approve`);
  const c = await gkCheck(env, cask, o);
  lines.push(...c.log);
  return { lines, rc: count(released, /Gatekeeper — released (\d+) file/) > 0 ? 0 : 1 };
}

export async function applyHost(cfg: ApplyConfig, exec: Exec, fs: ApplyFs, opts: ApplyOptions): Promise<ApplyResult> {
  const { dryRun } = opts;
  const now = opts.now ?? new Date();
  const today = day(now);
  const host = cfg.host;
  const r = opts.reviewer ?? (cfg.reviewer ? makeReviewer(cfg.reviewer) : unavailable);
  const tb = opts.typeB ?? { upgrades: typeBUpgrades, awaiting: awaitingTapApproval };

  // Streamed: every line reaches the sink as it is pushed, so a run that hangs or is killed still
  // leaves its log behind.
  const log: string[] = [];
  const sink = opts.onLine;
  if (sink) {
    const push = log.push.bind(log);
    log.push = (...xs: string[]) => {
      for (const l of xs) sink(l);
      return push(...xs);
    };
  }
  const stamp = `${today} ${p2(now.getHours())}:${p2(now.getMinutes())}`;
  // A dry run's header does not carry the updater name, so the shadow parser never takes it for a run.
  const prevName = opts.previousUpdater ?? DEFAULT_COMPAT.previousUpdater;
  log.push(dryRun ? `=== oupdate dry run ${host} ${stamp} ===` : `=== oupdate-${prevName} ${host} ${stamp} ===`);
  if (dryRun) log.push("dry run: every check runs; nothing is upgraded, restarted, cleaned or written, and notices are logged only");
  else if (cfg.notify === undefined) log.push("notify: not configured (apply.notify) — notices are logged here, never sent");

  // The brew phase's bookkeeping, kept outside each step so a step that stops part-way still reports.
  const b = {
    nothing: false,
    noBrew: false,
    started: false,
    sectionDone: false,
    flaggedAtSection: false,
    flagged: false,
    upgraded: [] as string[],
    failed: [] as string[],
    pinned: [] as string[],
    pinWarn: "",
    deferredCasks: [] as string[],
    caskTried: new Set<string>(),
    casksUp: [] as string[],
    casksFailed: [] as string[],
    casksSudo: [] as string[],
    casksRunning: [] as string[],
    gkNotes: [] as string[],
    restarted: [] as string[],
    fetchHead: !dryRun,
    unknownNote: "",
    headNote: "",
    relinkNote: "",
    waiterNote: "",
    staleNote: "",
    linkageNote: "",
    handoffNotes: [] as string[],
    stuck: [] as string[],
    appNotes: [] as string[],
    /** Release checks: one note per formula decided, and the held releases ("<formula> <version>") with their names as listed. */
    rcNotes: [] as string[],
    rcHeld: [] as string[],
    rcHeldNames: [] as string[],
    /** Formulae named bun held because this process is that Homebrew binary. */
    selfBun: [] as string[],
  };
  const brewHeld = () => [...cfg.caskExclude, ...heldFromPinned(b.pinned), ...b.selfBun.flatMap((n) => [n, last(n)]), ...b.rcHeldNames];
  const npmFailed: string[] = [];

  // Every command goes through here: brew never auto-updates, and a timeout is a FAILED entry of
  // the current phase (the package, for an upgrade) that stops the current step.
  // Labels the restart step handed to their owner command: the stale-keg check never hands them again.
  const ownerHanded = new Map<string, string>();
  let phase: "brew" | "npm" = "brew";
  const x: Exec = async (argv, o = {}) => {
    const env = argv[0] === cfg.brew ? { HOMEBREW_NO_AUTO_UPDATE: "1", ...o.env } : o.env;
    const res = await exec(argv, { ...o, ...(env ? { env } : {}), timeoutMs: o.timeoutMs ?? cfg.timeoutMs });
    if (res.timedOut) {
      const token = timeoutToken(argv[0] === cfg.brew ? ["brew", ...argv.slice(1)] : argv[0] === cfg.npm ? ["npm", ...argv.slice(1)] : argv);
      (phase === "brew" ? b.failed : npmFailed).push(token);
      log.push(`  TIMEOUT after ${o.timeoutMs ?? cfg.timeoutMs} ms: ${argv.join(" ")} — killed; ${phase} phase FAILED (${token})`);
      throw new PhaseTimeout();
    }
    return res;
  };
  const notify = makeNotify(cfg, exec, dryRun, log);
  const step = async (name: "brew" | "npm", label: string, f: () => Promise<void>) => {
    phase = name;
    try {
      await f();
    } catch (e) {
      if (!(e instanceof PhaseTimeout)) {
        const token = `error:${label.replaceAll(" ", "-")}`;
        (name === "brew" ? b.failed : npmFailed).push(token);
        log.push(`  ${label}: aborted (${e instanceof Error ? e.message : String(e)}) — ${name} phase FAILED (${token})`);
      }
      log.push(`phase ${name}: ${label} did not complete — continuing`);
    }
  };

  // Stuck state: read once, carried in memory, written once at the end (never in a dry run).
  const stuckFile = join(cfg.stateDir, "pending-state.tsv");
  let stuckState: string | undefined = "";
  if (!dryRun && (await fs.exists(stuckFile))) {
    stuckState = await fs.readFile(stuckFile);
    if (stuckState === undefined) log.push(`  WARNING: ${stuckFile} unreadable — stuck tracking off this run, the file is kept`);
  }
  let stuckDirty = false;
  let stuckBroken = false;
  const track = (lane: string, pending: string[]): string[] | undefined => {
    if (dryRun) return [];
    if (stuckState === undefined) {
      stuckBroken = true;
      return undefined;
    }
    const t = trackStuck(stuckState, lane, pending, { today, after: cfg.stuckAfter, exclude: cfg.caskExclude });
    stuckState = t.state;
    stuckDirty = true;
    if (t.stuck.length) log.push(`  STUCK [${lane}]: ${t.stuck.join(" ")} — pending ${cfg.stuckAfter}+ consecutive runs`);
    return t.stuck;
  };

  const waiterEnv: WaiterEnv = {
    // Not `x`: a timed-out --holder probe is an answer the handoff acts on (it hands off, as
    // the previous updater did), not a stop of the stale-keg step.
    exec: (argv, o = {}) => exec(argv, { ...o, timeoutMs: o.timeoutMs ?? cfg.timeoutMs }),
    exists: fs.exists,
    readFile: async (p) => {
      const t = await fs.readFile(p);
      if (t === undefined) throw new Error(`cannot read ${p}`);
      return t;
    },
    remove: fs.remove,
    mtimeDay: fs.mtimeDay,
    spawnDetached: fs.spawnDetached,
  };
  // The launchctl label queries: not `x` either, a timed-out query falls back to the plist name.
  const kegEnv: KegEnv = { exec: x, query: waiterEnv.exec, spawnDetached: fs.spawnDetached, isDir: fs.isDir, exists: fs.exists, listDir: fs.listDir, home: fs.home, uid: fs.uid };
  const tbEnv: TypeBEnv = {
    brew: async (args) => {
      const res = await x([cfg.brew, ...args]);
      return { rc: res.rc, out: res.out };
    },
    brewInfo: async (name) => {
      const res = await x([cfg.brew, "info", "--json=v2", name]);
      if (res.rc !== 0) return undefined;
      try {
        return (JSON.parse(res.out) as { formulae?: unknown[] }).formulae?.[0] as BrewFormulaInfo | undefined;
      } catch {
        return undefined;
      }
    },
    cellar: async (name) => {
      const res = await x([cfg.brew, "--cellar", name]);
      return res.rc === 0 ? res.out.trim() : "";
    },
    readFile: fs.readFile,
    git: async (dir, args) => {
      const res = await x(["git", "-C", dir, ...args]);
      return { rc: res.rc, out: res.out };
    },
  };
  const tbOpts: TypeBOptions = { officialTaps: cfg.officialTaps, host, logFile: cfg.logFile, notify, caps: cfg.caps, upstreamTaps: cfg.upstreamTaps };

  const brewFailed = async (name: string) => {
    b.failed.push(name);
    b.flagged = true;
    log.push(`  ${name}: FAILED — continuing`);
    await notify(`${host} brew FAILED: ${name}; log: ${cfg.logFile ?? "-"}`);
  };
  let quarantined: DeferredService | undefined;
  for (const s of cfg.deferred) if (!quarantined && (await fs.exists(s.quarantineFile))) quarantined = s;
  // A release check keeps its formula's previous keg: no install cleanup at all then (brew's periodic
  // cleanup after any upgrade would remove it too); the run's own cleanup step skips that formula.
  const installEnv = { HOMEBREW_NO_INSTALLED_DEPENDENTS_CHECK: "1", ...(quarantined || cfg.releaseChecks?.length ? { HOMEBREW_NO_INSTALL_CLEANUP: "1" } : {}) };

  // Release checks: the upgrades whose check has not decided (this run's and any a stopped run left),
  // and the staleOwners jobs of their previous kegs, restarted inline before the check.
  const rcEnv: ReleaseEnv = {
    exec: (argv, o = {}) => exec(argv, { ...o, ...(argv[0] === cfg.brew ? { env: { HOMEBREW_NO_AUTO_UPDATE: "1", ...o.env } } : {}), timeoutMs: o.timeoutMs ?? cfg.timeoutMs }),
    brew: cfg.brew, stateDir: cfg.stateDir, host, logFile: cfg.logFile,
    // Missing is the only "none": a state file or directory that is there but unread throws.
    readFile: fs.readState ?? (async (p) => {
      const t = await fs.readFile(p);
      if (t === undefined && (await fs.exists(p))) throw new Error(`cannot read ${p}`);
      return t;
    }),
    writeFile: fs.writeFile, remove: fs.remove, isDir: fs.isDir, listDir: fs.listState ?? fs.listDir,
    notify, log, stamp,
  };
  const rcPending = new Map<string, PendingCheck>();
  /** Formulae whose pending record is unreadable: held from upgrades, their kegs kept from cleanup. */
  const rcBroken: string[] = [];
  for (const p of await loadPending(rcEnv, log, rcBroken, (cfg.releaseChecks ?? []).map((c) => shortName(c.formula)))) rcPending.set(p.formula, p);
  const rcThisRun = new Set<string>();
  const rcJobs = new Map<string, QueuedOwner[]>();
  /** The stale-keg scan read the processes this run: without it an owner on the previous keg goes unseen. */
  let rcScanned = false;
  /** Kegs with a stale process the scan could not resolve to an owner: a check on one waits as if unscanned. */
  let rcUnresolved: ReadonlySet<string> = new Set();
  /** Owner jobs by target, the later ones added. */
  const mergeOwners = (a: readonly QueuedOwner[], add: readonly QueuedOwner[]) => [...a, ...add.filter((q) => !a.some((o) => o.target === q.target))];
  /** Removes a formula's registered stop task (its owed after). */
  const rcStopOff = new Map<string, () => void>();
  const stoppingNow = () => !!opts.isStopping?.() || execStopping();
  /**
   * after is owed: not run yet, and either the verdict says run (whether or not a before is
   * configured) or, with no verdict yet, before ran or the upgrade started (with no before: a run
   * that dies before its verdict still runs after). A "skip" verdict owes none.
   */
  const afterOwed = (p: PendingCheck) => !p.afterRan && p.after !== "skip" && (p.beforeRan || !!p.upgradeStarted || p.after === "run");
  /**
   * A signal after before ran (or the upgrade started) must not leave the host off: the stop path
   * runs after (past the stop, forced) before oupdate exits, unless the record's verdict says
   * "skip". It only records that after ran: the record stays, and the next run resumes it from its
   * last step.
   */
  const oweAfter = (p: PendingCheck) => {
    const rc = findCheck(cfg.releaseChecks, p.formula);
    if (!rc?.after || dryRun || rcStopOff.has(p.formula)) return;
    rcStopOff.set(p.formula, onStop(async (lg) => {
      if (p.after === "skip") {
        lg(`  release check ${p.formula}: stopped — after not run (the verdict leaves the host as before left it)`);
        return;
      }
      if (!afterOwed(p)) return;
      const lines: string[] = [];
      const ok = await runHook({ ...rcEnv, exec: (a, o = {}) => rcEnv.exec(a, { ...o, force: true }), log: lines, notify: async () => {} }, rc, "after");
      for (const l of lines) lg(l);
      lg(`  release check ${p.formula}: stopped — after ${ok ? "ran" : "FAILED, owed by the next run"}`);
      if (ok) {
        p.afterRan = true;
        await savePending(rcEnv, p);
      }
    }));
  };
  /**
   * A record without its installed version (a killed run, a brew upgrade that exited nonzero after
   * installing, a version query that failed): read it again, so the stale-keg scan retires the
   * previous keg and the owner still on it is restarted before the check.
   */
  const recoverTo = async (p: PendingCheck, said: string) => {
    try {
      // An upgrade that changed nothing is never taken for one by a later version change.
      if (!p.to && !p.ended && p.from && !p.unchanged) {
        const v = await brewView(rcEnv.exec, cfg.brew, p.full);
        if (v?.current && v.current !== p.from) {
          p.to = v.current;
          p.upgraded = true;
          await savePending(rcEnv, p);
          log.push(`  release check ${p.formula}: ${said} ${p.from} → ${p.to} — checked this run`);
        }
      }
    } catch (e) {
      log.push(`  WARNING: release check ${p.formula}: its record could not be updated (${e instanceof Error ? e.message : String(e)})`);
    }
  };
  if (!dryRun) {
    for (const p of rcPending.values()) {
      await recoverTo(p, "a stopped run upgraded");
      oweAfter(p);
    }
  }
  // The keg an unfinished check's owners must run: the candidate, or after a rollback the restored
  // version. Every other keg of its rack is one they must leave (the previous one, any older retained
  // one, the removed candidate).
  const expectedKeg = (p: PendingCheck) => join(p.rack, p.rolledBack ? p.from : p.to!);
  const releaseRacks = () => new Map([...rcPending.values()].filter((p) => p.to && p.from && p.rack && !p.ended).map((p) => [p.rack, expectedKeg(p)] as const));
  /** The racks the stale-keg scan retired, with the keg each expected: a record not among them as it is now was not scanned for. */
  let rcScannedRacks: ReadonlyMap<string, string> = new Map();
  /** A keg of the record's rack other than the one its owners must run. */
  const retiredFor = (p: PendingCheck, keg: string) => dirname(keg) === p.rack && keg !== expectedKeg(p);
  /** Set when the stale-keg check queued other owners while a release check was unfinished: their waiter starts after the release checks. */
  let waiterDeferred = "";
  /** Gated formulae outdated (held ones too) or not installed this run: an upgrade that depends on one waits. */
  const gatedOutdated: string[] = [];
  const ownerLock = opts.ownerLock ?? { take: realTakeLock, release: realReleaseLock };
  /** How long a release check waits for the owner waiter's lock before its check waits for a later run. */
  const LOCK_WAIT_MS = 10 * 60_000;
  const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
  /** Runs a check waits for its owner (any reason) before it ends with no verdict, notified. */
  const UNRESOLVED_WAIT_RUNS = 3;
  const clock = opts.ownerClock ?? { now: () => Date.now(), sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)), httpStatus: realHttpStatus };
  const restartOpts = {
    deferred: cfg.deferred, helper: cfg.restartHelper, labelRestart: cfg.labelRestart, staleKegUnlisted: cfg.staleKegUnlisted, detachedLog: join(cfg.stateDir, "restart.log"), ownerHanded,
    staleOwners: cfg.staleOwners,
  };

  // ── waiter report: a drain a dead waiter left behind is recovered before any long brew build ──
  let owners: OwnerReport = { note: "", busy: new Set(), failed: new Set() };
  await step("brew", "waiter report", async () => {
    const notes: string[] = [];
    for (const s of cfg.deferred) {
      const n = await waiterReport(waiterEnv, s, dryRun);
      if (n) notes.push(n);
    }
    // The owner restart waiter's last outcome, and the labels it failed (not queued again).
    if (cfg.staleOwners?.length) {
      owners = await ownerWaiterReport(fs, ownerDir(cfg.stateDir), dryRun);
      if (owners.note) notes.push(owners.note);
    }
    b.waiterNote = notes.join("; ");
  });

  // ── brew ──
  await step("brew", "brew", async () => {
    try {
      await brewSection();
    } finally {
      b.sectionDone = true;
      b.flaggedAtSection = b.flagged;
    }
  });
  // Run for whatever was upgraded, even when the brew step stopped part-way.
  await step("brew", "relink and restart", async () => {
    if (dryRun || !b.upgraded.length) return;
    const rl = await relinkUpgraded(kegEnv, b.upgraded, { brew: cfg.brew, log });
    b.relinkNote = rl.note;
    await restartUpgraded({ exec: x, exists: fs.exists, spawnDetached: fs.spawnDetached, home: fs.home, uid: fs.uid }, b.upgraded, { ...restartOpts, into: b.restarted });
    if (b.restarted.length) log.push(`restarted: ${b.restarted.join(" ")}`);
  });
  await step("brew", "cleanup", async () => {
    if (!dryRun && b.started && !b.noBrew) await cleanup();
  });
  await step("brew", "deferred casks", casksSection);
  await step("brew", "app bundles", appBundlesSection);
  await step("brew", "stale-keg check", async () => {
    if (b.noBrew) return;
    // This run's upgrades whose installed version was not read right after them.
    if (!dryRun) for (const p of rcPending.values()) await recoverTo(p, "the upgrade installed");
    const racks = releaseRacks();
    const retired = (keg: string) => racks.has(dirname(keg)) && racks.get(dirname(keg)) !== keg;
    const s = await staleKegCheck(kegEnv, {
      brew: cfg.brew, lsof: cfg.lsof, dryRun, host, logFile: cfg.logFile, notify,
      deferred: cfg.deferred.map((d) => d.name),
      // Handed to the service that matched, never to another one.
      // Recorded as made: kept if the re-scan after it stops the step.
      handoff: async (keg, name) => {
        const d = cfg.deferred.find((s) => s.name === name);
        const n = d ? await handoff(waiterEnv, d, keg, dryRun) : `${name} stale — no deferred service of that name, not handed off`;
        if (n) b.handoffNotes.push(n);
        return n;
      },
      restartHelper: cfg.restartHelper,
      labelRestart: cfg.labelRestart,
      staleKegUnlisted: cfg.staleKegUnlisted,
      jobRunners: cfg.jobRunners ?? opts.jobRunners ?? [],
      ownerHanded,
      detachedLog: join(cfg.stateDir, "restart.log"),
      staleOwners: cfg.staleOwners,
      ownerFailed: owners.failed,
      ownerBusy: owners.busy,
      // A release check's owner restarts inline (its check runs after it), never through the waiter.
      queueOwners: async (items) => {
        const mine = items.filter((q) => retired(q.keg));
        for (const q of mine) {
          const f = basename(dirname(q.keg));
          rcJobs.set(f, [...(rcJobs.get(f) ?? []), q]);
          // On the record as found: a run that resumes it restarts the job though its scan no longer finds it.
          const p = rcPending.get(f);
          if (p && !dryRun) {
            p.owners = mergeOwners(p.owners ?? [], [q]);
            await savePending(rcEnv, p);
          }
        }
        // A target a release check restarts inline is never also the waiter's, whatever other kegs it maps.
        const inline = new Set(mine.map((q) => q.target));
        const rest = items.filter((q) => !retired(q.keg) && !inline.has(q.target));
        // A waiter started now would hold its lock through the release checks' inline restarts.
        const later = rest.length && [...rcPending.values()].some((p) => !p.ended);
        let n = await queueOwners(fs, ownerDir(cfg.stateDir), rest, later ? undefined : opts.ownerWaiterArgv, join(cfg.stateDir, "restart.log"));
        if (later && !n.includes("could not queue")) {
          waiterDeferred = rest.map((q) => q.label).join(" ");
          n = `owner restart waiter starts after the release checks for ${waiterDeferred}`;
        }
        return [n, mine.length ? `owner restart for the release check: ${mine.map((q) => q.label).join(" ")}` : ""].filter(Boolean).join(", ");
      },
      releaseRacks: racks,
      trackStuck: (still) => track("stale-keg", still) ?? [],
      log,
    });
    b.staleNote = s.note;
    rcScanned = s.scanned !== false;
    if (rcScanned) rcScannedRacks = racks;
    rcUnresolved = s.unresolved;
  });
  await step("brew", "release checks", releaseChecksSection);
  await step("brew", "linkage check", async () => {
    if (b.noBrew) return;
    const l = await linkageCheck(kegEnv, { brew: cfg.brew, host, logFile: cfg.logFile, notify, log });
    b.linkageNote = l.note;
  });
  await step("brew", "stuck tracking", async () => {
    if (dryRun || b.noBrew) return;
    const q = await x([cfg.brew, "outdated", "--json=v2", "--greedy-auto-updates", ...(b.fetchHead ? ["--fetch-HEAD"] : [])]);
    const pending = q.rc === 0 ? pendingFromOutdated(q.out, brewHeld()) : undefined;
    if (pending === undefined) {
      await brewFailed("pending-query");
      return;
    }
    const s = track("brew", pending);
    if (s !== undefined) b.stuck = s;
  });

  // ── npm ──
  let npmStatus = "";
  // The phase's record is ours and its lines are the run's: a stop part-way keeps both.
  const npmRun: NpmRun = { log, pending: [], upgraded: [] };
  if (cfg.npm === null) npmStatus = "not managed here (apply.npm is null)";
  else {
    const npm = cfg.npm;
    await step("npm", "npm", async () => {
      const n = await npmSection(x, r, {
        npm, host, registry: cfg.npmRegistry, dryRun, logFile: cfg.logFile, notify,
        trackStuck: (pending) => track("npm", pending),
        into: npmRun,
      });
      npmStatus = n.status;
    });
  }

  // ── Claude Code (native) ──
  // The native build updates itself in place; with its background updater off, this
  // explicit call is the only update path. Not executable: skipped with no word, as the bash did.
  let ccPart: string | undefined = "claude-code: not configured";
  if (cfg.claudeCode) {
    const ccBin = cfg.claudeCode;
    ccPart = (await fs.isExecutable(ccBin)) ? "claude-code: not completed" : undefined;
    if (ccPart) {
      const stopping = () => !!opts.isStopping?.() || execStopping();
      log.push("", "--- claude code (native) ---");
      if (dryRun) {
        log.push("  DRY RUN - would run: claude update");
        ccPart = "claude-code: dry-run";
      } else if (stopping()) {
        log.push("  not run: oupdate is stopping");
        ccPart = "claude-code: not run (oupdate is stopping)";
      } else {
        await step("npm", "claude code", async () => {
          let rc: number | "timeout";
          try {
            const u = await x([ccBin, "update"]);
            rc = u.rc;
            for (const l of `${u.out}${u.err}`.split("\n")) if (l !== "") log.push(`  ${l}`);
          } catch (e) {
            if (!(e instanceof PhaseTimeout)) throw e;
            rc = "timeout";
          }
          // Read after the attempt: on success what now runs, on failure what it is stuck on.
          let ver = "unknown";
          if (!stopping()) {
            try {
              const v = await x([ccBin, "--version"]);
              // A failed --version is "unknown" even when it printed something (the bash took its first field).
              if (v.rc === 0) ver = v.out.trim().split(/\s+/)[0] || "unknown";
            } catch (e) {
              if (!(e instanceof PhaseTimeout)) throw e;
            }
          }
          ccPart = rc === 0 ? `claude-code: ${ver}` : `claude-code: FAILED (${rc === "timeout" ? "timeout" : `rc=${rc}`}, on ${ver})`;
        });
      }
    }
  }

  // ── post-upgrade checks (apply.postUpgradeCheck) ──
  // Each package upgraded this run that has a configured argv is run once; a failure is logged,
  // notified and counted (check:<name> in the brew line's FAILED list, so rc 1), never an abort.
  if (cfg.postUpgradeCheck && !dryRun) {
    const checks = Object.entries(cfg.postUpgradeCheck);
    const ups = [...b.upgraded, ...npmRun.upgraded];
    const todo = checks.filter(([name]) => ups.some((u) => u === name || u.split("/").at(-1) === name));
    if (todo.length) {
      log.push("", "--- post-upgrade checks ---");
      await step("brew", "post-upgrade checks", async () => {
        for (const [name, argv] of todo) {
          if (opts.isStopping?.() || execStopping()) {
            log.push("  not run: oupdate is stopping");
            return;
          }
          let why = "";
          try {
            const c = await x(argv);
            if (c.rc !== 0) why = `rc=${c.rc}`;
          } catch (e) {
            if (!(e instanceof PhaseTimeout)) throw e;
            why = "timeout";
          }
          if (!why) log.push(`post-upgrade check: ${name} ok`);
          else {
            b.failed.push(`check:${name}`);
            log.push(`post-upgrade check: ${name} FAILED (${why}): ${argv.join(" ")}`);
            await notify(`⚠️ <b>${host} post-upgrade check FAILED: ${name}</b>\n${argv.join(" ")} (${why})\nLog: ${cfg.logFile ?? "-"}`);
          }
        }
      });
    }
  }

  if (stuckDirty && stuckState !== undefined) {
    try {
      await fs.writeFile(stuckFile, stuckState);
    } catch (e) {
      log.push(`  WARNING: could not write ${stuckFile} (${e instanceof Error ? e.message : "error"})`);
      b.failed.push("stuck-state-not-saved");
    }
  }
  if (stuckBroken) b.failed.push("stuck-state-unreadable");

  const brewStatus = assembleBrew();
  // A failure is "FAILED — <name>", the form the shadow parser reads; a step that never finished
  // says so instead of "nothing to update".
  // Stopped part-way: what was already updated, then "not completed" (never "nothing to update").
  const left = npmRun.pending.filter((p) => !npmRun.upgraded.includes(p));
  const npmPartial = [
    ...(npmRun.upgraded.length ? [`upgraded: ${npmRun.upgraded.join(" ")}`] : []),
    left.length ? `not completed — still pending: ${left.join(" ")}` : "not completed",
  ];
  const npmParts = [...uniq(npmFailed).map((t) => `FAILED — ${t}`), ...(npmStatus ? [npmStatus] : npmFailed.length ? npmPartial : ["nothing to update"])];
  const npmLine = [...npmParts, ...(ccPart ? [ccPart] : [])].join("; ");
  const mas = "not checked — the App Store phase is not in oupdate";
  const rc: 0 | 1 = b.failed.length || /FAILED|ERROR/.test(npmLine) ? 1 : 0;
  const summary = [
    "",
    dryRun ? `=== ${host} dry-run summary (nothing applied) ===` : `=== ${host} summary ===`,
    `  brew: ${brewStatus}`,
    `  npm:  ${npmLine}`,
    `  mas:  ${mas}`,
  ];
  for (const l of summary) sink?.(l);
  // A run being stopped by a signal sends no done notice: its ABORTED line is the last word.
  if (!dryRun && !opts.isStopping?.()) await notify(`📋 <b>${host} ${prevName} done (oupdate)</b>\nbrew: ${brewStatus}\nnpm:  ${npmLine}\nmas:  ${mas}`);
  return { log, summary, rc };

  function assembleBrew(): string {
    // Casks deferred but never tried (a step stopped first) are still listed as deferred.
    const pendingCasks = b.deferredCasks.filter((k) => !b.caskTried.has(k));
    let core: string;
    if (b.noBrew) core = "not run";
    else if (b.nothing) core = "nothing to update";
    else if (!b.sectionDone) core = "not run";
    else if (b.upgraded.length && !dryRun) {
      core = `upgraded: ${b.upgraded.join(" ")}`;
      if (pendingCasks.length) core += `; casks deferred: ${pendingCasks.join(" ")}`;
      if (b.restarted.length) core += `; restarted: ${b.restarted.join(" ")}`;
      if (b.relinkNote) core += `; ${b.relinkNote}`;
    } else if (b.flaggedAtSection) core = "FLAGGED (see notifications)";
    else if (dryRun) core = "dry-run OK";
    else if (pendingCasks.length) core = `casks deferred: ${pendingCasks.join(" ")}`;
    // A failed query or step says FAILED in front; it is never "nothing approved".
    else core = b.deferredCasks.length || b.failed.length ? "" : "nothing approved for upgrade";
    if (b.unknownNote) core = `${b.unknownNote}; ${core}`;
    if (b.headNote) core = `${b.headNote}; ${core}`;
    if (quarantined) core = `${quarantined.name} QUARANTINED — unreviewed install, not restarting (${quarantined.quarantineFile}); ${core}`;
    const parts: string[] = [];
    if (b.casksUp.length) parts.push(`casks upgraded: ${b.casksUp.join(" ")}`);
    if (b.casksSudo.length) parts.push(`casks need sudo: ${b.casksSudo.join(" ")}`);
    if (b.casksRunning.length) parts.push(`casks held (running): ${b.casksRunning.join(" ")}`);
    if (b.casksFailed.length) parts.push(`casks FAILED: ${b.casksFailed.join(" ")}`);
    if (b.gkNotes.length) parts.push(`GATEKEEPER pending: ${b.gkNotes.join("; ")}`);
    if (parts.length) core = core ? `${core}; ${parts.join("; ")}` : parts.join("; ");
    const failed = uniq(b.failed);
    // The check's note, plus any handoff it does not already carry (a stop or a failed re-scan).
    const stale = [b.staleNote, ...b.handoffNotes.filter((n) => !b.staleNote.includes(n))].filter(Boolean).join("; ");
    const notifyNote = !dryRun && cfg.notify === undefined ? "notify: not configured — notices were logged only" : "";
    // Empty parts are skipped, so no "; ;" when the core is empty.
    return [
      failed.length ? `FAILED: ${failed.join(" ")}` : "",
      core.replace(/; $/, ""),
      b.appNotes.join("; "),
      b.stuck.length ? `STUCK: ${b.stuck.join(" ")}` : "",
      b.pinned.length ? `PINNED: ${b.pinned.join(" ")}` : "",
      b.selfBun.length ? `HELD: ${b.selfBun.map((n) => `${n} (runs under it)`).join(", ")}` : "",
      b.rcHeld.length ? `HELD by release check: ${b.rcHeld.join(" ")}` : "",
      b.rcNotes.length ? `release check: ${b.rcNotes.join(", ")}` : "",
      b.pinWarn, stale, b.linkageNote, b.waiterNote, notifyNote,
    ].filter(Boolean).join("; ");
  }

  async function brewSection() {
    log.push("", "--- brew ---");
    const v = await x([cfg.brew, "--version"]);
    if (v.rc === 127) {
      log.push(`${cfg.brew} not found — skipping the brew phase`);
      b.failed.push("brew-not-found");
      b.noBrew = true;
      return;
    }
    b.started = true;

    // 1. Sync the formula repo only. A failed tap fetch is surfaced and the run goes on, so one
    // unreachable tap does not cost the host its official upgrades.
    if (dryRun) log.push("dry-run: brew update skipped — the outdated list is against the taps as they are");
    else {
      const u = await x([cfg.brew, "update"]);
      const out = `${u.out}${u.err}`;
      if (u.rc !== 0) {
        log.push(`  WARNING: brew update exited ${u.rc} — a tap fetch likely failed, so the outdated list below may be computed against a STALE tap:`);
        log.push(...out.split("\n").filter((l) => /error|fatal|failed/i.test(l)).slice(0, 5).map((l) => `    ${l}`));
      }
      log.push(...out.trimEnd().split("\n").slice(-3));
    }

    // 2. Outdated formulae (with --fetch-HEAD, so a HEAD install shows) and casks (greedy, so an
    // auto_updates cask shows). A query that fails is a FAILED entry, never "nothing to update".
    let f = await x([cfg.brew, "outdated", ...(b.fetchHead ? ["--fetch-HEAD"] : []), "--formula"]);
    if (f.rc !== 0 && b.fetchHead) {
      b.headNote = `outdated --fetch-HEAD FAILED (rc ${f.rc}) — HEAD installs not checked this run`;
      b.fetchHead = false;
      log.push(`  WARNING: brew ${b.headNote}; falling back to the plain query`);
      f = await x([cfg.brew, "outdated", "--formula"]);
    }
    if (dryRun) log.push("dry-run: HEAD installs are not fetched");
    let formulas: string[] = [];
    if (f.rc !== 0) await brewFailed("outdated-query");
    else formulas = words(f.out);
    const c = await x([cfg.brew, "outdated", "--cask", "--greedy-auto-updates"]);
    let casks: string[] = [];
    if (c.rc !== 0) await brewFailed("cask-outdated-query");
    else casks = words(c.out);

    // Casks never auto-managed here.
    casks = casks.filter((k) => {
      if (!named(cfg.caskExclude, k)) return true;
      log.push(`  excluding ${k} (CASK_EXCLUDE — self-updates / too heavy to reinstall)`);
      return false;
    });

    // Gated formulae outdated, read before pins hold any: a pinned one is still pulled in by a
    // dependent's upgrade. A failed outdated query: every gated formula counts (fail closed).
    if (cfg.releaseChecks?.length) {
      const gated = f.rc !== 0 ? cfg.releaseChecks.map((c) => c.formula) : formulas.filter((n) => findCheck(cfg.releaseChecks, n));
      for (const n of gated) if (!gatedOutdated.includes(last(n))) gatedOutdated.push(last(n));
      // A gated formula not installed counts too: a dependent's upgrade would install it fresh (a held
      // release included) with no before, check or rollback. A failed list: every gated formula counts.
      const inst = await x([cfg.brew, "list", "--formula", "--full-name"]);
      const have = inst.rc === 0 ? words(inst.out).map(last) : [];
      for (const c of cfg.releaseChecks) {
        const n = last(c.formula);
        if (!have.includes(n) && !gatedOutdated.includes(n)) gatedOutdated.push(n);
      }
    }

    // The bun this run is executing. Upgrading Homebrew's bun replaces that binary mid-run
    // (brew cleanup then deletes the keg). It is held; a deliberate step updates it later.
    const self = holdRunningBun(formulas, opts.bunExec ?? process.execPath);
    for (const n of self.held) log.push(`  holding ${n} (runs under it)`);
    b.selfBun.push(...self.held);
    formulas = self.kept;

    // Pinned tools (brew pin, or a repo's pins.json) are held, never upgraded.
    const pinnedQ = await x([cfg.brew, "list", "--pinned"]);
    if (pinnedQ.rc !== 0) {
      b.pinWarn = `WARNING: brew list --pinned failed (rc ${pinnedQ.rc}) — brew pins not read, repo pins still held`;
      log.push(`  ${b.pinWarn}`);
    }
    const files = fs.pinFiles(cfg.pinRoots);
    for (const [kind, names] of [["brew", formulas], ["cask", casks]] as const) {
      const p = pinFilter(kind, names, { brewPinned: pinnedQ.rc === 0 ? words(pinnedQ.out) : [], files });
      if (kind === "brew") log.push(...p.warnings.map((w) => `  ${w}`));
      for (const n of p.pinned) log.push(`  holding ${n.replace(/\(.*$/, "")} (pinned: ${n.replace(/^[^(]*\(|\)$/g, "")})`);
      b.pinned.push(...p.pinned);
      if (kind === "brew") formulas = p.kept;
      else casks = p.kept;
    }

    // Release checks: a held release is not upgraded to (a newer one is); a dry run says what it would do.
    if (cfg.releaseChecks?.length) {
      const keep: string[] = [];
      for (const n of formulas) {
        const rc = findCheck(cfg.releaseChecks, n);
        if (!rc) {
          keep.push(n);
          continue;
        }
        const f = last(n);
        const open = rcPending.get(f);
        if (open) {
          // Never a second upgrade over an unfinished one: its from stays the rollback baseline.
          log.push(`  holding ${f} (its release check of ${open.from || "?"} → ${open.to ?? "?"} is not finished — finished first)`);
          b.rcHeldNames.push(n);
          continue;
        }
        if (rcBroken.includes(f)) {
          log.push(`  holding ${f} (its release check record ${pendingPath(cfg.stateDir, f)} is unreadable — fix or remove it)`);
          b.rcHeld.push(`${f} (record unreadable)`);
          b.rcHeldNames.push(n);
          continue;
        }
        const view = await brewView(rcEnv.exec, cfg.brew, n);
        const hs = await holdState(rcEnv, f);
        if (hs.unreadable) {
          log.push(`  holding ${f} (its release check hold ${holdPath(cfg.stateDir, f)} is unreadable — fix or remove it)`);
          b.rcHeld.push(`${f} (hold unreadable)`);
          b.rcHeldNames.push(n);
          continue;
        }
        // A hold is only ever compared with a version read: no candidate, no upgrade this run.
        if (!view?.candidate) {
          log.push(`  holding ${f} (release check: its candidate version could not be read — not upgraded this run)`);
          b.rcNotes.push(`${f} not upgraded, candidate unreadable`);
          b.rcHeldNames.push(n);
          continue;
        }
        const hold = hs.hold;
        if (hold && view.candidate === hold.version) {
          log.push(`  holding ${f} ${hold.version} (HELD by release check — failed ${hold.at}, rolled back to ${hold.from}; a newer release is tried)`);
          b.rcHeld.push(`${f} ${hold.version}`);
          b.rcHeldNames.push(n);
          continue;
        }
        keep.push(n);
        if (dryRun) {
          const to = view?.candidate ?? "?";
          log.push(`  dry-run: release check ${f}: would run ${rc.before ? `before [${asUser(rc, rc.before).join(" ")}], ` : ""}the upgrade to ${to} keeping the previous keg ${view?.current ?? "?"}, the owner restart, the check [${asUser(rc, rc.command).join(" ")}] with GATE_VERSION=${to}${rc.after ? `, then after [${asUser(rc, rc.after).join(" ")}]` : ""}`);
        }
      }
      formulas = keep;
    }

    if (!formulas.length && !casks.length) {
      log.push("brew: nothing to update");
      if (!b.failed.length) b.nothing = true;
      return;
    }

    // Never review a list brew failed to produce.
    const vq = await x([cfg.brew, "outdated", "--verbose", "--greedy-auto-updates", ...(b.fetchHead ? ["--fetch-HEAD"] : [])]);
    if (vq.rc !== 0) {
      await brewFailed("outdated-query");
      return;
    }
    // Excluded and held names stay out of the review table too (literal, by last segment).
    const hide = brewHeld();
    const verbose = `${vq.out}${vq.err}`.split("\n").filter((l) => !named(hide, l.trim().split(/\s+/)[0] ?? "")).join("\n");
    log.push(verbose.trimEnd(), "");

    // 3. Tap tiers. Type B is the config's list plus this host's approved taps.
    let typeBTaps = cfg.typeBTaps;
    if (cfg.approvedTapsFile) {
      const t = await fs.readFile(cfg.approvedTapsFile);
      if (t !== undefined) {
        const l = loadApprovedTaps(t, host, typeBTaps, { hostPrefixes: cfg.hostPrefixes });
        typeBTaps = l.taps;
        log.push(...l.warnings.map((w) => `  ${w}`));
      } else if (await fs.exists(cfg.approvedTapsFile)) log.push(`  WARNING: ${cfg.approvedTapsFile} unreadable — no tap approvals this run`);
    }
    let typeA: string[] = [];
    const typeBPairs: { pkg: string; tap: string }[] = [];
    const unknownF: { pkg: string; tap: string }[] = [];
    const unresolvedF: string[] = [];
    if (formulas.length) {
      const info = await x([cfg.brew, "info", "--json=v2", ...formulas]);
      const tapOf = new Map<string, string>();
      try {
        for (const e of (JSON.parse(info.out) as { formulae?: { name?: unknown; full_name?: unknown; tap?: unknown }[] }).formulae ?? []) {
          const tap = typeof e?.tap === "string" && e.tap ? e.tap : "unknown";
          for (const n of [e?.name, e?.full_name]) if (typeof n === "string" && n) tapOf.set(n, tap);
        }
      } catch {
        log.push("  WARNING: could not read formula tap data from brew — treating all pending formulae as unverified");
      }
      for (const pkg of formulas) {
        const tap = tapOf.get(pkg);
        if (tap === undefined) unresolvedF.push(pkg);
        else if (tapIn(tap, cfg.officialTaps)) typeA.push(pkg);
        else if (tapIn(tap, typeBTaps)) typeBPairs.push({ pkg: last(pkg), tap });
        else unknownF.push({ pkg: last(pkg), tap });
      }
    }
    // Casks by tap too, keyed on the name brew outdated gave (never the token echoed back), and
    // queried with --cask so a name that is also a formula is not answered about the formula.
    let keptCasks: string[] = [];
    const typeBCasks: string[] = [];
    const unknownC: { pkg: string; tap: string }[] = [];
    if (casks.length) {
      const info = await x([cfg.brew, "info", "--json=v2", "--cask", ...casks]);
      const tapOf = new Map<string, string>();
      try {
        for (const e of (JSON.parse(info.out) as { casks?: { token?: unknown; tap?: unknown }[] }).casks ?? []) {
          if (typeof e?.token === "string" && e.token) tapOf.set(e.token, typeof e.tap === "string" && e.tap ? e.tap : "unknown");
        }
      } catch {
        // an empty map: every cask below is unresolved
      }
      if (!tapOf.size) log.push("  WARNING: could not read cask tap data from brew — treating all pending casks as unverified");
      for (const k of casks) {
        const tap = tapOf.get(k);
        if (tap === undefined) unknownC.push({ pkg: k, tap: "tap-unresolved" });
        else if (tapIn(tap, cfg.officialTaps)) keptCasks.push(k);
        else if (tapIn(tap, typeBTaps)) typeBCasks.push(`${k}(${tap})`);
        else unknownC.push({ pkg: k, tap });
      }
    }
    const show = (xs: string[]) => (xs.length ? xs.join(" ") : "(none)");
    const unknownShown = [...unknownF.map((u) => `${u.pkg}(${u.tap})`), ...unresolvedF.map((u) => `${u}(tap-unresolved)`), ...unknownC.map((u) => `${u.pkg}(${u.tap})`)];
    log.push("Tier split:", `  Type A (first-party): ${show([...typeA, ...keptCasks])}`, `  Type B (third-party trusted): ${show(typeBPairs.map((p) => p.pkg))}`);
    log.push(`  Unknown tap: ${show(unknownShown)}`);
    if (typeBCasks.length) log.push(`  Trusted tap, no cask review path (skipped): ${typeBCasks.join(" ")}`);
    log.push("");

    // 4. Unknown taps: isolated, never block the host. Each pending formula gets an advisory
    // review (never installed, its notices logged only); one notice asks for the tap's approval.
    if (unknownShown.length || typeBCasks.length) {
      b.flagged = true;
      const tbNote = typeBCasks.length ? `; trusted-tap cask(s) skipped (no cask review path): ${typeBCasks.join(" ")}` : "";
      const items: string[] = [];
      if (unknownF.length || unknownC.length) {
        const a = await tb.awaiting(tbEnv, r, unknownF, unknownC, verbose, tbOpts);
        log.push(...a.log);
        if (a.items) items.push(a.items);
      }
      for (const pkg of unresolvedF) items.push(`(unresolved tap) (${pkg} ${outdatedVersions(pkg, verbose)}, review: n/a)`);
      const where = cfg.approvedTapsFile ?? "the approved-taps file (apply.approvedTapsFile)";
      if (items.length) {
        const list = items.join("; ");
        b.unknownNote = `FLAGGED — awaiting tap approval: ${list} — approve a tap by adding it to ${where}${tbNote}`;
        await notify(`⚠️ <b>${host} brew FLAGGED — awaiting tap approval</b>\n${list}${tbNote}\nHeld until the tap is approved; official Homebrew upgrades still proceed.\nApprove a tap once by adding a row to ${where} (tap, host or *, date, note); its updates then take the normal Type B review.\nLog: ${cfg.logFile ?? "-"}`);
      } else {
        b.unknownNote = `FLAGGED — ${tbNote.slice(2)}`;
        await notify(`⚠️ <b>${host} brew FLAGGED — trusted-tap cask skipped</b>\n${tbNote.slice(2)}\nLog: ${cfg.logFile ?? "-"}`);
      }
      log.push(`brew: awaiting tap approval — skipping [${unknownShown.join(" ")}${tbNote}], continuing with the rest`);
    }

    // 5. Type A: the deterministic version policy holds only what it names; the rest upgrades.
    if (typeA.length || keptCasks.length) {
      const all = [...typeA, ...keptCasks];
      log.push(`--- Type A review (${all.length} packages) ---`);
      const a = typeAReview(all, verbose, cfg.sensitive);
      log.push("┌─ Type A review", ...a.text.split("\n").map((l) => `│ ${l}`), "└─");
      if (a.held.length) {
        b.flagged = true;
        const held = new Set(a.held);
        typeA = typeA.filter((p) => !held.has(p));
        keptCasks = keptCasks.filter((p) => !held.has(p));
        await notify(`⚠️ <b>${host} Type A — holding ${a.held.length} pkg(s), upgrading rest</b>\nheld: ${a.held.join(" ")}\nSensitive major increase or unverifiable version baseline.\nLog: ${cfg.logFile ?? "-"}`);
        log.push(`Type A: holding [${a.held.join(" ")}] — upgrading [${[...typeA, ...keptCasks].join(" ")}]`);
      }
      typeA = await notWaiting(typeA);
      keptCasks = await notWaiting(keptCasks, true);
      if (!typeA.length && !keptCasks.length) log.push("Type A: nothing left to upgrade after holds");
      else if (dryRun) log.push(`dry-run: would upgrade Type A formulas=[${typeA.join(" ")}] casks=[${keptCasks.join(" ")}]`);
      else {
        // Recorded before the formula upgrades, so a stop part-way still leaves the casks to their phase.
        if (keptCasks.length) {
          b.deferredCasks = keptCasks;
          log.push(`Type A casks deferred until end of run: ${keptCasks.join(" ")}`);
        }
        for (const pkg of typeA) {
          if ((await upgradeFormula(pkg)) === 0) b.upgraded.push(pkg);
          else await brewFailed(pkg);
        }
      }
    }

    // 6. Type B: per-package review, then a guarded install. Its record is ours, filled as it goes.
    if (typeBPairs.length) {
      const go = new Set(await notWaiting(typeBPairs.map((p) => `${p.tap}/${p.pkg}`)));
      typeBPairs.splice(0, typeBPairs.length, ...typeBPairs.filter((p) => go.has(`${p.tap}/${p.pkg}`)));
    }
    if (typeBPairs.length) {
      const into: TypeBRun = { upgraded: b.upgraded, upgradedFull: [], failed: b.failed, flagged: false, log };
      try {
        await tb.upgrades(tbEnv, r, typeBPairs, {
          ...tbOpts,
          dryRun,
          into,
          upgrade: upgradeFormula,
        });
      } finally {
        if (into.flagged) b.flagged = true;
      }
    }
  }

  async function cleanup() {
    log.push("--- brew cleanup ---");
    // A quarantined service's reviewed keg, and a formula whose release check has not decided (its
    // previous keg is the rollback): clean everything else by name.
    const skip = [...(quarantined ? [quarantined.name] : []), ...rcPending.keys(), ...rcBroken];
    if (skip.length) {
      const fl = await x([cfg.brew, "list", "--formula", "--full-name"]);
      const cl = await x([cfg.brew, "list", "--cask"]);
      const keep = [...words(fl.out), ...words(cl.out)].filter((n) => !skip.includes(last(n)));
      if (quarantined) log.push(`  ${quarantined.name} quarantined — cleanup skips ${quarantined.name}`);
      for (const f of rcPending.keys()) log.push(`  ${f}: release check pending — cleanup skips ${f} (its previous keg is the rollback)`);
      for (const f of rcBroken) log.push(`  ${f}: release check record unreadable — cleanup skips ${f}`);
      if (keep.length) log.push(...(await x([cfg.brew, "cleanup", ...keep])).out.trimEnd().split("\n").slice(-5));
      return;
    }
    log.push(...(await x([cfg.brew, "cleanup"])).out.trimEnd().split("\n").slice(-5));
  }

  /**
   * The planned upgrades that do not depend on an outdated or uninstalled gated formula. brew upgrade
   * installs the dependencies a new version needs, so such an upgrade would pull the gated (or held)
   * release in with no before, check or rollback: it waits for a run where the gated formula is
   * installed and current.
   * The query is the candidate's declared dependencies, recursive, build and optional ones too: a
   * plain `brew deps` of an installed formula reads its installed keg's runtime dependencies (not
   * the new release's) and leaves out build dependencies, which a source build installs.
   * Unreadable dependencies wait too (fail closed). Every gated formula installed and current: nothing is queried.
   */
  async function notWaiting(names: string[], cask = false): Promise<string[]> {
    if (!gatedOutdated.length) return names;
    const keep: string[] = [];
    for (const n of names) {
      // Every planned upgrade, a gated formula (on another gated one) and a cask (its formula dependencies) too.
      // Only a formula is exempt from its own name: a cask named like a gated formula is another package.
      const d = await x([cfg.brew, "deps", ...DECLARED_DEPS, ...(cask ? ["--cask"] : []), n]);
      // Every line a package name, or the list is unreadable.
      const deps = d.rc === 0 ? words(d.out) : [];
      const read = d.rc === 0 && deps.every((dep) => PKG_NAME.test(dep));
      const hit = read ? deps.find((dep) => gatedOutdated.includes(last(dep)) && (cask || last(dep) !== last(n))) : undefined;
      if (!read) log.push(`  ${last(n)}: not upgraded this run — its dependencies could not be read while ${gatedOutdated.join(" ")} is gated by a release check`);
      else if (hit) log.push(`  ${last(n)}: not upgraded this run — it depends on ${last(hit)}, which a release check gates; retried next run`);
      else {
        keep.push(n);
        continue;
      }
      b.rcNotes.push(`${last(n)} waits for ${hit ? last(hit) : "its dependencies"}`);
    }
    return keep;
  }

  /** A formula upgrade; one with a release check records its previous keg first and runs its before. */
  async function upgradeFormula(full: string): Promise<number> {
    const rc = findCheck(cfg.releaseChecks, full);
    if (!rc) return (await x([cfg.brew, "upgrade", full], { env: installEnv })).rc;
    const f = last(full);
    const view = await brewView(rcEnv.exec, cfg.brew, full);
    const cel = await x([cfg.brew, "--cellar", f]);
    const rack = cel.rc === 0 ? cel.out.trim() : "";
    // The rollback needs all three: the version in use, its rack, and whether brew trusts the formula
    // (uninstall drops the trust). Any unread: not upgraded, never upgraded without a rollback.
    const trusted = view ? await trustState(rcEnv.exec, cfg.brew, view.full) : undefined;
    const why = !view?.current ? "the version in use could not be read" : !rack.startsWith("/") ? "its cellar could not be read" : trusted === undefined ? "its trust state could not be read" : "";
    if (!view?.current || why || trusted === undefined) {
      log.push(`  ${f}: not upgraded — release check: ${why}`);
      b.rcNotes.push(`${f} not upgraded, ${why}`);
      return 1;
    }
    const p: PendingCheck = { formula: f, full, rack, from: view.current, trusted, beforeRan: false, at: stamp };
    rcPending.set(f, p);
    rcThisRun.add(f);
    // Written before before runs: a run that dies from here on leaves it, and the next run owes after.
    await savePending(rcEnv, p);
    // The stop task decides at the stop whether after is owed (before ran, the upgrade started, or a verdict says run).
    oweAfter(p);
    if (rc.before) {
      p.beforeRan = true;
      await savePending(rcEnv, p);
      if (!(await runHook(rcEnv, rc, "before"))) {
        log.push(`  ${f}: not upgraded — its release check's before failed`);
        return 1;
      }
    }
    // On the record before the upgrade: from here a stop or an error before the verdict owes after, before or not.
    // Owed only once written: a write that fails stops the upgrade, and a run that upgraded nothing owes none.
    await savePending(rcEnv, { ...p, upgradeStarted: true });
    p.upgradeStarted = true;
    const code = (await x([cfg.brew, "upgrade", full], { env: installEnv })).rc;
    if (code === 0) {
      const now = await brewView(rcEnv.exec, cfg.brew, full);
      if (now?.current && now.current === p.from) {
        // brew exited 0 without changing the version in use (another updater installed the candidate
        // first, or brew had nothing to do): no upgrade, so no check and no rollback (the version in
        // use may be the only keg). after is owed as for an upgrade that did not complete.
        p.unchanged = true;
        await savePending(rcEnv, p);
        log.push(`  release check ${f}: brew upgrade exited 0 but ${f} is still ${p.from} — no upgrade, no check`);
      } else {
        p.upgraded = true;
        if (now?.current) p.to = now.current;
        await savePending(rcEnv, p);
        log.push(`  release check ${f}: ${p.from || "?"} → ${p.to ?? "?"}, the previous keg kept until the check decides`);
      }
    }
    return code;
  }

  /** A release check's owner jobs, inline, as the waiter does them: failed, busy, or ok. */
  async function ownerJobs(jobs: QueuedOwner[]): Promise<{ kind: "ok" | "busy" | "failed"; note: string }> {
    if (!jobs.length) return { kind: "ok", note: "" };
    const env: OwnerWaiterEnv = {
      exec: waiterEnv.exec, readFile: fs.readFile, writeFile: fs.writeFile, remove: fs.remove, listDir: fs.listDir, isDir: fs.isDir,
      ...(fs.appendFile ? { appendFile: fs.appendFile } : {}),
      now: clock.now, sleep: clock.sleep, httpStatus: clock.httpStatus, takeLock: async () => true, releaseLock: async () => {},
      log: (l) => log.push(`    owner: ${l}`),
    };
    const ops = ownerOps(env, { dir: ownerDir(cfg.stateDir), lsof: cfg.lsof });
    let kind: "ok" | "busy" | "failed" = "ok";
    const lines: string[] = [];
    for (const q of jobs) {
      // Restarted even when an earlier run's restart of it failed: the check needs it restarted.
      const r = await ops.job(q, { ignoreFailed: true });
      const line = r.line ?? `${q.label} not restarted`;
      log.push(`  release check owner: ${line}`);
      lines.push(line);
      // An owner gone before its restart was never restarted: a failure, never ok.
      if (r.kind === "failed" || r.kind === "skipped" || r.kind === "not-running") kind = "failed";
      else if (r.kind === "busy" && kind === "ok") kind = "busy";
    }
    return { kind, note: lines.join(", ") };
  }

  async function releaseChecksSection() {
    if (!rcPending.size) return;
    log.push("", "--- release checks ---");
    try {
    for (const p of [...rcPending.values()]) {
      const f = p.formula;
      // Each record on its own: one that throws is logged and notified, and the rest (their owed after too) go on.
      try {
      const rc = findCheck(cfg.releaseChecks, f);
      if (dryRun) {
        log.push(`  dry-run: release check ${f} ${p.to ?? "?"} pending — would restart its owner and run the check${rc?.after && afterOwed(p) ? `, then after [${asUser(rc, rc.after).join(" ")}]` : ""}`);
        continue;
      }
      if (!rc) {
        log.push(`  release check ${f}: no longer configured — its record is removed`);
        await fs.remove(pendingPath(cfg.stateDir, f));
        continue;
      }
      let keep = false;
      let locked = false;
      const lockPath = ownerFiles(ownerDir(cfg.stateDir)).lock;
      try {
        if (p.ended) {
          b.rcNotes.push(`${f}: after owed by an earlier run`);
          continue;
        }
        // A record that names no version change (to === from, as written before this was checked) is no upgrade.
        if (p.to && p.to === p.from && !p.verdict) {
          p.unchanged = true;
          delete p.to;
          delete p.upgraded;
        }
        if (!p.to && p.from && !p.unchanged) {
          // A stopped run may have upgraded without recording it.
          const v = await brewView(rcEnv.exec, cfg.brew, p.full);
          if (v?.current && v.current !== p.from) p.to = v.current;
        }
        // Answers read while stopping are not answers: nothing is decided from them.
        if (stoppingNow()) continue;
        if (!p.to || !p.from) {
          if (p.unchanged) {
            // No version change: nothing to check and nothing to roll back to. Notified: the version
            // in use may have come from another updater, unchecked.
            const why = `release check ${f}: not run — brew upgrade exited 0 but the version in use is still ${p.from}`;
            log.push(`  ${why}`);
            b.rcNotes.push(`${f} upgrade changed nothing (still ${p.from}), no check`);
            await notify(`⚠️ <b>${host} ${why}</b>\nNo upgrade to check: nothing is rolled back, ${p.from} is kept.\nLog: ${cfg.logFile ?? "-"}`);
          } else if (p.upgraded || p.to) {
            // Never a silent skip: no verdict, said so.
            const why = `release check ${f}: not run — the installed version could not be read (before ${p.from || "?"}, after ${p.to || "?"})`;
            log.push(`  ${why}`);
            b.failed.push(`release-check:${f}`);
            b.flagged = true;
            b.rcNotes.push(`${f} not checked, versions unreadable`);
            p.after = "run";
            await notify(`⚠️ <b>${host} ${why}</b>\nNo verdict: the new version is kept.\nLog: ${cfg.logFile ?? "-"}`);
          } else {
            log.push(`  release check ${f}: the upgrade did not complete — no check`);
            b.rcNotes.push(`${f} not upgraded, no check`);
          }
          p.ended = true;
          continue;
        }
        const to = p.to;
        // A confirmed fail is held from the moment it is decided, its rollback waiting or not.
        if (p.verdict === "fail" && !p.rolledBack && (await readHold(rcEnv, f))?.version !== to) await holdFailed(rcEnv, p as PendingCheck & { to: string });
        /**
         * This run's wait for the owner, counted on the record (every reason alike: the scan did not
         * run or did not look, a stale process unresolved, the waiter's lock, a busy owner). At the
         * limit an undecided check ends with no verdict (notified, the new version kept, after owed);
         * a decided one is never ended by it: it is notified and goes on waiting.
         */
        const ownerWait = async (why: string, note: string) => {
          p.unresolvedWaits = (p.unresolvedWaits ?? 0) + 1;
          await savePending(rcEnv, p);
          const n = p.unresolvedWaits;
          if (n < UNRESOLVED_WAIT_RUNS || (p.verdict && n > UNRESOLVED_WAIT_RUNS) || stoppingNow()) {
            keep = true;
            log.push(`  release check ${f}: ${why} — the check waits for a later run (${n}/${UNRESOLVED_WAIT_RUNS})`);
            b.rcNotes.push(`${f} ${to} check waits for its owner (${note})`);
            return;
          }
          if (p.verdict) {
            keep = true;
            const said = `release check ${f} ${to}: ${p.verdict === "fail" ? "FAIL decided, its rollback" : "its verdict"} has waited ${n} runs — ${why}`;
            log.push(`  ${said}`);
            b.failed.push(`release-check:${f}`);
            b.flagged = true;
            b.rcNotes.push(`${f} ${to} still waits for its owner (${note})`);
            await notify(`⚠️ <b>${host} ${said}</b>\nStill waiting: each run tries again.\nLog: ${cfg.logFile ?? "-"}`);
            return;
          }
          const said = `release check ${f} ${to}: not run — ${why} for ${n} runs`;
          log.push(`  ${said}`);
          b.failed.push(`release-check:${f}`);
          b.flagged = true;
          b.rcNotes.push(`${f} ${to} not checked, ${note} for ${n} runs`);
          await notify(`⚠️ <b>${host} ${said}</b>\nNo verdict: ${to} is kept.\nLog: ${cfg.logFile ?? "-"}`);
          // No verdict, the new version kept: after is owed as for a check that could not run, before or not.
          p.after = "run";
          // A notice made while stopping was not sent: the next run ends it.
          if (stoppingNow()) keep = true;
          else p.ended = true;
        };
        // An owner restart still ahead of an undecided check needs the stale-keg scan's view of who
        // runs the kegs it must leave. A decided verdict is never held back by it: a persisted FAIL goes
        // on to its rollback and hold. Whether a process is on such a keg right before any check is
        // the pre-check gate's to see (resume), whatever an earlier run's restart did.
        const restartAhead = !p.verdict && !p.ownerRestarted;
        if (cfg.staleOwners?.length && restartAhead && (!rcScanned || rcScannedRacks.get(p.rack) !== expectedKeg(p))) {
          // Not scanned for: the scan failed, or the installed version was read only after it.
          const unseen = rcScanned ? "the stale-keg scan did not look at its previous keg" : "the stale-keg scan did not run";
          await ownerWait(unseen, unseen);
          continue;
        }
        // A process on a keg the owner must leave whose owner the scan could not find: as unscanned,
        // unless the check names its owners: they are restarted and the gate scans before the check.
        if (cfg.staleOwners?.length && restartAhead && !rc.owners?.length && [...rcUnresolved].some((k) => retiredFor(p, k))) {
          await ownerWait("a process on its previous keg has no owner the stale-keg scan could find", "a stale process on its previous keg is unresolved");
          continue;
        }
        // No waiter restarts anything while this formula's owner is restarted and checked: its lock,
        // waited for (bounded), and the label's own queued job removed.
        if (cfg.staleOwners?.length || rc.owners?.length) {
          const t0 = clock.now();
          for (;;) {
            if (await ownerLock.take(lockPath)) {
              locked = true;
              break;
            }
            if (clock.now() - t0 >= LOCK_WAIT_MS) break;
            await clock.sleep(5_000);
          }
          if (!locked) {
            await ownerWait("the owner restart waiter held its lock past the bound", "the owner restart waiter holds its lock");
            continue;
          }
          for (const q of await requiredJobs(f, join(p.rack, p.rolledBack ? to : p.from))) await fs.remove(join(ownerFiles(ownerDir(cfg.stateDir)).queue, `${encodeURIComponent(q.target)}.json`));
        }
        // The record itself: each step resume writes is this record's.
        const d = await resume(rcEnv, rc, p as PendingCheck & { to: string }, {
          save: async () => savePending(rcEnv, p),
          stopping: stoppingNow,
          restartOwner: async (phase) => {
            const keg = join(p.rack, phase === "new" ? p.from : to);
            const into: string[] = [];
            if (phase === "restored") await restartUpgraded({ exec: x, exists: fs.exists, spawnDetached: fs.spawnDetached, home: fs.home, uid: fs.uid }, [p.formula], { ...restartOpts, into });
            // The version the owners must run after the restart: every other keg of the formula is stale.
            const expect = join(p.rack, phase === "new" ? to : p.from);
            const jobs = await requiredJobs(f, keg, expect);
            // The whole set on the record before any restart: a resumed rollback restarts the same owners.
            const all = mergeOwners(p.owners ?? [], jobs);
            if (all.length !== (p.owners ?? []).length) {
              p.owners = all;
              await savePending(rcEnv, p);
            }
            const o = await ownerJobs(jobs);
            const kind = into.some((s) => s.includes("FAILED")) ? "failed" : o.kind;
            // Whether a process is left on a keg it must leave is the pre-check gate's to see.
            return { kind, note: [...into, o.note].filter(Boolean).join(", ") || "nothing to restart" };
          },
          scan: (expect) => kegPids(p.rack, expect),
        });
        if (d.wait) await ownerWait(`its owner could not be restarted yet (${d.waitWhy ?? "busy"})`, d.waitWhy ?? "busy");
        else if (d.note) b.rcNotes.push(d.note);
        if (d.failed) {
          b.failed.push(d.failed);
          b.flagged = true;
        }
      } finally {
        if (locked) {
          try {
            await ownerLock.release(lockPath);
          } catch (e) {
            log.push(`  WARNING: release check ${f}: the owner lock could not be released (${errText(e)})`);
          }
        }
        // A stop under way: the stop task owns after; the record resumes from its last step.
        if (stoppingNow()) log.push(`  release check ${f}: oupdate is stopping — after is left to the stop path, the record to the next run`);
        else {
          const owed = !!rc.after && afterOwed(p);
          if (owed) {
            let ran = false;
            try {
              ran = await runHook(rcEnv, rc, "after");
            } catch (e) {
              log.push(`  release check ${f}: after FAILED (${errText(e)})`);
            }
            if (ran) {
              p.afterRan = true;
              // On the record before anything else can fail (the record's removal too): after never runs twice.
              await savePending(rcEnv, p);
            } else b.failed.push(`release-check-after:${f}`);
          } else if (rc.after && p.after === "skip") log.push(`  release check ${f}: after not run — the host stays as before left it`);
          // A stop that arrived during after (it was killed) leaves the record to the stop path too.
          if (!stoppingNow()) {
            rcStopOff.get(f)?.();
            rcStopOff.delete(f);
            if (keep && p.afterRan) {
              // Waiting: after ran for this run's before. afterRan stays, so a later verdict owes none.
              p.beforeRan = false;
            }
            // The record goes only once the check is over and no after is owed.
            if (p.ended && !(owed && !p.afterRan)) {
              await fs.remove(pendingPath(cfg.stateDir, f));
              rcPending.delete(f);
            } else await savePending(rcEnv, p);
          }
        }
      }
      } catch (e) {
        const why = `release check ${f}: FAILED (${errText(e)})`;
        log.push(`  ${why}`);
        b.failed.push(`release-check:${f}`);
        b.flagged = true;
        b.rcNotes.push(`${f} release check error`);
        try {
          await notify(`⚠️ <b>${host} ${why}</b>\nOther release checks go on.\nLog: ${cfg.logFile ?? "-"}`);
        } catch {
          // Logged above.
        }
      }
    }
    } finally {
      // Other owners queued while a release check was unfinished: their waiter starts now.
      if (waiterDeferred && !dryRun) {
        const labels = waiterDeferred;
        waiterDeferred = "";
        if (!opts.ownerWaiterArgv?.length) log.push(`  owner restart waiter FAILED: no waiter command here, ${labels} queued but not started`);
        else {
          try {
            const pid = await fs.spawnDetached(opts.ownerWaiterArgv, join(cfg.stateDir, "restart.log"));
            log.push(`  owner restart waiter started (pid ${pid}) for ${labels}, after the release checks`);
          } catch (e) {
            log.push(`  owner restart waiter FAILED to start (${e instanceof Error ? e.message : String(e)}), ${labels} queued`);
          }
        }
      }
    }
  }

  /**
   * The processes mapping a keg of the formula (its rack) other than `expect` now (a fresh lsof), or
   * undefined when the processes cannot be read.
   */
  async function kegPids(rack: string, expect: string): Promise<Holder[] | undefined> {
    const maps = await lsofMaps({ exec: x } as KegEnv, cfg.lsof, log, true);
    return maps === undefined ? undefined : kegHolders(maps, dirname(rack)).filter((h) => dirname(h.keg) === rack && h.keg !== expect);
  }

  /**
   * The owner jobs a release check needs restarted off `keg`: those the stale-keg check found on it,
   * and the formula's own launchd service when its label matches staleOwners (found or not: a
   * service that is not running then is a restart failure, never a pass). Only no staleOwners match
   * means no owner restart is needed. `expect`: the keg they must run after it (see QueuedOwner).
   */
  async function requiredJobs(f: string, keg: string, expect?: string): Promise<QueuedOwner[]> {
    // This run's scan and every owner the record names (an earlier run's scan): all required, as a
    // shell or supervisor maps no keg while its child runs the old one.
    const found = mergeOwners(rcJobs.get(f) ?? [], rcPending.get(f)?.owners ?? []);
    const jobs: QueuedOwner[] = found.map((q) => {
      const { expect: _, ...base } = q.keg === keg ? q : { ...q, pid: "?", keg };
      return { ...base, required: true, ...(expect ? { expect } : {}) };
    });
    for (const label of [`sh.brew.${f}`, `homebrew.mxcl.${f}`]) {
      const where = (await fs.exists(`/Library/LaunchDaemons/${label}.plist`)) ? "system" : (await fs.exists(`${fs.home}/Library/LaunchAgents/${label}.plist`)) ? `gui/${fs.uid}` : "";
      if (!where) continue;
      const owner = matchOwner(cfg.staleOwners, label);
      const target = `${where}/${label}`;
      if (owner && !jobs.some((q) => q.target === target)) {
        jobs.push({ label, target, pid: "?", keg, required: true, ...(expect ? { expect } : {}), ...(owner.probe ? { probe: owner.probe } : {}), ...(owner.health ? { health: owner.health } : {}),
          ...(owner.restart ? { restart: owner.restart } : {}), ...(owner.healthWithinSec ? { healthWithinSec: owner.healthWithinSec } : {}) });
      }
      break;
    }
    // The check's named owners: always required, matched literally, with the staleOwners entry's probe/health/restart when one matches.
    for (const label of findCheck(cfg.releaseChecks, f)?.owners ?? []) {
      const where = (await fs.exists(`/Library/LaunchDaemons/${label}.plist`)) ? "system" : (await fs.exists(`${fs.home}/Library/LaunchAgents/${label}.plist`)) ? `gui/${fs.uid}` : "system";
      const target = `${where}/${label}`;
      const had = jobs.findIndex((q) => q.label === label);
      if (had >= 0) {
        jobs[had] = { ...jobs[had]!, required: true };
        continue;
      }
      const owner = matchOwner(cfg.staleOwners, label);
      jobs.push({ label, target, pid: "?", keg, required: true, ...(expect ? { expect } : {}), ...(owner?.probe ? { probe: owner.probe } : {}), ...(owner?.health ? { health: owner.health } : {}),
        ...(owner?.restart ? { restart: owner.restart } : {}), ...(owner?.healthWithinSec ? { healthWithinSec: owner.healthWithinSec } : {}) });
    }
    return jobs;
  }

  async function appBundlesSection() {
    if (!cfg.appBundles.length) return;
    log.push("", "--- app bundles ---");
    const net = opts.appNet ?? realAppNet;
    const env = { ...net, exec: x, git: tbEnv.git, spawnDetached: fs.spawnDetached };
    for (const app of cfg.appBundles) {
      const res = await appBundleUpgrade(env, r, app, {
        dryRun, host, logFile: cfg.logFile, stateDir: cfg.stateDir, notify, caps: cfg.caps, detachedLog: join(cfg.stateDir, "restart.log"),
      });
      log.push(...res.log);
      if (res.status === "held") b.flagged = true;
      else if (res.status === "failed") {
        b.flagged = true;
        b.failed.push(`app:${app.name}`);
      }
      if (res.note) b.appNotes.push(res.note);
    }
  }

  async function casksSection() {
    if (!b.deferredCasks.length) return;
    log.push("", "--- deferred Type A casks ---");
    const gk = opts.gk ?? (await (async (): Promise<GkOps> => {
      const env = await gkEnv(cfg, x);
      if (!env) return gkUnchecked;
      const o: GkOptions = { dryRun, host, logFile: cfg.logFile, notify };
      return { snapshot: (k) => gkSnapshot(env, k), release: (k, p) => gkRelease(env, k, o, { prior: p }), check: (k) => gkCheck(env, k, o) };
    })());
    try {
      // One at a time: a batch upgrade fails whole when any one cask fails.
      for (const cask of b.deferredCasks) {
        b.caskTried.add(cask);
        // A pkg or kext artifact needs sudo, which an unattended run does not have.
        const info = await x([cfg.brew, "info", "--json=v2", "--cask", cask]);
        let needsSudo = false;
        let apps: string[] = [];
        try {
          const arts = (JSON.parse(info.out) as { casks?: { artifacts?: unknown[] }[] }).casks?.[0]?.artifacts ?? [];
          apps = arts.flatMap((a) => (a && typeof a === "object" && Array.isArray((a as { app?: unknown }).app) ? (a as { app: unknown[] }).app : [])).filter((n): n is string => typeof n === "string").map((n) => `/Applications/${n}`);
          needsSudo = arts.some((a) => !!a && typeof a === "object" && ("pkg" in a || "kext" in a));
        } catch {
          needsSudo = false;
        }
        if (needsSudo) {
          log.push(`  skip ${cask} — needs sudo (pkg/kext); flagged for manual upgrade`);
          b.casksSudo.push(cask);
          continue;
        }
        // An upgrade removes the cask's binaries and app: one with a process running from it waits for the next run.
        const room = (await x([cfg.brew, "--caskroom"])).out.trim();
        const maps = room.startsWith("/") ? await lsofMaps({ exec: x } as KegEnv, cfg.lsof, log) : undefined;
        const pids = maps === undefined ? [] : caskRunning(maps, room, cask, apps);
        if (pids.length) {
          log.push(`  ${cask}: deferred — a process is running from it (pid ${pids.join(" ")}); retried next run`);
          b.casksRunning.push(cask);
          continue;
        }
        log.push(`  upgrading ${cask}...`);
        // The snapshot is taken before the upgrade replaces what it reads.
        const prior = await gk.snapshot(cask);
        if ((await x([cfg.brew, "upgrade", "--cask", "--greedy", cask], { env: installEnv })).rc === 0) {
          b.casksUp.push(cask);
          log.push(...(await gk.release(cask, prior)));
          const c = await gk.check(cask);
          log.push(...c.log);
          if (c.note) b.gkNotes.push(c.note);
        } else {
          log.push(`  ${cask}: upgrade FAILED`);
          b.casksFailed.push(cask);
          await brewFailed(cask);
        }
      }
    } finally {
      if (b.casksFailed.length) {
        b.flagged = true;
        await notify(`⚠️ <b>${host} casks FAILED</b>\ncasks: ${b.casksFailed.join(" ")}\nLog: ${cfg.logFile ?? "-"}`);
        log.push(`deferred casks failed: ${b.casksFailed.join(" ")}`);
      }
      if (b.casksSudo.length) {
        await notify(`ℹ️ <b>${host} casks need manual upgrade (sudo)</b>\n${b.casksSudo.join(" ")}\nUpgrade interactively: brew upgrade --cask --greedy ${b.casksSudo.join(" ")}\nLog: ${cfg.logFile ?? "-"}`);
      }
    }
  }
}
