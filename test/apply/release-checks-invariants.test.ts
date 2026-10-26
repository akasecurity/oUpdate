// Release checks: the state machine explored. One host world (kegs, the opt link, the owner
// process, the state files) is carried across up to five runs of the apply run, with a gated
// formula with and without before/after and owners (none, a staleOwners job found by its keg, a
// named owner, a process no owner can be found for). The first run is crashed at every state write
// and external effect (SIGKILL before or after it: nothing after it takes effect; SIGTERM: the stop
// path runs), gets EACCES on every state-file op, or has an external call fail (nonzero, nonzero
// after its effect, malformed output, timeout, a busy waiter lock) drawn from a fixed seed, once or
// on every run, sometimes with a second failure or crash in the next run; the later runs recover.
// Invariants:
//   I1 once before ran, after runs exactly once by the end, unless the outcome is a confirmed FAIL
//      not restored to a passing version (then at most once, and never after the FAIL). A SIGKILL
//      or EACCES between a successful after and the write recording it may run after once more
//      (at least once, never left off); an after failing on every run is notified instead (I4).
//      A run that started the gated upgrade and was not killed tries after itself (its finally or,
//      on SIGTERM, its stop path), with or without before, unless it decided a confirmed FAIL not
//      restored to a passing version;
//   I2 a persisted FAIL is held, and its rollback is tried within the runs (a waiter lock busy on
//      every run may keep it waiting, notified);
//   I3 a new version left installed has a PASS, a held FAIL or a release-check notice;
//   I4 no pending record outlives the five runs without a notice of its own;
//   I5 within a run, after never runs before a check (the stop path runs last);
//   I6 a check never runs while the owner job (its own pid or any child it started, one orphaned by
//      a restart too) still runs another version (the previous one, or an older retained keg it
//      came up on), the job respawning between runs on any retained keg (the previous one, or an
//      older one) too, before the restored check as much as the new-version one, and the job already
//      running an older retained keg before the first run;
//   I7 a rollback never uninstalls the only installed keg (a brew upgrade that exited 0 without
//      changing the version, or another updater that installed the candidate first, is no upgrade);
//   I8 another formula's upgrade never pulls the gated formula's candidate in as a dependency (its
//      new release depends on the gated formula, its installed release does not), the gated formula
//      outdated or not installed at all (its release held or not).
import { describe, expect, test } from "bun:test";
import type { ReleaseCheck } from "../../src/apply/config.ts";
import type { Exec, ExecResult } from "../../src/apply/exec.ts";
import type { ApplyFs } from "../../src/apply/fs.ts";
import { isStopping, killLive, resetStopping, runStopTasks } from "../../src/apply/exec.ts";
import { applyHost } from "../../src/apply/run.ts";
import { fakeHost, fakeTypeB, testConfig } from "./host-fixture.ts";
import { scripted } from "./helpers.ts";

const OLD = "1.1.0";
const FROM = "1.2.0";
const TO = "1.3.0";
const PENDING = "/state.test/release-checks/pending/splash.json";
const HOLD = "/state.test/release-checks/holds/splash.json";
const LSOF_HEAD = "COMMAND PID USER FD TYPE DEVICE SIZE NODE NAME\n";
const LABEL = "com.max.splash-server";
const RUNS = 5;

type Hooks = "both" | "after" | "none";
/**
 * none; a staleOwners job found by its keg mapping; a named owner; a named owner that is a shell
 * wrapper (its own pid maps no keg) whose child maps the keg, with no staleOwners set (its first
 * restart after the linked version changes starts the child from the keg the child ran before, while
 * that keg exists); that wrapper leaving its old child alive, orphaned, on every restart
 * (wrapper-leak) or only on a restart after its keg was uninstalled (wrapper-leak-restored: the
 * rejected version's child survives the rollback's restart); a process with no owner on the
 * previous keg (from run 1, or from run 2 on); a staleOwners job or a named owner whose own pid and
 * its child both map the keg, the child (listed after its parent) outliving every restart,
 * orphaned (svc-leak, named-leak).
 */
type Owners = "none" | "svc" | "svc-leak" | "named" | "named-leak" | "wrapper" | "wrapper-leak" | "wrapper-leak-restored" | "orphan" | "orphan-late";
type Outcome = "pass" | "error" | "fail-pass" | "fail-fail" | "flaky";
type Kind = "rc1" | "rc1-effect" | "malformed" | "timeout" | "eacces" | "busy" | "kill-before" | "kill-after" | "term";
interface Fault {
  run: number;
  /** The op index in that run (every exec, state-file and lock call counts). */
  op: number;
  kind: Kind;
  /** The same command line (or the waiter lock) fails on every run from the first. */
  persistent?: boolean;
}
interface Case {
  hooks: Hooks;
  owners: Owners;
  outcome: Outcome;
  faults: Fault[];
  /**
   * noop: brew upgrade exits 0 and changes nothing (every run). concurrent: another updater installs
   * the candidate and cleans the previous keg up after the outdated query, before the gated upgrade
   * reads the version in use, so brew upgrade has nothing left to do.
   */
  upgrade?: "noop" | "concurrent";
  /**
   * Before every run after the first, the owner job respawns on its own on this retained keg (while
   * it exists): the previous one (FROM), or the older one (OLD, then kept on disk from the start).
   */
  respawn?: string;
  /** The owner job's processes already run on the older retained keg (OLD, kept on disk) before the first run. */
  startOld?: boolean;
  /**
   * A second formula, good-a, outdated until upgraded, whose new release depends on splash (runtime,
   * or build only); its installed release does not. Its brew upgrade installs splash's candidate
   * when splash is outdated, as brew does a dependency.
   */
  dependent?: "runtime" | "build-only";
  /** splash is not installed at the start (no keg), its candidate held (a hold file present) or not. */
  absent?: "held" | "unheld";
  /**
   * An older keg (1.1.0) is retained too, and the owner job's first restart after the upgrade (new)
   * or after the rollback (restored) brings its processes up on it, once.
   */
  retained?: "new" | "restored";
  /**
   * Between a check's attempts: after an attempt on a version exits 1 (the first such attempt on each
   * version), the owner job respawns on its own on this retained keg (while it is on disk) before the
   * next attempt: the previous one (FROM) or the older one (OLD, then kept on disk from the start).
   */
  retryRespawn?: string;
  /** The check's retries (default 1). */
  retries?: number;
}
type Ev =
  | { run: number; k: "before" | "after"; ok: boolean; stop: boolean }
  | { run: number; k: "check"; v: string; rc: number; owner?: string[] }
  | { run: number; k: "pending"; rec: Record<string, unknown> }
  | { run: number; k: "pending-rm" | "upgrade" }
  | { run: number; k: "uninstall"; only: boolean }
  | { run: number; k: "pulled" }
  | { run: number; k: "notify"; text: string };

