// A code forge, as the gate needs it: open PRs, a file at a sha, commit
// statuses and one comment per PR that the gate keeps up to date.

export interface Pull {
  number: number;
  headRef: string;
  headSha: string;
  baseSha: string;
}

export type StatusState = "pending" | "success" | "failure" | "error";

export interface Status {
  state: StatusState;
  context: string;
  description: string;
}

export interface Forge {
  openPulls(repo: string): Promise<Pull[]>;
  readFile(repo: string, sha: string, path: string): Promise<string | undefined>;
  /** The latest state of `context` on `sha`, if any. */
  statusOf(repo: string, sha: string, context: string): Promise<StatusState | undefined>;
  setStatus(repo: string, sha: string, status: Status): Promise<void>;
  upsertComment(repo: string, pr: number, marker: string, body: string): Promise<void>;
}
