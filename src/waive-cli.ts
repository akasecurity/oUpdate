// `oupdate waive add|list|remove`: the waiver records in <state dir>/waivers.json (see waiver.ts).

import { readFileSync } from "node:fs";
import { addWaiver, listWaivers, removeWaiver, sha256Hex } from "./waiver.ts";

const USAGE = "usage: oupdate waive add --state-dir DIR --eco npm|pypi --name N --version V (--file BINARY | --sha256 HEX) --reason TEXT --who NAME\n       oupdate waive list --state-dir DIR\n       oupdate waive remove --state-dir DIR --eco npm|pypi --name N --version V (--file BINARY | --sha256 HEX)\n       A waiver added after a gate hold does not re-gate that pull request: push a commit, or clear its status and comment.";

export interface WaiveCommand {
  verb: "add" | "list" | "remove";
  stateDir: string;
  eco?: "npm" | "pypi";
  name?: string;
  version?: string;
  file?: string;
  sha256?: string;
  reason?: string;
  who?: string;
}

export function parseWaiveArgs(argv: string[]): WaiveCommand {
  const [verb, ...rest] = argv;
  if (verb !== "add" && verb !== "list" && verb !== "remove") throw new Error(USAGE);
  const f = new Map<string, string>();
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (!["--state-dir", "--eco", "--name", "--version", "--file", "--sha256", "--reason", "--who"].includes(a)) throw new Error(`unknown flag ${a}\n${USAGE}`);
    const v = rest[++i];
    if (v === undefined) throw new Error(`${a} needs a value`);
    f.set(a, v);
  }
  const need = (...ks: string[]) => { for (const k of ks) if (!f.get(k)?.trim()) throw new Error(`waive ${verb} needs ${k}\n${USAGE}`); };
  need("--state-dir");
  const c: WaiveCommand = { verb, stateDir: f.get("--state-dir")! };
  if (verb === "list") return c;
  need("--eco", "--name", "--version");
  const eco = f.get("--eco");
  if (eco !== "npm" && eco !== "pypi") throw new Error("--eco must be npm or pypi");
  if (!f.get("--file") && !f.get("--sha256")) throw new Error("waive needs --file or --sha256");
  if (f.get("--file") && f.get("--sha256")) throw new Error("waive takes --file or --sha256, not both");
  if (verb === "add") need("--reason", "--who");
  Object.assign(c, { eco, name: f.get("--name"), version: f.get("--version"), file: f.get("--file"), sha256: f.get("--sha256")?.toLowerCase(), reason: f.get("--reason"), who: f.get("--who") });
  return c;
}

/** Returns the exit code: 0 done, 1 `remove` found nothing. */
export function waiveMain(c: WaiveCommand, io: { out: (l: string) => void; now: Date }): number {
  if (c.verb === "list") {
    const all = listWaivers(c.stateDir);
    if (!all.length) io.out("no waivers");
    for (const w of all) io.out(`${w.eco} ${w.name}@${w.version} sha256 ${w.sha256} waived by ${w.who} at ${w.at}: ${w.reason}`);
    return 0;
  }
  const sha256 = c.sha256 ?? sha256Hex(readFileSync(c.file!));
  const key = { eco: c.eco!, name: c.name!, version: c.version!, sha256 };
  if (c.verb === "add") {
    addWaiver(c.stateDir, { ...key, reason: c.reason!, who: c.who!, at: io.now.toISOString() });
    io.out(`waived ${key.eco} ${key.name}@${key.version} sha256 ${sha256}`);
    return 0;
  }
  const n = removeWaiver(c.stateDir, key);
  io.out(n ? `removed ${n} waiver(s) for ${key.name}@${key.version} sha256 ${sha256}` : `no waiver for ${key.name}@${key.version} sha256 ${sha256}`);
  return n ? 0 : 1;
}
