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

/**
 * A part some writer produces, in its whole form (no stray ";" inside a name list, which is how a legacy line that joined
 * parts with a bare ";" shows). A part that fits none is kept by the shadow report as unrecognized, never dropped.
 */
const KNOWN_PART = [
  /^upgraded:(?: [^\s;]+)+$/,
  /^FAILED — [^\s;]+$/,
  // src/apply/run-steps.ts claudeCodeStep: the version is one field; a failure is "(rc=<n>|timeout, on <version>)".
  /^claude-code: (?:not configured|not completed|dry-run|not run \([^;]*\)|FAILED \((?:rc=\d+|timeout), on [^\s;]+\)|[^\s;]+)$/,
  /^(?:nothing to update|nothing approved for upgrade|not run|dry-run OK|not managed here [^;]*)$/,
  /^not completed(?: — still pending: [^;]+)?$/,
  // src/apply/npm.ts: the npm path inside the first form is configured text and can hold ";".
  /^ERROR — (?:.+ not found, npm globals not checked|npm outdated query failed \(rc \d+\)|pending query failed|stuck state unusable)$/,
  /^STUCK: [^;]+$/,
];

export function isKnownNpmPart(part: string): boolean {
  return BATCH_HOLD.test(part) || KNOWN_PART.some((re) => re.test(part));
}
