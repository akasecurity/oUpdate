// First-seen dates for the cooldown hold (spec §5: the review "holds for cooldown"). Neither the OS Config inventory nor
// the security index carries a publish time per package, so the leg counts the cooldown from the first real run that saw
// a VM's candidate at that version. The dates are kept in the leg's `seenTo` JSON file: {vm: {<name>: {version,
// first}}}. Cooldown is caller policy: the broker sees no publish dates. Only a missing file
// (ENOENT) is empty; a file that cannot be read or is malformed holds every package (fail closed) and is never overwritten.

import type { TargetFs } from "../run.ts";
import { isObj } from "../strict.ts";
import { pkgKey, type Candidate } from "./answer.ts";
import { DEB_VERSION, parseTime } from "./verbs.ts";

export type Seen = Map<string, Map<string, { version: string; first: string }>>;

const VM = /^[a-z](?:[-a-z0-9]{0,61}[a-z0-9])?$/;
const KEY = /^[a-z0-9][a-z0-9+.-]{0,127}$/;

export async function readSeen(fs: TargetFs, path: string): Promise<{ ok: true; seen: Seen } | { ok: false; why: string }> {
  const bad = (what: string) => ({ ok: false as const, why: `first-seen file ${path} ${what}` });
  // Only a missing file starts empty; any other read error holds every package and leaves the file as it is.
  const got = await fs.readText(path);
  if ("missing" in got) return { ok: true, seen: new Map() };
  if ("error" in got) return bad(`could not be read: ${got.error.replace(/\s+/g, " ").slice(0, 200)}`);
  const text = got.text;
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    return bad("is not JSON");
  }
  if (!isObj(root)) return bad("is not an object");
  const seen: Seen = new Map();
  for (const [vm, pkgs] of Object.entries(root)) {
    if (!VM.test(vm) || !isObj(pkgs)) return bad(`has a bad entry for ${JSON.stringify(vm.slice(0, 64))}`);
    const m = new Map<string, { version: string; first: string }>();
    for (const [key, e] of Object.entries(pkgs)) {
      const ok = KEY.test(key) && isObj(e) && Object.keys(e).sort().join(",") === "first,version" && typeof e.version === "string" && DEB_VERSION.test(e.version) && typeof e.first === "string" && parseTime(e.first) !== undefined;
      if (!ok) return bad(`has a bad entry for ${vm} ${JSON.stringify(key.slice(0, 140))}`);
      m.set(key, { version: e.version as string, first: e.first as string });
    }
    seen.set(vm, m);
  }
  return { ok: true, seen };
}

/** Records one VM's candidates of this run and returns each key's first-seen time. A new version restarts its date; a key no longer a candidate is dropped. */
export function noteSeen(seen: Seen, vm: string, cands: Candidate[], now: Date): Map<string, Date> {
  const old = seen.get(vm) ?? new Map<string, { version: string; first: string }>();
  const next = new Map<string, { version: string; first: string }>();
  const out = new Map<string, Date>();
  for (const c of cands) {
    const key = pkgKey(c);
    const e = old.get(key);
    const entry = e && e.version === c.candidate ? e : { version: c.candidate, first: now.toISOString() };
    next.set(key, entry);
    out.set(key, new Date(parseTime(entry.first)!));
  }
  seen.set(vm, next);
  return out;
}

const byKey = <T>(a: [string, T], b: [string, T]) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);

/** Replaces the file whole; the error message, or undefined when written. */
export async function writeSeen(fs: TargetFs, path: string, seen: Seen): Promise<string | undefined> {
  const root = Object.fromEntries([...seen].sort(byKey).map(([vm, m]) => [vm, Object.fromEntries([...m].sort(byKey))]));
  try {
    await fs.writeFile(path, `${JSON.stringify(root, null, 2)}\n`);
    return undefined;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}
