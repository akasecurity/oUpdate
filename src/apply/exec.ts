// One way to run a command, so every side effect of the host apply can be scripted in tests.

import { constants } from "node:os";

export interface ExecResult {
  rc: number;
  out: string;
  err: string;
  /** The command ran past its timeoutMs and was killed: the caller marks its phase failed. */
  timedOut?: boolean;
  /** A stream grew past its bound (and the command was not log-only): the command was stopped, out is empty and rc is OVER_BOUND_RC. Never a partial answer. */
  truncated?: true;
}

/** The rc of a command stopped for output past its bound: nonzero, so every caller's rc check reads it as a failure. */
export const OVER_BOUND_RC = 125;

/**
 * force: starts even while oupdate is stopping (a release check's owed after, run from the stop tasks). soft: a timeout is
 * returned (timedOut) for the caller to record, not a stop of the phase. maxBytes: the most bytes of each of stdout and
 * stderr (default MAX_STREAM_BYTES; anything but a number of 1 or more is the default, a fraction is rounded down). A
 * command that prints more is stopped and fails (truncated, rc OVER_BOUND_RC, nothing of its output returned): no gate reads a
 * partial answer. tail: a command whose output is only logged keeps the last maxBytes instead (a notice line says how many
 * earlier bytes went), and is never stopped for it.
 */
export type Exec = (argv: string[], opts?: { env?: Record<string, string>; timeoutMs?: number; cwd?: string; stdin?: string; force?: boolean; soft?: boolean; maxBytes?: number; tail?: boolean }) => Promise<ExecResult>;

/** After SIGTERM to a timed-out command's process group, SIGKILL follows this much later. */
export const KILL_GRACE_MS = 2000;

/**
 * Process groups that may still be running: a command's group until it closes, a timed-out
 * group until its SIGKILL. A signal to oupdate stops them through killLive.
 */
const live = new Set<number>();

function killGroup(pid: number, sig: NodeJS.Signals) {
  try {
    process.kill(-pid, sig);
  } catch {
    // already gone
  }
}

const pidAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};
const groupAlive = (pid: number) => pidAlive(-pid);

/** One process: pid, parent, start time and full command line (ps -ww, so the command is never cut short). */
interface PsRow {
  pid: number;
  ppid: number;
  started: string;
  cmd: string;
}

function psRows(extra: string[] = []): PsRow[] {
  // LC_ALL=C: lstart's month and day names are English whatever the user's locale, so the pattern below always matches.
  const r = Bun.spawnSync(["ps", "-ww", ...(extra.length ? extra : ["-ax"]), "-o", "pid=,ppid=,lstart=,command="], { env: { ...process.env, LC_ALL: "C" } });
  return new TextDecoder().decode(r.stdout).split("\n").flatMap((l) => {
    const m = l.match(/^\s*(\d+)\s+(\d+)\s+(\w{3} \w{3}\s+\d+ \d\d:\d\d:\d\d \d{4})\s+(.*)$/);
    return m ? [{ pid: Number(m[1]), ppid: Number(m[2]), started: m[3]!, cmd: m[4]! }] : [];
  });
}

/**
 * Every descendant of `root` (children, grandchildren, and any that left the process group) with its start time and command line,
 * from one ps snapshot taken before the kill: a helper that escaped the group (a sandbox helper under brew) is still a descendant
 * then. Only taken while `root` is still a child of this process: if it already exited and was reaped, its pid may be reused and
 * its "children" are not ours to kill.
 */
export function snapshotTree(root: number, parent = process.pid): { pid: number; started: string; cmd: string }[] {
  try {
    const rows = psRows();
    if (!rows.some((r) => r.pid === root && r.ppid === parent)) return [];
    const out: { pid: number; started: string; cmd: string }[] = [];
    const seen = new Set<number>([root]);
    for (let frontier = [root]; frontier.length; ) {
      const next: number[] = [];
      for (const row of rows) {
        if (frontier.includes(row.ppid) && !seen.has(row.pid)) {
          seen.add(row.pid);
          out.push({ pid: row.pid, started: row.started, cmd: row.cmd });
          next.push(row.pid);
        }
      }
      frontier = next;
    }
    return out;
  } catch {
    return [];
  }
}

