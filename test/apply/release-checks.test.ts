// Release checks (release-checks.ts): the verdict, the rollback through brew and the hold, against a
// scripted exec. The run's wiring (before/after, the hold filter, cleanup, dry run) is in run.test.ts.
import { describe, expect, test } from "bun:test";
import type { ReleaseCheck } from "../../src/apply/config.ts";
import type { Exec } from "../../src/apply/exec.ts";
import { join } from "node:path";
import { asUser, holdPath, resume, runCheck, type KegProcs, type PendingCheck, type ReleaseEnv } from "../../src/apply/release-checks.ts";

/** resume from an upgraded record whose owner was restarted, with every step saved in memory; `st.after` mirrors the record's. */
async function decide(e: ReleaseEnv, rc: ReleaseCheck, p: PendingCheck & { to: string }, restart: (keg: string) => Promise<{ ok: boolean; note: string }>, st: { after?: "run" | "skip" }) {
  const rec = { ...p, ownerRestarted: true };
  const d = await resume(e, rc, rec, {
    save: async () => void (st.after = rec.after),
    restartOwner: async () => {
      const r = await restart(join(rec.rack, rec.to));
      return { kind: r.ok ? "ok" : "failed", note: r.note };
    },
    scan: async () => [],
    stopping: () => false,
  });
  st.after = rec.after;
  return d;
}

const CHECK: ReleaseCheck = { formula: "example/tap/splash", command: ["/opt/gate.test/check"], retries: 1, timeoutSec: 900 };
const P: PendingCheck & { to: string } = { formula: "splash", full: "example/tap/splash", rack: "/brew/Cellar/splash", from: "1.2.0", to: "1.3.0", beforeRan: false, at: "2026-10-26 04:00" };

interface Script {
  /** Check exits, in order, per GATE_VERSION. */
  check?: Record<string, (number | "timeout")[]>;
  dirs?: string[];
  trusted?: string[];
  rc?: Record<string, number>;
  /** The opt link's version at the start (default 1.3.0; "" none). */
  linked?: string;
  /** Kegs installed at the start (default 1.2.0 and 1.3.0). */
  kegs?: string[];
}

function env(s: Script = {}) {
  const calls: string[] = [];
  const envs: (Record<string, string> | undefined)[] = [];
  const files = new Map<string, string>();
  const notices: string[] = [];
  let linked = s.linked ?? "1.3.0";
  const kegs = new Set(s.kegs ?? ["1.2.0", "1.3.0"]);
  const queue = Object.fromEntries(Object.entries(s.check ?? {}).map(([k, v]) => [k, [...v]]));
  const exec: Exec = async (argv, o = {}) => {
    const line = argv.join(" ");
    calls.push(line);
    envs.push(o.env);
    if (s.rc?.[line] !== undefined) return { rc: s.rc[line]!, out: "", err: "" };
    if (argv.at(-1) === "/opt/gate.test/check") {
      const v = o.env?.GATE_VERSION ?? "?";
      const next = queue[v]?.shift() ?? 0;
      if (next === "timeout") return { rc: 124, out: "", err: "", timedOut: true };
      return { rc: next, out: `score ${v} attempt\nfinal score 0.${next}\n`, err: "" };
    }
    if (line === "/usr/bin/readlink /brew/opt/splash") return linked ? { rc: 0, out: `../Cellar/splash/${linked}\n`, err: "" } : { rc: 1, out: "", err: "" };
    if (argv[0] === "brew") {
      const rest = argv.slice(1).join(" ");
      if (rest === "--prefix") return { rc: 0, out: "/brew\n", err: "" };
      if (rest.startsWith("info --json=v2")) return { rc: 0, out: JSON.stringify({ formulae: [{ full_name: "example/tap/splash", linked_keg: linked || null, installed: [...kegs].sort().map((version) => ({ version })), versions: { stable: "1.3.0" }, revision: 0 }] }), err: "" };
      if (rest === "trust --formula --json=v1") return { rc: 0, out: JSON.stringify(s.trusted ?? []), err: "" };
      if (rest === "uninstall example/tap/splash") {
        kegs.delete(linked);
        linked = "";
        return { rc: 0, out: "", err: "" };
      }
      if (rest === "link example/tap/splash") {
        linked = [...kegs].sort().at(-1) ?? "";
        return { rc: 0, out: "", err: "" };
      }
      if (rest.startsWith("trust --formula ")) return { rc: 0, out: "", err: "" };
    }
    return { rc: 99, out: "", err: `UNEXPECTED ${line}` };
  };
  const dirs = new Set(s.dirs ?? ["/brew/Cellar/splash/1.2.0", "/brew/Cellar/splash/1.3.0"]);
  const e: ReleaseEnv = {
    exec, brew: "brew", stateDir: "/state.test", host: "host-a", logFile: "/log.test",
    readFile: async (p) => files.get(p),
    writeFile: async (p, t) => void files.set(p, t),
    remove: async (p) => void files.delete(p),
    isDir: async (p) => dirs.has(p),
    listDir: async () => [],
    notify: async (t) => void notices.push(t),
    log: [],
    stamp: "2026-10-26 04:00",
  };
  const restarts: string[] = [];
  const restartOwner = async (keg: string) => {
    restarts.push(keg);
    return { ok: true, note: "" };
  };
  return { e, calls, envs, files, notices, restarts, restartOwner, linked: () => linked };
}

