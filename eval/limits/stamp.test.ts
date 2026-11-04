import { expect, test } from "bun:test";
import type { ReviewerSpec } from "../../src/adapters/reviewer/spec.ts";
import { reviewerFingerprint } from "../../src/verdict-store.ts";
import { stampSpec, thinkingOf } from "./stamp.ts";

const NOW = new Date("2026-01-02T03:04:05Z");
const openai = (extra: Partial<Extract<ReviewerSpec, { type: "openai" }>> = {}): ReviewerSpec => ({ type: "openai", name: "r", baseUrls: ["https://example.test"], model: "m1", ...extra });

test("a stamp carries no base URL, header, expected header or key variable", () => {
  const spec = openai({
    baseUrls: ["https://SENTINEL-BASE-1.example.test/v1", "http://127.0.0.1:1/SENTINEL-BASE-2"],
    headers: { "x-api-key": "SENTINEL-HEADER-VALUE", "x-SENTINEL-HEADER-NAME": "v" },
    expectHeaders: { "x-served-by": "SENTINEL-SERVED-BY" },
    apiKeyEnv: "SENTINEL_KEY_ENV",
    timeoutMs: 1234,
    retryDelaysMs: [5678],
    maxTokens: 900,
    extraBody: { chat_template_kwargs: { enable_thinking: false } },
  });
  const stamp = stampSpec(spec, NOW);
  // The fingerprint is a hash; leave it out so a digit run in it cannot match a sentinel number.
  const text = JSON.stringify({ ...stamp, fingerprint: "" });
  for (const s of ["SENTINEL", "example.test", "127.0.0.1", "x-api-key", "x-served-by", "1234", "5678"]) expect(text).not.toContain(s);
  expect(Object.keys(stamp).sort()).toEqual(["at", "extraBody", "fingerprint", "maxTokens", "temperature", "type"]);
  expect(stamp).toEqual({ type: "openai", maxTokens: 900, temperature: 0, extraBody: { chat_template_kwargs: { enable_thinking: false } }, fingerprint: reviewerFingerprint(spec), at: "2026-01-02T03:04:05.000Z" });
});

test("extraBody is a deep copy and a temperature there is the one stamped", () => {
  const spec = openai({ extraBody: { temperature: 0.7, chat_template_kwargs: { enable_thinking: true } } });
  const stamp = stampSpec(spec, NOW);
  expect(stamp.temperature).toBe(0.7);
  (spec as { extraBody: { chat_template_kwargs: { enable_thinking: boolean } } }).extraBody.chat_template_kwargs.enable_thinking = false;
  expect(thinkingOf(stamp)).toBe("on");
  expect(stampSpec(openai(), NOW)).toEqual({ type: "openai", temperature: 0, fingerprint: reviewerFingerprint(openai()), at: "2026-01-02T03:04:05.000Z" });
});

test("thinking reads on, off and default from extraBody", () => {
  const t = (extraBody?: Record<string, unknown>) => thinkingOf(stampSpec(openai(extraBody ? { extraBody } : {}), NOW));
  expect(t({ chat_template_kwargs: { enable_thinking: true } })).toBe("on");
  expect(t({ chat_template_kwargs: { enable_thinking: false } })).toBe("off");
  expect(t({ chat_template_kwargs: { thinking: true } })).toBe("on");
  expect(t({ enable_thinking: false })).toBe("off");
  expect(t({ thinking: true })).toBe("on");
  expect(t({ thinking: false })).toBe("off");
  expect(t({ thinking: { type: "enabled", budget_tokens: 100 } })).toBe("on");
  expect(t({ thinking: { type: "disabled" } })).toBe("off");
  expect(t()).toBe("default");
  expect(t({})).toBe("default");
  expect(t({ chat_template_kwargs: { other: true } })).toBe("default");
  expect(t({ thinking: "maybe" })).toBe("default");
  expect(t({ chat_template_kwargs: "enable_thinking" })).toBe("default");
});

test("specs differing only in extraBody have different fingerprints and stamps", () => {
  const on = stampSpec(openai({ extraBody: { chat_template_kwargs: { enable_thinking: true } } }), NOW);
  const off = stampSpec(openai({ extraBody: { chat_template_kwargs: { enable_thinking: false } } }), NOW);
  expect(on.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  expect(on.fingerprint).not.toBe(off.fingerprint);
  expect(on).not.toEqual(off);
});

test("a command spec stamps only its type and fingerprint", () => {
  const spec: ReviewerSpec = { type: "command", name: "c", argv: ["SENTINEL-CMD", "--flag", "SENTINEL-ARG"], timeoutMs: 1234, workRoot: "/SENTINEL-ROOT" };
  const stamp = stampSpec(spec, NOW);
  expect(stamp).toEqual({ type: "command", fingerprint: reviewerFingerprint(spec), at: "2026-01-02T03:04:05.000Z" });
  expect(JSON.stringify(stamp)).not.toContain("SENTINEL");
  expect(thinkingOf(stamp)).toBe("default");
});
