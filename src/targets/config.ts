// The targets file read by `oupdate targets`: {"logDir", "reviewer"?, "targets": [...]}. Strict like
// the host config: an unknown key or a wrong type is an error. Reach kinds and legs the runner does not
// build yet still parse, so the file can list every target now and each reports "not checked"; the docker-compose leg is
// review only unless `apply` is true. A target plugin's reach, leg and OS names (registry.ts) parse only when it is loaded.

import { resolve } from "node:path";
import { validateReviewerSpec, type ReviewerSpec } from "../adapters/reviewer/spec.ts";
import { expandEnv } from "../env.ts";
import { BUILTIN_OS, isPluginLeg, isPluginReach, UNBUILT_LEGS, type Leg, type Reach, type Schedule, type Target, type UnbuiltLegKind } from "./model.ts";
import { parsePinBumpLeg } from "./pins/config.ts";
import { DEFAULT_COMPAT, renameKeys } from "./compat.ts";
import { EMPTY_REGISTRY, type Registry } from "./registry.ts";
import { absPath, isObj, obj, optBool, optCount, optStr, reqStr, strList } from "./strict.ts";

export interface TargetsConfig {
  targets: Target[];
  /** Run logs: targets.log, or dry-run-targets.log for a dry run. */
  logDir: string;
  /** The reviewer (and, for the two-reviewer legs, the first of the two). */
  reviewer?: ReviewerSpec;
  /** The two-reviewer legs' second reviewer. */
  secondReviewer?: ReviewerSpec;
}

const ID = /^[a-z0-9][a-z0-9-]*$/;
const REMOTE = /^[A-Za-z0-9._-]+$/;
const BRANCH = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;
/** GCP project id and Compute Engine instance name rules: no wildcard, filter or label can name a VM. */
const PROJECT = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const VM = /^[a-z](?:[-a-z0-9]{0,61}[a-z0-9])?$/;
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
export const ACTION = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;
export const BASE_URL = /^https?:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?\/?$/;

