// The spec §8 replay: past script nights rebuilt from their logs and reviewed again; the final decision must match.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { replayMain, type ReplayDeps } from "../../scripts/nas-replay.ts";

const FIX = join(import.meta.dir, "../fixtures/nas");
const LOGS: Record<string, string> = {
  "20261025.log": readFileSync(join(FIX, "script-night.log"), "utf8"),
  "20261026.log": readFileSync(join(FIX, "script-planted.log"), "utf8"),
  "notes.txt": "ignored",
};
const SPEC = (name: string) => JSON.stringify({ type: "command", name, argv: ["/bin/cat"] });

function deps(answer: (prompt: string, reviewer: string) => string, logs: Record<string, string | undefined> = LOGS): { d: ReplayDeps; out: string[]; prompts: string[] } {
  const out: string[] = [];
  const prompts: string[] = [];
  return {
    out,
    prompts,
    d: {
      list: async () => Object.keys(logs),
      read: async (p) => logs[p.split("/").pop()!],
      makeReviewer: (s) => ({ name: s.name, review: async (p) => (prompts.push(p), answer(p, s.name)) }),
      out: (l) => out.push(l),
    },
  };
}
const ARGV = ["--logs", "/logs", "--reviewer", SPEC("router-model"), "--second-reviewer", SPEC("onprem-model"), "--min-nights", "2"];
const OK = "1. none\n2. Verdict: APPROVE";
const UNCHANGED = "=== storage-box secure-update 2026-10-27 04:12 ===\ncontainers: all images up to date\n=== storage-box summary ===\n  containers: up to date\n";
const NO_SECTION = "=== storage-box secure-update 2026-10-28 04:12 ===\n";

describe("nas replay", () => {
  test("both nights agree: the clean one clears, the planted one is blocked by the pre-gate", async () => {
    const { d, out, prompts } = deps(() => "1. none\n2. Verdict: APPROVE");
    expect(await replayMain(ARGV, d)).toBe(0);
    expect(out[0]).toStartWith("20261025.log\toupdate cleared\tscript cleared\tsame");
    expect(out[1]).toStartWith("20261026.log\toupdate blocked\tscript blocked\tsame");
    expect(out[2]).toBe("replay: 2 of 2 replayed nights agree; 0 verified unchanged; 0 incomplete; 2 nights covered, at least 2 needed");
    expect(prompts[0]).toContain("Today is 2026-10-25.");
    expect(prompts[0]).toContain("| [registry.example/team/app:1]\n| RUN echo v2");
  });

  test("a model that now flags the clean night is a difference; exit 1", async () => {
    const { d, out } = deps(() => "1. RUN echo v2\n2. Verdict: FLAG");
    expect(await replayMain(ARGV, d)).toBe(1);
    expect(out[0]).toStartWith("20261025.log\toupdate blocked\tscript cleared\tDIFFERS");
    // The planted night is still blocked by the pre-gate, but the router's verdict differs from the script's.
    expect(out[1]).toStartWith("20261026.log\toupdate blocked\tscript blocked\tDIFFERS\trouter FLAG (script APPROVE)");
    expect(out.at(-1)).toBe("replay: 0 of 2 replayed nights agree; 0 verified unchanged; 0 incomplete; 2 nights covered, at least 2 needed");
  });

  test("each reviewer's verdict is compared, not only the final decision (Codex 6)", async () => {
    const { d, out } = deps((_p, who) => (who === "onprem-model" ? "1. RUN echo v2\n2. Verdict: FLAG" : OK), { "20261025.log": LOGS["20261025.log"] });
    expect(await replayMain([...ARGV.slice(0, -1), "1"], d)).toBe(1);
    expect(out[0]).toStartWith("20261025.log\toupdate blocked\tscript cleared\tDIFFERS\trouter APPROVE, on-prem FLAG (script APPROVE)");
  });

  test("a verified-unchanged night is covered; an unreadable log or one with no container section is incomplete and fails (Codex 6)", async () => {
    const ok = deps(() => OK, { ...LOGS, "20261027.log": UNCHANGED });
    expect(await replayMain([...ARGV.slice(0, -1), "3"], ok.d)).toBe(0);
    expect(ok.out).toContain("20261027.log\tverified unchanged");
    for (const bad of [undefined, NO_SECTION]) {
      const r = deps(() => OK, { ...LOGS, "20261028.log": bad });
      expect(await replayMain(ARGV, r.d)).toBe(1);
      expect(r.out.find((l) => l.startsWith("20261028.log"))).toStartWith("20261028.log\tINCOMPLETE: ");
      expect(r.out.at(-1)).toContain("; 1 incomplete;");
    }
  });

  test.each([
    ["a bare layer diff heading", "--- layer diff ---\n"],
    ["a truncated up-to-date line with no date or summary", "containers: all images up to date\n"],
    ["up to date with no final summary", "=== storage-box secure-update 2026-10-28 04:12 ===\ncontainers: all images up to date\n"],
    ["up to date but a summary that says updated", "=== storage-box secure-update 2026-10-28 04:12 ===\ncontainers: all images up to date\n=== storage-box summary ===\n  containers: updated (1 pulled)\n"],
  ])("%s is INCOMPLETE, never verified unchanged (Codex r2-1)", async (_what, log) => {
    const r = deps(() => OK, { ...LOGS, "20261028.log": log });
    expect(await replayMain([...ARGV.slice(0, -1), "2"], r.d)).toBe(1);
    expect(r.out.find((l) => l.startsWith("20261028.log"))).toStartWith("20261028.log\tINCOMPLETE: ");
  });

  test("coverage counts distinct calendar nights: a second copy of one night, or a bad date, is INCOMPLETE (Codex r2-2)", async () => {
    const dup = deps(() => OK, { "20261025.log": LOGS["20261025.log"], "copy.log": LOGS["20261025.log"] });
    expect(await replayMain(ARGV, dup.d)).toBe(1);
    expect(dup.out).toContain("copy.log\tINCOMPLETE: a second log for 2026-10-25 (first: 20261025.log)");
    expect(dup.out.at(-1)).toContain("; 1 nights covered, at least 2 needed");
    const bad = deps(() => OK, { ...LOGS, "x.log": UNCHANGED.replace("2026-10-27", "2026-13-40") });
    expect(await replayMain([...ARGV.slice(0, -1), "2"], bad.d)).toBe(1);
    expect(bad.out).toContain("x.log\tINCOMPLETE: no valid date in the log");
  });

  test("fewer nights than --min-nights (default 30) is incomplete coverage and fails (Codex 6)", async () => {
    const { d, out } = deps(() => OK);
    expect(await replayMain(ARGV.slice(0, -2), d)).toBe(1);
    expect(out.at(-1)).toBe("replay: 2 of 2 replayed nights agree; 0 verified unchanged; 0 incomplete; 2 nights covered, at least 30 needed");
  });

  test("missing flags are a usage error", async () => {
    await expect(replayMain(["--logs", "/logs"], deps(() => "").d)).rejects.toThrow("usage: bun scripts/nas-replay.ts");
  });
});