const HOLD = holdPath("/state.test", "splash");
/** A gate that lets every attempt run. */
const OPEN = async () => ({ kind: "ok" as const, note: "" });

describe("runCheck", () => {
  test("PASS at exit 0, with GATE_VERSION set to the version checked", async () => {
    const h = env();
    expect((await runCheck(h.e, CHECK, "1.3.0", OPEN)).kind).toBe("pass");
    expect(h.envs[0]).toEqual({ GATE_VERSION: "1.3.0" });
    expect(h.calls).toEqual(["/opt/gate.test/check"]);
  });
  test("FAIL then PASS on the retry is a PASS", async () => {
    const h = env({ check: { "1.3.0": [1, 0] } });
    const v = await runCheck(h.e, CHECK, "1.3.0", OPEN);
    expect(v).toMatchObject({ kind: "pass", attempts: 2 });
  });
  test("FAIL on every attempt (1 + retries) is a confirmed fail", async () => {
    const h = env({ check: { "1.3.0": [1, 1, 1] } });
    expect(await runCheck(h.e, { ...CHECK, retries: 2 }, "1.3.0", OPEN)).toMatchObject({ kind: "fail", attempts: 3 });
  });
  test("exit 2 or a timeout is could-not-run, never retried", async () => {
    expect(await runCheck(env({ check: { "1.3.0": [2] } }).e, CHECK, "1.3.0", OPEN)).toMatchObject({ kind: "error", why: "rc 2", attempts: 1 });
    expect(await runCheck(env({ check: { "1.3.0": ["timeout"] } }).e, CHECK, "1.3.0", OPEN)).toMatchObject({ kind: "error", why: "timeout", attempts: 1 });
  });
  test("runAs: through sudo -n -u <user> -H, keeping GATE_VERSION", async () => {
    const h = env();
    await runCheck(h.e, { ...CHECK, runAs: "gate" }, "1.3.0", OPEN);
    expect(h.calls).toEqual(["/usr/bin/sudo -n -u gate -H --preserve-env=GATE_VERSION -- /opt/gate.test/check"]);
    expect(asUser(CHECK, ["x"])).toEqual(["x"]);
  });
  test("the gate runs right before every attempt, a retry as much as the first", async () => {
    const h = env({ check: { "1.3.0": [1, 1, 0] } });
    const order: string[] = [];
    const exec = h.e.exec;
    h.e.exec = async (argv, o) => (order.push("check"), exec(argv, o));
    const v = await runCheck(h.e, { ...CHECK, retries: 2 }, "1.3.0", async () => (order.push("gate"), { kind: "ok", note: "" }));
    expect(v).toMatchObject({ kind: "pass", attempts: 3 });
    expect(order).toEqual(["gate", "check", "gate", "check", "gate", "check"]);
  });
  test("a gate that blocks a retry: blocked, the retry not run, the FAIL before it no verdict", async () => {
    const h = env({ check: { "1.3.0": [1, 0] } });
    const answers = [{ kind: "ok" as const, note: "" }, { kind: "busy" as const, note: "pid 9 still maps x" }];
    const v = await runCheck(h.e, CHECK, "1.3.0", async () => answers.shift()!);
    expect(v).toEqual({ kind: "blocked", gate: { kind: "busy", note: "pid 9 still maps x" }, attempts: 1 });
    expect(h.calls).toEqual(["/opt/gate.test/check"]);
    expect(h.e.log.at(-1)).toContain("attempt 2/2 not run (gate busy: pid 9 still maps x) — the 1 FAIL before it is no verdict");
  });
});

