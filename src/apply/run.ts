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

import { DEFAULT_COMPAT } from "../targets/compat.ts";
import { basename, dirname, join } from "node:path";
import { isStopping as execStopping, onStop } from "./exec.ts";
import type { Reviewer } from "../review.ts";
import { makeReviewer } from "../adapters/reviewer/spec.ts";
import type { ApplyConfig } from "./config.ts";
import type { Exec } from "./exec.ts";
import type { BrewFormulaInfo } from "./formula.ts";
import type { ApplyFs } from "./fs.ts";
import { gkCheck, gkRelease, gkRevert, realGates, type GkOptions } from "./gatekeeper.ts";
import { linkageCheck, relinkUpgraded, type KegEnv } from "./kegs.ts";
import { type NpmRun } from "./npm.ts";
import { ownerDir, ownerWaiterReport, realHttpStatus, realReleaseLock, realTakeLock, type QueuedOwner } from "./owner-waiter.ts";
import { brewView, findCheck, shortName, loadPending, runHook, savePending, type PendingCheck, type ReleaseEnv } from "./release-checks.ts";
import { heldFromPinned } from "./pins.ts";
import { restartUpgraded } from "./restarts.ts";
import { pendingFromOutdated, trackStuck } from "./stuck.ts";
import { awaitingTapApproval, typeBUpgrades, type TypeBEnv, type TypeBOptions } from "./typeb.ts";
import { handoff, waiterReport, type DeferredService, type WaiterEnv } from "./waiter.ts";
import { brewSection, casksSection, appBundlesSection, cleanup, gkEnv } from "./run-brew.ts";
import { releaseChecksSection } from "./run-release.ts";
import { claudeCodeStep, finishRun, npmStep, postUpgradeChecks, staleKegStep } from "./run-steps.ts";
import { PhaseTimeout, last, makeNotify, newBrewState, type ApplyOptions, type ApplyResult, type RunCtx, type RunState } from "./run-ctx.ts";
export { runsUnderBrewBun, holdRunningBun, named, makeNotify } from "./run-ctx.ts";
export type { GkOps, ApplyOptions, ApplyResult } from "./run-ctx.ts";

const p2 = (n: number) => String(n).padStart(2, "0");
const day = (d: Date) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;

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

const unavailable: Reviewer = {
  name: "none",
  review: async () => {
    throw new Error("no reviewer configured");
  },
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
  const b = newBrewState(dryRun);
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
  const st: RunState = { rcScanned: false, rcUnresolved: new Set(), rcScannedRacks: new Map(), waiterDeferred: "", owners: { note: "", busy: new Set(), failed: new Set() } };
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
  /** A keg of the record's rack other than the one its owners must run. */
  const retiredFor = (p: PendingCheck, keg: string) => dirname(keg) === p.rack && keg !== expectedKeg(p);
  /** Gated formulae outdated (held ones too) or not installed this run: an upgrade that depends on one waits. */
  const gatedOutdated: string[] = [];
  const ownerLock = opts.ownerLock ?? { take: realTakeLock, release: realReleaseLock };
  const clock = opts.ownerClock ?? { now: () => Date.now(), sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)), httpStatus: realHttpStatus };
  const restartOpts = {
    deferred: cfg.deferred, helper: cfg.restartHelper, labelRestart: cfg.labelRestart, staleKegUnlisted: cfg.staleKegUnlisted, detachedLog: join(cfg.stateDir, "restart.log"), ownerHanded,
    staleOwners: cfg.staleOwners,
  };

  const rt: RunCtx = {
    opts, cfg, fs, exec, dryRun, now, host, r, tb, log, stamp, b, brewHeld, x, notify, step, tbEnv, tbOpts, brewFailed, quarantined, installEnv,
    rcEnv, rcPending, rcBroken, rcThisRun, rcJobs, mergeOwners, rcStopOff, stoppingNow, afterOwed, oweAfter, expectedKeg, retiredFor, gatedOutdated,
    ownerLock, clock, restartOpts, waiterEnv, kegEnv, ownerHanded, track, recoverTo, releaseRacks, npmFailed, st,
  };

  // ── waiter report: a drain a dead waiter left behind is recovered before any long brew build ──
  await step("brew", "waiter report", async () => {
    const notes: string[] = [];
    for (const s of cfg.deferred) {
      const n = await waiterReport(waiterEnv, s, dryRun);
      if (n) notes.push(n);
    }
    // The owner restart waiter's last outcome, and the labels it failed (not queued again).
    if (cfg.staleOwners?.length) {
      st.owners = await ownerWaiterReport(fs, ownerDir(cfg.stateDir), dryRun);
      if (st.owners.note) notes.push(st.owners.note);
    }
    b.waiterNote = notes.join("; ");
  });

  // ── brew ──
  await step("brew", "brew", async () => {
    try {
      await brewSection(rt);
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
    if (!dryRun && b.started && !b.noBrew) await cleanup(rt);
  });
  await step("brew", "deferred casks", () => casksSection(rt));
  await step("brew", "app bundles", () => appBundlesSection(rt));
  await step("brew", "stale-keg check", () => staleKegStep(rt));
  await step("brew", "release checks", () => releaseChecksSection(rt));
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
  // The phase's record is ours and its lines are the run's: a stop part-way keeps both.
  const npmRun: NpmRun = { log, pending: [], upgraded: [] };
  const npmStatus = await npmStep(rt, npmRun);
  const ccPart = await claudeCodeStep(rt);
  await postUpgradeChecks(rt, npmRun);

  if (stuckDirty && stuckState !== undefined) {
    try {
      await fs.writeFile(stuckFile, stuckState);
    } catch (e) {
      log.push(`  WARNING: could not write ${stuckFile} (${e instanceof Error ? e.message : "error"})`);
      b.failed.push("stuck-state-not-saved");
    }
  }
  if (stuckBroken) b.failed.push("stuck-state-unreadable");

  return finishRun(rt, { npmRun, npmStatus, ccPart, prevName });
}
