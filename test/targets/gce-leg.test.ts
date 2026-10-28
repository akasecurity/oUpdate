// The os-packages leg, per VM: read, rules, both models, one patch request with that VM's approved names (never an empty
// one), the job, a post-job inventory newer than its end, the full compare, the broker's post-check as the authority,
// the run binding's time limits, and the latch after anything unclean. Summaries are fixed phrases and counts.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { Clock } from "../../src/targets/gce/job.ts";
import { osPackagesLeg } from "../../src/targets/gce/leg.ts";
import { newLatch } from "../../src/targets/gce/patch.ts";
import { parseTime } from "../../src/targets/gce/verbs.ts";
import type { OsPackagesLeg, Target } from "../../src/targets/model.ts";
import type { ReviewerPair } from "../../src/targets/compose/review.ts";
import type { OpenGce } from "../../src/targets/reach.ts";
import { TROUBLE_WORDS } from "../../src/targets/summary.ts";
import { fakeReviewer } from "./fake-broker.ts";
import { after, BOOT2, CANDS, fakeClock, fakeGce, GCE, GCE_REACH, INSTALLED, inventory, job, JOB_END, jobOf, runOf, VM_A, VM_B, type FakeGce, type FakeReply, type GceVm } from "./fake-gce.ts";
import { fakeExec, memFs } from "./fakes.ts";

const NOW = new Date("2026-10-26T03:00:00Z");
const START = Date.parse("2026-10-26T03:05:00Z");
const END = parseTime(JOB_END)!;
const MIN = 60_000;
const SEEN = "/state/seen.json";
const EARLY = "2026-10-20T03:00:00.000Z";
const SEEN_VM = { openssl: { version: "3.0.13-0ubuntu3.5", first: EARLY }, libssl3t64: { version: "3.0.13-0ubuntu3.5", first: EARLY }, curl: { version: "8.5.0-2ubuntu10.6", first: EARLY } };
const OLD_SEEN = JSON.stringify({ [VM_A]: SEEN_VM, [VM_B]: SEEN_VM });
const NEW = "3.0.13-0ubuntu3.5";
const CLEAN = { openssl: NEW, libssl3t64: NEW };
const postInv = (vm: string, moves: Record<string, string | null> = CLEAN, updateTime = "2026-10-26T03:21:00Z") => inventory({ vm, installed: after(moves), candidates: [CANDS[2]!], updateTime });
type Post = "clean" | "drift" | "not-checked" | null;
/** post null: the broker's post-check has not finished yet. */
const DONE = (vm: string, instance = "SUCCEEDED", state = "SUCCEEDED", post: Post = "clean") => job(vm, state, instance, JOB_END, post ?? undefined);
const vmScene = (vm: string, over: Partial<GceVm> = {}): GceVm => ({ inventory: [inventory({ vm }), postInv(vm)], jobs: [job(vm, "PATCHING", "APPLYING_PATCHES"), DONE(vm)], ...over });
const TARGET: Target = { id: "cloud-vms", os: "linux", reach: GCE_REACH, legs: [], schedule: { every: "night" }, summaryTo: "/status/cloud-vms.tsv" };
const leg = (apply = false, over: Partial<OsPackagesLeg> = {}): OsPackagesLeg => ({ kind: "os-packages", apply, cooldownDays: 2, seenTo: SEEN, approvalWaitS: 3600, ...over });
const both = (): ReviewerPair => ({ first: fakeReviewer("first-model", "APPROVE").reviewer, second: fakeReviewer("second-model", "APPROVE").reviewer });

