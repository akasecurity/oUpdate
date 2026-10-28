// The runner: due targets only, every reach opened, unbuilt reaches and legs reported with trouble,
// one tsv per target (none on a dry run), and the run log.
import { describe, expect, test } from "bun:test";
import type { TargetsConfig } from "../../src/targets/config.ts";
import type { Target } from "../../src/targets/model.ts";
import type { PinBumpLeg } from "../../src/targets/pins/config.ts";
import { runTargets, type LegRunner } from "../../src/targets/run.ts";
import { TROUBLE_WORDS } from "../../src/targets/summary.ts";
import { makeRegistry } from "../../src/targets/registry.ts";
import { A, ans, evidenceRows, fakeReviewer, targetExec, RUN, TEST_REACH, testRegistry, X } from "./fake-broker.ts";
import { fakeClock, GCE_REACH, gceExec, inventory, VM_A, VM_B } from "./fake-gce.ts";
import { fakeExec, gitRule, memFs } from "./fakes.ts";

const SHA = "a".repeat(40);
const NOW = new Date(2026, 9, 25, 4, 10); // a Sunday
const PIN_LEG: PinBumpLeg = { kind: "pin-bump", pinsPath: "img/pins.env", branchPrefix: "oupdate/", proposalDir: "/asks", push: false, cooldownDays: 7, author: { name: "oupdate", email: "oupdate@invalid" }, groups: [], fixed: [], notChecked: {} };
const LANE: Target = { id: "images", os: "linux", reach: { kind: "git", repo: "/repo", remote: "origin", base: "main" }, legs: [PIN_LEG], schedule: { every: "week", day: 0 }, summaryTo: "/status/images.tsv" };
const BOX: Target = { id: "host-b", os: "linux", reach: { kind: "vm-agent", vm: "vm-one", agent: "agent-one" }, legs: [{ kind: "docker-compose", apply: false, prune: true }], schedule: { every: "night" }, summaryTo: "/status/host-b.tsv" };
const LAPTOP: Target = { id: "laptop", os: "macos", reach: { kind: "local" }, legs: [{ kind: "brew" }, { kind: "npm" }], schedule: { every: "week", day: 3 }, summaryTo: "/status/laptop.tsv" };
const cfg = (...targets: Target[]): TargetsConfig => ({ targets, logDir: "/log" });
const gitOk = () => fakeExec([gitRule(["fetch"], {}), gitRule(["rev-parse"], { out: SHA })]);
const pinOk: LegRunner<PinBumpLeg> = async (_leg, ctx) => ({ lines: [`read at ${!("plugin" in ctx.reach) && ctx.reach.kind === "git" ? ctx.reach.baseSha.slice(0, 7) : "-"}`], summary: "pins current", trouble: false });

