import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseHostArgs, hostMain } from "../src/host/cli.ts";
import type { Runner } from "../src/host/probe.ts";

const dir = join(import.meta.dir, "fixtures", "host");
const fx = (f: string) => readFileSync(join(dir, f), "utf8");

// A runner that answers from the probe fixtures, keyed by the command.
function fixtureRunner(overrides: Record<string, string> = {}): { run: Runner; calls: string[][] } {
  const calls: string[][] = [];
  const clis = Object.fromEntries(fx("clis.txt").split("\n").filter(Boolean).map((l) => l.split("\t") as [string, string]));
  const table: Record<string, string> = {
    "sw_vers": fx("sw_vers.txt"),
    "brew info": fx("brew-info.json"),
    "brew outdated": fx("brew-outdated.json"),
    "npm ls": fx("npm-ls.json"),
    "npm outdated": fx("npm-outdated.json"),
    "docker images": fx("docker.jsonl"),
    "softwareupdate -l": fx("softwareupdate.txt"),
    ...overrides,
  };
  const run: Runner = async (argv) => {
    calls.push(argv);
    if (argv[1] === "--version") return clis[argv[0]!] ? { code: 0, stdout: clis[argv[0]!]! } : { code: 127, stdout: "" };
    const k = Object.keys(table).find((k) => argv.join(" ").startsWith(k));
    return { code: 0, stdout: k ? table[k]! : "" };
  };
  return { run, calls };
}

describe("oupdate host", () => {
  test("args: report-only is required; host defaults; state required", () => {
    expect(() => parseHostArgs(["--state", "x"])).toThrow(/--report-only/);
    expect(() => parseHostArgs(["--report-only"])).toThrow(/--state/);
    expect(parseHostArgs(["--report-only", "--state", "s", "--host", "h", "--prev-log", "l"])).toEqual({ host: "h", state: "s", prevLog: "l" });
  });

  test("never runs an update or install command", async () => {
    const { run, calls } = fixtureRunner();
    const state = mkdtempSync(join(tmpdir(), "oupdate-host-"));
    try {
      await hostMain({ host: "hosta", state, prevLog: join(dir, "prev.log") }, { run, feed: { query: async () => [] }, now: new Date("2026-10-21T20:00:00") });
      const flat = calls.map((c) => c.join(" "));
      expect(flat.some((c) => /\b(update|upgrade|install)\b/.test(c.replace("softwareupdate -l", "")))).toBe(false);
    } finally {
      rmSync(state, { recursive: true, force: true });
    }
  });

  test("first run writes the snapshot and the report; the next run diffs against it", async () => {
    const state = mkdtempSync(join(tmpdir(), "oupdate-host-"));
    try {
      const a = { host: "hosta", state, prevLog: join(dir, "prev.log") };
      const one = await hostMain(a, { ...fixtureRunner(), feed: { query: async () => [] }, now: new Date("2026-10-21T20:00:00") });
      expect(existsSync(join(state, "inventory.json"))).toBe(true);
      expect(existsSync(join(state, "reports", "2026-10-21.json"))).toBe(true);
      expect(one.report.compare?.upgraded.baseline).toBe(false);
      expect(one.text).toMatch(/^host hosta 2026-10-21: .*DIFFERS from the previous updater; agreeing weeks in a row: 0/);
      expect(one.text).toContain("outdated, not held by the previous updater: brotli npm");
      const two = await hostMain(a, { ...fixtureRunner(), feed: { query: async () => [] }, now: new Date("2026-10-21T21:00:00") });
      expect(two.report.compare?.upgraded.baseline).toBe(true);
      // nothing changed between the two snapshots, while the previous updater claims upgrades
      expect(two.report.compare?.upgraded.onlySecureUpdate).toContain("example-tool");
    } finally {
      rmSync(state, { recursive: true, force: true });
    }
  });

  test("a missing the previous updater log: report with a note, no comparison", async () => {
    const state = mkdtempSync(join(tmpdir(), "oupdate-host-"));
    try {
      const r = await hostMain({ host: "hosta", state, prevLog: join(state, "absent.log") }, { ...fixtureRunner(), feed: { query: async () => [] }, now: new Date("2026-10-21T20:00:00") });
      expect(r.report.compare).toBeNull();
      expect(r.text).toContain("no comparison");
    } finally {
      rmSync(state, { recursive: true, force: true });
    }
  });
});
