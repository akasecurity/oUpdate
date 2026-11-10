// Reviewer over any OpenAI-compatible /v1/chat/completions endpoint (a local
// model server, a proxy, or a hosted API). Base URLs are tried in order.

import { checkBaseUrl, checkExpectHeaders, checkReviewerName, checkServedByHeader, loopbackHost } from "./config-rules.ts";
import { parseVerdict, ReviewerError, type Reviewer } from "../../review.ts";

export interface OpenAIReviewerConfig {
  name: string;
  baseUrls: string[];
  model: string;
  apiKeyEnv?: string;
  maxTokens?: number;
  timeoutMs?: number;
  extraBody?: Record<string, unknown>;
  headers?: Record<string, string>;
  /** Response headers a 2xx answer must carry. Names are compared case-insensitively, values exactly. */
  expectHeaders?: Record<string, string>;
  /** Waits before each retry of a 503 or a refused connection (a local model cold-loading); default about 21 s in all. */
  retryDelaysMs?: number[];
  /** The response header that names who served an answer (a router in front of several models). Absent: served-by is not read and stays unknown. */
  servedByHeader?: string;
}

/** The max_tokens a review asks for when the spec sets none. */
export const DEFAULT_MAX_TOKENS = 4096;
/** The temperature every request sends; an extraBody temperature, spread after it, replaces it. */
export const DEFAULT_TEMPERATURE = 0;

const COLD_LOAD_DELAYS_MS = [1000, 2000, 4000, 6000, 8000];

const refused = (e: unknown) => /ECONNREFUSED|ConnectionRefused/.test(`${(e as { code?: string })?.code ?? ""} ${e instanceof Error ? e.message : String(e)}`);

// A 2xx from another server is not an answer. The first mismatch is the reason; this base is not retried.
function unexpectedHeader(headers: Headers, expect: Record<string, string> | undefined): string | undefined {
  if (!expect) return;
  for (const [name, want] of Object.entries(expect)) {
    const got = headers.get(name);
    // Only the header's name: an expected value can be config (a route URL with a credential), a received one is the server's.
    if (got !== want) return got === null ? `answer header ${name} missing` : `answer header ${name} did not match the expected value`;
  }
  return;
}

// Base URL (trimmed, with or without /v1 in any case) to the chat endpoint; a query string stays after the path.
export function chatUrl(base: string): string {
  const u = new URL(base.trim());
  u.pathname = `${u.pathname.replace(/\/+$/, "").replace(/\/v1$/i, "")}/v1/chat/completions`;
  return u.toString();
}

// Plain http is only safe for a key when the request never leaves the machine.
export function keySafeUrl(url: string): boolean {
  const u = new URL(url);
  return u.protocol !== "http:" || loopbackHost(u.hostname);
}

