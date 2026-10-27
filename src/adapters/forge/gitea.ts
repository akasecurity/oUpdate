// Gitea (and API-compatible forges) through its REST API v1. The token is a
// personal access token sent as `Authorization: token ...`.

import type { Forge, Pull, Status, StatusState } from "./types.ts";

export interface GiteaDeps {
  endpoint: string; // e.g. https://forge.example/api/v1
  token: string;
  /** The login the token acts as; unset, it is read from GET /user. */
  login?: string;
  fetch?: typeof fetch;
}

interface ApiPull {
  number: number;
  user?: { login?: string };
  head: { ref: string; sha: string; repo?: { full_name?: string } | null };
  base: { sha: string; repo?: { full_name?: string } | null };
}

export function giteaForge(deps: GiteaDeps): Forge {
  const f = deps.fetch ?? fetch;
  const base = deps.endpoint.replace(/\/+$/, "");
  const headers = { authorization: `token ${deps.token}`, accept: "application/json" };

  async function call(method: string, path: string, body?: unknown): Promise<Response> {
    const init: RequestInit = { method, headers: body === undefined ? headers : { ...headers, "content-type": "application/json" } };
    if (body !== undefined) init.body = JSON.stringify(body);
    return f(base + path, init);
  }

  async function json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const r = await call(method, path, body);
    if (!r.ok) throw new Error(`forge ${method} ${path.split("?")[0]}: ${r.status}`);
    return (await r.json()) as T;
  }

  const enc = (repo: string) => repo.split("/").map(encodeURIComponent).join("/");
  let me: Promise<string> | undefined;
  /** The login the token acts as, asked of the forge once. */
  function self(): Promise<string> {
    me ??= deps.login
      ? Promise.resolve(deps.login)
      : json<{ login?: string }>("GET", "/user").then((u) => {
          if (!u.login) throw new Error("forge GET /user: no login");
          return u.login;
        });
    return me;
  }

  /** The token's own comment that starts with `marker`, if any. */
  async function own(repo: string, pr: number, marker: string): Promise<{ id: number; body: string } | undefined> {
    // This endpoint takes no page or limit and returns every comment on the issue (Gitea and Forgejo), so one
    // call sees the marker comment however long the thread is.
    const me = (await self()).toLowerCase();
    const comments = await json<{ id: number; body: string; user?: { login?: string } }[]>("GET", `/repos/${enc(repo)}/issues/${pr}/comments`);
    return comments.find((c) => c.body.startsWith(marker) && c.user?.login?.toLowerCase() === me);
  }

  return {
    self,
    async openPulls(repo) {
      const out: Pull[] = [];
      for (let page = 1; ; page++) {
        const batch = await json<ApiPull[]>("GET", `/repos/${enc(repo)}/pulls?state=open&limit=50&page=${page}`);
        for (const p of batch) out.push({ number: p.number, headRef: p.head.ref, headSha: p.head.sha, baseSha: p.base.sha, author: p.user?.login ?? "", headRepo: p.head.repo?.full_name ?? "", baseRepo: p.base.repo?.full_name ?? "" });
        if (batch.length < 50) return out;
      }
    },
    async readFile(repo, sha, path) {
      const r = await call("GET", `/repos/${enc(repo)}/raw/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(sha)}`);
      if (r.status === 404) return undefined;
      if (!r.ok) throw new Error(`forge GET raw ${path}: ${r.status}`);
      return r.text();
    },
    async changedFiles(repo, pr) {
      const out: string[] = [];
      for (let page = 1; ; page++) {
        const batch = await json<{ filename: string; previous_filename?: string }[]>("GET", `/repos/${enc(repo)}/pulls/${pr}/files?limit=50&page=${page}`);
        for (const f of batch) {
          out.push(f.filename);
          if (f.previous_filename) out.push(f.previous_filename);
        }
        if (batch.length < 50) return out;
      }
    },
    async statusOf(repo, sha, context) {
      const list = await json<{ context: string; status?: StatusState; state?: StatusState; id: number; creator?: { login?: string } }[]>("GET", `/repos/${enc(repo)}/commits/${encodeURIComponent(sha)}/statuses?limit=50`);
      const latest = list.filter((s) => s.context === context).sort((a, b) => b.id - a.id)[0];
      const state = latest?.status ?? latest?.state;
      return state ? { state, creator: latest!.creator?.login ?? "" } : undefined;
    },
    async setStatus(repo, sha, status: Status) {
      await json("POST", `/repos/${enc(repo)}/statuses/${encodeURIComponent(sha)}`, status);
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
