// Reviewer that runs a configured command (argv, no shell) with the prompt on
// stdin and takes stdout as the review. Every review in one oupdate process starts
// in the same private directory, made once with mkdtemp (0700, unguessable, empty),
// so an agent CLI picks up no project files from wherever oupdate was started and
// nothing another user or an earlier process left behind. Sharing the cwd matters:
// an agent CLI puts the cwd in its system prompt, so a per-run directory would give
// each run its own prompt prefix and its own cache entry. The directory is never
// cleaned between runs (reviews can overlap) and is removed when the process exits.
// It runs through realExec: its own process group, which a stop (killLive) kills
// with everything else, and nothing starts once oupdate is stopping.

import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Reviewer } from "../../review.ts";
import { isStopping, realExec } from "../../apply/exec.ts";

export const DEFAULT_TIMEOUT_MS = 600_000;

export interface CommandReviewerConfig {
  name: string;
  argv: string[];
  timeoutMs?: number;
  workRoot?: string;
}

const dirs = new Map<string, string>();

function reviewDir(root: string): string {
  let dir = dirs.get(root);
  if (!dir) {
    dir = mkdtempSync(join(root, "oupdate-review-"));
    dirs.set(root, dir);
    const d = dir;
    process.on("exit", () => {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {}
    });
  }
  return dir;
}

function empty(dir: string): void {
  for (const e of readdirSync(dir)) rmSync(join(dir, e), { recursive: true, force: true });
}

let turn: Promise<unknown> = Promise.resolve();

export function commandReviewer(cfg: CommandReviewerConfig): Reviewer {
  return {
    name: cfg.name,
    review(prompt) {
      const run = turn.then(async () => {
        if (isStopping()) throw new Error(`reviewer ${cfg.name} not started: oupdate is stopping`);
        const dir = reviewDir(cfg.workRoot ?? tmpdir());
        empty(dir);
        try {
          const r = await realExec(cfg.argv, { cwd: dir, stdin: prompt, timeoutMs: cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS });
          if (r.timedOut) throw new Error(`reviewer ${cfg.name} timed out`);
          if (r.rc !== 0) throw new Error(`reviewer ${cfg.name} exit ${r.rc}: ${r.err.trim().slice(0, 300)}`);
          return r.out;
        } finally {
          // Best effort: a reviewer still writing during its kill grace can make this throw, which must not mask the result.
          try {
            empty(dir);
          } catch {}
        }
      });
      turn = run.catch(() => {});
      return run;
    },
  };
}
