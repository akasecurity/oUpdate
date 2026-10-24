// Scanner specs as they appear in config or on the command line.

import type { Scanner } from "../../review.ts";
import { guarddogScanner, type GuardDogScannerConfig } from "./guarddog.ts";

export type ScannerSpec = { type: "guarddog" } & GuardDogScannerConfig;

export function validateScannerSpec(v: unknown): ScannerSpec {
  if (!v || typeof v !== "object") throw new Error("scanner spec must be a JSON object");
  const o = v as Record<string, unknown>;
  if (o.type !== "guarddog") throw new Error(`scanner type must be guarddog, got ${String(o.type)}`);
  if (typeof o.name !== "string" || !o.name) throw new Error("scanner spec needs a name");
  if (!Array.isArray(o.argv) || !o.argv.length || !o.argv.every((s) => typeof s === "string")) throw new Error("guarddog scanner needs argv: a non-empty string array");
  for (const k of ["workRoot", "stripPrefix"]) if (o[k] !== undefined && typeof o[k] !== "string") throw new Error(`scanner ${k} must be a string`);
  if (o.timeoutMs !== undefined && (typeof o.timeoutMs !== "number" || !(o.timeoutMs > 0))) throw new Error("scanner timeoutMs must be a number > 0");
  return o as unknown as ScannerSpec;
}

export function parseScannerSpec(json: string): ScannerSpec {
  let v: unknown;
  try {
    v = JSON.parse(json);
  } catch {
    throw new Error("--scanner must be JSON");
  }
  return validateScannerSpec(v);
}

export function makeScanner(spec: ScannerSpec): Scanner {
  return guarddogScanner(spec);
}
