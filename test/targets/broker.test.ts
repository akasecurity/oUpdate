// The broker door: one broker client call per verb, argv only, named verb and typed slots, the run id carried after the
// broker mints it, evidence kept for the verdict's sha, and every write answer without a recognized outcome read as
// unknown (refused only when the caller sent nothing).
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { brokerRead, brokerWrite, composeRequest, evidenceSha, newSession, writeLine, writeSummary, type Verdict, type WriteResult } from "../../src/targets/broker/broker.ts";
import { TROUBLE_WORDS } from "../../src/targets/summary.ts";
import { fakeExec } from "./fakes.ts";
import { A, ans, BROKER, brokerAnswer, evidenceRows, targetExec, RUN, X, type FakeTarget } from "./fake-broker.ts";

const APP = "registry.example/team/app-a:1";
/** A `self` answer: five rows the broker passes through undecoded. */
const SELF = ans([["ROW", "a"], ["ROW", "b"], ["ROW", "c"], ["ROW", "d"], ["ROW", "e"]]);
const CAND = ans(evidenceRows({ digest: A("d"), config: A("c"), history: ["RUN x"] }));
const EVID = ans(evidenceRows({ id: A("a"), history: ["RUN x"] }));
const STATE = ans([["CONFIG", X("c")], ["SVC", "app", APP, A("a"), A("a")]]);
/** A write result without its broker request id, for exact comparisons. */
const bare = (w: WriteResult) => {
  const { requestId: _id, ...rest } = w;
  return rest;
};
const V: Verdict = { items: { app: "APPROVE" }, reviewers: { first: "first-model", second: "second-model" }, evidence_sha256: "0".repeat(64) };

