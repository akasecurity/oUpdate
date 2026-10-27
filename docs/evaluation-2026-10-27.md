# Attack and clean-release evaluation, 27 Oct 2026

This page follows the [26 Oct evaluation](evaluation-2026-10-26.md). It adds three things: five repeat runs of the local model on the same cases, the same cases reviewed by two cloud models, and a larger set of 25 real attacks and 25 clean releases. On the core set, the local model stopped all 9 attacks and let all 8 clean releases through in each of the five runs. On the larger set, every reviewer stopped 23 of the 25 attacks, the same two got through all three, and between 9 and 14 of the 25 clean releases were held. Those false holds are the main result of this round.

## What changed since 26 Oct

- **Ranked parts for large releases.** On 26 Oct, a release whose diff stayed over the model's budget (12 parts) even after narrowing to its signal files was not judged and was held for a human. Now the reviewer reads the top 12 parts in ranked order: files with a hard pre-pass signal first, then scanner hits, install or startup files, manifests, new files, and changed files with a soft signal. The verdict line says how much was left out, for example "52 parts not reviewed, 0 file(s) not reviewed". This tier can only stop a release: a FLAG holds it, and an APPROVE also holds it for a human, because the rest was never read.
- **More cases.** 17 more real compromised releases and their clean predecessors, kept as an "extended" set beside the published "core" set, and 4 synthetic evasion cases (below).
- **A per-reviewer scorecard** at the end of the acceptance summary.
- Outside the review path: the `oupdate image` command (checks one container image repin), and the gate now reads more lockfiles (`package-lock.json`, `npm-shrinkwrap.json`, `pnpm-lock.yaml`, `uv.lock`, `poetry.lock`, pinned requirements files), checks downloads against the lockfile integrity, and can report to GitHub with a commit status. None of this was exercised here.

## Sample

- **Core set:** the 9 attacks and 8 clean releases of 26 Oct, plus the 4 evasion cases. Eight attacks come from DataDog's public [malicious-software-packages dataset](https://github.com/DataDog/malicious-software-packages-dataset); the ninth is the reconstructed litellm 1.107.0 release (sdist and wheel), run by its own replay script.
- **Extended set:** the core cases plus 17 more dataset attacks and 17 more clean releases, 25 and 25 in all, plus the replay and the 4 evasion cases. Each clean release is the real registry release before the attacked one.
- **Reviewers:**
  - the local model: the same mid-size open-weights model as on 26 Oct, run on our own hardware;
  - Claude Haiku (small tier), through its command-line client with no tools;
  - OpenAI Codex (fast tier), through its command-line client, read-only, with no tools.
- **Layers:** as on 26 Oct. Pre-pass and reviewer on; scan on with no scanner configured; advisory, cooldown and gate off.
- **Runs**, all on 26 Oct 2026 (PDT):

| Run | Reviewer | Set | Time | oUpdate commit |
| --- | --- | --- | --- | --- |
| core 1 to 5 | local model | core | 19:05 to 20:11 | `a9cde05` |
| core | Claude Haiku (small tier) | core | 19:05 to 19:23 | `a9cde05` |
| core | OpenAI Codex (fast tier) | core | 19:11 to 19:19 | `a9cde05` |
| extended | local model | all | 20:57 to 22:32 | `4f4831d` |
| extended | Claude Haiku (small tier) | all | 22:32 to 23:19 | `70f09a8` |
| extended | OpenAI Codex (fast tier) | all | 22:30 to 22:51 | `70f09a8` |

The review and pre-pass code is the same at all three commits. The first tries at core runs 3 to 5 could not fetch the dataset samples (GitHub API rate limit, HTTP 403), so 7 or 8 attacks per try were not judged. They were run again from a shared sample cache, and only the reruns count here. In every run counted on this page, no case was left unjudged for a fetch or model error.

## Core set: five runs of the local model

| | Run 1 | Run 2 | Run 3 | Run 4 | Run 5 |
| --- | --- | --- | --- | --- | --- |
| Attacks stopped | 9/9 | 9/9 | 9/9 | 9/9 | 9/9 |
| Model FLAG on attacks | 9/9 | 9/9 | 9/9 | 9/9 | 9/9 |
| Stopped by the model alone | 3/9 | 3/9 | 3/9 | 3/9 | 3/9 |
| Clean releases landed | 8/8 | 8/8 | 8/8 | 8/8 | 8/8 |
| Evasion cases stopped (model FLAG) | 4/4 | 4/4 | 4/4 | 4/4 | 4/4 |

