// The host apply run, ported from secure-update's host script: the brew phase, then the npm phase,
// then one summary block in secure-update's own format ("=== <host> summary ===", "  brew: ...",
// "  npm:  ..."), so the host shadow parser (src/host/su-log.ts) and the fleet digest read it
// unchanged, then the end-of-run notice.
//
// Order: waiter report → brew (update → outdated → excludes and pins → tap tiers → Type A review
// → Type A upgrades → Type B) → relink and restarts → cleanup → deferred casks with Gatekeeper
// (snapshot before each upgrade; release, then check after it) → stale keg → linkage → stuck →
// npm.
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
// The Claude Code native update (secure-update's claude_step) runs in the npm phase after npm,
// when apply.claudeCode names an executable binary.

import { basename, join } from "node:path";
import { isStopping as execStopping } from "./exec.ts";
import type { Reviewer } from "../review.ts";
import { makeReviewer } from "../adapters/reviewer/spec.ts";
import type { ApplyConfig } from "./config.ts";
import type { Exec } from "./exec.ts";
import type { BrewFormulaInfo } from "./formula.ts";
import type { ApplyFs } from "./fs.ts";
import { gkCheck, gkRelease, gkRevert, gkSnapshot, realGates, type GkEnv, type GkOptions, type GkPrior } from "./gatekeeper.ts";
import { caskRunning, linkageCheck, lsofMaps, relinkUpgraded, staleKegCheck, type KegEnv } from "./kegs.ts";
import { npmSection, type NpmRun } from "./npm.ts";
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
  /** Test seams, as secure-update's tests mocked these functions. */
  gk?: GkOps;
  typeB?: { upgrades: typeof typeBUpgrades; awaiting: typeof awaitingTapApproval };
}

export interface ApplyResult {
  /** The run body, as secure-update logged it, and the end-of-run notice after the summary. */
  log: string[];
  /** The summary block. */
  summary: string[];
  rc: 0 | 1;
}

class PhaseTimeout extends Error {}

