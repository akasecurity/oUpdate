// Release checks in the apply run (config releaseChecks, release-checks.ts) against the scripted host:
// before → upgrade (previous keg kept) → owner restart → check → after, the rollback and hold, a held
// release on the next run, and the dry run.
import { describe, expect, test } from "bun:test";
import type { ReleaseCheck } from "../../src/apply/config.ts";
import type { Exec } from "../../src/apply/exec.ts";
import type { ApplyFs } from "../../src/apply/fs.ts";
import { isStopping, killLive, resetStopping, runStopTasks } from "../../src/apply/exec.ts";
import { applyHost } from "../../src/apply/run.ts";
import { fakeHost, fakeTypeB, testConfig, type HostScript } from "./host-fixture.ts";
import { scripted } from "./helpers.ts";

const CHECK: ReleaseCheck = { formula: "example/tap/gadget", command: ["/opt/gate.test/check"], retries: 1, timeoutSec: 900, before: ["svcctl", "off", "--now"], after: ["svcctl", "on"] };
const PENDING = "/state.test/release-checks/pending/gadget.json";
const HOLD = "/state.test/release-checks/holds/gadget.json";
const LSOF_HEAD = "COMMAND PID USER FD TYPE DEVICE SIZE NODE NAME\n";

interface Rc {
  /** Check exits per GATE_VERSION, in order (default 0). */
  check?: Record<string, number[]>;
  /** The version brew would install (default 1.3.0). */
  candidate?: string;
  /** Kegs on disk (default 1.2.0 and the candidate once upgraded). */
  noPrevKeg?: boolean;
  cfg?: Parameters<typeof testConfig>[0];
  script?: HostScript;
  files?: Record<string, string>;
  dryRun?: boolean;
  /** Extra answers, by exact command line. */
  answer?: (line: string, argv: string[]) => { rc: number; out: string; err: string } | undefined;
  /** Keg-only: brew info says linked_keg null; the opt link is the version. */
  kegOnly?: boolean;
  /** The opt link cannot be read (and brew info names no linked keg). */
  optUnreadable?: boolean;
  /** The version installed at the start (default 1.2.0). */
  startLinked?: string;
  /** A signal arrives when this command line runs: oupdate is stopping from then on (as realExec, nothing starts unless forced). */
  stopAt?: string;
  /** A signal arrives while the check runs on this version (the check is killed: rc 143). */
  stopAtCheck?: string;
  /** The waiter's lock: take answers in order (then true); every take and release is recorded in calls. */
  lock?: boolean[];
  /** The owner waiter command (absent: none, as in a test run). */
  cfgArgv?: string[];
  /** Changes the scripted file system before the run. */
  onFs?: (fs: ApplyFs) => void;
  /** The waiter lock's release throws (after recording it). */
  lockReleaseThrows?: boolean;
  /** brew upgrade installs the new keg even when it exits nonzero (a postinstall failure). */
  installsOnFail?: boolean;
  /** Pids a kickstart of their job does not end (an orphaned child): still in the scripted lsof after it. */
  outlives?: string[];
  /** The faked Type B review's rc (default 0: approved; 1 holds it). */
  typeBRc?: 0 | 1;
}

async function rcRun(o: Rc = {}) {
  let clockT = 0;
  const candidate = o.candidate ?? "1.3.0";
  const dirs = ["/brew/Cellar", ...(o.noPrevKeg ? [] : ["/brew/Cellar/gadget/1.2.0"]), ...(o.startLinked ? [`/brew/Cellar/gadget/${o.startLinked}`] : [])];
  const h = fakeHost({
    formulas: "gadget",
    verbose: `example/tap/gadget (1.2.0) < ${candidate}`,
    formulaTaps: { gadget: "example/tap" },
    lsof: [LSOF_HEAD],
    dirs,
    files: o.files,
    ...o.script,
  });
  let linked = o.startLinked ?? "1.2.0";
  const kegs = new Set([...(o.noPrevKeg ? [] : ["1.2.0"]), linked]);
  if (o.noPrevKeg) kegs.delete("1.2.0");
  const queue = Object.fromEntries(Object.entries(o.check ?? {}).map(([k, v]) => [k, [...v]]));
  const envs: { line: string; env?: Record<string, string> }[] = [];
  /** A kickstart -k ends the job's process (the pid its launchctl print last named) and its children: gone from the scripted lsof. */
  const jobPid = new Map<string, string>();
  const gone = new Set<string>();
  const exec: Exec = async (argv, opt = {}) => {
    const line = argv.join(" ");
    const kick = /launchctl kickstart -k (\S+)$/.exec(line);
    const r = await inner(argv, opt);
    const printed = /^launchctl print (\S+\/\S+)$/.exec(line);
    const pid = printed && r.rc === 0 ? /\bpid = (\d+)/.exec(r.out)?.[1] : undefined;
    if (printed && pid) jobPid.set(printed[1]!, pid);
    const was = kick ? jobPid.get(kick[1]!) : undefined;
    // Its children end with it too, unless they outlive it.
    const ended = was ? [was, ...Object.entries(o.script?.ps ?? {}).filter(([, v]) => v.ppid === was).map(([k]) => k)] : [];
    if (kick && r.rc === 0) for (const p of ended) if (!o.outlives?.includes(p)) gone.add(p);
    return r;
  };
  const inner: Exec = async (argv, opt = {}) => {
    const line = argv.join(" ");
    envs.push({ line, env: opt.env });
    if (isStopping() && !opt.force) {
      h.calls.push(`STOPPED ${line}`);
      return { rc: 143, out: "", err: "oupdate is stopping: not started" };
    }
    if (o.stopAt === line) {
      h.calls.push(line);
      await killLive(0);
      return { rc: 143, out: "", err: "" };
    }
    const extra = o.answer?.(line, argv);
    if (extra) {
      h.calls.push(line);
      return extra;
    }
    const ok = (out = "") => {
      h.calls.push(line);
      return { rc: 0, out, err: "" };
    };
    if (line === "brew info --json=v2 gadget" || line === "brew info --json=v2 example/tap/gadget") {
      return ok(JSON.stringify({ formulae: [{ name: "gadget", full_name: "example/tap/gadget", tap: "example/tap", keg_only: !!o.kegOnly, linked_keg: o.kegOnly || o.optUnreadable ? null : linked || null, installed: [...kegs].sort().map((version) => ({ version })), versions: { stable: candidate }, revision: 0 }] }));
    }
    if (line === "/usr/bin/readlink /brew/opt/gadget") return o.optUnreadable || !linked ? { rc: 1, out: "", err: "" } : ok(`../Cellar/gadget/${linked}\n`);
    if (line === "brew link --force example/tap/gadget") {
      linked = [...kegs].sort().at(-1) ?? "";
      return ok();
    }
    if (line === "brew unlink example/tap/gadget") return ok();
    if (line === "brew --cellar gadget") return ok("/brew/Cellar/gadget\n");
    // Dependencies: none unless a test answers otherwise.
    if (line.startsWith("brew deps ")) return ok("");
    if (line === "brew list --formula --full-name") return ok("good-a\nexample/tap/gadget\n");
    if (line === "brew list --cask") return ok("");
    if (line === "brew trust --formula --json=v1") return ok("[]");
    if (line === "brew uninstall example/tap/gadget") {
      kegs.delete(linked);
      linked = "";
      return ok();
    }
    if (line === "brew link example/tap/gadget") {
      // A keg-only formula is not linked without --force (brew warns and exits 0).
      if (!o.kegOnly) linked = [...kegs].sort().at(-1) ?? "";
      return ok();
    }
    if (line === "/opt/gate.test/check") {
      const v = opt.env?.GATE_VERSION ?? "?";
      h.calls.push(`${line} GATE_VERSION=${v}`);
      if (o.stopAtCheck === v) {
        await killLive(0);
        return { rc: 143, out: "", err: "" };
      }
      const rc = queue[v]?.shift() ?? 0;
      return { rc, out: `score ${v} 0.${rc}\n`, err: "" };
    }
    const r = await h.exec(argv, opt);
    if (argv[0]!.endsWith("lsof") && gone.size) return { ...r, out: r.out.split("\n").filter((l) => !gone.has(l.split(/\s+/)[1] ?? "")).join("\n") };
    if (argv[0] === "brew" && argv[1] === "upgrade" && (r.rc === 0 || o.installsOnFail) && argv.at(-1)!.endsWith("gadget")) {
      linked = candidate;
      kegs.add(candidate);
      dirs.push(`/brew/Cellar/gadget/${candidate}`);
    }
    return r;
  };
  // The release-check state dir lists its files, as on disk; every other dir lists nothing, as in the fixture.
  const listDir = h.fs.listDir;
  h.fs.listDir = async (d) => (d.startsWith("/state.test/release-checks") ? [...h.files.keys()].filter((k) => k.startsWith(`${d}/`)).map((k) => k.slice(d.length + 1)) : listDir(d));
  const isDir = h.fs.isDir;
  h.fs.isDir = async (p) => dirs.includes(p) || isDir(p);
  o.onFs?.(h.fs);
  const locks = [...(o.lock ?? [])];
  resetStopping();
  const res = await applyHost(testConfig({ npm: null, typeBTaps: ["example/tap"], releaseChecks: [CHECK], notify: ["send-notice"], ...o.cfg }), exec, h.fs, {
    dryRun: o.dryRun ?? false, reviewer: scripted([], "APPROVE").r, typeB: fakeTypeB(o.typeBRc ?? 0).typeB, now: new Date(2026, 9, 26, 4, 0),
    ownerClock: { now: () => clockT, sleep: async (ms) => void (clockT += ms), httpStatus: async () => 200 },
    ...(o.cfgArgv ? { ownerWaiterArgv: o.cfgArgv } : {}),
    ownerLock: {
      take: async (path) => {
        const got = locks.length ? locks.shift()! : true;
        h.calls.push(`lock ${path} ${got ? "taken" : "busy"}`);
        return got;
      },
      release: async (path) => {
        h.calls.push(`unlock ${path}`);
        if (o.lockReleaseThrows) throw new Error("EIO: lock release failed");
      },
    },
  });
  const brew = res.summary.find((l) => l.startsWith("  brew: ")) ?? "";
  // The release-check commands in order (before, upgrade, check, rollback, after).
  const flow = h.calls.filter((c) => c.startsWith("svcctl") || c.startsWith("brew upgrade") || c.startsWith("/opt/gate.test/check") || c.startsWith("brew uninstall") || c.startsWith("brew link ") || c.includes("kickstart"));
  return { ...h, res, brew, flow, envs, linked: () => linked, notices: () => h.calls.filter((c) => c.startsWith("send-notice")) };
}

describe("release checks in the run", () => {
  test("PASS: before, the upgrade without install cleanup, the check with GATE_VERSION, then after; cleanup skips the formula", async () => {
    const r = await rcRun();
    expect(r.flow).toEqual(["svcctl off --now", "brew upgrade example/tap/gadget", "/opt/gate.test/check GATE_VERSION=1.3.0", "svcctl on"]);
    expect(r.envs.find((e) => e.line === "brew upgrade example/tap/gadget")?.env).toMatchObject({ HOMEBREW_NO_INSTALL_CLEANUP: "1" });
    expect(r.calls).toContain("brew cleanup good-a");
    expect(r.calls).not.toContain("brew cleanup");
    expect(r.res.log).toContain("  gadget: release check pending — cleanup skips gadget (its previous keg is the rollback)");
    expect(r.brew).toContain("release check: gadget 1.3.0 PASS");
    expect(r.files.has(PENDING)).toBe(false);
    expect(r.writes).toContain(PENDING);
    expect(r.res.rc).toBe(0);
  });
  test("FAIL then PASS on the retry: a PASS, no rollback", async () => {
    const r = await rcRun({ check: { "1.3.0": [1, 0] } });
    expect(r.flow).toEqual(["svcctl off --now", "brew upgrade example/tap/gadget", "/opt/gate.test/check GATE_VERSION=1.3.0", "/opt/gate.test/check GATE_VERSION=1.3.0", "svcctl on"]);
    expect(r.brew).toContain("release check: gadget 1.3.0 PASS");
  });
  test("confirmed fail: rollback to the previous keg, hold, the restored version checked and passing, then after; FAILED and notified", async () => {
    const r = await rcRun({ check: { "1.3.0": [1, 1] } });
    expect(r.flow).toEqual([
      "svcctl off --now", "brew upgrade example/tap/gadget", "/opt/gate.test/check GATE_VERSION=1.3.0", "/opt/gate.test/check GATE_VERSION=1.3.0",
      "brew uninstall example/tap/gadget", "brew link example/tap/gadget", "/opt/gate.test/check GATE_VERSION=1.2.0", "svcctl on",
    ]);
    expect(r.linked()).toBe("1.2.0");
    expect(JSON.parse(r.files.get(HOLD)!)).toMatchObject({ formula: "gadget", version: "1.3.0", from: "1.2.0" });
    expect(r.brew).toContain("FAILED: release-check:gadget");
    expect(r.brew).toContain("release check: gadget 1.3.0 FAIL, rolled back to 1.2.0 (held, 1.2.0 PASS)");
    expect(r.notices().some((n) => n.includes("release check FAILED: gadget 1.3.0 — rolled back to 1.2.0") && n.includes("score 1.3.0 0.1"))).toBe(true);
    expect(r.res.rc).toBe(1);
  });
  test("the restored version fails too: after is not run, loud notice", async () => {
    const r = await rcRun({ check: { "1.3.0": [1, 1], "1.2.0": [1, 1] } });
    expect(r.flow.includes("svcctl on")).toBe(false);
    expect(r.res.log).toContain("  release check gadget: after not run — the host stays as before left it");
    expect(r.notices().some((n) => n.includes("🚨") && n.includes("FAILED too"))).toBe(true);
    expect(r.files.has(HOLD)).toBe(true);
  });
  test("previous keg missing at rollback: no rollback, the new version stays (held), after not run", async () => {
    const r = await rcRun({ check: { "1.3.0": [1, 1] }, noPrevKeg: true });
    expect(r.flow).toEqual(["svcctl off --now", "brew upgrade example/tap/gadget", "/opt/gate.test/check GATE_VERSION=1.3.0", "/opt/gate.test/check GATE_VERSION=1.3.0"]);
    expect(r.linked()).toBe("1.3.0");
    expect(JSON.parse(r.files.get(HOLD)!)).toMatchObject({ version: "1.3.0" });
    expect(r.notices().some((n) => n.includes("rollback impossible") && n.includes("previous keg /brew/Cellar/gadget/1.2.0 is missing"))).toBe(true);
    expect(r.brew).toContain("FAILED: release-check:gadget");
  });
  test("exit 2 (could not run): no rollback, the new version stays, notified, after runs, no FAILED entry", async () => {
    const r = await rcRun({ check: { "1.3.0": [2] } });
    expect(r.flow).toEqual(["svcctl off --now", "brew upgrade example/tap/gadget", "/opt/gate.test/check GATE_VERSION=1.3.0", "svcctl on"]);
    expect(r.notices().some((n) => n.includes("release check gadget 1.3.0: could not run (rc 2)"))).toBe(true);
    expect(r.brew).toContain("gadget 1.3.0 check could not run (rc 2), kept");
    expect(r.brew).not.toContain("FAILED");
    expect(r.files.has(HOLD)).toBe(false);
  });
  test("an upgrade that fails after before ran: no check, after still runs", async () => {
    const r = await rcRun({ script: { upgradeRc: { "example/tap/gadget": 1 } } });
    expect(r.flow).toEqual(["svcctl off --now", "brew upgrade example/tap/gadget", "svcctl on"]);
    expect(r.brew).toContain("gadget not upgraded, no check");
    expect(r.files.has(PENDING)).toBe(false);
  });
  test("an upgrade that hits the per-package time box stays FAILED with its after step owed", async () => {
    const r = await rcRun({ script: { timeout: ["brew upgrade example/tap/gadget"] } });
    expect(r.flow).toEqual(["svcctl off --now", "brew upgrade example/tap/gadget", "svcctl on"]);
    expect(r.brew).toContain("FAILED: gadget");
    expect(r.res.log.some((l) => l.includes("TIMEOUT after 500 ms: brew upgrade example/tap/gadget"))).toBe(true);
    expect(r.files.has(PENDING)).toBe(false);
  });
  test("a brew upgrade that exits 0 without changing the version: no check, no rollback, notified, after runs, the record removed", async () => {
    const r = await rcRun({ check: { "1.2.0": [1, 1] }, answer: (l) => (l === "brew upgrade example/tap/gadget" ? { rc: 0, out: "", err: "" } : undefined) });
    expect(r.flow).toEqual(["svcctl off --now", "brew upgrade example/tap/gadget", "svcctl on"]);
    expect(r.linked()).toBe("1.2.0");
    expect(r.res.log).toContain("  release check gadget: brew upgrade exited 0 but gadget is still 1.2.0 — no upgrade, no check");
    expect(r.brew).toContain("gadget upgrade changed nothing (still 1.2.0), no check");
    expect(r.notices().some((n) => n.includes("brew upgrade exited 0 but the version in use is still 1.2.0"))).toBe(true);
    expect(r.files.has(PENDING)).toBe(false);
    expect(r.files.has(HOLD)).toBe(false);
  });
  test("another updater installed the candidate (its only keg) before the gated upgrade read the version: no check, the only keg kept", async () => {
    const r = await rcRun({ startLinked: "1.3.0", noPrevKeg: true, check: { "1.3.0": [1, 1] } });
    expect(r.flow).toEqual(["svcctl off --now", "brew upgrade example/tap/gadget", "svcctl on"]);
    expect(r.calls.some((c) => c.startsWith("brew uninstall"))).toBe(false);
    expect(r.linked()).toBe("1.3.0");
    expect(r.files.has(HOLD)).toBe(false);
  });
  test("a record an earlier run wrote with to === from (no version change) is no upgrade: no check, after runs", async () => {
    const left = JSON.stringify({ formula: "gadget", full: "example/tap/gadget", rack: "/brew/Cellar/gadget", from: "1.2.0", to: "1.2.0", upgraded: true, upgradeStarted: true, beforeRan: true, at: "2026-10-25 04:00" });
    const r = await rcRun({ check: { "1.2.0": [1, 1] }, script: { formulas: "", verbose: "" }, files: { [PENDING]: left } });
    expect(r.flow).toEqual(["svcctl on"]);
    expect(r.files.has(PENDING)).toBe(false);
  });
  test("before failing: not upgraded, after still runs", async () => {
    const r = await rcRun({ answer: (l) => (l === "svcctl off --now" ? { rc: 3, out: "", err: "" } : undefined) });
    expect(r.flow).toEqual(["svcctl off --now", "svcctl on"]);
    expect(r.brew).toContain("FAILED: gadget");
  });
  test("runAs: before, the check and after run through sudo -n -u <user> -H", async () => {
    const SUDO = "/usr/bin/sudo -n -u gate -H --preserve-env=GATE_VERSION --";
    const r = await rcRun({ cfg: { releaseChecks: [{ ...CHECK, command: ["/opt/gate.test/run"], runAs: "gate" }] } });
    expect(r.calls).toContain(`${SUDO} svcctl off --now`);
    expect(r.calls).toContain(`${SUDO} /opt/gate.test/run`);
    expect(r.calls).toContain(`${SUDO} svcctl on`);
    expect(r.envs.find((e) => e.line === `${SUDO} /opt/gate.test/run`)?.env).toEqual({ GATE_VERSION: "1.3.0" });
  });
  test("next run: the held version is not upgraded to (logged HELD by release check), neither before nor after runs", async () => {
    const r = await rcRun({ files: { [HOLD]: JSON.stringify({ formula: "gadget", version: "1.3.0", from: "1.2.0", at: "2026-10-25 04:00" }) } });
    expect(r.flow).toEqual([]);
    expect(r.res.log.some((l) => l.includes("holding gadget 1.3.0 (HELD by release check"))).toBe(true);
    expect(r.brew).toContain("HELD by release check: gadget 1.3.0");
  });
  test("a newer version than the held one is tried normally", async () => {
    const r = await rcRun({ candidate: "1.4.0", files: { [HOLD]: JSON.stringify({ formula: "gadget", version: "1.3.0", from: "1.2.0", at: "2026-10-25 04:00" }) } });
    expect(r.flow).toEqual(["svcctl off --now", "brew upgrade example/tap/gadget", "/opt/gate.test/check GATE_VERSION=1.4.0", "svcctl on"]);
    expect(r.brew).toContain("release check: gadget 1.4.0 PASS");
    expect(r.files.has(HOLD)).toBe(false);
  });
  test("not outdated: neither before nor after", async () => {
    const r = await rcRun({ script: { formulas: "", verbose: "" } });
    expect(r.flow).toEqual([]);
  });
  test("dry run: says what it would run, runs none of it and writes nothing", async () => {
    const r = await rcRun({ dryRun: true });
    expect(r.flow).toEqual([]);
    expect(r.writes).toEqual([]);
    expect(r.res.log).toContain("  dry-run: release check gadget: would run before [svcctl off --now], the upgrade to 1.3.0 keeping the previous keg 1.2.0, the owner restart, the check [/opt/gate.test/check] with GATE_VERSION=1.3.0, then after [svcctl on]");
  });
  test("a staleOwners job on the previous keg is restarted inline before the check, never queued for the waiter", async () => {
    const gui = "gui/501 = {\n\tservices = {\n\t\t      77      - \torg.example.gadget\n\t}\n}\n";
    let prints = 0;
    const r = await rcRun({
      cfg: { staleOwners: [{ match: "org.example.gadget", probe: ["/opt/svc.test/idle"] }] },
      script: { lsof: [`${LSOF_HEAD}gadget 77 u txt REG 1,4 1 2 /brew/Cellar/gadget/1.2.0/bin/gadget\n`], ps: { "77": { comm: "gadget", command: "gadget serve", ppid: "1" } } },
      answer: (line, argv) => {
        if (line === "launchctl print gui/501") return { rc: 0, out: gui, err: "" };
        if (line === "launchctl print gui/501/org.example.gadget") {
          prints++;
          return { rc: 0, out: `\tstate = running\n\tpid = ${prints <= 2 ? 77 : 88}\n\tpath = /home.test/Library/LaunchAgents/org.example.gadget.plist\n`, err: "" };
        }
        if (argv[0]!.endsWith("lsof") && argv.includes("-p")) return { rc: 0, out: `${LSOF_HEAD}gadget ${argv[argv.indexOf("-p") + 1]} u txt REG 1,4 1 2 /brew/Cellar/gadget/1.3.0/bin/gadget\n`, err: "" };
        return undefined;
      },
    });
    expect(r.spawned).toEqual([]);
    expect([...r.files.keys()].some((k) => k.includes("/queue/"))).toBe(false);
    expect(r.flow).toEqual(["svcctl off --now", "brew upgrade example/tap/gadget", "launchctl kickstart -k gui/501/org.example.gadget", "/opt/gate.test/check GATE_VERSION=1.3.0", "svcctl on"]);
    expect(r.res.log).toContain("  release check owner: restarted org.example.gadget");
  });
});

