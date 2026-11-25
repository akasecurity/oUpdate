// OUP-326 item 2: <stateDir>/last-run.json, the result of a real run.
import { describe, expect, test } from "bun:test";
import type { AppNet } from "../../src/apply/appbundle.ts";
import { applyHost } from "../../src/apply/run.ts";
import { isoZone } from "../../src/apply/last-run.ts";
import { fakeHost, fakeTypeB, testConfig, type HostScript } from "./host-fixture.ts";
import { scripted } from "./helpers.ts";

const FILE = "/state.test/last-run.json";
const BREW: HostScript = { formulas: "good-a", verbose: "good-a (1.0) < 1.1", formulaTaps: { "good-a": "homebrew/core" } };
const NOW = new Date(2026, 9, 22, 7, 0, 0);

async function run(script: HostScript, o: { reply?: string; dryRun?: boolean; cfg?: Parameters<typeof testConfig>[0]; now?: Date; appNet?: AppNet; apply?: { isStopping?: () => boolean; cliRc?: () => number | undefined }; throwOn?: string; onCall?: (line: string, n: number) => { rc: number; out: string; err: string } | undefined } = {}) {
  const h = fakeHost(script);
  const inner = h.exec;
  const seen = new Map<string, number>();
  if (o.onCall) h.exec = async (argv, opts) => { const line = argv.join(" "); const n = (seen.get(line) ?? 0) + 1; seen.set(line, n); return o.onCall!(line, n) ?? inner(argv, opts); };
  const inner2 = h.exec;
  if (o.throwOn) h.exec = async (argv, opts) => { if (argv[0] === o.throwOn) throw new Error("spawn failed"); return inner2(argv, opts); };
  const res = await applyHost(testConfig({ logFile: "/log.test/host-update.log", ...o.cfg }), h.exec, h.fs, { dryRun: o.dryRun ?? false, reviewer: scripted([], o.reply ?? "APPROVE\nno attack indicators found").r, typeB: fakeTypeB(0).typeB, now: o.now ?? NOW, ...(o.appNet ? { appNet: o.appNet } : {}), ...o.apply });
  const text = h.files.get(FILE);
  return { ...res, ...h, doc: text === undefined ? undefined : JSON.parse(text), text };
}

