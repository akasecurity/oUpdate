import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { layerLines } from "../acceptance/summary.ts";
import type { ReviewResult } from "../src/review.ts";

const result = (layers: ReviewResult["layers"], reviewerText?: string[]): ReviewResult =>
  ({ eco: "npm", name: "p", from: "1.0.0", to: "1.0.1", decision: "hold", layers, ...(reviewerText ? { reviewerText } : {}) });
const LONG = `${"The diff adds a network call. ".repeat(30)}End of reason.`;

describe("layerLines", () => {
  test("a model FLAG prints the reviewer's whole answer on one line, past the 220 and 240 character cuts", () => {
    const text = `FLAG\n${LONG}\nsecond paragraph\twith\ttabs \u001b[31mred\u001b[0m`;
    const lines = layerLines(result([{ layer: "reviewer", verdict: "stop", detail: "m FLAG on part(s) 1 of 1: short" }], [text]));
    expect(lines[0]).toBe("    reviewer  stop    m FLAG on part(s) 1 of 1: short");
    expect(lines).toHaveLength(2);
    expect(lines[1]!.startsWith("    reason    FLAG The diff adds")).toBe(true);
    expect(lines[1]).toContain("End of reason. second paragraph with tabs ");
    expect(lines[1]!.length).toBeGreaterThan(500);
    expect(lines[1]).not.toMatch(/[\n\t\u001b]/);
  });

  test("an APPROVE, a hold for a human and a case the reviewer did not stop print no reason", () => {
    expect(layerLines(result([{ layer: "reviewer", verdict: "pass", detail: "m APPROVE on 1 part(s)" }], ["APPROVE\nfine"]))).toHaveLength(1);
    expect(layerLines(result([{ layer: "reviewer", verdict: "stop", detail: "too large for model review" }], ["APPROVE\nx"]))).toHaveLength(1);
    expect(layerLines(result([{ layer: "prepass", verdict: "stop", detail: "hard signal" }], ["FLAG\nx"]))).toHaveLength(1);
    expect(layerLines(result([{ layer: "reviewer", verdict: "stop", detail: "m FLAG on part(s) 1 of 1" }]))).toHaveLength(1);
  });

  test("other layers keep their 220 character cut", () => {
    const lines = layerLines(result([{ layer: "prepass", verdict: "pass", detail: "x".repeat(300) }]));
    expect(lines[0]).toBe(`    prepass   pass    ${"x".repeat(220)}`);
  });
});

describe("acceptance/run.ts summary", () => {
  test("a reviewer-stopped case prints the full FLAG answer", () => {
    const dir = mkdtempSync(join(tmpdir(), "oupdate-summary-"));
    try {
      const answer = `FLAG\\n${"The setup script posts local files to a remote host. ".repeat(12)}Done.`;
      const stub = JSON.stringify([{ type: "command", name: "stub", argv: ["sh", "-c", `cat >/dev/null; printf '${answer}\\n'`] }]);
      const p = Bun.spawnSync(["bun", resolve(import.meta.dir, "../acceptance/run.ts"), "--set", "extended", "--only", "synthetic-npm-preinstall-curl-pipe-sh", "--reviewers", stub, "--offline"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
      expect(p.stderr.toString()).toBe("");
      expect(p.exitCode).toBe(0);
      expect(p.stdout.toString()).toMatch(/^ {4}reason {4}FLAG The setup script posts local files to a remote host\..*Done\.$/m);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
