// The reviewer configuration a limits run used, written into its results so two runs can be compared without guessing.
// Results files are public: only settings that shape an answer are stamped. Where a reviewer is reached and with what
// credentials (base URLs, headers, expected response headers, key variable, work folder, command line) never are.

import { DEFAULT_MAX_TOKENS, DEFAULT_TEMPERATURE } from "../../src/adapters/reviewer/openai.ts";
import type { ReviewerSpec } from "../../src/adapters/reviewer/spec.ts";

export interface ReviewerStamp {
  type: ReviewerSpec["type"];
  /** The max_tokens sent: an extraBody number, else the spec's, else the adapter default. */
  maxTokens?: number | "set in extraBody";
  /** The temperature sent; "set in extraBody" when extraBody sets one that is not a number. */
  temperature?: number | "set in extraBody";
  /** The allowlisted part of extraBody (sampling and thinking settings); every other key is dropped. */
  extraBody?: Record<string, unknown>;
  /** How many top-level extraBody keys were dropped; absent when none were. */
  extraBodyOmitted?: number;
  /** A hash of exactly the public fields above (so two runs with the same stamped settings match), never of the model id, command line or any dropped key: a guessed model name cannot be checked against it. */
  fingerprint: string;
  /** ISO time the stamp was taken. */
  at: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

// A stamped value is checked per key: numbers only where the setting is numeric, booleans only where it is a switch, and
// strings only from a closed set of setting words, so free text (a token, an address) never reaches a public file.
const NUMERIC = new Set(["temperature", "top_p", "top_k", "min_p", "presence_penalty", "frequency_penalty", "repetition_penalty", "seed", "max_tokens", "max_completion_tokens", "budget_tokens"]);
const SWITCH = new Set(["enable_thinking", "think", "thinking"]);
const WORDS = new Set(["on", "off", "enabled", "disabled", "true", "false", "none", "minimal", "low", "medium", "high"]);
const WORD_KEYS = new Set(["enable_thinking", "think", "thinking", "reasoning_effort", "effort", "type"]);
const scalar = (key: string, v: unknown): boolean =>
  (typeof v === "number" && Number.isFinite(v) && NUMERIC.has(key)) || (typeof v === "boolean" && SWITCH.has(key)) || (typeof v === "string" && WORD_KEYS.has(key) && WORDS.has(v.toLowerCase()));

// Top-level keys stamped as plain values.
const PLAIN = ["enable_thinking", "think", "reasoning_effort", "temperature", "max_tokens", "top_p", "top_k", "min_p", "presence_penalty", "frequency_penalty", "repetition_penalty", "seed", "max_completion_tokens"];
// Top-level keys whose object value is reduced to the listed entries.
const NESTED: Record<string, string[]> = { chat_template_kwargs: ["enable_thinking", "thinking"], reasoning: ["effort", "type"], thinking: ["type", "budget_tokens"] };

// The stamped value of one top-level entry, or undefined to drop it.
function allowed(key: string, v: unknown): unknown {
  const nested = Object.hasOwn(NESTED, key);
  if (nested && isObj(v)) {
    const kept = Object.fromEntries(NESTED[key]!.filter((k) => scalar(k, v[k])).map((k) => [k, v[k]]));
    return Object.keys(kept).length ? kept : undefined;
  }
  return (nested || PLAIN.includes(key)) && scalar(key, v) ? v : undefined;
}

// extraBody is free-form and results are public, so only the allowlist is copied, never the rest (a model, a token).
function reduceExtraBody(body: Record<string, unknown>): { extraBody?: Record<string, unknown>; omitted: number } {
  const kept: Record<string, unknown> = {};
  let omitted = 0;
  for (const [k, v] of Object.entries(body)) {
    const a = allowed(k, v);
    if (a === undefined) omitted++;
    else kept[k] = a;
  }
  return { ...(Object.keys(kept).length ? { extraBody: kept } : {}), omitted };
}

// Keys sorted at every level, so the same settings listed in another order hash the same.
const canon = (v: unknown): unknown => (Array.isArray(v) ? v.map(canon) : isObj(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => [k, canon(x)])) : v);
const hashOf = (v: unknown): string => new Bun.CryptoHasher("sha256").update(JSON.stringify(canon(v))).digest("hex");

export function stampSpec(spec: ReviewerSpec, now = new Date()): ReviewerStamp {
  const at = now.toISOString();
  if (spec.type !== "openai") return { type: spec.type, fingerprint: hashOf({ type: spec.type }), at };
  const body = spec.extraBody ?? {};
  // The adapter spreads extraBody after max_tokens and temperature, so a value there is the one sent.
  const maxTokens = Object.hasOwn(body, "max_tokens") ? (typeof body.max_tokens === "number" ? body.max_tokens : "set in extraBody" as const) : spec.maxTokens ?? DEFAULT_MAX_TOKENS;
  const temperature = typeof body.temperature === "number" ? body.temperature : Object.hasOwn(body, "temperature") ? "set in extraBody" as const : DEFAULT_TEMPERATURE;
  const { extraBody, omitted } = reduceExtraBody(body);
  const shown = { type: spec.type, maxTokens, temperature, ...(extraBody !== undefined ? { extraBody } : {}), ...(omitted ? { extraBodyOmitted: omitted } : {}) };
  return { ...shown, fingerprint: hashOf(shown), at };
}

// Every word the stamp keeps under a switch key reads here, in any case: on, enabled, true / off, disabled, false.
const onOff = (v: unknown): "on" | "off" | undefined => {
  const w = typeof v === "string" ? v.toLowerCase() : v;
  if (w === true || w === "enabled" || w === "on" || w === "true") return "on";
  if (w === false || w === "disabled" || w === "off" || w === "false") return "off";
  if (isObj(v)) return onOff(v.type);
  return undefined;
};

const bool = onOff;

// A reasoning effort of "none" or "off" turns thinking off; any other non-empty string asks for it.
const effort = (v: unknown): "on" | "off" | undefined => {
  if (typeof v !== "string" || !v) return undefined;
  return ["none", "off"].includes(v.toLowerCase()) ? "off" : "on";
};

/** Whether the run asked for thinking, first switch found wins: chat_template_kwargs.enable_thinking or .thinking, a top-level enable_thinking or thinking flag, think, reasoning_effort, then reasoning.effort. Anything else is the server's default. */
export function thinkingOf(stamp: Pick<ReviewerStamp, "extraBody">): "on" | "off" | "default" {
  const b = stamp.extraBody;
  if (!b) return "default";
  const kw = isObj(b.chat_template_kwargs) ? b.chat_template_kwargs : undefined;
  return (kw ? onOff(kw.enable_thinking) ?? onOff(kw.thinking) : undefined)
    ?? onOff(b.enable_thinking) ?? onOff(b.thinking) ?? bool(b.think) ?? effort(b.reasoning_effort)
    ?? (isObj(b.reasoning) ? effort(b.reasoning.effort) : undefined) ?? "default";
}
