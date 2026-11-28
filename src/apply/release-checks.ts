// Release checks (config releaseChecks): a gated formula's upgrade is checked on the host. Its
// previous keg is kept through the upgrade (HOMEBREW_NO_INSTALL_CLEANUP, and the run's cleanup
// skips it), then after the upgrade and its owner's restart the check command runs with
// GATE_VERSION=<the installed version>. Exit 0 is PASS, exit 1 FAIL (rerun up to `retries` more
// times; FAIL every time is a confirmed fail), anything else or a timeout is "could not run": no
// verdict, the new version stays.
//
// Every attempt of every check (on the new version, and on the restored one after a rollback; a
// retry as much as the first) runs only through the pre-check gate (preCheckGate), which runCheck
// calls right before it: a fresh scan of every process mapping a keg of the formula other than the
// one the check expects, the owners restarted (at most once per phase per run) and the scan repeated
// when one is found. A process left, or processes that cannot be read, is no check this run (a wait,
// counted toward the limit every owner wait shares); FAILs of attempts before a blocked retry are no
// verdict (nothing is written until one). What a record says was restarted earlier never skips it.
//
// A confirmed fail rolls back. `brew link` always links a formula's latest keg (cmd/link.rb
// resolves `latest_kegs`), so with both kegs on disk it cannot link the older one; `brew uninstall`
// resolves the default keg (the opt link, i.e. the one just installed) and removes only it, leaving
// the previous keg, which `brew link` then links (a keg-only formula: `brew link --force`, which
// writes its opt link, then `brew unlink`, which keeps it). Versions are read from the opt link,
// which is what brew resolves (a keg-only formula has no linked keg). Uninstall also drops the formula's trust entry
// when its tap is not trusted as a whole (cmd/uninstall.rb), so a formula trusted before is trusted
// again. Then the owner is restarted the same way as after the upgrade, the release is held (a
// later run does not upgrade to that version; a newer one is tried) and the check runs again on the
// restored version. A missing previous keg is never guessed at: the new version stays (held too).
//
// before/after (optional): `before` runs right before the upgrade; `after` runs once the check
// passed, could not run, or the restored version passed. Any other verdict (a confirmed fail that
// was not restored to a passing version) leaves `after` unrun: the host stays as `before` left it.
// When the run stops before any verdict (an upgrade failure, an owner restart that failed, an
// error) `after` still runs, so the host is never left off by a run that decided nothing. A
// formula not upgraded this run runs neither.
//
// Files under <stateDir>/release-checks: pending/<formula>.json (an upgrade whose check has not
// decided yet, written before `before` runs, so a run that dies leaves it for the next run) and
// holds/<formula>.json (the held version).

import { join, resolve } from "node:path";
import type { ReleaseCheck } from "./config.ts";
import { LOG_ONLY, type Exec } from "./exec.ts";
import type { QueuedOwner } from "./owner-waiter.ts";
import { recordDir, recordPath, recordText, type SweepRecord } from "./tailscale-sweep.ts";

export interface PendingCheck {
  /** The formula's short name. */
  formula: string;
  /** The name it was upgraded by (tap-qualified for a Type B formula). */
  full: string;
  /** `brew --cellar <formula>`. */
  rack: string;
  /** The version in use (the opt link) before the upgrade. */
  from: string;
  /** The version in use after it; absent while the upgrade has not completed or it could not be read. */
  to?: string;
  /** `before` ran: `after` is owed unless a verdict says otherwise. */
  beforeRan: boolean;
  /** The tailscale sweep: the one version the upgrade was authorized to install (the turn was decided on it), written before brew upgrade runs. An installed version that is another release is a confirmed fail. */
  gated?: string;
  /** The installed version was not the authorized one: a fail with no sweep record of its own (the release was never tested here). */
  unauthorized?: boolean;
  /** The versions whose sweep record is still to be removed (unauthorized or dropped ones): set with the verdict, cleared once the file is gone. */
  invalidate?: string[];
  /**
   * The upgrade was about to start (written before brew upgrade runs): `after` is owed from here
   * on, before or not, unless a verdict says otherwise.
   */
  upgradeStarted?: boolean;
  /** brew upgrade exited 0 and the version in use changed. */
  upgraded?: boolean;
  /** brew upgrade exited 0 but the version in use is still `from`: no upgrade, no check, no rollback. */
  unchanged?: boolean;
  // The steps after the upgrade, each written before the next starts; a later run resumes from the
  // last one written, never re-deriving it.
  /**
   * The owner was restarted onto the new version: a later run does not restart it again up front.
   * Only that: the pre-check gate (preCheckGate) scans every process before the check whatever it says.
   */
  ownerRestarted?: boolean;
  /** The check's verdict on `to`, and its output tail. */
  verdict?: Verdict["kind"];
  /** For a could-not-run verdict: rc N or timeout. */
  why?: string;
  tail?: string[];
  /**
   * The formula was trusted (brew trust --formula) before the rollback's uninstall, which drops the
   * entry: written before the uninstall, so a rollback resumed after it trusts it again.
   */
  trusted?: boolean;
  /**
   * Every owner job the check found to restart (the stale-keg scan's too), written when found: a
   * later run that resumes the record restarts them though its own scan no longer finds them.
   */
  owners?: QueuedOwner[];
  /**
   * Runs whose check waited for its owner (the stale-keg scan did not run or did not look at its
   * keg, a stale process it could not resolve or that stayed on the keg after the named owners
   * restarted, the waiter's lock, a busy owner): at the limit an undecided check ends with no
   * verdict, notified; a decided one is notified and goes on.
   */
  unresolvedWaits?: number;
  /** Runs in which after was withheld because a restart process was still running as root (at AFTER_WITHHELD_RUNS it runs anyway; the count grows only while a fresh helper hangs in each run, as the pid is not kept across runs). */
  afterWithheld?: number;
  /** The new keg was removed and `from` is in use again (the release is held). */
  rolledBack?: boolean;
  /** The owner was restarted onto the restored version (as ownerRestarted: the gate scans regardless). */
  restoredOwnerRestarted?: boolean;
  /** The check's verdict on the restored `from`. */
  restoredVerdict?: Verdict["kind"];
  /** What the verdict says about after: "skip" from a confirmed fail until a restored PASS. */
  after?: "run" | "skip";
  /** The check is over (its verdict path ran to the end, or it ended with no verdict). */
  ended?: boolean;
  /** after ran (exit 0). */
  afterRan?: boolean;
  at: string;
}

export interface HoldRecord {
  formula: string;
  version: string;
  /** The version it was rolled back to. */
  from: string;
  at: string;
}

export const shortName = (n: string) => n.split("/").at(-1)!;
export const releaseDir = (stateDir: string) => join(stateDir, "release-checks");
export const pendingDir = (stateDir: string) => join(releaseDir(stateDir), "pending");
export const pendingPath = (stateDir: string, f: string) => join(pendingDir(stateDir), `${encodeURIComponent(f)}.json`);
export const holdPath = (stateDir: string, f: string) => join(releaseDir(stateDir), "holds", `${encodeURIComponent(f)}.json`);

export function findCheck(checks: readonly ReleaseCheck[] | undefined, name: string): ReleaseCheck | undefined {
  return checks?.find((c) => shortName(c.formula) === shortName(name));
}

/** The argv as run: through `sudo -n -u <user> -H` when the check names a user (oupdate runs as root). */
export function asUser(rc: ReleaseCheck, argv: string[]): string[] {
  return rc.runAs ? ["/usr/bin/sudo", "-n", "-u", rc.runAs, "-H", "--preserve-env=GATE_VERSION", "--", ...argv] : argv;
}

