// The host apply's config: everything host-specific comes from here, nothing is built in. It is
// the "apply" object of oupdate's config file. Paths must be absolute. An unknown key or a wrong
// type is an error, so a typo never silently turns a guard off.

import { isAbsolute } from "node:path";
import type { Caps } from "./chunked.ts";
import type { DeferredService } from "./waiter.ts";
import type { LabelRestart } from "./kegs.ts";
import { validateReviewerSpec, type ReviewerSpec } from "../adapters/reviewer/spec.ts";

export interface RestartHelper {
  /** A narrow root helper run as `sudo -n <path> <package>`. */
  path: string;
  /** Packages it may restart. */
  packages: string[];
  /** Of those, the ones restarted detached after a delay (a restart that would cut this run's own connection). */
  detached?: string[];
  delaySec?: number;
}

export interface ApplyConfig {
  host: string;
  /** Stuck state and the Gatekeeper team pins and release log live here. */
  stateDir: string;
  /** The run's log and summary are appended here. */
  logFile?: string;
  brew: string;
  /** npm's path, or null to skip the npm phase. */
  npm: string | null;
  /**
   * The native Claude Code binary (absolute). When set and executable, the npm phase runs
   * `<claudeCode> update`, then `<claudeCode> --version`; when absent the npm line says "not configured".
   */
  claudeCode?: string;
  lsof: string;
  /** Type A: official taps, the deterministic version policy. */
  officialTaps: string[];
  /** Type B: trusted third-party taps, reviewed per package. */
  typeBTaps: string[];
  /** Per-host tap approvals, "<tap>\t<host or *>\t<date>\t<note>" rows; adds to typeBTaps. */
  approvedTapsFile?: string;
  hostPrefixes: string[];
  /** Repos one level under these may hold a pins.json. */
  pinRoots: string[];
  caskExclude: string[];
  stuckAfter: number;
  /** Type A packages held on a major-version increase. */
  sensitive: string[];
  /** Services restarted only through their idle waiter. */
  deferred: DeferredService[];
  restartHelper?: RestartHelper;
  /**
   * Stale-keg restarts by launchd label (matched literally): "skip" leaves the restart to the job's
   * owner; "kickstart" restarts it as usual (an allow entry under staleKegUnlisted "report"); an argv
   * (argv[0] absolute) is run detached with the label appended, never waited for.
   */
  labelRestart?: LabelRestart;
  /** A stale-keg label not in labelRestart: "kickstart" (the default) restarts it, "report" only names it. */
  staleKegUnlisted?: "kickstart" | "report";
  /** A notify command: the notice text is passed as its last argument. [] is log-only by choice; absent is "not configured". */
  notify?: string[];
  reviewer?: ReviewerSpec;
  /**
   * Package name (brew formula, cask or npm global; a tap-qualified brew name matches on its last segment) to the argv run after
   * that package was upgraded this run, e.g. {"git": ["git", "--version"]}. A non-zero exit or a timeout is logged, notified and
   * counted as FAILED in the brew line; it never aborts the run. Absent: no check runs.
   */
  postUpgradeCheck?: Record<string, string[]>;
  /** Per command; a command past it is killed and its phase marked failed. */
  timeoutMs: number;
  npmRegistry: string;
  caps?: Caps;
}

export const DEFAULTS = {
  brew: "brew",
  npm: "npm",
  lsof: "/usr/sbin/lsof",
  officialTaps: ["homebrew/core", "homebrew/cask", "homebrew/cask-fonts", "homebrew/cask-versions", "homebrew/cask-drivers"],
  stuckAfter: 3,
  sensitive: ["openssl", "curl", "git", "python", "node", "ssh", "openssh", "ollama", "llama-cpp"],
  timeoutMs: 45 * 60_000,
  npmRegistry: "https://registry.npmjs.org",
};

