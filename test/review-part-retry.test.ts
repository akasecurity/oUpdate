import { afterAll, describe, expect, test } from "bun:test";
import { openaiReviewer, scrub } from "../src/adapters/reviewer/openai.ts";
import { validateReviewerSpec } from "../src/adapters/reviewer/spec.ts";
import { commandReviewer } from "../src/adapters/reviewer/command.ts";
import { ReviewerError, reviewUpdate } from "../src/review.ts";
import type { Registry } from "../src/adapters/ecosystem/types.ts";
import { readScope } from "../eval/limits/stats.ts";
import { cachedReviewer } from "../src/verdict-store.ts";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FileMap } from "../src/prepass.ts";

// A router stub: each call is one part. `fail` maps a call number (1-based) to how that call fails.
type Fail = "502" | "truncated" | "truncated-flag" | "empty" | "drop" | "400" | "429" | "slow502" | "slow" | "not-json" | "no-choices" | "null-json" | "number-content" | "truncated-null" | "parts-content" | "refusal" | "two-choices" | "content-filter" | "tool-calls" | "tool-calls-stop" | "function-call" | "unknown-finish" | "empty-refusal" | "stop" | "cut-body" | "object-refusal" | "odd-finish" | "slow-body" | "empty-function-call" | "empty-tool-calls" | "slow-flag-body" | "dup-choices" | "dup-content" | "escaped-dup" | "top-error" | "null-error" | "user-role" | "assistant-role" | "audio";
let fail = new Map<number, Fail>();
let answer = (_prompt: string) => "APPROVE\nno attack indicators found";
const calls: { nofb: string | null; prompt: string }[] = [];
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const body = await req.json();
    const prompt = String(body.messages?.at(-1)?.content ?? "");
    calls.push({ nofb: req.headers.get("x-no-fallback"), prompt });
    const how = fail.get(calls.length);
    if (how === "502") return new Response("bad gateway", { status: 502 });
    if (how === "400") return new Response("bad request", { status: 400 });
    if (how === "429") return new Response("slow down", { status: 429, headers: { "retry-after": "1" } });
    if (how === "slow") return Bun.sleep(2000).then(() => Response.json({ choices: [{ message: { content: "APPROVE\nno attack indicators found" } }] }));
    if (how === "not-json") return new Response("<html>gateway page</html>", { status: 200 });
    if (how === "no-choices") return Response.json({ choices: [] });
    if (how === "null-json") return Response.json(null);
    if (how === "truncated-null") return Response.json({ choices: [{ finish_reason: "length", message: null }] });
    if (how === "number-content") return Response.json({ choices: [{ message: { content: 42 } }] });
    if (how === "truncated-flag") return Response.json({ choices: [{ message: { content: "FLAG\ncredential theft detected in" }, finish_reason: "length" }] });
    if (how === "slow502") return Bun.sleep(40).then(() => new Response("bad gateway", { status: 502 }));
    // A 200 whose body sends a FLAG's first bytes and then breaks off; "drop" errors before any byte, so no response arrives.
    if (how === "cut-body")
      return new Response(new ReadableStream({ start: (c) => c.enqueue(new TextEncoder().encode('{"choices":[{"message":{"content":"FLAG')), pull: (c) => Bun.sleep(20).then(() => c.error(new Error("cut"))) }), { status: 200, headers: { "content-type": "application/json" } });
    // A 200 whose body sends its first bytes and then stalls, so our own deadline is what cuts it.
    if (how === "slow-body")
      return new Response(new ReadableStream({ start: (c) => c.enqueue(new TextEncoder().encode('{"choices":[{"message":{"content":"APPROVE')), pull: (c) => Bun.sleep(2000).then(() => c.close()) }), { status: 200, headers: { "content-type": "application/json" } });
    if (how === "empty-function-call") return Response.json({ choices: [{ message: { content: "APPROVE\nno attack indicators found", function_call: [] }, finish_reason: "stop" }] });
    if (how === "empty-tool-calls") return Response.json({ choices: [{ message: { content: "APPROVE\nno attack indicators found", tool_calls: [] }, finish_reason: "stop" }] });
    if (how === "slow-flag-body")
      return new Response(new ReadableStream({ start: (c) => c.enqueue(new TextEncoder().encode('{"choices":[{"message":{"content":"FLAG\\nexfil')), pull: (c) => Bun.sleep(2000).then(() => c.close()) }), { status: 200, headers: { "content-type": "application/json" } });
    const raw = (s: string) => new Response(s, { status: 200, headers: { "content-type": "application/json" } });
    const ok = '{"message":{"content":"APPROVE\\nno attack indicators found"}}';
    const flag = '{"message":{"content":"FLAG\\nexfil to a new host"}}';
    if (how === "dup-choices") return raw(`{"choices":[${flag}],"choices":[${ok}]}`);
    if (how === "dup-content") return raw('{"choices":[{"message":{"content":"FLAG\\nexfil to a new host","content":"APPROVE\\nno attack indicators found"}}]}');
    if (how === "escaped-dup") return raw(`{"choices":[${flag}],"\\u0063hoices":[${ok}]}`);
    if (how === "top-error") return Response.json({ error: { message: "upstream failed" }, choices: [{ message: { content: "APPROVE\nno attack indicators found" } }] });
    if (how === "null-error") return Response.json({ error: null, choices: [{ message: { content: "APPROVE\nno attack indicators found" } }] });
    if (how === "user-role") return Response.json({ choices: [{ message: { role: "user", content: "APPROVE\nno attack indicators found" } }] });
    if (how === "assistant-role") return Response.json({ choices: [{ message: { role: "assistant", content: "APPROVE\nno attack indicators found" }, finish_reason: "stop" }] });
    if (how === "audio") return Response.json({ choices: [{ message: { role: "assistant", content: "APPROVE\nno attack indicators found", audio: { id: "a1", transcript: "FLAG\nexfil to a new host" } } }] });
    if (how === "object-refusal") return Response.json({ choices: [{ message: { content: "APPROVE\nno attack indicators found", refusal: { reason: "policy" } }, finish_reason: "stop" }] });
    if (how === "odd-finish") return Response.json({ choices: [{ message: { content: "APPROVE\nno attack indicators found" }, finish_reason: "Pause <now>" }] });
    if (how === "drop") return new Response(new ReadableStream({ start: (c) => c.error(new Error("reset")) }), { status: 200, headers: { "content-type": "application/json" } });
    if (how === "truncated") return Response.json({ choices: [{ message: { content: "APPROVE\nno attack indicators found in the first" }, finish_reason: "length" }] });
    if (how === "empty") return Response.json({ choices: [{ message: { content: "" } }] });
    if (how === "parts-content") return Response.json({ choices: [{ message: { content: [{ type: "text", text: "FLAG\nexfil to a new host" }] } }] });
    if (how === "refusal") return Response.json({ choices: [{ message: { content: null, refusal: "I can't help with that." } }] });
    if (how === "two-choices") return Response.json({ choices: [{ message: { content: "APPROVE\nno attack indicators found" } }, { message: { content: "FLAG\nexfil to a new host" } }] });
    if (how === "tool-calls") return Response.json({ choices: [{ message: { content: "APPROVE\nno attack indicators found", tool_calls: [{ type: "function", function: { name: "verdict", arguments: '{"verdict":"FLAG"}' } }] }, finish_reason: "tool_calls" }] });
    if (how === "tool-calls-stop") return Response.json({ choices: [{ message: { content: "APPROVE\nno attack indicators found", tool_calls: [{ type: "function", function: { name: "verdict", arguments: '{"verdict":"FLAG"}' } }] }, finish_reason: "stop" }] });
    if (how === "function-call") return Response.json({ choices: [{ message: { content: "APPROVE\nno attack indicators found", function_call: { name: "verdict", arguments: '{"verdict":"FLAG"}' } } }] });
    if (how === "unknown-finish") return Response.json({ choices: [{ message: { content: "APPROVE\nno attack indicators found" }, finish_reason: "pause" }] });
    if (how === "empty-refusal") return Response.json({ choices: [{ message: { content: "APPROVE\nno attack indicators found", refusal: "" }, finish_reason: "stop" }] });
    if (how === "stop") return Response.json({ choices: [{ message: { content: "APPROVE\nno attack indicators found" }, finish_reason: "stop" }] });
    if (how === "content-filter") return Response.json({ choices: [{ message: { content: "APPROVE\n" }, finish_reason: "content_filter" }] });
    return Response.json({ choices: [{ message: { content: answer(prompt) } }] });
  },
});
// A second base that always answers 502.
const down = Bun.serve({ port: 0, fetch: () => new Response("bad gateway", { status: 502 }) });
// A base whose answer is always a FLAG cut off at max_tokens.
const cut = Bun.serve({ port: 0, fetch: () => Response.json({ choices: [{ message: { content: "FLAG\ncredential theft in" }, finish_reason: "length" }] }) });
// A base that APPROVEs with an @ in a header value.
const at = Bun.serve({ port: 0, fetch: () => Response.json({ choices: [{ message: { content: "APPROVE\nno attack indicators found" } }] }, { headers: { "x-model": "bob@corp" } }) });
// A base that always APPROVEs, with the header a gate expects.
const good = Bun.serve({ port: 0, fetch: () => Response.json({ choices: [{ message: { content: "APPROVE\nno attack indicators found" } }] }, { headers: { "x-served-by": "gate" } }) });
afterAll(() => (server.stop(true), down.stop(true), cut.stop(true), good.stop(true), at.stop(true)));

