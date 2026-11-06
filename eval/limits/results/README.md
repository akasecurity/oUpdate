# Limits eval results

This folder holds one record per release and run: `<version>.json` and `.md` from `run.ts`, `<version>-evasions.*` from `evasions.ts`, `<version>-coverage.*` from `coverage.ts`, and a few named one-off runs. Each file is written by a run and is never edited afterwards.

The fixture package names of three held-out cases were changed after those results were recorded, under the same case ids: the keyv-style, jscrambler-style and node-ipc-style cases now use names that do not exist on the npm registry (kv-store-lite-x, code-guard-pro-x, ipc-bus-lite-x). The results here (0.2.17 and earlier) are not directly comparable to later runs for those three ids; only the keyv-style and jscrambler-style cases appear in them, and the node-ipc-style case first appears in a later run.
