import { expect, test } from "bun:test";
import type { ReviewerSpec } from "../../src/adapters/reviewer/spec.ts";
import { DEFAULT_MAX_TOKENS, DEFAULT_TEMPERATURE } from "../../src/adapters/reviewer/openai.ts";
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
  expect(stamp).toEqual({ type: "openai", maxTokens: 900, temperature: 0, extraBody: { chat_template_kwargs: { enable_thinking: false } }, fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/), at: "2026-01-02T03:04:05.000Z" });
});

test("extraBody is a deep copy and a temperature there is the one stamped", () => {
  const spec = openai({ extraBody: { temperature: 0.7, chat_template_kwargs: { enable_thinking: true } } });
  const stamp = stampSpec(spec, NOW);
  expect(stamp.temperature).toBe(0.7);
  (spec as { extraBody: { chat_template_kwargs: { enable_thinking: boolean } } }).extraBody.chat_template_kwargs.enable_thinking = false;
  expect(thinkingOf(stamp)).toBe("on");
  expect(stampSpec(openai(), NOW)).toEqual({ type: "openai", maxTokens: DEFAULT_MAX_TOKENS, temperature: DEFAULT_TEMPERATURE, fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/), at: "2026-01-02T03:04:05.000Z" });
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

test("thinking also reads think, reasoning_effort and reasoning.effort, after the earlier switches", () => {
  const t = (extraBody: Record<string, unknown>) => thinkingOf(stampSpec(openai({ extraBody }), NOW));
  expect(t({ think: true })).toBe("on");
  expect(t({ think: false })).toBe("off");
  expect(t({ think: "yes" })).toBe("default");
  expect(t({ reasoning_effort: "high" })).toBe("on");
  expect(t({ reasoning_effort: "low" })).toBe("on");
  expect(t({ reasoning_effort: "none" })).toBe("off");
  expect(t({ reasoning_effort: "off" })).toBe("off");
  expect(t({ reasoning_effort: "" })).toBe("default");
  expect(t({ reasoning_effort: 3 })).toBe("default");
  expect(t({ reasoning: { effort: "medium" } })).toBe("on");
  expect(t({ reasoning: { effort: "none" } })).toBe("off");
  expect(t({ reasoning: { summary: "auto" } })).toBe("default");
  expect(t({ reasoning: "high" })).toBe("default");
  // Earlier switches win: the chat template first, then enable_thinking / thinking, then think, reasoning_effort, reasoning.
  expect(t({ chat_template_kwargs: { enable_thinking: false }, think: true, reasoning_effort: "high" })).toBe("off");
  expect(t({ enable_thinking: true, think: false })).toBe("on");
  expect(t({ think: false, reasoning_effort: "high" })).toBe("off");
  expect(t({ reasoning_effort: "none", reasoning: { effort: "high" } })).toBe("off");
});

test("max tokens is the one sent: an extraBody number, else the spec, else the adapter default", () => {
  expect(stampSpec(openai({ maxTokens: 900, extraBody: { max_tokens: 2000 } }), NOW).maxTokens).toBe(2000);
  expect(stampSpec(openai({ extraBody: { max_tokens: 2000 } }), NOW).maxTokens).toBe(2000);
  expect(stampSpec(openai({ maxTokens: 900, extraBody: { max_tokens: "lots" } }), NOW).maxTokens).toBe("set in extraBody");
  expect(stampSpec(openai({ maxTokens: 900 }), NOW).maxTokens).toBe(900);
  expect(stampSpec(openai(), NOW).maxTokens).toBe(DEFAULT_MAX_TOKENS);
});

test("a temperature in extraBody that is not a number is stamped as set there", () => {
  expect(stampSpec(openai({ extraBody: { temperature: "0.5" } }), NOW).temperature).toBe("set in extraBody");
  expect(stampSpec(openai({ extraBody: { temperature: null } }), NOW).temperature).toBe("set in extraBody");
  expect(stampSpec(openai({ extraBody: { temperature: 0.3 } }), NOW).temperature).toBe(0.3);
  expect(stampSpec(openai({ extraBody: { top_p: 0.9 } }), NOW).temperature).toBe(DEFAULT_TEMPERATURE);
});

test("extraBody is stamped through an allowlist: a model or any other key is never copied", () => {
  const spec = openai({
    extraBody: {
      model: "SENTINEL-MODEL-OVERRIDE",
      api_token: "SENTINEL-SECRET-abc123",
      chat_template_kwargs: { enable_thinking: true, system_prompt: "SENTINEL-KWARG" },
      reasoning: { effort: "high", type: "enabled", summary: "SENTINEL-SUMMARY" },
      top_p: 0.9,
      seed: 7,
      stop: ["SENTINEL-STOP"],
      reasoning_effort: "x".repeat(41),
    },
  });
  const stamp = stampSpec(spec, NOW);
  const text = JSON.stringify({ ...stamp, fingerprint: "" });
  for (const s of ["SENTINEL", "model", "api_token", "system_prompt", "summary", "stop", "xxxxx"]) expect(text).not.toContain(s);
  expect(stamp.extraBody).toEqual({ chat_template_kwargs: { enable_thinking: true }, reasoning: { effort: "high", type: "enabled" }, top_p: 0.9, seed: 7 });
  // model, api_token, stop and the reasoning_effort that is not a setting word are dropped top-level keys.
  expect(stamp.extraBodyOmitted).toBe(4);
  // The fingerprint hashes only the stamped fields: a different model id or name gives the same one, so a guessed model cannot be confirmed from it.
  const same = (x: Partial<Extract<ReviewerSpec, { type: "openai" }>>) => stampSpec(openai({ extraBody: { top_p: 0.9 }, ...x }), NOW);
  expect(same({ model: "other-model" }).fingerprint).toBe(same({}).fingerprint);
  expect(same({ name: "other-name" }).fingerprint).toBe(same({}).fingerprint);
  expect(same({}).fingerprint).toBe(stampSpec(openai({ extraBody: { top_p: 0.9 } }), NOW).fingerprint);
  expect(same({ extraBody: { top_p: 0.5 } }).fingerprint).not.toBe(same({}).fingerprint);
});

test("a chat_template_kwargs with an extra key is reduced to its thinking switches", () => {
  const stamp = stampSpec(openai({ extraBody: { chat_template_kwargs: { enable_thinking: false, thinking: true, documents: ["d"], custom: 1 } } }), NOW);
  expect(stamp.extraBody).toEqual({ chat_template_kwargs: { enable_thinking: false, thinking: true } });
  expect("extraBodyOmitted" in stamp).toBe(false);
});

test("a thinking object is reduced to its type and budget", () => {
  const stamp = stampSpec(openai({ extraBody: { thinking: { type: "enabled", budget_tokens: 100, note: "n" } } }), NOW);
  expect(stamp.extraBody).toEqual({ thinking: { type: "enabled", budget_tokens: 100 } });
  expect(thinkingOf(stamp)).toBe("on");
});

test("extraBodyOmitted counts dropped top-level keys and is absent when none are", () => {
  expect(stampSpec(openai({ extraBody: { model: "m2" } }), NOW).extraBodyOmitted).toBe(1);
  expect(stampSpec(openai({ extraBody: { model: "m2" } }), NOW).extraBody).toBeUndefined();
  expect(stampSpec(openai({ extraBody: { a: 1, b: { c: 2 }, top_k: 40 } }), NOW)).toMatchObject({ extraBody: { top_k: 40 }, extraBodyOmitted: 2 });
  expect(stampSpec(openai({ extraBody: { top_k: 40, min_p: 0.05 } }), NOW).extraBodyOmitted).toBeUndefined();
  expect(stampSpec(openai(), NOW).extraBodyOmitted).toBeUndefined();
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
  expect(stamp).toEqual({ type: "command", fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/), at: "2026-01-02T03:04:05.000Z" });
  expect(JSON.stringify(stamp)).not.toContain("SENTINEL");
  expect(thinkingOf(stamp)).toBe("default");
});

