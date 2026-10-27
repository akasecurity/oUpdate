// The forge gate: for each open update PR (Renovate's `renovate/` branches by
// default), diff the lockfile between base and head, review every package
// version the PR brings in, and report on the head commit as a status plus one
// comment. Final states (success, failure) are not re-reviewed; pending is, on
// the next run: a hold from cooldown alone or from layer errors can clear.

import type { Forge, Pull, StatusState } from "./adapters/forge/types.ts";
import { diffLocks, type LockChange } from "./lockdiff.ts";
import { LOCK_NAMES, parseLock } from "./lockfile/index.ts";
import type { Ecosystem } from "./prepass.ts";
import type { ReviewResult } from "./review.ts";

/** A package version a PR brings in, with the ecosystem of the lockfile that pins it. */
export type Change = LockChange & { eco: Ecosystem };

export interface GateArgs {
  forge: Forge;
  repo: string;
  review: (c: Change) => Promise<ReviewResult>;
  /** A PR is gated when its head branch starts with any of these. Default: Renovate's `renovate/`. */
  branchPrefixes?: string[];
  /** Lockfiles to diff, all into one status. None: each known lockfile name at the repo root that the head has. */
  lockPaths?: string[];
  /** What a version from a private registry gets; default PRIVATE_REGISTRY_DEFAULT. */
  privateRegistry?: PrivateRegistryPolicy;
  context?: string;
}

/**
 * A lockfile version from a non-default registry, which the public registry and OSV know nothing
 * about. "list": named in the comment as not reviewed, the gate state is left to the other changes. "hold": the
 * PR stays pending until a person merges it past the gate. "review": reviewed against the public registry, as
 * before (a dependency-confusion blind spot).
 */
export type PrivateRegistryPolicy = "list" | "hold" | "review";
export const PRIVATE_REGISTRY_DEFAULT: PrivateRegistryPolicy = "list";

const privateNote = (c: Change) => `not reviewed (private registry ${c.registry})`;

function heldPrivate(c: Change): ReviewResult {
  return { eco: c.eco, name: c.name, from: c.from ?? "", to: c.to, decision: "hold", layers: [{ layer: "gate", verdict: "error", detail: `${privateNote(c)}; a person decides` }] };
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
  return { eco: c.eco, name: c.name, from: c.from ?? "", to: c.to, decision: "hold", layers: [{ layer: "reviewer", verdict: "error", detail: `review failed: ${e instanceof Error ? e.message : String(e)}` }] };
}

function comment(locks: string, state: StatusState, results: ReviewResult[], unreviewed: Change[]): string {
  const lines = [MARKER, `**oupdate: ${state}** (${locks})`, ""];
  for (const r of results) if (r.malicious?.length) lines.push(`**MALICIOUS: ${r.name} ${r.to} (${r.malicious.join(", ")}).** Do not merge, and check where this version is already installed.`, "");
  for (const r of results) {
    lines.push(`- \`${r.name} ${r.from || "(new)"} -> ${r.to}\`: **${r.decision}**`);
    for (const l of r.layers) lines.push(`  - ${l.layer} ${l.verdict}: ${l.detail.replace(/\s+/g, " ").slice(0, 300)}`);
  }
  for (const c of unreviewed) lines.push(`- \`${c.name} ${c.from || "(new)"} -> ${c.to}\`: ${privateNote(c)}`);
  return lines.join("\n");
}

/** The changes a PR's head brings in across the lockfiles, each version once; `found` names the lockfiles the head has. */
async function lockChanges(a: GateArgs, pr: Pull, paths: string[]): Promise<{ found: string[]; changes: Change[] }> {
  const found: string[] = [];
  const changes: Change[] = [];
  const seen = new Set<string>();
  for (const path of paths) {
    const [baseText, headText] = await Promise.all([a.forge.readFile(a.repo, pr.baseSha, path), a.forge.readFile(a.repo, pr.headSha, path)]);
    if (headText === undefined) continue;
    found.push(path);
    const parse = (text: string) => {
      try {
        return parseLock(path, text);
      } catch (e) {
        throw new Error(`cannot read ${path}: ${e instanceof Error ? e.message : String(e)}`);
      }
    };
    const head = parse(headText);
    const base = baseText === undefined ? [] : parse(baseText).pkgs;
    for (const c of diffLocks(base, head.pkgs)) {
      const key = `${head.eco}:${c.name}:${c.from}:${c.to}`;
      if (seen.has(key)) continue;
      seen.add(key);
      changes.push({ ...c, eco: head.eco });
    }
  }
  return { found, changes };
}

export async function runGate(a: GateArgs): Promise<GatePull[]> {
  const prefixes = a.branchPrefixes?.length ? a.branchPrefixes : ["renovate/"];
  const paths = a.lockPaths?.length ? a.lockPaths : LOCK_NAMES;
  const context = a.context ?? "oupdate/review";
  const out: GatePull[] = [];
  for (const pr of await a.forge.openPulls(a.repo)) {
    if (!prefixes.some((p) => pr.headRef.startsWith(p))) continue;
    const prior = await a.forge.statusOf(a.repo, pr.headSha, context);
    if (prior === "success" || prior === "failure") {
      out.push({ number: pr.number, state: "skipped", results: [] });
      continue;
    }
    let found: string[], changes: Change[];
    try {
      ({ found, changes } = await lockChanges(a, pr, paths));
    } catch (e) {
      // A lockfile that does not parse is never read as "no changes": hold the PR and say why.
      const why = e instanceof Error ? e.message : String(e);
      await a.forge.setStatus(a.repo, pr.headSha, { state: "pending", context, description: why.slice(0, 200) });
      await a.forge.upsertComment(a.repo, pr.number, MARKER, [MARKER, `**oupdate: pending** (${paths.join(", ")})`, "", why].join("\n"));
      out.push({ number: pr.number, state: "pending", results: [] });
      continue;
    }
    const locks = found.join(", ");
    if (!changes.length) {
      const description = found.length ? `no package changes in ${locks}` : `no lockfile found (looked for ${paths.join(", ")})`;
      await a.forge.setStatus(a.repo, pr.headSha, { state: "success", context, description });
      out.push({ number: pr.number, state: "success", results: [] });
      continue;
    }
    const policy = a.privateRegistry ?? PRIVATE_REGISTRY_DEFAULT;
    const priv = policy === "review" ? [] : changes.filter((c) => c.registry);
    const unreviewed = policy === "list" ? priv : [];
    const results: ReviewResult[] = policy === "hold" ? priv.map(heldPrivate) : [];
    const toReview = changes.filter((c) => !priv.includes(c));
    if (toReview.length) await a.forge.setStatus(a.repo, pr.headSha, { state: "pending", context, description: `reviewing ${toReview.length} package change${toReview.length === 1 ? "" : "s"}` });
    for (const c of toReview) results.push(await a.review(c).catch((e) => errored(c, e)));
    const state = gateState(results);
    const land = results.filter((r) => r.decision === "land").length;
    const skipped = unreviewed.length ? `, ${unreviewed.length} not reviewed (private registry)` : "";
    await a.forge.setStatus(a.repo, pr.headSha, { state, context, description: `${results.length} package${results.length === 1 ? "" : "s"}: ${land} land, ${results.length - land} hold${skipped}` });
    if (state !== "pending" || priv.length || results.some((r) => r.layers.some((l) => l.verdict === "stop"))) await a.forge.upsertComment(a.repo, pr.number, MARKER, comment(locks, state, results, unreviewed));
    out.push({ number: pr.number, state, results });
  }
  return out;
}
