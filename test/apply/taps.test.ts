// Ported from secure-update's tap-approval cases (test/port/03): the approved-taps loader,
// literal tap matching and the "old→new" versions of `brew outdated --verbose`.
import { describe, expect, test } from "bun:test";
import { loadApprovedTaps, outdatedVersions, tapIn } from "../../src/apply/taps.ts";

const BASE = ["example/svc"];
const load = (tsv: string, host: string, opts = {}) => loadApprovedTaps(tsv, host, BASE, opts);

describe("loadApprovedTaps", () => {
  test("a * row applies on any host", () => {
    expect(load("example/workmux\t*\t2026-09-28\tok\n", "hosta").taps).toEqual(["example/svc", "example/workmux"]);
  });
  for (const [rowHost, host, applies] of [
    ["hostd", "hostd", true],
    ["HostD", "hostd", true],
    ["hostd", "HOSTD", true],
    ["hostd", "x-hostd", true],
    ["x-hostd", "hostd", true],
    ["hostn", "hostd", false],
    ["hosta", "hostw", false],
  ] as const) {
    test(`row host '${rowHost}' on host ${host} → ${applies ? "applies" : "ignored"}`, () => {
      const r = load(`example/tf\t${rowHost}\t2026-09-28\tnote\n`, host, { hostPrefixes: ["x-"] });
      expect(r.taps.includes("example/tf")).toBe(applies);
      expect(r.warnings).toEqual([]);
    });
  }
  test("comments and blank lines are ignored", () => {
    const r = load("# header\n\n   \n  # indented comment\tx\nexample/workmux\thosta\t2026-09-28\tn\n", "hosta");
    expect(r).toEqual({ taps: ["example/svc", "example/workmux"], warnings: [] });
  });
  test("malformed rows warn once each and are skipped", () => {
    const r = load(
      [
        "example/workmux\thosta",
        "not a tap\t*\t2026-09-28\tx",
        "evil/tap;rm -rf\t*\t2026-09-28\tx",
        "example/workmux example\t*\t2026-09-28",
        "example/other\t*\t2026-09-28\tok",
      ].join("\n"),
      "hosta",
    );
    expect(r.taps).toEqual(["example/svc", "example/other"]);
    expect(r.warnings).toHaveLength(4);
    for (const w of r.warnings) expect(w).toStartWith("approved-taps: ignoring malformed row: ");
  });
  test("no file is a silent no-op", () => {
    expect(load("", "hosta")).toEqual({ taps: ["example/svc"], warnings: [] });
  });
  test("no duplicates, whether already in the base list or listed twice", () => {
    const r = load("example/svc\t*\t2026-09-28\nexample/workmux\t*\t2026-09-28\nexample/workmux\thosta\t2026-09-28\n", "hosta");
    expect(r.taps).toEqual(["example/svc", "example/workmux"]);
  });
  test("a CRLF file still applies, host * and a host row with CR on the last field", () => {
    const r = load("# c\r\nexample/workmux\t*\t2026-09-28\tnote\r\nexample/tf\thosta\t2026-09-28\r\n", "hosta");
    expect(r.taps).toEqual(["example/svc", "example/workmux", "example/tf"]);
  });
  test("the tap is lower-cased", () => {
    expect(load("Example/Workmux\t*\t2026-09-28\n", "hosta").taps).toContain("example/workmux");
  });
  test("whitespace around fields is stripped", () => {
    expect(load("  example/workmux  \t hosta \t 2026-09-28 \t x\n", "hosta").taps).toContain("example/workmux");
  });
  test("an empty host column warns and does not apply (tabs never collapse)", () => {
    const r = load("example/workmux\t\t2026-09-28\tx\n", "hosta");
    expect(r.taps).toEqual(["example/svc"]);
    expect(r.warnings).toHaveLength(1);
  });
  test("a host that is not * or a hostname warns and does not apply", () => {
    const r = load("example/workmux\thosta,hostd\t2026-09-28\nexample/tf\t*hostd\t2026-09-28\n", "hostd");
    expect(r.taps).toEqual(["example/svc"]);
    expect(r.warnings).toHaveLength(2);
  });
});

describe("tapIn", () => {
  test("literal membership; an empty tap is never in the list", () => {
    expect(tapIn("", ["example/svc", "homebrew/core"])).toBe(false);
    expect(tapIn("", ["example/svc", "", "homebrew/core"])).toBe(false);
    expect(tapIn("example/svc", ["example/svc"])).toBe(true);
    expect(tapIn("example/work.ux", ["example/workmux"])).toBe(false);
  });
});

describe("outdatedVersions", () => {
  for (const [pkg, line, want] of [
    ["terraform", "example/tf/terraform (1.16.3) < 1.16.4", "1.16.3→1.16.4"],
    ["workmux", "example/workmux/workmux (0.1.266) < 0.1.268 [pinned at 0.1.266]", "0.1.266→0.1.268"],
    ["good-a", "good-a (1.0) < 1.1", "1.0→1.1"],
    ["python@3.13", "python@3.13 (3.13.5) < 3.13.6", "3.13.5→3.13.6"],
    ["kit", "other/tap/xkit (1.0) < 2.0", "?→?"],
    ["x.y", "org/tap/xzy (1.0) < 2.0", "?→?"],
  ] as const) {
    test(`${pkg} ← '${line}' → ${want}`, () => expect(outdatedVersions(pkg, `unrelated (0) < 1\n${line}\n`)).toBe(want));
  }
  test("a cask line with != and several installed versions", () => {
    expect(outdatedVersions("tool", "tool (1.0, 1.1) != 1.2")).toBe("1.0, 1.1→1.2");
    expect(outdatedVersions("tool", "tool (1.0) != 1.2 [pinned at 1.0]")).toBe("1.0→1.2");
  });
});
