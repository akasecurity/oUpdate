import { describe, expect, test } from "bun:test";
import { githubForge } from "../src/adapters/forge/github.ts";
import { join } from "node:path";

/** Hand-written API responses, trimmed to the fields that matter plus a few around them. */
const fixture = (f: string) => Bun.file(join(import.meta.dir, "fixtures/github", f)).json();
const pullsPage2 = await fixture("pulls-page2.json");
const statuses = await fixture("statuses.json");
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

const pull = (n: number) => ({ number: n, user: { login: "renovate[bot]" }, head: { ref: `renovate/p${n}`, sha: `h${n}`, repo: { full_name: "octo-org/app" } }, base: { ref: "main", sha: "b", repo: { full_name: "octo-org/app" } } });

describe("githubForge plain http", () => {
  test("the token is never sent to a plain http endpoint on a non-loopback host; loopback is allowed", async () => {
    const calls: Call[] = [];
    const bad = githubForge({ token: "t", login: "bot", endpoint: "http://forge.example/api/v3", fetch: fakeFetch({}, calls) });
    await expect(bad.openPulls("o/r")).rejects.toThrow(/token is not sent over plain http/);
    expect(calls).toEqual([]);
    const ok = githubForge({ token: "t", login: "bot", endpoint: "http://127.0.0.1:3000/api/v3", fetch: fakeFetch({}, calls) });
    await ok.openPulls("o/r").catch(() => {});
    expect(calls.length).toBeGreaterThan(0);
  });
});

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
    expect(out[0]).toEqual({ number: 1, headRef: "renovate/p1", headSha: "h1", baseSha: "b", author: "renovate[bot]", headRepo: "octo-org/app", baseRepo: "octo-org/app" });
    expect(out[100]).toEqual({ number: 42, headRef: "dependabot/npm_and_yarn/yaml-2.8.3", headSha: "4b1e5c0a3f2d9e8b7c6a5f4e3d2c1b0a9f8e7d6c", baseSha: "0f9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a2f1e", author: "dependabot[bot]", headRepo: "octo-org/app", baseRepo: "octo-org/app" });
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

  test("changedFiles pages through the PR's files, a rename's old path too; a list at GitHub's 3000 cap throws", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({ filename: `src/f${i}.ts` }));
    const f = githubForge({
      token: "t",
      fetch: fakeFetch({
        "GET /repos/o/r/pulls/7/files?per_page=100&page=1": () => Response.json(page1),
        "GET /repos/o/r/pulls/7/files?per_page=100&page=2": () => Response.json([{ filename: "web/bun.lock", previous_filename: "bun.lock" }]),
      }, []),
    });
    const out = await f.changedFiles("o/r", 7);
    expect(out).toHaveLength(102);
    expect(out.slice(-2)).toEqual(["web/bun.lock", "bun.lock"]);
    const full = Array.from({ length: 100 }, (_, i) => ({ filename: `f${i}` }));
    const routes: Record<string, () => Response> = {};
    for (let p = 1; p <= 31; p++) routes[`GET /repos/o/r/pulls/8/files?per_page=100&page=${p}`] = () => Response.json(p <= 30 ? full : []);
    await expect(githubForge({ token: "t", fetch: fakeFetch(routes, []) }).changedFiles("o/r", 8)).rejects.toThrow(/3000/);
  });

  test("statusOf reads the newest status of our context from the statuses list, with who posted it", async () => {
    const calls: Call[] = [];
    const f = githubForge({ token: "t", fetch: fakeFetch({ "GET /repos/octo-org/app/commits/s1/statuses?per_page=100&page=1": () => Response.json(statuses) }, calls) });
    expect(await f.statusOf("octo-org/app", "s1", "oupdate/review")).toEqual({ state: "success", creator: "mallory" });
    expect(await f.statusOf("octo-org/app", "s1", "ci/build")).toEqual({ state: "success", creator: "ci-bot" });
    expect(await f.statusOf("octo-org/app", "s1", "other")).toBeUndefined();
  });

  test("statusOf pages through more than 100 statuses", async () => {
    const calls: Call[] = [];
    const many = Array.from({ length: 100 }, (_, i) => ({ id: i, state: "success", context: `ci/${i}`, creator: { login: "ci" } }));
    const f = githubForge({
      token: "t",
      fetch: fakeFetch({
        "GET /repos/o/r/commits/h1/statuses?per_page=100&page=1": () => Response.json(many),
        "GET /repos/o/r/commits/h1/statuses?per_page=100&page=2": () => Response.json([{ id: 200, state: "failure", context: "oupdate/review", creator: { login: "gate" } }]),
      }, calls),
    });
    expect(await f.statusOf("o/r", "h1", "oupdate/review")).toEqual({ state: "failure", creator: "gate" });
    expect(calls).toHaveLength(2);
  });

  test("self reads the token's login from /user once, or takes it as given; a GITHUB_TOKEN refusal names --gate-login", async () => {
    const calls: Call[] = [];
    const f = githubForge({ token: "t", fetch: fakeFetch({ "GET /user": () => Response.json({ login: "octo-gate" }) }, calls) });
    expect(await f.self()).toBe("octo-gate");
    expect(await f.self()).toBe("octo-gate");
    expect(calls).toHaveLength(1);
    expect(await githubForge({ token: "t", login: "github-actions[bot]", fetch: fakeFetch({}, []) }).self()).toBe("github-actions[bot]");
    const refused = githubForge({ token: "t", fetch: (async () => Response.json({ message: "Resource not accessible by integration" }, { status: 403 })) as unknown as typeof fetch });
    await expect(refused.self()).rejects.toThrow(/403.*--gate-login github-actions\[bot\]/);
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

  test("upsertComment finds the gate's own marker comment on a later page and edits it", async () => {
    const calls: Call[] = [];
    const page1 = Array.from({ length: 100 }, (_, i) => ({ id: 9000 + i, body: `comment ${i}`, user: { login: "octocat" } }));
    const f = githubForge({
      token: "t",
      login: "github-actions[bot]",
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

  test("ownComment returns only the token's own marker comment, never another user's", async () => {
    const mk = (login: string) => githubForge({
      token: "t",
      login,
      fetch: fakeFetch({ "GET /repos/octo-org/app/issues/42/comments?per_page=100&page=1": () => Response.json(commentsPage2) }, []),
    });
    expect(await mk("oupdate-gate").ownComment("octo-org/app", 42, "<!-- oupdate-gate -->")).toBeUndefined();
    const mine = (commentsPage2 as { user: { login: string }; body: string }[]).find((c) => c.user.login === "github-actions[bot]" && c.body.startsWith("<!-- oupdate-gate -->"))!;
    expect(await mk("github-actions[bot]").ownComment("octo-org/app", 42, "<!-- oupdate-gate -->")).toBe(mine.body);
  });

  test("upsertComment never edits another user's comment carrying the marker", async () => {
    const calls: Call[] = [];
    const f = githubForge({
      token: "t",
      login: "oupdate-gate",
      fetch: fakeFetch({
        "GET /repos/octo-org/app/issues/42/comments?per_page=100&page=1": () => Response.json(commentsPage2),
        "POST /repos/octo-org/app/issues/42/comments": () => Response.json({}, { status: 201 }),
      }, calls),
    });
    await f.upsertComment("octo-org/app", 42, "<!-- oupdate-gate -->", "<!-- oupdate-gate -->\nnew");
    expect(calls.map((c) => c.method)).toEqual(["GET", "POST"]);
  });

  test("upsertComment creates the comment when no page carries the marker", async () => {
    const calls: Call[] = [];
    const f = githubForge({
      token: "t",
      login: "me",
      fetch: fakeFetch({
        "GET /repos/o/r/issues/8/comments?per_page=100&page=1": () => Response.json([{ id: 1, body: "hi", user: { login: "me" } }]),
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
