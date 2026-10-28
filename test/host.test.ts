import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseBrewInfo, parseBrewOutdated, parseNpmLs, parseNpmOutdated, parseDockerImages, parseSwVers, parseSoftwareUpdate, parseCliVersions } from "../src/host/collect.ts";
import { parsePrevSummary } from "../src/host/prev-log.ts";
import { compareRun, weeklyStreak } from "../src/host/compare.ts";
import { hostReport, type RawProbe } from "../src/host/report.ts";

const dir = join(import.meta.dir, "fixtures", "host");
const fx = (f: string) => readFileSync(join(dir, f), "utf8");

describe("collect parsers", () => {
  test("brew info: formulae and casks by full name, installed version, no paths", () => {
    const items = parseBrewInfo(fx("brew-info.json"));
    expect(items.find((i) => i.name === "example/svc/svc")).toEqual({ kind: "brew-formula", name: "example/svc/svc", version: "HEAD-a435a37" });
    expect(items.find((i) => i.name === "brotli")?.version).toBe("1.2.0");
    expect(items.filter((i) => i.kind === "brew-cask").length).toBe(2);
    expect(items.find((i) => i.name === "example-app")?.version).toBe("1.4.4,4783783166214144");
  });
  test("brew outdated: installed and current", () => {
    expect(parseBrewOutdated(fx("brew-outdated.json"))).toEqual([
      { kind: "brew-formula", name: "brotli", installed: "1.2.0", current: "1.2.0_1", pinned: false },
      { kind: "brew-formula", name: "example/svc/svc", installed: "HEAD-a435a37", current: "HEAD", pinned: false },
    ]);
  });
  test("npm globals and outdated", () => {
    expect(parseNpmLs(fx("npm-ls.json"))).toEqual([{ kind: "npm-global", name: "npm", version: "12.2.0" }]);
    expect(parseNpmOutdated(fx("npm-outdated.json"))).toEqual([{ kind: "npm-global", name: "npm", installed: "12.2.0", current: "12.2.1", pinned: false }]);
    expect(parseNpmLs("")).toEqual([]);
    expect(parseNpmOutdated("")).toEqual([]);
  });
  test("docker images: repo:tag at digest", () => {
    const d = parseDockerImages(fx("docker.jsonl"));
    expect(d[0]).toEqual({ kind: "docker-image", name: "python:3.13-slim", version: "sha256:cf50a4f6ac4f026458b08d5222023d700ac806410dff5e9ca8728fa44f2b850f" });
  });
  test("sw_vers and softwareupdate", () => {
    expect(parseSwVers(fx("sw_vers.txt"))).toEqual({ kind: "macos", name: "macOS", version: "27.0.1 (26A434)" });
    expect(parseSoftwareUpdate(fx("softwareupdate.txt"))).toEqual([]);
    const pending = "Software Update Tool\n\nFinding available software\nSoftware Update found the following new or updated software:\n* Label: macOS Tahoe 27.0.2-26A500\n\tTitle: macOS Tahoe, Version: 27.0.2, Size: 1234KiB, Recommended: YES, Action: restart,\n";
    expect(parseSoftwareUpdate(pending)).toEqual([{ kind: "macos", name: "macOS Tahoe 27.0.2-26A500", installed: "", current: "27.0.2", pinned: false }]);
  });
  test("cli versions: first version-looking token; a missing cli is skipped", () => {
    expect(parseCliVersions(fx("clis.txt"))).toEqual([
      { kind: "cli", name: "claude", version: "2.1.306" },
      { kind: "cli", name: "codex", version: "0.163.0" },
      { kind: "cli", name: "grok", version: "1.0.62" },
      { kind: "cli", name: "agy", version: "1.4.4" },
    ]);
  });
});

