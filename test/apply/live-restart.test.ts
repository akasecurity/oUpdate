// liveRestartPid: which root restart process still running holds a release check's owner restarts, its after and the stop path's after.
import { describe, expect, test } from "bun:test";
import { liveRestartPid, ownerArgvKey, ownerArgvs } from "../../src/apply/run-ctx.ts";

const ARGV = ["/usr/bin/sudo", "-n", "/usr/local/sbin/restart-helper", "svc"];

async function child() {
  return Bun.spawn(["/bin/sleep", "30"], { detached: true, stdio: ["ignore", "ignore", "ignore"] });
}

describe("liveRestartPid", () => {
  test("the formula's own helper, by package name, bare or tap-qualified", async () => {
    const c = await child();
    try {
      expect(liveRestartPid(new Map([["gadget", c.pid]]), "example/tap/gadget")).toBe(c.pid);
      expect(liveRestartPid(new Map([["gadget", c.pid]]), "gadget")).toBe(c.pid);
    } finally {
      c.kill("SIGKILL");
      await c.exited;
    }
  });
  test("another package's helper does not hold this formula", async () => {
    // Mutant caught: matching every key (a helper for an unrelated package holding every check).
    const c = await child();
    try {
      expect(liveRestartPid(new Map([["other", c.pid]]), "example/tap/gadget")).toBeUndefined();
    } finally {
      c.kill("SIGKILL");
      await c.exited;
    }
  });
  test("a running owner argv restart holds a check whose owners it covers, and no other", async () => {
    // Mutants caught: the argv scope dropped (an unrelated check's owner restart held, ended or reported with a false cause); the argv key not read.
    const c = await child();
    try {
      const running = new Map([[ownerArgvKey(ARGV), c.pid]]);
      expect(liveRestartPid(running, "example/tap/zeta", [ARGV])).toBe(c.pid);
      expect(liveRestartPid(running, "example/tap/zeta", [])).toBeUndefined();
      expect(liveRestartPid(running, "example/tap/zeta", [["/usr/bin/sudo", "-n", "/usr/local/sbin/restart-helper", "other"]])).toBeUndefined();
    } finally {
      c.kill("SIGKILL");
      await c.exited;
    }
  });
  test("a process that has exited holds nothing", async () => {
    const c = await child();
    c.kill("SIGKILL");
    await c.exited;
    expect(liveRestartPid(new Map([["gadget", c.pid], [ownerArgvKey(ARGV), c.pid]]), "gadget", [ARGV])).toBeUndefined();
  });
});

describe("ownerArgvs", () => {
  test("the argv a glob entry gives each label, once; kickstart, bootstrap and unmatched labels give none", () => {
    const owners = [{ match: "com.example.svc-*", restart: ARGV }, { match: "org.kick", restart: "kickstart" as const }, { match: "org.boot", restart: { bootstrap: "/p.plist" } }];
    expect(ownerArgvs(owners, ["com.example.svc-a", "com.example.svc-b", "org.kick", "org.boot", "org.none"])).toEqual([ARGV]);
    expect(ownerArgvs(undefined, ["x"])).toEqual([]);
  });
});
