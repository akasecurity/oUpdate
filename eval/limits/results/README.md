# Limits eval results

This folder holds one record per release and run: `<version>.json` and `.md` from `run.ts`, `<version>-evasions.*` from `evasions.ts`, `<version>-coverage.*` from `coverage.ts`, and a few named one-off runs. Each result file is written by a run and is never edited afterwards.

## Renamed held-out fixtures

The fixture package names of three held-out cases were changed, under the same case ids, because the old names were real npm packages a reviewer model might recognize. Only the package name changed; versions and file contents are the same. The result files store case ids, not package names, so this note is the record of the change.

| Case | Old name | New name |
| --- | --- | --- |
| keyv-style | `kv-store` | `kv-store-lite-x` |
| jscrambler-style | `code-guard` | `code-guard-pro-x` |
| node-ipc-style | `ipc-bus` | `ipc-bus-lite-x` |

The results here (0.2.17 and earlier) for the keyv-style and jscrambler-style cases were recorded under the old names, so they are not directly comparable to later runs for those two ids. The node-ipc-style case was renamed before any run was recorded, so it appears in no result here and has no old results to compare. The new names did not exist on the npm registry when they were chosen (2026-11-06).

The mastra-style-typosquat-dependency-postinstall case changed bytes (decoys 60 -> 123) after it was added, so a run made on the earlier bytes is not directly comparable to later runs for that id. It appears in no result here.
