// Gitea (and API-compatible forges) through its REST API v1. The token is a
// personal access token sent as `Authorization: token ...`.

import type { Forge, Pull, Status, StatusState } from "./types.ts";

export interface GiteaDeps {
  endpoint: string; // e.g. https://forge.example/api/v1
  token: string;
  fetch?: typeof fetch;
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

  return {
    async openPulls(repo) {
      const out: Pull[] = [];
      for (let page = 1; ; page++) {
        const batch = await json<{ number: number; head: { ref: string; sha: string }; base: { sha: string } }[]>("GET", `/repos/${enc(repo)}/pulls?state=open&limit=50&page=${page}`);
        for (const p of batch) out.push({ number: p.number, headRef: p.head.ref, headSha: p.head.sha, baseSha: p.base.sha });
        if (batch.length < 50) return out;
      }
    },
    async readFile(repo, sha, path) {
      const r = await call("GET", `/repos/${enc(repo)}/raw/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(sha)}`);
      if (r.status === 404) return undefined;
      if (!r.ok) throw new Error(`forge GET raw ${path}: ${r.status}`);
      return r.text();
    },
    async statusOf(repo, sha, context) {
      const list = await json<{ context: string; status?: StatusState; state?: StatusState; id: number }[]>("GET", `/repos/${enc(repo)}/commits/${encodeURIComponent(sha)}/statuses?limit=50`);
      const mine = list.filter((s) => s.context === context).sort((a, b) => b.id - a.id)[0];
      return mine ? (mine.status ?? mine.state) : undefined;
    },
    async setStatus(repo, sha, status: Status) {
      await json("POST", `/repos/${enc(repo)}/statuses/${encodeURIComponent(sha)}`, status);
    },
    async upsertComment(repo, pr, marker, body) {
      const comments = await json<{ id: number; body: string }[]>("GET", `/repos/${enc(repo)}/issues/${pr}/comments`);
      const mine = comments.find((c) => c.body.startsWith(marker));
      if (mine) await json("PATCH", `/repos/${enc(repo)}/issues/comments/${mine.id}`, { body });
      else await json("POST", `/repos/${enc(repo)}/issues/${pr}/comments`, { body });
    },
  };
}
