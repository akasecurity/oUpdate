#!/usr/bin/env bun
// Replays nas-secure-update.sh nights through oupdate's ported container review (spec §8). For each script log in a
// directory, it rebuilds the layer diffs the script reviewed, runs the same pre-gate, and sends the ported prompt to the
// router and on-prem reviewers. It then compares the final decision (blocked or cleared) and each reviewer's verdict with
// the script's. A night whose log says "all images up to date" and whose final container summary agrees is verified
// unchanged. A log that cannot be read, has no valid date, repeats a night already covered, has no container section, no
// final decision or a changed image without its diff is incomplete. Real logs stay on the runner
// and are never committed.
//
// usage: bun scripts/nas-replay.ts --logs DIR --reviewer JSON --second-reviewer JSON [--min-nights N]
// Exit 0 only when no night is incomplete, at least N nights (default 30) are covered (replayed or verified unchanged),
// at least one was replayed, and every replayed night agrees; 1 otherwise; 2 for usage.

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { makeReviewer, parseReviewerSpec, type ReviewerSpec } from "../src/adapters/reviewer/spec.ts";
import type { Reviewer } from "../src/review.ts";
import { layerDiffs, nasApproved, structuralHits } from "../src/targets/nas/evidence.ts";
import { composePrompt } from "../src/targets/nas/prompt.ts";
import { reviewTwice } from "../src/targets/nas/review.ts";
import { parseScriptLog } from "../src/targets/parity.ts";

export interface ReplayDeps {
  list(dir: string): Promise<string[]>;
  read(path: string): Promise<string | undefined>;
  makeReviewer(s: ReviewerSpec): Reviewer;
  out(l: string): void;
}

const USAGE = "usage: bun scripts/nas-replay.ts --logs DIR --reviewer JSON --second-reviewer JSON [--min-nights N]";
const MIN_NIGHTS = 30;

/** A YYYY-MM-DD that names a real calendar day. */
function realDate(d: string): boolean {
  const [y, m, day] = d.split("-").map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, day));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === day;
}

export async function replayMain(argv: string[], d: ReplayDeps): Promise<number> {
  const flag = (n: string) => {
    const i = argv.indexOf(n);
    const v = i >= 0 ? argv[i + 1] : undefined;
    if (!v) throw new Error(USAGE);
    return v;
  };
  const dir = flag("--logs");
  const reviewers = { router: d.makeReviewer(parseReviewerSpec(flag("--reviewer"))), onprem: d.makeReviewer(parseReviewerSpec(flag("--second-reviewer"))) };
  const min = argv.includes("--min-nights") ? Number(flag("--min-nights")) : MIN_NIGHTS;
  if (!Number.isInteger(min) || min < 1) throw new Error(`--min-nights must be a whole number >= 1 (${USAGE})`);
  let n = 0;
  let agree = 0;
  let unchanged = 0;
  let incomplete = 0;
  const seen = new Map<string, string>();
  const gap = (f: string, why: string) => {
    incomplete++;
    d.out(`${f}\tINCOMPLETE: ${why}`);
  };
  for (const f of (await d.list(dir)).filter((x) => x.endsWith(".log")).sort()) {
    const text = await d.read(join(dir, f));
    if (text === undefined) {
      gap(f, "unreadable");
      continue;
    }
    const night = parseScriptLog(text);
    // Coverage is of distinct calendar nights, each dated by its own log.
    if (!night.date || !realDate(night.date)) {
      gap(f, "no valid date in the log");
      continue;
    }
    const first = seen.get(night.date);
    if (first) {
      gap(f, `a second log for ${night.date} (first: ${first})`);
      continue;
    }
    seen.set(night.date, f);
    if (night.changed === "unknown") {
      gap(f, "no container section");
      continue;
    }
    if (!night.changed.length) {
      // Unchanged only on the script's explicit line and a final summary that agrees; a bare or cut-off section is not.
      if (!night.upToDate || night.diffs.length || !night.final?.startsWith("up to date")) {
        gap(f, "no explicit up-to-date line with a matching final container summary");
        continue;
      }
      unchanged++;
      d.out(`${f}\tverified unchanged`);
      continue;
    }
    if (night.diffs.length !== night.changed.length) {
      gap(f, `${night.changed.length} changed images but ${night.diffs.length} diffs`);
      continue;
    }
    if (!night.final?.startsWith("updated") && !night.final?.startsWith("blocked")) {
      gap(f, "no final container decision");
      continue;
    }
    const all = layerDiffs(night.diffs);
    const hits = structuralHits(all);
    const date = night.date;
    const v = await reviewTwice(reviewers, composePrompt(date, night.diffs.map((x) => x.ref), all), nasApproved);
    const ours = v.approved && !hits.length ? "cleared" : "blocked";
    const theirs = night.final.startsWith("updated") ? "cleared" : "blocked";
    const [sr = "", so = ""] = night.verdict.split("/");
    const same = ours === theirs && v.router === sr && v.onprem === so;
    n++;
    if (same) agree++;
    const vs = (ours: string, script: string) => (ours === script ? ours : `${ours} (script ${script})`);
    d.out(`${f}\toupdate ${ours}\tscript ${theirs}\t${same ? "same" : "DIFFERS"}\trouter ${vs(v.router, sr)}, on-prem ${vs(v.onprem, so)}; ${hits.length} pre-gate hit${hits.length === 1 ? "" : "s"}`);
  }
  const covered = n + unchanged;
  d.out(`replay: ${agree} of ${n} replayed nights agree; ${unchanged} verified unchanged; ${incomplete} incomplete; ${covered} nights covered, at least ${min} needed`);
  return n > 0 && agree === n && incomplete === 0 && covered >= min ? 0 : 1;
}

if (import.meta.main) {
  try {
    const code = await replayMain(process.argv.slice(2), {
      list: (p) => readdir(p),
      read: (p) => readFile(p, "utf8").catch(() => undefined),
      makeReviewer,
      out: (l) => console.log(l),
    });
    process.exit(code);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(2);
  }
}
