# Evals

Each folder is a public attack write-up replayed against oUpdate, or an evaluation run of oUpdate on a set of them: what the research reported, what oUpdate must do (block or detect), and the latest result. Add a row here in the same pull request that adds or re-runs an eval, copying its `Last run:` line.

| Folder | Run date | Source | Attack | Goal | Result |
|---|---|---|---|---|---|
| [2026-10-26-attack-and-clean-release-evaluation](2026-10-26-attack-and-clean-release-evaluation/) | 2026-10-26 (oUpdate 5ca5e43) | DataDog malicious-software-packages dataset and public write-ups | 9 real supply-chain attacks and 8 clean releases, advisory checks off, local model | block | 9 of 9 attacks stopped, 8 of 8 clean releases landed; superseded by the 27 Oct evaluation |
| [2026-10-27-attack-and-clean-release-evaluation](2026-10-27-attack-and-clean-release-evaluation/) | 2026-10-26 to 2026-10-27 (oUpdate a9cde05 core; 4f4831d and 70f09a8 extended; 3d64634 rerun) | The same sources, plus a larger set of 25 attacks and 25 clean releases | Five repeat runs of the local model, two cloud reviewers, an extended set | block | Core: 9 of 9 attacks stopped in every run, 8 of 8 clean releases landed (local model), 6 of 8 (cloud models). Extended at 0.2.1: 24 of 25 attacks stopped, 5 to 7 of 25 clean releases held |
| [2026-10-28-function-color-postinstall-hidden-download](2026-10-28-function-color-postinstall-hidden-download/) | 2026-10-29 (oUpdate 0.2.10, f1dc09b) | Forever Security, "Hijacking AI agents via the Downloads folder", 2026-10-22 | A dependency hides a download behind an install hook | block | 4 of 4 attacks blocked, 0 of 5 false positives |

## Ecosystem coverage

`bun eval/limits/coverage.ts` runs one minimal pull request per lockfile kind through the gate with a stub reviewer (no model) and records whether the lockfile was parsed, the pre-pass ran and the reviewer was reached. It writes `limits/results/<version>-coverage.{json,md}`.

## Evasion set

`bun eval/limits/evasions.ts` scores a labeled set of hand-written evasions (names split across versions or entries, chars built from code, shebang and extensionless entries, swapped duplicate sources, split sourcesContent) with no model: each case is one release through the review with a fake reviewer, and the payload is either shown to it or not. A case says whether it is expected shown or hidden and whether a hidden result is a known base weakness. It writes `limits/results/<version>-evasions.{json,md}`, exits 1 on a label mismatch; `limits/run.ts` runs it too, prints the mismatches in its summary and exits 1 on one. A case also counts as a mismatch when the reviewer was never called or a layer errored. A payload split across entries counts as shown only when every piece is in the new text.
