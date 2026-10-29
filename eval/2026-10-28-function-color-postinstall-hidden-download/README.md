# function-color: a dependency that hides a download behind an install hook

**Research:** "Hijacking AI agents via the Downloads folder", Forever Security, published 2026-10-22, <https://forever.security/blog/hijacking-ai-agents-via-downloads-folder/>

Last run: 2026-10-29, oUpdate 0.2.10 (f1dc09b), 4 of 4 attacks blocked, 0 of 5 false positives

- **Source:** Forever Security, ["Hijacking AI agents via the Downloads folder"](https://forever.security/blog/hijacking-ai-agents-via-downloads-folder/), 22 Oct 2026. Our earlier run of the real malicious releases is kept here as [malfex-function-color-2026-10-26.md](malfex-function-color-2026-10-26.md).
- **Attack:** `function-color` has no payload of its own. It adds color getters to every string, and each one calls its dependency `function-flag`. `function-flag` 1.7.3 runs `example.js` on install, and a call at the far right of a line padded with hundreds of spaces makes a helper download a Windows executable and run it hidden.
- **Goal:** `block` (kind: vulnerability). The tool must hold every attack case and land every look-alike, under the default policy.

## How scoring works

Each case is one pull request: the lockfile before and after goes through `runGate`, every package the change brings in (direct or transitive) is reviewed, and an attack counts as blocked when the gate fails the pull request because a package in it is held; a look-alike or control passes when the gate lets the pull request through.

## Cases

All synthetic: package names follow the public write-up, hosts are reserved `.example` names, file bodies are written for this eval.

| Case | Kind | Goal |
|---|---|---|
| `function-color-update` (1.0.0 to 1.7.3, its dependency `function-flag` moves 4.0.0 to 1.7.3) | attack | block |
| `function-color-install` (new install, brings in `function-flag` 1.7.3) | attack | block |
| `function-flag-install` (new install, install script plus hidden download) | attack | block |
| `function-flag-update` (4.0.0 to 1.7.3, install script already present) | attack | block |
| `control-patch-update` | control | pass |
| `lookalike-color-install` (legit string-color helper, no hooks) | look-alike | pass |
| `lookalike-color-dep-range-update` (dependency range moves within a major) | look-alike | pass |
| `lookalike-banner-update` (a font named Bloody, unchanged benign postinstall) | look-alike | pass |
| `lookalike-prebuilt-update` (unchanged install script that fetches a prebuilt binary; only `lib/hash.js` changes) | look-alike | pass |

## Results

oUpdate 0.2.10, default policy, pre-pass layer (no model reviewer, so the result is the same every run).

| Case | Pull request | Held at |
|---|---|---|
| `function-color-update` | failure | `function-color` 1.0.0 to 1.7.3 and `function-flag` 4.0.0 to 1.7.3 (pre-pass, install script) |
| `function-color-install` | failure | `function-flag` new 1.7.3 (pre-pass, install script) |
| `function-flag-install` | failure | `function-flag` new 1.7.3 (pre-pass, install script) |
| `function-flag-update` | failure | `function-flag` 4.0.0 to 1.7.3 (pre-pass, install script) |
| 5 controls and look-alikes | success | none |

Attacks blocked 4 of 4, look-alike false positives 0 of 5.

## Run

```
bun eval/2026-10-28-function-color-postinstall-hidden-download/run.ts
```

Writes `results/results.json` and `results/results.md` (git-ignored). Exit 0 only when every case meets its goal.