describe("release checks: review fixes (OUP review of feat/release-checks)", () => {
  const SVC = { staleOwners: [{ match: "org.example.gadget", probe: ["/opt/svc.test/idle"] }] };
  const gui = "gui/501 = {\n\tservices = {\n\t\t      77      - \torg.example.gadget\n\t}\n}\n";
  /** An owner on the previous keg (pid 77), restarted onto pid 88; `print` overrides launchctl print of the job. */
  const owner = (print?: (n: number) => string | undefined) => {
    let prints = 0;
    return {
      script: { lsof: [`${LSOF_HEAD}gadget 77 u txt REG 1,4 1 2 /brew/Cellar/gadget/1.2.0/bin/gadget\n`], ps: { "77": { comm: "gadget", command: "gadget serve", ppid: "1" } } },
      answer: (line: string, argv: string[]) => {
        if (line === "launchctl print gui/501") return { rc: 0, out: gui, err: "" };
        if (line === "launchctl print gui/501/org.example.gadget") {
          prints++;
          const custom = print?.(prints);
          if (custom === "") return { rc: 113, out: "", err: "not found" };
          return { rc: 0, out: custom ?? `\tstate = running\n\tpid = ${prints <= 2 ? 77 : 88}\n\tpath = /home.test/Library/LaunchAgents/org.example.gadget.plist\n`, err: "" };
        }
        if (argv[0]!.endsWith("lsof") && argv.includes("-p")) return { rc: 0, out: `${LSOF_HEAD}gadget ${argv[argv.indexOf("-p") + 1]} u txt REG 1,4 1 2 /brew/Cellar/gadget/1.3.0/bin/gadget\n`, err: "" };
        return undefined;
      },
    };
  };

  test("1: a signal after before: after still runs (forced past the stop) from the stop tasks, and only then is the record changed", async () => {
    const r = await rcRun({ stopAt: "brew upgrade example/tap/gadget" });
    expect(r.flow.filter((c) => c.startsWith("svcctl"))).toEqual(["svcctl off --now"]);
    expect(r.files.has(PENDING)).toBe(true);
    await runStopTasks(() => {});
    expect(r.calls.filter((c) => c.startsWith("svcctl"))).toEqual(["svcctl off --now", "svcctl on"]);
    expect(r.envs.find((e) => e.line === "svcctl on")).toBeDefined();
    // after ran, the check never did: the record stays for the next run's check, with no after owed.
    expect(JSON.parse(r.files.get(PENDING)!)).toMatchObject({ beforeRan: true, afterRan: true });
    expect(JSON.parse(r.files.get(PENDING)!).ended).toBeUndefined();
    resetStopping();
  });
  test("1: an after that does not run (it fails) keeps the record, so the next run owes it", async () => {
    const r = await rcRun({ answer: (l) => (l === "svcctl on" ? { rc: 1, out: "", err: "" } : undefined) });
    expect(JSON.parse(r.files.get(PENDING)!)).toMatchObject({ ended: true, beforeRan: true, verdict: "pass" });
    expect(JSON.parse(r.files.get(PENDING)!).afterRan).toBeUndefined();
    const next = await rcRun({ startLinked: "1.3.0", script: { formulas: "", verbose: "" }, files: { [PENDING]: r.files.get(PENDING)! } });
    expect(next.flow).toEqual(["svcctl on"]);
    expect(next.files.has(PENDING)).toBe(false);
  });

  test("2: a planned upgrade that depends on an outdated gated formula waits; the gated one upgrades as its own checked step", async () => {
    const r = await rcRun({
      script: { formulas: "good-a gadget", verbose: "good-a (1.0) < 1.1\nexample/tap/gadget (1.2.0) < 1.3.0", formulaTaps: { "good-a": "homebrew/core", gadget: "example/tap" } },
      answer: (l) => (l === "brew deps --include-build --include-optional good-a" ? { rc: 0, out: "zlib\ngadget\n", err: "" } : undefined),
    });
    expect(r.calls).not.toContain("brew upgrade good-a");
    expect(r.flow).toEqual(["svcctl off --now", "brew upgrade example/tap/gadget", "/opt/gate.test/check GATE_VERSION=1.3.0", "svcctl on"]);
    expect(r.res.log).toContain("  good-a: not upgraded this run — it depends on gadget, which a release check gates; retried next run");
  });
  test("2: a dependent of a held gated formula is not upgraded either (it would pull the held release in)", async () => {
    const r = await rcRun({
      script: { formulas: "good-a gadget", verbose: "good-a (1.0) < 1.1\nexample/tap/gadget (1.2.0) < 1.3.0", formulaTaps: { "good-a": "homebrew/core", gadget: "example/tap" } },
      files: { [HOLD]: JSON.stringify({ formula: "gadget", version: "1.3.0", from: "1.2.0", at: "2026-10-25 04:00" }) },
      answer: (l) => (l === "brew deps --include-build --include-optional good-a" ? { rc: 0, out: "gadget\n", err: "" } : undefined),
    });
    expect(r.calls.some((c) => c.startsWith("brew upgrade"))).toBe(false);
    expect(r.res.log).toContain("  good-a: not upgraded this run — it depends on gadget, which a release check gates; retried next run");
  });
  test("2: unreadable dependencies of a planned upgrade: held (fail closed) while a gated formula is outdated", async () => {
    const r = await rcRun({
      script: { formulas: "good-a gadget", verbose: "good-a (1.0) < 1.1\nexample/tap/gadget (1.2.0) < 1.3.0", formulaTaps: { "good-a": "homebrew/core", gadget: "example/tap" } },
      answer: (l) => (l === "brew deps --include-build --include-optional good-a" ? { rc: 1, out: "", err: "" } : undefined),
    });
    expect(r.calls).not.toContain("brew upgrade good-a");
    expect(r.res.log).toContain("  good-a: not upgraded this run — its dependencies could not be read while gadget is gated by a release check");
  });
  // brew as it answers: a plain `brew deps` of an installed formula lists its installed keg's runtime
  // dependencies; any include flag lists the candidate's declared ones (build ones with --include-build).
  const declaredDeps = (adds: "runtime" | "build-only") => (l: string) => {
    if (!l.startsWith("brew deps ") || !l.endsWith(" good-a")) return undefined;
    const flags = l.split(" ").slice(2, -1);
    const declared = flags.some((f) => f.startsWith("--include-"));
    return { rc: 0, out: declared && (adds === "runtime" || flags.includes("--include-build")) ? "zlib\ngadget\n" : "zlib\n", err: "" };
  };
  for (const adds of ["runtime", "build-only"] as const) {
    test(`2: another formula's new release adds a held gated formula as a ${adds} dependency (its installed release does not): it waits, read from the candidate's declared dependencies`, async () => {
      const r = await rcRun({
        script: { formulas: "good-a gadget", verbose: "good-a (1.0) < 1.1\nexample/tap/gadget (1.2.0) < 1.3.0", formulaTaps: { "good-a": "homebrew/core", gadget: "example/tap" } },
        files: { [HOLD]: JSON.stringify({ formula: "gadget", version: "1.3.0", from: "1.2.0", at: "2026-10-25 04:00" }) },
        answer: declaredDeps(adds),
      });
      expect(r.calls.filter((c) => c.startsWith("brew deps"))).toEqual(["brew deps --include-build --include-optional good-a"]);
      expect(r.calls.some((c) => c.startsWith("brew upgrade"))).toBe(false);
      expect(r.res.log).toContain("  good-a: not upgraded this run — it depends on gadget, which a release check gates; retried next run");
    });
  }
  test("2: dependencies listed in a form that is not package names: held (fail closed)", async () => {
    const r = await rcRun({
      script: { formulas: "good-a gadget", verbose: "good-a (1.0) < 1.1\nexample/tap/gadget (1.2.0) < 1.3.0", formulaTaps: { "good-a": "homebrew/core", gadget: "example/tap" } },
      answer: (l) => (l === "brew deps --include-build --include-optional good-a" ? { rc: 0, out: "{garbage\x00", err: "" } : undefined),
    });
    expect(r.calls).not.toContain("brew upgrade good-a");
    expect(r.res.log).toContain("  good-a: not upgraded this run — its dependencies could not be read while gadget is gated by a release check");
  });
  test("2: no gated formula outdated: dependencies are not queried", async () => {
    const r = await rcRun({ script: { formulas: "good-a", verbose: "good-a (1.0) < 1.1", formulaTaps: { "good-a": "homebrew/core" } } });
    expect(r.calls).toContain("brew upgrade good-a");
    expect(r.calls.some((c) => c.startsWith("brew deps"))).toBe(false);
  });
  for (const held of [true, false]) {
    test(`2: a gated formula not installed${held ? " (its release held)" : ""} gates a dependent too: brew would install it fresh, unchecked`, async () => {
      const r = await rcRun({
        script: { formulas: "good-a", verbose: "good-a (1.0) < 1.1", formulaTaps: { "good-a": "homebrew/core" } },
        ...(held ? { files: { [HOLD]: JSON.stringify({ formula: "gadget", version: "1.3.0", from: "1.2.0", at: "2026-10-25 04:00" }) } } : {}),
        answer: (l) => (l === "brew list --formula --full-name" ? { rc: 0, out: "good-a\n", err: "" } : l === "brew deps --include-build --include-optional good-a" ? { rc: 0, out: "zlib\ngadget\n", err: "" } : undefined),
      });
      expect(r.calls.some((c) => c.startsWith("brew upgrade"))).toBe(false);
      expect(r.res.log).toContain("  good-a: not upgraded this run — it depends on gadget, which a release check gates; retried next run");
    });
  }
  test("2: the installed list cannot be read: every gated formula gates its dependents (fail closed)", async () => {
    const r = await rcRun({
      script: { formulas: "good-a", verbose: "good-a (1.0) < 1.1", formulaTaps: { "good-a": "homebrew/core" } },
      answer: (l) => (l === "brew list --formula --full-name" ? { rc: 1, out: "", err: "" } : l === "brew deps --include-build --include-optional good-a" ? { rc: 0, out: "gadget\n", err: "" } : undefined),
    });
    expect(r.calls).not.toContain("brew upgrade good-a");
  });
  test("2: a gated formula not installed does not hold an upgrade that does not depend on it", async () => {
    const r = await rcRun({
      script: { formulas: "good-a", verbose: "good-a (1.0) < 1.1", formulaTaps: { "good-a": "homebrew/core" } },
      answer: (l) => (l === "brew list --formula --full-name" ? { rc: 0, out: "good-a\n", err: "" } : undefined),
    });
    expect(r.calls).toContain("brew deps --include-build --include-optional good-a");
    expect(r.calls).toContain("brew upgrade good-a");
  });

  test("3: a record a killed run left without its installed version: inferred before the stale-keg scan, so the owner restarts before the check", async () => {
    const o = owner();
    const left = JSON.stringify({ formula: "gadget", full: "example/tap/gadget", rack: "/brew/Cellar/gadget", from: "1.2.0", beforeRan: true, at: "2026-10-25 04:00" });
    const r = await rcRun({ ...o, cfg: SVC, startLinked: "1.3.0", script: { ...o.script, formulas: "", verbose: "" }, files: { [PENDING]: left } });
    expect(r.flow).toEqual(["launchctl kickstart -k gui/501/org.example.gadget", "/opt/gate.test/check GATE_VERSION=1.3.0", "svcctl on"]);
  });

  test("an earlier run's owner restart, its check not run: the owner respawned on the previous keg since is restarted again before the check", async () => {
    const o = owner();
    const left = JSON.stringify({ formula: "gadget", full: "example/tap/gadget", rack: "/brew/Cellar/gadget", from: "1.2.0", to: "1.3.0", upgraded: true, upgradeStarted: true, ownerRestarted: true, beforeRan: true, at: "2026-10-25 04:00" });
    const r = await rcRun({ ...o, cfg: SVC, startLinked: "1.3.0", script: { ...o.script, formulas: "", verbose: "" }, files: { [PENDING]: left } });
    expect(r.flow).toEqual(["launchctl kickstart -k gui/501/org.example.gadget", "/opt/gate.test/check GATE_VERSION=1.3.0", "svcctl on"]);
    expect(r.res.log).toContain("  release check gadget: pid 77 maps /brew/Cellar/gadget/1.2.0 before the check — its owners are restarted first");
    expect(r.res.log).toContain("  release check gadget: no process maps a gadget keg other than /brew/Cellar/gadget/1.3.0 after its owners restarted");
  });
  test("an earlier run's owner restart, its check not run, the previous keg still free: the check runs without another restart", async () => {
    const o = owner();
    const left = JSON.stringify({ formula: "gadget", full: "example/tap/gadget", rack: "/brew/Cellar/gadget", from: "1.2.0", to: "1.3.0", upgraded: true, upgradeStarted: true, ownerRestarted: true, beforeRan: true, at: "2026-10-25 04:00" });
    const r = await rcRun({ ...o, cfg: SVC, startLinked: "1.3.0", script: { ...o.script, lsof: [LSOF_HEAD], formulas: "", verbose: "" }, files: { [PENDING]: left } });
    expect(r.flow).toEqual(["/opt/gate.test/check GATE_VERSION=1.3.0", "svcctl on"]);
  });
  test("an earlier run's owner restart, its check not run, the processes unreadable now: no check this run (the wait counted), after runs", async () => {
    const o = owner();
    const left = JSON.stringify({ formula: "gadget", full: "example/tap/gadget", rack: "/brew/Cellar/gadget", from: "1.2.0", to: "1.3.0", upgraded: true, upgradeStarted: true, ownerRestarted: true, beforeRan: true, at: "2026-10-25 04:00" });
    const r = await rcRun({ ...o, cfg: SVC, startLinked: "1.3.0", script: { ...o.script, formulas: "", verbose: "" }, files: { [PENDING]: left },
      answer: (line, argv) => (argv[0]!.endsWith("lsof") && !argv.includes("-p") ? { rc: 1, out: "", err: "" } : o.answer(line, argv)) });
    expect(r.flow.some((c) => c.startsWith("/opt/gate.test/check"))).toBe(false);
    expect(r.res.log).toContain("  release check gadget: the gadget processes could not be read before the check");
    expect(JSON.parse(r.files.get(PENDING)!)).toMatchObject({ unresolvedWaits: 1 });
    expect(r.flow.at(-1)).toBe("svcctl on");
  });

  test("4: a failed owner restart is appended to the failed file (never rewritten), so a live waiter's entry is not lost", async () => {
    const o = owner((n) => (n <= 2 ? undefined : "\tstate = exited\n"));
    const appends: string[] = [];
    const r = await rcRun({ ...o, cfg: { ...SVC }, script: o.script, files: { "/state.test/owner-restarts/failed": "org.example.other\n" }, onFs: (fs) => {
      fs.appendFile = async (p, text) => void appends.push(`${p}:${text}`);
    } });
    expect(appends).toEqual(["/state.test/owner-restarts/failed:org.example.gadget\n"]);
    expect(r.writes).not.toContain("/state.test/owner-restarts/failed");
    expect(r.flow.some((c) => c.startsWith("/opt/gate.test/check"))).toBe(false);
  });

  test("5: keg-only: from and to come from the opt link; the check runs", async () => {
    const r = await rcRun({ kegOnly: true });
    expect(r.flow).toEqual(["svcctl off --now", "brew upgrade example/tap/gadget", "/opt/gate.test/check GATE_VERSION=1.3.0", "svcctl on"]);
  });
  test("5: keg-only rollback: link --force then unlink, so the opt link is the previous keg and nothing is linked into the prefix", async () => {
    const r = await rcRun({ kegOnly: true, check: { "1.3.0": [1, 1] } });
    expect(r.calls).toContain("brew link --force example/tap/gadget");
    expect(r.calls).toContain("brew unlink example/tap/gadget");
    expect(r.linked()).toBe("1.2.0");
    expect(r.flow.at(-1)).toBe("svcctl on");
  });
  test("5: the installed version cannot be read after the upgrade: no verdict, notified and logged, after runs", async () => {
    const r = await rcRun({ optUnreadable: true });
    expect(r.flow).toEqual(["svcctl off --now", "brew upgrade example/tap/gadget", "svcctl on"]);
    expect(r.notices().some((n) => n.includes("release check gadget: not run — the installed version could not be read"))).toBe(true);
    expect(r.brew).toContain("FAILED: release-check:gadget");
  });
  test("review 8 (I1): with after and no before, the installed version unreadable after the upgrade (no verdict) runs after", async () => {
    const { before: _, ...afterOnly } = CHECK;
    const r = await rcRun({ optUnreadable: true, cfg: { releaseChecks: [afterOnly] } });
    expect(r.flow).toEqual(["brew upgrade example/tap/gadget", "svcctl on"]);
  });

  test("6: an owner gone before its restart is a restart failure: no check, notified, after runs (no verdict)", async () => {
    const o = owner(() => "");
    const r = await rcRun({ ...o, cfg: SVC, script: o.script });
    expect(r.flow).toEqual(["svcctl off --now", "brew upgrade example/tap/gadget", "svcctl on"]);
    expect(r.notices().some((n) => n.includes("not run, the owner restart failed"))).toBe(true);
    expect(r.brew).toContain("FAILED: release-check:gadget");
  });
  test("6: an owner gone during the rollback restart: the restored version is not checked and after is not run", async () => {
    const o = owner((n) => (n >= 5 ? "" : undefined));
    const r = await rcRun({ ...o, cfg: SVC, script: o.script, check: { "1.3.0": [1, 1] } });
    expect(r.flow.filter((c) => c.startsWith("/opt/gate.test/check"))).toEqual(["/opt/gate.test/check GATE_VERSION=1.3.0", "/opt/gate.test/check GATE_VERSION=1.3.0"]);
    expect(r.flow.includes("svcctl on")).toBe(false);
    expect(r.notices().some((n) => n.includes("owner restart failed"))).toBe(true);
  });
});