describe("decide", () => {
  test("PASS: no rollback, after runs", async () => {
    const h = env();
    const st: { after?: "run" | "skip" } = {};
    const d = await decide(h.e, CHECK, P, h.restartOwner, st);
    expect(d).toEqual({ note: "splash 1.3.0 PASS" });
    expect(st.after).toBe("run");
    expect(h.calls.some((c) => c.includes("uninstall"))).toBe(false);
  });
  test("could not run (exit 2): the new version stays, notified, after runs, not a FAILED entry", async () => {
    const h = env({ check: { "1.3.0": [2] } });
    const st: { after?: "run" | "skip" } = {};
    const d = await decide(h.e, CHECK, P, h.restartOwner, st);
    expect(d.failed).toBeUndefined();
    expect(d.note).toBe("splash 1.3.0 check could not run (rc 2), kept");
    expect(h.notices[0]).toContain("could not run (rc 2)");
    expect(st.after).toBe("run");
    expect(h.calls.some((c) => c.includes("uninstall"))).toBe(false);
    expect(h.files.has(HOLD)).toBe(false);
  });
  test("confirmed fail: uninstall the new keg, link the previous, restart the owner, hold, check the restored version, notify with the scores", async () => {
    const h = env({ check: { "1.3.0": [1, 1], "1.2.0": [0] } });
    const st: { after?: "run" | "skip" } = {};
    const d = await decide(h.e, CHECK, P, h.restartOwner, st);
    expect(h.calls.filter((c) => c.startsWith("brew uninstall") || c.startsWith("brew link"))).toEqual(["brew uninstall example/tap/splash", "brew link example/tap/splash"]);
    expect(h.linked()).toBe("1.2.0");
    expect(h.restarts).toEqual(["/brew/Cellar/splash/1.3.0"]);
    expect(JSON.parse(h.files.get(HOLD)!)).toEqual({ formula: "splash", version: "1.3.0", from: "1.2.0", at: "2026-10-26 04:00" });
    expect(h.envs.filter((x) => x?.GATE_VERSION).map((x) => x!.GATE_VERSION)).toEqual(["1.3.0", "1.3.0", "1.2.0"]);
    expect(d).toEqual({ note: "splash 1.3.0 FAIL, rolled back to 1.2.0 (held, 1.2.0 PASS)", failed: "release-check:splash" });
    expect(st.after).toBe("run");
    expect(h.notices[0]).toContain("release check FAILED: splash 1.3.0 — rolled back to 1.2.0");
    expect(h.notices[0]).toContain("final score 0.1");
  });
  test("a formula trusted before the uninstall is trusted again", async () => {
    const h = env({ check: { "1.3.0": [1, 1] }, trusted: ["example/tap/splash"] });
    await decide(h.e, CHECK, P, h.restartOwner, {});
    expect(h.calls).toContain("brew trust --formula example/tap/splash");
  });
  test("restored version fails too: after is not run, loud notice", async () => {
    const h = env({ check: { "1.3.0": [1, 1], "1.2.0": [1, 1] } });
    const st: { after?: "run" | "skip" } = {};
    const d = await decide(h.e, CHECK, P, h.restartOwner, st);
    expect(st.after).toBe("skip");
    expect(d.note).toBe("splash 1.3.0 FAIL, rolled back to 1.2.0 (held), 1.2.0 FAIL, after not run");
    expect(h.notices[0]).toContain("🚨");
    expect(h.notices[0]).toContain("FAILED too");
    expect(h.files.has(HOLD)).toBe(true);
  });
  test("previous keg missing: no rollback, the new version stays (held), after not run, loud notice", async () => {
    const h = env({ check: { "1.3.0": [1, 1] }, dirs: ["/brew/Cellar/splash/1.3.0"] });
    const st: { after?: "run" | "skip" } = {};
    const d = await decide(h.e, CHECK, P, h.restartOwner, st);
    expect(h.calls.some((c) => c.includes("uninstall") || c.startsWith("brew link"))).toBe(false);
    expect(h.files.has(HOLD)).toBe(true);
    expect(h.restarts).toEqual([]);
    expect(st.after).toBe("skip");
    expect(d.failed).toBe("release-check:splash");
    expect(h.notices[0]).toContain("rollback impossible");
    expect(h.notices[0]).toContain("previous keg /brew/Cellar/splash/1.2.0 is missing");
  });
  test("a record whose new version is the previous one (to === from): the only keg is never uninstalled, rollback impossible, after not run", async () => {
    const h = env({ check: { "1.2.0": [1, 1] }, linked: "1.2.0", kegs: ["1.2.0"], dirs: ["/brew/Cellar/splash/1.2.0"] });
    const st: { after?: "run" | "skip" } = {};
    const d = await decide(h.e, CHECK, { ...P, to: "1.2.0" }, h.restartOwner, st);
    expect(h.calls.some((c) => c.includes("uninstall") || c.startsWith("brew link"))).toBe(false);
    expect(h.linked()).toBe("1.2.0");
    expect(h.restarts).toEqual([]);
    expect(st.after).toBe("skip");
    expect(d.failed).toBe("release-check:splash");
    expect(d.note).toContain("rollback impossible");
    expect(h.notices[0]).toContain("rollback impossible");
    expect(h.notices[0]).toContain("the only keg is never uninstalled");
  });
  test("a failed uninstall: nothing removed, the failed version held, after not run", async () => {
    const h = env({ check: { "1.3.0": [1, 1] }, rc: { "brew uninstall example/tap/splash": 1 } });
    const st: { after?: "run" | "skip" } = {};
    const d = await decide(h.e, CHECK, P, h.restartOwner, st);
    expect(st.after).toBe("skip");
    expect(h.files.has(HOLD)).toBe(true);
    expect(d.note).toContain("rollback impossible");
  });
  test("an owner restart that fails after the rollback: held, restored version not checked, after not run", async () => {
    const h = env({ check: { "1.3.0": [1, 1] } });
    const st: { after?: "run" | "skip" } = {};
    const d = await decide(h.e, CHECK, P, async () => ({ ok: false, note: "kickstart rc 5" }), st);
    expect(st.after).toBe("skip");
    expect(h.files.has(HOLD)).toBe(true);
    expect(h.envs.filter((x) => x?.GATE_VERSION === "1.2.0")).toEqual([]);
    expect(d.note).toContain("owner restart failed: kickstart rc 5");
  });
});

