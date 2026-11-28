// One host at a time for Tailscale (config riskyKeepPrevious, tailscaleCanaryOrder, tailscaleSweepRead, tailscaleVerify). Every host runs its own apply;
// the sweep is the rule that a host upgrades tailscale only when every host before it in the canary order has already been verified on that version, and that a
// failed verify stops every host after it. The previous keg is kept and rolled back by the release check this module's config makes for each risky package
// (release-checks.ts): keep, upgrade, restart the owner, verify, and on a confirmed fail relink the previous keg and hold the release.
//
// Records: each host writes its own <stateDir>/tailscale-sweep/<version>.json when its verify decides (tailscale-verify.ts). The other hosts' records are read
// through the `tailscaleSweepRead` command (argv; the target version is appended; it prints one line per host record, `<host> <version>` for a verified host
// and `<host> <version> failed` for a failed one). A line counts only when its version is the target version: a line for another version (a stale record) is
// ignored, never taken for this one. With no reader only the first host of the order may upgrade. A reader that fails, times out or prints garbage is "not
// our turn": the formula is held, the run goes on.

import { join } from "node:path";
import type { Exec } from "./exec.ts";

export const DEFAULT_RISKY_KEEP_PREVIOUS = ["tailscale"];
/** Canary first; desk and air (a GUI app, updated by hand) are not in it. */
export const DEFAULT_CANARY_ORDER = ["bonus", "ai", "max", "startup", "build", "mini", "dev"];
/** The most a reader may print and the longest it may run. */
const READ_TIMEOUT_MS = 60_000;
const READ_MAX_BYTES = 64 * 1024;

export type SweepStatus = "verified" | "failed";
export interface SweepRecord {
  host: string;
  version: string;
  status: SweepStatus;
  at: string;
}

export const recordDir = (stateDir: string) => join(stateDir, "tailscale-sweep");
/**
 * The file name of a version: every byte outside [A-Za-z0-9.+-] becomes `_` and two hex digits, so two versions never share a file (`_` itself is encoded). A lone UTF-16 surrogate has no
 * UTF-8 bytes (it would all read as U+FFFD, so two of them would share a file): it becomes `_s` and its four hex digits, which no byte escape can spell (s is not a hex digit).
 */
export const recordName = (version: string) =>
  `${[...version]
    .map((ch) => {
      const cp = ch.codePointAt(0)!;
      if (cp >= 0xd800 && cp <= 0xdfff) return `_s${cp.toString(16)}`;
      return Buffer.from(ch).toString("latin1").replace(/[^A-Za-z0-9.+-]/g, (c) => `_${c.charCodeAt(0).toString(16).padStart(2, "0")}`);
    })
    .join("")}.json`;
export const recordPath = (stateDir: string, version: string) => join(recordDir(stateDir), recordName(version));
/** The lock a real run holds on this host from its turn check to its end: two runs of one host never decide the sweep at once. */
export const sweepLockPath = (stateDir: string) => join(recordDir(stateDir), "lock");

/**
 * A version without the decoration of the known forms only: a leading `v`, a `-t<hex>` daemon suffix, a `+build` suffix and brew's `_N` revision
 * (`v1.80.2-t1a2b3c`, `1.80.2+x` and `1.80.2_1` are `1.80.2`). Any other suffix (`-rc1`) stays: it is another release.
 */
export const baseVersion = (v: string) => v.trim().replace(/^v/, "").replace(/-t[0-9a-f]+(?=[+_]|$)/, "").replace(/_\d+$/, "").replace(/\+[0-9A-Za-z.]+$/, "").replace(/_\d+$/, "");
/** True when two version strings are the same release (see baseVersion); an empty one is never the same as anything. */
export const sameVersion = (a: string, b: string) => baseVersion(a) !== "" && baseVersion(a) === baseVersion(b);

/** The tailscale casks (the GUI app): never upgraded by the apply run when tailscale is a risky package; update the app by hand. */
export const isTailscaleCask = (name: string) => ["tailscale", "tailscale-app"].includes(name.split("/").at(-1)!);

/** The record a host writes for a version (JSON, one line). */
export const recordText = (r: SweepRecord): string => `${JSON.stringify(r)}\n`;

/** The hosts a verify pings: the next `n` hosts of the order after `host`, wrapping round; none for a host not in the order. */
export function verifyPeers(order: readonly string[], host: string, n = 2): string[] {
  const i = order.indexOf(host);
  if (i < 0) return [];
  const out: string[] = [];
  for (let k = 1; out.length < Math.min(n, order.length - 1); k++) out.push(order[(i + k) % order.length]!);
  return out;
}

/**
 * A reader's output as a map host -> status for `version`, or undefined when any line is not `<host> <version>` or `<host> <version> failed` (garbage, and a
 * line without a version, is no answer). A line for another version is skipped: it says nothing about this one.
 */
export function parseSweepList(out: string, version: string): Map<string, SweepStatus> | undefined {
  const m = new Map<string, SweepStatus>();
  for (const line of out.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    const parts = t.split(/\s+/);
    const [host, v, status = "verified"] = parts;
    if (parts.length < 2 || parts.length > 3 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(host!) || (status !== "verified" && status !== "failed")) return undefined;
    if (v !== version) continue;
    // A host named twice: failed wins (a failure is never hidden by a later line).
    if (m.get(host!) !== "failed") m.set(host!, status);
  }
  return m;
}

export interface Turn {
  go: boolean;
  /** Why not (when !go), in the words of the log line. */
  why?: string;
}

/**
 * Whether `host` may upgrade now. `records` is what the reader printed for the version (undefined: no reader, or it failed); `readerSet` says which.
 * A host not in the order is refused; the first host needs no record; any other needs every host before it verified and none failed.
 */
export function turnFor(host: string, order: readonly string[], records: ReadonlyMap<string, SweepStatus> | undefined, readerSet: boolean): Turn {
  const i = order.indexOf(host);
  if (i < 0) return { go: false, why: `host ${host} is not in tailscaleCanaryOrder (refused)` };
  if (i === 0) return { go: true };
  const before = order.slice(0, i);
  if (!readerSet) return { go: false, why: `waiting for ${before.at(-1)}: tailscaleSweepRead not set` };
  if (!records) return { go: false, why: `waiting for ${before.at(-1)}: tailscaleSweepRead gave no answer` };
  for (const h of before) if (records.get(h) === "failed") return { go: false, why: `the sweep stopped at ${h}: its verify failed` };
  const missing = before.find((h) => records.get(h) !== "verified");
  if (missing) return { go: false, why: `waiting for ${missing}` };
  return { go: true };
}

/** Runs the reader for a version; undefined when it fails, times out, prints too much or prints garbage. */
export async function readSweep(exec: Exec, argv: readonly string[], version: string): Promise<Map<string, SweepStatus> | undefined> {
  let r;
  try {
    r = await exec([...argv, version], { timeoutMs: READ_TIMEOUT_MS, maxBytes: READ_MAX_BYTES, soft: true });
  } catch {
    return undefined;
  }
  if (r.rc !== 0 || r.timedOut || r.truncated) return undefined;
  return parseSweepList(r.out, version);
}

/** The turn of this host for one version: reads only when it must (not the first host, a reader set). */
export async function sweepTurn(a: { exec: Exec; host: string; order: readonly string[]; read: readonly string[] | undefined; version: string }): Promise<Turn> {
  const i = a.order.indexOf(a.host);
  if (i <= 0 || !a.read) return turnFor(a.host, a.order, undefined, a.read !== undefined);
  return turnFor(a.host, a.order, await readSweep(a.exec, a.read, a.version), true);
}
