import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { badCommitEmails } from "../scripts/export-public";

function git(cwd: string, args: string[], email: string) {
  const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: email };
  const r = Bun.spawnSync(["git", "-c", "commit.gpgsign=false", ...args], { cwd, env });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
}

test("badCommitEmails flags author or committer emails other than the noreply address", () => {
  const dir = mkdtempSync(join(tmpdir(), "oup-export-"));
  try {
    const good = "222731067+alsoknownaswill@users.noreply.github.com";
    git(dir, ["init", "-q", "-b", "main"], good);
    writeFileSync(join(dir, "a"), "1");
    git(dir, ["add", "-A"], good);
    git(dir, ["commit", "-q", "-m", "a"], good);
    expect(badCommitEmails(dir, "HEAD")).toEqual([]);
    writeFileSync(join(dir, "a"), "2");
    git(dir, ["commit", "-q", "-am", "b"], "someone@example.test");
    const bad = badCommitEmails(dir, "HEAD");
    expect(bad.length).toBe(1);
    expect(bad[0]).toContain("someone@example.test");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