describe("rollback: review round 3 (3b26f7e)", () => {
  test("2: a rollback killed after the uninstall, before the link: recovery links and trusts again (the opt link is missing, the sole installed version is not taken for it)", async () => {
    // The killed run removed 1.3.0; nothing is linked; only 1.2.0 is installed. It had recorded the trust.
    const h = env({ check: { "1.2.0": [0] }, dirs: ["/brew/Cellar/splash/1.2.0"], linked: "", kegs: ["1.2.0"], trusted: [] });
    const rec = { ...P, ownerRestarted: true, verdict: "fail" as const, after: "skip" as const, trusted: true };
    const d = await resume(h.e, CHECK, rec, { save: async () => {}, restartOwner: async () => ({ kind: "ok", note: "" }), scan: async () => [], stopping: () => false });
    expect(h.calls).toContain("brew link example/tap/splash");
    expect(h.calls).toContain("brew trust --formula example/tap/splash");
    expect(h.calls.some((c) => c.startsWith("brew uninstall"))).toBe(false);
    expect(h.linked()).toBe("1.2.0");
    expect(rec.rolledBack).toBe(true);
    expect(d.note).toBe("splash 1.3.0 FAIL, rolled back to 1.2.0 (held, 1.2.0 PASS)");
  });
  test("2: the same, but the link fails on recovery: rollback incomplete, after not run", async () => {
    const h = env({ check: { "1.2.0": [0] }, dirs: ["/brew/Cellar/splash/1.2.0"], linked: "", kegs: ["1.2.0"], rc: { "brew link example/tap/splash": 1 } });
    const rec = { ...P, ownerRestarted: true, verdict: "fail" as const, after: "skip" as const, trusted: false };
    const d = await resume(h.e, CHECK, rec, { save: async () => {}, restartOwner: async () => ({ kind: "ok", note: "" }), scan: async () => [], stopping: () => false });
    expect(rec.rolledBack).toBeUndefined();
    expect(rec.after).toBe("skip");
    expect(d.note).toContain("rollback incomplete");
    expect(h.envs.filter((x) => x?.GATE_VERSION === "1.2.0")).toEqual([]);
  });
  test("2: the trust state is saved on the record before the uninstall", async () => {
    const h = env({ check: { "1.3.0": [1, 1] }, trusted: ["example/tap/splash"] });
    const rec = { ...P, ownerRestarted: true };
    const saved: boolean[] = [];
    await resume(h.e, CHECK, rec, {
      save: async () => void saved.push(rec.trusted === true && !h.calls.some((c) => c.startsWith("brew uninstall"))),
      restartOwner: async () => ({ kind: "ok", note: "" }), scan: async () => [], stopping: () => false,
    });
    expect(saved).toContain(true);
  });
  test("5: a failing re-trust is a failed rollback: held, the restored version not checked, after not run", async () => {
    const h = env({ check: { "1.3.0": [1, 1], "1.2.0": [0] }, trusted: ["example/tap/splash"], rc: { "brew trust --formula example/tap/splash": 1 } });
    const st: { after?: "run" | "skip" } = {};
    const d = await decide(h.e, CHECK, P, h.restartOwner, st);
    expect(st.after).toBe("skip");
    expect(d.note).toContain("rollback incomplete");
    expect(d.failed).toBe("release-check:splash");
    expect(h.files.has(HOLD)).toBe(true);
    expect(h.envs.filter((x) => x?.GATE_VERSION === "1.2.0")).toEqual([]);
  });
});

