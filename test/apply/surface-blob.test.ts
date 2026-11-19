// blobBytes reads at most the head of a blob and gives up on a git that stalls, dies part-way or leaves a child holding its pipe.
// Scripted `git` binaries (a shell script each), never the real git.
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BLOB_READ_MS, blobBytes, gatherSurface } from "../../src/apply/surface.ts";

const made: string[] = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "oup304-"));
  made.push(d);
  return d;
};
const fakeGit = (body: string) => {
  const f = join(tmp(), "git");
  writeFileSync(f, `#!/bin/sh\n${body}\n`);
  chmodSync(f, 0o755);
  return f;
};
const PNG = "\\211PNG\\r\\n\\032\\n";

describe("blobBytes", () => {
  test("a short blob that ends by itself is returned whole", async () => {
    const got = await blobBytes("/x", "r", "a.png", { git: fakeGit(`printf '${PNG}'`) });
    expect([...got!]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  });
  test("a blob past the head is cut to 64 bytes and git is stopped (SIGKILL: it ignores SIGTERM), not waited for", async () => {
    const pids = join(tmp(), "pids.txt");
    const t0 = Date.now();
    const got = await blobBytes("/x", "r", "a.png", { git: fakeGit(`trap '' TERM; echo $$ > ${pids}; (sleep 30 & echo $! >> ${pids}; wait) & while [ "$(wc -l < ${pids})" -lt 2 ]; do sleep 0.05; done; head -c 100000 /dev/zero; wait`), ms: 20_000 });
    expect(got!.length).toBe(64);
    expect(Date.now() - t0).toBeLessThan(10_000);
    const recorded = (await Bun.file(pids).text()).trim().split("\n").map(Number);
    expect(recorded.length).toBe(2); // git's pid and its child's, both recorded before the first byte
    for (const pid of recorded) {
      let gone = false;
      for (let i = 0; i < 30 && !gone; i++) {
        try {
          process.kill(pid, 0);
          await new Promise((r) => setTimeout(r, 100));
        } catch {
          gone = true;
        }
      }
      expect({ pid, gone }).toEqual({ pid, gone: true });
    }
  });
  test("bytes that arrive in several chunks are joined in order (40 + 40 -> the first 64)", async () => {
    const got = await blobBytes("/x", "r", "a.png", { git: fakeGit(`head -c 40 /dev/zero | tr '\\0' a; sleep 0.4; head -c 40 /dev/zero | tr '\\0' b`) });
    expect(new TextDecoder().decode(got!)).toBe("a".repeat(40) + "b".repeat(24));
  });
  test("a missing blob (git exits 128 with nothing printed) is undefined; an empty blob (exit 0, nothing printed) is empty", async () => {
    expect(await blobBytes("/x", "r", "a.png", { git: fakeGit("exit 128") })).toBeUndefined();
    expect((await blobBytes("/x", "r", "a.png", { git: fakeGit("exit 0") }))?.length).toBe(0);
  });
  test("a git that dies after a few bytes (8-63) with a failure is undefined, never a short head", async () => {
    expect(await blobBytes("/x", "r", "a.png", { git: fakeGit(`printf '${PNG}'; exit 1`) })).toBeUndefined();
  });
  test("a git that stalls is given up on at the deadline", async () => {
    const t0 = Date.now();
    expect(await blobBytes("/x", "r", "a.png", { git: fakeGit(`sleep 30`), ms: 300 })).toBeUndefined();
    expect(Date.now() - t0).toBeLessThan(5000);
  });
  test("a child that keeps the pipe open after git's own death (a lazy fetch) does not hold the read past the deadline, and is killed", async () => {
    const pidFile = join(tmp(), "child.pid");
    // The "fetch" child inherits stdout and outlives git, which exits at once after a few bytes. A generous deadline: the child
    // must have written its pid long before it (a loaded machine delays the shell by far less than a second).
    const git = fakeGit(`printf '${PNG}'; (sleep 30 & echo $! > ${pidFile}; wait) & exit 0`);
    const t0 = Date.now();
    // Not the 8 header bytes it printed before exiting: the read never finished, so there is no answer.
    expect(await blobBytes("/x", "r", "a.png", { git, ms: 2500 })).toBeUndefined();
    expect(Date.now() - t0).toBeLessThan(10_000);
    let pid = NaN;
    for (let i = 0; i < 100 && !(pid > 0); i++) {
      pid = Number((await Bun.file(pidFile).text().catch(() => "")).trim());
      if (!(pid > 0)) await new Promise((r) => setTimeout(r, 100));
    }
    expect(pid).toBeGreaterThan(0);
    for (let i = 0; i < 50; i++) {
      try {
        process.kill(pid, 0);
      } catch {
        return;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`the child ${pid} is still running`);
  });
  test("a git that is not installed is undefined (the binary is flagged), never a rejection", async () => {
    expect(await blobBytes("/x", "r", "a.png", { git: "/nonexistent/oup304/git" })).toBeUndefined();
  });
  test("a git that closes stdout and stays alive is given up on at the deadline, not waited for or read as a short head", async () => {
    const t0 = Date.now();
    expect(await blobBytes("/x", "r", "a.png", { git: fakeGit(`printf 'ab'; exec >&-; sleep 30`), ms: 400 })).toBeUndefined();
    expect(Date.now() - t0).toBeLessThan(5000);
  });
  test("the object is named after `--`, so a rev that starts with a dash is never an option", async () => {
    const out = join(tmp(), "argv.txt");
    await blobBytes("/x", "-evil", "a.png", { git: fakeGit(`echo "$@" > ${out}; printf 'x'`) });
    expect((await Bun.file(out).text()).trim()).toBe("-C /x cat-file blob -- -evil:a.png");
  });
  test("the default deadline is 30 s", () => {
    expect(BLOB_READ_MS).toBe(30_000);
  });
  test("the deadline timer is cleared: a process that read a blob exits at once, not after the deadline", async () => {
    const dir = tmp();
    const script = join(dir, "run.ts");
    const git = fakeGit(`printf 'x'`);
    writeFileSync(script, `import { blobBytes } from ${JSON.stringify(join(import.meta.dir, "../../src/apply/surface.ts"))};\nawait blobBytes("/x", "r", "a.png", { git: ${JSON.stringify(git)} });\n`);
    const t0 = Date.now();
    const p = Bun.spawn([process.execPath, "run", script], { stdout: "ignore", stderr: "ignore" });
    expect(await p.exited).toBe(0);
    expect(Date.now() - t0).toBeLessThan(10_000);
  });
  // The exit status of a git we stopped is not read: stated behavior change (base read the whole blob and flagged a non-zero status).
  for (const n of [64, 65]) {
    test(`a git that prints ${n} bytes of PNG magic and then exits 1 passes (stated: its exit is not read once the head is in)`, async () => {
      const git = fakeGit(`printf '${PNG}'; head -c ${n - 8} /dev/zero; exit 1`);
      const got = await blobBytes("/x", "r", "a.png", { git });
      expect(got!.length).toBe(64);
      expect([...got!.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    });
  }
  test("a group kill that fails with EPERM leaves a child we cannot stop: git itself is killed by pid and the read is flagged (undefined), not passed", async () => {
    const pidFile = join(tmp(), "git.pid");
    const git = fakeGit(`trap '' TERM; echo $$ > ${pidFile}; head -c 100000 /dev/zero; sleep 30`);
    const calls: [number, string][] = [];
    const kill = (pid: number, sig: NodeJS.Signals) => {
      calls.push([pid, sig]);
      if (pid < 0) throw Object.assign(new Error("EPERM"), { code: "EPERM" });
      process.kill(pid, sig);
    };
    expect(await blobBytes("/x", "r", "a.png", { git, ms: 20_000, kill })).toBeUndefined();
    const pid = Number((await Bun.file(pidFile).text()).trim());
    expect(calls.map((c) => c[0] < 0)).toEqual([true, false]);
    let gone = false;
    for (let i = 0; i < 30 && !gone; i++) {
      try {
        process.kill(pid, 0);
        await new Promise((r) => setTimeout(r, 100));
      } catch {
        gone = true;
      }
    }
    expect(gone).toBe(true);
  });
  test("ESRCH on the group kill means it is already gone: the head is returned", async () => {
    const kill = (pid: number) => {
      if (pid < 0) throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
    };
    const got = await blobBytes("/x", "r", "a.png", { git: fakeGit(`head -c 100 /dev/zero`), kill });
    expect(got!.length).toBe(64);
  });
  test("a stdout.getReader() that throws still stops git: the reader is taken inside the cleanup", async () => {
    const git = fakeGit(`sleep 30`);
    const real = Bun.spawn;
    let pid = NaN;
    (Bun as { spawn: unknown }).spawn = ((...a: Parameters<typeof Bun.spawn>) => {
      const sp = real(...a);
      pid = sp.pid;
      return new Proxy(sp, { get: (t, k) => (k === "stdout" ? { getReader: () => { throw new Error("no reader"); } } : Reflect.get(t, k, t)) });
    }) as never;
    try {
      expect(await blobBytes("/x", "r", "a.png", { git, ms: 20_000 })).toBeUndefined();
    } finally {
      (Bun as { spawn: unknown }).spawn = real;
    }
    expect(pid).toBeGreaterThan(0);
    let gone = false;
    for (let i = 0; i < 30 && !gone; i++) {
      try {
        process.kill(pid, 0);
        await new Promise((r) => setTimeout(r, 100));
      } catch {
        gone = true;
      }
    }
    expect(gone).toBe(true);
  });
  test("200 reads of an endless stream leave the open files where they were (reader.cancel releases the pipe)", async () => {
    const git = fakeGit(`cat /dev/zero`);
    const open = () => readdirSync("/dev/fd").length;
    await blobBytes("/x", "r", "a.png", { git });
    const before = open();
    for (let i = 0; i < 200; i++) await blobBytes("/x", "r", "a.png", { git });
    await new Promise((r) => setTimeout(r, 200));
    expect(open() - before).toBeLessThan(20);
  });
  test("a git that writes a lot to stderr is still read within the deadline (stderr is not a pipe nobody reads)", async () => {
    const t0 = Date.now();
    const got = await blobBytes("/x", "r", "a.png", { git: fakeGit(`head -c 3000000 /dev/zero >&2; printf '${PNG}'`), ms: 4000 });
    expect([...got!]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(Date.now() - t0).toBeLessThan(3500);
  });
});

// A real partial clone, as appBundleUpgrade's src.git is (--filter=blob:none): the blob of a new release tag is not local, and the read
// fetches it from the origin, as the whole-blob read did, so a clean release passes; a stalled fetch costs the deadline and leaves no process.
describe("blobBytes on a --filter=blob:none clone", () => {
  const run = (cwd: string, ...a: string[]) => Bun.spawnSync(["git", "-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...a]);
  const PNGHEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const partial = () => {
    const origin = tmp();
    run(origin, "init", "-q", "-b", "main");
    run(origin, "config", "uploadpack.allowFilter", "true");
    run(origin, "config", "uploadpack.allowAnySHA1InWant", "true");
    writeFileSync(join(origin, ".gitattributes"), "*.png binary\n");
    writeFileSync(join(origin, "logo.png"), Buffer.concat([PNGHEAD, Buffer.alloc(200, 1)]));
    run(origin, "add", "-A");
    run(origin, "commit", "-q", "-m", "one");
    run(origin, "tag", "v1");
    writeFileSync(join(origin, "logo.png"), Buffer.concat([PNGHEAD, Buffer.alloc(300, 2)]));
    run(origin, "commit", "-qam", "two");
    run(origin, "tag", "v2");
    const src = join(tmp(), "src.git");
    Bun.spawnSync(["git", "clone", "-q", "--bare", "--filter=blob:none", `file://${origin}`, src]);
    return src;
  };
  test("the blob of a tag that is not local is fetched and read: a clean release is not held", async () => {
    const src = partial();
    // Not local before the read (a partial clone keeps no blob it was not asked for).
    expect(Bun.spawnSync(["git", "-C", src, "cat-file", "-e", "v2:logo.png"], { env: { ...process.env, GIT_NO_LAZY_FETCH: "1" } }).exitCode).not.toBe(0);
    const got = await blobBytes(src, "v2", "logo.png");
    expect([...got!.subarray(0, 8)]).toEqual([...PNGHEAD]);
  });
  test("gatherSurface on the clone: a modified real PNG (attributes mark it binary) is benign: no finding", async () => {
    const src = partial();
    const git = async (dir: string, args: string[]) => {
      const r = Bun.spawnSync(["git", "-C", dir, ...args]);
      return { rc: r.exitCode ?? 1, out: r.stdout.toString() };
    };
    const ok = await gatherSurface(git, src, "v1", "v2");
    expect(ok.ok && ok.surface.findings).toEqual([]);
  });
  test("a fetch that stalls costs the deadline, and the fetch process is gone after", async () => {
    const src = partial();
    const dir = tmp();
    const pidFile = join(dir, "hook.pid");
    const hook = join(dir, "hook.sh");
    writeFileSync(hook, `#!/bin/sh\necho $$ > ${pidFile}\nsleep 25\nexec "$@"\n`);
    chmodSync(hook, 0o755);
    const cfg = join(dir, "gitconfig");
    writeFileSync(cfg, `[uploadpack]\n\tpackObjectsHook = ${hook}\n`);
    const was = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = cfg;
    try {
      const t0 = Date.now();
      expect(await blobBytes(src, "v2", "logo.png", { ms: 1500 })).toBeUndefined();
      expect(Date.now() - t0).toBeLessThan(8000);
    } finally {
      if (was === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = was;
    }
    const pid = Number((await Bun.file(pidFile).text().catch(() => "")).trim());
    expect(pid).toBeGreaterThan(0);
    let gone = false;
    for (let i = 0; i < 30 && !gone; i++) {
      try {
        process.kill(pid, 0);
        await new Promise((r) => setTimeout(r, 100));
      } catch {
        gone = true;
      }
    }
    expect(gone).toBe(true);
  });
});
