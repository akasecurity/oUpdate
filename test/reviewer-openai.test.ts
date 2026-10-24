import { afterAll, describe, expect, test } from "bun:test";
import { openaiReviewer } from "../src/adapters/reviewer/openai.ts";

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
});