describe("previous updater summary", () => {
  test("last summary block of the host, with the run date", () => {
    const s = parsePrevSummary(fx("prev.log"), "hosta")!;
    expect(s.date).toBe("2026-10-21");
    expect(s.brew.upgraded).toEqual(["ca-certificates", "docker", "llvm", "example-tool", "python@3.11", "python@3.15", "example-net", "example-app"]);
    expect(s.brew.stuck).toEqual(["example/svc/svc"]);
    expect(s.npm.upgraded).toEqual([]);
    expect(s.npm.claudeCode).toBe("2.1.101");
    expect(s.aborted).toBe(false);
  });
  test("flagged taps, failed formulae and casks, an aborted run", () => {
    const log = [
      "=== host-update hostb 2026-10-20 07:00 ===",
      "=== hostb summary ===",
      "  brew: FAILED (rc=1); FAILED: example-app ; FLAGGED — awaiting tap approval: example/tf (terraform 1.16.5→1.16.6, review: APPROVE (formula-only, prebuilt)) — approve a tap by adding it to approved-taps.tsv; upgraded: c-ares go; casks upgraded: gcloud-cli; casks FAILED: example-app; STUCK: example/tf/terraform=1.16.6(7 runs, since 2026-10-14) ; STALE KEG: node still running from a deleted keg [node(6 runs, since 2026-10-15) ]",
      "  npm:  upgraded: npm; claude-code: 2.1.304",
      "  mas:  n/a — mas not installed",
      "=== ABORTED: host-update on hostb exited 1 — this run did NOT complete ===",
    ].join("\n");
    const s = parsePrevSummary(log, "hostb")!;
    expect(s.brew.upgraded).toEqual(["c-ares", "go", "gcloud-cli"]);
    expect(s.brew.failed).toEqual(["example-app"]);
    expect(s.brew.flagged).toEqual(["terraform"]);
    expect(s.brew.stuck).toEqual(["example/tf/terraform"]);
    expect(s.npm.upgraded).toEqual(["npm"]);
    expect(s.aborted).toBe(true);
  });
  test("PINNED: a repo pin is held; a brew pin is left to the pinned flag", () => {
    const log = ["=== host-update hostd 2026-10-23 07:00 ===", "=== hostd summary ===", "  brew: upgraded: uv; PINNED: duckdb(example-repo) ripgrep(brew pin) brave-browser(example-browser-repo)", "  npm:  nothing to update"].join("\n");
    expect(parsePrevSummary(log, "hostd")!.brew.pinned).toEqual(["duckdb", "brave-browser"]);
  });
  test("a host-named script header (=== x-host-update host date) gives the date too", () => {
    const log = ["=== hostc-host-update hostc 2026-10-21 07:00 ===", "=== hostc summary ===", "  brew: upgraded: uv", "  npm:  nothing to update", "[notify] hostc host-update done"].join("\n");
    expect(parsePrevSummary(log, "hostc")?.date).toBe("2026-10-21");
  });
  test("npm FLAGGED holds the whole pending batch; FAILED names the package", () => {
    const flag = ["=== host-update hostd 2026-10-22 07:00 ===", "=== hostd summary ===", "  brew: upgraded: node", "  npm:  FLAGGED — reviewer unavailable; claude-code: 2.1.308"].join("\n");
    expect(parsePrevSummary(flag, "hostd")!.npm).toEqual({ upgraded: [], flagged: true, failed: [], claudeCode: "2.1.308" });
    const wide = ["=== host-update hostd 2026-10-22 07:00 ===", "=== hostd summary ===", "  npm:        FLAGGED — reviewer unavailable"].join("\n");
    expect(parsePrevSummary(wide, "hostd")!.npm.flagged).toBe(true);
    const fail = ["=== host-update hostd 2026-10-22 07:00 ===", "=== hostd summary ===", "  npm:  FAILED — agent-browser; claude-code: 2.1.308"].join("\n");
    expect(parsePrevSummary(fail, "hostd")!.npm).toEqual({ upgraded: [], flagged: false, failed: ["agent-browser"], claudeCode: "2.1.308" });
  });
  test("claude-code: a version, the previous updater's FAILED (rc, on ver) and oupdate's FAILED (timeout, on ver)", () => {
    // Mutant caught: a FAILED claude-code part read as fine (no claudeCodeFailed), or "unknown" kept as a version.
    const npm = (part: string) => parsePrevSummary(["=== host-update hostd 2026-10-22 07:00 ===", "=== hostd summary ===", `  npm:  nothing to update; ${part}`].join("\n"), "hostd")!.npm;
    expect(npm("claude-code: 2.1.309")).toEqual({ upgraded: [], flagged: false, failed: [], claudeCode: "2.1.309" });
    expect(npm("claude-code: FAILED (rc=1, on 2.1.308)")).toEqual({ upgraded: [], flagged: false, failed: [], claudeCode: "2.1.308", claudeCodeFailed: true });
    expect(npm("claude-code: FAILED (rc=1, on unknown)")).toEqual({ upgraded: [], flagged: false, failed: [], claudeCodeFailed: true });
    expect(npm("claude-code: FAILED (timeout, on 2.1.308)")).toMatchObject({ claudeCode: "2.1.308", claudeCodeFailed: true });
    expect(npm("claude-code: not configured").claudeCode).toBeUndefined();
  });
  test("a Type B FLAG and a CASK_EXCLUDE in the run body are held too (the summary line leaves them out)", () => {
    const log = [
      "=== host-update hostd 2026-10-21 07:00 ===",
      "[notify] ⚠️ hostd Type B FLAG — oldpkg (formula)",
      "=== hostd summary ===",
      "  brew: upgraded: uv",
      "=== host-update hostd 2026-10-22 07:00 ===",
      "  excluding zoom (CASK_EXCLUDE — self-updates / too heavy to reinstall)",
      "[notify] ⚠️ hostd Type B FLAG — terraform (formula)",
      "[advisory — not notified] ⚠️ hostd Type B FLAG — svc",
      "=== hostd summary ===",
      "  brew: upgraded: uv; FLAGGED — awaiting tap approval: example/tap (gadget 1.3.0→1.4.0, review: FLAG (formula-only, prebuilt)) — approve a tap",
      "  npm:  nothing to update",
    ].join("\n");
    const b = parsePrevSummary(log, "hostd")!.brew;
    expect(b.flagged).toEqual(["gadget", "terraform", "svc"]);
    expect(b.excluded).toEqual(["zoom"]);
  });
  test("a dry run or one-off logged after the run never stands in for it (slice 7 re-review)", () => {
    // Mutant caught: the forward scan stopped only at a previous updater header, so a later dry run's
    // brew/npm lines replaced the run's (FAILED: foo then a dry run parsed as failed: []).
    const log = [
      "=== oupdate-host-update hostd 2026-10-22 07:00 ===",
      "",
      "=== hostd summary ===",
      "  brew: FAILED: foo; upgraded: uv",
      "  npm:  FAILED — bar",
      "=== oupdate dry run hostd 2026-10-22 09:00 ===",
      "",
      "=== hostd dry-run summary (nothing applied) ===",
      "  brew: dry-run OK",
      "  npm:  dry-run OK",
      "=== STOPPED: oupdate dry run on hostd got SIGINT — not a run, nothing more was done ===",
    ].join("\n");
    const s = parsePrevSummary(log, "hostd")!;
    expect(s.brew.failed).toEqual(["foo"]);
    expect(s.brew.upgraded).toEqual(["uv"]);
    expect(s.npm.failed).toEqual(["bar"]);
    expect(s.aborted).toBe(false);
  });
  test("no summary for the host: null", () => {
    expect(parsePrevSummary(fx("prev.log"), "other")).toBeNull();
  });
});

