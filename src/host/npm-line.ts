// The npm lane of a run's summary: one reader of its parts for the digest and the shadow report, so the two never
// disagree about where a part ends. The writers (src/apply/run-steps.ts finishRun, npm.ts) join parts with "; ".

/** An install that already happened, then found off the reviewed version: "FLAGGED — <pkg> installed <v>, reviewed <v>[, ...]". */
export const OFF_VERSION = /^FLAGGED — ([^\s,]+ installed [^\s,]+, reviewed [^\s,]+(?:, [^\s,]+ installed [^\s,]+, reviewed [^\s,]+)*)$/;

/** A batch hold: the reviewer's reason is the rest of the status. */
export const BATCH_HOLD = /^(?:FLAGGED|STRUCTURAL FLAG)\b/;

/** The part that follows the npm status on the line. */
const AFTER_STATUS = "claude-code: ";

/**
 * The parts of one npm line, split on "; ". A batch hold's reason can quote "; ERROR — x" or "; FAILED — y": after a
 * hold, every fragment up to the claude-code part is joined back into it (the off-version form is no reason: real parts
 * can follow it).
 */
export function npmParts(line: string): string[] {
  const parts: string[] = [];
  let hold = false;
  for (const raw of line.split("; ")) {
    const frag = raw.trim();
    if (!frag) continue;
    if (hold && !frag.startsWith(AFTER_STATUS)) {
      parts[parts.length - 1] += `; ${frag}`;
      continue;
    }
    parts.push(frag);
    hold = BATCH_HOLD.test(frag) && !OFF_VERSION.test(frag);
  }
  return parts;
}
