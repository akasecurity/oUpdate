// The pins diff review: the proposed pins diff and the evidence for each changed value go to the
// configured reviewer (the same Reviewer and verdict rule as review.ts). Only an APPROVE lets the leg
// write a branch; no reviewer, a failure or anything else is no proposal.

import { parseVerdict, VERDICT_CONTRACT, type Reviewer } from "../../review.ts";

export interface PinChange {
  group: string;
  from: string;
  to: string;
  evidence: string[];
}

export interface PinsReviewInput {
  pinsPath: string;
  changes: PinChange[];
  diff: string;
}

export interface PinsVerdict {
  verdict: "APPROVE" | "FLAG" | "error";
  /** The reviewer's name, or the error. */
  detail: string;
  text?: string;
}

export function pinsPrompt(a: PinsReviewInput): string {
  const ev = a.changes.flatMap((c) => [`[${c.group}] ${c.from} -> ${c.to}`, ...c.evidence.map((e) => `  ${e}`)]).join("\n");
  return `You are reviewing a proposed bump of pinned versions and hashes in ${a.pinsPath}, the pins file of a container base image, before it goes to a branch. A person rebuilds, scans and bakes the image from that branch; nothing is installed by this change itself.
Each changed value was read by a program from the source named in the evidence. Check for these explicit indicators only:
1. A changed line whose new value does not appear, character for character, in the evidence of its group.
2. A hash or integrity value that changes while its group's version stays the same (an image digest under a fixed tag is the exception: it moves when the tag is rebuilt, and its apt snapshot id moves with it).
3. Evidence that names a source other than the package's own registry entry, the project's own release, or the image's own repository.
Ordinary version, hash and digest bumps with none of these are APPROVE.

${VERDICT_CONTRACT}

--- evidence ---
${ev}
--- diff of ${a.pinsPath} ---
${a.diff}`;
}

export async function reviewPins(r: Reviewer | undefined, a: PinsReviewInput): Promise<PinsVerdict> {
  if (!r) return { verdict: "error", detail: "no reviewer configured" };
  let text: string;
  try {
    text = await r.review(pinsPrompt(a));
  } catch (e) {
    return { verdict: "error", detail: `${r.name}: ${e instanceof Error ? e.message : String(e)}` };
  }
  return { verdict: parseVerdict(text), detail: r.name, text };
}