describe("compare", () => {
  const summary = { date: "2026-10-21", brew: { upgraded: ["uv", "example-app"], failed: [], flagged: ["terraform"], stuck: ["example/svc/svc"] }, npm: { upgraded: [] as string[] }, aborted: false };
  const prev = [
    { kind: "brew-formula" as const, name: "uv", version: "1.0" },
    { kind: "brew-cask" as const, name: "example-app", version: "1.4.3" },
    { kind: "brew-formula" as const, name: "abseil", version: "1" },
  ];
  const cur = [
    { kind: "brew-formula" as const, name: "uv", version: "1.1" },
    { kind: "brew-cask" as const, name: "example-app", version: "1.4.4" },
    { kind: "brew-formula" as const, name: "abseil", version: "1" },
  ];
  test("agree when changed = upgraded and outdated = held", () => {
    const outdated = [
      { kind: "brew-formula" as const, name: "example/tf/terraform", installed: "1.16.5", current: "1.16.6", pinned: false },
      { kind: "brew-formula" as const, name: "example/svc/svc", installed: "HEAD-a", current: "HEAD", pinned: false },
    ];
    const c = compareRun({ prev, cur, outdated, summary });
    expect(c.agree).toBe(true);
    expect(c.upgraded).toEqual({ baseline: true, onlyInventory: [], onlyPrevious: [] });
    expect(c.held).toEqual({ onlyInventory: [], onlyPrevious: [] });
  });
  test("disagree: an outdated package the previous updater did not hold, a claimed upgrade with no version change", () => {
    const outdated = [{ kind: "brew-formula" as const, name: "brotli", installed: "1.2.0", current: "1.2.0_1", pinned: false }];
    const c = compareRun({ prev, cur: prev, outdated, summary });
    expect(c.agree).toBe(false);
    expect(c.upgraded.onlyPrevious).toEqual(["example-app", "uv"]);
    expect(c.held.onlyInventory).toEqual(["brotli"]);
    expect(c.held.onlyPrevious).toEqual(["example/svc/svc", "terraform"]);
  });
  test("a package a repo pins is held: the previous updater reports it PINNED, so outdated agrees", () => {
    const outdated = [{ kind: "brew-formula" as const, name: "duckdb", installed: "1.5.5", current: "2.0.0", pinned: false }];
    const c = compareRun({ prev, cur, outdated, summary: { ...summary, brew: { ...summary.brew, flagged: [], stuck: [], pinned: ["duckdb"] } } });
    expect(c.held).toEqual({ onlyInventory: [], onlyPrevious: [] });
  });
  test("a pinned outdated package is expected, not a disagreement", () => {
    const outdated = [{ kind: "brew-formula" as const, name: "brotli", installed: "1", current: "2", pinned: true }];
    const c = compareRun({ prev, cur, outdated, summary: { ...summary, brew: { ...summary.brew, flagged: [], stuck: [] } } });
    expect(c.held.onlyInventory).toEqual([]);
  });
  test("npm FLAGGED: every outdated npm global is held; FAILED holds the named one", () => {
    const outdated = [{ kind: "npm-global" as const, name: "npm", installed: "11.20.0", current: "12.2.1", pinned: false }];
    const base = { ...summary, brew: { ...summary.brew, flagged: [], stuck: [] } };
    expect(compareRun({ prev, cur, outdated, summary: { ...base, npm: { upgraded: [], flagged: true, failed: [] } } }).held).toEqual({ onlyInventory: [], onlyPrevious: [] });
    expect(compareRun({ prev, cur, outdated, summary: { ...base, npm: { upgraded: [], flagged: false, failed: ["npm"] } } }).held).toEqual({ onlyInventory: [], onlyPrevious: [] });
    expect(compareRun({ prev, cur, outdated, summary: base }).held.onlyInventory).toEqual(["npm"]);
  });
  test("a brew node upgrade explains a changed npm global (the node bottle ships its own npm)", () => {
    const p = [...prev, { kind: "brew-formula" as const, name: "node", version: "25.1" }, { kind: "npm-global" as const, name: "npm", version: "12.0.2" }];
    const c2 = [...cur, { kind: "brew-formula" as const, name: "node", version: "25.2" }, { kind: "npm-global" as const, name: "npm", version: "11.20.0" }];
    const base = { ...summary, brew: { ...summary.brew, flagged: [], stuck: [] } };
    expect(compareRun({ prev: p, cur: c2, outdated: [], summary: { ...base, brew: { ...base.brew, upgraded: [...base.brew.upgraded, "node"] } } }).upgraded.onlyInventory).toEqual([]);
    // without a node upgrade the npm change stays unexplained (node is then also unexplained)
    expect(compareRun({ prev: p, cur: c2, outdated: [], summary: base }).upgraded.onlyInventory).toEqual(["node", "npm"]);
  });
  test("an excluded cask is held", () => {
    const outdated = [{ kind: "brew-cask" as const, name: "zoom", installed: "6.1", current: "6.2", pinned: false }];
    const c = compareRun({ prev, cur, outdated, summary: { ...summary, brew: { ...summary.brew, flagged: [], stuck: [], excluded: ["zoom"] } } });
    expect(c.held).toEqual({ onlyInventory: [], onlyPrevious: [] });
  });
  test("first run: no baseline, upgrade side skipped", () => {
    const c = compareRun({ prev: undefined, cur, outdated: [], summary: { ...summary, brew: { ...summary.brew, flagged: [], stuck: [] } } });
    expect(c.upgraded.baseline).toBe(false);
    expect(c.agree).toBe(true);
  });
  test("weekly streak: consecutive ISO weeks whose every report agreed, ending at the latest week", () => {
    const r = (date: string, agree: boolean) => ({ date, agree });
    expect(weeklyStreak([r("2026-10-05", true), r("2026-10-12", true), r("2026-10-14", true), r("2026-10-19", true)])).toBe(3);
    expect(weeklyStreak([r("2026-10-12", true), r("2026-10-13", false), r("2026-10-19", true)])).toBe(1);
    expect(weeklyStreak([r("2026-10-05", true), r("2026-10-19", true)])).toBe(1);
    expect(weeklyStreak([])).toBe(0);
  });
  test("weekly streak: a seed run with no baseline neither agrees nor disagrees", () => {
    const r = (date: string, agree: boolean, baseline: boolean) => ({ date, agree, baseline });
    // the 10-21 seed differed only for lack of a snapshot; the 10-22 run agreed
    expect(weeklyStreak([r("2026-10-21", false, false), r("2026-10-22", true, true)])).toBe(1);
    expect(weeklyStreak([r("2026-10-21", false, false)])).toBe(0);
    expect(weeklyStreak([r("2026-10-14", true, true), r("2026-10-21", false, false), r("2026-10-22", false, true)])).toBe(0);
  });
});