export interface BrewView {
  full: string;
  /** The version in use: the opt link's keg, else the linked keg, else the only one installed. */
  current?: string;
  /** The opt link's keg alone (what brew resolves): absent when the link is missing or unreadable. */
  opt?: string;
  /**
   * What was learned about the opt link: `ok` (it names a keg in the Cellar), `unread` (brew --prefix, brew --cellar or the link read failed: nothing is known), `bad` (the reads
   * worked and the link is missing, dangling, not shaped <package>/<version> or resolves outside the Cellar: positive evidence it names no usable keg).
   */
  optState?: "ok" | "unread" | "bad";
  /** brew's own `linked_keg`: the other link that can name a keg. */
  linked?: string;
  kegOnly: boolean;
  /** The version an upgrade installs (stable, with its revision). */
  candidate?: string;
}

/** What brew's view of a package may be checked against on disk: a keg only counts when its directory is in the Cellar (see brewView). */
export interface KegCheck {
  isDir(path: string): Promise<boolean>;
  realPath?(path: string): Promise<string | undefined>;
}

/** A realpath that says nothing (access, I/O) is the same as no path where only the path is wanted. */
const realOrUndefined = async (real: (path: string) => Promise<string | undefined>, path: string): Promise<string | undefined> => {
  try {
    return await real(path);
  } catch {
    return undefined;
  }
};

/** The disk check for brew's view of a formula with a release check. */
export const kegDirFor = (env: Pick<ReleaseEnv, "isDir" | "realPath">): KegCheck => ({ isDir: env.isDir, ...(env.realPath ? { realPath: env.realPath } : {}) });

/**
 * What brew says about one formula, or undefined when it cannot. With `keg`, a keg counts as installed only when its directory exists and is `<real Cellar>/<package>/<version>` once
 * links are resolved, for the opt link's target (an absolute target is the path itself, a relative one is taken from the link's directory), for linked_keg and for the one installed
 * keg; a `brew --cellar` that cannot be read counts nothing as installed, and a `brew --prefix` that cannot be read only loses the opt link.
 */
export async function brewView(exec: Exec, brew: string, name: string, keg?: KegCheck): Promise<BrewView | undefined> {
  const r = await exec([brew, "info", "--json=v2", name]);
  if (r.rc !== 0) return undefined;
  let opt: string | undefined;
  const pre = await exec([brew, "--prefix"]);
  const prefix = pre.rc === 0 ? pre.out.trim() : "";
  const short = shortName(name);
  // The Cellar is where brew says it is (it is not always <prefix>/Cellar): read once, resolved, and absolute; one that cannot be read counts nothing as installed.
  let cellar: string | undefined;
  if (keg) {
    const c = await exec([brew, "--cellar"]);
    const root = c.rc === 0 ? c.out.trim() : "";
    cellar = root.startsWith("/") ? (keg.realPath ? await realOrUndefined(keg.realPath, root) : root) : undefined;
  }
  // `yes`: a keg of the Cellar. `no`: positive evidence it is not (missing, dangling, not a directory, resolves elsewhere). `unknown`: a stat or realpath failed for a reason that says nothing
  // about the path (access, I/O): nothing is learned, and it is never taken for a missing link.
  const inCellar = async (path: string, version: string): Promise<"yes" | "no" | "unknown"> => {
    if (!keg) return "yes";
    // A version is one folder name: "..", "../../etc" or "a/b" would be folded away by join() and read as a keg of the Cellar.
    if (version === "." || version === ".." || version.includes("/")) return "no";
    if (!cellar) return "unknown";
    let real: string | undefined;
    if (keg.realPath) {
      try {
        real = await keg.realPath(path);
      } catch {
        return "unknown";
      }
      if (real === undefined) return "no";
    }
    if (!(await keg.isDir(path))) return "no";
    return !keg.realPath || real === join(cellar, short, version) ? "yes" : "no";
  };
  let optState: "ok" | "unread" | "bad" = "unread";
  if (prefix.startsWith("/") && (!keg || cellar)) {
    const l = await exec(["/usr/bin/readlink", `${prefix}/opt/${short}`]);
    // rc 1 is a link that is not there (missing, or not a link) and also a path that cannot be looked at (a denied parent directory): /usr/bin/readlink says nothing on stderr for either,
    // so the path is looked up once more where the two differ (realPath: undefined is missing or dangling, a throw is a lookup that failed). Any other rc says nothing about the link.
    let absent = l.rc === 1;
    if (absent && keg?.realPath) {
      try {
        await keg.realPath(`${prefix}/opt/${short}`);
      } catch {
        absent = false;
      }
    }
    if (l.rc === 0 || absent) {
      optState = "bad";
      const target = l.rc === 0 ? l.out.trim() : "";
      // ../Cellar/<name>/<version>
      const version = target.split("/").at(-1);
      if (version && target.split("/").at(-2) === short) {
        const here = await inCellar(resolve(join(prefix, "opt"), target), version);
        if (here === "yes") {
          opt = version;
          optState = "ok";
        } else if (here === "unknown") optState = "unread";
      }
    }
  }
  try {
    const f = (JSON.parse(r.out) as { formulae?: { full_name?: unknown; linked_keg?: unknown; keg_only?: unknown; installed?: { version?: unknown }[]; revision?: unknown; versions?: { stable?: unknown } }[] }).formulae?.[0];
    if (!f) return undefined;
    const installed = (f.installed ?? []).map((i) => i?.version).filter((v): v is string => typeof v === "string" && !!v);
    const there = async (v: string | undefined) => (v && (await inCellar(join(cellar ?? "", short, v), v)) === "yes" ? v : undefined);
    const linked = await there(typeof f.linked_keg === "string" && f.linked_keg ? f.linked_keg : undefined);
    const current = opt ?? linked ?? (installed.length === 1 ? await there(installed[0]) : undefined);
    const stable = typeof f.versions?.stable === "string" ? f.versions.stable : undefined;
    const rev = typeof f.revision === "number" && f.revision > 0 ? `_${f.revision}` : "";
    return {
      full: typeof f.full_name === "string" && f.full_name ? f.full_name : name,
      ...(current ? { current } : {}),
      ...(opt ? { opt } : {}),
      optState,
      ...(linked ? { linked } : {}),
      kegOnly: f.keg_only === true,
      ...(stable ? { candidate: `${stable}${rev}` } : {}),
    };
  } catch {
    return undefined;
  }
}

export interface ReleaseEnv {
  /** Never throws on a timeout: it is returned (timedOut). */
  exec: Exec;
  brew: string;
  stateDir: string;
  host: string;
  logFile?: string;
  /** A state file: undefined only when it is missing; a read that fails otherwise throws. */
  readFile(path: string): Promise<string | undefined>;
  writeFile(path: string, text: string): Promise<void>;
  remove(path: string): Promise<void>;
  isDir(path: string): Promise<boolean>;
  /** The path with every link resolved; undefined when there is no such path (missing, dangling, not a directory in it); throws when the lookup itself failed (access, I/O). */
  realPath?(path: string): Promise<string | undefined>;
  /** What the path itself is (not its target); undefined when it cannot be statted. */
  kind?(path: string): Promise<"dir" | "file" | "link" | undefined>;
  /** Whether the path itself (not its target) is a symlink. */
  isSymlink?(path: string): Promise<boolean>;
  /** The risky packages (short names): each keeps its previous keg, and a pass prunes the older ones. */
  riskyKeep?: readonly string[];
  /** A state directory: [] only when it is missing; a listing that fails otherwise throws. */
  listDir(path: string): Promise<string[]>;
  notify(text: string): Promise<void>;
  log: string[];
  stamp: string;
}

/**
 * The hold file read whole: `unreadable` when one is there but cannot be read or parsed (it holds
 * the formula until fixed: an unknown hold is never no hold). Only a missing file is no hold.
 */
