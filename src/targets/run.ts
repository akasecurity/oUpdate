// `oupdate targets --apply`: for each due target, open its reach, run its legs, join the leg results
// into one summary line and publish it as the target's status tsv. A reach or leg that is not built,
// or that fails, is "not checked" or "error" with trouble, never a silent skip; a target with
// `parityTo` appends the night's parity facts on every real run. A dry run
// publishes nothing and writes dry-run-targets.log. The Mac host apply (host --apply) is separate.

import { appendFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Exec } from "../apply/exec.ts";
import { realFs } from "../apply/fs.ts";
import type { TargetsConfig } from "./config.ts";
import type { Clock } from "./gce/job.ts";
import { osPackagesLeg } from "./gce/leg.ts";
import { newLatch, type PatchLatch } from "./gce/patch.ts";
import { isOpenBroker } from "./broker/broker.ts";
import { composeLeg } from "./compose/compose.ts";
import type { ReviewerPair } from "../review-pair.ts";
import { isDue, isPluginLeg, type Leg, type LegResult, type ParityFacts, type Target, type TargetResult } from "./model.ts";
import type { PinBumpLeg } from "./pins/config.ts";
import { openReach, type OpenReach } from "./reach.ts";
import { EMPTY_REGISTRY, type Registry } from "./registry.ts";
import { joinLegs, oneLine, stamp, statusTsv } from "./summary.ts";

export interface TargetFs {
  /** The text, or undefined when missing or unreadable. */
  readFile(path: string): Promise<string | undefined>;
  /** The text, or missing (ENOENT only), or the read error: for state that must not be mistaken for empty. */
  readText(path: string): Promise<{ text: string } | { missing: true } | { error: string }>;
  /** Replaces the file whole (temporary name, then rename). */
  writeFile(path: string, text: string): Promise<void>;
  appendFile(path: string, text: string): Promise<void>;
  remove(path: string): Promise<void>;
}

export const realTargetFs: TargetFs = {
  readFile: (p) => realFs.readFile(p),
  readText: async (p) => {
    try {
      return { text: readFileSync(p, "utf8") };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return { missing: true };
      return { error: msg(e) };
    }
  },
  writeFile: (p, t) => realFs.writeFile(p, t),
  appendFile: async (p, t) => {
    mkdirSync(dirname(p), { recursive: true });
    appendFileSync(p, t);
  },
  remove: async (p) => rmSync(p, { force: true }),
};

export interface LegContext {
  target: Target;
  reach: OpenReach;
  dryRun: boolean;
  now: Date;
}

export type LegRunner<L extends Leg = Leg> = (leg: L, ctx: LegContext) => Promise<LegResult>;

export const DEFAULT_TIMEOUT_MS = 10 * 60_000;

export interface TargetDeps {
  exec: Exec;
  fs: TargetFs;
  /** This oupdate's revision, the tsv's rev row. */
  rev: string;
  /** The pin-bump leg (pins/leg.ts pinBumpRunner in production). */
  pinBump: LegRunner<PinBumpLeg>;
  /** The two reviewers of the docker-compose leg and of plugin legs; absent: those legs report "not checked". */
  reviewers?: ReviewerPair;
  /** The loaded target plugins (registry.ts); none when absent. */
  registry?: Registry;
  /** The os-packages leg's two reviewers and clock (its job and inventory waits); absent: that leg reports "not checked". */
  gce?: { reviewers: ReviewerPair; clock: Clock };
  timeoutMs?: number;
}

