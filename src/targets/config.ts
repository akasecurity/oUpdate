// The targets file read by `oupdate targets`: {"logDir", "reviewer"?, "targets": [...]}. Strict like
// the host config: an unknown key or a wrong type is an error. Reach kinds and legs the runner does not
// build yet still parse, so the file can list every target now and each reports "not checked"; the NAS legs are
// review only unless `apply` is true.

import { resolve } from "node:path";
import { validateReviewerSpec, type ReviewerSpec } from "../adapters/reviewer/spec.ts";
import { expandEnv } from "../env.ts";
import { NAS_LEGS, UNBUILT_LEGS, type Leg, type Reach, type Schedule, type Target, type TargetOs, type UnbuiltLegKind } from "./model.ts";
import { parsePinBumpLeg } from "./pins/config.ts";
import { absPath, isObj, obj, optBool, optCount, optStr, reqStr, strList } from "./strict.ts";

export interface TargetsConfig {
  targets: Target[];
  /** Run logs: targets.log, or dry-run-targets.log for a dry run. */
  logDir: string;
  /** The router-model reviewer (and, for the NAS legs, the first of the two). */
  reviewer?: ReviewerSpec;
  /** The NAS legs' on-prem second opinion. */
  secondReviewer?: ReviewerSpec;
}

const ID = /^[a-z0-9][a-z0-9-]*$/;
const REMOTE = /^[A-Za-z0-9._-]+$/;
const BRANCH = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;
/** GCP project id and Compute Engine instance name rules: no wildcard, filter or label can name a VM. */
const PROJECT = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const VM = /^[a-z](?:[-a-z0-9]{0,61}[a-z0-9])?$/;
const OS: readonly TargetOs[] = ["macos", "unraid", "linux"];
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const ACTION = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;
const BROKER_HOST = /^[a-z0-9][a-z0-9.-]{0,62}$/;
const BASE_URL = /^https?:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?\/?$/;

function reach(v: unknown, where: string): Reach {
  const kind = isObj(v) ? v.kind : undefined;
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
  if (kind === "broker-script") {
    const o = obj(v, where, ["kind", "host", "actions", "baseUrl", "credreq"]);
    const actions = strList(o, "actions", where, ACTION);
    if (!actions?.length) throw new Error(`${where}.actions must be a non-empty array`);
    const reads = actions.filter((a) => a.endsWith(".read")).length;
    const writes = actions.filter((a) => a.endsWith(".write")).length;
    if (reads !== 1 || writes > 1 || reads + writes !== actions.length) throw new Error(`${where}.actions must be one <name>.read action and at most one <name>.write action`);
    const credreq = o.credreq === undefined ? "credreq" : absPath(o, "credreq", where);
    return { kind: "broker-script", host: reqStr(o, "host", where, BROKER_HOST), actions, baseUrl: reqStr(o, "baseUrl", where, BASE_URL), credreq };
  }
  if (kind === "vm-agent") {
    const o = obj(v, where, ["kind", "vm", "agent"]);
    return { kind: "vm-agent", vm: reqStr(o, "vm", where), agent: reqStr(o, "agent", where) };
  }
  if (kind === "gce-patch") {
    const o = obj(v, where, ["kind", "project", "vms", "actions", "baseUrl", "credreq"]);
    const project = reqStr(o, "project", where, PROJECT);
    const vms = strList(o, "vms", where);
    if (!vms?.length) throw new Error(`${where}.vms must be a non-empty array`);
    if (vms.some((n) => !VM.test(n)) || new Set(vms).size !== vms.length) throw new Error(`${where}.vms must be distinct VM instance names`);
    const actions = strList(o, "actions", where, ACTION) ?? [];
    const reads = actions.filter((a) => a.endsWith(".read")).length;
    const patches = actions.filter((a) => a.endsWith(".patch")).length;
    if (reads !== 1 || patches > 1 || reads + patches !== actions.length) throw new Error(`${where}.actions must be one <name>.read action and at most one <name>.patch action`);
    const credreq = o.credreq === undefined ? "credreq" : absPath(o, "credreq", where);
    return { kind: "gce-patch", project, vms, actions, baseUrl: reqStr(o, "baseUrl", where, BASE_URL), credreq };
  }
  if (kind === "docker") {
    const o = obj(v, where, ["kind", "on"]);
    return { kind: "docker", on: reqStr(o, "on", where, ID) };
  }
  throw new Error(`${where}.kind must be local, git, broker-script, vm-agent, gce-patch or docker`);
}

function leg(v: unknown, where: string): Leg {
  const kind = isObj(v) ? v.kind : undefined;
  if (kind === "pin-bump") return parsePinBumpLeg(v, where);
  if (kind === "docker-compose") {
    const o = obj(v, where, ["kind", "apply", "prune"]);
    return { kind, apply: optBool(o, "apply", where) ?? false, prune: optBool(o, "prune", where) ?? true };
  }
  if (kind === "unraid-plugin") {
    const o = obj(v, where, ["kind", "apply"]);
    return { kind, apply: optBool(o, "apply", where) ?? false };
  }
  if (kind === "unraid-os") {
    obj(v, where, ["kind"]);
    return { kind };
  }
  if (kind === "os-packages") {
    const o = obj(v, where, ["kind", "apply", "cooldownDays", "seenTo", "cardWaitS"]);
    const seenTo = resolve(absPath(o, "seenTo", where));
    if (!seenTo.endsWith(".json")) throw new Error(`${where}.seenTo must end in .json`);
    const cardWaitS = optCount(o, "cardWaitS", where) ?? 3600;
    if (!Number.isInteger(cardWaitS) || cardWaitS < 60 || cardWaitS > 5400) throw new Error(`${where}.cardWaitS must be a whole number of seconds from 60 to 5400`);
    return { kind, apply: optBool(o, "apply", where) ?? false, cooldownDays: optCount(o, "cooldownDays", where) ?? 2, seenTo, cardWaitS };
  }
  if (typeof kind === "string" && (UNBUILT_LEGS as readonly string[]).includes(kind)) {
    obj(v, where, ["kind"]);
    return { kind: kind as UnbuiltLegKind };
  }
  throw new Error(`${where}.kind must be pin-bump, os-packages or one of ${[...NAS_LEGS, ...UNBUILT_LEGS].join(", ")}`);
}

