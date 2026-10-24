// Pure parsers for the host inventory commands. The inventory holds names and
// versions only: no paths, no host values.

export type ItemKind = "brew-formula" | "brew-cask" | "npm-global" | "docker-image" | "macos" | "cli";

export interface Item {
  kind: ItemKind;
  name: string;
  version: string;
}

export interface Outdated {
  kind: ItemKind;
  name: string;
  installed: string;
  current: string;
  pinned: boolean;
}

function json(text: string): any {
  return text.trim() ? JSON.parse(text) : undefined;
}

const last = (v: unknown): string => (Array.isArray(v) ? String(v.at(-1) ?? "") : String(v ?? ""));

export function parseBrewInfo(text: string): Item[] {
  const j = json(text) ?? {};
  const out: Item[] = [];
  for (const f of j.formulae ?? []) out.push({ kind: "brew-formula", name: f.full_name ?? f.name, version: String(f.installed?.at(-1)?.version ?? "") });
  for (const c of j.casks ?? []) out.push({ kind: "brew-cask", name: c.full_token ?? c.token, version: String(c.installed ?? "") });
  return out;
}

export function parseBrewOutdated(text: string): Outdated[] {
  const j = json(text) ?? {};
  const row = (kind: ItemKind, o: any): Outdated => ({ kind, name: o.name, installed: last(o.installed_versions), current: String(o.current_version ?? ""), pinned: !!o.pinned });
  return [...(j.formulae ?? []).map((o: any) => row("brew-formula", o)), ...(j.casks ?? []).map((o: any) => row("brew-cask", o))];
}

export function parseNpmLs(text: string): Item[] {
  const deps = json(text)?.dependencies ?? {};
  return Object.entries(deps).map(([name, d]: [string, any]) => ({ kind: "npm-global", name, version: String(d.version ?? "") }));
}

export function parseNpmOutdated(text: string): Outdated[] {
  const j = json(text) ?? {};
  return Object.entries(j).map(([name, d]: [string, any]) => ({ kind: "npm-global", name, installed: String(d.current ?? ""), current: String(d.latest ?? d.wanted ?? ""), pinned: false }));
}

export function parseDockerImages(text: string): Item[] {
  return text
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => {
      const d = JSON.parse(l);
      const digest = d.Digest && d.Digest !== "<none>" ? d.Digest : `id:${d.ID}`;
      return { kind: "docker-image" as const, name: `${d.Repository}:${d.Tag}`, version: digest };
    });
}

export function parseSwVers(text: string): Item {
  const get = (k: string) => text.match(new RegExp(`^${k}:\\s*(.+)$`, "m"))?.[1]?.trim() ?? "";
  return { kind: "macos", name: get("ProductName") || "macOS", version: `${get("ProductVersion")} (${get("BuildVersion")})` };
}

export function parseSoftwareUpdate(text: string): Outdated[] {
  const out: Outdated[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const label = lines[i]!.match(/^\* Label: (.+)$/)?.[1]?.trim();
    if (!label) continue;
    const version = lines[i + 1]?.match(/Version: ([^,]+),/)?.[1]?.trim() ?? "";
    out.push({ kind: "macos", name: label, installed: "", current: version, pinned: false });
  }
  return out;
}

// One "name<TAB>version output" line per CLI; an empty output means not installed.
export function parseCliVersions(text: string): Item[] {
  const out: Item[] = [];
  for (const line of text.split("\n")) {
    const [name, rest = ""] = line.split("\t");
    const v = rest.match(/\d+\.\d+(?:\.\d+)?/)?.[0];
    if (name && v) out.push({ kind: "cli", name, version: v });
  }
  return out;
}
