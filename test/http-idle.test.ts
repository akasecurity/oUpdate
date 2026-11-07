import { afterAll, describe, expect, test } from "bun:test";
import { npmRegistry } from "../src/adapters/ecosystem/npm.ts";
import { osvFeed } from "../src/adapters/advisory/osv.ts";
import { giteaForge } from "../src/adapters/forge/gitea.ts";
import { githubForge } from "../src/adapters/forge/github.ts";
import { dockerHubSource, registrySource, parseImageRef } from "../src/adapters/oci/registry.ts";
import { DOWNLOAD_IDLE_MS, HTTP_IDLE_MS, downloadIdleMs, fetchIdle, httpIdleMs, HTTP_TOTAL_MS, DOWNLOAD_TOTAL_MS, httpTotalMs, downloadTotalMs } from "../src/adapters/http.ts";
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
/** A body that arrives in `parts` pieces, one every `gap` ms: slower in total than the idle limit, steady within it. */
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
const slowButSteady = serve(() => trickle(packument, 8, 100, { "content-type": "application/json" })); // about 800 ms in total, never 300 ms quiet

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
});

describe("the limit starts over when the headers arrive", () => {
  test("a gap before the headers and a gap before the first byte are each under the limit, though together over it", async () => {
    const slow = (async (_url: unknown, init?: RequestInit) => {
      await Bun.sleep(400);
      const sig = init?.signal;
      return new Response(new ReadableStream({
        async start(c) {
          sig?.addEventListener("abort", () => c.error(sig.reason));
          await Bun.sleep(400);
          if (!sig?.aborted) { c.enqueue(enc.encode("ok")); c.close(); }
        },
      }));
    }) as typeof fetch;
    const r = await fetchIdle(slow, "http://example.invalid/", {}, 600);
    expect(await r.text()).toBe("ok");
  });
});

describe("the response it returns still describes the request", () => {
  test("the url and the redirect flag of the real response are kept", async () => {
    const real = new Response("ok");
    Object.defineProperties(real, { url: { value: "http://example.invalid/final" }, redirected: { value: true } });
    const r = await fetchIdle((async () => real) as unknown as typeof fetch, "http://example.invalid/start", {}, MS);
    expect(r.url).toBe("http://example.invalid/final");
    expect(r.redirected).toBe(true);
    expect(await r.text()).toBe("ok");
  });

  test("a decoded body does not keep the encoding or the length of the encoded one", async () => {
    const real = new Response("hello", { headers: { "content-encoding": "gzip", "content-length": "25", "content-type": "text/plain" } });
    const r = await fetchIdle((async () => real) as unknown as typeof fetch, "http://example.invalid/", {}, MS);
    expect(r.headers.get("content-encoding")).toBeNull();
    expect(r.headers.get("content-length")).toBeNull();
    expect(r.headers.get("content-type")).toBe("text/plain");
  });

  test("a length with no encoding is kept", async () => {
    const r = await fetchIdle((async () => new Response("hello", { headers: { "content-length": "5" } })) as unknown as typeof fetch, "http://example.invalid/", {}, MS);
    expect(r.headers.get("content-length")).toBe("5");
  });
});

describe("a caller's own signal still works", () => {
  test("aborting it aborts the fetch with its reason, and the idle limit still applies", async () => {
    const hang = ((_url: unknown, init?: RequestInit) => new Promise<Response>((_, no) => init?.signal?.addEventListener("abort", () => no(init.signal!.reason)))) as typeof fetch;
    const mine = new AbortController();
    const p = fetchIdle(hang, "http://example.invalid/", { signal: mine.signal }, 5000);
    mine.abort(new Error("mine"));
    expect(await refusal(p)).toBe("mine");
    expect(await refusal(fetchIdle(hang, "http://example.invalid/", { signal: new AbortController().signal }, MS))).toMatch(quiet);
  });
});

