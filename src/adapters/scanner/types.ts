// A static rule scanner finding, and the diff that keeps only what a new release adds.

export interface Finding {
  rule: string;
  path: string;
  detail: string;
}

// Rule + path pairs found only in the new release. Line numbers shift between
// releases, so they are not part of the key.
export function newFindings(old: Finding[], now: Finding[]): Finding[] {
  const seen = new Set(old.map((f) => `${f.rule}\0${f.path}`));
  return now.filter((f) => !seen.has(`${f.rule}\0${f.path}`));
}