describe("brokerRead", () => {
  test("one broker client call: named verb, typed slots, the broker's base URL, no shell", async () => {
    const { exec, calls, requests } = targetExec({ answers: { "compose.state": STATE, "image.candidate": CAND } });
    const s = newSession();
    await brokerRead(BROKER, exec, s, "compose.state");
    expect((await brokerRead(BROKER, exec, s, "image.candidate", { ref: APP })).ok).toBe(true);
    expect(calls[1]!.argv).toEqual(["/opt/broker-client", "store.oup.read", "box-1", "--why", "oupdate image.candidate", "--wait", "75", "--param", "verb=image.candidate", "--param", `ref=${APP}`, "--param", `run_id=${RUN}`]);
    expect(calls[1]!.env).toEqual({ BROKER_BASE_URL: "https://broker.example.invalid" });
    expect(calls[1]!.timeoutMs).toBe(105_000);
    expect(requests[1]!.params).toEqual({ verb: "image.candidate", ref: APP, run_id: RUN });
  });

  test.each([["app;reboot"], ["app latest"], ["app$(id)"], ["app\n__OUP_RC=0"]])("a slot outside its rule is never sent: %p (Review Focus 2)", async (ref) => {
    const { exec, calls } = targetExec({});
    const r = await brokerRead(BROKER, exec, newSession(), "image.candidate", { ref });
    expect(r.ok).toBe(false);
    expect((r as { why: string }).why).toContain("not asked: image.candidate: slot ref is not valid");
    expect(calls).toHaveLength(0);
  });

  test("the first compose.state mints the run; every later read carries it, self too", async () => {
    const { exec, requests } = targetExec({ answers: { self: SELF, "compose.state": STATE, "image.evidence": EVID } });
    const s = newSession();
    await brokerRead(BROKER, exec, s, "self");
    expect(s.runId).toBeUndefined();
    await brokerRead(BROKER, exec, s, "compose.state");
    expect(s.runId).toBe(RUN);
    await brokerRead(BROKER, exec, s, "image.evidence", { id: A("a") });
    await brokerRead(BROKER, exec, s, "self");
    expect(requests.map((q) => q.params.run_id)).toEqual([undefined, undefined, RUN, RUN]);
  });

  test("a run that changes mid-night is refused (Review Focus 4)", async () => {
    const { exec } = targetExec({ answers: { "compose.state": STATE }, replies: { "image.evidence": { status: "approved", result: { run_id: "run-9999zzzz", answer: EVID } } } });
    const s = newSession();
    await brokerRead(BROKER, exec, s, "compose.state");
    expect(await brokerRead(BROKER, exec, s, "image.evidence", { id: A("a") })).toEqual({ ok: false, why: `image.evidence: the broker's run changed (run-9999zzzz, expected ${RUN})` });
  });

  test.each([["image.evidence", { id: A("a") }], ["image.candidate", { ref: APP }], ["plugin.file", { plugin: "example.plugin", which: "new", copy: "Ab12Cd34" }]] as const)(
    "%s before the run is minted is never sent",
    async (verb, slots) => {
      const { exec, calls } = targetExec({});
      expect(await brokerRead(BROKER, exec, newSession(), verb, slots)).toEqual({ ok: false, why: `not asked: ${verb} needs the broker's run (no compose.state or plugin.check yet)` });
      expect(calls).toHaveLength(0);
    },
  );

  test("a minting read with no run id, or a later read that drops it, is refused (Review Focus 4)", async () => {
    const none = targetExec({ replies: { "compose.state": { status: "approved", result: { answer: brokerAnswer(STATE) } } } });
    expect(await brokerRead(BROKER, none.exec, newSession(), "compose.state")).toEqual({ ok: false, why: "compose.state: the broker gave no run id" });
    const dropped = targetExec({ answers: { "compose.state": STATE }, replies: { "image.evidence": { status: "approved", result: { answer: brokerAnswer(EVID) } } } });
    const s = newSession();
    await brokerRead(BROKER, dropped.exec, s, "compose.state");
    expect(await brokerRead(BROKER, dropped.exec, s, "image.evidence", { id: A("a") })).toEqual({ ok: false, why: `image.evidence: the broker's run changed (none, expected ${RUN})` });
  });

  test("an answer whose last row has no newline still parses, so the marker the caller puts back stays on its own line", async () => {
    const { exec } = targetExec({ replies: { self: { status: "approved", result: { answer: SELF.replace(/\n__OUP_RC=0\n$/, "") } } } });
    expect((await brokerRead(BROKER, exec, newSession(), "self")).ok).toBe(true);
  });

  test("an evidence answer the caller refuses still counts toward the evidence sha, as the broker records it", async () => {
    const bad = `ENTRYPOINT\tnull\r\n`;
    const { exec } = targetExec({ answers: { "compose.state": STATE }, replies: { "image.evidence": { status: "approved", result: { run_id: RUN, seq: 2, answer: bad } } } });
    const s = newSession();
    await brokerRead(BROKER, exec, s, "compose.state");
    expect((await brokerRead(BROKER, exec, s, "image.evidence", { id: A("a") })).ok).toBe(false);
    expect(s.evidence).toEqual([{ seq: 2, answer: bad }]);
  });

  test("the broker removes the final marker; a marker line left in an answer is refused (Review Focus 1)", async () => {
    const { exec } = targetExec({ replies: { self: { status: "approved", result: { answer: SELF } } } });
    expect(await brokerRead(BROKER, exec, newSession(), "self")).toEqual({ ok: false, why: "self: line 6: a marker line that is not the final line" });
  });

  test("evidence answers are kept in order for the verdict's evidence sha", async () => {
    const { exec } = targetExec({ answers: { "compose.state": STATE, "image.candidate": CAND, "image.evidence": EVID } });
    const s = newSession();
    await brokerRead(BROKER, exec, s, "compose.state");
    await brokerRead(BROKER, exec, s, "image.candidate", { ref: APP });
    await brokerRead(BROKER, exec, s, "image.evidence", { id: A("a") });
    expect(s.evidence.map((e) => e.answer)).toEqual([brokerAnswer(CAND), brokerAnswer(EVID)]);
    expect(evidenceSha(s)).toBe(createHash("sha256").update(brokerAnswer(CAND) + brokerAnswer(EVID)).digest("hex"));
  });

  test.each([
    ["a broker refusal", { replies: { self: { status: "denied", reason: "caller not listed" } } }, "self: broker denied: caller not listed"],
    ["a held item", { replies: { self: { status: "approved", result: { held: "EVIDENCE REDACTED" } } } }, "self: held by the broker: EVIDENCE REDACTED"],
    ["a result with no answer", { replies: { self: { status: "approved", result: {} } } }, "self: broker result has no answer"],
    ["no final marker ({failed} with no rc)", { answers: { self: "ROW\ta\n" } }, "self: target read failed: box-oup: read failed (no marker: outcome unknown)"],
    ["rc 5 ({failed, rc})", { answers: { self: ans([], 5) } }, "self: target read failed: box-oup: read failed (rc 5: busy)"],
    ["refused before the ssh call", { replies: { self: { status: "approved", result: { refused: "box-oup: caller limit" } } } }, "self: refused by the broker: box-oup: caller limit"],
    ["an answer over its cap", { answers: { self: ans([["SH", `/${"a".repeat(5000)}`]]) } }, "self: answer is 5016 bytes, over the 4096-byte cap"],
  ] as [string, FakeTarget, string][])("%s is a failure with its reason", async (_what, target, why) => {
    const { exec } = targetExec(target);
    expect(await brokerRead(BROKER, exec, newSession(), "self")).toEqual({ ok: false, why });
  });

  test("compose.state and plugin.check go once per run; a repeat is never sent", async () => {
    const { exec, calls } = targetExec({ answers: { "compose.state": STATE, "plugin.check": ans([]) } });
    const s = newSession();
    await brokerRead(BROKER, exec, s, "compose.state");
    expect((await brokerRead(BROKER, exec, s, "plugin.check")).ok).toBe(true);
    expect(await brokerRead(BROKER, exec, s, "compose.state")).toEqual({ ok: false, why: "not asked: compose.state was already read this run" });
    expect(await brokerRead(BROKER, exec, s, "plugin.check")).toEqual({ ok: false, why: "not asked: plugin.check was already read this run" });
    expect(calls).toHaveLength(2);
  });

  test("held, refused and failed reads add nothing to the evidence sha; answers count exactly as received", async () => {
    const { exec } = targetExec({ answers: { "compose.state": STATE, "image.evidence": ans([], 3), "image.candidate": CAND } });
    const s = newSession();
    await brokerRead(BROKER, exec, s, "compose.state");
    await brokerRead(BROKER, exec, s, "image.evidence", { id: A("a") });
    await brokerRead(BROKER, exec, s, "image.candidate", { ref: APP });
    expect(s.evidence.map((e) => e.answer)).toEqual([brokerAnswer(CAND)]);
    expect(brokerAnswer(CAND).endsWith("\n")).toBe(false);
  });

  test("a refused read names the run; one without the run id is a changed run (run_id always present)", async () => {
    for (const [result, why] of [
      [{ run_id: RUN, refused: "box-oup: second image.candidate for one ref" }, "image.candidate: refused by the broker: box-oup: second image.candidate for one ref"],
      [{ refused: "box-oup: second image.candidate for one ref" }, `image.candidate: the broker's run changed (none, expected ${RUN})`],
    ] as const) {
      const { exec } = targetExec({ answers: { "compose.state": STATE }, replies: { "image.candidate": { status: "approved", result } } });
      const s = newSession();
      await brokerRead(BROKER, exec, s, "compose.state");
      expect(await brokerRead(BROKER, exec, s, "image.candidate", { ref: APP })).toEqual({ ok: false, why });
    }
  });

  test("the evidence sha hashes the decoded answer string, not its escaped JSON form", async () => {
    const answer = `ID\t${A("a")}\nENTRYPOINT\tnull\nCMD\tnull\nHIST\t"caf\u00e9 \\"quoted\\""`;
    const { exec } = targetExec({ answers: { "compose.state": STATE }, replies: { "image.evidence": { status: "approved", result: { run_id: RUN, seq: 2, answer } } } });
    const s = newSession();
    await brokerRead(BROKER, exec, s, "compose.state");
    expect((await brokerRead(BROKER, exec, s, "image.evidence", { id: A("a") })).ok).toBe(true);
    const escaped = JSON.stringify(answer).slice(1, -1);
    expect(escaped).not.toBe(answer);
    expect(evidenceSha(s)).toBe(createHash("sha256").update(Buffer.from(answer, "utf8")).digest("hex"));
    expect(evidenceSha(s)).not.toBe(createHash("sha256").update(Buffer.from(escaped, "utf8")).digest("hex"));
  });

  test("the evidence sha is over the UTF-8 bytes of each answer as received, joined with nothing", () => {
    const s = { ...newSession(), evidence: [{ seq: 1, answer: "HIST\t\"caf\u00e9\"\n" }, { seq: 2, answer: "ID\tx\n" }] };
    expect(evidenceSha(s)).toBe(createHash("sha256").update(Buffer.concat(s.evidence.map((a) => Buffer.from(a.answer, "utf8")))).digest("hex"));
  });

  test("the design's evidence test vector: decoded strings in ascending seq; the NFD form must not match", () => {
    const seq1 = JSON.parse('"EVID web caf\\u00e9 \\u2713"') as string;
    const seq2 = JSON.parse('"CAND a\\u003cb"') as string;
    expect([seq1, seq2]).toEqual(["EVID web caf\u00e9 \u2713", "CAND a<b"]);
    expect(evidenceSha({ ...newSession(), evidence: [{ seq: 2, answer: seq2 }, { seq: 1, answer: seq1 }] })).toBe("059d7809357a92c3471c65ca0d79dddda3de6847128ac3eaccfffd546e0171af");
    const nfd = seq1.normalize("NFD");
    expect(nfd).not.toBe(seq1);
    expect(evidenceSha({ ...newSession(), evidence: [{ seq: 1, answer: nfd }, { seq: 2, answer: seq2 }] })).toBe("175b676747f703e49aebad1fd44ab355c3c0385c23a8c84508dd6abba752a622");
  });

  test("evidence answers carry the broker's seq; a missing or repeated seq is refused", async () => {
    for (const [result, why] of [
      [{ run_id: RUN, answer: brokerAnswer(EVID) }, "image.evidence: the broker gave no valid seq"],
      [{ run_id: RUN, seq: 2, answer: brokerAnswer(EVID) }, "image.evidence: the broker's seq 2 repeats"],
    ] as const) {
      const { exec } = targetExec({ answers: { "compose.state": STATE, "image.candidate": CAND }, replies: { "image.evidence": { status: "approved", result } } });
      const s = newSession();
      await brokerRead(BROKER, exec, s, "compose.state");
      await brokerRead(BROKER, exec, s, "image.candidate", { ref: APP });
      expect(s.evidence.map((e) => e.seq)).toEqual([2]);
      expect(await brokerRead(BROKER, exec, s, "image.evidence", { id: A("a") })).toEqual({ ok: false, why });
    }
  });

  test("a reply that is not an outcome is a failure", async () => {
    const { exec } = fakeExec([(argv) => (argv[0] === "/opt/broker-client" ? { rc: 1, out: "<html>", err: "proxy error" } : undefined)]);
    expect(await brokerRead(BROKER, exec, newSession(), "self")).toEqual({ ok: false, why: "self: the broker client gave no outcome (rc 1: proxy error)" });
  });
});

