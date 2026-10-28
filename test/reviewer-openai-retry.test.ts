import { afterAll, describe, expect, test } from "bun:test";
import { openaiReviewer } from "../src/adapters/reviewer/openai.ts";

const ok = () => Response.json({ choices: [{ message: { content: "APPROVE\nno attack indicators found" } }] });
const servers: ReturnType<typeof Bun.serve>[] = [];
afterAll(() => servers.forEach((s) => s.stop(true)));

function flaky(failures: number, status = 503) {
  const hits = { n: 0 };
  const s = Bun.serve({ port: 0, fetch: () => (++hits.n <= failures ? new Response("loading", { status }) : ok()) });
  servers.push(s);
  return { hits, base: `http://127.0.0.1:${s.port}` };
}

describe("openaiReviewer retries a cold-loading route", () => {
  test("503 twice then 200 succeeds on the third try", async () => {
    const { hits, base } = flaky(2);
    const r = openaiReviewer({ name: "local", baseUrls: [base], model: "m", retryDelaysMs: [1, 1, 1] });
    expect(await r.review("hi")).toBe("APPROVE\nno attack indicators found");
    expect(hits.n).toBe(3);
  });

  test("a 503 that never clears fails after the backoff is used up", async () => {
    const { hits, base } = flaky(99);
    const r = openaiReviewer({ name: "local", baseUrls: [base], model: "m", retryDelaysMs: [1, 1] });
    await expect(r.review("hi")).rejects.toThrow(/503/);
    expect(hits.n).toBe(3);
  });

  test("other errors are not retried", async () => {
    const { hits, base } = flaky(99, 500);
    const r = openaiReviewer({ name: "local", baseUrls: [base], model: "m", retryDelaysMs: [1, 1] });
    await expect(r.review("hi")).rejects.toThrow(/500/);
    expect(hits.n).toBe(1);
  });

  test("connection refused is retried until the server comes up", async () => {
    const probe = Bun.serve({ port: 0, fetch: ok });
    const port = probe.port;
    probe.stop(true);
    const r = openaiReviewer({ name: "local", baseUrls: [`http://127.0.0.1:${port}`], model: "m", retryDelaysMs: [50, 50, 50, 200] });
    const pending = r.review("hi");
    await new Promise((res) => setTimeout(res, 80));
    servers.push(Bun.serve({ port, fetch: ok }));
    expect(await pending).toBe("APPROVE\nno attack indicators found");
  });
});

describe("the retries share one deadline per base", () => {
  test("a stalling 503 route gives up at timeoutMs, not per attempt, and the next base is tried", async () => {
    const { base: bad } = flaky(99);
    const good = Bun.serve({ port: 0, fetch: ok });
    servers.push(good);
    const r = openaiReviewer({ name: "local", baseUrls: [bad, `http://127.0.0.1:${good.port}`], model: "m", retryDelaysMs: [200, 200, 200, 200, 200, 200], timeoutMs: 300 });
    const t0 = Date.now();
    expect(await r.review("hi")).toBe("APPROVE\nno attack indicators found");
    expect(Date.now() - t0).toBeLessThan(900);
  });
});
