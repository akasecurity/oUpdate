// Reviewer over any OpenAI-compatible /v1/chat/completions endpoint (a local
// model server, a router, or a hosted API). Base URLs are tried in order.

import type { Reviewer } from "../../review.ts";

export interface OpenAIReviewerConfig {
  name: string;
  baseUrls: string[];
  model: string;
  apiKeyEnv?: string;
  maxTokens?: number;
  timeoutMs?: number;
  extraBody?: Record<string, unknown>;
  headers?: Record<string, string>;
}

// Base URL (trimmed, with or without /v1 in any case) to the chat endpoint; a query string stays after the path.
export function chatUrl(base: string): string {
  const u = new URL(base.trim());
  u.pathname = `${u.pathname.replace(/\/+$/, "").replace(/\/v1$/i, "")}/v1/chat/completions`;
  return u.toString();
}

export function openaiReviewer(cfg: OpenAIReviewerConfig): Reviewer {
  return {
    name: cfg.name,
    async review(prompt) {
      const key = cfg.apiKeyEnv ? process.env[cfg.apiKeyEnv] : undefined;
      const errors: string[] = [];
      for (const base of cfg.baseUrls) {
        try {
          // A base is taken with or without its /v1, as OpenAI clients take it.
          const r = await fetch(chatUrl(base), {
            method: "POST",
            headers: { "content-type": "application/json", ...cfg.headers, ...(key ? { authorization: `Bearer ${key}` } : {}) },
            body: JSON.stringify({
              model: cfg.model,
              max_tokens: cfg.maxTokens ?? 4096,
              temperature: 0,
              messages: [{ role: "user", content: prompt }],
              ...cfg.extraBody,
            }),
            signal: AbortSignal.timeout(cfg.timeoutMs ?? 900_000),
            // Bun's fetch has its own 300 s default; slow local models need the signal alone.
            timeout: false,
          } as RequestInit);
          if (!r.ok) {
            errors.push(`${base}: ${r.status}`);
            continue;
          }
          const body = (await r.json()) as { choices?: { message?: { content?: string } }[] };
          // A thinking model may put its reasoning ahead of the answer; line 1 must be the verdict.
          const text = (body.choices?.[0]?.message?.content ?? "").replace(/^\s*<think>[\s\S]*?<\/think>\s*/, "");
          if (!text.trim()) {
            errors.push(`${base}: empty answer`);
            continue;
          }
          return text;
        } catch (e) {
          errors.push(`${base}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      throw new Error(`reviewer ${cfg.name} failed: ${errors.join("; ")}`);
    },
  };
}