describe("runTargets", () => {
  test("a git target runs its pin-bump leg and publishes the tsv", async () => {
    const { exec } = gitOk();
    const { fs, files } = memFs();
    const { results, rc } = await runTargets(cfg(LANE), { exec, fs, rev: "abc1234", pinBump: pinOk }, { dryRun: false, now: NOW });
    expect(rc).toBe(0);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ id: "images", summary: "pins current", trouble: false, published: "/status/images.tsv" });
    expect(files.get("/status/images.tsv")).toBe("host\timages\ndate\t2026-10-25 04:10\nrev\tabc1234\nsummary\tpins current\n");
    const log = files.get("/log/targets.log")!;
    expect(log).toContain("=== oupdate targets 2026-10-25 04:10 rev abc1234 ===");
    expect(log).toContain("[images] read at aaaaaaa");
    expect(log).toContain("[images] summary: pins current");
  });

  test("an unbuilt reach is not checked, with trouble, and still publishes", async () => {
    const { exec, calls } = fakeExec([]);
    const { fs, files } = memFs();
    const { results, rc } = await runTargets(cfg(BOX), { exec, fs, rev: "r", pinBump: pinOk }, { dryRun: false, now: NOW });
    expect(rc).toBe(1);
    expect(results[0]!.summary).toBe("not checked — reach vm-agent not built yet · error: see the targets log");
    expect(files.get("/status/host-b.tsv")).toContain("summary\tnot checked — reach vm-agent not built yet · error: see the targets log\n");
    expect(calls).toHaveLength(0);
  });

  test("unbuilt legs on an open reach are each not checked", async () => {
    const { exec } = fakeExec([]);
    const { fs } = memFs();
    const { results } = await runTargets(cfg(LAPTOP), { exec, fs, rev: "r", pinBump: pinOk }, { dryRun: false, now: NOW, only: ["laptop"] });
    expect(results[0]!.summary).toBe("brew: not checked — leg brew not built yet · npm: not checked — leg npm not built yet · error: see the targets log");
    expect(results[0]!.trouble).toBe(true);
  });

  test("a failed git fetch is not checked; the leg never runs", async () => {
    const { exec } = fakeExec([gitRule(["fetch"], { rc: 128, err: "fatal: no route" })]);
    const { fs } = memFs();
    let ran = false;
    const { results } = await runTargets(cfg(LANE), { exec, fs, rev: "r", pinBump: async () => ((ran = true), { lines: [], summary: "x", trouble: false }) }, { dryRun: false, now: NOW });
    expect(ran).toBe(false);
    expect(results[0]!.summary).toBe("not checked — reach git: fetch of main from origin failed (rc 128: fatal: no route)");
    expect(results[0]!.trouble).toBe(true);
  });

  test("a leg that throws is an error, not a crash", async () => {
    const { exec } = gitOk();
    const { fs } = memFs();
    const { results, rc } = await runTargets(cfg(LANE), { exec, fs, rev: "r", pinBump: async () => { throw new Error("boom"); } }, { dryRun: false, now: NOW });
    expect(rc).toBe(1);
    expect(results[0]!.summary).toBe("error: boom");
  });

  test("a dry run publishes nothing and logs to dry-run-targets.log", async () => {
    const { exec } = gitOk();
    const { fs, files } = memFs();
    const seen: boolean[] = [];
    const { results } = await runTargets(cfg(LANE), { exec, fs, rev: "r", pinBump: async (_l, ctx) => (seen.push(ctx.dryRun), { lines: [], summary: "pins would propose b", trouble: false }) }, { dryRun: true, now: NOW });
    expect(seen).toEqual([true]);
    expect(results[0]!.published).toBeUndefined();
    expect(files.has("/status/images.tsv")).toBe(false);
    expect(files.has("/log/targets.log")).toBe(false);
    expect(files.get("/log/dry-run-targets.log")).toContain("(dry run: nothing proposed or published)");
  });

  test("only due targets run unless named", async () => {
    const { exec } = gitOk();
    const { fs } = memFs();
    const lines: string[] = [];
    const due = await runTargets(cfg(LANE, LAPTOP), { exec, fs, rev: "r", pinBump: pinOk }, { dryRun: true, now: NOW, onLine: (l) => lines.push(l) });
    expect(due.results.map((r) => r.id)).toEqual(["images"]);
    const none = await runTargets(cfg(LAPTOP), { exec, fs, rev: "r", pinBump: pinOk }, { dryRun: true, now: NOW, onLine: (l) => lines.push(l) });
    expect(none).toEqual({ results: [], rc: 0 });
    expect(lines).toContain("no target is due today");
    await expect(runTargets(cfg(LANE), { exec, fs, rev: "r", pinBump: pinOk }, { dryRun: true, now: NOW, only: ["nope"] })).rejects.toThrow("unknown target nope");
  });

  test("a failed tsv write is trouble and the run goes on", async () => {
    const { exec } = gitOk();
    const { fs } = memFs();
    const broken = { ...fs, writeFile: async () => { throw new Error("read-only"); } };
    const { results, rc } = await runTargets(cfg(LANE), { exec, fs: broken, rev: "r", pinBump: pinOk }, { dryRun: false, now: NOW });
    expect(rc).toBe(1);
    expect(results[0]!.trouble).toBe(true);
    expect(results[0]!.lines).toContain("status: publish FAILED (read-only)");
    // Review: the summary the cli prints and the log's summary line both carry a trouble word.
    expect(results[0]!.summary).toBe("pins current · error: status not published to /status/images.tsv (read-only)");
    expect(TROUBLE_WORDS.test(results[0]!.summary)).toBe(true);
    expect(results[0]!.lines).toContain(`summary: ${results[0]!.summary}`);
    expect(results[0]!.lines).not.toContain("summary: pins current");
  });

  const BROKER_BOX: Target = {
    id: "host-a", os: "test-os", reach: TEST_REACH,
    legs: [{ kind: "docker-compose", apply: false, prune: true }],
    schedule: { every: "night" }, summaryTo: "/status/host-a.tsv", parityTo: "/parity/host-a.jsonl",
  };
  const ANSWERS = {
    self: ans([["ROW", "a"]]),
    "compose.state": ans([["CONFIG", X("c")], ["SVC", "app-a", "registry.example/team/app-a:1", A("a"), A("a")]]),
    "image.candidate": ans(evidenceRows({ digest: A("d"), config: A("a"), history: ["RUN x"] })),
  };
  const reviewers = () => ({ first: fakeReviewer("first-model", "APPROVE").reviewer, second: fakeReviewer("second-model", "APPROVE").reviewer });
  const REG = testRegistry();

  test("a broker target runs docker-compose over its plugin's reach and records the night's parity facts", async () => {
    const { exec, requests } = targetExec({ answers: ANSWERS });
    const { fs, files } = memFs();
    const { results, rc } = await runTargets(cfg(BROKER_BOX), { exec, fs, rev: "r", pinBump: pinOk, reviewers: reviewers(), registry: REG }, { dryRun: false, now: NOW });
    expect(rc).toBe(0);
    expect(results[0]!.summary).toBe("up to date");
    expect(requests.map((q) => [q.params.verb, q.params.run_id])).toEqual([["self", undefined], ["compose.state", undefined], ["image.candidate", RUN]]);
    expect(JSON.parse(files.get("/parity/host-a.jsonl")!.trim())).toEqual({ date: "2026-10-25", target: "host-a", rev: "r", checked: true, changed: [], pregate: [] });
    expect(results[0]!.lines).toContain("parity: recorded to /parity/host-a.jsonl");
  });

  test("a reach that fails still records an unchecked parity night", async () => {
    const { exec } = targetExec({});
    const { fs, files } = memFs();
    const { results } = await runTargets(cfg(BROKER_BOX), { exec, fs, rev: "r", pinBump: pinOk, reviewers: reviewers(), registry: REG }, { dryRun: false, now: NOW });
    // "failed" is already a trouble word, so joinLegs adds no "· error: see the targets log".
    expect(results[0]!.summary).toBe("not checked — reach test-broker: self: broker failed: fake: no answer scripted for self");
    expect(JSON.parse(files.get("/parity/host-a.jsonl")!.trim())).toEqual({ date: "2026-10-25", target: "host-a", rev: "r", checked: false });
  });

  test("a dry run records no parity", async () => {
    const { exec } = targetExec({ answers: ANSWERS });
    const { fs, files } = memFs();
    await runTargets(cfg(BROKER_BOX), { exec, fs, rev: "r", pinBump: pinOk, reviewers: reviewers(), registry: REG }, { dryRun: true, now: NOW });
    expect(files.has("/parity/host-a.jsonl")).toBe(false);
  });

  test("a parity record that cannot be written is trouble with a trouble word", async () => {
    const { exec } = targetExec({ answers: ANSWERS });
    const { fs } = memFs();
    const broken = { ...fs, appendFile: async (p: string, t: string) => { if (p.startsWith("/parity/")) throw new Error("read-only"); return fs.appendFile(p, t); } };
    const { results } = await runTargets(cfg(BROKER_BOX), { exec, fs: broken, rev: "r", pinBump: pinOk, reviewers: reviewers(), registry: REG }, { dryRun: false, now: NOW });
    expect(results[0]!.trouble).toBe(true);
    expect(results[0]!.summary).toEndWith("· error: parity not recorded (read-only)");
    expect(TROUBLE_WORDS.test(results[0]!.summary)).toBe(true);
  });

  test("docker-compose over a reach with no broker session, or with no reviewers, is not checked", async () => {
    const { exec } = fakeExec([]);
    const { fs } = memFs();
    const local: Target = { ...LAPTOP, legs: [{ kind: "docker-compose", apply: false, prune: true }] };
    const a = await runTargets(cfg(local), { exec, fs, rev: "r", pinBump: pinOk, reviewers: reviewers() }, { dryRun: false, now: NOW, only: ["laptop"] });
    expect(a.results[0]!.summary).toBe("not checked — leg docker-compose over reach local not built yet · error: see the targets log");
    const n = targetExec({ answers: ANSWERS });
    const b = await runTargets(cfg(BROKER_BOX), { exec: n.exec, fs, rev: "r", pinBump: pinOk, registry: REG }, { dryRun: false, now: NOW });
    expect(b.results[0]!.summary).toBe("not checked — leg docker-compose has no reviewers wired · error: see the targets log");
  });

  test("a plugin reach or leg with no plugin loaded is not checked and runs nothing", async () => {
    const { exec, calls } = fakeExec([]);
    const { fs } = memFs();
    const r = await runTargets(cfg(BROKER_BOX), { exec, fs, rev: "r", pinBump: pinOk, reviewers: reviewers() }, { dryRun: false, now: NOW });
    expect(r.results[0]!.summary).toBe("not checked — reach test-broker has no plugin loaded · error: see the targets log");
    const l = await runTargets(cfg({ ...LAPTOP, legs: [{ kind: "box-leg", plugin: true }] }), { exec, fs, rev: "r", pinBump: pinOk, reviewers: reviewers() }, { dryRun: false, now: NOW, only: ["laptop"] });
    expect(l.results[0]!.summary).toBe("not checked — leg box-leg has no plugin loaded · error: see the targets log");
    expect(calls).toHaveLength(0);
  });

  test("a plugin leg runs through its plugin with the reviewers", async () => {
    const { exec } = fakeExec([]);
    const seen: string[] = [];
    const reg = makeRegistry([{ legs: { "box-leg": { parse: () => ({ kind: "box-leg", plugin: true }), run: async (l, ctx, d) => (seen.push(`${l.kind} ${ctx.reach.kind} ${d.reviewers.first?.name}`), { lines: [], summary: "fine", trouble: false }) } } }]);
    const { results } = await runTargets(cfg({ ...LAPTOP, legs: [{ kind: "box-leg", plugin: true }] }), { exec, fs: memFs().fs, rev: "r", pinBump: pinOk, reviewers: reviewers(), registry: reg }, { dryRun: false, now: NOW, only: ["laptop"] });
    expect(results[0]!.summary).toBe("fine");
    expect(seen).toEqual(["box-leg local first-model"]);
  });

  test("an os-packages target runs its leg over gce-patch and publishes one line", async () => {
    const vms: Target = { id: "cloud-vms", os: "linux", reach: { ...GCE_REACH, vms: [VM_A] }, legs: [{ kind: "os-packages", apply: false, cooldownDays: 0, seenTo: "/state/seen.json", approvalWaitS: 3600 }], schedule: { every: "night" }, summaryTo: "/status/cloud-vms.tsv" };
    const { exec } = gceExec({ vms: { [VM_A]: { inventory: [inventory()] } } });
    const { fs, files } = memFs();
    const reviewers = { first: fakeReviewer("first-model", "APPROVE").reviewer, second: fakeReviewer("second-model", "APPROVE").reviewer };
    const { results, rc } = await runTargets(cfg(vms), { exec, fs, rev: "r", pinBump: pinOk, gce: { reviewers, clock: fakeClock(0) } }, { dryRun: false, now: NOW });
    expect(rc).toBe(0);
    expect(results[0]).toMatchObject({ summary: "vm-a: would patch 2 · held 1", trouble: false, published: "/status/cloud-vms.tsv" });
    expect(files.get("/state/seen.json")).toContain('"openssl"');
  });

  test("an os-packages target with no reviewers wired is not checked", async () => {
    const vms: Target = { id: "cloud-vms", os: "linux", reach: GCE_REACH, legs: [{ kind: "os-packages", apply: false, cooldownDays: 0, seenTo: "/state/seen.json", approvalWaitS: 3600 }], schedule: { every: "night" }, summaryTo: "/status/cloud-vms.tsv" };
    const { exec, calls } = fakeExec([]);
    const { results } = await runTargets(cfg(vms), { exec, fs: memFs().fs, rev: "r", pinBump: pinOk }, { dryRun: false, now: NOW });
    expect(results[0]).toMatchObject({ summary: "not checked — leg os-packages has no reviewers or clock wired · error: see the targets log", trouble: true });
    expect(calls).toHaveLength(0);
  });

  test("one latch for the whole run: trouble in one gce target stops the next target's patches, a thrown leg too", async () => {
    const osLeg = { kind: "os-packages" as const, apply: true, cooldownDays: 0, seenTo: "/state/a-seen.json", approvalWaitS: 3600 };
    const a: Target = { id: "vms-a", os: "linux", reach: { ...GCE_REACH, vms: [VM_A] }, legs: [osLeg], schedule: { every: "night" }, summaryTo: "/status/vms-a.tsv" };
    const b: Target = { id: "vms-b", os: "linux", reach: { ...GCE_REACH, vms: [VM_B] }, legs: [{ ...osLeg, seenTo: "/state/b-seen.json" }], schedule: { every: "night" }, summaryTo: "/status/vms-b.tsv" };
    const reviewers = { first: fakeReviewer("first-model", "APPROVE").reviewer, second: fakeReviewer("second-model", "APPROVE").reviewer };
    const scene = { [VM_B]: { inventory: [inventory({ vm: VM_B })] } };
    const unknownA = gceExec({ vms: scene });
    const r1 = await runTargets(cfg(a, b), { exec: unknownA.exec, fs: memFs().fs, rev: "r", pinBump: pinOk, gce: { reviewers, clock: fakeClock(0) } }, { dryRun: false, now: NOW });
    expect(r1.results[1]!.summary).toBe("vm-b: blocked (patch: not asked: an earlier VM this run ended with trouble (vm-a)) · held 1");
    expect(unknownA.requests.filter((q) => q.params.verb === "patch")).toHaveLength(0);
    const thrown = gceExec({ vms: { [VM_A]: { inventory: [inventory()] }, ...scene } });
    const { fs } = memFs();
    const broken = { ...fs, readText: async (p: string) => (p === "/state/a-seen.json" ? Promise.reject(new Error("disk gone")) : fs.readText(p)) };
    const r2 = await runTargets(cfg(a, b), { exec: thrown.exec, fs: broken, rev: "r", pinBump: pinOk, gce: { reviewers, clock: fakeClock(0) } }, { dryRun: false, now: NOW });
    expect(r2.results[0]!.summary).toStartWith("error: ");
    expect(r2.results[1]!.summary).toBe("vm-b: blocked (patch: not asked: an earlier VM this run ended with trouble (vms-a)) · held 1");
    expect(thrown.requests.filter((q) => q.params.verb === "patch")).toHaveLength(0);
  });

  test("a gce target that returns trouble without throwing latches the run: a failed first-seen save stops the next target's patch", async () => {
    const osLeg = { kind: "os-packages" as const, apply: true, cooldownDays: 0, seenTo: "/state/a-seen.json", approvalWaitS: 3600 };
    const a: Target = { id: "vms-a", os: "linux", reach: { ...GCE_REACH, vms: [VM_A] }, legs: [{ ...osLeg, apply: false }], schedule: { every: "night" }, summaryTo: "/status/vms-a.tsv" };
    const b: Target = { id: "vms-b", os: "linux", reach: { ...GCE_REACH, vms: [VM_B] }, legs: [{ ...osLeg, seenTo: "/state/b-seen.json" }], schedule: { every: "night" }, summaryTo: "/status/vms-b.tsv" };
    const reviewers = { first: fakeReviewer("first-model", "APPROVE").reviewer, second: fakeReviewer("second-model", "APPROVE").reviewer };
    const t = gceExec({ vms: { [VM_A]: { inventory: [inventory()] }, [VM_B]: { inventory: [inventory({ vm: VM_B })] } } });
    const { fs } = memFs();
    const eio = { ...fs, writeFile: async (p: string, text: string) => (p === "/state/a-seen.json" ? Promise.reject(new Error("EIO: i/o error")) : fs.writeFile(p, text)) };
    const { results } = await runTargets(cfg(a, b), { exec: t.exec, fs: eio, rev: "r", pinBump: pinOk, gce: { reviewers, clock: fakeClock(0) } }, { dryRun: false, now: NOW });
    expect(results[0]!.summary).toBe("vm-a: would patch 2 · held 1 · error: first-seen dates not saved to /state/a-seen.json (EIO: i/o error)");
    expect(results[1]!.summary).toBe("vm-b: blocked (patch: not asked: an earlier VM this run ended with trouble (vms-a)) · held 1");
    expect(t.requests.filter((q) => q.params.verb === "patch")).toHaveLength(0);
  });
});
