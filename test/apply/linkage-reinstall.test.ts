// OUP-326 item 3: formulae `brew linkage --test` names are reinstalled from source once, then tested again.
import { describe, expect, test } from "bun:test";
import { applyHost } from "../../src/apply/run.ts";
import type { Exec } from "../../src/apply/exec.ts";
import { fakeHost, fakeTypeB, testConfig, type HostScript } from "./host-fixture.ts";
import { scripted } from "./helpers.ts";

const BAD = (...names: string[]) => names.map((n) => `==> Checking ${n} linkage\nMissing libraries:\n  libx.dylib\n`).join("");
const REINSTALL = (n: string) => `brew reinstall --formula --build-from-source ${n}`;

/**
 * linkage: the output of each successive `brew linkage --test` call (rc 1 with that output; "" is clean, rc 0).
 * Everything else is the scripted host.
 */
async function run(o: { names?: string[]; linkage: string[]; script?: HostScript; dryRun?: boolean; cfg?: Parameters<typeof testConfig>[0]; reinstallRc?: Record<string, number>; timeout?: string[]; bunExec?: string; linkageTimesOutOn?: number; installed?: string[]; stopping?: () => boolean; secondRc?: number; secondListRc?: number }) {
  const names = o.names ?? ["good-a"];
  const h = fakeHost({ ...o.script, answers: { ...o.script?.answers, "brew list --formula": { rc: 0, out: `${names.join("\n")}\n` }, "brew list --formula --full-name": { rc: 0, out: `${[...names, ...(o.installed ?? [])].join("\n")}\n` } }, ...(o.timeout ? { timeout: o.timeout } : {}), rc: { ...o.script?.rc, ...Object.fromEntries(Object.entries(o.reinstallRc ?? {}).map(([n, rc]) => [REINSTALL(n), rc])) } });
  let n = 0;
  let lists = 0;
  const exec: Exec = async (argv, opts) => {
    if (o.secondListRc !== undefined && argv.join(" ") === "brew list --formula --full-name") return { rc: o.secondListRc, out: "", err: "" };
    if (argv[0] === "brew" && argv[1] === "linkage") {
      if (o.linkageTimesOutOn === n + 1) return { rc: 143, out: "", err: "", timedOut: true };
      const out = o.linkage[Math.min(n++, o.linkage.length - 1)] ?? "";
      h.calls.push(argv.join(" "));
      if (o.secondRc !== undefined && n >= 2) return { rc: o.secondRc, out: "", err: "" };
      return out ? { rc: 1, out, err: "" } : { rc: 0, out: "", err: "" };
    }
    return h.exec(argv, opts);
  };
  const res = await applyHost(testConfig({ logFile: "/log.test/h.log", ...o.cfg }), exec, h.fs, { dryRun: o.dryRun ?? false, reviewer: scripted([], "APPROVE\nno attack indicators found").r, typeB: fakeTypeB(0).typeB, now: new Date(2026, 9, 22, 7, 0), ...(o.bunExec ? { bunExec: o.bunExec } : {}), ...(o.stopping ? { isStopping: o.stopping } : {}) });
  const lr = h.files.get("/state.test/last-run.json");
  return { ...res, ...h, text: [...res.log, ...res.summary].join("\n"), lastRun: lr === undefined ? undefined : JSON.parse(lr) };
}
const reinstalls = (calls: string[]) => calls.filter((c) => c.startsWith("brew reinstall"));