function setup(g: FakeGce, vms: string[] = [VM_A], seen: string | null = OLD_SEEN, reviewers: ReviewerPair | ((c: Clock) => ReviewerPair) = both(), readError?: { error: string }) {
  const clock = fakeClock(START);
  const f = fakeGce({ ...g, clock });
  const { exec } = fakeExec([f.rule]);
  const mem = memFs(seen === null ? {} : { [SEEN]: seen });
  const files = mem.files;
  const fs = readError ? { ...mem.fs, readText: async () => readError } : mem.fs;
  const open: OpenGce = { kind: "gce-patch", exec, broker: GCE, project: "example-proj", vms };
  const r = typeof reviewers === "function" ? reviewers(clock) : reviewers;
  const latch = newLatch();
  const run = (l: OsPackagesLeg, dryRun = false) => osPackagesLeg(l, { target: TARGET, reach: open, dryRun, now: NOW }, { reviewers: r, fs, clock, latch });
  const patches = () => f.requests.filter((q) => q.action === "cloud.osc.patch");
  return { requests: f.requests, files, run, patches, clock, latch };
}

describe("os-packages leg", () => {
  test("review only: reports what it would patch, sends no patch, and keeps the first-seen dates", async () => {
    const t = setup({ vms: { [VM_A]: vmScene(VM_A) } });
    const r = await t.run(leg(false));
    expect(r).toMatchObject({ summary: "vm-a: would patch 2 · held 1", trouble: false });
    expect(t.patches()).toHaveLength(0);
    expect(JSON.parse(t.files.get(SEEN)!)[VM_A].openssl.first).toBe(EARLY);
    expect(r.lines).toContain("  held curl: broker: the candidate is newer than the security index lists");
  });

  test("a dry run with apply sends no patch and writes no state", async () => {
    const t = setup({ vms: { [VM_A]: vmScene(VM_A) } });
    expect((await t.run(leg(true), true)).summary).toBe("vm-a: would patch 2 · held 1");
    expect(t.patches()).toHaveLength(0);
    expect(t.files.get(SEEN)).toBe(OLD_SEEN);
  });

  test("apply: one patch with only the approved names, then the job, a fresh inventory, a clean compare and a clean post-check", async () => {
    const t = setup({ vms: { [VM_A]: vmScene(VM_A) } });
    const r = await t.run(leg(true));
    expect(r).toMatchObject({ summary: "vm-a: patched 2 · held 1", trouble: false });
    expect(t.requests.map((q) => String(q.params.verb))).toEqual(["inventory", "patch", "job.status", "job.status", "inventory"]);
    expect(t.patches()[0]!.params).toEqual({
      verb: "patch",
      run_id: runOf(VM_A),
      verdict: { items: { curl: "HOLD", libssl3t64: "APPROVE", openssl: "APPROVE" }, reviewers: { first: "first-model", second: "second-model" }, evidence_sha256: createHash("sha256").update(JSON.stringify(JSON.parse(t.requests[0]!.out!).result)).digest("hex") },
    });
    expect(r.lines).toContain(`patch: job ${jobOf(VM_A)} started for 2 package(s) [broker request req-2]`);
    expect(r.lines).toContain("  patched openssl");
    expect(r.lines).toContain("broker post-check: clean");
  });

  test("the post-check result is waited for when the job's end comes without it", async () => {
    const t = setup({ vms: { [VM_A]: vmScene(VM_A, { jobs: [DONE(VM_A, "SUCCEEDED", "SUCCEEDED", null), DONE(VM_A, "SUCCEEDED", "SUCCEEDED", null), DONE(VM_A)] }) } });
    expect(await t.run(leg(true))).toMatchObject({ summary: "vm-a: patched 2 · held 1", trouble: false });
    expect(t.requests.map((q) => String(q.params.verb))).toEqual(["inventory", "patch", "job.status", "inventory", "job.status", "job.status"]);
  });

  test("everything held means no patch request at all", async () => {
    const t = setup({ vms: { [VM_A]: vmScene(VM_A) } }, [VM_A], null);
    expect(await t.run(leg(true))).toMatchObject({ summary: "vm-a: held 3", trouble: false });
    expect(t.patches()).toHaveLength(0);
  });

  test("a model FLAG holds the VM with trouble and sends nothing", async () => {
    const t = setup({ vms: { [VM_A]: vmScene(VM_A) } }, [VM_A], OLD_SEEN, { first: fakeReviewer("first-model", "FLAG\n1. openssl").reviewer, second: fakeReviewer("second-model", "APPROVE").reviewer });
    expect(await t.run(leg(true))).toMatchObject({ summary: "vm-a: blocked (review: first FLAG) · held 3", trouble: true });
    expect(t.patches()).toHaveLength(0);
  });

  test("a clean night with alarming package names leaves no trouble word and no names in the summary (Review Focus 1)", async () => {
    const installed: [string, string][] = [["liberror-perl", "0.17029-2"], ["libblockdev3", "3.1.1-1"]];
    const candidates = [
      { name: "liberror-perl", installed: "0.17029-2", available: "0.17029-2ubuntu0.1" },
      { name: "libblockdev3", installed: "3.1.1-1", available: "3.1.1-1ubuntu0.1" },
    ];
    const moved = after({ "liberror-perl": "0.17029-2ubuntu0.1", libblockdev3: "3.1.1-1ubuntu0.1" }, installed);
    const scene = { inventory: [inventory({ installed, candidates }), inventory({ installed: moved, candidates: [], updateTime: "2026-10-26T03:21:00Z" })], jobs: [DONE(VM_A)] };
    const t = setup({ vms: { [VM_A]: scene } }, [VM_A], null);
    const r = await t.run(leg(true, { cooldownDays: 0 }));
    expect(r).toMatchObject({ summary: "vm-a: patched 2", trouble: false });
    expect(TROUBLE_WORDS.test(r.summary)).toBe(false);
    expect(r.summary).not.toContain("lib");
    expect(r.lines).toContain("  patched liberror-perl");
  });

  test("hostile text in an answer is refused at decode, kept out of the summary, and clipped in the log (Review Focus 2)", async () => {
    const hostile = `liberror-perl;${"x".repeat(5000)}`;
    const t = setup({ vms: { [VM_A]: { inventory: [inventory({ installed: [[hostile, "1.0-1"], ...INSTALLED], candidates: [] })] } } });
    const r = await t.run(leg(true));
    expect(r).toMatchObject({ summary: "vm-a: not checked — the inventory answer failed its rules", trouble: true });
    expect(r.lines.some((l) => l.startsWith("inventory.installed[0].name is not valid") && l.length <= 410)).toBe(true);
  });

  test("an unapproved change with a drift post-check is FLAG and stops the next VM's patch (Review Focus 5)", async () => {
    const t = setup({ vms: { [VM_A]: vmScene(VM_A, { inventory: [inventory({ vm: VM_A }), postInv(VM_A, { ...CLEAN, bash: "5.2.21-2ubuntu5" })], jobs: [DONE(VM_A, "SUCCEEDED", "SUCCEEDED", "drift")] }), [VM_B]: vmScene(VM_B) } }, [VM_A, VM_B]);
    const r = await t.run(leg(true));
    expect(r.trouble).toBe(true);
    expect(r.summary).toBe("vm-a: at reviewed version 2 · FLAG — 1 change(s) not approved after the job · FLAG — the broker's post-check found drift (the VM is suspended until it is acknowledged) · held 1 · vm-b: blocked (patch: not asked: an earlier VM this run ended with trouble (vm-a)) · held 1");
    expect(r.lines).toContain("  UNAPPROVED bash 5.2.21-2ubuntu4 -> 5.2.21-2ubuntu5");
    expect(t.patches().map((p) => p.vm)).toEqual([VM_A]);
  });

  test("a clean post-check that the caller's compare contradicts is trouble, and the reverse too", async () => {
    const one = setup({ vms: { [VM_A]: vmScene(VM_A, { inventory: [inventory({ vm: VM_A }), postInv(VM_A, { ...CLEAN, bash: "5.2.21-2ubuntu5" })] }) } });
    expect(await one.run(leg(true))).toMatchObject({ summary: "vm-a: at reviewed version 2 · FLAG — 1 change(s) not approved after the job · FLAG — the broker's post-check and the caller's compare disagree · held 1", trouble: true });
    const two = setup({ vms: { [VM_A]: vmScene(VM_A, { jobs: [DONE(VM_A, "SUCCEEDED", "SUCCEEDED", "drift")] }) } });
    expect(await two.run(leg(true))).toMatchObject({ summary: "vm-a: at reviewed version 2 · FLAG — the broker's post-check found drift (the VM is suspended until it is acknowledged) · FLAG — the broker's post-check and the caller's compare disagree · held 1", trouble: true });
  });

  test("a not-checked post-check is FAILED with outcome unknown, never patched", async () => {
    const t = setup({ vms: { [VM_A]: vmScene(VM_A, { jobs: [DONE(VM_A, "SUCCEEDED", "SUCCEEDED", "not-checked")] }) } });
    expect(await t.run(leg(true))).toMatchObject({ summary: "vm-a: at reviewed version 2 · FAILED — the broker's post-check could not check the VM (it is suspended; outcome unknown) · held 1", trouble: true });
  });

  test("no inventory newer than the job's end is trouble, never patched, and stops the next VM (Review Focus 4)", async () => {
    const t = setup({ vms: { [VM_A]: vmScene(VM_A, { inventory: [inventory({ vm: VM_A }), postInv(VM_A, CLEAN, JOB_END)] }), [VM_B]: vmScene(VM_B) } }, [VM_A, VM_B]);
    const r = await t.run(leg(true));
    expect(r.trouble).toBe(true);
    expect(r.summary).toBe("vm-a: error: no inventory newer than the job's end · held 1 · vm-b: blocked (patch: not asked: an earlier VM this run ended with trouble (vm-a)) · held 1");
    expect(r.lines).toContain(`no inventory newer than the job's end by the end of the wait (latest ${JOB_END})`);
    expect(t.patches().map((p) => p.vm)).toEqual([VM_A]);
  });

  test("a lost job status is never patched: the job and the post-check are unknown (Review Focus 4)", async () => {
    const t = setup({ vms: { [VM_A]: vmScene(VM_A, { replies: { "job.status": { status: "withheld", reason: "locked" } } }) } });
    const r = await t.run(leg(true));
    expect(r).toMatchObject({ summary: "vm-a: at reviewed version 2 · FAILED — job status unknown · FAILED — no result from the broker's post-check · held 1", trouble: true });
    expect(r.summary).not.toContain("patched");
  });

  test("an approval still pending is FAILED with outcome unknown, asks the VM's job status once, and stops the next VM (Review Focus 3)", async () => {
    const t = setup({ vms: { [VM_A]: vmScene(VM_A, { replies: { patch: { status: "pending" } } }), [VM_B]: vmScene(VM_B) } }, [VM_A, VM_B]);
    const r = await t.run(leg(true));
    expect(r.trouble).toBe(true);
    expect(r.summary).toBe("vm-a: FAILED — patch outcome unknown, the patch may have run (the broker's own post-check covers it) · held 1 · vm-b: blocked (patch: not asked: an earlier VM this run ended with trouble (vm-a)) · held 1");
    const status = t.requests.filter((q) => q.params.verb === "job.status");
    expect(status.map((q) => [q.vm, q.params.job_id, q.params.vm])).toEqual([[VM_A, undefined, VM_A]]);
    expect(r.lines).toContain(`job.status after the patch reply was lost: job ${jobOf(VM_A)} PATCHING, VM APPLYING_PATCHES`);
  });

  test("a broker refusal (role busy, VM suspended) is blocked with nothing ran, and its reason stays in the log", async () => {
    const t = setup({ vms: { [VM_A]: vmScene(VM_A, { replies: { patch: { status: "approved", result: { run_id: runOf(VM_A), seq: 2, refused: "gce-osc: role busy" } } } }) } });
    const r = await t.run(leg(true));
    expect(r).toMatchObject({ summary: "vm-a: blocked — nothing ran (see the targets log) · held 1", trouble: true });
    expect(r.lines).toContain("patch: refused by the broker, nothing ran: gce-osc: role busy [broker request req-2]");
  });

  test.each([
    ["an orphan intent", { status: "approved", result: { run_id: runOf(VM_A), seq: 2, intent: { intent_id: "int-0001", state: "orphan" } } }, "job.status after the patch reply was lost: an orphan intent int-0001 (no job was recorded; the VM is suspended until it is acknowledged)"],
    ["a voided intent", { status: "approved", result: { run_id: runOf(VM_A), seq: 2, intent: { intent_id: "int-0002", state: "void" } } }, "job.status after the patch reply was lost: a voided intent int-0002 (nothing ran)"],
    ["a broker restart that answers from its chain under a new boot, seq 1", { status: "approved", result: { run_id: runOf(VM_A), seq: 1, boot: BOOT2, job_id: jobOf(VM_A), state: "PATCHING", instance_state: "STARTED" } }, `job.status after the patch reply was lost: job ${jobOf(VM_A)} PATCHING, VM STARTED`],
    ["a broker restart whose new boot does not start at seq 1", { status: "approved", result: { run_id: runOf(VM_A), seq: 3, boot: BOOT2, job_id: jobOf(VM_A), state: "PATCHING", instance_state: "STARTED" } }, "job.status after the patch reply was lost: job.status: the broker's seq 3 under a new boot is not 1 (whether the patch ran is unknown)"],
    // Under the same boot the broker did not restart: a seq that starts again or jumps is refused.
    ["a seq that starts again at 1 under the same boot", { status: "approved", result: { run_id: runOf(VM_A), seq: 1, job_id: jobOf(VM_A), state: "PATCHING", instance_state: "STARTED" } }, "job.status after the patch reply was lost: job.status: the broker's seq 1 repeats (whether the patch ran is unknown)"],
    ["a seq that jumps under the same boot", { status: "approved", result: { run_id: runOf(VM_A), seq: 9, job_id: jobOf(VM_A), state: "PATCHING", instance_state: "STARTED" } }, "job.status after the patch reply was lost: job.status: the broker's seq 9 is not the next one (expected 2) (whether the patch ran is unknown)"],
    ["no job on the run", { status: "approved", result: { run_id: runOf(VM_A), seq: 2, refused: "gce-osc: no job" } }, "job.status after the patch reply was lost: job.status: refused by the broker: gce-osc: no job (whether the patch ran is unknown)"],
  ] as [string, FakeReply, string][])("a lost patch reply then %s is FAILED unknown and latched", async (_what, reply, line) => {
    const t = setup({ vms: { [VM_A]: vmScene(VM_A, { replies: { patch: { status: "pending" }, "job.status": reply } }), [VM_B]: vmScene(VM_B) } }, [VM_A, VM_B]);
    const r = await t.run(leg(true));
    expect(r.trouble).toBe(true);
    expect(r.summary).toStartWith("vm-a: FAILED — patch outcome unknown");
    expect(r.summary).toEndWith("vm-b: blocked (patch: not asked: an earlier VM this run ended with trouble (vm-a)) · held 1");
    expect(r.lines).toContain(line);
  });

  test("after a lost patch reply past the run's binding, job.status is not asked; still FAILED unknown and latched", async () => {
    let clock: Clock | undefined;
    const t = setup({ vms: { [VM_A]: vmScene(VM_A, { replies: { patch: () => (void clock!.sleep(2 * 60 * MIN), { status: "pending" }) } }) } }, [VM_A], OLD_SEEN, (c) => ((clock = c), both()));
    const r = await t.run(leg(true));
    expect(r.summary).toStartWith("vm-a: FAILED — patch outcome unknown");
    expect(t.requests.filter((q) => q.params.verb === "job.status")).toHaveLength(0);
    expect(r.lines).toContain("job.status after the patch reply was lost: not asked: the broker run's binding has ended (whether the patch ran is unknown)");
    expect(t.latch.stopped).toBe(VM_A);
  });

  test("a locked refusal (the intent voided) is blocked with nothing ran, latches, and says nothing of an orphan", async () => {
    const t = setup({ vms: { [VM_A]: vmScene(VM_A, { replies: { patch: { status: "approved", result: { run_id: runOf(VM_A), seq: 2, refused: "gce-osc: locked" } } } }), [VM_B]: vmScene(VM_B) } }, [VM_A, VM_B]);
    const r = await t.run(leg(true));
    expect(r.summary).toBe("vm-a: blocked — nothing ran (see the targets log) · held 1 · vm-b: blocked (patch: not asked: an earlier VM this run ended with trouble (vm-a)) · held 1");
    expect(r.lines).toContain("patch: refused by the broker, nothing ran: gce-osc: locked [broker request req-2]");
    expect(r.lines.some((l) => /orphan|suspended/.test(l))).toBe(false);
    expect(t.patches().map((p) => p.vm)).toEqual([VM_A]);
  });

  test("a job that completed with errors and installed only one package is FAILED twice over", async () => {
    const t = setup({ vms: { [VM_A]: vmScene(VM_A, { inventory: [inventory({ vm: VM_A }), postInv(VM_A, { openssl: NEW })], jobs: [DONE(VM_A, "FAILED", "COMPLETED_WITH_ERRORS")] }) } });
    expect(await t.run(leg(true))).toMatchObject({ summary: "vm-a: at reviewed version 1 · FAILED — 1 approved package(s) not installed · FAILED — job COMPLETED_WITH_ERRORS, VM FAILED · held 1", trouble: true });
  });

  test("a reboot left pending and names the broker dropped are reported, not trouble", async () => {
    const t = setup({ vms: { [VM_A]: vmScene(VM_A, { inventory: [inventory({ vm: VM_A }), postInv(VM_A, { openssl: NEW })], jobs: [DONE(VM_A, "SUCCEEDED_REBOOT_REQUIRED")], replies: { patch: { status: "approved", result: { run_id: runOf(VM_A), seq: 2, job_id: jobOf(VM_A), sent: ["openssl"] } } } }) } });
    expect(await t.run(leg(true))).toMatchObject({ summary: "vm-a: patched 1 · dropped by the broker 1 · reboot pending · held 1", trouble: false });
  });

  test("a VM the broker refuses is not checked, with the reason in the log; the next VM still runs", async () => {
    const t = setup({ vms: { [VM_B]: vmScene(VM_B) } }, [VM_A, VM_B]);
    const r = await t.run(leg(false));
    expect(r).toMatchObject({ summary: "vm-a: not checked — error reading the inventory · vm-b: would patch 2 · held 1", trouble: true });
    expect(r.lines).toContain("inventory: refused by the broker: gce-osc: unknown vm");
  });

  test("every not-checked summary carries a trouble word of its own", async () => {
    const t = setup({ vms: { [VM_A]: { inventory: [inventory({ extra: { env: "x" } })] } } }, [VM_A, VM_B]);
    const r = await t.run(leg(false));
    for (const part of r.summary.split(" · ")) expect(TROUBLE_WORDS.test(part)).toBe(true);
    const local = await osPackagesLeg(leg(false), { target: TARGET, reach: { kind: "local", exec: fakeExec([]).exec }, dryRun: false, now: NOW }, { reviewers: both(), fs: memFs().fs, clock: fakeClock(0), latch: newLatch() });
    expect(TROUBLE_WORDS.test(local.summary)).toBe(true);
  });

  test("an unreadable first-seen file holds every package with trouble and is left as it was", async () => {
    const t = setup({ vms: { [VM_A]: vmScene(VM_A) } }, [VM_A], "{");
    expect(await t.run(leg(true))).toMatchObject({ summary: `error: first-seen file ${SEEN} is not JSON; every package held · vm-a: held 3`, trouble: true });
    expect(t.patches()).toHaveLength(0);
    expect(t.files.get(SEEN)).toBe("{");
  });
});

