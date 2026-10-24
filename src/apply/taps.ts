// Third-party taps, ported from the previous updater. A Type B tap's packages are reviewed before
// they install. The base list comes from config; an approved-taps file adds taps per host,
// one row each: "<tap>\t<host or *>\t<approved date>\t<note>". "#" lines and blank lines are
// skipped; a malformed row warns and is skipped. Taps are matched literally, never as a
// pattern ("example/work.ux" is not "example/workmux").

const TAP = /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/;
const HOSTNAME = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

export interface TapLoadOptions {
  /** Prefixes stripped from both host names before they are compared (e.g. a site's naming scheme). */
  hostPrefixes?: string[];
}

export function hostKey(host: string, prefixes: string[] = []): string {
  const h = host.toLowerCase();
  const p = prefixes.map((x) => x.toLowerCase()).find((x) => x && h.startsWith(x));
  return p ? h.slice(p.length) : h;
}

export function loadApprovedTaps(tsv: string, host: string, base: string[], opts: TapLoadOptions = {}): { taps: string[]; warnings: string[] } {
  const taps = [...base];
  const warnings: string[] = [];
  const me = hostKey(host, opts.hostPrefixes);
  for (const raw of tsv.split("\n")) {
    // Split on every tab: an empty host column must stay empty, not shift the date into it.
    const [tapRaw = "", hostRaw = "", approvedRaw = ""] = raw.replaceAll("\r", "").split("\t").map((f) => f.trim());
    if (!tapRaw && !hostRaw && !approvedRaw) continue;
    if (tapRaw.startsWith("#")) continue;
    const tap = tapRaw.toLowerCase();
    if (!approvedRaw || !hostRaw || !TAP.test(tap) || (hostRaw !== "*" && !HOSTNAME.test(hostRaw))) {
      warnings.push(`approved-taps: ignoring malformed row: ${tap} | ${hostRaw || "(empty host)"} | ${approvedRaw || "(no date)"}`);
      continue;
    }
    if (hostRaw !== "*" && hostKey(hostRaw, opts.hostPrefixes) !== me) continue;
    if (!taps.includes(tap)) taps.push(tap);
  }
  return { taps, warnings };
}

export function tapIn(tap: string, list: string[]): boolean {
  return tap !== "" && list.includes(tap);
}

/**
 * "<old>→<new>" for a package from `brew outdated --verbose`, e.g.
 *   example/tf/terraform (1.16.3) < 1.16.4
 *   example/workmux/workmux (0.1.266) < 0.1.268 [pinned at 0.1.266]
 * The name matches bare or as a "/<name>" suffix, compared literally; "?→?" when not found.
 */
export function outdatedVersions(pkg: string, verbose: string): string {
  for (const line of verbose.split("\n")) {
    const f = line.trim().split(/\s+/);
    const n = f[0] ?? "";
    if (n !== pkg && !n.endsWith(`/${pkg}`)) continue;
    const old = line.match(/\(([^)]*)\)/)?.[1] ?? "";
    let nv = "";
    for (let i = 1; i < f.length - 1; i++) if (f[i] === "<" || f[i] === "!=") { nv = f[i + 1]!; break; }
    if (!nv) nv = f.at(-1) ?? "";
    return `${old}→${nv}`;
  }
  return "?→?";
}
