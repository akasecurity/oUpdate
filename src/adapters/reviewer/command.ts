// Reviewer that runs a configured command (argv, no shell) with the prompt on
// stdin and takes stdout as the review. It starts in a fresh empty directory so
// an agent CLI picks up no project files from wherever oupdate was started.
// It runs through realExec: its own process group, which a stop (killLive) kills
// with everything else, and nothing starts once oupdate is stopping.

import { mkdtempSync, rmSync } from "node:fs";
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

export function commandReviewer(cfg: CommandReviewerConfig): Reviewer {
  return {
    name: cfg.name,
    async review(prompt) {
      if (isStopping()) throw new Error(`reviewer ${cfg.name} not started: oupdate is stopping`);
      const dir = mkdtempSync(join(cfg.workRoot ?? tmpdir(), "oupdate-review-"));
      try {
        const r = await realExec(cfg.argv, { cwd: dir, stdin: prompt, timeoutMs: cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS });
        if (r.timedOut) throw new Error(`reviewer ${cfg.name} timed out`);
        if (r.rc !== 0) throw new Error(`reviewer ${cfg.name} exit ${r.rc}: ${r.err.trim().slice(0, 300)}`);
        return r.out;
      } finally {
        // Best effort: a reviewer still writing during its kill grace can make this throw, which must not mask the result.
        try {
          rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        } catch {}
      }
    },
  };
}
