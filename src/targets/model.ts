// The target model: one OS target is an id, its OS, how oupdate reaches it, the update legs
// it runs, when it runs, and where its one summary line is published.

import type { PinBumpLeg } from "./pins/config.ts";

/** The built-in target OS names; a target plugin (registry.ts) can add more. */
export const BUILTIN_OS = ["macos", "linux"] as const;
export type TargetOs = string;

/**
 * A reach or leg kind that a target plugin parses and runs (registry.ts): `plugin` tells it apart from the built-in
 * kinds; the plugin's own type adds its fields.
 */
export type PluginReach = { kind: string; plugin: true };
export type PluginLeg = { kind: string; plugin: true };

export type BuiltinReach =
  | { kind: "local" }
  | { kind: "git"; repo: string; remote: string; base: string }
  | { kind: "vm-agent"; vm: string; agent: string }
  /**
   * The broker's OS Config patch job over exact VM names. `actions` holds one `<name>.read` and at most one
   * `<name>.patch` catalog action; the broker client is run with `baseUrl` in its environment. `project` is for the log only:
   * the broker's catalog pins each VM's project, zone and instance id.
   */
  | { kind: "gce-patch"; project: string; vms: string[]; actions: string[]; baseUrl: string; client: string }
  | { kind: "docker"; on: string };
export type Reach = BuiltinReach | PluginReach;

/** Legs the spec names that this runner does not run yet: each reports "not checked" with trouble. */
export const UNBUILT_LEGS = ["brew", "npm", "claude-code", "app-bundle"] as const;
export type UnbuiltLegKind = (typeof UNBUILT_LEGS)[number];

/** Docker Compose images, over a reach that opens a broker session. Review only unless `apply` is true. */
export type ComposeLeg = { kind: "docker-compose"; apply: boolean; prune: boolean };

/**
 * VM OS packages over the gce-patch reach. Review only unless `apply` is true. `cooldownDays` counts from the
 * first run that saw a candidate (kept in `seenTo`); `approvalWaitS` is how long one patch request waits on its approval.
 */
export type OsPackagesLeg = { kind: "os-packages"; apply: boolean; cooldownDays: number; seenTo: string; approvalWaitS: number };

export type BuiltinLeg = PinBumpLeg | ComposeLeg | OsPackagesLeg | { kind: UnbuiltLegKind };
export type Leg = BuiltinLeg | PluginLeg;
export const isPluginLeg = (l: Leg): l is PluginLeg => "plugin" in l;
export const isPluginReach = (r: Reach): r is PluginReach => "plugin" in r;

/** day: 0 is Sunday, as Date.getDay. */
export type Schedule = { every: "night" } | { every: "week"; day: number };

export interface Target {
  id: string;
  os: TargetOs;
  reach: Reach;
  legs: Leg[];
  schedule: Schedule;
  /** Absolute path of the status tsv it publishes (host, date, rev, summary rows). */
  summaryTo: string;
  /** Absolute .jsonl path: each real run appends the night's parity facts. */
  parityTo?: string;
}

/** The deterministic facts of a night that the parity run compares with the previous updater script's log, plus the model opinions. */
export interface ParityFacts {
  changed?: string[];
  pregate?: string[];
  verdict?: { first: string; second: string };
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
