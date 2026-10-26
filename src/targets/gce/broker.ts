// The gce-patch reach's reads (spec §2, §5; CRB-b129 §1 `gce.osconfig.read`): `credreq <read action> <vm> --param
// verb=<verb> …` through the shared credreq door. The first inventory of a VM mints the broker's run for that VM; every
// later read and the patch carry that run id, and every reply must name it. Every answer carries a per-run seq, 1, 2, 3 …
// with no gap, refusals included, and the broker's boot id; a new boot means the broker restarted and the run is dead
// (takeSeq). Each inventory answer is kept with its seq for the verdict's evidence sha (rev 14a §8.4, evidenceText). A
// refusal is {run_id?, seq, boot, refused: "gce-osc: <reason>"}, with no run id only before one is minted ("unknown vm",
// "vm not set up"). A review-time refusal (unknown vm, unknown job, a job verdict refused before the card) takes a seq
// too and comes as status "denied" with that refusal's JSON text as the reason; a card denied or expired, or a plain
// refusal with no §8 shape, takes none (CRB-b129 slice C d0e53a5; reasonRefusal). These rules are CRB-b129
// rev 15a §8 (Q-1); a change lands here only.

import type { Exec } from "../../apply/exec.ts";
import { credreqCall, isObj, short, tail, type Param } from "../credreq.ts";
import { BOOT_ID, GCE_READ_VERBS, JOB_ID, RUN_ID, type GceReadVerb } from "./verbs.ts";

export interface GceBroker {
  /** The credreq binary (absolute path, or a name on PATH). */
  credreq: string;
  baseUrl: string;
  readAction: string;
  /** Absent: the reach is review only. */
  patchAction?: string;
}

/**
 * One VM's night on the broker: its run id once minted, the broker's boot id and every seq it answered under that boot,
 * and every inventory answer with its seq. dead: the broker restarted (a new boot) during the run, so only the
 * chain-backed job.status {run_id, vm} still answers, no inventory counts and no patch is sent (rev 15a §8).
 */
export interface GceSession {
  vm: string;
  runId?: string;
  boot?: string;
  dead?: boolean;
  seqs: number[];
  evidence: { seq: number; answer: string }[];
}
export const newGceSession = (vm: string): GceSession => ({ vm, seqs: [], evidence: [] });

/** answer: the reply's own fields (§8.3, §8.6), beside which the broker sent run_id and seq. */
export type GceReadResult = { ok: true; answer: Record<string, unknown> } | { ok: false; why: string };

/**
 * The text one inventory answer contributes to the verdict's evidence sha (CRB-b129 rev 14a §8.4): the whole answer object,
 * run_id, seq and boot included, re-serialized with JSON.stringify in the key order it was received in (JSON.parse keeps it),
 * whatever whitespace the transport added. No other canonicalization and no Unicode normalization. The sha itself
 * (nas/broker.ts evidenceSha) is sha256 over these texts' UTF-8 in ascending seq, with nothing between; refused and
 * failed reads add nothing. This is the one place the per-answer bytes are chosen.
 */
export const evidenceText = (answer: Record<string, unknown>): string => JSON.stringify(answer);

/** credreq waits the verb's deadline plus this margin. */
export const WAIT_MARGIN_S = 15;
/** job.status takes the job id, or the VM: after a patch with no reply, the run's latest job is asked for (rev 14 §8.6). */
const SLOTS: Record<GceReadVerb, string[][]> = { inventory: [[]], "job.status": [["job_id"], ["vm"]] };