describe("review round 4 (85dd0da)", () => {
  test("5: the trust state cannot be read at the rollback: nothing is uninstalled (unknown is never untrusted)", async () => {
    const h = env({ check: { "1.3.0": [1, 1] }, rc: { "brew trust --formula --json=v1": 1 } });
    const st: { after?: "run" | "skip" } = {};
    const d = await decide(h.e, CHECK, P, h.restartOwner, st);
    expect(h.calls.some((c) => c.startsWith("brew uninstall"))).toBe(false);
    expect(d.note).toContain("rollback impossible");
    expect(st.after).toBe("skip");
    expect(h.files.has(HOLD)).toBe(true);
  });
  test("5: a malformed trust answer at the rollback: nothing is uninstalled", async () => {
    const h = env({ check: { "1.3.0": [1, 1] } });
    const exec = h.e.exec;
    h.e.exec = async (argv, o) => (argv.join(" ") === "brew trust --formula --json=v1" ? { rc: 0, out: "{\"x\":1}", err: "" } : exec(argv, o));
    const d = await decide(h.e, CHECK, P, h.restartOwner, {});
    expect(h.calls.some((c) => c.startsWith("brew uninstall"))).toBe(false);
    expect(d.note).toContain("rollback impossible");
  });
  test("5: the trust state the record carries from before the upgrade is used, not read again", async () => {
    const h = env({ check: { "1.3.0": [1, 1] }, rc: { "brew trust --formula --json=v1": 1 } });
    await decide(h.e, CHECK, { ...P, trusted: true }, h.restartOwner, {});
    expect(h.calls).toContain("brew uninstall example/tap/splash");
    expect(h.calls).toContain("brew trust --formula example/tap/splash");
    expect(h.linked()).toBe("1.2.0");
  });
});

