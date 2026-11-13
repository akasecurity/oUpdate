import { describe, expect, test } from "bun:test";
import { giteaForge } from "../src/adapters/forge/gitea.ts";

describe("giteaForge plain http", () => {
  test("the token is never sent to a plain http endpoint on a non-loopback host; loopback is allowed", async () => {
    const urls: string[] = [];
    const f = (async (u: string) => (urls.push(String(u)), Response.json([]))) as unknown as typeof fetch;
    const bad = giteaForge({ token: "t", login: "bot", endpoint: "http://forge.example/api/v1", fetch: f });
    await expect(bad.openPulls("o/r")).rejects.toThrow(/token is not sent over plain http/);
    expect(urls).toEqual([]);
    const ok = giteaForge({ token: "t", login: "bot", endpoint: "http://localhost:3000/api/v1", fetch: f });
    await ok.openPulls("o/r").catch(() => {});
    expect(urls.length).toBeGreaterThan(0);
  });
});

describe("giteaForge login lookup and failed answers", () => {
  /** A fetch that answers in order, records each request, and fails loudly on a request nobody planned. */
  const fake = (answers: (() => Response)[]) => {
    const calls: string[] = [];
    const f = (async (u: string, init?: RequestInit) => {
      const call = `${init?.method ?? "GET"} ${new URL(String(u)).pathname}`;
      calls.push(call);
      const next = answers.shift();
      if (!next) throw new Error(`unexpected request ${call}`);
      return next();
    }) as unknown as typeof fetch;
    return { f, calls };
  };
  const endpoint = "https://forge.example/api/v1";
  const trackedBody = () => {
    const state = { cancelled: false };
    return { state, body: new ReadableStream({ cancel() { state.cancelled = true; } }) };
  };

  test("a failed login lookup is asked again by the next call, and a good one is kept", async () => {
    const { f, calls } = fake([
      () => new Response("down", { status: 500 }),
      () => Response.json({ login: "bot" }),
      () => Response.json([]),
      () => Response.json([]),
    ]);
    const forge = giteaForge({ token: "t", endpoint, fetch: f });
    await expect(forge.ownComment("o/r", 1, "m")).rejects.toThrow(/GET \/user: 500/);
    await expect(forge.ownComment("o/r", 1, "m")).resolves.toBeUndefined();
    await expect(forge.ownComment("o/r", 1, "m")).resolves.toBeUndefined();
    expect(calls.filter((c) => c.endsWith("/user"))).toHaveLength(2);
    expect(calls).toHaveLength(4);
  });

  test("a response with no login fails the lookup", async () => {
    const { f } = fake([() => Response.json({})]);
    const forge = giteaForge({ token: "t", endpoint, fetch: f });
    await expect(forge.ownComment("o/r", 1, "m")).rejects.toThrow(/no login/);
  });

  test("a failed answer's body is cancelled", async () => {
    const { state, body } = trackedBody();
    const { f } = fake([() => new Response(body, { status: 502 })]);
    const forge = giteaForge({ token: "t", login: "bot", endpoint, fetch: f });
    await expect(forge.openPulls("o/r")).rejects.toThrow(/: 502/);
    expect(state.cancelled).toBe(true);
  });

  test("a missing file reads undefined and cancels its body", async () => {
    const { state, body } = trackedBody();
    const { f } = fake([() => new Response(body, { status: 404 })]);
    const forge = giteaForge({ token: "t", login: "bot", endpoint, fetch: f });
    expect(await forge.readFile("o/r", "abc", "a/b.txt")).toBeUndefined();
    expect(state.cancelled).toBe(true);
  });

  test("a request nobody planned fails with its method and path", async () => {
    const { f } = fake([]);
    const forge = giteaForge({ token: "t", login: "bot", endpoint, fetch: f });
    await expect(forge.openPulls("o/r")).rejects.toThrow(/unexpected request GET \/api\/v1\/repos\/o\/r\/pulls/);
  });
});
