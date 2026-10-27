// Case sets. "core" is the published set: the bar (9/9 attacks, 8/8 controls) and the 26 Oct
// result are scored on it. "extended" holds further real compromised releases and their clean
// controls, scored on their own counts. An entry in cases.json or controls.json without a
// "set" key is core; the synthetic evasion cases are core and keep their own scorecard line.

import { readFileSync } from "node:fs";
import { join } from "node:path";

export type CaseSet = "core" | "extended";
export type SetChoice = CaseSet | "all";
export const SETS: SetChoice[] = ["core", "extended", "all"];

export interface SetEntry {
  id: string;
  set?: CaseSet;
  source?: { type: string };
}

export function setOf(e: SetEntry): CaseSet {
  const s = e.set ?? "core";
  if (s !== "core" && s !== "extended") throw new Error(`case ${e.id}: unknown set ${String(s)}; sets: core,extended`);
  return s;
}

export const inSet = (e: SetEntry, choice: SetChoice) => choice === "all" || setOf(e) === choice;

/** The --set flag value; absent means core. */
export function parseSet(v: string | undefined): SetChoice {
  const s = (v ?? "core") as SetChoice;
  if (!SETS.includes(s)) throw new Error(`unknown set ${v}; sets: ${SETS.join(",")}`);
  return s;
}

export function loadSets(dir = import.meta.dir): { cases: SetEntry[]; controls: SetEntry[] } {
  const read = (f: string) => JSON.parse(readFileSync(join(dir, f), "utf8")) as SetEntry[];
  return { cases: read("cases.json"), controls: read("controls.json") };
}

/**
 * Counts for one set. attacks: the real releases (the replay included, synthetic cases not);
 * dataset: the attacks acceptance/run.ts runs itself (DataDog samples, so not the replay).
 */
export function setCounts(sets: { cases: SetEntry[]; controls: SetEntry[] }, choice: SetChoice) {
  const attacks = sets.cases.filter((c) => inSet(c, choice) && c.source?.type !== "synthetic");
  const controls = sets.controls.filter((c) => inSet(c, choice));
  return {
    attacks: attacks.length,
    dataset: attacks.filter((c) => c.source?.type === "datadog").length,
    controls: controls.length,
    attackIds: new Set(attacks.map((c) => c.id)),
    controlIds: new Set(controls.map((c) => c.id)),
  };
}
