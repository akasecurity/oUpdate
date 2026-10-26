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

import { join } from "node:path";
import type { ReleaseCheck } from "./config.ts";
import type { Exec } from "./exec.ts";
import type { QueuedOwner } from "./owner-waiter.ts";

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
  kegOnly: boolean;
  /** The version an upgrade installs (stable, with its revision). */
  candidate?: string;
}

/** What brew says about one formula, or undefined when it cannot. */
export async function brewView(exec: Exec, brew: string, name: string): Promise<BrewView | undefined> {
  const r = await exec([brew, "info", "--json=v2", name]);
  if (r.rc !== 0) return undefined;
  let opt: string | undefined;
  const pre = await exec([brew, "--prefix"]);
  const prefix = pre.rc === 0 ? pre.out.trim() : "";
  if (prefix.startsWith("/")) {
    const l = await exec(["/usr/bin/readlink", `${prefix}/opt/${shortName(name)}`]);
    const target = l.rc === 0 ? l.out.trim() : "";
    // ../Cellar/<name>/<version>
    if (target.split("/").at(-2) === shortName(name)) opt = target.split("/").at(-1) || undefined;
  }
  try {
    const f = (JSON.parse(r.out) as { formulae?: { full_name?: unknown; linked_keg?: unknown; keg_only?: unknown; installed?: { version?: unknown }[]; revision?: unknown; versions?: { stable?: unknown } }[] }).formulae?.[0];
    if (!f) return undefined;
    const installed = (f.installed ?? []).map((i) => i?.version).filter((v): v is string => typeof v === "string" && !!v);
    const current = opt ?? (typeof f.linked_keg === "string" && f.linked_keg ? f.linked_keg : installed.length === 1 ? installed[0] : undefined);
    const stable = typeof f.versions?.stable === "string" ? f.versions.stable : undefined;
    const rev = typeof f.revision === "number" && f.revision > 0 ? `_${f.revision}` : "";
    return {
      full: typeof f.full_name === "string" && f.full_name ? f.full_name : name,
      ...(current ? { current } : {}),
      ...(opt ? { opt } : {}),
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
  const r = await env.exec(argv, { timeoutMs: rc.timeoutSec * 1000 });
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
export async function runCheck(env: ReleaseEnv, rc: ReleaseCheck, version: string, gate: AttemptGate): Promise<Verdict | Blocked> {
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
    const r = await env.exec(argv, { env: { GATE_VERSION: version }, timeoutMs: rc.timeoutSec * 1000 });
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
export async function rollback(env: ReleaseEnv, p: PendingCheck, save: () => Promise<void> = async () => {}): Promise<{ ok: true } | { ok: false; why: string; removed: boolean }> {
  // The version in use is the previous one too: uninstalling it would remove the only keg.
  if (p.from && p.to === p.from) return { ok: false, why: `${p.to} is the version it would roll back to — rollback impossible (the only keg is never uninstalled)`, removed: false };
  const prev = join(p.rack, p.from);
  if (!p.from || !p.rack || !(await env.isDir(prev))) return { ok: false, why: `previous keg ${prev || "(unknown)"} is missing — rollback impossible`, removed: false };
  const v = await brewView(env.exec, env.brew, p.full);
  if (!v) return { ok: false, why: "brew info could not be read — not guessing which keg to remove", removed: false };
  const step = async (argv: string[]) => {
    const r = await env.exec(argv);
    env.log.push(`  release check ${p.formula}: ${argv.slice(1).join(" ")} — ${r.rc === 0 && !r.timedOut ? "ok" : `FAILED (${r.timedOut ? "timeout" : `rc ${r.rc}`})`}`);
    return r.rc === 0 && !r.timedOut;
  };
  // The new keg gone: a stopped run's rollback got past its uninstall.
  const resumed = !!p.to && !(await env.isDir(join(p.rack, p.to)));
  if (resumed) {
    if (p.trusted === undefined) return { ok: false, why: `${p.to} was removed by a stopped run before its trust state was recorded — trust and link by hand`, removed: true };
  } else {
    if (v.current !== p.to) return { ok: false, why: `brew uses ${v.current ?? "nothing readable"}, not ${p.to} — not guessing which keg to remove`, removed: false };
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
  const after = await brewView(env.exec, env.brew, p.full);
  if (after?.opt !== p.from) return { ok: false, why: `brew link ${v.full} left the opt link on ${after?.opt ?? "nothing"}, not ${p.from}`, removed: true };
  return { ok: true };
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
  /** The owner could not be restarted yet (busy): the record is kept for a later run. */
  wait?: boolean;
  /** Why it waits (the owner restart's note). */
  waitWhy?: string;
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
    return end({ note: `${f} ${p.to} not checked, owner restart failed`, failed });
  };
  /** The owners were restarted onto the candidate in this run (the record's flag says only that some run did). */
  let restartedNew = false;
  if (!p.ownerRestarted) {
    const r = await o.restartOwner("new");
    if (o.stopping()) return { stopped: true };
    if (r.kind === "busy") return newWaits(r);
    if (r.kind === "failed") return newFailed(r);
    restartedNew = true;
    p.ownerRestarted = true;
    await o.save();
  }
  if (!p.verdict) {
    // Nothing is written until a verdict: FAILs before a blocked retry (or a crash) leave the record as it was.
    const v = await runCheck(env, rc, p.to, gateFor("new", restartedNew));
    if (o.stopping()) return { stopped: true };
    if (v.kind === "blocked") return v.gate.kind === "failed" ? newFailed(v.gate) : newWaits(v.gate);
    p.verdict = v.kind;
    p.tail = v.tail;
    if (v.why) p.why = v.why;
    p.after = v.kind === "fail" ? "skip" : "run";
    await o.save();
  }
  const scores = (p.tail ?? []).join("\n");
  if (p.verdict === "pass") {
    const h = await readHold(env, f);
    if (h && h.version !== p.to) await env.remove(holdPath(env.stateDir, f));
    return end({ note: `${f} ${p.to} PASS` });
  }
  if (p.verdict === "error") {
    await env.notify(`⚠️ <b>${env.host} release check ${f} ${p.to}: could not run (${p.why ?? "?"})</b>\nNo verdict: ${p.to} is kept.\n${scores}\nLog: ${log}`);
    return end({ note: `${f} ${p.to} check could not run (${p.why ?? "?"}), kept` });
  }
  // A confirmed fail: after runs only for a restored version that passes.
  if (!p.rolledBack) {
    // Held before the rollback is tried: a failed version is always held, whether the rollback
    // removes it, cannot, or a stop comes first (a rollback by hand is then not undone by a later run).
    await holdFailed(env, p);
    const rb = await rollback(env, p, o.save);
    if (o.stopping()) return { stopped: true };
    if (!rb.ok) {
      env.log.push(`  release check ${f}: ROLLBACK FAILED — ${rb.why}`);
      await env.notify(`🚨 <b>${env.host} release check FAILED: ${f} ${p.to}, rollback ${rb.removed ? "incomplete" : "impossible"}</b>\n${rb.why}\n${rb.removed ? `${p.to} removed and held` : `${p.to} left installed and held`}. after not run: the host stays as before left it.\n${scores}\nLog: ${log}`);
      return end({ note: `${f} ${p.to} FAIL, rollback ${rb.removed ? "incomplete" : "impossible"} (${rb.why.replaceAll(";", ",")})`, failed });
    }
    p.rolledBack = true;
    await o.save();
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
    const v = await runCheck(env, rc, p.from, gateFor("restored", restartedRestored));
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