describe("the pre-check gate: a fresh scan in front of every check, whatever the record's restart flags say", () => {
  const OLDKEG = "/brew/Cellar/splash/1.1.0";
  /** resume with scripted scans (each answer in turn, the last repeating) and restarts recorded by phase. */
  const gated = async (h: ReturnType<typeof env>, rec: PendingCheck & { to: string }, scans: ({ pid: string; keg: string }[] | undefined)[]) => {
    const phases: string[] = [];
    const expects: string[] = [];
    let n = 0;
    const d = await resume(h.e, CHECK, rec, {
      save: async () => {},
      restartOwner: async (phase) => {
        phases.push(phase);
        return { kind: "ok", note: "" };
      },
      scan: async (expect) => {
        expects.push(expect);
        return scans[Math.min(n++, scans.length - 1)];
      },
      stopping: () => false,
    });
    return { d, phases, expects };
  };
  test("an earlier run restarted the owners onto the candidate: a process on an older retained keg since is restarted, scanned again, then checked", async () => {
    const h = env();
    const rec = { ...P, ownerRestarted: true };
    const g = await gated(h, rec, [[{ pid: "77", keg: OLDKEG }], []]);
    expect(g.phases).toEqual(["new"]);
    expect(g.expects).toEqual(["/brew/Cellar/splash/1.3.0", "/brew/Cellar/splash/1.3.0"]);
    expect(rec.verdict).toBe("pass");
    expect(h.e.log).toContain(`  release check splash: pid 77 maps ${OLDKEG} before the check — its owners are restarted first`);
  });
  test("the process still there after that restart: no check, a wait", async () => {
    const h = env();
    const rec = { ...P, ownerRestarted: true };
    const g = await gated(h, rec, [[{ pid: "77", keg: OLDKEG }]]);
    expect(g.d).toMatchObject({ wait: true });
    expect(g.d.waitWhy).toBe(`pid 77 still maps ${OLDKEG} after its owners restarted`);
    expect(h.envs.some((x) => x?.GATE_VERSION)).toBe(false);
    expect(rec.verdict).toBeUndefined();
  });
  test("the processes cannot be read: no restart, no check, a wait", async () => {
    const h = env();
    const rec = { ...P, ownerRestarted: true };
    const g = await gated(h, rec, [undefined]);
    expect(g.phases).toEqual([]);
    expect(g.d).toMatchObject({ wait: true, waitWhy: "the splash processes could not be read before the check" });
    expect(h.envs.some((x) => x?.GATE_VERSION)).toBe(false);
  });
  test("restarted in this run and a process left: a wait without a second restart", async () => {
    const h = env();
    const rec = { ...P };
    const g = await gated(h, rec, [[{ pid: "78", keg: "/brew/Cellar/splash/1.2.0" }]]);
    expect(g.phases).toEqual(["new"]);
    expect(g.d).toMatchObject({ wait: true });
    expect(rec.ownerRestarted).toBe(true);
  });
  test("a stopped run persisted the restored restart, the owner respawned on an older retained keg since: restarted onto the restored version and scanned again before the restored check", async () => {
    // Rolled back already: only 1.2.0 (and the older 1.1.0) installed, 1.2.0 linked.
    const h = env({ check: { "1.2.0": [0] }, linked: "1.2.0", kegs: ["1.1.0", "1.2.0"], dirs: ["/brew/Cellar/splash/1.1.0", "/brew/Cellar/splash/1.2.0"] });
    const rec = { ...P, ownerRestarted: true, verdict: "fail" as const, after: "skip" as const, trusted: false, rolledBack: true, restoredOwnerRestarted: true };
    const g = await gated(h, rec, [[{ pid: "99", keg: OLDKEG }], []]);
    expect(g.phases).toEqual(["restored"]);
    expect(g.expects).toEqual(["/brew/Cellar/splash/1.2.0", "/brew/Cellar/splash/1.2.0"]);
    expect(rec.restoredVerdict).toBe("pass");
  });
  test("the owner respawned on the previous keg between the candidate's attempts: the retry's gate finds it, no second restart in the run, no retry, no verdict (the FAIL before it does not count), a wait", async () => {
    const h = env({ check: { "1.3.0": [1, 0] } });
    const rec = { ...P };
    const saved: Partial<PendingCheck>[] = [];
    const scans: KegProcs[] = [[], [{ pid: "80", keg: "/brew/Cellar/splash/1.2.0" }]];
    let n = 0;
    const phases: string[] = [];
    const d = await resume(h.e, CHECK, rec, {
      save: async () => void saved.push({ ...rec }),
      restartOwner: async (phase) => (phases.push(phase), { kind: "ok", note: "" }),
      scan: async () => scans[Math.min(n++, scans.length - 1)],
      stopping: () => false,
    });
    expect(d).toMatchObject({ wait: true, waitWhy: "pid 80 still maps /brew/Cellar/splash/1.2.0 after its owners restarted" });
    expect(phases).toEqual(["new"]);
    expect(h.calls.filter((c) => c === "/opt/gate.test/check")).toHaveLength(1);
    expect(rec.verdict).toBeUndefined();
    expect(rec.after).toBeUndefined();
    expect(rec.ended).toBeUndefined();
    // Nothing is written between the attempts: a crash there leaves the record as it was.
    expect(saved.every((r) => r.verdict === undefined)).toBe(true);
  });
  test("an earlier run restarted the owners: a respawn between the attempts is restarted once by the retry's gate, then the retry runs", async () => {
    const h = env({ check: { "1.3.0": [1, 0] } });
    const rec = { ...P, ownerRestarted: true };
    const g = await gated(h, rec, [[], [{ pid: "80", keg: "/brew/Cellar/splash/1.2.0" }], []]);
    expect(g.phases).toEqual(["new"]);
    expect(rec.verdict).toBe("pass");
    expect(h.calls.filter((c) => c === "/opt/gate.test/check")).toHaveLength(2);
  });
  test("an owner restart that fails in a retry's gate: as for the first attempt's (no verdict, the new version kept, after owed)", async () => {
    const h = env({ check: { "1.3.0": [1, 0] } });
    const rec = { ...P, ownerRestarted: true };
    let n = 0;
    const d = await resume(h.e, CHECK, rec, {
      save: async () => {},
      restartOwner: async () => ({ kind: "failed", note: "kickstart rc 5" }),
      scan: async () => (n++ === 0 ? [] : [{ pid: "80", keg: "/brew/Cellar/splash/1.2.0" }]),
      stopping: () => false,
    });
    expect(d).toMatchObject({ note: "splash 1.3.0 not checked, owner restart failed", failed: "release-check:splash" });
    expect(rec.verdict).toBeUndefined();
    expect(rec.after).toBe("run");
    expect(h.calls.filter((c) => c === "/opt/gate.test/check")).toHaveLength(1);
  });
  test("the owner respawned on an older retained keg between the restored version's attempts: no retry, no restored verdict, the record waits (after stays skipped)", async () => {
    const h = env({ check: { "1.2.0": [1, 0] }, linked: "1.2.0", kegs: ["1.1.0", "1.2.0"], dirs: ["/brew/Cellar/splash/1.1.0", "/brew/Cellar/splash/1.2.0"] });
    const rec = { ...P, ownerRestarted: true, verdict: "fail" as const, after: "skip" as const, trusted: false, rolledBack: true };
    const g = await gated(h, rec, [[], [{ pid: "99", keg: OLDKEG }]]);
    expect(g.phases).toEqual(["restored"]);
    expect(g.d).toMatchObject({ wait: true, waitWhy: `pid 99 still maps ${OLDKEG} after its owners restarted` });
    expect(h.envs.filter((x) => x?.GATE_VERSION === "1.2.0")).toHaveLength(1);
    expect(rec.restoredVerdict).toBeUndefined();
    expect(rec.after).toBe("skip");
    expect(rec.ended).toBeUndefined();
  });
  test("the same, the restored owners restarted by an earlier run: the retry's gate restarts them once, the retry passes", async () => {
    const h = env({ check: { "1.2.0": [1, 0] }, linked: "1.2.0", kegs: ["1.1.0", "1.2.0"], dirs: ["/brew/Cellar/splash/1.1.0", "/brew/Cellar/splash/1.2.0"] });
    const rec = { ...P, ownerRestarted: true, verdict: "fail" as const, after: "skip" as "run" | "skip", trusted: false, rolledBack: true, restoredOwnerRestarted: true };
    const g = await gated(h, rec, [[], [{ pid: "99", keg: OLDKEG }], []]);
    expect(g.phases).toEqual(["restored"]);
    expect(rec.restoredVerdict).toBe("pass");
    expect(rec.after).toBe("run");
  });
  test("the same, the process still there: the restored version is not checked, the record waits (after stays skipped)", async () => {
    const h = env({ check: { "1.2.0": [0] }, linked: "1.2.0", kegs: ["1.1.0", "1.2.0"], dirs: ["/brew/Cellar/splash/1.1.0", "/brew/Cellar/splash/1.2.0"] });
    const rec = { ...P, ownerRestarted: true, verdict: "fail" as const, after: "skip" as const, trusted: false, rolledBack: true, restoredOwnerRestarted: true };
    const g = await gated(h, rec, [[{ pid: "99", keg: OLDKEG }]]);
    expect(g.d).toMatchObject({ wait: true });
    expect(h.envs.some((x) => x?.GATE_VERSION === "1.2.0")).toBe(false);
    expect(rec.restoredVerdict).toBeUndefined();
    expect(rec.after).toBe("skip");
    expect(rec.ended).toBeUndefined();
  });
});

describe("realFs state reads (review round 5)", () => {
  test("readState: a missing file is undefined, a file that cannot be read throws", async () => {
    const { realFs } = await import("../../src/apply/fs.ts");
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(`${tmpdir()}/oupdate-rs-`);
    try {
      expect(await realFs.readState!(`${dir}/missing.json`)).toBeUndefined();
      // A directory is there but is not a readable file (EISDIR).
      await expect(realFs.readState!(dir)).rejects.toThrow();
      expect(await realFs.listState!(`${dir}/missing`)).toEqual([]);
      await realFs.writeFile(`${dir}/f.json`, "{}");
      await expect(realFs.listState!(`${dir}/f.json`)).rejects.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
