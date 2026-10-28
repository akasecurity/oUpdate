// Type A (official taps): a deterministic version policy, ported from the previous updater's
// Type A review. A security-sensitive package is held on a major-version increase, or when its
// row in `brew outdated --verbose` cannot be read; everything else is approved. Names compare
// literally; the sensitive list matches the last path segment without its @version suffix.

export function typeAReview(packages: string[], verbose: string, sensitive: string[]): { held: string[]; text: string } {
  const sens = new Set(sensitive);
  const rows = verbose.split(/\r?\n/);
  const major = (v: string) => /^v?([0-9]+)(?:[.,_+-]|$)/.exec(v)?.[1];
  const held = packages.filter((pkg) => {
    if (!sens.has(pkg.split("/").at(-1)!.split("@")[0]!)) return false;
    const matches = rows.filter((row) => row.split(/\s+/)[0] === pkg);
    if (matches.length !== 1) return true;
    const m = matches[0]!.match(/^\S+\s+\(([^)]+)\)\s*<\s*(\S+)\s*$/);
    if (!m) return true;
    const next = major(m[2]!);
    const installed = m[1]!.split(/,\s*|\s+/).map(major);
    return !next || installed.some((old) => !old || BigInt(next) > BigInt(old));
  });
  return {
    held,
    text: held.length ? `FLAG\nHOLD: ${held.join(" ")}\nSensitive major increase or unverifiable version baseline.` : "APPROVE",
  };
}