describe("release checks: review round 2 (b8c02f7)", () => {
  const SVC = { staleOwners: [{ match: "org.example.gadget", probe: ["/opt/svc.test/idle"] }] };
  const RERANK: ReleaseCheck = { formula: "example/tap/rerank", command: ["/opt/gate.test/rerank"], retries: 0, timeoutSec: 60 };
  const LOCK = "/state.test/owner-restarts/lock";
  const gui = "gui/501 = {\n\tservices = {\n\t\t      77      - \torg.example.gadget\n\t}\n}\n";
  const owner = (print?: (n: number) => string | undefined) => {
    let prints = 0;
    return {
      script: { lsof: [`${LSOF_HEAD}gadget 77 u txt REG 1,4 1 2 /brew/Cellar/gadget/1.2.0/bin/gadget\n`], ps: { "77": { comm: "gadget", command: "gadget serve", ppid: "1" } } },
      answer: (line: string, argv: string[]) => {
        if (line === "launchctl print gui/501") return { rc: 0, out: gui, err: "" };
        if (line === "launchctl print gui/501/org.example.gadget") {
          prints++;
          const custom = print?.(prints);
          if (custom === "") return { rc: 113, out: "", err: "not found" };
          return { rc: 0, out: custom ?? `\tstate = running\n\tpid = ${prints <= 2 ? 77 : 88}\n\tpath = /home.test/Library/LaunchAgents/org.example.gadget.plist\n`, err: "" };
        }
        if (argv[0]!.endsWith("lsof") && argv.includes("-p")) return { rc: 0, out: `${LSOF_HEAD}gadget ${argv[argv.indexOf("-p") + 1]} u txt REG 1,4 1 2 /brew/Cellar/gadget/1.3.0/bin/gadget\n`, err: "" };
        return undefined;
      },
    };
  };
  const rerankInfo = (candidate: string) => ({ rc: 0, out: JSON.stringify({ formulae: [{ name: "rerank", full_name: "example/tap/rerank", tap: "example/tap", linked_keg: "1.0", installed: [{ version: "1.0" }], versions: { stable: candidate }, revision: 0 }] }), err: "" });

  test("1: a gated formula that depends on another outdated, held gated formula is skipped this run", async () => {
    const r = await rcRun({
      cfg: { releaseChecks: [CHECK, RERANK] },
      script: { formulas: "gadget rerank", verbose: "example/tap/gadget (1.2.0) < 1.3.0\nexample/tap/rerank (1.0) < 2.0", formulaTaps: { gadget: "example/tap", rerank: "example/tap" } },
      files: { "/state.test/release-checks/holds/rerank.json": JSON.stringify({ formula: "rerank", version: "2.0", from: "1.0", at: "2026-10-25 04:00" }) },
      answer: (l) => (l === "brew info --json=v2 rerank" || l === "brew info --json=v2 example/tap/rerank" ? rerankInfo("2.0") : l === "brew deps --include-build --include-optional example/tap/gadget" ? { rc: 0, out: "rerank\n", err: "" } : l === "brew deps --include-build --include-optional example/tap/rerank" ? { rc: 0, out: "", err: "" } : undefined),
    });
    expect(r.calls.some((c) => c.startsWith("brew upgrade") || c.startsWith("svcctl"))).toBe(false);
    expect(r.res.log).toContain("  gadget: not upgraded this run — it depends on rerank, which a release check gates; retried next run");
  });
  test("1: a cask whose formula dependencies include an outdated gated formula is not upgraded", async () => {
    const r = await rcRun({
      script: { formulas: "gadget", casks: "tfapp", caskTaps: { tfapp: "homebrew/cask" } },
      answer: (l) => (l === "brew deps --include-build --include-optional --cask tfapp" ? { rc: 0, out: "gadget\n", err: "" } : l === "brew deps --include-build --include-optional example/tap/gadget" ? { rc: 0, out: "", err: "" } : undefined),
    });
    expect(r.calls.some((c) => c.startsWith("brew upgrade --cask"))).toBe(false);
    expect(r.res.log).toContain("  tfapp: not upgraded this run — it depends on gadget, which a release check gates; retried next run");
    expect(r.flow).toEqual(["svcctl off --now", "brew upgrade example/tap/gadget", "/opt/gate.test/check GATE_VERSION=1.3.0", "svcctl on"]);
  });

  test("2: a signal during the restored-version check keeps the confirmed fail: no after, and recovery checks the restored version", async () => {
    const r = await rcRun({ check: { "1.3.0": [1, 1] }, stopAtCheck: "1.2.0" });
    await runStopTasks(() => {});
    expect(r.calls.filter((c) => c.startsWith("svcctl"))).toEqual(["svcctl off --now"]);
    const rec = JSON.parse(r.files.get(PENDING)!);
    expect(rec).toMatchObject({ verdict: "fail", rolledBack: true, after: "skip" });
    expect(rec.restoredVerdict).toBeUndefined();
    resetStopping();
    const next = await rcRun({ startLinked: "1.2.0", candidate: "1.2.0", script: { formulas: "", verbose: "" }, files: { [PENDING]: r.files.get(PENDING)!, [HOLD]: r.files.get(HOLD)! }, check: { "1.2.0": [2] } });
    expect(next.flow).toEqual(["/opt/gate.test/check GATE_VERSION=1.2.0"]);
    expect(next.notices().some((n) => n.includes("restored 1.2.0 could not be checked"))).toBe(true);
    expect(next.files.has(PENDING)).toBe(false);
  });

  test("3: an owner whose restart failed in an earlier run is still restarted inline before the check", async () => {
    const o = owner();
    const r = await rcRun({ ...o, cfg: SVC, script: o.script, files: { "/state.test/owner-restarts/failed": "org.example.gadget\n" } });
    expect(r.flow).toEqual(["svcctl off --now", "brew upgrade example/tap/gadget", "launchctl kickstart -k gui/501/org.example.gadget", "/opt/gate.test/check GATE_VERSION=1.3.0", "svcctl on"]);
  });
  test("3: no owner process found, but the formula's service matches staleOwners: its restart is required (gone: a restart failure, no check)", async () => {
    const r = await rcRun({
      cfg: { staleOwners: [{ match: "sh.brew.gadget" }] },
      onFs: (fs) => {
        const exists = fs.exists;
        fs.exists = async (p) => p === "/home.test/Library/LaunchAgents/sh.brew.gadget.plist" || exists(p);
      },
      answer: (l) => (l === "launchctl print gui/501/sh.brew.gadget" ? { rc: 113, out: "", err: "not found" } : undefined),
    });
    expect(r.flow).toEqual(["svcctl off --now", "brew upgrade example/tap/gadget", "svcctl on"]);
    expect(r.notices().some((n) => n.includes("not run, the owner restart failed"))).toBe(true);
  });

  test("4: an unfinished record is finished first: no new upgrade of that formula while it is pending", async () => {
    const left = JSON.stringify({ formula: "gadget", full: "example/tap/gadget", rack: "/brew/Cellar/gadget", from: "1.2.0", to: "1.3.0", upgraded: true, beforeRan: false, afterRan: true, at: "2026-10-25 04:00" });
    // A run that waited for the owner: its after already ran, so the verdict owes none.
    const r = await rcRun({ startLinked: "1.3.0", candidate: "1.4.0", script: { verbose: "example/tap/gadget (1.3.0) < 1.4.0" }, files: { [PENDING]: left } });
    expect(r.calls.some((c) => c.startsWith("brew upgrade"))).toBe(false);
    expect(r.flow).toEqual(["/opt/gate.test/check GATE_VERSION=1.3.0"]);
    expect(r.res.log).toContain("  holding gadget (its release check of 1.2.0 → 1.3.0 is not finished — finished first)");
  });

  test("5: the inline restart, check and re-check hold the waiter's lock (waited for, bounded); the label's queued waiter job is removed", async () => {
    const o = owner();
    const Q = "/state.test/owner-restarts/queue/gui%2F501%2Forg.example.gadget.json";
    const r = await rcRun({ ...o, cfg: SVC, script: o.script, lock: [false, false, true], files: { [Q]: JSON.stringify({ label: "org.example.gadget", target: "gui/501/org.example.gadget", pid: "77", keg: "/brew/Cellar/gadget/1.2.0" }) } });
    const seq = r.calls.filter((c) => c.startsWith("lock") || c.startsWith("unlock") || c.includes("kickstart") || c.startsWith("/opt/gate.test/check"));
    expect(seq).toEqual([`lock ${LOCK} busy`, `lock ${LOCK} busy`, `lock ${LOCK} taken`, "launchctl kickstart -k gui/501/org.example.gadget", "/opt/gate.test/check GATE_VERSION=1.3.0", `unlock ${LOCK}`]);
    expect(r.files.has(Q)).toBe(false);
  });
  test("5: the waiter's lock not free within the bound: the check waits (record kept), after runs", async () => {
    const o = owner();
    const r = await rcRun({ ...o, cfg: SVC, script: o.script, lock: Array(1000).fill(false) });
    expect(r.flow).toEqual(["svcctl off --now", "brew upgrade example/tap/gadget", "svcctl on"]);
    expect(r.brew).toContain("gadget 1.3.0 check waits for its owner (the owner restart waiter holds its lock)");
    expect(r.files.has(PENDING)).toBe(true);
  });
  test("5: with a release check pending, other owners' waiter starts only after the release checks", async () => {
    const o = owner();
    const r = await rcRun({ ...o, cfg: { staleOwners: [{ match: "org.example.*", probe: ["/opt/svc.test/idle"] }] }, script: { ...o.script, lsof: [`${LSOF_HEAD}gadget 77 u txt REG 1,4 1 2 /brew/Cellar/gadget/1.2.0/bin/gadget\nother 66 u txt REG 1,4 1 2 /brew/Cellar/other/0.9/bin/other\n`], ps: { ...o.script.ps, "66": { comm: "other", command: "other", ppid: "1" } } },
      answer: (l, a) => (l === "launchctl print gui/501" ? { rc: 0, out: "gui/501 = {\n\tservices = {\n\t\t      77      - \torg.example.gadget\n\t\t      66      - \torg.example.other\n\t}\n}\n", err: "" } : o.answer(l, a)),
      cfgArgv: ["/brew/bin/bun", "/app.test/src/cli.ts", "host", "--stale-owners-waiter"] });
    const i = r.calls.findIndex((c) => c.startsWith("spawn "));
    const j = r.calls.findIndex((c) => c.startsWith("/opt/gate.test/check"));
    expect(j).toBeGreaterThanOrEqual(0);
    expect(i).toBeGreaterThan(j);
    expect(r.files.has("/state.test/owner-restarts/queue/gui%2F501%2Forg.example.other.json")).toBe(true);
  });
});

describe("release checks: owners (custom launchd labels)", () => {
  const LABEL = "com.max.gadget-server";
  const PLIST = `/Library/LaunchDaemons/${LABEL}.plist`;
  const OWNED = { releaseChecks: [{ ...CHECK, owners: [LABEL] }] };
  const daemon = (o: { gone?: boolean; shell?: boolean } = {}) => {
    let prints = 0;
    return {
      onFs: (fs: ApplyFs) => {
        const exists = fs.exists;
        fs.exists = async (p: string) => p === PLIST || exists(p);
      },
      answer: (line: string, argv: string[]) => {
        if (line === `launchctl print system/${LABEL}`) {
          if (o.gone) return { rc: 113, out: "", err: "not found" };
          prints++;
          return { rc: 0, out: `\tstate = running\n\tpid = ${prints <= 3 ? 77 : 88}\n\tpath = ${PLIST}\n`, err: "" };
        }
        if (argv[0]!.endsWith("lsof") && argv.includes("-iTCP")) return { rc: 1, out: "", err: "" };
        if (argv[0]!.endsWith("lsof") && argv.includes("-p")) {
          const pid = argv[argv.indexOf("-p") + 1];
          // A shell or supervisor: its own process maps no keg (its child runs the release).
          if (o.shell) return { rc: 0, out: LSOF_HEAD, err: "" };
          return { rc: 0, out: `${LSOF_HEAD}gadget ${pid} u txt REG 1,4 1 2 /brew/Cellar/gadget/${pid === "77" ? "1.2.0" : "1.3.0"}/bin/gadget\n`, err: "" };
        }
        return undefined;
      },
    };
  };
  test("a named owner is restarted (system domain, sudo -n) before the check, though the stale-keg scan found nothing", async () => {
    const r = await rcRun({ cfg: OWNED, ...daemon() });
    expect(r.flow).toEqual(["svcctl off --now", "brew upgrade example/tap/gadget", `sudo -n launchctl kickstart -k system/${LABEL}`, "/opt/gate.test/check GATE_VERSION=1.3.0", "svcctl on"]);
  });
  test("a named owner not running or not found is held before the upgrade (OUP-78): no before, no upgrade, notified", async () => {
    const r = await rcRun({ cfg: OWNED, ...daemon({ gone: true }) });
    expect(r.flow).toEqual([]);
    expect(r.notices().some((n) => n.includes("held, not upgraded"))).toBe(true);
    expect(r.brew).toContain("FAILED: release-check:gadget");
  });
  test("review 8 (I1): with after and no before, a named owner that is not running is held too (OUP-78)", async () => {
    const { before: _, ...afterOnly } = OWNED.releaseChecks[0]!;
    const r = await rcRun({ cfg: { ...OWNED, releaseChecks: [afterOnly] }, ...daemon({ gone: true }) });
    expect(r.flow).toEqual([]);
  });
});

