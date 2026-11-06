import { afterAll, beforeAll, expect, test } from "bun:test";
import { get } from "../acceptance/http.ts";

let server: ReturnType<typeof Bun.serve>;
const url = (p: string) => `http://127.0.0.1:${server.port}${p}`;
beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const p = new URL(req.url).pathname;
      if (p === "/ok") return new Response("hello");
      if (p === "/missing") return new Response("no", { status: 404 });
      if (p === "/silent") return new Promise<Response>(() => {}); // never answers
      if (p === "/stall") return new Response(new ReadableStream({ start: (c) => c.enqueue(new TextEncoder().encode("part")) })); // headers, one chunk, then nothing
      return new Response("?", { status: 500 });
    },
  });
});
afterAll(() => server.stop(true));

test("a download that returns is read, and a bad status names the url", async () => {
  expect(new TextDecoder().decode(await get(url("/ok")))).toBe("hello");
  await expect(get(url("/missing"))).rejects.toThrow(`404 ${url("/missing")}`);
});

test("a server that never answers times out with an error that names the url", async () => {
  const started = Date.now();
  await expect(get(url("/silent"), { timeoutMs: 300 })).rejects.toThrow(`timed out after 0.3 s: ${url("/silent")}`);
  expect(Date.now() - started).toBeLessThan(5000);
});

test("a body that stalls after the headers also times out", async () => {
  await expect(get(url("/stall"), { timeoutMs: 300 })).rejects.toThrow(`timed out after 0.3 s: ${url("/stall")}`);
});

// The next tests replace fetch to look at how get() calls it and what it does with the body; the local server above covers the real stalls.
// withFetch swaps the global fetch for the length of one call, so it is only safe while this file's tests run one at a time (bun's default); a concurrent test would see the stub.
// Bun's own fetch init type (BunFetchRequestInit) has no `timeout` field, so the stub types the option itself.
const withFetch = async (impl: (u: string | URL | Request, init?: RequestInit & { timeout?: boolean }) => Promise<Response>, fn: () => Promise<void>) => {
  const real = globalThis.fetch;
  globalThis.fetch = impl as unknown as typeof fetch;
  try { await fn(); } finally { globalThis.fetch = real; }
};

test("the runtime's own 300 s fetch limit is switched off so the helper's limit is the one that applies", async () => {
  let seen: (RequestInit & { timeout?: boolean }) | undefined;
  await withFetch(async (_u, init) => ((seen = init), new Response("x")), async () => { await get("http://x.example/a"); });
  expect(seen?.timeout).toBe(false);
  expect(seen?.signal).toBeInstanceOf(AbortSignal);
  expect(seen?.signal?.aborted).toBe(false); // a live deadline, not one already spent
});

test("a bad status cancels the unread body", async () => {
  let cancelled = false;
  await withFetch(async () => new Response(new ReadableStream({ cancel: () => { cancelled = true; } }), { status: 500 }), async () => {
    await expect(get("http://x.example/b")).rejects.toThrow("500 http://x.example/b");
  });
  expect(cancelled).toBe(true);
});

test("only the helper's own timeout is reported as a timeout; any other abort passes through", async () => {
  await withFetch(async () => { throw new DOMException("cancelled by a caller", "AbortError"); }, async () => {
    await expect(get("http://x.example/c")).rejects.toThrow("cancelled by a caller");
  });
});