describe("os-packages leg: any trouble on a VM stops every later patch this run", () => {
  test.each([
    ["a VM the broker does not hold", { vms: { [VM_B]: vmScene(VM_B) } }],
    ["a malformed inventory", { vms: { [VM_A]: { inventory: [inventory({ extra: { env: "x" } })] }, [VM_B]: vmScene(VM_B) } }],
    ["a lost read", { vms: { [VM_A]: { replies: { inventory: { status: "withheld", reason: "locked" } } }, [VM_B]: vmScene(VM_B) } }],
    ["a VM not set up (a labeled VM, refused at its first inventory read)", { vms: { [VM_A]: { replies: { inventory: { status: "approved", result: { seq: 1, refused: "gce-osc: vm not set up" } } } }, [VM_B]: vmScene(VM_B) } }],
  ] as [string, FakeGce][])("%s: not checked, then the next VM is reviewed but not patched", async (_what, scene) => {
    const t = setup(scene, [VM_A, VM_B]);
    const r = await t.run(leg(true));
    expect(r.summary).toEndWith("vm-b: blocked (patch: not asked: an earlier VM this run ended with trouble (vm-a)) · held 1");
    expect(t.patches()).toHaveLength(0);
  });

  test("a review FLAG on one VM stops the next VM's patch", async () => {
    let calls = 0;
    const flagFirst: ReviewerPair = { first: fakeReviewer("first-model", () => (calls++ === 0 ? "FLAG\nno" : "APPROVE")).reviewer, second: fakeReviewer("second-model", "APPROVE").reviewer };
    const t = setup({ vms: { [VM_A]: vmScene(VM_A), [VM_B]: vmScene(VM_B) } }, [VM_A, VM_B], OLD_SEEN, flagFirst);
    expect((await t.run(leg(true))).summary).toBe("vm-a: blocked (review: first FLAG) · held 3 · vm-b: blocked (patch: not asked: an earlier VM this run ended with trouble (vm-a)) · held 1");
    expect(t.patches()).toHaveLength(0);
  });
});

