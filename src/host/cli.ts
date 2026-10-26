// oupdate host --report-only: one shadow report beside secure-update.
// Writes STATE/inventory.json (the snapshot the next run diffs against) and
// STATE/reports/<date>.json, then prints a summary with the weekly agreement streak.
//
// oupdate host --apply [--dry-run]: the host apply (src/apply/run.ts), from the "apply" object of
// the config file. --gatekeeper-approve CASK and --gatekeeper-revert CASK are the operator's
// one-offs for a cask's quarantine: no review, no upgrade. --stale-owners-waiter is the detached owner
// restart waiter the apply run starts (see apply/owner-waiter.ts); not meant to be run by hand.

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { homedir, hostname } from "node:os";
import type { Item } from "./collect.ts";
import { hostReport, type HostReport } from "./report.ts";
import { weeklyStreak } from "./compare.ts";
import { probeHost, type Runner } from "./probe.ts";
import type { AdvisoryFeed } from "../adapters/advisory/osv.ts";
import { parseApplyConfig, type ApplyConfig } from "../apply/config.ts";
import { killLive, runStopTasks, type Exec } from "../apply/exec.ts";
import type { ApplyFs } from "../apply/fs.ts";
import { applyHost, gatekeeperAction } from "../apply/run.ts";
import { ownerDir, realHttpStatus, realReleaseLock, realTakeLock, runOwnerWaiter } from "../apply/owner-waiter.ts";
import { realFs } from "../apply/fs.ts";
import { parseLaunchdArgs, type LaunchdArgs } from "./launchd.ts";

export interface HostArgs {
  host: string;
  state: string;
  suLog: string;
}

const FLAGS = new Set(["--host", "--state", "--su-log"]);

export function parseHostArgs(argv: string[]): HostArgs {
  const flags = new Map<string, string>();
  let reportOnly = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--report-only") reportOnly = true;
    else if (FLAGS.has(a)) {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      flags.set(a, v);
    } else throw new Error(`unknown flag ${a}`);
  }
  if (!reportOnly) throw new Error("host runs report-only for now: pass --report-only");
  if (!flags.has("--state")) throw new Error("host needs --state DIR");
  return {
    host: flags.get("--host") ?? hostname().split(".")[0]!,
    state: flags.get("--state")!,
    suLog: flags.get("--su-log") ?? join(homedir(), "Library/Logs/secure-update/launchagent.log"),
  };
}

export function renderHost(r: HostReport, streak: number): string {
  const c = r.compare;
  const lines = [`host ${r.host} ${r.date}: ${r.inventory.length} items, ${r.outdated.length} outdated, ${r.advisories === null ? "advisories unknown" : `${r.advisories.length} advisories`}, ${c ? (c.agree ? "AGREES with secure-update" : "DIFFERS from secure-update") : "no comparison"}; agreeing weeks in a row: ${streak}`];
  if (c && c.upgraded.baseline) {
    if (c.upgraded.onlyInventory.length) lines.push(`  changed, not in secure-update's upgraded: ${c.upgraded.onlyInventory.join(" ")}`);
    if (c.upgraded.onlySecureUpdate.length) lines.push(`  secure-update upgraded, no version change seen: ${c.upgraded.onlySecureUpdate.join(" ")}`);
  }
  if (c?.held.onlyInventory.length) lines.push(`  outdated, not held by secure-update: ${c.held.onlyInventory.join(" ")}`);
  if (c?.held.onlySecureUpdate.length) lines.push(`  held by secure-update, not outdated now: ${c.held.onlySecureUpdate.join(" ")}`);
  for (const a of r.advisories ?? []) lines.push(`  ${a.malicious ? "MALICIOUS" : a.severity} ${a.pkg.name}@${a.pkg.version}: ${a.id} ${a.summary}`);
  for (const n of r.notes) lines.push(`  note: ${n}`);
  return lines.join("\n");
}

