// A patch job's status: strict decode, what each end state means to the caller, and a bounded poll.
import { describe, expect, test } from "bun:test";
import { gceRead, newGceSession } from "../../src/targets/gce/broker.ts";
import { decodeJob, decodeJobByRun, jobOutcome, waitJob, waitPost, type JobStatus } from "../../src/targets/gce/job.ts";
import { parseTime } from "../../src/targets/gce/verbs.ts";
import { fakeClock, GCE, gceExec, inventory, job, JOB_END, jobOf, VM_A } from "./fake-gce.ts";

const J = jobOf(VM_A);

describe("decodeJob", () => {
  test("a running job has no end; an ended one has its end time", () => {
    expect(decodeJob(job(VM_A, "PATCHING", "APPLYING_PATCHES"), J)).toEqual({ ok: true, value: { jobId: J, state: "PATCHING", instanceState: "APPLYING_PATCHES", ended: false } });
    expect(decodeJob(job(VM_A, "SUCCEEDED", "SUCCEEDED", JOB_END), J)).toEqual({ ok: true, value: { jobId: J, state: "SUCCEEDED", instanceState: "SUCCEEDED", ended: true, endTime: Date.UTC(2026, 9, 26, 3, 20), endText: JOB_END } });
  });

  test.each([
    ["another job", ({ job_id: "job-other-1", state: "SUCCEEDED", instance_state: "SUCCEEDED", end_time: JOB_END }), `job.status names another job (expected ${J})`],
    ["an unknown state", job(VM_A, "DONE", "SUCCEEDED", JOB_END), 'job.status.state is not a known state: "DONE"'],
    ["an unknown instance state", job(VM_A, "SUCCEEDED", "FINE", JOB_END), 'job.status.instance_state is not a known state: "FINE"'],
    ["an ended job with no end", job(VM_A, "SUCCEEDED", "SUCCEEDED"), "job.status: an ended job needs end_time"],
    ["a running job with an end", job(VM_A, "PATCHING", "STARTED", JOB_END), "job.status: a running job has no end_time"],
    ["a bad end time", job(VM_A, "SUCCEEDED", "SUCCEEDED", "soon"), "job.status.end_time is not an RFC 3339 UTC time"],
    ["an unknown key", ({ job_id: J, state: "PATCHING", instance_state: "STARTED", pre_step: "x" }), "job.status: unknown key pre_step"],
    ["an unknown post-check result", job(VM_A, "SUCCEEDED", "SUCCEEDED", JOB_END, "fine" as "clean"), 'job.status.post is not a known result: "fine"'],
    ["a post-check result on a running job", job(VM_A, "PATCHING", "STARTED", undefined, "clean"), "job.status: a running job has no post-check result"],
  ])("%s is refused", (_what, text, why) => {
    expect(decodeJob(text, J)).toEqual({ ok: false, why });
  });
});

describe("decodeJob, the broker's post-check (rev 12 §8.6)", () => {
  test("post is clean, drift or not-checked once the post-check has finished", () => {
    for (const post of ["clean", "drift", "not-checked"] as const) {
      const d = decodeJob(job(VM_A, "SUCCEEDED", "SUCCEEDED", JOB_END, post), J);
      expect(d.ok && d.value.post).toBe(post);
    }
    const none = decodeJob(job(VM_A, "SUCCEEDED", "SUCCEEDED", JOB_END), J);
    expect(none.ok && none.value.post).toBeUndefined();
  });

  test("with no expected job id, any valid job id is taken (the VM's job after a lost patch reply)", () => {
    expect(decodeJob(job(VM_A, "PATCHING", "STARTED"), undefined)).toMatchObject({ ok: true, value: { jobId: J } });
    expect(decodeJob({ job_id: "Job;1", state: "PATCHING", instance_state: "STARTED" }, undefined)).toEqual({ ok: false, why: "job.status.job_id is not valid" });
  });
});

describe("decodeJobByRun (rev 14 §8.6)", () => {
  test("the run's latest job, or an orphan intent with its post-check result if any", () => {
    expect(decodeJobByRun(job(VM_A, "PATCHING", "STARTED"))).toMatchObject({ ok: true, value: { kind: "job", job: { jobId: J, state: "PATCHING" } } });
    expect(decodeJobByRun({ intent: { intent_id: "int-0001", state: "orphan" } })).toEqual({ ok: true, value: { kind: "orphan", intentId: "int-0001" } });
    expect(decodeJobByRun({ intent: { intent_id: "int-0001", state: "orphan" }, post: "not-checked" })).toEqual({ ok: true, value: { kind: "orphan", intentId: "int-0001", post: "not-checked" } });
    expect(decodeJobByRun({ intent: { intent_id: "int-0001", state: "running" } })).toEqual({ ok: false, why: 'job.status.intent.state is not valid: "running"' });
  });

  test("a voided intent (rev 15 §8.6) decodes, and never with a post-check result", () => {
    expect(decodeJobByRun({ intent: { intent_id: "int-0002", state: "void" } })).toEqual({ ok: true, value: { kind: "void", intentId: "int-0002" } });
    expect(decodeJobByRun({ intent: { intent_id: "int-0002", state: "void" }, post: "clean" })).toEqual({ ok: false, why: "job.status: a voided intent has no post-check result" });
    expect(decodeJobByRun({ intent: { intent_id: "int 1", state: "orphan" } })).toEqual({ ok: false, why: 'job.status.intent.intent_id is not valid: "int 1"' });
    expect(decodeJobByRun({ intent: { intent_id: "int-0001", state: "orphan" }, job_id: J })).toEqual({ ok: false, why: "job.status: unknown key job_id" });
  });
});