describe("hostReport", () => {
  const raw: RawProbe = {
    brewInfo: fx("brew-info.json"), brewOutdated: fx("brew-outdated.json"), npmLs: fx("npm-ls.json"), npmOutdated: fx("npm-outdated.json"),
    docker: fx("docker.jsonl"), swVers: fx("sw_vers.txt"), softwareUpdate: fx("softwareupdate.txt"), clis: fx("clis.txt"),
  };
  test("inventory, outdated, advisories for npm globals, comparison against the previous updater block", async () => {
    const queried: string[] = [];
    const feed = { query: async (pkgs: { ecosystem: string; name: string; version: string }[]) => { queried.push(...pkgs.map((p) => `${p.ecosystem}:${p.name}@${p.version}`)); return []; } };
    const r = await hostReport({ host: "hosta", raw, prevLog: fx("prev.log"), prev: undefined, feed, now: new Date("2026-10-21T20:00:00Z") });
    expect(queried).toEqual(["npm:npm@12.2.0"]);
    expect(r.date).toBe("2026-10-21");
    expect(r.inventory.some((i) => i.kind === "macos")).toBe(true);
    expect(r.compare?.held.onlyInventory).toEqual(["brotli", "npm"]);
    expect(r.compare?.agree).toBe(false);
    expect(JSON.stringify(r)).not.toMatch(/\/opt\/|\/Users|\/home/);
  });
  test("no previous updater block: compare is null and the report says so", async () => {
    const r = await hostReport({ host: "otherhost", raw, prevLog: "", prev: undefined, feed: { query: async () => [] }, now: new Date("2026-10-21T20:00:00Z") });
    expect(r.compare).toBeNull();
    expect(r.notes).toContain("no host-update summary for otherhost");
  });
  test("a failed advisory lookup is a note, never 'no advisories'", async () => {
    const r = await hostReport({ host: "hosta", raw, prevLog: fx("prev.log"), prev: undefined, feed: { query: async () => { throw new Error("osv 503"); } }, now: new Date() });
    expect(r.advisories).toBeNull();
    expect(r.notes.join(" ")).toMatch(/advisory lookup failed: osv 503/);
  });
});
