// OUP-326 item 4: outdated formulae that use each other are upgraded as one `brew upgrade a b c`.
import { describe, expect, test } from "bun:test";
import { applyHost } from "../../src/apply/run.ts";
import { fakeHost, fakeTypeB, testConfig, type HostScript } from "./host-fixture.ts";
import { scripted } from "./helpers.ts";

const upgrades = (calls: string[]) => calls.filter((c) => c.startsWith("brew upgrade"));
const BIN = "/brew/Cellar/bun/1.2.0/bin/bun";

/** `names` all outdated in homebrew/core; `uses` is each name's installed dependents (`brew uses`). */
async function run(names: string[], o: { uses?: Record<string, string>; script?: HostScript; cfg?: Parameters<typeof testConfig>[0]; dryRun?: boolean; taps?: Record<string, string>; bunExec?: string } = {}) {
  const h = fakeHost({
    formulas: names.join(" "),
    verbose: names.map((n) => `${n} (1.0) < 1.1`).join("\n"),
    formulaTaps: { ...Object.fromEntries(names.map((n) => [n, "homebrew/core"])), ...o.taps },
    ...(o.uses ? { uses: o.uses } : {}),
    ...o.script,
  });
  const res = await applyHost(testConfig({ logFile: "/log.test/h.log", ...o.cfg }), h.exec, h.fs, { dryRun: o.dryRun ?? false, reviewer: scripted([], "APPROVE\nno attack indicators found").r, typeB: fakeTypeB(0).typeB, now: new Date(2026, 9, 22, 7, 0), ...(o.bunExec ? { bunExec: o.bunExec } : {}) });
  const lr = h.files.get("/state.test/last-run.json");
  return { ...res, ...h, text: [...res.log, ...res.summary].join("\n"), lastRun: lr === undefined ? undefined : JSON.parse(lr) };
}

