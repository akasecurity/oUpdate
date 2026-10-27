#!/usr/bin/env bun
// Acceptance run: every malicious case (cases.json, dataset samples), every synthetic
// evasion case (cases.json, built in memory by acceptance/synthetic/generate.ts) and every
// benign control (controls.json, registry releases) goes through every layer.
// STATIC ONLY: nothing downloaded is installed, imported or run. The gate layer
// is never run here, because running a package's tests would run the payload.
//
// usage: bun acceptance/run.ts [--reviewers <file | JSON array>] [--only <id,...>] [--layers <layer,...>]
// --layers prepass,scan,reviewer,gate runs with no outside knowledge (no advisory, no cooldown).
//          [--scanner <JSON>] [--work <dir>] [--offline] [--set core|extended|all]
//   --set picks the cases (acceptance/sets.ts): core (default) is the published set scored
//   against the bar; extended is the further real releases and their controls; all is both.
//   --work keeps every downloaded artifact in <dir>/<id>/ (default ./acceptance-work);
//   --offline reviews what is already in --work and downloads nothing, so a
//   second machine can score its reviewers against the same bytes.
// Results go to ./acceptance-results/<id>[-<reviewer>].json and summary.txt; summary.txt
// ends with a scorecard per reviewer (acceptance/scorecard.ts) beside the published result.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { readArtifact, normalizePaths } from "../src/artifact.ts";
import { readSample } from "../src/dataset.ts";
import { reviewUpdate, classifyOutcome, LAYERS, type LayerName, type ReviewResult } from "../src/review.ts";
import { npmRegistry } from "../src/adapters/ecosystem/npm.ts";
import { pypiRegistry } from "../src/adapters/ecosystem/pypi.ts";
import { osvFeed } from "../src/adapters/advisory/osv.ts";
import { makeReviewer, validateReviewerSpec, type ReviewerSpec } from "../src/adapters/reviewer/spec.ts";
import { makeScanner, parseScannerSpec } from "../src/adapters/scanner/spec.ts";
import { scorecard, type ScoreRow } from "./scorecard.ts";
import { inSet, parseSet, setCounts, type CaseSet } from "./sets.ts";
import { syntheticPair, type SyntheticKind } from "./synthetic/generate.ts";
import type { Registry } from "../src/adapters/ecosystem/types.ts";
import type { Ecosystem, FileMap } from "../src/prepass.ts";

interface Case {
  id: string;
  eco: Ecosystem;
  name: string;
  good: string;
  bad: string;
  source?: { type: "datadog"; path: string } | { type: "replay"; script: string } | { type: "synthetic"; generator: SyntheticKind };
  window?: { published?: string; removed?: string };
  set?: CaseSet;
}

const DATASET_API = "https://api.github.com/repos/DataDog/malicious-software-packages-dataset/contents/samples";
const DATASET_PASS = "infected"; // the dataset's published passphrase

const argv = process.argv.slice(2);
const flag = (n: string) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : undefined;
};
const offline = argv.includes("--offline");
const work = resolve(flag("--work") ?? "acceptance-work");
const results = resolve("acceptance-results");
mkdirSync(results, { recursive: true });
const only = flag("--only")?.split(",");
const layers = flag("--layers")?.split(",").map((l) => l.trim()) as LayerName[] | undefined;
for (const l of layers ?? []) if (!LAYERS.includes(l)) throw new Error(`unknown layer ${l}; layers: ${LAYERS.join(",")}`);
const rspec = flag("--reviewers");
const reviewers: (ReviewerSpec | undefined)[] = rspec
  ? (JSON.parse(rspec.trimStart().startsWith("[") ? rspec : readFileSync(rspec, "utf8")) as unknown[]).map(validateReviewerSpec)
  : [undefined];
const sspec = flag("--scanner");
const scanner = sspec ? makeScanner(parseScannerSpec(sspec)) : undefined;

const set = parseSet(flag("--set"));

const here = import.meta.dir;
const allCases = JSON.parse(readFileSync(join(here, "cases.json"), "utf8")) as Case[];
const allControls = JSON.parse(readFileSync(join(here, "controls.json"), "utf8")) as Case[];
const cases = allCases.filter((c) => inSet(c, set) && (c.source?.type === "datadog" || c.source?.type === "synthetic"));
const controls = allControls.filter((c) => inSet(c, set));
const all = [...cases.map((c) => ({ c, malicious: true })), ...controls.map((c) => ({ c, malicious: false }))].filter(({ c }) => !only || only.includes(c.id));

const registries: Record<Ecosystem, Registry> = { npm: npmRegistry(), pypi: pypiRegistry() };

async function get(url: string, accept?: string): Promise<Uint8Array> {
  const r = await fetch(url, { headers: { "user-agent": "oupdate-acceptance", ...(accept ? { accept } : {}) } });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return new Uint8Array(await r.arrayBuffer());
}

function onlyFile(dir: string, prefix: string): string | undefined {
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.startsWith(prefix)).map((f) => join(dir, f))[0] : undefined;
}

// PyPI: pick the artifact of the same kind as the other side (wheel or sdist).
async function pypiArtifactUrl(name: string, version: string, kind: "wheel" | "sdist"): Promise<string> {
  const d = JSON.parse(new TextDecoder().decode(await get(`https://pypi.org/pypi/${name}/${version}/json`))) as { urls: { url: string; filename: string; packagetype: string }[] };
  const fit = d.urls.filter((u) => (kind === "wheel" ? u.packagetype === "bdist_wheel" : u.packagetype === "sdist"));
  const pick = fit.find((u) => u.filename.includes("py3-none-any")) ?? fit.find((u) => u.filename.includes("macosx")) ?? fit[0];
  if (!pick) throw new Error(`no ${kind} for ${name} ${version}`);
  return pick.url;
}

