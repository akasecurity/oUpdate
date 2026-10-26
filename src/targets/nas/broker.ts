// The broker-script reach's one door to the NAS (spec §2, §4; CRB-b128 §1.4, §4.6). Every call is
// `credreq <action> <broker target> --why … --wait … --param verb=<verb> [--param <slot>=<value>]…`, run as argv through
// Exec with the broker's HTTP base URL (the only route to the standing approval). A leg never builds a command for the
// NAS: it names a verb and its slot values, and each value is checked against its rule here before anything is sent.
// The result shapes and the verdict are the design's caller contract (rev 3g §4.8, which answers open questions O-1 and
// O-2); a change lands in this file only.

import { createHash } from "node:crypto";
import type { Exec } from "../../apply/exec.ts";
import { credreqCall, isObj, short, tail, type Param, type Reply } from "../credreq.ts";
import { parseAnswer, type Row } from "./answer.ts";
import { mergeOutcome, rcText, readFailure, suspends, writeOutcome, type WriteOutcome } from "./outcome.ts";
import { checkSlots, READ_VERBS, WRITE_VERBS, type ReadVerb, type WriteVerb } from "./verbs.ts";

export interface NasBroker {
  /** The credreq binary (absolute path, or a name on PATH). */
  credreq: string;
  baseUrl: string;
  /** The broker's catalog target name. */
  host: string;
  readAction: string;
  writeAction?: string;
}

/** One night on the broker: the run id it minted on the first compose.state or plugin.check, and every evidence answer with its seq. */
export interface NasSession {
  runId?: string;
  evidence: { seq: number; answer: string }[];
  /** Set by the first write of the run that ended failed, unknown or refused by the broker: no leg sends another write this run. */
  writeStopped?: string;
  /** compose.state and plugin.check each go once per run (§4.8: a repeat refuses); the ones already sent. */
  asked?: ReadVerb[];
  /** This run's compose.apply ended ok: the only case in which image.prune is sent. */
  applyOk?: boolean;
}
export const newSession = (): NasSession => ({ evidence: [] });

const RUN_ID = /^[A-Za-z0-9_-]{8,64}$/;
const KNOWN: readonly string[] = ["ok", "failed", "unknown", "no-change"];
const EVIDENCE: ReadonlySet<ReadVerb> = new Set(["image.evidence", "image.candidate", "plugin.file"]);
const MINTS: ReadonlySet<ReadVerb> = new Set(["compose.state", "plugin.check"]);
/** credreq waits the verb's deadline plus the broker's ssh margin (its ssh timeout is the deadline plus 15 s, CRB-b128 §1.3). */
const WAIT_MARGIN_S = 15;
/** The broker removes the answer's final marker once it has checked it (§4.8); the caller puts back the rc 0 it vouched for. */
const VOUCHED = "__OUP_RC=0\n";

export type ReadResult = { ok: true; rows: Row[]; answer: string } | { ok: false; why: string };

/**
 * One read. Before the night's run is minted (by compose.state or plugin.check) only self, os.version and the minting
 * verbs are asked, and with no run id; after it, every read carries the run id and every reply must name the same run.
 * The answer comes back with its final marker removed, so a marker line still in it is refused as not final.
 */
export async function brokerRead(b: NasBroker, exec: Exec, s: NasSession, verb: ReadVerb, slots: Record<string, string> = {}): Promise<ReadResult> {
  const refused = checkSlots(verb, slots);
  if (refused) return { ok: false, why: `not asked: ${refused}` };
  if (!s.runId && EVIDENCE.has(verb)) return { ok: false, why: `not asked: ${verb} needs the broker's run (no compose.state or plugin.check yet)` };
  if (MINTS.has(verb)) {
    if (s.asked?.includes(verb)) return { ok: false, why: `not asked: ${verb} was already read this run` };
    s.asked = [...(s.asked ?? []), verb];
  }
  const spec = READ_VERBS[verb];
  const params: Param[] = Object.entries(slots).map(([key, value]) => ({ key, value }));
  if (s.runId) params.push({ key: "run_id", value: s.runId });
  const c = await credreqCall(b, exec, b.readAction, b.host, verb, params, spec.deadlineS + WAIT_MARGIN_S);
  if (!c.ok) return { ok: false, why: `${verb}: ${c.why}` };
  const { status, reason, result } = c.reply;
  if (status !== "approved") return { ok: false, why: `${verb}: broker ${status}${tail(reason)}` };
  if (!isObj(result)) return { ok: false, why: `${verb}: broker result is not an object` };
  const id = result.run_id;
  if (id !== undefined && (typeof id !== "string" || !RUN_ID.test(id))) return { ok: false, why: `${verb}: the broker's run id is not valid` };
  if (s.runId !== undefined) {
    if (id !== s.runId) return { ok: false, why: `${verb}: the broker's run changed (${id ?? "none"}, expected ${s.runId})` };
  } else if (MINTS.has(verb) && id !== undefined) s.runId = id;
  // Held, refused before the ssh call, or failed on the NAS: no rows, and nothing for the evidence sha. Each names the
  // run once there is one (rev 3g), checked above.
  if (typeof result.refused === "string") return { ok: false, why: `${verb}: refused by the broker: ${short(result.refused)}` };
  if (typeof result.held === "string") return { ok: false, why: `${verb}: held by the broker: ${short(result.held)}` };
  if (typeof result.failed === "string") {
    const rc = typeof result.rc === "number" && Number.isInteger(result.rc) ? result.rc : undefined;
    return { ok: false, why: `${verb}: NAS read failed: ${short(result.failed)} (${rc === undefined ? "no marker: outcome unknown" : `rc ${rc}: ${rcText(rc)}`})` };
  }
  if (MINTS.has(verb) && s.runId === undefined) return { ok: false, why: `${verb}: the broker gave no run id` };
  if (typeof result.answer !== "string") return { ok: false, why: `${verb}: broker result has no answer` };
  // The broker records every evidence answer it returned, with its seq, so the caller counts it too, even one it refuses
  // below. A missing or repeated seq would make the two hashes disagree: refused here.
  if (EVIDENCE.has(verb)) {
    const seq = result.seq;
    if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 1) return { ok: false, why: `${verb}: the broker gave no valid seq` };
    if (s.evidence.some((e) => e.seq === seq)) return { ok: false, why: `${verb}: the broker's seq ${seq} repeats` };
    s.evidence.push({ seq, answer: result.answer });
  }
  const sep = result.answer === "" || result.answer.endsWith("\n") ? "" : "\n";
  const p = parseAnswer(result.answer + sep + VOUCHED, spec.capBytes);
  if (!p.ok) return { ok: false, why: `${verb}: ${p.why}` };
  const failed = readFailure(p.rc);
  if (failed) return { ok: false, why: `${verb}: ${failed}` };
  return { ok: true, rows: p.rows, answer: result.answer };
}

