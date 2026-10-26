// The NAS review rule (spec §4, the script's on-prem second opinion): the router model reviews first; only when it
// approves is the on-prem model asked the same prompt, and only two APPROVEs clear an item. A reviewer that throws,
// answers nothing or is not configured is "unavailable", which holds.

import type { Reviewer } from "../../review.ts";

export interface NasReviewers {
  router?: Reviewer;
  onprem?: Reviewer;
}
export type Opinion = "APPROVE" | "FLAG" | "unavailable" | "not asked";
export interface NasVerdict {
  router: Opinion;
  onprem: Opinion;
  approved: boolean;
  lines: string[];
}

export async function reviewTwice(r: NasReviewers, prompt: string, accept: (text: string) => boolean): Promise<NasVerdict> {
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
  const router = await ask("router", r.router);
  const onprem: Opinion = router === "APPROVE" ? await ask("on-prem", r.onprem) : "not asked";
  return { router, onprem, approved: router === "APPROVE" && onprem === "APPROVE", lines };
}