describe("last-run.json (OUP-326)", () => {
  test("a clean run writes the file with its fields", async () => {
    const r = await run(BREW);
    expect(r.rc).toBe(0);
    expect(r.doc).toMatchObject({ host: "hosta", ok: true, rc: 0, failed: [], upgraded: ["good-a"], held: [], linkage: "", log: "/log.test/host-update.log" });
    expect(r.doc.started).toBe(isoZone(NOW));
    expect(r.doc.ended).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d$/);
    expect(r.doc.version).toMatch(/^\d+\.\d+\.\d+/);
  });
  test("a failed run (rc 1) writes ok false and the failed token", async () => {
    const r = await run({ ...BREW, rc: { "brew update": 1 } });
    expect(r.rc).toBe(1);
    expect(r.doc).toMatchObject({ ok: false, rc: 1, failed: ["update"], upgraded: [] });
  });
  test("a held formula is listed", async () => {
    const r = await run({ ...BREW, formulas: "duckdb", verbose: "duckdb (1.5.5) < 2.0.0", formulaTaps: { duckdb: "homebrew/core" }, pinFiles: [{ repo: "example-repo", path: "/repos.test/example-repo/pins.json", text: '{"brew":{"duckdb":"1.5.5"}}' }] });
    expect(r.doc.held).toEqual(["duckdb"]);
  });
  test("a dry run writes nothing", async () => {
    const r = await run(BREW, { dryRun: true });
    expect(r.text).toBeUndefined();
    expect(r.writes.filter((w) => w.includes("last-run"))).toEqual([]);
  });
  test("a write that fails is a warning and leaves the rc as it was", async () => {
    const ok = await run(BREW);
    const r = await run({ ...BREW, failWrite: [FILE] });
    expect(r.text).toBeUndefined();
    expect(r.rc).toBe(ok.rc);
    expect(r.log.join("\n")).toContain(`WARNING: could not write the last-run file ${FILE} (ENOSPC: no space left on device)`);
    const f = await run({ ...BREW, rc: { "brew update": 1 }, failWrite: [FILE] });
    expect(f.rc).toBe(1);
  });
  test("started and ended are ISO in the host's zone: a fixed instant in America/Los_Angeles, offset sign included", async () => {
    const was = process.env.TZ;
    process.env.TZ = "America/Los_Angeles";
    try {
      const r = await run(BREW, { now: new Date(Date.UTC(2026, 10, 24, 17, 5, 9)) });
      expect(r.doc.started).toBe("2026-11-24T09:05:09-08:00");
      expect(isoZone(new Date(Date.UTC(2026, 6, 4, 12, 0, 0)))).toBe("2026-07-04T05:00:00-07:00");
      process.env.TZ = "Asia/Kolkata";
      expect(isoZone(new Date(Date.UTC(2026, 10, 24, 17, 5, 9)))).toBe("2026-11-24T22:35:09+05:30");
    } finally {
      if (was === undefined) delete process.env.TZ;
      else process.env.TZ = was;
    }
  });
  test("the pid ties the file to the run record", async () => {
    expect((await run(BREW)).doc.pid).toBe(process.pid);
  });
  test("a failed Claude Code update is a failed token", async () => {
    const CC = "/opt.test/claude-native/bin/claude";
    const r = await run({ ...BREW, executables: [CC], rc: { [`${CC} update`]: 1 } }, { cfg: { claudeCode: CC } });
    expect(r.rc).toBe(1);
    expect(r.doc.failed).toContain("claude-code");
  });
  test("a failed npm package is npm:<name> and the run is not ok", async () => {
    const r = await run({ npmOutdated: JSON.stringify({ tool: { current: "1.0.0", wanted: "1.1.0", latest: "1.1.0" } }), rc: { "npm install -g tool@1.1.0": 1 } });
    expect(r.rc).toBe(1);
    expect(r.doc).toMatchObject({ ok: false, rc: 1, failed: ["npm:tool"] });
  });
  test("an npm ERROR after an upgrade (the pending query fails) is the token npm; the upgrade is still listed", async () => {
    const out = JSON.stringify({ tool: { current: "1.0.0", wanted: "1.1.0", latest: "1.1.0" } });
    const r = await run({ npmOutdated: out }, { onCall: (l, n) => (l === "npm outdated -g --json" && n === 2 ? { rc: 5, out: "", err: "" } : undefined) });
    expect(r.rc).toBe(1);
    expect(r.doc).toMatchObject({ ok: false, rc: 1, failed: ["npm"], upgraded: ["tool"] });
  });
  test("a timed-out configured command is the program only: its argument is never in the file", async () => {
    const r = await run({ ...BREW, timeout: ["git SENTINEL-ARG-4e2"] }, { cfg: { postUpgradeCheck: { "good-a": ["git", "SENTINEL-ARG-4e2"] } } });
    expect(r.doc.failed).toContain("timeout:git");
    expect(r.text).not.toContain("SENTINEL-ARG-4e2");
  });
  test("a timed-out npm check is the program only too: its package argument is never in the file", async () => {
    const out = JSON.stringify({ tool: { current: "1.0.0", wanted: "1.1.0", latest: "1.1.0" } });
    const r = await run({ npmOutdated: out, timeout: ["npm update SENTINEL-NPM-ARG-8a1"] }, { cfg: { postUpgradeCheck: { tool: ["npm", "update", "SENTINEL-NPM-ARG-8a1"] } } });
    expect(r.doc.failed).toContain("timeout:npm");
    expect(r.text).not.toContain("SENTINEL-NPM-ARG-8a1");
  });
  test("two scoped npm packages with one base name stay two held entries", async () => {
    const out = JSON.stringify({ "@a/tool": { current: "1", wanted: "2", latest: "2" }, "@b/tool": { current: "1", wanted: "2", latest: "2" } });
    const h = fakeHost({ npmOutdated: out });
    await applyHost(testConfig(), h.exec, h.fs, { dryRun: false, reviewer: scripted(["FLAG\nan attack indicator"]).r, typeB: fakeTypeB(0).typeB, now: NOW });
    expect(JSON.parse(h.files.get(FILE)!).held).toEqual(["@a/tool", "@b/tool"]);
  });
  test("an app bundle the updater holds is in held by name", async () => {
    const APP = { name: "exampleapp", app: "/Applications/Example.app", repo: "owner/exampleapp", asset: "x" };
    const PLIST = (k: string) => `/usr/bin/plutil -extract ${k} raw -o - /Applications/Example.app/Contents/Info.plist`;
    const r = await run({
      ...BREW,
      answers: {
        [PLIST("CFBundleShortVersionString")]: { rc: 0, out: "0.7.0\n" },
        [PLIST("CFBundleIdentifier")]: { rc: 0, out: "com.example.app\n" },
        "codesign -dv /Applications/Example.app": { rc: 0, out: "TeamIdentifier=ABCDE12345\n" },
      },
    }, { cfg: { appBundles: [APP] }, appNet: { releases: async () => [{ tag_name: "v0.7.1", prerelease: false, draft: false, assets: [] }], download: async () => {}, sha256: async () => "", exists: async () => false, mkdir: async () => {}, remove: async () => {} } });
    expect(r.log.join("\n")).toContain("exampleapp: 0 release assets match x");
    expect(r.doc.held).toEqual(["exampleapp"]);
  });
  test("a brew upgrade that failed and an npm install that timed out, both named tool: both entries are in failed", async () => {
    const out = JSON.stringify({ typescript: { current: "1.0.0", wanted: "1.1.0", latest: "1.1.0" } });
    const r = await run({ formulas: "typescript", verbose: "typescript (1.0) < 1.1", formulaTaps: { typescript: "homebrew/core" }, upgradeRc: { typescript: 1 }, npmOutdated: out, timeout: ["npm install -g typescript@1.1.0"] });
    expect(r.doc.failed).toEqual(["typescript", "timeout:npm"]);
  });
  test.each([
    ["sudo -n with an environment assignment", ["sudo", "-n", "API_TOKEN=s3cr3t-5d1", "/usr/local/bin/check"], "s3cr3t-5d1"],
    ["sudo -u with a user name", ["sudo", "-u", "svcuser-5d1", "/usr/local/bin/check"], "svcuser-5d1"],
  ])("a timed-out check run through %s is timeout:sudo, nothing after sudo is read", async (_n, argv, secret) => {
    const r = await run({ ...BREW, timeout: [argv.join(" ")] }, { cfg: { postUpgradeCheck: { "good-a": argv } } });
    expect(r.doc.failed).toContain("timeout:sudo");
    expect(r.text).not.toContain(secret);
  });
  test("a brew update and an npm query that both time out: each lane's entry is its own program token", async () => {
    const r = await run({ ...BREW, timeout: ["brew update", "npm outdated"] });
    expect(r.doc.failed).toEqual(["timeout:brew", "timeout:npm"]);
  });
  test("a newline in a pin's repo name does not leak into held", async () => {
    const r = await run({ formulas: "duckdb", verbose: "duckdb (1.5.5) < 2.0.0", formulaTaps: { duckdb: "homebrew/core" }, pinFiles: [{ repo: "private\nrepo", path: "/repos.test/private-repo/pins.json", text: '{"brew":{"duckdb":"1.5.5"}}' }] });
    expect(r.doc.held).toEqual(["duckdb"]);
  });
  test("a formula the Type A policy held is in held", async () => {
    const r = await run({ formulas: "openssl@3 good-a", verbose: "openssl@3 (3.6.3) < 4.0.0\ngood-a (1.0) < 1.1", formulaTaps: { "openssl@3": "homebrew/core", "good-a": "homebrew/core" } });
    expect(r.doc.held).toEqual(["openssl@3"]);
    expect(r.doc.upgraded).toEqual(["good-a"]);
  });
  test("an npm batch the review flagged is held, every package named", async () => {
    const out = JSON.stringify({ a: { current: "1", wanted: "2", latest: "2" }, b: { current: "1", wanted: "2", latest: "2" } });
    const h = fakeHost({ npmOutdated: out });
    const res = await applyHost(testConfig(), h.exec, h.fs, { dryRun: false, reviewer: scripted(["FLAG\nan attack indicator"]).r, typeB: fakeTypeB(0).typeB, now: NOW });
    const doc = JSON.parse(h.files.get(FILE)!);
    expect(doc.held).toEqual(["a", "b"]);
    expect(doc.upgraded).toEqual([]);
  });
  test("two failed npm installs are both named, once each", async () => {
    const r = await run({ npmOutdated: JSON.stringify({ a: { current: "1", wanted: "2", latest: "2" }, b: { current: "1", wanted: "2", latest: "2" } }), rc: { "npm install -g a@2": 1, "npm install -g b@2": 1 } });
    expect(r.doc.failed).toEqual(["npm:a", "npm:b"]);
  });
  test("an npm timeout is one token, not the package twice", async () => {
    const r = await run({ npmOutdated: JSON.stringify({ tool: { current: "1.0.0", wanted: "1.1.0", latest: "1.1.0" } }), timeout: ["npm install -g tool@1.1.0"] });
    expect(r.doc.failed).toEqual(["timeout:npm"]);
  });
  test("a done notice that throws is a warning: the file is written and the rc stands", async () => {
    const r = await run(BREW, { cfg: { notify: ["send-notice"] }, throwOn: "send-notice" });
    expect(r.rc).toBe(0);
    expect(r.doc).toMatchObject({ ok: true, rc: 0 });
    expect(r.log.join("\n")).toContain("WARNING: the done notice failed (spawn failed)");
  });
  test("an npm ERROR status (the outdated query failed) is the token npm", async () => {
    const r = await run({ rc: { "npm outdated -g --json": 5 } });
    expect(r.rc).toBe(1);
    expect(r.doc).toMatchObject({ ok: false, rc: 1, failed: ["npm"] });
  });
  test("an npm hold reason that quotes FAILED or ERROR is a hold, not a failure: rc 0, failed []", async () => {
    const r = await run({ npmOutdated: JSON.stringify({ tool: { current: "1.0.0", wanted: "1.1.0", latest: "1.1.0" } }) }, { reply: "FLAG: postinstall prints FAILED and ERROR then runs curl" });
    expect(r.summary.join("\n")).toContain("FLAGGED — FLAG: postinstall prints FAILED and ERROR");
    expect(r.rc).toBe(0);
    expect(r.doc).toMatchObject({ ok: true, rc: 0, failed: [], held: ["tool"] });
  });
  test("npm and cask upgrades are in upgraded", async () => {
    const r = await run({ casks: "tfapp", caskTaps: { tfapp: "homebrew/cask" }, verbose: "tfapp (1) != 2", npmOutdated: JSON.stringify({ tool: { current: "1.0.0", wanted: "1.1.0", latest: "1.1.0" } }), lsof: ["COMMAND PID USER FD TYPE DEVICE SIZE NODE NAME\nlaunchd 1 root txt REG 1,4 1 2 /sbin/launchd\n"] });
    expect(r.doc.upgraded).toEqual(expect.arrayContaining(["tfapp", "tool"]));
  });
  test("a cask with a process running from it is held", async () => {
    const RUNNING = "COMMAND PID USER FD TYPE DEVICE SIZE NODE NAME\ngcloud 55 u txt REG 1,4 1 2 /brew/Caskroom/app/1.0/bin/gcloud\n";
    const r = await run({ casks: "app", caskTaps: { app: "homebrew/cask" }, verbose: "app (1.0) != 1.1", lsof: [RUNNING, "COMMAND PID USER FD TYPE DEVICE SIZE NODE NAME\n"] });
    expect(r.doc.held).toEqual(["app"]);
  });
  test("a linkage failure's note is in linkage", async () => {
    const r = await run({ ...BREW, answers: { "brew linkage --test good-a": { rc: 1, out: "==> Checking good-a linkage\nMissing libraries:\n  libx.dylib\n" } } });
    expect(r.doc.linkage).toContain("LINKAGE FAILED: good-a");
  });
  test("a run a signal stopped is not ok and says stopped, with the rc of the apply result", async () => {
    const r = await run(BREW, { apply: { isStopping: () => true, cliRc: () => 143 } });
    expect(r.doc).toMatchObject({ ok: false, rc: 143, stopped: true });
    expect((await run(BREW)).doc.stopped).toBeUndefined();
  });
  test("a broken log is rc 1, ok false, as the CLI exits", async () => {
    const r = await run(BREW, { apply: { cliRc: () => 1 } });
    expect(r.rc).toBe(0);
    expect(r.doc).toMatchObject({ ok: false, rc: 1 });
  });
  test("the file holds no config contents: a seeded notify token and a config value appear nowhere in its text", async () => {
    const r = await run(BREW, { cfg: { notify: ["send-notice", "SECRET-NOTIFY-TOKEN-9f3"], approvedTapsFile: "/conf.test/CONFIG-VALUE-7c1.tsv" } });
    expect(r.text).toBeDefined();
    expect(r.text).not.toContain("SECRET-NOTIFY-TOKEN-9f3");
    expect(r.text).not.toContain("CONFIG-VALUE-7c1");
    expect(Object.keys(r.doc).sort()).toEqual(["ended", "failed", "held", "host", "linkage", "log", "ok", "pid", "rc", "started", "upgraded", "version"]);
  });
});
