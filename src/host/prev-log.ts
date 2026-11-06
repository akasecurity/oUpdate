// The previous updater's run log: the last "=== <host> summary ===" block and the run header before it,
// "=== [<prefix>-]<name> <host> <date> …" (name: compat.ts previousUpdater; a host run writes "oupdate-<name>", so its
// own logs read the same way). Two holds show only in the run body, between the two:
// a Type B FLAG (a third-party tap's formula review) and a CASK_EXCLUDE skip.

import { MAS_NOT_CHECKED } from "../apply/summary-text.ts";
import { DEFAULT_COMPAT } from "../targets/compat.ts";

export interface PrevSummary {
  date?: string;
  // pinned: held because a repo's pins.json lists them; brew-pinned ones are left to Outdated.pinned.
  brew: { upgraded: string[]; failed: string[]; flagged: string[]; stuck: string[]; pinned?: string[]; excluded?: string[] };
  // flagged: the whole pending batch was held (FLAGGED, or a structural flag); the summary names none of it.
  // claudeCode: the version reported (on a failure, the one it is stuck on, when known); claudeCodeFailed: its update failed.
  npm: { upgraded: string[]; flagged?: boolean; failed?: string[]; claudeCode?: string; claudeCodeFailed?: boolean };
  aborted: boolean;
}

const words = (s: string) => s.split(/\s+/).filter(Boolean);