test("a short free string under an allowed key is dropped: only setting words are stamped", () => {
  const stamp = stampSpec(openai({ extraBody: { reasoning_effort: "sk-live-ZZZZ1234567890", thinking: { type: "dev@host.example" }, top_p: 0.9, max_completion_tokens: 500 } }), NOW);
  const text = JSON.stringify({ ...stamp, fingerprint: "" });
  expect(text).not.toContain("sk-live");
  expect(text).not.toContain("dev@host");
  expect(stamp.extraBody).toEqual({ top_p: 0.9, max_completion_tokens: 500 });
  expect(stamp.extraBodyOmitted).toBe(2);
});

test("a number under a word key and a word under a numeric key are dropped", () => {
  const stamp = stampSpec(openai({ extraBody: { reasoning_effort: 5, top_p: "high", temperature: 0.2, seed: true } }), NOW);
  expect(stamp.extraBody).toEqual({ temperature: 0.2 });
  expect(stamp.extraBodyOmitted).toBe(3);
});

test("the same settings in another key order give the same fingerprint", () => {
  const a = stampSpec(openai({ extraBody: { top_p: 0.9, seed: 7, chat_template_kwargs: { enable_thinking: true } } }), NOW);
  const b = stampSpec(openai({ extraBody: { chat_template_kwargs: { enable_thinking: true }, seed: 7, top_p: 0.9 } }), NOW);
  expect(a.fingerprint).toBe(b.fingerprint);
});

test("thinking reads every setting word the stamp keeps, in any case", () => {
  const t = (extraBody: Record<string, unknown>) => thinkingOf(stampSpec(openai({ extraBody }), NOW));
  expect(t({ chat_template_kwargs: { enable_thinking: "off" } })).toBe("off");
  expect(t({ think: "off" })).toBe("off");
  expect(t({ enable_thinking: "False" })).toBe("off");
  expect(t({ thinking: "Enabled" })).toBe("on");
  expect(t({ think: "true" })).toBe("on");
});