describe("os-packages leg: a broker restart mid-run", () => {
  test("a new boot on the post-job inventory is trouble, never patched, and latched", async () => {
    const t = setup({ vms: { [VM_A]: vmScene(VM_A, { replies: { inventory: (p) => (p.run_id ? { status: "approved", result: { run_id: runOf(VM_A), seq: 1, boot: BOOT2, ...postInv(VM_A) } } : { status: "approved", result: { run_id: runOf(VM_A), seq: 1, ...inventory({ vm: VM_A }) } }) } }), [VM_B]: vmScene(VM_B) } }, [VM_A, VM_B]);
    const r = await t.run(leg(true));
    expect(r.summary).toStartWith("vm-a: error: no inventory newer than the job's end");
    expect(r.summary).not.toContain("patched");
    expect(r.summary).toEndWith("vm-b: blocked (patch: not asked: an earlier VM this run ended with trouble (vm-a)) · held 1");
    expect(r.lines.some((l) => l.includes("the broker restarted"))).toBe(true);
  });
});

describe("os-packages leg: the run's one latch", () => {
  test("a latch set by an earlier target stops this leg's patches", async () => {
    const t = setup({ vms: { [VM_A]: vmScene(VM_A) } });
    t.latch.stopped = "other-target";
    expect((await t.run(leg(true))).summary).toBe("vm-a: blocked (patch: not asked: an earlier VM this run ended with trouble (other-target)) · held 1");
    expect(t.patches()).toHaveLength(0);
  });

  test("a first-seen file that cannot be read (not missing) holds every package with trouble and is never written", async () => {
    const t = setup({ vms: { [VM_A]: vmScene(VM_A) } }, [VM_A], OLD_SEEN, both(), { error: "EIO: i/o error" });
    expect(await t.run(leg(true))).toMatchObject({ summary: `error: first-seen file ${SEEN} could not be read: EIO: i/o error; every package held · vm-a: held 3`, trouble: true });
    expect(t.patches()).toHaveLength(0);
    expect(t.files.get(SEEN)).toBe(OLD_SEEN);
  });

  test("a first-seen save that fails latches the run", async () => {
    const t = setup({ vms: { [VM_A]: vmScene(VM_A) } });
    const { fs } = memFs();
    const r = await osPackagesLeg(leg(false), { target: TARGET, reach: { kind: "gce-patch", exec: fakeExec([fakeGce({ vms: { [VM_A]: vmScene(VM_A) } }).rule]).exec, broker: GCE, project: "example-proj", vms: [VM_A] }, dryRun: false, now: NOW }, { reviewers: both(), fs: { ...fs, writeFile: async () => Promise.reject(new Error("EIO")) }, clock: t.clock, latch: t.latch });
    expect(r.trouble).toBe(true);
    expect(t.latch.stopped).toBe("cloud-vms");
  });

  test("an unreadable first-seen file latches the run", async () => {
    const t = setup({ vms: { [VM_A]: vmScene(VM_A) } }, [VM_A], "{");
    await t.run(leg(true));
    expect(t.latch.stopped).toBe("cloud-vms");
  });
});

