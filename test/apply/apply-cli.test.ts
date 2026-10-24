// `oupdate host --apply | --dry-run | --gatekeeper-approve | --gatekeeper-revert` (slice 7), and the
// Exec timeout the run relies on.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readdirSync } from "node:fs";
import { closeRc, isStopping, KILL_GRACE_MS, killLive, liveGroups, realExec, resetStopping, type Exec } from "../../src/apply/exec.ts";
import { applyMain, logPath, parseHostCommand } from "../../src/host/cli.ts";
import { parseSuSummary } from "../../src/host/prev-log.ts";
import { fakeHost } from "./host-fixture.ts";

const root = mkdtempSync(join(tmpdir(), "oupdate-apply-cli-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
function config(apply: Record<string, unknown>) {
  const dir = join(root, `c${++n}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify({ apply: { stateDir: join(dir, "state"), npm: null, ...apply } }));
  return { dir, path };
}

describe("parseHostCommand", () => {
  test("--report-only stays the shadow report", () => {
    expect(parseHostCommand(["--report-only", "--state", "s", "--host", "h", "--prev-log", "l"])).toEqual({ mode: "report", args: { host: "h", state: "s", prevLog: "l" } });
  });
  test("--apply, with --dry-run, --config and --host", () => {
    expect(parseHostCommand(["--apply", "--dry-run", "--config", "/c.json", "--host", "hosta"])).toEqual({ mode: "apply", config: "/c.json", dryRun: true, host: "hosta" });
    const d = parseHostCommand(["--apply"]);
    expect(d).toMatchObject({ mode: "apply", dryRun: false });
    expect((d as { config: string }).config.endsWith(join(".config", "oupdate", "config.json"))).toBe(true);
  });
  test("the CLI exposes --gatekeeper-approve and --gatekeeper-revert", () => {
    expect(parseHostCommand(["--gatekeeper-approve", "tool", "--config", "/c.json"])).toEqual({ mode: "gatekeeper", action: "approve", cask: "tool", config: "/c.json" });
    expect(parseHostCommand(["--gatekeeper-revert", "tool", "--config", "/c.json"])).toEqual({ mode: "gatekeeper", action: "revert", cask: "tool", config: "/c.json" });
  });
  test("mistakes are errors", () => {
    expect(() => parseHostCommand(["--apply", "--report-only"])).toThrow(/one of/);
    expect(() => parseHostCommand(["--dry-run", "--report-only", "--state", "s"])).toThrow(/--dry-run goes with --apply/);
    expect(() => parseHostCommand(["--gatekeeper-approve"])).toThrow(/needs a value/);
    expect(() => parseHostCommand(["--gatekeeper-revert", "tool", "--dry-run"])).toThrow(/--dry-run goes with --apply/);
    expect(() => parseHostCommand(["--apply", "--bogus"])).toThrow(/unknown flag --bogus/);
  });
});

describe("applyMain", () => {
  test("--gatekeeper-revert through the real CLI: nothing restored is exit 1", () => {
    // Mutant caught (14): the one-offs always exited 0.
    const c = config({ brew: "brew-not-installed" });
    const p = Bun.spawnSync(["bun", join(import.meta.dir, "../../src/cli.ts"), "host", "--gatekeeper-revert", "tool", "--config", c.path]);
    expect(p.stdout.toString()).toContain("tool: restored quarantine on 0 file(s)");
    expect(p.exitCode).toBe(1);
  });

  test("--gatekeeper-revert that restores a file is exit 0", async () => {
    const c = config({});
    const f = join(c.dir, "tool-bin");
    writeFileSync(f, "");
    mkdirSync(join(c.dir, "state"), { recursive: true });
    writeFileSync(join(c.dir, "state", "gatekeeper-release.tsv"), `2026-10-22 07:00:00\ttool\t0181;x;Homebrew Cask;y\t${f}\n`);
    const calls: string[] = [];
    const exec: Exec = async (argv) => (calls.push(argv.join(" ")), { rc: 0, out: "", err: "" });
    const r = await applyMain({ mode: "gatekeeper", action: "revert", cask: "tool", config: c.path }, { exec, fs: fakeHost().fs, out: () => {} });
    expect(r).toEqual({ text: "  tool: restored quarantine on 1 file(s)", rc: 0 });
    expect(calls).toEqual([`xattr -w com.apple.quarantine 0181;x;Homebrew Cask;y ${f}`]);
  });

  test("--gatekeeper-approve with brew unable to name its Caskroom releases nothing", async () => {
    const c = config({});
    const calls: string[] = [];
    const exec: Exec = async (argv) => (calls.push(argv.join(" ")), { rc: 1, out: "", err: "" });
    const r = await applyMain({ mode: "gatekeeper", action: "approve", cask: "tool", config: c.path }, { exec, fs: fakeHost().fs, out: () => {} });
    expect(r).toEqual({ text: "  tool: cannot resolve brew --caskroom / --prefix — nothing released", rc: 1 });
    expect(calls).toEqual(["brew --caskroom", "brew --prefix"]);
  });

  test("--apply prints the summary block, appends it to the log file, exits with the run's rc", async () => {
    const c = config({ logFile: join(root, "apply.log") });
    const h = fakeHost();
    const r = await applyMain({ mode: "apply", config: c.path, dryRun: false, host: "hosta" }, { exec: h.exec, fs: h.fs, out: () => {} });
    expect(r.text).toContain("=== hosta summary ===\n  brew: nothing to update; notify: not configured — notices were logged only\n  npm:  not managed here (apply.npm is null)");
    expect(r.rc).toBe(0);
    expect(readFileSync(join(root, "apply.log"), "utf8")).toContain("=== hosta summary ===");
    expect(existsSync(join(c.dir, "state"))).toBe(true);
  });

  test("--dry-run creates no state directory", async () => {
    const c = config({});
    const h = fakeHost();
    await applyMain({ mode: "apply", config: c.path, dryRun: true }, { exec: h.exec, fs: h.fs, out: () => {} });
    expect(existsSync(join(c.dir, "state"))).toBe(false);
  });

  test("an unreadable or invalid config is an error, not a run", async () => {
    const h = fakeHost();
    await expect(applyMain({ mode: "apply", config: join(root, "missing.json"), dryRun: true }, { exec: h.exec, fs: h.fs })).rejects.toThrow(/cannot read config/);
    const c = config({ bogus: 1 });
    await expect(applyMain({ mode: "apply", config: c.path, dryRun: true }, { exec: h.exec, fs: h.fs })).rejects.toThrow(/unknown key bogus/);
    expect(h.calls).toEqual([]);
  });
});

describe("the log file (slice 7 review)", () => {
  test("2: lines are streamed as they are made; a signal writes the ABORTED line, stops live commands and exits", async () => {
    // Mutant caught: the log written only at the end (a hung run left nothing) and no ABORTED marker.
    const log = join(root, "stream.log");
    const c = config({ logFile: log });
    let release!: () => void;
    const hang = new Promise<void>((res) => (release = res));
    let reached!: () => void;
    const atUpdate = new Promise<void>((res) => (reached = res));
    const h = fakeHost();
    const exec: Exec = async (argv, o) => {
      if (argv.join(" ") === "brew update") {
        reached();
        await hang;
        return { rc: 1, out: "", err: "" };
      }
      return h.exec(argv, o);
    };
    const handlers = new Map<string, () => void>();
    const signals = { on: (s: string, f: () => void) => handlers.set(s, f), off: (s: string) => handlers.delete(s) };
    const exits: number[] = [];
    let stopped = 0;
    const done = applyMain({ mode: "apply", config: c.path, dryRun: false, host: "hosta" }, {
      exec, fs: h.fs, out: () => {}, signals, exit: (code) => void exits.push(code), stopLive: () => void stopped++, now: new Date(2026, 9, 22, 7, 0),
    });
    await atUpdate;
    expect(readFileSync(log, "utf8")).toContain("=== oupdate-host-update hosta 2026-10-22 07:00 ===\n");
    handlers.get("SIGTERM")!();
    expect(readFileSync(log, "utf8")).toContain("=== ABORTED: oupdate-host-update on hosta got SIGTERM — this run did NOT complete ===");
    await Bun.sleep(10);
    expect(exits).toEqual([143]);
    expect(stopped).toBe(1);
    release();
    await done;
    expect(handlers.size).toBe(0);
    // The prev-log parser's aborted test: a line starting "=== ABORTED:" (in a real run, process.exit follows it).
    expect(readFileSync(log, "utf8")).toMatch(/^=== ABORTED: /m);
  });

  test("2: a crash mid-run writes the ABORTED line too", async () => {
    const log = join(root, "crash.log");
    const c = config({ logFile: log });
    const h = fakeHost();
    const fs = { ...h.fs, exists: async () => { throw new Error("disk gone"); } };
    await expect(applyMain({ mode: "apply", config: c.path, dryRun: false, host: "hosta" }, { exec: h.exec, fs, out: () => {} })).rejects.toThrow(/disk gone/);
    expect(readFileSync(log, "utf8")).toContain("=== ABORTED: oupdate-host-update on hosta exited 2 (disk gone) — this run did NOT complete ===");
  });

  test("3: a dry run and a one-off never write the dated log; a stopped dry run says STOPPED, never ABORTED", async () => {
    // Mutants caught (re-review 1): dry runs and one-offs appended to the dated file the digest and
    // the shadow read, and a dry run's Ctrl-C wrote the real "=== ABORTED: oupdate-host-update" line.
    const dir = join(root, "side");
    const c = config({ logFile: join(dir, "{date}.log") });
    const now = new Date(2026, 9, 22, 7, 0);
    const h = fakeHost();
    await applyMain({ mode: "apply", config: c.path, dryRun: true, host: "hosta" }, { exec: h.exec, fs: h.fs, out: () => {}, now });
    await applyMain({ mode: "gatekeeper", action: "revert", cask: "tool", config: c.path, host: "hosta" }, { exec: h.exec, fs: h.fs, out: () => {}, now });
    expect(existsSync(join(dir, "20261022.log"))).toBe(false);
    const dry = readFileSync(join(dir, "dry-run-20261022.log"), "utf8");
    expect(dry).toContain("=== hosta dry-run summary (nothing applied) ===");
    expect(dry).not.toContain("=== hosta summary ===");
    expect(dry).not.toMatch(/^=== (\S+-)?the previous updater /m);
    expect(parseSuSummary(dry, "hosta")).toBeNull();
    expect(readFileSync(join(dir, "gatekeeper-20261022.log"), "utf8")).toContain("tool: restored quarantine on 0 file(s)");

    const handlers = new Map<string, () => void>();
    const signals = { on: (sg: string, f: () => void) => handlers.set(sg, f), off: (sg: string) => handlers.delete(sg) };
    const exec: Exec = async (argv, o) => {
      if (argv.join(" ") === "brew --version") handlers.get("SIGINT")!();
      return h.exec(argv, o);
    };
    const exits: number[] = [];
    await applyMain({ mode: "apply", config: c.path, dryRun: true, host: "hosta" }, { exec, fs: h.fs, out: () => {}, now, signals, exit: (code) => void exits.push(code), stopLive: () => {} });
    const after = readFileSync(join(dir, "dry-run-20261022.log"), "utf8");
    expect(after).toContain("=== STOPPED: oupdate dry run on hosta got SIGINT — not a run, nothing more was done ===");
    expect(after).not.toContain("=== ABORTED");
    expect(exits).toEqual([130]);
    expect(existsSync(join(dir, "20261022.log"))).toBe(false);
  });

  test("5: a log directory that cannot be made says why; a throwing stdout still leaves the line in the file", async () => {
    // Mutants caught: a silent logBroken, and stdout written before the file (a throwing stdout lost the line).
    const blocker = join(root, "blocker");
    writeFileSync(blocker, "");
    const c1 = config({ logFile: join(blocker, "sub", "{date}.log") });
    const seen: string[] = [];
    await applyMain({ mode: "apply", config: c1.path, dryRun: false, host: "hosta" }, { exec: fakeHost().exec, fs: fakeHost().fs, out: (l) => void seen.push(l) });
    expect(seen[0]).toMatch(/^WARNING: cannot create the log directory .*blocker\/sub \(.+\) — logging to stdout only$/);
    const log = join(root, "throwing.log");
    const c2 = config({ logFile: log });
    await applyMain({ mode: "apply", config: c2.path, dryRun: false, host: "hosta" }, { exec: fakeHost().exec, fs: fakeHost().fs, out: () => { throw new Error("EPIPE"); } });
    expect(readFileSync(log, "utf8")).toContain("=== hosta summary ===");
  });

  test("4: SIGHUP on a terminal is handled like SIGTERM: ABORTED, the run stops, exit 129", async () => {
    // Mutants caught: no SIGHUP handler; a run that goes on logging (and sends its done notice) after ABORTED.
    const log = join(root, "hup.log");
    const c = config({ logFile: log, notify: ["send-notice"] });
    const handlers = new Map<string, () => void>();
    const signals = { on: (sg: string, f: () => void) => handlers.set(sg, f), off: (sg: string) => handlers.delete(sg) };
    const exits: number[] = [];
    const h = fakeHost();
    // As realExec does: nothing starts once stopping.
    const exec: Exec = async (argv, o) => {
      if (isStopping()) return { rc: 143, out: "", err: "" };
      if (argv.join(" ") === "brew --version") handlers.get("SIGHUP")!();
      return h.exec(argv, o);
    };
    try {
      const r = await applyMain({ mode: "apply", config: c.path, dryRun: false, host: "hosta" }, { exec, fs: h.fs, out: () => {}, signals, exit: (code) => void exits.push(code), handleHup: true });
      const text = readFileSync(log, "utf8");
      expect(text.trimEnd().split("\n").at(-1)).toBe("=== ABORTED: oupdate-host-update on hosta got SIGHUP — this run did NOT complete ===");
      expect(exits).toEqual([129]);
      expect(r.rc).toBe(129);
      expect(h.calls.some((l) => l.startsWith("send-notice"))).toBe(false);
    } finally {
      resetStopping();
    }
  });

  test("without a terminal (nohup, launchd) SIGHUP is left alone", async () => {
    // Mutant caught (re-review 2 MEDIUM): a SIGHUP listener always installed, overriding nohup's ignore.
    const seen: string[] = [];
    const signals = { on: (sg: string) => void seen.push(sg), off: () => {} };
    const h = fakeHost();
    await applyMain({ mode: "apply", config: config({}).path, dryRun: true, host: "hosta" }, { exec: h.exec, fs: h.fs, out: () => {}, signals, handleHup: false });
    expect(seen).toEqual(["SIGTERM", "SIGINT"]);
  });

  test("HIGH: a command started while the stop waits never runs; nothing is logged after ABORTED; exit 143", async () => {
    // Mutants caught: realExec spawning while stopping (brew upgrade b ran unsupervised after ABORTED),
    // log lines after ABORTED, the run's own rc winning.
    const log = join(root, "stop.log");
    const marker = join(root, "b-started");
    const c = config({ logFile: log, notify: ["send-notice"] });
    const handlers = new Map<string, () => void>();
    const signals = { on: (sg: string, f: () => void) => handlers.set(sg, f), off: (sg: string) => handlers.delete(sg) };
    const exits: number[] = [];
    const h = fakeHost({ formulas: "a b", verbose: "a (1) < 1.1\nb (1) < 1.1", formulaTaps: { a: "homebrew/core", b: "homebrew/core" } });
    const exec: Exec = async (argv, o) => {
      const line = argv.join(" ");
      if (line === "brew upgrade a") {
        setTimeout(() => handlers.get("SIGTERM")!(), 150);
        return realExec(["/bin/sh", "-c", "sleep 30"], o);
      }
      if (line === "brew upgrade b") return realExec(["/bin/sh", "-c", `touch ${marker}; sleep 30`], o);
      if (line.startsWith("send-notice")) return realExec(["/bin/sh", "-c", "true"], o);
      return h.exec(argv, o);
    };
    try {
      const r = await applyMain({ mode: "apply", config: c.path, dryRun: false, host: "hosta" }, { exec, fs: h.fs, out: () => {}, signals, exit: (code) => void exits.push(code) });
      expect(r.rc).toBe(143);
      expect(exits).toEqual([143]);
      expect(existsSync(marker)).toBe(false);
      const text = readFileSync(log, "utf8");
      expect(text.trimEnd().split("\n").at(-1)).toBe("=== ABORTED: oupdate-host-update on hosta got SIGTERM — this run did NOT complete ===");
      expect(liveGroups()).toEqual([]);
    } finally {
      resetStopping();
    }
  }, 10_000);

  for (const tty of [true, false]) {
    test(`the handlers are on the process by default, and removed after (stdin ${tty ? "a" : "not a"} terminal)`, async () => {
      // Mutants caught: `deps.signals ?? process` replaced by a no-op source; SIGHUP not following the terminal.
      const SIGS = ["SIGTERM", "SIGINT", "SIGHUP"];
      const before = SIGS.map((sg) => process.listenerCount(sg));
      const during: number[][] = [];
      const h = fakeHost();
      const exec: Exec = async (argv, o) => {
        during.push(SIGS.map((sg) => process.listenerCount(sg)));
        return h.exec(argv, o);
      };
      await applyMain({ mode: "apply", config: config({}).path, dryRun: true, host: "hosta" }, { exec, fs: h.fs, out: () => {}, stdinIsTTY: tty });
      expect(during[0]).toEqual([before[0]! + 1, before[1]! + 1, before[2]! + (tty ? 1 : 0)]);
      expect(SIGS.map((sg) => process.listenerCount(sg))).toEqual(before);
    });
  }

  test("a second signal writes no second stop line and stops once", async () => {
    // Mutant caught: the `if (stopCode !== undefined) return` guard removed (two ABORTED lines, two stops, two exits).
    const log = join(root, "twice.log");
    const c = config({ logFile: log });
    const handlers = new Map<string, () => void>();
    const signals = { on: (sg: string, f: () => void) => handlers.set(sg, f), off: (sg: string) => handlers.delete(sg) };
    const exits: number[] = [];
    let stops = 0;
    const h = fakeHost();
    const exec: Exec = async (argv, o) => {
      if (argv.join(" ") === "brew --version") {
        handlers.get("SIGTERM")!();
        handlers.get("SIGTERM")!();
        handlers.get("SIGINT")!();
      }
      return h.exec(argv, o);
    };
    const r = await applyMain({ mode: "apply", config: c.path, dryRun: false, host: "hosta" }, { exec, fs: h.fs, out: () => {}, signals, exit: (code) => void exits.push(code), stopLive: () => void stops++ });
    expect(readFileSync(log, "utf8").match(/=== ABORTED/g)).toHaveLength(1);
    expect(stops).toBe(1);
    expect(exits).toEqual([143]);
    expect(r.rc).toBe(143);
  });

  test("a crash while a stop is under way returns the signal's code, with no second line", async () => {
    // Mutant caught: the catch path ignoring the stop (an "exited 2" ABORTED line and a rethrow).
    const log = join(root, "crash-stop.log");
    const c = config({ logFile: log });
    const handlers = new Map<string, () => void>();
    const signals = { on: (sg: string, f: () => void) => handlers.set(sg, f), off: (sg: string) => handlers.delete(sg) };
    const exits: number[] = [];
    const h = fakeHost();
    const fs = { ...h.fs, exists: async () => { handlers.get("SIGTERM")!(); throw new Error("disk gone"); } };
    const r = await applyMain({ mode: "apply", config: c.path, dryRun: false, host: "hosta" }, { exec: h.exec, fs, out: () => {}, signals, exit: (code) => void exits.push(code), stopLive: () => {} });
    expect(r.rc).toBe(143);
    expect(exits).toEqual([143]);
    const text = readFileSync(log, "utf8");
    expect(text.match(/=== ABORTED/g)).toHaveLength(1);
    expect(text).not.toContain("exited 2");
  });

  test("4: {date} in logFile is the run's local date as YYYYMMDD", async () => {
    // Mutant caught: a fixed log path (the digest reads the newest dated file).
    expect(logPath("/logs.test/{date}.log", new Date(2026, 0, 5, 23, 59))).toBe("/logs.test/20260105.log");
    const dir = join(root, "dated");
    const c = config({ logFile: join(dir, "{date}.log") });
    const h = fakeHost();
    await applyMain({ mode: "apply", config: c.path, dryRun: false, host: "hosta" }, { exec: h.exec, fs: h.fs, out: () => {}, now: new Date(2026, 9, 22, 7, 0) });
    expect(readFileSync(join(dir, "20261022.log"), "utf8")).toContain("=== hosta summary ===");
  });
});

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const until = async (f: () => boolean, ms: number) => {
  const end = Date.now() + ms;
  while (!f() && Date.now() < end) await Bun.sleep(25);
  return f();
};

describe("realExec: process groups (slice 7 re-review)", () => {
  test("killLive stops a running command's whole group: TERM, then KILL for what ignores TERM", async () => {
    // Mutants caught: killLive's body emptied, `live.add` deleted (the command is never stopped and the call hangs).
    const pidFile = join(root, "live.pid");
    const p = realExec(["/bin/sh", "-c", `trap "" TERM; sleep 30 & echo $! > ${pidFile}; wait`]);
    expect(await until(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== "", 3000)).toBe(true);
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    expect(liveGroups().length).toBeGreaterThan(0);
    try {
      await killLive(200);
      const r = await p;
      expect(r.rc).toBe(137);
      expect(await until(() => !alive(pid), 1000)).toBe(true);
      expect(liveGroups()).toEqual([]);
      // Stopping: nothing new starts.
      expect(await realExec(["/bin/sh", "-c", "exit 0"])).toEqual({ rc: 143, out: "", err: "oupdate is stopping: not started" });
    } finally {
      resetStopping();
    }
  }, 10_000);

  test("a timed-out group that ignores TERM gets SIGKILL after the grace, and stays listed until then", async () => {
    // Mutant caught: the SIGKILL timer deleted (the TERM-trapping grandchild lived on), or the pid dropped from `live` at the timeout.
    const r = await realExec(["/bin/sh", "-c", 'trap "" TERM; sleep 30 & echo $!; wait'], { timeoutMs: 300 });
    expect(r.timedOut).toBe(true);
    const pid = Number(r.out.trim());
    await Bun.sleep(200);
    expect(alive(pid)).toBe(true);
    expect(liveGroups().length).toBe(1);
    expect(await until(() => !alive(pid), KILL_GRACE_MS + 1500)).toBe(true);
    expect(liveGroups()).toEqual([]);
  }, 10_000);

  test("a timed-out call closes its pipe ends even while a grandchild still holds the other ends", async () => {
    // Mutant caught: stdout/stderr destroy() deleted (our ends stayed open until the grandchild died).
    const fds = () => readdirSync("/dev/fd").length;
    const before = fds();
    const r = await realExec(["/bin/sh", "-c", 'trap "" TERM; sleep 30 & wait'], { timeoutMs: 300 });
    expect(r.timedOut).toBe(true);
    await Bun.sleep(50);
    expect(fds()).toBe(before);
    await until(() => liveGroups().length === 0, KILL_GRACE_MS + 1500);
  }, 10_000);

  test("a child killed by a signal is 128 + its number", async () => {
    // Mutant caught: every signal but SIGKILL reported as 143.
    expect((await realExec(["/bin/sh", "-c", "kill -INT $$"])).rc).toBe(130);
    expect((await realExec(["/bin/sh", "-c", "kill -HUP $$"])).rc).toBe(129);
  });
});

describe("realExec: the SIGKILL outlives a quick exit (slice 7 re-review 2)", () => {
  test("a TERM-ignoring grandchild of a timed-out command is SIGKILLed even when the script would end at once", async () => {
    // Mutant caught: `.unref()` on the SIGKILL timer. Only the grandchild ignores TERM, so sh dies at
    // the timeout and nothing but that timer keeps the script up: with unref it exits at once and the
    // grandchild lives on.
    const dir = mkdtempSync(join(tmpdir(), "oupdate-unref-"));
    const pidFile = join(dir, "pid");
    const script = join(dir, "run.ts");
    writeFileSync(script, `import { realExec } from ${JSON.stringify(join(import.meta.dir, "../../src/apply/exec.ts"))};
await realExec(["/bin/sh", "-c", '(trap "" TERM; exec sleep 30) & echo $! > ${pidFile}; wait'], { timeoutMs: 1000 });
`);
    let pid = 0;
    try {
      const p = Bun.spawnSync(["bun", script]);
      expect(p.exitCode).toBe(0);
      pid = Number(readFileSync(pidFile, "utf8").trim());
      expect(await until(() => !alive(pid), 1500)).toBe(true);
    } finally {
      if (pid > 1 && alive(pid)) process.kill(pid, "SIGKILL");
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);
});

describe("closeRc", () => {
  test("exit code, else 128 + the signal number, else 1", () => {
    // Mutant caught: neither code nor signal read as 129 (a SIGHUP).
    expect(closeRc(0, null)).toBe(0);
    expect(closeRc(3, null)).toBe(3);
    expect(closeRc(null, "SIGINT")).toBe(130);
    expect(closeRc(null, "SIGKILL")).toBe(137);
    expect(closeRc(null, null)).toBe(1);
  });
});

describe("realExec timeout", () => {
  test("1: a grandchild holding the pipes does not keep the wait: the group is killed and it returns at once", async () => {
    // Mutant caught: kill of the direct child only, then waiting for pipe EOF (returned after the grandchild's 30 s).
    const t0 = Date.now();
    const r = await realExec(["/bin/sh", "-c", "sleep 30 & echo $!; wait"], { timeoutMs: 300 });
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(r.timedOut).toBe(true);
    const pid = Number(r.out.trim());
    expect(pid).toBeGreaterThan(1);
    await Bun.sleep(300);
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);
  });
  test("a command past its timeout is killed and reported as timed out", async () => {
    const r = await realExec(["sleep", "5"], { timeoutMs: 200 });
    expect(r.timedOut).toBe(true);
    expect(r.rc).not.toBe(0);
  });
  test("a command within its timeout is not", async () => {
    const r = await realExec(["true"], { timeoutMs: 5000 });
    expect(r).toEqual({ rc: 0, out: "", err: "" });
  });
});
