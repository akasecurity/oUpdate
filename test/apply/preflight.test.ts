// OUP-302 phase 1a: the pre-flight (disk free on the brew prefix, DNS/registry probes) is REPORT ONLY.
// A dry run prints what it would refuse; a real run never refuses and never runs the probes.
// Only exec is stubbed (fakeHost); preflight() and applyHost() are real.
import { describe, expect, test } from "bun:test";
import { applyHost } from "../../src/apply/run.ts";
import { PREFLIGHT_MIN_FREE_GIB, preflight } from "../../src/apply/preflight.ts";
import { fakeHost, fakeTypeB, testConfig } from "./host-fixture.ts";

const DF = (gib: number) => ({ rc: 0, out: `Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/d1 971350180 1 ${gib * 1048576} 89% /System/Volumes/Data\n` });
const CURL = (u: string) => `curl -q -g -sS -o /dev/null -I -m 10 -w %{http_code} -- ${u}`;
const ok = { [CURL("https://registry.npmjs.org/")]: { rc: 0, out: "200" }, [CURL("https://formulae.brew.sh/")]: { rc: 0, out: "200" } };

describe("preflight", () => {
  test("enough disk and both probes answering: nothing it would refuse", async () => {
    const h = fakeHost({ answers: { "df -k -- /brew": DF(50), ...ok } });
    const p = await preflight(testConfig(), h.exec);
    expect(p.wouldRefuse).toEqual([]);
    expect(p.lines).toContain("preflight: disk 50.0 GiB free on /brew");
  });
  test("disk under the threshold is a would-refuse reason that names the threshold", async () => {
    const h = fakeHost({ answers: { "df -k -- /brew": DF(PREFLIGHT_MIN_FREE_GIB - 1), ...ok } });
    const p = await preflight(testConfig(), h.exec);
    expect(p.wouldRefuse).toEqual([`disk ${PREFLIGHT_MIN_FREE_GIB - 1}.0 GiB free on /brew, under ${PREFLIGHT_MIN_FREE_GIB} GiB`]);
  });
  test("a failed probe (DNS rc 6) is a would-refuse reason; a disk that cannot be read is said, never passed", async () => {
    const h = fakeHost({ answers: { "df -k -- /brew": { rc: 1, out: "" }, ...ok, [CURL("https://formulae.brew.sh/")]: { rc: 6, out: "" } } });
    const p = await preflight(testConfig(), h.exec);
    expect(p.wouldRefuse).toEqual(["disk not read (df -k -- /brew rc 1)", "https://formulae.brew.sh not reached (rc 6, DNS)"]);
  });
});

