import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openaiReviewer } from "../../src/adapters/reviewer/openai.ts";
import type { Reviewer } from "../../src/review.ts";
import { addTallies, newTally, publicTally, restoreTally, servedLine, servedValuesRefusal, snapshotTally, trackServed } from "./served.ts";

const fake = (served: (string | undefined)[]): Reviewer => {
  let i = 0, cur: string | undefined;
  return { name: "r", review: async () => { cur = served[i++]; return "APPROVE"; }, lastServedBy: () => cur };
};

test("each call is counted by its served-by value, and calls not served by the requested model are counted apart", async () => {
  const t = newTally();
  const r = trackServed(fake(["m1", "m1", "other", undefined, "M1"]), "m1", t);
  for (let i = 0; i < 5; i++) await r.review("x");
  expect(t).toEqual({ calls: 5, by_value: { m1: 2, M1: 1, other: 1 }, not_requested: 1, unknown: 1 });
});

test("a reviewer that cannot say who served counts every call unknown", async () => {
  const t = newTally();
  const r = trackServed({ name: "r", review: async () => "APPROVE" }, "m1", t);
  await r.review("x");
  await r.review("x");
  expect(t).toEqual({ calls: 2, by_value: {}, not_requested: 0, unknown: 2 });
});

test("a failed call is not counted, and the error passes through", async () => {
  const t = newTally();
  const r = trackServed({ name: "r", review: async () => { throw new Error("down"); } }, "m1", t);
  await expect(r.review("x")).rejects.toThrow("down");
  expect(t.calls).toBe(0);
});

test("tallies add up", () => {
  const a = { calls: 2, by_value: { m1: 1, x: 1 }, not_requested: 1, unknown: 0 };
  const b = { calls: 3, by_value: { m1: 2 }, not_requested: 0, unknown: 1 };
  expect(addTallies([a, b])).toEqual({ calls: 5, by_value: { m1: 3, x: 1 }, not_requested: 1, unknown: 1 });
});

test("a committed tally carries counts only; the served-by values are kept out unless asked for", () => {
  const t = { calls: 5, by_value: { secret: 4, other: 1 }, not_requested: 1, unknown: 0 };
  expect(publicTally(t, false)).toEqual({ calls: 5, not_requested: 1, unknown: 0 });
  expect(JSON.stringify(publicTally(t, false))).not.toContain("secret");
  expect(publicTally(t, true)).toEqual(t);
});

test("--served-values is refused unless --out points outside the repo", () => {
  const repo = "/work/repo";
  expect(servedValuesRefusal(false, undefined, repo)).toBeUndefined();
  expect(servedValuesRefusal(false, "/work/repo/eval/limits/results", repo)).toBeUndefined();
  expect(servedValuesRefusal(true, undefined, repo)).toContain("--out");
  expect(servedValuesRefusal(true, "/work/repo/eval/limits/results", repo)).toContain("--out");
  expect(servedValuesRefusal(true, "/work/repo/eval/limits/../limits/results/x", repo)).toContain("--out");
  expect(servedValuesRefusal(true, "/work/repo", repo)).toContain("--out");
  expect(servedValuesRefusal(true, "/work/repo-other/out", repo)).toBeUndefined();
  expect(servedValuesRefusal(true, "/tmp/out", repo)).toBeUndefined();
});

test("a tally restored from a snapshot drops the calls of a failed attempt", async () => {
  const t = newTally();
  const r = trackServed(fake(["m1", "other", "m1"]), "m1", t);
  await r.review("x");
  const snap = snapshotTally(t);
  await r.review("x");
  await r.review("x");
  restoreTally(t, snap);
  expect(t).toEqual({ calls: 1, by_value: { m1: 1 }, not_requested: 0, unknown: 0 });
  await r.review("x");
  expect(t.calls).toBe(2);
});

test("an in-repo folder whose name starts with two dots is refused, and a symlink into the repo is refused", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "served-")));
  const repo = join(dir, "repo");
  mkdirSync(join(repo, "eval/limits/results"), { recursive: true });
  mkdirSync(join(repo, "..out"));
  mkdirSync(join(dir, "outside"));
  symlinkSync(join(repo, "eval/limits/results"), join(dir, "outside/link"));
  expect(servedValuesRefusal(true, join(repo, "..out"), repo)).toContain("--out");
  expect(servedValuesRefusal(true, join(repo, "..out/not-yet"), repo)).toContain("--out");
  expect(servedValuesRefusal(true, join(dir, "outside/link"), repo)).toContain("--out");
  expect(servedValuesRefusal(true, join(dir, "outside/link/not-yet"), repo)).toContain("--out");
  expect(servedValuesRefusal(true, join(dir, "outside"), repo)).toBeUndefined();
  expect(servedValuesRefusal(true, join(dir, "outside/not-yet"), repo)).toBeUndefined();
});

test("a missing folder directly under the root keeps its whole name", () => {
  // both paths are missing; a name cut by one character would make the second equal the first and be refused
  expect(servedValuesRefusal(true, "/ab-missing", "/b-missing")).toBeUndefined();
  expect(servedValuesRefusal(true, "/ab-missing/out", "/ab-missing")).toContain("--out");
});

test("a reviewer that is a class instance keeps its methods and fields when tracked", async () => {
  class Served implements Reviewer {
    name = "cls";
    private cur: string | undefined;
    async review() { this.cur = "m1"; return "APPROVE"; }
    lastServedBy() { return this.cur; }
    describe() { return `reviewer ${this.name}`; }
  }
  const t = newTally();
  const r = trackServed(new Served(), "m1", t) as Served;
  await r.review();
  expect(t).toEqual({ calls: 1, by_value: { m1: 1 }, not_requested: 0, unknown: 0 });
  expect(r.describe()).toBe("reviewer cls");
  expect(r.name).toBe("cls");
  expect(r.lastServedBy()).toBe("m1");
});

test("the served line says a call is one chunk sent to the reviewer", () => {
  const line = servedLine({ calls: 7, not_requested: 1, unknown: 2 });
  expect(line).toBe("served by: 7 reviewer calls (each call is one chunk sent to the reviewer, not one review); 1 not served by the requested model; 2 with no served-by header");
  expect(servedLine({ calls: 1, not_requested: 0, unknown: 0, by_value: { a: 1 } })).toContain("; by value a 1");
});

test("a served-by header with spaces around it counts as the trimmed value, and one that is only spaces counts as unknown", async () => {
  // The server sets the header padded with spaces, or with nothing but spaces. Bun's Headers and fetch strip the spaces around a header value before the adapter reads it, so this pins the end-to-end result (padded counts as the value, blank as unknown), not the trim in the adapter.
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const { model } = (await req.json()) as { model: string };
      return Response.json({ choices: [{ message: { content: "APPROVE\nno attack indicators found" } }] }, { headers: { "x-served-by": model === "blank" ? "   " : " local " } });
    },
  });
  try {
    const run = async (model: string, requested: string) => {
      const tally = newTally();
      const r = trackServed(openaiReviewer({ name: "r", baseUrls: [`http://127.0.0.1:${server.port}`], model, retryDelaysMs: [], servedByHeader: "x-served-by" }), requested, tally);
      await r.review("x");
      return tally;
    };
    const padded = await run("local", "local");
    expect(padded.by_value).toEqual({ local: 1 });
    expect(padded.not_requested).toBe(0);
    expect(padded.unknown).toBe(0);
    const blank = await run("blank", "blank");
    expect(blank.by_value).toEqual({});
    expect(blank.unknown).toBe(1);
    expect(blank.not_requested).toBe(0);
  } finally {
    server.stop(true);
  }
});
