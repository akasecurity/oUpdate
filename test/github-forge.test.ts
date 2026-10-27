import { describe, expect, test } from "bun:test";
import { githubForge } from "../src/adapters/forge/github.ts";
import { join } from "node:path";

/** Hand-written API responses, trimmed to the fields that matter plus a few around them. */
const fixture = (f: string) => Bun.file(join(import.meta.dir, "fixtures/github", f)).json();
const pullsPage2 = await fixture("pulls-page2.json");
const combined = (await fixture("combined-status.json")) as { sha: string };
const commentsPage2 = await fixture("comments-page2.json");

interface Call { method: string; url: string; headers: Headers; body?: string }

/** Answers by "METHOD path?query" relative to the API base; anything unrouted is a 404, as GitHub answers a missing file. */
function fakeFetch(routes: Record<string, () => Response>, calls: Call[], base = "https://api.github.com"): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ method: init?.method ?? "GET", url, headers: new Headers(init?.headers), body: init?.body as string | undefined });
    const h = routes[`${init?.method ?? "GET"} ${url.replace(base, "")}`];
    return h ? h() : Response.json({ message: "Not Found" }, { status: 404 });
  }) as typeof fetch;
}

const pull = (n: number) => ({ number: n, head: { ref: `renovate/p${n}`, sha: `h${n}` }, base: { ref: "main", sha: "b" } });

