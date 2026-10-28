// The proposal branch is written with plumbing only: no checkout changes, the base never moves, an
// existing branch is never overwritten, and a push sends only the proposal ref.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realExec } from "../../src/apply/exec.ts";
import { branchExists, branchName, proposeBranch, proposalText, type ProposeInput } from "../../src/targets/pins/propose.ts";
import { fakeExec, gitArgs, gitRule } from "./fakes.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const sh = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", "-C", cwd, "-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args]);
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return r.stdout.toString();
};

const BASE = "a".repeat(40);
const OID = (c: string) => c.repeat(40);
const plumbing = (over: { lsTree?: string; updateRef?: number; push?: number } = {}) =>
  fakeExec([
    gitRule(["ls-tree"], { out: over.lsTree ?? `100644 blob ${OID("d")}\timg/pins.env\n` }),
    gitRule(["hash-object"], { out: `${OID("e")}\n` }),
    gitRule(["read-tree"], {}),
    gitRule(["update-index"], {}),
    gitRule(["write-tree"], { out: `${OID("f")}\n` }),
    gitRule(["commit-tree"], { out: `${OID("1")}\n` }),
    gitRule(["update-ref"], { rc: over.updateRef ?? 0, err: over.updateRef ? "fatal: cannot lock ref: reference already exists" : "" }),
    gitRule(["push"], { rc: over.push ?? 0, err: over.push ? "error: failed to push some refs" : "" }),
  ]);
const input = (exec: ProposeInput["exec"], over: Partial<ProposeInput> = {}): ProposeInput => ({
  exec, repo: "/repo", remote: "origin", base: "main", baseSha: BASE, pinsPath: "img/pins.env", text: "A=2\n", branch: "oupdate/pins-0123456789ab",
  message: "chore: bump a\n", author: { name: "oupdate", email: "oupdate@invalid" }, push: false, timeoutMs: 5000, indexFile: "/tmp/idx", ...over,
});

