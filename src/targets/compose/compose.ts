// docker-compose over a reach that opens a broker session (the port of the previous shell updater's container section). It
// reads only through named verbs: the compose state, each ref's candidate from the registry (no pull, one read per ref),
// and each changed image's running evidence. It builds the diff per changed image the way that updater did, runs the grep
// pre-gate, and sends the ported prompt to the first model and, when that approves, to the second model. Any pre-gate
// hit or anything short of two APPROVEs holds every service. A service whose local image differs from its running one
// (drift) is reviewed like any other, but always held, and so is one with no running container. Only with `apply: true` on a real run does the leg ask
// compose.apply, where the broker binds every id and digest itself, and then image.prune (only the run id).

import type { ComposeLeg, LegResult, ParityFacts } from "../model.ts";
import type { LegContext } from "../run.ts";
import { stamp } from "../summary.ts";
import { decodeComposeState, decodeEvidence, type ComposeService, type ImageEvidence } from "../broker/answer.ts";
import { brokerRead, brokerWrite, composeRequest, verdictReviewers, writeSummary, writeLine, type OpenBroker } from "../broker/broker.ts";
import { layerDiffs, approvedAnswer, reviewDiff, structuralHits } from "./evidence.ts";
import { composePrompt } from "./prompt.ts";
import { reviewTwice, type ReviewerPair } from "./review.ts";

async function evidence(reach: OpenBroker, verb: "image.evidence" | "image.candidate", slots: Record<string, string>, label: string, lines: string[]): Promise<ImageEvidence | undefined> {
  const r = await brokerRead(reach.broker, reach.exec, reach.session, verb, slots);
  if (!r.ok) {
    lines.push(`${label}: ${r.why}`);
    return undefined;
  }
  const d = decodeEvidence(verb, r.rows);
  if (!d.ok) {
    lines.push(`${label}: ${d.why}`);
    return undefined;
  }
  return d.value;
}

/** Changed as the previous updater decided it: no candidate, not running, drifted, or a running id that is neither candidate id. */
const isChanged = (v: ComposeService, c: ImageEvidence | undefined) =>
  !c || !v.runningId || v.localId !== v.runningId || (v.runningId !== c.config && v.runningId !== c.digest);