/** SIGKILL to each snapshotted pid whose start time and command line are still exactly what they were (a reused pid is left alone). */
export function killTree(tree: { pid: number; started: string; cmd: string }[]) {
  for (const t of tree) {
    try {
      const now = psRows(["-p", String(t.pid)]).find((r) => r.pid === t.pid);
      if (now && now.started === t.started && now.cmd === t.cmd) process.kill(t.pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
}

/** The rc of a closed child: its exit code, else 128 + the signal number, else 1. */
export function closeRc(code: number | null, signal: NodeJS.Signals | null): number {
  if (code !== null) return code;
  if (signal) return 128 + (constants.signals[signal] ?? 15);
  return 1;
}

/** Set by killLive: from then on realExec starts nothing (oupdate is being stopped). */
let stopping = false;
export const isStopping = () => stopping;
type StopTask = (log: (line: string) => void) => Promise<void>;
/** Work a signal must still finish before oupdate exits (after killLive): a release check's owed after. */
const stopTasks = new Set<StopTask>();
/** Registers a stop task; returns its removal. */
export function onStop(f: StopTask): () => void {
  stopTasks.add(f);
  return () => void stopTasks.delete(f);
}
/** Runs every registered stop task once, in order; one that throws does not stop the rest. */
export async function runStopTasks(log: (line: string) => void = () => {}): Promise<void> {
  for (const f of [...stopTasks]) {
    stopTasks.delete(f);
    try {
      await f(log);
    } catch (e) {
      log(`  stop task failed (${e instanceof Error ? e.message : String(e)})`);
    }
  }
}

/** For tests only: a new run in the same process. */
export const resetStopping = () => {
  stopping = false;
};

/**
 * Stops every command still running: no new command starts from here on, SIGTERM to each group,
 * a short wait, then SIGKILL to every group still listed (also any started before the flag).
 */
export async function killLive(graceMs = 500): Promise<void> {
  stopping = true;
  for (const pid of live) killGroup(pid, "SIGTERM");
  await new Promise((r) => setTimeout(r, graceMs));
  for (const pid of [...live]) {
    killGroup(pid, "SIGKILL");
    live.delete(pid);
  }
}

/** The process groups killLive would stop now (for tests). */
export const liveGroups = () => [...live];

/**
 * Default most bytes of each of a command's stdout and stderr. Callers parse captured text as JSON (brew info and outdated, npm ls,
 * a broker client's reply, a reviewer command) or read it whole (git diff, lsof), so the default is far above any real answer
 * (32 MiB) and only bounds memory against a runaway command, which is stopped and fails.
 */
export const MAX_STREAM_BYTES = 32 * 1024 * 1024;

/** The bound for a command whose output is only logged (an upgrade, an install, a cleanup): pass it with tail: true. */
export const LOG_STREAM_BYTES = 1024 * 1024;

/**
 * The bound for the all-process lsof scans (stale-keg and release-check holders). Run as root over every user on a busy host,
 * lsof's answer can legitimately pass the default; a scan over even this fails (rc OVER_BOUND_RC), never reads as "nothing holds
 * it". Memory: up to 128 MiB held per stream until lsof ends.
 */
export const LSOF_STREAM_BYTES = 128 * 1024 * 1024;

/** The options of a log-only command: its last LOG_STREAM_BYTES are kept and nothing parses them. */
export const LOG_ONLY = { maxBytes: LOG_STREAM_BYTES, tail: true } as const;

/** maxBytes as used: a finite number of 1 or more, rounded down; anything else (0, Infinity) is the default. realExec rejects negative and NaN before this. */
export const boundOf = (n: number | undefined): number => (typeof n === "number" && Number.isFinite(n) && n >= 1 ? Math.floor(n) : MAX_STREAM_BYTES);

/** One stream's bytes: all of them up to `max`, or with `tail` the last `max` and how many earlier bytes were let go. */
interface Capture {
  max: number;
  tail: boolean;
  chunks: Uint8Array[];
  bytes: number;
  dropped: number;
  /** Set (non-tail) when a chunk took the stream past max; nothing more is read. */
  over: boolean;
}

function take(c: Capture, value: Uint8Array) {
  if (!c.tail) {
    if (c.bytes + value.length > c.max) {
      c.over = true;
      return;
    }
    c.chunks.push(value);
    c.bytes += value.length;
    return;
  }
  c.chunks.push(value);
  c.bytes += value.length;
  while (c.bytes > c.max) {
    const over = c.bytes - c.max;
    const first = c.chunks[0]!;
    if (first.length <= over) {
      c.chunks.shift();
      c.bytes -= first.length;
      c.dropped += first.length;
    } else {
      c.chunks[0] = first.subarray(over);
      c.bytes -= over;
      c.dropped += over;
    }
  }
}

/** Reads a stream to its end (or, past its bound, until onOver); a cancelled or failed stream just ends. */
async function drain(r: ReadableStreamDefaultReader<Uint8Array>, into: Capture, onOver: () => void) {
  try {
    for (;;) {
      const { done, value } = await r.read();
      if (done) return;
      take(into, value);
      if (into.over) {
        onOver();
        return;
      }
    }
  } catch {
    // cancelled at a timeout
  }
}

const newCapture = (max: number, tail: boolean): Capture => ({ max, tail, chunks: [], bytes: 0, dropped: 0, over: false });
const text = (c: Capture) => (c.dropped ? `[... ${c.dropped} earlier bytes truncated ...]\n` : "") + Buffer.concat(c.chunks).toString();

/**
 * Runs argv directly (never through a shell), in its own process group. A command that cannot
 * start is rc 127; one killed by a signal is 128 + the signal number. On a timeout the whole group
 * gets SIGTERM, then SIGKILL after a grace, and the result returns at once with our pipe ends
 * closed: a grandchild still holding them (git under brew update) cannot keep the run waiting.
 *
 * Bun.spawn and its `exited` promise, not node:child_process: under Bun 1.4.3 a child_process
 * child could finish and be reaped with no 'exit'/'close' event ever delivered (seen on the first
 * spawn in a process), so a finished command was waited on to its timeout.
 */
export const realExec: Exec = async (argv, opts = {}) => {
  // A caller bug, not a runtime condition: said at once, never quietly turned into some other bound.
  if (typeof opts.maxBytes === "number" && (Number.isNaN(opts.maxBytes) || opts.maxBytes < 0)) throw new RangeError(`exec maxBytes must not be negative or NaN, got ${opts.maxBytes}`);
  if (stopping && !opts.force) return { rc: 143, out: "", err: "oupdate is stopping: not started" };
  let p: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    p = Bun.spawn(argv, {
      stdin: opts.stdin === undefined ? "ignore" : new TextEncoder().encode(opts.stdin),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...opts.env },
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      detached: true,
    } as never) as unknown as Bun.Subprocess<"ignore", "pipe", "pipe">;
  } catch (e) {
    return { rc: 127, out: "", err: e instanceof Error ? e.message : String(e) };
  }
  const pid = p.pid;
  live.add(pid);
  const max = boundOf(opts.maxBytes);
  const out = newCapture(max, opts.tail === true);
  const err = newCapture(max, opts.tail === true);
  let overRes: () => void = () => {};
  const overflow = new Promise<"over">((res) => {
    overRes = () => res("over");
  });
  const outR = p.stdout.getReader();
  const errR = p.stderr.getReader();
  const finished = Promise.all([p.exited, drain(outR, out, overRes), drain(errR, err, overRes)]).then(() => "done" as const);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((res) => {
    if (opts.timeoutMs !== undefined) timer = setTimeout(() => res("timeout"), opts.timeoutMs);
  });
  const why = await Promise.race([finished, timeout, overflow]);
  clearTimeout(timer);
  if (why !== "done") {
    // An over-bound answer is never returned: let go of what was read at once, not after the kill wait (up to 2x max is held).
    if (why === "over") out.chunks.length = err.chunks.length = 0;
    const tree = snapshotTree(pid);
    killGroup(pid, "SIGTERM");
    // Not unref'd: oupdate stays up for the grace so the SIGKILL is sent. The group stays listed
    // until then: a grandchild may still be running.
    if (!opts.soft && why === "timeout") {
      setTimeout(() => {
        killGroup(pid, "SIGKILL");
        killTree(tree);
        live.delete(pid);
      }, KILL_GRACE_MS);
    }
    void outR.cancel().catch(() => {});
    void errR.cancel().catch(() => {});
    if (opts.soft || why === "over") {
      // The caller goes on to start another command (an over-bound read fails and the run continues, unlike a hard timeout, which
      // aborts the phase): wait for the kill to finish first, so a killed brew no longer holds its lock and a reviewer's
      // directory is not emptied under a child still writing. A child that exits at SIGTERM ends the wait at once.
      // Bounded, not exact: this can run past the caller's timeoutMs (a SIGTERM-ignorer: the grace, then the 1 s exit poll; seen 2070 ms
      // at timeoutMs 300), and a child stuck in uninterruptible sleep outlives the poll, so the group may still be alive on return.
      if (why === "over") await Promise.race([p.exited, new Promise((r) => setTimeout(r, KILL_GRACE_MS))]);
      else await new Promise((r) => setTimeout(r, KILL_GRACE_MS));
      killGroup(pid, "SIGKILL");
      killTree(tree);
      live.delete(pid);
      // Confirm the exit (bounded: 1 s): the group and each killed pid are gone, so the next brew does not meet their lock.
      for (let i = 0; i < 50 && (groupAlive(pid) || tree.some((t) => pidAlive(t.pid))); i++) await new Promise((r) => setTimeout(r, 20));
    }
    if (why === "over") return { rc: OVER_BOUND_RC, out: "", err: `output over ${max} bytes: the command was stopped`, truncated: true };
    return { rc: 124, out: text(out), err: text(err), timedOut: true };
  }
  live.delete(pid);
  return { rc: closeRc(p.exitCode, p.signalCode as NodeJS.Signals | null), out: text(out), err: text(err) };
};
