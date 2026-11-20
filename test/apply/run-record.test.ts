// OUP-302 phase 1b: a real run writes a per-run record of the versions it is about to move from
// (<stateDir>/runs/<YYYYMMDD-HHMMSS>.json). Versions and names only: nothing is read from secrets.
// A dry run writes nothing. Only exec and the in-memory fs are stubbed (fakeHost); applyHost is real.
import { describe, expect, test } from "bun:test";
import { applyHost } from "../../src/apply/run.ts";
import { makeRunRecord, runRecordPath } from "../../src/apply/run-record.ts";
import { fakeHost, testConfig } from "./host-fixture.ts";

const now = new Date(2026, 10, 19, 8, 30, 5);
const FILE = runRecordPath("/state.test", now);
const base = {
  formulas: "good-a pinned-b",
  casks: "some-cask",
  verbose: "good-a (1.0) < 1.1\npinned-b (2.0) < 3.0\nsome-cask (4.0) != 4.1",
  formulaTaps: { "good-a": "homebrew/core", "pinned-b": "homebrew/core" },
  caskTaps: { "some-cask": "homebrew/cask" },
  pinned: "pinned-b\n",
  npmOutdated: JSON.stringify({ "left-pad": { current: "1.0.0", wanted: "1.3.0", latest: "1.3.0" } }),
};

describe("the per-run from-version record", () => {
  test("a real run records brew formula, cask and npm candidates with their from versions; a pinned one is not in it", async () => {
    const h = fakeHost(base);
    await applyHost(testConfig(), h.exec, h.fs, { dryRun: false, now });
    const rec = JSON.parse(h.files.get(FILE)!);
    expect(rec).toEqual({
      host: "hosta",
      startedAt: "2026-11-19 08:30",
      entries: [
        { manager: "brew-formula", name: "good-a", from: "1.0", to: "1.1" },
        { manager: "brew-cask", name: "some-cask", from: "4.0", to: "4.1" },
        { manager: "npm", name: "left-pad", from: "1.0.0", to: "1.3.0" },
      ],
    });
  });

  test("the record is on disk before the first upgrade command runs", async () => {
    const h = fakeHost(base);
    let seen: string | undefined;
    const exec: typeof h.exec = async (argv, o) => {
      if (argv[0] === "brew" && argv[1] === "upgrade" && seen === undefined) seen = h.files.get(FILE) ?? "missing";
      return h.exec(argv, o);
    };
    await applyHost(testConfig(), exec, h.fs, { dryRun: false, now });
    expect(seen).not.toBe("missing");
    expect(JSON.parse(seen!).entries.map((e: { name: string }) => e.name)).toContain("good-a");
  });

  test("a dry run writes nothing at all", async () => {
    const h = fakeHost(base);
    await applyHost(testConfig(), h.exec, h.fs, { dryRun: true, now });
    expect(h.writes).toEqual([]);
    expect([...h.files.keys()].filter((k) => k.includes("/runs/"))).toEqual([]);
  });

  test("a record that cannot be written is a warning line; the run and its rc are unchanged", async () => {
    const h = fakeHost(base);
    const fs = { ...h.fs, writeFile: async (p: string, t: string) => (p.includes("/runs/") ? Promise.reject(new Error("disk full")) : h.fs.writeFile(p, t)) };
    const ref = await applyHost(testConfig(), fakeHost(base).exec, fakeHost(base).fs, { dryRun: false, now });
    const r = await applyHost(testConfig(), h.exec, fs, { dryRun: false, now });
    expect(r.log.join("\n")).toContain(`WARNING: could not write the run record ${FILE} (disk full)`);
    expect(r.rc).toBe(ref.rc);
    expect(h.calls).toContain("brew upgrade good-a");
  });

  test("nothing outdated: no record file", async () => {
    const h = fakeHost({});
    await applyHost(testConfig(), h.exec, h.fs, { dryRun: false, now });
    expect([...h.files.keys()].filter((k) => k.includes("/runs/"))).toEqual([]);
  });

  test("two runs on the DST fall-back hour (the same local clock time, an hour apart) write two files", () => {
    const a = runRecordPath("/s", new Date("2026-11-01T08:30:00Z"));
    const b = runRecordPath("/s", new Date("2026-11-01T09:30:00Z"));
    expect(a).not.toBe(b);
    expect(a).toMatch(/^\/s\/runs\/20261101-083000Z-\d+\.json$/);
  });

  test("a failed write warns once however many entries follow; the entries stay in the next write", async () => {
    const log: string[] = [];
    const writes: string[] = [];
    let fail = true;
    const fs = { writeFile: async (_p: string, t: string) => { if (fail) throw new Error("disk full"); writes.push(t); } } as never;
    const rec = makeRunRecord({ fs, stateDir: "/s", host: "h", now, stamp: "x", dryRun: false, log });
    await rec.add([{ manager: "npm", name: "a", from: "1", to: "2" }]);
    await rec.add([{ manager: "npm", name: "b", from: "1", to: "2" }]);
    expect(log.filter((l) => l.includes("WARNING"))).toHaveLength(1);
    fail = false;
    await rec.add([{ manager: "npm", name: "c", from: "1", to: "2" }]);
    expect(JSON.parse(writes[0]!).entries.map((e: { name: string }) => e.name)).toEqual(["a", "b", "c"]);
  });
});
