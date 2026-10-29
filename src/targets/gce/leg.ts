// The os-packages leg over the gce-patch reach. The VMs run one at a
// time, in the reach's order. For each: one inventory read (the VM's full upgrade set, with the broker's archive-index
// and dependency check of every candidate); the rule review (origin, cooldown, the 200-name cap); both models; then,
// only with `apply: true` on a real run and inside the run's 2 h binding, one patch request carrying that VM's approved
// names. If everything is held, no request is sent. After a started job the leg waits for the job's end, for an
// inventory newer than it and for the broker's post-check, all inside the hour the run answers after the job's end. The
// broker's post-check is the authority; the leg's own full compare is an extra check, and any change it did not approve,
// or any disagreement with the broker, is trouble. "patched" is said only when the job, the broker's post-check and the
// compare are all clean. A VM that ends with any trouble stops every later patch this run. Summaries are fixed phrases and
// counts; names, versions and every broker or decode reason go to the log.

import { requestLine } from "../broker-client.ts";
import type { LegResult, OsPackagesLeg } from "../model.ts";
import type { ReviewerPair } from "../../review-pair.ts";
import type { OpenGce } from "../reach.ts";
import type { LegContext, TargetFs } from "../run.ts";
import { decodeInventory, pkgKey, type Inventory } from "./answer.ts";
import { AFTER_JOB_MS, BINDING_MS, gceRead, newGceSession, type GceSession } from "./broker.ts";
import { compareInventory, type InventoryDiff } from "./compare.ts";
import { decodeJobByRun, jobOutcome, waitJob, waitPost, type Clock, type JobOutcome, type PostCheck } from "./job.ts";
import { gcePatch, patchSummary, type PatchLatch, type PatchResult } from "./patch.ts";
import { freshInventory, POST_WAIT } from "./post.ts";
import { aptPrompt, aptRules, packageLine, reviewApt } from "./review.ts";
import { noteSeen, readSeen, writeSeen, type Seen } from "./seen.ts";
import { patchVerdict } from "./verdict.ts";
import { verdictReviewers } from "../broker/broker.ts";

export interface GceLegDeps {
  /** The first and the second reviewer (the targets file's `reviewer` and `secondReviewer`). */
  reviewers: ReviewerPair;
  fs: TargetFs;
  clock: Clock;
  /** The run's one latch (run.ts runTargets), shared by every gce-patch target. */
  latch: PatchLatch;
}

interface VmResult {
  summary: string;
  trouble: boolean;
}

/** The patch is not sent this close to the end of the run's 2 h binding (the request itself takes seconds to arrive). */
const SEND_MARGIN_MS = 5 * 60_000;
/** The last post-job read starts this long before the run stops answering (a job.status call waits up to 75 s). */
const READ_MARGIN_MS = 5 * 60_000;

const heldTail = (n: number) => (n ? ` · held ${n}` : "");
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
/** Log lines carry the reasons, but a hostile answer cannot make one kilobytes long. */
const clip = (s: string) => (s.length > 400 ? `${s.slice(0, 400)}…` : s);

const POST_PHRASE: Record<PostCheck, string | undefined> = {
  clean: undefined,
  drift: "FLAG — the broker's post-check found drift (the VM is suspended until it is acknowledged)",
  "not-checked": "FAILED — the broker's post-check could not check the VM (it is suspended; outcome unknown)",
};

