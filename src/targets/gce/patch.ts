// The one patch request per VM (spec §5 caller rules; the broker spec `gce.osconfig.patch`): `credreq <patch action> <vm>
// --param verb=patch --param run_id=… --param-json verdict=…`. A card per job, one VM per job, never an empty list. The
// reply shape and the card statuses are the broker spec, and there is no window field (Q-10); a change lands
// in this file only. A pending card, a lost reply, an error or anything not recognized is unknown: the job may run. A
// broker refusal, or a card denied or expired, means nothing ran; that includes a card approved while the role is still
// busy ("role busy": the job never starts; the broker sends it 30 s before this request's deadline, inside credreq's wait),
// a VM the broker suspended after drift ("vm suspended", until a card acknowledges it), and a Lock epoch change right
// before the execute send ("locked": the broker voids the intent and does not suspend the VM, rev 15 §4.3). After any of
// these, no other VM is patched this run. A denied reply whose reason is a gce-osc §8 refusal (a job verdict refused
// before the card) is that refusal, seq included, not a card denial.

import type { Exec } from "../../apply/exec.ts";
import { credreqCall, isObj, short, tail, type Reply } from "../credreq.ts";
import { reasonRefusal, takeSeq, type GceBroker, type GceSession } from "./broker.ts";
import { approvedNames, type PatchVerdict } from "./verdict.ts";
import { JOB_ID, MAX_NAMES, PATCH_DEADLINE_S, PKG } from "./verbs.ts";

export type PatchResult = (
  | { outcome: "started"; jobId: string; sent: string[]; dropped: string[] }
  | { outcome: "refused"; sent: boolean }
  | { outcome: "unknown" }
) & { why: string; requestId?: string };

/**
 * One per `oupdate targets` run, shared by every gce-patch target (run.ts). stopped: set by the first VM (or target)
 * that ended with any trouble, to its name; no later VM gets a patch request. attempted: every VM a patch request was
 * about to be sent for, marked before sending, so no VM is sent two requests in one run.
 */
export interface PatchLatch {
  stopped?: string;
  attempted: Set<string>;
}
export const newLatch = (): PatchLatch => ({ attempted: new Set() });

export async function gcePatch(b: GceBroker, exec: Exec, s: GceSession, v: PatchVerdict, latch: PatchLatch, cardWaitS: number): Promise<PatchResult> {
  const no = (why: string): PatchResult => ({ outcome: "refused", sent: false, why: `patch: ${why}` });
  const names = approvedNames(v);
  if (!b.patchAction) return no("the reach names no patch action");
  if (!s.runId) return no("no broker run for this VM");
  if (latch.stopped) return no(`not asked: an earlier VM this run ended with trouble (${latch.stopped})`);
  if (s.dead) return no("not asked: the broker restarted, so the run is dead");
  if (!names.length) return no("not asked: no package is approved (an empty list is never sent)");
  if (names.length > MAX_NAMES) return no(`not asked: ${names.length} approved names, over the ${MAX_NAMES}-name cap`);
  if (names.some((n) => !PKG.test(n))) return no("not asked: an approved name is outside the package rule");
  if (latch.attempted.has(s.vm)) return no(`not asked: ${s.vm} already had a patch request this run`);
  latch.attempted.add(s.vm);
  let r: PatchResult;
  try {
    const params = [{ key: "run_id", value: s.runId }, { key: "verdict", value: JSON.stringify(v), json: true }];
    const c = await credreqCall(b, exec, b.patchAction, s.vm, "patch", params, PATCH_DEADLINE_S + cardWaitS);
    r = c.ok ? patchReply(s, names, c.reply) : { outcome: "unknown", why: `patch: ${c.why}` };
  } catch (e) {
    // An Exec that throws may have sent the request.
    r = { outcome: "unknown", why: `patch: ${short(e instanceof Error ? e.message : String(e))}` };
  }
  if (r.outcome === "unknown" || (r.outcome === "refused" && r.sent)) latch.stopped = s.vm;
  return r;
}

/** s: the VM's session, whose run the reply must name and whose seqs the reply's seq joins (broker.ts takeSeq). */
export function patchReply(s: GceSession, approved: string[], reply: Reply): PatchResult {
  const { status, reason } = reply;
  // A review-time refusal comes as status denied with its JSON as the reason; only denied is read so.
  const result = (status === "denied" ? reasonRefusal(reason) : undefined) ?? reply.result;
  const runId = s.runId!;
  const res = isObj(result) ? result : {};
  const rid = reply.requestId ? { requestId: reply.requestId } : {};
  // A broker answer (a refusal or a created job) carries a seq; a card status with no answer (pending, denied) does not.
  if (isObj(result) && Object.keys(result).length) {
    const bad = takeSeq(s, result);
    if (bad) return { outcome: "unknown", why: `patch: ${bad}`, ...rid };
  }
  if (typeof res.refused === "string") {
    if (res.run_id !== runId) return { outcome: "unknown", why: `patch: a refusal for another run (${String(res.run_id ?? "none")}, expected ${runId}): ${short(res.refused)}`, ...rid };
    return { outcome: "refused", sent: true, why: `patch: refused by the broker, nothing ran: ${short(res.refused)}`, ...rid };
  }
  if (status === "denied" || status === "expired") return { outcome: "refused", sent: true, why: `patch: card ${status}, nothing ran${tail(reason)}`, ...rid };
  if (status === "pending") return { outcome: "unknown", why: "patch: waits on a card on the page and may still run", ...rid };
  if (status !== "approved") return { outcome: "unknown", why: `patch: broker ${status}${tail(reason)}`, ...rid };
  if (res.run_id !== runId) return { outcome: "unknown", why: `patch: the broker's run changed (${String(res.run_id ?? "none")}, expected ${runId})`, ...rid };
  const jobId = res.job_id;
  if (typeof jobId !== "string" || !JOB_ID.test(jobId)) return { outcome: "unknown", why: "patch: approved with no valid job id: outcome unknown", ...rid };
  const sent = res.sent;
  const subset = Array.isArray(sent) && sent.length > 0 && new Set(sent).size === sent.length && sent.every((n) => typeof n === "string" && approved.includes(n));
  if (!subset) return { outcome: "unknown", why: `patch: job ${jobId}: the broker's sent list is not a non-empty subset of the approved names`, ...rid };
  const names = [...(sent as string[])].sort();
  const dropped = approved.filter((n) => !names.includes(n));
  const note = dropped.length ? `; the broker dropped ${dropped.length} before execute: ${dropped.join(" ")}` : "";
  return { outcome: "started", jobId, sent: names, dropped, why: `patch: job ${jobId} started for ${names.length} package(s)${note}`, ...rid };
}

/**
 * The summary fragment for a patch that did not start; every one carries a digest trouble word. Only the caller's own
 * reasons (a request not sent) reach the summary; the broker's text, which can name packages, stays in the log line.
 */
export function patchSummary(r: Exclude<PatchResult, { outcome: "started" }>): string {
  if (r.outcome === "refused") return r.sent ? "blocked — nothing ran (see the targets log)" : `blocked (${r.why})`;
  return "FAILED — patch outcome unknown, the patch may have run (the broker's own post-check covers it)";
}