export async function holdState(env: Pick<ReleaseEnv, "readFile" | "stateDir">, f: string): Promise<{ hold?: HoldRecord; unreadable?: boolean }> {
  let t: string | undefined;
  try {
    t = await env.readFile(holdPath(env.stateDir, f));
  } catch {
    return { unreadable: true };
  }
  if (t === undefined) return {};
  const h = parseHold(t);
  return h ? { hold: h } : { unreadable: true };
}

/**
 * Whether brew trusts the formula itself (brew trust --formula): true, false, or undefined when
 * brew's answer cannot be read. A formula with no tap ("/"-less) needs no trust: false.
 */
export async function trustState(exec: Exec, brew: string, full: string): Promise<boolean | undefined> {
  if (!full.includes("/")) return false;
  const t = await exec([brew, "trust", "--formula", "--json=v1"]);
  if (t.rc !== 0 || t.timedOut) return undefined;
  try {
    const list = JSON.parse(t.out) as unknown;
    return Array.isArray(list) ? list.includes(full) : undefined;
  } catch {
    return undefined;
  }
}

function parseHold(t: string): HoldRecord | undefined {
  try {
    const h = JSON.parse(t) as HoldRecord;
    return typeof h.version === "string" && h.version ? h : undefined;
  } catch {
    return undefined;
  }
}

/** The hold, or undefined when there is none or it cannot be read (an unread hold is left in place). */
export async function readHold(env: Pick<ReleaseEnv, "readFile" | "stateDir">, f: string): Promise<HoldRecord | undefined> {
  let t: string | undefined;
  try {
    t = await env.readFile(holdPath(env.stateDir, f));
  } catch {
    return undefined;
  }
  return t === undefined ? undefined : parseHold(t);
}

export const savePending = (env: Pick<ReleaseEnv, "writeFile" | "stateDir">, p: PendingCheck) => env.writeFile(pendingPath(env.stateDir, p.formula), `${JSON.stringify(p)}\n`);

/**
 * Every pending record on disk (an unreadable one is skipped and named; its formula goes into
 * `broken`). A directory that cannot be listed may hide any record: every `gated` formula is broken.
 */
export async function loadPending(env: Pick<ReleaseEnv, "readFile" | "listDir" | "stateDir">, log: string[], broken: string[] = [], gated: readonly string[] = []): Promise<PendingCheck[]> {
  const out: PendingCheck[] = [];
  const dir = pendingDir(env.stateDir);
  let names: string[];
  try {
    names = await env.listDir(dir);
  } catch (e) {
    for (const f of gated) if (!broken.includes(f)) broken.push(f);
    log.push(`  WARNING: release check records ${dir} cannot be listed (${e instanceof Error ? e.message : String(e)}) — every gated formula is held`);
    return out;
  }
  for (const n of names.filter((x) => x.endsWith(".json")).sort()) {
    try {
      const t = await env.readFile(join(dir, n));
      const p = JSON.parse(t ?? "") as PendingCheck;
      if (!p.formula || !p.full || typeof p.rack !== "string") throw new Error("incomplete");
      // A marker that is a list keeps its version strings, a bare string is that version, `true` (the first shape) is the record's own candidate; anything else is dropped.
      if (p.invalidate !== undefined) {
        const raw: unknown = p.invalidate;
        const keep = Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string" && !!v) : typeof raw === "string" && raw ? [raw] : raw === true && p.to ? [p.to] : [];
        if (keep.length) p.invalidate = [...new Set(keep)];
        else delete p.invalidate;
      }
      out.push(p);
    } catch {
      try {
        broken.push(decodeURIComponent(n.slice(0, -".json".length)));
      } catch {
        broken.push(n.slice(0, -".json".length));
      }
      log.push(`  WARNING: release check record ${join(dir, n)} unreadable — skipped, the file is kept`);
    }
  }
  return out;
}

const tailOf = (out: string, n = 15) => out.split("\n").map((l) => l.trimEnd()).filter(Boolean).slice(-n);

/** before or after; true when it exited 0. A failure is logged and notified. */
export async function runHook(env: ReleaseEnv, rc: ReleaseCheck, which: "before" | "after"): Promise<boolean> {
  const argv = asUser(rc, rc[which]!);
  const f = shortName(rc.formula);
  // Log-only: the output feeds tailOf and nothing else, so a hook that prints past the bound and exits 0 still passes.
  const r = await env.exec(argv, { timeoutMs: rc.timeoutSec * 1000, ...LOG_ONLY });
  const ok = r.rc === 0 && !r.timedOut;
  const why = r.timedOut ? "timeout" : `rc ${r.rc}`;
  env.log.push(`  release check ${f}: ${which} ${argv.join(" ")} — ${ok ? "ok" : `FAILED (${why})`}`);
  if (!ok) await env.notify(`⚠️ <b>${env.host} release check ${f}: ${which} FAILED (${why})</b>\n${argv.join(" ")}\n${tailOf(`${r.out}${r.err}`, 5).join("\n")}\nLog: ${env.logFile ?? "-"}`);
  return ok;
}

export interface Verdict {
  kind: "pass" | "fail" | "error";
  /** For error: rc N or timeout. */
  why: string;
  attempts: number;
  tail: string[];
}

/** The check could not start an attempt: its gate (preCheckGate) said busy or failed (or a stop came). No verdict this run. */
export interface Blocked {
  kind: "blocked";
  gate: OwnerResult;
  /** The attempts that ran before the blocked one (their FAILs are no verdict). */
  attempts: number;
}

/** The gate in front of one attempt: ok lets it run; anything else blocks it. */
export type AttemptGate = () => Promise<OwnerResult>;

/**
 * The check on one version: PASS at the first exit 0, FAIL when every attempt exits 1, error at the
 * first other exit or timeout. Every attempt, a retry as much as the first, runs only after `gate`
 * said ok right before it (the owner may respawn on another keg between attempts): a gate that says
 * anything else ends the check blocked, and the FAILs of the attempts before it are no verdict (the
 * record waits as for a gate that blocked the first attempt).
 */
export async function runCheck(env: ReleaseEnv, rc: ReleaseCheck, version: string, gate: AttemptGate, phase: "new" | "restored" = "new"): Promise<Verdict | Blocked> {
  const argv = asUser(rc, rc.command);
  const f = shortName(rc.formula);
  let tail: string[] = [];
  const total = 1 + rc.retries;
  for (let n = 1; n <= total; n++) {
    const g = await gate();
    if (g.kind !== "ok") {
      env.log.push(`  release check ${f} ${version}: attempt ${n}/${total} not run (gate ${g.kind}: ${g.note})${n > 1 ? ` — the ${n - 1} FAIL before it ${n > 2 ? "are" : "is"} no verdict` : ""}`);
      return { kind: "blocked", gate: g, attempts: n - 1 };
    }
    // Log-only: the output feeds tailOf and nothing else, so a check that prints past the bound keeps its real exit code (a FAIL still rolls back), never rc 125 ("could not run").
    const r = await env.exec(argv, { env: { GATE_VERSION: version, ...(phase === "restored" ? { GATE_PHASE: "restored" } : {}) }, timeoutMs: rc.timeoutSec * 1000, ...LOG_ONLY });
    tail = tailOf(`${r.out}${r.err}`);
    const said = r.timedOut ? `timeout after ${rc.timeoutSec} s` : r.rc === 0 ? "PASS" : r.rc === 1 ? "FAIL" : `could not run (rc ${r.rc})`;
    env.log.push(`  release check ${f} ${version}: attempt ${n}/${total} ${said}`);
    if (r.timedOut) return { kind: "error", why: "timeout", attempts: n, tail };
    if (r.rc === 0) return { kind: "pass", why: "", attempts: n, tail };
    if (r.rc !== 1) return { kind: "error", why: `rc ${r.rc}`, attempts: n, tail };
  }
  return { kind: "fail", why: "", attempts: total, tail };
}

