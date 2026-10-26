// The NAS parity run (spec §6). Each night oupdate's NAS legs run in review-only mode before nas-secure-update.sh and
// record one jsonl line: the deterministic facts (changed images, plugin update list, OS line, pre-gate hits) and the
// two model opinions. This module reads the script's log for the same night back into the same facts, compares them,
// and keeps the ledger. Any deterministic difference resets the count of matching nights. A verdict difference does not
// reset it, but stays "open" until the operator writes its adjudication into the row. Cutover needs PARITY_NIGHTS
// matching nights in a row and no open adjudication anywhere in the ledger.

import type { ParityFacts } from "./model.ts";
import { nasApproved } from "./nas/evidence.ts";

export const PARITY_NIGHTS = 7;

export interface NightFacts {
  changed: string[] | "unknown";
  plugins: string[] | "unknown";
  os: string;
  pregate: string[];
  /** `<router>/<on-prem>` opinions. */
  verdict: string;
}
export interface ScriptNight extends NightFacts {
  date?: string;
  /** The script's summary `containers:` text. */
  final?: string;
  /** The layer diffs the script reviewed, per image, as it logged them. */
  diffs: { ref: string; diff: string }[];
  /** The log has the script's explicit "containers: all images up to date" line. */
  upToDate?: true;
}
export type OupRecord = { date: string; target: string; rev: string; checked: boolean } & ParityFacts;

const uniqSorted = (xs: string[]) => [...new Set(xs)].sort();

export function recordFacts(r: OupRecord | undefined): NightFacts {
  if (!r || !r.checked) return { changed: "unknown", plugins: "unknown", os: "not checked", pregate: [], verdict: "not asked/not asked" };
  return {
    changed: r.changed ? uniqSorted(r.changed) : "unknown",
    plugins: r.plugins ? uniqSorted(r.plugins) : "unknown",
    os: r.os ?? "not checked",
    pregate: [...(r.pregate ?? [])].sort(),
    verdict: r.verdict ? `${r.verdict.router}/${r.verdict.onprem}` : "not asked/not asked",
  };
}

export function parseScriptLog(text: string): ScriptNight {
  let section = "";
  let inSummary = false;
  let date: string | undefined;
  let final: string | undefined;
  let changed: string[] | undefined;
  let plugins: string[] | undefined;
  let os = "not checked";
  let router = "not asked";
  let onprem = "not asked";
  const pregate: string[] = [];
  const diffs: { ref: string; diff: string }[] = [];
  let item: { ref: string; lines: string[] } | undefined;
  let block: { who: "router" | "onprem"; text: string[] } | undefined;
  let gate = false;
  let upToDate = false;
  const endItem = () => {
    if (item) diffs.push({ ref: item.ref, diff: item.lines.join("\n") });
    item = undefined;
  };
  for (const l of text.split("\n")) {
    if (block) {
      if (l.startsWith("│ ") || l === "│") {
        block.text.push(l.slice(2));
        continue;
      }
      const v = nasApproved(block.text.join("\n")) ? "APPROVE" : "FLAG";
      if (block.who === "router") router = v;
      else onprem = v;
      block = undefined;
    }
    if (gate) {
      const m = /^ {4}\d+:(.*)$/.exec(l);
      if (m) {
        pregate.push(m[1]!);
        continue;
      }
      gate = false;
    }
    if (item) {
      if (l.startsWith("    ")) {
        item.lines.push(l.slice(4));
        continue;
      }
      endItem();
    }
    const head = /^=== \S+ \S+ (\d{4}-\d{2}-\d{2}) \d{2}:\d{2} ===$/.exec(l);
    if (head) {
      date = head[1];
      continue;
    }
    if (/^=== \S+ summary ===$/.test(l)) {
      inSummary = true;
      continue;
    }
    if (inSummary) {
      const c = /^ {2}containers: (.*)$/.exec(l);
      if (c) final = c[1];
      continue;
    }
    const sec = /^--- (.+) ---$/.exec(l);
    if (sec) {
      section = sec[1]!;
      if (section === "plugins") plugins = [];
      if (section === "layer diff") changed = [];
      continue;
    }
    if (section === "plugins") {
      const m = /^ {2}(\S+): (\S+) -> (\S+)$/.exec(l);
      if (m) plugins!.push(`${m[1]} ${m[2]} -> ${m[3]}`);
      continue;
    }
    if (l === "containers: all images up to date") {
      changed = [];
      upToDate = true;
      continue;
    }
    if (section === "layer diff") {
      const m = /^ {2}(\S+): running image -> candidate$/.exec(l);
      if (m) {
        changed!.push(m[1]!);
        item = { ref: m[1]!, lines: [] };
      }
      continue;
    }
    if (l.startsWith("┌─ LLM second opinion")) block = { who: "onprem", text: [] };
    else if (l.startsWith("┌─ LLM (")) block = { who: "router", text: [] };
    else if (l === "  LLM review skipped — AI host unreachable") router = "unavailable";
    else if (l.startsWith("  STRUCTURAL PRE-GATE:")) gate = true;
    else if (l.startsWith("OS UPDATE AVAILABLE: ")) os = l.slice("OS ".length);
    else if (l === "OS: up to date") os = "up to date";
    else if (l.startsWith("OS check: could not reach releases API")) os = "check failed (API unreachable)";
  }
  endItem();
  return {
    ...(date ? { date } : {}),
    ...(final ? { final } : {}),
    ...(upToDate ? { upToDate: true as const } : {}),
    diffs,
    changed: changed ? uniqSorted(changed) : "unknown",
    plugins: plugins ? uniqSorted(plugins) : "unknown",
    os,
    pregate: pregate.sort(),
    verdict: `${router}/${onprem}`,
  };
}