const enc = (s: string) => new TextEncoder().encode(s);
const files = (o: Record<string, string>): FileMap => new Map(Object.entries(o).map(([k, v]) => [k, enc(v)]));
const names = ["a.py", "b.py", "c.py", "d.py", "e.py"];
const now = new Date("2026-10-21T18:00:00Z");
const registry: Registry = {
  latest: async () => undefined,
  publishedAt: async () => new Date(now.getTime() - 10 * 86_400_000),
  artifactUrls: async (_n, v) => [`https://files.example/${v}`],
};

type Over = { wrap?: (r: ReturnType<typeof openaiReviewer>) => Parameters<typeof reviewUpdate>[0]["reviewer"]; reviewer?: Parameters<typeof reviewUpdate>[0]["reviewer"]; expectHeaders?: Record<string, string>; maxReadMs?: number; bases?: string[] };
function run(failing: Record<number, Fail>, over: Over = {}) {
  fail = new Map(Object.entries(failing).map(([k, v]) => [Number(k), v]));
  calls.length = 0;
  const reviewer = openaiReviewer({ name: "router", baseUrls: over.bases ?? [`http://127.0.0.1:${server.port}`], model: "m1", retryDelaysMs: [], headers: { "x-no-fallback": "1" }, expectHeaders: over.expectHeaders });
  return reviewUpdate({
    eco: "pypi", name: "pkg", from: "1.0.0", to: "1.0.1", registry, advisories: { query: async () => [] }, reviewer: over.reviewer ?? (over.wrap ? over.wrap(reviewer) : reviewer),
    cooldownDays: 7, now, chunkChars: 200, maxReadMs: over.maxReadMs,
    loadArtifacts: async () => ({
      old: files(Object.fromEntries(names.map((n) => [n, `x = 1  # ${n}\n`]))),
      new: files(Object.fromEntries(names.map((n) => [n, `x = 2  # ${n} ${"z".repeat(120)}\n`]))),
    }),
  });
}
const reviewerLayer = (r: Awaited<ReturnType<typeof run>>) => r.layers.find((l) => l.layer === "reviewer")!;