export async function hostMain(a: HostArgs, deps: { run: Runner; feed: AdvisoryFeed; now: Date }): Promise<{ report: HostReport; text: string }> {
  const inv = join(a.state, "inventory.json");
  const reports = join(a.state, "reports");
  mkdirSync(reports, { recursive: true });
  const prev = existsSync(inv) ? (JSON.parse(readFileSync(inv, "utf8")) as { inventory: Item[] }).inventory : undefined;
  const suLog = existsSync(a.suLog) ? readFileSync(a.suLog, "utf8") : "";
  const report = await hostReport({ host: a.host, raw: await probeHost(deps.run), suLog, prev, feed: deps.feed, now: deps.now });
  writeFileSync(join(reports, `${report.date}.json`), JSON.stringify(report, null, 2) + "\n");
  writeFileSync(inv, JSON.stringify({ date: report.date, inventory: report.inventory }, null, 2) + "\n");
  const past = readdirSync(reports)
    .filter((f) => /^\d{4}-\d\d-\d\d\.json$/.test(f))
    .map((f) => JSON.parse(readFileSync(join(reports, f), "utf8")) as HostReport)
    .filter((r) => r.compare)
    .map((r) => ({ date: r.date, agree: r.compare!.agree, baseline: r.compare!.upgraded.baseline }));
  return { report, text: renderHost(report, weeklyStreak(past)) };
}

export type HostCommand =
  | { mode: "report"; args: HostArgs }
  | { mode: "apply"; config: string; dryRun: boolean; host?: string }
  | { mode: "gatekeeper"; action: "approve" | "revert"; cask: string; config: string; host?: string }
  | { mode: "owner-waiter"; config: string; host?: string }
  | { mode: "launchd"; args: LaunchdArgs };

export const defaultConfigPath = () => join(homedir(), ".config", "oupdate", "config.json");

/**
 * `oupdate host` arguments: --report-only (the shadow), --apply [--dry-run], a Gatekeeper one-off,
 * or --launchd-plist (prints the LaunchDaemon that schedules --apply).
 */
export function parseHostCommand(argv: string[]): HostCommand {
  const has = (f: string) => argv.includes(f);
  const modes = ["--report-only", "--apply", "--gatekeeper-approve", "--gatekeeper-revert", "--launchd-plist", "--stale-owners-waiter"].filter(has);
  if (modes.length > 1) throw new Error(`host takes one of ${modes.join(", ")}`);
  if (modes[0] === "--launchd-plist") return { mode: "launchd", args: parseLaunchdArgs(argv) };
  if (!modes.length || modes[0] === "--report-only") {
    if (has("--dry-run")) throw new Error("--dry-run goes with --apply");
    return { mode: "report", args: parseHostArgs(argv) };
  }
  let config: string | undefined;
  let host: string | undefined;
  let cask: string | undefined;
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--apply" || a === "--stale-owners-waiter") continue;
    else if (a === "--dry-run") dryRun = true;
    else if (a === "--config") config = value();
    else if (a === "--host") host = value();
    else if (a === "--gatekeeper-approve" || a === "--gatekeeper-revert") cask = value();
    else throw new Error(`unknown flag ${a}`);
  }
  config ??= defaultConfigPath();
  if (modes[0] === "--apply") return { mode: "apply", config, dryRun, ...(host ? { host } : {}) };
  if (dryRun) throw new Error("--dry-run goes with --apply");
  if (modes[0] === "--stale-owners-waiter") return { mode: "owner-waiter", config, ...(host ? { host } : {}) };
  return { mode: "gatekeeper", action: modes[0] === "--gatekeeper-approve" ? "approve" : "revert", cask: cask!, config, ...(host ? { host } : {}) };
}

function loadConfig(c: { config: string; host?: string }): ApplyConfig {
  let text: string;
  try {
    text = readFileSync(c.config, "utf8");
  } catch {
    throw new Error(`cannot read config ${c.config}`);
  }
  const cfg = parseApplyConfig(text, c.host ?? hostname().split(".")[0]!);
  return c.host ? { ...cfg, host: c.host } : cfg;
}

/**
 * The command that starts the owner restart waiter: bun by its stable link (a Cellar keg path is
 * deleted by the next bun upgrade, the very thing the waiter restarts jobs off), this CLI, the config.
 */
