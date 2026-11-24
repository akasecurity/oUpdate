// `host --apply` deletes oUpdate's own old config backups after a clean run (fixed name patterns,
// older than config.json), lists them in a dry run, and never touches anything else.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, lutimesSync, readFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Exec } from "../../src/apply/exec.ts";
import { realFs, type ApplyFs } from "../../src/apply/fs.ts";
import { applyMain } from "../../src/host/cli.ts";
import { fakeHost } from "./host-fixture.ts";

const root = mkdtempSync(join(tmpdir(), "oupdate-backups-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const T0 = Date.UTC(2026, 10, 1) / 1000;

/** A config dir: config.json at T0+1000 s; each file in `files` at T0 + its offset (seconds). */
function setup(files: Record<string, number>) {
  const dir = join(root, `c${++n}`);
  mkdirSync(dir, { recursive: true });
  const cfg = join(dir, "config.json");
  writeFileSync(cfg, JSON.stringify({ apply: { stateDir: join(dir, "state"), npm: null } }));
  utimesSync(cfg, T0 + 1000, T0 + 1000);
  for (const [name, off] of Object.entries(files)) {
    writeFileSync(join(dir, name), "x");
    utimesSync(join(dir, name), T0 + off, T0 + off);
  }
  return { dir, cfg };
}

/** The scripted host with the real file system for the config dir only (listing, mtimes, removal). */
function fsFor(dir: string, over: Partial<ApplyFs> = {}): ApplyFs {
  const h = fakeHost();
  const inDir = (p: string) => dirname(p) === dir;
  return {
    ...h.fs,
    listDir: (p) => (p === dir ? realFs.listDir(p) : h.fs.listDir(p)),
    mtimeMs: realFs.mtimeMs!,
    remove: (p) => (inDir(p) ? realFs.remove(p) : h.fs.remove(p)),
    ...over,
  };
}

const run = (c: { dir: string; cfg: string }, dryRun: boolean, over: Partial<ApplyFs> = {}) => {
  const h = fakeHost();
  return applyMain({ mode: "apply", config: c.cfg, dryRun, host: "hosta" }, { exec: h.exec, fs: fsFor(c.dir, over), out: () => {} });
};

const OLD = {
  "config.json.bak-20261101": 10,
  "config.json.pre-oq4e": 20,
  "config.json.bak-pre-staleowners": 30,
  "targets.json.pre-edit": 40,
};
const KEEP = {
  "config.json.bak-newer": 2000,
  "config.json.pre-newer": 1000.5,
  "config.json.bak-same": 1000,
  renovate: 10,
  "renovate-token": 10,
  "release-signing": 10,
  "scan-deny.txt": 10,
  "config.json.bak": 10,
  "config.json.pre-": 10,
  "config.json.keep": 10,
  "targets.json": 10,
  "oharness.pre-x": 10,
  "ilane.stale-x": 10,
};

describe("old config backups", () => {
  test("a clean apply run deletes the matching old files and keeps every other name", async () => {
    const c = setup({ ...OLD, ...KEEP });
    const r = await run(c, false);
    expect(r.rc).toBe(0);
    for (const f of Object.keys(OLD)) expect(existsSync(join(c.dir, f))).toBe(false);
    for (const f of Object.keys(KEEP)) expect(existsSync(join(c.dir, f))).toBe(true);
    expect(existsSync(c.cfg)).toBe(true);
    for (const f of Object.keys(OLD)) expect(r.text).toContain(`config backup: deleted ${join(c.dir, f)}`);
  });

  test("a dry run lists what it would delete and deletes nothing", async () => {
    const c = setup({ ...OLD, ...KEEP });
    const r = await run(c, true);
    for (const f of [...Object.keys(OLD), ...Object.keys(KEEP)]) expect(existsSync(join(c.dir, f))).toBe(true);
    for (const f of Object.keys(OLD)) expect(r.text).toContain(`config backup: would delete ${join(c.dir, f)}`);
    expect(r.text).not.toContain("config backup: deleted");
  });

  test("a failed delete is a warning; the run's rc and the other deletions stand", async () => {
    const c = setup({ "config.json.bak-a": 10, "config.json.bak-b": 20 });
    const bad = join(c.dir, "config.json.bak-a");
    const r = await run(c, false, { remove: async (p) => (p === bad ? Promise.reject(new Error("EPERM")) : realFs.remove(p)) });
    expect(r.rc).toBe(0);
    expect(r.text).toContain(`WARNING: config backup: could not delete ${bad} (EPERM)`);
    expect(existsSync(bad)).toBe(true);
    expect(existsSync(join(c.dir, "config.json.bak-b"))).toBe(false);
  });

  test("a directory and a symlink named like a backup, older than config.json, survive; the link's target is untouched", async () => {
    const c = setup({});
    const outside = join(root, `outside${n}`);
    writeFileSync(outside, "keep");
    utimesSync(outside, T0 + 10, T0 + 10);
    mkdirSync(join(c.dir, "config.json.bak-dir"));
    utimesSync(join(c.dir, "config.json.bak-dir"), T0 + 10, T0 + 10);
    symlinkSync(outside, join(c.dir, "config.json.pre-link"));
    lutimesSync(join(c.dir, "config.json.pre-link"), T0 + 10, T0 + 10);
    const r = await run(c, false);
    expect(r.rc).toBe(0);
    expect(statSync(join(c.dir, "config.json.bak-dir")).isDirectory()).toBe(true);
    expect(lstatSync(join(c.dir, "config.json.pre-link")).isSymbolicLink()).toBe(true);
    expect(readFileSync(outside, "utf8")).toBe("keep");
  });

  test("--config not named config.json: nothing is deleted, one line says so", async () => {
    const c = setup({ ...OLD });
    const custom = join(c.dir, "custom.json");
    renameSync(c.cfg, custom);
    writeFileSync(join(c.dir, "config.json"), "{}");
    utimesSync(join(c.dir, "config.json"), T0 + 1000, T0 + 1000);
    const h = fakeHost();
    const r = await applyMain({ mode: "apply", config: custom, dryRun: false, host: "hosta" }, { exec: h.exec, fs: fsFor(c.dir), out: () => {} });
    for (const f of Object.keys(OLD)) expect(existsSync(join(c.dir, f))).toBe(true);
    expect(r.text).toContain("config backup: cleanup skipped — --config is custom.json, not config.json");
  });

  test("a --config named like a backup is never deleted", async () => {
    const c = setup({});
    const odd = join(c.dir, "config.json.pre-x");
    renameSync(c.cfg, odd);
    writeFileSync(join(c.dir, "config.json"), "{}");
    utimesSync(join(c.dir, "config.json"), T0 + 2000, T0 + 2000);
    const h = fakeHost();
    await applyMain({ mode: "apply", config: odd, dryRun: false, host: "hosta" }, { exec: h.exec, fs: fsFor(c.dir), out: () => {} });
    expect(existsSync(odd)).toBe(true);
  });

  test("a run stopped by a signal deletes nothing", async () => {
    const c = setup({ ...OLD });
    const h = fakeHost();
    const handlers = new Map<string, () => void>();
    const signals = { on: (s: string, f: () => void) => handlers.set(s, f), off: (s: string) => handlers.delete(s) };
    let fired = false;
    const exec: Exec = async (argv, o) => {
      if (!fired) {
        fired = true;
        handlers.get("SIGTERM")!();
      }
      return h.exec(argv, o);
    };
    await applyMain({ mode: "apply", config: c.cfg, dryRun: false, host: "hosta" }, { exec, fs: fsFor(c.dir), out: () => {}, signals, exit: () => {}, stopLive: () => {} });
    expect(fired).toBe(true);
    for (const f of Object.keys(OLD)) expect(existsSync(join(c.dir, f))).toBe(true);
  });

  test("a run whose log cannot be written deletes nothing", async () => {
    const c = setup({ ...OLD });
    const blocker = join(c.dir, "blocker");
    writeFileSync(blocker, "file");
    writeFileSync(c.cfg, JSON.stringify({ apply: { stateDir: join(c.dir, "state"), npm: null, logFile: join(blocker, "sub", "run.log") } }));
    utimesSync(c.cfg, T0 + 1000, T0 + 1000);
    const h = fakeHost();
    const r = await applyMain({ mode: "apply", config: c.cfg, dryRun: false, host: "hosta" }, { exec: h.exec, fs: fsFor(c.dir), out: () => {} });
    expect(r.text).not.toContain("config backup: deleted");
    for (const f of Object.keys(OLD)) expect(existsSync(join(c.dir, f))).toBe(true);
  });

  test("a failed apply run (rc 1) deletes nothing", async () => {
    const c = setup({ ...OLD });
    const h = fakeHost({ lsof: ["COMMAND PID USER FD TYPE DEVICE SIZE NODE NAME\nlaunchd 1 root txt REG 1,4 1 2 /sbin/launchd\n"], casks: "app", caskTaps: { app: "homebrew/cask" }, verbose: "app (1.0) < 1.1", upgradeRc: { "--cask --greedy app": 1 } });
    const r = await applyMain({ mode: "apply", config: c.cfg, dryRun: false, host: "hosta" }, { exec: h.exec, fs: { ...h.fs, mtimeMs: realFs.mtimeMs!, listDir: (p) => (p === c.dir ? realFs.listDir(p) : h.fs.listDir(p)), remove: realFs.remove }, out: () => {} });
    expect(r.rc).toBe(1);
    for (const f of Object.keys(OLD)) expect(existsSync(join(c.dir, f))).toBe(true);
  });

  test("a --config path through a symlinked directory and `..`: only the directory that supplied config.json is cleaned", async () => {
    const base = join(root, `s${++n}`);
    mkdirSync(join(base, "real", "inner"), { recursive: true });
    symlinkSync(join(base, "real", "inner"), join(base, "lnk"));
    // The kernel reads lnk/../config.json as real/config.json; the lexical reading of the same path is base/config.json.
    for (const d of [join(base, "real"), base]) {
      writeFileSync(join(d, "config.json"), JSON.stringify({ apply: { stateDir: join(d, "state"), npm: null } }));
      utimesSync(join(d, "config.json"), T0 + 1000, T0 + 1000);
      writeFileSync(join(d, "config.json.bak-old"), "x");
      utimesSync(join(d, "config.json.bak-old"), T0 + 10, T0 + 10);
    }
    const h = fakeHost();
    await applyMain({ mode: "apply", config: `${base}/lnk/../config.json`, dryRun: false, host: "hosta" }, { exec: h.exec, fs: { ...h.fs, mtimeMs: realFs.mtimeMs!, listDir: realFs.listDir, remove: realFs.remove }, out: () => {} });
    expect(existsSync(join(base, "real", "config.json.bak-old"))).toBe(false);
    expect(existsSync(join(base, "config.json.bak-old"))).toBe(true);
  });
});
