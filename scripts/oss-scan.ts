#!/usr/bin/env bun
// Open-source scan (eval check 6): fails on host names, host names used as
// values, Gitea/NAS addresses, secrets and personal emails in git-tracked files.
// It builds on scripts/scan.ts (home paths, tailnet names, private IPs, non-reserved
// emails, deny list) and adds hostname and secret rules. A floor of known patterns,
// not proof. Exit 0 only with no findings.
//
// usage: bun scripts/oss-scan.ts [--json]
// Env: OUPDATE_SCAN_DENY (file outside the repo, one word per line), as for scan.ts.
//      OUPDATE_SCAN_HOSTS (comma list) replaces the default host names.

import { existsSync, readFileSync } from "node:fs";
import { scanText, type Finding } from "./scan.ts";

// The scanner and its test hold the patterns and sample hits, so they are not scanned.
const SELF = new Set(["scripts/oss-scan.ts", "test/oss-scan.test.ts"]);
const HOSTS = (process.env.OUPDATE_SCAN_HOSTS ?? "host-a,host-b").split(",").map((s) => s.trim()).filter(Boolean);
const H = `(?:${HOSTS.join("|")})`;

const RULES: { rule: string; re: RegExp }[] = [
  // Hostnames
  { rule: "tailnet-domain", re: /\.ts\.net\b/i },
  { rule: "host-fqdn", re: new RegExp(`\\b${H}\\.(?:local|lan|home|internal|ts\\.net)\\b`, "i") },
  { rule: "host-value", re: new RegExp(`(?:--host[ =]|\\bssh(?: -\\w+)* (?:\\w+@)?|\\bhost(?:name)?["']?\\s*[:=]\\s*["'])${H}\\b(?![-.\\w])`, "i") },
  { rule: "host-quoted", re: new RegExp(`(?<![?|])(?:^|[\\s,:=\\[(])(["'])${H}\\1(?=\\s*[,\\]):}]|\\s*$)`, "i") },
  { rule: "gitea-nas", re: /\b(?:gitea@\S*|git@(?:gitea|nas)\b\S*|nas\.[a-z0-9-]+\.[a-z]+|ssh:\/\/(?:git@)?(?:gitea|nas)\b\S*)/i },
  // Secrets
  { rule: "private-key", re: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/ },
  { rule: "aws-key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { rule: "github-token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/ },
  { rule: "api-token", re: /\b(?:sk-[A-Za-z0-9_-]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35}|glpat-[A-Za-z0-9_-]{20})\b/ },
  { rule: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { rule: "secret-assignment", re: /\b(?:api[_-]?key|secret|passw(?:or)?d|token)["']?\s*[:=]\s*["'][A-Za-z0-9+\/_=-]{16,}["']/i },
  { rule: "url-credentials", re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s\/:@"']+:[^\s\/@"']+@[^\s\/"']+/i },
];

// Placeholder values are not secrets.
const PLACEHOLDER = /(example|placeholder|your[-_ ]|xxxx|<[a-z-]+>|\$\{|dummy|fake|redacted|changeme)/i;

export function ossScanText(file: string, text: string, deny: string[] = []): Finding[] {
  const out = scanText(file, text, deny);
  text.split("\n").forEach((l, i) => {
    for (const { rule, re } of RULES) if (re.test(l) && !(rule.includes("secret") || rule === "url-credentials" ? PLACEHOLDER.test(l) : false)) out.push({ file, line: i + 1, rule });
  });
  const seen = new Set<string>();
  return out.filter((f) => !seen.has(`${f.line}:${f.rule}`) && seen.add(`${f.line}:${f.rule}`));
}

// .publish-allow: "<rule><TAB><path>" lines, the same file prepublish-check reads. A finding
// whose rule (or "*") and exact path match is dropped: fixtures and dataset paths that look
// like local values or emails.
export function parseAllow(text: string): { rule: string; path: string }[] {
  return text.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")).map((l) => {
    const [rule, path] = l.split("\t");
    return { rule: (rule ?? "").trim(), path: (path ?? "").trim() };
  }).filter((a) => a.rule && a.path);
}

export function dropAllowed(findings: Finding[], allow: { rule: string; path: string }[]): Finding[] {
  return findings.filter((f) => !allow.some((a) => (a.rule === f.rule || a.rule === "*") && a.path === f.file));
}

export function scanTracked(deny: string[] = []): { files: number; findings: Finding[] } {
  const files = new TextDecoder().decode(Bun.spawnSync(["git", "ls-files", "-z"]).stdout).split("\0").filter(Boolean);
  const findings = files.filter((f) => f !== "bun.lock" && !SELF.has(f) && existsSync(f)).flatMap((f) => {
    const buf = readFileSync(f);
    return buf.includes(0) ? [] : ossScanText(f, buf.toString("utf8"), deny);
  });
  const allow = existsSync(".publish-allow") ? parseAllow(readFileSync(".publish-allow", "utf8")) : [];
  return { files: files.length, findings: dropAllowed(findings, allow) };
}

if (import.meta.main) {
  const denyFile = process.env.OUPDATE_SCAN_DENY;
  const deny = denyFile && existsSync(denyFile) ? readFileSync(denyFile, "utf8").split("\n").map((s) => s.trim()).filter(Boolean) : [];
  if (denyFile && deny.length === 0) {
    console.error(`oss-scan: OUPDATE_SCAN_DENY=${denyFile} is missing or empty`);
    process.exit(2);
  }
  const { files, findings } = scanTracked(deny);
  if (process.argv.includes("--json")) console.log(JSON.stringify(findings));
  else for (const f of findings) console.log(`${f.file}:${f.line} ${f.rule}`);
  console.log(`oss-scan: ${files} files, ${findings.length} findings${deny.length ? `, deny list ${deny.length} words` : ", no deny list"}`);
  process.exit(findings.length ? 1 : 0);
}