// One tiny request per base, with the review's own cold-load retries. Only an outage holds a review: a refused connection, a
// timeout, or a 502/503/504 that outlasts the retries. Anything that answers (a 2xx, a 4xx, a wrong server, a base the key or
// headers may not be sent to) counts as reachable here, so review() runs and reports its own trouble.
async function probeOutage(cfg: OpenAIReviewerConfig): Promise<string | undefined> {
  const key = cfg.apiKeyEnv ? process.env[cfg.apiKeyEnv] : undefined;
  const hasHeaders = !!cfg.headers && Object.keys(cfg.headers).length > 0;
  const errors: string[] = [];
  for (const [i, base] of cfg.baseUrls.entries()) {
    let url: string;
    try {
      url = chatUrl(base);
      if ((key || hasHeaders) && !keySafeUrl(url)) return undefined;
    } catch {
      return undefined;
    }
    const signal = AbortSignal.timeout(Math.min(cfg.timeoutMs ?? 900_000, 120_000));
    let down: string | undefined;
    for (const wait of [...(cfg.retryDelaysMs ?? COLD_LOAD_DELAYS_MS), undefined]) {
      try {
        const r = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", ...cfg.headers, ...(key ? { authorization: `Bearer ${key}` } : {}) },
          body: JSON.stringify({ model: cfg.model, max_tokens: 1, temperature: DEFAULT_TEMPERATURE, messages: [{ role: "user", content: "ok" }] }),
          signal,
          timeout: false,
          redirect: "manual",
        } as RequestInit);
        await r.body?.cancel().catch(() => {});
        if (![502, 503, 504].includes(r.status)) return undefined;
        down = String(r.status);
        if (r.status !== 503) break;
      } catch (e) {
        const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
        if (!refused(e) && !timedOut) return undefined;
        down = e instanceof Error ? e.message : String(e);
        if (!refused(e)) break;
      }
      if (wait === undefined) break;
      try {
        await new Promise<void>((res, rej) => {
          const t = setTimeout(res, wait);
          signal.addEventListener("abort", () => (clearTimeout(t), rej(signal.reason)), { once: true });
        });
      } catch {
        break;
      }
    }
    errors.push(`${shownBase(base, i)}: ${scrub(down ?? "no response")}`);
  }
  return `reviewer ${cfg.name} not reachable: ${errors.join("; ")}`;
}

