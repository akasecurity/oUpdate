// Parity: the script's log read back into the same facts oupdate records, compared night by night, and the ledger's
// streak, reset and adjudication rules (spec §6).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { addNight, compareNight, LEDGER_HEAD, ledgerStatus, parseLedger, parseScriptLog, recordFacts, renderLedger, type LedgerRow, type OupRecord } from "../../src/targets/parity.ts";

const APP = "registry.example/team/app:1";
const fixture = (n: string) => readFileSync(join(import.meta.dir, "../fixtures/nas", n), "utf8");
const PLANTED_HIT = 'ENTRYPOINT/CMD changed: ["/init"]|null -> ["/bin/sh","-c","/app/hooks/prestart.sh && /init"]|null';
const rec = (o: Partial<OupRecord> = {}): OupRecord => ({ date: "2026-10-25", target: "storage-box", rev: "r", checked: true, changed: [APP], pregate: [], verdict: { primary: "APPROVE", secondary: "APPROVE" }, plugins: ["example.plugin 2026.09.01 -> 2026.10.01"], os: "up to date", ...o });

describe("parseScriptLog", () => {
  test("a clean night", () => {
    expect(parseScriptLog(fixture("script-night.log"))).toEqual({
      date: "2026-10-25", final: "updated (1 pulled)", diffs: [{ ref: APP, diff: "RUN echo v2" }],
      changed: [APP], plugins: ["example.plugin 2026.09.01 -> 2026.10.01"], os: "up to date", pregate: [], verdict: "APPROVE/APPROVE",
    });
  });

  test("the planted night: the pre-gate hit, the block, the OS update", () => {
    const n = parseScriptLog(fixture("script-planted.log"));
    expect(n).toMatchObject({ date: "2026-10-26", final: "blocked (1 pulled — review failed)", changed: [APP], plugins: [], os: "UPDATE AVAILABLE: 7.1.4 -> 7.2.0", pregate: [PLANTED_HIT], verdict: "APPROVE/APPROVE" });
    expect(n.diffs).toEqual([{ ref: APP, diff: `${PLANTED_HIT}\nRUN echo v2` }]);
  });

  test("a night with no container or plugin section is unknown there", () => {
    expect(parseScriptLog("=== prev-update box 2026-10-25 04:12 ===\nOS: up to date\n")).toMatchObject({ changed: "unknown", plugins: "unknown", os: "up to date" });
    expect(parseScriptLog("containers: all images up to date\n").changed).toEqual([]);
    expect(parseScriptLog("  LLM review skipped — AI host unreachable\n").verdict).toBe("unavailable/not asked");
  });
});

describe("compareNight", () => {
  test("oupdate's record and the script's log agree on a clean night", () => {
    const c = compareNight("2026-10-25", recordFacts(rec()), parseScriptLog(fixture("script-night.log")));
    expect(c).toEqual({ date: "2026-10-25", fields: { changed: true, plugins: true, os: true, pregate: true }, match: true, verdictOupdate: "APPROVE/APPROVE", verdictScript: "APPROVE/APPROVE" });
  });

  test("and on the planted night", () => {
    const r = rec({ date: "2026-10-26", pregate: [PLANTED_HIT], plugins: [], os: "UPDATE AVAILABLE: 7.1.4 -> 7.2.0" });
    expect(compareNight("2026-10-26", recordFacts(r), parseScriptLog(fixture("script-planted.log"))).match).toBe(true);
  });

  test("a differing plugin list, an unchecked night or a missing record does not match", () => {
    const script = parseScriptLog(fixture("script-night.log"));
    expect(compareNight("2026-10-25", recordFacts(rec({ plugins: [] })), script).fields.plugins).toBe(false);
    expect(compareNight("2026-10-25", recordFacts(rec({ checked: false })), script).match).toBe(false);
    expect(compareNight("2026-10-25", recordFacts(undefined), script)).toMatchObject({ match: false, fields: { changed: false, plugins: false, os: false } });
  });
});

