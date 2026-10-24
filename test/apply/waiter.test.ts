// Ported from the previous updater's waiter cases (test/port/07): the handoff of a deferred service to its
// idle waiter, and the waiter report. The waiter is a real script started detached.
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { killLive, realExec, resetStopping, type Exec } from "../../src/apply/exec.ts";
import { staleKegCheck, type KegEnv } from "../../src/apply/kegs.ts";
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
    // Mutant caught (follow-up 2): a timed-out probe (rc 124) refused as "unknown" (the previous updater hands off on
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
  test("hold: every run reports it, in words a status reader does not count as trouble", async () => {
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
