// Ported from secure-update's waiter cases (test/port/07): the handoff of a deferred service to its
// idle waiter, and the waiter report. The waiter is a real script started detached.
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { killLive, realExec, resetStopping, type Exec } from "../../src/apply/exec.ts";
import { staleKegCheck, type KegEnv } from "../../src/apply/kegs.ts";
import { matchOwner, ownerWaiterReport, queueOwners, makeFlockLock, realTakeLock, runOwnerWaiter, type OwnerWaiterEnv, type QueuedOwner } from "../../src/apply/owner-waiter.ts";
import { handoff, mtimeDayOf, realSpawnDetached, waiterReport, type DeferredService, type WaiterEnv } from "../../src/apply/waiter.ts";

const root = mkdtempSync(join(tmpdir(), "oupdate-waiter-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const TROUBLE_RE = /flag|block|cve|error|fail|abort|no status|stuck|stale|divergent/i;

let n = 0;
function fixture() {
  const dir = join(root, `case-${++n}`);
  mkdirSync(dir, { recursive: true });
  const waiter = join(dir, "fake-waiter.sh");
  // --holder prints the pid in ./holder or fails; --recover logs; anything else logs the keg it got.
  // The keg run records its own process group, prints to stdout and stderr, then sleeps a little.
  writeFileSync(
    waiter,
    `#!/bin/bash\nD="${dir}"\ncase "$1" in\n  --holder) [ -f "$D/holder" ] && cat "$D/holder" && exit 0; exit 1 ;;\n  --recover) echo recovered >> "$D/calls"; [ -f "$D/recover-fails" ] && exit 1; exit 0 ;;\n  *) ps -o pgid= -p $$ | tr -d ' ' > "$D/pgid"; echo to-stdout; echo to-stderr >&2; echo "waiter $1" >> "$D/calls" ;;\nesac\n`,
  );
  chmodSync(waiter, 0o755);
  const s: DeferredService = {
    name: "svc", waiter, holdFile: join(dir, "svc-hold"), quarantineFile: join(dir, "svc-quarantine"),
    outcomeFile: join(dir, "svc-restart.outcome"), restartLog: join(dir, "svc-restart.log"),
  };
  const env: WaiterEnv = {
    exec: realExec,
    exists: async (p) => existsSync(p),
    readFile: async (p) => readFileSync(p, "utf8"),
    remove: async (p) => rmSync(p, { force: true }),
    mtimeDay: mtimeDayOf,
    spawnDetached: realSpawnDetached,
  };
  const calls = () => (existsSync(join(dir, "calls")) ? readFileSync(join(dir, "calls"), "utf8").trim().split("\n") : []);
  const waitForCalls = async () => {
    for (let i = 0; i < 50 && !calls().length; i++) await Bun.sleep(100);
    return calls();
  };
  return { dir, s, env, calls, waitForCalls };
}

describe("handoff", () => {
  test("a stale deferred service is handed to the waiter, detached, with its keg", async () => {
    const f = fixture();
    const note = await handoff(f.env, f.s, "/brew/Cellar/svc/HEAD-old", false, { holderTimeoutMs: 5000 });
    expect(note).toMatch(/^svc stale — restart handed to waiter \(pid \d+\)$/);
    expect(await f.waitForCalls()).toEqual(["waiter /brew/Cellar/svc/HEAD-old"]);
  });
  test("the waiter runs in its own process group (it survives the run), stderr appended to the restart log, stdout dropped", async () => {
    const f = fixture();
    await handoff(f.env, f.s, "/k", false);
    await f.waitForCalls();
    const mine = Bun.spawnSync(["ps", "-o", "pgid=", "-p", String(process.pid)]).stdout.toString().trim();
    const theirs = readFileSync(join(f.dir, "pgid"), "utf8").trim();
    expect(theirs).toMatch(/^\d+$/);
    expect(mine).toMatch(/^\d+$/);
    expect(theirs).not.toBe(mine);
    const log = readFileSync(f.s.restartLog, "utf8");
    expect(log).toContain("to-stderr");
    expect(log).not.toContain("to-stdout");
  });
  test("a restart log in a folder that does not exist yet is created, not a failure", async () => {
    const f = fixture();
    const s = { ...f.s, restartLog: join(f.dir, "logs", "deep", "restart.log") };
    expect(await handoff(f.env, s, "/k", false)).toMatch(/restart handed to waiter \(pid \d+\)$/);
    await f.waitForCalls();
    expect(existsSync(s.restartLog)).toBe(true);
  });
  test("a waiter that cannot be started is a FAILED note, never a thrown error", async () => {
    const f = fixture();
    const env = { ...f.env, spawnDetached: async () => { throw new Error("spawn refused"); } };
    const note = await handoff(env, f.s, "/k", false);
    expect(note).toBe("svc stale — FAILED to start the waiter (spawn refused), nothing will restart it");
    expect(note).toMatch(TROUBLE_RE);
  });
  test("a dry run with a hold still says on hold (the hold is checked first)", async () => {
    const f = fixture();
    writeFileSync(f.s.holdFile, "");
    expect(await handoff(f.env, f.s, "/k", true)).toBe(`svc on hold — not restarting (see ${f.s.holdFile})`);
  });
  test("a live waiter is not duplicated", async () => {
    const f = fixture();
    writeFileSync(join(f.dir, "holder"), "4242\n");
    expect(await handoff(f.env, f.s, "/k", false)).toBe("svc stale — waiter already running (pid 4242)");
    await Bun.sleep(200);
    expect(f.calls()).toEqual([]);
  });
  test("dry-run never starts a waiter", async () => {
    const f = fixture();
    expect(await handoff(f.env, f.s, "/k", true)).toBe("svc stale — dry-run: would hand svc to fake-waiter.sh");
    await Bun.sleep(200);
    expect(f.calls()).toEqual([]);
  });
  test("a missing waiter script is a failure the digest sees", async () => {
    const f = fixture();
    const note = await handoff(f.env, { ...f.s, waiter: join(f.dir, "nope.sh") }, "/k", false);
    expect(note).toBe(`svc stale — FAILED: ${join(f.dir, "nope.sh")} missing, nothing will restart it`);
    expect(note).toMatch(TROUBLE_RE);
  });
  test("hold: a stale service is not handed to the waiter", async () => {
    const f = fixture();
    writeFileSync(f.s.holdFile, "");
    expect(await handoff(f.env, f.s, "/k", false)).toBe(`svc on hold — not restarting (see ${f.s.holdFile})`);
    await Bun.sleep(200);
    expect(f.calls()).toEqual([]);
  });
  test("quarantine: a stale service is not handed to the waiter", async () => {
    const f = fixture();
    writeFileSync(f.s.quarantineFile, "");
    expect(await handoff(f.env, f.s, "/k", false)).toBe(`svc quarantined — not restarting (see ${f.s.quarantineFile})`);
    await Bun.sleep(200);
    expect(f.calls()).toEqual([]);
  });
  test("quarantine and hold both present: quarantine is named (it is checked first)", async () => {
    const f = fixture();
    writeFileSync(f.s.quarantineFile, "");
    writeFileSync(f.s.holdFile, "");
    expect(await handoff(f.env, f.s, "/k", false)).toBe(`svc quarantined — not restarting (see ${f.s.quarantineFile})`);
  });
  test("the --holder query is bounded at 30 s", async () => {
    const f = fixture();
    const seen: (number | undefined)[] = [];
    const exec: Exec = async (argv, opts) => {
      if (argv.includes("--holder")) seen.push(opts?.timeoutMs);
      return { rc: 0, out: "77\n", err: "" };
    };
    expect(await handoff({ ...f.env, exec }, f.s, "/k", false)).toBe("svc stale — waiter already running (pid 77)");
    expect(seen).toEqual([30_000]);
  });
  test("a spawn that fails after it returns (no pid) is a FAILED note, never pid -1", async () => {
    const f = fixture();
    const bad = join(f.dir, "no-such-binary");
    await expect(realSpawnDetached([bad], f.s.restartLog)).rejects.toThrow("no pid");
    const env = { ...f.env, spawnDetached: (argv: string[], log: string) => realSpawnDetached([bad, ...argv.slice(1)], log) };
    expect(await handoff(env, f.s, "/k", false)).toBe("svc stale — FAILED to start the waiter (no pid), nothing will restart it");
  });
});

describe("handoff while stopping (slice 7 re-review 3)", () => {
  test("after a stop began, no waiter is started (the refused holder probe is not 'no waiter')", async () => {
    // Mutant caught: handoff without the stopping check: the refused --holder probe (rc 143) read as
    // no waiter, and a new detached waiter started after ABORTED.
    const f = fixture();
    const spawned: string[][] = [];
    const env = { ...f.env, spawnDetached: async (argv: string[]) => (spawned.push(argv), 4242) };
    try {
      await killLive(1);
      expect(await handoff(env, f.s, "/k", false)).toBe("svc stale — not handed off: oupdate is stopping");
      expect(spawned).toEqual([]);
    } finally {
      resetStopping();
    }
  });
  test("realSpawnDetached itself refuses while stopping", async () => {
    // Mutant caught: realSpawnDetached unguarded (its children never enter the live set).
    const f = fixture();
    try {
      await killLive(1);
      await expect(realSpawnDetached(["/bin/bash", f.s.waiter, "/k"], f.s.restartLog)).rejects.toThrow(/stopping/);
      await Bun.sleep(200);
      expect(f.calls()).toEqual([]);
    } finally {
      resetStopping();
    }
  });
  test("a holder probe that timed out still hands off, and the note says so", async () => {
    // Mutant caught (follow-up 2): a timed-out probe (rc 124) refused as "unknown" (secure-update hands off on
    // any non-zero; the waiter's own lock makes a duplicate start safe).
    const f = fixture();
    const spawned: string[][] = [];
    const exec: Exec = async (argv, o) => (argv.includes("--holder") ? { rc: 124, out: "", err: "", timedOut: true } : realExec(argv, o));
    const env = { ...f.env, exec, spawnDetached: async (argv: string[]) => (spawned.push(argv), 4242) };
    expect(await handoff(env, f.s, "/k", false)).toBe("svc stale — restart handed to waiter (pid 4242) (holder check timed out)");
    expect(spawned).toEqual([["/bin/bash", f.s.waiter, "/k"]]);
  });
  test("a probe killed outside a stop (rc 143) hands off too: only a stop refuses", async () => {
    const f = fixture();
    const spawned: string[][] = [];
    const exec: Exec = async (argv, o) => (argv.includes("--holder") ? { rc: 143, out: "", err: "" } : realExec(argv, o));
    const env = { ...f.env, exec, spawnDetached: async (argv: string[]) => (spawned.push(argv), 4242) };
    expect(await handoff(env, f.s, "/k", false)).toBe("svc stale — restart handed to waiter (pid 4242)");
    expect(spawned).toHaveLength(1);
  });
  test("a stop that begins during the holder probe starts nothing", async () => {
    // Mutant caught (follow-up 4): the post-probe stopping check removed (the probe killed by the stop read as
    // "no waiter", and a waiter started after ABORTED).
    const f = fixture();
    const spawned: string[][] = [];
    const exec: Exec = async (argv, o) => {
      if (!argv.includes("--holder")) return realExec(argv, o);
      await killLive(1);
      return { rc: 143, out: "", err: "" };
    };
    const env = { ...f.env, exec, spawnDetached: async (argv: string[]) => (spawned.push(argv), 4242) };
    try {
      expect(await handoff(env, f.s, "/k", false)).toBe("svc stale — not handed off: oupdate is stopping");
      expect(spawned).toEqual([]);
    } finally {
      resetStopping();
    }
  });
  test("the holder probe's timeout is injectable (default 30 s)", async () => {
    // Mutant caught: a fixed 30 s bound (the probe timeout equalled the test timeout).
    const f = fixture();
    const seen: (number | undefined)[] = [];
    const exec: Exec = async (argv, o) => (argv.includes("--holder") && seen.push(o?.timeoutMs), { rc: 0, out: "1\n", err: "" });
    await handoff({ ...f.env, exec }, f.s, "/k", false, { holderTimeoutMs: 250 });
    await handoff({ ...f.env, exec }, f.s, "/k", false);
    expect(seen).toEqual([250, 30_000]);
  });
});

describe("waiterReport", () => {
  test("recovers a leftover drain, then surfaces and clears the last outcome", async () => {
    const f = fixture();
    writeFileSync(f.s.outcomeFile, "2026-09-29 07:02 restarted onto new keg (was HEAD-old)\n");
    expect(await waiterReport(f.env, f.s, false)).toBe("svc waiter: 2026-09-29 07:02 restarted onto new keg (was HEAD-old)");
    expect(f.calls()).toEqual(["recovered"]);
    expect(existsSync(f.s.outcomeFile)).toBe(false);
  });
  test("an unreadable outcome reads as empty, is still removed, and never throws", async () => {
    const f = fixture();
    writeFileSync(f.s.outcomeFile, "x\n");
    const env = { ...f.env, readFile: async () => { throw new Error("EACCES"); } };
    expect(await waiterReport(env, f.s, false)).toBe("svc waiter: ");
    expect(existsSync(f.s.outcomeFile)).toBe(false);
  });
  test("several notes are joined with '; '", async () => {
    const f = fixture();
    writeFileSync(join(f.dir, "recover-fails"), "");
    writeFileSync(f.s.outcomeFile, "done\n");
    expect(await waiterReport(f.env, f.s, false)).toBe("svc waiter: FAILED to recover a leftover drain; svc waiter: done");
  });
  test("a recover that fails is reported", async () => {
    const f = fixture();
    writeFileSync(join(f.dir, "recover-fails"), "");
    expect(await waiterReport(f.env, f.s, false)).toBe("svc waiter: FAILED to recover a leftover drain");
  });
  test("hold: every run reports it, in words the fleet digest does not count as trouble", async () => {
    const f = fixture();
    writeFileSync(f.s.holdFile, "");
    const note = await waiterReport(f.env, f.s, false);
    expect(note).toMatch(/^svc on hold since \d{4}-\d{2}-\d{2} — not restarted; release: rm .*\/svc-hold$/);
    expect(note.replace(f.s.holdFile, "/home.test/Library/Logs/oupdate/svc-hold")).not.toMatch(TROUBLE_RE);
    expect("svc waiter: 2026-10-04 07:02 held: svc on hold — not restarting").not.toMatch(TROUBLE_RE);
    expect("restarted: svc(on hold, not restarted)").not.toMatch(TROUBLE_RE);
  });
  test("a hold removed between the check and its date still gets a note, never a thrown error", async () => {
    const f = fixture();
    writeFileSync(f.s.holdFile, "");
    const env = { ...f.env, mtimeDay: async () => { throw new Error("ENOENT"); } };
    expect(await waiterReport(env, f.s, false)).toBe(`svc on hold — not restarted; release: rm ${f.s.holdFile}`);
  });
  test("a dry run reports nothing and runs nothing", async () => {
    const f = fixture();
    writeFileSync(f.s.outcomeFile, "x\n");
    expect(await waiterReport(f.env, f.s, true)).toBe("");
    expect(f.calls()).toEqual([]);
    expect(existsSync(f.s.outcomeFile)).toBe(true);
  });
});

describe("staleKegCheck with the real handoff", () => {
  test("a stale deferred service is handed to the waiter, never kickstarted, sudo'd or alarmed", async () => {
    const f = fixture();
    const cellar = "/brew/Cellar";
    const calls: string[] = [];
    const exec: Exec = async (argv) => {
      calls.push(argv.join(" "));
      if (argv[0] === "/usr/sbin/lsof") return { rc: 0, out: `python 30 u txt REG 1,4 100 200 ${cellar}/svc/HEAD-old/libexec/bin/python\n`, err: "" };
      if (argv[0] === "brew") return { rc: 0, out: `${cellar}\n`, err: "" };
      if (argv[0] === "ps") return { rc: 0, out: argv[2] === "comm=" ? "svc-server\n" : "1\n", err: "" };
      return { rc: 0, out: "", err: "" };
    };
    const env: KegEnv = { exec, isDir: async (p) => p === cellar, exists: async () => false, listDir: async () => [], home: "/home.test", uid: 501 };
    const notices: string[] = [];
    const v = await staleKegCheck(env, {
      brew: "brew", lsof: "/usr/sbin/lsof", dryRun: false, host: "fixture", notify: (t) => void notices.push(t), deferred: ["svc"],
      handoff: (keg) => handoff(f.env, f.s, keg, false), trackStuck: () => [],
    });
    expect(await f.waitForCalls()).toEqual([`waiter ${cellar}/svc/HEAD-old`]);
    expect(v.note).toMatch(/^svc stale — restart handed to waiter \(pid \d+\)$/);
    expect(calls.some((c) => c.startsWith("sudo") || c.includes("launchctl"))).toBe(false);
    expect(notices).toEqual([]);
  });
});

// OUP-b10: the stale-owner waiter (owner-waiter.ts). Every launchctl, lsof and probe call is a fake.
describe("owner waiter", () => {
  const Q = "/state.test/owner-restarts";
  const CELLAR = "/brew/Cellar";
  const KEG = `${CELLAR}/bun/1.0_old`;
  const maps = (pid: string, keg: string) => `bun ${pid} u txt REG 1,4 1 2 ${keg}/bin/bun\n`;
  const printOut = (pid: string | undefined, state = "running", path = "/home.test/Library/LaunchAgents/org.example.svc.plist") =>
    `gui/501/org.example.svc = {\n\tactive count = 1\n\tpath = ${path}\n\tstate = ${state}\n${pid ? `\tpid = ${pid}\n` : ""}\tendpoints = {\n\t\tpid = 1\n\t}\n}\n`;
  const item = (over: Partial<QueuedOwner> = {}): QueuedOwner => ({ label: "org.example.svc", target: "gui/501/org.example.svc", pid: "20", keg: KEG, ...over });

  interface Script {
    /** Successive ESTABLISHED answers for the default probe: true = a connection. */
    busy?: boolean[];
    /** Per target: pid before and after the kickstart (undefined: not running). */
    pids?: Record<string, [string | undefined, string | undefined]>;
    /** pid → the keg dir its maps show (default the new keg). */
    kegOf?: Record<string, string>;
    probeRc?: number[];
    kickRc?: number;
    http?: number;
    lockHeld?: boolean;
    /** Successive takeLock answers (overrides lockHeld). */
    lockSeq?: boolean[];
    files?: Record<string, string>;
    /** Per target: successive pids launchd shows before the kickstart (the last repeats). */
    printSeq?: Record<string, (string | undefined)[]>;
    /** Other processes on the host: pid → the keg dir they map. lsof lists them too unless -a ANDs -p in. */
    others?: Record<string, string>;
    bootstrapRc?: number;
    /** The kickstart throws: the waiter dies mid-restart. */
    kickThrows?: boolean;
    /** Called the first time the waiter finds the queue empty (an apply run queuing right then). */
    onEmptyQueue?: () => void;
  }
  function owEnv(s: Script = {}) {
    const calls: string[] = [];
    const logs: string[] = [];
    const files = new Map(Object.entries(s.files ?? {}));
    const busy = [...(s.busy ?? [])];
    const probe = [...(s.probeRc ?? [])];
    const locks = [...(s.lockSeq ?? [])];
    const seq = Object.fromEntries(Object.entries(s.printSeq ?? {}).map(([k, v]) => [k, [...v]]));
    const kicked = new Set<string>();
    let emptyHook = s.onEmptyQueue;
    let t = 0;
    let released = false;
    const exec: Exec = async (argv) => {
      const line = argv.join(" ");
      calls.push(line);
      if (argv[0] === "launchctl" && argv[1] === "print") {
        const target = argv[2]!;
        const [before, after] = s.pids?.[target] ?? ["20", "30"];
        let pid = kicked.has(target) ? after : before;
        const q = seq[target];
        if (!kicked.has(target) && q?.length) pid = q.length > 1 ? q.shift() : q[0];
        return { rc: 0, out: printOut(pid, pid ? "running" : "not running"), err: "" };
      }
      if (line.includes("launchctl bootout")) {
        kicked.add(argv.at(-1)!);
        return { rc: 0, out: "", err: "" };
      }
      if (line.includes("launchctl bootstrap")) return { rc: s.bootstrapRc ?? 0, out: "", err: "" };
      if (line.includes("kickstart -k")) {
        if (s.kickThrows) throw new Error("waiter killed mid-restart");
        kicked.add(argv.at(-1)!);
        return { rc: s.kickRc ?? 0, out: "", err: "" };
      }
      if (argv[0] === "/usr/sbin/lsof" && argv.includes("-iTCP")) {
        const b = busy.length > 1 ? busy.shift()! : (busy[0] ?? false);
        return b ? { rc: 0, out: "COMMAND PID\nbun 20 u IPv4 TCP 127.0.0.1:8080->127.0.0.1:5000 (ESTABLISHED)\n", err: "" } : { rc: 1, out: "", err: "" };
      }
      if (argv[0] === "/usr/sbin/lsof") {
        // As real lsof: without -a the -p and -d selections are ORed, so every process's maps come back.
        const pid = argv[argv.indexOf("-p") + 1]!;
        const mine = maps(pid, s.kegOf?.[pid] ?? `${CELLAR}/bun/1.1`);
        if (argv.includes("-a")) return { rc: 0, out: mine, err: "" };
        return { rc: 0, out: mine + Object.entries(s.others ?? {}).map(([p, k]) => maps(p, k)).join(""), err: "" };
      }
      if (argv[0] === "/opt/svc.test/idle") return { rc: probe.length > 1 ? probe.shift()! : (probe[0] ?? 0), out: "", err: "" };
      return { rc: 99, out: "", err: `UNEXPECTED ${line}` };
    };
    const env: OwnerWaiterEnv = {
      exec,
      readFile: async (p) => files.get(p),
      writeFile: async (p, text) => void files.set(p, text),
      remove: async (p) => void files.delete(p),
      listDir: async (d) => {
        const names = [...files.keys()].filter((k) => k.startsWith(`${d}/`)).map((k) => k.slice(d.length + 1));
        if (d === `${Q}/queue` && !names.length && emptyHook) {
          const h = emptyHook;
          emptyHook = undefined;
          h();
        }
        return names;
      },
      isDir: async (p) => p === `${CELLAR}/bun/1.1`,
      now: () => t,
      sleep: async (ms) => void (t += ms),
      takeLock: async () => (locks.length ? locks.shift()! : !s.lockHeld),
      releaseLock: async () => void (released = true),
      httpStatus: async (url) => (calls.push(`GET ${url}`), s.http ?? 200),
      log: (l) => void logs.push(l),
    };
    const queue = (...qs: QueuedOwner[]) => {
      for (const q of qs) files.set(`${Q}/queue/${encodeURIComponent(q.target)}.json`, JSON.stringify(q));
    };
    const outcome = () => [...files.keys()].filter((k) => k.startsWith(`${Q}/outcomes/`)).sort().map((k) => files.get(k)!.trim());
    return { env, calls, logs, files, queue, outcome, released: () => released, clock: () => t };
  }
  /** An outcome file as the waiter writes one. */
  const outcomeFile = (n: number, text: string): [string, string] => [`${Q}/outcomes/${String(n).padStart(15, "0")}-1-${n}.txt`, `${text}\n`];
  const opts = { dir: Q, lsof: "/usr/sbin/lsof" };
  const reportEnv = (files: Map<string, string>) => ({
    readFile: async (p: string) => files.get(p),
    remove: async (p: string) => void files.delete(p),
    listDir: async (d: string) => [...files.keys()].filter((k) => k.startsWith(`${d}/`)).map((k) => k.slice(d.length + 1)),
  });

  test("matchOwner: a whole-label glob, * and ? only, dots literal", () => {
    const owners = [{ match: "org.ofleet.*" }, { match: "com.x.svc?" }];
    expect(matchOwner(owners, "org.ofleet.ohost")).toEqual({ match: "org.ofleet.*" });
    expect(matchOwner(owners, "com.x.svc2")).toEqual({ match: "com.x.svc?" });
    expect(matchOwner(owners, "orgXofleet.ohost")).toBeUndefined();
    expect(matchOwner(owners, "com.x.svc")).toBeUndefined();
    expect(matchOwner(owners, "a.org.ofleet.x")).toBeUndefined();
    expect(matchOwner(undefined, "org.ofleet.ohost")).toBeUndefined();
  });

  test("queueOwners writes one file per job and starts the waiter detached", async () => {
    const written = new Map<string, string>();
    const spawned: string[][] = [];
    const env = { readFile: async (p: string) => written.get(p), writeFile: async (p: string, t: string) => void written.set(p, t), spawnDetached: async (a: string[]) => (spawned.push(a), 4242) };
    const note = await queueOwners(env, Q, [item(), item({ label: "org.example.b", target: "system/org.example.b", pid: "40" })], ["/brew/bin/bun", "/app/src/cli.ts", "host", "--stale-owners-waiter"], "/state.test/restart.log");
    expect(note).toBe("owner restart waiter started (pid 4242) for org.example.svc org.example.b");
    expect([...written.keys()].sort()).toEqual([`${Q}/queue/gui%2F501%2Forg.example.svc.json`, `${Q}/queue/system%2Forg.example.b.json`]);
    expect(JSON.parse(written.get(`${Q}/queue/system%2Forg.example.b.json`)!)).toEqual(item({ label: "org.example.b", target: "system/org.example.b", pid: "40" }));
    expect(spawned).toEqual([["/brew/bin/bun", "/app/src/cli.ts", "host", "--stale-owners-waiter"]]);
  });
  test("queueOwners with no waiter command, or a spawn that fails, says FAILED", async () => {
    const env = { readFile: async () => undefined, writeFile: async () => {}, spawnDetached: async (): Promise<number> => Promise.reject(new Error("EAGAIN")) };
    expect(await queueOwners(env, Q, [item()], undefined, "/l")).toMatch(/^owner restart waiter FAILED: no waiter command here/);
    expect(await queueOwners(env, Q, [item()], ["/bun"], "/l")).toBe("owner restart waiter FAILED to start (EAGAIN), org.example.svc queued");
    expect(await queueOwners(env, Q, [], ["/bun"], "/l")).toBe("");
  });

  test("the report shows and removes the last outcome, reads busy labels, and names failed labels every run", async () => {
    const files = new Map([
      outcomeFile(1, "restarted org.example.a"), outcomeFile(2, "held: busy org.example.b (busy past 120 min)"), outcomeFile(3, "FAILED: org.example.c not healthy after restart (x) — rollback: y"),
      [`${Q}/failed`, "org.example.c\n"],
    ]);
    const env = reportEnv(files);
    const r = await ownerWaiterReport(env, Q, false);
    expect(r.note).toBe(`owner restart waiter: restarted org.example.a, held: busy org.example.b (busy past 120 min), FAILED: org.example.c not healthy after restart (x) — rollback: y; owner restart FAILED earlier for org.example.c — not retried, retry: rm ${Q}/failed`);
    // Split as the summary parser (su-log.ts) splits the brew line: no part starts "FAILED:" (it would read as failed packages).
    expect(r.note.split(";").filter((p) => /^\s*FAILED:/.test(p))).toEqual([]);
    expect(r.note).not.toMatch(/stale/i);
    expect([...r.busy]).toEqual(["org.example.b"]);
    expect([...r.failed]).toEqual(["org.example.c"]);
    expect([...files.keys()].filter((k) => k.includes("/outcomes/"))).toEqual([]);
    expect(files.has(`${Q}/failed`)).toBe(true);
    const again = await ownerWaiterReport(env, Q, false);
    expect(again.note).toBe(`owner restart FAILED earlier for org.example.c — not retried, retry: rm ${Q}/failed`);
  });
  test("a clean outcome carries no trouble word; a dry run leaves the outcome in place", async () => {
    const files = new Map([outcomeFile(1, "restarted org.example.a")]);
    const r = await ownerWaiterReport(reportEnv(files), Q, true);
    expect(r.note).toBe("owner restart waiter: restarted org.example.a");
    expect(r.note).not.toMatch(TROUBLE_RE);
    expect(files.size).toBe(1);
  });
  test("review 6: an outcome the waiter writes while the report reads is kept for the next report, never lost", async () => {
    const files = new Map([outcomeFile(1, "restarted org.example.a")]);
    const env = reportEnv(files);
    const read = env.readFile;
    let wrote = false;
    env.readFile = async (p) => {
      const t = await read(p);
      // The waiter finishes its next job between the report's read and its remove.
      if (p.includes("/outcomes/") && !wrote) {
        wrote = true;
        files.set(...outcomeFile(2, "restarted org.example.b"));
      }
      return t;
    };
    expect((await ownerWaiterReport(env, Q, false)).note).toBe("owner restart waiter: restarted org.example.a");
    expect((await ownerWaiterReport(env, Q, false)).note).toBe("owner restart waiter: restarted org.example.b");
  });

  describe("re-review 1: the lock is a kernel flock, never a file to reclaim", () => {
    let k = 0;
    const fresh = () => {
      const d = join(root, `flock-${++k}`);
      mkdirSync(d, { recursive: true });
      return { d, lock: join(d, "lock") };
    };
    test("taken through the flock seam: LOCK_EX|LOCK_NB on the lock file's fd, the file created and never deleted, pid + start time in the info file", async () => {
      const { d, lock } = fresh();
      const seen: { fd: number; op: number }[] = [];
      const lk = makeFlockLock({ flock: (fd, op) => (seen.push({ fd, op }), 0), pid: 4242, startTime: () => "Mon Oct 26 07:00:00 2026" });
      expect(await lk.take(lock)).toBe(true);
      expect(seen).toHaveLength(1);
      expect(seen[0]!.op).toBe(2 | 4);
      expect(readFileSync(`${lock}.info`, "utf8")).toBe("4242 Mon Oct 26 07:00:00 2026\n");
      await lk.release(lock);
      expect(existsSync(lock)).toBe(true);
      expect(readdirSync(d).sort()).toEqual(["lock", "lock.info"]);
    });
    test("a flock refused (another holder) is false, its fd closed, the info file untouched", async () => {
      const { lock } = fresh();
      writeFileSync(`${lock}.info`, "7 holder\n");
      const lk = makeFlockLock({ flock: () => -1, pid: 1, startTime: () => "x" });
      expect(await lk.take(lock)).toBe(false);
      expect(readFileSync(`${lock}.info`, "utf8")).toBe("7 holder\n");
    });
    test.if(process.platform === "darwin")("real flock across processes: refused while the holder lives, free once it exits without unlocking", async () => {
      const { d, lock } = fresh();
      const mod = join(import.meta.dir, "../../src/apply/owner-waiter.ts");
      const child = join(d, "child.ts");
      // Takes the lock, prints the answer; with "hold" it then waits to be killed, never releasing.
      writeFileSync(child, `import { realTakeLock } from ${JSON.stringify(mod)};\nconst ok = await realTakeLock(${JSON.stringify(lock)});\nconsole.log(ok ? "took" : "refused");\nif (process.argv[2] === "hold") await new Promise(() => {});\nprocess.exit(0);\n`);
      const holder = Bun.spawn(["bun", child, "hold"], { stdout: "pipe", stderr: "inherit" });
      const reader = holder.stdout.getReader();
      const first = new TextDecoder().decode((await reader.read()).value);
      expect(first.trim()).toBe("took");
      const second = Bun.spawnSync(["bun", child]);
      expect(second.stdout.toString().trim()).toBe("refused");
      holder.kill("SIGKILL");
      await holder.exited;
      const third = Bun.spawnSync(["bun", child]);
      expect(third.stdout.toString().trim()).toBe("took");
    }, 30_000); // three bun starts
  });
  test("review 1: launchd replaced the process during the idle wait: the new pid is checked again before the kickstart", async () => {
    const t = "gui/501/org.example.svc";
    // Still on the deleted keg: idle is waited for again, on the new pid.
    const a = owEnv({ printSeq: { [t]: ["20", "21"] }, kegOf: { "21": KEG } });
    a.queue(item());
    expect(await runOwnerWaiter(a.env, opts)).toBe(0);
    const kick = a.calls.indexOf(`launchctl kickstart -k ${t}`);
    const before = a.calls.slice(0, kick);
    expect(before.filter((c) => c.includes("-p 21 -iTCP")).length).toBeGreaterThan(0);
    expect(before.lastIndexOf(`launchctl print ${t}`)).toBeGreaterThan(before.findIndex((c) => c.includes("-p 21 -iTCP")));
    // On the new keg already: dropped, never kickstarted.
    const b = owEnv({ printSeq: { [t]: ["20", "21"] } });
    b.queue(item());
    expect(await runOwnerWaiter(b.env, opts)).toBe(0);
    expect(b.calls.some((c) => c.includes("kickstart"))).toBe(false);
    expect(b.outcome()).toEqual(["already on the new keg: org.example.svc"]);
  });
  test("review 2: health reads only the restarted pid's maps (lsof -a), never another process's deleted keg", async () => {
    const w = owEnv({ others: { "40": KEG } });
    w.queue(item());
    expect(await runOwnerWaiter(w.env, { ...opts, idleMs: 0 })).toBe(0);
    expect(w.outcome()).toEqual(["restarted org.example.svc"]);
    expect(w.calls).toContain("/usr/sbin/lsof -nP -w -a -p 30 -d txt,mem");
  });
  test("review 4: a waiter that dies mid-restart leaves a record; the next waiter marks it FAILED and never restarts it again", async () => {
    const w = owEnv({ kickThrows: true });
    w.queue(item());
    await expect(runOwnerWaiter(w.env, { ...opts, idleMs: 0 })).rejects.toThrow("waiter killed mid-restart");
    expect(w.files.has(`${Q}/inprogress.json`)).toBe(true);
    // The next run queues it again (still stale); the next waiter finds the record first.
    const next = owEnv({ files: Object.fromEntries(w.files) });
    const other = item({ label: "org.example.z", target: "gui/501/org.example.z" });
    next.queue(item(), other);
    // re-review 2: as a failure on the normal path, the interrupted one stops the queue for this run;
    // the rest stay queued (the next run reports them waiting), nothing else is restarted.
    expect(await runOwnerWaiter(next.env, { ...opts, idleMs: 0 })).toBe(1);
    expect(next.calls.some((c) => c.includes("kickstart"))).toBe(false);
    expect(next.files.has(`${Q}/queue/${encodeURIComponent(other.target)}.json`)).toBe(true);
    expect(next.outcome()).toEqual(["FAILED: org.example.svc restart interrupted (the waiter stopped mid-restart) — rollback: launchctl bootout gui/501/org.example.svc && launchctl bootstrap gui/501 /home.test/Library/LaunchAgents/org.example.svc.plist"]);
    expect(next.files.get(`${Q}/failed`)).toBe("org.example.svc\n");
    expect(next.files.has(`${Q}/inprogress.json`)).toBe(false);
  });
  test("review 4: a waiter stopped before the restart (still waiting for idle) puts the job back, it is not a failure", async () => {
    const w = owEnv({ files: { [`${Q}/inprogress.json`]: JSON.stringify({ phase: "waiting", item: item() }) } });
    expect(await runOwnerWaiter(w.env, opts)).toBe(0);
    expect(w.files.has(`${Q}/failed`)).toBe(false);
    expect(w.outcome()).toEqual(["restarted org.example.svc"]);
  });
  test("review 7: work queued while the waiter is finding the queue empty is not stranded", async () => {
    // The apply run queues a job right as the waiter sees an empty queue; its own waiter exits on the lock.
    const hooked = owEnv({ lockSeq: [true, true], onEmptyQueue: () => hooked.queue(item()) });
    expect(await runOwnerWaiter(hooked.env, opts)).toBe(0);
    expect(hooked.calls).toContain("launchctl kickstart -k gui/501/org.example.svc");
    expect(hooked.outcome()).toEqual(["restarted org.example.svc"]);
  });
  describe("restart mode bootstrap: bootout then bootstrap, never kickstart -k", () => {
    const T = "system/org.ofleet.ohost";
    const PLIST = "/Library/LaunchDaemons/org.ofleet.ohost.plist";
    const ohost = (over: Partial<QueuedOwner> = {}) => item({ label: "org.ofleet.ohost", target: T, restart: { bootstrap: PLIST }, ...over });
    test("a system job: sudo -n launchctl bootout <target>, then sudo -n launchctl bootstrap system <plist>, then health", async () => {
      const w = owEnv({ pids: { [T]: ["20", "31"] } });
      w.queue(ohost());
      expect(await runOwnerWaiter(w.env, { ...opts, idleMs: 0 })).toBe(0);
      expect(w.calls.filter((c) => c.includes("launchctl b") || c.includes("kickstart"))).toEqual([`sudo -n launchctl bootout ${T}`, `sudo -n launchctl bootstrap system ${PLIST}`]);
      expect(w.outcome()).toEqual(["restarted org.ofleet.ohost"]);
    });
    test("a gui job runs without sudo, in its gui domain", async () => {
      const g = "gui/501/org.example.svc";
      const w = owEnv();
      w.queue(item({ restart: { bootstrap: "/home.test/Library/LaunchAgents/org.example.svc.plist" } }));
      expect(await runOwnerWaiter(w.env, { ...opts, idleMs: 0 })).toBe(0);
      expect(w.calls.filter((c) => c.includes("launchctl b"))).toEqual([`launchctl bootout ${g}`, "launchctl bootstrap gui/501 /home.test/Library/LaunchAgents/org.example.svc.plist"]);
    });
    test("a failed bootstrap is FAILED with the bootstrap-again note", async () => {
      const w = owEnv({ bootstrapRc: 5 });
      w.queue(ohost());
      expect(await runOwnerWaiter(w.env, { ...opts, idleMs: 0 })).toBe(1);
      expect(w.outcome()[0]).toBe(`FAILED: org.ofleet.ohost not healthy after restart (bootstrap rc 5) — bootstrap again: sudo launchctl bootstrap system ${PLIST}`);
      expect(w.files.get(`${Q}/failed`)).toBe("org.ofleet.ohost\n");
    });
    test("healthWithinSec bounds the health wait (default 60 s)", async () => {
      const a = owEnv({ pids: { [T]: ["20", "20"] } });
      a.queue(ohost({ healthWithinSec: 5 }));
      expect(await runOwnerWaiter(a.env, { ...opts, idleMs: 0 })).toBe(1);
      expect(a.clock()).toBeGreaterThanOrEqual(5_000);
      expect(a.clock()).toBeLessThan(10_000);
      const b = owEnv({ pids: { [T]: ["20", "20"] } });
      b.queue(ohost());
      expect(await runOwnerWaiter(b.env, { ...opts, idleMs: 0 })).toBe(1);
      expect(b.clock()).toBeGreaterThanOrEqual(60_000);
      expect(b.clock()).toBeLessThan(65_000);
    });
  });
  test("another waiter holds the lock: nothing runs, the queue is kept", async () => {
    const w = owEnv({ lockHeld: true });
    w.queue(item());
    expect(await runOwnerWaiter(w.env, opts)).toBe(0);
    expect(w.calls).toEqual([]);
    expect(w.files.size).toBe(1);
  });
  test("default probe: waits for 60 s with no ESTABLISHED TCP, then kickstarts the gui job and checks it is healthy", async () => {
    const w = owEnv({ busy: [true, true, false] });
    w.queue(item());
    expect(await runOwnerWaiter(w.env, opts)).toBe(0);
    expect(w.outcome()).toEqual(["restarted org.example.svc"]);
    const kick = w.calls.indexOf("launchctl kickstart -k gui/501/org.example.svc");
    expect(kick).toBeGreaterThan(0);
    // Idle sampled for the full minute before the kickstart.
    expect(w.calls.slice(0, kick).filter((c) => c.includes("ESTABLISHED")).length).toBeGreaterThanOrEqual(2 + 60_000 / 3_000);
    expect(w.clock()).toBeGreaterThanOrEqual(60_000);
    expect(w.calls.slice(kick)).toContain("/usr/sbin/lsof -nP -w -a -p 30 -d txt,mem");
    expect(w.calls.some((c) => c.startsWith("sudo"))).toBe(false);
    expect(w.released()).toBe(true);
    expect([...w.files.keys()].filter((k) => k.includes("/queue/"))).toEqual([]);
  });
  test("a probe argv decides idle; a system job is kickstarted through sudo -n; the health URL is checked", async () => {
    const t = "system/org.example.svc";
    const w = owEnv({ probeRc: [1, 1, 0], pids: { [t]: ["20", "31"] } });
    w.queue(item({ target: t, probe: ["/opt/svc.test/idle"], health: "http://127.0.0.1:8080/health" }));
    expect(await runOwnerWaiter(w.env, opts)).toBe(0);
    expect(w.calls.filter((c) => c === "/opt/svc.test/idle")).toHaveLength(3);
    expect(w.calls.some((c) => c.includes("ESTABLISHED"))).toBe(false);
    expect(w.calls).toContain(`sudo -n launchctl kickstart -k ${t}`);
    expect(w.calls).toContain("GET http://127.0.0.1:8080/health");
    expect(w.outcome()).toEqual(["restarted org.example.svc"]);
  });
  test("busy past the bound is held, never restarted; the next job still goes", async () => {
    const w = owEnv({ probeRc: [1] });
    w.queue(item({ probe: ["/opt/svc.test/idle"] }), item({ label: "org.example.z", target: "gui/501/org.example.z" }));
    expect(await runOwnerWaiter(w.env, { ...opts, busyBoundMs: 30_000, idleMs: 10_000 })).toBe(0);
    expect(w.calls).not.toContain("launchctl kickstart -k gui/501/org.example.svc");
    expect(w.calls).toContain("launchctl kickstart -k gui/501/org.example.z");
    expect(w.outcome()).toEqual(["held: busy org.example.svc (busy past 1 min)", "restarted org.example.z"]);
  });
  test("not healthy after the restart: FAILED with the bootout/bootstrap rollback, the label marked failed, the queue stopped", async () => {
    // The pid never changes: the restart did not take.
    const w = owEnv({ pids: { "gui/501/org.example.svc": ["20", "20"] } });
    w.queue(item(), item({ label: "org.example.z", target: "gui/501/org.example.z" }));
    expect(await runOwnerWaiter(w.env, { ...opts, idleMs: 0 })).toBe(1);
    // No ";" in an outcome: the summary's parser splits the brew line there, and a part starting "FAILED:" reads as failed packages.
    expect(w.outcome()[0]).toBe("FAILED: org.example.svc not healthy after restart (state running, pid 20) — rollback: launchctl bootout gui/501/org.example.svc && launchctl bootstrap gui/501 /home.test/Library/LaunchAgents/org.example.svc.plist");
    expect(w.outcome()[1]).toBe("not tried: org.example.z (queue stopped after org.example.svc failed)");
    expect(w.files.get(`${Q}/failed`)).toBe("org.example.svc\n");
    expect(w.calls).not.toContain("launchctl kickstart -k gui/501/org.example.z");
    expect([...w.files.keys()].filter((k) => k.includes("/queue/"))).toEqual([]);
    expect(w.released()).toBe(true);
  });
  test("a health URL that does not answer 200, or a new pid still on a deleted keg, is FAILED", async () => {
    const a = owEnv({ http: 503 });
    a.queue(item({ health: "http://127.0.0.1:8080/health" }));
    expect(await runOwnerWaiter(a.env, { ...opts, idleMs: 0 })).toBe(1);
    expect(a.outcome()[0]).toStartWith("FAILED: org.example.svc not healthy after restart (health http://127.0.0.1:8080/health answered 503)");
    const b = owEnv({ kegOf: { "30": KEG } });
    b.queue(item());
    expect(await runOwnerWaiter(b.env, { ...opts, idleMs: 0 })).toBe(1);
    expect(b.outcome()[0]).toStartWith("FAILED: org.example.svc not healthy after restart (pid 30 still maps a deleted keg)");
  });
  test("a job already on the new keg is not restarted; a failed label is skipped; an unloaded job is held", async () => {
    const t = "gui/501/org.example.svc";
    const a = owEnv({ pids: { [t]: ["25", "26"] } });
    a.queue(item());
    expect(await runOwnerWaiter(a.env, opts)).toBe(0);
    expect(a.outcome()).toEqual(["already on the new keg: org.example.svc"]);
    expect(a.calls.some((c) => c.includes("kickstart"))).toBe(false);
    const b = owEnv({ files: { [`${Q}/failed`]: "org.example.svc\n" } });
    b.queue(item());
    expect(await runOwnerWaiter(b.env, opts)).toBe(0);
    expect(b.calls).toEqual([]);
    const c = owEnv({ pids: { [t]: [undefined, undefined] } });
    c.queue(item());
    expect(await runOwnerWaiter(c.env, opts)).toBe(0);
    expect(c.outcome()).toEqual(["held: org.example.svc not running"]);
    expect(c.calls.some((x) => x.includes("kickstart"))).toBe(false);
  });
});