describe("githubForge", () => {
  test("sends a bearer token with the GitHub JSON media type and API version, to api.github.com by default", async () => {
    const calls: Call[] = [];
    const f = githubForge({ token: "ghs_x", fetch: fakeFetch({ "GET /repos/o/r/pulls?state=open&per_page=100&page=1": () => Response.json([]) }, calls) });
    await f.openPulls("o/r");
    expect(calls[0]!.url).toBe("https://api.github.com/repos/o/r/pulls?state=open&per_page=100&page=1");
    expect(calls[0]!.headers.get("authorization")).toBe("Bearer ghs_x");
    expect(calls[0]!.headers.get("accept")).toBe("application/vnd.github+json");
    expect(calls[0]!.headers.get("x-github-api-version")).toBe("2022-11-28");
  });

  test("an endpoint (GitHub Enterprise Server) replaces the base URL; a trailing slash is dropped", async () => {
    const calls: Call[] = [];
    const base = "https://ghe.example/api/v3";
    const f = githubForge({ endpoint: `${base}/`, token: "t", fetch: fakeFetch({ "GET /repos/o/r/pulls?state=open&per_page=100&page=1": () => Response.json([]) }, calls, base) });
    expect(await f.openPulls("o/r")).toEqual([]);
    expect(calls[0]!.url).toBe(`${base}/repos/o/r/pulls?state=open&per_page=100&page=1`);
  });

  test("lists open PRs page by page until a short page", async () => {
    const calls: Call[] = [];
    const page1 = Array.from({ length: 100 }, (_, i) => pull(i + 1));
    const f = githubForge({
      token: "t",
      fetch: fakeFetch({
        "GET /repos/octo-org/app/pulls?state=open&per_page=100&page=1": () => Response.json(page1),
        "GET /repos/octo-org/app/pulls?state=open&per_page=100&page=2": () => Response.json(pullsPage2),
      }, calls),
    });
    const out = await f.openPulls("octo-org/app");
    expect(out).toHaveLength(101);
    expect(out[0]).toEqual({ number: 1, headRef: "renovate/p1", headSha: "h1", baseSha: "b" });
    expect(out[100]).toEqual({ number: 42, headRef: "dependabot/npm_and_yarn/yaml-2.8.3", headSha: "4b1e5c0a3f2d9e8b7c6a5f4e3d2c1b0a9f8e7d6c", baseSha: "0f9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a2f1e" });
    expect(calls).toHaveLength(2);
  });

  test("reads a file at a sha as raw bytes, past the 1 MB limit of the base64 contents response; 404 is no file", async () => {
    const calls: Call[] = [];
    const big = `{"lockfileVersion":3,"pad":"${"x".repeat(1_100_000)}"}`;
    const f = githubForge({
      token: "t",
      fetch: fakeFetch({ "GET /repos/o/r/contents/web/package-lock.json?ref=h1": () => new Response(big) }, calls),
    });
    expect(await f.readFile("o/r", "h1", "web/package-lock.json")).toBe(big);
    expect(calls[0]!.headers.get("accept")).toBe("application/vnd.github.raw+json");
    expect(await f.readFile("o/r", "h1", "bun.lock")).toBeUndefined();
  });

  test("path segments and the ref are URL-encoded, the slashes between segments are kept", async () => {
    const calls: Call[] = [];
    const f = githubForge({ token: "t", fetch: fakeFetch({}, calls) });
    await f.readFile("o/r", "h 1", "my app/bun.lock");
    expect(calls[0]!.url).toBe("https://api.github.com/repos/o/r/contents/my%20app/bun.lock?ref=h%201");
  });

  test("a read that fails other than 404 throws with the status, never reads as a missing file", async () => {
    const f = githubForge({ token: "t", fetch: (async () => new Response("rate limited", { status: 403 })) as unknown as typeof fetch });
    await expect(f.readFile("o/r", "h1", "bun.lock")).rejects.toThrow(/403/);
  });

  test("statusOf reads our context from the combined status, which holds the latest state per context", async () => {
    const calls: Call[] = [];
    const sha = combined.sha;
    const f = githubForge({ token: "t", fetch: fakeFetch({ [`GET /repos/octo-org/app/commits/${sha}/status?per_page=100&page=1`]: () => Response.json(combined) }, calls) });
    expect(await f.statusOf("octo-org/app", sha, "oupdate/review")).toBe("pending");
    expect(await f.statusOf("octo-org/app", sha, "ci/build")).toBe("success");
    expect(await f.statusOf("octo-org/app", sha, "other")).toBeUndefined();
  });

  test("statusOf pages through a combined status with more than 100 contexts", async () => {
    const calls: Call[] = [];
    const many = Array.from({ length: 100 }, (_, i) => ({ id: i, state: "success", context: `ci/${i}` }));
    const f = githubForge({
      token: "t",
      fetch: fakeFetch({
        "GET /repos/o/r/commits/h1/status?per_page=100&page=1": () => Response.json({ state: "failure", sha: "h1", total_count: 101, statuses: many }),
        "GET /repos/o/r/commits/h1/status?per_page=100&page=2": () => Response.json({ state: "failure", sha: "h1", total_count: 101, statuses: [{ id: 200, state: "failure", context: "oupdate/review" }] }),
      }, calls),
    });
    expect(await f.statusOf("o/r", "h1", "oupdate/review")).toBe("failure");
    expect(calls).toHaveLength(2);
  });

  test("setStatus posts state, context and description, cut to GitHub's 140 characters", async () => {
    const calls: Call[] = [];
    const f = githubForge({ token: "t", fetch: fakeFetch({ "POST /repos/o/r/statuses/h1": () => Response.json({}, { status: 201 }) }, calls) });
    await f.setStatus("o/r", "h1", { state: "success", context: "oupdate/review", description: "ok" });
    expect(JSON.parse(calls[0]!.body!)).toEqual({ state: "success", context: "oupdate/review", description: "ok" });
    expect(calls[0]!.headers.get("content-type")).toBe("application/json");
    await f.setStatus("o/r", "h1", { state: "pending", context: "oupdate/review", description: "d".repeat(200) });
    const sent = JSON.parse(calls[1]!.body!).description as string;
    expect(sent).toHaveLength(140);
    expect(sent.endsWith("…")).toBe(true);
  });

  test("upsertComment finds the marker comment on a later page and edits it", async () => {
    const calls: Call[] = [];
    const page1 = Array.from({ length: 100 }, (_, i) => ({ id: 9000 + i, body: `comment ${i}` }));
    const f = githubForge({
      token: "t",
      fetch: fakeFetch({
        "GET /repos/octo-org/app/issues/42/comments?per_page=100&page=1": () => Response.json(page1),
        "GET /repos/octo-org/app/issues/42/comments?per_page=100&page=2": () => Response.json(commentsPage2),
        "PATCH /repos/octo-org/app/issues/comments/9102": () => Response.json({}),
      }, calls),
    });
    await f.upsertComment("octo-org/app", 42, "<!-- oupdate-gate -->", "<!-- oupdate-gate -->\nnew");
    expect(calls.map((c) => `${c.method} ${c.url.replace("https://api.github.com", "")}`)).toEqual([
      "GET /repos/octo-org/app/issues/42/comments?per_page=100&page=1",
      "GET /repos/octo-org/app/issues/42/comments?per_page=100&page=2",
      "PATCH /repos/octo-org/app/issues/comments/9102",
    ]);
    expect(JSON.parse(calls[2]!.body!)).toEqual({ body: "<!-- oupdate-gate -->\nnew" });
  });

  test("upsertComment creates the comment when no page carries the marker", async () => {
    const calls: Call[] = [];
    const f = githubForge({
      token: "t",
      fetch: fakeFetch({
        "GET /repos/o/r/issues/8/comments?per_page=100&page=1": () => Response.json([{ id: 1, body: "hi" }]),
        "POST /repos/o/r/issues/8/comments": () => Response.json({}, { status: 201 }),
      }, calls),
    });
    await f.upsertComment("o/r", 8, "<!-- m -->", "<!-- m -->\nnew");
    expect(calls.at(-1)!.method).toBe("POST");
    expect(JSON.parse(calls.at(-1)!.body!)).toEqual({ body: "<!-- m -->\nnew" });
  });

  test("a failed write throws with the method, path and status", async () => {
    const f = githubForge({ token: "t", fetch: fakeFetch({}, []) });
    await expect(f.setStatus("o/r", "x", { state: "success", context: "c", description: "d" })).rejects.toThrow("forge POST /repos/o/r/statuses/x: 404");
  });
});
