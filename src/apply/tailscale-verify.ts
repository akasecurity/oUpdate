// The verify of a tailscale upgrade, run by the release check (release-checks.ts) with GATE_VERSION=<the installed version>.
//   bun tailscale-verify.ts --host <host> --state <stateDir> --peers <a,b> [-- <argv...>]
// Exit 0: reach verified (the host's record says verified); 1: reach failed (the record says failed, the release check rolls back); 2: could not run (no
// record, an older record for this version is removed, the new version stays and the sweep waits at this host). Without `-- argv` the verify is local:
// `tailscale status --json` must exit 0 and say BackendState Running, Self.Online and a daemon Version equal to GATE_VERSION (the daemon serving the CLI is
// the new one, not a system daemon left on the old keg), then `tailscale ping --c 3 <peer>` must answer from at least one peer (all peers failing is a failed reach; none to ping is exit 2). A tailscale command that hangs past its limit or exits nonzero is a failed reach (exit 1); exit 2 is only for a tailscale that cannot be started.
// The whole check is tried up to ATTEMPTS times before a failure is the verdict, so the record is written once, from the final verdict (the release check
// runs it with no retry of its own). With `-- argv` that command decides (exit 0 pass, 1 fail, anything else could not run), e.g. one that runs the ping
// from a peer.

import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { constants as osConstants } from "node:os";
import { randomBytes } from "node:crypto";
import { baseVersion, recordDir, recordPath, recordText, sameVersion, type SweepRecord } from "./tailscale-sweep.ts";

/** `cut`: the command printed more than the verify keeps, so what it said is incomplete (never a pass). */
export type Run = (argv: string[]) => Promise<{ rc: number | undefined; out: string; cut?: boolean }>;

/** How many times the local reach check runs before a failure stands. */
export const ATTEMPTS = 3;
/** The longest one `tailscale status` and one `tailscale ping --c 3` may take; past it the command is stopped (SIGTERM, then SIGKILL) and counts as hung: a failed reach (exit 1), not "could not run". */
export const STATUS_TIMEOUT_MS = 20_000;
export const PING_TIMEOUT_MS = 30_000;
/** Waited once before the first status (a daemon just restarted needs a moment) and between attempts. */
export const SETTLE_MS = 10_000;
export const RETRY_WAIT_MS = 15_000;
/** The most a local verify can take with `peers` peers: the settle wait, then every attempt runs status and every ping to its limit plus the kill grace and the last second of the runner, with the wait between attempts (307 s for 2 peers). It stays below the release check's own timeout (600 s), so the check never ends on that outer timeout (which would be no verdict). */
export const maxVerifyMs = (peers: number) => SETTLE_MS + ATTEMPTS * (STATUS_TIMEOUT_MS + peers * PING_TIMEOUT_MS + (1 + peers) * (KILL_GRACE_MS + 1_000)) + (ATTEMPTS - 1) * RETRY_WAIT_MS;
/** Test overrides (milliseconds): the settle and retry waits and the per-command limit. Read only when TAILSCALE_VERIFY_TEST=1 is set too, so a stray variable in a service's environment cannot shorten the production waits. */
const fromEnv = (name: string, dflt: number) => {
  const v = process.env.TAILSCALE_VERIFY_TEST === "1" ? process.env[name] : undefined;
  return v !== undefined && v !== "" && Number(v) >= 0 ? Number(v) : dflt;
};

export interface VerifyDeps {
  run: Run;
  version: string | undefined;
  now: () => Date;
  /** False for the check of a restored (rolled back) version: its answer is returned, no record is written or removed. */
  record?: boolean;
  write: (dir: string, path: string, text: string) => Promise<void>;
  remove: (path: string) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  /** Waits (ms) before the first status and between attempts; the real runner takes them from the constants. */
  settleMs?: number;
  retryMs?: number;
  log: (s: string) => void;
}

export interface VerifyArgs {
  host: string;
  state: string;
  peers: string[];
  custom?: string[];
}

export const TAILSCALE = (process.env.TAILSCALE_BIN ?? "").startsWith("/") ? process.env.TAILSCALE_BIN! : "tailscale";

export { baseVersion, sameVersion };