// Config-derived text that leaves this adapter (the reason in a thrown error, ready()'s diagnostic) is kept in a budget
// stop's detail, the results store and logs, so a base URL's credentials must not reach it. Never applied to a model's
// answer: that is the model reading package content, and rewriting it could change its verdict line.
// A base is shown by shownBase, which never prints a base it cannot rebuild. Header values are never quoted. Each other
// piece of text (one base's reason) is scrubbed on its own, never the joined message, so an @ in one entry cannot reach
// into the next: token by token (split on whitespace), in each authority (from :// to the next / or the token's end, a ? or
// # in a password included) everything up to its last @ first, then from the token's first scheme:// the query and fragment
// to the token's end. Linear. The reviewer's name is plain by construction (the spec refuses one that is not).
// Known limits: in free text a URL with a space in it is not read as one URL, a "/" inside a userinfo ends the authority
// early, and a URL with no path whose query holds an @ (http://h?k=a@b) loses its host instead (shown as http://b). Only
// shownBase protects bases (and checkBaseUrl refuses an ambiguous one at config time); Bun's fetch errors do not quote URLs,
// so what is left for scrub is our own text.
export function scrub(s: string): string {
  return s.split(/(\s+)/).map(scrubToken).join("");
}
function scrubToken(t: string): string {
  let i = t.indexOf("://");
  if (i < 0) return t;
  const first = i;
  let out = "";
  let from = 0;
  while (i >= 0) {
    const start = i + 3;
    let end = start;
    let at = -1;
    for (; end < t.length && t[end] !== "/"; end++) if (t[end] === "@") at = end;
    out += t.slice(from, start);
    from = at >= 0 ? at + 1 : start;
    // From the stop: when it is the first / of the next scheme's ://, that :// starts one character before it.
    i = t.indexOf("://", Math.max(end - 1, start));
  }
  // The text before the first :// is unchanged, so `first` still points at it.
  const done = out + t.slice(from);
  const q = done.slice(first).search(/[?#]/);
  return q >= 0 ? done.slice(0, first + q) : done;
}
// Plain host[:port][/path] text, with nothing in it that could be a credential, a query or a fragment.
const PLAIN_BASE = /^[A-Za-z0-9.:[\]_-]+(?:\/[A-Za-z0-9._~/-]*)?$/;
/** A base as an error shows it: scheme://host[:port]/path when it parses with a host and its path holds no @ or %40 (a
 * password whose @ was written %40 can sit there); a plain host:port text as written; anything else only by its place in
 * the list, never its text. */
function shownBase(base: string, i: number): string {
  try {
    const u = new URL(base.trim());
    // A base with no scheme parses with its host as the scheme (localhost:8080 has protocol "localhost:"): only a URL with a host is rebuilt.
    if (u.host && !/@|%40/i.test(u.pathname)) return `${u.protocol}//${u.host}${u.pathname === "/" ? "" : u.pathname}`;
  } catch {}
  return PLAIN_BASE.test(base.trim()) ? base.trim() : `base #${i + 1}`;
}

// A name the headers object refuses leaves served-by unknown; it never costs the answer.
function readServedBy(headers: Headers, name: string | undefined): string | undefined {
  if (!name) return undefined;
  try {
    return headers.get(name)?.trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * A reviewer behind an OpenAI-compatible chat endpoint, tried base by base. A base that gives no answer (a non-2xx or a
 * network failure) falls through to the next, and so does an APPROVE from a base without the expected header; any FLAG
 * from any base stands. A 2xx answer that cannot be read (not JSON, no choice or more than one, a refusal, content that
 * is not text or is empty, a body the peer breaks off, a finish_reason other than "stop", a tool call) ends the call: it
 * holds. A 2xx body our own deadline cuts ends the call too (it may have begun a FLAG) and is never retried: cut by the
 * caller's cap it is a capped error (the caller's budget stop), cut by the base's own timeout a non-transient one. A failed
 * call throws ReviewerError, transient only when every base tried failed with a 5xx or 408, a network error or a timeout.
 */
export function openaiReviewer(cfg: OpenAIReviewerConfig): Reviewer {
  checkReviewerName(cfg.name);
  cfg.baseUrls.forEach((b, i) => checkBaseUrl(b, i));
  checkExpectHeaders(cfg.expectHeaders);
  checkServedByHeader(cfg.servedByHeader);
  let served: string | undefined;
  let unverified = false;
  return {
    name: cfg.name,
    ready: () => probeOutage(cfg),
    lastServedBy: () => served,
    lastUnverified: () => unverified,
    async review(prompt, opts) {
      served = undefined;
      unverified = false;
      const key = cfg.apiKeyEnv ? process.env[cfg.apiKeyEnv] : undefined;
      const errors: string[] = [];
      // The call's failure is transient only when every base failed in a way another try can get past: a 5xx or 408, or a
      // network error or timeout. Anything else on any base vetoes a retry: a bad base URL, a skipped base, a redirect,
      // another 4xx (429 too: its wait is not honored), a header mismatch, a body that is no JSON or not the chat shape,
      // no answer, an empty answer or a cut-off one, a 2xx body the peer breaks off (the same prompt at temperature 0 and
      // the same max_tokens fails the same way again, and a cut-off FLAG must stay a hold, not become another base's APPROVE
      // on the retry). A 2xx body cut by our own deadline is never retried either: a retry that met a 502 on that base
      // would fall through to another base's APPROVE. Cut by the caller's cap it stays capped (transient), which the caller
      // reads as its budget stop, never a retry; cut by the base's own timeout it is not transient.
      let transient = true;
      // Set when the caller's time cap (opts.timeoutMs) is what ended a base: its deadline fired, or none was left to try it.
      let capped = false;
      let at = 0; // the place in the list of the base being tried, for "base #i"
      const fail = (base: string, why: string, again = false) => {
        errors.push(`${shownBase(base, at)}: ${scrub(why)}`);
        if (!again) transient = false;
      };
      // The caller's cap covers every base and every try in this call.
      const deadline = opts?.timeoutMs !== undefined ? Date.now() + opts.timeoutMs : undefined;
      for (const [i, base] of cfg.baseUrls.entries()) {
        at = i;
        let url: string;
        try {
          // A base is taken with or without its /v1, as OpenAI clients take it.
          url = chatUrl(base);
        } catch (e) {
          fail(base, e instanceof Error ? e.message : String(e));
          continue;
        }
        // Fetch throws for a scheme it cannot send and for a header value it cannot carry, just as it does for a network
        // error: both are checked here, so what the network part below catches is the network.
        if (!/^https?:$/.test(new URL(url).protocol)) {
          fail(base, "skipped, not an http or https URL");
          continue;
        }
        let headers: Headers;
        try {
          headers = new Headers({ "content-type": "application/json", ...cfg.headers, ...(key ? { authorization: `Bearer ${key}` } : {}) });
        } catch {
          fail(base, "skipped, a configured header is not valid");
          continue;
        }
        const left = deadline === undefined ? undefined : deadline - Date.now();
        if (left !== undefined && left <= 0) {
          capped = true;
          fail(base, "skipped, the call's time is spent", true);
          continue;
        }
        if (key && !keySafeUrl(url)) {
          fail(base, `skipped, the ${cfg.apiKeyEnv} key is not sent over plain http to a non-loopback host (use https)`);
          continue;
        }
        // Configured headers often carry a credential too (an api-key header), so they follow the same rule.
        if (cfg.headers && Object.keys(cfg.headers).length && !keySafeUrl(url)) {
          fail(base, "skipped, the configured headers are not sent over plain http to a non-loopback host (use https)");
          continue;
        }
        // The network part: only a failure here is transient.
        let r: Response | undefined;
        // One deadline for this base, retries included; a fallback base gets its own. The caller's cap, when it is the shorter.
        const own = cfg.timeoutMs ?? 900_000;
        const signal = AbortSignal.timeout(Math.min(own, left ?? Infinity));
        try {
          const send = () => fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify({
              model: cfg.model,
              max_tokens: cfg.maxTokens ?? DEFAULT_MAX_TOKENS,
              temperature: DEFAULT_TEMPERATURE,
              messages: [{ role: "user", content: prompt }],
              ...cfg.extraBody,
            }),
            signal,
            // Bun's fetch has its own 300 s default; slow local models need the signal alone.
            timeout: false,
            // keySafeUrl vets this URL only: a followed redirect would carry the key, or a credential in the
            // configured headers, on to wherever it points. Never followed, keyed or not.
            redirect: "manual",
          } as RequestInit);
          for (const wait of [...(cfg.retryDelaysMs ?? COLD_LOAD_DELAYS_MS), undefined]) {
            try {
              r = await send();
              if (r.status !== 503) break;
              if (wait !== undefined) await r.body?.cancel().catch(() => {});
            } catch (e) {
              if (!refused(e) || wait === undefined) throw e;
            }
            if (wait === undefined) break;
            await new Promise<void>((res, rej) => {
              const t = setTimeout(res, wait);
              signal.addEventListener("abort", () => (clearTimeout(t), rej(signal.reason)), { once: true });
            });
          }
          if (!r) throw new Error("no response");
          if (!r.ok) await r.body?.cancel().catch(() => {});
        } catch (e) {
          if (signal.aborted && left !== undefined && left < own) capped = true;
          fail(base, e instanceof Error ? e.message : String(e), true);
          continue;
        }
        if (r.status >= 300 && r.status < 400) {
          fail(base, `redirect (${r.status}) not followed, the key and headers go only to the configured URL`);
          continue;
        }
        if (!r.ok) {
          fail(base, String(r.status), r.status >= 500 || r.status === 408);
          continue;
        }
        // A response without the expected header is no verdict this reviewer vouches for, but its body is still read: a FLAG
        // in it stands (a hold costs nothing), only its APPROVE is refused.
        const mismatch = unexpectedHeader(r.headers, cfg.expectHeaders);
        const why = (s: string) => mismatch ?? s;
        // From here the base answered with a 2xx. An answer it gave that cannot be read ends the call (a hold): the model may
        // have said FLAG in a shape this adapter does not read, and another base's APPROVE must not replace it. Only a base
        // that gave no answer at all (a non-2xx, a network failure) falls through to the next.
        // A body the peer breaks off after the 200 may have held a FLAG cut off in transit: a hold, never a retry or the next
        // base. One our own deadline cut ends the call as well, since its first bytes may have been a FLAG, and is not retried:
        // capped when the caller's cap fired (the caller's budget stop), else not transient.
        let raw: string;
        try {
          raw = await r.text();
        } catch (e) {
          const m = e instanceof Error ? e.message : String(e);
          if (signal.aborted) {
            const byCap = left !== undefined && left < own;
            if (byCap) capped = true;
            fail(base, m, byCap);
            break;
          }
          fail(base, why(`the answer's body broke off: ${m}`));
          break;
        }
        let body: unknown;
        try {
          body = JSON.parse(raw);
        } catch {
          fail(base, why("the response is not JSON"));
          break;
        }
        const choices = body && typeof body === "object" ? (body as { choices?: unknown }).choices : undefined;
        if (Array.isArray(choices) && choices.length > 1) {
          fail(base, why(`more than one answer in the response (${choices.length} choices)`));
          break;
        }
        const choice = Array.isArray(choices) && choices[0] && typeof choices[0] === "object" ? (choices[0] as { message?: unknown; finish_reason?: unknown }) : undefined;
        // Only an answer that ended on its own (finish_reason "stop", or none given) is a verdict. A cut-off answer can start
        // APPROVE and lose the FLAG that followed, and a tool call can carry the verdict outside the text. It is checked
        // before the answer's shape, so the error says why the answer stopped.
        const end = choice?.finish_reason;
        if (end !== undefined && end !== null && end !== "stop") {
          const stop =
            end === "length" ? `answer truncated at max_tokens (${cfg.maxTokens ?? DEFAULT_MAX_TOKENS})`
            : end === "content_filter" ? "answer stopped by a content filter"
            : end === "tool_calls" || end === "function_call" ? `answer ended in a tool call (${end})`
            : typeof end === "string" && /^[a-z_]{1,32}$/.test(end) ? `answer ended with finish_reason ${end}`
            : "answer ended with an unknown finish_reason";
          fail(base, `${mismatch ? `${mismatch}; ` : ""}${stop}`);
          break;
        }
        const message = choice?.message && typeof choice.message === "object" ? (choice.message as { content?: unknown; refusal?: unknown; tool_calls?: unknown; function_call?: unknown }) : undefined;
        if (!choice || !message) {
          fail(base, why("no answer in the response"));
          break;
        }
        // Any refusal holds but a blank string (one beside a normal answer is no refusal): an object is a refusal too.
        if (message.refusal !== undefined && message.refusal !== null && !(typeof message.refusal === "string" && message.refusal.trim() === "")) {
          fail(base, why("the model refused to answer"));
          break;
        }
        // An empty tool_calls list is no call (some servers always send one); any function_call that is not null is one.
        const tools = message.tool_calls;
        const calls = Array.isArray(tools) ? tools.length > 0 : tools !== undefined && tools !== null;
        if (calls || (message.function_call !== undefined && message.function_call !== null)) {
          fail(base, why("the answer calls a tool"));
          break;
        }
        if (message.content !== undefined && message.content !== null && typeof message.content !== "string") {
          fail(base, why("the answer is not text"));
          break;
        }
        // A thinking model may put its reasoning ahead of the answer; line 1 must be the verdict.
        const text = (message.content ?? "").replace(/^\s*<think>[\s\S]*?<\/think>\s*/, "");
        if (!text.trim()) {
          fail(base, why("empty answer"));
          break;
        }
        if (mismatch && parseVerdict(text) !== "FLAG") {
          fail(base, mismatch);
          continue;
        }
        served = readServedBy(r.headers, cfg.servedByHeader);
        unverified = !!mismatch;
        return text;
      }
      const again = transient && errors.length > 0;
      throw new ReviewerError(`reviewer ${cfg.name} failed: ${errors.join("; ")}`, again, again && capped);
    },
  };
}
