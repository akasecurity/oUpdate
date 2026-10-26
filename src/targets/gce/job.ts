// A patch job's status (CRB-b129 §1 `job.status`, chain-recorded job ids only) and what it means to the caller. The
// answer shape and the state names are rev 13 §8.6 (open question Q-6); a change lands in this file only. `post` is the
// broker's own post-check result once it has finished: clean, drift (the VM is suspended until a card acknowledges it)
// or not-checked (no fresh inventory in 30 min, also suspended). It is the authority on the job's effect. A Google patch job
// ends SUCCEEDED, COMPLETED_WITH_ERRORS, CANCELED or TIMED_OUT; the VM's own state is the instance detail. Only SUCCEEDED
// on both is ok; a failure on the VM is failed; a cancel, a timeout or any other mix is unknown.

import type { Exec } from "../../apply/exec.ts";
import type { Decoded } from "../nas/answer.ts";
import { isObj, obj, optStr, reqStr } from "../strict.ts";
import { gceRead, type GceBroker, type GceSession } from "./broker.ts";
import { JOB_ID, parseTime } from "./verbs.ts";

const RUNNING: readonly string[] = ["STARTED", "INSTANCE_LOOKUP", "PATCHING"];
const ENDED: readonly string[] = ["SUCCEEDED", "COMPLETED_WITH_ERRORS", "CANCELED", "TIMED_OUT"];
const INSTANCE: readonly string[] = [
  "PENDING", "INACTIVE", "NOTIFIED", "STARTED", "DOWNLOADING_PATCHES", "APPLYING_PATCHES", "REBOOTING", "SUCCEEDED",
  "SUCCEEDED_REBOOT_REQUIRED", "FAILED", "ACKED", "TIMED_OUT", "RUNNING_PRE_PATCH_STEP", "RUNNING_POST_PATCH_STEP", "NO_AGENT_DETECTED",
];

const POST = ["clean", "drift", "not-checked"] as const;
export type PostCheck = (typeof POST)[number];

export interface JobStatus {
  jobId: string;
  state: string;
  instanceState: string;
  ended: boolean;
  endTime?: number;
  endText?: string;
  post?: PostCheck;
}

/** answer: the job.status reply's fields without run_id and seq (rev 13 §8.6). With no expected job id (the VM's job after a patch with no reply), any job id inside its rule is taken. */
export function decodeJob(answer: unknown, expected: string | undefined): Decoded<JobStatus> {
  try {
    const o = obj(answer, "job.status", ["job_id", "state", "instance_state", "end_time", "post"]);
    if (expected !== undefined && o.job_id !== expected) throw new Error(`job.status names another job (expected ${expected})`);
    if (typeof o.job_id !== "string" || !JOB_ID.test(o.job_id)) throw new Error("job.status.job_id is not valid");
    const jobId = o.job_id;
    const state = reqStr(o, "state", "job.status");
    if (!RUNNING.includes(state) && !ENDED.includes(state)) throw new Error(`job.status.state is not a known state: ${JSON.stringify(state.slice(0, 40))}`);
    const instanceState = reqStr(o, "instance_state", "job.status");
    if (!INSTANCE.includes(instanceState)) throw new Error(`job.status.instance_state is not a known state: ${JSON.stringify(instanceState.slice(0, 40))}`);
    const ended = ENDED.includes(state);
    const endText = optStr(o, "end_time", "job.status");
    if (ended && endText === undefined) throw new Error("job.status: an ended job needs end_time");
    if (!ended && endText !== undefined) throw new Error("job.status: a running job has no end_time");
    if (o.post !== undefined && !(POST as readonly unknown[]).includes(o.post)) throw new Error(`job.status.post is not a known result: ${JSON.stringify(String(o.post).slice(0, 40))}`);
    if (!ended && o.post !== undefined) throw new Error("job.status: a running job has no post-check result");
    if (endText === undefined) return { ok: true, value: { jobId, state, instanceState, ended } };
    const endTime = parseTime(endText);
    if (endTime === undefined) throw new Error("job.status.end_time is not an RFC 3339 UTC time");
    return { ok: true, value: { jobId, state, instanceState, ended, endTime, endText, ...(o.post !== undefined ? { post: o.post as PostCheck } : {}) } };
  } catch (e) {
    return { ok: false, why: e instanceof Error ? e.message : String(e) };
  }
}

export type JobOutcome = { outcome: "ok" | "failed" | "unknown"; reboot: boolean; why: string };