/** Local reach: status ok, running, self online, the new daemon, and every peer pings (at least one peer). */
async function localReach(run: Run, peers: string[], version: string, log: (s: string) => void): Promise<0 | 1 | 2> {
  if (!peers.length) {
    log("no peer to ping: the verify cannot pass (this host is alone in tailscaleCanaryOrder)");
    return 2;
  }
  const st = await run([TAILSCALE, "status", "--json"]);
  // Only a tailscale that cannot be started at all is "could not run"; one that hangs or exits nonzero did not reach, which is the failure the rollback exists for.
  if (st.rc === undefined) return 2;
  if (st.rc !== 0) {
    log(`tailscale status --json: rc ${st.rc}`);
    return 1;
  }
  if (st.cut) {
    log("tailscale status --json: the output is longer than the verify reads — not a status");
    return 1;
  }
  let j: { BackendState?: unknown; Version?: unknown; Self?: { Online?: unknown } };
  try {
    const parsed: unknown = JSON.parse(st.out);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
    j = parsed as typeof j;
  } catch {
    // The daemon answered with something that is not a status: not a reach.
    log("tailscale status --json: not a JSON object");
    return 1;
  }
  if (j.BackendState !== "Running" || j.Self?.Online !== true) {
    log(`tailscale status: BackendState ${String(j.BackendState)}, self online ${String(j.Self?.Online)}`);
    return 1;
  }
  if (typeof j.Version !== "string" || !sameVersion(j.Version, version)) {
    log(`tailscale status: the daemon runs ${String(j.Version)}, not ${version}`);
    return 1;
  }
  // One peer answering is enough (a peer asleep or rebooting is not this host's failure); every peer failing while this host is online is a failed reach.
  for (const p of peers) {
    const r = await run([TAILSCALE, "ping", "--c", "3", p]);
    if (r.rc === undefined) return 2;
    if (r.rc === 0 && !r.cut) return 0;
    log(r.rc === 0 ? `tailscale ping ${p}: the output is longer than the verify reads — not an answer` : `tailscale ping ${p}: rc ${r.rc}`);
  }
  return 1;
}

