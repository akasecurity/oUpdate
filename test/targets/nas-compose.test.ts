// The docker-compose leg over the fake broker: reads only by named verbs, the script's diff and pre-gate, two
// reviewers, and a write only with apply on a real run, carrying the run id, the verdict and the hold list.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ComposeLeg, Target } from "../../src/targets/model.ts";
import { composeLeg } from "../../src/targets/nas/compose.ts";
import { MISSING_ID } from "../../src/targets/nas/evidence.ts";
import type { OpenNas } from "../../src/targets/reach.ts";
import type { LegContext } from "../../src/targets/run.ts";
import { DIGEST_TROUBLE } from "../../src/targets/summary.ts";
import { A, ans, brokerAnswer, evidenceRows, fakeReviewer, openNas, REACH, RUN, X, type FakeNas } from "./fake-nas.ts";

const APP = "registry.example/team/app:1";
const DB = "registry.example/db:16";
const NOW = new Date(2026, 9, 25, 3, 0);
const OK = "1. none\n2. Verdict: APPROVE";
const TARGET: Target = { id: "storage-box", os: "unraid", reach: REACH, legs: [], schedule: { every: "night" }, summaryTo: "/status/storage-box.tsv" };
const leg = (o: Partial<ComposeLeg> = {}): ComposeLeg => ({ kind: "docker-compose", apply: false, prune: true, ...o });
const ctx = (nas: OpenNas, dryRun = false): LegContext => ({ target: TARGET, reach: nas, dryRun, now: NOW });

const state = (app = { local: A("a"), running: A("a") }, extra: string[][] = []) =>
  ans([["CONFIG", X("c")], ["SVC", "app", APP, app.local, app.running], ["SVC", "db", DB, A("b"), A("b")], ...extra]);
const CAND_APP = ans(evidenceRows({ digest: A("d"), config: A("c"), history: ["RUN echo v2", "RUN base layer"] }));
const CAND_DB = ans(evidenceRows({ digest: A("e"), config: A("b"), history: ["RUN db"] }));
const RUN_APP = ans(evidenceRows({ id: A("a"), history: ["RUN echo v1", "RUN base layer"] }));

function scene(o: { state?: string; candApp?: string; runApp?: string; extra?: FakeNas } = {}): FakeNas {
  return {
    ...o.extra,
    answers: {
      "compose.state": o.state ?? state(),
      "image.candidate": (p) => (p.ref === APP ? (o.candApp ?? CAND_APP) : p.ref === DB ? CAND_DB : ans([], 3)),
      "image.evidence": (p) => (p.id === A("a") ? (o.runApp ?? RUN_APP) : ans([], 3)),
      ...o.extra?.answers,
    },
  };
}
function reviewers(router = OK, onprem = OK) {
  const r = fakeReviewer("router-model", router);
  const o = fakeReviewer("onprem-model", onprem);
  return { r, o, reviewers: { router: r.reviewer, onprem: o.reviewer } };
}
const verbs = (requests: { params: Record<string, unknown> }[]) => requests.map((q) => q.params.verb);
const writes = <T extends { action: string }>(requests: T[]) => requests.filter((q) => q.action === "store.oup.write");

