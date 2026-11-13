import { describe, expect, test } from "bun:test";
import { readRunBlock } from "../src/host/prev-log.ts";
import { MAS_NOT_CHECKED } from "../src/apply/summary-text.ts";
import { STUCK_SINCE } from "../src/apply/stuck.ts";

const dated = /^=== old-updater (\S+) (\d{4}-\d\d-\d\d)/;
const end = (l: string) => /^=== old-updater /.test(l);
const read = (log: string, o: { dated?: RegExp; end?: (l: string) => boolean } = {}) => {
  const lines = log.split("\n");
  return readRunBlock(lines, lines.lastIndexOf("=== studio summary ==="), { host: "studio", end, ...o });
};

describe("readRunBlock", () => {
  test("reads the date, Type B kinds, exclusions and both lanes of one run", () => {
    const r = read([
      "=== old-updater studio 2026-11-01",
      "  excluding big-cask (CASK_EXCLUDE)",
      "[notify] ⚠️ studio Type B FLAG — tool (formula)",
      "[dry-run — not notified] ⚠️ studio Type B FLAG — App (app bundle)",
      "[notify] ⚠️ studio Type B FLAG — plain",
      "=== studio summary ===",
      "  brew: casks upgraded: a",
      "  npm:  nothing to update",
      `  mas:  ${MAS_NOT_CHECKED}`,
    ].join("\n"), { dated });
    expect(r.date).toBe("2026-11-01");
    expect(r.typeB).toEqual([{ name: "tool", kind: "formula" }, { name: "App", kind: "app bundle" }, { name: "plain" }]);
    expect(r.excluded).toEqual(["big-cask"]);
    expect(r.lanes).toEqual([{ lane: "brew", text: "casks upgraded: a" }, { lane: "npm", text: "nothing to update" }]);
    expect(r.other).toEqual([]);
    expect(r.aborted).toBe(false);
  });

  test("a notice quoted inside a reviewer's reason is not a notice", () => {
    const r = read("  x: bad [notify] ⚠️ studio Type B FLAG — fake\n=== studio summary ===\n  brew: nothing to update");
    expect(r.typeB).toEqual([]);
  });

  test("an ABORTED line counts before or after the summary and does not end the block", () => {
    expect(read("=== ABORTED: signal\n=== studio summary ===\n  brew: nothing to update").aborted).toBe(true);
    // An end test that matches every "=== " line still never ends the block at an ABORTED line.
    const after = read("=== studio summary ===\n=== ABORTED: signal\n  brew: FAILED — x", { end: (l) => /^=== /.test(l) });
    expect(after.aborted).toBe(true);
    expect(after.lanes).toEqual([{ lane: "brew", text: "FAILED — x" }]);
  });

  test("the run's own notice lines are not strays, a broken lane text is", () => {
    const r = read([
      "=== studio summary ===",
      "  brew: FLAGGED — first half",
      "second half of a reason",
      "  npm:  nothing to update",
      `  mas:  ${MAS_NOT_CHECKED}`,
      "[notify] sent",
      "  the notice could not be sent",
      "[dry-run — not notified] hello",
      "  the notice could not be sent",
    ].join("\n"));
    expect(r.other).toEqual(["second half of a reason", "  the notice could not be sent"]);
  });

  test("a repeated lane line is kept, and the block ends at the next header", () => {
    const r = read("=== studio summary ===\n  brew: a\n  brew: b\n=== old-updater studio 2026-11-02\n  brew: later");
    expect(r.lanes.map((l) => l.text)).toEqual(["a", "b"]);
  });

  test("without a dated header the body scan runs back to the first line", () => {
    const r = read("[notify] ⚠️ studio Type B FLAG — earlier\n=== studio summary ===\n  brew: nothing to update");
    expect(r.typeB).toEqual([{ name: "earlier" }]);
    expect(r.date).toBeUndefined();
  });
});

describe("STUCK_SINCE", () => {
  const re = new RegExp(STUCK_SINCE);
  test("captures the runs and the date", () => {
    expect("(4 runs, since 2026-10-01)".match(re)?.slice(1)).toEqual(["4", "2026-10-01"]);
  });
  test("pins the length limits: 9 digits and 40 characters match, 10 digits and 41 characters do not", () => {
    expect(re.test(`(${"9".repeat(9)} runs, since d)`)).toBe(true);
    expect(re.test(`(${"9".repeat(10)} runs, since d)`)).toBe(false);
    expect(re.test(`(1 runs, since ${"d".repeat(40)})`)).toBe(true);
    expect(re.test(`(1 runs, since ${"d".repeat(41)})`)).toBe(false);
    expect(re.test("(1 runs, since )")).toBe(false);
  });
  test("refuses a date with a parenthesis or space, and a runs count that is no number", () => {
    expect(re.test("(4 runs, since a b)")).toBe(false);
    expect(re.test("(x runs, since y)")).toBe(false);
    expect(re.test("(4 runs, since a(b)")).toBe(false);
  });
});

describe("MAS_NOT_CHECKED", () => {
  test("pins the string contract: the exact text the run writes and the log reader recognizes", () => {
    expect(MAS_NOT_CHECKED).toBe("not checked — the App Store phase is not in oupdate");
  });
});