async function afterJob(vm: string, g: OpenGce, s: GceSession, inv: Inventory, p: Extract<PatchResult, { outcome: "started" }>, deps: GceLegDeps, latch: PatchLatch, nHeld: number, lines: string[]): Promise<VmResult> {
  const job = await waitJob(g.broker, g.exec, s, p.jobId, deps.clock);
  const out: JobOutcome = job.ok ? jobOutcome(job.value) : { outcome: "unknown", reboot: false, why: job.why };
  lines.push(clip(`job ${p.jobId}: ${out.outcome} (${out.why})`));
  // With no end time from the broker, the job has not ended as far as the caller knows, so its end is no earlier than now:
  // only an inventory newer than now can show its effect, and the run answers until at least an hour from now.
  const end = job.ok && job.value.endTime !== undefined ? job.value.endTime : deps.clock.now();
  const readsUntil = end + AFTER_JOB_MS - READ_MARGIN_MS;
  const fresh = await freshInventory(g.broker, g.exec, s, end, deps.clock, Math.min(deps.clock.now() + POST_WAIT.forMs, readsUntil));
  let diff: InventoryDiff | undefined;
  if (!fresh.ok) lines.push(clip(fresh.why));
  else {
    const reviewed = new Map(inv.candidates.filter((c) => p.sent.includes(c.name)).map((c) => [pkgKey(c), c.candidate]));
    diff = compareInventory(inv, fresh.value, reviewed);
    lines.push(`post-job inventory of ${fresh.value.updateText}`);
    for (const k of diff.patched) lines.push(`  patched ${k}`);
    for (const k of diff.notInstalled) lines.push(`  NOT INSTALLED ${k}`);
    for (const k of diff.unapproved) lines.push(`  UNAPPROVED ${k}`);
  }
  const post = job.ok && job.value.post !== undefined ? job : await waitPost(g.broker, g.exec, s, p.jobId, deps.clock, readsUntil);
  const verdict = post.ok ? post.value.post : undefined;
  lines.push(post.ok ? `broker post-check: ${verdict}` : clip(`broker post-check: ${post.why}`));

  const parts: string[] = [];
  let trouble = false;
  const bad = (part: string) => {
    parts.push(part);
    trouble = true;
  };
  if (diff) {
    const clean = out.outcome === "ok" && verdict === "clean" && !diff.unapproved.length;
    parts.push(`${clean ? "patched" : "at reviewed version"} ${diff.patched.length}`);
    if (diff.unapproved.length) bad(`FLAG — ${diff.unapproved.length} change(s) not approved after the job`);
    if (diff.notInstalled.length) bad(`FAILED — ${diff.notInstalled.length} approved package(s) not installed`);
  } else bad("error: no inventory newer than the job's end");
  if (out.outcome !== "ok") bad(job.ok ? `FAILED — job ${out.why}` : "FAILED — job status unknown");
  if (!post.ok || verdict === undefined) bad("FAILED — no result from the broker's post-check");
  else if (POST_PHRASE[verdict]) bad(POST_PHRASE[verdict]!);
  // The broker's post-check is the authority; the caller's compare must agree with it.
  if (diff && (verdict === "clean" || verdict === "drift") && (verdict === "clean") !== !diff.unapproved.length) bad("FLAG — the broker's post-check and the caller's compare disagree");
  if (p.dropped.length) parts.push(`dropped by the broker ${p.dropped.length}`);
  if (out.reboot) parts.push("reboot pending");
  if (trouble) latch.stopped = vm;
  return { summary: `${parts.join(" · ")}${heldTail(nHeld)}`, trouble };
}

/**
 * After a patch with no reply: the run's latest job, an orphan or voided intent, or no job, for
 * the log only; the outcome stays unknown and the VM latched whatever it says. Not asked once the run's binding is past
 * `until`.
 */
async function jobByRun(g: OpenGce, s: GceSession, clock: Clock, until: number): Promise<string> {
  if (clock.now() > until) return "not asked: the broker run's binding has ended (whether the patch ran is unknown)";
  const j = await gceRead(g.broker, g.exec, s, "job.status", { vm: s.vm });
  if (!j.ok) return `${j.why} (whether the patch ran is unknown)`;
  const d = decodeJobByRun(j.answer);
  if (!d.ok) return `${d.why} (whether the patch ran is unknown)`;
  if (d.value.kind === "void") return `a voided intent ${d.value.intentId} (nothing ran)`;
  if (d.value.kind === "orphan") return `an orphan intent ${d.value.intentId}${d.value.post ? `, post-check ${d.value.post}` : ""} (no job was recorded; the VM is suspended until it is acknowledged)`;
  const job = d.value.job;
  return `job ${job.jobId} ${job.state}, VM ${job.instanceState}${job.post ? `, post-check ${job.post}` : ""}`;
}

