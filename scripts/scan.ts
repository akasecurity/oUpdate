// Public-repo hygiene scan over tracked files: home paths, tailnet names,
// CGNAT addresses, non-reserved emails, and an operator deny list read from
// OUPDATE_SCAN_DENY (a file outside the repo, one word per line). It is a
// floor of known patterns, not proof.

import { readFileSync, existsSync } from "node:fs";

export interface Finding {
  file: string;
  line: number;
  rule: string;
}

const RULES: { rule: string; re: RegExp }[] = [
  { rule: "home-path", re: /\/(Users|home)\/[A-Za-z0-9._-]+/ },
  { rule: "tailnet", re: /\b[a-z0-9-]+\.ts\.net\b/i },
  { rule: "cgnat-ip", re: /\b100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b/ },
  { rule: "private-ip", re: /\b(192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/ },
];

const EMAIL = /\b[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+\.)+[A-Za-z]{2,}\b/g;
const RESERVED = /(^|\.)(example\.(com|org|net)|test|invalid|localhost|noreply\.github\.com|users\.noreply\.invalid)$/i;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function scanText(file: string, text: string, deny: string[] = []): Finding[] {
  const out: Finding[] = [];
  const denyRe = deny.length ? new RegExp(`\\b(${deny.map(escapeRe).join("|")})\\b`, "i") : undefined;
  text.split("\n").forEach((l, i) => {
    for (const { rule, re } of RULES) if (re.test(l)) out.push({ file, line: i + 1, rule });
    for (const m of l.matchAll(EMAIL)) {
      const domain = m[0].split("@")[1]!;
      if (!RESERVED.test(domain)) out.push({ file, line: i + 1, rule: "email" });
    }
    if (denyRe?.test(l)) out.push({ file, line: i + 1, rule: "deny-list" });
  });
  return out;
}

if (import.meta.main) {
  const files = new TextDecoder()
    .decode(Bun.spawnSync(["git", "ls-files", "-z"]).stdout)
    .split("\0")
    .filter(Boolean);
  const denyFile = process.env.OUPDATE_SCAN_DENY;
  const deny = denyFile && existsSync(denyFile) ? readFileSync(denyFile, "utf8").split("\n").map((s) => s.trim()).filter(Boolean) : [];
  if (denyFile && deny.length === 0) {
    console.error(`scan: OUPDATE_SCAN_DENY=${denyFile} is missing or empty`);
    process.exit(2);
  }
  const findings = files.flatMap((f) => (existsSync(f) ? scanText(f, readFileSync(f, "utf8"), deny) : []));
  for (const f of findings) console.log(`${f.file}:${f.line} ${f.rule}`);
  console.log(`scan: ${files.length} files, ${findings.length} findings${deny.length ? `, deny list ${deny.length} words` : ", no deny list"}`);
  process.exit(findings.length ? 1 : 0);
}
