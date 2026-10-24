// The host apply's verdict rule, ported from the previous updater: line 1 (the first non-blank
// line) must be exactly APPROVE, ignoring case and a trailing "." or "!". Anything else on
// that line, or an empty answer, is a FLAG. An APPROVE whose body still carries a verdict
// word is contradictory: the chunk is asked once more with CLARIFY, and a repeat is a FLAG.
// A FLAG without grounded quotes is asked once more too; the two reasons share one retry,
// so a chunk never costs more than two reviewer calls.
//
// Two deliberate changes from the previous updater: it also needed its reviewer's own literal
// first-line check, so a leading blank line cost a retry and "APPROVE." was a FLAG; here both
// approve on the first call. And the body is read twice, as written and folded (markdown
// emphasis, bullets and quote markers, curly apostrophes, zero-width characters and look-alike
// letters folded, NFKC applied, so a fullwidth "Verdict：" line is a second verdict too),
// a match in either reading counts. The contradiction list itself is the previous updater's.
// Line 1 is trimmed as JavaScript trims, so a BOM or no-break space around APPROVE is ignored,
// and a bare CR ends a line ("APPROVE\rClean." is APPROVE with the body "Clean.").
// A body line that starts with "Verdict:" (after markdown, bullets or quote markers) is a
// second verdict unless it is exactly "Verdict: APPROVE". Otherwise the contradiction list,
// CLARIFY and the second-verdict rule are the previous updater's, word for word.

import type { Reviewer } from "../review.ts";
import { foldConfusables } from "./ground.ts";

export const CLARIFY =
  "Answer with APPROVE or FLAG alone on the first line. If you APPROVE, do not use the words flag, block, blocks, hold, reject or deny anywhere in your reply.";

// Conservative on purpose (the previous updater's verdictOf): even a negated hold or flag is ambiguous.
const CONTRADICTION = [
  /\b(FLAG\w*|HOLD|REJECT\w*|DENY|DENIED|BLOCK\w*)\b/i,
  /\b(not|never|cannot|don't|do not)\s+approve\b/i,
  /\b(do not|don't|never)\s+(install|upgrade|proceed|deploy)\b/i,
  /\b(is|looks|appears|seems)\s+(unsafe|malicious|suspicious|dangerous)\b/i,
];
// At line start, after the prefixes the folded reading strips; "Overall verdict: routine" is prose.
const SECOND_VERDICT = /^\s*(?:\d+[.)]\s*)?Verdict:/i;
const SECOND_APPROVE = /^\s*(?:\d+[.)]\s*)?Verdict:\s*APPROVE\s*$/i;

export function firstVerdict(text: string): { first: "APPROVE" | "FLAG"; contradictory: boolean } {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const at = lines.findIndex((l) => l.trim() !== "");
  if (at < 0 || !/^APPROVE[.!]?$/i.test(lines[at]!.trim())) return { first: "FLAG", contradictory: false };
  const raw = lines.slice(at + 1);
  // Folding ("**Verdict:**", "> > Verdict:", "- Verdict:", "Don’t", "FL\u200bAG") must not hide a
  // second verdict; checking the raw text too keeps what folding would join ("**HOLD**ing").
  const folded = raw.map((l) =>
    foldConfusables(l.normalize("NFKC"))
      .replace(/\p{Cf}/gu, "")
      .replace(/[\u2018\u2019\u02bc]/g, "'")
      .replace(/[*_`]/g, "")
      .replace(/^\s*(?:[#>]+\s*|[-+\u2022]\s+)+/, ""),
  );
  // Phrases are matched across line breaks ("do not\napprove"); the second-verdict check is per line.
  const contradictory = [raw, folded].some(
    (body) => CONTRADICTION.some((re) => re.test(body.join("\n"))) || body.some((l) => SECOND_VERDICT.test(l) && !SECOND_APPROVE.test(l)),
  );
  return { first: "APPROVE", contradictory };
}

/** Whether a FLAG's quoted evidence is in the diff: GROUNDED, UNGROUNDED (quotes not found) or NOQUOTE. */
export type Grounding = (answer: string) => "GROUNDED" | "UNGROUNDED" | "NOQUOTE";

export interface ChunkVerdict {
  verdict: "APPROVE" | "FLAG" | "UNAVAILABLE";
  calls: number;
  log: string[];
  /** For a FLAG: the answer's first line and why it stood, for the notice. */
  reason?: string;
}

/** Every answer goes into the log in a box, as the previous updater printed it, so a held update shows what the reviewer said. */
export function reviewBox(title: string, answer: string): string[] {
  return [`┌─ ${title}`, ...answer.replace(/\r\n?/g, "\n").split("\n").map((l) => `│ ${l}`), "└─"];
}

export async function reviewChunk(r: Reviewer, prompt: string, opts: { ground: Grounding; box?: string; chunk?: number }): Promise<ChunkVerdict> {
  const log: string[] = [];
  const again = `re-reviewing ${opts.chunk === undefined ? "" : `chunk ${opts.chunk} `}once`;
  let ask = prompt;
  for (let calls = 1; ; calls++) {
    let text: unknown;
    try {
      text = await r.review(ask);
    } catch {
      text = undefined;
    }
    if (typeof text !== "string") {
      log.push(...reviewBox(opts.box ?? "review", "[reviewer unavailable]"));
      return { verdict: "UNAVAILABLE", calls, log, reason: "[no review output: reviewer unavailable]" };
    }
    log.push(...reviewBox(opts.box ?? "review", text));
    const first = text.replace(/\r\n?/g, "\n").split("\n").find((l) => l.trim() !== "")?.trim() ?? "";
    const reason = (why = "") => (first ? first + why : "[no review output]");
    const v = firstVerdict(text);
    const retry = calls === 1;
    if (v.first === "APPROVE" && !v.contradictory) return { verdict: "APPROVE", calls, log };
    if (v.first === "APPROVE") {
      if (!retry) return { verdict: "FLAG", calls, log, reason: reason(" (contradictory APPROVE)") };
      log.push(`contradictory APPROVE (verdict words in an approval): ${again}`);
      ask = `${prompt}\n\n${CLARIFY}`;
      continue;
    }
    let g: ReturnType<Grounding> | "TOOLFAIL";
    try {
      g = opts.ground(text);
    } catch {
      g = "TOOLFAIL";
    }
    if (retry && g === "UNGROUNDED") {
      log.push(`ungrounded FLAG (quotes not in diff): ${again}`);
      ask = prompt;
      continue;
    }
    if (retry && g === "NOQUOTE") {
      log.push(`FLAG without quoted evidence: ${again}`);
      ask = prompt;
      continue;
    }
    return { verdict: "FLAG", calls, log, reason: reason(g === "UNGROUNDED" ? " (ungrounded)" : "") };
  }
}
