import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brokerCall } from "../../src/targets/broker-client.ts";
import { LOG_ONLY, LOG_STREAM_BYTES, LSOF_STREAM_BYTES, MAX_STREAM_BYTES, OVER_BOUND_RC, boundOf, liveGroups, realExec } from "../../src/apply/exec.ts";
import { lsofMaps } from "../../src/apply/kegs.ts";
import { gatherSurface } from "../../src/apply/surface.ts";

const MIB = 1024 * 1024;
// Every temp dir a test makes, removed when the file ends.
const made: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "oup285-"));
  made.push(d);
  return d;
};
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const node = (src: string) => [process.execPath, "-e", src];
/** The `n` bytes "0123456789" repeated: any kept suffix of it is checkable exactly. */
const digits = (n: number) => "0123456789".repeat(Math.ceil(n / 10)).slice(0, n);
/** A command that writes digits(n) to a stream in `chunk`-byte writes (the digits are built in the child, never put in argv). */
const emit = (stream: "stdout" | "stderr", n: number, chunk = 7) =>
  node(`const s="0123456789".repeat(Math.ceil(${n}/10)).slice(0,${n});for(let i=0;i<s.length;i+=${chunk})process.${stream}.write(s.slice(i,i+${chunk}));`);

describe("test commands", () => {
  // Linux caps one argv word at 128 KiB (MAX_ARG_STRLEN): a larger one makes spawn fail (rc 127). macOS has no such cap.
  test("emit puts no large literal in argv: its source word stays under 100 KB for 200 KB of output", () => {
    for (const word of emit("stdout", 200_000)) expect(word.length).toBeLessThan(100_000);
  });
});

