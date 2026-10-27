// GitHub (and GitHub Enterprise Server) through its REST API. The gate reports
// with a commit status, not a check run: a status works with both the Actions
// GITHUB_TOKEN (`statuses: write`) and a personal access token, which cannot
// create check runs, and branch protection can require it like any check.

import type { Forge, Pull, Status, StatusState } from "./types.ts";

export interface GithubDeps {
  /** API base, e.g. https://ghe.example/api/v3. Default https://api.github.com. */
  endpoint?: string;
  token: string;
  /**
   * The login the token acts as; unset, it is read from GET /user. The Actions GITHUB_TOKEN cannot read /user:
   * pass "github-actions[bot]" for it.
   */
  login?: string;
  fetch?: typeof fetch;
}

interface ApiPull {
  number: number;
  user?: { login?: string } | null;
  head: { ref: string; sha: string; repo?: { full_name?: string } | null };
  base: { sha: string; repo?: { full_name?: string } | null };
}

const PAGE = 100;
/** GitHub refuses a status description longer than this. */
const DESCRIPTION_MAX = 140;
/** GitHub's cap on the files listed for one PR. */
const FILES_MAX = 3000;

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
  let me: Promise<string> | undefined;
  /** The login the token acts as, asked of the forge once. */
  function self(): Promise<string> {
    me ??= deps.login
      ? Promise.resolve(deps.login)
      : call("GET", "/user").then(async (r) => {
          if (!r.ok) throw new Error(`forge GET /user: ${r.status}; the Actions GITHUB_TOKEN cannot read it, pass --gate-login github-actions[bot]`);
          const u = (await r.json()) as { login?: string };
          if (!u.login) throw new Error("forge GET /user: no login");
          return u.login;
        });
    return me;
  }

  type Comment = { id: number; body: string; user?: { login?: string } | null };
  /** The token's own comment that starts with `marker`, if any. */
  async function own(repo: string, pr: number, marker: string): Promise<Comment | undefined> {
    const me = (await self()).toLowerCase();
    for await (const c of pages(`/repos/${enc(repo)}/issues/${pr}/comments`, list<Comment>)) {
      if (c.body?.startsWith(marker) && c.user?.login?.toLowerCase() === me) return c;
    }
    return undefined;
  }

  return {
    self,
    async openPulls(repo) {
      const out: Pull[] = [];
      for await (const p of pages(`/repos/${enc(repo)}/pulls?state=open`, list<ApiPull>)) {
        out.push({ number: p.number, headRef: p.head.ref, headSha: p.head.sha, baseSha: p.base.sha, author: p.user?.login ?? "", headRepo: p.head.repo?.full_name ?? "", baseRepo: p.base.repo?.full_name ?? "" });
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
    async changedFiles(repo, pr) {
      const out: string[] = [];
      for await (const f of pages(`/repos/${enc(repo)}/pulls/${pr}/files`, list<{ filename: string; previous_filename?: string }>)) {
        out.push(f.filename);
        if (f.previous_filename) out.push(f.previous_filename);
      }
      // GitHub lists at most 3000 files of a PR; past that the list is cut short, so the rest cannot be seen.
      if (out.length >= FILES_MAX) throw new Error(`PR #${pr} changes ${FILES_MAX} or more files, more than GitHub lists`);
      return out;
    },
    async statusOf(repo, sha, context) {
      // The statuses list runs newest first and names who posted each (the combined status does not).
      for await (const s of pages(`/repos/${enc(repo)}/commits/${encodeURIComponent(sha)}/statuses`, list<{ context: string; state: StatusState; creator?: { login?: string } | null }>)) {
        if (s.context === context) return { state: s.state, creator: s.creator?.login ?? "" };
      }
      return undefined;
    },
    async setStatus(repo, sha, status: Status) {
      const chars = Array.from(status.description);
      const description = chars.length > DESCRIPTION_MAX ? chars.slice(0, DESCRIPTION_MAX - 1).join("") + "…" : status.description;
      await json("POST", `/repos/${enc(repo)}/statuses/${encodeURIComponent(sha)}`, { ...status, description });
    },
    async ownComment(repo, pr, marker) {
      return (await own(repo, pr, marker))?.body;
    },
    async upsertComment(repo, pr, marker, body) {
      const mine = await own(repo, pr, marker);
      if (mine) await json("PATCH", `/repos/${enc(repo)}/issues/comments/${mine.id}`, { body });
      else await json("POST", `/repos/${enc(repo)}/issues/${pr}/comments`, { body });
    },
  };
}
