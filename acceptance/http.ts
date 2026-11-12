// The download helper of acceptance/run.ts: the direct downloads (package files, the dataset sample) and the JSON lookups it makes
// itself. Each has a time limit that covers the headers and the whole body, so a stall ends with an error naming the url.
// Not covered: the registry lookups (npm artifact urls, publish dates) and the OSV advisory calls the run makes through
// src/adapters, which still use a fetch without a time limit.
// The limit covers the whole download, not the gap between chunks: a very large file on a slow link fails at the limit even while
// data is arriving (pass a longer timeoutMs for such a file).
export const FILE_TIMEOUT_MS = 120_000;
export const JSON_TIMEOUT_MS = 30_000;

// A bad status keeps its number, the Retry-After header (in ms) and, when the server sent them, the rate-limit headers, so a caller can
// decide whether and how long to wait; the message is "<status> <url>".
export class HttpError extends Error {
  constructor(readonly status: number, url: string, readonly retryAfterMs?: number, readonly rateLimit?: { remaining: number; resetAtMs: number }) {
    super(`${status} ${url}`);
  }
}

// A request that never got a status: the connection failed or the time limit passed. The message is the underlying one. retryable is
// true only for a failure that a later attempt can fix (a reset or refused connection, a timeout, a temporary DNS failure); a missing
// host (NXDOMAIN), a certificate or TLS error and anything unrecognized (a TypeError, a bug) is not.
export class NetworkError extends Error {
  constructor(message: string, readonly retryable: boolean, options?: { cause?: unknown }) {
    super(message, options);
  }
}

const NEVER_RETRY = /ENOTFOUND|NXDOMAIN|CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_|ERR_INVALID|HOSTNAME_MISMATCH/i;
const RETRY_CODE = /^(ECONN|ETIMEDOUT|EPIPE|EAI_AGAIN|ENETUNREACH|ENETDOWN|EHOSTUNREACH|UND_ERR|ConnectionRefused|ConnectionClosed|FailedToOpenSocket)/;
const RETRY_TEXT = /connection (was )?(closed|reset|refused|lost)|socket (hang up|connection was closed)|network|unexpectedly|timed out/i;
export function retryableNetworkFailure(e: unknown): boolean {
  const code = typeof (e as { code?: unknown })?.code === "string" ? (e as { code: string }).code : "";
  const text = e instanceof Error ? e.message : String(e);
  if (NEVER_RETRY.test(code) || NEVER_RETRY.test(text)) return false;
  return RETRY_CODE.test(code) || RETRY_TEXT.test(text);
}

const IMF_DATE = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;

// Retry-After is a whole number of seconds or an HTTP date (IMF-fixdate); anything else ("1.5", "-1", "soon") is ignored.
export function parseRetryAfter(v: string | null | undefined, now = Date.now()): number | undefined {
  if (!v) return undefined;
  const t = v.trim();
  if (/^\d+$/.test(t)) return Number(t) * 1000;
  if (!IMF_DATE.test(t)) return undefined;
  const d = Date.parse(t);
  return Number.isNaN(d) ? undefined : Math.max(0, d - now);
}

function rateLimitOf(h: Headers): { remaining: number; resetAtMs: number } | undefined {
  const rem = h.get("x-ratelimit-remaining"), reset = h.get("x-ratelimit-reset");
  if (rem === null || reset === null || !/^\d+$/.test(rem.trim()) || !/^\d+$/.test(reset.trim())) return undefined;
  return { remaining: Number(rem), resetAtMs: Number(reset) * 1000 };
}

export async function get(url: string, opts: { accept?: string; timeoutMs?: number; fetchImpl?: typeof fetch } = {}): Promise<Uint8Array> {
  const timeoutMs = opts.timeoutMs ?? FILE_TIMEOUT_MS;
  new URL(url); // a malformed url is a caller bug: it throws here, outside the network handling, and is never retried
  try {
    // timeout: false switches off Bun's own 300 s fetch limit, so the limit here is the only one and may be longer than 300 s.
    const init = { headers: { "user-agent": "oupdate-acceptance", ...(opts.accept ? { accept: opts.accept } : {}) }, signal: AbortSignal.timeout(timeoutMs), timeout: false };
    const r = await (opts.fetchImpl ?? fetch)(url, init as RequestInit);
    if (!r.ok) {
      await r.body?.cancel().catch(() => {}); // do not leave the unread body of an error page open
      throw new HttpError(r.status, url, parseRetryAfter(r.headers.get("retry-after")), rateLimitOf(r.headers));
    }
    return new Uint8Array(await r.arrayBuffer());
  } catch (e) {
    // AbortSignal.timeout rejects with a TimeoutError; no caller signal exists here, so any other abort is not ours to relabel.
    if (e instanceof Error && e.name === "TimeoutError") throw new NetworkError(`timed out after ${timeoutMs / 1000} s: ${url}`, true);
    if (e instanceof HttpError || (e instanceof Error && e.name === "AbortError")) throw e;
    throw new NetworkError(e instanceof Error ? e.message : String(e), retryableNetworkFailure(e), { cause: e });
  }
}

