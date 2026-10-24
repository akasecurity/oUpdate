# oupdate

A dependency and advisory sweep: it inventories packages across repos and hosts, matches them against advisory feeds, holds routine updates for a cooldown, reads each update's release-artifact diff with a deterministic pre-pass and a model reviewer, and hands the change to your own gate. Early release: the interfaces may still change.

## Install

oupdate is a Bun and TypeScript tool. It needs [Bun](https://bun.sh); there is no build step.

```
git clone https://github.com/akasecurity/oupdate.git   # placeholder URL; replace with the real repository
cd oupdate
bun install
bun src/cli.ts review npm some-pkg 1.0.0 1.0.1
```

`bin` in `package.json` maps `oupdate` to `src/cli.ts`, so `bun link` gives you an `oupdate` command.

## Configuration

Most commands take their settings as flags (`--reviewer`, `--scanner`, `--token-file`). The host commands read a JSON config from `$HOME/.config/oupdate/config.json` or the file you pass with `--config`; the `apply` object is described under [Host apply](#host-apply). `${NAME}` in any config value is read from the environment. `scripts/sample.config.example.json` is a minimal config with one local OpenAI-compatible reviewer and placeholders only.

## Gate update PRs on a forge

Run after your update bot (Renovate, for example): for each open PR on a `renovate/` branch, oupdate diffs `bun.lock` between base and head and reviews every package version the PR brings in. It then posts a commit status `oupdate/review` and one comment carrying the per-layer verdicts.

```
oupdate gate --endpoint https://forge.example/api/v1 --repo owner/name \
  --token-file ~/.config/oupdate/forge-token \
  --reviewer '{"type":"openai","name":"local","baseUrls":["http://127.0.0.1:8080/v1"],"model":"your-model"}'
```

- **success:** every change lands.
- **failure:** a layer other than cooldown stopped one.
- **pending:** only cooldown or layer errors held it; the next run reviews it again.

The advisory layer splits OSV entries in two:
- **Malicious** (an OpenSSF `MAL-` id or alias) always stops the update. The comment opens with a MALICIOUS line, because the useful next step is checking where that version is already installed.
- **Vulnerabilities** stop only the ones this update introduces. If the old version already had one, keeping the old version would not help, so it is listed as "already in" and does not stop the update. Vulnerabilities the update removes are listed as "fixes".

Heads that already have success or failure are skipped. Gitea and API-compatible forges are supported.

## GuardDog layer

Between the pre-pass and the reviewer, a static rule scanner can run on both releases: `--scanner JSON` on `review` and `gate`. It sees only the files the new release adds or changes, plus the old copies of the changed files. Only rule + path pairs that are new in the new release count.

Why changed files only: GuardDog 3.2.0 stops each rule after its `max_hits` (1 to 3) matches per package, in sorted walk order. Unchanged code that sorts first can use up a rule's budget and hide a new file: litellm 1.107.0's payload under `litellm-1.107.0.data/purelib/` raised nothing beside the 3,773-file `litellm/` directory. The budget still applies inside the changed set, so a large release can still hide a match behind another changed file. They reach the reviewer as soft signals and mark their files as priority files. With no scanner the layer is skipped; a scanner that fails, times out or reports a rule error holds the update.

oupdate writes the files it already unpacked into a fresh directory (dirs 0755, files 0644, every path checked) and passes the directory, not the archive, so GuardDog's own extraction never runs on untrusted input. The command is an argv with `{eco}` and `{dir}` placeholders, run with no shell. Run it in the sandbox image from `sandbox/guarddog/` (hash-locked wheels, non-root user):

```
oupdate review npm some-pkg 1.0.0 1.0.1 --scanner '{"type":"guarddog","name":"guarddog",
  "workRoot":"<dir under $HOME>","stripPrefix":"/scan","timeoutMs":600000,
  "argv":["docker","run","--rm","--network","none","--read-only","--tmpfs","/tmp:rw,size=256m",
    "--cap-drop","ALL","--security-opt","no-new-privileges","--memory","2g","--pids-limit","256",
    "-v","{dir}:/scan:ro","oupdate-guarddog:local","{eco}","scan","/scan","--output-format","json"]}'
```

- `--network none`: GuardDog tries to refresh its popular-package lists and logs a network error. The rules still run.
- `workRoot` goes under `$HOME`, because a colima or Docker Desktop VM mounts only the home directory.
- Build the image with `docker build -t oupdate-guarddog:local sandbox/guarddog`. To refresh the lock, run `sandbox/guarddog/lock.sh`; it only takes wheels at least 7 days old.


### Review budget

The local reviewer reads the release diff in parts, at most 12. When the whole diff is over that, it reads the priority files only: files with a pre-pass or scanner signal, new files, manifests and install or startup files. When those are still over it, it reads the signal files only: files with a signal, manifests and install or startup files. A FLAG on the signal files stops the update. An APPROVE there does not land it, because the rest of the diff was not read: the update stays held for a human, and the verdict names how many files were left out.

## Client keys

`oupdate keys [DIR] [--cooldown-days N] [--json]` checks the install-time hardening the package managers already ship, in a repo's own config. It finds the managers from their lockfiles and only reads; it never edits a file. Exit 1 when a key is missing or too weak.

| manager | file | key | want |
|---|---|---|---|
| npm | `.npmrc` | `ignore-scripts` | `true` |
| npm | `.npmrc` | `allow-git` | `none` |
| npm | `.npmrc` | `min-release-age` | at least the cooldown, in days |
| pnpm | `pnpm-workspace.yaml` (or `.npmrc` kebab-case) | `strictDepBuilds` | `true` |
| pnpm | same | `minimumReleaseAge` | at least the cooldown, in minutes |
| bun | `bunfig.toml` `[install]` | `minimumReleaseAge` | at least the cooldown, in seconds |
| uv | `uv.toml` or `pyproject.toml` `[tool.uv]` | `exclude-newer` | a rolling duration (`"7 days"`, `P7D`); a fixed date is weak |

The build-script allow-lists are listed, not judged: pnpm `allowBuilds` (or the older `onlyBuiltDependencies`) and bun `trustedDependencies` (bun runs no other dependency's lifecycle scripts). Build-script denial stops the install-script attacks; it does not stop a payload that runs at import or at Python start, which is what the review layers are for. None of these keys lifts the cooldown for an advisory fix: `oupdate review --advisory-fix` does that.

## Host shadow report

`oupdate host --report-only --state DIR [--host NAME] [--prev-log PATH]` reads the installed inventory of this host (Homebrew formulae and casks, global npm packages, Docker images, macOS and its pending updates, agent CLI versions). It runs read-only commands only, with `HOMEBREW_NO_AUTO_UPDATE=1`, and never updates or installs anything. Advisories for the npm globals come from OSV; a failed lookup is a note in the report, never "no advisories".

It compares the run against the last summary block of the previous updater's run log (its log: `--prev-log`):
- what changed since the previous snapshot, against the previous updater's `upgraded:` and `casks upgraded:` names (a brew `node` upgrade covers a changed `npm` global, since the node bottle ships its own npm);
- what is still outdated, against what the previous updater held: flagged (a Type B FLAG in the run body counts too), stuck, failed, skipped by CASK_EXCLUDE, or listed in a repo's `pins.json` (the previous updater's `PINNED:` part). A brew-pinned package counts as held. An npm batch the previous updater FLAGGED (its summary names no packages) holds every outdated npm global.

It writes `DIR/inventory.json` (the snapshot for the next run) and `DIR/reports/<date>.json`, then prints a summary with the number of weeks in a row in which every report agreed. Run it once the previous updater finishes, so a release published later that day doesn't show up as a disagreement.

## Host apply

`oupdate host --apply` applies this host's Homebrew formula, cask and npm global updates, with the guards of the updater it replaces. Run `--dry-run` first: it runs every check and changes nothing on disk. It skips `brew update` and the HEAD fetch, upgrades, restarts, cleanup, the waiter and state writes, and it logs notices without sending them.

### Quick start

1. Write the `apply` object in `$HOME/.config/oupdate/config.json` (or pass `--config FILE`). Paths must be absolute; an unknown key is an error. `{date}` in `logFile` is the run's local date as YYYYMMDD, so each day gets its own file. Give `brew` and `npm` as absolute paths when launchd runs it: a LaunchDaemon's PATH has no Homebrew directory. `claudeCode` is the absolute path of the native Claude Code binary (the install's `.local/bin/claude` in the user's home); leave it out on a host without one. `notify` is a command that gets each notice as its last argument; `[]` means log-only by choice (see below). `postUpgradeCheck` (optional, off by default) maps a package name to an argv, e.g. `{"git": ["git", "--version"]}`: after the run, each package upgraded in it (brew or npm; a tap-qualified brew name matches on its last segment) gets its command run once, and a non-zero exit or a timeout is logged (`post-upgrade check: <name> FAILED (rc=N)`), notified, counted as `FAILED: check:<name>` in the brew line (so the run exits 1) and never aborts the run. A dry run runs no check.

   ```json
   {
     "apply": {
       "stateDir": "/var/lib/oupdate",
       "logFile": "/var/log/oupdate/{date}.log",
       "brew": "/opt/homebrew/bin/brew",
       "npm": "/opt/homebrew/bin/npm",
       "claudeCode": "/opt/example/bin/claude",
       "typeBTaps": ["example/tool"],
       "approvedTapsFile": "/etc/oupdate/approved-taps.tsv",
       "pinRoots": ["/srv/repos"],
       "caskExclude": ["some-huge-suite"],
       "reviewer": { "type": "openai", "name": "local", "baseUrls": ["http://127.0.0.1:8080/v1"], "model": "your-model" },
       "notify": ["/usr/local/bin/your-notice-command"],
       "labelRestart": { "org.example.quiet-daemon": ["/usr/local/sbin/restart-when-quiet", "--wait"], "org.example.manual": "skip" }
     }
   }
   ```

2. `oupdate host --apply --dry-run` prints the run and a dry-run summary. Read the tier split, the holds and the notices it would have sent. It writes `dry-run-<log file name>` beside the log, never the dated log itself, and its header and summary are named so that nothing reading a log takes a dry run for a run.
3. `oupdate host --apply` is the live run. The exit code is 1 when anything failed.
4. Schedule it with launchd or cron. See [Schedule it](#schedule-it).

Every line goes to the log file and stdout as it is made. A run stopped by SIGTERM or SIGINT (or SIGHUP, when started from a terminal), or one that crashes, ends with an `=== ABORTED: ...` line: the commands it was running are stopped (SIGTERM, then SIGKILL), nothing new starts (no command, no reviewer command, no idle waiter, no delayed restart), nothing more is logged, no done notice is sent, and the exit code is the signal's (143, 130, 129). A dry run or a Gatekeeper one-off stopped that way ends with `=== STOPPED: ...` instead, in its own log file. Without a terminal (launchd, `nohup`), SIGHUP is left alone, so `nohup` keeps a logout from stopping the run. A finished run ends with the summary block the host shadow report already reads, then a done notice:

```
=== <host> summary ===
  brew: upgraded: ...; casks upgraded: ...; PINNED: ...; STUCK: ...
  npm:  upgraded: ...; claude-code: 2.1.309
  mas:  not checked — the App Store phase is not in oupdate
```

`mas` reads "not checked" on every run by design: the App Store phase is not in oupdate, and the words are not ones the digest counts as trouble. `claude-code` is the version after the update, `FAILED (rc=<rc>, on <version>)` or `FAILED (timeout, on <version>)` when the update failed (`unknown` when `--version` fails too), `not configured` without `claudeCode`, and `dry-run` in a dry run. A `claudeCode` path that is not executable is skipped with no `claude-code` part, as the previous updater did.

### Schedule it

`oupdate host --launchd-plist` prints a LaunchDaemon plist that runs `oupdate host --apply` every day at one time. It writes nothing; you install it as root.

```
oupdate host --launchd-plist --label org.example.oupdate-apply --user USER --at 03:30 \
  [--config FILE] [--bun PATH] [--app DIR] [--home DIR] [--stdout FILE] [--path DIR]... > org.example.oupdate-apply.plist
```

- The label takes letters, digits, `.` and `-` only; it becomes the plist's file name.
- The job runs as `--user` with group `staff`, at `--at` (HH:MM, 00:00 to 23:59), and not at load. It has no KeepAlive and no AbandonProcessGroup: the idle waiter detaches itself.
- It runs `<bun> <app>/src/cli.ts host --apply`, plus `--config FILE` when given. `--bun` defaults to the `bun` found on PATH, as found (not resolved), and `--app` to this tree. Every path must be absolute. A bun in a temp dir (`/tmp`, `/private/tmp`, `/var/folders`) or in a `bun-node-` directory (the node shim `bun run --bun` puts first on PATH) is refused, given or found: it is gone at reboot or the next upgrade. A found bun under your home is refused when `--user` is someone else, who may not be able to reach it; pass `--bun` then. A bun inside a Homebrew `Cellar` keg is refused, given or found: the first run that upgrades bun ends with `brew cleanup`, which deletes that keg, and launchd then cannot start the job. Use the stable link, e.g. `/opt/homebrew/bin/bun`.
- `HOME` is `--home`. It can be left out only when `--user` is the user running the command.
- `PATH` is bun's directory, then the directories of the config's absolute `brew` and `npm`, then each `--path DIR`, then `/usr/bin:/bin:/usr/sbin:/sbin`. Homebrew's own directory is not on it unless the config puts it there, so give `brew` and `npm` as absolute paths in the config: a bare `brew` (the default) is not found under launchd. npm is a `#!/usr/bin/env node` script, so `node` must be on that PATH: Homebrew's npm and node share a directory, which the config's `npm` adds. Without `--config`, or with a bare `npm` in it, pass `--path` with node's directory.
- With `--config`, the config is read even when `--stdout` is given, for the brew and npm directories. To skip it, leave out `--config` and give those directories with `--path`; the job then reads the default config.
- launchd's stdout and stderr go to `--stdout`. It defaults to `launchd-oupdate.log` beside the config's `apply.logFile`. A name that starts with `2` is refused, because the digest reads the newest `2*.log` as the run log.
- If the host shadow report's trigger (`scripts/host-shadow-trigger.sh`) watches the old job's stdout log (the shadow's `--prev-log`), pass that file as `--stdout`, so the trigger still fires. Or retire the shadow on that host: after the switch it compares oupdate with itself.

Pick the time the old updater ran. launchd does not create the stdout file's directory, so make it first, owned by the job's user. Then, as root, disable the old job and install the new one:

```
mkdir -p /var/log/oupdate && chown USER:staff /var/log/oupdate
cp org.example.oupdate-apply.plist /Library/LaunchDaemons/org.example.oupdate-apply.plist
chown root:wheel /Library/LaunchDaemons/org.example.oupdate-apply.plist
chmod 644 /Library/LaunchDaemons/org.example.oupdate-apply.plist
plutil -lint /Library/LaunchDaemons/org.example.oupdate-apply.plist
launchctl disable system/org.example.old-updater
launchctl bootout system/org.example.old-updater
launchctl bootstrap system /Library/LaunchDaemons/org.example.oupdate-apply.plist
launchctl print system/org.example.oupdate-apply
```

These steps assume the old job is a LaunchDaemon (`system/`). If it is a LaunchAgent, use `gui/<uid>/<old label>` for its `disable`, `bootout` and `enable`, and `launchctl bootstrap gui/<uid> <its plist>` in the revert.

`disable` keeps the old job off across reboots; its plist stays where it is, for the revert. To install a changed plist later, run `launchctl bootout system/org.example.oupdate-apply` before the copy: bootstrapping a label that is already loaded fails with `5: Input/output error`.

To revert, as root:

```
launchctl bootout system/org.example.oupdate-apply
rm /Library/LaunchDaemons/org.example.oupdate-apply.plist
launchctl enable system/org.example.old-updater
launchctl bootstrap system /Library/LaunchDaemons/org.example.old-updater.plist
```

### What it does

1. **Waiter report.** A deferred service's waiter recovers a drain a dead waiter left behind, then shows its last outcome.
2. **brew.** Sync the taps, then list outdated formulae (HEAD installs included) and casks (auto-updating ones included). Then:
   - Drop the excluded casks, and hold pinned tools: a `brew pin`, or a name in a repo's `pins.json` one level under `pinRoots`.
   - Split the rest by tap:
     - **Type A**: the official taps. A deterministic version policy holds a major increase of a sensitive package.
     - **Type B**: `typeBTaps` plus this host's rows in the approved-taps file. Each package gets its own review before it installs.
     - **Unknown taps**: an advisory review only. One notice asks for the tap's approval; nothing installs.
   - Upgrade what passed, one package at a time. Relink, then restart each upgraded service, except a deferred one: that goes to its idle waiter.
3. **Deferred casks.** One at a time, with Gatekeeper around each upgrade: snapshot before, then release and check after.
4. **Stale keg and linkage.** Restart services still running from a deleted keg, and report broken library links. Every stale process is looked at, not one per package. This oupdate run and the processes that started it are never restarted; they move to the new keg with the next run. A process launchd started (parent pid 1) is looked up in launchd by its pid: `launchctl print system` for a daemon (restarted with `sudo -n launchctl kickstart -k system/<label>`), then `launchctl print gui/<uid>` for your own agent (restarted in `gui/<uid>/`). So a job whose label never names the package, such as an agent running a Homebrew `bun`, is still found. Only when launchd has no row for such a pid is the label taken from a plist name containing the package, narrowed by the process name, once per package; the restart helper is used only for such a name-matched label, since it restarts a package's own service. More than one label for a pid, an unmatched label or an ambiguous plist match is named for you, never guessed. A process launchd did not start (a shell's `bun`, say) is never restarted, not by its pid and not by a plist name: if its direct parent is a launchd job's own process (say a plist whose shell does not `exec`), the package is named for an operator as `<pkg>(child of <label>)`, noticed and counted toward stuck, and never restarted through that chain; when that job was already restarted or handed to its owner this run, the child carries that outcome instead. Any other process (an interactive one, or one deeper under a job, such as a shell in a session under a daemon) is left alone and not counted on the re-scan; a job further up its chain is only logged. A label is restarted once per run; every package stale under it is accounted for by that one outcome. `labelRestart` overrides the restart of a label, matched literally, on either path: `"skip"` leaves it to the job's owner (the STALE KEG note says so), `"kickstart"` restarts it as usual, and a command (its first entry an absolute path) is started detached with the label as its last argument and not waited for; the note reads `STALE KEG: <pkg> handed to <command> (<label>)` until a run finds the package gone (a re-scan that already finds it gone says only `restarted onto new keg`). The same `labelRestart` applies when step 2 restarts the service of a package it just upgraded, before the restart helper and kickstart, for a label whose plist exists. An owner command is started at most once per run: a label step 2 handed over is not handed again by this step. Write owner commands to be single-instance anyway (take a lock, exit when another one runs). `staleKegUnlisted` says what this step does with a label not in `labelRestart`: `"kickstart"` (the default) restarts it as above; `"report"` makes `labelRestart` an allow list, so such a label is never restarted (no helper, no kickstart), its packages read `<pkg>(reported only, not on the restart list)` in the STALE KEG note and count toward stuck. List a label as `"kickstart"` to restart it then; a `"kickstart"` label found only by plist name goes through the restart helper by package when the helper lists that package. Report mode does not cover deferred services: they still go to their idle waiter. Step 2 obeys it too: in report mode a label with a plist that is not in `labelRestart` is not restarted there (no helper, no kickstart) and reads `<pkg>(reported only, not on the restart list)` in the restarted list. A failed or timed-out launchctl query (`print gui/<uid>` fails with no GUI session) is logged and falls back to the plist name. The log says which way each label was found. A dry run runs these queries and only says what it would kickstart, hand over, leave or report. A deferred service on a deleted keg is handed to its idle waiter unless its `--holder` probe answers 0, the waiter's sign that one is already running. Any other answer hands off; a timed-out probe is named in the note. Your waiter must take its own exclusive lock and exit when another one is live. During a stop, nothing is handed off.
5. **Stuck.** Count what is still pending, run after run. Pinned and excluded packages never count.
6. **npm globals.** One review of the batch, with literal attack indicators forced to FLAG. Then upgrade each package by name.
7. **Claude Code (native).** In the npm phase, after npm: `<claudeCode> update` (its output indented in the log), then `<claudeCode> --version` for the version the summary reports. The native build updates itself in place; with its background updater off, this call is the only update path. A dry run logs `DRY RUN - would run: claude update` and runs neither command; during a stop neither starts. A timed-out update is also a `FAILED — timeout:claude-update` entry on the npm line.

Fail closed: a failed query is a FAILED entry in the summary, never "nothing to update". An unreadable state file is reported and kept. With no reviewer configured, everything that needs a review is held. A command that runs past `timeoutMs` is killed with its whole process group. It becomes a FAILED entry: the package, for an upgrade, else `timeout:<command>`. The run goes on to the next step, and what the stopped step already upgraded is still reported, relinked, restarted and cleaned up. With no `notify` key, notices are only logged, and the brew line ends with `notify: not configured`. `"notify": []` makes the run log-only by choice: notices are still logged as `[notify] ...`, nothing is sent, and the brew line has no such note.

Gatekeeper one-offs, with no review and no upgrade:
- `oupdate host --gatekeeper-approve CASK` releases a cask nobody ever approved. The same three gates apply: one Team ID, the pinned team, and notarization.
- `oupdate host --gatekeeper-revert CASK` puts back every quarantine value a release removed.

Not in this version, and held or reported rather than skipped: the review of a HEAD install, the source-diff review of a source-built Type B package, and the App Store.

The Gatekeeper one-offs exit 1 when nothing was released or restored. They log to `gatekeeper-<log file name>`, never the dated log.

## Development

```
bun run test
bun run typecheck
bun run scan
```

`bun run scan` (`scripts/scan.ts`) checks tracked files for home paths, tailnet names, private IPs, non-reserved emails and secrets. `scripts/oss-scan.ts` adds hostname and secret rules. Set `OUPDATE_SCAN_DENY` to a file outside the repo (one word per line) for your own deny list.

## Evaluation

`acceptance/` holds the attack and control cases. `cases.json` lists 9 attack cases, `controls.json` 8 clean updates that must land. `acceptance/run.ts` runs the cases through the review layers with the reviewers you give it, and it fetches the malicious-package samples from the public DataDog malicious-software-packages dataset on GitHub, and `acceptance/extract.ts` unpacks them. The litellm 1.107.0 case needs a replay script that this repository does not ship, so a run counts it as not run. Results go to `./acceptance-results/`.

`scripts/eval.ts` runs the whole set plus the repo scan. Copy `scripts/eval.config.example.json`, point `sampleConfig` at a copy of `scripts/sample.config.example.json`, then:

```
OUPDATE_EVAL_BASE_URL=http://127.0.0.1:8080/v1 OUPDATE_EVAL_MODEL=<model> bun scripts/eval.ts --only 6
```

## License

MIT. See [LICENSE](LICENSE).
