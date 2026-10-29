// What the host apply run's steps share (run.ts drives them; run-brew.ts and run-release.ts hold the steps): the
// option and result types, the run's context and brew bookkeeping, and the small name helpers.

import { realpathSync } from "node:fs";
import type { AppNet } from "./appbundle.ts";
import type { Reviewer } from "../review.ts";
import type { ApplyConfig } from "./config.ts";
import type { Exec } from "./exec.ts";
import type { ApplyFs } from "./fs.ts";
import type { KegEnv } from "./kegs.ts";
import type { GkPrior } from "./gatekeeper.ts";
import type { OwnerReport, QueuedOwner } from "./owner-waiter.ts";
import type { PendingCheck, ReleaseEnv } from "./release-checks.ts";
import { restartUpgraded } from "./restarts.ts";
import { awaitingTapApproval, typeBUpgrades, type TypeBEnv, type TypeBOptions } from "./typeb.ts";
import type { DeferredService, WaiterEnv } from "./waiter.ts";

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

export class PhaseTimeout extends Error {}

export const words = (s: string) => s.split(/\s+/).filter(Boolean);
/**
 * `brew deps` flags for what an upgrade may install: the candidate's declared dependencies (any flag
 * here turns off the installed keg's runtime list), recursive, with build (a source build) and
 * optional (an install's --with options) ones.
 */
export const DECLARED_DEPS = ["--include-build", "--include-optional"];
/** A formula or cask name, bare or tap-qualified, as `brew deps` lists it. */
export const PKG_NAME = /^[\w@.+-]+(\/[\w@.+-]+){0,2}$/;
export const uniq = (xs: string[]) => [...new Set(xs)];
export const last = (n: string) => n.split("/").at(-1)!;

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
export const named = (entries: Iterable<string>, name: string) => {
  for (const e of entries) if (e === name || last(e) === last(name)) return true;
  return false;
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

export function newBrewState(dryRun: boolean) {
  return {
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
    /** `brew outdated --verbose`, as reviewed: the versions Type A approved. */
    verbose: "",
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
}

/** Mutable state the stale-keg step writes and the release checks read, shared across the run's steps. */
export interface RunState {
  /** The stale-keg scan read the processes this run: without it an owner on the previous keg goes unseen. */
  rcScanned: boolean;
  /** Kegs with a stale process the scan could not resolve to an owner: a check on one waits as if unscanned. */
  rcUnresolved: ReadonlySet<string>;
  /** The racks the stale-keg scan retired, with the keg each expected: a record not among them as it is now was not scanned for. */
  rcScannedRacks: ReadonlyMap<string, string>;
  /** Set when the stale-keg check queued other owners while a release check was unfinished: their waiter starts after the release checks. */
  waiterDeferred: string;
  /** The owner restart waiter's last outcome, and the labels it failed (not queued again). */
  owners: OwnerReport;
}

export type BrewState = ReturnType<typeof newBrewState>;

/** What the run's steps share: the config, the effects, the brew bookkeeping and the release-check state. */
export interface RunCtx {
  opts: ApplyOptions;
  cfg: ApplyConfig;
  fs: ApplyFs;
  exec: Exec;
  dryRun: boolean;
  now: Date;
  host: string;
  r: Reviewer;
  tb: NonNullable<ApplyOptions["typeB"]>;
  log: string[];
  stamp: string;
  b: BrewState;
  brewHeld: () => string[];
  x: Exec;
  notify: (text: string) => Promise<void>;
  step: (name: "brew" | "npm", label: string, f: () => Promise<void>) => Promise<void>;
  tbEnv: TypeBEnv;
  tbOpts: TypeBOptions;
  brewFailed: (name: string) => Promise<void>;
  quarantined: DeferredService | undefined;
  installEnv: Record<string, string>;
  rcEnv: ReleaseEnv;
  rcPending: Map<string, PendingCheck>;
  rcBroken: string[];
  rcThisRun: Set<string>;
  rcJobs: Map<string, QueuedOwner[]>;
  mergeOwners: (a: readonly QueuedOwner[], add: readonly QueuedOwner[]) => QueuedOwner[];
  rcStopOff: Map<string, () => void>;
  stoppingNow: () => boolean;
  afterOwed: (p: PendingCheck) => boolean;
  oweAfter: (p: PendingCheck) => void;
  expectedKeg: (p: PendingCheck) => string;
  retiredFor: (p: PendingCheck, keg: string) => boolean;
  gatedOutdated: string[];
  ownerLock: NonNullable<ApplyOptions["ownerLock"]>;
  clock: NonNullable<ApplyOptions["ownerClock"]>;
  restartOpts: Omit<NonNullable<Parameters<typeof restartUpgraded>[2]>, "into">;
  waiterEnv: WaiterEnv;
  kegEnv: KegEnv;
  /** Labels the restart step handed to their owner command: the stale-keg check never hands them again. */
  ownerHanded: Map<string, string>;
  /** Stuck tracking for a lane: the packages pending for the configured number of runs, undefined when the state is unreadable. */
  track: (lane: string, pending: string[]) => string[] | undefined;
  recoverTo: (p: PendingCheck, said: string) => Promise<void>;
  releaseRacks: () => Map<string, string>;
  npmFailed: string[];
  st: RunState;
}
