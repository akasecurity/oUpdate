// bun.lock (text lockfile, JSON with trailing commas) -> registry packages.
// Workspace, git, file and link entries are skipped: they have no registry
// version to check.

export interface LockedPackage {
  name: string;
  version: string;
}

function stripTrailingCommas(text: string): string {
  // Commas before a closing bracket, outside strings.
  let out = "";
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inStr) {
      out += c;
      if (c === "\\") out += text[++i] ?? "";
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      continue;
    }
    if (c === ",") {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j]!)) j++;
      if (text[j] === "}" || text[j] === "]") continue;
    }
    out += c;
  }
  return out;
}

export function parseBunLock(text: string): LockedPackage[] {
  const lock = JSON.parse(stripTrailingCommas(text)) as { packages?: Record<string, unknown[]> };
  const seen = new Set<string>();
  const out: LockedPackage[] = [];
  for (const entry of Object.values(lock.packages ?? {})) {
    const spec = entry[0];
    if (typeof spec !== "string") continue;
    const at = spec.lastIndexOf("@");
    if (at <= 0) continue;
    const name = spec.slice(0, at);
    const version = spec.slice(at + 1);
    if (!/^\d+\.\d+\.\d+/.test(version)) continue; // workspace:, github:, file:, link:
    const key = `${name}@${version}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, version });
  }
  return out;
}
