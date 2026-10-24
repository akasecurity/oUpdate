// The idle waiter for a deferred service, ported from the previous updater's deferred-service
// handoff and waiter report. A kickstart cuts off live requests, so a deferred service running from a
// stale keg is handed to a waiter script (the site's own): it waits for an idle window, drains,
// restarts and verifies. The waiter is detached because launchd kills the job's process group
// when this run exits. Its outcome surfaces one run later through the report.
//
// The waiter script's contract: `--holder` prints the pid of a running waiter (rc 0) or fails;
// `--recover` undoes a drain a dead waiter left behind; `<keg>` waits and restarts. A hold file
// stops every start or restart; a quarantine file (an install that did not match its review)
// too. Both notes avoid the status reader's trouble words: a held service is the intended state.

import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, statSync } from "node:fs";
import { basename, dirname } from "node:path";
import { isStopping, type Exec } from "./exec.ts";

export interface DeferredService {
  /** As notes name it, e.g. the package. */
  name: string;
  waiter: string;
  holdFile: string;
  quarantineFile: string;
  /** The waiter writes its last outcome here; the report shows and removes it. */
  outcomeFile: string;
  /** The waiter's stderr is appended here. */
  restartLog: string;
}

export interface WaiterEnv {
  exec: Exec;
  exists(path: string): Promise<boolean>;
  readFile(path: string): Promise<string>;
  remove(path: string): Promise<void>;
  /** The hold file's modification date, YYYY-MM-DD (local). */
  mtimeDay(path: string): Promise<string>;
  /** Starts argv in its own process group, stdin and stdout closed, stderr appended to a file; returns the pid. */
  spawnDetached(argv: string[], stderrFile: string): Promise<number>;
}

/** Starts nothing once oupdate is being stopped: a detached child would outlive the stop unsupervised. */
export const realSpawnDetached = async (argv: string[], stderrFile: string): Promise<number> => {
  if (isStopping()) throw new Error("oupdate is stopping: not started");
  mkdirSync(dirname(stderrFile), { recursive: true });
  const fd = openSync(stderrFile, "a");
  try {
    const child = spawn(argv[0]!, argv.slice(1), { detached: true, stdio: ["ignore", "ignore", fd] });
    // A spawn that fails after returning (EAGAIN) has no pid and reports through 'error'; with no
    // listener that event would crash the run, so it is swallowed here and the missing pid throws.
    child.on("error", () => {});
    if (child.pid === undefined) throw new Error("no pid");
    child.unref();
    return child.pid;
  } finally {
    closeSync(fd);
  }
};

export const mtimeDayOf = async (path: string) => {
  const d = statSync(path).mtime;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** The --holder probe's default bound. */
export const HOLDER_TIMEOUT_MS = 30_000;

/**
 * Hands the stale keg to the waiter, or says why not. Returns the note; never fails the run.
 * As the previous updater did, any probe answer but 0 hands off: the waiter takes an exclusive lock and
 * exits when one is already live, so a duplicate start is safe. A probe that timed out says so in
 * the note. Only a stop (the probe refused or killed by it) starts nothing.
 */
export async function handoff(env: WaiterEnv, s: DeferredService, keg: string, dryRun: boolean, o: { holderTimeoutMs?: number } = {}): Promise<string> {
  if (await env.exists(s.quarantineFile)) return `${s.name} quarantined — not restarting (see ${s.quarantineFile})`;
  if (await env.exists(s.holdFile)) return `${s.name} on hold — not restarting (see ${s.holdFile})`;
  if (dryRun) return `${s.name} stale — dry-run: would hand ${s.name} to ${basename(s.waiter)}`;
  if (!(await env.exists(s.waiter))) return `${s.name} stale — FAILED: ${s.waiter} missing, nothing will restart it`;
  if (isStopping()) return `${s.name} stale — not handed off: oupdate is stopping`;
  const holder = await env.exec(["/bin/bash", s.waiter, "--holder"], { timeoutMs: o.holderTimeoutMs ?? HOLDER_TIMEOUT_MS });
  if (holder.rc === 0) return `${s.name} stale — waiter already running (pid ${holder.out.trim()})`;
  // A stop that began during the probe (it may be why the probe failed): start nothing.
  if (isStopping()) return `${s.name} stale — not handed off: oupdate is stopping`;
  const probe = holder.timedOut || holder.rc === 124 ? " (holder check timed out)" : "";
  let pid: number;
  try {
    pid = await env.spawnDetached(["/bin/bash", s.waiter, keg], s.restartLog);
  } catch (e) {
    return `${s.name} stale — FAILED to start the waiter (${e instanceof Error ? e.message : "error"}), nothing will restart it`;
  }
  return `${s.name} stale — restart handed to waiter (pid ${pid})${probe}`;
}

/**
 * Before the brew phase: recover a drain a dead waiter left behind, show (and clear) the last
 * outcome, and report a hold on every run so it is not forgotten. Skipped in a dry run.
 */
export async function waiterReport(env: WaiterEnv, s: DeferredService, dryRun: boolean): Promise<string> {
  if (dryRun) return "";
  const notes: string[] = [];
  if (await env.exists(s.waiter)) {
    if ((await env.exec(["/bin/bash", s.waiter, "--recover"])).rc !== 0) notes.push(`${s.name} waiter: FAILED to recover a leftover drain`);
  }
  if (await env.exists(s.outcomeFile)) {
    // An unreadable outcome reads as empty and is still removed, as the bash's cat then rm -f.
    let text = "";
    try {
      text = await env.readFile(s.outcomeFile);
    } catch {
      text = "";
    }
    notes.push(`${s.name} waiter: ${text.replace(/\n+$/, "")}`);
    try {
      await env.remove(s.outcomeFile);
    } catch {
      // left for the next run
    }
  }
  if (await env.exists(s.holdFile)) {
    // A hold removed between the two calls still gets its note, without the day.
    const since = await env.mtimeDay(s.holdFile).then((d) => ` since ${d}`, () => "");
    notes.push(`${s.name} on hold${since} — not restarted; release: rm ${s.holdFile}`);
  }
  return notes.join("; ");
}