const BUILTIN_REACHES = ["local", "git", "vm-agent", "gce-patch", "docker"];
const orList = (xs: string[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(", ")} or ${xs[xs.length - 1]}` : xs.join(""));

function reach(v: unknown, where: string, reg: Registry): Reach {
  const kind = isObj(v) ? v.kind : undefined;
  const plugin = typeof kind === "string" ? reg.reaches.get(kind) : undefined;
  if (plugin) return plugin.parse(v, where);
  if (kind === "local") {
    obj(v, where, ["kind"]);
    return { kind: "local" };
  }
  if (kind === "git") {
    const o = obj(v, where, ["kind", "repo", "remote", "base"]);
    const base = optStr(o, "base", where) ?? "main";
    if (!BRANCH.test(base) || base.split("/").some((s) => s === "." || s === "..")) throw new Error(`${where}.base must be a branch name`);
    return { kind: "git", repo: absPath(o, "repo", where), remote: optStr(o, "remote", where, REMOTE) ?? "origin", base };
  }
  if (kind === "vm-agent") {
    const o = obj(v, where, ["kind", "vm", "agent"]);
    return { kind: "vm-agent", vm: reqStr(o, "vm", where), agent: reqStr(o, "agent", where) };
  }
  if (kind === "gce-patch") {
    const o = obj(v, where, ["kind", "project", "vms", "actions", "baseUrl", "client"]);
    const project = reqStr(o, "project", where, PROJECT);
    const vms = strList(o, "vms", where);
    if (!vms?.length) throw new Error(`${where}.vms must be a non-empty array`);
    if (vms.some((n) => !VM.test(n)) || new Set(vms).size !== vms.length) throw new Error(`${where}.vms must be distinct VM instance names`);
    const actions = strList(o, "actions", where, ACTION) ?? [];
    const reads = actions.filter((a) => a.endsWith(".read")).length;
    const patches = actions.filter((a) => a.endsWith(".patch")).length;
    if (reads !== 1 || patches > 1 || reads + patches !== actions.length) throw new Error(`${where}.actions must be one <name>.read action and at most one <name>.patch action`);
    const client = o.client === undefined ? (reg.compat.brokerClient?.command ?? DEFAULT_COMPAT.brokerClient.command) : absPath(o, "client", where);
    return { kind: "gce-patch", project, vms, actions, baseUrl: reqStr(o, "baseUrl", where, BASE_URL), client };
  }
  if (kind === "docker") {
    const o = obj(v, where, ["kind", "on"]);
    return { kind: "docker", on: reqStr(o, "on", where, ID) };
  }
  throw new Error(`${where}.kind must be ${orList([...BUILTIN_REACHES, ...reg.reaches.keys()])}`);
}

function leg(v: unknown, where: string, reg: Registry): Leg {
  const kind = isObj(v) ? v.kind : undefined;
  const plugin = typeof kind === "string" ? reg.legs.get(kind) : undefined;
  if (plugin) return plugin.parse(v, where);
  if (kind === "pin-bump") return parsePinBumpLeg(v, where);
  if (kind === "docker-compose") {
    const o = obj(v, where, ["kind", "apply", "prune"]);
    return { kind, apply: optBool(o, "apply", where) ?? false, prune: optBool(o, "prune", where) ?? true };
  }
  if (kind === "os-packages") {
    const o = obj(v, where, ["kind", "apply", "cooldownDays", "seenTo", "approvalWaitS"]);
    const seenTo = resolve(absPath(o, "seenTo", where));
    if (!seenTo.endsWith(".json")) throw new Error(`${where}.seenTo must end in .json`);
    const approvalWaitS = optCount(o, "approvalWaitS", where) ?? 3600;
    if (!Number.isInteger(approvalWaitS) || approvalWaitS < 60 || approvalWaitS > 5400) throw new Error(`${where}.approvalWaitS must be a whole number of seconds from 60 to 5400`);
    return { kind, apply: optBool(o, "apply", where) ?? false, cooldownDays: optCount(o, "cooldownDays", where) ?? 2, seenTo, approvalWaitS };
  }
  if (typeof kind === "string" && (UNBUILT_LEGS as readonly string[]).includes(kind)) {
    obj(v, where, ["kind"]);
    return { kind: kind as UnbuiltLegKind };
  }
  throw new Error(`${where}.kind must be pin-bump, os-packages or one of ${["docker-compose", ...reg.legs.keys(), ...UNBUILT_LEGS].join(", ")}`);
}

function schedule(s: string, where: string): Schedule {
  if (s === "nightly") return { every: "night" };
  const m = s.match(/^weekly:([a-z]{3})$/);
  const day = m ? DAYS.indexOf(m[1]!) : -1;
  if (day < 0) throw new Error(`${where}.schedule must be "nightly" or "weekly:<sun|mon|tue|wed|thu|fri|sat>"`);
  return { every: "week", day };
}

/** The reach names a write action through its plugin. */
const canWrite = (r: Reach, reg: Registry): boolean => isPluginReach(r) && reg.reaches.get(r.kind)?.canWrite?.(r) === true;

function target(v: unknown, where: string, reg: Registry): Target {
  const o = obj(v, where, ["id", "os", "reach", "legs", "schedule", "summaryTo", "parityTo"]);
  const id = reqStr(o, "id", where, ID);
  const os = reqStr(o, "os", where);
  const oses = [...BUILTIN_OS, ...reg.os];
  if (!oses.includes(os)) throw new Error(`${where}.os must be ${orList(oses)}`);
  const r = reach(o.reach, `${where}.reach`, reg);
  if (!Array.isArray(o.legs) || !o.legs.length) throw new Error(`${where}.legs must be a non-empty array`);
  const legs = (o.legs as unknown[]).map((l, j) => leg(l, `${where}.legs[${j}]`, reg));
  legs.forEach((l, j) => {
    if (isPluginLeg(l)) {
      const why = reg.legs.get(l.kind)?.check?.(l, r, os, reg);
      if (why) throw new Error(`${where}.legs[${j}]: ${why}`);
      return;
    }
    if (l.kind === "pin-bump" && r.kind !== "git") throw new Error(`${where}.legs[${j}]: pin-bump needs a git reach`);
    if (l.kind === "docker-compose" && l.apply && !canWrite(r, reg)) throw new Error(`${where}.legs[${j}]: apply needs a reach with a write action`);
    if (l.kind === "os-packages" && (r.kind !== "gce-patch" || os !== "linux")) throw new Error(`${where}.legs[${j}]: os-packages needs a linux target with a gce-patch reach`);
    if (l.kind === "os-packages" && l.apply && !(!isPluginReach(r) && r.kind === "gce-patch" && r.actions.some((a) => a.endsWith(".patch")))) throw new Error(`${where}.legs[${j}]: apply needs a gce-patch reach with a .patch action`);
  });
  // Normalized, so "." / ".." / "//" aliases of one status file compare equal in the duplicate check.
  const summaryTo = resolve(absPath(o, "summaryTo", where));
  if (!summaryTo.endsWith(".tsv")) throw new Error(`${where}.summaryTo must end in .tsv`);
  const parityTo = o.parityTo === undefined ? undefined : resolve(absPath(o, "parityTo", where));
  if (parityTo !== undefined && !parityTo.endsWith(".jsonl")) throw new Error(`${where}.parityTo must end in .jsonl`);
  return { id, os, reach: r, legs, schedule: schedule(reqStr(o, "schedule", where), where), summaryTo, ...(parityTo ? { parityTo } : {}) };
}

/** Parses the targets file's text, ${NAME} read from env; `reg` adds the loaded plugins' kinds. */
export function parseTargetsConfig(text: string, env: Record<string, string | undefined> = process.env, reg: Registry = EMPTY_REGISTRY): TargetsConfig {
  const expanded = expandEnv(text, env);
  let root: unknown;
  try {
    root = JSON.parse(expanded);
  } catch {
    throw new Error("targets config is not valid JSON");
  }
  root = renameKeys(root, reg.compat.configKeys);
  const r = obj(root, "config", ["targets", "logDir", "reviewer", "secondReviewer"]);
  if (!Array.isArray(r.targets) || !r.targets.length) throw new Error("config.targets must be a non-empty array");
  const targets = (r.targets as unknown[]).map((t, i) => target(t, `targets[${i}]`, reg));
  const ids = new Set<string>();
  const files = new Set<string>();
  const seenFiles = new Set<string>();
  // A VM in two gce-patch targets would get two patch requests a run; names alone are compared, so two projects
  // cannot hide the same instance name either.
  const gceVms = new Map<string, string>();
  targets.forEach((t, i) => {
    if (ids.has(t.id)) throw new Error(`targets[${i}]: id ${t.id} is used twice`);
    if (files.has(t.summaryTo)) throw new Error(`targets[${i}]: summaryTo ${t.summaryTo} is used twice`);
    ids.add(t.id);
    files.add(t.summaryTo);
    if (!isPluginReach(t.reach) && t.reach.kind === "gce-patch")
      for (const vm of t.reach.vms) {
        const other = gceVms.get(vm);
        if (other !== undefined) throw new Error(`targets[${i}].reach.vms: ${vm} is already in gce-patch target ${other}`);
        gceVms.set(vm, t.id);
      }
    for (const l of t.legs) {
      if (isPluginLeg(l) || l.kind !== "os-packages") continue;
      if (seenFiles.has(l.seenTo)) throw new Error(`targets[${i}]: seenTo ${l.seenTo} is used twice`);
      seenFiles.add(l.seenTo);
    }
  });
  targets.forEach((t, i) => {
    if (!isPluginReach(t.reach) && t.reach.kind === "docker" && (t.reach.on === t.id || !ids.has(t.reach.on))) throw new Error(`targets[${i}].reach.on names no other target: ${t.reach.on}`);
  });
  const logDir = absPath(r, "logDir", "config");
  return {
    targets,
    logDir,
    ...(r.reviewer !== undefined ? { reviewer: validateReviewerSpec(r.reviewer) } : {}),
    ...(r.secondReviewer !== undefined ? { secondReviewer: validateReviewerSpec(r.secondReviewer) } : {}),
  };
}
