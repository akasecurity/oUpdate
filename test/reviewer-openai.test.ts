import { afterAll, describe, expect, test } from "bun:test";
import { openaiReviewer } from "../src/adapters/reviewer/openai.ts";
import { reviewUpdate } from "../src/review.ts";

const seen: { auth: string | null; nofb: string | null; body: any }[] = [];
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const body = await req.json();
    seen.push({ auth: req.headers.get("authorization"), nofb: req.headers.get("x-no-fallback"), body });
    if (url.pathname === "/down/v1/chat/completions") return new Response("no", { status: 503 });
    if (url.pathname !== "/v1/chat/completions") return new Response("not found", { status: 404 });
    if (body.model === "think") return Response.json({ choices: [{ message: { content: "<think>\nmaybe FLAG? no.\n</think>\n\nAPPROVE\nno attack indicators found" } }] });
    if (body.model === "only-think") return Response.json({ choices: [{ message: { content: "<think>\nhmm\n</think>\n" } }] });
    if (body.model === "truncated") return Response.json({ choices: [{ message: { content: "APPROVE\nno attack indicators found in the first half of" }, finish_reason: "length" }] });
    if (body.model === "no-choices") return Response.json({ choices: [] });
    if (body.model === "no-message") return Response.json({ choices: [{ finish_reason: "stop" }] });
    if (body.model === "empty") return Response.json({ choices: [{ message: { content: "" } }] });
    return Response.json({ choices: [{ message: { content: "APPROVE\nno attack indicators found" } }] });
  },
});
afterAll(() => server.stop(true));
const base = `http://127.0.0.1:${server.port}`;

describe("openaiReviewer", () => {
  test("posts the prompt as one user message with model, max_tokens and extra body", async () => {
    process.env.OUPDATE_TEST_KEY = "k-123";
    const r = openaiReviewer({ name: "local", baseUrls: [base], model: "m1", apiKeyEnv: "OUPDATE_TEST_KEY", maxTokens: 900, extraBody: { chat_template_kwargs: { enable_thinking: true } } });
    expect(await r.review("hello")).toBe("APPROVE\nno attack indicators found");
    const last = seen.at(-1)!;
    expect(last.auth).toBe("Bearer k-123");
    expect(last.body).toMatchObject({ model: "m1", max_tokens: 900, messages: [{ role: "user", content: "hello" }], chat_template_kwargs: { enable_thinking: true } });
  });

  test("a base URL given with /v1 (as OpenAI clients take it) is not doubled to /v1/v1", async () => {
    for (const b of [`${base}/v1`, `${base}/v1/`, `${base}/`]) {
      const r = openaiReviewer({ name: "local", baseUrls: [b], model: "m1" });
      expect(await r.review("hello")).toBe("APPROVE\nno attack indicators found");
    }
  });
  test("a base URL is trimmed, /V1 is case-insensitive, and a query string stays after the path", async () => {
    for (const b of [` ${base}/V1/ `, `${base}/v1?x=1`, `${base}?x=1`]) {
      const r = openaiReviewer({ name: "local", baseUrls: [b], model: "m1" });
      expect(await r.review("hello")).toBe("APPROVE\nno attack indicators found");
    }
  });
  test("falls through to the next base URL on an error status", async () => {
    const r = openaiReviewer({ name: "local", baseUrls: [`${base}/down`, base], model: "m1" });
    expect(await r.review("x")).toContain("APPROVE");
  });

  test("an empty answer is an error, not a verdict", async () => {
    const r = openaiReviewer({ name: "local", baseUrls: [base], model: "empty" });
    await expect(r.review("x")).rejects.toThrow(/empty/);
  });

  test("every base failing throws with each reason", async () => {
    const r = openaiReviewer({ name: "local", baseUrls: [`${base}/down`], model: "m1" });
    await expect(r.review("x")).rejects.toThrow(/503/);
  });

  test("sends extra headers (x-no-fallback for a security gate)", async () => {
    const r = openaiReviewer({ name: "local", baseUrls: [base], model: "m1", headers: { "x-no-fallback": "1" } });
    await r.review("x");
    expect(seen.at(-1)!.nofb).toBe("1");
  });

  test("a leading <think> block is dropped so line 1 is the verdict", async () => {
    const r = openaiReviewer({ name: "local", baseUrls: [base], model: "think" });
    expect(await r.review("x")).toBe("APPROVE\nno attack indicators found");
  });

  test("an answer that is only a <think> block is empty, an error", async () => {
    const r = openaiReviewer({ name: "local", baseUrls: [base], model: "only-think" });
    await expect(r.review("x")).rejects.toThrow(/empty/);
  });

  test("a truncated answer (finish_reason length) is an error, not a verdict", async () => {
    const r = openaiReviewer({ name: "local", baseUrls: [base], model: "truncated" });
    await expect(r.review("x")).rejects.toThrow(/truncated/);
  });

  test("a missing choice or message is an error, not a verdict", async () => {
    for (const model of ["no-choices", "no-message"]) {
      const r = openaiReviewer({ name: "local", baseUrls: [base], model });
      await expect(r.review("x")).rejects.toThrow(/no answer|empty/);
    }
  });

  test("a truncated APPROVE holds the update end to end through the verdict path", async () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    const files = (o: Record<string, string>) => new Map(Object.entries(o).map(([k, v]) => [k, enc(v)]));
    const now = new Date("2026-10-21T18:00:00Z");
    const res = await reviewUpdate({
      eco: "pypi",
      name: "pkg",
      from: "1.0.0",
      to: "1.0.1",
      registry: { latest: async () => undefined, publishedAt: async () => new Date(now.getTime() - 30 * 86_400_000), artifactUrls: async (_n, v) => [`https://files.example/${v}`] },
      advisories: { query: async () => [] },
      reviewer: openaiReviewer({ name: "local", baseUrls: [base], model: "truncated" }),
      cooldownDays: 7,
      now,
      loadArtifacts: async () => ({ old: files({ "a.py": "x = 1\n" }), new: files({ "a.py": "x = 2\n" }) }),
    });
    expect(res.decision).toBe("hold");
    expect(res.layers.find((l) => l.layer === "reviewer")).toMatchObject({ verdict: "error" });
    expect(res.layers.find((l) => l.layer === "reviewer")!.detail).toMatch(/truncated/);
  });
});

