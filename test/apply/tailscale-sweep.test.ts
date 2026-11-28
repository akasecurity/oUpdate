// Tailscale one host at a time (OUP-325): the config keys, the turn in the canary order, the verify and its record, and the hold in the apply run.
import { describe, expect, test } from "bun:test";
import { parseApplyConfig } from "../../src/apply/config.ts";
import type { Exec } from "../../src/apply/exec.ts";
import { realFs } from "../../src/apply/fs.ts";
import { applyHost } from "../../src/apply/run.ts";
import { baseVersion, sameVersion } from "../../src/apply/tailscale-verify.ts";
import { DEFAULT_CANARY_ORDER, recordDir, isTailscaleCask, parseSweepList, readSweep, recordName, recordPath, sweepTurn, turnFor, verifyPeers } from "../../src/apply/tailscale-sweep.ts";
import { ATTEMPTS, KILL_GRACE_MS, maxVerifyMs, parseArgs, PING_TIMEOUT_MS, RETRY_WAIT_MS, runCommand, SETTLE_MS, STATUS_TIMEOUT_MS, verify, type Run } from "../../src/apply/tailscale-verify.ts";
import { execFile } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { constants, tmpdir } from "node:os";
import { join } from "node:path";
import { brewView, failOptLink, installedAbove, invalidateRecord, loadPending, pruneOlderKegs, rollback, runCheck, staleSweepRecords, type ReleaseEnv } from "../../src/apply/release-checks.ts";
import { fakeHost, fakeTypeB, testConfig } from "./host-fixture.ts";
import { scripted } from "./helpers.ts";

const cfg = (apply: Record<string, unknown>) => JSON.stringify({ apply });
const ORDER = DEFAULT_CANARY_ORDER;
const ok = (...hosts: string[]) => new Map(hosts.map((h) => [h, "verified" as const]));

describe("config keys", () => {
  test("defaults: tailscale is risky, the order is the canary order, and tailscale gets the built-in verify", () => {
    const c = parseApplyConfig(cfg({ stateDir: "/state.test", host: "ai" }), "ai");
    expect(c.riskyKeepPrevious).toEqual(["tailscale"]);
    expect(c.tailscaleCanaryOrder).toEqual(["bonus", "ai", "max", "startup", "build", "mini", "dev"]);
    const check = c.releaseChecks!.find((r) => r.formula === "tailscale")!;
    expect(check.command.slice(2)).toEqual(["--host", "ai", "--state", "/state.test", "--peers", "max,startup"]);
    expect(check.command[1]!.endsWith("/tailscale-verify.ts")).toBe(true);
    // The verify retries inside itself, so the record is written once, from its final verdict.
    expect(check.retries).toBe(0);
    expect(check.builtin).toBe(true);
  });
  test("tailscaleVerify replaces the local ping after `--`, and an own releaseChecks entry for tailscale is refused while it is a risky package", () => {
    const c = parseApplyConfig(cfg({ stateDir: "/state.test", host: "bonus", tailscaleVerify: ["/opt/x/ping-from-peer", "bonus"] }), "bonus");
    expect(c.releaseChecks![0]!.command.slice(-3)).toEqual(["--", "/opt/x/ping-from-peer", "bonus"]);
    expect(() => parseApplyConfig(cfg({ stateDir: "/state.test", releaseChecks: [{ formula: "homebrew/core/tailscale", command: ["/opt/x/own"] }] }), "bonus")).toThrow("tailscale is a risky package, so its check is the built-in verify");
    const own = parseApplyConfig(cfg({ stateDir: "/state.test", riskyKeepPrevious: [], releaseChecks: [{ formula: "homebrew/core/tailscale", command: ["/opt/x/own"] }] }), "bonus");
    expect(own.releaseChecks!.map((r) => r.command)).toEqual([["/opt/x/own"]]);
  });
  test("bad values are refused at load with the key named", () => {
    const bad = (o: Record<string, unknown>) => () => parseApplyConfig(cfg({ stateDir: "/state.test", ...o }), "h");
    expect(bad({ tailscaleCanaryOrder: [] })).toThrow("tailscaleCanaryOrder must be a non-empty array");
    expect(bad({ tailscaleCanaryOrder: ["a", "a"] })).toThrow("tailscaleCanaryOrder lists a host twice");
    expect(bad({ tailscaleCanaryOrder: ["a b"] })).toThrow("is not a host name");
    expect(bad({ riskyKeepPrevious: ["tailscale", "tailscale"] })).toThrow("riskyKeepPrevious lists a package twice");
    expect(bad({ riskyKeepPrevious: ["tailscale", "homebrew/core/tailscale"] })).toThrow("riskyKeepPrevious lists a package twice");
    expect(bad({ riskyKeepPrevious: ["gadget"] })).toThrow("riskyKeepPrevious: gadget needs a releaseChecks entry");
    expect(bad({ tailscaleSweepRead: ["relative"] })).toThrow("tailscaleSweepRead must be an argv");
    expect(bad({ tailscaleVerify: [] })).toThrow("tailscaleVerify must be an argv");
    expect(bad({ riskyKeepPrevious: 5 })).toThrow("riskyKeepPrevious must be an array");
  });
  test("a risky package other than tailscale needs and keeps its own check; [] turns the list off", () => {
    const c = parseApplyConfig(cfg({ stateDir: "/state.test", riskyKeepPrevious: ["gadget"], releaseChecks: [{ formula: "gadget", command: ["/opt/x/check"] }] }), "h");
    expect(c.releaseChecks!.map((r) => r.formula)).toEqual(["gadget"]);
    expect(parseApplyConfig(cfg({ stateDir: "/state.test", riskyKeepPrevious: [] }), "h").releaseChecks).toBeUndefined();
  });
});

describe("the turn in the canary order", () => {
  test("verifyPeers: the next two hosts, wrapping; none for a host not in the order", () => {
    expect(verifyPeers(ORDER, "bonus")).toEqual(["ai", "max"]);
    expect(verifyPeers(ORDER, "mini")).toEqual(["dev", "bonus"]);
    expect(verifyPeers(ORDER, "dev")).toEqual(["bonus", "ai"]);
    expect(verifyPeers(ORDER, "desk")).toEqual([]);
    expect(verifyPeers(["a", "b"], "a")).toEqual(["b"]);
  });
  test("parseSweepList: `host version` is verified, `host version failed` is failed, a line for another version is skipped, garbage is no answer", () => {
    expect(parseSweepList("bonus 1.80.2\nai 1.80.2 verified\nmax 1.80.2 failed\n", "1.80.2")).toEqual(new Map([["bonus", "verified"], ["ai", "verified"], ["max", "failed"]]));
    expect(parseSweepList("bonus 1.80.2\nbonus 1.80.2 failed\nbonus 1.80.2 verified", "1.80.2")!.get("bonus")).toBe("failed");
    expect(parseSweepList("", "1.80.2")).toEqual(new Map());
    // A stale line (another version) never counts for this one, and a failed one for another version never stops it.
    expect(parseSweepList("bonus 1.78.0\nai 1.78.0 failed\nmax 1.80.2", "1.80.2")).toEqual(new Map([["max", "verified"]]));
    // A line with no version (the old `bonus verified`) cannot authorize anything.
    expect(parseSweepList("bonus verified", "1.80.2")).toEqual(new Map());
    expect(parseSweepList("bonus", "1.80.2")).toBeUndefined();
    expect(parseSweepList("bonus 1.80.2 maybe", "1.80.2")).toBeUndefined();
    expect(parseSweepList("<html>", "1.80.2")).toBeUndefined();
    expect(parseSweepList("bonus 1.80.2 verified extra", "1.80.2")).toBeUndefined();
  });
  test("recordName: two versions never share a file name, and the name has no separator", () => {
    const vs = ["1.80.2", "1.80/2", "1.80_2", "1.80:2", "1.80_2f2", "1.80/2", "é", "e\u0301", "..", "a b"];
    const names = vs.map(recordName);
    expect(new Set(names).size).toBe(new Set(vs).size);
    for (const n of names) expect(/^[A-Za-z0-9._+-]+\.json$/.test(n)).toBe(true);
    expect(recordName("1.80/2")).not.toBe(recordName("1.80_2"));
    expect(recordName("1.80.2")).toBe("1.80.2.json");
  });
  test("isTailscaleCask: the app, bare or tap-qualified; nothing else", () => {
    expect(["tailscale", "tailscale-app", "homebrew/cask/tailscale-app"].map(isTailscaleCask)).toEqual([true, true, true]);
    expect(["tailscaled", "tailscale-extra"].map(isTailscaleCask)).toEqual([false, false]);
  });
  test("the first host goes with no record; a host not in the order, desk and air included, is refused", () => {
    expect(turnFor("bonus", ORDER, undefined, false)).toEqual({ go: true });
    for (const h of ["desk", "air", "unknown"]) expect(turnFor(h, ORDER, ok(...ORDER), true)).toEqual({ go: false, why: `host ${h} is not in tailscaleCanaryOrder (refused)` });
  });
  test("with no reader only the first host may upgrade: every other host waits for the one before it", () => {
    expect(turnFor("ai", ORDER, undefined, false)).toEqual({ go: false, why: "waiting for bonus: tailscaleSweepRead not set" });
    expect(turnFor("dev", ORDER, undefined, false).why).toBe("waiting for mini: tailscaleSweepRead not set");
  });
  test("a reader that gave no answer is not our turn", () => {
    expect(turnFor("ai", ORDER, undefined, true)).toEqual({ go: false, why: "waiting for bonus: tailscaleSweepRead gave no answer" });
  });
  test("every host before it must be verified: the first missing one is named", () => {
    expect(turnFor("ai", ORDER, ok("bonus"), true)).toEqual({ go: true });
    expect(turnFor("max", ORDER, ok("bonus"), true)).toEqual({ go: false, why: "waiting for ai" });
    expect(turnFor("dev", ORDER, ok("bonus", "ai", "max", "startup", "build"), true).why).toBe("waiting for mini");
    expect(turnFor("dev", ORDER, ok("bonus", "ai", "max", "startup", "build", "mini"), true)).toEqual({ go: true });
    // A host after it being verified does not stand in for one before it.
    expect(turnFor("max", ORDER, ok("bonus", "build"), true).why).toBe("waiting for ai");
  });
  test("a failed record stops every later host, named", () => {
    const failed = new Map([["bonus", "verified" as const], ["ai", "failed" as const]]);
    for (const h of ["max", "startup", "build", "mini", "dev"]) expect(turnFor(h, ORDER, failed, true)).toEqual({ go: false, why: "the sweep stopped at ai: its verify failed" });
  });
  test("a failure at a host after this one does not stop it", () => {
    expect(turnFor("ai", ORDER, new Map([["bonus", "verified" as const], ["max", "failed" as const]]), true)).toEqual({ go: true });
  });
  test("readSweep: a reader that fails, times out, prints too much or garbage is undefined, never a throw", async () => {
    const reader = (r: Partial<Awaited<ReturnType<Exec>>> | "throw"): Exec => async () => {
      if (r === "throw") throw new Error("spawn failed");
      return { rc: 0, out: "", err: "", ...r };
    };
    expect(await readSweep(reader({ out: "bonus 1.0\n" }), ["/x/read"], "1.0")).toEqual(ok("bonus"));
    expect(await readSweep(reader({ out: "bonus 0.9\n" }), ["/x/read"], "1.0")).toEqual(new Map());
    expect(await readSweep(reader({ rc: 1, out: "bonus 1.0\n" }), ["/x/read"], "1.0")).toBeUndefined();
    expect(await readSweep(reader({ timedOut: true, out: "bonus 1.0\n" }), ["/x/read"], "1.0")).toBeUndefined();
    expect(await readSweep(reader({ truncated: true, out: "" }), ["/x/read"], "1.0")).toBeUndefined();
    expect(await readSweep(reader({ out: "garbage line here now" }), ["/x/read"], "1.0")).toBeUndefined();
    expect(await readSweep(reader("throw"), ["/x/read"], "1.0")).toBeUndefined();
  });
  test("sweepTurn runs the reader with the version appended, and only for a host that is not first", async () => {
    const seen: string[][] = [];
    const exec: Exec = async (argv) => (seen.push(argv), { rc: 0, out: "bonus 1.80.2\n", err: "" });
    expect(await sweepTurn({ exec, host: "ai", order: ORDER, read: ["/x/read", "--fleet"], version: "1.80.2" })).toEqual({ go: true });
    expect(seen).toEqual([["/x/read", "--fleet", "1.80.2"]]);
    expect(await sweepTurn({ exec, host: "bonus", order: ORDER, read: ["/x/read"], version: "1.80.2" })).toEqual({ go: true });
    expect(await sweepTurn({ exec, host: "desk", order: ORDER, read: ["/x/read"], version: "1.80.2" })).toEqual({ go: false, why: "host desk is not in tailscaleCanaryOrder (refused)" });
    expect(seen.length).toBe(1);
  });
});