describe("release checks: review round 3 (3b26f7e)", () => {
  const LABEL = "com.max.gadget-server";
  const PLIST = `/Library/LaunchDaemons/${LABEL}.plist`;
  test("1: a named owner whose own process maps no keg (a shell or supervisor) is still restarted and health-checked", async () => {
    let prints = 0;
    const r = await rcRun({
      cfg: { releaseChecks: [{ ...CHECK, owners: [LABEL] }] },
      onFs: (fs) => {
        const exists = fs.exists;
        fs.exists = async (p: string) => p === PLIST || exists(p);
      },
      answer: (line, argv) => {
        if (line === `launchctl print system/${LABEL}`) {
          prints++;
          return { rc: 0, out: `\tstate = running\n\tpid = ${prints <= 3 ? 77 : 88}\n\tpath = ${PLIST}\n`, err: "" };
        }
        if (argv[0]!.endsWith("lsof") && argv.includes("-iTCP")) return { rc: 1, out: "", err: "" };
        if (argv[0]!.endsWith("lsof") && argv.includes("-p")) return { rc: 0, out: LSOF_HEAD, err: "" };
        return undefined;
      },
    });
    expect(r.flow).toEqual(["svcctl off --now", "brew upgrade example/tap/gadget", `sudo -n launchctl kickstart -k system/${LABEL}`, "/opt/gate.test/check GATE_VERSION=1.3.0", "svcctl on"]);
    expect(r.res.log).toContain(`  release check owner: restarted ${LABEL}`);
  });
  test("3: a tap-qualified formula's own service is restarted after the rollback by its short-name label", async () => {
    const AGENT = "/home.test/Library/LaunchAgents/sh.brew.gadget.plist";
    const r = await rcRun({
      check: { "1.3.0": [1, 1], "1.2.0": [0] },
      onFs: (fs) => {
        const exists = fs.exists;
        fs.exists = async (p: string) => p === AGENT || exists(p);
      },
      answer: (line) => (line === "launchctl kickstart -k gui/501/sh.brew.gadget" ? { rc: 0, out: "", err: "" } : undefined),
    });
    const kicks = r.calls.filter((c) => c === "launchctl kickstart -k gui/501/sh.brew.gadget");
    expect(kicks.length).toBe(2);
    const rolled = r.calls.indexOf("brew link example/tap/gadget");
    expect(r.calls.lastIndexOf("launchctl kickstart -k gui/501/sh.brew.gadget")).toBeGreaterThan(rolled);
    expect(r.calls.lastIndexOf("launchctl kickstart -k gui/501/sh.brew.gadget")).toBeLessThan(r.calls.indexOf("/opt/gate.test/check GATE_VERSION=1.2.0"));
  });
  test("4: an after owed by a check with no before: recovery runs it (the record says PASS, after not yet run)", async () => {
    const NOBEFORE: ReleaseCheck = { ...CHECK, before: undefined };
    const rec = { formula: "gadget", full: "example/tap/gadget", rack: "/brew/Cellar/gadget", from: "1.2.0", to: "1.3.0", beforeRan: false, upgraded: true, ownerRestarted: true, verdict: "pass", after: "run", ended: true, at: "2026-10-26 03:00" };
    const r = await rcRun({ cfg: { releaseChecks: [NOBEFORE] }, startLinked: "1.3.0", script: { formulas: "", verbose: "" }, files: { [PENDING]: `${JSON.stringify(rec)}\n` } });
    expect(r.flow).toEqual(["svcctl on"]);
    expect(r.files.has(PENDING)).toBe(false);
  });
  test("4: with no before, an after that fails is owed by the next run", async () => {
    const NOBEFORE: ReleaseCheck = { ...CHECK, before: undefined };
    const r = await rcRun({ cfg: { releaseChecks: [NOBEFORE] }, answer: (l) => (l === "svcctl on" ? { rc: 1, out: "", err: "" } : undefined) });
    expect(r.flow.filter((c) => c.startsWith("svcctl"))).toEqual(["svcctl on"]);
    expect(r.files.has(PENDING)).toBe(true);
    const next = await rcRun({ cfg: { releaseChecks: [NOBEFORE] }, startLinked: "1.3.0", script: { formulas: "", verbose: "" }, files: { [PENDING]: r.files.get(PENDING)! } });
    expect(next.flow).toEqual(["svcctl on"]);
    expect(next.files.has(PENDING)).toBe(false);
  });
});

describe("release checks: review round 4 (85dd0da)", () => {
  const SVC = { staleOwners: [{ match: "org.example.gadget", probe: ["/opt/svc.test/idle"] }] };
  /** A custom staleOwners job: `pids` answers launchctl print of it in order (the last repeats); `keg` maps a pid to its keg version. */
  const svc = (pids: string[], keg: (pid: string) => string, listed: string) => {
    let prints = 0;
    return (line: string, argv: string[]) => {
      if (line === "launchctl print gui/501") return { rc: 0, out: `gui/501 = {\n\tservices = {\n\t\t      ${listed}      - \torg.example.gadget\n\t}\n}\n`, err: "" };
      if (line === "launchctl print gui/501/org.example.gadget") {
        const pid = pids[Math.min(prints++, pids.length - 1)]!;
        return { rc: 0, out: `\tstate = running\n\tpid = ${pid}\n\tpath = /home.test/Library/LaunchAgents/org.example.gadget.plist\n`, err: "" };
      }
      if (argv[0]!.endsWith("lsof") && argv.includes("-p")) {
        const pid = argv[argv.indexOf("-p") + 1]!;
        return { rc: 0, out: `${LSOF_HEAD}gadget ${pid} u txt REG 1,4 1 2 /brew/Cellar/gadget/${keg(pid)}/bin/gadget\n`, err: "" };
      }
      return undefined;
    };
  };

  test("1: an owner the stale-keg scan found is on the record, so a rollback resumed by a later run restarts it", async () => {
    const r = await rcRun({
      cfg: SVC, check: { "1.3.0": [1, 1] }, stopAt: "brew uninstall example/tap/gadget",
      script: { lsof: [`${LSOF_HEAD}gadget 77 u txt REG 1,4 1 2 /brew/Cellar/gadget/1.2.0/bin/gadget\n`], ps: { "77": { comm: "gadget", command: "gadget serve", ppid: "1" } } },
      answer: svc(["77", "77", "88"], (p) => (p === "77" ? "1.2.0" : "1.3.0"), "77"),
    });
    await runStopTasks(() => {});
    resetStopping();
    const rec = JSON.parse(r.files.get(PENDING)!);
    expect(rec).toMatchObject({ verdict: "fail", ownerRestarted: true });
    expect(rec.rolledBack).toBeUndefined();
    expect(rec.owners?.map((q: { target: string }) => q.target)).toEqual(["gui/501/org.example.gadget"]);
    // The owner now runs the failed 1.3.0, which the scan does not retire: only the record names it.
    const next = await rcRun({
      cfg: SVC, startLinked: "1.3.0", check: { "1.2.0": [0] }, files: { [PENDING]: r.files.get(PENDING)! },
      // The scan before the restart sees 88 on the failed 1.3.0; the re-scan after the restored restart, only 99 on 1.2.0.
      script: { formulas: "", verbose: "", lsof: [`${LSOF_HEAD}gadget 88 u txt REG 1,4 1 2 /brew/Cellar/gadget/1.3.0/bin/gadget\n`, `${LSOF_HEAD}gadget 99 u txt REG 1,4 1 2 /brew/Cellar/gadget/1.2.0/bin/gadget\n`], ps: { "88": { comm: "gadget", command: "gadget serve", ppid: "1" } } },
      answer: svc(["88", "88", "99"], (p) => (p === "99" ? "1.2.0" : "1.3.0"), "88"),
    });
    const kick = next.calls.indexOf("launchctl kickstart -k gui/501/org.example.gadget");
    expect(kick).toBeGreaterThan(next.calls.indexOf("brew link example/tap/gadget"));
    expect(kick).toBeLessThan(next.calls.indexOf("/opt/gate.test/check GATE_VERSION=1.2.0"));
  });

  test("1b: a process still mapping the rejected keg after the restored restart (an orphaned child): the restored check does not run, no after, the wait counted", async () => {
    const r = await rcRun({
      cfg: SVC, check: { "1.3.0": [1, 1] }, stopAt: "brew uninstall example/tap/gadget",
      script: { lsof: [`${LSOF_HEAD}gadget 77 u txt REG 1,4 1 2 /brew/Cellar/gadget/1.2.0/bin/gadget\n`], ps: { "77": { comm: "gadget", command: "gadget serve", ppid: "1" } } },
      answer: svc(["77", "77", "88"], (p) => (p === "77" ? "1.2.0" : "1.3.0"), "77"),
    });
    await runStopTasks(() => {});
    resetStopping();
    // The new pid 99 runs 1.2.0, but 88 survived the restart on the uninstalled 1.3.0 (its files deleted, still mapped).
    const next = await rcRun({
      cfg: SVC, startLinked: "1.3.0", check: { "1.2.0": [0] }, files: { [PENDING]: r.files.get(PENDING)! },
      script: { formulas: "", verbose: "", lsof: [`${LSOF_HEAD}gadget 88 u txt REG 1,4 1 2 /brew/Cellar/gadget/1.3.0/bin/gadget\n`], ps: { "88": { comm: "gadget", command: "gadget serve", ppid: "1" } } },
      answer: svc(["88", "88", "99"], (p) => (p === "99" ? "1.2.0" : "1.3.0"), "88"),
      outlives: ["88"],
    });
    expect(next.calls).toContain("launchctl kickstart -k gui/501/org.example.gadget");
    expect(next.flow.some((c) => c === "/opt/gate.test/check GATE_VERSION=1.2.0" || c.startsWith("svcctl on"))).toBe(false);
    expect(next.res.log).toContain("  release check gadget: pid 88 still maps /brew/Cellar/gadget/1.3.0 after its owners restarted");
    expect(JSON.parse(next.files.get(PENDING)!)).toMatchObject({ verdict: "fail", rolledBack: true, after: "skip", unresolvedWaits: 1 });
  });

  test("2: the formula's own service (pid unknown) is required: restarted though its own process (a shell) maps no keg", async () => {
    let prints = 0;
    const r = await rcRun({
      cfg: { staleOwners: [{ match: "sh.brew.gadget" }] },
      onFs: (fs) => {
        const exists = fs.exists;
        fs.exists = async (p) => p === "/home.test/Library/LaunchAgents/sh.brew.gadget.plist" || exists(p);
      },
      answer: (line, argv) => {
        if (line === "launchctl print gui/501/sh.brew.gadget") {
          prints++;
          return { rc: 0, out: `\tstate = running\n\tpid = ${prints <= 2 ? 77 : 88}\n\tpath = /home.test/Library/LaunchAgents/sh.brew.gadget.plist\n`, err: "" };
        }
        if (argv[0]!.endsWith("lsof") && argv.includes("-iTCP")) return { rc: 1, out: "", err: "" };
        if (argv[0]!.endsWith("lsof") && argv.includes("-p")) return { rc: 0, out: LSOF_HEAD, err: "" };
        return undefined;
      },
    });
    expect(r.res.log).toContain("  release check owner: restarted sh.brew.gadget");
    const kick = r.calls.lastIndexOf("launchctl kickstart -k gui/501/sh.brew.gadget");
    expect(kick).toBeGreaterThan(r.calls.indexOf("brew upgrade example/tap/gadget"));
    expect(kick).toBeLessThan(r.calls.indexOf("/opt/gate.test/check GATE_VERSION=1.3.0"));
  });

  test("3: a repo-pinned outdated gated formula still gates its dependents (it would be pulled in unchecked)", async () => {
    const r = await rcRun({
      script: { formulas: "good-a gadget", verbose: "good-a (1.0) < 1.1\nexample/tap/gadget (1.2.0) < 1.3.0", formulaTaps: { "good-a": "homebrew/core", gadget: "example/tap" },
        pinFiles: [{ repo: "example-repo", path: "/repos.test/example-repo/pins.json", text: '{"brew":{"gadget":"1.2.0"}}' }] },
      answer: (l) => (l === "brew deps --include-build --include-optional good-a" ? { rc: 0, out: "gadget\n", err: "" } : undefined),
    });
    expect(r.calls.some((c) => c.startsWith("brew upgrade"))).toBe(false);
    expect(r.res.log).toContain("  good-a: not upgraded this run — it depends on gadget, which a release check gates; retried next run");
  });
  test("3: a brew-pinned outdated gated formula gates its dependents too", async () => {
    const r = await rcRun({
      script: { formulas: "good-a gadget", pinned: "gadget\n", verbose: "good-a (1.0) < 1.1\nexample/tap/gadget (1.2.0) < 1.3.0", formulaTaps: { "good-a": "homebrew/core", gadget: "example/tap" } },
      answer: (l) => (l === "brew deps --include-build --include-optional good-a" ? { rc: 0, out: "gadget\n", err: "" } : undefined),
    });
    expect(r.calls.some((c) => c.startsWith("brew upgrade"))).toBe(false);
  });

  test("4: a held formula whose candidate cannot be read is not upgraded this run", async () => {
    let infos = 0;
    const r = await rcRun({
      files: { [HOLD]: JSON.stringify({ formula: "gadget", version: "1.3.0", from: "1.2.0", at: "2026-10-25 04:00" }) },
      answer: (l) => (l === "brew info --json=v2 gadget" && infos++ === 0 ? { rc: 1, out: "", err: "" } : undefined),
    });
    expect(r.flow).toEqual([]);
    expect(r.res.log).toContain("  holding gadget (release check: its candidate version could not be read — not upgraded this run)");
  });
  test("4: any gated formula whose candidate cannot be read is not upgraded this run", async () => {
    let infos = 0;
    const r = await rcRun({ answer: (l) => (l === "brew info --json=v2 gadget" && infos++ === 0 ? { rc: 1, out: "", err: "" } : undefined) });
    expect(r.flow).toEqual([]);
  });

  test("5: the trust state cannot be read: the gated formula is not upgraded (neither before nor the upgrade)", async () => {
    const r = await rcRun({ answer: (l) => (l === "brew trust --formula --json=v1" ? { rc: 1, out: "", err: "" } : undefined) });
    expect(r.flow).toEqual([]);
    expect(r.files.has(PENDING)).toBe(false);
  });
  test("5: a malformed trust answer is unknown, never untrusted", async () => {
    const r = await rcRun({ answer: (l) => (l === "brew trust --formula --json=v1" ? { rc: 0, out: "{}", err: "" } : undefined) });
    expect(r.flow).toEqual([]);
  });
  test("5: the trust state read before the upgrade is the one the rollback restores", async () => {
    let trusts = 0;
    const r = await rcRun({
      check: { "1.3.0": [1, 1] },
      answer: (l) => (l === "brew trust --formula --json=v1" ? (trusts++ === 0 ? { rc: 0, out: '["example/tap/gadget"]', err: "" } : { rc: 1, out: "", err: "" }) : l === "brew trust --formula example/tap/gadget" ? { rc: 0, out: "", err: "" } : undefined),
    });
    expect(r.calls).toContain("brew trust --formula example/tap/gadget");
    expect(r.linked()).toBe("1.2.0");
    expect(r.flow.at(-1)).toBe("svcctl on");
  });

  test("sibling: the formula outdated query failed: a cask that depends on a gated formula is not upgraded", async () => {
    const r = await rcRun({
      script: { formulas: "", casks: "tfapp", caskTaps: { tfapp: "homebrew/cask" }, rc: { "brew outdated --formula": 1 } },
      answer: (l) => (l === "brew deps --include-build --include-optional --cask tfapp" ? { rc: 0, out: "gadget\n", err: "" } : l === "brew outdated --fetch-HEAD --formula" ? { rc: 1, out: "", err: "" } : undefined),
    });
    expect(r.calls.some((c) => c.startsWith("brew upgrade --cask"))).toBe(false);
  });
  test("sibling: the version in use cannot be read right before the upgrade: not upgraded, no before", async () => {
    let infos = 0;
    const r = await rcRun({ answer: (l) => (l === "brew info --json=v2 example/tap/gadget" && infos++ === 0 ? { rc: 1, out: "", err: "" } : undefined) });
    expect(r.flow).toEqual([]);
    expect(r.files.has(PENDING)).toBe(false);
  });
  test("sibling: the formula's cellar cannot be read: not upgraded, no before", async () => {
    const r = await rcRun({ answer: (l) => (l === "brew --cellar gadget" ? { rc: 1, out: "", err: "" } : undefined) });
    expect(r.flow).toEqual([]);
  });
  test("sibling: a hold file that cannot be read holds the formula (never an absent hold)", async () => {
    const r = await rcRun({ files: { [HOLD]: "{not json" } });
    expect(r.flow).toEqual([]);
    expect(r.res.log.some((l) => l.includes("holding gadget") && l.includes("unreadable"))).toBe(true);
  });
  test("sibling: an unreadable pending record holds its formula and keeps its previous keg from cleanup", async () => {
    const r = await rcRun({ files: { [PENDING]: "{not json" } });
    expect(r.flow).toEqual([]);
    expect(r.calls).not.toContain("brew cleanup");
    expect(r.calls).toContain("brew cleanup good-a");
  });
  test("sibling: the stale-keg scan failed: a check whose owner must restart waits (record kept), after runs", async () => {
    const r = await rcRun({
      cfg: SVC,
      answer: (_l, argv) => (argv[0]!.endsWith("lsof") && argv.includes("-d") ? { rc: 1, out: "", err: "" } : undefined),
    });
    expect(r.flow).toEqual(["svcctl off --now", "brew upgrade example/tap/gadget", "svcctl on"]);
    expect(r.files.has(PENDING)).toBe(true);
    expect(r.brew).toContain("gadget 1.3.0 check waits for its owner (the stale-keg scan did not run)");
  });
});

describe("release checks: review round 10", () => {
  // A staleOwners job (pid 77) and its child (78) both on the previous keg, the parent listed first:
  // the scan queues the parent and takes the child as covered by its restart.
  const run = (outlives: string[]) => {
    const gui = "gui/501 = {\n\tservices = {\n\t\t      77      - \torg.example.gadget\n\t}\n}\n";
    let prints = 0;
    return rcRun({
      cfg: { staleOwners: [{ match: "org.example.gadget", probe: ["/opt/svc.test/idle"] }] },
      outlives,
      script: {
        lsof: [`${LSOF_HEAD}gadget 77 u txt REG 1,4 1 2 /brew/Cellar/gadget/1.2.0/bin/gadget\ngadget 78 u txt REG 1,4 1 2 /brew/Cellar/gadget/1.2.0/bin/gadget\n`],
        ps: { "77": { comm: "gadget", command: "gadget serve", ppid: "1" }, "78": { comm: "gadget", command: "gadget worker", ppid: "77" } },
      },
      answer: (line, argv) => {
        if (line === "launchctl print gui/501") return { rc: 0, out: gui, err: "" };
        if (line === "launchctl print gui/501/org.example.gadget") {
          prints++;
          return { rc: 0, out: `\tstate = running\n\tpid = ${prints <= 2 ? 77 : 88}\n\tpath = /home.test/Library/LaunchAgents/org.example.gadget.plist\n`, err: "" };
        }
        if (argv[0]!.endsWith("lsof") && argv.includes("-p")) return { rc: 0, out: `${LSOF_HEAD}gadget ${argv[argv.indexOf("-p") + 1]} u txt REG 1,4 1 2 /brew/Cellar/gadget/1.3.0/bin/gadget\n`, err: "" };
        return undefined;
      },
    });
  };
  test("1: the parent's child outliving the inline restart on the previous keg: the check waits (record kept, the wait counted), after runs", async () => {
    const r = await run(["78"]);
    expect(r.calls).toContain("launchctl kickstart -k gui/501/org.example.gadget");
    expect(r.flow).not.toContain("/opt/gate.test/check GATE_VERSION=1.3.0");
    expect(r.res.log).toContain("  release check gadget: pid 78 still maps /brew/Cellar/gadget/1.2.0 after its owners restarted");
    expect(JSON.parse(r.files.get(PENDING)!)).toMatchObject({ unresolvedWaits: 1 });
    expect(r.flow.at(-1)).toBe("svcctl on");
  });
  test("1: the child ended with its parent's restart: the re-scan finds the previous keg free and the check runs", async () => {
    const r = await run([]);
    expect(r.flow).toEqual(["svcctl off --now", "brew upgrade example/tap/gadget", "launchctl kickstart -k gui/501/org.example.gadget", "/opt/gate.test/check GATE_VERSION=1.3.0", "svcctl on"]);
    expect(r.res.log).toContain("  release check gadget: no process maps a gadget keg other than /brew/Cellar/gadget/1.3.0 after its owners restarted");
  });
});

