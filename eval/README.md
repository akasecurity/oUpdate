# Evals

Each folder is a public attack write-up replayed against oUpdate: what the research reported, what oUpdate must do (block or detect), and the latest result. Add a row here in the same pull request that adds or re-runs an eval, copying its `Last run:` line.

| Folder | Run date | Source | Attack | Goal | Result |
|---|---|---|---|---|---|
| [2026-10-28-function-color-postinstall-hidden-download](2026-10-28-function-color-postinstall-hidden-download/) | 2026-10-29 (oUpdate 0.2.10, f1dc09b) | Forever Security, "Hijacking AI agents via the Downloads folder", 2026-10-22 | A dependency hides a download behind an install hook | block | 4 of 4 attacks blocked, 0 of 5 false positives |

## Ecosystem coverage

`bun eval/limits/coverage.ts` runs one minimal pull request per lockfile kind through the gate with a stub reviewer (no model) and records whether the lockfile was parsed, the pre-pass ran and the reviewer was reached. It writes `limits/results/<version>-coverage.{json,md}`.

## Evasion set

`bun eval/limits/evasions.ts` scores a labeled set of hand-written evasions (names split across versions or entries, chars built from code, shebang and extensionless entries, swapped duplicate sources, split sourcesContent) with no model: each case is one release through the review with a fake reviewer, and the payload is either shown to it or not. A case says whether it is expected shown or hidden and whether a hidden result is a known base weakness. It writes `limits/results/<version>-evasions.{json,md}`, exits 1 on a label mismatch; `limits/run.ts` runs it too, prints the mismatches in its summary and exits 1 on one. A case also counts as a mismatch when the reviewer was never called or a layer errored. A payload split across entries counts as shown only when every piece is in the new text.
