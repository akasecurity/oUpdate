// `oupdate targets parity --record FILE --script-log FILE --date YYYY-MM-DD --ledger FILE [--target ID]`: compares one
// night's oupdate record (the target's parityTo jsonl) with nas-secure-update.sh's log of the same night, appends one row
// to the ledger tsv and prints the row and the parity status. Exit 0 when the night matched, 1 when it did not. A usage
// or input error throws (exit 2 in src/cli.ts). A night with no oupdate record is a difference, never a skip.

import { addNight, compareNight, ledgerStatus, parseLedger, parseScriptLog, recordFacts, renderLedger, type OupRecord } from "./parity.ts";
import type { TargetFs } from "./run.ts";

export interface ParityCommand {
  record: string;
  scriptLog: string;
  date: string;
  ledger: string;
  target?: string;
}

const USAGE = "usage: oupdate targets parity --record FILE --script-log FILE --date YYYY-MM-DD --ledger FILE [--target ID]";
const FLAGS: Record<string, keyof ParityCommand> = { "--record": "record", "--script-log": "scriptLog", "--date": "date", "--ledger": "ledger", "--target": "target" };

export function parseParityCommand(argv: string[]): ParityCommand {
  const c: Partial<ParityCommand> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!Object.hasOwn(FLAGS, a)) throw new Error(`unknown flag ${a} (${USAGE})`);
    const v = argv[++i];
    if (v === undefined || v.startsWith("--")) throw new Error(`${a} needs a value`);
    c[FLAGS[a]!] = v;
  }
  if (!c.record || !c.scriptLog || !c.date || !c.ledger) throw new Error(USAGE);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(c.date)) throw new Error("--date must be YYYY-MM-DD");
  return c as ParityCommand;
}

export async function parityMain(c: ParityCommand, d: { fs: TargetFs; out: (l: string) => void }): Promise<number> {
  const log = await d.fs.readFile(c.scriptLog);
  if (log === undefined) throw new Error(`cannot read the script log ${c.scriptLog}`);
  const night = parseScriptLog(log);
  if (night.date && night.date !== c.date) throw new Error(`the script log is for ${night.date}, not ${c.date}`);
  const records = ((await d.fs.readFile(c.record)) ?? "").split("\n").filter((l) => l.trim()).map((l, i) => {
    try {
      return JSON.parse(l) as OupRecord;
    } catch {
      throw new Error(`${c.record} line ${i + 1} is not JSON`);
    }
  });
  const rec = records.filter((r) => r.date === c.date && (!c.target || r.target === c.target)).pop();
  const rows = parseLedger(await d.fs.readFile(c.ledger));
  const row = addNight(rows, compareNight(c.date, recordFacts(rec), night));
  await d.fs.writeFile(c.ledger, renderLedger([...rows, row]));
  const cells = Object.entries(row.cells).map(([k, v]) => `${k} ${v}`).join(", ");
  d.out(`${c.date}: ${row.match ? "match" : "DIFFERS"} (${cells}); verdicts oupdate ${row.verdictOupdate}, script ${row.verdictScript}${rec ? "" : "; no oupdate record for this night"}`);
  d.out(ledgerStatus([...rows, row]).line);
  return row.match ? 0 : 1;
}
