# Limits eval results

This folder holds one record per release and run: `<version>.json` and `.md` from `run.ts`, `<version>-evasions.*` from `evasions.ts`, `<version>-coverage.*` from `coverage.ts`, and a few named one-off runs. Each result file is written by a run and is never edited afterwards.

## Changed held-out fixtures

The fixture package names of three held-out cases were changed, under the same case ids (a fourth, the host package of the mastra-style-typosquat-dependency-postinstall case, was named flow-agent and became flow-agent-kit-x before it was public or run, so it has no old results), because the old names were real npm packages a reviewer model might recognize. Only the package name changed; versions and file contents are the same. The result files store case ids, not package names, so this note is the record of the change.

| Case | Old name | New name |
| --- | --- | --- |
| keyv-style | `kv-store` | `kv-store-lite-x` |
| jscrambler-style | `code-guard` | `code-guard-pro-x` |
| node-ipc-style | `ipc-bus` | `ipc-bus-lite-x` |

The results here (0.2.17 and earlier) for the keyv-style and jscrambler-style cases were recorded under the old names, so they are not directly comparable to later runs for those two ids. The node-ipc-style case was renamed before any run was recorded, so it appears in no result here and has no old results to compare. The new names did not exist on the npm registry when they were chosen (2026-11-06).

The mastra-style-typosquat-dependency-postinstall case changed bytes on 2026-11-06: the dropper grew from 2987 to 4595 bytes (decoys 60 -> 123) to match the write-up. The case was first released in v0.2.19 with the 123-decoy bytes, so no release carried the 60-decoy bytes, no recorded run used them, and the case appears in no result here (the results here stop at 0.2.17).