describe("a failed answer's body is released", () => {
  const cancelled = () => {
    const seen = { cancelled: 0 };
    const res = (status: number) => new Response(new ReadableStream({ pull(c) { c.enqueue(enc.encode("x")); }, cancel() { seen.cancelled++; } }), { status });
    return { seen, res };
  };
  test("forge json, readFile and the file list", async () => {
    for (const make of [(f: typeof fetch) => giteaForge({ endpoint: "https://forge.example/api/v1", token: "t", login: "bot", fetch: f }), (f: typeof fetch) => githubForge({ endpoint: "https://forge.example", token: "t", login: "bot", fetch: f })]) {
      for (const status of [500, 404]) {
        const { seen, res } = cancelled();
        const forge = make((async () => res(status)) as unknown as typeof fetch);
        await forge.readFile("o/r", "abc", "a.txt").catch(() => {});
        expect(seen.cancelled).toBe(1);
      }
      const pulls = cancelled();
      await refusal(make((async () => pulls.res(500)) as unknown as typeof fetch).openPulls("o/r"));
      expect(pulls.seen.cancelled).toBe(1);
      const files = cancelled();
      await refusal(make((async () => files.res(500)) as unknown as typeof fetch).changedFiles("o/r", 1));
      expect(files.seen.cancelled).toBe(1);
    }
  });

  test("a registry manifest and token, and a Docker Hub manifest", async () => {
    const { seen, res } = cancelled();
    const reg = registrySource({ fetch: (async () => res(500)) as unknown as typeof fetch, timeoutMs: MS });
    await refusal(reg.imageEvidence(parseImageRef("registry.example/app:1"), "linux/amd64"));
    expect(seen.cancelled).toBe(1);

    const hub = cancelled();
    let n = 0;
    const hubFetch = (async () => (++n === 1 ? Response.json({ token: "t" }) : hub.res(500))) as unknown as typeof fetch;
    await refusal(dockerHubSource({ fetch: hubFetch, timeoutMs: MS }).index("library/alpine", "3"));
    expect(hub.seen.cancelled).toBe(1);

    const redir = cancelled();
    const loop = (async () => new Response(new ReadableStream({ pull(c) { c.enqueue(enc.encode("x")); }, cancel() { redir.seen.cancelled++; } }), { status: 302, headers: { location: "https://registry.example/elsewhere" } })) as unknown as typeof fetch;
    expect(await refusal(registrySource({ fetch: loop, timeoutMs: MS }).imageEvidence(parseImageRef("registry.example/app:1"), "linux/amd64"))).toMatch(/over 5 redirects/);
    expect(redir.seen.cancelled).toBe(6); // every 3xx body, the last one before the error

    const first = cancelled();
    let calls = 0;
    const challenge = (async (url: unknown) => {
      calls++;
      if (String(url).startsWith("https://auth.example/")) return Response.json({ token: "t" });
      if (calls === 1) return new Response(first.res(401).body, { status: 401, headers: { "www-authenticate": 'Bearer realm="https://auth.example/token",service="r"' } });
      return new Response("no", { status: 500 });
    }) as unknown as typeof fetch;
    await refusal(registrySource({ fetch: challenge, timeoutMs: MS }).imageEvidence(parseImageRef("registry.example/app:1"), "linux/amd64"));
    expect(first.seen.cancelled).toBe(1); // the 401 that was replaced by the retry

    // a token step that fails leaves the replaced 401 canceled too, and each case fails at the step it means to test
    const cases: { realm: string; token?: () => Response; fails: RegExp }[] = [
      { realm: "https://auth.example/token", token: () => new Response("no", { status: 503 }), fails: /token HTTP 503/ },
      { realm: "https://auth.example/token", token: () => Response.json({}), fails: /token missing/ },
      { realm: "https://auth.example/token", token: () => new Response("not json", { status: 200 }), fails: /^registry token answer is not JSON$/ },
      { realm: "http://auth.example/token", fails: /not https/ },
      { realm: "not a url", fails: /^registry token realm is not a URL: not a url$/ },
    ];
    for (const [i, k] of cases.entries()) {
      const c = cancelled();
      let askedToken = false;
      const failing = (async (url: unknown) => {
        if (String(url).startsWith("https://auth.example/")) { askedToken = true; return k.token!(); }
        return new Response(c.res(401).body, { status: 401, headers: { "www-authenticate": `Bearer realm="${k.realm}",service="r"` } });
      }) as unknown as typeof fetch;
      const msg = await refusal(registrySource({ fetch: failing, timeoutMs: MS }).imageEvidence(parseImageRef("registry.example/app:1"), "linux/amd64"));
      expect(msg, `case ${i}`).toMatch(k.fails);
      expect(askedToken, `case ${i}`).toBe(k.token !== undefined);
      expect(c.seen.cancelled, `case ${i}`).toBe(1);
    }

    expect(await refusal(dockerHubSource({ fetch: (async () => new Response("not json")) as unknown as typeof fetch, timeoutMs: MS }).index("library/alpine", "3"))).toBe("registry token answer is not JSON");

    const tok = cancelled();
    await refusal(dockerHubSource({ fetch: (async () => tok.res(403)) as unknown as typeof fetch, timeoutMs: MS }).index("library/alpine", "3"));
    expect(tok.seen.cancelled).toBe(1);
  });
});