const KEYS = new Set([
  "host", "stateDir", "logFile", "brew", "npm", "claudeCode", "lsof", "officialTaps", "typeBTaps", "approvedTapsFile", "hostPrefixes", "pinRoots",
  "caskExclude", "stuckAfter", "sensitive", "deferred", "restartHelper", "labelRestart", "staleKegUnlisted", "notify", "reviewer", "postUpgradeCheck", "timeoutMs", "npmRegistry", "caps",
]);
const SERVICE_KEYS = ["name", "waiter", "holdFile", "quarantineFile", "outcomeFile", "restartLog"] as const;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

function str(o: Obj, k: string, where: string): string | undefined {
  const v = o[k];
  if (v === undefined) return undefined;
  if (typeof v !== "string" || !v) throw new Error(`${where}.${k} must be a non-empty string`);
  return v;
}

function path(o: Obj, k: string, where: string): string | undefined {
  const v = str(o, k, where);
  if (v !== undefined && !isAbsolute(v)) throw new Error(`${where}.${k} must be an absolute path`);
  return v;
}

function list(o: Obj, k: string, where: string, nonEmpty = false): string[] | undefined {
  const v = o[k];
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string" && x !== "") || (nonEmpty && !v.length)) throw new Error(`${where}.${k} must be a${nonEmpty ? " non-empty" : "n"} array of non-empty strings`);
  return v as string[];
}

function posInt(o: Obj, k: string, where: string): number | undefined {
  const v = o[k];
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1) throw new Error(`${where}.${k} must be a positive integer`);
  return v;
}

function service(v: unknown, i: number): DeferredService {
  const where = `apply.deferred[${i}]`;
  if (!isObj(v)) throw new Error(`${where} must be an object`);
  for (const k of Object.keys(v)) if (!(SERVICE_KEYS as readonly string[]).includes(k)) throw new Error(`${where}: unknown key ${k}`);
  const name = str(v, "name", where);
  if (!name) throw new Error(`${where}.name is required`);
  const out: Record<string, string> = { name };
  for (const k of SERVICE_KEYS.slice(1)) {
    const p = path(v, k, where);
    if (!p) throw new Error(`${where}.${k} is required`);
    out[k] = p;
  }
  return out as unknown as DeferredService;
}