describe("proposal branch", () => {
  test("branchName is the prefix plus a hash of the pins path and the new file", () => {
    expect(branchName("oupdate/", "img/pins.env", "A=2\n")).toMatch(/^oupdate\/pins-[0-9a-f]{12}$/);
    expect(branchName("oupdate/", "img/pins.env", "A=2\n")).toBe(branchName("oupdate/", "img/pins.env", "A=2\n"));
    expect(branchName("oupdate/", "img/pins.env", "A=3\n")).not.toBe(branchName("oupdate/", "img/pins.env", "A=2\n"));
  });

  test("branchExists asks show-ref for the local branch", async () => {
    const yes = fakeExec([gitRule(["show-ref"], {})]);
    expect(await branchExists(yes.exec, "/repo", "oupdate/pins-x", 1000)).toBe(true);
    expect(gitArgs(yes.calls[0]!)).toEqual(["show-ref", "--verify", "--quiet", "refs/heads/oupdate/pins-x"]);
    expect(await branchExists(fakeExec([gitRule(["show-ref"], { rc: 1 })]).exec, "/repo", "oupdate/pins-x", 1000)).toBe(false);
  });

  test("plumbing order, the temporary index, the author, and create-only update-ref", async () => {
    const { exec, calls } = plumbing();
    expect(await proposeBranch(input(exec))).toEqual({ ok: true, commit: OID("1"), pushed: false });
    expect(calls.map((c) => gitArgs(c)[0])).toEqual(["ls-tree", "hash-object", "read-tree", "update-index", "write-tree", "commit-tree", "update-ref"]);
    const by = (verb: string) => calls.find((c) => gitArgs(c)[0] === verb)!;
    expect(by("hash-object").stdin).toBe("A=2\n");
    expect(by("hash-object").env?.GIT_INDEX_FILE).toBeUndefined();
    for (const v of ["read-tree", "update-index", "write-tree"]) expect(by(v).env?.GIT_INDEX_FILE).toBe("/tmp/idx");
    expect(gitArgs(by("update-index"))).toEqual(["update-index", "--cacheinfo", `100644,${OID("e")},img/pins.env`]);
    expect(gitArgs(by("commit-tree"))).toEqual(["commit-tree", "--no-gpg-sign", OID("f"), "-p", BASE, "-F", "-"]);
    expect(by("commit-tree").env).toMatchObject({ GIT_AUTHOR_NAME: "oupdate", GIT_AUTHOR_EMAIL: "oupdate@invalid", GIT_COMMITTER_NAME: "oupdate", GIT_COMMITTER_EMAIL: "oupdate@invalid", GIT_TERMINAL_PROMPT: "0" });
    expect(by("update-ref").stdin).toBe(`create refs/heads/oupdate/pins-0123456789ab ${OID("1")}\n`);
  });

  // Review Focus 2: an existing branch is never moved and the base is never the target.
  test("an existing branch is refused by update-ref create", async () => {
    const r = await proposeBranch(input(plumbing({ updateRef: 128 }).exec));
    expect(r).toEqual({ ok: false, why: "update-ref failed (rc 128): fatal: cannot lock ref: reference already exists" });
  });

  test("a branch named like the base, or with no prefix, is refused before any git call", async () => {
    const { exec, calls } = plumbing();
    expect(await proposeBranch(input(exec, { branch: "main" }))).toEqual({ ok: false, why: "refusing branch name main" });
    expect(await proposeBranch(input(exec, { branch: "oupdate/pins-x", base: "oupdate/pins-x" }))).toEqual({ ok: false, why: "refusing branch name oupdate/pins-x" });
    expect(calls).toHaveLength(0);
  });

  test("a pins path that is a symlink or absent is refused", async () => {
    expect(await proposeBranch(input(plumbing({ lsTree: `120000 blob ${OID("d")}\timg/pins.env\n` }).exec))).toEqual({ ok: false, why: `img/pins.env is not a regular file at aaaaaaaaaaaa (120000 blob ${OID("d")}\timg/pins.env)` });
    expect(await proposeBranch(input(plumbing({ lsTree: "" }).exec))).toEqual({ ok: false, why: "img/pins.env is not a regular file at aaaaaaaaaaaa (absent)" });
  });

  test("push sends only the proposal ref; a failed push is reported, the branch stays", async () => {
    const ok = plumbing();
    expect(await proposeBranch(input(ok.exec, { push: true }))).toEqual({ ok: true, commit: OID("1"), pushed: true });
    expect(gitArgs(ok.calls.at(-1)!)).toEqual(["push", "--porcelain", "origin", "refs/heads/oupdate/pins-0123456789ab:refs/heads/oupdate/pins-0123456789ab"]);
    expect(await proposeBranch(input(plumbing({ push: 1 }).exec, { push: true }))).toEqual({ ok: true, commit: OID("1"), pushed: false, pushError: "rc 1: error: failed to push some refs" });
  });

  test("real git: checkout and base untouched, branch holds the new file, push sends only the branch", async () => {
    const root = mkdtempSync(join(tmpdir(), "oupdate-pins-"));
    dirs.push(root);
    const remote = join(root, "remote.git");
    sh(root, "init", "-q", "--bare", "-b", "main", remote);
    const seed = join(root, "seed");
    sh(root, "clone", "-q", remote, seed);
    mkdirSync(join(seed, "img"));
    writeFileSync(join(seed, "img", "pins.env"), "A=1\nB=2\n");
    sh(seed, "add", "."), sh(seed, "commit", "-q", "-m", "seed"), sh(seed, "push", "-q", "origin", "HEAD:main");
    const clone = join(root, "clone");
    sh(root, "clone", "-q", remote, clone);
    const baseSha = sh(clone, "rev-parse", "origin/main").trim();
    const run = (push: boolean) => proposeBranch({ exec: realExec, repo: clone, remote: "origin", base: "main", baseSha, pinsPath: "img/pins.env", text: "A=1\nB=3\n", branch: "oupdate/pins-test", message: "chore: bump b\n", author: { name: "oupdate", email: "oupdate@invalid" }, push, timeoutMs: 30_000, indexFile: join(root, "idx") });
    const r = await run(true);
    expect(r).toMatchObject({ ok: true, pushed: true });
    if (!r.ok) throw new Error(r.why);
    expect(sh(clone, "show", "oupdate/pins-test:img/pins.env")).toBe("A=1\nB=3\n");
    expect(sh(clone, "rev-parse", "oupdate/pins-test^").trim()).toBe(baseSha);
    expect(sh(clone, "log", "-1", "--format=%an <%ae>", "oupdate/pins-test").trim()).toBe("oupdate <oupdate@invalid>");
    expect(readFileSync(join(clone, "img", "pins.env"), "utf8")).toBe("A=1\nB=2\n");
    expect(sh(clone, "status", "--porcelain")).toBe("");
    expect(sh(remote, "rev-parse", "main").trim()).toBe(baseSha);
    expect(sh(remote, "rev-parse", "oupdate/pins-test").trim()).toBe(r.commit);
    expect((await run(false)).ok).toBe(false);
  });

  test("the proposal names the branch, every change, what was held, and that oupdate never merges", () => {
    const t = proposalText({ target: "images", repo: "/repo", remote: "origin", base: "main", baseSha: BASE, branch: "oupdate/pins-x", commit: OID("1"), pushed: false, pinsPath: "img/pins.env", changes: [{ group: "cli", from: "1.2.3", to: "1.2.4", evidence: ["npm @scope/cli 1.2.3 -> 1.2.4"] }], reviewer: "local", held: ["base sha256:2222 (2.0 h old, cooldown 7 d)"] });
    expect(t).toContain("Branch:   oupdate/pins-x");
    expect(t).toContain("Pushed:   no (local branch in /repo)");
    expect(t).toContain("  cli: 1.2.3 -> 1.2.4\n    npm @scope/cli 1.2.3 -> 1.2.4");
    expect(t).toContain("Held this run (not in the branch):\n  base sha256:2222 (2.0 h old, cooldown 7 d)");
    expect(t).toContain("oupdate only proposes: it never merges, never pushes to the base branch and never builds or bakes.");
    expect(t.endsWith("\n")).toBe(true);
  });
});
