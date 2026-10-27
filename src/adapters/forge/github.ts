// GitHub (and GitHub Enterprise Server) through its REST API. The gate reports
// with a commit status, not a check run: a status works with both the Actions
// GITHUB_TOKEN (`statuses: write`) and a personal access token, which cannot
// create check runs, and branch protection can require it like any check.

import type { Forge, Pull, Status, StatusState } from "./types.ts";

export interface GithubDeps {
  /** API base, e.g. https://ghe.example/api/v3. Default https://api.github.com. */
  endpoint?: string;
  token: string;
  fetch?: typeof fetch;
}

const PAGE = 100;
/** GitHub refuses a status description longer than this. */
const DESCRIPTION_MAX = 140;

export function githubForge(deps: GithubDeps): Forge {
  const f = deps.fetch ?? fetch;
  const base = (deps.endpoint ?? "https://api.github.com").replace(/\/+$/, "");
  const headers = { authorization: `Bearer ${deps.token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" };

  async function call(method: string, path: string, body?: unknown, accept?: string): Promise<Response> {
    const h: Record<string, string> = { ...headers };
    if (accept) h.accept = accept;
    if (body !== undefined) h["content-type"] = "application/json";
    const init: RequestInit = { method, headers: h };
    if (body !== undefined) init.body = JSON.stringify(body);
    return f(base + path, init);
  }

  async function json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const r = await call(method, path, body);
    if (!r.ok) throw new Error(`forge ${method} ${path.split("?")[0]}: ${r.status}`);
    return (await r.json()) as T;
  }

  /** Every item of a list endpoint, PAGE at a time, until a short page; the caller may stop early. */
  async function* pages<T>(path: string, items: (page: unknown) => T[]): AsyncGenerator<T> {
    const sep = path.includes("?") ? "&" : "?";
    for (let page = 1; ; page++) {
      const batch = items(await json<unknown>("GET", `${path}${sep}per_page=${PAGE}&page=${page}`));
      yield* batch;
      if (batch.length < PAGE) return;
    }
  }

  const enc = (repo: string) => repo.split("/").map(encodeURIComponent).join("/");
  const list = <T>(p: unknown) => p as T[];

  return {
    async openPulls(repo) {
      const out: Pull[] = [];
      for await (const p of pages(`/repos/${enc(repo)}/pulls?state=open`, list<{ number: number; head: { ref: string; sha: string }; base: { sha: string } }>)) {
        out.push({ number: p.number, headRef: p.head.ref, headSha: p.head.sha, baseSha: p.base.sha });
      }
      return out;
    },
    async readFile(repo, sha, path) {
      // The raw media type returns the bytes themselves, up to 100 MB; the default JSON response carries base64
      // content only up to 1 MB, which a large package-lock.json passes.
      const r = await call("GET", `/repos/${enc(repo)}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(sha)}`, undefined, "application/vnd.github.raw+json");
      if (r.status === 404) return undefined;
      if (!r.ok) throw new Error(`forge GET contents ${path}: ${r.status}`);
      return r.text();
    },
    async statusOf(repo, sha, context) {
      // The combined status holds the latest status per context.
      for await (const s of pages(`/repos/${enc(repo)}/commits/${encodeURIComponent(sha)}/status`, (p) => (p as { statuses: { context: string; state: StatusState }[] }).statuses)) {
        if (s.context === context) return s.state;
      }
      return undefined;
    },
    async setStatus(repo, sha, status: Status) {
      const chars = Array.from(status.description);
      const description = chars.length > DESCRIPTION_MAX ? chars.slice(0, DESCRIPTION_MAX - 1).join("") + "…" : status.description;
      await json("POST", `/repos/${enc(repo)}/statuses/${encodeURIComponent(sha)}`, { ...status, description });
    },
    async upsertComment(repo, pr, marker, body) {
      for await (const c of pages(`/repos/${enc(repo)}/issues/${pr}/comments`, list<{ id: number; body: string }>)) {
        if (c.body?.startsWith(marker)) {
          await json("PATCH", `/repos/${enc(repo)}/issues/comments/${c.id}`, { body });
          return;
        }
      }
      await json("POST", `/repos/${enc(repo)}/issues/${pr}/comments`, { body });
    },
  };
}
