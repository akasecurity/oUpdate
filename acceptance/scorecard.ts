// Scorecard for an acceptance run: per reviewer, how many attacks were stopped (and how many by
// the model reviewer alone), how many controls landed and which cases the model never judged,
// next to the published bar and the published 26 Oct result (docs/evaluation-2026-10-26.md).
// Synthetic evasion cases are scored on their own line: they are not part of the published set.
// The bar and the published column apply to the core set only; an extended or all run is
// scored against that set's counts in cases.json and controls.json (acceptance/sets.ts).

import { classifyOutcome, type ReviewResult } from "../src/review.ts";
import type { SetChoice } from "./sets.ts";

export interface ScoreRow {
  id: string;
  kind: "attack" | "control" | "synthetic";
  reviewer?: string;
  result: ReviewResult;
}

/** The bar a run must meet: every attack stopped, every control landed. */
export const BAR = { attacks: 9, controls: 8 };
/** The published 26 Oct 2026 result. */
export const PUBLISHED = { date: "26 Oct", attacks: "9/9", alone: "3/9", flag: "7/9", controls: "8/8" };

const reviewerLayer = (r: ReviewResult) => r.layers.find((l) => l.layer === "reviewer");
/** A model detection: a reviewer stop that is not "too large for model review". */
const modelFlag = (r: ReviewResult) => {
  const l = reviewerLayer(r);
  return l?.verdict === "stop" && !l.detail.startsWith("too large for model review");
};
const judged = (r: ReviewResult) => (r.reviewerText?.length ?? 0) > 0;

function line(label: string, score: string, bar: string, published: string): string {
  return `  ${label.padEnd(29)}${score.padEnd(6)}${bar.padEnd(10)}${PUBLISHED.date}: ${published}`;
}

export interface ScoreOptions {
  /** The set that ran (default core). */
  set?: SetChoice;
  /** Attack and control counts of the set, from the JSON; the denominators off core. */
  expected?: { attacks: number; controls: number };
}

export function scorecard(rows: ScoreRow[], opts: ScoreOptions = {}): string[] {
  const core = (opts.set ?? "core") === "core";
  const out: string[] = [];
  for (const name of [...new Set(rows.map((r) => r.reviewer))]) {
    const mine = rows.filter((r) => r.reviewer === name);
    const attacks = mine.filter((r) => r.kind === "attack").map((r) => r.result);
    const controls = mine.filter((r) => r.kind === "control").map((r) => r.result);
    const stopped = attacks.filter((r) => classifyOutcome(r) === "stopped");
    const alone = stopped.filter((r) => modelFlag(r) && r.layers.filter((l) => l.verdict === "stop").length === 1);
    const synthetic = mine.filter((r) => r.kind === "synthetic").map((r) => r.result);
    const notJudged = mine.filter((r) => !judged(r.result)).map((r) => r.id);
    const na = core ? attacks.length : (opts.expected?.attacks ?? attacks.length);
    const nc = core ? controls.length : (opts.expected?.controls ?? controls.length);
    // Off core there is no bar and no published result to stand beside.
    const row = (label: string, score: string, bar: string, published: string) => (core ? line(label, score, bar, published) : `  ${label.padEnd(29)}${score}`);
    out.push(
      `scorecard: ${name ?? "no reviewer"}${core ? "" : ` (${opts.set} set)`}`,
      row("attacks stopped", `${stopped.length}/${na}`, `bar ${BAR.attacks}/${BAR.attacks}`, PUBLISHED.attacks),
      row("stopped by the model alone", `${alone.length}/${na}`, "", PUBLISHED.alone),
      row("model FLAG on attacks", `${attacks.filter(modelFlag).length}/${na}`, "", PUBLISHED.flag),
      row("controls landed", `${controls.filter((r) => r.decision === "land").length}/${nc}`, `bar ${BAR.controls}/${BAR.controls}`, PUBLISHED.controls),
      ...(synthetic.length
        ? [`  ${"evasion cases stopped".padEnd(29)}${`${synthetic.filter((r) => classifyOutcome(r) === "stopped").length}/${synthetic.length}`.padEnd(6)}model FLAG ${synthetic.filter(modelFlag).length}/${synthetic.length}`]
        : []),
      `  ${"not judged by the model".padEnd(29)}${notJudged.length}${notJudged.length ? `: ${notJudged.join(", ")}` : ""}`,
    );
  }
  return out;
}
