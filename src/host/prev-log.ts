// the previous updater's launchagent log: the last "=== <host> summary ===" block
// and the run header before it. Two holds show only in the run body, between the two:
// a Type B FLAG (a third-party tap's formula review) and a CASK_EXCLUDE skip.

export interface SuSummary {
  date?: string;
  // pinned: held because a repo's pins.json lists them; brew-pinned ones are left to Outdated.pinned.
  brew: { upgraded: string[]; failed: string[]; flagged: string[]; stuck: string[]; pinned?: string[]; excluded?: string[] };
  // flagged: the whole pending batch was held (FLAGGED, or a structural flag); the summary names none of it.
  // claudeCode: the version reported (on a failure, the one it is stuck on, when known); claudeCodeFailed: its update failed.
  npm: { upgraded: string[]; flagged?: boolean; failed?: string[]; claudeCode?: string; claudeCodeFailed?: boolean };
  aborted: boolean;
}

const words = (s: string) => s.split(/\s+/).filter(Boolean);

function parseBrew(line: string): SuSummary["brew"] {
  const b: SuSummary["brew"] = { upgraded: [], failed: [], flagged: [], stuck: [] };
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

function parseNpm(line: string): SuSummary["npm"] {
  const n: SuSummary["npm"] = { upgraded: [], flagged: false, failed: [] };
  for (const raw of line.split(";")) {
    const p = raw.trim();
    const up = p.match(/^upgraded:(.*)$/);
    if (up) n.upgraded.push(...words(up[1]!));
    if (/^(?:FLAGGED|STRUCTURAL FLAG)\b/.test(p)) n.flagged = true;
    const failed = p.match(/^FAILED — (\S+)$/);
    if (failed) n.failed!.push(failed[1]!);
    const cc = p.match(/^claude-code: (\S+)$/);
    if (cc) n.claudeCode = cc[1];
    // the previous updater's "FAILED (rc=<rc>, on <ver>)" and oupdate's "FAILED (timeout, on <ver>)".
    const ccf = p.match(/^claude-code: FAILED \((?:rc=\d+|timeout), on (\S+)\)$/);
    if (ccf) {
      n.claudeCodeFailed = true;
      if (ccf[1] !== "unknown") n.claudeCode = ccf[1];
    }
  }
  return n;
}

export function parseSuSummary(log: string, host: string): SuSummary | null {
  const lines = log.split("\n");
  const at = lines.lastIndexOf(`=== ${host} summary ===`);
  if (at < 0) return null;
  const s: SuSummary = { brew: { upgraded: [], failed: [], flagged: [], stuck: [] }, npm: { upgraded: [] }, aborted: false };
  const typeB: string[] = [];
  const excluded: string[] = [];
  for (let i = at - 1; i >= 0; i--) {
    const h = lines[i]!.match(/^=== (?:\S+-)?host-update (\S+) (\d{4}-\d\d-\d\d)/);
    if (h && h[1] === host) {
      s.date = h[2];
      break;
    }
    const tb = lines[i]!.match(/ Type B FLAG — ([^\s<]+)/);
    if (tb) typeB.unshift(tb[1]!);
    const ex = lines[i]!.match(/^\s+excluding (\S+) \(CASK_EXCLUDE\b/);
    if (ex) excluded.unshift(ex[1]!);
  }
  for (let i = at + 1; i < lines.length; i++) {
    const l = lines[i]!;
    // The next run's header ends this block; so does any oupdate header (a dry run's included), so
    // lines of a later dry run never stand in for the run's own.
    if (/^=== (?:\S+-)?host-update /.test(l) || /^=== oupdate[ -]/.test(l)) break;
    if (/^=== ABORTED:/.test(l)) s.aborted = true;
    const m = l.match(/^\s+(brew|npm):\s+(.*)$/);
    if (m?.[1] === "brew") s.brew = parseBrew(m[2]!);
    else if (m?.[1] === "npm") s.npm = parseNpm(m[2]!);
  }
  s.brew.flagged = [...new Set([...s.brew.flagged, ...typeB])];
  if (excluded.length) s.brew.excluded = [...new Set(excluded)];
  return s;
}
