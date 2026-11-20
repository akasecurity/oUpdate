// OUP-302 phase 1b: the per-run record of the versions a real run is about to move from, kept so a
// person (or a later rollback step) has something to restore from. One file per run,
// <stateDir>/runs/<YYYYMMDD-HHMMSSZ>-<pid>.json, rewritten whole as entries are added, so a run that dies
// leaves what it had. It holds manager, name, from and to: versions only, nothing from any secret.
// A dry run writes nothing. A record that cannot be written is a warning line, never a failed run:
// the record is evidence, not a gate.

import type { ApplyFs } from "./fs.ts";

export interface RunRecordEntry {
  manager: "brew-formula" | "brew-cask" | "npm";
  name: string;
  from: string;
  to: string;
}

export interface RunRecord {
  add(entries: RunRecordEntry[]): Promise<void>;
}

const p2 = (n: number) => String(n).padStart(2, "0");

/** The record file of a run started at `now`: a UTC stamp (the local clock repeats an hour when the clocks go back) and the pid. */
export function runRecordPath(stateDir: string, now: Date): string {
  const u = (n: number) => p2(n);
  return `${stateDir}/runs/${now.getUTCFullYear()}${u(now.getUTCMonth() + 1)}${u(now.getUTCDate())}-${u(now.getUTCHours())}${u(now.getUTCMinutes())}${u(now.getUTCSeconds())}Z-${process.pid}.json`;
}

export function makeRunRecord(o: { fs: ApplyFs; stateDir: string; host: string; now: Date; stamp: string; dryRun: boolean; log: string[] }): RunRecord {
  const entries: RunRecordEntry[] = [];
  const path = runRecordPath(o.stateDir, o.now);
  let warned = false;
  return {
    async add(more) {
      if (o.dryRun || !more.length) return;
      entries.push(...more);
      try {
        await o.fs.writeFile(path, JSON.stringify({ host: o.host, startedAt: o.stamp, entries }, null, 2) + "\n");
      } catch (e) {
        if (warned) return;
        warned = true;
        o.log.push(`  WARNING: could not write the run record ${path} (${e instanceof Error ? e.message : String(e)})`);
      }
    },
  };
}