async function fetchSide(c: Case, version: string, dir: string, kind: "wheel" | "sdist" | "npm"): Promise<string> {
  mkdirSync(dir, { recursive: true });
  const url = kind === "npm" ? (await registries.npm.artifactUrls(c.name, version))[0] : await pypiArtifactUrl(c.name, version, kind);
  if (!url) throw new Error(`no artifact for ${c.name} ${version}`);
  const file = join(dir, decodeURIComponent(new URL(url).pathname.split("/").pop()!));
  writeFileSync(file, await get(url));
  return file;
}

async function loadPair(c: Case, malicious: boolean): Promise<{ old: FileMap; new: FileMap }> {
  if (c.source?.type === "synthetic") return syntheticPair(c.source.generator);
  const dir = join(work, c.id);
  let badMap: FileMap;
  let kind: "wheel" | "sdist" | "npm";
  if (malicious) {
    let zip = onlyFile(join(dir, "bad"), "");
    if (!zip) {
      if (offline) throw new Error(`offline: no sample in ${dir}/bad`);
      const src = c.source as { type: "datadog"; path: string };
      const listing = JSON.parse(new TextDecoder().decode(await get(`${DATASET_API}/${src.path}`, "application/vnd.github+json"))) as { name: string; download_url: string }[];
      const z = listing.find((x) => x.name.endsWith(".zip"));
      if (!z) throw new Error(`no zip in dataset path ${src.path}`);
      mkdirSync(join(dir, "bad"), { recursive: true });
      zip = join(dir, "bad", z.name);
      writeFileSync(zip, await get(z.download_url));
    }
    badMap = await readSample(zip, DATASET_PASS, c.eco);
  } else {
    kind = c.eco === "npm" ? "npm" : "wheel";
    const f = onlyFile(join(dir, "bad"), "") ?? (offline ? undefined : await fetchSide(c, c.bad, join(dir, "bad"), kind));
    if (!f) throw new Error(`offline: no artifact in ${dir}/bad`);
    badMap = await readArtifact(f);
  }
  kind = c.eco === "npm" ? "npm" : [...badMap.keys()].some((k) => k.includes(".dist-info/")) ? "wheel" : "sdist";
  const g = onlyFile(join(dir, "good"), "") ?? (offline ? undefined : await fetchSide(c, c.good, join(dir, "good"), kind));
  if (!g) throw new Error(`offline: no artifact in ${dir}/good`);
  return { old: normalizePaths(await readArtifact(g)), new: normalizePaths(badMap) };
}

const summary: string[] = [];
const tally: string[] = [];
const scored: ScoreRow[] = [];
for (const { c, malicious } of all) {
  // Review at the moment the release was pulled (or today for controls).
  const removed = c.window?.removed;
  const now = removed ? new Date(removed) : new Date();
  // A synthetic package is not on any registry or advisory feed: it is 30 days old and has no advisories.
  const synthetic = c.source?.type === "synthetic";
  const base: Registry = synthetic ? { latest: async () => undefined, publishedAt: async () => new Date(now.getTime() - 30 * 86_400_000), artifactUrls: async () => [] } : registries[c.eco];
  const registry: Registry = c.window?.published ? { ...base, publishedAt: async () => new Date(c.window!.published!) } : base;
  const kind = synthetic ? "SYN " : malicious ? "MAL " : "CTRL";
  let pair: { old: FileMap; new: FileMap } | undefined;
  let loadErr: unknown;
  try {
    pair = await loadPair(c, malicious);
  } catch (e) {
    loadErr = e;
  }
  for (const rv of reviewers) {
    const r: ReviewResult = await reviewUpdate({
      eco: c.eco,
      name: c.name,
      from: c.good,
      to: c.bad,
      registry,
      advisories: synthetic ? { query: async () => [] } : osvFeed(),
      reviewer: rv ? makeReviewer(rv) : undefined,
      scanner,
      cooldownDays: 7,
      now,
      only: layers,
      loadArtifacts: async () => {
        if (!pair) throw loadErr instanceof Error ? loadErr : new Error(String(loadErr));
        return pair;
      },
    });
    const tag = `${c.id}${rv ? `-${rv.name}` : ""}`;
    writeFileSync(join(results, `${tag}.json`), JSON.stringify({ malicious, ...r }, null, 2) + "\n");
    const stoppedBy = r.layers.filter((l) => l.verdict === "stop").map((l) => l.layer);
    const outcome = classifyOutcome(r);
    scored.push({ id: c.id, kind: synthetic ? "synthetic" : malicious ? "attack" : "control", reviewer: rv?.name, result: r });
    tally.push(`${kind} ${outcome}`);
    summary.push(`${kind} ${tag}: ${outcome.toUpperCase()} ${r.decision}${stoppedBy.length ? ` (stopped by ${stoppedBy.join(", ")})` : ""}`);
    for (const l of r.layers) summary.push(`    ${l.layer.padEnd(9)} ${l.verdict.padEnd(7)} ${l.detail.slice(0, 220)}`);
  }
}
const counts = new Map<string, number>();
for (const t of tally) counts.set(t, (counts.get(t) ?? 0) + 1);
// Off core, a run is scored against the set's dataset attacks and controls in the JSON (not with --only).
const inJson = setCounts({ cases: allCases, controls: allControls }, set);
const expected = only ? undefined : { attacks: inJson.dataset, controls: inJson.controls };
summary.push(`set: ${set}`, `layers: ${layers?.join(",") ?? "all"}`, ...[...counts].sort().map(([k, n]) => `${k}: ${n}`), "", ...scorecard(scored, { set, expected }));
writeFileSync(join(results, "summary.txt"), summary.join("\n") + "\n");
console.log(summary.join("\n"));