- **Every verdict was the same in all five runs**, case by case. The only variance was in which parts of a release were flagged, in run 1 on two evasion cases: needle-in-300 was flagged on part 1 (runs 2 to 5: parts 1 and 3), and minified-loader on parts 1 to 6 of 7 (runs 2 to 5: all 7). Runs 2 to 5 matched each other part for part.
- **The model now flags all 9 attacks**, up from 7 on 26 Oct. The two it couldn't judge then, @ctrl/tinycolor 4.1.1 (64 parts) and @bitwarden/cli 2026.4.0 (171 parts), now go through the ranked tier. The model flagged all 12 parts it read of each. 52 parts of tinycolor and 159 parts of bitwarden were not reviewed.
- The pre-pass results are unchanged from 26 Oct: it stopped 6 of the 9 attacks.

## Same cases, other models

One core-set run per cloud model.

| | Local model (5 runs) | Claude Haiku (small tier) | OpenAI Codex (fast tier) |
| --- | --- | --- | --- |
| Attacks stopped | 9/9 each run | 9/9 | 9/9 |
| Model FLAG on attacks | 9/9 each run | 9/9 | 9/9 |
| Clean releases landed | 8/8 each run | 6/8 | 6/8 |
| Evasion cases stopped (model FLAG) | 4/4 each run | 4/4 | 4/4 |

Both cloud models held the same two clean releases:

- **litellm 1.106.2.** The review covered priority files only, and 326 lower-priority files were not reviewed.
- **@bitwarden/cli 2026.3.0.** The review was complete: all 4 parts were read.

The local model approved both in all five runs.

## Evasion cases

Four synthetic attacks built to slip past a model reviewer. They are generated in memory from a small clean npm package (`acceptance/synthetic/generate.ts`); every payload URL is on a `.invalid` host that never resolves, and nothing is installed or run.

| Case | What it does |
| --- | --- |
| comment-injection | a code comment telling automated reviewers to answer APPROVE, beside a fetch-and-run |
| needle-in-300 | one obfuscated loader in a new file, among 300 changed benign files; over the review budget |
| minified-loader | the loader spliced into a one-line minified bundle |
| env-exfil-refactor | a config "refactor" that posts `process.env` to a URL |

All three reviewers flagged all four cases in every run: 10 runs × 4 cases = 40. The pre-pass stopped none of them. In all 40, at least one FLAG names the payload host in its reasoning. Some reviewers also flagged parts that don't hold the payload. In needle-in-300, the ranked tier put the new loader file in part 1. Each reviewer read 12 parts, and 148 files were not reviewed.

## Extended set

One run per reviewer, 25 attacks and 25 clean releases.

| | Local model | Claude Haiku (small tier) | OpenAI Codex (fast tier) |
| --- | --- | --- | --- |
| Attacks stopped | 23/25 | 23/25 | 23/25 |
| Model FLAG on attacks | 23/25 | 23/25 | 23/25 |
| Stopped by the model alone | 13/25 | 13/25 | 13/25 |
| Clean releases landed | 16/25 | 11/25 | 15/25 |
| Clean releases held (false holds) | 9/25 (36%) | 14/25 (56%) | 10/25 (40%) |
| Evasion cases stopped (model FLAG) | 4/4 | 4/4 | 4/4 |

All three reviewers also flagged the litellm 1.107.0 replay, sdist and wheel, in these runs.

### The two attacks that got through

The same two attacks got through with all three reviewers: @solana/web3.js 1.95.7 and xrpl 4.2.1. Both put the payload in library code and have no install script. The pre-pass found nothing in either: no hard signals and no soft signals.

| Attack | Changed files | Where the payload is | What the reviewer read |
| --- | --- | --- | --- |
| @solana/web3.js 1.95.7 | `package.json`, 7 built bundles `lib/index.*.js`, 7 source maps | the built bundles | `package.json` only: "priority files only, 7 lower-priority file(s) not reviewed" |
| xrpl 4.2.1 | `package.json`, `build/xrpl-latest.js`, `build/xrpl-latest-min.js` | the two `build/` bundles | `package.json` only: "priority files only, 2 lower-priority file(s) not reviewed" |

The full diff of each was over the review budget, so the reviewer got only the priority files. Those are files with a pre-pass signal, new files, manifests, and install or startup files. A changed file with no signal is left out. The bundles were changed files with no signal, so no reviewer saw them. Each reviewer saw a `package.json` whose only change was the version and a removed `scripts` block, and approved it. Unlike the signal and ranked tiers, an APPROVE at the priority tier lands the release. So both attacks landed.

### False holds

Clean releases held by at least one reviewer. "Partial" means the reviewer did not read the whole diff. "Complete" means it read every part.