describe("brokerWrite", () => {
  async function minted(target: FakeTarget) {
    const t = targetExec({ ...target, answers: { "compose.state": STATE, ...target.answers } });
    const s = newSession();
    await brokerRead(BROKER, t.exec, s, "compose.state");
    return { ...t, s };
  }

  test("sends only the run id, the verdict and the hold list", async () => {
    const { exec, s, requests, calls } = await minted({});
    expect(bare(await brokerWrite(BROKER, exec, s, "compose.apply", V, ["db"]))).toEqual({ outcome: "ok", rc: 0, why: "compose.apply: rc 0 (ok)", reachedSsh: true });
    expect(requests[1]).toMatchObject({ action: "store.oup.write", wait: 1515, params: { verb: "compose.apply", run_id: RUN, verdict: V, hold: ["db"] } });
    expect(Object.keys(requests[1]!.params).sort()).toEqual(["hold", "run_id", "verb", "verdict"]);
    expect(calls[1]!.argv.slice(7)).toEqual(["--param", "verb=compose.apply", "--param", `run_id=${RUN}`, "--param-json", `verdict=${JSON.stringify(V)}`, "--param-json", 'hold=["db"]']);
  });

  test.each([
    ["rc 6", { writeRc: { "compose.apply": 6 } }, { outcome: "failed", rc: 6, why: "compose.apply: rc 6 (failed after a change, rolled back)", reachedSsh: true }],
    ["no rc", { writeRc: { "compose.apply": null } }, { outcome: "unknown", why: "compose.apply: no rc came back", reachedSsh: true }],
    ["the broker's outcome disagrees", { writeOutcome: { "compose.apply": "failed" } }, { outcome: "unknown", rc: 0, why: "compose.apply: rc 0 (ok); the broker says failed, the caller's table says ok", reachedSsh: true }],
    ["an approval still pending", { replies: { "compose.apply": { status: "pending" } } }, { outcome: "unknown", why: "compose.apply: waits on an approval and may still run", reachedSsh: false }],
    ["denied", { replies: { "compose.apply": { status: "denied", reason: "standing entry suspended after a failed apply" } } }, { outcome: "refused", why: "compose.apply: approval denied, nothing ran: standing entry suspended after a failed apply", sent: true }],
    ["an approval that expired (nothing ran)", { replies: { "compose.apply": { status: "expired" } } }, { outcome: "refused", why: "compose.apply: approval expired, nothing ran", sent: true }],
    ["refused before the ssh call", { replies: { "compose.apply": { status: "approved", result: { run_id: RUN, refused: "box-oup: write in flight" } } } }, { outcome: "refused", why: "compose.apply: refused by the broker, nothing ran: box-oup: write in flight", sent: true }],
    ["refused with no run id (always present)", { replies: { "compose.apply": { status: "approved", result: { refused: "box-oup: clock behind chain" } } } }, { outcome: "unknown", why: `compose.apply: a refusal for another run (none, expected ${RUN}): box-oup: clock behind chain`, reachedSsh: false }],
    ["refused: clock behind chain", { replies: { "compose.apply": { status: "approved", result: { run_id: RUN, refused: "box-oup: clock behind chain" } } } }, { outcome: "refused", why: "compose.apply: refused by the broker, nothing ran: box-oup: clock behind chain", sent: true }],
    ["an outcome the caller does not know", { writeOutcome: { "compose.apply": "maybe" } }, { outcome: "unknown", rc: 0, why: "compose.apply: rc 0 (ok); the broker says \"maybe\", the caller's table says ok", reachedSsh: true }],
    ["failed with no rc", { replies: { "compose.apply": { status: "failed", reason: "ssh timeout" } } }, { outcome: "unknown", why: "compose.apply: no rc came back: ssh timeout", reachedSsh: false }],
    ["a result with no outcome (always present)", { replies: { "compose.apply": { status: "approved", result: { run_id: RUN, rc: 0 } } } }, { outcome: "unknown", rc: 0, why: "compose.apply: rc 0 (ok); the broker sent no outcome", reachedSsh: false }],
  ] as [string, FakeTarget, unknown][])("%s (Review Focus 3)", async (_what, target, want) => {
    const { exec, s } = await minted(target);
    expect(bare(await brokerWrite(BROKER, exec, s, "compose.apply", V, []))).toEqual(want as never);
  });

  test("a client timeout, and a client that never started, are unknown (Review Focus 3)", async () => {
    const s = { ...newSession(), runId: RUN };
    const slow = fakeExec([(argv) => (argv[0] === "/opt/broker-client" ? { rc: 124, timedOut: true } : undefined)]);
    expect(bare(await brokerWrite(BROKER, slow.exec, s, "compose.apply", V, []))).toEqual({ outcome: "unknown", why: "compose.apply: the broker client timed out after 1545 s", reachedSsh: false });
    // fakeExec([]) answers rc 127, "unscripted: <argv>": the client never started, so nothing was sent.
    const missing = fakeExec([]);
    const r = await brokerWrite(BROKER, missing.exec, { ...newSession(), runId: RUN }, "compose.apply", V, []);
    expect(r.outcome).toBe("unknown");
    expect(r.why).toStartWith("compose.apply: the broker client did not start: unscripted: /opt/broker-client store.oup.write");
  });

  test("no write action, or no run this night: refused with no call (Review Focus 4)", async () => {
    const { exec, calls } = targetExec({});
    const { writeAction: _w, ...readOnly } = BROKER;
    expect(bare(await brokerWrite(readOnly, exec, { ...newSession(), runId: RUN }, "compose.apply", V, []))).toEqual({ outcome: "refused", why: "compose.apply: the reach names no write action", sent: false });
    expect(bare(await brokerWrite(BROKER, exec, newSession(), "compose.apply", V, []))).toEqual({ outcome: "refused", why: "compose.apply: no broker run this night", sent: false });
    expect(calls).toHaveLength(0);
  });

  test("image.prune sends only the verb and the run id, and only after this run's compose.apply ended ok", async () => {
    const { exec, s, requests } = await minted({});
    expect(bare(await brokerWrite(BROKER, exec, s, "image.prune"))).toEqual({ outcome: "refused", why: "image.prune: not asked: no compose.apply ended ok this run", sent: false });
    expect(requests).toHaveLength(1);
    await brokerWrite(BROKER, exec, s, "compose.apply", V, []);
    expect(bare(await brokerWrite(BROKER, exec, s, "image.prune"))).toEqual({ outcome: "ok", rc: 0, why: "image.prune: rc 0 (ok)", reachedSsh: true });
    expect(requests[2]).toMatchObject({ action: "store.oup.write", wait: 135, params: { verb: "image.prune", run_id: RUN } });
    expect(Object.keys(requests[2]!.params).sort()).toEqual(["run_id", "verb"]);
  });

  test("a write the broker refused before the ssh call stops later writes of the run too", async () => {
    const { exec, s, calls } = await minted({ replies: { "compose.apply": { status: "approved", result: { run_id: RUN, refused: "box-oup: write in flight" } } } });
    expect((await brokerWrite(BROKER, exec, s, "compose.apply", V, [])).outcome).toBe("refused");
    const n = calls.length;
    expect((await brokerWrite(BROKER, exec, s, "plugin.update", V, [])).why).toStartWith("plugin.update: not asked: an earlier write this run did not end cleanly");
    expect(calls).toHaveLength(n);
  });

  test("composeRequest names every service, BUILD ones as HOLD, and holds exactly the HOLD items", () => {
    const s = { ...newSession(), runId: RUN, evidence: [{ seq: 1, answer: "x" }] };
    const r = composeRequest(["app", "db", "tool"], ["tool", "gen"], new Set(["app", "tool"]), { first: "first-model", second: "second-model" }, s);
    expect(r).toEqual({
      verdict: { items: { app: "APPROVE", db: "HOLD", tool: "HOLD", gen: "HOLD" }, reviewers: { first: "first-model", second: "second-model" }, evidence_sha256: evidenceSha(s) },
      hold: ["db", "tool", "gen"],
    });
  });

  test("a write that ends failed or unknown stops every later write of the run, in any leg (Review Focus 3)", async () => {
    const { exec, s, calls } = await minted({ writeRc: { "compose.apply": null } });
    expect((await brokerWrite(BROKER, exec, s, "compose.apply", V, [])).outcome).toBe("unknown");
    const n = calls.length;
    expect(bare(await brokerWrite(BROKER, exec, s, "plugin.update", V, []))).toEqual({ outcome: "refused", why: "plugin.update: not asked: an earlier write this run did not end cleanly (compose.apply: no rc came back)", sent: false });
    expect(calls).toHaveLength(n);
  });

  test("a broker failed status carrying outcome ok, or a write reply naming another run, is unknown (Review Focus 3, 4)", async () => {
    const f = await minted({ replies: { "compose.apply": { status: "failed", reason: "x", result: { run_id: RUN, outcome: "ok", rc: 0 } } } });
    expect((await brokerWrite(BROKER, f.exec, f.s, "compose.apply", V, [])).outcome).toBe("unknown");
    const r = await minted({ replies: { "compose.apply": { status: "approved", result: { run_id: "run-9999zzzz", outcome: "ok", rc: 0 } } } });
    expect(bare(await brokerWrite(BROKER, r.exec, r.s, "compose.apply", V, []))).toEqual({ outcome: "unknown", rc: 0, why: `compose.apply: rc 0 (ok); the broker's run changed (run-9999zzzz, expected ${RUN})`, reachedSsh: true });
  });

  test("each write keeps the broker's request id, and its log line names it", async () => {
    const { exec, s } = await minted({});
    const w = await brokerWrite(BROKER, exec, s, "compose.apply", V, []);
    expect(w.requestId).toBe("req-2");
    expect(writeLine(w)).toBe("compose.apply: rc 0 (ok) [broker request req-2]");
    expect(writeLine({ outcome: "refused", why: "x", sent: false })).toBe("x");
  });

  test("writeSummary: only a write that reached the ssh call names the suspension; every summary is trouble", () => {
    const f = writeSummary({ outcome: "failed", rc: 6, why: "compose.apply: rc 6 (failed after a change, rolled back)", reachedSsh: true });
    const u = writeSummary({ outcome: "unknown", why: "compose.apply: the broker client timed out after 1545 s", reachedSsh: false });
    expect(u).toBe("FAILED — compose.apply: the broker client timed out after 1545 s; outcome unknown, the write may have run");
    const n = writeSummary({ outcome: "refused", why: "compose.apply: approval denied, nothing ran", sent: true });
    expect(n).toBe("blocked — nothing ran (compose.apply: approval denied, nothing ran)");
    for (const t of [u, n]) expect(TROUBLE_WORDS.test(t)).toBe(true);
    expect(f).toBe("FAILED — compose.apply: rc 6 (failed after a change, rolled back); the broker suspends the standing entry until it is approved again");
    const b = writeSummary({ outcome: "no-change", rc: 9, why: "compose.apply: rc 9 (an apply ran under 20 h ago)", reachedSsh: true });
    expect(b).toBe("blocked (compose.apply: rc 9 (an apply ran under 20 h ago))");
    expect(writeSummary({ outcome: "refused", why: "x", sent: false })).toBe("blocked (x)");
    for (const t of [f, b]) expect(TROUBLE_WORDS.test(t)).toBe(true);
  });
});