describe("docker-compose leg", () => {
  test("nothing changed is up to date: no running evidence read, no review", async () => {
    const { nas, requests } = await openNas(scene({ candApp: ans(evidenceRows({ digest: A("d"), config: A("a"), history: ["RUN echo v1", "RUN base layer"] })) }));
    const { r, reviewers: rv } = reviewers();
    const res = await composeLeg(leg(), ctx(nas), nas, rv);
    expect(res).toMatchObject({ summary: "up to date", trouble: false, parity: { changed: [], pregate: [] } });
    expect(verbs(requests)).toEqual(["self", "compose.state", "image.candidate", "image.candidate"]);
    expect(r.prompts).toHaveLength(0);
  });

  test("a running id equal to the candidate's manifest digest is also unchanged (either image store)", async () => {
    const { nas } = await openNas(scene({ candApp: ans(evidenceRows({ digest: A("a"), config: A("c"), history: ["RUN x"] })) }));
    expect((await composeLeg(leg(), ctx(nas), nas, reviewers().reviewers)).summary).toBe("up to date");
  });

  test("a changed image is reviewed with the ported prompt; review only, it would update and writes nothing", async () => {
    const { nas, requests } = await openNas(scene());
    const { r, o, reviewers: rv } = reviewers();
    const res = await composeLeg(leg(), ctx(nas), nas, rv);
    expect(res).toMatchObject({ summary: `would update 1 (${APP})`, trouble: false, parity: { changed: [APP], pregate: [], verdict: { router: "APPROVE", onprem: "APPROVE" } } });
    expect(r.prompts[0]).toContain("Today is 2026-10-25.");
    expect(r.prompts[0]).toContain(`Updated images:\n<<<BEGIN UNTRUSTED DATA: updated images>>>\n| ${APP}\n<<<END UNTRUSTED DATA: updated images>>>\n\nLayer changes (docker history diff, new layers only):\n<<<BEGIN UNTRUSTED DATA: layer changes>>>\n| [${APP}]\n| RUN echo v2\n<<<END UNTRUSTED DATA: layer changes>>>\n\nKNOWN-NORMAL BASELINE`);
    expect(o.prompts).toEqual(r.prompts);
    expect(writes(requests)).toHaveLength(0);
    expect(res.lines).toContain(`  ${APP}: running image -> candidate`);
    expect(res.lines).toContain("    RUN echo v2");
  });

  test("the planted ENTRYPOINT is blocked by the pre-gate even when both models approve (Review Focus 1)", async () => {
    const f = JSON.parse(readFileSync(join(import.meta.dir, "../fixtures/nas/planted-image.json"), "utf8"));
    const { nas, requests } = await openNas(scene({ candApp: ans(evidenceRows({ ...f.candidate, digest: A("d"), config: A("c") })), runApp: ans(evidenceRows({ ...f.running, id: A("a") })) }));
    const res = await composeLeg(leg({ apply: true }), ctx(nas), nas, reviewers().reviewers);
    expect(res.summary).toBe("blocked (1 changed — pre-gate: 1 hit)");
    expect(res.trouble).toBe(true);
    expect(res.parity?.pregate).toEqual(['ENTRYPOINT/CMD changed: ["/init"]|null -> ["/bin/sh","-c","/app/hooks/prestart.sh && /init"]|null']);
    expect(writes(requests)).toHaveLength(0);
  });

  test("a router FLAG holds everything; the on-prem model is not asked", async () => {
    const { nas } = await openNas(scene());
    const { o, reviewers: rv } = reviewers("1. RUN echo v2\n2. Verdict: FLAG new layer");
    const res = await composeLeg(leg({ apply: true }), ctx(nas), nas, rv);
    expect(res).toMatchObject({ summary: "blocked (1 changed — review: router FLAG)", trouble: true, parity: { verdict: { router: "FLAG", onprem: "not asked" } } });
    expect(o.prompts).toHaveLength(0);
  });

  test("a candidate that cannot be read is BASELINE MISSING and holds (Review Focus 1)", async () => {
    const { nas } = await openNas(scene({ candApp: ans([], 3) }));
    const res = await composeLeg(leg(), ctx(nas), nas, reviewers().reviewers);
    expect(res.summary).toBe("blocked (1 changed — pre-gate: 1 hit)");
    expect(res.parity?.pregate).toEqual([MISSING_ID]);
    expect(res.lines).toContain(`${APP} candidate: image.candidate: NAS read failed: nas-oup: read failed (rc 3: a tool failed)`);
  });

  test("a held (redacted) candidate is BASELINE MISSING and holds", async () => {
    const { nas } = await openNas(scene({ extra: { replies: { "image.candidate": (p) => (p.ref === APP ? { status: "approved", result: { run_id: RUN, held: "EVIDENCE REDACTED" } } : undefined) } } }));
    const res = await composeLeg(leg(), ctx(nas), nas, reviewers().reviewers);
    expect(res.summary).toBe("blocked (1 changed — pre-gate: 1 hit)");
    expect(res.lines).toContain(`${APP} candidate: image.candidate: held by the broker: EVIDENCE REDACTED`);
  });

  test("a BUILD service is reported and never read", async () => {
    // The BUILD tag is a template literal: oss-scan reads a quoted "build" as a host name.
    const { nas, requests } = await openNas(scene({ state: state(undefined, [["SVC", "tool", "tool:dev", A("f"), A("f")], [`BUILD`, "tool"]]) }));
    const res = await composeLeg(leg(), ctx(nas), nas, reviewers().reviewers);
    expect(res.lines).toContain("tool: built locally; reported, never reviewed");
    expect(requests.filter((q) => q.params.verb === "image.candidate").map((q) => q.params.ref)).toEqual([APP, DB]);
  });

  test("a compose.state refusal is not checked", async () => {
    const { nas } = await openNas(scene({ extra: { replies: { "compose.state": { status: "denied", reason: "caller not listed" } } } }));
    expect(await composeLeg(leg(), ctx(nas), nas, reviewers().reviewers)).toMatchObject({ summary: "not checked — compose.state: broker denied: caller not listed", trouble: true });
  });

  test("apply: compose.apply carries only the run id, the verdict and the hold list; then prune, only the run id (rev 3e §4.8)", async () => {
    const { nas, requests } = await openNas(scene());
    const res = await composeLeg(leg({ apply: true }), ctx(nas), nas, reviewers().reviewers);
    expect(res).toMatchObject({ summary: `updated (${APP})`, trouble: false });
    expect(res.lines.filter((l) => l.includes("[broker request req-"))).toEqual(["compose.apply: rc 0 (ok) [broker request req-6]", "image.prune: rc 0 (ok) [broker request req-7]"]);
    const sha = createHash("sha256").update(brokerAnswer(CAND_APP) + brokerAnswer(CAND_DB) + brokerAnswer(RUN_APP)).digest("hex");
    const verdict = { items: { app: "APPROVE", db: "HOLD" }, reviewers: { router: "router-model", onprem: "onprem-model" }, evidence_sha256: sha };
    expect(writes(requests).map((q) => (q as { params: unknown }).params)).toEqual([
      { verb: "compose.apply", run_id: RUN, verdict, hold: ["db"] },
      { verb: "image.prune", run_id: RUN },
    ]);
  });

  test("apply on a dry run writes nothing", async () => {
    const { nas, requests } = await openNas(scene());
    expect((await composeLeg(leg({ apply: true }), ctx(nas, true), nas, reviewers().reviewers)).summary).toBe(`would update 1 (${APP})`);
    expect(writes(requests)).toHaveLength(0);
  });

  test.each([
    [6, "FAILED — compose.apply: rc 6 (failed after a change, rolled back); the broker suspends the standing entry until a Re-arm card is approved"],
    [null, "FAILED — compose.apply: no rc came back; the broker suspends the standing entry until a Re-arm card is approved"],
    [9, "blocked (compose.apply: rc 9 (an apply ran under 20 h ago))"],
  ] as [number | null, string][])("compose.apply rc %p: %s; no prune (Review Focus 3)", async (rc, summary) => {
    const { nas, requests } = await openNas(scene({ extra: { writeRc: { "compose.apply": rc } } }));
    const res = await composeLeg(leg({ apply: true }), ctx(nas), nas, reviewers().reviewers);
    expect(res).toMatchObject({ summary, trouble: true });
    expect(DIGEST_TROUBLE.test(res.summary)).toBe(true);
    expect(verbs(requests)).not.toContain("image.prune");
  });

  test("a failed prune after an ok apply is trouble", async () => {
    const { nas } = await openNas(scene({ extra: { writeRc: { "image.prune": 3 } } }));
    expect((await composeLeg(leg({ apply: true }), ctx(nas), nas, reviewers().reviewers)).summary).toBe(`updated (${APP}) · prune FAILED — image.prune: rc 3 (a tool failed); the broker suspends the standing entry until a Re-arm card is approved`);
  });

  const RUN_APP2 = ans(evidenceRows({ id: A("e"), history: ["RUN echo v2"] }));
  const shared = (app2: string[]) => ans([["CONFIG", X("c")], ["SVC", "app", APP, A("a"), A("a")], app2, ["SVC", "db", DB, A("b"), A("b")]]);
  const evid = { "image.evidence": (p: Record<string, unknown>) => (p.id === A("a") ? RUN_APP : RUN_APP2) };

  test("services sharing a ref: every distinct running image is diffed against the candidate (Codex 1)", async () => {
    const { nas, requests } = await openNas(scene({ state: shared(["SVC", "app2", APP, A("e"), A("e")]), extra: { answers: evid } }));
    const rv = reviewers();
    const res = await composeLeg(leg({ apply: true }), ctx(nas), nas, rv.reviewers);
    expect(requests.filter((q) => q.params.verb === "image.evidence").map((q) => q.params.id)).toEqual([A("a"), A("e")]);
    expect(rv.r.prompts[0]).toContain(`[${APP} (running ${"a".repeat(12)})]`);
    expect(rv.r.prompts[0]).toContain(`[${APP} (running ${"e".repeat(12)})]`);
    expect(rv.r.prompts[0]).toMatch(/running e{12}\)\]\n\| RUN base layer/);
    expect((writes(requests)[0]!.params.verdict as { items: unknown }).items).toEqual({ app: "APPROVE", app2: "APPROVE", db: "HOLD" });
    expect(res.summary).toBe(`updated (${APP})`);
  });

  test("services sharing a ref: one with no running container has no baseline and is held (Codex 1)", async () => {
    const { nas, requests } = await openNas(scene({ state: shared(["SVC", "app2", APP, A("e"), "-"]), extra: { answers: evid } }));
    const res = await composeLeg(leg({ apply: true }), ctx(nas), nas, reviewers().reviewers);
    expect(requests.filter((q) => q.params.verb === "image.evidence").map((q) => q.params.id)).toEqual([A("a")]);
    const w = writes(requests)[0]!.params as { verdict: { items: unknown }; hold: unknown };
    expect(w.verdict.items).toEqual({ app: "APPROVE", app2: "HOLD", db: "HOLD" });
    expect(w.hold).toEqual(["app2", "db"]);
    expect(res.summary).toBe(`updated (${APP}) · held (no running container: app2)`);
    expect(res.trouble).toBe(true);
  });

  test("services sharing a ref: a drifted one's running image is diffed too, and it stays held", async () => {
    const st = ans([["CONFIG", X("c")], ["SVC", "app", APP, A("f"), A("a")], ["SVC", "app2", APP, A("e"), A("e")], ["SVC", "db", DB, A("b"), A("b")]]);
    const { nas, requests } = await openNas(scene({ state: st, extra: { answers: evid } }));
    await composeLeg(leg(), ctx(nas), nas, reviewers().reviewers);
    expect(requests.filter((q) => q.params.verb === "image.evidence").map((q) => q.params.id)).toEqual([A("a"), A("e")]);
  });

  test("drift: a local image that differs from the running one is reviewed but held", async () => {
    const { nas, requests } = await openNas(scene({ state: state({ local: A("f"), running: A("a") }) }));
    const res = await composeLeg(leg({ apply: true }), ctx(nas), nas, reviewers().reviewers);
    expect(res).toMatchObject({ summary: "blocked (1 changed, every one held) · held (local image differs from running: app)", trouble: true, parity: { changed: [APP] } });
    expect(writes(requests)).toHaveLength(0);
  });

  test("evidence reads go one at a time, so the broker's return order is the request order (rev 3f)", async () => {
    const t = await openNas(scene());
    let live = 0;
    let most = 0;
    const exec: typeof t.nas.exec = async (argv, o) => {
      live++;
      most = Math.max(most, live);
      await new Promise((r) => setTimeout(r, 1));
      try {
        return await t.nas.exec(argv, o);
      } finally {
        live--;
      }
    };
    await composeLeg(leg(), ctx(t.nas), { ...t.nas, exec }, reviewers().reviewers);
    expect(t.requests.filter((q) => q.params.verb === "image.candidate" || q.params.verb === "image.evidence").length).toBeGreaterThan(2);
    expect(most).toBe(1);
  });
});
