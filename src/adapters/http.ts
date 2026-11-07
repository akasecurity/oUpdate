/** How long a registry, forge or advisory request may go without receiving data (the headers, then each piece of the body). A stalled server would otherwise hold a sweep with no sign. */
export const HTTP_IDLE_MS = 60_000;

/** The same for a tarball or wheel download, which can be large and slow: it only has to keep sending. */
export const DOWNLOAD_IDLE_MS = 300_000;

const positive = (raw: string | undefined, dflt: number): number => {
  const n = Number(raw);
  return raw !== undefined && Number.isInteger(n) && n > 0 && n <= 86_400_000 ? n : dflt;
};

/** The idle limit for requests, in milliseconds: OUPDATE_HTTP_IDLE_MS when it is a whole number from 1 to 86400000, else HTTP_IDLE_MS. */
export const httpIdleMs = (env: Record<string, string | undefined> = process.env): number => positive(env.OUPDATE_HTTP_IDLE_MS, HTTP_IDLE_MS);

/** The idle limit for downloads: OUPDATE_DOWNLOAD_IDLE_MS when valid, else DOWNLOAD_IDLE_MS. */
export const downloadIdleMs = (env: Record<string, string | undefined> = process.env): number => positive(env.OUPDATE_DOWNLOAD_IDLE_MS, DOWNLOAD_IDLE_MS);

/**
 * A fetch that fails when the server goes quiet: the limit applies to the wait for the headers and then to the wait for each piece of the
 * body, and starts over whenever data arrives, so a large answer that keeps coming is never cut off while a stalled one is. Bun's own
 * 300 s limit is switched off (`timeout: false`) so this is the only one. A stall rejects the fetch, or the read of the body, with
 * an error that says "timed out after N ms without data" and names the url; any other failure keeps its own message. The caller reads
 * the body as usual and should cancel it when it will not read it (the limit stops with the body).
 */
export async function fetchIdle(f: typeof fetch, url: string | URL, init: RequestInit = {}, ms: number = httpIdleMs()): Promise<Response> {
  const ctl = new AbortController();
  const why = new Error(`timed out after ${ms} ms without data: ${url}`);
  why.name = "TimeoutError";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => clearTimeout(timer);
  const arm = () => { stop(); timer = setTimeout(() => ctl.abort(why), ms); timer.unref?.(); };
  arm();
  let r: Response;
  try {
    r = await f(url, { ...init, signal: ctl.signal, timeout: false } as RequestInit);
    arm();
  } catch (e) {
    stop();
    throw e;
  }
  if (!r.body) {
    stop();
    return r;
  }
  const reader = r.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(c) {
      try {
        const { done, value } = await reader.read();
        if (done) { stop(); c.close(); } else { arm(); c.enqueue(value); }
      } catch (e) {
        stop();
        c.error(e);
      }
    },
    cancel(reason) {
      stop();
      return reader.cancel(reason);
    },
  });
  return new Response(body, { status: r.status, statusText: r.statusText, headers: r.headers });
}