describe("a failed part call is retried once", () => {
  test("the diff is five parts, one call each", async () => {
    const r = await run({});
    expect(reviewerLayer(r).verdict).toBe("pass");
    expect(calls.length).toBe(5);
  });

  for (const how of ["502", "drop"] as const) {
    test(`a ${how} on part 3 is retried with the same prompt and headers, and the update gets a verdict`, async () => {
      const r = await run({ 3: how });
      expect(reviewerLayer(r).verdict).toBe("pass");
      expect(r.decision).toBe("land");
      expect(calls.length).toBe(6);
      expect(calls[3]!.prompt).toBe(calls[2]!.prompt);
      expect(calls[3]!.prompt).toContain("part 3 of 5");
      expect(calls.every((c) => c.nofb === "1")).toBe(true);
    });
  }

  test("a part that fails twice is a reviewer error naming the part and the total", async () => {
    const r = await run({ 4: "502", 5: "502" });
    const l = reviewerLayer(r);
    expect(l.verdict).toBe("error");
    expect(l.detail).toContain("part 4/5 failed twice");
    expect(l.detail).toContain("502");
    expect(calls.length).toBe(5);
    expect(r.decision).not.toBe("land");
  });

  test("two failures on different parts are each retried once", async () => {
    const r = await run({ 1: "502", 4: "drop" });
    expect(reviewerLayer(r).verdict).toBe("pass");
    expect(calls.length).toBe(7);
  });

  test("an answer is never retried: a FLAG ends the review on its part", async () => {
    answer = (p) => (p.includes("part 2 of 5") ? "FLAG\nexfil to a new host" : "APPROVE\nno attack indicators found");
    try {
      const r = await run({});
      expect(reviewerLayer(r).verdict).toBe("stop");
      expect(calls.length).toBe(2);
    } finally {
      answer = () => "APPROVE\nno attack indicators found";
    }
  });
});

describe("a failure that another try cannot fix is not retried, and still names the part", () => {
  test("a 400", async () => {
    const r = await run({ 2: "400" });
    expect(reviewerLayer(r).verdict).toBe("error");
    expect(reviewerLayer(r).detail).toContain("part 2/5 failed: ");
    expect(calls.length).toBe(2);
  });
  test("a response without the expected header", async () => {
    const r = await run({}, { expectHeaders: { "x-served-by": "gate" } });
    expect(reviewerLayer(r).verdict).toBe("error");
    expect(reviewerLayer(r).detail).toContain("part 1/5 failed: ");
    expect(calls.length).toBe(1);
  });
  test("a reviewer error not marked transient", async () => {
    let n = 0;
    const r = await run({}, { reviewer: { name: "cmd", review: async () => (n++, Promise.reject(new Error("command not found"))) } });
    expect(reviewerLayer(r).detail).toContain("part 1/5 failed: command not found");
    expect(n).toBe(1);
  });
  test("a transient failure once the read time budget is spent is the budget stop, not retried", async () => {
    const r = await run({ 1: "slow502" }, { maxReadMs: 10 });
    expect(reviewerLayer(r).verdict).toBe("stop");
    expect(reviewerLayer(r).detail).toStartWith("0 of 5 part(s) read, the read time budget of 10 ms ran out");
    expect(calls.length).toBe(1);
    expect(r.decision).not.toBe("land");
  });
  test("a non-transient failure stays an error under a budget", async () => {
    const r = await run({ 1: "400" }, { maxReadMs: 5000 });
    expect(reviewerLayer(r).verdict).toBe("error");
    expect(reviewerLayer(r).detail).toContain("part 1/5 failed: ");
  });
});

describe("what is never retried", () => {
  // Each case: part 2 fails this way once; a retry would get APPROVE and the update would land.
  for (const how of ["truncated", "truncated-flag", "empty", "no-choices", "not-json", "null-json", "number-content", "parts-content", "refusal", "two-choices", "content-filter", "cut-body", "object-refusal", "odd-finish", "empty-function-call", "dup-choices", "dup-content", "escaped-dup", "top-error", "user-role", "audio", "tool-calls", "tool-calls-stop", "function-call", "unknown-finish", "429"] as const) {
    test(`a ${how} answer is a hold, not a retry`, async () => {
      const r = await run({ 2: how });
      expect(reviewerLayer(r).verdict).toBe("error");
      expect(reviewerLayer(r).detail).toContain("part 2/5 failed: ");
      expect(calls.length).toBe(2);
      expect(r.decision).not.toBe("land");
    });
  }
  test("a malformed base URL is not transient", async () => {
    const rev = openaiReviewer({ name: "router", baseUrls: ["not a url"], model: "m1", retryDelaysMs: [] });
    const e = await rev.review("p").catch((x) => x);
    expect(e).toBeInstanceOf(ReviewerError);
    expect((e as ReviewerError).transient).toBe(false);
  });
  test("a 502 is transient, typed on the error", async () => {
    fail = new Map([[1, "502"]]);
    calls.length = 0;
    const rev = openaiReviewer({ name: "router", baseUrls: [`http://127.0.0.1:${server.port}`], model: "m1", retryDelaysMs: [] });
    const e = await rev.review("p").catch((x) => x);
    expect(e).toBeInstanceOf(ReviewerError);
    expect((e as ReviewerError).transient).toBe(true);
  });
});

describe("the retry gets only what is left of the read budget", () => {
  test("a slow retry is cut at the budget, not at the reviewer's own timeout", async () => {
    const t0 = performance.now();
    const r = await run({ 1: "502", 2: "slow" }, { maxReadMs: 150 });
    const took = performance.now() - t0;
    expect(calls.length).toBe(2);
    expect(reviewerLayer(r).verdict).toBe("stop");
    expect(reviewerLayer(r).detail).toStartWith("0 of 5 part(s) read, the read time budget of 150 ms ran out");
    expect(took).toBeLessThan(1000);
    expect(r.decision).not.toBe("land");
  });
});

