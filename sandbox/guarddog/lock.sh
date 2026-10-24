#!/bin/bash
# Regenerate requirements.lock (hash-pinned wheels, none newer than 7 days) for the GuardDog sandbox image.
# Run where docker is. (uv -q with -o - prints nothing, so it writes a file and cats it.) Extra requirements (e.g. semgrep==X) come from requirements.in next to this file.
set -euo pipefail
export PATH=/opt/homebrew/bin:$PATH
cd "$(dirname "$0")"
BASE=$(sed -nE 's/^FROM (python@sha256:[0-9a-f]+).*/\1/p' Dockerfile)
CUTOFF=$(date -u -v-7d +%Y-%m-%dT00:00:00Z 2>/dev/null || date -u -d '7 days ago' +%Y-%m-%dT00:00:00Z)
docker run --rm -i -e CUTOFF="$CUTOFF" "$BASE" sh -c 'pip install -q uv==0.9.5 >/dev/null 2>&1; cat > r.in; uv pip compile -q -o /tmp/r.lock --generate-hashes --only-binary :all: --exclude-newer "$CUTOFF" --no-header --no-annotate --python-platform aarch64-unknown-linux-gnu r.in >&2 && cat /tmp/r.lock' < requirements.in > requirements.lock
echo "cutoff $CUTOFF"; grep -cE '^[a-z]' requirements.lock
