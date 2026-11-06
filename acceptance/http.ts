// The download helper of acceptance/run.ts: the direct downloads (package files, the dataset sample) and the JSON lookups it makes
// itself. Each has a time limit that covers the headers and the whole body, so a stall ends with an error naming the url.
// Not covered: the registry lookups (npm artifact urls, publish dates) and the OSV advisory calls the run makes through
// src/adapters, which still use a fetch without a time limit.
export const FILE_TIMEOUT_MS = 120_000;
export const JSON_TIMEOUT_MS = 30_000;

export async function get(url: string, opts: { accept?: string; timeoutMs?: number } = {}): Promise<Uint8Array> {
  const timeoutMs = opts.timeoutMs ?? FILE_TIMEOUT_MS;
  try {
    const r = await fetch(url, { headers: { "user-agent": "oupdate-acceptance", ...(opts.accept ? { accept: opts.accept } : {}) }, signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) throw new Error(`${r.status} ${url}`);
    return new Uint8Array(await r.arrayBuffer());
  } catch (e) {
    if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) throw new Error(`timed out after ${timeoutMs / 1000} s: ${url}`);
    throw e;
  }
}