describe("os-packages leg inside the broker's run binding", () => {
  test("a review that runs past the 2 h binding sends no patch", async () => {
    let calls = 0;
    const slow = (c: Clock): ReviewerPair => ({
      first: fakeReviewer("first-model", () => {
        if (calls++ === 1) void c.sleep(2 * 60 * MIN);
        return "APPROVE";
      }).reviewer,
      second: fakeReviewer("second-model", "APPROVE").reviewer,
    });
    const t = setup({ vms: { [VM_A]: vmScene(VM_A), [VM_B]: vmScene(VM_B) } }, [VM_A, VM_B], OLD_SEEN, slow);
    const r = await t.run(leg(true));
    expect(r.summary).toBe("vm-a: patched 2 · held 1 · vm-b: blocked (patch: not asked: the review ran past the broker run's 2 h binding) · held 1");
    expect(r.trouble).toBe(true);
    expect(t.patches().map((p) => p.vm)).toEqual([VM_A]);
  });

  test("the worst case fits: the patch goes inside 2 h of the run's mint, and every later read inside 1 h of the job's end", async () => {
    const running = Array.from({ length: 30 }, () => job(VM_A, "PATCHING", "APPLYING_PATCHES"));
    const t = setup({ vms: { [VM_A]: vmScene(VM_A, { inventory: [inventory({ vm: VM_A }), postInv(VM_A, CLEAN, JOB_END)], jobs: [...running, DONE(VM_A, "SUCCEEDED", "SUCCEEDED", null)] }) } });
    const r = await t.run(leg(true, { approvalWaitS: 5400 }));
    expect(r.summary).toBe("vm-a: error: no inventory newer than the job's end · FAILED — no result from the broker's post-check · held 1");
    const [mint, patch, ...later] = t.requests;
    expect(patch!.params.verb).toBe("patch");
    expect(patch!.at! - mint!.at!).toBeLessThan(2 * 60 * MIN);
    const last = later[later.length - 1]!.at!;
    expect(last).toBeLessThanOrEqual(END + 60 * MIN);
    expect(last).toBeGreaterThan(END + 50 * MIN);
  });
});