/**
 * Back to the previous keg: uninstall the linked (new) keg, link what is left, trust the formula
 * again when it was trusted. `removed`: the new keg is gone (the release is held either way then).
 * A rollback a stopped run began (the new keg already gone) is finished, never inferred done: the
 * link and the trust run again, and only the opt link naming the previous keg is success.
 */
export async function rollback(env: ReleaseEnv, p: PendingCheck, save: () => Promise<void> = async () => {}, o: { builtin?: boolean } = {}): Promise<{ ok: true; note?: string } | { ok: false; why: string; removed: boolean; retry?: true }> {
  // The version in use is the previous one too: uninstalling it would remove the only keg.
  if (p.from && p.to === p.from) return { ok: false, why: `${p.to} is the version it would roll back to — rollback impossible (the only keg is never uninstalled)`, removed: false };
  const prev = join(p.rack, p.from);
  if (!p.from || !p.rack || !(await env.isDir(prev))) return { ok: false, why: `previous keg ${prev || "(unknown)"} is missing — rollback impossible`, removed: false };
  const v = await brewView(env.exec, env.brew, p.full, kegDirFor(env));
  if (!v) return { ok: false, why: "brew info could not be read — not guessing which keg to remove", removed: false };
  const step = async (argv: string[]) => {
    const r = await env.exec(argv);
    env.log.push(`  release check ${p.formula}: ${argv.slice(1).join(" ")} — ${r.rc === 0 && !r.timedOut ? "ok" : `FAILED (${r.timedOut ? "timeout" : `rc ${r.rc}`})`}`);
    return r.rc === 0 && !r.timedOut;
  };
  // The new keg gone: a stopped run's rollback got past its uninstall.
  const resumed = !!p.to && !(await env.isDir(join(p.rack, p.to)));
  // `brew link` links the newest keg left, not a named one: with a keg newer than the previous one in the rack it would link that one. Checked before anything is uninstalled
  // (a resumed rollback has uninstalled already). Fails closed: a rack that cannot be read, or a name or version that cannot be ordered, is a refusal.
  const refuse = (why: string) => ({ ok: false as const, why: `${why}; ${resumed ? `${p.to} is already uninstalled, link ${p.from} by hand` : "nothing is uninstalled, roll back by hand"} (docs/tailscale-upgrades.md)`, removed: resumed });
  let rack: string[];
  try {
    rack = await env.listDir(p.rack);
  } catch (e) {
    return refuse(`${p.rack} could not be read (${e instanceof Error ? e.message : String(e)})`);
  }
  if (!KEG_NAME.test(p.from)) return refuse(`the previous version ${p.from} is not a version brew link can be ordered by`);
  const odd: string[] = [];
  // The candidate itself is listed but cannot be statted: whether it is installed is not known, so it is not taken for uninstalled.
  if (p.to !== undefined && rack.includes(p.to) && env.kind && (await env.kind(join(p.rack, p.to))) === undefined) return { ok: false, why: `${p.to} in ${p.rack} could not be statted — not guessing whether it is installed; nothing is uninstalled, roll back by hand (docs/tailscale-upgrades.md)`, removed: false };
  const unstatted: string[] = [];
  for (const n of rack) {
    if (n === p.to) continue;
    const k = env.kind ? await env.kind(join(p.rack, n)) : (await env.isDir(join(p.rack, n))) ? "dir" : "file";
    if (k === undefined) unstatted.push(n);
    else if (n !== p.to && !KEG_NAME.test(n) && k !== "file") odd.push(n);
  }
  if (unstatted.length) return refuse(`${unstatted.join(", ")} in ${p.rack} could not be statted`);
  if (odd.length) return refuse(`${odd.join(", ")} in ${p.rack} cannot be ordered against ${p.from}, so it is not known which keg brew link would pick`);
  // A tie in version order with another spelling (1.2_0 and 1.2.0) is not known to be older: it counts as newer.
  const newer = rack.filter((n) => n !== p.to && n !== p.from && KEG_NAME.test(n) && kegCompare(n, p.from) >= 0).sort(kegCompare);
  if (newer.length) return refuse(`${newer.join(", ")} in ${p.rack} is newer than ${p.from} (or not told apart from it), so brew link would pick it`);
  if (resumed) {
    if (p.trusted === undefined) return { ok: false, why: `${p.to} was removed by a stopped run before its trust state was recorded — trust and link by hand`, removed: true };
  } else {
    // The tailscale check (or any record with an authorized version) uninstalls only the keg the opt link itself names: what brew's fallback links (linked_keg, the one keg installed) name
    // while the link is bad is not known to be the installed one, whatever the record says. A link that could not be read is not a refusal: nothing is uninstalled and a later run asks again.
    if (o.builtin || p.gated !== undefined) {
      if (v.optState === "unread") return { ok: false, why: `the opt link could not be read — nothing is uninstalled, the rollback is asked again next run`, removed: false, retry: true };
      if (!(v.optState === "ok" && v.opt === p.to)) return { ok: false, why: `the opt link does not name ${p.to} — not guessing which keg to remove; roll back by hand (docs/tailscale-upgrades.md)`, removed: false };
    }
    if (v.current !== p.to) return { ok: false, why: `brew uses ${v.current ?? "nothing readable"}, not ${p.to} — not guessing which keg to remove; roll back by hand (docs/tailscale-upgrades.md)`, removed: false };
    // Read before the upgrade (the record carries it); a record from before that reads it now.
    if (p.trusted === undefined) {
      const trusted = await trustState(env.exec, env.brew, v.full);
      if (trusted === undefined) return { ok: false, why: `brew trust --formula --json=v1 could not be read — not uninstalling ${p.to} (its trust could not be restored)`, removed: false };
      p.trusted = trusted;
      await save();
    }
    if (!(await step([env.brew, "uninstall", v.full]))) return { ok: false, why: `brew uninstall ${v.full} failed`, removed: false };
  }
  // A keg-only formula: link --force writes the opt link, unlink takes the prefix links away again.
  const linked = v.kegOnly ? (await step([env.brew, "link", "--force", v.full])) && (await step([env.brew, "unlink", v.full])) : await step([env.brew, "link", v.full]);
  if (!linked) return { ok: false, why: `brew link ${v.full} failed`, removed: true };
  if (p.trusted && !(await step([env.brew, "trust", "--formula", v.full]))) return { ok: false, why: `brew trust --formula ${v.full} failed — ${p.from} is linked but not trusted again`, removed: true };
  const after = await brewView(env.exec, env.brew, p.full, kegDirFor(env));
  // The reads worked and the link is missing, dangling, wrong-shaped or names another keg: the relink did not land (a failed rollback, never restarted onto nothing). Only reads that
  // failed (brew --prefix, brew --cellar, the link read) say nothing: the restart and the check of the restored version go on, and the note is raised.
  if (after?.optState === "ok" && after.opt === p.from) return { ok: true };
  if (after && after.optState !== "unread") return { ok: false, why: `brew link ${v.full} left the opt link ${after.opt ? `on ${after.opt}` : "missing or not on a keg"}, not on ${p.from}`, removed: true };
  return { ok: true, note: `the opt link could not be read after the relink — ${p.from} is not confirmed linked; its restart and check go on` };
}

/**
 * A confirmed fail of the tailscale check, made durable in this order: the verdict on the pending record first (the rollback never depends on the sweep record),
 * then the host's failed sweep record for `version`. A record that cannot be written is logged and never turns the fail into no verdict.
 */