describe("what is handed to a command", () => {
  test("a registry URL with credentials or a non-http scheme is never probed, and the password is never printed", async () => {
    for (const reg of [`https://user:s3cret${"@"}registry.example`, "-o/tmp/x", "ftp://registry.example"]) {
      const h = fakeHost({ answers: { "df -k -- /brew": DF(50), ...ok } });
      const p = await preflight(testConfig({ npmRegistry: reg }), h.exec);
      expect(p.wouldRefuse.some((w) => w.startsWith("registry URL not probed"))).toBe(true);
      expect(p.lines.join("\n")).not.toContain("s3cret");
      expect(h.calls.filter((c) => c.startsWith("curl ") && (c.includes("s3cret") || c.includes("-o/tmp/x") || c.includes("ftp:")))).toEqual([]);
    }
  });
  test("curl runs with -q and -- before the URL; a brew prefix not starting with / is not given to df", async () => {
    const h = fakeHost({ answers: { "df -k -- /brew": DF(50), ...ok } });
    await preflight(testConfig(), h.exec);
    expect(h.calls.filter((c) => c.startsWith("curl ")).every((c) => c.startsWith("curl -q ") && / -- https:\/\//.test(c))).toBe(true);
    const h2 = fakeHost({ answers: { "brew --prefix": { rc: 0, out: "-x\n" }, ...ok } });
    const p = await preflight(testConfig(), h2.exec);
    expect(h2.calls.filter((c) => c.startsWith("df "))).toEqual([]);
    expect(p.wouldRefuse[0]).toContain("disk not read");
  });
});

describe("the limits and the exact edges", () => {
  test("exactly the threshold is not a would-refuse (< not <=); a hair under it is", async () => {
    const at = await preflight(testConfig(), fakeHost({ answers: { "df -k -- /brew": DF(PREFLIGHT_MIN_FREE_GIB), ...ok } }).exec);
    expect(at.wouldRefuse).toEqual([]);
    const under = await preflight(testConfig(), fakeHost({ answers: { "df -k -- /brew": { rc: 0, out: `h\n/dev/d 1 1 ${PREFLIGHT_MIN_FREE_GIB * 1048576 - 1} 1% /\n` }, ...ok } }).exec);
    expect(under.wouldRefuse.length).toBe(1);
  });
  test("a username alone in the URL is a credential: not probed", async () => {
    const h = fakeHost({ answers: { "df -k -- /brew": DF(50), ...ok } });
    const p = await preflight(testConfig({ npmRegistry: `https://token${"@"}registry.example` }), h.exec);
    expect(p.wouldRefuse).toContain("registry URL not probed (it carries credentials)");
    expect(h.calls.some((c) => c.includes("registry.example"))).toBe(false);
  });
  test("a URL with a query or a fragment is not probed; the probe is given the parsed href and -g", async () => {
    for (const reg of ["https://registry.example/?_authToken=SECRET", "https://registry.example/#x", "https://registry.example/[1-3]"]) {
      const h = fakeHost({ answers: { "df -k -- /brew": DF(50), ...ok } });
      const p = await preflight(testConfig({ npmRegistry: reg }), h.exec);
      expect(p.wouldRefuse.some((w) => w.startsWith("registry URL not probed"))).toBe(true);
      expect(h.calls.some((c) => c.includes("SECRET") || c.includes("registry.example"))).toBe(false);
      expect(p.lines.join("\n")).not.toContain("SECRET");
    }
    const h = fakeHost({ answers: { "df -k -- /brew": DF(50), ...ok } });
    await preflight(testConfig({ npmRegistry: "https://registry.npmjs.org" }), h.exec);
    expect(h.calls).toContain(CURL("https://registry.npmjs.org/"));
  });
  test("each command has its own short bound and none is soft; a timeout is a would-refuse reason, never a pass", async () => {
    const h = fakeHost({ answers: { "df -k -- /brew": DF(50) }, timeout: ["curl "] });
    const p = await preflight(testConfig({ timeoutMs: 45 * 60_000 }), h.exec);
    const probes = h.callOpts.filter((c) => /^(brew --prefix$|df |curl )/.test(c.line));
    expect(probes.length).toBe(4);
    expect(probes.every((c) => c.opts?.timeoutMs !== undefined && c.opts.timeoutMs <= 15_000 && !c.opts.soft)).toBe(true);
    expect(p.wouldRefuse.length).toBe(2);
  });
});

describe("the apply run", () => {
  test("probes that time out do not change what a dry run reports for Type B (they never feed the time-box counter)", async () => {
    const T = "\t";
    const script = { files: { "/conf.test/approved-taps.tsv": `example/wm${T}*${T}2026-09-28${T}fixture\n` }, formulas: "wm wn", verbose: "example/wm/wm (0.1.0) < 0.2.0\nexample/wm/wn (0.1.0) < 0.2.0", formulaTaps: { wm: "example/wm", wn: "example/wm" }, answers: { "df -k -- /brew": DF(50), ...ok } };
    const go = async (timeout: string[]) => {
      const h = fakeHost({ ...script, timeout });
      const tb = fakeTypeB(0);
      const r = await applyHost(testConfig({ approvedTapsFile: "/conf.test/approved-taps.tsv" }), h.exec, h.fs, { dryRun: true, typeB: tb.typeB });
      return { seen: tb.seen, text: [...r.log, ...r.summary].filter((l) => !l.includes("preflight")).join("\n") };
    };
    const quiet = await go([]);
    const slow = await go(["curl "]);
    expect(quiet.seen.length).toBeGreaterThan(0);
    expect(slow.seen).toEqual(quiet.seen);
    expect(slow.text).not.toContain("time box");
    expect(slow.text.replace(/\(http [^)]*\)/g, "")).toEqual(quiet.text.replace(/\(http [^)]*\)/g, ""));
  });
  test("a dry run prints the pre-flight report and still ends dry-run OK when it would refuse", async () => {
    const h = fakeHost({ answers: { "df -k -- /brew": DF(1), ...ok } });
    const r = await applyHost(testConfig(), h.exec, h.fs, { dryRun: true });
    const t = r.log.join("\n");
    expect(t).toContain("dry-run: preflight (report only, nothing is refused): would refuse — disk 1.0 GiB free on /brew, under 10 GiB");
    expect(r.rc).toBe(0);
    expect(h.writes).toEqual([]);
  });
  test("a dry run with skipPreflight (host --readiness, which reads df and the registry itself) makes no pre-flight call and prints no pre-flight line", async () => {
    const h = fakeHost({ answers: { "df -k -- /brew": DF(1), ...ok } });
    const r = await applyHost(testConfig(), h.exec, h.fs, { dryRun: true, skipPreflight: true });
    expect(h.calls.filter((c) => /^(df|curl) /.test(c))).toEqual([]);
    expect(r.log.join("\n")).not.toContain("preflight");
  });
  test("a real run neither probes nor refuses: no df or curl, and the upgrade still runs on a full disk", async () => {
    const h = fakeHost({ formulas: "good-a", verbose: "good-a (1.0) < 1.1", formulaTaps: { "good-a": "homebrew/core" }, answers: { "df -k -- /brew": DF(1), ...ok } });
    const r = await applyHost(testConfig(), h.exec, h.fs, { dryRun: false });
    expect(h.calls.filter((c) => /^(df|curl) /.test(c))).toEqual([]);
    expect(h.calls).toContain("brew upgrade good-a");
    expect(r.log.join("\n")).not.toContain("preflight");
  });
});
