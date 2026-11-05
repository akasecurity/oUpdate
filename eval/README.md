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

`bun eval/limits/evasions.ts` scores a labeled set of hand-written evasions (names split across versions or entries, chars built from code, shebang and extensionless entries, swapped duplicate sources, split sourcesContent) with no model: each case is one release through the review with a fake reviewer, and the payload is either shown to it or not. A case says whether it is expected shown or hidden and whether a hidden result is a known base weakness. It writes `limits/results/<version>-evasions.{json,md}`, exits 1 on a label mismatch; `limits/run.ts` runs it too, prints the mismatches in its summary and exits 1 on one. A case also counts as a mismatch when the reviewer was never called or a layer errored. A payload split across entries counts as shown only when every piece is in the new text. The set also records ways a loader can assemble the map's file name at run time that the review does not match (a name built from parts, a name that ends in a literal that is no tail of the map's name, a one-character tail, a template whose text ends in the tail, a suffix scan, a different parse call, character codes): they are known weaknesses, because a name rule covers only the shapes it lists, and a rule keyed on reading files would also show the map of any large bundle that reads files.

## Limits results

`bun eval/limits/run.ts --reviewer <spec.json> --repeats 10` runs every attack and every clean case ten times through the gate and writes `limits/results/<version>.{json,md}`; the first lines of each result record the reviewer settings it ran with (thinking on or off, max tokens, a fingerprint of the settings).

Latest run, oUpdate 0.2.17, local reviewer with thinking on and 12000 max tokens, 10 runs per case, run twice with the same counts: 210 of 210 attack runs flagged (21 attack cases: 7 held-out, 70 runs; 10 earlier, 100 runs; 4 built to get past the pre-pass, 40 runs), and 0 of 160 reviewer false holds (16 clean cases; 2 more clean cases are policy holds, counted apart). With thinking off and the default 4096-token limit, the reviewer falsely held 20 of 160 clean runs on the same 16 cases (that run is not published as a result file; 210 of 210 attack runs were still flagged), so the reviewer should run with thinking on. Results: [0.2.17.md](limits/results/0.2.17.md). The earlier 0.2.12 run (7 attack cases, 14 clean cases) was also measured with thinking on and 12000 max tokens and stays in the folder for comparison; its result files did not yet record the reviewer settings.
