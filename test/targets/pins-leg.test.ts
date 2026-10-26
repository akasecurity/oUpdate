// The leg end to end over fakes: read at the base commit, discover, cooldown, artifact and diff review,
// branch and train ask on APPROVE only, and a summary line the digest reads right.
import { describe, expect, test } from "bun:test";
import type { OciSource } from "../../src/adapters/oci/registry.ts";
import type { ReviewResult } from "../../src/review.ts";
import type { Target } from "../../src/targets/model.ts";
import type { PinBumpLeg } from "../../src/targets/pins/config.ts";
import type { DatedRelease, GithubSource } from "../../src/targets/pins/github.ts";
import { pinBumpRunner, type NpmPayload, type PinLegDeps } from "../../src/targets/pins/leg.ts";
import { branchName } from "../../src/targets/pins/propose.ts";
import type { NpmSource } from "../../src/targets/pins/npm.ts";
import type { SnapshotSource } from "../../src/targets/pins/oci.ts";
import type { OpenReach } from "../../src/targets/reach.ts";
import { DIGEST_TROUBLE } from "../../src/targets/summary.ts";
import { scripted } from "../apply/helpers.ts";
import { fakeExec, gitArgs, gitRule, memFs, type Call } from "./fakes.ts";

const BASE = "a".repeat(40);
const OID = (c: string) => c.repeat(40);
const SRI = (c: string) => `sha512-${c.repeat(86)}==`;
const IMG = `sha256:${"c".repeat(64)}`;
const NOW = new Date("2026-10-25T12:00:00Z");
const OLD_PUB = "2026-10-01T00:00:00Z";
const PINS = `# sample pins\nCLI_VERSION=1.2.3\nCLI_INTEGRITY=${SRI("A")}\nTOOL_VERSION=2.0.0\nTOOL_SHA256_X64=${"b".repeat(64)}\nIMAGE_TAG=24.04\nIMAGE_DIGEST=${IMG}\nPROJECT=sample\nLATER=\n`;

const LEG: PinBumpLeg = {
  kind: "pin-bump", pinsPath: "img/pins.env", branchPrefix: "oupdate/", trainAskDir: "/asks", push: false, cooldownDays: 7,
  author: { name: "oupdate", email: "oupdate@invalid" },
  groups: [
    { source: "npm", name: "cli", package: "@scope/cli", versionKey: "CLI_VERSION", integrity: { CLI_INTEGRITY: "@scope/cli@{v}" }, propose: true },
    { source: "github-release", name: "tool", repo: "example/tool", tag: "v{v}", versionKey: "TOOL_VERSION", assets: { TOOL_SHA256_X64: "tool_{v}_linux_amd64.tar.gz" }, propose: true },
    { source: "oci-index", name: "image", registry: "docker-hub", repository: "library/sample", tagKey: "IMAGE_TAG", digestKey: "IMAGE_DIGEST", propose: true },
  ],
  fixed: ["PROJECT"], notChecked: { LATER: "no source yet" },
};
const TARGET: Target = { id: "lane-images", os: "linux", reach: { kind: "git", repo: "/repo", remote: "origin", base: "main" }, legs: [LEG], schedule: { every: "night" }, summaryTo: "/status/lane-images.tsv" };

interface Opts {
  pins?: string;
  showRc?: number;
  npmLatest?: string;
  npmPublished?: string;
  toolTag?: string;
  toolPropose?: boolean;
  exists?: boolean;
  answers?: string[];
  npmReview?: ReviewResult | Error;
  dryRun?: boolean;
  push?: boolean;
  pushRc?: number;
  /** The existing branch tip: its pins text, the files it changes, whether its parent is on the base. */
  tipText?: string;
  tipFiles?: string[];
  tipOnBase?: boolean;
  /** The cli group also pins a platform package's integrity (CLI_PLAT_X64). */
  platform?: boolean;
  /** With platform: the integrity map names only the platform package (CLI_INTEGRITY is then fixed). */
  onlyPlatform?: boolean;
  /** A per-package artifact review answer, ahead of npmReview. */
  npmReviewFor?: Record<string, ReviewResult | Error>;
}