export interface RunOptions {
  dryRun: boolean;
  now: Date;
  /** Run these targets whatever their schedule; each must exist. */
  only?: string[];
  onLine?: (line: string) => void;
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

// Why a reviewer pair cannot be reached right now (an outage only), asked once per pair per run: a leg that needs it is held, not failed.
// The latch is made once per run, so keying the memo on it keeps the answer to one run.
const readiness = new WeakMap<PatchLatch, Map<ReviewerPair, Promise<string | undefined>>>();
async function reviewersHeld(pair: ReviewerPair, ctx: LegContext, latch: PatchLatch): Promise<string | undefined> {
  // A dry run proposes and publishes nothing, so it makes no model request here either.
  if (ctx.dryRun) return undefined;
  let memo = readiness.get(latch);
  if (!memo) readiness.set(latch, (memo = new Map()));
  let p = memo.get(pair);
  if (!p) {
    p = Promise.all([pair.first, pair.second].map((r) => r?.ready?.().catch(() => undefined))).then((why) => why.find((w) => w !== undefined));
    memo.set(pair, p);
  }
  return p;
}
const held = (why: string): LegResult => ({ lines: [why], summary: `held — ${why}; the review runs when the reviewer is up`, trouble: false });

async function runLeg(leg: Leg, ctx: LegContext, deps: TargetDeps, latch: PatchLatch): Promise<LegResult> {
  const reg = deps.registry ?? EMPTY_REGISTRY;
  if (isPluginLeg(leg)) {
    const k = reg.legs.get(leg.kind);
    if (!k) return { lines: [], summary: `not checked — leg ${leg.kind} has no plugin loaded`, trouble: true };
    if (!deps.reviewers) return { lines: [], summary: `not checked — leg ${leg.kind} has no reviewers wired`, trouble: true };
    const why = await reviewersHeld(deps.reviewers, ctx, latch);
    if (why) return held(why);
    return k.run(leg, ctx, { reviewers: deps.reviewers });
  }
  if (leg.kind === "pin-bump") return deps.pinBump(leg, ctx);
  if (leg.kind === "docker-compose") {
    if (!deps.reviewers) return { lines: [], summary: "not checked — leg docker-compose has no reviewers wired", trouble: true };
    if (!isOpenBroker(ctx.reach)) return { lines: [], summary: `not checked — leg docker-compose over reach ${ctx.reach.kind} not built yet`, trouble: true };
    const why = await reviewersHeld(deps.reviewers, ctx, latch);
    if (why) return held(why);
    return composeLeg(leg, ctx, ctx.reach, deps.reviewers, reg.containerBaseline);
  }
  if (leg.kind === "os-packages") {
    if (!deps.gce) return Promise.resolve({ lines: [], summary: "not checked — leg os-packages has no reviewers or clock wired", trouble: true });
    const why = await reviewersHeld(deps.gce.reviewers, ctx, latch);
    if (why) return held(why);
    try {
      const r = await osPackagesLeg(leg, ctx, { ...deps.gce, fs: deps.fs, latch });
      // Any trouble the leg returns, not only what it latched itself, stops every later gce patch this run.
      if (r.trouble) latch.stopped ??= ctx.target.id;
      return r;
    } catch (e) {
      // A leg that throws may have sent a request: no later gce target patches this run.
      latch.stopped ??= ctx.target.id;
      throw e;
    }
  }
  return Promise.resolve({ lines: [], summary: `not checked — leg ${leg.kind} not built yet`, trouble: true });
}

async function runTarget(t: Target, deps: TargetDeps, opts: RunOptions, latch: PatchLatch): Promise<TargetResult> {
  const lines: string[] = [`=== ${t.id} (${t.os}, reach ${t.reach.kind}) ===`];
  const h = await openReach(t.reach, deps.exec, deps.timeoutMs ?? DEFAULT_TIMEOUT_MS, deps.registry ?? EMPTY_REGISTRY);
  const legs: { kind: string; result: LegResult }[] = [];
  if (!h.ok) legs.push({ kind: "reach", result: { lines: [], summary: `not checked — ${h.why}`, trouble: true } });
  else
    for (const leg of t.legs) {
      let result: LegResult;
      try {
        result = await runLeg(leg, { target: t, reach: h.open, dryRun: opts.dryRun, now: opts.now }, deps, latch);
      } catch (e) {
        result = { lines: [], summary: `error: ${msg(e)}`, trouble: true };
      }
      lines.push(`--- ${leg.kind} ---`, ...result.lines, `${leg.kind}: ${result.summary}`);
      legs.push({ kind: leg.kind, result });
    }
  const { summary, trouble } = joinLegs(legs);
  const res: TargetResult = { id: t.id, summary, trouble, lines };
  if (t.parityTo && !opts.dryRun) {
    const facts: ParityFacts = Object.assign({}, ...legs.map((l) => l.result.parity ?? {}));
    const record = { date: stamp(opts.now).slice(0, 10), target: t.id, rev: deps.rev, checked: h.ok, ...facts };
    try {
      await deps.fs.appendFile(t.parityTo, `${JSON.stringify(record)}\n`);
      lines.push(`parity: recorded to ${t.parityTo}`);
    } catch (e) {
      res.trouble = true;
      res.summary = `${res.summary} · error: parity not recorded (${oneLine(msg(e))})`;
      lines.push(`parity: record FAILED (${msg(e)})`);
    }
  }
  if (!opts.dryRun) {
    try {
      await deps.fs.writeFile(t.summaryTo, statusTsv({ host: t.id, date: stamp(opts.now), rev: deps.rev, summary: res.summary }));
      res.published = t.summaryTo;
      lines.push(`status: published to ${t.summaryTo}`);
    } catch (e) {
      res.trouble = true;
      lines.push(`status: publish FAILED (${msg(e)})`);
      // The printed and logged summary must read as trouble too, whatever the legs said.
      res.summary = `${res.summary} · error: status not published to ${t.summaryTo} (${oneLine(msg(e))})`;
    }
  }
  lines.push(`summary: ${res.summary}`);
  return res;
}

export async function runTargets(cfg: TargetsConfig, deps: TargetDeps, opts: RunOptions): Promise<{ results: TargetResult[]; rc: number }> {
  const ids = new Set(cfg.targets.map((t) => t.id));
  for (const id of opts.only ?? []) if (!ids.has(id)) throw new Error(`unknown target ${id}`);
  const chosen = opts.only?.length ? cfg.targets.filter((t) => opts.only!.includes(t.id)) : cfg.targets.filter((t) => isDue(t.schedule, opts.now));
  const out: string[] = [];
  const emit = (l: string) => {
    out.push(l);
    opts.onLine?.(l);
  };
  emit(`=== oupdate targets ${stamp(opts.now)} rev ${deps.rev}${opts.dryRun ? " (dry run: nothing proposed or published)" : ""} ===`);
  if (!chosen.length) emit("no target is due today");
  const results: TargetResult[] = [];
  // One latch for the whole run: trouble on any gce-patch VM stops every later patch, in every target.
  const latch = newLatch();
  for (const t of chosen) {
    const r = await runTarget(t, deps, opts, latch);
    for (const l of r.lines) emit(`[${t.id}] ${l}`);
    results.push(r);
  }
  const logFile = join(cfg.logDir, opts.dryRun ? "dry-run-targets.log" : "targets.log");
  try {
    await deps.fs.appendFile(logFile, out.join("\n") + "\n");
  } catch (e) {
    opts.onLine?.(`log not written to ${logFile}: ${msg(e)}`);
  }
  return { results, rc: results.some((r) => r.trouble) ? 1 : 0 };
}
