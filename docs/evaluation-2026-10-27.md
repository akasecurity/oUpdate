# Attack and clean-release evaluation, 27 Oct 2026

This page follows the [26 Oct evaluation](evaluation-2026-10-26.md). It adds three things: five repeat runs of the local model on the same cases, the same cases reviewed by two cloud models, and a larger set of 25 real attacks and 25 clean releases. On the core set, the local model stopped all 9 attacks and let all 8 clean releases through in each of the five runs. On the larger set, every reviewer stopped 23 of the 25 attacks, the same two got through all three, and between 9 and 14 of the 25 clean releases were held. Those false holds are the main result of this round.

For the effect of the 0.2.1 and 0.2.2 releases on these cases, see [Update: 0.2.1 and 0.2.2](#update-021-and-022) below.

## What changed since 26 Oct

- **Ranked parts for large releases.** On 26 Oct, a release whose diff stayed over the model's budget (12 parts) even after narrowing to its signal files was not judged and was held for a human. Now the reviewer reads the top 12 parts in ranked order: files with a hard pre-pass signal first, then scanner hits, install or startup files, manifests, new files, and changed files with a soft signal. The verdict line says how much was left out, for example "52 parts not reviewed, 0 file(s) not reviewed". This tier can only stop a release: a FLAG holds it, and an APPROVE also holds it for a human, because the rest was never read.
- **More cases.** 17 more real compromised releases and their clean predecessors, kept as an "extended" set beside the published "core" set, and 4 synthetic evasion cases (below).
- **A per-reviewer scorecard** at the end of the acceptance summary.
- Outside the review path: the `oupdate image` command (checks one container image repin), and the gate now reads more lockfiles (`package-lock.json`, `npm-shrinkwrap.json`, `pnpm-lock.yaml`, `uv.lock`, `poetry.lock`, pinned requirements files), checks downloads against the lockfile integrity, and can report to GitHub with a commit status. None of this was exercised here.

## Sample

- **Core set:** the 9 attacks and 8 clean releases of 26 Oct, plus the 4 evasion cases. Eight attacks come from DataDog's public [malicious-software-packages dataset](https://github.com/DataDog/malicious-software-packages-dataset); the ninth is the reconstructed litellm 1.107.0 release (sdist and wheel), run by its own replay script.
- **Extended set:** the core cases plus 17 more dataset attacks and 17 more clean releases, 25 and 25 in all, plus the replay and the 4 evasion cases. Each clean release is the real registry release before the attacked one.
- **Reviewers:**
  - the local model: the same mid-size open-weights model as on 26 Oct,;
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

## Update: 0.2.1 and 0.2.2

Two releases followed this evaluation. The numbers above are from 0.2.0 code and stay as they are. This section adds what changed and what the extended set showed after.

### What changed

- **0.2.1: an ordered diff for the reviewer.** The old diff compared files as sets of lines, so a line found anywhere in both versions was dropped. That made some changed files look cut off to the model, such as node-ipc 12.0.0. The reviewer now gets ordered hunks with line numbers, and a changed minified line is shown as its removed and added tokens. Files that changed only in line endings or whitespace are named as such.
- **0.2.1: each part is judged on its own.** When a diff is split into parts, the prompt now says each part goes to a separate call and that not seeing the other parts is not by itself a reason to FLAG.
- **0.2.1: a 2-day cooldown by default** for dependency updates in your repos and for pin bumps, down from 7. The cooldown layer was off in these runs, so this change was not measured.
- **0.2.2: an APPROVE at the priority tier holds for a human** when files were left unread. A FLAG still stops the release. If the priority tier has no files to review at all, the release is held for a human without calling the reviewer.

### 0.2.1 on the extended set

The local model and Claude Haiku (small tier) ran the extended set again at 0.2.1, with the same cases, layers and sample cache as above. OpenAI Codex (fast tier) was not run again, so its numbers are still the 0.2.0 ones above.

| Run | Reviewer | Set | Time (PDT) | oUpdate commit |
| --- | --- | --- | --- | --- |
| extended | local model | all | 26 Oct 23:46 to 27 Oct 02:54 | `3d64634` |
| extended | Claude Haiku (small tier) | all | 27 Oct 02:54 to 03:27 | `3d64634` |

The review and pre-pass code at `3d64634` is the same as in the 0.2.1 release. No case was left unjudged for a fetch or model error.

| | Local model, 0.2.0 | Local model, 0.2.1 | Claude Haiku, 0.2.0 | Claude Haiku, 0.2.1 |
| --- | --- | --- | --- | --- |
| Attacks stopped | 23/25 | 24/25 | 23/25 | 24/25 |
| Model FLAG on attacks | 23/25 | 24/25 | 23/25 | 24/25 |
| Stopped by the model alone | 13/25 | 14/25 | 13/25 | 14/25 |
| Clean releases landed | 16/25 | 18/25 | 11/25 | 20/25 |
| Clean releases held (false holds) | 9/25 (36%) | 7/25 (28%) | 14/25 (56%) | 5/25 (20%) |
| Evasion cases stopped (model FLAG) | 4/4 | 4/4 | 4/4 | 4/4 |

Both reviewers also flagged the litellm 1.107.0 replay, sdist and wheel, at 0.2.1.

**Attacks.** @solana/web3.js 1.95.7 is now stopped by both reviewers. Its diff now fits the review budget in 2 parts, so the reviewer read the whole release, built bundles included, and flagged both parts. xrpl 4.2.1 still landed with both. The reviewer again read only `package.json`: "priority files only, 2 lower-priority file(s) not reviewed".

**Clean releases that changed:**

| Clean release | Local model | Claude Haiku (small tier) |
| --- | --- | --- |
| litellm 1.106.2 | landed, no change | held, now landed |
| @bitwarden/cli 2026.3.0 | landed, now held | held, now landed |
| @solana/web3.js 1.95.5 | held, now landed | held, now landed |
| node-ipc 12.0.0 | held, no change | held, now landed |
| posthog-node 5.13.2 | landed, no change | held, now landed |
| telnyx 4.87.0 | landed, no change | held, now landed |
| num2words 0.5.14 | landed, no change | held, now landed |
| guardrails-ai 0.10.0 | held, now landed | held, now landed |
| durabletask 1.4.0 | held, now landed | held, now landed |

The local model newly held @bitwarden/cli 2026.3.0. It read all 5 parts and flagged parts 2 and 4.

**Clean releases still held at 0.2.1:**

| Clean release | Local model | Claude Haiku (small tier) | Review |
| --- | --- | --- | --- |
| @bitwarden/cli 2026.3.0 | held | landed | complete, 5 parts |
| axios 1.14.0 | held | held | complete, 6 parts; the pre-pass holds its changed `prepare` script |
| node-ipc 12.0.0 | held | landed | complete, 1 part |
| xrpl 4.2.0 | held | held | partial, ranked: 9 parts and 69 files not reviewed |
| cline 2.2.3 | held | held | partial, ranked: 192 parts not reviewed |
| elementary-data 0.23.2 | held | held | partial, ranked: 113 parts and 8 files not reviewed |
| xinference 2.5.0 | held | held | partial, ranked: 15 parts and 42 files not reviewed |
| **Held** | **7** | **5** | |

- Haiku flagged none of the 25 clean releases at 0.2.1. It approved axios 1.14.0, which the pre-pass held on its own. It approved the top 12 parts of the four ranked-tier releases, and that tier holds for a human whatever the model answers.
- The local model flagged all 7 of the clean releases it held. 4 of them were partial reviews (ranked tier) and 3 were complete.

### 0.2.2: a replay of the 0.2.1 verdicts

The 0.2.2 rule changes only what happens after the model answers. So it was checked by passing the recorded 0.2.1 verdicts of both reviewers through it, not by running the models again.

In both 0.2.1 runs, xrpl 4.2.1 was the only case whose review covered priority files only. Under 0.2.2, its APPROVE holds it for a human. So with 0.2.2 rules, both reviewers would stop 25 of 25 attacks, and no extra clean releases are held: 18/25 landed for the local model and 20/25 for Haiku, as at 0.2.1. No case in either run had a priority tier with no files to review. Model FLAG on attacks stays 24/25: xrpl 4.2.1 is held because files went unread, not because the model found the payload.

### Limits of this update

- **Single runs.** Each 0.2.1 number is one run per reviewer. The run-to-run spread on the extended set is unknown, so some changes in the tables may be noise.
- **The 0.2.2 numbers are a replay of recorded verdicts, not a fresh run.** They apply the new rule to the 0.2.1 answers.
- **Codex was not run at 0.2.1 or 0.2.2.** Its numbers on this page are still from 0.2.0.
- **The caveats above still apply.** These are known, published attacks, the advisory, cooldown, scanner and gate layers were off, and the cooldown change was not measured.

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