function setup(o: Opts = {}) {
  const pins = o.pins ?? (o.platform ? `${PINS}CLI_PLAT_X64=${SRI("P")}\n` : PINS);
  const { exec, calls } = fakeExec([
    gitRule(["show", `${BASE}:img/pins.env`], { rc: o.showRc ?? 0, out: o.showRc ? "" : pins, err: o.showRc ? "fatal: path not in tree" : "" }),
    gitRule(["show-ref"], { rc: o.exists ? 0 : 1 }),
    gitRule(["ls-tree"], { out: `100644 blob ${OID("d")}\timg/pins.env\n` }),
    gitRule(["hash-object"], { out: OID("e") }),
    gitRule(["read-tree"], {}),
    gitRule(["update-index"], {}),
    gitRule(["write-tree"], { out: OID("f") }),
    gitRule(["commit-tree"], { out: OID("1") }),
    gitRule(["update-ref"], {}),
    gitRule(["rev-list"], { out: `${OID("1")} ${BASE}\n` }),
    gitRule(["merge-base"], { rc: o.tipOnBase === false ? 1 : 0 }),
    gitRule(["diff-tree"], { out: (o.tipFiles ?? ["img/pins.env"]).map((f) => `${f}\0`).join("") }),
    gitRule(["show", `${OID("1")}:img/pins.env`], { out: o.tipText ?? CLI_TEXT }),
    gitRule(["push"], { rc: o.pushRc ?? 0, err: o.pushRc ? "fatal: could not read from remote" : "" }),
  ]);
  const npm: NpmSource = {
    latest: async () => o.npmLatest ?? "1.2.3",
    publishedAt: async () => new Date(o.npmPublished ?? OLD_PUB),
    integrity: async (n, v) => (v !== (o.npmLatest ?? "1.2.3") ? undefined : n === "@scope/cli" ? SRI("N") : n === "@scope/cli-linux-x64" ? SRI("Q") : undefined),
  };
  const tag = o.toolTag ?? "v2.0.0";
  const v = tag.slice(1);
  const rel: DatedRelease = { tag_name: tag, prerelease: false, draft: false, published_at: OLD_PUB, assets: [{ name: `tool_${v}_linux_amd64.tar.gz`, browser_download_url: `https://github.com/example/tool/releases/download/${tag}/tool_${v}_linux_amd64.tar.gz`, digest: `sha256:${"9".repeat(64)}` }] };
  const github: GithubSource = { releases: async () => [rel] };
  const oci: OciSource = { index: async () => ({ digest: IMG, images: [], created: new Date(OLD_PUB) }) };
  const snapshot: SnapshotSource = { exists: async () => true };
  const rev = scripted(o.answers ?? ["APPROVE\nno attack indicators found"]);
  const npmReviews: string[] = [];
  const payloads: NpmPayload[] = [];
  const landed = (name: string, from: string, to: string): ReviewResult => ({ eco: "npm", name, from, to, decision: "land", layers: [] });
  const { fs, files } = memFs();
  const deps: PinLegDeps = {
    sources: { npm, github, oci, snapshot },
    reviewer: rev.r,
    reviewNpm: async (p) => {
      const { name, from, to } = p;
      npmReviews.push(`${name} ${from} ${to}`);
      payloads.push(p);
      const ans = o.npmReviewFor?.[name] ?? o.npmReview;
      if (ans instanceof Error) throw ans;
      return ans ?? landed(name, from, to);
    },
    fs, timeoutMs: 5000, tmpDir: "/tmp",
  };
  const plat = { CLI_PLAT_X64: "@scope/cli-linux-x64@{v}" };
  const base0 = o.platform
    ? { ...LEG, fixed: o.onlyPlatform ? [...LEG.fixed, "CLI_INTEGRITY"] : LEG.fixed, groups: LEG.groups.map((g) => (g.source === "npm" ? { ...g, integrity: o.onlyPlatform ? plat : { ...g.integrity, ...plat } } : g)) }
    : LEG;
  const base = o.toolPropose === false ? { ...base0, groups: base0.groups.map((g) => (g.name === "tool" ? { ...g, propose: false, note: "coupled" } : g)) } : base0;
  const leg = o.push ? { ...base, push: true } : base;
  const reach: OpenReach = { kind: "git", exec, repo: "/repo", remote: "origin", base: "main", baseSha: BASE };
  const run = () => pinBumpRunner(deps)(leg, { target: TARGET, reach, dryRun: o.dryRun ?? false, now: NOW });
  const verbs = () => calls.map((c: Call) => gitArgs(c)[0]);
  // run builds the runner from deps at call time, so dropReviewer takes effect on the next run.
  return { run, calls, verbs, files, prompts: rev.prompts, npmReviews, payloads, dropReviewer: () => { deps.reviewer = undefined; } };
}