/** The verify, with every unexpected error (a throw, a failed write or removal) answered as 2, could not run: an uncaught error would exit 1, which the release check reads as a rollback. */
export async function verify(a: VerifyArgs, d: VerifyDeps): Promise<0 | 1 | 2> {
  try {
    return await decide(a, d);
  } catch (e) {
    d.log(`verify could not run: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
}

async function decide(a: VerifyArgs, d: VerifyDeps): Promise<0 | 1 | 2> {
  if (!d.version) {
    d.log("GATE_VERSION is not set");
    return 2;
  }
  const path = recordPath(a.state, d.version);
  let code: 0 | 1 | 2;
  if (a.custom?.length) {
    const r = await d.run(a.custom);
    // A custom verifier that printed more than the verify reads has not answered: a failed verify, whatever it exited.
    code = r.cut || r.rc === 1 ? 1 : r.rc === 0 ? 0 : 2;
  } else {
    code = 1;
    // A daemon that was just restarted is given a moment before the first look, and a failure is looked at again (spaced) before it stands.
    await d.sleep(d.settleMs ?? SETTLE_MS);
    for (let n = 1; n <= ATTEMPTS && code === 1; n++) {
      if (n > 1) await d.sleep(d.retryMs ?? RETRY_WAIT_MS);
      code = await localReach(d.run, a.peers, d.version, d.log);
    }
  }
  if (code === 2) {
    // No verdict: a record left by an earlier try of this version must not stand for it.
    if (d.record !== false) await d.remove(path).catch((e) => d.log(`record not removed: ${e instanceof Error ? e.message : String(e)}`));
    return 2;
  }
  if (d.record === false) return code;
  const rec: SweepRecord = { host: a.host, version: d.version, status: code === 0 ? "verified" : "failed", at: d.now().toISOString() };
  try {
    await d.write(recordDir(a.state), path, recordText(rec));
  } catch (e) {
    // A failed reach check stays failed whatever the record does (the release check rolls back); a verified one that cannot be published is no verdict.
    d.log(`record not written: ${e instanceof Error ? e.message : String(e)}`);
    if (code === 0) return 2;
  }
  return code;
}

export function parseArgs(argv: string[]): VerifyArgs | undefined {
  const dd = argv.indexOf("--");
  const head = dd < 0 ? argv : argv.slice(0, dd);
  const custom = dd < 0 ? undefined : argv.slice(dd + 1);
  const get = (k: string) => {
    const i = head.indexOf(k);
    return i >= 0 ? head[i + 1] : undefined;
  };
  const host = get("--host");
  const state = get("--state");
  if (!host || !state || !state.startsWith("/")) return undefined;
  return { host, state, peers: (get("--peers") ?? "").split(",").filter(Boolean), ...(custom?.length ? { custom } : {}) };
}

const CMD_LIMIT_MS = process.env.TAILSCALE_VERIFY_TEST === "1" && process.env.TAILSCALE_VERIFY_CMD_TIMEOUT_MS ? fromEnv("TAILSCALE_VERIFY_CMD_TIMEOUT_MS", STATUS_TIMEOUT_MS) : undefined;
export const KILL_GRACE_MS = 2_000;
/**
 * The most of a command's output that is kept (the rest is read and dropped, and the run says `cut`). A `tailscale status --json` of a tailnet of hundreds of machines is a few
 * hundred KB; 8 MiB leaves room for far more, and a command that prints past it is a failed reach, never a pass.
 */
const KEEP_BYTES = 8 << 20;

/**
 * Runs a command in a process group of its own and answers its exit code. Past `limitMs` the group gets SIGTERM and, after `graceMs`, SIGKILL, and the answer is 124. A
 * command that started and died of a signal (a crash) answers 128 plus the signal's number. Only a command that could not be started at all (ENOENT, EACCES) answers no code:
 * that is the one case the verify calls "could not run"; every other end of a command that started is a code, so a crash, a hang or a flood is a failed reach.
 * Bun.spawn, not node:child_process: under Bun 1.4.3 a child_process child could finish with no 'close' event delivered on the first spawn of a process (exec.ts realExec).
 */
export const runCommand = (argv: string[], limitMs: number, graceMs = KILL_GRACE_MS): ReturnType<Run> =>
  new Promise((resolve) => {
    let out = "";
    let total = 0;
    let cut = false;
    let stopped = false;
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (rc: number | undefined) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      resolve({ rc, out, ...(cut ? { cut: true } : {}) });
    };
    let child: Bun.Subprocess<"ignore", "pipe", "ignore">;
    try {
      child = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "ignore", detached: true } as never) as unknown as Bun.Subprocess<"ignore", "pipe", "ignore">;
    } catch {
      finish(undefined);
      return;
    }
    const kill = (sig: NodeJS.Signals) => {
      try {
        process.kill(-child.pid, sig);
      } catch {
        // already gone
      }
    };
    timer = setTimeout(() => {
      stopped = true;
      kill("SIGTERM");
      timer = setTimeout(() => {
        // A group that is already gone needs no KILL (and its pid may be someone else's by now).
        try {
          process.kill(-child.pid, 0);
        } catch (e) {
          // Only "no such process" says the group is gone; any other error (a permission one) still gets the KILL.
          if ((e as NodeJS.ErrnoException)?.code === "ESRCH") {
            finish(124);
            return;
          }
        }
        kill("SIGKILL");
        // The close of the killed group answers; if it never comes the answer is 124 anyway.
        timer = setTimeout(() => finish(124), 1_000);
      }, graceMs);
    }, limitMs);
    const decoder = new TextDecoder();
    const read = (async () => {
      const reader = child.stdout.getReader();
      for (;;) {
        const { done: end, value } = await reader.read();
        if (end) return;
        // Bytes, not decoded characters: whatever crosses the limit, even in the last chunk, makes the output cut.
        total += value.byteLength;
        if (total > KEEP_BYTES) cut = true;
        else out += decoder.decode(value, { stream: true });
      }
    })().catch(() => {
      // A stream that failed part-way is an incomplete answer, never a pass.
      cut = true;
    });
    void Promise.all([child.exited, read]).then(() => {
      // Stopped on the limit: the scheduled SIGKILL of the whole group still follows the grace (a member that ignored SIGTERM must not outlive the answer), and it answers.
      if (stopped) return;
      const sig = child.signalCode;
      finish(child.exitCode ?? (sig ? 128 + (osConstants.signals[sig as keyof typeof osConstants.signals] ?? 9) : 137));
    }, () => {
      // A stopped command still answers through the kill chain; only one that was not stopped could not be waited on.
      if (!stopped) finish(undefined);
    });
  });

const realRun: Run = (argv) => runCommand(argv, CMD_LIMIT_MS ?? (argv[1] === "ping" ? PING_TIMEOUT_MS : argv[1] === "status" ? STATUS_TIMEOUT_MS : CUSTOM_LIMIT_MS));
/** A custom verify command (tailscaleVerify) may run longer than status or ping: up to 120 s each (its attempts add up inside the release check's timeout). */
const CUSTOM_LIMIT_MS = 120_000;

if (import.meta.main) {
  const a = parseArgs(process.argv.slice(2));
  if (!a) {
    console.error("usage: tailscale-verify.ts --host <host> --state <absolute dir> [--peers a,b] [-- argv...]");
    process.exit(2);
  }
  const rc = await verify(a, {
    run: realRun,
    version: process.env.GATE_VERSION,
    now: () => new Date(),
    write: async (dir, path, text) => {
      await mkdir(dir, { recursive: true });
      // Written whole to a name of its own, then renamed: a reader never sees half a record and two verifiers never share a temp file.
      const tmp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
      await writeFile(tmp, text);
      await rename(tmp, path);
    },
    record: process.env.GATE_PHASE !== "restored",
    remove: (path) => rm(path, { force: true }),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    settleMs: fromEnv("TAILSCALE_VERIFY_SETTLE_MS", SETTLE_MS),
    retryMs: fromEnv("TAILSCALE_VERIFY_RETRY_MS", RETRY_WAIT_MS),
    log: (s) => console.error(s),
  });
  process.exit(rc);
}
