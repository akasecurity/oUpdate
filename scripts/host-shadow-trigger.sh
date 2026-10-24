#!/bin/bash
# launchd WatchPaths trigger for `oupdate host --report-only`: fires on every write
# to the secure-update log and runs one shadow report once today's secure-update run
# on this host has printed its "secure-update done" line. At most one report a day.
# Env: OUPDATE_APP (the oupdate tree), OUPDATE_STATE, OUPDATE_SU_LOG, OUPDATE_HOST.
set -u
export PATH=/opt/homebrew/bin:/usr/local/bin:$HOME/.bun/bin:/usr/bin:/bin HOMEBREW_NO_AUTO_UPDATE=1
APP=${OUPDATE_APP:?OUPDATE_APP not set}
STATE=${OUPDATE_STATE:-$HOME/.oupdate/host}
LOG=${OUPDATE_SU_LOG:-$HOME/Library/Logs/secure-update/launchagent.log}
HOST=${OUPDATE_HOST:-$(hostname -s)}
today=$(date +%F)
[ -f "$STATE/reports/$today.json" ] && exit 0
[ -f "$LOG" ] || exit 0
# The last run header for this host must be today's, with its done line after it.
tail -n 5000 "$LOG" | awk -v h="$HOST" -v d="$today" '
  $0 ~ "^=== ([a-z]+-)?secure-update " h " " { run = ($4 == d); done = 0; next }
  run && $0 ~ h " secure-update done" { done = 1 }
  END { exit !(run && done) }' || exit 0
mkdir -p "$STATE"
mkdir "$STATE/.lock" 2>/dev/null || exit 0
trap 'rmdir "$STATE/.lock"' EXIT
{
  echo "=== oupdate host $HOST $(date '+%F %H:%M')"
  bun "$APP/src/cli.ts" host --report-only --host "$HOST" --state "$STATE" --su-log "$LOG"
  echo "rc=$?"
} >> "$STATE/shadow.log" 2>&1
