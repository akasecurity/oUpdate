#!/usr/bin/env bun
// Public export: builds the open-source tree from this repo's HEAD as one fresh commit.
// Scope: every tracked file except replay/ (deployment replays), plus LICENSE (MIT), the
// public README sections and the package.json / tsconfig.json edits below. It runs
// scripts/oss-scan.ts over the result before committing and fails on any finding.
// Commit dates come from the source HEAD, so the same source gives the same export commit.
//
// usage: bun scripts/export-public.ts <target-dir>
// The target must be missing, empty, or an earlier export (an oupdate package whose only commits
// are by 222731067+alsoknownaswill@users.noreply.github.com); its content is replaced. Nothing is pushed.

import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const AUTHOR = { name: "Will Lin", email: "222731067+alsoknownaswill@users.noreply.github.com" };
const SRC = resolve(dirname(import.meta.path), "..");

function run(cwd: string, argv: string[], env: Record<string, string> = {}): string {
  const p = Bun.spawnSync(argv, { cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`${argv.join(" ")} failed (${p.exitCode}): ${p.stderr.toString().trim()}`);
  return p.stdout.toString();
}

// Exact replacements on the source README: [from, to]. Each must match once, so a README
// edit that breaks a rule fails the export instead of silently publishing the private text.
const README_EDITS: [string, string][] = [
  [
    "Work in progress; the quickstart comes with the CLI.\n",
    `Early release, built from tools that run in production; the interfaces may still change. The easiest way to install it is to ask your coding agent to set it up; see [Set up with your agent](#set-up-with-your-agent).

## Install

oUpdate is a Bun and TypeScript tool. It needs [Bun](https://bun.sh); there is no build step.

Install a release tag, not the tip of \`main\`, and check that the commit matches the one on the [release page](https://github.com/akasecurity/oupdate/releases):

\`\`\`
git clone --branch v0.2.1 https://github.com/akasecurity/oupdate.git
cd oupdate
git rev-parse HEAD
bun install
bun src/cli.ts review npm ms 2.1.2 2.1.3
\`\`\`

\`bin\` in \`package.json\` maps \`oupdate\` to \`src/cli.ts\`, so \`bun link\` gives you an \`oupdate\` command.

### Before you run it

oUpdate becomes part of your supply chain, so read it before you trust it:
- It has no runtime dependencies. \`bun.lock\` holds only the dev tools (TypeScript and Bun's types).
- \`review\` and \`gate\` download release archives from the registry and read them; they never install a package or run its code (archives are read with \`bsdtar\`; the optional GuardDog layer runs in the container you give it). The network calls go to the package registries, OSV, your reviewer endpoint and, for \`gate\`, your forge.
- \`image\` reads two images' manifests and config blobs from their container registry; it never pulls a layer or runs the image.
- Nothing runs as root unless you schedule \`host --apply\` as a LaunchDaemon yourself. Start with \`host --apply --dry-run\`: it runs every check and changes nothing on disk.

### Set up with your agent

Paste this into your coding agent:

\`\`\`
Set up oUpdate (https://github.com/akasecurity/oupdate) on this machine for me. Clone it, read its AGENTS.md and follow it step by step. Ask me before anything that changes my system.
\`\`\`

[AGENTS.md](AGENTS.md) gives the agent the order to work in:
- what you want oUpdate for;
- prerequisites, then the install;
- a local or hosted reviewer model, checked on a known-clean update;
- a dry run before any live run;
- scheduling only with your approval.

## Configuration

Most commands take their settings as flags (\`--reviewer\`, \`--scanner\`, \`--token-file\`). The host commands read a JSON config from \`$HOME/.config/oupdate/config.json\` or the file you pass with \`--config\`; the \`apply\` object is described under [Host apply](#host-apply). \`\${NAME}\` in any config value is read from the environment. \`scripts/sample.config.example.json\` is a minimal config with one local OpenAI-compatible reviewer and placeholders only.
`,
  ],
  [
    "the last summary block of the previous updater's log:",
    "the last summary block of the previous updater's run log (its log: `--prev-log`):",
  ],
  [
    /## Ported test specs[\s\S]*?(?=## Gates)/.source,
    "",
  ],
  ["## Gates\n", "## Development\n"],
  ["OUPDATE_SCAN_DENY=<file outside the repo> bun run scan\n```\n", "bun run scan\n```\n\n`bun run scan` (`scripts/scan.ts`) checks tracked files for home paths, tailnet names, private IPs, non-reserved emails and secrets. `scripts/oss-scan.ts` adds hostname and secret rules. Set `OUPDATE_SCAN_DENY` to a file outside the repo (one word per line) for your own deny list.\n"],
  ["## Eval check 6\n", "## Evaluation\n"],
  [
    "`scripts/eval.ts` check 6 runs `oss-scan` over the tracked files and checks 1 and 2 on a clean sample config. `scripts/sample.config.example.json` is that config: one local OpenAI-compatible reviewer, placeholders only. `${NAME}` in any config value is read from the environment. Point `sampleConfig` in your eval config (see `scripts/eval.config.example.json`) at a copy, then:",
    "`acceptance/` holds the attack and control cases. `cases.json` lists 9 attack cases from real releases and 4 synthetic evasion cases, which `acceptance/synthetic/generate.ts` builds in memory with payload URLs on `.invalid` hosts only; `controls.json` lists 8 clean updates that must land. That is the core set, the one the published bar is scored on. Both files also hold an extended set, marked `\"set\": \"extended\"`: 17 more compromised releases and a clean control for each. `acceptance/run.ts --set extended` (or `--set all`) runs it and scores it against its own counts, with no published bar. `acceptance/run.ts` runs the cases through the review layers with the reviewers you give it, and it fetches the malicious-package samples from the public DataDog malicious-software-packages dataset on GitHub, and `acceptance/extract.ts` unpacks them. The litellm 1.107.0 case needs a replay script that this repository does not ship, so a run counts it as not run. Results go to `./acceptance-results/`.\n\n`scripts/eval.ts` runs the whole set plus the repo scan. Copy `scripts/eval.config.example.json`, point `sampleConfig` at a copy of `scripts/sample.config.example.json`, then:",
  ],
  [/## Publish checklist[\s\S]*$/.source, "## License\n\nMIT. See [LICENSE](LICENSE).\n"],
];
// Entries built from a regex source (the section removals) are applied as regexes.
const REGEX_EDITS = new Set([README_EDITS[2]![0], README_EDITS[README_EDITS.length - 1]![0]]);

export function publicReadme(src: string): string {
  let out = src;
  for (const [from, to] of README_EDITS) {
    if (REGEX_EDITS.has(from)) {
      const re = new RegExp(from);
      if (!re.test(out)) throw new Error(`README rule did not match: ${from.slice(0, 40)}`);
      out = out.replace(re, to);
    } else {
      if (out.split(from).length !== 2) throw new Error(`README rule must match once: ${from.slice(0, 40)}`);
      out = out.replace(from, () => to);
    }
  }
  return out;
}

const LICENSE = `MIT License

Copyright (c) 2026 oUpdate contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;

function replaceOnce(text: string, from: string, to: string, what: string): string {
  if (text.split(from).length !== 2) throw new Error(`${what}: pattern must match once`);
  return text.replace(from, () => to);
}

function checkTarget(target: string): void {
  if (target === SRC || target.startsWith(SRC + "/") || SRC.startsWith(target + "/")) throw new Error("target overlaps the source repo");
  if (!existsSync(target) || readdirSync(target).length === 0) return;
  const pkg = join(target, "package.json");
  if (!existsSync(pkg) || JSON.parse(readFileSync(pkg, "utf8")).name !== "oupdate") throw new Error("target is not empty and not an oupdate export");
  const emails = run(target, ["git", "log", "--format=%ae"]).split("\n").filter(Boolean);
  if (emails.length === 0 || emails.some((e) => e !== AUTHOR.email)) throw new Error("target has commits that are not an earlier export");
}

// Every commit in `range` (e.g. origin/main..HEAD) must have the noreply address as author and committer.
export function badCommitEmails(repo: string, range: string): string[] {
  const rows = run(repo, ["git", "log", "--format=%h %ae %ce", range]).split("\n").filter(Boolean);
  return rows.filter((r) => r.split(" ").slice(1).some((e) => e !== AUTHOR.email));
}

if (import.meta.main && process.argv[2] === "--check-push") {
  const [repo, range] = [process.argv[3], process.argv[4]];
  if (!repo || !range) throw new Error("usage: bun scripts/export-public.ts --check-push <repo> <range>");
  const bad = badCommitEmails(repo, range);
  if (bad.length) throw new Error(`commits with a non-noreply author or committer email:\n${bad.join("\n")}`);
  console.log("commit metadata ok");
} else if (import.meta.main) {
  const arg = process.argv[2];
  if (!arg) throw new Error("usage: bun scripts/export-public.ts <target-dir>");
  mkdirSync(arg, { recursive: true });
  const target = realpathSync(arg);
  checkTarget(target);
  for (const e of readdirSync(target)) rmSync(join(target, e), { recursive: true, force: true });

  const date = run(SRC, ["git", "log", "-1", "--format=%cI", "HEAD"]).trim();
  const tar = join(target, ".export.tar");
  run(SRC, ["git", "archive", "--format=tar", "-o", tar, "HEAD"]);
  run(target, ["tar", "-xf", tar]);
  rmSync(tar);
  rmSync(join(target, "replay"), { recursive: true, force: true });

  const pj = join(target, "package.json");
  writeFileSync(pj, replaceOnce(readFileSync(pj, "utf8"), '  "private": true,\n', '  "private": true,\n  "license": "MIT",\n', "package.json"));
  const ts = join(target, "tsconfig.json");
  writeFileSync(ts, replaceOnce(readFileSync(ts, "utf8"), '"scripts", "replay", "acceptance"', '"scripts", "acceptance"', "tsconfig.json"));
  const rd = join(target, "README.md");
  writeFileSync(rd, publicReadme(readFileSync(rd, "utf8")));
  writeFileSync(join(target, "LICENSE"), LICENSE);

  const env = { GIT_AUTHOR_NAME: AUTHOR.name, GIT_AUTHOR_EMAIL: AUTHOR.email, GIT_COMMITTER_NAME: AUTHOR.name, GIT_COMMITTER_EMAIL: AUTHOR.email, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
  run(target, ["git", "init", "-q", "-b", "main"]);
  run(target, ["git", "add", "-A"]);
  const scan = Bun.spawnSync(["bun", "scripts/oss-scan.ts"], { cwd: target, stdout: "pipe", stderr: "pipe" });
  if (scan.exitCode !== 0) throw new Error(`oss-scan found problems in the export:\n${scan.stdout.toString()}${scan.stderr.toString()}`);
  run(target, ["git", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "chore: initial public release"], env);
  console.log(`exported ${run(SRC, ["git", "rev-parse", "--short", "HEAD"]).trim()} -> ${target} @ ${run(target, ["git", "rev-parse", "--short", "HEAD"]).trim()}`);
}
