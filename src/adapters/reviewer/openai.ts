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

// Plain http is only safe for a key when the request never leaves the machine.
const LOOPBACK = new Set(["localhost", "[::1]"]);
export function keySafeUrl(url: string): boolean {
  const u = new URL(url);
  return u.protocol !== "http:" || LOOPBACK.has(u.hostname) || /^127\.\d+\.\d+\.\d+$/.test(u.hostname);
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
          const url = chatUrl(base);
          if (key && !keySafeUrl(url)) {
            errors.push(`${base}: skipped, the ${cfg.apiKeyEnv} key is not sent over plain http to a non-loopback host (use https)`);
            continue;
          }
          const r = await fetch(url, {
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
            // keySafeUrl vets this URL only: a followed redirect would carry the key, or a credential in the
            // configured headers, on to wherever it points. Never followed, keyed or not.
            redirect: "manual",
          } as RequestInit);
          if (r.status >= 300 && r.status < 400) {
            errors.push(`${base}: redirect (${r.status}) not followed, the key and headers go only to the configured URL`);
            continue;
          }
          if (!r.ok) {
            errors.push(`${base}: ${r.status}`);
            continue;
          }
          const body = (await r.json()) as { choices?: { message?: { content?: string }; finish_reason?: string }[] };
          const choice = body.choices?.[0];
          if (!choice?.message) {
            errors.push(`${base}: no answer in the response`);
            continue;
          }
          // A cut-off answer can start APPROVE and lose the FLAG that followed; it is never a verdict.
          if (choice.finish_reason === "length") {
            errors.push(`${base}: answer truncated at max_tokens (${cfg.maxTokens ?? 4096})`);
            continue;
          }
          // A thinking model may put its reasoning ahead of the answer; line 1 must be the verdict.
          const text = (choice.message.content ?? "").replace(/^\s*<think>[\s\S]*?<\/think>\s*/, "");
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
