// The apply run end to end against a scripted host (test/apply/host-fixture.ts). Ported from
// secure-update's brew-phase cases (test/port/03, 04, 06, 07 and 12b): which formulae reach the
// upgrade, how taps are classified, the summary's notes, the cask phase's Gatekeeper order, the
// stuck state, the restart list and the phase order. New here: timeouts, the dry run's no-write
// promise and the summary read back by the host shadow parser.
import { describe, expect, test } from "bun:test";
import type { AppNet } from "../../src/apply/appbundle.ts";
import { applyHost, type GkOps } from "../../src/apply/run.ts";
import { parseSuSummary } from "../../src/host/su-log.ts";
import { fakeHost, fakeTypeB, testConfig, type HostScript } from "./host-fixture.ts";
import { scripted } from "./helpers.ts";

const T = "\t";
// As secure-update's brewMocks: a core formula, a third-party tap formula, a third-party tap cask.
const BREW: HostScript = {
  formulas: "good-a wm",
  verbose: ["good-a (1.0) < 1.1", "example/wm/wm (0.1.0) < 0.2.0 [pinned at 0.1.0]", "example/tf/tfapp (1.5) < 1.6"].join("\n"),
  formulaTaps: { "good-a": "homebrew/core", wm: "example/wm" },
  casks: "tfapp",
  caskTaps: { tfapp: "example/tf" },
};
const APPROVED = "/conf.test/approved-taps.tsv";
const brewLine = (summary: string[]) => summary.find((l) => l.startsWith("  brew: ")) ?? "";
const npmLine = (summary: string[]) => summary.find((l) => l.startsWith("  npm:  ")) ?? "";

async function run(script: HostScript, o: { cfg?: Parameters<typeof testConfig>[0]; dryRun?: boolean; tb?: ReturnType<typeof fakeTypeB>; gk?: GkOps; appNet?: AppNet } = {}) {
  const h = fakeHost(script);
  const tb = o.tb ?? fakeTypeB(0);
  const res = await applyHost(testConfig(o.cfg), h.exec, h.fs, { dryRun: o.dryRun ?? false, reviewer: scripted([], "APPROVE\nno attack indicators found").r, typeB: tb.typeB, gk: o.gk, appNet: o.appNet, now: new Date(2026, 9, 22, 7, 0) });
  const text = [...res.log, ...res.summary].join("\n");
  return { ...res, ...h, tb, text, brew: brewLine(res.summary), npm: npmLine(res.summary) };
}

describe("post-upgrade check (issue 2)", () => {
  const CHECK = { "good-a": ["good-a", "--version"], wm: ["wm", "--version"] };
  test("off by default: no check command runs", async () => {
    const r = await run(BREW);
    expect(r.calls.some((c) => c.endsWith("--version") && c !== "brew --version")).toBe(false);
  });
  test("an upgraded package with a passing check is logged ok; no failure", async () => {
    const r = await run(BREW, { cfg: { postUpgradeCheck: CHECK } });
    expect(r.calls).toContain("good-a --version");
    expect(r.log).toContain("post-upgrade check: good-a ok");
    expect(r.rc).toBe(0);
  });
  test("a package not upgraded this run is not checked", async () => {
    const r = await run(BREW, { cfg: { postUpgradeCheck: CHECK } });
    expect(r.calls).not.toContain("wm --version");
  });
  test("a failing check is logged, notified, counted as FAILED in the brew line and rc 1; the run goes on", async () => {
    const r = await run({ ...BREW, rc: { "good-a --version": 3 } }, { cfg: { postUpgradeCheck: CHECK, notify: ["notify-cmd"] } });
    expect(r.log).toContain("post-upgrade check: good-a FAILED (rc=3): good-a --version");
    expect(r.calls.some((c) => c.startsWith("notify-cmd") && c.includes("post-upgrade check FAILED: good-a"))).toBe(true);
    expect(r.brew).toContain("FAILED: check:good-a");
    expect(r.rc).toBe(1);
    expect(r.calls).toContain("brew cleanup");
    expect(r.log.some((l) => l.startsWith("[notify] 📋"))).toBe(true);
  });
  test("a timed-out check is a failure, not an abort", async () => {
    const r = await run({ ...BREW, timeout: ["good-a --version"] }, { cfg: { postUpgradeCheck: CHECK } });
    expect(r.brew).toContain("check:good-a");
    expect(r.rc).toBe(1);
    expect(r.summary.some((l) => l.startsWith("  npm:"))).toBe(true);
  });
  test("a dry run runs no check", async () => {
    const r = await run(BREW, { dryRun: true, cfg: { postUpgradeCheck: CHECK } });
    expect(r.calls).not.toContain("good-a --version");
  });
  test("an npm package upgraded is checked too", async () => {
    const r = await run({ npmOutdated: JSON.stringify({ pkgx: { current: "1.0.0", wanted: "1.1.0", latest: "1.1.0" } }) }, { cfg: { postUpgradeCheck: { pkgx: ["pkgx", "--version"] } } });
    expect(r.calls).toContain("pkgx --version");
  });
});