// The train ask path of the cli 1.2.3 -> 1.2.4 bump (the branch name hashes the new file).
const CLI_TEXT = PINS.replace("CLI_VERSION=1.2.3", "CLI_VERSION=1.2.4").replace(`CLI_INTEGRITY=${SRI("A")}`, `CLI_INTEGRITY=${SRI("N")}`);
const CLI_BRANCH = branchName("oupdate/", CLI_TEXT);
const CLI_ASK = `/asks/lane-images-${CLI_BRANCH.replaceAll("/", "-")}.txt`;
/** The train ask a past run wrote for the branch: its Commit line is the APPROVE record of that tip. */
const ASK = (commit = OID("1")) => `oupdate train ask: lane-images\n\nBranch:   ${CLI_BRANCH}\nCommit:   ${commit} on origin/main ${BASE}\n`;
const VERIFY = ["rev-list", "merge-base", "diff-tree", "show"];

describe("pin-bump leg", () => {
  test("all current: no review, no branch", async () => {
    const s = setup();
    const r = await s.run();
    expect(r).toMatchObject({ summary: "pins current; not checked: 1 pin (see log)", trouble: false });
    expect(s.prompts).toHaveLength(0);
    expect(s.verbs()).toEqual(["show"]);
    expect(r.lines).toContain("not checked: LATER (no source yet)");
    expect(DIGEST_TROUBLE.test(r.summary)).toBe(false);
  });

  test("an npm bump past cooldown: artifact review, diff review, branch and train ask", async () => {
    const s = setup({ npmLatest: "1.2.4" });
    const r = await s.run();
    expect(r.trouble).toBe(false);
    expect(r.summary).toMatch(/^pins proposed oupdate\/pins-[0-9a-f]{12} \(cli 1\.2\.3→1\.2\.4\); not checked: 1 pin \(see log\)$/);
    expect(DIGEST_TROUBLE.test(r.summary)).toBe(false);
    expect(s.npmReviews).toEqual(["@scope/cli 1.2.3 1.2.4"]);
    expect(s.prompts[0]).toContain(`+CLI_INTEGRITY=${SRI("N")}`);
    const hash = s.calls.find((c) => gitArgs(c)[0] === "hash-object")!;
    expect(hash.stdin).toBe(PINS.replace("CLI_VERSION=1.2.3", "CLI_VERSION=1.2.4").replace(`CLI_INTEGRITY=${SRI("A")}`, `CLI_INTEGRITY=${SRI("N")}`));
    const branch = r.summary.split(" ")[2]!;
    expect(s.calls.find((c) => gitArgs(c)[0] === "update-ref")!.stdin).toBe(`create refs/heads/${branch} ${OID("1")}\n`);
    const ask = s.files.get(`/asks/lane-images-${branch.replaceAll("/", "-")}.txt`)!;
    expect(ask).toContain(`Branch:   ${branch}`);
    expect(ask).toContain("  cli: 1.2.3 -> 1.2.4");
    expect(s.verbs()).not.toContain("push");
  });

  test("a dry run reviews but writes no object, branch or train ask", async () => {
    const s = setup({ npmLatest: "1.2.4", dryRun: true });
    const r = await s.run();
    expect(r.summary).toMatch(/^pins would propose oupdate\/pins-[0-9a-f]{12} \(cli 1\.2\.3→1\.2\.4\)/);
    expect(s.prompts).toHaveLength(1);
    expect(s.verbs()).toEqual(["show", "show-ref"]);
    expect([...s.files.keys()]).toEqual([]);
    expect(DIGEST_TROUBLE.test(r.summary)).toBe(false);
  });

  test("a fresh release is held for cooldown, with no review", async () => {
    const s = setup({ npmLatest: "1.2.4", npmPublished: "2026-10-24T12:00:00Z" });
    const r = await s.run();
    expect(r.summary).toBe("pins nothing to propose; held: cli 1.2.4 (24.0 h old, cooldown 7 d); not checked: 1 pin (see log)");
    expect(r.trouble).toBe(false);
    expect(s.npmReviews).toHaveLength(0);
    expect(s.prompts).toHaveLength(0);
    expect(DIGEST_TROUBLE.test(r.summary)).toBe(false);
  });

  test("a FLAG on the pins diff is trouble and writes nothing", async () => {
    const s = setup({ npmLatest: "1.2.4", answers: ["FLAG\n+CLI_VERSION has no evidence"] });
    const r = await s.run();
    expect(r.trouble).toBe(true);
    expect(r.summary).toStartWith("pins FLAGGED by scripted (cli 1.2.3→1.2.4)");
    expect(s.verbs()).toEqual(["show", "show-ref"]);
  });

  test("an npm artifact review stop is FLAGGED; a review crash is an error", async () => {
    const stop: ReviewResult = { eco: "npm", name: "@scope/cli", from: "1.2.3", to: "1.2.4", decision: "hold", layers: [{ layer: "prepass", verdict: "stop", detail: "install-hook package.json" }] };
    const a = await setup({ npmLatest: "1.2.4", npmReview: stop }).run();
    expect(a).toMatchObject({ summary: "pins nothing to propose; FLAGGED: cli 1.2.4; not checked: 1 pin (see log)", trouble: true });
    const b = await setup({ npmLatest: "1.2.4", npmReview: new Error("download 503") }).run();
    expect(b).toMatchObject({ summary: "pins nothing to propose; error: cli (artifact review of @scope/cli@1.2.4: download 503); not checked: 1 pin (see log)", trouble: true });
  });

  // Review: the artifact review gets each changed tarball with the integrity the proposal pins for it.
  test("the artifact review covers every changed payload with its pinned integrity", async () => {
    const s = setup({ npmLatest: "1.2.4", platform: true });
    const r = await s.run();
    expect(r.trouble).toBe(false);
    expect(s.payloads).toEqual([
      { name: "@scope/cli", from: "1.2.3", to: "1.2.4", fromIntegrity: SRI("A"), toIntegrity: SRI("N") },
      { name: "@scope/cli-linux-x64", from: "1.2.3", to: "1.2.4", fromIntegrity: SRI("P"), toIntegrity: SRI("Q") },
    ]);
  });

  test("a platform package held by its review holds the whole group", async () => {
    const stop: ReviewResult = { eco: "npm", name: "@scope/cli-linux-x64", from: "1.2.3", to: "1.2.4", decision: "hold", layers: [{ layer: "prepass", verdict: "stop", detail: "new binary" }] };
    const s = setup({ npmLatest: "1.2.4", platform: true, npmReviewFor: { "@scope/cli-linux-x64": stop } });
    const r = await s.run();
    expect(r).toMatchObject({ summary: "pins nothing to propose; FLAGGED: cli 1.2.4; not checked: 1 pin (see log)", trouble: true });
    expect(s.prompts).toHaveLength(0);
    expect(s.verbs()).not.toContain("update-ref");
  });

  test("a main package not in the integrity map is still reviewed, with no integrity to check", async () => {
    const s = setup({ npmLatest: "1.2.4", platform: true, onlyPlatform: true });
    const r = await s.run();
    expect(r.trouble).toBe(false);
    expect(s.payloads).toEqual([
      { name: "@scope/cli", from: "1.2.3", to: "1.2.4" },
      { name: "@scope/cli-linux-x64", from: "1.2.3", to: "1.2.4", fromIntegrity: SRI("P"), toIntegrity: SRI("Q") },
    ]);
  });

  test("an unknown pin is trouble; the known groups still run", async () => {
    const s = setup({ pins: `${PINS}NEW_PIN=1\n`, npmLatest: "1.2.4" });
    const r = await s.run();
    expect(r.trouble).toBe(true);
    expect(r.summary).toContain("pins proposed oupdate/pins-");
    expect(r.summary).toContain("not checked: unknown pins NEW_PIN");
  });

  // Review Focus 2: the same bump twice is "already proposed": no review, no update-ref.
  test("an existing proposal branch is reported, not rewritten", async () => {
    const s = setup({ npmLatest: "1.2.4", exists: true });
    s.files.set(CLI_ASK, ASK());
    const r = await s.run();
    expect(r).toMatchObject({ trouble: false });
    expect(s.npmReviews).toHaveLength(0);
    expect(r.summary).toMatch(/^pins already proposed oupdate\/pins-[0-9a-f]{12} \(cli 1\.2\.3→1\.2\.4\)/);
    expect(s.prompts).toHaveLength(0);
    expect(s.verbs()).toEqual(["show", "show-ref", ...VERIFY]);
    expect(DIGEST_TROUBLE.test(r.summary)).toBe(false);
  });

  test("a newer value in a propose:false group is reported, not proposed, not trouble", async () => {
    const s = setup({ toolTag: "v2.1.0", toolPropose: false });
    const r = await s.run();
    expect(r).toMatchObject({ summary: "pins nothing to propose; newer, not proposed: tool 2.1.0 (coupled); not checked: 1 pin (see log)", trouble: false });
    expect(s.prompts).toHaveLength(0);
    expect(DIGEST_TROUBLE.test(r.summary)).toBe(false);
  });

  test("a pins file that cannot be read or parsed is not checked, with trouble", async () => {
    expect(await setup({ showRc: 128 }).run()).toMatchObject({ summary: "not checked — cannot read img/pins.env at origin/main", trouble: true });
    expect(await setup({ pins: "A=1\nnot a pin\n" }).run()).toMatchObject({ summary: "not checked — img/pins.env: pins line 2 is not KEY=value", trouble: true });
  });

  test("a group key missing from the file is an error for that group", async () => {
    const r = await setup({ pins: PINS.replace("TOOL_SHA256_X64", "TOOL_SHA_X64") }).run();
    expect(r.trouble).toBe(true);
    expect(r.summary).toContain("error: tool (missing TOOL_SHA256_X64)");
    expect(r.summary).toContain("not checked: unknown pins TOOL_SHA_X64");
  });

  test("no reviewer configured: an error, nothing written", async () => {
    const s = setup({ npmLatest: "1.2.4", answers: [] });
    s.dropReviewer();
    const r = await s.run();
    expect(r).toMatchObject({ trouble: true });
    expect(r.summary).toStartWith("pins review error: no reviewer configured (cli 1.2.3→1.2.4)");
    expect(s.verbs()).toEqual(["show", "show-ref"]);
  });
  // Final review: a repeat proposal must not hide a missing train ask or an unpushed branch.
  test("already proposed with no train ask on disk is trouble", async () => {
    const s = setup({ npmLatest: "1.2.4", exists: true });
    const r = await s.run();
    expect(r.trouble).toBe(true);
    expect(r.summary).toContain(`pins already proposed ${CLI_BRANCH}`);
    expect(r.summary).toContain(`error: train ask ${CLI_ASK} is missing`);
  });

  // Review: an existing branch is pushed only when it holds exactly this run's proposal and its APPROVE record.
  describe("an existing branch that is not this proposal is trouble and never pushed", () => {
    const cases: [string, Opts, string][] = [
      ["changed pins", { tipText: CLI_TEXT.replace("TOOL_VERSION=2.0.0", "TOOL_VERSION=6.6.6") }, "holds different pins than this run's proposal"],
      ["an unrelated file change", { tipFiles: ["img/pins.env", "img/build.sh"] }, "changes more than img/pins.env"],
      ["a parent off the base", { tipOnBase: false }, "is not on the base"],
    ];
    test.each(cases)("%s", async (_name, o, why) => {
      const s = setup({ npmLatest: "1.2.4", exists: true, push: true, ...o });
      s.files.set(CLI_ASK, ASK());
      const r = await s.run();
      expect(r.trouble).toBe(true);
      expect(r.summary).toStartWith(`pins error: branch ${CLI_BRANCH} exists but tip ${OID("1").slice(0, 12)} ${why}; not pushed`);
      expect(DIGEST_TROUBLE.test(r.summary)).toBe(true);
      expect(s.verbs()).not.toContain("push");
      expect(s.npmReviews).toHaveLength(0);
    });

    test("a missing approval record (train ask)", async () => {
      const s = setup({ npmLatest: "1.2.4", exists: true, push: true });
      const r = await s.run();
      expect(r.trouble).toBe(true);
      expect(r.summary).toContain(`error: train ask ${CLI_ASK} is missing, not pushed`);
      expect(s.verbs()).not.toContain("push");
    });

    test("a train ask that records another commit", async () => {
      const s = setup({ npmLatest: "1.2.4", exists: true, push: true });
      s.files.set(CLI_ASK, ASK(OID("2")));
      const r = await s.run();
      expect(r.trouble).toBe(true);
      expect(r.summary).toContain(`records ${OID("2").slice(0, 12)}, not the branch tip ${OID("1").slice(0, 12)}; not pushed`);
      expect(s.verbs()).not.toContain("push");
    });
  });

  test("already proposed with push on pushes the branch again; a failed push is trouble", async () => {
    const ok = setup({ npmLatest: "1.2.4", exists: true, push: true });
    ok.files.set(CLI_ASK, ASK());
    expect(await ok.run()).toMatchObject({ trouble: false });
    expect(gitArgs(ok.calls.at(-1)!)).toEqual(["push", "--porcelain", "origin", `refs/heads/${CLI_BRANCH}:refs/heads/${CLI_BRANCH}`]);
    const bad = setup({ npmLatest: "1.2.4", exists: true, push: true, pushRc: 128 });
    bad.files.set(CLI_ASK, ASK());
    const r = await bad.run();
    expect(r.trouble).toBe(true);
    expect(r.summary).toContain("error: push failed (rc 128: fatal: could not read from remote)");
    expect(bad.npmReviews).toHaveLength(0);
    expect(bad.prompts).toHaveLength(0);
  });
});
