// The target model (spec §2): one OS target is an id, its OS, how oupdate reaches it, the update legs
// it runs, when it runs, and where its one summary line is published for a status reader.

import type { PinBumpLeg } from "./pins/config.ts";

export type TargetOs = "macos" | "nasos" | "linux";

export type Reach =
  | { kind: "local" }
  | { kind: "git"; repo: string; remote: string; base: string }
  /**
   * Fixed scripts on the target, run by the broker (spec §4). `host` is the broker's catalog target; `actions` holds one
   * `<name>.read` and at most one `<name>.write` catalog action; `credreq` is run with CREDBROKER_BASE_URL=`baseUrl`.
   */
  | { kind: "broker-script"; host: string; actions: string[]; baseUrl: string; credreq: string }
  | { kind: "vm-agent"; vm: string; agent: string }
  /**
   * The broker's OS Config patch job over exact VM names (spec §5). `actions` holds one `<name>.read` and at most one
   * `<name>.patch` catalog action; `credreq` is run with CREDBROKER_BASE_URL=`baseUrl`. `project` is for the log only:
   * the broker's catalog pins each VM's project, zone and instance id.
   */
  | { kind: "gce-patch"; project: string; vms: string[]; actions: string[]; baseUrl: string; credreq: string }
  | { kind: "docker"; on: string };

/** Legs the spec names that this runner does not run yet: each reports "not checked" with trouble. */
export const UNBUILT_LEGS = ["brew", "npm", "claude-code", "app-bundle"] as const;
export type UnbuiltLegKind = (typeof UNBUILT_LEGS)[number];

/** The NAS legs (spec §4), over the broker-script reach. Review only unless `apply` is true. */
export const NAS_LEGS = ["docker-compose", "nas-plugin", "nas-os"] as const;
export type ComposeLeg = { kind: "docker-compose"; apply: boolean; prune: boolean };
export type PluginLeg = { kind: "nas-plugin"; apply: boolean };
export type OsLeg = { kind: "nas-os" };
export type NasLeg = ComposeLeg | PluginLeg | OsLeg;

/**
 * VM OS packages over the gce-patch reach (spec §5). Review only unless `apply` is true. `cooldownDays` counts from the
 * first run that saw a candidate (kept in `seenTo`); `cardWaitS` is how long one patch request waits on its card.
 */
export type OsPackagesLeg = { kind: "os-packages"; apply: boolean; cooldownDays: number; seenTo: string; cardWaitS: number };

export type Leg = PinBumpLeg | NasLeg | OsPackagesLeg | { kind: UnbuiltLegKind };
export const isNasLeg = (l: Leg): l is NasLeg => (NAS_LEGS as readonly string[]).includes(l.kind);

/** day: 0 is Sunday, as Date.getDay. */
export type Schedule = { every: "night" } | { every: "week"; day: number };

export interface Target {
  id: string;
  os: TargetOs;
  reach: Reach;
  legs: Leg[];
  schedule: Schedule;
  /** Absolute path of the status tsv a status reader reads (host, date, rev, summary rows). */
  summaryTo: string;
  /** Absolute .jsonl path: each real run appends the night's parity facts (spec §6). */
  parityTo?: string;
}

/** The deterministic facts of a NAS night that the parity run compares with the previous updater script, plus the model opinions. */
export interface ParityFacts {
  changed?: string[];
  pregate?: string[];
  verdict?: { primary: string; secondary: string };
  plugins?: string[];
  os?: string;
}

/** What one leg reports: its log lines, one summary fragment, and whether anything needs a person. */
export interface LegResult {
  lines: string[];
  summary: string;
  trouble: boolean;
  parity?: ParityFacts;
}

export interface TargetResult {
  id: string;
  summary: string;
  trouble: boolean;
  lines: string[];
  /** The tsv path written; absent on a dry run or a failed write. */
  published?: string;
}

export function isDue(s: Schedule, now: Date): boolean {
  return s.every === "night" || now.getDay() === s.day;
}