/** The write request's verdict (CRB-b128 §4.3; keys confirmed by rev 3e §4.8, open question O-2). */
export interface Verdict {
  items: Record<string, "APPROVE" | "HOLD">;
  /** The reviewer ids the arming card pinned: the configured reviewers' names. */
  reviewers: { router: string; onprem: string };
  evidence_sha256: string;
}

/**
 * The verdict's evidence sha (rev 3g §4.8), the one place its encoding lives: sha256 of the UTF-8 encoding of each
 * evidence answer string as JSON.parse gave it (never the escaped JSON text, no Unicode normalization), in ascending
 * seq, concatenated with nothing between.
 */
export function evidenceSha(s: NasSession): string {
  const h = createHash("sha256");
  for (const e of [...s.evidence].sort((a, b) => a.seq - b.seq)) h.update(Buffer.from(e.answer, "utf8"));
  return h.digest("hex");
}

/**
 * compose.apply's verdict and hold list (§4.8): items names every service of the run's compose.state, BUILD services
 * always HOLD, and hold lists exactly the HOLD items, in that order.
 */
export function composeRequest(services: string[], build: string[], approve: ReadonlySet<string>, reviewers: Verdict["reviewers"], s: NasSession): { verdict: Verdict; hold: string[] } {
  const names = [...new Set([...services, ...build])];
  const items = Object.fromEntries(names.map((n) => [n, approve.has(n) && !build.includes(n) ? ("APPROVE" as const) : ("HOLD" as const)]));
  return { verdict: { items, reviewers, evidence_sha256: evidenceSha(s) }, hold: names.filter((n) => items[n] === "HOLD") };
}

/**
 * A write's result. reachedSsh: the broker answered with an outcome, so the write reached the NAS. Every answer without a
 * recognized outcome, and every error, timeout or lost reply, is unknown. refused: nothing ran; sent says whether the
 * caller sent a request (the broker refused it before the ssh call, or a card was denied or expired).
 */
export type WriteResult = ({ outcome: WriteOutcome; rc?: number; why: string; reachedSsh: boolean } | { outcome: "refused"; why: string; sent: boolean }) & { requestId?: string };

/** The write's line in the target's log, naming the broker's request id when there is one. */
export const writeLine = (w: WriteResult): string => (w.requestId ? `${w.why} [broker request ${w.requestId}]` : w.why);

/** image.prune carries only the verb and the run id (the apply's run, §4.8); the other writes carry a verdict and a hold list. */
export function brokerWrite(b: NasBroker, exec: Exec, s: NasSession, verb: "image.prune"): Promise<WriteResult>;
export function brokerWrite(b: NasBroker, exec: Exec, s: NasSession, verb: Exclude<WriteVerb, "image.prune">, verdict: Verdict, hold: string[]): Promise<WriteResult>;
export async function brokerWrite(b: NasBroker, exec: Exec, s: NasSession, verb: WriteVerb, verdict?: Verdict, hold?: string[]): Promise<WriteResult> {
  const no = (why: string): WriteResult => ({ outcome: "refused", why: `${verb}: ${why}`, sent: false });
  if (!b.writeAction) return no("the reach names no write action");
  if (!s.runId) return no("no broker run this night");
  if ((verb === "image.prune") !== (verdict === undefined)) return no(verb === "image.prune" ? "takes no verdict" : "needs a verdict");
  if (s.writeStopped) return no(`not asked: an earlier write this run did not end cleanly (${s.writeStopped})`);
  // §4.4: prune only after its own run's compose.apply ended ok.
  if (verb === "image.prune" && !s.applyOk) return no("not asked: no compose.apply ended ok this run");
  let w: WriteResult;
  try {
    w = await sendWrite(b, b.writeAction, exec, s.runId, verb, verdict, hold);
  } catch (e) {
    // An Exec that throws may have sent the request: unknown, and latched below before the leg sees it.
    w = { outcome: "unknown", why: `${verb}: ${short(e instanceof Error ? e.message : String(e))}`, reachedSsh: false };
  }
  if (w.outcome === "refused" ? w.sent : suspends(w.outcome)) s.writeStopped = w.why;
  if (verb === "compose.apply" && w.outcome === "ok") s.applyOk = true;
  return w;
}

