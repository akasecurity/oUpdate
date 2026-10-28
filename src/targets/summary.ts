// One summary line per target, published as a status tsv: "host", "date", "rev" and "summary" rows, tab separated. A
// status reader marks a line as trouble when it matches TROUBLE_WORDS, so a target with trouble must carry one of them.

import type { LegResult } from "./model.ts";

/** The trouble words a status reader looks for, case-insensitive. */
export const TROUBLE_WORDS = /flag|block|cve|error|fail|abort|no status|stuck|stale|divergent/i;

/** Tabs and line breaks would split a tsv row: each run becomes one space. */
export function oneLine(s: string): string {
  return s.replace(/[\t\r\n]+/g, " ");
}

export function joinLegs(legs: { kind: string; result: LegResult }[]): { summary: string; trouble: boolean } {
  const trouble = legs.some((l) => l.result.trouble);
  let summary = oneLine(legs.length === 1 ? legs[0]!.result.summary : legs.map((l) => `${l.kind}: ${l.result.summary}`).join(" · "));
  if (trouble && !TROUBLE_WORDS.test(summary)) summary += " · error: see the targets log";
  return { summary, trouble };
}

const two = (n: number) => String(n).padStart(2, "0");

/** Local "YYYY-MM-DD HH:MM", the tsv's date field (a reader compares the first word with today). */
export function stamp(d: Date): string {
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

export interface StatusRow {
  host: string;
  date: string;
  rev: string;
  summary: string;
}

export function statusTsv(r: StatusRow): string {
  return [`host\t${oneLine(r.host)}`, `date\t${oneLine(r.date)}`, `rev\t${oneLine(r.rev)}`, `summary\t${oneLine(r.summary)}`].join("\n") + "\n";
}
