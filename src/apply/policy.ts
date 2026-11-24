// oupdate-policy.json: one shared file that names an owner and a reason for every pin-like entry of a
// host's config (pinRoots, caskExclude, a deferred service's holdFile) and for entries with no config
// key of their own (sandboxPins). An entry without both owner and reason is an error naming it. A plain
// value in config.json that the policy does not list still works for one release: it is reported as
// ownerless (a warning, never a failure). The policy's own values for pinRoots and caskExclude apply
// too, so a host can move them out of config.json.

import { isAbsolute } from "node:path";
import type { ApplyConfig } from "./config.ts";

export const POLICY_GROUPS = ["pinRoots", "caskExclude", "holdFile", "sandboxPins"] as const;
export type PolicyGroup = (typeof POLICY_GROUPS)[number];

export interface PolicyEntry {
  value: string;
  owner: string;
  reason: string;
}
export type Policy = Record<PolicyGroup, PolicyEntry[]>;

export const DEFAULT_POLICY_NAME = "oupdate-policy.json";
/** Every ownerless warning line starts with this; the digest reader skips such lines. */
export const POLICY_NOTE_PREFIX = "policy: WARNING ownerless: ";

/**
 * The form the consumers compare, for the duplicate and ownerless checks: a cask by its last path segment
 * (run-ctx.ts named()), a pinRoots path without trailing slashes, every other value exactly (a holdFile
 * is statted as written).
 */
export function sameKey(g: PolicyGroup, v: string): string {
  if (g === "caskExclude") return v.split("/").at(-1)!;
  if (g === "pinRoots") return v.length > 1 ? v.replace(/\/+$/, "") || "/" : v;
  return v;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown) => typeof v === "string" && v.trim() !== "";
const empty = (): Policy => ({ pinRoots: [], caskExclude: [], holdFile: [], sandboxPins: [] });

/** The first key written twice in one object of valid JSON text, or undefined (JSON.parse keeps only the last). */
function duplicateKey(src: string): string | undefined {
  let i = 0;
  const ws = () => {
    while (" \t\n\r".includes(src[i] ?? "x")) i++;
  };
  const str = (): string => {
    const start = i++;
    while (src[i] !== '"') i += src[i] === "\\" ? 2 : 1;
    return JSON.parse(src.slice(start, ++i)) as string;
  };
  const value = (): string | undefined => {
    ws();
    const c = src[i];
    if (c === "{") {
      i++;
      const seen = new Set<string>();
      for (ws(); src[i] !== "}"; ws()) {
        const k = str();
        if (seen.has(k)) return k;
        seen.add(k);
        ws();
        i++; // ":"
        const d = value();
        if (d !== undefined) return d;
        ws();
        if (src[i] === ",") i++;
      }
      i++;
    } else if (c === "[") {
      i++;
      for (ws(); src[i] !== "]"; ws()) {
        const d = value();
        if (d !== undefined) return d;
        ws();
        if (src[i] === ",") i++;
      }
      i++;
    } else if (c === '"') str();
    else while (i < src.length && !",}] \t\n\r".includes(src[i]!)) i++;
    return undefined;
  };
  return value();
}

/** Parses the policy file's text; every mistake is an error that names the entry. */
export function parsePolicy(src: string, name = DEFAULT_POLICY_NAME): Policy {
  let root: unknown;
  try {
    root = JSON.parse(src);
  } catch {
    throw new Error(`${name} is not valid JSON`);
  }
  const dup = duplicateKey(src);
  if (dup !== undefined) throw new Error(`${name}: duplicate key ${JSON.stringify(dup)}`);
  if (!isObj(root)) throw new Error(`${name} must be an object`);
  for (const k of Object.keys(root)) if (!(POLICY_GROUPS as readonly string[]).includes(k)) throw new Error(`${name}: unknown key ${JSON.stringify(k)}`);
  const out = empty();
  for (const g of POLICY_GROUPS) {
    const list = root[g];
    if (list === undefined) continue;
    if (!Array.isArray(list)) throw new Error(`${name}: ${g} must be an array`);
    list.forEach((e, i) => {
      const at = `${name}: ${g}[${i}]`;
      if (!isObj(e)) throw new Error(`${at} must be an object with value, owner and reason`);
      if (!text(e.value)) throw new Error(`${at} needs a value`);
      const value = e.value as string;
      const missing = (["owner", "reason"] as const).filter((k) => !text(e[k]));
      if (missing.length) throw new Error(`${at} (${JSON.stringify(value)}) needs ${missing.join(" and ")}`);
      if ((g === "pinRoots" || g === "holdFile") && !isAbsolute(value)) throw new Error(`${at} (${JSON.stringify(value)}) must be an absolute path`);
      if (out[g].some((x) => sameKey(g, x.value) === sameKey(g, value))) throw new Error(`${at} (${JSON.stringify(value)}) is listed twice`);
      out[g].push({ value, owner: e.owner as string, reason: e.reason as string });
    });
  }
  return out;
}

/**
 * The config with the policy's pinRoots and caskExclude values added, and the warning lines for every
 * plain config value the policy has no entry for ("ownerless"). No policy: every plain value is ownerless.
 */
export function applyPolicy(cfg: ApplyConfig, policy: Policy | undefined, fileName = DEFAULT_POLICY_NAME): { cfg: ApplyConfig; notes: string[] } {
  const p = policy ?? empty();
  const notes: string[] = [];
  const own = (g: PolicyGroup, key: string, values: string[]) => {
    for (const v of values) if (!p[g].some((e) => sameKey(g, e.value) === sameKey(g, v))) notes.push(`${POLICY_NOTE_PREFIX}${key} ${JSON.stringify(v)} has no owner and reason in ${fileName}`);
  };
  own("pinRoots", "pinRoots", cfg.pinRoots);
  own("caskExclude", "caskExclude", cfg.caskExclude);
  own("holdFile", "deferred holdFile", cfg.deferred.map((s) => s.holdFile));
  const union = (a: string[], g: PolicyGroup) => [...a, ...p[g].map((e) => e.value).filter((v) => !a.some((x) => (g === "pinRoots" ? sameKey(g, x) === sameKey(g, v) : x === v)))];
  return { cfg: { ...cfg, pinRoots: union(cfg.pinRoots, "pinRoots"), caskExclude: union(cfg.caskExclude, "caskExclude"), policyEntries: { pinRoots: p.pinRoots, caskExclude: p.caskExclude } }, notes };
}
