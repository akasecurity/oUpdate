import { afterAll, describe, expect, test } from "bun:test";
import { openaiReviewer } from "../src/adapters/reviewer/openai.ts";

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const body = (await req.json()) as { model: string };
    const headers: Record<string, string> = body.model === "bare" ? {} : { "x-served-by": body.model === "fallback" ? "other-model" : body.model };
    if (body.model === "fail") return new Response("no", { status: 500, headers });
    return Response.json({ choices: [{ message: { content: "APPROVE\nno attack indicators found" } }] }, { headers });
  },
});
afterAll(() => server.stop(true));
const base = `http://127.0.0.1:${server.port}`;
const make = (model: string, servedByHeader: string | null = "x-served-by") => openaiReviewer({ name: "local", baseUrls: [base], model, retryDelaysMs: [], ...(servedByHeader ? { servedByHeader } : {}) });

describe("openaiReviewer served-by", () => {
  test("reports the router's served-by header of the latest answer", async () => {
    const r = make("m1");
    expect(r.lastServedBy?.()).toBeUndefined();
    await r.review("x");
    expect(r.lastServedBy?.()).toBe("m1");
  });

  test("a fallback shows as another value than the requested model", async () => {
    const r = make("fallback");
    await r.review("x");
    expect(r.lastServedBy?.()).toBe("other-model");
  });

  test("an answer without the header reads undefined", async () => {
    const r = make("bare");
    await r.review("x");
    expect(r.lastServedBy?.()).toBeUndefined();
  });

  test("without a servedByHeader setting nothing is read, whatever the endpoint sends", async () => {
    const r = make("m1", null);
    await r.review("x");
    expect(r.lastServedBy?.()).toBeUndefined();
  });

  test("the header name is the one configured, in any case", async () => {
    const r = make("m1", "X-Served-By");
    await r.review("x");
    expect(r.lastServedBy?.()).toBe("m1");
    const other = make("m1", "x-other");
    await other.review("x");
    expect(other.lastServedBy?.()).toBeUndefined();
  });

  test("a failed call clears the value", async () => {
    const r = make("fail");
    await expect(r.review("x")).rejects.toThrow();
    expect(r.lastServedBy?.()).toBeUndefined();
  });
});