export function jobOutcome(j: JobStatus): JobOutcome {
  const why = `${j.state}, VM ${j.instanceState}`;
  if (j.state === "SUCCEEDED" && (j.instanceState === "SUCCEEDED" || j.instanceState === "SUCCEEDED_REBOOT_REQUIRED")) return { outcome: "ok", reboot: j.instanceState === "SUCCEEDED_REBOOT_REQUIRED", why };
  if (j.state === "COMPLETED_WITH_ERRORS" || ["FAILED", "NO_AGENT_DETECTED", "INACTIVE"].includes(j.instanceState)) return { outcome: "failed", reboot: false, why };
  return { outcome: "unknown", reboot: false, why };
}

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}
export const realClock: Clock = { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };

/** The job's duration (1800 s, CRB-b129 §2.4) plus 5 min, polled every 30 s. */
export const JOB_WAIT = { everyMs: 30_000, forMs: 35 * 60_000 };

export async function waitJob(b: GceBroker, exec: Exec, s: GceSession, jobId: string, clock: Clock, w = JOB_WAIT): Promise<Decoded<JobStatus>> {
  const until = clock.now() + w.forMs;
  for (;;) {
    const r = await gceRead(b, exec, s, "job.status", { job_id: jobId });
    if (!r.ok) return r;
    const d = decodeJob(r.answer, jobId);
    if (!d.ok || d.value.ended) return d;
    if (clock.now() >= until) return { ok: false, why: `job ${jobId} still ${d.value.state} after ${Math.round(w.forMs / 60_000)} min` };
    await clock.sleep(w.everyMs);
  }
}

const INTENT_ID = /^[A-Za-z0-9._:-]{1,80}$/;

/**
 * job.status by run ({run_id, vm}, rev 15 §8.6): the run's latest job, or its latest intent with no job: an orphan (the
 * execute answer was lost; the VM is suspended) or a voided intent (refused `locked` before the send; nothing ran).
 */
export type JobByRun = { kind: "job"; job: JobStatus } | { kind: "orphan"; intentId: string; post?: PostCheck } | { kind: "void"; intentId: string };

export function decodeJobByRun(answer: unknown): Decoded<JobByRun> {
  if (!isObj(answer) || answer.intent === undefined) {
    const d = decodeJob(answer, undefined);
    return d.ok ? { ok: true, value: { kind: "job", job: d.value } } : d;
  }
  try {
    const o = obj(answer, "job.status", ["intent", "post"]);
    const i = obj(o.intent, "job.status.intent", ["intent_id", "state"]);
    const intentId = reqStr(i, "intent_id", "job.status.intent", INTENT_ID);
    const state = reqStr(i, "state", "job.status.intent", /^(orphan|void)$/);
    if (o.post !== undefined && !(POST as readonly unknown[]).includes(o.post)) throw new Error(`job.status.post is not a known result: ${JSON.stringify(String(o.post).slice(0, 40))}`);
    if (state === "void") {
      if (o.post !== undefined) throw new Error("job.status: a voided intent has no post-check result");
      return { ok: true, value: { kind: "void", intentId } };
    }
    return { ok: true, value: { kind: "orphan", intentId, ...(o.post !== undefined ? { post: o.post as PostCheck } : {}) } };
  } catch (e) {
    return { ok: false, why: e instanceof Error ? e.message : String(e) };
  }
}

/** The broker's post-check is polled this often. */
export const POST_EVERY_MS = 60_000;

/**
 * Polls the job until the broker's post-check result appears, or until `until` (epoch ms on the clock), the caller's
 * read window: the run answers reads until 1 h after the job's end (rev 12 §8.1). A lost read ends the wait.
 */
export async function waitPost(b: GceBroker, exec: Exec, s: GceSession, jobId: string, clock: Clock, until: number): Promise<Decoded<JobStatus>> {
  for (;;) {
    // Checked before every read, so a late reply never leads to a read past the window.
    if (clock.now() > until) return { ok: false, why: "job.status: not asked: the run's read window has ended" };
    const r = await gceRead(b, exec, s, "job.status", { job_id: jobId });
    if (!r.ok) return r;
    const d = decodeJob(r.answer, jobId);
    if (!d.ok || d.value.post !== undefined) return d;
    if (clock.now() + POST_EVERY_MS > until) return { ok: false, why: "no result from the broker's post-check by the end of the read window" };
    await clock.sleep(POST_EVERY_MS);
  }
}