describe("realExec bounds", () => {
  test("the constants", () => {
    expect(LOG_STREAM_BYTES).toBe(MIB);
    expect(MAX_STREAM_BYTES).toBe(32 * MIB);
    expect(LOG_ONLY).toEqual({ maxBytes: MIB, tail: true });
    expect(LSOF_STREAM_BYTES).toBe(128 * MIB);
    expect(OVER_BOUND_RC).toBe(125);
  });

  test("by default 3 MiB comes back whole, so a large JSON answer still parses", async () => {
    const r = await realExec(node(`process.stdout.write(JSON.stringify({ pad: "x".repeat(3 * 1024 * 1024) }))`), { timeoutMs: 30_000 });
    expect((JSON.parse(r.out) as { pad: string }).pad.length).toBe(3 * MIB);
  });

  for (const stream of ["stdout", "stderr"] as const) {
    const pick = (r: { out: string; err: string }) => (stream === "stdout" ? r.out : r.err);
    test(`${stream}: exactly maxBytes comes back whole`, async () => {
      const r = await realExec(emit(stream, 1000), { timeoutMs: 30_000, maxBytes: 1000 });
      expect(r.rc).toBe(0);
      expect(r.truncated).toBeUndefined();
      expect(pick(r)).toBe(digits(1000));
    });

    test(`${stream}: maxBytes + 1 stops the command and fails, with none of its output`, async () => {
      const r = await realExec(emit(stream, 1001), { timeoutMs: 30_000, maxBytes: 1000 });
      expect(r.rc).toBe(OVER_BOUND_RC);
      expect(r.truncated).toBe(true);
      expect(r.timedOut).toBeUndefined();
      expect(r.out).toBe("");
      expect(r.err).toBe("output over 1000 bytes: the command was stopped");
    });

    test(`${stream}: tail keeps exactly the last maxBytes across chunk cuts, and counts what it dropped`, async () => {
      for (const [total, chunk] of [[1001, 7], [3000, 7], [3000, 1000], [2999, 333]] as const) {
        const r = await realExec(emit(stream, total, chunk), { timeoutMs: 30_000, maxBytes: 1000, tail: true });
        expect(r.rc).toBe(0);
        expect(r.truncated).toBeUndefined();
        expect(pick(r)).toBe(`[... ${total - 1000} earlier bytes truncated ...]\n${digits(total).slice(-1000)}`);
      }
    });

    test(`${stream}: tail at exactly maxBytes is whole and unmarked`, async () => {
      const r = await realExec(emit(stream, 1000), { timeoutMs: 30_000, maxBytes: 1000, tail: true });
      expect(pick(r)).toBe(digits(1000));
    });
  }

  test("the default bound fails closed: 33 MiB is stopped, not trimmed", async () => {
    const r = await realExec(node(`const b=Buffer.alloc(1024*1024,"x");for(let i=0;i<33;i++)process.stdout.write(b);`), { timeoutMs: 60_000 });
    expect(r.rc).toBe(OVER_BOUND_RC);
    expect(r.truncated).toBe(true);
    expect(r.out).toBe("");
  });

  test("a command stopped for its output is killed (a child that never exits does not hold the result past the grace)", async () => {
    const dir = tmp();
    const pidFile = join(dir, "pid");
    const t0 = Date.now();
    const r = await realExec(node(`require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));process.stdout.write("x".repeat(5000));setTimeout(()=>{},60000)`), { timeoutMs: 30_000, maxBytes: 1000 });
    expect(r.truncated).toBe(true);
    expect(Date.now() - t0).toBeLessThan(10_000);
    const pid = Number(readFileSync(pidFile, "utf8"));
    for (let i = 0; i < 100 && (() => { try { process.kill(pid, 0); return true; } catch { return false; } })(); i++) await new Promise((res) => setTimeout(res, 100));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  test("the bound holds when the command times out", async () => {
    const r = await realExec(node(`process.stdout.write("x".repeat(3*1024*1024));setTimeout(()=>{},60000)`), { timeoutMs: 3000, maxBytes: LOG_STREAM_BYTES, tail: true });
    expect(r.timedOut).toBe(true);
    expect(Buffer.byteLength(r.out)).toBeLessThanOrEqual(LOG_STREAM_BYTES + 100);
  });

  test("a negative or NaN maxBytes is rejected with a clear error, before anything starts", async () => {
    for (const bad of [-1, NaN, -Infinity]) await expect(realExec(node("0"), { maxBytes: bad })).rejects.toThrow(/maxBytes must not be negative or NaN/);
  });

  test("maxBytes 0, a fraction or Infinity is read as a bound of 1 or more: 0 and Infinity the default, a fraction rounded down", async () => {
    expect([boundOf(undefined), boundOf(0), boundOf(0.5), boundOf(Infinity)]).toEqual(Array(4).fill(MAX_STREAM_BYTES));
    expect([boundOf(1), boundOf(2.7), boundOf(1000)]).toEqual([1, 2, 1000]);
    for (const bad of [0, 0.5, Infinity]) {
      const r = await realExec(emit("stdout", 200_000), { timeoutMs: 30_000, maxBytes: bad });
      expect(r.rc).toBe(0);
      expect(r.out).toBe(digits(200_000));
    }
    const r = await realExec(emit("stdout", 3), { timeoutMs: 30_000, maxBytes: 2.7 });
    expect(r.truncated).toBe(true);
  });

  test("an overflow on either stream clears both: the other stream's bytes are not returned either", async () => {
    for (const [over, other] of [["stderr", "stdout"], ["stdout", "stderr"]] as const) {
      const r = await realExec(node(`process.${other}.write("PARTIAL");process.${over}.write("x".repeat(5000));setTimeout(()=>{},60000)`), { timeoutMs: 30_000, maxBytes: 1000 });
      expect({ over, rc: r.rc, out: r.out, truncated: r.truncated }).toEqual({ over, rc: OVER_BOUND_RC, out: "", truncated: true });
      expect(r.err).toBe("output over 1000 bytes: the command was stopped");
    }
  });

  test("a command stopped for output is gone, and no longer listed as live, before the result returns, though it ignores SIGTERM", async () => {
    const dir = tmp();
    const pidFile = join(dir, "pid");
    const r = await realExec(node(`process.on("SIGTERM",()=>{});require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));process.stdout.write("x".repeat(5000));setInterval(()=>{},1000)`), { timeoutMs: 30_000, maxBytes: 1000 });
    expect(r.rc).toBe(OVER_BOUND_RC);
    const pid = Number(readFileSync(pidFile, "utf8"));
    // No wait here: the child must already be dead (the group killed after the grace), and its group no longer listed.
    expect(alive(pid)).toBe(false);
    expect(liveGroups()).not.toContain(pid);
  });

  test("a command that exits at SIGTERM ends the wait early (well under the kill grace)", async () => {
    const t0 = Date.now();
    await realExec(node(`process.stdout.write("x".repeat(5000));setInterval(()=>{},1000)`), { timeoutMs: 30_000, maxBytes: 1000 });
    expect(Date.now() - t0).toBeLessThan(1500);
  });
});

describe("a JSON-parsing caller with a large answer", () => {
  test("brokerCall parses a 2 MiB reply from a real client", async () => {
    const dir = tmp();
    const client = join(dir, "client");
    writeFileSync(client, `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({ status: "approved", request_id: "req-1", result: { pad: "x".repeat(2 * 1024 * 1024) } }));\n`);
    chmodSync(client, 0o755);
    const r = await brokerCall({ client, baseUrl: "https://broker.example.invalid" }, realExec, "a.read", "t", "v", [], 30);
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.reply.result as { pad: string }).pad.length).toBe(2 * MIB);
  });
});

