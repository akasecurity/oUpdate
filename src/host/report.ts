// One host report: inventory, outdated, OSV advisories for npm globals, and the
// shadow comparison against that day's summary from the previous updater's log (prev-log.ts). Report-only.

import { parseBrewInfo, parseBrewOutdated, parseNpmLs, parseNpmOutdated, parseDockerImages, parseSwVers, parseSoftwareUpdate, parseCliVersions, type Item, type Outdated } from "./collect.ts";
import { parsePrevSummary, type PrevSummary } from "./prev-log.ts";
import { compareRun, type Comparison } from "./compare.ts";
import { DEFAULT_COMPAT } from "../targets/compat.ts";
import type { Advisory, AdvisoryFeed } from "../adapters/advisory/osv.ts";

export interface RawProbe {
  brewInfo: string;
  brewOutdated: string;
  npmLs: string;
  npmOutdated: string;
  docker: string;
  swVers: string;
  softwareUpdate: string;
  clis: string;
}

export interface HostReport {
  host: string;
  date: string;
  generatedAt: string;
  inventory: Item[];
  outdated: Outdated[];
  advisories: Advisory[] | null;
  previous: PrevSummary | null;
  compare: Comparison | null;
  notes: string[];
}

export function localDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export async function hostReport(a: { host: string; raw: RawProbe; prevLog: string; prev: Item[] | undefined; feed: AdvisoryFeed; now: Date; previousUpdater?: string }): Promise<HostReport> {
  const notes: string[] = [];
  const inventory: Item[] = [
    parseSwVers(a.raw.swVers),
    ...parseBrewInfo(a.raw.brewInfo),
    ...parseNpmLs(a.raw.npmLs),
    ...parseDockerImages(a.raw.docker),
    ...parseCliVersions(a.raw.clis),
  ];
  const outdated = [...parseBrewOutdated(a.raw.brewOutdated), ...parseNpmOutdated(a.raw.npmOutdated), ...parseSoftwareUpdate(a.raw.softwareUpdate)];
  let advisories: Advisory[] | null = null;
  try {
    advisories = await a.feed.query(inventory.filter((i) => i.kind === "npm-global").map((i) => ({ ecosystem: "npm", name: i.name, version: i.version })));
  } catch (e) {
    notes.push(`advisory lookup failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  const name = a.previousUpdater ?? DEFAULT_COMPAT.previousUpdater;
  const summary = parsePrevSummary(a.prevLog, a.host, name);
  if (!summary) notes.push(`no ${name} summary for ${a.host}`);
  else if (summary.aborted) notes.push(`${name} run aborted`);
  if (summary && !a.prev) notes.push("no previous snapshot: upgrade comparison starts next run");
  const compare = summary ? compareRun({ prev: a.prev, cur: inventory, outdated, summary }) : null;
  return { host: a.host, date: summary?.date ?? localDate(a.now), generatedAt: a.now.toISOString(), inventory, outdated, advisories, previous: summary, compare, notes };
}
