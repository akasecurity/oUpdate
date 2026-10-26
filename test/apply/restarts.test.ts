// Step 7 of the previous updater's brew phase: restart the services of upgraded packages (slice 7).
import { describe, expect, test } from "bun:test";
import { killLive, resetStopping, type Exec } from "../../src/apply/exec.ts";
import { restartUpgraded, type RestartEnv } from "../../src/apply/restarts.ts";

const SVC = { name: "svc", waiter: "/w.test", holdFile: "/hold.test", quarantineFile: "/q.test", outcomeFile: "/o.test", restartLog: "/r.test" };
const HELPER = "/usr/local/sbin/helper.test";

function env(files: string[], rc: Record<string, number> = {}) {
  const calls: string[] = [];
  const spawned: string[][] = [];
  const exec: Exec = async (argv) => {
    calls.push(argv.join(" "));
    return { rc: rc[argv.join(" ")] ?? 0, out: "", err: "" };
  };
  const e: RestartEnv = {
    exec, home: "/home.test", uid: 501,
    exists: async (p) => files.includes(p),
    spawnDetached: async (argv) => (spawned.push(argv), 4242),
  };
  return { e, calls, spawned };
}

describe("restartUpgraded", () => {
  test("canonical label first, legacy label after; system via sudo -n, user agents via gui/<uid>", async () => {
    const { e, calls } = env(["/Library/LaunchDaemons/sh.brew.a.plist", "/Library/LaunchDaemons/homebrew.mxcl.b.plist", "/home.test/Library/LaunchAgents/homebrew.mxcl.c.plist"]);
    const out = await restartUpgraded(e, ["a", "b", "c", "d"], { deferred: [], detachedLog: "/log.test" });
    expect(out).toEqual(["a(sys)", "b(sys)", "c(user)"]);
    expect(calls).toEqual([
      "sudo -n launchctl kickstart -k system/sh.brew.a",
      "sudo -n launchctl kickstart -k system/homebrew.mxcl.b",
      "launchctl kickstart -k gui/501/homebrew.mxcl.c",
    ]);
  });
  test("a package the helper allows restarts through it; a missing helper is FAILED", async () => {
    const files = ["/Library/LaunchDaemons/sh.brew.a.plist", HELPER];
    const { e, calls } = env(files);
    expect(await restartUpgraded(e, ["a"], { deferred: [], helper: { path: HELPER, packages: ["a"] }, detachedLog: "/log.test" })).toEqual(["a(sys)"]);
    expect(calls).toEqual([`sudo -n ${HELPER} a`]);
    const gone = env(["/Library/LaunchDaemons/sh.brew.a.plist"]);
    expect(await restartUpgraded(gone.e, ["a"], { deferred: [], helper: { path: HELPER, packages: ["a"] }, detachedLog: "/log.test" })).toEqual(["a(FAILED to restart)"]);
  });
  test("a detached restart runs later through the helper, its arguments positional", async () => {
    const { e, calls, spawned } = env(["/Library/LaunchDaemons/sh.brew.net.plist", HELPER]);
    const out = await restartUpgraded(e, ["net"], { deferred: [], helper: { path: HELPER, packages: ["net"], detached: ["net"], delaySec: 5 }, detachedLog: "/log.test" });
    expect(out).toEqual(["net(sys,deferred)"]);
    expect(calls).toEqual([]);
    expect(spawned).toEqual([["/bin/sh", "-c", 'sleep 5; exec sudo -n "$0" "$1"', HELPER, "net"]]);
    const noPlist = env([HELPER]);
    expect(await restartUpgraded(noPlist.e, ["net"], { deferred: [], helper: { path: HELPER, packages: ["net"], detached: ["net"] }, detachedLog: "/log.test" })).toEqual(["net(FAILED: no launchd plist for homebrew.mxcl.net)"]);
  });
  test('labelRestart "skip": no helper, no kickstart, left to its owner (label re-review D)', async () => {
    // Mutant caught: the policy not checked in restartUpgraded, or checked after the helper.
    const { e, calls, spawned } = env(["/Library/LaunchDaemons/sh.brew.a.plist", HELPER]);
    const out = await restartUpgraded(e, ["a"], { deferred: [], helper: { path: HELPER, packages: ["a"] }, labelRestart: { "sh.brew.a": "skip" }, detachedLog: "/log.test" });
    expect(out).toEqual(["a(restart left to its owner)"]);
    expect(calls).toEqual([]);
    expect(spawned).toEqual([]);
  });
  test("staleOwners: a matching label is left to the stale-keg check's idle waiter, before labelRestart and the helper", async () => {
    const { e, calls, spawned } = env(["/Library/LaunchDaemons/sh.brew.a.plist", "/home.test/Library/LaunchAgents/sh.brew.b.plist", HELPER]);
    const out = await restartUpgraded(e, ["a", "b"], {
      deferred: [], helper: { path: HELPER, packages: ["a"] }, labelRestart: { "sh.brew.a": "kickstart" }, staleKegUnlisted: "report", detachedLog: "/log.test",
      staleOwners: [{ match: "sh.brew.*" }],
    });
    expect(out).toEqual(["a(waiting for idle restart)", "b(waiting for idle restart)"]);
    expect(calls).toEqual([]);
    expect(spawned).toEqual([]);
  });
  test('staleKegUnlisted "report": an unlisted label with a plist is reported, never restarted (issue 3)', async () => {
    const { e, calls, spawned } = env(["/Library/LaunchDaemons/sh.brew.a.plist", "/Library/LaunchDaemons/sh.brew.b.plist", "/Library/LaunchDaemons/sh.brew.c.plist", HELPER]);
    const out = await restartUpgraded(e, ["a", "b", "c"], {
      deferred: [], helper: { path: HELPER, packages: ["a"], detached: ["c"] }, staleKegUnlisted: "report", detachedLog: "/log.test",
      labelRestart: { "sh.brew.b": "kickstart" },
    });
    expect(out).toEqual(["a(reported only, not on the restart list)", "b(sys)", "c(reported only, not on the restart list)"]);
    expect(calls).toEqual(["sudo -n launchctl kickstart -k system/sh.brew.b"]);
    expect(spawned).toEqual([]);
  });
  test('staleKegUnlisted "report": a label without a plist is still left alone, and kickstart mode is unchanged', async () => {
    const none = env([]);
    expect(await restartUpgraded(none.e, ["a"], { deferred: [], staleKegUnlisted: "report", detachedLog: "/log.test" })).toEqual([]);
    const k = env(["/Library/LaunchDaemons/sh.brew.a.plist"]);
    expect(await restartUpgraded(k.e, ["a"], { deferred: [], staleKegUnlisted: "kickstart", detachedLog: "/log.test" })).toEqual(["a(sys)"]);
  });
  test("labelRestart command: started detached with the label appended, before the detached helper path", async () => {
    // Mutants caught: the label not appended; the detached helper path taken first.
    const { e, calls, spawned } = env(["/Library/LaunchDaemons/sh.brew.net.plist", HELPER]);
    const out = await restartUpgraded(e, ["net"], {
      deferred: [], helper: { path: HELPER, packages: ["net"], detached: ["net"] }, labelRestart: { "sh.brew.net": ["/opt/owner.test/restart-when-quiet", "--wait"] }, detachedLog: "/log.test",
    });
    expect(out).toEqual(["net(handed to restart-when-quiet)"]);
    expect(spawned).toEqual([["/opt/owner.test/restart-when-quiet", "--wait", "sh.brew.net"]]);
    expect(calls).toEqual([]);
  });
  test('labelRestart "kickstart": the normal path, the helper then the kickstart, never a spawn', async () => {
    // Mutant caught: "kickstart" taken as an owner command (spawned as argv ["k","i",…]) or as "skip".
    const { e, calls, spawned } = env(["/Library/LaunchDaemons/sh.brew.a.plist", "/home.test/Library/LaunchAgents/sh.brew.b.plist", HELPER]);
    const out = await restartUpgraded(e, ["a", "b"], { deferred: [], helper: { path: HELPER, packages: ["a"] }, labelRestart: { "sh.brew.a": "kickstart", "sh.brew.b": "kickstart" }, detachedLog: "/log.test" });
    expect(out).toEqual(["a(sys)", "b(user)"]);
    expect(calls).toEqual([`sudo -n ${HELPER} a`, "launchctl kickstart -k gui/501/sh.brew.b"]);
    expect(spawned).toEqual([]);
  });
  test("an owner command that cannot start is FAILED, and is not reported as handed", async () => {
    // Mutant caught: the spawn failure entry dropped or read as handed.
    const { e } = env(["/Library/LaunchDaemons/sh.brew.a.plist"]);
    e.spawnDetached = async () => Promise.reject(new Error("no such file"));
    const handed = new Map<string, string>();
    const out = await restartUpgraded(e, ["a"], { deferred: [], labelRestart: { "sh.brew.a": ["/opt/owner.test/restart-when-quiet"] }, detachedLog: "/log.test", ownerHanded: handed });
    expect(out).toEqual(["a(FAILED: handoff to restart-when-quiet)"]);
    expect(handed.size).toBe(0);
  });
  test("labelRestart applies only to a label whose plist exists (label re-review 2 (6))", async () => {
    // Mutant caught: the fallback homebrew.mxcl.<pkg> handed to an owner with no service behind it.
    const { e, calls, spawned } = env([]);
    const out = await restartUpgraded(e, ["a"], { deferred: [], labelRestart: { "homebrew.mxcl.a": ["/opt/owner.test/restart-when-quiet"], "sh.brew.a": "skip" }, detachedLog: "/log.test" });
    expect(out).toEqual([]);
    expect(spawned).toEqual([]);
    expect(calls).toEqual([]);
  });
  test("a handed label is reported to the stale-keg check", async () => {
    const { e } = env(["/Library/LaunchDaemons/sh.brew.a.plist"]);
    const handed = new Map<string, string>();
    await restartUpgraded(e, ["a"], { deferred: [], labelRestart: { "sh.brew.a": ["/opt/owner.test/restart-when-quiet"] }, detachedLog: "/log.test", ownerHanded: handed });
    expect([...handed]).toEqual([["sh.brew.a", "restart-when-quiet"]]);
  });
  test("a deferred service, bare or tap-qualified, is never restarted here", async () => {
    const { e, calls } = env(["/Library/LaunchDaemons/sh.brew.svc.plist"]);
    expect(await restartUpgraded(e, ["svc", "example/svc/svc"], { deferred: [SVC], detachedLog: "/log.test" })).toEqual(["svc(deferred to idle waiter)", "example/svc/svc(deferred to idle waiter)"]);
    expect(calls).toEqual([]);
  });
  test("while stopping, nothing restarts and no delayed restart is spawned (slice 7 re-review 3)", async () => {
    // Mutant caught: restartUpgraded without the stopping check (the detached `sleep 60; sudo -n helper` started after ABORTED).
    const { e, calls, spawned } = env(["/Library/LaunchDaemons/sh.brew.net.plist", "/Library/LaunchDaemons/sh.brew.a.plist", HELPER]);
    try {
      await killLive(1);
      const out = await restartUpgraded(e, ["net", "a"], { deferred: [], helper: { path: HELPER, packages: ["net"], detached: ["net"] }, detachedLog: "/log.test" });
      expect(out).toEqual(["net(not restarted: oupdate is stopping)", "a(not restarted: oupdate is stopping)"]);
      expect(spawned).toEqual([]);
      expect(calls).toEqual([]);
    } finally {
      resetStopping();
    }
  });
});
