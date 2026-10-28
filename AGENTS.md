# AGENTS.md

Instructions for a coding agent that is setting oUpdate up for its user, or working on this repository. The [README](README.md) is the full reference; this file is the order to do things in.

## Setting oUpdate up for a user

Work through these steps in order. Show the user what you found at each step, and ask before anything that changes their system outside this checkout.

### 1. Ask what they want

oUpdate does five separate jobs. Ask which ones the user wants, and don't set up the others.

- **Nightly updates on a Mac (`oupdate host --apply`).** Applies Homebrew formula, cask and npm global updates after review. This is the usual choice for a Mac user.
- **One-off review (`oupdate review`).** Reviews a single npm or PyPI update before you take it.
- **Container image check (`oupdate image`).** Compares an image you run with the tag or digest you want to repin to, before you change the pin. It only reads.
- **Update PR gate (`oupdate gate`).** Reviews each Renovate or Dependabot PR and posts a commit status. It reads `bun.lock`, `package-lock.json`, `npm-shrinkwrap.json`, `pnpm-lock.yaml`, `uv.lock` and `poetry.lock`, plus a pinned `requirements*.txt` named with `--lock`. It works on GitHub (`--forge github`, usually from a scheduled Actions workflow; the README section has the file) and on Gitea or Forgejo.
- **Repo hardening check (`oupdate keys`).** Checks a repo's package-manager config for release-age and build-script settings. It only reads.

### 2. Check the prerequisites

- Bun: `bun --version`. If it's missing, ask the user before installing it (https://bun.sh).
- For host updates, macOS with Homebrew: `brew --version`, `which brew`, `which npm`.

### 3. Install

Clone to a stable path the user will keep, such as `~/.oupdate/app`. A scheduled job runs from this path, so it must not be under a temporary directory.

Install the latest release tag, not the tip of `main`. Show the user the commit `git rev-parse HEAD` prints next to the one on https://github.com/akasecurity/oupdate/releases, and stop if they differ.

```bash
git clone --branch v0.2.5 https://github.com/akasecurity/oupdate.git ~/.oupdate/app
cd ~/.oupdate/app
git rev-parse HEAD
bun install
```

### 4. Choose the reviewer model

The reviewer is any OpenAI-compatible chat endpoint. Ask the user which one to use:

- **A local model.** Use the server's base URL, for example Ollama `http://127.0.0.1:11434/v1`, LM Studio `http://127.0.0.1:1234/v1` or a llama.cpp server `http://127.0.0.1:8080/v1`, plus a model it serves. List the served models with `curl -s <base>/models` (for a base given without `/v1`, use `<base>/v1/models`). `baseUrls` takes a base with or without `/v1`.
- **A hosted model.** Use the provider's OpenAI-compatible base URL. Set `"apiKeyEnv"` to the name of the environment variable that holds the key. Never write a key into the config, this repository or the chat. oUpdate sends the key only over https or to a loopback host (127.0.0.1, ::1, localhost); with a key set, a plain http base URL on any other host is skipped. A redirect is an error for that base URL and is never followed, with or without a key, so neither the key nor any configured header goes anywhere else.

The reviewer spec is one JSON object:

```json
{ "type": "openai", "name": "local", "baseUrls": ["http://127.0.0.1:8080/v1"], "model": "<model>" }
```

Optional keys: `apiKeyEnv`, `maxTokens` (default 4096), `timeoutMs` (default 900000), `headers` and `expectHeaders`. `headers` are sent on the request. `expectHeaders` names response headers a 2xx answer must carry: the name is compared case-insensitively and the value exactly. A mismatch discards that answer (`<base>: answer <header> <got>, expected <want>`, or `missing` when the header is absent) and the next base is tried. It is not retried. To refuse an answer the fleet router served from its cloud fallback, set `"expectHeaders": {"x-ofleet-served-by": "local"}`. Without a reviewer, oUpdate holds every update that needs a review.

Check the endpoint with a known-clean update. It should end in `LAND`, with `reviewer pass ... APPROVE`:

```bash
bun src/cli.ts review npm ms 2.1.2 2.1.3 --reviewer '<the JSON above>'
```

If the reviewer line says `error` or the call times out, fix the endpoint before you go on.

### 5. Set up the job

**Nightly updates on a Mac.** Follow the README's [Host apply](README.md#host-apply) Quick start:

1. Write `apply` in `~/.config/oupdate/config.json`. Get the absolute paths of `brew` and `npm` from `which`. Put `stateDir` and `logFile` under the user's home, for example `~/.oupdate/state` and `~/.oupdate/logs/{date}.log`, written as absolute paths. Use your reviewer spec as `reviewer`.
   - Set `notify` to `[]` unless the user has a notification command.
   - Taps outside Homebrew's own go in `typeBTaps` only with the user's say-so. List them with `brew tap`.
   - An unknown key is an error, so add only keys the README documents.
2. Run `bun src/cli.ts host --apply --dry-run`. Show the user the tier split, the holds and any notices it would have sent. Nothing changes on disk except a `dry-run-` log beside the log file. `STALE KEG` lines name running processes still on a Homebrew version that was upgraded away; a live run restarts the ones it may, so they are not an error.
3. Run the live `bun src/cli.ts host --apply` only after the user says yes.
4. Scheduling is optional and needs root. `bun src/cli.ts host --launchd-plist --label <label> --user <user> --at <HH:MM> --config <config> --bun <path> > <label>.plist` prints the plist. Use a stable bun path such as `/opt/homebrew/bin/bun`, never one inside a Homebrew `Cellar`. The plist runs oUpdate from this checkout's path. Show the user the install commands from the README's [Schedule it](README.md#schedule-it), and get their approval before running anything as root. If they already have an update job, ask before disabling it.

**One-off review, PR gate or hardening check.** Run the command from the README section of the same name with the reviewer spec above.

### Rules

- Dry run first, then the live run only with the user's yes.
- Never store secrets in a file you create. Point to them through environment variables (`apiKeyEnv`, or `${NAME}` in a value of the host config, a targets file or the eval config; an unset or empty variable stops the run with its name) or a token file the user makes.
- Don't edit oUpdate's source, or switch off a layer, to make a run pass. A hold is the tool working. Show it to the user.

## Working on this repository

- Tests: `bun test`. Types: `bunx tsc --noEmit`. Before a commit: `bun scripts/oss-scan.ts` (no home paths, private hostnames, IPs or secrets in tracked files).
- `acceptance/run.ts` runs the attack and clean-release cases; see [docs/evaluation-2026-10-26.md](docs/evaluation-2026-10-26.md).
- Nothing downloaded during a review is installed, imported or run. Keep it that way.
