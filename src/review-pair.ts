// The two-reviewer rule (the previous updater's second opinion): the first model reviews first; only when it
// approves is the second model asked the same prompt, and only two APPROVEs clear an item. A reviewer that throws,
// answers nothing or is not configured is "unavailable", which holds. Shared by the image, compose, GCE and
// plugin legs, so it lives beside review.ts rather than under one target.

import type { Reviewer } from "./review.ts";

export interface ReviewerPair {
  first?: Reviewer;
  second?: Reviewer;
}
export type Opinion = "APPROVE" | "FLAG" | "unavailable" | "not asked";
export interface PairVerdict {
  first: Opinion;
  second: Opinion;
  approved: boolean;
  lines: string[];
}

export async function reviewTwice(r: ReviewerPair, prompt: string, accept: (text: string) => boolean): Promise<PairVerdict> {
  const lines: string[] = [];
  const ask = async (who: string, rev: Reviewer | undefined): Promise<Opinion> => {
    if (!rev) {
      lines.push(`${who}: no reviewer configured`);
      return "unavailable";
    }
    let text: string;
    try {
      text = await rev.review(prompt);
    } catch (e) {
      lines.push(`${who} (${rev.name}): ${e instanceof Error ? e.message : String(e)}`);
      return "unavailable";
    }
    if (!text.trim()) {
      lines.push(`${who} (${rev.name}): empty answer`);
      return "unavailable";
    }
    lines.push(`┌─ ${who} (${rev.name})`, ...text.split("\n").map((l) => `│ ${l}`), "└─");
    return accept(text) ? "APPROVE" : "FLAG";
  };
  const first = await ask("first", r.first);
  const second: Opinion = first === "APPROVE" ? await ask("second", r.second) : "not asked";
  return { first, second, approved: first === "APPROVE" && second === "APPROVE", lines };
}
