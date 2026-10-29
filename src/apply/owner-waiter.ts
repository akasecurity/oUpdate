// Stale-keg owners restarted at an idle moment (config staleOwners). A kickstart cuts off live work,
// so a launchd job matching a staleOwners glob is not restarted by the stale-keg check: it is queued
// and a detached waiter (oupdate itself, `host --stale-owners-waiter`) restarts the queued jobs one
// at a time, as the Example waiter does: an exclusive lock, outcome files the next run reports and
// removes, and launchd never killing it with the run's process group.
//
// Per job: wait for idle (the owner's probe argv exits 0, else no ESTABLISHED TCP on its pid for
// 60 s straight), busy past a bound is "held: busy" and the next job goes. Right before the restart
// the job's pid is read again: a process launchd replaced meanwhile is checked again (dropped when it
// is on the new keg, else idle is waited for on it). Then `launchctl kickstart -k`, then health (a
// new pid running within 60 s, the health URL 200 when set, and no deleted keg mapped by that pid).
// An unhealthy job stops the queue, names the bootout/bootstrap rollback (the old keg is gone, so no
// version rollback), and is written to the failed file: the run never queues it again until that
// file is removed.
//
// An owner with restart {bootstrap: plist} is restarted by `launchctl bootout` then `launchctl
// bootstrap <domain> <plist>` instead (its FAILED note says "bootstrap again"); healthWithinSec
// replaces the 60 s health window.
//
// Crash safety: the job being worked is recorded in inprogress.json before its queue entry is
// removed. A waiter that finds the record "restarting" treats that restart as failed (never retried);
// "waiting" (nothing was done yet) goes back to the queue.
//
// Files under <stateDir>/owner-restarts (a name without a status reader's trouble word "stale", which a
// clean outcome must not carry): queue/<target>.json (one per job, so the run adding and the waiter
// taking never rewrite one file), outcomes/<time>-<pid>-<n>.txt (one per result, read and removed one
// by one), failed (one label per line), inprogress.json, lock (flocked, never deleted) and lock.info.

import { closeSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { dlopen, FFIType } from "bun:ffi";
import { dirname, join } from "node:path";
import type { Exec } from "./exec.ts";
import { kegHolders } from "./holders.ts";

export interface StaleOwner {
  /** A launchd label glob: `*` any run of characters, `?` one. */
  match: string;
  /** Exits 0 when the job is idle; argv[0] absolute. */
  probe?: string[];
  /** Must answer 200 after the restart. */
  health?: string;
  /**
   * "kickstart" (default): `launchctl kickstart -k`. {bootstrap: plist}: `launchctl bootout` then
   * `launchctl bootstrap <domain> <plist>` (for a daemon kickstart -k once left stuck in a spawn failure).
   */
  restart?: OwnerRestart;
  /** How long the restarted job has to be healthy (default 60). */
  healthWithinSec?: number;
}

export type OwnerRestart = "kickstart" | { bootstrap: string };

export interface QueuedOwner {
  label: string;
  /** system/<label> or gui/<uid>/<label>. */
  target: string;
  /** The stale pid seen by the run. */
  pid: string;
  /** The deleted keg directory it ran from. */
  keg: string;
  probe?: string[];
  health?: string;
  restart?: OwnerRestart;
  healthWithinSec?: number;
  /**
   * Always restarted and health-checked (a release check's named owner): never "already on the new
   * keg" from its own pid's maps, as a shell or supervisor maps no keg while its child runs the old one.
   */
  required?: boolean;
  /**
   * The keg the job must run after its restart (a release check's: the candidate, or the restored
   * version after a rollback): any other keg of the formula mapped is stale too, an older retained
   * keg as much as `keg`, so "off the previous keg" is never taken for "on the expected version".
   */
  expect?: string;
}

const globRe = (g: string) => new RegExp(`^${[...g].map((c) => (c === "*" ? ".*" : c === "?" ? "." : c.replace(/[\\^$.|+()[\]{}]/g, "\\$&"))).join("")}$`);

/** The first owner whose glob matches the whole label. */
export function matchOwner(owners: readonly StaleOwner[] | undefined, label: string): StaleOwner | undefined {
  return owners?.find((o) => globRe(o.match).test(label));
}

export const ownerDir = (stateDir: string) => join(stateDir, "owner-restarts");
export const ownerFiles = (dir: string) => ({
  queue: join(dir, "queue"), outcomes: join(dir, "outcomes"), failed: join(dir, "failed"), lock: join(dir, "lock"), inprogress: join(dir, "inprogress.json"),
});
const queueName = (target: string) => `${encodeURIComponent(target)}.json`;

/** The labels in the failed file. */
const failedLabels = (text: string | undefined) => new Set((text ?? "").split("\n").map((l) => l.trim()).filter(Boolean));

export interface OwnerQueueEnv {
  readFile(path: string): Promise<string | undefined>;
  writeFile(path: string, text: string): Promise<void>;
  spawnDetached(argv: string[], stderrFile: string): Promise<number>;
}

/**
 * Adds the jobs to the queue and starts the waiter (a live one holds the lock and the new one
 * exits, so a second start is safe). Returns the note; never throws.
 */
export async function queueOwners(env: OwnerQueueEnv, dir: string, items: QueuedOwner[], waiterArgv: string[] | undefined, stderrFile: string): Promise<string> {
  if (!items.length) return "";
  const f = ownerFiles(dir);
  const labels = items.map((i) => i.label).join(" ");
  try {
    for (const i of items) await env.writeFile(join(f.queue, queueName(i.target)), `${JSON.stringify(i)}\n`);
  } catch (e) {
    return `owner restart waiter FAILED: could not queue ${labels} (${e instanceof Error ? e.message : String(e)})`;
  }
  if (!waiterArgv?.length) return `owner restart waiter FAILED: no waiter command here, ${labels} queued but not started`;
  try {
    const pid = await env.spawnDetached(waiterArgv, stderrFile);
    return `owner restart waiter started (pid ${pid}) for ${labels}`;
  } catch (e) {
    return `owner restart waiter FAILED to start (${e instanceof Error ? e.message : String(e)}), ${labels} queued`;
  }
}

export interface OwnerReport {
  note: string;
  /** Labels the last waiter held as busy. */
  busy: Set<string>;
  /** Labels whose restart failed: never queued again until the failed file is removed. */
  failed: Set<string>;
}

/**
 * Before the brew phase: the waiter's results since the last report (each file read, then removed,
 * so one written meanwhile is kept for the next report) and the failed labels (every run).
 */
export async function ownerWaiterReport(
  env: { readFile(path: string): Promise<string | undefined>; remove(path: string): Promise<void>; listDir(path: string): Promise<string[]> },
  dir: string,
  dryRun: boolean,
): Promise<OwnerReport> {
  const f = ownerFiles(dir);
  const failed = failedLabels(await env.readFile(f.failed));
  const busy = new Set<string>();
  const notes: string[] = [];
  const lines: string[] = [];
  for (const name of (await env.listDir(f.outcomes)).filter((n) => n.endsWith(".txt")).sort()) {
    const path = join(f.outcomes, name);
    const text = await env.readFile(path);
    if (text === undefined) continue;
    lines.push(...text.split("\n").map((l) => l.trim()).filter(Boolean));
    if (!dryRun) {
      try {
        await env.remove(path);
      } catch {
        // left for the next run
      }
    }
  }
  for (const l of lines) {
    const m = l.match(/^held: busy (\S+)/);
    if (m) busy.add(m[1]!);
  }
  // Joined with commas: a part of the brew line starting "FAILED:" would read as failed packages.
  if (lines.length) notes.push(`owner restart waiter: ${lines.join(", ")}`);
  if (failed.size) notes.push(`owner restart FAILED earlier for ${[...failed].join(" ")} — not retried, retry: rm ${f.failed}`);
  return { note: notes.join("; "), busy, failed };
}

export interface OwnerWaiterEnv {
  exec: Exec;
  readFile(path: string): Promise<string | undefined>;
  writeFile(path: string, text: string): Promise<void>;
  remove(path: string): Promise<void>;
  /**
   * Appends in one write. The failed file is shared by this waiter and a run's inline release-check
   * restarts, which do not hold the lock: an append never loses the other's line. Absent (tests):
   * read, then rewrite.
   */
  appendFile?(path: string, text: string): Promise<void>;
  listDir(path: string): Promise<string[]>;
  isDir(path: string): Promise<boolean>;
  now(): number;
  sleep(ms: number): Promise<void>;
  /** An exclusive lock for this process's life; false when a live process holds it. */
  takeLock(path: string): Promise<boolean>;
  releaseLock(path: string): Promise<void>;
  /** The URL's HTTP status, 0 when it cannot be fetched. */
  httpStatus(url: string): Promise<number>;
  log(line: string): void;
}

export interface OwnerWaiterOptions {
  dir: string;
  lsof: string;
  /** Names this waiter's outcome files (default process.pid). */
  id?: number;
  idleMs?: number;
  sampleMs?: number;
  busyBoundMs?: number;
  healthMs?: number;
  healthPollMs?: number;
  probeTimeoutMs?: number;
}

const BUSY_BOUND_MS = 2 * 60 * 60_000;
/** How often a job launchd keeps replacing during the wait is checked again before it is held. */
const REPLACED_MAX = 5;

/** `launchctl print <target>`: its pid, state and plist path. */
export function parsePrint(out: string): { pid?: string; state?: string; path?: string } {
  const r: { pid?: string; state?: string; path?: string } = {};
  // The job's own keys sit one tab in; nested blocks (endpoints, environment) are deeper.
  for (const line of out.split("\n")) {
    const m = line.match(/^\t(pid|state|path) = (.+)$/);
    if (m && r[m[1] as "pid"] === undefined) r[m[1] as "pid"] = m[2]!.trim();
  }
  return r;
}

/** system or gui/<uid>: the target without its label. */
const domainOf = (q: QueuedOwner) => q.target.slice(0, q.target.length - q.label.length - 1);

/** The operator's way back, named in a FAILED outcome. */
const rollback = (q: QueuedOwner, plist: string | undefined) => {
  const sudo = q.target.startsWith("system/") ? "sudo " : "";
  // No ";" anywhere in an outcome: the summary parser splits the brew line there.
  if (typeof q.restart === "object") return `bootstrap again: ${sudo}launchctl bootstrap ${domainOf(q)} ${q.restart.bootstrap}`;
  return `rollback: ${sudo}launchctl bootout ${q.target} && ${sudo}launchctl bootstrap ${domainOf(q)} ${plist ?? `<${q.label}.plist>`}`;
};

interface InProgress {
  phase: "waiting" | "restarting";
  item: QueuedOwner;
  /** The plist path launchd named, for the rollback note. */
  path?: string;
}

/**
 * The waiter: takes the lock, works the queue one job at a time, writes the outcomes. After it lets
 * the lock go it looks at the queue once more: a job queued while it was finishing (its own waiter
 * exited on the lock) is never left without one. Returns the rc.
 */
export async function runOwnerWaiter(env: OwnerWaiterEnv, o: OwnerWaiterOptions): Promise<number> {
  const f = ownerFiles(o.dir);
  const queued = async () => (await env.listDir(f.queue)).filter((n) => n.endsWith(".json")).sort();
  for (;;) {
    if (!(await env.takeLock(f.lock))) {
      env.log("another owner restart waiter holds the lock — exiting");
      return 0;
    }
    let rc: number;
    try {
      rc = await workQueue(env, o);
    } finally {
      await env.releaseLock(f.lock);
    }
    // A failure stopped the queue on purpose; otherwise go again when work arrived meanwhile.
    if (rc !== 0 || !(await queued()).length) return rc;
  }
}

/** How one job ended: restarted, already on the new keg, not running, held busy, failed, or skipped (its label already failed). */
export type OwnerJobKind = "restarted" | "already" | "not-running" | "busy" | "failed" | "skipped";

export interface OwnerJobResult {
  kind: OwnerJobKind;
  /** The outcome line; none for a skipped job. */
  line?: string;
}

/**
 * The per-job steps of the waiter, shared by the waiter's queue and by the run's release checks
 * (which restart their formula's owner inline, so their check runs after it).
 */
export function ownerOps(env: OwnerWaiterEnv, o: OwnerWaiterOptions) {
  const f = ownerFiles(o.dir);
  const idleMs = o.idleMs ?? 60_000;
  const sampleMs = o.sampleMs ?? 3_000;
  const bound = o.busyBoundMs ?? BUSY_BOUND_MS;
  const healthMs = o.healthMs ?? 60_000;
  const pollMs = o.healthPollMs ?? 2_000;
  const markFailed = async (label: string) => {
    const had = (await env.readFile(f.failed)) ?? "";
    if (failedLabels(had).has(label)) return;
    if (env.appendFile) await env.appendFile(f.failed, `${label}\n`);
    else await env.writeFile(f.failed, `${had}${label}\n`);
  };
  const print = async (target: string) => {
    const r = await env.exec(["launchctl", "print", target]);
    return r.rc === 0 ? parsePrint(r.out) : undefined;
  };
  /**
   * Whether this pid still maps a file of the job's stale keg (which may still be on disk: a
   * release check keeps the previous keg), of any keg of the same formula but `expect` (when set),
   * or of any keg directory that no longer exists (-a: only this pid's maps). `strict` (a release check's owner, whose check relies on it): output
   * without lsof's COMMAND header is a failed scan, never "no keg mapped" (as lsofMaps).
   */
  const onDeletedKeg = async (pid: string, keg: string, strict = false, expect?: string) => {
    const r = await env.exec([o.lsof, "-nP", "-w", "-a", "-p", pid, "-d", "txt,mem"]);
    if (r.rc !== 0) return undefined;
    if (strict && !r.out.split("\n").some((l) => l.startsWith("COMMAND"))) return undefined;
    const cellar = dirname(dirname(keg));
    const other = (k: string) => expect !== undefined && dirname(k) === dirname(expect) && k !== expect;
    for (const h of kegHolders(r.out, cellar)) if (h.pid === pid && (h.keg === keg || other(h.keg) || !(await env.isDir(h.keg)))) return true;
    return false;
  };
  /** Idle: the probe exits 0, else no ESTABLISHED TCP on the pid for idleMs straight. False once busy past the bound. */
  const waitIdle = async (q: QueuedOwner, pid: string) => {
    const start = env.now();
    let since: number | undefined;
    for (;;) {
      if (q.probe) {
        const r = await env.exec(q.probe, { timeoutMs: o.probeTimeoutMs ?? 30_000 });
        if (r.rc === 0 && !r.timedOut) return true;
      } else {
        const r = await env.exec([o.lsof, "-nP", "-w", "-a", "-p", pid, "-iTCP", "-sTCP:ESTABLISHED"]);
        // lsof exits 1 with nothing to list: no connection. Anything else counts as busy.
        const idle = r.rc === 1 && !r.out.trim();
        if (!idle) since = undefined;
        else {
          since ??= env.now();
          if (env.now() - since >= idleMs) return true;
        }
      }
      if (env.now() - start >= bound) return false;
      await env.sleep(sampleMs);
    }
  };
  /** The restart itself, argv arrays only (sudo -n in the system domain). Returns the reason when it failed. */
  const restartJob = async (q: QueuedOwner): Promise<string | undefined> => {
    const sudo = q.target.startsWith("system/") ? ["sudo", "-n"] : [];
    if (typeof q.restart === "object") {
      const out = await env.exec([...sudo, "launchctl", "bootout", q.target]);
      if (out.rc !== 0) return `bootout rc ${out.rc}`;
      const boot = await env.exec([...sudo, "launchctl", "bootstrap", domainOf(q), q.restart.bootstrap]);
      return boot.rc !== 0 ? `bootstrap rc ${boot.rc}` : undefined;
    }
    const kick = await env.exec([...sudo, "launchctl", "kickstart", "-k", q.target]);
    return kick.rc !== 0 ? `kickstart rc ${kick.rc}` : undefined;
  };
  /** Healthy: a new pid running, the health URL 200, no deleted keg mapped (nor any keg of the formula but q.expect). Returns the reason when not. */
  const health = async (q: QueuedOwner, oldPid: string): Promise<string | undefined> => {
    const start = env.now();
    let why = "no new pid";
    for (;;) {
      const p = await print(q.target);
      if (!p) why = "not loaded";
      else if (p.state !== "running" || !p.pid || p.pid === oldPid) why = `state ${p.state ?? "unknown"}, pid ${p.pid ?? "none"}`;
      else {
        const url = q.health ? await env.httpStatus(q.health) : 200;
        if (url !== 200) why = `health ${q.health} answered ${url || "nothing"}`;
        else {
          const stale = await onDeletedKeg(p.pid, q.keg, q.required, q.expect);
          if (stale === false) return undefined;
          why = stale ? `pid ${p.pid} still maps ${q.expect ? `a keg other than ${q.expect}` : "a deleted keg"}` : `lsof failed on pid ${p.pid}`;
        }
      }
      if (env.now() - start >= (q.healthWithinSec ? q.healthWithinSec * 1000 : healthMs)) return why;
      await env.sleep(pollMs);
    }
  };
  /**
   * One job: wait for idle on the pid that will be restarted (read again right before the restart;
   * a process launchd replaced meanwhile is checked again, as kickstart -k would kill the
   * replacement), restart, health. A failed job's label is marked failed (a label already marked is
   * skipped, unless ignoreFailed). `restarting` is called
   * right before the restart with the plist path launchd named.
   */
  const job = async (q: QueuedOwner, hooks: { restarting?: (plist: string | undefined) => Promise<void>; ignoreFailed?: boolean } = {}): Promise<OwnerJobResult> => {
    // ignoreFailed: a release check restarts its owner even when an earlier restart of it failed.
    if (!hooks.ignoreFailed && failedLabels(await env.readFile(f.failed)).has(q.label)) return { kind: "skipped" };
    const first = await print(q.target);
    if (!first?.pid) return { kind: "not-running", line: `held: ${q.label} not running` };
    if (!q.required && first.pid !== q.pid && (await onDeletedKeg(first.pid, q.keg)) === false) return { kind: "already", line: `already on the new keg: ${q.label}` };
    let pid = first.pid;
    let plist = first.path;
    for (let tries = 0; ; tries++) {
      env.log(`${q.label}: waiting for idle (pid ${pid})`);
      if (!(await waitIdle(q, pid))) return { kind: "busy", line: `held: busy ${q.label} (busy past ${Math.round(bound / 60_000)} min)` };
      const again = await print(q.target);
      if (!again?.pid) return { kind: "not-running", line: `held: ${q.label} not running` };
      plist = again.path ?? plist;
      if (again.pid === pid) break;
      if (!q.required && (await onDeletedKeg(again.pid, q.keg)) === false) return { kind: "already", line: `already on the new keg: ${q.label}` };
      if (tries >= REPLACED_MAX) return { kind: "busy", line: `held: ${q.label} keeps being replaced (pid ${again.pid})` };
      pid = again.pid;
    }
    await hooks.restarting?.(plist);
    const why = (await restartJob(q)) ?? (await health(q, pid));
    if (why === undefined) return { kind: "restarted", line: `restarted ${q.label}` };
    await markFailed(q.label);
    return { kind: "failed", line: `FAILED: ${q.label} not healthy after restart (${why}) — ${rollback(q, plist)}` };
  };
  return { job, markFailed };
}

async function workQueue(env: OwnerWaiterEnv, o: OwnerWaiterOptions): Promise<number> {
  const f = ownerFiles(o.dir);
  const id = o.id ?? process.pid;
  const ops = ownerOps(env, o);
  let seq = 0;
  /** One file per result, never appended to: the report reads and removes each whole. */
  const outcome = async (line: string) => {
    env.log(line);
    await env.writeFile(join(f.outcomes, `${String(env.now()).padStart(15, "0")}-${id}-${++seq}.txt`), `${line}\n`);
  };
  const setProgress = (p: InProgress) => env.writeFile(f.inprogress, `${JSON.stringify(p)}\n`);
  const stopQueue = async (after: string) => {
    for (const n of (await env.listDir(f.queue)).filter((x) => x.endsWith(".json"))) {
      const t = await env.readFile(join(f.queue, n));
      await env.remove(join(f.queue, n));
      let label = n;
      try {
        label = (JSON.parse(t ?? "") as QueuedOwner).label || n;
      } catch {
        // named by its file
      }
      await outcome(`not tried: ${label} (queue stopped after ${after} failed)`);
    }
  };

  // A record left by a waiter that stopped part-way.
  const left = await env.readFile(f.inprogress);
  if (left !== undefined) {
    let p: InProgress | undefined;
    try {
      p = JSON.parse(left) as InProgress;
      if (!p.item?.label || !p.item.target) p = undefined;
    } catch {
      p = undefined;
    }
    if (!p) await outcome("FAILED: unreadable in-progress record of a stopped owner restart waiter");
    else if (p.phase === "restarting") {
      // The restart may have half happened: never retried, the operator decides. As any failure, it
      // stops the queue for this run; the rest stay queued for a later run.
      await ops.markFailed(p.item.label);
      await outcome(`FAILED: ${p.item.label} restart interrupted (the waiter stopped mid-restart) — ${rollback(p.item, p.path)}`);
      await env.remove(f.inprogress);
      return 1;
    } else {
      // Nothing was done yet: back to the queue (the run may have queued it again already).
      await env.writeFile(join(f.queue, queueName(p.item.target)), `${JSON.stringify(p.item)}\n`);
    }
    await env.remove(f.inprogress);
  }

  for (;;) {
    const names = (await env.listDir(f.queue)).filter((n) => n.endsWith(".json")).sort();
    if (!names.length) return 0;
    const file = join(f.queue, names[0]!);
    const text = await env.readFile(file);
    let q: QueuedOwner;
    try {
      q = JSON.parse(text ?? "") as QueuedOwner;
      if (!q.label || !q.target || !q.pid || !q.keg) throw new Error("incomplete");
    } catch {
      await env.remove(file);
      await outcome(`FAILED: unreadable queue entry ${names[0]}`);
      continue;
    }
    // Recorded before the entry goes, so a stop from here on never loses the job.
    await setProgress({ phase: "waiting", item: q });
    await env.remove(file);
    const r = await ops.job(q, { restarting: (path) => setProgress({ phase: "restarting", item: q, path }) });
    if (r.line) await outcome(r.line);
    await env.remove(f.inprogress);
    // Stop the queue: the failed job is marked, the rest are named and left for a later run.
    if (r.kind === "failed") {
      await stopQueue(q.label);
      return 1;
    }
  }
}

/** `ps -o lstart=`: the start time of a running pid, for the lock's info file. */
export function psStartTime(pid: number): string | undefined {
  try {
    const p = Bun.spawnSync(["ps", "-o", "lstart=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" });
    const t = p.stdout.toString().trim();
    return p.exitCode === 0 && t ? t : undefined;
  } catch {
    return undefined;
  }
}

const LOCK_EX = 2;
const LOCK_NB = 4;

let libcFlock: ((fd: number, op: number) => number) | undefined;
/** flock(2) from libc through bun:ffi, loaded on first use. */
export function realFlock(fd: number, op: number): number {
  if (!libcFlock) {
    const lib = dlopen(process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } });
    libcFlock = (f, o) => lib.symbols.flock(f, o) as number;
  }
  return libcFlock(fd, op);
}

