// One host report: inventory, outdated, OSV advisories for npm globals, and the
// shadow comparison against that day's previous updater summary. Report-only.

import { parseBrewInfo, parseBrewOutdated, parseNpmLs, parseNpmOutdated, parseDockerImages, parseSwVers, parseSoftwareUpdate, parseCliVersions, type Item, type Outdated } from "./collect.ts";
import { parseSuSummary, type SuSummary } from "./prev-log.ts";
import { compareRun, type Comparison } from "./compare.ts";
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
  secureUpdate: SuSummary | null;
  compare: Comparison | null;
  notes: string[];
}

export function localDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export async function hostReport(a: { host: string; raw: RawProbe; prevLog: string; prev: Item[] | undefined; feed: AdvisoryFeed; now: Date }): Promise<HostReport> {
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
  const su = parseSuSummary(a.prevLog, a.host);
  if (!su) notes.push(`no previous updater summary for ${a.host}`);
  else if (su.aborted) notes.push("the previous updater run aborted");
  if (su && !a.prev) notes.push("no previous snapshot: upgrade comparison starts next run");
  const compare = su ? compareRun({ prev: a.prev, cur: inventory, outdated, su }) : null;
  return { host: a.host, date: su?.date ?? localDate(a.now), generatedAt: a.now.toISOString(), inventory, outdated, advisories, secureUpdate: su, compare, notes };
}
