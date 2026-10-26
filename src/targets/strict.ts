// Strict reading of the targets config, in apply/config.ts's style: an unknown key, a wrong type or a
// missing required value is an error, so a typo never silently turns a guard off.

import { isAbsolute } from "node:path";

export type Obj = Record<string, unknown>;
export const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** An object holding only the listed keys. */
export function obj(v: unknown, where: string, keys: readonly string[]): Obj {
  if (!isObj(v)) throw new Error(`${where} must be an object`);
  for (const k of Object.keys(v)) if (!keys.includes(k)) throw new Error(`${where}: unknown key ${k}`);
  return v;
}

export function optStr(o: Obj, k: string, where: string, re?: RegExp): string | undefined {
  const v = o[k];
  if (v === undefined) return undefined;
  if (typeof v !== "string" || !v) throw new Error(`${where}.${k} must be a non-empty string`);
  if (re && !re.test(v)) throw new Error(`${where}.${k} is not valid: ${JSON.stringify(v)}`);
  return v;
}

export function reqStr(o: Obj, k: string, where: string, re?: RegExp): string {
  const v = optStr(o, k, where, re);
  if (v === undefined) throw new Error(`${where}.${k} is required`);
  return v;
}

export function absPath(o: Obj, k: string, where: string): string {
  const v = reqStr(o, k, where);
  if (!isAbsolute(v)) throw new Error(`${where}.${k} must be an absolute path`);
  return v;
}

export function optBool(o: Obj, k: string, where: string): boolean | undefined {
  const v = o[k];
  if (v === undefined) return undefined;
  if (typeof v !== "boolean") throw new Error(`${where}.${k} must be true or false`);
  return v;
}

export function optCount(o: Obj, k: string, where: string): number | undefined {
  const v = o[k];
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw new Error(`${where}.${k} must be a number >= 0`);
  return v;
}

export function strList(o: Obj, k: string, where: string, re?: RegExp): string[] | undefined {
  const v = o[k];
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string" && x !== "" && (!re || re.test(x)))) throw new Error(`${where}.${k} must be an array of valid non-empty strings`);
  return [...(v as string[])];
}

/** An object of string values, keys checked with keyRe; built with fromEntries so "__proto__" is only a key. */
export function strMap(o: Obj, k: string, where: string, keyRe: RegExp, valueRe?: RegExp): Record<string, string> | undefined {
  const v = o[k];
  if (v === undefined) return undefined;
  if (!isObj(v)) throw new Error(`${where}.${k} must be an object`);
  const entries: [string, string][] = [];
  for (const [key, val] of Object.entries(v)) {
    if (!keyRe.test(key)) throw new Error(`${where}.${k}: key ${JSON.stringify(key)} is not valid`);
    if (typeof val !== "string" || !val || (valueRe && !valueRe.test(val))) throw new Error(`${where}.${k}[${JSON.stringify(key)}] is not valid`);
    entries.push([key, val]);
  }
  return Object.fromEntries(entries);
}