describe("release checks: review round 5 (4b24ca6)", () => {
  const SVC = { staleOwners: [{ match: "org.example.gadget", probe: ["/opt/svc.test/idle"] }] };
  const QUEUED = "/state.test/owner-restarts/queue/gui%2F501%2Forg.example.gadget.json";
  /** pid 77 under org.example.gadget maps an ungated deleted keg (bun/1.0) and the gated gadget/1.2.0; restarted onto 88. */
  const shared = () => {
    let prints = 0;
    return {
      script: {
        lsof: [`${LSOF_HEAD}gadget 77 u txt REG 1,4 1 2 /brew/Cellar/bun/1.0/lib/libbun.dylib\ngadget 77 u txt REG 1,4 1 2 /brew/Cellar/gadget/1.2.0/bin/gadget\n`],
        ps: { "77": { comm: "gadget", command: "gadget serve", ppid: "1" } },
      },
      answer: (line: string, argv: string[]) => {
        if (line === "launchctl print gui/501") return { rc: 0, out: "gui/501 = {\n\tservices = {\n\t\t      77      - \torg.example.gadget\n\t}\n}\n", err: "" };
        if (line === "launchctl print gui/501/org.example.gadget") {
          prints++;
          return { rc: 0, out: `\tstate = running\n\tpid = ${prints <= 2 ? 77 : 88}\n\tpath = /home.test/Library/LaunchAgents/org.example.gadget.plist\n`, err: "" };
        }
        if (argv[0]!.endsWith("lsof") && argv.includes("-p")) return { rc: 0, out: `${LSOF_HEAD}gadget ${argv[argv.indexOf("-p") + 1]} u txt REG 1,4 1 2 /brew/Cellar/gadget/1.3.0/bin/gadget\n`, err: "" };
        return undefined;
      },
    };
  };

  test("1: an owner mapping an ungated deleted keg first and the gated previous keg too is restarted inline before the check, never by the waiter", async () => {
    const r = await rcRun({ cfg: SVC, ...shared() });
    expect(r.writes).not.toContain(QUEUED);
    expect(r.spawned).toEqual([]);
    expect(r.flow).toEqual(["svcctl off --now", "brew upgrade example/tap/gadget", "launchctl kickstart -k gui/501/org.example.gadget", "/opt/gate.test/check GATE_VERSION=1.3.0", "svcctl on"]);
    expect(r.res.log).toContain("  release check owner: restarted org.example.gadget");
  });
  test("1: the same, when the waiter failed that label earlier (the ungated keg is not retried, the gated one is)", async () => {
    const r = await rcRun({ cfg: SVC, ...shared(), files: { "/state.test/owner-restarts/failed": "org.example.gadget\n" } });
    expect(r.flow).toEqual(["svcctl off --now", "brew upgrade example/tap/gadget", "launchctl kickstart -k gui/501/org.example.gadget", "/opt/gate.test/check GATE_VERSION=1.3.0", "svcctl on"]);
  });

  test("2: a stale process on the previous keg whose owner cannot be found (launchctl queries fail): the check waits, record kept", async () => {
    const r = await rcRun({
      cfg: { staleOwners: [{ match: "org.example.custom" }] },
      script: { lsof: [`${LSOF_HEAD}gadget 77 u txt REG 1,4 1 2 /brew/Cellar/gadget/1.2.0/bin/gadget\n`], ps: { "77": { comm: "gadget", command: "gadget serve", ppid: "1" } } },
      answer: (line) => (line === "launchctl print system" || line === "launchctl print gui/501" ? { rc: 1, out: "", err: "" } : undefined),
    });
    expect(r.flow).toEqual(["svcctl off --now", "brew upgrade example/tap/gadget", "svcctl on"]);
    expect(r.calls.some((c) => c.startsWith("/opt/gate.test/check"))).toBe(false);
    expect(r.files.has(PENDING)).toBe(true);
    expect(r.brew).toContain("gadget 1.3.0 check waits for its owner");
  });

  test("3: a hold file that is there but cannot be read holds the formula", async () => {
    const r = await rcRun({
      files: { [HOLD]: JSON.stringify({ formula: "gadget", version: "1.3.0", from: "1.2.0", at: "2026-10-25 04:00" }) },
      onFs: (fs) => {
        const read = fs.readFile;
        fs.readFile = async (p) => (p === HOLD ? undefined : read(p));
      },
    });
    expect(r.flow).toEqual([]);
    expect(r.res.log.some((l) => l.includes("holding gadget") && l.includes("unreadable"))).toBe(true);
  });
  test("3: a pending record that is there but cannot be read holds its formula and keeps its keg from cleanup", async () => {
    const r = await rcRun({
      files: { [PENDING]: "{}" },
      onFs: (fs) => {
        const read = fs.readFile;
        fs.readFile = async (p) => (p === PENDING ? undefined : read(p));
      },
    });
    expect(r.flow).toEqual([]);
    expect(r.calls).not.toContain("brew cleanup");
  });
  test("3: the pending directory cannot be listed: every gated formula is held and kept from cleanup", async () => {
    const r = await rcRun({
      onFs: (fs) => {
        fs.listState = async (d) => {
          if (d === "/state.test/release-checks/pending") throw new Error("EACCES");
          return fs.listDir(d);
        };
      },
    });
    expect(r.flow).toEqual([]);
    expect(r.calls).not.toContain("brew cleanup");
    expect(r.calls).toContain("brew cleanup good-a");
  });
});

describe("release checks: review round 6 (2eeb039)", () => {
  const LABEL = "com.max.gadget-server";
  const PLIST = `/Library/LaunchDaemons/${LABEL}.plist`;
  const STALE = `${LSOF_HEAD}gadget 78 u txt REG 1,4 1 2 /brew/Cellar/gadget/1.2.0/bin/gadget\n`;
  const FRESH = `${LSOF_HEAD}gadget 79 u txt REG 1,4 1 2 /brew/Cellar/gadget/1.3.0/bin/gadget\n`;
  const NAMED = { staleOwners: [{ match: "org.example.custom" }], releaseChecks: [{ ...CHECK, owners: [LABEL] }] };
  /**
   * A named owner (a shell, pid 77, mapping no keg) whose child pid 78 maps the previous keg: the
   * scan marks the keg unresolved (child of the job). `clears`: its restart moves the child off.
   */
  const wrapper = (clears: boolean) => {
    let prints = 0;
    let kicked = false;
    return {
      script: { ps: { "78": { comm: "gadget", command: "gadget serve", ppid: "77" }, "77": { comm: "sh", command: "sh -c gadget serve", ppid: "1" } } },
      onFs: (fs: ApplyFs) => {
        const exists = fs.exists;
        fs.exists = async (p: string) => p === PLIST || exists(p);
      },
      answer: (line: string, argv: string[]) => {
        if (line === "launchctl print system") return { rc: 0, out: `system = {\n\tservices = {\n\t\t      77      - \t${LABEL}\n\t}\n}\n`, err: "" };
        if (line === "launchctl print gui/501") return { rc: 0, out: "gui/501 = {\n\tservices = {\n\t}\n}\n", err: "" };
        if (line === `sudo -n launchctl kickstart -k system/${LABEL}`) kicked = true;
        if (line === `launchctl print system/${LABEL}`) {
          prints++;
          return { rc: 0, out: `\tstate = running\n\tpid = ${prints <= 3 ? 77 : 88}\n\tpath = ${PLIST}\n`, err: "" };
        }
        if (argv[0]!.endsWith("lsof") && argv.includes("-iTCP")) return { rc: 1, out: "", err: "" };
        if (argv[0]!.endsWith("lsof") && argv.includes("-p")) return { rc: 0, out: LSOF_HEAD, err: "" };
        if (argv[0]!.endsWith("lsof") && argv.includes("-d")) return { rc: 0, out: kicked && clears ? FRESH : STALE, err: "" };
        return undefined;
      },
    };
  };
  const waited = (n: number) => ({ formula: "gadget", full: "example/tap/gadget", rack: "/brew/Cellar/gadget", from: "1.2.0", to: "1.3.0", beforeRan: false, upgraded: true, afterRan: true, unresolvedWaits: n, at: "2026-10-25 04:00" });

  test("1: a named owner whose child maps the previous keg (unresolved by the scan) is restarted; the re-scan finds the keg free, so the check runs", async () => {
    const r = await rcRun({ cfg: NAMED, ...wrapper(true) });
    expect(r.flow).toEqual(["svcctl off --now", "brew upgrade example/tap/gadget", `sudo -n launchctl kickstart -k system/${LABEL}`, "/opt/gate.test/check GATE_VERSION=1.3.0", "svcctl on"]);
    expect(r.brew).toContain("release check: gadget 1.3.0 PASS");
    expect(r.files.has(PENDING)).toBe(false);
  });
  test("1: a stale process still on the previous keg after the named owners restarted: the check waits (record kept, the wait counted), after runs", async () => {
    const r = await rcRun({ cfg: NAMED, ...wrapper(false) });
    expect(r.flow).toEqual(["svcctl off --now", "brew upgrade example/tap/gadget", `sudo -n launchctl kickstart -k system/${LABEL}`, "svcctl on"]);
    expect(r.files.has(PENDING)).toBe(true);
    expect(JSON.parse(r.files.get(PENDING)!).unresolvedWaits).toBe(1);
    expect(r.brew).toContain("gadget 1.3.0 check waits for its owner");
  });
  test("review 8 #1: with no staleOwners set, a named wrapper owner whose child stays on the previous keg still holds the check back", async () => {
    const r = await rcRun({ cfg: { releaseChecks: [{ ...CHECK, owners: [LABEL] }] }, ...wrapper(false) });
    expect(r.calls.some((c) => c.startsWith("/opt/gate.test/check"))).toBe(false);
    expect(r.flow).toEqual(["svcctl off --now", "brew upgrade example/tap/gadget", `sudo -n launchctl kickstart -k system/${LABEL}`, "svcctl on"]);
    expect(JSON.parse(r.files.get(PENDING)!).unresolvedWaits).toBe(1);
  });
  test("review 8 #1: with no staleOwners set and the stale-keg scan failed, the named owners' restart is followed by a scan of the previous keg", async () => {
    for (const clears of [false, true]) {
      const w = wrapper(clears);
      let scans = 0;
      const r = await rcRun({
        cfg: { releaseChecks: [{ ...CHECK, owners: [LABEL] }] },
        ...w,
        answer: (line, argv) => (argv[0]!.endsWith("lsof") && argv.includes("-d") && !argv.includes("-p") && !argv.includes("-iTCP") && scans++ === 0 ? { rc: 1, out: "", err: "" } : w.answer(line, argv)),
      });
      expect(r.calls.some((c) => c.startsWith("/opt/gate.test/check"))).toBe(clears);
      expect(r.files.has(PENDING)).toBe(!clears);
    }
  });
  for (const [how, bad] of [["fails", { rc: 1, out: "", err: "" }], ["prints no services block", { rc: 0, out: "{garbage\n", err: "" }]] as const) {
    test(`review 8 (I6): launchctl print system ${how} in the stale-keg scan: a wrapper's child on the previous keg is unresolved, never left alone, so the check waits`, async () => {
      const w = wrapper(false);
      const r = await rcRun({ cfg: { releaseChecks: [{ ...CHECK, owners: [LABEL] }] }, ...w, answer: (line, argv) => (line === "launchctl print system" ? bad : w.answer(line, argv)) });
      expect(r.calls.some((c) => c.startsWith("/opt/gate.test/check"))).toBe(false);
      expect(r.files.has(PENDING)).toBe(true);
    });
  }
  test("review 8 (I1): with after and no before, an unresolved stale process ending the record with no verdict at the limit runs after", async () => {
    const { before: _, ...afterOnly } = CHECK;
    const r = await rcRun({
      cfg: { staleOwners: [{ match: "org.example.custom" }], releaseChecks: [afterOnly] },
      startLinked: "1.3.0",
      script: { formulas: "", verbose: "", lsof: [STALE], ps: { "78": { comm: "gadget", command: "gadget serve", ppid: "1" } } },
      answer: (line) => (line === "launchctl print system" || line === "launchctl print gui/501" ? { rc: 1, out: "", err: "" } : undefined),
      files: { [PENDING]: `${JSON.stringify({ ...waited(2), afterRan: false })}\n` },
    });
    expect(r.calls.some((c) => c.startsWith("/opt/gate.test/check"))).toBe(false);
    expect(r.flow).toEqual(["svcctl on"]);
    expect(r.files.has(PENDING)).toBe(false);
  });
  test("review 8 #1: with no staleOwners set, the re-scan finding the keg free lets the check run", async () => {
    const r = await rcRun({ cfg: { releaseChecks: [{ ...CHECK, owners: [LABEL] }] }, ...wrapper(true) });
    expect(r.flow).toEqual(["svcctl off --now", "brew upgrade example/tap/gadget", `sudo -n launchctl kickstart -k system/${LABEL}`, "/opt/gate.test/check GATE_VERSION=1.3.0", "svcctl on"]);
    expect(r.files.has(PENDING)).toBe(false);
  });
  test("1: bounded: the run that reaches the wait limit notifies and ends the record (no verdict, the new version kept), never waiting forever", async () => {
    const w = wrapper(false);
    const r = await rcRun({ cfg: NAMED, ...w, startLinked: "1.3.0", script: { formulas: "", verbose: "", ...w.script }, files: { [PENDING]: `${JSON.stringify(waited(2))}\n` } });
    expect(r.calls.some((c) => c.startsWith("/opt/gate.test/check"))).toBe(false);
    expect(r.notices().some((n) => n.includes("gadget 1.3.0") && n.includes("not run"))).toBe(true);
    expect(r.brew).toContain("FAILED: release-check:gadget");
    expect(r.files.has(PENDING)).toBe(false);
  });
  test("1: bounded with no named owner too: an unresolved stale process ends the record with a notice at the limit", async () => {
    const r = await rcRun({
      cfg: { staleOwners: [{ match: "org.example.custom" }] },
      startLinked: "1.3.0",
      script: { formulas: "", verbose: "", lsof: [STALE], ps: { "78": { comm: "gadget", command: "gadget serve", ppid: "1" } } },
      answer: (line) => (line === "launchctl print system" || line === "launchctl print gui/501" ? { rc: 1, out: "", err: "" } : undefined),
      files: { [PENDING]: `${JSON.stringify(waited(2))}\n` },
    });
    expect(r.calls.some((c) => c.startsWith("/opt/gate.test/check"))).toBe(false);
    expect(r.notices().some((n) => n.includes("gadget 1.3.0") && n.includes("not run"))).toBe(true);
    expect(r.files.has(PENDING)).toBe(false);
  });

  const ALPHA = "/state.test/release-checks/pending/alpha.json";
  const alphaRec = { formula: "alpha", full: "alpha", rack: "/brew/Cellar/alpha", from: "1.0", to: "1.1", beforeRan: false, upgraded: true, verdict: "pass", after: "run", afterRan: true, ended: true, at: "2026-10-25 04:00" };
  const eacces = (fs: ApplyFs) => {
    const remove = fs.remove;
    fs.remove = async (p) => {
      if (p === ALPHA) throw new Error("EACCES: permission denied");
      return remove(p);
    };
  };
  test("2: an earlier completed record whose removal fails (EACCES) does not keep a later record from its check and owed after", async () => {
    const r = await rcRun({ cfg: { releaseChecks: [CHECK, { ...CHECK, formula: "alpha", before: undefined, after: undefined }] }, files: { [ALPHA]: `${JSON.stringify(alphaRec)}\n` }, onFs: eacces });
    expect(r.flow).toEqual(["svcctl off --now", "brew upgrade example/tap/gadget", "/opt/gate.test/check GATE_VERSION=1.3.0", "svcctl on"]);
    expect(r.brew).toContain("gadget 1.3.0 PASS");
    expect(r.brew).toContain("FAILED: release-check:alpha");
    expect(r.res.log.some((l) => l.includes("alpha") && l.includes("EACCES"))).toBe(true);
    expect(r.notices().some((n) => n.includes("alpha") && n.includes("EACCES"))).toBe(true);
  });
  test("2: an earlier record no longer configured whose removal fails does not keep a later record from its owed after", async () => {
    const r = await rcRun({ files: { [ALPHA]: `${JSON.stringify(alphaRec)}\n` }, onFs: eacces });
    expect(r.flow).toEqual(["svcctl off --now", "brew upgrade example/tap/gadget", "/opt/gate.test/check GATE_VERSION=1.3.0", "svcctl on"]);
  });
  test("2: the owner lock's release throwing still runs the record's owed after", async () => {
    const r = await rcRun({ cfg: { staleOwners: [{ match: "org.example.custom" }] }, lockReleaseThrows: true });
    expect(r.flow).toEqual(["svcctl off --now", "brew upgrade example/tap/gadget", "/opt/gate.test/check GATE_VERSION=1.3.0", "svcctl on"]);
  });
});