/** `baseline`: the host's known-normal baseline for the review prompt (prompt.ts DEFAULT_BASELINE when absent). */
export async function composeLeg(leg: ComposeLeg, ctx: LegContext, reach: OpenBroker, reviewers: ReviewerPair, baseline?: string): Promise<LegResult> {
  const lines: string[] = [];
  const st = await brokerRead(reach.broker, reach.exec, reach.session, "compose.state");
  if (!st.ok) return { lines, summary: `not checked — ${st.why}`, trouble: true };
  const state = decodeComposeState(st.rows);
  if (!state.ok) return { lines, summary: `not checked — ${state.why}`, trouble: true };
  const build = new Set(state.value.build);
  for (const b of build) lines.push(`${b}: built locally; reported, never reviewed`);
  const services = state.value.services.filter((v) => !build.has(v.service));

  const candidates = new Map<string, ImageEvidence | undefined>();
  for (const ref of new Set(services.map((v) => v.ref))) candidates.set(ref, await evidence(reach, "image.candidate", { ref }, `${ref} candidate`, lines));
  const changed = services.filter((v) => isChanged(v, candidates.get(v.ref)));
  const drift = changed.filter((v) => v.runningId !== undefined && v.localId !== v.runningId).map((v) => v.service);
  const refs = [...new Set(changed.map((v) => v.ref))];
  // A service with no running container has no baseline of its own: held when another service on its ref is running
  // (that one is reviewed); a ref with no running service at all is BASELINE MISSING and holds the leg, as the previous updater did.
  const noBaseline = changed.filter((v) => v.runningId === undefined && changed.some((x) => x.ref === v.ref && x.runningId !== undefined)).map((v) => v.service);
  if (!refs.length) {
    lines.push("containers: all images up to date");
    return { lines, summary: "up to date", trouble: false, parity: { changed: [], pregate: [] } };
  }

  lines.push("--- layer diff ---");
  const diffs: { ref: string; diff: string }[] = [];
  const running = new Map<string, ImageEvidence | undefined>();
  for (const ref of refs) {
    // Services sharing a ref: each distinct running image is its own diff against the candidate, read one at a time.
    const ids = [...new Set(changed.filter((v) => v.ref === ref && v.runningId !== undefined).map((v) => v.runningId!))];
    for (const id of ids.length ? ids : [undefined]) {
      if (id && !running.has(id)) running.set(id, await evidence(reach, "image.evidence", { id }, `${ref} running`, lines));
      const diff = reviewDiff(id ? running.get(id) : undefined, candidates.get(ref));
      const label = ids.length > 1 ? `${ref} (running ${id!.slice(7, 19)})` : ref;
      lines.push(`  ${label}: running image -> candidate`, ...diff.split("\n").map((l) => `    ${l}`));
      diffs.push({ ref: label, diff });
    }
  }
  const all = layerDiffs(diffs);
  const hits = structuralHits(all);
  const v = await reviewTwice(reviewers, composePrompt(stamp(ctx.now).slice(0, 10), refs, all, baseline), approvedAnswer);
  lines.push(...v.lines);
  if (hits.length) lines.push("STRUCTURAL PRE-GATE: layer lines matched high-signal patterns —", ...hits.map((h) => `    ${h}`));
  const parity: ParityFacts = { changed: [...refs].sort(), pregate: [...hits].sort(), verdict: { first: v.first, second: v.second } };
  const held = (drift.length ? ` · held (local image differs from running: ${drift.join(", ")})` : "") + (noBaseline.length ? ` · held (no running container: ${noBaseline.join(", ")})` : "");
  const heldTrouble = drift.length + noBaseline.length > 0 && leg.apply;

  if (hits.length || !v.approved) {
    const why = hits.length ? `pre-gate: ${hits.length} hit${hits.length === 1 ? "" : "s"}` : v.first !== "APPROVE" ? `review: first ${v.first}` : `review: second ${v.second}`;
    return { lines, summary: `blocked (${refs.length} changed — ${why})${held}`, trouble: true, parity };
  }
  if (!leg.apply || ctx.dryRun) return { lines, summary: `would update ${refs.length} (${refs.join(", ")})${held}`, trouble: heldTrouble, parity };

  const apply = changed.filter((x) => !drift.includes(x.service) && !noBaseline.includes(x.service));
  if (!apply.length) return { lines, summary: `blocked (${refs.length} changed, every one held)${held}`, trouble: true, parity };
  const { verdict, hold } = composeRequest(
    state.value.services.map((x) => x.service),
    state.value.build,
    new Set(apply.map((x) => x.service)),
    verdictReviewers({ first: reviewers.first!.name, second: reviewers.second!.name }, reach.broker.reviewerKeys),
    reach.session,
  );
  const w = await brokerWrite(reach.broker, reach.exec, reach.session, "compose.apply", verdict, hold);
  lines.push(writeLine(w));
  if (w.outcome !== "ok") return { lines, summary: `${writeSummary(w)}${held}`, trouble: true, parity };
  const updated = `updated (${[...new Set(apply.map((x) => x.ref))].join(", ")})`;
  if (!leg.prune) return { lines, summary: `${updated}${held}`, trouble: heldTrouble, parity };
  const p = await brokerWrite(reach.broker, reach.exec, reach.session, "image.prune");
  lines.push(writeLine(p));
  if (p.outcome !== "ok") return { lines, summary: `${updated} · prune ${writeSummary(p)}${held}`, trouble: true, parity };
  return { lines, summary: `${updated}${held}`, trouble: heldTrouble, parity };
}