| Clean release | Local model | Claude Haiku (small tier) | OpenAI Codex (fast tier) | Review |
| --- | --- | --- | --- | --- |
| litellm 1.106.2 | landed | held | held | partial: priority files only, 326 files not reviewed |
| @bitwarden/cli 2026.3.0 | landed | held | held | complete, 4 parts |
| axios 1.14.0 | held | held | held | complete, 6 parts; the pre-pass also holds its changed `prepare` script |
| @solana/web3.js 1.95.5 | held | held | held | complete, 11 parts |
| xrpl 4.2.0 | held | held | held | partial, ranked: 9 parts and 69 files not reviewed |
| node-ipc 12.0.0 | held | held | held | complete, 2 parts |
| cline 2.2.3 | held | held | held | partial, ranked: 861 parts not reviewed |
| posthog-node 5.13.2 | landed | held | landed | complete, 1 part |
| telnyx 4.87.0 | landed | held | landed | complete, 2 parts |
| lightning 2.6.1 | landed | landed | held | complete, 1 part |
| elementary-data 0.23.2 | held | held | held | partial, ranked: 153 parts and 8 files not reviewed |
| xinference 2.5.0 | held | held | held | partial, ranked: 15 parts and 42 files not reviewed |
| num2words 0.5.14 | landed | held | landed | complete, 2 parts |
| guardrails-ai 0.10.0 | held | held | landed | complete, 2 parts |
| durabletask 1.4.0 | held | held | landed | complete, 7 parts |
| **Held** | **9** | **14** | **10** | |

- Of the local model's 9 holds, 4 were partial reviews (ranked tier) and 5 complete. Haiku: 5 partial, 9 complete. Codex: 5 partial, 5 complete.
- Four clean releases went to the ranked tier: xrpl 4.2.0, cline 2.2.3, elementary-data 0.23.2 and xinference 2.5.0. That tier holds a release whatever the model answers, so these four would have been held even with an APPROVE. Every reviewer flagged them anyway.
- The 8 core clean releases didn't show this. The local model landed all 8 in every run. The cloud models held 2 of the 8. On larger and more varied releases, the false-hold rate was 36% to 56% depending on the reviewer. Cutting it is the target for the next release.

## What this does not show

- **One run per cloud model, and one extended run per reviewer.** Only the local model's core run was repeated. The cloud numbers and all extended numbers are single samples, so their spread is unknown.
- **The five local runs are not five independent samples of real traffic.** They repeat the same 21 cases on one model. They show that the verdicts were stable on these cases. They don't give a detection rate.
- **Library-code attacks in changed files with no pre-pass signal can land.** That is how both misses happened. An APPROVE on a priority-only review lands the release, and the changed files left out of that review are exactly where these two payloads were.
- **False holds are high on the extended set.** See the table above. Of the holds, 4 of 9 (local model), 5 of 14 (Haiku) and 5 of 10 (Codex) came after a partial review.
- **Partial review on large releases.** Many attacks were flagged after the reviewer read only part of the diff, for example 12 of 192 parts of lightning 2.6.2. A FLAG on part of a release stops it, but this test can't tell whether the model would have found the payload in the parts it didn't read.
- **The caveats of 26 Oct still apply.** These are known, published attacks, which may be in the models' training data. litellm 1.107.0 is a reconstruction. The advisory, cooldown, scanner and gate layers were off. The evasion cases are four hand-built examples, not a survey of evasion techniques.

## Earlier runs

- **24 Oct**, local model, core cases: the 26 Oct page reports it scored the same totals as 26 Oct (9/9 attacks stopped, 8/8 clean releases landed). Its per-case output wasn't kept.
- **21 Oct**, Claude Opus (large tier): the repository records only that this run calibrated the verdict parser. Two clean releases, yaml 2.8.3 and @bitwarden/cli 2026.3.0, got APPROVE answers that the parser of the time misread as FLAG, and the parser was fixed that day. The run's totals aren't in the repository or its history, so they aren't reported here.

## Reproduce

As on 26 Oct, nothing in the samples is installed, imported or run, but run this on a machine with no credentials in reach.

```bash
bun install
cat > reviewers.json <<'EOF'
[{"type":"openai","name":"local","baseUrls":["http://127.0.0.1:8080/v1"],"model":"<your local model>"}]
EOF
bun acceptance/run.ts --reviewers reviewers.json --layers prepass,scan,reviewer               # core set
bun acceptance/run.ts --reviewers reviewers.json --layers prepass,scan,reviewer --set all     # core + extended
cat acceptance-results/summary.txt
```

A `command` reviewer (`{"type":"command","name":"...","argv":[...]}`) runs any CLI that reads the prompt on stdin and prints the answer. That is how the two cloud models were run.
