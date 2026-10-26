// `oupdate targets parity`: one night's record and the script's log in, one ledger row and the status line out.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parityMain, parseParityCommand } from "../../src/targets/parity-cli.ts";
import { LEDGER_HEAD } from "../../src/targets/parity.ts";
import { memFs } from "./fakes.ts";

const LOG = readFileSync(join(import.meta.dir, "../fixtures/nas/script-night.log"), "utf8");
const REC = JSON.stringify({ date: "2026-10-25", target: "storage-box", rev: "r", checked: true, changed: ["registry.example/team/app:1"], pregate: [], verdict: { primary: "APPROVE", secondary: "APPROVE" }, plugins: ["example.plugin 2026.09.01 -> 2026.10.01"], os: "up to date" });
const ARGS = ["--record", "/p/box.jsonl", "--script-log", "/p/20261025.log", "--date", "2026-10-25", "--ledger", "/p/ledger.tsv"];

describe("oupdate targets parity", () => {
  test("parseParityCommand", () => {
    expect(parseParityCommand([...ARGS, "--target", "storage-box"])).toEqual({ record: "/p/box.jsonl", scriptLog: "/p/20261025.log", date: "2026-10-25", ledger: "/p/ledger.tsv", target: "storage-box" });
    expect(() => parseParityCommand(ARGS.slice(2))).toThrow("usage: oupdate targets parity");
    expect(() => parseParityCommand([...ARGS.slice(0, 4), "--date", "25.10.2026", ...ARGS.slice(6)])).toThrow("--date must be YYYY-MM-DD");
    expect(() => parseParityCommand([...ARGS, "--force"])).toThrow("unknown flag --force");
    expect(() => parseParityCommand(["--record"])).toThrow("--record needs a value");
  });

  test("a matching night appends a row and prints the status; exit 0", async () => {
    const { fs, files } = memFs({ "/p/box.jsonl": `${REC}\n`, "/p/20261025.log": LOG });
    const out: string[] = [];
    expect(await parityMain(parseParityCommand(ARGS), { fs, out: (l) => out.push(l) })).toBe(0);
    expect(files.get("/p/ledger.tsv")).toBe(`${LEDGER_HEAD}\n2026-10-25\tsame\tsame\tsame\tsame\tyes\t1\tAPPROVE/APPROVE\tAPPROVE/APPROVE\t\n`);
    expect(out).toEqual(["2026-10-25: match (changed same, plugins same, os same, pregate same); verdicts oupdate APPROVE/APPROVE, script APPROVE/APPROVE", "parity: 1 of 7 matching nights in a row"]);
  });

  test("no oupdate record for the night is a difference; exit 1", async () => {
    const { fs, files } = memFs({ "/p/20261025.log": LOG });
    const out: string[] = [];
    expect(await parityMain(parseParityCommand(ARGS), { fs, out: (l) => out.push(l) })).toBe(1);
    expect(files.get("/p/ledger.tsv")).toContain("\tno\t0\t");
    expect(out[0]).toEndWith("; no oupdate record for this night");
  });

  test("a script log for another night, or no log, is an error", async () => {
    const { fs } = memFs({ "/p/box.jsonl": REC, "/p/20261025.log": LOG.replace("2026-10-25 04:12", "2026-10-24 04:12") });
    await expect(parityMain(parseParityCommand(ARGS), { fs, out: () => {} })).rejects.toThrow("the script log is for 2026-10-24, not 2026-10-25");
    await expect(parityMain(parseParityCommand(ARGS), { fs: memFs().fs, out: () => {} })).rejects.toThrow("cannot read the script log /p/20261025.log");
  });
});