export async function failedRecord(env: Pick<ReleaseEnv, "writeFile" | "stateDir" | "host" | "stamp" | "log">, p: PendingCheck, version: string, save: () => Promise<void>): Promise<void> {
  await save();
  const rec: SweepRecord = { host: env.host, version, status: "failed", at: env.stamp };
  try {
    await env.writeFile(recordPath(env.stateDir, version), recordText(rec));
  } catch (e) {
    env.log.push(`  release check ${p.formula}: WARNING — the failed sweep record for ${version} could not be written (${e instanceof Error ? e.message : String(e)}); the rollback goes on`);
  }
}

/**
 * The tailscale check authorizes one version (p.gated; none on the record: nothing). An installed version that is another release is never verified: a confirmed fail, then the rollback and
 * hold as for any fail. No sweep record is written: that release was never tested here, so nothing about it is for the fleet to read. True when it was one.
 */
export async function failUnauthorized(env: Pick<ReleaseEnv, "writeFile" | "readFile" | "remove" | "stateDir" | "host" | "stamp" | "log">, p: PendingCheck, save: () => Promise<void>): Promise<boolean> {
  // The comparison is exact (a revision `1.80.2_1` is not `1.80.2`). A record with no authorized version (written before it was kept) authorizes nothing.
  // A saved PASS is no authorization: only a pass of the authorized version stands (a record with a PASS and no authorized version is legacy).
  if (!p.to || p.to === p.gated || (p.verdict && !(p.verdict === "pass" && !p.rolledBack))) return false;
  return failNotVerified(env, p, save, p.gated ? `installed ${p.to}, the tailscale sweep decided on ${p.gated}` : `installed ${p.to} with no authorized version on the record`);
}

/** The confirmed fail of a version that was never verified, with the rollback and hold of any fail; its sweep record is removed (see failUnauthorized). */
async function failNotVerified(env: Pick<ReleaseEnv, "writeFile" | "readFile" | "remove" | "stateDir" | "host" | "stamp" | "log">, p: PendingCheck, save: () => Promise<void>, why: string): Promise<true> {
  p.unauthorized = true;
  p.verdict = "fail";
  p.why = why;
  p.tail = [p.why];
  p.after = "skip";
  // A record this host already published for that version (a verify that passed before the run died) must not stand for a release that was never authorized. The marker is saved with
  // the verdict, before the removal, and cleared only once the file is gone: a crash or a failed removal leaves it, and every later run removes again.
  p.invalidate = [...new Set([...(p.invalidate ?? []), p.to!])];
  env.log.push(`  release check ${p.formula}: ${p.why} — rolled back`);
  await save();
  await invalidateRecord(env, p, save);
  return true;
}

/**
 * The version the tailscale check stands on after an install or on a recovery: the opt link's keg alone (brew's other links are not read for it). `ok` adopts it; `bad` (the link is
 * positively missing or names no keg) with a keg named by brew's other links is a confirmed fail of that keg, never verified; `unread` adopts nothing (the check stays pending).
 */
export async function adoptInstalled(env: Pick<ReleaseEnv, "writeFile" | "readFile" | "remove" | "stateDir" | "host" | "stamp" | "log" | "listDir" | "isDir">, p: PendingCheck, v: BrewView | undefined, save: () => Promise<void>): Promise<void> {
  if (v?.optState === "ok" && v.opt) p.to = v.opt;
  else if (v?.optState === "bad") {
    const named = await installedAbove(env, p, v);
    if (named) {
      p.to = named;
      await failOptLink(env, p, save);
    }
  }
}

/** A confirmed fail of the version on the record: the opt link is positively missing or names no keg of the Cellar, so nothing says that version is in use. */
export async function failOptLink(env: Pick<ReleaseEnv, "writeFile" | "readFile" | "remove" | "stateDir" | "host" | "stamp" | "log">, p: PendingCheck, save: () => Promise<void>): Promise<boolean> {
  // A version that is the one to roll back to is no upgrade (a legacy record with to == from): nothing is invalidated or rolled back for it.
  if (!p.to || p.to === p.from) return false;
  return failNotVerified(env, p, save, `the opt link names no keg of the Cellar (${p.to} is named only by brew's other links), so ${p.to} is not verified`);
}

/**
 * The version an interrupted install left: only the authorized version, when brew's links name it or the rack lists it as a keg (the install started and died before it was recorded: only a
 * record at upgradeStarted can have installed one). undefined when neither is so or the rack cannot be listed.
 */
