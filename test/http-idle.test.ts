import { afterAll, describe, expect, test } from "bun:test";
import { npmRegistry } from "../src/adapters/ecosystem/npm.ts";
import { osvFeed } from "../src/adapters/advisory/osv.ts";
import { giteaForge } from "../src/adapters/forge/gitea.ts";
import { githubForge } from "../src/adapters/forge/github.ts";
import { dockerHubSource, registrySource, parseImageRef } from "../src/adapters/oci/registry.ts";
import { DOWNLOAD_IDLE_MS, HTTP_IDLE_MS, downloadIdleMs, fetchIdle, httpIdleMs } from "../src/adapters/http.ts";
import { fetchVerified } from "../src/targets/pins/npm.ts";

const servers: ReturnType<typeof Bun.serve>[] = [];
const serve = (fetch: (req: Request) => Response | Promise<Response>) => {
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch, idleTimeout: 0 });
  servers.push(s);
  return `http://127.0.0.1:${s.port}`;
};
afterAll(() => { for (const s of servers) s.stop(true); });

const MS = 300;
const enc = new TextEncoder();
/** A body that arrives in `parts` pieces, one every `gap` ms: slower in all than the idle limit, steady within it. */
const trickle = (text: string, parts: number, gap: number, headers: Record<string, string> = {}) => {
  const size = Math.ceil(text.length / parts);
  let i = 0;
  return new Response(new ReadableStream({
    async pull(c) {
      if (i >= text.length) return c.close();
      await Bun.sleep(gap);
      c.enqueue(enc.encode(text.slice(i, i + size)));
      i += size;
    },
  }), { headers });
};
const never = serve(() => new Promise<Response>(() => {}));
/** Sends the headers and half a body, then nothing. */
const stall = serve(() => new Response(new ReadableStream({ start(c) { c.enqueue(enc.encode('{"dist-tags":')); } }), { headers: { "content-type": "application/json" } }));
const packument = JSON.stringify({ "dist-tags": { latest: "2.8.3" }, time: {}, versions: {}, pad: "x".repeat(200) });
const slowButSteady = serve(() => trickle(packument, 8, 100, { "content-type": "application/json" })); // about 800 ms in all, never 300 ms quiet

const refusal = async (p: Promise<unknown>) => p.then(() => { throw new Error("resolved"); }, (e: Error) => e.message);
const quiet = new RegExp(`^timed out after ${MS} ms without data: `);

describe("the limit is for silence, not for the whole request", () => {
  test("an answer that keeps arriving is read in full though it takes longer than the limit", async () => {
    const t = Date.now();
    expect(await npmRegistry({ base: slowButSteady, timeoutMs: MS }).latest("yaml")).toBe("2.8.3");
    expect(Date.now() - t).toBeGreaterThan(MS);
  });

  test("an answer that stops arriving fails after the limit, and one that never starts fails too", async () => {
    expect(await refusal(npmRegistry({ base: stall, timeoutMs: MS }).latest("yaml"))).toMatch(quiet);
    expect(await refusal(npmRegistry({ base: never, timeoutMs: MS }).latest("yaml"))).toMatch(quiet);
  });

  test("a failure that is not a stall keeps its own message", async () => {
    const dead = never.replace(/:\d+$/, ":1");
    expect(await refusal(fetchIdle(fetch, dead, {}, MS))).not.toMatch(/timed out/);
  });

  test("the limits are read from the environment, and a bad value falls back to the default", () => {
    expect(httpIdleMs({})).toBe(HTTP_IDLE_MS);
    expect(downloadIdleMs({})).toBe(DOWNLOAD_IDLE_MS);
    expect(DOWNLOAD_IDLE_MS).toBeGreaterThan(HTTP_IDLE_MS);
    expect(httpIdleMs({ OUPDATE_HTTP_IDLE_MS: "1500" })).toBe(1500);
    expect(downloadIdleMs({ OUPDATE_DOWNLOAD_IDLE_MS: "900000" })).toBe(900000);
    for (const bad of ["", "0", "-5", "1.5", "abc", "99999999999"]) {
      expect(httpIdleMs({ OUPDATE_HTTP_IDLE_MS: bad }), bad).toBe(HTTP_IDLE_MS);
      expect(downloadIdleMs({ OUPDATE_DOWNLOAD_IDLE_MS: bad }), bad).toBe(DOWNLOAD_IDLE_MS);
    }
  });
});

describe("forge requests do not hang", () => {
  test("gitea: a server that never answers fails with the stall message", async () => {
    const forge = giteaForge({ endpoint: `${never}/api/v1`, token: "t", login: "bot", timeoutMs: MS });
    expect(await refusal(forge.openPulls("o/r"))).toMatch(quiet);
  });
  test("github: a server that never answers fails with the stall message", async () => {
    const forge = githubForge({ endpoint: never, token: "t", login: "bot", timeoutMs: MS });
    expect(await refusal(forge.openPulls("o/r"))).toMatch(quiet);
  });
  test("gitea: a body that stalls after the headers fails too, and a steady slow one is read", async () => {
    const stalled = giteaForge({ endpoint: `${stall}/api/v1`, token: "t", login: "bot", timeoutMs: MS });
    expect(await refusal(stalled.openPulls("o/r"))).toMatch(quiet);
    const pulls = JSON.stringify(Array.from({ length: 3 }, () => ({ number: 1, user: { login: "x" }, head: { ref: "r", sha: "h", repo: { full_name: "o/r" } }, base: { sha: "b", repo: { full_name: "o/r" } } })));
    const steady = serve(() => trickle(pulls, 8, 100, { "content-type": "application/json" }));
    const ok = giteaForge({ endpoint: `${steady}/api/v1`, token: "t", login: "bot", timeoutMs: MS });
    expect((await ok.openPulls("o/r")).length).toBe(3);
  });
});