describe("tap approval in the brew phase (port 03)", () => {
  for (const [rc, verdict] of [[0, "APPROVE (formula-only, prebuilt)"], [1, "FLAG (formula-only, prebuilt)"], [2, "n/a"]] as const) {
    test(`unapproved tap → advisory review (${verdict}), awaiting-approval note in the brew summary, Type A still upgraded`, async () => {
      const r = await run(BREW, { tb: fakeTypeB(rc), cfg: { approvedTapsFile: APPROVED } });
      expect(r.tb.seen).toContain("TBREVIEW wm example/wm suppress=1");
      expect(r.brew).toMatch(/^ {2}brew: FLAGGED — awaiting tap approval: example\/wm \(wm 0\.1\.0→0\.2\.0, review: /);
      expect(r.brew).toContain(`example/wm (wm 0.1.0→0.2.0, review: ${verdict})`);
      expect(r.brew).toContain("example/tf (tfapp 1.5→1.6, review: n/a (cask))");
      expect(r.brew).toContain(`approve a tap by adding it to ${APPROVED}`);
      expect(r.calls).toContain("brew upgrade good-a");
      expect(r.calls.some((c) => /^brew upgrade (\S+\/)?wm$/.test(c))).toBe(false);
      expect(r.calls).not.toContain("brew upgrade --cask --greedy tfapp");
      expect(r.log.filter((l) => /^\[notify\] .*awaiting tap approval/.test(l))).toHaveLength(1);
      expect(r.text).not.toContain("[notify] hosta Type B FLAG");
      expect(r.brew).toContain("upgraded: good-a");
    });
  }

  test("approved tap → the Type B path, upgraded on APPROVE, no awaiting-approval note for it", async () => {
    const r = await run({ ...BREW, files: { [APPROVED]: `example/wm${T}*${T}2026-09-28${T}fixture\n` } }, { cfg: { approvedTapsFile: APPROVED } });
    expect(r.tb.seen).toContain("TBREVIEW wm example/wm suppress=0");
    expect(r.calls).toContain("brew upgrade example/wm/wm");
    expect(r.brew).not.toContain("example/wm (wm");
    expect(r.brew).toContain("awaiting tap approval: example/tf (tfapp");
    expect(r.brew).toContain("upgraded: good-a wm");
  });

  test("approved for another host only → still awaiting approval", async () => {
    const r = await run({ ...BREW, files: { [APPROVED]: `example/wm${T}hostn${T}2026-09-28${T}fixture\n` } }, { cfg: { approvedTapsFile: APPROVED } });
    expect(r.tb.seen).toContain("TBREVIEW wm example/wm suppress=1");
    expect(r.brew).toContain("example/wm (wm 0.1.0→0.2.0");
  });

  test("D: package tap 'example/work.ux' is not treated as approved example/workmux", async () => {
    const s = { ...BREW, formulaTaps: { "good-a": "homebrew/core", wm: "example/work.ux" } };
    const r = await run(s, { cfg: { typeBTaps: ["example/svc", "example/workmux"] } });
    expect(r.tb.seen).toContain("TBREVIEW wm example/work.ux suppress=1");
    expect(r.tb.seen).not.toContain("TBREVIEW wm example/work.ux suppress=0");
    expect(r.calls.some((c) => /^brew upgrade (\S+\/)?wm$/.test(c))).toBe(false);
  });

  test("dry run: Type B FLAGs and holds are logged, never notified, and nothing is changed", async () => {
    const files = { [APPROVED]: `example/wm${T}*${T}2026-09-28${T}fixture\n` };
    const r = await run({ ...BREW, files, formulas: "good-a wm openssl@3", verbose: `${BREW.verbose}\nopenssl@3 (3.6.3) < 4.0.0`, formulaTaps: { ...BREW.formulaTaps, "openssl@3": "homebrew/core" } }, {
      dryRun: true, tb: fakeTypeB(1), cfg: { approvedTapsFile: APPROVED, notify: ["notify-cmd"] },
    });
    expect(r.log).toContain("[dry-run — not notified] ⚠️ hosta Type B FLAG — wm");
    expect(r.log.some((l) => l.startsWith("[dry-run — not notified] ⚠️ hosta Type A — holding 1 pkg(s)"))).toBe(true);
    expect(r.log.some((l) => l.startsWith("[dry-run — not notified] ⚠️ hosta brew FLAGGED — awaiting tap approval"))).toBe(true);
    expect(r.text).not.toContain("[notify]");
    expect(r.calls.some((c) => c.startsWith("notify-cmd"))).toBe(false);
    // Nothing that changes the host: no tap sync, HEAD fetch, upgrade, cleanup, restart or write.
    expect(r.calls.filter((c) => /^brew (update|upgrade|cleanup|link|unlink)\b|--fetch-HEAD|launchctl|^sudo|^npm update|^spawn/.test(c))).toEqual([]);
    expect(r.writes).toEqual([]);
    expect(r.log).toContain("dry-run: would upgrade Type A formulas=[good-a] casks=[]");
    expect(r.brew).toMatch(/^ {2}brew: FLAGGED — awaiting tap approval: example\/tf/);
  });
});

describe("stuck tracking in the run (port 04)", () => {
  const STATE = "/state.test/pending-state.tsv";

  test("pending query failure preserves the state file and marks the phase failed", async () => {
    const before = `brew${T}app=1.0${T}2${T}yesterday\n`;
    const r = await run({ files: { [STATE]: before }, rc: { "brew outdated --json=v2 --greedy-auto-updates --fetch-HEAD": 9 } });
    expect(r.files.get(STATE)).toBe(before);
    expect(r.writes).not.toContain(STATE);
    expect(r.brew).toContain("FAILED: pending-query");
    expect(r.rc).toBe(1);
  });

  test("a malformed pending answer is a failed query too, the state kept", async () => {
    const before = `brew${T}app=1.0${T}2${T}yesterday\n`;
    // rc 0 with no answer: not JSON, so a failed query, not "nothing pending".
    const r = await run({ files: { [STATE]: before }, rc: { "brew outdated --json=v2 --greedy-auto-updates --fetch-HEAD": 0 } });
    expect(r.files.get(STATE)).toBe(before);
    expect(r.brew).toContain("FAILED: pending-query");
  });

  test("successfully upgraded casks are not stuck", async () => {
    const r = await run({ casks: "app", caskTaps: { app: "homebrew/cask" }, verbose: "app (1.0) < 1.1" });
    expect(r.calls).toContain("brew upgrade --cask --greedy app");
    expect(r.brew).toContain("casks upgraded: app");
    expect(r.text).not.toContain("STUCK");
  });

  test("a cask that fails to upgrade is FAILED and counted toward stuck", async () => {
    const r = await run({ casks: "app", caskTaps: { app: "homebrew/cask" }, verbose: "app (1.0) < 1.1", upgradeRc: { "--cask --greedy app": 1 } });
    expect(r.brew).toMatch(/^ {2}brew: FAILED: app; .*casks FAILED: app; STUCK: app=9\.9\(1 runs, since 2026-10-22\)/);
    expect(r.files.get(STATE)).toBe(`brew${T}app=9.9${T}1${T}2026-10-22\n`);
    expect(r.rc).toBe(1);
  });

  test("an unreadable state file is kept and reported, never read as empty", async () => {
    const h = fakeHost({ casks: "app", caskTaps: { app: "homebrew/cask" }, verbose: "app (1.0) < 1.1", dirs: [STATE] });
    const res = await applyHost(testConfig(), h.exec, h.fs, { dryRun: false, reviewer: scripted([], "APPROVE").r, typeB: fakeTypeB().typeB });
    expect(brewLine(res.summary)).toMatch(/^ {2}brew: FAILED: stuck-state-unreadable; /);
    expect(h.writes).not.toContain(STATE);
    expect(res.rc).toBe(1);
  });

  test("pinned and excluded packages are held, reported, and never count as stuck", async () => {
    const r = await run({
      formulas: "duckdb good-a", casks: "big", verbose: "duckdb (1.5.5) < 2.0.0\ngood-a (1.0) < 1.1\nbig (1) < 2",
      formulaTaps: { duckdb: "homebrew/core", "good-a": "homebrew/core" }, caskTaps: { big: "homebrew/cask" },
      pinFiles: [{ repo: "example-repo", path: "/repos.test/example-repo/pins.json", text: '{"brew":{"duckdb":"1.5.5"}}' }],
    }, { cfg: { caskExclude: ["big"] } });
    expect(r.calls).not.toContain("brew upgrade duckdb");
    expect(r.log).toContain("  holding duckdb (pinned: example-repo)");
    expect(r.log.some((l) => l.startsWith("  excluding big (CASK_EXCLUDE"))).toBe(true);
    expect(r.brew).toContain("PINNED: duckdb(example-repo)");
    expect(r.brew).not.toContain("STUCK");
    expect(r.log.find((l) => l.includes("duckdb (1.5.5)"))).toBeUndefined();
  });
});

test("a tap-qualified excluded cask is matched on its last segment and kept out of the review table", async () => {
  const r = await run({ casks: "example/tf/big app", caskTaps: { app: "homebrew/cask" }, verbose: "example/tf/big (1) < 2\napp (1.0) < 1.1" }, { cfg: { caskExclude: ["big"] } });
  expect(r.log.some((l) => l.startsWith("  excluding example/tf/big (CASK_EXCLUDE"))).toBe(true);
  expect(r.log.some((l) => l.startsWith("example/tf/big ("))).toBe(false);
  expect(r.calls).toContain("brew upgrade --cask --greedy app");
});

describe("the cask phase and Gatekeeper (port 06)", () => {
  test("snapshot before the upgrade, release then check after it", async () => {
    const h = fakeHost({ casks: "app other", caskTaps: { app: "homebrew/cask", other: "homebrew/cask" }, verbose: "app (1.0) < 1.1\nother (2) < 3", sudoCasks: ["other"] });
    const prior = { prior: "ok" as const, team: "TEAMAAAAAA" };
    const gk: GkOps = {
      snapshot: async (c) => (h.calls.push(`gk snapshot ${c}`), prior),
      release: async (c, p) => (h.calls.push(`gk release ${c} ${p.prior} ${p.team}`), [`  ${c}: Gatekeeper — released 1 file(s), notarized ${p.team}`]),
      check: async (c) => (h.calls.push(`gk check ${c}`), { note: `${c}: 1 unapproved`, log: [] }),
    };
    const res = await applyHost(testConfig(), h.exec, h.fs, { dryRun: false, reviewer: scripted([], "APPROVE").r, typeB: fakeTypeB().typeB, gk });
    const seq = h.calls.filter((c) => c.startsWith("gk ") || c.startsWith("brew upgrade --cask"));
    expect(seq).toEqual(["gk snapshot app", "brew upgrade --cask --greedy app", "gk release app ok TEAMAAAAAA", "gk check app"]);
    expect(brewLine(res.summary)).toContain("casks upgraded: app; casks need sudo: other; GATEKEEPER pending: app: 1 unapproved");
    expect(res.log).toContain("  app: Gatekeeper — released 1 file(s), notarized TEAMAAAAAA");
  });

  test("a failed cask upgrade gets no release and no check", async () => {
    const h = fakeHost({ casks: "app", caskTaps: { app: "homebrew/cask" }, verbose: "app (1.0) < 1.1", upgradeRc: { "--cask --greedy app": 1 } });
    const gk: GkOps = {
      snapshot: async (c) => (h.calls.push(`gk snapshot ${c}`), { prior: "ok", team: "T" }),
      release: async (c) => (h.calls.push(`gk release ${c}`), []),
      check: async (c) => (h.calls.push(`gk check ${c}`), { note: "", log: [] }),
    };
    await applyHost(testConfig(), h.exec, h.fs, { dryRun: false, reviewer: scripted([], "APPROVE").r, typeB: fakeTypeB().typeB, gk });
    expect(h.calls.filter((c) => c.startsWith("gk "))).toEqual(["gk snapshot app"]);
  });
});

describe("a cask with a running process is deferred (oupdate#4)", () => {
  const RUN = "COMMAND PID USER FD TYPE DEVICE SIZE NODE NAME\ngcloud 55 u txt REG 1,4 1 2 /brew/Caskroom/app/1.0/bin/gcloud\n";
  const base = { casks: "app other", caskTaps: { app: "homebrew/cask", other: "homebrew/cask" }, verbose: "app (1.0) < 1.1\nother (2) < 3" };
  test("it is not upgraded this run, is logged with the reason, counts as pending, and the rest carry on", async () => {
    const r = await run({ ...base, lsof: [RUN, "COMMAND PID USER FD TYPE DEVICE SIZE NODE NAME\n"] });
    expect(r.calls).not.toContain("brew upgrade --cask --greedy app");
    expect(r.calls).toContain("brew upgrade --cask --greedy other");
    expect(r.text).toContain("app: deferred — a process is running from it (pid 55)");
    expect(r.brew).toContain("casks held (running): app");
    expect(r.brew).toContain("casks upgraded: other");
    expect(r.files.get("/state.test/pending-state.tsv")).toContain(`brew${T}app=9.9${T}1${T}2026-10-22`);
  });
});

describe("service restarts and the phase order (port 07)", () => {
  const SVC = {
    name: "svc", waiter: "/conf.test/svc-waiter.sh", holdFile: "/state.test/svc-hold", quarantineFile: "/state.test/svc-quarantine",
    outcomeFile: "/state.test/svc-outcome", restartLog: "/state.test/svc-restart.log",
  };
  const SVC_BREW: HostScript = {
    formulas: "good-a svc", verbose: "good-a (1.0) < 1.1\nsvc (0.1) < 0.2",
    formulaTaps: { "good-a": "homebrew/core", svc: "example/svc" },
    files: { "/Library/LaunchDaemons/sh.brew.svc.plist": "", "/Library/LaunchDaemons/sh.brew.good-a.plist": "" },
  };

  test("the brew phase never restarts a deferred service; it is deferred to the idle waiter", async () => {
    const r = await run(SVC_BREW, { cfg: { deferred: [SVC] } });
    expect(r.calls).toContain("brew upgrade example/svc/svc");
    expect(r.brew).toContain("restarted: good-a(sys) svc(deferred to idle waiter)");
    expect(r.calls).toContain("sudo -n launchctl kickstart -k system/sh.brew.good-a");
    expect(r.calls.filter((c) => c.includes("svc") && /launchctl|sudo/.test(c))).toEqual([]);
  });

  test("an upgraded service whose label is in labelRestart is left to its owner, never kickstarted (label re-review D)", async () => {
    // Mutant caught: labelRestart not passed to restartUpgraded (step 2 kickstarts an owner-gated label).
    const r = await run(SVC_BREW, { cfg: { deferred: [SVC], labelRestart: { "sh.brew.good-a": "skip" } } });
    expect(r.calls).toContain("brew upgrade good-a");
    expect(r.calls.some((c) => c.includes("sh.brew.good-a"))).toBe(false);
    expect(r.brew).toContain("good-a(restart left to its owner)");
  });

  test("an owner command runs once per run: step 2 hands the label, the stale-keg check does not hand it again (label re-review 2 (2))", async () => {
    // Mutant caught: ownerHanded not passed from step 2 to the stale-keg check (two spawns of one owner command).
    const lsof = "COMMAND PID USER FD TYPE DEVICE SIZE NODE NAME\ngood-a 77 u txt REG 1,4 1 2 /brew/Cellar/good-a/1.0/bin/good-a\n";
    const print = "system = {\n\tservices = {\n\t\t      77      - \tsh.brew.good-a\n\t}\n}\n";
    const h = fakeHost({ ...SVC_BREW, dirs: ["/brew/Cellar"], lsof: [lsof], ps: { "77": { comm: "good-a", ppid: "1" } } });
    const exec: typeof h.exec = async (argv, o) => (argv.join(" ") === "launchctl print system" ? { rc: 0, out: print, err: "" } : h.exec(argv, o));
    const res = await applyHost(testConfig({ npm: null, deferred: [SVC], labelRestart: { "sh.brew.good-a": ["/opt/owner.test/restart-when-quiet"] } }), exec, h.fs, { dryRun: false, reviewer: scripted([], "APPROVE").r, typeB: fakeTypeB().typeB });
    expect(h.spawned.filter((a) => a[0] === "/opt/owner.test/restart-when-quiet")).toEqual([["/opt/owner.test/restart-when-quiet", "sh.brew.good-a"]]);
    expect(res.log).toContain("    sh.brew.good-a was handed to restart-when-quiet by the restart step this run");
    expect(res.summary.join("\n")).toContain("STALE KEG: good-a handed to restart-when-quiet (sh.brew.good-a)");
  });

  test("staleKegUnlisted report reaches the stale-keg check; step 2 reports the unlisted upgraded service too", async () => {
    // Mutant caught: staleKegUnlisted not passed from the run to the stale-keg check (the unlisted label kickstarted).
    const lsof = ["COMMAND PID USER FD TYPE DEVICE SIZE NODE NAME", "bun 77 u txt REG 1,4 1 2 /brew/Cellar/bun/1.0_old/bin/bun"].join("\n");
    const print = "system = {\n\tservices = {\n\t\t      77      - \torg.example.agent-daemon\n\t}\n}\n";
    const h = fakeHost({ ...SVC_BREW, dirs: ["/brew/Cellar"], lsof: [lsof], ps: { "77": { comm: "bun", ppid: "1" } } });
    const exec: typeof h.exec = async (argv, o) => (argv.join(" ") === "launchctl print system" ? { rc: 0, out: print, err: "" } : h.exec(argv, o));
    const res = await applyHost(testConfig({ npm: null, deferred: [SVC], staleKegUnlisted: "report" }), exec, h.fs, { dryRun: false, reviewer: scripted([], "APPROVE").r, typeB: fakeTypeB().typeB });
    expect(h.calls.some((c) => c.includes("sh.brew.good-a") && c.includes("kickstart"))).toBe(false);
    expect(res.summary.join("\n")).toContain("good-a(reported only, not on the restart list)");
    expect(h.calls.some((c) => c.includes("org.example.agent-daemon") && c.includes("kickstart"))).toBe(false);
    expect(res.log).toContain("    bun: org.example.agent-daemon not on the restart list — reported only");
    expect(res.summary.join("\n")).toContain("STALE KEG: bun(reported only, not on the restart list) still running from a deleted keg");
  });

  test("a deferred service on hold is reported, not restarted", async () => {
    const r = await run({ ...SVC_BREW, files: { ...SVC_BREW.files, [SVC.holdFile]: "" } }, { cfg: { deferred: [SVC] } });
    expect(r.brew).toContain("svc(on hold, not restarted)");
    expect(r.brew).toContain("svc on hold since 2026-10-20 — not restarted");
  });

  test("a restart that cannot be made is FAILED to restart, never dropped", async () => {
    const r = await run({ ...SVC_BREW, rc: { "sudo -n launchctl kickstart -k system/sh.brew.good-a": 1 } }, { cfg: { deferred: [SVC] } });
    expect(r.brew).toContain("good-a(FAILED to restart)");
  });

  test("leftover drains are recovered before the brew build, stale-keg check after, then linkage", async () => {
    const lsofOut = "COMMAND PID USER FD TYPE DEVICE SIZE NODE NAME\n";
    const r = await run({ ...SVC_BREW, files: { ...SVC_BREW.files, [SVC.waiter]: "" }, dirs: ["/brew/Cellar"], lsof: [lsofOut] }, { cfg: { deferred: [SVC] } });
    const at = (re: RegExp) => r.calls.findIndex((c) => re.test(c));
    const order = [at(/^\/bin\/bash \/conf\.test\/svc-waiter\.sh --recover$/), at(/^brew update$/), at(/^brew upgrade good-a$/), at(/lsof -nP/), at(/^brew linkage --test/)];
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});

describe("the run: failures, timeouts and the summary", () => {
  test("individual failures keep the successes, the casks and the summary; rc 1", async () => {
    const r = await run({
      formulas: "bad-a good-a", casks: "app", verbose: "bad-a (1) < 2\ngood-a (1.0) < 1.1\napp (1.0) < 1.1",
      formulaTaps: { "bad-a": "homebrew/core", "good-a": "homebrew/core" }, caskTaps: { app: "homebrew/cask" }, upgradeRc: { "bad-a": 9 },
    });
    expect(r.calls).toContain("brew upgrade good-a");
    expect(r.brew).toMatch(/^ {2}brew: FAILED: bad-a; upgraded: good-a; casks upgraded: app/);
    expect(r.calls).toContain("brew cleanup");
    expect(r.rc).toBe(1);
  });

  test("a sensitive major increase is held; the rest upgrades", async () => {
    const r = await run({ formulas: "openssl@3 good-a", verbose: "openssl@3 (3.6.3) < 4.0.0\ngood-a (1.0) < 1.1", formulaTaps: { "openssl@3": "homebrew/core", "good-a": "homebrew/core" } });
    expect(r.calls).not.toContain("brew upgrade openssl@3");
    expect(r.calls).toContain("brew upgrade good-a");
    expect(r.log).toContain("Type A: holding [openssl@3] — upgrading [good-a]");
    expect(r.log.some((l) => l.startsWith("[notify] ⚠️ hosta Type A — holding 1 pkg(s)"))).toBe(true);
  });

  test("a timeout marks the brew phase failed and the run goes on: later steps, npm, summary, rc 1", async () => {
    const r = await run({ ...BREW, formulas: "good-a", timeout: ["brew upgrade good-a"] });
    expect(r.brew).toMatch(/^ {2}brew: FAILED: good-a; /);
    expect(r.log.some((l) => l.startsWith("  TIMEOUT after 1000 ms: brew upgrade good-a — killed; brew phase FAILED (good-a)"))).toBe(true);
    expect(r.calls.some((c) => c.startsWith("brew linkage"))).toBe(true);
    expect(r.calls).toContain("npm outdated -g --json");
    expect(r.summary).toContain("=== hosta summary ===");
    expect(r.rc).toBe(1);
  });

  test("a timeout in npm marks only npm failed", async () => {
    const r = await run({ timeout: ["npm outdated"] });
    // Mutant caught: "FAILED (timeout: …); nothing to update" (unparsed, and claims nothing to update).
    expect(r.npm).toMatch(/^ {2}npm: {2}FAILED — timeout:npm-outdated; not completed; /);
    expect(r.npm).not.toContain("nothing to update");
    expect(r.brew).toBe("  brew: nothing to update; notify: not configured — notices were logged only");
    expect(r.rc).toBe(1);
  });

  test("an outdated query that fails is FAILED, never nothing to update", async () => {
    const r = await run({ rc: { "brew outdated --fetch-HEAD --formula": 1, "brew outdated --formula": 1 } });
    expect(r.brew).toContain("FAILED: outdated-query");
    expect(r.brew).toContain("outdated --fetch-HEAD FAILED (rc 1)");
    expect(r.rc).toBe(1);
  });

  test("no reviewer configured: what needs a review is held as unavailable", async () => {
    const h = fakeHost({ npmOutdated: JSON.stringify({ tool: { current: "1.0.0", wanted: "1.1.0", latest: "1.1.0" } }) });
    const res = await applyHost(testConfig(), h.exec, h.fs, { dryRun: false });
    expect(npmLine(res.summary)).toMatch(/^ {2}npm: {2}FLAGGED — /);
    expect(h.calls).not.toContain("npm update -g tool");
  });

  test("the summary is read back by the host shadow parser unchanged", async () => {
    const r = await run({
      ...BREW, formulas: "good-a wm bad-a duckdb", verbose: `${BREW.verbose}\nbad-a (1) < 2\nduckdb (1.5.5) < 2.0.0`,
      formulaTaps: { ...BREW.formulaTaps, "bad-a": "homebrew/core", duckdb: "homebrew/core" }, upgradeRc: { "bad-a": 9 },
      pinFiles: [{ repo: "example-repo", path: "/repos.test/example-repo/pins.json", text: '{"brew":{"duckdb":"1"}}' }],
      npmOutdated: JSON.stringify({ tool: { current: "1.0.0", latest: "1.1.0" } }),
    }, { tb: fakeTypeB(1) });
    const s = parseSuSummary(r.text, "hosta")!;
    expect(s).not.toBeNull();
    expect(s.date).toBe("2026-10-22");
    expect(s.brew.upgraded).toEqual(["good-a"]);
    expect(s.brew.failed).toEqual(["bad-a"]);
    // Only the first awaiting item: the parser splits the brew line on ";" and the items are joined
    // with "; " (secure-update's own format, so the same holds for its logs).
    expect(s.brew.flagged).toEqual(["wm"]);
    expect(s.brew.pinned).toEqual(["duckdb"]);
    expect(s.npm.flagged).toBe(false);
    expect(s.npm.upgraded).toEqual(["tool"]);
    expect(s.aborted).toBe(false);
  });

  test("a second run the same day carries the state through: counts go on, other lanes kept", async () => {
    const STATE = "/state.test/pending-state.tsv";
    const s: HostScript = { casks: "app", caskTaps: { app: "homebrew/cask" }, verbose: "app (1.0) < 1.1", upgradeRc: { "--cask --greedy app": 1 } };
    const h = fakeHost({ ...s, files: { [STATE]: `npm${T}tool=2${T}1${T}2026-10-21\n` } });
    const cfg = testConfig({ npm: null, stuckAfter: 2 });
    const go = () => applyHost(cfg, h.exec, h.fs, { dryRun: false, reviewer: scripted([], "APPROVE").r, typeB: fakeTypeB().typeB, now: new Date(2026, 9, 22, 7, 0) });
    expect(brewLine((await go()).summary)).not.toContain("STUCK");
    expect(brewLine((await go()).summary)).toContain("STUCK: app=9.9(2 runs, since 2026-10-22)");
    expect(h.files.get(STATE)).toBe(`npm${T}tool=2${T}1${T}2026-10-21\nbrew${T}app=9.9${T}2${T}2026-10-22\n`);
  });
});

describe("slice 7 review", () => {
  const SVC1 = { name: "svc1", waiter: "/conf.test/svc1-waiter.sh", holdFile: "/state.test/svc1-hold", quarantineFile: "/state.test/svc1-q", outcomeFile: "/state.test/svc1-out", restartLog: "/state.test/svc1.log" };
  const SVC2 = { ...SVC1, name: "svc2", waiter: "/conf.test/svc2-waiter.sh", holdFile: "/state.test/svc2-hold", quarantineFile: "/state.test/svc2-q", outcomeFile: "/state.test/svc2-out" };

  test("5: timeouts round-trip through the shadow parser as failures", async () => {
    // Mutant caught: "FAILED (timeout: …)" text, which parseBrew/parseNpm never read as a failure.
    const r = await run({ ...BREW, formulas: "good-a", timeout: ["brew update", "npm outdated"] });
    const s = parseSuSummary(r.text, "hosta")!;
    expect(s.brew.failed).toEqual(["timeout:brew-update"]);
    expect(s.npm.failed).toEqual(["timeout:npm-outdated"]);
    const u = await run({ ...BREW, formulas: "good-a", timeout: ["brew upgrade good-a"] });
    expect(parseSuSummary(u.text, "hosta")!.brew.failed).toEqual(["good-a"]);
  });

  test("6: a Type A timeout part-way keeps what was done: summary, casks, relink/restart and cleanup still run", async () => {
    // Mutant caught: the old single brew step lost the casks (deferred after the loop) and skipped restart and cleanup.
    const r = await run({
      formulas: "good-a slow-b", casks: "app", verbose: "good-a (1.0) < 1.1\nslow-b (1) < 1.1\napp (1.0) < 1.1",
      formulaTaps: { "good-a": "homebrew/core", "slow-b": "homebrew/core" }, caskTaps: { app: "homebrew/cask" },
      timeout: ["brew upgrade slow-b"], files: { "/Library/LaunchDaemons/sh.brew.good-a.plist": "" },
    });
    expect(r.brew).toMatch(/^ {2}brew: FAILED: slow-b; upgraded: good-a; restarted: good-a\(sys\); casks upgraded: app/);
    expect(r.calls).toContain("sudo -n launchctl kickstart -k system/sh.brew.good-a");
    expect(r.calls).toContain("brew cleanup");
  });

  test("6: a Type B timeout part-way keeps the upgrades already done", async () => {
    // Mutant caught: Type B results returned only at the end, so wm was lost when wm2 timed out.
    const r = await run({
      formulas: "wm wm2", verbose: "wm (0.1) < 0.2\nwm2 (0.1) < 0.2", formulaTaps: { wm: "example/svc", wm2: "example/svc" },
      timeout: ["brew upgrade example/svc/wm2"], files: { "/Library/LaunchDaemons/sh.brew.wm.plist": "" },
    });
    expect(r.brew).toMatch(/^ {2}brew: FAILED: wm2; upgraded: wm; restarted: wm\(sys\)/);
    expect(r.calls).toContain("brew cleanup");
  });

  test("8: the end-of-run notice and the unported phases are in the summary", async () => {
    const r = await run({}, { cfg: { notify: ["notify-cmd"] } });
    expect(r.summary).toContain("  mas:  not checked — the App Store phase is not in oupdate");
    expect(r.npm).toMatch(/; claude-code: not configured$/);
    expect(parseSuSummary(r.text, "hosta")!.npm.claudeCode).toBeUndefined();
    expect(r.log.at(-1)).toBe("[notify] 📋 hosta secure-update done (oupdate)");
    expect(r.calls.filter((c) => c.startsWith("notify-cmd 📋 hosta secure-update done (oupdate)"))).toHaveLength(1);
    const d = await run({}, { dryRun: true, cfg: { notify: ["notify-cmd"] } });
    expect(d.calls.some((c) => c.startsWith("notify-cmd"))).toBe(false);
  });

  test("9: no notify command configured is said once in the log and on the brew line (a line the digest keeps)", async () => {
    // Mutant caught (re-review 6): a separate "  notify:" summary line, which the digest's brew|npm|mas filter drops.
    const r = await run({});
    expect(r.log.filter((l) => l.startsWith("notify: not configured"))).toHaveLength(1);
    expect(r.brew).toBe("  brew: nothing to update; notify: not configured — notices were logged only");
    expect(r.summary.filter((l) => l.startsWith("  ")).map((l) => l.trim().split(":")[0])).toEqual(["brew", "npm", "mas"]);
    expect((await run({}, { cfg: { notify: ["notify-cmd"] } })).brew).toBe("  brew: nothing to update");
  });

  test("9b: notify [] is log-only by choice: notices are logged, nothing is sent, and no not-configured note", async () => {
    const r = await run({}, { cfg: { notify: [] } });
    expect(r.brew).toBe("  brew: nothing to update");
    expect(r.log.some((l) => l.startsWith("notify: not configured"))).toBe(false);
    expect(r.log.at(-1)).toBe("[notify] 📋 hosta secure-update done (oupdate)");
    expect(r.calls.some((c) => c.includes("secure-update done"))).toBe(false);
  });

  test("11: with two deferred services, a dependency keg goes to the service that holds it", async () => {
    // Mutant caught: the old fallback handed any keg not named after a service to deferred[0] (svc1).
    const lsof = "COMMAND PID USER FD TYPE DEVICE SIZE NODE NAME\nsvc2 77 u txt REG 1,4 1 2 /brew/Cellar/libdep/1.0/lib/libdep.dylib\n";
    const r = await run({ dirs: ["/brew/Cellar"], lsof: [lsof], ps: { "77": { comm: "svc2", command: "svc2 serve", ppid: "1" } }, files: { [SVC1.waiter]: "", [SVC2.waiter]: "" } }, { cfg: { deferred: [SVC1, SVC2] } });
    expect(r.calls).toContain(`/bin/bash ${SVC2.waiter} --holder`);
    expect(r.calls).not.toContain(`/bin/bash ${SVC1.waiter} --holder`);
    expect(r.brew).toContain("svc2 stale — waiter already running");
  });

  test("12: a failed brew list --pinned is a warning in the summary; repo pins still hold", async () => {
    const r = await run({
      formulas: "duckdb", verbose: "duckdb (1) < 2", formulaTaps: { duckdb: "homebrew/core" }, rc: { "brew list --pinned": 1 },
      pinFiles: [{ repo: "example-repo", path: "/repos.test/example-repo/pins.json", text: '{"brew":{"duckdb":"1"}}' }],
    });
    expect(r.brew).toContain("WARNING: brew list --pinned failed (rc 1) — brew pins not read, repo pins still held");
    expect(r.brew).toContain("PINNED: duckdb(example-repo)");
  });

  test("13: a tap-qualified exclusion entry matches the bare cask name", async () => {
    // Mutant caught: named() looked up only the candidate's segments, never the entry's.
    const r = await run({ casks: "big app", caskTaps: { big: "homebrew/cask", app: "homebrew/cask" }, verbose: "big (1) < 2\napp (1.0) < 1.1" }, { cfg: { caskExclude: ["example/tf/big"] } });
    expect(r.calls).not.toContain("brew upgrade --cask --greedy big");
    expect(r.log.some((l) => l.startsWith("big ("))).toBe(false);
  });
});

describe("slice 7 re-review", () => {
  test("2: an npm timeout after an earlier package was updated keeps it, the pending list and the review in the log", async () => {
    // Mutant caught: npmSection's own log and status, returned only at the end (pkg1 and the review vanished).
    const r = await run({ npmOutdated: JSON.stringify({ one: { current: "1.0.0", latest: "1.1.0" }, two: { current: "1.0.0", latest: "1.1.0" } }), timeout: ["npm update -g two"] });
    // Mutant caught (re-review 2): NpmRun.pending never read.
    expect(r.npm).toMatch(/^ {2}npm: {2}FAILED — two; upgraded: one; not completed — still pending: two; /);
    expect(r.log).toContain("Pending npm upgrades:");
    expect(r.log.some((l) => l.startsWith("┌─ review npm"))).toBe(true);
    const s = parseSuSummary(r.text, "hosta")!;
    expect(s.npm.upgraded).toEqual(["one"]);
    expect(s.npm.failed).toEqual(["two"]);
  });

  test("2: a restart timeout keeps the relink note and the restarts already made", async () => {
    // Mutant caught: b.restarted assigned only when restartUpgraded returned.
    const r = await run({
      formulas: "good-a good-b", verbose: "good-a (1.0) < 1.1\ngood-b (1.0) < 1.1", formulaTaps: { "good-a": "homebrew/core", "good-b": "homebrew/core" },
      files: { "/Library/LaunchDaemons/sh.brew.good-a.plist": "", "/Library/LaunchDaemons/sh.brew.good-b.plist": "" },
      timeout: ["sudo -n launchctl kickstart -k system/sh.brew.good-b"],
    });
    expect(r.brew).toMatch(/^ {2}brew: FAILED: timeout:launchctl-kickstart; upgraded: good-a good-b; restarted: good-a\(sys\)/);
  });

  test("2: a stale-keg re-scan timeout keeps the handoff note; a linkage timeout keeps the stale-keg note", async () => {
    // Mutant caught: the handoff note only in staleKegCheck's return value (lost when its re-scan timed out).
    const SVC = { name: "svc", waiter: "/conf.test/svc-waiter.sh", holdFile: "/state.test/svc-hold", quarantineFile: "/state.test/svc-q", outcomeFile: "/state.test/svc-out", restartLog: "/state.test/svc.log" };
    const lsof = "COMMAND PID USER FD TYPE DEVICE SIZE NODE NAME\nsvc 77 u txt REG 1,4 1 2 /brew/Cellar/svc/1.0/bin/svc\n";
    // The first lsof answers; the re-scan after the handoff times out (timeout matching is by prefix, so script it by count).
    const h = fakeHost({ dirs: ["/brew/Cellar"], lsof: [lsof], files: { [SVC.waiter]: "" }, ps: { "77": { comm: "svc", ppid: "1" } } });
    let n = 0;
    const exec: typeof h.exec = async (argv, o) => (argv[0]!.endsWith("lsof") && ++n === 2 ? { rc: 143, out: "", err: "", timedOut: true } : h.exec(argv, o));
    const res = await applyHost(testConfig({ deferred: [SVC], npm: null }), exec, h.fs, { dryRun: false, reviewer: scripted([], "APPROVE").r, typeB: fakeTypeB().typeB });
    expect(brewLine(res.summary)).toMatch(/^ {2}brew: FAILED: timeout:lsof; .*svc stale — waiter already running/);
    const lk = await run({ dirs: ["/brew/Cellar"], lsof: [lsof], files: { [SVC.waiter]: "" }, ps: { "77": { comm: "svc", ppid: "1" } }, timeout: ["brew linkage"] }, { cfg: { deferred: [SVC] } });
    expect(lk.brew).toContain("svc stale — waiter already running");
    expect(lk.brew).toContain("FAILED: timeout:brew-linkage");
  });

  test("2: a timed-out launchctl label query falls back to the plist name and never fails the brew phase", async () => {
    // Mutant caught: kegEnv.query left on the step's exec (the timeout stopped the stale-keg step as FAILED).
    const lsof = ["COMMAND PID USER FD TYPE DEVICE SIZE NODE NAME", "bun 77 u txt REG 1,4 1 2 /brew/Cellar/bun/1.0_old/bin/bun", "bun 78 u txt REG 1,4 1 2 /brew/Cellar/bun/1.1/bin/bun"].join("\n");
    const h = fakeHost({ dirs: ["/brew/Cellar", "/brew/Cellar/bun/1.1"], lsof: [lsof, lsof.split("\n").filter((l) => !l.includes(" 77 ")).join("\n")], ps: { "77": { comm: "bun", ppid: "1" } }, timeout: ["launchctl print system", "launchctl print gui/501"] });
    const fs = { ...h.fs, listDir: async (p: string) => (p === "/Library/LaunchDaemons" ? ["sh.brew.bun.plist"] : []) };
    const res = await applyHost(testConfig({ npm: null }), h.exec, fs, { dryRun: false, reviewer: scripted([], "APPROVE").r, typeB: fakeTypeB().typeB });
    expect(res.log).toContain("    launchctl print gui/501 timed out — falling back to the plist name");
    expect(h.calls).toContain("sudo -n launchctl kickstart -k system/sh.brew.bun");
    expect(brewLine(res.summary)).not.toContain("FAILED");
    expect(res.summary.join("\n")).toContain("restarted onto new keg: bun");
  });

  test("2: a labelRestart owner command reaches the run's detached spawn, with the label appended", async () => {
    // Mutant caught: labelRestart or spawnDetached not passed from the run to the stale-keg check.
    const lsof = ["COMMAND PID USER FD TYPE DEVICE SIZE NODE NAME", "bun 77 u txt REG 1,4 1 2 /brew/Cellar/bun/1.0_old/bin/bun"].join("\n");
    const print = "system = {\n\tservices = {\n\t\t      77      - \torg.example.agent-daemon\n\t}\n}\n";
    const h = fakeHost({ dirs: ["/brew/Cellar"], lsof: [lsof], ps: { "77": { comm: "bun", ppid: "1" } } });
    const exec: typeof h.exec = async (argv, o) => (argv.join(" ") === "launchctl print system" ? { rc: 0, out: print, err: "" } : h.exec(argv, o));
    const res = await applyHost(testConfig({ npm: null, labelRestart: { "org.example.agent-daemon": ["/opt/owner.test/restart-when-quiet"] } }), exec, h.fs, { dryRun: false, reviewer: scripted([], "APPROVE").r, typeB: fakeTypeB().typeB });
    expect(h.spawned).toContainEqual(["/opt/owner.test/restart-when-quiet", "org.example.agent-daemon"]);
    expect(h.calls.some((c) => c.includes("kickstart"))).toBe(false);
    expect(res.summary.join("\n")).toContain("STALE KEG: bun handed to restart-when-quiet (org.example.agent-daemon)");
  });

  test("3: a failed query never reads as nothing approved", async () => {
    // Mutant caught: "FAILED: timeout:brew-update; nothing approved for upgrade".
    const r = await run({ ...BREW, timeout: ["brew update"] });
    expect(r.brew).toMatch(/^ {2}brew: FAILED: timeout:brew-update(;|$)/);
    expect(r.brew).not.toContain("nothing approved");
  });

  test("5: timeout tokens name the real command and package", async () => {
    const { timeoutToken } = await import("../../src/apply/run.ts");
    // Mutants caught: `git -C …` → timeout:-C, `sudo -n …` → timeout:-n, `@scope/b` → b.
    expect(timeoutToken(["git", "-C", "/tap.test", "rev-parse", "HEAD"])).toBe("timeout:git-rev-parse");
    expect(timeoutToken(["sudo", "-n", "launchctl", "kickstart", "-k", "system/x"])).toBe("timeout:launchctl-kickstart");
    expect(timeoutToken(["sudo", "-n", "/usr/local/sbin/helper.test", "svc"])).toBe("timeout:helper.test");
    expect(timeoutToken(["npm", "update", "-g", "@scope/b"])).toBe("@scope/b");
    expect(timeoutToken(["brew", "upgrade", "--cask", "--greedy", "app"])).toBe("app");
    expect(timeoutToken(["brew", "upgrade", "example/svc/svc"])).toBe("svc");
    expect(timeoutToken(["/usr/sbin/lsof", "-nP", "-w", "-d", "txt,mem"])).toBe("timeout:lsof");
    expect(timeoutToken(["/opt.test/bin/claude", "update"])).toBe("timeout:claude-update");
  });
});

describe("slice 7 re-review 2", () => {
  const SVC = { name: "svc", waiter: "/conf.test/svc-waiter.sh", holdFile: "/state.test/svc-hold", quarantineFile: "/state.test/svc-q", outcomeFile: "/state.test/svc-out", restartLog: "/state.test/svc.log" };
  const lsof = "COMMAND PID USER FD TYPE DEVICE SIZE NODE NAME\nsvc 77 u txt REG 1,4 1 2 /brew/Cellar/svc/1.0/bin/svc\n";

  test("a re-scan lsof that fails (not a timeout) keeps the handoff note beside the failure", async () => {
    // Mutant caught: the re-scan failure note replaced the handoff note, and the run's `staleNote || handoffNotes` dropped it.
    const h = fakeHost({ dirs: ["/brew/Cellar"], lsof: [lsof], files: { [SVC.waiter]: "" }, ps: { "77": { comm: "svc", ppid: "1" } } });
    let n = 0;
    const exec: typeof h.exec = async (argv, o) => (argv[0]!.endsWith("lsof") && ++n === 2 ? { rc: 1, out: "", err: "" } : h.exec(argv, o));
    const res = await applyHost(testConfig({ deferred: [SVC], npm: null }), exec, h.fs, { dryRun: false, reviewer: scripted([], "APPROVE").r, typeB: fakeTypeB().typeB });
    expect(brewLine(res.summary)).toContain("STALE-KEG CHECK FAILED: lsof unusable on re-scan (/usr/sbin/lsof); svc stale — waiter already running");
  });

  test("the stale-keg, relink and linkage detail lines are in the run log", async () => {
    // Mutants caught: `log` dropped from the staleKegCheck, relinkUpgraded or linkageCheck call (their lines vanished).
    const r = await run({
      formulas: "good-a", verbose: "good-a (1.0) < 1.1", formulaTaps: { "good-a": "homebrew/core" },
      dirs: ["/brew/Cellar", "/brew/var/homebrew/linked"], lsof: [lsof], files: { [SVC.waiter]: "" }, ps: { "77": { comm: "svc", command: "svc serve", ppid: "1" } },
      rc: { "brew linkage --test good-a": 1 },
    }, { cfg: { deferred: [SVC] } });
    expect(r.log).toContain("  STALE KEG: svc — pid 77 (svc serve) still running from 1.0, which no longer exists");
    expect(r.log).toContain("  good-a: upgraded but NOT linked — relinking before restart");
    expect(r.log).toContain("  LINKAGE FAILED: brew linkage --test (unparsed, see log); fix: brew reinstall --build-from-source <formula>");
  });
});

describe("slice 7 re-review 3", () => {
  test("no done notice once stopping, even through a notify command that would run", async () => {
    // Mutant caught: the isStopping check before the done notice removed (the fake host's notify command never short-circuits).
    const h = fakeHost({});
    const res = await applyHost(testConfig({ notify: ["notify-cmd"], npm: null }), h.exec, h.fs, { dryRun: false, reviewer: scripted([], "APPROVE").r, typeB: fakeTypeB().typeB, isStopping: () => true });
    expect(h.calls.some((c) => c.startsWith("notify-cmd 📋"))).toBe(false);
    expect(res.log.some((l) => l.includes("secure-update done"))).toBe(false);
    const go = fakeHost({});
    await applyHost(testConfig({ notify: ["notify-cmd"], npm: null }), go.exec, go.fs, { dryRun: false, reviewer: scripted([], "APPROVE").r, typeB: fakeTypeB().typeB, isStopping: () => false });
    expect(go.calls.some((c) => c.startsWith("notify-cmd 📋"))).toBe(true);
  });
});

describe("slice 7 follow-up", () => {
  test("in the run, a timed-out holder probe hands off and the brew line says so", async () => {
    // Mutant caught: the waiter env on the run's throwing exec (a timed-out probe stopped the stale-keg step, no handoff).
    const SVC = { name: "svc", waiter: "/conf.test/svc-waiter.sh", holdFile: "/state.test/svc-hold", quarantineFile: "/state.test/svc-q", outcomeFile: "/state.test/svc-out", restartLog: "/state.test/svc.log" };
    const lsof = "COMMAND PID USER FD TYPE DEVICE SIZE NODE NAME\nsvc 77 u txt REG 1,4 1 2 /brew/Cellar/svc/1.0/bin/svc\n";
    const r = await run({ dirs: ["/brew/Cellar"], lsof: [lsof], files: { [SVC.waiter]: "" }, ps: { "77": { comm: "svc", ppid: "1" } }, timeout: [`/bin/bash ${SVC.waiter} --holder`] }, { cfg: { deferred: [SVC] } });
    expect(r.spawned).toEqual([["/bin/bash", SVC.waiter, "/brew/Cellar/svc/1.0"]]);
    expect(r.brew).toContain("svc stale — restart handed to waiter (pid 4242) (holder check timed out)");
    expect(r.brew).not.toContain("timeout:");
  });
});

describe("Claude Code native update in the npm phase (port 12c, claude_step)", () => {
  const CC = "/opt.test/claude-native/bin/claude";
  const ccCalls = (calls: string[]) => calls.filter((c) => c.startsWith(CC));
  const cc = (script: HostScript = {}, o: Parameters<typeof run>[1] = {}) => run({ executables: [CC], ...script }, { ...o, cfg: { claudeCode: CC, ...o.cfg } });

  test("an update reports the version after it on the npm line, and su-log reads it", async () => {
    // Mutants caught: the step not run (no update call), the version read before the update, the part dropped from the npm line.
    const r = await cc({ claudeUpdateOut: "Checking for updates\nSuccessfully updated from 1.0.0 to 2.0.0\n" });
    expect(ccCalls(r.calls)).toEqual([`${CC} update`, `${CC} --version`]);
    expect(r.npm).toBe("  npm:  nothing to update; claude-code: 2.0.0");
    const at = r.log.indexOf("--- claude code (native) ---");
    expect(at).toBeGreaterThan(r.log.findIndex((l) => l.startsWith("--- npm")));
    expect(r.log.slice(at + 1, at + 3)).toEqual(["  Checking for updates", "  Successfully updated from 1.0.0 to 2.0.0"]);
    expect(parseSuSummary(r.text, "hosta")!.npm).toEqual({ upgraded: [], flagged: false, failed: [], claudeCode: "2.0.0" });
    expect(r.rc).toBe(0);
  });

  test("a failed update is FAILED with its rc and the version it is stuck on; su-log sees a failure", async () => {
    // Mutants caught: rc ignored (reported as the version), the version left out, parseNpm reading FAILED as fine.
    const r = await cc({ rc: { [`${CC} update`]: 1 }, claudeVersion: "1.0.0" });
    expect(r.npm).toBe("  npm:  nothing to update; claude-code: FAILED (rc=1, on 1.0.0)");
    const s = parseSuSummary(r.text, "hosta")!;
    expect(s.npm.claudeCode).toBe("1.0.0");
    expect(s.npm.claudeCodeFailed).toBe(true);
    expect(r.rc).toBe(1);
  });

  test("a wholly broken binary (update and --version fail) still reports, on unknown, and the run goes on", async () => {
    // Mutant caught: a failed --version's stdout taken as the version ("dyld:"), or the step thrown away.
    const r = await cc({ rc: { [`${CC} update`]: 1 }, claudeVersion: null }, { cfg: { notify: ["notify-cmd"] } });
    expect(r.npm).toBe("  npm:  nothing to update; claude-code: FAILED (rc=1, on unknown)");
    expect(r.summary).toContain("  mas:  not checked — the App Store phase is not in oupdate");
    expect(r.calls.some((c) => c.startsWith("notify-cmd 📋"))).toBe(true);
    const s = parseSuSummary(r.text, "hosta")!;
    expect(s.npm.claudeCodeFailed).toBe(true);
    expect(s.npm.claudeCode).toBeUndefined();
  });

  test("--version failing after a good update reports unknown", async () => {
    const r = await cc({ claudeVersion: null });
    expect(r.npm).toBe("  npm:  nothing to update; claude-code: unknown");
  });

  test("an update that times out is FAILED (a timeout entry su-log counts as failed); --version still runs and the run finishes", async () => {
    // Mutants caught: the timeout escaping the step (no summary), no FAILED — entry, the run's timeout not passed.
    const timeouts: (number | undefined)[] = [];
    const h = fakeHost({ executables: [CC], timeout: [`${CC} update`], claudeVersion: "1.0.0" });
    const exec: typeof h.exec = async (argv, o) => {
      if (argv[0] === CC) timeouts.push(o?.timeoutMs);
      return h.exec(argv, o);
    };
    const res = await applyHost(testConfig({ claudeCode: CC, timeoutMs: 777 }), exec, h.fs, { dryRun: false, reviewer: scripted([], "APPROVE").r, typeB: fakeTypeB().typeB });
    expect(timeouts).toEqual([777, 777]);
    const line = npmLine(res.summary);
    expect(line).toBe("  npm:  FAILED — timeout:claude-update; nothing to update; claude-code: FAILED (timeout, on 1.0.0)");
    expect(res.log).toContain(`  TIMEOUT after 777 ms: ${CC} update — killed; npm phase FAILED (timeout:claude-update)`);
    const s = parseSuSummary([...res.log, ...res.summary].join("\n"), "hosta")!;
    expect(s.npm.failed).toEqual(["timeout:claude-update"]);
    expect(s.npm.claudeCodeFailed).toBe(true);
    expect(s.npm.claudeCode).toBe("1.0.0");
    expect(res.rc).toBe(1);
  });

  test("with npm null the step still runs, its timeout on the npm line (never the brew line)", async () => {
    // Mutant caught: phase left at "brew" when the npm step is skipped, so the timeout landed on the brew line.
    const r = await cc({ timeout: [`${CC} update`] }, { cfg: { npm: null } });
    expect(r.npm).toBe("  npm:  FAILED — timeout:claude-update; not managed here (apply.npm is null); claude-code: FAILED (timeout, on 2.0.0)");
    expect(r.brew).not.toContain("timeout:claude");
  });

  test("not configured: no call, the npm line says so", async () => {
    // Mutant caught: a default path probed or run when apply.claudeCode is absent.
    const r = await run({ executables: [CC] });
    expect(ccCalls(r.calls)).toEqual([]);
    expect(r.calls.some((c) => c.includes("claude"))).toBe(false);
    expect(r.npm).toBe("  npm:  nothing to update; claude-code: not configured");
    expect(parseSuSummary(r.text, "hosta")!.npm.claudeCode).toBeUndefined();
  });

  test("configured but not executable: skipped silently, as the bash, no claude-code part", async () => {
    // Mutant caught: the step run without the executable check (or a part/log line added).
    const r = await cc({ executables: [] });
    expect(ccCalls(r.calls)).toEqual([]);
    expect(r.npm).toBe("  npm:  nothing to update");
    expect(r.log).not.toContain("--- claude code (native) ---");
  });

  test("dry run: the would-run line, no calls at all, claude-code: dry-run", async () => {
    // Mutants caught: update run in a dry run; --version called in a dry run.
    const r = await cc({}, { dryRun: true });
    expect(ccCalls(r.calls)).toEqual([]);
    expect(r.log).toContain("  DRY RUN - would run: claude update");
    expect(r.npm).toBe("  npm:  nothing to update; claude-code: dry-run");
  });

  test("stopping: nothing runs; stopped during the update: no --version", async () => {
    // Mutants caught: the isStopping check before the update removed; the one before --version removed.
    const h = fakeHost({ executables: [CC] });
    const res = await applyHost(testConfig({ claudeCode: CC }), h.exec, h.fs, { dryRun: false, reviewer: scripted([], "APPROVE").r, typeB: fakeTypeB().typeB, isStopping: () => true });
    expect(ccCalls(h.calls)).toEqual([]);
    expect(npmLine(res.summary)).toMatch(/; claude-code: not run \(oupdate is stopping\)$/);
    let stop = false;
    const g = fakeHost({ executables: [CC] });
    const exec: typeof g.exec = async (argv, o) => {
      if (argv.join(" ") === `${CC} update`) {
        stop = true;
        return { rc: 143, out: "", err: "" };
      }
      return g.exec(argv, o);
    };
    const r2 = await applyHost(testConfig({ claudeCode: CC }), exec, g.fs, { dryRun: false, reviewer: scripted([], "APPROVE").r, typeB: fakeTypeB().typeB, isStopping: () => stop });
    expect(ccCalls(g.calls)).toEqual([]);
    expect(npmLine(r2.summary)).toMatch(/; claude-code: FAILED \(rc=143, on unknown\)$/);
  });
});

describe("app bundles", () => {
  const APP = { name: "omlx", app: "/Applications/oMLX.app", repo: "jundot/omlx", asset: "x" };
  const net = (releases: AppNet["releases"]): AppNet => ({ releases, download: async () => {}, sha256: async () => "", exists: async () => false, mkdir: async () => {}, remove: async () => {} });
  test("none configured: the phase is silent", async () => {
    const r = await run(BREW);
    expect(r.text).not.toContain("--- app bundles ---");
  });
  test("a bundle that cannot be checked is FAILED in the brew line and fails the run", async () => {
    const r = await run(BREW, { cfg: { appBundles: [APP] }, appNet: net(async () => { throw new Error("offline"); }) });
    expect(r.text).toContain("--- app bundles ---");
    expect(r.brew).toContain("app:omlx");
    expect(r.rc).toBe(1);
  });
});