function parseBrew(line: string): PrevSummary["brew"] {
  const b: PrevSummary["brew"] = { upgraded: [], failed: [], flagged: [], stuck: [] };
  for (const raw of line.split(";")) {
    const p = raw.trim();
    let m: RegExpMatchArray | null;
    if ((m = p.match(/^(?:casks )?upgraded:(.*)$/))) b.upgraded.push(...words(m[1]!));
    else if ((m = p.match(/^(?:casks )?FAILED:(.*)$/))) b.failed.push(...words(m[1]!));
    else if (p.startsWith("FLAGGED — awaiting tap approval:")) for (const f of p.matchAll(/\(([^\s(),]+) \S+→/g)) b.flagged.push(f[1]!);
    else if (p.startsWith("PINNED:")) for (const x of p.slice(7).matchAll(/(\S+)\(([^)]*)\)/g)) { if (x[2] !== "brew pin") (b.pinned ??= []).push(x[1]!); }
    else if (p.startsWith("STUCK:")) for (const s of p.slice(6).matchAll(/(?:^|\s)([^\s=]+)=[^\s(]*\(/g)) b.stuck.push(s[1]!);
  }
  b.failed = [...new Set(b.failed)];
  return b;
}

function parseNpm(line: string): PrevSummary["npm"] {
  const n: PrevSummary["npm"] = { upgraded: [], flagged: false, failed: [] };
  for (const raw of line.split(";")) {
    const p = raw.trim();
    const up = p.match(/^upgraded:(.*)$/);
    if (up) n.upgraded.push(...words(up[1]!));
    if (/^(?:FLAGGED|STRUCTURAL FLAG)\b/.test(p)) n.flagged = true;
    const failed = p.match(/^FAILED — (\S+)$/);
    if (failed) n.failed!.push(failed[1]!);
    const cc = p.match(/^claude-code: (\S+)$/);
    if (cc) n.claudeCode = cc[1];
    // The previous updater's "FAILED (rc=<rc>, on <ver>)" and oupdate's "FAILED (timeout, on <ver>)".
    const ccf = p.match(/^claude-code: FAILED \((?:rc=\d+|timeout), on (\S+)\)$/);
    if (ccf) {
      n.claudeCodeFailed = true;
      if (ccf[1] !== "unknown") n.claudeCode = ccf[1];
    }
  }
  return n;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A Type B FLAG notice from the run body; kind is its parenthesized label ("formula", "HEAD", "app bundle"), when given. */
export interface TypeBFlag {
  name: string;
  kind?: string;
}

/** What a run log holds around one summary line: the body's holds and the summary block's lane lines. */
export interface RunBlock {
  typeB: TypeBFlag[];
  excluded: string[];
  /** Every lane line of the summary block, in order (a repeated lane is kept, never overwritten). */
  lanes: { lane: "brew" | "npm"; text: string }[];
  /** Lines of the summary block that are no lane line (brew, npm or mas) and not blank, such as a lane text that broke across lines. */
  other: string[];
  /** An "=== ABORTED" line in the run, before or after its summary: the run did not complete. */
  aborted: boolean;
  /** The run header's date, when `dated` was given and found. */
  date?: string;
}

// Lines the run itself writes after its lane lines, which are not strays: the mas lane's fixed text,
// the two notice lines makeNotify writes ("[notify] ..." and "[dry-run — not notified] ...") and,
// directly after a "[notify] " line, its send-failure note. A continuation that matches one of these
// exactly is skipped too; the summary writer puts each lane on one line, so a new log has none.
const MAS_TEXT = new RegExp(`^\\s+mas:\\s+${MAS_NOT_CHECKED.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
const NOTICE = /^\[(?:notify|dry-run — not notified)\] /;
const runOwnLine = (l: string, prev: string | undefined) =>
  MAS_TEXT.test(l) || NOTICE.test(l) || (/^\s+the notice could not be sent$/.test(l) && prev !== undefined && /^\[notify\] /.test(prev));

/**
 * Reads the run log around the summary line at `at`: the body before it, back to the host's own
 * run header when `dated` (capturing host, then date) is given, else to the start; then the summary
 * block after it until a line `end` matches ("=== ABORTED" never ends it). The one reader for the
 * shadow report and the digest.
 *
 * Without `dated` (the digest passes none), or when no earlier line is the host's own dated run
 * header, the body scan has no start line and runs back to the first line of `lines`: a Type B
 * notice, a CASK_EXCLUDE skip or an "=== ABORTED" line from an earlier run in the same text is
 * then read as this run's. Pass a log that holds only this run (or give `dated`) to bound it.
 */
export function readRunBlock(lines: string[], at: number, o: { host: string; dated?: RegExp; end: (l: string) => boolean }): RunBlock {
  const r: RunBlock = { typeB: [], excluded: [], lanes: [], other: [], aborted: false };
  for (let i = at - 1; i >= 0; i--) {
    const l = lines[i]!;
    const h = o.dated && l.match(o.dated);
    if (h && h[1] === o.host) {
      r.date = h[2];
      break;
    }
    // The stop line is written on the signal, so it usually comes before the summary.
    if (/^=== ABORTED:/.test(l)) r.aborted = true;
    // Only the notice line itself: a reviewer's reason quoting one is not a notice.
    const tb = l.match(/^\[(?:notify|[a-z-]+ — not notified)\] \S+ \S+ Type B FLAG — ([^\s<]+)(?: \(([^)<]{1,40})\))?/);
    if (tb) r.typeB.unshift(tb[2] ? { name: tb[1]!, kind: tb[2] } : { name: tb[1]! });
    const ex = l.match(/^\s+excluding (\S+) \(CASK_EXCLUDE\b/);
    if (ex) r.excluded.unshift(ex[1]!);
  }
  for (let i = at + 1; i < lines.length; i++) {
    const l = lines[i]!;
    if (/^=== ABORTED:/.test(l)) {
      r.aborted = true;
      continue;
    }
    if (o.end(l)) break;
    const m = l.match(/^\s+(brew|npm):\s+(.*)$/);
    if (m) r.lanes.push({ lane: m[1] as "brew" | "npm", text: m[2]! });
    else if (l.trim() && !runOwnLine(l, lines[i - 1])) r.other.push(l);
  }
  return r;
}

export function parsePrevSummary(log: string, host: string, name: string = DEFAULT_COMPAT.previousUpdater): PrevSummary | null {
  const header = new RegExp(`^=== (?:\\S+-)?${escape(name)} `);
  const dated = new RegExp(`^=== (?:\\S+-)?${escape(name)} (\\S+) (\\d{4}-\\d\\d-\\d\\d)`);
  const lines = log.split("\n");
  const at = lines.lastIndexOf(`=== ${host} summary ===`);
  if (at < 0) return null;
  // The next run's header ends this block; so does any oupdate header (a dry run's included), so
  // lines of a later dry run never stand in for the run's own.
  const r = readRunBlock(lines, at, { host, dated, end: (l) => header.test(l) || /^=== oupdate[ -]/.test(l) });
  // The last line of each lane, as the previous updater's own reader did.
  const brew = r.lanes.findLast((x) => x.lane === "brew");
  const npm = r.lanes.findLast((x) => x.lane === "npm");
  const s: PrevSummary = {
    ...(r.date ? { date: r.date } : {}),
    brew: brew ? parseBrew(brew.text) : { upgraded: [], failed: [], flagged: [], stuck: [] },
    npm: npm ? parseNpm(npm.text) : { upgraded: [] },
    aborted: r.aborted,
  };
  // An app bundle is not a formula: its flag is the app's, never a brew hold.
  const typeB = r.typeB.filter((t) => t.kind !== "app bundle").map((t) => t.name);
  s.brew.flagged = [...new Set([...s.brew.flagged, ...typeB])];
  if (r.excluded.length) s.brew.excluded = [...new Set(r.excluded)];
  return s;
}