export const BACKOFF = { baseMs: 2_000, capMs: 60_000, attempts: 4, totalMs: 60_000 };

// Every attempt was used or the time budget ran out first; the message names the url, the attempts and the last failure.
export class GaveUpError extends Error {}

const hhmm = (ms: number) => new Date(ms).toTimeString().slice(0, 5);
const reason = (e: unknown) => (e instanceof Error ? e.message : String(e));

// get() that retries what a busy server answers with: HTTP 403, 429 and 5xx, and genuine network failures or timeouts (never a malformed
// url, a missing host, a certificate error or another error). Any other status (404, ...) fails at once. One stateless rule, the same
// for every call: up to 4 attempts, waiting 2 s, 4 s and 8 s between them (baseMs, 2x, 4x), each wait with up to 20 % jitter so parallel
// shards drift apart. A Retry-After longer than that delay is honored, and every wait is clamped to capMs (60 s). A 403 or 429 that
// carries x-ratelimit-remaining: 0 waits until x-ratelimit-reset when that is within capMs, and otherwise fails at once with
// "rate limited until HH:MM". The whole call is bounded by totalMs (default 60 s, a real deadline): no request starts after it, a
// request that starts is cut to what is left, and a wait that would pass it gives up. After the last attempt, or at the deadline, the
// error is "gave up after N attempts: <url>: <last error>". Nothing is remembered between calls, so a lasting outage costs at most
// totalMs per call and a server that comes back is used at once. Deadlines use a monotonic clock (now, default performance.now) so a
// wall-clock step cannot extend or cut them; wallNow (default Date.now) is only compared with the epoch time of x-ratelimit-reset.
// fetchImpl, sleep, random, now and wallNow are injectable.
export async function getWithBackoff(
  url: string,
  opts: { accept?: string; timeoutMs?: number; fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void>; random?: () => number; now?: () => number; wallNow?: () => number; attempts?: number; baseMs?: number; capMs?: number; totalMs?: number } = {},
): Promise<Uint8Array> {
  const { attempts = BACKOFF.attempts, baseMs = BACKOFF.baseMs, capMs = BACKOFF.capMs, totalMs = BACKOFF.totalMs } = opts;
  const sleep = opts.sleep ?? ((ms: number) => Bun.sleep(ms));
  const random = opts.random ?? Math.random;
  const now = opts.now ?? (() => performance.now());
  const wallNow = opts.wallNow ?? Date.now;
  const started = now();
  let last: unknown;
  let made = 0;
  for (let i = 0; i < attempts; i++) {
    // A real deadline: no request starts after the budget is used, and one that starts is cut to what is left of it.
    const left = totalMs - (now() - started);
    if (i > 0 && left <= 0) break;
    made++;
    try {
      return await get(url, { ...opts, timeoutMs: Math.max(1, Math.min(opts.timeoutMs ?? FILE_TIMEOUT_MS, left)) });
    } catch (e) {
      last = e;
      const retry = (e instanceof NetworkError && e.retryable) || (e instanceof HttpError && (e.status === 403 || e.status === 429 || e.status >= 500));
      if (!retry) throw e;
      if (i === attempts - 1) break;
      let wait = Math.min(Math.max(e instanceof HttpError ? (e.retryAfterMs ?? 0) : 0, baseMs * 2 ** i) * (1 + 0.2 * random()), capMs);
      if (e instanceof HttpError && (e.status === 403 || e.status === 429) && e.rateLimit && e.rateLimit.remaining === 0) {
        const until = e.rateLimit.resetAtMs - wallNow();
        if (until > capMs) throw new Error(`rate limited until ${hhmm(e.rateLimit.resetAtMs)}: ${url}`);
        wait = Math.min(Math.max(wait, until + 1000), capMs);
      }
      if (now() - started + wait > totalMs) break;
      await sleep(wait);
    }
  }
  throw new GaveUpError(`gave up after ${made} attempts: ${url}: ${reason(last)}`);
}