describe("release checks: review round 7 (5912cdf)", () => {
  const SVC = { staleOwners: [{ match: "org.example.gadget", probe: ["/opt/svc.test/idle"] }] };
  /** A custom staleOwners job found only through its keg mappings: pid 77 on the previous keg, restarted onto 88. */
  const owner = () => {
    let prints = 0;
    return {
      script: { lsof: [`${LSOF_HEAD}gadget 77 u txt REG 1,4 1 2 /brew/Cellar/gadget/1.2.0/bin/gadget\n`], ps: { "77": { comm: "gadget", command: "gadget serve", ppid: "1" } } },
      answer: (line: string, argv: string[]) => {
        if (line === "launchctl print gui/501") return { rc: 0, out: "gui/501 = {\n\tservices = {\n\t\t      77      - \torg.example.gadget\n\t}\n}\n", err: "" };
        if (line === "launchctl print gui/501/org.example.gadget") {
          prints++;
          return { rc: 0, out: `\tstate = running\n\tpid = ${prints <= 2 ? 77 : 88}\n\tpath = /home.test/Library/LaunchAgents/org.example.gadget.plist\n`, err: "" };
        }
        if (argv[0]!.endsWith("lsof") && argv.includes("-p")) return { rc: 0, out: `${LSOF_HEAD}gadget ${argv[argv.indexOf("-p") + 1]} u txt REG 1,4 1 2 /brew/Cellar/gadget/1.3.0/bin/gadget\n`, err: "" };
        return undefined;
      },
    };
  };

  test("1: brew upgrade exits nonzero after installing the new keg: the version is recovered before the stale-keg scan, so the keg-mapped owner restarts before the check", async () => {
    const o = owner();
    const r = await rcRun({ ...o, cfg: SVC, script: { ...o.script, upgradeRc: { "example/tap/gadget": 1 } }, installsOnFail: true });
    expect(r.flow).toEqual(["svcctl off --now", "brew upgrade example/tap/gadget", "launchctl kickstart -k gui/501/org.example.gadget", "/opt/gate.test/check GATE_VERSION=1.3.0", "svcctl on"]);
  });
  test("1: the post-upgrade version query fails once: recovered before the stale-keg scan, the owner restarts before the check", async () => {
    const o = owner();
    let infos = 0;
    const r = await rcRun({ ...o, cfg: SVC, answer: (l, a) => (l === "brew info --json=v2 example/tap/gadget" && ++infos === 2 ? { rc: 1, out: "", err: "" } : o.answer(l, a)) });
    expect(r.flow).toEqual(["svcctl off --now", "brew upgrade example/tap/gadget", "launchctl kickstart -k gui/501/org.example.gadget", "/opt/gate.test/check GATE_VERSION=1.3.0", "svcctl on"]);
  });
  test("1: a version recovered only after the stale-keg scan is not checked against an unscanned keg: the check waits (record kept), after runs", async () => {
    const o = owner();
    let infos = 0;
    // Every version read fails until the release checks section: the scan never saw the previous keg as retired.
    const r = await rcRun({ ...o, cfg: SVC, answer: (l, a) => (l === "brew info --json=v2 example/tap/gadget" && ++infos >= 2 && infos <= 3 ? { rc: 1, out: "", err: "" } : o.answer(l, a)) });
    expect(r.calls.some((c) => c.startsWith("/opt/gate.test/check"))).toBe(false);
    expect(r.flow.at(-1)).toBe("svcctl on");
    expect(r.files.has(PENDING)).toBe(true);
    expect(JSON.parse(r.files.get(PENDING)!).to).toBe("1.3.0");
  });

  test("2: a persisted FAIL is rolled back and held though a stale process on the previous keg is unresolved at the wait limit (never ended as no verdict)", async () => {
    const rec = { formula: "gadget", full: "example/tap/gadget", rack: "/brew/Cellar/gadget", from: "1.2.0", to: "1.3.0", trusted: false, beforeRan: true, upgraded: true, ownerRestarted: true, verdict: "fail", after: "skip", unresolvedWaits: 2, at: "2026-10-25 04:00" };
    const r = await rcRun({
      cfg: { staleOwners: [{ match: "org.example.custom" }] },
      startLinked: "1.3.0",
      script: { formulas: "", verbose: "", lsof: [`${LSOF_HEAD}gadget 78 u txt REG 1,4 1 2 /brew/Cellar/gadget/1.2.0/bin/gadget\n`], ps: { "78": { comm: "gadget", command: "gadget serve", ppid: "1" } } },
      answer: (line) => (line === "launchctl print system" || line === "launchctl print gui/501" ? { rc: 1, out: "", err: "" } : undefined),
      files: { [PENDING]: `${JSON.stringify(rec)}\n` },
    });
    expect(r.calls).toContain("brew uninstall example/tap/gadget");
    expect(r.linked()).toBe("1.2.0");
    expect(JSON.parse(r.files.get(HOLD)!)).toMatchObject({ version: "1.3.0" });
    expect(r.notices().some((n) => n.includes("No verdict"))).toBe(false);
  });
  test("2: a persisted FAIL is rolled back though the stale-keg scan did not run", async () => {
    const rec = { formula: "gadget", full: "example/tap/gadget", rack: "/brew/Cellar/gadget", from: "1.2.0", to: "1.3.0", trusted: false, beforeRan: true, upgraded: true, ownerRestarted: true, verdict: "fail", after: "skip", at: "2026-10-25 04:00" };
    const r = await rcRun({
      cfg: { staleOwners: [{ match: "org.example.custom" }] },
      startLinked: "1.3.0",
      script: { formulas: "", verbose: "" },
      answer: (_l, argv) => (argv[0]!.endsWith("lsof") && argv.includes("-d") ? { rc: 1, out: "", err: "" } : undefined),
      files: { [PENDING]: `${JSON.stringify(rec)}\n` },
    });
    expect(r.calls).toContain("brew uninstall example/tap/gadget");
    expect(JSON.parse(r.files.get(HOLD)!)).toMatchObject({ version: "1.3.0" });
  });

  test("3: a cask named like a held gated formula and depending on it is not upgraded (the self-name exemption is for formulae only)", async () => {
    const r = await rcRun({
      script: { formulas: "gadget", casks: "gadget", caskTaps: { gadget: "homebrew/cask" } },
      files: { [HOLD]: JSON.stringify({ formula: "gadget", version: "1.3.0", from: "1.2.0", at: "2026-10-25 04:00" }) },
      answer: (l) => (l === "brew deps --include-build --include-optional --cask gadget" ? { rc: 0, out: "gadget\n", err: "" } : undefined),
    });
    expect(r.calls.some((c) => c.startsWith("brew upgrade --cask"))).toBe(false);
    expect(r.res.log).toContain("  gadget: not upgraded this run — it depends on gadget, which a release check gates; retried next run");
  });
});

describe("release checks: an older retained keg (Codex review of 3ee8ffa)", () => {
  const LABEL = "com.max.gadget-server";
  const PLIST = `/Library/LaunchDaemons/${LABEL}.plist`;
  const OLD = "/brew/Cellar/gadget/1.1.0";
  const line = (pid: string, v: string) => `gadget ${pid} u txt REG 1,4 1 2 /brew/Cellar/gadget/${v}/bin/gadget\n`;
  /**
   * A named owner (pid 77) whose restarts start pids 88, 99, …; `onKeg(n)`: the keg the n-th
   * restart's process maps (its own pid, or with `wrapper` a child the system-wide scan sees).
   */
  const retained = (onKeg: (n: number) => string, wrapper = false) => {
    let prints = 0;
    let kicks = 0;
    const pidOf = (n: number) => String(77 + 11 * n);
    return {
      cfg: { releaseChecks: [{ ...CHECK, owners: [LABEL] }] },
      onFs: (fs: ApplyFs) => {
        const exists = fs.exists;
        fs.exists = async (p: string) => p === PLIST || exists(p);
        const isDir = fs.isDir;
        fs.isDir = async (p: string) => p === OLD || isDir(p);
      },
      answer: (l: string, argv: string[]) => {
        if (l.includes(`kickstart -k system/${LABEL}`)) {
          kicks++;
          return undefined;
        }
        if (l === `launchctl print system/${LABEL}`) {
          prints++;
          return { rc: 0, out: `\tstate = running\n\tpid = ${pidOf(kicks)}\n\tpath = ${PLIST}\n`, err: "" };
        }
        if (argv[0]!.endsWith("lsof") && argv.includes("-iTCP")) return { rc: 1, out: "", err: "" };
        if (argv[0]!.endsWith("lsof") && argv.includes("-p")) {
          const pid = argv[argv.indexOf("-p") + 1]!;
          return { rc: 0, out: LSOF_HEAD + (!wrapper && kicks && pid === pidOf(kicks) ? line(pid, onKeg(kicks)) : ""), err: "" };
        }
        if (argv[0]!.endsWith("lsof") && kicks) return { rc: 0, out: LSOF_HEAD + line(wrapper ? "500" : pidOf(kicks), onKeg(kicks)), err: "" };
        return undefined;
      },
    };
  };

  test("an owner restarted onto an older retained keg (neither the previous nor a deleted one) fails its health: the candidate is not checked", async () => {
    const r = await rcRun(retained(() => "1.1.0"));
    expect(r.calls.some((c) => c.startsWith("/opt/gate.test/check"))).toBe(false);
    expect(r.res.log.some((l) => l.includes(`not healthy after restart (pid 88 still maps a keg other than /brew/Cellar/gadget/1.3.0)`))).toBe(true);
    expect(r.brew).toContain("gadget 1.3.0 not checked, owner restart failed");
  });
  test("a wrapper owner whose child comes up on an older retained keg: the re-scan finds it, the check waits", async () => {
    const r = await rcRun(retained(() => "1.1.0", true));
    expect(r.calls.some((c) => c.startsWith("/opt/gate.test/check"))).toBe(false);
    expect(r.res.log).toContain(`  release check gadget: pid 500 still maps ${OLD} after its owners restarted`);
    expect(r.files.has(PENDING)).toBe(true);
  });
  test("the owner on the candidate keg: the check runs", async () => {
    const r = await rcRun(retained(() => "1.3.0"));
    expect(r.calls).toContain("/opt/gate.test/check GATE_VERSION=1.3.0");
  });
  test("after a rollback, an owner restarted onto an older retained keg: the restored version is not checked, after not run", async () => {
    const r = await rcRun({ ...retained((n) => (n === 1 ? "1.3.0" : "1.1.0")), check: { "1.3.0": [1, 1] } });
    expect(r.calls).toContain("brew uninstall example/tap/gadget");
    expect(r.calls).toContain("/opt/gate.test/check GATE_VERSION=1.3.0");
    expect(r.calls).not.toContain("/opt/gate.test/check GATE_VERSION=1.2.0");
    expect(r.calls).not.toContain("svcctl on");
    expect(r.res.log.some((l) => l.includes("still maps a keg other than /brew/Cellar/gadget/1.2.0"))).toBe(true);
  });
  test("an earlier run's owner restart, its check not run: an owner process on an older retained keg since puts the restart ahead again", async () => {
    const rec = { formula: "gadget", full: "example/tap/gadget", rack: "/brew/Cellar/gadget", from: "1.2.0", to: "1.3.0", trusted: false, beforeRan: false, upgraded: true, upgradeStarted: true, ownerRestarted: true, at: "2026-10-25 04:00" };
    const o = retained(() => "1.3.0");
    const r = await rcRun({
      ...o,
      startLinked: "1.3.0",
      script: { formulas: "", verbose: "", lsof: [LSOF_HEAD + line("77", "1.1.0")] },
      files: { [PENDING]: `${JSON.stringify(rec)}\n` },
    });
    expect(r.res.log).toContain(`  release check gadget: pid 77 maps ${OLD} before the check — its owners are restarted first`);
    expect(r.flow).toEqual([`sudo -n launchctl kickstart -k system/${LABEL}`, "/opt/gate.test/check GATE_VERSION=1.3.0", "svcctl on"]);
  });
});

describe("release checks: owners on any keg of the formula but the expected one (Codex review of c32a13b)", () => {
  const OLD = "/brew/Cellar/gadget/1.1.0";
  const gui = "gui/501 = {\n\tservices = {\n\t\t      77      - \torg.example.gadget\n\t}\n}\n";
  /** A custom staleOwners job (no named owner, no service of the formula's own) already on the older retained 1.1.0. */
  const onOld = () => {
    let prints = 0;
    return {
      cfg: { staleOwners: [{ match: "org.example.gadget", probe: ["/opt/svc.test/idle"] }] },
      onFs: (fs: ApplyFs) => {
        const isDir = fs.isDir;
        fs.isDir = async (p: string) => p === OLD || isDir(p);
      },
      script: { lsof: [`${LSOF_HEAD}gadget 77 u txt REG 1,4 1 2 ${OLD}/bin/gadget\n`], ps: { "77": { comm: "gadget", command: "gadget serve", ppid: "1" } } },
      answer: (line: string, argv: string[]) => {
        if (line === "launchctl print gui/501") return { rc: 0, out: gui, err: "" };
        if (line === "launchctl print gui/501/org.example.gadget") {
          prints++;
          return { rc: 0, out: `\tstate = running\n\tpid = ${prints <= 2 ? 77 : 88}\n\tpath = /home.test/Library/LaunchAgents/org.example.gadget.plist\n`, err: "" };
        }
        if (argv[0]!.endsWith("lsof") && argv.includes("-p")) {
          const pid = argv[argv.indexOf("-p") + 1]!;
          return { rc: 0, out: `${LSOF_HEAD}gadget ${pid} u txt REG 1,4 1 2 /brew/Cellar/gadget/${pid === "77" ? "1.1.0" : "1.3.0"}/bin/gadget\n`, err: "" };
        }
        return undefined;
      },
    };
  };
  test("an owner already on an older retained keg before the upgrade is found by the stale-keg scan and restarted before the check", async () => {
    const r = await rcRun(onOld());
    expect(r.flow).toEqual(["svcctl off --now", "brew upgrade example/tap/gadget", "launchctl kickstart -k gui/501/org.example.gadget", "/opt/gate.test/check GATE_VERSION=1.3.0", "svcctl on"]);
    expect(r.res.log).toContain("  release check gadget: no process maps a gadget keg other than /brew/Cellar/gadget/1.3.0 after its owners restarted");
  });
  test("the same owner outliving its restart there: no check, the wait counted, after runs", async () => {
    const r = await rcRun({ ...onOld(), outlives: ["77"] });
    expect(r.flow.some((c) => c.startsWith("/opt/gate.test/check"))).toBe(false);
    expect(r.res.log).toContain(`  release check gadget: pid 77 still maps ${OLD} after its owners restarted`);
    expect(JSON.parse(r.files.get(PENDING)!)).toMatchObject({ unresolvedWaits: 1 });
    expect(r.flow.at(-1)).toBe("svcctl on");
  });
});

describe("OUP-78: a formula whose check owner is not running is held, and an unfinished check keeps its keg", () => {
  const LABEL = "com.max.gadget-server";
  const PLIST = `/Library/LaunchDaemons/${LABEL}.plist`;
  const OWNED = { releaseChecks: [{ ...CHECK, owners: [LABEL] }] };
  /** The owner's launchd job: running for its first `upFor` prints, then not loaded. */
  const daemon = (upFor: number) => {
    let prints = 0;
    return {
      onFs: (fs: ApplyFs) => {
        const exists = fs.exists;
        fs.exists = async (p: string) => p === PLIST || exists(p);
      },
      answer: (line: string, argv: string[]) => {
        if (line === `launchctl print system/${LABEL}`) {
          prints++;
          return prints <= upFor ? { rc: 0, out: `\tstate = running\n\tpid = 77\n\tpath = ${PLIST}\n`, err: "" } : { rc: 113, out: "", err: "not found" };
        }
        if (argv[0]!.endsWith("lsof") && argv.includes("-iTCP")) return { rc: 1, out: "", err: "" };
        return undefined;
      },
    };
  };

  test("a: the owner is not running before the upgrade: held, no before, no upgrade, no cleanup of its keg, a held line in the summary", async () => {
    const r = await rcRun({ cfg: OWNED, ...daemon(0) });
    expect(r.calls.some((c) => c.startsWith("brew upgrade"))).toBe(false);
    expect(r.flow).toEqual([]);
    expect(r.res.log).toContain(`  holding gadget (release check: its owner ${LABEL} is not running — not upgraded, its keg is untouched)`);
    expect(r.brew).toContain(`gadget not upgraded, owner ${LABEL} not running`);
    expect(r.brew).toContain("FAILED: release-check:gadget");
    expect(r.files.has(PENDING)).toBe(false);
  });

  test("b: an owner restart that fails keeps the record and the previous keg, in the run and in the next run", async () => {
    // Running at the pre-upgrade probe, gone at the restart.
    const first = await rcRun({ cfg: OWNED, ...daemon(1) });
    expect(first.flow).toEqual(["svcctl off --now", "brew upgrade example/tap/gadget", "svcctl on"]);
    expect(first.notices().some((n) => n.includes("not run, the owner restart failed"))).toBe(true);
    expect(first.files.has(PENDING)).toBe(true);
    expect(first.calls).not.toContain("brew cleanup");
    expect(first.calls).toContain("brew cleanup good-a");
    // The next run: the owner is still gone.
    const second = await rcRun({ cfg: OWNED, ...daemon(0), startLinked: "1.3.0", candidate: "1.3.0", script: { formulas: "", verbose: "" }, files: { [PENDING]: first.files.get(PENDING)! } });
    expect(second.files.has(PENDING)).toBe(true);
    expect(second.calls).not.toContain("brew cleanup");
    expect(second.calls.some((c) => c.startsWith("brew cleanup") && c.includes("gadget"))).toBe(false);
    expect(second.calls.some((c) => c.startsWith("brew uninstall"))).toBe(false);
  });
});

