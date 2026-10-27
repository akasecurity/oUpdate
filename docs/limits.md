# Limits

These are the published limits of oUpdate. Each one has a GitHub issue (label `limit`) that names the behavior we want, the metric that measures it, and the pass bar. Every release re-scores this table. When a limit's eval passes, this page, the README and the website change with it. This page is the source of truth for those lines.

Scored at: **0.2.2** (numbers from [the 27 Oct evaluation](evaluation-2026-10-27.md), extended set: 25 attacks plus the litellm 1.107.0 replay, 25 clean releases).

| # | Limit | Metric | Pass bar | Now | Issue |
| --- | --- | --- | --- | --- | --- |
| 1 | Attacks are known and published, and may be in the models' training data; litellm 1.107.0 is a reconstruction | Stops on held-out attacks published after each model's training cutoff | At least 10 held-out attacks, all stopped | Not measured | [#16](https://github.com/akasecurity/oUpdate/issues/16) |
| 2 | The latest totals replay recorded verdicts under the newest hold rule, not a fresh run | Fresh run at the release commit, or replay | Fresh run for every release that changes review behavior | Replay (0.2.2 rules over the 0.2.1 verdicts) | [#17](https://github.com/akasecurity/oUpdate/issues/17) |
| 3 | Single runs on known attacks, not a detection rate | Spread across repeat runs; stop rate with a 95% interval | 5 or more runs per reviewer, all attacks stopped in every run, 50 or more attacks | Core set: 5 local runs, 9/9 each. Extended set: 1 run per reviewer, 26 attacks | [#18](https://github.com/akasecurity/oUpdate/issues/18) |
| 4 | False holds on clean releases | False-hold rate per reviewer, with the reason for each hold | 10% or less, no attack lost | Local model 28% (7/25), Claude Haiku 20% (5/25) | [#19](https://github.com/akasecurity/oUpdate/issues/19) |
| 5 | Many flags came after a partial read of a large diff | Unread-files rate; share of attack stops made after a full read | 90% or more of attack stops after a full read | Not scored per case yet; 4 of 25 clean releases were partial reads | [#20](https://github.com/akasecurity/oUpdate/issues/20) |
| 6 | The advisory, cooldown, scanner and gate layers were off in the eval | Stops and false holds with all layers on, and each layer alone | A published run with all layers on, and one per layer | Not run | [#21](https://github.com/akasecurity/oUpdate/issues/21) |
| 7 | Not a package-manager hook: manual and agent installs bypass it | Coverage test of each install path | brew, npm -g and pip/uv installs outside oUpdate are reviewed or held | Not covered | [#22](https://github.com/akasecurity/oUpdate/issues/22) |
| 8 | Python lockfile sha256 hashes are not checked in the gate | Gate cases that swap the hash at the same version | Every swap fails, the clean case passes | Not checked | [#24](https://github.com/akasecurity/oUpdate/issues/24) |
| 9 | `oupdate image` reads no layer contents and supports no private registries | Image cases with a payload layer, and a private-registry case | Payload layer holds, clean repin lands, private registry holds | Layers not read | [#13](https://github.com/akasecurity/oUpdate/issues/13) |
| 10 | Not covered: yarn.lock in the gate, apt and other OS packages, Mac App Store | Coverage matrix, one case per ecosystem | No ecosystem passes unseen: each is reviewed or held | Not covered | [#23](https://github.com/akasecurity/oUpdate/issues/23) |
