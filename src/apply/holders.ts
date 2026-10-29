// A process mapping a file under a Homebrew keg, read from lsof output. Its own module so kegs.ts and
// owner-waiter.ts (which kegs.ts imports) both use it without importing each other.

export interface Holder {
  pid: string;
  pkg: string;
  keg: string;
}

/** Every distinct (pid, package, keg dir) mapping a file under <cellar>/<pkg>/<keg>/… in lsof output. */
export function kegHolders(lsofOut: string, cellar: string): Holder[] {
  const c = `${cellar}/`;
  const seen = new Set<string>();
  const out: Holder[] = [];
  for (const line of lsofOut.split("\n")) {
    const f = line.trim().split(/\s+/);
    const name = f.at(-1) ?? "";
    if (!name.startsWith(c)) continue;
    const [pkg, keg, ...rest] = name.slice(c.length).split("/");
    if (!pkg || !keg || !rest.length) continue;
    const h = { pid: f[1] ?? "", pkg, keg: `${c}${pkg}/${keg}` };
    const k = `${h.pid}\t${h.pkg}\t${h.keg}`;
    if (!seen.has(k)) {
      seen.add(k);
      out.push(h);
    }
  }
  // pids in numeric order (as strings 12345 sorts before 9876), then package and keg.
  const key = (h: Holder) => `${h.pkg}\t${h.keg}`;
  return out.sort((a, b) => Number(a.pid) - Number(b.pid) || (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}
