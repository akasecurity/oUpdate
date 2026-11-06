// The download helper of acceptance/run.ts: the direct downloads (package files, the dataset sample) and the JSON lookups it makes
// itself. Each has a time limit that covers the headers and the whole body, so a stall ends with an error naming the url.
// Not covered: the registry lookups (npm artifact urls, publish dates) and the OSV advisory calls the run makes through
// src/adapters, which still use a fetch without a time limit.
// The limit covers the whole download, not the gap between chunks: a very large file on a slow link fails at the limit even while
// data is arriving (pass a longer timeoutMs for such a file).
export const FILE_TIMEOUT_MS = 120_000;
export const JSON_TIMEOUT_MS = 30_000;

export async function get(url: string, opts: { accept?: string; timeoutMs?: number } = {}): Promise<Uint8Array> {
  const timeoutMs = opts.timeoutMs ?? FILE_TIMEOUT_MS;
  try {
    // timeout: false switches off Bun's own 300 s fetch limit, so the limit here is the only one and may be longer than 300 s.
    const init = { headers: { "user-agent": "oupdate-acceptance", ...(opts.accept ? { accept: opts.accept } : {}) }, signal: AbortSignal.timeout(timeoutMs), timeout: false };
    const r = await fetch(url, init as RequestInit);
    if (!r.ok) {
      await r.body?.cancel().catch(() => {}); // do not leave the unread body of an error page open
      throw new Error(`${r.status} ${url}`);
    }
    return new Uint8Array(await r.arrayBuffer());
  } catch (e) {
    // AbortSignal.timeout rejects with a TimeoutError; no caller signal exists here, so any other abort is not ours to relabel.
    if (e instanceof Error && e.name === "TimeoutError") throw new Error(`timed out after ${timeoutMs / 1000} s: ${url}`);
    throw e;
  }
}