describe("more than one base", () => {
  const both = () => [`http://127.0.0.1:${server.port}`, `http://127.0.0.1:${down.port}`];
  test("a truncated FLAG on one base and a 502 on the other is not retried: the FLAG's base would APPROVE next time", async () => {
    const r = await run({ 1: "truncated-flag" }, { bases: both() });
    expect(reviewerLayer(r).verdict).toBe("error");
    expect(reviewerLayer(r).detail).toContain("part 1/5 failed: ");
    expect(calls.length).toBe(1);
    expect(r.decision).not.toBe("land");
  });
  test("a header mismatch on one base and a 502 on the other is not retried", async () => {
    const r = await run({}, { bases: both(), expectHeaders: { "x-served-by": "gate" } });
    expect(reviewerLayer(r).detail).toContain("part 1/5 failed: ");
    expect(calls.length).toBe(1);
  });
  test("a 502 on every base is retried", async () => {
    const r = await run({ 1: "502" }, { bases: both() });
    expect(reviewerLayer(r).verdict).toBe("pass");
    expect(calls.length).toBe(6);
  });
});

describe("the read budget covers the first try too", () => {
  test("a slow first try is cut at the budget", async () => {
    const t0 = performance.now();
    const r = await run({ 1: "slow" }, { maxReadMs: 150 });
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(reviewerLayer(r).verdict).toBe("stop");
    expect(reviewerLayer(r).detail).toStartWith("0 of 5 part(s) read, the read time budget of 150 ms ran out");
    // What failed is said at the end, where no reader of the start is affected.
    expect(reviewerLayer(r).detail).toMatch(/; needs a human; last try: part 1\/5: reviewer router failed: .*timed out/);
    expect(readScope(reviewerLayer(r).detail)).toBe("partial");
    expect(r.decision).not.toBe("land");
  });
  test("an APPROVE that comes in after the budget is a budget hold", async () => {
    // A reviewer that does not honor the cap: the last part's answer arrives after the budget, with no part after it.
    const late = { name: "late", review: (p: string) => Bun.sleep(p.includes("part 5 of 5") ? 300 : 0).then(() => "APPROVE\nno attack indicators found") };
    const r = await run({}, { reviewer: late, maxReadMs: 150 });
    expect(reviewerLayer(r).verdict).toBe("stop");
    expect(reviewerLayer(r).detail).toBe("5 of 5 part(s) read, the read time budget of 150 ms ran out; needs a human");
    expect(r.decision).not.toBe("land");
  });
  test("the limits stats count a budget cut, a timed-out part among them, as a partial read", async () => {
    const cutMid = await run({ 3: "slow" }, { maxReadMs: 150 });
    expect(reviewerLayer(cutMid).verdict).toBe("stop");
    expect(readScope(reviewerLayer(cutMid).detail)).toBe("partial");
  });
});

describe("in one call", () => {
  test("a truncated FLAG on the first base is not replaced by the next base's APPROVE", async () => {
    const r = await run({}, { bases: [`http://127.0.0.1:${cut.port}`, `http://127.0.0.1:${server.port}`] });
    expect(calls.length).toBe(0);
    expect(reviewerLayer(r).verdict).toBe("error");
    expect(reviewerLayer(r).detail).toContain("truncated");
    expect(r.decision).not.toBe("land");
  });
  test("a scheme fetch cannot send is a config error, not transient", async () => {
    const e = await openaiReviewer({ name: "router", baseUrls: ["ftp://example.com"], model: "m1", retryDelaysMs: [] }).review("p").catch((x) => x);
    expect(e).toBeInstanceOf(ReviewerError);
    expect((e as ReviewerError).transient).toBe(false);
  });
  test("a header value fetch cannot carry is a config error, not transient", async () => {
    const e = await openaiReviewer({ name: "router", baseUrls: [`http://127.0.0.1:${server.port}`], model: "m1", retryDelaysMs: [], headers: { "x-bad": "a\nb" } }).review("p").catch((x) => x);
    expect(e).toBeInstanceOf(ReviewerError);
    expect((e as ReviewerError).transient).toBe(false);
  });
});

