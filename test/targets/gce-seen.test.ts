// First-seen dates: a missing file is empty, a malformed one is an error (every package held), a new version restarts
// its date, a package no longer a candidate is dropped, and the file round-trips.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { noteSeen, readSeen, writeSeen } from "../../src/targets/gce/seen.ts";
import { realTargetFs, type TargetFs } from "../../src/targets/run.ts";
import { inv, VM_A, VM_B } from "./fake-gce.ts";
import { memFs } from "./fakes.ts";

const P = "/state/seen.json";
const EARLY = new Date("2026-10-20T03:00:00.000Z");
const NOW = new Date("2026-10-26T03:00:00.000Z");

describe("first-seen dates", () => {
  test("a missing file is empty; the first sighting is now; the file round-trips", async () => {
    const { fs, files } = memFs();
    const r = await readSeen(fs, P);
    expect(r).toEqual({ ok: true, seen: new Map() });
    if (!r.ok) return;
    const first = noteSeen(r.seen, VM_A, inv().candidates, NOW);
    expect([...first.values()].every((d) => d.getTime() === NOW.getTime())).toBe(true);
    expect(await writeSeen(fs, P, r.seen)).toBeUndefined();
    expect(JSON.parse(files.get(P)!)).toEqual({ [VM_A]: { "curl": { version: "8.5.0-2ubuntu10.6", first: NOW.toISOString() }, "libssl3t64": { version: "3.0.13-0ubuntu3.5", first: NOW.toISOString() }, "openssl": { version: "3.0.13-0ubuntu3.5", first: NOW.toISOString() } } });
    const again = await readSeen(fs, P);
    expect(again.ok && again.seen.get(VM_A)!.size).toBe(3);
  });

  test("a known version keeps its date; a new version restarts it; a gone candidate is dropped; other VMs stay", async () => {
    const text = JSON.stringify({
      [VM_A]: { "openssl": { version: "3.0.13-0ubuntu3.5", first: EARLY.toISOString() }, "libssl3t64": { version: "3.0.13-0ubuntu3.4", first: EARLY.toISOString() }, "zsh": { version: "5.9-7", first: EARLY.toISOString() } },
      [VM_B]: { "bash": { version: "5.2.21-2ubuntu5", first: EARLY.toISOString() } },
    });
    const { fs } = memFs({ [P]: text });
    const r = await readSeen(fs, P);
    if (!r.ok) throw new Error(r.why);
    const first = noteSeen(r.seen, VM_A, inv().candidates, NOW);
    expect(first.get("openssl")).toEqual(EARLY);
    expect(first.get("libssl3t64")).toEqual(NOW);
    expect([...r.seen.get(VM_A)!.keys()].sort()).toEqual(["curl", "libssl3t64", "openssl"]);
    expect(r.seen.get(VM_B)!.has("bash")).toBe(true);
  });

  test.each([
    ["not JSON", "{"],
    ["an array", "[]"],
    ["a bad VM key", JSON.stringify({ "VM A": {} })],
    ["a proto key", '{"__proto__": {}}'],
    ["a bad package key", JSON.stringify({ [VM_A]: { "Bash": { version: "1", first: NOW.toISOString() } } })],
    ["a bad version", JSON.stringify({ [VM_A]: { "bash": { version: "x y", first: NOW.toISOString() } } })],
    ["a bad time", JSON.stringify({ [VM_A]: { "bash": { version: "1", first: "yesterday" } } })],
    ["an extra key", JSON.stringify({ [VM_A]: { "bash": { version: "1", first: NOW.toISOString(), note: "x" } } })],
  ])("%s is an error", async (_what, text) => {
    const { fs } = memFs({ [P]: text });
    const r = await readSeen(fs, P);
    expect(r.ok).toBe(false);
    expect((r as { why: string }).why).toStartWith(`first-seen file ${P}`);
  });

  test("a write that fails returns its reason", async () => {
    const broken: TargetFs = { ...memFs().fs, writeFile: async () => { throw new Error("disk full"); } };
    expect(await writeSeen(broken, P, new Map())).toBe("disk full");
  });

  test("on the real filesystem only a missing file starts empty; any other read error holds everything", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oup-seen-"));
    try {
      expect(await readSeen(realTargetFs, join(dir, "seen.json"))).toEqual({ ok: true, seen: new Map() });
      const r = await readSeen(realTargetFs, dir);
      expect(r.ok).toBe(false);
      expect((r as { why: string }).why).toStartWith(`first-seen file ${dir} could not be read: `);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a read error from the fs is an error, not an empty file", async () => {
    const failing: TargetFs = { ...memFs().fs, readText: async () => ({ error: "EACCES: permission denied" }) };
    expect(await readSeen(failing, P)).toEqual({ ok: false, why: `first-seen file ${P} could not be read: EACCES: permission denied` });
  });
});