async function oneVm(vm: string, leg: OsPackagesLeg, ctx: LegContext, g: OpenGce, deps: GceLegDeps, seen: Seen | undefined, latch: PatchLatch, lines: string[]): Promise<VmResult> {
  const notChecked = (why: string, phrase: string): VmResult => {
    lines.push(clip(why));
    return { summary: `not checked — ${phrase}`, trouble: true };
  };
  const s = newGceSession(vm);
  // This first read mints the VM's run, so its binding ends no earlier than two hours from now.
  const minted = deps.clock.now();
  const r = await gceRead(g.broker, g.exec, s, "inventory");
  if (!r.ok) return notChecked(r.why, "error reading the inventory");
  const d = decodeInventory(r.answer, vm);
  if (!d.ok) return notChecked(d.why, "the inventory answer failed its rules");
  const inv = d.value;
  lines.push(`${inv.os.shortName} ${inv.os.version} ${inv.os.architecture} (kernel ${inv.os.kernelVersion}), instance ${inv.instanceId}, inventory of ${inv.updateText}, ${inv.installed.length} installed, broker run ${s.runId}`);
  if (!inv.candidates.length) return { summary: "nothing to update", trouble: false };
  const rules = seen
    ? aptRules(inv, noteSeen(seen, vm, inv.candidates, ctx.now), ctx.now, leg.cooldownDays)
    : { eligible: [], held: inv.candidates.map((c) => ({ key: pkgKey(c), why: "first-seen dates unreadable" })) };
  for (const c of rules.eligible) lines.push(`  eligible ${packageLine(c)}`);
  for (const h of rules.held) lines.push(`  held ${h.key}: ${h.why}`);
  const nHeld = rules.held.length;
  if (!rules.eligible.length) return { summary: `held ${nHeld}`, trouble: false };
  const v = await reviewApt(deps.reviewers, aptPrompt({ vm, os: `${inv.os.shortName} ${inv.os.version}`, packages: rules.eligible }));
  lines.push(...v.lines);
  if (!v.approved) {
    const who = v.first !== "APPROVE" ? `first ${v.first}` : `second ${v.second}`;
    return { summary: `blocked (review: ${who}) · held ${inv.candidates.length}`, trouble: true };
  }
  const names = new Set(rules.eligible.map((c) => c.name));
  if (!leg.apply || ctx.dryRun) return { summary: `would patch ${names.size}${heldTail(nHeld)}`, trouble: false };
  // Not sent: nothing can run, so no latch; the VM is reviewed again on the next run.
  if (deps.clock.now() > minted + BINDING_MS - SEND_MARGIN_MS) {
    lines.push("patch: not asked: the review ran past the broker run's 2 h binding");
    return { summary: `blocked (patch: not asked: the review ran past the broker run's 2 h binding)${heldTail(nHeld)}`, trouble: true };
  }
  // Both reviewers approved, so both are configured.
  const verdict = patchVerdict(inv, names, verdictReviewers({ first: deps.reviewers.first!.name, second: deps.reviewers.second!.name }, g.broker.reviewerKeys), s);
  const p = await gcePatch(g.broker, g.exec, s, verdict, latch, leg.approvalWaitS);
  lines.push(clip(requestLine(p)));
  if (p.outcome === "unknown") lines.push(clip(`job.status after the patch reply was lost: ${await jobByRun(g, s, deps.clock, minted + BINDING_MS - READ_MARGIN_MS)}`));
  if (p.outcome !== "started") return { summary: `${patchSummary(p)}${heldTail(nHeld)}`, trouble: true };
  return afterJob(vm, g, s, inv, p, deps, latch, nHeld, lines);
}

export async function osPackagesLeg(leg: OsPackagesLeg, ctx: LegContext, deps: GceLegDeps): Promise<LegResult> {
  const g = ctx.reach;
  if ("plugin" in g || g.kind !== "gce-patch") return { lines: [], summary: `not checked — error: leg os-packages over reach ${g.kind} not built`, trouble: true };
  const lines: string[] = [];
  const parts: string[] = [];
  let trouble = false;
  const sr = await readSeen(deps.fs, leg.seenTo);
  const latch = deps.latch;
  if (!sr.ok) {
    parts.push(`error: ${sr.why}; every package held`);
    trouble = true;
    latch.stopped ??= ctx.target.id;
  }
  const seen = sr.ok ? sr.seen : undefined;
  for (const vm of g.vms) {
    const vmLines: string[] = [];
    let r: VmResult;
    try {
      r = await oneVm(vm, leg, ctx, g, deps, seen, latch, vmLines);
    } catch (e) {
      // A throw after the patch request may hide a running job; the lines so far (the request id) are kept.
      vmLines.push(clip(`error: ${msg(e)}`));
      r = { summary: "error: the leg failed on this VM (see the targets log)", trouble: true };
      latch.stopped ??= vm;
    }
    // Any trouble on a VM (not checked, a review FLAG, a patch not sent or unclean) stops every later patch this run.
    if (r.trouble) latch.stopped ??= vm;
    lines.push(`--- vm ${vm} ---`, ...vmLines, `${vm}: ${r.summary}`);
    parts.push(`${vm}: ${r.summary}`);
    trouble ||= r.trouble;
  }
  if (seen && !ctx.dryRun) {
    const err = await writeSeen(deps.fs, leg.seenTo, seen);
    if (err) {
      parts.push(`error: first-seen dates not saved to ${leg.seenTo} (${err})`);
      trouble = true;
      latch.stopped ??= ctx.target.id;
    }
  }
  return { lines, summary: parts.join(" · "), trouble };
}
