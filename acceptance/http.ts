// The acceptance run's one download helper. Every request has a time limit that covers the headers and the whole body, so a
// stalled download ends with an error naming the url instead of holding the run until an outer cap.
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