export interface FlockDeps {
  flock(fd: number, op: number): number;
  pid: number;
  startTime(pid: number): string | undefined;
}

/**
 * The waiter's lock: a kernel advisory lock (flock LOCK_EX|LOCK_NB) on <dir>/lock, a file created
 * once and never deleted. The kernel drops it when the holder dies, so there is no dead lock to
 * reclaim and no pid reuse to guard. The fd stays open for the waiter's life; closing it releases.
 * Who holds it (pid and start time) is written to <lock>.info for reporting only.
 */
export function makeFlockLock(deps: FlockDeps) {
  const held = new Map<string, number>();
  return {
    take: async (path: string): Promise<boolean> => {
      if (held.has(path)) return false;
      mkdirSync(dirname(path), { recursive: true });
      const fd = openSync(path, "a");
      if (deps.flock(fd, LOCK_EX | LOCK_NB) !== 0) {
        closeSync(fd);
        return false;
      }
      held.set(path, fd);
      try {
        writeFileSync(`${path}.info`, `${deps.pid} ${deps.startTime(deps.pid) ?? "?"}\n`);
      } catch {
        // reporting only
      }
      return true;
    },
    release: async (path: string): Promise<void> => {
      const fd = held.get(path);
      if (fd === undefined) return;
      held.delete(path);
      closeSync(fd);
    },
  };
}

const realLock = makeFlockLock({ flock: realFlock, pid: process.pid, startTime: psStartTime });
export const realTakeLock = realLock.take;
export const realReleaseLock = realLock.release;

export async function realHttpStatus(url: string): Promise<number> {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(5_000) })).status;
  } catch {
    return 0;
  }
}
