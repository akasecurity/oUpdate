// The text lines a run writes into summary.txt after each case.

import { isHumanHold, parseVerdict, stripTerminal, type ReviewResult } from "../src/review.ts";

const flat = (t: string) => stripTerminal(t.replace(/\s+/g, " ")).trim();

/**
 * One line per layer, its detail (it can carry package text) flattened and stripped of terminal controls, cut at 220 characters, then, for a case the model reviewer stopped
 * (not a hold for a human), the reviewer's whole answer on one line: the layer detail keeps only the
 * first 240 characters of the first reasoning line, which is too short to tell a false hold from a catch.
 */
export function layerLines(r: ReviewResult): string[] {
  const out = r.layers.map((l) => `    ${l.layer.padEnd(9)} ${l.verdict.padEnd(7)} ${flat(l.detail).slice(0, 220)}`);
  const stop = r.layers.find((l) => l.layer === "reviewer" && l.verdict === "stop");
  if (stop && !isHumanHold(stop)) {
    const flagged = (r.reviewerText ?? []).filter((t) => parseVerdict(t) === "FLAG");
    for (const t of flagged) out.push(`    ${"reason".padEnd(9)} ${flat(t)}`);
  }
  return out;
}
