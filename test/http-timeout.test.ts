import { afterAll, describe, expect, test } from "bun:test";
import { npmIntegrity, npmRegistry } from "../src/adapters/ecosystem/npm.ts";
import { pypiRegistry } from "../src/adapters/ecosystem/pypi.ts";
import { osvFeed } from "../src/adapters/advisory/osv.ts";
import { reviewUpdate } from "../src/review.ts";

// Three local servers: one that answers, one that never answers, one that sends the headers and then stalls the body.
const servers: ReturnType<typeof Bun.serve>[] = [];
const serve = (fetch: (req: Request) => Response | Promise<Response>, ) => {
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch, idleTimeout: 0 });
  servers.push(s);
  return `http://127.0.0.1:${s.port}`;
};
afterAll(() => { for (const s of servers) s.stop(true); });

const never = serve(() => new Promise<Response>(() => {}));
const stall = serve(() => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{"results":[')); } }), { headers: { "content-type": "application/json" } }));
const MS = 150;

const timedOut = (p: Promise<unknown>) => p.then(() => { throw new Error("resolved"); }, (e: Error) => e.message);

describe("a stalled request fails instead of hanging", () => {
  test("npm packument: no answer", async () => {
    const t = Date.now();
    expect(await timedOut(npmRegistry({ base: never, timeoutMs: MS }).latest("yaml"))).toMatch(/^timed out after 150 ms without data: /);
    expect(Date.now() - t).toBeLessThan(5000);
  });
  test("npm packument: body stalls after the headers", async () => {
    expect(await timedOut(npmRegistry({ base: stall, timeoutMs: MS }).latest("yaml"))).toMatch(/^timed out after 150 ms without data: /);
  });
  test("npm per-version document: no answer", async () => {
    expect(await timedOut(npmIntegrity("yaml", "1.0.0", { base: never, timeoutMs: MS }))).toMatch(/^timed out after 150 ms without data: /);
  });
  test("pypi: no answer and a stalled body", async () => {
    expect(await timedOut(pypiRegistry({ base: never, timeoutMs: MS }).latest("requests"))).toMatch(/^timed out after 150 ms without data: /);
    expect(await timedOut(pypiRegistry({ base: stall, timeoutMs: MS }).publishedAt("requests", "1.0.0"))).toMatch(/^timed out after 150 ms without data: /);
  });
  test("osv querybatch: no answer and a stalled body", async () => {
    const pkg = [{ ecosystem: "npm", name: "yaml", version: "1.0.0" }];
    expect(await timedOut(osvFeed({ base: never, timeoutMs: MS }).query(pkg))).toMatch(/^timed out after 150 ms without data: /);
    expect(await timedOut(osvFeed({ base: stall, timeoutMs: MS }).query(pkg))).toMatch(/^timed out after 150 ms without data: /);
  });
  test("osv vuln detail: no answer", async () => {
    const base = serve((req) => (new URL(req.url).pathname.endsWith("/querybatch") ? Response.json({ results: [{ vulns: [{ id: "GHSA-x" }] }] }) : new Promise<Response>(() => {})));
    expect(await timedOut(osvFeed({ base, timeoutMs: MS }).query([{ ecosystem: "npm", name: "yaml", version: "1.0.0" }]))).toMatch(/^timed out after 150 ms without data: .*vulns\/GHSA-x/);
  });
  test("an error that is not a timeout keeps its own message", async () => {
    const refused = serve(() => new Response("x"));
    const dead = refused.replace(/:\d+$/, ":1");
    expect(await timedOut(npmRegistry({ base: dead, timeoutMs: MS }).latest("yaml"))).not.toMatch(/timed out/);
  });
  test("a timeout is an error layer in the review, the same as an unreachable registry", async () => {
    const r = await reviewUpdate({
      eco: "npm", name: "yaml", from: "1.0.0", to: "1.0.1",
      registry: npmRegistry({ base: never, timeoutMs: MS }), advisories: osvFeed({ base: never, timeoutMs: MS }),
      cooldownDays: 7, now: new Date(), only: ["cooldown", "advisory"], reviewer: undefined, loadArtifacts: async () => ({ old: new Map(), new: new Map() }),
    });
    for (const layer of ["cooldown", "advisory"]) {
      const l = r.layers.find((x) => x.layer === layer)!;
      expect(l.verdict).toBe("error");
      expect(l.detail).toMatch(/timed out after 150 ms without data/);
    }
    expect(r.decision).not.toBe("land");
  });
});

describe("the normal path is unchanged", () => {
  const ok = serve((req) => {
    const p = new URL(req.url).pathname;
    if (p === "/yaml") return Response.json({ "dist-tags": { latest: "2.8.3" }, time: {}, versions: {} });
    if (p === "/missing") return new Response("no", { status: 404 });
    if (p === "/querybatch") return Response.json({ results: [{}] });
    return new Response("boom", { status: 500 });
  });
  test("200 parses, 404 is undefined, 500 throws the registry status", async () => {
    expect(await npmRegistry({ base: ok }).latest("yaml")).toBe("2.8.3");
    expect(await npmRegistry({ base: ok }).latest("missing")).toBeUndefined();
    expect(await timedOut(npmRegistry({ base: ok }).latest("other"))).toMatch(/^registry 500 for /);
  });
  test("osv answers and an HTTP error still throws its status", async () => {
    expect(await osvFeed({ base: ok }).query([{ ecosystem: "npm", name: "yaml", version: "1.0.0" }])).toEqual([]);
    expect(await timedOut(osvFeed({ base: ok + "/x" }).query([{ ecosystem: "npm", name: "yaml", version: "1.0.0" }]))).toMatch(/^osv 500 for querybatch/);
  });
  test("requests carry a signal and turn off Bun's own limit", async () => {
    const seen: RequestInit[] = [];
    const f = (async (_u: unknown, init?: RequestInit) => (seen.push(init!), Response.json({ "dist-tags": {}, time: {}, versions: {} }))) as typeof fetch;
    await npmRegistry({ fetch: f }).latest("yaml");
    await osvFeed({ fetch: f }).query([]);
    await osvFeed({ fetch: (async (_u: unknown, init?: RequestInit) => (seen.push(init!), Response.json({ results: [{}] }))) as typeof fetch }).query([{ ecosystem: "npm", name: "a", version: "1" }]);
    expect(seen.length).toBe(2);
    for (const init of seen) { expect(init.signal).toBeInstanceOf(AbortSignal); expect((init as { timeout?: boolean }).timeout).toBe(false); }
  });
});