describe("a check whose owner is left unloaded on purpose (ownerUnloaded: upgrade) upgrades with no check; anything short of a positive no-such-job holds", () => {
  const A = "com.example.gadget-server";
  const B = "com.example.gadget-worker";
  const daemonPlist = (l: string) => `/Library/LaunchDaemons/${l}.plist`;
  const agentPlist = (l: string) => `/home.test/Library/LaunchAgents/${l}.plist`;
  type State = "unloaded" | "loaded" | "running" | "denied" | "system-running" | "user-idle" | "rc113-other" | "notfound-rc1" | "no-gui-domain" | "no-system-domain";
  const NOJOB = (l: string, d: string) => ({ rc: 113, out: "Bad request.\n", err: `Could not find service "${l}" in domain for ${d}\n` });
  /** A complete lsof: its header and one unrelated process, ended. */
  const CLEAN = `${LSOF_HEAD}launchd 1 root txt REG 1,4 1 2 /sbin/launchd\n`;
  interface Owner {
    state: State;
    /** Where its plist is (default /Library/LaunchDaemons); "none": no plist anywhere. */
    plist?: "daemon" | "agent" | "none";
    /** The Label its plist names (default the owner label). */
    plistLabel?: string;
    /** After this many prints of the label (any domain), it runs. */
    loadsAfter?: number;
    /** The answer to the label's first print only. */
    firstPrint?: { rc: number; out: string; err: string };
    /** What it becomes after loadsAfter prints (default running). */
    becomes?: State;
  }
  /**
   * Owners by label, and launchd's answers. "running" names pid 77 for its first 3 running prints, then 88 (restarted).
   * `lsof`: the full-scan answer (default CLEAN). `timeouts`: command lines that time out.
   */
  /** Every user's processes as `ps -axww -o pid=,ppid=,command=` prints them (default: launchd only). */
  const PS = "    1     0 /sbin/launchd\n";
  type Answer = { rc: number; out: string };
  /** `ps`: one answer for every read, or successive answers (the last repeats). */
  const owners = (o: Record<string, Owner>, x: { lsof?: { rc: number; out: string; err?: string }; ps?: Answer | Answer[]; timeouts?: string[] } = {}) => {
    const psAnswers = x.ps === undefined ? [{ rc: 0, out: PS }] : Array.isArray(x.ps) ? [...x.ps] : [x.ps];
    const prints = new Map<string, number>();
    const running = new Map<string, number>();
    const plistOf = (l: string) => ((o[l]!.plist ?? "daemon") === "none" ? "" : o[l]!.plist === "agent" ? agentPlist(l) : daemonPlist(l));
    const plists = Object.keys(o).map(plistOf).filter(Boolean);
    return {
      onFs: (fs: ApplyFs) => {
        const exists = fs.exists;
        fs.exists = async (p: string) => plists.includes(p) || exists(p);
      },
      script: x.timeouts ? { timeout: x.timeouts } : {},
      answer: (line: string, argv: string[]) => {
        if (x.timeouts?.includes(line)) return undefined;
        const pl = line.match(/^plutil -extract Label raw -o - (\S+)$/);
        if (pl) {
          const l = Object.keys(o).find((k) => plistOf(k) === pl[1]);
          return l ? { rc: 0, out: `${o[l]!.plistLabel ?? l}\n`, err: "" } : { rc: 1, out: "", err: "No such file\n" };
        }
        const m = line.match(/^launchctl print (system|gui\/501|user\/501)\/(\S+)$/);
        if (m && o[m[2]!]) {
          const l = m[2]!;
          const n = (prints.get(l) ?? 0) + 1;
          prints.set(l, n);
          if (n === 1 && o[l]!.firstPrint) return o[l]!.firstPrint!;
          const st = o[l]!.loadsAfter !== undefined && n > o[l]!.loadsAfter! ? (o[l]!.becomes ?? "running") : o[l]!.state;
          const domain = m[1] === "system" ? "system" : m[1] === "user/501" ? "uid: 501" : "user gui: 501";
          if (st === "denied") return { rc: 1, out: "", err: "Operation not permitted\n" };
          if (st === "rc113-other") return { rc: 113, out: "Bad request.\n", err: "" };
          if (st === "notfound-rc1") return { ...NOJOB(l, domain), rc: 1 };
          if (st === "no-system-domain") return m[1] === "system" ? { rc: 112, out: "Bad request.\n", err: "Could not find domain for system\n" } : NOJOB(l, domain);
          if (st === "no-gui-domain") return m[1] === "gui/501" ? { rc: 112, out: "Bad request.\n", err: "Could not find domain for user gui: 501\n" } : NOJOB(l, domain);
          if (st === "unloaded" || ((st === "system-running" || st === "running") && m[1] !== "system") || (st === "user-idle" && m[1] !== "user/501")) return NOJOB(l, domain);
          if (st === "loaded" || st === "user-idle") return { rc: 0, out: `\tstate = not running\n\tpath = ${daemonPlist(l)}\n`, err: "" };
          const k = (running.get(l) ?? 0) + 1;
          running.set(l, k);
          return { rc: 0, out: `\tstate = running\n\tpid = ${k <= 3 ? 77 : 88}\n\tpath = ${daemonPlist(l)}\n`, err: "" };
        }
        if (argv[0]!.endsWith("lsof") && argv.includes("-iTCP")) return { rc: 1, out: "", err: "" };
        if (argv[0]!.endsWith("lsof") && argv.includes("-p")) return { rc: 0, out: LSOF_HEAD, err: "" };
        if (argv[0]!.endsWith("lsof") && argv.some((a) => a.endsWith("txt,mem"))) return { err: "", ...(x.lsof ?? { rc: 0, out: CLEAN }) };
        if (line === "ps -axww -o pid=,ppid=,command=") return { err: "", ...(psAnswers.length > 1 ? psAnswers.shift()! : psAnswers[0]!) };
        return undefined;
      },
    };
  };
  const cfgOf = (labels: string[], mode: "upgrade" | "none" = "upgrade") => ({ releaseChecks: [{ ...CHECK, owners: labels, ...(mode === "upgrade" ? { ownerUnloaded: mode } : {}) }] });
  const held = (r: Awaited<ReturnType<typeof rcRun>>) => {
    expect(r.calls.some((c) => c.startsWith("brew upgrade"))).toBe(false);
    expect(r.brew).toContain("FAILED: release-check:gadget");
    expect(r.notices().some((n) => n.includes("release check gadget: held, not upgraded"))).toBe(true);
    expect(r.res.log.some((l) => l.includes("upgraded unchecked"))).toBe(false);
  };

  test("unloaded (plist naming the label, rc 113 'Could not find service' in system, gui and user), nothing on its kegs: upgraded with no before, check or after, said after the upgrade, no FAILED, no warning, no record", async () => {
    const r = await rcRun({ cfg: cfgOf([A]), ...owners({ [A]: { state: "unloaded" } }) });
    expect(r.flow).toEqual(["brew upgrade example/tap/gadget"]);
    for (const d of ["system", "gui/501", "user/501"]) expect(r.calls).toContain(`launchctl print ${d}/${A}`);
    expect(r.calls).toContain(`plutil -extract Label raw -o - ${daemonPlist(A)}`);
    expect(r.res.log).toContain(`  release check gadget: its owner ${A} is not loaded and nothing runs from it (ownerUnloaded: upgrade) — no check this run, asked again right before the upgrade`);
    expect(r.res.log).toContain(`  release check gadget: brew upgrade done with no check — its owner ${A} is not loaded; not restarted`);
    expect(r.res.log).toContain("restart: gadget not restarted — upgraded unchecked, its owner is not loaded");
    expect(r.brew).toContain("release check: gadget upgraded unchecked, owner not loaded");
    expect(r.brew).not.toContain("release-check:gadget");
    expect(r.notices().some((n) => n.includes("⚠️"))).toBe(false);
    expect(r.files.has(PENDING)).toBe(false);
  });
  test("right before the upgrade the owner probes are the last calls: nothing runs between the last print and brew upgrade", async () => {
    const r = await rcRun({ cfg: cfgOf([A]), ...owners({ [A]: { state: "unloaded" } }) });
    const up = r.calls.indexOf("brew upgrade example/tap/gadget");
    expect(up).toBeGreaterThan(0);
    // Its plist is a LaunchDaemon's: the system print is the last, after gui and user.
    expect(r.calls.slice(up - 3, up)).toEqual([`launchctl print gui/501/${A}`, `launchctl print user/501/${A}`, `launchctl print system/${A}`]);
    // The recheck: the scan (cellar, lsof, ps), then the probes, then the upgrade.
    const recheck = r.calls.slice(0, up);
    const lastScan = Math.max(recheck.lastIndexOf("ps -axww -o pid=,ppid=,command="), recheck.lastIndexOf("brew --cellar gadget"));
    const firstProbeAfter = recheck.findIndex((c, i) => i > lastScan && c.startsWith("launchctl print"));
    expect(firstProbeAfter).toBeGreaterThan(lastScan);
    expect(recheck.slice(lastScan + 1).every((c) => c.startsWith("launchctl print") || c.startsWith("plutil "))).toBe(true);
  });
  test("the owner starts (in system) while gui is asked: the system print, last, sees it running: the checked path, never unchecked", async () => {
    // A LaunchDaemon: gui, user, then system. It starts after the first print, in system only.
    const r = await rcRun({ cfg: cfgOf([A]), ...owners({ [A]: { state: "unloaded", loadsAfter: 1, becomes: "system-running" } }) });
    expect(r.flow[0]).toBe("svcctl off --now");
    expect(r.res.log.some((l) => l.includes("no check this run") || l.includes("upgraded unchecked"))).toBe(false);
  });
  test("two owners: every owner's own-domain print comes after every other probe, the last calls before brew upgrade", async () => {
    const r = await rcRun({ cfg: cfgOf([A, B]), ...owners({ [A]: { state: "unloaded" }, [B]: { state: "unloaded" } }) });
    const up = r.calls.indexOf("brew upgrade example/tap/gadget");
    expect(up).toBeGreaterThan(0);
    expect(r.calls.slice(up - 3, up)).toEqual([`launchctl print user/501/${B}`, `launchctl print system/${A}`, `launchctl print system/${B}`]);
  });
  test("an agent (its plist in ~/Library/LaunchAgents): system first, then gui and user last (user holds it with no gui session)", async () => {
    const r = await rcRun({ cfg: cfgOf([A]), ...owners({ [A]: { state: "no-gui-domain", plist: "agent" } }) });
    const up = r.calls.indexOf("brew upgrade example/tap/gadget");
    expect(up).toBeGreaterThan(0);
    expect(r.calls.slice(up - 3, up)).toEqual([`launchctl print system/${A}`, `launchctl print gui/501/${A}`, `launchctl print user/501/${A}`]);
  });
  test("a headless host (gui/<uid> answers 'Could not find domain', exit 112): no job there, upgraded unchecked", async () => {
    const r = await rcRun({ cfg: cfgOf([A]), ...owners({ [A]: { state: "no-gui-domain" } }) });
    expect(r.flow).toEqual(["brew upgrade example/tap/gadget"]);
  });
  test("unloaded but another user's process runs from its keg (ps, which lsof as this user cannot see): held", async () => {
    const r = await rcRun({ cfg: cfgOf([A]), ...owners({ [A]: { state: "unloaded" } }, { ps: { rc: 0, out: `${PS}  4242     1 /brew/Cellar/gadget/1.2.0/libexec/bin/python3 -m server\n` } }) });
    held(r);
    expect(r.res.log).toContain(`  holding gadget (release check: its owner ${A} is not loaded, but pid 4242 runs from it — not upgraded, its keg is untouched)`);
  });
  test("unloaded but a process runs from its opt link: held", async () => {
    held(await rcRun({ cfg: cfgOf([A]), ...owners({ [A]: { state: "unloaded" } }, { ps: { rc: 0, out: `${PS}  4243     1 /brew/opt/gadget/bin/gadget serve\n` } }) }));
  });
  test("unloaded but ps fails: held", async () => {
    const r = await rcRun({ cfg: cfgOf([A]), ...owners({ [A]: { state: "unloaded" } }, { ps: { rc: 1, out: "" } }) });
    held(r);
    expect(r.res.log).toContain(`  holding gadget (release check: its owner ${A} is not loaded, but the processes running from it could not be read completely — not upgraded, its keg is untouched)`);
  });
  // The same formula as Type A (its tap official here).
  const typeA = (labels: string[]) => ({ ...cfgOf(labels), typeBTaps: [], officialTaps: ["homebrew/core", "example/tap"] });
  test("Type A: unloaded, upgraded unchecked", async () => {
    const r = await rcRun({ cfg: typeA([A]), ...owners({ [A]: { state: "unloaded" } }) });
    expect(r.res.log.some((l) => l.startsWith("--- Type A review"))).toBe(true);
    expect(r.flow).toEqual(["brew upgrade gadget"]);
    expect(r.brew).toContain("release check: gadget upgraded unchecked, owner not loaded");
  });
  test("Type A: the owner loads before the recheck: held, not upgraded, not an upgrade failure", async () => {
    const r = await rcRun({ cfg: typeA([A]), ...owners({ [A]: { state: "unloaded", loadsAfter: 3 } }) });
    expect(r.calls.some((c) => c.startsWith("brew upgrade"))).toBe(false);
    expect(r.brew).toContain("FAILED: release-check:gadget;");
    expect(r.brew).not.toMatch(/FAILED: [^;]*(^| )(example\/tap\/)?gadget( |;)/);
  });
  test("Type A: upgraded to a version other than the reviewed one: flagged, and no 'upgraded unchecked' note", async () => {
    const r = await rcRun({ cfg: typeA([A]), ...owners({ [A]: { state: "unloaded" } }), script: { verbose: "example/tap/gadget (1.2.0) < 1.4.0" } });
    expect(r.calls).toContain("brew upgrade gadget");
    expect(r.res.log.some((l) => l.includes("Type A:") && l.includes("FLAGGED"))).toBe(true);
    expect(r.brew).not.toContain("upgraded unchecked");
  });
  /**
   * A whole run where pid 66 sits on a deleted keg of gadget after the upgrade, run by launchd under the
   * formula's own label (the stale-keg step would restart it). `o`: the run's other options; `fromStart`: there from
   * the start of the run.
   */
  const leftover = async (o: Partial<Rc> = {}, ownerState: Owner = { state: "unloaded" }, fromStart = false) => {
    const SVC = "sh.brew.gadget";
    const AGENT = `/home.test/Library/LaunchAgents/${SVC}.plist`;
    const base = owners({ [A]: ownerState });
    let upgraded = false;
    return rcRun({
      cfg: cfgOf([A]),
      ...o,
      onFs: (fs) => {
        base.onFs(fs);
        const exists = fs.exists;
        fs.exists = async (p: string) => p === AGENT || exists(p);
      },
      script: { ...o.script, ps: { "66": { comm: "gadget", command: "/brew/Cellar/gadget/1.1.9/bin/gadget serve", ppid: "1" } } },
      answer: (line, argv) => {
        // From the upgrade on (or from the start: a run after the one that upgraded).
        if (fromStart || line.startsWith("brew upgrade")) upgraded = true;
        if (upgraded && argv[0]!.endsWith("lsof") && argv.some((a) => a.endsWith("txt,mem"))) return { rc: 0, out: `${CLEAN}gadget 66 u txt REG 1,4 1 2 /brew/Cellar/gadget/1.1.9/bin/gadget\n`, err: "" };
        if (line === `launchctl print gui/501/${SVC}`) return { rc: 0, out: `\tstate = running\n\tpid = 66\n\tpath = ${AGENT}\n`, err: "" };
        if (line === "launchctl print gui/501") return { rc: 0, out: `services = {\n\t66\t-\t${SVC}\n}\n`, err: "" };
        return base.answer(line, argv);
      },
    });
  };
  test("a whole run: a process on a deleted keg of the formula after an unchecked upgrade is reported by the stale-keg check, never restarted", async () => {
    const r = await leftover();
    expect(r.calls).toContain("brew upgrade example/tap/gadget");
    expect(r.calls.some((c) => c.includes("kickstart"))).toBe(false);
    expect(r.res.log).toContain("    gadget: upgraded with no release check (its owner is not loaded) — pid 66 is reported, never restarted here");
  });
  test("a whole run: planned unchecked but its upgrade failed: not left alone, the stale-keg step handles it as any package", async () => {
    const r = await leftover({ script: { upgradeRc: { "example/tap/gadget": 1 } } });
    expect(r.res.log.some((l) => l.includes("upgraded with no release check"))).toBe(false);
    expect(r.calls).toContain(`launchctl kickstart -k gui/501/sh.brew.gadget`);
  });
  test("a whole run, Type A: brew upgraded it unchecked, then a version mismatch flagged it: its leftover process is still left alone", async () => {
    const r = await leftover({ cfg: { ...cfgOf([A]), typeBTaps: [], officialTaps: ["homebrew/core", "example/tap"] }, script: { verbose: "example/tap/gadget (1.2.0) < 1.4.0" } });
    expect(r.calls).toContain("brew upgrade gadget");
    expect(r.res.log.some((l) => l.includes("Type A:") && l.includes("FLAGGED"))).toBe(true);
    expect(r.calls.some((c) => c.includes("kickstart"))).toBe(false);
  });
  test("the next run (no unchecked upgrade in it): a leftover process on the unchecked formula's deleted keg is restarted as any stale process (documented: oUpdate keeps no record of it)", async () => {
    const r = await leftover({ script: { formulas: "", verbose: "" } }, { state: "unloaded" }, true);
    expect(r.calls.some((c) => c.startsWith("brew upgrade"))).toBe(false);
    expect(r.calls).toContain(`launchctl kickstart -k gui/501/sh.brew.gadget`);
  });
  test("the first print denied (exit 1), every later print 'no such job', scans clean: held (the first answer must say no job too)", async () => {
    held(await rcRun({ cfg: cfgOf([A]), ...owners({ [A]: { state: "unloaded", firstPrint: { rc: 1, out: "", err: "Operation not permitted\n" } } }) }));
  });
  test.each([["daemon", "the first print"], ["agent", "a later print"]] as const)("the system domain answering 'Could not find domain' (exit 112), %s plist (%s): held (only a gui or user domain may be absent)", async (plist) => {
    held(await rcRun({ cfg: cfgOf([A]), ...owners({ [A]: { state: "no-system-domain", plist } }) }));
  });
  test.each([
    ["a script under a keg's share/", "/usr/bin/python3 /brew/opt/gadget/share/server.py"],
    ["a path after --opt=", "/usr/bin/java --opt=/brew/Cellar/gadget/1.2.0/lib/x.jar"],
    ["a path inside a -cp list", "/usr/bin/java -cp /a.jar:/brew/opt/gadget/lib/b.jar:/c.jar Main"],
    ["a program that only reads a file there (tail -f of a log; held, the safe side)", "tail -f /brew/opt/gadget/share/status.log"],
    ["an attached -r option", "/usr/bin/ruby -r/brew/opt/gadget/libexec/server.rb -e sleep"],
    ["an attached -I option", "/usr/bin/ruby -I/brew/Cellar/gadget/1.2.0/lib -e sleep"],
    ["a file:// url", "/usr/bin/java -Dx=1 file:///brew/opt/gadget/share/app.jar"],
    ["a quoted path", "/bin/sh -c '/brew/opt/gadget/bin/gadget serve'"],
    ["a path after a comma", "/usr/bin/tool --paths=/a,/brew/opt/gadget/lib"],
    ["the opt folder itself, no trailing slash", "/usr/bin/java -Dhome=/brew/opt/gadget -jar x.jar"],
    ["an argument file (@<path>)", "/usr/bin/javac @/brew/opt/gadget/share/args.txt"],
    ["a path after a semicolon", "/bin/sh -c true;/brew/opt/gadget/bin/gadget"],
    ["the opt folder before &&", "/bin/sh -c 'cd /brew/opt/gadget&&./run'"],
    ["the opt folder before a pipe", "/bin/sh -c 'ls /brew/opt/gadget|cat'"],
    ["the opt folder before )", "/bin/sh -c '(cd /brew/opt/gadget)'"],
    ["the opt folder before a backtick", "/bin/sh -c 'echo `ls /brew/opt/gadget`'"],
    ["the opt folder at the end of the line", "/usr/bin/tool --home /brew/opt/gadget"],
  ])("a process naming a path under its keg or opt link (%s): held", async (_n, cmd) => {
    const r = await rcRun({ cfg: cfgOf([A]), ...owners({ [A]: { state: "unloaded" } }, { ps: { rc: 0, out: `${PS}  4244     1 ${cmd}\n` } }) });
    held(r);
    expect(r.res.log).toContain(`  holding gadget (release check: its owner ${A} is not loaded, but pid 4244 runs from it — not upgraded, its keg is untouched)`);
  });
  test("a path that only shares a prefix (/brew/opt/gadget-extra/): not a holder, upgraded unchecked", async () => {
    const r = await rcRun({ cfg: cfgOf([A]), ...owners({ [A]: { state: "unloaded" } }, { ps: { rc: 0, out: `${PS}  4248     1 /brew/opt/gadget-extra/bin/x\n` } }) });
    expect(r.flow).toEqual(["brew upgrade example/tap/gadget"]);
  });
  test("a path that only ends like its opt link (/tmp/brew/opt/gadget/): not a holder, upgraded unchecked", async () => {
    const r = await rcRun({ cfg: cfgOf([A]), ...owners({ [A]: { state: "unloaded" } }, { ps: { rc: 0, out: `${PS}  4250     1 /tmp/brew/opt/gadget/bin/x\n` } }) });
    expect(r.flow).toEqual(["brew upgrade example/tap/gadget"]);
  });
  test("this run's own process and its ps name the formula's paths: not holders, upgraded unchecked", async () => {
    const self = String(process.pid);
    const ps = `${PS}  ${self}     1 bun oupdate host --apply /brew/opt/gadget/bin/gadget\n  4251  ${self} ps -axww -o pid=,ppid=,command= /brew/opt/gadget/\n`;
    const r = await rcRun({ cfg: cfgOf([A]), ...owners({ [A]: { state: "unloaded" } }, { ps: { rc: 0, out: ps } }) });
    expect(r.flow).toEqual(["brew upgrade example/tap/gadget"]);
  });
  test("a child of this run running a keg script (an interpreter: not in lsof's txt maps): held", async () => {
    const self = String(process.pid);
    const ps = `${PS}  ${self}     1 bun oupdate host --apply\n  4252  ${self} /usr/bin/ruby /brew/Cellar/gadget/1.2.0/libexec/worker.rb\n`;
    const r = await rcRun({ cfg: cfgOf([A]), ...owners({ [A]: { state: "unloaded" } }, { ps: { rc: 0, out: ps } }) });
    held(r);
    expect(r.res.log).toContain(`  holding gadget (release check: its owner ${A} is not loaded, but pid 4252 runs from it — not upgraded, its keg is untouched)`);
  });
  test("an interpreter running a script from its keg's libexec: a holder, held", async () => {
    const r = await rcRun({ cfg: cfgOf([A]), ...owners({ [A]: { state: "unloaded" } }, { ps: { rc: 0, out: `${PS}  4245     1 /usr/bin/python3 -u /brew/opt/gadget/libexec/server.py\n` } }) });
    held(r);
    expect(r.res.log).toContain(`  holding gadget (release check: its owner ${A} is not loaded, but pid 4245 runs from it — not upgraded, its keg is untouched)`);
  });
  test("a process ps cannot show (\"(name)\") on both reads: held", async () => {
    const r = await rcRun({ cfg: cfgOf([A]), ...owners({ [A]: { state: "unloaded" } }, { ps: { rc: 0, out: `${PS}  4246     1 (server)\n` } }) });
    held(r);
    expect(r.res.log).toContain(`  holding gadget (release check: its owner ${A} is not loaded, but a process command is unreadable (pid 4246) — not upgraded, its keg is untouched)`);
  });
  test("a process ps cannot show on one read only (mid-exec): read again (2 reads per scan), readable and unrelated, upgraded unchecked", async () => {
    const r = await rcRun({ cfg: cfgOf([A]), ...owners({ [A]: { state: "unloaded" } }, { ps: [{ rc: 0, out: `${PS}  4247     1 (bash)\n` }, { rc: 0, out: `${PS}  4247     1 /bin/bash -c true\n` }] }) });
    expect(r.flow).toEqual(["brew upgrade example/tap/gadget"]);
    // The plan and the recheck: 2 reads, then 1 (the second scan's first read is readable).
    expect(r.calls.filter((c) => c === "ps -axww -o pid=,ppid=,command=")).toHaveLength(3);
  });
  test("mid-exec on the first read, the second shows it running from the keg: held", async () => {
    const r = await rcRun({ cfg: cfgOf([A]), ...owners({ [A]: { state: "unloaded" } }, { ps: [{ rc: 0, out: `${PS}  4247     1 (gadget)\n` }, { rc: 0, out: `${PS}  4247     1 /brew/Cellar/gadget/1.2.0/bin/gadget serve\n` }] }) });
    held(r);
    expect(r.res.log).toContain(`  holding gadget (release check: its owner ${A} is not loaded, but pid 4247 runs from it — not upgraded, its keg is untouched)`);
  });
  test("lsof finds a holder while a ps row stays unreadable: the hold names the holder, not the unreadable row", async () => {
    const r = await rcRun({ cfg: cfgOf([A]), ...owners({ [A]: { state: "unloaded" } }, { lsof: { rc: 0, out: `${CLEAN}gadget 66 u txt REG 1,4 1 2 /brew/Cellar/gadget/1.2.0/bin/gadget\n` }, ps: { rc: 0, out: `${PS}  4253     1 (x)\n` } }) });
    held(r);
    expect(r.res.log).toContain(`  holding gadget (release check: its owner ${A} is not loaded, but pid 66 runs from it — not upgraded, its keg is untouched)`);
  });
  test("a holder in the first read that reads \"(name)\" in the second is still a holder (both reads count)", async () => {
    const r = await rcRun({ cfg: cfgOf([A]), ...owners({ [A]: { state: "unloaded" } }, { ps: [
      { rc: 0, out: `${PS}    41     1 (bash)\n    42     1 /usr/bin/python3 /brew/opt/gadget/libexec/server.py\n` },
      { rc: 0, out: `${PS}    41     1 /bin/bash -c true\n    42     1 (python3)\n` },
    ] }) });
    held(r);
    expect(r.res.log).toContain(`  holding gadget (release check: its owner ${A} is not loaded, but pid 42 runs from it — not upgraded, its keg is untouched)`);
  });
  test.each([["prints nothing", { rc: 0, out: "" }], ["exits 1 though it printed a list", { rc: 1, out: "    1     0 /sbin/launchd\n" }], ["times out", "timeout"]] as const)("unloaded but ps %s: held", async (_n, ps) => {
    held(await rcRun({ cfg: cfgOf([A]), ...owners({ [A]: { state: "unloaded" } }, ps === "timeout" ? { timeouts: ["ps -axww -o pid=,ppid=,command="] } : { ps: { ...ps } }) }));
  });
  test("unloaded, its plist in ~/Library/LaunchAgents: upgraded unchecked", async () => {
    const r = await rcRun({ cfg: cfgOf([A]), ...owners({ [A]: { state: "unloaded", plist: "agent" } }) });
    expect(r.flow).toEqual(["brew upgrade example/tap/gadget"]);
    expect(r.calls).toContain(`plutil -extract Label raw -o - ${agentPlist(A)}`);
  });
  test("unloaded, dry run: says it would upgrade unchecked and runs nothing", async () => {
    const r = await rcRun({ cfg: cfgOf([A]), ...owners({ [A]: { state: "unloaded" } }), dryRun: true });
    expect(r.flow).toEqual([]);
    expect(r.res.log).toContain(`  dry-run: release check gadget: its owner ${A} is not loaded and nothing runs from it (ownerUnloaded: upgrade) — would upgrade with no before, check or after`);
  });
  test("the owner loads between the plan and the upgrade (a review takes minutes): asked again, held as before, not upgraded", async () => {
    // The plan prints 3 times (gui, user, then system); from the next print on it runs (in system).
    const r = await rcRun({ cfg: cfgOf([A]), ...owners({ [A]: { state: "unloaded", loadsAfter: 3 } }) });
    expect(r.res.log).toContain(`  release check gadget: its owner ${A} is not loaded and nothing runs from it (ownerUnloaded: upgrade) — no check this run, asked again right before the upgrade`);
    expect(r.calls.some((c) => c.startsWith("brew upgrade"))).toBe(false);
    expect(r.brew).toContain("FAILED: release-check:gadget");
    expect(r.res.log.some((l) => l.includes("upgraded unchecked"))).toBe(false);
    expect(r.brew).toContain("FAILED: release-check:gadget;");
    expect(r.brew).not.toContain("STUCK");
    expect(r.res.log).toContain(`  holding gadget (release check: its owner ${A} runs now, though it was not loaded when this run planned — not upgraded, its keg is untouched)`);
  });
  test("the formula's own service label, unloaded with its plist present and default restart settings: no kickstart, no restart FAILED", async () => {
    const OWN = "homebrew.mxcl.gadget";
    const r = await rcRun({ cfg: cfgOf([OWN]), ...owners({ [OWN]: { state: "unloaded" } }) });
    expect(r.calls).toContain("brew upgrade example/tap/gadget");
    expect(r.calls.some((c) => c.includes("kickstart"))).toBe(false);
    expect(r.brew).not.toContain("FAILED");
    expect(r.res.log).toContain("restart: gadget not restarted — upgraded unchecked, its owner is not loaded");
  });
  test("a failed upgrade: no 'upgraded unchecked', FAILED as for any upgrade", async () => {
    const r = await rcRun({ cfg: cfgOf([A]), ...owners({ [A]: { state: "unloaded" } }), script: { upgradeRc: { "example/tap/gadget": 1 } } });
    expect(r.res.log.some((l) => l.includes("upgraded unchecked"))).toBe(false);
    expect(r.brew).not.toContain("upgraded unchecked");
    expect(r.brew).toMatch(/FAILED: .*gadget/);
  });
  test("a review hold after the owner probe: not upgraded, no 'upgraded unchecked'", async () => {
    const r = await rcRun({ cfg: cfgOf([A]), ...owners({ [A]: { state: "unloaded" } }), typeBRc: 1 });
    expect(r.calls.some((c) => c.startsWith("brew upgrade"))).toBe(false);
    expect(r.brew).not.toContain("upgraded unchecked");
  });
  test("same user, working directory inside a keg (a relative script maps nothing from it): the lsof cwd row holds it", async () => {
    const cwd = `${CLEAN}python3 66 u cwd DIR 1,4 736 2 /brew/Cellar/gadget/1.2.0/libexec\n`;
    const r = await rcRun({ cfg: cfgOf([A]), ...owners({ [A]: { state: "unloaded" } }, { lsof: { rc: 0, out: cwd } }) });
    held(r);
    expect(r.res.log).toContain(`  holding gadget (release check: its owner ${A} is not loaded, but pid 66 runs from it — not upgraded, its keg is untouched)`);
    expect(r.calls).toContain("/usr/sbin/lsof -nP -w -d cwd,txt,mem");
  });
  test("same user, working directory at a keg's root (no file under it): the lsof cwd row holds it", async () => {
    const cwd = `${CLEAN}python3 66 u cwd DIR 1,4 736 2 /brew/Cellar/gadget/1.2.0\n`;
    const r = await rcRun({ cfg: cfgOf([A]), ...owners({ [A]: { state: "unloaded" } }, { lsof: { rc: 0, out: cwd } }) });
    held(r);
  });
  test("a working directory elsewhere: not a holder, upgraded unchecked", async () => {
    const cwd = `${CLEAN}python3 66 u cwd DIR 1,4 736 2 /Users/someone/project\n`;
    const r = await rcRun({ cfg: cfgOf([A]), ...owners({ [A]: { state: "unloaded" } }, { lsof: { rc: 0, out: cwd } }) });
    expect(r.flow).toEqual(["brew upgrade example/tap/gadget"]);
  });
  test("unloaded but a process maps a keg of the formula: held", async () => {
    const r = await rcRun({ cfg: cfgOf([A]), ...owners({ [A]: { state: "unloaded" } }, { lsof: { rc: 0, out: `${CLEAN}gadget 66 u txt REG 1,4 1 2 /brew/Cellar/gadget/1.2.0/bin/gadget\n` } }) });
    held(r);
    expect(r.res.log).toContain(`  holding gadget (release check: its owner ${A} is not loaded, but pid 66 runs from it — not upgraded, its keg is untouched)`);
  });
  test.each([
    ["lsof fails", { rc: 1, out: "" }],
    ["lsof warns on stderr (a partial scan)", { rc: 0, out: CLEAN, err: "lsof: WARNING: can't stat() nfs file system /mnt/x\n" }],
    ["lsof's last row is cut off", { rc: 0, out: `${CLEAN}gadget 66 u txt REG` }],
    ["lsof prints only its header", { rc: 0, out: LSOF_HEAD }],
  ] as const)("unloaded but %s: held", async (_n, lsof) => {
    const r = await rcRun({ cfg: cfgOf([A]), ...owners({ [A]: { state: "unloaded" } }, { lsof: { ...lsof } }) });
    held(r);
    expect(r.res.log).toContain(`  holding gadget (release check: its owner ${A} is not loaded, but the processes running from it could not be read completely — not upgraded, its keg is untouched)`);
  });
  test("a print that fails for another reason (permission denied): held", async () => {
    held(await rcRun({ cfg: cfgOf([A]), ...owners({ [A]: { state: "denied" } }) }));
  });
  test.each([["rc 113 with no 'Could not find service'", "rc113-other"], ["'Could not find service' with another rc", "notfound-rc1"]] as const)("an odd print answer (%s): held", async (_n, state) => {
    held(await rcRun({ cfg: cfgOf([A]), ...owners({ [A]: { state } }) }));
  });
  test("a mistyped label (no plist in either place, no job in any domain): held", async () => {
    held(await rcRun({ cfg: cfgOf([A]), ...owners({ [A]: { state: "unloaded", plist: "none" } }) }));
  });
  test("a plist whose Label is another job's: held", async () => {
    held(await rcRun({ cfg: cfgOf([A]), ...owners({ [A]: { state: "unloaded", plistLabel: "com.example.other" } }) }));
  });
  test("another domain: plist in ~/Library/LaunchAgents, no job in gui/<uid>, but the job runs in system: held", async () => {
    held(await rcRun({ cfg: cfgOf([A]), ...owners({ [A]: { state: "system-running", plist: "agent" } }) }));
  });
  test("loaded idle in user/<uid> (no job in system or gui): held", async () => {
    held(await rcRun({ cfg: cfgOf([A]), ...owners({ [A]: { state: "user-idle" } }) }));
  });
  test("a probe that times out (ownerUnloaded: upgrade): held, the run goes on", async () => {
    const r = await rcRun({ cfg: cfgOf([A]), ...owners({ [A]: { state: "unloaded" } }, { timeouts: [`launchctl print user/501/${A}`] }) });
    held(r);
    expect(r.brew).not.toContain("timeout:");
  });
  test("the first print times out (ownerUnloaded: upgrade): held, no phase stop, the run goes on", async () => {
    const r = await rcRun({ cfg: cfgOf([A]), ...owners({ [A]: { state: "unloaded" } }, { timeouts: [`launchctl print system/${A}`] }) });
    held(r);
    expect(r.brew).not.toContain("timeout:");
  });
  test("the default (no ownerUnloaded): only the one print runs, as before, so a would-be second probe timing out changes nothing", async () => {
    const r = await rcRun({ cfg: cfgOf([A], "none"), ...owners({ [A]: { state: "unloaded" } }, { timeouts: [`launchctl print gui/501/${A}`, `launchctl print user/501/${A}`] }) });
    held(r);
    expect(r.calls.filter((c) => c.startsWith("launchctl print") && c.endsWith(A))).toEqual([`launchctl print system/${A}`]);
    expect(r.calls.some((c) => c.startsWith("plutil"))).toBe(false);
    expect(r.brew).not.toContain("timeout:");
    expect(r.res.log).toContain(`  holding gadget (release check: its owner ${A} is not running — not upgraded, its keg is untouched)`);
    expect(r.brew).toContain(`gadget not upgraded, owner ${A} not running`);
  });
  test("loaded with no pid: held, as with no ownerUnloaded", async () => {
    const r = await rcRun({ cfg: cfgOf([A]), ...owners({ [A]: { state: "loaded" } }) });
    held(r);
    expect(r.res.log).toContain(`  holding gadget (release check: its owner ${A} is not running — not upgraded, its keg is untouched)`);
  });
  test("two owners, one unloaded and one loaded with no pid: held, each named as found", async () => {
    const r = await rcRun({ cfg: cfgOf([A, B]), ...owners({ [A]: { state: "unloaded" }, [B]: { state: "loaded" } }) });
    held(r);
    expect(r.res.log).toContain(`  holding gadget (release check: its owner ${A} is not loaded, ${B} is not running — not upgraded, its keg is untouched)`);
  });
  test("two owners, one unloaded and one running: not unchecked; held as for an owner not running", async () => {
    const r = await rcRun({ cfg: cfgOf([A, B]), ...owners({ [A]: { state: "unloaded" }, [B]: { state: "running" } }) });
    held(r);
    expect(r.res.log).toContain(`  holding gadget (release check: its owner ${A} is not loaded (the others run) — not upgraded, its keg is untouched)`);
  });
  test("running: the full checked path (before, upgrade, owner restart, check, after), never the unchecked one", async () => {
    const r = await rcRun({ cfg: cfgOf([A]), ...owners({ [A]: { state: "running" } }) });
    expect(r.flow).toEqual(["svcctl off --now", "brew upgrade example/tap/gadget", `sudo -n launchctl kickstart -k system/${A}`, "/opt/gate.test/check GATE_VERSION=1.3.0", "svcctl on"]);
    expect(r.res.log.some((l) => l.includes("upgraded unchecked"))).toBe(false);
  });
});