const p2 = (n: number) => String(n).padStart(2, "0");
const day = (d: Date) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
const words = (s: string) => s.split(/\s+/).filter(Boolean);
const uniq = (xs: string[]) => [...new Set(xs)];
const last = (n: string) => n.split("/").at(-1)!;
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
  // A dry run's header is not secure-update's, so the shadow parser never takes it for a run.
  log.push(dryRun ? `=== oupdate dry run ${host} ${stamp} ===` : `=== oupdate-secure-update ${host} ${stamp} ===`);
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
  };
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
    // secure-update did), not a stop of the stale-keg step.
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
  const tbOpts: TypeBOptions = { officialTaps: cfg.officialTaps, host, logFile: cfg.logFile, notify, caps: cfg.caps };

  const brewFailed = async (name: string) => {
    b.failed.push(name);
    b.flagged = true;
    log.push(`  ${name}: FAILED — continuing`);
    await notify(`${host} brew FAILED: ${name}; log: ${cfg.logFile ?? "-"}`);
  };
  let quarantined: DeferredService | undefined;
  for (const s of cfg.deferred) if (!quarantined && (await fs.exists(s.quarantineFile))) quarantined = s;
  const installEnv = { HOMEBREW_NO_INSTALLED_DEPENDENTS_CHECK: "1", ...(quarantined ? { HOMEBREW_NO_INSTALL_CLEANUP: "1" } : {}) };

  // ── waiter report: a drain a dead waiter left behind is recovered before any long brew build ──
  await step("brew", "waiter report", async () => {
    const notes: string[] = [];
    for (const s of cfg.deferred) {
      const n = await waiterReport(waiterEnv, s, dryRun);
      if (n) notes.push(n);
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
    await restartUpgraded({ exec: x, exists: fs.exists, spawnDetached: fs.spawnDetached, home: fs.home, uid: fs.uid }, b.upgraded, {
      deferred: cfg.deferred, helper: cfg.restartHelper, labelRestart: cfg.labelRestart, staleKegUnlisted: cfg.staleKegUnlisted, detachedLog: join(cfg.stateDir, "restart.log"), into: b.restarted, ownerHanded,
    });
    if (b.restarted.length) log.push(`restarted: ${b.restarted.join(" ")}`);
  });
  await step("brew", "cleanup", async () => {
    if (!dryRun && b.started && !b.noBrew) await cleanup();
  });
  await step("brew", "deferred casks", casksSection);
  await step("brew", "stale-keg check", async () => {
    if (b.noBrew) return;
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
      ownerHanded,
      detachedLog: join(cfg.stateDir, "restart.log"),
      trackStuck: (still) => track("stale-keg", still) ?? [],
      log,
    });
    b.staleNote = s.note;
  });
  await step("brew", "linkage check", async () => {
    if (b.noBrew) return;
    const l = await linkageCheck(kegEnv, { brew: cfg.brew, host, logFile: cfg.logFile, notify, log });
    b.linkageNote = l.note;
  });
  await step("brew", "stuck tracking", async () => {
    if (dryRun || b.noBrew) return;
    const q = await x([cfg.brew, "outdated", "--json=v2", "--greedy-auto-updates", ...(b.fetchHead ? ["--fetch-HEAD"] : [])]);
    const pending = q.rc === 0 ? pendingFromOutdated(q.out, [...cfg.caskExclude, ...heldFromPinned(b.pinned)]) : undefined;
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

  // ── Claude Code (native), secure-update's claude_step ──
  // The native build updates itself in place; the background updater stays off fleet-wide, so this
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
  if (!dryRun && !opts.isStopping?.()) await notify(`📋 <b>${host} secure-update done (oupdate)</b>\nbrew: ${brewStatus}\nnpm:  ${npmLine}\nmas:  ${mas}`);
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
      b.stuck.length ? `STUCK: ${b.stuck.join(" ")}` : "",
      b.pinned.length ? `PINNED: ${b.pinned.join(" ")}` : "",
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
    const hide = [...cfg.caskExclude, ...heldFromPinned(b.pinned)];
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
      if (!typeA.length && !keptCasks.length) log.push("Type A: nothing left to upgrade after holds");
      else if (dryRun) log.push(`dry-run: would upgrade Type A formulas=[${typeA.join(" ")}] casks=[${keptCasks.join(" ")}]`);
      else {
        // Recorded before the formula upgrades, so a stop part-way still leaves the casks to their phase.
        if (keptCasks.length) {
          b.deferredCasks = keptCasks;
          log.push(`Type A casks deferred until end of run: ${keptCasks.join(" ")}`);
        }
        for (const pkg of typeA) {
          if ((await x([cfg.brew, "upgrade", pkg], { env: installEnv })).rc === 0) b.upgraded.push(pkg);
          else await brewFailed(pkg);
        }
      }
    }

    // 6. Type B: per-package review, then a guarded install. Its record is ours, filled as it goes.
    if (typeBPairs.length) {
      const into: TypeBRun = { upgraded: b.upgraded, upgradedFull: [], failed: b.failed, flagged: false, log };
      try {
        await tb.upgrades(tbEnv, r, typeBPairs, {
          ...tbOpts,
          dryRun,
          into,
          upgrade: async (full) => (await x([cfg.brew, "upgrade", full], { env: installEnv })).rc,
        });
      } finally {
        if (into.flagged) b.flagged = true;
      }
    }
  }

  async function cleanup() {
    log.push("--- brew cleanup ---");
    if (quarantined) {
      // Keep the reviewed keg the running service is on: clean everything else by name.
      const name = quarantined.name;
      const fl = await x([cfg.brew, "list", "--formula", "--full-name"]);
      const cl = await x([cfg.brew, "list", "--cask"]);
      const keep = [...words(fl.out), ...words(cl.out)].filter((n) => last(n) !== name);
      log.push(`  ${name} quarantined — cleanup skips ${name}`);
      if (keep.length) log.push(...(await x([cfg.brew, "cleanup", ...keep])).out.trimEnd().split("\n").slice(-5));
      return;
    }
    log.push(...(await x([cfg.brew, "cleanup"])).out.trimEnd().split("\n").slice(-5));
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
