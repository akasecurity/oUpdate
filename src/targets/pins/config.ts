// The pin-bump leg's config: which pins file in the git reach, how each group of its keys finds a
// newer value, and where a proposal goes. Every key in the pins file must be named exactly once:
// in a group, in `fixed` (a policy value, not an update) or in `notChecked` (with the reason, which
// the leg logs each run). A key named nowhere is reported as an unknown pin, with trouble.

import { absPath, isObj, obj, optBool, optCount, optStr, reqStr, strList, strMap, type Obj } from "../strict.ts";

export const PIN_KEY = /^[A-Z][A-Z0-9_]*$/;
const GROUP_NAME = /^[a-z0-9][a-z0-9-]*$/;
const NPM_NAME = /^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/;
/** "name@{v}" with an optional suffix after the version, e.g. "@scope/cli@{v}-linux-x64". */
const NPM_SPEC = /^(@[a-z0-9._-]+\/)?[a-z0-9._-]+@\{v\}[A-Za-z0-9.-]*$/;
const SLUG = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
/** A release tag with exactly one {v}, e.g. "v{v}" or "bun-v{v}". */
const TAG = /^[A-Za-z0-9._-]*\{v\}[A-Za-z0-9._-]*$/;
/** An asset file name, {v} allowed any number of times. */
const ASSET = /^[A-Za-z0-9._-]*(\{v\}[A-Za-z0-9._-]*)*$/;
const REPOSITORY = /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/;
const BRANCH_PREFIX = /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*\/$/;
const HTTPS_URL = /^https:\/\/[A-Za-z0-9.-]+(\/[A-Za-z0-9._~\/-]*)?$/;
const SUITE = /^[a-z][a-z0-9-]*$/;
const AUTHOR_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/;
const EMAIL = /^[^\s@<>]+@[^\s@<>]+$/;

export interface NpmGroup { source: "npm"; name: string; package: string; versionKey: string; integrity: Record<string, string>; propose: boolean; note?: string }
export interface GithubGroup { source: "github-release"; name: string; repo: string; tag: string; versionKey: string; assets: Record<string, string>; propose: boolean; note?: string }
export interface OciGroup { source: "oci-index"; name: string; registry: "docker-hub"; repository: string; tagKey: string; digestKey: string; snapshot?: { key: string; base: string; suite: string }; propose: boolean; note?: string }
export type PinGroup = NpmGroup | GithubGroup | OciGroup;

export interface PinBumpLeg {
  kind: "pin-bump";
  /** Repository-relative path of the pins file, read at the base commit (never from a checkout). */
  pinsPath: string;
  /** Branch names are `<branchPrefix>pins-<hash>`; the prefix ends in "/", so a branch is never the base. */
  branchPrefix: string;
  /** Absolute directory for the train ask text files. */
  trainAskDir: string;
  /** Push the proposal branch (only that ref) to the reach's remote. */
  push: boolean;
  cooldownDays: number;
  author: { name: string; email: string };
  groups: PinGroup[];
  fixed: string[];
  notChecked: Record<string, string>;
}

export const DEFAULT_AUTHOR = { name: "oupdate", email: "oupdate@invalid" };

const LEG_KEYS = ["kind", "pinsPath", "branchPrefix", "trainAskDir", "push", "cooldownDays", "author", "groups", "fixed", "notChecked"];

/** The keys a group reads or writes. */
export function groupKeys(g: PinGroup): string[] {
  if (g.source === "npm") return [g.versionKey, ...Object.keys(g.integrity)];
  if (g.source === "github-release") return [g.versionKey, ...Object.keys(g.assets)];
  return [g.tagKey, g.digestKey, ...(g.snapshot ? [g.snapshot.key] : [])];
}

const note = (o: Obj, where: string): { note?: string } => {
  const n = optStr(o, "note", where);
  return n ? { note: n } : {};
};