describe("ledger", () => {
  const night = (date: string, match = true, verdicts: [string, string] = ["APPROVE/APPROVE", "APPROVE/APPROVE"]) => ({
    date, fields: { changed: match, plugins: true, os: true, pregate: true }, match, verdictOupdate: verdicts[0], verdictScript: verdicts[1],
  });
  const build = (...ns: ReturnType<typeof night>[]) => ns.reduce<LedgerRow[]>((rows, n) => [...rows, addNight(rows, n)], []);

  test("matching nights count up; a deterministic difference resets to 0", () => {
    const rows = build(night("2026-10-25"), night("2026-10-26"), night("2026-10-27", false), night("2026-10-28"));
    expect(rows.map((r) => r.streak)).toEqual([1, 2, 0, 1]);
    expect(rows[2]!.cells.changed).toBe("DIFFERS");
  });

  test("a verdict difference keeps the count but stays open until adjudicated", () => {
    const rows = build(night("2026-10-25"), night("2026-10-26", true, ["FLAG/not asked", "APPROVE/APPROVE"]));
    expect(rows[1]).toMatchObject({ streak: 2, adjudication: "open" });
    expect(rows[0]!.adjudication).toBe("");
  });

  test("a skipped night restarts the count; month and year boundaries do not (Codex 5)", () => {
    expect(build(night("2026-10-25"), night("2026-10-27")).map((r) => r.streak)).toEqual([1, 1]);
    expect(build(night("2026-10-30"), night("2026-10-31"), night("2026-11-01"), night("2026-11-02")).map((r) => r.streak)).toEqual([1, 2, 3, 4]);
    expect(build(night("2027-02-28"), night("2027-03-01")).map((r) => r.streak)).toEqual([1, 2]);
    expect(build(night("2028-02-28"), night("2028-03-01")).map((r) => r.streak)).toEqual([1, 1]);
    expect(build(night("2026-12-31"), night("2027-01-01")).map((r) => r.streak)).toEqual([1, 2]);
  });

  test("seven monthly matching records are not seven nights in a row (Codex 5)", () => {
    const rows = build(...Array.from({ length: 7 }, (_, i) => night(`2026-0${i + 1}-15`)));
    expect(ledgerStatus(rows)).toMatchObject({ streak: 1, ready: false });
  });

  test("stored streaks are never trusted: they are recomputed from dates and matches on load (Codex r2-3)", () => {
    const row = (d: string, streak: number) => `${d}\tsame\tsame\tsame\tsame\tyes\t${streak}\tAPPROVE/APPROVE\tAPPROVE/APPROVE\t`;
    const text = [LEDGER_HEAD, ...[1, 2, 3, 4, 5, 6].map((m) => row(`2026-0${m}-15`, m))].join("\n") + "\n";
    const rows = parseLedger(text);
    expect(rows.map((r) => r.streak)).toEqual([1, 1, 1, 1, 1, 1]);
    const next = addNight(rows, night("2026-06-16"));
    expect(next.streak).toBe(2);
    expect(ledgerStatus([...rows, next])).toMatchObject({ streak: 2, ready: false });
    // ledgerStatus recomputes too, whatever rows it is handed.
    expect(ledgerStatus(rows.map((r, i) => ({ ...r, streak: 7 + i }))).ready).toBe(false);
    expect(() => parseLedger([LEDGER_HEAD, row("2026-06-15", 1), row("2026-06-14", 2)].join("\n"))).toThrow("parity ledger: row 3 is not after row 2");
  });

  test("ready after 7 matching nights with no open adjudication", () => {
    const dates = Array.from({ length: 7 }, (_, i) => `2026-11-0${i + 1}`);
    const rows = build(...dates.map((d) => night(d)));
    expect(ledgerStatus(rows)).toEqual({ streak: 7, open: 0, ready: true, line: "parity: 7 of 7 matching nights in a row — ready for cutover" });
    const withOpen = build(...dates.map((d, i) => night(d, true, i === 3 ? ["FLAG/not asked", "APPROVE/APPROVE"] : ["APPROVE/APPROVE", "APPROVE/APPROVE"])));
    expect(ledgerStatus(withOpen)).toMatchObject({ ready: false, open: 1, line: "parity: 7 of 7 matching nights in a row, 1 verdict difference open" });
  });

  test("a night already in the ledger, or before its last night, is refused", () => {
    const rows = build(night("2026-10-26"));
    expect(() => addNight(rows, night("2026-10-26"))).toThrow("parity: 2026-10-26 is already in the ledger");
    expect(() => addNight(rows, night("2026-10-25"))).toThrow("parity: 2026-10-25 is before the ledger's last night 2026-10-26");
  });

  test("render and parse round-trip; an edited adjudication is kept", () => {
    const rows = build(night("2026-10-25"), night("2026-10-26", true, ["FLAG/not asked", "APPROVE/APPROVE"]));
    const text = renderLedger(rows);
    expect(text.split("\n")[0]).toBe(LEDGER_HEAD);
    expect(parseLedger(text)).toEqual(rows);
    const edited = text.replace("\topen\n", "\toupdate right\n");
    expect(parseLedger(edited)[1]!.adjudication).toBe("oupdate right");
    expect(ledgerStatus(parseLedger(edited)).open).toBe(0);
    expect(() => parseLedger("date\tother\n")).toThrow("parity ledger: unexpected header");
    expect(parseLedger(undefined)).toEqual([]);
  });
});