describe("dependents upgraded as one unit (OUP-326 item 4)", () => {
  test("an outdated dependent is upgraded in the same brew upgrade as what it uses", async () => {
    const r = await run(["a", "b"], { uses: { a: "b\n" } });
    expect(upgrades(r.calls)).toEqual(["brew upgrade a b"]);
    expect(r.calls).toContain("brew uses --installed --recursive --formula a");
    expect(r.text).toContain("upgraded: a b");
    expect(r.rc).toBe(0);
  });
  test("formulae that share no dependents are upgraded one by one, as before", async () => {
    const r = await run(["a", "b"], { uses: { a: "zlib\n" } });
    expect(upgrades(r.calls)).toEqual(["brew upgrade a", "brew upgrade b"]);
  });
  test("a dependent that is not outdated does not widen the set", async () => {
    const r = await run(["a", "b"], { uses: { a: "up-to-date-dep\n" } });
    expect(upgrades(r.calls)).toEqual(["brew upgrade a", "brew upgrade b"]);
  });
  test("sets that share a member are one set, where its last member was", async () => {
    const r = await run(["a", "x", "c", "d"], { uses: { a: "c\n", d: "c\n" } });
    expect(upgrades(r.calls)).toEqual(["brew upgrade x", "brew upgrade a c d"]);
  });
  test("a member is not moved past a formula it uses or that uses it, or one not read: it upgrades alone, where it was", async () => {
    // m's dependents could not be read: a would pass it on its way to z.
    const r = await run(["a", "m", "z"], { uses: { a: "z\n" }, script: { rc: { "brew uses --installed --recursive --formula m": 1 } } });
    expect(upgrades(r.calls)).toEqual(["brew upgrade a", "brew upgrade m", "brew upgrade z"]);
    expect(r.text).toContain("a: upgraded alone — upgrading it with z would move it past m");
    // m lists a as its dependent: all three are one set, where z was.
    const q = await run(["a", "m", "z"], { uses: { a: "z\n", m: "a\n" } });
    expect(upgrades(q.calls)).toEqual(["brew upgrade a m z"]);
    // m is read and unrelated to a and z: a and z stay one set, where z was, and m goes before it.
    const u = await run(["a", "m", "z"], { uses: { a: "z\n", m: "q\n" } });
    expect(upgrades(u.calls)).toEqual(["brew upgrade m", "brew upgrade a z"]);
  });
  test("a member is not moved past a read formula that is related to it but not in the set", async () => {
    // a lists y as a dependent, but y has a pinned outdated dependent p, so y is alone: a would pass y on its way to z.
    const r = await run(["a", "y", "z", "p"], { uses: { a: "z\ny\n", y: "p\n" }, script: { pinned: "p" } });
    expect(upgrades(r.calls)).toEqual(["brew upgrade a", "brew upgrade y", "brew upgrade z"]);
    expect(r.text).toContain("a: upgraded alone — upgrading it with z would move it past y");
  });
  test("a set is dispatched where its last member was: the time-box breaker the earlier formulae hit comes first", async () => {
    const r = await run(["a", "x", "y", "b"], { uses: { a: "b\n" }, script: { timeout: ["brew upgrade x", "brew upgrade y"] } });
    expect(upgrades(r.calls)).toEqual(["brew upgrade x", "brew upgrade y"]);
    expect(r.text).toContain("waiting for the next run: a b");
  });
  test("a set that partly succeeded: the member brew installed counts upgraded, the other is FAILED by name", async () => {
    const r = await run(["a", "b"], { uses: { a: "b\n" }, script: { upgradeRc: { "a b": 1 }, upgradePartial: { "a b": ["a"] } } });
    expect(r.text).toContain("upgraded: a");
    expect(r.lastRun.failed).toEqual(["b"]);
    expect(r.rc).toBe(1);
  });
  test("brew exits 1 after installing both members: both count upgraded and the run is still a failure", async () => {
    const r = await run(["a", "b"], { uses: { a: "b\n" }, script: { upgradeRc: { "a b": 1 }, upgradePartial: { "a b": ["a", "b"] } } });
    expect(r.text).toContain("upgraded: a b");
    expect(r.lastRun.failed).toEqual(["a", "b"]);
    expect(r.lastRun.ok).toBe(false);
    expect(r.rc).toBe(1);
  });
  test("a single dependents line holding two names is unreadable: upgraded alone, not split into a set", async () => {
    const r = await run(["a", "b", "c"], { uses: { a: "b c\n" } });
    expect(upgrades(r.calls)).toEqual(["brew upgrade a", "brew upgrade b", "brew upgrade c"]);
    expect(r.text).toContain("a: upgraded alone — its dependents could not be read");
  });
  test("a set that failed and whose versions cannot be read: every member FAILED", async () => {
    const r = await run(["a", "b"], { uses: { a: "b\n" }, script: { upgradeRc: { "a b": 1 }, upgradePartial: { "a b": ["a"] }, rc: { "brew info --json=v2 a": 1, "brew info --json=v2 b": 1 } } });
    expect(r.lastRun.failed).toEqual(["a", "b"]);
  });
  test("a dependents read that times out upgrades the formula alone and the loop goes on", async () => {
    const r = await run(["a", "b"], { uses: { a: "b\n" }, script: { timeout: ["brew uses --installed --recursive --formula a"] } });
    expect(upgrades(r.calls)).toEqual(["brew upgrade a", "brew upgrade b"]);
    expect(r.text).toContain("a: the read of its dependents timed out");
  });
  test("a formula marked alone is in no set, even when another formula lists it", async () => {
    const r = await run(["a", "b"], { uses: { b: "a\n" }, script: { rc: { "brew uses --installed --recursive --formula a": 1 } } });
    expect(upgrades(r.calls)).toEqual(["brew upgrade a", "brew upgrade b"]);
  });
  test("apply.heldByDesign is matched on the whole name, as the stuck report does", async () => {
    const r = await run(["a", "b"], { uses: { a: "b\n" }, cfg: { heldByDesign: ["example/tap/b"] } });
    expect(upgrades(r.calls)).toEqual(["brew upgrade a b"]);
  });
  test("an option-like line in the read makes it unreadable, whatever else it names", async () => {
    const r = await run(["a", "b"], { uses: { a: "b\n--force\n" } });
    expect(upgrades(r.calls)).toEqual(["brew upgrade a", "brew upgrade b"]);
  });
  test("a pinned outdated dependent is never pulled in: the formula upgrades alone, and the pinned one is held", async () => {
    const r = await run(["a", "b", "x"], { uses: { a: "b\n" }, script: { pinned: "b" } });
    expect(upgrades(r.calls)).toEqual(["brew upgrade a", "brew upgrade x"]);
    expect(r.text).toContain("a: upgraded alone — its outdated dependent b is held or not upgraded in this list");
  });
  test("a release-checked dependent that reaches the Type A list is never pulled in", async () => {
    const info = JSON.stringify({ formulae: [{ name: "b", full_name: "b", tap: "homebrew/core", keg_only: false, linked_keg: "1.0", installed: [{ version: "1.0" }], versions: { stable: "1.1" }, revision: 0 }] });
    const r = await run(["a", "b", "x"], { uses: { a: "b\n" }, script: { answers: { "brew info --json=v2 b": { rc: 0, out: info } } }, cfg: { releaseChecks: [{ formula: "b", command: ["/opt/gate.test/run"], before: [], after: [], timeoutMs: 1000 }] as never } });
    expect(r.text).toContain("Type A (first-party): a b x");
    expect(upgrades(r.calls).some((c) => c.includes(" a b") || c.includes(" b a"))).toBe(false);
    expect(r.text).toContain("a: upgraded alone");
  });
  test("a dependents line that is not a package name makes the read fail: upgraded alone", async () => {
    const r = await run(["a", "b"], { uses: { a: "b\nwe!rd\n" } });
    expect(upgrades(r.calls)).toEqual(["brew upgrade a", "brew upgrade b"]);
  });
  test("a formula held by design is not pulled in", async () => {
    const r = await run(["a", "b", "x"], { uses: { a: "b\n" }, cfg: { heldByDesign: ["b"] } });
    expect(upgrades(r.calls)).toEqual(["brew upgrade a", "brew upgrade b", "brew upgrade x"]);
    expect(r.text).toContain("a: upgraded alone");
  });
  test("the bun this run executes under is not pulled in", async () => {
    const r = await run(["a", "bun", "x"], { uses: { a: "bun\n" }, bunExec: BIN });
    expect(upgrades(r.calls)).toEqual(["brew upgrade a", "brew upgrade x"]);
  });
  test("a Type B or unknown-tap dependent is not pulled in", async () => {
    const r = await run(["a", "b", "x"], { uses: { a: "b\n" }, taps: { b: "example/other" } });
    expect(upgrades(r.calls)).toEqual(["brew upgrade a", "brew upgrade x"]);
    const t = await run(["a", "b", "x"], { uses: { a: "b\n" }, taps: { b: "example/svc" } });
    expect(upgrades(t.calls)).toEqual(["brew upgrade a", "brew upgrade x", "brew upgrade example/svc/b"]);
  });
  test("a dependents list that cannot be read: upgraded alone, as before", async () => {
    const r = await run(["a", "b"], { uses: { a: "b\n" }, script: { rc: { "brew uses --installed --recursive --formula a": 1 } } });
    expect(upgrades(r.calls)).toEqual(["brew upgrade a", "brew upgrade b"]);
    expect(r.text).toContain("a: upgraded alone — its dependents could not be read");
  });
  test("a dependent name that could be read as an option is never an argument", async () => {
    const r = await run(["a", "b"], { uses: { a: "--force\n" } });
    expect(upgrades(r.calls)).toEqual(["brew upgrade a", "brew upgrade b"]);
    const q = await run(["a", "-b"], { uses: { a: "-b\n" } });
    expect(upgrades(q.calls).every((c) => c.split(" ").length === 3)).toBe(true);
  });
  test("a failed set is FAILED for each member by name; the next unit still runs", async () => {
    const r = await run(["a", "b", "x"], { uses: { a: "b\n" }, script: { upgradeRc: { "a b": 1 } } });
    expect(upgrades(r.calls)).toEqual(["brew upgrade a b", "brew upgrade x"]);
    expect(r.rc).toBe(1);
    expect(r.lastRun.failed).toEqual(["a", "b"]);
    expect(r.text).toContain("upgraded: x");
  });
  test("one set is one package for the time box: bounded by upgradeTimeoutMs, soft, FAILED per member", async () => {
    const r = await run(["a", "b", "x"], { uses: { a: "b\n" }, cfg: { upgradeTimeoutMs: 12345 }, script: { timeout: ["brew upgrade a b"] } });
    const call = r.callOpts.find((c) => c.line === "brew upgrade a b")!;
    expect(call.opts?.timeoutMs).toBe(12345);
    expect(call.opts?.soft).toBe(true);
    expect(r.lastRun.failed).toEqual(["a", "b"]);
    expect(upgrades(r.calls)).toContain("brew upgrade x");
  });
  test("two timed-out sets in a row stop the rest, counted once per set", async () => {
    const r = await run(["a", "b", "c", "d", "x"], { uses: { a: "b\n", c: "d\n" }, script: { timeout: ["brew upgrade a b", "brew upgrade c d"] } });
    expect(upgrades(r.calls)).toEqual(["brew upgrade a b", "brew upgrade c d"]);
    expect(r.text).toContain("waiting for the next run: x");
  });
  test("a dry run upgrades nothing and logs the set it would upgrade", async () => {
    const r = await run(["a", "b"], { uses: { a: "b\n" }, dryRun: true });
    expect(upgrades(r.calls)).toEqual([]);
    expect(r.text).toContain("dry-run: would upgrade as one unit: a b");
  });
  test("a single outdated formula makes no dependents query", async () => {
    const r = await run(["a"], { uses: { a: "b\n" } });
    expect(r.calls.some((c) => c.startsWith("brew uses"))).toBe(false);
    expect(upgrades(r.calls)).toEqual(["brew upgrade a"]);
  });
});
