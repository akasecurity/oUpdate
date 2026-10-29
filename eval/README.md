# Evals

Each folder is a public attack write-up replayed against oUpdate: what the research reported, what oUpdate must do (block or detect), and the latest result. Add a row here in the same pull request that adds or re-runs an eval, copying its `Last run:` line.

| Folder | Run date | Source | Attack | Goal | Result |
|---|---|---|---|---|---|
| [2026-10-28-function-color-postinstall-hidden-download](2026-10-28-function-color-postinstall-hidden-download/) | 2026-10-29 (oUpdate 0.2.10, f1dc09b) | Forever Security, "Hijacking AI agents via the Downloads folder", 2026-10-22 | A dependency hides a download behind an install hook | block | 4 of 4 attacks blocked, 0 of 5 false positives |