export function ownerWaiterArgv(config: string, execPath: string = process.execPath, main: string = Bun.main): string[] {
  const i = execPath.indexOf("/Cellar/");
  const bun = i < 0 ? execPath : join(execPath.slice(0, i) || "/", "bin", basename(execPath));
  return [bun, main, "host", "--stale-owners-waiter", "--config", resolve(config)];
}

/** `host --stale-owners-waiter`: works the owner restart queue of the config's stateDir. Returns the rc. */
export async function ownerWaiterMain(c: Extract<HostCommand, { mode: "owner-waiter" }>, deps: { exec: Exec; out?: (line: string) => void }): Promise<number> {
  const cfg = loadConfig(c);
  const out = deps.out ?? ((l: string) => console.error(l));
  const p2 = (n: number) => String(n).padStart(2, "0");
  const stamp = () => {
    const d = new Date();
    return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
  };
  return runOwnerWaiter(
    {
      exec: deps.exec,
      readFile: realFs.readFile,
      writeFile: realFs.writeFile,
      remove: realFs.remove,
      appendFile: realFs.appendFile,
      listDir: realFs.listDir,
      isDir: realFs.isDir,
      now: () => Date.now(),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      takeLock: realTakeLock,
      releaseLock: realReleaseLock,
      httpStatus: realHttpStatus,
      log: (l) => out(`${stamp()} owner waiter ${cfg.host}: ${l}`),
    },
    { dir: ownerDir(cfg.stateDir), lsof: cfg.lsof },
  );
}

/** A log file name may carry {date}: the run's local date as YYYYMMDD (one file per day, as secure-update kept). */
export function logPath(template: string, now: Date): string {
  const d = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
  return template.replaceAll("{date}", d);
}

/** Where a signal handler is registered: the process, or a test's emitter. */
export type StopSignal = "SIGTERM" | "SIGINT" | "SIGHUP";
export interface SignalSource {
  on(sig: StopSignal, f: () => void): unknown;
  off(sig: StopSignal, f: () => void): unknown;
}
const SIGNAL_RC: Record<StopSignal, number> = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };

export interface ApplyDeps {
  exec: Exec;
  fs: ApplyFs;
  now?: Date;
  /** Each line as it is produced (default: stdout). */
  out?: (line: string) => void;
  signals?: SignalSource;
  /** Called after the stop line on a signal (default: process.exit). */
  exit?: (code: number) => void;
  /** Stops the commands still running on a signal (default: killLive, SIGTERM then SIGKILL; nothing new starts after). */
  stopLive?: () => Promise<void> | void;
  /**
   * Handle SIGHUP (default: only when stdin is a terminal). Under nohup or launchd stdin is not a
   * terminal, and a hangup keeps its default (or nohup's ignore) instead of stopping the run.
   */
  handleHup?: boolean;
  /** Whether stdin is a terminal (default: process.stdin.isTTY); decides the SIGHUP default. */
  stdinIsTTY?: boolean;
}

/**
 * The log file a command writes. Only a real run writes the dated file the shadow report and the
 * digest read; a dry run and a Gatekeeper one-off write a "dry-run-" / "gatekeeper-" file beside it,
 * which neither reads.
 */
export function logFileFor(c: Extract<HostCommand, { mode: "apply" | "gatekeeper" }>, file: string): string {
  if (c.mode === "apply" && !c.dryRun) return file;
  return join(dirname(file), `${c.mode === "apply" ? "dry-run" : "gatekeeper"}-${basename(file)}`);
}

/**
 * Runs --apply or a Gatekeeper one-off. Each line goes out as it is made, appended to the log file
 * first, then stdout, so a run that hangs or is killed leaves its log. A real run that is stopped
 * by a signal or crashes ends with secure-update's "=== ABORTED" line, as its exit trap did; a dry
 * run or one-off with a "=== STOPPED" line, which no reader counts as an aborted run. Returns the
 * text and the exit code.
 */