export async function gceRead(b: GceBroker, exec: Exec, s: GceSession, verb: GceReadVerb, slots: Record<string, string> = {}): Promise<GceReadResult> {
  const keys = Object.keys(slots);
  if (!SLOTS[verb].some((want) => keys.length === want.length && want.every((k) => Object.hasOwn(slots, k)))) {
    return { ok: false, why: `not asked: ${verb} takes ${SLOTS[verb].map((w) => w.join(", ") || "no parameters").join(", or ")}` };
  }
  if (slots.job_id !== undefined && !JOB_ID.test(slots.job_id)) return { ok: false, why: `not asked: ${verb}: job id is not valid` };
  if (slots.vm !== undefined && slots.vm !== s.vm) return { ok: false, why: `not asked: ${verb}: vm ${slots.vm.slice(0, 64)} is not this run's VM (${s.vm})` };
  if (verb === "job.status" && !s.runId) return { ok: false, why: `not asked: ${verb} needs the VM's broker run` };
  // After a restart only the chain-backed job.status by run answers (rev 15a §8); nothing else is sent.
  const recovery = verb === "job.status" && slots.vm !== undefined;
  if (s.dead && !recovery) return { ok: false, why: `not asked: ${verb}: the broker restarted, so the run is dead` };
  const params: Param[] = Object.entries(slots).map(([key, value]) => ({ key, value }));
  if (s.runId) params.push({ key: "run_id", value: s.runId });
  const spec = GCE_READ_VERBS[verb];
  const c = await credreqCall(b, exec, b.readAction, s.vm, verb, params, spec.deadlineS + WAIT_MARGIN_S);
  if (!c.ok) return { ok: false, why: `${verb}: ${c.why}` };
  const { status, reason } = c.reply;
  const denied = status === "denied" ? reasonRefusal(reason) : undefined;
  if (status !== "approved" && !denied) return { ok: false, why: `${verb}: broker ${status}${tail(reason)}` };
  const result = denied ?? c.reply.result;
  if (!isObj(result)) return { ok: false, why: `${verb}: broker result is not an object` };
  const bad = takeSeq(s, result, recovery);
  if (bad) return { ok: false, why: `${verb}: ${bad}` };
  // A VM not in the catalog, or not set up (no OS Config agent, no enable-osconfig, no service account), is refused before
  // any run exists; the leg reports it "not checked". Once the run is minted, a refusal must name it.
  if (typeof result.refused === "string") {
    if (s.runId !== undefined && result.run_id !== s.runId) return { ok: false, why: `${verb}: the broker's run changed (${String(result.run_id ?? "none").slice(0, 64)}, expected ${s.runId}): ${short(result.refused)}` };
    return { ok: false, why: `${verb}: refused by the broker: ${short(result.refused)}` };
  }
  const id = result.run_id;
  if (typeof id !== "string" || !RUN_ID.test(id)) return { ok: false, why: `${verb}: the broker gave no valid run id` };
  if (s.runId !== undefined && id !== s.runId) return { ok: false, why: `${verb}: the broker's run changed (${id}, expected ${s.runId})` };
  // The cap is on what came back, as received; a broker over its own cap refuses (`answer too large`), never cuts.
  if (new TextEncoder().encode(c.raw).length > spec.capBytes) return { ok: false, why: `${verb}: answer is over the ${spec.capBytes}-byte cap` };
  if (verb === "inventory") s.evidence.push({ seq: result.seq as number, answer: evidenceText(result) });
  s.runId ??= id;
  const { run_id: _r, seq: _s, boot: _b, ...answer } = result;
  return { ok: true, answer };
}

/**
 * A review-time §8 refusal sent as a deny reason (CRB-b129 slice C d0e53a5): the reason, trimmed, is the JSON
 * text of {run_id?, seq, boot, refused: "gce-osc: <reason>"} and is read as that answer, seq included. Anything else (not
 * JSON, or JSON without that shape) is undefined: a plain denial that took no seq.
 */
export function reasonRefusal(reason: string | undefined): Record<string, unknown> | undefined {
  if (!reason) return undefined;
  let o: unknown;
  try {
    o = JSON.parse(reason.trim());
  } catch {
    return undefined;
  }
  if (!isObj(o) || typeof o.refused !== "string" || !o.refused.startsWith("gce-osc: ") || !("seq" in o) || !("boot" in o)) return undefined;
  return o;
}

/**
 * The one seq and boot check for every broker answer on the VM's run: reads, refusals and patch replies (rev 15a §8:
 * every answer carries a per-run seq, 1, 2, … in answer order, refusals included, and the broker's boot id; seq counts
 * per run per boot). Both are recorded before anything else in the answer is read. A missing seq or boot, a seq already
 * seen or any seq but the next one fails closed. A new boot means the broker restarted: the run is dead, which fails
 * every answer but the recovery job.status {run_id, vm} (recovery), and that one must start again at seq 1. Returns
 * why, or undefined when the answer is good.
 */
export function takeSeq(s: GceSession, result: Record<string, unknown>, recovery = false): string | undefined {
  const seq = result.seq;
  if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 1) return "the broker gave no valid seq";
  const boot = result.boot;
  if (typeof boot !== "string" || !BOOT_ID.test(boot)) return "the broker gave no valid boot";
  if (s.boot !== undefined && boot !== s.boot) {
    s.dead = true;
    if (!recovery) return `the broker restarted (boot ${boot.slice(0, 8)}…, was ${s.boot.slice(0, 8)}…): the run is dead`;
    if (seq !== 1) return `the broker's seq ${seq} under a new boot is not 1`;
    s.boot = boot;
    s.seqs = [seq];
    return undefined;
  }
  s.boot ??= boot;
  if (s.seqs.includes(seq)) return `the broker's seq ${seq} repeats`;
  // The caller sees every answer of its own run, so the seqs it gets run 1, 2, 3 … with no gap.
  const next = s.seqs.length ? Math.max(...s.seqs) + 1 : 1;
  if (seq !== next) return `the broker's seq ${seq} is not the next one (expected ${next})`;
  s.seqs.push(seq);
  return undefined;
}

/**
 * The run binding (rev 12 §8.1): reads and the patch request must come within 2 h of the run's mint (a patch whose card
 * is pending holds the binding until the card resolves), and once a job is recorded, inventory and job.status answer
 * until 1 h after the job's end. Later requests are refused (`run expired`).
 */
export const BINDING_MS = 2 * 60 * 60_000;
export const AFTER_JOB_MS = 60 * 60_000;