/** Parses the config file's text; `host` is the fallback when the file names none. */
export function parseApplyConfig(text: string, fallbackHost: string): ApplyConfig {
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    throw new Error("config is not valid JSON");
  }
  if (!isObj(root) || !isObj(root.apply)) throw new Error('config needs an "apply" object');
  const a = root.apply;
  const w = "apply";
  for (const k of Object.keys(a)) if (!KEYS.has(k)) throw new Error(`${w}: unknown key ${k}`);
  const stateDir = path(a, "stateDir", w);
  if (!stateDir) throw new Error(`${w}.stateDir is required`);
  let npm: string | null = DEFAULTS.npm;
  if (a.npm === null) npm = null;
  else if (a.npm !== undefined) npm = str(a, "npm", w)!;
  let restartHelper: RestartHelper | undefined;
  if (a.restartHelper !== undefined) {
    const h = a.restartHelper;
    const hw = `${w}.restartHelper`;
    if (!isObj(h)) throw new Error(`${hw} must be an object`);
    for (const k of Object.keys(h)) if (!["path", "packages", "detached", "delaySec"].includes(k)) throw new Error(`${hw}: unknown key ${k}`);
    const p = path(h, "path", hw);
    if (!p) throw new Error(`${hw}.path is required`);
    restartHelper = { path: p, packages: list(h, "packages", hw) ?? [], detached: list(h, "detached", hw), delaySec: posInt(h, "delaySec", hw) };
  }
  let labelRestart: LabelRestart | undefined;
  if (a.labelRestart !== undefined) {
    const lw = `${w}.labelRestart`;
    if (!isObj(a.labelRestart)) throw new Error(`${lw} must be an object`);
    // Built with fromEntries (own data properties), so a label like "__proto__" is only a label.
    const entries: [string, LabelRestart[string]][] = [];
    for (const [label, v] of Object.entries(a.labelRestart)) {
      if (!label) throw new Error(`${lw}: a label must be non-empty`);
      if (v === "skip" || v === "kickstart") entries.push([label, v]);
      else if (Array.isArray(v) && v.length && v.every((x) => typeof x === "string" && x !== "") && isAbsolute(v[0] as string)) entries.push([label, [...(v as string[])]]);
      else throw new Error(`${lw}[${JSON.stringify(label)}] must be "skip", "kickstart" or a non-empty argv array whose first entry is an absolute path`);
    }
    labelRestart = Object.fromEntries(entries);
  }
  let postUpgradeCheck: Record<string, string[]> | undefined;
  if (a.postUpgradeCheck !== undefined) {
    const pw = `${w}.postUpgradeCheck`;
    if (!isObj(a.postUpgradeCheck)) throw new Error(`${pw} must be an object`);
    const entries: [string, string[]][] = [];
    for (const [pkg, v] of Object.entries(a.postUpgradeCheck)) {
      if (!pkg) throw new Error(`${pw}: a package name must be non-empty`);
      if (!Array.isArray(v) || !v.length || !v.every((x) => typeof x === "string" && x !== "")) throw new Error(`${pw}[${JSON.stringify(pkg)}] must be a non-empty array of non-empty strings`);
      entries.push([pkg, [...(v as string[])]]);
    }
    postUpgradeCheck = Object.fromEntries(entries);
  }
  const staleKegUnlisted = a.staleKegUnlisted === "report" ? "report" : "kickstart";
  if (a.staleKegUnlisted !== undefined && a.staleKegUnlisted !== staleKegUnlisted) throw new Error(`${w}.staleKegUnlisted must be "kickstart" or "report"`);
  if (a.deferred !== undefined && !Array.isArray(a.deferred)) throw new Error(`${w}.deferred must be an array`);
  let caps: Caps | undefined;
  if (a.caps !== undefined) {
    if (!isObj(a.caps)) throw new Error(`${w}.caps must be an object`);
    caps = { lines: posInt(a.caps, "lines", `${w}.caps`), maxChunks: posInt(a.caps, "maxChunks", `${w}.caps`), bytes: posInt(a.caps, "bytes", `${w}.caps`) };
  }
  return {
    host: str(a, "host", w) ?? fallbackHost,
    stateDir,
    logFile: path(a, "logFile", w),
    brew: str(a, "brew", w) ?? DEFAULTS.brew,
    npm,
    claudeCode: path(a, "claudeCode", w),
    lsof: path(a, "lsof", w) ?? DEFAULTS.lsof,
    officialTaps: (list(a, "officialTaps", w, true) ?? DEFAULTS.officialTaps).map((t) => t.toLowerCase()),
    typeBTaps: (list(a, "typeBTaps", w) ?? []).map((t) => t.toLowerCase()),
    approvedTapsFile: path(a, "approvedTapsFile", w),
    hostPrefixes: list(a, "hostPrefixes", w) ?? [],
    pinRoots: (list(a, "pinRoots", w) ?? []).map((p, i) => {
      if (!isAbsolute(p)) throw new Error(`${w}.pinRoots[${i}] must be an absolute path`);
      return p;
    }),
    caskExclude: list(a, "caskExclude", w) ?? [],
    stuckAfter: posInt(a, "stuckAfter", w) ?? DEFAULTS.stuckAfter,
    sensitive: list(a, "sensitive", w) ?? DEFAULTS.sensitive,
    deferred: ((a.deferred as unknown[] | undefined) ?? []).map(service),
    restartHelper,
    labelRestart,
    staleKegUnlisted,
    notify: list(a, "notify", w),
    postUpgradeCheck,
    reviewer: a.reviewer === undefined ? undefined : validateReviewerSpec(a.reviewer),
    timeoutMs: posInt(a, "timeoutMs", w) ?? DEFAULTS.timeoutMs,
    npmRegistry: str(a, "npmRegistry", w) ?? DEFAULTS.npmRegistry,
    caps,
  };
}