function schedule(s: string, where: string): Schedule {
  if (s === "nightly") return { every: "night" };
  const m = s.match(/^weekly:([a-z]{3})$/);
  const day = m ? DAYS.indexOf(m[1]!) : -1;
  if (day < 0) throw new Error(`${where}.schedule must be "nightly" or "weekly:<sun|mon|tue|wed|thu|fri|sat>"`);
  return { every: "week", day };
}

function target(v: unknown, where: string): Target {
  const o = obj(v, where, ["id", "os", "reach", "legs", "schedule", "summaryTo", "parityTo"]);
  const id = reqStr(o, "id", where, ID);
  const os = reqStr(o, "os", where);
  if (!(OS as readonly string[]).includes(os)) throw new Error(`${where}.os must be macos, unraid or linux`);
  const r = reach(o.reach, `${where}.reach`);
  if (!Array.isArray(o.legs) || !o.legs.length) throw new Error(`${where}.legs must be a non-empty array`);
  const legs = (o.legs as unknown[]).map((l, j) => leg(l, `${where}.legs[${j}]`));
  const canWrite = r.kind === "broker-script" && r.actions.some((a) => a.endsWith(".write"));
  legs.forEach((l, j) => {
    if (l.kind === "pin-bump" && r.kind !== "git") throw new Error(`${where}.legs[${j}]: pin-bump needs a git reach`);
    if ((l.kind === "unraid-plugin" || l.kind === "unraid-os") && r.kind !== "broker-script") throw new Error(`${where}.legs[${j}]: ${l.kind} needs a broker-script reach`);
    if ((l.kind === "docker-compose" || l.kind === "unraid-plugin") && l.apply && !canWrite) throw new Error(`${where}.legs[${j}]: apply needs a broker-script reach with a .write action`);
    if (l.kind === "os-packages" && (r.kind !== "gce-patch" || os !== "linux")) throw new Error(`${where}.legs[${j}]: os-packages needs a linux target with a gce-patch reach`);
    if (l.kind === "os-packages" && l.apply && !(r.kind === "gce-patch" && r.actions.some((a) => a.endsWith(".patch")))) throw new Error(`${where}.legs[${j}]: apply needs a gce-patch reach with a .patch action`);
  });
  // Normalized, so "." / ".." / "//" aliases of one status file compare equal in the duplicate check.
  const summaryTo = resolve(absPath(o, "summaryTo", where));
  if (!summaryTo.endsWith(".tsv")) throw new Error(`${where}.summaryTo must end in .tsv`);
  const parityTo = o.parityTo === undefined ? undefined : resolve(absPath(o, "parityTo", where));
  if (parityTo !== undefined && !parityTo.endsWith(".jsonl")) throw new Error(`${where}.parityTo must end in .jsonl`);
  return { id, os: os as TargetOs, reach: r, legs, schedule: schedule(reqStr(o, "schedule", where), where), summaryTo, ...(parityTo ? { parityTo } : {}) };
}

/** Parses the targets file's text, ${NAME} read from env. */
export function parseTargetsConfig(text: string, env: Record<string, string | undefined> = process.env): TargetsConfig {
  const expanded = expandEnv(text, env);
  let root: unknown;
  try {
    root = JSON.parse(expanded);
  } catch {
    throw new Error("targets config is not valid JSON");
  }
  const r = obj(root, "config", ["targets", "logDir", "reviewer", "secondReviewer"]);
  if (!Array.isArray(r.targets) || !r.targets.length) throw new Error("config.targets must be a non-empty array");
  const targets = (r.targets as unknown[]).map((t, i) => target(t, `targets[${i}]`));
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
    if (t.reach.kind === "gce-patch")
      for (const vm of t.reach.vms) {
        const other = gceVms.get(vm);
        if (other !== undefined) throw new Error(`targets[${i}].reach.vms: ${vm} is already in gce-patch target ${other}`);
        gceVms.set(vm, t.id);
      }
    for (const l of t.legs) {
      if (l.kind !== "os-packages") continue;
      if (seenFiles.has(l.seenTo)) throw new Error(`targets[${i}]: seenTo ${l.seenTo} is used twice`);
      seenFiles.add(l.seenTo);
    }
  });
  targets.forEach((t, i) => {
    if (t.reach.kind === "docker" && (t.reach.on === t.id || !ids.has(t.reach.on))) throw new Error(`targets[${i}].reach.on names no other target: ${t.reach.on}`);
  });
  const logDir = absPath(r, "logDir", "config");
  return {
    targets,
    logDir,
    ...(r.reviewer !== undefined ? { reviewer: validateReviewerSpec(r.reviewer) } : {}),
    ...(r.secondReviewer !== undefined ? { secondReviewer: validateReviewerSpec(r.secondReviewer) } : {}),
  };
}