function group(v: unknown, where: string): PinGroup {
  const source = isObj(v) ? v.source : undefined;
  if (source === "npm") {
    const o = obj(v, where, ["source", "name", "package", "versionKey", "integrity", "propose", "note"]);
    return {
      source: "npm",
      name: reqStr(o, "name", where, GROUP_NAME),
      package: reqStr(o, "package", where, NPM_NAME),
      versionKey: reqStr(o, "versionKey", where, PIN_KEY),
      integrity: strMap(o, "integrity", where, PIN_KEY, NPM_SPEC) ?? {},
      propose: optBool(o, "propose", where) ?? true,
      ...note(o, where),
    };
  }
  if (source === "github-release") {
    const o = obj(v, where, ["source", "name", "repo", "tag", "versionKey", "assets", "propose", "note"]);
    const assets = strMap(o, "assets", where, PIN_KEY, ASSET);
    if (!assets || !Object.keys(assets).length) throw new Error(`${where}.assets must name at least one pinned asset hash`);
    return {
      source: "github-release",
      name: reqStr(o, "name", where, GROUP_NAME),
      repo: reqStr(o, "repo", where, SLUG),
      tag: reqStr(o, "tag", where, TAG),
      versionKey: reqStr(o, "versionKey", where, PIN_KEY),
      assets,
      propose: optBool(o, "propose", where) ?? true,
      ...note(o, where),
    };
  }
  if (source === "oci-index") {
    const o = obj(v, where, ["source", "name", "registry", "repository", "tagKey", "digestKey", "snapshot", "propose", "note"]);
    if (reqStr(o, "registry", where) !== "docker-hub") throw new Error(`${where}.registry must be "docker-hub" (the only registry read so far)`);
    let snapshot: OciGroup["snapshot"];
    if (o.snapshot !== undefined) {
      const sw = `${where}.snapshot`;
      const s = obj(o.snapshot, sw, ["key", "base", "suite"]);
      snapshot = { key: reqStr(s, "key", sw, PIN_KEY), base: reqStr(s, "base", sw, HTTPS_URL), suite: reqStr(s, "suite", sw, SUITE) };
    }
    return {
      source: "oci-index",
      name: reqStr(o, "name", where, GROUP_NAME),
      registry: "docker-hub",
      repository: reqStr(o, "repository", where, REPOSITORY),
      tagKey: reqStr(o, "tagKey", where, PIN_KEY),
      digestKey: reqStr(o, "digestKey", where, PIN_KEY),
      ...(snapshot ? { snapshot } : {}),
      propose: optBool(o, "propose", where) ?? true,
      ...note(o, where),
    };
  }
  throw new Error(`${where}.source must be npm, github-release or oci-index`);
}

export function parsePinBumpLeg(v: unknown, where: string): PinBumpLeg {
  const o = obj(v, where, LEG_KEYS);
  const pinsPath = reqStr(o, "pinsPath", where);
  if (pinsPath.startsWith("/") || !/^[A-Za-z0-9._\/-]+$/.test(pinsPath) || pinsPath.split("/").some((s) => s === "" || s === "." || s === ".."))
    throw new Error(`${where}.pinsPath must be a path inside the repository, without empty, . or .. segments`);
  const branchPrefix = reqStr(o, "branchPrefix", where);
  if (!BRANCH_PREFIX.test(branchPrefix) || branchPrefix.includes("..")) throw new Error(`${where}.branchPrefix must be lowercase segments ending in "/", e.g. "oupdate/"`);
  let author = DEFAULT_AUTHOR;
  if (o.author !== undefined) {
    const aw = `${where}.author`;
    const a = obj(o.author, aw, ["name", "email"]);
    author = { name: reqStr(a, "name", aw, AUTHOR_NAME), email: reqStr(a, "email", aw, EMAIL) };
  }
  if (!Array.isArray(o.groups) || !o.groups.length) throw new Error(`${where}.groups must be a non-empty array`);
  const groups = (o.groups as unknown[]).map((g, i) => group(g, `${where}.groups[${i}]`));
  const fixed = strList(o, "fixed", where, PIN_KEY) ?? [];
  const notChecked = strMap(o, "notChecked", where, PIN_KEY) ?? {};
  const names = new Set<string>();
  for (const g of groups) {
    if (names.has(g.name)) throw new Error(`${where}: two groups are named ${g.name}`);
    names.add(g.name);
  }
  const owner = new Map<string, string>();
  const claim = (k: string, by: string) => {
    const prev = owner.get(k);
    if (prev) throw new Error(`${where}: ${k} is named by ${prev} and ${by}`);
    owner.set(k, by);
  };
  for (const g of groups) for (const k of groupKeys(g)) claim(k, `group ${g.name}`);
  for (const k of fixed) claim(k, "fixed");
  for (const k of Object.keys(notChecked)) claim(k, "notChecked");
  return {
    kind: "pin-bump",
    pinsPath,
    branchPrefix,
    trainAskDir: absPath(o, "trainAskDir", where),
    push: optBool(o, "push", where) ?? false,
    cooldownDays: optCount(o, "cooldownDays", where) ?? 7,
    author,
    groups,
    fixed,
    notChecked,
  };
}
