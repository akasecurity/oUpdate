// `oupdate targets --apply [--dry-run] --config FILE [--target ID]...`: runs the targets file's due
// targets (or the named ones) and prints one summary line per target; the os-packages leg gets both reviewers and the
// clock. Exit 0 when no target had trouble, 1 otherwise; a usage or config error is exit 2 (src/cli.ts).
// `oupdate targets parity …` is parity-cli.ts.

import type { Exec } from "../apply/exec.ts";
import type { ReviewerSpec } from "../adapters/reviewer/spec.ts";
import type { Reviewer } from "../review.ts";
import { parseTargetsConfig } from "./config.ts";
import { realClock, type Clock } from "./gce/job.ts";
import type { NasLegDeps } from "./nas/leg.ts";
import type { NasOsReleases } from "./nas/os.ts";
import { pinBumpRunner, type PinLegDeps, type PinSources } from "./pins/leg.ts";
import { DEFAULT_TIMEOUT_MS, runTargets, type TargetFs } from "./run.ts";

export interface TargetsCommand {
  config: string;
  dryRun: boolean;
  only: string[];
}

const USAGE = "usage: oupdate targets --apply [--dry-run] --config FILE [--target ID]...";

export function parseTargetsCommand(argv: string[]): TargetsCommand {
  let apply = false;
  let dryRun = false;
  let config: string | undefined;
  const only: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--apply") apply = true;
    else if (a === "--dry-run") dryRun = true;
    else if (a === "--config") config = value();
    else if (a === "--target") only.push(value());
    else throw new Error(`unknown flag ${a}`);
  }
  if (!apply) throw new Error(`targets needs --apply (${USAGE})`);
  if (!config) throw new Error(`targets needs --config FILE (${USAGE})`);
  return { config, dryRun, only };
}

/** This oupdate tree's short commit, the tsv's rev row; "unknown" outside a git checkout. */
export async function appRev(exec: Exec, root: string): Promise<string> {
  const r = await exec(["git", "-C", root, "rev-parse", "--short", "HEAD"], { timeoutMs: 10_000 });
  const v = r.out.trim();
  return r.rc === 0 && /^[0-9a-f]{4,64}$/.test(v) ? v : "unknown";
}

export interface TargetsMainDeps {
  exec: Exec;
  fs: TargetFs;
  now: Date;
  rev: string;
  tmpDir: string;
  sources: PinSources;
  makeReviewer: (s: ReviewerSpec) => Reviewer;
  /** The npm artifact review for the config's reviewer (cli.ts runReview in production). */
  reviewNpm: (spec: ReviewerSpec | undefined) => PinLegDeps["reviewNpm"];
  /** The nasos releases API (nas/os.ts realNasOsReleases in production). */
  releases: NasOsReleases;
  /** The os-packages leg's waits; gce/job.ts realClock when absent. */
  clock?: Clock;
  out: (line: string) => void;
}

export async function targetsMain(c: TargetsCommand, d: TargetsMainDeps): Promise<number> {
  const text = await d.fs.readFile(c.config);
  if (text === undefined) throw new Error(`cannot read targets config ${c.config}`);
  const cfg = parseTargetsConfig(text);
  const reviewer = cfg.reviewer ? d.makeReviewer(cfg.reviewer) : undefined;
  const second = cfg.secondReviewer ? d.makeReviewer(cfg.secondReviewer) : undefined;
  const reviewers = { primary: reviewer, secondary: second };
  const nas: NasLegDeps = { reviewers, releases: d.releases };
  const pinBump = pinBumpRunner({ sources: d.sources, reviewer, reviewNpm: d.reviewNpm(cfg.reviewer), fs: d.fs, timeoutMs: DEFAULT_TIMEOUT_MS, tmpDir: d.tmpDir });
  const { results, rc } = await runTargets(cfg, { exec: d.exec, fs: d.fs, rev: d.rev, pinBump, nas, gce: { reviewers, clock: d.clock ?? realClock } }, { dryRun: c.dryRun, now: d.now, only: c.only, onLine: d.out });
  for (const r of results) d.out(`${r.id}: ${r.summary}`);
  return rc;
}
