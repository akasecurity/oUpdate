import { describe, expect, test } from "bun:test";
import { commandReviewer, DEFAULT_TIMEOUT_MS } from "../src/adapters/reviewer/command.ts";
import { killLive, liveGroups, resetStopping } from "../src/apply/exec.ts";

describe("commandReviewer", () => {
  test("sends the prompt on stdin and returns stdout", async () => {
    const r = commandReviewer({ name: "echo", argv: [process.execPath, "-e", "process.stdout.write('APPROVE\\n' + (await Bun.stdin.text()).length)"] });
    const out = await r.review("hello");
    expect(out).toBe("APPROVE\n5");
  });

  test("runs in an empty private directory, not the caller's cwd", async () => {
    const r = commandReviewer({ name: "pwd", argv: [process.execPath, "-e", "process.stdout.write(require('fs').readdirSync('.').length + ' ' + process.cwd())"] });
    const out = await r.review("");
    const [count, cwd] = out.split(" ");
    expect(count).toBe("0");
    expect(cwd).not.toBe(process.cwd());
  });

  test("a non-zero exit throws", async () => {
    const r = commandReviewer({ name: "fail", argv: [process.execPath, "-e", "process.exit(3)"] });
    await expect(r.review("x")).rejects.toThrow(/exit 3/);
  });

  test("a timeout throws", async () => {
    const r = commandReviewer({ name: "slow", argv: [process.execPath, "-e", "await Bun.sleep(5000)"], timeoutMs: 200 });
    await expect(r.review("x")).rejects.toThrow(/timed out/);
  });

  test("the default timeout is 600 s and a configured one overrides it", async () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(600_000);
  });

  test("a timeout stays 'timed out' when the reviewer keeps writing into its directory", async () => {
    const r = commandReviewer({ name: "writer", argv: ["/bin/sh", "-c", "while :; do mkdir -p d; : > d/$$.$RANDOM; done"], timeoutMs: 300 });
    await expect(r.review("x")).rejects.toThrow(/timed out/);
  });

  test("a stop (killLive) kills a running reviewer command, and none starts while stopping (slice 7 follow-up)", async () => {
    // Mutant caught: Bun.spawn outside the live-group tracking (a stop left the reviewer up to its 600 s timeout).
    // A group from an earlier timed-out test stays listed for its SIGKILL grace: wait it out.
    for (let i = 0; i < 200 && liveGroups().length; i++) await Bun.sleep(20);
    const r = commandReviewer({ name: "slow", argv: ["/bin/sh", "-c", "sleep 30"] });
    const t0 = Date.now();
    // Settled at once into a value, so the rejection is never unhandled while the stop runs.
    const p = r.review("x").then(() => "resolved", (e: Error) => e.message);
    try {
      for (let i = 0; i < 100 && !liveGroups().length; i++) await Bun.sleep(20);
      expect(liveGroups().length).toBe(1);
      await killLive(100);
      expect(await p).toMatch(/^reviewer slow exit 143/);
      expect(Date.now() - t0).toBeLessThan(3000);
      expect(liveGroups()).toEqual([]);
      await expect(r.review("x")).rejects.toThrow(/not started: oupdate is stopping/);
    } finally {
      resetStopping();
    }
  }, 10_000);
});