/** mulberry32: a fixed seed gives the same cases every run. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const isExecFault = (k: Kind) => k === "rc1" || k === "rc1-effect" || k === "malformed" || k === "timeout";

/** Runs one case across up to RUNS runs; returns the events and the world at the end. */
async function explore(c: Case) {
  const check: ReleaseCheck = {
    formula: "incoai/tap/splash", command: ["/opt/gate.test/check"], retries: c.retries ?? 1, timeoutSec: 900,
    ...(c.hooks === "both" ? { before: ["ohost", "off", "--now"] } : {}),
    ...(c.hooks !== "none" ? { after: ["ohost", "on"] } : {}),
    ...(c.owners.startsWith("named") || c.owners.startsWith("wrapper") ? { owners: [LABEL] } : {}),
  };
  const svc = c.owners.startsWith("svc");
  const named = c.owners.startsWith("named");
  /** The owner's own pid maps the keg and its child does too, the child outliving each restart. */
  const parentLeak = c.owners === "svc-leak" || c.owners === "named-leak";
  const staleOwners = svc ? [{ match: "org.example.splash", probe: ["/opt/svc.test/idle"] }] : named ? [{ match: LABEL, probe: ["/opt/svc.test/idle"] }] : c.owners.startsWith("orphan") ? [{ match: "org.example.custom" }] : undefined;
  // The world.
  const files = new Map<string, string>();
  const kegs = new Set(c.absent ? [] : c.retained || c.startOld || c.respawn === OLD || c.retryRespawn === OLD ? [OLD, FROM] : [FROM]);
  let linked = c.absent ? "" : FROM;
  if (c.absent === "held") files.set(HOLD, `${JSON.stringify({ formula: "splash", version: TO, from: FROM, at: "2026-10-25 04:00" })}\n`);
  /** The candidate was installed once (the restored restart comes after it). */
  let upgradedOnce = false;
  /** The retained keg already started on (once). */
  let oldStarted = false;
  /** The keg a restart (not a respawn pinned to a keg) starts on: the older retained one once, at its phase. */
  const startKeg = () => {
    const phase = linked === TO ? "new" : upgradedOnce && linked === FROM ? "restored" : undefined;
    if (c.retained && !oldStarted && phase === c.retained && kegs.has(OLD)) {
      oldStarted = true;
      return OLD;
    }
    return linked || FROM;
  };
  let nextPid = 77;
  const wrapper = c.owners.startsWith("wrapper");
  /** The owner job's process and the keg it maps (none with no owner; a wrapper maps none, its child does). */
  let ownerPid = svc || named || wrapper ? String(nextPid) : "";
  /** The keg the owner job's processes run before the first run. */
  const firstKeg = c.startOld ? OLD : FROM;
  const procKeg = new Map<string, string>(ownerPid && !wrapper ? [[ownerPid, firstKeg]] : []);
  /** A child's parent pid: the wrapper's child. */
  const parentOf = new Map<string, string>();
  /** Versions the wrapper already started its child from after they stopped being linked (once each). */
  const staleStarted = new Set<string>();
  /** Every process the owner job started (each wrapper's children, orphaned or not), alive or not. */
  const jobPids = new Set<string>(ownerPid ? [ownerPid] : []);
  if (wrapper || parentLeak) {
    const child = String(++nextPid);
    procKeg.set(child, firstKeg);
    parentOf.set(child, ownerPid);
    jobPids.add(child);
  }
  /** The kegs the owner job's live processes map: its own pid, its children, and children a restart orphaned. */
  const ownerKegs = () => [...jobPids].flatMap((pid) => (procKeg.has(pid) ? [procKeg.get(pid)!] : []));
  const checkRuns = new Map<string, number>();
  /** The versions whose failing attempt the owner job already respawned after (retryRespawn: once each). */
  const retryRespawned = new Set<string>();
  const events: Ev[] = [];
  let clockT = 0;
  const persistentLines = new Set<string>();
  /** The op count of each run. */
  const ops: number[] = [];
  const opLabels: string[][] = [];
  /** The runs a SIGKILL ended (their finally and stop path never ran). */
  const killed = new Set<number>();
  /** good-a (the dependent) upgraded. */
  let depDone = false;

  for (let run = 1; run <= RUNS; run++) {
    let op = 0;
    let dead = false;
    let term = false;
    const faultAt = (n: number) => c.faults.find((f) => f.run === run && f.op === n);
    /** One op: returns the fault to apply to it, after handling crashes. */
    const labels: string[] = [];
    const enter = async (label: string): Promise<{ fault?: Fault; skip: boolean; termAfter: boolean }> => {
      const n = op++;
      labels.push(label);
      if (dead) return { skip: true, termAfter: false };
      const f = faultAt(n);
      if (f?.kind === "kill-before") {
        dead = true;
        return { skip: true, termAfter: false };
      }
      return { fault: f, skip: false, termAfter: f?.kind === "term" };
    };
    const crashAfter = async (f?: Fault) => {
      if (f?.kind === "kill-after") dead = true;
      if (f?.kind === "term" && !term) {
        term = true;
        await killLive(0);
      }
    };

    // The orphan: started from the previous keg, no launchd job, never restarted by anyone.
    if (c.owners === "orphan" || (c.owners === "orphan-late" && run >= 2)) procKeg.set("66", FROM);
    // Not installed is not outdated (brew outdated lists installed formulae only).
    const outdated = kegs.size > 0 && [...kegs].sort().at(-1)! < TO;
    const dep = c.dependent && !depDone;
    const h = fakeHost({
      formulas: [...(dep ? ["good-a"] : []), ...(outdated ? ["splash"] : [])].join(" "),
      verbose: [...(dep ? ["good-a (1.0) < 1.1"] : []), ...(outdated ? [`incoai/tap/splash (${[...kegs].sort().at(-1)}) < ${TO}`] : [])].join("\n"),
      formulaTaps: { splash: "incoai/tap", "good-a": "homebrew/core" },
    });
    const lsofAll = () => LSOF_HEAD + [...procKeg].map(([pid, v]) => `splash ${pid} u txt REG 1,4 1 2 /brew/Cellar/splash/${v}/bin/splash\n`).join("");
    const services = () => (ownerPid ? `\t\t      ${ownerPid}      - \t${svc ? "org.example.splash" : LABEL}\n` : "");
    const target = svc ? "gui/501/org.example.splash" : `system/${LABEL}`;
    /** A restart of the owner job; `on`: its new processes start from that keg (a respawn pinned to it). */
    const kick = (on?: string) => {
      if (wrapper) {
        // The wrapper and its child are replaced; the child starts from its old keg once after the link moved.
        const [old] = [...parentOf].find(([, pp]) => pp === ownerPid) ?? [];
        const was = old ? procKeg.get(old) : undefined;
        // A leaking wrapper's old child outlives the restart, orphaned (reparented to launchd).
        const leak = c.owners === "wrapper-leak" || (c.owners === "wrapper-leak-restored" && was !== undefined && !kegs.has(was));
        if (old && leak) parentOf.set(old, "1");
        else if (old) {
          procKeg.delete(old);
          parentOf.delete(old);
        }
        ownerPid = String(++nextPid);
        jobPids.add(ownerPid);
        const child = String(++nextPid);
        jobPids.add(child);
        const sticky = !on && was !== undefined && was !== linked && kegs.has(was) && !staleStarted.has(was);
        if (sticky) staleStarted.add(was);
        procKeg.set(child, on ?? (sticky ? was : startKeg()));
        parentOf.set(child, ownerPid);
        return;
      }
      if (ownerPid) {
        procKeg.delete(ownerPid);
        // Its child outlives it, orphaned (reparented to launchd), still on the keg it ran.
        for (const [kid, pp] of parentOf) if (pp === ownerPid) parentOf.set(kid, "1");
      }
      ownerPid = String(++nextPid);
      jobPids.add(ownerPid);
      const k = on ?? startKeg();
      procKeg.set(ownerPid, k);
      if (parentLeak) {
        const child = String(++nextPid);
        jobPids.add(child);
        procKeg.set(child, k);
        parentOf.set(child, ownerPid);
      }
    };
    // Between runs the owner job respawns on its own, on its retained keg while it is on disk.
    if (c.respawn && run >= 2 && ownerPid && kegs.has(c.respawn)) kick(c.respawn);
    /** The other updater ran (concurrent): once, in the first run. */
    let other = run > 1;
    /** The world's answer to a command, applying its effect. */
    const answer = async (argv: string[], opt: Parameters<Exec>[1] = {}): Promise<ExecResult> => {
      const line = argv.join(" ");
      const ok = (out = ""): ExecResult => ({ rc: 0, out, err: "" });
      if (line === "brew info --json=v2 splash" || line === "brew info --json=v2 incoai/tap/splash") {
        if (c.upgrade === "concurrent" && !other) {
          other = true;
          kegs.clear();
          kegs.add(TO);
          linked = TO;
        }
        return ok(JSON.stringify({ formulae: [{ name: "splash", full_name: "incoai/tap/splash", tap: "incoai/tap", keg_only: false, linked_keg: linked || null, installed: [...kegs].sort().map((version) => ({ version })), versions: { stable: TO }, revision: 0 }] }));
      }
      if (line === "/usr/bin/readlink /brew/opt/splash") return linked ? ok(`../Cellar/splash/${linked}\n`) : { rc: 1, out: "", err: "" };
      if (line === "brew --cellar splash") return ok("/brew/Cellar/splash\n");
      if (line.startsWith("brew deps ") && line.endsWith(" good-a") && c.dependent) {
        // brew as it answers: a plain query reads the installed keg's runtime dependencies; any
        // include flag, the candidate's declared ones (build ones only with --include-build).
        const flags = argv.slice(2, -1);
        const declared = flags.some((f) => f.startsWith("--include-"));
        return ok(declared && (c.dependent === "runtime" || flags.includes("--include-build")) ? "zlib\nsplash\n" : "zlib\n");
      }
      if (line.startsWith("brew deps ")) return ok("");
      if (line === "brew upgrade good-a" && c.dependent) {
        depDone = true;
        // brew installs the dependency's newest release, held or not.
        if (([...kegs].sort().at(-1) ?? "") < TO) {
          events.push({ run, k: "pulled" });
          kegs.add(TO);
          linked = TO;
        }
        return ok("upgraded\n");
      }
      if (line === "brew list --formula --full-name") return ok(`${c.dependent ? "good-a\n" : ""}${kegs.size ? "incoai/tap/splash\n" : ""}`);
      if (line === "brew list --cask") return ok("");
      if (line === "brew trust --formula --json=v1") return ok("[]");
      if (line === "brew upgrade incoai/tap/splash") {
        if (c.upgrade === "noop") return ok("already up to date\n");
        upgradedOnce = true;
        kegs.add(TO);
        linked = TO;
        return ok("upgraded\n");
      }
      if (line === "brew uninstall incoai/tap/splash") {
        events.push({ run, k: "uninstall", only: kegs.size <= 1 });
        if (linked) kegs.delete(linked);
        linked = "";
        return ok();
      }
      if (line === "brew link incoai/tap/splash") {
        linked = [...kegs].sort().at(-1) ?? "";
        return ok();
      }
      if (line === "/opt/gate.test/check") {
        const v = opt.env?.GATE_VERSION ?? "?";
        const n = (checkRuns.get(v) ?? 0) + 1;
        checkRuns.set(v, n);
        const rc = v === TO
          ? (c.outcome === "pass" ? 0 : c.outcome === "error" ? 2 : c.outcome === "flaky" ? (n === 1 ? 1 : 0) : 1)
          : c.outcome === "fail-fail" ? 1 : 0;
        // The owner job respawns on its own between this attempt and the next (once per version).
        if (rc === 1 && c.retryRespawn && ownerPid && kegs.has(c.retryRespawn) && !retryRespawned.has(v)) {
          retryRespawned.add(v);
          kick(c.retryRespawn);
        }
        return { rc, out: `score ${v}\n`, err: "" };
      }
      if (line === "ohost off --now" || line === "ohost on") return ok();
      if (line === "/opt/svc.test/idle") return ok();
      if (argv[0]!.endsWith("lsof")) {
        if (argv.includes("-iTCP")) return { rc: 1, out: "", err: "" };
        if (argv.includes("-p")) {
          const pid = argv[argv.indexOf("-p") + 1]!;
          const v = procKeg.get(pid);
          return ok(LSOF_HEAD + (v ? `splash ${pid} u txt REG 1,4 1 2 /brew/Cellar/splash/${v}/bin/splash\n` : ""));
        }
        return ok(lsofAll());
      }
      if (argv[0] === "ps") {
        const pid = argv[4]!;
        if (wrapper && pid === ownerPid) return ok(`${argv[2] === "comm=" ? "sh" : argv[2] === "command=" ? "sh -c splash serve" : "1"}\n`);
        if (!procKeg.has(pid)) return { rc: 1, out: "", err: "" };
        return ok(`${argv[2] === "comm=" ? "splash" : argv[2] === "command=" ? "splash serve" : (parentOf.get(pid) ?? "1")}\n`);
      }
      if (line === "launchctl print gui/501") return ok(`gui/501 = {\n\tservices = {\n${svc ? services() : ""}\t}\n}\n`);
      if (line === "launchctl print system") return ok(`system = {\n\tservices = {\n${named || wrapper ? services() : ""}\t}\n}\n`);
      if (line === `launchctl print ${target}` && c.owners !== "none") {
        const plist = svc ? "/home.test/Library/LaunchAgents/org.example.splash.plist" : `/Library/LaunchDaemons/${LABEL}.plist`;
        return ok(`\tstate = running\n\tpid = ${ownerPid}\n\tpath = ${plist}\n`);
      }
      if (line === `launchctl kickstart -k ${target}` || line === `sudo -n launchctl kickstart -k ${target}`) {
        kick();
        return ok();
      }
      if (argv[0] === "launchctl") return { rc: 113, out: "", err: "not found" };
      if (argv[0] === "notify-cmd") {
        events.push({ run, k: "notify", text: argv.slice(1).join(" ") });
        return ok();
      }
      return h.exec(argv, opt);
    };
    const record = (argv: string[], r: ExecResult, stop: boolean) => {
      const line = argv.join(" ");
      if (line === "ohost off --now") events.push({ run, k: "before", ok: r.rc === 0 && !r.timedOut, stop });
      if (line === "ohost on") events.push({ run, k: "after", ok: r.rc === 0 && !r.timedOut, stop });
    };
    const exec: Exec = async (argv, opt = {}) => {
      const line = argv.join(" ");
      if (isStopping() && !opt.force) return { rc: 143, out: "", err: "oupdate is stopping: not started" };
      const e = await enter(`exec ${line}`);
      if (e.skip) return { rc: 137, out: "", err: "killed" };
      if (line === "brew upgrade incoai/tap/splash") events.push({ run, k: "upgrade" });
      const f = e.fault;
      // Notices are delivered (a failed notice is the notifier's fault, not the state machine's).
      const faulty = argv[0] !== "notify-cmd";
      if (faulty && f && isExecFault(f.kind) && f.persistent) persistentLines.add(line);
      const kind = faulty ? (persistentLines.has(line) ? c.faults.find((x) => x.persistent)!.kind : f && isExecFault(f.kind) ? f.kind : undefined) : undefined;
      if (e.termAfter) {
        // The signal arrives while this command runs: it is killed.
        await crashAfter(f);
        if (line === "/opt/gate.test/check") events.push({ run, k: "check", v: opt.env?.GATE_VERSION ?? "?", rc: 143 });
        record(argv, { rc: 143, out: "", err: "" }, false);
        return { rc: 143, out: "", err: "" };
      }
      // A hook's or the check's failure has no effect; elsewhere rc1-effect and the rest apply the effect first.
      const hook = line === "ohost on" || line === "ohost off --now";
      // The owner job's kegs while the check runs (a respawn after it ends does not count).
      const ownerDuring = ownerPid ? ownerKegs() : undefined;
      let r: ExecResult;
      if (kind === "rc1" || ((kind === "rc1-effect" || kind === "malformed") && hook)) r = { rc: 1, out: "", err: "injected" };
      else if (kind === "timeout" && hook) r = { rc: 124, out: "", err: "", timedOut: true };
      else {
        r = await answer(argv, opt);
        if (kind === "rc1-effect") r = { rc: 1, out: r.out, err: "injected" };
        else if (kind === "malformed") r = { rc: 0, out: "{garbage\x00", err: "" };
        else if (kind === "timeout") r = { rc: 124, out: "", err: "", timedOut: true };
      }
      if (line === "/opt/gate.test/check") {
        events.push({ run, k: "check", v: opt.env?.GATE_VERSION ?? "?", rc: r.timedOut ? 124 : r.rc, ...(ownerDuring ? { owner: ownerDuring } : {}) });
      }
      record(argv, r, !!opt.force && isStopping());
      await crashAfter(f);
      return r;
    };
    /** A state-file op: faulted (EACCES), skipped when dead, crashing before or after it. */
    const fsOp = async <T>(label: string, fn: () => Promise<T>, dflt: T): Promise<T> => {
      const e = await enter(label);
      if (e.skip) return dflt;
      if (e.fault?.kind === "eacces") throw new Error("EACCES: permission denied");
      const v = await fn();
      await crashAfter(e.fault);
      return v;
    };
    const dirs = () => new Set(["/brew/Cellar", "/brew/Cellar/splash", ...[...kegs].map((v) => `/brew/Cellar/splash/${v}`)]);
    const plists = named || wrapper ? [`/Library/LaunchDaemons/${LABEL}.plist`] : svc ? ["/home.test/Library/LaunchAgents/org.example.splash.plist"] : [];
    const fs: ApplyFs = {
      ...h.fs,
      exists: async (p) => files.has(p) || dirs().has(p) || plists.includes(p),
      isDir: async (p) => dirs().has(p),
      listDir: async () => [],
      readFile: async (p) => files.get(p),
      readState: (p) => fsOp(`read ${p}`, async () => files.get(p), undefined),
      listState: (d) => fsOp(`list ${d}`, async () => [...files.keys()].filter((k) => k.startsWith(`${d}/`)).map((k) => k.slice(d.length + 1)), [] as string[]),
      writeFile: (p, t) => fsOp(`write ${p}`, async () => {
        files.set(p, t);
        if (p === PENDING) events.push({ run, k: "pending", rec: JSON.parse(t) as Record<string, unknown> });
      }, undefined),
      remove: (p) => fsOp(`rm ${p}`, async () => {
        files.delete(p);
        if (p === PENDING) events.push({ run, k: "pending-rm" });
      }, undefined),
      appendFile: (p, t) => fsOp(`append ${p}`, async () => void files.set(p, (files.get(p) ?? "") + t), undefined),
      spawnDetached: async () => 4242,
    };
    resetStopping();
    await applyHost(testConfig({ npm: null, typeBTaps: ["incoai/tap"], releaseChecks: [check], notify: ["notify-cmd"], ...(staleOwners ? { staleOwners } : {}) }), exec, fs, {
      dryRun: false, reviewer: scripted([], "APPROVE").r, typeB: fakeTypeB().typeB, now: new Date(2026, 9, 26, 4, 0),
      ownerClock: { now: () => clockT, sleep: async (ms) => void (clockT += ms), httpStatus: async () => 200 },
      ownerLock: {
        take: async () => {
          const e = await enter("lock take");
          if (e.skip) return true;
          const busy = e.fault?.kind === "busy" || c.faults.some((f) => f.persistent && f.kind === "busy" && f.run <= run);
          await crashAfter(e.fault);
          return !busy;
        },
        release: async () => void (await enter("lock release")),
      },
    });
    // A SIGTERM runs the stop path; any other run leaves its stop tasks unrun (the process exits).
    if (term && !dead) await runStopTasks(() => {});
    if (dead) killed.add(run);
    ops.push(op);
    opLabels.push(labels);
    dead = true;
    await runStopTasks(() => {});
    resetStopping();
    if (run >= 2 && !files.has(PENDING) && !c.faults.some((f) => f.persistent)) break;
  }
  return { events, files, linked, kegs, ops, opLabels, killed, depDone, oldStarted };
}

