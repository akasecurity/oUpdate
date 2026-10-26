# Attack and clean-release evaluation, 26 Oct 2026

oupdate reviewed 9 real supply-chain attacks and 8 clean releases with the advisory checks off, so no known-malicious list could help. It stopped all 9 attacks and let all 8 clean releases through. This page gives the sample, the method, which check stopped each attack, and what the result does not show.

## Sample

- **One run**, 26 Oct 2026, 12:58 to 13:09 PDT, oupdate commit `5ca5e43`. An earlier run on 24 Oct, on the same cases with the same model, scored the same totals. It did not keep its per-case output, so this page reports the 26 Oct run.
- **9 attacks.** All are real malicious releases. Eight come from DataDog's public [malicious-software-packages dataset](https://github.com/DataDog/malicious-software-packages-dataset) (`compromised_lib`). The ninth is the litellm 1.107.0 release of 21 Oct 2026, which was live on PyPI for about 1h40m.
- **8 clean releases.** For seven of the attacked packages, the real registry release just before the attack, plus yaml 2.8.3.
- **Model:** a local open-weights model served on our own hardware through an OpenAI-compatible endpoint. No cloud model was used.

## Layers

| Layer | State | What it does |
| --- | --- | --- |
| advisory | off | known-malicious and vulnerability feeds |
| cooldown | off | holds new releases for N days |
| pre-pass | on | deterministic checks for literal attack patterns: install scripts, Python startup hooks (`.pth`, `sitecustomize.py`), build includes |
| scan | on, no scanner | the optional GuardDog layer; no scanner was configured, so it did nothing |
| reviewer | on | the local model reads the release's changed files and answers APPROVE or FLAG |
| gate | off | your own tests; never run on a malicious sample |

Any layer that says stop holds the release.

## Results

| Attack | Pre-pass | Model reviewer | Outcome |
| --- | --- | --- | --- |
| litellm 1.82.7 (PyPI) | pass | FLAG | stopped |
| ultralytics 8.3.41 (PyPI) | pass | FLAG | stopped |
| debug 4.4.2 (npm) | pass | FLAG | stopped |
| litellm 1.82.8 (PyPI) | stop: startup hook `litellm_init.pth` | FLAG | stopped |
| @nx/devkit 21.5.0 (npm, s1ngularity) | stop: install script | FLAG | stopped |
| eslint-config-prettier 10.1.7 (npm) | stop: install script | FLAG | stopped |
| litellm 1.107.0 (PyPI), sdist and wheel | stop: startup hooks `cook.pth`, `sitecustomize.py` | FLAG on both | stopped |
| @ctrl/tinycolor 4.1.1 (npm, Shai-Hulud) | stop: install script | not judged: too large (64 parts, limit 12), held for a human | stopped |
| @bitwarden/cli 2026.4.0 (npm) | stop: install script | not judged: too large (171 parts, limit 12), held for a human | stopped |

- **The model flagged 7 of the 9 attacks.** For 3 of them, it was the only check that stopped them.
- **The pre-pass stopped 6 of the 9.** It was the only check that stopped tinycolor and bitwarden.
- **No attack got through both checks.**

| Clean release | Pre-pass | Model reviewer | Outcome |
| --- | --- | --- | --- |
| litellm 1.106.2 | pass | APPROVE (priority files only; 326 lower-priority files not reviewed) | landed |
| ultralytics 8.3.40 | pass | APPROVE | landed |
| @ctrl/tinycolor 4.1.0 | pass | APPROVE | landed |
| @nx/devkit 21.4.1 | pass | APPROVE | landed |
| debug 4.4.1 | pass | APPROVE | landed |
| eslint-config-prettier 10.1.5 | pass | APPROVE | landed |
| @bitwarden/cli 2026.3.0 | pass | APPROVE | landed |
| yaml 2.8.3 | pass | APPROVE | landed |

## What this does not show

- **It's a small sample.** One run on 9 attacks and 8 clean releases can't give a detection rate or a false-alarm rate for real traffic. Model output can vary between runs.
- **The model didn't stop everything alone.** Two attacks were too large for it to review and were held for a human. For the 4 attacks where both checks fired, this run can't tell whether the model would have caught them without the pre-pass hints.
- **The model didn't read every file.** It skipped the lower-priority files of large releases: 61 files of litellm 1.82.7, and 326 files of the clean litellm 1.106.2.
- **These are known, published attacks.** The model's training data may include write-ups of the older ones. The test didn't include attacks built to evade this reviewer, such as prompt injection aimed at the model.
- **litellm 1.107.0 is a reconstruction.** No PyPI mirror still had the removed files. The replay rebuilt it from the 1.106.2 release plus the attacker's public commits (BerriAI/litellm `a8113b0d...20535d8f`). That replay script isn't in this repository, so a run from here counts that case as not run.
- **Most of oupdate was switched off.** The advisory, cooldown, scanner and gate layers were off, so the test exercises the pre-pass and the reviewer alone.

## Reproduce

Nothing in the samples is installed, imported or run, but run this on a machine with no credentials in reach.

```bash
bun install
cat > reviewers.json <<'EOF'
[{"type":"openai","name":"local","baseUrls":["http://127.0.0.1:8080/v1"],"model":"<your local model>"}]
EOF
bun acceptance/run.ts --reviewers reviewers.json --layers prepass,scan,reviewer
cat acceptance-results/summary.txt
```

`acceptance/run.ts` fetches the 8 dataset samples and the 8 clean releases, then writes one JSON file per case plus `summary.txt` to `./acceptance-results/`.
