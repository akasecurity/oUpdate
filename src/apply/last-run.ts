// OUP-326 item 2: the result of a real run, written to <stateDir>/last-run.json for a person or a Pilot to read
// (by ssh) without parsing the log. Whole file each run, written to a temporary name beside it and renamed
// (ApplyFs.writeFile). It holds host, times, rc, the FAILED tokens, what was upgraded and held, the linkage
// note, the log path and the oUpdate version: names and numbers only, nothing from the config or any secret.
// A dry run writes nothing. A file that cannot be written is a warning line, never a change of the run's rc.

import pkg from "../../package.json";
import type { ApplyFs } from "./fs.ts";

export interface LastRun {
  host: string;
  /** This process, to tie the file to runs/<stamp>-<pid>.json. */
  pid: number;
  started: string;
  ended: string;
  ok: boolean;
  rc: number;
  /** Present (true) only for a run a signal stopped: never ok. */
  stopped?: true;
  failed: string[];
  upgraded: string[];
  held: string[];
  linkage: string;
  log: string;
  version: string;
}

const p2 = (n: number) => String(n).padStart(2, "0");

/** ISO 8601 in the host's own zone ("2026-11-24T09:10:00-08:00"), never UTC. */
export function isoZone(d: Date): string {
  const off = -d.getTimezoneOffset();
  const a = Math.abs(off);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}${off < 0 ? "-" : "+"}${p2(Math.floor(a / 60))}:${p2(a % 60)}`;
}

export const lastRunPath = (stateDir: string) => `${stateDir}/last-run.json`;

export async function writeLastRun(o: { fs: ApplyFs; stateDir: string; dryRun: boolean; log: string[]; run: Omit<LastRun, "version" | "ok" | "stopped"> & { stopped: boolean } }): Promise<void> {
  if (o.dryRun) return;
  const path = lastRunPath(o.stateDir);
  try {
    const { stopped, ...rest } = o.run;
    const doc: LastRun = { ...rest, ...(stopped ? { stopped: true as const } : {}), ok: rest.rc === 0 && !stopped, version: pkg.version };
    await o.fs.writeFile(path, JSON.stringify(doc, null, 2) + "\n");
  } catch (e) {
    o.log.push(`  WARNING: could not write the last-run file ${path} (${e instanceof Error ? e.message : String(e)})`);
  }
}