/** The invariant violations of one explored case (empty: all hold). */
function violations(c: Case, w: Awaited<ReturnType<typeof explore>>): string[] {
  const out: string[] = [];
  const ev = w.events;
  const pend = ev.filter((e): e is Extract<Ev, { k: "pending" }> => e.k === "pending");
  const failAt = ev.findIndex((e) => e.k === "pending" && e.rec.verdict === "fail");
  const restoredPassAt = ev.findIndex((e) => e.k === "pending" && e.rec.restoredVerdict === "pass");
  const excepted = failAt >= 0 && restoredPassAt < 0;
  // A notice of its own (the run's done notice, which repeats every run, is no alert).
  const rcNotice = (from = 0) => ev.slice(from).some((e) => e.k === "notify" && !e.text.includes("secure-update done") && e.text.includes("splash") && /release check/.test(e.text));
  // I1
  // A SIGKILL between a successful after and the write that records it: after runs again (at least once, never left off).
  // Or the write that records it failing (EACCES): the record cannot say after ran.
  const killedPastAfter = c.faults.some((f) => (f.kind === "kill-after" && w.opLabels[f.run - 1]?.[f.op] === "exec ohost on")
    || ((f.kind === "kill-before" || (f.kind === "eacces" && w.opLabels[f.run - 1]?.[f.op] === `write ${PENDING}`)) && w.opLabels[f.run - 1]?.[f.op - 1] === "exec ohost on"));
  // An after that fails on every run never succeeds: it is notified each run instead (I4).
  const afterAlwaysFails = c.faults.some((f) => f.persistent && w.opLabels[f.run - 1]?.[f.op] === "exec ohost on");
  if (c.hooks === "both" && !afterAlwaysFails) {
    const befores = ev.flatMap((e, i) => (e.k === "before" ? [i] : []));
    befores.forEach((b, j) => {
      const end = befores[j + 1] ?? ev.length;
      const afters = ev.slice(b, end).filter((e) => e.k === "after" && e.ok).length;
      const most = killedPastAfter ? 2 : 1;
      if (excepted ? afters > most : afters < 1 || afters > most) out.push(`I1: before #${j + 1} was followed by ${afters} successful after runs${excepted ? " (a confirmed FAIL not restored)" : ""}`);
    });
  }
  if (excepted && ev.slice(failAt).some((e) => e.k === "after" && e.ok)) out.push("I1: after ran after a persisted FAIL whose restored version never passed");
  // I1, with or without before: an upgraded check that passed, could not run (an error verdict, or
  // ended with no verdict) or whose restored version passed discharges a configured after.
  if (c.hooks !== "none" && !afterAlwaysFails && !excepted) {
    // The record as last written: an upgraded one ending (or removed) with no verdict could not run.
    let rec: Record<string, unknown> | undefined;
    const upgraded = (r?: Record<string, unknown>) => !!r && r.to === TO && r.upgraded === true;
    const owedAt = ev.findIndex((e) => {
      if (e.k === "pending") rec = e.rec;
      if (e.k === "pending") return upgraded(e.rec) && (e.rec.after === "run" || (e.rec.ended === true && !e.rec.verdict));
      return e.k === "pending-rm" && upgraded(rec) && !rec!.verdict;
    });
    if (owedAt >= 0) {
      // Counted from the upgrade (after is saved with the verdict that owes it, so it may come
      // first); with before, from the last before: an after already run for it (a wait) discharges it.
      const upgradeAt = ev.findIndex((e) => e.k === "pending" && upgraded(e.rec));
      const lastBefore = ev.slice(0, owedAt).findLastIndex((e) => e.k === "before" && e.ok);
      const afters = ev.slice(lastBefore >= 0 ? lastBefore : upgradeAt).filter((e) => e.k === "after" && e.ok).length;
      if (afters < 1) out.push("I1: an upgraded check that passed, could not run or was restored to a passing version never discharged after");
      // With no before, each upgrade started owes one after (as each before does): counted from the last one.
      const lastUpgrade = ev.slice(0, owedAt).findLastIndex((e) => e.k === "upgrade");
      const all = ev.slice(Math.max(lastUpgrade, 0)).filter((e) => e.k === "after" && e.ok).length;
      if (c.hooks === "after" && all > (killedPastAfter ? 2 : 1)) out.push(`I1: after (no before) ran ${all} times for one upgrade`);
    }
  }
  // I1 within the run: a run that started the gated upgrade owes after from that moment, before or
  // not, and discharges it itself (its finally, or its stop path on SIGTERM), not only through a
  // later run's recovery. Exempt: a SIGKILLed run (nothing of it runs), and a run that decided a
  // confirmed FAIL whose restored version did not pass in it.
  if (c.hooks !== "none" && !afterAlwaysFails) {
    for (let run = 1; run <= RUNS; run++) {
      const inRun = ev.filter((e) => e.run === run);
      if (!inRun.some((e) => e.k === "upgrade") || w.killed.has(run)) continue;
      const onTo = inRun.filter((e): e is Extract<Ev, { k: "check" }> => e.k === "check" && e.v === TO);
      const failed = onTo.some((e) => e.rc === 1) && !onTo.some((e) => e.rc === 0);
      const restoredPass = inRun.some((e) => e.k === "check" && e.v === FROM && e.rc === 0);
      if (failed && !restoredPass) continue;
      if (!inRun.some((e) => e.k === "after")) out.push(`I1: run ${run} started the gated upgrade and ended (not killed) without trying after`);
    }
  }
  // I2: the rollback is tried within the runs (only a waiter lock busy on every run may keep it waiting, notified: I4).
  if (failAt >= 0) {
    const tried = ev.slice(failAt).some((e) => e.k === "uninstall" || (e.k === "notify" && /rollback (impossible|incomplete)/.test(e.text)));
    const lockBlocked = w.files.has(PENDING) && c.faults.some((f) => f.persistent && f.kind === "busy");
    if (!tried && !lockBlocked) out.push(`I2: a persisted FAIL ${w.files.has(PENDING) ? "is still pending" : "ended"} with no rollback attempt`);
    const hold = w.files.get(HOLD);
    if (!hold || !hold.includes(`"version":"${TO}"`)) out.push(`I2: the failed ${TO} is not held`);
  }
  // I3 (a candidate another updater installed is not oupdate's to answer for: a run that crashed
  // before it saw brew change nothing cannot tell it from an upgrade that did not complete)
  // (A formula that started uninstalled and was never installed has nothing in use to answer for.)
  if (w.linked !== FROM && c.upgrade !== "concurrent" && !(c.absent && !w.linked)) {
    const passed = ev.some((e) => e.k === "check" && e.v === TO && e.rc === 0) && pend.some((e) => e.rec.verdict === "pass");
    const held = !!w.files.get(HOLD)?.includes(`"version":"${TO}"`);
    if (!passed && !held && !rcNotice()) out.push(`I3: ${w.linked || "(nothing linked)"} left in use with no PASS, no hold and no notice`);
  }
  // I4
  if (w.files.has(PENDING)) {
    const born = ev.findIndex((e) => e.k === "pending");
    if (!rcNotice(Math.max(born, 0))) out.push(`I4: a pending record outlived ${RUNS} runs with no notice: ${w.files.get(PENDING)!.trim()}`);
  }
  // I6 (beyond I1-I5): a check never runs while the owner job still runs another version.
  for (const e of ev) if (e.k === "check" && e.rc !== 143 && e.owner?.some((v) => v !== e.v)) out.push(`I6: the check on ${e.v} ran while the owner ran ${e.owner.join(" ")}`);
  // Never vacuous: an owner job always has a live process mapping some version, tracked.
  for (const e of ev) if (e.k === "check" && e.owner?.length === 0) out.push(`I6: the check on ${e.v} ran with none of the owner job's processes tracked`);
  // I7
  for (const e of ev) if (e.k === "uninstall" && e.only) out.push(`I7: run ${e.run} uninstalled the only installed keg`);
  // I8
  for (const e of ev) if (e.k === "pulled") out.push(`I8: run ${e.run} upgraded good-a, which pulled splash ${TO} in as a dependency`);
  // I5
  for (let run = 1; run <= RUNS; run++) {
    const inRun = ev.filter((e) => e.run === run && (e.k === "after" || e.k === "check"));
    const firstAfter = inRun.findIndex((e) => e.k === "after" && !e.stop);
    if (firstAfter >= 0 && inRun.slice(firstAfter).some((e) => e.k === "check")) out.push(`I5: run ${run} ran after before a check`);
  }
  return out;
}

