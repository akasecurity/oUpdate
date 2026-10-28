// The target plugin seam: reach kinds, leg kinds and target OS names beyond the built-in ones, keyed by kind. A plugin
// is a directory src/targets/ext/<name>/ whose index.ts exports `plugin: TargetPlugin`; loadRegistry imports each one
// present, so a tree without any still builds and runs, and a targets file that names a missing kind fails to parse.

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Exec } from "../apply/exec.ts";
import type { Compat } from "./compat.ts";
import type { ReviewerPair } from "./compose/review.ts";
import type { LegResult, PluginLeg, PluginReach, Reach } from "./model.ts";
import type { ReachHandle } from "./reach.ts";
import type { LegContext } from "./run.ts";

export interface ReachKind {
  /** Parses the reach object (its `kind` already matched); throws on any error, like the built-in kinds. */
  parse(v: unknown, where: string): PluginReach;
  open(r: PluginReach, exec: Exec, timeoutMs: number): Promise<ReachHandle>;
  /** The reach names a write action, so a leg with `apply: true` may run on it. */
  canWrite?(r: PluginReach): boolean;
}

export interface LegKind {
  parse(v: unknown, where: string): PluginLeg;
  /** Why the leg cannot run on this target's reach and OS (config error text), or undefined. */
  check?(l: PluginLeg, r: Reach, os: string, reg: Registry): string | undefined;
  run(l: PluginLeg, ctx: LegContext, deps: { reviewers: ReviewerPair }): Promise<LegResult>;
}

export interface TargetPlugin {
  os?: string[];
  reaches?: Record<string, ReachKind>;
  legs?: Record<string, LegKind>;
  /** The host's known-normal baseline for the container review prompt (compose/prompt.ts DEFAULT_BASELINE otherwise). */
  containerBaseline?: string;
  /** Older names an existing deployment still uses (compat.ts). */
  compat?: Compat;
}

export interface Registry {
  os: string[];
  reaches: Map<string, ReachKind>;
  legs: Map<string, LegKind>;
  containerBaseline?: string;
  compat: Compat;
}

export function makeRegistry(plugins: TargetPlugin[]): Registry {
  const reg: Registry = { os: [], reaches: new Map(), legs: new Map(), compat: {} };
  for (const p of plugins) {
    for (const o of p.os ?? []) if (!reg.os.includes(o)) reg.os.push(o);
    for (const [k, v] of Object.entries(p.reaches ?? {})) {
      if (reg.reaches.has(k)) throw new Error(`reach kind ${k} is registered twice`);
      reg.reaches.set(k, v);
    }
    for (const [k, v] of Object.entries(p.legs ?? {})) {
      if (reg.legs.has(k)) throw new Error(`leg kind ${k} is registered twice`);
      reg.legs.set(k, v);
    }
    if (p.containerBaseline !== undefined) {
      if (reg.containerBaseline !== undefined) throw new Error("two plugins give a container baseline");
      reg.containerBaseline = p.containerBaseline;
    }
    // Later plugins add to the older names; the two maps merge key by key.
    if (p.compat) reg.compat = { ...reg.compat, ...p.compat, configKeys: { ...reg.compat.configKeys, ...p.compat.configKeys }, brokerClient: { ...reg.compat.brokerClient, ...p.compat.brokerClient } };
  }
  return reg;
}

export const EMPTY_REGISTRY: Registry = makeRegistry([]);

export const EXT_DIR = join(import.meta.dir, "ext");

/** Imports every ext/<name>/index.ts present (in name order); no ext directory is the built-in kinds only. */
export async function loadRegistry(dir: string = EXT_DIR): Promise<Registry> {
  if (!existsSync(dir)) return EMPTY_REGISTRY;
  const plugins: TargetPlugin[] = [];
  for (const name of readdirSync(dir).sort()) {
    const index = join(dir, name, "index.ts");
    if (!existsSync(index)) continue;
    const m = (await import(index)) as { plugin?: TargetPlugin };
    if (!m.plugin) throw new Error(`target plugin ${name} exports no plugin`);
    plugins.push(m.plugin);
  }
  return makeRegistry(plugins);
}