describe("the verify and its record", () => {
  const STATUS = (o: { BackendState?: string; Online?: boolean; Version?: string }) => JSON.stringify({ BackendState: o.BackendState ?? "Running", Version: o.Version ?? "1.80.2-t1a2b3c", Self: { Online: o.Online ?? true } });
  const harness = (answers: Record<string, { rc: number | undefined; out?: string }>, version: string | null = "1.80.2") => {
    const ran: string[] = [];
    const writes: [string, string][] = [];
    const removed: string[] = [];
    const slept: number[] = [];
    const run: Run = async (argv) => {
      ran.push(argv.join(" "));
      const a = answers[argv.slice(1).join(" ")] ?? answers[argv.join(" ")];
      return a ? { rc: a.rc, out: a.out ?? "" } : { rc: 1, out: "" };
    };
    return { ran, writes, removed, slept, deps: { run, version: version ?? undefined, now: () => new Date("2026-11-27T12:00:00Z"), write: async (_d: string, p: string, t: string) => void writes.push([p, t]), remove: async (p: string) => void removed.push(p), sleep: async (ms: number) => void slept.push(ms), log: () => {} } };
  };
  const args = { host: "ai", state: "/state.test", peers: ["max", "startup"] };
  test("running, self online and every peer answering: exit 0 and a verified record", async () => {
    const h = harness({ "status --json": { rc: 0, out: STATUS({}) }, "ping --c 3 max": { rc: 0 }, "ping --c 3 startup": { rc: 0 } });
    expect(await verify(args, h.deps)).toBe(0);
    expect(h.writes).toEqual([[recordPath("/state.test", "1.80.2"), `${JSON.stringify({ host: "ai", version: "1.80.2", status: "verified", at: "2026-11-27T12:00:00.000Z" })}\n`]]);
  });
  test("a stopped backend, an offline self or every peer silent: exit 1 and a failed record", async () => {
    for (const h of [
      harness({ "status --json": { rc: 0, out: STATUS({ BackendState: "Stopped" }) } }),
      harness({ "status --json": { rc: 0, out: STATUS({ Online: false }) }, "ping --c 3 max": { rc: 0 }, "ping --c 3 startup": { rc: 0 } }),
      harness({ "status --json": { rc: 0, out: STATUS({}) }, "ping --c 3 max": { rc: 1 }, "ping --c 3 startup": { rc: 1 } }),
    ]) {
      expect(await verify(args, h.deps)).toBe(1);
      expect(JSON.parse(h.writes[0]![1]).status).toBe("failed");
    }
  });
  test("one peer answering is enough: the second is pinged only after the first failed, and one silent peer does not fail a healthy host", async () => {
    const first = harness({ "status --json": { rc: 0, out: STATUS({}) }, "ping --c 3 max": { rc: 0 } });
    expect(await verify(args, first.deps)).toBe(0);
    expect(first.ran.some((l) => l.endsWith("ping --c 3 startup"))).toBe(false);
    const second = harness({ "status --json": { rc: 0, out: STATUS({}) }, "ping --c 3 max": { rc: 1 }, "ping --c 3 startup": { rc: 0 } });
    expect(await verify(args, second.deps)).toBe(0);
    expect(JSON.parse(second.writes[0]![1]).status).toBe("verified");
  });
  test("a hung or failing local tailscale is a failed reach (exit 1, rollback); only one that cannot be started is could-not-run (exit 2)", async () => {
    const hung = harness({ "status --json": { rc: 124 } });
    expect(await verify(args, hung.deps)).toBe(1);
    expect(JSON.parse(hung.writes[0]![1]).status).toBe("failed");
    const ping = harness({ "status --json": { rc: 0, out: STATUS({}) }, "ping --c 3 max": { rc: 124 }, "ping --c 3 startup": { rc: 124 } });
    expect(await verify(args, ping.deps)).toBe(1);
    const garbage = harness({ "status --json": { rc: 0, out: "null" } });
    expect(await verify(args, garbage.deps)).toBe(1);
    const missing = harness({ "status --json": { rc: undefined } });
    expect(await verify(args, missing.deps)).toBe(2);
    const noPing = harness({ "status --json": { rc: 0, out: STATUS({}) }, "ping --c 3 max": { rc: undefined } });
    expect(await verify(args, noPing.deps)).toBe(2);
    expect(noPing.writes).toEqual([]);
  });
  test("the real command runner: a hang is stopped (SIGTERM, then SIGKILL) and answers 124, a crash answers 128+signal, a flood is cut, only a command that cannot start has no code; each is the verify's exit 1 or 2", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tsrun-"));
    const pidFile = join(dir, "pid");
    // Ignores SIGTERM and sleeps: only the escalation to SIGKILL ends it.
    const hung = await runCommand(["sh", "-c", `echo $$ > ${pidFile}; trap '' TERM; sleep 30`], 200, 200);
    expect(hung.rc).toBe(124);
    const pid = Number(readFileSync(pidFile, "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
    expect((await runCommand(["sh", "-c", "kill -SEGV $$"], 5000)).rc).toBe(128 + 11);
    const flood = await runCommand(["sh", "-c", "yes | head -c 12000000"], 10_000);
    expect(flood.rc).toBe(0);
    expect(flood.cut).toBe(true);
    expect(flood.out.length).toBeLessThan(9 * 1024 * 1024);
    expect((await runCommand([join(dir, "missing")], 5000)).rc).toBeUndefined();
    // Through the verify: the commands the local reach runs are replaced by each of these.
    const as = (cmd: string[]): Run => (argv) => runCommand(argv[1] === "status" ? cmd : ["true"], argv[1] === "status" ? 150 : 5000, 100);
    const base = harness({});
    for (const [cmd, want] of [[["sh", "-c", "trap '' TERM; sleep 30"], 1], [["sh", "-c", "kill -SEGV $$"], 1], [["sh", "-c", "yes | head -c 12000000"], 1], [[join(dir, "missing")], 2]] as const) {
      expect(await verify(args, { ...base.deps, run: as([...cmd]), settleMs: 0, retryMs: 0 })).toBe(want);
    }
    // A ping that floods and exits 0 is no answer (status is fine): with every peer cut the reach fails, never passes. A signal other than the table's is 128 + its number.
    const goodStatus = JSON.stringify({ BackendState: "Running", Version: "1.80.2-tabc", Self: { Online: true } });
    const pingFlood: Run = (argv) => (argv[1] === "status" ? Promise.resolve({ rc: 0, out: goodStatus }) : runCommand(["sh", "-c", "yes | head -c 12000000"], 10_000));
    expect(await verify(args, { ...base.deps, run: pingFlood, settleMs: 0, retryMs: 0 })).toBe(1);
    expect((await runCommand(["sh", "-c", "kill -USR1 $$"], 5000)).rc).toBe(128 + constants.signals.SIGUSR1);
    // The limit is counted in bytes over the whole output: one byte past it, in the only chunk there is, is cut; exactly at it is not.
    const exact = await runCommand(["sh", "-c", "head -c 8388608 /dev/zero"], 10_000);
    expect([exact.rc, exact.cut]).toEqual([0, undefined]);
    const over = await runCommand(["sh", "-c", "head -c 8388609 /dev/zero"], 10_000);
    expect([over.rc, over.cut]).toEqual([0, true]);
    // A custom verifier that floods and exits 0 has not answered: failed, never verified.
    const custom = { ...args, custom: ["/x/verify"] };
    expect(await verify(custom, { ...base.deps, run: async () => ({ rc: 0, out: "", cut: true }), settleMs: 0, retryMs: 0 })).toBe(1);
    expect(await verify(custom, { ...base.deps, run: async () => ({ rc: 0, out: "" }), settleMs: 0, retryMs: 0 })).toBe(0);
    // Cut is a failed verify whatever the exit code (a crash, a timeout), not could-not-run.
    for (const rc of [2, 124, 139]) expect(await verify(custom, { ...base.deps, run: async () => ({ rc, out: "", cut: true }), settleMs: 0, retryMs: 0 })).toBe(1);
    // A leader that dies on SIGTERM while a member of its group ignores it and no longer holds the pipe: the group is still killed before the answer.
    const memberPid = join(dir, "member");
    const hung2 = await runCommand(["sh", "-c", `sh -c 'trap "" TERM; echo $$ > ${memberPid}; exec sleep 30' >/dev/null 2>&1 & wait`], 300, 200);
    expect(hung2.rc).toBe(124);
    expect(() => process.kill(Number(readFileSync(memberPid, "utf8")), 0)).toThrow();
    rmSync(dir, { recursive: true, force: true });
  }, 30_000);
  test("the verify's own bound is below the release check's timeout of 600 s, for the peers the config gives it", () => {
    expect(maxVerifyMs(2)).toBeLessThan(600_000);
    expect(maxVerifyMs(2)).toBe(SETTLE_MS + ATTEMPTS * (STATUS_TIMEOUT_MS + 2 * PING_TIMEOUT_MS + 3 * (KILL_GRACE_MS + 1_000)) + (ATTEMPTS - 1) * RETRY_WAIT_MS);
    expect(maxVerifyMs(2)).toBe(307_000);
    expect(ATTEMPTS).toBe(3);
    expect(SETTLE_MS).toBe(10_000);
  });
  test("a tailscale that cannot be run, or no GATE_VERSION: exit 2 and no record", async () => {
    const h = harness({ "status --json": { rc: undefined } });
    expect(await verify(args, h.deps)).toBe(2);
    expect(h.writes).toEqual([]);
    const g = harness({}, null);
    expect(await verify(args, g.deps)).toBe(2);
    expect(g.ran).toEqual([]);
  });
  test("a failed status command is a failure though its stdout says Running (nonzero exit is never a pass)", async () => {
    const h = harness({ "status --json": { rc: 1, out: STATUS({}) }, "ping --c 3 max": { rc: 0 }, "ping --c 3 startup": { rc: 0 } });
    expect(await verify(args, h.deps)).toBe(1);
    expect(JSON.parse(h.writes[0]![1]).status).toBe("failed");
  });
  test("a daemon that is not the new version (a system daemon left on the old keg) fails the verify, though status and ping pass", async () => {
    for (const Version of ["1.78.0", "1.80.20", "1.80.2x"]) {
      const h = harness({ "status --json": { rc: 0, out: STATUS({ Version }) }, "ping --c 3 max": { rc: 0 }, "ping --c 3 startup": { rc: 0 } });
      expect(await verify(args, h.deps)).toBe(1);
      expect(JSON.parse(h.writes[0]![1]).status).toBe("failed");
    }
    expect(await verify(args, harness({ "status --json": { rc: 0, out: STATUS({ Version: "1.80.2" }) }, "ping --c 3 max": { rc: 0 }, "ping --c 3 startup": { rc: 0 } }).deps)).toBe(0);
  });
  test("a host with no peer cannot pass or fail: exit 2, no record, an older record of the version removed", async () => {
    const h = harness({ "status --json": { rc: 0, out: STATUS({}) } });
    expect(await verify({ ...args, peers: [] }, h.deps)).toBe(2);
    expect(h.ran).toEqual([]);
    expect(h.writes).toEqual([]);
    expect(h.removed).toEqual([recordPath("/state.test", "1.80.2")]);
  });
  test("could not run removes the version's record, so a stale one does not stand", async () => {
    const h = harness({ "status --json": { rc: undefined } });
    expect(await verify(args, h.deps)).toBe(2);
    expect(h.removed).toEqual([recordPath("/state.test", "1.80.2")]);
    const ok = harness({ "status --json": { rc: 0, out: STATUS({}) }, "ping --c 3 max": { rc: 0 }, "ping --c 3 startup": { rc: 0 } });
    await verify(args, ok.deps);
    expect(ok.removed).toEqual([]);
  });
  test("a failure is tried again before it stands: a pass on the second try writes one verified record; three failures write one failed record, after the settle and two waits", async () => {
    let n = 0;
    const flaky = harness({});
    flaky.deps.run = async (argv) => {
      if (argv[1] === "status") return { rc: 0, out: STATUS({}) };
      return { rc: ++n <= 2 ? 1 : 0, out: "" };
    };
    expect(await verify(args, flaky.deps)).toBe(0);
    expect(flaky.writes.map(([, t]) => JSON.parse(t).status)).toEqual(["verified"]);
    // The settle wait before the first look, then one wait before the second attempt.
    expect(flaky.slept).toEqual([SETTLE_MS, RETRY_WAIT_MS]);
    const down = harness({ "status --json": { rc: 0, out: STATUS({ Online: false }) } });
    expect(await verify(args, down.deps)).toBe(1);
    expect(down.writes.map(([, t]) => JSON.parse(t).status)).toEqual(["failed"]);
    expect(down.slept).toEqual([SETTLE_MS, RETRY_WAIT_MS, RETRY_WAIT_MS]);
  });
  test("an error inside the verify is exit 2, never the exit 1 an uncaught error would give: a failed write, a failed removal", async () => {
    const w = harness({ "status --json": { rc: 0, out: STATUS({}) }, "ping --c 3 max": { rc: 0 }, "ping --c 3 startup": { rc: 0 } });
    w.deps.write = async () => { throw new Error("ENOSPC"); };
    expect(await verify(args, w.deps)).toBe(2);
    const rm = harness({ "status --json": { rc: undefined } });
    rm.deps.remove = async () => { throw new Error("EACCES"); };
    expect(await verify(args, rm.deps)).toBe(2);
  });
  test("a failed record that cannot be written leaves the verdict failed (exit 1); a verified one that cannot be published is no verdict (exit 2)", async () => {
    const down = harness({ "status --json": { rc: 0, out: STATUS({ Online: false }) } });
    down.deps.write = async () => { throw new Error("ENOSPC"); };
    expect(await verify(args, down.deps)).toBe(1);
    const up = harness({ "status --json": { rc: 0, out: STATUS({}) }, "ping --c 3 max": { rc: 0 }, "ping --c 3 startup": { rc: 0 } });
    up.deps.write = async () => { throw new Error("ENOSPC"); };
    expect(await verify(args, up.deps)).toBe(2);
  });
  test("a verify of a restored version answers and writes nothing: no record, no removal", async () => {
    const ok = harness({ "status --json": { rc: 0, out: STATUS({}) }, "ping --c 3 max": { rc: 0 }, "ping --c 3 startup": { rc: 0 } });
    expect(await verify(args, { ...ok.deps, record: false })).toBe(0);
    const down = harness({ "status --json": { rc: 0, out: STATUS({ Online: false }) } });
    expect(await verify(args, { ...down.deps, record: false })).toBe(1);
    const none = harness({ "status --json": { rc: undefined } });
    expect(await verify(args, { ...none.deps, record: false })).toBe(2);
    expect([ok, down, none].flatMap((h) => [...h.writes, ...h.removed])).toEqual([]);
  });
  test("versions are compared without their decoration: v, +build, -tNN and brew's _N revision", () => {
    expect(["v1.80.2", "1.80.2+x", "1.80.2-t1a2b3c", "1.80.2_1", " 1.80.2 "].map(baseVersion)).toEqual(Array(5).fill("1.80.2"));
    expect(sameVersion("1.80.2-t1a2b3c", "1.80.2_1")).toBe(true);
    expect(sameVersion("v1.80.2", "1.80.2")).toBe(true);
    expect(sameVersion("1.80.20", "1.80.2")).toBe(false);
    expect(sameVersion("1.80.2x", "1.80.2")).toBe(false);
    // Only the known forms: another suffix is another release.
    expect(sameVersion("1.80.2-rc1", "1.80.2")).toBe(false);
    expect(sameVersion("1.80.2-t1a2b3c+x_1", "1.80.2")).toBe(true);
    expect(sameVersion("", "")).toBe(false);
  });
  test("a custom argv decides: 0 verified, 1 failed, anything else could not run (no record)", async () => {
    const custom = ["/opt/x/ping-from-peer"];
    for (const [rc, want, status] of [[0, 0, "verified"], [1, 1, "failed"], [3, 2, undefined], [undefined, 2, undefined]] as const) {
      const h = harness({ "/opt/x/ping-from-peer": { rc } });
      expect(await verify({ ...args, custom }, h.deps)).toBe(want);
      expect(h.writes.map(([, t]) => JSON.parse(t).status)).toEqual(status ? [status] : []);
    }
  });
  test("parseArgs reads the options and the argv after `--`; a relative state dir is refused", () => {
    expect(parseArgs(["--host", "ai", "--state", "/s", "--peers", "max,startup", "--", "/x/p", "a"])).toEqual({ host: "ai", state: "/s", peers: ["max", "startup"], custom: ["/x/p", "a"] });
    expect(parseArgs(["--host", "ai", "--state", "s"])).toBeUndefined();
    expect(parseArgs(["--state", "/s"])).toBeUndefined();
  });
});

describe("the apply run holds tailscale until it is this host's turn", () => {
  async function run(o: { host: string; read?: string[]; reader?: string; candidate?: string; candidates?: string[]; dry?: boolean; casks?: string; formulas?: string; lock?: boolean | "throws"; builtin?: boolean; files?: Record<string, string>; installedList?: string; installed?: string; moveAfterCellar?: string; upgradeRc?: number; risky?: string[]; deps?: Record<string, string>; daemon?: "none" | "stopped" | "old"; startUpgraded?: boolean; noOpt?: boolean; optAfter?: "gone" | "unread"; optAfterUpgrade?: boolean; unreadOpt?: boolean; linkedDir?: boolean; currentAfterCellar?: string; failRead?: string[]; failRemove?: string[]; stoppedLabel?: string; statusRc?: number; failWrite?: string[]; lsof?: string[]; ps?: Record<string, { comm?: string; command?: string; ppid?: string }> }) {
    const h = fakeHost({ formulas: o.formulas ?? "tailscale", verbose: "tailscale (1.78.0) < 1.80.2\ngood-a (1.0) < 1.1", formulaTaps: { tailscale: "homebrew/core", "good-a": "homebrew/core" }, dirs: ["/brew/Cellar", "/brew/Cellar/tailscale/1.78.0", ...(o.linkedDir ? ["/brew/var/homebrew/linked"] : [])], ...(o.daemon === "none" ? { ...(o.files ? { files: o.files } : {}) } : { files: { "/Library/LaunchDaemons/sh.brew.tailscale.plist": "", ...o.files } }), ...(o.upgradeRc ? { upgradeRc: { tailscale: o.upgradeRc } } : {}), ...(o.lsof ? { lsof: o.lsof, ps: o.ps } : {}), ...(o.failWrite ? { failWrite: o.failWrite } : {}), ...(o.failRemove ? { failRemove: o.failRemove } : {}), ...(o.failRead ? { failRead: o.failRead } : {}), ...(o.deps ? { deps: o.deps } : {}), ...(o.installedList ? { answers: { "brew list --formula --full-name": { rc: 0, out: o.installedList } } } : {}), ...(o.casks ? { casks: o.casks, caskTaps: { [o.casks]: "homebrew/cask" } } : {}) });
    const listDir = h.fs.listDir;
    h.fs.listDir = async (d) => (d.startsWith("/state.test/release-checks") || d === "/state.test/tailscale-sweep" ? [...h.files.keys()].filter((k) => k.startsWith(`${d}/`)).map((k) => k.slice(d.length + 1)) : listDir(d));
    // The installed keg's directory is there (brew's view only counts a keg that is in the Cellar).
    const isDir = h.fs.isDir;
    h.fs.isDir = async (d) => (o.currentAfterCellar && d === `/brew/Cellar/tailscale/${o.currentAfterCellar}`) || (/^\/brew\/Cellar\/tailscale\/[^/]+$/.test(d) && d.endsWith(`/${o.startUpgraded || upgradedNow() ? (o.installed ?? "1.80.2") : "1.78.0"}`)) || (await isDir(d));
    const calls: string[] = [];
    const seen = [...(o.candidates ?? [])];
    const locks: string[] = [];
    let upgraded = o.startUpgraded ?? false;
    const upgradedNow = () => upgraded;
    let moved = false;
    let filesAtUpgrade: string[] = [];
    const exec: Exec = async (argv, opt) => {
      const line = argv.join(" ");
      // The daemon of the host (real runs ask before anything is installed): running and on the version in use, unless a test says otherwise.
      if (!upgraded && /^launchctl print system\/(sh\.brew|homebrew\.mxcl|com\.tailscale)/.test(line) && o.daemon !== "none") return o.daemon === "stopped" || (o.stoppedLabel && line.endsWith(o.stoppedLabel)) ? { rc: 113, out: "", err: "not found" } : { rc: 0, out: "\tstate = running\n\tpid = 99\n", err: "" };
      if (line === "tailscale status --json" && o.statusRc) return { rc: o.statusRc, out: "", err: "boom" };
      if (line === "tailscale status --json") return { rc: 0, out: JSON.stringify({ BackendState: "Running", Version: o.daemon === "old" ? "1.70.0-tabc" : "1.78.0-tabc", Self: { Online: true } }), err: "" };
      if (line === "brew upgrade tailscale") { upgraded = true; filesAtUpgrade = [...h.files.keys()]; }
      if (line === "brew info --json=v2 tailscale") {
        const now = upgraded ? (o.installed ?? "1.80.2") : "1.78.0";
        return { rc: 0, out: JSON.stringify({ formulae: [{ name: "tailscale", full_name: "tailscale", tap: "homebrew/core", linked_keg: moved && o.currentAfterCellar !== undefined ? o.currentAfterCellar || null : now, installed: upgraded ? [{ version: "1.78.0" }, { version: now }] : moved && o.currentAfterCellar !== undefined ? [{ version: "1.78.0" }, { version: "1.77.0" }] : [{ version: "1.78.0" }], versions: { stable: moved && o.moveAfterCellar ? o.moveAfterCellar : seen.length > 1 ? seen.shift() : (seen[0] ?? o.candidate ?? "1.80.2") } }] }), err: "" };
      }
      if (line === "brew uninstall tailscale") return { rc: 0, out: "", err: "" };
      // The opt link: on the keg in use (the previous one until the upgrade), or what a test says it moved to ("" = the link is gone).
      if (line === "/usr/bin/readlink /brew/opt/tailscale" && o.noOpt) return { rc: 1, out: "", err: "" };
      if (line === "/usr/bin/readlink /brew/opt/tailscale" && o.unreadOpt) return { rc: 124, out: "", err: "" };
      // The link goes (or cannot be read) after the cellar read, while brew's linked_keg still names the version in use.
      if (line === "/usr/bin/readlink /brew/opt/tailscale" && o.optAfter && moved) return o.optAfter === "gone" ? { rc: 1, out: "", err: "" } : { rc: 124, out: "", err: "" };
      if (line === "/usr/bin/readlink /brew/opt/tailscale" && o.optAfterUpgrade && upgraded) return { rc: 1, out: "", err: "" };
      if (line === "/usr/bin/readlink /brew/opt/tailscale") {
        const cur = moved && o.currentAfterCellar !== undefined ? o.currentAfterCellar : upgraded ? (o.installed ?? "1.80.2") : "1.78.0";
        return cur ? { rc: 0, out: `../Cellar/tailscale/${cur}\n`, err: "" } : { rc: 1, out: "", err: "" };
      }
      if (line === "brew --cellar tailscale") moved = true;
      if (line === "brew --cellar tailscale") return { rc: 0, out: "/brew/Cellar/tailscale\n", err: "" };
      if (line.startsWith("brew trust ")) return { rc: 0, out: JSON.stringify({ formulae: [] }), err: "" };
      if (line === "brew --prefix") return { rc: 0, out: "/brew\n", err: "" };
      if (argv[0] === "/x/read") return calls.push(line), { rc: 0, out: o.reader ?? "", err: "" };
      return h.exec(argv, opt);
    };
    const res = await applyHost(
      testConfig({ host: o.host, logFile: "/log.test/h.log", riskyKeepPrevious: o.risky ?? ["tailscale"], tailscaleCanaryOrder: DEFAULT_CANARY_ORDER, ...(o.read ? { tailscaleSweepRead: o.read } : {}), releaseChecks: o.risky?.length === 0 ? [] : [{ formula: "tailscale", command: ["/opt/x/verify"], retries: 1, timeoutSec: 60, ...(o.builtin ?? true ? { builtin: true } : {}) }] }),
      exec, h.fs, { dryRun: o.dry ?? true, ownerLock: { take: async (p) => { locks.push(`take ${p}`); if (o.lock === "throws") throw new Error("EROFS: read-only file system"); return o.lock ?? true; }, release: async (p) => void locks.push(`release ${p}`) }, reviewer: scripted([], "APPROVE\nno attack indicators found").r, typeB: fakeTypeB(0).typeB },
    );
    return { ...res, files: h.files, filesAtUpgrade: () => filesAtUpgrade, optsOf: (prefix: string) => h.callOpts.filter((c) => c.line.startsWith(prefix)).map((c) => c.opts), calls, locks, envOf: (prefix: string) => h.callOpts.filter((c) => c.line.startsWith(prefix)).map((c) => c.opts?.env), text: [...res.log, ...res.summary].join("\n"), brew: h.calls };
  }
  test("a host that is not first, with no reader, holds tailscale and names the host it waits for", async () => {
    const r = await run({ host: "ai" });
    expect(r.text).toContain("holding tailscale (tailscale sweep: waiting for bonus: tailscaleSweepRead not set)");
    expect(r.text).not.toContain("release check tailscale:");
  });
  test("desk is refused, and so is a host that is not named", async () => {
    expect((await run({ host: "desk", read: ["/x/read"], reader: "bonus 1.80.2\nai 1.80.2\nmax 1.80.2\nstartup 1.80.2\nbuild 1.80.2\nmini 1.80.2\ndev 1.80.2\n" })).text).toContain("host desk is not in tailscaleCanaryOrder (refused)");
  });
  test("with the host before it verified the reader is asked with the version, and the host goes on to its release check", async () => {
    const r = await run({ host: "ai", read: ["/x/read"], reader: "bonus 1.80.2\n" });
    expect(r.calls).toEqual(["/x/read 1.80.2"]);
    expect(r.text).not.toContain("tailscale sweep:");
    expect(r.text).toContain("dry-run: release check tailscale: would run");
  });
  test("a failed record before it stops it, and a reader that prints garbage is a hold, not an error", async () => {
    expect((await run({ host: "max", read: ["/x/read"], reader: "bonus 1.80.2\nai 1.80.2 failed\n" })).text).toContain("the sweep stopped at ai: its verify failed");
    const g = await run({ host: "ai", read: ["/x/read"], reader: "<html>" });
    expect(g.text).toContain("tailscaleSweepRead gave no answer");
    expect(g.rc).toBe(0);
  });
  test("the first host of the order needs no reader", async () => {
    const r = await run({ host: "bonus" });
    expect(r.text).not.toContain("tailscale sweep:");
    expect(r.text).toContain("dry-run: release check tailscale: would run");
  });
  test("a stale line (another version) does not authorize this host, and a failed line for another version does not stop it", async () => {
    const stale = await run({ host: "ai", read: ["/x/read"], reader: "bonus 1.78.0\n" });
    expect(stale.text).toContain("holding tailscale (tailscale sweep: waiting for bonus)");
    const old = await run({ host: "ai", read: ["/x/read"], reader: "bonus 1.80.2\nbonus 1.78.0 failed\n" });
    expect(old.text).toContain("dry-run: release check tailscale: would run");
  });
  test("the tailscale cask is held on every host, the first included, and another cask goes on", async () => {
    const r = await run({ host: "bonus", casks: "tailscale-app" });
    expect(r.text).toContain("holding tailscale-app (tailscale sweep: the tailscale app is updated by hand, never by the apply run)");
    expect(r.text).not.toContain("casks=[tailscale-app");
    const none = await run({ host: "bonus", casks: "other-app" });
    expect(none.text).not.toContain("holding other-app");
  });
  test("a real run takes this host's sweep lock before it reads the turn; without it tailscale is held and the reader is not asked", async () => {
    const r = await run({ host: "ai", dry: false, read: ["/x/read"], reader: "bonus 1.80.2\n", lock: false });
    expect(r.locks).toEqual(["take /state.test/tailscale-sweep/lock"]);
    expect(r.text).toContain("holding tailscale (tailscale sweep: another run of this host holds the sweep lock)");
    expect(r.calls).toEqual([]);
    expect((await run({ host: "ai", read: ["/x/read"], reader: "bonus 1.80.2\n" })).locks).toEqual([]);
  });
  test("the upgrade holds when brew offers another version than the one the turn was decided on, and installs nothing", async () => {
    const r = await run({ host: "bonus", dry: false, candidates: ["1.80.2", "1.81.0"] });
    expect(r.text).toContain("tailscale: not upgraded — brew now offers 1.81.0, the tailscale sweep decided on 1.80.2");
    expect(r.brew.some((l) => l.startsWith("brew upgrade"))).toBe(false);
    const same = await run({ host: "bonus", dry: false, candidates: ["1.80.2", "1.80.2"] });
    expect(same.brew.some((l) => l === "brew upgrade tailscale" || l.startsWith("brew upgrade ") && l.includes("tailscale"))).toBe(true);
  });
  test("a tailscale that is not installed is a dependency to hold: an upgrade that would pull it in waits (formula and cask), on every host", async () => {
    const f = await run({ host: "desk", formulas: "good-a", builtin: true, deps: { "good-a": "tailscale\n" } });
    expect(f.text).toContain("good-a: not upgraded this run — it depends on tailscale, which a release check gates");
    const c = await run({ host: "desk", formulas: "good-a", casks: "other-app", builtin: true, deps: { "other-app": "tailscale-app\n" } });
    expect(c.text).toContain("other-app: not upgraded this run — it depends on tailscale-app, which a release check gates");
    const free = await run({ host: "desk", formulas: "good-a", casks: "other-app", builtin: true, deps: { "other-app": "libfoo\n" } });
    expect(free.text).not.toContain("not upgraded this run — it depends on");
  });
  test("the candidate is read again right before the install: a version that moved after the cellar and trust reads installs nothing and leaves no pending record", async () => {
    const r = await run({ host: "bonus", dry: false, moveAfterCellar: "1.81.0" });
    expect(r.text).toContain("tailscale: not upgraded — brew now offers 1.81.0, the tailscale sweep decided on 1.80.2");
    expect(r.brew.some((l) => l.startsWith("brew upgrade"))).toBe(false);
    expect([...r.files.keys()].filter((k) => k.includes("release-checks/pending"))).toEqual([]);
  });
  test("a host's record of the version is removed when an attempt starts, before the install", async () => {
    const path = "/state.test/tailscale-sweep/1.80.2.json";
    const r = await run({ host: "bonus", dry: false, files: { [path]: `${JSON.stringify({ host: "bonus", version: "1.80.2", status: "verified", at: "x" })}\n` } });
    expect(r.brew.some((l) => l === "brew upgrade tailscale")).toBe(true);
    // Gone by the time brew upgrade ran (order), not only at the end.
    expect(r.filesAtUpgrade()).not.toContain(path);
  });
  test("a version installed that is not the one decided on is never verified: rolled back and held here, and no sweep record is written for a release never tested", async () => {
    const r = await run({ host: "bonus", dry: false, candidates: ["1.80.2"], installed: "1.81.0" });
    expect(r.brew).toContain("brew link tailscale");
    expect([...r.files.keys()].filter((k) => k.includes("tailscale-sweep"))).toEqual([]);
    expect([...r.files.keys()].some((k) => k.includes("release-checks/holds/tailscale"))).toBe(true);
  });
  test("the sweep lock is taken before anything else reads this host's tailscale state, and its real error is reported", async () => {
    const r = await run({ host: "bonus", dry: false, lock: "throws" });
    expect(r.text).toContain("holding tailscale (tailscale sweep: the sweep lock could not be taken (EROFS: read-only file system))");
    expect(r.locks[0]).toBe("take /state.test/tailscale-sweep/lock");
    expect(r.brew.some((l) => l.startsWith("brew upgrade"))).toBe(false);
    const ok = await run({ host: "bonus", dry: false });
    expect(ok.locks).toEqual(["take /state.test/tailscale-sweep/lock", "release /state.test/tailscale-sweep/lock"]);
  });
  test("brew changed the keg and exited nonzero: the installed version is compared to the decided one anyway, and another release is rolled back and held, never recorded", async () => {
    const r = await run({ host: "bonus", dry: false, installed: "1.81.0", upgradeRc: 1 });
    expect([...r.files.keys()].filter((k) => k.includes("tailscale-sweep"))).toEqual([]);
    expect([...r.files.keys()].some((k) => k.includes("release-checks/holds/tailscale"))).toBe(true);
    expect(r.brew).toContain("brew link tailscale");
  });
  test("a run that lost the sweep lock never cleans tailscale: no install cleanup, no explicit cleanup of it; an unreadable pending record protects it too", async () => {
    const lost = await run({ host: "bonus", dry: false, lock: false, formulas: "tailscale good-a" });
    expect(lost.optsOf("brew upgrade").length).toBeGreaterThan(0);
    expect(lost.optsOf("brew upgrade").every((o) => o?.env?.HOMEBREW_NO_INSTALL_CLEANUP === "1")).toBe(true);
    expect(lost.brew).not.toContain("brew cleanup");
    expect(lost.brew.filter((l) => l.startsWith("brew cleanup")).every((l) => !l.split(" ").includes("tailscale"))).toBe(true);
    const bad = await run({ host: "desk", dry: false, formulas: "good-a", files: { "/state.test/release-checks/pending/tailscale.json": "{" } });
    expect(bad.optsOf("brew upgrade").some((o) => o?.env?.HOMEBREW_NO_INSTALL_CLEANUP === "1")).toBe(true);
  });
  test("before anything is installed the daemon must be there, running, and on the version in use: otherwise tailscale is held with no record and no effect on the fleet", async () => {
    for (const [daemon, why] of [["none", "no tailscale daemon plist found"], ["stopped", "system/sh.brew.tailscale is not running"], ["old", "the daemon runs 1.70.0-tabc, not the 1.78.0 in use"]] as const) {
      const r = await run({ host: "bonus", dry: false, daemon });
      expect(r.text).toContain(`holding tailscale (tailscale sweep: ${why}`);
      expect(r.text).toContain("nothing is installed)");
      expect(r.brew.some((l) => l.startsWith("brew upgrade"))).toBe(false);
      expect([...r.files.keys()].filter((k) => k.includes("tailscale-sweep") || k.includes("release-checks/pending"))).toEqual([]);
    }
    // The vendor system daemon counts too; a dry run reports the turn only.
    const vendor = await run({ host: "bonus", dry: false, daemon: "none", files: { "/Library/LaunchDaemons/com.tailscale.tailscaled.plist": "" } });
    expect(vendor.brew).toContain("launchctl print system/com.tailscale.tailscaled");
    const dry = await run({ host: "bonus", daemon: "none" });
    expect(dry.text).not.toContain("nothing is installed");
  });
  const seeded = { formula: "tailscale", full: "tailscale", rack: "/brew/Cellar/tailscale", from: "1.78.0", to: "1.80.2", beforeRan: false, at: "x", upgradeStarted: true, upgraded: true, gated: "1.80.2", trusted: false };
  const PENDING_TS = "/state.test/release-checks/pending/tailscale.json";
  test("recovery with no daemon to restart could not run: no check, no record, the previous keg stays; a tap-qualified risky entry finds the plist", async () => {
    const none = await run({ host: "bonus", dry: false, formulas: "good-a", startUpgraded: true, daemon: "none", files: { [PENDING_TS]: JSON.stringify(seeded) } });
    expect(none.text).toContain("no tailscale daemon found to restart");
    expect([...none.files.keys()].filter((k) => k.includes("tailscale-sweep"))).toEqual([]);
    expect(none.files.has(PENDING_TS)).toBe(true);
    const qualified = await run({ host: "bonus", dry: false, formulas: "good-a", startUpgraded: true, risky: ["homebrew/core/tailscale"], files: { [PENDING_TS]: JSON.stringify(seeded) } });
    expect(qualified.brew).toContain("launchctl print system/sh.brew.tailscale");
  });
  test("a run that lost the lock does not touch a pending tailscale check: no recovery, no write, nothing from the stale-keg step", async () => {
    const text = JSON.stringify(seeded);
    const r = await run({ host: "bonus", dry: false, formulas: "good-a", startUpgraded: true, lock: false, files: { [PENDING_TS]: text } });
    expect(r.files.get(PENDING_TS)).toBe(text);
    expect(r.text).not.toContain("release check tailscale");
    expect(r.brew.some((l) => l.startsWith("launchctl") || l.startsWith("brew uninstall") || l === "brew link tailscale")).toBe(false);
    expect(r.optsOf("brew upgrade").every((o) => o?.env?.HOMEBREW_NO_INSTALL_CLEANUP === "1")).toBe(true);
  });
  test("a saved PASS is recovered only for the authorized version that is installed now: no authorized version (legacy) is rolled back, a host changed since the PASS publishes nothing", async () => {
    const swept = (r: { files: Map<string, string> }) => [...r.files.keys()].filter((k) => k.includes("tailscale-sweep"));
    // Legacy: a PASS and no `gated`: nothing authorized it, so it is a confirmed fail (rollback, hold), never a verified record.
    const { gated: _g, ...legacy } = seeded;
    const old = await run({ host: "bonus", dry: false, formulas: "good-a", startUpgraded: true, files: { [PENDING_TS]: JSON.stringify({ ...legacy, verdict: "pass" }) } });
    expect(old.text).toContain("with no authorized version on the record");
    expect(old.brew).toContain("brew link tailscale");
    expect(swept(old).some((k) => (old.files.get(k) ?? "").includes("verified"))).toBe(false);
    // A PASS for 1.80.2 while 1.78.0 is installed (rolled back by hand): dropped, nothing published, nothing pruned.
    const back = await run({ host: "bonus", dry: false, formulas: "good-a", startUpgraded: true, installed: "1.78.0", files: { [PENDING_TS]: JSON.stringify({ ...seeded, verdict: "pass" }) } });
    expect(back.text).toContain("the saved PASS was for 1.80.2, the installed version is 1.78.0");
    expect(swept(back).some((k) => (back.files.get(k) ?? "").includes("verified"))).toBe(false);
    expect(back.brew).not.toContain("brew link tailscale");
  });
  test("a run that lost the lock reports a tailscaled still on a deleted keg and never restarts it: the lock holder's rollback or restart is not raced", async () => {
    const lsof = "COMMAND PID USER FD TYPE DEVICE SIZE NODE NAME\nlaunchd 1 root txt REG 1,4 1 2 /sbin/launchd\ntailscaled 77 root txt REG 1,4 1 2 /brew/Cellar/tailscale/1.77.0/bin/tailscaled\n";
    const ps = { "77": { comm: "tailscaled", command: "/brew/Cellar/tailscale/1.77.0/bin/tailscaled", ppid: "1" } };
    const r = await run({ host: "bonus", dry: false, formulas: "good-a", lock: false, lsof: [lsof], ps, files: { [PENDING_TS]: JSON.stringify(seeded) } });
    expect(r.text).toContain("tailscale: its release check belongs to another run of this host (the sweep lock) — pid 77 is reported, never restarted here");
    expect(r.brew.some((l) => l.includes("kickstart") || l.startsWith("launchctl bootout"))).toBe(false);
  });
  test("a saved PASS whose sweep record is missing is published again; when that write fails the pending record is kept for the next run", async () => {
    const rec = recordPath("/state.test", "1.80.2");
    const ok1 = await run({ host: "bonus", dry: false, formulas: "good-a", startUpgraded: true, files: { [PENDING_TS]: JSON.stringify({ ...seeded, verdict: "pass" }) } });
    expect(ok1.files.get(rec)).toContain("verified");
    expect(ok1.files.has(PENDING_TS)).toBe(false);
    const bad = await run({ host: "bonus", dry: false, formulas: "good-a", startUpgraded: true, failWrite: [rec], files: { [PENDING_TS]: JSON.stringify({ ...seeded, verdict: "pass" }) } });
    expect(bad.text).toContain("could not be written");
    expect(bad.files.has(rec)).toBe(false);
    expect(bad.files.has(PENDING_TS)).toBe(true);
    // The SECOND run (the disk is fine again): the record is not ended, so the verdict is published and only then is the check over; no prune ran on the first.
    expect(JSON.parse(bad.files.get(PENDING_TS)!).ended).toBeUndefined();
    const again = await run({ host: "bonus", dry: false, formulas: "good-a", startUpgraded: true, files: Object.fromEntries(bad.files) });
    expect(again.files.get(rec)).toContain("verified");
    expect(again.files.has(PENDING_TS)).toBe(false);
  });
  test("a verified record already published for a version whose PASS is dropped (no longer installed) or converted (not authorized) is removed", async () => {
    const rec = recordPath("/state.test", "1.80.2");
    const verified = '{"host":"bonus","version":"1.80.2","status":"verified","at":"x"}\n';
    const back = await run({ host: "bonus", dry: false, formulas: "good-a", startUpgraded: true, installed: "1.78.0", files: { [PENDING_TS]: JSON.stringify({ ...seeded, verdict: "pass" }), [rec]: verified } });
    expect(back.files.has(rec)).toBe(false);
    const { gated: _g, ...legacy } = seeded;
    const old = await run({ host: "bonus", dry: false, formulas: "good-a", startUpgraded: true, files: { [PENDING_TS]: JSON.stringify({ ...legacy, verdict: "pass" }), [rec]: verified } });
    expect(old.files.has(rec)).toBe(false);
  });
  test("every plist the owner restart will require must be running before the install: a second, stale one holds the host, and a status that exits nonzero is no version", async () => {
    const both = { "/Library/LaunchDaemons/com.tailscale.tailscaled.plist": "" };
    const stale = await run({ host: "bonus", dry: false, files: both, stoppedLabel: "com.tailscale.tailscaled" });
    expect(stale.text).toContain("holding tailscale (tailscale sweep: system/com.tailscale.tailscaled is not running");
    expect(stale.brew.some((l) => l.startsWith("brew upgrade"))).toBe(false);
    const rc = await run({ host: "bonus", dry: false, statusRc: 1 });
    expect(rc.text).toContain("tailscale status exited 1, the daemon's version could not be read");
    expect(rc.brew.some((l) => l.startsWith("brew upgrade"))).toBe(false);
    // The hold is in the result, with the way out.
    expect(stale.text).toContain("tailscale held at this host's turn");
  });
  test("one label with a system plist and a user plist is one target, the system one, in the pre-check as in the restart", async () => {
    const r = await run({ host: "bonus", dry: false, files: { "/home.test/Library/LaunchAgents/sh.brew.tailscale.plist": "" } });
    expect(r.brew).toContain("launchctl print system/sh.brew.tailscale");
    expect(r.brew.some((l) => l.startsWith("launchctl print gui/"))).toBe(false);
    expect(r.brew).toContain("brew upgrade tailscale");
  });
  test("a saved FAIL is rolled back and held even when its sweep record can never be written; the pending record stays until the failed record lands, then it goes", async () => {
    const rec = recordPath("/state.test", "1.80.2");
    const bad = await run({ host: "bonus", dry: false, formulas: "good-a", startUpgraded: true, failWrite: [rec], files: { [PENDING_TS]: JSON.stringify({ ...seeded, verdict: "fail", after: "skip", tail: ["x"] }) } });
    expect(bad.brew).toContain("brew link tailscale");
    expect([...bad.files.keys()].some((k) => k.includes("release-checks/holds/tailscale"))).toBe(true);
    expect(bad.files.has(rec)).toBe(false);
    expect(bad.files.has(PENDING_TS)).toBe(true);
    // The disk is fine again: the next run publishes the failed record, though the check is over, and only then drops the pending record.
    const again = await run({ host: "bonus", dry: false, formulas: "good-a", startUpgraded: true, files: Object.fromEntries(bad.files) });
    expect(again.files.get(rec)).toContain("failed");
    expect(again.files.has(PENDING_TS)).toBe(false);
  });
  test("a verified record of a version whose PASS is dropped, or that was never authorized, is removed before anything else; a removal that fails keeps the PASS or the marker for the next run", async () => {
    const rec = recordPath("/state.test", "1.80.2");
    const verified = '{"host":"bonus","version":"1.80.2","status":"verified","at":"x"}\n';
    const dropped = await run({ host: "bonus", dry: false, formulas: "good-a", startUpgraded: true, installed: "1.78.0", failRemove: [rec], files: { [PENDING_TS]: JSON.stringify({ ...seeded, verdict: "pass" }), [rec]: verified } });
    // The removal fails: the decision is not held back (the keg in use goes on), the marker keeps asking, and the run says so.
    expect(JSON.parse(dropped.files.get(PENDING_TS)!).invalidate).toEqual(["1.80.2"]);
    expect(dropped.files.has(rec)).toBe(true);
    expect(dropped.text).toContain("still to be removed");
    const { gated: _g, ...legacy } = seeded;
    const stuck = await run({ host: "bonus", dry: false, formulas: "good-a", startUpgraded: true, failRemove: [rec], files: { [PENDING_TS]: JSON.stringify({ ...legacy, verdict: "pass" }), [rec]: verified } });
    expect(JSON.parse(stuck.files.get(PENDING_TS)!).invalidate).toEqual(["1.80.2"]);
    expect(stuck.files.has(rec)).toBe(true);
    const next = await run({ host: "bonus", dry: false, formulas: "good-a", startUpgraded: true, files: Object.fromEntries(stuck.files) });
    expect(next.files.has(rec)).toBe(false);
    expect(next.files.get(PENDING_TS)).toBeUndefined();
  });
  test("a sweep record that cannot even be read (a directory at its path) never holds the rollback back: the saved FAIL is rolled back and held, the record kept, the run flagged", async () => {
    const rec = recordPath("/state.test", "1.80.2");
    // Neither readable nor replaceable (a directory at the path): reported, the record kept.
    const r = await run({ host: "bonus", dry: false, formulas: "good-a", startUpgraded: true, failRead: [rec], failWrite: [rec], files: { [PENDING_TS]: JSON.stringify({ ...seeded, verdict: "fail", after: "skip", tail: ["x"] }) } });
    expect(r.brew).toContain("brew link tailscale");
    expect([...r.files.keys()].some((k) => k.includes("release-checks/holds/tailscale"))).toBe(true);
    expect(r.files.has(PENDING_TS)).toBe(true);
    expect(r.text).toContain("could not be read (EISDIR");
    expect(r.text).toContain("sweep record /state.test/tailscale-sweep/1.80.2.json unreadable");
    // A saved PASS: nothing is decided or pruned while it cannot be checked against its record, and the check stays pending.
    const pass = await run({ host: "bonus", dry: false, formulas: "good-a", startUpgraded: true, failRead: [rec], failWrite: [rec], files: { [PENDING_TS]: JSON.stringify({ ...seeded, verdict: "pass" }) } });
    expect(pass.files.has(PENDING_TS)).toBe(true);
    expect(pass.text).toContain("could not be read (EISDIR");
    // Unreadable but replaceable (no read permission in a writable directory): the verdict is written over it and the record is healed.
    const healed = await run({ host: "bonus", dry: false, formulas: "good-a", startUpgraded: true, failRead: [rec], files: { [PENDING_TS]: JSON.stringify({ ...seeded, verdict: "fail", after: "skip", tail: ["x"] }) } });
    expect(healed.files.get(rec)).toContain("failed");
    expect(healed.text).toContain("replaced with the failed verdict");
  });
  test("a dropped PASS whose record cannot be removed does not stop the decision: another release installed is rolled back and held, and the marker keeps asking, flagged each run", async () => {
    const rec = recordPath("/state.test", "1.80.2");
    const verified = '{"host":"bonus","version":"1.80.2","status":"verified","at":"x"}\n';
    const r = await run({ host: "bonus", dry: false, formulas: "good-a", startUpgraded: true, installed: "1.81.0", failRemove: [rec], files: { [PENDING_TS]: JSON.stringify({ ...seeded, verdict: "pass" }), [rec]: verified } });
    expect(r.brew).toContain("brew link tailscale");
    expect([...r.files.keys()].some((k) => k.includes("release-checks/holds/tailscale"))).toBe(true);
    expect(JSON.parse(r.files.get(PENDING_TS)!).invalidate).toEqual(["1.80.2"]);
    // The next run: the removal still fails, and the run says so (the host is held for that reason, not silently).
    const next = await run({ host: "bonus", dry: false, formulas: "good-a", startUpgraded: true, installed: "1.81.0", failRemove: [rec], files: Object.fromEntries(r.files) });
    expect(next.text).toContain("sweep record /state.test/tailscale-sweep/1.80.2.json");
    expect(next.text).toContain("still to be removed");
    expect(next.files.has(PENDING_TS)).toBe(true);
  });
  test("an older sweep record that cannot be removed at the start of an attempt (a directory at its path) holds the upgrade, flagged, nothing installed; the record stays marked, so a later different candidate is held too until the file is gone", async () => {
    const rec = recordPath("/state.test", "1.80.2");
    const r = await run({ host: "bonus", dry: false, candidates: ["1.80.2"], failRemove: [rec] });
    expect(r.text).toContain("could not be removed (EPERM");
    expect(r.brew.some((l) => l.startsWith("brew upgrade tailscale"))).toBe(false);
    expect(JSON.parse(r.files.get(PENDING_TS)!)).toMatchObject({ ended: true, invalidate: ["1.80.2"] });
    // A later run, another candidate: the open record holds it with that reason; once the file can be removed the record goes and the next run may upgrade.
    const next = await run({ host: "bonus", dry: false, candidates: ["1.81.0"], failRemove: [rec], files: Object.fromEntries(r.files) });
    expect(next.brew.some((l) => l.startsWith("brew upgrade tailscale"))).toBe(false);
    expect(next.text).toContain("still to be removed");
    const healed = await run({ host: "bonus", dry: false, candidates: ["1.81.0"], files: Object.fromEntries(next.files) });
    expect(healed.files.has(PENDING_TS)).toBe(false);
  });
  test("the last read before the install holds it when the version in use changed or cannot be read: no install on an unreadable baseline", async () => {
    const moved = await run({ host: "bonus", dry: false, candidates: ["1.80.2"], currentAfterCellar: "" });
    expect(moved.brew.some((l) => l.startsWith("brew upgrade tailscale"))).toBe(false);
    expect(moved.text).toContain("the opt link is missing or names no keg, not the 1.78.0 it would roll back to");
    expect(moved.files.has(PENDING_TS)).toBe(false);
  });
  test("the baseline of the tailscale check is the opt link's keg: with no opt link read, linked_keg and the one installed keg are not taken for it and nothing is installed", async () => {
    const r = await run({ host: "bonus", dry: false, candidates: ["1.80.2"], noOpt: true });
    expect(r.text).toContain("not upgraded — release check: the version in use could not be read");
    expect(r.brew.some((l) => l.startsWith("brew upgrade tailscale"))).toBe(false);
  });
  test("a version in use that moved to another readable keg between the two reads before the install holds it, naming both", async () => {
    const r = await run({ host: "bonus", dry: false, candidates: ["1.80.2"], currentAfterCellar: "1.77.0" });
    expect(r.brew.some((l) => l.startsWith("brew upgrade tailscale"))).toBe(false);
    expect(r.text).toContain("the opt link names 1.77.0, not the 1.78.0 it would roll back to");
  });
  test("the opt link gone while brew's linked_keg still names the version in use holds the install, and an unreadable one says so (never the link's old keg)", async () => {
    const gone = await run({ host: "bonus", dry: false, candidates: ["1.80.2"], optAfter: "gone" });
    expect(gone.brew.some((l) => l.startsWith("brew upgrade tailscale"))).toBe(false);
    expect(gone.text).toContain("the opt link is missing or names no keg, not the 1.78.0 it would roll back to");
    const unread = await run({ host: "bonus", dry: false, candidates: ["1.80.2"], optAfter: "unread" });
    expect(unread.brew.some((l) => l.startsWith("brew upgrade tailscale"))).toBe(false);
    expect(unread.text).toContain("the opt link could not be read, not the 1.78.0 it would roll back to");
  });
  test("a stale verified record this host wrote (a hand rollback, a removal that failed with its marker) is removed and the next candidate goes on; a failing removal or another host's record holds it", async () => {
    const rec = recordPath("/state.test", "1.80.2");
    const record = (host: string) => `${JSON.stringify({ host, version: "1.80.2", status: "verified", at: "x" })}\n`;
    const first = await run({ host: "bonus", dry: false, candidates: ["1.80.2"], failRemove: [rec], failWrite: [PENDING_TS], files: { [rec]: record("bonus") } });
    expect(first.brew.some((l) => l.startsWith("brew upgrade tailscale"))).toBe(false);
    expect(first.files.has(PENDING_TS)).toBe(false);
    // The next run is offered another version; the directory is all that remembers 1.80.2, and the host is on 1.78.0: the record is removed, not held forever.
    const next = await run({ host: "bonus", dry: false, candidates: ["1.80.3"], files: Object.fromEntries(first.files) });
    expect(next.brew.some((l) => l === "brew upgrade tailscale")).toBe(true);
    expect(next.filesAtUpgrade()).not.toContain(rec);
    // The removal still failing holds, names the path and the reason.
    const stuck = await run({ host: "bonus", dry: false, candidates: ["1.80.3"], failRemove: [rec], files: Object.fromEntries(first.files) });
    expect(stuck.brew.some((l) => l.startsWith("brew upgrade tailscale"))).toBe(false);
    expect(stuck.text).toContain(`the sweep directory still holds ${rec} (verified 1.80.2, installed 1.78.0; its removal failed:`);
    expect(stuck.files.has(PENDING_TS)).toBe(false);
    // A record that names another host is not this host's to delete: held, the host named.
    const foreign = await run({ host: "bonus", dry: false, candidates: ["1.80.3"], files: { [rec]: record("ai") } });
    expect(foreign.brew.some((l) => l.startsWith("brew upgrade tailscale"))).toBe(false);
    expect(foreign.text).toContain(`${rec} (verified 1.80.2, installed 1.78.0, written by host ai: remove it by hand if it is not this host's)`);
    expect(foreign.files.has(rec)).toBe(true);
  });
  test("a record of the candidate that names another host is held and left alone: only this host's own record is removed at the start of an attempt", async () => {
    const rec = recordPath("/state.test", "1.80.2");
    const foreign = await run({ host: "bonus", dry: false, candidates: ["1.80.2"], files: { [rec]: `${JSON.stringify({ host: "ai", version: "1.80.2", status: "verified", at: "x" })}\n` } });
    expect(foreign.brew.some((l) => l.startsWith("brew upgrade tailscale"))).toBe(false);
    expect(foreign.text).toContain(`the sweep record ${rec} of 1.80.2 was written by host ai: remove it by hand if it is not this host's`);
    expect(foreign.files.has(rec)).toBe(true);
    expect(foreign.files.has(PENDING_TS)).toBe(false);
    // A record that is hostless, not a record, or has a non-string host is not this host's either: held, named, left as it is. Only one naming this host is removed.
    const cases: [string, string, string][] = [
      [JSON.stringify({ version: "1.80.2", status: "verified", at: "x" }), "names no host", "hostless"],
      [JSON.stringify({ host: 5, version: "1.80.2", status: "verified", at: "x" }), "names no host", "non-string host"],
      ["{ not json", "is not a record", "malformed"],
      ["null", "names no host", "null"],
      [JSON.stringify({ host: "", version: "1.80.2", status: "verified", at: "x" }), "names no host", "empty host"],
    ];
    for (const [text, why, label] of cases) {
      const r = await run({ host: "bonus", dry: false, candidates: ["1.80.2"], files: { [rec]: text } });
      expect({ label, installed: r.brew.some((l) => l.startsWith("brew upgrade tailscale")) }).toEqual({ label, installed: false });
      expect(r.text).toContain(`the sweep record ${rec} of 1.80.2 ${why}: remove it by hand if it is not this host's`);
      expect(r.files.get(rec)).toBe(text);
    }
    const unreadable = await run({ host: "bonus", dry: false, candidates: ["1.80.2"], failRead: [rec], files: { [rec]: "x" } });
    expect(unreadable.brew.some((l) => l.startsWith("brew upgrade tailscale"))).toBe(false);
    expect(unreadable.text).toContain(`the sweep record ${rec} of 1.80.2 cannot be read (`);
    expect(unreadable.files.has(rec)).toBe(true);
    // This host's own record is removed and the attempt goes on.
    const own = await run({ host: "bonus", dry: false, candidates: ["1.80.2"], files: { [rec]: `${JSON.stringify({ host: "bonus", version: "1.80.2", status: "verified", at: "x" })}\n` } });
    expect(own.brew.some((l) => l === "brew upgrade tailscale")).toBe(true);
  });
  test("a marker pending for a record is processed against the file that is there now: a replacement that names another host or no host is not deleted, flagged, the marker kept; this host's own is", async () => {
    const rec = recordPath("/state.test", "1.80.2");
    const marked = { formula: "tailscale", full: "tailscale", rack: "/brew/Cellar/tailscale", from: "1.78.0", beforeRan: false, at: "x", ended: true, gated: "1.80.2", invalidate: ["1.80.2"] };
    for (const text of [JSON.stringify({ host: "ai", version: "1.80.2", status: "verified", at: "x" }), JSON.stringify({ version: "1.80.2", status: "verified", at: "x" }), "{ not json"]) {
      const r = await run({ host: "bonus", dry: false, formulas: "good-a", startUpgraded: true, files: { [PENDING_TS]: JSON.stringify(marked), [rec]: text } });
      expect(r.files.get(rec)).toBe(text);
      expect(r.text).toContain(`the sweep record ${rec} of 1.80.2`);
      expect(r.text).toContain("not removed, asked again next run");
      expect(JSON.parse(r.files.get(PENDING_TS)!).invalidate).toEqual(["1.80.2"]);
    }
    const own = await run({ host: "bonus", dry: false, formulas: "good-a", startUpgraded: true, files: { [PENDING_TS]: JSON.stringify(marked), [rec]: `${JSON.stringify({ host: "bonus", version: "1.80.2", status: "verified", at: "x" })}\n` } });
    expect(own.files.has(rec)).toBe(false);
  });
  test("a saved FAIL for a keg that is not the authorized one is uninstalled only when the opt link itself names it: with the link bad, whatever brew's fallback names, nothing is uninstalled", async () => {
    const rec = { formula: "tailscale", full: "tailscale", rack: "/brew/Cellar/tailscale", from: "1.78.0", to: "1.84.0", gated: "1.82.0", beforeRan: false, at: "x", upgradeStarted: true, upgraded: true, verdict: "fail", unauthorized: true, after: "skip", trusted: false, why: "w", tail: ["w"] };
    const bad = await run({ host: "bonus", dry: false, formulas: "good-a", startUpgraded: true, installed: "1.84.0", noOpt: true, files: { [PENDING_TS]: JSON.stringify(rec) } });
    expect(bad.text).not.toContain("uninstall tailscale");
    expect(bad.text).toContain("ROLLBACK FAILED — the opt link does not name 1.84.0 — not guessing which keg to remove; roll back by hand (docs/tailscale-upgrades.md)");
    // The opt link naming the installed keg is the evidence a rollback needs.
    const ok = await run({ host: "bonus", dry: false, formulas: "good-a", startUpgraded: true, installed: "1.84.0", files: { [PENDING_TS]: JSON.stringify(rec) } });
    expect(ok.text).toContain("uninstall tailscale — ok");
  });
  test("a rollback that finds the opt link unread uninstalls nothing and is asked again next run; the next run with the link read rolls back", async () => {
    const rec = { formula: "tailscale", full: "tailscale", rack: "/brew/Cellar/tailscale", from: "1.78.0", to: "1.80.2", gated: "1.80.2", beforeRan: false, at: "x", upgradeStarted: true, upgraded: true, verdict: "fail", after: "skip", trusted: false, why: "w", tail: ["w"] };
    const first = await run({ host: "bonus", dry: false, formulas: "good-a", startUpgraded: true, unreadOpt: true, files: { [PENDING_TS]: JSON.stringify(rec) } });
    expect(first.text).not.toContain("uninstall tailscale");
    expect(first.text).toContain("rollback waits — the opt link could not be read — nothing is uninstalled, the rollback is asked again next run");
    expect(first.text).not.toContain("ROLLBACK FAILED");
    const kept = JSON.parse(first.files.get(PENDING_TS)!);
    expect(kept.rolledBack).toBeUndefined();
    expect(kept.ended).toBeUndefined();
    const second = await run({ host: "bonus", dry: false, formulas: "good-a", startUpgraded: true, files: Object.fromEntries(first.files) });
    expect(second.text).toContain("uninstall tailscale — ok");
  });
  test("a saved FAIL with no authorized version (a legacy record) is held to the same rule for the built-in check: linked_keg naming the keg is not enough", async () => {
    const rec = { formula: "tailscale", full: "tailscale", rack: "/brew/Cellar/tailscale", from: "1.78.0", to: "1.80.2", beforeRan: false, at: "x", upgradeStarted: true, upgraded: true, verdict: "fail", after: "skip", trusted: false, why: "w", tail: ["w"] };
    const bad = await run({ host: "bonus", dry: false, formulas: "good-a", startUpgraded: true, noOpt: true, files: { [PENDING_TS]: JSON.stringify(rec) } });
    expect(bad.text).not.toContain("uninstall tailscale");
    expect(bad.text).toContain("ROLLBACK FAILED — the opt link does not name 1.80.2");
  });
  test("a saved PASS whose opt link cannot be read has its verified record removed only if it is this host's: another host's stays, the marker, the pending check and the flag too", async () => {
    const rec = recordPath("/state.test", "1.80.2");
    const saved = { ...seeded, verdict: "pass" };
    const foreign = JSON.stringify({ host: "ai", version: "1.80.2", status: "verified", at: "x" });
    const kept = await run({ host: "bonus", dry: false, formulas: "good-a", startUpgraded: true, unreadOpt: true, files: { [PENDING_TS]: JSON.stringify(saved), [rec]: foreign } });
    expect(kept.files.get(rec)).toBe(foreign);
    expect(JSON.parse(kept.files.get(PENDING_TS)!).invalidate).toEqual(["1.80.2"]);
    expect(kept.text).toContain("still to be removed");
    expect(kept.text).toContain("was written by host ai");
    const own = await run({ host: "bonus", dry: false, formulas: "good-a", startUpgraded: true, unreadOpt: true, files: { [PENDING_TS]: JSON.stringify(saved), [rec]: `${JSON.stringify({ host: "bonus", version: "1.80.2", status: "verified", at: "x" })}\n` } });
    expect(own.files.has(rec)).toBe(false);
    expect(own.files.has(PENDING_TS)).toBe(true);
    expect(own.text).toContain("the installed version could not be read — the check stays pending");
  });
  test("a record that names this host but is not a record of the version (another version, no status) is not this host's to delete either", async () => {
    const rec = recordPath("/state.test", "1.80.2");
    for (const text of [JSON.stringify({ host: "bonus", version: "1.79.0", status: "verified", at: "x" }), JSON.stringify({ host: "bonus", version: "1.80.2", at: "x" }), JSON.stringify({ host: "bonus" })]) {
      const r = await run({ host: "bonus", dry: false, candidates: ["1.80.2"], files: { [rec]: text } });
      expect(r.brew.some((l) => l.startsWith("brew upgrade tailscale"))).toBe(false);
      expect(r.text).toContain("names this host but is not a record of 1.80.2");
      expect(r.files.get(rec)).toBe(text);
    }
  });
  test("a release-check formula whose opt link is bad after the upgrade is not relinked by the generic step: it would link the newest keg left, not the authorized one", async () => {
    const r = await run({ host: "bonus", dry: false, candidates: ["1.80.2"], optAfterUpgrade: true, linkedDir: true });
    expect(r.text).not.toContain("upgraded but NOT linked");
    expect(r.text).toContain("tailscale: the opt link is not read as on a keg — not relinked or restarted here, left to its release check");
    // Nor restarted by the generic step: a daemon restarted onto a bad link stays down if the rollback is refused.
    expect(r.text).not.toContain("restarted: tailscale");
  });
  test("records that are history do not hold: an older version's, the version in use, a failed one and one that is the candidate (removed at the start of the attempt)", async () => {
    const at = (v: string, status: string) => [recordPath("/state.test", v), `${JSON.stringify({ host: "bonus", version: v, status, at: "x" })}\n`] as const;
    const files = Object.fromEntries([at("1.70.0", "verified"), at("1.78.0", "verified"), at("1.79.0", "failed"), at("1.80.3", "verified")]);
    const r = await run({ host: "bonus", dry: false, candidates: ["1.80.3"], files });
    expect(r.brew.some((l) => l === "brew upgrade tailscale")).toBe(true);
    expect(r.text).not.toContain("the sweep directory still holds");
  });
  test("a record file in the sweep directory that cannot be read holds the attempt too, and is named", async () => {
    const rec = recordPath("/state.test", "1.79.0");
    const r = await run({ host: "bonus", dry: false, candidates: ["1.80.3"], files: { [rec]: "not json" } });
    expect(r.brew.some((l) => l.startsWith("brew upgrade tailscale"))).toBe(false);
    expect(r.text).toContain(`the sweep directory still holds ${rec} (unreadable:`);
  });
  test("a saved PASS is recovered only on the opt link: a link that is missing with linked_keg on the version publishes nothing and fails it, an unread one keeps the record pending", async () => {
    const swept = (r: { files: Map<string, string> }) => [...r.files.keys()].filter((k) => k.includes("tailscale-sweep") && (r.files.get(k) ?? "").includes("verified"));
    const bad = await run({ host: "bonus", dry: false, formulas: "good-a", startUpgraded: true, noOpt: true, files: { [PENDING_TS]: JSON.stringify({ ...seeded, verdict: "pass" }) } });
    expect(swept(bad)).toEqual([]);
    expect(bad.text).toContain("the opt link names no keg of the Cellar (1.80.2 is named only by brew's other links), so 1.80.2 is not verified");
    expect(bad.files.get(PENDING_TS) ?? "").not.toContain('"verdict":"pass"');
    const unread = await run({ host: "bonus", dry: false, formulas: "good-a", startUpgraded: true, unreadOpt: true, files: { [PENDING_TS]: JSON.stringify({ ...seeded, verdict: "pass" }) } });
    expect(swept(unread)).toEqual([]);
    expect(unread.text).toContain("the installed version could not be read — the check stays pending");
    expect(unread.files.has(PENDING_TS)).toBe(true);
  });
  test("the version read after the install is the opt link's: a link gone with linked_keg on the new keg is a fail of that keg, never a verify of it", async () => {
    const r = await run({ host: "bonus", dry: false, candidates: ["1.80.2"], optAfterUpgrade: true });
    expect(r.text).toContain("the opt link names no keg of the Cellar (1.80.2 is named only by brew's other links), so 1.80.2 is not verified");
    expect([...r.files.keys()].filter((k) => k.includes("tailscale-sweep") && (r.files.get(k) ?? "").includes("verified"))).toEqual([]);
  });
  test("the marker's first save failing holds the attempt without leaving a plain record: the next run holds again, and nothing is installed either time", async () => {
    const rec = recordPath("/state.test", "1.80.2");
    const first = await run({ host: "bonus", dry: false, candidates: ["1.80.2"], failRemove: [rec], failWrite: [PENDING_TS] });
    expect(first.brew.some((l) => l.startsWith("brew upgrade tailscale"))).toBe(false);
    expect(first.files.has(PENDING_TS)).toBe(false);
    expect(first.text).toContain("the marker could not be saved");
    const second = await run({ host: "bonus", dry: false, candidates: ["1.80.2"], failRemove: [rec], failWrite: [PENDING_TS], files: Object.fromEntries(first.files) });
    expect(second.brew.some((l) => l.startsWith("brew upgrade tailscale"))).toBe(false);
    expect(second.text).toContain("could not be removed (EPERM");
  });
  test("a marker keeps every valid version of a list, a bare string is that version, `true` is the record's own candidate only, anything else is dropped", async () => {
    const load = async (rec: Record<string, unknown>) => {
      const [p] = await loadPending({ stateDir: "/s", listDir: async () => ["tailscale.json"], readFile: async () => JSON.stringify({ formula: "tailscale", full: "tailscale", rack: "/r", ...rec }) }, [], []);
      return p!.invalidate;
    };
    expect(await load({ to: "1.80.2", gated: "1.80.3", invalidate: ["1.80.1", 5] })).toEqual(["1.80.1"]);
    expect(await load({ to: "1.80.2", gated: "1.80.3", invalidate: "1.80.1" })).toEqual(["1.80.1"]);
    expect(await load({ to: "1.80.2", gated: "1.80.3", invalidate: true })).toEqual(["1.80.2"]);
    expect(await load({ gated: "1.80.3", invalidate: true })).toBeUndefined();
    expect(await load({ to: "1.80.2", invalidate: 5 })).toBeUndefined();
  });
  test("the dependency query is soft, and the legacy cask token `tailscale` is a held dependency of a cask", async () => {
    // tailscale is installed and current (not in the outdated list): only the always-held cask tokens catch the dependency.
    const r = await run({ host: "desk", formulas: "good-a", casks: "other-app", installedList: "good-a\ntailscale\n", deps: { "other-app": "tailscale\n" } });
    expect(r.optsOf("brew deps").length).toBeGreaterThan(0);
    expect(r.optsOf("brew deps").every((o) => o?.soft === true)).toBe(true);
    expect(r.text).toContain("other-app: not upgraded this run — it depends on tailscale, which a release check gates");
  });
  test("a host with a risky list never loses the previous keg to cleanup: install cleanup is off for every upgrade and the run's own cleanup leaves tailscale out, pending check or not", async () => {
    const up = (r: Awaited<ReturnType<typeof run>>) => r.optsOf("brew upgrade").map((o) => o?.env?.HOMEBREW_NO_INSTALL_CLEANUP);
    const guarded = await run({ host: "desk", dry: false, formulas: "good-a", installedList: "good-a\ntailscale\n" });
    expect(up(guarded)).toEqual(["1"]);
    expect(guarded.brew).not.toContain("brew cleanup");
    expect(guarded.brew.filter((l) => l.startsWith("brew cleanup")).every((l) => !l.split(" ").includes("tailscale"))).toBe(true);
    expect(guarded.brew.some((l) => l.startsWith("brew cleanup"))).toBe(true);
    // With no risky list nothing is protected: brew's cleanup stays as it was.
    const free = await run({ host: "desk", dry: false, formulas: "good-a", risky: [], builtin: false });
    expect(up(free)).toEqual([undefined]);
    expect(free.brew).toContain("brew cleanup");
  });
  test("a tailscaleSweepRead that is not set upgrades nothing on a host that is not first, in a real run too; the first host goes", async () => {
    for (const host of ["ai", "max", "dev"]) {
      const r = await run({ host, dry: false });
      expect(r.text).toContain("tailscaleSweepRead not set");
      expect(r.brew.some((l) => l.startsWith("brew upgrade"))).toBe(false);
    }
    expect((await run({ host: "bonus", dry: false })).brew).toContain("brew upgrade tailscale");
  });
});

describe("the check the config makes, run as the release check runs it, against a stub tailscale", () => {
  // The stub is the process edge: a shell script printing what `tailscale status --json` and `tailscale ping` print. Everything else is the real verifier
  // (tailscale-verify.ts as a subprocess) and the real release-check runner.
  const stub = (dir: string, o: { version: string; ping?: number }) => {
    const bin = join(dir, "tailscale");
    writeFileSync(bin, `#!/bin/sh\ncase "$1" in\n status) echo '{"BackendState":"Running","Version":"${o.version}","Self":{"Online":true}}';;\n ping) exit ${o.ping ?? 0};;\nesac\n`);
    chmodSync(bin, 0o755);
    return bin;
  };
  const exec = (tailscale: string): ReleaseEnv["exec"] => (argv, o) =>
    new Promise((resolve) => {
      execFile(argv[0]!, argv.slice(1), { env: { ...process.env, ...o?.env, TAILSCALE_BIN: tailscale, TAILSCALE_VERIFY_TEST: "1", TAILSCALE_VERIFY_SETTLE_MS: "0", TAILSCALE_VERIFY_RETRY_MS: "0" }, timeout: 60_000 }, (e, out, err) => {
        const code = e ? (typeof (e as NodeJS.ErrnoException).code === "number" ? ((e as NodeJS.ErrnoException).code as unknown as number) : 125) : 0;
        resolve({ rc: code, out: String(out), err: String(err) });
      });
    });
  const built = (state: string) => parseApplyConfig(cfg({ stateDir: state, host: "ai" }), "ai").releaseChecks!.find((r) => r.formula === "tailscale")!;
  const lines: string[] = [];
  const env = (e: ReleaseEnv["exec"]) => ({ exec: e, log: lines }) as unknown as ReleaseEnv;
  test("the new daemon answering: the runner's verdict is pass and the record says verified, in a file named for the version", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tsverify-"));
    const state = join(dir, "state");
    const v = await runCheck(env(exec(stub(dir, { version: "1.80.2-tabc" }))), built(state), "1.80.2", async () => ({ kind: "ok", note: "" }));
    expect(v.kind).toBe("pass");
    expect(JSON.parse(readFileSync(recordPath(state, "1.80.2"), "utf8"))).toMatchObject({ host: "ai", version: "1.80.2", status: "verified" });
    // Written whole under a name of its own and renamed: no temp file is left.
    expect(readdirSync(join(state, "tailscale-sweep"))).toEqual(["1.80.2.json"]);
    rmSync(dir, { recursive: true, force: true });
  });
  test("a tailscale that cannot be run is the runner's error verdict, with no record", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tsverify-"));
    const state = join(dir, "state");
    const v = await runCheck(env(exec(join(dir, "missing"))), built(state), "1.80.2", async () => ({ kind: "ok", note: "" }));
    expect(v.kind).toBe("error");
    expect(existsSync(recordPath(state, "1.80.2"))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("the stale sweep records of a host", () => {
  const rec = (version: string, o: { host?: string; status?: string } = {}) => JSON.stringify({ host: o.host ?? "bonus", version, status: o.status ?? "verified", at: "x" });
  const dir = recordDir("/s");
  const at = (v: string) => recordPath("/s", v);
  function env(files: Record<string, string>, o: { list?: () => string[]; failRemove?: string[] } = {}) {
    const m = new Map(Object.entries(files));
    const log: string[] = [];
    return { m, log, e: { stateDir: "/s", host: "bonus", log, listDir: async () => (o.list ? o.list() : [...m.keys()].map((k) => k.slice(dir.length + 1))), readFile: async (p: string) => m.get(p), remove: async (p: string) => { if (o.failRemove?.includes(p)) throw new Error("EPERM"); m.delete(p); } } };
  }
  test("versions are ordered as numbers (1.80.10 is newer than 1.80.9, a revision is newer than its base), so only a newer one is stale", async () => {
    const x = env({ [at("1.80.10")]: rec("1.80.10"), [at("1.80.8")]: rec("1.80.8") });
    expect(await staleSweepRecords(x.e, "1.80.9", "1.81.0")).toEqual([]);
    expect([...x.m.keys()]).toEqual([at("1.80.8")]);
    // A revision-only bump: the record of 1.80.2 is for an older version than the installed 1.80.2_1; the record of 1.80.2_1 is newer than an installed 1.80.2.
    const older = env({ [at("1.80.2")]: rec("1.80.2") });
    expect(await staleSweepRecords(older.e, "1.80.2_1", "1.80.3")).toEqual([]);
    expect([...older.m.keys()]).toEqual([at("1.80.2")]);
    const newer = env({ [at("1.80.2_1")]: rec("1.80.2_1") });
    expect(await staleSweepRecords(newer.e, "1.80.2", "1.80.3")).toEqual([]);
    expect(newer.m.size).toBe(0);
  });
  test("a directory that is not there is no record, one that exists and cannot be listed holds, and a failed record or the version in use is history", async () => {
    expect(await staleSweepRecords(env({}, { list: () => [] }).e, "1.78.0", "1.80.2")).toEqual([]);
    const denied = await staleSweepRecords(env({}, { list: () => { throw new Error("EACCES: permission denied"); } }).e, "1.78.0", "1.80.2");
    expect(denied).toEqual([`${dir} could not be listed (EACCES: permission denied)`]);
    const x = env({ [at("1.79.0")]: rec("1.79.0", { status: "failed" }), [at("1.78.0")]: rec("1.78.0") });
    expect(await staleSweepRecords(x.e, "1.78.0", "1.80.2")).toEqual([]);
    expect(x.m.size).toBe(2);
  });
});

describe("installedAbove", () => {
  const p = { formula: "tailscale", full: "tailscale", rack: "/r", from: "1.78.0", gated: "1.82.0", beforeRan: false, at: "x", upgradeStarted: true } as unknown as Parameters<typeof installedAbove>[1];
  const env = (names: string[], dirs = names) => ({ listDir: async () => names, isDir: async (d: string) => dirs.some((n) => d === `/r/${n}`) });
  test("only the keg the record authorized counts as the install that died: a newer keg kept by hand is never taken for it", async () => {
    expect(await installedAbove(env(["1.78.0", "1.82.0", "1.84.0"]), p, undefined)).toBe("1.82.0");
    expect(await installedAbove(env(["1.78.0", "1.84.0"]), p, undefined)).toBeUndefined();
    // Listed but not a directory: nothing was installed under that name.
    expect(await installedAbove(env(["1.78.0", "1.82.0"], ["1.78.0"]), p, undefined)).toBeUndefined();
    // No authorized version on the record: no guess; no install started: none.
    expect(await installedAbove(env(["1.78.0", "1.84.0"]), { ...p, gated: undefined }, undefined)).toBeUndefined();
    // What brew's fallback links name (a bad opt link) is a keg kept by hand: never blamed, whether newer or older than the previous one; the authorized one named by brew is.
    const view = (current: string) => ({ full: "tailscale", current, kegOnly: false, optState: "bad" as const });
    expect(await installedAbove(env(["1.78.0"]), p, view("1.84.0"))).toBeUndefined();
    expect(await installedAbove(env(["1.78.0"]), p, view("1.70.0"))).toBeUndefined();
    expect(await installedAbove(env(["1.78.0"]), p, view("1.82.0"))).toBe("1.82.0");
    expect(await installedAbove(env(["1.78.0", "1.82.0"]), { ...p, upgradeStarted: undefined }, undefined)).toBeUndefined();
  });
});

describe("a bad link with no keg to blame", () => {
  test("is said as it is (the link was read), flagged, and names the by-hand recipe; the rollback refusal points at it too", async () => {
    // brew's fallback links (linked_keg) may name a keg kept by hand or the previous one while the opt link is bad: neither is blamed.
    for (const linkedKeg of [null, "1.84.0", "1.78.0"]) {
    const PENDING_TS = "/state.test/release-checks/pending/tailscale.json";
    const started = { formula: "tailscale", full: "tailscale", rack: "/brew/Cellar/tailscale", from: "1.78.0", beforeRan: false, at: "x", upgradeStarted: true, gated: "1.80.2", trusted: false };
    const h = fakeHost({ formulas: "good-a", verbose: "good-a (1.0) < 1.1", formulaTaps: { "good-a": "homebrew/core" }, dirs: ["/brew/Cellar", "/brew/Cellar/tailscale/1.78.0", "/brew/Cellar/tailscale/1.84.0"], files: { "/Library/LaunchDaemons/sh.brew.tailscale.plist": "", [PENDING_TS]: JSON.stringify(started) } });
    const listDir = h.fs.listDir;
    h.fs.listDir = async (d) => (d === "/brew/Cellar/tailscale" ? ["1.78.0", "1.84.0"] : d.startsWith("/state.test/release-checks") ? [...h.files.keys()].filter((k) => k.startsWith(`${d}/`)).map((k) => k.slice(d.length + 1)) : listDir(d));
    const isDir = h.fs.isDir;
    h.fs.isDir = async (d) => d.startsWith("/brew/Cellar/tailscale/") || (await isDir(d));
    const exec: Exec = async (argv, opt) => {
      const line = argv.join(" ");
      if (line === "brew info --json=v2 tailscale") return { rc: 0, out: JSON.stringify({ formulae: [{ name: "tailscale", full_name: "tailscale", tap: "homebrew/core", linked_keg: linkedKeg, installed: [{ version: "1.78.0" }, { version: "1.84.0" }], versions: { stable: "1.80.2" } }] }), err: "" };
      if (line === "/usr/bin/readlink /brew/opt/tailscale") return { rc: 1, out: "", err: "" };
      if (line === "brew --cellar tailscale") return { rc: 0, out: "/brew/Cellar/tailscale\n", err: "" };
      if (line === "brew --prefix") return { rc: 0, out: "/brew\n", err: "" };
      if (line.startsWith("brew trust ")) return { rc: 0, out: JSON.stringify({ formulae: [] }), err: "" };
      return h.exec(argv, opt);
    };
    const res = await applyHost(testConfig({ host: "bonus", logFile: "/log.test/h.log", riskyKeepPrevious: ["tailscale"], tailscaleCanaryOrder: DEFAULT_CANARY_ORDER, releaseChecks: [{ formula: "tailscale", command: ["/opt/x/verify"], retries: 1, timeoutSec: 60, builtin: true }] }), exec, h.fs, { dryRun: false, ownerLock: { take: async () => true, release: async () => {} }, reviewer: scripted([], "APPROVE\nno attack indicators found").r, typeB: fakeTypeB(0).typeB });
    const text = [...res.log, ...res.summary].join("\n");
    // The rack holds 1.84.0 (kept by hand), not the authorized 1.80.2: nothing is blamed, nothing is held or removed for 1.84.0.
    expect(text).toContain("the opt link is missing or names no keg and no installed keg can be named — the check stays pending, nothing is rolled back");
    expect(text).not.toContain("the installed version could not be read");
    expect(text).toContain("opt link missing or on no keg, no keg to blame, check pending (manual rollback recipe in the docs)");
    expect(h.files.has(PENDING_TS)).toBe(true);
    expect([...h.files.keys()].some((k) => k.includes("holds/tailscale"))).toBe(false);
    expect(res.rc).not.toBe(0);
    expect(h.calls.filter((c) => c.startsWith("brew uninstall") || c.startsWith("brew link ") || c === "brew link")).toEqual([]);
    expect(h.files.get(PENDING_TS) ?? "").not.toContain("1.84.0");
    }
  });
  test("a version saved on the record from a fallback link is not blamed either: with the link bad and the authorized keg absent the check stays pending and records no failure for it", async () => {
    const PENDING_TS = "/state.test/release-checks/pending/tailscale.json";
    const saved = { formula: "tailscale", full: "tailscale", rack: "/brew/Cellar/tailscale", from: "1.78.0", to: "1.84.0", beforeRan: false, at: "x", upgradeStarted: true, upgraded: true, gated: "1.80.2", trusted: false };
    const h = fakeHost({ formulas: "good-a", verbose: "good-a (1.0) < 1.1", formulaTaps: { "good-a": "homebrew/core" }, dirs: ["/brew/Cellar", "/brew/Cellar/tailscale/1.78.0", "/brew/Cellar/tailscale/1.84.0"], files: { "/Library/LaunchDaemons/sh.brew.tailscale.plist": "", [PENDING_TS]: JSON.stringify(saved) } });
    const listDir = h.fs.listDir;
    h.fs.listDir = async (d) => (d === "/brew/Cellar/tailscale" ? ["1.78.0", "1.84.0"] : d.startsWith("/state.test/release-checks") ? [...h.files.keys()].filter((k) => k.startsWith(`${d}/`)).map((k) => k.slice(d.length + 1)) : listDir(d));
    const isDir = h.fs.isDir;
    h.fs.isDir = async (d) => d.startsWith("/brew/Cellar/tailscale/") || (await isDir(d));
    const exec: Exec = async (argv, opt) => {
      const line = argv.join(" ");
      if (line === "brew info --json=v2 tailscale") return { rc: 0, out: JSON.stringify({ formulae: [{ name: "tailscale", full_name: "tailscale", tap: "homebrew/core", linked_keg: "1.84.0", installed: [{ version: "1.78.0" }, { version: "1.84.0" }], versions: { stable: "1.80.2" } }] }), err: "" };
      if (line === "/usr/bin/readlink /brew/opt/tailscale") return { rc: 1, out: "", err: "" };
      if (line === "brew --cellar tailscale") return { rc: 0, out: "/brew/Cellar/tailscale\n", err: "" };
      if (line === "brew --prefix") return { rc: 0, out: "/brew\n", err: "" };
      if (line.startsWith("brew trust ")) return { rc: 0, out: JSON.stringify({ formulae: [] }), err: "" };
      return h.exec(argv, opt);
    };
    const res = await applyHost(testConfig({ host: "bonus", logFile: "/log.test/h.log", riskyKeepPrevious: ["tailscale"], tailscaleCanaryOrder: DEFAULT_CANARY_ORDER, releaseChecks: [{ formula: "tailscale", command: ["/opt/x/verify"], retries: 1, timeoutSec: 60, builtin: true }] }), exec, h.fs, { dryRun: false, ownerLock: { take: async () => true, release: async () => {} }, reviewer: scripted([], "APPROVE\nno attack indicators found").r, typeB: fakeTypeB(0).typeB });
    const text = [...res.log, ...res.summary].join("\n");
    expect(text).toContain("the opt link is missing or names no keg and no installed keg can be named");
    expect(JSON.parse(h.files.get(PENDING_TS)!).verdict).toBeUndefined();
    expect([...h.files.keys()].some((k) => k.includes("holds/tailscale"))).toBe(false);
  });
  test("the rollback that does not guess names the by-hand recipe", async () => {
    const h = fakeHost({ formulas: "good-a", verbose: "good-a (1.0) < 1.1", formulaTaps: { "good-a": "homebrew/core" } });
    const log: string[] = [];
    const exec: Exec = async (argv) => {
      const line = argv.join(" ");
      if (line === "brew info --json=v2 tailscale") return { rc: 0, out: JSON.stringify({ formulae: [{ name: "tailscale", full_name: "tailscale", linked_keg: null, installed: [{ version: "1.78.0" }, { version: "1.80.2" }] }] }), err: "" };
      return { rc: 1, out: "", err: "" };
    };
    const r = await rollback({ exec, brew: "brew", stateDir: "/s", host: "bonus", readFile: async () => undefined, writeFile: async () => {}, remove: async () => {}, isDir: async () => true, listDir: async () => ["1.78.0", "1.80.2"], notify: async () => {}, log, stamp: "x" }, { formula: "tailscale", full: "tailscale", rack: "/r", from: "1.78.0", to: "1.80.2", beforeRan: false, at: "x" });
    expect(h.calls).toEqual([]);
    expect(r).toMatchObject({ ok: false, removed: false });
    expect((r as { why: string }).why).toBe("brew uses nothing readable, not 1.80.2 — not guessing which keg to remove; roll back by hand (docs/tailscale-upgrades.md)");
  });
});

describe("failOptLink", () => {
  const env = () => ({ writeFile: async () => {}, readFile: async () => undefined, remove: async () => {}, stateDir: "/s", host: "bonus", stamp: "x", log: [] as string[] });
  test("a record whose version is the one to roll back to is no upgrade: nothing is failed or invalidated for it", async () => {
    const p = { formula: "tailscale", full: "tailscale", rack: "/r", from: "1.78.0", to: "1.78.0", beforeRan: false, at: "x" } as unknown as Parameters<typeof failOptLink>[1];
    expect(await failOptLink(env(), p, async () => {})).toBe(false);
    expect(p.verdict).toBeUndefined();
    expect(p.invalidate).toBeUndefined();
    const up = { ...p, to: "1.80.2" } as typeof p;
    expect(await failOptLink(env(), up, async () => {})).toBe(true);
    expect(up).toMatchObject({ verdict: "fail", unauthorized: true, to: "1.80.2" });
    // The record is not there to be deleted: the removal path ran and the marker is cleared (not left by a read that failed).
    expect(up.invalidate).toBeUndefined();
  });
});

describe("an interrupted install (upgradeStarted, no version on the record)", () => {
  const PENDING_TS = "/state.test/release-checks/pending/tailscale.json";
  const started = { formula: "tailscale", full: "tailscale", rack: "/brew/Cellar/tailscale", from: "1.78.0", beforeRan: false, at: "x", upgradeStarted: true, gated: "1.80.2", trusted: false };
  test("a link that is confirmed bad with a newer keg in the rack is a fail of that keg: decided and held, the rollback reported, never waited on", async () => {
    const files = { [PENDING_TS]: JSON.stringify(started) };
    const h = fakeHost({ formulas: "good-a", verbose: "good-a (1.0) < 1.1", formulaTaps: { "good-a": "homebrew/core" }, dirs: ["/brew/Cellar", "/brew/Cellar/tailscale/1.78.0", "/brew/Cellar/tailscale/1.80.2"], files: { "/Library/LaunchDaemons/sh.brew.tailscale.plist": "", ...files } });
    const listDir = h.fs.listDir;
    h.fs.listDir = async (d) => (d === "/brew/Cellar/tailscale" ? ["1.78.0", "1.80.2"] : d.startsWith("/state.test/release-checks") ? [...h.files.keys()].filter((k) => k.startsWith(`${d}/`)).map((k) => k.slice(d.length + 1)) : listDir(d));
    const isDir = h.fs.isDir;
    h.fs.isDir = async (d) => d.startsWith("/brew/Cellar/tailscale/") || (await isDir(d));
    const exec: Exec = async (argv, opt) => {
      const line = argv.join(" ");
      if (line === "brew info --json=v2 tailscale") return { rc: 0, out: JSON.stringify({ formulae: [{ name: "tailscale", full_name: "tailscale", tap: "homebrew/core", linked_keg: null, installed: [{ version: "1.78.0" }, { version: "1.80.2" }], versions: { stable: "1.80.2" } }] }), err: "" };
      if (line === "/usr/bin/readlink /brew/opt/tailscale") return { rc: 1, out: "", err: "" };
      if (line === "brew --cellar tailscale") return { rc: 0, out: "/brew/Cellar/tailscale\n", err: "" };
      if (line === "brew --prefix") return { rc: 0, out: "/brew\n", err: "" };
      if (line.startsWith("brew trust ")) return { rc: 0, out: JSON.stringify({ formulae: [] }), err: "" };
      return h.exec(argv, opt);
    };
    const res = await applyHost(testConfig({ host: "bonus", logFile: "/log.test/h.log", riskyKeepPrevious: ["tailscale"], tailscaleCanaryOrder: DEFAULT_CANARY_ORDER, releaseChecks: [{ formula: "tailscale", command: ["/opt/x/verify"], retries: 1, timeoutSec: 60, builtin: true }] }), exec, h.fs, { dryRun: false, ownerLock: { take: async () => true, release: async () => {} }, reviewer: scripted([], "APPROVE\nno attack indicators found").r, typeB: fakeTypeB(0).typeB });
    const text = [...res.log, ...res.summary].join("\n");
    expect(text).toContain("the opt link names no keg of the Cellar (1.80.2 is named only by brew's other links), so 1.80.2 is not verified");
    expect([...h.files.keys()].some((k) => k.includes("release-checks/holds/tailscale"))).toBe(true);
    // brew names no keg in use, so the rollback does not guess which keg to remove: it is reported, never waited on.
    expect(text).toContain("ROLLBACK FAILED — the opt link does not name 1.80.2 — not guessing which keg to remove");
  });
});

describe("the invalidation marker", () => {
  test("a pending record that cannot be saved after the removal does not throw: the file is gone and the marker only asks once more", async () => {
    const p = { formula: "tailscale", invalidate: ["1.80.2"] } as unknown as Parameters<typeof invalidateRecord>[1];
    const log: string[] = [];
    const removed: string[] = [];
    const ok = await invalidateRecord({ readFile: async () => undefined, host: "bonus", remove: async (x: string) => void removed.push(x), stateDir: "/state.test", log }, p, async () => { throw new Error("ENOSPC"); });
    expect(ok).toBe(true);
    expect(removed).toEqual([recordPath("/state.test", "1.80.2")]);
    expect(log.join("\n")).toContain("could not be saved after the removal (ENOSPC)");
  });
});

describe("pruning older kegs after a pass", () => {
  const P = { formula: "tailscale", full: "tailscale", rack: "/c/Cellar/tailscale", from: "1.78.0", to: "1.80.2", at: "x", beforeRan: false } as unknown as Parameters<typeof pruneOlderKegs>[1];
  /** An env over a scripted cellar: `names` listed, `links` the paths that are symlinks, `real` the realpath answers, `live` the keg brew's links name now. */
  function env(o: { names: string[]; links?: string[]; real?: Record<string, string>; live?: string; cellar?: string; opt?: string | null | "unread"; linked?: string | null; rmRc?: number }) {
    const calls: string[] = [];
    const log: string[] = [];
    const e = {
      brew: "brew", log,
      exec: (async (argv: string[]) => {
        const line = argv.join(" ");
        calls.push(line);
        if (line === "brew --cellar") return { rc: 0, out: `${o.cellar ?? "/c/Cellar"}\n`, err: "" };
        if (line === "brew info --json=v2 tailscale") return { rc: 0, out: JSON.stringify({ formulae: [{ name: "tailscale", full_name: "tailscale", ...((o.linked === undefined ? (o.live ?? "1.80.2") : o.linked) ? { linked_keg: o.linked === undefined ? (o.live ?? "1.80.2") : o.linked } : {}), installed: [{ version: "1.80.2" }, { version: "1.78.0" }] }] }), err: "" };
        if (line === "brew --prefix") return { rc: 0, out: "/c\n", err: "" };
        if (argv[0] === "/bin/rm") return { rc: o.rmRc ?? 0, out: "", err: "" };
        if (argv[0] === "/usr/bin/readlink") return o.opt === "unread" ? { rc: 124, out: "", err: "" } : o.opt === null ? { rc: 1, out: "", err: "" } : { rc: 0, out: `../Cellar/tailscale/${o.opt ?? o.live ?? "1.80.2"}\n`, err: "" };
        return { rc: 0, out: "", err: "" };
      }) as Exec,
      listDir: async () => o.names,
      isDir: async () => true,
      realPath: async (p: string) => o.real?.[p] ?? p,
      isSymlink: async (p: string) => (o.links ?? []).includes(p),
    };
    return { e, calls, log, rm: () => calls.filter((c) => c.startsWith("/bin/rm")) };
  }
  test("only version-shaped names are removed; the verified and the previous keg stay; a README or dotfile is not a keg", async () => {
    const x = env({ names: ["1.70.0", "1.78.0", "1.80.2", "README", ".DS_Store", "1.7.0_1", "x1.2", "1.2.3.bak"] });
    await pruneOlderKegs(x.e, P);
    expect(x.rm()).toEqual(["/bin/rm -rf /c/Cellar/tailscale/1.7.0_1", "/bin/rm -rf /c/Cellar/tailscale/1.70.0"]);
  });
  test("a rack that resolves outside the real Cellar, or not to the package's own directory, removes nothing", async () => {
    const out = env({ names: ["1.70.0"], real: { "/c/Cellar/tailscale": "/elsewhere/tailscale" } });
    await pruneOlderKegs(out.e, P);
    expect(out.rm()).toEqual([]);
    const other = env({ names: ["1.70.0"], real: { "/c/Cellar/tailscale": "/c/Cellar/other" } });
    await pruneOlderKegs(other.e, P);
    expect(other.rm()).toEqual([]);
  });
  test("either link keeps its keg: brew's linked_keg too, and with neither link readable nothing is pruned; a keg newer than the verified one stays and does not stop older ones being pruned", async () => {
    const linked = env({ names: ["1.60.0", "1.62.0"], opt: "1.80.2", linked: "1.62.0" });
    await pruneOlderKegs(linked.e, P);
    expect(linked.rm()).toEqual(["/bin/rm -rf /c/Cellar/tailscale/1.60.0"]);
    const opt = env({ names: ["1.60.0", "1.62.0"], opt: "1.62.0", linked: "1.80.2" });
    await pruneOlderKegs(opt.e, P);
    expect(opt.rm()).toEqual(["/bin/rm -rf /c/Cellar/tailscale/1.60.0"]);
    const none = env({ names: ["1.60.0"], opt: null, linked: null });
    // Said, not silent: the caller flags the result with it.
    expect(await pruneOlderKegs(none.e, P)).toContain("its opt link is missing or names no keg");
    expect(none.rm()).toEqual([]);
    // opt unknown (prefix or link unreadable) while linked_keg names another keg: the keg opt names is unknown, so nothing is pruned.
    const unknownOpt = env({ names: ["1.60.0", "1.62.0"], opt: null, linked: "1.62.0" });
    await pruneOlderKegs(unknownOpt.e, P);
    expect(unknownOpt.rm()).toEqual([]);
    const newer = env({ names: ["1.60.0", "1.90.0"] });
    await pruneOlderKegs(newer.e, P);
    expect(newer.rm()).toEqual(["/bin/rm -rf /c/Cellar/tailscale/1.60.0"]);
  });
  test("the text of a dangling opt link is no installed version: with the directory check the keg must be there", async () => {
    const exec: Exec = async (argv) => {
      const line = argv.join(" ");
      if (line === "brew info --json=v2 tailscale") return { rc: 0, out: JSON.stringify({ formulae: [{ name: "tailscale", full_name: "tailscale", linked_keg: "1.78.0", installed: [{ version: "1.78.0" }] }] }), err: "" };
      if (line === "brew --prefix") return { rc: 0, out: "/c\n", err: "" };
      if (line === "brew --cellar") return { rc: 0, out: "/c/Cellar\n", err: "" };
      if (argv[0] === "/usr/bin/readlink") return { rc: 0, out: "../Cellar/tailscale/1.80.2\n", err: "" };
      return { rc: 1, out: "", err: "" };
    };
    expect((await brewView(exec, "brew", "tailscale"))?.current).toBe("1.80.2");
    expect((await brewView(exec, "brew", "tailscale", { isDir: async (d) => d !== "/c/Cellar/tailscale/1.80.2" }))?.current).toBe("1.78.0");
    // An absolute link target is the path itself, not under opt; the linked_keg fallback needs its directory in the Cellar too.
    const abs: Exec = async (argv) => (argv[0] === "/usr/bin/readlink" ? { rc: 0, out: "/c/Cellar/tailscale/1.80.2\n", err: "" } : exec(argv));
    const seen: string[] = [];
    expect((await brewView(abs, "brew", "tailscale", { isDir: async (d) => (seen.push(d), d === "/c/Cellar/tailscale/1.80.2") }))?.opt).toBe("1.80.2");
    expect(seen[0]).toBe("/c/Cellar/tailscale/1.80.2");
    // A Cellar that is not <prefix>/Cellar (brew says where it is): the kegs there count, and one that brew --cellar does not name does not.
    const elsewhere: Exec = async (argv) => (argv.join(" ") === "brew --cellar" ? { rc: 0, out: "/mnt/Cellar\n", err: "" } : argv[0] === "/usr/bin/readlink" ? { rc: 0, out: "/mnt/Cellar/tailscale/1.80.2\n", err: "" } : exec(argv));
    expect((await brewView(elsewhere, "brew", "tailscale", { isDir: async (d) => d.startsWith("/mnt/Cellar/tailscale/") }))?.current).toBe("1.80.2");
    expect((await brewView(async (argv) => (argv.join(" ") === "brew --cellar" ? { rc: 1, out: "", err: "" } : exec(argv)), "brew", "tailscale", { isDir: async () => true }))?.current).toBeUndefined();
    // Containment: the keg must resolve to <real Cellar>/<package>/<version>; an unreadable prefix loses the opt link, an unreadable Cellar loses every keg.
    const real = (m: Record<string, string>) => async (d: string) => m[d] ?? d;
    expect((await brewView(exec, "brew", "tailscale", { isDir: async () => true, realPath: real({ "/c/Cellar/tailscale/1.80.2": "/elsewhere/1.80.2" }) }))?.opt).toBeUndefined();
    expect((await brewView(exec, "brew", "tailscale", { isDir: async () => true, realPath: real({ "/c/Cellar": "/mnt/Cellar", "/c/Cellar/tailscale/1.80.2": "/mnt/Cellar/tailscale/1.80.2" }) }))?.opt).toBe("1.80.2");
    const noPrefix: Exec = async (argv) => (argv.join(" ") === "brew --prefix" ? { rc: 1, out: "", err: "" } : exec(argv));
    // The opt link needs the prefix; the kegs brew names itself need only the Cellar it reports.
    const np = await brewView(noPrefix, "brew", "tailscale", { isDir: async () => true });
    expect([np?.opt, np?.current]).toEqual([undefined, "1.78.0"]);
    expect((await brewView(noPrefix, "brew", "tailscale"))?.current).toBe("1.78.0");
    const nothing = await brewView(async (argv) => (argv[0] === "/usr/bin/readlink" ? { rc: 1, out: "", err: "" } : exec(argv)), "brew", "tailscale", { isDir: async () => false });
    expect(nothing?.current).toBeUndefined();
  });
  test("a stat or realpath that fails for a reason other than the path not being there says nothing: the opt link is unread, not bad", async () => {
    const exec: Exec = async (argv) => {
      const line = argv.join(" ");
      if (line === "brew info --json=v2 tailscale") return { rc: 0, out: JSON.stringify({ formulae: [{ name: "tailscale", full_name: "tailscale", linked_keg: "1.78.0", installed: [{ version: "1.78.0" }] }] }), err: "" };
      if (line === "brew --prefix") return { rc: 0, out: "/c\n", err: "" };
      if (line === "brew --cellar") return { rc: 0, out: "/c/Cellar\n", err: "" };
      if (argv[0] === "/usr/bin/readlink") return { rc: 0, out: "../Cellar/tailscale/1.78.0\n", err: "" };
      return { rc: 1, out: "", err: "" };
    };
    const eacces = (p: string) => async (d: string) => {
      if (d === p) throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      return d;
    };
    const denied = await brewView(exec, "brew", "tailscale", { isDir: async () => true, realPath: eacces("/c/Cellar/tailscale/1.78.0") });
    expect(denied?.optState).toBe("unread");
    expect(denied?.opt).toBeUndefined();
    // The same path positively not there (the realpath says so) is a bad link.
    const missing = await brewView(exec, "brew", "tailscale", { isDir: async () => true, realPath: async (d) => (d === "/c/Cellar/tailscale/1.78.0" ? undefined : d) });
    expect(missing?.optState).toBe("bad");
    // A directory check that says it is not one is a bad link too.
    expect((await brewView(exec, "brew", "tailscale", { isDir: async () => false, realPath: async (d) => d }))?.optState).toBe("bad");
    expect((await brewView(exec, "brew", "tailscale", { isDir: async () => true, realPath: async (d) => d }))?.optState).toBe("ok");
  });
  test("readlink exit 1 is a missing link only when the path is looked up again and is not there: a denied parent is unread (through the real filesystem, as /usr/bin/readlink says nothing for either)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "optlink-"));
    try {
      const prefix = join(dir, "pfx");
      mkdirSync(join(prefix, "Cellar", "tailscale", "1.78.0"), { recursive: true });
      // brew's own answers; readlink exits 1 with no message, as the real one does for a missing path, a file, and a mode-000 parent alike.
      const exec: Exec = async (argv) => {
        const line = argv.join(" ");
        if (line === "brew info --json=v2 tailscale") return { rc: 0, out: JSON.stringify({ formulae: [{ name: "tailscale", full_name: "tailscale", linked_keg: "1.78.0", installed: [{ version: "1.78.0" }] }] }), err: "" };
        if (line === "brew --prefix") return { rc: 0, out: `${prefix}\n`, err: "" };
        if (line === "brew --cellar") return { rc: 0, out: `${join(prefix, "Cellar")}\n`, err: "" };
        if (argv[0] === "/usr/bin/readlink") return { rc: 1, out: "", err: "" };
        return { rc: 1, out: "", err: "" };
      };
      const keg = { isDir: realFs.isDir, realPath: realFs.realPath };
      // No opt directory at all: the link is truly missing.
      expect((await brewView(exec, "brew", "tailscale", keg))?.optState).toBe("bad");
      // An opt directory with no link in it: missing too.
      mkdirSync(join(prefix, "opt"));
      expect((await brewView(exec, "brew", "tailscale", keg))?.optState).toBe("bad");
      // A dangling link: readlink would succeed, but a failed one is looked up the same way: missing.
      symlinkSync(join(dir, "nowhere"), join(prefix, "opt", "tailscale"));
      expect((await brewView(exec, "brew", "tailscale", keg))?.optState).toBe("bad");
      rmSync(join(prefix, "opt", "tailscale"));
      // The parent that cannot be looked into: the link may well be there, nothing is known.
      if (process.getuid?.() !== 0) {
        symlinkSync(join(prefix, "Cellar", "tailscale", "1.78.0"), join(prefix, "opt", "tailscale"));
        chmodSync(join(prefix, "opt"), 0);
        const denied = await brewView(exec, "brew", "tailscale", keg);
        expect(denied?.optState).toBe("unread");
        expect(denied?.opt).toBeUndefined();
      }
    } finally {
      // Restored when it was locked; a test that failed before the directory existed must not have its failure hidden by this.
      try {
        chmodSync(join(dir, "pfx", "opt"), 0o700);
      } catch {
        // Nothing was locked.
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test("the real realpath answers undefined for a path that is not there (missing, dangling, a file in the way) and throws for one it could not look at", async () => {
    const dir = mkdtempSync(join(tmpdir(), "realpath-"));
    try {
      writeFileSync(join(dir, "file"), "x");
      symlinkSync(join(dir, "nowhere"), join(dir, "dangling"));
      mkdirSync(join(dir, "locked"));
      writeFileSync(join(dir, "locked", "inner"), "x");
      expect(await realFs.realPath!(join(dir, "missing"))).toBeUndefined();
      expect(await realFs.realPath!(join(dir, "dangling"))).toBeUndefined();
      expect(await realFs.realPath!(join(dir, "file", "below"))).toBeUndefined();
      expect(await realFs.realPath!(join(dir, "file"))).toContain("file");
      // Root reads through a mode-0 directory: only a user that is not root can see the failure.
      if (process.getuid?.() !== 0) {
        chmodSync(join(dir, "locked"), 0);
        await expect(realFs.realPath!(join(dir, "locked", "inner"))).rejects.toMatchObject({ code: "EACCES" });
      }
    } finally {
      chmodSync(join(dir, "locked"), 0o700);
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test("a prune that left a keg is said so: an opt link that is unreadable says so, a missing one says that, and an rm that failed is named", async () => {
    expect(await pruneOlderKegs(env({ names: ["1.60.0"], opt: "unread", linked: null }).e, P)).toContain("its opt link could not be read");
    expect(await pruneOlderKegs(env({ names: ["1.60.0"], opt: null, linked: null }).e, P)).toContain("its opt link is missing or names no keg");
    const failed = env({ names: ["1.60.0"], rmRc: 1 });
    expect(await pruneOlderKegs(failed.e, P)).toBe("the older keg 1.60.0 could not be removed (rm rc 1)");
    expect(failed.log.join("\n")).toContain("the older keg 1.60.0 NOT removed (rm FAILED rc 1)");
    expect(await pruneOlderKegs(env({ names: ["1.60.0"] }).e, P)).toBeUndefined();
  });
  test("a symlink in the rack, or an entry that resolves elsewhere, is never removed; neither is the keg brew's links name now", async () => {
    const x = env({ names: ["1.60.0", "1.61.0", "1.62.0"], links: ["/c/Cellar/tailscale/1.60.0"], real: { "/c/Cellar/tailscale/1.61.0": "/etc/1.61.0" } });
    await pruneOlderKegs(x.e, P);
    expect(x.rm()).toEqual(["/bin/rm -rf /c/Cellar/tailscale/1.62.0"]);
    const live = env({ names: ["1.60.0", "1.62.0"], live: "1.62.0" });
    await pruneOlderKegs(live.e, P);
    expect(live.rm()).toEqual(["/bin/rm -rf /c/Cellar/tailscale/1.60.0"]);
  });
});