describe("linkage then reinstall (OUP-326)", () => {
  test("a formula the check names is reinstalled from source once and tested again; clean means repaired", async () => {
    const r = await run({ linkage: [BAD("good-a"), ""] });
    expect(reinstalls(r.calls)).toEqual([REINSTALL("good-a")]);
    expect(r.calls.filter((c) => c.startsWith("brew linkage"))).toEqual(["brew linkage --test good-a", "brew linkage --test good-a"]);
    expect(r.rc).toBe(0);
    expect(r.lastRun).toMatchObject({ ok: true, failed: [], linkage: "linkage repaired by reinstall: good-a" });
  });
  test("still broken after the reinstall: not repaired", async () => {
    const r = await run({ linkage: [BAD("good-a"), BAD("good-a")] });
    expect(r.lastRun.linkage).toContain("LINKAGE FAILED: good-a");
    expect(r.lastRun.linkage).not.toContain("repaired");
  });
  test("a clean linkage test reinstalls nothing", async () => {
    const r = await run({ linkage: [""] });
    expect(reinstalls(r.calls)).toEqual([]);
    expect(r.lastRun.linkage).toBe("");
  });
  test("a failed reinstall is a FAILED reinstall:<name> entry and the rest still run", async () => {
    const r = await run({ names: ["a", "b"], linkage: [BAD("a", "b"), ""], reinstallRc: { a: 1 } });
    expect(reinstalls(r.calls)).toEqual([REINSTALL("a"), REINSTALL("b")]);
    expect(r.rc).toBe(1);
    expect(r.lastRun.failed).toEqual(["reinstall:a"]);
    expect(r.lastRun.linkage).toContain("reinstall FAILED: a");
    expect(r.calls.filter((c) => c.startsWith("brew linkage"))).toEqual(["brew linkage --test a b", "brew linkage --test b"]);
  });
  test("a reinstall that times out is the same: a FAILED entry, the next one runs", async () => {
    const r = await run({ names: ["a", "b"], linkage: [BAD("a", "b"), ""], timeout: [REINSTALL("a")] });
    expect(reinstalls(r.calls)).toEqual([REINSTALL("a"), REINSTALL("b")]);
    expect(r.lastRun.failed).toEqual(["reinstall:a"]);
    expect(r.lastRun.ok).toBe(false);
  });
  test("every reinstall failing: no second linkage test, the note says so", async () => {
    const r = await run({ linkage: [BAD("good-a")], reinstallRc: { "good-a": 1 } });
    expect(r.calls.filter((c) => c.startsWith("brew linkage"))).toEqual(["brew linkage --test good-a"]);
    expect(r.lastRun.linkage).toContain("reinstall FAILED: good-a");
  });
  test("a formula brew pins is never reinstalled: named as held", async () => {
    const r = await run({ names: ["a", "b"], linkage: [BAD("a", "b"), ""], script: { pinned: "a" } });
    expect(reinstalls(r.calls)).toEqual([REINSTALL("b")]);
    expect(r.lastRun.linkage).toContain("not reinstalled (held): a");
    expect(r.text).toContain("linkage: a not reinstalled (pinned: brew pin)");
  });
  test("a formula a repo's pins.json lists is never reinstalled, though it is not outdated", async () => {
    const r = await run({ linkage: [BAD("good-a")], script: { pinFiles: [{ repo: "example-repo", path: "/repos.test/example-repo/pins.json", text: '{"brew":{"good-a":"1.0"}}' }] } });
    expect(reinstalls(r.calls)).toEqual([]);
    expect(r.lastRun.linkage).toContain("not reinstalled (held): good-a");
  });
  test("pins that cannot be read: nothing is reinstalled", async () => {
    const r = await run({ linkage: [BAD("good-a")], script: { rc: { "brew list --pinned --formula": 1 } } });
    expect(reinstalls(r.calls)).toEqual([]);
    expect(r.text).toContain("linkage: brew list --pinned failed (rc 1) — pins not read, nothing is reinstalled");
  });
  test("held by design, or with a release check, is not reinstalled", async () => {
    const r = await run({ names: ["a", "b", "c"], linkage: [BAD("a", "b", "c"), ""], cfg: { heldByDesign: ["a"], releaseChecks: [{ formula: "b", command: ["/opt/gate.test/run"], before: [], after: [], timeoutMs: 1000 }] as never } });
    expect(reinstalls(r.calls)).toEqual([REINSTALL("c")]);
    expect(r.lastRun.linkage).toContain("not reinstalled (held): a b");
  });
  test("the bun this run executes under is not reinstalled", async () => {
    const r = await run({ names: ["bun", "good-a"], linkage: [BAD("bun", "good-a"), ""], bunExec: "/brew/Cellar/bun/1.2.0/bin/bun" });
    expect(reinstalls(r.calls)).toEqual([REINSTALL("good-a")]);
    expect(r.text).toContain("linkage: bun not reinstalled (runs under it)");
  });
  test("an outdated formula is never reinstalled (it would install the new version unreviewed); the note names it", async () => {
    const r = await run({ names: ["openssl@3", "good-a"], linkage: [BAD("openssl@3", "good-a"), ""], script: { formulas: "openssl@3", verbose: "openssl@3 (3.6.3) < 4.0.0", formulaTaps: { "openssl@3": "homebrew/core" } } });
    expect(reinstalls(r.calls)).toEqual([REINSTALL("good-a")]);
    expect(r.lastRun.linkage).toContain("outdated, held: openssl@3");
  });
  test("a formula that depends on an outdated one is held, naming it; one whose dependencies cannot be read too", async () => {
    const outdated = { formulas: "openssl@3", verbose: "openssl@3 (3.6.3) < 4.0.0", formulaTaps: { "openssl@3": "homebrew/core" } };
    const r = await run({ names: ["a", "b"], linkage: [BAD("a", "b"), ""], installed: ["openssl@3", "zlib"], script: { ...outdated, deps: { a: "openssl@3\n", b: "zlib\n" } } });
    expect(reinstalls(r.calls)).toEqual([REINSTALL("b")]);
    expect(r.lastRun.linkage).toContain("not reinstalled (held): a");
    expect(r.text).toContain("linkage: a not reinstalled (it depends on openssl@3, which is outdated)");
    const u = await run({ names: ["a"], linkage: [BAD("a")], script: { ...outdated, rc: { "brew deps --formula --include-implicit a": 1 } } });
    expect(reinstalls(u.calls)).toEqual([]);
    expect(u.text).toContain("linkage: a not reinstalled (its dependencies could not be read)");
  });
  test("a pins.json that warns (truncated) reinstalls nothing and logs the warning", async () => {
    const r = await run({ linkage: [BAD("good-a")], script: { pinFiles: [{ repo: "example-repo", path: "/repos.test/example-repo/pins.json", text: '{"brew":{"good-a"' }] } });
    expect(reinstalls(r.calls)).toEqual([]);
    expect(r.text).toContain("linkage: WARNING: /repos.test/example-repo/pins.json: pins.json unreadable, holds nothing — nothing is reinstalled");
  });
  test("a tap-qualified pin key holds the versioned formula, and the pin query is formulae only", async () => {
    const r = await run({ names: ["foo@2", "bar"], linkage: [BAD("foo@2", "bar"), ""], script: { pinned: "acme/tools/foo@2" } });
    expect(reinstalls(r.calls)).toEqual([REINSTALL("bar")]);
    expect(r.calls).toContain("brew list --pinned --formula");
    const f = await run({ linkage: [BAD("good-a")], script: { pinFiles: [{ repo: "example-repo", path: "/repos.test/example-repo/pins.json", text: '{"brew":{"acme/tools/good-a":"1.0"}}' }] } });
    expect(reinstalls(f.calls)).toEqual([]);
  });
  test("the reinstall is bounded by the upgrade time box and is a soft timeout", async () => {
    const r = await run({ linkage: [BAD("good-a"), ""], cfg: { upgradeTimeoutMs: 12345 } });
    const call = r.callOpts.find((c) => c.line === REINSTALL("good-a"))!;
    expect(call.opts?.timeoutMs).toBe(12345);
    expect(call.opts?.soft).toBe(true);
  });
  test("a timeout in the pin query keeps the note: nothing reinstalled, the failure is named", async () => {
    const r = await run({ linkage: [BAD("good-a")], timeout: ["brew list --pinned"] });
    expect(reinstalls(r.calls)).toEqual([]);
    expect(r.lastRun.linkage).toContain("LINKAGE FAILED: good-a");
    expect(r.lastRun.linkage).toContain("linkage repair timed out");
    expect(r.lastRun.failed).toEqual(["timeout:brew"]);
  });
  test("a timeout in the second linkage test keeps what was done: reinstalled, not repaired, noted", async () => {
    const r = await run({ linkage: [BAD("good-a"), ""], linkageTimesOutOn: 2 });
    expect(reinstalls(r.calls)).toEqual([REINSTALL("good-a")]);
    expect(r.lastRun.linkage).toContain("LINKAGE FAILED: good-a");
    expect(r.lastRun.linkage).toContain("linkage repair timed out");
  });
  test("the second test names only what is still broken: the others count as repaired", async () => {
    const r = await run({ names: ["a", "b"], linkage: [BAD("a", "b"), BAD("b")] });
    expect(r.lastRun.linkage).toContain("LINKAGE FAILED: b; repaired by reinstall: a");
  });
  test("a second test that fails and names nothing is 'names unknown': none counts as repaired", async () => {
    const r = await run({ names: ["a", "b"], linkage: [BAD("a", "b"), "boom\n"] });
    expect(r.lastRun.linkage).toContain("LINKAGE FAILED: a b");
    expect(r.lastRun.linkage).toContain("linkage test failed, names unknown");
    expect(r.lastRun.linkage).not.toContain("repaired by reinstall");
  });
  test("with the time box open the rest are not tried, and are not FAILED entries", async () => {
    const r = await run({ names: ["a", "b", "c"], linkage: [BAD("a", "b", "c"), ""], timeout: [REINSTALL("a"), REINSTALL("b")] });
    expect(reinstalls(r.calls)).toEqual([REINSTALL("a"), REINSTALL("b")]);
    expect(r.lastRun.linkage).toContain("not tried (time box): c");
    expect(r.lastRun.failed).toEqual(["reinstall:a", "reinstall:b"]);
  });
  test("a dependency that is not installed holds the formula (the rebuild would install it unreviewed), even with nothing outdated", async () => {
    const r = await run({ names: ["a", "b"], linkage: [BAD("a", "b"), ""], script: { deps: { a: "acme/tools/libfoo\n", b: "zlib\n" } }, installed: ["zlib"] });
    expect(reinstalls(r.calls)).toEqual([REINSTALL("b")]);
    expect(r.lastRun.linkage).toContain("missing dependency, held: a needs libfoo");
  });
  test("a missing build dependency of the stable formula still holds", async () => {
    const r = await run({ names: ["a"], linkage: [BAD("a")], script: { buildDeps: { a: ["pkgconf"] } } });
    expect(reinstalls(r.calls)).toEqual([]);
    expect(r.lastRun.linkage).toContain("missing dependency, held: a needs pkgconf");
  });
  test("what a stable build never installs does not hold: the HEAD-only and optional dependencies are not asked for (the jq case)", async () => {
    // `brew deps --formula --include-build jq` prints autoconf automake libtool m4 oniguruma; the stable formula needs oniguruma only.
    const r = await run({ names: ["jq"], linkage: [BAD("jq"), ""], installed: ["oniguruma"], script: { deps: { jq: "oniguruma\n" }, buildDeps: { jq: [] } } });
    expect(reinstalls(r.calls)).toEqual([REINSTALL("jq")]);
    expect(r.calls.some((c) => c.includes("--include-build") || c.includes("--include-optional"))).toBe(false);
    expect(r.lastRun.linkage).toBe("linkage repaired by reinstall: jq");
  });
  test("an implicit dependency (unpacking the source, zstd) that is not installed holds the formula", async () => {
    const r = await run({ names: ["a"], linkage: [BAD("a")], script: { implicitDeps: { a: "zstd\n" } } });
    expect(reinstalls(r.calls)).toEqual([]);
    expect(r.lastRun.linkage).toContain("missing dependency, held: a needs zstd");
  });
  test("a build dependency that is current but whose own runtime dependency is outdated holds the formula (cairo, meson, python)", async () => {
    const outdated = { formulas: "openssl@3", verbose: "openssl@3 (3.6.3) < 4.0.0", formulaTaps: { "openssl@3": "homebrew/core" } };
    const r = await run({ names: ["x"], linkage: [BAD("x")], installed: ["meson", "openssl@3"], script: { ...outdated, buildDeps: { x: ["meson"] }, deps: { meson: "openssl@3\n" } } });
    expect(reinstalls(r.calls)).toEqual([]);
    expect(r.text).toContain("linkage: x not reinstalled (it depends on openssl@3, which is outdated)");
  });
  test("a build dependency's own runtime dependency that is not installed holds it", async () => {
    const r = await run({ names: ["x"], linkage: [BAD("x")], installed: ["meson"], script: { buildDeps: { x: ["meson"] }, deps: { meson: "libz\n" } } });
    expect(reinstalls(r.calls)).toEqual([]);
    expect(r.lastRun.linkage).toContain("missing dependency, held: x needs libz");
    expect(r.calls).toContain("brew deps --formula --include-implicit meson");
  });
  test("a build dependency declared by an alias resolves to the installed formula it names: not held", async () => {
    const r = await run({ names: ["x"], linkage: [BAD("x"), ""], installed: ["pkgconf"], script: { buildDeps: { x: ["pkg-config"] }, aliases: { "pkg-config": "pkgconf" } } });
    expect(reinstalls(r.calls)).toEqual([REINSTALL("x")]);
    expect(r.calls).toContain("brew info --json=v2 --formula pkg-config");
  });
  test("an alias's runtime dependencies are asked of the canonical formula, not of the alias", async () => {
    const r = await run({ names: ["x"], linkage: [BAD("x")], installed: ["pkgconf"], script: { buildDeps: { x: ["pkg-config"] }, aliases: { "pkg-config": "pkgconf" }, deps: { pkgconf: "libz\n" } } });
    expect(reinstalls(r.calls)).toEqual([]);
    expect(r.lastRun.linkage).toContain("missing dependency, held: x needs libz");
  });
  test("an info answer without the installed list is a bad shape: held", async () => {
    const r = await run({ names: ["a"], linkage: [BAD("a")], script: { answers: { "brew info --json=v2 --formula a": { rc: 0, out: JSON.stringify({ formulae: [{ name: "a", build_dependencies: [] }] }) } } } });
    expect(reinstalls(r.calls)).toEqual([]);
    expect(r.text).toContain("linkage: a not reinstalled (its dependencies could not be read)");
  });
  test("more build dependencies than the cap (20) is not checked one by one: held", async () => {
    const many = Array.from({ length: 21 }, (_, i) => `dep${i}`);
    const r = await run({ names: ["a"], linkage: [BAD("a")], installed: many, script: { buildDeps: { a: many } } });
    expect(reinstalls(r.calls)).toEqual([]);
    expect(r.text).toContain("linkage: a not reinstalled (its dependencies could not be read)");
  });
  test("an optional dependency counts only when the installed keg was built with an option (jq stays unheld)", async () => {
    const script = { deps: { x: "oniguruma\n" }, optionalDeps: { x: "libfoo\n" } };
    const without = await run({ names: ["x"], linkage: [BAD("x"), ""], installed: ["oniguruma"], script });
    expect(reinstalls(without.calls)).toEqual([REINSTALL("x")]);
    expect(without.calls.some((c) => c.includes("--include-optional"))).toBe(false);
    const withOpt = await run({ names: ["x"], linkage: [BAD("x")], installed: ["oniguruma"], script: { ...script, usedOptions: { x: ["--with-libfoo"] } } });
    expect(reinstalls(withOpt.calls)).toEqual([]);
    expect(withOpt.lastRun.linkage).toContain("missing dependency, held: x needs libfoo");
  });
  test("an option on any installed keg, not only the first listed, reads the optional dependencies", async () => {
    const script = { deps: { x: "oniguruma\n" }, optionalDeps: { x: "bar\n" }, installedKegs: { x: [{ used_options: [] }, { used_options: ["--with-bar"] }] } };
    const r = await run({ names: ["x"], linkage: [BAD("x")], installed: ["oniguruma"], script });
    expect(reinstalls(r.calls)).toEqual([]);
    expect(r.lastRun.linkage).toContain("missing dependency, held: x needs bar");
  });
  test.each([
    ["a null keg entry", [null]],
    ["used_options null", [{ used_options: null }]],
    ["used_options missing", [{}]],
    ["used_options not strings", [{ used_options: [1] }]],
  ])("malformed option metadata (%s) holds the formula: dependencies not read", async (_n, kegs) => {
    const r = await run({ names: ["x"], linkage: [BAD("x")], script: { installedKegs: { x: kegs as unknown[] } } });
    expect(reinstalls(r.calls)).toEqual([]);
    expect(r.text).toContain("linkage: x not reinstalled (its dependencies could not be read)");
  });
  test("the same bare name in two taps is two formulae: the build dependency is asked by its full name and compared exactly", async () => {
    const script = { buildDeps: { x: ["foo"] }, fullNames: { foo: "tapb/tools/foo" }, deps: { "tapb/tools/foo": "" } };
    const r = await run({ names: ["x"], linkage: [BAD("x")], installed: ["tapa/tools/foo"], script });
    expect(r.calls).toContain("brew deps --formula --include-implicit tapb/tools/foo");
    expect(reinstalls(r.calls)).toEqual([]);
    expect(r.lastRun.linkage).toContain("missing dependency, held: x needs foo");
    const ok = await run({ names: ["x"], linkage: [BAD("x"), ""], installed: ["tapb/tools/foo"], script });
    expect(reinstalls(ok.calls)).toEqual([REINSTALL("x")]);
  });
  test("a build dependency whose own query fails holds the formula (fail closed)", async () => {
    const r = await run({ names: ["x"], linkage: [BAD("x")], installed: ["meson"], script: { buildDeps: { x: ["meson"] }, rc: { "brew deps --formula --include-implicit meson": 1 } } });
    expect(reinstalls(r.calls)).toEqual([]);
    expect(r.text).toContain("linkage: x not reinstalled (its dependencies could not be read)");
  });
  test("build dependencies that cannot be read (the info query fails) hold it, fail closed", async () => {
    const r = await run({ names: ["a"], linkage: [BAD("a")], script: { rc: { "brew info --json=v2 --formula a": 1 } } });
    expect(reinstalls(r.calls)).toEqual([]);
    expect(r.text).toContain("linkage: a not reinstalled (its dependencies could not be read)");
  });
  test("a release-checked dependency that is not installed holds it too", async () => {
    const r = await run({ names: ["a"], linkage: [BAD("a")], script: { deps: { a: "gate\n" } }, cfg: { releaseChecks: [{ formula: "gate", command: ["/opt/gate.test/run"], retries: 1, timeoutSec: 900, before: [], after: [] }] } });
    expect(reinstalls(r.calls)).toEqual([]);
    expect(r.lastRun.linkage).toContain("missing dependency, held: a needs gate");
  });
  test("the dependency query is formulae only", async () => {
    const r = await run({ names: ["a"], linkage: [BAD("a"), ""] });
    expect(r.calls).toContain("brew deps --formula --include-implicit a");
    expect(r.calls).toContain("brew info --json=v2 --formula a");
  });
  test("a pins.json whose brew section is not an object reinstalls nothing", async () => {
    const r = await run({ linkage: [BAD("good-a")], script: { pinFiles: [{ repo: "example-repo", path: "/repos.test/example-repo/pins.json", text: '{"brew":["good-a"]}' }] } });
    expect(reinstalls(r.calls)).toEqual([]);
    expect(r.text).toContain('"brew" is not an object, holds nothing — nothing is reinstalled');
  });
  test("the time box counts reinstalls in a row: one that runs to its end resets it", async () => {
    const r = await run({ names: ["a", "b", "c", "d"], linkage: [BAD("a", "b", "c", "d"), ""], timeout: [REINSTALL("a"), REINSTALL("c")] });
    expect(reinstalls(r.calls)).toEqual([REINSTALL("a"), REINSTALL("b"), REINSTALL("c"), REINSTALL("d")]);
    expect(r.lastRun.linkage).not.toContain("not tried");
  });
  test("the upgrade phase's last timeout does not count: one reinstall timeout then the rest still run", async () => {
    const r = await run({ names: ["a", "b"], linkage: [BAD("a", "b"), ""], script: { formulas: "z", verbose: "z (1.0) < 1.1", formulaTaps: { z: "homebrew/core" } }, timeout: ["brew upgrade z", REINSTALL("a")] });
    expect(reinstalls(r.calls)).toEqual([REINSTALL("a"), REINSTALL("b")]);
  });
  test("a stopping run starts no reinstall: not tried (stopped), not FAILED, nothing repaired", async () => {
    const r = await run({ linkage: [BAD("good-a")], stopping: () => true });
    expect(reinstalls(r.calls)).toEqual([]);
    expect(r.lastRun.linkage).toContain("not tried (stopped): good-a");
    expect(r.lastRun.linkage).toContain("linkage repair interrupted");
    expect(r.lastRun.failed).toEqual([]);
  });
  test("a reinstall that never started (stop) is not a FAILED entry", async () => {
    const r = await run({ linkage: [BAD("good-a")], script: { answers: { [REINSTALL("good-a")]: { rc: 143, out: "", err: "oupdate is stopping: not started" } } } });
    expect(r.lastRun.failed).toEqual([]);
    expect(r.lastRun.linkage).toContain("not tried (stopped): good-a");
  });
  test("a second test killed by a signal is 'interrupted': none is claimed repaired", async () => {
    const r = await run({ linkage: [BAD("good-a")], secondRc: 143 });
    expect(r.lastRun.linkage).toContain("linkage repair interrupted");
    expect(r.lastRun.linkage).not.toContain("repaired by reinstall");
  });
  test("an installed list that cannot be read (the repair's own read) reinstalls nothing", async () => {
    const r = await run({ linkage: [BAD("good-a")], secondListRc: 1 });
    expect(reinstalls(r.calls)).toEqual([]);
    expect(r.text).toContain("linkage: brew list --formula failed (rc 1) — nothing is reinstalled");
  });
  test("a name that could be an option is not reinstalled", async () => {
    const r = await run({ names: ["-x"], linkage: [BAD("-x")] });
    expect(reinstalls(r.calls)).toEqual([]);
    expect(r.text).toContain("linkage: -x not reinstalled (not a formula name)");
  });
  test("a dry run reinstalls nothing and says what it would do", async () => {
    const r = await run({ names: ["a", "b"], linkage: [BAD("a", "b")], dryRun: true, script: { pinned: "b" } });
    expect(reinstalls(r.calls)).toEqual([]);
    expect(r.log).toContain("dry-run: would reinstall --build-from-source: a");
    expect(r.lastRun).toBeUndefined();
  });
});
