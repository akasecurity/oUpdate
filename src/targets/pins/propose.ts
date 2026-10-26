// Writes a proposal branch without touching any checkout: the new pins file becomes a blob, a temporary
// index (GIT_INDEX_FILE) takes the base tree plus that blob, and commit-tree makes one commit on the base
// commit. `update-ref create` refuses a branch that already exists, and a push sends only
// refs/heads/<branch>, never the base. The train ask is the text the image owner acts on.

import { createHash } from "node:crypto";
import type { Exec } from "../../apply/exec.ts";
import { GIT_ENV } from "../reach.ts";
import type { PinChange } from "./review.ts";

/** `<prefix>pins-<12 hex of sha256(new file)>`: the same bump always gets the same name. */
export function branchName(prefix: string, text: string): string {
  return `${prefix}pins-${createHash("sha256").update(text).digest("hex").slice(0, 12)}`;
}

export async function branchExists(exec: Exec, repo: string, branch: string, timeoutMs: number): Promise<boolean> {
  const r = await exec(["git", "-C", repo, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { env: GIT_ENV, timeoutMs });
  return r.rc === 0;
}

const OID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

export interface HoldsInput {
  exec: Exec;
  repo: string;
  branch: string;
  baseSha: string;
  pinsPath: string;
  /** The whole pins file this run would propose. */
  text: string;
  timeoutMs: number;
}

/**
 * Whether an existing proposal branch holds exactly this run's proposal: one commit whose parent is on the
 * base, which changes only the pins file, to exactly `text`. Anything else is not ours to push.
 */
export async function branchHolds(i: HoldsInput): Promise<{ ok: true; commit: string } | { ok: false; why: string }> {
  const git = (args: string[]) => i.exec(["git", "-C", i.repo, ...args], { env: GIT_ENV, timeoutMs: i.timeoutMs });
  const rl = await git(["rev-list", "--parents", "-n", "1", `refs/heads/${i.branch}`]);
  const ids = rl.out.trim().split(" ");
  if (rl.rc !== 0 || !ids.every((x) => OID.test(x))) return { ok: false, why: `cannot be read (rev-list rc ${rl.rc})` };
  if (ids.length !== 2) return { ok: false, why: `tip ${ids[0]!.slice(0, 12)} is not a one-parent commit` };
  const [commit, parent] = ids as [string, string];
  const anc = await git(["merge-base", "--is-ancestor", parent, i.baseSha]);
  if (anc.rc !== 0) return { ok: false, why: `tip ${commit.slice(0, 12)} is not on the base` };
  const dt = await git(["diff-tree", "-r", "--no-commit-id", "--name-only", "-z", parent, commit]);
  const changed = dt.out.split("\0").filter((n) => n !== "");
  if (dt.rc !== 0 || changed.length !== 1 || changed[0] !== i.pinsPath) return { ok: false, why: `tip ${commit.slice(0, 12)} changes more than ${i.pinsPath}` };
  const shown = await git(["show", `${commit}:${i.pinsPath}`]);
  if (shown.rc !== 0 || shown.out !== i.text) return { ok: false, why: `tip ${commit.slice(0, 12)} holds different pins than this run's proposal` };
  return { ok: true, commit };
}

/** The commit a train ask records for its branch, or undefined. */
export function askCommit(ask: string): string | undefined {
  const m = ask.match(/^Commit: +([0-9a-f]{40}(?:[0-9a-f]{24})?) on /m);
  return m?.[1];
}

export interface ProposeInput {
  exec: Exec;
  repo: string;
  remote: string;
  base: string;
  baseSha: string;
  pinsPath: string;
  /** The whole new pins file. */
  text: string;
  branch: string;
  message: string;
  author: { name: string; email: string };
  push: boolean;
  timeoutMs: number;
  /** A temporary path for GIT_INDEX_FILE; the caller removes it. */
  indexFile: string;
}

export type ProposeResult = { ok: true; commit: string; pushed: boolean; pushError?: string } | { ok: false; why: string };

const first = (s: string) => s.trim().split("\n")[0] ?? "";

export async function proposeBranch(i: ProposeInput): Promise<ProposeResult> {
  if (i.branch === i.base || !i.branch.includes("/")) return { ok: false, why: `refusing branch name ${i.branch}` };
  const git = (args: string[], o: { stdin?: string; env?: Record<string, string> } = {}) =>
    i.exec(["git", "-C", i.repo, ...args], { env: { ...GIT_ENV, ...o.env }, timeoutMs: i.timeoutMs, ...(o.stdin !== undefined ? { stdin: o.stdin } : {}) });
  const step = async (args: string[], o: { stdin?: string; env?: Record<string, string> } = {}) => {
    const r = await git(args, o);
    if (r.rc !== 0) throw new Error(`${args[0]} failed (rc ${r.rc}): ${first(r.err)}`);
    return r.out.trim();
  };
  try {
    const ls = await step(["ls-tree", i.baseSha, "--", i.pinsPath]);
    const mode = ls.split(/\s/)[0];
    if (mode !== "100644" && mode !== "100755") return { ok: false, why: `${i.pinsPath} is not a regular file at ${i.baseSha.slice(0, 12)} (${ls || "absent"})` };
    const blob = await step(["hash-object", "-w", "--stdin"], { stdin: i.text });
    const idx = { GIT_INDEX_FILE: i.indexFile };
    await step(["read-tree", i.baseSha], { env: idx });
    await step(["update-index", "--cacheinfo", `${mode},${blob},${i.pinsPath}`], { env: idx });
    const tree = await step(["write-tree"], { env: idx });
    const who = { GIT_AUTHOR_NAME: i.author.name, GIT_AUTHOR_EMAIL: i.author.email, GIT_COMMITTER_NAME: i.author.name, GIT_COMMITTER_EMAIL: i.author.email };
    const commit = await step(["commit-tree", "--no-gpg-sign", tree, "-p", i.baseSha, "-F", "-"], { stdin: i.message, env: who });
    if (![blob, tree, commit].every((x) => OID.test(x))) return { ok: false, why: "git returned a malformed object id" };
    await step(["update-ref", "--stdin"], { stdin: `create refs/heads/${i.branch} ${commit}\n` });
    if (!i.push) return { ok: true, commit, pushed: false };
    const p = await git(["push", "--porcelain", i.remote, `refs/heads/${i.branch}:refs/heads/${i.branch}`]);
    return p.rc === 0 ? { ok: true, commit, pushed: true } : { ok: true, commit, pushed: false, pushError: `rc ${p.rc}: ${first(p.err)}` };
  } catch (e) {
    return { ok: false, why: e instanceof Error ? e.message : String(e) };
  }
}

export interface TrainAskInput {
  target: string;
  repo: string;
  remote: string;
  base: string;
  baseSha: string;
  branch: string;
  commit: string;
  pushed: boolean;
  pinsPath: string;
  changes: PinChange[];
  reviewer: string;
  held: string[];
}

export function trainAsk(a: TrainAskInput): string {
  const lines = [
    `oupdate train ask: ${a.target}`,
    "",
    `Branch:   ${a.branch}`,
    `Commit:   ${a.commit} on ${a.remote}/${a.base} ${a.baseSha}`,
    `Pushed:   ${a.pushed ? `yes, to ${a.remote}` : `no (local branch in ${a.repo})`}`,
    `File:     ${a.pinsPath}`,
    `Review:   ${a.reviewer} APPROVE on the pins diff; npm bumps also passed the artifact review`,
    "",
    "Changes:",
    ...a.changes.flatMap((c) => [`  ${c.group}: ${c.from} -> ${c.to}`, ...c.evidence.map((e) => `    ${e}`)]),
  ];
  if (a.held.length) lines.push("", "Held this run (not in the branch):", ...a.held.map((h) => `  ${h}`));
  lines.push(
    "",
    "Ask: rebuild the image from this branch, scan it, and re-bake the base image if it passes; then merge.",
    "oupdate only proposes: it never merges, never pushes to the base branch and never builds or bakes.",
    `The Source comments in ${a.pinsPath} still carry the old read dates; refresh them when you merge.`,
  );
  return lines.join("\n") + "\n";
}
