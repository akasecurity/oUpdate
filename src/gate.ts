// The forge gate: for each open update PR (Renovate's `renovate/` branches by
// default), diff the lockfile between base and head, review every package
// version the PR brings in, and report on the head commit as a status plus one
// comment. Final states (success, failure) are not re-reviewed; pending is, on
// the next run: a hold from cooldown alone or from layer errors can clear.

import { parseBunLock } from "./adapters/ecosystem/bunlock.ts";
import type { Forge, StatusState } from "./adapters/forge/types.ts";
import { diffLocks, type LockChange } from "./lockdiff.ts";
import type { ReviewResult } from "./review.ts";

export type Change = LockChange;

export interface GateArgs {
  forge: Forge;
  repo: string;
  review: (c: Change) => Promise<ReviewResult>;
  branchPrefix?: string;
  lockPath?: string;
  context?: string;
}

export interface GatePull {
  number: number;
  state: StatusState | "skipped";
  results: ReviewResult[];
}

export const MARKER = "<!-- oupdate-gate -->";

export function gateState(results: ReviewResult[]): StatusState {
  if (results.every((r) => r.decision === "land")) return "success";
  const hard = results.some((r) => r.decision === "hold" && r.layers.some((l) => l.verdict === "stop" && l.layer !== "cooldown"));
  return hard ? "failure" : "pending";
}

function errored(c: Change, e: unknown): ReviewResult {
  return { eco: "npm", name: c.name, from: c.from ?? "", to: c.to, decision: "hold", layers: [{ layer: "reviewer", verdict: "error", detail: `review failed: ${e instanceof Error ? e.message : String(e)}` }] };
}

function comment(lockPath: string, state: StatusState, results: ReviewResult[]): string {
  const lines = [MARKER, `**oupdate: ${state}** (${lockPath})`, ""];
  for (const r of results) if (r.malicious?.length) lines.push(`**MALICIOUS: ${r.name} ${r.to} (${r.malicious.join(", ")}).** Do not merge, and check where this version is already installed.`, "");
  for (const r of results) {
    lines.push(`- \`${r.name} ${r.from || "(new)"} -> ${r.to}\`: **${r.decision}**`);
    for (const l of r.layers) lines.push(`  - ${l.layer} ${l.verdict}: ${l.detail.replace(/\s+/g, " ").slice(0, 300)}`);
  }
  return lines.join("\n");
}

export async function runGate(a: GateArgs): Promise<GatePull[]> {
  const prefix = a.branchPrefix ?? "renovate/";
  const lockPath = a.lockPath ?? "bun.lock";
  const context = a.context ?? "oupdate/review";
  const out: GatePull[] = [];
  for (const pr of await a.forge.openPulls(a.repo)) {
    if (!pr.headRef.startsWith(prefix)) continue;
    const prior = await a.forge.statusOf(a.repo, pr.headSha, context);
    if (prior === "success" || prior === "failure") {
      out.push({ number: pr.number, state: "skipped", results: [] });
      continue;
    }
    const [baseText, headText] = await Promise.all([a.forge.readFile(a.repo, pr.baseSha, lockPath), a.forge.readFile(a.repo, pr.headSha, lockPath)]);
    const changes = headText === undefined ? [] : diffLocks(baseText === undefined ? [] : parseBunLock(baseText), parseBunLock(headText));
    if (!changes.length) {
      await a.forge.setStatus(a.repo, pr.headSha, { state: "success", context, description: `no package changes in ${lockPath}` });
      out.push({ number: pr.number, state: "success", results: [] });
      continue;
    }
    await a.forge.setStatus(a.repo, pr.headSha, { state: "pending", context, description: `reviewing ${changes.length} package change${changes.length === 1 ? "" : "s"}` });
    const results: ReviewResult[] = [];
    for (const c of changes) results.push(await a.review(c).catch((e) => errored(c, e)));
    const state = gateState(results);
    const land = results.filter((r) => r.decision === "land").length;
    await a.forge.setStatus(a.repo, pr.headSha, { state, context, description: `${results.length} package${results.length === 1 ? "" : "s"}: ${land} land, ${results.length - land} hold` });
    if (state !== "pending" || results.some((r) => r.layers.some((l) => l.verdict === "stop"))) await a.forge.upsertComment(a.repo, pr.number, MARKER, comment(lockPath, state, results));
    out.push({ number: pr.number, state, results });
  }
  return out;
}