export async function installedAbove(env: Pick<ReleaseEnv, "listDir" | "isDir">, p: PendingCheck, v: BrewView | undefined): Promise<string | undefined> {
  // Only the keg the record authorized can be an install that died before it was recorded: any other keg (one kept by hand, whatever brew's fallback links name while the opt link is bad) never is.
  if (!p.upgradeStarted || !p.gated || !p.from || !KEG_NAME.test(p.from) || !KEG_NAME.test(p.gated) || kegCompare(p.gated, p.from) <= 0) return undefined;
  if (v?.current === p.gated) return p.gated;
  try {
    return (await env.listDir(p.rack)).includes(p.gated) && (await env.isDir(join(p.rack, p.gated))) ? p.gated : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Why this host may not delete its sweep record of `version`: undefined when there is none or it names this host (only that one is this host's to remove). A record that names another
 * host, no host or a non-string one, is not a record, or cannot be read is held, named, the file left as it is (the same way out as a stale record: remove it by hand).
 */
export async function candidateRecordHold(env: Pick<ReleaseEnv, "readFile" | "stateDir" | "host">, version: string): Promise<string | undefined> {
  const path = recordPath(env.stateDir, version);
  let text: string | undefined;
  try {
    text = await env.readFile(path);
  } catch (e) {
    return `the sweep record ${path} of ${version} cannot be read (${e instanceof Error ? e.message : String(e)}): remove it by hand if it is not this host's`;
  }
  if (text === undefined) return undefined;
  let rec: { host?: unknown; version?: unknown; status?: unknown } | null;
  try {
    rec = JSON.parse(text) as { host?: unknown; version?: unknown; status?: unknown } | null;
  } catch {
    return `the sweep record ${path} of ${version} is not a record: remove it by hand if it is not this host's`;
  }
  const host = rec?.host;
  // This host's own is a record of this version with a status; anything else at the path is not this host's to delete.
  if (host === env.host && rec?.version === version && (rec.status === "verified" || rec.status === "failed")) return undefined;
  if (host === env.host) return `the sweep record ${path} of ${version} names this host but is not a record of ${version}: remove it by hand if it is not this host's`;
  return `the sweep record ${path} of ${version} ${typeof host === "string" && host ? `was written by host ${host}` : "names no host"}: remove it by hand if it is not this host's`;
}

/**
 * The records in this host's sweep directory that must not stand while another version is installed: a verified record of a version newer than the one in use that is not the candidate
 * (a version this host verified and then dropped or rolled back, a hand rollback included, whose removal failed along with its marker: nothing else remembers it). One this host wrote
 * (its `host` is this host) is removed here and the attempt goes on (the safe direction); it holds only when the removal fails, when the record names another host (copied in: not ours
 * to delete), or when the file cannot be read or the directory cannot be listed (a directory that is not there is no record). Older versions' records, failed records (the hold
 * remembers those) and the candidate's own (removed at the start of its attempt) are not stale. Each entry says what to look at.
 */
export async function staleSweepRecords(env: Pick<ReleaseEnv, "listDir" | "readFile" | "remove" | "stateDir" | "host" | "log">, installed: string, candidate: string): Promise<string[]> {
  const dir = recordDir(env.stateDir);
  let names: string[];
  try {
    names = await env.listDir(dir);
  } catch (e) {
    return [`${dir} could not be listed (${e instanceof Error ? e.message : String(e)})`];
  }
  const stale: string[] = [];
  for (const n of names.filter((x) => x.endsWith(".json")).sort()) {
    const path = join(dir, n);
    try {
      const r = JSON.parse((await env.readFile(path)) ?? "") as { host?: unknown; version?: unknown; status?: unknown };
      if (typeof r.version !== "string" || !r.version || (r.status !== "verified" && r.status !== "failed")) throw new Error("not a sweep record");
      if (r.status === "failed" || r.version === candidate || r.version === installed) continue;
      // An older version's record is history; a newer one (or one that cannot be ordered) is not the version in use.
      if (KEG_NAME.test(r.version) && KEG_NAME.test(installed) && kegCompare(r.version, installed) < 0) continue;
      const what = `${path} (verified ${r.version}, installed ${installed}`;
      if (r.host !== env.host) {
        stale.push(`${what}, written by ${typeof r.host === "string" && r.host ? `host ${r.host}` : "no host"}: remove it by hand if it is not this host's)`);
        continue;
      }
      try {
        await env.remove(path);
        env.log.push(`  release check: the sweep record ${path} of ${r.version} is removed — this host verified it and ${installed} is in use`);
      } catch (e) {
        stale.push(`${what}; its removal failed: ${e instanceof Error ? e.message : String(e)})`);
      }
    } catch (e) {
      stale.push(`${path} (unreadable: ${e instanceof Error ? e.message : String(e)})`);
    }
  }
  return stale;
}

/**
 * Removes this host's sweep record of an unauthorized version and clears the marker. The owner is read again on every removal (the file at the path may have been replaced since the marker
 * was written): only a record that names this host is deleted; another host's, a hostless, malformed or unreadable one stays, flagged, the marker with it. A removal that fails is logged
 * and the marker stays. True when no record of this host is left.
 */
export async function invalidateRecord(env: Pick<ReleaseEnv, "readFile" | "remove" | "stateDir" | "host" | "log">, p: PendingCheck, save: () => Promise<void>): Promise<boolean> {
  if (!p.invalidate?.length) return true;
  const left: string[] = [];
  for (const v of p.invalidate) {
    const path = recordPath(env.stateDir, v);
    const held = await candidateRecordHold(env, v);
    if (held !== undefined) {
      left.push(v);
      env.log.push(`  release check ${p.formula}: WARNING — ${held} — not removed, asked again next run`);
      continue;
    }
    try {
      await env.remove(path);
    } catch (e) {
      left.push(v);
      env.log.push(`  release check ${p.formula}: WARNING — the sweep record ${path} of ${v} could not be removed (${e instanceof Error ? e.message : String(e)}) — asked again next run`);
    }
  }
  if (left.length) {
    p.invalidate = left;
    return false;
  }
  delete p.invalidate;
  try {
    await save();
  } catch (e) {
    // The files are gone; a marker that stays on disk only asks for the removals once more.
    env.log.push(`  release check ${p.formula}: WARNING — the pending record could not be saved after the removal (${e instanceof Error ? e.message : String(e)})`);
  }
  return true;
}

/** Version order of two keg names (digits split at dots and `_`): negative when a is older. */
function kegCompare(a: string, b: string): number {
  const x = a.split(/[._]/).map(Number);
  const y = b.split(/[._]/).map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** A keg directory name of brew: digits and dots, optionally a `_N` revision (never `README`, a dotfile or a path). */
const KEG_NAME = /^\d+(\.\d+)*(_\d+)?$/;

/**
 * After a pass of a risky package: its kegs other than the verified one and the one before it are removed, so the previous version stays available and only one older keg
 * is ever kept. The rack is resolved (realpath) and must be the package's own directory directly under the real Cellar; only version-shaped names, never a symlink, never what
 * brew's links name now (read again right before each removal), never the verified or previous one.
 */
export async function pruneOlderKegs(env: Pick<ReleaseEnv, "exec" | "brew" | "listDir" | "isDir" | "log" | "realPath" | "isSymlink" | "riskyKeep">, p: PendingCheck & { to: string }): Promise<string | undefined> {
  const skip = (why: string) => {
    env.log.push(`  release check ${p.formula}: ${p.to} verified — older kegs not pruned (${why})`);
    return why;
  };
  if (!p.rack.startsWith("/") || p.rack.split("/").at(-1) !== shortName(p.formula) || !p.from) return;
  if (!env.realPath || !env.isSymlink) return skip("the filesystem cannot resolve links");
  const cellar = await env.exec([env.brew, "--cellar"]);
  const realCellar = cellar.rc === 0 && cellar.out.trim().startsWith("/") ? await realOrUndefined(env.realPath, cellar.out.trim()) : undefined;
  const realRack = await realOrUndefined(env.realPath, p.rack);
  if (!realCellar || !realRack || realRack !== join(realCellar, shortName(p.formula))) return skip(`${p.rack} is not ${shortName(p.formula)} under the real Cellar`);
  let names: string[];
  try {
    names = await env.listDir(realRack);
  } catch {
    return skip(`${p.rack} could not be listed`);
  }
  let unread: string | undefined;
  for (const v of names.sort()) {
    // Only kegs older than the previous one: the previous, the verified and anything newer (a keg kept by hand) stay, and never keep older kegs from being pruned.
    if (v === p.to || v === p.from || !KEG_NAME.test(v) || kegCompare(v, p.from) >= 0) continue;
    const keg = join(realRack, v);
    if ((await env.isSymlink(keg)) || (await realOrUndefined(env.realPath, keg)) !== keg) {
      env.log.push(`  release check ${p.formula}: ${v} is a link, not a keg — left alone`);
      continue;
    }
    // The links brew has now, read again just before the removal: the keg they name stays.
    const live = await brewView(env.exec, env.brew, p.full, kegDirFor(env));
    // Either link keeps its keg; the opt link must have been read (an unreadable prefix or link leaves what is in use unknown): otherwise nothing is pruned.
    if (!live || !live.opt || live.current === v || live.opt === v || live.linked === v) {
      env.log.push(`  release check ${p.formula}: ${v} is in use or its links could not be read — left alone`);
      if (!live?.opt) unread = `its opt link ${live?.optState === "unread" || !live ? "could not be read" : "is missing or names no keg"}, so ${v} and the older kegs after it are not pruned`;
      continue;
    }
    const r = await env.exec(["/bin/rm", "-rf", keg]);
    env.log.push(`  release check ${p.formula}: ${p.to} verified — the older keg ${v} ${r.rc === 0 ? "removed" : `NOT removed (rm FAILED rc ${r.rc})`}; ${p.from} is kept for a rollback`);
    if (r.rc !== 0) unread ??= `the older keg ${v} could not be removed (rm rc ${r.rc})`;
  }
  return unread;
}

/** Holds the version a confirmed fail was decided on (a later run does not upgrade to it; a newer one is tried). */
export async function holdFailed(env: Pick<ReleaseEnv, "writeFile" | "stateDir" | "log" | "stamp">, p: PendingCheck & { to: string }): Promise<void> {
  const rec: HoldRecord = { formula: p.formula, version: p.to, from: p.from, at: env.stamp };
  await env.writeFile(holdPath(env.stateDir, p.formula), `${JSON.stringify(rec)}\n`);
  env.log.push(`  release check ${p.formula}: ${p.to} HELD (${holdPath(env.stateDir, p.formula)})`);
}

export interface Decision {
  /** For the summary: no ";" (the summary parser splits there). */
  note?: string;
  failed?: string;
  /** Said in the result and flagged, though the check ended well (a prune that could not run). */
  flag?: string;
  /** The owner could not be restarted yet (busy): the record is kept for a later run. */
  wait?: boolean;
  /** Why it waits (the owner restart's note, or the rollback's reason). */
  waitWhy?: string;
  /** What is waiting when it is not the owner restart: the rollback, which could not read the link. */
  waitFor?: "rollback";
  /** A stop arrived: nothing more was written; the record resumes from its last step. */
  stopped?: boolean;
}

export type OwnerResult = { kind: "ok" | "busy" | "failed"; note: string };

/** The processes mapping a keg of the formula: by pid, with the keg directory each maps. */
export type KegProcs = { pid: string; keg: string }[];

/** "pid 1 2 maps <keg>, pid 3 maps <keg>": the processes by keg. */
export function holding(hs: KegProcs): string {
  const kegs = [...new Set(hs.map((h) => h.keg))];
  return kegs.map((k) => `pid ${[...new Set(hs.filter((h) => h.keg === k).map((h) => h.pid))].join(" ")} maps ${k}`).join(", ");
}

/**
 * The one gate in front of every check (the candidate's and the restored version's, in a fresh run
 * or a resumed one, whatever the record's restart flags say): a fresh scan of every process mapping a
 * keg of the formula other than the one the check expects (the previous keg, any older retained
 * one, the rejected one after a rollback; a child, an orphan, a respawn alike). None: ok. Some, and
 * the owners not restarted for this check in this run: they are restarted (inline) and the scan runs
 * again. Any process left, or a scan that cannot read the processes: busy (no check this run, the
 * wait counted). A failed owner restart: failed, as for the restart before the check.
 */
export async function preCheckGate(
  env: Pick<ReleaseEnv, "log">,
  f: string,
  expect: string,
  restarted: boolean,
  o: { scan: () => Promise<KegProcs | undefined>; restart: () => Promise<OwnerResult>; stopping: () => boolean },
): Promise<OwnerResult> {
  let left = await o.scan();
  if (left && !left.length) {
    env.log.push(`  release check ${f}: no process maps a ${f} keg other than ${expect} ${restarted ? "after its owners restarted" : "before the check"}`);
    return { kind: "ok", note: "" };
  }
  if (left && !restarted) {
    env.log.push(`  release check ${f}: ${holding(left)} before the check — its owners are restarted first`);
    const r = await o.restart();
    if (r.kind !== "ok" || o.stopping()) return r;
    restarted = true;
    left = await o.scan();
    if (left && !left.length) {
      env.log.push(`  release check ${f}: no process maps a ${f} keg other than ${expect} after its owners restarted`);
      return { kind: "ok", note: r.note };
    }
  }
  const note = !left
    ? `the ${f} processes could not be read before the check`
    : `${holding(left).replaceAll(" maps ", " still maps ")}${restarted ? " after its owners restarted" : ""}`;
  env.log.push(`  release check ${f}: ${note}`);
  return { kind: "busy", note };
}

/**
 * Takes an upgraded record from its last written step to the end: owner restart, check, and on a
 * confirmed fail rollback, hold, owner restart and the check on the restored version. Each step is
 * saved before the next one starts. `p.after` is written with the verdict ("skip" from a confirmed
 * fail on, "run" when the check passed or could not run, or the restored version passed); the
 * caller runs after from it. A result that came in while oupdate is stopping is not written.
 */
export async function resume(
  env: ReleaseEnv,
  rc: ReleaseCheck,
  p: PendingCheck & { to: string },
  o: {
    save: () => Promise<void>;
    restartOwner: (phase: "new" | "restored") => Promise<OwnerResult>;
    /** Every process mapping a keg of the formula other than `expect` now (a fresh scan), or undefined when they cannot be read. */
    scan: (expect: string) => Promise<KegProcs | undefined>;
    stopping: () => boolean;
  },
): Promise<Decision> {
  const f = p.formula;
  const log = env.logFile ?? "-";
  const failed = `release-check:${f}`;
  const end = async (d: Decision): Promise<Decision> => {
    // A notice made while oupdate is stopping was never sent (nothing starts then): not ended, so
    // the next run resumes from the last step written and says it.
    if (o.stopping()) return { stopped: true };
    p.ended = true;
    await o.save();
    return d;
  };
  /**
   * The gate (preCheckGate) in front of every attempt of one phase's check, on the keg it expects.
   * `restarted`: its owners were restarted for it in this run; a gate that restarts them sets it, so
   * the owners are restarted at most once per phase per run (a retry's gate only scans again). A
   * stop arriving in it blocks the attempt (resume reports the stop).
   */
  const gateFor = (phase: "new" | "restored", restarted: boolean): AttemptGate => {
    const expect = join(p.rack, phase === "new" ? p.to : p.from);
    return async () => {
      const r = await preCheckGate(env, f, expect, restarted, {
        scan: () => o.scan(expect),
        restart: () => {
          restarted = true;
          return o.restartOwner(phase);
        },
        stopping: o.stopping,
      });
      return o.stopping() && r.kind === "ok" ? { kind: "busy", note: "oupdate is stopping" } : r;
    };
  };
  const newWaits = (r: OwnerResult): Decision => ({ wait: true, waitWhy: r.note, note: `${f} ${p.to} check waits for its owner (${r.note})` });
  const newFailed = async (r: OwnerResult) => {
    // No verdict, the new version kept: after is owed as for a check that could not run, before or not.
    p.after = "run";
    await env.notify(`⚠️ <b>${env.host} release check ${f} ${p.to}: not run, the owner restart failed</b>\n${r.note}\nLog: ${log}`);
    if (o.stopping()) return { stopped: true };
    // Not ended: no verdict was reached, so the record and the previous keg (the rollback) stay for a
    // later run (bounded by the run's owner-wait count, which ends it).
    await o.save();
    return { wait: true, waitWhy: r.note, note: `${f} ${p.to} not checked, owner restart failed`, failed };
  };
  /** The owners were restarted onto the candidate in this run (the record's flag says only that some run did). */
  let restartedNew = false;
  /**
   * The check the config makes for tailscale: an owner that cannot be restarted onto the candidate is a failed verify, not "no verdict". The node would stay on the
   * new version with a daemon nobody restarted and the sweep stopped behind it; it is rolled back as any confirmed fail, and the host's record says failed.
   */
  const asFailedVerify = async (r: OwnerResult) => {
    p.verdict = "fail";
    p.tail = [`owner restart failed: ${r.note}`];
    p.why = `owner restart failed: ${r.note}`;
    p.after = "skip";
    await failedRecord(env, p, p.to, o.save);
  };
  if (!p.ownerRestarted && !p.verdict) {
    const r = await o.restartOwner("new");
    if (o.stopping()) return { stopped: true };
    if (r.kind === "busy") return newWaits(r);
    if (r.kind === "failed" && rc.builtin) await asFailedVerify(r);
    else if (r.kind === "failed") return newFailed(r);
    else {
      restartedNew = true;
      p.ownerRestarted = true;
      await o.save();
    }
  }
  if (!p.verdict) {
    // Nothing is written until a verdict: FAILs before a blocked retry (or a crash) leave the record as it was.
    const v = await runCheck(env, rc, p.to, gateFor("new", restartedNew));
    if (o.stopping()) return { stopped: true };
    if (v.kind === "blocked" && v.gate.kind === "failed" && rc.builtin) await asFailedVerify(v.gate);
    else if (v.kind === "blocked") return v.gate.kind === "failed" ? newFailed(v.gate) : newWaits(v.gate);
    else {
      p.verdict = v.kind;
      p.tail = v.tail;
      if (v.why) p.why = v.why;
      p.after = v.kind === "fail" ? "skip" : "run";
      await o.save();
    }
  }
  const scores = (p.tail ?? []).join("\n");
  if (p.verdict === "pass") {
    const h = await readHold(env, f);
    if (h && h.version !== p.to) await env.remove(holdPath(env.stateDir, f));
    // The tailscale check: the version before this one stays (the rollback one command away); any older keg is replaced by it, now that the new one is verified.
    const pruneSkipped = rc.builtin || env.riskyKeep?.includes(shortName(f)) ? await pruneOlderKegs(env, p as PendingCheck & { to: string }) : undefined;
    // A prune that could not run is said so in the result: older kegs pile up until a later pass prunes them.
    return end({ note: `${f} ${p.to} PASS`, ...(pruneSkipped ? { flag: `${f} ${p.to} PASS, older kegs not pruned (${pruneSkipped.replaceAll(";", ",")})` } : {}) });
  }
  if (p.verdict === "error" && rc.builtin) {
    // The tailscale check could not decide (a timeout, an unexpected exit): the new version stays and so does the previous keg, the record is kept and the next run
    // asks again; nothing is recorded and the sweep stops at this host until a verdict.
    const why = p.why ?? "?";
    delete p.verdict;
    delete p.why;
    await o.save();
    await env.notify(`⚠️ <b>${env.host} release check ${f} ${p.to}: could not run (${why})</b>\nNo verdict: ${p.to} stays, its previous keg is kept, the next run asks again.\n${scores}\nLog: ${log}`);
    return { wait: true, waitWhy: `no verdict (${why})`, note: `${f} ${p.to} check could not run (${why}), asked again next run` };
  }
  if (p.verdict === "error") {
    await env.notify(`⚠️ <b>${env.host} release check ${f} ${p.to}: could not run (${p.why ?? "?"})</b>\nNo verdict: ${p.to} is kept.\n${scores}\nLog: ${log}`);
    return end({ note: `${f} ${p.to} check could not run (${p.why ?? "?"}), kept` });
  }
  // A confirmed fail: after runs only for a restored version that passes.
  /** A rollback an earlier run made: its relink is read again before the owners are restarted onto it. */
  const rolledEarlier = p.rolledBack === true;
  if (!p.rolledBack) {
    // Held before the rollback is tried: a failed version is always held, whether the rollback
    // removes it, cannot, or a stop comes first (a rollback by hand is then not undone by a later run).
    await holdFailed(env, p);
    const rb = await rollback(env, p, o.save, { builtin: rc.builtin === true });
    if (o.stopping()) return { stopped: true };
    if (!rb.ok && rb.retry) {
      // Not decided: the link could not be read this time. The fail and its hold stand, the record stays, and the next run rolls back (flagged meanwhile).
      env.log.push(`  release check ${f}: rollback waits — ${rb.why}`);
      return { wait: true, waitFor: "rollback", waitWhy: rb.why, note: `${f} ${p.to} FAIL, rollback waits (${rb.why.replaceAll(";", ",")})`, failed };
    }
    if (!rb.ok) {
      env.log.push(`  release check ${f}: ROLLBACK FAILED — ${rb.why}`);
      await env.notify(`🚨 <b>${env.host} release check FAILED: ${f} ${p.to}, rollback ${rb.removed ? "incomplete" : "impossible"}</b>\n${rb.why}\n${rb.removed ? `${p.to} removed and held` : `${p.to} left installed and held`}. after not run: the host stays as before left it.\n${scores}\nLog: ${log}`);
      return end({ note: `${f} ${p.to} FAIL, rollback ${rb.removed ? "incomplete" : "impossible"} (${rb.why.replaceAll(";", ",")})`, failed });
    }
    p.rolledBack = true;
    await o.save();
    if (rb.note) {
      env.log.push(`  release check ${f}: ${rb.note}`);
      await env.notify(`⚠️ <b>${env.host} release check ${f} ${p.to}: rolled back, ${rb.note}</b>\nLog: ${log}`);
    }
  }
  // The relink is read again before any owner is restarted onto the restored version: the restart in this run, or the gate's own restart when the check of the restored version
  // resumes (the flag of an earlier restart says nothing about the link now).
  if (rolledEarlier && !p.restoredVerdict) {
    const now = await brewView(env.exec, env.brew, p.full, kegDirFor(env));
    if (!now || now.optState === "unread") {
      const note = `the opt link could not be read after the relink${now ? "" : " (brew info failed)"} — ${p.from} is not confirmed linked; its restart and check go on`;
      env.log.push(`  release check ${f}: ${note}`);
      await env.notify(`⚠️ <b>${env.host} release check ${f} ${p.to}: rolled back, ${note}</b>\nLog: ${log}`);
    } else if (now && !(now.optState === "ok" && now.opt === p.from)) {
      const why = `the opt link is ${now.opt ? `on ${now.opt}` : "missing or not on a keg"}, not on ${p.from}, though the rollback was recorded`;
      env.log.push(`  release check ${f}: ROLLBACK FAILED — ${why}`);
      await env.notify(`🚨 <b>${env.host} release check FAILED: ${f} ${p.to}, rollback incomplete</b>\n${why}\n${p.to} removed and held. after not run: the host stays as before left it.\n${scores}\nLog: ${log}`);
      return end({ note: `${f} ${p.to} FAIL, rollback incomplete (${why.replaceAll(";", ",")})`, failed });
    }
  }
  const restoredFailed = async (rs: OwnerResult) => {
    await env.notify(`🚨 <b>${env.host} release check FAILED: ${f} ${p.to}, rolled back to ${p.from}, owner restart failed</b>\n${rs.note}\n${p.to} held. ${p.from} not checked, after not run.\n${scores}\nLog: ${log}`);
    return end({ note: `${f} ${p.to} FAIL, rolled back to ${p.from} (held), owner restart failed: ${rs.note}`, failed });
  };
  /** The owners were restarted onto the restored version in this run. */
  let restartedRestored = false;
  if (!p.restoredOwnerRestarted) {
    const rs = await o.restartOwner("restored");
    if (o.stopping()) return { stopped: true };
    if (rs.kind !== "ok") return restoredFailed(rs);
    restartedRestored = true;
    p.restoredOwnerRestarted = true;
    await o.save();
  }
  let again: string[] = [];
  if (!p.restoredVerdict) {
    const v = await runCheck(env, rc, p.from, gateFor("restored", restartedRestored), "restored");
    if (o.stopping()) return { stopped: true };
    if (v.kind === "blocked") {
      const g = v.gate;
      if (g.kind === "failed") return restoredFailed(g);
      return { wait: true, waitWhy: g.note, note: `${f} ${p.to} FAIL, rolled back to ${p.from} (held), its check waits for its owner (${g.note})` };
    }
    p.restoredVerdict = v.kind;
    p.after = v.kind === "pass" ? "run" : "skip";
    again = v.tail;
    await o.save();
  }
  if (p.restoredVerdict === "pass") {
    await env.notify(`⚠️ <b>${env.host} release check FAILED: ${f} ${p.to} — rolled back to ${p.from}</b>\n${p.to} held (a newer release is tried). ${p.from} passes.\n${scores}\nLog: ${log}`);
    return end({ note: `${f} ${p.to} FAIL, rolled back to ${p.from} (held, ${p.from} PASS)`, failed });
  }
  const said = p.restoredVerdict === "fail" ? "FAILED too" : "could not be checked";
  await env.notify(`🚨 <b>${env.host} release check: ${f} ${p.to} FAILED and the restored ${p.from} ${said}</b>\nafter not run: the host stays as before left it.\n${p.to} held.\n${p.to}:\n${scores}\n${p.from}:\n${again.join("\n")}\nLog: ${log}`);
  return end({ note: `${f} ${p.to} FAIL, rolled back to ${p.from} (held), ${p.from} ${p.restoredVerdict === "fail" ? "FAIL" : "check could not run"}, after not run`, failed });
}
