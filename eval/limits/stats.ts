/** Wilson score interval for k successes in n trials (z = 1.96 gives 95%). */
export function wilson(k: number, n: number, z = 1.96): { lo: number; hi: number } {
  if (n <= 0) return { lo: 0, hi: 1 };
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return { lo: Math.max(0, c - h), hi: Math.min(1, c + h) };
}

export type Scope = "full" | "priority" | "signal" | "ranked" | "none";
/** The stops where no part reached the model, matched at the start of the hold text so wording a model or a path adds later cannot turn a real read into "none": no parts at all, or too large with nothing left to review (signal or priority files alone, or no priority files). */
const NO_READ = /^(not model-reviewable: 0 parts to review|too large for model review: \d+ parts > \d+ \((signal|priority) files alone\); needs a human|too large for model review: [^;]*; no priority files to review)/;
/** How much of the diff the reviewer read, from its hold text: a narrowed review names its scope; a hold with no parts to review read nothing; a landed or plainly held one read it all. */
export const readScope = (detail: string): Scope => (NO_READ.test(detail) ? "none" : /\branked part/.test(detail) ? "ranked" : /\bsignal (part|files)/.test(detail) ? "signal" : /\bpriority files/.test(detail) ? "priority" : "full");
export const scopeNote = (counts: Record<string, number>) => Object.entries(counts).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(", ") || "full 0";