describe("jobOutcome", () => {
  const st = (state: string, instanceState: string): JobStatus => ({ jobId: J, state, instanceState, ended: true, endTime: 0, endText: JOB_END });
  test.each([
    ["SUCCEEDED", "SUCCEEDED", "ok", false],
    ["SUCCEEDED", "SUCCEEDED_REBOOT_REQUIRED", "ok", true],
    ["COMPLETED_WITH_ERRORS", "FAILED", "failed", false],
    ["SUCCEEDED", "FAILED", "failed", false],
    ["SUCCEEDED", "NO_AGENT_DETECTED", "failed", false],
    ["CANCELED", "APPLYING_PATCHES", "unknown", false],
    ["TIMED_OUT", "TIMED_OUT", "unknown", false],
    ["SUCCEEDED", "ACKED", "unknown", false],
  ] as const)("%s with the VM %s is %s", (state, instance, outcome, reboot) => {
    expect(jobOutcome(st(state, instance))).toEqual({ outcome, reboot, why: `${state}, VM ${instance}` });
  });
});

describe("waitJob", () => {
  async function minted(jobs: Record<string, unknown>[]) {
    const t = gceExec({ vms: { [VM_A]: { inventory: [inventory()], jobs } } });
    const s = newGceSession(VM_A);
    await gceRead(GCE, t.exec, s, "inventory");
    return { ...t, s };
  }

  test("polls until the job ends", async () => {
    const { exec, s } = await minted([job(VM_A, "PATCHING", "STARTED"), job(VM_A, "PATCHING", "APPLYING_PATCHES"), job(VM_A, "SUCCEEDED", "SUCCEEDED", JOB_END)]);
    const clock = fakeClock(0);
    const r = await waitJob(GCE, exec, s, J, clock);
    expect(r.ok && r.value.state).toBe("SUCCEEDED");
    expect(clock.slept).toEqual([30_000, 30_000]);
  });

  test("a job still running at the end of the wait is a failure", async () => {
    const { exec, s } = await minted([job(VM_A, "PATCHING", "APPLYING_PATCHES")]);
    const clock = fakeClock(0);
    expect(await waitJob(GCE, exec, s, J, clock, { everyMs: 60_000, forMs: 120_000 })).toEqual({ ok: false, why: `job ${J} still PATCHING after 2 min` });
    expect(clock.slept).toEqual([60_000, 60_000]);
  });

  test("waitPost polls until the broker's post-check result, within the read window", async () => {
    const { exec, s } = await minted([job(VM_A, "SUCCEEDED", "SUCCEEDED", JOB_END), job(VM_A, "SUCCEEDED", "SUCCEEDED", JOB_END, "clean")]);
    const clock = fakeClock(parseTime(JOB_END)!);
    const r = await waitPost(GCE, exec, s, J, clock, parseTime(JOB_END)! + 55 * 60_000);
    expect(r.ok && r.value.post).toBe("clean");
    expect(clock.slept).toEqual([60_000]);
  });

  test("no post-check result by the end of the read window is a failure", async () => {
    const { exec, s } = await minted([job(VM_A, "SUCCEEDED", "SUCCEEDED", JOB_END)]);
    const end = parseTime(JOB_END)!;
    const clock = fakeClock(end);
    expect(await waitPost(GCE, exec, s, J, clock, end + 5 * 60_000)).toEqual({ ok: false, why: "no result from the broker's post-check by the end of the read window" });
    expect(clock.now()).toBe(end + 5 * 60_000);
  });

  test("a lost status read ends the wait with its reason", async () => {
    const t = gceExec({ vms: { [VM_A]: { inventory: [inventory()], replies: { "job.status": { status: "withheld", reason: "locked" } } } } });
    const s = newGceSession(VM_A);
    await gceRead(GCE, t.exec, s, "inventory");
    expect(await waitJob(GCE, t.exec, s, J, fakeClock(0))).toEqual({ ok: false, why: "job.status: broker withheld: locked" });
  });

  test("waitPost checks the read window before every read: an ended window sends nothing, a late read stops the wait (binding)", async () => {
    const end = parseTime(JOB_END)!;
    const { exec, s, requests } = await minted([job(VM_A, "SUCCEEDED", "SUCCEEDED", JOB_END)]);
    expect(await waitPost(GCE, exec, s, J, fakeClock(end + 56 * 60_000), end + 55 * 60_000)).toEqual({ ok: false, why: "job.status: not asked: the run's read window has ended" });
    expect(requests).toHaveLength(1);
    const clock = fakeClock(end);
    const slow: typeof exec = async (argv, o) => {
      const r = await exec(argv, o);
      await clock.sleep(10 * 60_000);
      return r;
    };
    expect(await waitPost(GCE, slow, s, J, clock, end + 15 * 60_000)).toEqual({ ok: false, why: "no result from the broker's post-check by the end of the read window" });
    expect(requests.filter((q) => q.params.verb === "job.status")).toHaveLength(2);
  });
});
