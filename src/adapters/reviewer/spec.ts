// Reviewer specs as they appear in config or on the command line.

import type { Reviewer } from "../../review.ts";
import { commandReviewer, type CommandReviewerConfig } from "./command.ts";
import { openaiReviewer, type OpenAIReviewerConfig } from "./openai.ts";

export type ReviewerSpec = ({ type: "command" } & CommandReviewerConfig) | ({ type: "openai" } & OpenAIReviewerConfig);

const isStrArray = (v: unknown): v is string[] => Array.isArray(v) && v.length > 0 && v.every((s) => typeof s === "string");
const isStrMap = (v: unknown): v is Record<string, string> => !!v && typeof v === "object" && !Array.isArray(v) && Object.values(v).every((s) => typeof s === "string");

// Same refusal as apply/config.ts and targets/strict.ts. expectHeaders and retryDelaysMs are accepted ahead of the code that reads them, so that merge does not refuse a config that already sets them.
const COMMAND_KEYS = ["type", "name", "argv", "timeoutMs", "workRoot"];
const OPENAI_KEYS = ["type", "name", "baseUrls", "model", "apiKeyEnv", "maxTokens", "timeoutMs", "extraBody", "headers", "expectHeaders", "retryDelaysMs"];

function refuseUnknown(o: Record<string, unknown>, block: string, keys: readonly string[]): void {
  for (const k of Object.keys(o)) if (!keys.includes(k)) throw new Error(`${block}: unknown key ${k} (valid keys: ${keys.join(", ")})`);
}

export function validateReviewerSpec(v: unknown): ReviewerSpec {
  if (!v || typeof v !== "object") throw new Error("reviewer spec must be a JSON object");
  const o = v as Record<string, unknown>;
  if (o.type === "command") refuseUnknown(o, "command reviewer", COMMAND_KEYS);
  else if (o.type === "openai") refuseUnknown(o, "openai reviewer", OPENAI_KEYS);
  if (typeof o.name !== "string" || !o.name) {
    if (o.type !== "command" && o.type !== "openai") throw new Error(`reviewer type must be command or openai, got ${String(o.type)}`);
    throw new Error("reviewer spec needs a name");
  }
  if (o.type === "command") {
    if (!isStrArray(o.argv)) throw new Error("command reviewer needs argv: a non-empty string array");
    return o as unknown as ReviewerSpec;
  }
  if (o.type === "openai") {
    if (!isStrArray(o.baseUrls) || typeof o.model !== "string") throw new Error("openai reviewer needs baseUrls (string array) and model");
    if (o.expectHeaders !== undefined && !isStrMap(o.expectHeaders)) throw new Error("openai reviewer expectHeaders must be an object of string to string");
    return o as unknown as ReviewerSpec;
  }
  throw new Error(`reviewer type must be command or openai, got ${String(o.type)}`);
}

export function parseReviewerSpec(json: string): ReviewerSpec {
  let v: unknown;
  try {
    v = JSON.parse(json);
  } catch {
    throw new Error("--reviewer must be JSON");
  }
  return validateReviewerSpec(v);
}

export function makeReviewer(spec: ReviewerSpec): Reviewer {
  return spec.type === "command" ? commandReviewer(spec) : openaiReviewer(spec);
}