describe("openaiReviewer API key transport", () => {
  const realFetch = globalThis.fetch;
  afterAll(() => {
    globalThis.fetch = realFetch;
  });
  // Records what would go on the wire for non-loopback hosts the test cannot serve.
  function spyFetch() {
    const sent: { url: string; auth: string | null }[] = [];
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      sent.push({ url: String(url), auth: new Headers(init.headers).get("authorization") });
      return Response.json({ choices: [{ message: { content: "APPROVE\nno attack indicators found" }, finish_reason: "stop" }] });
    }) as typeof fetch;
    return sent;
  }

  test("a configured key is never sent to a plain http URL on a non-loopback host; that URL is skipped with a clear error", async () => {
    process.env.OUPDATE_TEST_KEY = "k-123";
    const sent = spyFetch();
    try {
      const r = openaiReviewer({ name: "cloud", baseUrls: ["http://primary.example:8080/v1", "http://10.0.0.5/v1"], model: "m1", apiKeyEnv: "OUPDATE_TEST_KEY" });
      await expect(r.review("x")).rejects.toThrow(/not sent over plain http/);
      expect(sent).toEqual([]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("with a key, a plain http fallback is skipped and the https or loopback URLs still get it", async () => {
    process.env.OUPDATE_TEST_KEY = "k-123";
    const sent = spyFetch();
    try {
      const r = openaiReviewer({ name: "cloud", baseUrls: ["http://primary.example/v1", "https://api.example/v1"], model: "m1", apiKeyEnv: "OUPDATE_TEST_KEY" });
      expect(await r.review("x")).toContain("APPROVE");
      expect(sent).toEqual([{ url: "https://api.example/v1/chat/completions", auth: "Bearer k-123" }]);
      for (const loop of ["http://127.0.0.1:8080/v1", "http://localhost:8080/v1", "http://[::1]:8080/v1"]) {
        sent.length = 0;
        const l = openaiReviewer({ name: "local", baseUrls: [loop], model: "m1", apiKeyEnv: "OUPDATE_TEST_KEY" });
        expect(await l.review("x")).toContain("APPROVE");
        expect(sent[0]!.auth).toBe("Bearer k-123");
      }
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  // Adversarial read 0.2.3 (Opus L5): keySafeUrl checks only the first URL; a followed redirect (https to http, or
  // to another host) would carry the key on. With a key a redirect is an error, never followed.
  test("with a key, a redirect is an error and the target never sees the request", async () => {
    process.env.OUPDATE_TEST_KEY = "k-123";
    const hits: (string | null)[] = [];
    const target = Bun.serve({ port: 0, fetch: (req) => (hits.push(req.headers.get("authorization")), Response.json({ choices: [{ message: { content: "APPROVE\nok" } }] })) });
    const hop = Bun.serve({ port: 0, fetch: () => new Response(null, { status: 307, headers: { location: `http://127.0.0.1:${target.port}/v1/chat/completions` } }) });
    try {
      const r = openaiReviewer({ name: "cloud", baseUrls: [`http://127.0.0.1:${hop.port}/v1`], model: "m1", apiKeyEnv: "OUPDATE_TEST_KEY" });
      await expect(r.review("x")).rejects.toThrow(/redirect.*not followed/);
      expect(hits).toEqual([]);
    } finally {
      hop.stop(true);
      target.stop(true);
    }
  });
  test("without a key a redirect is an error too: headers from the config never follow it", async () => {
    delete process.env.OUPDATE_TEST_KEY;
    const hits: (string | null)[] = [];
    const target = Bun.serve({ port: 0, fetch: (req) => (hits.push(req.headers.get("x-api-key")), Response.json({ choices: [{ message: { content: "APPROVE\nok" } }] })) });
    const hop = Bun.serve({ port: 0, fetch: () => new Response(null, { status: 302, headers: { location: `http://127.0.0.1:${target.port}/v1/chat/completions` } }) });
    try {
      const r = openaiReviewer({ name: "lan", baseUrls: [`http://127.0.0.1:${hop.port}/v1`], model: "m1", headers: { "x-api-key": "h-456" } });
      await expect(r.review("x")).rejects.toThrow(/redirect \(302\) not followed/);
      expect(hits).toEqual([]);
    } finally {
      hop.stop(true);
      target.stop(true);
    }
  });

  test("keyless plain http to a non-loopback host still works (no credential to leak)", async () => {
    const sent = spyFetch();
    try {
      const r = openaiReviewer({ name: "lan", baseUrls: ["http://gpu.lan:8080/v1"], model: "m1" });
      expect(await r.review("x")).toContain("APPROVE");
      expect(sent).toEqual([{ url: "http://gpu.lan:8080/v1/chat/completions", auth: null }]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