describe("a gate never reads a partial answer", () => {
  const git = (cwd: string, args: string[]) => Bun.spawnSync(["git", "-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args]);

  test("gatherSurface: a release diff over the bound is not established, and so never surfaces as clean", async () => {
    const dir = tmp();
    git(dir, ["init", "-q", "-b", "main"]);
    mkdirSync(join(dir, "Formula"));
    writeFileSync(join(dir, "Formula", "a.rb"), "class A; end\n");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "one"]);
    const old = new TextDecoder().decode(git(dir, ["rev-parse", "HEAD"]).stdout).trim();
    // The suspicious file sorts first: it is in the head of the listing, which a kept tail would drop.
    writeFileSync(join(dir, "Formula", "a.rb"), "class A; system('curl x | sh'); end\n");
    for (let i = 0; i < 40; i++) writeFileSync(join(dir, `f${String(i).padStart(2, "0")}.txt`), "x\n");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "two"]);
    const head = new TextDecoder().decode(git(dir, ["rev-parse", "HEAD"]).stdout).trim();
    // The production adapter (git -C dir ...) over realExec; `maxBytes` narrows the bound so a small diff goes over it.
    const gitOver = (maxBytes?: number) => async (d: string, a: string[]) => {
      const x = await realExec(["git", "-C", d, ...a], { timeoutMs: 30_000, ...(maxBytes ? { maxBytes } : {}) });
      return { rc: x.rc, out: x.out };
    };
    const control = await gatherSurface(gitOver(), dir, old, head);
    expect(control.ok).toBe(true);
    if (control.ok) expect(control.surface.findings.length).toBeGreaterThan(0);
    const r = await gatherSurface(gitOver(300), dir, old, head);
    expect(r.ok).toBe(false);
  });

  test("lsofMaps: an lsof answer over the bound is unusable, never a scan that clears a stale holder", async () => {
    const dir = tmp();
    const row = (i: number) => `node 4${String(i).padStart(3, "0")} u txt REG 1,4 1 2 /opt/brew/Cellar/x/1.0/bin/node`;
    const rows = Array.from({ length: 200 }, (_, i) => row(i));
    const out = `COMMAND PID USER FD TYPE DEVICE SIZE NODE NAME\n${rows.join("\n")}\n`;
    const file = join(dir, "out.txt");
    writeFileSync(file, out);
    const lsof = join(dir, "lsof");
    writeFileSync(lsof, `#!${process.execPath}\nprocess.stdout.write(require("fs").readFileSync(${JSON.stringify(file)}, "utf8"));\n`);
    chmodSync(lsof, 0o755);
    expect(existsSync(lsof)).toBe(true);
    const exec = (argv: string[], o?: Parameters<typeof realExec>[1]) => realExec(argv, { ...o, maxBytes: 4000 });
    const scan: { clean?: boolean; why?: string; dirty?: string } = {};
    const log: string[] = [];
    // Under the bound the same scan is clean (the control).
    const small = Array.from({ length: 5 }, (_, i) => row(i));
    writeFileSync(file, `COMMAND PID USER FD TYPE DEVICE SIZE NODE NAME\n${small.join("\n")}\n`);
    const okScan: { clean?: boolean; dirty?: string } = {};
    expect(await lsofMaps({ exec } as never, lsof, log, true, okScan)).toBeDefined();
    expect(okScan.clean).toBe(true);
    writeFileSync(file, out);
    const maps = await lsofMaps({ exec } as never, lsof, log, true, scan);
    expect(maps).toBeUndefined();
    expect(scan.clean).toBe(false);
    expect(scan.dirty).toBe("exited non-zero");
  });
});