describe("image registry requests do not hang", () => {
  /** A fetch that never answers, and honors the signal it is given. */
  const silent: typeof fetch = ((_u: unknown, init?: RequestInit) => new Promise((_res, rej) => init?.signal?.addEventListener("abort", () => rej(init.signal!.reason)))) as typeof fetch;
  test("the Docker Hub source fails with the stall message", async () => {
    expect(await refusal(dockerHubSource({ fetch: silent, timeoutMs: MS }).index("library/alpine", "3"))).toMatch(quiet);
  });
  test("a registry source fails with the stall message", async () => {
    expect(await refusal(registrySource({ fetch: silent, timeoutMs: MS }).imageEvidence(parseImageRef("alpine:3"), "linux/amd64"))).toMatch(quiet);
  });
});

describe("a download has its own, longer limit", () => {
  const tar = "t".repeat(400);
  test("a download that keeps arriving is read in full though it takes longer than the limit", async () => {
    const steady = serve(() => trickle(tar, 8, 100));
    const t = Date.now();
    const bytes = await fetchVerified(fetch, steady, undefined, MS);
    expect(new TextDecoder().decode(bytes)).toBe(tar);
    expect(Date.now() - t).toBeGreaterThan(MS);
  });
  test("a download that stalls fails with the stall message, and a bad status cancels the body", async () => {
    expect(await refusal(fetchVerified(fetch, never, undefined, MS))).toMatch(quiet);
    expect(await refusal(fetchVerified(fetch, stall, undefined, MS))).toMatch(quiet);
    let cancelled = false;
    const f = (async () => new Response(new ReadableStream({ cancel: () => { cancelled = true; } }), { status: 500 })) as unknown as typeof fetch;
    expect(await refusal(fetchVerified(f, "http://x.example/a", undefined, MS))).toMatch(/^download 500 for /);
    expect(cancelled).toBe(true);
  });
});

describe("a failed lookup is not kept for the rest of the sweep", () => {
  test("a packument that timed out once is fetched again", async () => {
    let n = 0;
    const base = serve(() => (++n === 1 ? new Promise<Response>(() => {}) : Response.json({ "dist-tags": { latest: "2.8.3" }, time: {}, versions: {} })));
    const reg = npmRegistry({ base, timeoutMs: MS });
    expect(await refusal(reg.latest("yaml"))).toMatch(quiet);
    expect(await reg.latest("yaml")).toBe("2.8.3");
    expect(n).toBe(2);
    expect(await reg.latest("yaml")).toBe("2.8.3"); // a good answer is kept
    expect(n).toBe(2);
  });

  test("a vulnerability detail that failed once is fetched again", async () => {
    let detail = 0;
    const base = serve((req) => {
      if (new URL(req.url).pathname === "/querybatch") return Response.json({ results: [{ vulns: [{ id: "GHSA-x" }] }] });
      return ++detail === 1 ? new Response("no", { status: 500 }) : Response.json({ id: "GHSA-x", summary: "s", affected: [] });
    });
    const feed = osvFeed({ base, timeoutMs: MS });
    const pkg = [{ ecosystem: "npm", name: "yaml", version: "1.0.0" }];
    expect(await refusal(feed.query(pkg))).toMatch(/^osv 500 for vuln GHSA-x/);
    expect((await feed.query(pkg)).map((a) => a.id)).toEqual(["GHSA-x"]);
    expect(detail).toBe(2);
    await feed.query(pkg);
    expect(detail).toBe(2); // a good answer is kept
  });
});

describe("a dropped response does not hold the process", () => {
  test("an unread response with a long limit lets the process exit at once", async () => {
    const httpTs = new URL("../src/adapters/http.ts", import.meta.url).pathname;
    const code = `
      import { fetchIdle } from ${JSON.stringify(httpTs)};
      const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("x".repeat(10), { status: 401 }) });
      await fetchIdle(fetch, "http://127.0.0.1:" + s.port + "/", {}, 4000);
      s.stop(true);
    `;
    const t0 = Date.now();
    const p = Bun.spawn([process.execPath, "-e", code], { stdout: "ignore", stderr: "ignore" });
    expect(await p.exited).toBe(0);
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  test("a forge login that failed once is asked for again", async () => {
    let users = 0;
    const base = serve((req) => {
      const path = new URL(req.url).pathname;
      if (path.endsWith("/user")) return ++users === 1 ? new Promise<Response>(() => {}) : Response.json({ login: "bot" });
      return Response.json([]);
    });
    for (const forge of [giteaForge({ endpoint: `${base}/api/v1`, token: "t", timeoutMs: MS }), githubForge({ endpoint: base, token: "t", timeoutMs: MS })]) {
      users = 0;
      expect(await refusal(forge.ownComment("o/r", 1, "m"))).toMatch(quiet);
      expect(await forge.ownComment("o/r", 1, "m")).toBeUndefined();
      expect(users).toBe(2);
    }
  });
});
