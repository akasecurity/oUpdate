// The reviewer configuration a limits run used, written into its results so two runs can be compared without guessing.
// Results files are public: only settings that shape an answer are stamped. Where a reviewer is reached and with what
// credentials (base URLs, headers, expected response headers, key variable, work folder, command line) never are.

import type { ReviewerSpec } from "../../src/adapters/reviewer/spec.ts";
import { reviewerFingerprint } from "../../src/verdict-store.ts";

export interface ReviewerStamp {
  type: ReviewerSpec["type"];
  maxTokens?: number;
  temperature?: number;
  extraBody?: Record<string, unknown>;
  /** reviewerFingerprint of the spec: a hash of the answer-shaping settings, the command line included. */
  fingerprint: string;
  /** ISO time the stamp was taken. */
  at: string;
}

export function stampSpec(spec: ReviewerSpec, now = new Date()): ReviewerStamp {
  const fingerprint = reviewerFingerprint(spec);
  const at = now.toISOString();
  if (spec.type !== "openai") return { type: spec.type, fingerprint, at };
  const extraBody = spec.extraBody === undefined ? undefined : structuredClone(spec.extraBody);
  // The adapter sends temperature 0, and extraBody is spread after it, so a temperature there is the one sent.
  const temperature = typeof extraBody?.temperature === "number" ? extraBody.temperature : 0;
  return {
    type: spec.type,
    ...(spec.maxTokens !== undefined ? { maxTokens: spec.maxTokens } : {}),
    temperature,
    ...(extraBody !== undefined ? { extraBody } : {}),
    fingerprint,
    at,
  };
}

const onOff = (v: unknown): "on" | "off" | undefined => {
  if (v === true || v === "enabled") return "on";
  if (v === false || v === "disabled") return "off";
  if (v && typeof v === "object" && !Array.isArray(v)) return onOff((v as { type?: unknown }).type);
  return undefined;
};

/** Whether the run asked for thinking: a chat-template switch (chat_template_kwargs.enable_thinking or .thinking) or a top-level enable_thinking / thinking flag. Anything else is the server's default. */
export function thinkingOf(stamp: Pick<ReviewerStamp, "extraBody">): "on" | "off" | "default" {
  const b = stamp.extraBody;
  if (!b) return "default";
  const kw = b.chat_template_kwargs as Record<string, unknown> | undefined;
  const isObj = !!kw && typeof kw === "object" && !Array.isArray(kw);
  return (isObj ? onOff(kw.enable_thinking) ?? onOff(kw.thinking) : undefined) ?? onOff(b.enable_thinking) ?? onOff(b.thinking) ?? "default";
}