export async function applyMain(c: Extract<HostCommand, { mode: "apply" | "gatekeeper" }>, deps: ApplyDeps & { ownerWaiterArgv?: string[] }): Promise<{ text: string; rc: number }> {
  const now = deps.now ?? new Date();
  const loaded = loadConfig(c);
  const cfg = loaded.logFile ? { ...loaded, logFile: logFileFor(c, logPath(loaded.logFile, now)) } : loaded;
  const write = deps.out ?? ((l: string) => console.log(l));
  const out = (l: string) => {
    try {
      write(l);
    } catch {
      // stdout gone (a closed pipe): the log file still has the line
    }
  };
  const lines: string[] = [];
  let logBroken = false;
  if (cfg.logFile) {
    try {
      mkdirSync(dirname(cfg.logFile), { recursive: true });
    } catch (e) {
      logBroken = true;
      out(`WARNING: cannot create the log directory ${dirname(cfg.logFile)} (${e instanceof Error ? e.message : String(e)}) — logging to stdout only`);
    }
  }
  // Set by a signal: after the stop line nothing more is logged, and the signal's exit code wins.
  let stopCode: number | undefined;
  let stopDone: Promise<void> | undefined;
  const emit = (l: string, force = false) => {
    if (stopCode !== undefined && !force) return;
    lines.push(l);
    if (cfg.logFile && !logBroken) {
      try {
        appendFileSync(cfg.logFile, `${l}\n`);
      } catch (e) {
        logBroken = true;
        out(`WARNING: could not append to ${cfg.logFile} (${e instanceof Error ? e.message : String(e)})`);
      }
    }
    out(l);
  };
  const real = c.mode === "apply" && !c.dryRun;
  const label = c.mode === "apply" ? (c.dryRun ? "oupdate dry run" : "oupdate-secure-update") : `oupdate --gatekeeper-${c.action}`;
  const stopped = (why: string) =>
    emit(real ? `=== ABORTED: ${label} on ${cfg.host} ${why} — this run did NOT complete ===` : `=== STOPPED: ${label} on ${cfg.host} ${why} — not a run, nothing more was done ===`, true);
  const signals = deps.signals ?? process;
  const handleHup = deps.handleHup ?? (deps.stdinIsTTY ?? !!process.stdin.isTTY);
  const sigs: StopSignal[] = handleHup ? ["SIGTERM", "SIGINT", "SIGHUP"] : ["SIGTERM", "SIGINT"];
  const handlers = sigs.map((sig) => {
    const f = () => {
      if (stopCode !== undefined) return;
      stopped(`got ${sig}`);
      stopCode = SIGNAL_RC[sig];
      const code = stopCode;
      stopDone = (async () => {
        try {
          await (deps.stopLive ?? (() => killLive()))();
          // What must still happen before the exit (a release check's after): awaited, logged.
          await runStopTasks((l) => emit(l, true));
        } finally {
          (deps.exit ?? ((c: number) => process.exit(c)))(code);
        }
      })();
    };
    signals.on(sig, f);
    return [sig, f] as const;
  });
  // A run that ends while the stop is under way returns the signal's code, after the stop.
  const settle = async (rc: number) => {
    if (stopCode === undefined) return rc;
    await stopDone;
    return stopCode;
  };
  try {
    if (c.mode === "gatekeeper") {
      mkdirSync(cfg.stateDir, { recursive: true });
      const g = await gatekeeperAction(cfg, deps.exec, c.action, c.cask);
      for (const l of g.lines) emit(l);
      return { text: lines.join("\n"), rc: await settle(g.rc) };
    }
    if (!c.dryRun) mkdirSync(cfg.stateDir, { recursive: true });
    const r = await applyHost(cfg, deps.exec, deps.fs, { dryRun: c.dryRun, now, onLine: (l) => emit(l), isStopping: () => stopCode !== undefined, ownerWaiterArgv: deps.ownerWaiterArgv ?? ownerWaiterArgv(c.config) });
    // The end-of-run notice is logged after the summary block: emitted by applyHost already.
    return { text: lines.join("\n"), rc: await settle(logBroken ? 1 : r.rc) };
  } catch (e) {
    if (stopCode !== undefined) return { text: lines.join("\n"), rc: await settle(2) };
    stopped(`exited 2 (${e instanceof Error ? e.message : String(e)})`);
    throw e;
  } finally {
    for (const [sig, f] of handlers) signals.off(sig, f);
  }
}
