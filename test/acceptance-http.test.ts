import { afterAll, beforeAll, expect, test } from "bun:test";
import { get, FILE_TIMEOUT_MS, JSON_TIMEOUT_MS } from "../acceptance/http.ts";

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

test("files get a longer timeout than JSON, and both are bounded", () => {
  expect(JSON_TIMEOUT_MS).toBeLessThan(FILE_TIMEOUT_MS);
  expect(FILE_TIMEOUT_MS).toBeLessThanOrEqual(300_000);
});
