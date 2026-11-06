/** Wilson score interval for k successes in n trials (z = 1.96 gives 95%). */
export function wilson(k: number, n: number, z = 1.96): { lo: number; hi: number } {
  if (n <= 0) return { lo: 0, hi: 1 };
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return { lo: Math.max(0, c - h), hi: Math.min(1, c + h) };
}

export type Scope = "full" | "priority" | "signal" | "ranked" | "partial" | "none";
/** The stops where no part reached the model, matched at the start of the hold text so wording a model or a path adds later cannot turn a real read into "none": no parts at all, or too large with nothing left to review (signal or priority files alone, or no priority files). */
const NO_READ = /^(not model-reviewable: 0 parts to review|too large for model review: \d+ parts > \d+ \((signal|priority) files alone\); needs a human|too large for model review: [^;]*; no priority files to review)/;
/** How much of the diff the reviewer read, from its hold text: a narrowed review names its scope; a hold with no parts to review read nothing; a landed or plainly held one read it all. */
/** A spent read time budget: some parts were read and the rest never, whatever tier narrowed the diff first. */
const BUDGET_STOP = /^\d+ of \d+ part\(s\) read, the read time budget/;
export const readScope = (detail: string): Scope => (BUDGET_STOP.test(detail) ? "partial" : NO_READ.test(detail) ? "none" : /\branked part/.test(detail) ? "ranked" : /\bsignal (part|files)/.test(detail) ? "signal" : /\bpriority files/.test(detail) ? "priority" : "full");
export const scopeNote = (counts: Record<string, number>) => Object.entries(counts).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(", ") || "full 0";

/** The read time budget of a limits run, in milliseconds. A budgeted run is not comparable with the committed baseline, so it must name its own --out directory and never overwrite results/<version>.* . */
export function parseReadBudget(raw: string | undefined, out: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (raw === "" || !Number.isInteger(n) || n < 1 || n > 86_400_000) throw new Error("--max-read-ms must be a whole number of milliseconds from 1 to 86400000");
  if (!out) throw new Error("--max-read-ms needs --out <dir>, so a budgeted run never overwrites the committed baseline results");
  return n;
}