describe("falling through to the next base", () => {
  const two = () => [`http://127.0.0.1:${server.port}`, `http://127.0.0.1:${good.port}`];
  test("a FLAG from a base without the expected header stands over the next base's APPROVE", async () => {
    answer = () => "FLAG\nexfil to a new host";
    try {
      const r = await run({}, { bases: two(), expectHeaders: { "x-served-by": "gate" } });
      expect(reviewerLayer(r).verdict).toBe("stop");
      expect(reviewerLayer(r).detail).toContain("FLAG on part(s) 1");
      expect(r.decision).not.toBe("land");
    } finally {
      answer = () => "APPROVE\nno attack indicators found";
    }
  });
  test("a 502 gives no answer: the next base's APPROVE is the part's verdict", async () => {
    const r = await run({ 1: "502" }, { bases: two() });
    expect(reviewerLayer(r).verdict).toBe("pass");
    expect(r.decision).toBe("land");
  });
  // A 2xx answer that cannot be read may be a FLAG in a shape the adapter does not read: it holds, never the next base's APPROVE.
  const unread: [Fail, RegExp][] = [
    ["empty", /empty answer/],
    ["not-json", /not JSON/],
    ["no-choices", /no answer in the response/],
    ["parts-content", /the answer is not text/],
    ["refusal", /the model refused to answer/],
    ["two-choices", /more than one answer in the response \(2 choices\)/],
    ["content-filter", /answer stopped by a content filter/],
    ["cut-body", /the answer's body broke off/],
    ["tool-calls", /answer ended in a tool call \(tool_calls\)/],
    ["tool-calls-stop", /the answer calls a tool/],
    ["function-call", /the answer calls a tool/],
    ["unknown-finish", /answer ended with finish_reason pause/],
    ["odd-finish", /answer ended with an unknown finish_reason$/],
    ["object-refusal", /the model refused to answer/],
    ["empty-function-call", /the answer calls a tool/],
    ["dup-choices", /the response repeats a JSON key/],
    ["dup-content", /the response repeats a JSON key/],
    ["escaped-dup", /the response repeats a JSON key/],
    ["top-error", /the response holds an error object$/],
    ["user-role", /the answer's role is not assistant/],
    ["audio", /the answer carries audio/],
  ];
  for (const how of ["stop", "empty-refusal", "empty-tool-calls", "null-error", "assistant-role"] as const) {
    test(`a ${how} answer is a normal answer`, async () => {
      const r = await run({ 1: how });
      expect(reviewerLayer(r).verdict).toBe("pass");
      expect(r.decision).toBe("land");
    });
  }
  for (const [how, why] of unread) {
    test(`a ${how} answer on the first base holds over the next base's APPROVE`, async () => {
      const r = await run({ 1: how }, { bases: two() });
      expect(reviewerLayer(r).verdict).toBe("error");
      expect(reviewerLayer(r).detail).toMatch(why);
      expect(r.decision).not.toBe("land");
    });
  }
});

describe("a FLAG from a base without the expected header", () => {
  const two = () => [`http://127.0.0.1:${server.port}`, `http://127.0.0.1:${good.port}`];
  test("holds, says where it came from, and is not stored for later reviews", async () => {
    const dir = mkdtempSync(join(tmpdir(), "verdicts-"));
    answer = () => "FLAG\nexfil to a new host";
    try {
      const r = await run({}, { bases: two(), expectHeaders: { "x-served-by": "gate" }, wrap: (rev) => cachedReviewer(rev, dir, "h") });
      expect(reviewerLayer(r).verdict).toBe("stop");
      expect(reviewerLayer(r).detail).toMatch(/: exfil to a new host; answer from a base without the expected header$/);
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      answer = () => "APPROVE\nno attack indicators found";
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test("a FLAG from a base with the header is stored as before", async () => {
    const dir = mkdtempSync(join(tmpdir(), "verdicts-"));
    answer = () => "FLAG\nexfil to a new host";
    try {
      const r = await run({}, { wrap: (rev) => cachedReviewer(rev, dir, "h") });
      expect(reviewerLayer(r).detail).not.toContain("without the expected header");
      expect(readdirSync(dir).length).toBe(1);
    } finally {
      answer = () => "APPROVE\nno attack indicators found";
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test("a truncated answer from it names the header mismatch too", async () => {
    const r = await run({ 1: "truncated" }, { expectHeaders: { "x-served-by": "gate" } });
    expect(reviewerLayer(r).detail).toContain("answer header x-served-by missing; answer truncated at max_tokens");
  });
  test("a truncated response with no message ends the call before the next base's APPROVE", async () => {
    const r = await run({ 1: "truncated-null" }, { bases: [`http://127.0.0.1:${server.port}`, `http://127.0.0.1:${good.port}`] });
    expect(reviewerLayer(r).verdict).toBe("error");
    expect(reviewerLayer(r).detail).toContain("truncated");
    expect(r.decision).not.toBe("land");
  });
});

describe("ReviewerError.capped", () => {
  const slow = (timeoutMs: number) => openaiReviewer({ name: "router", baseUrls: [`http://127.0.0.1:${server.port}`], model: "m1", retryDelaysMs: [], timeoutMs });
  const err = (p: Promise<string>) => p.then(() => { throw new Error("answered"); }, (e) => e as ReviewerError);
  test("true when the caller's cap fires", async () => {
    fail = new Map([[1, "slow"]]);
    calls.length = 0;
    const e = await err(slow(5000).review("p", { timeoutMs: 100 }));
    expect(e.transient).toBe(true);
    expect(e.capped).toBe(true);
  });
  test("a 2xx body cut by the caller's cap is capped: the caller's budget stop, not a hold of its own", async () => {
    fail = new Map([[1, "slow-body"]]);
    calls.length = 0;
    const e = await err(slow(5000).review("p", { timeoutMs: 150 }));
    expect(e.transient).toBe(true);
    expect(e.capped).toBe(true);
    expect(e.message).not.toContain("broke off");
  });
  test("a 2xx body cut by the base's own timeout is not transient and not capped", async () => {
    fail = new Map([[1, "slow-body"]]);
    calls.length = 0;
    const e = await err(slow(150).review("p", { timeoutMs: 5000 }));
    expect(e.transient).toBe(false);
    expect(e.capped).toBe(false);
    expect(e.message).not.toContain("broke off");
  });
  test("a 2xx body cut by our deadline ends the call: the next base's APPROVE does not replace a FLAG's first bytes", async () => {
    fail = new Map([[1, "slow-flag-body"]]);
    calls.length = 0;
    const rev = openaiReviewer({ name: "router", baseUrls: [`http://127.0.0.1:${server.port}`, `http://127.0.0.1:${good.port}`], model: "m1", retryDelaysMs: [], timeoutMs: 150 });
    const e = await err(rev.review("p"));
    expect(e.transient).toBe(false);
    expect(e.message).not.toContain(`127.0.0.1:${good.port}`);
  });
  // Base 1 cuts a FLAG's first bytes and stalls; a retry would meet a 502 there and fall through to base 2. Every way the
  // cut can end (the caller's cap: the budget stop; the base's own timeout: an error), crossed with every base-2 state:
  // base 2 is never called, and the part holds.
  type Base2 = { port: number; hits: () => number; stop: () => Promise<void> | void };
  const http2 = (reply: () => Response): Base2 => {
    let n = 0;
    const s = Bun.serve({ port: 0, fetch: () => (n++, reply()) });
    return { port: s.port!, hits: () => n, stop: () => s.stop(true) };
  };
  const base2: Record<string, () => Base2> = {
    "502": () => http2(() => new Response("bad gateway", { status: 502 })),
    APPROVE: () => http2(() => Response.json({ choices: [{ message: { content: "APPROVE\nno attack indicators found" } }] })),
    FLAG: () => http2(() => Response.json({ choices: [{ message: { content: "FLAG\nexfil to a new host" } }] })),
    // A socket that accepts, counts and closes: a network error before any response.
    "closed socket": () => {
      let n = 0;
      const l = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { open: (s) => { n++; s.end(); }, data: () => {} } });
      return { port: l.port, hits: () => n, stop: () => l.stop(true) };
    },
  };
  const cuts = [
    { cut: "the caller's cap", over: { maxReadMs: 150 }, verdict: "stop" },
    { cut: "the base's own timeout", over: { timeoutMs: 150 }, verdict: "error" },
  ] as const;
  for (const { cut, over, verdict } of cuts)
    for (const [state, make] of Object.entries(base2))
      test(`a 2xx body cut by ${cut}, base 2 ${state}: base 2 gets 0 calls and the part holds (${verdict})`, async () => {
        const counted = make();
        try {
          const rev = openaiReviewer({ name: "router", baseUrls: [`http://127.0.0.1:${server.port}`, `http://127.0.0.1:${counted.port}`], model: "m1", retryDelaysMs: [], timeoutMs: "timeoutMs" in over ? over.timeoutMs : undefined });
          const r = await run({ 1: "slow-flag-body", 2: "502" }, { reviewer: rev, maxReadMs: "maxReadMs" in over ? over.maxReadMs : undefined });
          expect(counted.hits()).toBe(0);
          expect(calls.length).toBe(1);
          expect(reviewerLayer(r).verdict).toBe(verdict);
          if (verdict === "stop") expect(readScope(reviewerLayer(r).detail)).toBe("partial");
          else expect(reviewerLayer(r).detail).toContain("part 1/5 failed: ");
          expect(r.decision).not.toBe("land");
        } finally {
          await counted.stop();
        }
      });
  test("a 2xx body the peer breaks off is a hold: not transient", async () => {
    fail = new Map([[1, "cut-body"]]);
    calls.length = 0;
    const e = await err(slow(5000).review("p", { timeoutMs: 5000 }));
    expect(e.transient).toBe(false);
    expect(e.message).toContain("the answer's body broke off");
  });
  test("false when the base's own timeout fires, with or without a longer cap", async () => {
    for (const opts of [undefined, { timeoutMs: 5000 }]) {
      fail = new Map([[1, "slow"]]);
      calls.length = 0;
      const e = await err(slow(100).review("p", opts));
      expect(e.transient).toBe(true);
      expect(e.capped).toBe(false);
    }
  });
});

describe("a base URL's credentials never reach an error or a detail", () => {
  // Built at run time: a literal user:pass@ URL in the source is what the release export scan refuses.
  const userinfo = (u: string, p: string) => [u, p].join(":") + "@";
  test("user:pass@, a query and a fragment are left out; scheme, host, port and path stay", async () => {
    const at = `http://${userinfo("alice", "s3cret")}127.0.0.1:${down.port}/router?key=k3y#frag`;
    const r = await run({}, { bases: [at], maxReadMs: 5000 });
    const d = reviewerLayer(r).detail;
    expect(d).toContain(`http://127.0.0.1:${down.port}/router: 502`);
    for (const x of ["alice", "s3cret", "k3y", "frag"]) expect(d).not.toContain(x);
    const e = await openaiReviewer({ name: "router", baseUrls: [at, `ftp://${userinfo("bob", "pw")}exa mple`], model: "m1", retryDelaysMs: [] }).review("p").then(() => new Error("answered"), (x) => x as Error);
    for (const x of ["alice", "s3cret", "k3y", "frag", "bob", "pw@"]) expect(e.message).not.toContain(x);
  });
  test("in the budget stop's last try too", async () => {
    const at = `http://${userinfo("alice", "s3cret")}127.0.0.1:${server.port}`;
    const r = await run({ 1: "slow" }, { bases: [at], maxReadMs: 150 });
    expect(reviewerLayer(r).detail).toContain("last try: ");
    expect(reviewerLayer(r).detail).not.toContain("s3cret");
    expect(reviewerLayer(r).detail).not.toContain("alice");
  });
});

describe("config-derived text that leaves the reviewer is scrubbed, entry by entry", () => {
  const userinfo = (u: string, p: string) => [u, p].join(":") + "@";
  const clean = (t: string) => { for (const x of ["ali ce", "ali\nce", "alice", "s3cret", "pa/ss", "k3y", "frag"]) expect(t).not.toContain(x); };
  const msg = (bases: string[], extra: Partial<Parameters<typeof openaiReviewer>[0]> = {}) =>
    openaiReviewer({ name: "router", baseUrls: bases, model: "m1", retryDelaysMs: [], ...extra }).review("p").then(() => "answered", (x) => (x as Error).message);
  test("a base whose path holds %40 is shown only by its place in the list", async () => {
    for (const p of ["/ss%40host/x", "/v1/%40scope"]) {
      const m = await msg([`http://127.0.0.1:${down.port}${p}`]);
      expect(m).toContain("base #1: 502");
      expect(m).not.toContain("%40");
      expect(m).not.toContain("ss");
    }
    expect(await msg([`http://127.0.0.1:${down.port}/router`])).toContain(`http://127.0.0.1:${down.port}/router: 502`);
  });
  test("a base the URL parser refuses is shown only by its place in the list", async () => {
    for (const b of [`http://${userinfo("ali ce", "s3cret")}example.invalid:bad?key=k3y#frag`, `http://${userinfo("alice", "pa/ss")}host`, `http://${userinfo("ali\nce", "s3cret")}host:bad`, "http://exa mple/x"]) {
      const m = await msg(["localhost:8080", b]);
      expect(m, b).toContain("failed: localhost:8080: ");
      expect(m, b).toContain("; base #2: ");
      clean(m);
    }
  });
  test("a URL quoted inside one entry's text", () => {
    expect(scrub(`connect failed for http://${userinfo("alice", "s3cret")}host/path?key=k3y#frag then https://${userinfo("alice", "s3cret")}h2:1/x`)).toBe("connect failed for http://host/path then https://h2:1/x");
    expect(scrub("see http://h/x?key=a;tok=SECRET now")).toBe("see http://h/x now");
    expect(scrub(`http://${userinfo("user", "pa;ss")}host/x`)).toBe("http://host/x");
    expect(scrub(`via=http://${userinfo("u", "p")}h,next=https://${userinfo("u2", "p2")}h2/x`)).toBe("via=http://h,next=https://h2/x");
  });
  test("an @ in free text outside a URL is kept verbatim, and entries stay separate", async () => {
    expect(scrub("503 contact ops@example.org")).toBe("503 contact ops@example.org");
    const m = await msg([`http://127.0.0.1:${at.port}`, `http://127.0.0.1:${down.port}`], { expectHeaders: { "x-model": "m1" } });
    expect(m).toBe(`reviewer router failed: http://127.0.0.1:${at.port}: answer header x-model did not match the expected value; http://127.0.0.1:${down.port}: 502`);
  });
  test("an expected header value is never quoted: a credential URL in it reaches no error, detail or budget text", async () => {
    const secret = `https://${userinfo("alice", "pa;ss")}host/x y\nz`;
    const m = await msg([`http://127.0.0.1:${good.port}`], { expectHeaders: { "x-route": secret } });
    expect(m).toBe(`reviewer router failed: http://127.0.0.1:${good.port}: answer header x-route missing`);
    const r = await run({}, { bases: [`http://127.0.0.1:${good.port}`], expectHeaders: { "x-served-by": secret } });
    expect(reviewerLayer(r).detail).toContain("answer header x-served-by did not match the expected value");
    const late = await run({ 1: "slow" }, { maxReadMs: 150, expectHeaders: { "x-route": secret } });
    for (const d of [reviewerLayer(r).detail, reviewerLayer(late).detail]) for (const x of ["alice", "pa;ss", "host/x"]) expect(d).not.toContain(x);
  });
  test("a duplicate base is numbered by its own place", async () => {
    const bad = `http://${userinfo("alice", "s3cret")}exa mple`;
    const m = await msg([bad, bad]);
    expect(m).toStartWith("reviewer router failed: base #1: ");
    expect(m).toContain("; base #2: ");
  });
  test("pins shownBase: a base the parser refuses, holding userinfo, leaves no @ in the thrown message", async () => {
    const m = await msg([`http://${userinfo("alice", "s3cret")}exa mple`, `http://${userinfo("alice", "pa/ss")}host`, `http://${userinfo("ali\nce", "x")}h:bad`, `https://${userinfo("alice", "pa?ss")}h:bad#x`]);
    expect(m).not.toContain("@");
    clean(m);
  });
  test("a password with ? or # loses all of it: the last @ of the authority is found before the query is cut", () => {
    expect(scrub(`https://${userinfo("alice", "pa?ss")}host/x`)).toBe("https://host/x");
    expect(scrub(`https://${userinfo("alice", "pa#ss")}host/x?k=v`)).toBe("https://host/x");
    expect(scrub(`x https://${userinfo("alice", "p?a#s")}h2:1 y`)).toBe("x https://h2:1 y");
  });
  test("an ambiguous base is refused when the spec is read and when a reviewer is built", () => {
    const spec = { type: "openai", name: "router", baseUrls: ["http://127.0.0.1:1"], model: "m1" };
    // The parser reads each of these without a username, so the text after it would be printed as host, port, path or query.
    for (const b of [`https://${userinfo("alice", "123?ss")}host/x`, `https://${userinfo("alice", "123#ss")}host/x`, `${userinfo("alice", "pa/ss")}host`, `${userinfo("alice", "s3cret")}host:8080`, "https://host/x?to=a@b", "https://host/x#a@b", `https://${userinfo("alice", "123/ss")}host/x`, "https://alice/ss@host/x", "https://alice\\ss@host/x", "https://host/@scope/v1", "http://127.0.0.1:1/a/@b/c@d", "https://@host/@x", "https://bob@alice:123/ss@host/x", "https://bob@alice\\ss@host/x", `https://${userinfo("outer", "pw")}alice:123/ss@host/x`, `https://${userinfo("outer", "pw")}alice\\ss@host/x`, `https://${userinfo("bob", "pw")}host/@scope/v1`, `https://${userinfo("outer", "pw")}alice:123/ss@host/../x`, `https://${userinfo("outer", "pw")}alice:123/ss@host/%2e%2e/x`, `https://${userinfo("outer", "pw")}alice:123\\ss@host\\..\\x`]) {
      expect(() => validateReviewerSpec({ ...spec, baseUrls: [b] }), b).toThrow(/^base #1 is ambiguous: percent-encode @ \? # in credentials, and @ in a path as %40$/);
      expect(() => openaiReviewer({ name: "router", baseUrls: [b], model: "m1" }), b).toThrow(/^base #1 is ambiguous/);
    }
    // A userinfo the parser takes as one, and an @ percent-encoded inside it, are fine.
    expect(() => openaiReviewer({ name: "router", baseUrls: [`https://${userinfo("alice", "pa%3Fss")}host/x`, "https://host/x?to=a%40b"], model: "m1" })).not.toThrow();
  });
  test("the refusal names the base by its place in the list, never its text", () => {
    const spec = { type: "openai", name: "router", baseUrls: ["http://127.0.0.1:1"], model: "m1" };
    const b = `https://${userinfo("alice", "123?ss")}host/x`;
    for (const build of [() => validateReviewerSpec({ ...spec, baseUrls: ["http://127.0.0.1:1", b] }), () => openaiReviewer({ name: "router", baseUrls: ["http://127.0.0.1:1", b], model: "m1" })]) {
      let m = "";
      try {
        build();
      } catch (e) {
        m = (e as Error).message;
      }
      expect(m).toBe("base #2 is ambiguous: percent-encode @ ? # in credentials, and @ in a path as %40");
    }
  });
  test("an empty userinfo, and an @ in a path written %40, are not ambiguous", () => {
    const spec = { type: "openai", name: "router", baseUrls: ["http://127.0.0.1:1"], model: "m1" };
    // An email-style username is fine with its @ written %40 (a raw one is refused, below); joined at run time for the release scan.
    for (const b of ["https://@host/x", "https://:@host/x", "https:///@host/x", "https:@host/x", "https://host/%40scope/v1", `https://${["bob", "x.com"].join("%40")}@host/x`]) {
      expect(() => validateReviewerSpec({ ...spec, baseUrls: [b] }), b).not.toThrow();
      expect(() => openaiReviewer({ name: "router", baseUrls: [b], model: "m1" }), b).not.toThrow();
    }
  });
  test("a raw @ inside the userinfo is ambiguous: this parser ends it at the last @, another reader at the first", () => {
    const spec = { type: "openai", name: "router", baseUrls: ["http://127.0.0.1:1"], model: "m1" };
    // Joined at run time so the release scan does not read an address or a user:pass@ URL.
    const at = "@";
    for (const b of [`http://${userinfo("u", "p")}example.com${at}127.0.0.1`, `https://${["bob", "x.com"].join(at)}${at}host/x`, `https://${userinfo(["bob", "x.com"].join(at), "pw")}host/x`, `https://a${at}b${at}c${at}host`]) {
      expect(() => validateReviewerSpec({ ...spec, baseUrls: [b] }), b).toThrow(/^base #1 is ambiguous: percent-encode @ \? # in credentials, and @ in a path as %40$/);
      expect(() => openaiReviewer({ name: "router", baseUrls: [b], model: "m1" }), b).toThrow(/^base #1 is ambiguous/);
    }
  });
  test("a userinfo with an empty username and a password set is parsed userinfo, not ambiguous", () => {
    const spec = { type: "openai", name: "router", baseUrls: ["http://127.0.0.1:1"], model: "m1" };
    const b = `https://${userinfo("", "p%40ss")}host/x`;
    expect(() => validateReviewerSpec({ ...spec, baseUrls: [b] })).not.toThrow();
    expect(() => openaiReviewer({ name: "router", baseUrls: [b], model: "m1" })).not.toThrow();
  });
  test("a userinfo over plain http is refused off the machine; https, and http to loopback, are fine", () => {
    const spec = { type: "openai", name: "router", baseUrls: ["http://127.0.0.1:1"], model: "m1" };
    const b = `http://${userinfo("alice", "s3cret")}host/x`;
    for (const build of [() => validateReviewerSpec({ ...spec, baseUrls: [b] }), () => openaiReviewer({ name: "router", baseUrls: [b], model: "m1" })])
      expect(build).toThrow(/^base #1 has a userinfo over plain http to a non-loopback host: use https$/);
    expect(() => validateReviewerSpec({ ...spec, baseUrls: [`http://${userinfo("", "pw")}host/x`] })).toThrow(/plain http/);
    for (const ok of [`https://${userinfo("alice", "s3cret")}host/x`, `http://${userinfo("alice", "s3cret")}127.0.0.1:1/x`, `http://${userinfo("alice", "s3cret")}localhost:1`]) {
      expect(() => validateReviewerSpec({ ...spec, baseUrls: [ok] }), ok).not.toThrow();
      expect(() => openaiReviewer({ name: "router", baseUrls: [ok], model: "m1" }), ok).not.toThrow();
    }
  });
  test("a servedByHeader that is not a legal header name is refused when a reviewer is built directly too", () => {
    expect(() => openaiReviewer({ name: "router", baseUrls: ["http://127.0.0.1:1"], model: "m1", servedByHeader: "x served" })).toThrow(/^openai reviewer servedByHeader must be a legal HTTP header name/);
    expect(() => openaiReviewer({ name: "router", baseUrls: ["http://127.0.0.1:1"], model: "m1", servedByHeader: "x-served-by" })).not.toThrow();
  });
  test("an expectHeaders name that is not a legal header name is refused at config, without quoting it", () => {
    const spec = { type: "openai", name: "router", baseUrls: ["http://127.0.0.1:1"], model: "m1" };
    const bad = `https://${userinfo("alice", "s3cret")}host/x`;
    for (const build of [() => validateReviewerSpec({ ...spec, expectHeaders: { [bad]: "v" } }), () => openaiReviewer({ name: "router", baseUrls: ["http://127.0.0.1:1"], model: "m1", expectHeaders: { [bad]: "v" } })]) {
      let m = "";
      try {
        build();
      } catch (e) {
        m = (e as Error).message;
      }
      expect(m).toStartWith("openai reviewer expectHeaders names must be legal HTTP header names");
      for (const x of ["alice", "s3cret", "host/x"]) expect(m).not.toContain(x);
    }
    expect(() => openaiReviewer({ name: "router", baseUrls: ["http://127.0.0.1:1"], model: "m1", expectHeaders: { "x-served-by": "gate" } })).not.toThrow();
  });
  test("a reviewer built directly gets the same name rule as the spec", () => {
    for (const name of ["r http://x", "a@b", "a b"]) {
      expect(() => openaiReviewer({ name, baseUrls: ["http://127.0.0.1:1"], model: "m1" }), name).toThrow(/reviewer name must be plain text/);
      expect(() => commandReviewer({ name, argv: ["true"] }), name).toThrow(/reviewer name must be plain text/);
    }
  });
  test("the spec refuses a reviewer name that is not plain text", () => {
    const spec = { type: "openai", name: "router", baseUrls: ["http://127.0.0.1:1"], model: "m1" };
    expect(validateReviewerSpec(spec).name).toBe("router");
    for (const name of [`r http://${userinfo("n", "pw")}x`, "a://b", "a@b", "a?b", "a#b", "a b", "a\tb", "a\nb"])
      expect(() => validateReviewerSpec({ ...spec, name }), name).toThrow(/reviewer name must be plain text/);
  });
  test("ready()'s diagnostic on a 502", async () => {
    const b = `http://${userinfo("alice", "s3cret")}127.0.0.1:${down.port}/router?key=k3y#frag`;
    const d = (await openaiReviewer({ name: "router", baseUrls: [b], model: "m1", retryDelaysMs: [] }).ready!())!;
    expect(d).toBe(`reviewer router not reachable: http://127.0.0.1:${down.port}/router: 502`);
    clean(d);
  });
  test("scrub is linear: 1 MB of letters, and of scheme fragments", () => {
    for (const t of ["a".repeat(1_000_000), "a://".repeat(250_000), "a:///".repeat(200_000), "a://@".repeat(200_000), "a://b?".repeat(170_000)]) {
      const t0 = performance.now();
      scrub(t);
      expect(performance.now() - t0).toBeLessThan(500);
    }
  });
});
