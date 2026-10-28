// The gce-patch inventory answer. The broker reduces the OS Config inventory, plus its archive-index and
// dependency check, to one JSON object per read, its fields beside run_id and seq: the VM, its instance id, the update time, os_info, the installed set by
// name and every upgradable candidate with the broker's origin verdict. Dependencies are not returned: the broker checks
// them, and the post-check catches drift. Decoding fails closed on an unknown key, a value outside its rule, a duplicate
// name, a candidate whose installed version is not the installed set's, or an answer naming another VM. Nothing in an
// answer is an instruction: names and versions pass fixed rules, and the broker's hold reasons stay log text.

import type { Decoded } from "../broker/answer.ts";
import { isObj, obj, reqStr, type Obj } from "../strict.ts";
import { DEB_VERSION, INSTANCE_ID, parseTime, PKG, SUITE } from "./verbs.ts";

export interface Pkg {
  name: string;
  version: string;
}
/** The broker's check of one candidate: its exact version is in the signed -security index and its relations hold, or why not. */
export type Origin = { ok: true; suite: string } | { ok: false; why: string };
export interface Candidate {
  name: string;
  installed: string;
  /** The broker's `available` version. */
  candidate: string;
  origin: Origin;
}
export interface Inventory {
  vm: string;
  instanceId: string;
  /** The inventory's update time, epoch ms, and as the broker wrote it. */
  updateTime: number;
  updateText: string;
  os: { shortName: string; version: string; architecture: string; kernelVersion: string };
  installed: Pkg[];
  candidates: Candidate[];
}

/** A package's key in the installed set, the compare and the first-seen file: its apt name (the inventory has no arch). */
export const pkgKey = (p: { name: string }): string => p.name;

const MAX_INSTALLED = 20_000;
const MAX_CANDIDATES = 2_000;
const ANY_CONTROL = /[\u0000-\u001f\u007f]/;

function list(o: Obj, k: string, where: string, max: number): unknown[] {
  const v = o[k];
  if (!Array.isArray(v)) throw new Error(`${where}.${k} must be an array`);
  if (v.length > max) throw new Error(`${where}.${k} has more than ${max} entries`);
  return v;
}

const BROKER_SHAPE = "must be {security: {suite}} or {hold: {reason}}";

function origin(c: Obj, w: string): Origin {
  const b = c.broker;
  if (!isObj(b) || Object.keys(b).length !== 1) throw new Error(`${w}.broker ${BROKER_SHAPE}`);
  if (isObj(b.security)) {
    const sec = obj(b.security, `${w}.broker.security`, ["suite"]);
    return { ok: true, suite: reqStr(sec, "suite", `${w}.broker.security`, SUITE) };
  }
  if (isObj(b.hold)) {
    const h = obj(b.hold, `${w}.broker.hold`, ["reason"]);
    const why = reqStr(h, "reason", `${w}.broker.hold`);
    if (why.length > 200 || ANY_CONTROL.test(why)) throw new Error(`${w}.broker.hold.reason must be one line of at most 200 characters`);
    // NEL and the Unicode line and paragraph separators break lines in some readers of the log: kept, but escaped.
    return { ok: false, why: why.replace(/[\u0085\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`) };
  }
  throw new Error(`${w}.broker ${BROKER_SHAPE}`);
}

/** answer: the inventory reply's fields without run_id and seq (broker.ts gceRead). */
export function decodeInventory(answer: unknown, vm: string): Decoded<Inventory> {
  try {
    const o = obj(answer, "inventory", ["vm", "instance_id", "update_time", "os_info", "installed", "candidates"]);
    if (o.vm !== vm) throw new Error(`inventory names another VM (${JSON.stringify(String(o.vm).slice(0, 64))}, expected ${vm})`);
    const instanceId = reqStr(o, "instance_id", "inventory", INSTANCE_ID);
    const updateText = reqStr(o, "update_time", "inventory");
    const updateTime = parseTime(updateText);
    if (updateTime === undefined) throw new Error(`inventory.update_time is not an RFC 3339 UTC time: ${JSON.stringify(updateText.slice(0, 40))}`);
    const os = obj(o.os_info, "inventory.os_info", ["short_name", "version", "architecture", "kernel_version"]);
    const osInfo = {
      // A Debian VM is refused by the broker's catalog, so only ubuntu is expected here.
      shortName: reqStr(os, "short_name", "inventory.os_info", /^ubuntu$/),
      version: reqStr(os, "version", "inventory.os_info", /^\d{1,2}(\.\d{1,2})?$/),
      architecture: reqStr(os, "architecture", "inventory.os_info", /^[a-z0-9_]{1,16}$/),
      kernelVersion: reqStr(os, "kernel_version", "inventory.os_info", /^[0-9][A-Za-z0-9.+_-]{0,63}$/),
    };
    const have = new Map<string, string>();
    const installed: Pkg[] = list(o, "installed", "inventory", MAX_INSTALLED).map((x, i) => {
      const w = `inventory.installed[${i}]`;
      const p = obj(x, w, ["name", "version"]);
      const pkg = { name: reqStr(p, "name", w, PKG), version: reqStr(p, "version", w, DEB_VERSION) };
      if (have.has(pkg.name)) throw new Error(`${w}: ${pkg.name} is listed twice`);
      have.set(pkg.name, pkg.version);
      return pkg;
    });
    const seen = new Set<string>();
    const candidates: Candidate[] = list(o, "candidates", "inventory", MAX_CANDIDATES).map((x, i) => {
      const w = `inventory.candidates[${i}]`;
      const c = obj(x, w, ["name", "installed", "available", "broker"]);
      const name = reqStr(c, "name", w, PKG);
      if (seen.has(name)) throw new Error(`${w}: ${name} is listed twice`);
      seen.add(name);
      const inst = reqStr(c, "installed", w, DEB_VERSION);
      if (have.get(name) !== inst) throw new Error(`${w}: ${name} installed ${inst} is not the inventory's installed version`);
      const next = reqStr(c, "available", w, DEB_VERSION);
      if (next === inst) throw new Error(`${w}: ${name} available equals its installed version`);
      return { name, installed: inst, candidate: next, origin: origin(c, w) };
    });
    return { ok: true, value: { vm, instanceId, updateTime, updateText, os: osInfo, installed, candidates } };
  } catch (e) {
    return { ok: false, why: e instanceof Error ? e.message : String(e) };
  }
}