const HOOKS: Hooks[] = ["both", "after", "none"];
const OWNERS: Owners[] = ["none", "svc", "svc-leak", "named", "named-leak", "wrapper", "wrapper-leak", "wrapper-leak-restored", "orphan", "orphan-late"];
const OUTCOMES: Outcome[] = ["pass", "error", "fail-pass", "fail-fail", "flaky"];
const describeCase = (c: Case) => `hooks=${c.hooks} owners=${c.owners} outcome=${c.outcome}${c.upgrade ? ` upgrade=${c.upgrade}` : ""}${c.respawn ? ` respawn=${c.respawn}` : ""}${c.startOld ? " startOld" : ""}${c.dependent ? ` dependent=${c.dependent}` : ""}${c.absent ? ` absent=${c.absent}` : ""}${c.retained ? ` retained=${c.retained}` : ""}${c.retryRespawn ? ` retryRespawn=${c.retryRespawn}` : ""}${c.retries !== undefined ? ` retries=${c.retries}` : ""} faults=${c.faults.map((f) => `r${f.run}#${f.op}:${f.kind}${f.persistent ? "*" : ""}`).join(",") || "none"}`;

describe("release checks: the state machine explored (invariants I1-I8)", () => {
  test("a clean run of every configuration holds every invariant", async () => {
    const bad: string[] = [];
    for (const hooks of HOOKS) for (const owners of OWNERS) for (const outcome of OUTCOMES) {
      const c: Case = { hooks, owners, outcome, faults: [] };
      for (const v of violations(c, await explore(c))) bad.push(`${describeCase(c)}: ${v}`);
    }
    expect(bad).toEqual([]);
  });

  test("a crash (SIGKILL before or after the step, or SIGTERM) at every persisted step and external effect of the first run, recovered by later runs", async () => {
    const bad: string[] = [];
    let cases = 0;
    for (const hooks of HOOKS) for (const owners of OWNERS) for (const outcome of ["pass", "error", "fail-pass", "fail-fail"] as Outcome[]) {
      // Count the first run's ops with a crash past the end (never fires).
      for (const op of await persistedSteps({ hooks, owners, outcome })) for (const kind of ["kill-before", "kill-after", "term"] as Kind[]) {
        const c: Case = { hooks, owners, outcome, faults: [{ run: 1, op, kind }] };
        cases++;
        for (const v of violations(c, await explore(c))) bad.push(`${describeCase(c)}: ${v}`);
      }
    }
    if (process.env.INV_DEBUG) console.log(`crash: ${cases} cases`);
    expect(cases).toBeGreaterThan(300);
    expect(bad.slice(0, 40)).toEqual([]);
  }, 120_000);

  test("EACCES on every state-file op of the first run (read, list, write, remove), recovered by later runs", async () => {
    const bad: string[] = [];
    let cases = 0;
    for (const hooks of HOOKS) for (const owners of OWNERS) for (const outcome of ["pass", "error", "fail-pass", "fail-fail"] as Outcome[]) {
      const labels = await cleanLabels({ hooks, owners, outcome });
      for (const [op, l] of labels.entries()) {
        if (!/^(read|list|write|rm|append) /.test(l)) continue;
        const c: Case = { hooks, owners, outcome, faults: [{ run: 1, op, kind: "eacces" }] };
        cases++;
        for (const v of violations(c, await explore(c))) bad.push(`${describeCase(c)} (${l}): ${v}`);
      }
    }
    if (process.env.INV_DEBUG) console.log(`eacces: ${cases} cases`);
    expect(bad.slice(0, 40)).toEqual([]);
  }, 120_000);

  test("seeded external-call failures (nonzero, after its effect, malformed, timeout, EACCES, busy lock), once or on every run", async () => {
    const r = rng(0x5eed);
    const pick = <T,>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)]!;
    const bad: string[] = [];
    const N = 600;
    /** A failure that fits the op: an exec fails, a state file is EACCES, the waiter lock is busy. */
    const faultFor = (labels: string[], run: number, rcOnly = false): Fault | undefined => {
      const op = Math.floor(r() * labels.length);
      const l = labels[op]!;
      if (l === "lock release" || l.startsWith("exec notify-cmd")) return undefined;
      const kind: Kind = l.startsWith("exec ") ? pick(["rc1", "rc1-effect", "malformed", "timeout"] as Kind[]) : l === "lock take" ? "busy" : "eacces";
      if (!rcOnly && r() < 0.25) return { run, op, kind: pick(["kill-before", "kill-after", "term"] as Kind[]) };
      return { run, op, kind, ...(run === 1 && kind !== "eacces" && r() < 0.12 ? { persistent: true } : {}) };
    };
    let runs = 0;
    let tried = 0;
    while (tried < N) {
      const base = { hooks: pick(HOOKS), owners: pick(OWNERS), outcome: pick(OUTCOMES) };
      const labels = await cleanLabels(base);
      const first = faultFor(labels, 1, true);
      if (!first) continue;
      const faults: Fault[] = [first];
      // Sometimes a second failure (or a crash) in the first recovery run.
      const second = r() < 0.4 ? faultFor(labels, 2) : undefined;
      if (second) faults.push(second);
      const c: Case = { ...base, faults };
      tried++;
      const w = await explore(c);
      runs += w.ops.length;
      for (const v of violations(c, w)) bad.push(`${describeCase(c)} (${c.faults.map((f) => w.opLabels[f.run - 1]?.[f.op]).join(", ")}): ${v}`);
    }
    if (process.env.INV_DEBUG) console.log(`seeded: ${tried} cases, ${runs} runs`);
    expect(bad.slice(0, 40)).toEqual([]);
  }, 120_000);

  test("every external call failing the same way on every run (nonzero, malformed, timeout, a busy lock)", async () => {
    const bad: string[] = [];
    let cases = 0;
    for (const owners of OWNERS) for (const outcome of ["pass", "fail-pass"] as Outcome[]) {
      const base = { hooks: "both" as Hooks, owners, outcome };
      const labels = await cleanLabels(base);
      const seen = new Set<string>();
      labels.forEach((l, op) => {
        if (seen.has(l) || l === "lock release" || l.startsWith("exec notify-cmd") || !(l.startsWith("exec ") || l === "lock take")) return;
        seen.add(l);
      });
      for (const l of seen) {
        const op = labels.indexOf(l);
        for (const kind of (l === "lock take" ? ["busy"] : ["rc1", "malformed", "timeout"]) as Kind[]) {
          const c: Case = { ...base, faults: [{ run: 1, op, kind, persistent: true }] };
          cases++;
          for (const v of violations(c, await explore(c))) bad.push(`${describeCase(c)} (${l}): ${v}`);
        }
      }
    }
    if (process.env.INV_DEBUG) console.log(`persistent: ${cases} cases`);
    expect(bad.slice(0, 40)).toEqual([]);
  }, 120_000);

  test("a brew upgrade that exits 0 without changing the version (itself, or another updater first): no check, no rollback, never the only keg uninstalled", async () => {
    const bad: string[] = [];
    let cases = 0;
    for (const upgrade of ["noop", "concurrent"] as const) for (const hooks of HOOKS) for (const owners of OWNERS) for (const outcome of OUTCOMES) {
      const base = { hooks, owners, outcome, upgrade };
      const crashes = outcome === "flaky" ? [] : (await persistedSteps(base)).flatMap((op) => (["kill-before", "kill-after", "term"] as Kind[]).map((kind) => [{ run: 1, op, kind }]));
      for (const faults of [[], ...crashes] as Fault[][]) {
        const c: Case = { ...base, faults };
        cases++;
        const w = await explore(c);
        for (const v of violations(c, w)) bad.push(`${describeCase(c)}: ${v}`);
        if (w.events.some((e) => e.k === "check")) bad.push(`${describeCase(c)}: a check ran though the version never changed`);
      }
    }
    if (process.env.INV_DEBUG) console.log(`no-op upgrade: ${cases} cases`);
    expect(bad.slice(0, 40)).toEqual([]);
  }, 120_000);

  test("the owner job respawning on the previous keg between runs, after a crash at every persisted step of the first run", async () => {
    const bad: string[] = [];
    let cases = 0;
    for (const hooks of ["both", "none"] as Hooks[]) for (const owners of OWNERS.filter((o) => o !== "none" && !o.startsWith("orphan"))) for (const outcome of ["pass", "error", "fail-pass", "fail-fail"] as Outcome[]) {
      for (const op of await persistedSteps({ hooks, owners, outcome })) for (const kind of ["kill-before", "kill-after", "term"] as Kind[]) {
        const c: Case = { hooks, owners, outcome, respawn: FROM, faults: [{ run: 1, op, kind }] };
        cases++;
        for (const v of violations(c, await explore(c))) bad.push(`${describeCase(c)}: ${v}`);
      }
    }
    if (process.env.INV_DEBUG) console.log(`respawn: ${cases} cases`);
    expect(cases).toBeGreaterThan(200);
    expect(bad.slice(0, 40)).toEqual([]);
  }, 120_000);

  test("another formula whose new release depends on the gated one (runtime, or build only): never upgraded while the gated one is outdated, after a crash at every persisted step or its dependency query failing on every run", async () => {
    const bad: string[] = [];
    let cases = 0;
    let upgradedLater = 0;
    for (const dependent of ["runtime", "build-only"] as const) for (const hooks of ["both", "none"] as Hooks[]) for (const owners of ["none", "svc", "wrapper"] as Owners[]) for (const outcome of ["pass", "fail-pass", "fail-fail"] as Outcome[]) {
      const base = { hooks, owners, outcome, dependent };
      const labels = await cleanLabels(base);
      const depsOp = labels.indexOf("exec brew deps --include-build --include-optional good-a");
      if (depsOp < 0) bad.push(`${describeCase({ ...base, faults: [] })}: good-a's declared dependencies never queried`);
      const crashes = (await persistedSteps(base)).flatMap((op) => (["kill-before", "kill-after", "term"] as Kind[]).map((kind): Fault[] => [{ run: 1, op, kind }]));
      const queryFails = depsOp < 0 ? [] : (["rc1", "malformed", "timeout"] as Kind[]).map((kind): Fault[] => [{ run: 1, op: depsOp, kind, persistent: true }]);
      for (const faults of [[], ...crashes, ...queryFails]) {
        const c: Case = { ...base, faults };
        cases++;
        const w = await explore(c);
        for (const v of violations(c, w)) bad.push(`${describeCase(c)}: ${v}`);
        // Not vacuous: once the gated formula passes, the dependent goes ahead.
        if (!faults.length && outcome === "pass") {
          if (w.depDone) upgradedLater++;
          else bad.push(`${describeCase(c)}: good-a never upgraded after splash passed`);
        }
      }
    }
    if (process.env.INV_DEBUG) console.log(`dependent: ${cases} cases`);
    expect(cases).toBeGreaterThan(200);
    expect(upgradedLater).toBe(2 * 2 * 3);
    expect(bad.slice(0, 40)).toEqual([]);
  }, 120_000);

  test("the gated formula not installed, its release held or not: a dependent's upgrade never installs it, after a crash at every persisted step or its installed list or dependency query failing on every run", async () => {
    const bad: string[] = [];
    let cases = 0;
    for (const absent of ["held", "unheld"] as const) for (const dependent of ["runtime", "build-only"] as const) for (const hooks of ["both", "none"] as Hooks[]) {
      const base = { hooks, owners: "none" as Owners, outcome: "pass" as Outcome, dependent, absent };
      const labels = await cleanLabels(base);
      const queries = ["exec brew list --formula --full-name", "exec brew deps --include-build --include-optional good-a"].map((l) => labels.indexOf(l));
      if (queries.some((op) => op < 0)) bad.push(`${describeCase({ ...base, faults: [] })}: the installed list or good-a's dependencies never queried`);
      const crashes = labels.flatMap((l, op) => (/^(write|rm|append) |^exec brew upgrade /.test(l) ? (["kill-before", "kill-after", "term"] as Kind[]).map((kind): Fault[] => [{ run: 1, op, kind }]) : []));
      const queryFails = queries.filter((op) => op >= 0).flatMap((op) => (["rc1", "malformed", "timeout"] as Kind[]).map((kind): Fault[] => [{ run: 1, op, kind, persistent: true }]));
      for (const faults of [[], ...crashes, ...queryFails]) {
        const c: Case = { ...base, faults };
        cases++;
        const w = await explore(c);
        for (const v of violations(c, w)) bad.push(`${describeCase(c)}: ${v}`);
        if (w.events.some((e) => e.k === "check" || e.k === "upgrade")) bad.push(`${describeCase(c)}: splash was checked or upgraded though it is not installed`);
      }
    }
    if (process.env.INV_DEBUG) console.log(`absent: ${cases} cases`);
    expect(cases).toBeGreaterThan(20);
    expect(bad.slice(0, 40)).toEqual([]);
  }, 120_000);

  test("an older keg retained too, the owner job coming up on it once after the upgrade or after the rollback: no check while it runs there, after a crash at every persisted step of the first run", async () => {
    const bad: string[] = [];
    let cases = 0;
    let cameUpOld = 0;
    const owners = OWNERS.filter((o) => o !== "none" && !o.startsWith("orphan"));
    for (const retained of ["new", "restored"] as const) for (const hooks of ["both", "none"] as Hooks[]) for (const o of owners) for (const outcome of (retained === "new" ? ["pass", "error", "fail-pass", "fail-fail"] : ["fail-pass", "fail-fail"]) as Outcome[]) {
      const base = { hooks, owners: o, outcome, retained };
      const crashes = hooks === "both" ? (await persistedSteps(base)).flatMap((op) => (["kill-before", "kill-after", "term"] as Kind[]).map((kind): Fault[] => [{ run: 1, op, kind }])) : [];
      for (const faults of [[], ...crashes]) {
        const c: Case = { ...base, faults };
        cases++;
        const w = await explore(c);
        if (!faults.length && w.oldStarted) cameUpOld++;
        for (const v of violations(c, w)) bad.push(`${describeCase(c)}: ${v}`);
      }
    }
    if (process.env.INV_DEBUG) console.log(`retained: ${cases} cases, ${cameUpOld} clean ones came up on ${OLD}`);
    // Not vacuous: every clean case's owner came up on the older keg (restored: but a leaking owner's,
    // whose child outlives every restart on the previous keg, so its check and rollback never come).
    expect(cameUpOld).toBe(owners.length * 2 * 4 + owners.filter((o) => !o.endsWith("-leak")).length * 2 * 2);
    expect(cases).toBeGreaterThan(300);
    expect(bad.slice(0, 40)).toEqual([]);
  }, 240_000);

  test("the owner job respawning on an older retained keg between runs (before the restored check too), after a crash at every persisted step of the first run", async () => {
    const bad: string[] = [];
    let cases = 0;
    /** Cases whose check (on the candidate or the restored version) ran in a run after the respawn. */
    let checkedAfterRespawn = 0;
    let restoredAfterRespawn = 0;
    for (const hooks of ["both", "none"] as Hooks[]) for (const owners of OWNERS.filter((o) => o !== "none" && !o.startsWith("orphan"))) for (const outcome of ["pass", "error", "fail-pass", "fail-fail"] as Outcome[]) {
      for (const op of await persistedSteps({ hooks, owners, outcome, respawn: OLD })) for (const kind of ["kill-before", "kill-after", "term"] as Kind[]) {
        const c: Case = { hooks, owners, outcome, respawn: OLD, faults: [{ run: 1, op, kind }] };
        cases++;
        const w = await explore(c);
        if (w.events.some((e) => e.k === "check" && e.run >= 2 && e.rc !== 143)) checkedAfterRespawn++;
        if (w.events.some((e) => e.k === "check" && e.run >= 2 && e.v === FROM && e.rc !== 143)) restoredAfterRespawn++;
        for (const v of violations(c, w)) bad.push(`${describeCase(c)}: ${v}`);
      }
    }
    if (process.env.INV_DEBUG) console.log(`respawn older: ${cases} cases, ${checkedAfterRespawn} checked after it, ${restoredAfterRespawn} restored`);
    expect(cases).toBeGreaterThan(200);
    // Not vacuous: checks, the restored one too, ran in a run the owner respawned before.
    expect(checkedAfterRespawn).toBeGreaterThan(50);
    expect(restoredAfterRespawn).toBeGreaterThan(10);
    expect(bad.slice(0, 40)).toEqual([]);
  }, 240_000);

  test("the owner job already running an older retained keg before the first run (neither the previous keg nor a deleted one): no check while it runs there, clean and after a crash at every persisted step", async () => {
    const bad: string[] = [];
    let cases = 0;
    let checked = 0;
    for (const hooks of ["both", "none"] as Hooks[]) for (const owners of OWNERS.filter((o) => o !== "none" && !o.startsWith("orphan"))) for (const outcome of OUTCOMES) {
      const base = { hooks, owners, outcome, startOld: true };
      const crashes = hooks === "both" && outcome !== "flaky" ? (await persistedSteps(base)).flatMap((op) => (["kill-before", "kill-after", "term"] as Kind[]).map((kind): Fault[] => [{ run: 1, op, kind }])) : [];
      for (const faults of [[], ...crashes]) {
        const c: Case = { ...base, faults };
        cases++;
        const w = await explore(c);
        if (!faults.length && w.events.some((e) => e.k === "check" && e.rc !== 143)) checked++;
        for (const v of violations(c, w)) bad.push(`${describeCase(c)}: ${v}`);
      }
    }
    if (process.env.INV_DEBUG) console.log(`start old: ${cases} cases, ${checked} clean ones checked`);
    expect(cases).toBeGreaterThan(200);
    // Not vacuous: a clean case's check runs once its owner is off the older keg (a leaking owner's
    // child outlives every restart there, so its check never comes).
    expect(checked).toBeGreaterThan(0);
    expect(bad.slice(0, 40)).toEqual([]);
  }, 240_000);

  test("the owner job respawning between a check's attempts (on the previous keg before the candidate's retry, on an older retained keg before the restored retry too), retries 1 or 2, clean and after a crash at every persisted step", async () => {
    const bad: string[] = [];
    let cases = 0;
    /** Clean cases whose owner respawned after a failing attempt on the candidate, and on the restored version. */
    let respawnedNew = 0;
    let respawnedRestored = 0;
    /** Clean cases that still reached a verdict on the candidate after it (a later run's check). */
    let decided = 0;
    for (const retryRespawn of [FROM, OLD]) for (const retries of [1, 2]) for (const hooks of ["both", "none"] as Hooks[]) for (const owners of OWNERS.filter((o) => o !== "none" && !o.startsWith("orphan"))) for (const outcome of ["fail-pass", "fail-fail", "flaky"] as Outcome[]) {
      const base = { hooks, owners, outcome, retryRespawn, retries };
      const crashes = hooks === "both" && retries === 1 && outcome !== "flaky" ? (await persistedSteps(base)).flatMap((op) => (["kill-before", "kill-after", "term"] as Kind[]).map((kind): Fault[] => [{ run: 1, op, kind }])) : [];
      for (const faults of [[], ...crashes]) {
        const c: Case = { ...base, faults };
        cases++;
        const w = await explore(c);
        if (!faults.length) {
          const checks = w.events.filter((e): e is Extract<Ev, { k: "check" }> => e.k === "check");
          if (checks.some((e) => e.v === TO && e.rc === 1)) respawnedNew++;
          if (checks.some((e) => e.v === FROM && e.rc === 1)) respawnedRestored++;
          if (w.events.some((e) => e.k === "pending" && e.rec.verdict && e.run >= 2)) decided++;
        }
        for (const v of violations(c, w)) bad.push(`${describeCase(c)}: ${v}`);
      }
    }
    if (process.env.INV_DEBUG) console.log(`retry respawn: ${cases} cases, ${respawnedNew} new, ${respawnedRestored} restored, ${decided} decided later`);
    expect(cases).toBeGreaterThan(200);
    // Not vacuous: a failing attempt (so a respawn before the next) on the candidate and on the restored version.
    expect(respawnedNew).toBeGreaterThan(50);
    expect(respawnedRestored).toBeGreaterThan(5);
    expect(decided).toBeGreaterThan(10);
    expect(bad.slice(0, 40)).toEqual([]);
  }, 240_000);
});

const clean = new Map<string, string[]>();
/** The ops of a clean first run of this configuration. */
async function cleanLabels(base: Omit<Case, "faults">): Promise<string[]> {
  const key = `${base.hooks}/${base.owners}/${base.outcome}/${base.upgrade ?? ""}/${base.respawn ?? ""}/${base.dependent ?? ""}/${base.absent ?? ""}/${base.retained ?? ""}/${base.startOld ?? ""}/${base.retryRespawn ?? ""}/${base.retries ?? ""}`;
  if (!clean.has(key)) clean.set(key, (await explore({ ...base, faults: [] })).opLabels[0]!);
  return clean.get(key)!;
}

/** The first run's state writes and external effects (hooks, upgrade, rollback, owner restart, check): the crash points. */
async function persistedSteps(base: Omit<Case, "faults">): Promise<number[]> {
  const labels = await cleanLabels(base);
  const effect = /^(write|rm|append) |^exec (ohost |brew upgrade |brew uninstall |brew link |brew trust --formula incoai|(sudo -n )?launchctl kickstart |\/opt\/gate\.test\/check)/;
  return labels.flatMap((l, i) => (effect.test(l) ? [i] : []));
}
