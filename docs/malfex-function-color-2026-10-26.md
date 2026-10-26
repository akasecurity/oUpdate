# MALFEX `function-color` through oUpdate, 26 Oct 2026

On 22 Oct 2026, Forever Security [reported](https://forever.security/blog/hijacking-ai-agents-via-downloads-folder/) a planted `AGENTS.md` in `~/Downloads` that steered a coding agent into installing the npm package `function-color`, part of the MALFEX campaign. We ran the real malicious releases through oUpdate's review to see what it does with them. It held every case, in one run, on dependency and global updates only (not the `launchctl` install path in the report); the model may have seen public MALFEX write-ups in training. This page gives the samples, the method, which check stopped each case, and what the result does not show.

## Samples

- **`function-color`** had two releases, 1.0.0 and 1.7.3. Both are listed as malicious (OSV `MAL-2026-17647`), so there is no clean earlier release to compare against.
- **`function-flag`** is the dependency `function-color` pulls in, and it is where the payload is. We used 4.0.0 and 1.7.3, the version that `function-color` 1.7.3's range resolves to.
- npm has removed the tarballs, and the DataDog malicious-software-packages dataset does not include these packages. We took them from a public npm mirror that still served them. npm's integrity hashes left with the tarballs, so we checked the copies against Checkmarx's published MALFEX indicators instead: the sha256 of `function-flag` 1.7.3's `index.js` and the download hosts in both `function-flag` versions match.

| Tarball | sha1 |
|---|---|
| `function-color-1.0.0.tgz` | `89d17dc44c49613160c5671214b636febd0f8643` |
| `function-color-1.7.3.tgz` | `77450ca807f126a6e2ac6d845ae02b76ec71c8f0` |
| `function-flag-1.7.3.tgz` | `2c0308e6afeaef92e138bd0b58d5f658f2dd222c` |
| `function-flag-4.0.0.tgz` | `34e04041bfeb879c59d46e13a856878935cc7908` |

## Method

- **One run**, 26 Oct 2026, four cases, one model call each, about 28 seconds in all. The review code is the one at public commit `064dc50`.
- **Layers:** the deterministic pre-pass and a model reviewer. No advisory check, threat feed, cooldown or scanner, so no known-malicious list could help.
- **Model:** a local open-weights model served on our own hardware through an OpenAI-compatible endpoint. No cloud model was used.
- **Cases:** each package as an update (`function-color` 1.0.0 → 1.7.3, `function-flag` 4.0.0 → 1.7.3) and as a new package (nothing → 1.7.3), the way `oupdate gate` sees a package the old lockfile did not have. The tarballs were read in memory; nothing was unpacked to disk, installed or run.

## Results

| Case | Decision | Stopped by |
|---|---|---|
| `function-color` 1.0.0 → 1.7.3 | held | model reviewer |
| `function-color` new → 1.7.3 | held | model reviewer |
| `function-flag` new → 1.7.3 | held | pre-pass (install script) and model reviewer |
| `function-flag` 4.0.0 → 1.7.3 | held | model reviewer |

- **`function-color` carries no payload of its own.** Its `index.js` is the same in 1.0.0 and 1.7.3: it adds color getters (`red`, `green`, ...) to every string, and each one calls `function-flag`'s `asciiArt(text, 'Bloody')`. The only change in 1.7.3 is the `function-flag` range, from `^4.0.0` to `^1.7.3`. The reviewer flagged the update as a suspicious major-version downgrade of an unknown dependency, and the new package for hooking every string to call that dependency. Both verdicts are right, but on indirect grounds: the reviewer never saw `function-flag`'s code in these two cases.
- **`function-flag` 1.7.3 is the payload.** Its `package.json` runs `example.js` on install, which calls `asciiArt("oi", "Bloody")`. In `index.js`, the font name `Bloody` reaches a function that downloads a Windows executable into `%APPDATA%` and runs it with its window hidden (hosts `cdnzona[.]discloud[.]app` in 1.7.3, `apicdn[.]squareweb[.]app` in 4.0.0). The call sits at the far right of a line padded with hundreds of spaces, out of sight in a normal editor view. As a new package, the pre-pass stopped it on the install script and the reviewer flagged the download-and-run. As an update from 4.0.0 the pre-pass did not fire, because it counts only signals a release adds and 4.0.0 already had the install script; the reviewer stopped it alone.

An install of `function-color` 1.7.3 brings in `function-flag` 1.7.3, so a lockfile change that adds it carries both, and oUpdate holds both.

## What this does not show

- **Not the install path in the report.** There, the agent wrote an MCP server entry whose command runs `npm install function-color` in a scratch directory through `launchctl`. oUpdate is not a hook on `npm`: it reviews the updates it applies or gates (npm globals and Homebrew on a Mac, repo dependency updates from an update bot). An install an agent or an attacker runs directly never reaches it.
- **One run.** Model output varies between runs, and the model may have seen public write-ups of MALFEX in training.
- **Four cases from one campaign.** For a broader measure, see the [attack and clean-release evaluation](evaluation-2026-10-26.md).

## Reproduce

For an update case:

```
oupdate review npm function-color 1.0.0 1.7.3 \
  --old-artifact function-color-1.0.0.tgz --new-artifact function-color-1.7.3.tgz \
  --only prepass,scan,reviewer \
  --reviewer '{"type":"openai","name":"local","baseUrls":["<endpoint>/v1"],"model":"<model>"}'
```

The command line does not take an empty "from" version, so the new-package cases call `reviewUpdate` from `src/review.ts` directly, the function the CLI and the acceptance suite use, with an empty `from`.
