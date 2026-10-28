// The container review's evidence, built the way the shell updater builds it (its image review diff, structural hits
// and review-approved functions), so that a parity night compares like with like. The evidence is
// Entrypoint, Cmd and history only. Missing evidence is a BASELINE MISSING line, which the pre-gate always hits.

import type { ImageEvidence } from "../broker/answer.ts";

export const MISSING_ID = "BASELINE MISSING: running or candidate image ID unavailable";
export const MISSING_HISTORY = "BASELINE MISSING: image history unavailable";

/** Entrypoint and Cmd as the previous updater compared them: `<entrypoint json>|<cmd json>` (the decoder made both canonical). */
export const startLine = (e: ImageEvidence): string => `${e.entrypoint}|${e.cmd}`;

/** History as `docker history --format '{{.CreatedBy}}'` prints it: one line per line of each entry. */
export const historyLines = (e: ImageEvidence): string[] => e.history.flatMap((h) => h.split("\n"));

/** The lines `diff old now` prints with "> ": what `now` adds, by a longest common subsequence after trimming shared ends. */
export function addedLines(old: string[], now: string[]): string[] {
  let pre = 0;
  while (pre < old.length && pre < now.length && old[pre] === now[pre]) pre++;
  let suf = 0;
  while (suf < old.length - pre && suf < now.length - pre && old[old.length - 1 - suf] === now[now.length - 1 - suf]) suf++;
  const a = old.slice(pre, old.length - suf);
  const b = now.slice(pre, now.length - suf);
  const n = a.length;
  const m = b.length;
  // The answer cap (64 KiB) bounds both sides well under 65535 lines.
  const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let k = m - 1; k >= 0; k--) L[i]![k] = a[i] === b[k] ? L[i + 1]![k + 1]! + 1 : Math.max(L[i + 1]![k]!, L[i]![k + 1]!);
  const out: string[] = [];
  let i = 0;
  let k = 0;
  while (k < m) {
    if (i < n && a[i] === b[k]) {
      i++;
      k++;
    } else if (i < n && L[i + 1]![k]! >= L[i]![k + 1]!) i++;
    else out.push(b[k++]!);
  }
  return out;
}

// Docker metadata instructions, not RUN commands that mention startup files (the previous updater's grep -vE, case-sensitive).
const META = /^(ENTRYPOINT|CMD)(\s|$)|^\/bin\/sh -c #\(nop\)\s+(ENTRYPOINT|CMD)(\s|$)/;

export function reviewDiff(running: ImageEvidence | undefined, candidate: ImageEvidence | undefined): string {
  if (!running || !candidate) return MISSING_ID;
  const oldH = historyLines(running);
  const newH = historyLines(candidate);
  if (!running.history.length || !candidate.history.length) return MISSING_HISTORY;
  const out: string[] = [];
  const a = startLine(running);
  const b = startLine(candidate);
  if (a !== b) out.push(`ENTRYPOINT/CMD changed: ${a} -> ${b}`);
  out.push(...addedLines(oldH, newH).filter((l) => !META.test(l)));
  return out.join("\n");
}

/** The previous updater's layer diffs: `[ref]`, the image's diff, then a blank line, per image. */
export const layerDiffs = (items: { ref: string; diff: string }[]): string => items.map((i) => `[${i.ref}]\n${i.diff}\n\n`).join("");

const S = "[ \\t\\v\\f\\r]";
/** nas_structural_hits' grep -inE, line by line: things a grep decides, not a model. It can only add a hold. */
export const IMAGE_PREGATE = new RegExp(
  `BASELINE MISSING|ENTRYPOINT|(^|${S})CMD${S}|(curl|wget)[^|]*\\|${S}*(sudo${S}+)?(ba|z|da)?sh([^A-Za-z0-9_.-]|$)|id_rsa|id_ed25519|\\.ssh/|AWS_SECRET|/etc/shadow`,
  "i",
);

export const structuralHits = (diffs: string): string[] => diffs.split("\n").filter((l) => IMAGE_PREGATE.test(l));

/**
 * nas_review_approved: an affirmative line (APPROVE, "2. APPROVE", "Verdict: APPROVE", a trailing reason allowed) and no
 * line that flags, holds, negates, qualifies the approval or mentions APPROVE / VERDICT: in any other way.
 */
export function approvedAnswer(text: string): boolean {
  let approved = false;
  let bad = false;
  for (const raw of text.split("\n")) {
    const line = raw.toUpperCase();
    if (/(^|[^A-Z0-9_])(FLAG[A-Z]*|HOLD|REJECT[A-Z]*|DENY|DENIED|BLOCK[A-Z]*|UNAVAILABLE)([^A-Z0-9_]|$)/.test(line)) bad = true;
    if (/(^|[^A-Z0-9_])(DO NOT|DON.T|NEVER)\s+(INSTALL|UPGRADE|PROCEED|DEPLOY)([^A-Z0-9_]|$)/.test(line)) bad = true;
    if (/(^|[^A-Z0-9_])(IS|LOOKS|APPEARS|SEEMS)\s+(UNSAFE|MALICIOUS|SUSPICIOUS|DANGEROUS)([^A-Z0-9_]|$)/.test(line)) bad = true;
    if (/APPROVE(\s*,)?\s+(IF|UNLESS|ONLY|PROVIDED|ASSUMING|PENDING|BUT|ONCE|WHEN|AFTER|CONDITIONALLY|TENTATIVELY)([^A-Z0-9_]|$)/.test(line)) bad = true;
    if (/^\s*([0-9]+[.)]\s*)?(VERDICT:\s*)?APPROVE([^A-Z0-9_]|$)/.test(line)) approved = true;
    else if (/APPROVE|VERDICT:/.test(line)) bad = true;
  }
  return approved && !bad;
}
