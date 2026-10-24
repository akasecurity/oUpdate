// Pinned tools are held, never upgraded (ported from the previous updater's su_pin_filter). A tool is
// held when brew pins it (formulae only: `brew outdated` still lists pinned formulae, and naming
// one to `brew upgrade` is an error) or when a repo lists it in a pins.json at its root:
//   {"brew": {"duckdb": "1.5.5"}, "cask": {"brave-browser": "1.97"}}
// Any upgrade of a listed tool is held, whatever the version; the version is for the reader.
// Names match on their last path segment. Lifting a hold is the repo's change, or `brew unpin`.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface PinFile {
  /** The repo directory's name, reported as the reason. */
  repo: string;
  /** Where it was read, for the warning. */
  path: string;
  /** undefined when the file exists but could not be read. */
  text: string | undefined;
}

/**
 * Every <root>/<repo>/pins.json one level under the roots (dot-directories skipped, as the shell
 * glob did). A pins.json that exists but cannot be read is kept with no text, so pinFilter warns.
 */
export function readPinFiles(roots: string[]): PinFile[] {
  const out: PinFile[] = [];
  for (const root of roots) {
    let names: string[];
    try {
      names = readdirSync(root).sort();
    } catch {
      continue;
    }
    for (const repo of names) {
      if (repo.startsWith(".")) continue;
      const p = join(root, repo, "pins.json");
      try {
        if (!statSync(p).isFile()) continue;
      } catch {
        continue; // no pins.json in this repo
      }
      let text: string | undefined;
      try {
        text = readFileSync(p, "utf8");
      } catch {
        text = undefined;
      }
      out.push({ repo, path: p, text });
    }
  }
  return out;
}

export interface PinResult {
  kept: string[];
  /** "<name>(<why>)", why being the repo or "brew pin". */
  pinned: string[];
  warnings: string[];
}

export function pinFilter(kind: "brew" | "cask", names: string[], o: { brewPinned?: string[]; files: PinFile[] }): PinResult {
  const held = new Map<string, string>();
  const warnings: string[] = [];
  if (kind === "brew") for (const n of o.brewPinned ?? []) if (!held.has(n)) held.set(n, "brew pin");
  for (const f of o.files) {
    let j: unknown;
    try {
      j = f.text === undefined ? undefined : JSON.parse(f.text);
    } catch {
      j = undefined;
    }
    if (!j || typeof j !== "object" || Array.isArray(j)) {
      warnings.push(`WARNING: ${f.path}: pins.json unreadable, holds nothing`);
      continue;
    }
    const section = (j as Record<string, unknown>)[kind];
    if (section && typeof section === "object" && !Array.isArray(section)) {
      for (const n of Object.keys(section)) if (!held.has(n)) held.set(n, f.repo);
    }
  }
  const kept: string[] = [];
  const pinned: string[] = [];
  for (const n of names) {
    const why = held.get(n.split("/").at(-1)!);
    if (why) pinned.push(`${n}(${why})`);
    else kept.push(n);
  }
  return { kept, pinned, warnings };
}

/** The names a pending query must skip for the pinned entries: each in full and by its last segment. */
export function heldFromPinned(pinned: string[]): string[] {
  return pinned.flatMap((p) => {
    const n = p.replace(/\(.*$/, "");
    return [n, n.split("/").at(-1)!];
  });
}