async function sendWrite(b: NasBroker, action: string, exec: Exec, runId: string, verb: WriteVerb, verdict?: Verdict, hold?: string[]): Promise<WriteResult> {
  const params: Param[] = [{ key: "run_id", value: runId }];
  if (verdict) params.push({ key: "verdict", value: JSON.stringify(verdict), json: true }, { key: "hold", value: JSON.stringify(hold ?? []), json: true });
  const c = await credreqCall(b, exec, action, b.host, verb, params, WRITE_VERBS[verb].deadlineS + WAIT_MARGIN_S);
  // A reply never received, any error and a timeout are unknown: the write may have run (§4.8).
  if (!c.ok) return { outcome: "unknown", why: `${verb}: ${c.why}`, reachedSsh: false };
  const r = writeReply(verb, runId, c.reply);
  return c.reply.requestId ? { ...r, requestId: c.reply.requestId } : r;
}

function writeReply(verb: WriteVerb, runId: string, reply: Reply): WriteResult {
  const { status, reason, result } = reply;
  const res = isObj(result) ? result : {};
  // Refused before the ssh call (a write in flight, a limit, a pin unreadable, a covered entry changed, a verdict mismatch).
  if (typeof res.refused === "string") {
    // rev 3g: a refusal always names its run; one for another run, or none, is not this write's answer.
    if (res.run_id !== runId) return { outcome: "unknown", why: `${verb}: a refusal for another run (${String(res.run_id ?? "none")}, expected ${runId}): ${short(res.refused)}`, reachedSsh: false };
    return { outcome: "refused", why: `${verb}: refused by the broker, nothing ran: ${short(res.refused)}`, sent: true };
  }
  // The card path (no standing cover): denied or expired means nothing ran; a card that outlives the wait is unknown.
  if (status === "denied" || status === "expired") return { outcome: "refused", why: `${verb}: card ${status}, nothing ran${tail(reason)}`, sent: true };
  if (status === "pending") return { outcome: "unknown", why: `${verb}: waits on a card on the page and may still run`, reachedSsh: false };
  if (status === "withheld" || status === "unknown") return { outcome: "unknown", why: `${verb}: broker ${status}${tail(reason)}`, reachedSsh: false };
  const rc = typeof res.rc === "number" && Number.isInteger(res.rc) ? res.rc : undefined;
  // The broker always sends its outcome (§4.8) and it must agree with the caller's table; a result without one is unknown.
  const caller: WriteOutcome = writeOutcome(verb, rc);
  const noOutcome = status === "approved" && typeof res.outcome !== "string";
  const merged = typeof res.outcome === "string" ? mergeOutcome(caller, res.outcome) : "unknown";
  // A failed status never reads as ok, and a reply for another run is not this write's answer.
  const otherRun = res.run_id !== runId;
  const outcome = otherRun || (status !== "approved" && merged === "ok") ? "unknown" : merged;
  const what = rc !== undefined ? `rc ${rc} (${rcText(rc)})` : "no rc came back";
  const says = typeof res.outcome === "string" && res.outcome !== caller ? `; the broker says ${KNOWN.includes(res.outcome) ? res.outcome : JSON.stringify(short(res.outcome))}, the caller's table says ${caller}` : "";
  const note = says ? says : noOutcome ? "; the broker sent no outcome" : otherRun && isObj(result) ? `; the broker's run changed (${String(res.run_id ?? "none")}, expected ${runId})` : "";
  return { outcome, ...(rc !== undefined ? { rc } : {}), why: `${verb}: ${what}${note}${tail(reason)}`, reachedSsh: typeof res.outcome === "string" };
}

/** The summary fragment for a write that did not end ok; every one carries a digest trouble word. */
export function writeSummary(w: WriteResult): string {
  if (w.outcome === "refused") return w.sent ? `blocked — nothing ran (${w.why})` : `blocked (${w.why})`;
  if (w.outcome === "failed" || w.outcome === "unknown") {
    // Only a write that reached the ssh call can suspend the standing entry.
    return w.reachedSsh ? `FAILED — ${w.why}; the broker suspends the standing entry until a Re-arm card is approved` : `FAILED — ${w.why}; outcome unknown, the write may have run`;
  }
  return `blocked (${w.why})`;
}