describe("a call has a limit in total, however steadily data arrives", () => {
  const whole = (n: number) => new RegExp(`^timed out after ${n} ms in total: `);
  /** A body that never stalls (a piece every 50 ms, far under any idle limit) and never ends. */
  const endless = serve(() => new Response(new ReadableStream({ async pull(c) { await Bun.sleep(50); c.enqueue(enc.encode("x")); } })));

  test("a body that keeps coming without end is cut off at the total, naming it", async () => {
    const r = await fetchIdle(fetch, endless, {}, 5000, 400);
    expect(await refusal(r.arrayBuffer())).toMatch(whole(400));
  });

  test("a call that never answers fails at the total when the idle limit is longer", async () => {
    expect(await refusal(fetchIdle(fetch, never, {}, 5000, MS))).toMatch(whole(MS));
  });

  test("the idle limit still fires first when it is the shorter one", async () => {
    expect(await refusal(fetchIdle(fetch, never, {}, MS, 5000))).toMatch(quiet);
  });

  test("a call that finishes inside the total is not cut off, and both of its timers are cleared", async () => {
    const live = new Set<unknown>();
    const { setTimeout: set, clearTimeout: clear } = globalThis;
    globalThis.setTimeout = ((fn: () => void, ms?: number, ...a: unknown[]) => {
      const h = set(fn, ms, ...a);
      if (ms === 5000 || ms === 3000) live.add(h);
      return h;
    }) as typeof setTimeout;
    globalThis.clearTimeout = ((h?: Parameters<typeof clear>[0]) => { live.delete(h); return clear(h); }) as typeof clearTimeout;
    try {
      const r = await fetchIdle(fetch, slowButSteady, {}, 5000, 3000);
      expect(JSON.parse(await r.text()).pad.length).toBe(200);
      expect(live.size).toBe(0);
    } finally {
      globalThis.setTimeout = set;
      globalThis.clearTimeout = clear;
      for (const h of live) clear(h as Parameters<typeof clear>[0]);
    }
  });

  test("the totals are read from the environment, and a bad value falls back to the default", () => {
    expect(httpTotalMs({})).toBe(HTTP_TOTAL_MS);
    expect(downloadTotalMs({})).toBe(DOWNLOAD_TOTAL_MS);
    expect(HTTP_TOTAL_MS).toBe(600_000);
    expect(DOWNLOAD_TOTAL_MS).toBe(3_600_000);
    expect(httpTotalMs({ OUPDATE_HTTP_TOTAL_MS: "1500" })).toBe(1500);
    expect(downloadTotalMs({ OUPDATE_DOWNLOAD_TOTAL_MS: "900000" })).toBe(900000);
    for (const bad of ["", "0", "-5", "1.5", "abc", "99999999999"]) {
      expect(httpTotalMs({ OUPDATE_HTTP_TOTAL_MS: bad }), bad).toBe(HTTP_TOTAL_MS);
      expect(downloadTotalMs({ OUPDATE_DOWNLOAD_TOTAL_MS: bad }), bad).toBe(DOWNLOAD_TOTAL_MS);
    }
  });

  test("a request and a download pick up their own environment limit by default", async () => {
    const was = { h: process.env.OUPDATE_HTTP_TOTAL_MS, d: process.env.OUPDATE_DOWNLOAD_TOTAL_MS };
    try {
      process.env.OUPDATE_HTTP_TOTAL_MS = "400";
      process.env.OUPDATE_DOWNLOAD_TOTAL_MS = "3000";
      // the request is cut at 400 ms; a download of the same shape (about 800 ms) is not
      expect(await refusal(npmRegistry({ base: slowButSteady, timeoutMs: 5000 }).latest("yaml"))).toMatch(whole(400));
      const tar = "t".repeat(64);
      const steady = serve(() => trickle(tar, 8, 100));
      expect(new TextDecoder().decode(await fetchVerified(fetch, steady, undefined, 5000))).toBe(tar);
      process.env.OUPDATE_DOWNLOAD_TOTAL_MS = "400";
      expect(await refusal(fetchVerified(fetch, steady, undefined, 5000))).toMatch(whole(400));
    } finally {
      for (const [k, v] of [["OUPDATE_HTTP_TOTAL_MS", was.h], ["OUPDATE_DOWNLOAD_TOTAL_MS", was.d]] as const) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }
  });
});

describe("the Docker Hub token stays with the registry", () => {
  test("a redirect to another origin (a CDN) is followed without the authorization header", async () => {
    // guards the runtime dropping Authorization on a cross-origin redirect: the source relies on it
    const seenAtCdn: (string | null)[] = [];
    const seenAtRegistry: (string | null)[] = [];
    const manifest = JSON.stringify({ schemaVersion: 2, mediaType: "application/vnd.oci.image.index.v1+json", manifests: [] });
    const cdn = serve((req) => { seenAtCdn.push(req.headers.get("authorization")); return new Response(manifest, { headers: { "content-type": "application/vnd.oci.image.index.v1+json" } }); });
    const registry = serve((req) => { seenAtRegistry.push(req.headers.get("authorization")); return new Response(null, { status: 307, headers: { location: `${cdn}/blob` } }); });
    // the hosts are fixed in the source: send them to the local registry, the redirect then crosses to the other port (another origin)
    const real = ((url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.startsWith("https://auth.docker.io/")) return Promise.resolve(Response.json({ token: "secret-token" }));
      return fetch(u.replace("https://registry-1.docker.io", registry), init);
    }) as typeof fetch;
    expect(await refusal(dockerHubSource({ fetch: real, timeoutMs: 2000 }).index("library/alpine", "3"))).toMatch(/has 0 linux\/amd64 images/); // the CDN manifest was read and parsed
    expect(seenAtRegistry).toEqual(["Bearer secret-token"]);
    expect(seenAtCdn.length).toBe(1);
    expect(seenAtCdn[0]).toBeNull();
  });
});
