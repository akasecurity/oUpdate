// One summary line per target, published in the tsv shape a status reader already reads for pushed
// hosts: "host", "date", "rev" and "summary" rows, tab separated. The digest marks a line red when it
// matches its TROUBLE_RE, so a target with trouble must carry one of those words.

import type { LegResult } from "./model.ts";

/** the status reader's trouble words , case-insensitive. */
export const DIGEST_TROUBLE = /flag|block|cve|error|fail|abort|no status|stuck|stale|divergent/i;

/** Tabs and line breaks would split a tsv row: each run becomes one space. */
export function oneLine(s: string): string {
  return s.replace(/[\t\r\n]+/g, " ");
}

export function joinLegs(legs: { kind: string; result: LegResult }[]): { summary: string; trouble: boolean } {
  const trouble = legs.some((l) => l.result.trouble);
  let summary = oneLine(legs.length === 1 ? legs[0]!.result.summary : legs.map((l) => `${l.kind}: ${l.result.summary}`).join(" · "));
  if (trouble && !DIGEST_TROUBLE.test(summary)) summary += " · error: see the targets log";
  return { summary, trouble };
}

const two = (n: number) => String(n).padStart(2, "0");

/** Local "YYYY-MM-DD HH:MM", the digest's date field (it compares the first word with today). */
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