export type Field = "changed" | "plugins" | "os" | "pregate";
const FIELDS: Field[] = ["changed", "plugins", "os", "pregate"];
const UNSURE = new Set(["unknown", "not checked"]);
const same = (a: string[] | string, b: string[] | string) => !(typeof a === "string" && UNSURE.has(a)) && !(typeof b === "string" && UNSURE.has(b)) && JSON.stringify(a) === JSON.stringify(b);

export interface NightCompare {
  date: string;
  fields: Record<Field, boolean>;
  match: boolean;
  verdictOupdate: string;
  verdictScript: string;
}

export function compareNight(date: string, oup: NightFacts, script: NightFacts): NightCompare {
  const fields = Object.fromEntries(FIELDS.map((f) => [f, same(oup[f], script[f])])) as Record<Field, boolean>;
  return { date, fields, match: FIELDS.every((f) => fields[f]), verdictOupdate: oup.verdict, verdictScript: script.verdict };
}

export const LEDGER_HEAD = "date\tchanged\tplugins\tos\tpregate\tmatch\tstreak\tverdict-oupdate\tverdict-script\tadjudication";

export interface LedgerRow {
  date: string;
  cells: Record<Field, "same" | "DIFFERS">;
  match: boolean;
  streak: number;
  verdictOupdate: string;
  verdictScript: string;
  /** "" when the verdicts agree; "open" until the operator writes who was right (and, if oupdate was wrong, the prompt fix). */
  adjudication: string;
}

const cell = (s: string | undefined): "same" | "DIFFERS" | undefined => (s === "same" || s === "DIFFERS" ? s : undefined);

/** Each row's streak recomputed from the dates and match results alone; a stored streak is never trusted. */
export function restreak(rows: LedgerRow[]): LedgerRow[] {
  const out: LedgerRow[] = [];
  for (const r of rows) {
    const last = out[out.length - 1];
    out.push({ ...r, streak: r.match ? (last && nextDay(last.date, r.date) ? last.streak : 0) + 1 : 0 });
  }
  return out;
}

export function parseLedger(text: string | undefined): LedgerRow[] {
  if (!text) return [];
  const [head, ...rows] = text.replace(/\n+$/, "").split("\n");
  if (head !== LEDGER_HEAD) throw new Error("parity ledger: unexpected header");
  const parsed = rows.map((l, i) => {
    const c = l.split("\t");
    const cells = { changed: cell(c[1]), plugins: cell(c[2]), os: cell(c[3]), pregate: cell(c[4]) };
    if (c.length !== 10 || !/^\d{4}-\d{2}-\d{2}$/.test(c[0]!) || !/^\d+$/.test(c[6]!) || Object.values(cells).some((v) => v === undefined) || (c[5] !== "yes" && c[5] !== "no")) {
      throw new Error(`parity ledger: row ${i + 2} is not valid`);
    }
    return { date: c[0]!, cells: cells as LedgerRow["cells"], match: c[5] === "yes", streak: Number(c[6]), verdictOupdate: c[7]!, verdictScript: c[8]!, adjudication: c[9]! };
  });
  parsed.forEach((r, i) => {
    if (i > 0 && r.date <= parsed[i - 1]!.date) throw new Error(`parity ledger: row ${i + 2} is not after row ${i + 1}`);
  });
  return restreak(parsed);
}

/** True when `b` is the calendar day after `a` (both YYYY-MM-DD). */
export function nextDay(a: string, b: string): boolean {
  const ms = (d: string) => Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)));
  return ms(b) - ms(a) === 86_400_000;
}

/** The streak counts consecutive calendar nights: a deterministic difference resets it to 0, a skipped night restarts it at 1. */
export function addNight(rows: LedgerRow[], n: NightCompare): LedgerRow {
  const last = restreak(rows).at(-1);
  if (rows.some((r) => r.date === n.date)) throw new Error(`parity: ${n.date} is already in the ledger`);
  if (last && n.date < last.date) throw new Error(`parity: ${n.date} is before the ledger's last night ${last.date}`);
  const cells = Object.fromEntries(FIELDS.map((f) => [f, n.fields[f] ? "same" : "DIFFERS"])) as LedgerRow["cells"];
  return {
    date: n.date,
    cells,
    match: n.match,
    streak: n.match ? (last && nextDay(last.date, n.date) ? last.streak : 0) + 1 : 0,
    verdictOupdate: n.verdictOupdate,
    verdictScript: n.verdictScript,
    adjudication: n.verdictOupdate === n.verdictScript ? "" : "open",
  };
}

export function renderLedger(rows: LedgerRow[]): string {
  const line = (r: LedgerRow) => [r.date, r.cells.changed, r.cells.plugins, r.cells.os, r.cells.pregate, r.match ? "yes" : "no", String(r.streak), r.verdictOupdate, r.verdictScript, r.adjudication].join("\t");
  return `${[LEDGER_HEAD, ...rows.map(line)].join("\n")}\n`;
}

export function ledgerStatus(rows: LedgerRow[]): { streak: number; open: number; ready: boolean; line: string } {
  const streak = restreak(rows).at(-1)?.streak ?? 0;
  const open = rows.filter((r) => r.adjudication === "open").length;
  const ready = streak >= PARITY_NIGHTS && open === 0;
  const openText = open ? `, ${open} verdict difference${open === 1 ? "" : "s"} open` : "";
  return { streak, open, ready, line: `parity: ${streak} of ${PARITY_NIGHTS} matching nights in a row${openText}${ready ? " — ready for cutover" : ""}` };
}
