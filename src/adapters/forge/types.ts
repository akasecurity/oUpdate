// A code forge, as the gate needs it: open PRs, a file at a sha, commit
// statuses and one comment per PR that the gate keeps up to date.

export interface Pull {
  number: number;
  headRef: string;
  headSha: string;
  baseSha: string;
  /** Login of the PR's author. */
  author: string;
  /** owner/name of the repos the head and base branches live in; "" when the forge does not say (a deleted fork). */
  headRepo: string;
  baseRepo: string;
}

export type StatusState = "pending" | "success" | "failure" | "error";

export interface Status {
  state: StatusState;
  context: string;
  description: string;
}

/** A commit status as the forge reports it, with the login of whoever posted it. */
export interface PostedStatus {
  state: StatusState;
  creator: string;
}

export interface Forge {
  /** Login of the user the token acts as. Throws when the forge cannot say. */
  self(): Promise<string>;
  openPulls(repo: string): Promise<Pull[]>;
  readFile(repo: string, sha: string, path: string): Promise<string | undefined>;
  /** Every path the PR changes, the old path of a rename too. Throws when the forge cannot list them all. */
  changedFiles(repo: string, pr: number): Promise<string[]>;
  /** The latest status of `context` on `sha` and who posted it, if any. */
  statusOf(repo: string, sha: string, context: string): Promise<PostedStatus | undefined>;
  setStatus(repo: string, sha: string, status: Status): Promise<void>;
  /** The body of the token's own comment that starts with `marker`, if any; another user's is never returned. */
  ownComment(repo: string, pr: number, marker: string): Promise<string | undefined>;
  /** Edits the token's own comment that starts with `marker`, else creates one; another user's is never edited. */
  upsertComment(repo: string, pr: number, marker: string, body: string): Promise<void>;
}
