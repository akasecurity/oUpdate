// One summary line per target in the tsv shape the fleet digest reads; trouble always shows as a trouble word.
import { describe, expect, test } from "bun:test";
import { DIGEST_TROUBLE, joinLegs, oneLine, stamp, statusTsv } from "../../src/targets/summary.ts";

const ok = (summary: string) => ({ lines: [], summary, trouble: false });
const bad = (summary: string) => ({ lines: [], summary, trouble: true });

describe("summary", () => {
  test("one leg passes its summary through", () => {
    expect(joinLegs([{ kind: "pin-bump", result: ok("pins current") }])).toEqual({ summary: "pins current", trouble: false });
  });

  test("several legs are named and joined", () => {
    expect(joinLegs([{ kind: "a", result: ok("x") }, { kind: "b", result: ok("y") }]).summary).toBe("a: x · b: y");
  });

  // Review Focus 3: trouble always carries a digest trouble word; a tab or newline never reaches the tsv.
  test("trouble without a trouble word gets one", () => {
    const j = joinLegs([{ kind: "reach", result: bad("not checked — reach vm-agent not built yet") }]);
    expect(j).toEqual({ summary: "not checked — reach vm-agent not built yet · error: see the targets log", trouble: true });
    expect(DIGEST_TROUBLE.test(j.summary)).toBe(true);
  });

  test("trouble that already has a trouble word is left alone", () => {
    expect(joinLegs([{ kind: "pin-bump", result: bad("pins FLAGGED by local") }]).summary).toBe("pins FLAGGED by local");
  });

  test("tabs and newlines fold to one space", () => {
    expect(oneLine("a\tb\r\nc\n\nd")).toBe("a b c d");
    expect(joinLegs([{ kind: "x", result: ok("one\ttwo\nthree") }]).summary).toBe("one two three");
  });

  test("statusTsv writes the four rows the digest reads", () => {
    expect(statusTsv({ host: "lane-images", date: "2026-10-25 04:10", rev: "abc1234", summary: "pins current" })).toBe(
      "host\tlane-images\ndate\t2026-10-25 04:10\nrev\tabc1234\nsummary\tpins current\n",
    );
    expect(statusTsv({ host: "a\tb", date: "d", rev: "r", summary: "s\nt" })).toBe("host\ta b\ndate\td\nrev\tr\nsummary\ts t\n");
  });

  test("stamp is local YYYY-MM-DD HH:MM", () => {
    expect(stamp(new Date(2026, 9, 5, 7, 3))).toBe("2026-10-05 07:03");
  });

  test("DIGEST_TROUBLE mirrors the digest's words", () => {
    for (const s of ["FLAGGED", "error", "FAILED", "aborted", "CVE-1", "STUCK", "stale", "blocked", "no status", "divergent"]) expect(DIGEST_TROUBLE.test(s)).toBe(true);
    for (const s of ["pins current", "held: cli 1.2.4 (2.0 h old, cooldown 7 d)", "not checked: 3 pins (see log)", "pins proposed oupdate/pins-0a1b2c3d4e5f"]) expect(DIGEST_TROUBLE.test(s)).toBe(false);
  });
});
